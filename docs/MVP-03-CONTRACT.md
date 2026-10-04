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
- **(vòng 8 — M03-01a)** `tolerance` mặc định = **12/255** (trước là 28: sản phẩm trắng/kem trên
  nền trắng có Δ≈26 ≤ 28 nên bị coi là NỀN ⇒ xoá sạch sản phẩm mà job vẫn báo `succeeded`).
  Sau khi loang phải **SOI BIÊN hai phía**: `measureBoundaryDelta` đo phía NỀN
  (`max`/`p95`/`over_ratio` so với `BOUNDARY_DELTA_SAFE = 8/255`) và phía GIỮ LẠI
  (`kept_min`/`kept_under_ratio` so với `BOUNDARY_DECISIVE_DELTA = 20/255`).
- **(vòng 8 — M03-01b) SIẾT `SUSPICIOUS_MASK`** — thêm hai ngưỡng, ghi rõ vì sao:
  `SUSPICIOUS_COVERAGE_MIN = 0.02` (giữ lại < 2% ảnh ⇒ gần như đã xoá sạch sản phẩm) và cặp
  `SUSPICIOUS_BACKGROUND_RATIO = 0.80` + `SUSPICIOUS_KEPT_BBOX_RATIO = 0.10` (nền đã tách > 80% mà
  hộp bao phần giữ lại < 10% khung ⇒ dấu hiệu "chỉ còn logo sống sót"). Ảnh TMĐT thật có sản phẩm
  chiếm ≥ 10% khung; dưới ngưỡng đó thà trả ảnh chỉ-retouch (luật #3).
- **(vòng 9 — N1) PHÂN LOẠI BA NHÁNH** (vòng 8 gộp cả hai vào `SUSPICIOUS_MASK` ⇒ ảnh có bóng đổ
  mềm, mask ĐÚNG, bị tố là "nghi ngờ ăn mất sản phẩm" — sai nguyên nhân và chặn oan):
  · **NGUY HIỂM** ⇒ `status = 'FAILED'` + `error_code = 'SUSPICIOUS_MASK'`, câu *"TỪ CHỐI kết quả
    tách nền (nghi ngờ ĂN MẤT SẢN PHẨM)…"*: tỉ lệ nền ngoài khoảng an toàn, giữ lại <
    `SUSPICIOUS_COVERAGE_MIN`, "đảo nhỏ" giữa nền lớn, **hoặc** `dirty_removed_ratio >
    AMBIGUOUS_DIRTY_AREA_MAX = 0.15` (một MẢNG LỚN không-phải-nền đã bị ăn; đo trên ảnh tổng hợp:
    bóng đổ mềm ~0.03, ca ăn sản phẩm ~0.30);
  · **NHẬP NHẰNG** ⇒ `status = 'SEGMENTATION_AMBIGUOUS'` + cùng tên mã, câu *"BIÊN NHẬP NHẰNG nên
    KHÔNG GHÉP NỀN (sản phẩm vẫn được giữ nguyên)… ảnh của bạn vẫn được RETOUCH…"*: phía NỀN có
    pixel lưng chừng nhưng diện tích bẩn nhỏ (bóng đổ mềm/viền mờ). Mặc định **KHÔNG ghép nền**;
  · **ĐẠT** ⇒ `OK`. Viền sản phẩm gần màu nền (`kept_under_ratio` cao) **một mình** KHÔNG hạ trạng
    thái (phía nền sạch nghĩa là flood fill giữ ĐÚNG sản phẩm — ca sản phẩm trắng/kem 244–248),
    chỉ thêm một câu *"Lưu ý: … hãy kiểm ảnh TRƯỚC|SAU"*.
- **`options.matting_allow_ambiguous = true`** (API; UI có checkbox “Vẫn ghép nền dù biên nhập
  nhằng”): với ca NHẬP NHẰNG, người dùng chấp nhận ghép nền ⇒ `status = OK`,
  `mask.ambiguous_override = true`, `content_meta.imagestudio.matting.ambiguous_override = true`,
  `asset.meta.matting.ambiguous_override = true` + warning nổi bật *"⚠️ ĐÃ BỎ QUA cảnh báo BIÊN
  NHẬP NHẰNG theo yêu cầu người dùng…"*. **Mặc định vẫn là KHÔNG ghép.**
- **(vòng 9 — N2) GIỚI HẠN VẬT LÝ:** sản phẩm chỉ khác nền **≤ 8/255** (`BOUNDARY_DELTA_SAFE`)
  KHÔNG THỂ phân biệt với nền bằng phương pháp đo màu ⇒ flood fill coi là nền và có thể ăn im lặng
  (đo được: `sản phẩm 251 + logo → OK, cov tụt 0.4307 → 0.1329`). Đây là giới hạn của phương pháp
  (không phải lỗi lập luận); cần tách được ca đó thì phải dùng provider `http`/AI.
- **(vòng 9 — N6) PROVIDER NGOÀI KHÔNG ĐO BIÊN:** chỉ `purejs` gọi `measureBoundaryDelta`; mọi
  provider khác ⇒ `mask.boundary_checked = false` + warning *"Provider … KHÔNG đo được biên vùng
  tách (chỉ provider "purejs" đo được) — hãy kiểm ảnh TRƯỚC|SAU trước khi dùng."* Đường `http`
  **chưa đo end-to-end** (xem `docs/VERIFICATION.md §14.4`).
- **(vòng 8 + 9) `mask` có thêm số đo MỞ RỘNG** (không thay 4 field đóng băng):
  `kept_bbox_ratio`, `boundary_delta = {count, max, p95, over_ratio, safe_delta, kept_count,
  kept_min, kept_p95, kept_under_ratio, decisive_delta, dirty_removed, dirty_removed_ratio,
  suspicious}`, `boundary_checked`, `ambiguous_override` — SỐ ĐO THẬT để người dùng và phản biện
  đọc được căn cứ; provider không đo thì field VẮNG MẶT (không bịa số 0).
  **(vòng 9 — N3)** `summarizeMatting` chuyển tiếp các số đo này ⇒ có mặt ở
  `content_meta.imagestudio.matting.mask`, `GET /api/imagestudio/jobs/:id → matting.mask`,
  `asset.meta.matting` và UI (khối “Số đo vùng tách nền”: Δp95, `over_ratio`, `kept_under_ratio`,
  `dirty_removed_ratio`, cờ override).
- **(vòng 8 — M03-01c) CÂU CHỮ:** provider KHÔNG được khẳng định "pixel sản phẩm giữ nguyên" (vùng
  "sản phẩm" do máy đoán). Câu đúng: *"Pixel NGOÀI vùng đã tách giữ nguyên từng byte; vùng đã tách
  do máy đoán theo màu nền — hãy mở ảnh TRƯỚC|SAU để kiểm."* UI hiện cảnh báo nổi bật **cho MỌI
  lượt có tách nền**.
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
**(vòng 8 — M03-05)** `composeImage` **chỉ ghép khi `matting.status === 'OK'`**; mọi trạng thái khác
(kể cả khi vẫn kèm buffer) ⇒ trả BẢN SAO y nguyên + lý do tiếng Việt (trước đây mask của lượt
matting ĐÃ THẤT BẠI vẫn đi vào ảnh ra). Mask có **alpha một phần** (0 < alpha < 255) vẫn được ghép
nhưng phải ĐẾM và cảnh báo nổi bật (pixel đó ra bán trong suốt).

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
**(vòng 8 — M03-05)** `retouch_effective` (và `meta.retouch_effective`) chỉ được ghi khi THẬT SỰ có
tham số hiệu lực: `status = 'NO_CHANGES'` hoặc `FAILED`/`UNSUPPORTED_IMAGE` ⇒ **= 0 ở cả 4 tham
số**; `retouch_clamped`/`retouch_rejected` vẫn giữ nguyên để không mất vết kẹp.
Retouch **không** được: đổi kích thước, dịch chuyển pixel, đổi kênh alpha của vùng trong suốt (nền đã
tách phải giữ alpha = 0), hay thay màu theo kiểu “đổi chất liệu”.

### 3.5 Overlay — chống bịa (dùng lại guardrail)

- Trước khi vẽ overlay, chạy kiểm bằng `checkClaimWords(textGốcCủaJob, overlay.text)` và
  `checkNumericClaims` của `src/imagelab/translate/guardrails.js`. Có vi phạm ⇒ **không vẽ**, trả
  `422 OVERLAY_UNSUPPORTED_CLAIM` kèm danh sách vi phạm. `textGốcCủaJob` = ghép các vùng chữ OCR +
  tên sản phẩm + ghi chú người dùng (nếu có); rỗng ⇒ coi như không có bằng chứng ⇒ mọi khẳng định
  bị chặn.
- **(vòng 8 — M03-02) BẰNG CHỨNG CHỈ ĐƯỢC LẤY TỪ DỮ LIỆU ĐÃ LƯU CỦA JOB:**
  `jobs.product_name`, vùng chữ trong DB (`store.listOcrRegions` — gồm vùng `source='user'` của
  MVP-02 IL-08) và ghi chú người dùng ĐÃ LƯU trong `content_meta` của job. **Bỏ hoàn toàn** việc
  nhận `overlay.source_text|sourceText|source|notes|evidence|ocr_text|product_name…` (16 khoá) từ
  client — kể cả trong `drawOverlay` (nay chỉ nhận `params.source_text` do SERVER truyền). Client
  gửi khoá nào thì tên khoá đó được ghi lại (`client_evidence_ignored`) và **nói ra** trong
  `warnings`; quyết định vẽ/không vẽ vẫn theo bằng chứng ĐÃ LƯU. Lý do: đúng lỗ "bằng chứng vòng"
  đã bị bắt ở MVP-01 (`docs/VERIFICATION.md §7.1`) — client vừa phát ngôn vừa tự cấp bằng chứng
  thì guardrail chỉ còn là thủ tục hình thức. Hệ quả: **không còn** nhánh "thấy client khai bằng
  chứng thì bỏ qua 422" (F7) — preflight luôn chạy trên bằng chứng đã lưu nên MỌI biến thể client
  khai bằng chứng đều **422**, 0 pixel chữ được vẽ.
- **(vòng 9 — N5) TRUY VẾT BẰNG CHỨNG:** kết quả overlay (kể cả khi BỊ CHẶN) mang
  `evidence_used = { sources: ['product_name'|'ocr_region'|'user_region'|'job_notes'], region_ids:
  [...], chars: N }` — có ở `content_meta.imagestudio.overlay`, trong kết quả `POST /generate`,
  `asset.meta.overlay` và UI (*“Bằng chứng dùng để duyệt chữ overlay: tên sản phẩm (đã lưu); vùng
  chữ do người dùng nhập (đã lưu) — vùng: #u1…”*). **Nguyên tắc:** dữ liệu NGƯỜI DÙNG ĐÃ LƯU vào
  job (`product_name` qua `PUT /api/jobs/:id/content`, vùng chữ qua
  `PUT /api/imagelab/jobs/:id/regions` với `source='user'`, ghi chú đã lưu trong `content_meta`)
  **là bằng chứng HỢP LỆ** — khác hẳn "client khai bằng chứng trong chính request", thứ đã bị CẤM
  ở M03-02: dữ liệu đó phải đi qua một route riêng, ghi BỀN vào DB, có dấu vết (`source`,
  `edited_by_user`), không phải field dùng-một-lần.
- Overlay **không** được chứa chữ CHƯA DỊCH — dùng `hasUntranslatedScript` (Hán + **kana +
  Hangul**, thay `hasCjk` từ vòng 8 — M03-04) và kiểm **TRƯỚC** danh sách vi phạm số liệu để trả
  đúng mã `OVERLAY_NOT_TRANSLATED` (trước đây `保修 12 个月` trả sai `OVERLAY_UNSUPPORTED_CLAIM`,
  còn kana/Hangul chỉ không được vẽ vì bộ font 5×7 thiếu glyph — may mắn của font, không phải luật).

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

### 3.6b CẤU HÌNH (bổ sung vòng 8 — M03-06)

`src/config.js` có ba khối mới (trước vòng 8 **không** có khoá nào ⇒ `IMAGESTUDIO_ENABLED=false`
bị bỏ qua và `MATTING_PROVIDER`/`RETOUCH_PROVIDER` luôn rơi về `purejs`):

| Biến môi trường | Khoá config | Mặc định | Ghi chú |
|---|---|---|---|
| `IMAGESTUDIO_ENABLED` | `imagestudio.enabled` | `true` | `false` ⇒ cả 5 route `/api/imagestudio/*` trả **503** + `/api/config.imagestudio.available=false` + `reason` |
| ~~`IMAGESTUDIO_DIR`~~ | ~~`imagestudio.dir`~~ | — | **BỎ ở vòng 9 (N4)**: không dòng mã nào đọc ⇒ config chết. Ảnh gốc VÀ ảnh tạo ra dùng CHUNG kho `IMAGELAB_DIR` (`src/imagelab/storage.js`) |
| `MATTING_PROVIDER` | `matting.provider` | `purejs` | `purejs`/`mock`/`http`/`none`; tên lạ ⇒ `UNKNOWN_PROVIDER` (fail-closed) |
| `MATTING_BASE_URL`/`_API_KEY`/`_MODEL`/`_TIMEOUT_MS` | `matting.*` | rỗng / 60000 | `http` thiếu `baseUrl` ⇒ `NOT_CONFIGURED` |
| `RETOUCH_PROVIDER` | `retouch.provider` | `purejs` | `purejs`/`mock`/`none` (không có `http`) |
| `RETOUCH_MAX_BRIGHTNESS`/`_CONTRAST`/`_SATURATION`/`_SHARPEN` | `retouch.limits.*` | 0.25/0.25/0.30/0.50 | ⚠️ **CHỈ SIẾT ĐƯỢC**: ngưỡng hiệu lực = `min(cấu hình, RETOUCH_LIMITS §3.4)` |

`COST_IMAGE_MATTING`/`COST_IMAGE_COMPOSE`/`COST_IMAGE_RETOUCH` thêm vào khối `cost`. Toàn bộ biến
được ghi kèm chú thích tiếng Việt trong `.env.example`. Ngưỡng CHẤT LƯỢNG của thuật toán
(`tolerance`, `minUniformity`, các ngưỡng biên) **không** đưa ra môi trường: siết/nới chúng qua env
là đổi luật fail-closed.

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
