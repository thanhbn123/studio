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

---

# VÒNG SỬA PHẢN BIỆN (F1…F6) — chốt lại các điểm lệch

Phán quyết vòng 1: **FAIL** (`docs/R1-REVIEW.md`). Những điểm dưới đây ĐỔI so với bản đóng băng đầu.

## 6.1 F1 — TRẦN `max_attempts` ở MỌI đường (không chỉ `failQueueItem`)

- `claimNextJob`/`claimQueueItem`: điều kiện nhặt có thêm **`attempts < max_attempts`**.
- `requeueStaleJobs`: **hai nhánh** — `attempts < max_attempts` ⇒ `queued`; đã chạm trần ⇒
  **`failed`** + `finished_at` + `last_error = 'quá số lần thử'`; trả thêm
  `{ failed, failed_ids, failed_job_ids }`.
- `JobQueue.reclaimStale()` chốt **JOB** tương ứng thành `failed` +
  `error_code = 'QUEUE_ATTEMPTS_EXHAUSTED'` + `finished_at` và **phát sự kiện `failed`** để hook
  tính tiền chạy đúng đường (hoàn tiền/đánh dấu).

## 6.2 F2 — LEASE + HEARTBEAT (không cướp việc, không hoàn tiền oan)

- Cột mới `job_queue.heartbeat_at` (migration cộng thêm).
- `store.touchQueueItem(id, { workerId, now })` — chỉ **chủ hiện tại** (`locked_by`) gia hạn được;
  trả `false` nếu mục đã đổi chủ/không còn `running`.
- `JobQueue` chạy **nhịp tim** trong lúc handler chạy: chu kỳ `max(50ms, min(30s, stale_ms/3))`,
  `unref()` (không giữ tiến trình sống), dừng ở `finally` và ở `close()`.
- `requeueStaleJobs` chỉ thu hồi mục quá hạn theo `COALESCE(heartbeat_at, locked_at, updated_at,
  created_at)` ⇒ job dài hơn `stale_ms` **không** còn bị cướp.
- `completeQueueItem`/`failQueueItem` **idempotent theo trạng thái**: mục đã `done`/`failed` không
  bị lật lại (không phát sự kiện hoàn tiền lần hai).

## 6.3 F3 — TIẾN TRÌNH ĐANG SỐNG phải nhặt việc `queued` (không cần restart)

- `JobQueue.pumpQueued({ olderThanMs?, limit? })`: `reclaimStale()` → liệt kê mục `queued` → dựng
  handler từ bảng đã đăng ký → xếp vào bộ nhớ; tôn trọng `concurrency`, `run_after`, và **không**
  nhặt lại mục đang PENDING/RUNNING trong bộ nhớ (so cả `queueItemId` **và** cặp
  `(job_id, handler)` — vì khoá bộ nhớ `…::fn:<id>` khác khoá DB `…::row:<id>`).
- Vòng **poll định kỳ** `config.queue.pollMs` (mặc định 1000ms, sàn 200ms) bật trong `resume()`,
  `unref()`, tắt trong `close()`.
- `scheduler.runOnce()` gọi `queue.pumpQueued()` mỗi nhịp (khi app có `queue.pumpQueued`), và
  `/api/health → scheduler.last_result` có thêm `claimed` + `exhausted`.

## 6.4 F4 — PHÂN LOẠI LỖI DRIVER + KHÔNG LÀM HỎNG TRANSACTION

- `#callStore` phân loại **theo thứ tự**: vi phạm UNIQUE ⇒ `LEDGER_CONFLICT`
  (`retryable: false`) → transaction bị abort (`25P02`) ⇒ `LEDGER_TX_ABORTED` → còn lại mới là
  `LEDGER_BUSY` (`retryable: true`). Mã thô của driver không bao giờ ra tới HTTP.
