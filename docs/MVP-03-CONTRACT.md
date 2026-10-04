# MVP-03 — HỢP ĐỒNG GIAO DIỆN (ĐÓNG BĂNG)

> **File này là luật.** Các agent code song song chỉ được viết đúng phần mình sở hữu; mọi tên hàm /
> tên field / mã lỗi dưới đây là **hợp đồng đóng băng**. Thấy hợp đồng sai thì **báo người điều phối**,
> KHÔNG tự sửa rồi để agent khác lệch theo.

Ngày khoá: 04/10/2026 · Người khoá: phiên điều khiển DSH · Nhánh: `feat/mvp03-imagestudio`

---

## 0. Mục tiêu MVP-03 (Image Generation / Retouching)

Từ **ảnh sản phẩm thật** tạo ra ảnh marketing **trung thực**:

```
ảnh gốc (bất biến)
  → tách nền (chỉ khi nền đủ đồng nhất — nếu không thì TỪ CHỐI, không đoán)
  → ghép nền mới theo bộ mẫu (nền MÔ PHỎNG, có ghi rõ)
  → retouch trong ngưỡng cho phép (độ sáng/tương phản/bão hoà/nét nhẹ) + ghi lại tham số
  → (tuỳ chọn) chèn chữ Việt bằng chính engine font của MVP-02, có kiểm chống bịa
  → ảnh MỚI cùng khung hình với ảnh gốc, có parent_id + sha256; ẢNH GỐC KHÔNG ĐỔI
```

Ba luật bất khả xâm phạm của dự án vẫn nguyên hiệu lực, cộng ba luật riêng của MVP-03:

1. **Không bóp méo sản phẩm.** Đầu ra **cùng kích thước** với ảnh gốc; không resize/crop/warp/biến
   dạng; retouch bị **kẹp trong ngưỡng** (xem §3.4) và tham số hiệu lực phải được ghi lại.
2. **Nền mới là MÔ PHỎNG, phải khai.** Mọi nền do hệ thống sinh ra mang nhãn `synthetic: true` +
   tên mẫu; UI hiện “nền MÔ PHỎNG (không phải ảnh thật)”.
3. **Tách nền là fail-closed.** Không đủ tự tin ⇒ `SEGMENTATION_FAILED` kèm số đo thật, KHÔNG cắt
   bừa (thà trả ảnh chỉ-retouch còn hơn cắt mất sản phẩm).

---

## 1. BẢN ĐỒ SỞ HỮU FILE

| Agent | Được ghi (sở hữu) | Chỉ được đọc |
|---|---|---|
| **E1 — Matting + Retouch** | `src/imagestudio/matting/**`, `src/imagestudio/retouch/**` | `src/imagelab/render/**`, `src/imagelab/geometry.js` |
| **E2 — Nền + Ghép + Overlay** | `src/imagestudio/compose/**` | `src/imagelab/render/**` |
| **E3 — Store/Jobs/Pipeline/Wiring** | `src/imagestudio/pipeline.js`, `src/store/index.js`, `src/store/schema.sql`, `src/app.js` | tất cả |
| **E4 — API** | `src/http/routes.js` | tất cả |
| **E5 — UI** | `public/app.js`, `public/index.html`, `public/styles.css` | tất cả |
| **Test** | `test/**` | tất cả |
| **Phản biện** | `docs/MVP-03-REVIEW.md` | tất cả |
| **Gộp** | mọi file (sửa lệch hợp đồng), trừ `docs/MVP-03-REVIEW.md` | tất cả |

Cấm với agent code: sửa `test/**`, `src/imagelab/**` (chỉ ĐỌC), `docs/**`; chạy `git commit/checkout/stash`;
thêm dependency (dự án chỉ có `pg`). Bắt buộc trước khi báo xong: `node --check` file mình sửa và
`npm test` giữ **xanh** (baseline khi bắt đầu: **578 test · 577 pass · 0 fail · 1 skipped**).

---

## 2. DÙNG LẠI (không viết lại)

