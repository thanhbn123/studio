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

---

## 5. ĐỊNH NGHĨA "XONG" CỦA MVP-02

- Ảnh gốc không đổi sau toàn bộ luồng: cùng `sha256` trên đĩa và trong DB.
- Ảnh render là bản ghi MỚI có `parent_id` + `sha256` riêng; không có đường nào ghi đè ảnh gốc.
- Vùng `brand`/`certification` không bị dịch và không bị xoá khỏi ảnh (trừ override có vết).
- Mọi bước đều có `usage_event`; job lỗi có `error_code` + `finished_at`, không treo `running`.
- Provider mock luôn tự khai `is_mock`; UI hiện nhãn MOCK; không có nhãn LIVE nào trong MVP-02.
- `npm test` xanh (183 test cũ + test mới của agent test) và `node tools/verify.mjs` xanh.
