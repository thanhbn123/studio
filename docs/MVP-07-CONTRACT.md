# MVP-07 — ĐĂNG BÀI FACEBOOK PAGE (DUYỆT TAY) — HỢP ĐỒNG GIAO DIỆN (ĐÓNG BĂNG)

> Tính năng: từ **một job đã chạy**, tạo **bài đăng nháp** → **người có quyền duyệt tay** →
> mới được gọi provider để đăng lên **Facebook Page**.
>
> **Sprint này KHÔNG có token Facebook.** Mục tiêu là dựng **khung**: hợp đồng + lớp abstraction +
> hàng đợi duyệt + provider `dry-run`. Khi chủ dự án cấp **Page ID + Page Access Token** (sau khi
> Facebook **app review**) thì chỉ việc khai hai biến môi trường là chạy — **không** phải sửa mã.
>
> **Không thêm dependency** (chỉ `pg` + Node built-in).

Nhánh: `thanhbn123/publish-facebook` · Ngày khoá: 09/10/2026 ·
Baseline đo được trên nhánh này TRƯỚC sprint: **1069 test · 1063 pass · 0 fail · 6 skipped · 0 todo**
Sau sprint (đo lại): **1199 test · 1193 pass · 0 fail · 6 skipped · 0 todo** (+130 test, 0 test cũ vỡ)
(`env -u DATABASE_URL npm test` — ⚠️ `DATABASE_URL` trong shell đang trỏ PostgreSQL **đã tắt**,
chạy `npm test` trần sẽ fail 5–6 ca vì `ECONNREFUSED`, không phải lỗi mã).

---

## 0. BỐN LUẬT RIÊNG CỦA MVP-07 (không được vi phạm, kể cả khi "tiện hơn")

1. **KHÔNG BAO GIỜ TỰ ĐĂNG.** Provider chỉ được gọi khi bản ghi `publish_items` ở trạng thái
   `approved` (do **owner/admin** bấm duyệt). Cổng này nằm ở **tầng DB** — một câu `UPDATE` có điều kiện
   (xem §2.4 `claimPublishItem`): không claim được thì **không có đường nào** gọi tới provider.
   Trạng thái `draft` / `pending_review` / `rejected` / `published` / `publishing` ⇒ **0 lời gọi mạng**.
2. **KHÔNG GỌI MẠNG KHI CHƯA CẤU HÌNH.** Provider `dry-run` (MẶC ĐỊNH) và `none` **không có một dòng
   `fetch` nào**. Provider `facebook` thiếu `pageId`/`accessToken` ⇒ trả `NOT_CONFIGURED` **trước** khi
   dựng URL — không bịa `post_id`, không bịa thành công.
3. **KHÔNG BỊA KẾT QUẢ.** `dry-run` tự khai `is_mock: true` và `post_id` **luôn có tiền tố `dry-`**;
   `url` là `null` (không có bài thật thì không có link thật). Lỗi từ Facebook được ghi **NGUYÊN VĂN**
   vào `publish_logs.error_message` (sau khi che token) — không nuốt, không dịch lại thành "lỗi không rõ".
4. **MỘT BÀI CHỈ ĐĂNG MỘT LẦN.** Idempotency khoá theo `publish_items.id`: `external_post_id` đã có ⇒
   lời gọi `publish` thứ hai **không** gọi provider, trả lại đúng kết quả cũ kèm `idempotent: true`.

---

## 1. BẢN ĐỒ SỞ HỮU FILE

| Agent | Được ghi | Chỉ đọc |
|---|---|---|
| **P1 — provider + dịch vụ duyệt/đăng** | `src/publish/**` | `src/store/**`, `src/security/**`, `src/config.js` |
| **P2 — store + schema** | `src/store/schema.sql`, `src/store/index.js` (**chỉ thêm**) | tất cả |
| **P3 — API** | `src/http/routes.js` (**chỉ THÊM route mới**, không sửa route cũ), `src/app.js` (chỉ khối wiring MVP-07), `src/config.js` (chỉ khối `publish`) | tất cả |
| **P4 — UI** | `public/app.js`, `public/index.html`, `public/styles.css` | tất cả |
| Test | `test/publish-*.test.js` | tất cả |
| Tài liệu | `docs/MVP-07-CONTRACT.md`, `docs/VERIFICATION.md` | tất cả |

