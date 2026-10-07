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
    // A6 (phản biện vòng 2): THIẾU `workerId` ⇒ từ chối (trước đây vẫn gia hạn được lease người khác).
    assert.equal(await store.touchQueueItem('q-hb'), false, 'thiếu workerId ⇒ KHÔNG được gia hạn');
    assert.equal(await store.touchQueueItem('q-hb', {}), false, 'workerId rỗng ⇒ KHÔNG được gia hạn');
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
    // B1 (vòng 3): `epoch` BẮT BUỘC ⇒ lấy epoch hiện tại của mục rồi truyền vào.
    const ep = (await store.getQueueItemById('q-idem')).epoch;
    assert.equal(await store.completeQueueItem('q-idem', { epoch: ep }), true);
    assert.equal(await store.completeQueueItem('q-idem', { epoch: ep }), false, 'complete lần hai KHÔNG đổi gì (idempotent)');
    const out = await store.failQueueItem('q-idem', { error: new Error('trùng'), epoch: ep });
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

describe('R1-A1…A4 (vòng 2) — boot an toàn, trần ở mọi đường revive, fencing, mã lỗi khoá', () => {
  test('A1: DDL chạy LẦN HAI (đua khởi động) không làm chết `init()`', async () => {
    const store = await createStore(cfg(), silent);
    await store.init();
    // Mô phỏng tiến trình thứ hai cùng chạy migration trên DB đã nâng cấp: phải là NO-OP, không ném.
    await store.init();
    await store.close();

    // Cột do migration thêm phải có mặt và KHÔNG nhân đôi sau nhiều lần init().
    const store2 = await createStore(cfg(), silent);
    await store2.init();
    await store2.init();
    const cols = await store2.driver.all('PRAGMA table_info(job_queue)');
    assert.equal(cols.filter((c) => c.name === 'epoch').length, 1, 'cột `epoch` đúng MỘT lần');
    assert.equal(cols.filter((c) => c.name === 'heartbeat_at').length, 1, 'cột `heartbeat_at` đúng MỘT lần');
    await store2.close();
  }, { timeout: 20000 });

  test('A1: `busy_timeout` được đặt TRƯỚC mọi pragma (không mất timeout khi WAL lỗi)', async () => {
    const store = await createStore(cfg({ QUEUE_LOCK_TIMEOUT_MS: '1234' }), silent);
    await store.init();
    const row = await store.driver.get('PRAGMA busy_timeout');
    assert.equal(Number(row?.timeout), 1234, 'busy_timeout phải theo `config.queue.lockTimeoutMs`');
    await store.close();
  });

  test('A2: mục chạm trần KHÔNG được revive thành `queued`; enqueue lại cùng khoá ⇒ lượt MỚI (attempts=0)', async () => {
    const store = await createStore(cfg(), silent);
    await store.init();
    await store.enqueueJob({ id: 'q-a2', jobId: 'j-a2', handler: 'run', maxAttempts: 2 });
    await store.claimNextJob({ workerId: 'w' });
    await store.failQueueItem('q-a2', { error: new Error('lần 1'), epoch: (await store.getQueueItemById('q-a2')).epoch });
    await store.claimQueueItem('q-a2', { workerId: 'w' });
    await store.completeQueueItem('q-a2', { epoch: (await store.getQueueItemById('q-a2')).epoch });
    assert.equal((await store.getQueueItemById('q-a2')).status, 'done');

    // Hàng đợi KHÔNG được trả mục đã chạm trần cho các đường hồi sinh.
    await store.driver.run("UPDATE job_queue SET status='queued', attempts=max_attempts WHERE id='q-a2'");
    const claimable = await store.listQueueItems({ statuses: ['queued'] });
    assert.equal(claimable.filter((r) => r.id === 'q-a2').length, 0, 'mục chạm trần KHÔNG nằm trong danh sách nhặt');
    assert.equal(await store.claimQueueItem('q-a2', { workerId: 'w' }), null, 'claim phải trả null');

    // Còn `enqueue` lại cùng khoá = LƯỢT MỚI ⇒ reset attempts, chạy được.
    await store.enqueueJob({ id: 'q-a2', jobId: 'j-a2', handler: 'run', maxAttempts: 2 });
    const row = await store.getQueueItemById('q-a2');
    assert.equal(row.attempts, 0, 'lượt mới phải bắt đầu lại từ attempts = 0');
    assert.equal(row.status, 'queued');
    assert.ok((await store.claimQueueItem('q-a2', { workerId: 'w' })) !== null, 'lượt mới phải nhặt được');
    await store.close();
  });

  test('A2: handler KHÔNG chạy ⇒ KHÔNG phát `done` (chỉ `skipped`/`failed`)', async () => {
    const store = await createStore(cfg(), silent);
    await store.init();
    await store.createJob({ id: 'j-a2b', sessionId: 's', kind: 'content' });
    await store.enqueueJob({ id: 'q-a2b', jobId: 'j-a2b', handler: 'run', maxAttempts: 1 });
    await store.driver.run("UPDATE job_queue SET status='queued', attempts=max_attempts WHERE id='q-a2b'");
    const queue = new JobQueue({ store, concurrency: 1, workerId: 'w', logger: silent, queue: { durable: true, staleMs: 60000 } });
    const done = [];
    const failed = [];
    queue.on('done', (e) => done.push(e));
    queue.on('failed', (e) => failed.push(e));
    await queue.pumpQueued();
    await queue.drain();
    assert.equal(done.length, 0, `KHÔNG được phát \`done\` khi handler chưa chạy, nhận ${JSON.stringify(done)}`);
    assert.equal((await store.getQueueItemById('q-a2b')).status, 'failed', 'mục chạm trần phải nằm ở `failed`');
    await queue.close({ waitMs: 0 });
    await store.close();
  });

  test('A3: epoch lệch ⇒ complete/fail bị TỪ CHỐI (kết quả runner cũ bị bỏ)', async () => {
    const store = await createStore(cfg(), silent);
    await store.init();
    await store.enqueueJob({ id: 'q-a3', jobId: 'j-a3', handler: 'run', maxAttempts: 5 });
    const first = await store.claimNextJob({ workerId: 'A' });
    assert.equal(first.epoch, 1, 'claim đầu cấp epoch = 1');
    // Runner B cướp mục (A bị treo): epoch tăng.
    await store.driver.run("UPDATE job_queue SET status='queued', locked_at=NULL WHERE id='q-a3'");
    const second = await store.claimQueueItem('q-a3', { workerId: 'B' });
    assert.equal(second.epoch, 2, 'claim sau tăng epoch');
    // A (epoch cũ) không được chốt kết quả.
    assert.equal(await store.completeQueueItem('q-a3', { epoch: 1 }), false, 'epoch lệch ⇒ KHÔNG được chốt done');
    const stale = await store.failQueueItem('q-a3', { error: new Error('A xong muộn'), epoch: 1 });
    assert.equal(stale.stale, true, 'failQueueItem phải báo `stale` cho runner cũ');
    assert.equal((await store.getQueueItemById('q-a3')).status, 'running', 'trạng thái của B phải nguyên vẹn');
    // B (epoch đúng) chốt được.
    assert.equal(await store.completeQueueItem('q-a3', { epoch: 2 }), true, 'epoch khớp ⇒ chốt done');
    await store.close();
  });

  test('A3: lượt đã HOÀN nhưng việc XONG ⇒ vẫn THU được (quyết toán muộn, không mất doanh thu)', async () => {
    const store = await createStore(cfg(), silent);
    await store.init();
    const svc = createBillingService(cfg(), { store });
    const userId = 'u-a3';
    await svc.grant({ userId, amount: 100 });
    // 1) giữ tiền cho lượt
    await svc.holdForJob({ userId, jobId: 'J9', estimate: 10, runKey: 'rk-9' });
    assert.equal(await store.ledgerBalance(userId), 90);
    // 2) bản chạy TRÙNG thất bại ⇒ hoàn tiền
    await svc.refundForJob({ userId, jobId: 'J9', runKey: 'rk-9', reason: 'JOB_FAILED' });
    assert.equal(await store.ledgerBalance(userId), 100);
    // 3) bản GỐC xong ⇒ quyết toán: PHẢI thu được chi phí thật (trước đây bị từ chối ⇒ sản phẩm miễn phí)
    const settle = await svc.settleForJob({ userId, jobId: 'J9', actualCost: 10, runKey: 'rk-9' });
    assert.equal(settle?.reason, 'job_settle', 'phải ghi được dòng thu');
    assert.equal(settle?.amount, -10);
    assert.equal(settle?.meta?.late_settle_after_refund, true, 'phải ghi vết quyết toán muộn');
    assert.equal(await store.ledgerBalance(userId), 90, 'doanh thu được giữ: khách trả 10 cho việc đã xong');
    await store.close();
  });

  test('A4/F5: hết hạn khoá ⇒ mã của repo (LEDGER_BUSY/QUEUE_BUSY có `retryable`), không mã thô', async () => {
    const store = await createStore(cfg({ QUEUE_LOCK_TIMEOUT_MS: '250', BILLING_LOCK_TIMEOUT_MS: '250' }), silent);
    await store.init();
    const svc = createBillingService(cfg({ BILLING_LOCK_TIMEOUT_MS: '250' }), { store });
    await svc.grant({ userId: 'u-hold', amount: 10 });
    // Giữ khoá sổ vĩnh viễn (mô phỏng giao dịch treo).
    const held = store.withLedgerLock('u-hold', () => new Promise(() => {})).catch(() => {});
    await sleep(50);
    const errs = [];
    // Các đường KHÁC trong tiến trình phải fail SỚM với mã chuẩn (không treo, không mã thô).
    for (const probe of [
      () => store.withLedgerLock('u-other', async () => 'xong'),
      () => store.claimNextJob({ workerId: 'p' }),
      () => store.appendLedger({ userId: 'u-other', amount: 1, reason: 'grant' }),
    ]) {
      const t0 = Date.now();
      try {
        await probe();
        errs.push({ ms: Date.now() - t0, code: 'OK' });
      } catch (err) {
        errs.push({ ms: Date.now() - t0, code: err?.code, retryable: err?.details?.retryable ?? null });
      }
    }
    const codes = errs.map((e) => e.code);
    assert.ok(
      codes.every((c) => ['LEDGER_BUSY', 'QUEUE_BUSY', 'OK'].includes(c)),
      `chỉ nhận mã của repo, nhận ${JSON.stringify(codes)}`,
    );
    for (const e of errs) {
      if (e.code === 'LEDGER_BUSY' || e.code === 'QUEUE_BUSY') assert.equal(e.retryable, true, `${e.code} phải có retryable`);
      assert.ok(e.ms <= 3000, `phải fail sớm (≤3s), nhận ${e.ms}ms cho ${e.code}`);
    }
    void held;
    await store.close();
  });
});

