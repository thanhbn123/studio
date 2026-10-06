/**
 * TEST HỒI QUY — MVP-05 vòng 5: BR-10 (không cắt ngang lượt ĐANG CHẠY) + BR-11 (dấu vết usage).
 *
 *   BR-10 (THẤP–TB, theo cấu hình)  `reconcileStuckRuns` phải BỎ QUA lượt của job ĐANG HOẠT ĐỘNG
 *        (hàng đợi còn việc / trạng thái queued|running) dù đã quá ngưỡng; có `force` cho admin;
 *        và đáy an toàn `billing.minStuckRunMs` (`BILLING_MIN_STUCK_RUN_MS`) không cho cấu hình
 *        ngưỡng quá ngắn cắt ngang job thật.
 *   BR-11 (THẤP)  mọi lần settle phải ghi RÕ nguồn chi phí: `meta.usage_source` ∈
 *        run|legacy|none|unavailable; không quy được usage ⇒ `meta.usage_unavailable = true` +
 *        log WARN `billing.usage_unavailable`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/store/index.js';
import { createBillingService } from '../src/billing/index.js';
import { loadConfig } from '../src/config.js';
import { j, ledgerRows, newJar, register, request } from './mvp05-helpers.js';
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

/** Logger ghi lại mọi bản ghi để khẳng định WARN có thật. */
function spyLogger() {
  const records = [];
  const make = (level) => (event, data) => records.push({ level, event, data });
  const logger = { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error'), records };
  logger.child = () => logger;
  return logger;
}

describe('BR-10 — reconciliation KHÔNG cắt ngang lượt đang chạy', () => {
  test('có `isJobActive` ⇒ lượt quá ngưỡng của job ĐANG chạy KHÔNG bị hoàn/đóng', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    const userId = 'u-br10';
    await svc.grant({ userId, amount: 2 });

    const running = await svc.holdForJob({ userId, jobId: 'JOB-RUNNING', estimate: 0.5 });
    const dead = await svc.holdForJob({ userId, jobId: 'JOB-DEAD', estimate: 0.5 });
    // Cả hai đều "quá ngưỡng" (đẩy created_at về quá khứ).
    const past = new Date(Date.now() - 600_000).toISOString();
    await store.driver.run('UPDATE wallet_ledger SET created_at = ? WHERE run_key IN (?, ?)', [past, running.run_key, dead.run_key]);

    const out = await svc.reconcileStuckRuns({
      olderThanMs: 1000,
      isJobActive: async (jobId) => jobId === 'JOB-RUNNING', // job này đang chạy thật
    });
    assert.equal(out.reconciled, 1, `chỉ job ĐÃ CHẾT được thu hồi: ${JSON.stringify(out)}`);
    assert.equal(out.skipped_active, 1, 'phải báo cáo số lượt BỎ QUA vì job đang hoạt động');
    assert.deepEqual(out.runs.map((r) => r.run_key), [dead.run_key]);

    const rows = await ledgerRows(store, userId);
    assert.equal(
      rows.some((r) => r.reason === 'job_refund' && r.run_key === running.run_key),
      false,
      'BR-10: lượt của job ĐANG CHẠY không được hoàn/đóng (nếu không nó thành miễn phí)',
    );
    assert.ok(rows.some((r) => r.reason === 'job_refund' && r.run_key === dead.run_key), 'job đã chết vẫn phải được thu hồi');
    await store.close();
  });

  test('đáy an toàn: BILLING_STUCK_RUN_MS ngắn hơn BILLING_MIN_STUCK_RUN_MS ⇒ tự nâng + log WARN', async () => {
    const config = unitConfig({ BILLING_STUCK_RUN_MS: '10', BILLING_MIN_STUCK_RUN_MS: '60000' });
    assert.equal(config.billing.stuckRunMs, 10, 'ngưỡng CẤU HÌNH giữ nguyên (dùng cho đường có kiểm tra job)');
    assert.equal(config.billing.minStuckRunMs, 60000);
    assert.equal(config.billing.stuckRunMsRaised, true, 'phải có cờ để tầng boot ghi WARN');

    const store = await createStore(config, silent);
    await store.init?.();
    const logger = spyLogger();
    const svc = createBillingService(config, { store, logger });

    // Đường KHÔNG kiểm được job đang chạy hay không ⇒ ngưỡng bị nâng lên ĐÁY AN TOÀN + WARN.
    const userId = 'u-br10-floor';
    await svc.grant({ userId, amount: 1 });
    const hold = await svc.holdForJob({ userId, jobId: 'JOB-FLOOR', estimate: 0.5 });
    const unguarded = await svc.reconcileStuckRuns({}); // không `isJobActive`
    assert.equal(unguarded.older_than_ms, 60000, 'không kiểm được job ⇒ ngưỡng phải bị nâng lên đáy 60s');
    assert.equal(unguarded.reconciled, 0, 'lượt còn MỚI (so với đáy 60s) không được thu hồi');
    assert.ok(
      logger.records.some((r) => r.level === 'warn' && r.event === 'billing.stuck_run_ms_raised'),
      `phải log WARN billing.stuck_run_ms_raised, nhận ${JSON.stringify(logger.records.map((r) => r.event))}`,
    );
    const rows = await ledgerRows(store, userId);
    assert.equal(rows.some((r) => r.reason === 'job_refund' && r.run_key === hold.run_key), false);

    // Đường CÓ kiểm tra job (app/route) ⇒ dùng đúng ngưỡng cấu hình (vận hành phục hồi được nhanh).
    // Đẩy `created_at` về quá khứ để so mốc mili-giây được tất định.
    await store.driver.run('UPDATE wallet_ledger SET created_at = ? WHERE run_key = ?', [
      new Date(Date.now() - 60_000).toISOString(),
      hold.run_key,
    ]);
    const guarded = await svc.reconcileStuckRuns({ isJobActive: () => false });
    assert.equal(guarded.older_than_ms, 10, 'có `isJobActive` ⇒ dùng ngưỡng cấu hình (10ms)');
    assert.equal(guarded.reconciled, 1, 'job đã chết + quá ngưỡng cấu hình ⇒ VẪN thu hồi được');
    await store.close();
  });

  test('HTTP: job đang chạy + ngưỡng ngắn (đã hạ đáy) ⇒ request thứ hai 409, KHÔNG thu hồi; tổng thu = tổng thật', async () => {
    const ctx = await startMvp05App({
      configOverrides: { BILLING_STUCK_RUN_MS: '50', BILLING_MIN_STUCK_RUN_MS: '50' },
    });
    try {
      const jar = newJar();
      const reg = await register(ctx.base, { email: 'br10@example.com', jar });
      const userId = reg.body.user.id;
      await ctx.app.billingService.grant({ userId, amount: 4, reason: 'admin_grant', actorId: 't' });

      const jobId = (await j(await request(ctx.base, '/api/jobs', { method: 'POST', jar, body: { manual: { title: 'br10' } } }))).job_id;
      const waitDone = async () => {
        for (let i = 0; i < 300; i += 1) {
          const st = await j(await request(ctx.base, `/api/jobs/${jobId}`, { jar }));
          if (st?.status && !['queued', 'running'].includes(st.status)) return;
          await new Promise((r) => setTimeout(r, 25));
        }
      };
      await waitDone();

      // Lượt chạy lại A (chậm) rồi 120ms sau bắn B: B KHÔNG được thu hồi lượt A đang chạy.
      const pA = request(ctx.base, `/api/jobs/${jobId}/regenerate`, { method: 'POST', jar, body: {} });
      await new Promise((r) => setTimeout(r, 120));
      const pB = request(ctx.base, `/api/jobs/${jobId}/regenerate`, { method: 'POST', jar, body: {} });
      const [a, b] = await Promise.all([pA, pB]);
      assert.equal(a.status, 202, `lượt A phải được nhận (nhận ${a.status})`);
      assert.ok([202, 409].includes(b.status), `lượt B phải là 202 (mở lượt mới) hoặc 409 (đang chạy), nhận ${b.status}`);
      await waitDone();
      await new Promise((r) => setTimeout(r, 300));

      const events = await ctx.store.listUsage(jobId);
      const holds = (await ledgerRows(ctx.store, userId)).filter((r) => r.reason === 'job_hold');
      const refundsReconciled = (await ledgerRows(ctx.store, userId)).filter((r) => r.reason === 'job_refund' && r.meta?.reconciled === true);
      const charged = Number((4 - (await ctx.store.ledgerBalance(userId))).toFixed(6));
      const real = Number(events.reduce((s, e) => s + Number(e.estimated_cost || 0), 0).toFixed(6));
      assert.equal(refundsReconciled.length, 0, 'BR-10: KHÔNG được thu hồi (hoàn) lượt đang chạy thật');
      assert.ok(
        Math.abs(charged - real) < 1e-6,
        `tổng thu phải bằng tổng chi phí thật (thu ${charged}, thật ${real}, hold ${holds.length}, event ${events.length})`,
      );
    } finally {
      await ctx.close();
    }
  });

  test('route bảo trì: `force: true` ⇒ thu hồi DÙ job đang hoạt động, dòng hoàn có `meta.forced`', async () => {
    const ctx = await startMvp05App({
      configOverrides: { BILLING_STUCK_RUN_MS: '0', BILLING_MIN_STUCK_RUN_MS: '0' },
    });
    try {
      const ownerJar = newJar();
      const ownerReg = await register(ctx.base, { email: 'br10-owner@example.com', jar: ownerJar });
      const ownerId = ownerReg.body.user.id;
      await ctx.store.updateUser(ownerId, { role: 'owner' });
      await ctx.app.billingService.grant({ userId: ownerId, amount: 1, reason: 'admin_grant', actorId: 't' });

      // Lượt "đang chạy" theo nghĩa job ở trạng thái running.
      await ctx.store.createJob({ id: 'JOB-FORCED', sessionId: 's', userId: ownerId, kind: 'content' });
      await ctx.store.updateJob('JOB-FORCED', { status: 'running', stage: 'running' });
      const hold = await ctx.app.billingService.holdForJob({ userId: ownerId, jobId: 'JOB-FORCED', estimate: 0.5 });
      await ctx.store.driver.run('UPDATE wallet_ledger SET created_at = ? WHERE run_key = ?', [
        new Date(Date.now() - 60_000).toISOString(),
        hold.run_key,
      ]);

      // Không force ⇒ bỏ qua (job đang hoạt động).
      const skipped = await j(await request(ctx.base, '/api/admin/billing/reconcile', { method: 'POST', jar: ownerJar, body: {} }));
      assert.equal(skipped.reconciled, 0, 'job đang chạy ⇒ không thu hồi');
      assert.equal(skipped.skipped_active, 1, 'phải báo cáo là đã bỏ qua vì job đang hoạt động');

      // force: true ⇒ ép thu hồi.
      const forced = await j(await request(ctx.base, '/api/admin/billing/reconcile', { method: 'POST', jar: ownerJar, body: { force: true } }));
      assert.equal(forced.reconciled, 1, `force ⇒ phải thu hồi, nhận ${JSON.stringify(forced)}`);
      assert.equal(forced.forced, true);
      const refund = (await ledgerRows(ctx.store, ownerId)).find((r) => r.reason === 'job_refund' && r.run_key === hold.run_key);
      assert.ok(refund, 'phải có dòng hoàn cho lượt bị ép thu hồi');
      assert.equal(refund.meta?.forced, true, 'dòng hoàn phải ghi `meta.forced = true`');
    } finally {
      await ctx.close();
    }
  });
});

