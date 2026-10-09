# PG-MONEY-REVIEW — phản biện ĐỘC LẬP bản vá TIỀN trên PostgreSQL (PR #28 · `thanhbn123/pg-coverage`)

**Người phản biện:** agent phản biện độc lập (không sửa mã nguồn, không `git add/commit/checkout`).
**Ngày đo:** 2026-10-09 · **Máy:** macOS arm64, không Docker, PostgreSQL 16.15 (Homebrew) dựng bằng `initdb`/`pg_ctl`.

## 0. Phán quyết

**PASS CÓ ĐIỀU KIỆN.** Bản vá **bịt được lỗi tiền thật** (đo được cả trước và sau), migration trên DB cũ
**chạy đúng, idempotent, giữ nguyên dữ liệu**, 29 test mới **chạy thật trên PostgreSQL** và **bắt được**
đúng lỗi mà nó nhắm tới, hồi quy SQLite/PG đều xanh.

Ba điều kiện còn lại (không chặn merge, nhưng phải biết):

| # | Mức | Vấn đề |
|---|---|---|
| **F1** | **TRUNG BÌNH** | `#widenMoneyColumns()` **im lặng bỏ qua** khi bảng không nằm trong schema `public` (search_path khác) — **không một dòng log**, app boot bình thường và **tiếp tục chạy miễn phí với `float4`** (đo được: ví 10.000 + 1 lượt giá 0.0004 ⇒ số dư **20000**, 0/4 cột được nới). |
| **F2** | **THẤP** | Không có test nào **tự động** phủ đường migration: tắt hẳn `#widenMoneyColumns()` ⇒ **29/29 test vẫn pass** (đo được). Đường migration chỉ được chứng minh bằng tay (§25.4) hoặc khi trỏ suite vào DB dựng bằng schema CŨ. |
| **F3** | **THẤP** | Trần 6 chữ số của `float8` là **9.007.199.254 credit** (`2^53/1e6`). Trần một lệnh cấp là 1e9 ⇒ **~9 lệnh cấp trần** là vượt; từ đó tiền lại sai (đo: số dư 1e11, 1.000 lượt trừ 0.0004 ⇒ lệch **2,83e-3**). Ngoài dải "thực tế" mà bản vá tự khai (0.0004 … 1e9) nhưng **không có chặn nào ở tầng số dư**. |

---

## 1. Phạm vi đo & cách tiếp cận

* Cây làm việc hiện tại đang ở **`feat/export-hardening`** (KHÔNG chứa `bee8ecb`); luật cứng cấm `git checkout`
  ⇒ bản vá được trích **chỉ đọc** từ git object:
  ```
  $ git log -1 bee8ecb^        → f8d96a3  (đúng mẹo: PR rebase trên develop)
  $ git archive thanhbn123/pg-coverage | tar -x -C /tmp/pgmoney-atk/pr28
  $ git clone --no-hardlinks --branch thanhbn123/pg-coverage <repo> /tmp/pgmoney-atk/full2   # bản sao CÓ .git (test deploy cần .git)
  ```
  Repo gốc **không bị sửa** (`git status --short` ⇒ trống; chỉ thêm đúng file này).
* PostgreSQL cục bộ (máy không Docker). Hai cổng 55432/55440 **đã bị cụm PG của worker trước chiếm**, nên
  reviewer dựng cụm riêng ở **55901** + **socket dir ngắn** (đường scratchpad > 103 byte sẽ làm `pg_ctl` chết):
  ```
  $ initdb -D /tmp/pgmoney-atk/pgdata -U postgres --encoding=UTF8 --locale=C
  $ pg_ctl -D /tmp/pgmoney-atk/pgdata -o "-p 55901 -k /tmp/pgmoney-atk/pgsock -c listen_addresses=127.0.0.1" -l …/pg.log start
  $ psql … -tAc "select version();" → PostgreSQL 16.15 (Homebrew) on aarch64-apple-darwin25.6.0
  ```
