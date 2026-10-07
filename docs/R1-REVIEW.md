# SPRINT R1 — BÁO CÁO PHẢN BIỆN ĐỘC LẬP

**PHÁN QUYẾT: FAIL**

> Phản biện độc lập cho sprint R1 (`feat/r1-reliability`, commit `4b18e9a`).
> Mọi phép đo dưới đây do **agent phản biện tự chạy lại**, script ở `/tmp/r1-atk/`
> (không sửa một dòng mã nguồn nào; `git diff HEAD` rỗng trong suốt phiên).
> Mã nguồn R1 không đổi trong phiên: `src/**` mtime 18:20–18:35, commit `4b18e9a`
> (committer 18:58) — hash tại thời điểm đo:
> `queue.js c9aaf1b37be1c9e1 · store/index.js 7af2fca5589ab5ac · billing/index.js 49e60aa1c84283c2 · scheduler.js 71b75ffa2e909d05`.
> ⚠️ Ghi chú minh bạch: trong phiên, cây làm việc **có bị ghi thêm từ bên ngoài** —
> 4 file `test/r1-*.test.js` (1247 dòng) xuất hiện lúc 18:50–18:56 và commit được tạo 18:58.
> `npm test` lần đầu của tôi (trước đó) thu 929 test; ba lần sau đều thu **962 test**.
> Mọi kết luận dưới đây là về **mã nguồn**, không phải về bộ test.

---

## 0. Kết luận trả lời câu hỏi trung tâm

| Câu hỏi | Trả lời đo được |
|---|---|
| Nhiều tiến trình cùng nhặt việc ⇒ có nhặt trùng không? | **KHÔNG trùng** — 2 tiến trình × 200 mục: giao rỗng; PG `SKIP LOCKED`: 100/100 không trùng (SQLite + PG thật). |
| Tiến trình bị kill ⇒ có mất việc không? | **Không mất nếu có tiến trình KHỞI ĐỘNG LẠI** (`resume()`), nhưng **ĐÌNH TRỆ VÔ HẠN nếu chỉ còn tiến trình đang sống**: không ai poll DB, cron không nhặt mục `queued`, và mục `running` bị cron trả về `queued` rồi… không ai chạy (F3). |
| Có chạy trùng quá `max_attempts` không? | **CÓ, VÔ HẠN.** Kill lặp 8 vòng với `max_attempts=3` ⇒ handler chạy **8 lần**, `attempts=8`, mục **không bao giờ** thành `failed` (F1). Ngoài ra job dài hơn `stale_ms` bị **chạy song song** ở 2 tiến trình (F2). |
| Ví có sai tiền khi nhiều tiến trình không? | **KHÔNG sai tiền** — SQLite + PostgreSQL thật, 2 tiến trình × 100 thao tác trộn: số dư = tổng sổ, 0 dòng âm, `balance_after` liên tục, 0 lỗi khoá, mỗi lượt đúng 1 dòng đóng, không tạo/mất tiền. Nhưng **lỗi va chạm khoá unique bị báo sai mã** (F4) và **tiền có thể bị hoàn oan** khi bản chạy trùng thất bại (F2). |
| Cron có dọn trùng / hoàn tiền 2 lần không? | **KHÔNG** — 2 lần `runOnce()` chồng nhau và 2 tiến trình cùng bật cron đều chỉ hoàn tiền 1 lần/lượt; lỗi một bước không giết bước kia; `stop()` chờ nhịp dở; `intervalMs` 0/âm/NaN kẹp về 60000. |
| `/api/health` có lộ đường dẫn/bí mật? | **KHÔNG** — quét `resp_api_health.json`: 0 hit `/Users/`, `/tmp/`, `postgres://`, `sk-`, `password`, `.db`. |

---

## 1. Tóm tắt phát hiện

