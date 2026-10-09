/**
 * API routes — bề mặt công khai của ứng dụng.
 *
 * Mọi lỗi được ném dưới dạng HttpError với thông báo AN TOÀN (không lộ stack,
 * không lộ secret, không lộ chi tiết nội bộ).
 */

import { randomUUID, createHash } from 'node:crypto';
import { Router, HttpError, sendJson, readJson, sessionId, presentedSessionId, parseCookies, MAX_BODY_BYTES_DEFAULT, SECURITY_HEADERS } from './server.js';
import { scrubPaths } from '../logger.js';
import { tryDetectSource } from '../sources/detect.js';
import { STYLES, LENGTHS } from '../content/styles.js';
import { JOB_STATUS } from '../store/index.js';
import { enforce, clientKey } from '../security/ratelimit.js';
import { sniffImageMime, sanitizeFilename, sanitizeText } from '../security/sanitize.js';
import { parseContentOptions } from '../content/styles.js';

const UUID_RE = /^[0-9a-fA-F-]{36}$|^[A-Za-z0-9_-]{8,64}$/;

/* ══════════════ MVP-05 · hằng số ĐÓNG BĂNG (hợp đồng §2.1/§2.3/§3.3) ══════════════
 * Khai ở cấp MODULE để mọi hàm ánh xạ lỗi dùng CHUNG một nguồn và không phụ thuộc thứ tự
 * khai báo. Cố ý KHÔNG static-import `src/accounts/**`: routes.js phải nạp được kể cả khi
 * khối MVP-05 chưa có mặt (A3 nạp phòng thủ bằng dynamic import) — một import hỏng ở đây
 * sẽ làm chết cả MVP-01/02/03.
 */

/** Tiền tố route NGHIỆP VỤ — chỉ những route này mới bị cổng "bắt buộc đăng nhập" chạm tới. */
const BUSINESS_PATH_RE = /^\/api\/(?:jobs|imagelab|imagestudio|videostudio|uploads|detect)(?:\/|$)/;

const ANON_EXEMPT_PATHS = new Set(['/api/health', '/api/config']);

/** Vai trò hợp lệ (§2.1) — ĐÓNG BĂNG, dùng chung cho phân quyền và route quản trị. */
const AUTH_ROLES = Object.freeze(['owner', 'admin', 'member']);
const ADMIN_ROLES = new Set(['owner', 'admin']);

/** Nhóm tổng hợp usage mà `/api/admin/usage` chấp nhận (§3.3). */
const USAGE_GROUP_BY = Object.freeze(['day', 'operation', 'user']);

/** MVP-06 — trạng thái yêu cầu nạp mà `?status=` chấp nhận (`docs/MVP-06-CONTRACT.md` §2).
 *  Khai LẠI ở đây (không static-import `src/store/index.js`? — store ĐƯỢC import sẵn cho
 *  `JOB_STATUS`, nhưng danh sách này là HỢP ĐỒNG HTTP nên giữ ngay cạnh route để đọc một chỗ). */
const TOPUP_STATUS_LIST = Object.freeze(['pending', 'confirmed', 'rejected', 'expired']);

/**
 * Danh sách operation của bảng giá (§2.1) — chỉ dùng để hỏi giá khi store CHƯA có
 * `listPricing`; không phải bản sao bảng giá (giá vẫn do A2/store quyết định).
 */
const PRICING_OPERATIONS = Object.freeze([
  'SOURCE_EXTRACT', 'VISION_ANALYSIS', 'TRANSLATION', 'CONTENT_GENERATE', 'CONTENT_REPAIR',
  'OCR_DETECT', 'IMAGE_RENDER', 'IMAGE_MATTING', 'IMAGE_COMPOSE', 'IMAGE_RETOUCH',
  // MVP-04 — video offline (đường DỰ PHÒNG khi store không có `listPricing`).
  'VIDEO_RENDER', 'VIDEO_ENCODE',
]);

/** Câu DUY NHẤT cho mọi ca sai thông tin đăng nhập (khớp hằng số trong `buildRouter`). */
const BAD_CREDENTIALS_TEXT = 'Email hoặc mật khẩu không đúng.';

/* ══════════════ MVP-07 · hằng số ĐÓNG BĂNG (hợp đồng §2.6/§3.1) ══════════════
 * Khai ở cấp MODULE để `/api/config` và hàm ánh xạ lỗi dùng CHUNG một nguồn. Cố ý KHÔNG
 * static-import `src/publish/**`: routes.js phải nạp được kể cả khi khối MVP-07 chưa có mặt
 * (app.js nạp phòng thủ bằng dynamic import) — một import hỏng ở đây sẽ làm chết cả MVP-01..06.
 */

/** Trạng thái bài đăng (bản sao ĐỌC-CHỈ của `PUBLISH_STATUSES` cho tầng HTTP). */
const PUBLISH_STATUS_LIST = Object.freeze([
  'draft', 'pending_review', 'approved', 'publishing', 'published', 'failed', 'rejected',
]);

/** `PublishError.code` ⇒ mã HTTP (hợp đồng §2.6). Mã lạ ⇒ 500 + log, KHÔNG đoán. */
const PUBLISH_ERROR_STATUS = Object.freeze({
  BAD_INPUT: 400,
  BAD_SCHEDULE: 400,
  TEXT_TOO_LONG: 400,
  MEDIA_TOO_MANY: 400,
  BAD_STATE: 409,
  MEDIA_NOT_PUBLIC: 422,
  ITEM_NOT_FOUND: 404,
  // Mã QUAN TRỌNG NHẤT của sprint: bài chưa duyệt ⇒ 409, và provider chưa hề được gọi.
  NOT_APPROVED: 409,
  ITEM_REJECTED: 409,
  PUBLISH_IN_PROGRESS: 409,
  ALREADY_PUBLISHED: 409,
  NOT_CONFIGURED: 409,
  PROVIDER_DISABLED: 503,
  PROVIDER_FAILED: 502,
  ATTEMPTS_EXHAUSTED: 429,
  STORE_WRITE_FAILED: 500,
});

const AUTH_CODE_SETS = Object.freeze({
  EMAIL_TAKEN: new Set(['EMAIL_TAKEN', 'EMAIL_EXISTS', 'DUPLICATE_EMAIL', 'USER_EXISTS', 'EMAIL_IN_USE']),
  WEAK_PASSWORD: new Set(['WEAK_PASSWORD', 'PASSWORD_TOO_SHORT', 'SHORT_PASSWORD', 'PASSWORD_TOO_WEAK', 'WEAK']),
  BAD_CREDENTIALS: new Set([
    'BAD_CREDENTIALS', 'INVALID_CREDENTIALS', 'INVALID_PASSWORD', 'WRONG_PASSWORD', 'PASSWORD_MISMATCH',
    'USER_NOT_FOUND', 'NOT_FOUND', 'NO_SUCH_USER', 'BAD_EMAIL', 'INVALID_EMAIL',
  ]),
  DISABLED: new Set(['ACCOUNT_DISABLED', 'USER_DISABLED', 'DISABLED', 'FORBIDDEN']),
  BAD_BODY: new Set(['BAD_BODY', 'INVALID_INPUT', 'VALIDATION_ERROR', 'MISSING_FIELD', 'BAD_REQUEST', 'BAD_EMAIL', 'INVALID_EMAIL']),
  USER_NOT_FOUND: new Set(['USER_NOT_FOUND', 'NOT_FOUND', 'NO_SUCH_USER']),
  BAD_ROLE: new Set(['BAD_ROLE', 'INVALID_ROLE', 'ROLE_INVALID']),
});