* Script tấn công: `/tmp/pgmoney-atk/pr28/.atk/*.mjs`; output thô: `/tmp/pgmoney-atk/out-*.txt`.

---

## 2. A1 — ĐÚNG ĐẮN CỦA KIỂU TIỀN (`out-01-types.txt`, `out-02-boundary.txt`)

### 2.1 Lỗi CŨ là thật (đo lại được trên `real` = float4)

```
10000::real            - 0.0004::real            = 10000        ← số dư KHÔNG ĐỔI (chạy miễn phí)
10000::double precision- 0.0004::double precision= 9999.9996    ← đúng
99.999999::real = 100      |  99.999999::double precision = 99.999999
100000::real - 0.004::real = 99999.99 (đúng 99999.996)
```
Qua **store thật** (mutation M1 = quay lại đúng bản chưa vá, xem §5) test tiền của họ đỏ đúng thông điệp:
```
AssertionError: trừ đúng 1 đơn vị tiền nhỏ nhất (MONEY_EPSILON):
  PostgreSQL trả 100 nhưng phải là 99.999999 (SQLite: 99.999999)
```

### 2.2 Tích luỹ 100.000 lần (câu hỏi trọng tâm: sai số tích luỹ)

```
chính xác (NUMERIC)      = 40.0000
PG double precision      = 39.99999999996013   sai lệch -3,99e-11  → roundMoney ⇒ 40 (ĐÚNG)
SQLite REAL              = 40                  (SQLite dùng cộng bù Kahan)
PG real (float4, BẢN CŨ) = 40.02524            sai lệch +2,52e-2   → SAI 25.000 đơn vị tiền nhỏ nhất
```
Mô phỏng đúng thuật toán của store (`roundMoney` mỗi bước, 100.000 lượt trừ 0.0004):
```
start=10.000     → 9960            (đúng)   |   start=1e9   → 999999960        (đúng)
start=1e6        → 999960          (đúng)   |   start=1e11  → 99999999960,28279 (đúng 99999999960 ⇒ LỆCH 0,283)
```
Cực nhỏ / cực lớn / âm / `0.1+0.2`:
```
1e-9 float8 = 1e-9 (giữ)   |  1e9+0.0004 = 1000000000.0004 (giữ)  |  -1e9+0.0004 = -999999999.9996 (giữ)
0.1+0.2 float8 = 0.30000000000000004 → roundMoney = 0.3 (đúng)
```
Biên: `2^53/1e6 = 9007199254.74099000` ⇒ **dưới ~9,007e9 credit thì 6 chữ số thập phân còn nguyên**
(ở 1e10, `+1e-6` bị nuốt: Δ = 1,907e-6).

### 2.3 So TỪNG DÒNG SQLite ↔ PostgreSQL (cùng dữ liệu, 500 giá trị 6 chữ số)

```
PG     sum=4332.4764069999965  roundMoney=4332.476407
SQLite sum=4332.476407000001   roundMoney=4332.476407
JS tuần tự = 4332.4764069999965 roundMoney=4332.476407
NUMERIC chính xác = 4332.476407      ⇒ PG và SQLite KHỚP sau làm tròn (khác thô 3,5e-12 — vô hại)
```
**Kết luận A1:** `DOUBLE PRECISION` giữ đủ 6 chữ số thập phân trong toàn bộ dải thực tế của repo
(0,000001 … 1e9) và khớp SQLite; chỉ vỡ ở số dư > 9,007e9 (F3).

---

## 3. A2 — MIGRATION `widenMoneyColumns()` (`out-03-migration.txt`)

### 3.1 DB CŨ có dữ liệu (schema `develop` = cột tiền `real`) → deploy bản vá

