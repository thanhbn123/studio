/**
 * TEST MVP-05 · A2 — Sổ credit APPEND-ONLY (`src/billing/**`) trên STORE THẬT.
 *
 * Luật #2 của hợp đồng §0 được kiểm bằng DỮ LIỆU: sau mỗi thao tác, số dư đọc từ sổ
 * (`store.ledgerBalance`) phải bằng tổng các dòng sổ, và không đường nào — kể cả gọi
 * thẳng `store.appendLedger` — được để số dư âm.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createStore, USAGE_OPERATIONS, DEFAULT_PRICING } from '../src/store/index.js';
import { BillingService, BillingError, createBillingService, LEDGER_REASONS } from '../src/billing/index.js';
import { MONEY_DECIMALS, roundMoney } from '../src/billing/money.js';
import { testConfig, silent, ledgerRows, ledgerSum, reasonCount, countRows } from './mvp05-helpers.js';

async function makeBilling(configOverrides = {}) {
  const config = testConfig(configOverrides);
  const store = await createStore(config, silent);
  const billing = createBillingService(config, { store, logger: silent });
  return { config, store, billing };
}

const newUser = () => `user-${randomUUID()}`;

/** Bất biến trung tâm: số dư = TỔNG SỔ, `balance_after` dòng cuối = số dư, không âm. */
async function assertLedgerInvariant(store, userId, { expectBalance } = {}) {
  const rows = await ledgerRows(store, userId);
  const sum = roundMoney(rows.reduce((acc, row) => acc + row.amount, 0));
  assert.equal(await ledgerSum(store, userId), sum, 'tổng sổ đọc qua helper phải khớp');
  const fromStore = await store.ledgerBalance(userId);
  assert.equal(fromStore, sum, 'số dư store phải bằng tổng sổ');
  assert.ok(sum >= 0, `số dư KHÔNG BAO GIỜ âm, nhận ${sum}`);
  if (rows.length > 0) {
    const last = rows[0]; // listLedger trả mới nhất trước
    assert.equal(last.balance_after, sum, 'balance_after dòng mới nhất phải bằng tổng sổ');
  }
  if (expectBalance !== undefined) assert.equal(sum, expectBalance);
  return { rows, sum };
}