export function buildRouter(app) {
  const { config, logger, store, pipeline, queue, sessions, rateLimiters, registry, visionProvider, contentEngine } = app;
  const router = new Router();

  const requireJob = async (id) => {
    if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_JOB_ID', 'Mã job không hợp lệ.');
    const job = await store.getJob(id);
    if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'Không tìm thấy job.');
    return job;
  };

  /**
   * MVP-05 (§3.3) — TÁCH DỮ LIỆU THEO TÀI KHOẢN.
   *
   * Tài nguyên có `user_id` (job/asset của người đã đăng nhập) chỉ thuộc về ĐÚNG user đó:
   * khác chủ ⇒ **404** (không xác nhận sự tồn tại), kể cả khi session_id trùng — nếu không,
   * đăng xuất xong vẫn đọc được dữ liệu cũ bằng cookie `sid` còn lại.
   *
   * `user_id` NULL = tài nguyên của khách ẨN DANH (MVP-01/02/03) ⇒ trả `false` để tầng gọi
   * giữ nguyên luật cũ theo `session_id`; KHÔNG tự gán tài nguyên ẩn danh cho tài khoản nào
   * (§2.2). Đây là chỗ DUY NHẤT định nghĩa luật sở hữu theo tài khoản — mọi route job/asset
   * (kể cả route cũ của MVP-01/02/03) đều đi qua đây.
   *
   * @returns {boolean} true = đã kiểm theo tài khoản (chủ hợp lệ), false = tài nguyên ẩn danh
   */
  const assertAccountOwnership = (resource, req, { code = 'JOB_NOT_FOUND', message = 'Không tìm thấy job.' } = {}) => {
    const ownerId = resource?.user_id ?? null;
    if (ownerId === null || ownerId === undefined || ownerId === '') return false;
    const userId = req?.user?.id ?? null;
    if (!userId || String(userId) !== String(ownerId)) throw new HttpError(404, code, message);
    return true;
  };

  /**
   * F-04 (sau phản biện) — route MVP-01 CŨ cũng phải kiểm quyền sở hữu theo session,
   * đúng chính sách của `/api/imagelab/*`: tài nguyên của session khác trả **404**
   * (không xác nhận sự tồn tại).
   *
   * ⚠️ `session_id` KHÔNG phải xác thực (cookie do client gửi — đã ghi từ MVP-01):
   * luật này chỉ chống TRUY CẬP NHẦM giữa các phiên, KHÔNG phải hàng rào bảo mật.
   * Request KHÔNG khai cookie session nào được coi là khách ẩn danh (MVP-01 vẫn chạy
   * được không cần cookie); riêng job ImageLab (`kind = 'image_translation'`) thì luôn
   * yêu cầu session khớp, vì đó là tài nguyên của MVP-02.
   */
  const requireOwnJob = async (req, res, id) => {
    const job = await requireJob(id);
    // MVP-05: job của TÀI KHOẢN khác ⇒ 404 trước mọi đối chiếu session.
    if (assertAccountOwnership(job, req)) return job;
    if (!job.session_id) return job; // job cũ không gắn session → không có gì để đối chiếu
    const sid = sessionId(req, res);
    if (job.session_id === sid) return job;
    const presented = presentedSessionId(req);
    const isImagelabJob = String(job.kind ?? '') === 'image_translation';
    if (presented !== null || isImagelabJob) {
      throw new HttpError(404, 'JOB_NOT_FOUND', 'Không tìm thấy job.');
    }
    return job; // khách ẩn danh (không khai session) — hành vi MVP-01 giữ nguyên
  };

  /* ─────────────── MVP-02 · tiện ích dùng chung cho imagelab ─────────────── */

  // 4.6 — module anh em (pipeline/storage) có thể chưa nạp được khi 5 agent chạy
  // song song. Mọi route /api/imagelab/* phải kiểm trước và trả 503 gọn gàng,
  // tuyệt đối không để MVP-02 làm chết server của MVP-01.
  const imagelabEnabled = () => config.imagelab?.enabled !== false;
  /** "Khả dụng" = đã nạp được pipeline + storage VÀ tính năng không bị tắt. */
  const imagelabAvailable = () => Boolean(app.imagelabPipeline && app.storage) && imagelabEnabled();
  /** Lý do THẬT do `src/app.js` ghi lại khi khối MVP-02 nạp lỗi — không được im lặng. */
  const imagelabUnavailableReason = () =>
    app.imagelabUnavailableReason || 'Không rõ lý do — xem log máy chủ (imagelab.wiring_failed).';

  /**
   * Nạp module C2 (`applyReviewEdits`) và module C4 (`pendingReviewLines`).
   *
   * Cố ý KHÔNG chép lại luật của các module anh em vào file này: bản sao luật là thứ
   * dễ lệch nhất (bản dự phòng cũ của `applyReviewEdits` từng từ chối `action: accept`
   * trên vùng nhãn hiệu, trong khi C2 cho phép — hai luật, hai kết quả). Module không
   * nạp được thì route báo 503 thẳng thắn, KHÔNG mô phỏng kết quả.
   */
  const moduleLoaders = new Map();
  const loadImagelabFunction = (specifier, exportName) => {
    const key = `${specifier}#${exportName}`;
    if (!moduleLoaders.has(key)) {
      moduleLoaders.set(key, (async () => {
        try {
          const mod = await import(specifier);
          if (typeof mod?.[exportName] !== 'function') {
            logger?.error?.('imagelab.module_export_missing', { module: specifier, export: exportName });
            return null;
          }
          return mod[exportName];
        } catch (err) {
          // Không đưa cả object lỗi vào log: message/stack của Node chứa đường dẫn tuyệt đối.
          logger?.error?.('imagelab.module_load_failed', {
            module: specifier,
            export: exportName,
            error_name: err?.name || 'Error',
            error_code: err?.code || null,
            error_message: String(err?.message || err).replace(/\/(?:Users|home|private|tmp|var|opt|mnt|Volumes)\/\S*/g, '<path>'),
          });
          return null;
        }
      })());
    }
    return moduleLoaders.get(key);
  };

  const imagelabLimits = () => ({
    max_image_bytes: config.imagelab?.maxImageBytes ?? config.net.maxUploadBytes,
    max_pixels: config.imagelab?.maxPixels ?? DEFAULT_MAX_PIXELS,
    max_regions: config.imagelab?.maxRegions ?? DEFAULT_MAX_REGIONS,
    allowed_image_mime: config.net.allowedImageMime,
  });

  const providerInfo = (p) => ({
    name: p?.name || 'none',
    model: p?.model || '',
    configured: Boolean(p?.configured),
    is_mock: Boolean(p?.isMock),
  });
  const imagelabProviders = () => ({
    ocr: providerInfo(app.ocrProvider),
    render: providerInfo(app.renderProvider),
    translate: providerInfo(app.translator),
  });

  const requireImagelab = () => {
    if (!imagelabAvailable()) {
      // F-05: thông báo tiếng Việt tự viết, đã lọc đường dẫn/secret → được phép hiện thẳng.
      throw HttpError.safe(503, 'IMAGELAB_UNAVAILABLE', imagelabUnavailableReason());
    }
  };
  const requirePipelineMethod = (name) => {
    requireImagelab();
    if (typeof app.imagelabPipeline?.[name] !== 'function') {
      throw HttpError.safe(503, 'IMAGELAB_UNAVAILABLE', `Pipeline dịch ảnh thiếu phương thức "${name}" — tính năng chưa sẵn sàng.`);
    }
  };
  const requireStoreMethod = (name) => {
    if (typeof store[name] !== 'function') {
      throw HttpError.safe(503, 'IMAGELAB_UNAVAILABLE', `Kho dữ liệu thiếu phương thức "${name}" — tính năng dịch ảnh chưa sẵn sàng.`);
    }
  };

  /** Provider có TỰ KHAI là chưa cấu hình hay không (không suy diễn khi thiếu getter). */
  const isUnconfigured = (p) => Boolean(p) && p.configured === false;

  // Quyền sở hữu theo session: tài nguyên của người khác trả 404 y như tài nguyên
  // không tồn tại — không xác nhận sự tồn tại của job/asset của session khác.
  // MVP-05: tài nguyên của TÀI KHOẢN khác cũng 404 (kiểm trước, xem `assertAccountOwnership`).
  const requireImagelabJob = async (id, sid, req = null) => {
    requireImagelab();
    if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_JOB_ID', 'Mã job không hợp lệ.');
    const job = await store.getJob(id);
    if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'Không tìm thấy job.');
    if (assertAccountOwnership(job, req)) return job;
    if (job.session_id !== sid) throw new HttpError(404, 'JOB_NOT_FOUND', 'Không tìm thấy job.');
    return job;
  };

  const requireImagelabAsset = async (id, sid, req = null) => {
    requireImagelab();
    requireStoreMethod('getImageAsset');
    if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_ASSET_ID', 'Mã ảnh không hợp lệ.');
    const asset = await store.getImageAsset(id);
    if (!asset) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');

    // Job sở hữu ảnh (nếu có) — dùng cho CẢ luật tài khoản (MVP-05) lẫn luật session (cũ).
    const ownerJob = asset.job_id ? await store.getJob(asset.job_id) : null;

    // (1) MVP-05 — ảnh HOẶC job sở hữu gắn `user_id`: chỉ chủ đọc được, khác chủ ⇒ 404.
    const accountOwner = asset.user_id ?? ownerJob?.user_id ?? null;
    if (accountOwner !== null && accountOwner !== undefined && accountOwner !== '') {
      if (String(req?.user?.id ?? '') !== String(accountOwner)) {
        throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');
      }
      return asset;
    }

    // (2) Ảnh ẩn danh: giữ nguyên luật MVP-02/03 theo `session_id`. Khi chủ hệ thống TẮT
    // chế độ ẩn danh (AUTH_ANONYMOUS_ALLOWED=false) thì tài nguyên ẩn danh không còn phục vụ.
    if (!anonymousAllowed()) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');

    if (asset.session_id) {
      if (asset.session_id !== sid) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');
    } else if (asset.job_id) {
      // Thiếu session_id trên asset thì đối chiếu qua job sở hữu nó.
      if (!ownerJob || ownerJob.session_id !== sid) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');
    } else {
      // Không xác định được chủ sở hữu → fail-closed, không trả dữ liệu.
      throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');
    }
    return asset;
  };

  /* ─────────────── MVP-03 · tiện ích dùng chung cho imagestudio ─────────────── */

  // 3.6 — E3 (pipeline + wiring) do agent khác viết song song nên có thể CHƯA có mặt lúc
  // server khởi động. Mọi route /api/imagestudio/* phải kiểm trước và trả 503 gọn gàng,
  // tuyệt đối không để MVP-03 làm chết server của MVP-01/MVP-02.
  const IMAGESTUDIO_MODULE_MESSAGE =
    'Không nạp được module mẫu nền / ngưỡng retouch của MVP-03 — tính năng tạo ảnh chưa sẵn sàng. Chi tiết ở log máy chủ (imagestudio.module_load_failed).';

  /**
   * MVP-03 có bị TẮT bằng cấu hình không.
   *
   * Cách chọn (nói rõ để không ai đoán): MVP-03 dùng CHUNG kho ảnh `src/imagelab/storage.js`
   * và trần ảnh `imagelab.maxImageBytes/maxPixels` với MVP-02, nên `imagelab.enabled = false`
   * cũng phải tắt MVP-03; đồng thời tôn trọng cờ riêng `imagestudio.enabled` nếu có, để tắt
   * riêng MVP-03 mà không phải bật lại MVP-02. Thiếu cả hai khoá ⇒ coi như đang bật.
   */
  const imagestudioEnabled = () => config.imagestudio?.enabled !== false && config.imagelab?.enabled !== false;

  /**
   * Kho ảnh để ĐỌC tệp: ưu tiên kho dùng chung của MVP-02, thiếu thì lấy kho riêng mà E3 đã
   * bơm vào pipeline (app.js có thể nạp kho riêng khi khối ImageLab hỏng) — không đoán.
   */
  const imagestudioStorage = () => app.storage || app.imagestudioPipeline?.storage || null;

  /**
   * "Khả dụng" = có pipeline E3 + không bị tắt bằng cấu hình.
   * KHÔNG lấy `storage` làm điều kiện: E3 có thể đang dùng kho riêng, và route chỉ cần kho
   * ở đúng chỗ đọc tệp (khi đó thiếu kho ⇒ 503 ngay tại route đó).
   */
  const imagestudioAvailable = () => Boolean(app.imagestudioPipeline) && imagestudioEnabled();

  /** Lý do THẬT khiến MVP-03 không chạy được (câu tiếng Việt, không lộ đường dẫn nội bộ). */
  const imagestudioUnavailableReason = () => {
    if (app.imagestudioUnavailableReason) return String(app.imagestudioUnavailableReason);
    if (!imagestudioEnabled()) return 'Tính năng tạo ảnh đang bị tắt bằng cấu hình (IMAGELAB_ENABLED/IMAGESTUDIO_ENABLED = false).';
    return 'Không nạp được pipeline tạo ảnh MVP-03 — tính năng tạo ảnh bị tắt. Chi tiết ở log máy chủ (imagestudio.wiring_failed).';
  };

  const requireImagestudio = () => {
    if (!imagestudioAvailable()) throw HttpError.safe(503, 'IMAGESTUDIO_UNAVAILABLE', imagestudioUnavailableReason());
  };

  const requireImagestudioMethod = (name) => {
    requireImagestudio();
    if (typeof app.imagestudioPipeline?.[name] !== 'function') {
      throw HttpError.safe(503, 'IMAGESTUDIO_UNAVAILABLE', `Pipeline tạo ảnh thiếu phương thức "${name}" — tính năng chưa sẵn sàng.`);
    }
  };

  const requireImagestudioStoreMethod = (name) => {
    if (typeof store[name] !== 'function') {
      throw HttpError.safe(503, 'IMAGESTUDIO_UNAVAILABLE', `Kho dữ liệu thiếu phương thức "${name}" — tính năng tạo ảnh chưa sẵn sàng.`);
    }
  };

  /** Thông tin provider MVP-03 — ĐÚNG ba field hợp đồng §3.6, không suy diễn thêm. */
  const imagestudioProviderInfo = (p) => ({
    name: p?.name || 'none',
    is_mock: Boolean(p?.isMock),
    configured: Boolean(p?.configured),
  });
  const imagestudioProviders = () => ({
    matting: imagestudioProviderInfo(app.mattingProvider),
    retouch: imagestudioProviderInfo(app.retouchProvider),
  });

  /**
   * Nạp module TĨNH của MVP-03 (`TEMPLATES`, `RETOUCH_LIMITS`) — nạp PHÒNG THỦ như MVP-02:
   * module anh em có thể chưa tồn tại lúc 5 agent chạy song song, và lỗi nạp KHÔNG được làm
   * sập server. Phần nào thiếu thì trả `null` — KHÔNG bịa giá trị thay thế.
   */
  const imagestudioModules = new Map();
  const loadImagestudioModule = (specifier) => {
    if (!imagestudioModules.has(specifier)) {
      imagestudioModules.set(specifier, (async () => {
        try {
          return await import(specifier);
        } catch (err) {
          logger?.error?.('imagestudio.module_load_failed', {
            module: specifier,
            error_name: err?.name || 'Error',
            error_code: err?.code || null,
            // Không đưa cả object lỗi vào log: message/stack của Node chứa đường dẫn tuyệt đối.
            error_message: String(err?.message || err).replace(/\/(?:Users|home|private|tmp|var|opt|mnt|Volumes)\/\S*/g, '<path>'),
          });
          return null;
        }
      })());
    }
    return imagestudioModules.get(specifier);
  };

  const imagestudioStaticModules = async () => {
    const [compose, retouch] = await Promise.all([
      loadImagestudioModule('../imagestudio/compose/index.js'),
      loadImagestudioModule('../imagestudio/retouch/index.js'),
    ]);
    return {
      templates: Array.isArray(compose?.TEMPLATES) ? compose.TEMPLATES : null,
      retouchLimits: retouch?.RETOUCH_LIMITS && typeof retouch.RETOUCH_LIMITS === 'object' ? retouch.RETOUCH_LIMITS : null,
    };
  };

  const requireImagestudioTemplates = async () => {
    const mods = await imagestudioStaticModules();
    if (!mods.templates || !mods.retouchLimits) {
      throw HttpError.safe(503, 'IMAGESTUDIO_UNAVAILABLE', IMAGESTUDIO_MODULE_MESSAGE);
    }
    return mods;
  };

  /** Quyền sở hữu job theo session: job của session khác trả 404 y như job không tồn tại. */
  const requireImagestudioJob = async (id, sid, req = null) => {
    requireImagestudio();
    if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_JOB_ID', 'Mã job không hợp lệ.');
    const job = await store.getJob(id);
    if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'Không tìm thấy job.');
    // MVP-05: job của TÀI KHOẢN khác ⇒ 404 (không xác nhận sự tồn tại).
    if (assertAccountOwnership(job, req)) return job;
    if (job.session_id !== sid) throw new HttpError(404, 'JOB_NOT_FOUND', 'Không tìm thấy job.');
    return job;
  };

  /** Quyền sở hữu ẢNH theo session — cùng luật với `requireImagelabAsset` (khác chủ ⇒ 404). */
  const requireImagestudioAsset = async (id, sid, req = null) => {
    requireImagestudio();
    requireImagestudioStoreMethod('getImageAsset');
    if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_ASSET_ID', 'Mã ảnh không hợp lệ.');
    const asset = await store.getImageAsset(id);
    if (!asset) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');

    const ownerJob = asset.job_id ? await store.getJob(asset.job_id) : null;

    // (1) MVP-05 — ảnh HOẶC job sở hữu gắn `user_id`: chỉ chủ đọc được.
    const accountOwner = asset.user_id ?? ownerJob?.user_id ?? null;
    if (accountOwner !== null && accountOwner !== undefined && accountOwner !== '') {
      if (String(req?.user?.id ?? '') !== String(accountOwner)) {
        throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');
      }
      return asset;
    }

    // (2) Ảnh ẩn danh: giữ nguyên luật theo `session_id`; tắt ẩn danh ⇒ không phục vụ.
    if (!anonymousAllowed()) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');
    if (asset.session_id) {
      if (asset.session_id !== sid) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');
    } else if (asset.job_id) {
      if (!ownerJob || ownerJob.session_id !== sid) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');
    } else {
      // Không xác định được chủ sở hữu → fail-closed, không trả dữ liệu.
      throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');
    }
    return asset;
  };

  /**
   * "Chữ gốc của job" (§3.5) = vùng chữ OCR + tên sản phẩm + ghi chú người dùng.
   *
   * Job MVP-03 không chạy OCR nên phần này thường RỖNG — và rỗng nghĩa là KHÔNG có bằng
   * chứng, đúng luật fail-closed (mọi khẳng định bị chặn), KHÔNG phải "cho qua".
   * Chỉ đọc dữ liệu ĐÃ LƯU của job; KHÔNG nhận "bằng chứng" từ chính body đang gọi.
   */
  const collectImagestudioEvidence = async (job) => {
    const parts = [];
    // Tên sản phẩm của job (E3 cũng đọc field này — giữ hai bên cùng một định nghĩa).
    const productName = typeof job?.product_name === 'string' ? job.product_name.trim() : '';
    if (productName) parts.push(productName);
    if (job?.id && typeof store.listOcrRegions === 'function') {
      try {
        for (const region of asArray(await store.listOcrRegions(job.id))) {
          const text =
            typeof region?.text === 'string' ? region.text : typeof region?.text_original === 'string' ? region.text_original : '';
          if (text.trim()) parts.push(text);
        }
      } catch (err) {
        logger?.warn?.('imagestudio.evidence_failed', {
          job_id: job.id,
          error_name: err?.name || 'Error',
          error_code: err?.code || null,
        });
      }
    }
    const meta = job?.content_meta && typeof job.content_meta === 'object' ? job.content_meta : {};
    for (const holder of [meta.imagestudio, meta.imagelab]) {
      if (!holder || typeof holder !== 'object') continue;
      for (const key of IMAGESTUDIO_EVIDENCE_KEYS) {
        const text = holder[key];
        if (typeof text === 'string' && text.trim()) parts.push(text);
      }
    }
    return parts.join('\n');
  };

  /**
   * Kiểm overlay TRƯỚC khi xếp hàng (§3.5) — để trả HTTP **422** ngay thay vì 202 rồi
   * người dùng ngồi chờ một tấm ảnh không bao giờ có chữ.
   *
   * Đây KHÔNG phải hàng rào duy nhất: `drawOverlay` của E2 vẫn kiểm lại y hệt lúc vẽ, nên
   * không có đường nào vẽ được khẳng định thiếu bằng chứng. Route chỉ chuyển kết quả kiểm
   * thành mã HTTP đúng hợp đồng.
   *
   * @returns {Promise<{code:string,message:string,violations:string[]}|null>} null = được vẽ
   */
  const preflightOverlayBlock = async (job, options) => {
    const overlay = options?.overlay;
    const text = typeof overlay?.text === 'string' ? overlay.text.trim() : '';
    if (!text) return null; // không có chữ overlay ⇒ không có gì để chặn

    const [checkClaimWords, checkNumericClaims, hasUntranslatedScript] = await Promise.all([
      loadImagelabFunction('../imagelab/translate/guardrails.js', 'checkClaimWords'),
      loadImagelabFunction('../imagelab/translate/guardrails.js', 'checkNumericClaims'),
      loadImagelabFunction('../imagelab/translate/guardrails.js', 'hasUntranslatedScript'),
    ]);
    if (!checkClaimWords || !checkNumericClaims || !hasUntranslatedScript) {
      throw HttpError.safe(503, 'IMAGESTUDIO_UNAVAILABLE', 'Thiếu module kiểm chống bịa (guardrails) — chưa thể nhận chữ overlay.');
    }

    // M03-04: "chưa dịch" kiểm TRƯỚC danh sách vi phạm — cùng một câu vừa có chữ Hán vừa có
    // số liệu thì lý do đúng là CHƯA DỊCH, không phải "khẳng định không có bằng chứng".
    if (hasUntranslatedScript(text)) {
      return {
        code: 'OVERLAY_NOT_TRANSLATED',
        message: 'Chữ overlay còn chữ Hán/kana/Hangul chưa dịch — KHÔNG vẽ (mục 3.5).',
        violations: [],
      };
    }

    let violations = [];
    try {
      const evidence = await collectImagestudioEvidence(job);
      violations = [
        ...asArray(checkClaimWords(evidence, text)),
        ...asArray(checkNumericClaims(evidence, text)),
      ].map(String);
    } catch (err) {
      // Không kiểm được thì KHÔNG cho qua (fail-closed) và cũng không cáo buộc sai.
      logger?.warn?.('imagestudio.overlay_check_failed', { error_name: err?.name || 'Error', error_code: err?.code || null });
      throw HttpError.safe(503, 'IMAGESTUDIO_UNAVAILABLE', 'Chưa kiểm được chữ overlay (lỗi bộ kiểm chống bịa) — chưa thể nhận yêu cầu.');
    }

    if (violations.length > 0) {
      const shown = text.length > 120 ? `${text.slice(0, 120)}…` : text;
      return {
        code: 'OVERLAY_UNSUPPORTED_CLAIM',
        message: `Chữ overlay “${shown}” chứa khẳng định/số liệu không có bằng chứng trong chữ gốc của job — KHÔNG vẽ (mục 3.5).`,
        violations,
      };
    }
    return null;
  };

  /** Đánh dấu job hỏng (best-effort) — không để job treo 'queued' khi ingest ném lỗi. */
  const markImagestudioJobFailed = async (jobId, err) => {
    if (typeof store.updateJob !== 'function') return;
    try {
      await store.updateJob(jobId, {
        status: JOB_STATUS.FAILED,
        stage: 'failed',
        error_code: err?.code || 'IMAGESTUDIO_INGEST_FAILED',
        error_message: scrubPaths(String(err?.message || 'Không lưu được ảnh tải lên.')),
        finished_at: new Date().toISOString(),
      });
    } catch (inner) {
      logger?.warn?.('imagestudio.fail_mark_failed', { job_id: jobId, error_name: inner?.name || 'Error' });
    }
  };

  /* ─────────────── MVP-04 · tiện ích dùng chung cho videostudio ─────────────── */

  // §2.4 — V1 (kịch bản) / V2 (mã hoá) / V3 (pipeline) do agent khác viết song song nên có
  // thể CHƯA có mặt lúc máy chủ khởi động. Mọi route /api/videostudio/* phải kiểm trước và
  // trả 503 gọn gàng, tuyệt đối không để MVP-04 làm chết server của MVP-01/02/03/05.
  const VIDEOSTUDIO_MODULE_MESSAGE =
    'Không nạp được module kịch bản video của MVP-04 — tính năng tạo video chưa sẵn sàng. Chi tiết ở log máy chủ (videostudio.module_load_failed).';

  /**
   * MVP-04 có bị TẮT bằng cấu hình không: tôn trọng cờ riêng `videostudio.enabled` (nếu V3
   * thêm) VÀ dùng chung công tắc `imagelab.enabled`, vì video dùng CHUNG kho tệp
   * (`src/imagelab/storage.js`) + trần ảnh với MVP-02/MVP-03. Thiếu cả hai khoá ⇒ coi như bật.
   */
  const videostudioEnabled = () => config.videostudio?.enabled !== false && config.imagelab?.enabled !== false;

  /** Kho để ĐỌC tệp: ưu tiên kho dùng chung MVP-02, thiếu thì lấy kho riêng mà V3 bơm vào pipeline. */
  const videostudioStorage = () => app.storage || app.videostudioPipeline?.storage || null;

  /** "Khả dụng" = có pipeline V3 + không bị tắt bằng cấu hình (KHÔNG lấy kho làm điều kiện). */
  const videostudioAvailable = () => Boolean(app.videostudioPipeline) && videostudioEnabled();

  /** Lý do THẬT (câu tiếng Việt, không lộ đường dẫn nội bộ) khiến MVP-04 không chạy được. */
  const videostudioUnavailableReason = () => {
    if (app.videostudioUnavailableReason) return String(app.videostudioUnavailableReason);
    if (!videostudioEnabled()) return 'Tính năng tạo video đang bị tắt bằng cấu hình (IMAGELAB_ENABLED/VIDEOSTUDIO_ENABLED = false).';
    return 'Không nạp được pipeline tạo video MVP-04 — tính năng tạo video bị tắt. Chi tiết ở log máy chủ (videostudio.wiring_failed).';
  };

  const requireVideostudio = () => {
    if (!videostudioAvailable()) throw HttpError.safe(503, 'VIDEOSTUDIO_UNAVAILABLE', videostudioUnavailableReason());
  };

  const requireVideostudioMethod = (name) => {
    requireVideostudio();
    if (typeof app.videostudioPipeline?.[name] !== 'function') {
      throw HttpError.safe(503, 'VIDEOSTUDIO_UNAVAILABLE', `Pipeline tạo video thiếu phương thức "${name}" — tính năng chưa sẵn sàng.`);
    }
  };

  const requireVideostudioStoreMethod = (name) => {
    if (typeof store[name] !== 'function') {
      throw HttpError.safe(503, 'VIDEOSTUDIO_UNAVAILABLE', `Kho dữ liệu thiếu phương thức "${name}" — tính năng tạo video chưa sẵn sàng.`);
    }
  };

  /**
   * Thông tin bộ mã hoá — ĐÚNG ba field hợp đồng §2.2/§2.4 (`name`, `is_mock`, `configured`).
   * Nhận cả `isMock` (hợp đồng V2) và `is_mock` (bản đã chuyển) để không lệch tên field.
   */
  const videostudioEncoderInfo = () => {
    const enc = app.videoEncoder || app.videostudioPipeline?.encoder || null;
    return {
      name: enc?.name || 'none',
      is_mock: Boolean(enc?.isMock ?? enc?.is_mock),
      configured: Boolean(enc?.configured),
    };
  };
  const videostudioProviders = () => ({ encoder: videostudioEncoderInfo() });

  /**
   * Nạp module của V1 — nạp PHÒNG THỦ như MVP-02/03: module anh em có thể chưa tồn tại lúc
   * các agent chạy song song, và lỗi nạp KHÔNG được làm sập server. Thiếu ⇒ `null`, KHÔNG
   * bịa giá trị thay thế (danh sách preset giả sẽ khiến UI dựng ra video sai tỉ lệ).
   */
  const videostudioModules = new Map();
  const loadVideostudioModule = (specifier) => {
    if (!videostudioModules.has(specifier)) {
      videostudioModules.set(specifier, (async () => {
        try {
          return await import(specifier);
        } catch (err) {
          logger?.error?.('videostudio.module_load_failed', {
            module: specifier,
            error_name: err?.name || 'Error',
            error_code: err?.code || null,
            // Không đưa cả object lỗi vào log: message/stack của Node chứa đường dẫn tuyệt đối.
            error_message: String(err?.message || err).replace(/\/(?:Users|home|private|tmp|var|opt|mnt|Volumes)\/\S*/g, '<path>'),
          });
          return null;
        }
      })());
    }
    return videostudioModules.get(specifier);
  };

  /**
   * Nguồn preset THẬT: ưu tiên `VIDEO_PRESETS` của V1 (`src/videostudio/plan/index.js` — nguồn
   * ĐÓNG BĂNG của §2.1). Chỉ khi V1 chưa nạp được mới dùng `app.videostudioPresets` do tầng gộp
   * bơm vào — đó là đường để test/gộp chạy được TRƯỚC khi V1 có mặt, KHÔNG phải bản chép luật
   * trong file này. Không có nguồn nào ⇒ `null` (route báo 503, không bịa danh sách).
   */
  const videostudioPresets = async () => {
    const mod = await loadVideostudioModule('../videostudio/plan/index.js');
    if (Array.isArray(mod?.VIDEO_PRESETS) && mod.VIDEO_PRESETS.length > 0) return mod.VIDEO_PRESETS;
    const injected = app.videostudioPresets;
    if (Array.isArray(injected) && injected.length > 0) return injected;
    return null;
  };

  const requireVideostudioPresets = async () => {
    const presets = await videostudioPresets();
    if (!presets) throw HttpError.safe(503, 'VIDEOSTUDIO_UNAVAILABLE', VIDEOSTUDIO_MODULE_MESSAGE);
    return presets;
  };

  /**
   * Trần đầu vào của MVP-04 (§2.4 `limits`): dùng chung trần ảnh MVP-02/MVP-03 trừ khi V3
   * khai riêng trong `config.videostudio`. `max_seconds` lấy từ cấu hình; thiếu thì lấy trần
   * CAO NHẤT trong preset THẬT của V1 — KHÔNG bịa một con số mặc định (30 giây là số của
   * preset, không phải của route).
   */
  const videostudioLimits = (presets = null) => {
    const configured = Number(config.videostudio?.maxSeconds);
    let seconds = Number.isFinite(configured) && configured > 0 ? configured : null;
    if (seconds === null && Array.isArray(presets)) {
      const list = presets.map((p) => Number(p?.max_seconds)).filter((n) => Number.isFinite(n) && n > 0);
      if (list.length > 0) seconds = Math.max(...list);
    }
    return {
      max_image_bytes: config.videostudio?.maxImageBytes ?? config.imagelab?.maxImageBytes ?? config.net.maxUploadBytes,
      max_pixels: config.videostudio?.maxPixels ?? config.imagelab?.maxPixels ?? DEFAULT_MAX_PIXELS,
      max_seconds: seconds,
      // §2.5: UI cần biết trần số cảnh để chặn TRƯỚC khi gửi (trước đây V5 phải đoán).
      max_scenes: VIDEOSTUDIO_MAX_SCENES,
    };
  };

  /** Trần để GIẢI MÃ ảnh đầu vào — thêm danh sách MIME cho phép (dùng chung với MVP-02). */
  const videostudioImageLimits = (presets = null) => ({
    ...videostudioLimits(presets),
    allowed_image_mime: config.net.allowedImageMime || [],
  });

  /** Quyền sở hữu job: job của tài khoản/session khác trả 404 y như job không tồn tại (§2.4). */
  const requireVideostudioJob = async (id, sid, req = null) => {
    requireVideostudio();
    if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_JOB_ID', 'Mã job không hợp lệ.');
    const job = await store.getJob(id);
    if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'Không tìm thấy job.');
    // MVP-05: job của TÀI KHOẢN khác ⇒ 404 (không xác nhận sự tồn tại).
    if (assertAccountOwnership(job, req)) return job;
    if (job.session_id !== sid) throw new HttpError(404, 'JOB_NOT_FOUND', 'Không tìm thấy job.');
    return job;
  };

  /** Quyền sở hữu TỆP theo session/tài khoản — cùng luật với `requireImagestudioAsset`. */
  const requireVideostudioAsset = async (id, sid, req = null) => {
    requireVideostudio();
    requireVideostudioStoreMethod('getImageAsset');
    if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_ASSET_ID', 'Mã tệp không hợp lệ.');
    const asset = await store.getImageAsset(id);
    if (!asset) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy tệp video.');

    const ownerJob = asset.job_id ? await store.getJob(asset.job_id) : null;

    // (1) MVP-05 — tệp HOẶC job sở hữu gắn `user_id`: chỉ chủ đọc được.
    const accountOwner = asset.user_id ?? ownerJob?.user_id ?? null;
    if (accountOwner !== null && accountOwner !== undefined && accountOwner !== '') {
      if (String(req?.user?.id ?? '') !== String(accountOwner)) {
        throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy tệp video.');
      }
      return asset;
    }

    // (2) Tệp ẩn danh: giữ nguyên luật theo `session_id`; tắt ẩn danh ⇒ không phục vụ.
    if (!anonymousAllowed()) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy tệp video.');
    if (asset.session_id) {
      if (asset.session_id !== sid) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy tệp video.');
    } else if (asset.job_id) {
      if (!ownerJob || ownerJob.session_id !== sid) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy tệp video.');
    } else {
      // Không xác định được chủ sở hữu → fail-closed, không trả dữ liệu.
      throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy tệp video.');
    }
    return asset;
  };

  /**
   * "Bằng chứng" của job video (§0 luật 3) — GOM ĐÚNG như `#evidenceText` của V3 để route và
   * pipeline không bao giờ phán hai kết luận khác nhau:
   *   · `jobs.product_name`;
   *   · vùng chữ trong DB (`store.listOcrRegions`) — gồm vùng do NGƯỜI DÙNG nhập tay;
   *   · ghi chú ĐÃ LƯU trong `content_meta` (`notes`/`note`/`user_note`/`source_text`).
   *
   * TUYỆT ĐỐI không lấy chữ người dùng vừa gửi trong request làm bằng chứng (bài học "bằng
   * chứng vòng" của MVP-03: chữ tự khai không chứng minh chính nó). Job chưa tồn tại ⇒ bằng
   * chứng RỖNG ⇒ mọi khẳng định/số liệu bị chặn.
   */
  const collectVideostudioEvidence = async (job) => {
    // Một giá trị bằng chứng có thể là chuỗi, mảng chuỗi hoặc object có `text` — đọc cả ba.
    const textFrom = (value) => {
      if (typeof value === 'string') return value.trim();
      if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join('\n');
      if (value && typeof value === 'object' && typeof value.text === 'string') return value.text.trim();
      return '';
    };

    const parts = [];
    const productName = String(job?.product_name ?? '').trim();
    if (productName) parts.push(productName);

    if (job?.id && typeof store.listOcrRegions === 'function') {
      try {
        for (const region of asArray(await store.listOcrRegions(job.id))) {
          const text = String(region?.text ?? region?.text_original ?? '').trim();
          if (text) parts.push(text);
        }
      } catch (err) {
        logger?.warn?.('videostudio.evidence_failed', {
          job_id: job.id,
          error_name: err?.name || 'Error',
          error_code: err?.code || null,
        });
      }
    }

    const meta = job?.content_meta && typeof job.content_meta === 'object' ? job.content_meta : {};
    for (const holder of [meta.videostudio, meta.imagelab, meta.imagestudio]) {
      if (!holder || typeof holder !== 'object') continue;
      for (const key of VIDEOSTUDIO_EVIDENCE_KEYS) {
        const text = textFrom(holder[key]);
        if (text) parts.push(text);
      }
    }
    return parts.join('\n');
  };

  /** Bộ kiểm khẳng định của V1 (`collectClaimViolations` — §2.1) — nạp phòng thủ, chưa có ⇒ `null`. */
  const loadVideostudioClaimCollector = async () => {
    const plan = await loadVideostudioModule('../videostudio/plan/index.js');
    if (typeof plan?.collectClaimViolations === 'function') return plan.collectClaimViolations;
    const claims = await loadVideostudioModule('../videostudio/plan/claims.js');
    return typeof claims?.collectClaimViolations === 'function' ? claims.collectClaimViolations : null;
  };

  /**
   * Bộ kiểm DỰ PHÒNG của V3 (`fallbackViolations` trong `src/videostudio/pipeline.js`).
   *
   * F7 (phản biện MVP-04): preflight ở route chỉ dùng bộ của V1 — mà bộ V1 **hẹp hơn** bộ dự phòng
   * của V3 (13/19 từ khoá như “giá rẻ nhất”, “miễn phí”, “nguyên seal” chỉ có ở V3). Hệ quả trước đây:
   * route trả **202** rồi job mới `failed` ⇒ người dùng chờ vô ích. Nay route dùng **cùng** hai bộ mà
   * pipeline dùng (hợp + khử trùng) ⇒ 422 NGAY, không còn đường "202 rồi failed".
   */
  const loadVideostudioFallbackViolations = async () => {
    for (const spec of ['../videostudio/pipeline.js', '../videostudio/pipeline']) {
      const mod = await loadVideostudioModule(spec);
      if (typeof mod?.fallbackViolations === 'function') return mod.fallbackViolations;
    }
    return null;
  };

  /**
   * Gọi bộ kiểm khẳng định của V1 cho TỪNG đoạn chữ (chữ ký ĐÓNG BĂNG của
   * `src/videostudio/plan/claims.js`: `collectClaimViolations(text, { evidence })`).
   *
   * Nếu vì lý do nào đó lời gọi hỏng ở MỌI câu (chữ ký đổi ở bản V1 khác), hàm trả `null` =
   * "không kiểm được" để tầng gọi quyết định — TUYỆT ĐỐI không đoán thành "đạt" (fail-closed
   * thuộc về V1/V3, nơi luôn kiểm lại trước khi vẽ).
   */
  const callClaimCollector = (fn, { evidence, texts }) => {
    const out = [];
    let answered = 0;
    for (const text of texts) {
      try {
        out.push(...asArray(fn(text, { evidence })));
        answered += 1;
      } catch {
        /* câu này không gọi được ⇒ thử câu kế tiếp */
      }
    }
    return answered > 0 ? out : null;
  };

  /**
   * Mọi đoạn chữ sẽ được VẼ lên video: `options` + `options.scenes[]`, đúng các khoá mà V3 gom
   * để đưa cho V1 (`TEXT_KEYS` của `videostudio/pipeline.js`) — nhờ vậy thứ được KIỂM và thứ
   * được VẼ là MỘT danh sách, không lệch.
   */
  /**
   * Mọi đoạn chữ SẼ ĐƯỢC VẼ theo cách V1 đọc (`readTextValue` của `plan/texts.js`):
   * `string` | `number` | `{ text | content | label | value }` — kể cả `scene.texts` dạng MẢNG
   * các object đó.
   *
   * ⚠️ F7 (phản biện MVP-04, MINOR): trước đây chỉ đọc `item.text` ⇒ `{content}`, `{label}`,
   * `{value}` và số LỌT qua preflight (route trả 202) rồi mới chết ở pipeline (`failed`) — người
   * dùng trả giá bằng một job + một lượt chạy chỉ để nhận lỗi muộn. Nay đọc ĐÚNG bộ khoá của V1.
   */
  const VIDEOSTUDIO_TEXT_VALUE_KEYS = Object.freeze(['text', 'content', 'label', 'value']);
  /**
   * Gom MỌI đoạn chữ trong một mục — KHÔNG chỉ khoá đầu tiên.
   *
   * N1/N3 (phản biện MVP-04 vòng 2): bản cũ trả về **một** giá trị (khoá đầu tiên tìm thấy) nên
   * `{ text: 'ok', label: 'miễn phí vận chuyển' }` hay `[[ 'miễn phí' ]]` (mảng lồng) **lọt** kiểm
   * tra sớm rồi vẫn được VẼ. Nay duyệt **đệ quy**: mọi khoá chữ, mọi mảng, mọi object lồng — khớp
   * đúng cách V1/V3 gom chữ để kiểm, nên "thứ bị kiểm" == "thứ được vẽ".
   */
  const videostudioTextValueOf = (item, out = []) => {
    if (typeof item === 'string') {
      if (item.trim()) out.push(item.trim());
      return out;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      out.push(String(item));
      return out;
    }
    if (Array.isArray(item)) {
      for (const entry of item) videostudioTextValueOf(entry, out);
      return out;
    }
    if (item && typeof item === 'object') {
      for (const key of VIDEOSTUDIO_TEXT_VALUE_KEYS) {
        if (item[key] === undefined || item[key] === null) continue;
        videostudioTextValueOf(item[key], out);
      }
      return out;
    }
    // Giá trị không phải string/số/mảng/object chữ (vd object lồng sâu) ⇒ KHÔNG dùng: trước đây bị
    // `sanitizeText` biến thành "[object Object]" rồi VẼ LÊN VIDEO (17.400 px — phản biện vòng 4).
    return out;
  };

  /** Trần độ dài chữ: ưu tiên hằng CỦA V1 (`VIDEOSTUDIO_TEXT_MAX`), fallback cùng giá trị. */
  const videostudioTextMax = async () => {
    try {
      const mod = await loadVideostudioModule('../videostudio/plan/texts.js');
      const value = Number(mod?.VIDEOSTUDIO_TEXT_MAX);
      if (Number.isFinite(value) && value > 0) return Math.trunc(value);
    } catch {
      /* V1 chưa nạp được ⇒ dùng giá trị dự phòng (không chặn đường) */
    }
    return VIDEOSTUDIO_TEXT_MAX;
  };

  const videostudioTextsOf = (options) => {
    const out = [];
    const push = (source) => {
      if (!source || typeof source !== 'object') return;
      for (const key of VIDEOSTUDIO_TEXT_KEYS) {
        const value = source[key];
        if (value === undefined || value === null) continue;
        for (const item of Array.isArray(value) ? value : [value]) {
          for (const text of videostudioTextValueOf(item)) out.push(text);
        }
      }
    };
    push(options);
    for (const scene of asArray(options?.scenes)) push(scene);
    return [...new Set(out)];
  };

  /**
   * Kiểm chữ TRƯỚC khi xếp hàng (§0 luật 3 + §2.5): trả 422 ngay thay vì 202 rồi người dùng
   * ngồi chờ một video không bao giờ có chữ.
   *
   * Đây KHÔNG phải hàng rào duy nhất: V1/V3 vẫn kiểm lại lúc dựng kế hoạch và ném
   * `VIDEO_TEXT_UNSUPPORTED_CLAIM` — route chỉ chuyển kết quả kiểm thành mã HTTP đúng hợp đồng.
   * Không nạp được bộ kiểm của V1 ⇒ BỎ QUA bước kiểm sớm (có log) và để V1/V3 phán quyết: route
   * cố ý KHÔNG chép luật chống bịa của module khác vào đây (bản sao luật là thứ dễ lệch nhất).
   *
   * @returns {Promise<{code:string,message:string,violations:string[]}|null>} null = không có gì bị chặn
   */
  const preflightVideostudioTexts = async (job, options) => {
    const texts = videostudioTextsOf(options);
    if (texts.length === 0) return null; // không có chữ ⇒ không có gì để chặn

    const collector = await loadVideostudioClaimCollector();
    if (!collector) {
      logger?.warn?.('videostudio.text_check_skipped', { reason: 'chưa nạp được collectClaimViolations của V1' });
      return null;
    }

    const evidence = await collectVideostudioEvidence(job);
    const violations = callClaimCollector(collector, { evidence, texts });

    // F7: hợp thêm bộ dự phòng của V3 (pipeline) — nếu thiếu, preflight sẽ hẹp hơn hàng rào thật.
    const evidenceText = typeof evidence === 'string' ? evidence : '';
    const fallback = await loadVideostudioFallbackViolations();
    let fallbackList = [];
    if (fallback) {
      try {
        fallbackList = asArray(fallback(texts, evidenceText)).map(violationText).filter(Boolean);
      } catch (err) {
        logger?.warn?.('videostudio.text_check_fallback_failed', { error_name: err?.name || 'Error' });
      }
    } else {
      logger?.warn?.('videostudio.text_check_fallback_missing', { reason: 'chưa nạp được fallbackViolations của V3' });
    }

    if (violations === null && fallbackList.length === 0) {
      logger?.warn?.('videostudio.text_check_unreadable', { reason: 'collectClaimViolations không trả lời được cho đoạn chữ nào' });
      return null;
    }
    const list = [...new Set([...(violations ?? []).map(violationText), ...fallbackList].filter(Boolean))];
    if (list.length === 0) return null;

    const shown = texts.join(' · ');
    const trimmed = shown.length > 120 ? `${shown.slice(0, 120)}…` : shown;
    return {
      code: 'VIDEO_TEXT_UNSUPPORTED_CLAIM',
      message: `Chữ trên video “${trimmed}” chứa khẳng định/số liệu không có bằng chứng trong dữ liệu đã lưu của job — KHÔNG vẽ (mục 0 luật 3).`,
      violations: list,
    };
  };

  /** Đánh dấu job hỏng (best-effort) — không để job treo 'queued' khi ingest ném lỗi. */
  const markVideostudioJobFailed = async (jobId, err) => {
    if (typeof store.updateJob !== 'function') return;
    try {
      await store.updateJob(jobId, {
        status: JOB_STATUS.FAILED,
        stage: 'failed',
        error_code: err?.code || 'VIDEOSTUDIO_INGEST_FAILED',
        error_message: scrubPaths(String(err?.message || 'Không lưu được ảnh tải lên.')),
        finished_at: new Date().toISOString(),
      });
    } catch (inner) {
      logger?.warn?.('videostudio.fail_mark_failed', { job_id: jobId, error_name: inner?.name || 'Error' });
    }
  };

  /* ══════════════ MVP-05 · Tài khoản + Ví credit (hợp đồng §3.3) ══════════════ */

  /* ── Khoá cấu hình (§2.3 — A1 sở hữu `config.auth`, A2 sở hữu `config.billing`) ──
   * Đọc PHÒNG THỦ: hai khối này có thể chưa có mặt khi các agent chạy song song. Thiếu
   * khoá ⇒ mặc định TƯƠNG THÍCH NGƯỢC (bật + cho phép ẩn danh) để luật #1 luôn đúng:
   * mọi test MVP-01/02/03 hiện có phải tiếp tục xanh.
   */
  const authConfig = () => (config?.auth && typeof config.auth === 'object' ? config.auth : {});
  const billingConfig = () => (config?.billing && typeof config.billing === 'object' ? config.billing : {});
  const authEnabled = () => authConfig().enabled !== false;
  const anonymousAllowed = () => authConfig().anonymousAllowed !== false;
  const billingEnabled = () => billingConfig().enabled !== false;
  const passwordMinLength = () => {
    const n = Number(authConfig().passwordMinLength);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 10;
  };
  const sessionDays = () => {
    const n = Number(authConfig().sessionDays);
    return Number.isFinite(n) && n > 0 ? n : 30;
  };
  /** Tên cookie xác thực — chỉ nhận tên hợp lệ (không cho cấu hình chèn header lạ). */
  const authCookieName = () => {
    const raw = String(authConfig().cookieName || 'vauth').trim();
    return /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : 'vauth';
  };
  const creditCurrency = () => String(billingConfig().currency || config?.cost?.currency || 'USD');

  /** Dịch vụ A1/A3 bơm vào `app`; `null` khi chưa nạp được ⇒ hệ thống chạy như MVP-01/02/03. */
  const accountService = () =>
    app?.accountService && typeof app.accountService.authenticate === 'function' ? app.accountService : null;
  const walletService = () => (app?.billingService && typeof app.billingService === 'object' ? app.billingService : null);
  const accountsAvailable = () => Boolean(accountService());
  const billingAvailable = () => Boolean(walletService()) && billingEnabled();

  const AUTH_DISABLED_MESSAGE = 'Tính năng tài khoản đang bị tắt bằng cấu hình (AUTH_ENABLED=false).';
  const AUTH_UNAVAILABLE_MESSAGE = 'Dịch vụ tài khoản chưa nạp được trên máy chủ này — tạm thời chưa đăng nhập/đăng ký được.';
  const BILLING_UNAVAILABLE_MESSAGE = 'Ví credit chưa nạp được trên máy chủ này — tính năng ví tạm thời không dùng được.';
  /** Câu DUY NHẤT cho mọi ca sai thông tin đăng nhập (không tiết lộ email có tồn tại hay không). */
  const BAD_CREDENTIALS_MESSAGE = 'Email hoặc mật khẩu không đúng.';

  /** `/api/auth/*` khi AUTH_ENABLED=false ⇒ 503 AUTH_DISABLED (hợp đồng §3.3). */
  const requireAuthFeature = () => {
    if (!authEnabled()) throw HttpError.safe(503, 'AUTH_DISABLED', AUTH_DISABLED_MESSAGE);
    const svc = accountService();
    if (!svc) throw HttpError.safe(503, 'AUTH_UNAVAILABLE', AUTH_UNAVAILABLE_MESSAGE);
    return svc;
  };

  /** Ví: chưa nạp được hoặc bị tắt ⇒ 503 nói thẳng, KHÔNG trả số dư 0 giả. */
  const requireWallet = () => {
    if (!billingEnabled()) {
      throw HttpError.safe(503, 'BILLING_UNAVAILABLE', 'Tính năng ví credit đang bị tắt bằng cấu hình (BILLING_ENABLED=false).');
    }
    const svc = walletService();
    if (!svc) throw HttpError.safe(503, 'BILLING_UNAVAILABLE', BILLING_UNAVAILABLE_MESSAGE);
    return svc;
  };

  /** Chưa đăng nhập ⇒ 401 (khác MVP-02: ở đây đã có xác thực thật). */
  const requireUser = (req) => {
    if (!req?.user) throw HttpError.safe(401, 'UNAUTHENTICATED', 'Bạn cần đăng nhập để dùng tính năng này.');
    return req.user;
  };

  /** Chưa đăng nhập ⇒ 401; đã đăng nhập nhưng role `member` ⇒ 403 FORBIDDEN. */
  const requireAdmin = (req) => {
    const user = requireUser(req);
    if (!ADMIN_ROLES.has(String(user?.role || 'member'))) {
      throw HttpError.safe(403, 'FORBIDDEN', 'Chỉ quản trị viên (owner/admin) được dùng chức năng này.');
    }
    return user;
  };

  /**
   * Đọc token THÔ từ cookie `vauth` (tên lấy từ `config.auth.cookieName`).
   * Token rác/sai hình dạng ⇒ `null` (coi như khách ẩn danh) — KHÔNG ném lỗi, KHÔNG log token.
   * `parseCookies` có thể ném URIError với cookie mã hoá hỏng nên phải bọc lại: một cookie
   * hỏng của client KHÔNG được biến mọi request thành HTTP 500.
   */
  const authTokenFromRequest = (req) => {
    let cookies = {};
    try {
      cookies = parseCookies(req?.headers?.cookie || '');
    } catch {
      return null;
    }
    const raw = cookies[authCookieName()];
    // Token do A1 sinh: 32 byte ngẫu nhiên → base64url. Chỉ nhận hình dạng hợp lệ.
    return typeof raw === 'string' && /^[A-Za-z0-9_-]{8,256}$/.test(raw) ? raw : null;
  };

  /**
   * Middleware `attachUser` — gắn `req.user` từ cookie, KHÔNG BAO GIỜ ném lỗi:
   * token rác/hết hạn/đã thu hồi/DB lỗi đều ⇒ khách ẩn danh (`req.user = null`).
   * Không log token (chỉ log tên lỗi). Chạy đúng MỘT lần cho mỗi request.
   */
  const attachUser = async (req) => {
    if (!req) return null;
    if (req.userAttached === true) return req.user ?? null;
    req.userAttached = true;
    req.user = null;

    const token = authTokenFromRequest(req);
    const svc = accountService();
    if (!token || !svc) return null;

    try {
      const user = await svc.authenticate(token);
      if (user && typeof user === 'object') req.user = user;
    } catch (err) {
      // Hết hạn/thu hồi/token rác là chuyện THƯỜNG GẶP → mức warn, không kèm token.
      logger?.warn?.('auth.authenticate_failed', {
        error_name: err?.name || 'Error',
        error_code: err?.code || null,
      });
    }
    return req.user ?? null;
  };

  /** Ghi thêm Set-Cookie mà không đè cookie khác (vd `sid`) đã đặt trước đó. */
  const appendSetCookie = (res, cookie) => {
    const prev = res.getHeader?.('set-cookie');
    const list = prev === undefined ? [] : Array.isArray(prev) ? prev.slice() : [String(prev)];
    list.push(cookie);
    res.setHeader('set-cookie', list);
  };

  const expiryMs = (value) => {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const t = Date.parse(value.trim());
      return Number.isFinite(t) ? t : null;
    }
    return null;
  };

  /** Cookie phiên đăng nhập (§3.1): HttpOnly + SameSite=Lax + Path=/ + Max-Age theo `expiresAt`. */
  const authCookie = (token, expiresAt) => {
    const ms = expiryMs(expiresAt);
    const maxAge = ms === null ? sessionDays() * 86400 : Math.max(0, Math.floor((ms - Date.now()) / 1000));
    const parts = [`${authCookieName()}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
    if (authConfig().secureCookie === true) parts.push('Secure');
    return parts.join('; ');
  };

  /** Đăng xuất: cookie rỗng + Max-Age=0 (không xoá cookie `sid` của phiên ẩn danh). */
  const clearedAuthCookie = () => {
    const parts = [`${authCookieName()}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (authConfig().secureCookie === true) parts.push('Secure');
    return parts.join('; ');
  };

  /** Body của `/api/auth/*`: object JSON phẳng, tối đa 32KB; sai hình dạng ⇒ 400 BAD_BODY. */
  const readAuthBody = async (req) => {
    const body = await readJson(req, { maxBytes: 32 * 1024 });
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw HttpError.safe(400, 'BAD_BODY', 'Body phải là một object JSON.');
    }
    return body;
  };

  /** Số dư ví của một user — `null` khi không có dịch vụ ví (KHÔNG bịa số 0). */
  const readBalance = async (userId) => {
    const svc = walletService();
    if (!svc || typeof svc.balance !== 'function' || !userId) return null;
    try {
      const b = await svc.balance(userId);
      if (b === null || b === undefined) return null;
      const amount = Number(b.amount);
      if (!Number.isFinite(amount)) return null;
      return { amount, currency: String(b.currency || creditCurrency()) };
    } catch (err) {
      logger?.warn?.('billing.balance_failed', { error_name: err?.name || 'Error', error_code: err?.code || null });
      return null;
    }
  };

  const balanceJson = (b) =>
    b && Number.isFinite(Number(b.amount)) ? { amount: Number(b.amount), currency: String(b.currency || creditCurrency()) } : null;

  /**
   * Tìm user theo id cho route quản trị: ưu tiên A1 (`getById`, đã lọc `password_hash`),
   * thiếu thì đọc thẳng store (A3). Không tìm thấy ⇒ `null` (route trả 404).
   */
  const findUserById = async (id) => {
    if (!id || !UUID_RE.test(String(id))) return null;
    const svc = accountService();
    if (svc && typeof svc.getById === 'function') {
      try {
        const u = await svc.getById(id);
        if (u) return u;
      } catch (err) {
        logger?.warn?.('auth.get_by_id_failed', { error_name: err?.name || 'Error', error_code: err?.code || null });
      }
    }
    if (typeof store.getUserById === 'function') {
      try {
        return (await store.getUserById(id)) || null;
      } catch {
        return null;
      }
    }
    return null;
  };

  /* ── Cổng giữ tiền TRƯỚC khi job chạy (§0 luật 2 + §4) ──
   * A4 KHÔNG chép luật giá của A2/A3 (bản sao luật là thứ dễ lệch nhất):
   *  - A3 bơm hook `app.billingHook.beforeJob({ userId, jobId, kind, sessionId })` (hoặc
   *    `app.billingService.beforeJob`) ⇒ route gọi đúng hook đó; hook ném
   *    `INSUFFICIENT_CREDIT` kèm `details { required, balance }` ⇒ route trả 402.
   *  - CHƯA có hook: chỉ kiểm điều kiện CẦN, không đoán đơn giá — số dư ≤ 0 thì không tài
   *    nào trả được job (mọi đơn giá đều > 0) ⇒ 402 sớm, KHÔNG tạo job nào.
   * Ẩn danh (`req.user` null) ⇒ bỏ qua hoàn toàn: không ví, không trừ credit (§2.2).
   */
  const billingHook = () =>
    app?.billingHook && typeof app.billingHook.beforeJob === 'function' ? app.billingHook : null;

  /** Điều kiện CẦN (số dư ≤ 0) — chỉ dùng khi A3 CHƯA bơm hook giữ tiền (§3.4b). */
  const assertWalletNotEmpty = async (req) => {
    if (!req?.user || !billingEnabled() || billingHook()) return;
    // Mọi đơn giá đều 0 (chế độ miễn phí) ⇒ không có gì để chặn.
    const costs = Object.values(config?.cost || {}).map(Number).filter(Number.isFinite);
    if (!(costs.length > 0 && costs.some((c) => c > 0))) return;
    const balance = await readBalance(req.user.id);
    if (balance && balance.amount <= 0) {
      throw HttpError.safe(402, 'INSUFFICIENT_CREDIT', insufficientCreditMessage(null, balance.amount), {
        required: null,
        balance: balance.amount,
        currency: balance.currency,
      });
    }
  };

  /**
   * Cổng ví chạy NGAY TRONG REQUEST, TRƯỚC khi ghi bất cứ thứ gì vào DB (§0 luật 2 + §3.4b).
   *
   * Đây là đường DUY NHẤT để lỗi thiếu credit ra tới HTTP: job đã vào hàng đợi thì lỗi chỉ
   * còn là job `failed`, tức là người dùng đã chờ rồi mới biết thiếu tiền.
   *
   * `app.billingHook.beforeJob` là hợp đồng ĐÓNG BĂNG của A3 (object hằng trên `app`, luôn
   * tồn tại): tự bỏ qua khi ẩn danh, tự trả `{held: 0}` khi chưa có ví, IDEMPOTENT theo jobId.
   * A4 KHÔNG chép luật giá — chỉ gọi hook và ánh xạ lỗi.
   */
  /* ── PB-08: chống brute-force đăng nhập theo CẶP (email chuẩn hoá, IP) ────────────────
   * Chỉ đếm lần THẤT BẠI; đăng nhập đúng xoá bộ đếm ⇒ không bao giờ tự khoá đường vào hợp lệ.
   * Cửa sổ 5 phút / 10 lần sai cho mỗi cặp; vượt ⇒ 429 kèm `Retry-After`.
   * ⚠️ `clientKey(req)` lấy IP từ socket/`x-forwarded-for`; sau reverse proxy PHẢI bật
   * `trust proxy` của tầng chạy (hoặc `ALLOW_PRIVATE_NETWORK` + header đúng) — xem
   * `docs/SECURITY.md`. Nếu không, mọi khách chung một IP và bucket theo IP mất tác dụng.
   */
  const LOGIN_WINDOW_MS = 5 * 60 * 1000;
  const LOGIN_MAX_FAILURES = 10;   // trần cho một CẶP (email, IP)
  const LOGIN_IP_MAX_FAILURES = 60; // BR-04: trần RỘNG theo IP — chặn "spraying" qua nhiều email
  const loginFailures = new Map(); // key → { count, firstAt }

  const normalizeEmailLike = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');

  const checkLoginAttempts = (key, max = LOGIN_MAX_FAILURES) => {
    const now = Date.now();
    const entry = loginFailures.get(key);
    if (!entry) return { blocked: false, retryAfterSec: 0 };
    if (now - entry.firstAt > LOGIN_WINDOW_MS) {
      loginFailures.delete(key);
      return { blocked: false, retryAfterSec: 0 };
    }
    if (entry.count < max) return { blocked: false, retryAfterSec: 0 };
    return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((entry.firstAt + LOGIN_WINDOW_MS - now) / 1000)) };
  };

  const registerLoginFailure = (key, max = LOGIN_MAX_FAILURES) => {
    const now = Date.now();
    const entry = loginFailures.get(key);
    if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
      loginFailures.set(key, { count: 1, firstAt: now });
    } else {
      entry.count += 1;
    }
    // Trần bộ nhớ: dọn các mục đã hết hạn khi map phình ra (không để rò rỉ bộ nhớ).
    if (loginFailures.size > 5000) {
      for (const [k, v] of loginFailures) if (now - v.firstAt > LOGIN_WINDOW_MS) loginFailures.delete(k);
    }
    return checkLoginAttempts(key, max);
  };

  const clearLoginFailures = (key) => {
    loginFailures.delete(key);
  };

  /**
   * PB-05 — tặng credit khi đăng ký theo `config.billing.defaultGrant` (0 = không tặng).
   * Lỗi ví KHÔNG được làm hỏng việc đăng ký: tài khoản đã tạo xong rồi — chỉ ghi log.
   */
  const grantDefaultOnRegister = async (user) => {
    const rawGrant = Number(config?.billing?.defaultGrant);
    const amount = Number.isFinite(rawGrant) && rawGrant > 0 ? rawGrant : 0;
    const userId = user?.id;
    if (!userId || !(amount > 0)) return null;
    const service = app?.billingService;
    if (!service || typeof service.grant !== 'function') {
      logger?.warn?.('billing.default_grant_skipped', { reason: 'không có billingService', user_id: userId, amount });
      return null;
    }
    try {
      const row = await service.grant({ userId, amount, reason: 'grant', note: 'credit tặng khi đăng ký' });
      logger?.info?.('billing.default_grant', { user_id: userId, amount });
      return { amount: Number(row?.amount ?? amount), currency: String(row?.currency || config?.billing?.currency || 'USD') };
    } catch (err) {
      logger?.warn?.('billing.default_grant_failed', {
        user_id: userId,
        amount,
        error_name: err?.name || 'Error',
        error_code: err?.code || null,
      });
      return null;
    }
  };

  /**
   * PB-01 (vòng 2) — chạy phần việc NẰM SAU `holdCreditBeforeJob` và GIẢI PHÓNG khoản giữ nếu
   * có bất kỳ lỗi nào. Trước đây chỉ `POST /api/jobs` gọi `releaseHoldOnFailure`; các route
   * khác để tiền bị giữ vĩnh viễn cho một request trả 4xx (đo được: 5 × 409 ⇒ mất 0,0415 credit,
   * sổ chỉ có `job_hold`).
   *
   * `releaseHoldOnFailure` chỉ chạy khi ĐÃ giữ tiền (`hold.held > 0`) và tự bỏ qua ẩn danh.
   *
   * @template T
   * @param {object} req
   * @param {string} jobId
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  const withHoldRelease = async (req, jobId, hold, fn) => {
    try {
      return await fn();
    } catch (err) {
      if (hold && Number(hold.held) > 0) await releaseHoldOnFailure(req, jobId);
      throw err;
    }
  };

  /**
   * BR-06 (vòng 3) — đánh dấu job ImageLab `failed` khi `ingest` lỗi SAU khi job đã được tạo.
   * Trước đây tiền được hoàn đúng nhưng job **treo `running` vĩnh viễn** (không có entry hàng
   * đợi, không ai đánh dấu) ⇒ rác trong UI.
   */
  const markImagelabJobFailed = async (jobId, err) => {
    if (typeof store.updateJob !== 'function') return;
    try {
      await store.updateJob(jobId, {
        status: JOB_STATUS.FAILED,
        stage: 'failed',
        error_code: err?.code || 'IMAGELAB_INGEST_FAILED',
        error_message: scrubPaths(String(err?.message || 'Không lưu được ảnh tải lên.')),
        finished_at: new Date().toISOString(),
      });
    } catch (inner) {
      logger?.warn?.('imagelab.fail_mark_failed', { job_id: jobId, error_name: inner?.name || 'Error' });
    }
  };

  /**
   * BR-08 — thu hồi các lượt TREO (chỉ những lượt cũ hơn `config.billing.stuckRunMs`).
   * Trả về SỐ lượt đã thu hồi; nuốt lỗi (đây là đường phục hồi, không được làm hỏng request).
   */
  const reconcileStuckRunsFor = async (req, { userId = null, force = false } = {}) => {
    const runner = typeof app?.reconcileStuckRuns === 'function'
      ? app.reconcileStuckRuns
      : (app?.billingService && typeof app.billingService.reconcileStuckRuns === 'function'
        ? app.billingService.reconcileStuckRuns.bind(app.billingService)
        : null);
    if (!runner || !billingEnabled()) return 0;
    try {
      // `app.reconcileStuckRuns` đã bơm `isJobActive` (hàng đợi + trạng thái job) ⇒ KHÔNG cắt ngang
      // lượt đang chạy thật (BR-10).
      const res = await runner({ userId: userId || req?.user?.id || null, force });
      const n = Number(res?.reconciled) || 0;
      if (n > 0) logger?.warn?.('billing.stuck_runs_reconciled', { reconciled: n, refunded: res?.refunded ?? 0 });
      return n;
    } catch (err) {
      logger?.warn?.('billing.reconcile_failed', { error_name: err?.name || 'Error', error_code: err?.code || null });
      return 0;
    }
  };

  const holdCreditBeforeJob = async (req, jobId, kind) => {
    const userId = req?.user?.id ?? null;
    if (!userId || !billingEnabled()) return null; // ẩn danh: không ví, không trừ credit (§2.2)
    const hook = billingHook();
    if (hook) {
      try {
        let result = (await hook.beforeJob({ userId, jobId, kind, sessionId: presentedSessionId(req) })) ?? null;
        // BR-08 (vòng 4): nếu lượt "đang mở" thực ra đã TREO (quá `billing.stuckRunMs`) thì THU HỒI
        // (hoàn 100% khoản giữ + đóng lượt) rồi cho chạy tiếp — thay vì 409 vĩnh viễn.
        if (result?.skipped === true) {
          const reconciled = await reconcileStuckRunsFor(req, { userId });
          if (reconciled > 0) {
            result = (await hook.beforeJob({ userId, jobId, kind, sessionId: presentedSessionId(req) })) ?? null;
          }
        }
        // BR-02 (vòng 3): lượt chạy của job này ĐANG MỞ (và còn MỚI) ⇒ request thứ hai KHÔNG được
        // dùng chung khoản giữ rồi chạy thật (K lượt chạy / 1 lượt bị thu). Chặn rõ ràng bằng 409.
        if (result?.skipped === true && result?.hold_disabled !== true) {
          throw HttpError.safe(409, 'JOB_ALREADY_RUNNING', 'Job này đang chạy một lượt khác — chờ lượt đó xong rồi hãy chạy lại.', {
            job_id: jobId,
            run_key: result?.run_key ?? null,
          });
        }
        if (result?.skipped === true && result?.hold_disabled === true) {
          // Chế độ không giữ tiền trước: lượt treo cũng phải được thu hồi rồi mở lượt mới.
          const reconciled = await reconcileStuckRunsFor(req, { userId });
          if (reconciled > 0) result = (await hook.beforeJob({ userId, jobId, kind, sessionId: presentedSessionId(req) })) ?? null;
        }
        return result;
      } catch (err) {
        // Thiếu tiền ⇒ 402 (mapBillingError); lỗi khác ⇒ fail-closed, báo lỗi thật.
        throw mapBillingError(err) || err;
      }
    }
    await assertWalletNotEmpty(req);
    return null;
  };

  /**
   * Ghi DB thất bại SAU khi hook đã giữ tiền ⇒ hoàn ngay phần đã giữ: không được để tiền
   * của người dùng bị giữ cho một job không hề tồn tại (best-effort, có log).
   */
  const releaseHoldOnFailure = async (req, jobId) => {
    const userId = req?.user?.id ?? null;
    const hook = billingHook();
    if (!userId || !hook || typeof hook.afterJob !== 'function') return;
    try {
      await hook.afterJob({ userId, jobId, status: 'failed', actualCost: 0 });
    } catch (err) {
      logger?.warn?.('billing.hook_failed', { phase: 'afterJob', error_name: err?.name || 'Error', error_code: err?.code || null });
    }
  };

  /* ─────────────────────────── A4-01 → A4-04 · /api/auth/* ─────────────────────────── */

  router.post('/api/auth/register', async (req, res) => {
    const svc = requireAuthFeature();
    // Chống dò tài khoản: bucket RIÊNG theo IP, dùng limiter CÓ SẴN (không tạo limiter mới).
    enforce(rateLimiters.requests, `auth:register:${clientKey(req)}`);

    const body = await readAuthBody(req);
    if (typeof body.email !== 'string' || !body.email.trim() || typeof body.password !== 'string') {
      throw HttpError.safe(400, 'BAD_BODY', 'Cần `email` (chuỗi) và `password` (chuỗi).');
    }
    const displayName = sanitizeText(body.display_name ?? body.displayName, { maxLength: 120 });

    let result;
    try {
      result = await svc.register({ email: body.email.trim(), password: body.password, displayName });
    } catch (err) {
      throw mapRegisterError(err, passwordMinLength());
    }

    const token = safeToken(result?.token);
    if (token && result?.expiresAt) appendSetCookie(res, authCookie(token, result.expiresAt));
    else logger?.warn?.('auth.register_no_token', { has_token: Boolean(token) });

    // PB-05 (vòng 2): `BILLING_DEFAULT_GRANT` trước đây là khoá CHẾT (khai 5 mà ví vẫn 0).
    // Nay đăng ký xong thì tặng đúng số đó, ghi sổ với `reason='grant'` (đối soát được).
    const grant = await grantDefaultOnRegister(result?.user);
    sendJson(res, 201, {
      user: publicUserJson(result?.user),
      expires_at: toIsoString(result?.expiresAt),
      ...(grant ? { credit_granted: grant } : {}),
    });
  });

  router.post('/api/auth/login', async (req, res) => {
    const svc = requireAuthFeature();

    const body = await readAuthBody(req);
    if (typeof body.email !== 'string' || !body.email.trim() || typeof body.password !== 'string' || !body.password) {
      throw HttpError.safe(400, 'BAD_BODY', 'Cần `email` (chuỗi) và `password` (chuỗi).');
    }

    // PB-08 (vòng 2): bucket RIÊNG theo `email` chuẩn hoá + IP, và CHỈ đếm lần THẤT BẠI.
    // Trước đây dùng chung bucket 120 req/phút theo IP ⇒ vừa quá rộng cho brute-force, vừa
    // tự khoá đường đăng nhập ĐÚNG của chính mình. Đăng nhập đúng KHÔNG tiêu quota.
    const emailKey = normalizeEmailLike(body.email);
    const ipKey = clientKey(req);
    const loginKey = `auth:login:${emailKey || '-'}:${ipKey}`;
    const ipWideKey = `auth:login-ip:${ipKey}`;
    const gate = checkLoginAttempts(loginKey, LOGIN_MAX_FAILURES);
    const ipGate = checkLoginAttempts(ipWideKey, LOGIN_IP_MAX_FAILURES);

    // Vì sao KHÔNG chặn thẳng khi bucket đã đầy: yêu cầu PB-08 là "đăng nhập ĐÚNG không bị
    // chặn bởi chính bộ đếm lần sai của mình". Nên vẫn XÁC THỰC, rồi mới phán quyết:
    //   · đúng ⇒ cho vào + xoá bộ đếm (người dùng thật không bao giờ bị khoá vì gõ nhầm);
    //   · sai  ⇒ 429 kèm `Retry-After` (kẻ dò mật khẩu bị chặn đúng lúc cần chặn).
    let result;
    try {
      result = await svc.login({
        email: body.email.trim(),
        password: body.password,
        userAgent: sanitizeText(req?.headers?.['user-agent'], { maxLength: 300 }),
      });
    } catch (err) {
      const mapped = mapLoginError(err);
      if (mapped?.code === 'BAD_CREDENTIALS') {
        const now = registerLoginFailure(loginKey, LOGIN_MAX_FAILURES);
        registerLoginFailure(ipWideKey, LOGIN_IP_MAX_FAILURES); // BR-04: đếm cả ở bucket theo IP
        const active = now.blocked ? now : (ipGate.blocked ? ipGate : (gate.blocked ? gate : null));
        if (active) {
          res.setHeader('retry-after', String(active.retryAfterSec));
          throw HttpError.safe(
            429,
            'RATE_LIMITED',
            `Quá nhiều lần đăng nhập sai cho tài khoản này — thử lại sau ${active.retryAfterSec} giây.`,
          );
        }
      }
      throw mapped;
    }
    clearLoginFailures(loginKey); // đăng nhập đúng ⇒ xoá bộ đếm sai của cặp (email, IP) này
    clearLoginFailures(ipWideKey); // ... và bộ đếm theo IP (người dùng thật vừa chứng minh mình hợp lệ)

    const token = safeToken(result?.token);
    if (token && result?.expiresAt) appendSetCookie(res, authCookie(token, result.expiresAt));
    else logger?.warn?.('auth.login_no_token', { has_token: Boolean(token) });

    sendJson(res, 200, { user: publicUserJson(result?.user), expires_at: toIsoString(result?.expiresAt) });
  });

  router.post('/api/auth/logout', async (req, res) => {
    // AUTH_ENABLED=false ⇒ 503 như mọi route /api/auth/*; còn lại đăng xuất luôn thành công
    // (xoá cookie là việc của client, thu hồi token là best-effort).
    if (!authEnabled()) throw HttpError.safe(503, 'AUTH_DISABLED', AUTH_DISABLED_MESSAGE);
    const svc = accountService();
    const token = authTokenFromRequest(req);
    if (svc && token && typeof svc.logout === 'function') {
      try {
        await svc.logout(token);
      } catch (err) {
        logger?.warn?.('auth.logout_failed', { error_name: err?.name || 'Error', error_code: err?.code || null });
      }
    }
    appendSetCookie(res, clearedAuthCookie());
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/auth/me', async (req, res) => {
    if (!authEnabled()) throw HttpError.safe(503, 'AUTH_DISABLED', AUTH_DISABLED_MESSAGE);
    await attachUser(req);
    const user = req.user || null;
    // Không có dịch vụ tài khoản ⇒ vẫn trả lời được "khách ẩn danh" (UI MVP-01/02/03 không vỡ).
    const balance = user ? await readBalance(user.id) : null;
    sendJson(res, 200, {
      user: user ? publicUserJson(user) : null,
      anonymous: !user,
      balance: balanceJson(balance),
    });
  });

  /* ───────────────────────── A4-05/A4-06 · /api/billing/* ───────────────────────── */

  router.get('/api/billing/ledger', async (req, res) => {
    const user = requireUser(req);
    const svc = requireWallet();
    const limit = clampInt(req.query.get('limit'), 50, 1, 200);
    const offset = clampInt(req.query.get('offset'), 0, 0, 1_000_000);

    let items = [];
    try {
      items = asArray(await svc.history({ userId: user.id, limit, offset }));
    } catch (err) {
      throw mapBillingError(err) || err;
    }
    const balance = await readBalance(user.id);
    sendJson(res, 200, { items: items.map(ledgerJson), balance: balanceJson(balance) });
  });

  router.get('/api/billing/pricing', async (req, res) => {
    // Bảng giá là thông tin công khai (không có bí mật): UI hiện được giá kể cả khi chưa
    // đăng nhập. KHÔNG trả bất kỳ khoá cấu hình nào khác.
    let pricing = [];
    if (typeof store.listPricing === 'function') {
      try {
        pricing = asArray(await store.listPricing());
      } catch (err) {
        logger?.warn?.('billing.pricing_failed', { error_name: err?.name || 'Error', error_code: err?.code || null });
      }
    } else {
      const svc = walletService();
      if (svc && typeof svc.priceOf === 'function') {
        for (const operation of PRICING_OPERATIONS) {
          try {
            const p = await svc.priceOf(operation);
            if (p) pricing.push(p);
          } catch {
            /* thiếu một dòng giá không được làm hỏng cả bảng */
          }
        }
      }
    }
    sendJson(res, 200, { pricing: pricing.map(pricingJson) });
  });

  /* ═════════ MVP-06 · NẠP CREDIT THỦ CÔNG (`docs/MVP-06-CONTRACT.md` §3) ═════════
   *
   * CHỈ THÊM route, không sửa route cũ. Bốn đường:
   *   POST /api/billing/topup-requests             (đã đăng nhập) — TẠO yêu cầu, KHÔNG đụng ví
   *   GET  /api/billing/topup-requests             (chính chủ: của mình; admin: tất cả + ?status=)
   *   POST /api/billing/topup-requests/:id/confirm (CHỈ admin) — đường DUY NHẤT credit vào ví
   *   POST /api/billing/topup-requests/:id/reject  (CHỈ admin) — bắt buộc lý do, KHÔNG dòng sổ
   *
   * `src/billing/topup.js` được nạp ĐỘNG y như khối MVP-05: một module hỏng KHÔNG được làm chết
   * MVP-01/02/03. Thiếu module ⇒ 503 `TOPUP_UNAVAILABLE` nói thẳng, KHÔNG im lặng trả rỗng.
   */

  let topupServicePromise = null;
  const topupService = async () => {
    requireWallet(); // ví tắt / chưa nạp ⇒ 503 trước khi nói tới nạp tiền
    if (!topupServicePromise) {
      topupServicePromise = (async () => {
        try {
          const mod = await import('../billing/topup.js');
          if (typeof mod?.createTopupService !== 'function') {
            throw new Error('module nạp credit không xuất `createTopupService`');
          }
          return mod.createTopupService(config, { store, billing: walletService(), logger });
        } catch (err) {
          logger?.error?.('topup.wiring_failed', {
            error_name: err?.name || 'Error',
            error_code: err?.code || null,
            // KHÔNG đưa cả object lỗi vào log: message/stack của Node chứa đường dẫn tuyệt đối.
            error_message: scrubPaths(String(err?.message || err)),
          });
          return null;
        }
      })();
    }
    const svc = await topupServicePromise;
    if (!svc) {
      throw HttpError.safe(503, 'TOPUP_UNAVAILABLE', 'Chức năng nạp credit chưa nạp được trên máy chủ này — tạm thời chưa tạo/duyệt được yêu cầu nạp.');
    }
    return svc;
  };

  /** Khối cấu hình nạp credit cho `/api/config` — thiếu module ⇒ `null` (UI ẩn form, nói thật). */
  const topupPublicConfig = async () => {
    if (!billingAvailable()) return null;
    try {
      const svc = await topupService();
      return svc.publicConfig();
    } catch {
      return null;
    }
  };

  const isAdminReq = (req) => ADMIN_ROLES.has(String(req?.user?.role || 'member'));

  router.post('/api/billing/topup-requests', async (req, res) => {
    const user = requireUser(req); // ẩn danh ⇒ 401 (luật §3)
    const svc = await topupService();
    // Chống spam yêu cầu nạp: bucket RIÊNG theo IP, dùng limiter CÓ SẴN (không tạo limiter mới).
    enforce(rateLimiters.requests, `topup:create:${clientKey(req)}`);
    const body = await readJson(req, { maxBytes: 32 * 1024 });
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw HttpError.safe(400, 'BAD_BODY', 'Body phải là một object JSON.');
    }
    let request;
    try {
      request = await svc.createRequest({
        userId: user.id,
        amountVnd: body.amount_vnd ?? body.amountVnd,
        reference: body.reference,
        note: body.note,
      });
    } catch (err) {
      throw mapTopupError(err) || mapBillingError(err) || err;
    }
    // Hợp đồng §4 — nói thật ngay trong phản hồi: ví KHÔNG hề bị chạm ở bước này.
    sendJson(res, 201, { request: topupRequestJson(request), wallet_touched: false, note: topupHonestNote(svc) });
  });

  router.get('/api/billing/topup-requests', async (req, res) => {
    const user = requireUser(req);
    const svc = await topupService();
    const admin = isAdminReq(req);
    const limit = clampInt(req.query.get('limit'), 50, 1, 200);
    const offset = clampInt(req.query.get('offset'), 0, 0, 1_000_000);
    const statusRaw = sanitizeText(req.query.get('status'), { maxLength: 20 }).toLowerCase();
    if (statusRaw && !TOPUP_STATUS_LIST.includes(statusRaw)) {
      throw HttpError.safe(400, 'BAD_STATUS', `\`status\` phải là một trong: ${TOPUP_STATUS_LIST.join(', ')}.`);
    }
    // `mine=1` cho admin xem RIÊNG yêu cầu của mình (trang Tài khoản của chính admin).
    const mineOnly = ['1', 'true', 'yes'].includes(String(req.query.get('mine') ?? '').toLowerCase());
    let out;
    try {
      out = await svc.list({
        userId: user.id,
        all: admin && !mineOnly,
        status: statusRaw || null,
        limit,
        offset,
      });
    } catch (err) {
      throw mapTopupError(err) || err;
    }
    sendJson(res, 200, {
      items: (out?.items || []).map(topupRequestJson),
      total: Number(out?.total) || 0,
      scope: admin && !mineOnly ? 'all' : 'mine',
      is_admin: admin,
    });
  });

  router.post('/api/billing/topup-requests/:id/confirm', async (req, res, params) => {
    const admin = requireAdmin(req);
    const svc = await topupService();
    const body = await readJson(req, { maxBytes: 32 * 1024 }).catch(() => ({}));
    let out;
    try {
      out = await svc.confirm({
        requestId: String(params?.id ?? ''),
        actorId: admin.id,
        credits: body?.credits ?? null,
        note: body?.note ?? '',
      });
    } catch (err) {
      throw mapTopupError(err) || mapBillingError(err) || err;
    }
    const balance = await readBalance(out?.request?.user_id);
    sendJson(res, 200, {
      request: topupRequestJson(out?.request),
      ledger: ledgerJson(out?.ledger),
      balance: balanceJson(balance),
    });
  });

  router.post('/api/billing/topup-requests/:id/reject', async (req, res, params) => {
    const admin = requireAdmin(req);
    const svc = await topupService();
    const body = await readJson(req, { maxBytes: 32 * 1024 });
    let out;
    try {
      out = await svc.reject({
        requestId: String(params?.id ?? ''),
        actorId: admin.id,
        reason: body?.reason ?? '',
      });
    } catch (err) {
      throw mapTopupError(err) || mapBillingError(err) || err;
    }
    // Từ chối KHÔNG sinh dòng sổ nào — nói thẳng trong phản hồi để UI khỏi đoán.
    sendJson(res, 200, { request: topupRequestJson(out?.request), ledger: null });
  });

  /* ────────────────────────── A4-07 → A4-10 · /api/admin/* ────────────────────────── */

  router.get('/api/admin/users', async (req, res) => {
    requireAdmin(req);
    const limit = clampInt(req.query.get('limit'), 50, 1, 200);
    const offset = clampInt(req.query.get('offset'), 0, 0, 1_000_000);

    let items = [];
    const svc = accountService();
    try {
      if (svc && typeof svc.list === 'function') items = asArray(await svc.list({ limit, offset }));
      else if (typeof store.listUsers === 'function') items = asArray(await store.listUsers({ limit, offset }));
      else throw HttpError.safe(503, 'ACCOUNTS_UNAVAILABLE', AUTH_UNAVAILABLE_MESSAGE);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw mapAuthError(err);
    }

    // `total`: dùng count của store khi có; không có thì đếm được bao nhiêu trả bấy nhiêu
    // (KHÔNG bịa con số). `countUsers` chưa nằm trong danh sách hàm đóng băng §3.4.
    let total = items.length + offset;
    if (typeof store.countUsers === 'function') {
      try {
        const n = Number(await store.countUsers());
        if (Number.isFinite(n)) total = n;
      } catch {
        /* giữ ước lượng từ trang hiện tại */
      }
    }
    sendJson(res, 200, { items: items.map(publicUserJson).filter(Boolean), total });
  });

  router.post('/api/admin/users/:id/credit', async (req, res, params) => {
    const admin = requireAdmin(req);
    const svc = requireWallet();
    const body = await readJson(req, { maxBytes: 32 * 1024 });
    const amount = Number(body?.amount);
    // PB-07 (vòng 2): UI ghi rõ "dương = cấp thêm, âm = điều chỉnh giảm" nhưng API trước đây
    // luôn từ chối số âm ⇒ không có đường hợp lệ nào để GIẢM credit. Nay cho phép số âm, map
    // sang `reason='adjustment'`; luật "số dư không âm" vẫn giữ (thiếu ⇒ 400 INSUFFICIENT_CREDIT).
    if (!Number.isFinite(amount) || amount === 0) {
      throw HttpError.safe(400, 'BAD_AMOUNT', '`amount` phải là số hữu hạn KHÁC 0 (dương = cấp thêm, âm = điều chỉnh giảm).');
    }
    const target = await findUserById(params?.id ?? '');
    if (!target) throw HttpError.safe(404, 'USER_NOT_FOUND', 'Không tìm thấy người dùng.');
    const note = sanitizeText(body?.note, { maxLength: 300 });

    let ledger;
    try {
      ledger = await svc.grant({
        userId: target.id,
        amount,
        reason: amount < 0 ? 'adjustment' : 'admin_grant',
        actorId: admin.id,
        note,
      });
    } catch (err) {
      // PB-07: giảm quá số dư ⇒ 400 `INSUFFICIENT_CREDIT` (KHÔNG phải 402: đây là thao tác
      // quản trị sai số liệu, không phải "ví không đủ để chạy job").
      if (String(err?.code) === 'INSUFFICIENT_CREDIT') {
        const d = err?.details && typeof err.details === 'object' ? err.details : {};
        throw HttpError.safe(400, 'INSUFFICIENT_CREDIT', 'Số dư không đủ để điều chỉnh giảm từng đó — ví không được âm.', {
          balance: Number.isFinite(Number(d.balance)) ? Number(d.balance) : null,
          amount: Number.isFinite(Number(d.amount)) ? Number(d.amount) : null,
        });
      }
      throw mapBillingError(err) || mapAuthError(err);
    }
    const balance = await readBalance(target.id);
    sendJson(res, 201, { ledger: ledgerJson(ledger), balance: balanceJson(balance) });
  });

  /**
   * BR-08 (vòng 4) — BẢO TRÌ: thu hồi các lượt chạy TREO (có `job_hold` mà không có dòng đóng).
   * Chỉ owner/admin. Trả `{ reconciled, refunded, older_than_ms }`.
   */
  router.post('/api/admin/billing/reconcile', async (req, res) => {
    requireAdmin(req);
    const service = app?.billingService;
    if (!service || typeof service.reconcileStuckRuns !== 'function') {
      throw HttpError.safe(503, 'BILLING_UNAVAILABLE', 'Ví credit chưa sẵn sàng — chưa thu hồi được lượt treo.');
    }
    const body = await readJson(req, { maxBytes: 8 * 1024 }).catch(() => ({}));
    const rawMs = Number(body?.older_than_ms);
    const olderThanMs = Number.isFinite(rawMs) && rawMs >= 0 ? rawMs : null;
    // BR-10: `force: true` ⇒ ÉP thu hồi dù job đang hoạt động (chỉ owner/admin, khi biết chắc job
    // đã chết) — dòng hoàn sẽ mang `meta.forced = true`.
    const force = body?.force === true;
    let out;
    try {
      out = typeof app?.reconcileStuckRuns === 'function'
        ? await app.reconcileStuckRuns({ olderThanMs, force })
        : await service.reconcileStuckRuns({ olderThanMs, force });
    } catch (err) {
      throw mapBillingError(err) || err;
    }
    logger?.warn?.('billing.reconcile_requested', { reconciled: out?.reconciled ?? 0, force, skipped_active: out?.skipped_active ?? 0 });
    sendJson(res, 200, {
      reconciled: Number(out?.reconciled) || 0,
      refunded: Number(out?.refunded) || 0,
      older_than_ms: out?.older_than_ms ?? null,
      skipped_active: Number(out?.skipped_active) || 0,
      forced: force,
    });
  });

  router.post('/api/admin/users/:id/role', async (req, res, params) => {
    requireAdmin(req);
    const svc = requireAuthFeature();
    const body = await readJson(req, { maxBytes: 16 * 1024 });
    const role = String(body?.role ?? '').trim().toLowerCase();
    if (!AUTH_ROLES.includes(role)) {
      throw HttpError.safe(400, 'BAD_ROLE', `\`role\` phải là một trong: ${AUTH_ROLES.join(', ')}.`);
    }
    const target = await findUserById(params?.id ?? '');
    if (!target) throw HttpError.safe(404, 'USER_NOT_FOUND', 'Không tìm thấy người dùng.');

    let updated;
    try {
      updated = await svc.setRole(target.id, role);
    } catch (err) {
      throw mapAuthError(err);
    }
    if (!updated || typeof updated !== 'object') updated = (await findUserById(target.id)) || target;
    sendJson(res, 200, { user: publicUserJson(updated) });
  });

  router.get('/api/admin/usage', async (req, res) => {
    requireAdmin(req);
    const from = sanitizeText(req.query.get('from'), { maxLength: 40 }) || null;
    const to = sanitizeText(req.query.get('to'), { maxLength: 40 }) || null;
    const groupBy = String(req.query.get('group_by') || 'day').trim().toLowerCase();
    if (!USAGE_GROUP_BY.includes(groupBy)) {
      throw HttpError.safe(400, 'BAD_GROUP_BY', `\`group_by\` phải là một trong: ${USAGE_GROUP_BY.join(', ')}.`);
    }

    const svc = walletService();
    let rows = [];
    try {
      if (typeof store.usageAggregate === 'function') rows = asArray(await store.usageAggregate({ from, to, groupBy }));
      else if (svc && typeof svc.usageSummary === 'function') rows = asArray(await svc.usageSummary({ from, to, groupBy }));
      else throw HttpError.safe(503, 'BILLING_UNAVAILABLE', BILLING_UNAVAILABLE_MESSAGE);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw mapBillingError(err) || err;
    }
    sendJson(res, 200, { rows: rows.map(usageRowJson) });
  });

  /* ───────────────────────────── Health ───────────────────────────── */

  router.get('/api/health', async (req, res) => {
    let dbOk = true;
    let dbError = null;
    try {
      await store.driver.get('SELECT 1 AS ok');
    } catch (err) {
      dbOk = false;
      dbError = err.message;
    }
    const moneySchema = typeof store?.moneySchemaStatus === 'function'
      ? store.moneySchemaStatus()
      : { ok: true, checked: false, reason: null, not_widened: [] };
    sendJson(res, dbOk ? 200 : 503, {
      status: dbOk ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      db: { dialect: store.dialect, ok: dbOk, error: dbError },
      // F1 (phản biện PR #28): KIỂU CỘT TIỀN phải HIỆN RA ở health, không im lặng.
      // `money_schema_ok: false` = DB còn cột tiền `real` (float4) — migration nới kiểu đã bị
      // chặn (app không boot tới được đây) HOẶC cột nằm NGOÀI `search_path` nên app không đọc tới.
      // `checked: false` = chưa kiểm được (SQLite, store dựng tay) — KHÔNG phải "đã kiểm và đạt".
      money_schema_ok: moneySchema.ok !== false,
      money_schema_reason: moneySchema.reason ?? null,
      money_schema: {
        checked: moneySchema.checked === true,
        ok: moneySchema.ok !== false,
        not_widened: Array.isArray(moneySchema.not_widened) ? moneySchema.not_widened : [],
      },
      jobs: queue.stats(),
      connectors: registry.list(),
      connector_init_failures: registry.initFailures,
      // 4.6 — UI/người vận hành dựa vào cờ này để biết MVP-02 có sẵn sàng không,
      // và `reason` để biết VÌ SAO nó tắt (không im lặng).
      imagelab: { available: imagelabAvailable(), reason: imagelabAvailable() ? null : imagelabUnavailableReason() },
      // MVP-05: tài khoản/ví có thật hay không — chỉ cờ + lý do, không lộ bí mật.
      accounts: { available: accountsAvailable(), reason: accountsAvailable() ? null : AUTH_UNAVAILABLE_MESSAGE },
      billing: {
        available: billingAvailable(),
        currency: creditCurrency(),
        reason: billingAvailable() ? null : BILLING_UNAVAILABLE_MESSAGE,
      },
      // R1 (§4): cron dọn dẹp — chỉ cờ + số đếm, KHÔNG lộ bí mật/đường dẫn.
      // Chưa gắn scheduler (test dựng router trực tiếp) ⇒ rơi về cấu hình + số 0.
      scheduler: (() => {
        const s = typeof app?.scheduler?.stats === 'function' ? app.scheduler.stats() : null;
        const r = s?.last_result;
        return {
          enabled: s ? s.enabled !== false : config?.scheduler?.enabled !== false,
          running: Boolean(s?.running),
          ticks: Number.isFinite(Number(s?.ticks)) ? Number(s.ticks) : 0,
          last_tick_at: s?.last_tick_at ?? null,
          last_result: r
            ? {
              reconciled: Number(r.reconciled) || 0,
              requeued: Number(r.requeued) || 0,
              // R1-F3 (vòng sửa phản biện): nhịp cron nay còn NHẶT VÀ CHẠY việc `queued` mồ côi
              // (`claimed`) và CHỐT mục chạm trần thành `failed` (`exhausted`) — health phải nói thật.
              claimed: Number(r.claimed) || 0,
              exhausted: Number(r.exhausted) || 0,
              errors: Number(r.errors) || 0,
            }
            : null,
        };
      })(),
    });
  });

  /* ═════════ MVP-08 · ĐĂNG SẢN PHẨM LÊN SÀN (`docs/MVP-08-CONTRACT.md` §4) ═════════
   *
   * CHỈ THÊM route. Bảy đường:
   *   GET  /api/marketplace/channels                 → [{name, configured, capabilities}] (công khai, chỉ cờ)
   *   POST /api/marketplace/listings                 {job_id, channel, run_key?, overrides?} → 201 {listing, issues[]}
   *   GET  /api/marketplace/listings?job_id=&channel=&status=  (chính chủ; admin: tất cả, `mine=1` để xem của mình)
   *   GET  /api/marketplace/listings/:id             → listing + payload + issues + unmapped + events
   *   POST /api/marketplace/listings/:id/approve|reject (CHỈ owner/admin — DUYỆT TAY)
   *   POST /api/marketplace/listings/:id/publish     (chủ hoặc admin; chỉ khi đã DUYỆT)
   *   POST /api/marketplace/listings/:id/sync        (đọc giá/tồn từ sàn — chỉ kênh đã cấu hình)
   *
   * Module nạp ĐỘNG như MVP-05/06: hỏng ⇒ 503 `MARKETPLACE_UNAVAILABLE` nói thẳng, không làm chết
   * MVP-01/02/03. Ẩn danh ⇒ 401 (đăng sàn KHÔNG dành cho ẩn danh). Khác chủ ⇒ 404.
   */

  let marketplaceServicePromise = null;
  const marketplaceEnabled = () => config?.marketplace?.enabled !== false;
  const marketplaceService = async () => {
    if (!marketplaceEnabled()) {
      throw HttpError.safe(503, 'MARKETPLACE_UNAVAILABLE', 'Tính năng đăng sàn đang bị tắt bằng cấu hình (MARKETPLACE_ENABLED=false).');
    }
    if (!marketplaceServicePromise) {
      marketplaceServicePromise = (async () => {
        try {
          const [{ createMarketplaceRegistry }, { createMarketplaceService }] = await Promise.all([
            import('../marketplace/registry.js'),
            import('../marketplace/publish.js'),
          ]);
          const registry = app?.marketplaceRegistry || createMarketplaceRegistry(config, { logger });
          return createMarketplaceService(config, { store, registry, logger });
        } catch (err) {
          logger?.error?.('marketplace.wiring_failed', {
            error_name: err?.name || 'Error',
            error_code: err?.code || null,
            error_message: scrubPaths(String(err?.message || err)),
          });
          return null;
        }
      })();
    }
    const svc = await marketplaceServicePromise;
    if (!svc) throw HttpError.safe(503, 'MARKETPLACE_UNAVAILABLE', 'Chức năng đăng sàn chưa nạp được trên máy chủ này.');
    return svc;
  };

  /** Khối cho `/api/config` — thiếu module ⇒ `null` (UI nói thật). */
  const marketplacePublicConfig = async () => {
    if (!marketplaceEnabled()) return null;
    try {
      const svc = await marketplaceService();
      return svc.channelsInfo();
    } catch {
      return null;
    }
  };

  const marketplaceIsAdmin = (req) => ADMIN_ROLES.has(String(req?.user?.role || 'member'));

  router.get('/api/marketplace/channels', async (req, res) => {
    const svc = await marketplaceService();
    sendJson(res, 200, svc.channelsInfo());
  });

  router.post('/api/marketplace/listings', async (req, res) => {
    const user = requireUser(req); // ẩn danh ⇒ 401
    const svc = await marketplaceService();
    enforce(rateLimiters.requests, `marketplace:create:${clientKey(req)}`);
    const body = await readJson(req, { maxBytes: 256 * 1024 });
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw HttpError.safe(400, 'BAD_BODY', 'Body phải là một object JSON.');
    const jobId = String(body.job_id ?? body.jobId ?? '');
    if (!UUID_RE.test(jobId)) throw HttpError.safe(400, 'BAD_JOB_ID', 'Thiếu hoặc sai `job_id`.');
    const job = await requireOwnJob(req, res, jobId); // khác chủ ⇒ 404
    let out;
    try {
      out = await svc.createListing({
        job,
        userId: user.id,
        channel: body.channel ?? null,
        overrides: body.overrides ?? null,
        runKey: body.run_key ?? body.runKey ?? null,
      });
    } catch (err) {
      throw mapMarketplaceError(err) || err;
    }
    sendJson(res, out.idempotent ? 200 : 201, { listing: marketplaceListingJson(out.listing), issues: out.issues || [], idempotent: Boolean(out.idempotent) });
  });

  router.get('/api/marketplace/listings', async (req, res) => {
    const user = requireUser(req);
    const svc = await marketplaceService();
    const admin = marketplaceIsAdmin(req);
    const mineOnly = ['1', 'true', 'yes'].includes(String(req.query.get('mine') ?? '').toLowerCase());
    const jobId = sanitizeText(req.query.get('job_id'), { maxLength: 64 }) || null;
    const channel = sanitizeText(req.query.get('channel'), { maxLength: 20 }) || null;
    const status = sanitizeText(req.query.get('status'), { maxLength: 20 }) || null;
    let out;
    try {
      out = await svc.list({
        userId: user.id,
        all: admin && !mineOnly,
        jobId,
        channel,
        status,
        limit: clampInt(req.query.get('limit'), 50, 1, 200),
        offset: clampInt(req.query.get('offset'), 0, 0, 1_000_000),
      });
    } catch (err) {
      throw mapMarketplaceError(err) || err;
    }
    sendJson(res, 200, { items: (out.items || []).map(marketplaceListingJson), total: Number(out.total) || 0, scope: admin && !mineOnly ? 'all' : 'mine', is_admin: admin });
  });

  router.get('/api/marketplace/listings/:id', async (req, res, params) => {
    const user = requireUser(req);
    const svc = await marketplaceService();
    let listing;
    try {
      listing = await svc.get({ id: String(params?.id ?? ''), requesterId: user.id, isAdmin: marketplaceIsAdmin(req) });
    } catch (err) {
      throw mapMarketplaceError(err) || err;
    }
    const events = await svc.events(listing.id);
    sendJson(res, 200, { listing: marketplaceListingJson(listing, { full: true }), events });
  });

  router.post('/api/marketplace/listings/:id/approve', async (req, res, params) => {
    const admin = requireAdmin(req); // member ⇒ 403
    const svc = await marketplaceService();
    let listing;
    try {
      listing = await svc.approve({ id: String(params?.id ?? ''), actorId: admin.id });
    } catch (err) {
      throw mapMarketplaceError(err) || err;
    }
    sendJson(res, 200, { listing: marketplaceListingJson(listing) });
  });

  router.post('/api/marketplace/listings/:id/reject', async (req, res, params) => {
    const admin = requireAdmin(req);
    const svc = await marketplaceService();
    const body = await readJson(req, { maxBytes: 32 * 1024 }).catch(() => ({}));
    let listing;
    try {
      listing = await svc.reject({ id: String(params?.id ?? ''), actorId: admin.id, reason: body?.reason ?? '' });
    } catch (err) {
      throw mapMarketplaceError(err) || err;
    }
    sendJson(res, 200, { listing: marketplaceListingJson(listing) });
  });

  /* ── ĐĂNG — chỉ khi đã DUYỆT (cổng thật ở `Store#claimMarketplaceListing`) ── */
  router.post('/api/marketplace/listings/:id/publish', async (req, res, params) => {
    const user = requireUser(req);
    const svc = await marketplaceService();
    let out;
    try {
      out = await svc.publish({ id: String(params?.id ?? ''), actorId: user.id, requesterId: user.id, isAdmin: marketplaceIsAdmin(req) });
    } catch (err) {
      throw mapMarketplaceError(err) || err;
    }
    sendJson(res, 200, {
      listing: marketplaceListingJson(out.listing),
      status: out.listing?.status ?? null,
      external_id: out.listing?.external_id ?? null,
      url: out.listing?.external_url ?? null,
      error_code: out.listing?.error_code ?? null,
      is_mock: Boolean(out.listing?.is_mock),
      called: Boolean(out.called),
      idempotent: Boolean(out.idempotent),
    });
  });

  router.post('/api/marketplace/listings/:id/sync', async (req, res, params) => {
    const user = requireUser(req);
    const svc = await marketplaceService();
    let out;
    try {
      out = await svc.sync({ id: String(params?.id ?? ''), actorId: user.id, requesterId: user.id, isAdmin: marketplaceIsAdmin(req) });
    } catch (err) {
      throw mapMarketplaceError(err) || err;
    }
    sendJson(res, 200, { listing: marketplaceListingJson(out.listing), snapshot: out.snapshot ?? null, is_mock: Boolean(out.result?.is_mock) });
  });

  /* ─────────────────────────── Capabilities ─────────────────────────── */

  router.get('/api/config', async (req, res) => {
    const sessionStatus = await sessions.status();
    // MVP-03: mẫu nền + ngưỡng retouch nạp PHÒNG THỦ (module anh em có thể chưa có mặt).
    // Thiếu module ⇒ khối `imagestudio` báo `available: false` + templates rỗng, KHÔNG làm
    // hỏng /api/config mà MVP-01/MVP-02 đang dùng.
    const isModules = await imagestudioStaticModules();
    const isReady = imagestudioAvailable() && Boolean(isModules.templates && isModules.retouchLimits);
    // MVP-04: preset + bộ mã hoá cho tab "Video". Module V1 có thể chưa có mặt ⇒ `presets: []`
    // + `available: false` + `reason` nói thẳng — KHÔNG làm hỏng /api/config mà MVP-01/02/03 dùng.
    const vsPresets = await videostudioPresets();
    const vsReady = videostudioAvailable() && Array.isArray(vsPresets) && vsPresets.length > 0;
    sendJson(res, 200, {
      styles: Object.values(STYLES).map((s) => ({ id: s.id, label: s.label, description: s.description })),
      lengths: Object.values(LENGTHS).map((l) => ({ id: l.id, label: l.label })),
      defaults: { style: 'ban-hang', length: 'vua' },
      providers: {
        content: { name: contentEngine?.providerName || 'none', model: contentEngine?.model || '', configured: Boolean(contentEngine?.configured) },
        vision: { name: visionProvider?.name || 'none', model: visionProvider?.model || '', configured: Boolean(visionProvider?.configured) },
      },
      session: sessionStatus,
      sources: registry.list().map((c) => c.source),
      limits: {
        max_upload_bytes: config.net.maxUploadBytes,
        max_upload_files: config.net.maxUploadFiles,
        allowed_image_mime: config.net.allowedImageMime,
        max_images_for_vision: config.vision.maxImages,
      },
      // 4.5.1 — khối cấu hình MVP-02 mà UI dựa vào (nhãn MOCK, giới hạn ảnh, loại vùng).
      imagelab: {
        available: imagelabAvailable(),
        // 4.6 — lý do thật khi tính năng không khả dụng (đã lọc đường dẫn nội bộ).
        reason: imagelabAvailable() ? null : imagelabUnavailableReason(),
        enabled: imagelabEnabled(),
        ...imagelabProviders(),
        limits: imagelabLimits(),
        kinds: [...IMAGELAB_KINDS],
        max_render_pixels: imagelabLimits().max_pixels,
      },
      // 3.6 — khối MVP-03 cho UI (tab "Tạo ảnh"): mẫu nền MÔ PHỎNG + ngưỡng retouch +
      // provider. `available` = pipeline E3 + kho ảnh + module mẫu nền/ngưỡng + cờ cấu hình
      // (xem `imagestudioEnabled`); `reason` nói thẳng vì sao tắt — không im lặng.
      imagestudio: {
        available: isReady,
        reason: isReady ? null : imagestudioAvailable() ? IMAGESTUDIO_MODULE_MESSAGE : imagestudioUnavailableReason(),
        enabled: imagestudioEnabled(),
        // Chỉ ba field UI cần; `synthetic` giữ nguyên giá trị THẬT của mẫu (không tự gán true).
        templates: (isModules.templates || []).map((t) => ({ id: t.id, label: t.label, synthetic: t.synthetic === true })),
        retouch_limits: isModules.retouchLimits || null,
        matting: imagestudioProviderInfo(app.mattingProvider),
        retouch: imagestudioProviderInfo(app.retouchProvider),
      },
      // §2.4 — khối MVP-04 cho UI (tab "Video"): `presets` chỉ id+label (UI không cần kích
      // thước), `encoder` đúng ba field hợp đồng, và `audio: false` là SỰ THẬT của bản offline
      // (GIF không có tiếng; TTS/nhạc là phần trả tiền) — UI phải hiện "video KHÔNG có tiếng".
      videostudio: {
        available: vsReady,
        reason: vsReady ? null : videostudioAvailable() ? VIDEOSTUDIO_MODULE_MESSAGE : videostudioUnavailableReason(),
        enabled: videostudioEnabled(),
        presets: (vsPresets || []).map((p) => ({ id: p.id, label: p.label })),
        encoder: videostudioEncoderInfo(),
        audio: false,
      },
      // MVP-07 (§4 hợp đồng đăng bài) — khối cho UI (P4): provider nào đang chạy, có phải CHẾ ĐỘ
      // THỬ không, đã cấu hình Facebook chưa. CHỈ cờ + giới hạn: KHÔNG token, KHÔNG Page ID.
      publish: publishConfigBlock(),
      // MVP-06 (§3 hợp đồng export) — khối cho UI (X3) biết có tải được gói .zip hay không.
      // CHỈ hai field: cờ khả dụng + định dạng; KHÔNG lộ đường dẫn, tên module hay bí mật.
      exports: {
        available: await exportsAvailable(),
        formats: ['zip'],
      },
      // MVP-05 (§3.3) — khối `auth`/`billing` cho UI: CHỈ cờ + giới hạn, TUYỆT ĐỐI không
      // lộ bí mật (không token, không khoá ký, không chi tiết nội bộ của dịch vụ).
      auth: {
        enabled: authEnabled(),
        anonymous_allowed: anonymousAllowed(),
        password_min_length: passwordMinLength(),
        roles: [...AUTH_ROLES],
        available: accountsAvailable(),
      },
      billing: {
        enabled: billingEnabled(),
        currency: creditCurrency(),
        available: billingAvailable(),
        // PB-05b (vòng 2): công tắc giữ-tiền-trước phải HIỆN RA cho người vận hành — trước đây
        // `BILLING_HOLD_BEFORE_JOB=false` bị bỏ qua im lặng (vẫn giữ tiền, vẫn 402).
        hold_before_job: billingConfig().holdBeforeJob !== false,
        default_grant: Number.isFinite(Number(billingConfig().defaultGrant)) ? Number(billingConfig().defaultGrant) : 0,
        // PB-02: trần số lượt chạy có tính tiền cho mỗi job (vượt ⇒ 429 RERUN_LIMIT_EXCEEDED).
        max_runs_per_job: Number.isFinite(Number(billingConfig().maxRunsPerJob)) ? Number(billingConfig().maxRunsPerJob) : 10,
        max_amount: Number.isFinite(Number(billingConfig().maxAmount)) ? Number(billingConfig().maxAmount) : null,
        // F3 (vòng vá PR #28): trần SỐ DƯ ví (vượt ⇒ 400 `AMOUNT_TOO_LARGE`) — UI/admin phải
        // biết con số này, nếu không họ chỉ thấy lỗi 400 mà không hiểu vì sao.
        max_balance: Number.isFinite(Number(billingConfig().maxBalance)) ? Number(billingConfig().maxBalance) : null,
        // BR-08: ngưỡng coi một lượt chạy là TREO (ms) — quá ngưỡng thì được thu hồi tự động.
        stuck_run_ms: Number.isFinite(Number(billingConfig().stuckRunMs)) ? Number(billingConfig().stuckRunMs) : null,
        min_stuck_run_ms: Number.isFinite(Number(billingConfig().minStuckRunMs)) ? Number(billingConfig().minStuckRunMs) : null,
        // MVP-06 (§3) — NẠP CREDIT THỦ CÔNG: tỷ giá + khoảng tiền + hướng dẫn chuyển khoản
        // LẤY TỪ CẤU HÌNH (UI KHÔNG hardcode số tài khoản). `null` = chưa nạp được module nạp
        // credit ⇒ UI ẩn form và nói thật, không bịa ra số tài khoản nào.
        topup: await topupPublicConfig(),
      },
      // §3.4 — trạng thái thật của dịch vụ tài khoản/ví để người vận hành biết VÌ SAO tắt.
      // MVP-08 (§4/§5) — kênh sàn + cờ live cho tab “Đăng sàn”: chỉ cờ, KHÔNG token. `null` = chưa nạp được module.
      marketplace: await marketplacePublicConfig(),
      accounts: { available: accountsAvailable(), reason: accountsAvailable() ? null : AUTH_UNAVAILABLE_MESSAGE },
    });
  });

  router.get('/api/session', async (req, res) => {
    sendJson(res, 200, await sessions.status());
  });

  /* ───────────────────────── G01 — detect link ───────────────────────── */

  router.post('/api/detect', async (req, res) => {
    enforce(rateLimiters.requests, `detect:${sessionId(req, res)}`);
    const body = await readJson(req, { maxBytes: 64 * 1024 });
    const url = sanitizeText(body.url, { maxLength: 2048 });
    if (!url) throw new HttpError(400, 'MISSING_URL', 'Thiếu `url`.');
    const result = tryDetectSource(url);
    if (!result.ok) {
      throw new HttpError(
        result.code === 'UNSUPPORTED_SOURCE' ? 400 : 422,
        result.code,
        result.message,
      );
    }
    sendJson(res, 200, result.detection);
  });

  /* ─────────────────────── G01/G11 — tạo job mới ─────────────────────── */

  router.post('/api/jobs', async (req, res) => {
    const sid = sessionId(req, res);
    enforce(rateLimiters.jobs, `jobs:${sid}`);
    const body = await readJson(req, { maxBytes: MAX_BODY_BYTES_DEFAULT });

    const url = sanitizeText(body.url, { maxLength: 2048 });
    const manual = body.manual && typeof body.manual === 'object' ? body.manual : null;
    const hasManual = Boolean(manual && (manual.title || manual.notes || (Array.isArray(manual.images) && manual.images.length > 0)));

    if (!url && !hasManual) {
      throw new HttpError(400, 'MISSING_INPUT', 'Cần `url` hoặc dữ liệu `manual`.');
    }

    // Kiểm nguồn TRƯỚC khi tạo job — báo lỗi rõ ràng ngay cho người dùng.
    let detection = null;
    if (url) {
      const det = tryDetectSource(url);
      if (!det.ok) {
        throw new HttpError(det.code === 'UNSUPPORTED_SOURCE' ? 400 : 422, det.code, det.message);
      }
      detection = det.detection;
    }

    const opts = parseContentOptions({ style: body.style, length: body.length });

    if (hasManual) {
      validateManualPayload(manual, config);
    }

    // MVP-05 (§0 luật 2 + §3.4b): cổng ví chạy TRƯỚC khi ghi job ⇒ thiếu credit thì DB
    // KHÔNG tăng dòng nào (job_id sinh trước để hook giữ tiền theo đúng job đó).
    const userId = req.user?.id ?? null;
    const jobId = randomUUID();
    const hold = await holdCreditBeforeJob(req, jobId, 'content'); // R1-F6: khoá hàng đợi theo lượt

    try {
      await store.createJob({
        id: jobId,
        sessionId: sid,
        userId,
        source: detection?.source || 'manual',
        sourceUrl: url,
        canonicalUrl: detection?.canonical_url || '',
        sourceProductId: detection?.source_product_id || '',
        style: opts.style,
        length: opts.length,
        inputMode: url && hasManual ? 'link+manual' : url ? 'link' : 'manual',
      });
    } catch (err) {
      await releaseHoldOnFailure(req, jobId);
      throw mapBillingError(err) || err;
    }

    try {
      // R1-F6: khoá idempotency theo LƯỢT CHẠY (khi có ví) ⇒ hai tiến trình cùng xếp MỘT lượt
      // chỉ tạo MỘT mục; hai request khác lượt vẫn là hai mục (MVP-05 §BR-02).
      queue.enqueue(jobId, () =>
        pipeline.run(jobId, {
          url,
          manual: hasManual ? manual : null,
          style: opts.style,
          length: opts.length,
          sessionId: sid,
          userId,
        }),
        { runKey: hold?.run_key ?? null },
      );
    } catch (err) {
      // PB-01: xếp hàng lỗi sau khi đã giữ tiền ⇒ hoàn khoản giữ.
      await releaseHoldOnFailure(req, jobId);
      throw mapBillingError(err) || err;
    }

    sendJson(res, 202, {
      job_id: jobId,
      status: JOB_STATUS.QUEUED,
      detection,
      style: opts.style,
      length: opts.length,
      poll: `/api/jobs/${jobId}`,
    });
  });

  /* ───────────────────────── G12 — lịch sử job ───────────────────────── */

  router.get('/api/jobs', async (req, res) => {
    const sid = sessionId(req, res);
    const limit = req.query.get('limit');
    const offset = req.query.get('offset');
    const scope = req.query.get('scope');
    const user = req.user || null;

    // MVP-05 (§3.3) — đã đăng nhập ⇒ CHỈ job của CHÍNH tài khoản (`jobs.user_id`), KHÔNG trộn
    // job ẩn danh của session hiện tại (§2.2: job cũ của session không tự thuộc về ai) và
    // KHÔNG cho `scope=all` nhìn sang dữ liệu người khác.
    const sessionIdFilter = user ? null : scope === 'all' ? null : sid;
    const [rows, rawTotal] = await Promise.all([
      store.listJobs({ sessionId: sessionIdFilter, userId: user?.id ?? null, limit, offset }),
      store.countJobs({ sessionId: sessionIdFilter, userId: user?.id ?? null }),
    ]);

    // Lọc lại theo chủ sở hữu ở tầng route: nếu store CHƯA hỗ trợ `userId` (A3 chưa nối), dòng
    // của người khác vẫn bị chặn. Dòng không khai chủ ⇒ đối chiếu qua `getJob` (fail-closed).
    const visibleRows = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!user) {
        visibleRows.push(row);
        continue;
      }
      const owner = row?.user_id ?? row?.userId ?? null;
      if (owner !== null && owner !== undefined && owner !== '') {
        if (String(owner) === String(user.id)) visibleRows.push(row);
        continue;
      }
      const hydrated = typeof store.getJob === 'function' ? await store.getJob(row.id).catch(() => null) : null;
      if (hydrated && String(hydrated.user_id ?? '') === String(user.id)) visibleRows.push(row);
    }
    // `total`: chỉ tin con số của store khi nó KHÔNG trả về dòng của người khác (nếu trả về,
    // nghĩa là bộ lọc `userId` chưa được store áp dụng ⇒ đếm theo số dòng đã kiểm được).
    const total = user && visibleRows.length !== (Array.isArray(rows) ? rows.length : 0) ? visibleRows.length : rawTotal;

    // N-3 (vòng 4): mỗi dòng lịch sử phải phân biệt được job ImageLab và mang nhãn MOCK
    // theo DẤU VẾT ĐÃ LƯU của chính job đó (không theo cấu hình máy chủ đang chạy).
    // KHÔNG trả `session_id`/`content_meta` thô (dữ liệu nội bộ).
    const items = visibleRows.map((row) => {
      // `listJobs` trả cột TEXT thô (SQLite) nên `content_meta` có thể là CHUỖI JSON —
      // phải parse trước khi đọc dấu vết MOCK, nếu không nhãn MOCK sẽ im lặng biến mất.
      const contentMeta = parseJsonObject(row?.content_meta);
      const mockSteps = collectMockSteps({ ...row, content_meta: contentMeta }, []);
      return {
        id: row.id,
        kind: row.kind ?? 'content',
        source: row.source,
        source_url: row.source_url,
        product_name: row.product_name,
        status: row.status,
        stage: row.stage,
        style: row.style,
        length: row.length,
        created_at: row.created_at,
        updated_at: row.updated_at,
        mock: mockSteps.length > 0,
        mock_steps: mockSteps,
      };
    });
    sendJson(res, 200, { items, total, limit: Number(limit) || 50, offset: Number(offset) || 0 });
  });

  /* ───────────────────── G10 — màn hình kết quả ───────────────────── */

  router.get('/api/jobs/:id', async (req, res, params) => {
    // F-04: job của session khác (hoặc job ImageLab không có session khớp) → 404.
    const job = await requireOwnJob(req, res, params.id);
    const [usage, evidence] = await Promise.all([store.usageSummary(job.id), store.getEvidence(job.id)]);
    sendJson(res, 200, {
      id: job.id,
      source: job.source,
      source_url: job.source_url,
      canonical_url: job.canonical_url,
      source_product_id: job.source_product_id,
      product_name: job.product_name,
      status: job.status,
      stage: job.stage,
      style: job.style,
      length: job.length,
      input_mode: job.input_mode,
      created_at: job.created_at,
      updated_at: job.updated_at,
      finished_at: job.finished_at,
      error_code: job.error_code,
      error_message: job.error_message,
      // G10: các khối mà màn hình kết quả cần
      product_master: job.product_master,
      vision: job.vision,
      knowledge: job.knowledge,
      content: job.content,
      content_meta: job.content_meta,
      evidence: job.evidence,
      usage_summary: usage,
      extraction_evidence: evidence,
      queue_state: queue.stateOf(job.id)?.state || null,
    });
  });

  /* ─────────── G10 — Regenerate (đổi phong cách/độ dài) ─────────── */

  router.post('/api/jobs/:id/regenerate', async (req, res, params) => {
    const sid = sessionId(req, res);
    enforce(rateLimiters.jobs, `regen:${sid}`);
    const job = await requireOwnJob(req, res, params.id); // F-04
    const body = await readJson(req, { maxBytes: 256 * 1024 });
    const opts = parseContentOptions({
      style: body.style ?? job.style,
      length: body.length ?? job.length,
    });

    if (!job.product_master) {
      throw new HttpError(409, 'NO_MASTER', 'Job chưa có Product Master để sinh lại nội dung.');
    }

    // MVP-05 (PB-02, vòng 2): mỗi LƯỢT CHẠY LẠI là một chu kỳ tiền MỚI ⇒ giữ tiền ngay trong
    // request (thiếu ⇒ 402, vượt trần lượt chạy ⇒ 429 RERUN_LIMIT_EXCEEDED — TRƯỚC khi xếp
    // hàng). Trước đây route này không giữ tiền nên mọi lượt regenerate đều miễn phí.
    const hold = await holdCreditBeforeJob(req, job.id, job.kind || 'content');
    try {
      await store.updateJob(job.id, { style: opts.style, length: opts.length, status: JOB_STATUS.QUEUED, stage: 'regenerating' });
      queue.enqueue(job.id, () =>
        pipeline.resumeFromMaster(job.id, job.product_master, {
          sessionId: sid,
          style: opts.style,
          length: opts.length,
          userId: req.user?.id ?? null,
          extraInstructions: sanitizeText(body.extra_instructions, { maxLength: 1000 }),
        }),
        // F6 (phản biện vòng 2): chỗ này CÓ `hold` nhưng trước đây không truyền khoá lượt ⇒ hai
        // tiến trình cùng xếp một lượt chạy lại vẫn tạo 2 mục. Nay đủ 8/8 chỗ.
        { runKey: hold?.run_key ?? null },
      );
    } catch (err) {
      await withHoldRelease(req, job.id, hold, async () => { throw err; }).catch(() => {});
      throw mapBillingError(err) || err;
    }
    sendJson(res, 202, { job_id: job.id, status: JOB_STATUS.QUEUED, style: opts.style, length: opts.length });
  });

  /* ─────────────── G10 — Edit: người dùng sửa nội dung ─────────────── */

  router.put('/api/jobs/:id/content', async (req, res, params) => {
    const job = await requireOwnJob(req, res, params.id); // F-04: chặn GHI trộm qua route cũ
    const body = await readJson(req, { maxBytes: 1024 * 1024 });
    if (!body || typeof body !== 'object') throw new HttpError(400, 'BAD_CONTENT', 'Thiếu nội dung.');

    const ALLOWED = [
      'product_name', 'headline', 'short_description', 'selling_points',
      'detailed_description', 'facebook_caption', 'tiktok_caption',
      'marketplace_description', 'hashtags', 'seo',
    ];
    const next = { ...(job.content || {}) };
    for (const key of ALLOWED) {
      if (!(key in body)) continue;
      if (key === 'seo') {
        next.seo = {
          title: sanitizeText(body.seo?.title, { maxLength: 200 }),
          meta_description: sanitizeText(body.seo?.meta_description, { maxLength: 400 }),
          keywords: Array.isArray(body.seo?.keywords)
            ? body.seo.keywords.map((k) => sanitizeText(k, { maxLength: 120 })).filter(Boolean).slice(0, 20)
            : [],
        };
      } else if (Array.isArray(next[key]) || Array.isArray(body[key])) {
        next[key] = (Array.isArray(body[key]) ? body[key] : [])
          .map((v) => sanitizeText(v, { maxLength: 1200 }))
          .filter(Boolean)
          .slice(0, 20);
      } else {
        next[key] = sanitizeText(body[key], { maxLength: 12000 });
      }
    }

    // Đánh dấu là đã sửa tay — để sau này phân biệt nội dung AI với nội dung người.
    const meta = { ...(job.content_meta || {}), edited_by_user: true, edited_at: new Date().toISOString() };

    await store.updateJob(job.id, {
      content: next,
      content_meta: meta,
      product_name: next.product_name || job.product_name,
    });
    sendJson(res, 200, { job_id: job.id, content: next, content_meta: meta });
  });

  /* ─────────────────────── G13 — usage của job ─────────────────────── */

  router.get('/api/jobs/:id/usage', async (req, res, params) => {
    const job = await requireOwnJob(req, res, params.id); // F-04
    const [events, summary] = await Promise.all([store.listUsage(job.id), store.usageSummary(job.id)]);
    sendJson(res, 200, { job_id: job.id, events, summary });
  });

  /* ─────────────── G11 — upload ảnh (base64 JSON) ─────────────── */

  router.post('/api/uploads', async (req, res) => {
    const sid = sessionId(req, res);
    enforce(rateLimiters.jobs, `upload:${sid}`);
    const body = await readJson(req, { maxBytes: MAX_BODY_BYTES_DEFAULT });
    const files = Array.isArray(body.images) ? body.images : [];
    if (files.length === 0) throw new HttpError(400, 'NO_FILES', 'Thiếu danh sách `images`.');
    if (files.length > config.net.maxUploadFiles) {
      throw new HttpError(413, 'TOO_MANY_FILES', `Tối đa ${config.net.maxUploadFiles} ảnh.`);
    }

    const stored = [];
    for (const f of files) {
      const b64 = typeof f === 'string' ? f : f?.base64;
      if (!b64) continue;
      let buf;
      try {
        buf = Buffer.from(b64, 'base64');
      } catch {
        continue;
      }
      if (buf.length > config.net.maxUploadBytes) {
        throw new HttpError(413, 'FILE_TOO_LARGE', `Ảnh vượt ${config.net.maxUploadBytes} byte.`);
      }
      // Không tin Content-Type client khai — kiểm magic bytes.
      const sniffed = sniffImageMime(buf);
      if (!sniffed || !config.net.allowedImageMime.includes(sniffed)) {
        throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', `Ảnh không hợp lệ hoặc định dạng không được phép.`);
      }
      const id = await store.recordUpload({
        sessionId: sid,
        filename: sanitizeFilename(f?.filename || 'upload'),
        mime: sniffed,
        bytes: buf.length,
        source: 'manual',
      });
      stored.push({ id, mime: sniffed, bytes: buf.length, data_url: `data:${sniffed};base64,${buf.toString('base64')}` });
    }

    if (stored.length === 0) throw new HttpError(400, 'NO_VALID_FILES', 'Không có ảnh hợp lệ nào.');
    sendJson(res, 201, { uploads: stored, count: stored.length });
  });

  /* ══════════ MVP-02 · Dịch ảnh Trung → Việt (hợp đồng 4.5) ══════════ */

  /* ── Tạo job dịch ảnh: nhận ảnh base64 đã kiểm magic bytes ── */

  router.post('/api/imagelab/jobs', async (req, res) => {
    requirePipelineMethod('ingest');
    requirePipelineMethod('runOcr');
    requireStoreMethod('createJob');

    const sid = sessionId(req, res);
    enforce(rateLimiters.jobs, `imagelab:${sid}`);

    const limits = imagelabLimits();
    // base64 phình ~4/3 so với nhị phân — nới body vừa đủ cho một ảnh.
    const body = await readJson(req, {
      maxBytes: Math.min(MAX_BODY_BYTES_DEFAULT, Math.ceil((limits.max_image_bytes * 4) / 3) + 64 * 1024),
    });

    const image = decodeImagelabImage(body.image, limits);
    const options = sanitizeImagelabOptions(body.options, config);

    // Fail-closed: provider chưa cấu hình thì báo ngay, không nhận ảnh rồi để job
    // chết trong hàng đợi mà người dùng không hiểu vì sao.
    if (isUnconfigured(app.ocrProvider) || isUnconfigured(app.translator)) {
      throw HttpError.safe(502, 'NOT_CONFIGURED', 'Provider OCR/dịch chưa được cấu hình — chưa thể dịch ảnh.');
    }

    // MVP-05 (§0 luật 2 + §3.4b): cổng ví TRƯỚC khi ghi job/ảnh ⇒ thiếu credit thì DB
    // KHÔNG tăng dòng nào (job_id sinh trước để hook giữ tiền theo đúng job đó).
    const userId = req.user?.id ?? null;
    const jobId = randomUUID();
    const hold = await holdCreditBeforeJob(req, jobId, 'image_translation');

    try {
      await store.createJob({
        id: jobId,
        sessionId: sid,
        userId,
        source: 'manual',
        inputMode: 'manual',
        kind: 'image_translation',
      });
    } catch (err) {
      await releaseHoldOnFailure(req, jobId);
      throw mapImagelabError(err, 'Không tạo được job dịch ảnh.');
    }

    // Ingest chạy NGAY trong request (xác thực magic bytes thêm một lần, dò kích thước,
    // ghi file + ghi DB) rồi mới xếp hàng OCR. Nhờ vậy:
    //   - `asset_id` trả về là THẬT (hợp đồng 4.5), không phải null;
    //   - ảnh hỏng/không hỗ trợ trả lỗi HTTP ngay, không biến thành một job chết
    //     trong hàng đợi mà người dùng không hiểu vì sao.
    let ingest;
    try {
      ingest = await app.imagelabPipeline.ingest(jobId, { image, sessionId: sid, userId, options });
    } catch (err) {
      // PB-01: ingest lỗi SAU khi đã giữ tiền ⇒ phải hoàn khoản giữ (trước đây chỉ throw).
      // BR-06: đồng thời đánh dấu job `failed` để KHÔNG treo `running` vĩnh viễn.
      await markImagelabJobFailed(jobId, err);
      await releaseHoldOnFailure(req, jobId);
      throw mapImagelabError(err, 'Không lưu được ảnh tải lên.');
    }

    try {
      queue.enqueue(jobId, () => app.imagelabPipeline.runOcr(jobId, { sessionId: sid, userId, options }), { runKey: hold?.run_key ?? null });
    } catch (err) {
      await releaseHoldOnFailure(req, jobId);
      throw err;
    }

    sendJson(res, 202, {
      job_id: jobId,
      asset_id: ingest?.asset_id ?? null,
      status: JOB_STATUS.QUEUED,
      poll: `/api/imagelab/jobs/${jobId}`,
    });
  });

  /* ── Trạng thái job + vùng chữ + bản dịch để duyệt ── */

  router.get('/api/imagelab/jobs/:id', async (req, res, params) => {
    requireImagelab();
    requireStoreMethod('listImageAssets');
    requireStoreMethod('listOcrRegions');
    requireStoreMethod('listTranslationLines');

    const sid = sessionId(req, res);
    const job = await requireImagelabJob(params.id, sid, req);

    const [assets, rawRegions, rawLines] = await Promise.all([
      store.listImageAssets(job.id, {}),
      store.listOcrRegions(job.id),
      store.listTranslationLines(job.id),
    ]);
    // IL08-06: decorator vết hạ mức (module thuần của tầng imagelab, nạp qua loader).
    const traceDowngrade = await loadImagelabFunction('../imagelab/manual-regions.js', 'withKindDowngradeTrace');

    const list = Array.isArray(assets) ? assets : [];
    const originals = list.filter((a) => a.role === 'original');
    const rendered = list.filter((a) => a.role === 'rendered');
    const asset = originals.find((a) => !a.parent_id) || originals[0] || null;
    const lastRendered = rendered[rendered.length - 1] || null;

    sendJson(res, 200, {
      job: jobJson(job),
      asset: assetJson(asset),
      rendered: rendered.map(assetJson),
      regions: (rawRegions || []).map((r) => regionJson(r, traceDowngrade)),
      // IL08-06 (vòng 7): vết hạ mức có cấu trúc — MỞ LẠI TRANG vẫn đọc được (không phải
      // trạng thái in-memory của lần lưu trước). Mỗi vùng cũng mang vết riêng ở `regions[]`.
      kind_downgrades: Array.isArray(job.content_meta?.imagelab?.manual?.kind_downgrades)
        ? job.content_meta.imagelab.manual.kind_downgrades
        : [],
      lines: (rawLines || []).map(lineJson),
      render_summary: buildRenderSummary(lastRendered),
      warnings: collectWarnings(asset, lastRendered),
      providers: imagelabProviders(),
      // F-03 (sau phản biện): nhãn MOCK phải theo DẤU VẾT CỦA JOB, không theo cấu hình
      // máy chủ đang chạy. `mock_steps` đọc từ `content_meta.imagelab.mock_steps` +
      // meta của chính các ảnh thuộc job; `providers_snapshot` là ảnh chụp provider
      // tại THỜI ĐIỂM CHẠY đã lưu trong job (khác `providers` = cấu hình hiện tại).
      mock_steps: collectMockSteps(job, list),
      providers_snapshot: providersSnapshot(job, list),
      // Bổ sung (không nằm trong hợp đồng tối thiểu): vùng OCR bị bỏ + cảnh báo OCR,
      // để UI hiện được "vùng bị bỏ kèm lý do" mà không phải bịa.
      ocr: collectOcrMeta(asset),
    });
  });

  /* ── Người dùng sửa/duyệt từng dòng ── */

  router.put('/api/imagelab/jobs/:id/lines', async (req, res, params) => {
    requireImagelab();
    requireStoreMethod('listTranslationLines');
    requireStoreMethod('updateTranslationLines');

    const sid = sessionId(req, res);
    enforce(rateLimiters.jobs, `imagelab-lines:${sid}`);
    const job = await requireImagelabJob(params.id, sid, req);

    const body = await readJson(req, { maxBytes: 512 * 1024 });
    const edits = sanitizeEdits(body.edits);
    const allowBrandOverride = body.allow_brand_override === true;

    const current = ((await store.listTranslationLines(job.id)) || []).map(lineJson);

    // Luật duyệt dòng nằm ở ĐÚNG MỘT chỗ: `applyReviewEdits` của C2. Ở đây từng có
    // một bản dự phòng chép tay luật đó cho trường hợp C2 chưa tồn tại — nó đã lệch
    // thật (từ chối `action: accept` trên vùng nhãn hiệu trong khi C2 cho phép), nên
    // đã bị xoá. Thiếu module ⇒ báo 503, KHÔNG mô phỏng kết quả.
    const applyReviewEdits = await loadImagelabFunction('../imagelab/translate/index.js', 'applyReviewEdits');
    if (!applyReviewEdits) {
      throw HttpError.safe(503, 'IMAGELAB_UNAVAILABLE', 'Module duyệt bản dịch chưa nạp được trên máy chủ này.');
    }

    let result;
    try {
      const applied = (await applyReviewEdits(current, edits, { allowBrandOverride })) || {};
      result = {
        lines: Array.isArray(applied.lines) ? applied.lines.map(lineJson) : current,
        rejected: asArray(applied.rejected),
        warnings: asArray(applied.warnings).map(String),
      };
    } catch (err) {
      throw mapImagelabError(err, 'Không lưu được bản sửa.');
    }

    await store.updateTranslationLines(job.id, result.lines);

    sendJson(res, 200, { lines: result.lines, rejected: result.rejected, warnings: result.warnings });
  });

  /* ── IL-08: vùng chữ do NGƯỜI DÙNG nhập tay (hợp đồng §11.1) ── */

  router.put('/api/imagelab/jobs/:id/regions', async (req, res, params) => {
    // Thiếu module/phương thức ⇒ 503 IMAGELAB_UNAVAILABLE như mọi route imagelab khác.
    requirePipelineMethod('setManualRegions');
    requireStoreMethod('listImageAssets');
    requireStoreMethod('listOcrRegions');
    requireStoreMethod('saveOcrRegions');
    requireStoreMethod('listTranslationLines');
    requireStoreMethod('saveTranslationLines');
    requireStoreMethod('updateJob');

    const sid = sessionId(req, res);
    enforce(rateLimiters.jobs, `imagelab-regions:${sid}`);
    const job = await requireImagelabJob(params.id, sid, req);

    const body = await readJson(req, { maxBytes: 512 * 1024 });
    const limits = imagelabLimits();

    // Luật §11.1 — mảng rỗng/không phải mảng ⇒ 400; quá trần ⇒ 413 (chặn trước khi chuẩn hoá).
    if (!Array.isArray(body?.regions) || body.regions.length === 0) {
      throw HttpError.safe(400, 'NO_REGIONS', 'Danh sách `regions` phải là mảng có ít nhất 1 vùng chữ (x, y, w, h, chữ Trung).');
    }
    // IL08-04 (vòng 6): trần theo JOB (nếu job có khai `options.max_regions` lúc tạo) phải
    // được áp CÙNG trần cấu hình — trước đây đường nhập tay chỉ đọc trần toàn cục nên job
    // khai `max_regions: 1` vẫn nhận 5 vùng.
    const jobCap = Number(job?.content_meta?.imagelab?.limits?.max_regions);
    const effectiveMaxRegions = Number.isFinite(jobCap) && jobCap > 0
      ? Math.min(limits.max_regions, Math.trunc(jobCap))
      : limits.max_regions;
    if (body.regions.length > effectiveMaxRegions) {
      throw HttpError.safe(
        413,
        'TOO_MANY_REGIONS',
        `Quá nhiều vùng chữ (${body.regions.length}) — tối đa ${effectiveMaxRegions} vùng mỗi lần nhập` +
          `${effectiveMaxRegions !== limits.max_regions ? ' (trần riêng của job này)' : ''}.`,
        { max_regions: effectiveMaxRegions, job_max_regions: Number.isFinite(jobCap) && jobCap > 0 ? Math.trunc(jobCap) : null },
      );
    }

    const regions = sanitizeManualRegionsInput(body.regions);
    // `replace` mặc định true (§11.1): chỉ đổi hành vi khi client gửi ĐÚNG `false`.
    const replace = body?.replace !== false;
    const confirmReplaceEdited = body?.confirm_replace_edited === true;

    // MVP-05 (§3.4b, chỗ #3 trong 5 chỗ đóng băng): nhập lại vùng chữ = chạy lại OCR/dịch
    // (TIÊU credit) ⇒ cổng ví chạy NGAY trong request; thiếu ⇒ 402, không ghi vùng nào.
    const hold = await holdCreditBeforeJob(req, job.id, job.kind || 'image_translation');

    let result;
    try {
      result = await withHoldRelease(req, job.id, hold, () => app.imagelabPipeline.setManualRegions(job.id, {
        sessionId: sid,
        userId: req.user?.id ?? null,
        regions,
        replace,
        confirmReplaceEdited,
        // IL08-01(a): chỉ chặn khi có lượt OCR THẬT đang chờ/đang chạy trong hàng đợi.
        ocrPending: typeof queue?.isPending === 'function' ? queue.isPending(job.id) : null,
      }));
    } catch (err) {
      throw mapImagelabError(err, 'Không lưu được vùng chữ nhập tay.');
    }

    const traceDowngrade = await loadImagelabFunction('../imagelab/manual-regions.js', 'withKindDowngradeTrace');
    sendJson(res, 200, {
      job_id: job.id,
      status: result?.status ?? JOB_STATUS.AWAITING_REVIEW,
      regions: asArray(result?.regions).map((r) => regionJson(r, traceDowngrade)),
      lines: asArray(result?.lines).map(lineJson),
      // Vùng bị bỏ: `{ index, code, reason, text? }` — UI phải hiện ra (§11.2 luật 10).
      rejected: asArray(result?.rejected),
      warnings: asArray(result?.warnings).map(String),
    });
  });

  /* ── Render ảnh đã duyệt (chạy qua queue) ── */

  router.post('/api/imagelab/jobs/:id/render', async (req, res, params) => {
    requirePipelineMethod('renderApproved');
    requireStoreMethod('listTranslationLines');

    const sid = sessionId(req, res);
    enforce(rateLimiters.jobs, `imagelab-render:${sid}`);
    const job = await requireImagelabJob(params.id, sid, req);

    const body = await readJson(req, { maxBytes: 256 * 1024 });
    const requestedRegionIds = Array.isArray(body.only_region_ids) ? body.only_region_ids : null;
    let onlyRegionIds = sanitizeRegionIds(body.only_region_ids);
    let unknownRegionIds = [];
    const force = body.force === true;

    if (isUnconfigured(app.renderProvider)) {
      throw HttpError.safe(502, 'NOT_CONFIGURED', 'Provider render chưa được cấu hình — chưa thể render ảnh.');
    }

    const lines = ((await store.listTranslationLines(job.id)) || []).map(lineJson);
    if (lines.length === 0) {
      throw HttpError.safe(409, 'IMAGELAB_NO_LINES', 'Job chưa có dòng chữ nào để render.');
    }

    // N-4 (vòng 4) + N-11 (vòng 5): `only_region_ids` phải FAIL-CLOSED.
    //  - Trường VẮNG MẶT            ⇒ "render tất cả dòng đã duyệt" (hành vi cũ, hợp đồng 4.4).
    //  - Mảng RỖNG `[]`             ⇒ người dùng KHÔNG chọn vùng nào ⇒ KHÔNG render gì
    //    (trước đây bị hiểu là "không lọc" ⇒ ÂM THẦM render TẤT CẢ: nhiều hơn yêu cầu).
    //  - Có id nhưng KHÔNG id nào khớp ⇒ 409 UNKNOWN_REGION_IDS + danh sách id không khớp.
    if (requestedRegionIds) {
      if (requestedRegionIds.length === 0) {
        throw HttpError.safe(
          400,
          'EMPTY_REGION_IDS',
          '`only_region_ids` là mảng RỖNG — bạn chưa chọn vùng nào nên KHÔNG render gì cả. Bỏ hẳn trường này nếu muốn render tất cả các dòng đã duyệt.',
          { only_region_ids: [] },
        );
      }
      const known = new Set(lines.map((l) => String(l.region_id)));
      const matched = onlyRegionIds.filter((id) => known.has(id));
      const rawIds = requestedRegionIds
        .map((v) => sanitizeText(v, { maxLength: 64 }))
        .filter(Boolean);
      unknownRegionIds = [...new Set([...rawIds, ...onlyRegionIds].filter((id) => !known.has(id)))].slice(0, 100);
      if (matched.length === 0) {
        throw HttpError.safe(
          409,
          'UNKNOWN_REGION_IDS',
          `Không có vùng nào khớp \`only_region_ids\` (${unknownRegionIds.length} id không tồn tại hoặc không hợp lệ) — không render gì cả để tránh vẽ nhiều hơn yêu cầu.`,
          { unknown_region_ids: unknownRegionIds },
        );
      }
      onlyRegionIds = matched;
    }
    // Cùng MỘT hàm luật với `renderApproved` của pipeline (hợp đồng 4.4): dòng
    // `NEEDS_REVIEW` mà `edited_by_user === true` coi như đã được người dùng xử lý.
    // Trước đây route tự lọc `status === 'NEEDS_REVIEW'` nên chặn oan những dòng
    // người dùng đã bấm bỏ qua trong khi pipeline cho qua.
    const pendingReviewLines = await loadImagelabFunction('../imagelab/pipeline.js', 'pendingReviewLines');
    if (!pendingReviewLines) {
      throw HttpError.safe(503, 'IMAGELAB_UNAVAILABLE', 'Module pipeline dịch ảnh chưa nạp được trên máy chủ này.');
    }
    const pending = pendingReviewLines(lines);
    if (pending.length > 0 && !force) {
      throw HttpError.safe(409, 'REVIEW_REQUIRED', `Còn ${pending.length} dòng cần bạn duyệt trước khi render.`, {
        pending_region_ids: pending.map((l) => l.region_id).slice(0, 100),
      });
    }

    // MVP-05 (PB-02, vòng 2): RENDER là một LƯỢT CHẠY có tính tiền ⇒ giữ tiền ngay trong
    // request (thiếu ⇒ 402; vượt trần lượt chạy ⇒ 429 RERUN_LIMIT_EXCEEDED) TRƯỚC khi xếp
    // hàng. Trước đây lượt render không bao giờ bị thu.
    const hold = await holdCreditBeforeJob(req, job.id, job.kind || 'image_translation');
    try {
      await store.updateJob(job.id, {
        status: JOB_STATUS.QUEUED,
        stage: 'rendering',
        error_code: null,
        error_message: null,
      });

      queue.enqueue(job.id, () =>
        app.imagelabPipeline.renderApproved(job.id, {
          sessionId: sid,
          userId: req.user?.id ?? null,
          onlyRegionIds,
          force,
          unknownRegionIds,
        }),
        // R1-F6: khoá idempotency theo LƯỢT CHẠY — hai tiến trình cùng xếp MỘT lượt render chỉ
        // tạo MỘT mục; hai request render KHÁC lượt vẫn là hai mục (đã nghiệm thu ở MVP-05).
        { runKey: hold?.run_key ?? null },
      );
    } catch (err) {
      await withHoldRelease(req, job.id, hold, async () => { throw err; }).catch(() => {});
      throw mapImagelabError(err, 'Không xếp hàng render được.');
    }

    sendJson(res, 202, { job_id: job.id, status: JOB_STATUS.QUEUED, force });
  });

  /* ── Metadata asset (KHÔNG kèm bytes, KHÔNG kèm đường dẫn nội bộ) ── */

  router.get('/api/imagelab/assets/:id', async (req, res, params) => {
    const sid = sessionId(req, res);
    const asset = await requireImagelabAsset(params.id, sid, req);
    sendJson(res, 200, assetJson(asset));
  });

  /* ── File ảnh nhị phân (có kiểm quyền sở hữu như mọi route khác) ── */

  router.get('/api/imagelab/assets/:id/file', async (req, res, params) => {
    const sid = sessionId(req, res);
    const asset = await requireImagelabAsset(params.id, sid, req);

    const allowed = config.net.allowedImageMime || [];
    if (!asset.mime || !allowed.includes(asset.mime)) {
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Định dạng ảnh này không được phép trả về.');
    }

    let buffer;
    try {
      buffer = await app.storage.read(asset);
    } catch (err) {
      logger?.warn?.('imagelab.asset_read_failed', { asset_id: asset.id, error: err });
      throw new HttpError(404, 'ASSET_FILE_NOT_FOUND', 'Không tìm thấy tệp ảnh.');
    }
    if (!buffer || buffer.length === 0) {
      throw new HttpError(404, 'ASSET_FILE_NOT_FOUND', 'Không tìm thấy tệp ảnh.');
    }

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': asset.mime,
      'content-length': buffer.length,
      // Ảnh riêng của từng phiên — cấm mọi cache dùng chung.
      'cache-control': 'private, no-store',
      'content-disposition': `inline; filename="imagelab-${asset.role || 'image'}-${String(asset.id).slice(0, 8)}.${extForMime(asset.mime)}"`,
    });
    res.end(buffer);
  });

  /* ══════════ MVP-03 · Tạo ảnh (Image Generation/Retouching, hợp đồng 3.6) ══════════ */

  /* ── Tạo job tạo ảnh: nhận ảnh base64 đã kiểm magic bytes, ingest NGAY trong request ── */

  router.post('/api/imagestudio/jobs', async (req, res) => {
    requireImagestudioMethod('ingest');
    requireImagestudioMethod('generate');
    requireImagestudioStoreMethod('createJob');
    await requireImagestudioTemplates();

    const sid = sessionId(req, res);
    enforce(rateLimiters.jobs, `imagestudio:${sid}`);

    const limits = imagelabLimits();
    // base64 phình ~4/3 so với nhị phân — nới body vừa đủ cho một ảnh.
    const body = await readJson(req, {
      maxBytes: Math.min(MAX_BODY_BYTES_DEFAULT, Math.ceil((limits.max_image_bytes * 4) / 3) + 64 * 1024),
    });

    // Kiểm ảnh y như MVP-02 (dùng lại ĐÚNG một hàm): không tin Content-Type client khai
    // (magic bytes), chặn theo allowedImageMime + maxImageBytes + maxPixels; lỗi 400/413/415
    // kèm câu tiếng Việt. Không kiểm provider matting ở đây: theo §3.3, tách nền thất bại
    // KHÔNG được làm chết job — vẫn còn đường chỉ-retouch (status PARTIAL).
    const image = decodeImagelabImage(body.image, limits);
    const options = sanitizeImagestudioOptions(body.options);

    // §3.5 — overlay thiếu bằng chứng thì KHÔNG nhận job rồi để nó chạy mà không vẽ: trả 422
    // ngay, chưa tạo job nào (không để lại rác). Job chưa tồn tại nên "chữ gốc" đúng bằng
    // RỖNG ⇒ mọi khẳng định/số liệu đều bị chặn.
    const blocked = await preflightOverlayBlock(null, options);
    if (blocked) return sendImagestudioOverlayBlocked(res, blocked);

    // MVP-05 (§0 luật 2 + §3.4b): cổng ví TRƯỚC khi ghi job/ảnh ⇒ thiếu credit thì DB
    // KHÔNG tăng dòng nào (job_id sinh trước để hook giữ tiền theo đúng job đó).
    const userId = req.user?.id ?? null;
    const jobId = randomUUID();
    const hold = await holdCreditBeforeJob(req, jobId, IMAGESTUDIO_KIND);

    try {
      await store.createJob({
        id: jobId,
        sessionId: sid,
        userId,
        source: 'manual',
        inputMode: 'manual',
        kind: IMAGESTUDIO_KIND,
      });
    } catch (err) {
      await releaseHoldOnFailure(req, jobId);
      throw mapImagestudioError(err, 'Không tạo được job tạo ảnh.');
    }

    // Ingest chạy NGAY trong request (như MVP-02 đã làm) để `asset_id` trả về là THẬT và
    // ảnh hỏng/không hỗ trợ ra HTTP ngay, không biến thành job chết trong hàng đợi.
    let ingest;
    try {
      ingest = await app.imagestudioPipeline.ingest(jobId, { image, sessionId: sid, userId, options });
    } catch (err) {
      await markImagestudioJobFailed(jobId, err);
      // PB-01: ingest lỗi SAU khi đã giữ tiền ⇒ hoàn khoản giữ (job đã failed, không chạy gì).
      await releaseHoldOnFailure(req, jobId);
      throw mapImagestudioError(err, 'Không lưu được ảnh tải lên.');
    }

    try {
      queue.enqueue(jobId, () => app.imagestudioPipeline.generate(jobId, { sessionId: sid, userId, options, force: false }), { runKey: hold?.run_key ?? null });
    } catch (err) {
      await releaseHoldOnFailure(req, jobId);
      throw err;
    }

    sendJson(res, 202, {
      job_id: jobId,
      asset_id: ingest?.asset_id ?? null,
      status: JOB_STATUS.QUEUED,
      poll: `/api/imagestudio/jobs/${jobId}`,
    });
  });

  /* ── Trạng thái job + ảnh gốc/ảnh đã tạo + dấu vết từng bước ── */

  router.get('/api/imagestudio/jobs/:id', async (req, res, params) => {
    requireImagestudio();
    requireImagestudioStoreMethod('listImageAssets');
    const { templates, retouchLimits } = await requireImagestudioTemplates();

    const sid = sessionId(req, res);
    const job = await requireImagestudioJob(params.id, sid, req);

    const list = asArray(await store.listImageAssets(job.id, {}));
    const originals = list.filter((a) => a.role === 'original');
    const rendered = list.filter((a) => a.role === 'rendered');
    const asset = originals.find((a) => !a.parent_id) || originals[0] || null;
    const latest = rendered[rendered.length - 1] || null;

    // E3 ghi dấu vết từng bước vào `meta` của ảnh rendered mới nhất (§3.3). Đọc ĐÚNG những
    // gì đã lưu; chưa chạy tới bước nào ⇒ null/[] — KHÔNG suy diễn, KHÔNG bịa. Chấp nhận cả
    // hai cách đặt khoá (`meta.<bước>` và `meta.imagestudio.<bước>`) để không lệch E3.
    const meta = latest?.meta && typeof latest.meta === 'object' ? latest.meta : {};
    const blob = meta.imagestudio && typeof meta.imagestudio === 'object' ? { ...meta, ...meta.imagestudio } : meta;
    const run = job.content_meta?.imagestudio && typeof job.content_meta.imagestudio === 'object' ? job.content_meta.imagestudio : null;
    // Bản tổng hợp của job CHỈ được ghép vào ảnh khi nó MÔ TẢ ĐÚNG ảnh này (cùng lượt chạy),
    // nếu không sẽ gán số liệu của lượt chạy khác cho ảnh cũ — đúng kiểu "bịa" cần tránh.
    const sameRun = run && latest && run.rendered_asset_id === latest.id ? run : null;
    const traces = imagestudioStepTraces(blob, sameRun);

    sendJson(res, 200, {
      job: jobJson(job),
      asset: assetJson(asset),
      rendered: rendered.map(assetJson),
      matting: traces.matting,
      compose: traces.compose,
      retouch: traces.retouch,
      overlay: blob.overlay ?? null,
      warnings: asArray(blob.warnings).map(String),
      // Bổ sung ngoài danh sách tối thiểu: các field §3.3 bắt buộc ghi lên ảnh rendered
      // (`retouch_effective`, `synthetic_background`) — chuyển thẳng, không diễn giải.
      retouch_effective: blob.retouch_effective ?? null,
      synthetic_background: blob.synthetic_background ?? null,
      // Lượt chạy MỚI NHẤT của job (kể cả khi lượt đó KHÔNG tạo ảnh mới, ví dụ NO_CHANGES):
      // UI cần thấy nó, và nó được tách khỏi dữ liệu của ảnh để không trộn hai lượt.
      last_run: imagestudioLastRun(run),
      providers: imagestudioProviders(),
      templates,
      retouch_limits: retouchLimits,
    });
  });

  /* ── Chạy lại (hoặc chạy tiếp) với tham số mới — ảnh cũ KHÔNG bị ghi đè ── */

  router.post('/api/imagestudio/jobs/:id/generate', async (req, res, params) => {
    requireImagestudioMethod('generate');
    requireImagestudioStoreMethod('listImageAssets');
    requireImagestudioStoreMethod('updateJob');
    await requireImagestudioTemplates();

    const sid = sessionId(req, res);
    enforce(rateLimiters.jobs, `imagestudio-generate:${sid}`);
    const job = await requireImagestudioJob(params.id, sid, req);

    if (String(job.kind ?? '') !== IMAGESTUDIO_KIND) {
      throw HttpError.safe(409, 'IMAGESTUDIO_NOT_IMAGE_JOB', 'Job này không phải job tạo ảnh (`image_generation`) — không chạy tạo ảnh được.');
    }

    const body = await readJson(req, { maxBytes: 256 * 1024 });
    const options = sanitizeImagestudioOptions(body.options);
    // `force` chỉ có nghĩa "chạy lại dù chưa đổi gì" — KHÔNG bao giờ miễn kiểm chống bịa
    // (§3.5): overlay thiếu bằng chứng vẫn bị 422, không có cờ nào mở được đường đó.
    const force = body.force === true;

    const originals = asArray(await store.listImageAssets(job.id, { role: 'original' }));
    if (originals.length === 0) {
      throw HttpError.safe(409, 'IMAGESTUDIO_NO_ORIGINAL', 'Job này chưa có ảnh gốc — hãy tải ảnh lên trước khi tạo ảnh.');
    }

    // 422 TRƯỚC khi xếp hàng (xem `preflightOverlayBlock`): người dùng biết ngay chữ sẽ
    // không được vẽ, thay vì 202 rồi chờ một tấm ảnh không có chữ. Job giữ nguyên trạng thái.
    const blocked = await preflightOverlayBlock(job, options);
    if (blocked) return sendImagestudioOverlayBlocked(res, blocked);

    // MVP-05 (§3.4b, chỗ #5 trong 5 chỗ đóng băng): chạy tạo ảnh là bước TIÊU credit ⇒ cổng
    // ví chạy NGAY trong request; thiếu ⇒ 402 trước khi xếp hàng (job giữ nguyên trạng thái).
    const hold = await holdCreditBeforeJob(req, job.id, IMAGESTUDIO_KIND);

    // PB-01: mọi lỗi SAU khi giữ tiền (ghi trạng thái / xếp hàng) phải hoàn khoản giữ.
    try {
      await store.updateJob(job.id, {
        status: JOB_STATUS.QUEUED,
        stage: 'queued',
        error_code: null,
        error_message: null,
      });

      // Ảnh MỚI: pipeline ghi asset role `rendered` với `parent_id` = ảnh gốc; ảnh cũ còn nguyên.
      queue.enqueue(job.id, () =>
        app.imagestudioPipeline.generate(job.id, { sessionId: sid, userId: req.user?.id ?? null, options, force }),
        { runKey: hold?.run_key ?? null },
      );
    } catch (err) {
      await withHoldRelease(req, job.id, hold, async () => { throw err; }).catch(() => {});
      throw err;
    }

    sendJson(res, 202, { job_id: job.id, status: JOB_STATUS.QUEUED, force, poll: `/api/imagestudio/jobs/${job.id}` });
  });

  /* ── Danh sách mẫu nền MÔ PHỎNG + ngưỡng retouch (UI dựng thanh trượt từ đây) ── */

  router.get('/api/imagestudio/templates', async (req, res) => {
    requireImagestudio();
    const { templates, retouchLimits } = await requireImagestudioTemplates();
    sendJson(res, 200, {
      templates,
      retouch_limits: retouchLimits,
      matting_provider: imagestudioProviderInfo(app.mattingProvider),
    });
  });

  /* ── File ảnh nhị phân (kiểm quyền sở hữu theo session như mọi route khác) ──
   * `GET /api/imagelab/assets/:id/file` cũng đã kiểm quyền theo session và PHỤC VỤ ĐƯỢC ảnh
   * của job MVP-03 (asset cùng bảng, cùng kho). Route này là đường RIÊNG của MVP-03 để UI
   * không phụ thuộc vào việc khối ImageLab có khả dụng hay không.
   */

  router.get('/api/imagestudio/assets/:id/file', async (req, res, params) => {
    const sid = sessionId(req, res);
    const asset = await requireImagestudioAsset(params.id, sid, req);
    const storage = imagestudioStorage();
    if (!storage || typeof storage.read !== 'function') {
      throw HttpError.safe(503, 'IMAGESTUDIO_UNAVAILABLE', 'Không có kho ảnh để đọc tệp — tính năng tạo ảnh chưa sẵn sàng.');
    }

    const allowed = config.net.allowedImageMime || [];
    if (!asset.mime || !allowed.includes(asset.mime)) {
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Định dạng ảnh này không được phép trả về.');
    }

    let buffer;
    try {
      buffer = await storage.read(asset);
    } catch (err) {
      logger?.warn?.('imagestudio.asset_read_failed', { asset_id: asset.id, error_name: err?.name || 'Error' });
      throw new HttpError(404, 'ASSET_FILE_NOT_FOUND', 'Không tìm thấy tệp ảnh.');
    }
    if (!buffer || buffer.length === 0) {
      throw new HttpError(404, 'ASSET_FILE_NOT_FOUND', 'Không tìm thấy tệp ảnh.');
    }

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': asset.mime,
      'content-length': buffer.length,
      // Ảnh riêng của từng phiên — cấm mọi cache dùng chung.
      'cache-control': 'private, no-store',
      'content-disposition': `inline; filename="imagestudio-${asset.role || 'image'}-${String(asset.id).slice(0, 8)}.${extForMime(asset.mime)}"`,
    });
    res.end(buffer);
  });

  /* ══════════ MVP-04 · Video Studio (tạo video ngắn, hợp đồng §2.4) ══════════ */

  /* ── Danh mục preset + bộ mã hoá + trần đầu vào (UI dựng form từ đây) ──
   * Route này KHÔNG trả dữ liệu của ai cả (chỉ danh mục), nhưng vẫn nằm sau cổng "khả dụng"
   * để khi thiếu module thì UI nhận 503 thẳng thắn thay vì một danh sách rỗng gây hiểu sai.
   */

  router.get('/api/videostudio/presets', async (req, res) => {
    requireVideostudio();
    const presets = await requireVideostudioPresets();
    sendJson(res, 200, {
      // §2.1: trả NGUYÊN `VIDEO_PRESETS` (id/label/width/height/fps/max_seconds/synthetic).
      presets,
      encoder: videostudioEncoderInfo(),
      // §2.4: đúng ba khoá `max_image_bytes`/`max_pixels`/`max_seconds`.
      limits: videostudioLimits(presets),
    });
  });

  /* ── Tạo job video: nhận ảnh base64 đã kiểm magic bytes, ingest NGAY trong request ── */

  router.post('/api/videostudio/jobs', async (req, res) => {
    requireVideostudioMethod('ingest');
    requireVideostudioMethod('generate');
    requireVideostudioStoreMethod('createJob');

    const sid = sessionId(req, res);
    enforce(rateLimiters.jobs, `videostudio:${sid}`);

    const limits = videostudioImageLimits();
    // base64 phình ~4/3 so với nhị phân — nới body vừa đủ cho một ảnh (giống MVP-02/03).
    const body = await readJson(req, {
      maxBytes: Math.min(MAX_BODY_BYTES_DEFAULT, Math.ceil((limits.max_image_bytes * 4) / 3) + 64 * 1024),
    });

    // Kiểm ảnh y như MVP-02/03 (dùng lại ĐÚNG một hàm): không tin Content-Type client khai
    // (magic bytes), chặn theo allowedImageMime + maxImageBytes + maxPixels ⇒ 400/413/415
    // kèm câu tiếng Việt. Ảnh gốc bất biến là việc của V3 (kiểm sha256 cuối lượt).
    const images = collectVideostudioImages(body, limits);
    const options = sanitizeVideostudioOptions(body.options);

    // §0 luật 3 — chữ thiếu bằng chứng thì KHÔNG nhận job rồi để pipeline chạy mà không vẽ:
    // trả 422 ngay, CHƯA tạo job nào (không để lại rác). Job chưa tồn tại nên "dữ liệu đã lưu"
    // đúng bằng RỖNG ⇒ mọi khẳng định/số liệu trong `options.texts` đều bị chặn.
    const blocked = await preflightVideostudioTexts(null, options);
    if (blocked) return sendVideostudioTextBlocked(res, blocked);

    // MVP-05 (§0 luật 2 + §3.4b): cổng ví chạy NGAY TRONG REQUEST và TRƯỚC khi ghi job ⇒ thiếu
    // credit thì DB KHÔNG tăng dòng nào (`job_id` sinh trước để hook giữ tiền theo đúng job đó).
    const userId = req.user?.id ?? null;
    const jobId = randomUUID();
    const hold = await holdCreditBeforeJob(req, jobId, VIDEOSTUDIO_KIND);

    try {
      await withHoldRelease(req, jobId, hold, () =>
        store.createJob({
          id: jobId,
          sessionId: sid,
          userId,
          source: 'manual',
          inputMode: 'manual',
          kind: VIDEOSTUDIO_KIND,
        }));
    } catch (err) {
      throw mapVideostudioError(err, 'Không tạo được job tạo video.');
    }

    // Ingest chạy NGAY trong request (như MVP-02/03) để `asset_id` trả về là THẬT và ảnh
    // hỏng/không hỗ trợ ra HTTP ngay, không biến thành job chết trong hàng đợi. Mỗi ảnh là MỘT
    // cảnh (V3 đánh số cảnh theo thứ tự đã lưu).
    const ingested = [];
    try {
      await withHoldRelease(req, jobId, hold, async () => {
        for (const image of images) {
          ingested.push(await app.videostudioPipeline.ingest(jobId, { image, sessionId: sid, userId, options }));
        }
      });
    } catch (err) {
      // Ingest lỗi SAU khi job đã tạo ⇒ đánh dấu `failed` (KHÔNG treo `queued`) rồi mới trả lỗi;
      // `withHoldRelease` đã hoàn khoản giữ nên không ai bị trừ tiền cho một job không chạy.
      await markVideostudioJobFailed(jobId, err);
      const mapped = mapVideostudioError(err, 'Không lưu được ảnh tải lên.');
      if (mapped.status === 422 && mapped.code === 'VIDEO_TEXT_UNSUPPORTED_CLAIM') {
        return sendVideostudioTextBlocked(res, {
          code: mapped.code,
          message: mapped.message,
          violations: asArray(mapped.details?.violations),
        });
      }
      throw mapped;
    }

    // Mỗi LƯỢT CHẠY có `run_key` riêng (§2.3). Ưu tiên `run_key` của khoản giữ (hook A3 sinh
    // theo `<jobId>#<n>`) để usage của V3 quy được về ĐÚNG lượt đã mở trong sổ ví; khách ẩn
    // danh (không ví) thì tự sinh một khoá duy nhất cho lượt này.
    const runKey = hold?.run_key || randomUUID();
    try {
      await withHoldRelease(req, jobId, hold, async () => {
        queue.enqueue(jobId, () => app.videostudioPipeline.generate(jobId, { sessionId: sid, options, runKey }), { runKey });
      });
    } catch (err) {
      throw mapVideostudioError(err, 'Không xếp được lượt tạo video.');
    }

    sendJson(res, 202, {
      job_id: jobId,
      // `asset_id` = ẢNH GỐC ĐẦU TIÊN (cảnh 1) — field ĐÓNG BĂNG của §2.4; `asset_ids` là danh
      // sách đầy đủ khi yêu cầu mang nhiều ảnh (UI V5 cần để biết job có mấy cảnh).
      asset_id: ingested[0]?.asset_id ?? null,
      asset_ids: ingested.map((item) => item?.asset_id ?? null).filter(Boolean),
      status: JOB_STATUS.QUEUED,
      poll: `/api/videostudio/jobs/${jobId}`,
    });
  });

  /* ── Trạng thái job + ảnh gốc + các video đã tạo + kế hoạch/mã hoá của video mới nhất ── */

  router.get('/api/videostudio/jobs/:id', async (req, res, params) => {
    requireVideostudio();
    requireVideostudioStoreMethod('listImageAssets');

    const sid = sessionId(req, res);
    const job = await requireVideostudioJob(params.id, sid, req);

    const list = asArray(await store.listImageAssets(job.id, {}));
    const originals = list.filter((a) => a.role === 'original');
    const rendered = list.filter((a) => a.role === 'rendered');
    const asset = originals.find((a) => !a.parent_id) || originals[0] || null;
    const latest = rendered[rendered.length - 1] || null;

    // V3 ghi kế hoạch / tóm tắt mã hoá / cảnh báo vào `meta` của video `rendered` MỚI NHẤT
    // (§2.3 lưu `meta.plan_summary` + `meta.encode_summary`; §2.4 gọi ra là `plan`/`encode`).
    // Đọc ĐÚNG những gì đã lưu — chưa chạy tới bước nào thì `null`/`[]`, KHÔNG suy diễn, KHÔNG bịa.
    const meta = latest?.meta && typeof latest.meta === 'object' ? latest.meta : {};
    const blob = meta.videostudio && typeof meta.videostudio === 'object' ? { ...meta, ...meta.videostudio } : meta;
    const run =
      job.content_meta?.videostudio && typeof job.content_meta.videostudio === 'object' ? job.content_meta.videostudio : null;
    const presets = await videostudioPresets();

    sendJson(res, 200, {
      job: jobJson(job),
      asset: assetJson(asset),
      // Mọi video đã tạo (không ghi đè cái cũ) — ảnh gốc nằm ở `asset`, không trộn vào đây.
      rendered: rendered.map(assetJson),
      plan: blob.plan ?? blob.plan_summary ?? null,
      encode: blob.encode ?? blob.encode_summary ?? null,
      // F4: BẰNG CHỨNG đã dùng để cho phép vẽ chữ (`{sources, region_ids, chars}`) — người duyệt
      // nhìn là biết vì sao chữ này được vẽ (product_name / ocr_region / user_region / job_notes).
      evidence_used: blob.evidence_used ?? run?.evidence_used ?? null,
      // §0 luật 2: video offline KHÔNG có tiếng — trả ĐÚNG giá trị đã lưu, thiếu ⇒ null.
      audio: blob.audio ?? null,
      // F9 (phản biện MVP-04, MINOR): đường job LỖI không có asset `rendered` ⇒ `blob.warnings` rỗng
      // dù `content_meta.videostudio.warnings` đã có (ví dụ câu “Video KHÔNG có tiếng…”). Gộp cả hai
      // nguồn (khử trùng, giữ thứ tự) để mọi đường trả cùng một danh sách cảnh báo.
      warnings: [...new Set([
        ...asArray(blob.warnings).map(String),
        ...asArray(run?.warnings).map(String),
      ])].filter(Boolean),
      providers: videostudioProviders(),
      presets: Array.isArray(presets) ? presets : null,
      last_run: videostudioLastRun(run),
    });
  });

  /* ── Chạy lượt MỚI (mở `run_key` mới) — video cũ KHÔNG bị ghi đè ── */

  router.post('/api/videostudio/jobs/:id/generate', async (req, res, params) => {
    requireVideostudioMethod('generate');
    requireVideostudioStoreMethod('listImageAssets');
    requireVideostudioStoreMethod('updateJob');

    const sid = sessionId(req, res);
    enforce(rateLimiters.jobs, `videostudio-generate:${sid}`);
    const job = await requireVideostudioJob(params.id, sid, req);

    if (String(job.kind ?? '') !== VIDEOSTUDIO_KIND) {
      throw HttpError.safe(409, 'VIDEOSTUDIO_NOT_VIDEO_JOB', 'Job này không phải job tạo video (`video_generation`) — không chạy tạo video được.');
    }

    const body = await readJson(req, { maxBytes: 256 * 1024 });
    const options = sanitizeVideostudioOptions(body.options);
    // `force` chỉ có nghĩa "chạy lại dù chưa đổi gì" — KHÔNG bao giờ miễn kiểm chống bịa (§0 luật 3).
    const force = body.force === true;

    // Thứ tự kiểm CỐ Ý: thiếu ảnh gốc TRƯỚC (lỗi cụ thể, người dùng biết phải làm gì), rồi mới
    // tới "đang chạy". Job đang chạy thật thì LUÔN đã có ảnh gốc, nên không có ca nào bị che.
    const originals = asArray(await store.listImageAssets(job.id, { role: 'original' }));
    if (originals.length === 0) {
      throw HttpError.safe(409, 'VIDEOSTUDIO_NO_ORIGINAL', 'Job này chưa có ảnh gốc — hãy tải ảnh lên trước khi tạo video.');
    }

    // BR-02 (MVP-05): job ĐANG CHẠY/đang chờ ⇒ lượt thứ hai bị chặn bằng 409, không mở hai lượt
    // song song trên cùng một job. Hook ví cũng chặn ca này, nhưng khách ẨN DANH không có ví nên
    // route phải tự chặn — nếu không, ẩn danh sẽ chạy được nhiều lượt chồng nhau.
    if (job.status === JOB_STATUS.QUEUED || job.status === JOB_STATUS.RUNNING) {
      throw HttpError.safe(409, 'JOB_ALREADY_RUNNING', 'Job này đang chạy một lượt khác — chờ lượt đó xong rồi hãy chạy lại.', {
        job_id: job.id,
        run_key: null,
      });
    }

    // 422 TRƯỚC khi xếp hàng: người dùng biết ngay chữ sẽ không được vẽ, thay vì 202 rồi chờ
    // một video không có chữ. Bằng chứng lấy từ dữ liệu ĐÃ LƯU của job, không lấy từ body.
    const blocked = await preflightVideostudioTexts(job, options);
    if (blocked) return sendVideostudioTextBlocked(res, blocked);

    // MVP-05 (§3.4b): chạy tạo video là bước TIÊU credit ⇒ cổng ví chạy NGAY trong request;
    // thiếu ⇒ 402 (hoặc 409 nếu lượt cũ còn mở) TRƯỚC khi xếp hàng, job giữ nguyên trạng thái.
    const hold = await holdCreditBeforeJob(req, job.id, VIDEOSTUDIO_KIND);
    const runKey = hold?.run_key || randomUUID();

    try {
      await store.updateJob(job.id, {
        status: JOB_STATUS.QUEUED,
        stage: 'queued',
        error_code: null,
        error_message: null,
      });

      // Video MỚI: V3 ghi asset role `rendered` với `parent_id` = ảnh gốc; video cũ còn nguyên.
      queue.enqueue(job.id, () => app.videostudioPipeline.generate(job.id, { sessionId: sid, options, runKey }), { runKey });
    } catch (err) {
      await withHoldRelease(req, job.id, hold, async () => { throw err; }).catch(() => {});
      throw mapVideostudioError(err, 'Không chạy được lượt tạo video mới.');
    }

    sendJson(res, 202, {
      job_id: job.id,
      status: JOB_STATUS.QUEUED,
      run_key: runKey,
      force,
      poll: `/api/videostudio/jobs/${job.id}`,
    });
  });

  /* ── Tệp nhị phân (GIF/MP4) — kiểm quyền sở hữu, KHÔNG BAO GIỜ lộ `storage_path` ── */

  router.get('/api/videostudio/assets/:id/file', async (req, res, params) => {
    const sid = sessionId(req, res);
    const asset = await requireVideostudioAsset(params.id, sid, req);
    const storage = videostudioStorage();
    if (!storage || typeof storage.read !== 'function') {
      throw HttpError.safe(503, 'VIDEOSTUDIO_UNAVAILABLE', 'Không có kho tệp để đọc — tính năng tạo video chưa sẵn sàng.');
    }

    // `Content-Type` THẬT của tệp: ảnh/GIF theo `ALLOWED_IMAGE_MIME`, thêm `video/mp4` cho
    // provider `ffmpeg`. Ngoài danh sách ⇒ 415 (không đoán bừa định dạng để trình duyệt tự hiểu).
    const mime = String(asset.mime || '');
    const allowed = [...(config.net.allowedImageMime || []), ...VIDEOSTUDIO_EXTRA_MIME];
    if (!mime || !allowed.includes(mime)) {
      throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Định dạng tệp này không được phép trả về.');
    }

    let buffer;
    try {
      buffer = await storage.read(asset);
    } catch (err) {
      logger?.warn?.('videostudio.asset_read_failed', { asset_id: asset.id, error_name: err?.name || 'Error' });
      throw new HttpError(404, 'ASSET_FILE_NOT_FOUND', 'Không tìm thấy tệp video.');
    }
    if (!buffer || buffer.length === 0) {
      throw new HttpError(404, 'ASSET_FILE_NOT_FOUND', 'Không tìm thấy tệp video.');
    }

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': mime,
      'content-length': buffer.length,
      // Tệp riêng của từng phiên/tài khoản — cấm mọi cache dùng chung.
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename="videostudio-${asset.role || 'video'}-${String(asset.id).slice(0, 8)}.${videostudioExtForMime(mime)}"`,
    });
    res.end(buffer);
  });

  /* ═══════════ MVP-06 · GÓI XUẤT BẢN (.zip) — hợp đồng docs/EXPORT-CONTRACT.md §3 ═══════════
   * CHỈ THÊM route mới: khối này không chạm vào bất kỳ route cũ nào.
   *
   * Module X1 (`src/exports/**`) do agent khác viết song song nên có thể CHƯA có mặt — xử lý
   * y như MVP-02/03/04 với module anh em: KHÔNG static-import (một import hỏng sẽ giết cả
   * MVP-01..05), KHÔNG sửa `src/app.js`; nạp phòng thủ bằng dynamic import trong try/catch
   * ngay tại route, thiếu module ⇒ 503 `EXPORT_UNAVAILABLE` kèm câu tiếng Việt.
   */

  const EXPORT_UNAVAILABLE_MESSAGE =
    'Tính năng gói xuất bản chưa nạp được trên máy chủ này — tạm thời chưa tải được gói (.zip).';

  /**
   * Log lỗi của khối export: CHỈ tên/mã lỗi + message đã lọc đường dẫn.
   * KHÔNG log nội dung gói, KHÔNG log `storage_path`/`session_id` (hợp đồng §3).
   */
  const logExportError = (event, err) => {
    const message = String(err?.message ?? err ?? '')
      .replace(/\/(?:Users|home|private|tmp|var|opt|mnt|Volumes)\/\S*/g, '<path>')
      .slice(0, 300);
    logger?.error?.(event, { error_name: err?.name || 'Error', error_code: err?.code || null, error_message: message });
  };

  /** Nạp module X1 một lần cho mỗi router; lỗi ⇒ `null` (KHÔNG ném ra ngoài). */
  let exportModulePromise = null;
  const importExportModule = async () => {
    try {
      const mod = await import('../exports/index.js');
      if (typeof mod?.buildExportBundle !== 'function') {
        logExportError('exports.module_export_missing', Object.assign(new Error('thiếu export buildExportBundle'), { code: 'EXPORT_EXPORT_MISSING' }));
        return null;
      }
      return mod;
    } catch (err) {
      logExportError('exports.module_load_failed', err);
      return null;
    }
  };

  /**
   * Lấy module X1: ưu tiên `app.exports` (điểm bơm của tầng gộp), nếu không có thì dynamic
   * import `../exports/index.js`. Kết quả được NHỚ theo router để không import lại mỗi request.
   */
  const loadExportModule = () => {
    const injected = app?.exports;
    if (injected && typeof injected.buildExportBundle === 'function') return Promise.resolve(injected);
    if (!exportModulePromise) exportModulePromise = importExportModule();
    return exportModulePromise;
  };

  /** Lý do THẬT khi khối export không khả dụng (app.js/tầng gộp có thể bơm câu đã lọc). */
  const exportUnavailableMessage = () => {
    const reason = app?.exportsUnavailableReason;
    return typeof reason === 'string' && reason.trim() ? reason : EXPORT_UNAVAILABLE_MESSAGE;
  };

  /**
   * Khối export có được phép chạy không. `app.exportsUnavailableReason` (chuỗi khác rỗng) là
   * công tắc TẮT tường minh — cùng khuôn `imagelabUnavailableReason`/`videostudioUnavailableReason`
   * của file này, để tầng gộp (hoặc test) nói được "module chưa nạp" mà không phải xoá file.
   */
  const exportsEnabled = () => {
    const reason = app?.exportsUnavailableReason;
    return !(typeof reason === 'string' && reason.trim());
  };

  /** Thiếu module/tắt tường minh ⇒ 503 nói thẳng, KHÔNG mô phỏng gói rỗng (hợp đồng §3). */
  const requireExportModule = async () => {
    if (!exportsEnabled()) throw HttpError.safe(503, 'EXPORT_UNAVAILABLE', exportUnavailableMessage());
    const mod = await loadExportModule();
    if (!mod) throw HttpError.safe(503, 'EXPORT_UNAVAILABLE', exportUnavailableMessage());
    return mod;
  };

  /** Cờ cho `/api/config` — CHỈ cờ, không lộ đường dẫn/bí mật/phiên bản module. */
  // D6 (LOW): `available` phải phản ánh ĐỦ điều kiện chạy được — thiếu `storage` thì UI không được
  // hứa "tải được" rồi trả 503/500.
  const exportsAvailable = async () =>
    exportsEnabled()
    && Boolean(await loadExportModule())
    && Boolean(app?.storage && typeof app.storage.read === 'function');

  /**
   * Quyền sở hữu y HỆT route job khác (`requireOwnJob`: id rác ⇒ 400, job lạ/khác tài khoản
   * ⇒ 404, đã đăng nhập thì `jobs.user_id` phải khớp), nhưng chặt thêm MỘT nhịp cho riêng
   * gói xuất bản: gói chứa TOÀN BỘ nội dung + ảnh + video của job, nên request KHÔNG khai
   * cookie session nào cũng bị coi là khác chủ (404) — cố ý không nới luật "khách không khai
   * session" của route chi tiết job MVP-01 cho một tệp chứa tất cả dữ liệu.
   */
  const requireOwnExportJob = async (req, res, id) => {
    const job = await requireOwnJob(req, res, id);
    // D4 (phản biện, MEDIUM): job KHÔNG có chủ (không `user_id` VÀ không `session_id`) thì gói dữ
    // liệu đầy đủ KHÔNG được mở cho người lạ — trước đây ai cũng tải được (200 kể cả không cookie).
    if (job.user_id == null && !job.session_id) {
      logger?.warn?.('exports.ownerless_job_denied', { job_id: job.id });
      throw new HttpError(404, 'JOB_NOT_FOUND', 'Không tìm thấy job.');
    }
    if (job.user_id == null && job.session_id) {
      const sid = sessionId(req, res);
      if (String(sid) !== String(job.session_id)) {
        throw new HttpError(404, 'JOB_NOT_FOUND', 'Không tìm thấy job.');
      }
    }
    return job;
  };

  /** Lỗi của module X1 ⇒ HTTP an toàn; KHÔNG BAO GIỜ trả message/stack nội bộ của module. */
  const mapExportError = (err) => {
    const code = String(err?.code || '').trim().toUpperCase();
    if (code === 'JOB_NOT_FOUND') return new HttpError(404, 'JOB_NOT_FOUND', 'Không tìm thấy job.');
    if (code === 'BAD_JOB_ID' || code === 'INVALID_JOB_ID') {
      return new HttpError(400, 'BAD_JOB_ID', 'Mã job không hợp lệ.');
    }
    // Module X1 tự nói nó chưa sẵn sàng (kho ảnh chưa nạp, ...) ⇒ giữ đúng 503 như hợp đồng.
    if (code === 'EXPORT_UNAVAILABLE') return HttpError.safe(503, 'EXPORT_UNAVAILABLE', exportUnavailableMessage());
    // D6: thiếu `storage` (kho asset chưa nạp) là "chưa sẵn sàng", KHÔNG phải lỗi 500 của gói.
    if (code === 'BAD_INPUT' && /storage/i.test(String(err?.message ?? ''))) {
      return HttpError.safe(503, 'EXPORT_UNAVAILABLE', exportUnavailableMessage());
    }
    // R6 (phản biện vòng 2, MEDIUM): gói vượt TRẦN KÍCH THƯỚC ⇒ 413 kèm SỐ ĐO thật (bytes/limit),
    // KHÔNG phải 500 "thử lại" (thử lại y hệt vẫn vượt trần) và KHÔNG được dựng tiếp cho hết RAM.
    if (code === 'BUNDLE_TOO_LARGE') {
      const details = err?.details && typeof err.details === 'object' ? err.details : {};
      const bytes = Number(details.bytes);
      const limit = Number(details.limit);
      const measured = Number.isFinite(bytes) && Number.isFinite(limit)
        ? ` Đo được ${bytes} byte, trần cho phép ${limit} byte.`
        : '';
      logger?.warn?.('exports.bundle_too_large', {
        job_id: details.jobId ?? null,
        bytes: Number.isFinite(bytes) ? bytes : null,
        limit: Number.isFinite(limit) ? limit : null,
      });
      return HttpError.safe(
        413,
        'BUNDLE_TOO_LARGE',
        `Gói xuất bản vượt trần kích thước máy chủ cho phép nên bị từ chối dựng (để không ăn hết bộ nhớ).${measured}`,
        { bytes: Number.isFinite(bytes) ? bytes : null, limit: Number.isFinite(limit) ? limit : null, max_bundle_bytes: Number.isFinite(limit) ? limit : null },
      );
    }
    // R6: quá nhiều lượt dựng gói đồng thời ⇒ 429 `EXPORT_BUSY` (KHÁC 429 RATE_LIMITED theo phiên).
    if (code === 'EXPORT_BUSY') {
      const details = err?.details && typeof err.details === 'object' ? err.details : {};
      logger?.warn?.('exports.busy', { running: details.running ?? null, queued: details.queued ?? null, concurrency: details.concurrency ?? null });
      const retryAfterMs = Number.isFinite(Number(details.retry_after_ms)) ? Number(details.retry_after_ms) : 2000;
      return Object.assign(
        HttpError.safe(
          429,
          'EXPORT_BUSY',
          'Máy chủ đang dựng một gói xuất bản khác và hàng đợi đã đầy — chờ một lát rồi thử lại (mỗi lúc chỉ dựng vài gói để không hết bộ nhớ).',
          { ...details, retry_after_ms: retryAfterMs },
        ),
        { retryAfterMs },
      );
    }
    logExportError('exports.bundle_build_failed', err);
    return HttpError.safe(500, 'EXPORT_FAILED', 'Không dựng được gói xuất bản. Vui lòng thử lại.');
  };

  /**
   * `Content-Disposition` an toàn: tên tệp của X1 được LỌC LẠI ở đây (bỏ CR/LF/ngoặc kép để
   * không chèn được header), chỉ nhận tập ký tự ASCII an toàn; tên gốc có ký tự ngoài ASCII
   * thì thêm biến thể RFC 5987 `filename*=UTF-8''…` cho trình duyệt.
   */
  const exportDisposition = (rawName, jobId) => {
    const raw = String(rawName ?? '').replace(/[\r\n"]/g, '').trim();
    let safe = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._-]+/, '').slice(0, 120);
    if (!safe) safe = `goi-xuat-ban-${String(jobId).slice(0, 8)}.zip`;
    if (!/\.zip$/i.test(safe)) safe = `${safe}.zip`;
    const parts = [`attachment; filename="${safe}"`];
    if (/[^\x20-\x7E]/.test(raw)) parts.push(`filename*=UTF-8''${encodeURIComponent(raw).slice(0, 180)}`);
    return parts.join('; ');
  };

  /**
   * R6 — TRẦN KÍCH THƯỚC GÓI + CỔNG GIỚI HẠN SỐ LƯỢT DỰNG GÓI ĐỒNG THỜI.
   *
   * Vì sao không static-import `src/exports/limits.js`: cùng lý do như module X1 ở trên — một
   * import hỏng (bản sao repo đã xoá `src/exports/**`, xem test 503) sẽ giết cả server. Nên giới
   * hạn được đọc qua module đã nạp phòng thủ, kèm bản dự phòng tối thiểu (fail-closed).
   *
   * `app.exportLimits` (nếu có) được QUYỀN GHI ĐÈ — điểm bơm cho test/vận hành, cùng khuôn với
   * `app.exports` và `app.exportsUnavailableReason`.
   */
  const EXPORT_FALLBACK_LIMITS = Object.freeze({ maxBundleBytes: 64 * 1024 * 1024, maxConcurrentBundles: 1, maxQueuedBundles: 4, maxWaitMs: 30_000 });

  const exportLimits = (mod) => {
    const base = typeof mod?.resolveExportLimits === 'function' ? mod.resolveExportLimits(process.env) : { ...EXPORT_FALLBACK_LIMITS };
    const injected = app?.exportLimits;
    return injected && typeof injected === 'object' ? { ...base, ...injected } : base;
  };

  /** Cổng dự phòng khi module X1 chưa có `createExportGate` (bản cũ hơn bản vá R6) — KHÔNG fail-open. */
  const fallbackExportGate = (concurrency, queueLimit) => {
    let running = 0;
    const waiting = [];
    const stats = () => ({ running, queued: waiting.length, concurrency, queue_limit: queueLimit });
    const release = () => {
      const next = waiting.shift();
      if (next) next();
      else running = Math.max(0, running - 1);
    };
    return {
      stats,
      async run(fn) {
        if (running >= concurrency) {
          if (waiting.length >= queueLimit) {
            throw Object.assign(
              new Error(`Máy chủ đang dựng ${running} gói xuất bản và hàng đợi đã đầy (${waiting.length}/${queueLimit}) — từ chối thêm để không ăn hết bộ nhớ.`),
              { code: 'EXPORT_BUSY', details: { ...stats(), retry_after_ms: 2000 } },
            );
          }
          await new Promise((resolve) => waiting.push(resolve));
        } else {
          running += 1;
        }
        try {
          return await fn();
        } finally {
          release();
        }
      },
    };
  };

  let exportGate = null;
  let exportGateKey = '';
  /** Một cổng cho mỗi router; đổi giới hạn ⇒ dựng lại (test bơm `app.exportLimits` trước request). */
  const exportGateFor = (mod, limits) => {
    const key = `${limits.maxConcurrentBundles}/${limits.maxQueuedBundles}/${limits.maxWaitMs}`;
    if (!exportGate || exportGateKey !== key) {
      if (typeof mod?.createExportGate === 'function') {
        exportGate = mod.createExportGate({ concurrency: limits.maxConcurrentBundles, queueLimit: limits.maxQueuedBundles, maxWaitMs: limits.maxWaitMs });
      } else {
        logger?.warn?.('exports.gate_without_limiter', { message: 'Module X1 chưa có `createExportGate` ⇒ dùng cổng dự phòng của route.' });
        exportGate = fallbackExportGate(limits.maxConcurrentBundles, limits.maxQueuedBundles);
      }
      exportGateKey = key;
    }
    return exportGate;
  };

  /**
   * Dựng gói qua module X1. Cả hai route dùng CHUNG hàm này để `manifest` trả qua API và
   * `MANIFEST.json` trong gói luôn là MỘT nguồn sự thật (không có hai bản kê khai lệch nhau).
   */
  const buildBundleFor = async (jobId, { zip = true } = {}) => {
    const mod = await requireExportModule();
    const limits = exportLimits(mod);
    // R6: chỉ đường TẢI GÓI (.zip) đi qua cổng — `/manifest` không nén, chỉ đọc + băm, nhưng vẫn
    // chịu CÙNG trần byte để một job khổng lồ không kéo cả kho ảnh vào RAM.
    const gate = zip ? exportGateFor(mod, limits) : null;
    try {
      // D5 (phản biện Gói xuất bản, MEDIUM): route `/manifest` KHÔNG được dựng cả ZIP rồi bỏ
      // buffer — job 60 MB asset tốn ~2,3s CPU + ~245 MB RSS cho một phản hồi 10 KB. Module X1 có
      // đường `buildExportManifest` (chỉ kê khai, không nén); thiếu nó (bản cũ) ⇒ rơi về đường cũ.
      const onlyManifest = zip === false && typeof mod.buildExportManifest === 'function';
      if (zip === false && !onlyManifest) {
        logger?.warn?.('exports.manifest_without_zip_builder', {
          message: 'Module X1 chưa có `buildExportManifest` ⇒ route /manifest phải dựng cả ZIP (chậm hơn).',
        });
      }
      const build = async () => {
        const built = await (onlyManifest ? mod.buildExportManifest : mod.buildExportBundle)({
          store,
          // Gói chỉ ĐỌC asset đã có trên đĩa; X1 tự quyết cách đọc, routes.js không ghép đường dẫn.
          storage: app?.storage ?? null,
          jobId,
          logger,
          // R6: trần byte có cấu hình (`EXPORT_MAX_BUNDLE_BYTES`) — X1 ném `BUNDLE_TOO_LARGE`
          // NGAY khi tổng byte vượt trần, không dựng tiếp.
          maxTotalBytes: limits.maxBundleBytes,
        });
        if (zip === false) {
          // Đường chỉ-manifest: bắt buộc có `manifest`, KHÔNG cần buffer.
          if (!built || !built.manifest) {
            throw Object.assign(new Error('buildExportManifest không trả về manifest hợp lệ'), { code: 'BAD_BUNDLE' });
          }
          return built;
        }
        if (!built || !Buffer.isBuffer(built.buffer) || built.buffer.length === 0) {
          throw Object.assign(new Error('buildExportBundle không trả về buffer hợp lệ'), { code: 'BAD_BUNDLE' });
        }
        return built;
      };
      return gate ? await gate.run(build) : await build();
    } catch (err) {
      throw mapExportError(err);
    }
  };

  /* ── Tải gói .zip (nhị phân) — rate limit CHUNG `rateLimiters.jobs`, key `export:${sid}` ── */

  router.get('/api/exports/jobs/:id/bundle', async (req, res, params) => {
    // Chế độ TẮT ẩn danh: gói xuất bản là route nghiệp vụ ⇒ bắt buộc đăng nhập (như /api/jobs/*).
    if (!anonymousAllowed()) requireUser(req);
    const sid = sessionId(req, res);
    enforce(rateLimiters.jobs, `export:${sid}`);
    const job = await requireOwnExportJob(req, res, params.id);
    const built = await buildBundleFor(job.id);

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': 'application/zip',
      'content-length': built.buffer.length,
      // Gói là dữ liệu riêng của một phiên/tài khoản — cấm mọi cache dùng chung (hợp đồng §3).
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      // Luôn là tệp ĐÍNH KÈM (không bao giờ inline) để trình duyệt tải về chứ không hiển thị.
      'content-disposition': exportDisposition(built.filename, job.id),
    });
    // Chỉ log SỐ LIỆU (byte/số entry) — không log nội dung gói, không log đường dẫn.
    logger?.info?.('exports.bundle_served', {
      job_id: job.id,
      bytes: built.buffer.length,
      entries: Array.isArray(built.entries) ? built.entries.length : null,
    });
    res.end(built.buffer);
  });

  /* ── Bản kê khai rời (JSON) — cùng nguồn với MANIFEST.json trong gói ── */

  router.get('/api/exports/jobs/:id/manifest', async (req, res, params) => {
    if (!anonymousAllowed()) requireUser(req);
    const sid = sessionId(req, res);
    enforce(rateLimiters.jobs, `export:${sid}`);
    const job = await requireOwnExportJob(req, res, params.id);
    // D5: CHỈ dựng manifest — không tạo ZIP.
    const built = await buildBundleFor(job.id, { zip: false });

    // Đúng ba field hợp đồng §3: manifest + warnings + missing. KHÔNG kèm buffer/đường dẫn.
    sendJson(res, 200, {
      manifest: built.manifest ?? null,
      warnings: Array.isArray(built.warnings) ? built.warnings : [],
      missing: Array.isArray(built.missing) ? built.missing : [],
    });
  });

  /* ══════════════════════════════════════════════════════════════════════════
   * MVP-07 — ĐĂNG BÀI FACEBOOK PAGE (DUYỆT TAY) · hợp đồng `docs/MVP-07-CONTRACT.md` §4
   *
   * Tám route dưới đây là route MỚI (chỉ THÊM, không sửa route cũ). Ba luật của khối:
   *
   *   1. **Bắt buộc đăng nhập** cho MỌI `/api/publish/*` — ẩn danh ⇒ 401. Đăng bài là hành động
   *      ra ngoài, phải có người chịu trách nhiệm và phải có người duyệt.
   *   2. **Khác chủ ⇒ 404** (không xác nhận sự tồn tại), y hệt chính sách `requireOwnJob`.
   *      owner/admin thấy và duyệt được bài của MỌI người — đó chính là hàng đợi duyệt.
   *   3. **Chỉ `approved` mới được đăng.** Route `…/publish` không tự kiểm bằng `if`: nó gọi
   *      `PublishService.publishItem()`, và cổng thật nằm ở câu UPDATE có điều kiện trong
   *      `Store#claimPublishItem` (xem src/store/index.js).
   * ══════════════════════════════════════════════════════════════════════════ */

  const PUBLISH_UNAVAILABLE_MESSAGE =
    'Khối đăng bài chưa nạp được trên máy chủ này — tính năng đăng bài tạm thời không dùng được.';

  /** Lý do THẬT do `src/app.js` ghi lại (hoặc cấu hình tắt) — cùng khuôn `imagelabUnavailableReason`. */
  const publishUnavailableReason = () => {
    const reason = app?.publishUnavailableReason;
    return typeof reason === 'string' && reason.trim() ? reason : PUBLISH_UNAVAILABLE_MESSAGE;
  };

  const publishEnabled = () => config?.publish?.enabled !== false;

  const publishService = () =>
    app?.publishService && typeof app.publishService.publishItem === 'function' ? app.publishService : null;

  const publishAvailable = () =>
    publishEnabled()
    && Boolean(publishService())
    && typeof store?.createPublishItem === 'function'
    && typeof store?.claimPublishItem === 'function';

  /** Thiếu module/store cũ/tắt tường minh ⇒ 503 nói thẳng, KHÔNG mô phỏng danh sách rỗng. */
  const requirePublish = () => {
    if (!publishEnabled()) {
      throw HttpError.safe(503, 'PUBLISH_UNAVAILABLE', 'Tính năng đăng bài đang bị tắt bằng cấu hình (PUBLISH_ENABLED=false).');
    }
    const svc = publishService();
    if (!svc) throw HttpError.safe(503, 'PUBLISH_UNAVAILABLE', publishUnavailableReason());
    if (typeof store?.claimPublishItem !== 'function' || typeof store?.createPublishItem !== 'function') {
      throw HttpError.safe(503, 'PUBLISH_UNAVAILABLE', 'Store trên máy chủ này chưa có bảng/hàm đăng bài (DB chưa nâng cấp?).');
    }
    return svc;
  };

  /** Khối `publish` cho `/api/config` — CHỈ cờ + giới hạn; KHÔNG token, KHÔNG Page ID. */
  const publishConfigBlock = () => {
    const svc = publishService();
    const info = svc ? svc.providerInfo() : { name: 'none', channel: 'facebook_page', configured: false, is_mock: false, notice: '' };
    return {
      available: publishAvailable(),
      enabled: publishEnabled(),
      reason: publishAvailable() ? null : publishUnavailableReason(),
      channel: String(info.channel || 'facebook_page'),
      // Luật bất biến của sprint: hệ thống KHÔNG BAO GIỜ tự đăng — UI phải nói rõ điều này.
      manual_approval_required: true,
      provider: { name: info.name, configured: Boolean(info.configured), is_mock: Boolean(info.is_mock), notice: String(info.notice || '') },
      statuses: [...PUBLISH_STATUS_LIST],
      limits: {
        max_text_length: Number(config?.publish?.maxTextLength) || 63206,
        max_media: Number(config?.publish?.maxMedia) || 1,
        max_attempts: Number(config?.publish?.maxAttempts) || 3,
      },
    };
  };

  /** `PublishError.code` ⇒ HTTP theo hợp đồng §2.6. KHÔNG BAO GIỜ lộ stack/token của module. */
  const mapPublishError = (err) => {
    if (err instanceof HttpError) return err;
    const code = String(err?.code || '').trim().toUpperCase();
    const message = String(err?.message ?? '').trim();
    const status = PUBLISH_ERROR_STATUS[code];
    if (status) {
      // Câu tiếng Việt do chính repo viết (module P1 không chứa token/đường dẫn) ⇒ hiện thẳng.
      return HttpError.safe(status, code, message || 'Không thực hiện được yêu cầu đăng bài.', err?.details ?? {});
    }
    logger?.error?.('publish.route_failed', {
      error_name: err?.name || 'Error',
      error_code: err?.code || null,
      error_message: scrubPaths(err?.message || err),
    });
    return HttpError.safe(500, 'PUBLISH_FAILED', 'Không xử lý được yêu cầu đăng bài. Vui lòng thử lại.');
  };

  /** Người gọi là owner/admin hay không (dùng để mở hàng đợi duyệt, KHÔNG để nới cổng duyệt). */
  const isPublishAdmin = (req) => ADMIN_ROLES.has(String(req?.user?.role || 'member'));

  /**
   * Bài đăng của CHÍNH người gọi (hoặc bất kỳ bài, nếu người gọi là owner/admin).
   * Khác chủ ⇒ **404** (không xác nhận sự tồn tại) — cùng chính sách `requireOwnJob`.
   */
  const requireOwnPublishItem = async (req, id) => {
    if (!UUID_RE.test(String(id ?? ''))) throw new HttpError(400, 'BAD_ITEM_ID', 'Mã bài đăng không hợp lệ.');
    const item = await store.getPublishItem(String(id));
    if (!item) throw new HttpError(404, 'ITEM_NOT_FOUND', 'Không tìm thấy bài đăng.');
    if (isPublishAdmin(req)) return item;
    const uid = String(req?.user?.id ?? '');
    if (!uid || String(item.user_id ?? '') !== uid) throw new HttpError(404, 'ITEM_NOT_FOUND', 'Không tìm thấy bài đăng.');
    return item;
  };

  /**
   * `MediaRef[]` cho provider: id media → asset THẬT trong store, kèm URL công khai nếu dựng
   * được từ `PUBLIC_BASE_URL`.
   *
   * ⚠️ `PUBLIC_BASE_URL` rỗng ⇒ `url` rỗng ⇒ provider `facebook` trả `MEDIA_NOT_PUBLIC` (nói
   * thẳng là Facebook không tải được ảnh về), KHÔNG dựng URL `127.0.0.1` rồi để Facebook lỗi
   * mơ hồ. Asset không thuộc chủ bài ⇒ bỏ qua (không bao giờ đăng ảnh của người khác).
   */
  const publishMediaRefs = async (item) => {
    const ids = Array.isArray(item?.media_ids) ? item.media_ids : [];
    if (ids.length === 0 || typeof store?.getImageAsset !== 'function') return [];
    const base = String(config?.publicBaseUrl ?? '').trim().replace(/\/+$/, '');
    const out = [];
    for (const id of ids) {
      let asset = null;
      try {
        asset = await store.getImageAsset(String(id));
      } catch {
        asset = null;
      }
      if (!asset) continue;
      const owner = asset.user_id ?? null;
      if (owner && String(owner) !== String(item.user_id ?? '')) {
        logger?.warn?.('publish.media_owner_mismatch', { item_id: item.id });
        continue;
      }
      out.push({
        id: String(asset.id),
        mime: String(asset.mime ?? ''),
        bytes: Number(asset.bytes ?? 0),
        // Route tệp ảnh đã có từ MVP-02 — dùng lại, KHÔNG tự ghép đường dẫn đĩa.
        url: base ? `${base}/api/imagelab/assets/${encodeURIComponent(String(asset.id))}/file` : '',
      });
    }
    return out;
  };

  /** Bài đăng trả ra API — ĐÚNG các field hợp đồng; KHÔNG lộ `session_id`, KHÔNG lộ token. */
  const publicPublishItem = (item) => ({
    id: item.id,
    job_id: item.job_id,
    channel: item.channel,
    provider: item.provider,
    text: item.text,
    media_ids: item.media_ids,
    status: item.status,
    scheduled_at: item.scheduled_at,
    approved_by: item.approved_by,
    approved_at: item.approved_at,
    rejected_by: item.rejected_by,
    rejected_at: item.rejected_at,
    reject_reason: item.reject_reason,
    published_at: item.published_at,
    external_post_id: item.external_post_id,
    external_url: item.external_url,
    is_mock: item.is_mock,
    error_code: item.error_code,
    last_error: item.last_error,
    attempts: item.attempts,
    created_at: item.created_at,
    updated_at: item.updated_at,
  });

  /* ── Tạo bài NHÁP từ một job ── */

  router.post('/api/publish/items', async (req, res) => {
    const svc = requirePublish();
    const user = requireUser(req);
    enforce(rateLimiters.jobs, `publish:${sessionId(req, res)}`);
    const body = await readJson(req, { maxBytes: 256 * 1024 });
    const jobId = String(body?.job_id ?? body?.jobId ?? '').trim();
    if (!jobId) throw new HttpError(400, 'BAD_INPUT', 'Thiếu `job_id` — bài đăng phải xuất phát từ một job đã chạy.');
    // Job phải là job CỦA CHÍNH NGƯỜI GỌI (khác chủ ⇒ 404) — kể cả owner/admin: tạo bài là
    // hành động của chủ nội dung, duyệt mới là việc của quản trị.
    const job = await requireOwnJob(req, res, jobId);
    try {
      const created = await svc.createItem({
        job,
        userId: user.id,
        text: body?.text,
        mediaIds: body?.media_ids ?? body?.mediaIds ?? [],
        channel: body?.channel,
        scheduledAt: body?.scheduled_at ?? body?.scheduledAt ?? null,
        submit: body?.submit === true,
      });
      sendJson(res, 201, {
        item: publicPublishItem(created.item),
        warnings: created.warnings ?? [],
        dropped_media: created.dropped_media ?? 0,
        provider: svc.providerInfo(),
      });
    } catch (err) {
      throw mapPublishError(err);
    }
  });

  /* ── Hàng đợi duyệt: owner/admin thấy MỌI bài, member chỉ thấy bài của mình ── */

  router.get('/api/publish/items', async (req, res) => {
    const svc = requirePublish();
    const user = requireUser(req);
    enforce(rateLimiters.requests, `publish-read:${sessionId(req, res)}`);
    const url = new URL(req.url, 'http://local');
    const statusRaw = String(url.searchParams.get('status') ?? '').trim();
    if (statusRaw && !PUBLISH_STATUS_LIST.includes(statusRaw)) {
      throw new HttpError(400, 'BAD_STATUS', `Trạng thái không hợp lệ (chỉ nhận: ${PUBLISH_STATUS_LIST.join(', ')}).`);
    }
    const jobId = String(url.searchParams.get('job_id') ?? '').trim();
    const all = isPublishAdmin(req);
    const [items, total] = await Promise.all([
      store.listPublishItems({
        userId: user.id,
        all,
        status: statusRaw || null,
        jobId: jobId || null,
        limit: clampInt(url.searchParams.get('limit'), 50, 1, 200),
        offset: clampInt(url.searchParams.get('offset'), 0, 0, 100000),
      }),
      store.countPublishItems({ userId: user.id, all, status: statusRaw || null }),
    ]);
    sendJson(res, 200, {
      items: asArray(items).map((it) => publicPublishItem(it)),
      total,
      scope: all ? 'all' : 'mine',
      can_approve: all,
      provider: svc.providerInfo(),
      statuses: [...PUBLISH_STATUS_LIST],
    });
  });

  /* ── Chi tiết + VẾT mọi lần gọi provider (kể cả lỗi nguyên văn của Facebook) ── */

  router.get('/api/publish/items/:id', async (req, res, params) => {
    const svc = requirePublish();
    requireUser(req);
    enforce(rateLimiters.requests, `publish-read:${sessionId(req, res)}`);
    const item = await requireOwnPublishItem(req, params.id);
    const logs = typeof store.listPublishLogs === 'function' ? asArray(await store.listPublishLogs(item.id, { limit: 50 })) : [];
    sendJson(res, 200, {
      item: publicPublishItem(item),
      logs: logs.map((l) => ({
        id: l.id,
        attempt: l.attempt,
        provider: l.provider,
        status: l.status,
        external_post_id: l.external_post_id,
        error_code: l.error_code,
        // NGUYÊN VĂN lỗi nền tảng (token đã bị `maskToken` che ở tầng provider).
        error_message: l.error_message,
        is_mock: l.is_mock,
        request_summary: l.request_summary,
        created_at: l.created_at,
      })),
      provider: svc.providerInfo(),
    });
  });

  /* ── Chủ bài gửi duyệt: draft → pending_review ── */

  router.post('/api/publish/items/:id/submit', async (req, res, params) => {
    const svc = requirePublish();
    requireUser(req);
    enforce(rateLimiters.jobs, `publish:${sessionId(req, res)}`);
    const item = await requireOwnPublishItem(req, params.id);
    try {
      sendJson(res, 200, { item: publicPublishItem(await svc.submit(item.id)) });
    } catch (err) {
      throw mapPublishError(err);
    }
  });

  /* ── DUYỆT / TỪ CHỐI — CHỈ owner/admin (member ⇒ 403) ── */

  router.post('/api/publish/items/:id/approve', async (req, res, params) => {
    const svc = requirePublish();
    const admin = requireAdmin(req);
    enforce(rateLimiters.jobs, `publish:${sessionId(req, res)}`);
    const item = await requireOwnPublishItem(req, params.id);
    try {
      sendJson(res, 200, { item: publicPublishItem(await svc.approve(item.id, { by: admin.id })) });
    } catch (err) {
      throw mapPublishError(err);
    }
  });

  router.post('/api/publish/items/:id/reject', async (req, res, params) => {
    const svc = requirePublish();
    const admin = requireAdmin(req);
    enforce(rateLimiters.jobs, `publish:${sessionId(req, res)}`);
    const item = await requireOwnPublishItem(req, params.id);
    const body = await readJson(req, { maxBytes: 16 * 1024 }).catch(() => null);
    try {
      const next = await svc.reject(item.id, { by: admin.id, reason: sanitizeText(String(body?.reason ?? ''), { maxLength: 1000 }) });
      sendJson(res, 200, { item: publicPublishItem(next) });
    } catch (err) {
      throw mapPublishError(err);
    }
  });

  /* ── ĐĂNG — CHỈ chạy khi bài đã `approved` (cổng thật ở `Store#claimPublishItem`) ── */

  router.post('/api/publish/items/:id/publish', async (req, res, params) => {
    const svc = requirePublish();
    const user = requireUser(req);
    enforce(rateLimiters.jobs, `publish:${sessionId(req, res)}`);
    const item = await requireOwnPublishItem(req, params.id);
    const media = await publishMediaRefs(item);
    try {
      const out = await svc.publishItem(item.id, { actorId: user.id, media });
      sendJson(res, 200, {
        item: publicPublishItem(out.item),
        result: {
          status: out.result?.status ?? null,
          post_id: out.result?.post_id ?? null,
          url: out.result?.url ?? null,
          error_code: out.result?.error_code ?? null,
          error_message: String(out.result?.error_message ?? ''),
          is_mock: Boolean(out.result?.is_mock),
          provider: out.result?.provider ?? null,
          scheduled_at: out.result?.scheduled_at ?? null,
        },
        // `called = false` ⇒ provider KHÔNG được gọi (bài đã đăng trước đó) — luật "một bài
        // chỉ đăng một lần" quan sát được từ ngoài, không phải chỉ nằm trong mã.
        called: out.called === true,
        idempotent: out.idempotent === true,
      });
    } catch (err) {
      throw mapPublishError(err);
    }
  });

  /* ── Trạng thái provider (có thể gọi mạng) — CHỈ owner/admin ── */

  router.get('/api/publish/provider', async (req, res) => {
    const svc = requirePublish();
    requireAdmin(req);
    enforce(rateLimiters.requests, `publish-read:${sessionId(req, res)}`);
    sendJson(res, 200, { provider: svc.providerInfo(), probe: await svc.probe() });
  });

  /**
   * MVP-05 — gắn middleware `attachUser` (+ cổng "bắt buộc đăng nhập" khi chủ hệ thống tắt
   * chế độ ẩn danh) cho MỌI route đã đăng ký ở trên.
   *
   * `Router` của repo cố ý tối giản (không có middleware toàn cục), nên bọc handler tại đây
   * thay vì sửa `src/http/server.js`: mọi route — kể cả route cũ của MVP-01/02/03 — dùng
   * CHUNG một chỗ đọc cookie/`req.user`, không route nào quên.
   *
   * Thứ tự chạy: attachUser (không bao giờ ném) → cổng ẩn danh → handler.
   */
  for (const route of router.routes) {
    const handler = route.handler;
    route.handler = async (req, res, params) => {
      await attachUser(req);
      if (!anonymousAllowed() && requiresLoginWhenAnonymousOff(req)) requireUser(req);
      return handler(req, res, params);
    };
  }

  return router;
}

