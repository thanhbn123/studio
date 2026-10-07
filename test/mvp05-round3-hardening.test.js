/**
 * TEST HỒI QUY — MVP-05 vòng 3: xử lý BR-01…BR-07 của phản biện vòng 2.
 *
 *   BR-07 (CAO, đường mặc định)  settle phải theo chi phí của RIÊNG LƯỢT (`usage_events.run_key`)
 *                                — không bao giờ lấy usage TÍCH LUỸ của cả job.
 *   BR-01 (CAO theo cấu hình)    `BILLING_HOLD_BEFORE_JOB=false` vẫn mở LƯỢT, vẫn settle theo
 *                                chi phí thật của lượt và vẫn áp trần `maxRunsPerJob`.
 *   BR-02 (TB)                   hai request chồng nhau cùng job ⇒ request thứ hai 409.
 *   BR-03 (TB)                   sổ lỗi ở `beforeJob` ⇒ FAIL-CLOSED 503; DB chặn 2 dòng ĐÓNG
 *                                cho cùng một lượt (settle+refund).
 *   BR-04 (THẤP)                 login còn bucket RỘNG theo IP (chống spraying).
 *   BR-05 (THẤP)                 lượt lỗi đã hoàn KHÔNG ăn vào trần lượt.
 *   BR-06 (THẤP)                 `ingest` lỗi ⇒ job `failed` (không treo `running`).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/store/index.js';
import { createBillingService } from '../src/billing/index.js';
import { loadConfig } from '../src/config.js';
import { newJar, register, request, j, ledgerRows, tmpDir } from './mvp05-helpers.js';
import { startMvp05App } from './mvp05-helpers.js';
import { silent } from './helpers.js';

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

describe('BR-07 — settle theo chi phí của RIÊNG LƯỢT (không thu thừa)', () => {
  test('usage ghi KHÔNG kèm run_key: mỗi lượt vẫn bị thu đúng phần TĂNG của lượt đó', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    const userId = 'u-br07';
    const jobId = 'JOB-BR07';
    await svc.grant({ userId, amount: 1 });

    const charged = [];
    for (let run = 1; run <= 4; run += 1) {
      const beforeHold = await store.ledgerBalance(userId);
      await svc.holdForJob({ userId, jobId, estimate: 0.5 });
      // Lượt này tiêu THẬT 0.1 — usage ghi kiểu CŨ (không có run_key).
      await store.recordUsage({ jobId, sessionId: 's', operation: 'OCR_DETECT', estimatedCost: 0.1 });
      await svc.settleForJob({ userId, jobId }); // KHÔNG truyền actualCost ⇒ service tự tính
      // Phần THỰC SỰ bị thu của lượt = số dư trước khi giữ − số dư sau khi quyết toán.
      charged.push(Number((beforeHold - (await store.ledgerBalance(userId))).toFixed(6)));
    }
    assert.deepEqual(charged, [0.1, 0.1, 0.1, 0.1], `mỗi lượt phải thu 0.1, nhận ${JSON.stringify(charged)}`);
    assert.equal(await store.ledgerBalance(userId), 0.6, 'tổng thu 0.4 cho 0.4 chi phí thật (1 − 0.4)');
    await store.close();
  });

  test('usage CÓ run_key: settle lấy đúng chi phí của lượt, kể cả khi lượt trước tốn nhiều', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    const userId = 'u-br07b';
    const jobId = 'JOB-BR07B';
    await svc.grant({ userId, amount: 1 });

    const h1 = await svc.holdForJob({ userId, jobId, estimate: 0.5 });
    await store.recordUsage({ jobId, sessionId: 's', runKey: h1.run_key, operation: 'A', estimatedCost: 0.4 });
    await svc.settleForJob({ userId, jobId });
    assert.equal(await store.ledgerBalance(userId), 0.6, 'lượt 1 thu 0.4');

    const h2 = await svc.holdForJob({ userId, jobId, estimate: 0.5 });
    await store.recordUsage({ jobId, sessionId: 's', runKey: h2.run_key, operation: 'B', estimatedCost: 0.05 });
    await svc.settleForJob({ userId, jobId });
    assert.equal(await store.ledgerBalance(userId), 0.55, 'lượt 2 chỉ thu 0.05 — KHÔNG thu lại 0.4 của lượt 1');
    await store.close();
  });

  test('pipeline ghi usage kèm run_key của lượt (HTTP: 2 lượt chạy content ⇒ thu đúng, không thu thừa)', async () => {
    const ctx = await startMvp05App();
    try {
      const jar = newJar();
      const reg = await register(ctx.base, { email: 'br07@example.com', jar });
      const userId = reg.body.user.id;
      await ctx.app.billingService.grant({ userId, amount: 1, reason: 'admin_grant', actorId: 't' });

      const runOnce = async () => {
        const created = await j(await request(ctx.base, '/api/jobs', { method: 'POST', jar, body: { manual: { title: 'br07' } } }));
        const jobId = created.job_id;
        for (let i = 0; i < 200; i += 1) {
          const st = await j(await request(ctx.base, `/api/jobs/${jobId}`, { jar }));
          if (st?.status && !['queued', 'running'].includes(st.status)) break;
          await new Promise((r) => setTimeout(r, 25));
        }
        return jobId;
      };

      const jobId = await runOnce();
      const usage1 = await ctx.store.usageSummary(jobId);
      const balance1 = (await ctx.store.ledgerBalance(userId));
      // Usage của lượt 1 phải ĐƯỢC GẮN run_key (không còn NULL) ⇒ lần sau quy được về lượt.
      const events = await ctx.store.listUsage(jobId);
      assert.ok(events.length > 0);
      assert.ok(events.every((e) => typeof e.run_key === 'string' && e.run_key.endsWith('#1')), 'usage lượt 1 phải mang run_key #1');

      const regen = await request(ctx.base, `/api/jobs/${jobId}/regenerate`, { method: 'POST', jar, body: {} });
      assert.equal(regen.status, 202);
      for (let i = 0; i < 200; i += 1) {
        const st = await j(await request(ctx.base, `/api/jobs/${jobId}`, { jar }));
        if (st?.status && !['queued', 'running'].includes(st.status)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const usage2 = await ctx.store.usageSummary(jobId);
      const balance2 = await ctx.store.ledgerBalance(userId);
      const charged = Number((balance1 - balance2).toFixed(6));
      const costOfRun2 = Number((usage2.estimated_cost - usage1.estimated_cost).toFixed(6));
      assert.ok(charged > 0, 'lượt chạy lại PHẢI bị thu');
      assert.ok(
        Math.abs(charged - costOfRun2) < 1e-6,
        `lượt 2 phải thu đúng chi phí của lượt (${costOfRun2}), nhận ${charged} (thu thừa ${Number((charged - costOfRun2).toFixed(6))})`,
      );
    } finally {
      await ctx.close();
    }
  });
});

describe('BR-01 — holdBeforeJob=false vẫn mở LƯỢT, vẫn settle và vẫn áp trần', () => {
  test('3 lượt chạy lại ⇒ 3 dòng job_settle (số dư giảm), lượt vượt trần ⇒ 429', async () => {
    const ctx = await startMvp05App({
      configOverrides: { BILLING_HOLD_BEFORE_JOB: 'false', BILLING_MAX_RUNS_PER_JOB: '3' },
    });
    try {
      const jar = newJar();
      const reg = await register(ctx.base, { email: 'br01@example.com', jar });
      const userId = reg.body.user.id;
      await ctx.app.billingService.grant({ userId, amount: 1, reason: 'admin_grant', actorId: 't' });

      const created = await j(await request(ctx.base, '/api/jobs', { method: 'POST', jar, body: { manual: { title: 'br01' } } }));
      const jobId = created.job_id;
      const waitDone = async () => {
        for (let i = 0; i < 200; i += 1) {
          const st = await j(await request(ctx.base, `/api/jobs/${jobId}`, { jar }));
          if (st?.status && !['queued', 'running'].includes(st.status)) return;
          await new Promise((r) => setTimeout(r, 25));
        }
      };
      await waitDone();
      const settlesAfterFirst = (await ledgerRows(ctx.store, userId)).filter((r) => r.reason === 'job_settle').length;
      assert.equal(settlesAfterFirst, 1, 'lượt đầu phải có dòng job_settle (thu theo chi phí thật)');
      const balanceAfterFirst = await ctx.store.ledgerBalance(userId);
      assert.ok(balanceAfterFirst < 1, 'số dư phải GIẢM sau lượt đầu');

      let statuses = [];
      for (let i = 0; i < 2; i += 1) {
        const regen = await request(ctx.base, `/api/jobs/${jobId}/regenerate`, { method: 'POST', jar, body: {} });
        statuses.push(regen.status);
        if (regen.status === 202) await waitDone();
      }
      assert.deepEqual(statuses, [202, 202], 'hai lượt trong trần phải chạy được');
      const rows = await ledgerRows(ctx.store, userId);
      assert.equal(rows.filter((r) => r.reason === 'job_settle').length, 3, 'MỖI lượt một dòng settle (trước đây: không có dòng nào)');
      const balanceAfterThree = await ctx.store.ledgerBalance(userId);
      assert.ok(balanceAfterThree < balanceAfterFirst, 'số dư tiếp tục giảm theo từng lượt');

      const over = await request(ctx.base, `/api/jobs/${jobId}/regenerate`, { method: 'POST', jar, body: {} });
      assert.equal(over.status, 429, 'lượt vượt trần phải bị chặn 429 (trước đây 202)');
      assert.equal((await j(over)).error.code, 'RERUN_LIMIT_EXCEEDED');
    } finally {
      await ctx.close();
    }
  });
});

describe('BR-02 — hai request chồng nhau cùng job', () => {
  test('request thứ hai khi lượt đang mở ⇒ 409 JOB_ALREADY_RUNNING (không chạy chung một khoản giữ)', async () => {
    const ctx = await startMvp05App();
    try {
      const jar = newJar();
      const reg = await register(ctx.base, { email: 'br02@example.com', jar });
      const userId = reg.body.user.id;
      await ctx.app.billingService.grant({ userId, amount: 5, reason: 'admin_grant', actorId: 't' });

      const jobId = (await j(await request(ctx.base, '/api/jobs', { method: 'POST', jar, body: { manual: { title: 'br02' } } }))).job_id;
      for (let i = 0; i < 200; i += 1) {
        const st = await j(await request(ctx.base, `/api/jobs/${jobId}`, { jar }));
        if (st?.status && !['queued', 'running'].includes(st.status)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      // Hai request GẦN NHƯ ĐỒNG THỜI trên cùng job.
      const [a, b] = await Promise.all([
        request(ctx.base, `/api/jobs/${jobId}/regenerate`, { method: 'POST', jar, body: {} }),
        request(ctx.base, `/api/jobs/${jobId}/regenerate`, { method: 'POST', jar, body: {} }),
      ]);
      const statuses = [a.status, b.status].sort();
      const blocked = [a, b].find((r) => r.status === 409);
      if (blocked) assert.equal((await j(blocked)).error.code, 'JOB_ALREADY_RUNNING');

      for (let i = 0; i < 240; i += 1) {
        const st = await j(await request(ctx.base, `/api/jobs/${jobId}`, { jar }));
        if (st?.status && !['queued', 'running'].includes(st.status)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      // BẤT BIẾN (BR-02): số LƯỢT CHẠY THẬT (usage mang run_key) ≤ số LƯỢT BỊ GIỮ TIỀN.
      const events = await ctx.store.listUsage(jobId);
      const realRuns = new Set(events.map((e) => e.run_key).filter(Boolean));
      const holds = (await ledgerRows(ctx.store, userId)).filter((r) => r.reason === 'job_hold');
      assert.ok(realRuns.size >= 2, `hai request 202 phải là HAI lượt chạy thật (nhận ${realRuns.size})`);
      assert.ok(
        holds.length >= realRuns.size,
        `mỗi lượt chạy thật phải có một khoản giữ riêng: ${realRuns.size} lượt / ${holds.length} hold (status ${JSON.stringify(statuses)})`,
      );
    } finally {
      await ctx.close();
    }
  });
});

describe('BR-03 — sổ lỗi ⇒ fail-closed; DB chặn 2 dòng đóng cho cùng lượt', () => {
  test('beforeJob: lỗi ghi sổ ⇒ BILLING_UNAVAILABLE (không cho chạy miễn phí)', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    const userId = 'u-br03';

    const { createApp } = await import('../src/app.js');
    const app = await createApp({ config, logger: silent, store, billingService: svc, connectors: [] });
    try {
      await svc.grant({ userId, amount: 1 });
      // Bơm lỗi ghi sổ: mọi lần `holdForJob` sẽ ném lỗi DB thô (giống `database is locked`).
      const original = store.appendLedger.bind(store);
      store.appendLedger = async () => {
        throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
      };
      await assert.rejects(
        () => app.billingHook.beforeJob({ userId, jobId: 'JOB-BR03', kind: 'content' }),
        (err) => err.code === 'BILLING_UNAVAILABLE',
        'BR-03a: lỗi sổ phải fail-closed, KHÔNG được nuốt thành "không giữ được tiền nhưng vẫn chạy"',
      );
      store.appendLedger = original;
    } finally {
      await app.close?.();
      await store.close();
    }
  });

  test('DB: lượt đã settle thì KHÔNG thể ghi thêm job_refund cho cùng lượt', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const userId = 'u-br03b';
    const jobId = 'JOB-BR03B';
    await store.appendLedger({ userId, amount: 1, reason: 'admin_grant', balanceAfter: 1 });
    await store.appendLedger({ userId, amount: -0.5, reason: 'job_hold', jobId, runKey: `${jobId}#1`, balanceAfter: 0.5 });
    await store.appendLedger({ userId, amount: 0.4, reason: 'job_settle', jobId, runKey: `${jobId}#1`, balanceAfter: 0.9 });
    await assert.rejects(
      () => store.appendLedger({ userId, amount: 0.1, reason: 'job_refund', jobId, runKey: `${jobId}#1`, balanceAfter: 1 }),
      (err) => err?.code === 'LEDGER_CONFLICT' || /UNIQUE|constraint/i.test(String(err?.message || err)),
      'BR-03b: một lượt chỉ được có MỘT dòng đóng (settle HOẶC refund)',
    );
    await store.close();
  });
});

describe('BR-04 — chống spraying: còn trần RỘNG theo IP', () => {
  test('nhiều email khác nhau, mỗi email 1 lần sai ⇒ vẫn có 429 theo IP', async () => {
    const ctx = await startMvp05App();
    try {
      let blocked = 0;
      for (let i = 0; i < 70; i += 1) {
        const res = await request(ctx.base, '/api/auth/login', {
          method: 'POST',
          body: { email: `spray-${i}@example.com`, password: 'sai-mat-khau-123' },
        });
        if (res.status === 429) {
          blocked += 1;
          assert.ok(Number(res.headers?.get?.('retry-after')) > 0, '429 phải kèm Retry-After');
        }
      }
      assert.ok(blocked > 0, 'BR-04: spraying qua nhiều email phải bị chặn theo IP (trước đây 0 lần 429)');
    } finally {
      await ctx.close();
    }
  });
});

describe('BR-05 — lượt LỖI không ăn vào trần lượt', () => {
  test('tầng dịch vụ: lượt đã refund không tính vào trần', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    const userId = 'u-br05';
    const jobId = 'JOB-BR05';
    await svc.grant({ userId, amount: 5 });

    for (let i = 0; i < 3; i += 1) {
      const h = await svc.holdForJob({ userId, jobId, estimate: 0.5, maxRunsPerJob: 2 });
      await svc.refundForJob({ userId, jobId, runKey: h.run_key, reason: 'JOB_FAILED' });
    }
    assert.deepEqual(await svc.billableRunsOfJob({ userId, jobId }), [], '3 lượt lỗi đã hoàn ⇒ 0 lượt có thu');
    const ok = await svc.holdForJob({ userId, jobId, estimate: 0.5, maxRunsPerJob: 2 });
    assert.ok(ok.run_key, 'job chưa từng thành công vẫn phải chạy được (không 429 oan)');
    await store.close();
  });
});

describe('BR-06 — ingest lỗi ⇒ job failed (không treo running)', () => {
  test('tiền hoàn đủ và job mang trạng thái failed + error_code', async () => {
    const ctx = await startMvp05App();
    try {
      const jar = newJar();
      const reg = await register(ctx.base, { email: 'br06@example.com', jar });
      const userId = reg.body.user.id;
      await ctx.app.billingService.grant({ userId, amount: 1, reason: 'admin_grant', actorId: 't' });

      // Bơm lỗi storage ⇒ nhánh `ingest` lỗi của route imagelab.
      const pipeline = ctx.app.imagelabPipeline;
      const original = pipeline.ingest.bind(pipeline);
      pipeline.ingest = async () => {
        throw Object.assign(new Error('storage hỏng'), { code: 'STORAGE_WRITE_FAILED' });
      };

      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/9v3lAAAAAElFTkSuQmCC',
        'base64',
      );
      const res = await request(ctx.base, '/api/imagelab/jobs', {
        method: 'POST',
        jar,
        body: { image: { base64: png.toString('base64') } },
      });
      assert.ok(res.status >= 400, `ingest lỗi ⇒ HTTP lỗi, nhận ${res.status}`);
      pipeline.ingest = original;

      const balance = await ctx.store.ledgerBalance(userId);
      assert.equal(balance, 1, 'PB-01: tiền phải được hoàn đủ');
      const running = await ctx.store.driver.all("SELECT id, status FROM jobs WHERE status IN ('running','queued')");
      assert.equal(running.length, 0, `BR-06: không được để job treo (còn ${JSON.stringify(running)})`);
      const failed = await ctx.store.driver.all("SELECT error_code, finished_at FROM jobs WHERE status = 'failed'");
      assert.ok(failed.length >= 1, 'phải có job ở trạng thái failed');
      assert.ok(failed[0].error_code, 'job failed phải có error_code');
      assert.ok(failed[0].finished_at, 'job failed phải có finished_at');
    } finally {
      await ctx.close();
    }
  });
});
