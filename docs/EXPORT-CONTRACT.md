# GÓI XUẤT BẢN (EXPORT BUNDLE) — HỢP ĐỒNG GIAO DIỆN (ĐÓNG BĂNG)

> Tính năng: từ **một job đã chạy**, tải về **một file `.zip`** chứa **mọi thứ đã tạo**:
> nội dung tiếng Việt (JSON + TXT), ảnh gốc, ảnh đã tạo (MVP-03), video (MVP-04), và **bản kê khai**
> (`MANIFEST.json`) nói rõ cái gì là thật, cái gì là mock, cái gì chưa có (ví dụ video không tiếng).
> **Không cần dịch vụ trả tiền. Không thêm dependency** (tự viết ZIP, chỉ dùng `node:zlib`).

Nhánh: `feat/export-bundle` · Ngày khoá: 07/10/2026 · Baseline: **986 test · 980 pass · 0 fail · 6 skipped**
(chạy `env -u DATABASE_URL npm test` — `DATABASE_URL` trong shell đang trỏ PG đã tắt).

---

## 0. Ba luật riêng

1. **Gói phải tự khai.** `MANIFEST.json` ghi rõ: mọi bước dùng provider giả (`mock_steps`), nhãn kiểm
   chứng (`MOCK_VERIFIED` / `MANUAL_INPUT` — **không bao giờ** `LIVE_VERIFIED` nếu chưa gọi dịch vụ thật),
   **cái gì KHÔNG có trong gói** (ví dụ `"audio": null` với video), và **cảnh báo** đã sinh ra trong job.
   Không được "gói đẹp" bằng cách bỏ cảnh báo.
2. **Không bịa nội dung.** Gói chỉ chứa **dữ liệu đã lưu của job** + file **đã có trên đĩa**. Thiếu gì thì
   ghi vào mục `missing` của manifest, **không** tạo file rỗng giả, **không** chèn placeholder.
3. **Ảnh gốc bất biến.** Xuất gói **không** được sửa/ghi đè bất kỳ asset nào (`sha256` trước/sau y hệt).

---

## 1. BẢN ĐỒ SỞ HỮU FILE

| Agent | Được ghi | Chỉ đọc |
|---|---|---|
| **X1 — ZIP writer + đóng gói** | `src/exports/**` | `src/imagelab/storage.js`, `src/store/**` |
| **X2 — API** | `src/http/routes.js` (**chỉ thêm route mới**, không sửa route cũ) | tất cả |
| **X3 — UI** | `public/app.js`, `public/index.html`, `public/styles.css` | tất cả |
| Test | `test/**` | tất cả |
| Phản biện | `docs/EXPORT-REVIEW.md` | tất cả |
| Gộp | mọi file (trừ `docs/EXPORT-REVIEW.md`) | tất cả |

Cấm: sửa `test/**` (trừ agent test), `docs/**`, `src/imagelab/**`, `src/imagestudio/**`,
`src/videostudio/**`, `src/billing/**`, `src/accounts/**`, `src/jobs/**`; thêm dependency.
Bắt buộc: `node --check` + `env -u DATABASE_URL npm test` xanh.

---

## 2. X1 — `src/exports/**`

```js
export class ExportError extends Error {}          // .code, .details
export function crc32(buffer) → number             // bảng CRC32 tự dựng
export function createZip({ entries }) → Buffer    // ZIP "store" (không nén) HOẶC deflate bằng node:zlib
export function inspectZip(buffer) → { valid, entries: [{name, size, crc32, method}], bytes, errors }
export async function buildExportBundle({ store, storage, jobId, logger }) → {
  buffer, filename, bytes, entries, manifest, warnings, missing
}
export function manifestFor({ job, assets, lines, usage, evidence, extra }) → object
```

Luật:
- **ZIP thật, mở được bằng `unzip`/Finder**: chữ ký `PK\x03\x04`, central directory đúng, CRC32 đúng,
  `name` UTF-8 (đặt cờ bit 11 để tên tiếng Việt hiển thị đúng). `inspectZip` là **bộ đọc ĐỘC LẬP**
  (parse central directory, **không** dùng lại hàm ghi) — dùng nó trong test.
