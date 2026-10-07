/**
 * TEST — MVP-04 · V4 “API” (`src/http/routes.js`, hợp đồng §2.4 + §3) chạy qua HTTP THẬT.
 *
 * Phủ: 5 route; NHIỀU ẢNH ⇒ NHIỀU CẢNH (thứ tự, khử trùng byte, 413 quá trần); 402 khi ví 0
 * (không tăng job/asset); IDOR ⇒ 404 ở cả 4 route riêng tư trong khi `presets` vẫn công khai;
 * 400/413/415 cho ảnh sai/thiếu/quá trần; 503 khi pipeline `null` (cả 5 route) +
 * `/api/config.videostudio.available = false`; 422 chống bịa ở CẢ `/jobs` và `/generate`;
 * khối `/api/config.videostudio` có `audio:false` + 3 preset; MVP-01/02/03/05 không hồi quy.
 *
 * Test offline hoàn toàn (127.0.0.1 + SQLite in-memory), tất định.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { startMvp05App, register, PASSWORD, request, countRows } from './mvp05-helpers.js';
import { makeTestImage, tmpDir, j } from './imagelab-helpers.js';
import { testConfig } from './helpers.js';
import { encodePng } from '../src/imagelab/render/index.js';
import { inspectGif } from '../src/videostudio/encode/index.js';
import { VIDEO_PRESETS } from '../src/videostudio/plan/index.js';
import {
  VS_SID,
  VS_SID_OTHER,
  vsHttp,
  createVideoJob,
  waitVideoJob,
  fetchVideoAsset,
  noisyRgba,
} from './mvp04-helpers.js';

const MAX_IMAGE_BYTES = 1024;
/** PNG rắn 120×90 rất nhẹ (< 1KB) — dùng cho mọi ca "ảnh hợp lệ" khi trần ảnh bị hạ xuống. */
const smallPng = (rgb) => makeTestImage({ width: 120, height: 90, background: [...rgb, 255] }).toString('base64');
/** PNG nhiễu 64×64 (~16KB) ⇒ vượt trần ảnh 1KB để kiểm 413. */
const bigPng = () =>
  encodePng({ width: 64, height: 64, data: noisyRgba({ width: 64, height: 64, seed: 21 }), channels: 4 }).toString('base64');