- `src/imagelab/storage.js` — lưu/đọc ảnh (đã chống path traversal). Dùng nguyên.
- `src/imagelab/render/{png.js,image.js,font/**,layout.js,draw.js}` — codec PNG, tiện ích ảnh, font
  Việt có dấu, layout. Dùng nguyên (chỉ ĐỌC).
- `src/imagelab/geometry.js` — `strictCoordinate`, `intersectBoxWithImage`, `boxesIntersect`.
- `src/store/index.js` — `createJob/updateJob/…`, `createImageAsset`, `image_assets` (role
  `original|rendered`), `usage_events`, `extraction_evidence`.
- `src/imagelab/translate/guardrails.js` — dùng `checkClaimWords`/`CLAIM_GROUPS` để chặn overlay bịa.

---

## 3. HỢP ĐỒNG MODULE

### 3.1 E1 — Matting (`src/imagestudio/matting/`)

```js
export class MattingError extends Error {}          // .code, .details
export class MattingProvider {
  get name(); get model(); get isMock(); get configured();
  async probe({ buffer, mime }) → { width, height } | null
  async removeBackground({ image, options }) → MattingResult
}
export function createMattingProvider(config, { logger } = {}) → MattingProvider
```

**`MattingResult` (đóng băng)**
```js
{
  status: 'OK' | 'UNIFORM_BACKGROUND_NOT_FOUND' | 'UNSUPPORTED_IMAGE' | 'NOT_CONFIGURED' | 'FAILED',
  provider, model, is_mock,
  output: { buffer, mime, width, height, sha256 } | null,   // PNG RGBA, nền trong suốt
  mask: { coverage: 0.37, background_ratio: 0.62, uniformity: 0.94, seed_colors: 3 },
  kept_bbox: { x, y, w, h } | null,                          // hộp bao phần GIỮ LẠI
  warnings: string[], elapsed_ms: number,
  error_code: string|null, error_message: string|null
}
```

Luật:
- Provider `purejs` = **flood fill từ viền** theo khoảng cách màu (ngưỡng `tolerance`), chỉ loang
  trong vùng nối với viền ảnh ⇒ không ăn vào giữa sản phẩm.
- `uniformity` = tỉ lệ pixel viền nằm trong cụm màu chủ đạo (0..1). Nếu `< minUniformity`
  (mặc định 0.75) ⇒ `status = 'UNIFORM_BACKGROUND_NOT_FOUND'`, `output = null`, kèm số đo thật.
- `background_ratio` < 0.05 hoặc > 0.98 ⇒ nghi ngờ (ảnh toàn nền / không tách được) ⇒ fail-closed
  với `error_code = 'SUSPICIOUS_MASK'`.
- Không được sửa `image.buffer` tại chỗ; `output.sha256` là hash ảnh ĐẦU RA; ảnh vào phải giữ nguyên.
- Provider `mock`: trả mask giả cố định, `is_mock = true`, `output` = bản sao ảnh vào (KHÔNG tách thật).
- `http`/`none`: như các provider khác của dự án (POST `{image_base64, options}` → `{image_base64, mask}`;
  thiếu cấu hình ⇒ `NOT_CONFIGURED`).

### 3.2 E2 — Nền + Ghép + Overlay (`src/imagestudio/compose/`)

```js
export const TEMPLATES = Object.freeze([...]);   // [{ id, label, kind: 'solid'|'gradient'|'floor', synthetic: true, colors: [...] }]
export class ComposeError extends Error {}
export function composeImage({ image, matting, template, options }) → ComposeResult   // hàm thuần
export function drawOverlay({ image, overlay, font }) → { buffer, applied, warnings }  // hàm thuần
```

**Template tối thiểu (id đóng băng):** `trang` (trắng), `xam-nhat` (xám nhạt), `gradient-xanh`,
`gradient-hong`, `san-go` (nền gỗ mô phỏng bằng gradient nâu + đường sàn). Mọi template
`synthetic: true`.

