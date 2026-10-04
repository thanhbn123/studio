# MVP-02 — HỢP ĐỒNG GIAO DIỆN (ĐÓNG BĂNG)

> **File này là luật.** Năm agent code song song chỉ được viết đúng phần mình sở hữu, và
> mọi tên hàm / tên field / mã lỗi dưới đây là **hợp đồng đóng băng** — không được tự đổi.
> Nếu thấy hợp đồng sai, **báo lại người điều phối**, KHÔNG tự sửa rồi để agent khác lệch theo.

Ngày khoá: 03/10/2026 · Người khoá: phiên điều khiển DSH · Nhánh: `feat/mvp02-imagelab`

---

## 0. Mục tiêu MVP-02

Dịch chữ Trung trên **ảnh sản phẩm** sang tiếng Việt, giữ nguyên bố cục và phong cách:

```
ảnh người dùng tải lên
  → OCR phát hiện vùng chữ (hộp bao + nội dung + ngôn ngữ + độ tin cậy)
  → phân loại từng vùng (mô tả / nhãn hiệu / chứng nhận / giá)
  → dịch sang tiếng Việt (có bảng duyệt để người dùng sửa TỪNG DÒNG)
  → người dùng duyệt
  → xoá chữ cũ (inpainting) + render chữ Việt vào đúng hộp, tự chọn cỡ chữ vừa hộp
  → ảnh mới có truy vết về ảnh gốc; ảnh gốc BẤT BIẾN
```

Ghi `usage_event` cho hai operation mới: `OCR_DETECT`, `IMAGE_RENDER`.

---

## 1. NĂM LUẬT BẤT KHẢ XÂM PHẠM (mọi agent phải giữ)

1. **Không bịa.** Không có field nào được sinh ra mà không chứng minh được nguồn. Provider giả
   PHẢI tự khai `is_mock = true`. Không kết quả nào của MVP-02 được dán nhãn `LIVE_VERIFIED`.
2. **Ảnh gốc bất biến.** Không ghi đè file gốc; buffer đầu vào không được sửa tại chỗ
   (in-place). Mọi ảnh sinh ra là **bản ghi mới** có `parent_id` trỏ về ảnh gốc + `sha256` cả hai.
3. **Nhãn hiệu / chứng nhận KHÔNG BAO GIỜ bị dịch hay xoá.** Chúng bị đánh dấu, bị bỏ qua, và
   lý do được ghi lại. Chỉ người dùng mới được override, và override phải để lại vết.
4. **Fail-closed, không fail-im lặng.** Thiếu provider → `NOT_CONFIGURED`. Ảnh không giải mã
   được → `UNSUPPORTED_IMAGE`. Không đủ chỗ cho chữ → `fits: false` và **bỏ qua vùng đó**, không
   bao giờ tràn ra ngoài hộp hay vẽ đè lên vùng khác trong im lặng.
5. **Không thêm dependency ngoài `pg`.** Chỉ dùng module có sẵn của Node (`node:zlib`,
   `node:crypto`, `node:fs`…). Tiếng Việt trong comment/thông báo; định danh code bằng tiếng Anh.

---

## 2. BẢN ĐỒ SỞ HỮU FILE (chỉ được GHI trong cột "sở hữu")

| Agent | Được ghi (sở hữu) | Chỉ được đọc |
|---|---|---|
| **C1 — OCR** | `src/imagelab/ocr/**`, `src/config.js`, `.env.example` | mọi thứ khác |
| **C2 — Dịch & duyệt** | `src/imagelab/translate/**` | `src/ai/provider.js`, `src/content/guardrails.js` |
| **C3 — Render & pixel** | `src/imagelab/render/**` | `src/security/sanitize.js` |
| **C4 — Store/Jobs/App** | `src/imagelab/pipeline.js`, `src/imagelab/storage.js`, `src/store/schema.sql`, `src/store/index.js`, `src/store/migrate.js`, `src/app.js` | `src/imagelab/ocr/**`, `src/imagelab/translate/**`, `src/imagelab/render/**` |
| **C5 — API & UI** | `src/http/routes.js`, `public/app.js`, `public/index.html`, `public/styles.css` | tất cả |
| **Test** | `test/**` | tất cả |
| **Phản biện** | `docs/MVP-02-REVIEW.md` | tất cả |
| **Gộp** | mọi file (sửa lệch hợp đồng), trừ `docs/MVP-02-REVIEW.md` | tất cả |

**Cấm với 5 agent code:** không sửa `test/**`, không sửa `src/sources/**`, `src/vision/**`,
`src/content/**` (chỉ import), không chạy `git commit`/`git checkout`/`git stash`, không đổi
`package.json` (trừ C4 nếu buộc phải thêm script — phải báo), không tạo file ngoài danh sách.

**Bắt buộc trước khi báo xong:** `node --check` mọi file mình sửa, và `npm test` phải giữ
**183 test cũ pass** (1 skipped là bình thường). Nếu test đỏ ở file mình KHÔNG sở hữu → ghi lại
vào báo cáo, KHÔNG tự sửa file người khác.

---

## 3. HỢP ĐỒNG DỮ LIỆU

### 3.1 `ImageAsset` (C4 ghi DB, C5 đọc qua store)

```js
{
  id: 'uuid',
  job_id: 'uuid',
  session_id: 'string',
  role: 'original' | 'rendered',
  parent_id: 'uuid|null',        // rendered → original; original → null
  mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
  bytes: 12345,
  width: 800,                    // null nếu chưa dò được
  height: 600,
  sha256: 'hex',
  storage_path: '<job_id>/<asset_id>.png',   // TƯƠNG ĐỐI trong imagelab.dir
  source: 'upload' | 'render',
  meta: object|null,             // vd: { applied, unsupported_glyphs, warnings }
  created_at: 'ISO-8601'
}
```

### 3.2 `Region` (C1 sinh, C4 lưu, C5 hiển thị)

```js
{
  id: 'r1',                      // do normalizeRegions gán: thứ tự đọc trên→dưới, trái→phải
  box: { x: 12, y: 40, w: 120, h: 32 },        // PIXEL, số nguyên, đã clamp vào ảnh
  box_normalized: { x: 0.015, y: 0.05, w: 0.15, h: 0.04 },  // 0..1, 6 chữ số thập phân
  text: '纯棉短袖T恤',            // nguyên văn chữ đọc được — KHÔNG dịch, KHÔNG suy diễn
  lang: 'zh-Hans',               // 'zh' | 'zh-Hans' | 'zh-Hant' | 'und'
  confidence: 0.93,              // 0..1
  kind: 'descriptive',           // 'descriptive'|'brand'|'certification'|'price'|'unknown'
  kind_reason: 'chữ mô tả thông thường',
  translatable: true,            // LUÔN === (kind === 'descriptive')
  source: 'ocr' | 'user'
}
```

### 3.3 `TranslatedLine` (C2 sinh, C4 lưu, C5 sửa)

```js
{
  region_id: 'r1',
  text_original: '纯棉短袖T恤',
  text_vi: 'Áo thun tay ngắn cotton',
  status: 'TRANSLATED',          // xem bảng trạng thái bên dưới
  provenance: 'ai',              // 'ai' | 'glossary' | 'user' | 'none'
  confidence: 0.8,
  violations: [],                // lý do cần người duyệt (tiếng Việt, hiện thẳng lên UI)
  edited_by_user: false,
  edited_at: null,
  notes: ''
}
```

| `status` | nghĩa |
|---|---|
| `TRANSLATED` | dịch xong, không có vi phạm |
| `GLOSSARY` | lấy từ điển thuật ngữ, không gọi AI |
| `SKIPPED_BRAND` | là nhãn hiệu → KHÔNG dịch, `text_vi = ''` |
| `SKIPPED_CERTIFICATION` | là chứng nhận → KHÔNG dịch, `text_vi = ''` |
| `SKIPPED_PRICE` | là giá → KHÔNG dịch (giá do người bán quyết) |
| `SKIPPED_BY_USER` | **người dùng CHỦ ĐỘNG bỏ qua** (`action: 'skip'`) — khác `NEEDS_REVIEW`: không chặn render, luôn vào `skipped` kèm lý do (bổ sung sau phản biện F-06) |
| `NEEDS_REVIEW` | có vi phạm guardrail, phải người duyệt |
| `USER_EDITED` | người dùng đã sửa |
| `FAILED` | provider lỗi cho riêng dòng này |

