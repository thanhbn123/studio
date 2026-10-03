/**
 * Store — lớp repository dùng chung cho cả SQLite và PostgreSQL.
 *
 * Mọi truy cập DB đi qua đây. Tầng trên (routes, jobs) không biết mình đang chạy
 * trên driver nào, nên chuyển từ SQLite sang PostgreSQL chỉ là đổi `DB_DRIVER`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { SqliteDriver } from './sqlite-driver.js';
import { PostgresDriver } from './postgres-driver.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = path.join(HERE, 'schema.sql');

export const JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  NEEDS_MANUAL: 'needs_manual',
});

export const USAGE_OPERATIONS = Object.freeze([
  'SOURCE_EXTRACT',
  'VISION_ANALYSIS',
  'TRANSLATION',
  'CONTENT_GENERATE',
  'CONTENT_REPAIR',
]);

export const VERIFICATION_LEVELS = Object.freeze([
  'MOCK_VERIFIED',
  'MANUAL_INPUT',
  'LIVE_VERIFIED',
  'AUTHENTICATED_LIVE_VERIFIED',
  'BLOCKED',
  'UNSUPPORTED',
]);

const nowIso = () => new Date().toISOString();

function toJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function fromJson(text) {
  if (text === null || text === undefined || text === '') return null;
  if (typeof text === 'object') return text; // PostgreSQL jsonb trả về object sẵn
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function createDriver(config, logger) {
  const driver = String(config?.db?.driver || 'sqlite').toLowerCase();
  if (driver === 'postgres' || driver === 'postgresql') {
    return new PostgresDriver({
      url: config?.db?.url,
      sslMode: config?.db?.sslMode,
      poolMax: config?.db?.poolMax,
      logger,
    });
  }
  return new SqliteDriver({ path: config?.db?.sqlitePath, logger });
}

export class Store {
  constructor({ driver, logger } = {}) {
    this.driver = driver;
    this.logger = logger;
    this.dialect = driver?.dialect || 'sqlite';
  }

  get isPostgres() {
    return this.dialect === 'postgres';
  }

  async init() {
    await this.driver.connect();
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    // PostgreSQL không hỗ trợ "PRAGMA"; schema không chứa PRAGMA nên chạy thẳng được.
    if (this.isPostgres) {
      await this.driver.exec(schema);
    } else {
      await this.driver.exec(schema);
    }
    this.logger?.info('store.initialized', { dialect: this.dialect });
    return this;
  }

  async close() {
    await this.driver.close();
  }

  /* ───────────────────────────── Jobs ───────────────────────────── */

  async createJob({ id = randomUUID(), sessionId = '', source = '', sourceUrl = '', canonicalUrl = '', sourceProductId = '', style = '', length = '', inputMode = 'link' } = {}) {
    const ts = nowIso();
    await this.driver.run(
      `INSERT INTO jobs (id, session_id, source, source_url, canonical_url, source_product_id,
        product_name, status, stage, style, length, input_mode, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, sessionId, source, sourceUrl, canonicalUrl, sourceProductId, '', JOB_STATUS.QUEUED, 'queued', style, length, inputMode, ts, ts],
    );
    return id;
  }

  /** Cập nhật job. Chỉ nhận các cột nằm trong allowlist — không nội suy tên cột từ input. */
  async updateJob(id, patch = {}) {
    const COLUMNS = {
      status: null,
      stage: null,
      error_code: null,
      error_message: null,
      product_name: null,
      source: null,
      canonical_url: null,
      source_product_id: null,
      product_master: toJson,
      vision: toJson,
      knowledge: toJson,
      content: toJson,
      evidence: toJson,
      content_meta: toJson,
      finished_at: null,
      style: null,
      length: null,
    };
    const sets = [];
    const params = [];
    for (const [col, transform] of Object.entries(COLUMNS)) {
      if (!(col in patch)) continue;
      sets.push(`${col} = ?`);
      params.push(transform ? transform(patch[col]) : patch[col]);
    }
    if (sets.length === 0) return 0;
    sets.push('updated_at = ?');
    params.push(nowIso());
    params.push(id);
    const res = await this.driver.run(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, params);
    return res.changes;
  }

  async getJob(id) {
    const row = await this.driver.get('SELECT * FROM jobs WHERE id = ?', [id]);
    return row ? this.#hydrateJob(row) : null;
  }

  #hydrateJob(row) {
    return {
      id: row.id,
      session_id: row.session_id,
      source: row.source,
      source_url: row.source_url,
      canonical_url: row.canonical_url,
      source_product_id: row.source_product_id,
      product_name: row.product_name,
      status: row.status,
      stage: row.stage,
      error_code: row.error_code,
      error_message: row.error_message,
      style: row.style,
      length: row.length,
      input_mode: row.input_mode,
      product_master: fromJson(row.product_master),
      vision: fromJson(row.vision),
      knowledge: fromJson(row.knowledge),
      content: fromJson(row.content),
      evidence: fromJson(row.evidence),
      content_meta: fromJson(row.content_meta),
      created_at: row.created_at,
      updated_at: row.updated_at,
      finished_at: row.finished_at,
    };
  }

  async listJobs({ sessionId = null, limit = 50, offset = 0 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const off = Math.max(Number(offset) || 0, 0);
    const rows = sessionId
      ? await this.driver.all(
          `SELECT id, session_id, source, source_url, product_name, status, stage, style, length, created_at, updated_at
           FROM jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [sessionId, lim, off],
        )
      : await this.driver.all(
          `SELECT id, session_id, source, source_url, product_name, status, stage, style, length, created_at, updated_at
           FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [lim, off],
        );
    return rows;
  }

  async countJobs({ sessionId = null } = {}) {
    const row = sessionId
      ? await this.driver.get('SELECT COUNT(*) AS n FROM jobs WHERE session_id = ?', [sessionId])
      : await this.driver.get('SELECT COUNT(*) AS n FROM jobs');
    return Number(row?.n ?? 0);
  }

  /* ─────────────────────── Usage / billing (G13) ─────────────────────── */

  async recordUsage({
    id = randomUUID(),
    jobId = null,
    sessionId = '',
    operation,
    provider = '',
    model = '',
    inputUnits = 0,
    outputUnits = 0,
    estimatedCost = 0,
    currency = 'USD',
    meta = null,
  }) {
    await this.driver.run(
      `INSERT INTO usage_events (id, job_id, session_id, operation, provider, model,
        input_units, output_units, estimated_cost, currency, meta, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, jobId, sessionId, operation, provider, model, inputUnits, outputUnits, estimatedCost, currency, toJson(meta), nowIso()],
    );
    return id;
  }

  async listUsage(jobId) {
    return this.driver.all('SELECT * FROM usage_events WHERE job_id = ? ORDER BY created_at ASC', [jobId]);
  }

  /** Tổng hợp chi phí theo job — nền tảng cho credit-based billing sau này. */
  async usageSummary(jobId) {
    const row = await this.driver.get(
      `SELECT COUNT(*) AS events, COALESCE(SUM(estimated_cost),0) AS cost,
              COALESCE(SUM(input_units),0) AS input_units, COALESCE(SUM(output_units),0) AS output_units
       FROM usage_events WHERE job_id = ?`,
      [jobId],
    );
    return {
      events: Number(row?.events ?? 0),
      estimated_cost: Number(row?.cost ?? 0),
      input_units: Number(row?.input_units ?? 0),
      output_units: Number(row?.output_units ?? 0),
    };
  }

  /* ────────────────────── Extraction evidence (G14) ────────────────────── */

  async recordEvidence({
    id = randomUUID(),
    jobId = null,
    connector = '',
    extractionMethod = '',
    verification = 'BLOCKED',
    httpStatus = null,
    bytes = 0,
    loginRequired = false,
    blockedReason = '',
    foundFields = [],
    missingFields = [],
    visionProvider = '',
    contentProvider = '',
  }) {
    await this.driver.run(
      `INSERT INTO extraction_evidence (id, job_id, connector, extraction_method, verification,
        http_status, bytes, login_required, blocked_reason, found_fields, missing_fields,
        vision_provider, content_provider, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, jobId, connector, extractionMethod, verification, httpStatus, bytes,
        loginRequired ? 1 : 0, blockedReason, toJson(foundFields), toJson(missingFields),
        visionProvider, contentProvider, nowIso(),
      ],
    );
    return id;
  }

  async getEvidence(jobId) {
    const rows = await this.driver.all(
      'SELECT * FROM extraction_evidence WHERE job_id = ? ORDER BY created_at DESC LIMIT 5',
      [jobId],
    );
    return rows.map((r) => ({
      ...r,
      login_required: Boolean(r.login_required),
      found_fields: fromJson(r.found_fields) || [],
      missing_fields: fromJson(r.missing_fields) || [],
    }));
  }

  /* ─────────────────────────── Uploads (G11) ─────────────────────────── */

  async recordUpload({ id = randomUUID(), jobId = null, sessionId = '', filename = '', mime = '', bytes = 0, source = 'manual' }) {
    await this.driver.run(
      `INSERT INTO uploads (id, job_id, session_id, filename, mime, bytes, source, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, jobId, sessionId, filename, mime, bytes, source, nowIso()],
    );
    return id;
  }

  async listUploads(jobId) {
    return this.driver.all('SELECT * FROM uploads WHERE job_id = ? ORDER BY created_at ASC', [jobId]);
  }
}

/** Tạo + khởi tạo store theo cấu hình. */
export async function createStore(config, logger) {
  const driver = createDriver(config, logger);
  const store = new Store({ driver, logger });
  await store.init();
  return store;
}

export default createStore;