**`ComposeResult`**: `{ output: {buffer,mime,width,height,sha256}, template: {id,label,synthetic:true},
background_ratio, warnings, elapsed_ms }`.
Luật: ảnh vào và ảnh ra **cùng kích thước**; pixel **giữ lại** (mask = 0) phải **y hệt** ảnh gốc
(so từng byte RGBA) trừ khi có retouch; nền chỉ được vẽ vào vùng mask > 0.

**Overlay** (`drawOverlay`): `overlay = { text, x, y, size?, color?, align? }` — dùng font/layout của
`src/imagelab/render`. Trả `{ buffer, applied: boolean, reason?, warnings }`. Overlay **không** được
vẽ chồng lên vùng chữ đã có trong ảnh gốc? (không kiểm được — bỏ qua), nhưng **phải** kiểm nội dung:
xem §3.5.

### 3.3 E3 — Pipeline (`src/imagestudio/pipeline.js`)

```js
export const IMAGESTUDIO_STAGES = Object.freeze(['queued','storing','matting','composing','retouching','done','failed']);
export const IMAGESTUDIO_KIND = 'image_generation';
export class ImageGenerationPipeline {
  constructor({ config, logger, store, storage, mattingProvider, retouchProvider })
  async ingest(jobId, { image, sessionId, options }) → { asset_id, width, height, sha256 }
  async generate(jobId, { sessionId, options, force = false }) → { status, asset, matting, compose, retouch, warnings }
}
export function clampRetouchParams(params, limits) → { params, clamped: string[], rejected: string[] }
```

Luật:
- `jobs.kind = 'image_generation'` (cột đã có từ MVP-02; giá trị mới, **không** cần migration).
- `USAGE_OPERATIONS` thêm **`IMAGE_MATTING`**, **`IMAGE_COMPOSE`**, **`IMAGE_RETOUCH`** (giữ nguyên
  các operation cũ). Ghi usage: matting (input = pixel, output = 1 nếu OK), compose (input = pixel,
  output = 1), retouch (input = pixel, output = số tham số áp dụng). **Không** ghi operation không chạy.
- Evidence: `connector = 'imagestudio'`, `extraction_method = 'upload+generate'`,
  `verification = 'MANUAL_INPUT'` (ảnh người dùng tải lên) — **không bao giờ** `LIVE_VERIFIED`.
- Lỗi matting **không** làm chết job: nếu `UNIFORM_BACKGROUND_NOT_FOUND` ⇒ **vẫn chạy retouch** trên
  ảnh gốc và `status = 'PARTIAL'`, `warnings` nói rõ “không tách được nền”; nếu cả retouch cũng không
  đổi gì ⇒ `error_code = 'NO_CHANGES'`, `status = PARTIAL` (không được báo OK).
- Ảnh ra lưu với role `rendered`, `parent_id` = asset gốc, `meta.kind = 'image_generation'`,
  `meta.template`, `meta.retouch_effective`, `meta.synthetic_background = true|false`,
  `meta.overlay`.
- `ingest` giới hạn: `imagelab.maxImageBytes`, `imagelab.maxPixels` (dùng lại cấu hình MVP-02).

### 3.4 E1 — Retouch (`src/imagestudio/retouch/`)

```js
export class RetouchProvider { get name(); get configured(); async apply({ image, params }) → RetouchResult }
export function createRetouchProvider(config, { logger } = {}) → RetouchProvider
export const RETOUCH_LIMITS = Object.freeze({ brightness: 0.25, contrast: 0.25, saturation: 0.30, sharpen: 0.5 });
```

`params = { brightness?, contrast?, saturation?, sharpen? }` (số thực; dương = tăng).
**Ngưỡng kẹp (bắt buộc)**: vượt `RETOUCH_LIMITS` ⇒ **kẹp** lại và ghi vào `clamped[]` (KHÔNG từ chối
âm thầm, KHÔNG bỏ qua). Tham số không phải số hữu hạn ⇒ vào `rejected[]`, coi như không truyền.
`RetouchResult = { status: 'OK'|'NO_CHANGES'|'UNSUPPORTED_IMAGE'|'FAILED', output, params_effective,
clamped: string[], rejected: string[], warnings, elapsed_ms, error_code }`.
Retouch **không** được: đổi kích thước, dịch chuyển pixel, đổi kênh alpha của vùng trong suốt (nền đã
tách phải giữ alpha = 0), hay thay màu theo kiểu “đổi chất liệu”.