describe('MVP-05 · A2 — bất biến sổ credit (append-only, không âm)', () => {
  let ctx;
  let userId;
  before(async () => {
    ctx = await makeBilling();
  });
  after(async () => {
    await ctx.store.close();
  });
  beforeEach(() => {
    userId = newUser();
  });

  test('chuỗi grant → hold → settle → refund: số dư = TỔNG SỔ ở MỌI bước', async () => {
    const { store, billing } = ctx;
    const jobId = `job-${randomUUID()}`;

    const grant = await billing.grant({ userId, amount: 10, reason: 'admin_grant', actorId: 'admin-1', note: 'cấp thử' });
    assert.equal(grant.reason, 'admin_grant');
    assert.equal(grant.amount, 10);
    assert.equal(grant.balance_after, 10);
    assert.equal((await billing.balance(userId)).amount, 10);
    await assertLedgerInvariant(store, userId, { expectBalance: 10 });

    const hold = await billing.holdForJob({ userId, jobId, estimate: 0.5, operations: ['CONTENT_GENERATE'] });
    assert.equal(hold.balance_after, 9.5);
    await assertLedgerInvariant(store, userId, { expectBalance: 9.5 });
    const holdRow = (await ledgerRows(store, userId)).find((row) => row.reason === 'job_hold');
    assert.equal(holdRow.amount, -0.5, 'giữ tiền = dòng ÂM');
    assert.equal(holdRow.job_id, jobId);
    assert.equal(holdRow.operation, 'CONTENT_GENERATE');
    assert.equal(hold.ledgerId, holdRow.id);

    const settle = await billing.settleForJob({ userId, jobId, actualCost: 0.3 });
    assert.equal(settle.reason, 'job_settle');
    assert.equal(settle.amount, 0.2, 'quyết toán hoàn phần chênh 0.5 − 0.3');
    await assertLedgerInvariant(store, userId, { expectBalance: 9.7 });

    // Job đã settle ⇒ không còn gì để hoàn: refund KHÔNG được hoàn quá phần đã giữ.
    const refundAfterSettle = await billing.refundForJob({ userId, jobId, reason: 'JOB_FAILED' });
    if (refundAfterSettle) {
      await assertLedgerInvariant(store, userId);
      const rows = await ledgerRows(store, userId);
      const held = -rows.filter((r) => r.reason === 'job_hold').reduce((a, r) => a + r.amount, 0);
      const refunded = rows.filter((r) => r.reason === 'job_refund').reduce((a, r) => a + r.amount, 0);
      assert.ok(refunded <= held + 1e-9, `tổng hoàn (${refunded}) không được vượt tổng giữ (${held})`);
    }

    // Job thứ hai: giữ rồi hoàn 100%.
    const job2 = `job-${randomUUID()}`;
    const balanceBefore = (await billing.balance(userId)).amount;
    const hold2 = await billing.holdForJob({ userId, jobId: job2, estimate: { total: 1, lines: [{ operation: 'TRANSLATION', count: 1 }] } });
    assert.equal(hold2.balance_after, roundMoney(balanceBefore - 1));
    const refund = await billing.refundForJob({ userId, jobId: job2, reason: 'JOB_FAILED' });
    assert.equal(refund.reason, 'job_refund');
    assert.equal(refund.amount, 1, 'hoàn ĐÚNG 100% phần đã giữ');
    assert.equal(refund.meta.reason, 'JOB_FAILED');
    assert.equal((await billing.balance(userId)).amount, balanceBefore);
    await assertLedgerInvariant(store, userId, { expectBalance: balanceBefore });

    // Mọi dòng sổ đều có reason hợp lệ + created_at + id (append-only, đối soát được).
    for (const row of await ledgerRows(store, userId)) {
      assert.ok(LEDGER_REASONS.includes(row.reason), `reason lạ: ${row.reason}`);
      assert.ok(row.id && row.created_at);
      assert.equal(typeof row.balance_after, 'number');
    }
  });

  test('holdForJob vượt số dư ⇒ INSUFFICIENT_CREDIT và sổ KHÔNG thêm dòng nào', async () => {
    const { store, billing } = ctx;
    await billing.grant({ userId, amount: 0.4, reason: 'grant' });
    const before = await countRows(store, 'wallet_ledger');
    const err = await billing.holdForJob({ userId, jobId: `job-${randomUUID()}`, estimate: 0.5 }).catch((e) => e);
    assert.ok(err instanceof BillingError, 'phải là BillingError để route map sang 402');
    assert.equal(err.code, 'INSUFFICIENT_CREDIT');
    assert.equal(err.details.required, 0.5);
    assert.equal(err.details.balance, 0.4);
    assert.equal(err.details.currency, 'USD');
    assert.equal(await countRows(store, 'wallet_ledger'), before, 'thiếu tiền ⇒ KHÔNG ghi dòng nào');
    await assertLedgerInvariant(store, userId, { expectBalance: 0.4 });
  });

  test('settleForJob / refundForJob gọi 2–3 lần ⇒ ĐÚNG 1 dòng (idempotent theo jobId)', async () => {
    const { store, billing } = ctx;
    await billing.grant({ userId, amount: 5, reason: 'admin_grant' });

    const jobA = `job-${randomUUID()}`;
    await billing.holdForJob({ userId, jobId: jobA, estimate: 1 });
    const s1 = await billing.settleForJob({ userId, jobId: jobA, actualCost: 0.25 });
    const s2 = await billing.settleForJob({ userId, jobId: jobA, actualCost: 0.25 });
    const s3 = await billing.settleForJob({ userId, jobId: jobA, actualCost: 0.25 });
    assert.equal(await reasonCount(store, userId, 'job_settle'), 1, 'settle 3 lần vẫn chỉ 1 dòng');
    assert.equal(s2.id, s1.id);
    assert.equal(s3.amount, s1.amount);
    assert.equal(s1.amount, 0.75);
    await assertLedgerInvariant(store, userId, { expectBalance: 4.75 });

    const jobB = `job-${randomUUID()}`;
    await billing.holdForJob({ userId, jobId: jobB, estimate: 2 });
    const r1 = await billing.refundForJob({ userId, jobId: jobB, reason: 'JOB_FAILED' });
    const r2 = await billing.refundForJob({ userId, jobId: jobB, reason: 'JOB_FAILED' });
    const r3 = await billing.refundForJob({ userId, jobId: jobB, reason: 'JOB_FAILED' });
    assert.equal(await reasonCount(store, userId, 'job_refund'), 1, 'refund 3 lần vẫn chỉ 1 dòng');
    assert.equal(r1.amount, 2);
    assert.equal(r2.amount, r1.amount, 'gọi lại trả dòng CŨ, không hoàn thêm');
    assert.equal(r3.id, r1.id);
    await assertLedgerInvariant(store, userId, { expectBalance: 4.75 });
  });

  test('refundForJob không hoàn quá phần đã giữ; job không có hold ⇒ không ghi gì', async () => {
    const { store, billing } = ctx;
    await billing.grant({ userId, amount: 3, reason: 'admin_grant' });

    const job = `job-${randomUUID()}`;
    await billing.holdForJob({ userId, jobId: job, estimate: 1.5 });
    const refund = await billing.refundForJob({ userId, jobId: job, reason: 'JOB_FAILED' });
    assert.equal(refund.amount, 1.5);
    const again = await billing.refundForJob({ userId, jobId: job, reason: 'JOB_FAILED' });
    assert.equal(again.amount, 1.5, 'lần hai trả dòng cũ, KHÔNG cộng dồn');
    assert.equal(await reasonCount(store, userId, 'job_refund'), 1);

    const before = await countRows(store, 'wallet_ledger');
    const noHold = await billing.refundForJob({ userId, jobId: `job-${randomUUID()}`, reason: 'JOB_FAILED' });
    assert.equal(noHold, null, 'job chưa từng giữ tiền ⇒ không có gì để hoàn');
    assert.equal(await countRows(store, 'wallet_ledger'), before);
    await assertLedgerInvariant(store, userId, { expectBalance: 3 });
  });

  test('KHÔNG BAO GIỜ số dư âm — thử MỌI đường (hold lớn, settle > giữ, refund 2 lần, ghi sổ thẳng)', async () => {
    const { store, billing } = ctx;
    await billing.grant({ userId, amount: 1, reason: 'admin_grant' });

    // (a) hold lớn hơn số dư
    const err = await billing.holdForJob({ userId, jobId: `job-${randomUUID()}`, estimate: 99 }).catch((e) => e);
    assert.equal(err.code, 'INSUFFICIENT_CREDIT');

    // (b) settle với chi phí THẬT lớn hơn phần đã giữ, khi ví đã về 0
    const job = `job-${randomUUID()}`;
    await billing.holdForJob({ userId, jobId: job, estimate: 1 });
    assert.equal((await billing.balance(userId)).amount, 0);
    const settle = await billing.settleForJob({ userId, jobId: job, actualCost: 5 });
    assert.ok(settle === null || settle.amount === 0, 'ví 0 ⇒ chỉ ghi tối đa bằng số dư hiện có (0)');
    await assertLedgerInvariant(store, userId, { expectBalance: 0 });

    // (c) refund hai lần liên tiếp
    const job2 = `job-${randomUUID()}`;
    await billing.grant({ userId, amount: 2, reason: 'admin_grant' });
    await billing.holdForJob({ userId, jobId: job2, estimate: 2 });
    await billing.refundForJob({ userId, jobId: job2, reason: 'JOB_FAILED' });
    await billing.refundForJob({ userId, jobId: job2, reason: 'JOB_FAILED' });
    await assertLedgerInvariant(store, userId, { expectBalance: 2 });

    // (d) ghi sổ THẲNG bằng store, bỏ qua service
    const before = await countRows(store, 'wallet_ledger');
    const direct = await store
      .appendLedger({ userId, amount: -1000, reason: 'adjustment', balanceAfter: -1000 })
      .catch((e) => e);
    assert.equal(direct.code, 'INSUFFICIENT_CREDIT', 'chốt chặn tầng DB cũng phải từ chối');
    assert.equal(await countRows(store, 'wallet_ledger'), before, 'transaction phải rollback, không ghi dòng âm');
    await assertLedgerInvariant(store, userId, { expectBalance: 2 });

    // (e) grant số âm quá số dư
    const drain = await billing.grant({ userId, amount: -5, reason: 'adjustment' }).catch((e) => e);
    assert.equal(drain.code, 'INSUFFICIENT_CREDIT');
    await assertLedgerInvariant(store, userId, { expectBalance: 2 });
  });

  test('tiền LÀM TRÒN 6 chữ số — không có 0.30000000000000004 trong DB hay API', async () => {
    const { store, billing } = ctx;
    await billing.grant({ userId, amount: 0.1, reason: 'grant' });
    await billing.grant({ userId, amount: 0.2, reason: 'grant' });
    assert.equal((await billing.balance(userId)).amount, 0.3, '0.1 + 0.2 phải là ĐÚNG 0.3');
    await assertLedgerInvariant(store, userId, { expectBalance: 0.3 });

    // estimate mang nhiễu float (0.1 + 0.2) ⇒ dòng giữ tiền vẫn phải là -0.3
    const job = `job-${randomUUID()}`;
    await billing.holdForJob({ userId, jobId: job, estimate: 0.1 + 0.2 });
    const holdRow = (await ledgerRows(store, userId)).find((row) => row.reason === 'job_hold');
    assert.equal(holdRow.amount, -0.3, 'ước tính 0.30000000000000004 phải được ghi thành -0.3');
    assert.equal(holdRow.balance_after, 0);

    // settle với số nhiễu: phần chênh cũng phải tròn
    const settle = await billing.settleForJob({ userId, jobId: job, actualCost: 0.1 + 0.2 - 0.1 });
    assert.equal(settle.amount, 0.1);
    await assertLedgerInvariant(store, userId, { expectBalance: 0.1 });

    const rows = await ledgerRows(store, userId);
    for (const row of rows) {
      for (const value of [row.amount, row.balance_after]) {
        assert.equal(roundMoney(value), value, `${value} phải đã được làm tròn`);
        const decimals = String(value).split('.')[1] ?? '';
        assert.ok(decimals.length <= MONEY_DECIMALS, `${value} có quá ${MONEY_DECIMALS} chữ số thập phân`);
      }
    }
    assert.equal(JSON.stringify(rows).includes('0000000000000004'), false, 'không được có nhiễu float trong sổ');
  });
});