/**
 * Khi `AUTH_ANONYMOUS_ALLOWED=false`: các route NGHIỆP VỤ (jobs/imagelab/imagestudio/
 * videostudio/uploads/detect) bắt buộc đăng nhập. Miễn trừ theo hợp đồng §2.3/§3.3/§2.4:
 *  - `/api/auth/*` (nếu không thì không ai đăng nhập được),
 *  - `/api/health`, `/api/config` (giám sát + UI khởi động),
 *  - route FILE ẢNH/VIDEO: tự kiểm quyền sở hữu và trả 404 cho tệp không thuộc mình,
 *    KHÔNG trả 401 (đúng câu "route file ảnh nếu ảnh thuộc chính user (còn lại 404)").
 */
function requiresLoginWhenAnonymousOff(req) {
  const path = String(req?.url || '').split('?')[0];
  if (ANON_EXEMPT_PATHS.has(path)) return false;
  if (/^\/api\/(?:imagelab|imagestudio|videostudio)\/assets\/[^/]+\/file\/?$/.test(path)) return false;
  return BUSINESS_PATH_RE.test(path);
}






/** Số nguyên trong khoảng cho phép (query `limit`/`offset`); giá trị rác ⇒ mặc định. */
function clampInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** `Date`/ISO/ms → chuỗi ISO; không đọc được ⇒ `null` (KHÔNG bịa thời điểm). */
function toIsoString(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim()) {
    const t = Date.parse(value.trim());
    return Number.isFinite(t) ? new Date(t).toISOString() : value.trim();
  }
  return null;
}