```
[trước init] pricing.unit_price=real  usage_events.estimated_cost=real  wallet_ledger.amount=real  wallet_ledger.balance_after=real
init #1 → dialect=postgres
[sau init #1] cả 4 cột = double precision          (log: 4 dòng money_column_widened)
init #2 OK · init #3 OK                            (không ALTER lại — IDEMPOTENT)
dữ liệu cũ sau migration: amount 10000 giữ nguyên; -0.0004 giữ nguyên giá trị float4 cũ
số dư theo SUM = 9999.9996
ví MỚI 10.000 + hold 0.0004 + settle 0.0004 ⇒ số dư 9999.9996  ⇒ THU ĐƯỢC TIỀN
```
Thuộc tính cột sau khi nới kiểu còn nguyên: `amount/balance_after` vẫn `NOT NULL`.
**Boot 3 tiến trình ĐỒNG THỜI trên DB cũ** (`out-12-concurrent.txt`: 2.000 dòng sổ):
```
3 tiến trình boot song song mất 33ms — cả 3 OK, số dư đọc được = 20000000
dữ liệu sau: 2000 dòng, tổng 20000000 (không mất dòng nào) · cả 4 cột = double precision
```

### 3.2 HAI ĐƯỜNG LÀM MIGRATION IM LẶNG THẤT BẠI

**(a) Bảng ngoài schema `public` — `out-04-failopen.txt` (F1, TRUNG BÌNH).** Truy vấn `information_schema`
lọc cứng `table_schema = 'public'`. DB có `search_path = app` (triển khai tách schema / DBA đặt `search_path`):
```
[trước init] cả 4 cột = real
số dư sau khi chạy 1 lượt giá 0.0004 = 20000   ⇒ ⚠️ CHẠY MIỄN PHÍ (khoản thu bị nuốt)
[sau init]  cả 4 cột VẪN = real — số cột được nới = 0/4
log migration khi boot: []            ← KHÔNG một dòng log ⇒ không ai biết
```

**(b) Thiếu quyền `ALTER` (không phải chủ bảng).**
* Nếu **bất kỳ** bảng nào trong danh sách `ADD COLUMN IF NOT EXISTS` không thuộc role app thì `init()`
  **chết sớm** (fail-closed) — đo được: `must be owner of table jobs`. (Lưu ý: PG kiểm quyền **trước** khi
  thấy cột đã tồn tại — đã kiểm chứng bằng `ALTER TABLE … ADD COLUMN IF NOT EXISTS <cột đã có>`.)
* Nếu **chỉ `pricing`** không thuộc role app (`out-14-perm-pricing.txt`) thì `init()` **đi qua**, ví vẫn đúng
  (`9999.9996`), nhưng:
  ```
  pricing.unit_price=real   (3 cột kia = double precision)
  log: store.migration.money_widen_skipped {"table":"pricing","column":"unit_price","error":"must be owner of table pricing"}
  ```
  ⇒ **fail-open một phần, có log**. Hại thấp: `unit_price` là giá trị đơn lẻ (sai số tương đối ~5e-8),
  không phải phép trừ số dư như `wallet_ledger.amount` (nơi float4 gây triệt tiêu).

**(c) Dòng sổ CŨ sau migration (F3 nhỏ, `out-03`).** Dòng cũ giữ `balance_after = 10000` trong khi
`SUM(amount)` mới = `9999.9996` ⇒ **bất biến "balance_after dòng mới nhất === số dư" bị VỠ trên DB nâng cấp**
(lệch 0,0004 = đúng khoản đã bị float4 nuốt trước đó). Không test nào phủ ca này; hướng lệch là hướng
"còn nợ tiền" nên không thất thoát thêm, nhưng màn đối soát sẽ thấy lệch.

---

## 4. A3 — SCHEMA DÙNG CHUNG HAI DRIVER + RÀ CỘT `REAL` CÒN LẠI (`out-05-sqlite.txt`)