describe('MVP-05 · A2 — bảng giá & ước tính', () => {
  let ctx;
  before(async () => {
    ctx = await makeBilling();
  });
  after(async () => {
    await ctx.store.close();
  });

  test('seed pricing đủ MỌI USAGE_OPERATIONS — CONTENT_REPAIR PHẢI có giá', async () => {
    const pricing = await ctx.store.listPricing();
    assert.equal(pricing.length, USAGE_OPERATIONS.length, 'seed phải đủ mọi operation của hợp đồng §2.1');
    const byOp = new Map(pricing.map((row) => [row.operation, row]));
    for (const operation of USAGE_OPERATIONS) {
      const row = byOp.get(operation);
      assert.ok(row, `bảng pricing thiếu ${operation}`);
      assert.ok(row.unit_price > 0, `${operation} phải có giá > 0, nhận ${row.unit_price}`);
      // priceOf phải trả được giá cho MỌI operation (không ném UNKNOWN_OPERATION).
      const price = await ctx.billing.priceOf(operation);
      assert.equal(price.operation, operation);
      assert.equal(price.unit_price, row.unit_price);
      assert.equal(price.currency, 'USD');
    }
    const repair = await ctx.billing.priceOf('CONTENT_REPAIR');
    assert.equal(repair.unit_price, DEFAULT_PRICING.CONTENT_REPAIR);
    assert.ok(repair.unit_price > 0);
  });

  test('priceOf operation lạ ⇒ UNKNOWN_OPERATION (không bịa giá 0)', async () => {
    for (const bad of ['KHONG_CO_THAT', '', null, undefined, 42, {}]) {
      const err = await ctx.billing.priceOf(bad).catch((e) => e);
      assert.ok(err instanceof BillingError, `phải là BillingError với ${JSON.stringify(bad)}`);
      assert.equal(err.code, 'UNKNOWN_OPERATION');
    }
  });

  test('estimate: gộp theo operation, count và subtotal đúng số học', async () => {
    const out = await ctx.billing.estimate({
      userId: null, // ước tính KHÔNG chạm ví ⇒ chạy được cả cho ẩn danh
      operations: [{ operation: 'OCR_DETECT', count: 2 }, 'TRANSLATION', { operation: 'OCR_DETECT' }],
    });
    assert.equal(out.currency, 'USD');
    const lines = new Map(out.lines.map((line) => [line.operation, line]));
    assert.equal(lines.get('OCR_DETECT').count, 3, 'hai lần khai OCR_DETECT phải gộp lại');
    assert.equal(lines.get('OCR_DETECT').unit_price, 0.0004);
    assert.equal(lines.get('OCR_DETECT').subtotal, roundMoney(0.0004 * 3));
    assert.equal(lines.get('TRANSLATION').count, 1);
    assert.equal(out.total, roundMoney(0.0004 * 3 + 0.0008));
    assert.equal(out.lines.length, 2);

    const empty = await ctx.billing.estimate({ operations: [] });
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.lines, []);

    const bad = await ctx.billing.estimate({ operations: 'CONTENT_GENERATE' }).catch((e) => e);
    assert.equal(bad.code, 'INVALID_ARGUMENT');
  });
});