/**
 * Token phiên PHẢI là chuỗi an toàn để nhét vào header `Set-Cookie` (base64url).
 * Token lạ ⇒ `null`: không đặt cookie, không để lọt ký tự điều khiển vào header.
 */
function safeToken(token) {
  if (typeof token !== 'string') return null;
  const clean = token.trim();
  return /^[A-Za-z0-9_-]{8,256}$/.test(clean) ? clean : null;
}

/**
 * `user` TRẢ RA CLIENT — danh sách TRẮNG: TUYỆT ĐỐI không có `password_hash`, không token,
 * không khoá nội bộ nào khác (kể cả khi tầng A1/A3 lỡ trả cả dòng DB thô).
 */
function publicUserJson(user) {
  if (!user || typeof user !== 'object') return null;
  return {
    id: user.id ?? null,
    email: user.email ?? null,
    display_name: user.display_name ?? user.displayName ?? null,
    role: user.role ?? 'member',
    status: user.status ?? 'active',
    created_at: user.created_at ?? user.createdAt ?? null,
    updated_at: user.updated_at ?? user.updatedAt ?? null,
    last_login_at: user.last_login_at ?? user.lastLoginAt ?? null,
  };
}

/** Dòng sổ credit trả cho client — chỉ field hợp đồng §2.1, không lộ cột nội bộ. */
function ledgerJson(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id ?? null,
    amount: Number.isFinite(Number(row.amount)) ? Number(row.amount) : null,
    currency: row.currency ?? null,
    reason: row.reason ?? null,
    job_id: row.job_id ?? null,
    operation: row.operation ?? null,
    balance_after: Number.isFinite(Number(row.balance_after)) ? Number(row.balance_after) : null,
    created_at: row.created_at ?? null,
  };
}