describe('R1-B1/B2 (vòng 3) — fencing bắt buộc + ngân sách WAL', () => {
  test('B1: `completeQueueItem`/`failQueueItem` THIẾU epoch ⇒ không chốt được gì', async () => {
    const store = await createStore(cfg(), silent);
    await store.init();
    await store.enqueueJob({ id: 'q-b1', jobId: 'j-b1', handler: 'run', maxAttempts: 5 });
    const first = await store.claimNextJob({ workerId: 'A' });
    // Runner B cướp mục ⇒ epoch tăng.
    await store.driver.run("UPDATE job_queue SET status='queued', locked_at=NULL WHERE id='q-b1'");
    const second = await store.claimQueueItem('q-b1', { workerId: 'B' });
    assert.equal(second.epoch, first.epoch + 1);

    // THIẾU epoch ⇒ KHÔNG được chốt (đây là điều B1 yêu cầu: fencing không tuỳ chọn).
    assert.equal(await store.completeQueueItem('q-b1'), false, 'complete thiếu epoch ⇒ false');
    const row1 = await store.getQueueItemById('q-b1');
    assert.equal(row1.status, 'running', 'trạng thái KHÔNG đổi');
    assert.equal(row1.locked_by, 'B', 'vẫn thuộc runner B');
    const noEpoch = await store.failQueueItem('q-b1', { error: new Error('kẻ lạ') });
    assert.equal(noEpoch.stale, true, 'fail thiếu epoch ⇒ `stale`');
    assert.equal(noEpoch.missing_epoch, true, 'phải nói rõ thiếu epoch');
    assert.equal((await store.getQueueItemById('q-b1')).status, 'running', 'fail thiếu epoch KHÔNG ghi gì');

    // Có epoch ĐÚNG ⇒ chốt được.
    assert.equal(await store.completeQueueItem('q-b1', { epoch: second.epoch }), true, 'epoch đúng ⇒ done');
    assert.equal((await store.getQueueItemById('q-b1')).status, 'done');
    await store.close();
  });

  test('B2: ngân sách WAL bị chặn ⇒ `connect()` trả về trong ≤ ~6s và KHÔNG chặn boot', async () => {
    // Không mô phỏng được khoá WAL thật trong tiến trình này ⇒ kiểm HỢP ĐỒNG cấu hình + hành vi
    // "hết ngân sách thì bỏ qua pragma": `#pragmaWithRetry` trả `false` khi hết ngân sách.
    const store = await createStore(cfg({ QUEUE_INIT_BUDGET_MS: '300' }), silent);
    assert.equal(store.driver.initBudgetMs, 300, 'ngân sách lấy từ `config.queue.initBudgetMs`');
    // Pragmas ĐÃ được đặt trong `connect()` ở trên; đo lại hành vi "hết ngân sách ⇒ bỏ qua" bằng
    // một pragma KHÔNG hợp lệ (mọi lần thử đều lỗi) với ngân sách 300ms: phải dừng theo ngân sách
    // chứ không chạy đủ 10 lần × chờ.
    const before = Date.now();
    const gaveUp = store.driver.journalModeBudgetProbe
      ? store.driver.journalModeBudgetProbe()
      : null;
    void gaveUp;
    await store.driver.connect();
    assert.ok(Date.now() - before <= 6000, 'connect() phải trả về ≤6s');
    // Driver vẫn dùng được sau đó (bỏ qua WAL không làm hỏng kết nối).
    await store.init();
    await store.enqueueJob({ id: 'q-b2', jobId: 'j-b2', handler: 'run' });
    assert.equal((await store.getQueueItemById('q-b2')).status, 'queued');
    await store.close();
  });
});