Cấm: sửa `test/**` của sprint khác · sửa `docs/*-REVIEW.md` · commit `.env` · thêm dependency ·
sửa `src/imagelab/**`, `src/imagestudio/**`, `src/videostudio/**`, `src/billing/**`, `src/accounts/**`,
`src/exports/**`, `src/jobs/**`.
Bắt buộc: `node --check` mọi file + `env -u DATABASE_URL npm test` **0 fail**.

---

## 2. P1 — `src/publish/**` (chữ ký ĐÓNG BĂNG)

```
src/publish/errors.js              PublishError + PUBLISH_CODES
src/publish/items.js              trạng thái + luật chuyển trạng thái + chuẩn hoá bài đăng
src/publish/provider.js           createPublishProvider() — chọn provider theo cấu hình
src/publish/providers/dry-run.js  provider MẶC ĐỊNH (không mạng)
src/publish/providers/facebook.js Graph API /{page-id}/feed và /{page-id}/photos
src/publish/providers/none.js     tắt hẳn (luôn NOT_CONFIGURED)
src/publish/service.js            PublishService — cổng duyệt + idempotency + ghi log
src/publish/index.js              mặt tiền (P3/P4 chỉ import từ đây)
```

### 2.1 `PublishProvider` — lớp abstraction

Mọi provider là một object **đúng hình dạng sau** (không class bắt buộc, chỉ hình dạng):

```js
{
  name: 'dry-run' | 'facebook' | 'none',   // tên provider, không bao giờ rỗng
  channel: 'facebook_page',                // kênh đăng (sprint này chỉ một kênh)
  model: '',                               // giữ cho đồng dạng với provider khác của repo
  configured: boolean,                     // ĐỦ cấu hình để gọi thật hay không
  isMock: boolean,                         // true ⇒ KHÔNG BAO GIỜ đăng thật

  async probe() → ProbeResult,
  async publish({ text, media, scheduledAt }) → PublishResult,
}
```

`ProbeResult` (ĐÓNG BĂNG):

```js
{
  ok: boolean,              // provider sẵn sàng nhận bài
  name: string,             // = provider.name
  channel: string,
  configured: boolean,
  is_mock: boolean,
  page_id: string,          // '' khi chưa cấu hình — KHÔNG BAO GIỜ chứa token
  error_code: string|null,  // null khi ok
  message: string,          // câu tiếng Việt an toàn (đã che token)
}
```

`publish()` **đầu vào**:

| Field | Kiểu | Luật |
|---|---|---|
| `text` | string | Bắt buộc khi không có media. Đã chuẩn hoá (§2.2); vượt `maxTextLength` ⇒ `TEXT_TOO_LONG` |
| `media` | `MediaRef[]` | `[]` = bài chỉ có chữ. Mỗi phần tử `{ id, mime, bytes, url }`; `url` = **địa chỉ công khai** của ảnh/video (rỗng ⇒ xem §2.5) |
| `scheduledAt` | string\|null | ISO-8601 trong **tương lai**; `null` = đăng ngay. Quá khứ ⇒ `BAD_SCHEDULE` |

`publish()` **đầu ra** `PublishResult` (ĐÓNG BĂNG — đúng các field này, không thêm bớt):

```js
{
  status: 'PUBLISHED' | 'SCHEDULED' | 'NOT_CONFIGURED' | 'FAILED',
  post_id: string|null,        // id bài trên nền tảng; dry-run ⇒ 'dry-<hex>'
  url: string|null,            // link bài THẬT; dry-run/null ⇒ null (không bịa link)
  error_code: string|null,     // null khi status PUBLISHED/SCHEDULED
  error_message: string,       // '' khi thành công; lỗi Facebook giữ NGUYÊN VĂN (đã che token)
  is_mock: boolean,            // = provider.isMock
  provider: string,            // = provider.name
  scheduled_at: string|null,   // ISO khi status = 'SCHEDULED'
  raw: object|null,            // phản hồi thật đã LỌC (không chứa token) — để đối soát
}
```

**`publish()` KHÔNG BAO GIỜ ném lỗi ra ngoài** (fail-closed như `OcrProvider`): mọi sự cố trở thành
`status: 'FAILED'` + `error_code`.

### 2.2 `src/publish/items.js`

