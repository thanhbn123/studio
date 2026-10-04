/**
 * TEST MVP-03 · E4 — API (`src/http/routes.js`), hợp đồng §3.6.
 *
 * Server THẬT trên 127.0.0.1 (như `test/imagelab-api.test.js`), provider purejs chạy offline.
 * Phủ: 5 route `/api/imagestudio/*`, IDOR (session khác ⇒ 404 ở MỌI route kể cả route file ảnh),
 * 400/413/415 cho ảnh thiếu/sai/quá trần, 422 overlay thiếu bằng chứng (KHÔNG tạo job/ảnh),
 * 503 `IMAGESTUDIO_UNAVAILABLE` khi thiếu pipeline hoặc bị tắt bằng cấu hình,
 * khối `imagestudio` trong `/api/config`, và MVP-01/MVP-02 KHÔNG hồi quy.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { sha256 } from '../src/imagelab/render/index.js';
import { RETOUCH_LIMITS } from '../src/imagestudio/retouch/index.js';
import { TEMPLATE_IDS } from '../src/imagestudio/compose/index.js';
import { startImagelabApp, j, cookie, postJson, imagelabConfig } from './imagelab-helpers.js';
import { productImage, noisyImage } from './imagestudio-helpers.js';

const SID_A = 'imagestudioSessionAAAAA1';
const SID_B = 'imagestudioSessionBBBBB2';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Poll job như UI thật, dừng khi job rời `queued|running`. */
async function waitIs(base, id, sid, { tries = 300, delay = 15 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    const res = await fetch(`${base}/api/imagestudio/jobs/${id}`, { headers: cookie(sid) });
    last = await j(res);
    const status = last?.job?.status;
    if (!['queued', 'running'].includes(status)) return last;
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`job ${id} không kết thúc kịp: ${JSON.stringify(last)?.slice(0, 200)}`);
}

const createJob = (base, sid, options, buffer = productImage()) =>
  postJson(base, '/api/imagestudio/jobs', { image: { base64: buffer.toString('base64'), filename: 'sp.png' }, options }, sid);

