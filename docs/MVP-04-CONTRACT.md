# MVP-04 (phần OFFLINE) — HỢP ĐỒNG GIAO DIỆN (ĐÓNG BĂNG)

> **File này là luật.** Tên hàm/field/mã lỗi dưới đây là **hợp đồng đóng băng** cho sprint
> MVP-04 phần làm được **không cần dịch vụ trả tiền**. Thấy sai thì báo người điều phối.

Ngày khoá: 07/10/2026 · Nhánh: `feat/mvp04-videostudio`

---

## 0. Phạm vi & ba luật riêng

**Mục tiêu:** từ **ảnh sản phẩm thật** + **chữ Việt** dựng **video bán hàng ngắn** chạy được ngay,
không cần dịch vụ trả tiền và không cần `ffmpeg`.

**Máy này KHÔNG có `ffmpeg`** (đã kiểm). Vì vậy:

| Việc | Làm được offline? |
|---|---|
| Ghép ảnh thành video có nhịp (thời lượng từng cảnh) | ✅ **GIF động** (tự viết bộ mã hoá LZW) + **chuỗi khung PNG** |
| Chữ Việt trên video (tiêu đề, giá, CTA, phụ đề) | ✅ dùng engine font của MVP-02 |
| Nhiều tỉ lệ 9:16 · 1:1 · 16:9 | ✅ (pad/crop — **không bóp méo**) |
| Chuyển cảnh (cắt/ mờ dần), hiệu ứng chậm (zoom/pan) | ✅ |
| **Tiếng** (voice-over, nhạc nền) | ❌ **KHÔNG** — GIF không có tiếng; TTS/dịch vụ sinh tiếng là phần trả tiền |
| **MP4/H.264** | ❌ offline — cần `ffmpeg` hoặc dịch vụ; có provider `ffmpeg` nhưng **chưa đo được** ở máy này |

Ba luật riêng:
1. **Không bóp méo ảnh**: ảnh ra đúng tỉ lệ đã chọn; ảnh gốc chỉ được **pad** (thêm viền) hoặc **crop**
   (cắt bớt) — **không** kéo giãn; mọi lựa chọn phải ghi vào `plan.scenes[].fit`.
2. **Không có tiếng thì phải NÓI RÕ**: mọi kết quả MVP-04 mang `audio: null` + cảnh báo
   “video KHÔNG có tiếng”; không bao giờ được quảng cáo là video hoàn chỉnh để đăng ngay.
3. **Chữ trên video theo đúng luật chống bịa của MVP-03**: khẳng định/số liệu thiếu bằng chứng
   (bằng chứng = dữ liệu **đã lưu** của job: `product_name`, vùng chữ OCR/người dùng nhập, ghi chú)
   ⇒ **không vẽ**, trả lỗi `VIDEO_TEXT_UNSUPPORTED_CLAIM`.

---

## 1. BẢN ĐỒ SỞ HỮU FILE

| Agent | Được ghi | Chỉ đọc |
|---|---|---|
| **V1 — Kịch bản/khung hình** | `src/videostudio/plan/**` | `src/imagelab/render/**`, `src/imagestudio/compose/**` |
| **V2 — Mã hoá GIF + chuỗi khung** | `src/videostudio/encode/**` | `src/imagelab/render/**` |
| **V3 — Pipeline + store + wiring** | `src/videostudio/pipeline.js`, `src/store/index.js`, `src/app.js` | tất cả |
| **V4 — API** | `src/http/routes.js` | tất cả |
| **V5 — UI** | `public/**` | tất cả |
| **Test** | `test/**` | tất cả |
| **Phản biện** | `docs/MVP-04-REVIEW.md` | tất cả |
| **Gộp** | mọi file (trừ `docs/MVP-04-REVIEW.md`) | tất cả |

Cấm: sửa `test/**` (trừ agent test), `docs/**`, `src/imagelab/**`, `src/imagestudio/**` (chỉ ĐỌC),
thêm dependency (chỉ `pg` + Node built-in). Bắt buộc: `node --check` + `npm test` xanh
(baseline khi bắt đầu: **849 test · 848 pass · 0 fail · 1 skipped**).

---

## 2. HỢP ĐỒNG MODULE

### 2.1 V1 — `src/videostudio/plan/`

