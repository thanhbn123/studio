/**
 * R3-S — CRON NỘI BỘ (scheduler) theo `docs/R1-RELIABILITY-CONTRACT.md` §4.
 *
 * Vì sao cần: hai lỗ hổng còn lại của sprint độ tin cậy chỉ được vá nếu có một nhịp ĐỊNH KỲ:
 *   1. `app.reconcileStuckRuns(...)` (MVP-05/BR-08) — thu hồi LƯỢT CHẠY TREO: lượt có
 *      `job_hold` mà tiến trình chết trước khi quyết toán ⇒ hoàn tiền + mở khoá job.
 *   2. `store.requeueStaleJobs(...)` (R1-Q) — trả mục hàng đợi `running` quá cũ về `queued`.
 *
 * Nguyên tắc thiết kế:
 *   · `runOnce()` chạy ĐÚNG MỘT nhịp và trả số liệu thật ⇒ test được mà KHÔNG cần thời gian thật
 *     (không `sleep`, không chờ `setInterval`).
 *   · `start()` dùng `setInterval(...).unref()` ⇒ timer KHÔNG giữ tiến trình sống khi server tắt.
 *   · Lỗi trong một bước chỉ làm tăng `errors` + ghi log warn; vòng lặp KHÔNG bao giờ chết.
 *   · R1-Q/R2-B chưa land (thiếu hàm) ⇒ scheduler VẪN chạy, trả số 0 và log info MỘT LẦN —
 *     không ném lỗi, không làm chết boot.
 *   · Log đúng MỘT dòng mỗi nhịp và CHỈ KHI CÓ VIỆC (`scheduler.tick`) — nhịp rỗi không rác log.
 */

/** Số đếm an toàn: giá trị lạ/âm/NaN ⇒ 0 (không bao giờ trả `NaN` ra `/api/health`). */
const toCount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

