/**
 * TEST MVP-02 · API (C5) — 6 route của hợp đồng 4.5, chạy trên server THẬT.
 *
 * Server nội bộ 127.0.0.1 (giống `test/api.test.js`); provider là bản chạy offline
 * (OCR mock fixture, translator mock, render purejs) nên không cần mạng/API key.
 *
 * Phủ: luồng đầy đủ, IDOR (session B → 404 ở MỌI route), validate ảnh (400/415/413),
 * header file ảnh, không lộ `storage_path`, 503 khi ImageLab không khả dụng,
 * khối `imagelab` trong `/api/config`, và MVP-01 vẫn chạy.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { sha256 } from '../src/imagelab/render/index.js';
import { j, cookie, postJson, putJson, startImagelabApp, waitJob, headphones } from './imagelab-helpers.js';

const SID_A = 'imagelabSessionAAAAAAA1';
const SID_B = 'imagelabSessionBBBBBBB2';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('MVP-02 API — luồng đầy đủ + IDOR (server thật)', () => {
  let ctx;
  const flow = {};

  before(async () => {
    ctx = await startImagelabApp();
  });
  after(async () => {
    await ctx.close();
  });

  test('POST /api/imagelab/jobs → 202 với job_id + asset_id THẬT', async () => {
    const buf = headphones();
    flow.bytes = buf.length;
    const res = await postJson(ctx.base, '/api/imagelab/jobs', {
      image: { base64: buf.toString('base64'), filename: 'tai-nghe.png' },
    }, SID_A);
    assert.equal(res.status, 202);
    const body = await j(res);
    assert.ok(UUID_RE.test(body.job_id), `job_id phải là uuid, nhận ${body.job_id}`);
    assert.ok(UUID_RE.test(body.asset_id), `asset_id phải là giá trị THẬT, nhận ${body.asset_id}`);
    assert.equal(body.status, 'queued');
    assert.equal(body.poll, `/api/imagelab/jobs/${body.job_id}`);
    flow.jobId = body.job_id;
    flow.assetId = body.asset_id;
  });

  test('GET /api/imagelab/jobs/:id → awaiting_review, có vùng + dòng, KHÔNG lộ storage_path', async () => {
    const d = await waitJob(ctx.base, flow.jobId, SID_A);
    assert.equal(d.job.status, 'awaiting_review');
    assert.equal(d.job.stage, 'awaiting_review');
    assert.equal(d.job.kind, 'image_translation');
    assert.equal(d.job.finished_at, null, 'chờ duyệt thì chưa finished');
    assert.ok(d.asset && d.asset.id === flow.assetId);
    assert.equal(d.asset.role, 'original');
    assert.equal(d.asset.sha256, sha256(headphones()));
    assert.ok(Array.isArray(d.rendered) && d.rendered.length === 0);
    assert.equal(d.render_summary, null);
    assert.ok(d.regions.length >= 1);
    assert.equal(d.lines.length, d.regions.length);

    // Nhãn MOCK/LIVE phải nói thật
    assert.equal(d.providers.ocr.is_mock, true);
    assert.equal(d.providers.render.is_mock, false);
    assert.equal(d.providers.render.name, 'purejs');

    const raw = JSON.stringify(d);
    assert.ok(!raw.includes('storage_path'), 'JSON KHÔNG được chứa storage_path');
    assert.ok(!raw.includes(ctx.config.imagelab.dir), 'JSON không được lộ đường dẫn nội bộ');
    assert.ok(!raw.includes('LIVE_VERIFIED'));
    flow.job = d;
  });

  test('GET /api/imagelab/assets/:id (metadata) và .../file (nhị phân) đúng hợp đồng', async () => {
    const metaRes = await fetch(`${ctx.base}/api/imagelab/assets/${flow.assetId}`, { headers: cookie(SID_A) });
    assert.equal(metaRes.status, 200);
    const meta = await j(metaRes);
    assert.equal(meta.role, 'original');
    assert.equal(meta.parent_id, null);
    assert.equal(meta.width, 320);
    assert.equal(meta.height, 320);
    assert.equal(meta.sha256, sha256(headphones()));
    assert.ok(!('storage_path' in meta), 'metadata KHÔNG được kèm storage_path');
    assert.ok(!('buffer' in meta) && !('bytes' in meta && Buffer.isBuffer(meta.bytes)), 'metadata KHÔNG kèm bytes ảnh');

    const fileRes = await fetch(`${ctx.base}/api/imagelab/assets/${flow.assetId}/file`, { headers: cookie(SID_A) });
    assert.equal(fileRes.status, 200);
    assert.equal(fileRes.headers.get('content-type'), 'image/png');
    assert.equal(fileRes.headers.get('cache-control'), 'private, no-store');
    assert.equal(fileRes.headers.get('x-content-type-options'), 'nosniff');
    assert.match(fileRes.headers.get('content-security-policy') || '', /default-src 'self'/);
    const bytes = Buffer.from(await fileRes.arrayBuffer());
    assert.equal(bytes.length, flow.bytes);
    assert.equal(sha256(bytes), sha256(headphones()), 'file trả về phải đúng ảnh gốc đã tải lên');
  });

  test('PUT .../lines (accept) → 200; POST .../render → 202 → job succeeded + ảnh render mới', async () => {
    const current = await waitJob(ctx.base, flow.jobId, SID_A);
    const edits = current.lines.map((l) => ({ region_id: l.region_id, text_vi: l.text_vi, action: 'accept' }));
    const put = await putJson(ctx.base, `/api/imagelab/jobs/${flow.jobId}/lines`, { edits }, SID_A);
    assert.equal(put.status, 200);
    const putBody = await j(put);
    assert.ok(Array.isArray(putBody.lines) && putBody.lines.length === current.lines.length);
    assert.ok(Array.isArray(putBody.rejected));
    assert.ok(Array.isArray(putBody.warnings));

    // Vùng nhãn hiệu/chứng nhận vẫn rỗng chữ Việt sau khi duyệt
    for (const l of putBody.lines) {
      const region = current.regions.find((r) => r.id === l.region_id);
      if (region && ['brand', 'certification', 'price'].includes(region.kind)) {
        assert.equal(l.text_vi, '', `vùng ${region.kind} không được có chữ Việt`);
      }
    }

    const renderRes = await postJson(ctx.base, `/api/imagelab/jobs/${flow.jobId}/render`, { force: true }, SID_A);
    assert.equal(renderRes.status, 202);
    const renderBody = await j(renderRes);
    assert.equal(renderBody.job_id, flow.jobId);
    assert.equal(renderBody.status, 'queued');

    const done = await waitJob(ctx.base, flow.jobId, SID_A);
    assert.equal(done.job.status, 'succeeded');
    assert.equal(done.job.stage, 'done');
    assert.ok(done.job.finished_at);
    assert.equal(done.rendered.length, 1, 'phải có ĐÚNG một ảnh render');
    const rendered = done.rendered[0];
    assert.equal(rendered.role, 'rendered');
    assert.equal(rendered.parent_id, flow.assetId, 'ảnh render phải trỏ về ảnh gốc');
    assert.notEqual(rendered.sha256, done.asset.sha256);
    assert.equal(done.asset.sha256, sha256(headphones()), 'ảnh gốc KHÔNG được đổi sau render');
    assert.equal(done.render_summary.status, 'OK');
    assert.ok(!JSON.stringify(done).includes('storage_path'));

    // Không vùng bị khoá nào được vẽ
    const kindById = Object.fromEntries(done.regions.map((r) => [r.id, r.kind]));
    for (const applied of done.render_summary.applied) {
      assert.equal(kindById[applied.region_id], 'descriptive', `vùng ${applied.region_id} không phải mô tả mà bị vẽ`);
    }

    // Ảnh render tải về được
    const fileRes = await fetch(`${ctx.base}/api/imagelab/assets/${rendered.id}/file`, { headers: cookie(SID_A) });
    assert.equal(fileRes.status, 200);
    const bytes = Buffer.from(await fileRes.arrayBuffer());
    assert.equal(sha256(bytes), rendered.sha256);
    flow.renderedId = rendered.id;
  });

  test('IDOR: session B gọi mọi tài nguyên của session A → 404 ở TẤT CẢ', async () => {
    const cases = [
      ['GET job', () => fetch(`${ctx.base}/api/imagelab/jobs/${flow.jobId}`, { headers: cookie(SID_B) })],
      ['GET asset', () => fetch(`${ctx.base}/api/imagelab/assets/${flow.assetId}`, { headers: cookie(SID_B) })],
      ['GET asset file', () => fetch(`${ctx.base}/api/imagelab/assets/${flow.assetId}/file`, { headers: cookie(SID_B) })],
      ['GET rendered file', () => fetch(`${ctx.base}/api/imagelab/assets/${flow.renderedId}/file`, { headers: cookie(SID_B) })],
      ['PUT lines', () => putJson(ctx.base, `/api/imagelab/jobs/${flow.jobId}/lines`, { edits: [{ region_id: 'r1', action: 'accept' }] }, SID_B)],
      ['POST render', () => postJson(ctx.base, `/api/imagelab/jobs/${flow.jobId}/render`, { force: true }, SID_B)],
    ];
    for (const [label, run] of cases) {
      const res = await run();
      assert.equal(res.status, 404, `${label} của session khác lẽ ra phải 404, nhận ${res.status}`);
      const body = await j(res);
      assert.ok(body.error && body.error.code, `${label} phải có mã lỗi`);
    }

    // Session A vẫn xem được bình thường (chứng minh 404 ở trên là do ownership)
    assert.equal((await fetch(`${ctx.base}/api/imagelab/jobs/${flow.jobId}`, { headers: cookie(SID_A) })).status, 200);
  });

  test('job không tồn tại / id sai định dạng → 404 / 400 (không lộ thông tin)', async () => {
    const missing = await fetch(`${ctx.base}/api/imagelab/jobs/00000000-0000-0000-0000-000000000000`, { headers: cookie(SID_A) });
    assert.equal(missing.status, 404);
    const bad = await fetch(`${ctx.base}/api/imagelab/jobs/ab`, { headers: cookie(SID_A) });
    assert.equal(bad.status, 400);
    const badAsset = await fetch(`${ctx.base}/api/imagelab/assets/ab`, { headers: cookie(SID_A) });
    assert.equal(badAsset.status, 400);
    const notFoundAsset = await fetch(`${ctx.base}/api/imagelab/assets/00000000-0000-0000-0000-000000000000`, { headers: cookie(SID_A) });
    assert.equal(notFoundAsset.status, 404);
  });

  test('cổng duyệt ở tầng HTTP: còn dòng NEEDS_REVIEW chưa xử lý → POST render trả 409 REVIEW_REQUIRED', async () => {
    const buf = headphones();
    const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
      image: { base64: buf.toString('base64') },
    }, SID_A));
    const d = await waitJob(ctx.base, created.job_id, SID_A);

    // Ghi thẳng một dòng NEEDS_REVIEW CHƯA được người dùng xử lý vào DB.
    const pending = {
      region_id: d.regions[0].id,
      text_original: d.regions[0].text,
      text_vi: 'Chữ chưa duyệt',
      status: 'NEEDS_REVIEW',
      provenance: 'ai',
      confidence: 0.5,
      violations: ['cần người duyệt'],
      notes: '',
      edited_by_user: false,
      edited_at: null,
    };
    await ctx.store.saveTranslationLines(created.job_id, [pending]);

    const res = await postJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/render`, {}, SID_A);
    assert.equal(res.status, 409);
    const body = await j(res);
    assert.equal(body.error.code, 'REVIEW_REQUIRED');
    assert.deepEqual(body.error.details?.pending_region_ids ?? [], [d.regions[0].id]);

    // force = true thì đi tiếp được (202)
    const forced = await postJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/render`, { force: true }, SID_A);
    assert.equal(forced.status, 202);
    const finished = await waitJob(ctx.base, created.job_id, SID_A, { tries: 200 });
    // Dòng duy nhất còn lại là vùng nhãn hiệu ⇒ không có op nào đủ điều kiện vẽ:
    // job phải kết thúc với mã lỗi rõ ràng, KHÔNG được tạo ảnh rỗng giả và không treo.
    assert.equal(finished.job.status, 'failed');
    assert.equal(finished.job.error_code, 'IMAGELAB_NO_LINES');
    assert.ok(finished.job.finished_at, 'job kết thúc phải có finished_at');
  });

  test('MVP-01 KHÔNG bị phá: POST /api/jobs cũ vẫn chạy và /api/health vẫn ok', async () => {
    const health = await j(await fetch(`${ctx.base}/api/health`));
    assert.equal(health.status, 'ok');
    assert.equal(health.imagelab.available, true);
    assert.equal(health.imagelab.reason, null);

    const res = await postJson(ctx.base, '/api/jobs', { url: 'https://detail.1688.com/offer/552160420012.html' }, SID_A);
    assert.equal(res.status, 202);
    const body = await j(res);
    assert.ok(UUID_RE.test(body.job_id));
  });
});

describe('MVP-02 API — validate ảnh đầu vào (400/415/413)', () => {
  let ctx;
  let smallBytes;
  let smallPixels;

  before(async () => {
    ctx = await startImagelabApp();
    smallBytes = await startImagelabApp({ configOverrides: { IMAGELAB_MAX_IMAGE_BYTES: '1000' } });
    smallPixels = await startImagelabApp({ configOverrides: { IMAGELAB_MAX_PIXELS: '1000' } });
  });
  after(async () => {
    await ctx.close();
    await smallBytes.close();
    await smallPixels.close();
  });

  test('base64 hỏng → 400 BAD_IMAGE', async () => {
    const res = await postJson(ctx.base, '/api/imagelab/jobs', { image: { base64: '!!!!khong-phai-base64!!!!' } }, SID_A);
    assert.equal(res.status, 400);
    assert.equal((await j(res)).error.code, 'BAD_IMAGE');
  });

  test('thiếu ảnh → 400 MISSING_IMAGE', async () => {
    const res = await postJson(ctx.base, '/api/imagelab/jobs', {}, SID_A);
    assert.equal(res.status, 400);
    assert.equal((await j(res)).error.code, 'MISSING_IMAGE');
  });

  test('HTML khai `image/png` → 415 (không tin Content-Type của client)', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const res = await postJson(ctx.base, '/api/imagelab/jobs', {
      image: { base64: html.toString('base64'), mime: 'image/png', filename: 'evil.png' },
    }, SID_A);
    assert.equal(res.status, 415);
    assert.equal((await j(res)).error.code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  test('vượt maxImageBytes → 413 IMAGE_TOO_LARGE', async () => {
    const res = await postJson(smallBytes.base, '/api/imagelab/jobs', {
      image: { base64: headphones().toString('base64') },
    }, SID_A);
    assert.equal(res.status, 413);
    assert.equal((await j(res)).error.code, 'IMAGE_TOO_LARGE');
  });

  test('vượt maxPixels → 413 IMAGE_TOO_LARGE', async () => {
    const res = await postJson(smallPixels.base, '/api/imagelab/jobs', {
      image: { base64: headphones().toString('base64') },
    }, SID_A);
    assert.equal(res.status, 413);
    assert.equal((await j(res)).error.code, 'IMAGE_TOO_LARGE');
  });

  test('edits rác ở PUT lines → 400 BAD_EDITS (không 500)', async () => {
    const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
      image: { base64: headphones().toString('base64') },
    }, SID_A));
    await waitJob(ctx.base, created.job_id, SID_A);
    const res = await putJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/lines`, { edits: [] }, SID_A);
    assert.equal(res.status, 400);
    assert.equal((await j(res)).error.code, 'BAD_EDITS');
  });
});

describe('MVP-02 API — 503 khi không khả dụng + khối /api/config', () => {
  test('IMAGELAB_ENABLED=false → mọi route imagelab trả 503 IMAGELAB_UNAVAILABLE kèm lý do thật', async () => {
    const ctx = await startImagelabApp({ configOverrides: { IMAGELAB_ENABLED: 'false' } });
    try {
      const routes = [
        ['POST /api/imagelab/jobs', () => postJson(ctx.base, '/api/imagelab/jobs', { image: { base64: headphones().toString('base64') } }, SID_A)],
        ['GET /api/imagelab/jobs/:id', () => fetch(`${ctx.base}/api/imagelab/jobs/00000000-0000-0000-0000-000000000000`, { headers: cookie(SID_A) })],
        ['PUT /api/imagelab/jobs/:id/lines', () => putJson(ctx.base, '/api/imagelab/jobs/00000000-0000-0000-0000-000000000000/lines', { edits: [{ region_id: 'r1', action: 'accept' }] }, SID_A)],
        ['POST /api/imagelab/jobs/:id/render', () => postJson(ctx.base, '/api/imagelab/jobs/00000000-0000-0000-0000-000000000000/render', {}, SID_A)],
        ['GET /api/imagelab/assets/:id', () => fetch(`${ctx.base}/api/imagelab/assets/00000000-0000-0000-0000-000000000000`, { headers: cookie(SID_A) })],
        ['GET /api/imagelab/assets/:id/file', () => fetch(`${ctx.base}/api/imagelab/assets/00000000-0000-0000-0000-000000000000/file`, { headers: cookie(SID_A) })],
      ];
      for (const [label, run] of routes) {
        const res = await run();
        assert.equal(res.status, 503, `${label} lẽ ra 503, nhận ${res.status}`);
        const body = await j(res);
        assert.equal(body.error.code, 'IMAGELAB_UNAVAILABLE');
        assert.ok(body.error.message && body.error.message.length > 0, 'phải nói rõ LÝ DO');
      }

      const cfg = await j(await fetch(`${ctx.base}/api/config`));
      assert.equal(cfg.imagelab.available, false);
      assert.equal(cfg.imagelab.enabled, false);
      assert.ok(cfg.imagelab.reason && cfg.imagelab.reason.length > 0, 'available=false phải kèm reason');
      assert.ok(!cfg.imagelab.reason.includes('/Users/'), 'reason không được lộ đường dẫn tuyệt đối');

      const health = await j(await fetch(`${ctx.base}/api/health`));
      assert.equal(health.imagelab.available, false);
      assert.ok(health.imagelab.reason);
    } finally {
      await ctx.close();
    }
  });

  test('pipeline bị null (module hỏng) → 503, không sập server MVP-01', async () => {
    const ctx = await startImagelabApp();
    try {
      ctx.app.imagelabPipeline = null;
      const res = await fetch(`${ctx.base}/api/imagelab/jobs/00000000-0000-0000-0000-000000000000`, { headers: cookie(SID_A) });
      assert.equal(res.status, 503);
      assert.equal((await j(res)).error.code, 'IMAGELAB_UNAVAILABLE');

      const cfg = await j(await fetch(`${ctx.base}/api/config`));
      assert.equal(cfg.imagelab.available, false);
      assert.ok(cfg.imagelab.reason);

      // MVP-01 vẫn sống
      assert.equal((await j(await fetch(`${ctx.base}/api/health`))).status, 'ok');
    } finally {
      ctx.app.imagelabPipeline = ctx.pipeline;
      await ctx.close();
    }
  });

  test('GET /api/config có khối imagelab đầy đủ (provider thật + giới hạn + kinds)', async () => {
    const ctx = await startImagelabApp();
    try {
      const d = await j(await fetch(`${ctx.base}/api/config`));
      assert.equal(d.imagelab.available, true);
      assert.equal(d.imagelab.enabled, true);
      assert.equal(d.imagelab.reason, null);

      assert.equal(d.imagelab.ocr.name, 'mock');
      assert.equal(d.imagelab.ocr.is_mock, true, 'UI dựa vào cờ này để hiện nhãn MOCK');
      assert.equal(d.imagelab.ocr.configured, true);
      assert.equal(d.imagelab.render.name, 'purejs');
      assert.equal(d.imagelab.render.is_mock, false);
      assert.equal(d.imagelab.render.configured, true);
      assert.equal(d.imagelab.translate.is_mock, true);

      assert.ok(d.imagelab.limits.max_image_bytes > 0);
      assert.ok(d.imagelab.limits.max_pixels > 0);
      assert.ok(d.imagelab.limits.max_regions > 0);
      assert.ok(d.imagelab.limits.allowed_image_mime.includes('image/png'));
      assert.deepEqual(d.imagelab.kinds, ['descriptive', 'brand', 'certification', 'price', 'unknown']);
      assert.equal(typeof d.imagelab.max_render_pixels, 'number');

      const raw = JSON.stringify(d);
      assert.ok(!raw.includes('api_key') && !raw.includes('sk-'), 'config KHÔNG được lộ API key');
    } finally {
      await ctx.close();
    }
  });
});

describe('MVP-02 API — hồi quy sau phản biện (F-03/F-04/F-05)', () => {
  const SID_X = 'regressionSessionXXXXXX1';
  const SID_Y = 'regressionSessionYYYYYY2';

  test('F-03: GET job trả mock_steps + providers_snapshot từ DẤU VẾT ĐÃ LƯU, không theo cấu hình hiện tại', async () => {
    const ctx = await startImagelabApp();
    try {
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: headphones().toString('base64') },
      }, SID_X));
      await waitJob(ctx.base, created.job_id, SID_X);

      const d = await j(await fetch(`${ctx.base}/api/imagelab/jobs/${created.job_id}`, { headers: cookie(SID_X) }));
      assert.deepEqual(d.mock_steps, ['ocr', 'translate'], 'job chạy bằng OCR + dịch mock');
      assert.equal(d.providers_snapshot.ocr.name, 'mock');
      assert.equal(d.providers_snapshot.ocr.is_mock, true);
      assert.equal(d.providers_snapshot.translate.is_mock, true);
      assert.ok(d.providers_snapshot.recorded_at, 'phải có mốc thời gian chụp provider lúc chạy');

      // "Khởi động lại máy chủ với provider THẬT trên cùng DB": thay provider đang chạy,
      // dữ liệu job không đổi ⇒ nhãn MOCK của job cũ KHÔNG được biến mất.
      ctx.app.ocrProvider = { name: 'real-ocr', model: 'x', isMock: false, configured: true, async detect() { return { status: 'OK', regions: [] }; } };
      ctx.app.translator = { name: 'real-ai', model: 'y', isMock: false, configured: true };

      const after = await j(await fetch(`${ctx.base}/api/imagelab/jobs/${created.job_id}`, { headers: cookie(SID_X) }));
      assert.deepEqual(after.mock_steps, ['ocr', 'translate'], 'mock_steps là dấu vết của JOB, không phải cấu hình');
      assert.equal(after.providers.ocr.is_mock, false, 'providers = cấu hình HIỆN TẠI (đã là provider thật)');
      assert.equal(after.providers_snapshot.ocr.is_mock, true, 'providers_snapshot = lúc chạy (vẫn là mock)');
      assert.equal(after.asset.meta.ocr.is_mock, true, 'meta ảnh gốc vẫn khai mock');
    } finally {
      await ctx.close();
    }
  });

  test('F-04: route MVP-01 cũ kiểm quyền sở hữu — session khác nhận 404 (đọc VÀ ghi)', async () => {
    const ctx = await startImagelabApp();
    try {
      const created = await j(await postJson(ctx.base, '/api/jobs', {
        manual: { title: 'Sản phẩm MVP-01', notes: 'ghi chú' },
      }, SID_X));
      const jobId = created.job_id;

      const otherGet = await fetch(`${ctx.base}/api/jobs/${jobId}`, { headers: cookie(SID_Y) });
      assert.equal(otherGet.status, 404, 'session khác đọc job MVP-01 → 404');
      const otherUsage = await fetch(`${ctx.base}/api/jobs/${jobId}/usage`, { headers: cookie(SID_Y) });
      assert.equal(otherUsage.status, 404);
      const otherPut = await putJson(ctx.base, `/api/jobs/${jobId}/content`, { headline: 'SỬA TRỘM' }, SID_Y);
      assert.equal(otherPut.status, 404, 'session khác GHI job MVP-01 → 404');
      const otherRegen = await postJson(ctx.base, `/api/jobs/${jobId}/regenerate`, {}, SID_Y);
      assert.equal(otherRegen.status, 404);

      const ownGet = await j(await fetch(`${ctx.base}/api/jobs/${jobId}`, { headers: cookie(SID_X) }));
      assert.notEqual(ownGet.content?.headline, 'SỬA TRỘM', 'nội dung KHÔNG bị sửa trộm');
      assert.equal((await fetch(`${ctx.base}/api/jobs/${jobId}`, { headers: cookie(SID_X) })).status, 200, 'chủ sở hữu vẫn đọc được');

      // Job ImageLab cũng không còn cửa sau qua route MVP-01.
      const il = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: headphones().toString('base64') },
      }, SID_X));
      await waitJob(ctx.base, il.job_id, SID_X);
      assert.equal((await fetch(`${ctx.base}/api/jobs/${il.job_id}`, { headers: cookie(SID_Y) })).status, 404);
      assert.equal((await fetch(`${ctx.base}/api/jobs/${il.job_id}/usage`, { headers: cookie(SID_Y) })).status, 404);
      // Job ImageLab là tài nguyên MVP-02 ⇒ đòi session khớp NGAY CẢ khi không khai cookie
      // (khách ẩn danh không được đọc job của người khác qua route MVP-01 cũ).
      assert.equal((await fetch(`${ctx.base}/api/jobs/${il.job_id}`)).status, 404);
      // Còn job MVP-01 thì giữ nguyên hành vi cũ khi KHÔNG khai session (183 test MVP-01 vẫn xanh):
      assert.equal((await fetch(`${ctx.base}/api/jobs/${jobId}`)).status, 200);
    } finally {
      await ctx.close();
    }
  });

  test('F-05: lỗi 5xx an toàn (IMAGELAB_UNAVAILABLE / NOT_CONFIGURED) trả ĐÚNG message tiếng Việt', async () => {
    const ctx = await startImagelabApp({ configOverrides: { IMAGELAB_ENABLED: 'false' } });
    try {
      const res = await fetch(`${ctx.base}/api/imagelab/jobs/00000000-0000-0000-0000-000000000000`, { headers: cookie(SID_X) });
      assert.equal(res.status, 503);
      const body = await j(res);
      assert.equal(body.error.code, 'IMAGELAB_UNAVAILABLE');
      assert.notEqual(body.error.message, 'Lỗi hệ thống. Vui lòng thử lại.', 'message thật KHÔNG được bị che');
      assert.match(body.error.message, /IMAGELAB_ENABLED|bị tắt/i);
    } finally {
      await ctx.close();
    }
  });

  test('F-05: HttpError.safe giữ message cho 5xx, HttpError thường thì bị che (không lộ stack)', async () => {
    const { HttpError, sendError } = await import('../src/http/server.js');
    const capture = () => {
      const out = {};
      const res = { writeHead: (s) => { out.status = s; }, end: (b) => { out.body = JSON.parse(b); } };
      return { res, out };
    };

    const safe = capture();
    sendError(safe.res, HttpError.safe(502, 'NOT_CONFIGURED', 'Provider OCR chưa được cấu hình.'));
    assert.equal(safe.out.status, 502);
    assert.equal(safe.out.body.error.message, 'Provider OCR chưa được cấu hình.');

    const plain = capture();
    sendError(plain.res, new HttpError(500, 'BOOM', 'Chi tiết nội bộ: /Users/ai-do/secret.js'));
    assert.equal(plain.out.body.error.message, 'Lỗi hệ thống. Vui lòng thử lại.');
    assert.ok(!JSON.stringify(plain.out.body).includes('secret.js'), 'không được lộ chi tiết nội bộ');
    assert.equal(plain.out.body.error.stack, undefined);
  });
});
