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

*Bằng chứng thô: `/tmp/r1-atk/{q1,q2,q3,q4,q5,q6,l1_race,l2_lock,l3_hang,l4_pg,l5_race_err,l6_pg_rehold,c1_cron,r1_regression}.mjs` + `*.out`.*
