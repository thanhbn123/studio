/**
 * API routes — bề mặt công khai của ứng dụng.
 *
 * Mọi lỗi được ném dưới dạng HttpError với thông báo AN TOÀN (không lộ stack,
 * không lộ secret, không lộ chi tiết nội bộ).
 */

import { Router, HttpError, sendJson, readJson, sessionId, presentedSessionId, MAX_BODY_BYTES_DEFAULT, SECURITY_HEADERS } from './server.js';
import { scrubPaths } from '../logger.js';
import { tryDetectSource } from '../sources/detect.js';
import { STYLES, LENGTHS } from '../content/styles.js';
import { JOB_STATUS } from '../store/index.js';
import { enforce } from '../security/ratelimit.js';
import { sniffImageMime, sanitizeFilename, sanitizeText } from '../security/sanitize.js';
import { parseContentOptions } from '../content/styles.js';

const UUID_RE = /^[0-9a-fA-F-]{36}$|^[A-Za-z0-9_-]{8,64}$/;

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
  const requireImagelabJob = async (id, sid) => {
    requireImagelab();
    if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_JOB_ID', 'Mã job không hợp lệ.');
    const job = await store.getJob(id);
    if (!job || job.session_id !== sid) throw new HttpError(404, 'JOB_NOT_FOUND', 'Không tìm thấy job.');
    return job;
  };

  const requireImagelabAsset = async (id, sid) => {
    requireImagelab();
    requireStoreMethod('getImageAsset');
    if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_ASSET_ID', 'Mã ảnh không hợp lệ.');
    const asset = await store.getImageAsset(id);
    if (!asset) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');

    if (asset.session_id) {
      if (asset.session_id !== sid) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');
    } else if (asset.job_id) {
      // Thiếu session_id trên asset thì đối chiếu qua job sở hữu nó.
      const job = await store.getJob(asset.job_id);
      if (!job || job.session_id !== sid) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');
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
  const requireImagestudioJob = async (id, sid) => {
    requireImagestudio();
    if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_JOB_ID', 'Mã job không hợp lệ.');
    const job = await store.getJob(id);
    if (!job || job.session_id !== sid) throw new HttpError(404, 'JOB_NOT_FOUND', 'Không tìm thấy job.');
    return job;
  };

  /** Quyền sở hữu ẢNH theo session — cùng luật với `requireImagelabAsset` (khác chủ ⇒ 404). */
  const requireImagestudioAsset = async (id, sid) => {
    requireImagestudio();
    requireImagestudioStoreMethod('getImageAsset');
    if (!UUID_RE.test(id)) throw new HttpError(400, 'BAD_ASSET_ID', 'Mã ảnh không hợp lệ.');
    const asset = await store.getImageAsset(id);
    if (!asset) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');

    if (asset.session_id) {
      if (asset.session_id !== sid) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');
    } else if (asset.job_id) {
      const job = await store.getJob(asset.job_id);
      if (!job || job.session_id !== sid) throw new HttpError(404, 'ASSET_NOT_FOUND', 'Không tìm thấy ảnh.');
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
    sendJson(res, dbOk ? 200 : 503, {
      status: dbOk ? 'ok' : 'degraded',
      time: new Date().toISOString(),
      db: { dialect: store.dialect, ok: dbOk, error: dbError },
      jobs: queue.stats(),
      connectors: registry.list(),
      connector_init_failures: registry.initFailures,
      // 4.6 — UI/người vận hành dựa vào cờ này để biết MVP-02 có sẵn sàng không,
      // và `reason` để biết VÌ SAO nó tắt (không im lặng).
      imagelab: { available: imagelabAvailable(), reason: imagelabAvailable() ? null : imagelabUnavailableReason() },
    });
  });

  /* ─────────────────────────── Capabilities ─────────────────────────── */

  router.get('/api/config', async (req, res) => {
    const sessionStatus = await sessions.status();
    // MVP-03: mẫu nền + ngưỡng retouch nạp PHÒNG THỦ (module anh em có thể chưa có mặt).
    // Thiếu module ⇒ khối `imagestudio` báo `available: false` + templates rỗng, KHÔNG làm
    // hỏng /api/config mà MVP-01/MVP-02 đang dùng.
    const isModules = await imagestudioStaticModules();
    const isReady = imagestudioAvailable() && Boolean(isModules.templates && isModules.retouchLimits);
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

    const jobId = await store.createJob({
      sessionId: sid,
      source: detection?.source || 'manual',
      sourceUrl: url,
      canonicalUrl: detection?.canonical_url || '',
      sourceProductId: detection?.source_product_id || '',
      style: opts.style,
      length: opts.length,
      inputMode: url && hasManual ? 'link+manual' : url ? 'link' : 'manual',
    });

    queue.enqueue(jobId, () =>
      pipeline.run(jobId, {
        url,
        manual: hasManual ? manual : null,
        style: opts.style,
        length: opts.length,
        sessionId: sid,
      }),
    );

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
    const sessionIdFilter = scope === 'all' ? null : sid;
    const [rows, total] = await Promise.all([
      store.listJobs({ sessionId: sessionIdFilter, limit, offset }),
      store.countJobs({ sessionId: sessionIdFilter }),
    ]);
    // N-3 (vòng 4): mỗi dòng lịch sử phải phân biệt được job ImageLab và mang nhãn MOCK
    // theo DẤU VẾT ĐÃ LƯU của chính job đó (không theo cấu hình máy chủ đang chạy).
    // KHÔNG trả `session_id`/`content_meta` thô (dữ liệu nội bộ).
    const items = (Array.isArray(rows) ? rows : []).map((row) => {
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

    await store.updateJob(job.id, { style: opts.style, length: opts.length, status: JOB_STATUS.QUEUED, stage: 'regenerating' });
    queue.enqueue(job.id, () =>
      pipeline.resumeFromMaster(job.id, job.product_master, {
        sessionId: sid,
        style: opts.style,
        length: opts.length,
        extraInstructions: sanitizeText(body.extra_instructions, { maxLength: 1000 }),
      }),
    );
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

    const jobId = await store.createJob({
      sessionId: sid,
      source: 'manual',
      inputMode: 'manual',
      kind: 'image_translation',
    });

    // Ingest chạy NGAY trong request (xác thực magic bytes thêm một lần, dò kích thước,
    // ghi file + ghi DB) rồi mới xếp hàng OCR. Nhờ vậy:
    //   - `asset_id` trả về là THẬT (hợp đồng 4.5), không phải null;
    //   - ảnh hỏng/không hỗ trợ trả lỗi HTTP ngay, không biến thành một job chết
    //     trong hàng đợi mà người dùng không hiểu vì sao.
    let ingest;
    try {
      ingest = await app.imagelabPipeline.ingest(jobId, { image, sessionId: sid, options });
    } catch (err) {
      throw mapImagelabError(err, 'Không lưu được ảnh tải lên.');
    }

    queue.enqueue(jobId, () => app.imagelabPipeline.runOcr(jobId, { sessionId: sid, options }));

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
    const job = await requireImagelabJob(params.id, sid);

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
    const job = await requireImagelabJob(params.id, sid);

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
    const job = await requireImagelabJob(params.id, sid);

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

    let result;
    try {
      result = await app.imagelabPipeline.setManualRegions(job.id, {
        sessionId: sid,
        regions,
        replace,
        confirmReplaceEdited,
        // IL08-01(a): chỉ chặn khi có lượt OCR THẬT đang chờ/đang chạy trong hàng đợi.
        ocrPending: typeof queue?.isPending === 'function' ? queue.isPending(job.id) : null,
      });
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
    const job = await requireImagelabJob(params.id, sid);

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

    await store.updateJob(job.id, {
      status: JOB_STATUS.QUEUED,
      stage: 'rendering',
      error_code: null,
      error_message: null,
    });

    queue.enqueue(job.id, () =>
      app.imagelabPipeline.renderApproved(job.id, { sessionId: sid, onlyRegionIds, force, unknownRegionIds }),
    );

    sendJson(res, 202, { job_id: job.id, status: JOB_STATUS.QUEUED, force });
  });

  /* ── Metadata asset (KHÔNG kèm bytes, KHÔNG kèm đường dẫn nội bộ) ── */

  router.get('/api/imagelab/assets/:id', async (req, res, params) => {
    const sid = sessionId(req, res);
    const asset = await requireImagelabAsset(params.id, sid);
    sendJson(res, 200, assetJson(asset));
  });

  /* ── File ảnh nhị phân (có kiểm quyền sở hữu như mọi route khác) ── */

  router.get('/api/imagelab/assets/:id/file', async (req, res, params) => {
    const sid = sessionId(req, res);
    const asset = await requireImagelabAsset(params.id, sid);

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

    const jobId = await store.createJob({
      sessionId: sid,
      source: 'manual',
      inputMode: 'manual',
      kind: IMAGESTUDIO_KIND,
    });

    // Ingest chạy NGAY trong request (như MVP-02 đã làm) để `asset_id` trả về là THẬT và
    // ảnh hỏng/không hỗ trợ ra HTTP ngay, không biến thành job chết trong hàng đợi.
    let ingest;
    try {
      ingest = await app.imagestudioPipeline.ingest(jobId, { image, sessionId: sid, options });
    } catch (err) {
      await markImagestudioJobFailed(jobId, err);
      throw mapImagestudioError(err, 'Không lưu được ảnh tải lên.');
    }

    queue.enqueue(jobId, () => app.imagestudioPipeline.generate(jobId, { sessionId: sid, options, force: false }));

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
    const job = await requireImagestudioJob(params.id, sid);

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
    const job = await requireImagestudioJob(params.id, sid);

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

    await store.updateJob(job.id, {
      status: JOB_STATUS.QUEUED,
      stage: 'queued',
      error_code: null,
      error_message: null,
    });

    // Ảnh MỚI: pipeline ghi asset role `rendered` với `parent_id` = ảnh gốc; ảnh cũ còn nguyên.
    queue.enqueue(job.id, () => app.imagestudioPipeline.generate(job.id, { sessionId: sid, options, force }));

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
    const asset = await requireImagestudioAsset(params.id, sid);
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

  return router;
}

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

export default buildRouter;