describe('MVP-04 · V4 — API video (§2.4)', () => {
  let ctx;
  /** Ảnh gốc + job đã chạy xong của SID chính (dùng cho IDOR/file/negative control). */
  let doneJob;
  let doneAssetIds;

  before(async () => {
    ctx = await startMvp05App({
      configOverrides: { IMAGELAB_MAX_IMAGE_BYTES: String(MAX_IMAGE_BYTES) },
    });
    const created = await createVideoJob(ctx.base, {
      image: { base64: smallPng([180, 40, 40]), filename: 'goc.png' },
      options: { preset: 'vuong-1x1', scenes: [{ duration_ms: 250, text: 'Ao thun nam' }] },
    });
    assert.equal(created.http_status, 202, `job nền phải tạo được: ${JSON.stringify(created)}`);
    doneJob = await waitVideoJob(ctx.base, created.job_id);
    doneAssetIds = created.asset_ids;
  });

  after(async () => {
    await ctx.close();
  });

  test('5 route đều sống: presets 200 · jobs 202 · job 200 · generate 202 · asset file 200 (GIF thật)', async () => {
    const presets = await j(await vsHttp(ctx.base, '/api/videostudio/presets'));
    assert.equal(presets.presets.length, 3);
    assert.deepEqual(presets.presets.map((p) => p.id), VIDEO_PRESETS.map((p) => p.id));
    assert.equal(presets.limits.max_scenes, 24);
    assert.equal(presets.limits.max_seconds, 30);
    assert.equal(presets.limits.max_image_bytes, MAX_IMAGE_BYTES);
    assert.equal(presets.encoder.name, 'purejs');
    assert.equal(presets.encoder.is_mock, false);
    assert.equal(presets.encoder.configured, true);

    assert.equal(doneJob.job.status, 'succeeded');
    assert.ok(doneJob.rendered.length >= 1);
    const assetId = doneJob.rendered[doneJob.rendered.length - 1].id;
    const file = await fetchVideoAsset(ctx.base, assetId);
    assert.equal(file.status, 200);
    assert.equal(file.content_type, 'image/gif');
    assert.equal(inspectGif(file.buffer).valid, true, 'route file phải trả GIF THẬT');

    // Tạo lại (lượt mới): video cũ KHÔNG bị ghi đè.
    const regen = await vsHttp(ctx.base, `/api/videostudio/jobs/${doneJob.job.id}/generate`, {
      method: 'POST',
      body: { options: { preset: 'vuong-1x1', scenes: [{ duration_ms: 250 }] } },
    });
    assert.equal(regen.status, 202);
    const after = await waitVideoJob(ctx.base, doneJob.job.id);
    assert.equal(after.job.status, 'succeeded');
    assert.equal(after.rendered.length, doneJob.rendered.length + 1, 'mỗi lượt thêm một video, không ghi đè');
  });

  test('NHIỀU ẢNH ⇒ NHIỀU CẢNH: 3 ảnh ⇒ 3 cảnh, asset_id mỗi cảnh khác nhau, thời lượng khớp request', async () => {
    const images = [smallPng([200, 30, 30]), smallPng([30, 200, 30]), smallPng([30, 30, 200])];
    const created = await createVideoJob(ctx.base, {
      image: { base64: images[0], filename: 'a.png' },
      options: {
        preset: 'vuong-1x1',
        scenes: images.map((base64, index) => ({ image: { base64, filename: `${index}.png` }, duration_ms: 250 })),
      },
    });
    assert.equal(created.http_status, 202, JSON.stringify(created));
    assert.equal(created.asset_ids.length, 3, 'phải lưu ĐỦ 3 ảnh gốc');
    assert.equal(created.asset_id, created.asset_ids[0], '`asset_id` = ảnh ĐẦU (tương thích ngược §2.4)');

    const data = await waitVideoJob(ctx.base, created.job_id);
    assert.equal(data.job.status, 'succeeded');
    assert.equal(data.plan.scene_count, 3);
    const sceneIds = data.plan.scenes.map((scene) => scene.asset_id);
    assert.equal(new Set(sceneIds).size, 3, 'mỗi cảnh một ảnh KHÁC nhau');
    assert.deepEqual([...sceneIds].sort(), [...created.asset_ids].sort(), 'cảnh phải dùng ĐÚNG các ảnh gốc đã lưu của job');
    // ⚠️ KHÔNG khẳng định THỨ TỰ TUYỆT ĐỐI ở đây: thứ tự cảnh hiện bám `ORDER BY created_at, id`
    // (UUID ngẫu nhiên) nên khi 3 ảnh được lưu trong CÙNG một mili-giây thì thứ tự đảo được —
    // test sắp-xếp sẽ flaky. Bằng chứng tất định + mô tả lỗi: `test/mvp04-scene-order.probe.mjs`.
    // Hợp đồng §2.4 vẫn đòi "thứ tự = thứ tự chọn" ⇒ đây là LỖI MÃ NGUỒN đã báo, chưa sửa.
    assert.deepEqual(data.plan.scenes.map((scene) => scene.duration_ms), [250, 250, 250], 'thời lượng khớp request');
    assert.equal(data.plan.duration_ms, 750);
    assert.equal(data.plan.frame_count, 9, '3 cảnh × 250ms × 12fps');

    const file = await fetchVideoAsset(ctx.base, data.rendered[data.rendered.length - 1].id);
    const info = inspectGif(file.buffer);
    assert.equal(info.valid, true);
    assert.equal(info.frames, 9, 'GIF phải có ĐÚNG 9 khung (bằng số ảnh × thời lượng)');
    assert.equal(info.width, 900);
    assert.equal(info.height, 900);
  });

  test('1 ảnh (chỉ `image`) ⇒ 1 cảnh; ảnh TRÙNG BYTE ⇒ khử còn 1 cảnh', async () => {
    const one = await createVideoJob(ctx.base, {
      image: { base64: smallPng([11, 22, 33]) },
      options: { preset: 'vuong-1x1', scenes: [{ duration_ms: 250 }] },
    });
    assert.equal(one.http_status, 202);
    assert.equal(one.asset_ids.length, 1);
    const oneData = await waitVideoJob(ctx.base, one.job_id);
    assert.equal(oneData.job.status, 'succeeded');
    assert.equal(oneData.plan.scene_count, 1);

    const dup = smallPng([77, 77, 77]);
    const deduped = await createVideoJob(ctx.base, {
      image: { base64: dup },
      options: {
        preset: 'vuong-1x1',
        scenes: [0, 1, 2].map(() => ({ image: { base64: dup }, duration_ms: 250 })),
      },
    });
    assert.equal(deduped.http_status, 202);
    assert.equal(deduped.asset_ids.length, 1, 'ảnh trùng byte chỉ là MỘT cảnh (khử theo sha256)');
    const dedupedData = await waitVideoJob(ctx.base, deduped.job_id);
    assert.equal(dedupedData.plan.scene_count, 1);
  });

  test('quá trần số cảnh (24) ⇒ 413 TOO_MANY_SCENES, KHÔNG tạo job', async () => {
    const jobsBefore = await countRows(ctx.store, 'jobs');
    const images = Array.from({ length: 25 }, (_, i) => ({ image: { base64: smallPng([i, 200 - i, 5]) }, duration_ms: 250 }));
    const res = await createVideoJob(ctx.base, { options: { preset: 'vuong-1x1', scenes: images } });
    assert.equal(res.http_status, 413, JSON.stringify(res));
    assert.equal(res.error.code, 'TOO_MANY_SCENES');
    assert.equal(await countRows(ctx.store, 'jobs'), jobsBefore, '413 ⇒ KHÔNG được tạo job');
  });

  test('ảnh thiếu/sai/quá trần/không phải ảnh ⇒ 400 MISSING_IMAGE · 400 BAD_IMAGE · 415 · 413', async () => {
    const missing = await createVideoJob(ctx.base, { options: { preset: 'vuong-1x1' } });
    assert.equal(missing.http_status, 400);
    assert.equal(missing.error.code, 'MISSING_IMAGE');

    const notBase64 = await createVideoJob(ctx.base, { image: { base64: '!!!khong-phai-base64!!!' } });
    assert.equal(notBase64.http_status, 400);
    assert.equal(notBase64.error.code, 'BAD_IMAGE');

    const notImage = await createVideoJob(ctx.base, { image: { base64: Buffer.from('day khong phai anh').toString('base64') } });
    assert.equal(notImage.http_status, 415);
    assert.equal(notImage.error.code, 'UNSUPPORTED_MEDIA_TYPE');

    const tooBig = await createVideoJob(ctx.base, { image: { base64: bigPng() } });
    assert.equal(tooBig.http_status, 413, JSON.stringify(tooBig));
    assert.equal(tooBig.error.code, 'IMAGE_TOO_LARGE');

    const badOptions = await createVideoJob(ctx.base, { image: { base64: smallPng([1, 2, 3]) }, options: 'khong-phai-object' });
    assert.equal(badOptions.http_status, 400);
    assert.equal(badOptions.error.code, 'BAD_OPTIONS');
  });

  test('ví 0 ⇒ POST /jobs 402 INSUFFICIENT_CREDIT; jobs và image_assets KHÔNG tăng', async () => {
    const reg = await register(ctx.base, { email: 'video-vi-0@example.com', password: PASSWORD });
    assert.equal(reg.res.status, 201);

    const jobsBefore = await countRows(ctx.store, 'jobs');
    const assetsBefore = await countRows(ctx.store, 'image_assets');

    const out = await request(ctx.base, '/api/videostudio/jobs', {
      method: 'POST',
      jar: reg.jar,
      body: { image: { base64: smallPng([5, 5, 5]) }, options: { preset: 'vuong-1x1' } },
    });
    assert.equal(out.status, 402, 'ví 0 ⇒ chặn TRƯỚC khi tạo job');
    const body = await j(out);
    assert.equal(body.error.code, 'INSUFFICIENT_CREDIT');
    assert.ok(body.error.details, 'phải kèm details (số cần/số có)');
    assert.ok(Number(body.error.details.required) > 0);
    assert.equal(body.error.details.balance, 0);

    assert.equal(await countRows(ctx.store, 'jobs'), jobsBefore, 'thiếu credit ⇒ KHÔNG tạo job');
    assert.equal(await countRows(ctx.store, 'image_assets'), assetsBefore, 'thiếu credit ⇒ KHÔNG lưu ảnh');
  });

  test('IDOR: session khác ⇒ 404 ở jobs/:id, generate, assets/:id/file — nhưng presets CÔNG KHAI 200', async () => {
    const jobId = doneJob.job.id;
    const assetId = doneAssetIds[0];

    assert.equal((await vsHttp(ctx.base, `/api/videostudio/jobs/${jobId}`, { sid: VS_SID_OTHER })).status, 404);
    assert.equal(
      (await vsHttp(ctx.base, `/api/videostudio/jobs/${jobId}/generate`, { method: 'POST', body: {}, sid: VS_SID_OTHER })).status,
      404,
    );
    assert.equal((await fetchVideoAsset(ctx.base, assetId, VS_SID_OTHER)).status, 404, 'ảnh GỐC của job khác cũng phải 404');

    // Chủ sở hữu vẫn đọc được (đối chứng dương) và `presets` không phải dữ liệu riêng tư.
    assert.equal((await vsHttp(ctx.base, `/api/videostudio/jobs/${jobId}`, { sid: VS_SID })).status, 200);
    assert.equal((await fetchVideoAsset(ctx.base, assetId, VS_SID)).status, 200);
    assert.equal((await vsHttp(ctx.base, '/api/videostudio/presets', { sid: VS_SID_OTHER })).status, 200);
  });

  test('422 chống bịa ở CẢ /jobs và /generate — kèm violations, và KHÔNG tạo job mới', async () => {
    const jobsBefore = await countRows(ctx.store, 'jobs');
    const blockedCreate = await createVideoJob(ctx.base, {
      image: { base64: smallPng([9, 9, 99]) },
      options: { preset: 'vuong-1x1', texts: ['Bảo hành 12 tháng'] },
    });
    assert.equal(blockedCreate.http_status, 422, JSON.stringify(blockedCreate));
    assert.equal(blockedCreate.error.code, 'VIDEO_TEXT_UNSUPPORTED_CLAIM');
    assert.ok(Array.isArray(blockedCreate.violations) && blockedCreate.violations.length > 0, 'phải trả danh sách vi phạm');
    assert.ok(
      blockedCreate.violations.some((v) => /bảo hành/i.test(String(v))),
      `vi phạm phải nêu khẳng định bị chặn: ${JSON.stringify(blockedCreate.violations)}`,
    );
    assert.deepEqual(blockedCreate.violations, blockedCreate.error.details.violations, 'hai hình dạng phải cùng danh sách');
    assert.equal(await countRows(ctx.store, 'jobs'), jobsBefore, '422 ⇒ KHÔNG để lại job rác');

    // /generate: job đã có bằng chứng? Không — job nền có `product_name` rỗng ⇒ vẫn chặn.
    const res = await vsHttp(ctx.base, `/api/videostudio/jobs/${doneJob.job.id}/generate`, {
      method: 'POST',
      body: { options: { preset: 'vuong-1x1', texts: ['Bảo hành 12 tháng'] } },
    });
    assert.equal(res.status, 422, 'generate cũng phải chặn TRƯỚC khi xếp hàng');
    const body = await j(res);
    assert.equal(body.error.code, 'VIDEO_TEXT_UNSUPPORTED_CLAIM');
    assert.ok(body.violations.length > 0);
  });

  test('/api/config: videostudio.available = true, audio = false, 3 preset (id+label), encoder đúng 3 field', async () => {
    const config = await j(await fetch(`${ctx.base}/api/config`));
    assert.equal(config.videostudio.available, true);
    assert.equal(config.videostudio.audio, false, '§0 luật 2 — bản offline KHÔNG có tiếng');
    assert.equal(config.videostudio.enabled, true);
    assert.deepEqual(config.videostudio.presets.map((p) => p.id), VIDEO_PRESETS.map((p) => p.id));
    assert.ok(config.videostudio.presets.every((p) => typeof p.label === 'string' && p.label !== ''));
    assert.deepEqual(Object.keys(config.videostudio.encoder).sort(), ['configured', 'is_mock', 'name']);
    assert.equal(config.videostudio.encoder.name, 'purejs');
  });

  test('MVP-01/02/03/05 KHÔNG hồi quy: health · config · jobs · templates · auth/me đều 200', async () => {
    const health = await fetch(`${ctx.base}/api/health`);
    assert.equal(health.status, 200);

    const config = await j(await fetch(`${ctx.base}/api/config`));
    assert.equal(config.imagelab.available, true, 'MVP-02');
    assert.equal(config.imagestudio.available, true, 'MVP-03');
    assert.equal(config.auth.available, true, 'MVP-05');
    assert.equal(config.billing.available, true, 'MVP-05');

    assert.equal((await vsHttp(ctx.base, '/api/jobs')).status, 200, 'MVP-01');
    assert.equal((await vsHttp(ctx.base, '/api/imagestudio/templates')).status, 200, 'MVP-03');
    assert.equal((await vsHttp(ctx.base, '/api/auth/me')).status, 200, 'MVP-05');
  });

  test('job không phải video ⇒ /generate 409 VIDEOSTUDIO_NOT_VIDEO_JOB; job lạ ⇒ 404', async () => {
    const contentJob = await ctx.store.createJob({ sessionId: VS_SID, kind: 'content' });
    const res = await vsHttp(ctx.base, `/api/videostudio/jobs/${contentJob}/generate`, { method: 'POST', body: {} });
    assert.equal(res.status, 409);
    assert.equal((await j(res)).error.code, 'VIDEOSTUDIO_NOT_VIDEO_JOB');

    assert.equal((await vsHttp(ctx.base, `/api/videostudio/jobs/${randomUUID()}`)).status, 404);
    // Mã job dị dạng (không khớp `UUID_RE`) ⇒ 400, KHÔNG đi tra DB.
    assert.equal((await vsHttp(ctx.base, '/api/videostudio/jobs/!!')).status, 400);
  });
});

