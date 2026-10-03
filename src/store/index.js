/**
 * Store — lớp repository dùng chung cho cả SQLite và PostgreSQL.
 *
 * Mọi truy cập DB đi qua đây. Tầng trên (routes, jobs) không biết mình đang chạy
 * trên driver nào, nên chuyển từ SQLite sang PostgreSQL chỉ là đổi `DB_DRIVER`.
 *
 * MVP-02 bổ sung phần ImageLab (image_assets / ocr_regions / translation_lines) và
 * cột `jobs.kind`. Toàn bộ phần cũ giữ nguyên hành vi.
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
  // MVP-02: job ImageLab đã OCR + dịch xong, đang chờ người dùng duyệt từng dòng.
  AWAITING_REVIEW: 'awaiting_review',
});

export const USAGE_OPERATIONS = Object.freeze([
  'SOURCE_EXTRACT',
  'VISION_ANALYSIS',
  'TRANSLATION',
  'CONTENT_GENERATE',
  'CONTENT_REPAIR',
  // MVP-02
  'OCR_DETECT',
  'IMAGE_RENDER',
]);

/** Loại job: MVP-01 sinh nội dung, MVP-02 dịch chữ trên ảnh. */
export const JOB_KINDS = Object.freeze({
  CONTENT: 'content',
  IMAGE_TRANSLATION: 'image_translation',
});

export const IMAGE_ASSET_ROLES = Object.freeze(['original', 'rendered']);

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

/**
 * Số hữu hạn ĐỌC TỪ DB, hoặc `fallback`.
 *
 * ⚠️ N-1 (vòng 5): KHÔNG dùng `Number(value)` trực tiếp. `Number('  ') === 0`,
 * `Number('\t') === 0`, `Number('0x10') === 16`, `Number([]) === 0` — nên toạ độ
 * rác trong DB bị biến thành SỐ ngay ở tầng đọc, và tầng `geometry.strictCoordinate`
 * phía sau không bao giờ nhìn thấy "rác" để mà chặn (hộp bảo vệ "ảo" ở x=0 ⇒ pixel
 * nhãn hiệu bị xoá thật trong khi `skipped` vẫn báo "không xoá").
 *
 * Luật (giống hệt `strictCoordinate` của `src/imagelab/geometry.js`):
 *   - `number` hữu hạn ⇒ nhận;
 *   - CHUỖI đã `trim()` khác rỗng và đúng dạng số THẬP PHÂN ⇒ nhận;
 *   - mọi thứ khác (null/undefined/''/'  '/hex/NaN/±Infinity/boolean/mảng/object) ⇒ `fallback`.
 */
