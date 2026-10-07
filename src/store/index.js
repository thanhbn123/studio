/**
 * Store — lớp repository dùng chung cho cả SQLite và PostgreSQL.
 *
 * Mọi truy cập DB đi qua đây. Tầng trên (routes, jobs) không biết mình đang chạy
 * trên driver nào, nên chuyển từ SQLite sang PostgreSQL chỉ là đổi `DB_DRIVER`.
 *
 * MVP-02 bổ sung phần ImageLab (image_assets / ocr_regions / translation_lines) và
 * cột `jobs.kind`. Toàn bộ phần cũ giữ nguyên hành vi.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { SqliteDriver } from './sqlite-driver.js';
import { PostgresDriver } from './postgres-driver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = path.join(HERE, 'schema.sql');

export const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  NEEDS_MANUAL: 'needs_manual',
  // MVP-02: job ImageLab đã OCR + dịch xong, đang chờ người dùng duyệt từng dòng.
  AWAITING_REVIEW: 'awaiting_review',
});

export const USAGE_OPERATIONS = Object.freeze([
  'SOURCE_EXTRACT',
  'VISION_ANALYSIS',
  'TRANSLATION',
  'CONTENT_GENERATE',
  'CONTENT_REPAIR',
  // MVP-02
  'OCR_DETECT',
  'IMAGE_RENDER',
  // MVP-03 — chỉ ghi khi bước THẬT SỰ chạy (matting từ chối ⇒ không có IMAGE_MATTING).
  'IMAGE_MATTING',
  'IMAGE_COMPOSE',
  'IMAGE_RETOUCH',
  // MVP-04 — video offline: `VIDEO_RENDER` (dựng khung) và `VIDEO_ENCODE` (mã hoá GIF/MP4).
  // Chỉ ghi khi bước THẬT SỰ chạy (chữ thiếu bằng chứng ⇒ không dựng khung, không mã hoá ⇒
  // KHÔNG có dòng usage nào).
  'VIDEO_RENDER',
  'VIDEO_ENCODE',
]);

/** Loại job: MVP-01 sinh nội dung, MVP-02 dịch chữ trên ảnh, MVP-03 tạo ảnh. */
export const JOB_KINDS = Object.freeze({
  CONTENT: 'content',
  IMAGE_TRANSLATION: 'image_translation',
  // MVP-03 (E3): job tạo ảnh/retouch. Cột `jobs.kind` đã có từ MVP-02 nên KHÔNG cần migration.
  IMAGE_GENERATION: 'image_generation',
});

export const IMAGE_ASSET_ROLES = Object.freeze(['original', 'rendered']);

/* ───────────────────────── MVP-05 — tài khoản + ví ───────────────────────── */

/** Vai trò người dùng (hợp đồng §2.1) — A1/A4 dùng chung, không định nghĩa lại. */
export const USER_ROLES = Object.freeze(['owner', 'admin', 'member']);

/** Trạng thái tài khoản. `disabled` ⇒ mọi phiên bị từ chối (A1 kiểm ở authenticate). */
export const USER_STATUSES = Object.freeze(['active', 'disabled']);

/** Lý do hợp lệ của một dòng sổ credit (hợp đồng §2.1). Sổ là APPEND-ONLY. */
export const LEDGER_REASONS = Object.freeze([
  'grant',
  'admin_grant',
  'job_hold',
  'job_settle',
  'job_refund',
  'adjustment',
]);

/** Kiểu nhóm của `usageAggregate` (hợp đồng §3.4). */
export const USAGE_GROUP_BY = Object.freeze(['day', 'operation', 'user']);

/** Nhãn nhóm cho usage của job ẩn danh (`jobs.user_id IS NULL`). */
export const ANONYMOUS_GROUP_LABEL = '(ẩn danh)';

/**
 * Số chữ số làm tròn của TIỀN TỆ (credit). `amount`/`balance_after` là REAL nên cộng thô
 * sẽ sinh `1.9000000000000001`; mọi chỗ ghi/đọc tiền đều đi qua `roundMoney` để số dư đối
 * soát được bằng `===` và không lệch ~1e-15 giữa các lần đọc.
 */
export const MONEY_DECIMALS = 6;

/* ── R1 (§3): tham số khoá ghi sổ ở tầng DB — soi gương tham số của src/billing/index.js ── */

/** Số lần THỬ LẠI khi SQLite báo bận (`database is locked`) — hết lượt ⇒ lỗi `LEDGER_BUSY`. */
export const LEDGER_LOCK_RETRIES = 6;
/** Thời gian chờ cơ sở giữa hai lần thử (ms) — tăng gấp đôi, có trần. Tổng ngân sách phải NHỎ. */
export const LEDGER_LOCK_RETRY_BASE_MS = 20;
/** Trần thời gian chờ một lần thử (ms). */
export const LEDGER_LOCK_RETRY_MAX_MS = 120;
/** Trần số mục một lượt `resume()` / `requeueStaleJobs()` — chặn boot treo vì sổ hàng đợi quá lớn. */
export const QUEUE_RESUME_LIMIT = 200;

/** Thông điệp `last_error` khi một mục hàng đợi chạm trần số lần thử (F1). */
export const QUEUE_EXHAUSTED_ERROR = 'quá số lần thử';

/** Làm tròn tiền về 6 chữ số thập phân (null/không phải số ⇒ null). */
export function roundMoney(value) {
  const n = toNum(value, null);
  if (n === null) return null;
  const factor = 10 ** MONEY_DECIMALS;
  // `Math.round` trên số đã dịch dấu phẩy; cộng EPS để 0.0000005 không bị làm tròn xuống
  // do biểu diễn nhị phân (ví dụ 1.0000005 → 1.000001).
  return Math.round((n + Math.sign(n) * Number.EPSILON) * factor) / factor;
}

/**
 * GIÁ MẶC ĐỊNH CỦA REPO cho từng operation — dùng khi `config.cost` thiếu khoá.
 *
 * ⚠️ Đây KHÔNG phải giá nhà cung cấp: đây là con số ước tính của repo (trùng mặc định
 * `config.cost` của MVP-01) để mọi operation trong `USAGE_OPERATIONS` đều có giá và
 * `priceOf()` không bao giờ ném `UNKNOWN_OPERATION`. `CONTENT_REPAIR` (lượt gọi model sửa
 * nội dung) lấy cùng mức với `CONTENT_GENERATE`.
 */
export const DEFAULT_PRICING = Object.freeze({
  SOURCE_EXTRACT: 0.0005,
  VISION_ANALYSIS: 0.003,
  TRANSLATION: 0.0008,
  CONTENT_GENERATE: 0.004,
  CONTENT_REPAIR: 0.004,
  OCR_DETECT: 0.0004,
  IMAGE_RENDER: 0.0015,
  IMAGE_MATTING: 0.002,
  IMAGE_COMPOSE: 0.0005,
  IMAGE_RETOUCH: 0.0005,
  // MVP-04 — video offline (dựng khung + mã hoá GIF bằng CPU của máy chủ). Cùng quy ước:
  // GIÁ MẶC ĐỊNH CỦA REPO, KHÔNG phải giá nhà cung cấp. Phải > 0 vì giá 0 = "miễn phí"
  // (sai nghiệp vụ) và `mvp05-billing` khẳng định mọi operation đều có giá > 0.
  VIDEO_RENDER: 0.0006,
  VIDEO_ENCODE: 0.0004,
});

export const VERIFICATION_LEVELS = Object.freeze([
  'MOCK_VERIFIED',
  'MANUAL_INPUT',
  'LIVE_VERIFIED',
  'AUTHENTICATED_LIVE_VERIFIED',
  'BLOCKED',
  'UNSUPPORTED',
]);

const nowIso = () => new Date().toISOString();

function toJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function fromJson(text) {
  if (text === null || text === undefined || text === '') return null;
  if (typeof text === 'object') return text; // PostgreSQL jsonb trả về object sẵn
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Số hữu hạn ĐỌC TỪ DB, hoặc `fallback`.
 *
 * ⚠️ N-1 (vòng 5): KHÔNG dùng `Number(value)` trực tiếp. `Number('  ') === 0`,
 * `Number('\t') === 0`, `Number('0x10') === 16`, `Number([]) === 0` — nên toạ độ
 * rác trong DB bị biến thành SỐ ngay ở tầng đọc, và tầng `geometry.strictCoordinate`
 * phía sau không bao giờ nhìn thấy "rác" để mà chặn (hộp bảo vệ "ảo" ở x=0 ⇒ pixel
 * nhãn hiệu bị xoá thật trong khi `skipped` vẫn báo "không xoá").
 *
 * Luật (giống hệt `strictCoordinate` của `src/imagelab/geometry.js`):
 *   - `number` hữu hạn ⇒ nhận;
 *   - CHUỖI đã `trim()` khác rỗng và đúng dạng số THẬP PHÂN ⇒ nhận;
 *   - mọi thứ khác (null/undefined/''/'  '/hex/NaN/±Infinity/boolean/mảng/object) ⇒ `fallback`.
 */
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function toNum(value, fallback = null) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || !DECIMAL_RE.test(trimmed)) return fallback;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** Số nguyên, hoặc null — dùng cho toạ độ pixel. */
function toIntOrNull(value) {
  const n = toNum(value, null);
  return n === null ? null : Math.trunc(n);
}

/* ─────────────── R1 — tiện ích dùng chung cho khoá ghi + hàng đợi bền ─────────────── */

/** Ngủ `ms` (không âm). Dùng cho backoff có giới hạn khi driver báo bận. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Lỗi "driver đang bận/khoá" — dùng để QUYẾT ĐỊNH thử lại, KHÔNG dùng để nuốt lỗi.
 *
 * ⚠️ Cố ý KHÔNG khớp mã `SQLITE_ERROR` trần: node:sqlite dùng chính mã đó cho lỗi cú pháp
 * SQL, nên khớp trần là biến lỗi lập trình thành "thử lại 6 lần rồi báo LEDGER_BUSY" (che
 * mất bug thật). Chỉ khớp khi THÔNG ĐIỆP nói rõ khoá/bận, hoặc mã khoá cụ thể.
 */
/**
 * A3 (fencing) — chuẩn hoá `epoch` của tầng gọi: `null`/`undefined`/`''` nghĩa là "KHÔNG kiểm epoch".
 *
 * ⚠️ Bài học đo được: `Number(null) === 0` và `Number.isFinite(0) === true` ⇒ nếu viết
 * `Number.isFinite(Number(epoch))` thì lời gọi KHÔNG truyền epoch sẽ bị hiểu là `epoch = 0` và
 * mọi câu UPDATE kèm `AND epoch = 0` không khớp dòng nào (mục `running` có epoch ≥ 1) ⇒
 * `completeQueueItem`/`touchQueueItem` im lặng thất bại.
 */
function normalizeEpoch(epoch) {
  if (epoch === null || epoch === undefined || epoch === '') return null;
  const n = Number(epoch);
  return Number.isFinite(n) ? n : null;
}

/**
 * A4/F5 (phản biện R1 vòng 2) — CHUẨN HOÁ lỗi khoá thành mã của repo.
 *
 * Vì sao: khi hết hạn chờ khoá, driver SQLite trả `ERR_SQLITE_ERROR` (ví dụ
 * `cannot start a transaction within a transaction` hoặc `database is locked`). Mã thô đó lọt ra
 * tới HTTP/CLI là SAI HỢP ĐỒNG: tầng gọi chỉ biết `LEDGER_BUSY`/`QUEUE_BUSY` kèm `retryable`.
 */
function asRepoBusyError(err, { code = 'LEDGER_BUSY', message = null, details = null } = {}) {
  if (!isBusyError(err)) return err;
  if (err instanceof Error && (err.code === 'LEDGER_BUSY' || err.code === 'QUEUE_BUSY')) return err;
  const wrapped = Object.assign(
    new Error(message || 'Cơ sở dữ liệu đang bận (khoá ghi) — thao tác chưa được thực hiện, thử lại được.'),
    {
      code,
      details: { ...(details ?? {}), retryable: true, driver_code: err?.code ?? null },
      cause: err,
    },
  );
  return wrapped;
}

function isBusyError(err) {
  const text = `${err?.code ?? ''} ${err?.message ?? ''}`;
  if (String(err?.code ?? '') === 'DB_LOCK_TIMEOUT') return true;
  // A4/F5 (vòng 2): lỗi "transaction lồng nhau" và `SQLITE_ERROR` do khoá cũng là BẬN — phải được
  // map thành `LEDGER_BUSY`/`QUEUE_BUSY` kèm `retryable`, KHÔNG bao giờ để mã thô ra ngoài.
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked|cannot start a transaction within a transaction|deadlock|40001|40P01|55P03|LEDGER_BUSY|QUEUE_BUSY|DB_LOCK_TIMEOUT/i.test(text);
}

/**
 * Thông điệp lỗi ngắn gọn để lưu vào `job_queue.last_error` (kèm `code` nếu có).
 * Cắt trần 2000 ký tự — cột này chỉ để người vận hành đọc, không phải nơi chứa stack.
 */
function errorText(error) {
  if (!error) return null;
  const code = error.code ? `${error.code}: ` : '';
  return `${code}${error.message || String(error)}`.slice(0, 2000);
}

/** Kẹp số nguyên trong khoảng [min, max]. */
function clampInt(value, fallback, min, max) {
  const n = toNum(value, null);
  const v = n === null ? fallback : Math.trunc(n);
  return Math.min(Math.max(v, min), max);
}

/**
 * Dung sai dấu phẩy động khi chặn số dư ÂM (R1: tách ra hằng số module vì luật này dùng ở
 * cả `appendLedger` lẫn transaction của `withLedgerLock`). `amount` là REAL nên một phép trừ
 * "về 0" có thể ra -1e-17; chỉ coi là âm THẬT khi vượt dung sai.
 */
const EPS_LEDGER = 1e-9;

export function createDriver(config, logger) {
  const driver = String(config?.db?.driver || 'sqlite').toLowerCase();
  if (driver === 'postgres' || driver === 'postgresql') {
    return new PostgresDriver({
      url: config?.db?.url,
      sslMode: config?.db?.sslMode,
      poolMax: config?.db?.poolMax,
      logger,
    });
  }
  // A1/A5: truyền `config` xuống driver để `busy_timeout` theo cấu hình (`queue.lockTimeoutMs`).
  return new SqliteDriver({ path: config?.db?.sqlitePath, logger, config });
}

export class Store {
  constructor({ driver, logger, config = null } = {}) {
    this.driver = driver;
    this.logger = logger;
    // MVP-05: `config.cost.*` là NGUỒN GIÁ MẶC ĐỊNH (§2.3) — Store cần nó để seed bảng
    // `pricing` lúc `init()`. Không truyền (test dựng Store trực tiếp) ⇒ dùng DEFAULT_PRICING.
    this.config = config;
    this.dialect = driver?.dialect || 'sqlite';
  }

  /**
   * R1 (§3): transaction ĐANG MỞ của ngữ cảnh async hiện tại.
   *
   * Vì sao phải là `AsyncLocalStorage` chứ không phải một field `this.#tx`: hai `withLedgerLock`
   * của hai NGƯỜI DÙNG khác nhau chạy song song trong cùng tiến trình; một field chung sẽ để
   * lời gọi của người này ghi nhầm vào transaction của người kia (hoặc ghi ra ngoài transaction
   * ⇒ mất tính nguyên tử của "đọc số dư rồi ghi sổ"). ALS tách ngữ cảnh theo từng chuỗi async.
   */
  #txAls = new AsyncLocalStorage();

