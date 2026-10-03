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
 */

import { createHash, randomUUID } from 'node:crypto';
import { JOB_STATUS, VERIFICATION_LEVELS } from '../store/index.js';
import { sniffImageMime } from '../security/sanitize.js';

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

/** Mức bằng chứng DUY NHẤT được phép: ảnh do người dùng tải lên. */
export const IMAGELAB_VERIFICATION = 'MANUAL_INPUT';

/** Chỉ những dòng này mới được dựng RenderOp (hợp đồng 4.4). */
export const RENDERABLE_STATUSES = Object.freeze(['TRANSLATED', 'GLOSSARY', 'USER_EDITED']);

/**
 * Dòng CHƯA được người duyệt xử lý → còn chặn render (hợp đồng 4.4).
 *
 * Đây là NGUỒN LUẬT DUY NHẤT cho câu hỏi "còn dòng nào phải duyệt không":
 * `renderApproved()` (C4) và route `POST /api/imagelab/jobs/:id/render` (C5) đều
 * gọi hàm này. Trước đây C5 tự chép lại luật (`status === 'NEEDS_REVIEW'`) nên
 * hai bản lệch nhau ở ca dòng đã được người dùng xử lý (`edited_by_user = true`,
 * ví dụ action `skip`) — route chặn 409 trong khi pipeline cho qua.
 */
export function pendingReviewLines(lines) {
  return (Array.isArray(lines) ? lines : []).filter(
    (l) => String(l?.status ?? '') === 'NEEDS_REVIEW' && l?.edited_by_user !== true,
  );
}

/** Ba loại vùng KHÔNG BAO GIỜ được dịch/xoá (luật #3). */
export const NEVER_RENDER_KINDS = Object.freeze(['brand', 'certification', 'price']);

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
  NEEDS_REVIEW: 'Dòng cần người duyệt nhưng CHƯA được duyệt — bỏ qua, không vẽ.',
  FAILED: 'Provider dịch lỗi cho riêng dòng này — bỏ qua.',
});

const KIND_SKIP_REASON = Object.freeze({
  brand: 'Vùng nhãn hiệu — tuyệt đối không xoá/vẽ đè (luật #3), kể cả khi dòng dịch có nội dung.',
  certification: 'Vùng chứng nhận — tuyệt đối không xoá/vẽ đè (luật #3).',
  price: 'Vùng giá — tuyệt đối không xoá/vẽ đè (luật #3).',
});

const NEVER_LIVE = Object.freeze(new Set(['LIVE_VERIFIED', 'AUTHENTICATED_LIVE_VERIFIED']));

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