describe('MVP-05 · A2 — ẩn danh không có ví + validate tham số', () => {
  let ctx;
  before(async () => {
    ctx = await makeBilling();
  });
  after(async () => {
    await ctx.store.close();
  });

  test('mọi hàm ví với userId rỗng ⇒ ANONYMOUS_NO_WALLET (không chạm store)', async () => {
    const calls = [
      () => ctx.billing.balance(null),
      () => ctx.billing.balance(''),
      () => ctx.billing.grant({ userId: null, amount: 1 }),
      () => ctx.billing.holdForJob({ userId: '', jobId: 'j1', estimate: 1 }),
      () => ctx.billing.settleForJob({ userId: null, jobId: 'j1', actualCost: 0 }),
      () => ctx.billing.refundForJob({ userId: undefined, jobId: 'j1' }),
      () => ctx.billing.history({ userId: null }),
    ];
    for (const call of calls) {
      const err = await call().catch((e) => e);
      assert.ok(err instanceof BillingError, 'phải là BillingError');
      assert.equal(err.code, 'ANONYMOUS_NO_WALLET');
    }
  });

  test('thiếu jobId / grant 0 / reason lạ / groupBy lạ ⇒ lỗi có mã rõ ràng', async () => {
    const userId = newUser();
    await ctx.billing.grant({ userId, amount: 1, reason: 'grant' });

    const noJob = await ctx.billing.holdForJob({ userId, jobId: '', estimate: 1 }).catch((e) => e);
    assert.equal(noJob.code, 'INVALID_ARGUMENT');
    const noJob2 = await ctx.billing.refundForJob({ userId, jobId: '  ' }).catch((e) => e);
    assert.equal(noJob2.code, 'INVALID_ARGUMENT');

    const zero = await ctx.billing.grant({ userId, amount: 0 }).catch((e) => e);
    assert.equal(zero.code, 'INVALID_AMOUNT');
    const junk = await ctx.billing.grant({ userId, amount: 'khong-phai-so' }).catch((e) => e);
    assert.equal(junk.code, 'INVALID_AMOUNT');
    const badReason = await ctx.billing.grant({ userId, amount: 1, reason: 'job_hold' }).catch((e) => e);
    assert.equal(badReason.code, 'INVALID_REASON');

    const badGroup = await ctx.billing.usageSummary({ groupBy: 'thang' }).catch((e) => e);
    assert.equal(badGroup.code, 'INVALID_GROUP_BY');
    assert.deepEqual(badGroup.details.allowed, ['day', 'operation', 'user']);

    const negativeEstimate = await ctx.billing.holdForJob({ userId, jobId: 'j-neg', estimate: -5 }).catch((e) => e);
    assert.equal(negativeEstimate.code, 'INVALID_AMOUNT');
  });

  test('holdForJob với estimate 0 ⇒ job miễn phí: KHÔNG ghi dòng 0 nào', async () => {
    const userId = newUser();
    await ctx.billing.grant({ userId, amount: 1, reason: 'grant' });
    const before = await countRows(ctx.store, 'wallet_ledger');
    const out = await ctx.billing.holdForJob({ userId, jobId: 'job-free', estimate: 0 });
    assert.equal(out.ledgerId, null);
    assert.equal(out.balance_after, 1);
    assert.equal(await countRows(ctx.store, 'wallet_ledger'), before);
  });

  test('history: sổ mới nhất trước, phân trang limit/offset không trùng', async () => {
    const userId = newUser();
    for (let i = 0; i < 5; i += 1) await ctx.billing.grant({ userId, amount: 1, reason: 'grant' });
    const all = await ctx.billing.history({ userId, limit: 50 });
    assert.equal(all.length, 5);
    assert.equal(all[0].balance_after, 5, 'dòng mới nhất phải ở đầu');
    assert.equal(all[4].balance_after, 1);
    const page = await ctx.billing.history({ userId, limit: 2, offset: 1 });
    assert.equal(page.length, 2);
    assert.equal(page[0].id, all[1].id);
    assert.equal(page[1].id, all[2].id);
  });

  test('thiếu store ⇒ STORE_UNAVAILABLE (không phải TypeError)', async () => {
    const bare = new BillingService({ config: testConfig() });
    const err = await bare.balance(newUser()).catch((e) => e);
    assert.equal(err.code, 'STORE_UNAVAILABLE');
    // Không có store ⇒ KHÔNG có bảng giá, nhưng `config.cost` (MVP-01) vẫn là nguồn giá mặc định.
    const price = await bare.priceOf('CONTENT_GENERATE');
    assert.equal(price.unit_price, 0.004);
    const unknown = await bare.priceOf('KHONG_CO_THAT').catch((e) => e);
    assert.equal(unknown.code, 'UNKNOWN_OPERATION');
  });
});
