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

-- ============================================================================
-- R1 — HÀNG ĐỢI BỀN (hợp đồng §2.1)
--
-- Vì sao có bảng này: hàng đợi MVP-01..05 nằm TRONG BỘ NHỚ, khởi động lại tiến trình là
-- mất mọi việc đang chờ (đã ghi ở docs/OWNER-DECISIONS.md mục 4). Bảng này là SỔ CÁI của
-- hàng đợi: mục việc được ghi DB TRƯỚC khi chạy, nên tiến trình chết vẫn chạy lại được.
--
-- Chỉ dùng TEXT/INTEGER + thời gian ISO-8601 trong TEXT ⇒ CÙNG file schema chạy được trên
-- cả SQLite (node:sqlite) và PostgreSQL 16.
--
-- ⚠️ INDEX KHÔNG đặt ở đây — bài học `wallet_ledger.seq`: index tạo trong file này chạy
-- TRƯỚC migration, nên trên DB cũ (bảng đã tồn tại nhưng thiếu cột) `CREATE INDEX` sẽ làm
-- chết `init()`. Ba index của bảng này do `#applyAdditiveMigrations()` tạo SAU migration
-- (xem src/store/index.js).
--
-- `payload` là JSON NHỎ (tham số lượt chạy) — TUYỆT ĐỐI không nhét base64 ảnh vào đây.
-- ============================================================================
CREATE TABLE IF NOT EXISTS job_queue (
  id           TEXT PRIMARY KEY,             -- uuid của MỤC hàng đợi (khác `job_id`)
  job_id       TEXT NOT NULL,
  kind         TEXT NOT NULL,                -- 'content' | 'image_translation' | 'image_generation' | 'video_generation'
  handler      TEXT NOT NULL,                -- tên việc: 'run' | 'generate' | 'render' | 'run_ocr' …
  payload      TEXT,
  status       TEXT NOT NULL DEFAULT 'queued',   -- 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after    TEXT,                         -- ISO: chưa tới mốc thì không nhặt (backoff)
  locked_at    TEXT,
  locked_by    TEXT,
  heartbeat_at TEXT,                         -- R1-F2: nhịp tim của worker đang giữ mục
  epoch        INTEGER NOT NULL DEFAULT 0,   -- R1-A3: số thứ tự lần CLAIM (fencing)
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  finished_at  TEXT
);

-- Bảng giá theo operation. `config.cost.*` (MVP-01) vẫn là nguồn giá MẶC ĐỊNH; bảng này
-- để quản trị viên chỉnh giá mà không phải deploy lại (A2 seed từ config khi cần).
CREATE TABLE IF NOT EXISTS pricing (
  operation  TEXT PRIMARY KEY,
  unit_price REAL NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'USD',
  note       TEXT,
  updated_at TEXT NOT NULL
);

-- ============================================================================
-- MVP-07 — ĐĂNG BÀI FACEBOOK PAGE (DUYỆT TAY) — hợp đồng `docs/MVP-07-CONTRACT.md` §3
--
-- Vì sao có hai bảng này: chủ dự án đã chốt **duyệt tay từng bài**. `publish_items` là HÀNG ĐỢI
-- DUYỆT (sổ cái của từng bài: ai duyệt, lúc nào, đã đăng chưa, id bài bên ngoài), còn
-- `publish_logs` là VẾT của **mọi** lời gọi provider — kể cả lần thất bại, kèm lỗi NGUYÊN VĂN
-- của nền tảng. Không có `publish_logs` thì `last_error` chỉ giữ lỗi cuối và cả lịch sử đăng
-- biến mất, đúng kiểu "không chứng minh được" mà repo này cấm.
--
-- CỔNG DUYỆT nằm ở tầng DB: `Store#claimPublishItem` là MỘT câu UPDATE có điều kiện
-- (`status IN ('approved','failed') AND external_post_id IS NULL`). Không claim được ⇒ không có
-- đường nào gọi tới provider ⇒ hệ thống KHÔNG BAO GIỜ tự đăng khi chưa có người bấm duyệt.
--
-- Chỉ dùng TEXT/INTEGER + thời gian ISO-8601 trong TEXT ⇒ CÙNG file schema chạy được trên cả
-- SQLite (node:sqlite) và PostgreSQL 16.
--
-- ⚠️ INDEX KHÔNG ĐẶT Ở ĐÂY — bài học `wallet_ledger.seq` / `job_queue.epoch`: index trong file
-- này chạy TRƯỚC migration, nên trên DB cũ (bảng đã tồn tại nhưng thiếu cột) `CREATE INDEX` làm
-- CHẾT `init()`. Bốn index của hai bảng này do `#applyAdditiveMigrations()` tạo SAU migration
-- (xem src/store/index.js).
-- ============================================================================
CREATE TABLE IF NOT EXISTS publish_items (
  id               TEXT PRIMARY KEY,
  job_id           TEXT,
  user_id          TEXT,                              -- chủ bài; route /api/publish/* bắt buộc đăng nhập
  channel          TEXT NOT NULL DEFAULT 'facebook_page',
  provider         TEXT,                              -- provider ĐÃ dùng ở lượt đăng gần nhất
  text             TEXT,
  media_ids        TEXT,                              -- JSON mảng id của image_assets
  -- 'draft' | 'pending_review' | 'approved' | 'publishing' | 'published' | 'failed' | 'rejected'
  status           TEXT NOT NULL DEFAULT 'draft',
  scheduled_at     TEXT,
  approved_by      TEXT,                              -- user_id của owner/admin đã bấm DUYỆT
  approved_at      TEXT,
  rejected_by      TEXT,
  rejected_at      TEXT,
  reject_reason    TEXT,
  published_at     TEXT,
  external_post_id TEXT,                              -- id bài trên nền tảng; 'dry-…' = CHẾ ĐỘ THỬ
  external_url     TEXT,
  is_mock          INTEGER NOT NULL DEFAULT 0,        -- 1 = kết quả của provider GIẢ (dry-run)
  error_code       TEXT,
  last_error       TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  run_key          TEXT,                              -- '<itemId>#<n>' — danh tính MỘT lượt đăng
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- Vết MỌI lời gọi provider (luật §0.3 của hợp đồng). APPEND-ONLY: không UPDATE/DELETE nào lên
-- bảng này trong toàn bộ mã nguồn.
-- `error_message` giữ NGUYÊN VĂN lỗi nền tảng, nhưng access token đã bị `maskToken()` che TRƯỚC
-- khi tới đây. `request_summary` chỉ là SỐ LIỆU (endpoint, độ dài chữ, số media) — KHÔNG chứa
-- nội dung bài, KHÔNG chứa token.
CREATE TABLE IF NOT EXISTS publish_logs (
  id               TEXT PRIMARY KEY,
  item_id          TEXT NOT NULL,
  attempt          INTEGER NOT NULL DEFAULT 0,
  run_key          TEXT,
  provider         TEXT,
  channel          TEXT,
  status           TEXT,                              -- PublishResult.status
  external_post_id TEXT,
  error_code       TEXT,
  error_message    TEXT,
  is_mock          INTEGER NOT NULL DEFAULT 0,
  request_summary  TEXT,
  created_at       TEXT NOT NULL
);
