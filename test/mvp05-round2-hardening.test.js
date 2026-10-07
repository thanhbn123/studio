/**
 * TEST HỒI QUY — MVP-05 vòng 2: xử lý PB-01…PB-08 của phản biện.
 *
 *   PB-01 (CAO)  mọi lỗi SAU khi giữ tiền phải HOÀN khoản giữ (không mất credit cho request 4xx).
 *   PB-02 (CAO)  chu kỳ tiền theo LƯỢT CHẠY (run) — chạy lại phải trả tiền + trần lượt chạy.
 *   PB-03 (CAO)  bootstrap owner đầu tiên (OWNER_EMAIL + service.bootstrapOwner).
 *   PB-04 (TB)   `refundForJob` KHÔNG hoàn phần đã settle (không tạo tiền) + unique index DB.
 *   PB-05 (TB)   `BILLING_DEFAULT_GRANT` và `BILLING_HOLD_BEFORE_JOB=false` phải có tác dụng THẬT.
 *   PB-06 (THẤP) `grant(1e308)` ⇒ 400, sổ KHÔNG thêm dòng (trước: 201 + dòng amount = 0).
 *   PB-07 (THẤP) credit số âm ⇒ `reason='adjustment'`, giữ luật số dư không âm (400 khi thiếu).
 *   PB-08 (THẤP) bucket login theo (email, IP), chỉ đếm lần SAI, 429 + `Retry-After`,
 *                KHÔNG chặn đăng nhập ĐÚNG.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/store/index.js';
import { createBillingService } from '../src/billing/index.js';
import { createAccountService } from '../src/accounts/index.js';
import { loadConfig } from '../src/config.js';
import {
  PASSWORD,
  j,
  ledgerRows,
  login,
  me,
  newJar,
  register,
  request,
  startMvp05App,
  tmpDir,
} from './mvp05-helpers.js';
import { silent } from './helpers.js';

/** Config tối thiểu cho test tầng dịch vụ (không dựng HTTP). */
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

describe('PB-01 — lỗi 4xx sau khi giữ tiền ⇒ HOÀN khoản giữ', () => {
  test('PUT /api/imagelab/jobs/:id/regions 409 ⇒ số dư về đúng cũ, sổ có dòng job_refund', async () => {
    const ctx = await startMvp05App();
    try {
      // 1) Tạo job NỘI DUNG ẩn danh (không có ảnh gốc) trên một client chưa đăng nhập.
      const jar = newJar();
      const created = await request(ctx.base, '/api/jobs', {
        method: 'POST',
        jar,
        body: { manual: { title: 'job PB-01' } },
      });
      assert.equal(created.status, 202, `phải tạo được job ẩn danh (nhận ${created.status})`);
      const jobId = (await j(created)).job_id;

      // 2) Đăng nhập TRÊN CHÍNH client đó (job ẩn danh cũ vẫn thuộc session này) rồi nạp credit.
      const reg = await register(ctx.base, { email: 'pb01@example.com', jar });
      const userId = reg.body.user.id;
      await ctx.app.billingService.grant({ userId, amount: 1, reason: 'admin_grant', actorId: 'test' });
      const balanceBefore = (await j(await me(ctx.base, jar))).balance.amount;
      assert.equal(balanceBefore, 1, 'ví phải có 1 credit trước khi đo');

      // 3) PUT vùng chữ trên job KHÔNG có ảnh gốc ⇒ 409 (đã giữ tiền rồi mới lỗi).
      let attempts = 0;
      for (let i = 0; i < 3; i += 1) {
        const res = await request(ctx.base, `/api/imagelab/jobs/${jobId}/regions`, {
          method: 'PUT',
          jar,
          body: { regions: [{ box: { x: 1, y: 1, w: 10, h: 10 }, text: '纯棉' }] },
        });
        if (res.status === 409) attempts += 1;
      }
      assert.ok(attempts > 0, 'phải có ít nhất một request 409 để đo');

      const balanceAfter = (await j(await me(ctx.base, jar))).balance.amount;
      assert.equal(balanceAfter, balanceBefore, `PB-01: 409 KHÔNG được tiêu credit (trước ${balanceBefore}, sau ${balanceAfter})`);
      const rows = await ledgerRows(ctx.store, userId);
      const holds = rows.filter((r) => r.reason === 'job_hold').length;
      const refunds = rows.filter((r) => r.reason === 'job_refund').length;
      assert.ok(refunds >= holds, `mỗi khoản giữ phải có dòng hoàn (hold=${holds}, refund=${refunds})`);
    } finally {
      await ctx.close();
    }
  });
});

