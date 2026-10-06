# MVP-05 — HỒ SƠ NGHIỆM THU (dành cho Owner)

> Để anh **tự chạy và tự kiểm** rồi ký — không phải tin lời kể của agent.
> Số liệu lấy từ lệnh chạy thật trên máy anh ngày **06/10/2026**.

- Nhánh: `feat/mvp05-accounts` → PR [#22](https://github.com/thanhbn123/studio/pull/22) vào `develop`
- Bộ test: **826 test · 825 pass · 0 fail · 1 skipped** · `node tools/verify.mjs` EXIT=0
- CI: **5/5 job PASS** (Linux · PostgreSQL 16 · smoke server thật · Docker · quét secret)
- Phản biện độc lập: vòng 1 **FAIL** (4 lỗi CAO về **vòng đời tiền**) → đã vá hết → vòng 2 (đang chấm)
  — nguyên văn: [`MVP-05-REVIEW.md`](MVP-05-REVIEW.md)

---

## 1. Làm gì

Thay `session_id` (vốn **không phải xác thực** — `docs/VERIFICATION.md` §8.2 đã ghi rõ) bằng **tài khoản
thật**, **ví credit**, tách dữ liệu theo người dùng, và trang quản trị.

**Luật quan trọng nhất: người chưa đăng nhập vẫn dùng được mọi thứ.** Đăng nhập là **tuỳ chọn** — dán
link là chạy vẫn hoạt động; chỉ khi đăng nhập thì job mới gắn với tài khoản và mới trừ credit.

---

## 2. Ba lệnh anh chạy

```bash
npm test          # 826 test · 825 pass · 0 fail · 1 skipped
npm run verify    # kiểm cú pháp + test → EXIT 0
npm start         # http://127.0.0.1:3000
```

**Tạo tài khoản quản trị đầu tiên** (bắt buộc, nếu không sẽ không ai cấp được credit):

```bash
npm run make-owner -- anh@example.com
# → in ra MẬT KHẨU TẠM đúng một lần; đăng nhập rồi đổi sau
```

Hoặc đặt `OWNER_EMAIL=anh@example.com` trong `.env` rồi khởi động — hệ thống tự nâng/tạo owner khi
chưa có owner nào (và **cảnh báo** nếu hệ thống đang có 0 owner).

Trên giao diện: **Đăng nhập** → **Tài khoản** (số dư + lịch sử sổ + bảng giá) → **Quản trị**
(cấp credit, đổi vai trò, xem usage theo ngày/thao tác/người).

---

## 3. Checklist nghiệm thu

| # | Điều cần kiểm | Cách kiểm | Kỳ vọng | ☐ |
|---|---|---|---|---|
| 1 | Test xanh | `npm test` | 825 pass · 0 fail · 1 skip | ☐ |
| 2 | Verify xanh | `npm run verify` | EXIT 0 | ☐ |
| 3 | **Ẩn danh KHÔNG bị chặn** | chưa đăng nhập, dán link 1688 rồi chạy | job chạy được, ví **không** bị trừ | ☐ |
| 4 | Đăng ký / đăng nhập | `#/dangnhap` | đăng ký xong tự đăng nhập; sai mật khẩu báo chung một câu | ☐ |
| 5 | **Tạo owner đầu tiên** | `npm run make-owner -- <email>` | đăng nhập được, vào `#/quantri` được | ☐ |
| 6 | Cấp credit | `#/quantri` → cấp credit | số dư đổi **ngay**, có dòng sổ ghi rõ ai cấp | ☐ |
| 7 | **Chặn trước khi chạy khi hết credit** | để ví 0 rồi chạy job | báo **402** rõ số cần/số có, **không** job nào được tạo | ☐ |
| 8 | **Chạy lại phải trả tiền** | bấm “chạy lại/chạy lại với tham số khác” 2–3 lần | số dư **giảm mỗi lượt**, không có lượt miễn phí | ☐ |
| 9 | **Lỗi thì hoàn tiền** | cố tình gây lỗi sau khi bắt đầu (ví dụ dùng vùng nhập tay cho job không có ảnh) | số dư **về như cũ**, có dòng `job_refund` | ☐ |
| 10 | **Không đọc được dữ liệu người khác** | đăng nhập tài khoản B, mở link job của A | **404** (không xác nhận tồn tại) | ☐ |
| 11 | Sổ đối soát được | `#/taikhoan` | số dư = tổng các dòng sổ; mọi dòng có lý do + số dư sau | ☐ |
| 12 | Nhãn trung thực | `#/taikhoan` | ghi rõ “credit nội bộ, chưa có cổng thanh toán” | ☐ |

---

## 4. Những gì nghiệm thu này **KHÔNG** bao gồm (nói thẳng)

1. **Chưa có cổng thanh toán** — đây là **MVP-06**, cần anh quyết nhà cung cấp + pháp nhân nhận tiền.
   Credit ở MVP-05 **chỉ do quản trị cấp tay** (có ghi sổ, không sửa/xoá dòng).
2. **Khoá tuần tự hoá tiền nằm trong bộ nhớ** (đúng khi chạy **1 tiến trình**). Chạy nhiều instance
   cần khoá ở tầng DB — đã ghi `docs/VERIFICATION.md`.
3. **Retry tự động của hàng đợi** ngay sau lỗi có thể chạy khi dòng hoàn tiền của lượt trước chưa ghi
   ⇒ hook coi là **cùng lượt** (không mở hold mới). Đã ghi `§16.6`; cần hàng đợi chờ `afterJob` xong.
4. **Chưa đo**: PostgreSQL thật cho các bảng mới (CI mới chứng minh **schema + migration**), reverse
   proxy thật (`trust proxy`), provider thật, trình duyệt thật (UI chạy hàm thật trong Node).
5. **Chưa có**: đổi/quên mật khẩu, xác thực email, 2FA, chuyển credit giữa người dùng, hoá đơn.
6. **Không phải chuẩn kế toán**: tiền làm tròn **6 chữ số** theo quy ước của repo.

---

## 5. Ký nghiệm thu

| | |
|---|---|
| Người nghiệm thu | Owner (anh) |
| Ngày | .......................... |
| Phán quyết | ☐ ĐẠT · ☐ CẦN SỬA (ghi rõ bên dưới) |
| Ghi chú | |

**Sau khi ĐẠT**, thứ tự đề xuất: phần **offline của MVP-04 (video từ ảnh + chữ)** → rồi tới các phần
cần anh quyết (**MVP-06 thanh toán**, **MVP-07/08 đăng bài lên Facebook/TikTok/Shopee**).