describe('MVP-03 API — 5 route + luồng đầy đủ (server thật)', () => {
  let ctx;
  const flow = {};

  before(async () => {
    ctx = await startImagelabApp();
  });
  after(async () => {
    await ctx.close();
  });

  test('POST /api/imagestudio/jobs → 202 với job_id + asset_id THẬT', async () => {
    const input = productImage();
    flow.input = input;
    const res = await createJob(ctx.base, SID_A, { template: 'trang', retouch: { brightness: 0.1 } }, input);
    assert.equal(res.status, 202);
    const body = await j(res);
    assert.ok(UUID_RE.test(body.job_id), `job_id phải là uuid, nhận ${body.job_id}`);
    assert.ok(UUID_RE.test(body.asset_id), `asset_id phải là THẬT, nhận ${body.asset_id}`);
    assert.equal(body.status, 'queued');
    assert.equal(body.poll, `/api/imagestudio/jobs/${body.job_id}`);
    flow.jobId = body.job_id;
    flow.assetId = body.asset_id;
  });

  test('GET /api/imagestudio/jobs/:id → job image_generation + asset gốc + ảnh rendered có parent_id', async () => {
    const d = await waitIs(ctx.base, flow.jobId, SID_A);
    assert.equal(d.job.status, 'succeeded');
    assert.equal(d.job.stage, 'done');
    assert.equal(d.job.kind, 'image_generation');
    assert.ok(d.job.finished_at, 'job xong phải có finished_at');
    assert.equal(d.asset.id, flow.assetId);
    assert.equal(d.asset.role, 'original');
    assert.equal(d.asset.sha256, sha256(flow.input));
    assert.equal(d.rendered.length, 1);
    assert.equal(d.rendered[0].role, 'rendered');
    assert.equal(d.rendered[0].parent_id, flow.assetId, 'ảnh ra phải trỏ về ảnh gốc');
    assert.deepEqual([d.rendered[0].width, d.rendered[0].height], [d.asset.width, d.asset.height], 'ảnh ra CÙNG kích thước');
    assert.equal(d.rendered[0].meta.synthetic_background, true);
    assert.equal(d.rendered[0].meta.template.synthetic, true);
    assert.equal(d.retouch_effective.brightness, 0.1);
    assert.deepEqual(d.retouch_limits, { ...RETOUCH_LIMITS }, 'ngưỡng trả về phải là số của MÁY CHỦ');
    assert.deepEqual(d.templates.map((t) => t.id), [...TEMPLATE_IDS]);
    assert.equal(d.providers.matting.name, 'purejs');
    assert.equal(d.providers.matting.is_mock, false);
    assert.equal(d.providers.retouch.name, 'purejs');

    // Không lộ đường dẫn nội bộ / dấu vết LIVE.
    const raw = JSON.stringify(d);
    assert.ok(!raw.includes('storage_path'), 'JSON KHÔNG được chứa storage_path');
    assert.ok(!raw.includes(ctx.config.imagelab.dir), 'JSON không được lộ đường dẫn nội bộ');
    assert.ok(!raw.includes('LIVE_VERIFIED'));
    flow.job = d;
  });

  test('GET /api/imagestudio/templates → 5 mẫu MÔ PHỎNG + ngưỡng retouch', async () => {
    const res = await fetch(`${ctx.base}/api/imagestudio/templates`, { headers: cookie(SID_A) });
    assert.equal(res.status, 200);
    const body = await j(res);
    assert.deepEqual(body.templates.map((t) => t.id), [...TEMPLATE_IDS]);
    for (const t of body.templates) assert.equal(t.synthetic, true, `mẫu ${t.id} phải synthetic = true`);
    assert.deepEqual(body.retouch_limits, { ...RETOUCH_LIMITS });
    assert.equal(body.matting_provider.name, 'purejs');
  });

  test('GET /api/imagestudio/assets/:id/file → ảnh nhị phân THẬT (không cache chung)', async () => {
    const res = await fetch(`${ctx.base}/api/imagestudio/assets/${flow.assetId}/file`, { headers: cookie(SID_A) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    assert.match(res.headers.get('content-disposition') || '', /imagestudio-original-/);
    const buffer = Buffer.from(await res.arrayBuffer());
    assert.equal(sha256(buffer), sha256(flow.input), 'file trả về phải là ẢNH GỐC nguyên bản');
  });

  test('route file ảnh CŨ của MVP-02 vẫn phục vụ được ảnh MVP-03 (UI Trước/Sau dùng nó)', async () => {
    // `renderIsCompare` của UI trỏ `/api/imagelab/assets/:id/file` — route đó phải phục vụ
    // được cả ảnh gốc lẫn ảnh rendered của MVP-03, nếu không khối Trước/Sau sẽ vỡ ảnh.
    const job = await (await fetch(`${ctx.base}/api/imagestudio/jobs/${flow.jobId}`, { headers: cookie(SID_A) })).json();
    for (const asset of [job.asset, job.rendered[0]]) {
      const res = await fetch(`${ctx.base}/api/imagelab/assets/${asset.id}/file`, { headers: cookie(SID_A) });
      assert.equal(res.status, 200, `route imagelab phải trả được ${asset.role}`);
      assert.equal(res.headers.get('content-type'), 'image/png');
      assert.equal(sha256(Buffer.from(await res.arrayBuffer())), asset.sha256);
    }
  });

  test('POST /api/imagestudio/jobs/:id/generate → tạo asset MỚI, ảnh cũ VẪN CÒN', async () => {
    const before = await (await fetch(`${ctx.base}/api/imagestudio/jobs/${flow.jobId}`, { headers: cookie(SID_A) })).json();
    const res = await postJson(ctx.base, `/api/imagestudio/jobs/${flow.jobId}/generate`, { options: { template: 'gradient-hong' } }, SID_A);
    assert.equal(res.status, 202);
    const body = await j(res);
    assert.equal(body.job_id, flow.jobId);
    assert.equal(body.status, 'queued');

    const after = await waitIs(ctx.base, flow.jobId, SID_A);
    assert.equal(after.rendered.length, before.rendered.length + 1, 'phải có thêm một ảnh MỚI');
    const ids = after.rendered.map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length, 'không được ghi đè ảnh cũ');
    for (const a of after.rendered) assert.equal(a.parent_id, flow.assetId);
    assert.equal(after.rendered[after.rendered.length - 1].meta.template.id, 'gradient-hong');

    // Ảnh gốc vẫn nguyên và vẫn tải được.
    const originalFile = await fetch(`${ctx.base}/api/imagestudio/assets/${flow.assetId}/file`, { headers: cookie(SID_A) });
    assert.equal(originalFile.status, 200);
    assert.equal(sha256(Buffer.from(await originalFile.arrayBuffer())), sha256(flow.input));
    flow.renderedCount = after.rendered.length;
  });

  test('job KHÔNG phải image_generation ⇒ 409 (không chạy tạo ảnh bừa)', async () => {
    const jobId = await ctx.store.createJob({ sessionId: SID_A, kind: 'content' });
    const res = await postJson(ctx.base, `/api/imagestudio/jobs/${jobId}/generate`, {}, SID_A);
    assert.equal(res.status, 409);
    assert.equal((await j(res)).error.code, 'IMAGESTUDIO_NOT_IMAGE_JOB');
  });

  test('GET /api/config → khối imagestudio đúng hợp đồng 3.6; MVP-01/MVP-02 KHÔNG hồi quy', async () => {
    const res = await fetch(`${ctx.base}/api/config`, { headers: cookie(SID_A) });
    assert.equal(res.status, 200);
    const cfg = await j(res);

    assert.equal(cfg.imagestudio.available, true);
    assert.equal(cfg.imagestudio.enabled, true);
    assert.equal(cfg.imagestudio.reason, null);
    assert.deepEqual(cfg.imagestudio.retouch_limits, { ...RETOUCH_LIMITS });
    assert.deepEqual(cfg.imagestudio.templates.map((t) => t.id), [...TEMPLATE_IDS]);
    for (const t of cfg.imagestudio.templates) assert.equal(t.synthetic, true);
    assert.deepEqual(Object.keys(cfg.imagestudio.matting).sort(), ['configured', 'is_mock', 'name']);
    assert.equal(cfg.imagestudio.matting.name, 'purejs');
    assert.equal(cfg.imagestudio.retouch.name, 'purejs');

    // MVP-01 / MVP-02 vẫn nguyên.
    assert.ok(Array.isArray(cfg.styles) && cfg.styles.length > 0);
    assert.ok(Array.isArray(cfg.lengths) && cfg.lengths.length > 0);
    assert.ok(cfg.limits.max_upload_bytes > 0);
    assert.equal(cfg.imagelab.available, true);
    assert.equal(cfg.imagelab.enabled, true);
    assert.ok(cfg.imagelab.limits.max_image_bytes > 0);
    assert.equal(cfg.providers.content.name, 'mock');
  });

  test('GET /api/health vẫn chạy (MVP-01 không hồi quy)', async () => {
    const res = await fetch(`${ctx.base}/api/health`, { headers: cookie(SID_A) });
    assert.equal(res.status, 200);
    const body = await j(res);
    assert.equal(body.status, 'ok');
    assert.equal(body.db.ok, true);
  });
});

describe('MVP-03 API — IDOR: session khác ⇒ 404 ở MỌI route', () => {
  let ctx;
  const flow = {};

  before(async () => {
    ctx = await startImagelabApp();
    const res = await createJob(ctx.base, SID_A, { template: 'trang' });
    const body = await j(res);
    flow.jobId = body.job_id;
    flow.assetId = body.asset_id;
    const d = await waitIs(ctx.base, flow.jobId, SID_A);
    flow.renderedId = d.rendered[0].id;
    flow.renderedCount = d.rendered.length;
  });
  after(async () => {
    await ctx.close();
  });

  test('GET job của session khác ⇒ 404 (không phải 403, không lộ sự tồn tại)', async () => {
    const res = await fetch(`${ctx.base}/api/imagestudio/jobs/${flow.jobId}`, { headers: cookie(SID_B) });
    assert.equal(res.status, 404);
    assert.equal((await j(res)).error.code, 'JOB_NOT_FOUND');
  });

  test('POST generate của session khác ⇒ 404 và KHÔNG tạo ảnh', async () => {
    const res = await postJson(ctx.base, `/api/imagestudio/jobs/${flow.jobId}/generate`, {}, SID_B);
    assert.equal(res.status, 404);
    await new Promise((r) => setTimeout(r, 80));
    const mine = await waitIs(ctx.base, flow.jobId, SID_A);
    assert.equal(mine.rendered.length, flow.renderedCount, 'session khác KHÔNG được tạo ảnh');
  });

  test('GET file ảnh của session khác ⇒ 404 (kể cả route file ảnh, cả ảnh gốc lẫn ảnh ra)', async () => {
    for (const id of [flow.assetId, flow.renderedId]) {
      const res = await fetch(`${ctx.base}/api/imagestudio/assets/${id}/file`, { headers: cookie(SID_B) });
      assert.equal(res.status, 404, `asset ${id} của session khác phải 404`);
    }
  });

  test('chủ sở hữu vẫn xem được (404 ở trên là do SESSION, không phải do route hỏng)', async () => {
    const job = await fetch(`${ctx.base}/api/imagestudio/jobs/${flow.jobId}`, { headers: cookie(SID_A) });
    assert.equal(job.status, 200);
    const file = await fetch(`${ctx.base}/api/imagestudio/assets/${flow.renderedId}/file`, { headers: cookie(SID_A) });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('content-type'), 'image/png');
  });

  test('UUID sai định dạng ⇒ 400; id hợp lệ nhưng không tồn tại ⇒ 404', async () => {
    const short = await fetch(`${ctx.base}/api/imagestudio/jobs/abc`, { headers: cookie(SID_A) });
    assert.equal(short.status, 400);
    assert.equal((await j(short)).error.code, 'BAD_JOB_ID');

    const absent = await fetch(`${ctx.base}/api/imagestudio/jobs/khong-ton-tai-0000`, { headers: cookie(SID_A) });
    assert.equal(absent.status, 404);
    assert.equal((await j(absent)).error.code, 'JOB_NOT_FOUND');
  });
});