/**
 * MVP-06 — một YÊU CẦU NẠP trả cho client (`docs/MVP-06-CONTRACT.md` §2/§3).
 * Danh sách TRẮNG: chỉ field của hợp đồng, không lộ cột nội bộ nào.
 */
function topupRequestJson(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: row.id ?? null,
    user_id: row.user_id ?? null,
    amount_vnd: Number.isFinite(Number(row.amount_vnd)) ? Number(row.amount_vnd) : null,
    credits: Number.isFinite(Number(row.credits)) ? Number(row.credits) : null,
    rate_vnd_per_credit: Number.isFinite(Number(row.rate_vnd_per_credit)) ? Number(row.rate_vnd_per_credit) : null,
    method: row.method ?? null,
    reference: row.reference ?? '',
    note: row.note ?? '',
    status: row.status ?? null,
    created_at: row.created_at ?? null,
    decided_at: row.decided_at ?? null,
    decided_by: row.decided_by ?? null,
    ledger_entry_id: row.ledger_entry_id ?? null,
  };
}

/** Câu nói thật của MVP-06 (lấy từ service để KHÔNG có hai bản chữ lệch nhau). */
function topupHonestNote(svc) {
  const text = svc && typeof svc.publicConfig === 'function' ? svc.publicConfig()?.note : null;
  return typeof text === 'string' && text ? text : null;
}