### 3.4 `RenderOp` (C5/C4 dựng, C3 thực thi)

```js
{
  region_id: 'r1',
  box: { x, y, w, h },           // pixel trên ẢNH GỐC
  action: 'erase' | 'draw_text' | 'erase_and_draw',
  text: 'Áo thun tay ngắn',      // bắt buộc khi action có draw_text
  style: { color: [20,20,20], align: 'center', bold: false, padding: 2 }   // tuỳ chọn
}
```

---

## 4. HỢP ĐỒNG MODULE

### 4.1 C1 — `src/imagelab/ocr/`

**`src/imagelab/ocr/index.js`**

```js
export class OcrError extends Error {}          // .code, .details
export class OcrProvider {
  get name() {}          // 'mock' | 'http' | 'none'
  get model() {}         // string
  get isMock() {}        // boolean — BẮT BUỘC đúng sự thật
  get configured() {}    // boolean
  async detect({ buffer, mime, width, height }, { maxRegions, minConfidence } = {}) → OcrResult
}
export function createOcrProvider(config, { logger } = {}) → OcrProvider
export function classifyRegion(text) → { kind, kind_reason, translatable }
export function normalizeRegions(rawRegions, { width, height, maxRegions, minConfidence }) → { regions, dropped, warnings }
```

**`OcrResult` (đóng băng)**

```js
{
  status: 'OK' | 'NO_TEXT' | 'NOT_CONFIGURED' | 'FAILED' | 'UNSUPPORTED_IMAGE',
  provider, model, is_mock,
  regions: Region[],
  dropped: [{ reason: string, text?: string }],
  warnings: string[],
  usage: { input_units: number, output_units: number } | null,
  error_code: string | null, error_message: string | null
}
```

- `provider: 'mock'` → đọc vùng từ fixture JSON (`config.ocr.mockFixture`, mặc định
  `src/imagelab/ocr/fixtures/mock-regions.json`), `is_mock = true`, `status = 'OK'`.
  Fixture phải chứa vùng chữ Trung THẬT của một ảnh sản phẩm, gồm đủ 4 loại `kind` để test.
- `provider: 'http'` → adapter REST tổng quát: POST `${baseUrl}` body
  `{ image_base64, mime, width, height, max_regions }`, chờ JSON `{ regions: [...] }`.
  Dùng `safeFetch` của `src/security/fetcher.js` (đọc, không sửa). `is_mock = false`.
- `provider: 'none'` hoặc thiếu key/baseUrl → `status: 'NOT_CONFIGURED'`, `regions: []`.
- `classifyRegion` nhận diện tối thiểu: `®`, `™`, `商标`, `品牌`, `官方`, `旗舰店` → `brand`;
  `认证`, `合格证`, `检验`, `CE`, `FDA`, `ISO`, `3C`, `RoHS` → `certification`;
  `¥`, `￥`, `元`, `价格`, `包邮` + số → `price`; còn lại → `descriptive`.
  Không chắc → `unknown` và `translatable = false` (**fail-closed**: không dịch thứ mình không hiểu).
- `normalizeRegions` phải: bỏ vùng rỗng/whitespace, bỏ vùng dưới `minConfidence`, clamp hộp
  vào biên ảnh, bỏ vùng có `w<=0 || h<=0`, bỏ vùng trùng khít, sắp theo thứ tự đọc, cắt còn
  `maxRegions`, và **ghi lại mọi vùng bị bỏ vào `dropped`** kèm lý do.

**Config C1 phải thêm vào `src/config.js`** (khối `imagelab`, `ocr`, `render`, `translate`,
`cost.OCR_DETECT`, `cost.IMAGE_RENDER`):

```js
imagelab: { enabled, dir, maxImageBytes, maxPixels, maxRegions, minConfidence, fontScale, maxOutputBytes },
ocr:    { provider, apiKey, baseUrl, model, timeoutMs, mockFixture },
render: { provider, apiKey, baseUrl, model, timeoutMs },
translate: { provider, apiKey, baseUrl, model, timeoutMs },   // mặc định kế thừa khối `ai`
```
Biến môi trường (ghi vào `.env.example`, kèm chú thích tiếng Việt):
`IMAGELAB_ENABLED`, `IMAGELAB_DIR`, `IMAGELAB_MAX_IMAGE_BYTES`, `IMAGELAB_MAX_PIXELS`,
`IMAGELAB_MAX_REGIONS`, `IMAGELAB_MIN_CONFIDENCE`, `IMAGELAB_FONT_SCALE`,
`OCR_PROVIDER`, `OCR_API_KEY`, `OCR_BASE_URL`, `OCR_MODEL`, `OCR_TIMEOUT_MS`, `OCR_MOCK_FIXTURE`,
`RENDER_PROVIDER`, `RENDER_API_KEY`, `RENDER_BASE_URL`, `RENDER_MODEL`, `RENDER_TIMEOUT_MS`,
`TRANSLATE_PROVIDER`, `TRANSLATE_API_KEY`, `TRANSLATE_BASE_URL`, `TRANSLATE_MODEL`,
`COST_OCR_DETECT`, `COST_IMAGE_RENDER`.

Mặc định an toàn: `OCR_PROVIDER=mock`, `RENDER_PROVIDER=purejs`.

### 4.2 C2 — `src/imagelab/translate/`

**`src/imagelab/translate/index.js`**

```js
export class Translator {
  get name(); get model(); get isMock(); get configured();
  async translateRegions(regions, { context = '', glossaryExtra = {} } = {}) → TranslateResult
}
export function createTranslator(config, { logger, aiProvider } = {}) → Translator
export function applyReviewEdits(lines, edits, { allowBrandOverride = false } = {})
  → { lines, rejected: [{region_id, reason}], warnings: string[] }
export function enforceTranslationGuardrails(line, { region } = {}) → { line, violations: string[] }
export const GLOSSARY            // Map/Object: thuật ngữ TMĐT Trung → Việt
export const NEVER_TRANSLATE     // mảng RegExp: mẫu chữ CẤM dịch
```

**`TranslateResult`**
```js
{ status: 'OK'|'NO_LINES'|'NOT_CONFIGURED'|'FAILED', provider, model, is_mock,
  lines: TranslatedLine[], warnings: string[], usage: {input_units, output_units}|null,
  error_code: string|null, error_message: string|null }
```

Luật của C2 (đây là phần dễ bịa nhất — phải siết):
- Vùng `translatable === false` → **không bao giờ** gọi AI cho vùng đó; trả
  `SKIPPED_BRAND` / `SKIPPED_CERTIFICATION` / `SKIPPED_PRICE` / `NEEDS_REVIEW` (với `unknown`),
  `text_vi = ''`, `provenance = 'none'`.
- Guardrail bắt buộc (ghi vào `violations`, đặt `NEEDS_REVIEW`):
  a) `text_vi` chứa **số liệu/đơn vị không có trong `text_original`** (số, %, ml, W, mAh, kg, cm…);
  b) `text_vi` vẫn còn ký tự CJK → "CHƯA DỊCH";
  c) `text_vi` chứa từ khẳng định thuộc nhóm cấm (bảo hành, chứng nhận, chống nước, chính hãng,
     số 1, tốt nhất) mà `text_original` không có;
  d) `text_vi` rỗng nhưng `translatable === true`.
- `providers`: `mock` (từ điển thuật ngữ + ghép cơ học, `is_mock = true`), `ai` (dùng
  `createProvider()` của `src/ai/provider.js` với khối `config.translate`, `is_mock = false`),
  `none` → `NOT_CONFIGURED`.
- `applyReviewEdits`: `edits = [{ region_id, text_vi, action: 'accept'|'edit'|'skip' }]`.
  Sửa dòng `brand`/`certification` chỉ được khi `allowBrandOverride === true`; nếu không → đẩy vào
  `rejected` kèm lý do. `edit` → `status = 'USER_EDITED'`, `provenance = 'user'`,
  `edited_by_user = true`, `edited_at = ISO`. Dòng bị sửa vẫn phải qua `enforceTranslationGuardrails`.
- Không gọi AI khi không có vùng nào translatable → trả `NO_LINES`/`OK` mà không tốn usage.

### 4.3 C3 — `src/imagelab/render/`