- **Cấu trúc gói** (tên file cố định):
  ```
  MANIFEST.json                 bản kê khai (§0 luật 1)
  noi-dung/noi-dung.json        nội dung đã sinh (nguyên bản từ store)
  noi-dung/noi-dung.txt         bản dễ đọc cho người (tiêu đề, mô tả, điểm bán, hashtag)
  anh/anh-goc-<n>.<ext>         mọi asset role 'original'
  anh/anh-tao-<n>.png           mọi asset role 'rendered' là ảnh
  video/video-<n>.gif           mọi asset role 'rendered' là video
  bang-chung/usage.json         usage_events của job
  bang-chung/evidence.json      extraction_evidence của job
  ```
- `manifest` tối thiểu: `{ generated_at, job: {id, kind, status, created_at}, providers, mock_steps,
  verification, audio: null|{...}, counts: {assets, images, videos, lines, usage}, warnings: [...],
  missing: [...], original_sha256: [...], tool: {name, version} }`.
- `filename` = `<kind>-<jobId ngắn>-<YYYYMMDD-HHmm>.zip`, **đã làm sạch** ký tự lạ.
- Job không tồn tại ⇒ `ExportError('JOB_NOT_FOUND')`; job không có asset nào ⇒ vẫn xuất gói **có manifest**
  + `missing` nói rõ (không được ném lỗi im lặng).
- Không đọc/ghi ngoài `IMAGELAB_DIR` (dùng `storage`, không tự ghép đường dẫn).
- **Không sửa asset**: chỉ đọc.

---

## 3. X2 — API (chỉ THÊM, không đổi route cũ)

```
GET /api/exports/jobs/:id/bundle            → 200 application/zip (Content-Disposition có filename)
GET /api/exports/jobs/:id/manifest          → 200 { manifest, warnings, missing }
```

Luật: quyền sở hữu y như các route job khác (đã đăng nhập ⇒ `jobs.user_id` phải khớp; ẩn danh ⇒ theo
`session_id`); khác chủ ⇒ **404**; job không tồn tại ⇒ 404; thiếu module ⇒ **503 `EXPORT_UNAVAILABLE`**;
rate limit dùng `rateLimiters.jobs` key `export:${sid}`; header: `Content-Type: application/zip`,
`Content-Disposition: attachment; filename="..."`, `Cache-Control: private, no-store`,
`X-Content-Type-Options: nosniff`; **không** lộ `storage_path`/`session_id`.
`/api/config` thêm khối `exports: { available, formats: ['zip'] }`.

---

## 4. X3 — UI

Nút **“TẢI GÓI XUẤT BẢN (.zip)”** ở: màn job MVP-01 (nội dung), màn job MVP-02 (dịch ảnh),
màn job MVP-03 (tạo ảnh), màn job MVP-04 (video). Bấm ⇒ tải qua `GET /api/exports/jobs/:id/bundle`
(dùng thẻ `<a download>` hoặc `location.assign`, **không** nhồi base64 vào state).
Kèm dòng nói thật: **“Gói gồm nội dung + ảnh + video đã tạo; các bước dùng dữ liệu giả được ghi rõ
trong MANIFEST.json”**. Job đang chạy ⇒ vẫn tải được nhưng UI nhắc “job chưa xong, gói có thể thiếu”.
Escape mọi text bằng `esc()`.

---

## 5. ĐỊNH NGHĨA "XONG"

- ZIP **mở được bằng công cụ ngoài** (`unzip -l`, Finder) và `inspectZip` khớp (số entry, CRC32, tên).
- `MANIFEST.json` có đủ: providers/mock_steps/verification/warnings/missing/audio.
- Gói của job **chưa có gì** vẫn hợp lệ + `missing` nói rõ.
- Ảnh gốc bất biến sau khi xuất (`sha256` trước/sau y hệt).
- IDOR ⇒ 404; ẩn danh (không tài khoản) vẫn tải được gói của chính phiên mình.
- `env -u DATABASE_URL npm test` xanh; `node tools/verify.mjs` xanh.