/**
 * Lỗi của MVP-06 → HTTP. Mã lỗi LÀ HỢP ĐỒNG (§3):
 *   `TOPUP_ALREADY_DECIDED`      ⇒ 409 (xác nhận 2 lần — sổ KHÔNG đổi)
 *   `TOPUP_REFERENCE_DUPLICATE`  ⇒ 409 (chống khai khống)
 *   `TOPUP_AMOUNT_OUT_OF_RANGE`  ⇒ 400
 *   `TOPUP_NOT_FOUND`            ⇒ 404 (kể cả khi yêu cầu là của người khác — không tiết lộ)
 *   `TOPUP_ANONYMOUS`            ⇒ 401
 */
function mapTopupError(err) {
  if (!err || typeof err !== 'object') return null;
  const code = String(err.code || '');
  const details = err.details && typeof err.details === 'object' ? err.details : {};
  const message = String(err.message || 'Không xử lý được yêu cầu nạp credit.');
  if (code === 'TOPUP_ALREADY_DECIDED') {
    return HttpError.safe(409, code, message, {
      request_id: details.request_id ?? null,
      status: details.status ?? null,
      decided_at: details.decided_at ?? null,
    });
  }
  if (code === 'TOPUP_REFERENCE_DUPLICATE') {
    return HttpError.safe(409, code, message, { reference: details.reference ?? null });
  }
  if (code === 'TOPUP_AMOUNT_OUT_OF_RANGE') {
    return HttpError.safe(400, code, message, {
      amount_vnd: details.amount_vnd ?? null,
      min_topup_vnd: details.min_topup_vnd ?? null,
      max_topup_vnd: details.max_topup_vnd ?? null,
    });
  }
  if (code === 'TOPUP_AMOUNT_INVALID' || code === 'TOPUP_REFERENCE_REQUIRED' || code === 'TOPUP_REASON_REQUIRED'
      || code === 'TOPUP_CREDITS_INVALID' || code === 'INVALID_TOPUP_AMOUNT') {
    return HttpError.safe(400, code, message, { amount_vnd: details.amount_vnd ?? null });
  }
  if (code === 'TOPUP_NOT_FOUND') {
    return HttpError.safe(404, code, 'Không tìm thấy yêu cầu nạp.', { request_id: details.request_id ?? null });
  }
  if (code === 'TOPUP_ANONYMOUS') {
    return HttpError.safe(401, 'UNAUTHENTICATED', 'Bạn cần đăng nhập để nạp credit.');
  }
  if (code === 'TOPUP_UNAVAILABLE' || code === 'TOPUP_NO_OWNER') {
    return HttpError.safe(503, 'TOPUP_UNAVAILABLE', message);
  }
  return null;
}

