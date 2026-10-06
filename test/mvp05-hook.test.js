/**
 * TEST MVP-05 · §3.4b — Hook giữ tiền `app.billingHook.beforeJob/afterJob`.
 *
 * Hook được lấy từ APP THẬT (`createApp` tự nạp `src/accounts/**` + `src/billing/**`),
 * nên mọi khẳng định ở đây đúng với object mà `src/http/routes.js` gọi trong request:
 * ẩn danh ⇒ không ghi sổ; thiếu tiền ⇒ NÉM `INSUFFICIENT_CREDIT` (fail-closed); idempotent
 * theo `jobId`; `billingService === null` ⇒ hook vẫn tồn tại và job vẫn chạy.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startMvp05App, register, request, j, waitJob, countRows, ledgerRows, reasonCount, newJar, PASSWORD } from './mvp05-helpers.js';

const jobId = () => `job-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

describe('MVP-05 · §3.4b — hook giữ tiền (app thật, billing bật)', () => {
  let ctx;
  let userId;

  before(async () => {
    ctx = await startMvp05App();
    const reg = await register(ctx.base, { email: 'hook-user@example.com', password: PASSWORD });
    assert.equal(reg.res.status, 201);
    userId = reg.body.user.id;
  });
  after(async () => {
    await ctx.close();
  });

  test('app.billingHook là OBJECT HẰNG có beforeJob/afterJob; service thật đã nạp', async () => {
    assert.equal(typeof ctx.app.billingHook, 'object');
    assert.equal(typeof ctx.app.billingHook.beforeJob, 'function');
    assert.equal(typeof ctx.app.billingHook.afterJob, 'function');
    assert.ok(ctx.app.billingService, 'wiring MVP-05 phải nạp được billingService thật');
    assert.ok(ctx.app.accountService, 'wiring MVP-05 phải nạp được accountService thật');
  });

  test('ẩn danh (userId null) ⇒ {held: 0, balance_after: null} và KHÔNG ghi dòng sổ nào', async () => {
    const before = await countRows(ctx.store, 'wallet_ledger');
    const out = await ctx.app.billingHook.beforeJob({ userId: null, jobId: jobId(), kind: 'content', sessionId: 'phien-an-danh' });
    assert.equal(out.held, 0);
    assert.equal(out.balance_after, null);
    assert.equal(await countRows(ctx.store, 'wallet_ledger'), before, 'ẩn danh KHÔNG có ví ⇒ không dòng sổ (§0 luật 1)');

    const empty = await ctx.app.billingHook.beforeJob({ jobId: jobId(), kind: 'content' });
    assert.equal(empty.held, 0);
    assert.equal(await countRows(ctx.store, 'wallet_ledger'), before);
  });

  test('beforeJob gọi 2 lần cùng jobId ⇒ ĐÚNG 1 dòng job_hold (idempotent theo dữ liệu)', async () => {
    await ctx.app.billingService.grant({ userId, amount: 1, reason: 'admin_grant', actorId: 'admin-test' });
    const id = jobId();
    const first = await ctx.app.billingHook.beforeJob({ userId, jobId: id, kind: 'content', sessionId: 's1' });
    assert.ok(first.held > 0, `phải giữ tiền cho job nội dung, nhận ${JSON.stringify(first)}`);
    assert.equal(await reasonCount(ctx.store, userId, 'job_hold'), 1);
    const balanceAfterHold = (await ctx.app.billingService.balance(userId)).amount;
    assert.equal(first.balance_after, balanceAfterHold);

    const second = await ctx.app.billingHook.beforeJob({ userId, jobId: id, kind: 'content', sessionId: 's1' });
    assert.equal(second.held, first.held, 'lần hai trả thông tin lần giữ CŨ');
    assert.equal(await reasonCount(ctx.store, userId, 'job_hold'), 1, 'gọi lại KHÔNG được giữ tiền lần hai');
    assert.equal((await ctx.app.billingService.balance(userId)).amount, balanceAfterHold, 'số dư không đổi');

    // Dọn: hoàn lại để các test sau có số dư xác định.
    await ctx.app.billingHook.afterJob({ userId, jobId: id, status: 'failed', actualCost: 0 });
    assert.equal((await ctx.app.billingService.balance(userId)).amount, 1);
  });

  test('thiếu tiền ⇒ NÉM INSUFFICIENT_CREDIT + details {required, balance, currency}, không ghi sổ', async () => {
    const poor = await register(ctx.base, { email: 'hook-poor@example.com', password: PASSWORD });
    assert.equal(poor.res.status, 201);
    assert.equal((await ctx.app.billingService.balance(poor.body.user.id)).amount, 0, 'đăng ký mặc định không tặng credit');
    const before = await countRows(ctx.store, 'wallet_ledger');

    const err = await ctx.app.billingHook
      .beforeJob({ userId: poor.body.user.id, jobId: jobId(), kind: 'content', sessionId: 's-poor' })
      .catch((e) => e);
    assert.ok(err, 'phải ném lỗi thiếu credit (fail-closed có chủ ý)');
    assert.equal(err.code, 'INSUFFICIENT_CREDIT');
    assert.ok(err.details, 'phải kèm details để route trả 402');
    assert.ok(Number(err.details.required) > 0, `details.required phải > 0, nhận ${err.details.required}`);
    assert.equal(err.details.balance, 0);
    assert.equal(err.details.currency, 'USD');
    assert.equal(await countRows(ctx.store, 'wallet_ledger'), before, 'thiếu tiền ⇒ không dòng sổ nào');
  });

  test("afterJob({status:'failed'}) ⇒ job_refund ĐÚNG bằng phần giữ; gọi lần 2 KHÔNG hoàn thêm", async () => {
    const id = jobId();
    /** Dòng sổ của ĐÚNG job này (người dùng đã có sổ từ các test trước). */
    const rowsOfJob = async () => (await ledgerRows(ctx.store, userId)).filter((row) => row.job_id === id);
    const countOfJob = async (reason) => (await rowsOfJob()).filter((row) => row.reason === reason).length;

    const balanceBefore = (await ctx.app.billingService.balance(userId)).amount;
    const held = await ctx.app.billingHook.beforeJob({ userId, jobId: id, kind: 'content', sessionId: 's2' });
    assert.equal((await ctx.app.billingService.balance(userId)).amount, balanceBefore - held.held);
    assert.equal(await countOfJob('job_hold'), 1);

    const out = await ctx.app.billingHook.afterJob({ userId, jobId: id, status: 'failed', actualCost: 0 });
    assert.equal(out.settled, false);
    assert.equal(out.refunded, held.held, 'hoàn ĐÚNG 100% phần đã giữ');
    assert.equal(await countOfJob('job_refund'), 1);
    assert.equal((await ctx.app.billingService.balance(userId)).amount, balanceBefore);

    const again = await ctx.app.billingHook.afterJob({ userId, jobId: id, status: 'failed', actualCost: 0 });
    assert.equal(again.refunded, 0);
    assert.equal(await countOfJob('job_refund'), 1, 'gọi lần hai KHÔNG hoàn thêm');
    assert.equal((await ctx.app.billingService.balance(userId)).amount, balanceBefore);

    // Sổ của job này: 1 hold + 1 refund, không có dòng nào khác (append-only, đối soát được).
    assert.deepEqual((await rowsOfJob()).map((row) => row.reason).sort(), ['job_hold', 'job_refund']);
  });

  test("afterJob(status khác 'failed') ⇒ quyết toán theo actualCost, hoàn phần GIỮ DƯ", async () => {
    const id = jobId();
    const balanceBefore = (await ctx.app.billingService.balance(userId)).amount;
    const held = await ctx.app.billingHook.beforeJob({ userId, jobId: id, kind: 'content', sessionId: 's3' });
    const actual = held.held / 2;
    const out = await ctx.app.billingHook.afterJob({ userId, jobId: id, status: 'succeeded', actualCost: actual });
    assert.equal(out.settled, true);
    assert.equal(out.refunded, held.held - actual, 'hoàn phần giữ dư');
    assert.equal(await reasonCount(ctx.store, userId, 'job_settle'), 1);
    assert.equal((await ctx.app.billingService.balance(userId)).amount, balanceBefore - actual);

    const again = await ctx.app.billingHook.afterJob({ userId, jobId: id, status: 'succeeded', actualCost: actual });
    assert.equal(again.refunded, 0, 'đã quyết toán ⇒ không hoàn thêm');
    assert.equal(await reasonCount(ctx.store, userId, 'job_settle'), 1);
    assert.equal((await ctx.app.billingService.balance(userId)).amount, balanceBefore - actual);
  });

  test('beforeJob ẩn danh rồi afterJob ẩn danh: không ném, không ghi sổ', async () => {
    const before = await countRows(ctx.store, 'wallet_ledger');
    const id = jobId();
    await ctx.app.billingHook.beforeJob({ userId: null, jobId: id, kind: 'image_translation', sessionId: 's4' });
    const out = await ctx.app.billingHook.afterJob({ userId: null, jobId: id, status: 'failed', actualCost: 0 });
    assert.deepEqual(out, { settled: false, refunded: 0 });
    assert.equal(await countRows(ctx.store, 'wallet_ledger'), before);
    // Hook vẫn phải sống sau mọi lần gọi — không nuốt lỗi thành trạng thái hỏng.
    assert.equal(typeof ctx.app.billingHook.beforeJob, 'function');
  });
});

