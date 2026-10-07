/**
 * MVP-05 (A2) — Ví credit: bảng giá + SỔ CREDIT APPEND-ONLY.
 *
 * Hai luật không được vi phạm (hợp đồng MVP-05 §0):
 *   1. KHÔNG phá người dùng ẩn danh — `userId` rỗng ⇒ mọi hàm ví ném
 *      `ANONYMOUS_NO_WALLET`; tầng gọi PHẢI bỏ qua billing cho ẩn danh.
 *   2. Sổ credit là APPEND-ONLY: số dư = TỔNG SỔ (`store.ledgerBalance`), không có
 *      cột `balance` nào để sửa tay; KHÔNG BAO GIỜ ghi/xoá/sửa dòng cũ; KHÔNG BAO GIỜ
 *      để số dư âm (mọi lần trừ đều kiểm tra số dư ĐỌC TỪ SỔ ngay trước khi ghi).
 *
 * Hợp đồng store mà lớp này cần (A3 — §3.4, tên method đã đóng băng):
 *
 *   appendLedger({ userId, amount, currency, reason, jobId, operation, meta, balanceAfter })
 *        → ledgerRow | id            (meta: object | null — store tự JSON.stringify như recordUsage)
 *   listLedger({ userId, limit, offset })       → ledgerRow[]  (nhận thêm `jobId` tuỳ chọn;
 *                                                                không hỗ trợ cũng KHÔNG sao — xem #jobRows)
 *   ledgerBalance(userId)                       → number | { amount, currency }
 *   upsertPricing({ operation, unitPrice, currency, note }) → pricingRow
 *   listPricing()                               → pricingRow[]
 *   usageAggregate({ from, to, groupBy })       → row[]        (groupBy ∈ day|operation|user)
 *
 * KHOÁ SỔ (R1-B — `docs/R1-RELIABILITY-CONTRACT.md` §3):
 *   MỌI thao tác GHI sổ (`grant`, `holdForJob`, `settleForJob`, `refundForJob` — kể cả
 *   `adjustment`) chạy trong `#withLedgerSection()`, và đoạn "đọc sổ → tính `balance_after`
 *   → ghi dòng" nằm trong `store.withLedgerLock(userId, fn)` do R1-Q cung cấp (§2.2) ⇒ khoá
 *   theo NGƯỜI DÙNG ở TẦNG DB, đúng cả khi nhiều tiến trình cùng ghi (SQLite: transaction ghi
 *   + `busy_timeout`; PostgreSQL: `pg_advisory_xact_lock`).
 *   `#locks` (promise chain trong bộ nhớ) được GIỮ như lớp chống trùng RẺ trong cùng tiến
 *   trình — KHÔNG còn là lớp bảo vệ duy nhất.
 *   R1-Q chưa land ⇒ `#withLedgerSection` rơi về khoá bộ nhớ **kèm log warn MỘT LẦN**
 *   (`billing.ledger_lock_fallback`) + retry có giới hạn cho lỗi `database is locked`
 *   (`LEDGER_BUSY` kèm `retryable: true` sau N lần). Fail-closed vẫn giữ: số dư âm bị tầng
 *   store chặn, dòng trùng `(user_id, job_id, run_key, reason)` bị unique index chặn.
 *
 * Giới hạn ĐÃ BIẾT (ghi rõ để không ai tưởng là an toàn tuyệt đối):
 *   - Khi `store.withLedgerLock` CHƯA có (R1-Q chưa land), hai TIẾN TRÌNH cùng user vẫn có
 *     thể đọc cùng số dư rồi cùng ghi. Hệ quả được chặn bởi tầng DB (không âm, không trùng
 *     dòng theo `run_key`), nhưng `balance_after` của dòng do tiến trình thua cuộc tính có
 *     thể lệch — retry + đọc lại dòng thắng giữ cho API vẫn trả kết quả đúng.
 *   - `#jobRows` đọc sổ theo trang (tối đa `LEDGER_MAX_SCAN` dòng). Nếu A3 lọc được
 *     theo `jobId` ở tầng SQL thì mọi chuyện nhẹ; nếu không, user có sổ dài hơn ngưỡng
 *     đó sẽ được ghi log `billing.ledger_scan_truncated` (không im lặng).
 */

import { DEFAULT_MAX_AMOUNT, MONEY_EPSILON, normalizeAmount, roundMoney, sumMoney, toFiniteNumber } from './money.js';
import { normalizeLedgerRow, normalizeLedgerRows, normalizePricingRow } from './ledger-rows.js';

/**
 * Lý do ghi sổ — ĐÓNG BĂNG theo §2.1. Sổ chỉ nhận đúng 6 giá trị này; thêm giá trị
 * mới là thay đổi hợp đồng dữ liệu (phải hỏi người điều phối).
 */
export const LEDGER_REASONS = Object.freeze([
  'grant',
  'admin_grant',
  'job_hold',
  'job_settle',
  'job_refund',
  'adjustment',
]);

/** Lý do gắn với MỘT job — dùng để đối soát phần đã giữ của job. */
const JOB_REASONS = Object.freeze(['job_hold', 'job_settle', 'job_refund']);

/** Lý do cấp credit bằng tay (admin/cấp bù) — `job_*` không được dùng ở `grant()`. */
const MANUAL_GRANT_REASONS = Object.freeze(['grant', 'admin_grant', 'adjustment']);

const GROUP_BY_VALUES = Object.freeze(['day', 'operation', 'user']);

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** Kích thước trang khi quét sổ theo job. Nhỏ hơn `MAX_LIMIT` để nếu store có kẹp limit thấp hơn thì vẫn phân trang đúng. */
const LEDGER_PAGE_SIZE = 100;
/** Trần số dòng quét cho một job — chặn treo máy với sổ khổng lồ. */
const LEDGER_MAX_SCAN = 5000;

/* ── R1-B (§3): tham số cho khoá ghi sổ ở tầng DB ── */
/** Số lần THỬ LẠI khi driver báo bận/khoá (`database is locked`, deadlock…). Hết lượt ⇒ `LEDGER_BUSY`. */
const LEDGER_LOCK_RETRIES = 6;
/** Thời gian chờ cơ sở giữa hai lần thử (ms) — tăng gấp đôi, có nhiễu để hai tiến trình không đập vào nhau cùng nhịp. */
const LEDGER_LOCK_RETRY_BASE_MS = 20;
/** Trần thời gian chờ một lần thử (ms) — tổng ngân sách thử lại phải NHỎ để không treo request. */
const LEDGER_LOCK_RETRY_MAX_MS = 120;
/** TỔNG ngân sách thử lại (ms) cho đường DỰ PHÒNG — hết ngân sách thì fail-closed, không chờ mãi. */
const LEDGER_LOCK_RETRY_BUDGET_MS = 2000;
/** Trần số lần thử lại cấu hình được (chặn cấu hình sai biến retry thành treo máy). */
const LEDGER_LOCK_RETRIES_MAX = 20;

/** Lỗi của tầng ví — LUÔN có `code` để A4 map sang HTTP mà không phải đoán chuỗi. */
export class BillingError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/* ────────────────────────────── tiện ích nội bộ ────────────────────────────── */

/** `new BillingService(config)` cũng chạy được — dò theo hình dạng, không đoán bừa. */
function normalizeDeps(deps) {
  const opts = deps && typeof deps === 'object' ? deps : {};
  const looksLikeConfig = !opts.store && !opts.config && (opts.billing !== undefined || opts.cost !== undefined);
  if (looksLikeConfig) return { store: null, logger: null, config: opts };
  return { store: opts.store ?? null, logger: opts.logger ?? null, config: opts.config ?? null };
}

/** `ledgerBalance` có thể trả số trần hoặc object — nhận cả hai. */
function parseBalanceResult(raw) {
  if (typeof raw === 'number' || typeof raw === 'string') {
    return { amount: toFiniteNumber(raw) ?? 0, currency: '' };
  }
  if (raw && typeof raw === 'object') {
    const amount = toFiniteNumber(raw.amount ?? raw.balance ?? raw.total ?? raw.sum);
    const currency = typeof raw.currency === 'string' ? raw.currency.trim() : '';
    return { amount: amount ?? 0, currency };
  }
  return { amount: 0, currency: '' };
}

/** Gộp operations (chuỗi hoặc `{operation, count}`) thành Map<operation, số lần>. */
function countOperations(operations) {
  if (operations === undefined || operations === null) return new Map();
  if (!Array.isArray(operations)) {
    throw new BillingError('INVALID_ARGUMENT', '`operations` phải là MẢNG tên operation.', {
      got: typeof operations,
    });
  }
  const counts = new Map();
  for (const item of operations) {
    let name = '';
    let times = 1;
    if (typeof item === 'string') {
      name = item.trim();
    } else if (item && typeof item === 'object') {
      name = String(item.operation ?? '').trim();
      const n = toFiniteNumber(item.count ?? item.times ?? 1);
      times = n === null || n <= 0 ? 0 : Math.trunc(n);
    }
    if (!name) {
      throw new BillingError('INVALID_ARGUMENT', `Phần tử \`operations\` không hợp lệ: ${JSON.stringify(item)}`);
    }
    if (times <= 0) continue; // đếm 0 lần ⇒ không tính tiền
    counts.set(name, (counts.get(name) ?? 0) + times);
  }
  return counts;
}

/** Danh sách tên operation (giữ nguyên thứ tự, có thể trùng) — để lưu vào meta dòng giữ tiền. */
function listOperationNames(operations) {
  if (!Array.isArray(operations)) return [];
  return operations
    .map((item) => (typeof item === 'string' ? item.trim() : String(item?.operation ?? '').trim()))
    .filter(Boolean);
}

/** Cột `operation` của dòng `job_hold` chỉ có nghĩa khi job chỉ có DUY NHẤT một operation. */
function singleOperation(names) {
  const unique = [...new Set(names)];
  return unique.length === 1 ? unique[0] : null;
}

function requireJobId(jobId) {
  const jid = typeof jobId === 'string' ? jobId.trim() : '';
  if (!jid) {
    throw new BillingError('INVALID_ARGUMENT', 'Thiếu `jobId` — mọi thao tác giữ/hoàn tiền phải gắn với một job cụ thể.');
  }
  return jid;
}

function normalizeLimit(limit) {
  const n = toFiniteNumber(limit);
  if (n === null || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.trunc(n), MAX_LIMIT);
}

function normalizeOffset(offset) {
  const n = toFiniteNumber(offset);
  if (n === null || n <= 0) return 0;
  return Math.trunc(n);
}

function findLast(rows, predicate) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (predicate(rows[i])) return rows[i];
  }
  return null;
}

/**
 * Phần credit ĐANG GIỮ của một job = `-(tổng các dòng job_* của job)`.
 * `job_hold` ghi số ÂM (đã giữ), `job_settle` ghi phần chênh, `job_refund` ghi phần hoàn —
 * nên đảo dấu tổng là ra "còn giữ bao nhiêu". Chỉ tính các reason thuộc `JOB_REASONS`:
 * một dòng `grant`/`adjustment` lỡ mang `job_id` KHÔNG được coi là tiền đã giữ của job.
 */
