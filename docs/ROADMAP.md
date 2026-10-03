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

**Trạng thái: ĐÃ TRIỂN KHAI trên nhánh `feat/mvp02-imagelab` — CHỜ OWNER NGHIỆM THU.**

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

**Mục tiêu:** tạo ảnh marketing từ ảnh sản phẩm thật (nền sạch, ảnh đời sống, ảnh banner).

Phạm vi dự kiến:
- Tách nền sản phẩm, thay nền theo bộ mẫu.
- Sinh ảnh bối cảnh (lifestyle) từ ảnh sản phẩm thật.
- Retouch: cân sáng, làm sạch, giữ trung thực với sản phẩm.

**Giới hạn đạo đức bắt buộc:** không tạo ảnh làm sai lệch hình dáng/màu sắc/chất liệu thật của
sản phẩm; không tạo ảnh giả người thật, thương hiệu thật, hay bằng chứng không có thật.

---

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

## MVP-06 — Payments

**Mục tiêu:** thu tiền thật.

Phạm vi dự kiến: cổng thanh toán (thẻ/chuyển khoản/ví điện tử), hoá đơn, đối soát, hoàn tiền,
webhook thanh toán có kiểm chữ ký.

**Phụ thuộc:** MVP-05 phải xong trước. Cần Owner quyết nhà cung cấp thanh toán và pháp nhân
nhận tiền trước khi bắt đầu.

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