**`src/imagelab/render/index.js`**

```js
export class RenderError extends Error {}       // .code, .details
export class RenderProvider {
  get name(); get model(); get isMock(); get configured();
  async probe({ buffer, mime }) → { width, height } | null
  async render({ image, ops, options } = {}) → RenderResult
}
export function createRenderProvider(config, { logger } = {}) → RenderProvider
export function layoutText({ text, box, font, options } = {}) → LayoutResult
export function loadFont(name = '5x7') → Font
export function sha256(buffer) → string
```

**`RenderResult`**
```js
{
  status: 'OK'|'PARTIAL'|'UNSUPPORTED_IMAGE'|'NOT_CONFIGURED'|'FAILED',
  provider, model, is_mock,
  output: { buffer, mime, width, height, sha256 } | null,
  original_sha256: 'hex',                       // chứng minh ảnh gốc không đổi
  applied: [{ region_id, action, box, font_size?, lines?, text? }],
  skipped: [{ region_id, reason }],             // reason: 'TEXT_TOO_LONG'|'BOX_TOO_SMALL'|'NO_GLYPH'|'BAD_BOX'|…
  unsupported_glyphs: string[],
  warnings: string[], elapsed_ms: number,
  error_code: string|null, error_message: string|null
}
```

**`LayoutResult`**
```js
{ fits: boolean, font_size: number, line_height: number,
  lines: [{ text, x, y, w, h }],
  reason: null | 'TEXT_TOO_LONG' | 'BOX_TOO_SMALL' | 'BAD_BOX' }
```
Luật: `fits === true` thì **mọi** đường bao chữ phải nằm TRONG `box` (có test hình học kiểm).
`erase_and_draw` chỉ được xoá đúng vùng `box` của chính nó, không được tràn sang vùng khác.

Provider của C3:
- `mock` — không đổi pixel, trả bản sao buffer + `applied` mô tả, `is_mock = true`.
- `purejs` — **thật**, chạy offline, chỉ PNG:
  - `png.js`: `decodePng(buffer)` (8-bit, color type 0/2/4/6, non-interlaced; gặp 16-bit /
    interlaced / palette → ném `RenderError('PNG_UNSUPPORTED')`), `encodePng({width,height,data,channels})`,
    chặn `width*height > maxPixels` → `IMAGE_TOO_LARGE`.
  - `inpaint.js`: `estimateBackground(pixels, box)` = trung vị viền ngoài hộp; tô lại vùng hộp.
  - `font/`: font bitmap 5x7 + **ghép dấu tiếng Việt** (sắc/huyền/hỏi/ngã/nặng + mũ/trăng/móc/đ)
    để render được chữ Việt có dấu. Ký tự không có glyph → **không vẽ**, đẩy vào
    `unsupported_glyphs` và `skipped`, `status = 'PARTIAL'`.
  - Với input không phải PNG (vd JPEG) → `status: 'UNSUPPORTED_IMAGE'`,
    `error_code: 'RENDER_JPEG_UNSUPPORTED'`, thông báo nói rõ cần cắm provider `http`.
  - **Không được sửa buffer đầu vào** (copy trước khi vẽ) — test sẽ so `sha256` trước/sau.
- `http` — POST `${baseUrl}` `{ image_base64, ops }` → `{ image_base64, applied?, unsupported_glyphs? }`
  qua `safeFetch`; `is_mock = false`.
- `none` → `NOT_CONFIGURED`.

### 4.4 C4 — store, storage, pipeline, wiring

**`src/imagelab/storage.js`**
```js
export function createImageStorage(config, { logger } = {}) → {
  async save({ jobId, assetId, ext, buffer }) → { storage_path, bytes, sha256 },
  async read(asset) → Buffer,
  async exists(asset) → boolean,
  async remove(asset) → void
}
```
Đường dẫn = `<imagelab.dir>/<jobId>/<assetId>.<ext>`; `jobId`/`assetId` phải khớp
`/^[A-Za-z0-9_-]{1,64}$/` nếu không → ném lỗi (chống path traversal). Ghi kiểu nguyên tử
(ghi file tạm `.tmp` rồi `rename`). Không bao giờ ghi ra ngoài `imagelab.dir`.

**Schema (`src/store/schema.sql`)** — thêm cột `jobs.kind` (mặc định `'content'`) và 3 bảng:

```sql
-- jobs.kind: 'content' (MVP-01) | 'image_translation' (MVP-02)
CREATE TABLE IF NOT EXISTS image_assets (
  id TEXT PRIMARY KEY, job_id TEXT, session_id TEXT, role TEXT NOT NULL, parent_id TEXT,
  mime TEXT, bytes INTEGER, width INTEGER, height INTEGER, sha256 TEXT, storage_path TEXT,
  source TEXT, meta TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_image_assets_job ON image_assets (job_id, role);

CREATE TABLE IF NOT EXISTS ocr_regions (
  id TEXT PRIMARY KEY, job_id TEXT, asset_id TEXT, region_key TEXT,
  x INTEGER, y INTEGER, w INTEGER, h INTEGER,
  x_norm REAL, y_norm REAL, w_norm REAL, h_norm REAL,
  text_original TEXT, lang TEXT, confidence REAL, kind TEXT, kind_reason TEXT,
  translatable INTEGER DEFAULT 0, source TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_ocr_regions_job ON ocr_regions (job_id);

CREATE TABLE IF NOT EXISTS translation_lines (
  id TEXT PRIMARY KEY, job_id TEXT, region_key TEXT, text_original TEXT, text_vi TEXT,
  status TEXT, provenance TEXT, confidence REAL, violations TEXT, notes TEXT,
  edited_by_user INTEGER DEFAULT 0, edited_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_translation_lines_job ON translation_lines (job_id);
```

**`Store` API mới (đóng băng tên)**
```js
JOB_STATUS.AWAITING_REVIEW = 'awaiting_review'      // thêm vào object đã có
USAGE_OPERATIONS += 'OCR_DETECT', 'IMAGE_RENDER'    // giữ nguyên 5 cái cũ

async createJob({ ..., kind = 'content' })
async createImageAsset({ id?, jobId, sessionId, role, parentId, mime, bytes, width, height, sha256, storagePath, source, meta }) → id
async getImageAsset(id) → ImageAsset | null
async listImageAssets(jobId, { role } = {}) → ImageAsset[]
async saveOcrRegions(jobId, assetId, regions) → number     // idempotent: xoá region cũ của job rồi ghi lại
async listOcrRegions(jobId) → Array<Region & { asset_id, region_key }>
async saveTranslationLines(jobId, lines) → number          // idempotent theo job
async listTranslationLines(jobId) → TranslatedLine[]
async updateTranslationLines(jobId, lines) → number        // update theo region_key
```
`#hydrateJob` phải trả thêm `kind`. `products_master`, `vision`… giữ nguyên.

**Migration cộng thêm (additive)** — bảng cũ đã tồn tại trong `data/studio.db`:
`Store.init()` chạy thêm `#applyAdditiveMigrations()` **idempotent**:
- SQLite: đọc `PRAGMA table_info(jobs)`, thiếu `kind` thì `ALTER TABLE jobs ADD COLUMN kind TEXT DEFAULT 'content'`.
- Postgres: `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'content'`.
Chạy `init()` hai lần liên tiếp không được lỗi (test sẽ kiểm).

**`src/imagelab/pipeline.js`**
```js
export const IMAGELAB_STAGES = Object.freeze(['queued','storing','ocr','translating','awaiting_review','rendering','done','failed']);
export class ImageTranslationPipeline {
  constructor({ config, logger, store, storage, ocrProvider, translator, renderProvider })
  async ingest(jobId, { image, sessionId, options }) → { asset_id, asset, width, height, sha256 }
  async runOcr(jobId, { sessionId, options } = {}) → { status, regions, lines, ocr, translate }
  async renderApproved(jobId, { sessionId, onlyRegionIds, force = false } = {}) → { status, asset, render }
}
```
- `runOcr` lưu regions + lines rồi đặt `status = JOB_STATUS.AWAITING_REVIEW`, `stage = 'awaiting_review'`,
  `finished_at = null`. **Không tự render.**