describe('PB-02 — chu kỳ tiền theo LƯỢT CHẠY', () => {
  test('tầng dịch vụ: mỗi lượt chạy mở hold RIÊNG, settle theo run_key; trần lượt chạy ⇒ RERUN_LIMIT_EXCEEDED', async () => {
    const config = unitConfig({ BILLING_MAX_RUNS_PER_JOB: '2' });
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    const userId = 'u-pb02';
    await svc.grant({ userId, amount: 10 });

    const h1 = await svc.holdForJob({ userId, jobId: 'job-1', estimate: 1 });
    assert.equal(h1.run_key, 'job-1#1');
    const again = await svc.holdForJob({ userId, jobId: 'job-1', estimate: 1 });
    assert.equal(again.run_key, 'job-1#1', 'gọi lại CÙNG lượt ⇒ không mở hold mới (idempotent theo run)');
    await svc.settleForJob({ userId, jobId: 'job-1', actualCost: 0.4 });

    const h2 = await svc.holdForJob({ userId, jobId: 'job-1', estimate: 1 });
    assert.equal(h2.run_key, 'job-1#2', 'lượt chạy lại phải mở hold MỚI (trước đây miễn phí)');
    await svc.settleForJob({ userId, jobId: 'job-1', actualCost: 0.4 });

    await assert.rejects(
      () => svc.holdForJob({ userId, jobId: 'job-1', estimate: 1, maxRunsPerJob: 2 }),
      (err) => err.code === 'RERUN_LIMIT_EXCEEDED',
      'vượt trần lượt chạy ⇒ RERUN_LIMIT_EXCEEDED',
    );
    // Số dư: 10 − 0.4 − 0.4 = 9.2 (HAI lượt đều bị thu — không còn lượt miễn phí).
    const balance = await store.ledgerBalance(userId);
    assert.ok(Math.abs(balance - 9.2) < 1e-9, `số dư phải là 9.2, nhận ${balance}`);
    await store.close();
  });

  test('HTTP: vượt trần lượt chạy ⇒ 429 RERUN_LIMIT_EXCEEDED (không phải 5xx)', async () => {
    const ctx = await startMvp05App({ configOverrides: { BILLING_MAX_RUNS_PER_JOB: '1' } });
    try {
      const jar = newJar();
      const reg = await register(ctx.base, { email: 'pb02@example.com', jar });
      const userId = reg.body.user.id;
      await ctx.app.billingService.grant({ userId, amount: 5, reason: 'admin_grant', actorId: 'test' });

      const created = await request(ctx.base, '/api/jobs', { method: 'POST', jar, body: { manual: { title: 'job PB-02' } } });
      assert.equal(created.status, 202);
      const jobId = (await j(created)).job_id;

      // Chờ LƯỢT CHẠY #1 khép lại (settle) — lúc đó trần `maxRunsPerJob = 1` đã dùng hết, nên
      // lượt chạy lại phải bị chặn 429 (nếu lượt #1 còn đang chạy thì hook coi là CÙNG lượt).
      for (let i = 0; i < 200; i += 1) {
        const st = await j(await request(ctx.base, `/api/jobs/${jobId}`, { jar }));
        if (st?.status && !['queued', 'running'].includes(st.status)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const rerun = await request(ctx.base, `/api/jobs/${jobId}/regenerate`, { method: 'POST', jar, body: {} });
      assert.equal(rerun.status, 429, `phải là 429, nhận ${rerun.status}`);
      assert.equal((await j(rerun)).error.code, 'RERUN_LIMIT_EXCEEDED');
    } finally {
      await ctx.close();
    }
  });
});

describe('PB-03 — bootstrap owner đầu tiên', () => {
  test('chưa có owner + có email ⇒ TẠO owner, mật khẩu tạm trả ĐÚNG MỘT LẦN; lần hai idempotent', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const accounts = createAccountService(config, { store, logger: silent });

    const first = await accounts.bootstrapOwner({ email: 'owner@example.com' });
    assert.equal(first.created, true);
    assert.equal(first.user.role, 'owner');
    assert.ok(typeof first.password === 'string' && first.password.length >= 10, 'phải trả mật khẩu tạm');

    const second = await accounts.bootstrapOwner({ email: 'khac@example.com' });
    assert.equal(second.created, false, 'đã có owner ⇒ KHÔNG tạo thêm, KHÔNG hạ cấp ai');

    const none = await accounts.bootstrapOwner({ email: '' });
    assert.equal(none.reason, undefined, 'đã có owner thì không cần email');
    await store.close();
  });

  test('chưa có owner + KHÔNG có email ⇒ reason NO_OWNER_EMAIL (để tầng boot ghi WARN)', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const accounts = createAccountService(config, { store, logger: silent });
    const res = await accounts.bootstrapOwner({ email: '' });
    assert.equal(res.created, false);
    assert.equal(res.reason, 'NO_OWNER_EMAIL');
    await store.close();
  });

  test('owner bootstrap ĐĂNG NHẬP ĐƯỢC bằng mật khẩu tạm và gọi được /api/admin/users', async () => {
    const ctx = await startMvp05App();
    try {
      const accounts = ctx.app.accountService;
      assert.ok(accounts && typeof accounts.bootstrapOwner === 'function', 'app phải có accountService');
      const boot = await accounts.bootstrapOwner({ email: 'boot@example.com' });
      assert.equal(boot.created, true);
      const logged = await login(ctx.base, { email: 'boot@example.com', password: boot.password });
      assert.equal(logged.res.status, 200, 'owner bootstrap phải đăng nhập được bằng mật khẩu tạm');
      const res = await request(ctx.base, '/api/admin/users', { jar: logged.jar });
      assert.equal(res.status, 200, 'owner phải gọi được route quản trị');
    } finally {
      await ctx.close();
    }
  });
});

