# MVP-05 — HỢP ĐỒNG GIAO DIỆN (ĐÓNG BĂNG)

> **File này là luật.** Tên hàm / tên field / mã lỗi dưới đây là **hợp đồng đóng băng** cho sprint
> MVP-05 (Tài khoản + Ví credit). Thấy sai thì báo người điều phối, KHÔNG tự sửa rồi để agent khác lệch.

Ngày khoá: 04/10/2026 · Người khoá: phiên điều khiển DSH · Nhánh: `feat/mvp05-accounts`

---

## 0. Mục tiêu & hai luật riêng

**Mục tiêu:** nhiều người dùng, mỗi người có ví credit; dữ liệu tách theo tài khoản; `session_id`
(không phải xác thực — đã ghi rõ ở `docs/VERIFICATION.md` §8.2) được thay bằng **tài khoản thật**.

1. **KHÔNG phá người dùng ẩn danh.** Toàn bộ MVP-01/02/03 hiện chạy bằng `session_id` và **phải tiếp
   tục chạy** khi chưa đăng nhập (chế độ ẩn danh: không ví, không credit, hạn mức thấp hơn). Đăng nhập
   là **tuỳ chọn**, không bắt buộc — nếu bắt buộc, mọi test cũ đỏ và sản phẩm mất tính "dán link là chạy".
2. **Sổ credit là APPEND-ONLY và luôn đối soát được.** Số dư = tổng sổ, KHÔNG có cột `balance` sửa
   tay. Mọi lần trừ/hoàn đều là một dòng mới có `reason`, `job_id`, `operation`, `amount`, `balance_after`.
   Không bao giờ để số dư âm; không bao giờ sửa/xoá dòng sổ.

---

## 1. BẢN ĐỒ SỞ HỮU FILE

| Agent | Được ghi (sở hữu) | Chỉ được đọc |
|---|---|---|
| **A1 — Tài khoản & phiên** | `src/accounts/**` | `src/security/**`, `src/store/**` |
| **A2 — Ví & bảng giá & hook tính tiền** | `src/billing/**` | `src/store/**`, `src/jobs/**` |
| **A3 — Store + migration + wiring** | `src/store/schema.sql`, `src/store/index.js`, `src/app.js` | tất cả |
| **A4 — API + phân quyền** | `src/http/routes.js` | tất cả |
| **A5 — UI** | `public/app.js`, `public/index.html`, `public/styles.css` | tất cả |
| **Test** | `test/**` | tất cả |
| **Phản biện** | `docs/MVP-05-REVIEW.md` | tất cả |
| **Gộp** | mọi file (sửa lệch hợp đồng), trừ `docs/MVP-05-REVIEW.md` | tất cả |

Cấm: sửa `test/**` (trừ agent test), `docs/**`, thêm dependency (chỉ `pg` + Node built-in).
Bắt buộc trước khi báo xong: `node --check` + `npm test` xanh (baseline khi bắt đầu sẽ do người điều
phối chốt — hiện **582 test · 581 pass · 0 fail · 1 skipped**, sẽ tăng sau MVP-03).

---

## 2. HỢP ĐỒNG DỮ LIỆU

### 2.1 Bảng mới (SQLite + PostgreSQL, cùng một `schema.sql`)

