# MVP-06 — NẠP CREDIT THỦ CÔNG (HỢP ĐỒNG ĐÓNG BĂNG)

> **Quyết định của Owner (09/10/2026):** dùng **chuyển khoản ngân hàng + quản trị cấp credit tay**.
> **KHÔNG** tích hợp cổng thanh toán, **KHÔNG** pháp nhân, **KHÔNG** hoá đơn ở giai đoạn này.
> Pháp nhân = **cá nhân**. Vì vậy MVP-06 bản gốc (cổng thanh toán, webhook, hoàn tiền tự động)
> **hoãn vô thời hạn** — ghi ở `docs/OWNER-DECISIONS.md`.

## 0. Ba luật riêng

1. **Không tự cộng tiền.** Credit chỉ vào ví qua **một** đường: quản trị viên gọi `grant()`.
   Hệ thống **không** bao giờ tự cộng khi thấy “có tiền vào tài khoản” (không có ngân hàng nào kết nối).
2. **Yêu cầu nạp phải có vết.** Mọi yêu cầu nạp tiền là một **bản ghi** (`topup_requests`) có trạng thái
   và **không** được sửa/xoá (chỉ chuyển trạng thái, mỗi lần chuyển ghi `topup_events`).
3. **Số tiền trên yêu cầu ≠ tiền trong ví.** Ví tính bằng **credit**; tỷ giá (VND/credit) là **dữ liệu
   cấu hình**, ghi lại **tại thời điểm duyệt** (đổi tỷ giá sau không làm sai lịch sử).

## 1. Bản đồ sở hữu file

| Phần | File |
|---|---|
| Nghiệp vụ | `src/billing/topup.js` (mới) |
| Bảng | `src/store/schema.sql` (`topup_requests`, `topup_events`) + migration cộng thêm (**index tạo SAU migration**) |
| API | `src/http/routes.js` (chỉ thêm) |
| UI | `public/app.js`, `public/index.html`, `public/styles.css` (tab **Tài khoản/Quản trị**) |
| Test | `test/topup-*.test.js` |

## 2. Dữ liệu

`topup_requests`: `id`, `user_id` (NULL cho ẩn danh — không cho nạp), `amount_vnd INTEGER`,
`credits REAL`, `rate_vnd_per_credit REAL`, `method` (`bank_transfer`), `reference` (mã giao dịch ngân hàng,
người dùng nhập), `note`, `status` (`pending|confirmed|rejected|expired`), `created_at`, `decided_at`,
`decided_by`, `ledger_entry_id` (dòng sổ sinh ra khi `confirmed`), `run_key` (chống cộng 2 lần).

`topup_events`: `id`, `request_id`, `from_status`, `to_status`, `actor_user_id`, `reason`, `created_at`.

## 3. API (chỉ THÊM)

```
POST /api/billing/topup-requests            (đã đăng nhập) {amount_vnd, reference, note} → 201 {request}
GET  /api/billing/topup-requests            (chính chủ: của mình; admin: tất cả, lọc ?status=)
POST /api/billing/topup-requests/:id/confirm (CHỈ admin) {credits?, note?} → 200 {request, ledger}
POST /api/billing/topup-requests/:id/reject  (CHỈ admin) {reason} → 200 {request}
GET  /api/config.billing                     thêm {rate_vnd_per_credit, min_topup_vnd, max_topup_vnd}
```
Luật: ẩn danh ⇒ **401**; khác chủ ⇒ **404**; `amount_vnd` ngoài `[min,max]` ⇒ **400
`TOPUP_AMOUNT_OUT_OF_RANGE`**; xác nhận 2 lần ⇒ **409 `TOPUP_ALREADY_DECIDED`** (idempotent theo
`run_key = topup:<request_id>`); xác nhận ⇒ **một** dòng sổ qua `withLedgerLock` + tôn trọng trần
`BILLING_MAX_BALANCE` (**400 `AMOUNT_TOO_LARGE`**); `reference` trùng của **cùng** người dùng ⇒
**409 `TOPUP_REFERENCE_DUPLICATE`** (chống khai khống).

## 4. UI

Tab **Tài khoản**: form “Nạp credit” (số tiền VND, mã giao dịch, ghi chú) + **hướng dẫn chuyển khoản
do quản trị đặt** (số tài khoản lấy từ cấu hình, **không** hardcode) + bảng yêu cầu của mình.
Tab **Quản trị**: danh sách yêu cầu `pending` + nút **XÁC NHẬN** (hiện số credit sẽ cộng + tỷ giá đang
dùng) / **TỪ CHỐI** (bắt buộc lý do). Nói thật: **“Tiền vào ví chỉ sau khi quản trị xác nhận — hệ thống
không tự biết tiền đã về tài khoản.”**

## 5. Định nghĩa XONG

- Ẩn danh không tạo được yêu cầu; người dùng chỉ thấy yêu cầu của mình; admin thấy tất cả.
- Xác nhận ⇒ **đúng 1** dòng sổ, số dư tăng đúng `credits`, `balance_after` liên tục; xác nhận lại ⇒ 409, sổ không đổi.
- Từ chối ⇒ **không** dòng sổ nào, có lý do trong `topup_events`.
- Đổi tỷ giá sau khi duyệt ⇒ yêu cầu **cũ** giữ nguyên `rate_vnd_per_credit` đã ghi.
- `npm test` xanh; có test cho: 2 lần xác nhận, trần số dư, trùng `reference`, và **không** cộng tiền khi chỉ tạo yêu cầu.
