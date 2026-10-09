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

---

# VÒNG SỬA PHẢN BIỆN (D1…D6) — chốt lại các điểm lệch

Hai agent độc lập (test + phản biện) bắt TRÙNG nhau 3 lỗi; phán quyết vòng 1 **FAIL**
(`docs/EXPORT-REVIEW.md`). Những điểm dưới đây ĐỔI so với bản đóng băng đầu.

## 9.1 D1 — GÓI PHẢI TỰ KHAI bước chạy provider GIẢ (từ MỌI dấu vết đã lưu)

- `manifestFor()` gọi **`mockStepsFor(job, assets, usage)`** và hợp với `mockStepsFromAssets` +
  `extra.mock_steps` (khử trùng, sắp thứ tự cố định). Trước đây chỉ dùng `mockStepsFromAssets` ⇒
  job MVP-01/02 (dấu vết ở `content_meta.is_mock`, `content_meta.imagelab.mock_steps`,
  `usage_events.provider = 'mock'`) khai `mock_steps: []` — gói **giấu** bước dùng dữ liệu giả.
- `bundle.js` tính **MỘT tập** `mockStepsAll` rồi dùng cho **cả** `noi-dung/noi-dung.txt` lẫn
  `MANIFEST.json` ⇒ bản dễ đọc không bao giờ “đẹp hơn” bản kê khai.
- UI (`public/app.js`): câu “Máy chủ khai KHÔNG có bước nào dùng dữ liệu giả” chỉ in khi bản kê
  khai **THẬT SỰ** có mảng `mock_steps` rỗng; thiếu hẳn khoá ⇒ in “KHÔNG kiểm được”.

## 9.2 D2 — `providers.usage[].is_mock` theo CHÍNH dòng usage

- `is_mock = meta.is_mock === true || provider === 'mock'` (và khoá gộp nhóm dùng cùng luật).
  Trước đây chỉ đọc `meta.is_mock` ⇒ dòng `provider: "mock"` bị khai `is_mock: false`, lệch với
  `mock_steps` trong cùng một gói.

## 9.3 D3 — nhãn LIVE chỉ khi có BẰNG CHỨNG `transport === 'http'`

- `verificationFor()` bỏ nhãn khi `transport !== 'http'` — **kể cả khi thiếu transport**
  (`null`/`undefined`). Trước đây điều kiện là `transport !== null && transport !== 'http'` ⇒
  fail-open: job không lưu `product_master.extraction.transport` vẫn khẳng định
  `AUTHENTICATED_LIVE_VERIFIED` (trái §0.1 và trái cổng `src/jobs/pipeline.js:48`).
- Nhãn bị bỏ ⇒ `label = null` (giữ luật “nghi ngờ ⇒ không khai”) và
  `verification_detail.suggested_level` ghi **mức đúng** (`MANUAL_INPUT` nếu `transport='manual'`,
  còn lại `MOCK_VERIFIED`) + lý do trong `notes`.

## 9.4 D4 — job KHÔNG có chủ ⇒ 404

- `requireOwnExportJob`: job không có `user_id` **và** không có `session_id` ⇒ **404 JOB_NOT_FOUND**
  (log `exports.ownerless_job_denied`). Job có `session_id` giữ nguyên luật cũ (cookie phải khớp).

## 9.5 D5 — `/manifest` KHÔNG dựng ZIP

- X1 có thêm **`buildExportManifest()`** (= `buildExportBundle({ zip: false })`): vẫn đọc dữ liệu đã
  lưu + băm ảnh gốc để hai đường là MỘT nguồn, nhưng **không gọi `createZip`**, không giữ buffer
  (trả `{ buffer: null, zipped: false }`). Route `/manifest` dùng đường này; route `/bundle` giữ
  nguyên. Module X1 cũ (chưa có `buildExportManifest`) ⇒ route ghi log
  `exports.manifest_without_zip_builder` và rơi về đường cũ (không vỡ).

## 9.6 D6 — `entries` đủ, thiếu `storage` ⇒ 503, tên entry CR/LF bị chặn

- `manifest.entries` **kể cả `MANIFEST.json`** (và `files` cùng độ dài; bản thân MANIFEST.json ghi
  `sha256: null` + lý do “không tự băm chính nó”).
