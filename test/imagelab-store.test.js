/**
 * TEST MVP-02 · STORE & MIGRATION (C4) — `src/store/**`.
 *
 * Hai điều quan trọng nhất:
 *  1. 8 method mới chạy đúng trên SQLite in-memory, và `saveOcrRegions` /
 *     `saveTranslationLines` IDEMPOTENT THEO JOB (gọi 2 lần không nhân đôi dữ liệu).
 *  2. Migration CỘNG THÊM: DB dựng theo schema MVP-01 CŨ (bảng `jobs` thiếu cột `kind`)
 *     phải nâng cấp được tại chỗ, `init()` chạy 2 lần không lỗi, job cũ vẫn đọc được.
 *
 * Test dùng file DB trong thư mục tạm (`node:os` tmpdir) — không đụng `data/studio.db`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { Store, JOB_KINDS, JOB_STATUS, USAGE_OPERATIONS } from '../src/store/index.js';
import { SqliteDriver } from '../src/store/sqlite-driver.js';
import { silent } from './helpers.js';
import { tmpDir } from './imagelab-helpers.js';

const openStore = async (dbPath = ':memory:') => {
  const store = new Store({ driver: new SqliteDriver({ path: dbPath, logger: silent }), logger: silent });
  await store.init();
  return store;
};

const sampleRegions = () => [
  {
    id: 'r2',
    box: { x: 40, y: 200, w: 260, h: 48 },
    box_normalized: { x: 0.05, y: 0.25, w: 0.325, h: 0.06 },
    text: '纯棉短袖T恤',
    lang: 'zh-Hans',
    confidence: 0.93,
    kind: 'descriptive',
    kind_reason: 'chữ mô tả thông thường',
    translatable: true,
    source: 'ocr',
  },
  {
    id: 'r1',
    box: { x: 40, y: 40, w: 200, h: 40 },
    box_normalized: { x: 0.05, y: 0.05, w: 0.25, h: 0.05 },
    text: '品牌旗舰店',
    lang: 'zh-Hans',
    confidence: 0.97,
    kind: 'brand',
    kind_reason: 'nhãn hiệu',
    translatable: false,
    source: 'ocr',
  },
];

const sampleLines = () => [
  { region_id: 'r1', text_original: '品牌旗舰店', text_vi: '', status: 'SKIPPED_BRAND', provenance: 'none', confidence: 0, violations: [], notes: 'nhãn hiệu', edited_by_user: false, edited_at: null },
  { region_id: 'r2', text_original: '纯棉短袖T恤', text_vi: 'Áo thun cotton', status: 'TRANSLATED', provenance: 'ai', confidence: 0.8, violations: [], notes: '', edited_by_user: false, edited_at: null },
];

describe('MVP-02 store — method mới (SQLite in-memory)', () => {
  test('createJob({kind}) + getJob().kind; mặc định là content', async () => {
    const store = await openStore();
    const contentId = await store.createJob({ sessionId: 's1' });
    const imageId = await store.createJob({ sessionId: 's1', kind: JOB_KINDS.IMAGE_TRANSLATION });

    assert.equal((await store.getJob(contentId)).kind, JOB_KINDS.CONTENT);
    assert.equal((await store.getJob(imageId)).kind, JOB_KINDS.IMAGE_TRANSLATION);
    assert.equal((await store.getJob(imageId)).status, JOB_STATUS.QUEUED);
    assert.ok('AWAITING_REVIEW' in JOB_STATUS && JOB_STATUS.AWAITING_REVIEW === 'awaiting_review');
    await store.close();
  });

  test('createImageAsset / getImageAsset / listImageAssets: round-trip đủ field + lọc role', async () => {
    const store = await openStore();
    const jobId = await store.createJob({ sessionId: 's1', kind: JOB_KINDS.IMAGE_TRANSLATION });
    const originalId = await store.createImageAsset({
      jobId,
      sessionId: 's1',
      role: 'original',
      mime: 'image/png',
      bytes: 1774,
      width: 320,
      height: 320,
      sha256: 'a'.repeat(64),
      storagePath: `${jobId}/${randomUUID()}.png`,
      source: 'upload',
      meta: { filename: 'a.png' },
    });
    const renderedId = await store.createImageAsset({
      jobId,
      sessionId: 's1',
      role: 'rendered',
      parentId: originalId,
      mime: 'image/png',
      bytes: 2400,
      width: 320,
      height: 320,
      sha256: 'b'.repeat(64),
      storagePath: `${jobId}/${randomUUID()}.png`,
      source: 'render',
      meta: { status: 'OK', is_mock: false },
    });

    const original = await store.getImageAsset(originalId);
    assert.equal(original.role, 'original');
    assert.equal(original.parent_id, null);
    assert.equal(original.width, 320);
    assert.equal(original.height, 320);
    assert.equal(original.bytes, 1774);
    assert.equal(original.mime, 'image/png');
    assert.deepEqual(original.meta, { filename: 'a.png' });

    const rendered = await store.getImageAsset(renderedId);
    assert.equal(rendered.parent_id, originalId, 'ảnh render phải trỏ về ảnh gốc');
    assert.equal(rendered.source, 'render');
    assert.equal(rendered.meta.status, 'OK');

    assert.equal((await store.listImageAssets(jobId)).length, 2);
    assert.deepEqual((await store.listImageAssets(jobId, { role: 'rendered' })).map((a) => a.id), [renderedId]);
    assert.equal(await store.getImageAsset(randomUUID()), null);

    await assert.rejects(
      () => store.createImageAsset({ jobId, role: 'role-la', mime: 'image/png' }),
      /role không hợp lệ/,
    );
    await assert.rejects(() => store.createImageAsset({ role: 'original' }), /thiếu jobId/);
    await store.close();
  });

  test('saveOcrRegions IDEMPOTENT theo job: gọi 2 lần không nhân đôi', async () => {
    const store = await openStore();
    const jobId = await store.createJob({ sessionId: 's1', kind: JOB_KINDS.IMAGE_TRANSLATION });
    const assetId = await store.createImageAsset({ jobId, sessionId: 's1', role: 'original', mime: 'image/png' });

    assert.equal(await store.saveOcrRegions(jobId, assetId, sampleRegions()), 2);
    assert.equal(await store.saveOcrRegions(jobId, assetId, sampleRegions()), 2);

    const regions = await store.listOcrRegions(jobId);
    assert.equal(regions.length, 2, 'gọi lưu 2 lần KHÔNG được sinh vùng trùng');

    // Trả về theo thứ tự đọc trên→dưới
    assert.deepEqual(regions.map((r) => r.id), ['r1', 'r2']);
    const brand = regions.find((r) => r.id === 'r1');
    assert.equal(brand.kind, 'brand');
    assert.equal(brand.translatable, false, 'translatable phải là boolean thật, không phải 0/1');
    assert.equal(brand.text, '品牌旗舰店');
    assert.equal(brand.box.x, 40);
    assert.equal(brand.region_key, 'r1');
    assert.equal(brand.asset_id, assetId);

    const desc = regions.find((r) => r.id === 'r2');
    assert.equal(desc.translatable, true);
    assert.equal(desc.confidence, 0.93);

    // Job khác không bị ảnh hưởng
    assert.deepEqual(await store.listOcrRegions(randomUUID()), []);
    await store.close();
  });

  test('saveTranslationLines IDEMPOTENT + listTranslationLines theo thứ tự vùng OCR', async () => {
    const store = await openStore();
    const jobId = await store.createJob({ sessionId: 's1', kind: JOB_KINDS.IMAGE_TRANSLATION });
    const assetId = await store.createImageAsset({ jobId, sessionId: 's1', role: 'original', mime: 'image/png' });
    await store.saveOcrRegions(jobId, assetId, sampleRegions());

    assert.equal(await store.saveTranslationLines(jobId, sampleLines()), 2);
    assert.equal(await store.saveTranslationLines(jobId, sampleLines()), 2);

    const lines = await store.listTranslationLines(jobId);
    assert.equal(lines.length, 2, 'gọi lưu 2 lần KHÔNG được sinh dòng trùng');
    assert.deepEqual(lines.map((l) => l.region_id), ['r1', 'r2'], 'phải xếp theo thứ tự đọc của vùng');
    for (const line of lines) {
      assert.deepEqual(Object.keys(line).sort(), [
        'confidence', 'edited_at', 'edited_by_user', 'notes', 'provenance', 'region_id', 'status', 'text_original', 'text_vi', 'violations',
      ]);
    }
    assert.equal(lines[0].status, 'SKIPPED_BRAND');
    assert.equal(lines[1].text_vi, 'Áo thun cotton');
    assert.equal(lines[1].edited_by_user, false);
    await store.close();
  });

  test('updateTranslationLines: cập nhật theo region_key trong ĐÚNG job', async () => {
    const store = await openStore();
    const jobA = await store.createJob({ sessionId: 'a', kind: JOB_KINDS.IMAGE_TRANSLATION });
    const jobB = await store.createJob({ sessionId: 'b', kind: JOB_KINDS.IMAGE_TRANSLATION });
    for (const jobId of [jobA, jobB]) {
      const assetId = await store.createImageAsset({ jobId, sessionId: 'x', role: 'original', mime: 'image/png' });
      await store.saveOcrRegions(jobId, assetId, sampleRegions());
      await store.saveTranslationLines(jobId, sampleLines());
    }

    const ts = new Date().toISOString();
    const changed = await store.updateTranslationLines(jobA, [
      { region_id: 'r2', text_vi: 'Áo thun cotton cao cấp', status: 'USER_EDITED', provenance: 'user', edited_by_user: true, edited_at: ts },
      { region_id: 'khong-co', text_vi: 'x' },
    ]);
    assert.equal(changed, 1);

    const a = await store.listTranslationLines(jobA);
    const r2 = a.find((l) => l.region_id === 'r2');
    assert.equal(r2.text_vi, 'Áo thun cotton cao cấp');
    assert.equal(r2.status, 'USER_EDITED');
    assert.equal(r2.provenance, 'user');
    assert.equal(r2.edited_by_user, true);
    assert.equal(r2.edited_at, ts);

    const b = await store.listTranslationLines(jobB);
    assert.equal(b.find((l) => l.region_id === 'r2').text_vi, 'Áo thun cotton', 'job khác KHÔNG được sửa');
    await store.close();
  });

  test('usage_events nhận OCR_DETECT và IMAGE_RENDER; tổng hợp đúng', async () => {
    const store = await openStore();
    assert.ok(USAGE_OPERATIONS.includes('OCR_DETECT'));
    assert.ok(USAGE_OPERATIONS.includes('IMAGE_RENDER'));
    // 5 operation cũ vẫn còn
    for (const op of ['SOURCE_EXTRACT', 'VISION_ANALYSIS', 'TRANSLATION', 'CONTENT_GENERATE', 'CONTENT_REPAIR']) {
      assert.ok(USAGE_OPERATIONS.includes(op), `mất operation cũ ${op}`);
    }

    const jobId = await store.createJob({ sessionId: 's1', kind: JOB_KINDS.IMAGE_TRANSLATION });
    await store.recordUsage({ jobId, sessionId: 's1', operation: 'OCR_DETECT', provider: 'mock', model: 'mock-ocr-v1', inputUnits: 102400, outputUnits: 4, estimatedCost: 0.0004 });
    await store.recordUsage({ jobId, sessionId: 's1', operation: 'IMAGE_RENDER', provider: 'purejs', model: 'purejs/png+font5x7', inputUnits: 2, outputUnits: 2, estimatedCost: 0.0015 });

    const events = await store.listUsage(jobId);
    assert.deepEqual(events.map((e) => e.operation), ['OCR_DETECT', 'IMAGE_RENDER']);
    assert.equal(events[0].input_units, 102400);
    assert.equal(events[0].output_units, 4);

    const summary = await store.usageSummary(jobId);
    assert.equal(summary.events, 2);
    assert.equal(summary.input_units, 102402);
    assert.equal(summary.output_units, 6);
    assert.ok(Math.abs(summary.estimated_cost - 0.0019) < 1e-9);
    await store.close();
  });

  test('init() chạy 2 lần trên DB mới cũng không lỗi (idempotent)', async () => {
    const store = await openStore();
    await store.init();
    await store.init();
    const tables = (await store.driver.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map((r) => r.name);
    for (const t of ['jobs', 'usage_events', 'uploads', 'extraction_evidence', 'image_assets', 'ocr_regions', 'translation_lines']) {
      assert.ok(tables.includes(t), `thiếu bảng ${t}`);
    }
    await store.close();
  });
});

describe('MVP-02 store — migration DB MVP-01 CŨ (thiếu cột jobs.kind)', () => {
  const OLD_JOB_ID = '11111111-2222-3333-4444-555555555555';

  test('init() 2 lần trên DB cũ: thêm cột kind, giữ nguyên job cũ, job cũ đọc được', async () => {
    const dbPath = path.join(tmpDir(), 'studio-mvp01-old.db');

    // (1) Dựng DB theo schema MVP-01 CŨ: có bảng jobs nhưng KHÔNG có cột kind.
    const first = new Store({ driver: new SqliteDriver({ path: dbPath, logger: silent }), logger: silent });
    await first.init();
    await first.driver.run('ALTER TABLE jobs DROP COLUMN kind');
    const before = (await first.driver.all('PRAGMA table_info(jobs)')).map((c) => c.name);
    assert.ok(!before.includes('kind'), 'bước chuẩn bị phải tạo được DB cũ thiếu cột kind');

    const ts = new Date().toISOString();
    await first.driver.run(
      `INSERT INTO jobs (id, session_id, source, source_url, product_name, status, stage, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [OLD_JOB_ID, 'session-cu-0001', '1688', 'https://detail.1688.com/offer/1.html', 'Sản phẩm cũ MVP-01', 'succeeded', 'done', ts, ts],
    );
    await first.driver.run(
      "INSERT INTO usage_events (id, job_id, session_id, operation, estimated_cost, currency, created_at) VALUES (?,?,?,?,?,?,?)",
      [randomUUID(), OLD_JOB_ID, 'session-cu-0001', 'SOURCE_EXTRACT', 0.0005, 'USD', ts],
    );
    await first.close();

    // (2) Mở lại bằng Store hiện tại và chạy init() HAI LẦN liên tiếp.
    const store = new Store({ driver: new SqliteDriver({ path: dbPath, logger: silent }), logger: silent });
    await store.init();
    await store.init(); // lần 2 KHÔNG được lỗi (ALTER chỉ chạy khi thiếu cột)

    const cols = (await store.driver.all('PRAGMA table_info(jobs)')).map((c) => c.name);
    assert.ok(cols.includes('kind'), 'sau migration phải có cột jobs.kind');

    const oldJob = await store.getJob(OLD_JOB_ID);
    assert.ok(oldJob, 'job cũ phải đọc được sau migration');
    assert.equal(oldJob.kind, 'content', 'job cũ mặc định là content');
    assert.equal(oldJob.status, JOB_STATUS.SUCCEEDED);
    assert.equal(oldJob.product_name, 'Sản phẩm cũ MVP-01');
    assert.equal((await store.listUsage(OLD_JOB_ID)).length, 1, 'dữ liệu usage cũ phải còn');

    const listed = await store.listJobs({ sessionId: 'session-cu-0001' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, OLD_JOB_ID);

    // Bảng MVP-02 được tạo thêm trên DB cũ, và job mới vẫn ghi được kind.
    const newId = await store.createJob({ sessionId: 'session-moi-0002', kind: JOB_KINDS.IMAGE_TRANSLATION });
    assert.equal((await store.getJob(newId)).kind, JOB_KINDS.IMAGE_TRANSLATION);
    const tables = (await store.driver.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map((r) => r.name);
    for (const t of ['image_assets', 'ocr_regions', 'translation_lines']) assert.ok(tables.includes(t), `thiếu bảng ${t}`);
    await store.close();
  });
});
