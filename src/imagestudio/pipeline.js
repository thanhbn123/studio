/**
 * MVP-03 — E3: PIPELINE TẠO ẢNH (Image Generation / Retouching).
 *
 *   ảnh người dùng → ingest (lưu ảnh gốc BẤT BIẾN)
 *                  → generate: matting → composing → retouching → overlay → lưu ảnh MỚI
 *
 * Ba luật riêng của MVP-03 (hợp đồng §0) chi phối file này:
 *  1. KHÔNG BÓP MÉO SẢN PHẨM: ảnh ra cùng kích thước ảnh gốc, retouch bị KẸP ngưỡng và
 *     tham số hiệu lực được ghi lại; ảnh gốc trên đĩa được băm LẠI cuối mỗi lượt generate.
 *  2. NỀN MÔ PHỎNG PHẢI KHAI: `meta.synthetic_background` + `meta.template.synthetic`.
 *  3. FAIL-CLOSED, NÓI THẬT: thà `status = 'PARTIAL'` kèm cảnh báo còn hơn `succeeded` giả.
 *     Không đổi gì ⇒ `error_code = 'NO_CHANGES'` và KHÔNG lưu ảnh mới.
 *
 * Bốn nguyên tắc giống MVP-02 (xem `src/imagelab/pipeline.js`):
 *  - Mọi lỗi có `code` máy đọc được (`ImageStudioError`).
 *  - Job lỗi luôn có `error_code` + `finished_at`; KHÔNG BAO GIỜ treo `running`.
 *  - Usage chỉ ghi cho bước THẬT SỰ chạy (matting từ chối ⇒ KHÔNG ghi `IMAGE_MATTING`).
 *  - Evidence luôn `MANUAL_INPUT`; hàm `imagestudioVerification()` cố tình KHÔNG nhận tham
 *    số mức bằng chứng để không ai lỡ truyền `LIVE_VERIFIED` vào (luật #1 của dự án).
 *
 * Module anh em: matting/retouch được BƠM vào qua constructor (provider thật hoặc giả trong
 * test); compose là hàm THUẦN nên gọi trực tiếp (hợp đồng §3.2 — E2 không có provider).
 * `clampRetouchParams` được TÁI XUẤT đúng như hợp đồng §3.3 yêu cầu (một bản luật duy nhất
 * nằm ở `src/imagestudio/retouch/limits.js`, không chép lại).
 *
 * Hợp đồng dữ liệu cho E4/E5 (những gì file này ghi vào store):
 *  - `jobs.kind = 'image_generation'`, `jobs.status ∈ {queued, running, succeeded, 'PARTIAL', failed}`,
 *    `jobs.stage ∈ IMAGESTUDIO_STAGES`, kết thúc luôn có `finished_at`.
 *  - `jobs.content_meta.imagestudio` = { status, error_code, template, synthetic_background,
 *    retouch_effective, overlay:{applied,reason,violations}, failures:[{step,code,message}],
 *    warnings, rendered_asset_id, original_asset_id, original_sha256, output_sha256, providers }.
 *  - `image_assets` role `original` (bất biến) và role `rendered` (`parent_id` = asset gốc,
 *    `meta.kind = 'image_generation'`, `meta.template`, `meta.synthetic_background`,
 *    `meta.retouch_effective`, `meta.overlay`, `meta.warnings`).
 */

import { createHash, randomUUID } from 'node:crypto';
import { JOB_STATUS, VERIFICATION_LEVELS } from '../store/index.js';
import { sniffImageMime } from '../security/sanitize.js';
import { probeImage } from '../imagelab/render/image.js';
import { TEMPLATE_IDS, composeImage, drawOverlay, findTemplate } from './compose/index.js';
import { MATTING_MASK_EXTRA_FIELDS } from './matting/index.js';
import { RETOUCH_LIMITS, RETOUCH_PARAM_NAMES, clampRetouchParams, zeroRetouchParams } from './retouch/index.js';

/** Các bước của một job MVP-03 (hợp đồng §3.3 — ĐÓNG BĂNG, C5/E5 hiện tiến trình theo đây). */
export const IMAGESTUDIO_STAGES = Object.freeze([
  'queued',
  'storing',
  'matting',
  'composing',
  'retouching',
  'done',
  'failed',
]);

/** Loại job MVP-03 (`jobs.kind` đã có từ MVP-02, chỉ thêm giá trị — không cần migration). */
export const IMAGESTUDIO_KIND = 'image_generation';

/** Dấu vết: connector + cách trích xuất + mức bằng chứng (KHÔNG BAO GIỜ LIVE_VERIFIED). */
export const IMAGESTUDIO_CONNECTOR = 'imagestudio';
export const IMAGESTUDIO_EXTRACTION_METHOD = 'upload+generate';
export const IMAGESTUDIO_VERIFICATION = 'MANUAL_INPUT';

/**
 * Trạng thái job khi luồng chạy xong nhưng KHÔNG trọn vẹn (matting từ chối, overlay bị chặn,
 * hoặc không đổi gì). Viết HOA đúng như hợp đồng §3.3 ("status = 'PARTIAL'"); các trạng thái
 * còn lại dùng `JOB_STATUS` của store để không sinh thêm từ vựng.
 */
export const IMAGESTUDIO_PARTIAL = 'PARTIAL';

/** Mã lỗi MỨC JOB: chạy xong mà ảnh không đổi gì so với ảnh gốc (không được báo OK). */
export const IMAGESTUDIO_NO_CHANGES = 'NO_CHANGES';

/** Mẫu nền mặc định (hợp đồng §3.2). */
export const IMAGESTUDIO_DEFAULT_TEMPLATE = 'trang';

/** Những `stage` nghĩa là "một lượt generate đang chạy" — dùng cho cổng chống chạy chồng. */
export const IMAGESTUDIO_GENERATING_STAGES = Object.freeze(['storing', 'matting', 'composing', 'retouching']);

const MIME_EXT = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

const ALLOWED_IMAGE_MIME = Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const NEVER_LIVE = Object.freeze(new Set(['LIVE_VERIFIED', 'AUTHENTICATED_LIVE_VERIFIED']));

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Lỗi của tầng MVP-03 — LUÔN có `code` để E4 map sang HTTP mà không phải đoán chuỗi.
 * (Không tái dùng `ImageLabError` để hai hợp đồng MVP-02/MVP-03 không trộn vào nhau.)
 */
export class ImageStudioError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ImageStudioError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Cổng chặn cứng: MVP-03 không bao giờ được ghi LIVE_VERIFIED (luật #1 của dự án). */
function imagestudioVerification(level = IMAGESTUDIO_VERIFICATION) {
  if (!VERIFICATION_LEVELS.includes(level)) {
    throw new ImageStudioError('INVALID_VERIFICATION', `Mức bằng chứng không hợp lệ: ${JSON.stringify(String(level))}`);
  }
  if (NEVER_LIVE.has(level)) {
    throw new ImageStudioError('LIVE_VERIFICATION_FORBIDDEN', 'MVP-03 KHÔNG BAO GIỜ được ghi LIVE_VERIFIED (luật #1).');
  }
  return level;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Giải mã base64 nghiêm ngặt — `Buffer.from(x,'base64')` một mình sẽ bỏ qua rác. */
function decodeBase64Strict(raw, { label = 'image', maxBytes = 0 } = {}) {
  const clean = String(raw).replace(/\s+/g, '');
  if (!clean) throw new ImageStudioError('INVALID_IMAGE', `${label} rỗng — không có dữ liệu ảnh.`);
  if (maxBytes > 0 && clean.length > Math.ceil((maxBytes * 4) / 3) + 8) {
    throw new ImageStudioError('IMAGE_TOO_LARGE', `Ảnh vượt giới hạn ${maxBytes} byte (chặn trước khi giải mã).`);
  }
  if (!BASE64_RE.test(clean)) {
    throw new ImageStudioError('INVALID_IMAGE', `${label} không phải chuỗi base64 hợp lệ.`);
  }
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function decodeDataUrlOrBase64(raw, opts) {
  const value = String(raw).trim();
  const match = /^data:([a-z0-9.+/-]+);base64,(.*)$/is.exec(value);
  if (match) {
    if (!/^image\//i.test(match[1])) {
      throw new ImageStudioError('INVALID_IMAGE', `Data URL không phải ảnh: ${match[1]}`);
    }
    return decodeBase64Strict(match[2], opts);
  }
  return decodeBase64Strict(value, opts);
}

/**
 * Nhận Buffer | Uint8Array | base64 | data URL | `{ base64|data_url|buffer|mime|filename }`.
 * Cùng ngữ nghĩa với bộ giải mã của MVP-02 (không tin `mime` client khai — magic bytes mới quyết).
 */
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
        throw new ImageStudioError('INVALID_IMAGE', 'Thiếu dữ liệu ảnh (`image.base64`).');
      }
      buffer = decodeDataUrlOrBase64(raw, { maxBytes });
    }
  } else {
    throw new ImageStudioError('INVALID_IMAGE', 'Dữ liệu ảnh không hợp lệ — cần Buffer hoặc { base64 }.');
  }

  if (!buffer || buffer.length === 0) {
    throw new ImageStudioError('INVALID_IMAGE', 'Ảnh rỗng (0 byte).');
  }
  if (maxBytes > 0 && buffer.length > maxBytes) {
    throw new ImageStudioError('IMAGE_TOO_LARGE', `Ảnh ${buffer.length} byte vượt giới hạn ${maxBytes} byte.`);
  }
  return { buffer, declaredMime, filename };
}