### 3.5 Overlay — chống bịa (dùng lại guardrail)

- Trước khi vẽ overlay, chạy kiểm bằng `checkClaimWords(textGốcCủaJob, overlay.text)` và
  `checkNumericClaims` của `src/imagelab/translate/guardrails.js`. Có vi phạm ⇒ **không vẽ**, trả
  `422 OVERLAY_UNSUPPORTED_CLAIM` kèm danh sách vi phạm. `textGốcCủaJob` = ghép các vùng chữ OCR +
  tên sản phẩm + ghi chú người dùng (nếu có); rỗng ⇒ coi như không có bằng chứng ⇒ mọi khẳng định
  bị chặn.
- Overlay **không** được chứa chữ Hán (chưa dịch) — dùng `hasCjk`.

### 3.6 E4 — API (`src/http/routes.js`)

```
POST /api/imagestudio/jobs         body { image:{base64,filename?}, options?:{template?,retouch?,overlay?} }
                                   → 202 { job_id, asset_id, status, poll }
GET  /api/imagestudio/jobs/:id     → 200 { job, asset, rendered:[], matting, compose, retouch, warnings, providers }
POST /api/imagestudio/jobs/:id/generate  body { options?, force? } → 202 { job_id, status }
GET  /api/imagestudio/templates    → 200 { templates: [...], retouch_limits: {...} }
GET  /api/imagestudio/assets/:id/file → ảnh nhị phân (dùng lại route imagelab nếu tiện)
```

Luật: quyền sở hữu theo session (khác ⇒ **404**); validate ảnh bằng `sniffImageMime` +
`maxImageBytes` + `maxPixels`; rate limit `rateLimiters.jobs`; lỗi qua `HttpError.safe` với câu
tiếng Việt; thiếu module ⇒ `503 IMAGESTUDIO_UNAVAILABLE`; `GET /api/config` thêm khối
`imagestudio: { available, templates, retouch_limits, matting:{name,is_mock,configured}, retouch:{...} }`.

### 3.7 E5 — UI (`public/**`)

Tab **“Tạo ảnh”** (thứ ba, cạnh “Nội dung” và “Dịch ảnh”):
- Kéo-thả ảnh → chọn **mẫu nền** (hiện nhãn “MÔ PHỎNG”) → thanh trượt **độ sáng / tương phản / bão
  hoà / nét** (giá trị trong ngưỡng, hiện rõ khi bị kẹp) → ô **chữ overlay** (tuỳ chọn) → **TẠO ẢNH**.
- Kết quả: ảnh **trước | sau** + tải về; hiện mọi cảnh báo thật (nền không tách được, tham số bị kẹp,
  overlay bị chặn vì thiếu bằng chứng) — **không được ẩn**.
- Escape toàn bộ text bằng `esc()`.

---

## 4. ĐỊNH NGHĨA "XONG" CỦA MVP-03

- Ảnh gốc bất biến (sha256 trên đĩa y hệt trước/sau toàn bộ luồng).
- Ảnh ra **cùng kích thước** ảnh gốc; pixel vùng GIỮ LẠI không đổi nếu không bật retouch.
- Mọi nền sinh ra có `synthetic: true`; UI ghi rõ “MÔ PHỎNG”.
- Vượt ngưỡng retouch ⇒ bị **kẹp** và ghi lại; không có đường nào vượt ngưỡng mà im lặng.
- Overlay có khẳng định thiếu bằng chứng ⇒ **không vẽ** + 422 kèm lý do.
- Tách nền không đủ tự tin ⇒ nói thẳng `UNIFORM_BACKGROUND_NOT_FOUND`/`SUSPICIOUS_MASK`, không cắt bừa.
- Mọi bước chạy đều có `usage_event` đúng operation; job lỗi có `error_code` + `finished_at`.
- `npm test` xanh và `node tools/verify.mjs` xanh.