/** Một dòng bảng giá: `{operation, unit_price, currency, note}` (§3.3). */
function pricingJson(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    operation: row.operation ?? null,
    unit_price: Number.isFinite(Number(row.unit_price)) ? Number(row.unit_price) : null,
    currency: row.currency ?? null,
    note: row.note ?? null,
  };
}

/** Một dòng usage tổng hợp — chuyển thẳng dữ liệu store trả, không diễn giải thêm. */
function usageRowJson(row) {
  if (!row || typeof row !== 'object') return null;
  return { ...row };
}

/** Câu tiếng Việt cho 402 — kèm số đo THẬT khi có, không bịa khi thiếu. */
function insufficientCreditMessage(required, balance) {
  if (Number.isFinite(Number(required)) && Number.isFinite(Number(balance))) {
    return `Số dư credit không đủ để chạy job này: cần ${Number(required)}, hiện có ${Number(balance)}. Hãy nạp thêm credit rồi thử lại.`;
  }
  if (Number.isFinite(Number(balance))) {
    return `Số dư credit không đủ để chạy job này (hiện có ${Number(balance)}). Hãy nạp thêm credit rồi thử lại.`;
  }
  return 'Số dư credit không đủ để chạy job này. Hãy nạp thêm credit rồi thử lại.';
}

/**
 * Lỗi của tầng ví (A2/A3) → HTTP.
 *
 * Chỉ nhận đúng `INSUFFICIENT_CREDIT` (hoặc lỗi đã mang `status: 402`) ⇒ **402** kèm
 * `details { required, balance }` (trường nào tầng dưới không cung cấp thì để `null`,
 * KHÔNG bịa số). Lỗi khác ⇒ `null` để tầng gọi dùng bảng ánh xạ của chính nó.
 */
function mapBillingError(err) {
  if (!err || typeof err !== 'object') return null;
  const code = String(err.code || '');
  // BR-03a (vòng 3): không giữ được tiền vì SỔ LỖI ⇒ 503 (fail-closed), KHÔNG cho chạy miễn phí.
  if (code === 'BILLING_UNAVAILABLE') {
    return HttpError.safe(503, 'BILLING_UNAVAILABLE', String(err.message || 'Sổ ví tạm thời không dùng được — thử lại sau.'), {
      job_id: err?.details?.job_id ?? null,
      cause_code: err?.details?.cause_code ?? null,
    });
  }
  // PB-02 (vòng 2): vượt trần số lượt chạy có tính tiền của job ⇒ 429 (không phải 5xx, không
  // phải 402: người dùng CÓ tiền, chỉ là job này đã chạy quá nhiều lượt).
  if (code === 'RERUN_LIMIT_EXCEEDED') {
    const d = err.details && typeof err.details === 'object' ? err.details : {};
    return HttpError.safe(
      429,
      'RERUN_LIMIT_EXCEEDED',
      String(err.message || 'Job đã chạy quá số lượt cho phép — hãy tạo job mới.'),
      { job_id: d.job_id ?? null, runs: Number.isFinite(Number(d.runs)) ? Number(d.runs) : null, max_runs: Number.isFinite(Number(d.max_runs)) ? Number(d.max_runs) : null },
    );
  }
  // PB-06: khoản tiền không hợp lệ / vượt trần ⇒ 400 (trước đây `grant(1e308)` ghi sổ 0 mà vẫn 201).
  // F3 (vòng vá PR #28): `AMOUNT_TOO_LARGE` nay còn dùng cho TRẦN SỐ DƯ ví (`max_balance`) —
  // chi tiết trả thêm `balance`/`max_balance` để UI/admin biết vì sao bị từ chối.
  if (code === 'INVALID_AMOUNT' || code === 'AMOUNT_TOO_LARGE' || code === 'INVALID_REASON') {
    const d = err.details && typeof err.details === 'object' ? err.details : {};
    return HttpError.safe(400, code, String(err.message || 'Số credit không hợp lệ.'), {
      amount: d.amount ?? null,
      max: d.max ?? null,
      balance: Number.isFinite(Number(d.balance)) ? Number(d.balance) : null,
      max_balance: Number.isFinite(Number(d.max_balance)) ? Number(d.max_balance) : null,
    });
  }
  if (code !== 'INSUFFICIENT_CREDIT' && Number(err.status) !== 402) return null;
  const raw = err.details && typeof err.details === 'object' ? err.details : {};
  const required = Number(raw.required ?? raw.estimated ?? raw.amount);
  const balance = Number(raw.balance ?? raw.available ?? raw.balance_after);
  const details = {
    required: Number.isFinite(required) ? required : null,
    balance: Number.isFinite(balance) ? balance : null,
    // §3.4b: details có cả `currency`; thiếu thì để `null` (không bịa đơn vị tiền).
    currency: typeof raw.currency === 'string' && raw.currency ? raw.currency : null,
  };
  return HttpError.safe(402, 'INSUFFICIENT_CREDIT', insufficientCreditMessage(details.required, details.balance), details);
}

/**
 * Lỗi của `/api/auth/register` → HTTP theo hợp đồng §3.3.
 *
 * A1 có thể dùng tên mã khác (`EMAIL_EXISTS`, `PASSWORD_TOO_SHORT`…) nên nhận cả nhóm
 * tương đương; mã LẠ ⇒ 500 (không đoán bừa thành 4xx để tránh che lỗi hệ thống).
 */
function mapRegisterError(err, minLength = 10) {
  if (err instanceof HttpError) return err;
  const code = authErrorCode(err);
  const details = err?.details && typeof err.details === 'object' ? err.details : {};
  if (AUTH_CODE_SETS.EMAIL_TAKEN.has(code)) {
    return HttpError.safe(409, 'EMAIL_TAKEN', 'Email này đã được đăng ký — hãy đăng nhập hoặc dùng email khác.');
  }
  if (AUTH_CODE_SETS.WEAK_PASSWORD.has(code)) {
    return HttpError.safe(400, 'WEAK_PASSWORD', `Mật khẩu quá yếu — cần ít nhất ${minLength} ký tự.`);
  }
  if (AUTH_CODE_SETS.DISABLED.has(code)) {
    return HttpError.safe(403, 'ACCOUNT_DISABLED', 'Tài khoản này đã bị khoá — liên hệ quản trị viên.');
  }
  if (AUTH_CODE_SETS.BAD_BODY.has(code)) {
    return HttpError.safe(400, 'BAD_BODY', 'Dữ liệu đăng ký không hợp lệ (kiểm tra lại email/mật khẩu).', details);
  }
  return authInternalError(err, 'Không tạo được tài khoản.');
}

/**
 * Lỗi của `/api/auth/login` → HTTP. MỌI ca sai thông tin (email không tồn tại, mật khẩu sai,
 * email sai định dạng) trả **CÙNG MỘT** 401 + CÙNG MỘT câu: không được để kẻ dò tài khoản
 * phân biệt được email nào có thật.
 */
function mapLoginError(err) {
  if (err instanceof HttpError) return err;
  const code = authErrorCode(err);
  if (AUTH_CODE_SETS.BAD_CREDENTIALS.has(code)) {
    return HttpError.safe(401, 'BAD_CREDENTIALS', BAD_CREDENTIALS_TEXT);
  }
  if (AUTH_CODE_SETS.DISABLED.has(code)) {
    return HttpError.safe(403, 'ACCOUNT_DISABLED', 'Tài khoản này đã bị khoá — liên hệ quản trị viên.');
  }
  if (AUTH_CODE_SETS.BAD_BODY.has(code)) {
    return HttpError.safe(400, 'BAD_BODY', 'Dữ liệu đăng nhập không hợp lệ (cần `email` và `password`).');
  }
  return authInternalError(err, 'Không đăng nhập được.');
}

/** Lỗi tài khoản dùng chung cho route quản trị (`setRole`, `list`…) — giữ đúng mã 4xx. */
function mapAuthError(err) {
  if (err instanceof HttpError) return err;
  const code = authErrorCode(err);
  if (AUTH_CODE_SETS.USER_NOT_FOUND.has(code)) {
    return HttpError.safe(404, 'USER_NOT_FOUND', 'Không tìm thấy người dùng.');
  }
  if (AUTH_CODE_SETS.BAD_ROLE.has(code)) {
    return HttpError.safe(400, 'BAD_ROLE', `\`role\` phải là một trong: ${AUTH_ROLES.join(', ')}.`);
  }
  if (AUTH_CODE_SETS.EMAIL_TAKEN.has(code)) {
    return HttpError.safe(409, 'EMAIL_TAKEN', 'Email này đã được đăng ký — hãy dùng email khác.');
  }
  // A1 chặn hạ cấp owner CUỐI CÙNG (LAST_OWNER): 409 + câu tiếng Việt, không phải 500.
  if (code === 'LAST_OWNER') {
    return HttpError.safe(409, 'LAST_OWNER', 'Không thể hạ cấp owner cuối cùng — hệ thống sẽ không còn ai quản trị.');
  }
  if (code === 'STORE_UNAVAILABLE' || code === 'STORE_ERROR' || code === 'OWNER_COUNT_UNAVAILABLE') {
    return HttpError.safe(503, 'ACCOUNTS_UNAVAILABLE', 'Kho dữ liệu tài khoản đang lỗi — vui lòng thử lại sau.');
  }
  return authInternalError(err, 'Không xử lý được yêu cầu tài khoản.');
}

/** Lỗi hệ thống của tầng tài khoản: 500 an toàn, KHÔNG dội message nội bộ ra client. */
function authInternalError(err, fallbackMessage) {
  const code = authErrorCode(err) || 'AUTH_FAILED';
  return HttpError.safe(500, code, fallbackMessage);
}

const authErrorCode = (err) => String(err?.code || '').trim().toUpperCase();

/** Kiểm dữ liệu thủ công trước khi tạo job. */
function validateManualPayload(manual, config) {
  if (manual.title && String(manual.title).length > 1000) {
    throw new HttpError(422, 'TITLE_TOO_LONG', 'Tiêu đề quá dài (tối đa 1000 ký tự).');
  }
  if (manual.notes && String(manual.notes).length > 20000) {
    throw new HttpError(422, 'NOTES_TOO_LONG', 'Ghi chú quá dài (tối đa 20000 ký tự).');
  }
  if (Array.isArray(manual.images)) {
    if (manual.images.length > config.net.maxUploadFiles) {
      throw new HttpError(422, 'TOO_MANY_IMAGES', `Tối đa ${config.net.maxUploadFiles} ảnh.`);
    }
    for (const img of manual.images) {
      const url = typeof img === 'string' ? img : img?.url;
      if (!url) continue;
      if (!/^https?:\/\//i.test(url) && !/^data:image\//i.test(url)) {
        throw new HttpError(422, 'BAD_IMAGE_URL', 'URL ảnh phải là http(s) hoặc data:image.');
      }
    }
  }
}

/* ══════════════ MVP-02 · helper thuần cho imagelab ══════════════ */

const DEFAULT_MAX_PIXELS = 16_000_000;
const DEFAULT_MAX_REGIONS = 40;
const EDIT_ACTIONS = new Set(['accept', 'edit', 'skip']);
const REGION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const IMAGELAB_KINDS = Object.freeze(['descriptive', 'brand', 'certification', 'price', 'unknown']);

const asArray = (v) => (Array.isArray(v) ? v : []);

/* ═════════ MVP-08 — tiện ích JSON + ánh xạ lỗi của đăng sàn ═════════ */

/** Một listing trả cho client. `full: true` kèm payload/input/unmapped (màn chi tiết + nút XEM PAYLOAD). */
function marketplaceListingJson(row, { full = false } = {}) {
  if (!row || typeof row !== 'object') return null;
  const base = {
    id: row.id ?? null,
    job_id: row.job_id ?? null,
    user_id: row.user_id ?? null,
    channel: row.channel ?? null,
    status: row.status ?? null,
    run_key: row.run_key ?? null,
    external_id: row.external_id ?? null,
    external_url: row.external_url ?? null,
    is_mock: Boolean(row.is_mock),
    error_code: row.error_code ?? null,
    last_error: row.last_error ?? null,
    attempts: Number.isFinite(Number(row.attempts)) ? Number(row.attempts) : 0,
    issues: Array.isArray(row.issues) ? row.issues : [],
    unmapped_count: Array.isArray(row.unmapped) ? row.unmapped.length : 0,
    title: row.input?.title ?? null,
    price_vnd: row.input?.price_vnd ?? null,
    stock: row.input?.stock ?? null,
    approved_by: row.approved_by ?? null,
    approved_at: row.approved_at ?? null,
    rejected_by: row.rejected_by ?? null,
    rejected_at: row.rejected_at ?? null,
    reject_reason: row.reject_reason ?? null,
    published_at: row.published_at ?? null,
    remote_snapshot: row.remote_snapshot ?? null,
    synced_at: row.synced_at ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
  if (!full) return base;
  return {
    ...base,
    input: row.input ?? null,
    overrides: row.overrides ?? null,
    payload: row.payload ?? null,
    unmapped: Array.isArray(row.unmapped) ? row.unmapped : [],
    defaults_applied: Array.isArray(row.defaults_applied) ? row.defaults_applied : [],
    last_result: row.last_result ?? null,
  };
}

/**
 * Lỗi MVP-08 → HTTP (hợp đồng §4): PREFLIGHT_FAILED ⇒ 422 kèm issues[]; CHANNEL_NOT_CONFIGURED,
 * NOT_APPROVED, LISTING_ALREADY_DECIDED, PUBLISH_IN_PROGRESS ⇒ 409; MARKETPLACE_ERROR ⇒ 502 + raw
 * (đã che bí mật); LISTING_NOT_FOUND ⇒ 404; ATTEMPTS_EXCEEDED ⇒ 429.
 */
function mapMarketplaceError(err) {
  if (!err || typeof err !== 'object') return null;
  const code = String(err.code || '');
  const d = err.details && typeof err.details === 'object' ? err.details : {};
  const message = String(err.message || 'Không xử lý được yêu cầu đăng sàn.');
  if (code === 'PREFLIGHT_FAILED') return HttpError.safe(422, code, message, { channel: d.channel ?? null, issues: Array.isArray(d.issues) ? d.issues : [], input: d.input ?? null, listing_id: d.listing_id ?? null });
  if (code === 'CHANNEL_NOT_CONFIGURED') return HttpError.safe(409, code, message, { channel: d.channel ?? null, notice: d.notice ?? null, listing_id: d.listing_id ?? null });
  if (code === 'NOT_APPROVED' || code === 'LISTING_ALREADY_DECIDED' || code === 'PUBLISH_IN_PROGRESS' || code === 'SYNC_UNAVAILABLE') return HttpError.safe(409, code, message, { listing_id: d.listing_id ?? null, status: d.status ?? null });
  if (code === 'ATTEMPTS_EXCEEDED') return HttpError.safe(429, code, message, { listing_id: d.listing_id ?? null, attempts: d.attempts ?? null, max_attempts: d.max_attempts ?? null });
  if (code === 'MARKETPLACE_ERROR') return HttpError.safe(502, code, message, { channel: d.channel ?? null, listing_id: d.listing_id ?? null, error_code: d.error_code ?? null, raw: d.raw ?? null, attempts: d.attempts ?? null, max_attempts: d.max_attempts ?? null, listing: d.listing ? marketplaceListingJson(d.listing) : null });
  if (code === 'LISTING_NOT_FOUND') return HttpError.safe(404, code, 'Không tìm thấy listing.', { listing_id: d.listing_id ?? null });
  if (code === 'CHANNEL_UNKNOWN' || code === 'BAD_INPUT' || code === 'REASON_REQUIRED') return HttpError.safe(400, code, message, { channel: d.channel ?? null });
  if (code === 'MARKETPLACE_UNAVAILABLE') return HttpError.safe(503, code, message);
  return null;
}


/** Parse một cột JSON dạng object (SQLite trả TEXT); trả {} nếu không đọc được. */
function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Job rút gọn cho UI — không lộ session_id hay chi tiết nội bộ. */
function jobJson(job) {
  return {
    id: job.id,
    kind: job.kind ?? null,
    status: job.status,
    stage: job.stage,
    source: job.source,
    input_mode: job.input_mode,
    error_code: job.error_code ?? null,
    error_message: job.error_message ?? null,
    created_at: job.created_at,
    updated_at: job.updated_at,
    finished_at: job.finished_at ?? null,
  };
}

/** Ảnh: chỉ metadata — TUYỆT ĐỐI không trả `storage_path` (đường dẫn nội bộ). */
function assetJson(asset) {
  if (!asset) return null;
  return {
    id: asset.id,
    job_id: asset.job_id ?? null,
    role: asset.role,
    parent_id: asset.parent_id ?? null,
    mime: asset.mime ?? null,
    bytes: asset.bytes ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
    sha256: asset.sha256 ?? null,
    source: asset.source ?? null,
    meta: asset.meta && typeof asset.meta === 'object' ? asset.meta : null,
    created_at: asset.created_at ?? null,
  };
}

/**
 * Chuẩn hoá vùng OCR: store có thể trả cột phẳng (x, y, w, h, text_original)
 * hoặc object lồng (box, box_normalized, text) — nhận cả hai, không bịa field.
 */
/**
 * `Region` → JSON cho client. `withKindDowngradeTrace` được TRUYỀN VÀO (không static-import
 * module imagelab ở đây): routes.js nạp module imagelab qua loader để còn trả 503 khi module
 * thiếu, thay vì làm sập cả app.
 *
 * IL08-06 (vòng 7): vùng bị NGƯỜI DÙNG hạ mức bảo vệ phải mang vết ra tới client (PUT và GET
 * dùng chung hàm này) — vết đọc lại từ `kind_reason` ĐÃ LƯU, không phải trạng thái in-memory.
 */
function regionJson(r, withKindDowngradeTrace = null) {
  const box = r.box && typeof r.box === 'object'
    ? r.box
    : { x: r.x, y: r.y, w: r.w, h: r.h };
  const norm = r.box_normalized && typeof r.box_normalized === 'object'
    ? r.box_normalized
    : { x: r.x_norm, y: r.y_norm, w: r.w_norm, h: r.h_norm };
  const traced = typeof withKindDowngradeTrace === 'function' ? withKindDowngradeTrace(r) : r;
  return {
    ...(traced?.kind_downgraded
      ? {
          kind_downgraded: true,
          kind_declared_by_user: traced.kind_declared_by_user ?? null,
          kind_classified_by_machine: traced.kind_classified_by_machine ?? null,
        }
      : {}),
    id: r.region_key || r.id,
    box,
    box_normalized: norm,
    text: r.text ?? r.text_original ?? '',
    lang: r.lang || 'und',
    confidence: r.confidence ?? null,
    kind: r.kind || 'unknown',
    kind_reason: r.kind_reason || '',
    translatable: Boolean(r.translatable),
    source: r.source || 'ocr',
    asset_id: r.asset_id ?? null,
  };
}

function lineJson(l) {
  return {
    region_id: l.region_id || l.region_key || '',
    text_original: l.text_original ?? '',
    text_vi: l.text_vi ?? '',
    status: l.status ?? '',
    provenance: l.provenance || 'none',
    confidence: l.confidence ?? null,
    violations: parseJsonArray(l.violations),
    edited_by_user: Boolean(l.edited_by_user),
    edited_at: l.edited_at ?? null,
    notes: l.notes ?? '',
  };
}

/** Tóm tắt render từ `meta` của asset đã render — null nếu chưa render. */
function buildRenderSummary(rendered) {
  if (!rendered) return null;
  const meta = rendered.meta && typeof rendered.meta === 'object' ? rendered.meta : {};
  return {
    asset_id: rendered.id,
    status: meta.status ?? null,
    // H-2: mã lỗi của engine (`NO_OPS` khi không vẽ được vùng nào) — UI nói thẳng.
    error_code: meta.error_code ?? null,
    // N-5: đã kiểm pixel vùng bảo vệ trên ảnh trả về chưa? (null = không có gì để kiểm)
    protected_pixels_verified: meta.protected_pixels_verified ?? null,
    provider: meta.provider ?? null,
    is_mock: meta.is_mock ?? null,
    applied: asArray(meta.applied),
    skipped: asArray(meta.skipped),
    unsupported_glyphs: asArray(meta.unsupported_glyphs),
    warnings: asArray(meta.warnings).map(String),
    forced: meta.forced ?? null,
    // F-02: vết override nhãn hiệu/chứng nhận/giá đã dùng cho ảnh này.
    overrides: asArray(meta.overrides),
    elapsed_ms: meta.elapsed_ms ?? null,
  };
}

const MOCK_STEP_ORDER = Object.freeze(['ocr', 'translate', 'render']);

const isTruthyMock = (value) => value === true || value === 1 || value === '1' || value === 'true';

/**
 * F-03 — các bước đã chạy bằng provider MOCK, đọc từ DẤU VẾT ĐÃ LƯU của job:
 * `content_meta.imagelab.mock_steps` (pipeline ghi lúc chạy) + meta của chính các ảnh
 * thuộc job (`asset.meta.ocr.is_mock`, `asset.meta.is_mock` của ảnh render).
 *
 * Tuyệt đối KHÔNG suy ra từ cấu hình provider đang chạy: khởi động lại máy chủ với
 * provider thật trên cùng DB thì job cũ vẫn phải báo MOCK.
 */
function collectMockSteps(job, assets) {
  const steps = new Set();
  const il = job?.content_meta?.imagelab;
  if (il && typeof il === 'object') {
    for (const s of asArray(il.mock_steps)) if (s) steps.add(String(s));
  }
  for (const a of asArray(assets)) {
    const meta = a?.meta && typeof a.meta === 'object' ? a.meta : {};
    if (isTruthyMock(meta.ocr?.is_mock)) steps.add('ocr');
    if (isTruthyMock(meta.translate?.is_mock)) steps.add('translate');
    if (isTruthyMock(meta.is_mock)) steps.add('render');
  }
  return MOCK_STEP_ORDER.filter((s) => steps.has(s)).concat([...steps].filter((s) => !MOCK_STEP_ORDER.includes(s)));
}

/**
 * F-03 — ẢNH CHỤP provider tại THỜI ĐIỂM CHẠY, lấy từ dữ liệu đã lưu của job
 * (`content_meta.imagelab.ocr/translate/render`), không phải từ `app.*Provider`.
 * Trường nào job chưa chạy tới thì để `null` (không bịa).
 */
function providersSnapshot(job, assets) {
  const il = job?.content_meta?.imagelab;
  const meta = il && typeof il === 'object' ? il : {};
  const fromRecord = (rec) => {
    if (!rec || typeof rec !== 'object') return null;
    return {
      name: rec.provider ?? null,
      model: rec.model ?? null,
      is_mock: rec.is_mock ?? null,
      status: rec.status ?? null,
    };
  };
  const snapshot = {
    ocr: fromRecord(meta.ocr),
    translate: fromRecord(meta.translate),
    render: fromRecord(meta.render),
    recorded_at: meta.updated_at ?? null,
  };
  // Dự phòng (job cũ chưa có content_meta): đọc thẳng meta ảnh đã lưu.
  if (!snapshot.ocr || !snapshot.render) {
    for (const a of asArray(assets)) {
      const am = a?.meta && typeof a.meta === 'object' ? a.meta : {};
      if (!snapshot.ocr && am.ocr && typeof am.ocr === 'object') {
        snapshot.ocr = {
          name: am.ocr.provider ?? null,
          model: am.ocr.model ?? null,
          is_mock: am.ocr.is_mock ?? null,
          status: am.ocr.status ?? null,
        };
      }
      if (!snapshot.render && a?.role === 'rendered' && am.provider) {
        snapshot.render = {
          name: am.provider ?? null,
          model: am.model ?? null,
          is_mock: am.is_mock ?? null,
          status: am.status ?? null,
        };
      }
    }
  }
  return snapshot;
}

/** Gộp cảnh báo CÓ THẬT đã lưu trong meta của các asset (không tự sinh thêm). */
function collectWarnings(...assets) {
  const out = [];
  for (const a of assets) {
    const meta = a?.meta && typeof a.meta === 'object' ? a.meta : {};
    for (const w of asArray(meta.warnings)) if (w) out.push(String(w));
    const ocr = meta.ocr && typeof meta.ocr === 'object' ? meta.ocr : null;
    for (const w of asArray(ocr?.warnings)) if (w) out.push(String(w));
  }
  return [...new Set(out)];
}

/** Trạng thái OCR + vùng bị bỏ (nếu pipeline có lưu vào meta của ảnh gốc). */
function collectOcrMeta(asset) {
  const meta = asset?.meta && typeof asset.meta === 'object' ? asset.meta : {};
  const ocr = meta.ocr && typeof meta.ocr === 'object' ? meta.ocr : null;
  // IL08-03 (vòng 6): nếu vùng nhập tay đã THAY vùng OCR thì khối này là LỊCH SỬ, không
  // phải số liệu hiện hành — phải nói rõ, không được trình bày như đang hiện hành.
  const superseded = ocr?.superseded_by_manual_regions === true;
  return {
    status: ocr?.status ?? null,
    provider: ocr?.provider ?? null,
    model: ocr?.model ?? null,
    is_mock: ocr?.is_mock ?? null,
    dropped: asArray(ocr?.dropped ?? meta.dropped),
    warnings: asArray(ocr?.warnings ?? meta.warnings).map(String),
    superseded_by_manual_regions: superseded,
    superseded_at: ocr?.superseded_at ?? null,
    ...(superseded
      ? {
          note:
            'Dấu vết OCR TRƯỚC ĐÓ — đã bị thay bởi vùng nhập tay; các con số/danh sách dưới đây KHÔNG mô tả vùng chữ đang có của job.',
        }
      : {}),
  };
}

/**
 * Giải mã + kiểm ảnh đầu vào: base64 hỏng → 400 BAD_IMAGE; không tin Content-Type
 * client khai (magic bytes); chặn theo allowedImageMime / maxImageBytes / maxPixels.
 */
function decodeImagelabImage(image, limits) {
  const raw = typeof image === 'string' ? image : image?.base64;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new HttpError(400, 'MISSING_IMAGE', 'Thiếu dữ liệu ảnh (`image.base64`).');
  }

  let b64 = raw.trim();
  const dataUrl = /^data:[^;,]*;base64,/i.exec(b64);
  if (dataUrl) b64 = b64.slice(dataUrl[0].length);
  b64 = b64.replace(/\s+/g, '');

  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 === 1) {
    throw new HttpError(400, 'BAD_IMAGE', 'Dữ liệu ảnh base64 không hợp lệ.');
  }
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length === 0) throw new HttpError(400, 'BAD_IMAGE', 'Dữ liệu ảnh base64 không hợp lệ.');

  if (buffer.length > limits.max_image_bytes) {
    throw new HttpError(413, 'IMAGE_TOO_LARGE', `Ảnh vượt giới hạn ${Math.round(limits.max_image_bytes / 1024 / 1024)}MB.`);
  }

  const mime = sniffImageMime(buffer);
  const allowed = limits.allowed_image_mime || [];
  if (!mime || !allowed.includes(mime)) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Ảnh không hợp lệ hoặc định dạng không được phép (chỉ nhận PNG/JPEG/WebP/GIF).');
  }

  const size = readImageDimensions(buffer, mime);
  if (size && size.width > 0 && size.height > 0 && size.width * size.height > limits.max_pixels) {
    throw new HttpError(413, 'IMAGE_TOO_LARGE', `Ảnh vượt giới hạn ${limits.max_pixels} pixel.`);
  }

  return {
    base64: b64,
    buffer,
    mime,
    bytes: buffer.length,
    width: size?.width ?? null,
    height: size?.height ?? null,
    filename: sanitizeFilename(typeof image === 'object' ? image?.filename : '', { fallback: 'image' }),
  };
}

/**
 * Đọc kích thước ảnh từ header (không giải mã pixel). Trả null nếu không chắc —
 * khi đó để pipeline tự báo UNSUPPORTED_IMAGE thay vì đoán bừa.
 */
function readImageDimensions(buf, mime) {
  try {
    if (mime === 'image/png') {
      if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/gif') {
      if (buf.length < 10) return null;
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === 'image/webp') {
      if (buf.length < 30) return null;
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X') {
        return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      }
      if (fourcc === 'VP8L') {
        const b0 = buf[21];
        const b1 = buf[22];
        const b2 = buf[23];
        const b3 = buf[24];
        return {
          width: 1 + (b0 | ((b1 & 0x3f) << 8)),
          height: 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)),
        };
      }
      if (fourcc === 'VP8 ') {
        // Khung keyframe: start code 0x9d 0x01 0x2a rồi mới tới kích thước.
        if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      return null;
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i += 1;
          continue;
        }
        const marker = buf[i + 1];
        if (marker === 0xff || marker === 0x00) {
          i += 1;
          continue;
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
          i += 2;
          continue;
        }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return null;
        const isSof =
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf);
        if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + len;
      }
      return null;
    }
  } catch {
    return null;
  }
  return null;
}

/** Tuỳ chọn gửi kèm pipeline — làm sạch, chặn prototype pollution, có trần kích thước. */
function sanitizeImagelabOptions(raw, config) {
  const options = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return options;

  const context = sanitizeText(raw.context, { maxLength: 1000 });
  if (context) options.context = context;

  const extra = raw.glossary_extra;
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    const out = {};
    for (const [k, v] of Object.entries(extra).slice(0, 200)) {
      if (DANGEROUS_KEYS.has(k)) continue;
      const key = sanitizeText(k, { maxLength: 120 });
      const value = sanitizeText(v, { maxLength: 300 });
      if (key && value) out[key] = value;
    }
    if (Object.keys(out).length > 0) options.glossary_extra = out;
  }

  const maxRegions = Number.parseInt(raw.max_regions, 10);
  const cap = config.imagelab?.maxRegions ?? DEFAULT_MAX_REGIONS;
  if (Number.isFinite(maxRegions) && maxRegions > 0) options.max_regions = Math.min(maxRegions, cap);

  return options;
}

/** Danh sách sửa dòng: chỉ nhận id hợp lệ, text đã làm sạch, action trong danh sách đóng. */
function sanitizeEdits(raw) {
  if (!Array.isArray(raw)) throw new HttpError(400, 'BAD_EDITS', 'Thiếu danh sách `edits`.');
  if (raw.length > 500) throw new HttpError(413, 'TOO_MANY_EDITS', 'Quá nhiều dòng cần lưu (tối đa 500).');

  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const regionId = sanitizeText(e.region_id, { maxLength: 64 });
    if (!REGION_ID_RE.test(regionId)) continue;
    const textVi = sanitizeText(e.text_vi, { maxLength: 2000 });
    const action = EDIT_ACTIONS.has(e.action) ? e.action : typeof e.text_vi === 'string' ? 'edit' : 'accept';
    out.push({ region_id: regionId, text_vi: textVi, action });
  }
  if (out.length === 0) throw new HttpError(400, 'BAD_EDITS', 'Không có dòng hợp lệ nào để lưu.');
  return out;
}

/** Trần ký tự chữ mỗi vùng nhập tay (§11.2 luật 1) — mức API, khớp `manual-regions.js`. */
const MANUAL_REGION_TEXT_MAX = 500;

/**
 * Body `PUT /api/imagelab/jobs/:id/regions`: giữ các trường hợp lệ và làm sạch `text`.
 *
 * GIỮ NGUYÊN VỊ TRÍ, kể cả mục rác: `rejected[].index` là vị trí trong mảng CLIENT GỬI
 * (§11.2 luật 10), nên lọc bỏ mục rác ở đây sẽ làm lệch index mà UI đang đối chiếu.
 * Luật hình học / `kind` / `confidence` / khử trùng id KHÔNG được chép lại ở đây —
 * chúng nằm ở ĐÚNG MỘT chỗ: `src/imagelab/manual-regions.js`.
 */
function sanitizeManualRegionsInput(raw) {
  return (Array.isArray(raw) ? raw : []).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry; // để C4 báo NOT_OBJECT
    const rawText = entry.text;
    return {
      id: entry.id,
      box:
        entry.box && typeof entry.box === 'object' && !Array.isArray(entry.box)
          ? {
              x: entry.box.x,
              y: entry.box.y,
              w: entry.box.w ?? entry.box.width,
              h: entry.box.h ?? entry.box.height,
            }
          : null,
      // Chỉ làm sạch khi là chuỗi/số; object/mảng để C4 báo TEXT_EMPTY thay vì hoá thành '[object Object]'.
      text:
        typeof rawText === 'string' || typeof rawText === 'number'
          ? sanitizeText(rawText, { maxLength: MANUAL_REGION_TEXT_MAX })
          : rawText,
      kind: typeof entry.kind === 'string' ? sanitizeText(entry.kind, { maxLength: 32 }) : entry.kind,
      confidence: entry.confidence,
      // IL08-02: cờ HẠ MỨC bảo vệ phải đi tới `manual-regions.js` theo TỪNG vùng; thiếu cờ
      // thì kind do client khai chỉ được LEO THANG (không bao giờ hạ).
      ...(entry.allow_kind_downgrade === true ? { allow_kind_downgrade: true } : {}),
    };
  });
}

function sanitizeRegionIds(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'BAD_REGION_IDS', '`only_region_ids` phải là một mảng.');
  const out = [];
  for (const v of raw.slice(0, 500)) {
    const id = sanitizeText(v, { maxLength: 64 });
    if (REGION_ID_RE.test(id)) out.push(id);
  }
  return [...new Set(out)];
}

/** Lỗi pipeline/provider → HTTP an toàn, giữ nguyên mã lỗi THẬT của provider. */
function mapImagelabError(err, fallbackMessage = 'Không xử lý được yêu cầu.') {
  if (err instanceof HttpError) return err;
  // MVP-05: thiếu credit (hook giữ tiền của A3 ném ra từ pipeline) ⇒ 402, KHÔNG phải 500.
  const billing = mapBillingError(err);
  if (billing) return billing;
  const code = typeof err?.code === 'string' && err.code ? err.code : 'IMAGELAB_FAILED';
  const message = typeof err?.message === 'string' && err.message ? err.message : fallbackMessage;
  if (code === 'REVIEW_REQUIRED') return HttpError.safe(409, code, message);
  if (code === 'IMAGELAB_NO_LINES') return HttpError.safe(409, code, message);
  // IL-08 (§11.1): lỗi có câu tiếng Việt do repo viết ⇒ `HttpError.safe` để client thấy
  // ĐÚNG câu đó (kể cả khi pipeline chạy qua tầng khác). `details` giữ danh sách vùng đã
  // sửa tay để UI cảnh báo trước khi người dùng bấm "Vẫn thay".
  if (code === 'IMAGELAB_NO_ORIGINAL' || code === 'MANUAL_EDITS_WOULD_BE_LOST') {
    return HttpError.safe(409, code, message, err?.details && typeof err.details === 'object' ? err.details : {});
  }
  // IL08-01(a) (vòng 6): job đang chạy OCR/dịch ⇒ 409 + câu tiếng Việt (UI hiện "chờ xong").
  if (code === 'IMAGELAB_JOB_RUNNING') {
    return HttpError.safe(409, code, message, err?.details && typeof err.details === 'object' ? err.details : {});
  }
  if (code === 'NO_REGIONS') return HttpError.safe(400, code, message);
  if (code === 'TOO_MANY_REGIONS') return HttpError.safe(413, code, message);
  // Lỗi do CHÍNH ảnh người dùng gửi lên (ingest chạy trong request) — phải trả đúng
  // loại lỗi 4xx kèm lý do thật, không gộp vào "provider báo lỗi 502".
  if (code === 'UNSUPPORTED_IMAGE') return new HttpError(415, code, message);
  if (code === 'IMAGE_TOO_LARGE' || code === 'PIXELS_EXCEEDED') return new HttpError(413, code, message);
  if (code === 'INVALID_IMAGE' || code === 'INVALID_INPUT' || code === 'MISSING_IMAGE' || code === 'BAD_IMAGE') {
    return new HttpError(400, code, message);
  }
  if (code === 'OUTPUT_TOO_LARGE') return new HttpError(413, code, message);
  if (code === 'NOT_CONFIGURED') {
    // F-05: câu này do repo tự viết, không chứa chi tiết provider → hiện thẳng.
    return HttpError.safe(502, code, message);
  }
  if (/^(OCR|RENDER|TRANSLATE)/.test(code)) {
    return new HttpError(502, code, `Provider xử lý ảnh báo lỗi (${code}). Vui lòng thử lại hoặc kiểm tra cấu hình provider.`);
  }
  return new HttpError(500, code, fallbackMessage);
}

function extForMime(mime) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime] || 'bin';
}

/* ══════════════════ MVP-03 · hằng số + bộ làm sạch dùng chung ══════════════════ */

/** Loại job của MVP-03 (§3.3, giá trị ĐÓNG BĂNG — E3 export cùng tên ở `imagestudio/pipeline.js`). */
const IMAGESTUDIO_KIND = 'image_generation';

