/**
 * R1 (§2) — HÀNG ĐỢI BỀN: `src/store/**` (bảng `job_queue`) + `src/jobs/queue.js`.
 *
 * Sprint độ tin cậy không thêm tính năng — nó làm hàng đợi **không mất việc** khi tiến trình
 * chết và **không chạy hai lần** khi có nhiều tiến trình. Test ở đây khẳng định ĐÚNG những
 * điều đó bằng HÀNH VI THẬT trên store SQLite thật (không cần mạng, không cần PG):
 *
 *   1. Ghi DB TRƯỚC khi chạy (mục việc có thật trong `job_queue` lúc handler chạy).
 *   2. `claimNextJob` NGUYÊN TỬ trong một tiến trình: hai lần nhặt ⇒ hai mục khác nhau,
 *      mục `running` không bao giờ bị nhặt lại.
 *   3. `completeQueueItem` / `failQueueItem` đổi trạng thái đúng; hết lượt ⇒ `failed`.
 *   4. `requeueStaleJobs` trả mục `running` QUÁ CŨ về `queued` + `locked_at = null`,
 *      KHÔNG đụng mục đang chạy bình thường.
 *   5. `queueStats()` đúng 4 khoá của hợp đồng §2.2.
 *   6. `resume()` khôi phục mục `queued` + mục `running` quá cũ rồi CHẠY LẠI ĐƯỢC.
 *   7. Retry: lần 1–2 ⇒ còn `queued`; lần 3 ⇒ `failed` + job `failed` có `error_code`/`finished_at`.
 *   8. Idempotent theo LƯỢT CHẠY (`runKey`): enqueue 2 lần ⇒ 1 mục, handler chạy 1 lần —
 *      kể cả khi hai lời gọi đến từ hai `JobQueue` khác nhau (mô phỏng 2 tiến trình).
 *   9. HỒI QUY `test/imagelab-concurrency.test.js`: hai LƯỢT khác nhau (hai closure khác nhau,
 *      hoặc khác `runKey`) ⇒ PHẢI là 2 mục và chạy CẢ HAI — gộp lại là nuốt mất một lượt
 *      người dùng đã trả tiền (MVP-05 §BR-02).
 *  10. `QUEUE_DURABLE=false` ⇒ KHÔNG ghi dòng DB nào, hành vi bộ nhớ cũ nguyên vẹn.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createStore } from '../src/store/index.js';
import { JobQueue, QUEUE_DEFAULTS, resolveHandlerName } from '../src/jobs/queue.js';
import { startImagelabApp } from './imagelab-helpers.js';
import { testConfig, silent } from './helpers.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Store SQLite in-memory thật + cấu hình hàng đợi nhanh (backoff 0 ⇒ test tất định, không chờ). */
async function makeStoreAndQueue(overrides = {}, queueOverrides = {}) {
  const config = testConfig({ QUEUE_RETRY_BASE_MS: '0', QUEUE_MAX_ATTEMPTS: '3', ...overrides });
  const store = await createStore(config, silent);
  const queue = new JobQueue({
    store,
    logger: silent,
    queue: { ...config.queue, ...queueOverrides },
  });
  return { config, store, queue };
}

const countQueueRows = async (store) => {
  const row = await store.driver.get('SELECT COUNT(*) AS n FROM job_queue');
  return Number(row?.n ?? 0);
};

const rowsOfJob = (store, jobId) =>
  store.driver.all('SELECT * FROM job_queue WHERE job_id = ? ORDER BY created_at ASC, id ASC', [jobId]);

/** Chờ có điều kiện (tất định, có trần) — KHÔNG phụ thuộc một khoảng thời gian cố định. */
async function waitFor(check, { tries = 200, delay = 10, label = 'điều kiện' } = {}) {
  for (let i = 0; i < tries; i += 1) {
    const value = await check();
    if (value) return value;
    await sleep(delay);
  }
  throw new Error(`Hết ${tries} lần chờ mà ${label} vẫn chưa đúng.`);
}