```js
export const PUBLISH_STATUSES = Object.freeze([
  'draft', 'pending_review', 'approved', 'publishing', 'published', 'failed', 'rejected',
]);
export const PUBLISH_CHANNELS = Object.freeze(['facebook_page']);
export const PUBLISH_TERMINAL = Object.freeze(['published', 'rejected']);

/** Trạng thái nào được phép gọi provider. ĐÚNG hai trạng thái — không nới. */
export const PUBLISHABLE_STATUSES = Object.freeze(['approved', 'failed']);

export function canTransition(from, to) → boolean
export function normalizePublishText(raw, { maxLength }) → { text, warnings }
export function normalizeMediaIds(raw, { maxMedia }) → string[]
export function draftTextFromJob(job) → string        // gợi ý nội dung từ job MVP-01 (có thể rỗng)
```

Bảng chuyển trạng thái (ngoài bảng này ⇒ `BAD_STATE`):

| Từ | Tới | Ai làm |
|---|---|---|
| — | `draft`, `pending_review` | chủ bài (người đã đăng nhập) |
| `draft` | `pending_review`, `rejected` | chủ bài (gửi duyệt) · owner/admin (từ chối) |
| `pending_review` | `approved`, `rejected` | **chỉ owner/admin** |
| `approved` | `publishing` | **chỉ** qua `claimPublishItem` (§2.4) |
| `publishing` | `published`, `failed` | kết quả thật của provider |
| `failed` | `publishing` | đăng lại (vẫn còn `approved_by` cũ) |
| `published`, `rejected` | — | **terminal** |

`failed` → `publishing` được phép **chỉ khi** `external_post_id IS NULL` (luật §0.4).

### 2.3 `createPublishProvider(config, { logger })`

```js
export function createPublishProvider(config, { logger } = {}) → PublishProvider
```

- `config.publish.provider === 'dry-run'` (MẶC ĐỊNH) ⇒ `DryRunProvider` — `configured: true`, `isMock: true`.
- `'facebook'` ⇒ `FacebookPageProvider` — `configured` = có **cả** `pageId` **và** `accessToken`.
- `'none'` ⇒ `NoneProvider` — `configured: false`, mọi `publish()` ⇒ `NOT_CONFIGURED`.
- Tên lạ ⇒ **fail-closed về `none`** + `logger.warn('publish.provider_unknown')` (KHÔNG rơi về `dry-run`:
  một cấu hình sai không được âm thầm biến thành "đã đăng").

### 2.4 `PublishService` — cổng duyệt + idempotency

```js
export class PublishService {
  constructor({ store, provider, config, logger })

  async createItem({ job, userId, text, mediaIds, channel, submit }) → PublishItem
  async submit(itemId, { userId }) → PublishItem            // draft → pending_review
  async approve(itemId, { by }) → PublishItem               // pending_review → approved
  async reject(itemId, { by, reason }) → PublishItem        // draft|pending_review → rejected
  async publishItem(itemId, { actorId }) → {
    item, result, called, idempotent,                       // `called` = ĐÃ gọi provider hay chưa
  }
  async probe() → ProbeResult
  providerInfo() → { name, channel, configured, is_mock }
}
```

`publishItem()` chạy **đúng thứ tự này**, không đảo:

1. `store.claimPublishItem(id, { runKey })` — câu `UPDATE … WHERE id = ? AND status IN
   ('approved','failed') AND external_post_id IS NULL` (nguyên tử trên cả SQLite và PostgreSQL).
2. **Claim thất bại** ⇒ đọc lại bản ghi và ném `PublishError` đúng lý do (`NOT_APPROVED`,
   `ALREADY_PUBLISHED` *(trả kết quả cũ, không ném)*, `PUBLISH_IN_PROGRESS`, `ITEM_REJECTED`) —
   **chưa một dòng mạng nào chạy**.
3. Claim thành công (`status = 'publishing'`, `attempts += 1`) ⇒ **giờ mới** gọi `provider.publish()`.
4. Ghi `publish_logs` **mọi lần gọi** (thành công hay thất bại), rồi cập nhật `publish_items`:
   `PUBLISHED`/`SCHEDULED` ⇒ `status = 'published'` + `external_post_id` + `published_at`;
   còn lại ⇒ `status = 'failed'` + `error_code` + `last_error`.