/** Kích thước thật của buffer đầu ra — null nếu không đọc được header. */
function outputSize(buffer) {
  const probed = probeImage(buffer);
  if (!probed) return null;
  const width = Number(probed.width);
  const height = Number(probed.height);
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? { width: Math.trunc(width), height: Math.trunc(height), mime: probed.mime || null }
    : null;
}

/** Bản mô tả JSON-safe của `MattingResult` (KHÔNG chứa buffer pixel — response E4 là JSON). */
function summarizeMatting(result) {
  if (!result || typeof result !== 'object') return null;
  const output = result.output && typeof result.output === 'object' ? result.output : null;
  const mask = result.mask && typeof result.mask === 'object' ? result.mask : {};
  return {
    status: String(result.status ?? 'FAILED'),
    provider: String(result.provider ?? ''),
    model: String(result.model ?? ''),
    is_mock: Boolean(result.is_mock),
    output: output
      ? {
          mime: String(output.mime ?? ''),
          width: Number.isFinite(Number(output.width)) ? Number(output.width) : null,
          height: Number.isFinite(Number(output.height)) ? Number(output.height) : null,
          sha256: String(output.sha256 ?? ''),
          bytes: Buffer.isBuffer(output.buffer) ? output.buffer.length : null,
        }
      : null,
    // N3 (vòng 9): chuyển tiếp CẢ số đo MỞ RỘNG (trước đây bị bỏ ⇒ `GET matting.mask` chỉ có
    // 4 field đóng băng, còn `kept_bbox_ratio`/`boundary_delta` thì mất hút ở mọi đường API).
    mask: {
      coverage: mask.coverage ?? null,
      background_ratio: mask.background_ratio ?? null,
      uniformity: mask.uniformity ?? null,
      seed_colors: mask.seed_colors ?? null,
      ...Object.fromEntries(
        MATTING_MASK_EXTRA_FIELDS.filter((key) => mask[key] !== undefined && mask[key] !== null).map((key) => [key, mask[key]]),
      ),
    },
    // N1: cờ "người dùng đã bỏ qua cảnh báo biên nhập nhằng" — đọc được ở `asset.meta.matting`.
    ambiguous_override: mask.ambiguous_override === true,
    boundary_checked: mask.boundary_checked === true,
    kept_bbox: result.kept_bbox ?? null,
    warnings: Array.isArray(result.warnings) ? result.warnings.map(String).slice(0, 50) : [],
    elapsed_ms: Number.isFinite(Number(result.elapsed_ms)) ? Number(result.elapsed_ms) : 0,
    error_code: result.error_code ?? null,
    error_message: result.error_message ?? null,
  };
}

/** Bản mô tả JSON-safe của `ComposeResult`. */
function summarizeCompose(result, applied) {
  if (!result || typeof result !== 'object') return null;
  const output = result.output && typeof result.output === 'object' ? result.output : null;
  return {
    applied: Boolean(applied),
    template: result.template
      ? {
          id: String(result.template.id ?? ''),
          label: String(result.template.label ?? ''),
          synthetic: result.template.synthetic === true,
        }
      : null,
    background_ratio: Number.isFinite(Number(result.background_ratio)) ? Number(result.background_ratio) : 0,
    output: output
      ? {
          mime: String(output.mime ?? ''),
          width: Number.isFinite(Number(output.width)) ? Number(output.width) : null,
          height: Number.isFinite(Number(output.height)) ? Number(output.height) : null,
          sha256: String(output.sha256 ?? ''),
          bytes: Buffer.isBuffer(output.buffer) ? output.buffer.length : null,
        }
      : null,
    warnings: Array.isArray(result.warnings) ? result.warnings.map(String).slice(0, 50) : [],
    elapsed_ms: Number.isFinite(Number(result.elapsed_ms)) ? Number(result.elapsed_ms) : 0,
  };
}

/** Bản mô tả JSON-safe của `RetouchResult`. */
function summarizeRetouch(result, effectiveFallback) {
  if (!result || typeof result !== 'object') return null;
  const output = result.output && typeof result.output === 'object' ? result.output : null;
  return {
    status: String(result.status ?? 'FAILED'),
    params_effective: result.params_effective ?? effectiveFallback ?? null,
    clamped: Array.isArray(result.clamped) ? result.clamped.map(String) : [],
    rejected: Array.isArray(result.rejected) ? result.rejected.map(String) : [],
    output: output
      ? {
          mime: String(output.mime ?? ''),
          width: Number.isFinite(Number(output.width)) ? Number(output.width) : null,
          height: Number.isFinite(Number(output.height)) ? Number(output.height) : null,
          sha256: String(output.sha256 ?? ''),
          bytes: Buffer.isBuffer(output.buffer) ? output.buffer.length : null,
        }
      : null,
    warnings: Array.isArray(result.warnings) ? result.warnings.map(String).slice(0, 50) : [],
    elapsed_ms: Number.isFinite(Number(result.elapsed_ms)) ? Number(result.elapsed_ms) : 0,
    error_code: result.error_code ?? null,
  };
}

/** Rút text bằng chứng từ một giá trị bất kỳ (chuỗi / mảng dòng). */
function textFrom(candidate) {
  if (typeof candidate === 'string') return candidate.trim();
  if (Array.isArray(candidate)) {
    return candidate.filter((v) => typeof v === 'string' && v.trim() !== '').join('\n');
  }
  return '';
}

export class ImageGenerationPipeline {
  /**
   * `#inFlight` — khoá chống chạy chồng TRONG TIẾN TRÌNH cho `generate()`.
   * `jobs.status` trong DB chỉ là khoá giữa các tiến trình; hai lời gọi `generate()` liên
   * tiếp trên cùng một job có thể cùng đọc thấy `queued` (vì cả hai đều `await` ngay dòng
   * đầu), rồi cùng ghi hai ảnh rendered và cùng đặt trạng thái cuối — đó là đua thật.
   */
  #inFlight = new Set();

  /** Cảnh báo `billing.disabled` chỉ được ghi MỘT LẦN cho mỗi pipeline (không spam log). */
  #billingDisabledLogged = false;

  constructor({ config, logger, store, storage, mattingProvider = null, retouchProvider = null, billingService = null, billingHook = null } = {}) {
    this.config = config ?? {};
    this.logger = logger;
    this.store = store;
    this.storage = storage;
    this.mattingProvider = mattingProvider;
    this.retouchProvider = retouchProvider;
    // MVP-05: dịch vụ ví credit (A2) + hook dùng chung với route (§3.4b). Cả hai `null`
    // ⇒ hook tính tiền bỏ qua hoàn toàn.
    this.billingService = billingService || null;
    this.billingHook = billingHook || null;
  }

  /** Khối cấu hình dùng chung với MVP-02 (giới hạn ảnh). Thiếu khối → mặc định an toàn. */
  get imagelabConfig() {
    return this.config?.imagelab || {};
  }

  /** Ngưỡng retouch HIỆU LỰC: provider có thể SIẾT hơn hợp đồng, không bao giờ nới. */
  get retouchLimits() {
    const limits = this.retouchProvider?.retouchLimits;
    return limits && typeof limits === 'object' ? limits : RETOUCH_LIMITS;
  }

  /* ───────────────────────── tiện ích nội bộ ───────────────────────── */