describe('MVP-05 · §3.4b — billingService null: hook vẫn tồn tại, job vẫn chạy', () => {
  let ctx;
  before(async () => {
    // BILLING_ENABLED=false ⇒ wiring đặt `billingService = null` (đúng đường thật của src/app.js).
    ctx = await startMvp05App({ configOverrides: { BILLING_ENABLED: 'false' } });
  });
  after(async () => {
    await ctx.close();
  });

  test('billingService === null, hook vẫn là object; gọi vào KHÔNG ném', async () => {
    assert.equal(ctx.app.billingService, null, 'ví tắt ⇒ billingService null');
    assert.ok(ctx.app.billingUnavailableReason, 'phải có lý do THẬT (không im lặng)');
    assert.equal(typeof ctx.app.billingHook, 'object');
    assert.equal(typeof ctx.app.billingHook.beforeJob, 'function');
    assert.equal(typeof ctx.app.billingHook.afterJob, 'function');

    const before = await ctx.app.billingHook.beforeJob({ userId: 'ai-do-nhung-khong-co-vi', jobId: jobId(), kind: 'content' });
    assert.equal(before.held, 0);
    const after = await ctx.app.billingHook.afterJob({ userId: 'ai-do-nhung-khong-co-vi', jobId: jobId(), status: 'failed', actualCost: 0 });
    assert.deepEqual(after, { settled: false, refunded: 0 });
  });

  test('job của người đã đăng nhập VẪN chạy bình thường khi ví tắt; không ai bị chặn', async () => {
    const jar = newJar();
    const reg = await register(ctx.base, { email: 'khong-vi@example.com', password: PASSWORD, jar });
    assert.equal(reg.res.status, 201);
    const userId = reg.body.user.id;

    const res = await request(ctx.base, '/api/jobs', {
      method: 'POST',
      jar,
      body: { manual: { title: 'Sản phẩm chạy khi ví tắt', notes: 'ghi chú kiểm thử' } },
    });
    assert.equal(res.status, 202, 'ví tắt KHÔNG được chặn job');
    const { job_id: id } = await j(res);
    const done = await waitJob(ctx.base, id, { jar });
    assert.equal(done.status, 'succeeded', 'job phải chạy xong bình thường');
    assert.equal(await countRows(ctx.store, 'wallet_ledger'), 0, 'ví tắt ⇒ không dòng sổ nào');
    assert.equal(await countRows(ctx.store, 'jobs'), 1);
    assert.ok(userId);
  });
});