### 2.5 `FacebookPageProvider` — chi tiết Graph API

| Ca | Gọi gì |
|---|---|
| Chỉ chữ | `POST {baseUrl}/{apiVersion}/{pageId}/feed` · `message`, `access_token` |
| Có 1 ảnh (có `url` công khai) | `POST {baseUrl}/{apiVersion}/{pageId}/photos` · `url`, `caption`, `access_token` |
| Hẹn giờ | thêm `published=false` + `scheduled_publish_time=<unix giây>` |

- Thân request là `application/x-www-form-urlencoded` (**không** multipart ⇒ không cần dependency).
- `probe()` là `GET /{page-id}?fields=id,name` với token trong header `Authorization: Bearer`.
- Đi qua `safeFetch` với `domains` = **đúng host của `baseUrl`** (mặc định `graph.facebook.com`) và
  `allowPrivateNetwork` = `config.publish.facebook.allowPrivateNetwork` (mặc định **false**) ⇒ không SSRF.
- `access_token` **không bao giờ** nằm trong URL (query string đi vào access log của mọi proxy):
  đăng bài ⇒ trong **thân** request, `probe()` ⇒ trong **header** `Authorization`.
  `maskToken()` là lưới cuối, che token khỏi **mọi** log/`error_message`/`raw`.
- **CHƯA LÀM trong sprint này (nói thẳng, không giả vờ):** tải ảnh **từ đĩa** lên Facebook (multipart
  `source`). Media không có `url` công khai ⇒ `status: 'FAILED'`, `error_code: 'MEDIA_NOT_PUBLIC'`.
  Nhiều ảnh trong một bài (`attached_media`) cũng chưa làm ⇒ `MEDIA_TOO_MANY` (sprint này 1 ảnh/bài).

### 2.6 Mã lỗi (`PUBLISH_CODES`) — ĐÓNG BĂNG

| Code | Nghĩa | HTTP |
|---|---|---|
| `BAD_INPUT` | Thiếu/sai tham số (không có `job_id`, `text` rỗng mà không media…) | 400 |
| `BAD_STATE` | Chuyển trạng thái không có trong bảng §2.2 | 409 |
| `BAD_SCHEDULE` | `scheduledAt` không phải ISO tương lai | 400 |
| `TEXT_TOO_LONG` | Vượt `publish.maxTextLength` | 400 |
| `MEDIA_TOO_MANY` | Vượt `publish.maxMedia` (hoặc >1 với provider `facebook`) | 400 |
| `MEDIA_NOT_PUBLIC` | Ảnh chỉ có trên đĩa, chưa có URL công khai (§2.5) | 422 |
| `ITEM_NOT_FOUND` | Không có bài đó (hoặc không phải của mình) | 404 |
| `NOT_APPROVED` | **Chưa duyệt** ⇒ cấm đăng (luật §0.1) | 409 |
| `ITEM_REJECTED` | Bài đã bị từ chối | 409 |
| `PUBLISH_IN_PROGRESS` | Đang có lượt đăng khác giữ bài | 409 |
| `ALREADY_PUBLISHED` | Đã đăng rồi (trả kết quả cũ, `idempotent: true`) | 200 |
| `NOT_CONFIGURED` | Provider thiếu Page ID / token ⇒ **chưa đăng được** | 409 |
| `PROVIDER_DISABLED` | `provider = none` hoặc `PUBLISH_ENABLED=false` | 503 |
| `PROVIDER_FAILED` | Facebook trả lỗi / mạng lỗi (kèm nguyên văn trong log) | 502 |
| `ATTEMPTS_EXHAUSTED` | Vượt `publish.maxAttempts` | 429 |
| `STORE_WRITE_FAILED` | Lỗi DB thật | 500 |

---

## 3. P2 — bảng mới (`src/store/schema.sql` + migration)

### 3.1 `publish_items`