- `renderApproved`: thiếu lines → `IMAGELAB_NO_LINES`; còn dòng `NEEDS_REVIEW` chưa duyệt mà
  `force !== true` → ném lỗi có `code = 'REVIEW_REQUIRED'`; khi `force` phải ghi lý do vào
  `asset.meta.forced` + `warnings`. Chỉ dựng `RenderOp` cho dòng có `text_vi` khác rỗng và
  `status` ∈ {TRANSLATED, GLOSSARY, USER_EDITED}. Dòng bị bỏ phải vào `skipped` kèm lý do.
- Ghi `usage_event`: `OCR_DETECT` (input_units = số pixel, output_units = số region),
  `TRANSLATION` (input/output = số ký tự), `IMAGE_RENDER` (input_units = số op, output_units = số op đã áp dụng).
- Ghi `extraction_evidence` cho job imagelab: `connector = 'imagelab'`,
  `extraction_method = 'upload+render'`, `verification = 'MANUAL_INPUT'` (ảnh người dùng tải lên),
  và nếu có bước nào chạy provider mock thì ghi vào `blocked_reason`/meta danh sách bước mock —
  **tuyệt đối không `LIVE_VERIFIED`**.
- Lỗi provider KHÔNG được làm job treo: đặt `status = failed`, `error_code` rõ, `finished_at`.

**`src/app.js`** — bơm thêm: `ocrProvider`, `renderProvider`, `translator`, `storage`,
`imagelabPipeline`; truyền vào `buildRouter(app)`. Giữ nguyên hành vi cũ (183 test cũ phải xanh).

### 4.5 C5 — API + UI

**Routes (đóng băng)**
```
POST /api/imagelab/jobs             body { image: {base64, filename?}, options?: {context?, glossary_extra?, max_regions?} }
                                    → 202 { job_id, asset_id, status, poll }
GET  /api/imagelab/jobs/:id         → 200 { job, asset, rendered: ImageAsset[], regions: Region[],
                                            lines: TranslatedLine[], render_summary, warnings: string[],
                                            providers: { ocr, render, translate } }
PUT  /api/imagelab/jobs/:id/lines   body { edits: [{region_id, text_vi, action}], allow_brand_override?: boolean }
                                    → 200 { lines, rejected, warnings }
POST /api/imagelab/jobs/:id/render  body { only_region_ids?, force? } → 202 { job_id, status }
GET  /api/imagelab/assets/:id       → 200 metadata (KHÔNG kèm bytes)
GET  /api/imagelab/assets/:id/file  → 200 ảnh nhị phân, `Content-Type` đúng, `Cache-Control: private, no-store`
```
Luật C5:
- Mọi route phải kiểm **quyền sở hữu theo session**: `job.session_id !== sid` → **404**
  (không phải 403 — không xác nhận sự tồn tại của job người khác). Áp dụng cả cho assets.
- Validate ảnh bằng `sniffImageMime` (không tin Content-Type), chặn theo
  `config.net.allowedImageMime`, `imagelab.maxImageBytes`, `imagelab.maxPixels`.
- Rate limit dùng `rateLimiters.jobs` như các route nặng khác.
- `GET /api/config` thêm khối `imagelab` (mục 4.5.1) — UI dựa vào đó để hiện nhãn MOCK.
- Lỗi trả `HttpError(status, code, message_vi)`; không lộ stack/đường dẫn nội bộ.

**4.5.1 Khối `imagelab` trong `GET /api/config`**
```js
imagelab: {
  enabled: true,
  ocr:       { name, model, configured, is_mock },
  render:    { name, model, configured, is_mock },
  translate: { name, model, configured, is_mock },
  limits:    { max_image_bytes, max_pixels, max_regions, allowed_image_mime },
  kinds:     ['descriptive','brand','certification','price','unknown'],
  max_render_pixels: number
}
```

**UI (`public/`)** — thêm khu "Dịch ảnh Trung → Việt" (tab riêng, không phá giao diện MVP-01):
1. Chọn/kéo-thả ảnh (PNG/JPEG/WebP/GIF) → tạo job → poll `GET /api/imagelab/jobs/:id` tới
   `awaiting_review` (hiện tiến trình theo `stage`).
2. Hiện ảnh gốc; bảng duyệt: `chữ gốc (Trung)` | `chữ Việt (input sửa được)` | `loại` | `trạng thái`
   | `lý do cần duyệt`. Vùng `brand`/`certification`/`price` hiện **khoá, không cho sửa** kèm lý do
   và nút "vẫn dịch vùng này" (gửi `allow_brand_override: true` — có ghi vết).
3. Nút "Lưu & duyệt tất cả" (`PUT .../lines`) và "Render ảnh" (`POST .../render`).
4. Hiện ảnh kết quả cạnh ảnh gốc (trước/sau) + nút tải về (`GET .../file`).
5. Hiện **cảnh báo thật**: nhãn `MOCK` nếu provider là mock, danh sách glyph thiếu, vùng bị bỏ
   kèm lý do, vi phạm guardrail. Không được ẩn.
6. **Escape toàn bộ** text lấy từ OCR/DB trước khi chèn vào DOM (`escapeHtml`) — chữ Trung trong
   ảnh là dữ liệu không tin cậy.

### 4.6 Luật chống vỡ khi 5 agent lắp ráp SONG SONG

Năm agent viết cùng lúc nên có lúc module anh em **chưa kịp tồn tại**. Vì vậy:

- **C4 (`src/app.js`)**: khối MVP-02 phải được nạp **phòng thủ** — bọc trong `try/catch`
  (dynamic `import()` cũng được). Nếu nạp lỗi: ghi log `imagelab.wiring_failed`, đặt
  `app.imagelabPipeline = null`, `app.ocrProvider/renderProvider/translator = null`, và
  **MVP-01 phải vẫn khởi động bình thường**. Không được để MVP-02 làm chết boot của MVP-01.
- **C5 (`src/http/routes.js`)**: mọi route `/api/imagelab/*` phải kiểm
  `imagelabPipeline`/`storage` trước; thiếu → `HttpError(503, 'IMAGELAB_UNAVAILABLE', ...)`.
- `GET /api/health` và `GET /api/config` phải trả `imagelab: { available: boolean }` để UI biết.
- Khi lắp ráp xong, agent Gộp sẽ **gỡ bỏ** lớp phòng thủ nếu không còn cần — nhưng chỉ sau khi
  tất cả module đã tồn tại và test xanh.

**Bổ sung sau khi Gộp lắp ráp (04/10/2026) — không đổi tên nào đã đóng băng ở trên:**

- `imagelab` ở `/api/health` và `/api/config` trả thêm `reason: string|null` — lý do THẬT khi
  `available = false` (đã lọc secret + đường dẫn tuyệt đối), `null` khi khả dụng. Log
  `imagelab.wiring_failed` ghi ở mức **error** kèm `module` (đường dẫn tương đối của module hỏng).
  `available` = nạp được pipeline + storage **và** `config.imagelab.enabled !== false`.
- **Một luật, một chỗ:** C5 KHÔNG được chép lại luật của module anh em. Bản dự phòng
  `applyEditsFallback` (mô phỏng `applyReviewEdits`) đã bị **xoá** vì lệch thật với C2; luật
  "còn dòng nào chặn render" nay do `pendingReviewLines()` export từ `src/imagelab/pipeline.js`
  cung cấp cho cả `renderApproved` (C4) và `POST .../render` (C5).
- `POST /api/imagelab/jobs` chạy `ingest()` **ngay trong request** rồi mới xếp hàng `runOcr`, nhờ
  vậy `asset_id` trong body 202 là giá trị THẬT (không còn `null`) và lỗi ảnh trả về dưới dạng
  HTTP ngay (415 `UNSUPPORTED_IMAGE`, 413 `IMAGE_TOO_LARGE`/`PIXELS_EXCEEDED`) thay vì một job
  chết trong hàng đợi.

---

## 5. ĐỊNH NGHĨA "XONG" CỦA MVP-02

- Ảnh gốc không đổi sau toàn bộ luồng: cùng `sha256` trên đĩa và trong DB.
- Ảnh render là bản ghi MỚI có `parent_id` + `sha256` riêng; không có đường nào ghi đè ảnh gốc.
- Vùng `brand`/`certification` không bị dịch và không bị xoá khỏi ảnh (trừ override có vết).
- Mọi bước đều có `usage_event`; job lỗi có `error_code` + `finished_at`, không treo `running`.
- Provider mock luôn tự khai `is_mock`; UI hiện nhãn MOCK; không có nhãn LIVE nào trong MVP-02.
- `npm test` xanh (183 test cũ + test mới của agent test) và `node tools/verify.mjs` xanh.