```
SQLite nhận `DOUBLE PRECISION`: wallet_ledger.amount:DOUBLE PRECISION ... typeof(amount)='real' (REAL affinity)
ghi/đọc lại 0.0004 và 9999.9996 ⇒ 'real', đúng từng chữ số
DB SQLite dựng bằng schema CŨ (REAL) ⇒ vẫn đúng (SQLite REAL = float8), bản vá không đụng gì (isPostgres=false)
```
Rà cả `schema.sql` + `information_schema` của DB thật — cột `REAL` còn lại **chỉ là hình học/độ tin cậy**,
KHÔNG phải tiền:
```
ocr_regions.x_norm|y_norm|w_norm|h_norm|confidence = real ; translation_lines.confidence = real
4 cột tiền (wallet_ledger.amount, wallet_ledger.balance_after, usage_events.estimated_cost, pricing.unit_price) = double precision
```
Không có cột tiền nào được thêm bằng migration trong mã JS (mọi `#addColumnIfMissing` là TEXT/INTEGER) ⇒
**danh sách 4 cột của `MONEY_COLUMNS` là đủ**.

---

## 5. A4 — 29 TEST MỚI CÓ CHẠY THẬT KHÔNG? (`out-*` §5)

```
$ env -u DATABASE_URL node --test test/pg-{wallet,queue,schema}.test.js
ℹ tests 29 · pass 0 · fail 0 · skipped 29     ← BỎ QUA CÓ KIỂM SOÁT (không fail, không "pass" giả)

$ DATABASE_URL=postgres://studio:***@127.0.0.1:55901/studio node --test --test-concurrency=1 test/pg-*.test.js
ℹ tests 29 · pass 29 · fail 0 · skipped 0     ← CHẠY THẬT (gồm "TIỀN … KHÔNG ĐƯỢC MẤT CHỮ SỐ")
```
**Kiểm chứng bằng mutation** (bản sao ở `/tmp`, không sửa repo):

| Mutation | Kết quả | Ý nghĩa |
|---|---|---|
| **M1** = đúng bản CHƯA vá (schema `REAL`, không nới kiểu), DB trắng | **fail 1/9** — đúng test tiền | Test **bắt được** lỗi mà nó nhắm tới |
| **M2** = schema vá nhưng `#widenMoneyColumns()` bị vô hiệu hoá, DB trắng | **29/29 pass** | ❗ Suite **KHÔNG** phủ đường migration (F2) |
| M2 trỏ vào DB dựng bằng schema CŨ (`atk_oldflow2`) | **fail 1/9** — đúng test tiền | Nếu trỏ đúng DB cũ thì suite bắt được |
| Bản vá thật trỏ vào DB dựng bằng schema CŨ (`atk_oldflow`) | **29/29 pass** | Đường migration chạy đúng end-to-end |

---

## 6. A5 — BẤT BIẾN TIỀN TRÊN POSTGRESQL VỚI BẢN VÁ (`out-07-invariants.txt`, `out-13-differential.txt`)

Script độc lập (`/tmp/pgmoney-atk/pr28/.atk/06-pg-invariants.mjs`), không dùng test của họ:

```
ví 10.000 + 1 lượt 0.0004: số dư SQL = tổng sổ JS = 9999.9996 · không âm · balance_after dòng cuối = số dư
chi vượt số dư ⇒ INSUFFICIENT_CREDIT (sổ không đổi, không âm)
hold 2 lần cùng (job_id, run_key) ⇒ ĐÚNG 1 dòng job_hold
ĐUA settle+refund cùng lượt ⇒ ĐÚNG 1 dòng đóng: closes=["job_settle/settle=0.75"], số dư = 4.75 = 5-1+0.75
reconcile lượt treo (stuckRunMs=1s): lượt mới = 0 thu hồi · lượt quá hạn = 1 thu hồi (hoàn 0.5) · gọi lại = 0 (idempotent)
```
**Differential 200 lượt** (giá ngẫu nhiên 6 chữ số, ví 1.000.000) — SQLite vs PG:
```
SQLite: 401 dòng, số dư cuối 999900.898726
PG    : 401 dòng, số dư cuối 999900.898726      → dòng khác nhau: 0/401
tổng đã thu (Σ job_hold) = 99.101274  ⇒ 1.000.000 − 99.101274 = 999.900,898726 = số dư (ĐÚNG TỪNG CHỮ SỐ)
```
Script cũ `/tmp/mvp05-atk4/v4-pg-reconcile.mjs` (đã trỏ lại cây bản vá, `out-06-v4.txt`) chạy được trên PG;
lưu ý **script cũ đã lệch cấu hình**: nó đặt `BILLING_STUCK_RUN_MS=1000` nhưng bản hiện tại có **sàn**
`BILLING_MIN_STUCK_RUN_MS=60000` ⇒ `older=60000`, nên phần "thu hồi lượt treo" của script cũ không còn
đúng kỳ vọng (không phải lỗi bản vá tiền). Đặt đúng cả hai khoá (script §6) thì thu hồi chạy đúng.