| # | Mức | Phát hiện | Bằng chứng (1 dòng) | Vì sao quan trọng | Gợi ý sửa |
|---|---|---|---|---|---|
| **F1** | **CAO** | **Vòng lặp crash vượt trần `max_attempts` vô hạn.** `requeueStaleJobs` trả mục `running` về `queued` **không kiểm `attempts`**, và `claimNextJob`/`claimQueueItem` **không có điều kiện `attempts < max_attempts`** ⇒ tiến trình chết lặp (OOM/deploy/crash-loop) làm mục chạy lại mãi mãi, không bao giờ `failed`. | `TỔNG số lần handler được gọi = 8 (max_attempts=3)` · `DB cuối: attempts=8, max_attempts=3, status=running` (`q3.out`) | Đốt tiền provider vô hạn (OCR/render/video), job người dùng treo `running` mãi, không có tín hiệu hỏng để hoàn tiền. Trái thẳng "không chạy trùng quá max_attempts" và §2.3. | `claimNextJob`: thêm `AND attempts < max_attempts`; `requeueStaleJobs`: chia 2 nhánh — `attempts + 1 < max_attempts` ⇒ `queued`, ngược lại ⇒ `failed` + `finished_at` (+ phát `failed` để job có `error_code`). |
| **F2** | **CAO** | **Mục `running` lâu hơn `stale_ms` bị cron "cướp" và CHẠY SONG SONG.** Không có heartbeat cập nhật `locked_at` trong lúc handler chạy; chủ cũ không biết mình mất mục nên vẫn chạy tới hết. | `A=[…857368..859870] B=[…858176..858878]` — B chạy **lọt trong** A cho **cùng một mục**, `attempts` nhảy 1→2 (`q4.out`) | Chạy trùng thật = gấp đôi chi phí provider, ghi đè asset/kết quả của nhau; nếu bản trùng `failed` thì hook hoàn tiền (`src/app.js:407-412`) trong khi bản gốc vẫn xong ⇒ **mất doanh thu**. Mặc định `stale_ms`=10 phút — job OCR/render/video dài hơn 10 phút là có thật. | (a) heartbeat `touchQueueItem(id, {lockedAt})` mỗi ~30s trong lúc chạy + `requeueStaleJobs` chỉ thu hồi khi `locked_at` quá cũ **và** không có heartbeat; (b) trước khi chạy lại mục bị thu hồi, xác nhận chủ cũ đã chết (cờ `cancel_requested`); (c) đặt `stale_ms` > thời lượng job tối đa và ghi rõ trong hợp đồng. |
| **F3** | **CAO** | **Việc "mồ côi" đình trệ vô hạn khi tiến trình giữ nó chết mà không có ai restart.** Không tiến trình nào poll DB để nhặt mục `queued`; cron chỉ `UPDATE` trạng thái `running`→`queued` rồi **không ai chạy**; chỉ `resume()` lúc boot mới cứu. | `DB sau khi A chết: job-0 running, job-1/job-2 queued` · `sau 6 nhịp cron: requeued=1 · B đã chạy được 0 việc` · `resume() ⇒ 3 việc chạy` (`q6.out`) | Trong triển khai nhiều tiến trình (đúng ca hợp đồng nhắm tới), tiến trình sống **không thể** cứu việc của tiến trình chết: job treo `running`/`queued` mãi, người dùng thấy vòng xoay vô tận, cron báo "đã dọn" nhưng thực tế không ai chạy ⇒ "không mất việc" chỉ đúng khi **có restart**. | Cho worker một nhịp `claimNextJob()` định kỳ (poll `queued` khi rảnh, ví dụ mỗi 1–5s), hoặc cho cron bước thứ 3: nhặt và chạy các mục `queued` không có chủ. Ghi rõ trong hợp đồng: "khôi phục cần ít nhất một tiến trình restart". |
| **F4** | **VỪA–CAO** | **Va chạm khoá unique của sổ bị báo SAI MÃ.** Đường "phục hồi thua cuộc đua" trong `holdForJob/settleForJob/refundForJob` không hoạt động: SQLite ⇒ `LEDGER_BUSY` (cờ `retryable:true` — lỗi **vĩnh viễn** bị báo thành **tạm thời**); PostgreSQL ⇒ `25P02` thô (`current transaction is aborted`) vì transaction đã abort nên câu SELECT phục hồi cũng lỗi. | `sqlite={"errCode":"LEDGER_BUSY"} · postgres={"errCode":"25P02"}` (cùng ca: hold lại một `(jobId, runKey)` đã đóng) — `l6.out`; workload PG 2 tiến trình: **15/100 thao tác** nổ `25P02` | Client được bảo "thử lại đi" cho một xung đột không bao giờ tự khỏi (503 lặp vô ích); trên PG mã driver thô (`25P02`) lọt ra tầng HTTP ⇒ 500, mất tính idempotent đã hứa theo `(job_id, run_key)`. | Ở `#callStore`: phân loại constraint **TRƯỚC** nhánh busy (đừng để `ERR_SQLITE_ERROR` khớp regex busy); trên PG: `SAVEPOINT` trước INSERT để rollback về savepoint rồi đọc lại sổ trong **cùng** transaction (không để transaction abort), hoặc dùng `INSERT ... ON CONFLICT DO NOTHING` + `SELECT`. |
| **F5** | **VỪA** | **Khoá sổ treo ⇒ nghẽn dây chuyền.** Trong **cùng tiến trình**: `#withMutex` không timeout ⇒ mọi transaction khác (user khác, `claimNextJob`, `appendLedger`) **đứng vĩnh viễn**. Khác tiến trình: chờ **25–32 giây** mới fail-closed. SQLite: "khoá theo user" thực chất là **khoá ghi toàn cục** — khoá ví chặn luôn hàng đợi. | `probe withLedgerLock(u1): 32476ms LEDGER_BUSY` · `claimNextJob: 32550ms QUEUE_BUSY` · `holdForJob(u2): 25057ms` · in-process: cả 3 probe `timeout after 6000ms` (`l3_hang`) | Một thao tác ví chậm/treo làm request người khác treo 25–32s (vượt timeout LB) và **đóng băng cả tiến trình** (kể cả cron, kể cả shutdown vì `stop()` chờ vô hạn). | Timeout cho `#withMutex`/`withLedgerLock` (ví dụ 2–3s ⇒ `LEDGER_BUSY`), giảm `busy_timeout` + số lần thử để tổng ≤ 3–5s; tài liệu hoá rõ: trên SQLite mọi transaction ghi là hàng đợi chung. |
| **F6** | **VỪA** | **§2.3 "idempotent theo `(jobId, handler)`" KHÔNG có trên đường chạy thật.** Mọi route gọi `queue.enqueue(id, fn)` **không truyền meta** ⇒ không có `runKey` ⇒ id mục ngẫu nhiên ⇒ 2 tiến trình enqueue cùng job+handler tạo **2 mục, chạy 2 lần**. | 2 tiến trình × 2 lần enqueue cùng `job-X`, không runKey ⇒ `job_queue=4 dòng · START=4` (`q5_dupkey`); cùng `runKey` ⇒ `rows=1, START=1` | Khoá liên tiến trình bằng PRIMARY KEY (điểm được quảng cáo trong commit) chỉ hoạt động nếu **người gọi truyền `runKey`**, mà `src/http/routes.js` không truyền (runKey chỉ nằm trong closure). Nghĩa là: không có chống trùng liên tiến trình cho bất kỳ route nào; chỉ còn chốt `claim` (cùng dòng). | Truyền `runKey` (từ hook tính tiền) vào `meta` của `queue.enqueue` cho các route có lượt chạy, hoặc sửa hợp đồng §2.3 cho đúng thực tế. |
| **F7** | **THẤP** | `runOnce()` gọi chồng **không bị chặn** (chỉ `tick()` có cờ `inFlight`); `intervalMs=1` vẫn tạo vòng lặp nóng (kẹp `>= 1`). Trên SQLite hậu quả tiền vẫn đúng; trên PG có thể nổ `25P02` (F4). | `runOnce #1={"reconciled":1} #2={"reconciled":1}` — tiền vẫn `90→100`, 1 dòng refund (`c1_cron`); `intervalMs=1 -> 1ms` | Cron gọi tay/2 tiến trình là ca hợp đồng §4; hiện an toàn nhờ idempotent của DB chứ không nhờ scheduler. | Cờ `inFlight` dùng chung cho cả `runOnce()`; kẹp `intervalMs >= 1000`. |
| **F8** | **THÔNG TIN** | Đường PostgreSQL mới của R1 **không được bộ test phủ**: `test/r1-*.test.js` **không có** `child_process`/`fork`/`spawn`/`SIGKILL` (0 hit) ⇒ không có ca 2 tiến trình thật; `max_attempts` chỉ được test qua đường handler ném lỗi (`r1-queue-durable.test.js:332`), không qua requeue/crash. | `grep -c "child_process\|fork(\|spawn(" test/r1-*.test.js` ⇒ 0 cho cả 4 file | DoD ghi "chứng minh bằng test + script 2 tiến trình thật": phần "script" có, phần "test" không. Vì thế F1/F2/F3 lọt qua bộ test xanh. | Thêm test: crash-loop quá `max_attempts`, cướp việc khi `stale_ms` nhỏ, mồ côi `queued` khi chỉ còn tiến trình sống; và ít nhất 1 test 2 tiến trình (fork) cho cả SQLite lẫn PG. |
| **F9** | **THẤP** | `job_queue` phình to **không** làm claim chậm vô hạn: 10k mục ⇒ 0,80ms/claim lúc đầu, 0,03ms lúc cuối. Kế hoạch có `USE TEMP B-TREE FOR ORDER BY` (index chỉ phủ `status`) — chấp nhận được ở 10k, sẽ đáng theo dõi ở 10⁶. | `100 đầu=0.800ms · giữa=0.390ms · cuối=0.030ms` + `EXPLAIN` (`q1.out`) | Không phải lỗi sprint này. | Thêm index `(status, created_at, id)` nếu hàng đợi thường > 100k mục. |

---

## 2. Chi tiết từng phát hiện (lệnh + output thật)

### F1 — Crash-loop vượt `max_attempts` (CAO)

Lệnh: `node /tmp/r1-atk/q3_crashloop.mjs` (1 mục `maxAttempts=3`; mỗi vòng: tiến trình mới boot → `resume()` → claim → handler treo → `kill -9`).

```
vòng 1: row={"job_id":"job-0","status":"running","attempts":1,"max_attempts":3}
vòng 2: row={"job_id":"job-0","status":"running","attempts":2,"max_attempts":3}
vòng 3: row={"job_id":"job-0","status":"running","attempts":3,"max_attempts":3}
vòng 4: row={"job_id":"job-0","status":"running","attempts":4,"max_attempts":3}
...
vòng 8: row={"job_id":"job-0","status":"running","attempts":8,"max_attempts":3}
TỔNG số lần handler được gọi = 8 (max_attempts=3)
DB cuối: [{"job_id":"job-0","status":"running","attempts":8,"max_attempts":3}] queueStats={"queued":0,"running":1,"done":0,"failed":0}
FAIL :: k3': handler không chạy quá max_attempts=3 :: thực tế=8
FAIL :: k3': sau khi hết lượt, mục phải 'failed' (không quay lại queued/running)
```

Nguyên nhân (đọc mã): `src/store/index.js:1836-1855` (`requeueStaleJobs`) không đọc `attempts`; `src/store/index.js:1727-1735` (`#claimQueueRow`) không có `attempts < max_attempts`. `failQueueItem` **có** kiểm trần, nhưng đường "tiến trình chết" không đi qua nó.
Cùng họ với F2 (đều do thiếu heartbeat/đếm trần ở đường requeue).

### F2 — Cướp việc ⇒ chạy song song (CAO)

Lệnh: `node /tmp/r1-atk/q4_steal.mjs` (A chạy job 2,5s; `stale_ms=500ms`; sau 750ms gọi `requeueStaleJobs({olderThanMs:500})` rồi tiến trình B `resume()` và claim).

```
DB lúc A đang chạy: [{"status":"running","attempts":1,"locked_by":"A"}]
sau requeueStaleJobs: {"requeued":1,"ids":["item-1"]} -> [{"status":"queued","attempts":1,"locked_by":null}]
  1791374857368 A-START job-1
  1791374858176 B-START job-1      ← B chạy trong lúc A vẫn đang chạy
  1791374858878 B-END job-1
  1791374859870 A-END job-1
A=[…857368..859870] B=[…858176..858878]
PASS :: HAI tiến trình chạy CÙNG một mục hàng đợi (chạy trùng)
DB cuối: [{"status":"done","attempts":2,"locked_by":null}]
```

