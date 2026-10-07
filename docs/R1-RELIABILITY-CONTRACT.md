# SPRINT ĐỘ TIN CẬY (R1) — HỢP ĐỒNG GIAO DIỆN (ĐÓNG BĂNG)

> Ba lỗ hổng đã ghi trong `docs/OWNER-DECISIONS.md` mục 4 và `docs/VERIFICATION.md`:
> hàng đợi **trong bộ nhớ** (khởi động lại là mất việc đang chờ) · khoá tiền **trong bộ nhớ**
> (chỉ đúng 1 tiến trình) · **không có cron** thu hồi lượt treo. Sprint này bịt cả ba.
> **Không** đụng vào hành vi nghiệp vụ đã nghiệm thu — chỉ làm nó **bền** và **an toàn khi chạy nhiều tiến trình**.

Nhánh: `feat/r1-reliability` · Ngày khoá: 07/10/2026 · Baseline: **929 test · 928 pass · 0 fail · 1 skipped**

---

## 1. BẢN ĐỒ SỞ HỮU

| Agent | Được ghi | Chỉ đọc |
|---|---|---|
| **R1-Q** (hàng đợi bền) | `src/jobs/queue.js`, `src/store/schema.sql`, `src/store/index.js`, `src/app.js` | tất cả |
| **R2-B** (khoá tiền DB) | `src/billing/**` | `src/store/**` (chỉ gọi method R1-Q cung cấp) |
| **R3-S** (cron) | `src/scheduler.js` (mới), `src/server.js`, `src/config.js`, `.env.example` | tất cả |
| Test | `test/**` | tất cả |
| Phản biện | `docs/R1-REVIEW.md` | tất cả |
| Gộp | mọi file (trừ `docs/R1-REVIEW.md`) | tất cả |

Cấm: sửa `test/**` (trừ agent test), `docs/**`, thêm dependency. Bắt buộc: `node --check` + `npm test` xanh.

---

## 2. R1-Q — HÀNG ĐỢI BỀN

### 2.1 Bảng mới (SQLite + PostgreSQL, cùng `schema.sql`)

```sql
job_queue (
  id TEXT PRIMARY KEY,             -- uuid của mục hàng đợi
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'content' | 'image_translation' | 'image_generation' | 'video_generation'
  handler TEXT NOT NULL,           -- tên việc: 'run' | 'generate' | 'render' | 'run_ocr' …
  payload TEXT,                    -- JSON nhỏ (KHÔNG chứa base64 ảnh)
  status TEXT NOT NULL DEFAULT 'queued',   -- 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TEXT,                  -- ISO: chưa tới mốc thì không nhặt (backoff)
  locked_at TEXT, locked_by TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
);
-- index: (status, run_after), (job_id), (locked_at)
```

### 2.2 Method store (TÊN ĐÓNG BĂNG — R1-Q viết, R3-S dùng)

```js
enqueueJob({ id?, jobId, kind, handler, payload, maxAttempts, runAfter }) → queueRow
claimNextJob({ workerId, now }) → queueRow | null      // NGUYÊN TỬ: chỉ 1 tiến trình nhặt được 1 mục
completeQueueItem(id) → boolean
failQueueItem(id, { error, retryDelayMs }) → { status: 'queued'|'failed', attempts }
requeueStaleJobs({ olderThanMs, now, limit }) → { requeued: number }   // mục 'running' quá cũ ⇒ về 'queued'
queueStats() → { queued, running, done, failed }
getQueueItem(jobId) → queueRow | null
withLedgerLock(userId, fn) → Promise<any>   // R2-B dùng (xem §3)
```

**Nguyên tắc nguyên tử:** `claimNextJob` phải chạy trong **một transaction** (`driver.transaction` sẵn có)
và dùng cơ chế khoá của driver (SQLite: `BEGIN IMMEDIATE`/`UPDATE ... WHERE status='queued'` rồi kiểm
`changes`; PostgreSQL: `SELECT ... FOR UPDATE SKIP LOCKED`) ⇒ **hai tiến trình cùng nhặt không được
trả về cùng một mục**.

### 2.3 `JobQueue` (bền)

- `new JobQueue({ store, logger, concurrency, workerId, now })` — hành vi cũ giữ nguyên:
  `enqueue(jobId, fn)`, `isPending(jobId)`, `stats()`, `onIdle()`.
