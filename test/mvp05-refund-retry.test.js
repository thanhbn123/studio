/**
 * Chuyển PROBE `mvp05-refund-retry.probe.mjs` thành TEST THẬT (vòng 2).
 *
 * Probe cũ ghi nhận 3 góc khuất của "idempotent theo jobId". Sau bản vá PB-01/PB-02/PB-04 cả
 * ba đều KHÔNG còn tái hiện được, nên chúng trở thành khẳng định bắt buộc của bộ test:
 *   1. chạy lại SAU khi job lỗi được hoàn tiền ⇒ phải MỞ CHU KỲ MỚI và THU tiền;
 *   2. `refundForJob` sau `settleForJob` ⇒ KHÔNG hoàn phần đã tiêu (không tạo tiền);
 *   3. request 4xx sau khi giữ tiền ⇒ HOÀN khoản giữ (số dư về đúng cũ + có dòng hoàn).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/store/index.js';
import { createBillingService } from '../src/billing/index.js';
import { loadConfig } from '../src/config.js';
import { newJar, register, request, j, ledgerRows, tmpDir } from './mvp05-helpers.js';
import { startImagelabApp } from './imagelab-helpers.js';
import { silent } from './helpers.js';

const unitConfig = () =>
  loadConfig({
    NODE_ENV: 'test',
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: ':memory:',
    AI_PROVIDER: 'mock',
    LOG_LEVEL: 'silent',
    IMAGELAB_DIR: tmpDir(),
  });

describe('MVP-05 · hoàn tiền & chạy lại (probe cũ đã thành test)', () => {
  test('(1) chạy lại sau khi hoàn tiền ⇒ mở chu kỳ MỚI và THU tiền', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    const userId = 'u-retry';
    await svc.grant({ userId, amount: 1 });

    const hold1 = await svc.holdForJob({ userId, jobId: 'job-r', estimate: 0.5 });
    await svc.refundForJob({ userId, jobId: 'job-r', runKey: hold1.run_key, reason: 'JOB_FAILED' });
    assert.equal(await store.ledgerBalance(userId), 1, 'hoàn xong ⇒ ví về đúng 1');

    const hold2 = await svc.holdForJob({ userId, jobId: 'job-r', estimate: 0.5 });
    assert.notEqual(hold2.run_key, hold1.run_key, 'lượt chạy lại phải là LƯỢT MỚI');
    assert.equal(hold2.balance_after, 0.5, 'lượt chạy lại PHẢI bị giữ tiền (trước đây miễn phí)');
    await svc.settleForJob({ userId, jobId: 'job-r', actualCost: 0.2 });
    assert.equal(await store.ledgerBalance(userId), 0.8, 'thu đúng chi phí thật của lượt chạy lại');
    await store.close();
  });

  test('(2) refundForJob sau settleForJob ⇒ không hoàn phần đã tiêu', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    const userId = 'u-refund';
    await svc.grant({ userId, amount: 1 });

    const hold = await svc.holdForJob({ userId, jobId: 'job-s', estimate: 1 });
    await svc.settleForJob({ userId, jobId: 'job-s', actualCost: 0.6 });
    assert.equal(await store.ledgerBalance(userId), 0.4, 'đã tiêu 0.6 ⇒ còn 0.4');
    await svc.refundForJob({ userId, jobId: 'job-s', runKey: hold.run_key });
    assert.equal(await store.ledgerBalance(userId), 0.4, 'refund sau settle KHÔNG được tạo tiền');
    await store.close();
  });

  test('(3) request 4xx sau khi giữ tiền ⇒ có dòng hoàn, ví về đúng cũ', async () => {
    const ctx = await startImagelabApp();
    try {
      const jar = newJar();
      const created = await request(ctx.base, '/api/jobs', { method: 'POST', jar, body: { manual: { title: 'job 4xx' } } });
      assert.equal(created.status, 202);
      const jobId = (await j(created)).job_id;
      const reg = await register(ctx.base, { email: 'retry@example.com', jar });
      const userId = reg.body.user.id;
      await ctx.app.billingService.grant({ userId, amount: 1, reason: 'admin_grant', actorId: 't' });

      const put = await request(ctx.base, `/api/imagelab/jobs/${jobId}/regions`, {
        method: 'PUT',
        jar,
        body: { regions: [{ box: { x: 1, y: 1, w: 10, h: 10 }, text: '纯棉' }] },
      });
      assert.equal(put.status, 409, 'job không có ảnh gốc ⇒ 409');
      const rows = await ledgerRows(ctx.store, userId);
      assert.ok(rows.some((r) => r.reason === 'job_refund'), 'PB-01: phải có dòng hoàn cho khoản đã giữ');
      const balance = (await j(await request(ctx.base, '/api/auth/me', { jar }))).balance.amount;
      assert.equal(balance, 1, 'số dư phải về đúng 1 (không mất credit cho request 4xx)');
    } finally {
      await ctx.close();
    }
  });
});
