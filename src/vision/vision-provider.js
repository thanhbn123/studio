/**
 * G07 — VISION PROVIDER.
 *
 * Phân tích ảnh sản phẩm và trả về phân tích CÓ CẤU TRÚC.
 *
 * Nguyên tắc chống bịa (đây là phần dễ vi phạm nhất của toàn hệ thống):
 *  - Prompt cấm rõ ràng việc suy diễn chất liệu, dung lượng, công suất, chống nước,
 *    chứng nhận, bảo hành, nguồn gốc, giá.
 *  - Mọi thứ model KHÔNG chắc phải nằm trong `uncertain_claims`.
 *  - Sau khi model trả về, `enforceVisionGuardrails()` kiểm lại lần nữa: nếu model
 *    lỡ khẳng định một thuộc tính "cấm đoán" mà không có chữ trong ảnh/nguồn, ta
 *    chuyển nó sang `uncertain_claims` và ghi cảnh báo.
 */

import { createProvider } from '../ai/provider.js';
import { extractJson, AiError } from '../ai/provider.js';
import { safeJsonParse, sniffImageMime } from '../security/sanitize.js';

export class VisionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VisionError';
    this.code = code;
    this.details = details;
  }
}

export const VISION_SCHEMA = Object.freeze({
  product_type: 'string',
  visible_features: ['string'],
  visible_text: ['string'],
  colors: ['string'],
  likely_use_cases: ['string'],
  uncertain_claims: ['string'],
});

const SYSTEM_PROMPT = `Bạn là chuyên gia phân tích ảnh sản phẩm cho thương mại điện tử.
Bạn CHỈ được mô tả những gì NHÌN THẤY TRỰC TIẾP trong ảnh.

TUYỆT ĐỐI KHÔNG ĐƯỢC suy đoán hoặc khẳng định các thông tin sau nếu ảnh không hiển thị rõ bằng chữ:
- chất liệu (da thật, cotton, nhôm...)
- dung lượng / kích thước chính xác (ml, lít, cm, inch)
- công suất, điện áp, dung lượng pin (W, V, mAh)
- khả năng chống nước / chống bụi (IP68...)
- chứng nhận, tiêu chuẩn (CE, FDA, ISO...)
- bảo hành
- nguồn gốc, xuất xứ, thương hiệu nếu logo không đọc được rõ
- giá

Nếu ảnh gợi ý một trong các thông tin trên nhưng KHÔNG có bằng chứng nhìn thấy được,
hãy đưa vào "uncertain_claims" dưới dạng câu hỏi/ghi chú, KHÔNG đưa vào visible_features.

Trả về DUY NHẤT một object JSON hợp lệ, không kèm giải thích, đúng cấu trúc:
{
  "product_type": "loại sản phẩm chung, ví dụ: tai nghe chụp tai",
  "visible_features": ["đặc điểm nhìn thấy được, tối đa 8 mục"],
  "visible_text": ["mọi chữ/số đọc được trong ảnh, giữ nguyên ngôn ngữ gốc"],
  "colors": ["màu nhìn thấy, tối đa 6 mục"],
  "likely_use_cases": ["công dụng suy ra từ hình dáng, tối đa 5 mục"],
  "uncertain_claims": ["điều KHÔNG chắc chắn / cần xác minh, tối đa 8 mục"]
}`;

/** Thuộc tính bị cấm khẳng định khi không có bằng chứng trong ảnh. */
const FORBIDDEN_CLAIM_PATTERNS = [
  { re: /chống nước|kháng nước|waterproof|ip6[5-9]|ip[7-9]\d/i, label: 'chống nước' },
  { re: /\b\d+\s?(ml|l|lit|inch|cm|mm|mAh|W|V|Hz)\b/i, label: 'thông số đo lường' },
  { re: /da thật|genuine leather|cotton\s*100|nhôm|thép không gỉ|inox|titan/i, label: 'chất liệu' },
  { re: /\b(ce|fda|iso\s?\d+|rohs|fcc)\b/i, label: 'chứng nhận' },
  { re: /bảo hành\s*\d+|\b\d+\s*(năm|tháng)\s*bảo hành/i, label: 'bảo hành' },
  { re: /xuất xứ|nguồn gốc|made in|sản xuất tại/i, label: 'nguồn gốc' },
  { re: /\b\d+[\.,]?\d*\s*(vnđ|đ|usd|nd tệ|cny|¥)/i, label: 'giá' },
];