---

## 7. A6 — HỒI QUY

Chạy trong **bản clone có `.git`** (`/tmp/pgmoney-atk/full2`, nhánh `thanhbn123/pg-coverage`, cây sạch):
```
$ env -u DATABASE_URL npm test                      → EXIT 0 · tests 1098 · pass 1063 · fail 0 · skipped 35
$ env -u DATABASE_URL node tools/verify.mjs         → EXIT 0 · tests 1098 · pass 1063 · fail 0 · skipped 35
$ DATABASE_URL=postgres://…:55901/studio npm test   → EXIT 0 · tests 1098 · pass 1097 · fail 0 · skipped 1
```
Khớp **chính xác** con số §25.2 của tác giả. (Cảnh báo cho vòng sau: chạy suite trong cây `git archive`
KHÔNG có `.git` sẽ đỏ oan 2 test — `deploy-scripts.test.js` cần `.git`, và `mvp04-multi-scene` treo/ECONNRESET
khi chạy song song với tải nặng; không liên quan bản vá tiền.)

---

## 8. ĐỀ XUẤT (không bắt buộc để merge)

1. **F1:** bỏ lọc cứng `table_schema='public'` — dùng `to_regclass('wallet_ledger')` /
   `information_schema.columns WHERE table_name = ? AND table_schema = ANY(current_schemas(false))`,
   và **fail-closed có kiểm soát**: nếu sau vòng lặp vẫn còn cột tiền `real` ⇒ ném lỗi chặn boot (hoặc
   ghi log `error` + cờ `/api/health`), thay vì `warn` rồi chạy tiếp với `float4`.
2. **F2:** thêm 1 test dựng bảng bằng DDL `REAL` (DB riêng) rồi `init()` và khẳng định `data_type` của
   **cả 4** cột = `double precision` — hiện **không** test nào khẳng định kiểu cột (chỉ khẳng định tên cột).
3. **F3:** chặn trần số dư (hoặc chuyển `wallet_ledger.amount/balance_after` sang `NUMERIC(20,6)` trên PG —
   SQLite vẫn REAL affinity nên file schema dùng chung được), hoặc ghi rõ trần 9,007e9 trong hợp đồng.
4. **Vận hành:** `ALTER COLUMN … TYPE` viết lại bảng + khoá `ACCESS EXCLUSIVE`; chưa đặt `lock_timeout`.
   Với sổ lớn, boot có thể chặn lâu — nên chạy migration thành bước riêng (`node src/store/migrate.js`) và
   đặt `lock_timeout`/`statement_timeout` cho riêng bước đó.

## 9. CHƯA ĐO ĐƯỢC (đừng ghi là đã đo)

* **Bảng tiền RẤT LỚN**: mới đo 2.000 dòng (33ms cho 3 tiến trình). Thời gian/khoá của `ALTER … TYPE`
  trên sổ hàng triệu dòng **chưa đo**.
* **PG phiên bản khác** (14/15/17) và **PG trên Linux** — reviewer chỉ có 16.15 macOS/arm64 cục bộ
  (tác giả có thêm CI PostgreSQL 16 Linux).
* **`kill -9` giữa transaction** và nhiều **tiến trình OS** (reviewer chỉ chạy nhiều pool/tiến trình trong
  cùng một máy, không mô phỏng crash).
* **Số dư > 9,007e9 credit**: mới mô phỏng bằng số học float8 + SQL, **chưa** chạy qua store thật.