- `appendLedger` ghi kiểu **`ON CONFLICT DO NOTHING`** (PostgreSQL) / **`OR IGNORE`** (SQLite):
  vi phạm UNIQUE **không** còn abort transaction; `changes === 0` ⇒ ném `LEDGER_CONFLICT` để tầng
  gọi **đọc lại dòng đã có** (idempotent theo `(job_id, run_key)`).
- `withLedgerLock`'s tx view có `savepoint(name, fn)`; tầng billing ghi sổ trong savepoint và tự
  chạy lại section (tối đa 2 lần) nếu transaction bị abort.

## 6.5 F5 — MỌI KHOÁ CÓ TIMEOUT HỮU HẠN

- `config.billing.lockTimeoutMs` (`BILLING_LOCK_TIMEOUT_MS`, mặc định 5000) — khoá tuần tự hoá ví
  trong bộ nhớ; hết hạn ⇒ `LEDGER_BUSY` + `retryable: true`.
- `config.queue.lockTimeoutMs` (`QUEUE_LOCK_TIMEOUT_MS`, mặc định 5000) — mutex transaction SQLite
  trong tiến trình; hết hạn ⇒ `DB_LOCK_TIMEOUT` (được `isBusyError` coi là bận) ⇒ `QUEUE_BUSY`
  kèm `retryable: true`.
- Ghi rõ: trên SQLite **mọi** transaction ghi dùng chung một hàng đợi (một file, một kết nối) —
  yêu cầu ví có thể phải chờ hàng đợi; trần chờ ở trên bảo đảm nó fail sớm thay vì treo.

## 6.6 F6 — KHOÁ IDEMPOTENCY TRÊN ĐƯỜNG THẬT

- Mọi chỗ `queue.enqueue(...)` trong `src/http/routes.js` nay truyền `meta.runKey` khi lượt chạy
  có khoá ví (`hold.run_key`): `POST /api/jobs`, `regenerate`, `POST /api/imagelab/jobs`,
  `PUT …/regions`, `render`, `POST /api/imagestudio/jobs`, `generate`,
  `POST/POST-generate /api/videostudio/jobs`.
- Ngữ nghĩa: **cùng một khoá** (cùng lượt) + N tiến trình × M lần enqueue ⇒ **MỘT** mục hàng đợi,
  MỘT lần chạy (khoá chính là hàm băm tất định của `jobId::handler::rk:<runKey>`).
  **Hai lượt khác nhau** (kể cả hai request render song song của khách ẩn danh — không có ví ⇒
  không có `run_key`) vẫn là **hai mục, hai lần chạy** (MVP-05 §BR-02 giữ nguyên).

---

# VÒNG 3 — SỬA A1…A6 + hai mục còn sót của F5/F6

Phán quyết vòng 2: **PASS CÓ ĐIỀU KIỆN** (`docs/R1-REVIEW.md` mục “VÒNG 2”, script `/tmp/r1-atk2/**`).

## 7.1 A1 — BOOT ĐỒNG THỜI không được làm chết tiến trình (SQLite)

- `SqliteDriver.connect()`: **`busy_timeout` đặt TRƯỚC TIÊN** (và truyền `timeout` cho
  `new DatabaseSync`); `foreign_keys` và `journal_mode = WAL` là pragma RIÊNG, lỗi WAL **không**
  còn làm mất timeout (trước đây cả ba nằm trong một `try` ⇒ WAL lỗi là timeout = 0).
- `#pragmaWithRetry('journal_mode', …)`: 10 lần × 100–500ms cho `SQLITE_BUSY` khi nhiều tiến trình
  cùng đổi sang WAL.
- `Store.init()`: tách `#initOnce()` + **thử lại có ngân sách** (`queue.initRetries`,
  tổng ≤ `queue.lockTimeoutMs`) khi gặp lỗi bận.
- `#runIdempotentDdl()`: DDL nâng cấp cột/index chịu được ĐUA KHỞI ĐỘNG —
  `duplicate column name` / `already exists` là **thành công** (migration idempotent), không ném.
  (Đây là nguyên nhân thật của 13–38% ca boot chết: hai tiến trình cùng `ALTER TABLE`.)

