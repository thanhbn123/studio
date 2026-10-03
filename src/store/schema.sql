-- ============================================================================
-- VIP PRODUCT STUDIO — schema MVP-01
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
