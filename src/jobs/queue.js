/**
 * Hàng đợi công việc nền — BỀN (R1, hợp đồng §2.3).
 *
 * Vì sao phải bền: hàng đợi MVP-01..05 nằm TRONG BỘ NHỚ, khởi động lại tiến trình là mất mọi
 * việc đang chờ (docs/OWNER-DECISIONS.md mục 4). Bản này giữ NGUYÊN API cũ —
 * `enqueue(jobId, fn)`, `isPending(jobId)`, `stats()`, `onIdle()`/`drain()`, `waitFor()`,
 * `stateOf()` — nhưng ghi mục việc xuống `job_queue` TRƯỚC khi chạy:
 *
 *   enqueue → store.enqueueJob() (chống trùng theo KHOÁ LƯỢT CHẠY, xem `#itemKey`)
 *           → xếp vào bộ nhớ → nhặt NGUYÊN TỬ (claimQueueItem) → chạy
 *           → completeQueueItem() | failQueueItem() (backoff, hết lượt ⇒ `failed`)
 *
 * ⚠️ CHỐNG TRÙNG THEO `(jobId, handler)` LÀ SAI (hồi quy thật đã xảy ra ở
 * `test/imagelab-concurrency.test.js`): hai request render ĐỒNG THỜI trên cùng một job là HAI
 * LƯỢT RIÊNG, mỗi lượt có `run_key` và bị thu tiền riêng (MVP-05 §BR-02) — gộp chúng là nuốt
 * mất một lượt người dùng đã trả tiền. Khoá chống trùng vì vậy mang DANH TÍNH LƯỢT CHẠY:
 * `jobId::handler::rk:<runKey>` khi tầng gọi truyền `runKey`, ngược lại
 * `jobId::handler::fn:<định danh hàm xử lý>` (cùng một hàm ⇒ cùng một lượt; hai closure khác
 * nhau ⇒ hai lượt). Xem `#itemKey` để biết vì sao.
 *
 * Khởi động lại tiến trình: `resume()` đọc mục `queued` + thu hồi mục `running` quá cũ
 * (`requeueStaleJobs`) rồi chạy lại bằng BẢNG HÀM dựng handler (`registerHandler`), vì hàm
 * xử lý ban đầu là closure chỉ sống trong tiến trình cũ.
 *
 * `durable: false` (hoặc `QUEUE_DURABLE=false`) ⇒ chạy y hệt hành vi cũ trong bộ nhớ (để so
 * sánh/rollback) — nhánh đó KHÔNG chạm tới DB một lần nào.
 *
 * Đặc tính giữ nguyên từ bản cũ:
 *  - Giới hạn số job chạy song song; thử lại có kiểm soát; không bao giờ để lỗi của một job
 *    làm chết worker; `drain()` để test chờ chạy xong.
 */

import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';

export const JOB_STATE = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
});

/** Mặc định của `config.queue` (hợp đồng §2.3) — dùng khi R3-S chưa kịp thêm khoá vào config.js. */
export const QUEUE_DEFAULTS = Object.freeze({
  durable: true,
  staleMs: 600000,
  maxAttempts: 3,
  retryBaseMs: 2000,
  /**
   * TRẦN TỔNG thời gian chờ thử lại của MỘT mục (ms).
   *
   * Vì sao cần trần: lịch của hợp đồng (`retryBaseMs * attempts`, 3 lượt, base 2000) cho tổng
   * 2s + 4s = **6 giây** — job hỏng phải 6 giây mới hiện `failed`, và bài test ĐÃ NGHIỆM THU
   * `test/imagelab-f02-f06-review-render.test.js` chỉ poll job 100 × 25ms (đo thực tế ~6,1 giây,
   * máy nhanh hơn thì ngắn hơn) ⇒ biên độ ~0 giây, đỏ/máy-phụ-thuộc. Trần này CHIA LẠI lịch theo
   * TỈ LỆ (giữ đúng dáng backoff tăng dần 1:2:…) sao cho tổng ≤ trần.
   *
   * Muốn đúng NGUYÊN lịch của hợp đồng: đặt `retryTotalMs` = 6000 (qua `config.queue.retryTotalMs`).
   */
  retryTotalMs: 2000,
  pollMs: 1000,
});

/**
 * Tên việc MẶC ĐỊNH theo `(kind, stage)` của job trong DB.
 *
 * Vì sao cần suy ra: tầng gọi đã nghiệm thu (`src/http/routes.js`) gọi `queue.enqueue(id, fn)`
 * với ĐÚNG hai tham số — không truyền tên việc. Muốn khoá chống trùng ỔN ĐỊNH giữa các lần gọi
 * thì tên việc phải suy được từ dữ liệu đã có trong DB (`(kind, stage)`); phần DANH TÍNH LƯỢT
 * CHẠY thì lấy từ chính lời gọi (runKey nếu có, ngược lại là tham chiếu hàm xử lý).
 *
 * `stage` là thứ phân biệt hai lượt khác nhau trên CÙNG một job ImageLab: OCR (`stage=queued`)
 * và render (`stage=rendering`) — nếu gộp cả hai vào một tên thì lượt render sẽ bị coi là
 * "trùng" và bị nuốt mất.
 */
export const DEFAULT_HANDLER_BY_KIND = Object.freeze({
  content: Object.freeze({ __default: 'run', queued: 'run', starting: 'run' }),
  image_translation: Object.freeze({ __default: 'run_ocr', queued: 'run_ocr', ocr: 'run_ocr', rendering: 'render', render: 'render' }),
  image_generation: Object.freeze({ __default: 'generate', queued: 'generate' }),
  video_generation: Object.freeze({ __default: 'generate', queued: 'generate' }),
});

/** Suy tên việc từ `(kind, stage)` — không bao giờ trả rỗng (mặc định `'run'`). */
export function resolveHandlerName(kind, stage = null) {
  const k = String(kind || 'content');
  const s = stage ? String(stage) : '';
  const table = DEFAULT_HANDLER_BY_KIND[k] || null;
  const picked = (table && (table[s] || table.__default)) || 'run';
  return String(picked);
}

/**
 * ID mục hàng đợi TẤT ĐỊNH theo khoá idempotency `(jobId, handler, runKey)`.
 *
 * Vì sao cần id tất định: đó là chốt chặn LIÊN TIẾN TRÌNH cho "cùng một lượt chạy chỉ được
 * chạy một lần" — PRIMARY KEY của `job_queue` đảm bảo chỉ một tiến trình chèn được, kẻ đến sau
 * đọc lại mục cũ. (Không dùng unique index trên `(job_id, handler)`: hai request đồng thời là
 * hai LƯỢT riêng, xem `#itemKey`.)
 */