Hệ quả tiền (đọc mã, không cần dựng lại toàn bộ app): `src/app.js:407-412` — `afterJob({status:'failed'})` ⇒ `refundForJob(...)`. Nếu bản chạy **trùng** thất bại (ví dụ mất mạng/provider lỗi), lượt bị **hoàn tiền**, còn bản gốc vẫn hoàn tất ⇒ khách nhận sản phẩm miễn phí; `settleForJob` sau đó bị chặn bởi "lượt đã có `job_refund` ⇒ không quyết toán lại" (`src/billing/index.js:1043-1045`).

### F3 — Việc mồ côi: tiến trình sống không cứu được (CAO)

Lệnh: `node /tmp/r1-atk/q6_orphan.mjs` (B sống từ trước, `resume()` lúc hàng đợi rỗng; A enqueue 3 việc rồi bị `kill -9`; B chạy 6 nhịp cron thật `requeueStaleJobs`).

```
B boot + resume(): {"durable":true,"requeued":0,"restored":0,"skipped":0}
DB sau khi A chết: [job-0 running/1, job-1 queued/0, job-2 queued/0]
sau 6 nhịp cron: requeued=1 · B đã chạy được 0 việc
DB: [job-0 queued/1, job-1 queued/0, job-2 queued/0]     ← cron trả về queued nhưng KHÔNG AI chạy
PASS :: B SỐNG không hề nhặt mục queued/running do A để lại (không có vòng poll DB)
PASS :: cron chỉ trả được mục running quá cũ về queued (không đụng mục queued)
--- khởi động lại ---
resume()={"restored":3} · tổng việc B chạy=3 · DB cuối: cả 3 done
```

### F4 — Va chạm unique bị báo sai mã (VỪA–CAO)

Lệnh: `node /tmp/r1-atk/l6_pg_rehold.mjs` (SQLite + PostgreSQL 16.15 thật, schema riêng `r1atk_rehold`; kịch bản: hold → refund → hold lại **cùng** `(jobId, runKey)`).

```
SQLite:
  3) hold lại CÙNG lượt: LỖI code=LEDGER_BUSY driver_code=LEDGER_BUSY msg=Sổ credit đang bận sau 0 lần thử lại…
  sổ: 3 dòng · job_hold=1 · balance={"amount":100,"currency":"USD"}
PostgreSQL THẬT:
  3) hold lại CÙNG lượt: LỖI code=25P02 driver_code=- msg=current transaction is aborted, commands ignored until end of transaction block
  sổ: 3 dòng · job_hold=1 · balance={"amount":100,"currency":"USD"}
SO SÁNH: sqlite={"errCode":"LEDGER_BUSY"} · postgres={"errCode":"25P02"}
```

Bằng chứng bổ trợ (workload trộn 2 tiến trình trên PG thật): `w2={"errors":15,"firstError":{"code":"25P02"}}` trong khi SQLite tương ứng chỉ có `skipped` và 0 lỗi.
Phân tích mã: `src/billing/index.js:461` khớp `SQLITE_ERROR` trong regex "bận" ⇒ lỗi `ERR_SQLITE_ERROR` của ràng buộc UNIQUE bị bọc thành `LEDGER_BUSY` **trước khi** `isUniqueLedgerViolation` (dòng 304-307) có cơ hội nhận ra; trên PG, INSERT lỗi làm abort transaction nên `#findRunRow` sau đó nổ `25P02`.
Ghi chú: **tiền vẫn đúng** (vẫn 1 dòng `job_hold`, số dư 100) — đây là lỗi mã lỗi/khả dụng, không phải mất tiền.

### F5 — Khoá treo ⇒ nghẽn dây chuyền (VỪA)

Lệnh: `node /tmp/r1-atk/l3_hang.mjs` (holder giữ `withLedgerLock('u1')` 90s).

```
probe withLedgerLock(u1): 32476ms · err=LEDGER_BUSY
probe claimNextJob khi ví u1 treo: 32550ms · err=QUEUE_BUSY      ← khoá VÍ chặn cả HÀNG ĐỢI
probe holdForJob(u2) trong lúc u1 treo: 25057ms · err=null       ← người dùng KHÁC chờ 25s
sau khi holder bị kill: vào lại được=true (0ms)                  ← hồi phục, không deadlock vĩnh viễn
--- cùng tiến trình (l3b_inproc) ---
{"otherUser":{"timeout":true,"ms":6002},"claim":{"timeout":true,"ms":6002},"appendLedger":{"timeout":true,"ms":6001}}
```

Đối chiếu PG (per-user thật): `withLedgerLock(user KHÁC) khi u-pg đang giữ khoá: 1ms · err=null` (`l4_pg`).

### F6 — Không có chống trùng liên tiến trình trên đường thật (VỪA)

Lệnh: `node /tmp/r1-atk/q5_dupkey.mjs`.

```
ĐÒN 1e — cùng runKey:  job_queue=1 dòng · START=1 · END=1        ← chống trùng TỐT
ĐÒN 1f — không runKey: job_queue=4 dòng · START=4 · END=4        ← 4 lượt enqueue ⇒ 4 lần chạy
```
Đối chiếu mã: `src/jobs/queue.js:358` — chỉ khi `entry.runKey` mới dùng id băm tất định; `src/http/routes.js` (các dòng 1920, 2069, 2245, 2511, 2634, 2743, 2905, 3027) gọi `queue.enqueue(id, fn)` **không kèm meta**.

### F7/F9 — Cron & kích thước hàng đợi

```
intervalMs=0 -> 60000 · -5 -> 60000 · NaN -> 60000 · 1 -> 1        (c1_cron)
runOnce chồng: #1={"reconciled":1} #2={"reconciled":1}; balance 90->100; job_refund=1 dòng  (tiền đúng)
lỗi 1 bước: {"reconciled":0,"requeued":1,"errors":1}               (bước sau vẫn chạy)
stop() giữa nhịp: chờ 1104ms, balance=100 (không cắt ngang transaction)
2 tiến trình cron: P1={"reconciled":5} P2={"reconciled":0}; job_refund=5 dòng; balance=100 (không hoàn 2 lần)
10k mục: 100 đầu=0.800ms/claim · giữa=0.390ms · cuối=0.030ms; EXPLAIN … USE TEMP B-TREE FOR ORDER BY
```

### Bộ test & hồi quy (số tự đo)

```
npm test (3 lần, có DATABASE_URL, PG 16.15 sống): tests 962 · pass 961 · fail 0 · skipped 1   (lần chạy ĐẦU của phiên: 929 · 928 · 0 · 1 — đúng như commit khai, khi test/r1-*.test.js chưa xuất hiện)
env -u DATABASE_URL npm test:                     tests 962 · pass 956 · fail 0 · skipped 6   (5 test PG bị skip)
node --test test/imagelab-concurrency.test.js:    2/2 pass · 0 fail
node --test test/mvp05-{billing,hook,anonymous,store,refund-retry}.test.js: 41/41 pass · 0 fail
node tools/verify.mjs:                            EXIT 0 (fail 0, skipped 1)
node tools/imagelab-demo.mjs:                     EXIT 0
init() hai lần trên DB cũ:                        dữ liệu nguyên vẹn; index job_queue đủ 3 + autoindex; 15 cột
QUEUE_DURABLE=false:                              durable=false · 0 dòng job_queue · hành vi cũ (bản trước R1 cũng không gộp trùng)
/api/health:                                      scheduler={enabled:true,running:true,ticks:12,…}; quét bí mật/đường dẫn: 0 hit
```

---

## 3. Đã cố phá mà KHÔNG phá được

