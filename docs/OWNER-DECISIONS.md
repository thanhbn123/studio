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

## 4. Việc kỹ thuật còn nợ — ĐÃ XONG sprint R1 (07/10/2026)

Sprint độ tin cậy **R1** đã merge (PR [#24](https://github.com/thanhbn123/studio/pull/24), merge `584ef6a`):

| Việc | Kết quả |
|---|---|
| Hàng đợi bền (không mất việc khi restart) | ✅ `job_queue` trong DB + `resume()` + retry + trần lượt thử (đo: kill -9 ⇒ chạy lại, không mất việc) |
| Khoá tiền ở tầng DB (nhiều tiến trình) | ✅ SQLite `BEGIN IMMEDIATE` · PostgreSQL `pg_advisory_xact_lock`; đo 2 tiến trình trên **cả SQLite và PG thật**: 0 dòng âm, 0 lỗi khoá |
| Cron thu hồi lượt treo + việc chết | ✅ `src/scheduler.js` mỗi nhịp dọn **và nhặt việc đang chờ**; `/api/health` có khối `scheduler` |

Còn lại (đã ghi `docs/VERIFICATION.md` §22.7 — **giới hạn vận hành, không phải lỗi mã**):

- **SQLite vẫn là một khoá ghi toàn cục** ⇒ trần chờ liên tiến trình = `số lần thử × lockTimeoutMs`
  (tệ nhất ~31,5s mặc định; giảm bằng `BILLING_LOCK_TIMEOUT_MS` / `QUEUE_LOCK_TIMEOUT_MS`). PostgreSQL giữ khoá **per-user**.
- **Mô hình lease**: nếu tiến trình bị `SIGSTOP`/máy ngủ, **hai tiến trình có thể cùng THỰC THI** một mục
  ⇒ tiền/trạng thái đã fenced (không mất/không tạo tiền) nhưng **chi phí provider có thể nhân đôi**.
  4 cách giảm đã ghi trong tài liệu (heartbeat dày hơn, `QUEUE_STALE_MS` lớn hơn, idempotency key phía provider, chỉ gọi provider khi còn lease).
- Tham số request (`force`, `only_region_ids`, `options`) **không được lưu** ⇒ lượt khôi phục sau restart dùng **mặc định an toàn**.
- Chưa đo: nhiều tiến trình PostgreSQL cho lease/epoch · mất điện/fsync · tải lớn · UI trên trình duyệt thật.

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