/**
 * Rà lại kết quả vision: chuyển khẳng định thiếu bằng chứng sang uncertain_claims.
 * @returns {{analysis:object, moved:string[]}}
 */
export function enforceVisionGuardrails(analysis, { visibleText = [] } = {}) {
  const moved = [];
  if (!analysis || typeof analysis !== 'object') {
    return { analysis: emptyVisionAnalysis(), moved };
  }
  const evidence = [
    ...(Array.isArray(analysis.visible_text) ? analysis.visible_text : []),
    ...visibleText,
  ]
    .join(' ')
    .toLowerCase();

  const features = Array.isArray(analysis.visible_features) ? analysis.visible_features : [];
  const keep = [];
  const uncertain = Array.isArray(analysis.uncertain_claims) ? [...analysis.uncertain_claims] : [];

  for (const f of features) {
    const text = String(f || '');
    const hit = FORBIDDEN_CLAIM_PATTERNS.find((p) => p.re.test(text));
    if (!hit) {
      keep.push(text);
      continue;
    }
    // Nếu chính chữ đó xuất hiện trong visible_text thì coi như có bằng chứng đọc được.
    const normalized = text.toLowerCase();
    const appearsInImageText = evidence.includes(normalized.slice(0, 30));
    if (appearsInImageText) {
      keep.push(text);
    } else {
      moved.push(text);
      uncertain.push(`Cần xác minh (${hit.label}): ${text}`);
    }
  }

  return {
    analysis: {
      product_type: String(analysis.product_type || ''),
      visible_features: keep.slice(0, 12),
      visible_text: (Array.isArray(analysis.visible_text) ? analysis.visible_text : []).slice(0, 40).map(String),
      colors: (Array.isArray(analysis.colors) ? analysis.colors : []).slice(0, 10).map(String),
      likely_use_cases: (Array.isArray(analysis.likely_use_cases) ? analysis.likely_use_cases : [])
        .slice(0, 10)
        .map(String),
      uncertain_claims: [...new Set(uncertain)].slice(0, 20),
    },
    moved,
  };
}

export function emptyVisionAnalysis() {
  return {
    product_type: '',
    visible_features: [],
    visible_text: [],
    colors: [],
    likely_use_cases: [],
    uncertain_claims: [],
  };
}

/**
 * VisionProvider — bọc một AiProvider có khả năng nhận ảnh.
 */
export class VisionProvider {
  constructor({ provider, maxImages = 6, logger, config } = {}) {
    this.provider = provider;
    this.maxImages = maxImages;
    this.logger = logger;
    this.config = config;
  }

  get name() {
    return this.provider?.name || 'none';
  }

  get model() {
    return this.provider?.model || '';
  }

  get configured() {
    return Boolean(this.provider?.configured);
  }

  /**
   * @param {Array<{url?:string, base64?:string, mimeType?:string}>} images
   * @returns {Promise<{analysis:object, used:number, skipped:number, provider:string, model:string, usage:object|null, warnings:string[]}>}
   */
  async analyzeImages(images = [], { productContext = '', maxImages } = {}) {
    if (!this.provider) throw new VisionError('NO_PROVIDER', 'Chưa cấu hình Vision provider.');
    const limit = maxImages ?? this.maxImages;

    const usable = [];
    const warnings = [];
    let skipped = 0;

    for (const img of images.slice(0, limit)) {
      try {
        const prepared = await this.#prepareImage(img);
        if (prepared) usable.push(prepared);
        else skipped += 1;
      } catch (err) {
        skipped += 1;
        warnings.push(`Bỏ qua 1 ảnh: ${err.message}`);
      }
    }

    if (usable.length === 0) {
      return {
        analysis: emptyVisionAnalysis(),
        used: 0,
        skipped,
        provider: this.name,
        model: this.model,
        usage: null,
        warnings: [...warnings, 'Không có ảnh nào dùng được để phân tích.'],
        status: 'NO_IMAGES',
      };
    }

    const contextLine = productContext
      ? `\n\nNgữ cảnh bổ sung (chỉ để hiểu ảnh, KHÔNG dùng để bịa thêm thuộc tính):\n${productContext.slice(0, 1500)}`
      : '';

    const res = await this.provider.chat(
      [
        { role: 'system', text: SYSTEM_PROMPT },
        {
          role: 'user',
          text: `Phân tích ${usable.length} ảnh sản phẩm dưới đây và trả về JSON theo đúng cấu trúc đã yêu cầu.${contextLine}`,
          images: usable,
        },
      ],
      { jsonMode: true, maxTokens: 2000, temperature: 0.2 },
    );

    const parsed = extractJson(res.content) || safeJsonParse(res.content);
    if (!parsed) {
      throw new VisionError('VISION_BAD_JSON', 'Vision provider trả về nội dung không phải JSON hợp lệ.', {
        preview: String(res.content || '').slice(0, 300),
      });
    }

    const { analysis, moved } = enforceVisionGuardrails(parsed);
    if (moved.length > 0) {
      warnings.push(
        `Đã chuyển ${moved.length} khẳng định thiếu bằng chứng sang uncertain_claims: ${moved
          .slice(0, 3)
          .join(' | ')}`,
      );
    }

    return {
      analysis,
      used: usable.length,
      skipped,
      provider: this.name,
      model: res.model,
      usage: res.usage,
      warnings,
      status: 'OK',
    };
  }

