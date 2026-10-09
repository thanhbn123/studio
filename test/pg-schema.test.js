/**
 * BẢNG MỚI CỦA MVP-03/04/05 + MIGRATION — NGHIỆP VỤ THẬT TRÊN POSTGRESQL.
 *
 * Lỗ hổng file này bịt: CI chạy PostgreSQL 16 nhưng chỉ dựng **schema + migration**; các
 * method đọc/ghi của `image_assets` (meta MVP-03), job `video_generation` (MVP-04),
 * `users` / `user_sessions` / `pricing` / `jobs.user_id` / `usage_events.run_key` (MVP-05)
 * chỉ được chứng minh trên SQLite in-memory.
 *
 * Những thứ CHỈ sai trên PostgreSQL:
 *   · `COUNT(*)` trả **BIGINT** — driver `pg` đưa về **chuỗi** '3', không phải số 3;
 *   · JSON lưu trong cột TEXT phải round-trip y nguyên (không bị PostgreSQL tự ép kiểu);
 *   · `ON CONFLICT … DO UPDATE` (upsert `pricing`) khác `INSERT OR REPLACE` của SQLite;
 *   · `ALTER TABLE … ADD COLUMN IF NOT EXISTS` — SQLite không có mệnh đề này;
 *   · `init()` chạy LẦN HAI trên DB đã có dữ liệu không được làm chết tiến trình.
 *
 * Tự BỎ QUA khi thiếu `DATABASE_URL`. Mọi dòng tạo ra đều bị dọn theo `RUN_TAG`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createStore, JOB_STATUS, USAGE_OPERATIONS } from '../src/store/index.js';
import {
  hasPg, skipNoPg, pgConfig, silent,
  newUserId, newJobId, purgeRunRows,
} from './pg-helpers.js';

describe('Bảng mới MVP-03/04/05 + migration trên PostgreSQL thật', () => {
  let store;

  before(async () => {
    if (!hasPg) return;
    store = await createStore(pgConfig(), silent);
    assert.equal(store.dialect, 'postgres');
  });

  after(async () => {
    if (!store) return;
    await purgeRunRows(store);
    await store.close();
  });

  /* ───────────────────────── migration cộng thêm ───────────────────────── */

  test('init() chạy LẦN HAI trên DB ĐÃ CÓ DỮ LIỆU vẫn không lỗi (migration idempotent)', { skip: skipNoPg }, async () => {
    // Có dữ liệu thật trong các bảng mà migration chạm tới — DB trắng không chứng minh được
    // rằng `ALTER TABLE`/`CREATE UNIQUE INDEX` không đụng dữ liệu cũ.
    const userId = newUserId('mig');
    const jobId = newJobId('mig');
    await store.createJob({ id: jobId, sessionId: 'pg-mig', source: 'test', userId });
    await store.appendLedger({ userId, amount: 3, reason: 'grant' });
    await store.recordUsage({ jobId, operation: 'OCR_DETECT', provider: 'mock', runKey: `${jobId}#1`, estimatedCost: 0.0004 });

    // init() lần hai qua một store MỚI (đúng cảnh hai tiến trình boot trên cùng DB).
    const second = await createStore(pgConfig(), silent);
    try {
      assert.equal(second.dialect, 'postgres');
      // Và lần BA ngay sau đó — vẫn phải im lặng thành công.
      const third = await createStore(pgConfig(), silent);
      await third.close();

      // Dữ liệu cũ KHÔNG được mất sau migration.
      assert.equal((await second.getJob(jobId)).user_id, userId, 'job cũ phải giữ nguyên user_id');
      assert.equal(await second.ledgerBalance(userId), 3, 'sổ credit cũ phải giữ nguyên');
    } finally {
      await second.close();
    }
  });

  test('mọi cột do migration thêm đều CÓ THẬT trên PostgreSQL', { skip: skipNoPg }, async () => {
    const cols = async (table) => {
      const rows = await store.driver.all(
        'SELECT column_name AS name FROM information_schema.columns WHERE table_name = ?',
        [table],
      );
      return rows.map((r) => r.name);
    };
    assert.ok((await cols('jobs')).includes('user_id'), 'MVP-05: thiếu jobs.user_id');
    assert.ok((await cols('jobs')).includes('kind'), 'MVP-02+: thiếu jobs.kind');
    for (const c of ['seq', 'run_key', 'close_kind']) {
      assert.ok((await cols('wallet_ledger')).includes(c), `MVP-05: thiếu wallet_ledger.${c}`);
    }
    assert.ok((await cols('usage_events')).includes('run_key'), 'BR-07: thiếu usage_events.run_key');
    for (const c of ['heartbeat_at', 'epoch']) {
      assert.ok((await cols('job_queue')).includes(c), `R1: thiếu job_queue.${c}`);
    }
    assert.ok((await cols('image_assets')).includes('user_id'), 'MVP-05 A4: thiếu image_assets.user_id');
  });

  test('partial unique index của sổ credit TỒN TẠI thật trên PostgreSQL', { skip: skipNoPg }, async () => {
    const rows = await store.driver.all(
      "SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'wallet_ledger'",
    );
    const names = rows.map((r) => r.name);
    for (const idx of ['uniq_wallet_ledger_run_close', 'uniq_wallet_ledger_run_reason']) {
      assert.ok(names.includes(idx), `thiếu partial unique index ${idx} — ràng buộc "một dòng đóng mỗi lượt" mất hiệu lực`);
    }
  });

  /* ───────────────────────── MVP-05 — tài khoản ───────────────────────── */

  test('users + user_sessions: vòng đời thật và COUNT(*) trả SỐ (không phải chuỗi BIGINT)', { skip: skipNoPg }, async () => {
    const userId = newUserId('acct');
    const email = `${userId}@example.test`;
    await store.createUser({ id: userId, email, displayName: 'Người dùng PG', role: 'member', passwordHash: 'x'.repeat(60) });

    const byEmail = await store.getUserByEmail(email);
    assert.equal(byEmail.id, userId);
    assert.equal(byEmail.display_name, 'Người dùng PG', 'tiếng Việt có dấu phải round-trip qua PostgreSQL');
    assert.equal(byEmail.status, 'active');

    // `COUNT(*)` của PostgreSQL là BIGINT ⇒ driver `pg` trả CHUỖI. Tầng store phải ép về số,
    // nếu không mọi phép so sánh `=== 1` và phân trang `countUsers()` đều sai âm thầm.
    const n = await store.countUsers();
    assert.equal(typeof n, 'number', `countUsers phải trả number, nhận ${typeof n}`);
    assert.ok(n >= 1);
    assert.equal(typeof (await store.countUsersByRole('member')), 'number', 'countUsersByRole phải trả number');

    // Phiên đăng nhập: DB chỉ giữ sha256, không giữ token thô.
    const tokenHash = 'a'.repeat(64);
    const sessionId = randomUUID();
    await store.createUserSession({
      id: sessionId, userId, tokenHash,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      userAgent: 'pg-test',
    });
    const session = await store.getUserSessionByTokenHash(tokenHash);
    assert.equal(session.id, sessionId);
    assert.equal(session.user_id, userId);

    await store.revokeUserSession(sessionId);
    const revoked = await store.getUserSessionByTokenHash(tokenHash);
    assert.ok(!revoked || revoked.revoked_at, 'phiên đã thu hồi không được dùng lại');

    await store.updateUser(userId, { display_name: 'Đã đổi tên', status: 'disabled' });
    const after = await store.getUserById(userId);
    assert.equal(after.display_name, 'Đã đổi tên');
    assert.equal(after.status, 'disabled');
  });

  test('jobs.user_id: listJobs/countJobs lọc ĐÚNG theo chủ sở hữu', { skip: skipNoPg }, async () => {
    const owner = newUserId('owner');
    const other = newUserId('other');
    const mine = [newJobId('own1'), newJobId('own2')];
    for (const id of mine) await store.createJob({ id, sessionId: 'pg-own', source: 'test', userId: owner });
    await store.createJob({ id: newJobId('oth1'), sessionId: 'pg-own', source: 'test', userId: other });

    const list = await store.listJobs({ userId: owner, limit: 50 });
    const ids = list.map((j) => j.id).sort();
    assert.deepEqual(ids, [...mine].sort(), 'listJobs theo userId chỉ được trả job của chính chủ');

    const count = await store.countJobs({ userId: owner });
    assert.equal(typeof count, 'number', 'countJobs phải trả number (BIGINT của PostgreSQL)');
    assert.equal(count, 2);
  });

  test('pricing: upsert IDEMPOTENT (ON CONFLICT DO UPDATE) và có giá cho MỌI operation', { skip: skipNoPg }, async () => {
    const list = await store.listPricing();
    const names = list.map((r) => r.operation);
    for (const op of USAGE_OPERATIONS) {
      assert.ok(names.includes(op), `thiếu dòng giá cho operation ${op} — priceOf() sẽ ném UNKNOWN_OPERATION`);
    }

    // Upsert hai lần: KHÔNG được đẻ dòng thứ hai, phải ghi đè giá.
    const op = USAGE_OPERATIONS[0];
    await store.upsertPricing({ operation: op, unitPrice: 0.111111, currency: 'USD', note: 'pg-test-1' });
    await store.upsertPricing({ operation: op, unitPrice: 0.222222, currency: 'USD', note: 'pg-test-2' });
    const rows = (await store.listPricing()).filter((r) => r.operation === op);
    assert.equal(rows.length, 1, 'upsert KHÔNG được nhân đôi dòng giá');
    assert.equal(rows[0].unit_price, 0.222222, 'upsert lần hai phải ghi đè giá');
    assert.equal(rows[0].note, 'pg-test-2');
  });

  /* ───────────────────────── BR-07 — usage theo LƯỢT CHẠY ───────────────────────── */

  test('usage_events.run_key: usageSummary tách chi phí theo TỪNG LƯỢT CHẠY', { skip: skipNoPg }, async () => {
    const jobId = newJobId('usage');
    await store.createJob({ id: jobId, sessionId: 'pg-usage', source: 'test' });
    const run1 = `${jobId}#1`;
    const run2 = `${jobId}#2`;

    await store.recordUsage({ jobId, operation: 'OCR_DETECT', provider: 'mock', runKey: run1, estimatedCost: 0.0004, inputUnits: 10, outputUnits: 1 });
    await store.recordUsage({ jobId, operation: 'TRANSLATION', provider: 'mock', runKey: run1, estimatedCost: 0.0008, inputUnits: 20, outputUnits: 2 });
    await store.recordUsage({ jobId, operation: 'OCR_DETECT', provider: 'mock', runKey: run2, estimatedCost: 0.0004, inputUnits: 30, outputUnits: 3 });

    const s1 = await store.usageSummary(jobId, { runKey: run1 });
    assert.equal(s1.events, 2, 'lượt #1 có 2 sự kiện');
    assert.equal(Math.round(s1.estimated_cost * 1e6) / 1e6, 0.0012, 'chi phí lượt #1 phải là tổng RIÊNG của lượt đó');

    const s2 = await store.usageSummary(jobId, { runKey: run2 });
    assert.equal(s2.events, 1);
    assert.equal(Math.round(s2.estimated_cost * 1e6) / 1e6, 0.0004, 'lượt #2 KHÔNG được cộng dồn chi phí lượt #1');

    const whole = await store.usageSummary(jobId);
    assert.equal(whole.events, 3, 'không truyền runKey ⇒ tổng cả job (tương thích ngược)');
    assert.equal(whole.input_units, 60, 'SUM(input_units) phải là số, không phải chuỗi');
    assert.equal(typeof whole.events, 'number');
  });

  test('usage_events.run_key NULL (dòng của DB cũ) được quy về lượt #1', { skip: skipNoPg }, async () => {
    const jobId = newJobId('legacy');
    await store.createJob({ id: jobId, sessionId: 'pg-usage', source: 'test' });
    // Dòng ghi TRƯỚC khi có cột `run_key` ⇒ run_key IS NULL.
    await store.recordUsage({ jobId, operation: 'CONTENT_GENERATE', provider: 'mock', estimatedCost: 0.004 });

    const first = await store.usageSummary(jobId, { runKey: `${jobId}#1` });
    assert.equal(first.events, 1, 'DB cũ phải quyết toán ĐÚNG cho lượt #1, không thu 0');

    const second = await store.usageSummary(jobId, { runKey: `${jobId}#2` });
    assert.equal(second.events, 0, 'lượt #2 KHÔNG được nhận chi phí của dòng cũ');
  });

  /* ───────────────────────── MVP-03 — meta của image_assets ───────────────────────── */

  test('MVP-03 image_assets.meta: JSON lồng nhau round-trip + updateImageAssetMeta', { skip: skipNoPg }, async () => {
    const jobId = newJobId('asset');
    await store.createJob({ id: jobId, sessionId: 'pg-asset', source: 'imagestudio', kind: 'image_generation' });

    const assetId = randomUUID();
    const meta = {
      matting: { provider: 'mock', is_mock: true, alpha_coverage: 0.4231 },
      compose: { background: '#ffffff', offsets: [12, -8] },
      retouch: { steps: ['denoise', 'sharpen'], params: { strength: 0.5, nested: { deep: [1, { k: 'v' }] } } },
      protected_pixels: true,
      note: 'tiếng Việt có dấu — giữ nguyên',
    };
    await store.createImageAsset({
      id: assetId, jobId, sessionId: 'pg-asset', role: 'rendered', parentId: null,
      mime: 'image/png', bytes: 4096, width: 512, height: 512,
      sha256: 'c'.repeat(64), storagePath: `${jobId}/${assetId}.png`, source: 'matting', meta,
    });

    const got = await store.getImageAsset(assetId);
    assert.deepEqual(got.meta, meta, 'meta MVP-03 phải round-trip Y NGUYÊN trên PostgreSQL');
    assert.equal(got.width, 512, 'số nguyên phải đọc lại là số');
    assert.equal(got.bytes, 4096);

    // Cập nhật meta tại chỗ (đường MVP-03 ghi kết quả từng bước).
    await store.updateImageAssetMeta(assetId, { ...meta, retouch: { ...meta.retouch, done: true } });
    const after = await store.getImageAsset(assetId);
    assert.equal(after.meta.retouch.done, true);
    assert.deepEqual(after.meta.matting, meta.matting, 'phần meta khác KHÔNG được mất khi cập nhật');

    const listed = await store.listImageAssets(jobId, { role: 'rendered' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, assetId);
  });

  /* ───────────────────────── MVP-04 — job video_generation ───────────────────────── */

  test('MVP-04 job video_generation: vòng đời + usage VIDEO_RENDER/VIDEO_ENCODE', { skip: skipNoPg }, async () => {
    const jobId = newJobId('video');
    await store.createJob({ id: jobId, sessionId: 'pg-video', source: 'videostudio', kind: 'video_generation' });

    const job = await store.getJob(jobId);
    assert.equal(job.kind, 'video_generation', 'jobs.kind phải giữ đúng kind của MVP-04');

    // listJobs phải trả `kind` (UI dùng cho badge).
    const list = await store.listJobs({ sessionId: 'pg-video', limit: 50 });
    assert.equal(list.find((j) => j.id === jobId)?.kind, 'video_generation');

    await store.recordUsage({ jobId, operation: 'VIDEO_RENDER', provider: 'purejs', runKey: `${jobId}#1`, estimatedCost: 0.0006, outputUnits: 30 });
    await store.recordUsage({ jobId, operation: 'VIDEO_ENCODE', provider: 'purejs', runKey: `${jobId}#1`, estimatedCost: 0.0004, outputUnits: 1 });
    const usage = await store.listUsage(jobId);
    assert.deepEqual(usage.map((u) => u.operation).sort(), ['VIDEO_ENCODE', 'VIDEO_RENDER']);
    assert.equal(usage.every((u) => u.run_key === `${jobId}#1`), true, 'usage của MVP-04 phải mang run_key');

    // Kết thúc job: JSON kế hoạch cảnh của MVP-04 nằm ở `content_meta` (xem allowlist cột
    // của `updateJob`) và phải round-trip y nguyên.
    const contentMeta = { kind: 'video_generation', preset: 'tiktok-9x16', plan_summary: { scenes: 3, duration_s: 30 } };
    const finishedAt = new Date().toISOString();
    await store.updateJob(jobId, { status: JOB_STATUS.SUCCEEDED, stage: 'done', content_meta: contentMeta, finished_at: finishedAt });
    const done = await store.getJob(jobId);
    assert.equal(done.status, 'succeeded');
    assert.deepEqual(done.content_meta, contentMeta, 'kế hoạch video (content_meta) phải round-trip trên PostgreSQL');
    assert.equal(done.finished_at, finishedAt, 'job succeeded phải có finished_at');

    // `updateJob` BỎ QUA cột ngoài allowlist (chống SQL injection qua tên cột) — trên
    // PostgreSQL cũng phải im lặng bỏ qua, KHÔNG được ném lỗi cột không tồn tại.
    assert.equal(await store.updateJob(jobId, { khong_co_cot_nay: 1 }), 0, 'cột lạ phải bị bỏ qua, không ném lỗi');
  });

  test('usageAggregate theo operation trả SỐ trên PostgreSQL (BIGINT/NUMERIC)', { skip: skipNoPg }, async () => {
    const jobId = newJobId('agg');
    await store.createJob({ id: jobId, sessionId: 'pg-agg', source: 'test' });
    await store.recordUsage({ jobId, operation: 'IMAGE_MATTING', provider: 'mock', estimatedCost: 0.002, inputUnits: 5, outputUnits: 1 });

    const rows = await store.usageAggregate({ groupBy: 'operation' });
    assert.ok(Array.isArray(rows) && rows.length > 0, 'usageAggregate phải trả mảng không rỗng');
    // Khoá nhóm tên là `group` (không phải `operation`) — hợp đồng §2.3 của route thống kê.
    const row = rows.find((r) => r.group === 'IMAGE_MATTING');
    assert.ok(row, `phải có dòng cho IMAGE_MATTING; nhận các nhóm: ${rows.map((r) => r.group).join(', ')}`);
    assert.equal(typeof row.events, 'number', `events phải là number, nhận ${typeof row.events}`);
    assert.equal(typeof row.estimated_cost, 'number', `estimated_cost phải là number, nhận ${typeof row.estimated_cost}`);
    assert.equal(typeof row.input_units, 'number', `input_units phải là number, nhận ${typeof row.input_units}`);
  });
});