```sql
CREATE TABLE IF NOT EXISTS publish_items (
  id               TEXT PRIMARY KEY,
  job_id           TEXT,
  user_id          TEXT,                 -- chủ bài; NULL chỉ có ở DB cũ (route bắt buộc đăng nhập)
  channel          TEXT NOT NULL DEFAULT 'facebook_page',
  provider         TEXT,                 -- provider ĐÃ dùng ở lượt đăng gần nhất
  text             TEXT,
  media_ids        TEXT,                 -- JSON mảng id của image_assets
  status           TEXT NOT NULL DEFAULT 'draft',
  scheduled_at     TEXT,
  approved_by      TEXT,
  approved_at      TEXT,
  rejected_by      TEXT,
  rejected_at      TEXT,
  reject_reason    TEXT,
  published_at     TEXT,
  external_post_id TEXT,
  external_url     TEXT,
  is_mock          INTEGER NOT NULL DEFAULT 0,
  error_code       TEXT,
  last_error       TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  run_key          TEXT,                 -- '<itemId>#<n>' — danh tính MỘT lượt đăng
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
```

### 3.2 `publish_logs` — vết **mọi** lời gọi provider (luật §0.3)

```sql
CREATE TABLE IF NOT EXISTS publish_logs (
  id               TEXT PRIMARY KEY,
  item_id          TEXT NOT NULL,
  attempt          INTEGER NOT NULL DEFAULT 0,
  run_key          TEXT,
  provider         TEXT,
  channel          TEXT,
  status           TEXT,                 -- PublishResult.status
  external_post_id TEXT,
  error_code       TEXT,
  error_message    TEXT,                 -- NGUYÊN VĂN lỗi nền tảng (đã che token)
  is_mock          INTEGER NOT NULL DEFAULT 0,
  request_summary  TEXT,                 -- JSON: {endpoint, text_length, media_count} — KHÔNG token, KHÔNG nội dung
  created_at       TEXT NOT NULL
);
```

⚠️ **INDEX KHÔNG ĐẶT TRONG `schema.sql`** — bài học `wallet_ledger.seq`/`job_queue.epoch`: index trong
file schema chạy **TRƯỚC** migration, nên trên DB cũ (bảng đã tồn tại nhưng thiếu cột)
`CREATE INDEX` làm **chết `init()`**. Bốn index dưới đây do `#applyAdditiveMigrations()` tạo **SAU**
khi mọi cột đã tồn tại:

```
idx_publish_items_user     (user_id, created_at)
idx_publish_items_status   (status, created_at)
idx_publish_items_job      (job_id)
idx_publish_logs_item      (item_id, created_at)
```

Và cột `run_key`/`provider`/`external_url`/`is_mock` được `#addColumnIfMissing()` thêm **tại chỗ** cho
DB tạo bởi bản trung gian (idempotent trên cả hai driver).

### 3.3 Hàm store mới (chỉ THÊM vào `src/store/index.js`)

```js
async createPublishItem({ id, jobId, userId, channel, text, mediaIds, status, scheduledAt }) → PublishItem
async getPublishItem(id) → PublishItem|null
async listPublishItems({ userId, status, jobId, limit, offset, all }) → PublishItem[]
async countPublishItems({ userId, status, all }) → number
async setPublishItemStatus(id, { from, to, patch }) → PublishItem|null   // UPDATE có điều kiện
async claimPublishItem(id, { runKey, now }) → PublishItem|null           // CỔNG DUYỆT ở tầng DB
async finishPublishItem(id, { status, externalPostId, externalUrl, publishedAt, errorCode, lastError, isMock, provider }) → PublishItem|null
async appendPublishLog({ itemId, attempt, runKey, provider, channel, status, externalPostId, errorCode, errorMessage, isMock, requestSummary }) → void
async listPublishLogs(itemId, { limit }) → PublishLog[]
```

`PublishItem` trả ra đã **hydrate**: `media_ids` là **mảng**, `is_mock` là **boolean**.
`setPublishItemStatus`/`claimPublishItem` trả `null` khi `UPDATE` đụng **0 dòng** (bị người khác giành) —
tầng trên **phải** đọc lại bản ghi để biết lý do, không được coi `null` là lỗi DB.

---

## 4. P3 — API (chỉ **THÊM**, không đổi route cũ)

```
POST   /api/publish/items                  → 201 { item }
GET    /api/publish/items?status=&job_id=  → 200 { items, total, provider, statuses }
GET    /api/publish/items/:id              → 200 { item, logs }
POST   /api/publish/items/:id/submit       → 200 { item }
POST   /api/publish/items/:id/approve      → 200 { item }          (CHỈ owner/admin)
POST   /api/publish/items/:id/reject       → 200 { item }          (CHỈ owner/admin)
POST   /api/publish/items/:id/publish      → 200 { item, result, called, idempotent }
GET    /api/publish/provider               → 200 { provider, probe }  (CHỈ owner/admin)
```

