/**
 * G09 — VIETNAMESE CONTENT ENGINE.
 *
 * Sinh bộ nội dung bán hàng tiếng Việt từ Vietnamese Product Master (G08).
 *
 * Hai tầng bảo vệ chống bịa:
 *   1. Prompt bị chặn bằng `factSheet` — danh sách ĐÓNG các dữ kiện được phép dùng.
 *   2. `checkContent()` chạy trên văn bản đã sinh; nếu phát hiện khẳng định không
 *      có bằng chứng, engine tự gọi một lượt SỬA (repair) để loại bỏ chúng.
 *      Nếu vẫn còn, nội dung được trả về kèm `violations` và bị đánh dấu
 *      `guardrails_passed = false` — UI phải hiển thị cảnh báo, không được im lặng.
 */

import { createProvider, extractJson, AiError, estimateCostFromUsage } from '../ai/provider.js';
import { parseContentOptions } from './styles.js';
import { buildFactSheet } from '../merge/knowledge-merge.js';
import { buildEvidenceText, checkContent } from './guardrails.js';
import { sanitizeText, safeJsonParse } from '../security/sanitize.js';

export class ContentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ContentError';
    this.code = code;
    this.details = details;
  }
}

export const CONTENT_KEYS = Object.freeze([
  'product_name',
  'headline',
  'short_description',
  'selling_points',
  'detailed_description',
  'facebook_caption',
  'tiktok_caption',
  'marketplace_description',
  'hashtags',
  'seo',
]);

const SYSTEM_PROMPT = `Bạn là chuyên gia viết nội dung bán hàng tiếng Việt cho thương mại điện tử, chuyên chuyển sản phẩm từ Taobao/1688/Pinduoduo thành nội dung bán hàng tiếng Việt.

LUẬT BẤT KHẢ XÂM PHẠM — vi phạm là hỏng việc:
1. CHỈ được dùng dữ kiện có trong "BẢNG DỮ KIỆN". Không được thêm bất kỳ thông tin nào khác.
2. TUYỆT ĐỐI KHÔNG bịa hoặc suy diễn: chất liệu, dung tích, công suất, kích thước, trọng lượng,
   khả năng chống nước, chứng nhận (ISO/CE/FDA...), bảo hành, nguồn gốc/xuất xứ, giá,
   khuyến mãi, giảm giá, quà tặng, số lượng có hạn, số lượng khách đã mua, đánh giá, xếp hạng sao.
3. Nếu BẢNG DỮ KIỆN không có giá, KHÔNG được nhắc đến giá hay "giá rẻ", "giá tốt" kèm con số.
4. Nếu không có thông số kỹ thuật, hãy mô tả bằng đặc điểm NHÌN THẤY và CÔNG DỤNG hợp lý,
   dùng ngôn ngữ mềm ("thiết kế", "kiểu dáng", "phù hợp với") thay vì khẳng định thông số.
5. Không dịch máy thô. Viết tiếng Việt tự nhiên, đúng ngữ pháp, có dấu đầy đủ.
6. Không dùng từ ngữ phóng đại vô căn cứ ("tốt nhất thị trường", "số 1", "duy nhất").

Định dạng trả về: DUY NHẤT một object JSON hợp lệ, KHÔNG kèm văn bản giải thích, KHÔNG bọc trong markdown.
Cấu trúc bắt buộc:
{
  "product_name": "tên sản phẩm tiếng Việt, ngắn gọn, tự nhiên",
  "headline": "tiêu đề bán hàng hấp dẫn, 1 câu",
  "short_description": "2-4 câu mô tả ngắn",
  "selling_points": ["4-8 điểm bán hàng, mỗi điểm 1 câu"],
  "detailed_description": "mô tả đầy đủ, có thể chia đoạn",
  "facebook_caption": "bài đăng Facebook, có emoji hợp lý, có CTA",
  "tiktok_caption": "caption TikTok ngắn, nhịp nhanh, có hashtag",
  "marketplace_description": "mô tả cho Shopee/TikTok Shop, gạch đầu dòng rõ ràng, TRUNG THỰC, người bán sẽ tự kiểm lại",
  "hashtags": ["8-15 hashtag tiếng Việt/tiếng Anh phù hợp, có dấu #"],
  "seo": {
    "title": "SEO title tối đa 60 ký tự",
    "meta_description": "meta description 120-160 ký tự",
    "keywords": ["5-12 từ khoá"]
  }
}`;