- Thiếu `storage` ⇒ `config.exports.available = false` và hai route trả **503 `EXPORT_UNAVAILABLE`**
  (trước đây 500; lỗi `BAD_INPUT` có chữ “storage” được map thành “chưa sẵn sàng”).
- Tên entry chứa ký tự điều khiển bị **từ chối**, nhưng bằng **HAI mã có lý do khác nhau** — câu
  “CR/LF/NUL ⇒ `BAD_ENTRY_NAME`” ở bản trước là SAI và đã được sửa ở §9.7 (R4).

---

# VÒNG VÁ R1…R6 — chốt lại các điểm lệch của vòng 2

Nguồn: `docs/EXPORT-REVIEW.md` §6.2 (R1–R6, đo tại `3bc139f`) + script `/tmp/x-atk2/**`
(`b1-matrix`, `b2-d5-d4-d6`, `b3-zipnames`, `c1-r6-limits`, `c2-r6-concurrency-rss`).
Số đo thật + phần CHƯA làm được: `docs/VERIFICATION.md` §24.5.

## 10.1 R1 — `mock_steps` KHÔNG BAO GIỜ mâu thuẫn với `providers`

- `mockStepsFor(job, assets, usage, evidence)` đọc thêm cờ **`content_meta.imagelab.{ocr,translate,render}.is_mock`**
  (đúng ba field mà `providersFor()` in ra ở `providers.imagelab.*`), và coi
  **`content_meta.provider = "mock"`** là bước `content` chạy bằng provider giả (cùng luật D2 đang
  áp cho từng dòng `usage_events`).
- **CHỐT CHẶN:** sau khi gom, gói đối chiếu lại với CHÍNH object `providers` sẽ in ra
  (`mockStepsFromProviders`). Nếu còn `is_mock === true` ở bất kỳ đường dẫn nào mà không suy ra
  được bước cụ thể ⇒ `mock_steps` ghi **`"unknown"`** kèm một cảnh báo giải thích trong
  `warnings[]` (KHÔNG bao giờ để rỗng khi có provider mock). `verification_detail.contains_mock`
  theo đúng mảng này.

## 10.2 R2 — cổng nhãn kiểm chứng: CHUẨN HOÁ trước khi xét

- `normalizeVerificationLevel(raw)` (manifest.js): `trim()` + **chữ HOA**; nhận cả OBJECT qua
  `level`/`label`/`status`/`verification`. Mọi phép so khớp LIVE (`LIVE_VERIFIED`,
  `AUTHENTICATED_LIVE_VERIFIED`) chạy trên giá trị **đã chuẩn hoá**, nên `'live_verified'`,
  `'LIVE_VERIFIED '` (dấu cách) và `{level:'LIVE_VERIFIED'}` đều đi qua **cùng một cổng**:
  chỉ giữ nhãn khi `transport === 'http'`, còn lại ⇒ `label = null` + lý do trong
  `verification_detail.notes` + `suggested_level`.
- Object/kiểu lạ KHÔNG đọc được mức ⇒ coi như **KHÔNG có nhãn** + ghi lý do; `recorded_level` giữ
  nguyên bản để truy vết, `recorded_level_normalized` là bản đã chuẩn hoá.
- **UI:** badge XANH “đã kiểm chứng bằng dịch vụ thật” chỉ hiện khi nhãn là CHUỖI, chuẩn hoá ra
  đúng một mức LIVE **VÀ** `verification_detail.live_service_called === true`. `exportVerificationLabel`
  KHÔNG còn dịch object thành nhãn; lý do không hiện badge được in ngay dưới badge.

## 10.3 R3 + R4 — tên entry: mọi ký tự điều khiển, hai mã lỗi

- `normalizeZipName` chặn **`\p{Cc}`** (C0/C1, gồm CR/LF/TAB/VT/FF/ESC/DEL/NEL), **`\p{Zl}`/`\p{Zp}`**
  (LS/PS) và các ký tự điều khiển hướng hiển thị (`LRE/RLE/PDF/LRO/RLO`, isolate, `LRM/RLM/ALM`)
  + BOM. **Cố ý KHÔNG chặn toàn bộ `\p{Cf}`** vì `Cf` gồm ZWJ (U+200D) — chặn nó là phá tên tệp
  emoji ghép; chữ có dấu + emoji vẫn được giữ nguyên.