```js
export const VIDEO_PRESETS = Object.freeze([
  { id: 'doc-9x16',  label: 'Dọc 9:16 (TikTok/Reels)', width: 720, height: 1280, fps: 12, max_seconds: 30, synthetic: false },
  { id: 'vuong-1x1', label: 'Vuông 1:1 (Feed)',        width: 900, height: 900,  fps: 12, max_seconds: 30, synthetic: false },
  { id: 'ngang-16x9',label: 'Ngang 16:9 (YouTube)',    width: 1280, height: 720, fps: 12, max_seconds: 30, synthetic: false },
]);
export class VideoError extends Error {}            // .code, .details
export function buildVideoPlan({ scenes, preset, options }) → VideoPlan
export function planFrameCount(plan) → number
export const TRANSITIONS = Object.freeze(['cut', 'fade']);
export const MOTIONS = Object.freeze(['none', 'zoom-in', 'zoom-out', 'pan-left', 'pan-right']);
export const FIT_MODES = Object.freeze(['pad', 'crop']);
```

**`VideoPlan` (đóng băng)**
```js
{
  preset_id, width, height, fps,
  frame_count, duration_ms, loop: 0,
  scenes: [{
    index, start_ms, end_ms, frames, duration_ms,
    asset_id, source: { width, height },
    fit: 'pad'|'crop', fit_box: { x, y, w, h },          // vị trí ảnh trong khung
    pad_color: '#RRGGBB',
    transition_in: 'cut'|'fade', transition_ms,
    motion: 'none'|'zoom-in'|...,
    texts: [{ text, x, y, size, align, color, start_ms, end_ms, animation: 'none'|'fade-in' }],
  }],
  warnings: string[], synthetic: false,                  // ảnh người dùng tải lên
}
```
Luật: `sum(scenes[].duration_ms) == duration_ms`; `frames == round(duration_ms/1000*fps)`;
thời lượng mỗi cảnh bị kẹp `scene.min_ms..preset.max_seconds*1000`; tổng > `max_seconds` ⇒ **cắt** và
ghi `warnings` (không bao giờ vượt trần); `fit_box` phải nằm **trong** khung (dùng
`intersectBoxWithImage` của `src/imagelab/geometry.js`).

### 2.2 V2 — `src/videostudio/encode/`

```js
export function encodeGif({ frames, width, height, delayMs, loop = 0, paletteSize = 256, dither = false })
  → { buffer, mime: 'image/gif', width, height, frames, bytes, palette_size, warnings }
export function inspectGif(buffer) → { valid, version, width, height, frames, loop, bytes, errors: [] }
export function writeFrameSequence({ frames, dir, prefix = 'frame', digits = 4 }) → { files: [paths], bytes }
export class VideoEncoder { get name(); get isMock(); get configured(); async encode({ plan, frames, options }) → EncodeResult }
export function createVideoEncoder(config, { logger }) → VideoEncoder     // mime: 'image/gif' | 'video/mp4'
export function renderFrames(plan, { loadImage, drawText }) → [{ index, rgba, width, height }]   // hoặc async iterable
```

Luật:
- **GIF thật**: `GIF89a`, có `NETSCAPE2.0` (loop), mỗi khung có `Graphic Control Extension` với delay,
  kết thúc `0x3B`. `inspectGif` là **bộ đọc độc lập** (parse khối, không dùng lại hàm ghi) để chứng minh
  số khung/kích thước/loop khớp — dùng nó trong test.
- Bảng màu: lượng tử hoá tối đa `paletteSize` màu (median-cut hoặc octree — chọn cách nào cũng được,
  ghi rõ); pixel gốc **không** được "đổi màu tuỳ tiện" quá mức: ghi `warnings` nếu sai số màu trung bình
  vượt ngưỡng đo được; `dither` mặc định **false**.
- `renderFrames`: vẽ phông (nền), ảnh (pad/crop), chữ (font MVP-02), chuyển cảnh `fade` (pha trộn theo
  `transition_ms`), `motion` (zoom/pan nội suy theo khung). **Không đổi kích thước khung** giữa các
  khung. Ảnh gốc không được sửa (`sha256` trước/sau phải y hệt).
- Provider: `purejs` (GIF, THẬT), `mock` (GIF 2 khung màu, `is_mock = true`), `ffmpeg`
  (ghi chuỗi PNG ra thư mục tạm rồi gọi `ffmpeg` ⇒ `video/mp4`; **không có `ffmpeg` ⇒
  `FFMPEG_NOT_AVAILABLE`**, không bịa), `none` ⇒ `NOT_CONFIGURED`.
- Không ghi ra ngoài `IMAGELAB_DIR`; dùng `src/imagelab/storage.js`.

### 2.3 V3 — Pipeline + store + wiring

