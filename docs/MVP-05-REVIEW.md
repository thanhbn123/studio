# MVP-05 — BÁO CÁO PHẢN BIỆN ĐỘC LẬP

**PHÁN QUYẾT: FAIL**

*Nhánh `feat/mvp05-accounts` @ `29dac2e` · phản biện viên độc lập (không sửa mã nguồn, không sửa `test/**`) ·
toàn bộ script tấn công ở `/tmp/mvp05-atk/` · mọi kết luận đều kèm lệnh + output thật bên dưới.*

**Vì sao FAIL:** trả lời bốn câu hỏi trung tâm —

| Câu hỏi | Trả lời | Bằng chứng |
|---|---|---|
| Có bao giờ **làm mất tiền của người dùng**? | **CÓ** — request trả 4xx vẫn giữ tiền và không bao giờ hoàn (PB-01) | §2.1 |
| Có bao giờ **tạo tiền từ hư không**? | **CÓ** ở tầng dịch vụ (đóng chu kỳ 2 lần ⇒ hoàn 100% phần đã tiêu) (PB-04) | §2.4 |
| Có **để người này đọc dữ liệu người kia**? | **KHÔNG** — 23 đường tấn công chéo tài khoản đều bị 404/403/405 | §3.2 |
| Có **cho qua mà không trả tiền**? | **CÓ** — mọi lượt chạy lại cùng `jobId` đều miễn phí; render ImageLab chưa bao giờ bị thu (PB-02) | §2.2, §2.3 |

Điểm mạnh (không phủ nhận): xác thực/phiên/cookie/token-hash **đúng hợp đồng**, tách dữ liệu theo tài khoản
**kín**, sổ credit **append-only thật** (số dư = tổng sổ, không âm, `balance_after` liên tục kể cả khi chạy
đồng thời 100 thao tác), ẩn danh **không bị phá**, migration **idempotent**. Lỗi nằm ở **vòng đời tiền**
(cổng giữ tiền một-lần-theo-job, không hoàn khi request lỗi, không chặn đóng chu kỳ hai lần), không nằm ở
tầng xác thực/phân quyền.

---

## 1. Tóm tắt