Luật:

- **Bắt buộc đăng nhập** cho **mọi** route `/api/publish/*`: ẩn danh ⇒ **401 `UNAUTHENTICATED`**.
  Lý do: đăng bài là hành động ra ngoài, phải có người chịu trách nhiệm và có người duyệt.
- **Khác chủ ⇒ 404 `ITEM_NOT_FOUND`** (không xác nhận sự tồn tại) — y hệt chính sách `requireOwnJob`.
  owner/admin xem/duyệt/từ chối được bài của **mọi** người (đó chính là hàng đợi duyệt);
  `GET /api/publish/items` trả **toàn bộ** bài cho owner/admin, **chỉ bài của mình** cho `member`.
- `POST /api/publish/items` body: `{ job_id, text?, media_ids?, channel?, submit? }`.
  `job_id` phải là job **của chính mình** (qua `requireOwnJob`) — khác chủ ⇒ 404.
  `text` rỗng ⇒ lấy gợi ý từ nội dung job (`draftTextFromJob`); vẫn rỗng và không media ⇒ 400 `BAD_INPUT`.
  `submit: true` ⇒ tạo luôn ở `pending_review`.
- `POST …/approve` và `…/reject`: `requireAdmin` (owner/admin) ⇒ `member` nhận **403 `FORBIDDEN`**.
- `POST …/publish`: **chỉ chạy khi `approved`** (hoặc `failed` chưa có `external_post_id`).
  Chưa duyệt ⇒ **409 `NOT_APPROVED`** và **provider không được gọi**.
  Đã đăng ⇒ **200** kèm `idempotent: true`, `called: false`, trả lại `external_post_id` cũ.
- Rate limit: `rateLimiters.jobs` key `publish:${sid}` cho route **ghi**; `rateLimiters.requests`
  key `publish-read:${sid}` cho route **đọc**.
- Khối `publish` không nạp được / `PUBLISH_ENABLED=false` ⇒ **503 `PUBLISH_UNAVAILABLE`** với lý do
  THẬT (cùng khuôn `imagelabUnavailableReason`) — **không** mô phỏng danh sách rỗng.
- `/api/config` thêm khối (CHỈ cờ, **không** token, **không** Page ID bí mật):

```json
"publish": {
  "available": true, "enabled": true, "channel": "facebook_page",
  "manual_approval_required": true,
  "provider": { "name": "dry-run", "configured": true, "is_mock": true },
  "statuses": ["draft","pending_review","approved","publishing","published","failed","rejected"],
  "limits": { "max_text_length": 63206, "max_media": 1 }
}
```

### 4.1 Cấu hình (`src/config.js`, khối `publish` — tên khoá ĐÓNG BĂNG)

| Env | Mặc định | Nghĩa |
|---|---|---|
| `PUBLISH_ENABLED` | `true` | Tắt hẳn khối đăng bài |
| `PUBLISH_PROVIDER` | **`dry-run`** | `dry-run` \| `facebook` \| `none` |
| `PUBLISH_MAX_TEXT_LENGTH` | `63206` | Trần độ dài bài (trần của Facebook) |
| `PUBLISH_MAX_MEDIA` | `1` | Sprint này 1 ảnh/bài (§2.5) |
| `PUBLISH_MAX_ATTEMPTS` | `3` | Trần số lượt đăng cho một bài |
| `FACEBOOK_PAGE_ID` | `''` | **Chủ dự án cấp** — thiếu ⇒ `NOT_CONFIGURED` |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | `''` | **Chủ dự án cấp** — thiếu ⇒ `NOT_CONFIGURED` |
| `FACEBOOK_API_VERSION` | `v21.0` | Phiên bản Graph API |
| `FACEBOOK_GRAPH_BASE_URL` | `https://graph.facebook.com` | Đổi được để test bằng server giả |
| `FACEBOOK_TIMEOUT_MS` | `30000` | Trần chờ một lời gọi |
| `PUBLISH_ALLOW_PRIVATE_NETWORK` | `false` | Chỉ bật khi trỏ Graph base URL vào server nội bộ (test) |

**Cách cắm token khi có (không sửa một dòng mã nào):**

