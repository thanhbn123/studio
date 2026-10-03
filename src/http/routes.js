/**
 * API routes — bề mặt công khai của ứng dụng.
 *
 * Mọi lỗi được ném dưới dạng HttpError với thông báo AN TOÀN (không lộ stack,
 * không lộ secret, không lộ chi tiết nội bộ).
 */

import { Router, HttpError, sendJson, readJson, sessionId, MAX_BODY_BYTES_DEFAULT } from './server.js';
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
    const [items, total] = await Promise.all([
      store.listJobs({ sessionId: sessionIdFilter, limit, offset }),
      store.countJobs({ sessionId: sessionIdFilter }),
    ]);
    sendJson(res, 200, { items, total, limit: Number(limit) || 50, offset: Number(offset) || 0 });
  });

  /* ───────────────────── G10 — màn hình kết quả ───────────────────── */

  router.get('/api/jobs/:id', async (req, res, params) => {
    const job = await requireJob(params.id);
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
    const job = await requireJob(params.id);
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
    const job = await requireJob(params.id);
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
    const job = await requireJob(params.id);
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

export default buildRouter;