## 7.2 A2 — TRẦN `attempts` ở MỌI đường “hồi sinh”; không có `done` giả

- `listQueueItems({ onlyClaimable = true })`: mặc định **loại** mục đã chạm trần ⇒ `resume()`,
  vòng poll và `pumpQueued()` không bao giờ nhặt lại mục rác.
- `enqueueJob()` khi mục đang `queued`/`running` **đã chạm trần** ⇒ coi là **LƯỢT MỚI**: reset
  `attempts = 0`, `epoch = epoch + 1`, xoá `locked_*`/`finished_at` (log `store.queue_item_revived`).
- `pumpQueued()` **chốt** mục `queued` đã chạm trần thành `failed` + job `failed`
  (`QUEUE_ATTEMPTS_EXHAUSTED`) và phát sự kiện `failed`.
- `#runItem`: khi `claim` trả `null` thì **KHÔNG phát `done`** nữa — phát `skipped`
  (`reason: 'claim_lost'`) hoặc `failed` nếu mục đã chạm trần.

## 7.3 A3 — FENCING bằng `epoch`

- Cột `job_queue.epoch` (migration): **mỗi lần claim tăng 1**; `claimNextJob`/`claimQueueItem` trả
  `epoch` cho runner.
- `completeQueueItem(id, { epoch })` / `failQueueItem(id, { epoch, … })` /
  `touchQueueItem(id, { workerId, epoch })`: **chỉ** chấp nhận khi epoch khớp. Lệch ⇒ `false`
  (`complete`) hoặc `{ stale: true }` (`fail`), **không** đổi trạng thái.
- `JobQueue`: giữ `entry.epoch`, truyền vào nhịp tim và hai đường kết thúc; kết quả của runner cũ
  bị **BỎ** kèm log `queue.stale_result_discarded` (không ghi trạng thái job, không phát `done`).
- ⚠️ `normalizeEpoch()`: `Number(null) === 0` ⇒ lời gọi KHÔNG truyền epoch từng bị hiểu là
  `epoch = 0` và mọi UPDATE kèm `AND epoch = 0` không khớp dòng nào; nay `null`/`''` = “không kiểm”.
- TIỀN (A3.2): lượt đã bị HOÀN nhưng việc **đã xong** ⇒ `settleForJob` ghi **quyết toán muộn**
  (`run_key = <runKey>#late`, `meta.late_settle_after_refund = true`) ⇒ **không mất doanh thu**.
  Chỉ giữ nguyên việc hoàn tiền khi BIẾT CHẮC job đã hỏng (`job.status` khác `succeeded`).

## 7.4 A4 + F5 — khoá hết hạn: nhường ĐÚNG THỨ TỰ, mã lỗi của repo

- `#withMutex` hết hạn: nhường lượt **sau khi chủ hiện tại xong** (`previous.then(release)`) —
  trước đây `release()` ngay ⇒ người sau vào mutex khi transaction còn mở ⇒
  `cannot start a transaction within a transaction` (`ERR_SQLITE_ERROR` thô).
- `isBusyError` nhận thêm `cannot start a transaction within a transaction` + `DB_LOCK_TIMEOUT`.
- `asRepoBusyError()`: mọi lỗi bận lộ ra tầng gọi đều được chuẩn hoá thành **`LEDGER_BUSY`/
  `QUEUE_BUSY` kèm `retryable: true`** (áp cho cả `appendLedger` gọi trực tiếp, `withLedgerLock`,
  `claimNextJob`, `init()`). Không bao giờ để `ERR_SQLITE_ERROR`/`SQLITE_BUSY` thô ra ngoài.

## 7.5 A5 — trần chờ áp ở TẦNG DB

