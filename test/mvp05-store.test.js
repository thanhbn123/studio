/**
 * TEST MVP-05 · A3 — Store, migration cộng thêm, phân trang sổ, usageAggregate.
 *
 * Phần migration chạy trên DB FILE THẬT: test tự dựng một DB "thời MVP-01" (bảng `jobs`
 * và `image_assets` CHƯA có `user_id`), rồi mở Store lên đúng file đó để chứng minh
 * `init()` nâng cấp tại chỗ, idempotent, và job cũ giữ `user_id = NULL`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { createStore } from '../src/store/index.js';
import { testConfig, silent, tmpDir } from './mvp05-helpers.js';

const MIGRATED_COLUMNS = ['kind', 'user_id'];

async function tableColumns(store, table) {
  const info = await store.driver.all(`PRAGMA table_info(${table})`);
  return info.map((col) => col.name);
}

async function tableNames(store) {
  const rows = await store.driver.all("SELECT name FROM sqlite_master WHERE type = 'table'");
  return rows.map((row) => row.name);
}

describe('MVP-05 · A3 — migration idempotent + 4 bảng mới', () => {
  let store;
  before(async () => {
    store = await createStore(testConfig(), silent);
  });
  after(async () => {
    await store.close();
  });

  test('init() chạy 2 lần không lỗi; 4 bảng mới (users/user_sessions/wallet_ledger/pricing) tồn tại', async () => {
    const names = await tableNames(store);
    for (const table of ['users', 'user_sessions', 'wallet_ledger', 'pricing']) {
      assert.ok(names.includes(table), `thiếu bảng ${table} (§2.1)`);
    }
    // Gọi lại init() trên CÙNG store — migration phải là no-op, không được ném.
    await store.init();
    await store.init();
    for (const table of ['users', 'user_sessions', 'wallet_ledger', 'pricing']) {
      assert.ok((await tableNames(store)).includes(table));
    }
    // `wallet_ledger` KHÔNG được có cột `balance` sửa tay (luật #2) và phải có `seq` ổn định.
    const ledgerCols = await tableColumns(store, 'wallet_ledger');
    assert.equal(ledgerCols.includes('balance'), false, 'sổ append-only KHÔNG có cột `balance`');
    for (const col of ['id', 'user_id', 'seq', 'amount', 'currency', 'reason', 'job_id', 'operation', 'meta', 'balance_after', 'created_at']) {
      assert.ok(ledgerCols.includes(col), `wallet_ledger thiếu cột ${col}`);
    }
    const jobCols = await tableColumns(store, 'jobs');
    const assetCols = await tableColumns(store, 'image_assets');
    assert.ok(jobCols.includes('user_id'), 'jobs.user_id phải có');
    assert.ok(assetCols.includes('user_id'), 'image_assets.user_id phải có');
    assert.ok(jobCols.includes('session_id'), 'jobs.session_id phải GIỮ NGUYÊN (ẩn danh dùng nó)');
  });
});

describe('MVP-05 · A3 — DB CŨ (trước MVP-05) nâng cấp tại chỗ, job cũ giữ NULL', () => {
  test('thêm cột user_id cho DB cũ; hàng cũ KHÔNG bị backfill cho ai', async () => {
    const file = path.join(tmpDir('vps-mvp05-old-'), 'studio.db');
    const oldJobId = randomUUID();
    const oldAssetId = randomUUID();

    // 1. Dựng DB "thời MVP-01/02": chưa có cột nào của MVP-05.
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE jobs (
      id TEXT PRIMARY KEY, session_id TEXT, source TEXT, source_url TEXT, canonical_url TEXT,
      source_product_id TEXT, product_name TEXT, status TEXT NOT NULL, stage TEXT, error_code TEXT,
      error_message TEXT, style TEXT, length TEXT, input_mode TEXT, kind TEXT DEFAULT 'content',
      product_master TEXT, vision TEXT, knowledge TEXT, content TEXT, evidence TEXT, content_meta TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT);`);
    raw.exec(`CREATE TABLE image_assets (
      id TEXT PRIMARY KEY, job_id TEXT, session_id TEXT, role TEXT NOT NULL, parent_id TEXT,
      mime TEXT, bytes INTEGER, width INTEGER, height INTEGER, sha256 TEXT, storage_path TEXT,
      source TEXT, meta TEXT, created_at TEXT NOT NULL);`);
    const ts = '2026-01-02T03:04:05.000Z';
    raw.prepare('INSERT INTO jobs (id, session_id, status, kind, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(oldJobId, 'phien-cu-01', 'succeeded', 'content', ts, ts);
    raw.prepare('INSERT INTO image_assets (id, job_id, session_id, role, mime, created_at) VALUES (?,?,?,?,?,?)')
      .run(oldAssetId, oldJobId, 'phien-cu-01', 'original', 'image/png', ts);
    raw.close();

    // 2. Mở Store lên đúng file cũ — schema + migration phải nâng cấp tại chỗ.
    const config = testConfig({ SQLITE_PATH: file, IMAGELAB_DIR: tmpDir() });
    const store = await createStore(config, silent);
    try {
      const jobCols = await tableColumns(store, 'jobs');
      const assetCols = await tableColumns(store, 'image_assets');
      for (const col of MIGRATED_COLUMNS) {
        assert.ok(jobCols.includes(col), `jobs thiếu ${col} sau migration`);
      }
      assert.ok(assetCols.includes('user_id'), 'image_assets thiếu user_id sau migration');

      const oldJob = await store.getJob(oldJobId);
      assert.equal(oldJob.user_id, null, 'job CŨ phải giữ user_id NULL — không tự thuộc về ai (§2.2)');
      assert.equal(oldJob.session_id, 'phien-cu-01');
      assert.equal(oldJob.kind, 'content');
      const oldAsset = await store.getImageAsset(oldAssetId);
      assert.equal(oldAsset.user_id, null, 'asset CŨ cũng giữ NULL');

      // 3. init() lần hai trên DB đã nâng cấp: idempotent, dữ liệu cũ còn nguyên.
      await store.init();
      assert.equal((await store.getJob(oldJobId)).user_id, null);
      assert.equal((await store.getJob(oldJobId)).session_id, 'phien-cu-01');
      const count = await store.driver.get('SELECT COUNT(*) AS n FROM jobs');
      assert.equal(Number(count.n), 1, 'migration không được nhân bản dữ liệu');
    } finally {
      await store.close();
    }
    assert.ok(fs.existsSync(file));
  });
});

describe('MVP-05 · A3 — gắn user_id vào job/asset mới (ẩn danh vẫn NULL)', () => {
  let store;
  let userId;
  before(async () => {
    store = await createStore(testConfig(), silent);
    const user = await store.createUser({
      id: randomUUID(),
      email: 'chu-so-huu@example.com',
      passwordHash: 'scrypt$16384$8$1$c2FsdHNhbHQ=$aGFzaGhhc2hoYXNoaGFzaA==',
    });
    userId = user.id;
  });
  after(async () => {
    await store.close();
  });

  test('createJob/createImageAsset nhận userId; không truyền ⇒ NULL (ẩn danh)', async () => {
    const owned = await store.createJob({ sessionId: 's1', userId, kind: 'content' });
    const anon = await store.createJob({ sessionId: 's2', kind: 'content' });
    assert.equal((await store.getJob(owned)).user_id, userId);
    assert.equal((await store.getJob(anon)).user_id, null);

    const ownedAsset = await store.createImageAsset({
      jobId: owned, sessionId: 's1', userId, role: 'original', mime: 'image/png', bytes: 10, sha256: 'a'.repeat(64),
    });
    const anonAsset = await store.createImageAsset({
      jobId: anon, sessionId: 's2', role: 'original', mime: 'image/png', bytes: 10, sha256: 'b'.repeat(64),
    });
    assert.equal((await store.getImageAsset(ownedAsset)).user_id, userId);
    assert.equal((await store.getImageAsset(anonAsset)).user_id, null);

    // listJobs lọc theo userId CHỈ trả job của chủ đó.
    const rows = await store.listJobs({ userId });
    assert.deepEqual(rows.map((row) => row.id), [owned]);
    const count = await store.countJobs({ userId });
    assert.equal(count, 1);
  });
});

describe('MVP-05 · A3 — phân trang sổ credit không trùng/sót', () => {
  let store;
  let userId;
  before(async () => {
    store = await createStore(testConfig(), silent);
    userId = randomUUID();
  });
  after(async () => {
    await store.close();
  });

  test('25 dòng ghi qua appendLedger: 2–3 trang hợp lại ĐÚNG toàn bộ, không dòng nào lặp', async () => {
    for (let i = 0; i < 25; i += 1) {
      await store.appendLedger({ userId, amount: 1, reason: 'grant', meta: { i } });
    }
    const all = await store.listLedger({ userId, limit: 500 });
    assert.equal(all.length, 25);
    const allIds = all.map((row) => row.id);

    const page1 = await store.listLedger({ userId, limit: 10, offset: 0 });
    const page2 = await store.listLedger({ userId, limit: 10, offset: 10 });
    const page3 = await store.listLedger({ userId, limit: 10, offset: 20 });
    assert.equal(page1.length, 10);
    assert.equal(page2.length, 10);
    assert.equal(page3.length, 5);

    const united = [...page1, ...page2, ...page3].map((row) => row.id);
    assert.equal(new Set(united).size, 25, 'không được có dòng lặp giữa các trang');
    assert.deepEqual(new Set(united), new Set(allIds), 'hợp các trang phải bằng TOÀN BỘ sổ');
    assert.deepEqual(united, allIds, 'thứ tự phân trang phải ổn định (seq giảm dần)');
    assert.deepEqual(page1.map((r) => r.id), allIds.slice(0, 10));
    assert.deepEqual(page3.map((r) => r.id), allIds.slice(20));
  });

  test('25 dòng CÙNG created_at (tie thật): phân trang vẫn không trùng/sót', async () => {
    const tiedUser = randomUUID();
    const tied = '2026-03-04T05:06:07.008Z';
    for (let i = 1; i <= 25; i += 1) {
      await store.driver.run(
        `INSERT INTO wallet_ledger (id, user_id, seq, amount, currency, reason, job_id, operation, meta, balance_after, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [randomUUID(), tiedUser, i, 1, 'USD', 'grant', null, null, null, i, tied],
      );
    }
    const all = await store.listLedger({ userId: tiedUser, limit: 500 });
    assert.equal(all.length, 25);
    assert.equal(new Set(all.map((row) => row.created_at)).size, 1, 'mọi dòng phải CÙNG một mốc thời gian');

    const pages = [];
    for (let offset = 0; offset < 25; offset += 7) {
      pages.push(...(await store.listLedger({ userId: tiedUser, limit: 7, offset })));
    }
    const ids = pages.map((row) => row.id);
    assert.equal(ids.length, 25);
    assert.equal(new Set(ids).size, 25, 'cùng created_at ⇒ phải sắp theo seq, không được trùng');
    assert.deepEqual(ids, all.map((row) => row.id));
    assert.deepEqual(all.map((row) => row.seq), Array.from({ length: 25 }, (_, i) => 25 - i), 'seq giảm dần');
  });
});

describe('MVP-05 · A3 — usageAggregate 3 kiểu groupBy', () => {
  let store;
  let userA;
  let userB;
  let jobA;
  let jobB;
  let jobAnon;

  before(async () => {
    store = await createStore(testConfig(), silent);
    userA = randomUUID();
    userB = randomUUID();
    jobA = await store.createJob({ sessionId: 'sa', userId: userA, kind: 'content' });
    jobB = await store.createJob({ sessionId: 'sb', userId: userB, kind: 'content' });
    jobAnon = await store.createJob({ sessionId: 'san', kind: 'content' });

    await store.recordUsage({ jobId: jobA, sessionId: 'sa', operation: 'CONTENT_GENERATE', provider: 'fake', model: 'm', inputUnits: 10, outputUnits: 20, estimatedCost: 0.004 });
    await store.recordUsage({ jobId: jobA, sessionId: 'sa', operation: 'TRANSLATION', provider: 'fake', model: 'm', inputUnits: 3, outputUnits: 4, estimatedCost: 0.0008 });
    await store.recordUsage({ jobId: jobB, sessionId: 'sb', operation: 'CONTENT_GENERATE', provider: 'fake', model: 'm', inputUnits: 1, outputUnits: 2, estimatedCost: 0.004 });
    await store.recordUsage({ jobId: jobAnon, sessionId: 'san', operation: 'OCR_DETECT', provider: 'fake', model: 'm', inputUnits: 5, outputUnits: 0, estimatedCost: 0.0004 });
  });
  after(async () => {
    await store.close();
  });

  test("groupBy 'day' → một nhóm ngày với số THẬT", async () => {
    const rows = await store.usageAggregate({ groupBy: 'day' });
    // Lấy mốc ngày từ CHÍNH dòng usage đã ghi (không tự tính lại — tránh đua qua nửa đêm).
    const expectedDay = (await store.listUsage(jobA))[0].created_at.slice(0, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].group, expectedDay);
    assert.equal(rows[0].events, 4);
    assert.equal(rows[0].estimated_cost, 0.0092);
    assert.equal(rows[0].input_units, 19);
    assert.equal(rows[0].output_units, 26);
    assert.equal(typeof rows[0].events, 'number');
    assert.equal(typeof rows[0].estimated_cost, 'number');
  });

  test("groupBy 'operation' → mỗi operation một dòng", async () => {
    const rows = await store.usageAggregate({ groupBy: 'operation' });
    const byOp = new Map(rows.map((row) => [row.group, row]));
    assert.deepEqual([...byOp.keys()].sort(), ['CONTENT_GENERATE', 'OCR_DETECT', 'TRANSLATION']);
    assert.equal(byOp.get('CONTENT_GENERATE').events, 2);
    assert.equal(byOp.get('CONTENT_GENERATE').estimated_cost, 0.008);
    assert.equal(byOp.get('TRANSLATION').events, 1);
    assert.equal(byOp.get('OCR_DETECT').estimated_cost, 0.0004);
  });

  test("groupBy 'user' → theo chủ job, job ẩn danh gom vào nhóm '(ẩn danh)'", async () => {
    const rows = await store.usageAggregate({ groupBy: 'user' });
    const byUser = new Map(rows.map((row) => [row.user_id, row]));
    assert.equal(byUser.get(userA).events, 2);
    assert.equal(byUser.get(userA).estimated_cost, 0.0048);
    assert.equal(byUser.get(userB).events, 1);
    const anon = rows.find((row) => row.user_id === null);
    assert.ok(anon, 'job ẩn danh phải có nhóm riêng');
    assert.equal(anon.group, '(ẩn danh)');
    assert.equal(anon.events, 1);
  });

  test('lọc from/to theo ngày; groupBy lạ ⇒ lỗi CÓ MÃ', async () => {
    const today = (await store.listUsage(jobA))[0].created_at.slice(0, 10);
    assert.equal((await store.usageAggregate({ groupBy: 'day', from: today })).length, 1);
    assert.equal((await store.usageAggregate({ groupBy: 'day', to: '2000-01-01' })).length, 0);
    assert.equal((await store.usageAggregate({ groupBy: 'day', from: '2000-01-01', to: '2000-01-02' })).length, 0);

    // `''`/`null` rơi về mặc định 'day' (hợp lệ) — chỉ giá trị LẠ mới là lỗi.
    for (const bad of ['thang', 'DAY', 42, {}]) {
      const err = await store.usageAggregate({ groupBy: bad }).catch((e) => e);
      assert.ok(err instanceof Error, `groupBy ${JSON.stringify(bad)} phải ném`);
      assert.equal(err.code, 'INVALID_GROUP_BY');
    }
  });
});