```js
export const VIDEOSTUDIO_STAGES = Object.freeze(['queued','storing','planning','rendering','encoding','done','failed']);
export const VIDEOSTUDIO_KIND = 'video_generation';
export class VideoStudioPipeline {
  constructor({ config, logger, store, storage, encoder, billingHook })
  async ingest(jobId, { image, sessionId, options }) → { asset_id, width, height, sha256 }
  async generate(jobId, { sessionId, options, runKey }) → { status, stage, error_code, asset, plan, encode, frames, warnings, duration_ms }
}
```

Luật: mỗi **lượt chạy** có `run_key` riêng (theo MVP-05 §3.4b: gọi `billingHook.beforeJob` **trong
route** trước khi chạy, `afterJob` ở cuối pipeline); usage op mới **`VIDEO_RENDER`** (input = số khung,
output = 1) và **`VIDEO_ENCODE`** (input = số khung, output = số byte) — thêm vào `USAGE_OPERATIONS` +
`pricing` (giá mặc định, ghi rõ là giá mặc định của repo); evidence `connector='videostudio'`,
`extraction_method='upload+video'`, `verification='MANUAL_INPUT'` — **không bao giờ** `LIVE_VERIFIED`;
asset role `rendered`, `parent_id` = asset gốc, `meta.kind='video_generation'`, `meta.preset`,
`meta.audio = null`, `meta.warnings`, `meta.plan_summary`, `meta.encode_summary`; lỗi ⇒ job `failed` +
`error_code` + `finished_at`, không treo `running`; ảnh gốc bất biến (kiểm `sha256` trên đĩa cuối lượt).

### 2.4 V4 — API

```
GET  /api/videostudio/presets → { presets: VIDEO_PRESETS, encoder: {name,is_mock,configured}, limits }
POST /api/videostudio/jobs    { image:{base64,filename?}, options:{preset?, scenes?, texts?, fit?} }
                              → 202 { job_id, asset_id, status, poll }        (402 nếu thiếu credit — MVP-05)
GET  /api/videostudio/jobs/:id → { job, asset, rendered:[], plan, encode, warnings, providers, presets, last_run }
POST /api/videostudio/jobs/:id/generate { options?, force? } → 202
GET  /api/videostudio/assets/:id/file → nhị phân (Content-Type thật, private/no-store, nosniff)
```
Luật: quyền theo session **và** theo tài khoản (MVP-05: khác chủ ⇒ 404); validate ảnh (magic bytes,
`maxImageBytes`, `maxPixels`); rate limit; **402 `INSUFFICIENT_CREDIT`** trước khi tạo job (gọi
`billingHook.beforeJob`); `503 VIDEOSTUDIO_UNAVAILABLE` khi thiếu module; `/api/config` thêm khối
`videostudio: { available, presets:[{id,label}], encoder:{name,is_mock,configured}, audio:false }`.

### 2.5 V5 — UI

Tab **“Video”** (thứ tư): kéo-thả ảnh (nhiều ảnh ⇒ nhiều cảnh, thứ tự = thứ tự chọn) → chọn tỉ lệ
(9:16/1:1/16:9) → nhập chữ cho từng cảnh (tiêu đề/giá/CTA; có ô “phụ đề”) → thời lượng mỗi cảnh →
**TẠO VIDEO** → poll theo `stage` → xem trước bằng `<img src=...gif>` + nút tải + hiện **mọi** cảnh báo
(không có tiếng · chữ bị chặn vì thiếu bằng chứng · ảnh bị crop/pad · vượt trần thời lượng).
Nhãn trung thực: **“video KHÔNG có tiếng”** hiện **cạnh** kết quả, không giấu. Escape mọi text bằng `esc()`.

---

## 3. ĐỊNH NGHĨA "XONG"

- GIF mở được bằng trình xem ảnh; `inspectGif` khớp số khung/kích thước/loop với `plan`.
- Ảnh gốc bất biến; ảnh ra **đúng tỉ lệ preset**; **không** kéo giãn (kiểm bằng pixel: tỉ lệ khung đo được
  == tỉ lệ preset).
- Tổng thời lượng ≤ trần preset; vượt ⇒ bị cắt + có `warnings`.
- Chữ thiếu bằng chứng ⇒ **không vẽ** + lỗi `VIDEO_TEXT_UNSUPPORTED_CLAIM` (422), 0 pixel chữ.
- Mọi kết quả có `audio: null` + cảnh báo “KHÔNG có tiếng”.
- `usage_event` chỉ ghi bước **chạy thật**; evidence `MANUAL_INPUT`.
- Ẩn danh vẫn dùng được (không ví); có tài khoản ⇒ thu theo **lượt** đúng chi phí lượt đó.
- `npm test` xanh + `node tools/verify.mjs` xanh.
