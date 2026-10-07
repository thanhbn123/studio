/**
 * R1 (§4) — CRON NỘI BỘ (`src/scheduler.js`) + khối `scheduler` của `GET /api/health`.
 *
 * Vì sao cần cron: hai lỗ hổng còn lại của sprint độ tin cậy (lượt chạy treo giữ tiền, mục
 * hàng đợi `running` của tiến trình đã chết) chỉ được dọn nếu có một nhịp ĐỊNH KỲ. Hợp đồng §4
 * chốt: `runOnce()` gọi tay được (test KHÔNG cần thời gian thật), `start()` không tick ngay,
 * `stop()` tắt sạch và KHÔNG giữ tiến trình sống, lỗi một bước chỉ tăng `errors` chứ không
 * làm chết vòng lặp.
 *
 * Test ở đây dùng hàm giả đếm số lần gọi cho hai bước, và app THẬT cho `/api/health`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createScheduler } from '../src/scheduler.js';
import { startImagelabApp, j } from './imagelab-helpers.js';
import { silent, testConfig } from './helpers.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** App/store giả đếm số lần gọi + ghi lại tham số (đúng "hai hàm" của hợp đồng §4). */
function fakeDeps({ reconciled = 0, requeued = 0, reconcileError = null, requeueError = null } = {}) {
  const calls = { reconcile: [], requeue: [] };
  const app = {
    async reconcileStuckRuns(args) {
      calls.reconcile.push(args);
      if (reconcileError) throw reconcileError;
      return { reconciled, refunded: 0, runs: [], skipped_active: 0 };
    },
  };
  const store = {
    async requeueStaleJobs(args) {
      calls.requeue.push(args);
      if (requeueError) throw requeueError;
      return { requeued, ids: [] };
    },
  };
  return { app, store, calls };
}

const CONFIG = { scheduler: { enabled: true, intervalMs: 60_000 }, billing: { stuckRunMs: 1234 }, queue: { staleMs: 5678 } };


/** Phần ĐÓNG BĂNG của kết quả nhịp (§4). R1-F3 thêm `claimed`/`exhausted` — khẳng định riêng. */
const hopLe = (out) => ({ reconciled: out.reconciled, requeued: out.requeued, errors: out.errors });

