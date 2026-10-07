/**
 * R1 (§3) — KHOÁ TIỀN Ở TẦNG DB: `store.withLedgerLock` + `src/billing/**`.
 *
 * Vì sao đây là sprint độ tin cậy: khoá tiền bản cũ nằm TRONG BỘ NHỚ nên chỉ đúng khi có
 * đúng một tiến trình. Bản R1 đẩy khoá xuống DB (SQLite `BEGIN IMMEDIATE` trong CÙNG
 * transaction với "đọc số dư → ghi dòng sổ"), nhờ vậy nhiều tiến trình vẫn không ghi lệch.
 *
 * Test khẳng định HÀNH VI THẬT trên store SQLite thật + BillingService thật:
 *   1. `withLedgerLock(userId, fn)`: `fn` chạy TRONG transaction; `fn` ném ⇒ ROLLBACK,
 *      KHÔNG dòng nào được ghi.
 *   2. Hai lời gọi tuần tự cùng user ⇒ `balance_after` LIÊN TỤC; 20 lời gọi song song
 *      ⇒ số dư = tổng sổ, không âm, mỗi dòng một mốc số dư khác nhau.
 *   3. Bất biến MVP-05 giữ nguyên: số dư = tổng sổ, không âm, idempotent `(job_id, run_key)`,
 *      tiền tròn 6 chữ số, `INSUFFICIENT_CREDIT` ⇒ ném + KHÔNG thêm dòng.
 *   4. MỌI lần ghi sổ của billing đều nằm TRONG `withLedgerLock` — kiểm bằng store giả có
 *      chốt chặn: gọi `appendLedger` ngoài khoá ⇒ ném `LEDGER_LOCK_REQUIRED` (đây là bất biến
 *      mà chốt chặn nội bộ `LEDGER_LOCK_REQUIRED` của billing bảo vệ, xem báo cáo).
 *   5. `store` THIẾU `withLedgerLock` ⇒ billing rơi về đường dự phòng, cảnh báo ĐÚNG MỘT LẦN,
 *      và bất biến vẫn đúng.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createStore, MONEY_DECIMALS, roundMoney } from '../src/store/index.js';
import { createBillingService, BillingError } from '../src/billing/index.js';
import { testConfig, silent } from './helpers.js';

const newUser = () => `user-${randomUUID()}`;
const newJob = () => `job-${randomUUID()}`;

async function makeStore(config = testConfig()) {
  return createStore(config, silent);
}

const ledgerRows = (store, userId) => store.listLedger({ userId, limit: 500 });
const sumRows = (rows) => roundMoney(rows.reduce((acc, row) => acc + row.amount, 0));

/** Bất biến trung tâm (MVP-05 luật #2): số dư = TỔNG SỔ, không âm, `balance_after` liên tục. */
async function assertLedgerInvariant(store, userId, { expectBalance } = {}) {
  const rows = await ledgerRows(store, userId); // mới nhất trước
  const sum = sumRows(rows);
  assert.equal(await store.ledgerBalance(userId), sum, 'số dư store phải bằng TỔNG SỔ');
  assert.ok(sum >= 0, `số dư KHÔNG BAO GIỜ âm, nhận ${sum}`);
  if (rows.length > 0) assert.equal(rows[0].balance_after, sum, '`balance_after` dòng mới nhất phải bằng tổng sổ');
  // Tiền tròn 6 chữ số (MVP-05): không dòng nào lưu số lẻ hơn 6 chữ số thập phân.
  for (const row of rows) {
    for (const field of ['amount', 'balance_after']) {
      const value = row[field];
      assert.ok(
        Math.abs(value * 10 ** MONEY_DECIMALS - Math.round(value * 10 ** MONEY_DECIMALS)) < 1e-6,
        `${field} phải tròn ${MONEY_DECIMALS} chữ số, nhận ${value}`,
      );
    }
  }
  if (expectBalance !== undefined) assert.equal(sum, expectBalance);
  return { rows, sum };
}

/** Logger ghi lại mọi lời gọi để kiểm "cảnh báo đúng MỘT lần". */
function capturingLogger() {
  const entries = [];
  const push = (level) => (message, ctx) => entries.push({ level, message, ctx });
  return {
    entries,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
    names: (level) => entries.filter((e) => !level || e.level === level).map((e) => e.message),
  };
}

/**
 * Store giả bọc store THẬT:
 *   - `hideLock: true` ⇒ giấu `withLedgerLock` (mô phỏng store thời trước R1);
 *   - chốt chặn: `appendLedger` gọi NGOÀI khoá theo user ⇒ ném `LEDGER_LOCK_REQUIRED`.
 */