function normalizeContent(raw) {
  const arr = (v, max) =>
    (Array.isArray(v) ? v : v ? [v] : [])
      .map((x) => sanitizeText(typeof x === 'string' ? x : String(x ?? ''), { maxLength: 1200 }))
      .filter(Boolean)
      .slice(0, max);

  const seo = raw?.seo && typeof raw.seo === 'object' ? raw.seo : {};
  return {
    product_name: sanitizeText(raw?.product_name, { maxLength: 200 }),
    headline: sanitizeText(raw?.headline, { maxLength: 300 }),
    short_description: sanitizeText(raw?.short_description, { maxLength: 1500 }),
    selling_points: arr(raw?.selling_points, 12),
    detailed_description: sanitizeText(raw?.detailed_description, { maxLength: 12000 }),
    facebook_caption: sanitizeText(raw?.facebook_caption, { maxLength: 4000 }),
    tiktok_caption: sanitizeText(raw?.tiktok_caption, { maxLength: 2000 }),
    marketplace_description: sanitizeText(raw?.marketplace_description, { maxLength: 8000 }),
    hashtags: arr(raw?.hashtags, 20).map((h) => (h.startsWith('#') ? h : `#${h}`)),
    seo: {
      title: sanitizeText(seo.title, { maxLength: 120 }),
      meta_description: sanitizeText(seo.meta_description, { maxLength: 320 }),
      keywords: arr(seo.keywords, 15),
    },
  };
}

export class ContentEngine {
  constructor({ provider, logger, config } = {}) {
    this.provider = provider;
    this.logger = logger;
    this.config = config;
  }

  get providerName() {
    return this.provider?.name || 'none';
  }

  get model() {
    return this.provider?.model || '';
  }

  get configured() {
    return Boolean(this.provider?.configured);
  }

  /**
   * Dịch tên + mô tả gốc sang tiếng Việt (operation TRANSLATION).
   */
  async translate(master, { maxChars = 3000 } = {}) {
    if (!this.configured) throw new AiError('AI_NOT_CONFIGURED', 'Chưa cấu hình AI provider cho dịch thuật.');
    const title = master?.title_original || '';
    const desc = (master?.description_original || '').slice(0, maxChars);
    if (!title && !desc) return { title_vi: '', description_vi: '', usage: null, skipped: true };

    const res = await this.provider.chat(
      [
        {
          role: 'system',
          text: 'Bạn dịch tiếng Trung sang tiếng Việt cho sản phẩm thương mại điện tử. Dịch trung thực, KHÔNG thêm thông tin không có trong bản gốc, KHÔNG bịa thông số. Trả về DUY NHẤT JSON: {"title_vi":"","description_vi":""}',
        },
        { role: 'user', text: `Tên gốc:\n${title}\n\nMô tả gốc:\n${desc}` },
      ],
      { jsonMode: true, maxTokens: 2000, temperature: 0.2 },
    );

    const parsed = extractJson(res.content) || {};
    return {
      title_vi: sanitizeText(parsed.title_vi, { maxLength: 300 }),
      description_vi: sanitizeText(parsed.description_vi, { maxLength: 8000 }),
      usage: res.usage,
      model: res.model,
      provider: res.provider,
      skipped: false,
    };
  }