```sql
users (
  id TEXT PRIMARY KEY,                 -- uuid
  email TEXT NOT NULL UNIQUE,          -- đã chuẩn hoá lowercase
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member', -- 'owner' | 'admin' | 'member'
  password_hash TEXT NOT NULL,         -- scrypt: "scrypt$N$r$p$salt$hash"
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'disabled'
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT
);

user_sessions (
  id TEXT PRIMARY KEY,                 -- uuid (không lưu token thô)
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,            -- sha256 của token trong cookie
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  last_seen_at TEXT, revoked_at TEXT, user_agent TEXT
);

wallet_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount REAL NOT NULL,                -- âm = trừ, dương = cộng (credit)
  currency TEXT NOT NULL DEFAULT 'USD',
  reason TEXT NOT NULL,                -- 'grant'|'admin_grant'|'job_hold'|'job_settle'|'job_refund'|'adjustment'
  job_id TEXT, operation TEXT, meta TEXT,
  balance_after REAL NOT NULL,         -- đối soát: tổng sổ == balance_after của dòng cuối
  created_at TEXT NOT NULL
);

pricing (
  operation TEXT PRIMARY KEY,          -- SOURCE_EXTRACT|VISION_ANALYSIS|TRANSLATION|CONTENT_GENERATE|CONTENT_REPAIR|OCR_DETECT|IMAGE_RENDER|IMAGE_MATTING|IMAGE_COMPOSE|IMAGE_RETOUCH
  unit_price REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
  note TEXT, updated_at TEXT NOT NULL
);

-- cột thêm vào bảng cũ (migration CỘNG THÊM, idempotent):
--   jobs.user_id TEXT NULL          (job ẩn danh giữ NULL)
--   image_assets.user_id TEXT NULL
```

### 2.2 Quy ước
- `jobs.session_id` **giữ nguyên** (dùng cho ẩn danh + tương thích ngược); `jobs.user_id` là mới.
- Ẩn danh: `user_id = NULL`, không có ví, KHÔNG trừ credit, vẫn bị rate limit theo `session_id`.
- Đã đăng nhập: mọi job/asset mới gắn `user_id`; job cũ của session ẩn danh **không** tự thuộc về ai.

---

## 3. HỢP ĐỒNG MODULE

### 3.1 A1 — `src/accounts/`

```js
export class AccountError extends Error {}          // .code, .details
export const PASSWORD_MIN_LENGTH = 10;
export function hashPassword(password) → string      // scrypt, salt riêng mỗi user
export function verifyPassword(password, stored) → boolean
export function normalizeEmail(email) → string       // trim + lowercase; '' nếu không hợp lệ
export class AccountService {
  constructor({ store, logger, config })
  async register({ email, password, displayName }) → { user, token, expiresAt }   // token THÔ chỉ trả 1 lần
  async login({ email, password, userAgent }) → { user, token, expiresAt }
  async logout(token) → boolean
  async authenticate(token) → user | null              // null nếu hết hạn/đã thu hồi/bị disable
  async getById(id) → user | null
  async list({ limit, offset }) → user[]
  async setRole(id, role) → user                       // chỉ admin gọi được (kiểm ở route)
  async setStatus(id, status) → user
}
export function createAccountService(config, { store, logger }) → AccountService
```

- `user` trả ra **KHÔNG BAO GIỜ** có `password_hash` (dùng `toPublicUser(user)`).
- Mật khẩu: `scrypt` của `node:crypto`, N=16384/r=8/p=1, salt 16 byte; `timingSafeEqual` khi so sánh.
- `token`: 32 byte ngẫu nhiên → base64url; **DB chỉ lưu sha256**. Hạn mặc định 30 ngày (`AUTH_SESSION_DAYS`).
- Cookie: tên `sid_auth`… (chốt: **`vauth`**), `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` khi
  `PUBLIC_BASE_URL` là https; **KHÔNG** chứa email/id người dùng.

### 3.2 A2 — `src/billing/`

```js
export class BillingError extends Error {}          // .code
export class BillingService {
  constructor({ store, logger, config })
  async priceOf(operation) → { operation, unit_price, currency }        // từ bảng pricing, fallback config.cost
  async balance(userId) → { amount, currency }
  async estimate({ userId, operations }) → { total, currency, lines: [{operation, unit_price}] }
  async grant({ userId, amount, reason, actorId, note }) → ledgerRow    // 'admin_grant' | 'grant'
  async holdForJob({ userId, jobId, estimate, operations }) → { ledgerId, balance_after }
  async settleForJob({ userId, jobId, actualCost }) → ledgerRow         // trả phần chênh (âm/dương)
  async refundForJob({ userId, jobId, reason }) → ledgerRow             // hoàn 100% phần đã giữ
  async history({ userId, limit, offset }) → ledgerRow[]
  async usageSummary({ from, to, groupBy }) → rows                      // cho trang quản trị
}
export function createBillingService(config, { store, logger }) → BillingService
```