1. **Nhặt trùng giữa 2 tiến trình** (SQLite 200 mục; PG thật 100 mục `SKIP LOCKED`): giao rỗng, không mục nào bỏ quên, 0 lỗi `QUEUE_BUSY`/`claimErrors`.
2. **Kill -9 trước claim / sau claim / giữa lúc chạy** rồi `resume()`: cả 5 job chạy xong, không mất việc, không đánh hỏng oan, hiệu ứng phụ chỉ lặp đúng 1 lần (at-least-once).
3. **Enqueue cùng `runKey` từ 2 tiến trình cùng lúc**: PRIMARY KEY chặn, đúng 1 mục, handler chạy 1 lần.
4. **`runAfter` tương lai/quá khứ; `max_attempts` 0/1/1e9**: tương lai không bị nhặt; 0 kẹp lên 1; 1e9 kẹp trần 100.
5. **Payload JSON hỏng / ký tự lạ (NUL, ESC, tiếng Việt, emoji)**: hydrate phòng thủ, không ném lỗi.
6. **Sai tiền khi 2 tiến trình ghi sổ** — SQLite (**2×100 thao tác trộn** + **100 vòng đua hold** + **100 vòng đua settle-vs-refund**) và **PostgreSQL thật** (2×100 thao tác trộn, 50 vòng đua): số dư = `SUM(amount)`, **0 dòng âm**, `balance_after` liên tục theo `seq`, **0 lỗi khoá**, mỗi `(job, run)` **đúng 1 dòng đóng**, không lượt nào bị giữ tiền 2 lần, không tạo/mất tiền. Đây là phần **chắc nhất** của sprint.
7. **`withLedgerLock`: rollback sạch** khi `fn` ném lỗi (không dòng nào ghi, số dư không nhảy, lỗi nghiệp vụ giữ nguyên mã); **lồng khoá cùng user** chạy đúng trong cùng transaction và rollback xoá cả dòng của tầng trong.
8. **Cron**: `runOnce()` chồng nhau, 2 tiến trình cùng cron ⇒ hoàn tiền đúng 1 lần/lượt; lỗi 1 bước không giết bước kia; `stop()` chờ nhịp dở, không cắt transaction; `intervalMs` 0/âm/NaN kẹp 60000; `enabled=false` không tạo timer.
9. **Hồi quy**: `imagelab-concurrency` xanh; MVP-05 (billing/hook/anonymous/store/refund-retry) 41/41 xanh; `verify.mjs` EXIT 0; `imagelab-demo.mjs` EXIT 0; `init()` 2 lần trên DB cũ nguyên dữ liệu; `QUEUE_DURABLE=false` không chạm DB và giữ đúng hành vi bộ nhớ cũ.
10. **`/api/health` không lộ** đường dẫn/bí mật (quét 763 byte JSON: 0 hit).

---

## 4. Chưa kiểm được / giới hạn

1. **Chưa đo end-to-end qua HTTP cho F2/F3** (dựng 2 server thật, tạo job qua API, `kill -9` một server, xem server kia có cứu việc). Tôi chỉ đo ở tầng `JobQueue`/`store` + đọc mã đường `app.js`/`routes.js`. Muốn chắc mức độ ảnh hưởng người dùng, cần thêm ca này.
2. **Chưa dựng lại được "hoàn tiền oan ⇒ sản phẩm miễn phí"** ở mức sổ cái trong app thật (cần pipeline ImageLab chạy thật + hook). Kết luận tiền của F2 hiện dựa trên **đọc mã** (`app.js:407-412`, `billing/index.js:1043-1045`) + hành vi sổ đã đo, không phải một giao dịch thật.
3. **Chưa đo `fsync`/mất dữ liệu khi mất điện** (không có `PRAGMA synchronous`, `wal_autocheckpoint`); chỉ đo kill -9 tiến trình.
4. **Chưa đo tải cao thật** (hàng trăm tiến trình, hàng triệu mục, PG có replication); các phép đo 2 tiến trình × 100–200 thao tác, 10k mục chỉ là quy mô nhỏ.
5. **Chưa kiểm PG ở chế độ `sslMode=require/verify-full`** hay pool cạn (`poolMax`) — ca "driver bận" mới đo qua SQLite `busy_timeout`.
6. **Chưa rà toàn bộ call-site `holdForJob`** để khẳng định F4 chạm được đường người dùng thật (tôi chỉ chứng minh nó chạm được qua API của `BillingService` và trong workload 2 tiến trình có truyền `runKey`).
7. **Nguồn gốc thay đổi giữa phiên**: 4 file `test/r1-*.test.js` xuất hiện lúc 18:50–18:56 và commit tạo lúc 18:58 trong khi tôi đang đo — tôi **không** xác minh được ai/việc gì ghi chúng (không phải tôi: `git diff HEAD` rỗng, tôi chỉ ghi `docs/R1-REVIEW.md`).

---

## 5. Việc cần làm trước khi coi R1 là "XONG"

1. **F1**: chặn trần trong `claimNextJob` + `requeueStaleJobs` (đk `attempts+1 < max_attempts`, hết lượt ⇒ `failed` + phát `failed`).
2. **F2**: heartbeat `locked_at` + chỉ thu hồi khi thật sự mất nhịp tim; hoặc tăng `stale_ms` mặc định và ghi rõ giới hạn.
3. **F3**: worker poll `claimNextJob` định kỳ (hoặc cron nhặt mục `queued` không chủ) — nếu không, DoD phải ghi "khôi phục cần restart".
4. **F4**: phân loại constraint trước nhánh busy (`#callStore`) + `SAVEPOINT`/`ON CONFLICT` cho PG.
5. **F5**: timeout cho `#withMutex`/khoá sổ; hạ tổng ngân sách chờ xuống ≤ 3–5s.
6. **F6 + F8**: truyền `runKey` vào `meta` ở các route, và bổ sung test 2 tiến trình thật (fork) cho cả SQLite lẫn PG, gồm 3 ca vừa phá được.

*Bằng chứng thô vòng 1: `/tmp/r1-atk/{q1,q2,q3,q4,q5,q6,l1_race,l2_lock,l3_hang,l4_pg,l5_race_err,l6_pg_rehold,c1_cron,r1_regression}.mjs` + `*.out`.*

═══════════════════════════════════════════════════════════════════════════════

# VÒNG 2 — CHẤM LẠI TẠI COMMIT `f1e75c5`

**PHÁN QUYẾT VÒNG 2: PASS CÓ ĐIỀU KIỆN**