describe('PB-04 — refundForJob không bao giờ hoàn phần đã tiêu', () => {
  test('settle rồi refund ⇒ KHÔNG ghi thêm dòng, số dư giữ nguyên', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    const userId = 'u-pb04';
    await svc.grant({ userId, amount: 1 });

    const hold = await svc.holdForJob({ userId, jobId: 'job-x', estimate: 0.5 });
    await svc.settleForJob({ userId, jobId: 'job-x', actualCost: 0.1 });
    const afterSettle = await store.ledgerBalance(userId);
    assert.ok(Math.abs(afterSettle - 0.9) < 1e-9, `sau settle phải là 0.9, nhận ${afterSettle}`);

    const refund = await svc.refundForJob({ userId, jobId: 'job-x', runKey: hold.run_key });
    assert.equal(refund?.reason, 'job_settle', 'đã settle ⇒ trả dòng cũ, KHÔNG ghi job_refund');
    const afterRefund = await store.ledgerBalance(userId);
    assert.equal(afterRefund, afterSettle, 'refund sau settle KHÔNG được tạo tiền');
    const rows = await ledgerRows(store, userId);
    assert.equal(rows.filter((r) => r.reason === 'job_refund').length, 0);
    await store.close();
  });

  test('DB có unique index cho (user_id, job_id, run_key, reason) — chặn ghi trùng ở tầng dữ liệu', async () => {
    const config = unitConfig();
    const store = await createStore(config, silent);
    await store.init?.();
    const userId = 'u-pb04b';
    // Mở ví trước bằng dòng KHÔNG gắn job (nếu không chính nó đã chiếm khoá unique).
    await store.appendLedger({ userId, amount: 1, reason: 'admin_grant', balanceAfter: 1 });
    const payload = {
      userId,
      amount: -0.5,
      reason: 'job_hold',
      jobId: 'job-y',
      runKey: 'job-y#1',
      balanceAfter: 0.5,
    };
    await store.appendLedger(payload);
    // F4 (R1 vòng sửa phản biện): DB KHÔNG còn để câu INSERT làm ABORT transaction — nó ghi kiểu
    // `ON CONFLICT DO NOTHING`/`OR IGNORE` rồi tầng store ném `LEDGER_CONFLICT` (lỗi nghiệp vụ,
    // transaction vẫn dùng được để ĐỌC LẠI dòng đã có). Vẫn đúng luật "không ghi trùng".
    await assert.rejects(
      () => store.appendLedger(payload),
      (err) => err?.code === 'LEDGER_CONFLICT' || /UNIQUE|constraint/i.test(String(err?.message || err)),
      'ghi trùng (user, job, run_key, reason) phải bị chặn',
    );
    await store.close();
  });
});