---

## 6. SỬA ĐỔI SAU PHẢN BIỆN (vòng 2 — bổ sung, KHÔNG đổi tên nào đã đóng băng)

Nguồn: [`docs/MVP-02-REVIEW.md`](MVP-02-REVIEW.md) (FAIL: 1 CRITICAL · 2 MAJOR · 5 MINOR).
Mọi tên hàm / tên field / mã lỗi ở các mục 1–5 **giữ nguyên**; dưới đây chỉ bổ sung và siết luật.

**F-01 — vùng bảo vệ (protected boxes), phòng thủ ba tầng**

- `Region` không đổi. `normalizeRegions` (C1) bổ sung: hai vùng **cùng hộp nhưng khác chữ** →
  giữ vùng có mức bảo vệ cao nhất (`brand|certification|price > unknown > descriptive`, trong
  nhóm bảo vệ: `brand > certification > price`), vùng còn lại vào `dropped` kèm lý do; và thêm
  `warnings` liệt kê mọi cặp hộp **giao nhau** (chạm cạnh không tính).
- `render({ image, ops, options })` (C3) nhận thêm `options.protected_boxes` — mảng hộp, nhận cả
  hai dạng `{x,y,w,h}` và `{region_id, box}`. Provider `purejs` **không được đổi bất kỳ pixel nào**
  trong các hộp đó (mặt nạ ở tầng ghi pixel); op nằm trọn trong vùng bảo vệ → `skipped`
  `PROTECTED_BOX_MASKED`; op bị chặn một phần → vẫn vẽ nhưng `applied[].masked = true` + cảnh báo.
  Op của **chính** vùng được bảo vệ (override có vết) vẫn vẽ được lên vùng của nó.
- `renderApproved` (C4) **không dựng op** nếu hộp của op giao với hộp của vùng được bảo vệ **khác**
  (kể cả lồng nhau / trùng hộp) → `skipped` với lý do bắt đầu bằng `BOX_OVERLAPS_PROTECTED: <id> (<kind>)`.
  Vùng được coi là bảo vệ khi `kind ∈ {brand,certification,price}` **hoặc** dòng có
  `status ∈ {SKIPPED_BRAND, SKIPPED_CERTIFICATION, SKIPPED_PRICE}` (hai dấu hiệu độc lập).

**F-02 — `allow_brand_override` có tác dụng thật (override có vết ĐƯỢC vẽ)**

- `renderApproved` dựng op cho vùng `brand/certification/price` **chỉ khi** dòng có
  `edited_by_user === true` **và** `provenance === 'user'` **và** `text_vi` khác rỗng.
- Khi đó: `applied[].override = true`; `asset.meta.overrides = [{region_id, kind, edited_at}]`;
  thêm warning tiếng Việt nói rõ vùng nhãn hiệu/chứng nhận ĐÃ bị thay theo yêu cầu người dùng;
  `content_meta.imagelab.render.overrides = <số override>`; `render_summary.overrides` trả về UI.
- Chỉ có `allow_brand_override: true` lúc `PUT .../lines` mà dòng **không có vết** ⇒ **không** vào op.

**F-03 — nhãn MOCK theo job, không theo cấu hình**

- `GET /api/imagelab/jobs/:id` trả thêm `mock_steps: string[]` (đọc từ
  `content_meta.imagelab.mock_steps` + `image_assets.meta`) và
  `providers_snapshot: { ocr, translate, render, recorded_at }` (ảnh chụp provider **lúc chạy**,
  đã lưu trong job; `null` nếu job chưa chạy tới bước đó). `providers` vẫn là cấu hình HIỆN TẠI.
- UI **luôn** hiện nhãn MOCK khi `mock_steps` khác rỗng, kể cả khi cấu hình hiện tại là provider thật.

**F-04 — quyền sở hữu theo session cho route MVP-01 cũ**

- `GET /api/jobs/:id`, `PUT /api/jobs/:id/content`, `POST /api/jobs/:id/regenerate`,
  `GET /api/jobs/:id/usage`: job có `session_id` khác session người gọi → **404** (như `/api/imagelab/*`).
  Request KHÔNG khai cookie session ⇒ coi là khách ẩn danh; riêng job `kind = 'image_translation'`
  luôn đòi session khớp. `scope=all` của danh sách job giữ nguyên.
- ⚠️ `session_id` **không phải xác thực** — xem `README.md` §3.5 và `docs/VERIFICATION.md` §8.2.

**F-05 — cờ `expose` cho `HttpError`**

- `new HttpError(status, code, message, details, { expose })` và `HttpError.safe(...)`.
  `expose = true` ⇒ `sendError` trả ĐÚNG `message` (kể cả 5xx) và cả `details`; **không bao giờ** lộ stack.
  Chỉ đánh dấu cho: `NOT_CONFIGURED`, `IMAGELAB_UNAVAILABLE`, `REVIEW_REQUIRED`, `IMAGELAB_NO_LINES`.

**F-06 — tách `SKIPPED_BY_USER` khỏi `NEEDS_REVIEW`**

- `applyReviewEdits` với `action: 'skip'` → `status = 'SKIPPED_BY_USER'`, `edited_by_user = true`,
  `edited_at`, `provenance = 'user'`, `text_vi` giữ rỗng (không tính là vi phạm guardrail).
- `pendingReviewLines()` chỉ lọc `status === 'NEEDS_REVIEW'` — **bất kể** `edited_by_user`;
  còn `NEEDS_REVIEW` mà `force !== true` ⇒ 409 kèm danh sách dòng.
- `force = true`: dòng `NEEDS_REVIEW` vào `skipped` + warning nổi bật "bị guardrail chặn nên KHÔNG được vẽ".
  `SKIPPED_BY_USER` không chặn render và vào `skipped` với lý do "người dùng đã bỏ qua".

**F-08 — siết guardrail dịch (C2)**

- Mọi luật chạy trên văn bản đã **bỏ ký tự vô hình** (U+200B–U+200D, U+FEFF, U+2060) + NFC.
- Số: `\p{Nd}` (mọi bộ chữ số Unicode, kể cả full-width `１２`); thêm luật **số viết bằng chữ
  tiếng Việt + đơn vị/thời gian** (`một…mười, mười hai, hai mươi, trăm, nghìn, triệu, tỷ` đi kèm
  `tháng, năm, ngày, giờ, phút, lần, %, kg, g, ml, l, cm, mm, m, W, V, mAh, chiếc, cái, bộ, hộp, gói`).
- Chữ chưa dịch: kana (`\p{Script=Hiragana}`, `\p{Script=Katakana}`) và Hangul (`\p{Script=Hangul}`)
  vào **cùng nhóm** "CHƯA DỊCH" với CJK.

---

## 7. SỬA ĐỔI SAU VÒNG SĂN LỖ HỔNG (vòng 3 — vẫn chỉ BỔ SUNG, không đổi tên đã đóng băng)

Nguồn: 7 test bị `skip` có chủ đích trong `test/imagelab-f08-guardrails.test.js` và
`test/imagelab-patch-holes.test.js` (agent test độc lập tìm ra sau bản vá F-01…F-08).
Cả 7 đã được vá và **gỡ `skip`**; nội dung khẳng định của agent test giữ nguyên.

**H-1 — kẹp hộp = GIAO với khung ảnh (module dùng chung)**

- Thêm `src/imagelab/geometry.js`: `intersectBoxWithImage(box, width, height)` và
  `boxesIntersect(a, b)` — **một chỗ duy nhất** cho hình học hộp pixel.
- `ocr/normalize.js`, `pipeline.js#clampBox`, `render/image.js#clampBox` đều dùng hàm này.
  Kẹp hộp phải **cắt bớt `w`/`h`** theo phần giao; giao rỗng ⇒ trả `null` (vùng bị bỏ kèm
  lý do). Bản cũ ở `normalize.js`/`pipeline.js` dời gốc mà giữ `w`/`h` ⇒ hộp bị NỚI RỘNG,
  làm vùng mô tả hợp lệ bị `BOX_OVERLAPS_PROTECTED` chặn oan và `box_normalized` sai.
