# MVP-03 — HỒ SƠ NGHIỆM THU (dành cho Owner)

> Để anh **tự chạy và tự nhìn** trong vài phút rồi ký nghiệm thu — không phải tin lời kể của agent.
> Số liệu lấy từ lệnh chạy thật trên máy anh ngày **04/10/2026**.

- Nhánh: `feat/mvp03-imagestudio` → PR [#21](https://github.com/thanhbn123/studio/pull/21) vào `develop`
- Bộ test: **698 test · 697 pass · 0 fail · 1 skipped** · `node tools/verify.mjs` EXIT=0
- CI: **5/5 job PASS** (Linux · PostgreSQL 16 · smoke server thật · Docker · quét secret)
- Phản biện độc lập: vòng 1 **FAIL** (1 CRITICAL + 1 MAJOR + 4 MINOR) → đã vá hết → vòng 2 (đang chấm)
  — nguyên văn: [`MVP-03-REVIEW.md`](MVP-03-REVIEW.md)

---

## 1. Ba lệnh anh chạy

```bash
npm test                # 698 test · 697 pass · 0 fail · 1 skipped
npm run verify          # kiểm cú pháp + test → EXIT 0
npm start               # http://127.0.0.1:3000 → tab thứ ba "Tạo ảnh"
```

Trên giao diện: kéo-thả ảnh PNG → chọn **mẫu nền** (mỗi mẫu có badge *MÔ PHỎNG*) → kéo thanh trượt
độ sáng/tương phản/bão hoà/nét (không vượt được ngưỡng) → (tuỳ chọn) nhập chữ overlay → **TẠO ẢNH**
→ xem **TRƯỚC | SAU** và mọi cảnh báo.

---

## 2. Điều đáng nhìn: ảnh TRƯỚC | SAU

![Ảnh sản phẩm mô phỏng trước và sau khi tạo ảnh](assets/mvp03-truoc-sau.png)

> Ảnh mẫu do máy sinh (nền trắng + khối “sản phẩm” xanh). Nhìn trái→phải: nền trắng được **thay bằng
> gradient xanh** (mẫu `gradient-xanh`, khai `synthetic: true`), **sản phẩm giữ nguyên hình dạng,
> vị trí và kích thước**, độ bão hoà nhích nhẹ theo tham số.

---

## 3. Checklist nghiệm thu

| # | Điều cần kiểm | Cách kiểm | Kỳ vọng | ☐ |
|---|---|---|---|---|
| 1 | Test xanh | `npm test` | 697 pass · 0 fail · 1 skip | ☐ |
| 2 | Verify xanh | `npm run verify` | EXIT 0 | ☐ |
| 3 | Tab “Tạo ảnh” chạy được | `npm start` → tab 3 | tạo ảnh ra kết quả + ảnh TRƯỚC\|SAU | ☐ |
| 4 | **Ảnh gốc bất biến** | tạo ảnh xong, mở lại ảnh gốc | không đổi; hệ thống báo “ảnh gốc không đổi” | ☐ |
| 5 | **Sản phẩm không bị méo** | so ảnh trước/sau | cùng khung hình, hình dạng/vị trí sản phẩm y hệt | ☐ |
| 6 | **Nền là MÔ PHỎNG và có khai** | nhìn nhãn trên UI + `asset.meta.template.synthetic` | luôn `synthetic: true` + chữ “MÔ PHỎNG” | ☐ |
| 7 | **Retouch bị kẹp ngưỡng** | kéo thanh trượt hết cỡ | không vượt ngưỡng; nếu server kẹp thì hiện tên tham số + giá trị hiệu lực | ☐ |
| 8 | **Tách nền fail-closed** | thử ảnh nền lộn xộn (ảnh chụp cảnh) | báo “không tách được nền” + số đo, **vẫn** retouch, không cắt bừa | ☐ |
| 9 | **Overlay bịa bị chặn** | nhập chữ `Bảo hành 12 tháng` khi ảnh/tên chưa có | **422**, không vẽ chữ nào, hiện lý do + vi phạm | ☐ |
| 10 | Nhãn trung thực | `/api/config` + UI | `matting.is_mock` đúng sự thật; **không** có nhãn `LIVE_VERIFIED` | ☐ |
| 11 | Tài liệu trung thực | [`VERIFICATION.md`](VERIFICATION.md) §13 | có mục “còn thiếu / chưa đo” nói thẳng | ☐ |

---

## 4. Những gì nghiệm thu này **KHÔNG** bao gồm (nói thẳng)

1. **Tách nền chỉ hợp ảnh NỀN ĐỒNG NHẤT** (ảnh studio, nền trắng/xám phẳng). Nền gradient, ảnh chụp
   cảnh thật, sản phẩm có bóng đổ mềm ⇒ hệ thống **TỪ CHỐI** kèm số đo và chỉ retouch — **không có
   matting AI**. Đây là giới hạn thật, không phải lỗi.
2. **Chỉ xử lý PNG.** JPEG/WebP/GIF cần cắm `MATTING_PROVIDER=http` + `MATTING_BASE_URL` (chưa đo
   service thật — cần anh chỉ dịch vụ).
3. **Overlay chỉ có chữ**, chưa kéo-vẽ vị trí/cỡ chữ trên ảnh (server đặt mặc định); chưa preview
   realtime retouch.
4. **Các ngưỡng biên** (8/20/5%/2%/10%) là **lựa chọn có ghi lý do**, đo trên ảnh tổng hợp — ảnh có
   bóng đổ mềm có thể bị từ chối oan (đúng luật “thà không làm còn hơn làm sai”).
5. **Chưa đo**: provider thật (matting/retouch qua HTTP), PostgreSQL cho các bảng mới (CI mới chứng
   minh schema + migration), trình duyệt thật (UI chạy hàm thật trong Node), nhiều job đồng thời,
   ảnh sát trần 16MP.
6. **Chưa có credit/tài khoản** — đó là **MVP-05** (hợp đồng đã soạn: [`MVP-05-CONTRACT.md`](MVP-05-CONTRACT.md)).

---

## 5. Ký nghiệm thu

| | |
|---|---|
| Người nghiệm thu | Owner (anh) |
| Ngày | .......................... |
| Phán quyết | ☐ ĐẠT · ☐ CẦN SỬA (ghi rõ bên dưới) |
| Ghi chú | |

**Sau khi ĐẠT**, thứ tự đề xuất: **MVP-05 (tài khoản + ví credit)** → phần **offline của MVP-04
(video từ ảnh + chữ)** → rồi mới tới các phần cần anh quyết (thanh toán MVP-06, đăng bài MVP-07/08).