describe('R1 · §4 — runOnce(): một nhịp tất định, gọi ĐÚNG hai hàm', () => {
  test('trả `{reconciled, requeued, errors}` và truyền đúng ngưỡng cấu hình cho từng bước', async () => {
    const { app, store, calls } = fakeDeps({ reconciled: 2, requeued: 3 });
    const scheduler = createScheduler({ app, store, config: CONFIG, logger: silent });

    const out = await scheduler.runOnce();
    // R1-F3 (vòng sửa phản biện): nhịp cron nay còn NHẶT VÀ CHẠY việc `queued` mồ côi ⇒ kết quả
    // có thêm `claimed`/`exhausted`. Khẳng định phần ĐÓNG BĂNG cũ + phần mới.
    assert.deepEqual(
      { reconciled: out.reconciled, requeued: out.requeued, errors: out.errors },
      { reconciled: 2, requeued: 3, errors: 0 },
    );
    assert.equal(out.claimed, 0, 'không có `app.queue.pumpQueued` ⇒ không nhặt thêm việc');
    assert.equal(calls.reconcile.length, 1, 'phải gọi `app.reconcileStuckRuns` đúng MỘT lần mỗi nhịp');
    assert.equal(calls.requeue.length, 1, 'phải gọi `store.requeueStaleJobs` đúng MỘT lần mỗi nhịp');
    assert.deepEqual(calls.reconcile[0], { olderThanMs: 1234 }, 'bước 1 dùng `config.billing.stuckRunMs`');
    assert.deepEqual(calls.requeue[0], { olderThanMs: 5678 }, 'bước 2 dùng `config.queue.staleMs`');
  });

  test('thiếu CẢ HAI hàm ⇒ trả 0 và KHÔNG ném (app cũ vẫn boot được)', async () => {
    const scheduler = createScheduler({ app: {}, store: {}, config: CONFIG, logger: silent });
    const out = await scheduler.runOnce();
    assert.deepEqual(
      { reconciled: out.reconciled, requeued: out.requeued, errors: out.errors },
      { reconciled: 0, requeued: 0, errors: 0 },
    );
    assert.deepEqual(scheduler.stats().last_result, out);
  });

  test('lỗi trong một bước ⇒ `errors` tăng + KHÔNG ném; bước còn lại vẫn chạy', async () => {
    const failing1 = fakeDeps({ requeued: 4, reconcileError: Object.assign(new Error('reconcile nổ'), { code: 'E1' }) });
    const s1 = createScheduler({ app: failing1.app, store: failing1.store, config: CONFIG, logger: silent });
    assert.deepEqual(hopLe(await s1.runOnce()), { reconciled: 0, requeued: 4, errors: 1 });
    assert.equal(failing1.calls.requeue.length, 1, 'bước 1 lỗi KHÔNG được chặn bước 2');

    const failing2 = fakeDeps({ reconciled: 5, requeueError: new Error('requeue nổ') });
    const s2 = createScheduler({ app: failing2.app, store: failing2.store, config: CONFIG, logger: silent });
    assert.deepEqual(hopLe(await s2.runOnce()), { reconciled: 5, requeued: 0, errors: 1 });

    // Lỗi ở CẢ HAI bước ⇒ errors = 2, vẫn không ném.
    const both = fakeDeps({ reconcileError: new Error('x'), requeueError: new Error('y') });
    const s3 = createScheduler({ app: both.app, store: both.store, config: CONFIG, logger: silent });
    assert.deepEqual(hopLe(await s3.runOnce()), { reconciled: 0, requeued: 0, errors: 2 });
    // Vòng lặp vẫn sống: nhịp sau (đã hết lỗi) chạy bình thường.
    both.app.reconcileStuckRuns = async () => ({ reconciled: 1 });
    both.store.requeueStaleJobs = async () => ({ requeued: 2 });
    assert.deepEqual(hopLe(await s3.runOnce()), { reconciled: 1, requeued: 2, errors: 0 });
  });

  test('stats() đếm `ticks`, `last_tick_at`, `last_result` sau mỗi nhịp', async () => {
    const { app, store } = fakeDeps({ reconciled: 1, requeued: 1 });
    const scheduler = createScheduler({ app, store, config: CONFIG, logger: silent });
    const before = scheduler.stats();
    assert.equal(before.ticks, 0);
    assert.equal(before.last_tick_at, null);
    assert.equal(before.last_result, null);
    assert.equal(before.enabled, true);
    assert.equal(before.running, false);

    await scheduler.runOnce();
    const one = scheduler.stats();
    assert.equal(one.ticks, 1);
    assert.ok(Number.isFinite(Date.parse(one.last_tick_at)), '`last_tick_at` phải là mốc ISO đọc được');
    assert.deepEqual(
      { reconciled: one.last_result.reconciled, requeued: one.last_result.requeued, errors: one.last_result.errors },
      { reconciled: 1, requeued: 1, errors: 0 },
    );

    await scheduler.runOnce();
    const two = scheduler.stats();
    assert.equal(two.ticks, 2);
    assert.ok(Date.parse(two.last_tick_at) >= Date.parse(one.last_tick_at));
    // `last_result` là BẢN SAO — sửa nó không được làm hỏng số liệu nội bộ.
    two.last_result.reconciled = 999;
    assert.equal(scheduler.stats().last_result.reconciled, 1);
  });
});