export function createScheduler({ app = null, store = null, config = {}, logger = null } = {}) {
  const cfg = config?.scheduler || {};
  // Mặc định AN TOÀN: bật cron. Chỉ tắt khi khai tường minh `SCHEDULER_ENABLED=false`.
  const enabled = cfg.enabled !== false;
  const rawInterval = Number(cfg.intervalMs);
  // Kẹp >= 1ms: `0`/số âm của `setInterval` là vòng lặp nóng (CPU 100%) — không bao giờ cho lọt.
  const intervalMs = Number.isFinite(rawInterval) && rawInterval > 0 ? Math.floor(rawInterval) : 60000;

  let timer = null;
  let running = false;
  let ticks = 0;
  let lastTickAt = null;
  let lastResult = null;
  /** Nhịp ĐANG chạy từ `setInterval` — chặn chồng nhịp khi một nhịp chạy lâu hơn `intervalMs`. */
  let inFlight = null;
  /** MỌI nhịp đang chạy (kể cả `runOnce()` gọi tay) — `stop()` chờ hết trước khi đóng DB. */
  const pending = new Set();
  /** Chỉ log "chưa có việc để dọn" MỘT lần cho cả vòng đời (không rác log mỗi nhịp). */
  let missingStepsLogged = false;

  /** Ghi log phòng thủ: logger có thể là `null` (test) và log KHÔNG bao giờ được làm sập nhịp. */
  const logAt = (level, message, ctx) => {
    try {
      logger?.[level]?.(message, ctx);
    } catch {
      /* logging hỏng không phải lý do để chết cron */
    }
  };

  /**
   * MỘT nhịp dọn dẹp (gọi được thủ công — test không cần thời gian thật).
   * Không bao giờ ném; nhịp được ghi danh vào `pending` để `stop()` chờ.
   * @returns {Promise<{reconciled:number, requeued:number, errors:number}>}
   */
  function runOnce() {
    const p = runOnePass().catch((err) => {
      // Phòng thủ CUỐI: mọi bước đã bọc `try/catch` riêng, nhưng lỗi bất ngờ cũng KHÔNG được
      // làm chết vòng lặp (mất cron = quay lại đúng lỗ hổng sprint này đang bịt).
      logAt('warn', 'scheduler.tick_failed', {
        error_name: err?.name || 'Error',
        error_code: err?.code || null,
      });
      ticks += 1;
      lastTickAt = new Date().toISOString();
      lastResult = { reconciled: 0, requeued: 0, errors: 1 };
      return { ...lastResult };
    });
    pending.add(p);
    const drop = () => pending.delete(p);
    p.then(drop, drop);
    return p;
  }

  /** Thân một nhịp: mỗi bước bọc `try/catch` riêng nên KHÔNG lỗi nào thoát ra ngoài. */
  async function runOnePass() {
    const result = { reconciled: 0, requeued: 0, claimed: 0, exhausted: 0, errors: 0 };
    let didWork = false;

    // Chỉ gọi khi hàm CÓ THẬT — R1-Q/R2-B có thể chưa land mà app vẫn phải boot.
    const reconcile = typeof app?.reconcileStuckRuns === 'function' ? app.reconcileStuckRuns : null;
    const requeue = typeof store?.requeueStaleJobs === 'function' ? store.requeueStaleJobs : null;

    if (!reconcile && !requeue && !missingStepsLogged) {
      missingStepsLogged = true;
      logAt('info', 'scheduler.no_work', {
        message: 'Scheduler đang chạy nhưng chưa có việc để dọn: thiếu app.reconcileStuckRuns (MVP-05) và store.requeueStaleJobs (R1-Q). Nhịp vẫn tiếp tục, không lỗi.',
        interval_ms: intervalMs,
      });
    }

    // 1) Thu hồi LƯỢT CHẠY TREO (MVP-05 — `app.reconcileStuckRuns` đã bơm `isJobActive`).
    if (reconcile) {
      try {
        const out = await reconcile.call(app, { olderThanMs: config?.billing?.stuckRunMs });
        // Chấp nhận cả `{ reconciled }` lẫn số trần (R2-B có thể đổi hình dạng trả về).
        const n = toCount(typeof out === 'object' && out !== null ? out.reconciled : out);
        result.reconciled = n;
        if (n > 0) didWork = true;
      } catch (err) {
        result.errors += 1;
        logAt('warn', 'scheduler.step_failed', {
          step: 'reconcile_stuck_runs',
          error_name: err?.name || 'Error',
          error_code: err?.code || null,
        });
      }
    }

    // 2) F3 (phản biện R1, CAO): NHẶT VÀ CHẠY việc `queued` mồ côi — không chỉ đổi trạng thái.
    // Trước đây cron chỉ `UPDATE running → queued` rồi không ai chạy ⇒ tiến trình đang sống không
    // cứu được việc của tiến trình đã chết (đo được: 6 nhịp cron, 0 việc chạy). `queue.drain()`
    // thu hồi mục quá hạn RỒI dựng handler và chạy, tôn trọng `concurrency`/`run_after`.
    const queue = app?.queue && typeof app.queue.pumpQueued === 'function' ? app.queue : null;
    if (queue) {
      try {
        const out = await queue.pumpQueued({ olderThanMs: config?.queue?.staleMs });
        const n = toCount(typeof out === 'object' && out !== null ? out.claimed : out);
        result.claimed = n;
        result.requeued = toCount(typeof out === 'object' && out !== null ? out.requeued : 0);
        result.exhausted = toCount(typeof out === 'object' && out !== null ? out.exhausted : 0);
        if (n > 0 || result.requeued > 0 || result.exhausted > 0) didWork = true;
      } catch (err) {
        result.errors += 1;
        logAt('warn', 'scheduler.step_failed', {
          step: 'queue_pump_queued',
          error_name: err?.name || 'Error',
          error_code: err?.code || null,
        });
      }
    } else if (requeue) {
      // Không có `queue.pumpQueued` (dựng app kiểu cũ) ⇒ giữ đường cũ để không hồi quy.
      try {
        const out = await requeue.call(store, { olderThanMs: config?.queue?.staleMs });
        const n = toCount(typeof out === 'object' && out !== null ? out.requeued : out);
        result.requeued = n;
        if (n > 0) didWork = true;
      } catch (err) {
        result.errors += 1;
        logAt('warn', 'scheduler.step_failed', {
          step: 'requeue_stale_jobs',
          error_name: err?.name || 'Error',
          error_code: err?.code || null,
        });
      }
    }

    ticks += 1;
    lastTickAt = new Date().toISOString();
    lastResult = { ...result };
    // MỘT dòng, và CHỈ KHI CÓ VIỆC (thu hồi/trả lại hàng đợi). Nhịp rỗi im lặng.
    if (didWork) {
      logAt('info', 'scheduler.tick', {
        ticks,
        reconciled: result.reconciled,
        requeued: result.requeued,
        errors: result.errors,
      });
    }
    return { ...result };
  }

  /** Nhịp từ `setInterval`: không chồng nhịp, không bao giờ ném ra ngoài. */
  function tick() {
    if (inFlight) return inFlight; // nhịp trước chưa xong ⇒ bỏ nhịp này, không xếp chồng
    const p = runOnce();
    inFlight = p;
    const clear = () => { if (inFlight === p) inFlight = null; };
    p.then(clear, clear);
    return p;
  }

  /**
   * Bật vòng lặp. Idempotent. `SCHEDULER_ENABLED=false` ⇒ KHÔNG tạo timer nào.
   * Nhịp ĐẦU TIÊN chạy sau `intervalMs` (không chạy ngay lúc boot): việc dọn lúc khởi động
   * đã do `app.js` (reconcile) và `queue.resume()` của R1-Q lo.
   */
  function start() {
    if (!enabled) {
      logAt('info', 'scheduler.disabled', {
        message: 'SCHEDULER_ENABLED=false — cron dọn dẹp KHÔNG chạy (không có timer nào được tạo).',
      });
      return;
    }
    if (running) return;
    running = true;
    timer = setInterval(tick, intervalMs);
    // `unref()`: timer KHÔNG giữ tiến trình sống — server tắt là tiến trình thoát được ngay.
    timer?.unref?.();
    logAt('info', 'scheduler.started', { interval_ms: intervalMs, enabled });
  }

  /** Tắt sạch: xoá interval rồi CHỜ nhịp đang chạy xong. Idempotent, không ném. */
  async function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    const wasRunning = running;
    running = false;
    // Chờ MỌI nhịp đang chạy (kể cả `runOnce()` gọi tay) — tránh đóng DB khi còn việc dở.
    if (pending.size > 0) await Promise.allSettled([...pending]);
    if (wasRunning) logAt('info', 'scheduler.stopped', { ticks });
  }

  /** Số liệu cho `/api/health` — chỉ cờ + số đếm, KHÔNG bí mật, KHÔNG đường dẫn. */
  function stats() {
    return {
      enabled,
      running,
      interval_ms: intervalMs,
      ticks,
      last_tick_at: lastTickAt,
      last_result: lastResult ? { ...lastResult } : null,
    };
  }

  return { start, stop, runOnce, stats };
}

export default createScheduler;
