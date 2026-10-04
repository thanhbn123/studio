# MVP-03 — HIẾN CHƯƠNG PHẢN BIỆN (dành cho agent phản biện độc lập)

> Mục đích: **cố tình phá** MVP-03 (Image Generation / Retouching) trước khi Owner nghiệm thu.
> Bài học MVP-01/MVP-02: verifier độc lập đã bác đúng những tuyên bố mà nhóm tự tin nhất
> (guardrails chống bịa, nhãn MOCK/LIVE, và ở MVP-02 là **hộp chữ chồng nhau xoá pixel logo mà hệ
> thống vẫn báo “không xoá”**). Vì vậy bước này KHÔNG được bỏ.

Người viết: phiên điều khiển DSH · Nhánh: `feat/mvp03-imagestudio` · Hợp đồng: `docs/MVP-03-CONTRACT.md`

---

## 1. Luật của người phản biện

1. **Không sửa mã nguồn.** Chỉ ghi `docs/MVP-03-REVIEW.md`. Mọi phát hiện phải kèm **bằng chứng chạy
   được** (lệnh + output thật).
2. **Không tin lời khai.** Mọi câu trong báo cáo của nhóm code là giả thuyết cần kiểm: “không bóp méo
   sản phẩm”, “nền là mô phỏng và có khai”, “tách nền fail-closed”, “retouch bị kẹp ngưỡng”,
   “overlay bịa bị chặn”, “ảnh gốc bất biến”.
3. Được dựng script tạm ở `/tmp/mvp03-atk/` (không ghi vào `test/**`).
4. **Phải nói rõ cái gì ĐẠT** — một báo cáo chỉ toàn lỗi là báo cáo không đáng tin.
5. Phán quyết cuối: **PASS / PASS CÓ ĐIỀU KIỆN / FAIL**, phát hiện xếp mức `CRITICAL / MAJOR / MINOR`.

---

## 2. Danh sách tấn công bắt buộc

### A. Luật #1 — Không bóp méo sản phẩm
- A1. Ảnh ra có **luôn cùng kích thước** ảnh gốc không? Thử ảnh 1×1, 3×7, 2000×1, ảnh rất lớn.
- A2. Pixel vùng **GIỮ LẠI** có y hệt ảnh gốc khi **không** bật retouch không? (đếm pixel đổi ngoài
  mask; thử cả khi mask sai/thiếu/lệch cỡ).
- A3. Retouch: tham số vượt ngưỡng ⇒ có **bị kẹp** thật và ghi lại không? Thử `brightness: 99`,
  `-99`, `NaN`, `'0.9'`, `Infinity`, mảng, object, `__proto__`. Có đường nào vượt ngưỡng mà im lặng?
- A4. Retouch có **đổi alpha** của vùng nền đã tách (làm nền đen/viền răng cưa) không? Có **dịch**
  pixel (sharpen quá tay ⇒ lệch ảnh) không?
- A5. Ảnh gốc trên đĩa + trong DB có bất biến sau **toàn bộ** chuỗi thao tác (create → generate nhiều
  lần → overlay → xoá job?) không?

### B. Luật #2 — Nền MÔ PHỎNG phải được khai
- B1. Mọi nền do hệ thống sinh ra có `synthetic: true` (trong `asset.meta`, trong `GET`, trong UI) không?
- B2. Có đường nào **không** đi qua template mà vẫn ghép nền (hoặc ngược lại: template lạ ⇒ có bịa nền
  mặc định không)?
- B3. UI có chỗ nào gọi nền sinh ra là “ảnh thật”/“AI tạo nền thật” không? (grep chuỗi trong `public/`).
- B4. Overlay vẽ lên ảnh có bị tính là “ảnh gốc” trong bất kỳ nhãn nào không?

### C. Luật #3 — Tách nền fail-closed
- C1. Nền gradient/nhiễu/ảnh chụp thật ⇒ có **từ chối** (`UNIFORM_BACKGROUND_NOT_FOUND`) hay vẫn cắt bừa?
- C2. Mask “dị thường” (`background_ratio` < 0.05 hoặc > 0.98) ⇒ `SUSPICIOUS_MASK`? Thử ảnh toàn một màu,
  ảnh chỉ có 1 pixel khác, ảnh trong suốt hoàn toàn.
- C3. Mask lệch kích thước / không phải PNG / hỏng CRC / alpha một phần ⇒ compose xử lý thế nào (không
  được resize, không được đoán)?