describe('PB-05 — hai khoá cấu hình phải có tác dụng THẬT', () => {
  test('BILLING_DEFAULT_GRANT ⇒ đăng ký xong ví có đúng số đó + một dòng sổ reason=grant', async () => {
    const ctx = await startMvp05App({ configOverrides: { BILLING_DEFAULT_GRANT: '5' } });
    try {
      const reg = await register(ctx.base, { email: 'grant@example.com' });
      const body = reg.body;
      assert.equal(body.credit_granted?.amount, 5, 'response phải nói rõ đã tặng bao nhiêu');
      const meRes = await j(await me(ctx.base, reg.jar));
      assert.equal(meRes.balance.amount, 5, 'ví phải có đúng 5 credit (trước đây là 0)');
      const rows = await ledgerRows(ctx.store, body.user.id);
      assert.equal(rows.filter((r) => r.reason === 'grant').length, 1, 'phải có dòng sổ grant để đối soát');
    } finally {
      await ctx.close();
    }
  });

  test('BILLING_HOLD_BEFORE_JOB=false ⇒ KHÔNG giữ tiền trước, KHÔNG 402, nhưng vẫn thu theo usage sau khi chạy', async () => {
    const ctx = await startMvp05App({
      configOverrides: { BILLING_HOLD_BEFORE_JOB: 'false', BILLING_DEFAULT_GRANT: '0' },
    });
    try {
      const reg = await register(ctx.base, { email: 'holdoff@example.com' });
      const userId = reg.body.user.id;
      const cfg = await j(await request(ctx.base, '/api/config'));
      assert.equal(cfg.billing.hold_before_job, false, '/api/config phải nói thật là đang KHÔNG giữ trước');

      // Ví 0 credit: nếu còn giữ tiền trước thì sẽ 402. Với holdBeforeJob=false ⇒ phải nhận job.
      const created = await request(ctx.base, '/api/jobs', { method: 'POST', jar: reg.jar, body: { manual: { title: 'ví 0' } } });
      assert.equal(created.status, 202, `không được 402 khi đã tắt giữ-tiền-trước (nhận ${created.status})`);
      const rows = await ledgerRows(ctx.store, userId);
      assert.equal(rows.filter((r) => r.reason === 'job_hold').length, 0, 'không được giữ tiền trước');
    } finally {
      await ctx.close();
    }
  });
});

describe('PB-06 — grant số cực lớn ⇒ 400 và KHÔNG ghi sổ', () => {
  test('tầng dịch vụ: 1e308 ⇒ INVALID_AMOUNT, vượt trần ⇒ AMOUNT_TOO_LARGE', async () => {
    const config = unitConfig({ BILLING_MAX_AMOUNT: '1000' });
    const store = await createStore(config, silent);
    await store.init?.();
    const svc = createBillingService(config, { store });
    await assert.rejects(() => svc.grant({ userId: 'u-pb06', amount: 1e308 }), (err) => err.code === 'INVALID_AMOUNT');
    await assert.rejects(() => svc.grant({ userId: 'u-pb06', amount: 5000 }), (err) => err.code === 'AMOUNT_TOO_LARGE');
    const rows = await ledgerRows(store, 'u-pb06');
    assert.equal(rows.length, 0, 'PB-06: bị từ chối thì sổ KHÔNG được thêm dòng nào');
    await store.close();
  });

  test('HTTP: POST /api/admin/users/:id/credit amount=1e308 ⇒ 400 (trước đây 201)', async () => {
    const ctx = await startMvp05App();
    try {
      const ownerJar = newJar();
      const ownerReg = await register(ctx.base, { email: 'pb06-owner@example.com', jar: ownerJar });
      const ownerId = ownerReg.body.user.id;
      await ctx.store.updateUser(ownerId, { role: 'owner' });
      const target = (await register(ctx.base, { email: 'pb06-target@example.com' })).body;

      const res = await request(ctx.base, `/api/admin/users/${target.user.id}/credit`, {
        method: 'POST',
        jar: ownerJar,
        body: { amount: 1e308 },
      });
      assert.equal(res.status, 400, `phải là 400, nhận ${res.status}`);
      assert.equal((await j(res)).error.code, 'INVALID_AMOUNT');
      const rows = await ledgerRows(ctx.store, target.user.id);
      assert.equal(rows.length, 0, 'sổ không được có dòng amount = 0');
    } finally {
      await ctx.close();
    }
  });
});

