/**
 * ImageLab pipeline (C4) — nhạc trưởng của luồng MVP-02.
 *
 *   ảnh người dùng → ingest (lưu ảnh gốc bất biến) → runOcr (OCR → dịch → chờ duyệt)
 *                  → người dùng duyệt từng dòng → renderApproved (xoá chữ cũ + vẽ chữ Việt)
 *
 * Bốn nguyên tắc chi phối file này (theo hợp đồng MVP-02, mục 1):
 *  1. KHÔNG BỊA: mọi field trả về đều có nguồn; provider mock phải tự khai `is_mock`;
 *     không kết quả nào của MVP-02 được dán nhãn `LIVE_VERIFIED`.
 *  2. ẢNH GỐC BẤT BIẾN: ảnh gốc chỉ được ĐỌC. Ảnh render là bản ghi MỚI có `parent_id`.
 *     Buffer gốc được băm trước/sau khi render để phát hiện provider sửa tại chỗ.
 *  3. NHÃN HIỆU / CHỨNG NHẬN / GIÁ không bao giờ bị dịch hay xoá — chặn bằng `kind`
 *     của vùng, không chỉ bằng `status` của dòng.
 *  4. FAIL-CLOSED: mọi lỗi provider/DB đều để lại `status = failed` + `error_code` +
 *     `finished_at`. Không bao giờ để job treo `running` mà không có lý do.
 *
 * Module anh em (ocr/translate/render) KHÔNG được import ở đây — chúng được bơm vào
 * qua constructor để pipeline dùng được với provider giả trong test và để 5 agent có
 * thể lắp ráp song song mà không phụ thuộc lúc biên dịch.
 *
 * NGOẠI LỆ có kiểm soát (IL-08, hợp đồng §11): `manual-regions.js` là helper THUẦN của
 * chính tầng này (C4). Nó được import tĩnh vì luật phân loại vùng (`classifyRegion`) và
 * luật kẹp hộp (`geometry.js`) chỉ được có ĐÚNG MỘT bản trong repo — chép lại luật vào
 * pipeline là cách chắc chắn nhất để hai bản lệch nhau.
 */

import { createHash, randomUUID } from 'node:crypto';
import { JOB_STATUS, VERIFICATION_LEVELS } from '../store/index.js';
import { sniffImageMime } from '../security/sanitize.js';
import { boxesIntersect, intersectBoxWithImage, strictCoordinate } from './geometry.js';
import { MANUAL_ID_PREFIX, normalizeManualRegions } from './manual-regions.js';

/** Các bước của một job ImageLab — C5 hiện tiến trình theo `stage` này. */
export const IMAGELAB_STAGES = Object.freeze([
  'queued',
  'storing',
  'ocr',
  'translating',
  'awaiting_review',
  'rendering',
  'done',
  'failed',
]);

export const IMAGELAB_CONNECTOR = 'imagelab';
export const IMAGELAB_EXTRACTION_METHOD = 'upload+render';

/**
 * IL-08 — cách trích xuất khi vùng chữ do NGƯỜI DÙNG nhập tay (§11.2 luật 9):
 * giữ nguyên `upload+render` rồi ghi thêm `+manual-regions`. Không có bước OCR nào chạy.
 */
export const IMAGELAB_EXTRACTION_METHOD_MANUAL = `${IMAGELAB_EXTRACTION_METHOD}+manual-regions`;

/** Mức bằng chứng DUY NHẤT được phép: ảnh do người dùng tải lên. */
export const IMAGELAB_VERIFICATION = 'MANUAL_INPUT';

/** Chỉ những dòng này mới được dựng RenderOp (hợp đồng 4.4). */
export const RENDERABLE_STATUSES = Object.freeze(['TRANSLATED', 'GLOSSARY', 'USER_EDITED']);

/**
 * Dòng CHƯA được người duyệt xử lý → còn chặn render (hợp đồng 4.4).
 *
 * Đây là NGUỒN LUẬT DUY NHẤT cho câu hỏi "còn dòng nào phải duyệt không":
 * `renderApproved()` (C4) và route `POST /api/imagelab/jobs/:id/render` (C5) đều
 * gọi hàm này.
 *
 * Sửa theo F-06 của phản biện: cổng chỉ quan tâm `status === 'NEEDS_REVIEW'`, BẤT KỂ
 * `edited_by_user`. Trước đây dòng `NEEDS_REVIEW` mà người dùng đã sửa (nhưng vẫn vi
 * phạm guardrail) được miễn cổng 409 rồi bị bỏ im lặng khỏi ảnh — người dùng tưởng đã
 * vẽ. Người dùng muốn bỏ qua thật thì dùng `action: 'skip'` (⇒ `SKIPPED_BY_USER`,
 * không chặn render và xuất hiện trong `skipped` với lý do rõ ràng).
 */
export function pendingReviewLines(lines) {
  return (Array.isArray(lines) ? lines : []).filter(
    (l) => String(l?.status ?? '') === 'NEEDS_REVIEW',
  );
}

/** Ba loại vùng KHÔNG BAO GIỜ được dịch/xoá (luật #3). */
export const NEVER_RENDER_KINDS = Object.freeze(['brand', 'certification', 'price']);

/** Nhãn tiếng Việt của kind — dùng cho cảnh báo override (không dùng cho logic). */
const KIND_LABEL_VI = Object.freeze({
  brand: 'nhãn hiệu',
  certification: 'chứng nhận',
  price: 'giá',
});

const MIME_EXT = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

const ALLOWED_IMAGE_MIME = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Lý do bỏ qua, viết bằng tiếng Việt để hiện thẳng lên UI (không được ẩn). */
const STATUS_SKIP_REASON = Object.freeze({
  SKIPPED_BRAND: 'Vùng nhãn hiệu — không dịch, không xoá (luật bất khả xâm phạm #3).',
  SKIPPED_CERTIFICATION: 'Vùng chứng nhận — không dịch, không xoá (luật bất khả xâm phạm #3).',
  SKIPPED_PRICE: 'Vùng giá — giá do người bán quyết, không tự dịch.',
  SKIPPED_BY_USER: 'Người dùng đã bỏ qua dòng này — không vẽ chữ Việt vào vùng (có ghi vết).',
  NEEDS_REVIEW: 'Dòng bị guardrail chặn (cần người duyệt) nhưng CHƯA được duyệt — bỏ qua, KHÔNG vẽ.',
  FAILED: 'Provider dịch lỗi cho riêng dòng này — bỏ qua.',
});

const KIND_SKIP_REASON = Object.freeze({
  brand: 'Vùng nhãn hiệu — tuyệt đối không xoá/vẽ đè (luật #3), kể cả khi dòng dịch có nội dung.',
  certification: 'Vùng chứng nhận — tuyệt đối không xoá/vẽ đè (luật #3).',
  price: 'Vùng giá — tuyệt đối không xoá/vẽ đè (luật #3).',
});

const NEVER_LIVE = Object.freeze(new Set(['LIVE_VERIFIED', 'AUTHENTICATED_LIVE_VERIFIED']));

/**
 * Mã lỗi MỨC JOB khi render không vẽ được vùng nào (N-2, vòng 4). Ảnh mới vẫn được lưu
 * nên `status = succeeded`, nhưng `error_code` phải nói thật để client không hiểu nhầm.
 */
export const RENDER_NO_OPS = 'RENDER_NO_OPS';

