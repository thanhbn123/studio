/**
 * TEST MVP-07 · P2 — BẢNG + MIGRATION (`src/store/schema.sql`, `src/store/index.js`), hợp đồng §3.
 *
 * Phủ điều kiện "XONG" số 8: `init()` chạy HAI LẦN liên tiếp trên cùng DB không lỗi (schema +
 * migration + index đều idempotent), và — quan trọng hơn — mô phỏng đúng CẠM BẪY cũ của repo:
 *
 *   DB tạo bởi một bản TRUNG GIAN đã có bảng `publish_items` nhưng THIẾU cột (`run_key`,
 *   `is_mock`…). `CREATE TABLE IF NOT EXISTS` là no-op, nên nếu index nằm trong `schema.sql`
 *   thì câu `CREATE INDEX` chạy TRƯỚC migration và làm CHẾT `init()`. Test dưới đây dựng đúng
 *   tình huống đó trên DB THẬT (tệp trên đĩa) rồi đòi `init()` phải sống.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Store, createStore } from '../src/store/index.js';
import { SqliteDriver } from '../src/store/sqlite-driver.js';
import { testConfig, silent } from './helpers.js';
import { seedContentJob } from './publish-helpers.js';

const USER = 'user-store-publish';

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-publish-store-'));
  return { dir, file: path.join(dir, 'studio.db') };
}

describe('MVP-07 P2 — bảng `publish_items` / `publish_logs` (§3)', () => {
  test('hai bảng tồn tại sau `init()` với ĐỦ cột hợp đồng §3.1/§3.2', async () => {
    const store = await createStore(testConfig({ SQLITE_PATH: ':memory:' }), silent);
    try {
      const cols = (await store.driver.all('PRAGMA table_info(publish_items)')).map((c) => c.name);
      for (const c of [
        'id', 'job_id', 'user_id', 'channel', 'provider', 'text', 'media_ids', 'status',
        'scheduled_at', 'approved_by', 'approved_at', 'rejected_by', 'rejected_at', 'reject_reason',
        'published_at', 'external_post_id', 'external_url', 'is_mock', 'error_code', 'last_error',
        'attempts', 'run_key', 'created_at', 'updated_at',
      ]) {
        assert.ok(cols.includes(c), `publish_items thiếu cột \`${c}\``);
      }
      const logCols = (await store.driver.all('PRAGMA table_info(publish_logs)')).map((c) => c.name);
      for (const c of ['id', 'item_id', 'attempt', 'run_key', 'provider', 'channel', 'status', 'external_post_id', 'error_code', 'error_message', 'is_mock', 'request_summary', 'created_at']) {
        assert.ok(logCols.includes(c), `publish_logs thiếu cột \`${c}\``);
      }
    } finally {
      await store.close();
    }
  });

  test('bốn index được tạo SAU migration (không nằm trong schema.sql)', async () => {
    // Luật của repo: index cho bảng mới KHÔNG được nằm trong file schema. Bỏ dòng CHÚ THÍCH
    // trước khi soi, vì chú thích của chính khối MVP-07 có nhắc chữ "CREATE INDEX".
    const schema = fs.readFileSync(new URL('../src/store/schema.sql', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    assert.ok(!/CREATE INDEX[^;]*publish_items/i.test(schema), 'index của publish_items KHÔNG được đặt trong schema.sql');
    assert.ok(!/CREATE INDEX[^;]*publish_logs/i.test(schema), 'index của publish_logs KHÔNG được đặt trong schema.sql');

    const store = await createStore(testConfig({ SQLITE_PATH: ':memory:' }), silent);
    try {
      const names = (await store.driver.all("SELECT name FROM sqlite_master WHERE type = 'index'")).map((r) => r.name);
      for (const idx of ['idx_publish_items_user', 'idx_publish_items_status', 'idx_publish_items_job', 'idx_publish_logs_item']) {
        assert.ok(names.includes(idx), `thiếu index \`${idx}\` (phải do #applyAdditiveMigrations tạo)`);
      }
    } finally {
      await store.close();
    }
  });

  test('`init()` chạy HAI LẦN liên tiếp trên cùng DB không lỗi (§6 điều kiện 8)', async () => {
    const { dir, file } = tmpDbPath();
    try {
      const config = testConfig({ SQLITE_PATH: file });
      const first = await createStore(config, silent);
      await first.init(); // lần hai trên cùng tiến trình
      await first.close();
      const second = await createStore(config, silent); // tiến trình mới trên DB đã có dữ liệu
      await second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('DB TRUNG GIAN (bảng đã có, THIẾU cột) ⇒ migration vá tại chỗ, `init()` KHÔNG chết', async () => {
    const { dir, file } = tmpDbPath();
    try {
      // 1. Dựng tay một DB "bản cũ": bảng publish_items chỉ có vài cột, KHÔNG có run_key/is_mock.
      const driver = new SqliteDriver({ path: file }, silent);
      await driver.connect();
      await driver.exec(`CREATE TABLE publish_items (
        id TEXT PRIMARY KEY, job_id TEXT, user_id TEXT, channel TEXT, text TEXT,
        media_ids TEXT, status TEXT, approved_by TEXT, approved_at TEXT,
        published_at TEXT, external_post_id TEXT, error_code TEXT, attempts INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
      await driver.exec("CREATE TABLE publish_logs (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, attempt INTEGER, provider TEXT, channel TEXT, status TEXT, external_post_id TEXT, error_code TEXT, error_message TEXT, is_mock INTEGER, created_at TEXT NOT NULL)");
      await driver.run('INSERT INTO publish_items (id, status, created_at, updated_at) VALUES (?,?,?,?)', ['cu-1', 'draft', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
      await driver.close();

      // 2. `init()` phải nâng cấp tại chỗ mà KHÔNG chết.
      const store = await createStore(testConfig({ SQLITE_PATH: file }), silent);
      try {
        const cols = (await store.driver.all('PRAGMA table_info(publish_items)')).map((c) => c.name);
        for (const c of ['run_key', 'is_mock', 'provider', 'external_url', 'scheduled_at', 'rejected_by', 'rejected_at', 'reject_reason', 'last_error']) {
          assert.ok(cols.includes(c), `migration phải thêm cột \`${c}\` cho DB cũ`);
        }
        // Dòng CŨ còn nguyên, không bị backfill bừa.
        const old = await store.getPublishItem('cu-1');
        assert.equal(old.status, 'draft');
        assert.equal(old.run_key, null);
        assert.equal(old.is_mock, false);
        // Index vẫn tạo được SAU khi cột đã tồn tại.
        const names = (await store.driver.all("SELECT name FROM sqlite_master WHERE type = 'index'")).map((r) => r.name);
        assert.ok(names.includes('idx_publish_items_user'));
      } finally {
        await store.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MVP-07 P2 — hydrate + truy vấn', () => {
  test('`media_ids` trả ra là MẢNG, `is_mock` là BOOLEAN (tầng trên không phải đoán)', async () => {
    const store = await createStore(testConfig({ SQLITE_PATH: ':memory:' }), silent);
    try {
      const job = await seedContentJob(store, { userId: USER });
      const item = await store.createPublishItem({ jobId: job.id, userId: USER, text: 'x', mediaIds: ['a-asset-id-1', 'b-asset-id-2'] });
      assert.ok(Array.isArray(item.media_ids));
      assert.deepEqual(item.media_ids, ['a-asset-id-1', 'b-asset-id-2']);
      assert.equal(item.is_mock, false);
      assert.equal(typeof item.is_mock, 'boolean');
      assert.equal(item.attempts, 0);
      assert.equal(item.status, 'draft', 'mặc định phải là `draft`, KHÔNG BAO GIỜ `approved`');
    } finally {
      await store.close();
    }
  });

  test('`listPublishItems` KHÔNG trả bài của người khác khi `all` không bật', async () => {
    const store = await createStore(testConfig({ SQLITE_PATH: ':memory:' }), silent);
    try {
      const jobA = await seedContentJob(store, { userId: 'u-a' });
      const jobB = await seedContentJob(store, { userId: 'u-b' });
      await store.createPublishItem({ jobId: jobA.id, userId: 'u-a', text: 'a' });
      await store.createPublishItem({ jobId: jobB.id, userId: 'u-b', text: 'b' });
      const mine = await store.listPublishItems({ userId: 'u-a' });
      assert.equal(mine.length, 1);
      assert.equal(mine[0].text, 'a');
      // Thiếu `userId` và không bật `all` ⇒ RỖNG (fail-closed), không trả hết bảng.
      assert.deepEqual(await store.listPublishItems({}), []);
      assert.equal(await store.countPublishItems({}), 0);
      assert.equal((await store.listPublishItems({ all: true })).length, 2);
      assert.equal(await store.countPublishItems({ all: true }), 2);
    } finally {
      await store.close();
    }
  });

  test('`setPublishItemStatus` chỉ ghi cột trong danh sách TRẮNG (không ghi cột lạ)', async () => {
    const store = await createStore(testConfig({ SQLITE_PATH: ':memory:' }), silent);
    try {
      const job = await seedContentJob(store, { userId: USER });
      const item = await store.createPublishItem({ jobId: job.id, userId: USER, text: 'x', status: 'pending_review' });
      const next = await store.setPublishItemStatus(item.id, {
        from: ['pending_review'],
        to: 'approved',
        patch: { approved_by: 'admin-1', external_post_id: 'HACK', user_id: 'nguoi-khac' },
      });
      assert.equal(next.status, 'approved');
      assert.equal(next.approved_by, 'admin-1');
      assert.equal(next.external_post_id, null, 'cột ngoài danh sách trắng KHÔNG được ghi');
      const raw = await store.driver.get('SELECT user_id FROM publish_items WHERE id = ?', [item.id]);
      assert.equal(raw.user_id, USER, 'không được đổi chủ bài qua `patch`');
    } finally {
      await store.close();
    }
  });

  test('`setPublishItemStatus` trả `null` khi trạng thái hiện tại không khớp `from`', async () => {
    const store = await createStore(testConfig({ SQLITE_PATH: ':memory:' }), silent);
    try {
      const job = await seedContentJob(store, { userId: USER });
      const item = await store.createPublishItem({ jobId: job.id, userId: USER, text: 'x', status: 'draft' });
      assert.equal(await store.setPublishItemStatus(item.id, { from: ['pending_review'], to: 'approved' }), null);
    } finally {
      await store.close();
    }
  });

  test('`appendPublishLog` thiếu `item_id` ⇒ ném lỗi có mã (không ghi vết mồ côi)', async () => {
    const store = await createStore(testConfig({ SQLITE_PATH: ':memory:' }), silent);
    try {
      await assert.rejects(() => store.appendPublishLog({ status: 'PUBLISHED' }), (e) => e.code === 'INVALID_PUBLISH_LOG');
    } finally {
      await store.close();
    }
  });

  test('`appendPublishLog` chặn trần độ dài lỗi nhưng GIỮ phần đầu nguyên văn', async () => {
    const store = await createStore(testConfig({ SQLITE_PATH: ':memory:' }), silent);
    try {
      const job = await seedContentJob(store, { userId: USER });
      const item = await store.createPublishItem({ jobId: job.id, userId: USER, text: 'x' });
      await store.appendPublishLog({ itemId: item.id, status: 'FAILED', errorMessage: `(#200) ${'x'.repeat(9000)}` });
      const logs = await store.listPublishLogs(item.id);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].error_message.length, 4000);
      assert.match(logs[0].error_message, /^\(#200\)/, 'phần đầu nguyên văn phải còn');
    } finally {
      await store.close();
    }
  });

  test('`Store` cũ không có hàm publish_* ⇒ `PublishService` từ chối dựng (nói thẳng)', async () => {
    const { PublishService, PUBLISH_CODES } = await import('../src/publish/index.js');
    assert.throws(
      () => new PublishService({ store: {}, provider: { publish() {} } }),
      (e) => e.code === PUBLISH_CODES.BAD_INPUT,
    );
  });

  test('`Store` được export (để tầng khác dựng được) và có đủ 9 hàm publish_*', () => {
    for (const fn of [
      'createPublishItem', 'getPublishItem', 'listPublishItems', 'countPublishItems',
      'setPublishItemStatus', 'claimPublishItem', 'finishPublishItem', 'appendPublishLog', 'listPublishLogs',
    ]) {
      assert.equal(typeof Store.prototype[fn], 'function', `Store thiếu hàm \`${fn}\``);
    }
  });
});