/**
 * Các khoá mà `drawOverlay` (E2) coi là "chữ gốc của job" — dùng để (a) gom bằng chứng từ
 * dữ liệu ĐÃ LƯU của job và (b) biết khi nào client tự khai bằng chứng (khi đó tầng vẽ phán
 * quyết, route không chặn trước). Danh sách này bám `resolveSourceText` của E2.
 */
const IMAGESTUDIO_EVIDENCE_KEYS = Object.freeze([
  'source_text',
  'sourceText',
  'source',
  'text_source',
  'text_original',
  'job_text',
  'job_source',
  'evidence',
  'evidence_text',
  'evidence_texts',
  'original_text',
  'ocr_text',
  'product_name',
  'user_note',
  'note',
  'notes',
]);

const IMAGESTUDIO_OVERLAY_TEXT_MAX = 500;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Body `options` của MVP-03 (`{ template?, remove_background?, retouch?, overlay? }`).
 *
 * Nguyên tắc: route KIỂM KIỂU và LÀM SẠCH, nhưng KHÔNG áp luật nghiệp vụ thay các tầng dưới.
 * Đặc biệt KHÔNG kẹp tham số retouch ở đây: việc kẹp theo `RETOUCH_LIMITS` + ghi `clamped[]`
 * thuộc E1/E3 (§3.4) — kẹp sớm ở route sẽ làm MẤT vết "tham số bị kẹp" mà hợp đồng bắt buộc.
 * Ngoại lệ duy nhất: kiểu SAI rõ ràng (không phải object/boolean/số) ⇒ 400 ngay, không đoán.
 */
function sanitizeImagestudioOptions(raw) {
  const options = {};
  if (raw === undefined || raw === null) return options;
  if (!isPlainObject(raw)) {
    throw HttpError.safe(400, 'BAD_OPTIONS', '`options` phải là một object.');
  }

  const template = sanitizeText(raw.template, { maxLength: 64 });
  if (template) options.template = template;

  if (raw.remove_background !== undefined && raw.remove_background !== null) {
    if (typeof raw.remove_background !== 'boolean') {
      throw HttpError.safe(400, 'BAD_OPTIONS', '`options.remove_background` phải là true hoặc false.');
    }
    options.remove_background = raw.remove_background;
  }

  if (raw.retouch !== undefined && raw.retouch !== null) {
    if (!isPlainObject(raw.retouch)) {
      throw HttpError.safe(400, 'BAD_OPTIONS', '`options.retouch` phải là object các tham số số (brightness/contrast/saturation/sharpen).');
    }
    options.retouch = sanitizeRetouchPassThrough(raw.retouch);
  }

  if (raw.overlay !== undefined && raw.overlay !== null) {
    options.overlay = sanitizeImagestudioOverlay(raw.overlay);
  }

  // N1 (vòng 9): người dùng CHẤP NHẬN ghép nền dù biên nhập nhằng (bóng đổ mềm/viền mờ).
  // Mặc định KHÔNG bật; bật thì tầng matting vẫn ghép nhưng ghi vết nổi bật.
  if (raw.matting_allow_ambiguous !== undefined && raw.matting_allow_ambiguous !== null) {
    if (typeof raw.matting_allow_ambiguous !== 'boolean') {
      throw HttpError.safe(400, 'BAD_OPTIONS', '`options.matting_allow_ambiguous` phải là true hoặc false.');
    }
    options.matting_options = { ...(options.matting_options || {}), matting_allow_ambiguous: raw.matting_allow_ambiguous === true };
  }

  return options;
}

/**
 * Tham số retouch: chuyển THẲNG giá trị cho tầng retouch (E1/E3 tự kẹp + tự ghi
 * `clamped[]`/`rejected[]`); chỉ loại khoá nguy hiểm (prototype pollution) và hạ giá trị
 * không nguyên thuỷ xuống `null` — tầng retouch coi `null` là "không phải số hữu hạn" nên
 * VẪN báo trong `rejected[]`, không im lặng. Trần 32 khoá để body rác không phình vô hạn.
 */
function sanitizeRetouchPassThrough(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw).slice(0, 32)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const name = sanitizeText(key, { maxLength: 32 });
    if (!name) continue;
    out[name] = value === null || ['number', 'string', 'boolean'].includes(typeof value) ? value : null;
  }
  return out;
}

/** `overlay` (§3.2): `{ text, x, y, size?, color?, align? }` + các khoá bằng chứng (nếu client khai). */
function sanitizeImagestudioOverlay(raw) {
  if (!isPlainObject(raw)) {
    throw HttpError.safe(400, 'BAD_OPTIONS', '`options.overlay` phải là object dạng { text, x, y, size?, color?, align? }.');
  }
  const out = { text: '' };
  const rawText = raw.text;
  if (rawText !== undefined && rawText !== null) {
    if (typeof rawText !== 'string' && typeof rawText !== 'number') {
      throw HttpError.safe(400, 'BAD_OPTIONS', '`options.overlay.text` phải là chuỗi.');
    }
    out.text = sanitizeText(rawText, { maxLength: IMAGESTUDIO_OVERLAY_TEXT_MAX });
  }

  for (const key of ['x', 'y', 'size']) {
    const value = raw[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw HttpError.safe(400, 'BAD_OPTIONS', `\`options.overlay.${key}\` phải là một số hữu hạn.`);
    }
    out[key] = value;
  }
  // `align` lạ KHÔNG bị từ chối: `drawOverlay` đã fail-closed về 'left' cho giá trị không
  // nằm trong left|center|right — chép lại luật đó ở route là thêm một bản dễ lệch.
  const color = sanitizeText(raw.color, { maxLength: 32 });
  if (color) out.color = color;
  const align = sanitizeText(raw.align, { maxLength: 16 });
  if (align) out.align = align;

  // M03-02 (vòng 8): bằng chứng do CLIENT khai bị BỎ HOÀN TOÀN — không chuyển xuống tầng vẽ,
  // không dùng làm "chữ gốc của job". Bằng chứng chỉ lấy từ dữ liệu ĐÃ LƯU của job (tên sản
  // phẩm, vùng OCR, vùng người dùng nhập, ghi chú đã lưu) — bài học "bằng chứng vòng" §7.1.
  // Khoá nào client có gửi thì GHI LẠI TÊN để câu trả lời nói rõ là đã bỏ qua (không im lặng).
  const ignored = [];
  for (const key of IMAGESTUDIO_EVIDENCE_KEYS) {
    const value = raw[key];
    const hasText = typeof value === 'string' && value.trim();
    const hasLines = Array.isArray(value) && value.some((l) => typeof l === 'string' && l.trim());
    const hasObject = value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
    if (hasText || hasLines || hasObject) ignored.push(key);
  }
  if (ignored.length > 0) out.client_evidence_ignored = ignored;
  return out;
}

/**
 * 422 khi overlay bị chặn vì thiếu bằng chứng (§3.5).
 *
 * Trả CẢ HAI hình dạng: phong bì lỗi chuẩn của repo (`{ error: { code, message, details } }`)
 * và các trường phẳng `{ code, message, violations }` mà hợp đồng 3.6 yêu cầu — UI/test đọc
 * kiểu nào cũng đúng, và KHÔNG lộ stack/đường dẫn nội bộ.
 */
function sendImagestudioOverlayBlocked(res, { code, message, violations } = {}) {
  const list = asArray(violations).map(String);
  const errorCode = code || 'OVERLAY_UNSUPPORTED_CLAIM';
  sendJson(res, 422, {
    error: { code: errorCode, message, details: { violations: list } },
    code: errorCode,
    message,
    violations: list,
  });
}

/**
 * Dấu vết ba bước của ẢNH ĐÃ TẠO, đọc từ ĐÚNG dữ liệu E3 lưu (`meta` của ảnh rendered).
 *
 * Ưu tiên `meta.matting/compose/retouch` nếu E3 ghi thẳng bản mô tả đầy đủ. Nếu chưa, dựng
 * bản mô tả TỐI THIỂU từ hai nguồn THẬT đã lưu:
 *   - `meta.generator` (E3 luôn ghi): `matting_status`, `compose_background_ratio`, `retouch_status`;
 *   - `meta.retouch_effective/retouch_clamped/retouch_rejected`, `meta.template`;
 *   - bản tổng hợp của CHÍNH lượt chạy đã tạo ra ảnh này (`run`, truyền vào chỉ khi khớp
 *     `rendered_asset_id`) để lấy `providers`, `composed`, mã lỗi từng bước.
 * Trường nào E3 KHÔNG lưu (mask, coverage, output…) để `null` — KHÔNG bịa số đo.
 */
function imagestudioStepTraces(blob, run) {
  const generator = isPlainObject(blob?.generator) ? blob.generator : null;
  const providers = isPlainObject(run?.providers) ? run.providers : null;
  const failures = asArray(run?.failures);
  const failureCode = (step) => {
    const hit = failures.find((f) => f && String(f.step) === step && f.code);
    return hit ? String(hit.code) : null;
  };
  const asFinite = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

  const matting =
    blob?.matting ??
    (generator?.matting_status
      ? {
          status: String(generator.matting_status),
          provider: providers?.matting?.name ?? null,
          is_mock: providers?.matting?.is_mock ?? null,
          error_code: failureCode('matting'),
          mask: null,
          output: null,
          kept_bbox: null,
          warnings: [],
        }
      : null);

  const compose =
    blob?.compose ??
    (generator || run
      ? {
          applied: typeof run?.composed === 'boolean' ? run.composed : null,
          template: blob?.template ?? null,
          background_ratio: asFinite(generator?.compose_background_ratio),
          output: null,
          warnings: [],
        }
      : null);

  const retouch =
    blob?.retouch ??
    (generator?.retouch_status || blob?.retouch_effective
      ? {
          status: generator?.retouch_status ? String(generator.retouch_status) : null,
          params_effective: blob?.retouch_effective ?? null,
          clamped: asArray(blob?.retouch_clamped).map(String),
          rejected: asArray(blob?.retouch_rejected).map(String),
          error_code: failureCode('retouch'),
          output: null,
          warnings: [],
        }
      : null);

  return { matting, compose, retouch };
}

/**
 * Lượt chạy MỚI NHẤT của job (E3 lưu ở `jobs.content_meta.imagestudio`) — kể cả khi lượt đó
 * KHÔNG tạo ảnh mới (NO_CHANGES). Chỉ trả field cần cho UI và ĐÃ LỌC đường dẫn nội bộ.
 */
function imagestudioLastRun(run) {
  if (!isPlainObject(run)) return null;
  const text = (v) => (typeof v === 'string' && v ? scrubPaths(v) : null);
  return {
    status: run.status ?? null,
    error_code: run.error_code ?? null,
    error_message: text(run.error_message),
    updated_at: run.updated_at ?? null,
    rendered_asset_id: run.rendered_asset_id ?? null,
    original_asset_id: run.original_asset_id ?? null,
    template: run.template ?? null,
    synthetic_background: run.synthetic_background ?? null,
    // N9 (vòng 10): `last_run` cũng mang theo bản tóm tắt matting (có mask) — lượt KHÔNG tạo
    // ảnh mới (NO_CHANGES / bị chặn) vẫn phải cho UI đọc được số đo thay vì mất hút.
    matting: isPlainObject(run.matting) ? run.matting : null,
    retouch_effective: run.retouch_effective ?? null,
    retouch_clamped: asArray(run.retouch_clamped).map(String),
    retouch_rejected: asArray(run.retouch_rejected).map(String),
    overlay: run.overlay ?? null,
    providers: run.providers ?? null,
    warnings: asArray(run.warnings).map(String),
    failures: asArray(run.failures)
      .slice(0, 20)
      .map((f) => ({ step: f?.step ?? null, code: f?.code ?? null, message: text(f?.message) })),
  };
}

/**
 * Lỗi pipeline/provider MVP-03 → HTTP an toàn, giữ mã lỗi THẬT của tầng dưới.
 * Mọi câu chữ đều đi qua `scrubPaths` trước khi ra client (chặn rò đường dẫn nội bộ).
 */
function mapImagestudioError(err, fallbackMessage = 'Không tạo được ảnh.') {
  if (err instanceof HttpError) return err;
  // MVP-05: thiếu credit ⇒ 402 (cùng một cách hiểu với MVP-01/MVP-02), không phải 500.
  const billing = mapBillingError(err);
  if (billing) return billing;
  const code = typeof err?.code === 'string' && err.code ? err.code : 'IMAGESTUDIO_FAILED';
  const message = scrubPaths(typeof err?.message === 'string' && err.message ? err.message : fallbackMessage);
  const details = err?.details && typeof err.details === 'object' ? err.details : {};

  // §3.5 — overlay bị chặn vì thiếu bằng chứng: 422 kèm danh sách vi phạm.
  if (code === 'OVERLAY_UNSUPPORTED_CLAIM' || code === 'OVERLAY_NOT_TRANSLATED') {
    return HttpError.safe(422, code, message, details);
  }
  // §0 luật 3 — tách nền không đủ tự tin thì NÓI THẲNG kèm số đo thật, không cắt bừa.
  if (code === 'SEGMENTATION_FAILED' || code === 'UNIFORM_BACKGROUND_NOT_FOUND' || code === 'SUSPICIOUS_MASK') {
    return HttpError.safe(422, code, message, details);
  }
  if (
    code === 'IMAGESTUDIO_NO_ORIGINAL' ||
    code === 'IMAGESTUDIO_NO_ASSET' ||
    code === 'IMAGESTUDIO_NOT_IMAGE_JOB' ||
    code === 'IMAGESTUDIO_JOB_RUNNING' ||
    code === 'ALREADY_INGESTED'
  ) {
    return HttpError.safe(409, code, message, details);
  }
  if (code === 'TEMPLATE_NOT_FOUND') return new HttpError(400, code, message);
  if (code === 'UNSUPPORTED_IMAGE') return new HttpError(415, code, message);
  if (code === 'IMAGE_TOO_LARGE' || code === 'PIXELS_EXCEEDED' || code === 'OUTPUT_TOO_LARGE' || code === 'TOO_MANY_REGIONS') {
    return new HttpError(413, code, message);
  }
  if (code === 'MISSING_IMAGE' || code === 'BAD_IMAGE' || code === 'INVALID_IMAGE' || code === 'INVALID_INPUT' || code === 'BAD_OPTIONS') {
    return new HttpError(400, code, message);
  }
  if (code === 'NOT_CONFIGURED') return HttpError.safe(502, code, message);
  // Lỗi provider của MVP-03: KHÔNG dội chi tiết provider ra client (có thể chứa đường dẫn).
  if (/^(MATTING|COMPOSE|RETOUCH)/.test(code)) {
    return new HttpError(502, code, `Provider xử lý ảnh MVP-03 báo lỗi (${code}). Vui lòng thử lại hoặc kiểm tra cấu hình provider.`);
  }
  // Còn lại dùng chung bảng ánh xạ của MVP-02 (đã xử lý MISSING_IMAGE/BAD_IMAGE/NOT_CONFIGURED/…).
  return mapImagelabError({ code: err?.code, message, details }, fallbackMessage);
}

/* ══════════════════ MVP-04 · hằng số + bộ làm sạch dùng chung ══════════════════ */

/** Loại job của MVP-04 (§2.3, giá trị ĐÓNG BĂNG — V3 export cùng tên ở `videostudio/pipeline.js`). */
const VIDEOSTUDIO_KIND = 'video_generation';

/**
 * MIME NGOÀI danh sách ảnh mà route tệp của MVP-04 được phép trả về: `video/mp4` (đầu ra của
 * provider `ffmpeg`). Danh sách ảnh/GIF vẫn lấy từ `ALLOWED_IMAGE_MIME` của cấu hình — nới
 * cấu hình là nới luôn cho video, không phải sửa hai chỗ.
 */
const VIDEOSTUDIO_EXTRA_MIME = Object.freeze(['video/mp4']);

/** Trần số cảnh / số đoạn chữ mỗi request — chặn body rác phình vô hạn (V1 vẫn kẹp tiếp). */
const VIDEOSTUDIO_MAX_SCENES = 24;
const VIDEOSTUDIO_MAX_TEXTS = 60;
/** Trần ký tự mỗi đoạn chữ sẽ vẽ lên video (khớp `IMAGESTUDIO_OVERLAY_TEXT_MAX`). */
/**
 * F8: trần độ dài chữ — LẤY TỪ V1 (`plan/texts.js → VIDEOSTUDIO_TEXT_MAX`) khi nạp được, để chỉ
 * còn MỘT con số cho cả sanitize → plan/summary → UI. Không nạp được ⇒ 500 (cùng giá trị).
 */
const VIDEOSTUDIO_TEXT_MAX = 500; // giá trị dự phòng; `videostudioTextMax()` ưu tiên hằng của V1

/**
 * Khoá chứa chữ sẽ VẼ lên video — GIỮ KHỚP `TEXT_KEYS` của `src/videostudio/pipeline.js`
 * (`texts`, `text`, `title`, `subtitle`, `price`, `cta`). Route đọc đúng bộ khoá đó để (a) chuyển
 * tiếp chữ xuống V1/V3 và (b) kiểm chống bịa trên ĐÚNG những câu sẽ được vẽ.
 */
const VIDEOSTUDIO_TEXT_KEYS = Object.freeze(['texts', 'text', 'title', 'subtitle', 'price', 'cta']);

/**
 * Khoá ghi chú ĐÃ LƯU được coi là bằng chứng — GIỮ KHỚP `#evidenceText` của
 * `src/videostudio/pipeline.js` (nếu route rộng hơn V3 thì preflight cho qua rồi V3 chặn;
 * nếu hẹp hơn thì route chặn oan câu V3 sẽ vẽ được — cả hai đều sai).
 */
const VIDEOSTUDIO_EVIDENCE_KEYS = Object.freeze(['notes', 'note', 'user_note', 'source_text']);

/** Phần mở rộng cho tên tệp tải về — `video/mp4` không nằm trong bảng của MVP-02. */
function videostudioExtForMime(mime) {
  return mime === 'video/mp4' ? 'mp4' : extForMime(mime);
}

/** Một mục `image` của client có kèm base64 không (mục rỗng/thiếu ⇒ bỏ qua, không đoán). */
const hasImageBase64 = (value) =>
  Boolean(value) && typeof value === 'object' && typeof value.base64 === 'string' && value.base64.trim() !== '';

/**
 * Gom MỌI ảnh của một yêu cầu tạo video thành danh sách cảnh, theo ĐÚNG thứ tự:
 *   1. `body.image` — cảnh 1, khoá ĐÓNG BĂNG của §2.4 (thiếu ⇒ 400 như trước giờ);
 *   2. `body.options.scenes[i].image` — ảnh của từng cảnh, dạng mà UI V5 gửi (§2.5: "nhiều ảnh
 *      ⇒ nhiều cảnh, thứ tự = thứ tự chọn"; V5 ghi rõ nếu V4 chốt khoá khác thì chỉ sửa ở V5).
 *
 * Mọi ảnh đi qua CÙNG một bộ kiểm (`decodeImagelabImage`) nên 400/413/415 áp dụng như nhau,
 * không có đường lách qua cảnh phụ. Ảnh TRÙNG BYTE (UI gửi cùng một ảnh ở cả `image` lẫn
 * `scenes[0].image`) chỉ được nhận MỘT lần — nếu không, người dùng sẽ thấy cảnh lặp.
 */
function collectVideostudioImages(body, limits) {
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    const decoded = decodeImagelabImage(raw, limits);
    const key = createHash('sha256').update(decoded.buffer).digest('hex');
    if (seen.has(key)) return; // khử trùng theo sha256 (§2.5: cùng một ảnh chỉ là MỘT cảnh)
    seen.add(key);
    out.push(decoded);
  };
  const scenes = asArray(body?.options?.scenes);
  const scenesCarryFirstImage = hasImageBase64(scenes[0]?.image);
  // THỨ TỰ ẢNH = THỨ TỰ CẢNH (§2.5). Hai kiểu yêu cầu:
  //   · `scenes[0].image` có mặt ⇒ `scenes` là NGUỒN THỨ TỰ (UI V5 gửi như vậy); `image` chỉ là
  //     ảnh đầu tương thích ngược — nếu nó KHÁC byte với mọi ảnh của cảnh thì bị BỎ QUA (không
  //     chèn thêm cảnh lạ làm lệch thứ tự người dùng đã chọn) và ghi log để còn truy vết;
  //   · không có ảnh nào trong `scenes` ⇒ `image` là ảnh đầu (hành vi cũ, tương thích ngược),
  //     rồi mới tới ảnh của từng cảnh theo thứ tự.
  // Ảnh trùng byte luôn bị khử (một ảnh = một cảnh).
  if (scenesCarryFirstImage) {
    for (const scene of scenes) {
      if (hasImageBase64(scene?.image)) add(scene.image);
    }
    if (hasImageBase64(body?.image)) {
      const key = createHash('sha256').update(Buffer.from(String(body.image.base64), 'base64')).digest('hex');
      if (!seen.has(key)) {
        logger?.warn?.('videostudio.extra_image_ignored', {
          reason: '`image` khác byte với mọi `options.scenes[i].image` — bỏ qua để giữ ĐÚNG thứ tự cảnh người dùng chọn.',
        });
      }
    }
  } else {
    if (hasImageBase64(body?.image)) add(body.image);
    for (const scene of scenes) {
      if (hasImageBase64(scene?.image)) add(scene.image);
    }
  }
  if (out.length === 0) decodeImagelabImage(body?.image, limits); // ném 400 MISSING_IMAGE có sẵn
  if (out.length > VIDEOSTUDIO_MAX_SCENES) {
    throw new HttpError(
      413,
      'TOO_MANY_SCENES',
      `Quá nhiều ảnh trong một yêu cầu (${out.length}; tối đa ${VIDEOSTUDIO_MAX_SCENES} cảnh mỗi video).`,
    );
  }
  return out;
}

/**
 * Body `options` của MVP-04 (`{ preset?, scenes?, texts?, fit? }`).
 *
 * Nguyên tắc giống `sanitizeImagestudioOptions`: route KIỂM KIỂU và LÀM SẠCH, nhưng KHÔNG áp
 * luật nghiệp vụ thay V1 — thời lượng/kẹp trần/tỉ lệ/pad-crop là luật của `buildVideoPlan`,
 * chép lại ở đây là thêm một bản dễ lệch. Kiểu SAI rõ ràng (không phải object/mảng) ⇒ 400 ngay.
 */
function sanitizeVideostudioOptions(raw) {
  const options = {};
  if (raw === undefined || raw === null) return options;
  if (!isPlainObject(raw)) {
    throw HttpError.safe(400, 'BAD_OPTIONS', '`options` phải là một object.');
  }

  const preset = sanitizeText(raw.preset, { maxLength: 64 });
  if (preset) options.preset = preset;

  // `fit` lạ KHÔNG bị từ chối ở đây: V1 đã fail-closed về `FIT_MODES` (§2.1) — chỉ nhận chuỗi.
  const fit = sanitizeText(raw.fit, { maxLength: 16 });
  if (fit) options.fit = fit;

  if (raw.scenes !== undefined && raw.scenes !== null) options.scenes = sanitizeVideostudioScenes(raw.scenes);
  if (raw.texts !== undefined && raw.texts !== null) options.texts = sanitizeVideostudioTexts(raw.texts);

  // Chữ ở cấp CHUNG (`text`/`title`/`subtitle`/`price`/`cta`) — V3 đọc chúng cho cảnh không tự
  // khai chữ, nên route phải chuyển tiếp chứ không được nuốt.
  for (const key of VIDEOSTUDIO_TEXT_KEYS) {
    if (key === 'texts') continue;
    const value = sanitizeVideostudioTextField(raw[key]);
    if (value !== undefined) options[key] = value;
  }
  return options;
}

/** Một mục chữ (`string` | `{ text, … }`) → giá trị đã làm sạch, `null` nếu không có gì để vẽ. */
function sanitizeVideostudioTextItem(item, onDrop) {
  if (typeof item === 'string' || typeof item === 'number') {
    return sanitizeText(item, { maxLength: VIDEOSTUDIO_TEXT_MAX }) || null;
  }
  if (!isPlainObject(item)) {
    // N3 (phản biện vòng 5): mục là MẢNG LỒNG (`[[str]]`) hoặc rác ⇒ trước đây bị bỏ IM LẶNG.
    onDrop?.(Array.isArray(item) ? 'TEXT_ITEM_IS_ARRAY' : 'TEXT_ITEM_NOT_OBJECT');
    return null;
  }
  const entry = {};
  // `text` chỉ nhận chuỗi/số. Object lồng (vd `{text:{label:'…'}}`) trước đây bị `sanitizeText`
  // biến thành "[object Object]" và VẼ LÊN VIDEO (17.400 px) — nay bỏ + cảnh báo.
  const text = typeof item.text === 'string' || typeof item.text === 'number'
    ? sanitizeText(item.text, { maxLength: VIDEOSTUDIO_TEXT_MAX })
    : '';
  if (text) entry.text = text;
  else if (item.text !== undefined && item.text !== null) onDrop?.('TEXT_ITEM_NESTED_OBJECT');
  for (const [key, value] of Object.entries(item).slice(0, 24)) {
    if (key === 'text' || DANGEROUS_KEYS.has(key)) continue;
    const name = sanitizeText(key, { maxLength: 32 });
    if (!name) continue;
    if (typeof value === 'string') {
      const v = sanitizeText(value, { maxLength: 120 });
      if (v) entry[name] = v;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      entry[name] = value;
    } else if (typeof value === 'boolean') {
      entry[name] = value;
    }
  }
  return Object.keys(entry).length > 0 ? entry : null;
}

/** Trường chữ ở cấp chung: giữ nguyên dạng (chuỗi ⇒ chuỗi, mảng ⇒ mảng), rỗng ⇒ `undefined`. */
function sanitizeVideostudioTextField(value) {
  if (value === undefined || value === null) return undefined;
  const list = (Array.isArray(value) ? value : [value]).slice(0, VIDEOSTUDIO_MAX_TEXTS);
  const out = list.map((item) => sanitizeVideostudioTextItem(item)).filter((item) => item !== null);
  if (out.length === 0) return undefined;
  return Array.isArray(value) ? out : out[0];
}

/**
 * `scenes`: mảng mô tả cảnh (mỗi ảnh người dùng tải lên ⇒ một cảnh, thứ tự = thứ tự chọn).
 * Chỉ giữ giá trị NGUYÊN THUỶ (chuỗi đã làm sạch / số hữu hạn / boolean / mảng ngắn), bỏ khoá
 * nguy hiểm (prototype pollution) và bỏ mục rác — KHÔNG đoán giá trị thiếu.
 */
function sanitizeVideostudioScenes(raw) {
  if (!Array.isArray(raw)) throw HttpError.safe(400, 'BAD_OPTIONS', '`options.scenes` phải là một mảng.');
  if (raw.length > VIDEOSTUDIO_MAX_SCENES) {
    throw new HttpError(413, 'TOO_MANY_SCENES', `Quá nhiều cảnh trong một yêu cầu (tối đa ${VIDEOSTUDIO_MAX_SCENES}).`);
  }
  const out = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const scene = {};
    // Chữ của cảnh (`text`/`title`/`subtitle`/`price`/`cta`/`texts`) đi qua ĐÚNG bộ làm sạch chữ.
    for (const key of VIDEOSTUDIO_TEXT_KEYS) {
      const value = sanitizeVideostudioTextField(item[key]);
      if (value !== undefined) scene[key] = value;
    }
    for (const [key, value] of Object.entries(item).slice(0, 24)) {
      if (VIDEOSTUDIO_TEXT_KEYS.includes(key) || DANGEROUS_KEYS.has(key)) continue;
      const name = sanitizeText(key, { maxLength: 32 });
      if (!name) continue;
      if (typeof value === 'string') {
        const text = sanitizeText(value, { maxLength: 300 });
        if (text) scene[name] = text;
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        scene[name] = value;
      } else if (typeof value === 'boolean') {
        scene[name] = value;
      } else if (Array.isArray(value)) {
        const list = value
          .slice(0, 50)
          .filter((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
          .map((v) => (typeof v === 'string' ? sanitizeText(v, { maxLength: 300 }) : v));
        if (list.length > 0) scene[name] = list;
      }
    }
    if (Object.keys(scene).length > 0) out.push(scene);
  }
  return out;
}

/**
 * `texts`: các đoạn chữ sẽ VẼ lên video (tiêu đề/giá/CTA/phụ đề). Nhận chuỗi hoặc object
 * `{ text, … }`; giữ các khoá định vị/kiểu chữ mà UI gửi kèm để V1 khỏi phải đoán lại.
 */
function sanitizeVideostudioTexts(raw) {
  if (!Array.isArray(raw)) throw HttpError.safe(400, 'BAD_OPTIONS', '`options.texts` phải là một mảng.');
  if (raw.length > VIDEOSTUDIO_MAX_TEXTS) {
    throw new HttpError(413, 'TOO_MANY_TEXTS', `Quá nhiều đoạn chữ trong một yêu cầu (tối đa ${VIDEOSTUDIO_MAX_TEXTS}).`);
  }
  const dropped = [];
  const out = raw
    .map((item) => sanitizeVideostudioTextItem(item, (reason) => dropped.push(reason)))
    .filter((item) => item !== null);
  if (dropped.length > 0) {
    // N3 (phản biện vòng 5): trước đây mục chữ hỏng bị bỏ IM LẶNG (`[[str]]` ⇒ video không có chữ,
    // không một cảnh báo). Nay nói thẳng bằng mã lỗi để người dùng biết mình gửi sai dạng.
    throw HttpError.safe(
      400,
      'BAD_TEXT_SHAPE',
      'Dữ liệu chữ không hợp lệ: mỗi mục phải là chuỗi, số, hoặc object có `text`/`content`/`label`/`value` là chuỗi/số (không nhận mảng lồng hay object lồng).',
      { dropped_count: dropped.length, reasons: [...new Set(dropped)] },
    );
  }
  return out;
}

/**
 * 422 khi chữ trên video bị chặn vì thiếu bằng chứng (§0 luật 3).
 *
 * Trả CẢ HAI hình dạng: phong bì lỗi chuẩn của repo (`{ error: { code, message, details } }`)
 * và các trường phẳng `{ code, message, violations }` mà hợp đồng §2.4 yêu cầu — UI/test đọc
 * kiểu nào cũng đúng, và KHÔNG lộ stack/đường dẫn nội bộ.
 */
function sendVideostudioTextBlocked(res, { code, message, violations } = {}) {
  const list = asArray(violations).map(String);
  const errorCode = code || 'VIDEO_TEXT_UNSUPPORTED_CLAIM';
  sendJson(res, 422, {
    error: { code: errorCode, message, details: { violations: list } },
    code: errorCode,
    message,
    violations: list,
  });
}

/**
 * Một vi phạm chống bịa (chuỗi, hoặc object `{ rule, code, message, text }` của V1) → câu tiếng
 * Việt để UI hiện thẳng. Hàm THUẦN ở cấp module vì cả route (422) lẫn `last_run` đều dùng.
 */
function violationText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const detail = v.message ?? v.detail ?? v.reason ?? '';
  const where = v.text ?? v.word ?? '';
  return [where, detail].map((x) => String(x ?? '').trim()).filter(Boolean).join(' — ');
}

/**
 * Lượt chạy MỚI NHẤT của job video (V3 lưu ở `jobs.content_meta.videostudio`) — kể cả khi lượt
 * đó KHÔNG tạo được video. Chỉ trả field UI cần, đã LỌC đường dẫn nội bộ (`scrubPaths`).
 */
function videostudioLastRun(run) {
  if (!isPlainObject(run)) return null;
  const text = (v) => (typeof v === 'string' && v ? scrubPaths(v) : null);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  // `content_meta.videostudio.preset` của V3 là OBJECT mô tả preset (không phải id) — lấy id ra.
  const presetId = typeof run.preset === 'string' ? run.preset : run.preset_id ?? run.preset?.id ?? null;
  return {
    status: run.status ?? null,
    stage: run.stage ?? null,
    run_key: run.run_key ?? null,
    error_code: run.error_code ?? null,
    error_message: text(run.error_message),
    updated_at: run.updated_at ?? null,
    rendered_asset_id: run.rendered_asset_id ?? run.asset?.id ?? null,
    original_asset_id: run.original_asset_id ?? null,
    preset_id: presetId,
    duration_ms: num(run.duration_ms),
    frames: num(run.frames),
    // §0 luật 2: `audio` LUÔN là null ở bản offline — trả đúng giá trị đã lưu, không suy diễn.
    audio: run.audio ?? null,
    no_audio: run.no_audio === true,
    warnings: asArray(run.warnings).map(String),
    // V3 lưu bản mô tả plan/encode của LƯỢT NÀY ở `content_meta` — chuyển tiếp để UI đọc được
    // cả khi lượt đó KHÔNG tạo ra video (nhờ vậy không phải suy từ ảnh cũ).
    plan: run.plan ?? run.plan_summary ?? null,
    encode: run.encode ?? run.encode_summary ?? null,
    providers: isPlainObject(run.providers) ? run.providers : null,
    violations: asArray(run.violations).map(violationText).filter(Boolean),
    evidence_used: isPlainObject(run.evidence_used) ? run.evidence_used : null,
    failures: asArray(run.failures)
      .slice(0, 20)
      .map((f) => ({ step: f?.step ?? null, code: f?.code ?? null, message: text(f?.message) })),
  };
}

/**
 * Lỗi pipeline/mã hoá MVP-04 → HTTP an toàn, giữ mã lỗi THẬT của tầng dưới.
 * Mọi câu chữ đều đi qua `scrubPaths` trước khi ra client (chặn rò đường dẫn nội bộ).
 */
function mapVideostudioError(err, fallbackMessage = 'Không tạo được video.') {
  if (err instanceof HttpError) return err;
  // MVP-05: thiếu credit ⇒ 402 (cùng một cách hiểu với MVP-01/02/03), KHÔNG phải 500.
  const billing = mapBillingError(err);
  if (billing) return billing;
  const code = typeof err?.code === 'string' && err.code ? err.code : 'VIDEOSTUDIO_FAILED';
  const message = scrubPaths(typeof err?.message === 'string' && err.message ? err.message : fallbackMessage);
  const details = isPlainObject(err?.details) ? err.details : {};

  // §0 luật 3 — chữ thiếu bằng chứng: 422 kèm danh sách vi phạm (KHÔNG BAO GIỜ là 500).
  if (code === 'VIDEO_TEXT_UNSUPPORTED_CLAIM') {
    return HttpError.safe(422, code, message, { violations: asArray(details.violations).map(String) });
  }
  if (code === 'VIDEO_TEXT_NOT_TRANSLATED') return HttpError.safe(422, code, message, { violations: [] });
  // Xung đột trạng thái: chưa có ảnh gốc / sai loại job / job đang chạy (MVP-05 §BR-02).
  if (
    code === 'VIDEOSTUDIO_NO_ORIGINAL' ||
    code === 'VIDEOSTUDIO_NOT_VIDEO_JOB' ||
    code === 'VIDEOSTUDIO_JOB_RUNNING' ||
    code === 'JOB_ALREADY_RUNNING' ||
    code === 'ALREADY_INGESTED'
  ) {
    return HttpError.safe(409, code, message, details);
  }
  // Bộ mã hoá chưa cấu hình / thiếu `ffmpeg` ⇒ nói thẳng là chưa chạy được, KHÔNG bịa kết quả.
  if (code === 'VIDEO_NOT_CONFIGURED' || code === 'NOT_CONFIGURED' || code === 'FFMPEG_NOT_AVAILABLE') {
    return HttpError.safe(502, code, message, details);
  }
  if (code === 'BAD_PRESET' || code === 'UNSUPPORTED_PRESET' || code === 'PRESET_NOT_FOUND') {
    return new HttpError(400, code, message);
  }
  // Lỗi do CHÍNH ảnh người dùng gửi lên (ingest chạy trong request) — đúng loại 4xx, không gộp 502.
  if (code === 'UNSUPPORTED_IMAGE') return new HttpError(415, code, message);
  if (
    code === 'IMAGE_TOO_LARGE' ||
    code === 'PIXELS_EXCEEDED' ||
    code === 'OUTPUT_TOO_LARGE' ||
    code === 'TOO_MANY_SCENES' ||
    code === 'TOO_MANY_TEXTS'
  ) {
    return new HttpError(413, code, message);
  }
  if (code === 'MISSING_IMAGE' || code === 'BAD_IMAGE' || code === 'INVALID_IMAGE' || code === 'INVALID_INPUT' || code === 'BAD_OPTIONS') {
    return new HttpError(400, code, message);
  }
  // Lỗi provider mã hoá/vẽ khung: KHÔNG dội chi tiết provider ra client (có thể chứa đường dẫn).
  if (/^(VIDEO|GIF|FRAME|ENCODE|RENDER)/.test(code)) {
    return new HttpError(502, code, `Bộ mã hoá/vẽ video báo lỗi (${code}). Vui lòng thử lại hoặc kiểm tra cấu hình provider.`);
  }
  // Còn lại dùng chung bảng ánh xạ của MVP-02 (đã xử lý MISSING_IMAGE/BAD_IMAGE/NOT_CONFIGURED/…).
  return mapImagelabError({ code: err?.code, message, details }, fallbackMessage);
}

export default buildRouter;
