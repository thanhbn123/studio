# ROADMAP — VIP Product Studio

Tài liệu này ghi thứ tự các giai đoạn sau MVP-01. Nguyên tắc: **mỗi giai đoạn chỉ bắt đầu khi
giai đoạn trước đã được Owner nghiệm thu**, và MVP-01 đã chuẩn bị sẵn chỗ nối cho từng phần.

---

## Đã xong — MVP-01: Product Content Studio

Luồng: link Taobao/1688/PDD → trích xuất thật → Product Master → phân tích ảnh → nội dung
bán hàng tiếng Việt → bằng chứng + lịch sử + usage.

Điểm nối đã có sẵn cho các giai đoạn sau:

- `usage_event` (G13) đã ghi đủ `operation` / `provider` / `input_units` / `output_units` /
  `estimated_cost` → chuyển sang credit-based billing không phải viết lại core.
- `ProductSourceConnector` là registry cô lập → thêm sàn mới không đụng connector cũ.
- `VisionProvider` và AI provider là abstraction → đổi provider không đụng nghiệp vụ.
- `jobs` có `status`/`stage` → thêm bước dài (video, render ảnh) chỉ cần thêm stage.

---

## MVP-02 — Image Translation Studio

**Trạng thái: ĐÃ MERGE VÀO `develop`** (PR [#20](https://github.com/thanhbn123/studio/pull/20),
merge commit `55aed67`, 03/10/2026) **— CHỜ OWNER NGHIỆM THU.**

Bằng chứng đi kèm: **510 test · 509 pass · 0 fail · 1 skipped** · `npm run verify` EXIT=0 ·
**CI 5/5 job xanh** (Linux · **PostgreSQL 16 thật** · smoke server thật · Docker + chạy luồng MVP-02
trong image · quét secret) · **4 lượt phản biện độc lập**: lượt đầu **FAIL** (1 CRITICAL — hộp chữ
chồng nhau xoá pixel logo mà hệ thống vẫn báo “không xoá”), các lượt sau **PASS CÓ ĐIỀU KIỆN** →
**PASS**; 14 phát hiện đã vá và được kiểm lại độc lập. Chi tiết đo được:
[`docs/VERIFICATION.md`](VERIFICATION.md) §8–§12 · báo cáo phản biện nguyên văn:
[`docs/MVP-02-REVIEW.md`](MVP-02-REVIEW.md).

**Mục tiêu:** dịch chữ Trung trên ảnh sản phẩm sang tiếng Việt, giữ nguyên bố cục và phong cách.

Đã làm:
- Phát hiện vùng chữ (OCR) trên ảnh gốc: hộp bao (pixel + chuẩn hoá) + nội dung + ngôn ngữ + độ tin cậy.
- Phân loại từng vùng: `descriptive` / `brand` / `certification` / `price` / `unknown` (fail-closed).
- Dịch sang tiếng Việt qua **bảng duyệt sửa từng dòng**, có từ điển thuật ngữ + 4 luật guardrail.
- Xoá chữ cũ (inpaint) và render chữ Việt vào đúng hộp, tự chọn cỡ chữ vừa hộp; không vừa thì **bỏ qua**
  và giữ nguyên chữ gốc (không bao giờ vẽ tràn).
- Giữ nguyên ảnh gốc bất biến; mọi ảnh sinh ra là bản mới có `parent_id` + `sha256` truy vết.
- Ghi `usage_event` cho hai operation mới: `OCR_DETECT`, `IMAGE_RENDER` (dịch dùng `TRANSLATION`).

Giới hạn THẬT đang có (đọc trước khi tin):
- OCR mặc định là **mock** đọc từ fixture dựng tay (`is_mock = true`). OCR thật cần cắm provider
  `OCR_PROVIDER=http` — **chưa đo được** vì chưa có dịch vụ.
- Render nội bộ `purejs` **chỉ giải mã PNG** (8-bit, color type 0/2/4/6, non-interlaced).
  JPEG/WebP/GIF trả `UNSUPPORTED_IMAGE` — cần `RENDER_PROVIDER=http` để xử lý.
- Chưa có test nào trên UI `public/app.js` (escape XSS) và trên provider `http` thật.

Quy tắc đã chốt cho rủi ro đạo đức (điều khoản "cần quyết trước" của bản roadmap cũ):
**chỉ dịch chữ mô tả**; chữ là **nhãn hiệu / chứng nhận / giá** thì không dịch, không xoá, và lý do
được ghi lại; người dùng chỉ override được khi gửi cờ rõ ràng, và override để lại vết.

---

## MVP-03 — Image Generation / Retouching

**Trạng thái: ĐÃ MERGE VÀO `develop`** (PR [#21](https://github.com/thanhbn123/studio/pull/21),
merge commit `3caa66b`, 04/10/2026) **— CHỜ OWNER NGHIỆM THU.**

Bằng chứng: **717 test · 716 pass · 0 fail · 1 skipped** · `node tools/verify.mjs` EXIT=0 ·
**CI 5/5 job xanh** · **3 vòng phản biện độc lập**: vòng 1 **FAIL** (1 CRITICAL — tách nền **ăn mất
sản phẩm gần màu nền** mà job vẫn `succeeded` và warning khẳng định “pixel sản phẩm giữ nguyên”;
1 MAJOR — overlay có đường **“tự rửa tội”** qua `overlay.source_text` do client gửi) → đã vá →
các vòng sau **PASS CÓ ĐIỀU KIỆN** → đã vá nốt (N1…N9). Hồ sơ nghiệm thu:
[`MVP-03-ACCEPTANCE.md`](MVP-03-ACCEPTANCE.md) · báo cáo phản biện nguyên văn:
[`MVP-03-REVIEW.md`](MVP-03-REVIEW.md) · hợp đồng: [`MVP-03-CONTRACT.md`](MVP-03-CONTRACT.md).

Đã làm:
- **Tách nền** (flood fill từ viền, thuần JS, không dịch vụ trả tiền) — **fail-closed**: nền không
  đồng nhất ⇒ `UNIFORM_BACKGROUND_NOT_FOUND`; biên nhập nhằng / nghi cắt vào sản phẩm ⇒
  `SEGMENTATION_AMBIGUOUS` / `SUSPICIOUS_MASK` kèm **số đo thật**; cờ `matting_allow_ambiguous`
  mặc định TẮT và **không** mở đường cho ca nguy hiểm.
- **5 mẫu nền** (`trang`, `xam-nhat`, `gradient-xanh`, `gradient-hong`, `san-go`) đều
  `synthetic: true` — nền sinh ra là **MÔ PHỎNG, có khai** ở API/meta/UI.
- **Retouch** brightness/contrast/saturation/sharpen, **bị kẹp theo ngưỡng** và ghi lại
  `params_effective`/`clamped`/`rejected`; không resize/warp, không đổi alpha vùng nền đã tách.
- **Overlay chữ Việt** (dùng font của MVP-02) — bằng chứng **chỉ lấy từ dữ liệu ĐÃ LƯU của job**;
  khẳng định thiếu bằng chứng ⇒ **422, không vẽ pixel nào**; trả `evidence_used`.
- `usage_event` mới: `IMAGE_MATTING`, `IMAGE_COMPOSE`, `IMAGE_RETOUCH` (chỉ ghi bước **chạy thật**).
- UI tab thứ ba **“Tạo ảnh”** + 5 route `/api/imagestudio/*`.

Giới hạn THẬT: chỉ hợp ảnh **nền đồng nhất** (không có matting AI); **chỉ PNG** (JPEG/WebP cần
provider `http` — **chưa đo**); sản phẩm cách nền ≤ **8/255** là **giới hạn vật lý** không tách được;
ảnh có bóng đổ mềm bị **từ chối ghép nền** (vẫn retouch) — đúng luật “thà không làm còn hơn làm sai”.

Phạm vi dự kiến ban đầu (còn lại, chưa làm):
- Sinh ảnh bối cảnh (lifestyle) từ ảnh sản phẩm thật — cần model sinh ảnh (dịch vụ trả tiền).
- Ảnh banner nhiều tỉ lệ.

**Giới hạn đạo đức bắt buộc:** không tạo ảnh làm sai lệch hình dáng/màu sắc/chất liệu thật của
sản phẩm; không tạo ảnh giả người thật, thương hiệu thật, hay bằng chứng không có thật.

---

## Sprint độ tin cậy R1 — ĐÃ MERGE (07/10/2026)

PR [#24](https://github.com/thanhbn123/studio/pull/24), merge `584ef6a`. Bịt ba lỗ hổng vận hành:
**hàng đợi bền trong DB** (restart không mất việc) · **khoá tiền ở tầng DB** (SQLite + PostgreSQL,
đo 2 tiến trình thật) · **cron** dọn lượt ví treo/việc chết **và nhặt việc đang chờ**. Phản biện độc lập
**3 vòng** (FAIL → PASS CÓ ĐIỀU KIỆN → PASS CÓ ĐIỀU KIỆN sau khi vá A1–A6 + B1–B3): báo cáo
[`R1-REVIEW.md`](R1-REVIEW.md) · hợp đồng [`R1-RELIABILITY-CONTRACT.md`](R1-RELIABILITY-CONTRACT.md).
Test: **986 · 985 pass · 0 fail · 1 skipped** · CI 5/5. Giới hạn còn lại: [`VERIFICATION.md`](VERIFICATION.md) §22.7.

## MVP-04 — Video Studio

**Trạng thái: PHẦN OFFLINE ĐÃ MERGE VÀO `develop`** (PR [#23](https://github.com/thanhbn123/studio/pull/23), merge commit `af2b2da`, 07/10/2026) **— CHỜ OWNER NGHIỆM THU.**

Bằng chứng: **929 test · 928 pass · 0 fail · 1 skipped** · `node tools/verify.mjs` EXIT=0 · **CI 5/5 xanh** · **5 vòng phản biện độc lập** (FAIL → FAIL → PASS CÓ ĐIỀU KIỆN → FAIL → PASS CÓ ĐIỀU KIỆN, điều kiện cuối đã vá). Video mẫu: [`assets/mvp04-video-mau.gif`](assets/mvp04-video-mau.gif). Hồ sơ: [`MVP-04-ACCEPTANCE.md`](MVP-04-ACCEPTANCE.md) · hợp đồng: [`MVP-04-CONTRACT.md`](MVP-04-CONTRACT.md) · phản biện: [`MVP-04-REVIEW.md`](MVP-04-REVIEW.md).

Đã làm (offline, không dịch vụ trả tiền, không cần `ffmpeg`):
- **GIF động** với bộ nén **LZW tự viết** — kiểm bằng `file`, `sips` (ImageIO), ImageMagick và **decoder Python độc lập** (khớp pixel).
- **Chữ Việt** trên video (engine font MVP-02), **3 tỉ lệ 9:16 · 1:1 · 16:9** (pad/crop, **không bóp méo**),
  chuyển cảnh cut/fade, zoom/pan, **nhiều ảnh ⇒ nhiều cảnh** đúng thứ tự gửi.
- **Chống bịa**: chữ khẳng định/số liệu thiếu bằng chứng ⇒ **422, 0 pixel chữ** — đã bịt 5 vòng nguỵ trang
  (không dấu, homoglyph Cyrillic/Hy Lạp, full-width, dấu câu chen trong cụm, dính chữ, lookalike Latin,
  cụm bị tách sang nhiều mục/cảnh); đồng thời **hết chặn oan** chữ lành.
- Tab thứ tư **“Video”** + 5 route `/api/videostudio/*` + usage `VIDEO_RENDER`/`VIDEO_ENCODE` thu **theo lượt**.

Giới hạn THẬT: **video KHÔNG có tiếng** (GIF không chứa âm thanh — mọi kết quả đều nói rõ) ·
**chưa có MP4/H.264** (cần `ffmpeg`/dịch vụ; provider fail-closed, chưa đo được) · GIF ≤ 256 màu/khung ·
nhịp phát thật có thể lệch −4% (đã ghi `playback_ms`/`requested_ms`) · chỉ nhận PNG ·
chưa đo PostgreSQL cho job video / trình duyệt thật / nhiều video 30s song song.

Còn lại của MVP-04 (cần trả tiền): voice-over TTS tiếng Việt · nhạc nền · kết xuất MP4 · phụ đề tự động.

## MVP-04 — Video Studio

**Mục tiêu:** dựng video bán hàng ngắn từ ảnh + nội dung đã sinh ở MVP-01.

Phạm vi dự kiến:
- Ghép ảnh thành video có nhịp, có chữ, có nhạc nền.
- Sinh lời thoại từ `tiktok_caption` / `selling_points` đã có.
- Voice-over tiếng Việt, phụ đề tự động.
- Kết xuất nhiều tỉ lệ (9:16, 1:1, 16:9).

Điểm nối đã có: `main_video` trong Product Master đã có sẵn trường và trạng thái.

---

## MVP-05 — Customer Accounts + Credit

**Trạng thái: ĐÃ XONG PHẦN CODE, CHỜ MERGE + OWNER NGHIỆM THU** (PR [#22](https://github.com/thanhbn123/studio/pull/22), nhánh `feat/mvp05-accounts`, commit cuối `dcd429e`, 06/10/2026).

Bằng chứng: **849 test · 848 pass · 0 fail · 1 skipped** · `node tools/verify.mjs` EXIT=0 · **CI 5/5 xanh** · **4 vòng phản biện độc lập** (FAIL → FAIL → PASS CÓ ĐIỀU KIỆN → **PASS**, đo lại trên **SQLite và PostgreSQL 16 thật**) với **11 lỗ hổng vòng đời tiền** đã vá: giữ tiền rồi lỗi mà không hoàn · chạy lại **miễn phí** · **thu thừa theo usage tích luỹ (+150%)** · không có đường tạo owner đầu tiên · hoàn luôn phần đã tiêu · khoá cấu hình chết · grant `1e308` ghi dòng 0 · UI mời số âm mà API chối · chống brute-force mỏng · **kẹt lượt 409 vĩnh viễn** · thu lại usage đã hoàn · reconcile cắt ngang lượt đang chạy. Hồ sơ: [`MVP-05-ACCEPTANCE.md`](MVP-05-ACCEPTANCE.md) · [`MVP-05-CONTRACT.md`](MVP-05-CONTRACT.md) · [`MVP-05-REVIEW.md`](MVP-05-REVIEW.md).

Đã làm: tài khoản thật (scrypt, token chỉ lưu sha256, cookie HttpOnly) · ví credit **append-only** (số dư = tổng sổ, không bao giờ âm, mọi dòng có `reason`/`job_id`/`run_key`/`balance_after`) · **chặn 402 TRƯỚC khi chạy** (DB không tăng) · lỗi sau khi giữ tiền ⇒ hoàn · **mỗi lượt chạy lại thu đúng chi phí lượt đó** + trần 429 · tách dữ liệu theo tài khoản (khác chủ ⇒ 404) · **ẩn danh không bị phá** · `#/dangnhap` · `#/taikhoan` · `#/quantri` · `OWNER_EMAIL` + `npm run make-owner`.

Giới hạn THẬT: khoá tiền **trong bộ nhớ** (1 tiến trình) · reconcile **không có cron** · **thu thiếu có chủ ý** với usage đến muộn · chưa đo đa tiến trình tầng HTTP / proxy / provider thật / trình duyệt thật · **chưa có cổng thanh toán** (MVP-06).

## MVP-05 — Customer Accounts + Credit

**Mục tiêu:** nhiều người dùng, mỗi người có ví credit.

Phạm vi dự kiến:
- Đăng nhập, phân quyền, tách dữ liệu theo tài khoản.
- Ví credit: nạp, trừ theo `estimated_cost` của từng `usage_event`.
- Bảng giá theo operation; hạn mức theo gói.
- Trang quản trị: xem usage, hoàn credit khi job lỗi.

**Điểm nối đã có và cần thay:**
- `session_id` hiện chỉ để **phân vùng lịch sử**, KHÔNG phải xác thực. MVP-05 phải thay bằng
  tài khoản thật và chuyển `jobs.session_id` thành `user_id` (có migration).
- `MemoryRateLimiter` phải đổi sang bản Redis khi chạy nhiều instance.

---

## MVP-06 — Nạp credit THỦ CÔNG (chuyển khoản tay + quản trị cấp credit)

**Trạng thái: ĐÃ XONG PHẦN CODE theo PHẠM VI ĐÃ CHỐT** (nhánh `thanhbn123/mvp06-topup`,
09/10/2026). Hợp đồng: [`MVP-06-CONTRACT.md`](MVP-06-CONTRACT.md); bằng chứng số đo:
[`VERIFICATION.md` §26](VERIFICATION.md).

**Quyết định của Owner (09/10/2026):** pháp nhân là **cá nhân** ⇒ dùng **chuyển khoản ngân hàng
tay + quản trị viên cấp credit**. Vì vậy MVP-06 bản gốc (cổng thanh toán, webhook có kiểm chữ ký,
hoá đơn, hoàn tiền tự động) **HOÃN VÔ THỜI HẠN** — xem `OWNER-DECISIONS.md`.

Đã làm (phạm vi đã chốt): bảng `topup_requests` + `topup_events` (index tạo SAU migration) ·
`src/billing/topup.js` · 4 route `/api/billing/topup-requests*` (tạo / xem / XÁC NHẬN / TỪ CHỐI) ·
`/api/config.billing.topup` (tỷ giá + khoảng tiền + hướng dẫn chuyển khoản **lấy từ cấu hình**) ·
UI tab **Tài khoản** (form nạp + hướng dẫn chuyển khoản, KHÔNG hardcode số tài khoản) và tab
**Quản trị** (danh sách `pending` + XÁC NHẬN/TỪ CHỐI kèm lý do) · 45 test mới
(`test/topup-*.test.js`).

Ba luật được giữ và đo được: tạo yêu cầu **KHÔNG đụng ví** · xác nhận ⇒ **đúng 1** dòng sổ qua
`withLedgerLock` (xác nhận lần hai ⇒ 409 `TOPUP_ALREADY_DECIDED`, sổ không đổi) · tỷ giá
VND/credit **ghi lại tại thời điểm duyệt**.

**CHƯA làm (có chủ ý, theo quyết định của Owner):** chưa có cổng thanh toán · chưa có webhook
ngân hàng (hệ thống **không tự biết** tiền đã về) · chưa có hoá đơn · chưa đối soát tự động với
sao kê · chưa tự hết hạn yêu cầu `pending` (`expired` có trong lược đồ nhưng **không có cron**
nào chuyển trạng thái) · chưa có thông báo email/Zalo khi yêu cầu được duyệt.

### MVP-06 bản gốc — Payments (HOÃN)

**Mục tiêu:** thu tiền thật.

Phạm vi dự kiến: cổng thanh toán (thẻ/chuyển khoản/ví điện tử), hoá đơn, đối soát, hoàn tiền,
webhook thanh toán có kiểm chữ ký.

**Phụ thuộc:** cần Owner quyết nhà cung cấp thanh toán và **pháp nhân doanh nghiệp** nhận tiền
trước khi bắt đầu (hiện tại pháp nhân là cá nhân ⇒ chưa đủ điều kiện).

---

## MVP-07 — Facebook / TikTok Publisher

**Mục tiêu:** đăng bài tự động lên Facebook Page và TikTok.

Phạm vi dự kiến:
- OAuth kết nối tài khoản; lưu token vào secret storage (**không** vào DB dạng thô).
- Lên lịch đăng, hàng đợi, thử lại, báo lỗi.
- Duyệt trước khi đăng (bắt buộc ở giai đoạn đầu).

**Phụ thuộc:** cần app review / account approval từ Meta và TikTok — đây là blocker bên ngoài,
phải tính vào thời gian.

---

## MVP-08 — Marketplace Publisher

**Mục tiêu:** đăng sản phẩm lên Shopee / TikTok Shop.

Phạm vi dự kiến:
- Kết nối API sàn, map Product Master → schema của sàn.
- Đồng bộ tồn kho và giá.
- Xử lý lỗi theo từng sàn, không để một sàn hỏng làm hỏng luồng chung
  (cùng nguyên tắc cô lập như `ConnectorRegistry`).

**Phụ thuộc:** cần tài khoản người bán đã được duyệt và quyền gọi API của từng sàn.

---

## Việc kỹ thuật nên làm xen giữa các giai đoạn

| Việc | Vì sao | Khi nào |
|---|---|---|
| Thay rate-limit trong bộ nhớ bằng Redis | nhiều instance thì bộ đếm trong bộ nhớ vô nghĩa | trước MVP-06 |
| Hàng đợi job bền (BullMQ/Redis) | job mất khi tiến trình restart | trước MVP-05 |
| Xác thực + phân quyền thật | `session_id` hiện không phải bảo mật | MVP-05 |
| Proxy rotation cho 1688/Taobao | 1688 chặn theo IP rất nhanh | khi có nhu cầu volume |
| Theo dõi chi phí AI theo ngày | tránh vượt ngân sách | trước MVP-06 |
| Sao lưu & phục hồi DB | dữ liệu job là tài sản | trước MVP-05 |