describe('BR-11 — dấu vết nguồn usage khi settle', () => {
  test("job KHÔNG tốn gì ⇒ meta.usage_source = 'none' (không phải 'unavailable')", async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    const userId = 'u-br11-none';
    await svc.grant({ userId, amount: 1 });

    await svc.holdForJob({ userId, jobId: 'JOB-NONE', estimate: 0.5 });
    const settled = await svc.settleForJob({ userId, jobId: 'JOB-NONE' });
    assert.equal(settled.meta?.usage_source, 'none', `phải nói rõ là không có usage, nhận ${JSON.stringify(settled.meta)}`);
    assert.equal(settled.meta?.usage_unavailable, undefined, "không có usage nào thì KHÔNG phải 'không đọc được'");
    assert.equal(settled.amount, 0.5, 'hoàn lại toàn bộ khoản giữ (không thu gì)');
    await store.close();
  });

  test("usage có nhưng KHÔNG thuộc lượt ⇒ meta.usage_source = 'unavailable' + usage_unavailable + WARN", async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const logger = spyLogger();
    const svc = createBillingService(config, { store, logger });
    const userId = 'u-br11-unavail';
    await svc.grant({ userId, amount: 1 });

    // Lượt #1 lỗi: usage 0.3 gắn #1 rồi HOÀN 100%.
    const h1 = await svc.holdForJob({ userId, jobId: 'JOB-UNAVAIL', estimate: 0.5 });
    await store.recordUsage({ jobId: 'JOB-UNAVAIL', sessionId: 's', runKey: h1.run_key, operation: 'OCR_DETECT', estimatedCost: 0.3 });
    await svc.refundForJob({ userId, jobId: 'JOB-UNAVAIL', runKey: h1.run_key, reason: 'JOB_FAILED' });

    // Lượt #2 không có usage riêng ⇒ không thu, NHƯNG phải để lại vết.
    const h2 = await svc.holdForJob({ userId, jobId: 'JOB-UNAVAIL', estimate: 0.5 });
    const settled = await svc.settleForJob({ userId, jobId: 'JOB-UNAVAIL', runKey: h2.run_key });
    assert.equal(settled.meta?.usage_source, 'unavailable', `nhận ${JSON.stringify(settled.meta)}`);
    assert.equal(settled.meta?.usage_unavailable, true);
    assert.equal(settled.amount, 0.5, 'không thu lại phần đã hoàn');
    assert.ok(
      logger.records.some((r) => r.level === 'warn' && r.event === 'billing.usage_unavailable' && r.data?.run_key === h2.run_key),
      `phải log WARN billing.usage_unavailable kèm run_key, nhận ${JSON.stringify(logger.records.map((r) => `${r.level}:${r.event}`))}`,
    );
    await store.close();
  });

  test("usage của chính lượt ⇒ 'run'; usage DB cũ (không run_key) ⇒ 'legacy'", async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    const userId = 'u-br11-src';
    await svc.grant({ userId, amount: 2 });

    const h1 = await svc.holdForJob({ userId, jobId: 'JOB-SRC', estimate: 0.5 });
    await store.recordUsage({ jobId: 'JOB-SRC', sessionId: 's', runKey: h1.run_key, operation: 'OCR_DETECT', estimatedCost: 0.1 });
    const s1 = await svc.settleForJob({ userId, jobId: 'JOB-SRC', runKey: h1.run_key });
    assert.equal(s1.meta?.usage_source, 'run');

    const h2 = await svc.holdForJob({ userId, jobId: 'JOB-SRC', estimate: 0.5 });
    await store.recordUsage({ jobId: 'JOB-SRC', sessionId: 's', operation: 'IMAGE_RENDER', estimatedCost: 0.05 }); // DB cũ
    const s2 = await svc.settleForJob({ userId, jobId: 'JOB-SRC', runKey: h2.run_key });
    assert.equal(s2.meta?.usage_source, 'legacy');
    assert.equal(Number((0.5 - Number(s2.amount)).toFixed(6)), 0.05, 'vẫn thu đúng phần của lượt');
    await store.close();
  });
});