- Ví dụ chuẩn: hộp `{ x: -30, w: 240 }` trên ảnh rộng 320 → `{ x: 0, w: 210 }`.

**H-2 — render 0 op KHÔNG được báo `OK`**

- `RENDER_CODES.NO_OPS` (mới). `RenderProvider.render()` (C3): khi `applied.length === 0`
  và trạng thái provider con là `OK`/`PARTIAL` ⇒ hạ xuống **`PARTIAL`**, gắn
  `error_code = 'NO_OPS'` và thêm cảnh báo tiếng Việt ("không vẽ được vùng nào…").
  Ảnh trả về vẫn là bản sao y hệt ảnh gốc (`output.sha256` không đổi) — không tạo ảnh giả.
- Pipeline (C4): khi `applied.length === 0` phải thêm cảnh báo nổi bật và ghi
  `asset.meta.error_code`; `render_summary.error_code` được trả thêm cho UI.
  Giữ nguyên luật cũ: **không có op nào đủ điều kiện ⇒ job `FAILED IMAGELAB_NO_LINES`,
  không lưu ảnh rỗng**.

**F-08a — đơn vị tiền tệ trong luật "số viết bằng chữ"**

- `COUNTED_UNITS` (C2) bổ sung: `đồng`, `vnđ`, `vnd`, `đ`, `nghìn`, `nghàn`, `ngàn`,
  `triệu`, `tỷ`, `tỉ` ⇒ "…một trăm hai mươi nghìn đồng" bị bắt là số liệu bịa.

**F-08b — ký hiệu số ngoài `\p{Nd}`**

- `checkSpecialNumerals()` (C2): ký tự `\p{No}` (①, ½, ², ৴…) và `\p{Nl}` (số La Mã Ⅻ)
  có trong `text_vi` mà chữ gốc không có ⇒ vi phạm "số liệu không có trong chữ gốc".
  Ký hiệu nào NFKC đã quy về chữ số ASCII thì luật chữ số lo (không báo trùng).

**F-08c — chuẩn hoá NFKC**

- `normalizeForMatch()` (C2) đổi `NFC` → **`NFKC`**: gộp cả biến thể tương thích
  (chữ FULL-WIDTH Latin "ｂảo hành" → "bảo hành", "①" → "1", "㎖" → "ml").
  Văn bản trong `line` vẫn KHÔNG bị sửa — chỉ dùng để so khớp.

---

## 8. SỬA ĐỔI SAU PHẢN BIỆN VÒNG 2 (vòng 4 — bổ sung, không đổi tên đã đóng băng)

Nguồn: `docs/MVP-02-REVIEW.md` mục “VÒNG 2 — chấm lại” (PASS CÓ ĐIỀU KIỆN) với 3 điều kiện
bắt buộc (N-5/N-1/N-2) và 4 phát hiện phụ (N-3/N-4/N-6/N-7). Tất cả đã được xử lý.

**N-5 — không tin provider render (nhất là `RENDER_PROVIDER=http`)**

- Thêm `src/imagelab/render/verify.js`: `verifyProtectedPixels({ originalBuffer, outputBuffer,
  protectedBoxes, maxPixels })` — đo PIXEL trong hộp bảo vệ giữa ảnh gốc và ảnh trả về.
- `RenderProvider.render()` (C3) hậu kiểm sau khi provider con trả kết quả:
  - `sha256(output) === sha256(ảnh gốc)` mà vẫn khai `applied` ⇒ **bỏ lời khai**, hạ `PARTIAL`,
    `error_code = NO_OPS` + cảnh báo (bắt ca remote “liar” với MỌI định dạng ảnh).
  - `applied` khai nhiều hơn số op đã gửi ⇒ giữ đúng số op, `PARTIAL`,
    `error_code = RENDER_APPLIED_MISMATCH` + cảnh báo.
  - PNG giải mã được mà **pixel hộp bảo vệ bị đổi** (hoặc ảnh khác kích thước) ⇒ **TỪ CHỐI LƯU**:
    `status = FAILED`, `error_code = PROTECTED_PIXELS_CHANGED`, `output = null`, `applied = []`,
    job `failed` + `content_meta.imagelab.render.warnings` giữ nguyên lời giải thích.
  - PNG hỏng/không giải mã được ⇒ `FAILED` + `PNG_CORRUPT`, không lưu ảnh hỏng.
  - Không phải PNG (JPEG/WebP…) ⇒ **vẫn lưu** nhưng `protected_pixels_verified = false`,
    `status = PARTIAL`, `error_code = PROTECTED_PIXELS_UNVERIFIED` + cảnh báo nổi bật
    “KHÔNG kiểm chứng được pixel vùng bảo vệ trên định dạng này”.
- `RenderResult` thêm field `protected_pixels_verified: true|false|null`; `asset.meta` và
  `render_summary` trả lại field này cho UI.
- Hộp bảo vệ của CHÍNH vùng đang được vẽ (override có vết — F-02) không nằm trong diện hậu kiểm.

**N-1 — toạ độ NULL/rác là fail-closed**

- `src/imagelab/geometry.js` thêm `strictCoordinate(value)`: chỉ nhận số hữu hạn hoặc CHUỖI có
  nội dung số; `null`/`undefined`/`''`/`false`/`true`/mảng/object/`NaN`/`±Infinity` ⇒ `null`.
  `intersectBoxWithImage` dùng hàm này ⇒ hộp có toạ độ rác trả `null` (KHÔNG còn bị coi là 0).
- `pipeline.#boxOf`: `box` hỏng thì lấy `box_normalized` của CHÍNH vùng đó (nếu còn dùng được);
  cả hai hỏng ⇒ `null` → vùng vào `skipped` với `BAD_BOX_COORDINATE`.
- Nếu một vùng ĐƯỢC BẢO VỆ có hộp không dùng được ⇒ **chặn MỌI op** (không đoán vị trí), lý do
  `BOX_OVERLAPS_PROTECTED: <id> (<kind>, hộp không hợp lệ — fail-closed)`; không còn op ⇒
  job `FAILED IMAGELAB_NO_LINES`, không lưu ảnh.

**N-2 — job phải nói thật khi không vẽ được vùng nào**

- Hằng số mới `RENDER_NO_OPS` (export từ `pipeline.js`). Khi `applied.length === 0` mà ảnh mới
  vẫn được lưu: `job.status` giữ `succeeded` nhưng `job.error_code = 'RENDER_NO_OPS'` +
  `error_message` giải thích; `render_summary` vẫn `PARTIAL`/`NO_OPS`. Không có ảnh ⇒ `failed`.

**N-3 — lịch sử job phân biệt được job dịch ảnh và job MOCK**

- `Store.listJobs` `SELECT` thêm `kind` + `content_meta`; `GET /api/jobs` trả mỗi dòng thêm
  `kind`, `mock: boolean`, `mock_steps: string[]` (đọc từ dấu vết ĐÃ LƯU của chính job) và
  **không** trả `session_id`/`content_meta` thô. UI lịch sử hiện badge “Dịch ảnh” + “MOCK”.

**N-4 — `only_region_ids` fail-closed**

- `POST /api/imagelab/jobs/:id/render`: nếu client CÓ gửi `only_region_ids` mà **không id nào
  khớp** vùng của job ⇒ `409 UNKNOWN_REGION_IDS` kèm `details.unknown_region_ids`
  (trước đây lọc sạch thành `[]` ⇒ âm thầm render TẤT CẢ). Khớp một phần ⇒ chỉ render phần khớp
  và ghi cảnh báo vào `warnings`/`render_summary`.

**N-6/N-7 — guardrail (C2)**

- N-7a: lookahead của `VI_NUM_UNIT_SOURCE` đổi sang `(?![\p{L}\p{N}])` + cờ `u`; thêm nhánh
  `SYMBOL_UNITS` (`%`) và `unitAppearsInText()` ⇒ `纯棉100%T恤` → “Áo thun cotton 100%” KHÔNG bị
  tố oan nữa (trước đây `%` bị chặn vì đứng trước chữ `T`).
- N-7b: bỏ **danh từ đếm** (`chiếc, cái, bộ, hộp, gói`) khỏi `COUNTED_UNITS` — “Một chiếc áo thun
  cotton” là mạo từ, không phải số liệu; vẫn giữ đơn vị đo lường/thời gian/tiền tệ (F-08a).