describe('PB-07 — credit số âm = điều chỉnh giảm', () => {
  test('số âm ⇒ reason adjustment, số dư giảm; giảm quá số dư ⇒ 400 INSUFFICIENT_CREDIT', async () => {
    const ctx = await startMvp05App();
    try {
      const ownerJar = newJar();
      const ownerReg = await register(ctx.base, { email: 'pb07-owner@example.com', jar: ownerJar });
      await ctx.store.updateUser(ownerReg.body.user.id, { role: 'owner' });
      const target = (await register(ctx.base, { email: 'pb07-target@example.com' })).body;
      await ctx.app.billingService.grant({ userId: target.user.id, amount: 2, reason: 'admin_grant', actorId: 'x' });

      const minus = await request(ctx.base, `/api/admin/users/${target.user.id}/credit`, {
        method: 'POST',
        jar: ownerJar,
        body: { amount: -0.5, note: 'giảm tay' },
      });
      assert.equal(minus.status, 201, `số âm phải được nhận, nhận ${minus.status}`);
      const body = await j(minus);
      assert.equal(body.ledger.reason, 'adjustment');
      assert.equal(body.balance.amount, 1.5);

      const tooMuch = await request(ctx.base, `/api/admin/users/${target.user.id}/credit`, {
        method: 'POST',
        jar: ownerJar,
        body: { amount: -99 },
      });
      assert.equal(tooMuch.status, 400);
      assert.equal((await j(tooMuch)).error.code, 'INSUFFICIENT_CREDIT');

      const zero = await request(ctx.base, `/api/admin/users/${target.user.id}/credit`, {
        method: 'POST',
        jar: ownerJar,
        body: { amount: 0 },
      });
      assert.equal(zero.status, 400, 'amount = 0 vẫn là 400');
    } finally {
      await ctx.close();
    }
  });
});

describe('PB-08 — chống brute-force đăng nhập', () => {
  test('10 lần SAI ⇒ 429 + Retry-After; đăng nhập ĐÚNG sau đó vẫn 200; email khác không bị ảnh hưởng', async () => {
    const ctx = await startMvp05App();
    try {
      await register(ctx.base, { email: 'pb08@example.com', password: PASSWORD });
      const other = await register(ctx.base, { email: 'pb08-khac@example.com', password: PASSWORD });

      let firstBlocked = null;
      for (let i = 1; i <= 12; i += 1) {
        const res = await request(ctx.base, '/api/auth/login', {
          method: 'POST',
          body: { email: 'pb08@example.com', password: 'sai-mat-khau-123' },
        });
        if (res.status === 429 && firstBlocked === null) firstBlocked = { attempt: i, retryAfter: res.headers?.get?.('retry-after') ?? null };
      }
      assert.ok(firstBlocked, 'phải có 429 sau nhiều lần sai');
      assert.ok(firstBlocked.attempt <= 12, `429 phải xuất hiện trong 12 lần (nhận ở lần ${firstBlocked.attempt})`);
      assert.ok(Number(firstBlocked.retryAfter) > 0, `429 phải kèm Retry-After, nhận ${JSON.stringify(firstBlocked.retryAfter)}`);

      const ok = await request(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'pb08@example.com', password: PASSWORD } });
      assert.equal(ok.status, 200, 'PB-08: đăng nhập ĐÚNG không bị chặn bởi bộ đếm lần sai của chính mình');

      const clean = await request(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'pb08-khac@example.com', password: 'sai-mat-khau-123' } });
      assert.equal(clean.status, 401, 'bucket theo (email, IP): email khác phải là 401, không 429');
      assert.equal(other.res.status, 201);
    } finally {
      await ctx.close();
    }
  });
});