/** Lỗi có `code` rõ ràng — C5 map sang HTTP (REVIEW_REQUIRED → 409). */
export class ImageLabError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ImageLabError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/** Cổng chặn cứng: MVP-02 không bao giờ được ghi LIVE_VERIFIED (luật #1). */
function imagelabVerification(level = IMAGELAB_VERIFICATION) {
  if (!VERIFICATION_LEVELS.includes(level)) {
    throw new ImageLabError('INVALID_VERIFICATION', `Mức bằng chứng không hợp lệ: ${JSON.stringify(String(level))}`);
  }
  if (NEVER_LIVE.has(level)) {
    throw new ImageLabError('LIVE_VERIFICATION_FORBIDDEN', 'MVP-02 KHÔNG BAO GIỜ được ghi LIVE_VERIFIED (luật #1).');
  }
  return level;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Giải mã base64 nghiêm ngặt — `Buffer.from(x,'base64')` một mình sẽ bỏ qua rác. */
function decodeBase64Strict(raw, { label = 'image', maxBytes = 0 } = {}) {
  const clean = String(raw).replace(/\s+/g, '');
  if (!clean) throw new ImageLabError('INVALID_IMAGE', `${label} rỗng — không có dữ liệu ảnh.`);
  if (maxBytes > 0 && clean.length > Math.ceil((maxBytes * 4) / 3) + 8) {
    throw new ImageLabError('IMAGE_TOO_LARGE', `Ảnh vượt giới hạn ${maxBytes} byte (chặn trước khi giải mã).`);
  }
  if (!BASE64_RE.test(clean)) {
    throw new ImageLabError('INVALID_IMAGE', `${label} không phải chuỗi base64 hợp lệ.`);
  }
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function decodeDataUrlOrBase64(raw, opts) {
  const value = String(raw).trim();
  const match = /^data:([a-z0-9.+/-]+);base64,(.*)$/is.exec(value);
  if (match) {
    if (!/^image\//i.test(match[1])) {
      throw new ImageLabError('INVALID_IMAGE', `Data URL không phải ảnh: ${match[1]}`);
    }
    return decodeBase64Strict(match[2], opts);
  }
  return decodeBase64Strict(value, opts);
}

/** Nhận Buffer | Uint8Array | base64 | data URL | { base64 | data_url | buffer | mime | filename }. */
function decodeImageInput(image, { maxBytes = 0 } = {}) {
  let buffer = null;
  let declaredMime = null;
  let filename = null;

  if (Buffer.isBuffer(image)) {
    buffer = image;
  } else if (image instanceof Uint8Array) {
    buffer = Buffer.from(image);
  } else if (typeof image === 'string') {
    buffer = decodeDataUrlOrBase64(image, { maxBytes });
  } else if (image && typeof image === 'object') {
    filename = image.filename ? String(image.filename).slice(0, 200) : null;
    declaredMime = typeof image.mime === 'string' ? image.mime.toLowerCase() : null;
    if (Buffer.isBuffer(image.buffer) || image.buffer instanceof Uint8Array || image.buffer instanceof ArrayBuffer) {
      buffer = Buffer.from(image.buffer);
    } else {
      const raw = image.base64 ?? image.data ?? image.data_url ?? image.dataUrl ?? null;
      if (typeof raw !== 'string') {
        throw new ImageLabError('INVALID_IMAGE', 'Thiếu dữ liệu ảnh (`image.base64`).');
      }
      buffer = decodeDataUrlOrBase64(raw, { maxBytes });
    }
  } else {
    throw new ImageLabError('INVALID_IMAGE', 'Dữ liệu ảnh không hợp lệ — cần Buffer hoặc { base64 }.');
  }

  if (!buffer || buffer.length === 0) {
    throw new ImageLabError('INVALID_IMAGE', 'Ảnh rỗng (0 byte).');
  }
  if (maxBytes > 0 && buffer.length > maxBytes) {
    throw new ImageLabError('IMAGE_TOO_LARGE', `Ảnh ${buffer.length} byte vượt giới hạn ${maxBytes} byte.`);
  }
  return { buffer, declaredMime, filename };
}

/**
 * Cắt hộp bao vào biên ảnh — không bao giờ để RenderOp tràn ra ngoài ảnh.
 *
 * H-1: đây là GIAO của hộp với khung ảnh (hàm dùng chung `src/imagelab/geometry.js`),
 * KHÔNG phải "dời gốc rồi giữ nguyên w/h" — bản cũ làm hộp có toạ độ âm bị NỚI RỘNG,
 * khiến vùng mô tả hợp lệ bị `BOX_OVERLAPS_PROTECTED` chặn oan.
 */
function clampBox(box, width, height) {
  if (!box || typeof box !== 'object') return null;
  // N-1 (vòng 4): đọc toạ độ NGHIÊM NGẶT — NULL/rác KHÔNG được coi là 0.
  const x = strictCoordinate(box.x);
  const y = strictCoordinate(box.y);
  const w = strictCoordinate(box.w ?? box.width);
  const h = strictCoordinate(box.h ?? box.height);
  if (x === null || y === null || w === null || h === null) return null;
  return intersectBoxWithImage(
    { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) },
    strictCoordinate(width),
    strictCoordinate(height),
  );
}

export class ImageTranslationPipeline {
  constructor({ config, logger, store, storage, ocrProvider = null, translator = null, renderProvider = null } = {}) {
    this.config = config ?? {};
    this.logger = logger;
    this.store = store;
    this.storage = storage;
    this.ocrProvider = ocrProvider;
    this.translator = translator;
    this.renderProvider = renderProvider;
  }

  /** Khối cấu hình `imagelab` (C1). Thiếu khối → dùng mặc định an toàn, không bịa. */
  get imagelabConfig() {
    return this.config?.imagelab || {};
  }

  /* ───────────────────────── tiện ích nội bộ ───────────────────────── */

  async #setJob(jobId, patch) {
    try {
      return await this.store.updateJob(jobId, patch);
    } catch (err) {
      // Ghi trạng thái lỗi KHÔNG được làm sập tiến trình (phong cách Pipeline.#usage).
      this.logger?.error('imagelab.job_update_failed', { job_id: jobId, error: err });
      return 0;
    }
  }

  /** Ghi usage_event — không bao giờ để lỗi ghi làm hỏng pipeline. */
  async #usage(jobId, sessionId, operation, { provider = '', model = '', inputUnits = 0, outputUnits = 0, estimatedCost = 0, meta = null } = {}) {
    const int = (v) => Math.max(0, Math.trunc(Number(v) || 0));
    try {
      await this.store.recordUsage({
        jobId,
        sessionId,
        operation,
        provider: String(provider || ''),
        model: String(model || ''),
        inputUnits: int(inputUnits),
        outputUnits: int(outputUnits),
        estimatedCost: Number.isFinite(Number(estimatedCost)) ? Number(estimatedCost) : 0,
        currency: this.config?.cost?.currency || 'USD',
        meta,
      });
    } catch (err) {
      this.logger?.warn('imagelab.usage_record_failed', { job_id: jobId, operation, error: err });
    }
  }

  /**
   * Ghi `extraction_evidence` cho job imagelab. `verification` LUÔN là MANUAL_INPUT —
   * hàm này cố tình không nhận tham số mức bằng chứng để không ai lỡ truyền LIVE vào.
   * `extractionMethod` mặc định `upload+render`; đường nhập vùng tay (§11.2 luật 9)
   * truyền `upload+render+manual-regions` để dấu vết nói đúng nguồn vùng chữ.
   */
  async #evidence(jobId, { bytes = 0, foundFields = [], missingFields = [], blockedReason = '', ocrProvider = '', contentProvider = '', extractionMethod = IMAGELAB_EXTRACTION_METHOD } = {}) {
    try {
      await this.store.recordEvidence({
        jobId,
        connector: IMAGELAB_CONNECTOR,
        extractionMethod,
        verification: imagelabVerification(),
        httpStatus: 200,
        bytes: Math.max(0, Math.trunc(Number(bytes) || 0)),
        loginRequired: false,
        blockedReason: String(blockedReason || '').slice(0, 1000),
        foundFields,
        missingFields,
        visionProvider: String(ocrProvider || ''),
        contentProvider: String(contentProvider || ''),
      });
    } catch (err) {
      this.logger?.warn('imagelab.evidence_record_failed', { job_id: jobId, error: err });
    }
  }

  /** Đánh dấu job thất bại kèm `error_code` + `finished_at` — không bao giờ treo `running`. */
  async #failJob(jobId, error) {
    const code = String(error?.code || 'IMAGELAB_FAILED');
    const message = String(error?.message || 'Bước ImageLab thất bại.').replace(/\s+/g, ' ').slice(0, 500);
    await this.#setJob(jobId, {
      status: JOB_STATUS.FAILED,
      stage: 'failed',
      error_code: code,
      error_message: message,
      finished_at: new Date().toISOString(),
    });
    return { code, message };
  }

  async #originalAsset(jobId) {
    const list = await this.store.listImageAssets(jobId, { role: 'original' });
    return Array.isArray(list) && list.length > 0 ? list[0] : null;
  }

  #allowedMime() {
    const configured = this.config?.net?.allowedImageMime;
    return Array.isArray(configured) && configured.length > 0 ? configured : ALLOWED_IMAGE_MIME;
  }

  /**
   * Hộp bao pixel của vùng trên ảnh gốc; suy từ `box_normalized` nếu `box` thiếu/hỏng.
   *
   * N-1 (vòng 4): toạ độ đọc NGHIÊM NGẶT — `null`/`undefined`/`''`/`NaN`/`Infinity`/chuỗi
   * không phải số/boolean/mảng KHÔNG được coi là 0 (trước đây `Number(null) === 0` khiến
   * hộp bảo vệ "ảo" mọc ở gốc toạ độ và pixel nhãn hiệu bị xoá thật).
   *
   * Nếu `box` hỏng nhưng `box_normalized` của CHÍNH vùng đó còn dùng được thì lấy theo nó
   * (không đoán: đây là số liệu chuẩn hoá đã lưu cùng vùng). Cả hai đều hỏng ⇒ `null`,
   * và tầng gọi phải fail-closed.
   */
  #boxOf(region, asset) {
    const width = Number(asset?.width);
    const height = Number(asset?.height);
    const b = region?.box;
    if (b && typeof b === 'object') {
      const bx = strictCoordinate(b.x);
      const by = strictCoordinate(b.y);
      const bw = strictCoordinate(b.w ?? b.width);
      const bh = strictCoordinate(b.h ?? b.height);
      if (bx !== null && by !== null && bw !== null && bh !== null && bw > 0 && bh > 0) {
        return clampBox({ x: bx, y: by, w: bw, h: bh }, width, height);
      }
    }
    const n = region?.box_normalized;
    if (n && typeof n === 'object' && Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      const nx = strictCoordinate(n.x);
      const ny = strictCoordinate(n.y);
      const nw = strictCoordinate(n.w);
      const nh = strictCoordinate(n.h);
      if (nx !== null && ny !== null && nw !== null && nh !== null && nw > 0 && nh > 0) {
        return clampBox(
          { x: nx * width, y: ny * height, w: nw * width, h: nh * height },
          width,
          height,
        );
      }
    }
    return null;
  }

  #log(jobId) {
    return this.logger?.child?.({ job_id: jobId }) ?? this.logger;
  }

  /** Ghi thêm meta cho một ImageAsset — best-effort, lỗi chỉ ghi log (không làm hỏng bước chính). */
  async #updateAssetMeta(jobId, assetId, meta) {
    if (typeof this.store?.updateImageAssetMeta !== 'function') return 0;
    try {
      return await this.store.updateImageAssetMeta(assetId, meta);
    } catch (err) {
      this.logger?.warn('imagelab.asset_meta_update_failed', { job_id: jobId, asset_id: assetId, error: err });
      return 0;
    }
  }

  /* ══════════════════════════════ 1. INGEST ══════════════════════════════ */

  /**
   * Nhận ảnh người dùng, sniff magic bytes, dò kích thước, lưu file rồi ghi
   * `image_assets` role `original`. Ảnh gốc KHÔNG BAO GIỜ bị sửa sau bước này.
   */
  async ingest(jobId, { image, sessionId, options = {} } = {}) {
    if (!jobId) throw new ImageLabError('INVALID_INPUT', 'Thiếu jobId.');
    if (!this.store) throw new ImageLabError('NOT_CONFIGURED', 'Thiếu store — không ghi được DB.');
    if (!this.storage) throw new ImageLabError('NOT_CONFIGURED', 'Thiếu storage — không lưu được ảnh.');

    const cfg = this.imagelabConfig;
    const maxBytes = Number(cfg.maxImageBytes) > 0 ? Number(cfg.maxImageBytes) : 0;
    const maxPixels = Number(cfg.maxPixels) > 0 ? Number(cfg.maxPixels) : 0;
    const log = this.#log(jobId);

    const job = await this.store.getJob(jobId);
    if (!job) throw new ImageLabError('JOB_NOT_FOUND', `Không tìm thấy job ${jobId}.`);
    const sid = sessionId || job.session_id || '';

    // 1. Giải mã + kiểm magic bytes (KHÔNG tin Content-Type client khai).
    let buffer;
    let declaredMime;
    let filename;
    try {
      ({ buffer, declaredMime, filename } = decodeImageInput(image, { maxBytes }));
    } catch (err) {
      await this.#failJob(jobId, err);
      throw err;
    }

    const mime = sniffImageMime(buffer);
    if (!mime || !this.#allowedMime().includes(mime)) {
      const err = new ImageLabError(
        'UNSUPPORTED_IMAGE',
        `Không nhận dạng được ảnh (magic bytes) hoặc định dạng không được phép${declaredMime ? ` (client khai ${declaredMime})` : ''}. Chỉ nhận PNG/JPEG/WebP/GIF.`,
      );
      await this.#failJob(jobId, err);
      throw err;
    }

    // 2. Dò kích thước (không bắt buộc — probe lỗi thì ghi width/height = null).
    let width = null;
    let height = null;
    const warnings = [];
    if (typeof this.renderProvider?.probe === 'function') {
      try {
        const probed = await this.renderProvider.probe({ buffer, mime });
        const w = Number(probed?.width);
        const h = Number(probed?.height);
        if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
          width = Math.trunc(w);
          height = Math.trunc(h);
        } else {
          warnings.push('Không dò được kích thước ảnh (probe trả về rỗng).');
        }
      } catch (err) {
        warnings.push(`Không dò được kích thước ảnh: ${err.message}`);
        log?.warn('imagelab.probe_failed', { error: err });
      }
    } else {
      warnings.push('Không có render provider để dò kích thước ảnh (bỏ qua bước probe).');
    }

    if (maxPixels > 0 && width && height && width * height > maxPixels) {
      const err = new ImageLabError('PIXELS_EXCEEDED', `Ảnh ${width}×${height} = ${width * height} pixel vượt giới hạn ${maxPixels} pixel.`);
      await this.#failJob(jobId, err);
      throw err;
    }

    // 3. Lưu file (nguyên tử) rồi ghi DB.
    await this.#setJob(jobId, {
      status: JOB_STATUS.RUNNING,
      stage: 'storing',
      error_code: null,
      error_message: null,
      finished_at: null,
    });

    const assetId = options.assetId ? String(options.assetId) : randomUUID();
    const ext = MIME_EXT[mime] || 'bin';
    const meta = {};
    if (filename) meta.filename = filename;
    // Client khai mime khác magic bytes → ghi vết, không im lặng.
    if (declaredMime && declaredMime !== mime) meta.declared_mime = declaredMime;
    if (warnings.length > 0) meta.warnings = warnings;

    const saved = await this.storage.save({ jobId, assetId, ext, buffer });
    try {
      await this.store.createImageAsset({
        id: assetId,
        jobId,
        sessionId: sid,
        role: 'original',
        parentId: null,
        mime,
        bytes: saved.bytes,
        width,
        height,
        sha256: saved.sha256,
        storagePath: saved.storage_path,
        source: 'upload',
        meta: Object.keys(meta).length > 0 ? meta : null,
      });
    } catch (err) {
      // Ghi DB hỏng → dọn file vừa ghi để không để rác mồ côi.
      await this.storage.remove({ storage_path: saved.storage_path }).catch(() => {});
      await this.#failJob(jobId, err);
      throw err;
    }

    const asset = await this.store.getImageAsset(assetId);
    await this.#evidence(jobId, {
      bytes: saved.bytes,
      foundFields: ['image_asset:original'],
      missingFields: ['ocr_regions', 'translation_lines'],
      blockedReason: '',
      ocrProvider: this.ocrProvider?.name || '',
    });
    // IL08-04 (vòng 6): LƯU trần theo JOB để mọi bước sau (nhập vùng tay, render) áp CÙNG
    // trần mà client đã khai lúc tạo job — trước đây `options.max_regions` chỉ có tác dụng
    // trong đúng lượt `runOcr` rồi biến mất.
    const jobCaps = {};
    const optMaxRegions = Number(options?.maxRegions ?? options?.max_regions);
    if (Number.isFinite(optMaxRegions) && optMaxRegions > 0) jobCaps.max_regions = Math.trunc(optMaxRegions);
    const latestJob = await this.store.getJob(jobId);
    await this.#setJob(jobId, {
      status: JOB_STATUS.QUEUED,
      stage: 'queued',
      ...(Object.keys(jobCaps).length > 0
        ? {
            content_meta: {
              ...(latestJob?.content_meta || {}),
              imagelab: { ...(latestJob?.content_meta?.imagelab || {}), limits: jobCaps },
            },
          }
        : {}),
    });

    log?.info('imagelab.ingest_done', { asset_id: assetId, mime, bytes: saved.bytes, width, height, warnings: warnings.length });
    return { asset_id: assetId, asset, width, height, sha256: saved.sha256, mime, warnings };
  }

  /* ══════════════════════════════ 2. RUN OCR ═════════════════════════════ */

  /**
   * OCR → dịch → lưu regions + lines → `awaiting_review`, `finished_at = null`.
   * KHÔNG tự render. Lỗi provider → `failed` + `error_code` + `finished_at`.
   */
  async runOcr(jobId, { sessionId, options = {} } = {}) {
    const started = Date.now();
    const log = this.#log(jobId);
    const cfg = this.imagelabConfig;

    const job = await this.store.getJob(jobId);
    if (!job) throw new ImageLabError('JOB_NOT_FOUND', `Không tìm thấy job ${jobId}.`);
    const sid = sessionId || job.session_id || '';

    const asset = await this.#originalAsset(jobId);
    if (!asset) {
      const err = new ImageLabError('IMAGELAB_NO_ASSET', 'Job chưa có ảnh gốc — phải gọi ingest() trước khi OCR.');
      await this.#failJob(jobId, err);
      throw err;
    }

    await this.#setJob(jobId, {
      status: JOB_STATUS.RUNNING,
      stage: 'ocr',
      error_code: null,
      error_message: null,
      finished_at: null,
    });

    let buffer;
    try {
      buffer = await this.storage.read(asset);
    } catch (err) {
      await this.#failJob(jobId, err);
      throw err;
    }
    const mime = asset.mime || sniffImageMime(buffer) || 'application/octet-stream';
    const pixels = Number(asset.width) > 0 && Number(asset.height) > 0
      ? Number(asset.width) * Number(asset.height)
      : 0;

    // ── OCR ────────────────────────────────────────────────────────────────
    const failedResult = (code, message, extra = {}) => ({
      status: JOB_STATUS.FAILED,
      stage: 'failed',
      error_code: code,
      error_message: message,
      regions: [],
      lines: [],
      ocr: null,
      translate: null,
      ...extra,
    });

    if (!this.ocrProvider || this.ocrProvider.configured === false) {
      const err = new ImageLabError('NOT_CONFIGURED', 'Chưa cấu hình OCR provider — không chạy được bước nhận dạng chữ.');
      await this.#failJob(jobId, err);
      return failedResult(err.code, err.message);
    }

    const maxRegions = Number(options.maxRegions ?? options.max_regions ?? cfg.maxRegions);
    const minConfidence = Number(options.minConfidence ?? options.min_confidence ?? cfg.minConfidence);
    let ocr;
    try {
      ocr = await this.ocrProvider.detect(
        { buffer, mime, width: asset.width, height: asset.height },
        {
          ...(Number.isFinite(maxRegions) && maxRegions > 0 ? { maxRegions } : {}),
          ...(Number.isFinite(minConfidence) ? { minConfidence } : {}),
        },
      );
    } catch (err) {
      const wrapped = new ImageLabError(String(err?.code || 'OCR_FAILED'), `OCR thất bại: ${err?.message || err}`);
      log?.error('imagelab.ocr_failed', { error: err });
      await this.#failJob(jobId, wrapped);
      return failedResult(wrapped.code, wrapped.message);
    }

    const ocrStatus = String(ocr?.status || 'FAILED');
    const regions = Array.isArray(ocr?.regions) ? ocr.regions : [];
    const warnings = Array.isArray(ocr?.warnings) ? ocr.warnings.map(String).slice(0, 50) : [];
    const dropped = Array.isArray(ocr?.dropped) ? ocr.dropped : [];

    // usage OCR_DETECT: input_units = số pixel, output_units = số region.
    if (ocrStatus === 'OK' || ocrStatus === 'NO_TEXT') {
      await this.#usage(jobId, sid, 'OCR_DETECT', {
        provider: ocr?.provider || this.ocrProvider.name || '',
        model: ocr?.model || this.ocrProvider.model || '',
        inputUnits: pixels || Number(ocr?.usage?.input_units) || 0,
        outputUnits: regions.length,
        estimatedCost: this.config?.cost?.OCR_DETECT ?? 0,
        meta: {
          is_mock: Boolean(ocr?.is_mock),
          status: ocrStatus,
          ms: Date.now() - started,
          width: asset.width,
          height: asset.height,
          dropped: dropped.length,
        },
      });
    }

    if (ocrStatus === 'NOT_CONFIGURED' || ocrStatus === 'FAILED' || ocrStatus === 'UNSUPPORTED_IMAGE') {
      const code = String(ocr?.error_code || (ocrStatus === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : ocrStatus === 'UNSUPPORTED_IMAGE' ? 'UNSUPPORTED_IMAGE' : 'OCR_FAILED'));
      const message = String(ocr?.error_message || `OCR không chạy được (status = ${ocrStatus}).`).slice(0, 500);
      await this.#failJob(jobId, { code, message });
      return failedResult(code, message, { ocr, warnings });
    }

    // ── IL08-01(b) (vòng 6): ĐỌC LẠI job NGAY TRƯỚC KHI GHI ──────────────
    // (a) đã chặn đường vào thường, nhưng vẫn còn KHE giữa lúc kiểm tra và lúc ghi (đúng
    // lớp lỗi TOCTOU). Lớp này bảo đảm: vùng do NGƯỜI DÙNG nhập KHÔNG BAO GIỜ bị OCR xoá
    // im lặng — thà bỏ kết quả OCR còn hơn mất dữ liệu người dùng.
    const freshJob = await this.store.getJob(jobId);
    const freshMeta = freshJob?.content_meta?.imagelab || {};
    const freshRegions = (await this.store.listOcrRegions(jobId)) || [];
    const userRegions = freshRegions.filter((r) => String(r?.source ?? '') === 'user');
    if (freshMeta.manual_regions === true || userRegions.length > 0) {
      const guardWarning =
        `Vùng do NGƯỜI DÙNG nhập tay đã thay kết quả OCR — KHÔNG ghi đè (${userRegions.length} vùng nguồn 'user'` +
        `${freshMeta.manual_regions === true ? ', dấu vết manual_regions = true' : ''}). Kết quả OCR lần này bị BỎ.`;
      const prevWarnings = Array.isArray(freshMeta.warnings) ? freshMeta.warnings.map(String) : [];
      await this.#setJob(jobId, {
        status: JOB_STATUS.AWAITING_REVIEW,
        stage: 'awaiting_review',
        finished_at: null,
        content_meta: {
          ...(freshJob?.content_meta || {}),
          imagelab: {
            ...freshMeta,
            manual_regions: true,
            regions_source: 'user',
            // Dấu vết: lần OCR này có chạy nhưng KHÔNG được ghi vào DB.
            ocr_superseded: {
              at: new Date().toISOString(),
              provider: ocr?.provider || '',
              status: ocrStatus,
              skipped_write: true,
              user_regions: userRegions.length,
            },
            warnings: [...prevWarnings, guardWarning],
            updated_at: new Date().toISOString(),
          },
        },
      });
      const keptLines = (await this.store.listTranslationLines(jobId)) || [];
      log?.warn('imagelab.ocr_skipped_manual_regions', { user_regions: userRegions.length });
      return {
        status: JOB_STATUS.AWAITING_REVIEW,
        stage: 'awaiting_review',
        asset,
        regions: freshRegions,
        lines: keptLines,
        ocr,
        translate: null,
        skipped_ocr_write: true,
        mock_steps: Array.isArray(freshMeta.mock_steps) ? freshMeta.mock_steps.map(String) : [],
        warnings: [...warnings, guardWarning],
        duration_ms: Date.now() - started,
      };
    }

    // ── Lưu vùng OCR (idempotent theo job) ────────────────────────────────
    try {
      await this.store.saveOcrRegions(jobId, asset.id, regions);
    } catch (err) {
      const wrapped = new ImageLabError('DB_WRITE_FAILED', `Không lưu được vùng OCR: ${err.message}`);
      await this.#failJob(jobId, wrapped);
      return failedResult(wrapped.code, wrapped.message, { ocr, warnings });
    }

    // ── Dịch ──────────────────────────────────────────────────────────────
    await this.#setJob(jobId, { stage: 'translating' });
    const translatableCount = regions.filter((r) => r?.translatable === true).length;
    let translate = null;
    let providerLines = [];

    if (!this.translator || this.translator.configured === false) {
      if (translatableCount === 0) {
        // Không có vùng nào được phép dịch → bỏ qua bước dịch, KHÔNG tốn usage.
        translate = {
          status: 'NO_LINES', provider: 'none', model: '', is_mock: false, lines: [],
          warnings: ['Không có vùng nào được phép dịch — bỏ qua bước dịch (không gọi provider).'],
          usage: null, error_code: null, error_message: null,
        };
      } else {
        const err = new ImageLabError('NOT_CONFIGURED', 'Chưa cấu hình dịch provider — không dịch được vùng chữ nào.');
        await this.#failJob(jobId, err);
        return failedResult(err.code, err.message, { ocr, warnings });
      }
    } else {
      try {
        translate = await this.translator.translateRegions(regions, {
          context: options.context || '',
          glossaryExtra: options.glossaryExtra || options.glossary_extra || {},
        });
      } catch (err) {
        const wrapped = new ImageLabError(String(err?.code || 'TRANSLATE_FAILED'), `Dịch thất bại: ${err?.message || err}`);
        log?.error('imagelab.translate_failed', { error: err });
        await this.#failJob(jobId, wrapped);
        return failedResult(wrapped.code, wrapped.message, { ocr, warnings, regions });
      }
    }

    const translateStatus = String(translate?.status || 'FAILED');
    if (translateStatus === 'NOT_CONFIGURED' || translateStatus === 'FAILED') {
      const code = String(translate?.error_code || (translateStatus === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'TRANSLATE_FAILED'));
      const message = String(translate?.error_message || `Dịch không chạy được (status = ${translateStatus}).`).slice(0, 500);
      await this.#failJob(jobId, { code, message });
      return failedResult(code, message, { ocr, translate, warnings, regions });
    }

    providerLines = Array.isArray(translate?.lines) ? translate.lines : [];
    const translateWarnings = Array.isArray(translate?.warnings) ? translate.warnings.map(String).slice(0, 50) : [];

    // usage TRANSLATION: input/output = số ký tự. Chỉ ghi khi provider THẬT SỰ chạy.
    if (translateStatus === 'OK') {
      await this.#usage(jobId, sid, 'TRANSLATION', {
        provider: translate?.provider || '',
        model: translate?.model || '',
        inputUnits: providerLines.reduce((n, l) => n + String(l?.text_original ?? '').length, 0),
        outputUnits: providerLines.reduce((n, l) => n + String(l?.text_vi ?? '').length, 0),
        estimatedCost: this.config?.cost?.TRANSLATION ?? 0,
        meta: {
          is_mock: Boolean(translate?.is_mock),
          status: translateStatus,
          ms: Date.now() - started,
          lines: providerLines.length,
          translatable_regions: translatableCount,
        },
      });
    }

    // ── Lưu dòng dịch (idempotent theo job) ───────────────────────────────
    try {
      await this.store.saveTranslationLines(jobId, providerLines);
    } catch (err) {
      const wrapped = new ImageLabError('DB_WRITE_FAILED', `Không lưu được dòng dịch: ${err.message}`);
      await this.#failJob(jobId, wrapped);
      return failedResult(wrapped.code, wrapped.message, { ocr, translate, warnings, regions });
    }

    // Đọc lại từ DB: thứ trả về phải là thứ ĐÃ LƯU, không phải lời hứa của provider.
    const lines = await this.store.listTranslationLines(jobId);
    const persistedRegions = await this.store.listOcrRegions(jobId);

    // ── Bằng chứng + trạng thái chờ duyệt ─────────────────────────────────
    const mockSteps = [];
    if (ocr?.is_mock) mockSteps.push('ocr');
    if (translate?.is_mock) mockSteps.push('translate');
    const blockedReason = mockSteps.length > 0
      ? `Có bước chạy provider MOCK (${mockSteps.join(', ')}) — kết quả là dữ liệu minh hoạ, KHÔNG phải kết quả thật.`
      : '';

    const warningsAll = [...warnings, ...translateWarnings];
    await this.#setJob(jobId, {
      status: JOB_STATUS.AWAITING_REVIEW,
      stage: 'awaiting_review',
      finished_at: null,
      error_code: null,
      error_message: null,
      content_meta: {
        ...(job.content_meta || {}),
        imagelab: {
          // IL08-04 (vòng 6): GIỮ các field đã có của `imagelab` (vd `limits.max_regions`
          // do `ingest` ghi, `manual_regions`) — dựng lại từ đầu là cách làm mất dấu vết
          // và làm trần theo job biến mất sau bước OCR.
          ...(job.content_meta?.imagelab || {}),
          mock_steps: mockSteps,
          ocr: {
            provider: ocr?.provider || '',
            model: ocr?.model || '',
            is_mock: Boolean(ocr?.is_mock),
            status: ocrStatus,
            regions: persistedRegions.length,
            dropped: dropped.length,
          },
          translate: {
            provider: translate?.provider || '',
            model: translate?.model || '',
            is_mock: Boolean(translate?.is_mock),
            status: translateStatus,
            lines: lines.length,
          },
          warnings: warningsAll,
          updated_at: new Date().toISOString(),
        },
      },
    });

    await this.#evidence(jobId, {
      bytes: asset.bytes,
      foundFields: ['image_asset:original', `ocr_regions:${persistedRegions.length}`, `translation_lines:${lines.length}`],
      missingFields: lines.length > 0 ? [] : ['translation_lines'],
      blockedReason,
      ocrProvider: ocr?.provider || '',
      contentProvider: translate?.provider || '',
    });

    // Ghi vết OCR lên meta của ẢNH GỐC để C5 đọc `asset.meta.ocr` (vùng bị bỏ + cảnh báo)
    // mà không phải bịa. Lỗi ở bước này chỉ ghi log — dữ liệu chính đã nằm ở bảng riêng.
    await this.#updateAssetMeta(jobId, asset.id, {
      ocr: {
        status: ocrStatus,
        provider: ocr?.provider || '',
        model: ocr?.model || '',
        is_mock: Boolean(ocr?.is_mock),
        regions: persistedRegions.length,
        dropped: dropped.slice(0, 50).map((d) => ({
          reason: String(d?.reason ?? '').slice(0, 200),
          ...(d?.text ? { text: String(d.text).slice(0, 200) } : {}),
        })),
        warnings,
      },
    });

    log?.info('imagelab.ocr_done', {
      ocr_status: ocrStatus,
      regions: persistedRegions.length,
      lines: lines.length,
      dropped: dropped.length,
      mock_steps: mockSteps,
      ms: Date.now() - started,
    });

    return {
      status: JOB_STATUS.AWAITING_REVIEW,
      stage: 'awaiting_review',
      asset,
      regions: persistedRegions,
      lines,
      ocr,
      translate,
      mock_steps: mockSteps,
      warnings: warningsAll,
      duration_ms: Date.now() - started,
    };
  }

  /* ═══════════════════ 2b. VÙNG CHỮ NHẬP TAY (IL-08) ═══════════════════ */

  /**
   * IL-08 — người dùng tự nhập vùng chữ (thay thế hoặc ghi thêm vùng OCR) rồi dịch.
   *
   * Vì sao có đường này: `OCR_PROVIDER=mock` trả về fixture cố định, KHÔNG liên quan tới
   * ảnh người dùng dán vào — nên trên ảnh THẬT tính năng không dùng được cho tới khi cắm
   * OCR thật. Đường nhập tay gỡ đúng điểm chết đó (“OCR không được là điểm chết duy nhất”).
   *
   * Mười luật của hợp đồng §11.2 nằm ở ĐÚNG hàm này:
   *   1. `text` bắt buộc, làm sạch ≤ 500 ký tự; rỗng ⇒ vào `rejected` (không im lặng).
   *   2. hộp: 4 số hữu hạn (`strictCoordinate`) rồi GIAO với khung ảnh
   *      (`intersectBoxWithImage`); giao rỗng ⇒ `BOX_OUTSIDE_IMAGE`; hộp bị cắt thì ghi
   *      lại hộp ĐÃ CẮT (không giữ hộp tràn ra ngoài).
   *   3. `kind` hợp lệ thì dùng, không thì `classifyRegion(text)`; bất biến
   *      `translatable === (kind === 'descriptive')`.
   *   4. `confidence` mặc định 1 (người dùng tự nhập, không phải máy đoán), clamp 0..1.
   *   5. `source = 'user'`; id `u1..uN` (giữ id client gửi nếu an toàn và chưa trùng).
   *   6. `replace = true` ⇒ xoá vùng + dòng cũ rồi ghi lại; có dòng `edited_by_user` mà
   *      chưa xác nhận ⇒ `MANUAL_EDITS_WOULD_BE_LOST` và KHÔNG xoá gì.
   *      `replace = false` ⇒ ghi thêm, id tiếp tục dãy `u…`.
   *   7. Dịch qua `translator.translateRegions` (§4.2) rồi ghi lines; job về
   *      `awaiting_review`, `stage = 'awaiting_review'`, `finished_at = null`.
   *   8. KHÔNG ghi `OCR_DETECT` (không có OCR nào chạy — ghi vào là BỊA usage);
   *      `TRANSLATION` ghi như bình thường khi thật sự có vùng cần dịch.
   *   9. Dấu vết: `content_meta.imagelab.manual_regions = true`,
   *      `content_meta.imagelab.regions_source = 'user'`,
   *      `extraction_evidence.extraction_method = 'upload+render+manual-regions'`;
   *      job vẫn `MANUAL_INPUT` ở tầng evidence — KHÔNG BAO GIỜ `LIVE_VERIFIED`.
   *  10. Mọi vùng bị bỏ đều nằm trong `rejected` kèm `index` (vị trí trong mảng client
   *      gửi) + `code` máy đọc được + câu tiếng Việt.
   *
   * Lỗi translator KHÔNG làm job treo: kết quả `FAILED`/`NOT_CONFIGURED` của C2 vẫn được
   * ghi thành lines (FAILED) rồi job về `awaiting_review` — người dùng thấy đúng sự thật.
   */
  async setManualRegions(jobId, {
    sessionId = '',
    regions = [],
    replace = true,
    confirmReplaceEdited = false,
    // IL08-01(a): `true` = job đang CHỜ trong hàng đợi OCR; `false` = chắc chắn KHÔNG có
    // lượt OCR nào đang chờ (vd công cụ demo cố ý bỏ qua OCR); `null`/bỏ trống = suy từ
    // trạng thái job (an toàn: `queued` coi như đang chờ).
    ocrPending = null,
  } = {}) {
    const started = Date.now();
    const log = this.#log(jobId);
    const cfg = this.imagelabConfig;

    if (!jobId) throw new ImageLabError('INVALID_INPUT', 'Thiếu jobId.');
    if (!this.store) throw new ImageLabError('NOT_CONFIGURED', 'Thiếu store — không ghi được DB.');

    const job = await this.store.getJob(jobId);
    if (!job) throw new ImageLabError('JOB_NOT_FOUND', `Không tìm thấy job ${jobId}.`);
    const sid = sessionId || job.session_id || '';

    // ── Luật 11.2 (tiền điều kiện): phải có ẢNH GỐC ───────────────────────
    // Không có ảnh gốc thì không có khung để kẹp hộp và cũng không có gì để render sau.
    // Đây là lỗi TIỀN ĐIỀU KIỆN (C5 map 409): KHÔNG đánh job `failed` — job chưa hỏng,
    // người dùng còn phải tải ảnh lên rồi gọi lại.
    const asset = await this.#originalAsset(jobId);
    if (!asset) {
      throw new ImageLabError(
        'IMAGELAB_NO_ORIGINAL',
        'Job chưa có ảnh gốc — hãy tải ảnh lên trước khi nhập vùng chữ bằng tay.',
      );
    }

    // ── IL08-01(a) (vòng 6): job ĐANG chạy ⇒ TỪ CHỐI, KHÔNG ghi gì ───────
    // Khe thời gian THẬT: người dùng mở khối nhập tay trong lúc OCR còn chạy (OCR mock
    // nhanh, OCR THẬT chậm vài giây) rồi bấm lưu; nếu cho ghi thì khi OCR xong,
    // `saveOcrRegions` sẽ xoá vùng người dùng và dấu vết `manual_regions` biến mất —
    // mất dữ liệu im lặng (luật #4). Trả 409 có mã riêng + câu tiếng Việt để UI nói rõ.
    const pending = ocrPending === null || ocrPending === undefined
      ? job.status === JOB_STATUS.QUEUED // không ai nói rõ ⇒ mặc định an toàn: đang chờ
      : ocrPending === true;
    if (job.status === JOB_STATUS.RUNNING || (job.status === JOB_STATUS.QUEUED && pending)) {
      throw new ImageLabError(
        'IMAGELAB_JOB_RUNNING',
        `Job đang chạy OCR/dịch (status = ${job.status}, stage = ${job.stage || '—'}) — chờ xong rồi hãy nhập vùng chữ bằng tay. KHÔNG có gì bị ghi.`,
        { status: job.status, stage: job.stage ?? null, ocr_pending: pending },
      );
    }

    // ── Module dịch phải có TRƯỚC khi ghi bất cứ thứ gì ────────────────────
    // Thiếu module ⇒ dừng tay: không để lại vùng chữ mà không bao giờ có dòng dịch.
    if (!this.translator || typeof this.translator.translateRegions !== 'function') {
      throw new ImageLabError('NOT_CONFIGURED', 'Chưa cấu hình module dịch — chưa thể nhập vùng chữ bằng tay (chưa ghi gì).');
    }

    // ── Luật 6: cổng bảo vệ bản sửa tay của người dùng ────────────────────
    const currentLines = (await this.store.listTranslationLines(jobId)) || [];
    const editedLines = currentLines.filter((l) => l?.edited_by_user === true);
    if (replace === true && editedLines.length > 0 && confirmReplaceEdited !== true) {
      throw new ImageLabError(
        'MANUAL_EDITS_WOULD_BE_LOST',
        `Job đang có ${editedLines.length} dòng người dùng đã sửa tay (${editedLines
          .slice(0, 10)
          .map((l) => l.region_id)
          .join(', ')}) — thay toàn bộ vùng sẽ làm MẤT các bản sửa đó. Gửi lại với confirm_replace_edited = true nếu vẫn muốn thay.`,
        { edited_region_ids: editedLines.map((l) => l.region_id).slice(0, 100), edited_lines: editedLines.length },
      );
    }

    const existingRegions = (await this.store.listOcrRegions(jobId)) || [];
    const usedIds = replace === true
      ? []
      : existingRegions.map((r) => String(r.id ?? r.region_key ?? '')).filter(Boolean);

    // ── Luật 1..5: chuẩn hoá vùng nhập tay (hàm THUẦN `manual-regions.js`) ─
    // Trần vùng tính theo SỐ CHỖ CÒN LẠI khi ghi thêm, để tổng không vượt trần HIỆU LỰC.
    // IL08-04 (vòng 6): trần hiệu lực = min(trần cấu hình, trần RIÊNG của job nếu có).
    const cfgMax = Number(cfg.maxRegions) > 0 ? Math.trunc(Number(cfg.maxRegions)) : 0;
    const jobMaxRaw = Number(job.content_meta?.imagelab?.limits?.max_regions);
    const jobMax = Number.isFinite(jobMaxRaw) && jobMaxRaw > 0 ? Math.trunc(jobMaxRaw) : 0;
    const maxRegions = cfgMax > 0 && jobMax > 0 ? Math.min(cfgMax, jobMax) : (cfgMax || jobMax);
    const cap = maxRegions > 0 ? Math.max(0, maxRegions - usedIds.length) : undefined;
    const normalizedResult = normalizeManualRegions(regions, {
      width: asset.width,
      height: asset.height,
      ...(cap === undefined ? {} : { maxRegions: cap }),
      idPrefix: MANUAL_ID_PREFIX,
      usedIds,
    });
    const normalized = normalizedResult.regions;
    const rejected = normalizedResult.rejected;
    const warnings = [...normalizedResult.warnings];

    // Người dùng xác nhận thay dù có bản sửa tay ⇒ ghi vết rõ, không im lặng.
    if (replace === true && editedLines.length > 0 && confirmReplaceEdited === true) {
      warnings.push(`⚠️ Đã thay thế toàn bộ vùng theo xác nhận của người dùng: ${editedLines.length} bản sửa tay đã bị xoá.`);
    }
    if (replace === true && normalized.length === 0 && existingRegions.length > 0) {
      warnings.push(
        `⚠️ KHÔNG vùng nhập tay nào dùng được nhưng vẫn thay thế theo yêu cầu (replace = true): đã XOÁ ${existingRegions.length} vùng cũ của job. Xem "rejected" để biết lý do từng vùng.`,
      );
    }

    // ── Ghi vùng: thay thế (mặc định) hoặc ghi thêm ───────────────────────
    const toSave = replace === true ? normalized : [...existingRegions, ...normalized];
    try {
      await this.store.saveOcrRegions(jobId, asset.id, toSave);
    } catch (err) {
      const wrapped = new ImageLabError('DB_WRITE_FAILED', `Không lưu được vùng nhập tay: ${err.message}`);
      await this.#failJob(jobId, wrapped);
      throw wrapped;
    }

    await this.#setJob(jobId, {
      status: JOB_STATUS.RUNNING,
      stage: 'translating',
      error_code: null,
      error_message: null,
      finished_at: null,
    });

    // ── Luật 7: dịch vùng MỚI (không đụng bản sửa tay ở chế độ ghi thêm) ──
    const translatableCount = normalized.filter((r) => r.translatable === true).length;
    let translate = null;
    let providerLines = [];
    try {
      // Luật §4.2 nằm ở C2: vùng `translatable === false` KHÔNG BAO GIỜ được gửi provider.
      translate = await this.translator.translateRegions(normalized, {});
    } catch (err) {
      const wrapped = new ImageLabError(String(err?.code || 'TRANSLATE_FAILED'), `Dịch vùng nhập tay thất bại: ${err?.message || err}`);
      log?.error('imagelab.manual_regions_translate_failed', { error: err });
      // Chế độ thay thế: vùng cũ đã bị xoá ⇒ không để lại dòng mồ côi trỏ vào vùng không còn.
      if (replace === true) await this.store.saveTranslationLines(jobId, []).catch(() => {});
      await this.#failJob(jobId, wrapped);
      throw wrapped;
    }

    const translateStatus = String(translate?.status || 'FAILED');
    providerLines = Array.isArray(translate?.lines) ? translate.lines : [];
    const translateWarnings = Array.isArray(translate?.warnings) ? translate.warnings.map(String).slice(0, 50) : [];
    const translateFailed = translateStatus === 'NOT_CONFIGURED' || translateStatus === 'FAILED';

    // ── Luật 8: usage — TUYỆT ĐỐI KHÔNG `OCR_DETECT` ───────────────────────
    // Không có OCR nào chạy cho vùng nhập tay; ghi `OCR_DETECT` vào là BỊA usage (và làm
    // hỏng mọi thống kê chi phí OCR sau này). Chỉ `TRANSLATION`, và chỉ khi thật sự có
    // vùng cần dịch (không có vùng translatable thì C2 còn không gọi provider).
    if (translateStatus === 'OK' && translatableCount > 0) {
      await this.#usage(jobId, sid, 'TRANSLATION', {
        provider: translate?.provider || '',
        model: translate?.model || '',
        inputUnits: providerLines.reduce((n, l) => n + String(l?.text_original ?? '').length, 0),
        outputUnits: providerLines.reduce((n, l) => n + String(l?.text_vi ?? '').length, 0),
        estimatedCost: this.config?.cost?.TRANSLATION ?? 0,
        meta: {
          is_mock: Boolean(translate?.is_mock),
          status: translateStatus,
          ms: Date.now() - started,
          lines: providerLines.length,
          translatable_regions: translatableCount,
          regions_source: 'user',
          manual_regions: true,
        },
      });
    }

    // ── Ghi lines: thay thế, hoặc GIỮ bản sửa tay rồi thêm dòng mới ────────
    const mergedLines = replace === true ? providerLines : [...currentLines, ...providerLines];
    try {
      await this.store.saveTranslationLines(jobId, mergedLines);
    } catch (err) {
      const wrapped = new ImageLabError('DB_WRITE_FAILED', `Không lưu được dòng dịch của vùng nhập tay: ${err.message}`);
      await this.#failJob(jobId, wrapped);
      throw wrapped;
    }

    // Đọc lại từ DB: thứ trả về phải là thứ ĐÃ LƯU, không phải lời hứa của provider.
    const lines = await this.store.listTranslationLines(jobId);
    const persistedRegions = await this.store.listOcrRegions(jobId);

    // ── Luật 9: dấu vết + trạng thái chờ duyệt ────────────────────────────
    const prevMeta = job.content_meta?.imagelab || {};
    const mockSteps = Array.from(
      new Set([
        ...(Array.isArray(prevMeta.mock_steps) ? prevMeta.mock_steps.map(String) : []),
        ...(translate?.is_mock ? ['translate'] : []),
      ]),
    );
    const warningsAll = [...warnings, ...translateWarnings];
    if (translateFailed) {
      warningsAll.push(
        `Dịch vùng nhập tay không chạy được (status = ${translateStatus}) — các dòng cần dịch đang ở trạng thái FAILED; job vẫn ở "chờ duyệt", KHÔNG bị treo.`,
      );
    }

    const mockNote = mockSteps.length > 0
      ? `Có bước chạy provider MOCK (${mockSteps.join(', ')}) — kết quả là dữ liệu minh hoạ, KHÔNG phải kết quả thật.`
      : '';
    const manualNote = `Vùng chữ do NGƯỜI DÙNG nhập tay (source = user): ${normalized.length} vùng được nhận, ${rejected.length} vùng bị bỏ — KHÔNG có bước OCR nào chạy cho các vùng này.`;

    const jobUpdate = await this.#setJob(jobId, {
      status: JOB_STATUS.AWAITING_REVIEW,
      stage: 'awaiting_review',
      finished_at: null,
      error_code: translateFailed
        ? String(translate?.error_code || (translateStatus === 'NOT_CONFIGURED' ? 'TRANSLATE_NOT_CONFIGURED' : 'TRANSLATE_FAILED'))
        : null,
      error_message: translateFailed
        ? String(translate?.error_message || `Dịch không chạy được (status = ${translateStatus}).`).slice(0, 500)
        : null,
      content_meta: {
        ...(job.content_meta || {}),
        imagelab: {
          ...prevMeta,
          // Hai field C5 đọc thẳng (hợp đồng §11.2 luật 9).
          manual_regions: true,
          regions_source: 'user',
          regions: persistedRegions.length,
          lines: lines.length,
          manual: {
            at: new Date().toISOString(),
            requested: Array.isArray(regions) ? regions.length : 0,
            accepted: normalized.length,
            rejected: rejected.length,
            replace: replace === true,
            confirm_replace_edited: confirmReplaceEdited === true,
          },
          mock_steps: mockSteps,
          translate: {
            provider: translate?.provider || '',
            model: translate?.model || '',
            is_mock: Boolean(translate?.is_mock),
            status: translateStatus,
            lines: providerLines.length,
          },
          warnings: warningsAll,
          updated_at: new Date().toISOString(),
        },
      },
    });
    if (!jobUpdate) log?.warn('imagelab.manual_regions_job_update_empty', { job_id: jobId });

    await this.#evidence(jobId, {
      bytes: asset.bytes,
      extractionMethod: IMAGELAB_EXTRACTION_METHOD_MANUAL,
      foundFields: ['image_asset:original', 'regions_source:user', `ocr_regions:${persistedRegions.length}`, `translation_lines:${lines.length}`],
      missingFields: lines.length > 0 ? [] : ['translation_lines'],
      blockedReason: [mockNote, manualNote].filter(Boolean).join(' '),
      // KHÔNG truyền OCR provider: bước này KHÔNG chạy OCR. Dấu vết OCR (nếu có) nằm ở
      // bản ghi evidence trước đó + `content_meta.imagelab.ocr`.
      ocrProvider: '',
      contentProvider: translate?.provider || '',
    });

    // Meta ẢNH GỐC còn giữ bản ghi OCR cũ (`asset.meta.ocr` — C5 đọc để hiện "vùng OCR bị
    // bỏ"). Sau khi THAY bằng vùng người dùng nhập, thông tin đó là LỊCH SỬ, không còn mô
    // tả vùng đang có ⇒ ghi dấu đã bị thay (không xoá, không sửa số liệu cũ).
    const prevOcrMeta = asset.meta && typeof asset.meta === 'object' && asset.meta.ocr && typeof asset.meta.ocr === 'object'
      ? asset.meta.ocr
      : null;
    if (replace === true && prevOcrMeta) {
      await this.#updateAssetMeta(jobId, asset.id, {
        ocr: { ...prevOcrMeta, superseded_by_manual_regions: true, superseded_at: new Date().toISOString() },
      });
    }

    log?.info('imagelab.manual_regions_done', {
      accepted: normalized.length,
      rejected: rejected.length,
      regions: persistedRegions.length,
      lines: lines.length,
      replace: replace === true,
      translate_status: translateStatus,
      ms: Date.now() - started,
    });

    return {
      job_id: jobId,
      status: JOB_STATUS.AWAITING_REVIEW,
      stage: 'awaiting_review',
      asset,
      regions: persistedRegions,
      lines,
      rejected,
      warnings: warningsAll,
      translate,
      manual: {
        requested: Array.isArray(regions) ? regions.length : 0,
        accepted: normalized.length,
        rejected: rejected.length,
        replace: replace === true,
      },
      duration_ms: Date.now() - started,
    };
  }

  /* ═══════════════════════════ 3. RENDER APPROVED ═══════════════════════ */

  /**
   * Dựng RenderOp từ các dòng ĐÃ DUYỆT rồi render ra ảnh mới (role `rendered`,
   * `parent_id` = ảnh gốc). Ảnh gốc chỉ được đọc.
   */
  async renderApproved(jobId, { sessionId, onlyRegionIds, force = false, unknownRegionIds = [] } = {}) {
    const started = Date.now();
    const log = this.#log(jobId);
    const cfg = this.imagelabConfig;

    const job = await this.store.getJob(jobId);
    if (!job) throw new ImageLabError('JOB_NOT_FOUND', `Không tìm thấy job ${jobId}.`);
    const sid = sessionId || job.session_id || '';

    const original = await this.#originalAsset(jobId);
    if (!original) {
      const err = new ImageLabError('IMAGELAB_NO_ASSET', 'Job chưa có ảnh gốc — không có gì để render.');
      await this.#failJob(jobId, err);
      throw err;
    }

    const allLines = await this.store.listTranslationLines(jobId);
    if (!Array.isArray(allLines) || allLines.length === 0) {
      // Cổng nghiệp vụ của hợp đồng 4.4 — KHÔNG đánh job failed (người dùng còn phải duyệt).
      throw new ImageLabError('IMAGELAB_NO_LINES', 'Job chưa có dòng dịch nào để render — hãy chạy OCR + dịch và duyệt trước.');
    }

    const selected = Array.isArray(onlyRegionIds) && onlyRegionIds.length > 0
      ? new Set(onlyRegionIds.map(String))
      : null;
    const lines = selected ? allLines.filter((l) => selected.has(String(l.region_id))) : allLines;

    // Còn dòng NEEDS_REVIEW chưa duyệt → chặn (C5 map thành HTTP 409).
    const pending = pendingReviewLines(allLines);
    if (pending.length > 0 && force !== true) {
      throw new ImageLabError(
        'REVIEW_REQUIRED',
        `Còn ${pending.length} dòng cần người duyệt (${pending.map((l) => l.region_id).slice(0, 10).join(', ')}) — hãy duyệt hoặc gọi lại với force = true.`,
        { regions: pending.map((l) => l.region_id) },
      );
    }

    const warnings = [];
    // N-4 (vòng 4): id trong `only_region_ids` không khớp vùng nào ⇒ CẢNH BÁO (không im lặng).
    if (Array.isArray(unknownRegionIds) && unknownRegionIds.length > 0) {
      warnings.push(
        `⚠️ ${unknownRegionIds.length} id trong \`only_region_ids\` không khớp vùng nào của job (${unknownRegionIds.slice(0, 5).join(', ')}) — chỉ render các vùng khớp.`,
      );
    }
    let forcedReason = null;
    if (force === true) {
      forcedReason = pending.length > 0
        ? `⚠️ Người dùng buộc render (force = true) dù còn ${pending.length} dòng bị guardrail chặn (NEEDS_REVIEW) chưa duyệt: ${pending.map((l) => l.region_id).slice(0, 10).join(', ')}. Các dòng bị guardrail chặn nên KHÔNG được vẽ — chữ đó sẽ KHÔNG xuất hiện trên ảnh.`
        : 'Người dùng gọi render với force = true (không có dòng NEEDS_REVIEW nào bị ảnh hưởng).';
      warnings.push(forcedReason);
    }

    // ── Dựng RenderOp ─────────────────────────────────────────────────────
    const persistedRegions = await this.store.listOcrRegions(jobId);
    const regionById = new Map(persistedRegions.map((r) => [String(r.id), r]));
    const ops = [];
    const skipped = [];
    const overrides = [];

    // F-01 lớp 1 (sau phản biện) — hộp của MỌI vùng được bảo vệ, BẤT KỂ trạng thái dòng.
    // Op của vùng khác không được phép giao với bất kỳ hộp nào trong số này: thà giữ lại
    // chữ Trung còn hơn xoá mất nhãn hiệu/chứng nhận (fail-closed).
    //
    // Vùng được coi là bảo vệ khi hội đủ MỘT trong hai dấu hiệu ĐỘC LẬP:
    //   (1) `kind ∈ {brand, certification, price}` — nguồn luật #3; hoặc
    //   (2) dòng dịch có `status ∈ {SKIPPED_BRAND, SKIPPED_CERTIFICATION, SKIPPED_PRICE}`
    //       — dấu hiệu thứ hai của C2, cứu được ca provider OCR trả vùng THIẾU `kind`
    //       (khi đó mọi vùng thành `unknown`, chỉ còn `status` là đáng tin).
    const lineByRegion = new Map();
    for (const line of allLines) lineByRegion.set(String(line?.region_id ?? ''), line);
    const protectedBoxes = [];
    const unusableProtected = []; // vùng bảo vệ có toạ độ KHÔNG dùng được (N-1)
    for (const region of persistedRegions) {
      const rid = String(region?.id ?? '');
      const kind = String(region?.kind ?? '');
      const status = String(lineByRegion.get(rid)?.status ?? '');
      const protectedByKind = NEVER_RENDER_KINDS.includes(kind);
      const protectedByStatus = status === 'SKIPPED_BRAND' || status === 'SKIPPED_CERTIFICATION' || status === 'SKIPPED_PRICE';
      if (!protectedByKind && !protectedByStatus) continue;
      const pbox = this.#boxOf(region, original);
      if (pbox) protectedBoxes.push({ region_id: rid, kind, box: pbox });
      else unusableProtected.push({ region_id: rid, kind });
    }
    // N-1 (vòng 4): KHÔNG biết hộp bảo vệ nằm ở đâu thì mọi op đều CÓ THỂ chồng lên nó ⇒
    // fail-closed: không dựng op nào. Nếu vì thế mà không còn op ⇒ `IMAGELAB_NO_LINES`
    // (job failed, KHÔNG lưu ảnh) — thà không render còn hơn xoá mất nhãn hiệu.
    const unusableReason = unusableProtected.length
      ? `BOX_OVERLAPS_PROTECTED: ${unusableProtected[0].region_id} (${unusableProtected[0].kind}, hộp không hợp lệ — fail-closed) — không xác định được vị trí vùng được bảo vệ nên KHÔNG xoá/vẽ bất kỳ vùng nào.`
      : null;
    if (unusableReason) warnings.push(unusableReason);

    for (const line of allLines) {
      const rid = String(line?.region_id ?? '');
      if (!rid) {
        skipped.push({ region_id: rid, reason: 'Dòng dịch thiếu region_id — không xác định được vùng.' });
        continue;
      }
      if (selected && !selected.has(rid)) {
        skipped.push({ region_id: rid, reason: 'Không nằm trong danh sách vùng được yêu cầu render (onlyRegionIds).' });
        continue;
      }
      if (!String(line.text_vi ?? '').trim()) {
        skipped.push({ region_id: rid, reason: STATUS_SKIP_REASON[line.status] || 'Chưa có bản dịch tiếng Việt (text_vi rỗng).' });
        continue;
      }
      if (!RENDERABLE_STATUSES.includes(line.status)) {
        skipped.push({ region_id: rid, reason: STATUS_SKIP_REASON[line.status] || `Trạng thái ${line.status} không được phép render.` });
        continue;
      }
      const region = regionById.get(rid) || null;
      if (!region) {
        skipped.push({ region_id: rid, reason: 'Không tìm thấy vùng OCR tương ứng trong DB.' });
        continue;
      }
      // Luật #3 (sửa theo F-02 của phản biện): vùng brand/certification/price CHỈ được
      // dựng op khi có OVERRIDE CÓ VẾT — người dùng đã thực sự sửa/duyệt dòng đó
      // (`edited_by_user = true` + `provenance = 'user'` + có chữ Việt). Mọi trường hợp
      // khác (kể cả `allow_brand_override` lúc PUT mà dòng KHÔNG có vết) vẫn bị bỏ qua.
      const kind = String(region.kind ?? '');
      const protectedKind = NEVER_RENDER_KINDS.includes(kind);
      const tracedOverride =
        line.edited_by_user === true &&
        String(line.provenance ?? '') === 'user' &&
        String(line.text_vi ?? '').trim() !== '';
      if (protectedKind && !tracedOverride) {
        skipped.push({ region_id: rid, reason: KIND_SKIP_REASON[kind] });
        continue;
      }
      // KHÔNG chặn thêm theo `translatable`: hợp đồng 4.4 chỉ cho phép dựng op khi
      // dòng có text_vi + status ∈ {TRANSLATED, GLOSSARY, USER_EDITED}, và chặn TUYỆT ĐỐI
      // với brand/certification/price khi không có override có vết (đã chặn ở trên).
      // Vùng `unknown` do người dùng tự sửa (USER_EDITED, có edited_by_user + provenance
      // 'user') là override CÓ VẾT nên được phép vẽ; nếu chặn ở đây thì UI sẽ hiện dòng
      // "đã duyệt" mà không bao giờ được render — đúng kiểu thất bại im lặng mà luật #4 cấm.
      const box = this.#boxOf(region, original);
      if (!box) {
        skipped.push({
          region_id: rid,
          reason:
            'BAD_BOX_COORDINATE: hộp bao thiếu hoặc toạ độ không hợp lệ (NULL, rỗng, NaN, Infinity, chuỗi không phải số) — KHÔNG vẽ để tránh tràn ra ngoài vùng.',
        });
        continue;
      }
      // N-1: có vùng bảo vệ với toạ độ hỏng ⇒ chặn MỌI op (không đoán vị trí hộp bảo vệ).
      if (unusableReason) {
        skipped.push({ region_id: rid, reason: unusableReason });
        continue;
      }
      // F-01 lớp 1: op KHÔNG được GIAO với hộp của vùng được bảo vệ KHÁC (chồng một phần,
      // lồng nhau, hay trùng hộp) — nếu giao thì KHÔNG dựng op và nói rõ chồng lên vùng nào.
      const clash = protectedBoxes.find((p) => p.region_id !== rid && boxesIntersect(box, p.box));
      if (clash) {
        const reason = `BOX_OVERLAPS_PROTECTED: ${clash.region_id} (${clash.kind}) — hộp của vùng “${rid}” giao với vùng được bảo vệ nên KHÔNG xoá/vẽ (luật #3); giữ nguyên chữ Trung trong vùng đó.`;
        skipped.push({ region_id: rid, reason });
        warnings.push(reason);
        continue;
      }
      ops.push({
        region_id: rid,
        box,
        action: 'erase_and_draw',
        text: String(line.text_vi).trim(),
        style: { align: 'center', padding: 2 },
      });

      if (protectedKind) {
        overrides.push({ region_id: rid, kind, edited_at: line.edited_at ?? null });
        warnings.push(
          `⚠️ Vùng ${KIND_LABEL_VI[kind] || kind} “${rid}” ĐÃ BỊ THAY CHỮ TRÊN ẢNH theo yêu cầu người dùng (override có vết: ${line.status}, provenance=user${
            line.edited_at ? `, lúc ${line.edited_at}` : ''
          }).`,
        );
      }
    }

    const failedResult = (code, message, extra = {}) => ({
      status: JOB_STATUS.FAILED,
      stage: 'failed',
      error_code: code,
      error_message: message,
      asset: null,
      render: null,
      ops,
      skipped,
      warnings: [...warnings, message],
      ...extra,
    });

    if (ops.length === 0) {
      // Không có gì đủ điều kiện vẽ: nói rõ lý do, KHÔNG tạo ảnh rỗng giả.
      // F-01: job chạy qua hàng đợi nên `skipped` không tới được UI — nhét lý do THẬT
      // vào error_message để người dùng biết vì sao (thường là "hộp giao vùng bảo vệ").
      const summary = skipped
        .slice(0, 3)
        .map((s) => `${s.region_id || '?'}: ${String(s.reason).slice(0, 120)}`)
        .join(' | ');
      throw new ImageLabError(
        'IMAGELAB_NO_LINES',
        `Không có dòng nào đủ điều kiện render (xem \`skipped\` để biết lý do).${summary ? ` Lý do: ${summary}` : ''}`,
        { skipped },
      );
    }

    if (!this.renderProvider || this.renderProvider.configured === false) {
      const err = new ImageLabError('NOT_CONFIGURED', 'Chưa cấu hình render provider — không tạo được ảnh.');
      await this.#failJob(jobId, err);
      return failedResult(err.code, err.message);
    }

    // ── Đọc ảnh gốc + băm để chứng minh ảnh gốc bất biến ──────────────────
    const buffer = await this.storage.read(original);
    const beforeHash = sha256(buffer);
    if (original.sha256 && beforeHash !== original.sha256) {
      const err = new ImageLabError('ASSET_HASH_MISMATCH', 'File ảnh gốc trên đĩa KHÔNG khớp sha256 trong DB — dừng render để không tạo ảnh từ dữ liệu sai.');
      await this.#failJob(jobId, err);
      return failedResult(err.code, err.message);
    }

    await this.#setJob(jobId, {
      status: JOB_STATUS.RUNNING,
      stage: 'rendering',
      error_code: null,
      error_message: null,
      finished_at: null,
    });

    let render;
    try {
      render = await this.renderProvider.render({
        image: { buffer, mime: original.mime || sniffImageMime(buffer) || '', width: original.width, height: original.height, sha256: beforeHash },
        ops,
        options: {
          fontScale: cfg.fontScale,
          maxOutputBytes: cfg.maxOutputBytes,
          force: force === true,
          jobId,
          // F-01 lớp 2 (hàng rào cuối ở tầng pixel): provider THẬT không được đổi bất kỳ
          // pixel nào trong hộp của vùng brand/certification/price, kể cả khi op phủ lên.
          // Kèm `region_id` để op của CHÍNH vùng đó (override có vết — F-02) vẫn vẽ được
          // lên vùng của nó, trong khi mọi vùng bảo vệ khác vẫn đóng băng pixel.
          protected_boxes: protectedBoxes.map((p) => ({ region_id: p.region_id, box: p.box })),
        },
      });
    } catch (err) {
      const wrapped = new ImageLabError(String(err?.code || 'RENDER_FAILED'), `Render thất bại: ${err?.message || err}`);
      log?.error('imagelab.render_failed', { error: err });
      await this.#failJob(jobId, wrapped);
      return failedResult(wrapped.code, wrapped.message);
    }

    // Ảnh gốc bất biến: provider không được sửa buffer đầu vào tại chỗ.
    if (sha256(buffer) !== beforeHash) {
      const err = new ImageLabError('ORIGINAL_MUTATED', 'Buffer ảnh gốc bị sửa tại chỗ bởi render provider — vi phạm luật "ảnh gốc bất biến". Ảnh render KHÔNG được lưu.');
      await this.#failJob(jobId, err);
      throw err;
    }
    if (render?.original_sha256 && render.original_sha256 !== beforeHash) {
      const err = new ImageLabError('ORIGINAL_MUTATED', 'Render provider báo sha256 ảnh gốc khác file trên đĩa — dừng để bảo toàn ảnh gốc.');
      await this.#failJob(jobId, err);
      throw err;
    }

    const renderStatus = String(render?.status || 'FAILED');
    if (renderStatus !== 'OK' && renderStatus !== 'PARTIAL') {
      const code = String(render?.error_code || (renderStatus === 'NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'RENDER_FAILED'));
      const message = String(render?.error_message || `Render không thành công (status = ${renderStatus}).`).slice(0, 500);
      await this.#failJob(jobId, { code, message });
      // N-5: giữ lại CHÍNH warnings/skipped của provider vào content_meta để UI/lịch sử
      // đọc được lý do thật (với `PROTECTED_PIXELS_CHANGED` thì câu giải thích nằm ở đây).
      await this.#setJob(jobId, {
        content_meta: {
          ...(job.content_meta || {}),
          imagelab: {
            ...(job.content_meta?.imagelab || {}),
            render: {
              provider: String(render?.provider || ''),
              model: String(render?.model || ''),
              is_mock: Boolean(render?.is_mock),
              status: renderStatus,
              applied: 0,
              skipped: Array.isArray(render?.skipped) ? render.skipped.length : 0,
              error_code: code,
              protected_pixels_verified: render?.protected_pixels_verified ?? null,
              warnings: Array.isArray(render?.warnings) ? render.warnings.map(String).slice(0, 50) : [],
            },
            warnings: Array.isArray(render?.warnings) ? render.warnings.map(String).slice(0, 50) : [],
            updated_at: new Date().toISOString(),
          },
        },
      }).catch(() => {});
      return failedResult(code, message, { render });
    }

    const out = render?.output || null;
    if (!out || !out.buffer) {
      const err = new ImageLabError('RENDER_OUTPUT_INVALID', 'Render provider báo thành công nhưng không trả về ảnh (output rỗng).');
      await this.#failJob(jobId, err);
      return failedResult(err.code, err.message, { render });
    }
    const outBuffer = Buffer.isBuffer(out.buffer) ? out.buffer : Buffer.from(out.buffer);
    if (outBuffer.length === 0) {
      const err = new ImageLabError('RENDER_OUTPUT_INVALID', 'Ảnh render rỗng (0 byte).');
      await this.#failJob(jobId, err);
      return failedResult(err.code, err.message, { render });
    }

    const maxOut = Number(cfg.maxOutputBytes) > 0 ? Number(cfg.maxOutputBytes) : 0;
    if (maxOut > 0 && outBuffer.length > maxOut) {
      const err = new ImageLabError('OUTPUT_TOO_LARGE', `Ảnh render ${outBuffer.length} byte vượt giới hạn ${maxOut} byte.`);
      await this.#failJob(jobId, err);
      return failedResult(err.code, err.message, { render });
    }

    // Mime của ảnh render: ưu tiên magic bytes; provider khai lệch thì ghi cảnh báo.
    const declaredOutMime = ALLOWED_IMAGE_MIME.includes(String(out.mime || '').toLowerCase())
      ? String(out.mime).toLowerCase()
      : null;
    const sniffedOutMime = sniffImageMime(outBuffer);
    const outMime = sniffedOutMime || declaredOutMime;
    if (!outMime) {
      const err = new ImageLabError('RENDER_OUTPUT_INVALID', 'Ảnh render không nhận dạng được định dạng (magic bytes lạ).');
      await this.#failJob(jobId, err);
      return failedResult(err.code, err.message, { render });
    }
    const extraWarnings = [];
    if (!sniffedOutMime) {
      extraWarnings.push(`Ảnh render không nhận dạng được magic bytes — tạm tin mime provider khai (${outMime}).`);
    }

    // ── Lưu ảnh render: BẢN GHI MỚI, parent_id trỏ về ảnh gốc ─────────────
    const providerSkipped = Array.isArray(render?.skipped) ? render.skipped : [];
    const providerWarnings = Array.isArray(render?.warnings) ? render.warnings.map(String).slice(0, 50) : [];
    // F-02: op của vùng nhãn hiệu/chứng nhận/giá (override có vết) phải mang cờ `override`
    // trong `applied` để C5/UI nhìn là biết vùng đó bị thay theo yêu cầu người dùng.
    const overrideIds = new Set(overrides.map((o) => String(o.region_id)));
    const applied = (Array.isArray(render?.applied) ? render.applied : []).map((a) =>
      overrideIds.has(String(a?.region_id)) ? { ...a, override: true } : a,
    );
    const mergedSkipped = [...skipped, ...providerSkipped];
    // H-2 (vòng 3): provider báo đã chạy xong mà KHÔNG vẽ được vùng nào ⇒ job vẫn có thể
    // `succeeded` (ảnh là bản ghi mới, hợp lệ) nhưng TUYỆT ĐỐI không được im lặng: thêm
    // cảnh báo nổi bật + giữ `error_code` của engine (NO_OPS) trong meta để UI nói thật.
    if (applied.length === 0) {
      warnings.push(
        `⚠️ Không vùng nào được vẽ (0/${ops.length} op áp dụng được) — ảnh kết quả y hệt ảnh gốc. Xem danh sách "vùng không được vẽ" để biết lý do.`,
      );
    }
    const mergedWarnings = [...warnings, ...providerWarnings, ...extraWarnings];
    const providerName = String(render?.provider || this.renderProvider.name || '');
    const providerModel = String(render?.model || this.renderProvider.model || '');
    const isMock = Boolean(render?.is_mock ?? this.renderProvider.isMock);

    const renderedId = randomUUID();
    const ext = MIME_EXT[outMime] || 'bin';
    const meta = {
      // `status` để C5 đọc thẳng `render_summary.status` từ meta ảnh đã render.
      status: renderStatus,
      // H-2: mã lỗi của engine (vd `NO_OPS` khi không vẽ được vùng nào) — không im lặng.
      error_code: render?.error_code ?? null,
      // N-5: `true` = đã đo pixel vùng bảo vệ trên ảnh trả về; `false` = KHÔNG kiểm được
      // (định dạng khác PNG); `null` = không có hộp bảo vệ nào để kiểm.
      protected_pixels_verified: render?.protected_pixels_verified ?? null,
      applied,
      applied_count: applied.length,
      skipped: mergedSkipped,
      // F-02: vết của mọi override nhãn hiệu/chứng nhận/giá đã dùng cho ảnh này.
      overrides,
      unsupported_glyphs: Array.isArray(render?.unsupported_glyphs) ? render.unsupported_glyphs : [],
      warnings: mergedWarnings,
      provider: providerName,
      model: providerModel,
      is_mock: isMock,
      original_sha256: beforeHash,
      ops_count: ops.length,
      forced: forcedReason,
      elapsed_ms: Number.isFinite(Number(render?.elapsed_ms)) ? Number(render.elapsed_ms) : Date.now() - started,
      rendered_at: new Date().toISOString(),
    };

    let saved;
    try {
      saved = await this.storage.save({ jobId, assetId: renderedId, ext, buffer: outBuffer });
    } catch (err) {
      await this.#failJob(jobId, err);
      throw err;
    }

    try {
      await this.store.createImageAsset({
        id: renderedId,
        jobId,
        sessionId: sid,
        role: 'rendered',
        parentId: original.id,
        mime: outMime,
        bytes: saved.bytes,
        width: Number.isFinite(Number(out.width)) ? Number(out.width) : null,
        height: Number.isFinite(Number(out.height)) ? Number(out.height) : null,
        sha256: saved.sha256,
        storagePath: saved.storage_path,
        source: 'render',
        meta,
      });
    } catch (err) {
      await this.storage.remove({ storage_path: saved.storage_path }).catch(() => {});
      await this.#failJob(jobId, err);
      throw err;
    }

    const renderedAsset = await this.store.getImageAsset(renderedId);

    // ── Bằng chứng + trạng thái job + usage ───────────────────────────────
    const prevMeta = job.content_meta?.imagelab || {};
    const mockSteps = Array.from(new Set([...(Array.isArray(prevMeta.mock_steps) ? prevMeta.mock_steps : []), ...(isMock ? ['render'] : [])]));
    const blockedReason = mockSteps.length > 0
      ? `Có bước chạy provider MOCK (${mockSteps.join(', ')}) — kết quả là dữ liệu minh hoạ, KHÔNG phải kết quả thật.`
      : '';

    await this.#usage(jobId, sid, 'IMAGE_RENDER', {
      provider: providerName,
      model: providerModel,
      inputUnits: ops.length,
      outputUnits: applied.length,
      estimatedCost: this.config?.cost?.IMAGE_RENDER ?? 0,
      meta: {
        is_mock: isMock,
        status: renderStatus,
        ms: Date.now() - started,
        skipped: mergedSkipped.length,
        unsupported_glyphs: meta.unsupported_glyphs.length,
        forced: Boolean(forcedReason),
      },
    });

    await this.#setJob(jobId, {
      status: JOB_STATUS.SUCCEEDED,
      stage: 'done',
      finished_at: new Date().toISOString(),
      // N-2 (vòng 4): job phải PHẢN ÁNH sự thật — không vẽ được vùng nào thì `error_code`
      // của job KHÔNG được để `null` (client chỉ đọc `job.status`/`error_code` sẽ tưởng
      // đã render xong). Ảnh mới vẫn được lưu (bản ghi hợp lệ, y hệt ảnh gốc) nên
      // `status` giữ `succeeded`; nếu KHÔNG lưu được ảnh thì đường lỗi phía trên đã `failed`.
      error_code: applied.length === 0 ? RENDER_NO_OPS : null,
      error_message: applied.length === 0
        ? 'Render chạy xong nhưng KHÔNG vẽ được vùng nào (0 op áp dụng được) — ảnh kết quả y hệt ảnh gốc; xem `render_summary.skipped` để biết lý do.'
        : null,
      content_meta: {
        ...(job.content_meta || {}),
        imagelab: {
          ...prevMeta,
          mock_steps: mockSteps,
          render: {
            provider: providerName,
            model: providerModel,
            is_mock: isMock,
            status: renderStatus,
            applied: applied.length,
            skipped: mergedSkipped.length,
            unsupported_glyphs: meta.unsupported_glyphs.length,
            forced: Boolean(forcedReason),
            overrides: overrides.length,
            rendered_asset_id: renderedId,
          },
          warnings: mergedWarnings,
          updated_at: new Date().toISOString(),
        },
      },
    });

    await this.#evidence(jobId, {
      bytes: saved.bytes,
      foundFields: ['image_asset:original', 'image_asset:rendered', `render_ops:${ops.length}`],
      missingFields: [],
      blockedReason,
      ocrProvider: prevMeta.ocr?.provider || '',
      contentProvider: providerName,
    });

    log?.info('imagelab.render_done', {
      rendered_asset_id: renderedId,
      ops: ops.length,
      applied: applied.length,
      skipped: mergedSkipped.length,
      unsupported_glyphs: meta.unsupported_glyphs.length,
      forced: Boolean(forcedReason),
      ms: Date.now() - started,
    });

    return {
      status: JOB_STATUS.SUCCEEDED,
      stage: 'done',
      asset: renderedAsset,
      render,
      ops,
      skipped: mergedSkipped,
      warnings: mergedWarnings,
      overrides,
      mock_steps: mockSteps,
    };
  }
}

export default ImageTranslationPipeline;