describe('MVP-03 API — validate ảnh: 400 / 413 / 415', () => {
  let ctx;
  before(async () => {
    ctx = await startImagelabApp();
  });
  after(async () => {
    await ctx.close();
  });

  test('thiếu ảnh ⇒ 400 MISSING_IMAGE; base64 rác ⇒ 400 BAD_IMAGE', async () => {
    const missing = await postJson(ctx.base, '/api/imagestudio/jobs', { options: {} }, SID_A);
    assert.equal(missing.status, 400);
    assert.equal((await j(missing)).error.code, 'MISSING_IMAGE');

    const bad = await postJson(ctx.base, '/api/imagestudio/jobs', { image: { base64: '!!!khong-phai-base64!!!' } }, SID_A);
    assert.equal(bad.status, 400);
    assert.equal((await j(bad)).error.code, 'BAD_IMAGE');
  });

  test('dữ liệu không phải ảnh ⇒ 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const res = await postJson(
      ctx.base,
      '/api/imagestudio/jobs',
      { image: { base64: Buffer.from('day khong phai la anh').toString('base64') } },
      SID_A,
    );
    assert.equal(res.status, 415);
    assert.equal((await j(res)).error.code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  test('PNG cắt cụt (header đọc được, thân hỏng) ⇒ nhận job nhưng KẾT THÚC PARTIAL/NO_CHANGES, KHÔNG báo OK', async () => {
    // Route chỉ kiểm magic bytes + header (đúng hợp đồng §3.6); phần thân hỏng lộ ra ở bước
    // tách nền. Điều bắt buộc: KHÔNG được báo thành công và KHÔNG được lưu ảnh mới.
    const truncated = productImage().subarray(0, 40);
    const res = await postJson(ctx.base, '/api/imagestudio/jobs', { image: { base64: truncated.toString('base64') } }, SID_A);
    assert.equal(res.status, 202);
    const body = await j(res);
    const d = await waitIs(ctx.base, body.job_id, SID_A);
    assert.equal(d.job.status, 'PARTIAL');
    assert.equal(d.job.error_code, 'NO_CHANGES');
    assert.deepEqual(d.rendered, [], 'KHÔNG được lưu ảnh mới từ dữ liệu hỏng');
    assert.ok(JSON.stringify(d).includes('PNG_CORRUPT'), 'phải ghi vết lỗi giải mã PNG');
  });

  test('`options` sai kiểu ⇒ 400 BAD_OPTIONS (route không đoán)', async () => {
    const res = await postJson(ctx.base, '/api/imagestudio/jobs', { image: { base64: productImage().toString('base64') }, options: 'sai' }, SID_A);
    assert.equal(res.status, 400);
    assert.equal((await j(res)).error.code, 'BAD_OPTIONS');
  });
});

describe('MVP-03 API — trần cấu hình (413 theo maxPixels / maxImageBytes)', () => {
  let ctx;
  before(async () => {
    ctx = await startImagelabApp({ configOverrides: { IMAGELAB_MAX_PIXELS: 1000, IMAGELAB_MAX_IMAGE_BYTES: 4096 } });
  });
  after(async () => {
    await ctx.close();
  });

  test('vượt max_pixels ⇒ 413 IMAGE_TOO_LARGE', async () => {
    const res = await postJson(ctx.base, '/api/imagestudio/jobs', { image: { base64: productImage().toString('base64') } }, SID_A);
    assert.equal(res.status, 413);
    const body = await j(res);
    assert.equal(body.error.code, 'IMAGE_TOO_LARGE');
    assert.match(body.error.message, /pixel/);
  });

  test('vượt max_image_bytes ⇒ 413 IMAGE_TOO_LARGE', async () => {
    const res = await postJson(ctx.base, '/api/imagestudio/jobs', { image: { base64: noisyImage().toString('base64') } }, SID_A);
    assert.equal(res.status, 413);
    assert.equal((await j(res)).error.code, 'IMAGE_TOO_LARGE');
  });
});

describe('MVP-03 API — overlay thiếu bằng chứng ⇒ 422, KHÔNG tạo job/ảnh', () => {
  let ctx;
  let jobId;
  before(async () => {
    ctx = await startImagelabApp();
    const res = await createJob(ctx.base, SID_A, { template: 'trang' });
    jobId = (await j(res)).job_id;
    await waitIs(ctx.base, jobId, SID_A);
  });
  after(async () => {
    await ctx.close();
  });

  test('POST /jobs với "Bảo hành 12 tháng" ⇒ 422 + violations + KHÔNG tạo job', async () => {
    const before = (await ctx.store.listJobs({ sessionId: SID_A })).length;
    const res = await createJob(ctx.base, SID_A, { overlay: { text: 'Bảo hành 12 tháng' } });
    assert.equal(res.status, 422);
    const body = await j(res);
    assert.equal(body.code, 'OVERLAY_UNSUPPORTED_CLAIM');
    assert.equal(body.error.code, 'OVERLAY_UNSUPPORTED_CLAIM');
    assert.ok(Array.isArray(body.violations) && body.violations.length > 0, 'phải kèm danh sách vi phạm');
    assert.deepEqual(body.error.details.violations, body.violations);
    assert.equal((await ctx.store.listJobs({ sessionId: SID_A })).length, before, 'KHÔNG được tạo job nào');
  });

  test('POST /jobs/:id/generate với "chính hãng" ⇒ 422 + KHÔNG thêm ảnh + job không đổi', async () => {
    const before = await (await fetch(`${ctx.base}/api/imagestudio/jobs/${jobId}`, { headers: cookie(SID_A) })).json();
    const res = await postJson(ctx.base, `/api/imagestudio/jobs/${jobId}/generate`, { options: { overlay: { text: 'chính hãng' } } }, SID_A);
    assert.equal(res.status, 422);
    assert.equal((await j(res)).code, 'OVERLAY_UNSUPPORTED_CLAIM');

    await new Promise((r) => setTimeout(r, 60));
    const after = await (await fetch(`${ctx.base}/api/imagestudio/jobs/${jobId}`, { headers: cookie(SID_A) })).json();
    assert.equal(after.rendered.length, before.rendered.length, 'KHÔNG được tạo ảnh mới');
    assert.equal(after.job.status, before.job.status, 'job phải giữ nguyên trạng thái');
  });

  test('overlay còn chữ Hán ⇒ 422 OVERLAY_NOT_TRANSLATED', async () => {
    const res = await postJson(ctx.base, `/api/imagestudio/jobs/${jobId}/generate`, { options: { overlay: { text: '保修' } } }, SID_A);
    assert.equal(res.status, 422);
    assert.equal((await j(res)).code, 'OVERLAY_NOT_TRANSLATED');
  });

  test('overlay vừa có chữ Hán vừa có SỐ LIỆU ⇒ vẫn 422 (chặn vì khẳng định), KHÔNG vẽ', async () => {
    // Thứ tự báo lỗi giữa hai lý do chặn là chi tiết cài đặt; điều hợp đồng bắt buộc là
    // KHÔNG được vẽ và phải nói ra lý do.
    const res = await postJson(ctx.base, `/api/imagestudio/jobs/${jobId}/generate`, { options: { overlay: { text: '保修 12 个月' } } }, SID_A);
    assert.equal(res.status, 422);
    const body = await j(res);
    assert.ok(['OVERLAY_NOT_TRANSLATED', 'OVERLAY_UNSUPPORTED_CLAIM'].includes(body.code));
    assert.ok(body.violations.length > 0 || body.code === 'OVERLAY_NOT_TRANSLATED');
  });

  test('overlay HỢP LỆ có bằng chứng client khai ⇒ 202 và ảnh ra có chữ', async () => {
    const res = await postJson(
      ctx.base,
      `/api/imagestudio/jobs/${jobId}/generate`,
      { options: { template: 'trang', overlay: { text: 'Tai nghe', x: 2, y: 2, w: 40, h: 20, size: 10, source_text: 'Tai nghe Bluetooth' } } },
      SID_A,
    );
    assert.equal(res.status, 202);
    const d = await waitIs(ctx.base, jobId, SID_A);
    const latest = d.rendered[d.rendered.length - 1];
    assert.equal(latest.meta.overlay.applied, true);
  });
});

describe('MVP-03 API — 503 IMAGESTUDIO_UNAVAILABLE', () => {
  test('thiếu pipeline (app.imagestudioPipeline = null) ⇒ 503 ở MỌI route', async () => {
    const ctx = await startImagelabApp();
    try {
      const buffer = productImage();
      const before = ctx.app.imagestudioPipeline;
      const job = await ctx.store.createJob({ sessionId: SID_A, kind: 'image_generation' });
      const assetId = '00000000-0000-0000-0000-000000000000';
      ctx.app.imagestudioPipeline = null;

      const calls = [
        ['POST', '/api/imagestudio/jobs', { image: { base64: buffer.toString('base64') } }],
        ['GET', `/api/imagestudio/jobs/${job}`, null],
        ['POST', `/api/imagestudio/jobs/${job}/generate`, {}],
        ['GET', '/api/imagestudio/templates', null],
        ['GET', `/api/imagestudio/assets/${assetId}/file`, null],
      ];
      for (const [method, url, body] of calls) {
        const res =
          method === 'GET'
            ? await fetch(`${ctx.base}${url}`, { headers: cookie(SID_A) })
            : await postJson(ctx.base, url, body, SID_A);
        assert.equal(res.status, 503, `${method} ${url} phải 503`);
        assert.equal((await j(res)).error.code, 'IMAGESTUDIO_UNAVAILABLE');
      }

      // `/api/config` phải nói THẲNG vì sao tắt, và MVP-02 vẫn khả dụng.
      const cfg = await (await fetch(`${ctx.base}/api/config`, { headers: cookie(SID_A) })).json();
      assert.equal(cfg.imagestudio.available, false);
      assert.ok(cfg.imagestudio.reason, 'phải có lý do thật, không im lặng');
      assert.equal(cfg.imagelab.available, true, 'MVP-02 KHÔNG được chết theo');
      ctx.app.imagestudioPipeline = before;
    } finally {
      await ctx.close();
    }
  });

  test('IMAGESTUDIO_ENABLED=false ⇒ 503 + /api/config báo enabled: false', async () => {
    const config = imagelabConfig(); // thư mục ảnh trong tmp — test KHÔNG ghi vào cây mã nguồn
    config.imagestudio = { enabled: false };
    const ctx = await startImagelabApp({ config });
    try {
      const res = await fetch(`${ctx.base}/api/imagestudio/templates`, { headers: cookie(SID_A) });
      assert.equal(res.status, 503);
      assert.equal((await j(res)).error.code, 'IMAGESTUDIO_UNAVAILABLE');
      const cfg = await (await fetch(`${ctx.base}/api/config`, { headers: cookie(SID_A) })).json();
      assert.equal(cfg.imagestudio.available, false);
      assert.equal(cfg.imagestudio.enabled, false);
      assert.match(cfg.imagestudio.reason, /tắt bằng cấu hình/);
      assert.equal(cfg.imagelab.available, true);
    } finally {
      await ctx.close();
    }
  });
});