- N-6: so khớp thêm bản **KHÔNG DẤU** (`deaccent()`) cho cả từ khoá khẳng định và cụm
  số-bằng-chữ; thêm `№` vào nhóm ký hiệu số. Giới hạn còn lại (`xii` chữ thường, homoglyph,
  “tốt nhứt”) ghi ở `docs/VERIFICATION.md` §10.3.

---

## 9. SỬA ĐỔI SAU PHẢN BIỆN VÒNG 3 (vòng 5 — bổ sung, không đổi tên đã đóng băng)

Nguồn: `docs/MVP-02-REVIEW.md` mục “VÒNG 3 — chấm lại” (**PASS CÓ ĐIỀU KIỆN**, không còn
CRITICAL/MAJOR) với **một điều kiện còn lại** (N-1 ở tầng store) và 4 phát hiện MINOR (N-8…N-11).

**N-1 (store) — toạ độ rác KHÔNG được hoá thành số khi đọc DB**

- `src/store/index.js#toNum` dùng cùng luật với `geometry.strictCoordinate`: `null`/`undefined`/
  `''`/chuỗi chỉ có khoảng trắng/`NaN`/`±Infinity`/boolean/mảng/object/chuỗi không phải số thập
  phân ⇒ `null`; **không** nhận hex (`'0x10'` KHÔNG được thành `16`) và **không** biến
  `'  '` thành `0`. Lý do: `Number('  ') === 0` từng biến hộp vùng nhãn hiệu thành hộp "ảo" ở gốc
  toạ độ ⇒ pixel nhãn hiệu bị xoá thật (đo được 2800/4000) trong khi `skipped` vẫn nói "không xoá".

**N-8 — hậu kiểm ảnh provider `http` không chỉ dựa vào hash (một chiều)**

- (a) Ảnh trả về **cùng pixel nhưng khác byte** (ví dụ remote thêm chunk `tEXt`) mà khai `applied`
  ⇒ hậu kiểm **so PIXEL trong hộp của từng op đã gửi**; không hộp nào đổi ⇒ bỏ `applied`,
  `PARTIAL` + `error_code = NO_OPS` + cảnh báo “không tin lời khai `applied`”.
- (b) Remote chỉ đổi pixel **ngoài** mọi hộp op ⇒ cũng `PARTIAL` + `NO_OPS` (không được báo `OK`).
- (c) Ảnh trả về **sai `width`/`height`** ⇒ TỪ CHỐI LƯU: `FAILED` + `RENDER_SIZE_MISMATCH`,
  `output = null` — kiểm cả khi job **không có** vùng bảo vệ nào.
- (d) Dữ liệu trả về không phải ảnh (magic bytes sai) ⇒ từ chối, không lưu asset.

**N-9 — từ vựng đơn vị**

- Bổ sung đơn vị khối lượng/đo lường còn thiếu để bắt ca **đổi đơn vị** (`500克` → “500 tấn”);
  dịch đúng đơn vị (`500克` → “500 gram”) vẫn `TRANSLATED`.

**N-10 — nhánh so khớp bỏ dấu phải hẹp**

- Chỉ dùng `deaccent()` khi **văn bản ứng viên không có dấu tiếng Việt nào** (đúng ca
  “bao hanh mot nam”); văn bản CÓ DẤU thì so khớp như cũ ⇒ hết dương tính giả kiểu
  “Chỉnh hàng”, “Đất chuẩn bị trồng”, “Tột nhất”.

**N-11 — `only_region_ids` rỗng**

- Trường **vắng mặt** ⇒ render tất cả dòng đã duyệt (hành vi cũ).
- Mảng **rỗng** `[]` ⇒ `400 EMPTY_REGION_IDS` (người dùng chưa chọn vùng nào ⇒ không render gì),
  KHÔNG được hiểu thành “không lọc” rồi âm thầm render tất cả.

---

## 10. SỬA ĐỔI SAU PHÁN QUYẾT CUỐI (vòng 6 — bổ sung, không đổi tên đã đóng băng)

Nguồn: `docs/MVP-02-REVIEW.md` mục “VÒNG 4 — chấm cuối” — phán quyết **PASS**, còn 2 lỗ hổng
MINOR (N-12/N-13). Đã vá nốt.

**N-12 — hậu kiểm phải ĐẾN TỪNG VÙNG**

- `inspectRenderedPixels()` nhận thêm `opEntries: [{ region_id, box }]` và trả `opEntries` chi
  tiết: mỗi vùng có `changedRgb` + `drawn`.
- “Đã vẽ” = **có pixel RGB đổi** (`countChangedInBox(..., includeAlpha = false)`); đổi **mỗi kênh
  alpha** KHÔNG tính là đã vẽ (trước đây remote chỉ cần sửa alpha là qua mặt được hậu kiểm).
- `RenderProvider.render()`: vùng nào không đổi RGB thì **bị bỏ khỏi `applied`**, hạ `PARTIAL`,
  `error_code = RENDER_APPLIED_MISMATCH` + cảnh báo nêu id các vùng không được vẽ. Trước đây
  hậu kiểm chỉ hỏi “có ít nhất một hộp đổi không”, nên remote vẽ 1/2 op vẫn được báo `OK`.

**N-13 — không giải mã được ảnh trả về thì không được báo `OK`**

- Khi job **không có vùng bảo vệ** mà ảnh trả về vẫn có op nhưng repo không giải mã được
  (PNG palette/1-bit/interlaced, hoặc định dạng khác PNG) ⇒ mã lỗi mới
  `RENDER_OUTPUT_UNVERIFIED`: giữ `PARTIAL` + cảnh báo “KHÔNG kiểm chứng được pixel…” thay vì
  `OK`. Trường hợp CÓ vùng bảo vệ vẫn giữ nguyên `PROTECTED_PIXELS_UNVERIFIED` như §8.

---

## 11. IL-08 — NHẬP VÙNG CHỮ BẰNG TAY (manual OCR fallback)

**Vì sao phải có:** với `OCR_PROVIDER=mock` (mặc định), vùng chữ trả về là **fixture cố định** —
KHÔNG liên quan tới ảnh người dùng dán vào. Nghĩa là trên ảnh THẬT, tính năng hiện **không dùng
được** cho tới khi cắm OCR thật. Đường nhập tay gỡ đúng điểm chết đó — cùng nguyên tắc với
G11 manual fallback của MVP-01 (“các sàn không được là điểm chết duy nhất” → “OCR không được là
điểm chết duy nhất”). Hợp đồng §3.2 đã chừa sẵn `Region.source: 'user'`; mục này hiện thực nó.

### 11.1 API (đóng băng)

```
PUT /api/imagelab/jobs/:id/regions
body: {
  regions: [{ id?, box: {x,y,w,h}, text, kind?, confidence? }],
  replace?: boolean,                 // mặc định true
  confirm_replace_edited?: boolean   // bắt buộc true nếu job đã có dòng edited_by_user
}
→ 200 { job_id, status, regions: Region[], lines: TranslatedLine[],
        rejected: [{ index, reason }], warnings: string[] }
```

Lỗi (dùng `HttpError.safe` để giữ câu tiếng Việt):
`400 NO_REGIONS` (mảng rỗng/không phải mảng) · `413 TOO_MANY_REGIONS` (quá `imagelab.maxRegions`) ·
`409 IMAGELAB_NO_ORIGINAL` (job chưa có asset gốc) ·
`409 MANUAL_EDITS_WOULD_BE_LOST` (có dòng `edited_by_user` mà chưa xác nhận) ·
`503 IMAGELAB_UNAVAILABLE` (như các route khác).

### 11.2 Luật xử lý (C-A hiện thực)

1. Mỗi vùng: `text` bắt buộc, `sanitizeText(..., maxLength 500)`; rỗng sau khi làm sạch ⇒ **vào
   `rejected`** với `reason`, KHÔNG im lặng bỏ.
2. `box`: 4 số hữu hạn theo `geometry.strictCoordinate`; hộp được **giao với khung ảnh**
   (`intersectBoxWithImage`); giao rỗng ⇒ `rejected` lý do `BOX_OUTSIDE_IMAGE`; hộp bị cắt thì
   ghi lại hộp ĐÃ CẮT (không giữ hộp tràn ra ngoài).
