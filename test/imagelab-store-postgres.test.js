/**
 * MVP-02 STORE TRÊN POSTGRESQL THẬT.
 *
 * Vì sao cần file này: bộ test imagelab khác luôn chạy SQLite in-memory (`testConfig` ép
 * `DB_DRIVER=sqlite`), nên CI chỉ chứng minh **schema + migration** đúng trên PostgreSQL.
 * Phần **method store** của MVP-02 (`image_assets`, `ocr_regions`, `translation_lines`) trên
 * PostgreSQL trước đây chỉ có tự kiểm thủ công — file này biến nó thành test thường trực.
 *
 * Tự BỎ QUA khi không có `DATABASE_URL` sống (giống `test/store.test.js`), để máy nào không có
 * PostgreSQL vẫn chạy được toàn bộ bộ test.
 *
 * Mọi dữ liệu tạo ra đều được DỌN theo `job_id` ở `finally` — không để rác lại DB dùng chung.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createStore, JOB_STATUS } from '../src/store/index.js';
import { testConfig, silent } from './helpers.js';

const hasPg = Boolean(process.env.DATABASE_URL);
const skipNoPg = hasPg ? false : 'không có DATABASE_URL — bỏ qua (giống test/store.test.js)';

const cfg = () => testConfig({ DB_DRIVER: 'postgres', DATABASE_URL: process.env.DATABASE_URL });

/** Xoá mọi thứ thuộc một job — chạy cả khi test đỏ. */
async function cleanup(store, jobId) {
  for (const sql of [
    'DELETE FROM translation_lines WHERE job_id = ?',
    'DELETE FROM ocr_regions WHERE job_id = ?',
    'DELETE FROM image_assets WHERE job_id = ?',
    'DELETE FROM usage_events WHERE job_id = ?',
    'DELETE FROM extraction_evidence WHERE job_id = ?',
    'DELETE FROM jobs WHERE id = ?',
  ]) {
    await store.driver.run(sql, [jobId]).catch(() => {});
  }
}

