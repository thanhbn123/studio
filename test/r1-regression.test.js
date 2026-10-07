/**
 * R1 (§5) — HỒI QUY: sprint độ tin cậy KHÔNG được phá thứ đã nghiệm thu.
 *
 * Ba thứ dễ vỡ nhất khi thêm bảng/hàng đợi/khoá mới:
 *   1. DB "thời trước R1" (chưa có `job_queue`, `wallet_ledger` chưa có `seq`/`run_key`/
 *      `close_kind`, `jobs` chưa có `user_id`): `init()` phải nâng cấp TẠI CHỖ, chạy 2 lần
 *      không lỗi, có `job_queue` + index, và dữ liệu cũ PHẢI nguyên vẹn.
 *   2. Ẩn danh (không ví): luồng job ImageLab không tài khoản phải chạy y như trước —
 *      không dòng sổ nào, không bị chặn, hàng đợi bền vẫn ghi nhận việc.
 *   3. `/api/health` vẫn đủ field cũ (đã kiểm ở `test/r1-scheduler.test.js`), và job của
 *      người dùng CÓ ví vẫn giữ nguyên chuỗi giữ tiền → quyết toán (không thu 2 lần).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { createStore } from '../src/store/index.js';
import { createBillingService } from '../src/billing/index.js';
import { headphones, j, postJson, startImagelabApp, tmpDir, waitJob } from './imagelab-helpers.js';
import { testConfig, silent } from './helpers.js';

const tableNames = async (store) => (await store.driver.all("SELECT name FROM sqlite_master WHERE type='table'")).map((r) => r.name);
const indexNames = async (store, table) => (await store.driver.all(`PRAGMA index_list(${table})`)).map((r) => r.name);
const tableColumns = async (store, table) => (await store.driver.all(`PRAGMA table_info(${table})`)).map((r) => r.name);

/** Bảng `job_queue` đúng hợp đồng §2.1 — 15 cột, KHÔNG thiếu cột nào. */
const QUEUE_COLUMNS = [
  'id', 'job_id', 'kind', 'handler', 'payload', 'status', 'attempts', 'max_attempts',
  'run_after', 'locked_at', 'locked_by',
  // R1-F2/A3 (vòng sửa phản biện): hai cột THÊM SAU bằng migration ⇒ luôn nằm cuối bảng.
  'heartbeat_at', 'epoch',
  'last_error', 'created_at', 'updated_at', 'finished_at',
];