- C4. PNG palette/1-bit/interlaced/16-bit, JPEG/WebP/GIF ⇒ fail-closed có mã rõ?

### D. Chống bịa (overlay + dấu vết)
- D1. Overlay `"Bảo hành 12 tháng"`, `"BH 12 tháng"`, `"chống nước IP68"`, `"hơn 10 nghìn người mua"`,
  `"①② tháng"`, `"ｂảo hành"`, homoglyph Kirin/Greek, không dấu `"bao hanh 12 thang"` — với nguồn bằng
  chứng **rỗng** ⇒ **không được vẽ** và phải trả vi phạm.
- D2. Nguồn bằng chứng có bị **giả** được từ client không (`overlay.source_text` do client gửi)? Nếu có,
  nêu rõ mức độ (đây là đường “tự rửa tội” giống lỗ hổng bằng chứng vòng của MVP-01).
- D3. Overlay chứa chữ Hán ⇒ `OVERLAY_NOT_TRANSLATED`; overlay rỗng/toàn khoảng trắng ⇒ không vẽ.
- D4. Usage event có bịa không: bước matting **thất bại** mà vẫn ghi `IMAGE_MATTING` như thành công?
  Bước không chạy (tắt tách nền, không overlay) mà vẫn ghi usage?
- D5. Evidence có bao giờ `LIVE_VERIFIED` cho job MVP-03 không? (phải luôn `MANUAL_INPUT`.)

### E. Bảo mật & vận hành
- E1. **IDOR**: session khác ⇒ 404 ở **mọi** route `/api/imagestudio/*` + route file ảnh; job không tồn
  tại ⇒ 404; id không phải uuid ⇒ 400.
- E2. Ảnh đầu vào: base64 rác, HTML khai `image/png`, ảnh > `maxImageBytes`, > `maxPixels`, 0 byte,
  ảnh khai MIME sai.
- E3. **DoS**: ảnh lớn nhất cho phép × nhiều job; body khổng lồ; template id cực dài; overlay text 1 MB;
  `retouch` là object lồng sâu.
- E4. **XSS**: overlay text, template label, tên file, `warnings` (mọi thứ server trả) khi UI render —
  chạy **hàm UI thật** như `test/imagelab-ui-helpers.js` đang làm.
- E5. Rò rỉ: `storage_path`, `session_id`, secret, đường dẫn tuyệt đối trong response/log.
- E6. Prototype pollution qua body (`__proto__`, `constructor`), JSON hỏng, body vượt trần.
- E7. **Tương tác chéo**: job `image_generation` có lẫn với `content` (MVP-01) và `image_translation`
  (MVP-02) không? `GET /api/jobs` (lịch sử) có phân biệt đúng 3 loại? Route cũ có bị ảnh hưởng không?
- E8. Job lỗi/treo: provider ném exception, matting OK nhưng compose lỗi, retouch lỗi ⇒ job có
  `error_code` + `finished_at`, không treo `running`? Hàng đợi rỗng mà job `running` ⇒ có đường thoát?

### F. Hồi quy
- F1. `npm test` (tự đo, ghi số) · `node tools/verify.mjs` · `npm run demo:imagelab` (+ `--regions`).
- F2. Các phát hiện MVP-02 vẫn được giữ: chạy lại script ở `/tmp/atk5`, `/tmp/atk6`, `/tmp/atk-il08b`
  nếu còn; đặc biệt **F-01 (pixel nhãn hiệu)** và **IL08-01 (OCR không ghi đè vùng tay)**.
- F3. UI 2 tab cũ vẫn hoạt động (chạy hàm thật trong Node).

---

## 3. Định dạng `docs/MVP-03-REVIEW.md`

```md
# MVP-03 — BÁO CÁO PHẢN BIỆN ĐỘC LẬP
PHÁN QUYẾT: PASS | PASS CÓ ĐIỀU KIỆN | FAIL

## 1. Tóm tắt   (bảng: mức | phát hiện | bằng chứng | vì sao quan trọng | gợi ý sửa)
## 2. Chi tiết từng phát hiện   (lệnh + output thật + kết luận)
## 3. Những tuyên bố đã cố phá mà KHÔNG phá được
## 4. Mục chưa kiểm được (nói rõ vì sao)
```

**Trung thực là trên hết:** nếu một đòn tấn công không chạy được, ghi rõ vì sao — không suy đoán,
không thổi phồng, không bỏ qua.