function heldFromRows(rows) {
  const amounts = [];
  for (const row of rows) {
    if (!JOB_REASONS.includes(row?.reason)) continue;
    amounts.push(row?.amount);
  }
  return roundMoney(-sumMoney(amounts));
}

/**
 * PB-02 (vòng 2) — KHOÁ SỔ THEO **LƯỢT CHẠY** (run), không theo `jobId`.
 *
 * Vì sao: khoá theo `jobId` khiến mọi lượt chạy lại (`regenerate`/`render`/`generate`/retry)
 * đều MIỄN PHÍ — `beforeJob` thấy "job đã từng có `job_hold`" là bỏ qua. Nay mỗi lượt chạy có
 * `run_key` riêng: `"<jobId>#<n>"` với `n` = số lượt đã mở + 1. `run_key` được ghi vào CỘT
 * `wallet_ledger.run_key` (không chỉ trong `meta`) để có thể đánh unique index ở tầng DB.
 */
export function runKeyOf(row) {
  const direct = typeof row?.run_key === 'string' ? row.run_key.trim() : '';
  if (direct) return direct;
  const fromMeta = row?.meta && typeof row.meta === 'object' ? row.meta.run_key : null;
  return typeof fromMeta === 'string' && fromMeta.trim() ? fromMeta.trim() : '';
}

/** Mọi `run_key` đã thấy trong sổ của MỘT job (theo thứ tự xuất hiện). */
function runKeysOf(rows) {
  const out = [];
  for (const row of rows) {
    if (!JOB_REASONS.includes(row?.reason)) continue;
    const key = runKeyOf(row);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Lượt chạy đang MỞ = lượt mới nhất có `job_hold` mà CHƯA có `job_settle`/`job_refund`. */
function openRunKeyOf(rows) {
  const closed = new Set();
  for (const row of rows) {
    const key = runKeyOf(row);
    if (key && (row?.reason === 'job_settle' || row?.reason === 'job_refund')) closed.add(key);
  }
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row?.reason !== 'job_hold') continue;
    const key = runKeyOf(row);
    if (!key) continue;
    if (!closed.has(key)) return key;
  }
  return '';
}