  /**
   * R1: mutex TRONG TIẾN TRÌNH cho transaction của SQLite.
   *
   * Vì sao cần: `node:sqlite` chỉ có MỘT kết nối `DatabaseSync` cho cả tiến trình, nên hai
   * transaction chồng nhau (một cái đang `await` bên trong) sẽ lỗi
   * "cannot start a transaction within a transaction". Mutex này xếp hàng các transaction
   * do Store mở, nhờ vậy 20 thao tác ghi song song trong CÙNG tiến trình vẫn chạy tuần tự.
   */
  #txMutexTail = Promise.resolve();

  get isPostgres() {
    return this.dialect === 'postgres';
  }

  /* ──────── R1 — hạ tầng transaction/khoá dùng chung cho §2.2 và §3 ──────── */

  /** Transaction đang mở của ngữ cảnh async này (null nếu đang ở ngoài transaction). */
  #activeTx() {
    return this.#txAls.getStore() || null;
  }

  /**
   * Executor để ĐỌC/GHI: ưu tiên transaction đang mở (nếu có) rồi mới tới driver.
   * Nhờ vậy `ledgerBalance()` gọi BÊN TRONG `withLedgerLock` đọc ĐÚNG transaction đó —
   * "đọc số dư rồi ghi sổ" mới thật sự nguyên tử (đọc ở kết nối khác là đọc dữ liệu cũ).
   */
  #exec() {
    const active = this.#activeTx();
    return active?.tx || this.driver;
  }

  /**
   * Giao diện transaction trao cho `fn` của `withLedgerLock` (§3).
   *
   * R2-B có HAI cách dùng, cả hai đều chạy trong CÙNG một transaction:
   *   `await store.withLedgerLock(uid, async () => { await store.appendLedger({...}); })`
   *   `await store.withLedgerLock(uid, async (tx) => { await tx.appendLedger({...}); })`
   */
  #txView(tx) {
    // F4 (phản biện R1, VỪA–CAO): `savepoint()` — chạy một khối lệnh trong SAVEPOINT.
    //
    // Vì sao cần: trên PostgreSQL, một câu INSERT vi phạm UNIQUE làm **hỏng cả transaction**
    // (`25P02 current transaction is aborted`) ⇒ mọi câu SELECT phục hồi sau đó cũng lỗi, và mã
    // driver thô lọt ra tầng HTTP (đo được: 15/100 thao tác trong workload 2 tiến trình). Với
    // SAVEPOINT, ta rollback về đúng mốc trước INSERT rồi ĐỌC LẠI dòng đã có trong CÙNG
    // transaction ⇒ luôn trả về kết quả idempotent thay vì lỗi.
    let spSeq = 0;
    const savepoint = async (name, fn) => {
      const sp = `sp_${String(name || 'block').replace(/[^A-Za-z0-9_]/g, '_')}_${(spSeq += 1)}`;
      await tx.run(`SAVEPOINT ${sp}`);
      try {
        const out = await fn();
        await tx.run(`RELEASE SAVEPOINT ${sp}`);
        return out;
      } catch (err) {
        try {
          await tx.run(`ROLLBACK TO SAVEPOINT ${sp}`);
          await tx.run(`RELEASE SAVEPOINT ${sp}`);
        } catch {
          /* không rollback được về mốc ⇒ để lỗi gốc nổi lên (fail-closed) */
        }
        throw err;
      }
    };
    return {
      run: (sql, params = []) => tx.run(sql, params),
      all: (sql, params = []) => tx.all(sql, params),
      get: (sql, params = []) => tx.get(sql, params),
      savepoint,
      // Các method dưới đây dùng `#exec()` nên tự bám vào transaction đang mở.
      appendLedger: (options = {}) => this.appendLedger(options),
      ledgerBalance: (userId) => this.ledgerBalance(userId),
      listLedger: (options = {}) => this.listLedger(options),
    };
  }

  /** Xếp hàng một việc vào mutex trong tiến trình (xem `#txMutexTail`). */
  async #withMutex(fn) {
    const timeoutMs = this.#lockTimeoutMs();
    const previous = this.#txMutexTail;
    let release;
    this.#txMutexTail = new Promise((resolve) => {
      release = resolve;
    });
    // F5 (phản biện R1, VỪA): CHỜ KHOÁ PHẢI CÓ HẠN. Trước đây hàng đợi mutex trong tiến trình
    // không timeout ⇒ một transaction treo làm MỌI transaction khác (kể cả `claimNextJob`, kể cả
    // cron, kể cả shutdown) đứng vĩnh viễn. Hết hạn ⇒ lỗi nghiệp vụ có `retryable: true`.
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(
          new Error(`Chờ khoá ghi DB quá ${timeoutMs}ms — tiến trình khác đang giữ khoá.`),
          { code: 'DB_LOCK_TIMEOUT', details: { timeout_ms: timeoutMs, retryable: true } },
        ));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      await Promise.race([previous, timeout]);
    } catch (err) {
      // A4 (phản biện R1 vòng 2, VỪA): HẾT HẠN ⇒ nhường lượt **SAU KHI chủ hiện tại xong**.
      //
      // Trước đây chỗ này `release()` NGAY ⇒ người chờ kế tiếp vào mutex trong lúc transaction
      // của chủ cũ CÒN MỞ ⇒ `BEGIN` thứ hai trên cùng kết nối SQLite nổ
      // `cannot start a transaction within a transaction` (`ERR_SQLITE_ERROR` thô), và mọi việc
      // khác trong tiến trình fail dây chuyền trong 0–1ms.
      previous.then(() => release(), () => release());
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** F5 — trần thời gian chờ khoá (ms): `config.queue.lockTimeoutMs`, mặc định 5000. */
  #lockTimeoutMs() {
    const raw = Number(this.config?.queue?.lockTimeoutMs);
    if (Number.isFinite(raw) && raw > 0) return Math.min(60000, Math.trunc(raw));
    return 5000;
  }

  /**
   * Transaction SQLite do Store tự mở.
   *
   * Vì sao không dùng thẳng `driver.transaction`: driver phát `BEGIN` (deferred) — với hai
   * TIẾN TRÌNH cùng ghi, transaction bắt đầu bằng ĐỌC rồi mới ghi sẽ đụng `SQLITE_BUSY_SNAPSHOT`
   * và `busy_timeout` KHÔNG cứu được (SQLite không thử lại loại xung đột này). `BEGIN IMMEDIATE`
   * giữ khoá GHI ngay từ câu lệnh đầu nên chỉ còn chờ khoá thường (busy_timeout = 5000ms do
   * `SqliteDriver.connect()` đặt).
   *
   * Nếu driver không phải SQLite thật (driver giả trong test), rơi về `driver.transaction`.
   */
  async #withSqliteTx(fn, { immediate = false } = {}) {
    return this.#withMutex(async () => {
      await this.driver.connect?.();
      const db = this.driver?.db;
      if (!db || typeof db.exec !== 'function') return this.driver.transaction(fn);
      db.exec(immediate ? 'BEGIN IMMEDIATE' : 'BEGIN');
      try {
        const result = await fn(this.driver);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* transaction có thể đã hỏng — bỏ qua, lỗi gốc mới là thứ cần ném */
        }
        throw err;
      }
    });
  }

  /** Transaction theo driver: PostgreSQL ⇒ `driver.transaction`; SQLite ⇒ `BEGIN IMMEDIATE`. */
  async #inTransaction(fn) {
    if (this.isPostgres) return this.driver.transaction(fn);
    return this.#withSqliteTx(fn, { immediate: true });
  }

  /**
   * Thử lại có GIỚI HẠN khi driver báo bận; hết lượt ⇒ lỗi `code` chỉ định (mặc định
   * `LEDGER_BUSY`). Lỗi KHÁC (nghiệp vụ, cú pháp SQL…) được ném thẳng — không thử lại mù.
   */
  async #retryOnBusy(fn, { attempts = LEDGER_LOCK_RETRIES, baseMs = LEDGER_LOCK_RETRY_BASE_MS, maxMs = LEDGER_LOCK_RETRY_MAX_MS, code = 'LEDGER_BUSY', message = null, details = null } = {}) {
    const tries = clampInt(attempts, LEDGER_LOCK_RETRIES, 1, 50);
    let lastErr = null;
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        if (!isBusyError(err)) throw err;
        lastErr = err;
        if (attempt < tries) {
          const wait = Math.min(clampInt(baseMs, LEDGER_LOCK_RETRY_BASE_MS, 0, 5000) * 2 ** (attempt - 1), clampInt(maxMs, LEDGER_LOCK_RETRY_MAX_MS, 0, 5000));
          // Nhiễu nhỏ để hai tiến trình không đập vào nhau cùng nhịp.
          await sleep(wait + Math.floor(Math.random() * 10));
        }
      }
    }
    throw Object.assign(
      new Error(message || `DB đang bận (database is locked) sau ${tries} lần thử — thao tác chưa được ghi.`),
      { code, details: { ...(details || {}), retryable: true, attempts: tries, driver_code: lastErr?.code ?? null }, cause: lastErr },
    );
  }

  async init() {
    // A1 (phản biện R1 vòng 2): BOOT ĐỒNG THỜI trên DB TRẮNG. Nhiều tiến trình cùng chạy DDL
    // (schema + migration) có thể gặp `database is locked`; trước đây lỗi đó làm CHẾT tiến trình
    // (đo được 6/16 lần boot). Nay `init()` tự thử lại với backoff — cùng lắm là boot chậm hơn.
    const attempts = clampInt(this.config?.queue?.initRetries, 10, 1, 50);
    // A5 (phản biện R1 vòng 2): trần chờ phải áp cho CẢ LIÊN TIẾN TRÌNH. Mỗi lần thử đã chờ
    // `busy_timeout` (= `queue.lockTimeoutMs`) ở tầng driver; nhân với số lần thử sẽ thành 50s+.
    // Vì vậy tổng ngân sách thử lại bị chặn bởi `queue.lockTimeoutMs` (mặc định 5000ms).
    const budgetMs = this.#lockTimeoutMs();
    const startedAt = Date.now();
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.#initOnce();
      } catch (err) {
        last = err;
        if (!isBusyError(err)) throw err;
        const spent = Date.now() - startedAt;
        if (spent >= budgetMs) {
          this.logger?.warn('store.init_busy_budget_exhausted', { attempt, spent_ms: spent, budget_ms: budgetMs });
          break;
        }
        this.logger?.warn('store.init_busy_retry', { attempt, attempts, spent_ms: spent, error_code: err?.code ?? null });
        await sleep(Math.min(500, 100 * attempt, Math.max(0, budgetMs - spent)));
      }
    }
    throw asRepoBusyError(last, {
      code: 'QUEUE_BUSY',
      message: `Khởi tạo store thất bại: DB đang bận quá ${budgetMs}ms (tiến trình khác đang giữ khoá ghi).`,
      details: { budget_ms: budgetMs },
    });
  }

  /** Thân `init()` một lượt (schema + migration + seed) — tách ra để `init()` thử lại được. */
  async #initOnce() {
    await this.driver.connect();
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    // PostgreSQL không hỗ trợ "PRAGMA"; schema không chứa PRAGMA nên chạy thẳng được.
    if (this.isPostgres) {
      await this.driver.exec(schema);
    } else {
      await this.driver.exec(schema);
    }
    await this.#applyAdditiveMigrations();
    // MVP-05: bảng giá phải có ĐỦ mọi operation trong `USAGE_OPERATIONS` (kể cả
    // `CONTENT_REPAIR`) trước khi bất kỳ ai gọi `priceOf()` — nếu không, ước tính giữ tiền
    // sẽ ném `UNKNOWN_OPERATION`.
    await this.#seedPricing();
    this.logger?.info('store.initialized', { dialect: this.dialect });
    return this;
  }

  /**
   * Migration CỘNG THÊM (additive) — bắt buộc IDEMPOTENT.
   *
   * `data/studio.db` của MVP-01 đã có bảng `jobs` từ trước, nên `CREATE TABLE IF NOT
   * EXISTS` trong schema KHÔNG thể thêm cột `kind` cho nó. Phải ALTER tại chỗ:
   *   - SQLite: đọc `PRAGMA table_info(<bảng>)`, thiếu cột thì mới ALTER (SQLite không
   *     có `ADD COLUMN IF NOT EXISTS`).
   *   - PostgreSQL: `ADD COLUMN IF NOT EXISTS` tự idempotent.
   * Nhờ vậy `init()` chạy hai lần liên tiếp không lỗi, và DB cũ nâng cấp được tại chỗ.
   *
   * MVP-05 thêm 2 cột (hợp đồng §2.1) — cả hai đều NULL-able và KHÔNG backfill:
   *   - `jobs.user_id`         NULL = job ẩn danh (luật #1: người dùng ẩn danh không bị phá)
   *   - `image_assets.user_id` NULL = ảnh của phiên ẩn danh
   * Job/asset CŨ giữ nguyên `user_id = NULL`, KHÔNG tự gán cho ai (hợp đồng §2.2).
   */
  async #applyAdditiveMigrations() {
    await this.#addColumnIfMissing('jobs', 'kind', "TEXT DEFAULT 'content'");
    await this.#addColumnIfMissing('jobs', 'user_id', 'TEXT');
    await this.#addColumnIfMissing('image_assets', 'user_id', 'TEXT');
    // MVP-05 (vòng 2): `wallet_ledger.seq` — thứ tự TĂNG DẦN trong phạm vi một user, để
    // `listLedger` sắp xếp ỔN ĐỊNH (nhiều dòng có thể cùng mili-giây). DB tạo trước vòng
    // này chưa có cột ⇒ thêm tại chỗ; dòng cũ giữ `seq = 0` (không UPDATE sổ append-only).
    await this.#addColumnIfMissing('wallet_ledger', 'seq', 'INTEGER NOT NULL DEFAULT 0');
    await this.#createIndexIfPossible('idx_wallet_ledger_user_seq', 'wallet_ledger', 'user_id, seq');
    // MVP-05 (vòng 2, PB-02/PB-04): `wallet_ledger.run_key` — khoá chu kỳ tiền theo LƯỢT CHẠY
    // (`<jobId>#<n>`), để mỗi lượt chạy lại có hold/settle/refund riêng. Thêm SAU migration
    // (bài học `seq`: index trong `schema.sql` làm chết `init()` trên DB cũ).
    await this.#addColumnIfMissing('wallet_ledger', 'run_key', 'TEXT');
    // BR-03b (vòng 3): `wallet_ledger.close_kind` — 'settle' | 'refund' cho dòng ĐÓNG lượt chạy.
    // Nhờ cột này, ràng buộc ở tầng DB phát biểu được đúng luật "MỘT dòng đóng cho mỗi lượt"
    // (unique trên `(user_id, job_id, run_key)` WHERE `close_kind IS NOT NULL`) — unique theo
    // `reason` không chặn được cặp settle+refund cho cùng lượt.
    await this.#addColumnIfMissing('wallet_ledger', 'close_kind', 'TEXT');
    await this.#createUniqueIndexIfPossible('uniq_wallet_ledger_run_close', 'wallet_ledger', {
      columns: 'user_id, job_id, run_key',
      where: 'close_kind IS NOT NULL AND run_key IS NOT NULL',
    });
    // BR-07 (vòng 3): `usage_events.run_key` — chi phí THẬT phải quy được về TỪNG LƯỢT CHẠY,
    // nếu không `afterJob` sẽ settle theo usage TÍCH LUỸ của cả job (thu thừa các lượt trước).
    await this.#addColumnIfMissing('usage_events', 'run_key', 'TEXT');
    // R1-F2 (vòng sửa phản biện): `job_queue.heartbeat_at` — nhịp tim của worker đang giữ mục.
    // Thêm SAU migration (bài học `seq`/`run_key`): index/cột mới không được làm chết `init()`.
    await this.#addColumnIfMissing('job_queue', 'heartbeat_at', 'TEXT');
    // R1-A3 (vòng 2): `job_queue.epoch` — số thứ tự lần CLAIM, dùng làm "fencing token".
    // Mỗi lần claim tăng 1; mọi thao tác kết thúc (complete/fail/heartbeat) chỉ được chấp nhận
    // nếu epoch còn khớp ⇒ kết quả của runner ĐÃ BỊ CƯỚP không thể ghi đè trạng thái/tiền của
    // runner mới.
    await this.#addColumnIfMissing('job_queue', 'epoch', 'INTEGER NOT NULL DEFAULT 0');
    await this.#createIndexIfPossible('idx_job_queue_status_created', 'job_queue', 'status, created_at, id');
    await this.#createIndexIfPossible('idx_usage_run_key', 'usage_events', 'job_id, run_key');
    await this.#createIndexIfPossible('idx_wallet_ledger_run_key', 'wallet_ledger', 'user_id, job_id, run_key');
    await this.#createUniqueIndexIfPossible('uniq_wallet_ledger_run_reason', 'wallet_ledger', {
      columns: 'user_id, job_id, run_key, reason',
      where: "reason IN ('job_hold','job_settle','job_refund') AND run_key IS NOT NULL",
    });
    // Index tra cứu theo chủ sở hữu (A4 lọc dữ liệu theo user). Tạo SAU khi cột đã tồn tại;
    // lỗi ở đây không được làm chết boot (DB cũ/hỏng vẫn phải chạy được MVP-01/02/03).
    await this.#createIndexIfPossible('idx_jobs_user_id', 'jobs', 'user_id');
    await this.#createIndexIfPossible('idx_image_assets_user_id', 'image_assets', 'user_id');
    // R1 (hợp đồng §2.1): index của `job_queue` được tạo Ở ĐÂY, không phải trong schema.sql —
    // xem bài học `wallet_ledger.seq` ngay trên: index trong file schema chạy TRƯỚC migration
    // nên DB cũ (bảng đã có nhưng thiếu cột) sẽ chết `init()`. Hàm `#createIndexIfPossible`
    // bắt lỗi và chỉ ghi log, nên `init()` chạy hai lần liên tiếp vẫn không lỗi.
    await this.#createIndexIfPossible('idx_job_queue_status_run_after', 'job_queue', 'status, run_after');
    await this.#createIndexIfPossible('idx_job_queue_job_id', 'job_queue', 'job_id');
    await this.#createIndexIfPossible('idx_job_queue_locked_at', 'job_queue', 'locked_at');
    // ⚠️ KHÔNG unique index trên `(job_id, handler)`: hai REQUEST ĐỒNG THỜI trên cùng một job là
    // hai LƯỢT CHẠY riêng (mỗi lượt có `run_key` và bị thu tiền riêng — MVP-05 §BR-02), nên hai
    // mục sống cùng `(job_id, handler)` là HỢP LỆ. Khoá idempotency thật nằm ở `job_queue.id`
    // (id tất định theo `(jobId, handler, runKey)` do JobQueue truyền vào) — xem `enqueueJob`.
    // Dòng dưới chỉ để DỌN index mà bản R1-Q trung gian đã tạo (idempotent, DB mới không có gì).
    await this.#dropIndexIfPossible('uniq_job_queue_live');
  }

  /** Xoá index nếu tồn tại — dùng để dọn index của bản trung gian; lỗi chỉ ghi log. */
  async #dropIndexIfPossible(name) {
    try {
      await this.driver.run(`DROP INDEX IF EXISTS ${name}`);
    } catch (err) {
      this.logger?.warn('store.migration.index_drop_skipped', { name, error: err?.message || String(err) });
    }
  }

  /** Thêm cột nếu thiếu — idempotent trên CẢ hai driver (xem #applyAdditiveMigrations). */
  async #addColumnIfMissing(table, column, ddl) {
    if (this.isPostgres) {
      // `IF NOT EXISTS` của PostgreSQL đã idempotent, nhưng hai tiến trình boot cùng lúc vẫn có
      // thể đua ở tầng catalog ⇒ bọc thêm lớp chịu lỗi "đã tồn tại".
      await this.#runIdempotentDdl(() => this.driver.run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${ddl}`), { table, column });
      return;
    }
    const info = await this.driver.all(`PRAGMA table_info(${table})`);
    // Bảng chưa tồn tại (schema lỗi?) thì không ALTER — tránh lỗi khó hiểu.
    if (!Array.isArray(info) || info.length === 0) return;
    if (info.some((col) => col?.name === column)) return;
    const added = await this.#runIdempotentDdl(() => this.driver.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`), { table, column });
    if (added) this.logger?.info('store.migration.column_added', { table, column, dialect: this.dialect });
  }

  /**
   * A1 (phản biện R1 vòng 2, VỪA–CAO) — DDL PHẢI CHỊU ĐƯỢC ĐUA KHỞI ĐỘNG.
   *
   * Vì sao: hai tiến trình boot cùng lúc trên DB trắng đều thấy cột thiếu rồi cùng `ALTER TABLE`;
   * kẻ thua nhận `duplicate column name: …` ⇒ `init()` ném ⇒ **tiến trình CHẾT** (đo được 2–6/16
   * lần boot). "Đã tồn tại" là kết quả MONG MUỐN của migration idempotent, không phải lỗi.
   *
   * @returns {Promise<boolean>} `true` nếu câu lệnh thực sự tạo mới, `false` nếu đã có sẵn.
   */
  async #runIdempotentDdl(run, meta = {}) {
    try {
      await run();
      return true;
    } catch (err) {
      const text = `${err?.code ?? ''} ${err?.message ?? ''}`;
      if (/duplicate column name|already exists|duplicate key value|SQLITE_ERROR.*duplicate/i.test(text)) {
        this.logger?.info('store.migration.already_applied', { ...meta, dialect: this.dialect });
        return false;
      }
      throw err;
    }
  }

  /** Tạo index nếu có thể — DB cũ thiếu cột thì chỉ ghi log, KHÔNG làm chết `init()`. */
  async #createIndexIfPossible(name, table, column) {
    try {
      await this.#runIdempotentDdl(() => this.driver.run(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${column})`), { name, table });
    } catch (err) {
      this.logger?.warn('store.migration.index_skipped', { name, table, column, error: err?.message || String(err) });
    }
  }

  /**
   * Tạo UNIQUE index nếu có thể (PB-04, vòng 2) — chặn hai tiến trình ghi trùng một chu kỳ
   * tiền của cùng lượt chạy. Partial unique index chạy được trên CẢ SQLite và PostgreSQL.
   * Lỗi (DB cũ đã có dữ liệu trùng, driver không hỗ trợ…) chỉ ghi log, KHÔNG làm chết `init()`.
   */
  async #createUniqueIndexIfPossible(name, table, { columns, where = '' } = {}) {
    try {
      // ⚠️ `WHERE` phải nằm NGOÀI dấu ngoặc của danh sách cột (partial index); nhét vào trong
      // là lỗi cú pháp trên cả SQLite lẫn PostgreSQL.
      const clause = where ? ` WHERE ${where}` : '';
      await this.#runIdempotentDdl(
        () => this.driver.run(`CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${table} (${columns})${clause}`),
        { name, table },
      );
    } catch (err) {
      this.logger?.warn('store.migration.unique_index_skipped', {
        name,
        table,
        error: err?.message || String(err),
      });
    }
  }

  /**
   * Seed bảng `pricing` từ `config.cost` (hợp đồng §2.3 — `billing.pricingFromCost`) và bảo
   * đảm MỌI operation trong `USAGE_OPERATIONS` đều có giá.
   *
   * Vì sao bắt buộc: `CONTENT_REPAIR` có trong hợp đồng §2.1 + `USAGE_OPERATIONS` nhưng
   * KHÔNG có trong `config.cost`; thiếu dòng giá thì `priceOf('CONTENT_REPAIR')` ném
   * `UNKNOWN_OPERATION` và cả lượt ước tính giữ tiền đổ.
   *
   * Idempotent (upsert `ON CONFLICT ... DO UPDATE`) và chạy mỗi lần `init()`:
   *   - operation thiếu trong `config.cost` ⇒ dùng `DEFAULT_PRICING` (GIÁ MẶC ĐỊNH CỦA REPO,
   *     KHÔNG phải giá nhà cung cấp) và ghi rõ nguồn vào `note`;
   *   - `config.billing.pricingFromCost === false` ⇒ KHÔNG seed (giữ giá đã chỉnh tay).
   */
  async #seedPricing() {
    if (this.config?.billing?.pricingFromCost === false) return;
    const cost = this.config?.cost || {};
    const currency = String(this.config?.billing?.currency || cost.currency || 'USD');
    for (const operation of USAGE_OPERATIONS) {
      const fromConfig = toNum(cost[operation], null);
      const unitPrice = fromConfig === null ? DEFAULT_PRICING[operation] : fromConfig;
      if (!Number.isFinite(Number(unitPrice))) continue;
      try {
        await this.upsertPricing({
          operation,
          unitPrice,
          currency,
          note: fromConfig === null
            ? 'giá MẶC ĐỊNH của repo (config.cost thiếu khoá này — không phải giá nhà cung cấp)'
            : 'seed từ config.cost',
        });
      } catch (err) {
        // Seed hỏng KHÔNG được làm chết boot: A2 vẫn còn fallback `config.cost` khi tính giá.
        this.logger?.warn('store.pricing_seed_failed', { operation, error: err?.message || String(err) });
      }
    }
    this.logger?.info('store.pricing_seeded', { operations: USAGE_OPERATIONS.length, currency });
  }

  async close() {
    await this.driver.close();
  }

  /* ───────────────────────────── Jobs ───────────────────────────── */

  async createJob({ id = randomUUID(), sessionId = '', source = '', sourceUrl = '', canonicalUrl = '', sourceProductId = '', style = '', length = '', inputMode = 'link', kind = JOB_KINDS.CONTENT, userId = null } = {}) {
    const ts = nowIso();
    const jobKind = String(kind || JOB_KINDS.CONTENT);
    // MVP-05: `userId = null` ⇒ job ẩn danh (luật #1 — không có ví, không trừ credit).
    await this.driver.run(
      `INSERT INTO jobs (id, session_id, source, source_url, canonical_url, source_product_id,
        product_name, status, stage, style, length, input_mode, kind, user_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, sessionId, source, sourceUrl, canonicalUrl, sourceProductId, '', JOB_STATUS.QUEUED, 'queued', style, length, inputMode, jobKind, userId || null, ts, ts],
    );
    return id;
  }

  /** Cập nhật job. Chỉ nhận các cột nằm trong allowlist — không nội suy tên cột từ input. */
  async updateJob(id, patch = {}) {
    const COLUMNS = {
      status: null,
      stage: null,
      error_code: null,
      error_message: null,
      product_name: null,
      source: null,
      canonical_url: null,
      source_product_id: null,
      product_master: toJson,
      vision: toJson,
      knowledge: toJson,
      content: toJson,
      evidence: toJson,
      content_meta: toJson,
      finished_at: null,
      style: null,
      length: null,
      kind: null,
    };
    const sets = [];
    const params = [];
    for (const [col, transform] of Object.entries(COLUMNS)) {
      if (!(col in patch)) continue;
      sets.push(`${col} = ?`);
      params.push(transform ? transform(patch[col]) : patch[col]);
    }
    if (sets.length === 0) return 0;
    sets.push('updated_at = ?');
    params.push(nowIso());
    params.push(id);
    const res = await this.driver.run(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, params);
    return res.changes;
  }

  async getJob(id) {
    const row = await this.driver.get('SELECT * FROM jobs WHERE id = ?', [id]);
    return row ? this.#hydrateJob(row) : null;
  }

  #hydrateJob(row) {
    return {
      id: row.id,
      session_id: row.session_id,
      // MVP-05: NULL = job ẩn danh. Đây là field A4 dùng để tách dữ liệu theo tài khoản
      // (`jobs.user_id === user.id`), KHÔNG được trả cho client khi chưa đăng nhập.
      user_id: row.user_id ?? null,
      source: row.source,
      source_url: row.source_url,
      canonical_url: row.canonical_url,
      source_product_id: row.source_product_id,
      product_name: row.product_name,
      status: row.status,
      stage: row.stage,
      error_code: row.error_code,
      error_message: row.error_message,
      style: row.style,
      length: row.length,
      input_mode: row.input_mode,
      // DB cũ (trước migration) có thể chưa có cột này → coi như job nội dung.
      kind: row.kind || JOB_KINDS.CONTENT,
      product_master: fromJson(row.product_master),
      vision: fromJson(row.vision),
      knowledge: fromJson(row.knowledge),
      content: fromJson(row.content),
      evidence: fromJson(row.evidence),
      content_meta: fromJson(row.content_meta),
      created_at: row.created_at,
      updated_at: row.updated_at,
      finished_at: row.finished_at,
    };
  }

  /**
   * Lịch sử job.
   *
   * MVP-05: thêm bộ lọc TUỲ CHỌN `userId` (A4 dùng để chỉ trả job của chính người đăng
   * nhập). Chỉ lọc khi `userId` là chuỗi khác rỗng — nhờ vậy hành vi CŨ (theo `sessionId`,
   * hoặc không lọc) giữ nguyên 100% và job ẩn danh không bị lộ sang nhau.
   */
  async listJobs({ sessionId = null, userId, limit = 50, offset = 0 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const COLUMNS = 'id, session_id, user_id, kind, source, source_url, product_name, status, stage, style, length, content_meta, created_at, updated_at';
    if (typeof userId === 'string' && userId) {
      return this.driver.all(
        `SELECT ${COLUMNS} FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [userId, lim, off],
      );
    }
    const rows = sessionId
      ? await this.driver.all(
          `SELECT ${COLUMNS}
           FROM jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [sessionId, lim, off],
        )
      : await this.driver.all(
          `SELECT ${COLUMNS}
           FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [lim, off],
        );
    return rows;
  }

  /** Đếm job — cùng quy ước lọc với `listJobs` (MVP-05: thêm `userId` tuỳ chọn). */
  async countJobs({ sessionId = null, userId } = {}) {
    const row = (typeof userId === 'string' && userId)
      ? await this.driver.get('SELECT COUNT(*) AS n FROM jobs WHERE user_id = ?', [userId])
      : sessionId
        ? await this.driver.get('SELECT COUNT(*) AS n FROM jobs WHERE session_id = ?', [sessionId])
        : await this.driver.get('SELECT COUNT(*) AS n FROM jobs');
    return Number(row?.n ?? 0);
  }

  /* ─────────────────────── Usage / billing (G13) ─────────────────────── */

  async recordUsage({
    id = randomUUID(),
    jobId = null,
    sessionId = '',
    runKey = null,
    run_key = null,
    operation,
    provider = '',
    model = '',
    inputUnits = 0,
    outputUnits = 0,
    estimatedCost = 0,
    currency = 'USD',
    meta = null,
  }) {
    await this.driver.run(
      `INSERT INTO usage_events (id, job_id, session_id, run_key, operation, provider, model,
        input_units, output_units, estimated_cost, currency, meta, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, jobId, sessionId, runKey ?? run_key ?? null, operation, provider, model,
        inputUnits, outputUnits, estimatedCost, currency, toJson(meta), nowIso(),
      ],
    );
    return id;
  }

  async listUsage(jobId) {
    return this.driver.all('SELECT * FROM usage_events WHERE job_id = ? ORDER BY created_at ASC', [jobId]);
  }

  /**
   * Tổng hợp chi phí theo job — nền tảng cho credit-based billing.
   *
   * BR-07 (vòng 3): nhận thêm `runKey` để lấy chi phí của **RIÊNG MỘT LƯỢT CHẠY**. Không có
   * tham số này thì vẫn là tổng của cả job (tương thích ngược cho route thống kê).
   * Dòng cũ (ghi trước khi có cột) mang `run_key IS NULL` ⇒ quy về lượt `#1` — nhờ vậy DB cũ
   * vẫn quyết toán đúng cho lượt chạy đầu tiên thay vì thu 0.
   */
  async usageSummary(jobId, { runKey = null, run_key = null } = {}) {
    const run = runKey ?? run_key ?? null;
    const firstRun = typeof run === 'string' && /#1$/.test(run);
    const where = run
      ? (firstRun ? 'WHERE job_id = ? AND (run_key = ? OR run_key IS NULL)' : 'WHERE job_id = ? AND run_key = ?')
      : 'WHERE job_id = ?';
    const params = run ? [jobId, run] : [jobId];
    const row = await this.driver.get(
      `SELECT COUNT(*) AS events, COALESCE(SUM(estimated_cost),0) AS cost,
              COALESCE(SUM(input_units),0) AS input_units, COALESCE(SUM(output_units),0) AS output_units
       FROM usage_events ${where}`,
      params,
    );
    return {
      events: Number(row?.events ?? 0),
      estimated_cost: Number(row?.cost ?? 0),
      input_units: Number(row?.input_units ?? 0),
      output_units: Number(row?.output_units ?? 0),
    };
  }

  /* ────────────────────── Extraction evidence (G14) ────────────────────── */

  async recordEvidence({
    id = randomUUID(),
    jobId = null,
    connector = '',
    extractionMethod = '',
    verification = 'BLOCKED',
    httpStatus = null,
    bytes = 0,
    loginRequired = false,
    blockedReason = '',
    foundFields = [],
    missingFields = [],
    visionProvider = '',
    contentProvider = '',
  }) {
    await this.driver.run(
      `INSERT INTO extraction_evidence (id, job_id, connector, extraction_method, verification,
        http_status, bytes, login_required, blocked_reason, found_fields, missing_fields,
        vision_provider, content_provider, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, jobId, connector, extractionMethod, verification, httpStatus, bytes,
        loginRequired ? 1 : 0, blockedReason, toJson(foundFields), toJson(missingFields),
        visionProvider, contentProvider, nowIso(),
      ],
    );
    return id;
  }

  async getEvidence(jobId) {
    const rows = await this.driver.all(
      'SELECT * FROM extraction_evidence WHERE job_id = ? ORDER BY created_at DESC LIMIT 5',
      [jobId],
    );
    return rows.map((r) => ({
      ...r,
      login_required: Boolean(r.login_required),
      found_fields: fromJson(r.found_fields) || [],
      missing_fields: fromJson(r.missing_fields) || [],
    }));
  }

  /* ─────────────────────────── Uploads (G11) ─────────────────────────── */

  async recordUpload({ id = randomUUID(), jobId = null, sessionId = '', filename = '', mime = '', bytes = 0, source = 'manual' }) {
    await this.driver.run(
      `INSERT INTO uploads (id, job_id, session_id, filename, mime, bytes, source, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, jobId, sessionId, filename, mime, bytes, source, nowIso()],
    );
    return id;
  }

  async listUploads(jobId) {
    return this.driver.all('SELECT * FROM uploads WHERE job_id = ? ORDER BY created_at ASC', [jobId]);
  }

  /* ═══════════════════════ MVP-02 — ImageLab (C4) ═══════════════════════ */

  /* ─────────────────────────── image_assets ─────────────────────────── */

  /**
   * Ghi một `ImageAsset` (ảnh gốc hoặc ảnh đã render). Trả về id.
   * `role` bắt buộc thuộc {original, rendered} — fail-closed, không nhận giá trị lạ.
   */
  async createImageAsset({
    id = randomUUID(),
    jobId = null,
    sessionId = '',
    userId = null,
    role,
    parentId = null,
    mime = '',
    bytes = 0,
    width = null,
    height = null,
    sha256 = '',
    storagePath = '',
    source = 'upload',
    meta = null,
  } = {}) {
    if (!IMAGE_ASSET_ROLES.includes(role)) {
      throw new Error(`image_assets.role không hợp lệ: ${JSON.stringify(String(role ?? ''))} (chỉ nhận original|rendered).`);
    }
    if (!jobId) throw new Error('createImageAsset thiếu jobId.');
    await this.driver.run(
      `INSERT INTO image_assets (id, job_id, session_id, user_id, role, parent_id, mime, bytes, width, height,
        sha256, storage_path, source, meta, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        // MVP-05: `userId = null` ⇒ ảnh của phiên ẩn danh (luật #1 — không bắt buộc đăng nhập).
        id, jobId, sessionId, userId || null, role, parentId, mime, toNum(bytes, 0), toIntOrNull(width), toIntOrNull(height),
        sha256, storagePath, source, toJson(meta), nowIso(),
      ],
    );
    return id;
  }

  #hydrateImageAsset(row) {
    return {
      id: row.id,
      job_id: row.job_id,
      session_id: row.session_id,
      // MVP-05: NULL = ảnh của phiên ẩn danh (A4 kiểm chủ sở hữu qua job).
      user_id: row.user_id ?? null,
      role: row.role,
      parent_id: row.parent_id ?? null,
      mime: row.mime || '',
      bytes: toNum(row.bytes, 0),
      width: toNum(row.width, null),
      height: toNum(row.height, null),
      sha256: row.sha256 || '',
      storage_path: row.storage_path || '',
      source: row.source || '',
      meta: fromJson(row.meta),
      created_at: row.created_at,
    };
  }

  async getImageAsset(id) {
    const row = await this.driver.get('SELECT * FROM image_assets WHERE id = ?', [id]);
    return row ? this.#hydrateImageAsset(row) : null;
  }

  async listImageAssets(jobId, { role } = {}) {
    const rows = role
      ? await this.driver.all('SELECT * FROM image_assets WHERE job_id = ? AND role = ? ORDER BY created_at ASC, id ASC', [jobId, role])
      : await this.driver.all('SELECT * FROM image_assets WHERE job_id = ? ORDER BY created_at ASC, id ASC', [jobId]);
    return rows.map((r) => this.#hydrateImageAsset(r));
  }

  /**
   * Cập nhật `meta` của một ImageAsset (merge nông, giữ khoá cũ).
   * Dùng để ghi vết OCR (vùng bị bỏ, cảnh báo) lên ảnh gốc sau khi `runOcr` xong —
   * C5 đọc `asset.meta.ocr` để hiện "vùng bị bỏ kèm lý do" mà không phải bịa.
   */
  async updateImageAssetMeta(id, meta = {}) {
    const row = await this.driver.get('SELECT meta FROM image_assets WHERE id = ?', [id]);
    if (!row) return 0;
    const merged = { ...(fromJson(row.meta) || {}), ...(meta && typeof meta === 'object' ? meta : {}) };
    const res = await this.driver.run('UPDATE image_assets SET meta = ? WHERE id = ?', [toJson(merged), id]);
    return Number(res?.changes ?? 0);
  }

  /* ─────────────────────────── ocr_regions ─────────────────────────── */

  /**
   * Lưu vùng OCR — IDEMPOTENT THEO JOB: xoá hết vùng cũ của job rồi ghi lại.
   * Nhờ vậy gọi lại `runOcr` (retry) không sinh vùng trùng.
   */
  async saveOcrRegions(jobId, assetId, regions = []) {
    const list = Array.isArray(regions) ? regions : [];
    const ts = nowIso();
    return this.driver.transaction(async (tx) => {
      await tx.run('DELETE FROM ocr_regions WHERE job_id = ?', [jobId]);
      let saved = 0;
      for (let i = 0; i < list.length; i += 1) {
        const r = list[i] || {};
        // `id` trong DB là khoá kỹ thuật duy nhất toàn cục; id vùng theo hợp đồng
        // ('r1'…) nằm ở `region_key` — vì 'r1' của hai job khác nhau sẽ đụng PRIMARY KEY.
        const key = String(r.id ?? r.region_key ?? `r${i + 1}`);
        const box = r.box || {};
        const norm = r.box_normalized || {};
        await tx.run(
          `INSERT INTO ocr_regions (id, job_id, asset_id, region_key, x, y, w, h,
            x_norm, y_norm, w_norm, h_norm, text_original, lang, confidence, kind, kind_reason,
            translatable, source, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            randomUUID(), jobId, assetId, key,
            toIntOrNull(box.x), toIntOrNull(box.y), toIntOrNull(box.w), toIntOrNull(box.h),
            toNum(norm.x, null), toNum(norm.y, null), toNum(norm.w, null), toNum(norm.h, null),
            String(r.text ?? r.text_original ?? ''), r.lang || 'und', toNum(r.confidence, 0),
            r.kind || 'unknown', r.kind_reason || '',
            // Fail-closed: chỉ nhận translatable khi C1 khai ĐÚNG `true`.
            (r.translatable === true ? 1 : 0),
            r.source || 'ocr', ts,
          ],
        );
        saved += 1;
      }
      return saved;
    });
  }

  /** Trả về `Region` (hợp đồng 3.2) + `asset_id` + `region_key`, theo thứ tự đọc trên→dưới. */
  async listOcrRegions(jobId) {
    const rows = await this.driver.all(
      'SELECT * FROM ocr_regions WHERE job_id = ? ORDER BY y ASC, x ASC',
      [jobId],
    );
    return rows.map((row) => ({
      id: row.region_key || row.id,
      asset_id: row.asset_id,
      region_key: row.region_key || row.id,
      box: {
        x: toNum(row.x, null),
        y: toNum(row.y, null),
        w: toNum(row.w, null),
        h: toNum(row.h, null),
      },
      box_normalized: {
        x: toNum(row.x_norm, null),
        y: toNum(row.y_norm, null),
        w: toNum(row.w_norm, null),
        h: toNum(row.h_norm, null),
      },
      text: row.text_original || '',
      // Bí danh cột DB (C5 và tools/imagelab-demo.mjs đều đọc `text ?? text_original`).
      text_original: row.text_original || '',
      lang: row.lang || 'und',
      confidence: toNum(row.confidence, 0),
      kind: row.kind || 'unknown',
      kind_reason: row.kind_reason || '',
      translatable: Boolean(row.translatable),
      source: row.source || 'ocr',
    }));
  }

  /* ───────────────────────── translation_lines ───────────────────────── */

  /** Lưu bản dịch — IDEMPOTENT THEO JOB: xoá dòng cũ của job rồi ghi lại. */
  async saveTranslationLines(jobId, lines = []) {
    const list = Array.isArray(lines) ? lines : [];
    const ts = nowIso();
    return this.driver.transaction(async (tx) => {
      await tx.run('DELETE FROM translation_lines WHERE job_id = ?', [jobId]);
      let saved = 0;
      for (const line of list) {
        const l = line || {};
        const key = String(l.region_id ?? l.region_key ?? '');
        if (!key) continue; // dòng không có khoá vùng là dòng hỏng — không ghi
        await tx.run(
          `INSERT INTO translation_lines (id, job_id, region_key, text_original, text_vi,
            status, provenance, confidence, violations, notes, edited_by_user, edited_at,
            created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            randomUUID(), jobId, key,
            String(l.text_original ?? ''), String(l.text_vi ?? ''),
            l.status || 'NEEDS_REVIEW', l.provenance || 'none', toNum(l.confidence, 0),
            toJson(Array.isArray(l.violations) ? l.violations : []), String(l.notes ?? ''),
            l.edited_by_user ? 1 : 0, l.edited_at ?? null, ts, ts,
          ],
        );
        saved += 1;
      }
      return saved;
    });
  }

  /** Trả về `TranslatedLine` (hợp đồng 3.3), xếp theo thứ tự đọc của vùng OCR. */
  async listTranslationLines(jobId) {
    const rows = await this.driver.all(
      `SELECT tl.* FROM translation_lines tl
       LEFT JOIN ocr_regions r ON r.job_id = tl.job_id AND r.region_key = tl.region_key
       WHERE tl.job_id = ?
       ORDER BY r.y ASC, r.x ASC, tl.created_at ASC`,
      [jobId],
    );
    return rows.map((row) => ({
      region_id: row.region_key,
      text_original: row.text_original || '',
      text_vi: row.text_vi || '',
      status: row.status || '',
      provenance: row.provenance || 'none',
      confidence: toNum(row.confidence, 0),
      violations: fromJson(row.violations) || [],
      edited_by_user: Boolean(row.edited_by_user),
      edited_at: row.edited_at ?? null,
      notes: row.notes || '',
    }));
  }

  /**
   * Cập nhật tại chỗ các dòng đã có, khoá theo `region_key` trong phạm vi job.
   * Chỉ nhận cột trong allowlist; trả về số dòng đã cập nhật.
   */
  async updateTranslationLines(jobId, lines = []) {
    const list = Array.isArray(lines) ? lines : [];
    const ts = nowIso();
    return this.driver.transaction(async (tx) => {
      let changed = 0;
      for (const line of list) {
        const l = line || {};
        const key = String(l.region_id ?? l.region_key ?? '');
        if (!key) continue;
        const sets = [];
        const params = [];
        if ('text_vi' in l) {
          sets.push('text_vi = ?');
          params.push(String(l.text_vi ?? ''));
        }
        if ('status' in l) {
          sets.push('status = ?');
          params.push(l.status || 'NEEDS_REVIEW');
        }
        if ('provenance' in l) {
          sets.push('provenance = ?');
          params.push(l.provenance || 'none');
        }
        if ('confidence' in l) {
          sets.push('confidence = ?');
          params.push(toNum(l.confidence, 0));
        }
        if ('violations' in l) {
          sets.push('violations = ?');
          params.push(toJson(Array.isArray(l.violations) ? l.violations : []));
        }
        if ('notes' in l) {
          sets.push('notes = ?');
          params.push(String(l.notes ?? ''));
        }
        if ('edited_by_user' in l) {
          sets.push('edited_by_user = ?');
          params.push(l.edited_by_user ? 1 : 0);
        }
        if ('edited_at' in l) {
          sets.push('edited_at = ?');
          params.push(l.edited_at ?? null);
        }
        sets.push('updated_at = ?');
        params.push(ts);
        params.push(jobId, key);
        const res = await tx.run(
          `UPDATE translation_lines SET ${sets.join(', ')} WHERE job_id = ? AND region_key = ?`,
          params,
        );
        changed += Number(res?.changes ?? 0);
      }
      return changed;
    });
  }

  /* ═════════════════ MVP-05 — TÀI KHOẢN, PHIÊN, VÍ CREDIT ═════════════════
   *
   * Toàn bộ tầng tài khoản/ví đi qua đây (A1 + A2 chỉ đọc file này, không viết vào).
   * Hai luật riêng của MVP-05 được giữ ở tầng thấp nhất:
   *   #1 Ẩn danh không bị phá — không method nào ở đây BẮT BUỘC phải có tài khoản; job
   *      ẩn danh (`user_id = NULL`) vẫn chạy và KHÔNG có dòng sổ nào.
   *   #2 Sổ APPEND-ONLY — chỉ có `appendLedger` (INSERT) và các hàm ĐỌC. Không có
   *      UPDATE/DELETE trên `wallet_ledger`, không có cột `balance` sửa tay.
   */

  /* ─────────────────────────────── users ─────────────────────────────── */

  /** Chuẩn hoá email: trim + lowercase (hợp đồng §2.1: "đã chuẩn hoá lowercase"). */
  #normalizeEmail(email) {
    return String(email ?? '').trim().toLowerCase();
  }

  /**
   * Người dùng trả về tầng trên. CÓ `password_hash` vì A1 cần để `verifyPassword`;
   * A1 chịu trách nhiệm lọc bằng `toPublicUser` trước khi trả ra HTTP (hợp đồng §3.1).
   */
  #hydrateUser(row) {
    return {
      id: row.id,
      email: row.email,
      display_name: row.display_name ?? '',
      role: row.role || 'member',
      password_hash: row.password_hash,
      status: row.status || 'active',
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_login_at: row.last_login_at ?? null,
    };
  }

  async createUser({ id = randomUUID(), email, displayName = '', display_name = '', role = 'member', passwordHash = '', password_hash = '', status = 'active' } = {}) {
    const normalized = this.#normalizeEmail(email);
    if (!normalized) throw Object.assign(new Error('createUser thiếu email hợp lệ.'), { code: 'INVALID_EMAIL' });
    const hash = String(passwordHash || password_hash || '');
    if (!hash) throw Object.assign(new Error('createUser thiếu passwordHash (mật khẩu thô KHÔNG bao giờ vào store).'), { code: 'INVALID_PASSWORD_HASH' });
    const ts = nowIso();
    try {
      await this.driver.run(
        `INSERT INTO users (id, email, display_name, role, password_hash, status, created_at, updated_at, last_login_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, normalized, String(displayName ?? display_name ?? ''), String(role || 'member'), hash, String(status || 'active'), ts, ts, null],
      );
    } catch (err) {
      // Đua nhau đăng ký cùng email: UNIQUE của DB là chốt cuối. Dịch thành mã máy đọc được
      // để A1 trả 409 thay vì 500 (SQLite: SQLITE_CONSTRAINT_UNIQUE, PostgreSQL: 23505).
      const text = String(err?.message || '');
      if (err?.code === '23505' || /UNIQUE|duplicate key/i.test(text)) {
        throw Object.assign(new Error('Email đã được đăng ký.'), { code: 'EMAIL_TAKEN', cause: err });
      }
      throw err;
    }
    return this.getUserById(id);
  }

  async getUserByEmail(email) {
    const normalized = this.#normalizeEmail(email);
    if (!normalized) return null;
    const row = await this.driver.get('SELECT * FROM users WHERE email = ?', [normalized]);
    return row ? this.#hydrateUser(row) : null;
  }

  async getUserById(id) {
    if (!id) return null;
    const row = await this.driver.get('SELECT * FROM users WHERE id = ?', [String(id)]);
    return row ? this.#hydrateUser(row) : null;
  }

  /**
   * Danh sách người dùng cho trang quản trị — CỐ TÌNH không trả `password_hash`
   * (đây đúng là đường dễ rò rỉ nhất; A1 vẫn lọc lại bằng `toPublicUser`).
   */
  async listUsers({ limit = 50, offset = 0 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const rows = await this.driver.all(
      `SELECT id, email, display_name, role, status, created_at, updated_at, last_login_at
       FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [lim, off],
    );
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      display_name: row.display_name ?? '',
      role: row.role || 'member',
      status: row.status || 'active',
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_login_at: row.last_login_at ?? null,
    }));
  }

  /** Tổng số người dùng — để A4 trả `{ items, total }` cho `GET /api/admin/users`. */
  async countUsers() {
    const row = await this.driver.get('SELECT COUNT(*) AS n FROM users');
    return Number(row?.n ?? 0);
  }

  /**
   * Đếm người dùng theo vai trò — A1 dùng để chặn hạ cấp `owner` CUỐI CÙNG (đếm bằng SQL
   * thay vì phân trang `listUsers`). A1 coi method này là TUỲ CHỌN nên thiếu cũng không sao.
   */
  async countUsersByRole(role) {
    const row = await this.driver.get('SELECT COUNT(*) AS n FROM users WHERE role = ?', [String(role || '')]);
    return Number(row?.n ?? 0);
  }

  /**
   * Cập nhật người dùng theo allowlist (không nội suy tên cột từ input).
   * Trả về người dùng SAU khi cập nhật, hoặc `null` nếu không tồn tại.
   */
  async updateUser(id, patch = {}) {
    if (!id) return null;
    const sets = [];
    const params = [];
    const push = (col, value) => {
      sets.push(`${col} = ?`);
      params.push(value);
    };
    if ('email' in patch) {
      const normalized = this.#normalizeEmail(patch.email);
      if (normalized) push('email', normalized);
    }
    if ('display_name' in patch || 'displayName' in patch) {
      push('display_name', String(patch.display_name ?? patch.displayName ?? ''));
    }
    if ('role' in patch) push('role', String(patch.role || 'member'));
    if ('password_hash' in patch || 'passwordHash' in patch) {
      push('password_hash', String(patch.password_hash ?? patch.passwordHash ?? ''));
    }
    if ('status' in patch) push('status', String(patch.status || 'active'));
    if ('last_login_at' in patch || 'lastLoginAt' in patch) {
      push('last_login_at', patch.last_login_at ?? patch.lastLoginAt ?? null);
    }
    if (sets.length === 0) return this.getUserById(id);
    push('updated_at', nowIso());
    params.push(String(id));
    await this.driver.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.getUserById(id);
  }

  /** Ghi dấu lần đăng nhập gần nhất. Trả về người dùng sau khi cập nhật (null nếu không có). */
  async touchLastLogin(id, at = nowIso()) {
    if (!id) return null;
    await this.driver.run(
      'UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?',
      [at, at, String(id)],
    );
    return this.getUserById(id);
  }

  /* ─────────────────────────── user_sessions ─────────────────────────── */

  /** Phiên đăng nhập — DB chỉ có `token_hash`, KHÔNG BAO GIỜ có token thô. */
  #hydrateUserSession(row) {
    return {
      id: row.id,
      user_id: row.user_id,
      token_hash: row.token_hash,
      created_at: row.created_at,
      expires_at: row.expires_at,
      last_seen_at: row.last_seen_at ?? null,
      revoked_at: row.revoked_at ?? null,
      user_agent: row.user_agent ?? null,
    };
  }

  async createUserSession({ id = randomUUID(), userId = null, user_id = null, tokenHash = '', token_hash = '', createdAt = null, created_at = null, expiresAt = null, expires_at = null, userAgent = '', user_agent = '' } = {}) {
    const uid = String(userId || user_id || '');
    const hash = String(tokenHash || token_hash || '');
    const expires = expiresAt || expires_at || null;
    if (!uid || !hash || !expires) {
      throw Object.assign(new Error('createUserSession cần userId, tokenHash và expiresAt.'), { code: 'INVALID_SESSION' });
    }
    await this.driver.run(
      `INSERT INTO user_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at, revoked_at, user_agent)
       VALUES (?,?,?,?,?,?,?,?)`,
      // `createdAt` do A1 truyền (nếu có) được tôn trọng — test hết hạn phiên cần mốc thời gian xác định.
      [id, uid, hash, createdAt || created_at || nowIso(), expires, null, null, String(userAgent ?? user_agent ?? '')],
    );
    return this.getUserSessionByTokenHash(hash);
  }

  async getUserSessionByTokenHash(tokenHash) {
    const hash = String(tokenHash ?? '');
    if (!hash) return null;
    const row = await this.driver.get('SELECT * FROM user_sessions WHERE token_hash = ?', [hash]);
    return row ? this.#hydrateUserSession(row) : null;
  }

  /** Cập nhật `last_seen_at`. Trả về số dòng đã đổi (0 = phiên không tồn tại). */
  async touchUserSession(id, at = nowIso()) {
    if (!id) return 0;
    const res = await this.driver.run('UPDATE user_sessions SET last_seen_at = ? WHERE id = ?', [at, String(id)]);
    return Number(res?.changes ?? 0);
  }

  /** Thu hồi MỘT phiên (đăng xuất). Trả về số dòng đã đổi. */
  async revokeUserSession(id, at = nowIso()) {
    if (!id) return 0;
    const res = await this.driver.run(
      'UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
      [at, String(id)],
    );
    return Number(res?.changes ?? 0);
  }

  /** Thu hồi MỌI phiên còn hiệu lực của một người dùng (đổi mật khẩu / khoá tài khoản). */
  async revokeAllUserSessions(userId, at = nowIso()) {
    if (!userId) return 0;
    const res = await this.driver.run(
      'UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
      [at, String(userId)],
    );
    return Number(res?.changes ?? 0);
  }

  /* ──────────────────────────── wallet_ledger ──────────────────────────── */

  #hydrateLedgerRow(row) {
    return {
      id: row.id,
      user_id: row.user_id,
      // Số thứ tự tăng dần trong sổ của user — khoá sắp xếp ỔN ĐỊNH cho phân trang.
      seq: Number(toNum(row.seq, 0)),
      amount: roundMoney(row.amount),
      currency: row.currency || 'USD',
      reason: row.reason,
      job_id: row.job_id ?? null,
      // PB-02 (vòng 2): khoá chu kỳ tiền theo LƯỢT CHẠY — cột riêng (không chỉ trong `meta`)
      // để tầng billing đọc lại được mà không phải parse JSON.
      run_key: row.run_key ?? null,
      close_kind: row.close_kind ?? null,
      operation: row.operation ?? null,
      meta: fromJson(row.meta),
      balance_after: roundMoney(row.balance_after),
      created_at: row.created_at,
    };
  }

  /**
   * Ghi MỘT dòng sổ (append-only) và trả về dòng vừa ghi kèm `balance_after`.
   *
   * NGUYÊN TỬ: số dư được tính bằng `SUM(amount)` và dòng mới được chèn trong CÙNG một
   * transaction (`driver.transaction`) — hai request cùng lúc không thể cùng đọc một số dư
   * rồi ghi hai dòng lệch nhau.
   *
   * FAIL-CLOSED: nếu số dư sau khi cộng < 0 thì NÉM lỗi `code = 'INSUFFICIENT_CREDIT'` và
   * KHÔNG ghi dòng nào (transaction rollback) — đây là chốt chặn cuối của A2, không đường
   * nào làm số dư âm được (luật #2).
   *
   * Sai số dấu phẩy động: `amount` là REAL nên một phép trừ "về 0" có thể ra -1e-17. Dùng
   * dung sai EPS: chỉ coi là âm thật khi vượt quá dung sai, nhờ vậy không từ chối oan một
   * giao dịch hợp lệ vì nhiễu số học.
   */
  async appendLedger({ id = randomUUID(), userId = null, user_id = null, amount, currency = 'USD', reason = 'adjustment', jobId = null, job_id = null, runKey = null, run_key = null, operation = null, meta = null } = {}) {
    const uid = String(userId || user_id || '');
    if (!uid) throw Object.assign(new Error('appendLedger thiếu userId.'), { code: 'INVALID_LEDGER_ROW' });
    const value = toNum(amount, null);
    if (value === null) {
      throw Object.assign(new Error(`appendLedger: amount không phải số hữu hạn (${JSON.stringify(amount)}).`), { code: 'INVALID_LEDGER_ROW' });
    }
    const ts = nowIso();
    // TIỀN TỆ LÀM TRÒN 6 CHỮ SỐ ngay tại biên ghi sổ: REAL cộng thô sinh 1.9000000000000001,
    // khiến `ledgerBalance` trả 9.995999999999999 và mọi test so `===` đều lệch ~1e-15.
    const valueRounded = roundMoney(value);
    const row = {
      id,
      user_id: uid,
      amount: valueRounded,
      currency: String(currency || 'USD'),
      reason: String(reason || 'adjustment'),
      job_id: jobId ?? job_id ?? null,
      run_key: runKey ?? run_key ?? null,
      // BR-03b: dòng ĐÓNG lượt chạy (settle/refund) được đánh dấu để unique index chặn việc
      // một lượt vừa settle vừa refund (trên PostgreSQL, đọc-rồi-ghi giữa 2 tiến trình vẫn hở).
      close_kind: (() => {
        const r = String(reason || '');
        if (r === 'job_settle') return 'settle';
        if (r === 'job_refund') return 'refund';
        return null;
      })(),
      operation: operation ?? null,
      meta: meta && typeof meta === 'object' ? meta : null,
      created_at: ts,
    };
    // R1 (§3): nếu ĐANG ở trong `withLedgerLock` thì ghi vào CHÍNH transaction đó (bám theo
    // ngữ cảnh async); còn không thì mở transaction riêng — vẫn giữ nguyên luật "đọc số dư +
    // chèn dòng trong MỘT transaction". Nhờ nhánh đầu, R2-B gọi `store.appendLedger()` bên
    // trong khoá mà không sinh transaction lồng nhau (SQLite: BEGIN chồng BEGIN là lỗi).
    const active = this.#activeTx();
    if (active) return this.#appendLedgerOn(active.tx, row, uid, ts);
    // A4/F5: đường gọi TRỰC TIẾP vẫn phải trả mã của repo khi DB bận (không lộ `ERR_SQLITE_ERROR`).
    const wrap = (err) => asRepoBusyError(err, {
      code: 'LEDGER_BUSY',
      message: `Sổ credit đang bận (khoá ghi) — chưa ghi được dòng cho user ${uid}.`,
      details: { user_id: uid, reason: row.reason, job_id: row.job_id },
    });
    if (this.isPostgres) {
      try {
        return await this.driver.transaction((tx) => this.#appendLedgerOn(tx, row, uid, ts));
      } catch (err) {
        throw wrap(err);
      }
    }
    try {
      return await this.#withSqliteTx((tx) => this.#appendLedgerOn(tx, row, uid, ts), { immediate: true });
    } catch (err) {
      throw wrap(err);
    }
  }

  /** Thân của `appendLedger` chạy TRÊN một transaction đã có (driver hoặc transaction đang mở). */
  async #appendLedgerOn(tx, row, uid, ts) {
    // Số dư VÀ số thứ tự `seq` được đọc trong CÙNG transaction với lần chèn: hai request
    // cùng lúc không thể cùng đọc một số dư (hay cùng một `seq`) rồi ghi hai dòng lệch nhau.
    const current = await tx.get(
      'SELECT COALESCE(SUM(amount),0) AS total, COALESCE(MAX(seq),0) AS max_seq FROM wallet_ledger WHERE user_id = ?',
      [uid],
    );
    const balanceBefore = roundMoney(toNum(current?.total, 0));
    const balanceAfter = roundMoney(balanceBefore + row.amount);
    if (balanceAfter < -EPS_LEDGER) {
      throw Object.assign(
        new Error(`Không đủ credit: số dư ${balanceBefore} + ${row.amount} < 0.`),
        { code: 'INSUFFICIENT_CREDIT', details: { user_id: uid, balance: balanceBefore, amount: row.amount, reason: row.reason, job_id: row.job_id } },
      );
    }
    const seq = Number(toNum(current?.max_seq, 0)) + 1;
    // F4 (phản biện R1, VỪA–CAO) — GHI KIỂU "KHÔNG BAO GIỜ LÀM HỎNG TRANSACTION".
    //
    // Vì sao: trên PostgreSQL, một INSERT vi phạm UNIQUE làm ABORT cả transaction ⇒ mọi câu lệnh
    // sau đó (kể cả câu SELECT để "đọc lại dòng đã có") nổ `25P02`, mã driver thô lọt ra tới HTTP,
    // và tính idempotent theo `(job_id, run_key)` mất tác dụng. `ON CONFLICT DO NOTHING`
    // (SQLite: `OR IGNORE`) KHÔNG abort: câu lệnh trả `changes = 0`, ta tự ném
    // `LEDGER_CONFLICT` (lỗi nghiệp vụ, transaction vẫn dùng được) để tầng gọi ĐỌC LẠI dòng đã có.
    const conflict = this.isPostgres ? 'ON CONFLICT DO NOTHING' : 'OR IGNORE';
    const res = await tx.run(
      `INSERT ${this.isPostgres ? 'INTO wallet_ledger' : conflict + ' INTO wallet_ledger'} (id, user_id, seq, amount, currency, reason, job_id, run_key, close_kind, operation, meta, balance_after, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)${this.isPostgres ? ` ${conflict}` : ''}`,
      [
        row.id, row.user_id, seq, row.amount, row.currency, row.reason, row.job_id, row.run_key,
        row.close_kind, row.operation, toJson(row.meta), balanceAfter, ts,
      ],
    );
    if (Number(res?.changes ?? 1) === 0) {
      // Đã có dòng cho cùng khoá unique (user, job, run_key, reason) — KHÔNG ghi thêm, KHÔNG abort.
      throw Object.assign(
        new Error(`Dòng sổ đã tồn tại cho (user=${uid}, job=${row.job_id}, run_key=${row.run_key}, reason=${row.reason}).`),
        { code: 'LEDGER_CONFLICT', details: { user_id: uid, job_id: row.job_id, run_key: row.run_key, reason: row.reason } },
      );
    }
    return { ...row, seq, balance_after: balanceAfter };
  }

  /**
   * Lịch sử sổ của một người dùng (mới nhất trước). `jobId` là bộ lọc TUỲ CHỌN — hook tính
   * tiền dùng nó để biết một job đã có chu kỳ hold/settle/refund nào chưa.
   */
  async listLedger({ userId = null, jobId = null, limit = 50, offset = 0 } = {}) {
    const uid = String(userId ?? '');
    if (!uid) return [];
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);
    // Sắp xếp ỔN ĐỊNH: `seq` giảm dần (mới nhất trước). Nhiều dòng có thể cùng `created_at`
    // tới từng mili-giây nên chỉ sắp theo thời gian là không đủ — trang sổ sẽ nhảy cóc và
    // phân trang có thể trùng/sót dòng. `created_at`/`id` chỉ còn là khoá phụ cho dòng cũ
    // (tạo trước khi có cột `seq`, giữ `seq = 0`).
    const rows = jobId
      ? await this.#exec().all(
          `SELECT * FROM wallet_ledger WHERE user_id = ? AND job_id = ? ORDER BY seq DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
          [uid, String(jobId), lim, off],
        )
      : await this.#exec().all(
          `SELECT * FROM wallet_ledger WHERE user_id = ? ORDER BY seq DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
          [uid, lim, off],
        );
    return rows.map((row) => this.#hydrateLedgerRow(row));
  }

  /**
   * BR-08 (vòng 4) — LIỆT KÊ CÁC LƯỢT CHẠY ĐANG MỞ: dòng `job_hold` có `run_key` mà **không** có
   * dòng ĐÓNG (`close_kind IS NOT NULL`) nào cùng `(user_id, job_id, run_key)`.
   *
   * `olderThanIso` (tuỳ chọn) chỉ lấy các khoản giữ CŨ HƠN mốc đó — nhờ vậy reconciliation không
   * cắt ngang một job đang chạy thật. Sắp xếp cũ nhất trước để xử lý dần.
   */
  async listOpenJobHolds({ olderThanIso = null, limit = 200, userId = null } = {}) {
    const where = [
      "h.reason = 'job_hold'",
      'h.run_key IS NOT NULL',
      'h.job_id IS NOT NULL',
      `NOT EXISTS (SELECT 1 FROM wallet_ledger c
                     WHERE c.user_id = h.user_id AND c.job_id = h.job_id
                       AND c.run_key = h.run_key AND c.close_kind IS NOT NULL)`,
    ];
    const params = [];
    if (olderThanIso) { where.push('h.created_at < ?'); params.push(String(olderThanIso)); }
    if (userId) { where.push('h.user_id = ?'); params.push(String(userId)); }
    params.push(Math.min(Math.max(Number(limit) || 200, 1), 1000));
    const rows = await this.#exec().all(
      `SELECT h.* FROM wallet_ledger h WHERE ${where.join(' AND ')}
       ORDER BY h.created_at ASC, h.seq ASC LIMIT ?`,
      params,
    );
    return rows.map((row) => this.#hydrateLedgerRow(row));
  }

  /** Số dư = TỔNG SỔ (không có cột balance sửa tay). Chưa có dòng nào ⇒ 0. */
  async ledgerBalance(userId) {
    const uid = String(userId ?? '');
    if (!uid) return 0;
    const row = await this.#exec().get('SELECT COALESCE(SUM(amount),0) AS total FROM wallet_ledger WHERE user_id = ?', [uid]);
    // Trả số ĐÃ LÀM TRÒN 6 chữ số để khớp đúng `balance_after` của dòng cuối trong sổ.
    return roundMoney(toNum(row?.total, 0));
  }

  /* ═════════ R1 — HÀNG ĐỢI BỀN (§2.1/§2.2) + KHOÁ SỔ Ở TẦNG DB (§3) ═════════
   *
   * TÊN METHOD Ở ĐÂY LÀ HỢP ĐỒNG ĐÓNG BĂNG (§2.2): R2-B gọi `withLedgerLock`, R3-S gọi
   * `requeueStaleJobs`. Đổi tên = phá vỡ lắp ghép giữa ba agent.
   *
   * Bốn luật được giữ ngay ở tầng thấp nhất:
   *   #1 NGUYÊN TỬ — `claimNextJob`/`claimQueueItem` là MỘT câu UPDATE có điều kiện
   *      `status='queued'` (PostgreSQL thêm `FOR UPDATE SKIP LOCKED`) ⇒ hai tiến trình cùng
   *      nhặt KHÔNG BAO GIỜ nhận cùng một mục.
   *   #2 CHỐNG TRÙNG THEO KHOÁ LƯỢT CHẠY (không phải `(job_id, handler)`): id mục hàng đợi là
   *      khoá idempotency do JobQueue truyền vào (tất định khi có `runKey`) — hai request đồng
   *      thời trên cùng một job là HAI LƯỢT riêng và phải chạy cả hai (MVP-05 §BR-02: mỗi lượt
   *      thu tiền riêng). Xem `enqueueJob`.
   *   #3 KHOÁ SỔ THEO NGƯỜI DÙNG — SQLite `BEGIN IMMEDIATE` + thử lại có giới hạn; PostgreSQL
   *      `pg_advisory_xact_lock`. `fn` chạy TRONG transaction; lỗi ⇒ rollback rồi ném lại.
   *   #4 FAIL-CLOSED — mọi lỗi đều có `code`; hết lượt thử vì bận ⇒ `LEDGER_BUSY`/`QUEUE_BUSY`,
   *      KHÔNG im lặng coi như thành công.
   */

  /* ─────────────────────── §3 — khoá tiền theo người dùng ─────────────────────── */

  /**
   * Chạy `fn` trong một transaction GIỮ KHOÁ theo `userId`.
   *
   * R2-B dùng: mọi thao tác ghi sổ (đọc số dư + chèn dòng) phải nằm trong cùng transaction
   * này, nếu không hai tiến trình vẫn đọc được cùng một số dư rồi ghi hai dòng lệch nhau.
   *
   *   `fn` nhận một `tx` ({ run, all, get, appendLedger, ledgerBalance, listLedger }) —
   *   và các method của `store` gọi BÊN TRONG `fn` cũng tự bám vào transaction này
   *   (AsyncLocalStorage), nên cả hai cách viết đều đúng.
   *
   * Lỗi: `fn` ném ⇒ ROLLBACK rồi ném LẠI NGUYÊN lỗi (giữ `code` nghiệp vụ như
   * `INSUFFICIENT_CREDIT`). Bận quá N lần ⇒ lỗi `code = 'LEDGER_BUSY'` (kèm `retryable: true`).
   */
  async withLedgerLock(userId, fn) {
    const uid = String(userId ?? '').trim();
    if (!uid) {
      throw Object.assign(new Error('withLedgerLock: thiếu userId — khoá sổ phải theo NGƯỜI DÙNG.'), { code: 'INVALID_LEDGER_LOCK' });
    }
    if (typeof fn !== 'function') {
      throw Object.assign(new Error('withLedgerLock: tham số thứ hai phải là hàm (nhận tx).'), { code: 'INVALID_LEDGER_LOCK' });
    }
    // Đã ở TRONG một khoá (fn gọi lồng nhau, hoặc appendLedger gọi lại) ⇒ chạy tiếp trong CÙNG
    // transaction. Mở transaction thứ hai ở đây là lỗi trên SQLite ("cannot start a transaction
    // within a transaction") và làm mất tính nguyên tử trên PostgreSQL.
    const active = this.#activeTx();
    if (active) return fn(this.#txView(active.tx));
    if (this.isPostgres) return this.#withPgLedgerLock(uid, fn);
    return this.#withSqliteLedgerLock(uid, fn);
  }

  /** Tham số thử lại khi bận — đọc từ `config.queue.*` (R3-S) với mặc định của repo. */
  #ledgerLockOptions() {
    const cfg = this.config?.queue || {};
    return {
      attempts: clampInt(cfg.ledgerLockRetries, LEDGER_LOCK_RETRIES, 1, 50),
      baseMs: clampInt(cfg.ledgerLockRetryBaseMs, LEDGER_LOCK_RETRY_BASE_MS, 0, 5000),
      maxMs: clampInt(cfg.ledgerLockRetryMaxMs, LEDGER_LOCK_RETRY_MAX_MS, 0, 5000),
    };
  }

  /**
   * SQLite: `BEGIN IMMEDIATE` — giữ khoá GHI ngay câu lệnh đầu.
   *
   * Vì sao IMMEDIATE: transaction mở bằng ĐỌC rồi mới ghi sẽ đụng `SQLITE_BUSY_SNAPSHOT` khi
   * tiến trình khác vừa ghi xong, và `busy_timeout` KHÔNG thử lại loại xung đột đó (SQLite trả
   * lỗi ngay) ⇒ "database is locked" đúng như lỗi đã ghi trong hợp đồng. Giữ khoá ghi từ đầu
   * thì chỉ còn chờ khoá thường — `busy_timeout = 5000ms` (đặt ở `SqliteDriver.connect()`)
   * lo phần chờ, còn `#retryOnBusy` lo phần hi hữu còn lại.
   */
  async #withSqliteLedgerLock(uid, fn) {
    const opts = this.#ledgerLockOptions();
    // A5 (SQLite): trần LIÊN TIẾN TRÌNH do `PRAGMA busy_timeout` quyết định — driver lấy từ
    // `config.queue.lockTimeoutMs` (xem `SqliteDriver.busyTimeoutMs`).
    return this.#retryOnBusy(
      () => this.#withSqliteTx(async (tx) => {
        const view = this.#txView(tx);
        // Toàn bộ `fn` chạy bên trong transaction; ALS để mọi lời gọi store lồng bên trong
        // (appendLedger, ledgerBalance…) dùng CHÍNH kết nối này.
        return this.#txAls.run({ tx, userId: uid }, () => fn(view));
      }, { immediate: true }),
      {
        ...opts,
        code: 'LEDGER_BUSY',
        message: `Sổ credit đang bận (database is locked) sau ${opts.attempts} lần thử — thao tác của user ${uid} chưa được ghi.`,
        details: { user_id: uid },
      },
    );
  }

  /**
   * PostgreSQL: `pg_advisory_xact_lock(hashtext(userId))` — khoá theo NGƯỜI DÙNG, giữ tới hết
   * transaction (tự nhả khi COMMIT/ROLLBACK, không có đường rò khoá). `hashtext()` trả int4 nên
   * ép `::bigint` tường minh để không phụ thuộc quy tắc chọn overload của PostgreSQL.
   */
  async #withPgLedgerLock(uid, fn) {
    const timeoutMs = this.#lockTimeoutMs();
    return this.driver.transaction(async (tx) => {
      // A5 (phản biện R1 vòng 2, VỪA): TRẦN CHỜ KHOÁ PHẢI ÁP Ở TẦNG DB, không chỉ trong tiến trình.
      // Trước đây tiến trình khác chờ tới **32,4s** mới fail (khoá ghi của SQLite) vì trần chỉ nằm
      // trong bộ nhớ. `lock_timeout`/`statement_timeout` buộc MÁY CHỦ cắt sớm ⇒ lỗi trả về đúng
      // hạn ở mọi tiến trình.
      await tx.run(`SET LOCAL lock_timeout = '${timeoutMs}ms'`);
      await tx.run(`SET LOCAL statement_timeout = '${timeoutMs * 3}ms'`);
      await tx.run('SELECT pg_advisory_xact_lock(hashtext(?)::bigint)', [uid]);
      return this.#txAls.run({ tx, userId: uid }, () => fn(this.#txView(tx)));
    });
  }

  /* ───────────────────────── §2.2 — bảng `job_queue` ───────────────────────── */

  /** Dòng hàng đợi trả ra tầng trên — `payload` đã parse JSON (nhỏ, KHÔNG chứa base64 ảnh). */
  #hydrateQueueRow(row) {
    return {
      id: row.id,
      job_id: row.job_id,
      kind: row.kind,
      handler: row.handler,
      payload: fromJson(row.payload),
      status: row.status,
      attempts: Number(toNum(row.attempts, 0)),
      max_attempts: Number(toNum(row.max_attempts, 3)),
      run_after: row.run_after ?? null,
      locked_at: row.locked_at ?? null,
      heartbeat_at: row.heartbeat_at ?? null,
      epoch: Number(toNum(row.epoch, 0)),
      locked_by: row.locked_by ?? null,
      last_error: row.last_error ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      finished_at: row.finished_at ?? null,
    };
  }

  /**
   * Mục SỐNG (`queued`/`running`) của một cặp `(job_id, handler)` — CHỈ dùng cho đường
   * `enqueueJob` KHÔNG truyền `id` (tầng gọi trực tiếp). JobQueue luôn truyền `id` (khoá
   * idempotency theo LƯỢT CHẠY) nên hai request đồng thời không bị gộp ở đây.
   */
  async #findLiveQueueItem(jobId, handler) {
    const row = await this.driver.get(
      `SELECT * FROM job_queue
        WHERE job_id = ? AND handler = ? AND status IN ('queued','running')
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [jobId, handler],
    );
    return row ? this.#hydrateQueueRow(row) : null;
  }

  /**
   * Xếp một mục việc vào hàng đợi BỀN (ghi DB TRƯỚC khi chạy — hợp đồng §2.3).
   *
   * HAI ĐƯỜNG, và đây là chỗ suýt gây hồi quy nghiệp vụ (xem báo cáo R1-Q):
   *
   *  1. **Có `id` do tầng gọi truyền** (JobQueue luôn truyền): id CHÍNH LÀ khoá idempotency.
   *     - `id` TẤT ĐỊNH theo `(jobId, handler, runKey)` ⇒ hai tiến trình cùng xếp MỘT lượt chạy
   *       thì PRIMARY KEY chặn kẻ đến sau (nguyên tử, không cần index phụ), kẻ đó đọc lại mục cũ
   *       và trả `reused: true`.
   *     - `id` ngẫu nhiên (lượt chạy KHÔNG có khoá) ⇒ là một lượt RIÊNG: hai request render
   *       đồng thời trên cùng một job là HAI ý định, phải có hai mục và phải chạy cả hai
   *       (MVP-05 §BR-02: mỗi lượt thu tiền riêng — đây là kết luận đã nghiệm thu, không được
   *       gộp lại thành một).
   *     Mục cùng id đã `done`/`failed` ⇒ MỞ LẠI (cùng một khoá = cùng một lượt chạy).
   *
   *  2. **Không truyền `id`** (tầng gọi trực tiếp, đường cũ): giữ luật §2.3 — đã có mục SỐNG
   *     cùng `(jobId, handler)` thì trả mục cũ kèm `reused: true`.
   */
  async enqueueJob({ id = null, jobId = null, kind = 'content', handler = 'run', payload = null, maxAttempts = 3, runAfter = null } = {}) {
    const jid = String(jobId ?? '').trim();
    if (!jid) throw Object.assign(new Error('enqueueJob thiếu jobId.'), { code: 'INVALID_QUEUE_ITEM' });
    const h = String(handler ?? '').trim() || 'run';
    const explicitId = id === null || id === undefined || String(id).trim() === '' ? null : String(id).trim();
    if (!explicitId) {
      const existing = await this.#findLiveQueueItem(jid, h);
      if (existing) return { ...existing, reused: true };
    }
    // A2 (phản biện R1 vòng 2, VỪA): mục đang `queued` NHƯNG ĐÃ CHẠM TRẦN là mục "rác" — giữ
    // nguyên `attempts` thì `claim` trả `null` mãi mãi (kẹt `queued` vĩnh viễn + `done` giả từ
    // vòng poll). `enqueue` lại chính khoá đó là MỘT LƯỢT MỚI ⇒ reset `attempts`, tăng `epoch`.
    if (explicitId) {
      const known = await this.getQueueItemById(explicitId).catch(() => null);
      if (known && (known.status === 'queued' || known.status === 'running')
        && Number(known.attempts) >= Number(known.max_attempts)) {
        await this.driver.run(
          `UPDATE job_queue
              SET status = 'queued', attempts = 0, epoch = epoch + 1, run_after = ?,
                  locked_at = NULL, locked_by = NULL, heartbeat_at = NULL,
                  finished_at = NULL, last_error = NULL, updated_at = ?
            WHERE id = ?`,
          [runAfter ? String(runAfter) : null, nowIso(), explicitId],
        );
        const fresh = await this.getQueueItemById(explicitId);
        this.logger?.info('store.queue_item_revived', { queue_item_id: explicitId, job_id: jid, attempts: fresh?.attempts ?? 0 });
        return { ...fresh, revived: true, reused: false };
      }
    }
    const ts = nowIso();
    const row = {
      id: explicitId || randomUUID(),
      job_id: jid,
      kind: String(kind || 'content'),
      handler: h,
      payload: toJson(payload),
      status: 'queued',
      attempts: 0,
      max_attempts: clampInt(maxAttempts, 3, 1, 100),
      run_after: runAfter ? String(runAfter) : null,
      locked_at: null,
      locked_by: null,
      last_error: null,
      created_at: ts,
      updated_at: ts,
      finished_at: null,
    };
    try {
      await this.driver.run(
        `INSERT INTO job_queue (id, job_id, kind, handler, payload, status, attempts, max_attempts,
           run_after, locked_at, locked_by, last_error, created_at, updated_at, finished_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          row.id, row.job_id, row.kind, row.handler, row.payload, row.status, row.attempts, row.max_attempts,
          row.run_after, row.locked_at, row.locked_by, row.last_error, row.created_at, row.updated_at, row.finished_at,
        ],
      );
    } catch (err) {
      // Đã có dòng cùng khoá (PRIMARY KEY) — hai tiến trình cùng xếp MỘT lượt chạy.
      const same = explicitId ? await this.getQueueItemById(explicitId).catch(() => null) : null;
      if (same && (same.status === 'queued' || same.status === 'running')) return { ...same, reused: true };
      if (same) {
        // Cùng khoá idempotency nhưng lượt trước đã kết thúc ⇒ MỞ LẠI chính mục đó (không đẻ
        // thêm mục cho cùng một khoá), rồi trả về để chạy.
        //
        // A2 (phản biện R1 vòng 2, VỪA): mở lại là LƯỢT MỚI ⇒ phải **RESET `attempts`** và cấp
        // `epoch` mới. Trước đây `attempts` giữ nguyên giá trị cũ ⇒ mục vừa mở lại đã chạm trần
        // ngay: `claim` trả `null`, vòng poll nhặt lại liên tục và phát `done(skipped=true)` GIẢ
        // (đo được 10 lần dựng handler + 10 `done` giả trong 2 giây dù handler chạy 0 lần).
        await this.driver.run(
          `UPDATE job_queue
              SET status = 'queued', attempts = 0, epoch = epoch + 1, run_after = ?,
                  locked_at = NULL, locked_by = NULL, heartbeat_at = NULL,
                  finished_at = NULL, last_error = NULL, updated_at = ?
            WHERE id = ?`,
          [row.run_after, ts, explicitId],
        );
        const revived = await this.getQueueItemById(explicitId);
        this.logger?.info('store.queue_item_revived', { queue_item_id: explicitId, job_id: jid, handler: h });
        return { ...revived, revived: true };
      }
      if (!explicitId) {
        const again = await this.#findLiveQueueItem(jid, h).catch(() => null);
        if (again) return { ...again, reused: true };
      }
      throw err;
    }
    return this.#hydrateQueueRow(row);
  }

  /** Thân chung của `claimNextJob` (nhặt mục KẾ TIẾP) và `claimQueueItem` (nhặt ĐÚNG một mục). */
  async #claimQueueRow({ id = null, workerId = 'worker', now = null } = {}) {
    const ts = String(now || nowIso());
    const wid = String(workerId || 'worker');
    // PostgreSQL: `FOR UPDATE SKIP LOCKED` để tiến trình thứ hai NHẢY QUA mục đang bị khoá thay
    // vì chờ rồi nhặt lại chính mục đó. SQLite không có cú pháp này, nhưng câu UPDATE có điều
    // kiện `status='queued'` + `RETURNING *` đã là NGUYÊN TỬ: một câu lệnh, một khoá ghi, chỉ
    // một tiến trình thấy `changes`/`RETURNING` khác rỗng.
    const skipLocked = this.isPostgres ? ' FOR UPDATE SKIP LOCKED' : '';
    // F1 (phản biện R1, CAO): TRẦN SỐ LẦN THỬ phải được tôn trọng NGAY Ở ĐÂY.
    // Trước đây câu này chỉ lọc `status='queued'` ⇒ vòng crash-loop (tiến trình bị kill lặp) làm
    // mục được nhặt lại MÃI MÃI: đo được handler chạy 8 lần với `max_attempts=3`, DB cuối vẫn
    // `running`/`attempts=8` (không bao giờ `failed`) ⇒ đốt tiền provider vô hạn.
    // `max_attempts` là nguồn sự thật trong DB; mục đã chạm trần do `requeueStaleJobs` chốt
    // `failed` (xem dưới), còn điều kiện ở đây là chốt thứ hai.
    const target = id
      ? `(SELECT id FROM job_queue WHERE id = ? AND status = 'queued' AND attempts < max_attempts${skipLocked})`
      : `(SELECT id FROM job_queue WHERE status = 'queued' AND attempts < max_attempts
           AND (run_after IS NULL OR run_after <= ?)
           ORDER BY created_at ASC, id ASC LIMIT 1${skipLocked})`;
    const params = id ? [ts, wid, ts, ts, id] : [ts, wid, ts, ts, ts];
    const sql = `UPDATE job_queue
                    SET status = 'running', attempts = attempts + 1, epoch = epoch + 1,
                        locked_at = ?, locked_by = ?, heartbeat_at = ?, updated_at = ?
                  WHERE id = ${target} AND status = 'queued'
                  RETURNING *`;
    const row = await this.#retryOnBusy(
      () => this.#inTransaction(async (tx) => {
        const rows = await tx.all(sql, params);
        return Array.isArray(rows) && rows[0] ? rows[0] : null;
      }),
      {
        attempts: clampInt(this.config?.queue?.claimRetries, LEDGER_LOCK_RETRIES, 1, 50),
        code: 'QUEUE_BUSY',
        message: 'Hàng đợi đang bận (database is locked) — chưa nhặt được mục nào.',
        details: { worker_id: wid },
      },
    );
    return row ? this.#hydrateQueueRow(row) : null;
  }

  /**
   * Nhặt mục KẾ TIẾP đã tới hạn (`queued`, `run_after` đã qua) — NGUYÊN TỬ.
   * Trả `null` khi hàng đợi rỗng. Hết lượt thử vì bận ⇒ ném `code = 'QUEUE_BUSY'`
   * (KHÔNG trả `null`: trả null là tầng gọi hiểu nhầm "hết việc" rồi ngồi không).
   */
  async claimNextJob({ workerId = 'worker', now = null } = {}) {
    return this.#claimQueueRow({ id: null, workerId, now });
  }

  /**
   * Nhặt ĐÚNG một mục đã biết (JobQueue đang giữ mục trong bộ nhớ) — cùng bảo đảm nguyên tử
   * với `claimNextJob`. Trả `null` nếu mục đã bị tiến trình khác nhặt / đã xong / bị huỷ.
   * Nhờ vậy tiến trình "kẻ đến sau" KHÔNG chạy lại việc mà tiến trình khác đã nhận.
   */
  async claimQueueItem(id, { workerId = 'worker', now = null } = {}) {
    const qid = String(id ?? '').trim();
    if (!qid) throw Object.assign(new Error('claimQueueItem thiếu id mục hàng đợi.'), { code: 'INVALID_QUEUE_ITEM' });
    return this.#claimQueueRow({ id: qid, workerId, now });
  }

  /** Đánh dấu mục đã XONG. Trả `true` nếu thật sự có dòng đổi trạng thái. */
  async completeQueueItem(id, { epoch = null, force = false } = {}) {
    const qid = String(id ?? '').trim();
    if (!qid) return false;
    const ts = nowIso();
    const wantsEpoch = normalizeEpoch(epoch);
    // B1 (phản biện R1 vòng 3, VỪA): `epoch` là BẮT BUỘC — thiếu epoch thì KHÔNG được chốt `done`.
    // Trước đây lời gọi thiếu epoch vẫn chốt được mục của runner KHÁC (fencing chỉ có tác dụng khi
    // tầng gọi tự nguyện truyền epoch ⇒ "fencing tuỳ chọn"). `force: true` chỉ dành cho đường VẬN
    // HÀNH (dọn mục rác) và luôn ghi log.
    if (wantsEpoch === null) {
      if (force !== true) {
        this.logger?.warn('store.complete_missing_epoch', { queue_item_id: qid });
        return false;
      }
      this.logger?.warn('store.complete_forced', { queue_item_id: qid });
    }
    // A3 (fencing): runner ĐÃ BỊ CƯỚP (epoch lệch) không được chốt `done` — nếu không, kết quả của
    // nó ghi đè trạng thái của runner mới.
    const res = await this.driver.run(
      `UPDATE job_queue
          SET status = 'done', locked_at = NULL, locked_by = NULL, heartbeat_at = NULL, last_error = NULL,
              updated_at = ?, finished_at = ?
        WHERE id = ? AND status IN ('running','queued')${wantsEpoch === null ? '' : ' AND epoch = ?'}`,
      wantsEpoch === null ? [ts, ts, qid] : [ts, ts, qid, wantsEpoch],
    );
    return Number(res?.changes ?? 0) > 0;
  }

  /**
   * Ghi nhận một lần THẤT BẠI của mục hàng đợi.
   *
   * `attempts` (đã tăng lúc nhặt) < `max_attempts` ⇒ trả mục về `queued` kèm `run_after` =
   * hiện tại + `retryDelayMs` (backoff); hết lượt ⇒ `failed` + `finished_at` (tầng JobQueue
   * phát tiếp sự kiện `failed` để job có `error_code` + `finished_at`).
   *
   * Mục biến mất khỏi DB (dữ liệu bị xoá tay?) ⇒ coi như HỎNG HẲN thay vì trả `queued`:
   * trả `queued` cho một dòng không tồn tại là vòng lặp thử lại vô tận.
   *
   * `force: true` (mở rộng, KHÔNG đổi chữ ký hợp đồng) dùng cho lỗi CẤU HÌNH không thể tự
   * khỏi — ví dụ mục khôi phục mà tiến trình này không có hàm xử lý: đánh dấu `failed` ngay
   * thay vì thử lại 3 lượt vô ích.
   */
  async failQueueItem(id, { error = null, retryDelayMs = 0, force = false, epoch = null } = {}) {
    const qid = String(id ?? '').trim();
    if (!qid) throw Object.assign(new Error('failQueueItem thiếu id mục hàng đợi.'), { code: 'INVALID_QUEUE_ITEM' });
    const row = await this.driver.get('SELECT * FROM job_queue WHERE id = ?', [qid]);
    if (!row) return { status: 'failed', attempts: 0, missing: true, last_error: errorText(error) };
    // B1: `epoch` BẮT BUỘC (trừ đường vận hành `force: true`) — thiếu epoch thì từ chối.
    const wantsEpoch = normalizeEpoch(epoch);
    if (wantsEpoch === null && force !== true) {
      this.logger?.warn('store.fail_missing_epoch', { queue_item_id: qid });
      return { status: row.status, attempts: Number(toNum(row.attempts, 0)), stale: true, missing_epoch: true, last_error: errorText(error) };
    }
    // A3 (fencing): mục đã được claim bởi LƯỢT KHÁC (epoch khác) ⇒ kết quả của runner cũ bị BỎ.
    if (wantsEpoch !== null && Number(toNum(row.epoch, 0)) !== wantsEpoch) {
      return { status: row.status, attempts: Number(toNum(row.attempts, 0)), stale: true, last_error: errorText(error) };
    }
    const attempts = Number(toNum(row.attempts, 0));
    const maxAttempts = Math.max(1, Number(toNum(row.max_attempts, 3)));
    const exhausted = force === true || attempts >= maxAttempts;
    const ts = nowIso();
    const delay = Math.max(0, Number(toNum(retryDelayMs, 0)) || 0);
    const runAfter = exhausted ? null : new Date(Date.parse(ts) + delay).toISOString();
    await this.driver.run(
      `UPDATE job_queue
          SET status = ?, run_after = ?, locked_at = NULL, locked_by = NULL,
              last_error = ?, updated_at = ?, finished_at = ?
        WHERE id = ? AND status IN (${force === true ? "'running','queued'" : "'running'"})`,
      [exhausted ? 'failed' : 'queued', runAfter, errorText(error), ts, exhausted ? ts : null, qid],
    );
    // Đọc lại để trả ĐÚNG trạng thái thật (lượt requeue của scheduler có thể đã chen vào).
    const after = await this.driver.get('SELECT status, attempts FROM job_queue WHERE id = ?', [qid]);
    return {
      status: after?.status ?? (exhausted ? 'failed' : 'queued'),
      attempts: Number(toNum(after?.attempts, attempts)),
      max_attempts: maxAttempts,
      run_after: runAfter,
      last_error: errorText(error),
    };
  }

  /**
   * Thu hồi các mục `running` QUÁ CŨ (tiến trình giữ chúng đã chết) về `queued` — R3-S gọi
   * mỗi nhịp cron, `JobQueue.resume()` gọi lúc khởi động.
   *
   * `olderThanMs` tính từ `COALESCE(locked_at, updated_at, created_at)` (mục thiếu `locked_at`
   * vẫn phải thu hồi được — nếu chỉ soi `locked_at` thì mục đó treo vĩnh viễn).
   */
  async requeueStaleJobs({ olderThanMs = 600000, now = null, limit = QUEUE_RESUME_LIMIT } = {}) {
    const ts = String(now || nowIso());
    const window = Math.max(0, Number(toNum(olderThanMs, 600000)) || 0);
    const parsed = Date.parse(ts);
    const cutoff = new Date((Number.isFinite(parsed) ? parsed : Date.now()) - window).toISOString();
    const lim = clampInt(limit, QUEUE_RESUME_LIMIT, 1, 1000);

    // F1+F2 (phản biện R1, CAO) — HAI NHÁNH, và chỉ thu hồi mục ĐÃ HẾT HEARTBEAT.
    //
    //  · `attempts + 1 < max_attempts` ⇒ còn lượt: trả về `queued` (kèm `run_after` để backoff).
    //  · đã chạm trần ⇒ `failed` + `finished_at` + `last_error='quá số lần thử'`. Trước đây nhánh
    //    này không tồn tại ⇒ crash-loop chạy vượt trần VÔ HẠN và mục không bao giờ `failed`.
    //  · `heartbeat_at` (F2) được worker cập nhật định kỳ trong lúc chạy ⇒ mục của job DÀI không
    //    còn bị cron "cướp" chỉ vì `locked_at` cũ; chỉ mục thật sự mất nhịp mới bị thu hồi.
    const stale = `COALESCE(heartbeat_at, locked_at, updated_at, created_at) <= ?`;
    const exhaustedSql = `UPDATE job_queue
          SET status = 'failed', locked_at = NULL, locked_by = NULL, run_after = NULL,
              last_error = ?, updated_at = ?, finished_at = ?
        WHERE id IN (
          SELECT id FROM job_queue
           WHERE status = 'running' AND attempts >= max_attempts AND ${stale}
           ORDER BY COALESCE(heartbeat_at, locked_at, updated_at, created_at) ASC LIMIT ?
        )
        RETURNING id, job_id`;
    const requeuedSql = `UPDATE job_queue
          SET status = 'queued', locked_at = NULL, locked_by = NULL, run_after = ?, updated_at = ?
        WHERE id IN (
          SELECT id FROM job_queue
           WHERE status = 'running' AND attempts < max_attempts AND ${stale}
           ORDER BY COALESCE(heartbeat_at, locked_at, updated_at, created_at) ASC LIMIT ?
        )
        RETURNING id, job_id`;
    const exhaustedRows = await this.driver.all(exhaustedSql, [QUEUE_EXHAUSTED_ERROR, ts, ts, cutoff, lim]);
    const exhausted = Array.isArray(exhaustedRows) ? exhaustedRows : [];
    const rows = await this.driver.all(requeuedSql, [ts, ts, cutoff, lim]);
    const ids = (Array.isArray(rows) ? rows : []).map((r) => r.id);
    const failedIds = exhausted.map((r) => r.id);
    return {
      requeued: ids.length,
      ids,
      // Mục CHẠM TRẦN: tầng gọi (scheduler/queue) phải chốt JOB tương ứng thành `failed`
      // (`job_id` trả kèm để không phải truy vấn thêm).
      failed: failedIds.length,
      failed_ids: failedIds,
      failed_job_ids: exhausted.map((r) => r.job_id).filter(Boolean),
    };
  }

  /**
   * F2 (phản biện R1, CAO) — GIA HẠN LEASE (heartbeat) cho một mục đang chạy.
   *
   * Worker gọi định kỳ (`stale_ms/3`) trong lúc handler chạy ⇒ cron `requeueStaleJobs` biết mục
   * còn SỐNG và KHÔNG cướp nó. Tiến trình chết ⇒ nhịp ngừng ⇒ mục quá hạn và được thu hồi (đúng
   * ý đồ). Chỉ chủ hiện tại (`locked_by`) mới gia hạn được ⇒ không ai "gia hạn hộ" mục của người khác.
   *
   * @returns {Promise<boolean>} `true` nếu còn là chủ của mục (chưa bị thu hồi).
   */
  async touchQueueItem(id, { workerId = null, now = null, epoch = null } = {}) {
    const qid = String(id ?? '').trim();
    if (!qid) return false;
    // A6 (phản biện R1 vòng 2, THẤP): BẮT BUỘC khớp `workerId`. Trước đây thiếu `workerId` vẫn
    // gia hạn được lease của NGƯỜI KHÁC (chỉ cần biết id mục) ⇒ một tiến trình lạ có thể giữ mục
    // sống mãi. Nay thiếu/lệch `workerId` ⇒ từ chối (`false`).
    const wid = workerId === null || workerId === undefined ? '' : String(workerId).trim();
    if (!wid) {
      this.logger?.warn('store.touch_missing_worker', { queue_item_id: qid });
      return false;
    }
    const ts = String(now || nowIso());
    // A3: nếu caller biết `epoch` thì còn phải khớp epoch hiện tại (fencing).
    const wantsEpoch = normalizeEpoch(epoch);
    const sql = `UPDATE job_queue
                    SET locked_at = ?, heartbeat_at = ?, updated_at = ?
                  WHERE id = ? AND status = 'running' AND locked_by = ?${wantsEpoch === null ? '' : ' AND epoch = ?'}`;
    const params = wantsEpoch === null ? [ts, ts, ts, qid, wid] : [ts, ts, ts, qid, wid, wantsEpoch];
    const res = await this.#retryOnBusy(() => this.driver.run(sql, params), {
      attempts: clampInt(this.config?.queue?.claimRetries, LEDGER_LOCK_RETRIES, 1, 50),
      code: 'QUEUE_BUSY',
      message: 'Hàng đợi đang bận (database is locked) — chưa gia hạn được lease.',
      details: { queue_item_id: qid, worker_id: wid },
    });
    return Number(res?.changes ?? 0) > 0;
  }

  /**
   * Đếm mục hàng đợi theo trạng thái. Hợp đồng §2.2 chốt ĐÚNG bốn khoá này — `cancelled`
   * (chưa dùng ở sprint này) KHÔNG nằm trong kết quả để tầng gọi không phải đoán.
   */
  async queueStats() {
    const rows = await this.driver.all('SELECT status, COUNT(*) AS n FROM job_queue GROUP BY status');
    const out = { queued: 0, running: 0, done: 0, failed: 0 };
    for (const row of Array.isArray(rows) ? rows : []) {
      const key = String(row?.status ?? '');
      if (Object.prototype.hasOwnProperty.call(out, key)) out[key] = Number(toNum(row.n, 0));
    }
    return out;
  }

  /** Mục theo ID mục hàng đợi (bổ trợ cho JobQueue; hợp đồng §2.2 chỉ chốt `getQueueItem(jobId)`). */
  async getQueueItemById(id) {
    const qid = String(id ?? '').trim();
    if (!qid) return null;
    const row = await this.driver.get('SELECT * FROM job_queue WHERE id = ?', [qid]);
    return row ? this.#hydrateQueueRow(row) : null;
  }

  /**
   * Mục hàng đợi của một JOB. Ưu tiên mục còn SỐNG (`queued`/`running`) — đó là mục quyết định
   * "job này còn việc hay không"; không có thì trả mục MỚI NHẤT (để tra cứu kết quả gần nhất).
   */
  async getQueueItem(jobId) {
    const jid = String(jobId ?? '').trim();
    if (!jid) return null;
    const live = await this.driver.get(
      `SELECT * FROM job_queue WHERE job_id = ? AND status IN ('queued','running')
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [jid],
    );
    if (live) return this.#hydrateQueueRow(live);
    const latest = await this.driver.get(
      'SELECT * FROM job_queue WHERE job_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      [jid],
    );
    return latest ? this.#hydrateQueueRow(latest) : null;
  }

  /**
   * Liệt kê mục theo trạng thái (bổ trợ cho `JobQueue.resume()`). Sắp CŨ NHẤT TRƯỚC để việc
   * khôi phục giữ đúng thứ tự đã xếp hàng.
   */
  async listQueueItems({ statuses = ['queued'], limit = QUEUE_RESUME_LIMIT, onlyClaimable = true } = {}) {
    const list = (Array.isArray(statuses) ? statuses : [statuses]).map((s) => String(s)).filter(Boolean);
    if (list.length === 0) return [];
    const placeholders = list.map(() => '?').join(',');
    // A2: mục đã CHẠM TRẦN không bao giờ được trả về cho các đường "hồi sinh" (`resume`/poll/
    // `pumpQueued`) — nhặt nó lên chỉ tạo vòng lặp rác và `done` giả. `onlyClaimable: false` dành
    // cho truy vấn quan sát.
    const extra = onlyClaimable ? ' AND attempts < max_attempts' : '';
    const rows = await this.driver.all(
      `SELECT * FROM job_queue WHERE status IN (${placeholders})${extra} ORDER BY created_at ASC, id ASC LIMIT ?`,
      [...list, clampInt(limit, QUEUE_RESUME_LIMIT, 1, 1000)],
    );
    return (Array.isArray(rows) ? rows : []).map((row) => this.#hydrateQueueRow(row));
  }

  /* ─────────────────────────────── pricing ─────────────────────────────── */

  #hydratePricing(row) {
    return {
      operation: row.operation,
      unit_price: toNum(row.unit_price, 0),
      currency: row.currency || 'USD',
      note: row.note ?? '',
      updated_at: row.updated_at,
    };
  }

  /** Thêm/ghi đè đơn giá một operation (SQL `ON CONFLICT` chạy được cả SQLite và PostgreSQL). */
  async upsertPricing({ operation, unitPrice = null, unit_price = null, currency = 'USD', note = '' } = {}) {
    const op = String(operation || '').trim();
    if (!op) throw Object.assign(new Error('upsertPricing thiếu operation.'), { code: 'INVALID_PRICING' });
    const price = toNum(unitPrice ?? unit_price, null);
    if (price === null || price < 0) {
      throw Object.assign(new Error(`upsertPricing: unit_price không hợp lệ (${JSON.stringify(unitPrice ?? unit_price)}).`), { code: 'INVALID_PRICING' });
    }
    await this.driver.run(
      `INSERT INTO pricing (operation, unit_price, currency, note, updated_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT (operation) DO UPDATE SET
         unit_price = excluded.unit_price,
         currency = excluded.currency,
         note = excluded.note,
         updated_at = excluded.updated_at`,
      [op, price, String(currency || 'USD'), String(note ?? ''), nowIso()],
    );
    const row = await this.driver.get('SELECT * FROM pricing WHERE operation = ?', [op]);
    return row ? this.#hydratePricing(row) : null;
  }

  async listPricing() {
    const rows = await this.driver.all('SELECT * FROM pricing ORDER BY operation ASC');
    return rows.map((row) => this.#hydratePricing(row));
  }

  /* ───────────────────────────── usageAggregate ───────────────────────────── */

  /**
   * Tổng hợp `usage_events` cho trang quản trị (hợp đồng §3.4).
   *
   * `groupBy ∈ {day, operation, user}`:
   *   - `day`       → `substr(created_at,1,10)` (chạy được cả SQLite lẫn PostgreSQL)
   *   - `operation` → `usage_events.operation`
   *   - `user`      → `jobs.user_id` qua JOIN (KHÔNG dùng `usage_events.session_id`:
   *                   session chỉ là phiên trình duyệt, không phải chủ sở hữu). Job ẩn danh
   *                   (`user_id IS NULL`) gom vào nhóm '(ẩn danh)'.
   *
   * Trả về mảng dòng đã chuẩn hoá:
   *   `{ group, events, estimated_cost, input_units, output_units, user_id? }`
   * (`user_id` chỉ có ở `groupBy = 'user'`; `null` = nhóm ẩn danh.)
   *
   * Mọi giá trị đếm/tổng đều được ép về `number`: PostgreSQL trả `COUNT`/`SUM(integer)` dạng
   * chuỗi bigint, còn SQLite trả số — tầng trên không phải tự đoán.
   */
  async usageAggregate({ from = null, to = null, groupBy = 'day' } = {}) {
    const group = String(groupBy || 'day');
    if (!USAGE_GROUP_BY.includes(group)) {
      throw Object.assign(new Error(`usageAggregate: groupBy không hợp lệ (${JSON.stringify(groupBy)}) — chỉ nhận ${USAGE_GROUP_BY.join('|')}.`), { code: 'INVALID_GROUP_BY' });
    }
    // Ngày trần 'YYYY-MM-DD' ⇒ mở rộng thành cả ngày (00:00:00.000 → 23:59:59.999).
    const bound = (value, edge) => {
      if (typeof value !== 'string' || !value) return null;
      return value.length === 10 ? `${value}T${edge}` : value;
    };
    const fromBound = bound(from, '00:00:00.000Z');
    const toBound = bound(to, '23:59:59.999Z');

    const where = [];
    const params = [];
    if (fromBound) {
      where.push('ue.created_at >= ?');
      params.push(fromBound);
    }
    if (toBound) {
      where.push('ue.created_at <= ?');
      params.push(toBound);
    }
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';

    const METRICS = `COUNT(*) AS events,
             COALESCE(SUM(ue.estimated_cost),0) AS estimated_cost,
             COALESCE(SUM(ue.input_units),0) AS input_units,
             COALESCE(SUM(ue.output_units),0) AS output_units`;

    let rows;
    if (group === 'user') {
      // `GROUP BY j.user_id` (không phải theo COALESCE) để PostgreSQL chấp nhận cả cột
      // `j.user_id` lẫn biểu thức COALESCE trong SELECT.
      rows = await this.driver.all(
        `SELECT COALESCE(j.user_id, '${ANONYMOUS_GROUP_LABEL}') AS bucket, j.user_id AS owner_id, ${METRICS}
         FROM usage_events ue
         LEFT JOIN jobs j ON j.id = ue.job_id${whereSql}
         GROUP BY j.user_id
         ORDER BY 1 ASC`,
        params,
      );
    } else {
      const bucketExpr = group === 'day' ? 'substr(ue.created_at,1,10)' : 'ue.operation';
      rows = await this.driver.all(
        `SELECT ${bucketExpr} AS bucket, ${METRICS}
         FROM usage_events ue${whereSql}
         GROUP BY ${bucketExpr}
         ORDER BY 1 ASC`,
        params,
      );
    }

    return (Array.isArray(rows) ? rows : []).map((row) => {
      const out = {
        group: String(row.bucket ?? ''),
        events: Number(toNum(row.events, 0)),
        estimated_cost: roundMoney(toNum(row.estimated_cost, 0)),
        input_units: toNum(row.input_units, 0),
        output_units: toNum(row.output_units, 0),
      };
      if (group === 'user') out.user_id = row.owner_id ?? null;
      return out;
    });
  }
}

/** Tạo + khởi tạo store theo cấu hình. */
export async function createStore(config, logger) {
  const driver = createDriver(config, logger);
  const store = new Store({ driver, logger, config });
  await store.init();
  return store;
}

export default createStore;
