/**
 * TEST MVP-05 · LUẬT #1 (§0) — ẨN DANH KHÔNG BỊ PHÁ.
 *
 * Đây là bằng chứng hồi quy chính của MVP-05: khách KHÔNG đăng nhập (không cookie `vauth`)
 * vẫn tạo được job ở CẢ 3 loại (content / image_translation / image_generation), chạy tới
 * trạng thái kết thúc, và KHÔNG có dòng sổ credit nào được ghi.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { productImage } from './imagestudio-helpers.js';
import { startMvp05App, request, j, waitJob, countRows, newJar } from './mvp05-helpers.js';

const TERMINAL_OK = new Set(['succeeded', 'awaiting_review', 'needs_manual']);

describe('MVP-05 · luật #1 — ẩn danh chạy đủ MVP-01/02/03, không ví, không dòng sổ', () => {
  let ctx;
  const made = {};

  before(async () => {
    ctx = await startMvp05App();
  });
  after(async () => {
    await ctx.close();
  });

  test('POST /api/jobs (content) không cookie ⇒ 202 → job succeeded, user_id NULL', async () => {
    const jar = newJar();
    const res = await request(ctx.base, '/api/jobs', {
      method: 'POST',
      jar,
      body: { manual: { title: 'Sản phẩm ẩn danh', notes: 'không đăng nhập' } },
    });
    assert.equal(res.status, 202, 'luật #1: dán dữ liệu là chạy, không bắt đăng nhập');
    assert.equal(jar.vauth, undefined, 'không được tự cấp cookie đăng nhập');
    const { job_id: jobId } = await j(res);
    made.content = jobId;

    const done = await waitJob(ctx.base, jobId, { jar });
    assert.equal(done.status, 'succeeded');
    assert.equal(done.input_mode, 'manual');
    const job = await ctx.store.getJob(jobId);
    assert.equal(job.user_id, null, 'job ẩn danh PHẢI giữ user_id NULL (§2.2)');
    assert.ok(job.session_id, 'vẫn dùng session_id cho rate limit + tương thích ngược');
  });

  test('POST /api/imagelab/jobs không cookie ⇒ 202 → job chạy xong OCR, không gắn tài khoản', async () => {
    const png = productImage();
    const jar = newJar();
    const res = await request(ctx.base, '/api/imagelab/jobs', {
      method: 'POST',
      jar,
      body: { image: { base64: png.toString('base64'), filename: 'an-danh.png' }, options: {} },
    });
    assert.equal(res.status, 202);
    const { job_id: jobId, asset_id: assetId } = await j(res);
    made.imagelab = jobId;

    const done = await waitJob(ctx.base, jobId, { jar, path: '/api/imagelab/jobs', shape: 'wrapped' });
    assert.ok(TERMINAL_OK.has(done.job.status), `job dịch ảnh phải chạy xong, nhận ${done.job.status}`);
    assert.equal((await ctx.store.getJob(jobId)).user_id, null);
    assert.equal((await ctx.store.getImageAsset(assetId)).user_id, null, 'ảnh ẩn danh giữ user_id NULL');
  });

  test('POST /api/imagestudio/jobs không cookie ⇒ 202 → job tạo ảnh succeeded', async () => {
    const png = productImage();
    const jar = newJar();
    const res = await request(ctx.base, '/api/imagestudio/jobs', {
      method: 'POST',
      jar,
      body: { image: { base64: png.toString('base64'), filename: 'an-danh-sp.png' }, options: { template: 'trang' } },
    });
    assert.equal(res.status, 202);
    const { job_id: jobId, asset_id: assetId } = await j(res);
    made.imagestudio = jobId;

    const done = await waitJob(ctx.base, jobId, { jar, path: '/api/imagestudio/jobs', shape: 'wrapped' });
    assert.equal(done.job.status, 'succeeded');
    assert.equal((await ctx.store.getJob(jobId)).user_id, null);
    assert.equal((await ctx.store.getImageAsset(assetId)).user_id, null);
  });

  test('sau 3 job ẩn danh: KHÔNG có dòng sổ credit nào, không user nào được tạo', async () => {
    assert.equal(await countRows(ctx.store, 'wallet_ledger'), 0, 'ẩn danh không có ví ⇒ sổ phải TRỐNG');
    assert.equal(await countRows(ctx.store, 'users'), 0);
    assert.equal(await countRows(ctx.store, 'jobs'), 3, 'đúng 3 job của 3 loại');
    // 1 ảnh gốc của imagelab + 1 ảnh gốc + 1 ảnh rendered của imagestudio.
    assert.equal(await countRows(ctx.store, 'image_assets'), 3);
    for (const asset of await ctx.store.driver.all('SELECT user_id FROM image_assets')) {
      assert.equal(asset.user_id, null, 'mọi ảnh ẩn danh phải giữ user_id NULL');
    }
    assert.ok(made.content && made.imagelab && made.imagestudio);
  });

  test('route MVP-01/02/03 cũ vẫn phục vụ khách ẩn danh (không 401)', async () => {
    const session = await request(ctx.base, '/api/session');
    assert.equal(session.status, 200);

    const list = await request(ctx.base, '/api/jobs?limit=10');
    assert.equal(list.status, 200, 'GET /api/jobs vẫn chạy cho khách ẩn danh');

    const detect = await request(ctx.base, '/api/detect', {
      method: 'POST',
      body: { url: 'https://detail.1688.com/offer/552160420012.html' },
    });
    assert.equal(detect.status, 200, 'POST /api/detect vẫn chạy cho khách ẩn danh');
    assert.equal((await j(detect)).source, '1688');

    const health = await j(await request(ctx.base, '/api/health'));
    assert.equal(health.accounts.available, true, 'tài khoản phải KHẢ DỤNG nhưng vẫn tuỳ chọn');
    assert.equal(health.billing.available, true);
    assert.equal(health.billing.currency, 'USD');
  });

  test('/api/config có khối `auth` + `billing` với đúng khoá hợp đồng §2.3/§3.3', async () => {
    const res = await request(ctx.base, '/api/config');
    assert.equal(res.status, 200);
    const config = await j(res);

    assert.equal(config.auth.enabled, true);
    assert.equal(config.auth.anonymous_allowed, true, 'mặc định phải cho phép ẩn danh');
    assert.equal(config.auth.password_min_length, 10, 'sàn hợp đồng §3.1');
    assert.deepEqual(config.auth.roles, ['owner', 'admin', 'member']);

    assert.equal(config.billing.enabled, true);
    assert.equal(config.billing.currency, 'USD', 'chỉ MỘT khoá tiền tệ (CREDIT_CURRENCY)');
    assert.equal(config.billing.available, true);

    // Không được lộ bí mật qua /api/config.
    const raw = JSON.stringify(config);
    for (const secret of ['password_hash', 'token_hash', 'vauth=', 'apiKey', 'api_key']) {
      assert.equal(raw.includes(secret), false, `/api/config KHÔNG được chứa ${secret}`);
    }
  });
});