- SQLite: `PRAGMA busy_timeout = config.queue.lockTimeoutMs` (mặc định 5000) — đặt trước mọi pragma.
- PostgreSQL: trong transaction khoá sổ có `SET LOCAL lock_timeout = <ms>` và
  `SET LOCAL statement_timeout = <3×ms>` ⇒ máy chủ tự cắt thay vì chờ vô hạn.
- **Giới hạn còn lại (ghi rõ, không im lặng)**: SQLite vẫn là **một khoá ghi toàn cục**; đo thật
  trên máy này: tiến trình thứ hai chờ tới khi chủ nhả (~8,5s trong phép đo với người giữ 9s),
  KHÔNG cắt đúng 5s như mong đợi — xem `docs/VERIFICATION.md` §22.6.

## 7.6 A6 + F6

- A6: `touchQueueItem` **bắt buộc** `workerId` (thiếu/rỗng ⇒ `false` + log
  `store.touch_missing_worker`); kèm `epoch` nếu caller biết.
- F6: đủ **8/8** chỗ `queue.enqueue` truyền `meta.runKey` (bổ sung `POST /api/jobs/:id/regenerate`).

---

# VÒNG 4 — B1…B3 (chốt R1)

## 8.1 B1 — FENCING KHÔNG TUỲ CHỌN: `epoch` bắt buộc

- `completeQueueItem(id, { epoch })`: **thiếu epoch ⇒ `false`** + log `store.complete_missing_epoch`
  (trạng thái KHÔNG đổi). Chỉ đường VẬN HÀNH mới dùng `{ force: true }` (log `store.complete_forced`).
- `failQueueItem(id, { epoch })`: **thiếu epoch ⇒ `{ stale: true, missing_epoch: true }`** + log
  `store.fail_missing_epoch`, không ghi gì. `{ force: true }` dành cho dọn mục rác (queue dùng cho
  mục chạm trần/quá hạn).
- Mọi chỗ gọi nội bộ (`JobQueue.#runItem`, `#handleFailure`, `reclaimStale`, `pumpQueued`) truyền
  `entry.epoch` / `row.epoch`. Test cũ đã cập nhật theo hợp đồng mới.

## 8.2 B2 — NGÂN SÁCH TỔNG cho pragma lúc `connect()`

- `config.queue.initBudgetMs` (`QUEUE_INIT_BUDGET_MS`, mặc định **5000ms**) chặn tổng thời gian thử
  lại của `journal_mode = WAL` (trước đây 10 lần × `busy_timeout` 5s ⇒ `connect()` chặn **~56s**).
- Hết ngân sách ⇒ **BỎ QUA WAL**, chạy chế độ journal mặc định (vẫn đúng, chỉ kém song song) và
  **đi tiếp**; log warn **một lần** `store.wal_deferred`.
- `config.queue.initRetries` (`QUEUE_INIT_RETRIES`, mặc định 10) cho số lần thử của `Store.init()`
  (vẫn bị chặn thêm bởi `queue.lockTimeoutMs`).

## 8.3 B3 + R3 — số liệu và giới hạn (tài liệu)

- §22.7 của `docs/VERIFICATION.md` đã sửa: trần chờ liên tiến trình là
  **`số lần thử × lockTimeoutMs`** (không phải một lần), kèm số đo của phản biện (tệ nhất **31,5s**,
  trong tiến trình **30,4s**, đặt 300ms ⇒ **2,2s**) và cách giảm.
- **R3 (giới hạn của mô hình lease):** khi lease mất (SIGSTOP/máy ngủ), **hai tiến trình có thể
  THỰC THI cùng một mục** ⇒ chi phí provider có thể nhân đôi, dù tiền/trạng thái đã được fenced.
  Ghi rõ ở `docs/VERIFICATION.md` §22.7 mục 2 kèm 4 cách giảm (heartbeat dày hơn, `stale_ms` lớn
  hơn, **idempotency key phía provider**, chỉ gọi provider sau khi xác nhận còn lease).