describe('R1 · §2.2 — method hàng đợi bền ở tầng store', () => {
  test('enqueueJob ghi DB TRƯỚC khi chạy; completeQueueItem đổi trạng thái đúng', async () => {
    const { store, queue } = await makeStoreAndQueue();
    try {
      const jobId = `job-${randomUUID()}`;
      await store.createJob({ id: jobId });
      let statusAtRun = null;
      let attemptsAtRun = null;

      queue.enqueue(jobId, async () => {
        // Lúc handler chạy, mục việc ĐÃ nằm trong DB (ghi trước) và đang `running` (đã nhặt).
        const row = await store.getQueueItem(jobId);
        assert.ok(row, 'mục hàng đợi phải có trong DB trước khi handler chạy');
        statusAtRun = row.status;
        attemptsAtRun = row.attempts;
        return 'xong';
      }, { runKey: 'run-1' });

      assert.equal(queue.isPending(jobId), true, 'isPending phải đúng NGAY sau enqueue (hành vi cũ)');
      await queue.drain();

      assert.equal(statusAtRun, 'running', 'trong handler, mục phải đang `running` (đã được nhặt)');
      assert.equal(attemptsAtRun, 1, 'lần chạy đầu tiên ⇒ attempts = 1 (DB là nguồn sự thật)');

      const row = await store.getQueueItem(jobId);
      assert.equal(row.status, 'done');
      assert.ok(row.finished_at, 'mục xong phải có `finished_at`');
      assert.equal(row.locked_at, null, 'mục xong phải nhả khoá');
      assert.equal(await store.completeQueueItem(row.id), false, 'mục đã `done` ⇒ complete lần hai trả false');
      assert.deepEqual(await store.queueStats(), { queued: 0, running: 0, done: 1, failed: 0 });
    } finally {
      await queue.close().catch(() => {});
      await store.close();
    }
  });

  test('claimNextJob NGUYÊN TỬ: hai lần nhặt ⇒ hai mục khác nhau, mục `running` không bị nhặt lại', async () => {
    const { store } = await makeStoreAndQueue();
    try {
      await store.enqueueJob({ id: 'q-1', jobId: 'j-1', kind: 'content', handler: 'run' });
      await store.enqueueJob({ id: 'q-2', jobId: 'j-2', kind: 'content', handler: 'run' });

      const first = await store.claimNextJob({ workerId: 'w-1' });
      const second = await store.claimNextJob({ workerId: 'w-1' });
      const third = await store.claimNextJob({ workerId: 'w-1' });

      assert.ok(first && second, 'phải nhặt được đúng hai mục đã xếp');
      assert.notEqual(first.id, second.id, 'hai lần nhặt KHÔNG được trả về cùng một mục');
      assert.deepEqual([first.id, second.id].sort(), ['q-1', 'q-2'].sort());
      assert.equal(third, null, 'hết mục `queued` ⇒ trả null (không nhặt lại mục `running`)');
      for (const item of [first, second]) {
        assert.equal(item.status, 'running');
        assert.equal(item.attempts, 1, 'mỗi lần nhặt tăng attempts đúng 1');
        assert.equal(item.locked_by, 'w-1');
        assert.ok(item.locked_at, 'mục `running` phải có `locked_at`');
      }
      // Nhặt ĐÚNG một mục đã `running` (đường `claimQueueItem` của JobQueue) ⇒ null.
      assert.equal(await store.claimQueueItem('q-1', { workerId: 'w-2' }), null);
      // Nhặt mục không tồn tại ⇒ null, không ném.
      assert.equal(await store.claimQueueItem('khong-ton-tai', { workerId: 'w-2' }), null);
      assert.deepEqual(await store.queueStats(), { queued: 0, running: 2, done: 0, failed: 0 });
    } finally {
      await store.close();
    }
  });

  test('failQueueItem: còn lượt ⇒ `queued` + backoff; hết lượt ⇒ `failed` + finished_at + last_error', async () => {
    const { store } = await makeStoreAndQueue();
    try {
      await store.enqueueJob({ id: 'q-retry', jobId: 'j-retry', maxAttempts: 2 });
      await store.claimNextJob({ workerId: 'w-1' });

      const retry = await store.failQueueItem('q-retry', { error: Object.assign(new Error('hỏng tạm'), { code: 'TAM' }), retryDelayMs: 5000 });
      assert.equal(retry.status, 'queued', 'attempts 1 < max 2 ⇒ trả về `queued`');
      assert.equal(retry.attempts, 1);
      let row = await store.getQueueItemById('q-retry');
      assert.equal(row.status, 'queued');
      assert.equal(row.locked_at, null, 'trả về hàng đợi phải nhả khoá');
      assert.equal(row.finished_at, null);
      assert.ok(Date.parse(row.run_after) > Date.now(), 'phải có `run_after` trong tương lai (backoff)');
      assert.match(row.last_error, /TAM: hỏng tạm/, 'last_error phải giữ mã lỗi để vận hành đọc được');

      // Chưa tới `run_after` (backoff 5s) ⇒ KHÔNG được nhặt.
      assert.equal(await store.claimNextJob({ workerId: 'w-1' }), null, 'chưa tới `run_after` thì không nhặt');
      // Tới hạn (giả lập đồng hồ) ⇒ nhặt được, attempts = 2 = max.
      const secondClaim = await store.claimNextJob({ workerId: 'w-1', now: new Date(Date.now() + 6000).toISOString() });
      assert.equal(secondClaim.attempts, 2);
      const dead = await store.failQueueItem('q-retry', { error: new Error('hỏng hẳn'), retryDelayMs: 5000 });
      assert.equal(dead.status, 'failed', 'hết lượt ⇒ `failed`');
      row = await store.getQueueItemById('q-retry');
      assert.equal(row.status, 'failed');
      assert.ok(row.finished_at, 'mục hỏng hẳn phải có `finished_at`');
      assert.equal(row.run_after, null);
      assert.deepEqual(await store.queueStats(), { queued: 0, running: 0, done: 0, failed: 1 });
    } finally {
      await store.close();
    }
  });

  test('requeueStaleJobs: chỉ mục `running` QUÁ CŨ về `queued` + locked_at=null', async () => {
    const { store } = await makeStoreAndQueue();
    try {
      const old = new Date(Date.now() - 3600_000).toISOString();
      const fresh = new Date().toISOString();
      await store.enqueueJob({ id: 'q-cu', jobId: 'j-cu' });
      await store.enqueueJob({ id: 'q-moi', jobId: 'j-moi' });
      await store.enqueueJob({ id: 'q-cho', jobId: 'j-cho' }); // vẫn `queued` ⇒ không đụng tới
      await store.driver.run("UPDATE job_queue SET status='running', locked_at=?, locked_by='w-cu' WHERE id='q-cu'", [old]);
      await store.driver.run("UPDATE job_queue SET status='running', locked_at=?, locked_by='w-moi' WHERE id='q-moi'", [fresh]);

      const out = await store.requeueStaleJobs({ olderThanMs: 60_000 });
      assert.equal(out.requeued, 1);
      assert.deepEqual(out.ids, ['q-cu']);

      const cu = await store.getQueueItemById('q-cu');
      assert.equal(cu.status, 'queued');
      assert.equal(cu.locked_at, null, 'mục thu hồi phải có `locked_at = null` (§2.2)');
      assert.equal(cu.locked_by, null);
      assert.equal((await store.getQueueItemById('q-moi')).status, 'running', 'mục đang chạy bình thường KHÔNG được thu hồi');
      assert.equal((await store.getQueueItemById('q-cho')).status, 'queued');
      assert.deepEqual(await store.queueStats(), { queued: 2, running: 1, done: 0, failed: 0 });
    } finally {
      await store.close();
    }
  });

  test('queueStats() trả ĐÚNG bốn khoá của hợp đồng §2.2', async () => {
    const { store } = await makeStoreAndQueue();
    try {
      const stats = await store.queueStats();
      assert.deepEqual(Object.keys(stats).sort(), ['done', 'failed', 'queued', 'running']);
      for (const value of Object.values(stats)) assert.equal(typeof value, 'number');
    } finally {
      await store.close();
    }
  });

  test('resume(): khôi phục mục `queued` + mục `running` quá cũ rồi CHẠY LẠI ĐƯỢC', async () => {
    const config = testConfig({ QUEUE_RETRY_BASE_MS: '0' });
    const store = await createStore(config, silent);
    try {
      const old = new Date(Date.now() - 3600_000).toISOString();
      const fresh = new Date().toISOString();
      await store.enqueueJob({ id: 'q-queued', jobId: 'j-queued', kind: 'content', handler: 'run', payload: { sessionId: 's-1' } });
      await store.enqueueJob({ id: 'q-stale', jobId: 'j-stale', kind: 'content', handler: 'run' });
      await store.enqueueJob({ id: 'q-fresh', jobId: 'j-fresh', kind: 'content', handler: 'run' });
      await store.driver.run("UPDATE job_queue SET status='running', locked_at=? WHERE id='q-stale'", [old]);
      await store.driver.run("UPDATE job_queue SET status='running', locked_at=? WHERE id='q-fresh'", [fresh]);

      // "Tiến trình mới": cùng DB, hàng đợi mới tinh, không còn closure cũ.
      const queue = new JobQueue({ store, logger: silent, queue: { ...config.queue, staleMs: 60_000 } });
      const ran = [];
      queue.registerHandler('run', async ({ jobId, payload }) => () => {
        ran.push({ jobId, sessionId: payload?.sessionId ?? null });
      });

      const out = await queue.resume();
      assert.deepEqual(out, { durable: true, requeued: 1, restored: 2, skipped: 0 },
        'mục `running` quá cũ ⇒ requeued; hai mục `queued` ⇒ restored');
      await queue.drain();

      assert.deepEqual(ran.map((r) => r.jobId).sort(), ['j-queued', 'j-stale'], 'việc đang chờ KHÔNG được mất khi khởi động lại');
      assert.equal(ran.find((r) => r.jobId === 'j-queued').sessionId, 's-1', 'payload nhỏ phải được khôi phục theo mục');
      assert.equal((await store.getQueueItemById('q-queued')).status, 'done');
      assert.equal((await store.getQueueItemById('q-stale')).status, 'done');
      const freshRow = await store.getQueueItemById('q-fresh');
      assert.equal(freshRow.status, 'running', 'mục `running` CHƯA quá cũ vẫn thuộc tiến trình khác — không được giẫm vào');
      assert.equal(freshRow.locked_at, fresh);
    } finally {
      await store.close();
    }
  });

  test('close() giữa chừng KHÔNG mất việc: mục chưa chạy vẫn `queued` trong DB ⇒ resume() chạy nốt', async () => {
    const config = testConfig({ QUEUE_RETRY_BASE_MS: '0' });
    const store = await createStore(config, silent);
    try {
      const queue = new JobQueue({ store, logger: silent, concurrency: 1, queue: config.queue });
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const started = [];
      for (const id of ['j-1', 'j-2', 'j-3']) {
        await store.createJob({ id });
        queue.enqueue(id, async () => { started.push(id); if (id === 'j-1') await gate; return id; }, { runKey: `rk-${id}` });
      }
      // Chờ CẢ BA mục đã xuống DB (ghi trước khi chạy) và mục đầu đã bắt đầu chạy.
      await waitFor(async () => (await countQueueRows(store)) === 3 && started.includes('j-1'), { label: 'ba mục vào DB + j-1 chạy' });

      await queue.close({ waitMs: 0 }); // "tiến trình tắt đột ngột" — không chờ việc đang chạy
      release();
      await waitFor(async () => (await store.getQueueItem('j-3'))?.status === 'queued', { label: 'j-3 còn queued' });

      const queuedRows = await store.driver.all("SELECT id FROM job_queue WHERE status = 'queued' ORDER BY id");
      assert.equal(queuedRows.length, 2, 'hai mục chưa chạy phải còn `queued` trong DB (việc KHÔNG mất)');

      // Tiến trình mới: khôi phục rồi chạy nốt.
      const queue2 = new JobQueue({ store, logger: silent, queue: config.queue });
      const ranAgain = new Set();
      queue2.registerHandler('run', async ({ jobId }) => () => { ranAgain.add(jobId); return jobId; });
      await queue2.resume();
      await queue2.drain();
      assert.deepEqual([...ranAgain].sort(), ['j-2', 'j-3'], 'mục còn `queued` phải được chạy lại sau khi khởi động lại');
      assert.deepEqual(await store.queueStats(), { queued: 0, running: 0, done: 3, failed: 0 });
      await queue2.close().catch(() => {});
    } finally {
      await store.close();
    }
  });

  test('resume() gặp mục KHÔNG có hàm xử lý ⇒ fail-closed (mục `failed`), KHÔNG im lặng bỏ mất việc', async () => {
    const config = testConfig({ QUEUE_RETRY_BASE_MS: '0' });
    const store = await createStore(config, silent);
    try {
      await store.createJob({ id: 'j-la' });
      await store.enqueueJob({ id: 'q-la', jobId: 'j-la', kind: 'content', handler: 'khong-co-ham-nay' });

      const queue = new JobQueue({ store, logger: silent, queue: config.queue });
      const failed = [];
      queue.on('failed', (evt) => failed.push(evt));
      const out = await queue.resume();
      await queue.drain();

      assert.equal(out.restored, 0, 'không dựng được handler ⇒ không xếp vào bộ nhớ chạy');
      assert.equal(out.skipped, 1);
      const row = await store.getQueueItemById('q-la');
      assert.equal(row.status, 'failed', 'mục không chạy lại được phải hiện `failed`, KHÔNG treo `queued` vĩnh viễn');
      assert.match(row.last_error, /QUEUE_HANDLER_UNKNOWN|không có hàm xử lý/i);
      assert.equal(failed.length, 1, 'phải phát sự kiện `failed` để job có `error_code` + `finished_at`');
      assert.equal(failed[0].error.code, 'QUEUE_HANDLER_UNKNOWN');
    } finally {
      await store.close();
    }
  });
});

