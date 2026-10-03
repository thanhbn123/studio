# MVP-02 — HIẾN CHƯƠNG PHẢN BIỆN (dành cho agent phản biện độc lập)

> Mục đích: **cố tình phá** MVP-02 trước khi Owner nghiệm thu. Bài học từ MVP-01: verifier độc lập
> bác đúng hai tuyên bố mà nhóm tự tin nhất (guardrails chống bịa và nhãn MOCK/LIVE). Vì vậy
> bước này KHÔNG được bỏ, và agent phản biện **không được sửa code** — chỉ tìm và chứng minh.

Người viết hiến chương: phiên điều khiển DSH · Ngày: 03/10/2026 · Nhánh: `feat/mvp02-imagelab`

---

## 1. Luật của người phản biện

1. **Không sửa mã nguồn.** Chỉ ghi `docs/MVP-02-REVIEW.md`. Mọi phát hiện phải kèm **bằng chứng
   chạy được** (lệnh + output thật), không kèm phán đoán suông.
2. **Không tin lời khai.** Mọi câu trong tài liệu/comment/báo cáo của nhóm code đều là giả thuyết
   cần kiểm. Đặc biệt: "không bịa", "ảnh gốc bất biến", "nhãn hiệu không bị dịch", "chống IDOR".
3. **Được dựng test tạm** ở `/tmp` để chứng minh (không được ghi vào `test/**` của repo, vì đó là
   phần của agent test — nếu cần test thường trực thì **đề nghị**, không tự thêm).
4. **Phải nói rõ cái gì ĐẠT.** Một báo cáo chỉ toàn lỗi là báo cáo không đáng tin. Ghi cả những
   tuyên bố đã cố phá mà không phá được.
5. Phán quyết cuối cùng phải là một trong: **PASS**, **PASS CÓ ĐIỀU KIỆN**, **FAIL** — kèm danh
   sách phát hiện xếp theo mức `CRITICAL / MAJOR / MINOR`.

---

## 2. Danh sách tấn công bắt buộc

### A. Luật số 1 — Không bịa
- A1. Chạy toàn luồng với provider **mock**: nhãn cuối cùng trong DB (`extraction_evidence.verification`,
  `image_assets.meta`) và trên UI có **thật sự** là MOCK/MANUAL_INPUT, hay có chỗ nào ghi `LIVE_VERIFIED`?
- A2. Dựng một OCR provider giả trả về vùng có `confidence = 0.01` và chữ rỗng — chúng có bị lọt
  vào DB/UI không?
- A3. Ép `status: 'OK'` giả từ provider lỗi (provider ném exception) — job có bị treo `running`
  không? Có `error_code` + `finished_at` không?
- A4. Bịa số liệu qua đường dịch: cho `text_original = "纯棉T恤"` và ép bản dịch chứa "12 tháng bảo hành"
  → guardrail có bắt không? Thử cả cách nói vòng tiếng Việt: "BH 12 tháng", "bảo hành một năm",
  "chống nước IP68", "hơn 10 nghìn người mua".

### B. Luật số 2 — Ảnh gốc bất biến
- B1. `sha256` của ảnh gốc trên đĩa **trước và sau** toàn bộ luồng (upload → OCR → render). Có đổi không?
- B2. Buffer đầu vào `render()` bị sửa tại chỗ không? (so hash của chính buffer đó sau khi gọi).
- B3. Ảnh render có `parent_id` trỏ đúng ảnh gốc và `sha256` khác ảnh gốc không? Có đường nào
  ghi đè file ảnh gốc (cùng `storage_path`) không?
- B4. Render hai lần cùng một job — có tạo hai asset khác nhau, hay ghi đè lên asset cũ?

### C. Luật số 3 — Nhãn hiệu / chứng nhận không bị dịch, không bị xoá
- C1. Vùng `kind = 'brand'` / `'certification'`: `text_vi` có luôn rỗng không?
- C2. Render có **xoá** vùng brand khỏi ảnh không (dù không vẽ gì)? Kiểm pixel vùng đó trước/sau.
- C3. `PUT .../lines` với `allow_brand_override: false` mà sửa dòng brand → có bị **từ chối thật**
  không, hay vẫn ghi vào DB? Kiểm DB sau khi gọi API.
- C4. `allow_brand_override: true` → override có để lại vết (`edited_by_user`, `provenance = 'user'`) không?