/** Cắt hộp bao vào biên ảnh — không bao giờ để RenderOp tràn ra ngoài ảnh. */
function clampBox(box, width, height) {
  let { x, y, w, h } = box;
  if (Number.isFinite(width) && width > 0) {
    x = Math.min(Math.max(x, 0), width - 1);
    w = Math.min(w, width - x);
  }
  if (Number.isFinite(height) && height > 0) {
    y = Math.min(Math.max(y, 0), height - 1);
    h = Math.min(h, height - y);
  }
  if (!(w > 0) || !(h > 0)) return null;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
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
   */
  async #evidence(jobId, { bytes = 0, foundFields = [], missingFields = [], blockedReason = '', ocrProvider = '', contentProvider = '' } = {}) {
    try {
      await this.store.recordEvidence({
        jobId,
        connector: IMAGELAB_CONNECTOR,
        extractionMethod: IMAGELAB_EXTRACTION_METHOD,
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

  /** Hộp bao pixel của vùng trên ảnh gốc; suy từ `box_normalized` nếu thiếu `box`. */
  #boxOf(region, asset) {
    const width = Number(asset?.width);
    const height = Number(asset?.height);
    const b = region?.box;
    if (b && [b.x, b.y, b.w, b.h].every((v) => Number.isFinite(Number(v))) && Number(b.w) > 0 && Number(b.h) > 0) {
      return clampBox(
        { x: Number(b.x), y: Number(b.y), w: Number(b.w), h: Number(b.h) },
        width,
        height,
      );
    }
    const n = region?.box_normalized;
    if (
      n && Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 &&
      Number(n.w) > 0 && Number(n.h) > 0
    ) {
      return clampBox(
        {
          x: Number(n.x || 0) * width,
          y: Number(n.y || 0) * height,
          w: Number(n.w) * width,
          h: Number(n.h) * height,
        },
        width,
        height,
      );
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
    // Ảnh đã lưu xong, chờ worker OCR — stage 'queued' để UI biết đang chờ.
    await this.#setJob(jobId, { status: JOB_STATUS.QUEUED, stage: 'queued' });

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

  /* ═══════════════════════════ 3. RENDER APPROVED ═══════════════════════ */

  /**
   * Dựng RenderOp từ các dòng ĐÃ DUYỆT rồi render ra ảnh mới (role `rendered`,
   * `parent_id` = ảnh gốc). Ảnh gốc chỉ được đọc.
   */
  async renderApproved(jobId, { sessionId, onlyRegionIds, force = false } = {}) {
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
    let forcedReason = null;
    if (force === true) {
      forcedReason = pending.length > 0
        ? `Người dùng buộc render (force = true) dù còn ${pending.length} dòng NEEDS_REVIEW chưa duyệt: ${pending.map((l) => l.region_id).slice(0, 10).join(', ')}. Các dòng này KHÔNG được vẽ.`
        : 'Người dùng gọi render với force = true (không có dòng NEEDS_REVIEW nào bị ảnh hưởng).';
      warnings.push(forcedReason);
    }

    // ── Dựng RenderOp ─────────────────────────────────────────────────────
    const persistedRegions = await this.store.listOcrRegions(jobId);
    const regionById = new Map(persistedRegions.map((r) => [String(r.id), r]));
    const ops = [];
    const skipped = [];

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
      if (NEVER_RENDER_KINDS.includes(region.kind)) {
        skipped.push({ region_id: rid, reason: KIND_SKIP_REASON[region.kind] });
        continue;
      }
      // KHÔNG chặn thêm theo `translatable`: hợp đồng 4.4 chỉ cho phép dựng op khi
      // dòng có text_vi + status ∈ {TRANSLATED, GLOSSARY, USER_EDITED}, và CẤM TUYỆT ĐỐI
      // với brand/certification/price (đã chặn ở trên). Vùng `unknown` do người dùng
      // tự sửa (USER_EDITED, có edited_by_user + provenance 'user') là override CÓ VẾT
      // nên được phép vẽ; nếu chặn ở đây thì UI sẽ hiện dòng "đã duyệt" mà không bao giờ
      // được render — đúng kiểu thất bại im lặng mà luật #4 cấm.
      const box = this.#boxOf(region, original);
      if (!box) {
        skipped.push({ region_id: rid, reason: 'Hộp bao không hợp lệ (BAD_BOX) — không vẽ để tránh tràn ra ngoài vùng.' });
        continue;
      }
      ops.push({
        region_id: rid,
        box,
        action: 'erase_and_draw',
        text: String(line.text_vi).trim(),
        style: { align: 'center', padding: 2 },
      });
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
      throw new ImageLabError('IMAGELAB_NO_LINES', 'Không có dòng nào đủ điều kiện render (xem `skipped` để biết lý do).', { skipped });
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
    const applied = Array.isArray(render?.applied) ? render.applied : [];
    const mergedSkipped = [...skipped, ...providerSkipped];
    const mergedWarnings = [...warnings, ...providerWarnings, ...extraWarnings];
    const providerName = String(render?.provider || this.renderProvider.name || '');
    const providerModel = String(render?.model || this.renderProvider.model || '');
    const isMock = Boolean(render?.is_mock ?? this.renderProvider.isMock);

    const renderedId = randomUUID();
    const ext = MIME_EXT[outMime] || 'bin';
    const meta = {
      // `status` để C5 đọc thẳng `render_summary.status` từ meta ảnh đã render.
      status: renderStatus,
      applied,
      applied_count: applied.length,
      skipped: mergedSkipped,
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
      error_code: null,
      error_message: null,
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
      mock_steps: mockSteps,
    };
  }
}

export default ImageTranslationPipeline;