  /**
   * Sinh bộ nội dung đầy đủ.
   *
   * @returns {Promise<{content:object, meta:object, usage:object|null, guardrails:object}>}
   */
  async generate(master, knowledge, { style, length, extraInstructions = '', repair = true } = {}) {
    if (!this.configured) {
      throw new AiError('AI_NOT_CONFIGURED', 'Chưa cấu hình AI provider cho Content Engine.');
    }
    const opts = parseContentOptions({ style, length });
    const factSheet = buildFactSheet(master, knowledge);
    const evidenceText = buildEvidenceText(master, knowledge, knowledge?.vision || null);

    const userPrompt = [
      `PHONG CÁCH: ${opts.styleLabel}. ${opts.styleGuidance}`,
      `ĐỘ DÀI: ${opts.lengthLabel}. ${opts.lengthGuidance}`,
      extraInstructions ? `YÊU CẦU THÊM TỪ NGƯỜI DÙNG: ${sanitizeText(extraInstructions, { maxLength: 1000 })}` : '',
      '',
      'BẢNG DỮ KIỆN (chỉ được dùng những gì có ở đây):',
      factSheet,
      '',
      `Số điểm bán hàng cần: ${opts.sellingPointCount}.`,
      'Hãy trả về JSON đúng cấu trúc đã quy định.',
    ]
      .filter(Boolean)
      .join('\n');

    const messages = [
      { role: 'system', text: SYSTEM_PROMPT },
      { role: 'user', text: userPrompt },
    ];

    const first = await this.provider.chat(messages, {
      jsonMode: true,
      maxTokens: this.config?.ai?.maxOutputTokens ?? 4096,
      temperature: this.config?.ai?.temperature ?? 0.4,
    });

    const parsedRaw = extractJson(first.content) || safeJsonParse(first.content);
    if (!parsedRaw) {
      throw new ContentError('CONTENT_BAD_JSON', 'Content provider trả về nội dung không phải JSON hợp lệ.', {
        preview: String(first.content || '').slice(0, 300),
      });
    }

    let content = normalizeContent(parsedRaw);
    let guard = checkContent(content, { evidenceText });
    let repairAttempted = false;
    let repairUsage = null;

    // Lượt SỬA: yêu cầu model loại bỏ đúng những khẳng định thiếu bằng chứng.
    if (repair && !guard.passed) {
      repairAttempted = true;
      try {
        const repairRes = await this.provider.chat(
          [
            { role: 'system', text: SYSTEM_PROMPT },
            { role: 'user', text: userPrompt },
            { role: 'assistant', text: JSON.stringify(content) },
            {
              role: 'user',
              text: [
                'Bản JSON vừa rồi VI PHẠM luật chống bịa. Hãy sửa lại và trả về JSON hoàn chỉnh.',
                'Các khẳng định sau KHÔNG có bằng chứng trong BẢNG DỮ KIỆN, phải loại bỏ hoặc viết lại cho đúng:',
                ...guard.violations.map((v) => `- [${v.label}] "${v.matched}"`),
                'Giữ nguyên cấu trúc JSON và phong cách/độ dài đã yêu cầu. Không thêm thông tin mới.',
              ].join('\n'),
            },
          ],
          { jsonMode: true, maxTokens: this.config?.ai?.maxOutputTokens ?? 4096, temperature: 0.2 },
        );
        repairUsage = repairRes.usage;
        const repaired = extractJson(repairRes.content);
        if (repaired) {
          const candidate = normalizeContent(repaired);
          const candidateGuard = checkContent(candidate, { evidenceText });
          // Chỉ nhận bản sửa nếu nó THỰC SỰ tốt hơn.
          if (candidateGuard.violations.length < guard.violations.length) {
            content = candidate;
            guard = candidateGuard;
          }
        }
      } catch (err) {
        this.logger?.warn('content.repair_failed', { error: err });
      }
    }

    const costFirst = estimateCostFromUsage(first.model, first.usage);
    const costRepair = repairUsage ? estimateCostFromUsage(first.model, repairUsage) : 0;

    return {
      content,
      usage: {
        first: first.usage,
        repair: repairUsage,
        total_tokens:
          (first.usage?.total_tokens ?? 0) +
          (repairUsage?.total_tokens ?? 0),
      },
      meta: {
        style: opts.style,
        style_label: opts.styleLabel,
        length: opts.length,
        length_label: opts.lengthLabel,
        provider: first.provider || this.providerName,
        model: first.model || this.model,
        repair_attempted: repairAttempted,
        estimated_cost: (costFirst ?? 0) + (costRepair ?? 0),
        generated_at: new Date().toISOString(),
        is_mock: Boolean(first.mock),
      },
      guardrails: {
        passed: guard.passed,
        violations: guard.violations,
        warnings: guard.warnings,
        checked_rules: guard.checked,
      },
    };
  }
}

/** Tạo ContentEngine từ cấu hình. */
export function createContentEngine(config, { logger } = {}) {
  const cfg = config?.ai || {};
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
  return new ContentEngine({ provider, logger, config });
}

export default createContentEngine;