```sh
PUBLISH_PROVIDER=facebook
FACEBOOK_PAGE_ID=<id của Page>
FACEBOOK_PAGE_ACCESS_TOKEN=<Page Access Token sau app review>
```

---

## 5. P4 — UI (`public/**`): màn **“Đăng bài”**

- Tab thứ năm trên thanh điều hướng: **“Đăng bài”** · route hash `#/dangbai` (và `#/dangbai/:id`).
- **Băng trạng thái provider, luôn hiện ở đầu màn:**
  - provider `dry-run` ⇒ băng **vàng**: **“CHẾ ĐỘ THỬ — không đăng thật”** + câu giải thích
    (`post_id` có tiền tố `dry-`, không có bài nào lên Facebook).
  - provider `facebook` nhưng `configured: false` ⇒ băng **đỏ**:
    **“chưa cấu hình Facebook (cần Page ID + token)”**.
  - provider `none` / `PUBLISH_ENABLED=false` ⇒ băng **đỏ** nói thẳng khối đăng bài đang tắt.
- **Danh sách** nhóm theo trạng thái (bộ lọc: tất cả · nháp · chờ duyệt · đã duyệt · đã đăng · lỗi ·
  bị từ chối), mỗi dòng: trạng thái, kênh, thời gian, **xem trước** nội dung (nguyên văn, cắt gọn) +
  ảnh/video kèm (thẻ `<img>`/`<video>` trỏ route file có sẵn của MVP-02/03/04).
- **Nút:** **DUYỆT** / **TỪ CHỐI** (chỉ hiện với owner/admin) · **GỬI DUYỆT** (chủ bài, bài nháp) ·
  **ĐĂNG NGAY** (chỉ bật khi bài `approved`/`failed`; bài chưa duyệt ⇒ nút **disabled** + câu
  “phải được duyệt trước khi đăng”).
- Bài `published` hiện `external_post_id`; `dry-` ⇒ ghi rõ **“id thử — không có bài thật”**.
  Bài `failed` hiện **nguyên văn** lỗi nền tảng.
- **Form tạo bài** ngay trên màn: chọn job trong lịch sử + ô nội dung (gợi ý từ nội dung job).
- **Mọi** text động đi qua `esc()`. Không `innerHTML` dữ liệu thô.

---

## 6. ĐỊNH NGHĨA “XONG” (nghiệm thu được)

1. Bài **chưa duyệt** ⇒ `POST …/publish` trả **409 `NOT_APPROVED`** và provider **ghi nhận 0 lời gọi**
   (đo bằng provider giả có đếm `calls`).
2. Bài **đã duyệt** ⇒ `POST …/publish` gọi provider **đúng 1 lần**, bài sang `published`,
   có `external_post_id`, có **1 dòng** `publish_logs`.
3. Gọi `POST …/publish` **hai lần** ⇒ provider vẫn **đúng 1 lời gọi**, lần hai trả `idempotent: true`,
   `called: false`, `attempts` không tăng thêm lượt gọi mạng.
4. Provider mặc định `dry-run` ⇒ `post_id` có tiền tố `dry-`, `is_mock: true`, `url: null`,
   **0 lời gọi mạng** (đo bằng cách thay `globalThis.fetch` thành hàm ném lỗi).
5. Provider `facebook` **thiếu token** ⇒ `NOT_CONFIGURED`, **0 lời gọi mạng**, không bịa `post_id`.
6. Provider `facebook` **có token giả + server giả** ⇒ gọi đúng `/{page-id}/feed`, lỗi Facebook được
   giữ **nguyên văn** trong `publish_logs.error_message`, và **token không xuất hiện** trong log/API.
7. `member` gọi `approve` ⇒ **403**; ẩn danh ⇒ **401**; bài của người khác (member) ⇒ **404**.
8. `init()` chạy **hai lần liên tiếp** trên cùng DB không lỗi (migration + index idempotent).
9. `env -u DATABASE_URL npm test` **0 fail** và **có thêm** `test/publish-*.test.js`.
10. `docs/VERIFICATION.md` có mục MVP-07 nói rõ **cái gì chưa**: chưa có token ⇒ **chưa từng đăng thật**;
    chưa qua **app review**; chưa đo API thật; chưa làm multipart upload ảnh từ đĩa.