  #log(jobId) {
    return this.logger?.child?.({ job_id: jobId }) ?? this.logger;
  }

  /** Ghi trạng thái job — lỗi ghi KHÔNG được làm sập tiến trình. */
  async #setJob(jobId, patch) {
    try {
      return await this.store.updateJob(jobId, patch);
    } catch (err) {
      this.logger?.error('imagestudio.job_update_failed', { job_id: jobId, error: err });
      return 0;
    }
  }

  /** Ghi usage_event — chỉ gọi cho bước THẬT SỰ chạy; lỗi ghi chỉ ghi log. */
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
      this.logger?.warn('imagestudio.usage_record_failed', { job_id: jobId, operation, error: err });
    }
  }

  /**
   * Ghi `extraction_evidence` cho job MVP-03. `verification` LUÔN `MANUAL_INPUT`
   * (ảnh do người dùng tải lên) — hàm không nhận tham số mức bằng chứng.
   */
  async #evidence(jobId, { bytes = 0, foundFields = [], missingFields = [], blockedReason = '', mattingProvider = '', retouchProvider = '' } = {}) {
    try {
      await this.store.recordEvidence({
        jobId,
        connector: IMAGESTUDIO_CONNECTOR,
        extractionMethod: IMAGESTUDIO_EXTRACTION_METHOD,
        verification: imagestudioVerification(),
        httpStatus: 200,
        bytes: Math.max(0, Math.trunc(Number(bytes) || 0)),
        loginRequired: false,
        blockedReason: String(blockedReason || '').slice(0, 1000),
        foundFields,
        missingFields,
        visionProvider: String(mattingProvider || ''),
        contentProvider: String(retouchProvider || ''),
      });
    } catch (err) {
      this.logger?.warn('imagestudio.evidence_record_failed', { job_id: jobId, error: err });
    }
  }

  /** Ghi thêm meta cho một ImageAsset — best-effort, lỗi chỉ ghi log. */
  async #updateAssetMeta(jobId, assetId, meta) {
    if (typeof this.store?.updateImageAssetMeta !== 'function') return 0;
    try {
      return await this.store.updateImageAssetMeta(assetId, meta);
    } catch (err) {
      this.logger?.warn('imagestudio.asset_meta_update_failed', { job_id: jobId, asset_id: assetId, error: err });
      return 0;
    }
  }

  /* ═════════════════ MVP-05 — HOOK TÍNH TIỀN (hợp đồng §3.4) ═════════════════
   *
   * LUẬT #1 — ẨN DANH KHÔNG BỊ PHÁ: job không có `user_id` đi thẳng vào thân `generate()`,
   * KHÔNG gọi một hàm billing nào (MVP-03 vẫn chạy y hệt cho khách chưa đăng nhập).
   *
   * LUẬT #2 — SỔ APPEND-ONLY: một lượt `generate()` của job có tài khoản là một chu kỳ
   * `app.billingHook.beforeJob` → `afterJob` (bên dưới là `holdForJob`/`settleForJob`/
   * `refundForJob` của A2), quyết toán theo usage THẬT và hoàn 100% khi job hỏng. Job đã có
   * chu kỳ khép lại thì không thu thêm lần nữa (idempotent theo `jobId`).
   *
   * FAIL-CLOSED Ở ĐÚNG MỘT CHỖ: thiếu credit khi giữ tiền ⇒ ném `INSUFFICIENT_CREDIT` để
   * KHÔNG chạy job (route map thành 402). Lỗi billing khác chỉ ghi log mức warn.
   */

  /** Ước tính các operation lượt chạy này sẽ dùng (cơ sở để giữ tiền trước). */
  #estimateOperations(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const ops = [];
    if (opts.remove_background !== false && opts.removeBackground !== false) ops.push('IMAGE_MATTING');
    ops.push('IMAGE_COMPOSE');
    if (opts.retouch || opts.retouch_params) ops.push('IMAGE_RETOUCH');
    return ops;
  }

  /** Ghi log lỗi billing ở mức warn — KHÔNG bao giờ làm hỏng job vì một sự cố ví tiền. */
  #warnHook(step, jobId, err) {
    this.logger?.warn('billing.hook_failed', {
      job_id: jobId,
      step,
      error_name: err?.name || 'Error',
      error_code: err?.code || null,
      error_message: String(err?.message || err).slice(0, 300),
    });
  }

  /** Chi phí THẬT của job = tổng `estimated_cost` của mọi `usage_events` (hợp đồng §3.4). */
  async #actualCost(jobId) {
    try {
      const summary = await this.store?.usageSummary?.(jobId);
      return Number(summary?.estimated_cost ?? 0);
    } catch (err) {
      this.#warnHook('usage_summary', jobId, err);
      return 0;
    }
  }

  /** Giữ tiền khi pipeline tự dựng với BillingService thô (test/demo) — không giữ hai lần. */
  async #holdDirect(billing, userId, jobId, operations) {
    if (typeof this.store?.listLedger === 'function') {
      const rows = await this.store.listLedger({ userId, jobId, limit: 200 });
      if (Array.isArray(rows) && rows.some((r) => r?.reason === 'job_hold')) return;
    }
    const estimate = await billing.estimate({ userId, operations });
    await billing.holdForJob({ userId, jobId, estimate, operations });
  }

  /** Kết thúc chu kỳ khi dùng BillingService thô — bỏ qua nếu job đã settle/refund. */
  async #closeDirect(billing, userId, jobId, { failed = false, actualCost = 0, reason = 'JOB_FAILED' } = {}) {
    let rows = [];
    if (typeof this.store?.listLedger === 'function') {
      rows = await this.store.listLedger({ userId, jobId, limit: 200 }) || [];
    }
    if (rows.some((r) => r?.reason === 'job_settle' || r?.reason === 'job_refund')) return;
    if (failed) {
      if (!rows.some((r) => r?.reason === 'job_hold')) return; // chưa giữ gì ⇒ không có gì để hoàn
      await billing.refundForJob({ userId, jobId, reason });
      return;
    }
    await billing.settleForJob({ userId, jobId, actualCost });
  }

  /**
   * Bọc một lượt `generate()` bằng chu kỳ: giữ tiền (nếu chưa giữ) → chạy → quyết toán/hoàn tiền.
   *
   * Nguồn ví ưu tiên `billingHook` — CHÍNH object A4 gọi trong request (§3.4b): A4 đã giữ
   * tiền cho `POST /api/imagestudio/jobs` và `POST .../generate`; hook tự ĐỌC SỔ THẬT theo
   * `jobId` nên lần gọi ở đây KHÔNG giữ thêm đồng nào. Nó là lưới an toàn cho đường không
   * qua route (demo/tool) và cho job xếp hàng trước khi hook ra đời.
   */
  async #withBilling(jobId, operations, run) {
    const hook = this.billingHook;
    const billing = this.billingService;
    if (!hook && !billing) {
      if (!this.#billingDisabledLogged) {
        this.#billingDisabledLogged = true;
        this.logger?.warn('billing.disabled', {
          reason: 'Không có billingService — hook tính tiền bị bỏ qua, job vẫn chạy và không ai bị chặn.',
        });
      }
      return run();
    }

    let job = null;
    try {
      job = await this.store?.getJob?.(jobId);
    } catch (err) {
      this.#warnHook('read_job', jobId, err);
      return run();
    }
    const userId = job?.user_id || null;
    if (!userId) return run(); // ẩn danh ⇒ bỏ qua HOÀN TOÀN (luật #1)

    try {
      if (hook) {
        await hook.beforeJob({
          userId,
          jobId,
          kind: job?.kind || 'image_generation',
          sessionId: job?.session_id || '',
          operations,
        });
      } else {
        await this.#holdDirect(billing, userId, jobId, operations);
      }
    } catch (err) {
      if (err?.code === 'INSUFFICIENT_CREDIT') throw err; // fail-closed có chủ ý (route map thành 402)
      this.#warnHook('before_job', jobId, err);
      return run();
    }

    let result;
    let failure = null;
    try {
      result = await run();
    } catch (err) {
      failure = err;
    }

    // Trạng thái THẬT lấy từ DB: `#failJob` đánh dấu failed mà KHÔNG ném lỗi.
    let status = failure ? JOB_STATUS.FAILED : (result?.status ?? null);
    if (!failure) {
      try {
        const fresh = await this.store?.getJob?.(jobId);
        status = fresh?.status ?? status;
      } catch {
        /* không đọc được trạng thái ⇒ dùng status pipeline trả về */
      }
    }
    const actualCost = await this.#actualCost(jobId);

    try {
      if (hook) {
        await hook.afterJob({ userId, jobId, status: status || JOB_STATUS.SUCCEEDED, actualCost });
      } else {
        await this.#closeDirect(billing, userId, jobId, {
          failed: status === JOB_STATUS.FAILED,
          actualCost,
          reason: 'IMAGESTUDIO_FAILED',
        });
      }
    } catch (err) {
      this.#warnHook('after_job', jobId, err);
    }

    if (failure) throw failure;
    return result;
  }

  /** Đánh dấu job thất bại kèm `error_code` + `finished_at` — không bao giờ treo `running`. */
  async #failJob(jobId, error) {
    const code = String(error?.code || 'IMAGESTUDIO_FAILED');
    const message = String(error?.message || 'Bước tạo ảnh thất bại.').replace(/\s+/g, ' ').slice(0, 500);
    await this.#setJob(jobId, {
      status: JOB_STATUS.FAILED,
      stage: 'failed',
      error_code: code,
      error_message: message,
      finished_at: new Date().toISOString(),
    });
    return { code, message };
  }

  /** Ảnh gốc (asset ĐẦU TIÊN role `original`) — mọi bước sau chỉ ĐỌC nó. */
  async #originalAsset(jobId) {
    const list = await this.store.listImageAssets(jobId, { role: 'original' });
    return Array.isArray(list) && list.length > 0 ? list[0] : null;
  }

  #allowedMime() {
    const configured = this.config?.net?.allowedImageMime;
    return Array.isArray(configured) && configured.length > 0 ? configured : ALLOWED_IMAGE_MIME;
  }

  /**
   * "Text gốc của job" để chống bịa overlay (hợp đồng §3.5) — CHỈ từ DỮ LIỆU ĐÃ LƯU:
   *   · `jobs.product_name` (tên sản phẩm của chính job);
   *   · vùng chữ trong DB (`store.listOcrRegions`) — gồm cả vùng do NGƯỜI DÙNG nhập tay
   *     của MVP-02 IL-08 (`source = 'user'`);
   *   · ghi chú người dùng ĐÃ LƯU trong `content_meta` của job.
   *
   * ⚠️ M03-02 (vòng 8): KHÔNG nhận `overlay.source_text|notes|evidence|ocr_text…` từ request
   * nữa — client vừa phát ngôn vừa tự cấp bằng chứng là lỗ "bằng chứng vòng" (§7.1).
   * Rỗng ⇒ KHÔNG có bằng chứng ⇒ guardrail chặn mọi khẳng định (fail-closed).
   */
  async #evidenceText(jobId, job) {
    const parts = [];
    /** N5 (vòng 9): NGUỒN của từng mẩu bằng chứng — để kết quả overlay truy vết được. */
    const sources = [];
    const usedRegions = [];

    const productName = String(job?.product_name ?? '').trim();
    if (productName) {
      parts.push(productName);
      sources.push('product_name');
    }

    let regions = [];
    try {
      regions = (await this.store.listOcrRegions(jobId)) || [];
    } catch (err) {
      this.logger?.warn('imagestudio.ocr_regions_read_failed', { job_id: jobId, error: err });
    }
    let sawOcr = false;
    let sawUser = false;
    for (const r of regions) {
      const text = String(r?.text ?? r?.text_original ?? '').trim();
      if (!text) continue;
      parts.push(text);
      const id = String(r?.region_key ?? r?.id ?? '');
      if (id) usedRegions.push(id);
      if (String(r?.source ?? '') === 'user') sawUser = true;
      else sawOcr = true;
    }
    if (sawOcr) sources.push('ocr_region');
    if (sawUser) sources.push('user_region');

    // Ghi chú người dùng ĐÃ LƯU trong job (không phải ghi chú client gửi kèm lượt này).
    const meta = job?.content_meta && typeof job.content_meta === 'object' ? job.content_meta : {};
    let sawNotes = false;
    for (const holder of [meta.imagestudio, meta.imagelab]) {
      if (!holder || typeof holder !== 'object') continue;
      for (const key of ['notes', 'note', 'user_note', 'source_text']) {
        const text = textFrom(holder[key]);
        if (text) {
          parts.push(text);
          sawNotes = true;
        }
      }
    }
    if (sawNotes) sources.push('job_notes');

    const text = parts.join('\n');
    return { text, evidence_used: { sources, region_ids: usedRegions.slice(0, 50), chars: text.length } };
  }

  /* ══════════════════════════════ 1. INGEST ══════════════════════════════ */

  /**
   * Nhận ảnh người dùng: sniff magic bytes, chặn theo `imagelab.maxImageBytes`/`maxPixels`,
   * dò kích thước bằng `probeImage`, lưu file rồi ghi `image_assets` role `original`.
   * Từ bước này trở đi ẢNH GỐC KHÔNG BAO GIỜ bị sửa (mọi lượt generate chỉ đọc + băm lại).
   *
   * @returns {Promise<{asset_id:string, asset:object, width:number, height:number, sha256:string,
   *                    mime:string, bytes:number, warnings:string[]}>}
   */
  async ingest(jobId, { image, sessionId, options = {} } = {}) {
    if (!jobId) throw new ImageStudioError('INVALID_INPUT', 'Thiếu jobId.');
    if (!this.store) throw new ImageStudioError('NOT_CONFIGURED', 'Thiếu store — không ghi được DB.');
    if (!this.storage) throw new ImageStudioError('NOT_CONFIGURED', 'Thiếu storage — không lưu được ảnh.');

    const cfg = this.imagelabConfig;
    const maxBytes = Number(cfg.maxImageBytes) > 0 ? Number(cfg.maxImageBytes) : 0;
    const maxPixels = Number(cfg.maxPixels) > 0 ? Number(cfg.maxPixels) : 0;
    const log = this.#log(jobId);
    const warnings = [];

    const job = await this.store.getJob(jobId);
    if (!job) throw new ImageStudioError('JOB_NOT_FOUND', `Không tìm thấy job ${jobId}.`);
    const sid = sessionId || job.session_id || '';

    // Một job = MỘT ảnh gốc bất biến. Tải ảnh thứ hai ⇒ từ chối (không ghi gì, không đánh
    // job failed: đây là lỗi tiền điều kiện của client, ảnh gốc cũ vẫn nguyên vẹn).
    const existing = await this.#originalAsset(jobId);
    if (existing) {
      throw new ImageStudioError(
        'ALREADY_INGESTED',
        `Job đã có ảnh gốc (asset ${existing.id}) — mỗi job chỉ có MỘT ảnh gốc bất biến. Hãy tạo job mới cho ảnh khác.`,
        { asset_id: existing.id },
      );
    }

    // 1. Giải mã + kiểm magic bytes (KHÔNG tin `mime` client khai).
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
      const err = new ImageStudioError(
        'UNSUPPORTED_IMAGE',
        `Không nhận dạng được ảnh (magic bytes) hoặc định dạng không được phép${declaredMime ? ` (client khai ${declaredMime})` : ''}. Chỉ nhận ${this.#allowedMime().join(', ')}.`,
      );
      await this.#failJob(jobId, err);
      throw err;
    }

    // 2. Dò kích thước THẬT: MVP-03 không thể làm gì nếu không biết khung ảnh.
    const size = outputSize(buffer);
    if (!size) {
      const err = new ImageStudioError('INVALID_IMAGE', 'Không đọc được kích thước ảnh từ header — ảnh hỏng hoặc header không hợp lệ.');
      await this.#failJob(jobId, err);
      throw err;
    }
    const { width, height } = size;
    if (maxPixels > 0 && width * height > maxPixels) {
      const err = new ImageStudioError('PIXELS_EXCEEDED', `Ảnh ${width}×${height} = ${width * height} pixel vượt giới hạn ${maxPixels} pixel.`);
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
    const meta = { kind: IMAGESTUDIO_KIND, role: 'original' };
    if (filename) meta.filename = filename;
    // Client khai mime khác magic bytes → ghi vết, không im lặng.
    if (declaredMime && declaredMime !== mime) meta.declared_mime = declaredMime;

    // Ghi file CÓ THỂ hỏng (đĩa đầy/quyền/assetId sai định dạng) ⇒ phải đánh dấu job failed,
    // nếu không job sẽ treo `running` mãi mãi (luật: không bao giờ treo).
    let saved;
    try {
      saved = await this.storage.save({ jobId, assetId, ext, buffer });
    } catch (err) {
      const wrapped = new ImageStudioError(String(err?.code || 'STORAGE_WRITE_FAILED'), `Không lưu được ảnh gốc: ${err?.message || err}`);
      await this.#failJob(jobId, wrapped);
      throw wrapped;
    }
    try {
      await this.store.createImageAsset({
        id: assetId,
        jobId,
        sessionId: sid,
        // MVP-05 §2.2: đã đăng nhập ⇒ mọi asset mới gắn `user_id`; ẩn danh ⇒ null.
        userId: job.user_id || null,
        role: 'original',
        parentId: null,
        mime,
        bytes: saved.bytes,
        width,
        height,
        sha256: saved.sha256,
        storagePath: saved.storage_path,
        source: 'upload',
        meta,
      });
    } catch (err) {
      // Ghi DB hỏng → dọn file vừa ghi để không để rác mồ côi.
      await this.storage.remove({ storage_path: saved.storage_path }).catch(() => {});
      await this.#failJob(jobId, err);
      throw err;
    }

    const asset = await this.store.getImageAsset(assetId);

    // 4. Job kind: đường tạo ảnh phải mang `image_generation`. Job do client tạo thiếu kind
    //    (mặc định 'content') ⇒ ĐẶT LẠI và ghi cảnh báo, không im lặng đổi dữ liệu.
    if (String(job.kind ?? '') !== IMAGESTUDIO_KIND) {
      warnings.push(`Job kind "${job.kind || 'content'}" ⇒ đặt lại thành "${IMAGESTUDIO_KIND}" cho luồng tạo ảnh.`);
      await this.#setJob(jobId, { kind: IMAGESTUDIO_KIND });
    }

    await this.#setJob(jobId, {
      status: JOB_STATUS.QUEUED,
      stage: 'queued',
      content_meta: {
        ...(job.content_meta || {}),
        imagestudio: {
          ...(job.content_meta?.imagestudio || {}),
          kind: IMAGESTUDIO_KIND,
          original_asset_id: assetId,
          mime,
          width,
          height,
          bytes: saved.bytes,
          sha256: saved.sha256,
          warnings,
          updated_at: new Date().toISOString(),
        },
      },
    });

    await this.#evidence(jobId, {
      bytes: saved.bytes,
      foundFields: ['image_asset:original', `kind:${IMAGESTUDIO_KIND}`],
      missingFields: ['image_asset:rendered'],
      mattingProvider: this.mattingProvider?.name || '',
      retouchProvider: this.retouchProvider?.name || '',
    });

    log?.info('imagestudio.ingest_done', { asset_id: assetId, mime, bytes: saved.bytes, width, height });
    return { asset_id: assetId, asset, width, height, sha256: saved.sha256, mime, bytes: saved.bytes, warnings };
  }

  /* ══════════════════════════════ 2. GENERATE ══════════════════════════════ */

  /**
   * Chạy đúng trình tự stage: `storing → matting → composing → retouching → done|failed`.
   *
   * Không bước nào được phép làm CHẾT job vì lý do "không đủ tự tin" (matting từ chối,
   * retouch không đổi gì, overlay bị guardrail chặn): job vẫn chạy tiếp trên ảnh gốc,
   * `status = 'PARTIAL'`, mọi lý do nằm trong `warnings` + `failures`.
   * Job CHỈ `failed` khi lỗi thuộc về hệ thống/đầu vào (không có ảnh gốc, ảnh gốc bị đổi
   * trên đĩa, ghi DB/đĩa hỏng, kích thước đầu ra lệch ảnh gốc).
   *
   * Hai lượt `generate()` chồng nhau trên cùng job ⇒ lượt sau bị chặn bằng
   * `IMAGESTUDIO_JOB_RUNNING` (khoá trong tiến trình + `jobs.status` trong DB);
   * `force = true` là đường thoát có ý thức, và ảnh cũ KHÔNG BAO GIỜ bị ghi đè.
   *
   * @returns {Promise<{status:string, asset:object|null, matting:object|null, compose:object|null,
   *                    retouch:object|null, overlay:object|null, warnings:string[], failures:Array,
   *                    error_code:string|null, original_asset:object, duration_ms:number}>}
   */
  async generate(jobId, { sessionId, options = {}, force = false } = {}) {
    if (!jobId) throw new ImageStudioError('INVALID_INPUT', 'Thiếu jobId.');
    // Khoá TRONG TIẾN TRÌNH (xem `#inFlight`) — `force = true` là đường thoát duy nhất.
    if (this.#inFlight.has(String(jobId)) && !force) {
      throw new ImageStudioError(
        'IMAGESTUDIO_JOB_RUNNING',
        `Job ${jobId} đang có một lượt tạo ảnh chạy trong tiến trình này — chờ lượt đó xong, hoặc gọi lại với force = true nếu thật sự muốn chạy chồng.`,
        { job_id: String(jobId), hint: 'force=true' },
      );
    }
    this.#inFlight.add(String(jobId));
    try {
      // MVP-05 §3.4: một lượt generate là một chu kỳ tính tiền (ẩn danh ⇒ bỏ qua hoàn toàn).
      return await this.#withBilling(jobId, this.#estimateOperations(options), () =>
        this.#generateLocked(jobId, { sessionId, options, force }));
    } finally {
      this.#inFlight.delete(String(jobId));
    }
  }

  /** Thân của `generate()` — chỉ gọi qua `generate()` để luôn đi kèm khoá chống chạy chồng. */
  async #generateLocked(jobId, { sessionId, options = {}, force = false } = {}) {
    const started = Date.now();
    if (!jobId) throw new ImageStudioError('INVALID_INPUT', 'Thiếu jobId.');
    if (!this.store) throw new ImageStudioError('NOT_CONFIGURED', 'Thiếu store — không ghi được DB.');
    if (!this.storage) throw new ImageStudioError('NOT_CONFIGURED', 'Thiếu storage — không đọc/ghi được ảnh.');

    const log = this.#log(jobId);
    const warnings = [];
    /** Mọi bước hỏng theo cách "không chết job" đều để lại vết ở đây (E4/E5 đọc được). */
    const failures = [];
    const opts = options && typeof options === 'object' ? options : {};

    const job = await this.store.getJob(jobId);
    if (!job) throw new ImageStudioError('JOB_NOT_FOUND', `Không tìm thấy job ${jobId}.`);
    const sid = sessionId || job.session_id || '';

    // ── Cổng chống chạy chồng (tiền điều kiện — KHÔNG đụng trạng thái job) ─────
    if (!force && job.status === JOB_STATUS.RUNNING && IMAGESTUDIO_GENERATING_STAGES.includes(String(job.stage))) {
      throw new ImageStudioError(
        'IMAGESTUDIO_JOB_RUNNING',
        `Job đang chạy bước "${job.stage}" (status = running) — chờ bước này xong, hoặc gọi lại với force = true nếu chắc chắn không có lượt chạy nào đang thực hiện.`,
        { status: job.status, stage: job.stage ?? null, hint: 'force=true' },
      );
    }

    // ── Tiền điều kiện: ảnh gốc + mẫu nền hợp lệ (không đụng trạng thái job) ───
    const original = await this.#originalAsset(jobId);
    if (!original) {
      const err = new ImageStudioError('IMAGESTUDIO_NO_ASSET', 'Job chưa có ảnh gốc — phải gọi ingest() trước khi generate().');
      await this.#failJob(jobId, err);
      throw err;
    }

    const templateRaw = opts.template ?? opts.template_id ?? IMAGESTUDIO_DEFAULT_TEMPLATE;
    const templateId = typeof templateRaw === 'object' && templateRaw !== null ? String(templateRaw.id ?? '') : String(templateRaw);
    const template = findTemplate(templateId);
    if (!template) {
      throw new ImageStudioError('TEMPLATE_NOT_FOUND', `Mẫu nền không tồn tại: ${JSON.stringify(String(templateRaw))}.`, {
        available: TEMPLATE_IDS,
      });
    }

    await this.#setJob(jobId, {
      status: JOB_STATUS.RUNNING,
      stage: 'storing',
      error_code: null,
      error_message: null,
      finished_at: null,
    });

    // ── Đọc ảnh gốc + chứng minh bất biến (băm TRƯỚC mọi thao tác) ────────────
    let originalBuffer;
    try {
      originalBuffer = await this.storage.read(original);
    } catch (err) {
      const wrapped = new ImageStudioError(String(err?.code || 'STORAGE_READ_FAILED'), `Không đọc được ảnh gốc: ${err?.message || err}`);
      await this.#failJob(jobId, wrapped);
      throw wrapped;
    }
    const originalSha = sha256(originalBuffer);
    if (original.sha256 && original.sha256 !== originalSha) {
      const err = new ImageStudioError(
        'ORIGINAL_HASH_MISMATCH',
        `Ảnh gốc trên đĩa KHÔNG khớp sha256 đã lưu (${originalSha.slice(0, 12)}… ≠ ${String(original.sha256).slice(0, 12)}…) — dừng để không tạo ảnh từ dữ liệu hỏng.`,
      );
      await this.#failJob(jobId, err);
      throw err;
    }
    const originalMime = original.mime || sniffImageMime(originalBuffer) || 'application/octet-stream';
    const originalWidth = Number(original.width) > 0 ? Number(original.width) : outputSize(originalBuffer)?.width ?? null;
    const originalHeight = Number(original.height) > 0 ? Number(original.height) : outputSize(originalBuffer)?.height ?? null;
    const pixels = originalWidth && originalHeight ? originalWidth * originalHeight : 0;

    if (originalMime !== 'image/png') {
      warnings.push(
        `Ảnh gốc không phải PNG (${originalMime}) — engine offline (tách nền/ghép/retouch/overlay) chỉ xử lý PNG, nên các bước có thể TỪ CHỐI.`,
      );
    }

    // Ảnh đang được xử lý (mỗi bước chỉ ĐƯỢC THAY bằng buffer MỚI, không sửa tại chỗ).
    let currentBuffer = originalBuffer;
    let currentMime = originalMime;

    const previousRendered = ((await this.store.listImageAssets(jobId, { role: 'rendered' })) || []).length;
    if (previousRendered > 0) {
      warnings.push(
        `Job đã có ${previousRendered} ảnh đã tạo trước đó — lượt này thêm một ảnh MỚI (chỉ ghi thêm, KHÔNG ghi đè ảnh cũ).`,
      );
    }

    /* ── (a) MATTING ──────────────────────────────────────────────────────── */
    await this.#setJob(jobId, { stage: 'matting' });
    const wantMatting = opts.remove_background !== false && opts.removeBackground !== false;
    let matting = null;
    if (!wantMatting) {
      // Bước KHÔNG chạy ⇒ KHÔNG ghi usage IMAGE_MATTING (không được bịa usage).
      warnings.push('Người dùng tắt tách nền (remove_background = false) — bỏ qua bước tách nền, giữ nguyên nền ảnh gốc.');
    } else if (!this.mattingProvider || typeof this.mattingProvider.removeBackground !== 'function') {
      const message = 'Chưa nạp module tách nền — bỏ qua matting, job chạy tiếp trên ảnh gốc.';
      warnings.push(message);
      failures.push({ step: 'matting', code: 'NOT_CONFIGURED', message });
    } else {
      try {
        const mattingOptions = opts.matting_options && typeof opts.matting_options === 'object' ? opts.matting_options : {};
        // N1: người dùng cho phép ghép nền dù biên nhập nhằng (mặc định KHÔNG).
        if (opts.matting_allow_ambiguous === true) mattingOptions.matting_allow_ambiguous = true;
        matting = await this.mattingProvider.removeBackground({
          image: { buffer: originalBuffer, mime: originalMime },
          options: mattingOptions,
        });
      } catch (err) {
        // Hợp đồng §3.1 nói provider KHÔNG ném ra ngoài — đây là lưới an toàn.
        const message = `Tách nền ném lỗi (${err?.code || 'MATTING_FAILED'}): ${err?.message || err}`;
        log?.error('imagestudio.matting_threw', { error: err });
        warnings.push(message);
        failures.push({ step: 'matting', code: String(err?.code || 'MATTING_FAILED'), message });
        matting = null;
      }
      if (Array.isArray(matting?.warnings) && matting.warnings.length > 0) {
        warnings.push(...matting.warnings.map(String).slice(0, 20));
      }
      if (matting?.status === 'OK' && matting.output?.buffer) {
        await this.#usage(jobId, sid, 'IMAGE_MATTING', {
          provider: matting.provider || this.mattingProvider.name || '',
          model: matting.model || this.mattingProvider.model || '',
          inputUnits: pixels,
          outputUnits: 1,
          estimatedCost: this.config?.cost?.IMAGE_MATTING ?? 0,
          meta: {
            is_mock: Boolean(matting.is_mock),
            status: matting.status,
            mask: matting.mask ?? null,
            kept_bbox: matting.kept_bbox ?? null,
            ms: matting.elapsed_ms ?? null,
          },
        });
      } else {
        const code = String(matting?.error_code || (matting?.status ? `MATTING_${matting.status}` : 'MATTING_FAILED'));
        const message = `Không tách được nền (${code}): ${matting?.error_message || 'provider không trả kết quả'}`;
        warnings.push(message, 'Vẫn chạy retouch trên ẢNH GỐC (không cắt bừa) — đúng luật fail-closed của MVP-03.');
        failures.push({ step: 'matting', code, message });
      }
    }

    const mattingOk = matting?.status === 'OK' && Boolean(matting.output?.buffer);

    /* ── (b) COMPOSING ────────────────────────────────────────────────────── */
    await this.#setJob(jobId, { stage: 'composing' });
    let composeResult = null;
    let composed = false;
    let syntheticBackground = false;
    try {
      composeResult = composeImage({
        image: { buffer: currentBuffer, mime: currentMime },
        // Đưa CẢ kết quả matting HỎNG vào: compose tự fail-closed (`readMask` trả null) và
        // câu cảnh báo của nó nói đúng `matting.status` thay vì "matting = null" chung chung.
        matting: matting ?? null,
        template: templateId,
        options: { template: templateId },
      });
    } catch (err) {
      const message = `Ghép nền lỗi (${err?.code || 'COMPOSE_FAILED'}): ${err?.message || err}`;
      log?.error('imagestudio.compose_failed', { error: err });
      warnings.push(message);
      failures.push({ step: 'compose', code: String(err?.code || 'COMPOSE_FAILED'), message });
    }

    if (composeResult) {
      warnings.push(...(Array.isArray(composeResult.warnings) ? composeResult.warnings.map(String).slice(0, 20) : []));
      composed = Number(composeResult.background_ratio) > 0 && Boolean(composeResult.output?.buffer);
      syntheticBackground = composed && composeResult.template?.synthetic === true;
      if (composed) {
        currentBuffer = composeResult.output.buffer;
        currentMime = composeResult.output.mime || 'image/png';
        await this.#usage(jobId, sid, 'IMAGE_COMPOSE', {
          provider: 'compose',
          model: templateId,
          inputUnits: pixels,
          outputUnits: 1,
          estimatedCost: this.config?.cost?.IMAGE_COMPOSE ?? 0,
          meta: {
            template: templateId,
            synthetic: composeResult.template?.synthetic === true,
            background_ratio: composeResult.background_ratio,
            matting_ok: mattingOk,
            ms: composeResult.elapsed_ms ?? null,
          },
        });
      } else if (mattingOk) {
        // Có mask mà không pixel nền nào được ghi ⇒ bất thường, phải nói ra.
        const message = 'Có mask nền nhưng KHÔNG pixel nền nào được ghép (background_ratio = 0) — ảnh giữ nguyên.';
        warnings.push(message);
        failures.push({ step: 'compose', code: 'COMPOSE_NO_BACKGROUND', message });
      }
      // Không có mask (matting từ chối) ⇒ compose trả BẢN SAO + NO_MASK_WARNING:
      // đúng như E2 mô tả, đã có failure của matting ở trên nên không thêm lỗi trùng.
    }

    /* ── (c) RETOUCHING ───────────────────────────────────────────────────── */
    await this.#setJob(jobId, { stage: 'retouching' });
    const rawRetouch = opts.retouch ?? opts.retouch_params ?? null;
    const retouchRequested = Boolean(rawRetouch) && typeof rawRetouch === 'object' && Object.keys(rawRetouch).length > 0;

    // Kẹp ngưỡng ở tầng PIPELINE (hợp đồng §3.3): lấy `clamped[]`/`rejected[]` để nói thật
    // với người dùng. Provider cũng kẹp (có thể SIẾT hơn) — hai lần kẹp không bao giờ nới.
    const clampResult = clampRetouchParams(retouchRequested ? rawRetouch : {}, this.retouchLimits);
    let retouchEffective = clampResult.params;
    const clampedNames = [...clampResult.clamped];
    const rejectedNames = [...clampResult.rejected];

    let retouch = null;
    let retouched = false;
    if (!retouchRequested) {
      // Bước KHÔNG chạy ⇒ KHÔNG ghi usage IMAGE_RETOUCH.
      warnings.push('Không có tham số retouch nào được yêu cầu — bỏ qua bước retouch, giữ nguyên tông màu ảnh.');
    } else {
      if (clampedNames.length > 0) {
        warnings.push(
          `Tham số vượt ngưỡng đã bị KẸP: ${clampedNames
            .map((name) => `${name}: ${JSON.stringify(rawRetouch?.[name])} ⇒ ${retouchEffective[name]} (ngưỡng ±${this.retouchLimits[name]})`)
            .join('; ')}.`,
        );
      }
      if (rejectedNames.length > 0) {
        warnings.push(`Tham số retouch không hợp lệ đã bị BỎ (coi như không truyền): ${rejectedNames.join(', ')}.`);
      }

      if (!this.retouchProvider || typeof this.retouchProvider.apply !== 'function') {
        const message = 'Chưa nạp module retouch — không retouch được (job vẫn chạy tiếp, KHÔNG ghi usage IMAGE_RETOUCH).';
        warnings.push(message);
        failures.push({ step: 'retouch', code: 'NOT_CONFIGURED', message });
      } else {
        try {
          retouch = await this.retouchProvider.apply({
            image: { buffer: currentBuffer, mime: currentMime },
            params: rawRetouch, // provider tự kẹp theo ngưỡng HIỆU LỰC của nó (đã siết nếu cấu hình siết)
          });
        } catch (err) {
          const message = `Retouch ném lỗi (${err?.code || 'RETOUCH_FAILED'}): ${err?.message || err}`;
          log?.error('imagestudio.retouch_threw', { error: err });
          warnings.push(message);
          failures.push({ step: 'retouch', code: String(err?.code || 'RETOUCH_FAILED'), message });
          retouch = null;
        }
      }

      if (retouch) {
        warnings.push(...(Array.isArray(retouch.warnings) ? retouch.warnings.map(String).slice(0, 20) : []));
        for (const name of Array.isArray(retouch.clamped) ? retouch.clamped : []) {
          if (!clampedNames.includes(name)) clampedNames.push(name);
        }
        for (const name of Array.isArray(retouch.rejected) ? retouch.rejected : []) {
          if (!rejectedNames.includes(name)) rejectedNames.push(name);
        }
        retouchEffective = retouch.params_effective ?? retouchEffective;

        if (retouch.status === 'OK' && retouch.output?.buffer) {
          currentBuffer = retouch.output.buffer;
          currentMime = retouch.output.mime || 'image/png';
          retouched = true;
          const appliedParams = RETOUCH_PARAM_NAMES.filter((name) => Number(retouchEffective?.[name]) !== 0);
          await this.#usage(jobId, sid, 'IMAGE_RETOUCH', {
            provider: this.retouchProvider.name || '',
            model: this.retouchProvider.model || '',
            inputUnits: pixels,
            outputUnits: appliedParams.length,
            estimatedCost: this.config?.cost?.IMAGE_RETOUCH ?? 0,
            meta: {
              status: retouch.status,
              params_effective: retouchEffective,
              applied_params: appliedParams,
              clamped: clampedNames,
              rejected: rejectedNames,
              ms: retouch.elapsed_ms ?? null,
            },
          });
        } else if (retouch.status === 'NO_CHANGES') {
          // M03-05 (vòng 8): KHÔNG pixel nào đổi ⇒ KHÔNG được ghi `retouch_effective` như thể
          // đã retouch (dấu vết nói sai — cùng lớp lỗi F-03/N-3 của MVP-02). Tham số bị KẸP
          // vẫn giữ nguyên trong `params_clamped`/`params_rejected` để không mất vết.
          retouchEffective = zeroRetouchParams();
          retouch = { ...retouch, params_effective: retouchEffective };
          warnings.push(
            'Retouch KHÔNG đổi gì (NO_CHANGES) — không tính là đã làm, không ghi usage IMAGE_RETOUCH, ' +
              'và `retouch_effective` để 0 (tham số bị kẹp vẫn nằm trong `retouch_clamped`).',
          );
        } else {
          const code = String(retouch.error_code || `RETOUCH_${retouch.status}`);
          const message = `Retouch không chạy được (${retouch.status}/${code}) — ảnh giữ nguyên bước trước đó.`;
          // Không áp được tham số nào ⇒ `retouch_effective` = 0 (không bịa là đã retouch).
          retouchEffective = zeroRetouchParams();
          retouch = { ...retouch, params_effective: retouchEffective };
          warnings.push(message);
          failures.push({ step: 'retouch', code, message });
        }
      }
    }

    /* ── (d) OVERLAY (chống bịa — hợp đồng §3.5) ──────────────────────────── */
    const overlayInput = opts.overlay && typeof opts.overlay === 'object' ? opts.overlay : null;
    let overlay = null;
    let overlayApplied = false;
    if (overlayInput && String(overlayInput.text ?? '').trim() !== '') {
      const evidence = await this.#evidenceText(jobId, job);
      const sourceText = evidence.text;
      // Nói THẲNG nếu client gửi kèm "bằng chứng" — nó bị bỏ qua, không được dùng để biện minh.
      const ignoredEvidence = Array.isArray(overlayInput?.client_evidence_ignored) ? overlayInput.client_evidence_ignored : [];
      if (ignoredEvidence.length > 0) {
        warnings.push(
          `BỎ QUA bằng chứng do client tự khai trong overlay (${ignoredEvidence.map(String).join(', ')}) — ` +
            'bằng chứng chỉ được lấy từ dữ liệu ĐÃ LƯU của job (tên sản phẩm, vùng chữ, ghi chú đã lưu).',
        );
      }
      let drawn = null;
      try {
        drawn = drawOverlay({
          image: { buffer: currentBuffer, mime: currentMime },
          overlay: overlayInput,
          source_text: sourceText,
          evidence_used: evidence.evidence_used,
        });
      } catch (err) {
        const message = `Vẽ overlay lỗi (${err?.code || 'OVERLAY_FAILED'}): ${err?.message || err}`;
        log?.error('imagestudio.overlay_failed', { error: err });
        warnings.push(message);
        failures.push({ step: 'overlay', code: String(err?.code || 'OVERLAY_FAILED'), message });
      }
      if (drawn) {
        warnings.push(...(Array.isArray(drawn.warnings) ? drawn.warnings.map(String).slice(0, 20) : []));
        if (drawn.applied === true && drawn.buffer) {
          currentBuffer = drawn.buffer;
          currentMime = 'image/png';
          overlayApplied = true;
          overlay = { applied: true, reason: null, violations: [], evidence_used: evidence.evidence_used };
        } else {
          // KHÔNG lưu ảnh overlay: giữ nguyên ảnh của bước trước đó (fail-closed).
          overlay = {
            applied: false,
            reason: String(drawn.reason || 'OVERLAY_FAILED'),
            violations: Array.isArray(drawn.violations) ? drawn.violations.map(String).slice(0, 50) : [],
            // N5: nói rõ bằng chứng ĐÃ DÙNG (kể cả khi bị chặn) để người duyệt tra được vì sao.
            evidence_used: evidence.evidence_used,
          };
          warnings.push(`KHÔNG vẽ overlay (${overlay.reason}) — giữ nguyên ảnh trước đó.`);
          failures.push({ step: 'overlay', code: overlay.reason, message: warnings[warnings.length - 1] });
        }
      } else if (!overlay) {
        overlay = { applied: false, reason: 'OVERLAY_FAILED', violations: [], evidence_used: evidence.evidence_used };
      }
    } else if (overlayInput) {
      warnings.push('Overlay không có nội dung (text rỗng) — bỏ qua, KHÔNG vẽ.');
    }

    /* ── (e) CHỐT: có đổi gì không? Ảnh ra có đúng khung ảnh gốc không? ────── */
    const changed = composed || retouched || overlayApplied;

    // Khử cảnh báo TRÙNG NHAU (pipeline và provider có thể kẹp cùng tham số ⇒ cùng câu),
    // nhưng TUYỆT ĐỐI không bỏ cảnh báo nào chỉ xuất hiện một lần (không được ẩn sự thật).
    const warningsAll = [...new Set(warnings)];

    // Bất biến #1: ẢNH GỐC BẤT BIẾN — đọc lại từ ĐĨA và băm so với lúc bắt đầu.
    let originalBufferAfter;
    try {
      originalBufferAfter = await this.storage.read(original);
    } catch (err) {
      const wrapped = new ImageStudioError(String(err?.code || 'STORAGE_READ_FAILED'), `Không đọc lại được ảnh gốc để kiểm bất biến: ${err?.message || err}`);
      await this.#failJob(jobId, wrapped);
      throw wrapped;
    }
    if (sha256(originalBufferAfter) !== originalSha) {
      const err = new ImageStudioError('ORIGINAL_MUTATED', 'Ảnh gốc đã BỊ ĐỔI trong lúc tạo ảnh — dừng và không lưu ảnh mới (luật #1).');
      await this.#failJob(jobId, err);
      throw err;
    }

    let rendered = null;
    let renderedSize = null;
    if (changed) {
      // Bất biến #1: ảnh ra CÙNG kích thước ảnh gốc (không resize/crop/warp).
      renderedSize = outputSize(currentBuffer);
      if (!renderedSize) {
        const err = new ImageStudioError('INVALID_OUTPUT', 'Ảnh đầu ra không đọc được header — không lưu (fail-closed).');
        await this.#failJob(jobId, err);
        throw err;
      }
      if (originalWidth && originalHeight && (renderedSize.width !== originalWidth || renderedSize.height !== originalHeight)) {
        const err = new ImageStudioError(
          'OUTPUT_SIZE_MISMATCH',
          `Ảnh ra ${renderedSize.width}×${renderedSize.height} LỆCH ảnh gốc ${originalWidth}×${originalHeight} — không lưu (luật #1: không resize/crop).`,
        );
        await this.#failJob(jobId, err);
        throw err;
      }

      const assetId = randomUUID();
      const outMime = currentMime || 'image/png';
      const ext = MIME_EXT[outMime] || 'png';
      // Ghi ảnh ra CÓ THỂ hỏng (đĩa đầy/quyền) ⇒ job phải `failed` + `finished_at`,
      // KHÔNG được treo `running` (luật fail-closed của cả dự án).
      let saved;
      try {
        saved = await this.storage.save({ jobId, assetId, ext, mime: outMime, buffer: currentBuffer });
      } catch (err) {
        const wrapped = new ImageStudioError(String(err?.code || 'STORAGE_WRITE_FAILED'), `Không lưu được ảnh đã tạo: ${err?.message || err}`);
        await this.#failJob(jobId, wrapped);
        throw wrapped;
      }
      const meta = {
        kind: IMAGESTUDIO_KIND,
        template: { id: template.id, label: template.label, synthetic: template.synthetic === true },
        synthetic_background: syntheticBackground,
        // N1 (vòng 9): vết "người dùng đã bỏ qua cảnh báo biên nhập nhằng" nằm NGAY trên ảnh ra.
        // N9 (vòng 10): ghi bản TÓM TẮT ĐẦY ĐỦ (có `mask` + mọi số đo biên) — trước đây chỉ
        // 3 field nên `GET /api/imagestudio/jobs/:id`, `asset.meta` và UI KHÔNG có số đo nào.
        matting: summarizeMatting(matting),
        retouch_effective: retouchEffective,
        retouch_clamped: clampedNames,
        retouch_rejected: rejectedNames,
        overlay,
        parent_sha256: originalSha,
        generator: {
          stages: ['matting', 'composing', 'retouching'],
          matting_status: matting?.status ?? null,
          compose_background_ratio: composeResult ? Number(composeResult.background_ratio) || 0 : 0,
          retouch_status: retouch?.status ?? null,
        },
        warnings: warningsAll.slice(0, 50),
      };
      try {
        await this.store.createImageAsset({
          id: assetId,
          jobId,
          sessionId: sid,
          // MVP-05 §2.2: ảnh render thuộc cùng chủ sở hữu với job.
          userId: job.user_id || null,
          role: 'rendered',
          parentId: original.id,
          mime: outMime,
          bytes: saved.bytes,
          width: renderedSize.width,
          height: renderedSize.height,
          sha256: saved.sha256,
          storagePath: saved.storage_path,
          source: 'generate',
          meta,
        });
      } catch (err) {
        await this.storage.remove({ storage_path: saved.storage_path }).catch(() => {});
        await this.#failJob(jobId, err);
        throw err;
      }
      rendered = await this.store.getImageAsset(assetId);
      // Dấu vết trên ẢNH GỐC (chỉ ghi meta DB — file ảnh gốc KHÔNG bị chạm).
      // `updateImageAssetMeta` merge NÔNG ở cấp cao nhất, nên khoá `imagestudio` phải được
      // gộp tay: nếu không, lượt tạo ảnh sau sẽ XOÁ dấu vết của lượt trước (mất lịch sử).
      const freshOriginal = await this.store.getImageAsset(original.id);
      const prevTrace =
        freshOriginal?.meta?.imagestudio && typeof freshOriginal.meta.imagestudio === 'object' ? freshOriginal.meta.imagestudio : {};
      const at = new Date().toISOString();
      const runs = (Array.isArray(prevTrace.runs) ? prevTrace.runs : []).slice(-4);
      runs.push({
        rendered_id: assetId,
        rendered_sha256: saved.sha256,
        at,
        template: template.id,
        synthetic_background: syntheticBackground,
        retouch_effective: retouchEffective,
        overlay,
      });
      await this.#updateAssetMeta(jobId, original.id, {
        imagestudio: {
          ...prevTrace,
          rendered_id: assetId,
          rendered_sha256: saved.sha256,
          at,
          synthetic_background: syntheticBackground,
          retouch_effective: retouchEffective,
          overlay,
          runs,
        },
      });
    }

    // ── Trạng thái cuối ───────────────────────────────────────────────────
    let status;
    let errorCode = null;
    let errorMessage = null;
    if (!changed) {
      // Hợp đồng §3.3: không đổi gì ⇒ KHÔNG được báo OK, KHÔNG lưu ảnh mới.
      // (Nếu job đã có ảnh rendered từ lượt trước thì ảnh đó VẪN CÒN trong DB —
      //  chỉ ghi thêm, không bao giờ xoá — nhưng `error_code = 'NO_CHANGES'`.)
      status = IMAGESTUDIO_PARTIAL;
      errorCode = IMAGESTUDIO_NO_CHANGES;
      errorMessage = `Không có thay đổi nào so với ảnh gốc (${failures.map((f) => f.code).join(', ') || 'không bước nào chạy'}).`;
      warnings.push('KHÔNG có thay đổi nào so với ảnh gốc ⇒ KHÔNG lưu ảnh mới và KHÔNG báo thành công (NO_CHANGES).');
    } else if (failures.length > 0) {
      status = IMAGESTUDIO_PARTIAL;
      errorCode = failures[0].code;
      errorMessage = failures[0].message;
    } else {
      status = JOB_STATUS.SUCCEEDED;
    }

    const finishedAt = new Date().toISOString();
    const warningsFinal = [...new Set(warnings)];
    const freshJob = await this.store.getJob(jobId);
    await this.#setJob(jobId, {
      status,
      stage: 'done',
      error_code: errorCode,
      error_message: errorMessage,
      finished_at: finishedAt,
      content_meta: {
        ...(freshJob?.content_meta || {}),
        imagestudio: {
          ...(freshJob?.content_meta?.imagestudio || {}),
          kind: IMAGESTUDIO_KIND,
          status,
          error_code: errorCode,
          error_message: errorMessage,
          template: { id: template.id, label: template.label, synthetic: template.synthetic === true },
          synthetic_background: syntheticBackground,
          composed,
          retouched,
          retouch_effective: retouchEffective,
          retouch_clamped: clampedNames,
          retouch_rejected: rejectedNames,
          overlay,
          failures,
          // Tóm tắt 3 bước (KHÔNG chứa buffer pixel) để E4 trả `GET /api/imagestudio/jobs/:id`
          // với đúng field `matting`/`compose`/`retouch` mà không phải đoán lại từ log.
          matting: summarizeMatting(matting),
          compose: summarizeCompose(composeResult, composed),
          retouch: summarizeRetouch(retouch, retouchEffective),
          warnings: warningsFinal.slice(0, 50),
          rendered_asset_id: rendered?.id ?? null,
          original_asset_id: original.id,
          original_sha256: originalSha,
          output_sha256: rendered?.sha256 ?? null,
          output_size: renderedSize ? { width: renderedSize.width, height: renderedSize.height } : null,
          previous_rendered: previousRendered,
          providers: {
            matting: this.mattingProvider ? { name: this.mattingProvider.name || '', is_mock: Boolean(this.mattingProvider.isMock) } : null,
            retouch: this.retouchProvider ? { name: this.retouchProvider.name || '', is_mock: Boolean(this.retouchProvider.isMock) } : null,
          },
          duration_ms: Date.now() - started,
          updated_at: finishedAt,
        },
      },
    });

    await this.#evidence(jobId, {
      bytes: rendered?.bytes ?? original.bytes,
      foundFields: [
        'image_asset:original',
        ...(rendered ? ['image_asset:rendered', `template:${template.id}`] : []),
        `status:${status}`,
      ],
      missingFields: rendered ? [] : ['image_asset:rendered'],
      blockedReason: failures.length > 0 ? failures.map((f) => `${f.step}:${f.code}`).join(', ').slice(0, 1000) : '',
      mattingProvider: this.mattingProvider?.name || '',
      retouchProvider: this.retouchProvider?.name || '',
    });

    log?.info('imagestudio.generate_done', {
      status,
      error_code: errorCode,
      changed,
      matting: matting?.status ?? null,
      compose_ratio: composeResult ? composeResult.background_ratio : null,
      retouch: retouch?.status ?? null,
      overlay: overlay?.applied ?? null,
      rendered_id: rendered?.id ?? null,
      ms: Date.now() - started,
    });

    return {
      status,
      stage: 'done',
      error_code: errorCode,
      error_message: errorMessage,
      asset: rendered,
      asset_id: rendered?.id ?? null,
      original_asset: original,
      original_sha256: originalSha,
      template: { id: template.id, label: template.label, synthetic: template.synthetic === true },
      synthetic_background: syntheticBackground,
      retouch_effective: retouchEffective,
      retouch_clamped: clampedNames,
      retouch_rejected: rejectedNames,
      matting: summarizeMatting(matting),
      compose: summarizeCompose(composeResult, composed),
      retouch: summarizeRetouch(retouch, retouchEffective),
      overlay,
      failures,
      warnings: warningsFinal,
      previous_rendered: previousRendered,
      duration_ms: Date.now() - started,
    };
  }
}

/** Tái xuất ĐÚNG hợp đồng §3.3 — một bản luật duy nhất nằm ở tầng retouch (E1). */
export { clampRetouchParams } from './retouch/index.js';

export default ImageGenerationPipeline;