Luật:
- **Không bao giờ số dư âm**: nếu `balance + amount < 0` ⇒ ném `INSUFFICIENT_CREDIT` (không ghi sổ).
- `holdForJob`: giữ tiền **trước** khi chạy job theo `estimated_cost` (tổng các operation dự kiến);
  nếu thiếu ⇒ `402 INSUFFICIENT_CREDIT` **trước** khi tạo job.
- `settleForJob`: đối chiếu với `usage_events` thật của job, hoàn phần chênh; `refundForJob` khi job
  `failed` (100% phần đã giữ).
- Mọi lần ghi sổ phải **tuần tự hoá theo user** (khoá trong bộ nhớ `#locks` là đủ cho 1 tiến trình;
  ghi rõ giới hạn này trong tài liệu) để `balance_after` không lệch khi 2 request cùng lúc.
- Ẩn danh (`userId` null) ⇒ mọi hàm billing ném `ANONYMOUS_NO_WALLET`; tầng gọi phải bỏ qua billing.

### 3.3 A4 — API (đóng băng)

```
POST /api/auth/register   { email, password, display_name? } → 201 { user, expires_at } + Set-Cookie
POST /api/auth/login      { email, password }                → 200 { user, expires_at } + Set-Cookie
POST /api/auth/logout                                        → 200 { ok: true }
GET  /api/auth/me         → 200 { user: {...} | null, anonymous: boolean, balance: {amount,currency}|null }
GET  /api/billing/ledger?limit&offset → 200 { items, balance }
GET  /api/billing/pricing → 200 { pricing: [{operation, unit_price, currency, note}] }
GET  /api/admin/users?limit&offset → 200 { items, total }            (chỉ role owner|admin)
POST /api/admin/users/:id/credit { amount, note } → 201 { ledger, balance }
POST /api/admin/users/:id/role   { role } → 200 { user }
GET  /api/admin/usage?from&to&group_by=day|operation|user → 200 { rows }
```

- **Phân quyền**: `GET/POST /api/admin/*` yêu cầu `role ∈ {owner, admin}` ⇒ nếu không: **403**; chưa
  đăng nhập ⇒ **401**. (Khác MVP-02: ở đây 401/403 đúng nghĩa vì đã có xác thực thật.)
- **Tách dữ liệu**: khi đã đăng nhập, `GET /api/jobs`, `GET /api/jobs/:id`, mọi route imagelab/imagestudio
  **chỉ** trả tài nguyên của chính user đó (`jobs.user_id = user.id`) ⇒ khác chủ ⇒ **404** (không xác
  nhận sự tồn tại). Ẩn danh giữ nguyên hành vi theo `session_id` như trước.
- Giữ **nguyên** mọi route cũ; thêm middleware `attachUser` (đọc cookie `vauth` → `req.user`) và
  `requireUser`/`requireAdmin`.
- `GET /api/config` thêm `auth: { enabled: true, anonymous_allowed: true, password_min_length: 10,
  roles: ['owner','admin','member'] }`.

### 3.4 A3 — Store + migration + wiring

- Thêm 4 bảng §2.1 vào `schema.sql` (chạy được cả SQLite và PostgreSQL).
- `#applyAdditiveMigrations()` thêm cột `jobs.user_id`, `image_assets.user_id` (idempotent, cả 2 driver).
- Method store mới (tên đóng băng):
  `createUser`, `getUserByEmail`, `getUserById`, `listUsers`, `updateUser`, `touchLastLogin`,
  `createUserSession`, `getUserSessionByTokenHash`, `touchUserSession`, `revokeUserSession`,
  `revokeAllUserSessions`, `appendLedger`, `listLedger`, `ledgerBalance`, `upsertPricing`, `listPricing`,
  `usageAggregate({from,to,groupBy})`.
