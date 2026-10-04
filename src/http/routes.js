/**
 * API routes — bề mặt công khai của ứng dụng.
 *
 * Mọi lỗi được ném dưới dạng HttpError với thông báo AN TOÀN (không lộ stack,
 * không lộ secret, không lộ chi tiết nội bộ).
 */

import { Router, HttpError, sendJson, readJson, sessionId, presentedSessionId, MAX_BODY_BYTES_DEFAULT, SECURITY_HEADERS } from './server.js';
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

    const list = Array.isArray(assets) ? assets : [];
    const originals = list.filter((a) => a.role === 'original');
    const rendered = list.filter((a) => a.role === 'rendered');
    const asset = originals.find((a) => !a.parent_id) || originals[0] || null;
    const lastRendered = rendered[rendered.length - 1] || null;

    sendJson(res, 200, {
      job: jobJson(job),
      asset: assetJson(asset),
      rendered: rendered.map(assetJson),
      regions: (rawRegions || []).map(regionJson),
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

    sendJson(res, 200, {
      job_id: job.id,
      status: result?.status ?? JOB_STATUS.AWAITING_REVIEW,
      regions: asArray(result?.regions).map(regionJson),
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
function regionJson(r) {
  const box = r.box && typeof r.box === 'object'
    ? r.box
    : { x: r.x, y: r.y, w: r.w, h: r.h };
  const norm = r.box_normalized && typeof r.box_normalized === 'object'
    ? r.box_normalized
    : { x: r.x_norm, y: r.y_norm, w: r.w_norm, h: r.h_norm };
  return {
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

export default buildRouter;