describe('MVP-02 store — PostgreSQL thật', () => {
  let store;
  const createdJobs = [];

  before(async () => {
    if (!hasPg) return;
    store = await createStore(cfg(), silent);
    assert.equal(store.dialect, 'postgres');
  });

  after(async () => {
    if (!store) return;
    for (const id of createdJobs) await cleanup(store, id);
    await store.close();
  });

  const newJob = async () => {
    const id = await store.createJob({
      sessionId: 'pg-imagelab',
      source: 'imagelab',
      inputMode: 'upload',
      kind: 'image_translation',
    });
    createdJobs.push(id);
    return id;
  };

  test('schema có đủ 3 bảng MVP-02 + cột jobs.kind', { skip: skipNoPg }, async () => {
    const rows = await store.driver.all(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    );
    const names = rows.map((r) => r.name);
    for (const t of ['image_assets', 'ocr_regions', 'translation_lines']) {
      assert.ok(names.includes(t), `thiếu bảng ${t} trên PostgreSQL`);
    }
    const cols = await store.driver.all(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_name='jobs'",
    );
    assert.ok(cols.map((c) => c.name).includes('kind'), 'thiếu cột jobs.kind trên PostgreSQL');
  });

  test('init() chạy LẦN HAI không lỗi (migration cộng thêm idempotent)', { skip: skipNoPg }, async () => {
    const second = await createStore(cfg(), silent);
    try {
      assert.equal(second.dialect, 'postgres');
    } finally {
      await second.close();
    }
  });

  test('createJob(kind) + getJob/listJobs trả đúng kind trên PostgreSQL', { skip: skipNoPg }, async () => {
    const id = await newJob();
    const job = await store.getJob(id);
    assert.equal(job.kind, 'image_translation');

    const list = await store.listJobs({ sessionId: 'pg-imagelab', limit: 5 });
    const found = list.find((j) => j.id === id);
    assert.ok(found, 'job phải có trong listJobs');
    assert.equal(found.kind, 'image_translation', 'listJobs phải trả kind (dùng cho badge UI)');
  });

  test('8 method MVP-02 chạy đúng và JSON round-trip giống SQLite', { skip: skipNoPg }, async () => {
    const jobId = await newJob();

    // ── image_assets ────────────────────────────────────────────────────────
    const originalId = randomUUID();
    await store.createImageAsset({
      id: originalId,
      jobId,
      sessionId: 'pg-imagelab',
      role: 'original',
      parentId: null,
      mime: 'image/png',
      bytes: 1234,
      width: 320,
      height: 320,
      sha256: 'a'.repeat(64),
      storagePath: `${jobId}/${originalId}.png`,
      source: 'upload',
      meta: { ocr: { is_mock: true }, nested: { list: [1, 2, 3] } },
    });
    const renderedId = randomUUID();
    await store.createImageAsset({
      id: renderedId,
      jobId,
      sessionId: 'pg-imagelab',
      role: 'rendered',
      parentId: originalId,
      mime: 'image/png',
      bytes: 2345,
      width: 320,
      height: 320,
      sha256: 'b'.repeat(64),
      storagePath: `${jobId}/${renderedId}.png`,
      source: 'render',
      meta: { applied: 2, overrides: ['r1'] },
    });

    const got = await store.getImageAsset(originalId);
    assert.equal(got.role, 'original');
    assert.equal(got.width, 320);
    assert.deepEqual(got.meta.nested, { list: [1, 2, 3] }, 'JSON lồng nhau phải round-trip trên PG');

    const rendered = await store.listImageAssets(jobId, { role: 'rendered' });
    assert.equal(rendered.length, 1);
    assert.equal(rendered[0].id, renderedId);
    assert.equal(rendered[0].parent_id, originalId);

    const all = await store.listImageAssets(jobId);
    assert.equal(all.length, 2);

    // ── ocr_regions (idempotent theo job) ───────────────────────────────────
    const regions = [
      {
        id: 'r1',
        box: { x: 10, y: 20, w: 100, h: 30 },
        box_normalized: { x: 0.03, y: 0.06, w: 0.31, h: 0.09 },
        text: '品牌旗舰店',
        lang: 'zh-Hans',
        confidence: 0.91,
        kind: 'brand',
        kind_reason: 'nhãn hiệu',
        translatable: false,
        source: 'ocr',
      },
      {
        id: 'r2',
        box: { x: 10, y: 80, w: 120, h: 30 },
        box_normalized: { x: 0.03, y: 0.25, w: 0.375, h: 0.09 },
        text: '纯棉短袖T恤',
        lang: 'zh-Hans',
        confidence: 0.88,
        kind: 'descriptive',
        kind_reason: 'chữ mô tả',
        translatable: true,
        source: 'ocr',
      },
    ];
    assert.equal(await store.saveOcrRegions(jobId, originalId, regions), 2);
    assert.equal(await store.saveOcrRegions(jobId, originalId, regions), 2, 'gọi lần hai phải ghi đè, không nhân đôi');
    const saved = await store.listOcrRegions(jobId);
    assert.equal(saved.length, 2, 'saveOcrRegions phải IDEMPOTENT theo job');
    const brand = saved.find((r) => r.id === 'r1');
    assert.equal(brand.kind, 'brand');
    assert.equal(brand.translatable, false, 'translatable phải giữ đúng boolean qua PostgreSQL');
    assert.equal(brand.text, '品牌旗舰店');

    // ── translation_lines (idempotent + update theo region_key) ─────────────
    const lines = [
      {
        region_id: 'r1',
        text_original: '品牌旗舰店',
        text_vi: '',
        status: 'SKIPPED_BRAND',
        provenance: 'none',
        confidence: 0.9,
        violations: [],
        notes: 'Vùng nhãn hiệu — không dịch',
        edited_by_user: false,
        edited_at: null,
      },
      {
        region_id: 'r2',
        text_original: '纯棉短袖T恤',
        text_vi: 'Áo thun tay ngắn cotton',
        status: 'TRANSLATED',
        provenance: 'ai',
        confidence: 0.8,
        violations: ['cần duyệt'],
        notes: '',
        edited_by_user: false,
        edited_at: null,
      },
    ];
    assert.equal(await store.saveTranslationLines(jobId, lines), 2);
    assert.equal(await store.saveTranslationLines(jobId, lines), 2, 'ghi lần hai vẫn phải là 2 dòng');
    const savedLines = await store.listTranslationLines(jobId);
    assert.equal(savedLines.length, 2, 'saveTranslationLines phải IDEMPOTENT theo job');
    const r2 = savedLines.find((l) => l.region_id === 'r2');
    assert.deepEqual(r2.violations, ['cần duyệt'], 'mảng JSON phải round-trip trên PG');
    assert.equal(r2.edited_by_user, false);

    // update theo region_key
    const updated = savedLines.map((l) =>
      l.region_id === 'r2'
        ? { ...l, text_vi: 'Áo thun cotton ngắn tay (người dùng sửa)', status: 'USER_EDITED', provenance: 'user', edited_by_user: true, edited_at: new Date().toISOString() }
        : l,
    );
    assert.equal(await store.updateTranslationLines(jobId, updated), 2);
    const afterUpdate = await store.listTranslationLines(jobId);
    const r2b = afterUpdate.find((l) => l.region_id === 'r2');
    assert.equal(r2b.status, 'USER_EDITED');
    assert.equal(r2b.provenance, 'user');
    assert.equal(r2b.edited_by_user, true, 'cờ boolean phải đọc lại đúng trên PostgreSQL');
    assert.equal(afterUpdate.length, 2, 'update KHÔNG được nhân đôi dòng');

    // ── usage_event với 2 operation mới ─────────────────────────────────────
    await store.recordUsage({ jobId, operation: 'OCR_DETECT', provider: 'mock', inputUnits: 102400, outputUnits: 2 });
    await store.recordUsage({ jobId, operation: 'IMAGE_RENDER', provider: 'purejs', inputUnits: 1, outputUnits: 1 });
    const usage = await store.listUsage(jobId);
    assert.deepEqual(usage.map((u) => u.operation).sort(), ['IMAGE_RENDER', 'OCR_DETECT']);
  });

  test('job MVP-02 cập nhật trạng thái awaiting_review được trên PostgreSQL', { skip: skipNoPg }, async () => {
    const id = await newJob();
    await store.updateJob(id, { status: JOB_STATUS.AWAITING_REVIEW, stage: 'awaiting_review' });
    const job = await store.getJob(id);
    assert.equal(job.status, 'awaiting_review');
    assert.equal(job.stage, 'awaiting_review');
    assert.equal(job.finished_at, null, 'job đang chờ duyệt KHÔNG được có finished_at');
  });
});