  /** Chuẩn hoá ảnh về base64 + mimeType; từ chối thứ không phải ảnh. */
  async #prepareImage(img) {
    let buffer;
    let mimeType = img.mimeType || '';

    if (img.base64) {
      buffer = Buffer.from(img.base64, 'base64');
    } else if (img.buffer) {
      buffer = Buffer.isBuffer(img.buffer) ? img.buffer : Buffer.from(img.buffer);
    } else if (img.url && /^data:/i.test(img.url)) {
      // Ảnh do người dùng tải lên (G11) đi vào dưới dạng data URL. Phải giải mã
      // TẠI CHỖ và phải kiểm TRƯỚC nhánh `img.url` chung bên dưới — vì `safeFetch`
      // chỉ nhận http/https (URL data cũng vượt giới hạn 2048 ký tự), nên nếu để
      // nhánh chung chạy trước thì ảnh thủ công luôn bị bỏ qua trong im lặng.
      const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(img.url);
      if (!m) throw new VisionError('BAD_IMAGE', 'data URL không hợp lệ.');
      mimeType = mimeType || m[1];
      buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    } else if (img.url) {
      const { safeFetch } = await import('../security/fetcher.js');
      const res = await safeFetch(img.url, {
        timeoutMs: this.config?.net?.fetchTimeoutMs ?? 20000,
        maxBytes: this.config?.net?.maxFetchBytes ?? 8 * 1024 * 1024,
        allowPrivateNetwork: this.config?.net?.allowPrivateNetwork ?? false,
      });
      buffer = res.body;
      mimeType = mimeType || res.headers['content-type'] || '';
    } else {
      throw new VisionError('BAD_IMAGE', 'Ảnh thiếu cả url lẫn dữ liệu base64.');
    }

    // Không tin Content-Type khai báo — kiểm magic bytes.
    const sniffed = sniffImageMime(buffer);
    if (!sniffed) throw new VisionError('NOT_AN_IMAGE', 'Dữ liệu không phải ảnh hợp lệ (magic bytes).');
    const allowed = this.config?.net?.allowedImageMime ?? ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(sniffed)) {
      throw new VisionError('MIME_NOT_ALLOWED', `Định dạng ảnh không được phép: ${sniffed}`);
    }
    const maxBytes = this.config?.net?.maxFetchBytes ?? 8 * 1024 * 1024;
    if (buffer.length > maxBytes) {
      throw new VisionError('IMAGE_TOO_LARGE', `Ảnh vượt ${maxBytes} byte.`);
    }

    return { base64: buffer.toString('base64'), mimeType: sniffed, bytes: buffer.length };
  }
}

/** Tạo VisionProvider từ cấu hình. */
export function createVisionProvider(config, { logger } = {}) {
  const cfg = config?.vision || {};
  const provider = createProvider(
    {
      provider: cfg.provider,
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
    },
    { logger },
  );
  return new VisionProvider({ provider, maxImages: cfg.maxImages ?? 6, logger, config });
}

export default createVisionProvider;