function tripwireStore(realStore, { hideLock = false } = {}) {
  const locked = new Set();
  const violations = [];
  return new Proxy(realStore, {
    get(target, prop) {
      if (prop === '__violations') return violations;
      if (prop === 'withLedgerLock') {
        if (hideLock) return undefined;
        return async (userId, fn) => {
          const key = String(userId);
          locked.add(key);
          try {
            return await target.withLedgerLock(userId, fn);
          } finally {
            locked.delete(key);
          }
        };
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      // Giấu khoá ⇒ đường dự phòng của billing KHÔNG đi qua store, nên không quan sát được khoá
      // nào; chốt chặn cũng không được gắn (nếu không, test sẽ đo nhầm chính store giả của mình).
      if (prop === 'appendLedger' && !hideLock) {
        return async (payload = {}) => {
          const owner = String(payload.userId ?? payload.user_id ?? '');
          if (!locked.has(owner)) {
            violations.push(owner);
            throw Object.assign(new Error('appendLedger gọi NGOÀI khoá theo người dùng'), { code: 'LEDGER_LOCK_REQUIRED' });
          }
          return value.call(target, payload);
        };
      }
      return value.bind(target);
    },
  });
}

describe('R1 · §3 — withLedgerLock: transaction thật, rollback thật, tuần tự theo user', () => {
  test('`fn` chạy TRONG transaction; `fn` ném ⇒ ROLLBACK, không dòng nào được ghi', async () => {
    const store = await makeStore();
    try {
      const userId = newUser();
      await assert.rejects(
        store.withLedgerLock(userId, async (tx) => {
          const row = await tx.appendLedger({ userId, amount: 5, reason: 'grant' });
          assert.equal(row.balance_after, 5, 'bên trong transaction phải thấy số dư vừa ghi');
          assert.equal(await tx.ledgerBalance(userId), 5, 'đọc bằng `tx` phải thấy dòng CHƯA commit (cùng transaction)');
          throw Object.assign(new Error('nổ giữa transaction'), { code: 'BOOM' });
        }),
        /nổ giữa transaction/,
      );
      assert.equal((await ledgerRows(store, userId)).length, 0, 'rollback ⇒ KHÔNG được còn dòng nào');
      assert.equal(await store.ledgerBalance(userId), 0);

      // Lỗi NGHIỆP VỤ của store (số dư âm) cũng phải rollback sạch.
      await assert.rejects(
        store.withLedgerLock(userId, () => store.appendLedger({ userId, amount: -1, reason: 'adjustment' })),
        (err) => err.code === 'INSUFFICIENT_CREDIT',
      );
      assert.equal((await ledgerRows(store, userId)).length, 0);

      // Commit bình thường thì dòng phải còn.
      await store.withLedgerLock(userId, (tx) => tx.appendLedger({ userId, amount: 2, reason: 'grant' }));
      assert.equal(await store.ledgerBalance(userId), 2);
    } finally {
      await store.close();
    }
  });

  test('thiếu userId / thiếu hàm ⇒ INVALID_LEDGER_LOCK (không mở transaction)', async () => {
    const store = await makeStore();
    try {
      await assert.rejects(store.withLedgerLock('', () => {}), (err) => err.code === 'INVALID_LEDGER_LOCK');
      await assert.rejects(store.withLedgerLock('u-1', null), (err) => err.code === 'INVALID_LEDGER_LOCK');
      await assert.rejects(store.withLedgerLock('u-1', 'khong-phai-ham'), (err) => err.code === 'INVALID_LEDGER_LOCK');
    } finally {
      await store.close();
    }
  });

  test('hai lời gọi TUẦN TỰ cùng user ⇒ `balance_after` liên tục; 20 lời gọi SONG SONG ⇒ số dư = tổng sổ', async () => {
    const store = await makeStore();
    try {
      const userId = newUser();
      const first = await store.withLedgerLock(userId, (tx) => tx.appendLedger({ userId, amount: 10, reason: 'grant' }));
      const second = await store.withLedgerLock(userId, (tx) => tx.appendLedger({ userId, amount: -3, reason: 'adjustment' }));
      assert.equal(first.balance_after, 10);
      assert.equal(second.balance_after, 7, 'tuần tự ⇒ `balance_after` phải nối tiếp dòng trước');
      await assertLedgerInvariant(store, userId, { expectBalance: 7 });

      // 20 thao tác SONG SONG (+1 mỗi lần) — khoá DB phải tuần tự hoá, không mất dòng nào.
      const userId2 = newUser();
      await store.withLedgerLock(userId2, (tx) => tx.appendLedger({ userId: userId2, amount: 100, reason: 'grant' }));
      await Promise.all(Array.from({ length: 20 }, () =>
        store.withLedgerLock(userId2, (tx) => tx.appendLedger({ userId: userId2, amount: 1, reason: 'adjustment' }))));

      const { rows, sum } = await assertLedgerInvariant(store, userId2);
      assert.equal(sum, 120, '20 lời gọi song song ⇒ KHÔNG được mất dòng nào');
      assert.equal(rows.length, 21);
      const balances = rows.map((row) => row.balance_after);
      assert.equal(new Set(balances).size, balances.length, 'mỗi dòng một mốc số dư (không hai dòng cùng `balance_after`)');
      assert.deepEqual([...balances].sort((a, b) => a - b), Array.from({ length: 21 }, (_, i) => 100 + i));
    } finally {
      await store.close();
    }
  });
});

describe('R1 · §3 — BillingService ghi sổ QUA khoá DB', () => {
  test('mọi lần ghi sổ đều nằm TRONG withLedgerLock; ghi ngoài khoá ⇒ LEDGER_LOCK_REQUIRED', async () => {
    const config = testConfig();
    const realStore = await makeStore(config);
    try {
      const wrapped = tripwireStore(realStore);
      const logger = capturingLogger();
      const billing = createBillingService(config, { store: wrapped, logger });
      const user = newUser();
      const jobId = newJob();

      await billing.grant({ userId: user, amount: 5, reason: 'admin_grant' });
      const hold = await billing.holdForJob({ userId: user, jobId, estimate: 1, runKey: 'r1' });
      await billing.settleForJob({ userId: user, jobId, actualCost: 0.4, runKey: 'r1' });
      await billing.refundForJob({ userId: user, jobId, runKey: 'r1', reason: 'THU_HOI' });
      await assert.rejects(billing.holdForJob({ userId: user, jobId: newJob(), estimate: 1000, runKey: 'r2' }),
        (err) => err.code === 'INSUFFICIENT_CREDIT');
      assert.ok(hold.ledgerId);

      assert.deepEqual(wrappedViolations(wrapped), [], 'KHÔNG được có lần ghi nào ngoài `withLedgerLock`');      assert.equal(logger.names('warn').filter((n) => n === 'billing.ledger_lock_fallback').length, 0);
      assert.deepEqual(logger.names('info').filter((n) => n === 'billing.ledger_lock_mode'), ['billing.ledger_lock_mode'],
        'phải log MỘT LẦN chế độ khoá DB để vận hành biết mình được bảo vệ thế nào');
      assert.equal(logger.entries.find((e) => e.message === 'billing.ledger_lock_mode').ctx.mode, 'db');
      await assertLedgerInvariant(realStore, user);

      // CHỐT CHẶN có thật: gọi thẳng `appendLedger` ngoài khoá ⇒ bị chặn (đối chứng dương).
      await assert.rejects(
        wrapped.appendLedger({ userId: user, amount: 1, reason: 'grant' }),
        (err) => err.code === 'LEDGER_LOCK_REQUIRED',
      );
    } finally {
      await realStore.close();
    }
  });

  test('idempotent `(job_id, run_key)`: 2 service (2 "tiến trình") cùng giữ tiền ⇒ ĐÚNG 1 dòng', async () => {
    const config = testConfig();
    const store = await makeStore(config);
    try {
      const b1 = createBillingService(config, { store, logger: silent });
      const b2 = createBillingService(config, { store, logger: silent });
      const user = newUser();
      const jobId = newJob();
      await b1.grant({ userId: user, amount: 10, reason: 'admin_grant' });

      const [h1, h2] = await Promise.all([
        b1.holdForJob({ userId: user, jobId, estimate: 2, runKey: 'r1' }),
        b2.holdForJob({ userId: user, jobId, estimate: 2, runKey: 'r1' }),
      ]);
      const rows = await ledgerRows(store, user);
      const holds = rows.filter((row) => row.reason === 'job_hold');
      assert.equal(holds.length, 1, 'cùng `(job_id, run_key)` ⇒ chỉ MỘT dòng giữ tiền (không thu 2 lần)');
      assert.equal(h1.ledgerId, h2.ledgerId, 'cả hai lời gọi phải trỏ về CÙNG dòng sổ');
      await assertLedgerInvariant(store, user, { expectBalance: 8 });

      // Quyết toán lặp lại cùng lượt ⇒ vẫn một dòng `job_settle`, số dư không đổi.
      const s1 = await b1.settleForJob({ userId: user, jobId, actualCost: 1, runKey: 'r1' });
      const s2 = await b2.settleForJob({ userId: user, jobId, actualCost: 1, runKey: 'r1' });
      assert.equal(s1.id, s2.id, 'settle lặp lại phải trả dòng CŨ, không ghi thêm');
      assert.equal((await ledgerRows(store, user)).filter((r) => r.reason === 'job_settle').length, 1);
      await assertLedgerInvariant(store, user, { expectBalance: 9 });
    } finally {
      await store.close();
    }
  });

  test('tiền tròn 6 chữ số + số dư = tổng sổ sau chuỗi thao tác thật', async () => {
    const config = testConfig();
    const store = await makeStore(config);
    try {
      const billing = createBillingService(config, { store, logger: silent });
      const user = newUser();
      const jobId = newJob();
      await billing.grant({ userId: user, amount: 1.1234567, reason: 'admin_grant' });
      const afterGrant = await store.ledgerBalance(user);
      assert.equal(afterGrant, 1.123457, 'tiền phải tròn 6 chữ số ngay tại biên ghi sổ');
      await billing.holdForJob({ userId: user, jobId, estimate: 0.0000004, runKey: 'r1' });
      await billing.settleForJob({ userId: user, jobId, actualCost: 0.0000001, runKey: 'r1' });
      await assertLedgerInvariant(store, user);
    } finally {
      await store.close();
    }
  });

  test('INSUFFICIENT_CREDIT: ném + KHÔNG thêm dòng nào; ẩn danh ⇒ ANONYMOUS_NO_WALLET', async () => {
    const config = testConfig();
    const store = await makeStore(config);
    try {
      const billing = createBillingService(config, { store, logger: silent });
      const user = newUser();
      const jobId = newJob();
      await billing.grant({ userId: user, amount: 1, reason: 'admin_grant' });
      const before = (await ledgerRows(store, user)).length;

      await assert.rejects(
        billing.holdForJob({ userId: user, jobId, estimate: 5, runKey: 'r1' }),
        (err) => err instanceof BillingError && err.code === 'INSUFFICIENT_CREDIT',
      );
      assert.equal((await ledgerRows(store, user)).length, before, 'thiếu credit ⇒ sổ KHÔNG được thêm dòng');
      await assertLedgerInvariant(store, user, { expectBalance: 1 });

      // Tầng DB cũng là chốt chặn cuối: ghi thẳng số âm vượt số dư ⇒ ném, không ghi.
      await assert.rejects(
        store.withLedgerLock(user, (tx) => tx.appendLedger({ userId: user, amount: -3, reason: 'adjustment' })),
        (err) => err.code === 'INSUFFICIENT_CREDIT',
      );
      await assertLedgerInvariant(store, user, { expectBalance: 1 });

      await assert.rejects(
        billing.grant({ userId: null, amount: 1, reason: 'grant' }),
        (err) => err.code === 'ANONYMOUS_NO_WALLET',
      );
    } finally {
      await store.close();
    }
  });
});

describe('R1 · §3 — đường DỰ PHÒNG khi store thiếu withLedgerLock', () => {
  test('thiếu khoá DB ⇒ warn ĐÚNG MỘT LẦN, vẫn đúng bất biến (khoá bộ nhớ + retry)', async () => {
    const config = testConfig();
    const realStore = await makeStore(config);
    try {
      const wrapped = tripwireStore(realStore, { hideLock: true });
      assert.equal(typeof wrapped.withLedgerLock, 'undefined', 'store giả phải THIẾU hẳn withLedgerLock');
      const logger = capturingLogger();
      const billing = createBillingService(config, { store: wrapped, logger });
      const user = newUser();
      const jobId = newJob();

      await billing.grant({ userId: user, amount: 10, reason: 'admin_grant' });
      await billing.holdForJob({ userId: user, jobId, estimate: 2, runKey: 'r1' });
      await billing.settleForJob({ userId: user, jobId, actualCost: 1, runKey: 'r1' });
      await billing.grant({ userId: user, amount: 1, reason: 'admin_grant' });
      await assert.rejects(billing.holdForJob({ userId: user, jobId: newJob(), estimate: 100, runKey: 'r9' }),
        (err) => err.code === 'INSUFFICIENT_CREDIT');

      const fallbackWarns = logger.entries.filter((e) => e.message === 'billing.ledger_lock_fallback');
      assert.equal(fallbackWarns.length, 1, 'cảnh báo "chỉ khoá trong bộ nhớ" phải đúng MỘT lần, không rác log mỗi thao tác');
      assert.equal(fallbackWarns[0].ctx.mode, 'memory');
      assert.match(String(fallbackWarns[0].ctx.missing), /withLedgerLock/);
      assert.equal(logger.entries.filter((e) => e.message === 'billing.ledger_lock_mode').length, 0,
        'không có khoá DB thì KHÔNG được log chế độ `db` (không nói dối về mức bảo vệ)');

      await assertLedgerInvariant(realStore, user, { expectBalance: 10 });
      const rows = await ledgerRows(realStore, user);
      assert.equal(rows.filter((r) => r.reason === 'job_hold').length, 1, 'giữ tiền đúng một lần dù không có khoá DB');
      assert.equal(rows.filter((r) => r.reason === 'job_settle').length, 1);
    } finally {
      await realStore.close();
    }
  });
});

/** Danh sách user bị bắt ghi ngoài khoá (đọc qua closure của proxy). */
function wrappedViolations(proxy) {
  return proxy.__violations || [];
}