3. `kind` **(sửa ở vòng 6 — IL08-02)**: **luôn** chạy `classifyRegion(text)` rồi hợp nhất với
   kind client khai theo luật **CHỈ LEO THANG BẢO VỆ** — đúng bản luật của `ocr/normalize.js`:
   thứ tự `brand | certification | price > unknown > descriptive` (dùng chung `dedupePriority`).
   - Client khai **cao hơn hoặc bằng** mức máy phân loại ⇒ dùng kind client khai.
   - Client khai **thấp hơn** ⇒ **GIỮ mức cao hơn** + ghi `warnings` nói rõ đã nâng lên mức nào
     và vì sao (chống lách luật #3: khai `descriptive` cho chữ giá/nhãn hiệu/chứng nhận).
   - Muốn hạ THẬT: gửi `allow_kind_downgrade: true` **cho từng vùng** ⇒ dùng kind client khai
     và **bắt buộc ghi vết**; không có cờ thì **không bao giờ** hạ.
     **(vòng 7 — IL08-06)** Vết phải **BỀN** và **ĐỌC LẠI ĐƯỢC** ở ba nơi:
     1. `ocr_regions.kind_reason` mang hậu tố `[NGƯỜI DÙNG HẠ MỨC từ <kind máy phân loại>]`
        (bền theo bản ghi vùng, `source='user'` giữ nguyên);
     2. `content_meta.imagelab.manual.kind_downgrades = [{kind_downgraded, region_id,
        declared_by_user, classified_by_machine, applied_kind, at}]` — **giữ qua các lần lưu
        sau**, chỉ lọc bỏ vùng không còn tồn tại; mỗi lần lưu còn nhắc lại bằng một câu cảnh
        báo `⚠️ Vùng … vẫn đang ở mức … do NGƯỜI DÙNG HẠ MỨC …`;
     3. `GET /api/imagelab/jobs/:id` trả `kind_downgrades: [...]` (cấp job) và **mỗi vùng** đã hạ
        mức có `kind_downgraded: true` + `kind_declared_by_user` + `kind_classified_by_machine`.
     Vùng KHÔNG hạ mức thì **không** có các field này (không bịa vết).
   - Không khai `kind` (hoặc khai giá trị không hợp lệ) ⇒ như cũ: dùng `classifyRegion(text)`.
   **Bất biến:** `translatable === (kind === 'descriptive')` — luôn giữ.
4. `confidence`: mặc định `1` (người dùng tự nhập, không phải máy đoán), clamp `0..1`.
5. `source: 'user'` cho mọi vùng nhập tay; `id` do server gán `u1..uN` nếu client không gửi.
6. `replace === true` (mặc định): xoá regions + lines cũ của job rồi ghi lại. Nếu có **bất kỳ**
   dòng `edited_by_user === true` và `confirm_replace_edited !== true` ⇒ `409 MANUAL_EDITS_WOULD_BE_LOST`.
   `replace === false` ⇒ **ghi thêm** vào danh sách hiện có (id tiếp tục `u…`).
7. Sau khi ghi regions: chạy `Translator.translateRegions` (đúng luật §4.2 — vùng không
   `translatable` KHÔNG được gửi cho provider) → ghi lines → `status = awaiting_review`,
   `stage = 'awaiting_review'`, `finished_at = null`.
8. **Usage:** KHÔNG ghi `OCR_DETECT` cho vùng nhập tay (không có OCR nào chạy — ghi vào là bịa);
   `TRANSLATION` ghi như bình thường khi có gọi dịch.
9. **Dấu vết:** `content_meta.imagelab.manual_regions = true`,
   `content_meta.imagelab.regions_source = 'user'`, và `extraction_evidence.extraction_method`
   giữ nguyên/ghi thêm `+manual-regions`. Job vẫn là `MANUAL_INPUT` ở tầng evidence — **không bao
   giờ** `LIVE_VERIFIED`.
10. `rejected` phải liệt kê **mọi** vùng bị bỏ kèm `index` (vị trí trong mảng client gửi) và lý do
    tiếng Việt; UI phải hiện ra.
11. **(vòng 6 — IL08-01; sửa vòng 7 — IL08-07)** Cổng chặn dựa trên **việc THẬT đang chờ/chạy
    trong hàng đợi** (`JobQueue.isPending(jobId)`), không chỉ cột `jobs.status`:
    - Hàng đợi **có** việc cho job ⇒ `409 IMAGELAB_JOB_RUNNING`, **KHÔNG ghi gì**; câu tiếng Việt
      phải nêu **ĐÚNG BƯỚC** đang chạy theo `jobs.stage` (“Job đang chạy bước render ảnh…”,
      “bước nhận dạng chữ (OCR)”, “bước dịch chữ”…) — **không** hardcode “OCR/dịch”.
    - Hàng đợi **KHÔNG** còn việc nào mà `jobs.status` vẫn `queued`/`running` (job **mồ côi**:
      tiến trình chết / máy chủ vừa khởi động lại) ⇒ **CHO LƯU** + cảnh báo nói thật
      `⚠️ Job đang ở trạng thái "running" … nhưng HÀNG ĐỢI không còn việc nào cho job này …`
      (không chặn vĩnh viễn người dùng). Lớp chặn thứ hai nằm ở `runOcr`: trước khi
    ghi vùng OCR, nó **đọc lại job**; nếu đã có `content_meta.imagelab.manual_regions === true`
    hoặc tồn tại vùng `source = 'user'` ⇒ **DỪNG, không ghi đè**, giữ `awaiting_review`, ghi
    `content_meta.imagelab.ocr_superseded` + cảnh báo “KHÔNG ghi đè”. UI **disable** nút lưu khi
    job đang chạy và hiện ghi chú “đang OCR, chờ xong”.
12. **(vòng 6 — IL08-04)** Trần vùng hiệu lực = `min(imagelab.maxRegions, options.max_regions
    của job nếu có)`; trần theo job được lưu ở `content_meta.imagelab.limits.max_regions` lúc
    `ingest` và **không được mất** ở các bước sau. Vượt trần ⇒ `413 TOO_MANY_REGIONS`.

### 11.3 UI (C-B hiện thực)

- Trong màn job dịch ảnh, thêm khối **“Nhập vùng chữ bằng tay”** (mở/đóng được, mặc định mở khi
  OCR đang là mock hoặc khi job chưa có vùng nào):
  - Bảng dòng: `x` · `y` · `w` · `h` · `chữ Trung` · `loại` (select 5 loại) · nút xoá; nút “Thêm vùng”.
  - Nút **“LƯU VÙNG & DỊCH”** → gọi API trên với `replace: true`.
  - Nếu 409 `MANUAL_EDITS_WOULD_BE_LOST` ⇒ hiện cảnh báo rõ + nút “Vẫn thay (mất bản sửa tay)”
    gửi `confirm_replace_edited: true`.
  - Hiện danh sách `rejected` kèm lý do.
  - Ghi rõ bằng chữ: “Vùng nhập tay có nguồn = người dùng; vùng nhãn hiệu / chứng nhận / giá vẫn
    bị KHOÁ như khi OCR đọc ra.”
  - Escape toàn bộ text người dùng nhập (XSS) — dùng `esc()` như các chỗ khác.
- Khi job `queued`/`running`: nút **“LƯU VÙNG & DỊCH”** ở trạng thái `disabled` + ghi chú
  “Job đang chạy OCR/dịch — chờ xong rồi hãy lưu vùng”; gặp `409 IMAGELAB_JOB_RUNNING` thì hiện
  đúng câu của máy chủ (không nuốt lỗi) và giữ nguyên bảng người dùng vừa nhập.

### 11.4 Dấu vết lịch sử sau khi vùng nhập tay THAY vùng OCR (vòng 6 — IL08-03)

`GET /api/imagelab/jobs/:id` trả khối `ocr` kèm:
`superseded_by_manual_regions: true`, `superseded_at`, và `note` nói rõ
“Dấu vết OCR TRƯỚC ĐÓ — đã bị thay bởi vùng nhập tay; các con số/danh sách dưới đây KHÔNG mô tả
vùng chữ đang có của job.” UI vẫn hiện khối “vùng chữ bị bỏ khi OCR” để truy vết nhưng đổi tiêu đề
thành *“Dấu vết OCR TRƯỚC ĐÓ — … (đã bị thay bởi vùng nhập tay)”* và không tô đỏ như cảnh báo
hiện hành.
