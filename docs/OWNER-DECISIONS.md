# CÁC PHẦN CÒN LẠI — CẦN OWNER QUYẾT (không tự làm)

Cập nhật: 07/10/2026 · Sau khi **MVP-01, MVP-02 (+IL-08), MVP-03, MVP-05** đã merge vào `develop`, và
**MVP-04 (phần offline)** vừa merge.

Tài liệu này liệt kê **đúng những việc còn lại** và **cái anh cần quyết** trước khi làm — vì chúng
đụng **tiền thật**, **tài khoản bên ngoài**, hoặc **pháp nhân**. Agent **không tự làm** các việc này.

---

## 1. Đo provider THẬT (tốn tiền)

| Việc | Cần gì | Vì sao cần anh quyết |
|---|---|---|
| OCR thật (đọc chữ trên ảnh sản phẩm Trung) | API key + ngân sách | Hiện `OCR_PROVIDER=mock` trả vùng chữ của **fixture cố định**; muốn dùng ảnh thật thì phải cắm provider thật **hoặc** dùng đường **nhập vùng tay (IL-08)** đã có |
| Dịch thật (Trung → Việt) | API key (`.env` đang có `AI_PROVIDER=deepseek`) | Đã có abstraction + guardrails; **chưa đo** chất lượng/chi phí thật |
| Tách nền thật (ảnh nền phức tạp) | dịch vụ matting/AI | Bản offline chỉ hợp **nền đồng nhất**; nền cảnh thật bị từ chối (đúng luật fail-closed) |
| Voice-over tiếng Việt + nhạc nền (MVP-04) | dịch vụ TTS | Video hiện **KHÔNG có tiếng**; đây là phần trả tiền |

**Câu hỏi cho anh:** anh muốn (a) chưa cắm provider nào, tiếp tục dùng mock + nhập tay; (b) cắm **một**
provider để đo trên ảnh thật (em cần biết ngân sách/tháng); hay (c) cắm đủ bộ (OCR + dịch + matting + TTS)?

---

## 2. MVP-06 — Thanh toán (cần quyết trước khi viết)

Hiện trạng: credit là **ví nội bộ**, chỉ **quản trị cấp tay**, sổ **append-only** (số dư = tổng sổ,
không bao giờ âm, mọi dòng có lý do + job + số dư sau). **Chưa có cổng thanh toán.**

**Anh cần quyết:**
1. **Nhà cung cấp**: Stripe / PayOS / VNPay / MoMo / chuyển khoản tay? (ảnh hưởng tới luồng nạp, phí, thời gian đối soát)
2. **Pháp nhân nhận tiền**: cá nhân hay công ty? (ảnh hưởng hoá đơn, thuế, điều khoản)
3. **Đơn vị tiền & giá**: bán theo **credit** hay theo **gói**? tỉ giá credit ↔ VND?
4. **Hoàn tiền**: chính sách khi job lỗi (hiện hệ thống **tự hoàn** khi job failed).
5. **Có xuất hoá đơn không?**

Khi có 1–5, em viết hợp đồng giao diện MVP-06 (webhook, đối soát, chống double-credit, idempotency)
rồi mới code — **không** tự chọn nhà cung cấp thay anh.

---

## 3. MVP-07/08 — Đăng bài lên Facebook / TikTok / Shopee (cần tài khoản được duyệt)

Hiện trạng: nội dung (MVP-01), ảnh (MVP-02/03), video (MVP-04), tài khoản + ví (MVP-05) đã có. **Chưa
đăng đi đâu cả.**

**Anh cần quyết / chuẩn bị:**
1. **Nền tảng nào trước**: Facebook Page · TikTok · Shopee? (mỗi nền tảng một thủ tục riêng)
2. **Tài khoản & quyền**: Page ID, TikTok Business, Shopee Open Platform — cần **app review** của họ
   (có thể mất ngày–tuần), và **token** do anh cấp.
3. **Chế độ đăng**: tự động hoàn toàn, hay **duyệt tay từng bài** trước khi đăng? (em khuyến nghị duyệt tay)
4. **Chính sách nội dung**: có giới hạn gì về ngành hàng/câu chữ không (để em cấu hình chặn trước khi đăng).

**Nguyên tắc em sẽ giữ:** không bao giờ tự đăng khi chưa được duyệt; mọi lần đăng đều có **log + idempotency**
(tránh đăng trùng); lỗi từ nền tảng phải hiện **nguyên văn**, không nuốt.

---

## 4. Việc kỹ thuật còn nợ (không cần anh quyết, em có thể làm tiếp khi anh muốn)

| Việc | Vì sao chưa làm |
|---|---|
| Hàng đợi bền (queue) + retry có kiểm soát | Hiện queue trong bộ nhớ: khởi động lại là mất việc đang chờ; MVP-05 đã ghi rõ giới hạn này |
| Khoá tiền ở tầng DB cho nhiều tiến trình | Hiện khoá trong bộ nhớ ⇒ đúng khi chạy **1 instance** |
| Cron thu hồi lượt treo (MVP-05) | Hiện chỉ chạy lúc khởi động / request kế tiếp / route admin |
| Đo trên trình duyệt thật (DOM) | UI đã kiểm bằng hàm thật trong Node, chưa chạy Selenium/Playwright |
| PostgreSQL cho mọi bảng mới | CI đã chạy schema + migration trên PG thật, nhưng test nghiệp vụ vẫn SQLite |

---

## 5. Trạng thái tổng (nghiệm thu được ngay)

| Giai đoạn | Trạng thái | Hồ sơ |
|---|---|---|
| MVP-01 Nội dung | ✅ đã merge | `VERIFICATION.md` |
| MVP-02 Dịch ảnh (+ IL-08 nhập vùng tay) | ✅ đã merge | [`MVP-02-ACCEPTANCE.md`](MVP-02-ACCEPTANCE.md) |
| MVP-03 Tạo ảnh | ✅ đã merge | [`MVP-03-ACCEPTANCE.md`](MVP-03-ACCEPTANCE.md) |
| MVP-04 Video (offline) | ✅ đã merge | [`MVP-04-ACCEPTANCE.md`](MVP-04-ACCEPTANCE.md) |
| MVP-05 Tài khoản + ví credit | ✅ đã merge | [`MVP-05-ACCEPTANCE.md`](MVP-05-ACCEPTANCE.md) |
| MVP-06 Thanh toán | ⛔ **chờ anh quyết** (mục 2) | — |
| MVP-07/08 Đăng bài | ⛔ **chờ anh quyết** (mục 3) | — |

**Một câu hỏi gọn cho anh:** anh muốn em (1) làm tiếp **việc kỹ thuật còn nợ** ở mục 4, (2) cắm
**provider thật** ở mục 1 để đo trên ảnh/ video thật, hay (3) dừng code để **anh nghiệm thu** 4 hồ sơ
MVP-02/03/04/05 trước?