### D. Bảo mật
- D1. **IDOR**: session A tạo job/asset, session B gọi `GET /api/imagelab/jobs/:id`,
  `GET /api/imagelab/assets/:id`, `.../file`, `PUT .../lines`, `POST .../render` → phải 404 ở TẤT CẢ.
- D2. **Path traversal**: chèn `../`, `..%2f`, `%00`, `a/b` vào `asset id`/`job id`/`filename` →
  không được đọc/ghi ngoài `imagelab.dir`. Thử cả `storage_path` bị đầu độc trong DB (nếu tự sửa DB được).
- D3. **XSS**: OCR trả về `text` chứa `<img src=x onerror=alert(1)>` và `"><script>alert(1)</script>`
  → UI có escape không? Kiểm cả chỗ hiện `notes`, `kind_reason`, `violations`, tên file.
- D4. **SSRF**: `OCR_BASE_URL`/`RENDER_BASE_URL` trỏ vào `http://169.254.169.254/`, `http://127.0.0.1:9222`
  → `safeFetch` có chặn không?
- D5. **DoS đầu vào**: PNG khổng lồ (dimensions lớn nhưng IDAT nhỏ — "decompression bomb"),
  PNG cắt ngắn, IDAT hỏng CRC, ảnh 1x1, ảnh 0 byte, base64 rác, 100 vùng chữ trùng nhau.
  Yêu cầu: không crash tiến trình, không treo, không cấp phát vô hạn, có `error_code` rõ.
- D6. **Rò rỉ**: log có in cookie/API key/đường dẫn tuyệt đối của máy không? Response lỗi có lộ stack?
- D7. Rate limit: gọi `POST /api/imagelab/jobs` 20 lần liên tiếp → có bị chặn theo `rateLimiters.jobs`?

### E. Tính đúng của hình học & render (phần dễ sai nhất)
- E1. `layoutText` với `fits === true`: mọi đường bao chữ có nằm TRONG hộp không? Thử hộp 10x6 px,
  chữ dài 200 ký tự, chữ 1 ký tự, hộp âm, hộp tràn ảnh, `w = 0`.
- E2. Op `erase_and_draw` có xoá lan sang vùng chữ khác không? (kiểm pixel ngoài hộp).
- E3. Chữ Việt có dấu render ra có mất dấu không? Thử "Ăn cơm", "Đường", "Ớt", "Ừ".
  Ký tự không có glyph → có bị **vẽ bừa** hay báo `unsupported_glyphs` + `PARTIAL`?
- E4. PNG round-trip: decode → encode → decode phải cho pixel y hệt (thử cả ảnh 1x1, ảnh có alpha,
  grayscale, và ảnh có filter type khác nhau).

### F. Vận hành
- F1. `npm test` và `node tools/verify.mjs` từ đầu trên cây mã sạch: có xanh thật không?
- F2. `Store.init()` chạy 2 lần trên DB cũ `data/studio.db`: có lỗi migration không? MVP-01 có còn
  chạy được sau khi thêm cột `kind` (tạo job kiểu cũ, xem `/api/jobs` cũ)?
- F3. Khởi động server với `OCR_PROVIDER=http` nhưng thiếu key, `RENDER_PROVIDER=purejs` với ảnh JPEG:
  thông báo lỗi có nói đúng sự thật không (không được báo thành công)?
- F4. `AI_PROVIDER` chưa cấu hình: MVP-01 và MVP-02 có fail-closed đúng cách không?

---

## 3. Định dạng `docs/MVP-02-REVIEW.md`

```md
# MVP-02 — BÁO CÁO PHẢN BIỆN ĐỘC LẬP
PHÁN QUYẾT: PASS | PASS CÓ ĐIỀU KIỆN | FAIL

## 1. Tóm tắt
(bảng: mức | phát hiện | bằng chứng | vì sao quan trọng | gợi ý sửa — KHÔNG tự sửa)

## 2. Chi tiết từng phát hiện
(mỗi mục: lệnh đã chạy + output thật + kết luận)

## 3. Những tuyên bố đã cố phá mà KHÔNG phá được
(liệt kê trung thực — đây là phần chứng minh báo cáo không thiên vị)

## 4. Mục chưa kiểm được
(nói rõ vì sao: cần provider thật / cần mạng / cần Owner)
```
