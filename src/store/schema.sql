-- ============================================================================
-- VIP PRODUCT STUDIO — schema MVP-01 + phần cộng thêm của MVP-02 (ImageLab)
--
-- Viết theo SQL DI ĐỘNG (portable): dùng TEXT/INTEGER/REAL, thời gian lưu dạng
-- ISO-8601 trong TEXT. Nhờ vậy CÙNG một file schema chạy được trên cả SQLite
-- (node:sqlite) và PostgreSQL 16 — không phải bảo trì hai bản schema.
--
-- Quy ước: mọi câu lệnh dùng placeholder `?`; driver PostgreSQL tự dịch sang $n.
-- ============================================================================

CREATE TABLE IF NOT EXISTS jobs (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT,
  source              TEXT,
  source_url          TEXT,
  canonical_url       TEXT,
  source_product_id   TEXT,
  product_name        TEXT,
  status              TEXT NOT NULL,
  stage               TEXT,
  error_code          TEXT,
  error_message       TEXT,
  style               TEXT,
  length              TEXT,
  input_mode          TEXT,
  -- MVP-02: 'content' (MVP-01) | 'image_translation' (ImageLab).
  -- DB cũ đã có bảng jobs sẽ được nâng cấp tại chỗ bằng #applyAdditiveMigrations().
  kind                TEXT DEFAULT 'content',

  -- Các tầng dữ liệu, lưu JSON
  product_master      TEXT,
  vision              TEXT,
  knowledge           TEXT,
  content             TEXT,
  evidence            TEXT,
  content_meta        TEXT,

  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  finished_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs (session_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs (source);

-- G13 — nền tảng usage/billing. Chưa thu tiền thật; mục tiêu là sau này
-- chuyển sang credit-based SaaS mà không phải viết lại core.
CREATE TABLE IF NOT EXISTS usage_events (
  id              TEXT PRIMARY KEY,
  job_id          TEXT,
  session_id      TEXT,
  operation       TEXT NOT NULL,
  provider        TEXT,
  model           TEXT,
  input_units     INTEGER DEFAULT 0,
  output_units    INTEGER DEFAULT 0,
  estimated_cost  REAL DEFAULT 0,
  currency        TEXT DEFAULT 'USD',
  meta            TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_job ON usage_events (job_id);
CREATE INDEX IF NOT EXISTS idx_usage_operation ON usage_events (operation);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events (created_at);

-- Ảnh người dùng tự tải lên (G11 manual fallback).
CREATE TABLE IF NOT EXISTS uploads (
  id          TEXT PRIMARY KEY,
  job_id      TEXT,
  session_id  TEXT,
  filename    TEXT,
  mime        TEXT,
  bytes       INTEGER,
  source      TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_uploads_job ON uploads (job_id);

-- Vết kiểm chứng cho verifier: mỗi lần trích xuất ghi lại mức độ bằng chứng.
CREATE TABLE IF NOT EXISTS extraction_evidence (
  id                TEXT PRIMARY KEY,
  job_id            TEXT,
  connector         TEXT,
  extraction_method TEXT,
  verification      TEXT,   -- MOCK_VERIFIED | LIVE_VERIFIED | AUTHENTICATED_LIVE_VERIFIED | BLOCKED | UNSUPPORTED
  http_status       INTEGER,
  bytes             INTEGER,
  login_required    INTEGER DEFAULT 0,
  blocked_reason    TEXT,
  found_fields      TEXT,
  missing_fields    TEXT,
  vision_provider   TEXT,
  content_provider  TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_job ON extraction_evidence (job_id);

-- ============================================================================
-- MVP-02 — ImageLab (dịch chữ Trung trên ảnh sản phẩm sang tiếng Việt)
--
-- Ba bảng dưới đây chỉ dùng TEXT/INTEGER/REAL nên CÙNG file schema chạy được trên
-- cả SQLite và PostgreSQL — không cột nào phụ thuộc cú pháp riêng của driver.
-- DB cũ (đã có bảng từ MVP-01) chạy lại schema này là nâng cấp được tại chỗ, vì
-- mọi câu lệnh đều `IF NOT EXISTS` và cột `jobs.kind` do #applyAdditiveMigrations lo.
-- ============================================================================

-- Ảnh gốc (BẤT BIẾN) và ảnh đã render (bản ghi MỚI có parent_id + sha256 riêng).
CREATE TABLE IF NOT EXISTS image_assets (
  id TEXT PRIMARY KEY, job_id TEXT, session_id TEXT, role TEXT NOT NULL, parent_id TEXT,
  mime TEXT, bytes INTEGER, width INTEGER, height INTEGER, sha256 TEXT, storage_path TEXT,
  source TEXT, meta TEXT, created_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_image_assets_job ON image_assets (job_id, role);

-- Vùng chữ OCR đọc được. `id` là khoá kỹ thuật (duy nhất toàn cục),
-- `region_key` là id vùng theo hợp đồng 3.2 ('r1', 'r2'…) — chỉ duy nhất trong job.
CREATE TABLE IF NOT EXISTS ocr_regions (
  id TEXT PRIMARY KEY, job_id TEXT, asset_id TEXT, region_key TEXT,
  x INTEGER, y INTEGER, w INTEGER, h INTEGER,
  x_norm REAL, y_norm REAL, w_norm REAL, h_norm REAL,
  text_original TEXT, lang TEXT, confidence REAL, kind TEXT, kind_reason TEXT,
  translatable INTEGER DEFAULT 0, source TEXT, created_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_ocr_regions_job ON ocr_regions (job_id);

-- Bản dịch từng dòng, khoá theo `region_key` trong phạm vi một job.
CREATE TABLE IF NOT EXISTS translation_lines (
  id TEXT PRIMARY KEY, job_id TEXT, region_key TEXT, text_original TEXT, text_vi TEXT,
  status TEXT, provenance TEXT, confidence REAL, violations TEXT, notes TEXT,
  edited_by_user INTEGER DEFAULT 0, edited_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_translation_lines_job ON translation_lines (job_id);

-- ============================================================================
-- MVP-05 — TÀI KHOẢN + VÍ CREDIT (hợp đồng §2.1)
--
-- Bốn bảng dưới đây cũng chỉ dùng TEXT/INTEGER/REAL + ISO-8601 trong TEXT nên CÙNG
-- file schema chạy được trên cả SQLite (node:sqlite) và PostgreSQL 16.
--
-- Hai luật riêng của MVP-05 được phản ánh ngay ở đây:
--   #1 Ẩn danh KHÔNG bị phá: `jobs.user_id` / `image_assets.user_id` là cột CỘNG THÊM,
--      NULL = job ẩn danh (xem #applyAdditiveMigrations trong src/store/index.js).
--   #2 Sổ credit APPEND-ONLY: `wallet_ledger` KHÔNG có cột `balance` sửa tay; số dư là
--      tổng `amount`, còn `balance_after` chỉ để đối soát dòng cuối. Không có UPDATE/DELETE
--      nào lên bảng này trong toàn bộ mã nguồn.
-- ============================================================================

-- Người dùng. `email` đã chuẩn hoá lowercase ở tầng store (UNIQUE).
-- `password_hash` là scrypt dạng "scrypt$N$r$p$salt$hash" — KHÔNG BAO GIỜ là mật khẩu thô.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'member',   -- 'owner' | 'admin' | 'member'
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'disabled'
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_login_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Phiên đăng nhập. DB chỉ lưu `token_hash` (sha256 của token trong cookie) — KHÔNG lưu
-- token thô, nên rò rỉ DB cũng không dùng lại được phiên.
CREATE TABLE IF NOT EXISTS user_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at   TEXT,
  user_agent   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions (user_id);

-- Sổ credit — APPEND-ONLY. Mỗi lần trừ/hoàn là MỘT DÒNG MỚI:
--   amount < 0: giữ tiền (job_hold) / quyết toán phần vượt (job_settle)
--   amount > 0: cấp credit (grant/admin_grant) / hoàn tiền (job_refund/job_settle)
-- `balance_after` = tổng `amount` của user NGAY SAU dòng này, tính trong CÙNG transaction
-- với lần chèn (xem Store#appendLedger) nên không bao giờ lệch khi 2 request cùng lúc.
-- TIỀN TỆ LÀM TRÒN 6 CHỮ SỐ (`roundMoney`) ngay khi ghi và khi đọc tổng — nếu cộng float
-- thô thì sổ sẽ có 1.9000000000000001 và mọi phép so sánh số dư đều lệch ~1e-15.
-- `seq`: số thứ tự TĂNG DẦN trong phạm vi một user, cấp ngay trong transaction của lần
-- chèn. Nhiều dòng có thể cùng mili-giây (`created_at`) nên chỉ sắp theo thời gian là
-- KHÔNG ổn định (uuid ngẫu nhiên ⇒ trang sổ nhảy cóc, phân trang trùng/sót). `seq` cho
-- thứ tự xác định trên CẢ SQLite lẫn PostgreSQL mà không cần sequence của từng driver.
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  seq           INTEGER NOT NULL DEFAULT 0,
  amount        REAL NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  reason        TEXT NOT NULL,   -- 'grant'|'admin_grant'|'job_hold'|'job_settle'|'job_refund'|'adjustment'
  job_id        TEXT,
  operation     TEXT,
  meta          TEXT,
  balance_after REAL NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wallet_ledger_user ON wallet_ledger (user_id);
-- LƯU Ý: index trên `seq` KHÔNG đặt ở đây. DB tạo bởi bản trước đã có bảng `wallet_ledger`
-- nhưng CHƯA có cột `seq`; `CREATE TABLE IF NOT EXISTS` là no-op nên câu index này sẽ chạy
-- TRƯỚC migration thêm cột và làm chết `init()`. Index `(user_id, seq)` do
-- `#applyAdditiveMigrations()` tạo SAU khi cột đã tồn tại (xem src/store/index.js).
CREATE INDEX IF NOT EXISTS idx_wallet_ledger_job ON wallet_ledger (job_id);

-- Bảng giá theo operation. `config.cost.*` (MVP-01) vẫn là nguồn giá MẶC ĐỊNH; bảng này
-- để quản trị viên chỉnh giá mà không phải deploy lại (A2 seed từ config khi cần).
CREATE TABLE IF NOT EXISTS pricing (
  operation  TEXT PRIMARY KEY,
  unit_price REAL NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  note       TEXT,
  updated_at TEXT NOT NULL
);
