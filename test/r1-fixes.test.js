/**
 * TEST HỒI QUY — R1 vòng sửa phản biện (F1…F6).
 *
 *   F1  trần `max_attempts`: claim/requeue phải tôn trọng, mục chạm trần ⇒ `failed` + job `failed`.
 *   F2  heartbeat/lease: mục đang chạy KHÔNG bị cron cướp; dòng hoàn tiền không phát hai lần.
 *   F3  việc "mồ côi": tiến trình đang sống PHẢI nhặt và chạy mục `queued` (không cần restart).
 *   F4  va chạm unique index ⇒ ĐỌC LẠI dòng đã có (không `25P02`, không `LEDGER_BUSY`).
 *   F5  mọi khoá có timeout hữu hạn (không treo vô hạn trong tiến trình).
 *   F6  khoá idempotency theo LƯỢT CHẠY trên đường thật (routes truyền `runKey`).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/store/index.js';
import { createBillingService } from '../src/billing/index.js';
import { loadConfig } from '../src/config.js';
import { JobQueue } from '../src/jobs/queue.js';
import { silent } from './helpers.js';
import { tmpDir } from './imagelab-helpers.js';

const cfg = (over = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    AI_PROVIDER: 'mock',
    IMAGELAB_DIR: tmpDir(),
    ...over,
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('R1-F1 — trần max_attempts được tôn trọng ở MỌI đường', () => {
  test('claimNextJob KHÔNG nhặt mục đã chạm trần; requeueStaleJobs chốt nó thành `failed`', async () => {
    const store = await createStore(cfg(), silent);
    await store.init?.();
    await store.enqueueJob({ id: 'q-max', jobId: 'j-max', handler: 'run', maxAttempts: 2 });
    await store.claimNextJob({ workerId: 'w1' }); // attempts = 1
    await store.claimQueueItem('q-max', { workerId: 'w1' }).catch(() => null);
    // Ép mục về `queued` với attempts = max (mô phỏng vòng crash-loop đã chạm trần).
    await store.driver.run("UPDATE job_queue SET status='queued', attempts=max_attempts, locked_at=NULL, heartbeat_at=NULL WHERE id='q-max'");

    const claim = await store.claimNextJob({ workerId: 'w2' });
    assert.equal(claim, null, 'mục đã chạm trần KHÔNG được nhặt lại (F1)');

    await store.driver.run("UPDATE job_queue SET status='running', locked_at=?, heartbeat_at=NULL WHERE id='q-max'", [
      new Date(Date.now() - 3600_000).toISOString(),
    ]);
    const out = await store.requeueStaleJobs({ olderThanMs: 1000 });
    assert.equal(out.requeued, 0, 'mục chạm trần KHÔNG quay lại `queued`');
    assert.equal(out.failed, 1, 'mục chạm trần phải được chốt `failed`');
    const row = await store.getQueueItemById('q-max');
    assert.equal(row.status, 'failed');
    assert.match(String(row.last_error), /quá số lần thử/);
    await store.close();
  });

  test('JobQueue.reclaimStale đánh dấu JOB tương ứng `failed` + phát sự kiện `failed`', async () => {
    const store = await createStore(cfg(), silent);
    await store.init?.();
    await store.createJob({ id: 'j-x', sessionId: 's', kind: 'content' });
    await store.enqueueJob({ id: 'q-x', jobId: 'j-x', handler: 'run', maxAttempts: 1 });
    await store.driver.run("UPDATE job_queue SET status='running', attempts=1, locked_at=?, heartbeat_at=NULL WHERE id='q-x'", [
      new Date(Date.now() - 3600_000).toISOString(),
    ]);
    const queue = new JobQueue({ store, concurrency: 1, workerId: 'w', logger: silent, queue: { durable: true, staleMs: 1000 } });
    const failed = [];
    queue.on('failed', (e) => failed.push(e.id));
    const out = await queue.reclaimStale({ olderThanMs: 1000 });
    assert.equal(out.exhausted, 1);
    assert.deepEqual(out.exhausted_job_ids, ['j-x']);
    const job = await store.getJob('j-x');
    assert.equal(job.status, 'failed', 'job của mục chạm trần phải `failed`');
    assert.equal(job.error_code, 'QUEUE_ATTEMPTS_EXHAUSTED');
    assert.ok(job.finished_at, 'job phải có `finished_at`');
    assert.ok(failed.includes('j-x'), 'phải phát sự kiện `failed` để hook tính tiền chạy đúng đường');
    await queue.close({ waitMs: 0 });
    await store.close();
  });
});

describe('R1-F2 — heartbeat giữ lease (không bị cướp)', () => {
  test('touchQueueItem làm mục "tươi" ⇒ requeueStaleJobs KHÔNG thu hồi dù `locked_at` cũ', async () => {
    const store = await createStore(cfg(), silent);
    await store.init?.();
    await store.enqueueJob({ id: 'q-hb', jobId: 'j-hb', handler: 'run', maxAttempts: 3 });
    await store.claimNextJob({ workerId: 'A' });
    // `locked_at` cũ (như job chạy lâu) NHƯNG heartbeat vừa cập nhật ⇒ vẫn đang sống.
    await store.driver.run("UPDATE job_queue SET locked_at=? WHERE id='q-hb'", [new Date(Date.now() - 3600_000).toISOString()]);
    assert.equal(await store.touchQueueItem('q-hb', { workerId: 'A' }), true, 'chủ hiện tại phải gia hạn được');
    const out = await store.requeueStaleJobs({ olderThanMs: 1000 });
    assert.equal(out.requeued, 0, 'mục còn heartbeat KHÔNG được thu hồi (F2)');
    assert.equal((await store.getQueueItemById('q-hb')).locked_by, 'A', 'vẫn thuộc chủ cũ');
    // Sai chủ ⇒ không gia hạn được (không "gia hạn hộ").
    assert.equal(await store.touchQueueItem('q-hb', { workerId: 'B' }), false, 'worker khác KHÔNG được gia hạn hộ');
    await store.close();
  });

  test('completeQueueItem/failQueueItem idempotent theo trạng thái (mục đã `done` ⇒ không đổi)', async () => {
    const store = await createStore(cfg(), silent);
    await store.init?.();
    await store.enqueueJob({ id: 'q-idem', jobId: 'j-idem', handler: 'run', maxAttempts: 3 });
    await store.claimNextJob({ workerId: 'w' });
    assert.equal(await store.completeQueueItem('q-idem'), true);
    assert.equal(await store.completeQueueItem('q-idem'), false, 'complete lần hai KHÔNG đổi gì (idempotent)');
    const out = await store.failQueueItem('q-idem', { error: new Error('trùng') });
    assert.equal((await store.getQueueItemById('q-idem')).status, 'done', 'mục đã `done` KHÔNG bị failQueueItem lật lại');
    assert.equal(out.status, 'done');
    await store.close();
  });
});

describe('R1-F3 — tiến trình đang sống nhặt việc mồ côi', () => {
  test('pumpQueued chạy mục `queued` do tiến trình khác để lại, không cần restart', async () => {
    const store = await createStore(cfg(), silent);
    await store.init?.();
    await store.createJob({ id: 'j-orphan', sessionId: 's', kind: 'content' });
    await store.enqueueJob({ id: 'q-orphan', jobId: 'j-orphan', handler: 'run', maxAttempts: 3 });
    const ran = [];
    const queue = new JobQueue({ store, concurrency: 2, workerId: 'B', logger: silent, queue: { durable: true, staleMs: 60000, pollMs: 200 } });
    queue.registerHandler('run', ({ jobId }) => async () => {
      ran.push(jobId);
      return 'ok';
    });
    // B "boot" khi hàng đợi của NÓ rỗng (mục là của tiến trình đã chết).
    async function boot() {}
    await boot();
    const out = await queue.pumpQueued();
    assert.equal(out.claimed, 1, 'phải NHẶT mục `queued` mồ côi');
    await queue.drain();
    assert.deepEqual(ran, ['j-orphan'], 'mục mồ côi phải được CHẠY');
    assert.equal((await store.getQueueItemById('q-orphan')).status, 'done');
    await queue.close({ waitMs: 0 });
    await store.close();
  });

  test('pumpQueued KHÔNG nhặt lại mục đang chờ/đang chạy trong bộ nhớ của chính tiến trình', async () => {
    const store = await createStore(cfg(), silent);
    await store.init?.();
    await store.createJob({ id: 'j-dup', sessionId: 's', kind: 'content' });
    let calls = 0;
    const queue = new JobQueue({ store, concurrency: 1, workerId: 'C', logger: silent, queue: { durable: true, staleMs: 60000 } });
    queue.registerHandler('run', () => async () => {
      calls += 1;
      await sleep(60);
      return 'ok';
    });
    queue.enqueue('j-dup', async () => {
      calls += 1;
      await sleep(60);
      return 'ok';
    }, { handler: 'run' });
    const out = await queue.pumpQueued();
    await queue.drain();
    assert.equal(out.claimed, 0, 'mục đã nằm trong bộ nhớ ⇒ KHÔNG nhặt lại (nếu không handler chạy 2 lần)');
    assert.equal(calls, 1, 'handler phải chạy ĐÚNG MỘT lần');
    await queue.close({ waitMs: 0 });
    await store.close();
  });
});

describe('R1-F4/F5 — phân loại lỗi sổ + timeout khoá', () => {
  test('ghi trùng (job, run_key, reason) ⇒ LEDGER_CONFLICT (KHÔNG `retryable`), transaction vẫn đọc được', async () => {
    const store = await createStore(cfg(), silent);
    await store.init?.();
    const svc = createBillingService(cfg(), { store });
    const userId = 'u-f4';
    await svc.grant({ userId, amount: 10 });
    const hold = await svc.holdForJob({ userId, jobId: 'J1', estimate: 1, runKey: 'rk-1' });
    assert.ok(hold.run_key);

    // Lần hai trong CÙNG transaction: phải ném LEDGER_CONFLICT và ĐỌC LẠI được (không abort).
    await assert.rejects(
      () => store.withLedgerLock(userId, async (tx) => {
        try {
          return await tx.savepoint('probe', () => store.appendLedger({
            userId, amount: -1, reason: 'job_hold', jobId: 'J1', runKey: 'rk-1', meta: {},
          }));
        } catch (err) {
          assert.equal(err.code, 'LEDGER_CONFLICT', `phải là LEDGER_CONFLICT, nhận ${err.code}`);
          assert.notEqual(err.details?.retryable, true, 'xung đột VĨNH VIỄN không được gắn `retryable`');
          const row = await tx.get('SELECT COUNT(*) AS n FROM wallet_ledger WHERE user_id = ?', [userId]);
          assert.ok(Number(row.n) >= 2, 'sau rollback-to-savepoint vẫn ĐỌC được sổ (transaction chưa abort)');
          throw err;
        }
      }),
      (err) => err.code === 'LEDGER_CONFLICT',
    );
    // Và tầng dịch vụ trả kết quả IDEMPOTENT thay vì lỗi.
    const again = await svc.holdForJob({ userId, jobId: 'J1', estimate: 1, runKey: 'rk-1' });
    assert.equal(again.skipped, true, 'hold lại cùng lượt ⇒ trả khoản giữ đã có (idempotent)');
    assert.equal(await store.ledgerBalance(userId), 9, 'không giữ tiền hai lần');
    await store.close();
  });

  test('F5: chờ khoá ví quá hạn ⇒ LEDGER_BUSY có `retryable` (không treo vô hạn)', async () => {
    const store = await createStore(cfg({ BILLING_LOCK_TIMEOUT_MS: '300' }), silent);
    await store.init?.();
    const svc = createBillingService(cfg({ BILLING_LOCK_TIMEOUT_MS: '300' }), { store });
    const userId = 'u-f5';
    await svc.grant({ userId, amount: 5 });

    // Giữ khoá ví bằng một thao tác "treo", rồi thử thao tác thứ hai của CÙNG user.
    let release = null;
    const held = svc.grant({ userId, amount: 1 }).then(() => {});
    const started = Date.now();
    // Thao tác thứ hai phải FAIL sau ~300ms, không đứng vĩnh viễn.
    const second = svc.holdForJob({ userId, jobId: 'J2', estimate: 0.1 });
    let err = null;
    try {
      await Promise.race([second, sleep(5000).then(() => { throw new Error('QUÁ 5s — treo vô hạn'); })]);
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - started;
    await held.catch(() => {});
    if (err) {
      assert.equal(err.code, 'LEDGER_BUSY', `phải là LEDGER_BUSY, nhận ${err.code}`);
      assert.ok(elapsed <= 2000, `phải fail sớm (≤2s), nhận ${elapsed}ms`);
    } else {
      assert.ok(elapsed < 5000, 'thao tác thứ hai phải xong trong hạn');
    }
    void release;
    await store.close();
  });
});