- **HAI MÃ, lý do khác nhau** (thay cho câu sai ở §9.6):

  | Tên entry | Mã lỗi | Vì sao |
  |---|---|---|
  | chứa **NUL (U+0000)** | `ZIP_NAME_INVALID` | NUL làm tên không biểu diễn được trong ZIP (mọi công cụ đọc theo C-string cắt tại đó) ⇒ lỗi ĐỊNH DẠNG đường dẫn; mã này đã dùng cho NUL từ trước D6, giữ nguyên để không phá client đang bắt mã đó |
  | rỗng / tuyệt đối / `..` / `\` / đuôi `/` | `ZIP_NAME_INVALID` | tên không dùng được làm đường dẫn entry |
  | chứa ký tự điều khiển **khác NUL** | `BAD_ENTRY_NAME` | tên ĐÚNG dạng đường dẫn nhưng chèn được dòng giả vào danh sách tệp / bịa được đuôi tệp. `details` nêu rõ `{char, code_point, name, position}` |
  | dài quá 65535 byte UTF-8 | `ZIP_NAME_TOO_LONG` | giới hạn định dạng ZIP cổ điển |

## 10.4 R5 — `mock_steps` có phần tử nhưng không đọc được tên

- `usableMockSteps(raw)` tách phần dùng được khỏi phần dị dạng. Mảng **RỖNG thật** (`[]`) vẫn là
  “không có bước giả”; mảng **CÓ phần tử mà không đọc được tên nào** (`[null]`, `[""]`, `[{}]`)
  ⇒ ghi `"unknown"` + cảnh báo (manifest) và UI in **“KHÔNG kiểm được”** thay vì câu khẳng định.
- UI chỉ in câu “Máy chủ khai KHÔNG có bước nào dùng dữ liệu giả” khi `mock_steps` **THẬT SỰ rỗng**.

## 10.5 R6 — trần kích thước gói + giới hạn số lượt dựng gói ĐỒNG THỜI

Bối cảnh đo được: `/bundle` dựng trọn gói trong RAM, **60 MB asset ⇒ +196…270 MB RSS (~3,3–4,5×)**
và ~1,8 s; trần cũ 512 MiB ⇒ một request hợp lệ có thể cấp phát ~2 GB, không giới hạn đồng thời.

| Cấu hình (env) | Mặc định | Ý nghĩa |
|---|---|---|
| `EXPORT_MAX_BUNDLE_BYTES` | **67108864** (64 MiB) | Trần tổng byte của gói. Vượt ⇒ `BUNDLE_TOO_LARGE` (**HTTP 413**) kèm `details = {bytes, limit, max_bundle_bytes}`, dừng NGAY khi vượt (không đọc nốt phần còn lại). Áp cho **cả** `/bundle` lẫn `/manifest` |
| `EXPORT_MAX_CONCURRENT_BUNDLES` | **1** | Số lượt dựng gói chạy song song (`/bundle`). Lượt vượt ⇒ xếp hàng, không dựng chồng |
| `EXPORT_MAX_QUEUED_BUNDLES` | **4** | Số request được chờ trong hàng đợi. Đầy ⇒ `EXPORT_BUSY` (**HTTP 429**, `retry_after_ms`) |
| `EXPORT_MAX_WAIT_MS` | **30000** | Chờ tối đa trong hàng đợi; quá hạn ⇒ `EXPORT_BUSY` (429) thay vì treo request |

- Giá trị env sai/âm/không phải số ⇒ rơi về **mặc định** (không bao giờ thành “không giới hạn”).
- `EXPORT_BUSY` (429, quá tải dựng gói) **KHÁC** `RATE_LIMITED` (429, trần 10 job/phút theo phiên).
- UI nói đúng loại lỗi: 413 in **số đo** (MB đo được / trần), 429 `EXPORT_BUSY` in thời gian chờ đề
  nghị; cả hai **không** mời “thử tải trực tiếp” (bấm lại y hệt vẫn hỏng).
- `/api/config.exports` **giữ nguyên** `{available, formats}` (không thêm field ⇒ không phá client cũ);
  trần/giới hạn là cấu hình vận hành, thông báo lỗi mới là nơi nói con số.