- **Ghi DB TRƯỚC khi chạy**: `enqueue` ⇒ `store.enqueueJob(...)` rồi mới xếp vào bộ nhớ.
- **Khôi phục khi khởi động**: `queue.resume()` đọc các mục `queued` + `running` quá cũ
  (`config.queue.staleMs`, mặc định 10 phút) ⇒ đưa lại vào hàng đợi; mục `running` cũ ⇒ `requeueStaleJobs`.
- **Retry**: handler ném lỗi ⇒ `failQueueItem` với backoff (mặc định `2000 * attempts` ms);
  hết `max_attempts` ⇒ `failed` + job `failed` (giữ nguyên hành vi cũ: job có `error_code` + `finished_at`).
- **Idempotent**: enqueue cùng `jobId` + `handler` khi mục cũ còn `queued`/`running` ⇒ **không** tạo mục mới
  (trả mục cũ) — nếu không sẽ chạy 2 lần và **thu tiền 2 lần** (MVP-05).
- `config.queue = { durable: true, staleMs: 600000, maxAttempts: 3, retryBaseMs: 2000 }`
  (`QUEUE_DURABLE`, `QUEUE_STALE_MS`, `QUEUE_MAX_ATTEMPTS`, `QUEUE_RETRY_BASE_MS` trong `.env.example`).
  `QUEUE_DURABLE=false` ⇒ chạy như cũ (bộ nhớ) — để so sánh/rollback.

---

## 3. R2-B — KHOÁ TIỀN Ở TẦNG DB

`BillingService` **bỏ phụ thuộc vào khoá trong bộ nhớ**: mọi thao tác ghi sổ đi qua
`store.withLedgerLock(userId, fn)` (R1-Q cung cấp) — khoá **theo người dùng**, giữ trong **cùng
transaction** với việc đọc số dư + ghi dòng sổ.

- SQLite: `BEGIN IMMEDIATE` (hoặc `PRAGMA busy_timeout` + transaction ghi) — chống `database is locked`
  bằng `retry` có giới hạn (`LEDGER_BUSY` sau N lần, như hiện tại).
- PostgreSQL: `pg_advisory_xact_lock(hashtext(userId))` trong transaction.
- **Bất biến không đổi**: số dư = tổng sổ, không bao giờ âm, `balance_after` liên tục, idempotent theo
  `(job_id, run_key)`.
- Chứng minh **2 tiến trình thật** (2 process Node chung 1 file SQLite; và PG nếu có `DATABASE_URL`):
  20 thao tác song song ⇒ số dư = tổng sổ, **0 dòng âm**, **0 lần chết vì `database is locked`**.

---

## 4. R3-S — CRON (scheduler)

```js
export function createScheduler({ app, store, config, logger }) → {
  start(): void, stop(): Promise<void>, runOnce(): Promise<{ reconciled, requeued, errors }>, stats()
}
```

- `src/server.js` khởi động scheduler khi `config.scheduler.enabled` (mặc định **true**) và
  `stop()` sạch khi tắt server; **không** giữ tiến trình sống nếu server đang tắt (`unref()`).
- Mỗi nhịp (`SCHEDULER_INTERVAL_MS`, mặc định 60_000):
  1. `app.reconcileStuckRuns({ olderThanMs: config.billing.stuckRunMs })` (MVP-05) — thu hồi lượt treo;
  2. `store.requeueStaleJobs({ olderThanMs: config.queue.staleMs })` — trả mục hàng đợi chết về hàng đợi.
- Log **một dòng** mỗi nhịp **chỉ khi có việc** (`scheduler.tick` với số liệu); lỗi ⇒ log warn, **không** chết vòng lặp.
- `GET /api/health` thêm `scheduler: { enabled, running, last_tick_at, ticks, last_result }` (không lộ bí mật).
- Test không được phụ thuộc thời gian thật: `runOnce()` gọi được thủ công.

---

## 5. ĐỊNH NGHĨA "XONG"

- Khởi động lại tiến trình ⇒ **việc đang chờ không mất**: mục `queued` được chạy lại; mục `running` quá cũ
  được trả về hàng đợi (chứng minh bằng test + script 2 tiến trình thật).
- Enqueue trùng `jobId`+`handler` ⇒ **không** chạy 2 lần, **không** thu tiền 2 lần.
- Ví an toàn khi **2 tiến trình** ghi sổ cùng lúc: số dư = tổng sổ, không âm, không chết vì khoá.
- Scheduler chạy được, `runOnce()` tất định, tắt sạch, số liệu hiện ở `/api/health`.
- **Không hồi quy**: toàn bộ test cũ xanh; `node tools/verify.mjs` xanh; hành vi ẩn danh (không ví) không đổi.
