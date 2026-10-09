/**
 * VÍ CREDIT (MVP-05 · R1) — NGHIỆP VỤ THẬT TRÊN POSTGRESQL.
 *
 * Lỗ hổng file này bịt: `wallet_ledger`, `jobs.user_id`, cùng toàn bộ chu kỳ tiền
 * hold → settle → refund trước đây chỉ được chứng minh trên **SQLite in-memory**
 * (`test/mvp05-billing.test.js`, `test/r1-ledger-lock.test.js`). CI chạy PostgreSQL 16
 * nhưng chỉ dựng schema. Những thứ CHỈ sai trên PostgreSQL mà SQLite không bao giờ lộ:
 *
 *   · `REAL` của PostgreSQL là **float4 (4 byte)**, của SQLite là float8 ⇒ tiền mất chữ số;
 *   · `INSERT … ON CONFLICT DO NOTHING` vs `INSERT OR IGNORE`;
 *   · partial unique index (`uniq_wallet_ledger_run_close/_run_reason`);
 *   · `pg_advisory_xact_lock` thay cho `BEGIN IMMEDIATE`;
 *   · một `INSERT` vi phạm UNIQUE **abort cả transaction** (25P02) — SQLite thì không.
 *
 * Tự BỎ QUA khi thiếu `DATABASE_URL`. Mọi dòng tạo ra đều bị dọn theo `RUN_TAG`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/store/index.js';
import { createBillingService, BillingError } from '../src/billing/index.js';
import { roundMoney } from '../src/billing/money.js';
import {
  hasPg, skipNoPg, pgConfig, sqliteConfig, silent,
  newUserId, newJobId, purgeRunRows, ledgerRows, jsLedgerSum,
} from './pg-helpers.js';

describe('Ví credit trên PostgreSQL thật — sổ, idempotency, đua settle/refund', () => {
  let store;
  let billing;

  before(async () => {
    if (!hasPg) return;
    const config = pgConfig();
    store = await createStore(config, silent);
    assert.equal(store.dialect, 'postgres', 'phải thật sự chạy trên PostgreSQL');
    billing = createBillingService(config, { store, logger: silent });
  });

  after(async () => {
    if (!store) return;
    await purgeRunRows(store);
    await store.close();
  });

  /** Bất biến trung tâm (hợp đồng MVP-05 §0 luật #2): số dư = TỔNG SỔ, không bao giờ âm. */
  async function assertLedgerInvariant(userId, { expectBalance } = {}) {
    const rows = await ledgerRows(store, userId);
    const fromStore = await store.ledgerBalance(userId);
    const fromJs = await jsLedgerSum(store, userId);
    assert.equal(fromStore, fromJs, 'số dư store (SUM trong SQL) phải bằng tổng sổ tính ở JS');
    assert.ok(fromStore >= 0, `số dư KHÔNG BAO GIỜ âm, nhận ${fromStore}`);
    if (rows.length > 0) {
      assert.equal(rows[0].balance_after, fromStore, 'balance_after của dòng mới nhất phải bằng số dư');
    }
    if (expectBalance !== undefined) assert.equal(fromStore, expectBalance, 'số dư phải đúng như mong đợi');
    return { rows, balance: fromStore };
  }

  test('số dư = TỔNG SỔ qua cả chu kỳ grant → hold → settle', { skip: skipNoPg }, async () => {
    const userId = newUserId('cycle');
    const jobId = newJobId('cycle');

    await billing.grant({ userId, amount: 10, reason: 'admin_grant', actorId: 'admin-pg' });
    await assertLedgerInvariant(userId, { expectBalance: 10 });

    const hold = await billing.holdForJob({ userId, jobId, estimate: 0.5, operations: ['CONTENT_GENERATE'] });
    assert.equal(hold.balance_after, 9.5);
    assert.ok(hold.run_key, 'hold phải trả run_key — khoá chu kỳ tiền theo LƯỢT CHẠY');
    await assertLedgerInvariant(userId, { expectBalance: 9.5 });

    await billing.settleForJob({ userId, jobId, actualCost: 0.2, runKey: hold.run_key });
    // Giữ 0.5, chi thật 0.2 ⇒ hoàn 0.3 ⇒ còn 9.8.
    await assertLedgerInvariant(userId, { expectBalance: 9.8 });

    const rows = await ledgerRows(store, userId);
    const reasons = rows.map((r) => r.reason).sort();
    assert.deepEqual(reasons, ['admin_grant', 'job_hold', 'job_settle']);
    // `seq` phải TĂNG DẦN và DUY NHẤT trong phạm vi user (cấp trong cùng transaction với insert).
    const seqs = rows.map((r) => r.seq).sort((a, b) => a - b);
    assert.deepEqual(seqs, [1, 2, 3], 'seq phải là 1..n liên tục trên PostgreSQL');
  });

  test('số dư KHÔNG BAO GIỜ âm — appendLedger trực tiếp bị từ chối INSUFFICIENT_CREDIT', { skip: skipNoPg }, async () => {
    const userId = newUserId('neg');
    await store.appendLedger({ userId, amount: 1, reason: 'grant' });

    await assert.rejects(
      () => store.appendLedger({ userId, amount: -5, reason: 'adjustment' }),
      (err) => {
        assert.equal(err.code, 'INSUFFICIENT_CREDIT', 'phải là mã nghiệp vụ, không phải mã driver thô');
        return true;
      },
      'đường gọi TRỰC TIẾP cũng không được để sổ âm',
    );

    // Và KHÔNG được ghi dòng nào (fail-closed, transaction đã rollback).
    await assertLedgerInvariant(userId, { expectBalance: 1 });
    assert.equal((await ledgerRows(store, userId)).length, 1, 'lần ghi bị từ chối không được để lại dòng');
  });

  test('holdForJob thiếu credit ⇒ INSUFFICIENT_CREDIT và sổ không đổi', { skip: skipNoPg }, async () => {
    const userId = newUserId('poor');
    const jobId = newJobId('poor');
    await billing.grant({ userId, amount: 0.001, reason: 'grant' });

    await assert.rejects(
      () => billing.holdForJob({ userId, jobId, estimate: 5, operations: ['CONTENT_GENERATE'] }),
      (err) => {
        assert.ok(err instanceof BillingError);
        assert.equal(err.code, 'INSUFFICIENT_CREDIT');
        return true;
      },
    );
    await assertLedgerInvariant(userId, { expectBalance: 0.001 });
  });

  test('IDEMPOTENT theo (job_id, run_key): hold hai lần cùng lượt ⇒ MỘT dòng job_hold', { skip: skipNoPg }, async () => {
    const userId = newUserId('idem');
    const jobId = newJobId('idem');
    await billing.grant({ userId, amount: 5, reason: 'grant' });

    const first = await billing.holdForJob({ userId, jobId, estimate: 1, operations: ['CONTENT_GENERATE'] });
    const second = await billing.holdForJob({ userId, jobId, estimate: 1, operations: ['CONTENT_GENERATE'], runKey: first.run_key });
    assert.equal(second.run_key, first.run_key, 'gọi lại cùng lượt phải trả CHÍNH lượt đó');
    assert.equal(second.skipped, true, 'lần hai phải được nhận ra là đã giữ tiền');

    const holds = (await ledgerRows(store, userId)).filter((r) => r.reason === 'job_hold');
    assert.equal(holds.length, 1, 'KHÔNG được giữ tiền hai lần cho cùng (job_id, run_key)');
    await assertLedgerInvariant(userId, { expectBalance: 4 });
  });

  test('partial unique index chặn dòng job_hold thứ hai cho cùng lượt (ghi THÔ qua appendLedger)', { skip: skipNoPg }, async () => {
    const userId = newUserId('uniq');
    const jobId = newJobId('uniq');
    const runKey = `${jobId}#1`;
    await store.appendLedger({ userId, amount: 5, reason: 'grant' });
    await store.appendLedger({ userId, amount: -1, reason: 'job_hold', jobId, runKey });

    // Dòng thứ hai cùng (user, job, run_key, reason) phải bị chặn Ở TẦNG DB — và phải lộ ra
    // thành `LEDGER_CONFLICT` (lỗi nghiệp vụ), KHÔNG phải `25P02 current transaction is aborted`.
    await assert.rejects(
      () => store.appendLedger({ userId, amount: -1, reason: 'job_hold', jobId, runKey }),
      (err) => {
        assert.equal(err.code, 'LEDGER_CONFLICT', `mong LEDGER_CONFLICT, nhận ${err.code}: ${err.message}`);
        return true;
      },
    );

    // Transaction KHÔNG bị abort ⇒ sổ vẫn đọc/ghi được ngay sau cú đụng unique.
    await assertLedgerInvariant(userId, { expectBalance: 4 });
    await store.appendLedger({ userId, amount: -1, reason: 'job_hold', jobId, runKey: `${jobId}#2` });
    await assertLedgerInvariant(userId, { expectBalance: 3 });
  });

  test('ĐUA settle + refund trên CÙNG lượt chạy ⇒ đúng MỘT dòng đóng được ghi', { skip: skipNoPg }, async () => {
    const userId = newUserId('race');
    const jobId = newJobId('race');
    await billing.grant({ userId, amount: 5, reason: 'grant' });
    const hold = await billing.holdForJob({ userId, jobId, estimate: 1, operations: ['CONTENT_GENERATE'] });
    const runKey = hold.run_key;

    // Hai đường đóng lượt chạy chạy ĐỒNG THỜI — đúng cảnh "job xong" và "cron hoàn tiền" đụng nhau.
    const results = await Promise.allSettled([
      billing.settleForJob({ userId, jobId, actualCost: 0.4, runKey }),
      billing.refundForJob({ userId, jobId, reason: 'đua với settle', runKey }),
    ]);

    const closeRows = (await ledgerRows(store, userId)).filter((r) => r.close_kind !== null && r.close_kind !== undefined);
    assert.equal(
      closeRows.length,
      1,
      `MỘT lượt chạy chỉ được MỘT dòng đóng (settle XOR refund); nhận ${closeRows.length}: ${JSON.stringify(closeRows.map((r) => r.reason))}`,
    );
    assert.equal(closeRows[0].run_key, runKey);

    // Bên thua KHÔNG được báo thành công giả: hoặc nó ném lỗi có `code`, hoặc nó trả về
    // CHÍNH dòng đóng đã có (idempotent) — tuyệt đối không ghi thêm dòng thứ hai.
    for (const r of results) {
      if (r.status === 'rejected') assert.ok(r.reason?.code, `lỗi phải có code máy đọc được, nhận: ${r.reason?.message}`);
    }
    await assertLedgerInvariant(userId);
  });

  test('ĐUA hai holdForJob đồng thời trên cùng job ⇒ không giữ tiền hai lần cho một lượt', { skip: skipNoPg }, async () => {
    const userId = newUserId('race2');
    const jobId = newJobId('race2');
    const runKey = `${jobId}#1`;
    await billing.grant({ userId, amount: 5, reason: 'grant' });

    await Promise.allSettled([
      billing.holdForJob({ userId, jobId, estimate: 1, operations: ['CONTENT_GENERATE'], runKey }),
      billing.holdForJob({ userId, jobId, estimate: 1, operations: ['CONTENT_GENERATE'], runKey }),
    ]);

    const holds = (await ledgerRows(store, userId)).filter((r) => r.reason === 'job_hold' && r.run_key === runKey);
    assert.equal(holds.length, 1, 'hai request đồng thời trên CÙNG lượt chỉ được giữ tiền MỘT lần');
    await assertLedgerInvariant(userId, { expectBalance: 4 });
  });

  test('listLedger phân trang KHÔNG trùng, KHÔNG sót (thứ tự ổn định theo seq)', { skip: skipNoPg }, async () => {
    const userId = newUserId('page');
    await store.appendLedger({ userId, amount: 100, reason: 'grant' });
    // 24 dòng cùng mili-giây là chuyện thường — `created_at` một mình KHÔNG đủ ổn định.
    for (let i = 0; i < 24; i += 1) {
      const jobId = newJobId(`page${i}`);
      await store.appendLedger({ userId, amount: -0.01, reason: 'job_hold', jobId, runKey: `${jobId}#1` });
    }
    const total = 25;

    const seen = [];
    for (let offset = 0; offset < total; offset += 7) {
      const page = await store.listLedger({ userId, limit: 7, offset });
      seen.push(...page.map((r) => r.id));
    }
    assert.equal(seen.length, total, `phân trang phải trả đủ ${total} dòng, nhận ${seen.length}`);
    assert.equal(new Set(seen).size, total, 'KHÔNG được có dòng TRÙNG giữa các trang');

    const all = await store.listLedger({ userId, limit: 500 });
    assert.deepEqual(seen, all.map((r) => r.id), 'ghép các trang phải ra ĐÚNG thứ tự của một lần đọc liền');
    // Thứ tự phải giảm dần theo `seq` (mới nhất trước) — ổn định trên cả hai dialect.
    const seqs = all.map((r) => r.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => b - a), 'listLedger phải sắp theo seq GIẢM DẦN');
  });

  test('TIỀN ĐI QUA POSTGRESQL KHÔNG ĐƯỢC MẤT CHỮ SỐ (đối chiếu trực tiếp với SQLite)', { skip: skipNoPg }, async () => {
    // Đơn vị tiền của repo là 6 chữ số thập phân (`MONEY_DECIMALS = 6`, `MONEY_EPSILON = 1e-6`)
    // và giá thật nằm ở mức 0.0004–0.004 credit/lượt (`DEFAULT_PRICING`). Ví 10.000 credit là
    // mức hoàn toàn bình thường. Test chạy CÙNG dữ liệu trên hai dialect và đòi KẾT QUẢ GIỐNG NHAU.
    const cases = [
      { grant: 100, charge: -0.000001, label: 'trừ đúng 1 đơn vị tiền nhỏ nhất (MONEY_EPSILON)' },
      { grant: 10000, charge: -0.0004, label: 'ví 10.000 credit, trừ 1 lượt OCR_DETECT giá thật' },
      { grant: 100000, charge: -0.004, label: 'ví 100.000 credit, trừ 1 lượt CONTENT_GENERATE giá thật' },
    ];

    const measure = async (st) => {
      const out = [];
      for (const c of cases) {
        const userId = newUserId('money');
        await st.appendLedger({ userId, amount: c.grant, reason: 'grant' });
        await st.appendLedger({ userId, amount: c.charge, reason: 'job_settle', jobId: newJobId('money'), runKey: `${userId}#1` });
        out.push(await st.ledgerBalance(userId));
      }
      return out;
    };

    const sqliteStore = await createStore(sqliteConfig(), silent);
    let onSqlite;
    try {
      onSqlite = await measure(sqliteStore);
    } finally {
      await sqliteStore.close();
    }
    const onPg = await measure(store);

    const expected = cases.map((c) => roundMoney(c.grant + c.charge));
    assert.deepEqual(onSqlite, expected, 'SQLite phải trừ tiền đúng — đây là mốc so sánh');
    for (let i = 0; i < cases.length; i += 1) {
      assert.equal(
        onPg[i],
        expected[i],
        `${cases[i].label}: PostgreSQL trả ${onPg[i]} nhưng phải là ${expected[i]} (SQLite: ${onSqlite[i]}). `
        + 'Nguyên nhân: wallet_ledger.amount/balance_after khai REAL — trên PostgreSQL REAL là float4 '
        + '(4 byte, ~7 chữ số có nghĩa), trên SQLite REAL là float8.',
      );
    }
  });
});