describe('R1 · §2.3 — JobQueue bền: retry, idempotent theo lượt chạy, chống trùng', () => {
  test('retry: lần 1–2 vẫn `queued`, lần 3 ⇒ `failed` + job `failed` có error_code + finished_at', async () => {
    const ctx = await startImagelabApp({ configOverrides: { QUEUE_RETRY_BASE_MS: '0', QUEUE_MAX_ATTEMPTS: '3' } });
    try {
      const { app, store } = ctx;
      assert.equal(app.queue.durable, true, 'store thật có đủ method §2.2 ⇒ hàng đợi phải BỀN');
      const jobId = `job-${randomUUID()}`;
      await store.createJob({ id: jobId });

      // Theo dõi trạng thái THẬT của mục ngay sau mỗi lần ghi nhận thất bại (tất định, không sleep).
      const seen = [];
      const realFail = store.failQueueItem.bind(store);
      store.failQueueItem = async (id, opts) => {
        const out = await realFail(id, opts);
        const row = await store.getQueueItemById(id);
        seen.push({ status: out.status, rowStatus: row.status, attempts: out.attempts });
        return out;
      };

      let calls = 0;
      app.queue.enqueue(jobId, async () => {
        calls += 1;
        throw Object.assign(new Error('nổ có mã'), { code: 'BOOM' });
      }, { runKey: 'run-1' });

      await app.queue.drain();
      const job = await waitFor(async () => {
        const row = await store.getJob(jobId);
        return row?.status === 'failed' ? row : null;
      }, { label: 'job chuyển `failed`' });

      assert.equal(calls, 3, 'handler phải được gọi đúng 3 lần (maxAttempts) rồi thôi');
      assert.deepEqual(seen.map((s) => s.status), ['queued', 'queued', 'failed'], 'lần 1–2 còn `queued`, lần 3 `failed`');
      assert.deepEqual(seen.map((s) => s.rowStatus), ['queued', 'queued', 'failed'], 'trạng thái DB phải khớp từng lần');
      assert.equal(seen[2].attempts, 3);

      const item = await store.getQueueItem(jobId);
      assert.equal(item.status, 'failed');
      assert.ok(item.finished_at, 'mục hỏng hẳn phải có `finished_at`');
      assert.match(item.last_error, /BOOM/, 'mục hỏng phải giữ mã lỗi');

      assert.equal(job.status, 'failed');
      assert.equal(job.stage, 'failed');
      assert.equal(job.error_code, 'BOOM', 'job phải có `error_code` (hành vi cũ giữ nguyên)');
      assert.ok(job.finished_at, 'job phải có `finished_at`');
    } finally {
      await ctx.close();
    }
  });

  test('enqueue cùng `runKey` 2 lần ⇒ 1 mục + handler chạy ĐÚNG 1 lần (không thu tiền 2 lần)', async () => {
    const { store, queue } = await makeStoreAndQueue();
    try {
      const jobId = `job-${randomUUID()}`;
      await store.createJob({ id: jobId });
      let runs = 0;
      // Cố ý dùng HAI closure khác nhau: khoá chống trùng phải theo LƯỢT CHẠY, không theo hàm.
      const mk = () => async () => { runs += 1; return 'ok'; };

      queue.enqueue(jobId, mk(), { runKey: 'luot-1' });
      queue.enqueue(jobId, mk(), { runKey: 'luot-1' });
      await queue.drain();

      assert.equal(runs, 1, 'cùng một lượt chạy ⇒ handler chỉ được chạy MỘT lần');
      assert.equal((await rowsOfJob(store, jobId)).length, 1, 'cùng lượt chạy ⇒ chỉ MỘT mục trong DB');
      assert.equal((await store.getQueueItem(jobId)).status, 'done');
    } finally {
      await queue.close().catch(() => {});
      await store.close();
    }
  });

  test('HAI `JobQueue` (mô phỏng 2 tiến trình) cùng `runKey` ⇒ vẫn chỉ 1 mục, 1 lần chạy', async () => {
    const config = testConfig({ QUEUE_RETRY_BASE_MS: '0' });
    const store = await createStore(config, silent);
    const q1 = new JobQueue({ store, logger: silent, queue: config.queue, workerId: 'tien-trinh-1' });
    const q2 = new JobQueue({ store, logger: silent, queue: config.queue, workerId: 'tien-trinh-2' });
    try {
      const jobId = `job-${randomUUID()}`;
      await store.createJob({ id: jobId });
      let runs = 0;

      q1.enqueue(jobId, async () => { runs += 1; await sleep(30); return 'p1'; }, { runKey: 'chung' });
      await sleep(20); // để tiến trình 1 kịp ghi mục xuống DB (đúng thứ tự thật)
      q2.enqueue(jobId, async () => { runs += 1; return 'p2'; }, { runKey: 'chung' });
      await Promise.all([q1.drain(), q2.drain()]);

      assert.equal(runs, 1, 'hai tiến trình cùng một lượt chạy ⇒ chỉ MỘT lần chạy');
      assert.equal((await rowsOfJob(store, jobId)).length, 1);
    } finally {
      await q1.close().catch(() => {});
      await q2.close().catch(() => {});
      await store.close();
    }
  });

  test('HỒI QUY: hai LƯỢT khác nhau (2 closure khác nhau) ⇒ 2 mục và chạy CẢ HAI', async () => {
    const { store, queue } = await makeStoreAndQueue();
    try {
      const jobId = `job-${randomUUID()}`;
      await store.createJob({ id: jobId });
      let runs = 0;

      queue.enqueue(jobId, async () => { runs += 1; return 'luot-a'; });
      queue.enqueue(jobId, async () => { runs += 1; return 'luot-b'; });
      await queue.drain();

      assert.equal(runs, 2, 'hai ý định riêng (hai tab/hai request) ⇒ phải chạy CẢ HAI, không được gộp');
      assert.equal((await rowsOfJob(store, jobId)).length, 2, 'mỗi lượt một mục — nuốt một lượt là mất tiền của người dùng');
    } finally {
      await queue.close().catch(() => {});
      await store.close();
    }
  });

  test('HỒI QUY: hai `runKey` khác nhau ⇒ 2 mục và chạy CẢ HAI', async () => {
    const { store, queue } = await makeStoreAndQueue();
    try {
      const jobId = `job-${randomUUID()}`;
      await store.createJob({ id: jobId });
      const ran = [];
      queue.enqueue(jobId, async () => { ran.push('r1'); }, { runKey: 'r1' });
      queue.enqueue(jobId, async () => { ran.push('r2'); }, { runKey: 'r2' });
      await queue.drain();
      assert.deepEqual(ran.sort(), ['r1', 'r2']);
      assert.equal((await rowsOfJob(store, jobId)).length, 2);
    } finally {
      await queue.close().catch(() => {});
      await store.close();
    }
  });

  test('QUEUE_DURABLE=false ⇒ KHÔNG ghi dòng DB nào, hành vi bộ nhớ cũ nguyên', async () => {
    const config = testConfig({ QUEUE_DURABLE: 'false' });
    assert.equal(config.queue.durable, false, 'config phải đọc được QUEUE_DURABLE=false');
    const store = await createStore(config, silent);
    const queue = new JobQueue({ store, logger: silent, queue: config.queue, maxAttempts: 2, retryDelayMs: 1 });
    try {
      assert.equal(queue.durable, false);
      const jobId = `job-${randomUUID()}`;
      let runs = 0;
      queue.enqueue(jobId, async () => { runs += 1; return 'ok'; });
      assert.equal(queue.isPending(jobId), true, 'hành vi cũ: isPending đúng ngay sau enqueue');
      await queue.drain();

      assert.equal(runs, 1);
      assert.equal(await countQueueRows(store), 0, 'chế độ bộ nhớ TUYỆT ĐỐI không chạm bảng job_queue');
      assert.deepEqual(await store.queueStats(), { queued: 0, running: 0, done: 0, failed: 0 });
      assert.equal(queue.stats().durable, false);
      assert.equal(QUEUE_DEFAULTS.durable, true, 'mặc định của repo vẫn là BỀN');
      assert.equal(resolveHandlerName('image_translation', 'rendering'), 'render', 'tên việc suy từ (kind, stage) giữ nguyên');
    } finally {
      await queue.close().catch(() => {});
      await store.close();
    }
  });
});