const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function toNum(value, fallback = null) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || !DECIMAL_RE.test(trimmed)) return fallback;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** Số nguyên, hoặc null — dùng cho toạ độ pixel. */
function toIntOrNull(value) {
  const n = toNum(value, null);
  return n === null ? null : Math.trunc(n);
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
    await this.#applyAdditiveMigrations();
    this.logger?.info('store.initialized', { dialect: this.dialect });
    return this;
  }

  /**
   * Migration CỘNG THÊM (additive) — bắt buộc IDEMPOTENT.
   *
   * `data/studio.db` của MVP-01 đã có bảng `jobs` từ trước, nên `CREATE TABLE IF NOT
   * EXISTS` trong schema KHÔNG thể thêm cột `kind` cho nó. Phải ALTER tại chỗ:
   *   - SQLite: đọc `PRAGMA table_info(jobs)`, thiếu `kind` thì mới ALTER (SQLite không
   *     có `ADD COLUMN IF NOT EXISTS`).
   *   - PostgreSQL: `ADD COLUMN IF NOT EXISTS` tự idempotent.
   * Nhờ vậy `init()` chạy hai lần liên tiếp không lỗi, và DB cũ nâng cấp được tại chỗ.
   */
  async #applyAdditiveMigrations() {
    if (this.isPostgres) {
      await this.driver.run("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'content'");
      return;
    }
    const info = await this.driver.all('PRAGMA table_info(jobs)');
    // Bảng chưa tồn tại (schema lỗi?) thì không ALTER — tránh lỗi khó hiểu.
    if (!Array.isArray(info) || info.length === 0) return;
    if (info.some((col) => col?.name === 'kind')) return;
    await this.driver.run("ALTER TABLE jobs ADD COLUMN kind TEXT DEFAULT 'content'");
    this.logger?.info('store.migration.column_added', { table: 'jobs', column: 'kind', dialect: this.dialect });
  }

  async close() {
    await this.driver.close();
  }

  /* ───────────────────────────── Jobs ───────────────────────────── */

  async createJob({ id = randomUUID(), sessionId = '', source = '', sourceUrl = '', canonicalUrl = '', sourceProductId = '', style = '', length = '', inputMode = 'link', kind = JOB_KINDS.CONTENT } = {}) {
    const ts = nowIso();
    const jobKind = String(kind || JOB_KINDS.CONTENT);
    await this.driver.run(
      `INSERT INTO jobs (id, session_id, source, source_url, canonical_url, source_product_id,
        product_name, status, stage, style, length, input_mode, kind, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, sessionId, source, sourceUrl, canonicalUrl, sourceProductId, '', JOB_STATUS.QUEUED, 'queued', style, length, inputMode, jobKind, ts, ts],
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
      kind: null,
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
      // DB cũ (trước migration) có thể chưa có cột này → coi như job nội dung.
      kind: row.kind || JOB_KINDS.CONTENT,
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
          `SELECT id, session_id, kind, source, source_url, product_name, status, stage, style, length, content_meta, created_at, updated_at
           FROM jobs WHERE session_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [sessionId, lim, off],
        )
      : await this.driver.all(
          `SELECT id, session_id, kind, source, source_url, product_name, status, stage, style, length, content_meta, created_at, updated_at
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

  /* ═══════════════════════ MVP-02 — ImageLab (C4) ═══════════════════════ */

  /* ─────────────────────────── image_assets ─────────────────────────── */

  /**
   * Ghi một `ImageAsset` (ảnh gốc hoặc ảnh đã render). Trả về id.
   * `role` bắt buộc thuộc {original, rendered} — fail-closed, không nhận giá trị lạ.
   */
  async createImageAsset({
    id = randomUUID(),
    jobId = null,
    sessionId = '',
    role,
    parentId = null,
    mime = '',
    bytes = 0,
    width = null,
    height = null,
    sha256 = '',
    storagePath = '',
    source = 'upload',
    meta = null,
  } = {}) {
    if (!IMAGE_ASSET_ROLES.includes(role)) {
      throw new Error(`image_assets.role không hợp lệ: ${JSON.stringify(String(role ?? ''))} (chỉ nhận original|rendered).`);
    }
    if (!jobId) throw new Error('createImageAsset thiếu jobId.');
    await this.driver.run(
      `INSERT INTO image_assets (id, job_id, session_id, role, parent_id, mime, bytes, width, height,
        sha256, storage_path, source, meta, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, jobId, sessionId, role, parentId, mime, toNum(bytes, 0), toIntOrNull(width), toIntOrNull(height),
        sha256, storagePath, source, toJson(meta), nowIso(),
      ],
    );
    return id;
  }

  #hydrateImageAsset(row) {
    return {
      id: row.id,
      job_id: row.job_id,
      session_id: row.session_id,
      role: row.role,
      parent_id: row.parent_id ?? null,
      mime: row.mime || '',
      bytes: toNum(row.bytes, 0),
      width: toNum(row.width, null),
      height: toNum(row.height, null),
      sha256: row.sha256 || '',
      storage_path: row.storage_path || '',
      source: row.source || '',
      meta: fromJson(row.meta),
      created_at: row.created_at,
    };
  }

  async getImageAsset(id) {
    const row = await this.driver.get('SELECT * FROM image_assets WHERE id = ?', [id]);
    return row ? this.#hydrateImageAsset(row) : null;
  }

  async listImageAssets(jobId, { role } = {}) {
    const rows = role
      ? await this.driver.all('SELECT * FROM image_assets WHERE job_id = ? AND role = ? ORDER BY created_at ASC, id ASC', [jobId, role])
      : await this.driver.all('SELECT * FROM image_assets WHERE job_id = ? ORDER BY created_at ASC, id ASC', [jobId]);
    return rows.map((r) => this.#hydrateImageAsset(r));
  }

  /**
   * Cập nhật `meta` của một ImageAsset (merge nông, giữ khoá cũ).
   * Dùng để ghi vết OCR (vùng bị bỏ, cảnh báo) lên ảnh gốc sau khi `runOcr` xong —
   * C5 đọc `asset.meta.ocr` để hiện "vùng bị bỏ kèm lý do" mà không phải bịa.
   */
  async updateImageAssetMeta(id, meta = {}) {
    const row = await this.driver.get('SELECT meta FROM image_assets WHERE id = ?', [id]);
    if (!row) return 0;
    const merged = { ...(fromJson(row.meta) || {}), ...(meta && typeof meta === 'object' ? meta : {}) };
    const res = await this.driver.run('UPDATE image_assets SET meta = ? WHERE id = ?', [toJson(merged), id]);
    return Number(res?.changes ?? 0);
  }

  /* ─────────────────────────── ocr_regions ─────────────────────────── */

  /**
   * Lưu vùng OCR — IDEMPOTENT THEO JOB: xoá hết vùng cũ của job rồi ghi lại.
   * Nhờ vậy gọi lại `runOcr` (retry) không sinh vùng trùng.
   */
  async saveOcrRegions(jobId, assetId, regions = []) {
    const list = Array.isArray(regions) ? regions : [];
    const ts = nowIso();
    return this.driver.transaction(async (tx) => {
      await tx.run('DELETE FROM ocr_regions WHERE job_id = ?', [jobId]);
      let saved = 0;
      for (let i = 0; i < list.length; i += 1) {
        const r = list[i] || {};
        // `id` trong DB là khoá kỹ thuật duy nhất toàn cục; id vùng theo hợp đồng
        // ('r1'…) nằm ở `region_key` — vì 'r1' của hai job khác nhau sẽ đụng PRIMARY KEY.
        const key = String(r.id ?? r.region_key ?? `r${i + 1}`);
        const box = r.box || {};
        const norm = r.box_normalized || {};
        await tx.run(
          `INSERT INTO ocr_regions (id, job_id, asset_id, region_key, x, y, w, h,
            x_norm, y_norm, w_norm, h_norm, text_original, lang, confidence, kind, kind_reason,
            translatable, source, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            randomUUID(), jobId, assetId, key,
            toIntOrNull(box.x), toIntOrNull(box.y), toIntOrNull(box.w), toIntOrNull(box.h),
            toNum(norm.x, null), toNum(norm.y, null), toNum(norm.w, null), toNum(norm.h, null),
            String(r.text ?? r.text_original ?? ''), r.lang || 'und', toNum(r.confidence, 0),
            r.kind || 'unknown', r.kind_reason || '',
            // Fail-closed: chỉ nhận translatable khi C1 khai ĐÚNG `true`.
            (r.translatable === true ? 1 : 0),
            r.source || 'ocr', ts,
          ],
        );
        saved += 1;
      }
      return saved;
    });
  }

  /** Trả về `Region` (hợp đồng 3.2) + `asset_id` + `region_key`, theo thứ tự đọc trên→dưới. */
  async listOcrRegions(jobId) {
    const rows = await this.driver.all(
      'SELECT * FROM ocr_regions WHERE job_id = ? ORDER BY y ASC, x ASC',
      [jobId],
    );
    return rows.map((row) => ({
      id: row.region_key || row.id,
      asset_id: row.asset_id,
      region_key: row.region_key || row.id,
      box: {
        x: toNum(row.x, null),
        y: toNum(row.y, null),
        w: toNum(row.w, null),
        h: toNum(row.h, null),
      },
      box_normalized: {
        x: toNum(row.x_norm, null),
        y: toNum(row.y_norm, null),
        w: toNum(row.w_norm, null),
        h: toNum(row.h_norm, null),
      },
      text: row.text_original || '',
      // Bí danh cột DB (C5 và tools/imagelab-demo.mjs đều đọc `text ?? text_original`).
      text_original: row.text_original || '',
      lang: row.lang || 'und',
      confidence: toNum(row.confidence, 0),
      kind: row.kind || 'unknown',
      kind_reason: row.kind_reason || '',
      translatable: Boolean(row.translatable),
      source: row.source || 'ocr',
    }));
  }

  /* ───────────────────────── translation_lines ───────────────────────── */

  /** Lưu bản dịch — IDEMPOTENT THEO JOB: xoá dòng cũ của job rồi ghi lại. */
  async saveTranslationLines(jobId, lines = []) {
    const list = Array.isArray(lines) ? lines : [];
    const ts = nowIso();
    return this.driver.transaction(async (tx) => {
      await tx.run('DELETE FROM translation_lines WHERE job_id = ?', [jobId]);
      let saved = 0;
      for (const line of list) {
        const l = line || {};
        const key = String(l.region_id ?? l.region_key ?? '');
        if (!key) continue; // dòng không có khoá vùng là dòng hỏng — không ghi
        await tx.run(
          `INSERT INTO translation_lines (id, job_id, region_key, text_original, text_vi,
            status, provenance, confidence, violations, notes, edited_by_user, edited_at,
            created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            randomUUID(), jobId, key,
            String(l.text_original ?? ''), String(l.text_vi ?? ''),
            l.status || 'NEEDS_REVIEW', l.provenance || 'none', toNum(l.confidence, 0),
            toJson(Array.isArray(l.violations) ? l.violations : []), String(l.notes ?? ''),
            l.edited_by_user ? 1 : 0, l.edited_at ?? null, ts, ts,
          ],
        );
        saved += 1;
      }
      return saved;
    });
  }

  /** Trả về `TranslatedLine` (hợp đồng 3.3), xếp theo thứ tự đọc của vùng OCR. */
  async listTranslationLines(jobId) {
    const rows = await this.driver.all(
      `SELECT tl.* FROM translation_lines tl
       LEFT JOIN ocr_regions r ON r.job_id = tl.job_id AND r.region_key = tl.region_key
       WHERE tl.job_id = ?
       ORDER BY r.y ASC, r.x ASC, tl.created_at ASC`,
      [jobId],
    );
    return rows.map((row) => ({
      region_id: row.region_key,
      text_original: row.text_original || '',
      text_vi: row.text_vi || '',
      status: row.status || '',
      provenance: row.provenance || 'none',
      confidence: toNum(row.confidence, 0),
      violations: fromJson(row.violations) || [],
      edited_by_user: Boolean(row.edited_by_user),
      edited_at: row.edited_at ?? null,
      notes: row.notes || '',
    }));
  }

  /**
   * Cập nhật tại chỗ các dòng đã có, khoá theo `region_key` trong phạm vi job.
   * Chỉ nhận cột trong allowlist; trả về số dòng đã cập nhật.
   */
  async updateTranslationLines(jobId, lines = []) {
    const list = Array.isArray(lines) ? lines : [];
    const ts = nowIso();
    return this.driver.transaction(async (tx) => {
      let changed = 0;
      for (const line of list) {
        const l = line || {};
        const key = String(l.region_id ?? l.region_key ?? '');
        if (!key) continue;
        const sets = [];
        const params = [];
        if ('text_vi' in l) {
          sets.push('text_vi = ?');
          params.push(String(l.text_vi ?? ''));
        }
        if ('status' in l) {
          sets.push('status = ?');
          params.push(l.status || 'NEEDS_REVIEW');
        }
        if ('provenance' in l) {
          sets.push('provenance = ?');
          params.push(l.provenance || 'none');
        }
        if ('confidence' in l) {
          sets.push('confidence = ?');
          params.push(toNum(l.confidence, 0));
        }
        if ('violations' in l) {
          sets.push('violations = ?');
          params.push(toJson(Array.isArray(l.violations) ? l.violations : []));
        }
        if ('notes' in l) {
          sets.push('notes = ?');
          params.push(String(l.notes ?? ''));
        }
        if ('edited_by_user' in l) {
          sets.push('edited_by_user = ?');
          params.push(l.edited_by_user ? 1 : 0);
        }
        if ('edited_at' in l) {
          sets.push('edited_at = ?');
          params.push(l.edited_at ?? null);
        }
        sets.push('updated_at = ?');
        params.push(ts);
        params.push(jobId, key);
        const res = await tx.run(
          `UPDATE translation_lines SET ${sets.join(', ')} WHERE job_id = ? AND region_key = ?`,
          params,
        );
        changed += Number(res?.changes ?? 0);
      }
      return changed;
    });
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