/** `run_key` của lượt chạy KẾ TIẾP cho một job: `"<jobId>#<số lượt đã mở + 1>"`. */
function nextRunKeyOf(rows, jobId) {
  const keys = runKeysOf(rows);
  let max = keys.length;
  for (const key of keys) {
    const m = /#(\d+)$/.exec(key);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${jobId}#${max + 1}`;
}

/** Phần credit ĐANG GIỮ của MỘT lượt chạy (chỉ tính dòng mang đúng `run_key` đó). */
function heldOfRun(rows, runKey) {
  const amounts = [];
  for (const row of rows) {
    if (!JOB_REASONS.includes(row?.reason)) continue;
    if (runKeyOf(row) !== runKey) continue;
    amounts.push(row?.amount);
  }
  return roundMoney(-sumMoney(amounts));
}

/** Dòng store trả về sau khi ghi: object | id | không gì cả. */
function pickReturnedRow(returned, payload) {
  if (returned && typeof returned === 'object') return returned;
  if (typeof returned === 'string' && returned) return { ...payload, id: returned };
  return { ...payload, id: null, created_at: new Date().toISOString() };
}

/* ─────────────── R1-B (§3): nhận diện lỗi khoá/đua ở tầng DB ─────────────── */

/**
 * Lỗi HẠ TẦNG dạng "bận/khoá" — retry được, KHÔNG phải lỗi nghiệp vụ.
 *
 * Vì sao phải retry: SQLite ở chế độ WAL trả `SQLITE_BUSY_SNAPSHOT` khi một transaction
 * ĐỌC muốn nâng lên GHI trong lúc tiến trình khác vừa ghi xong; PostgreSQL trả deadlock/
 * serialization (`40001`/`40P01`). Đây là đua BÌNH THƯỜNG khi hai tiến trình cùng ghi sổ,
 * không phải lỗi dữ liệu ⇒ thử lại (đọc lại số dư rồi quyết định lại) là đúng.
 *
 * KHÔNG khớp lỗi nghiệp vụ (`INSUFFICIENT_CREDIT`, `RERUN_LIMIT_EXCEEDED`, `INVALID_*`):
 * retry một lỗi nghiệp vụ là vô nghĩa và có thể che lỗi thật.
 */
function isLedgerBusyError(err) {
  if (err instanceof BillingError && err.code === 'LEDGER_BUSY') return true;
  if (err?.details?.retryable === true) return true;
  const text = `${err?.code ?? ''} ${err?.message ?? ''}`;
  return /SQLITE_BUSY|SQLITE_ERROR|database is locked|database table is locked|deadlock|40001|40P01|55P03|ECONNRESET|ETIMEDOUT|LEDGER_BUSY/i.test(text);
}

/**
 * Lỗi do UNIQUE INDEX của sổ (`uniq_wallet_ledger_run_reason`,
 * `uniq_wallet_ledger_run_close`): một tiến trình KHÁC đã ghi dòng cho cùng
 * `(user_id, job_id, run_key, reason)` trước mình. Đây là "thua cuộc đua" — đọc lại sổ và
 * trả về dòng đã có (idempotent theo `(job_id, run_key)`), KHÔNG ghi thêm dòng nào.
 */
function isUniqueLedgerViolation(err) {
  const text = `${err?.code ?? ''} ${err?.message ?? ''}`;
  if (String(err?.code ?? '') === 'LEDGER_CONFLICT') return true; // mã đã chuẩn hoá ở `#callStore` (F4)
  return /SQLITE_CONSTRAINT|UNIQUE constraint failed|duplicate key value|23505|uniq_wallet_ledger/i.test(text);
}

/** Số lần chạy lại section khi transaction bị ABORT vì unique violation (F4). */
const LEDGER_TX_ABORT_RETRIES = 2;

/** Chờ `ms` — dùng cho retry có giới hạn (không `unref`: chuỗi retry phải chạy xong). */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/* ──────────────────────────────── BillingService ──────────────────────────────── */

export class BillingService {
  /**
   * Khoá tuần tự hoá theo user: Map<userId, Promise> nối đuôi nhau (promise chain).
   * Từ R1-B đây chỉ còn là lớp chống trùng RẺ TRONG TIẾN TRÌNH; lớp bảo vệ thật nằm ở
   * `store.withLedgerLock` (xem `#withLedgerSection`).
   */
  #locks = new Map();

  /** F4: view transaction đang mở (để ghi sổ trong SAVEPOINT trên PostgreSQL). */
  #txView = null;

  /**
   * R1-B (§3) — số tầng khoá sổ đang giữ cho mỗi user. `#append` từ chối ghi nếu user
   * KHÔNG ở trong khoá: chốt chặn để một đường code mới không thể lặng lẽ ghi sổ ngoài khoá.
   */
  #sections = new Map();

  /** Đã cảnh báo "chưa có khoá DB ⇒ chỉ khoá trong bộ nhớ" chưa (cảnh báo MỘT lần). */
  #lockFallbackWarned = false;

  /** Đã log chế độ khoá đang dùng chưa (db | memory) — để vận hành biết mình đang ở đâu. */
  #lockModeLogged = false;

  /** BR-10: đã cảnh báo "ngưỡng bị nâng lên đáy an toàn" cho đường không kiểm được job chưa. */
  #floorWarned = false;

  constructor(deps = {}) {
    const { store, logger, config } = normalizeDeps(deps);
    this.store = store;
    // ⚠️ Gán logger NGAY: các cảnh báo cấu hình bên dưới (đáy an toàn BR-10) phải ra được log.
    this.logger = logger;
    // PB-06: trần credit cho một thao tác cấp/điều chỉnh (mặc định 1e9 — xem `money.js`).
    const cap = toFiniteNumber(config?.billing?.maxAmount);
    this.maxAmount = cap !== null && cap > 0 ? cap : DEFAULT_MAX_AMOUNT;
    // BR-08 (vòng 4): ngưỡng TREO của một lượt chạy (mặc định 15 phút) — xem `reconcileStuckRuns`.
    const stuck = toFiniteNumber(config?.billing?.stuckRunMs);
    const floor = toFiniteNumber(config?.billing?.minStuckRunMs);
    this.minStuckRunMs = floor !== null && floor >= 0 ? floor : 60 * 1000;
    // BR-10: ngưỡng TREO không bao giờ được thấp hơn đáy an toàn — nếu không, một cấu hình sai
    // có thể thu hồi (hoàn tiền + đóng) một lượt ĐANG CHẠY THẬT, biến nó thành miễn phí.
    this.stuckRunMs = stuck !== null && stuck >= 0 ? stuck : 15 * 60 * 1000;
    /** Đáy an toàn chỉ áp cho đường KHÔNG kiểm được job đang chạy hay không (xem §7.3). */
    this.#floorWarned = false;
    // R1-B (§3): tham số THỬ LẠI khi driver báo bận/khoá. Đọc từ `config.billing` (R3-S có
    // thể nối env sau); mặc định đủ nhỏ để một sự cố khoá thật vẫn fail-closed NHANH
    // (`LEDGER_BUSY`) chứ không treo request.
    const lockRetries = toFiniteNumber(config?.billing?.ledgerLockRetries);
    this.lockRetries = lockRetries !== null && lockRetries >= 0
      ? Math.min(Math.trunc(lockRetries), LEDGER_LOCK_RETRIES_MAX)
      : LEDGER_LOCK_RETRIES;
    const lockBaseMs = toFiniteNumber(config?.billing?.ledgerLockRetryBaseMs);
    this.lockRetryBaseMs = lockBaseMs !== null && lockBaseMs >= 0
      ? Math.min(lockBaseMs, LEDGER_LOCK_RETRY_MAX_MS)
      : LEDGER_LOCK_RETRY_BASE_MS;
    this.#lockFallbackWarned = false;
    this.#lockModeLogged = false;
    this.config = config;
  }

  /** `config.billing.enabled` — việc BẬT/TẮT billing thuộc tầng wiring (A3), không phải tầng này. */
  get enabled() {
    return this.#billingConfig().enabled !== false;
  }

  /** Đơn vị tiền tệ DUY NHẤT của ví (không có khoá tiền tệ thứ hai — §2.3). */
  get currency() {
    return this.#currency();
  }

  #billingConfig() {
    const billing = this.config?.billing;
    return billing && typeof billing === 'object' ? billing : {};
  }

  /**
   * §2.3: `currency` lấy từ `config.billing.currency`; nếu A1 chưa kịp thêm khoá
   * `billing` thì rơi về `config.cost.currency` (MVP-01 — CÙNG biến môi trường
   * `CREDIT_CURRENCY`, nên vẫn chỉ có một nguồn sự thật), cuối cùng mới là 'USD'.
   */
  #currency() {
    const fromBilling = typeof this.#billingConfig().currency === 'string' ? this.#billingConfig().currency.trim() : '';
    if (fromBilling) return fromBilling;
    const fromCost = typeof this.config?.cost?.currency === 'string' ? this.config.cost.currency.trim() : '';
    return fromCost || 'USD';
  }

  #costTable() {
    const cost = this.config?.cost;
    return cost && typeof cost === 'object' ? cost : {};
  }

  /** Ẩn danh KHÔNG có ví (luật #1) — chặn ngay, không chạm store. */
  #requireUserId(userId) {
    const uid = typeof userId === 'string' ? userId.trim() : '';
    if (!uid) {
      throw new BillingError(
        'ANONYMOUS_NO_WALLET',
        'Người dùng ẩn danh không có ví credit — tầng gọi phải bỏ qua billing (hợp đồng MVP-05 §3.2).',
        { user_id: null },
      );
    }
    return uid;
  }

  #requireStore() {
    if (!this.store) {
      throw new BillingError(
        'STORE_UNAVAILABLE',
        'BillingService thiếu `store` — A3 phải truyền store đã nối (hợp đồng §3.4).',
      );
    }
    return this.store;
  }

  #requireMethod(name) {
    const store = this.#requireStore();
    if (typeof store[name] !== 'function') {
      throw new BillingError(
        'STORE_UNAVAILABLE',
        `store.${name}() chưa có — A3 phải thêm theo hợp đồng §3.4 trước khi bật billing.`,
        { method: name },
      );
    }
    return store;
  }

  /**
   * Bọc lời gọi store để MỌI lỗi thoát ra đều có `code` (lỗi gốc giữ ở `error.cause`).
   *
   * ⚠️ Store (A3) cũng ném lỗi có `code` — ví dụ `INSUFFICIENT_CREDIT` của chốt chặn
   * tầng DB. Phải GIỮ NGUYÊN code đó và chuyển thành `BillingError` để A4 map đúng
   * HTTP 402; gói bừa thành `LEDGER_WRITE_FAILED` là biến 402 thành 500.
   */
  async #callStore(fn, { code, message, details = undefined, event = null }) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BillingError) throw err;
      this.logger?.error?.(event ?? 'billing.store_call_failed', {
        code: err?.code ?? code,
        error: err?.message ?? String(err),
        ...(details ?? {}),
      });
      // BR-03 (vòng 3): lỗi HẠ TẦNG (SQLite `database is locked`, deadlock/serialization của
      // PostgreSQL, mất kết nối…) phải ra tới tầng gọi bằng một mã NGHIỆP VỤ ổn định kèm cờ
      // `retryable` — không để lộ mã thô của driver (`ERR_SQLITE_ERROR`, `40P01`…) rồi bị tầng
      // trên nuốt mất, biến thành "job chạy mà không ai thu tiền".
      const rawCode = String(err?.code ?? '');
      const text = `${rawCode} ${String(err?.message ?? '')}`;
      // F4 (phản biện R1, VỪA–CAO) — THỨ TỰ PHÂN LOẠI QUAN TRỌNG:
      //  (1) VI PHẠM UNIQUE của sổ là lỗi VĨNH VIỄN (đã có dòng rồi) ⇒ mã riêng, KHÔNG `retryable`
      //      (trước đây `SQLITE_ERROR` khớp regex busy ⇒ báo `LEDGER_BUSY` + `retryable: true`,
      //      client thử lại vô ích cho một xung đột không bao giờ tự khỏi);
      //  (2) transaction bị ABORT (`25P02`) ⇒ mã riêng `LEDGER_TX_ABORTED` để tầng gọi biết phải
      //      rollback về savepoint rồi đọc lại (không bao giờ để mã thô của driver ra ngoài);
      //  (3) còn lại mới là BẬN (tạm thời, `retryable: true`).
      const isConstraint = /SQLITE_CONSTRAINT|UNIQUE constraint failed|duplicate key value|23505|uniq_wallet_ledger/i.test(text);
      const isTxAborted = /25P02|current transaction is aborted/i.test(text);
      const isBusy = !isConstraint && !isTxAborted
        && /SQLITE_BUSY|database is locked|database table is locked|deadlock|40001|40P01|55P03|ECONNRESET|ETIMEDOUT/i.test(text);
      const wrapped = isConstraint
        ? new BillingError('LEDGER_CONFLICT', 'Dòng sổ cho lượt này đã có (ghi bởi tiến trình khác) — đọc lại thay vì ghi thêm.', {
          ...(details ?? {}),
          retryable: false,
          driver_code: rawCode || null,
        })
        : isTxAborted
          ? new BillingError('LEDGER_TX_ABORTED', 'Transaction của sổ đã bị huỷ — cần chạy lại trong transaction mới.', {
            ...(details ?? {}),
            retryable: true,
            driver_code: rawCode || null,
          })
          : isBusy
            ? new BillingError('LEDGER_BUSY', 'Sổ credit đang bận (khoá ghi/đua tiến trình) — thao tác chưa được ghi.', {
              ...(details ?? {}),
              retryable: true,
              driver_code: rawCode || null,
            })
            : err && rawCode
              ? new BillingError(rawCode, err.message || message, err.details ?? details)
              : new BillingError(code, message, details);
      wrapped.cause = err;
      throw wrapped;
    }
  }

  /** Chạy `fn` khi ĐẾN LƯỢT của user này (tuần tự hoá ghi sổ để `balance_after` không lệch). */
  async #withUserLock(userId, fn) {
    const key = String(userId);
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current, () => current);
    this.#locks.set(key, tail);
    // F5 (phản biện R1, VỪA): khoá TUẦN TỰ HOÁ theo user trong bộ nhớ trước đây không timeout ⇒
    // một thao tác ví treo làm mọi thao tác ví khác của CÙNG tiến trình đứng vĩnh viễn (đo được:
    // 3 probe timeout 6s). Nay hết `config.billing.lockTimeoutMs` (mặc định 5000ms) ⇒
    // `LEDGER_BUSY` kèm `retryable: true` — không bao giờ treo vô hạn.
    const waitMs = this.#lockTimeoutMs();
    let timer = null;
    try {
      await Promise.race([
        previous.catch(() => {}), // chờ lượt trước nhả khoá (kể cả khi lượt trước lỗi)
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(this.#asLedgerBusy(
              Object.assign(new Error(`Chờ khoá ví của user quá ${waitMs}ms — thao tác khác đang giữ.`), { code: 'DB_LOCK_TIMEOUT' }),
              0,
            ));
          }, waitMs);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      release();
      if (this.#locks.get(key) === tail) this.#locks.delete(key);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    try {
      return await fn();
    } finally {
      release();
      if (this.#locks.get(key) === tail) this.#locks.delete(key); // không để Map phình mãi
    }
  }

  /** F5 — trần chờ khoá ví/của user (ms): `config.billing.lockTimeoutMs`, mặc định 5000. */
  #lockTimeoutMs() {
    const raw = Number(this.config?.billing?.lockTimeoutMs);
    if (Number.isFinite(raw) && raw > 0) return Math.min(60000, Math.trunc(raw));
    return 5000;
  }

  /**
   * R1-B (§3) — CHẠY MỘT ĐOẠN GHI SỔ DƯỚI KHOÁ THEO NGƯỜI DÙNG.
   *
   * MỌI thao tác ghi (`grant`, `holdForJob`, `settleForJob`, `refundForJob`) PHẢI đi qua đây.
   * Thứ tự khoá, từ ngoài vào trong:
   *   1. `#locks` — hàng đợi promise TRONG TIẾN TRÌNH: rẻ, chặn trùng ngay tại chỗ và giữ
   *      cho `balance_after` không lệch khi cùng một tiến trình có nhiều request;
   *   2. `store.withLedgerLock(userId, fn)` — khoá Ở TẦNG DB (R1-Q, §2.2): đọc số dư + tính
   *      `balance_after` + ghi dòng sổ nằm trong CÙNG một transaction ⇒ đúng cả khi chạy
   *      NHIỀU tiến trình (SQLite transaction ghi + `busy_timeout`; PostgreSQL
   *      `pg_advisory_xact_lock`).
   *
   * R1-Q CHƯA LAND (`store.withLedgerLock` không phải hàm) ⇒ rơi về khoá bộ nhớ **kèm log
   * warn MỘT LẦN** và vẫn retry có giới hạn cho lỗi khoá của driver. Đây là đường TẠM THỜI:
   * nó KHÔNG bảo vệ được hai tiến trình (tầng DB vẫn là chốt chặn cuối), nên phải thấy rõ
   * trong log chứ không được im lặng.
   */
  async #withLedgerSection(userId, fn) {
    const key = String(userId);
    return this.#withUserLock(key, async () => {
      const depth = this.#sections.get(key) ?? 0;
      this.#sections.set(key, depth + 1);
      try {
        return await this.#runUnderDbLedgerLock(key, fn);
      } finally {
        // Trả lại đúng độ sâu cũ (khoá có thể lồng nhau: `reconcileStuckRuns` → `refundForJob`).
        if (depth === 0) this.#sections.delete(key);
        else this.#sections.set(key, depth);
      }
    });
  }

  /**
   * F4 (phản biện R1) — GHI SỔ TRONG SAVEPOINT khi đang ở trong transaction của khoá DB.
   *
   * Vì sao: trên PostgreSQL, INSERT vi phạm UNIQUE làm HỎNG cả transaction ⇒ câu SELECT phục hồi
   * (`#findRunRow`/`#closingRowOfRun`) sau đó nổ `25P02` và mã thô lọt ra ngoài. Với SAVEPOINT,
   * lỗi chỉ huỷ tới mốc, transaction vẫn dùng được ⇒ đường "đọc lại dòng đã có" chạy đúng và
   * KHÔNG bao giờ trả `25P02` cho client.
   *
   * Không có `savepoint` (SQLite: `node:sqlite` không cần vì lỗi UNIQUE chỉ huỷ câu lệnh) ⇒ gọi thẳng.
   */
  async #appendInSavepoint(payload) {
    const view = this.#currentTxView();
    if (view && typeof view.savepoint === 'function') {
      return view.savepoint('ledger_append', () => this.#append(payload));
    }
    return this.#append(payload);
  }

  /** View transaction ĐANG MỞ của ngữ cảnh async này (do `store.withLedgerLock` bơm vào callback). */
  #currentTxView() {
    return this.#txView ?? null;
  }

  /** Lớp khoá DB (nếu R1-Q đã cung cấp) + retry có giới hạn khi driver báo bận. */
  async #runUnderDbLedgerLock(userId, fn) {
    const store = this.#requireStore();
    const dbLock = typeof store.withLedgerLock === 'function'
      ? (callback) => store.withLedgerLock(userId, callback)
      : null;
    // Có khoá DB ⇒ việc THỬ LẠI thuộc về tầng store (R1-Q §3: `BEGIN IMMEDIATE` + retry riêng):
    // billing KHÔNG nhân đôi ngân sách chờ (mỗi lần thử của store đã có `busy_timeout`), chỉ
    // chuẩn hoá lỗi bận thành `LEDGER_BUSY`. Không có khoá DB ⇒ billing tự retry (đường dự phòng).
    let retries = 0;
    if (dbLock) this.#noteLockMode('db');
    else {
      this.#noteLockMode('memory');
      this.#warnLockFallback();
      retries = this.lockRetries;
    }
    return this.#retryLedgerBusy(
      userId,
      () => (dbLock
        ? dbLock((tx) => {
          // Ghi lại view transaction để `#appendInSavepoint` dùng được SAVEPOINT (F4).
          const prev = this.#txView;
          this.#txView = tx ?? null;
          try {
            return fn(tx);
          } finally {
            this.#txView = prev;
          }
        })
        : fn()),
      retries,
    );
  }

  /**
   * Retry CÓ GIỚI HẠN cho lỗi "bận/khoá" của driver (đường DỰ PHÒNG khi thiếu khoá DB).
   *
   * An toàn để thử lại vì cả hai driver đều bảo đảm: transaction LỖI thì KHÔNG commit
   * (SQLite trả `SQLITE_BUSY` khi COMMIT ⇒ transaction còn mở rồi bị ROLLBACK; PostgreSQL
   * huỷ transaction) — nên lần thử lại đọc sổ từ đầu và không thể ghi trùng. Hết lượt (hoặc
   * quá tổng ngân sách) ⇒ `LEDGER_BUSY` kèm `retryable: true` (tầng trên map thành 503
   * `BILLING_UNAVAILABLE`) — fail-closed, KHÔNG treo request.
   */
  async #retryLedgerBusy(userId, run, maxRetries = this.lockRetries) {
    const startedAt = Date.now();
    // F4 (phản biện R1): transaction bị ABORT (`25P02`, hoặc `LEDGER_TX_ABORTED`) ⇒ mọi câu lệnh
    // sau đó trong CÙNG transaction đều lỗi. Cách chữa ĐÚNG là chạy lại TOÀN BỘ section trong một
    // transaction MỚI: lần chạy lại bắt đầu bằng bước ĐỌC sổ nên thấy ngay dòng mà tiến trình kia
    // đã ghi (idempotent theo `(job_id, run_key)`), không ghi thêm — thay vì để mã thô `25P02`
    // hoặc `LEDGER_BUSY` (cờ `retryable` cho một xung đột vĩnh viễn) lọt ra ngoài.
    let abortRetries = 0;
    const isAborted = (err) => {
      const text = `${err?.code ?? ''} ${err?.details?.cause_code ?? ''} ${err?.details?.driver_code ?? ''} ${err?.message ?? ''}`;
      return /25P02|current transaction is aborted|LEDGER_TX_ABORTED/i.test(text);
    };
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run();
      } catch (err) {
        if (isAborted(err) && abortRetries < LEDGER_TX_ABORT_RETRIES) {
          abortRetries += 1;
          this.logger?.warn?.('billing.ledger_tx_aborted_retry', {
            user_id: userId,
            attempt: abortRetries,
            hint: 'transaction bị huỷ (unique violation) — chạy lại section trong transaction mới để ĐỌC LẠI dòng đã có',
          });
          await sleep(Math.max(1, this.lockRetryBaseMs));
          continue;
        }
        if (!isLedgerBusyError(err)) throw err;
        const outOfBudget = Date.now() - startedAt > LEDGER_LOCK_RETRY_BUDGET_MS;
        if (attempt >= maxRetries || outOfBudget) throw this.#asLedgerBusy(err, attempt);
        const wait = Math.min(this.lockRetryBaseMs * 2 ** attempt, LEDGER_LOCK_RETRY_MAX_MS);
        // Nhiễu ±25% để hai tiến trình đập vào nhau không thức dậy cùng một nhịp.
        const delay = Math.max(1, Math.round(wait * (0.75 + Math.random() * 0.5)));
        this.logger?.warn?.('billing.ledger_lock_retry', {
          user_id: userId,
          attempt: attempt + 1,
          retries: maxRetries,
          delay_ms: delay,
          error_code: err?.code ?? null,
          hint: 'đua ghi sổ giữa các tiến trình — thử lại (đọc lại số dư rồi quyết định lại)',
        });
        await sleep(delay);
      }
    }
  }

  /** Chuẩn hoá lỗi hết lượt thử thành `LEDGER_BUSY` (fail-closed, có cờ `retryable`). */
  #asLedgerBusy(err, attempts) {
    if (err instanceof BillingError && err.code === 'LEDGER_BUSY') return err;
    const wrapped = new BillingError(
      'LEDGER_BUSY',
      `Sổ credit đang bận sau ${attempts} lần thử lại — thao tác CHƯA được ghi (an toàn để thử lại).`,
      { retryable: true, attempts, driver_code: err?.code ?? null },
    );
    wrapped.cause = err;
    return wrapped;
  }

  /** Ghi log MỘT LẦN chế độ khoá đang dùng — vận hành phải biết mình đang được bảo vệ thế nào. */
  #noteLockMode(mode) {
    if (this.#lockModeLogged) return;
    this.#lockModeLogged = true;
    if (mode === 'db') {
      this.logger?.info?.('billing.ledger_lock_mode', { mode: 'db', method: 'store.withLedgerLock', contract: 'R1 §3' });
    }
  }

  /** Cảnh báo MỘT LẦN: chưa có khoá DB ⇒ chỉ đúng trong MỘT tiến trình. */
  #warnLockFallback() {
    if (this.#lockFallbackWarned) return;
    this.#lockFallbackWarned = true;
    this.logger?.warn?.('billing.ledger_lock_fallback', {
      mode: 'memory',
      missing: 'store.withLedgerLock',
      reason: 'R1-Q chưa cung cấp khoá ví ở tầng DB — tạm dùng khoá TRONG TIẾN TRÌNH + retry có giới hạn.',
      risk: 'hai TIẾN TRÌNH cùng user có thể đua: tầng DB vẫn chặn số dư âm và dòng trùng (unique index), nhưng thứ tự `balance_after` có thể lệch.',
      contract: 'docs/R1-RELIABILITY-CONTRACT.md §3',
    });
  }

  /** Số dư ĐỌC TỪ SỔ, đã làm tròn. Chỉ gọi bên trong khoá của user. */
  async #balanceLocked(userId) {
    const store = this.#requireMethod('ledgerBalance');
    const raw = await this.#callStore(() => store.ledgerBalance(userId), {
      code: 'LEDGER_READ_FAILED',
      message: 'Không đọc được số dư từ sổ credit.',
      details: { user_id: userId },
    });
    return roundMoney(parseBalanceResult(raw).amount);
  }

  /**
   * Các dòng sổ của MỘT job. Ưu tiên để store lọc theo `jobId`; nếu store bỏ qua tham
   * số đó thì vẫn đúng nhờ tự lọc lại + phân trang (offset tiến theo số dòng THẬT nhận được,
   * nên store có kẹp `limit` thấp hơn yêu cầu cũng không bỏ sót trang).
   */
  async #jobRows(userId, jobId) {
    const store = this.#requireMethod('listLedger');
    const found = [];
    let offset = 0;
    let scanned = 0;
    for (;;) {
      const rows = await this.#callStore(
        () => store.listLedger({ userId, jobId, limit: LEDGER_PAGE_SIZE, offset }),
        {
          code: 'LEDGER_READ_FAILED',
          message: 'Không đọc được sổ credit.',
          details: { user_id: userId, job_id: jobId },
        },
      );
      const list = Array.isArray(rows) ? rows : [];
      if (list.length === 0) break;
      scanned += list.length;
      for (const row of list) {
        const normalized = normalizeLedgerRow(row);
        if (normalized && String(normalized.job_id ?? '') === jobId) found.push(normalized);
      }
      if (scanned >= LEDGER_MAX_SCAN) {
        this.logger?.warn?.('billing.ledger_scan_truncated', {
          user_id: userId,
          job_id: jobId,
          scanned,
          limit: LEDGER_MAX_SCAN,
          hint: 'store.listLedger nên lọc theo jobId ở tầng SQL (hợp đồng §3.4)',
        });
        break;
      }
      offset += list.length;
    }
    return found;
  }

  /**
   * R1-B (§3) — ĐỌC LẠI SỔ sau khi thua cuộc đua ở tầng DB (unique index): dòng CUỐI CÙNG
   * của một lượt chạy theo `reason`. Trả `null` nếu không có ⇒ tầng gọi ném lỗi gốc
   * (fail-closed, không đoán bừa là "chắc ai đó đã ghi rồi").
   */
  async #findRunRow(userId, jobId, runKey, reason) {
    if (!runKey) return null;
    const rows = await this.#jobRows(userId, jobId);
    return findLast(rows.filter((row) => runKeyOf(row) === runKey), (row) => row.reason === reason) ?? null;
  }

  /** Dòng ĐÓNG của một lượt (`job_settle` ưu tiên, sau đó `job_refund`) — dùng khi thua cuộc đua ghi dòng đóng. */
  async #closingRowOfRun(userId, jobId, runKey) {
    if (!runKey) return null;
    const rows = await this.#jobRows(userId, jobId);
    const runRows = rows.filter((row) => runKeyOf(row) === runKey);
    return findLast(runRows, (row) => row.reason === 'job_settle')
      ?? findLast(runRows, (row) => row.reason === 'job_refund')
      ?? null;
  }

  /**
   * GHI MỘT DÒNG SỔ (append-only). Chỉ gọi khi ĐANG giữ khoá của user và đã có
   * `balanceBefore` đọc từ sổ. Không bao giờ để số dư âm: nếu phép cộng ra âm thì
   * ném `INSUFFICIENT_CREDIT` và KHÔNG ghi gì.
   */
  async #append({ userId, amount, reason, jobId = null, operation = null, meta = null, balanceBefore, runKey = null }) {
    const store = this.#requireMethod('appendLedger');
    // R1-B (§3) — CHỐT CHẶN: không được ghi sổ ngoài khoá theo người dùng. Nếu một đường code
    // mới quên `#withLedgerSection`, dừng ngay (fail-closed) thay vì âm thầm ghi lệch số dư.
    if ((this.#sections.get(String(userId)) ?? 0) <= 0) {
      throw new BillingError(
        'LEDGER_LOCK_REQUIRED',
        'Ghi sổ credit phải chạy trong khoá theo người dùng (R1 §3) — đã chặn để không ghi lệch số dư.',
        { user_id: userId, reason },
      );
    }
    const currency = this.#currency();
    // PB-06: khoản ghi sổ phải HỮU HẠN và trong trần — `roundMoney(1e308) === Infinity` và
    // tầng store biến nó thành 0 ⇒ sổ ghi "0 credit" trong khi API báo thành công.
    const checkedDelta = normalizeAmount(amount, { max: this.maxAmount, allowZero: true });
    if (!checkedDelta.ok) {
      throw new BillingError(checkedDelta.code, `Khoản ghi sổ không hợp lệ (${checkedDelta.reason}).`, {
        amount: checkedDelta.amount,
        max: this.maxAmount,
        reason,
      });
    }
    const delta = checkedDelta.value;
    const afterRaw = roundMoney(balanceBefore + delta);
    if (afterRaw < -MONEY_EPSILON) {
      throw new BillingError(
        'INSUFFICIENT_CREDIT',
        `Thao tác sẽ làm số dư âm (${afterRaw} ${currency}) — đã chặn, KHÔNG ghi dòng nào.`,
        { balance: balanceBefore, amount: delta, currency },
      );
    }
    const balanceAfter = afterRaw < 0 ? 0 : afterRaw; // chặn -0 và nhiễu float
    const payload = {
      userId,
      amount: roundMoney(balanceAfter - balanceBefore),
      currency,
      reason,
      jobId,
      operation,
      runKey: runKey ?? null,
      meta: meta ?? null,
      balanceAfter,
    };
    const returned = await this.#callStore(() => store.appendLedger(payload), {
      code: 'LEDGER_WRITE_FAILED',
      message: 'Không ghi được dòng sổ credit.',
      details: { user_id: userId, reason, job_id: jobId },
      event: 'billing.ledger_append_failed',
    });
    const row = normalizeLedgerRow(pickReturnedRow(returned, payload));
    if (!row?.id) {
      // Không có id vẫn không sai sổ, nhưng `holdForJob` không trả được ledgerId ⇒ phải thấy trong log.
      this.logger?.warn?.('billing.ledger_append_without_id', { user_id: userId, reason, job_id: jobId });
    }
    this.logger?.info?.('billing.ledger_appended', {
      user_id: userId,
      reason,
      job_id: jobId,
      amount: payload.amount,
      balance_after: balanceAfter,
    });
    return row;
  }

  /* ───────────────────────────────── bảng giá ───────────────────────────────── */

  /**
   * §3.2 — đơn giá một operation: bảng `pricing` (A3) trước, thiếu thì `config.cost`
   * (MVP-01 — nguồn giá mặc định), vẫn thiếu thì `UNKNOWN_OPERATION`.
   * KHÔNG BAO GIỜ bịa ra giá 0: giá 0 nghĩa là miễn phí, sai nghiệp vụ.
   */
  async priceOf(operation) {
    const op = typeof operation === 'string' ? operation.trim() : '';
    if (!op) {
      throw new BillingError('UNKNOWN_OPERATION', `Tên operation không hợp lệ: ${JSON.stringify(operation ?? null)}`);
    }

    const row = await this.#findPricingRow(op);
    const fromTable = toFiniteNumber(row?.unit_price);
    if (fromTable !== null && fromTable >= 0) {
      return {
        operation: op,
        unit_price: fromTable,
        currency: typeof row?.currency === 'string' && row.currency.trim() ? row.currency.trim() : this.#currency(),
      };
    }

    const fromConfig = toFiniteNumber(this.#costTable()[op]);
    if (fromConfig !== null && fromConfig >= 0) {
      return { operation: op, unit_price: fromConfig, currency: this.#currency() };
    }

    throw new BillingError(
      'UNKNOWN_OPERATION',
      `Không có đơn giá cho operation "${op}" (bảng pricing không có và config.cost cũng không có khoá này).`,
      { operation: op },
    );
  }

  /** Đọc bảng `pricing` — best-effort: store chưa nối/đọc lỗi thì rơi về `config.cost`. */
  async #findPricingRow(operation) {
    const store = this.store;
    if (typeof store?.listPricing !== 'function') return null;
    try {
      const rows = await store.listPricing();
      if (!Array.isArray(rows)) return null;
      for (const raw of rows) {
        const row = normalizePricingRow(raw);
        if (row && row.operation === operation) return row;
      }
      return null;
    } catch (err) {
      this.logger?.warn?.('billing.pricing_read_failed', {
        operation,
        error: err?.message ?? String(err),
        hint: 'rơi về config.cost',
      });
      return null;
    }
  }

  /**
   * §3.2 — ước tính chi phí. `operations` là mảng tên operation (hoặc `{operation, count}`).
   * Chỉ tính GIÁ, không chạm ví ⇒ chạy được cả cho ẩn danh (tầng gọi tự bỏ qua billing).
   * `lines` gộp theo từng operation kèm `count`/`subtotal` để route/UI hiện được bảng giá.
   */
  async estimate({ userId = null, operations = [] } = {}) {
    void userId; // estimate không phụ thuộc ví — cố ý không ném ANONYMOUS_NO_WALLET
    const counts = countOperations(operations);
    const currency = this.#currency();
    const lines = [];
    for (const [operation, count] of counts) {
      const price = await this.priceOf(operation);
      if (price.currency !== currency) {
        this.logger?.warn?.('billing.estimate_currency_mismatch', {
          operation,
          price_currency: price.currency,
          wallet_currency: currency,
        });
      }
      lines.push({
        operation,
        unit_price: price.unit_price,
        count,
        subtotal: roundMoney(price.unit_price * count),
      });
    }
    return { total: sumMoney(lines.map((line) => line.subtotal)), currency, lines };
  }

  /* ─────────────────────────────────── ví ─────────────────────────────────── */

  /**
   * §3.2 — số dư = TỔNG SỔ (`store.ledgerBalance`). Không có cột số dư nào để sửa tay.
   * Ẩn danh ⇒ `ANONYMOUS_NO_WALLET`.
   */
  async balance(userId) {
    const uid = this.#requireUserId(userId);
    const store = this.#requireMethod('ledgerBalance');
    const raw = await this.#callStore(() => store.ledgerBalance(uid), {
      code: 'LEDGER_READ_FAILED',
      message: 'Không đọc được số dư từ sổ credit.',
      details: { user_id: uid },
    });
    const { amount, currency } = parseBalanceResult(raw);
    return { amount: roundMoney(amount), currency: currency || this.#currency() };
  }

  /**
   * §3.2 — cấp credit bằng tay (MVP-05 CHỈ nạp credit theo cách này).
   * `reason`: 'grant' (tặng khi đăng ký) | 'admin_grant' (admin cấp) | 'adjustment' (cấp bù).
   * Mặc định: có `actorId` ⇒ 'admin_grant', không ⇒ 'grant'.
   */
  async grant({ userId, amount, reason, actorId = null, note = '' } = {}) {
    const uid = this.#requireUserId(userId);
    const raw = toFiniteNumber(amount);
    // PB-06 (vòng 2): `normalizeAmount` TỪ CHỐI tràn số (1e308 ⇒ Infinity) và vượt trần
    // `billing.maxAmount` — trước đây sổ ghi một dòng `amount = 0` mà API vẫn báo 201.
    const checked = normalizeAmount(amount, { max: this.maxAmount });
    if (!checked.ok) {
      throw new BillingError(checked.code, `Số credit không hợp lệ: ${JSON.stringify(amount ?? null)} (${checked.reason})`, {
        amount: raw,
        max: checked.max ?? this.maxAmount,
      });
    }
    const value = checked.value;
    const picked = typeof reason === 'string' && reason.trim()
      ? reason.trim()
      : (actorId ? 'admin_grant' : 'grant');
    if (!MANUAL_GRANT_REASONS.includes(picked)) {
      throw new BillingError('INVALID_REASON', `Lý do cấp credit không hợp lệ: ${JSON.stringify(picked)}`, {
        reason: picked,
        allowed: [...MANUAL_GRANT_REASONS],
      });
    }
    const meta = { actor_id: typeof actorId === 'string' && actorId.trim() ? actorId.trim() : null, note: note ? String(note) : '' };
    // R1-B (§3): đọc số dư + ghi dòng `grant` nằm TRONG khoá DB theo user.
    return this.#withLedgerSection(uid, async () => {
      const balanceBefore = await this.#balanceLocked(uid);
      return this.#append({ userId: uid, amount: value, reason: picked, meta, balanceBefore });
    });
  }

  /**
   * §3.2 — GIỮ TIỀN TRƯỚC KHI CHẠY JOB: ghi ĐÚNG MỘT dòng âm `-estimate` với
   * `reason='job_hold'`. Thiếu credit ⇒ `INSUFFICIENT_CREDIT` và KHÔNG ghi gì (nhờ vậy
   * route trả 402 TRƯỚC khi tạo job — không tiêu tiền của người dùng rồi mới báo thiếu).
   * `estimate <= 0` ⇒ job miễn phí: không ghi dòng nào, trả `{ ledgerId: null, balance_after }`.
   *
   * `estimate` nhận số, chuỗi số, HOẶC nguyên cả object `{ total, lines }` mà `estimate()` trả về
   * (hook pipeline hay truyền kiểu này). Không có `operations` thì lấy luôn từ `estimate.lines`
   * để `meta.operations` vẫn ghi được dấu vết đã giữ tiền cho những bước nào.
   */
  async holdForJob({ userId, jobId, estimate: estimateValue, operations = null, runKey = null, maxRunsPerJob = null } = {}) {
    const uid = this.#requireUserId(userId);
    const jid = requireJobId(jobId);
    const estimateObject = estimateValue && typeof estimateValue === 'object' ? estimateValue : null;
    const ops = operations ?? (Array.isArray(estimateObject?.lines) ? estimateObject.lines : null);

    let value = toFiniteNumber(estimateValue);
    if (value === null && estimateObject) value = toFiniteNumber(estimateObject.total ?? estimateObject.estimate);
    if (value === null) {
      if (ops !== null && ops !== undefined) {
        value = (await this.estimate({ operations: ops })).total;
      } else {
        this.logger?.warn?.('billing.hold_without_estimate', { user_id: uid, job_id: jid });
        value = 0;
      }
    }
    if (value < 0) {
      throw new BillingError('INVALID_AMOUNT', `Chi phí ước tính không được âm: ${value}`, { estimate: value });
    }
    const amount = roundMoney(value);
    const operationNames = listOperationNames(ops);

    const runsCap = toFiniteNumber(maxRunsPerJob);

    // R1-B (§3): chọn lượt chạy + đọc số dư + ghi `job_hold` nằm TRONG khoá DB theo user.
    return this.#withLedgerSection(uid, async () => {
      const rows = await this.#jobRows(uid, jid);

      // (b0) PB-02: chọn LƯỢT CHẠY để giữ tiền — lượt đang mở nếu có (idempotent theo run),
      //      ngược lại mở lượt MỚI. Đây là chỗ sửa lỗi "chạy lại cùng jobId = miễn phí".
      const asked = typeof runKey === 'string' && runKey.trim() ? runKey.trim() : '';
      const openRun = openRunKeyOf(rows);
      const targetRun = asked || openRun || nextRunKeyOf(rows, jid);

      // (b0b) Trần số lượt chạy có tính tiền cho mỗi job ⇒ vượt thì TỪ CHỐI (route map 429).
      if (runsCap !== null && runsCap > 0) {
        // BR-05: chỉ đếm lượt CÓ THU (lượt lỗi đã hoàn không khoá job).
        const known = runKeysOf(rows);
        const billable = [...new Set(rows.filter((row) => {
          const key = runKeyOf(row);
          if (!key) return false;
          if (row.reason === 'job_settle') return true;
          if (row.reason === 'job_hold') return !rows.some((x) => x.reason === 'job_refund' && runKeyOf(x) === key);
          return false;
        }).map(runKeyOf))];
        const already = known.includes(targetRun);
        if (!already && billable.length >= runsCap) {
          throw new BillingError(
            'RERUN_LIMIT_EXCEEDED',
            `Job đã chạy ${billable.length} lượt có tính tiền — vượt trần ${runsCap} lượt mỗi job. Hãy tạo job mới.`,
            { job_id: jid, runs: billable.length, max_runs: runsCap },
          );
        }
      }

      // (b) LƯỢT CHẠY NÀY đang được giữ tiền (gọi lại cùng run) ⇒ không giữ lần hai.
      if (openRun === targetRun && heldOfRun(rows, targetRun) > 0) {
        const currentHold = findLast(rows.filter((row) => runKeyOf(row) === targetRun), (row) => row.reason === 'job_hold');
        return { ledgerId: currentHold?.id ?? null, balance_after: await this.#balanceLocked(uid), run_key: targetRun, skipped: true };
      }

      const balanceBefore = await this.#balanceLocked(uid);

      // (a) Job miễn phí: KHÔNG ghi dòng 0 — sổ sạch, không nhiễu.
      if (amount <= 0) return { ledgerId: null, balance_after: balanceBefore, run_key: targetRun };

      // (c) Thiếu credit ⇒ ném lỗi TRƯỚC, không ghi gì.
      if (balanceBefore - amount < -MONEY_EPSILON) {
        throw new BillingError(
          'INSUFFICIENT_CREDIT',
          `Không đủ credit: cần ${amount} ${this.#currency()}, ví chỉ còn ${balanceBefore} ${this.#currency()}.`,
          {
            required: amount,
            balance: balanceBefore,
            shortfall: roundMoney(amount - balanceBefore),
            currency: this.#currency(),
          },
        );
      }

      const meta = { estimate: amount, operations: operationNames, run_key: targetRun };
      let row;
      try {
        row = await this.#appendInSavepoint({
          userId: uid,
          amount: -amount,
          reason: 'job_hold',
          jobId: jid,
          runKey: targetRun,
          operation: singleOperation(operationNames),
          meta,
          balanceBefore,
        });
      } catch (err) {
        // R1-B (§3) — THUA CUỘC ĐUA khi thiếu khoá DB: unique index
        // `uniq_wallet_ledger_run_reason (user_id, job_id, run_key, reason)` chặn dòng thứ hai.
        // Đọc lại sổ và trả về khoản ĐÃ GIỮ (idempotent theo `(job_id, run_key)`) — tuyệt đối
        // KHÔNG giữ tiền hai lần; không tìm thấy dòng nào thì ném lỗi gốc (fail-closed).
        const raced = isUniqueLedgerViolation(err) ? await this.#findRunRow(uid, jid, targetRun, 'job_hold') : null;
        if (!raced) throw err;
        this.logger?.warn?.('billing.hold_run_race_recovered', { user_id: uid, job_id: jid, run_key: targetRun });
        return { ledgerId: raced.id ?? null, balance_after: await this.#balanceLocked(uid), run_key: targetRun, skipped: true };
      }
      return { ledgerId: row?.id ?? null, balance_after: row?.balance_after ?? balanceBefore, run_key: targetRun };
    });
  }

  /**
   * §3.2 — QUYẾT TOÁN job theo chi phí THẬT: hoàn phần chênh (dòng `+` nếu giữ nhiều hơn,
   * dòng `-` nếu giữ ít hơn). Không bao giờ để số dư âm: nếu thiếu thì chỉ ghi tối đa bằng
   * số dư hiện có và ghi rõ `meta.shortfall`.
   *
   * IDEMPOTENT theo `jobId`: đã có dòng `job_settle` cho job ⇒ trả dòng CŨ, không ghi mới
   * (gọi 2 lần không hoàn 2 lần). Dòng `job_settle` được ghi cả khi chênh lệch = 0 — đó là
   * dấu "job này đã quyết toán", thiếu nó thì không phân biệt được "chưa settle" và
   * "settle đúng bằng phần đã giữ".
   *
   * `actualCost` bỏ trống ⇒ đọc `usage_events` thật của job (`store.usageSummary` — G13).
   * Job không giữ tiền và chi phí thật = 0 ⇒ không có gì để quyết toán, trả `null`.
   */
  async settleForJob({ userId, jobId, actualCost, runKey = null } = {}) {
    const uid = this.#requireUserId(userId);
    const jid = requireJobId(jobId);

    // R1-B (§3): quyết toán chạy trong khoá DB theo user (đọc sổ + ghi dòng `job_settle` cùng transaction).
    return this.#withLedgerSection(uid, async () => {
      const rows = await this.#jobRows(uid, jid);
      // PB-02: quyết toán theo LƯỢT CHẠY. Lượt mặc định = lượt đang mở; nếu không còn lượt mở
      // (chế độ `holdBeforeJob=false`, hoặc lượt đã bị hoàn) thì dùng lượt mới nhất đã thấy,
      // cuối cùng mới mở khoá mới.
      const runs = runKeysOf(rows);
      const asked = typeof runKey === 'string' && runKey.trim() ? runKey.trim() : '';
      const targetRun = asked || openRunKeyOf(rows) || runs[runs.length - 1] || nextRunKeyOf(rows, jid);

      // IDEMPOTENT THEO LƯỢT: lượt này đã settle/refund ⇒ trả dòng cũ, KHÔNG ghi thêm.
      const runRows = rows.filter((row) => runKeyOf(row) === targetRun);
      const existing = findLast(runRows, (row) => row.reason === 'job_settle');
      if (existing) return existing;
      const refundRow = findLast(runRows, (row) => row.reason === 'job_refund');
      if (refundRow) {
        // A3 (phản biện R1 vòng 2, VỪA) — QUYẾT TOÁN MUỘN SAU KHI ĐÃ HOÀN.
        //
        // Ca thật đo được: lượt bị CƯỚP (SIGSTOP/mất lease) ⇒ bản chạy trùng thất bại ⇒ hoàn tiền;
        // bản GỐC chạy xong THÀNH CÔNG ⇒ settle bị từ chối vì lượt đã đóng ⇒ **sản phẩm miễn phí**
        // (mất 10 credit/lượt). Luật "một chu kỳ một lần" vẫn giữ, nhưng khi việc ĐÃ XONG thì phải
        // THU được: ghi một dòng `job_settle` BÙ với khoá lượt `<runKey>#late` (không đụng unique
        // index của lượt gốc) và ghi vết `meta.late_settle_after_refund`.
        const job = typeof this.store?.getJob === 'function' ? await this.store.getJob(jid).catch(() => null) : null;
        const lateRun = `${targetRun}#late`;
        const lateRows = rows.filter((row) => runKeyOf(row) === lateRun);
        const lateExisting = findLast(lateRows, (row) => row.reason === 'job_settle');
        if (lateExisting) return lateExisting;
        // `settleForJob` là API của đường THÀNH CÔNG (app.js gọi khi job xong; job hỏng thì đi
        // `refundForJob`) ⇒ không có dòng job (hoặc job chưa có trạng thái) thì TIN tầng gọi.
        // Chỉ giữ nguyên việc hoàn tiền khi BIẾT CHẮC job đã hỏng.
        const jobStatus = job?.status === undefined || job?.status === null ? null : String(job.status);
        if (jobStatus !== null && jobStatus !== 'succeeded') return refundRow
        let lateCost = toFiniteNumber(actualCost);
        if (lateCost === null || lateCost <= MONEY_EPSILON) {
          const usage = await this.#usageCostOfRun(jid, targetRun, rows);
          lateCost = usage ? usage.cost : 0;
        }
        if (!(lateCost > MONEY_EPSILON)) return refundRow; // không quy được chi phí ⇒ không thu
        const lateBalance = await this.#balanceLocked(uid);
        const late = await this.#appendInSavepoint({
          userId: uid,
          amount: -lateCost,
          reason: 'job_settle',
          jobId: jid,
          runKey: lateRun,
          meta: {
            late_settle_after_refund: true,
            refunded_run_key: targetRun,
            refund_amount: Number(refundRow.amount) || 0,
            cost: lateCost,
            usage_source: toFiniteNumber(actualCost) !== null ? 'request' : 'run',
          },
          balanceBefore: lateBalance,
        });
        this.logger?.warn?.('billing.late_settle_after_refund', {
          user_id: uid,
          job_id: jid,
          run_key: targetRun,
          late_run_key: lateRun,
          cost: lateCost,
        });
        return late;
      }

      let actual = toFiniteNumber(actualCost);
      let usageUnavailable = false;
      let legacyCounted = null; // BR-09: số dòng usage KHÔNG gắn lượt đã tính (tích luỹ)
      // BR-11: nguồn chi phí — 'request' (caller truyền) | 'run' | 'legacy' | 'none' | 'unavailable'
      let usageSource = toFiniteNumber(actualCost) !== null ? 'request' : null;
      if (actual === null && (actualCost === undefined || actualCost === null)) {
        // BR-07 (vòng 3): chi phí THẬT của **RIÊNG LƯỢT NÀY** — trước đây lấy tổng usage của
        // cả job nên lượt thứ n thu luôn chi phí của mọi lượt trước (đo được: +100…+150%).
        // BR-09 (vòng 4): không quy được usage về lượt ⇒ KHÔNG thu (thà thu thiếu) + ghi vết.
        const usage = await this.#usageCostOfRun(jid, targetRun, rows);
        if (!usage) {
          // Không đọc được usage ⇒ KHÔNG thu, và phải để lại VẾT rõ ràng (BR-11).
          usageUnavailable = true;
          usageSource = 'unavailable';
          actual = 0;
          this.logger?.warn?.('billing.usage_unavailable', { user_id: uid, job_id: jid, run_key: targetRun, reason: 'unreadable' });
        } else {
          actual = usage.cost;
          legacyCounted = usage.legacy_counted;
          usageSource = usage.source;
          if (usage.source === 'unavailable') {
            usageUnavailable = true;
            this.logger?.warn?.('billing.usage_unavailable', {
              user_id: uid,
              job_id: jid,
              run_key: targetRun,
              reason: 'no_event_of_this_run',
              usage_events: 'có dòng usage nhưng KHÔNG thuộc lượt này (đã hoàn/lượt khác) ⇒ thu 0',
            });
          }
        }
      }
      if (actual === null || actual < 0) {
        throw new BillingError(
          'INVALID_AMOUNT',
          `Chi phí thật không hợp lệ: ${JSON.stringify(actualCost ?? null)} (không đọc được từ usage_events).`,
          { actual_cost: actual },
        );
      }
      actual = roundMoney(actual);

      const held = heldOfRun(rows, targetRun);
      if (held <= MONEY_EPSILON && actual <= MONEY_EPSILON) {
        this.logger?.info?.('billing.settle_noop', { user_id: uid, job_id: jid, run_key: targetRun, held, actual_cost: actual });
        return null; // lượt chạy miễn phí — không có gì để quyết toán
      }

      const balanceBefore = await this.#balanceLocked(uid);
      const delta = roundMoney(actual - held); // >0: giữ thiếu (thu thêm) | <0: giữ thừa (hoàn lại)
      let amount = roundMoney(-delta);
      let shortfall = 0;
      if (amount < 0 && balanceBefore + amount < -MONEY_EPSILON) {
        const chargeable = roundMoney(Math.max(0, balanceBefore)); // thu tối đa bằng số dư hiện có
        shortfall = roundMoney(-amount - chargeable);
        amount = -chargeable;
        this.logger?.warn?.('billing.settle_shortfall', {
          user_id: uid,
          job_id: jid,
          shortfall,
          balance: balanceBefore,
        });
      }

      const meta = { held, actual_cost: actual, delta, run_key: targetRun };
      // BR-09: đánh dấu đã tính bao nhiêu dòng usage KHÔNG gắn lượt (để lượt sau không thu lại).
      if (legacyCounted !== null) meta.legacy_usage_counted = Math.trunc(legacyCounted);
      if (shortfall > 0) meta.shortfall = shortfall;
      if (usageUnavailable) meta.usage_unavailable = true; // BR-09/BR-11: thu 0 vì không quy được usage
      // BR-11: LUÔN ghi nguồn chi phí ⇒ đọc sổ là biết "job không tốn gì" hay "không quy được usage".
      meta.usage_source = usageSource ?? (actual <= MONEY_EPSILON ? 'none' : 'request');
      try {
        return await this.#appendInSavepoint({ userId: uid, amount, reason: 'job_settle', jobId: jid, runKey: targetRun, meta, balanceBefore });
      } catch (err) {
        // R1-B (§3) — thua cuộc đua với tiến trình khác (unique index `uniq_wallet_ledger_run_close`
        // cho phép ĐÚNG MỘT dòng đóng mỗi lượt): đọc lại, trả dòng đóng đã có, KHÔNG ghi thêm.
        const raced = isUniqueLedgerViolation(err) ? await this.#closingRowOfRun(uid, jid, targetRun) : null;
        if (!raced) throw err;
        this.logger?.warn?.('billing.settle_run_race_recovered', { user_id: uid, job_id: jid, run_key: targetRun, close_reason: raced.reason });
        return raced;
      }
    });
  }

  /**
   * §3.2 — HOÀN 100% PHẦN ĐANG GIỮ của job (job `failed`): tổng `job_hold` trừ các
   * `job_settle`/`job_refund` đã có. Không hoàn quá phần đang giữ; job không có
   * `job_hold` ⇒ không ghi gì.
   *
   * Idempotent mà vẫn đúng khi RETRY: lần gọi thứ hai thấy phần đang giữ = 0 ⇒ không ghi;
   * nhưng nếu job được giữ tiền lại (retry sau khi hoàn) thì lần hoàn sau vẫn hoạt động.
   *
   * `reason` ở đây là LÝ DO NGHIỆP VỤ (lưu ở `meta.reason`, mặc định 'job_failed');
   * cột `reason` của sổ LUÔN là 'job_refund' vì đó là giá trị đã đóng băng ở §2.1.
   */
  async refundForJob({ userId, jobId, reason = '', runKey = null, meta: extraMeta = null } = {}) {
    const uid = this.#requireUserId(userId);
    const jid = requireJobId(jobId);
    const note = typeof reason === 'string' && reason.trim() ? reason.trim() : 'job_failed';

    // R1-B (§3): hoàn tiền chạy trong khoá DB theo user (đọc sổ + ghi dòng `job_refund` cùng transaction).
    return this.#withLedgerSection(uid, async () => {
      const rows = await this.#jobRows(uid, jid);
      const runs = runKeysOf(rows);
      const asked = typeof runKey === 'string' && runKey.trim() ? runKey.trim() : '';
      const targetRun = asked || openRunKeyOf(rows) || runs[runs.length - 1] || '';
      const runRows = targetRun ? rows.filter((row) => runKeyOf(row) === targetRun) : rows;

      // PB-04 (vòng 2): TUYỆT ĐỐI không hoàn phần ĐÃ TIÊU. Nếu lượt này đã có `job_settle`
      // thì khoản "còn giữ" theo công thức `-(tổng job_*)` chính là SỐ ĐÃ THU — hoàn nó là
      // TẠO TIỀN (đo được ở `atk7-race.mjs` §7.3/§7.4: 20/20 lần job thành miễn phí).
      if (runRows.some((row) => row.reason === 'job_settle')) {
        return findLast(runRows, (row) => row.reason === 'job_settle'); // đã quyết toán ⇒ không hoàn gì thêm
      }
      const remaining = heldOfRun(rows, targetRun);
      if (remaining <= MONEY_EPSILON) {
        if (!runRows.some((row) => row.reason === 'job_hold')) {
          this.logger?.info?.('billing.refund_without_hold', { user_id: uid, job_id: jid, run_key: targetRun });
        }
        return findLast(runRows, (row) => row.reason === 'job_refund') ?? null; // không có gì để hoàn ⇒ không ghi
      }
      const balanceBefore = await this.#balanceLocked(uid);
      // BR-09: lượt bị HOÀN ⇒ mọi dòng usage KHÔNG gắn lượt đang tồn tại bị coi là của (các) lượt
      // đã khép, KHÔNG được thu lại ở lượt sau. Đếm bằng số dòng thật tại thời điểm hoàn.
      let refundLegacy = null;
      if (typeof this.store?.listUsage === 'function') {
        try {
          const list = await this.store.listUsage(jid);
          if (Array.isArray(list)) refundLegacy = list.filter((e) => !String(e?.run_key || '')).length;
        } catch { /* không đọc được ⇒ bỏ qua, chỉ là tối ưu chống thu thừa */ }
      }
      try {
        return await this.#appendInSavepoint({
          userId: uid,
          amount: remaining,
          reason: 'job_refund',
          jobId: jid,
          runKey: targetRun,
          meta: {
            reason: note,
            refunded: remaining,
            run_key: targetRun,
            ...(refundLegacy !== null ? { legacy_usage_counted: refundLegacy } : {}),
            ...(extraMeta && typeof extraMeta === 'object' ? extraMeta : {}),
          },
          balanceBefore,
        });
      } catch (err) {
        // R1-B (§3) — thua cuộc đua (unique index `uniq_wallet_ledger_run_close`): tiến trình
        // khác đã ĐÓNG lượt này. Trả dòng đóng đã có ⇒ không hoàn hai lần, không tạo tiền.
        const raced = isUniqueLedgerViolation(err) ? await this.#closingRowOfRun(uid, jid, targetRun) : null;
        if (!raced) throw err;
        this.logger?.warn?.('billing.refund_run_race_recovered', { user_id: uid, job_id: jid, run_key: targetRun, close_reason: raced.reason });
        return raced;
      }
    });
  }

  /**
   * PB-02 — số LƯỢT CHẠY có tính tiền đã mở cho một job (đếm theo `run_key` trong sổ).
   * Dùng cho trần `billing.maxRunsPerJob` và cho `GET /api/config.billing`.
   */
  async runsOfJob({ userId, jobId } = {}) {
    const uid = this.#requireUserId(userId);
    const jid = requireJobId(jobId);
    const rows = await this.#jobRows(uid, jid);
    return runKeysOf(rows);
  }

  /**
   * BR-05 (vòng 3) — số LƯỢT CÓ THU của một job: lượt đã `job_settle`, hoặc lượt còn ĐANG MỞ.
   * Lượt lỗi đã được hoàn (`job_refund` mà không settle) **không** tính ⇒ job chưa từng thành
   * công không bị khoá oan bằng 429.
   */
  async billableRunsOfJob({ userId, jobId } = {}) {
    const uid = this.#requireUserId(userId);
    const jid = requireJobId(jobId);
    const rows = await this.#jobRows(uid, jid);
    const byRun = new Map();
    for (const row of rows) {
      const key = runKeyOf(row);
      if (!key) continue;
      const entry = byRun.get(key) || { settle: false, refund: false, hold: false };
      if (row.reason === 'job_settle') entry.settle = true;
      else if (row.reason === 'job_refund') entry.refund = true;
      else if (row.reason === 'job_hold') entry.hold = true;
      byRun.set(key, entry);
    }
    return [...byRun.entries()].filter(([, e]) => e.settle || (!e.refund && e.hold)).map(([key]) => key);
  }

  /**
   * BR-08 (vòng 4) — THU HỒI CÁC LƯỢT CHẠY TREO.
   *
   * Vì sao cần: một lượt có `job_hold` mà KHÔNG có dòng đóng (settle lỗi `LEDGER_BUSY`, tiến trình
   * chết trước `afterJob`, mất điện…) để lại khoản giữ ĐỌNG và khoá job vĩnh viễn (mọi lần chạy
   * lại đều 409 `JOB_ALREADY_RUNNING`) — không có đường phục hồi nào. Hàm này quét các lượt mở
   * CŨ HƠN `olderThanMs` (mặc định `config.billing.stuckRunMs`, 15 phút) rồi:
   *   · HOÀN 100% phần đang giữ (`job_refund`, `meta.reconciled = true`, `meta.stuck_ms`),
   *   · ĐÓNG lượt ⇒ job chạy lại được.
   *
   * KHÔNG đụng tới lượt còn mới (tránh cắt ngang job đang chạy thật).
   *
   * @returns {Promise<{reconciled:number, refunded:number, older_than_ms:number, runs:object[]}>}
   */
  async reconcileStuckRuns({ userId = null, olderThanMs = null, limit = 200, isJobActive = null, force = false } = {}) {
    const store = this.store;
    const out = { reconciled: 0, refunded: 0, older_than_ms: this.stuckRunMs, runs: [], skipped_active: 0 };
    if (typeof store?.listOpenJobHolds !== 'function') return out; // store không hỗ trợ ⇒ không làm gì
    // BR-10 — NGƯỠNG HIỆU LỰC:
    //   · có `isJobActive` (đường app/route: biết job nào đang chạy) hoặc `force` ⇒ dùng đúng
    //     ngưỡng cấu hình (vận hành vẫn phục hồi được job chết nhanh);
    //   · KHÔNG kiểm được trạng thái job ⇒ áp ĐÁY AN TOÀN `minStuckRunMs`, để một cấu hình ngắn
    //     không thể cắt ngang job đang chạy thật.
    const canVerify = force || typeof isJobActive === 'function';
    const ms = toFiniteNumber(olderThanMs);
    const wanted = ms !== null && ms >= 0 ? ms : this.stuckRunMs;
    const older = canVerify ? wanted : Math.max(wanted, this.minStuckRunMs);
    if (older !== wanted && !this.#floorWarned) {
      this.#floorWarned = true;
      this.logger?.warn?.('billing.stuck_run_ms_raised', {
        configured_ms: wanted,
        applied_ms: older,
        min_stuck_run_ms: this.minStuckRunMs,
        reason: 'Không kiểm được job nào đang chạy ⇒ nâng ngưỡng TREO lên đáy an toàn để KHÔNG cắt ngang job thật.',
      });
    }
    out.older_than_ms = older;
    const cutoffIso = new Date(Date.now() - older).toISOString();

    const holds = await this.#callStore(
      () => store.listOpenJobHolds({ olderThanIso: cutoffIso, limit, userId: userId || null }),
      { code: 'LEDGER_READ_FAILED', message: 'Không đọc được danh sách lượt chạy đang mở.' },
    );
    if (!Array.isArray(holds) || holds.length === 0) return out;

    for (const hold of holds) {
      const owner = String(hold?.user_id || '');
      const jid = String(hold?.job_id || '');
      const runKey = runKeyOf(hold);
      if (!owner || !jid || !runKey) continue;
      // BR-10 (vòng 5): job ĐANG HOẠT ĐỘNG (hàng đợi còn việc, hoặc trạng thái queued/running)
      // ⇒ KHÔNG thu hồi, dù đã quá ngưỡng: lượt đó đang chạy THẬT, cắt ngang là làm nó miễn phí.
      // `force: true` (chỉ owner/admin, khi biết chắc job đã chết) bỏ qua rào này.
      if (!force && typeof isJobActive === 'function') {
        let active = false;
        try {
          active = (await isJobActive(jid)) === true;
        } catch (err) {
          // Không kiểm được trạng thái ⇒ coi như ĐANG hoạt động (an toàn: không cắt ngang).
          active = true;
          this.logger?.warn?.('billing.reconcile_active_check_failed', { job_id: jid, error_name: err?.name || 'Error' });
        }
        if (active) {
          out.skipped_active += 1;
          this.logger?.info?.('billing.stuck_run_skipped_active', { job_id: jid, run_key: runKey });
          continue;
        }
      }
      try {
        const stuckMs = Math.max(0, Date.now() - Date.parse(String(hold?.created_at || '')) || 0);
        const row = await this.refundForJob({
          userId: owner,
          jobId: jid,
          runKey,
          reason: 'STUCK_RUN_RECONCILE',
          meta: {
            reconciled: true,
            stuck_ms: Number.isFinite(stuckMs) ? stuckMs : null,
            ...(force ? { forced: true } : {}),
          },
        });
        const amount = Math.abs(toFiniteNumber(row?.amount) ?? 0);
        out.reconciled += 1;
        out.refunded = roundMoney(out.refunded + amount);
        out.runs.push({ job_id: jid, run_key: runKey, refunded: amount });
        this.logger?.warn?.('billing.stuck_run_reconciled', { job_id: jid, run_key: runKey, refunded: amount, stuck_ms: stuckMs });
      } catch (err) {
        // Một lượt lỗi KHÔNG được chặn các lượt còn lại.
        this.logger?.warn?.('billing.stuck_run_reconcile_failed', {
          job_id: jid,
          run_key: runKey,
          error_name: err?.name || 'Error',
          error_code: err?.code || null,
        });
      }
    }
    return out;
  }

  /** BR-07/BR-01 — `run_key` KẾ TIẾP cho một job (dùng khi không giữ tiền trước). */
  async nextRunKey({ userId, jobId } = {}) {
    const uid = this.#requireUserId(userId);
    const jid = requireJobId(jobId);
    const rows = await this.#jobRows(uid, jid);
    return nextRunKeyOf(rows, jid);
  }

  /** §3.2 — lịch sử sổ (mới nhất trước, theo store). Ẩn danh ⇒ `ANONYMOUS_NO_WALLET`. */
  async history({ userId, limit, offset } = {}) {
    const uid = this.#requireUserId(userId);
    const store = this.#requireMethod('listLedger');
    const rows = await this.#callStore(
      () => store.listLedger({ userId: uid, limit: normalizeLimit(limit), offset: normalizeOffset(offset) }),
      {
        code: 'LEDGER_READ_FAILED',
        message: 'Không đọc được lịch sử sổ credit.',
        details: { user_id: uid },
      },
    );
    return normalizeLedgerRows(rows);
  }

  /**
   * §3.2 — tổng hợp usage cho trang quản trị: `groupBy ∈ day|operation|user`
   * (A3 cài `store.usageAggregate`). Không gắn với một ví cụ thể nên chạy cho cả ẩn danh.
   */
  async usageSummary({ from = null, to = null, groupBy = undefined, group_by: groupBySnake = undefined } = {}) {
    // `group_by` (snake_case mà route A4 nhận từ query) phải được tôn trọng;
    // mặc định 'day' chỉ dùng khi CẢ HAI đều trống — không được để default che alias.
    const picked = String(groupBy ?? groupBySnake ?? 'day').trim().toLowerCase();
    if (!GROUP_BY_VALUES.includes(picked)) {
      throw new BillingError('INVALID_GROUP_BY', `groupBy không hợp lệ: ${JSON.stringify(groupBy ?? groupBySnake ?? null)}`, {
        group_by: groupBy ?? groupBySnake ?? null,
        allowed: [...GROUP_BY_VALUES],
      });
    }
    const store = this.#requireMethod('usageAggregate');
    const rows = await this.#callStore(() => store.usageAggregate({ from, to, groupBy: picked }), {
      code: 'USAGE_AGGREGATE_FAILED',
      message: 'Không tổng hợp được usage.',
      details: { from, to, group_by: picked },
    });
    return Array.isArray(rows) ? rows : [];
  }

  /** Chi phí THẬT của job theo `usage_events` (G13). Không đọc được ⇒ `null`. */
  /**
   * BR-07 — chi phí của MỘT LƯỢT CHẠY.
   *
   * Ưu tiên số đo ĐÃ GẮN `run_key` (`usage_events.run_key`). Nếu lượt này chưa có dòng usage
   * nào gắn khoá (DB cũ / caller ghi usage không kèm lượt) thì dùng **phần TĂNG so với phần đã
   * thu của các lượt trước** — vẫn không bao giờ thu lại tiền của lượt cũ:
   *   chi_phí_lượt = max(0, tổng_usage_của_job − Σ(đã_thu của các lượt trước)).
   */
  /**
   * BR-07 + BR-09 — chi phí của MỘT LƯỢT CHẠY, quy theo TỪNG DÒNG `usage_events`.
   *
   * Quy tắc (không bao giờ thu thừa):
   *   1. dòng CÓ `run_key` == lượt này ⇒ tính;
   *   2. dòng CÓ `run_key` của lượt khác (kể cả lượt đã được HOÀN) ⇒ KHÔNG tính;
   *   3. dòng KHÔNG gắn lượt (DB cũ / caller không truyền `runKey`) ⇒ quy theo thứ tự xác định:
   *      mỗi lần settle/refund ghi `meta.legacy_usage_counted` = số dòng không-gắn-lượt đã tính
   *      tích luỹ; lượt này chỉ nhận các dòng CÒN LẠI sau mốc đó.
   *   Không quy được dòng nào ⇒ chi phí 0 (thà thu thiếu còn hơn thu thừa — BR-09).
   *
   * @returns {Promise<{cost:number, legacy_counted:number, unavailable:boolean}|null>} `null` khi
   *          không đọc được usage (tầng gọi coi như KHÔNG thu + ghi vết).
   */
  async #usageCostOfRun(jobId, runKey, rows) {
    const store = this.store;
    if (typeof store?.listUsage !== 'function') return null; // không xác định được ⇒ không thu
    let list = null;
    try {
      list = await store.listUsage(jobId);
    } catch (err) {
      this.logger?.warn?.('billing.usage_list_failed', { job_id: jobId, run_key: runKey, error_name: err?.name || 'Error' });
      return null;
    }
    if (!Array.isArray(list)) return null;

    // (3) mốc "đã tính bao nhiêu dòng không gắn lượt" của các lượt TRƯỚC (settle/refund).
    // KHÔNG dùng mốc thời gian: nhiều dòng có thể cùng mili-giây ⇒ vừa có thể thu thừa, vừa có
    // thể bỏ sót. Bộ đếm tích luỹ là xác định (deterministic) trên mọi driver.
    let legacySkip = 0;
    for (const row of rows ?? []) {
      if (!['job_settle', 'job_refund'].includes(row?.reason)) continue;
      if (runKeyOf(row) === runKey) continue;
      const counted = toFiniteNumber(row?.meta?.legacy_usage_counted);
      if (counted !== null && counted > legacySkip) legacySkip = Math.trunc(counted);
    }
    const legacyRows = list
      .filter((event) => !String(event?.run_key || ''))
      .sort((a, b) => {
        const at = String(a?.created_at ?? '').localeCompare(String(b?.created_at ?? ''));
        return at !== 0 ? at : String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
      });
    const mineLegacy = legacyRows.slice(legacySkip);

    let cost = 0;
    let counted = 0;
    for (const event of list) {
      const key = String(event?.run_key || '');
      if (!key || key !== runKey) continue; // (1) và (2)
      cost += toFiniteNumber(event?.estimated_cost ?? event?.estimatedCost ?? 0) ?? 0;
      counted += 1;
    }
    for (const event of mineLegacy) {
      cost += toFiniteNumber(event?.estimated_cost ?? event?.estimatedCost ?? 0) ?? 0;
      counted += 1;
    }
    // BR-11 (vòng 5): LUÔN nói rõ chi phí đến từ đâu — không phân biệt được "job không tốn gì" với
    // "không quy được usage về lượt" là điều KHÔNG được phép (đã từng ghi `actual_cost = 0` im lặng).
    const attributed = list.filter((event) => String(event?.run_key || '') === runKey).length;
    const source = counted === 0 ? (list.length === 0 ? 'none' : 'unavailable') : (attributed > 0 ? 'run' : 'legacy');
    return {
      cost: counted > 0 ? roundMoney(cost) : 0,
      legacy_counted: legacySkip + mineLegacy.length,
      unavailable: false,
      source,
    };
  }

  async #usageCostOfJob(jobId) {
    const store = this.store;
    if (typeof store?.usageSummary !== 'function') return null;
    try {
      const summary = await store.usageSummary(jobId);
      const cost = toFiniteNumber(summary?.estimated_cost ?? summary?.estimatedCost ?? summary?.cost);
      return cost === null ? null : roundMoney(cost);
    } catch (err) {
      this.logger?.warn?.('billing.usage_summary_failed', { job_id: jobId, error: err?.message ?? String(err) });
      return null;
    }
  }
}

/** §3.2 — factory theo đúng thứ tự tham số `(config, { store, logger })`. */
export function createBillingService(config = {}, { store = null, logger = null } = {}) {
  const looksLikeDeps =
    config && typeof config === 'object' && !config.cost && !config.billing && Boolean(config.store || config.config);
  if (looksLikeDeps) return new BillingService(config); // gọi kiểu (deps) vẫn chạy
  return new BillingService({ store, logger, config });
}

export default BillingService;