> Chấm lại ĐỘC LẬP trên nhánh `feat/r1-reliability`, commit **`f1e75c5`** (PR #24).
> Script vòng 2: `/tmp/r1-atk2/**`; script vòng 1 + đối chứng: `/tmp/r1-atk/**`.
> `git diff HEAD` rỗng; **chỉ `docs/R1-REVIEW.md` được ghi** (không sửa mã nguồn/`test/**`).
> Hash mã nguồn tại thời điểm đo: `queue.js 66b57d5e3d0e6cf8 · store/index.js 3ab0207e755aef59 ·
> billing/index.js 2ddd96f06149e76f · scheduler.js fa67a49c2864770f · config.js fe9c4815ec9efd28 ·
> app.js 43fdfc6042b5e651 · routes.js 7cb724ec337fb277`.

## V2.1 — Sáu phát hiện vòng 1: đã vá thật hay chưa

| # | Kết luận vòng 2 | Bằng chứng đo lại (đọc SỐ LIỆU, không đọc lời khai) |
|---|---|---|
| **F1** | **ĐÃ VÁ THẬT** | `node /tmp/r1-atk/q3_crashloop.mjs`: kill -9 lặp 8 vòng với `max_attempts=3` ⇒ `TỔNG số lần handler được gọi = 3`, DB cuối `{"status":"failed","attempts":3,"max_attempts":3}`, `queueStats={"failed":1}` (vòng 1: 8 lần, `running/attempts=8`). PG thật (`a5_pg_multi.mjs`): claim→requeue→claim→requeue ⇒ `failed` + `finished_at`, claim kế tiếp `null`. |
| **F2** | **ĐÃ VÁ THẬT** (ca thường) | `q4_steal.mjs`: A đang chạy job 2,5s ⇒ `requeueStaleJobs` trả `{"requeued":0,"ids":[],"failed":0}`; log CHỈ có `A-START/A-END`, **không có `B-START`**; DB cuối `done/attempts=1` (vòng 1: B chạy lọt trong A, `attempts` 1→2). Còn khe **A3** (lease mất khi tiến trình bị treo). |
| **F3** | **ĐÃ VÁ THẬT** | `q6_orphan.mjs`: B sống (đã `resume()` lúc hàng đợi rỗng) + cron ⇒ **chạy 3/3 việc, KHÔNG cần restart** (vòng 1: 0/3). PG thật (`a5.2`): A bị `kill -9` để lại 1 `running` + 2 `queued` ⇒ B sống nhặt đủ **3/3**, DB cuối cả 3 `done`. `scheduler.runOnce()` báo thêm `claimed`. |
| **F4** | **ĐÃ VÁ THẬT** | `l6_pg_rehold.mjs` (DB sạch): SQLite **và PostgreSQL 16.15 thật** ⇒ `sqlite={"errCode":null,"holds":1,"balance":100} · postgres={"errCode":null,"holds":1,"balance":100}` (vòng 1: `LEDGER_BUSY` / `25P02`). `l5_race_err.mjs`: **0/100 lỗi** trên cả 2 driver (hold-race + settle-vs-refund), mỗi lượt đúng 1 dòng đóng. |
| **F5** | **VÁ MỘT PHẦN — VÁ SAI CÁCH (mã lỗi)** | Trong tiến trình nay CÓ trần: `a45` với `*_LOCK_TIMEOUT_MS=300` ⇒ `withLedgerLock(u2)` fail sau **325ms**; mặc định ⇒ **5033ms** (vòng 1: treo vĩnh viễn) — hết chặn vô hạn. NHƯNG mã trả ra là **`ERR_SQLITE_ERROR` THÔ** (không phải mã `retryable`), và mọi transaction khác trong tiến trình fail **0–1ms** cho tới khi người giữ commit ⇒ xem **A4**. Liên tiến trình KHÔNG được trần này bảo vệ: **32474ms** mới fail `LEDGER_BUSY` ⇒ xem **A5**. |
| **F6** | **ĐÃ VÁ THẬT 7/8 chỗ** | `grep -nE "queue\.enqueue\(|runKey: hold\?\.run_key|\{ runKey \}" src/http/routes.js` ⇒ 8 chỗ gọi `queue.enqueue`, **7 chỗ truyền `meta.runKey`**; còn **`POST /api/jobs/:id/regenerate` (dòng 2076–2078) CÓ `hold` nhưng KHÔNG truyền `runKey`** ⇒ đường chạy lại có thu tiền này vẫn không có chống trùng liên tiến trình. `q5_dupkey.mjs`: cùng `runKey` từ 2 tiến trình ⇒ **1 mục / 1 lần chạy**; KHÁC lượt (không runKey) ⇒ **2 mục / 2 lần** (không nuốt lượt đã trả tiền). Ghi chú hệ quả: 2 request ĐỒNG THỜI trên cùng job CÓ ví nay gộp thành MỘT lượt (khác kỳ vọng "2 lượt, 2 thu" của MVP-05 §BR-02) — tiền vẫn nhất quán (1 lượt = 1 thu); `test/imagelab-concurrency.test.js` vẫn 2/2 vì đường đó KHÔNG có ví (không truyền `runKey`). |

## V2.2 — Lỗ hổng MỚI phát hiện ở vòng 2

| # | Mức | Phát hiện | Bằng chứng (1 dòng) | Gợi ý sửa |
|---|---|---|---|---|
| **A1** | **VỪA–CAO** | **Boot đồng thời làm CHẾT tiến trình (SQLite).** `PRAGMA journal_mode = WAL` lỗi (`SQLITE_BUSY`) ⇒ `SqliteDriver.connect()` nuốt lỗi và **bỏ luôn `busy_timeout` + `foreign_keys`** ⇒ câu lệnh kế tiếp (`Store.init()` → `exec(schema)`) ném `database is locked` ⇒ tiến trình thoát. | `a1.1`: `busy_timeout={"timeout":0}`, DDL sau đó fail sau **0ms**. `a1.2`: 8 cặp boot đồng thời trên DB trắng ⇒ **6/16 tiến trình chết (38%)**; đối chứng DB đã init sẵn ⇒ **0/16** | Đặt `busy_timeout` TRƯỚC (hoặc `new DatabaseSync(file, { timeout: 5000 })`), bọc RIÊNG từng PRAGMA, retry chuyển WAL có giới hạn; cho `Store.init()` retry khi bận. (Gốc rễ có từ trước f1e75c5, nhưng đúng phạm vi "nhiều tiến trình" của R1.) |
| **A2** | **VỪA** | **"Mở lại" mục đã chạm trần ⇒ kẹt `queued` VĨNH VIỄN + nuốt lượt chạy lại.** `enqueueJob` nhánh revive KHÔNG reset `attempts`, còn claim mới đòi `attempts < max_attempts` ⇒ mục không ai nhặt được, không bao giờ `failed`; JobQueue vẫn phát `done(skipped=true)`; vòng poll nhặt lại mục rác này MỖI nhịp. | `a2_revive.mjs`: revive ⇒ `queued/attempts=2/2`, `claimNextJob` = `null`, `requeueStaleJobs` không cứu; JobQueue: enqueue lại cùng lượt ⇒ handler chạy thêm **0 lần**, `events=["done(skipped=true)"]`. `a23`: poll 200ms ⇒ **10 lần dựng handler + 10 sự kiện 'done' giả trong 2s**, handler thật 0 lần | Revive phải `attempts = 0` (mở lượt mới) hoặc chốt `failed` nếu giữ trần; `listQueueItems`/`pumpQueued` bỏ qua mục `attempts >= max_attempts` thay vì nhặt rồi phát `done` giả. |
| **A3** | **VỪA** | **Lease mất khi tiến trình bị TREO ⇒ vẫn chạy song song, và MẤT DOANH THU (đo ở SỔ CÁI).** Nhịp tim là timer ⇒ tiến trình bị treo (SIGSTOP ≡ máy ngủ/container pause/event loop bị chặn > nhịp tim) không gia hạn được ⇒ cron trả mục về `queued` ⇒ tiến trình khác nhặt và chạy; chủ cũ tỉnh dậy vẫn chạy tiếp. | `a3_lease_sigstop.mjs`: `requeued:1`, `A=[…315310..317811] B=[…316004..316004]` **chồng nhau**, DB cuối `done/attempts=2`. `a3.2` (BillingService thật): hold −10 → bản trùng thất bại ⇒ refund +10 → bản gốc thành công ⇒ `settleForJob` trả `job_refund` ⇒ **việc đã hoàn thành nhưng KHÔNG bị thu tiền: mất 10 credit/lượt trùng** | Fencing token/epoch trong `job_queue`: mỗi lần claim tăng epoch; `touchQueueItem`/`completeQueueItem` chỉ nhận epoch hiện tại; handler phải kiểm epoch trước khi ghi kết quả. (Mặc định `stale_ms=10 phút` làm ca này hiếm, nhưng `QUEUE_STALE_MS` hay được hạ.) |
| **A4** | **VỪA** | **Trần chờ khoá mới: mã lỗi THÔ + "fail nhanh" cho mọi việc khác trong tiến trình.** Khi hết `*_LOCK_TIMEOUT_MS`, `#withMutex` nhường chỗ trong khi transaction của người giữ VẪN MỞ trên cùng connection ⇒ lần thử kế tiếp đâm vào `BEGIN IMMEDIATE` lồng nhau ⇒ SQLite ném lỗi KHÔNG khớp regex "busy" ⇒ thoát thô, không retryable; mọi thao tác DB khác trong tiến trình fail 0–1ms cho tới khi người giữ commit. | `a45_poison_recover.mjs` (người giữ CHẬM 3s, timeout 300ms): `withLedgerLock(u2): 325ms LỖI ERR_SQLITE_ERROR` → `claimNextJob: 0ms LỖI ERR_SQLITE_ERROR` → `appendLedger: 0ms LỖI` → sau khi người giữ commit: `OK · inTx=false · balance=101` (hồi phục sạch) | Khi timeout: KHÔNG nhường mutex nếu transaction còn mở (hoặc đánh dấu connection "bẩn" chỉ mở lại sau COMMIT/ROLLBACK); chuẩn hoá `cannot start a transaction within a transaction` thành mã retryable. |
| **A5** | **VỪA** | **Trần timeout KHÔNG áp cho liên tiến trình.** `QUEUE/BILLING_LOCK_TIMEOUT_MS` chỉ chặn mutex/khoá-user TRONG tiến trình; chờ khoá ghi DB liên tiến trình vẫn do `busy_timeout=5000` cứng trong driver + 6 lần thử của `#retryOnBusy` quyết định. | `a4_lock_timeout.mjs` A4.3: tiến trình khác giữ khoá 60s ⇒ **32474ms** mới fail `LEDGER_BUSY` (vòng 1: 32384ms — gần như không đổi); với người giữ 7s thì chờ 7024ms rồi THÀNH CÔNG | Nếu quảng cáo "fail ≤2s" thì phải hạ cả `busy_timeout` (theo `lockTimeoutMs`) và số lần thử; nếu không, ghi rõ trong hợp đồng: trần chỉ có tác dụng trong tiến trình. |
| **A6** | **THẤP** | **`touchQueueItem(id)` KHÔNG truyền `workerId` gia hạn được lease của NGƯỜI KHÁC** (nhánh SQL bỏ điều kiện `locked_by`). JobQueue luôn truyền `workerId` nên chưa khai thác được từ app, nhưng là đường hở cho caller mới. | `a6_touch_forge.mjs`: `touch hộ (không workerId) => true`, `heartbeat_at` đổi, `locked_by` vẫn `worker-A`; `workerId` SAI ⇒ `false`; ĐÚNG ⇒ `true` | Bắt buộc `workerId` (fail-closed khi thiếu) — test `r1-fixes` hiện chỉ kiểm ca workerId SAI. |

## V2.3 — Đã cố phá mà KHÔNG phá được (vòng 2)

1. **F1**: kill -9 lặp 8 vòng (SQLite) và claim/requeue lặp (PG thật) ⇒ không vượt trần, chốt `failed` đúng.
2. **F2 ca thường**: job dài hơn `stale_ms` khi tiến trình còn sống (nhịp tim chạy) ⇒ `requeued:0`, không cướp được (chỉ phá được bằng SIGSTOP — A3).
3. **F3**: việc mồ côi trên SQLite (`q6`) và **PG thật** (`a5.2`), kể cả khi `pumpQueued`/cron chạy song song với `resume()`/`enqueue`.
4. **F4**: 2 tiến trình đua hold/settle/refund trên SQLite + PG: **0 lỗi**, không còn `25P02`/`LEDGER_BUSY` giả, mỗi lượt đúng 1 dòng đóng, số dư = tổng sổ, không tạo/mất tiền (`l1_race`, `l5_race_err`).
5. **Nhặt trùng**: 2 tiến trình × 200 mục (`q1`: `dup=0`, `unique=200/200`); PG `SKIP LOCKED` 100/100 (`l4_pg`).
6. **Cron**: 2 `runOnce()` chồng nhau + 2 tiến trình cùng cron ⇒ hoàn tiền đúng 1 lần/lượt; lỗi một bước không giết bước kia; `stop()` chờ nhịp dở; `intervalMs` 0/âm/NaN ⇒ 60000 (`c1_cron`).
7. **Hồi quy**: `npm test` **970 · 969 pass · 0 fail · 1 skipped**; `imagelab-concurrency` **2/2**; nhóm tiền/ẩn danh MVP-05 (billing, hook, anonymous, store, refund-retry, api, round2/3) **86/86**; `tools/verify.mjs` **EXIT 0**; `tools/imagelab-demo.mjs` **EXIT 0**; `init()` 2 lần trên DB cũ nguyên dữ liệu (index mới `idx_job_queue_status_created` + cột `heartbeat_at` xuất hiện đúng 15+1 cột); `QUEUE_DURABLE=false` không ghi dòng `job_queue` nào và giữ hành vi bộ nhớ cũ (tiền lệ trước R1 cũng không gộp trùng).
8. **`/api/health`** vẫn không lộ đường dẫn/bí mật; thêm `claimed`/`exhausted` đúng như hợp đồng.

## V2.4 — Chưa kiểm được (vòng 2)

1. **A3.2 chưa đo qua HTTP/app thật**: tôi đo chuỗi tiền bằng `BillingService` thật + `store` thật (không chỉ đọc mã), nhưng CHƯA dựng được ca "bản chạy trùng thất bại" bên trong pipeline thật để thấy hậu quả end-to-end (cần job ImageLab/Video chạy thật + hook).
2. **Lease/heartbeat trên PG dưới 2 tiến trình** chưa đo (mới đo SQLite SIGSTOP; PG mới đo F1/F3).
3. **A1 chưa đo trên PG** và chưa đo tần suất khi ≥3 tiến trình boot đồng thời / DB lớn (chỉ 8 cặp, DB trắng, macOS APFS).
4. **Chưa đo mất điện/fsync** (`synchronous`, `wal_autocheckpoint`) và chưa đo tải lớn (hàng nghìn mục, hàng chục worker, `pollMs` mỗi nhịp list 200 mục).
5. **Chưa xác minh ai ghi `test/r1-*.test.js` giữa phiên vòng 1** (không phải tôi) — cây làm việc bị ghi từ bên ngoài; `src/**` thì không đổi.

## V2.5 — PASS (có điều kiện) NGHĨA LÀ gì — và KHÔNG nghĩa là gì

**NGHĨA LÀ**: cả 6 phát hiện vòng 1 (F1…F6) đã được **vá thật và đo lại độc lập**, kể cả trên **PostgreSQL 16.15 thật**; câu hỏi trung tâm — "không mất việc, không chạy trùng, không sai tiền khi nhiều tiến trình / bị kill / driver bận" — nay đúng trong **các ca thường**: kill -9 (có nhịp tim), cron cướp việc, việc mồ côi, đua sổ cái 2 tiến trình, va chạm unique; bất biến tiền giữ nguyên; toàn bộ hồi quy xanh (970 test, verify EXIT 0).

**KHÔNG NGHĨA LÀ**:
1. **SQLite vẫn chỉ có MỘT khoá ghi toàn cục** — khoá ví chặn hàng đợi và ngược lại; trần timeout mới chỉ áp TRONG tiến trình (A5: liên tiến trình vẫn ~32s).
2. **Tham số theo request KHÔNG được lưu** (`manual`, `onlyRegionIds`, `force`, `options`…) ⇒ lượt khôi phục chạy bằng **mặc định an toàn**, không phải "chạy lại y hệt".
3. **Chống trùng liên tiến trình chỉ có khi caller truyền `runKey`** — routes nay đã truyền **7/8 chỗ** (còn `POST /api/jobs/:id/regenerate`), và code mới gọi `queue.enqueue` mà quên `runKey` là mất bảo vệ (và mở lại A2 nếu trùng khoá sau khi chạm trần).
4. **Chưa đo nhiều tiến trình PG cho lease/F2** (mới SQLite) và chưa đo mất điện/fsync, tải lớn.
5. **Còn 6 lỗ hổng vòng 2 chưa vá** (A1…A6) — trong đó A1 (38% tiến trình chết khi boot đồng thời trên DB trắng), A2 (mục kẹt vĩnh viễn + `done` giả mỗi nhịp), A3 (chạy song song + mất doanh thu khi lease mất) là ba việc nên vá trước khi coi R1 "XONG".

**Điều kiện để chuyển sang PASS đầy đủ**: vá A1 (init/PRAGMA), A2 (revive + bỏ qua mục chạm trần khi list), A3 (fencing/epoch hoặc từ chối chạy lại khi chưa xác nhận chủ cũ chết), A4 (mã lỗi chuẩn hoá + không nhường mutex khi transaction còn mở), và ghi rõ A5/A6 vào tài liệu vận hành.

*Bằng chứng thô vòng 2: `/tmp/r1-atk2/{a1_boot_race,a2_revive,a23_phantom_loop,a3_lease_sigstop,a4_lock_timeout,a44_poison,a45_poison_recover,a5_pg_multi,a6_touch_forge}.mjs` + `npmtest.out`, `l6_clean.out`, `r1reg.out`, `verify.out`, `demo.out`.*

═══════════════════════════════════════════════════════════════════════════════

# VÒNG 3 — CHẤM CUỐI TẠI COMMIT `0b29668`

**PHÁN QUYẾT CUỐI: PASS CÓ ĐIỀU KIỆN**

> Chấm cuối ĐỘC LẬP trên `feat/r1-reliability`, commit **`0b29668`** (PR #24).
> Script vòng 3: `/tmp/r1-atk3/**`; chạy lại toàn bộ `/tmp/r1-atk/**` (vòng 1) + `/tmp/r1-atk2/**` (vòng 2).
> `git status` chỉ có `docs/R1-REVIEW.md` bị sửa; không commit, không sửa mã nguồn/`test/**`.
> Hash mã nguồn khi đo: `queue.js a854ffec01219742 · store/index.js a86ba20017381310 ·
> billing/index.js 37783b1d2afcaac2 · sqlite-driver.js 120abfd57fd45527 · config.js fe9c4815ec9efd28 ·
> routes.js eda3a5f95d66ae7a`.

## V3.1 — Bảng A1…A6 và F1…F6 (đã vá thật hay chưa)

| # | Kết luận vòng 3 | Bằng chứng đo lại (số liệu, không đọc lời khai) |
|---|---|---|
| **A1** | **ĐÃ VÁ THẬT** | `a1_boot_race.mjs`: **0/16** tiến trình chết trên DB trắng (vòng 2: 6/16). `b3_boot4.mjs`: **4 tiến trình × 6 vòng = 0/24 chết**; DB đã có dữ liệu, 4 tiến trình × 4 vòng = **0/16 chết**, mục cũ còn nguyên `queued`. Tầng driver (B3.1): WAL bị chặn nhưng `busy_timeout=1200` VẪN được đặt (vòng 2: `timeout=0`), DDL chờ **1261ms** rồi mới báo bận (trước: 0ms). Còn **B2** (độ trễ boot). |
| **A2** | **ĐÃ VÁ THẬT** | `a2_revive.mjs`: revive ⇒ `attempts=0/2`, `claim` **NHẶT ĐƯỢC**, handler chạy thật 1 lần, `events=["done(skipped=false)"]`. `a23_phantom_loop.mjs`: poll 200ms trong 2s ⇒ **1 lần dựng handler + 1 lần chạy thật** (vòng 2: 10 `done` giả, 0 lần chạy). `b5_revive_cap.mjs` (`maxAttempts=1`, revive 3 lượt): mỗi lượt chạy đúng 1 lần, `attempts=1/1`, **0 mục vượt trần**, epoch 1→3→5. |
| **A3** | **ĐÃ VÁ THẬT** (fencing + tiền) | `b1_epoch.mjs`: A(epoch cũ).`complete`=**false**, B(epoch mới).`complete`=**true**; A.fail(epoch cũ) trả `{stale:true}`. `b4_fence_live.mjs` (thực chiến): SIGSTOP A → B cướp và **thất bại** → A tỉnh chốt `done` ⇒ log `A-EVENT skipped reason=stale_epoch`, DB giữ nguyên `failed/THIEF_FAILED/epoch=5`. Tiền (`a3_lease_sigstop.mjs`): hold −10 → refund +10 → `job_settle -10@rk-1#late` ⇒ **balance 90 = thu đúng 1 lần**. Còn **R3** (chạy trùng thể xác). |
| **A4** | **ĐÃ VÁ THẬT** | `a45_poison_recover.mjs` (người giữ chậm 3s, timeout 300ms): `withLedgerLock(u2)` → **2207ms `LEDGER_BUSY`** (vòng 2: `ERR_SQLITE_ERROR` thô), `claimNextJob` → **694ms OK** (chờ chủ xong rồi chạy, không fail dây chuyền), sau khi chủ commit: 0ms OK. `a44_poison.mjs`: `LEDGER_BUSY`/`QUEUE_BUSY` có `retryable`, **không còn mã thô**, `claimNextJob #2` → **1615ms OK**. |
| **A5** | **ĐÃ VÁ MỘT PHẦN** | Trần nay nằm ở tầng DB (`PRAGMA busy_timeout = queue.lockTimeoutMs`, PG `SET LOCAL lock_timeout/statement_timeout`) + ngân sách cho `init()`. NHƯNG worst case mặc định vẫn **31,5s** (`a4_lock_timeout.mjs` A4.3, người giữ 60s) và **30,4s** trong tiến trình (A4.1) — vì `#retryOnBusy` thử 6 lần × `busy_timeout` 5s; đặt `*_LOCK_TIMEOUT_MS=300` ⇒ **2,2s**. Tài liệu §22.7 ghi "~8,5s" (ca người giữ nhả trong cửa sổ) ⇒ xem **B3**. |
| **A6** | **ĐÃ VÁ THẬT** | `a6_touch_forge.mjs` + `b1.3`: `touchQueueItem(id, {})` (thiếu `workerId`) ⇒ **false** (vòng 2: true); `workerId` sai ⇒ false; đúng ⇒ true. |
| **F1** | ĐÃ VÁ (giữ nguyên) | `q3_crashloop.mjs`: kill -9 × 8 vòng, `max_attempts=3` ⇒ handler **3 lần**, DB cuối `failed/attempts=3`. PG thật (`a5_pg_multi.mjs`): chạm trần ⇒ `failed` + `finished_at`, claim sau `null`. |
| **F2** | ĐÃ VÁ (ca thường) | `q4_steal.mjs`: `requeued:0`, **không `B-START`**, DB cuối `done/attempts=1`. |
| **F3** | ĐÃ VÁ | `q6_orphan.mjs`: B sống chạy **3/3** việc không cần restart; PG thật (`a5.2`): **3/3**. |
| **F4** | ĐÃ VÁ | `l6_pg_rehold.mjs` (DB sạch): SQLite + PG16.15 ⇒ `errCode=null · holds=1 · balance=100`. `l5_race_err.mjs`: **0/100 lỗi** trên cả 2 driver, cả hold-race và settle-vs-refund. |
| **F5** | VÁ MỘT PHẦN | Mã lỗi đã đúng (`LEDGER_BUSY`/`QUEUE_BUSY` + `retryable`), hết "nhiễm độc" connection; trần mặc định vẫn ~30s (xem A5/B3). |
| **F6** | **ĐÃ VÁ THẬT 8/8** | `grep`: 8 `queue.enqueue` / **8 chỗ truyền `runKey`** (kể cả `POST /api/jobs/:id/regenerate` — vòng 2 còn thiếu). `q5_dupkey.mjs`: cùng `runKey` ⇒ **1 mục/1 lần**; khác lượt ⇒ 4 mục/4 lần (không nuốt lượt). |

## V3.2 — Lỗ hổng mới & tồn dư (đều nhỏ, không chặn)

| # | Mức | Phát hiện | Bằng chứng | Gợi ý sửa |
|---|---|---|---|---|
| **B1** | **VỪA** | **Fencing ở tầng store là TUỲ CHỌN.** `completeQueueItem(id)` **không truyền `epoch`** vẫn chốt được `done` cho mục đang thuộc runner KHÁC (`normalizeEpoch(null) === null` ⇒ bỏ điều kiện `AND epoch = ?`). Đường app luôn truyền epoch (`queue.js`) nên chưa khai thác được từ app — nhưng chốt chặn mà A3 dựng lên không được cưỡng chế. | `b1_epoch.mjs`: A epoch=1, B epoch=2 (đang giữ) ⇒ `complete KHÔNG epoch => true · status=done locked_by=null` | Bắt buộc `epoch` cho `complete/fail/touch` (fail-closed khi thiếu) — cùng cách A6 đã bắt buộc `workerId`; hoặc mặc định "phải khớp epoch hiện tại". |
| **B2** | **THẤP–VỪA** | **`connect()` có thể chặn ~56s khi boot.** WAL bị tiến trình khác giữ khoá ⇒ `#pragmaWithRetry` thử 10 lần, MỖI lần còn chịu `busy_timeout` (mặc định 5000ms) ⇒ tổng ~52–56s trước khi bỏ cuộc (không chết, `busy_timeout` vẫn đúng). Có thể vượt healthcheck/liveness khi boot trong container. | `b34_connect_latency.mjs`: `connect() mất **55777ms** · busy_timeout=5000`; với `lockTimeoutMs=1200` ⇒ 17852ms | Cho `#pragmaWithRetry` một NGÂN SÁCH TỔNG (như `init()`), và/hoặc hạ `busy_timeout` riêng cho lần chuyển WAL (ví dụ 200ms). |
| **B3** | **THẤP** | **Số liệu tài liệu lệch worst case.** §22.7 ghi "~8,5s" cho trần chờ khoá (đúng cho ca người giữ nhả trong cửa sổ) nhưng worst case đo được là **31,5s** (mặc định) / **2,2s** (khi `*_LOCK_TIMEOUT_MS=300`). | `a4_lock_timeout.mjs`: A4.3 `withLedgerLock ... 31531ms err=LEDGER_BUSY`; A4.2 `worst=2218ms` | Ghi công thức `retries × lockTimeoutMs` (và khuyến nghị hạ `QUEUE/BILLING_LOCK_TIMEOUT_MS` cho API có SLA). |
| **R3** | **THẤP (chấp nhận)** | **Lease mất ⇒ mục vẫn được HAI tiến trình THỰC THI** (tiền và trạng thái đã được fencing bảo vệ, nhưng chi phí provider có thể nhân đôi). Không tránh được nếu không huỷ được handler đang chạy. | `a3_lease_sigstop.mjs`: `A=[…930383..932884] B=[…931088..931088]` chồng nhau; `b4` cho thấy kết quả A bị bỏ | Handler tự kiểm epoch trước khi gọi provider/ghi kết quả, và/hoặc coi `stale_ms` là "chi phí chấp nhận". |

Tồn dư giữ nguyên từ vòng 1/2: SQLite chỉ có MỘT khoá ghi toàn cục (khoá ví chặn hàng đợi và ngược lại); tham số theo request (`manual`, `onlyRegionIds`, `force`, `options`…) không được lưu ⇒ lượt khôi phục chạy bằng mặc định an toàn; chống trùng liên tiến trình chỉ có khi caller truyền `runKey`.

## V3.3 — Đã cố phá mà KHÔNG phá được (vòng 3)

1. **Quyết toán muộn (`<runKey>#late`) — 6 đòn, không đòn nào thu hai lần / tạo tiền** (`b2_late_settle.mjs`): (a) hold→refund→settle ⇒ `balance 90`, đúng 1 dòng late; (b) gọi settle lại ⇒ idempotent, vẫn 90; (c) 3 lượt liên tiếp bị cướp ⇒ `70` (mỗi lượt thu 1 lần); (d) job `failed` ⇒ TỪ CHỐI (vẫn 70); (e) ví cạn với chi phí 1e6 ⇒ `INSUFFICIENT_CREDIT`, **0 dòng âm**, SUM không đổi; (f) **2 tiến trình cùng** quyết toán muộn ⇒ đúng **1 dòng `rk-r#late`**, `balance=90=SUM`, 0 lỗi.
2. **Fencing**: epoch cũ không chốt được `done`/`failed`; kẻ cướp thất bại giữ nguyên kết cục; chủ cũ nhận `skipped(stale_epoch)` thay vì `done`.
3. **Boot**: 4 tiến trình × 6 vòng trên DB trắng (0/24 chết), DB có dữ liệu 4×4 (0/16 chết, dữ liệu nguyên), boot lặp nhiều lần.
4. **F1–F4 + A6** trên SQLite **và PostgreSQL 16.15 thật**; nhặt trùng 200/100 mục; mồ côi SQLite + PG.
5. **Hồi quy**: `npm test` **977 · 976 pass · 0 fail · 1 skipped**; `tools/verify.mjs` **EXIT 0**; `tools/imagelab-demo.mjs` **EXIT 0**; `imagelab-concurrency` **2/2**; nhóm tiền/ẩn danh MVP-05 **86/86**; `init()` 2 lần nguyên dữ liệu; `QUEUE_DURABLE=false` không chạm DB.

## V3.4 — Chưa kiểm được (vòng 3)

1. **Chưa đo HTTP/app thật** cho chuỗi "bị cướp → hoàn tiền → thu muộn" trong pipeline ImageLab/Video (mới đo ở `BillingService` + `JobQueue` thật, không phải end-to-end qua route).
2. **Chưa đo PG cho lease/epoch dưới 2 tiến trình** (SIGSTOP/fencing mới trên SQLite; PG mới đo F1/F3 + sổ cái).
3. **Chưa đo mất điện/fsync**, tải lớn (hàng nghìn mục, nhiều worker) và chi phí CPU/DB của vòng poll 1s khi hàng đợi lớn.
4. **Chưa đo A1/B2 trong container** (volume mạng, k8s liveness): con số 55,8s là trên APFS cục bộ.

## V3.5 — PASS (có điều kiện) NGHĨA LÀ gì — và KHÔNG nghĩa là gì

**NGHĨA LÀ**: bốn điều kiện của vòng 2 (**A1, A2, A3, A4**) đã được **vá thật và đo lại độc lập**; A5/A6 vá một phần/đủ và đã ghi tài liệu; **F1…F6 đều xanh trên cả SQLite lẫn PostgreSQL thật**; tiền đúng trong MỌI đòn tôi thử (kể cả quyết toán muộn, ví cạn, 2 tiến trình đua, các lượt bị cướp liên tiếp) — số dư luôn = tổng sổ, không dòng âm, không tạo/mất tiền; hồi quy **977 test · 0 fail** + `verify` EXIT 0.

**KHÔNG NGHĨA LÀ**:
1. **SQLite vẫn chỉ có MỘT khoá ghi toàn cục** — khoá ví chặn hàng đợi và ngược lại; trần timeout chỉ có tác dụng thật khi hạ `QUEUE/BILLING_LOCK_TIMEOUT_MS` (mặc định worst case ~30s).
2. **Tham số theo request KHÔNG được lưu** (`manual`, `onlyRegionIds`, `force`, `options`…) ⇒ lượt khôi phục chạy bằng mặc định an toàn, không phải "chạy lại y hệt".
3. **Chống trùng liên tiến trình chỉ có khi caller truyền `runKey`** — nay 8/8 routes đã truyền, nhưng code mới gọi `queue.enqueue` mà quên `runKey` là mất bảo vệ.
4. **Lease mất vẫn cho phép hai tiến trình THỰC THI** cùng một mục (tiền/trạng thái đã fenced) ⇒ chi phí provider có thể nhân đôi (R3).
5. **Fencing ở tầng store là tuỳ chọn** — caller không truyền `epoch` sẽ bỏ qua chốt chặn (B1).
6. **Boot có thể chậm tới ~56s** khi WAL bị chặn ở cấu hình mặc định (B2) — cần để ý healthcheck.
7. **Chưa đo** nhiều tiến trình PG cho lease, mất điện/fsync, tải lớn (V3.4).

**Ba việc nhỏ còn lại (không chặn sprint)**: B1 — bắt buộc `epoch` cho `complete/fail/touch`; B2 — ngân sách tổng cho `#pragmaWithRetry`; B3 — ghi worst case `retries × lockTimeoutMs` vào `docs/VERIFICATION.md` §22.7. Nếu đội chấp nhận ba mục này như giới hạn đã ghi tài liệu (và R3 là chi phí chấp nhận của mô hình lease), thì R1 có thể đọc là **PASS**.

*Bằng chứng thô vòng 3: `/tmp/r1-atk3/{b1_epoch,b2_late_settle,b3_boot4,b34_connect_latency,b4_fence_live,b5_revive_cap,late_worker,fence_worker}.mjs` + `npmtest.out`, `verify.out`, `demo.out`; chạy lại `/tmp/r1-atk/{q3,q4,q5,q6,l5,l6}.mjs` và `/tmp/r1-atk2/{a1,a2,a23,a3,a4,a45,a44,a5,a6}*.mjs`.*