- `createJob({... userId})`, `#hydrateJob` trả thêm `user_id`; `createImageAsset({... userId})`.
- `src/app.js`: nạp **phòng thủ** `accountService` + `billingService` (try/catch + dynamic import như
  MVP-02/03); lỗi ⇒ log `accounts.wiring_failed`/`billing.wiring_failed` **mức error** và đặt `null`,
  **MVP-01/02/03 vẫn boot**; `/api/health` + `/api/config` trả `accounts: { available, reason }`.
- Hook tính tiền trong `src/jobs/pipeline.js`, `src/imagelab/pipeline.js`, `src/imagestudio/pipeline.js`:
  **chỉ khi** job có `user_id` (đăng nhập) ⇒ `holdForJob` trước khi chạy, `settleForJob` sau khi xong,
  `refundForJob` khi `failed`. Ẩn danh ⇒ bỏ qua hoàn toàn (không gọi billing).

### 3.5 A5 — UI

- Trang **Đăng nhập / Đăng ký** (route `#/dangnhap`), trang **Tài khoản** (`#/taikhoan`: số dư, lịch sử sổ),
  trang **Quản trị** (`#/quantri`, chỉ hiện với role owner|admin: danh sách user, cấp credit, usage).
- Header hiện: `Khách ẩn danh` khi chưa đăng nhập (kèm ghi chú “dữ liệu chỉ theo phiên trình duyệt”)
  hoặc `email · số dư` khi đã đăng nhập.
