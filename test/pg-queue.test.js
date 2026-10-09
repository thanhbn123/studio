/**
 * HÀNG ĐỢI BỀN (R1 §2.1/§2.2) — NGHIỆP VỤ THẬT TRÊN POSTGRESQL.
 *
 * Lỗ hổng file này bịt: `job_queue` + hai cột R1 (`epoch`, `heartbeat_at`) trước đây chỉ được
 * test trên SQLite in-memory (`test/r1-queue-durable.test.js`). Nhưng tính NGUYÊN TỬ của
 * `claimNextJob` được hiện thực KHÁC NHAU theo dialect:
 *
 *   · PostgreSQL: `SELECT … FOR UPDATE SKIP LOCKED` trong một `UPDATE … RETURNING`;
 *   · SQLite: dựa vào khoá ghi toàn file (một tiến trình ghi tại một thời điểm).
 *
 * `SKIP LOCKED` là mệnh đề **chỉ có trên PostgreSQL** ⇒ SQLite không bao giờ chứng minh được
 * nó. Hơn nữa SQLite in-memory chỉ có MỘT kết nối, nên "hai worker song song" trên SQLite là
 * giả lập; ở đây dùng **HAI STORE với HAI POOL kết nối riêng** — đua thật.
 *
 * Tự BỎ QUA khi thiếu `DATABASE_URL`. Mọi dòng tạo ra đều bị dọn theo `RUN_TAG`.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createStore, QUEUE_EXHAUSTED_ERROR } from '../src/store/index.js';
import {
  hasPg, skipNoPg, pgConfig, silent, RUN_TAG,
  newJobId, purgeRunRows, enqueueBackdated, makeStale, queueRow,
} from './pg-helpers.js';

describe('Hàng đợi bền trên PostgreSQL thật — nguyên tử, thu hồi, fencing, nhịp tim', () => {
  let store;
  /** Store THỨ HAI: pool kết nối RIÊNG ⇒ hai worker thật sự khác tiến trình logic. */
  let store2;

  before(async () => {
    if (!hasPg) return;
    store = await createStore(pgConfig(), silent);
    store2 = await createStore(pgConfig(), silent);
    assert.equal(store.dialect, 'postgres');
    assert.equal(store2.dialect, 'postgres');
    assert.notEqual(store.driver, store2.driver, 'hai store phải có driver/pool riêng');
  });

  after(async () => {
    if (!store) return;
    await purgeRunRows(store);
    await store.close();
    await store2?.close();
  });

  /**
   * CÔ LẬP TỪNG TEST: xoá mọi mục hàng đợi của lần chạy này trước mỗi test.
   *
   * Vì sao bắt buộc: `claimNextJob` nhặt mục `queued` CŨ NHẤT **trên toàn bảng**. Test trước
   * có thể để lại mục ở trạng thái `queued` (ví dụ sau `failQueueItem` còn lượt thử) với
   * `created_at` backdate CŨ HƠN mục của test sau ⇒ test sau nhặt được mục của test trước và
   * đỏ oan. Chỉ xoá theo `RUN_TAG` nên KHÔNG chạm dữ liệu của ai khác.
   */
  beforeEach(async () => {
    if (!store) return;
    await store.driver.run('DELETE FROM job_queue WHERE job_id LIKE ?', [`${RUN_TAG}-%`]);
  });

  /** Tạo một job thật + mục hàng đợi backdate (xem `enqueueBackdated`). */
  async function seedItem({ order = 0, maxAttempts = 3, handler = 'run', kind = 'content' } = {}) {
    const jobId = newJobId('q');
    await store.createJob({ id: jobId, sessionId: 'pg-queue', source: 'test', kind });
    return enqueueBackdated(store, { jobId, handler, kind, maxAttempts, order });
  }

  test('claimNextJob NGUYÊN TỬ: hai pool song song KHÔNG nhặt trùng một mục', { skip: skipNoPg }, async () => {
    const item = await seedItem({ order: 1 });

    // Đua thật: hai kết nối khác nhau cùng nhặt, chỉ MỘT được.
    const [a, b] = await Promise.all([
      store.claimNextJob({ workerId: 'worker-A' }),
      store2.claimNextJob({ workerId: 'worker-B' }),
    ]);

    const winners = [a, b].filter((r) => r && r.id === item.id);
    assert.equal(winners.length, 1, `đúng MỘT worker được nhặt mục ${item.id}; nhận ${winners.length}`);

    const row = await queueRow(store, item.id);
    assert.equal(row.status, 'running');
    assert.equal(Number(row.attempts), 1, 'attempts chỉ được tăng MỘT lần dù hai worker cùng nhặt');
    assert.ok(['worker-A', 'worker-B'].includes(row.locked_by));
    assert.equal(row.locked_by, winners[0].locked_by, 'DB phải ghi đúng worker đã thắng');
  });

  test('N mục · 2 worker song song: mỗi mục được nhặt ĐÚNG MỘT LẦN (không trùng, không sót)', { skip: skipNoPg }, async () => {
    const N = 8;
    const items = [];
    for (let i = 0; i < N; i += 1) items.push(await seedItem({ order: 10 + i }));
    const mine = new Set(items.map((it) => it.id));

    // Mỗi worker cố nhặt N lần; tổng số lần nhặt được mục CỦA TEST phải đúng N.
    const claimAll = async (st, workerId) => {
      const got = [];
      for (let i = 0; i < N; i += 1) {
        const row = await st.claimNextJob({ workerId });
        if (row && mine.has(row.id)) got.push(row.id);
      }
      return got;
    };
    const [gotA, gotB] = await Promise.all([claimAll(store, 'worker-A'), claimAll(store2, 'worker-B')]);

    const all = [...gotA, ...gotB];
    assert.equal(new Set(all).size, all.length, `KHÔNG mục nào được nhặt hai lần; trùng: ${all.length - new Set(all).size}`);
    assert.equal(all.length, N, `cả ${N} mục phải được nhặt hết (không sót); nhận ${all.length}`);

    for (const it of items) {
      const row = await queueRow(store, it.id);
      assert.equal(row.status, 'running', `mục ${it.id} phải đang chạy`);
      assert.equal(Number(row.attempts), 1, `mục ${it.id} chỉ được tăng attempts MỘT lần`);
      assert.equal(Number(row.epoch), 1, `mỗi lần claim cấp epoch mới ⇒ epoch = 1`);
    }
  });

  test('epoch/fencing: runner ĐÃ BỊ CƯỚP không chốt được done, runner mới thì được', { skip: skipNoPg }, async () => {
    const item = await seedItem({ order: 30 });

    const first = await store.claimNextJob({ workerId: 'worker-old' });
    assert.equal(first.id, item.id);
    const oldEpoch = Number(first.epoch);

    // Tiến trình giữ mục "chết": mất nhịp tim ⇒ cron thu hồi ⇒ worker mới nhặt lại.
    await makeStale(store, item.id);
    const requeued = await store.requeueStaleJobs({ olderThanMs: 1000 });
    assert.ok(requeued.ids.includes(item.id), 'mục mất nhịp phải được thu hồi về queued');

    const second = await store2.claimQueueItem(item.id, { workerId: 'worker-new' });
    assert.ok(second, 'worker mới phải nhặt lại được mục');
    const newEpoch = Number(second.epoch);
    assert.ok(newEpoch > oldEpoch, `epoch phải TĂNG sau mỗi lần claim (${oldEpoch} → ${newEpoch})`);

    // Runner CŨ quay lại chốt `done` với epoch cũ ⇒ phải bị TỪ CHỐI.
    assert.equal(
      await store.completeQueueItem(item.id, { epoch: oldEpoch }),
      false,
      'runner bị cướp KHÔNG được ghi đè trạng thái của runner mới',
    );
    assert.equal((await queueRow(store, item.id)).status, 'running', 'mục phải vẫn đang chạy cho runner mới');

    // Thiếu epoch hoàn toàn cũng bị từ chối (B1: fencing là BẮT BUỘC, không tuỳ chọn).
    assert.equal(await store.completeQueueItem(item.id, {}), false, 'thiếu epoch thì không được chốt done');

    // Runner MỚI chốt với epoch đúng ⇒ thành công.
    assert.equal(await store2.completeQueueItem(item.id, { epoch: newEpoch }), true);
    assert.equal((await queueRow(store, item.id)).status, 'done');
  });

  test('epoch/fencing: failQueueItem của runner cũ bị bỏ (stale), không tiêu lượt thử', { skip: skipNoPg }, async () => {
    const item = await seedItem({ order: 40 });
    const first = await store.claimNextJob({ workerId: 'worker-old' });
    const oldEpoch = Number(first.epoch);

    await makeStale(store, item.id);
    await store.requeueStaleJobs({ olderThanMs: 1000 });
    const second = await store2.claimQueueItem(item.id, { workerId: 'worker-new' });
    const newEpoch = Number(second.epoch);

    const stale = await store.failQueueItem(item.id, { error: new Error('runner cũ'), epoch: oldEpoch });
    assert.equal(stale.stale, true, 'kết quả thất bại của runner cũ phải bị đánh dấu stale và BỎ');
    assert.equal((await queueRow(store, item.id)).status, 'running', 'mục vẫn thuộc runner mới');

    // Runner mới báo lỗi với epoch đúng ⇒ được ghi nhận.
    const real = await store2.failQueueItem(item.id, { error: new Error('lỗi thật'), epoch: newEpoch, retryDelayMs: 0 });
    assert.ok(['queued', 'failed'].includes(real.status), `trạng thái sau fail phải hợp lệ, nhận ${real.status}`);
  });

  test('heartbeat_at: mục CÒN NHỊP không bị cron cướp; mục MẤT NHỊP thì bị thu hồi', { skip: skipNoPg }, async () => {
    const item = await seedItem({ order: 50 });
    const claimed = await store.claimQueueItem(item.id, { workerId: 'worker-live' });
    assert.equal(claimed.id, item.id);

    // Worker còn sống: gia hạn lease.
    assert.equal(
      await store.touchQueueItem(item.id, { workerId: 'worker-live', epoch: Number(claimed.epoch) }),
      true,
      'chủ hiện tại phải gia hạn được lease',
    );
    const afterTouch = await queueRow(store, item.id);
    assert.ok(afterTouch.heartbeat_at, 'touchQueueItem phải ghi heartbeat_at');

    // Cron chạy với cửa sổ rộng ⇒ mục còn nhịp KHÔNG được thu hồi (R1-F2: job dài không bị cướp).
    const sweep = await store.requeueStaleJobs({ olderThanMs: 600000 });
    assert.ok(!sweep.ids.includes(item.id), 'mục CÒN NHỊP TIM không được bị thu hồi');
    assert.equal((await queueRow(store, item.id)).status, 'running');

    // A6: người KHÁC không được gia hạn hộ lease.
    assert.equal(await store.touchQueueItem(item.id, { workerId: 'worker-stranger' }), false, 'worker lạ không được gia hạn lease');
    // Thiếu workerId cũng bị từ chối.
    assert.equal(await store.touchQueueItem(item.id, {}), false, 'thiếu workerId thì không được gia hạn');

    // Tiến trình chết ⇒ nhịp ngừng ⇒ bị thu hồi (đúng ý đồ).
    await makeStale(store, item.id);
    const sweep2 = await store.requeueStaleJobs({ olderThanMs: 1000 });
    assert.ok(sweep2.ids.includes(item.id), 'mục MẤT NHỊP phải được thu hồi về queued');
    assert.equal((await queueRow(store, item.id)).status, 'queued');
  });

  test('requeueStaleJobs: mục CHẠM TRẦN số lần thử ⇒ chốt failed, KHÔNG thu hồi vô hạn', { skip: skipNoPg }, async () => {
    // `max_attempts = 1`: nhặt một lần là chạm trần ngay.
    const item = await seedItem({ order: 60, maxAttempts: 1 });
    const claimed = await store.claimNextJob({ workerId: 'worker-crash' });
    assert.equal(claimed.id, item.id);
    assert.equal(Number(claimed.attempts), 1);

    await makeStale(store, item.id);
    const sweep = await store.requeueStaleJobs({ olderThanMs: 1000 });

    assert.ok(sweep.failed_ids.includes(item.id), 'mục chạm trần phải nằm trong failed_ids');
    assert.ok(!sweep.ids.includes(item.id), 'mục chạm trần KHÔNG được trả về queued');
    assert.ok(sweep.failed_job_ids.includes(item.job_id), 'phải trả kèm job_id để tầng gọi chốt job failed');

    const row = await queueRow(store, item.id);
    assert.equal(row.status, 'failed');
    assert.equal(row.last_error, QUEUE_EXHAUSTED_ERROR);
    assert.ok(row.finished_at, 'mục failed phải có finished_at');

    // Và KHÔNG nhặt lại được nữa (chốt thứ hai ở `claimNextJob`: attempts < max_attempts).
    assert.equal(await store.claimQueueItem(item.id, { workerId: 'worker-again' }), null, 'mục failed không được nhặt lại');
  });

  test('enqueueJob cùng khoá idempotency: MỞ LẠI mục cũ, reset attempts, cấp epoch mới', { skip: skipNoPg }, async () => {
    const jobId = newJobId('revive');
    await store.createJob({ id: jobId, sessionId: 'pg-queue', source: 'test' });
    const explicitId = `${jobId}-run1`;

    const first = await store.enqueueJob({ id: explicitId, jobId, handler: 'run', maxAttempts: 2 });
    assert.equal(first.id, explicitId);
    const claimed = await store.claimQueueItem(explicitId, { workerId: 'w1' });
    await store.completeQueueItem(explicitId, { epoch: Number(claimed.epoch) });
    assert.equal((await queueRow(store, explicitId)).status, 'done');

    // Xếp LẠI cùng khoá ⇒ mở lại CHÍNH mục đó, không đẻ mục mới.
    const again = await store.enqueueJob({ id: explicitId, jobId, handler: 'run', maxAttempts: 2 });
    assert.equal(again.id, explicitId);
    assert.equal(again.revived, true, 'phải báo rõ là MỞ LẠI mục cũ');

    const row = await queueRow(store, explicitId);
    assert.equal(row.status, 'queued');
    assert.equal(Number(row.attempts), 0, 'A2: mở lại là LƯỢT MỚI ⇒ attempts phải RESET về 0');
    assert.ok(Number(row.epoch) > Number(claimed.epoch), 'mở lại phải cấp epoch MỚI');
    assert.equal(row.finished_at, null);

    const count = await store.driver.get('SELECT COUNT(*) AS n FROM job_queue WHERE job_id = ?', [jobId]);
    assert.equal(Number(count.n), 1, 'KHÔNG được đẻ thêm mục cho cùng khoá idempotency');
  });

  test('run_after (backoff): mục chưa tới hạn KHÔNG bị nhặt', { skip: skipNoPg }, async () => {
    const item = await seedItem({ order: 70 });
    const future = new Date(Date.now() + 3600_000).toISOString();
    await store.driver.run('UPDATE job_queue SET run_after = ? WHERE id = ?', [future, item.id]);

    // `claimNextJob` là đường DUY NHẤT lọc `run_after` (`claimQueueItem` CỐ TÌNH không lọc:
    // JobQueue đang giữ chính mục đó trong bộ nhớ và tự quyết thời điểm chạy).
    // Mục của test được backdate về 1990 nên nếu nó đủ điều kiện thì nó CHẮC CHẮN được nhặt
    // trước mọi mục khác — vậy "không nhặt được nó" là bằng chứng `run_after` có hiệu lực.
    const got = await store.claimNextJob({ workerId: 'worker-early' });
    assert.notEqual(got?.id, item.id, 'mục có run_after ở tương lai KHÔNG được nhặt');
    assert.equal((await queueRow(store, item.id)).status, 'queued', 'mục phải vẫn ở queued');

    // Tới hạn rồi thì nhặt được ngay — chứng minh chỉ `run_after` chặn nó, không phải lý do khác.
    await store.driver.run('UPDATE job_queue SET run_after = NULL WHERE id = ?', [item.id]);
    const now = await store.claimNextJob({ workerId: 'worker-ontime' });
    assert.equal(now?.id, item.id, 'hết backoff thì mục phải được nhặt');
  });

  test('queueStats đếm đúng theo trạng thái trên PostgreSQL', { skip: skipNoPg }, async () => {
    const stats = await store.queueStats();
    for (const key of ['queued', 'running', 'done', 'failed']) {
      assert.equal(typeof stats[key], 'number', `queueStats phải có khoá số ${key}`);
      assert.ok(Number.isInteger(stats[key]), `${key} phải là số nguyên (PostgreSQL COUNT trả BIGINT dạng chuỗi)`);
    }
    assert.ok(!('cancelled' in stats), 'hợp đồng §2.2 chốt đúng 4 khoá');
  });
});