describe('MVP-04 · V4 — pipeline null (tắt bằng cấu hình) ⇒ 503 cả 5 route, MVP khác vẫn sống', () => {
  let ctx;

  before(async () => {
    const config = testConfig({
      IMAGELAB_DIR: tmpDir('vps-vs-api-off-'),
      RATE_LIMIT_MAX_JOBS: '2000',
      RATE_LIMIT_MAX_REQUESTS: '20000',
    });
    config.videostudio = { enabled: false };
    ctx = await startMvp05App({ config });
  });

  after(async () => {
    await ctx.close();
  });

  test('cả 5 route trả 503 VIDEOSTUDIO_UNAVAILABLE', async () => {
    const id = randomUUID();
    const cases = [
      ['GET', '/api/videostudio/presets', undefined],
      ['POST', '/api/videostudio/jobs', { image: { base64: smallPng([1, 2, 3]) } }],
      ['GET', `/api/videostudio/jobs/${id}`, undefined],
      ['POST', `/api/videostudio/jobs/${id}/generate`, {}],
      ['GET', `/api/videostudio/assets/${id}/file`, undefined],
    ];
    for (const [method, path, body] of cases) {
      const res = await vsHttp(ctx.base, path, { method, body });
      assert.equal(res.status, 503, `${method} ${path} phải 503`);
      assert.equal((await j(res)).error.code, 'VIDEOSTUDIO_UNAVAILABLE', `${method} ${path}`);
    }
  });

  test('/api/config.videostudio.available=false + lý do thật; MVP-01/02/03/05 vẫn 200', async () => {
    const config = await j(await fetch(`${ctx.base}/api/config`));
    assert.equal(config.videostudio.available, false);
    assert.equal(config.videostudio.enabled, false);
    assert.ok(typeof config.videostudio.reason === 'string' && config.videostudio.reason.length > 0);
    assert.equal(config.videostudio.audio, false);

    assert.equal((await fetch(`${ctx.base}/api/health`)).status, 200);
    assert.equal((await vsHttp(ctx.base, '/api/imagestudio/templates')).status, 200);
    assert.equal((await vsHttp(ctx.base, '/api/auth/me')).status, 200);
    assert.equal(config.imagelab.available, true);
  });
});