describe('R1 · §4 — start()/stop(): không tick ngay, tắt sạch, không giữ tiến trình sống', () => {
  test('start() không tick ngay; stop() idempotent; timer đã unref(); SCHEDULER_ENABLED=false ⇒ không tick', async () => {
    const { app, store, calls } = fakeDeps({ reconciled: 1, requeued: 1 });
    const scheduler = createScheduler({ app, store, config: { ...CONFIG, scheduler: { enabled: true, intervalMs: 40 } }, logger: silent });

    // Bắt handle của `setInterval` để kiểm nó đã được `unref()` (không giữ tiến trình sống).
    const realSetInterval = globalThis.setInterval;
    let timer = null;
    globalThis.setInterval = (fn, ms) => {
      timer = realSetInterval(fn, ms);
      return timer;
    };
    try {
      scheduler.start();
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    assert.ok(timer, 'start() phải tạo timer khi được bật');
    assert.equal(typeof timer.hasRef, 'function');
    assert.equal(timer.hasRef(), false, 'timer PHẢI `unref()` — cron không được giữ tiến trình sống (§4)');
    assert.equal(scheduler.stats().running, true);
    assert.equal(calls.reconcile.length, 0, 'start() KHÔNG được tick ngay lúc boot');
    assert.equal(scheduler.stats().ticks, 0);

    // Nhịp thật sự chạy theo interval.
    for (let i = 0; i < 100 && calls.reconcile.length === 0; i += 1) await sleep(10);
    assert.ok(calls.reconcile.length >= 1, 'sau `intervalMs` phải có nhịp chạy');

    await scheduler.stop();
    assert.equal(scheduler.stats().running, false, 'sau stop() ⇒ running = false');
    const ticksAfterStop = scheduler.stats().ticks;
    const callsAfterStop = calls.reconcile.length;
    await sleep(120); // > 3 nhịp — nếu timer còn sống thì số liệu đã tăng
    assert.equal(scheduler.stats().ticks, ticksAfterStop, 'stop() phải dừng HẲN vòng lặp');
    assert.equal(calls.reconcile.length, callsAfterStop);

    await scheduler.stop(); // idempotent: gọi lần hai không ném, không đổi số liệu
    assert.equal(scheduler.stats().running, false);
    assert.equal(scheduler.stats().ticks, ticksAfterStop);
    assert.equal(timer.hasRef(), false);
  });

  test('SCHEDULER_ENABLED=false ⇒ KHÔNG tạo timer, KHÔNG tick; runOnce() gọi tay vẫn chạy', async () => {
    const { app, store, calls } = fakeDeps({ reconciled: 1 });
    // Đọc thẳng từ env như lúc chạy thật: SCHEDULER_ENABLED=false ⇒ config.scheduler.enabled = false.
    const config = testConfig({ SCHEDULER_ENABLED: 'false', SCHEDULER_INTERVAL_MS: '5' });
    assert.equal(config.scheduler.enabled, false, 'env `SCHEDULER_ENABLED=false` phải tắt cron');
    const scheduler = createScheduler({ app, store, config, logger: silent });

    let intervalCalls = 0;
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = (...args) => {
      intervalCalls += 1;
      return realSetInterval(...args);
    };
    try {
      scheduler.start();
      await sleep(60);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    assert.equal(intervalCalls, 0, 'tắt bằng cấu hình ⇒ KHÔNG được tạo timer nào');
    assert.equal(calls.reconcile.length, 0);
    assert.equal(scheduler.stats().ticks, 0);
    assert.equal(scheduler.stats().enabled, false);
    assert.equal(scheduler.stats().running, false);

    // `enabled` chỉ chặn VÒNG LẶP; gọi tay `runOnce()` vẫn là một nhịp thật (test/vận hành).
    assert.deepEqual(hopLe(await scheduler.runOnce()), { reconciled: 1, requeued: 0, errors: 0 });
    assert.equal(scheduler.stats().ticks, 1);
  });
});

describe('R1 · §4 — nhịp cron trên APP THẬT + /api/health', () => {
  test('runOnce() trên app thật: gọi được cả hai bước thật, không ném, số 0 khi không có việc', async () => {
    const ctx = await startImagelabApp();
    try {
      const scheduler = createScheduler({ app: ctx.app, store: ctx.store, config: ctx.config, logger: silent });
      assert.equal(typeof ctx.app.reconcileStuckRuns, 'function', 'app thật phải có `reconcileStuckRuns` (§4 bước 1)');
      assert.equal(typeof ctx.store.requeueStaleJobs, 'function', 'store thật phải có `requeueStaleJobs` (§4 bước 2)');

      const out = await scheduler.runOnce();
      assert.deepEqual({ reconciled: out.reconciled, requeued: out.requeued, errors: out.errors }, { reconciled: 0, requeued: 0, errors: 0 }, 'DB sạch ⇒ nhịp không có việc, không lỗi');
      // Mục hàng đợi `running` chết ⇒ nhịp cron THẬT phải thu hồi được.
      const old = new Date(Date.now() - 3600_000).toISOString();
      await ctx.store.enqueueJob({ id: 'q-chet', jobId: 'j-chet', handler: 'run' });
      await ctx.store.driver.run("UPDATE job_queue SET status='running', locked_at=? WHERE id='q-chet'", [old]);
      const again = await scheduler.runOnce();
      assert.equal(again.requeued, 1, 'cron phải trả mục `running` chết về hàng đợi');
      assert.equal(again.errors, 0);
      // R1-F3 (vòng sửa phản biện): nhịp cron KHÔNG chỉ đổi trạng thái — nó còn NHẶT VÀ CHẠY mục
      // vừa thu hồi (`queue.pumpQueued`), nên trạng thái cuối là `running` (đang chạy) hoặc `done`,
      // KHÔNG còn nằm im ở `queued` như trước.
      assert.ok(again.claimed >= 1, `cron phải NHẶT mục vừa thu hồi để chạy, nhận claimed=${again.claimed}`);
      const after = (await ctx.store.getQueueItemById('q-chet')).status;
      assert.ok(['running', 'done'].includes(after), `mục phải được nhặt/chạy (không nằm im ở queued), nhận ${after}`);
      await ctx.store.driver.run("UPDATE job_queue SET status='done', locked_at=NULL WHERE id='q-chet'");
    } finally {
      await ctx.close();
    }
  });

  test('/api/health: có khối `scheduler` đủ 5 khoá, GIỮ NGUYÊN field cũ, KHÔNG lộ đường dẫn/bí mật', async () => {
    const ctx = await startImagelabApp();
    try {
      // (a) Chưa gắn scheduler (test dựng router trực tiếp) ⇒ khối vẫn phải có, số 0, không ném.
      const bare = await j(await fetch(`${ctx.base}/api/health`));
      assert.deepEqual(Object.keys(bare.scheduler).sort(), ['enabled', 'last_result', 'last_tick_at', 'running', 'ticks']);
      // (R1-F3 giữ nguyên 5 khoá của khối; nội dung `last_result` có thêm claimed/exhausted —
      // khẳng định ở dưới.)
      assert.equal(bare.scheduler.enabled, ctx.config.scheduler.enabled !== false);
      assert.equal(bare.scheduler.running, false);
      assert.equal(bare.scheduler.ticks, 0);
      assert.equal(bare.scheduler.last_tick_at, null);
      assert.equal(bare.scheduler.last_result, null);

      // (b) Gắn scheduler THẬT (như `src/server.js`) rồi chạy một nhịp ⇒ số liệu thật hiện lên.
      const scheduler = createScheduler({ app: ctx.app, store: ctx.store, config: ctx.config, logger: silent });
      ctx.app.scheduler = scheduler;
      await scheduler.runOnce();
      scheduler.start();

      const res = await fetch(`${ctx.base}/api/health`);
      const body = await j(res);
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(body.scheduler).sort(), ['enabled', 'last_result', 'last_tick_at', 'running', 'ticks']);
      assert.equal(body.scheduler.enabled, true);
      assert.equal(body.scheduler.running, true, 'scheduler đã start() ⇒ health phải nói đang chạy');
      assert.equal(body.scheduler.ticks, 1);
      assert.ok(Number.isFinite(Date.parse(body.scheduler.last_tick_at)));
      // R1-F3: kết quả nhịp có thêm `claimed`/`exhausted` (nhặt việc mồ côi) — vẫn là số.
      assert.deepEqual(Object.keys(body.scheduler.last_result).sort(), ['claimed', 'errors', 'exhausted', 'reconciled', 'requeued']);
      for (const value of Object.values(body.scheduler.last_result)) assert.equal(typeof value, 'number');

      // Field CŨ phải còn nguyên (hợp đồng §4: CHỈ thêm khối `scheduler`).
      for (const key of ['status', 'time', 'db', 'jobs', 'connectors', 'connector_init_failures', 'imagelab', 'accounts', 'billing']) {
        assert.ok(key in body, `/api/health phải giữ field cũ \`${key}\``);
      }
      assert.equal(body.status, 'ok');
      assert.equal(body.db.ok, true);
      assert.equal(body.db.dialect, 'sqlite');
      assert.equal(typeof body.jobs.queued, 'number');
      assert.equal(body.imagelab.available, true, 'MVP-02 vẫn khả dụng');
      assert.equal(body.accounts.available, true, 'MVP-05 accounts vẫn khả dụng');
      assert.equal(body.billing.available, true, 'MVP-05 billing vẫn khả dụng');
      assert.ok(Array.isArray(body.connectors));

      // KHÔNG lộ đường dẫn nội bộ / bí mật.
      const raw = JSON.stringify(body);
      const dir = ctx.config.imagelab.dir;
      assert.ok(dir, 'test phải có thư mục ImageLab thật để kiểm rò rỉ');
      assert.equal(raw.includes(dir), false, 'không được lộ thư mục lưu ảnh nội bộ');
      assert.equal(/(^|[^a-z])\/(Users|home|var|private|tmp)\//.test(raw), false, 'không được lộ đường dẫn hệ thống');
      for (const needle of ['storage_path', 'password', 'password_hash', 'apiKey', 'api_key', 'secret', 'token']) {
        assert.equal(raw.toLowerCase().includes(needle.toLowerCase()), false, `/api/health KHÔNG được chứa \`${needle}\``);
      }
      await scheduler.stop();
    } finally {
      await ctx.close();
    }
  });
});
