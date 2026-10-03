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
