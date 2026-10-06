/**
 * TEST HỒI QUY — MVP-05 vòng 4: xử lý BR-08 (lượt treo) + BR-09 (không thu lại usage đã hoàn).
 *
 *   BR-08 (TB)  lượt có `job_hold` mà KHÔNG có dòng đóng ⇒ `reconcileStuckRuns` HOÀN 100% khoản
 *               giữ + đóng lượt (job chạy lại được). KHÔNG đụng lượt còn mới (vẫn 409). Có route
 *               bảo trì `POST /api/admin/billing/reconcile` (member 403, owner 200).
 *   BR-09 (THẤP–TB) công thức dự phòng KHÔNG được thu lại usage của lượt đã `job_refund`
 *               (cùng cơ chế với usage đến muộn của lượt đã khép) — thà thu thiếu còn hơn thu thừa.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/store/index.js';
import { createBillingService } from '../src/billing/index.js';
import { loadConfig } from '../src/config.js';
import { newJar, register, request, j, ledgerRows } from './mvp05-helpers.js';
import { startMvp05App } from './mvp05-helpers.js';
import { silent } from './helpers.js';
import { tmpDir } from './imagelab-helpers.js';

const unitConfig = (over = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: ':memory:',
    AI_PROVIDER: 'mock',
    LOG_LEVEL: 'silent',
    IMAGELAB_DIR: tmpDir(),
    ...over,
  });

describe('BR-08 — thu hồi lượt TREO (reconcile)', () => {
  test('tầng dịch vụ: lượt quá hạn ⇒ hoàn 100% + có dòng đóng; lượt CÒN MỚI ⇒ không đụng', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    const userId = 'u-br08';
    await svc.grant({ userId, amount: 2 });

    const old = await svc.holdForJob({ userId, jobId: 'JOB-OLD', estimate: 0.5 });
    const fresh = await svc.holdForJob({ userId, jobId: 'JOB-FRESH', estimate: 0.5 });
    const balanceBefore = await store.ledgerBalance(userId);
    assert.equal(balanceBefore, 1, 'đã giữ 2 × 0.5');

    // Đẩy `created_at` của khoản giữ CŨ về quá khứ 1 giờ (mô phỏng tiến trình chết trước afterJob).
    await store.driver.run("UPDATE wallet_ledger SET created_at = ? WHERE run_key = ?", [
      new Date(Date.now() - 3600_000).toISOString(),
      old.run_key,
    ]);

    const out = await svc.reconcileStuckRuns({ olderThanMs: 60_000 });
    assert.equal(out.reconciled, 1, `chỉ lượt CŨ được thu hồi, nhận ${JSON.stringify(out)}`);
    assert.equal(out.refunded, 0.5, 'hoàn đúng 100% khoản giữ');
    assert.deepEqual(out.runs.map((r) => r.run_key), [old.run_key]);

    const balanceAfter = await store.ledgerBalance(userId);
    assert.equal(balanceAfter, balanceBefore + 0.5, 'số dư về đúng trước khi giữ lượt treo');
    const rows = await ledgerRows(store, userId);
    const refund = rows.find((r) => r.reason === 'job_refund' && r.run_key === old.run_key);
    assert.ok(refund, 'phải có dòng job_refund cho lượt treo');
    assert.equal(refund.meta?.reconciled, true, 'dòng hoàn phải ghi rõ `reconciled: true`');
    assert.ok(Number.isFinite(Number(refund.meta?.stuck_ms)), 'phải ghi `stuck_ms` (bao lâu thì coi là treo)');
    assert.equal((await svc.billableRunsOfJob({ userId, jobId: 'JOB-OLD' })).length, 0, 'lượt treo đã đóng ⇒ không tính vào trần');

    // Lượt CÒN MỚI không bị đụng tới.
    const freshRows = await ledgerRows(store, userId);
    assert.equal(
      freshRows.some((r) => (r.reason === 'job_settle' || r.reason === 'job_refund') && r.run_key === fresh.run_key),
      false,
      'BR-08: KHÔNG được thu hồi lượt còn mới (không cắt ngang job đang chạy thật)',
    );
    await store.close();
  });

  test('HTTP: lượt treo quá hạn ⇒ request sau KHÔNG còn 409, tiền được hoàn, lượt mới bị thu', async () => {
    const ctx = await startMvp05App({ configOverrides: { BILLING_STUCK_RUN_MS: '50' } });
    try {
      const jar = newJar();
      const reg = await register(ctx.base, { email: 'br08@example.com', jar });
      const userId = reg.body.user.id;
      await ctx.app.billingService.grant({ userId, amount: 2, reason: 'admin_grant', actorId: 't' });

      const jobId = (await j(await request(ctx.base, '/api/jobs', { method: 'POST', jar, body: { manual: { title: 'br08' } } }))).job_id;
      const waitDone = async () => {
        for (let i = 0; i < 200; i += 1) {
          const st = await j(await request(ctx.base, `/api/jobs/${jobId}`, { jar }));
          if (st?.status && !['queued', 'running'].includes(st.status)) return;
          await new Promise((r) => setTimeout(r, 25));
        }
      };
      await waitDone();

      // Bơm lỗi `afterJob` cho lượt KẾ TIẾP ⇒ lượt mở, không có dòng đóng (giống u3b).
      const hook = ctx.app.billingHook;
      const real = hook.afterJob.bind(hook);
      let broken = true;
      hook.afterJob = async (...args) => {
        if (broken) { broken = false; throw Object.assign(new Error('LEDGER_BUSY (giả lập)'), { code: 'LEDGER_BUSY' }); }
        return real(...args);
      };
      const regen = await request(ctx.base, `/api/jobs/${jobId}/regenerate`, { method: 'POST', jar, body: {} });
      assert.equal(regen.status, 202);
      await waitDone();
      hook.afterJob = real;

      const balanceStuck = await ctx.store.ledgerBalance(userId);
      const holdsBefore = (await ledgerRows(ctx.store, userId)).filter((r) => r.reason === 'job_hold').length;
      const closesBefore = (await ledgerRows(ctx.store, userId)).filter((r) => r.reason === 'job_settle' || r.reason === 'job_refund').length;
      assert.equal(holdsBefore - closesBefore, 1, 'phải có đúng MỘT lượt mở (treo) để đo');

      // Chờ quá ngưỡng treo (50 ms) rồi chạy lại: route phải THU HỒI rồi cho chạy tiếp.
      await new Promise((r) => setTimeout(r, 120));
      const retry = await request(ctx.base, `/api/jobs/${jobId}/regenerate`, { method: 'POST', jar, body: {} });
      assert.equal(retry.status, 202, `lượt treo phải được thu hồi để chạy tiếp (nhận ${retry.status})`);
      await waitDone();

      const rows = await ledgerRows(ctx.store, userId);
      const refunds = rows.filter((r) => r.reason === 'job_refund' && r.meta?.reconciled === true);
      assert.ok(refunds.length >= 1, 'phải có dòng hoàn cho lượt treo (`meta.reconciled = true`)');
      assert.ok(rows.filter((r) => r.reason === 'job_settle').length >= 2, 'lượt mới phải được quyết toán');
      const balanceFinal = await ctx.store.ledgerBalance(userId);
      assert.ok(balanceFinal > balanceStuck, `tiền giữ đọng phải được trả lại (trước ${balanceStuck}, sau ${balanceFinal})`);
    } finally {
      await ctx.close();
    }
  });

  test('route bảo trì: member ⇒ 403, owner ⇒ 200 kèm {reconciled, refunded}', async () => {
    const ctx = await startMvp05App({ configOverrides: { BILLING_STUCK_RUN_MS: '0' } });
    try {
      const memberJar = newJar();
      await register(ctx.base, { email: 'br08-member@example.com', jar: memberJar });
      const forbidden = await request(ctx.base, '/api/admin/billing/reconcile', { method: 'POST', jar: memberJar, body: {} });
      assert.equal(forbidden.status, 403, 'member KHÔNG được gọi route bảo trì');

      const ownerJar = newJar();
      const ownerReg = await register(ctx.base, { email: 'br08-owner@example.com', jar: ownerJar });
      const ownerId = ownerReg.body.user.id;
      await ctx.store.updateUser(ownerId, { role: 'owner' });
      // Tạo một lượt treo thật để route có việc làm; đẩy `created_at` về quá khứ để tất định
      // (ngưỡng 0 vẫn so bằng mili-giây nên một khoản giữ "vừa tạo" có thể trùng mốc).
      await ctx.app.billingService.grant({ userId: ownerId, amount: 1, reason: 'admin_grant', actorId: 't' });
      const stuck = await ctx.app.billingService.holdForJob({ userId: ownerId, jobId: 'JOB-ADMIN', estimate: 0.5 });
      await ctx.store.driver.run('UPDATE wallet_ledger SET created_at = ? WHERE run_key = ?', [
        new Date(Date.now() - 60_000).toISOString(),
        stuck.run_key,
      ]);

      const ok = await request(ctx.base, '/api/admin/billing/reconcile', { method: 'POST', jar: ownerJar, body: {} });
      assert.equal(ok.status, 200, 'owner phải gọi được route bảo trì');
      const body = await j(ok);
      assert.equal(body.reconciled, 1, `phải thu hồi đúng 1 lượt treo, nhận ${JSON.stringify(body)}`);
      assert.equal(body.refunded, 0.5);
      const again = await j(await request(ctx.base, '/api/admin/billing/reconcile', { method: 'POST', jar: ownerJar, body: {} }));
      assert.equal(again.reconciled, 0, 'gọi lại ⇒ không còn lượt treo nào (idempotent)');
    } finally {
      await ctx.close();
    }
  });
});

describe('BR-09 — không thu lại usage của lượt ĐÃ HOÀN', () => {
  test('lượt #1 lỗi (usage 0.3, đã hoàn 100%) ⇒ lượt #2 KHÔNG bị thu lại 0.3', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    const userId = 'u-br09';
    const jobId = 'JOB-BR09';
    await svc.grant({ userId, amount: 1 });

    const h1 = await svc.holdForJob({ userId, jobId, estimate: 0.5 });
    await store.recordUsage({ jobId, sessionId: 's', operation: 'OCR_DETECT', estimatedCost: 0.3 });
    await svc.refundForJob({ userId, jobId, runKey: h1.run_key, reason: 'JOB_FAILED' });
    assert.equal(await store.ledgerBalance(userId), 1, 'lượt lỗi được hoàn 100%');

    const h2 = await svc.holdForJob({ userId, jobId, estimate: 0.5 });
    const s2 = await svc.settleForJob({ userId, jobId, runKey: h2.run_key });
    const chargedRun2 = Number((0.5 - Number(s2?.amount ?? 0)).toFixed(6));
    assert.equal(chargedRun2, 0, `lượt #2 KHÔNG có usage riêng ⇒ thu 0, nhận ${chargedRun2} (thu lại phần đã hoàn)`);
    assert.equal(await store.ledgerBalance(userId), 1, 'số dư không đổi ⇒ không thu lại tiền đã hoàn');
    await store.close();
  });

  test('usage đến MUỘN của lượt đã khép ⇒ không bị thu ở lượt sau', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    const userId = 'u-br09b';
    const jobId = 'JOB-LATE';
    await svc.grant({ userId, amount: 2 });

    const h1 = await svc.holdForJob({ userId, jobId, estimate: 0.5 });
    await store.recordUsage({ jobId, sessionId: 's', runKey: h1.run_key, operation: 'OCR_DETECT', estimatedCost: 0.1 });
    await svc.settleForJob({ userId, jobId, runKey: h1.run_key });
    await store.recordUsage({ jobId, sessionId: 's', runKey: h1.run_key, operation: 'IMAGE_RENDER', estimatedCost: 0.2 });

    const h2 = await svc.holdForJob({ userId, jobId, estimate: 0.5 });
    await store.recordUsage({ jobId, sessionId: 's', runKey: h2.run_key, operation: 'TRANSLATION', estimatedCost: 0.3 });
    const s2 = await svc.settleForJob({ userId, jobId, runKey: h2.run_key });
    assert.equal(Number((0.5 - Number(s2.amount)).toFixed(6)), 0.3, 'lượt 2 chỉ thu usage CỦA LƯỢT (0.3)');

    const h3 = await svc.holdForJob({ userId, jobId, estimate: 0.5 });
    const s3 = await svc.settleForJob({ userId, jobId, runKey: h3.run_key });
    assert.equal(Number((0.5 - Number(s3?.amount ?? 0)).toFixed(6)), 0, 'lượt 3 không có usage riêng ⇒ thu 0 (không thu phần đến muộn)');
    await store.close();
  });

  test('DB cũ (usage KHÔNG gắn run_key): lượt #1 nhận hết, lượt sau chỉ nhận phần của mình', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    const userId = 'u-br09c';
    const jobId = 'JOB-LEGACY';
    await svc.grant({ userId, amount: 1 });

    const charged = [];
    for (let run = 1; run <= 3; run += 1) {
      const before = await store.ledgerBalance(userId);
      await svc.holdForJob({ userId, jobId, estimate: 0.5 });
      await store.recordUsage({ jobId, sessionId: 's', operation: 'OCR_DETECT', estimatedCost: 0.1 });
      await svc.settleForJob({ userId, jobId });
      charged.push(Number((before - (await store.ledgerBalance(userId))).toFixed(6)));
    }
    assert.deepEqual(charged, [0.1, 0.1, 0.1], `mỗi lượt 0.1 (không thu thừa, không bỏ sót): ${JSON.stringify(charged)}`);
    await store.close();
  });
});
