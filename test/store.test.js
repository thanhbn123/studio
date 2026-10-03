/**
 * TEST STORE — SQLite và PostgreSQL dùng CÙNG một schema.
 *
 * Đây là bằng chứng cho yêu cầu "PostgreSQL-ready": không phải lời tuyên bố, mà là
 * cùng file `schema.sql` chạy được trên cả hai engine, và repository cho kết quả
 * giống nhau.
 *
 * Test PostgreSQL tự BỎ QUA nếu không có `DATABASE_URL` sống — để CI không phụ thuộc
 * vào việc máy lập trình viên có sẵn PostgreSQL hay không.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SqliteDriver } from '../src/store/sqlite-driver.js';
import { PostgresDriver } from '../src/store/postgres-driver.js';
import { Store, JOB_STATUS, createStore } from '../src/store/index.js';
import { testConfig, silent } from './helpers.js';

const makeSqliteStore = async () => {
  const store = new Store({ driver: new SqliteDriver({ path: ':memory:', logger: silent }), logger: silent });
  await store.init();
  return store;
};

const hasPg = Boolean(process.env.DATABASE_URL);

describe('Store — SQLite', () => {
  test('tạo đủ 4 bảng', async () => {
    const store = await makeSqliteStore();
    const rows = await store.driver.all(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const names = rows.map((r) => r.name);
    for (const t of ['jobs', 'usage_events', 'uploads', 'extraction_evidence']) {
      assert.ok(names.includes(t), `thiếu bảng ${t}`);
    }
    await store.close();
  });

  test('vòng đời job: tạo → cập nhật → đọc lại, JSON round-trip đúng', async () => {
    const store = await makeSqliteStore();
    const id = await store.createJob({ sessionId: 's1', source: '1688', sourceUrl: 'https://x/y' });
    assert.ok(id);

    const master = { source: '1688', images: [{ url: 'a' }], price: { raw: '1', currency: 'CNY' } };
    await store.updateJob(id, {
      status: JOB_STATUS.SUCCEEDED,
      stage: 'done',
      product_name: 'Tên',
      product_master: master,
      content: { product_name: 'Tên' },
      evidence: { rows: [{ label: 'Ảnh', status: 'FOUND' }] },
    });

    const got = await store.getJob(id);
    assert.equal(got.status, JOB_STATUS.SUCCEEDED);
    assert.equal(got.product_name, 'Tên');
    assert.deepEqual(got.product_master, master, 'JSON phải round-trip nguyên vẹn');
    assert.equal(got.content.product_name, 'Tên');
    assert.equal(got.evidence.rows[0].label, 'Ảnh');
    await store.close();
  });

  test('updateJob BỎ QUA cột không nằm trong allowlist (chống SQL injection qua tên cột)', async () => {
    const store = await makeSqliteStore();
    const id = await store.createJob({ sessionId: 's1' });
    await store.updateJob(id, {
      status: 'running',
      "status = 'hacked', product_name": 'x',
      'DROP TABLE jobs': 1,
    });
    const got = await store.getJob(id);
    assert.equal(got.status, 'running');
    // Bảng vẫn còn nguyên
    const n = await store.countJobs({});
    assert.equal(n, 1);
    await store.close();
  });

  test('lọc job theo session', async () => {
    const store = await makeSqliteStore();
    await store.createJob({ sessionId: 'A' });
    await store.createJob({ sessionId: 'A' });
    await store.createJob({ sessionId: 'B' });
    assert.equal(await store.countJobs({ sessionId: 'A' }), 2);
    assert.equal(await store.countJobs({ sessionId: 'B' }), 1);
    assert.equal(await store.countJobs({}), 3);
    const listA = await store.listJobs({ sessionId: 'A' });
    assert.equal(listA.length, 2);
    await store.close();
  });

  test('usage_event ghi và tổng hợp đúng', async () => {
    const store = await makeSqliteStore();
    const jobId = await store.createJob({ sessionId: 's' });
    await store.recordUsage({ jobId, operation: 'SOURCE_EXTRACT', estimatedCost: 0.001, inputUnits: 100, outputUnits: 5 });
    await store.recordUsage({ jobId, operation: 'CONTENT_GENERATE', estimatedCost: 0.004, inputUnits: 900, outputUnits: 400 });
    const s = await store.usageSummary(jobId);
    assert.equal(s.events, 2);
    assert.ok(Math.abs(s.estimated_cost - 0.005) < 1e-9);
    assert.equal(s.input_units, 1000);
    assert.equal(s.output_units, 405);
    await store.close();
  });

  test('extraction_evidence lưu và đọc lại đúng kiểu', async () => {
    const store = await makeSqliteStore();
    const jobId = await store.createJob({ sessionId: 's' });
    await store.recordEvidence({
      jobId,
      connector: '1688',
      verification: 'BLOCKED',
      loginRequired: true,
      foundFields: ['a'],
      missingFields: ['b', 'c'],
    });
    const ev = await store.getEvidence(jobId);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].login_required, true, 'phải là boolean thật, không phải 0/1');
    assert.deepEqual(ev[0].found_fields, ['a']);
    assert.deepEqual(ev[0].missing_fields, ['b', 'c']);
    await store.close();
  });

  test('uploads ghi và đọc lại', async () => {
    const store = await makeSqliteStore();
    const jobId = await store.createJob({ sessionId: 's' });
    await store.recordUpload({ jobId, filename: 'a.png', mime: 'image/png', bytes: 123 });
    const ups = await store.listUploads(jobId);
    assert.equal(ups.length, 1);
    assert.equal(ups[0].mime, 'image/png');
    await store.close();
  });

  test('createStore tạo thư mục cha cho file sqlite', async () => {
    const cfg = testConfig({ SQLITE_PATH: '/tmp/vps-test-nested/dir/x.db' });
    const store = await createStore(cfg, silent);
    assert.equal(store.dialect, 'sqlite');
    await store.close();
  });
});

describe('PostgresDriver — dịch placeholder', () => {
  test('? → $1..$n', () => {
    assert.equal(PostgresDriver.toPgPlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
  });

  test('KHÔNG dịch dấu ? nằm trong chuỗi literal', () => {
    assert.equal(
      PostgresDriver.toPgPlaceholders("SELECT '?' AS q, a FROM t WHERE b = ?"),
      "SELECT '?' AS q, a FROM t WHERE b = $1",
    );
  });

  test('xử lý escape nháy đơn', () => {
    assert.equal(PostgresDriver.toPgPlaceholders("SELECT 'it''s ?' , a = ?"), "SELECT 'it''s ?' , a = $1");
  });
});

describe('Store — PostgreSQL (cùng schema.sql)', () => {
  test('cùng file schema tạo cùng bộ bảng trên PostgreSQL', { skip: !hasPg ? 'không có DATABASE_URL — bỏ qua' : false }, async () => {
    const cfg = testConfig({ DB_DRIVER: 'postgres', DATABASE_URL: process.env.DATABASE_URL });
    const store = await createStore(cfg, silent);
    try {
      assert.equal(store.dialect, 'postgres');
      const rows = await store.driver.all(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      );
      const names = rows.map((r) => r.name);
      for (const t of ['jobs', 'usage_events', 'uploads', 'extraction_evidence']) {
        assert.ok(names.includes(t), `thiếu bảng ${t} trên PostgreSQL`);
      }

      // Cùng vòng đời job, cùng kỳ vọng như SQLite
      const id = await store.createJob({ sessionId: 'pg-test', source: 'taobao', sourceUrl: 'https://x/y' });
      const master = { source: 'taobao', price: { raw: '15.00', currency: 'CNY' } };
      await store.updateJob(id, { status: JOB_STATUS.SUCCEEDED, product_master: master, product_name: 'PG' });
      const got = await store.getJob(id);
      assert.equal(got.status, JOB_STATUS.SUCCEEDED);
      assert.deepEqual(got.product_master, master, 'JSON round-trip trên PostgreSQL phải giống SQLite');

      await store.recordUsage({ jobId: id, operation: 'SOURCE_EXTRACT', estimatedCost: 0.002, inputUnits: 7 });
      const sum = await store.usageSummary(id);
      assert.equal(sum.events, 1);
      assert.equal(sum.input_units, 7);
    } finally {
      await store.close();
    }
  });

  test('lỗi khi thiếu DATABASE_URL nhưng chọn driver postgres', { skip: hasPg ? 'đã có DATABASE_URL' : false }, async () => {
    const driver = new PostgresDriver({ url: '', logger: silent });
    await assert.rejects(() => driver.connect(), /DATABASE_URL/);
  });
});