describe('R1 · §5 — DB "thời trước R1": init() hai lần, nâng cấp tại chỗ, dữ liệu cũ nguyên', () => {
  test('có `job_queue` + 3 index; `jobs`/`wallet_ledger` được thêm cột; dòng cũ KHÔNG bị đổi', async () => {
    const file = path.join(tmpDir('vps-r1-cu-'), 'studio.db');
    const oldJobId = `job-cu-${randomUUID()}`;
    const oldUserId = `user-cu-${randomUUID()}`;
    const ts = '2026-01-02T03:04:05.000Z';

    // 1) Dựng DB "thời trước R1": CHƯA có bảng `job_queue`; các cột thêm sau này cũng chưa có.
    const raw = new DatabaseSync(file);
    raw.exec(`CREATE TABLE jobs (
      id TEXT PRIMARY KEY, session_id TEXT, source TEXT, source_url TEXT, canonical_url TEXT,
      source_product_id TEXT, product_name TEXT, status TEXT NOT NULL, stage TEXT, error_code TEXT,
      error_message TEXT, style TEXT, length TEXT, input_mode TEXT, product_master TEXT, vision TEXT,
      knowledge TEXT, content TEXT, evidence TEXT, content_meta TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT);`);
    raw.exec(`CREATE TABLE image_assets (
      id TEXT PRIMARY KEY, job_id TEXT, session_id TEXT, role TEXT NOT NULL, parent_id TEXT, mime TEXT,
      bytes INTEGER, width INTEGER, height INTEGER, sha256 TEXT, storage_path TEXT, source TEXT,
      meta TEXT, created_at TEXT NOT NULL);`);
    raw.exec(`CREATE TABLE wallet_ledger (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
      reason TEXT NOT NULL, job_id TEXT, operation TEXT, meta TEXT, balance_after REAL NOT NULL,
      created_at TEXT NOT NULL);`);
    raw.prepare('INSERT INTO jobs (id, session_id, status, stage, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(oldJobId, 'phien-cu-01', 'succeeded', 'done', ts, ts);
    raw.prepare('INSERT INTO wallet_ledger (id, user_id, amount, reason, balance_after, created_at) VALUES (?,?,?,?,?,?)')
      .run('ledger-cu-1', oldUserId, 7, 'grant', 7, ts);
    raw.close();

    const config = testConfig({ SQLITE_PATH: file, IMAGELAB_DIR: tmpDir() });

    // 2) Mở store lên DB cũ (init lần 1) rồi gọi init() LẦN HAI — phải idempotent.
    const store = await createStore(config, silent);
    try {
      await store.init();
      await store.init();

      const tables = await tableNames(store);
      assert.ok(tables.includes('job_queue'), 'init() phải tạo bảng `job_queue` trên DB cũ (§2.1)');
      assert.deepEqual(await tableColumns(store, 'job_queue'), QUEUE_COLUMNS, '`job_queue` phải đúng cột hợp đồng §2.1');

      const indexes = await indexNames(store, 'job_queue');
      for (const name of ['idx_job_queue_status_run_after', 'idx_job_queue_job_id', 'idx_job_queue_locked_at']) {
        assert.ok(indexes.includes(name), `thiếu index \`${name}\` (§2.1)`);
      }

      // Dữ liệu CŨ: job giữ nguyên mọi giá trị; cột mới nhận mặc định, KHÔNG tự thuộc về ai.
      const oldJob = await store.getJob(oldJobId);
      assert.equal(oldJob.status, 'succeeded');
      assert.equal(oldJob.stage, 'done');
      assert.equal(oldJob.session_id, 'phien-cu-01');
      assert.equal(oldJob.created_at, ts, '`created_at` cũ không được viết lại');
      assert.equal(oldJob.kind, 'content', 'cột `kind` thêm sau ⇒ mặc định `content`');
      assert.equal(oldJob.user_id, null, 'job cũ KHÔNG được tự gán cho ai (luật #1)');

      const oldRows = await store.listLedger({ userId: oldUserId });
      assert.equal(oldRows.length, 1);
      assert.equal(oldRows[0].amount, 7);
      assert.equal(oldRows[0].balance_after, 7);
      assert.equal(oldRows[0].seq, 0, 'dòng sổ cũ giữ `seq = 0` — KHÔNG backfill sổ append-only');
      assert.equal(oldRows[0].run_key, null);
      assert.equal(await store.ledgerBalance(oldUserId), 7);

      // Hàng đợi bền phải CHẠY ĐƯỢC trên DB vừa nâng cấp.
      await store.enqueueJob({ id: 'q-moi', jobId: oldJobId, kind: 'content', handler: 'run' });
      const claimed = await store.claimNextJob({ workerId: 'w-sau-nang-cap' });
      assert.equal(claimed.id, 'q-moi');
      await store.completeQueueItem('q-moi');
      assert.deepEqual(await store.queueStats(), { queued: 0, running: 0, done: 1, failed: 0 });
    } finally {
      await store.close();
    }

    // 3) "Khởi động lại tiến trình": mở store MỚI trên đúng file đó — vẫn init sạch, dữ liệu còn nguyên.
    const store2 = await createStore(config, silent);
    try {
      assert.ok((await tableNames(store2)).includes('job_queue'));
      assert.equal((await store2.getJob(oldJobId)).status, 'succeeded');
      assert.equal(await store2.ledgerBalance(oldUserId), 7);
      assert.equal((await store2.listLedger({ userId: oldUserId })).length, 1, 'init() lần nữa KHÔNG được nhân bản dòng sổ');
      assert.deepEqual(await store2.queueStats(), { queued: 0, running: 0, done: 1, failed: 0 });
      assert.equal((await store2.driver.get('SELECT COUNT(*) AS n FROM job_queue')).n, 1);
    } finally {
      await store2.close();
    }
  });
});

describe('R1 · §5 — ẩn danh (không ví) KHÔNG bị ảnh hưởng', () => {
  test('job ImageLab ẩn danh chạy trọn vẹn: không dòng sổ nào, hàng đợi bền ghi nhận việc', async () => {
    const ctx = await startImagelabApp();
    const SID = 'r1-anon-session-1';
    try {
      const buf = headphones();
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: buf.toString('base64'), filename: 'tai-nghe.png' },
      }, SID));
      assert.ok(created.job_id, `phải tạo được job ẩn danh: ${JSON.stringify(created).slice(0, 200)}`);

      const done = await waitJob(ctx.base, created.job_id, SID, { until: (d) => d?.job?.status === 'awaiting_review' });
      assert.equal(done.job.status, 'awaiting_review', 'luồng ẩn danh phải đi tới bước chờ duyệt như trước R1');

      const job = await ctx.store.getJob(created.job_id);
      assert.equal(job.user_id, null, 'job ẩn danh KHÔNG được gán chủ');
      const ledgerCount = await ctx.store.driver.get('SELECT COUNT(*) AS n FROM wallet_ledger');
      assert.equal(Number(ledgerCount.n), 0, 'ẩn danh KHÔNG có ví ⇒ tuyệt đối không có dòng sổ nào');

      // Hàng đợi BỀN vẫn ghi nhận và hoàn tất việc của phiên ẩn danh.
      const item = await ctx.store.getQueueItem(created.job_id);
      assert.ok(item, 'job ẩn danh vẫn phải đi qua hàng đợi bền (ghi DB trước khi chạy)');
      assert.equal(item.status, 'done');
      assert.equal(item.handler, 'run_ocr');
      assert.equal(Number((await ctx.store.driver.get('SELECT COUNT(*) AS n FROM job_queue')).n), 1);

      // Hook tính tiền bỏ qua ẩn danh — không ném, không giữ tiền.
      const skipped = await ctx.app.billingHook.beforeJob({ userId: null, jobId: created.job_id, kind: 'image_translation' });
      assert.equal(skipped.held, 0);
      assert.equal(skipped.balance_after, null);

      const health = await j(await fetch(`${ctx.base}/api/health`));
      assert.equal(health.status, 'ok');
    } finally {
      await ctx.close();
    }
  });

  test('người dùng CÓ ví: chuỗi giữ tiền → quyết toán vẫn đúng, không thu hai lần', async () => {
    const config = testConfig();
    const store = await createStore(config, silent);
    try {
      const billing = createBillingService(config, { store, logger: silent });
      const user = `user-${randomUUID()}`;
      const jobId = `job-${randomUUID()}`;
      await billing.grant({ userId: user, amount: 5, reason: 'admin_grant' });
      const hold = await billing.holdForJob({ userId: user, jobId, estimate: 0.5, runKey: 'r1' });
      assert.equal(hold.balance_after, 4.5);
      // Ẩn danh (job không có user) không được dính dòng sổ của người khác.
      await store.createJob({ id: jobId, userId: user });
      await store.createJob({ id: `job-anon-${randomUUID()}`, userId: null });
      const settle = await billing.settleForJob({ userId: user, jobId, actualCost: 0.2, runKey: 'r1' });
      assert.equal(settle.amount, 0.3, 'quyết toán hoàn phần chênh 0.5 − 0.2');
      assert.equal(await store.ledgerBalance(user), 4.8);
      assert.equal((await store.listLedger({ userId: user, limit: 50 })).length, 3, 'grant + hold + settle, KHÔNG thêm dòng nào');
    } finally {
      await store.close();
    }
  });
});
