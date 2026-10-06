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
 * Giới hạn ĐÃ BIẾT (ghi rõ để không ai tưởng là an toàn tuyệt đối):
 *   - Khoá tuần tự hoá theo user nằm TRONG BỘ NHỚ (`#locks`) ⇒ chỉ đúng khi chạy
 *     MỘT tiến trình. Chạy nhiều instance (docker scale, cluster) thì hai request cùng
 *     user ở hai tiến trình khác nhau vẫn có thể đọc cùng số dư rồi cùng ghi ⇒ cần
 *     khoá/mutux ở tầng DB (SELECT ... FOR UPDATE trên hàng ví, hoặc unique index +
 *     transaction) trước khi mở rộng ngang.
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

/* ──────────────────────────────── BillingService ──────────────────────────────── */

export class BillingService {
  /**
   * Khoá tuần tự hoá theo user: Map<userId, Promise> nối đuôi nhau (promise chain).
   * ⚠️ CHỈ đúng trong MỘT tiến trình — xem phần "Giới hạn ĐÃ BIẾT" ở đầu file.
   */
  #locks = new Map();

  constructor(deps = {}) {
    const { store, logger, config } = normalizeDeps(deps);
    this.store = store;
    // PB-06: trần credit cho một thao tác cấp/điều chỉnh (mặc định 1e9 — xem `money.js`).
    const cap = toFiniteNumber(config?.billing?.maxAmount);
    this.maxAmount = cap !== null && cap > 0 ? cap : DEFAULT_MAX_AMOUNT;
    this.logger = logger;
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
      const wrapped = err && typeof err.code === 'string' && err.code
        ? new BillingError(err.code, err.message || message, err.details ?? details)
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
    await previous.catch(() => {}); // chờ lượt trước nhả khoá (kể cả khi lượt trước lỗi)
    try {
      return await fn();
    } finally {
      release();
      if (this.#locks.get(key) === tail) this.#locks.delete(key); // không để Map phình mãi
    }
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
   * GHI MỘT DÒNG SỔ (append-only). Chỉ gọi khi ĐANG giữ khoá của user và đã có
   * `balanceBefore` đọc từ sổ. Không bao giờ để số dư âm: nếu phép cộng ra âm thì
   * ném `INSUFFICIENT_CREDIT` và KHÔNG ghi gì.
   */
  async #append({ userId, amount, reason, jobId = null, operation = null, meta = null, balanceBefore, runKey = null }) {
    const store = this.#requireMethod('appendLedger');
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
    return this.#withUserLock(uid, async () => {
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

    return this.#withUserLock(uid, async () => {
      const rows = await this.#jobRows(uid, jid);

      // (b0) PB-02: chọn LƯỢT CHẠY để giữ tiền — lượt đang mở nếu có (idempotent theo run),
      //      ngược lại mở lượt MỚI. Đây là chỗ sửa lỗi "chạy lại cùng jobId = miễn phí".
      const asked = typeof runKey === 'string' && runKey.trim() ? runKey.trim() : '';
      const openRun = openRunKeyOf(rows);
      const targetRun = asked || openRun || nextRunKeyOf(rows, jid);

      // (b0b) Trần số lượt chạy có tính tiền cho mỗi job ⇒ vượt thì TỪ CHỐI (route map 429).
      if (runsCap !== null && runsCap > 0) {
        const known = runKeysOf(rows);
        const already = known.includes(targetRun);
        if (!already && known.length >= runsCap) {
          throw new BillingError(
            'RERUN_LIMIT_EXCEEDED',
            `Job đã chạy ${known.length} lượt có tính tiền — vượt trần ${runsCap} lượt mỗi job. Hãy tạo job mới.`,
            { job_id: jid, runs: known.length, max_runs: runsCap },
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
      const row = await this.#append({
        userId: uid,
        amount: -amount,
        reason: 'job_hold',
        jobId: jid,
        runKey: targetRun,
        operation: singleOperation(operationNames),
        meta,
        balanceBefore,
      });
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

    return this.#withUserLock(uid, async () => {
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
      if (runRows.some((row) => row.reason === 'job_refund')) {
        // Lượt đã được HOÀN (job failed) ⇒ không quyết toán lại (giữ luật "một chu kỳ một lần").
        return findLast(runRows, (row) => row.reason === 'job_refund');
      }

      let actual = toFiniteNumber(actualCost);
      if (actual === null && (actualCost === undefined || actualCost === null)) {
        actual = await this.#usageCostOfJob(jid);
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
      if (shortfall > 0) meta.shortfall = shortfall;
      return this.#append({ userId: uid, amount, reason: 'job_settle', jobId: jid, runKey: targetRun, meta, balanceBefore });
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
  async refundForJob({ userId, jobId, reason = '', runKey = null } = {}) {
    const uid = this.#requireUserId(userId);
    const jid = requireJobId(jobId);
    const note = typeof reason === 'string' && reason.trim() ? reason.trim() : 'job_failed';

    return this.#withUserLock(uid, async () => {
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
      return this.#append({
        userId: uid,
        amount: remaining,
        reason: 'job_refund',
        jobId: jid,
        runKey: targetRun,
        meta: { reason: note, refunded: remaining, run_key: targetRun },
        balanceBefore,
      });
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