| # | Mức | Phát hiện | Bằng chứng (lệnh · output thật) | Vì sao quan trọng | Gợi ý sửa |
|---|---|---|---|---|---|
| **PB-01** | **CAO** | **Giữ tiền rồi ném 4xx mà không hoàn.** `PUT /api/imagelab/jobs/:id/regions` gọi `holdCreditBeforeJob` rồi mới `setManualRegions`; mọi lỗi 409 ở đây để tiền bị giữ mà **không hề có dòng hoàn** (không settle/refund). 5 request 409 liên tiếp rút 0,0415 credit, không có dòng sổ nào hoàn. Hai chỗ cùng lỗi: `POST /api/imagelab/jobs` và `POST /api/imagestudio/jobs` khi `ingest` ném lỗi sau khi đã giữ tiền (chỉ đánh dấu job failed, không hoàn). | `node /tmp/mvp05-atk/atk8-confirm.mjs` §8.3 → `409:IMAGELAB_NO_ORIGINAL` ×5 · `1 → 0.9585 (−0.0415)` · `sổ = job_hold ×5, settle/refund = false` | Đúng câu hỏi trung tâm: số dư người dùng **giảm cho một request không thực hiện gì** và **không có dòng hoàn nào**. Blast radius (đã đo, xem §2.1b): khoản giữ chỉ được "tiêu thụ" nếu người dùng **chạy lại đúng job đó** (`regenerate` → 202, settle trừ tiếp phần thật); nếu không, số credit ấy nằm ngoài tầm dùng mà không có cách nào đòi. Tôi **không** dựng được ca mất vĩnh viễn 100% (mọi job thử được đều còn đường chạy lại) — nên đây là "mất quyền dùng + không hoàn", không phải "bốc hơi không thể cứu". | Sau **mọi** lỗi nằm sau `holdCreditBeforeJob` phải gọi `releaseHoldOnFailure` (đã có sẵn nhưng chỉ dùng ở `POST /api/jobs`), và/hoặc hoàn tiền cho mọi `job_hold` không có settle/refund khi job kết thúc vĩnh viễn. |
| **PB-02** | **CAO** | **Cổng tính tiền chỉ có tác dụng MỘT LẦN cho mỗi `jobId`.** `beforeJob` bỏ qua nếu **đã từng** có dòng `job_hold`; `afterJob` bỏ qua nếu đã có `job_settle`/`job_refund` ⇒ mọi lượt chạy lại của cùng job đều miễn phí: `POST /api/jobs/:id/regenerate` (3 lượt), `POST /api/imagelab/jobs/:id/render`, `POST /api/imagestudio/jobs/:id/generate`, và cả lượt chạy lại **sau khi job lỗi đã được hoàn tiền**. | `node /tmp/mvp05-atk/atk4-gate.mjs` §G3 → `regenerate #1..#3 → 202, usage_events 2→4→6→8, balance 0.9982 → 0.9982`; `atk8-confirm.mjs` §8.2 → job lỗi (đã hoàn) → regenerate → `status=succeeded, balance=1 → 1` | Công việc AI thật (tốn tiền nhà cung cấp) được trả cho khách miễn phí, không giới hạn số lần. Doanh thu bằng 0 trên mọi lượt chạy lại. | Đóng chu kỳ theo **lượt chạy** (run id) chứ không theo `jobId`, hoặc cho phép mở chu kỳ mới khi chu kỳ trước đã khép (mở hold mới + settle mới), kèm trần số lượt chạy lại/job. |
| **PB-03** | **CAO** | **Không có đường tạo owner/admin đầu tiên.** Tự đăng ký luôn là `member`; mọi route `/api/admin/*` đòi `owner\|admin`; không có route/CLI/env nào phong owner đầu tiên ⇒ trên cài đặt mới **không ai cấp được credit** (mặc định `BILLING_DEFAULT_GRANT=0`), ví vĩnh viễn 0 credit, mọi job 402. | `node /tmp/mvp05-atk/atk4-gate.mjs` §G1 → `tự phong owner → 403`; `tự cấp credit → 403`; `SELECT COUNT(*) FROM users WHERE role IN ('owner','admin') → 0` | §4 chốt "Nạp credit ở MVP-05 chỉ bằng admin cấp tay" — nhưng bản triển khai mới không thể sinh ra admin đó. Tính năng tài khoản+ví **không dùng được** cho tới khi có người sửa SQL tay (không được tài liệu hoá ở README/.env.example). | Thêm bootstrap có chủ đích: `OWNER_EMAIL` khi khởi động, `npm run make-owner -- <email>`, hoặc user đăng ký đầu tiên thành `owner` (kèm cảnh báo trong log) — và ghi vào README. |
| **PB-04** | **TRUNG BÌNH** | **`refundForJob` không kiểm dòng `job_settle`** ⇒ đóng chu kỳ hai lần sẽ hoàn luôn phần **đã tiêu**: hold 0,5 → settle (thu 0,1) → refund +0,1 ⇒ balance về đúng 1,0 (job tiêu tiền thật mà miễn phí). Chạy **song song** `settleForJob` + `refundForJob` cùng `jobId`: 20/20 lần đều ra "job miễn phí". | `node /tmp/mvp05-atk/atk7-race.mjs` §7.3 → `20 lần đua: thu ĐÚNG=0; MIỄN PHÍ=20; các số dư: [1,1,1,…]`; §7.4 → `refundForJob sau settle → GHI THÊM dòng +0.1 → balance cuối=1` | `heldFromRows()` sau settle trả về **số đã thu**, không phải "còn giữ" ⇒ mọi đường gọi refund sau settle đều tạo tiền. Hiện hook tự chặn bằng `rows.some(settle\|refund)` (đọc-rồi-hành, không nguyên tử) nên qua HTTP tôi chưa bắn trúng (6 lần thử, §3.5) — nhưng đây là quả mìn cho mọi caller tương lai (tool/demo/queue retry/đa tiến trình). | Trong `refundForJob`: nếu đã có `job_settle` cho job ⇒ không hoàn (hoặc chỉ hoàn phần `hold − settle` thực sự còn giữ); khoá theo job ở tầng DB (unique index + transaction) thay vì chỉ `#locks` trong bộ nhớ. |
| **PB-05** | **TRUNG BÌNH** | **Hai khoá cấu hình trong hợp đồng §2.3 là khoá chết**: `BILLING_DEFAULT_GRANT` (credit tặng khi đăng ký) không được đọc ở bất kỳ đâu; `BILLING_HOLD_BEFORE_JOB=false` vẫn giữ tiền và vẫn 402. | `node /tmp/mvp05-atk/atk3-auth.mjs` §3.10 → `BILLING_DEFAULT_GRANT=5: đăng ký → 201, balance=0, số dòng sổ = 0`; `BILLING_HOLD_BEFORE_JOB=false + ví 0 credit: POST /api/jobs → 402` | Cấu hình nói dối: người vận hành tưởng đã bật "tặng credit khi đăng ký"/"tắt giữ tiền trước" nhưng hệ thống làm ngược lại. | Nối 2 khoá vào `register()` (grant qua billing) và vào `holdCreditBeforeJob`/hook, hoặc xoá khỏi hợp đồng + `.env.example`. |
| **PB-06** | **THẤP** | **`grant` số cực lớn ghi dòng `amount = 0` mà vẫn trả 201.** `roundMoney(1e308) → Infinity`; `#append` biến `Infinity` thành `0` và ghi sổ "thành công". | `node /tmp/mvp05-atk/atk6-money.mjs` §6.5 → `credit amount=1e308 → 201 {"amount":5.9988,…}` (số dư KHÔNG đổi); `atk1-ledger.mjs` 1.1 → `grant(1e308) → OK {… "amount":0}` | Sổ ghi một dòng `admin_grant` 0 credit trong khi API báo thành công ⇒ sai lệch sổ im lặng (luật #2 "đối soát được" bị xói mòn), admin tin đã nạp tiền. | Chặn `!Number.isFinite` **sau** khi làm tròn (`roundMoney` phải ném/`INVALID_AMOUNT` khi kết quả không hữu hạn), và kiểm trần số credit tối đa. |
| **PB-07** | **THẤP** | **UI mời nhập số âm để "điều chỉnh giảm" nhưng API luôn từ chối.** `public/app.js:4180` ghi "Số credit (dương = cấp thêm, âm = điều chỉnh giảm)"; `POST /api/admin/users/:id/credit` chặn `amount <= 0` ⇒ 400. | `atk6-money.mjs` §6.5 → `credit amount=-5 → 400 BAD_AMOUNT` (và `amount=0 → 400`) | Không có đường hợp lệ nào để giảm/điều chỉnh credit qua API dù sổ có `reason='adjustment'`; admin bấm "XÁC NHẬN CẤP" với số âm sẽ luôn lỗi. | Thống nhất: hoặc cho phép số âm (map sang `adjustment`, giữ luật không âm), hoặc sửa nhãn UI + tài liệu. |
| **PB-08** | **THẤP** | **Chống brute-force mỏng**: `/api/auth/login` dùng chung bucket `rateLimiters.requests` (120 request/phút **theo IP**), không có khoá theo tài khoản; 429 chặn luôn cả đăng nhập **đúng** (tự khoá mình 1 phút). | `atk3-auth.mjs` §3.7 → `150 lần login sai → 429 = 68 lần, lần đầu ở request #83`; `login đúng sau đó → 429 RATE_LIMITED` | 120 phép thử mật khẩu/phút/IP vẫn là con số lớn cho mật khẩu yếu; đặt sau proxy mà không bật `trust proxy` thì mọi khách chung một bucket ⇒ một kẻ tấn công khoá được cả hệ thống. | Bucket riêng + backoff theo `email` (đã chuẩn hoá) song song với IP; trả 429 kèm `Retry-After`; ghi tài liệu về proxy. |

---

## 2. Chi tiết từng phát hiện (lệnh + output thật)

Bộ script (chạy từ `/tmp`, **không** ghi vào repo): `lib.mjs` (dựng app thật, SQLite in-memory, provider giả,
giữ cookie như trình duyệt, `auditLedger()` kiểm 3 bất biến của sổ), `atk1-ledger.mjs`, `atk2-idor.mjs`,
`atk3-auth.mjs`, `atk4-gate.mjs`, `atk5-migration.mjs`, `atk6-money.mjs`, `atk7-race.mjs`,
`atk8-confirm.mjs`, `atk9-race-http.mjs`, `atk10-admin.mjs`. Output đầy đủ: `/tmp/mvp05-atk/out1..out10.txt`.

### 2.1 PB-01 — Tiền bị giữ rồi request trả 409, không bao giờ hoàn

```
$ node /tmp/mvp05-atk/atk8-confirm.mjs
== 8.3 RÒ RỈ HOLD LẶP LẠI: 5 job ẩn danh × 1 request 409 = mất 5 lần tiền giữ ==
  5 job ẩn danh (0 dòng sổ): {"n":0}
  đăng nhập trên chính client đó → 200
[audit sau 5 request 409] OK rows=6 sum=0.9585 balance=0.9585 reasons={"admin_grant":1,"job_hold":-0.0415}
  mã trả về: ["409:IMAGELAB_NO_ORIGINAL","409:IMAGELAB_NO_ORIGINAL","409:IMAGELAB_NO_ORIGINAL","409:IMAGELAB_NO_ORIGINAL","409:IMAGELAB_NO_ORIGINAL"]
  số dư: {"amount":1,"currency":"USD"} → {"amount":0.9585,"currency":"USD"}  (mất 0.0415 credit)
  sổ: [{"seq":2,"reason":"job_hold","job_id":"1aa182e1…","amount":-0.0083,"balance_after":0.9917}, … 5 dòng]
  có dòng settle/refund nào cho 5 job đó? false
```

Cùng cảnh báo ở lần chạy đầu (`atk4-gate.mjs` §G5): `PUT regions trên job content ẩn danh → 409
IMAGELAB_NO_ORIGINAL`, số dư `0.9816 → 0.9733`, sổ chỉ có `job_hold`.

- Cơ chế: `src/http/routes.js:1662` gọi `holdCreditBeforeJob` **trước** `setManualRegions` (1666). Mọi lỗi
  ném ra từ `setManualRegions` (`IMAGELAB_NO_ORIGINAL`, `IMAGELAB_JOB_RUNNING`,
  `MANUAL_EDITS_WOULD_BE_LOST`, `NOT_CONFIGURED`) đi thẳng ra 4xx mà **không** gọi
  `releaseHoldOnFailure` (hàm này đã có ở `routes.js:790` nhưng chỉ `POST /api/jobs` dùng).
- Hai chỗ cùng lỗi (chưa bắn được vì cần lỗi ingest, nhưng đọc mã là thấy):
  `routes.js:1505-1509` (imagelab `ingest`) và `routes.js:1879-1884` (imagestudio `ingest`) — sau hold chỉ
  `throw`, không hoàn.
- Điều kiện tiên quyết để "job chưa từng có hold" là có thật: job ẩn danh (§2.2 hợp đồng cho phép job cũ
  theo `session_id` vẫn đọc được sau khi đăng nhập — đã kiểm: HTTP 200), job tạo trên DB cũ, job tạo lúc
  `billingService=null`.
- Mức độ: mỗi request 409 rút bằng đúng `estimate` của kind (content = 0.0083; image_translation = 0.0027;
  image_generation = 0.003). Không có log/cảnh báo nào cho người dùng biết.

### 2.1b PB-01 — Khoản giữ rò rỉ đòi lại được hay không? (đo, không suy đoán)

```
$ node /tmp/mvp05-atk/atk12-perm2.mjs    # job ẩn danh nguồn bị chặn (needs_manual), rồi đăng nhập
  PUT regions (giữ tiền rồi 409) → 409 IMAGELAB_NO_ORIGINAL
  balance = {"amount":0.9917,…}                      ← đã mất 0.0083, sổ chỉ có job_hold
  POST regenerate → 202                              ← chạy lại được ⇒ khoản giữ bị "tiêu thụ"
[audit cuối] reasons={"admin_grant":1,"job_hold":-0.0083,"job_settle":0.0068} · balance=0.9985
$ node /tmp/mvp05-atk/atk11-perm.mjs     # job ẩn danh chạy THÀNH CÔNG rồi mới bị 409
  PUT regions → 409 IMAGELAB_NO_ORIGINAL ; POST regenerate → 202 ; balance cuối 0.9964
```

Kết luận đo được: khoản giữ rò rỉ **không tự biến mất** nhưng cũng **không được hoàn**; nó chỉ được dùng
tiếp nếu người dùng chạy lại **đúng job đó** (khi đó `settle` trừ tiếp chi phí thật của lượt chạy mới). Với
người dùng bình thường (bỏ job lỗi, tạo job mới), số credit ấy coi như mất — và **không có dòng sổ nào nói
điều đó**. Đây vẫn là vi phạm luật "request 4xx ⇒ không ghi gì" và luật "mọi lần trừ đều có dòng hoàn tương
ứng khi job không chạy".

### 2.2 PB-02 — Chạy lại cùng job = miễn phí (đã trả tiền một lần, chạy bao nhiêu lần cũng được)

```
$ node /tmp/mvp05-atk/atk4-gate.mjs
== G3. Tạo job có trả tiền + CHẠY LẠI KHÔNG TRẢ TIỀN ==
  POST /api/jobs → 202 job=e5d02d7b-…
[audit sau lượt chạy 1] OK rows=3 sum=0.9982 balance=0.9982 reasons={"admin_grant":1,"job_hold":-0.0083,"job_settle":0.0065}
  usage_events của job sau lượt 1: 2
  regenerate #1 → HTTP 202, job=succeeded, usage_events=4
  regenerate #2 → HTTP 202, job=succeeded, usage_events=6
  regenerate #3 → HTTP 202, job=succeeded, usage_events=8
[audit sau 3 lần regenerate] OK rows=3 sum=0.9982 balance=0.9982
  balance: 0.9982 → 0.9982 (KHÔNG đổi = 3 lượt chạy AI miễn phí)
  tổng chi phí thật đã ghi vào usage_events: {"events":8,"estimated_cost":0.0072,…}
```

Và lượt chạy lại **sau khi job lỗi đã được hoàn tiền** cũng miễn phí:

```
$ node /tmp/mvp05-atk/atk8-confirm.mjs
== 8.2 REGENERATE SAU KHI JOB LỖI ĐÃ HOÀN TIỀN: chạy lại thành công, không thu tiền ==
  lần 1: status=failed, balance=1, sổ=["job_hold","job_refund"]
  POST regenerate → 202
  lần 2: status=succeeded, balance=1
  chi phí thật luỹ kế: {"events":3,"estimated_cost":0.0026,…}
  sổ theo job: [job_hold −0.0083, job_refund +0.0083]     ← KHÔNG có dòng settle nào
  ⇒ *** CHẠY LẠI THÀNH CÔNG, ví vẫn 1 credit (miễn phí) ***
```

- Cơ chế: `src/app.js:189` (`beforeJob`: `if (rows.some(r => r.reason === 'job_hold')) return { skipped: true }`)
  và `src/app.js:244` (`afterJob`: bỏ qua nếu có `job_settle` **hoặc** `job_refund`). Hai điều kiện này
  đúng cho "chống thu hai lần", nhưng sai cho "lượt chạy mới": chu kỳ của một job chỉ khép **một lần duy
  nhất** trong toàn bộ vòng đời.
- `routes.js:1340-1342` tự nhận "sinh lại nội dung cũng TIÊU credit" nhưng thực tế không thu được đồng nào.

### 2.2b PB-02 — ImageStudio: 2 lượt tạo ảnh lại, 0 đồng (và lượt đầu cũng 0 đồng)

```
$ node /tmp/mvp05-atk/atk13-imagestudio.mjs
  POST /api/imagestudio/jobs → 202 job=c8901291-…
[audit sau lượt tạo ảnh 1] OK rows=3 sum=1 balance=1 reasons={"admin_grant":1,"job_hold":-0.003,"job_refund":0.003}
  usage lượt 1: {"events":0,"estimated_cost":0,…}
  generate lần 2 → HTTP 202, usage={"events":2,"estimated_cost":0.0025,…}
  generate lần 3 → HTTP 202, usage={"events":4,"estimated_cost":0.005,…}
[audit sau 2 lần generate lại] OK rows=3 sum=1 balance=1   ← KHÔNG có dòng sổ mới
  balance: 1 → 1 · số ảnh đã tạo (rendered): 2
```

Hai điều đáng chú ý: (a) hai lượt chạy lại **miễn phí hoàn toàn** dù sinh thêm 2 ảnh và 0,005 chi phí thật;
(b) **lượt chạy ĐẦU cũng bị hoàn 100%** vì pipeline mock không ghi `usage_events` nào ⇒ `settle actualCost=0`
⇒ hoàn hết. Việc thu tiền phụ thuộc HOÀN TOÀN vào `usage_events` do pipeline tự ghi: bước nào quên ghi
usage thì bước đó miễn phí (không có đối chiếu độc lập nào giữa "đã chạy" và "đã ghi usage").

### 2.3 PB-02 (tiếp) — Render ảnh ImageLab chưa bao giờ bị thu tiền

```
$ node /tmp/mvp05-atk/atk6-money.mjs
== 6.2 RENDER ảnh ImageLab có bị tính tiền không? ==
  job imagelab: status=awaiting_review lines=4
[audit sau OCR (chưa render)] OK rows=3 sum=0.9988 balance=0.9988 reasons={"admin_grant":1,"job_hold":-0.0027,"job_settle":0.0015}
  usage trước render: {"events":2,"estimated_cost":0.0012,…}
  POST render → 202 {"job_id":"afb3cb50-…","status":"queued","force":true}
  job sau render: status=succeeded
[audit sau render] OK rows=3 sum=0.9988 balance=0.9988 reasons={"admin_grant":1,"job_hold":-0.0027,"job_settle":0.0015}
  usage sau render: {"events":3,"estimated_cost":0.0027,…}
  số dư: 0.9988 → 0.9988 (render có tính thêm đồng nào không?)
```

- Ước tính giữ tiền của job `image_translation` **có** gồm `IMAGE_RENDER` (0.0015) — `src/app.js:97` — nhưng
  `runOcr` settle theo usage thật (0.0012) nên đã **hoàn lại 0.0015** cho phần render; khi render chạy sau
  đó thì `beforeJob`/`afterJob` đều bị bỏ qua. Kết quả: job tiêu 0.0027 nhưng chỉ thu 0.0012.

### 2.4 PB-04 — Đóng chu kỳ hai lần ⇒ hoàn luôn phần đã tiêu (tạo tiền)

```
$ node /tmp/mvp05-atk/atk7-race.mjs
== 7.3 ĐUA settle + refund trên CÙNG jobId (tầng dịch vụ, lặp 20 lần) ==
  20 lần đua settle+refund: số lần bị thu ĐÚNG (0.9) = 0; số lần job THÀNH RA MIỄN PHÍ (1.0) = 20
  các số dư quan sát: [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]
[audit race] OK rows=4 sum=1 balance=1 reasons={"grant":1,"job_hold":-0.5,"job_settle":0.4,"job_refund":0.1}

== 7.4 refundForJob SAU settle (không đua) có hoàn luôn phần ĐÃ TIÊU không? ==
  sau settle: balance=0.9 (đã thu 0.1 cho công việc THẬT)
  refundForJob sau settle → GHI THÊM dòng +0.1
  balance cuối=1 ⇒ *** job đã tiêu tiền thật nhưng được HOÀN 100% ***
```

- Gốc: `src/billing/index.js:173` `heldFromRows()` = `−(tổng các dòng job_*)`. Sau `hold −0.5` + `settle +0.4`
  thì "phần đang giữ" bị tính = **0.1** (thực chất là phần đã thu) ⇒ `refundForJob` hoàn tiếp 0.1.
- `refundForJob` (`src/billing/index.js:698`) **không** kiểm dòng `job_settle`; chỉ `settleForJob` mới
  idempotent theo settle.
- Ở tầng dịch vụ đây là 20/20 (không phải may rủi) vì `Promise.all` luôn cho settle ghi trước.
- Qua HTTP: tôi thử 6 lần kịch bản "2 lượt chạy song song cùng job, 1 lượt lỗi" (`atk9-race-http.mjs`) —
  **chưa** bắn trúng cửa sổ đọc-rồi-ghi của hook (kết quả: `0 miễn phí · 6 thu tiền bình thường`), nên
  PB-04 hiện là **mìn tiềm ẩn** chứ chưa phải khai thác được từ ngoài. Vẫn phải sửa: một caller tương lai
  (tool/demo/queue retry/đa tiến trình) là đủ.
- **Xác nhận độc lập:** `test/mvp05-refund-retry.probe.mjs` (agent test viết song song lúc 17:50, KHÔNG chạy
  trong `npm test`) mô tả đúng hai lỗ hổng này: "(2) `refundForJob` SAU `settleForJob` ⇒ HOÀN NỐT PHẦN ĐÃ
  TIÊU … job thành miễn phí" và gợi ý y hệt ("`refundForJob` trả `null` khi job đã có dòng `job_settle`").

### 2.5 Những gì **không** sai ở tầng sổ (để định vị lỗi chính xác)

```
$ node /tmp/mvp05-atk/atk1-ledger.mjs     # sổ: âm / NaN / Infinity / -0 / chuỗi số / jobId rỗng
[audit đồng thời 50+50] OK rows=101 sum=106.25 balance=106.25
  50 hold CÙNG jobId → chỉ 1 dòng job_hold; 50 settle CÙNG jobId → chỉ 1 dòng job_settle; balance 9.8 (đúng)
$ node /tmp/mvp05-atk/atk6-money.mjs
== 6.6 Ví: số dư có BAO GIỜ âm không (quét toàn bộ DB) ==
  MIN(balance_after)=0.9973 · số dòng âm=0
  tổng số dòng sổ=8 · số dòng lệch (balance_after ≠ tổng luỹ kế)=0
  số user có "số dư ≠ tổng sổ"=0
```

### 2.6 PB-03 — Không có owner đầu tiên

```
$ node /tmp/mvp05-atk/atk4-gate.mjs
== G1. Cài đặt MỚI: có ai cấp được credit không? ==
  register #1 → 201 role=member
  tự phong owner qua /api/admin/users/:id/role → 403 {"error":{"code":"FORBIDDEN",…}}
  tự cấp credit → 403 {"error":{"code":"FORBIDDEN",…}}
  roles trong DB (mọi user đều KHÔNG phải admin): [{"email":"admin@local","role":"member"}]
  ⇒ không route/CLI/env nào tạo owner đầu tiên: {"n":0}
```

`grep -rn "owner" src tools .env.example | grep -v "ownerJob|ownerId"` chỉ ra `ROLES`, `LAST_OWNER`,
`ADMIN_ROLES`… **không** có bootstrap. `docs/*.md` cũng không hướng dẫn.

### 2.7 PB-05 — Hai khoá cấu hình chết

```
$ node /tmp/mvp05-atk/atk3-auth.mjs
== 3.10 BILLING_DEFAULT_GRANT và BILLING_HOLD_BEFORE_JOB có được tôn trọng? ==
  BILLING_DEFAULT_GRANT=5: đăng ký → 201, balance={"amount":0,"currency":"USD"}, số dòng sổ = 0 (kỳ vọng 1 dòng grant 5)
  BILLING_HOLD_BEFORE_JOB=false + ví 0 credit: POST /api/jobs → 402 (false ⇒ kỳ vọng 202 không giữ tiền)
$ grep -rn "defaultGrant\|holdBeforeJob" src public
src/config.js:237:      defaultGrant: Math.max(0, toNum(env.BILLING_DEFAULT_GRANT, 0)),
src/config.js:238:      holdBeforeJob: toBool(env.BILLING_HOLD_BEFORE_JOB, true),
```

### 2.8 PB-06 — `grant(1e308)` ghi sổ `amount = 0` và trả 201

```
$ node /tmp/mvp05-atk/atk6-money.mjs
  credit amount="5" (chuỗi số) → 201 {"amount":5.9988,"currency":"USD"}
  credit amount=1e308 → 201 {"amount":5.9988,"currency":"USD"}      ← số dư KHÔNG đổi
$ node /tmp/mvp05-atk/atk1-ledger.mjs
  grant(amount=1e+308) → OK {…,"amount":0,…}
```

Chuỗi nhân quả: `roundMoney(1e308) = Infinity` → `#append` (`src/billing/index.js:376`) gọi
`roundMoney(Infinity) = 0` → ghi dòng 0. `Number.isFinite` không được kiểm lại ở cuối.

---

## 3. Đã cố phá mà KHÔNG phá được

### 3.1 Sổ credit (luật #2) — chắc
- Số dư âm: `appendLedger(-1)`, `-5e-7`, `-1e-9`, `-1e-10` khi số dư 0 → **INSUFFICIENT_CREDIT**, không ghi
  dòng nào; `MIN(balance_after)` toàn DB = 0 (không có dòng âm, không có `-0`).
- `NaN`, `Infinity`, `-Infinity`, `'abc'`, `'1e999'`, `'0x10'`, `''`, `'   '`, `[]`, `{}`, `true` cho
  `grant`/`hold`/`settle`/`appendLedger` → **INVALID_AMOUNT / INVALID_LEDGER_ROW**, không rác vào sổ.
- `jobId` rỗng/`'   '`/`null`/`undefined`/`0`/`{}`/`[]` → **INVALID_ARGUMENT** (không có "job ma").
- Trùng `jobId` giữa 2 user → sổ **tách đúng theo user** (`A: 9007199254742004`, `B: 0.8`), không lẫn.
- `settle` gọi 2–5 lần với `actualCost` khác nhau/âm/`NaN`/chuỗi → trả **đúng dòng settle cũ**, số dư không
  đổi. `refund` gọi 3 lần → 1 dòng, số dư về đúng.
- `settle actualCost = 999` khi số dư 0 → thu tối đa bằng số dư, ghi `meta.shortfall`, **không âm**.
- Đồng thời: 100 thao tác `Promise.all` (hold/grant/settle/refund) → `sum == balance`, `balance_after` liên
  tục, 0 dòng lệch; 50 `holdForJob` **cùng jobId** song song → **1 dòng** hold; 50 `settleForJob` cùng jobId →
  **1 dòng** settle (khoá theo user + transaction của store hoạt động).
- Làm tròn: 200 × `grant(0.0000004)` → tất cả bị từ chối (làm tròn 0), không tạo tiền; 100 × (hold+settle
  0.0000004) → 0 dòng, số dư không đổi.

### 3.2 Rò rỉ chéo tài khoản — kín (23/23 bị chặn)
`node /tmp/mvp05-atk/atk2-idor.mjs` — B tấn công A: `GET /api/jobs/:id`, `GET /api/jobs/:id/usage`,
`PUT /api/jobs/:id/content`, `POST /api/jobs/:id/regenerate`, `GET /api/imagelab/jobs/:id`,
`PUT .../lines`, `PUT .../regions`, `POST .../render`, `GET /api/imagelab/assets/:id`,
`GET /api/imagelab/assets/:id/file`, `GET /api/imagestudio/jobs/:id`, `POST .../generate`,
`GET /api/imagestudio/assets/:id/file` → **404 hết**. Ghi trộm bị chặn thật (nội dung job A không đổi).
Job ẩn danh: B (sid khác) → 404; A đã đăng nhập (sid khác) → 404; chính chủ sid → 200 (đúng luật cũ §2.2).
`GET /api/admin/*` khi là `member` → **403**, khi ẩn danh → **401**; `PUT` vào route admin → 405;
`PUT content` kèm `role`/`user_id` → không đổi quyền (`role` trong DB vẫn `member`); tự đăng ký kèm
`role:'owner'` → DB vẫn `member`. Sổ credit của B chỉ có dòng của B (0 `job_id` của A lọt vào).
`GET /api/admin/users` không trả `password_hash`/`token_hash`/`scrypt` (đã kiểm chuỗi trong response).
IDOR qua id không phải uuid → 404/400, không lộ sự tồn tại.

### 3.3 Xác thực / phiên / cookie — đúng hợp đồng §3.1
- `sha256(token thô) === user_sessions.token_hash` ✔; token thô **không** có trong DB, không có trong body
  response (`body keys: ["user","expires_at"]`), không có trong log (`log chứa TOKEN thô? false`,
  `chứa MẬT KHẨU thô? false`, `chứa 'scrypt$'? false`).
- Cookie: `vauth=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=…` và **thêm `Secure`** khi
  `PUBLIC_BASE_URL=https://…`; cookie không chứa email/id.
- Token sửa 1 ký tự / rỗng / rác / 10k ký tự → khách ẩn danh (không 500). Phiên hết hạn → khách; logout →
  `revoked_at` được ghi, cookie cũ **không** dùng lại được; tài khoản `disabled` → phiên chết và login trả
  403 `ACCOUNT_DISABLED` (chỉ sau khi mật khẩu đúng).
- Dò tài khoản: email lạ / email có thật + sai mk / email rác / 10k ký tự / `__proto__` / có khoảng trắng /
  unicode → **cùng 401 BAD_CREDENTIALS, cùng câu**. Thời gian: email lạ med **23.3 ms** vs mật khẩu sai med
  **23.4 ms** (12 lần đo mỗi nhánh) ⇒ không lộ qua thời gian.
- Mật khẩu yếu/rỗng/null/4097 ký tự → 400 WEAK_PASSWORD/BAD_BODY; mật khẩu emoji 10 ký tự → OK (đếm theo
  codepoint, đúng `[...password].length`).

### 3.4 Cổng giữ tiền §3.4b — 402 đúng ở cả 5 chỗ, DB không tăng
```
$ node /tmp/mvp05-atk/atk4-gate.mjs     # ví 0 credit
  POST /api/jobs → 402 {"code":"INSUFFICIENT_CREDIT","…cần 0.0083, hiện có 0"}
  POST /api/imagelab/jobs → 402 (cần 0.0027)
  POST /api/imagestudio/jobs → 402 (cần 0.003)
  DB trước: {"jobs":0,"assets":0,"ledger":0,"usage":0}
  DB sau  : {"jobs":0,"assets":0,"ledger":0,"usage":0}   Δ = 0 hết
$ node /tmp/mvp05-atk/atk6-money.mjs    # job ẩn danh có thật, rồi đăng nhập ví 0 credit
  [chỗ #3] PUT regions khi 0 credit → 402 "INSUFFICIENT_CREDIT"
  [chỗ #5] POST generate khi 0 credit → 402 "INSUFFICIENT_CREDIT"
  Δ jobs/assets/regions/lines/ledger = 0 hết
```
`beforeJob` gọi 3 lần + **2 lần song song** cùng `jobId` → chỉ **1 dòng** hold (`atk4` §G4).

### 3.5 Đua qua HTTP (chưa bắn được — xem PB-04)
`node /tmp/mvp05-atk/atk9-race-http.mjs`: 6 lần dựng cảnh 2 lượt chạy song song cùng job (một lượt lỗi
`FAKE_AI_DOWN`) → `0 lần job thành công mà bị hoàn hết tiền · 6 lần thu tiền bình thường`. Cửa sổ
đọc-rồi-ghi của hook nhỏ hơn 1 ms nên chưa khai thác được từ ngoài trong thời gian cho phép.

### 3.6 Migration / hồi quy / ẩn danh — đạt
- DB cũ (schema MVP-03 + `wallet_ledger` **thiếu cột `seq`**) → `init()` **2 lần liên tiếp không lỗi**; cột
  `jobs.user_id`, `image_assets.user_id`, `wallet_ledger.seq` được thêm; 4 bảng mới có mặt; dòng sổ cũ giữ
  nguyên (`seq = 0`); job cũ `user_id NULL` đọc được ẩn danh 0 cookie và **không** phát sinh dòng sổ nào.
- 3 loại job ẩn danh (content / imagelab / imagestudio) chạy được **không cần cookie, không cần tài khoản**,
  tổng số dòng sổ = 0.
- Module MVP-05 lỗi (bản sao repo trong `/tmp`, 2 file `throw`): app **vẫn boot**, `accountService=null`,
  `billingService=null`, `billingHook` vẫn là object; `POST /api/jobs` → 202 và job `succeeded`;
  `/api/auth/me` → 200 khách; `register` → 503 AUTH_UNAVAILABLE; `/api/health` nói rõ lý do.
- `AUTH_ENABLED=false` → `/api/auth/*` 503, job ẩn danh vẫn 202. `BILLING_ENABLED=false` → ledger 503
  (không bịa số 0), job vẫn 202, `/api/auth/me` balance `null`.
  `AUTH_ANONYMOUS_ALLOWED=false` → route nghiệp vụ 401, `/api/auth/*`+health+config vẫn chạy, route file ảnh
  trả 404 (không 401) — đúng §2.3/§3.3.
- `/api/config` có `auth: {enabled, anonymous_allowed, password_min_length, roles, available}`.
- `estimate.total = 0.0083` khớp tổng bảng giá; `priceOf` ném `UNKNOWN_OPERATION` cho operation lạ/rỗng;
  bảng giá **không** có giá âm/0/không hữu hạn; **không có route nào** sửa được bảng giá (`POST/PUT
  /api/billing/pricing` → 405, `/api/admin/pricing` → 404) ⇒ không đầu độc giá qua HTTP.
- Admin: `credit` cho user không tồn tại / id không phải uuid → 404; hạ cấp owner cuối → 409 `LAST_OWNER`;
  `role` viết hoa/khoảng trắng được chuẩn hoá; `/api/admin/usage?group_by=user` gom đúng nhóm `(ẩn danh)` +
  theo `user_id`; `group_by` lạ → 400; `GET /api/admin/users` → `{items,total}` không lộ hash.
- **Bộ test (tự đo 2 lần, vì có agent test chạy song song trong lúc phản biện):**
  - lúc **bắt đầu** phản biện (chỉ có test cũ, đúng commit `29dac2e`): `npm test` = **717 test · 716 pass ·
    0 fail · 1 skipped** (exit 0);
  - lúc **kết thúc** (agent test đã thêm 9 file `test/mvp05-*` **chưa được commit**): `npm test` = **809 test ·
    808 pass · 0 fail · 1 skipped** (exit 0) và `node tools/verify.mjs` = **809 test · 808 pass · 0 fail ·
    1 skipped** (exit 0, kiểm cú pháp 160 file).
  - ⚠️ **Commit được phản biện (`29dac2e`) KHÔNG chứa một test nào cho MVP-05** (`git show --stat` không có
    `test/**`; mọi file `test/mvp05-*.test.js` đang là **untracked**, sinh ra lúc 17:45–17:50 trong lúc tôi
    phản biện). Vì vậy "717 test cũ còn xanh" **không** nói gì về MVP-05.
  - Đáng chú ý: `test/mvp05-refund-retry.probe.mjs` (agent test thêm lúc 17:50, **không** chạy trong
    `npm test`) **độc lập ghi nhận đúng hai lỗ hổng PB-02 và PB-04** của tôi — nhưng chọn để ngoài bộ test
    ("không phải lỗi tới được", "quyết định của Owner"), nên bộ test vẫn xanh trong khi lỗ hổng còn nguyên.
    `test/mvp05-billing.test.js:81-88` thậm chí chỉ khẳng định bất biến yếu `refunded ≤ held` cho ca
    refund-sau-settle ⇒ **bộ test mới không bắt được PB-04**.
  - Repo không bị tôi sửa: `git status --short` chỉ có `docs/MVP-05-REVIEW.md` (của tôi) + các file
    `test/mvp05-*` (của agent test).

---

## 4. Chưa kiểm được (vì sao)

1. **PostgreSQL** — không có `DATABASE_URL`/server PG trong môi trường này (đó cũng là test bị `skipped`).
   Các bất biến của sổ ở tầng SQL (`SUM` + transaction, `seq`) mới chỉ được chứng minh trên SQLite;
   `holdForJob`/`settle` trên PG (đặc biệt `BEGIN`/`SELECT SUM` + `INSERT` chạy song song nhiều kết nối)
   **chưa** được đo.
2. **Đa tiến trình/đa instance** — `#locks` của `BillingService` là khoá trong bộ nhớ (chính tài liệu A2 đã
   ghi). Tôi chỉ kiểm được 1 tiến trình; hai instance cùng ghi sổ cho một user chưa được thử (cần PG/docker
   scale).
3. **Provider thật** (AI/OCR/render) — mọi thí nghiệm dùng provider giả/mock offline, nên **chi phí thật** và
   hành vi lỗi/độ trễ của nhà cung cấp (ảnh hưởng tới các cửa sổ đua ở PB-04) chưa được đo.
4. **UI trong trình duyệt thật** — chưa chạy GUI: mới đọc mã `public/app.js` (mọi chỗ render dữ liệu người
   dùng đều qua `esc()`, `esc` escape cả `"`/`'`; không thấy chỗ nhét token vào DOM). Hành vi thực tế của
   trang `#/dangnhap`, `#/taikhoan`, `#/quantri` (đặc biệt luồng nhập số âm ở PB-07) chưa bấm tay.
5. **Tải/độ bền** — chưa chạy load test (10k user, sổ 100k dòng). `#jobRows` quét sổ theo trang với trần
   `LEDGER_MAX_SCAN = 5000` dòng/job: với job có sổ dài hơn ngưỡng đó, `holdForJob`/`settle` có thể **không
   nhìn thấy** dòng cũ (có log `billing.ledger_scan_truncated` nhưng hậu quả kế toán chưa được đo).
6. **Rate limit sau proxy** — `clientKey()` chỉ đọc `req.socket.remoteAddress` (không có `trustProxy`): hành
   vi sau nginx/Cloudflare chưa được kiểm (xem PB-08).

---

### Phụ lục — lệnh tái lập nhanh

```bash
cd "/Users/viporder/Library/CloudStorage/SynologyDrive-Macbook/Thành bộ não/production/vip-product-studio"
npm test                                  # lúc bắt đầu: 717 · 716 pass · 0 fail · 1 skipped
npm test                                  # lúc kết thúc (đã có test mvp05-* của agent test): 809 · 808 pass · 0 fail
node tools/verify.mjs                     # 809 · 808 pass · 0 fail · 1 skipped
node /tmp/mvp05-atk/atk8-confirm.mjs      # PB-01 (§8.3) + PB-02 (§8.2)
node /tmp/mvp05-atk/atk4-gate.mjs         # PB-02 (§G3) + PB-03 (§G1) + 402 cả 5 chỗ (§G2)
node /tmp/mvp05-atk/atk6-money.mjs        # render miễn phí (§6.2) + PB-06 (§6.5) + bất biến sổ (§6.6)
node /tmp/mvp05-atk/atk7-race.mjs         # PB-04 (§7.3, §7.4)
node /tmp/mvp05-atk/atk3-auth.mjs         # xác thực/cookie/timing/brute-force + PB-05 (§3.10)
node /tmp/mvp05-atk/atk11-perm.mjs        # PB-01: khoản giữ rò rỉ có đòi lại được không
node /tmp/mvp05-atk/atk12-perm2.mjs       # PB-01: biến thể needs_manual
node /tmp/mvp05-atk/atk13-imagestudio.mjs # PB-02: ImageStudio chạy lại 2 lần = 0 đồng
node /tmp/mvp05-atk/atk2-idor.mjs         # 23 đường IDOR (đều bị chặn)
node /tmp/mvp05-atk/atk5-migration.mjs    # migration 2 lần, DB cũ, ẩn danh 3 loại, module lỗi vẫn boot
```