- Khi chưa đăng nhập, **không** chặn tính năng nào (luật #1); chỉ hiện gợi ý “đăng nhập để lưu lịch sử”.
- Escape mọi thứ bằng `esc()`; không hiển thị token; đăng xuất phải gọi API + xoá state.

---

## 4. ĐỊNH NGHĨA "XONG" CỦA MVP-05

- Ẩn danh vẫn chạy đủ MVP-01/02/03 (test cũ xanh 100%).
- Đăng ký/đăng nhập/đăng xuất hoạt động; mật khẩu **không bao giờ** lưu thô; token trong cookie là
  token **hash** ở DB; hết hạn/thu hồi ⇒ 401.
- Tách dữ liệu: user A **không** đọc/ghi được job/asset của user B (404), kể cả qua route cũ.
- Sổ credit append-only: số dư = tổng sổ; không có đường nào làm số dư âm; mọi trừ/hoàn có `reason` +
  `job_id`; job lỗi ⇒ hoàn tiền có dòng sổ.
- Chưa đủ credit ⇒ `402 INSUFFICIENT_CREDIT` **trước** khi chạy job (không tiêu tiền của người dùng
  rồi mới báo thiếu).
- Trang quản trị chỉ owner/admin vào được (401/403 đúng); usage tổng hợp được theo ngày/operation/user.
- `npm test` xanh; `node tools/verify.mjs` xanh; migration idempotent trên DB cũ.

**KHÔNG thuộc MVP-05:** cổng thanh toán thật, hoá đơn, webhook (MVP-06 — cần Owner quyết nhà cung cấp
và pháp nhân nhận tiền). Nạp credit ở MVP-05 chỉ bằng **admin cấp tay** (có ghi sổ).

---

## 2.3 KHOÁ CẤU HÌNH (A1 sở hữu `src/config.js` + `.env.example`)

```js
auth: {
  enabled: true,              // AUTH_ENABLED
  cookieName: 'vauth',        // AUTH_COOKIE_NAME
  sessionDays: 30,            // AUTH_SESSION_DAYS
  passwordMinLength: 10,      // AUTH_PASSWORD_MIN_LENGTH
  anonymousAllowed: true,     // AUTH_ANONYMOUS_ALLOWED  (false ⇒ mọi route cần đăng nhập, TRỪ /api/auth/*)
  secureCookie: false,        // AUTH_SECURE_COOKIE (bật khi chạy https)
},
billing: {
  enabled: true,              // BILLING_ENABLED
  currency: 'USD',            // CREDIT_CURRENCY  (đã có ở MVP-01 — dùng lại, KHÔNG tạo khoá thứ hai)
  defaultGrant: 0,            // BILLING_DEFAULT_GRANT (credit tặng khi đăng ký; 0 = không tặng)
  holdBeforeJob: true,        // BILLING_HOLD_BEFORE_JOB (giữ tiền trước khi chạy job)
  pricingFromCost: true,      // BILLING_PRICING_FROM_COST (seed bảng pricing từ config.cost hiện có)
},
```

Luật: **không** tạo khoá tiền tệ thứ hai; `config.cost.*` của MVP-01 vẫn là nguồn giá mặc định.
`AUTH_ANONYMOUS_ALLOWED=false` chỉ được dùng khi Owner muốn đóng hoàn toàn chế độ ẩn danh — mặc định
giữ `true` để mọi test cũ xanh.

---

## 3.4b HOOK GIỮ TIỀN GỌI ĐƯỢC TỪ ROUTE (bổ sung, ĐÓNG BĂNG)

**Vấn đề thật (A4 phát hiện):** `POST /api/jobs` xếp hàng qua `queue.enqueue(jobId, () => pipeline.run(...))`;
handler chạy trong `#runItem` có try/catch ⇒ lỗi `INSUFFICIENT_CREDIT` ném từ **trong** pipeline
**không bao giờ** ra tới HTTP ⇒ client nhận 202 rồi job `failed`, tức là **đã tiêu thời gian của người
dùng rồi mới báo thiếu tiền** — trái luật “chặn TRƯỚC khi chạy”.

**Hợp đồng đóng băng (A3 hiện thực, A4 gọi):**

```js
app.billingHook = {
  async beforeJob({ userId, jobId, kind, sessionId }) → { held: number, balance_after, currency }
      // - userId rỗng/null (ẩn danh) ⇒ KHÔNG làm gì, trả { held: 0, balance_after: null }
      // - đủ tiền ⇒ giữ tiền (dòng `job_hold`) rồi trả về
      // - thiếu tiền ⇒ ném BillingError code 'INSUFFICIENT_CREDIT' + details { required, balance, currency }
      // - IDEMPOTENT theo jobId (gọi 2 lần không giữ 2 lần)
      // - billingService null ⇒ bỏ qua (trả { held: 0, balance_after: null }) + log 1 lần
  async afterJob({ userId, jobId, status, actualCost }) → { settled: boolean, refunded: number }
      // status 'failed' ⇒ hoàn 100% phần đã giữ; ngược lại ⇒ quyết toán theo actualCost
      // idempotent theo jobId; billingService null ⇒ bỏ qua
};
```

- **A4 gọi `await app.billingHook.beforeJob(...)` NGAY TRONG REQUEST**, **sau** `store.createJob` và
  **TRƯỚC** `queue.enqueue`, ở **5 chỗ**: `POST /api/jobs`, `POST /api/imagelab/jobs`,
  `PUT /api/imagelab/jobs/:id/regions`, `POST /api/imagestudio/jobs`,
  `POST /api/imagestudio/jobs/:id/generate`. Lỗi ⇒ map **402** `INSUFFICIENT_CREDIT` +
  `details { required, balance, currency }`; **không** job/ảnh nào được tạo (kiểm: DB không tăng).
- **A3 gọi `afterJob`** ở cuối mỗi pipeline (đúng một lần cho mỗi lượt chạy thật).
- Cả hai hàm **không bao giờ** làm hỏng luồng cũ: bọc try/catch, log `billing.hook_failed` mức warn —
  **trừ** `INSUFFICIENT_CREDIT` ở `beforeJob` (đó là fail-closed có chủ ý, phải ném ra).
- `billingHook` là **object hằng** trên `app` (không phải hàm), để A4 gọi ổn định kể cả khi
  `billingService` là `null`.

---

# VÒNG 2 — SỬA THEO PHẢN BIỆN (PB-01…PB-08)

Phán quyết vòng 1: **FAIL** (`docs/MVP-05-REVIEW.md`: 1 CRITICAL/CAO ×3 + TB ×2 + THẤP ×3).
Các mục dưới đây là **bổ sung** — không đổi tên field/khoá đã đóng băng, chỉ làm chúng có tác dụng thật.

## 5.1 PB-01 — mọi lỗi SAU khi giữ tiền đều phải HOÀN

- `src/http/routes.js` thêm `withHoldRelease(req, jobId, hold, fn)`: chạy phần việc sau khi giữ
  tiền, lỗi ⇒ gọi `releaseHoldOnFailure` (hoàn 100%) rồi ném lại.
- Áp cho **cả 5 chỗ** đã giữ tiền: `POST /api/jobs`, `POST /api/imagelab/jobs`,
  `PUT /api/imagelab/jobs/:id/regions`, `POST /api/imagestudio/jobs`,
  `POST /api/imagestudio/jobs/:id/generate` — kể cả nhánh `ingest` lỗi và `queue.enqueue` lỗi.
- Bất biến mới: **request trả 4xx sau khi giữ tiền ⇒ số dư về đúng như trước + có dòng `job_refund`**.

## 5.2 PB-02 — chu kỳ tiền theo LƯỢT CHẠY (run), không theo `jobId`

- Cột mới `wallet_ledger.run_key` (TEXT, thêm bằng migration cộng thêm — **không** đặt trong
  `schema.sql` để không làm chết `init()` trên DB cũ, cùng bài học với `seq`).
- `run_key = "<jobId>#<n>"`, `n` = số lượt đã mở + 1. `BillingService.holdForJob/settleForJob/
  refundForJob` nhận `runKey`; **idempotent theo (job, run)**: gọi lại cùng lượt ⇒ không ghi thêm.
- Hook `beforeJob`: lượt ĐANG MỞ (hold chưa settle/refund) ⇒ dùng lại (idempotent); đã khép ⇒
  **mở lượt MỚI** (chạy lại PHẢI trả tiền). `afterJob` khép ĐÚNG lượt đang mở.
- Trần mới `config.billing.maxRunsPerJob` (env `BILLING_MAX_RUNS_PER_JOB`, mặc định 10): vượt ⇒
  lỗi `RERUN_LIMIT_EXCEEDED`, route map **429** (kèm `details {job_id, runs, max_runs}`).
  Vượt trần được kiểm **trong request** ở `regenerate`/`render`/`generate`/tạo job mới.
- Ẩn danh vẫn KHÔNG có ví, KHÔNG dòng sổ (luật #1 không đổi).

## 5.3 PB-03 — bootstrap owner đầu tiên

- `AccountService.bootstrapOwner({ email, password? })`: chưa có owner/admin ⇒ nâng user đã có
  lên `owner`, hoặc TẠO mới với mật khẩu tạm **trả về đúng một lần**; đã có owner ⇒ không làm gì.
- Boot (`src/app.js`): `OWNER_EMAIL` (khoá mới `config.auth.ownerEmail`) ⇒ bootstrap ngay; tạo mới
  thì log **WARN** kèm mật khẩu tạm + câu “ĐỔI MẬT KHẨU NGAY”. Không có `OWNER_EMAIL` và cũng
  chưa có owner ⇒ log WARN hướng dẫn `npm run make-owner -- <email>` (không im lặng).
- CLI `tools/make-owner.mjs` + script `npm run make-owner -- <email> [mật khẩu]` (idempotent).
- Ghi vào `README.md` (mục khởi động) + `.env.example`.

## 5.4 PB-04 — `refundForJob` không bao giờ hoàn phần ĐÃ TIÊU

- Nếu lượt chạy đã có `job_settle` ⇒ `refundForJob` trả dòng settle cũ, **không ghi thêm**.
- Chặn ở tầng DB: **partial unique index** `uniq_wallet_ledger_run_reason` trên
  `(user_id, job_id, run_key, reason)` WHERE `reason IN ('job_hold','job_settle','job_refund') AND
  run_key IS NOT NULL` — tạo SAU migration (idempotent, chạy được cả SQLite và PostgreSQL).

## 5.5 PB-05 — hai khoá cấu hình hết "nói dối"

- `billing.defaultGrant` được **nối thật**: đăng ký xong ⇒ `grant` đúng số đó (`reason='grant'`,
  response có `credit_granted`), UI/ledger đọc được.
- `billing.holdBeforeJob === false` ⇒ KHÔNG giữ tiền trước, KHÔNG chặn 402, chỉ settle theo chi phí
  THẬT sau khi chạy + log WARN một lần; `GET /api/config.billing` trả `hold_before_job`,
  `default_grant`, `max_runs_per_job`, `max_amount`.

## 5.6 PB-06 — trần credit + chặn tràn số

- `money.normalizeAmount(value, { max })`: `1e308` ⇒ `INVALID_AMOUNT` (tràn số), vượt trần ⇒
  `AMOUNT_TOO_LARGE`; mọi khoản ghi sổ đi qua đây. `config.billing.maxAmount`
  (`BILLING_MAX_AMOUNT`, mặc định `1e9`). Route map **400** (trước: `grant(1e308)` ⇒ 201 + dòng 0).

## 5.7 PB-07 — credit số âm = điều chỉnh giảm

- `POST /api/admin/users/:id/credit` nhận `amount` ÂM ⇒ `reason='adjustment'`; `amount = 0` hoặc
  không phải số ⇒ 400 `BAD_AMOUNT`. Giảm quá số dư ⇒ **400 `INSUFFICIENT_CREDIT`** (giữ luật ví
  không âm; KHÁC 402 vì đây là thao tác quản trị, không phải "ví không đủ để chạy job").

## 5.8 PB-08 — chống brute-force đăng nhập

- Bucket RIÊNG theo **`email` chuẩn hoá + IP**: 10 lần **SAI** / 5 phút cho mỗi cặp; vượt ⇒
  **429 + `Retry-After`**.
- **Đăng nhập ĐÚNG không bao giờ bị chặn** bởi bộ đếm lần sai của chính mình: khi bucket đầy vẫn
  xác thực, đúng ⇒ cho vào + xoá bộ đếm; sai ⇒ 429.
- ⚠️ Vận hành sau reverse proxy: xem ghi chú `trust proxy` ở `docs/SECURITY.md` — sai cấu hình thì
  mọi khách chung một IP và bucket theo IP mất tác dụng.

---

# VÒNG 3 — SỬA THEO PHẢN BIỆN VÒNG 2 (BR-01…BR-07)

Phán quyết vòng 2: **FAIL** (`docs/MVP-05-REVIEW.md` mục “VÒNG 2”). Bổ sung bắt buộc:

## 6.1 BR-07 — settle theo LƯỢT CHẠY, không theo usage tích luỹ

- `usage_events.run_key` (cột mới, migration cộng thêm — cùng cách với `wallet_ledger.run_key`);
  `store.recordUsage({..., runKey})` ghi khoá lượt; `store.usageSummary(jobId, { runKey })` lọc theo
  lượt (dòng cũ `run_key IS NULL` quy về lượt `#1`).
- Pipeline (jobs/imagelab/imagestudio) nhớ `run_key` của lượt đang chạy (`#runKeys`, lấy từ
  `hook.beforeJob` / `hook.runKeyForJob`), gắn vào MỌI `recordUsage`, và truyền vào `afterJob`.
- `BillingService.settleForJob({..., runKey})`: nếu không có `actualCost` thì lấy chi phí **của
  riêng lượt** (`usageSummary(runKey)`), nếu lượt chưa có dòng usage gắn khoá thì lấy
  `max(0, tổng usage − Σ đã thu của các lượt trước)` — **không bao giờ** thu lại tiền lượt cũ.
- Bất biến: với N lượt chạy, `Σ(đã thu) == chi phí THẬT của N lượt` (không thu thừa).

## 6.2 BR-01 — `BILLING_HOLD_BEFORE_JOB=false` vẫn phải mở LƯỢT, settle và áp trần

- Không giữ tiền trước, nhưng `beforeJob` **mở lượt** (`run_key`), `afterJob` ghi `job_settle`
  theo chi phí THẬT của lượt đó, và **trần `maxRunsPerJob` vẫn áp** (429 `RERUN_LIMIT_EXCEEDED`).
- Ví không đủ lúc quyết toán ⇒ thu tối đa phần đang có, ghi `meta.shortfall` vào sổ + log **ERROR**
  `billing.settle_shortfall` (không im lặng).

## 6.3 BR-02 — hai request chồng nhau trên cùng job

- Lượt đang MỞ ⇒ request thứ hai (route) trả **409 `JOB_ALREADY_RUNNING`** kèm `{job_id, run_key}`;
  không dùng chung khoản giữ để chạy K lượt thật. Bất biến: số lượt chạy thật == số lượt bị thu.

## 6.4 BR-03 — sổ lỗi/khoá ghi: fail-closed + ràng buộc DB

- Lỗi ghi sổ ở `beforeJob` ⇒ `BILLING_UNAVAILABLE` ⇒ **503** (TRỪ khi `billing.enabled=false`):
  không cho job chạy mà không thu được tiền (trước đây bị nuốt ⇒ fail-open).
- `#callStore` map lỗi hạ tầng (`database is locked`, deadlock/`40001`/`40P01`, timeout) thành
  `LEDGER_BUSY` (kèm `details.retryable`) thay vì để lộ mã thô của driver.
- `afterJob` lỗi ⇒ log **ERROR** `billing.after_job_failed` (có `run_key`) — không chết im lặng.
- Cột `wallet_ledger.close_kind` (`settle`|`refund`) + **unique index** `uniq_wallet_ledger_run_close`
  trên `(user_id, job_id, run_key)` WHERE `close_kind IS NOT NULL` ⇒ mỗi lượt chỉ có MỘT dòng đóng
  (settle HOẶC refund), chạy được cả SQLite lẫn PostgreSQL, tạo SAU migration.
- SQLite: `PRAGMA busy_timeout = 5000` (đã có trong `src/store/sqlite-driver.js`).

## 6.5 BR-04…BR-06

- **BR-04**: login giữ **cả hai** bucket — `(email chuẩn hoá, IP)` 10 lần sai/5 phút **và** theo
  `IP` 60 lần sai/5 phút (chống spraying); 429 kèm `Retry-After`. Đăng nhập ĐÚNG vẫn luôn được
  xác thực và xoá cả hai bộ đếm.
- **BR-05**: trần `maxRunsPerJob` chỉ đếm **lượt có thu** (đã `job_settle`, hoặc đang mở). Lượt
  lỗi đã hoàn tiền **không** tính ⇒ job chưa từng thành công không bị 429 oan.
- **BR-06**: `ingest` lỗi ở route ImageLab ⇒ job `failed` + `error_code` + `finished_at`
  (hết treo `running`), tiền vẫn hoàn đủ.