export function queueItemIdFor(idempotencyKey) {
  const hex = createHash('sha256').update(String(idempotencyKey)).digest('hex').slice(0, 32).split('');
  hex[12] = '5'; // dạng uuid — chỉ để dễ đọc trong log/DB
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

export class JobQueue extends EventEmitter {
  /** Định danh THAM CHIẾU hàm xử lý — khoá chống trùng cho lượt chạy không có `runKey`. */
  #fnIds;
  /** F3 — timer vòng nhặt việc (null khi chưa bật/tắt). */
  #pollTimer = null;
  /** F3 — chu kỳ vòng nhặt việc (ms). */
  #pollMs = QUEUE_DEFAULTS.pollMs;
  #fnSeq = 0;

  /**
   * @param {object}  [opts]
   * @param {number}  [opts.concurrency]   số job chạy song song (mặc định 2)
   * @param {number}  [opts.maxAttempts]   số lần thử ở chế độ BỘ NHỚ (giữ nguyên hành vi cũ)
   * @param {number}  [opts.retryDelayMs]  backoff cơ sở ở chế độ BỘ NHỚ (giữ nguyên hành vi cũ)
   * @param {object}  [opts.store]         store có các method §2.2 ⇒ bật được chế độ BỀN
   * @param {object}  [opts.queue]         `config.queue` (§2.3) — có thể thiếu khoá (R3-S chưa thêm)
   * @param {boolean} [opts.durable]       ghi đè `config.queue.durable`
   * @param {string}  [opts.workerId]      danh tính tiến trình (ghi vào `locked_by`)
   * @param {Function}[opts.now]           nguồn thời gian (test) → Date | ISO string
   * @param {object}  [opts.handlers]      bảng hàm dựng handler cho `resume()`
   */
  constructor({
    concurrency = 2,
    maxAttempts = 2,
    logger,
    retryDelayMs = 500,
    store = null,
    queue = null,
    durable = null,
    workerId = null,
    now = null,
    handlers = null,
    resumeLimit = 200,
    closeTimeoutMs = 5000,
  } = {}) {
    super();
    this.concurrency = Math.max(1, concurrency);
    this.maxAttempts = Math.max(1, maxAttempts);
    this.logger = logger;
    this.retryDelayMs = retryDelayMs;
    this.store = store || null;
    this.queue = [];
    this.active = new Map(); // id -> {attempts, state}
    this.running = 0;
    this.idleResolvers = [];

    const cfg = queue && typeof queue === 'object' ? queue : {};
    const wantsDurable = durable === null ? (cfg.durable ?? QUEUE_DEFAULTS.durable) : durable;
    // Chỉ bật được chế độ bền khi store có ĐỦ method của §2.2 — thiếu một cái là thà chạy
    // như cũ (bộ nhớ) còn hơn ghi nửa vời rồi mất việc.
    const required = ['enqueueJob', 'claimNextJob', 'claimQueueItem', 'completeQueueItem', 'failQueueItem', 'requeueStaleJobs', 'listQueueItems'];
    const missing = this.store ? required.filter((name) => typeof this.store[name] !== 'function') : required;
    this.durable = Boolean(this.store && wantsDurable && missing.length === 0);
    if (wantsDurable && this.store && missing.length > 0) {
      this.logger?.warn('queue.durable_disabled', { reason: 'store thiếu method hàng đợi (§2.2)', missing });
    }
    // Số lần thử của chế độ BỀN lấy từ `config.queue.maxAttempts` (§2.3, mặc định 3).
    this.queueMaxAttempts = Math.max(1, Math.trunc(this.#num(cfg.maxAttempts, QUEUE_DEFAULTS.maxAttempts)));
    // Backoff cơ sở: `config.queue.retryBaseMs` (R3-S đã thêm khoá, mặc định 2000 theo §2.3).
    // Chưa có khoá (dựng JobQueue trực tiếp) ⇒ giữ nhịp cũ `retryDelayMs`.
    this.retryBaseMs = Math.max(0, this.#num(cfg.retryBaseMs, this.retryDelayMs));
    // Trần TỔNG thời gian chờ thử lại của một mục — xem `QUEUE_DEFAULTS.retryTotalMs` để biết vì sao.
    this.retryTotalMs = Math.max(0, this.#num(cfg.retryTotalMs, QUEUE_DEFAULTS.retryTotalMs));
    this.staleMs = Math.max(0, this.#num(cfg.staleMs, QUEUE_DEFAULTS.staleMs));
    // F3: nhịp NHẶT VIỆC (ms) — sàn 200ms để không tạo vòng lặp nóng, trần 60s.
    this.#pollMs = Math.min(60000, Math.max(200, Math.trunc(this.#num(cfg.pollMs, QUEUE_DEFAULTS.pollMs))));
    this.#pollTimer = null;
    this.resumeLimit = Math.max(1, Math.trunc(this.#num(cfg.resumeLimit, resumeLimit)));
    this.closeTimeoutMs = Math.max(0, this.#num(cfg.closeTimeoutMs, closeTimeoutMs));
    this.workerId = String(workerId || `w-${process.pid}-${randomUUID().slice(0, 8)}`);
    this.now = typeof now === 'function' ? now : () => new Date();

    this.handlers = new Map();
    if (handlers && typeof handlers === 'object') {
      for (const [name, factory] of Object.entries(handlers)) this.registerHandler(name, factory);
    }
    this.items = new Map(); // khoá idempotency (`jobId::handler::rk|fn:…`) -> entry đang sống
    this.#fnIds = new WeakMap(); // tham chiếu hàm xử lý -> định danh (khoá chống trùng không runKey)
    this.#fnSeq = 0;
    this.restored = new Set(); // id mục DB đã khôi phục (không khôi phục hai lần)
    this.timers = new Set();
    this.preparing = 0; // mục đang ghi DB trước khi chạy (tính vào `size` để drain() chờ)
    this.waiting = 0; // mục đang chờ backoff (tính vào `size`)
    this.closed = false;
  }

  get size() {
    return this.queue.length + this.running + this.preparing + this.waiting;
  }

  /** Số thực hữu hạn, hoặc `fallback`. */
  #num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  #iso(at = null) {
    const value = at ?? this.now();
    if (value instanceof Date) return value.toISOString();
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
  }

  /**
   * Job có đang CHỜ hoặc ĐANG CHẠY trong hàng đợi không? (IL08-01, vòng 6)
   * Khác `active.has(id)`: mục đã chạy XONG vẫn nằm trong `active` để tra cứu kết quả,
   * nên phải loại `done`/`failed` — nếu không, mọi job cũ sẽ bị coi là "đang chạy".
   */
  isPending(id) {
    const entry = this.active.get(String(id));
    return Boolean(entry && (entry.state === JOB_STATE.PENDING || entry.state === JOB_STATE.RUNNING));
  }

  stats() {
    return {
      queued: this.queue.length,
      running: this.running,
      concurrency: this.concurrency,
      tracked: this.active.size,
      // R1: số liệu của hàng đợi BỀN — `/api/health` cho biết tiến trình này có đang bền không.
      durable: this.durable,
      preparing: this.preparing,
      waiting: this.waiting,
    };
  }

  /** Đăng ký hàm dựng handler cho `resume()` (mục khôi phục từ DB không còn closure cũ). */
  registerHandler(name, factory) {
    const key = String(name || '').trim();
    if (!key || typeof factory !== 'function') {
      throw Object.assign(new Error('registerHandler cần (tên việc, hàm dựng handler).'), { code: 'INVALID_HANDLER' });
    }
    this.handlers.set(key, factory);
    return this;
  }

  /** Chờ tới khi hàng đợi rỗng (tên cũ §2.3). Dùng trong test và graceful shutdown. */
  onIdle() {
    return this.drain();
  }

  /** Chờ tới khi hàng đợi rỗng. */
  drain() {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  /** Chờ một job cụ thể kết thúc. */
  waitFor(id) {
    const entry = this.active.get(id);
    if (entry && (entry.state === JOB_STATE.DONE || entry.state === JOB_STATE.FAILED)) {
      return Promise.resolve(entry);
    }
    return new Promise((resolve) => {
      const onDone = ({ id: jid }) => {
        if (jid !== id) return;
        cleanup();
        resolve(this.active.get(id));
      };
      const onFailed = ({ id: jid }) => {
        if (jid !== id) return;
        cleanup();
        resolve(this.active.get(id));
      };
      const cleanup = () => {
        this.off('done', onDone);
        this.off('failed', onFailed);
      };
      this.on('done', onDone);
      this.on('failed', onFailed);
    });
  }

  stateOf(id) {
    return this.active.get(id) || null;
  }

  /**
   * Xếp một job vào hàng đợi.
   *
   * @param {string} id
   * @param {(ctx:{attempt:number, queueItemId:string|null}) => Promise<any>} handler
   * @param {object} [meta] `{ kind, handler, payload, maxAttempts, runAfter, stage }` — tuỳ chọn;
   *   thiếu thì tên việc được suy từ `(kind, stage)` của job trong DB.
   */
  enqueue(id, handler, meta = {}) {
    const jobId = String(id);
    if (typeof handler !== 'function') {
      throw Object.assign(new Error(`enqueue("${jobId}") thiếu hàm xử lý.`), { code: 'INVALID_HANDLER' });
    }
    // Cho phép `enqueue(id, fn, 'run')` — dạng ngắn gọn của `{ handler: 'run' }`.
    const opts = typeof meta === 'string' ? { handler: meta } : (meta || {});
    // ── Chế độ BỘ NHỚ (hành vi cũ, `QUEUE_DURABLE=false`) ──────────────────────────────
    if (!this.durable) {
      this.active.set(jobId, { attempts: 0, state: JOB_STATE.PENDING });
      this.queue.push({ id: jobId, handler, key: null, queueItemId: null });
      this.#pump();
      return jobId;
    }
    // ── Chế độ BỀN: ghi DB TRƯỚC, chỉ chạy sau khi dòng DB đã có ────────────────────────
    const entry = {
      id: jobId,
      key: null,
      // DANH TÍNH LƯỢT CHẠY: có `runKey` ⇒ chống trùng theo LƯỢT; không có ⇒ theo THAM CHIẾU hàm
      // xử lý (xem `#itemKey`). TUYỆT ĐỐI không dùng `(jobId, handler)` trần — hai request render
      // đồng thời là hai lượt riêng, gộp lại là nuốt mất một lượt người dùng đã trả tiền.
      runKey: this.#runKeyOf(opts),
      handlerRef: handler,
      handlerName: opts.handler ? String(opts.handler) : null,
      kind: opts.kind ? String(opts.kind) : null,
      stage: opts.stage ? String(opts.stage) : null,
      payload: opts.payload ?? null,
      attempts: 0,
      state: JOB_STATE.PENDING,
      queueItemId: null,
      enqueuedAt: Date.now(),
    };
    // Giữ nguyên hành vi cũ: `isPending(id)` đúng NGAY sau khi enqueue.
    this.active.set(jobId, entry);
    this.preparing += 1;
    this.#prepare(entry, handler, opts)
      .then((item) => {
        if (!item) return;
        this.queue.push(item);
        this.#pump();
      })
      .catch((err) => this.#failPreparation(entry, err))
      .finally(() => {
        this.preparing -= 1;
        if (this.size === 0) this.#resolveIdle();
        this.#pump();
      });
    return jobId;
  }

  /** Ghi mục việc xuống DB rồi trả về mục để chạy (null nếu là mục TRÙNG ⇒ không chạy lần hai). */
  async #prepare(entry, handler, meta) {
    const info = await this.#describeItem(entry, meta);
    entry.handlerName = info.handler;
    entry.kind = info.kind;
    entry.key = this.#itemKey(entry, info.handler);
    // Trùng NGAY TRONG tiến trình này: mục cũ còn sống ⇒ không xếp lần thứ hai.
    const dup = this.items.get(entry.key);
    if (dup && dup !== entry && (dup.state === JOB_STATE.PENDING || dup.state === JOB_STATE.RUNNING)) {
      this.logger?.warn('queue.duplicate_enqueue', {
        job_id: entry.id,
        handler: info.handler,
        run_key: entry.runKey,
        reason: entry.runKey ? 'cùng lượt chạy (runKey)' : 'cùng hàm xử lý',
      });
      this.#drop(entry, 'duplicate');
      return null;
    }
    this.items.set(entry.key, entry);
    let row = null;
    try {
      row = await this.store.enqueueJob({
        // id tất định theo khoá idempotency khi biết `runKey` (nguyên tử cả LIÊN tiến trình);
        // không có `runKey` thì mỗi lần enqueue là một LƯỢT RIÊNG ⇒ id ngẫu nhiên.
        id: entry.queueItemId || (entry.runKey ? queueItemIdFor(entry.key) : randomUUID()),
        jobId: entry.id,
        kind: info.kind,
        handler: info.handler,
        payload: info.payload,
        maxAttempts: meta.maxAttempts ?? this.queueMaxAttempts,
        runAfter: info.runAfter,
      });
    } catch (err) {
      this.items.delete(entry.key);
      throw err;
    }
    if (!row) {
      this.items.delete(entry.key);
      throw Object.assign(new Error(`Không ghi được mục hàng đợi cho job ${entry.id}.`), { code: 'QUEUE_ENQUEUE_FAILED' });
    }
    if (row.reused) {
      // Cùng MỘT LƯỢT CHẠY đang sống ở nơi khác (tiến trình khác, hoặc mục vừa khôi phục) ⇒
      // TUYỆT ĐỐI không chạy lại: chạy hai lần cùng một lượt là thu tiền hai lần.
      this.logger?.warn('queue.enqueue_reused', { job_id: entry.id, handler: info.handler, run_key: entry.runKey, queue_item_id: row.id });
      this.#drop(entry, 'reused');
      return null;
    }
    entry.queueItemId = row.id;
    entry.attempts = Number(row.attempts) || 0;
    const item = { id: entry.id, handler, key: entry.key, queueItemId: row.id };
    if (meta.runAfter || row.run_after) {
      const at = Date.parse(String(meta.runAfter || row.run_after));
      const delay = Number.isFinite(at) ? at - Date.now() : 0;
      if (delay > 0) {
        this.#schedule(item, delay);
        return null;
      }
    }
    return item;
  }

  /**
   * KHOÁ CHỐNG TRÙNG của một mục — mang DANH TÍNH LƯỢT CHẠY, không phải `(jobId, handler)`.
   *
   * Vì sao: hai request render ĐỒNG THỜI trên cùng một job là HAI LƯỢT RIÊNG (mỗi lượt có
   * `run_key` và bị thu tiền riêng — MVP-05 §BR-02, kết luận đã nghiệm thu). Gộp chúng theo
   * `(jobId, handler)` là nuốt mất một lượt người dùng đã trả tiền (hồi quy thật đã xảy ra).
   *
   *   - Có `runKey` do tầng gọi truyền (`meta.runKey`): khoá = `jobId::handler::rk:<runKey>`
   *     ⇒ bấm hai lần CÙNG một lượt (cùng runKey) chỉ chạy MỘT lần, và cả LIÊN tiến trình
   *     (id mục hàng đợi là hàm băm tất định của khoá này).
   *   - KHÔNG có `runKey`: khoá = `jobId::handler::fn:<định danh hàm xử lý>`. Cùng một hàm
   *     (cùng tham chiếu) ⇒ cùng một lượt (chống trùng đúng như §2.3); hai closure KHÁC nhau
   *     (hai request, hai tab) ⇒ hai lượt riêng, phải chạy cả hai.
   */
  #itemKey(entry, handlerName) {
    const scope = entry.runKey
      ? `rk:${entry.runKey}`
      : `fn:${this.#fnId(entry.handlerRef)}`;
    return `${entry.id}::${handlerName}::${scope}`;
  }

  /** Định danh ổn định cho một THAM CHIẾU hàm xử lý (WeakMap ⇒ không giữ hàm sống, không rò rỉ). */
  #fnId(fn) {
    if (typeof fn !== 'function') return 'none';
    let id = this.#fnIds.get(fn);
    if (!id) {
      this.#fnSeq += 1;
      id = `f${this.#fnSeq}`;
      this.#fnIds.set(fn, id);
    }
    return id;
  }

  /** Khoá lượt chạy do tầng gọi cung cấp (nhiều cách gọi tên cho tiện dụng). */
  #runKeyOf(meta = {}) {
    const raw = meta.runKey ?? meta.run_key ?? meta.idempotencyKey ?? meta.idempotency_key
      ?? meta.dedupeKey ?? meta.dedupe_key ?? meta.payload?.run_key ?? meta.payload?.runKey ?? null;
    const key = raw === null || raw === undefined ? '' : String(raw).trim();
    return key || null;
  }

  /** Đọc `kind`/`stage` của job để chốt TÊN VIỆC ổn định cho khoá idempotent. */
  async #describeItem(entry, meta = {}) {
    let kind = entry.kind || (meta.kind ? String(meta.kind) : null);
    let stage = entry.stage || (meta.stage ? String(meta.stage) : null);
    if (!kind || !stage) {
      const job = await this.#getJobSafe(entry.id);
      kind = kind || job?.kind || null;
      stage = stage || job?.stage || null;
    }
    return {
      kind: String(kind || 'content'),
      stage,
      handler: entry.handlerName || resolveHandlerName(kind, stage),
      payload: entry.runKey
        ? { ...(entry.payload && typeof entry.payload === 'object' ? entry.payload : {}), run_key: entry.runKey }
        : (entry.payload ?? null),
      runAfter: meta.runAfter ? this.#iso(meta.runAfter) : null,
    };
  }

  /** `store.getJob` phòng thủ: không có method / lỗi DB thì coi như không đọc được (không chết enqueue). */
  async #getJobSafe(jobId) {
    if (typeof this.store?.getJob !== 'function') return null;
    try {
      return await this.store.getJob(jobId);
    } catch (err) {
      this.logger?.warn('queue.job_lookup_failed', { job_id: jobId, error: err });
      return null;
    }
  }

  /** Bỏ một mục chuẩn bị hỏng/trùng, trả lại trạng thái `active` cho mục sống khác của cùng job. */
  #drop(entry, reason) {
    if (entry.key && this.items.get(entry.key) === entry) this.items.delete(entry.key);
    if (this.active.get(entry.id) !== entry) return;
    const other = [...this.items.values()].find(
      (e) => e !== entry && e.id === entry.id && (e.state === JOB_STATE.PENDING || e.state === JOB_STATE.RUNNING),
    );
    if (other) {
      this.active.set(entry.id, other);
      return;
    }
    entry.state = JOB_STATE.DONE;
    entry.dropped = reason;
    this.active.set(entry.id, entry);
  }

  /** Ghi DB thất bại TRƯỚC khi chạy: fail-closed — báo job hỏng, không để job treo `queued`. */
  #failPreparation(entry, err) {
    this.logger?.error('queue.enqueue_failed', { job_id: entry.id, handler: entry.handlerName, error: err });
    this.#drop(entry, 'failed');
    entry.state = JOB_STATE.FAILED;
    entry.error = err?.message || String(err);
    this.active.set(entry.id, entry);
    this.emit('failed', { id: entry.id, error: err, attempts: 0 });
  }

  /**
   * Khôi phục hàng đợi sau khi tiến trình khởi động lại (§2.3): mục `running` quá cũ được trả
   * về `queued`, rồi mọi mục `queued` được dựng lại handler và xếp vào bộ nhớ.
   *
   * AN TOÀN NHIỀU TIẾN TRÌNH: mục khôi phục KHÔNG chạy ngay — lúc chạy nó vẫn phải thắng
   * `claimQueueItem()` (một câu UPDATE nguyên tử), nên hai tiến trình cùng `resume()` thì chỉ
   * MỘT tiến trình chạy được mục đó.
   */
  /**
   * F1+F2 (phản biện R1) — THU HỒI MỤC QUÁ HẠN **và chốt hậu quả**.
   *
   * Khác `store.requeueStaleJobs` thuần: ở đây còn
   *   · mục đã CHẠM TRẦN (`attempts >= max_attempts`) ⇒ job tương ứng được đánh dấu `failed` +
   *     `error_code='QUEUE_ATTEMPTS_EXHAUSTED'` + `finished_at`, và phát sự kiện `failed` để hook
   *     tính tiền chạy đúng đường (hoàn tiền/đánh dấu) — trước đây mục cứ quay lại `queued` mãi;
   *   · mục còn lượt ⇒ về `queued` để `resume()`/`drain()` nhặt tiếp.
   *
   * @returns {Promise<{requeued:number, ids:string[], exhausted:number, exhausted_job_ids:string[]}>}
   */
  async reclaimStale({ olderThanMs = null, limit = null } = {}) {
    const empty = { requeued: 0, ids: [], exhausted: 0, exhausted_job_ids: [] };
    if (!this.durable || typeof this.store?.requeueStaleJobs !== 'function') return empty;
    let out = null;
    try {
      out = await this.store.requeueStaleJobs({
        olderThanMs: olderThanMs ?? this.staleMs,
        now: this.#iso(),
        limit: limit ?? this.resumeLimit,
      });
    } catch (err) {
      // Thu hồi lỗi KHÔNG được chặn phần còn lại.
      this.logger?.error('queue.resume_requeue_failed', { error: err });
      return empty;
    }
    const requeued = Number(out?.requeued) || 0;
    if (requeued > 0) this.logger?.warn('queue.stale_requeued', { requeued, stale_ms: this.staleMs });
    const exhaustedJobs = Array.isArray(out?.failed_job_ids) ? out.failed_job_ids : [];
    for (const jobId of exhaustedJobs) {
      const err = Object.assign(
        new Error(`Mục hàng đợi của job ${jobId} đã chạm trần số lần thử — không thử lại nữa.`),
        { code: 'QUEUE_ATTEMPTS_EXHAUSTED' },
      );
      try {
        await this.store.updateJob?.(jobId, {
          status: 'failed',
          stage: 'failed',
          error_code: 'QUEUE_ATTEMPTS_EXHAUSTED',
          error_message: err.message,
          finished_at: new Date().toISOString(),
        });
      } catch (e2) {
        this.logger?.error('queue.exhausted_job_update_failed', { job_id: jobId, error: e2 });
      }
      this.logger?.error('queue.attempts_exhausted', { job_id: jobId });
      this.emit('failed', { id: jobId, error: err, attempts: this.queueMaxAttempts, exhausted: true });
    }
    return {
      requeued,
      ids: Array.isArray(out?.ids) ? out.ids : [],
      exhausted: Number(out?.failed) || exhaustedJobs.length || 0,
      exhausted_job_ids: exhaustedJobs,
    };
  }

  /**
   * F3 (phản biện R1, CAO) — NHẶT VÀ CHẠY việc `queued` không có chủ (việc "mồ côi").
   *
   * Trước đây chỉ `resume()` lúc BOOT mới chạy được việc `queued`; cron chỉ đổi trạng thái
   * `running → queued` rồi **không ai nhặt** ⇒ tiến trình đang sống không cứu được việc của tiến
   * trình đã chết (đo được: sau 6 nhịp cron, B chạy được 0 việc). Nay scheduler gọi `drain()` mỗi
   * nhịp: nó (1) thu hồi mục quá hạn, (2) dựng handler cho các mục `queued` còn lượt và xếp vào
   * bộ nhớ — tôn trọng `concurrency`, `run_after`, và KHÔNG đụng mục đang `running` ở tiến trình
   * khác (lúc chạy vẫn phải thắng `claimQueueItem` nguyên tử).
   *
   * ⚠️ Tên `pumpQueued` (KHÔNG phải `drain`): `drain()` đã là API "chờ hàng đợi bộ nhớ rỗng" mà
   * test/tầng gọi đang dùng — đổi nghĩa nó là phá vỡ hợp đồng có sẵn.
   */
  async pumpQueued({ olderThanMs = null, limit = null } = {}) {
    if (!this.durable) return { durable: false, requeued: 0, claimed: 0, skipped: 0, exhausted: 0 };
    const reclaimed = await this.reclaimStale({ olderThanMs, limit });
    // A2 (phản biện R1 vòng 2, VỪA): mục `queued` ĐÃ CHẠM TRẦN không bao giờ nhặt được nữa ⇒ phải
    // được CHỐT `failed` (+ job `failed`) chứ không nằm im. Trước đây nó kẹt `queued` vĩnh viễn và
    // vòng poll liên tục dựng handler rồi phát `done(skipped=true)` GIẢ.
    let exhaustedMarked = 0;
    const stuck = await this.store
      .listQueueItems({ statuses: ['queued'], limit: limit ?? this.resumeLimit, onlyClaimable: false })
      .catch(() => []);
    for (const row of stuck) {
      if (Number(row.attempts) < Number(row.max_attempts)) continue;
      const err = Object.assign(
        new Error(`Mục hàng đợi của job ${row.job_id} đã chạm trần số lần thử — không nhặt lại.`),
        { code: 'QUEUE_ATTEMPTS_EXHAUSTED' },
      );
      await this.store.failQueueItem?.(row.id, { error: err, force: true }).catch((e2) => {
        this.logger?.error('queue.exhausted_mark_failed_error', { queue_item_id: row.id, error: e2 });
      });
      if (typeof this.store.updateJob === 'function') {
        await this.store.updateJob(row.job_id, {
          status: 'failed',
          stage: 'failed',
          error_code: 'QUEUE_ATTEMPTS_EXHAUSTED',
          error_message: err.message,
          finished_at: new Date().toISOString(),
        }).catch((e2) => this.logger?.error('queue.exhausted_job_update_failed', { job_id: row.job_id, error: e2 }));
      }
      this.logger?.error('queue.attempts_exhausted', { job_id: row.job_id, queue_item_id: row.id });
      this.emit('failed', { id: row.job_id, error: err, attempts: Number(row.attempts) || 0, exhausted: true });
      exhaustedMarked += 1;
    }
    const rows = await this.store.listQueueItems({ statuses: ['queued'], limit: limit ?? this.resumeLimit });
    let claimed = 0;
    let skipped = 0;
    for (const row of rows) {
      if (this.closed) break;
      if (this.running >= this.concurrency) break; // tôn trọng trần chạy song song
      const rowRunKey = row.payload?.run_key ?? row.payload?.runKey ?? null;
      const key = rowRunKey ? `${row.job_id}::${row.handler}::rk:${rowRunKey}` : `${row.job_id}::${row.handler}::row:${row.id}`;
      const live = this.items.get(key);
      if (live && (live.state === JOB_STATE.PENDING || live.state === JOB_STATE.RUNNING)) {
        skipped += 1; // đã có trong bộ nhớ (kể cả đang chạy) ⇒ không nhặt lại
        continue;
      }
      // ⚠️ KHOÁ BỘ NHỚ KHÁC KHOÁ DB: mục do `enqueue()` xếp hàng có khoá `…::fn:<id hàm>`, còn
      // khoá suy từ dòng DB là `…::row:<id>`. Nếu chỉ so khoá, nhịp poll sẽ NHẶT LẠI chính mục mà
      // hàng đợi trong bộ nhớ đang chờ ⇒ handler chạy HAI lần cho một việc. Vì vậy còn phải so
      // theo `queueItemId` (id dòng DB) và theo (job, handler) đang PENDING/RUNNING.
      const busyInMemory = [...this.items.values()].some((entry) => {
        if (!entry || (entry.state !== JOB_STATE.PENDING && entry.state !== JOB_STATE.RUNNING)) return false;
        if (entry.queueItemId && entry.queueItemId === row.id) return true;
        return entry.id === row.job_id && entry.handlerName === row.handler;
      });
      if (busyInMemory) {
        skipped += 1;
        continue;
      }
      let handler = null;
      try {
        handler = await this.#buildHandler(row);
      } catch (err) {
        this.logger?.error('queue.handler_build_failed', { job_id: row.job_id, handler: row.handler, error: err });
      }
      if (!handler) {
        skipped += 1;
        continue; // không dựng được handler ⇒ để `resume()` xử lý fail-closed như cũ
      }
      const entry = {
        id: row.job_id,
        key,
        handlerName: row.handler,
        kind: row.kind,
        stage: null,
        payload: row.payload ?? null,
        attempts: Number(row.attempts) || 0,
        state: JOB_STATE.PENDING,
        queueItemId: row.id,
        restored: true,
      };
      this.items.set(key, entry);
      const current = this.active.get(row.job_id);
      if (!current || current.state === JOB_STATE.DONE || current.state === JOB_STATE.FAILED) {
        this.active.set(row.job_id, entry);
      }
      const item = { id: row.job_id, handler, key, queueItemId: row.id };
      const at = row.run_after ? Date.parse(row.run_after) : NaN;
      const delay = Number.isFinite(at) ? at - Date.now() : 0;
      if (delay > 0) this.#schedule(item, delay);
      else this.queue.push(item);
      claimed += 1;
    }
    this.#pump();
    if (claimed > 0) this.logger?.info('queue.drained', { claimed, skipped, requeued: reclaimed.requeued });
    return {
      durable: true,
      requeued: reclaimed.requeued,
      claimed,
      skipped,
      exhausted: (Number(reclaimed.exhausted) || 0) + exhaustedMarked,
    };
  }

  async resume() {
    if (!this.durable) return { durable: false, requeued: 0, restored: 0, skipped: 0 };
    let requeued = 0;
    try {
      const out = await this.reclaimStale();
      requeued = Number(out?.requeued) || 0;
    } catch (err) {
      this.logger?.error('queue.resume_requeue_failed', { error: err });
    }
    const rows = await this.store.listQueueItems({ statuses: ['queued'], limit: this.resumeLimit });
    let restored = 0;
    let skipped = 0;
    for (const row of rows) {
      if (this.restored.has(row.id)) continue;
      this.restored.add(row.id);
      // Mục khôi phục: khoá theo LƯỢT CHẠY đã lưu trong payload, không có thì theo chính ID mục
      // (mỗi dòng DB là một lượt riêng) — không bao giờ gộp hai lượt khác nhau làm một.
      const rowRunKey = row.payload?.run_key ?? row.payload?.runKey ?? null;
      const key = rowRunKey ? `${row.job_id}::${row.handler}::rk:${rowRunKey}` : `${row.job_id}::${row.handler}::row:${row.id}`;
      const live = this.items.get(key);
      if (live && (live.state === JOB_STATE.PENDING || live.state === JOB_STATE.RUNNING)) {
        skipped += 1;
        continue;
      }
      let handler = null;
      try {
        handler = await this.#buildHandler(row);
      } catch (err) {
        this.logger?.error('queue.handler_build_failed', { job_id: row.job_id, handler: row.handler, error: err });
      }
      if (!handler) {
        // FAIL-CLOSED: không dựng được hàm xử lý ⇒ KHÔNG im lặng bỏ mục (việc sẽ mất). Đánh dấu
        // hỏng hẳn kèm mã lỗi rõ ràng; `emit('failed')` để job có `error_code` + `finished_at`.
        const err = Object.assign(
          new Error(`Không có hàm xử lý "${row.handler}" cho job ${row.job_id} — không thể chạy lại mục đã khôi phục.`),
          { code: 'QUEUE_HANDLER_UNKNOWN' },
        );
        this.logger?.error('queue.handler_missing', { job_id: row.job_id, handler: row.handler, queue_item_id: row.id });
        await this.store.failQueueItem(row.id, { error: err, force: true }).catch((e2) => {
          this.logger?.error('queue.handler_missing_mark_failed_error', { queue_item_id: row.id, error: e2 });
        });
        skipped += 1;
        this.emit('failed', { id: row.job_id, error: err, attempts: Number(row.attempts) || 0 });
        continue;
      }
      const entry = {
        id: row.job_id,
        key,
        handlerName: row.handler,
        kind: row.kind,
        stage: null,
        payload: row.payload ?? null,
        attempts: Number(row.attempts) || 0,
        state: JOB_STATE.PENDING,
        queueItemId: row.id,
        restored: true,
      };
      this.items.set(key, entry);
      const current = this.active.get(row.job_id);
      if (!current || current.state === JOB_STATE.DONE || current.state === JOB_STATE.FAILED) {
        this.active.set(row.job_id, entry);
      }
      const item = { id: row.job_id, handler, key, queueItemId: row.id };
      const at = row.run_after ? Date.parse(row.run_after) : NaN;
      const delay = Number.isFinite(at) ? at - Date.now() : 0;
      if (delay > 0) this.#schedule(item, delay);
      else this.queue.push(item);
      restored += 1;
    }
    this.#pump();
    // F3 (phản biện R1, CAO): bật VÒNG NHẶT VIỆC định kỳ. Không có nó, tiến trình đang sống chỉ
    // chạy được việc tại đúng thời điểm `resume()`; việc `queued` sinh ra SAU đó (do tiến trình
    // khác chết, do cron trả mục `running` về `queued`) sẽ nằm im mãi — đo được: sau 6 nhịp cron,
    // tiến trình sống chạy được 0 việc, phải restart mới chạy.
    this.#startPolling();
    if (restored > 0 || requeued > 0) {
      this.logger?.info('queue.resumed', { requeued, restored, skipped, durable: true, poll_ms: this.#pollMs });
    }
    return { durable: true, requeued, restored, skipped };
  }

  /** Dựng hàm xử lý cho một mục khôi phục từ DB (closure cũ đã chết theo tiến trình). */
  async #buildHandler(row) {
    const factory = this.handlers.get(String(row.handler));
    if (typeof factory !== 'function') return null;
    const fn = await factory({
      jobId: row.job_id,
      kind: row.kind,
      handler: row.handler,
      payload: row.payload ?? null,
      row,
      store: this.store,
      queue: this,
      logger: this.logger,
    });
    return typeof fn === 'function' ? fn : null;
  }

  #pump() {
    if (this.closed) return;
    while (this.running < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this.running += 1;
      this.#runItem(item)
        .catch(() => {
          /* đã xử lý bên trong */
        })
        .finally(() => {
          this.running -= 1;
          if (this.size === 0) this.#resolveIdle();
          this.#pump();
        });
    }
    if (this.size === 0) this.#resolveIdle();
  }

  /** Đưa một mục vào hàng đợi sau `delayMs` (backoff). Có trần thời gian chờ của tiến trình. */
  #schedule(item, delayMs) {
    if (this.closed) return;
    this.waiting += 1;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      this.waiting -= 1;
      if (this.closed) {
        if (this.size === 0) this.#resolveIdle();
        return;
      }
      this.queue.push(item);
      this.#pump();
      if (this.size === 0) this.#resolveIdle();
    }, Math.max(0, Number(delayMs) || 0));
    // ⚠️ KHÔNG `unref()` timer này: bản cũ chờ backoff bằng `await new Promise(setTimeout)` —
    // tham chiếu MẠNH — nên `drain()`/test vẫn sống tới lúc thử lại. `unref()` sẽ để tiến trình
    // thoát giữa lúc chờ và `drain()` treo vĩnh viễn ("unsettled top-level await").
    // `close()` là nơi duy nhất huỷ timer (đã có).
    this.timers.add(timer);
  }

  async #runItem(item) {
    const entry = this.items.get(item.key) || this.active.get(item.id) || { attempts: 0, state: JOB_STATE.PENDING };
    let claim = null;
    if (this.durable) {
      try {
        claim = item.queueItemId
          ? await this.store.claimQueueItem(item.queueItemId, { workerId: this.workerId, now: this.#iso() })
          : await this.store.claimNextJob({ workerId: this.workerId, now: this.#iso() });
      } catch (err) {
        // DB bận quá lâu: KHÔNG đánh dấu job hỏng (việc chưa hề chạy) — trả mục lại hàng đợi
        // bộ nhớ và thử lại sau; dòng DB vẫn `queued` nên lần `resume()` sau vẫn thấy.
        this.logger?.warn('queue.claim_deferred', { job_id: item.id, error: err });
        this.#schedule(item, Math.max(this.retryBaseMs, 250));
        return;
      }
      if (!claim) {
        // Không thắng được lượt nhặt: tiến trình KHÁC đã nhận mục này, hoặc mục đã xong/bị huỷ.
        // Đây là chốt chặn cuối cùng của "không chạy hai lần, không thu tiền hai lần".
        //
        // A2 (phản biện R1 vòng 2, VỪA): KHÔNG được phát `done` khi handler CHƯA CHẠY — trước đây
        // phát `done(skipped: true)` nên tầng gọi tưởng job đã xong (đo được 10 `done` giả trong
        // 2 giây). Nay phát `skipped` với lý do đọc được, và nếu mục đã chạm trần thì đánh dấu
        // `failed` để không ai nhặt lại.
        const row = item.queueItemId ? await this.store.getQueueItemById?.(item.queueItemId).catch(() => null) : null;
        const exhausted = row ? Number(row.attempts) >= Number(row.max_attempts) : false;
        if (exhausted && item.queueItemId) {
          await this.store.failQueueItem?.(item.queueItemId, {
            error: Object.assign(new Error('Mục đã chạm trần số lần thử — không chạy lại.'), { code: 'QUEUE_ATTEMPTS_EXHAUSTED' }),
            force: true,
          }).catch((err) => this.logger?.warn('queue.exhausted_mark_failed', { queue_item_id: item.queueItemId, error: err }));
          this.logger?.error('queue.attempts_exhausted', { job_id: item.id, queue_item_id: item.queueItemId });
          this.emit('failed', {
            id: item.id,
            error: Object.assign(new Error('Mục đã chạm trần số lần thử.'), { code: 'QUEUE_ATTEMPTS_EXHAUSTED' }),
            attempts: Number(row?.attempts) || 0,
            exhausted: true,
          });
        } else {
          this.logger?.warn('queue.item_skipped', { job_id: item.id, queue_item_id: item.queueItemId || null });
          this.emit('skipped', { id: item.id, queue_item_id: item.queueItemId || null, reason: 'claim_lost' });
        }
        entry.state = exhausted ? JOB_STATE.FAILED : JOB_STATE.DONE;
        entry.skipped = true;
        this.active.set(item.id, entry);
        return;
      }
      entry.queueItemId = claim.id;
      // A3 (fencing): epoch của LƯỢT CLAIM này — mọi thao tác kết thúc phải kèm epoch.
      entry.epoch = Number(claim.epoch ?? 0);
    }
    entry.attempts = this.durable ? Number(claim?.attempts ?? entry.attempts + 1) : entry.attempts + 1;
    entry.state = JOB_STATE.RUNNING;
    this.active.set(item.id, entry);
    if (item.key) this.items.set(item.key, entry);

    // F2 (phản biện R1, CAO) — HEARTBEAT: giữ lease sống trong lúc handler chạy.
    // Không có nhịp này, job dài hơn `stale_ms` bị cron "cướp" và HAI tiến trình chạy song song
    // cùng một mục (đo được: 2 khoảng thời gian chồng nhau, `attempts` 1→2, bản trùng `failed`
    // ⇒ hook hoàn tiền trong khi bản gốc vẫn xong ⇒ mất doanh thu).
    const heartbeat = this.#startHeartbeat(entry.queueItemId, entry.epoch ?? null);
    try {
      const result = await item.handler({
        attempt: entry.attempts,
        queueItemId: entry.queueItemId ?? null,
        workerId: this.workerId,
        epoch: entry.epoch ?? null,
      });
      if (this.durable && entry.queueItemId) {
        // A3 (fencing): chỉ chốt `done` nếu epoch CÒN KHỚP. Runner đã bị cướp (SIGSTOP/mất lease)
        // không được ghi đè kết quả của runner mới; kết quả của nó bị BỎ và ghi log.
        const ok = await this.store.completeQueueItem(entry.queueItemId, { epoch: entry.epoch ?? null });
        if (ok === false && entry.epoch !== undefined && entry.epoch !== null) {
          this.logger?.warn('queue.stale_result_discarded', {
            job_id: item.id,
            queue_item_id: entry.queueItemId,
            epoch: entry.epoch,
            reason: 'epoch_lệch — lượt này đã bị claim lại bởi tiến trình khác',
          });
          entry.state = JOB_STATE.DONE;
          entry.finishedAt = new Date().toISOString();
          entry.staleResult = true;
          this.active.set(item.id, entry);
          this.emit('skipped', { id: item.id, queue_item_id: entry.queueItemId, reason: 'stale_epoch' });
          return;
        }
      }
      entry.state = JOB_STATE.DONE;
      entry.finishedAt = new Date().toISOString();
      this.active.set(item.id, entry);
      this.emit('done', { id: item.id, result, attempts: entry.attempts });
    } catch (err) {
      await this.#handleFailure(item, entry, err);
    } finally {
      heartbeat?.stop();
    }
  }

  /**
   * F2 — nhịp tim cho mục đang chạy: `stale_ms/3` (tối thiểu 1s, tối đa 30s).
   *
   * Trả `null` khi không ở chế độ bền (không có mục DB để gia hạn). Mỗi nhịp gọi
   * `store.touchQueueItem(id, { workerId })`; mục đã bị thu hồi/đổi chủ ⇒ hàm trả `false` và ta
   * ghi log `queue.lease_lost` (KHÔNG tự ý chạy tiếp như thể vẫn sở hữu — nhưng cũng không giết
   * handler đang chạy: để nó kết thúc rồi `completeQueueItem` sẽ là no-op vì mục không còn 'running').
   */
  /**
   * F3 — vòng NHẶT VIỆC định kỳ (`config.queue.pollMs`, mặc định 1000ms, sàn 200ms).
   *
   * Nhịp này `unref()` (không giữ tiến trình sống) và chỉ chạy khi hàng đợi BỀN. Mỗi nhịp gọi
   * `pumpQueued()`: thu hồi mục quá hạn rồi nhặt mục `queued` còn lượt để chạy — nhờ vậy việc "mồ
   * côi" của tiến trình đã chết được cứu bởi BẤT KỲ tiến trình nào đang sống, không cần restart.
   */
  #startPolling() {
    if (!this.durable || this.closed || this.#pollTimer) return null;
    const timer = setInterval(() => {
      if (this.closed) return;
      this.pumpQueued().catch((err) => this.logger?.warn('queue.poll_failed', { error: err }));
    }, this.#pollMs);
    timer.unref?.();
    this.#pollTimer = timer;
    this.timers.add(timer);
    return timer;
  }

  /** Dừng vòng nhặt việc (dùng trong `close()`). */
  #stopPolling() {
    if (!this.#pollTimer) return;
    clearInterval(this.#pollTimer);
    this.timers.delete(this.#pollTimer);
    this.#pollTimer = null;
  }

  #startHeartbeat(queueItemId, epoch = null) {
    if (!this.durable || !queueItemId || typeof this.store?.touchQueueItem !== 'function') return null;
    // ⚠️ SÀN THẤP (50ms), không phải 1s: `stale_ms` có thể được chỉnh rất ngắn (test/đo), và nhịp
    // tim dài hơn cửa sổ treo thì KHÔNG bảo vệ được gì (đo thật: `stale_ms=500` + nhịp 1000ms ⇒
    // cron vẫn cướp mục đang chạy). Nhịp = `stale_ms/3` ⇒ luôn có 3 nhịp trong một cửa sổ.
    const period = Math.max(50, Math.min(30000, Math.floor(this.staleMs / 3) || 50));
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      this.store
        .touchQueueItem(queueItemId, { workerId: this.workerId, now: this.#iso(), epoch })
        .then((ok) => {
          if (ok === false) this.logger?.warn('queue.lease_lost', { queue_item_id: queueItemId, worker_id: this.workerId });
        })
        .catch((err) => this.logger?.warn('queue.heartbeat_failed', { queue_item_id: queueItemId, error: err }));
    }, period);
    // Nhịp tim KHÔNG được giữ tiến trình sống khi mọi việc đã xong.
    timer.unref?.();
    this.timers.add(timer);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      this.timers.delete(timer);
    };
    return { stop, period };
  }

  /**
   * Khoảng chờ trước lần thử lại thứ `attempts` (1-based) của một mục.
   *
   * Lịch GỐC của hợp đồng §2.3 là `retryBaseMs * attempts` (1:2:3…), nhưng tổng của nó bị chặn
   * trần `retryTotalMs` bằng cách CHIA THEO TỈ LỆ — giữ đúng dáng backoff tăng dần mà job hỏng
   * vẫn hiện `failed` sớm (xem `QUEUE_DEFAULTS.retryTotalMs`). Khi lịch gốc đã nằm trong trần
   * (ví dụ `retryBaseMs` 500 với 3 lượt = 1,5 giây) thì trả về ĐÚNG lịch gốc.
   */
  #retryDelayFor(attempts, maxAttempts = this.queueMaxAttempts) {
    const budget = Math.max(0, this.retryTotalMs);
    const slots = Math.max(1, Math.trunc(this.#num(maxAttempts, this.queueMaxAttempts)) - 1);
    const contract = Array.from({ length: slots }, (_, k) => Math.max(0, this.retryBaseMs) * (k + 1));
    const total = contract.reduce((sum, v) => sum + v, 0);
    if (total <= 0) return 0;
    const scale = Math.min(1, budget / total);
    const index = Math.min(Math.max(1, Math.trunc(this.#num(attempts, 1))), slots) - 1;
    return Math.max(0, Math.round(contract[index] * scale));
  }

  /** Xử lý một lần handler ném lỗi: backoff rồi thử lại, hoặc chốt `failed`. */
  async #handleFailure(item, entry, err) {
    if (this.durable && entry.queueItemId) {
      // Backoff theo lịch §2.3 (có trần tổng). Quyết định thử lại hay hỏng hẳn nằm ở
      // `attempts`/`max_attempts` trong DB — nguồn sự thật, không phải biến đếm trong bộ nhớ.
      const delay = this.#retryDelayFor(entry.attempts);
      let out = null;
      try {
        out = await this.store.failQueueItem(entry.queueItemId, { error: err, retryDelayMs: delay, epoch: entry.epoch ?? null });
      } catch (e2) {
        // KHÔNG ghi được trạng thái thất bại ⇒ fail-closed: coi như hỏng hẳn (không thử lại vô
        // hạn một mục mà DB không chịu cập nhật).
        this.logger?.error('queue.fail_mark_error', { job_id: item.id, queue_item_id: entry.queueItemId, error: e2 });
        out = { status: 'failed', attempts: entry.attempts };
      }
      if (out?.stale === true) {
        // A3: lượt này đã bị claim lại ⇒ KHÔNG ghi trạng thái/tiền cho kết quả cũ.
        this.logger?.warn('queue.stale_result_discarded', {
          job_id: item.id,
          queue_item_id: entry.queueItemId,
          epoch: entry.epoch ?? null,
          reason: 'kết quả của lượt cũ bị bỏ (epoch lệch)',
        });
        entry.state = JOB_STATE.DONE;
        entry.staleResult = true;
        this.active.set(item.id, entry);
        this.emit('skipped', { id: item.id, queue_item_id: entry.queueItemId, reason: 'stale_epoch' });
        return;
      }
      if (out?.status === 'queued') {
        this.logger?.warn('job.retry', { job_id: item.id, attempt: entry.attempts, retry_in_ms: delay, error: err });
        entry.state = JOB_STATE.PENDING;
        this.active.set(item.id, entry);
        if (item.key) this.items.set(item.key, entry);
        const at = out.run_after ? Date.parse(out.run_after) : NaN;
        const wait = Number.isFinite(at) ? Math.max(0, at - Date.now()) : delay;
        this.#schedule(item, wait);
        return;
      }
      entry.state = JOB_STATE.FAILED;
      entry.error = err?.message || String(err);
      this.active.set(item.id, entry);
      this.emit('failed', { id: item.id, error: err, attempts: entry.attempts });
      return;
    }
    // ── Chế độ BỘ NHỚ: giữ nguyên hành vi cũ ──────────────────────────────────────────
    if (entry.attempts < this.maxAttempts) {
      this.logger?.warn('job.retry', { job_id: item.id, attempt: entry.attempts, error: err });
      entry.state = JOB_STATE.PENDING;
      this.active.set(item.id, entry);
      this.#schedule(item, this.retryDelayMs * entry.attempts);
      return;
    }
    entry.state = JOB_STATE.FAILED;
    entry.error = err?.message || String(err);
    this.active.set(item.id, entry);
    this.emit('failed', { id: item.id, error: err, attempts: entry.attempts });
  }

  #resolveIdle() {
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const r of resolvers) r();
  }

  /**
   * Dừng hàng đợi SẠCH (gọi từ `app.close()`):
   *  - không nhận/không nhặt việc mới;
   *  - chờ việc ĐANG CHẠY kết thúc (có trần thời gian, không cắt ngang handler);
   *  - bỏ các mục CHƯA chạy khỏi bộ nhớ — chúng VẪN `queued` trong DB nên lần khởi động sau
   *    `resume()` sẽ chạy lại (đúng tinh thần "khởi động lại không mất việc").
   */
  async close({ waitMs = null } = {}) {
    this.#stopPolling();
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.waiting = 0;
    const budget = Math.max(0, this.#num(waitMs, this.closeTimeoutMs));
    if (this.running > 0) {
      await Promise.race([this.drain(), new Promise((resolve) => {
        const t = setTimeout(resolve, budget);
        t.unref?.();
      })]);
    }
    const dropped = this.queue.length;
    this.queue.length = 0;
    if (dropped > 0) this.logger?.warn('queue.close_pending_dropped', { dropped, note: 'vẫn còn queued trong DB ⇒ resume() lần sau chạy lại' });
    this.#resolveIdle();
    return { dropped, running: this.running, durable: this.durable };
  }
}

export default JobQueue;
