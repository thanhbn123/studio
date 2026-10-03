/**
 * Background job abstraction.
 *
 * MVP chạy hàng đợi TRONG TIẾN TRÌNH: đủ cho một instance và đủ để thay bằng
 * Redis/BullMQ sau này mà không phải sửa tầng gọi — tầng gọi chỉ biết `enqueue()`
 * và `on('done')`.
 *
 * Đặc tính:
 *  - Giới hạn số job chạy song song.
 *  - Thử lại có kiểm soát (`maxAttempts`), có backoff.
 *  - Không bao giờ để lỗi của một job làm chết worker.
 *  - `drain()` để test chờ chạy xong.
 */

import { EventEmitter } from 'node:events';

export const JOB_STATE = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
});

export class JobQueue extends EventEmitter {
  constructor({ concurrency = 2, maxAttempts = 2, logger, retryDelayMs = 500 } = {}) {
    super();
    this.concurrency = Math.max(1, concurrency);
    this.maxAttempts = Math.max(1, maxAttempts);
    this.logger = logger;
    this.retryDelayMs = retryDelayMs;
    this.queue = [];
    this.active = new Map(); // id -> {attempts, state}
    this.running = 0;
    this.idleResolvers = [];
  }

  get size() {
    return this.queue.length + this.running;
  }

  stats() {
    return {
      queued: this.queue.length,
      running: this.running,
      concurrency: this.concurrency,
      tracked: this.active.size,
    };
  }

  /**
   * @param {string} id
   * @param {() => Promise<any>} handler
   */
  enqueue(id, handler) {
    this.active.set(id, { attempts: 0, state: JOB_STATE.PENDING });
    this.queue.push({ id, handler });
    this.#pump();
    return id;
  }

  #pump() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this.running += 1;
      this.#runItem(item)
        .catch(() => {
          /* đã xử lý bên trong */
        })
        .finally(() => {
          this.running -= 1;
          if (this.size === 0) this.#resolveIdle();
          this.#pump();
        });
    }
    if (this.size === 0) this.#resolveIdle();
  }

  async #runItem({ id, handler }) {
    const entry = this.active.get(id) || { attempts: 0, state: JOB_STATE.PENDING };
    entry.attempts += 1;
    entry.state = JOB_STATE.RUNNING;
    this.active.set(id, entry);

    try {
      const result = await handler({ attempt: entry.attempts });
      entry.state = JOB_STATE.DONE;
      this.active.set(id, entry);
      this.emit('done', { id, result, attempts: entry.attempts });
    } catch (err) {
      if (entry.attempts < this.maxAttempts) {
        this.logger?.warn('job.retry', { job_id: id, attempt: entry.attempts, error: err });
        entry.state = JOB_STATE.PENDING;
        this.active.set(id, entry);
        await new Promise((r) => setTimeout(r, this.retryDelayMs * entry.attempts));
        this.queue.push({ id, handler });
        return;
      }
      entry.state = JOB_STATE.FAILED;
      entry.error = err?.message || String(err);
      this.active.set(id, entry);
      this.emit('failed', { id, error: err, attempts: entry.attempts });
    }
  }

  #resolveIdle() {
    const resolvers = this.idleResolvers;
    this.idleResolvers = [];
    for (const r of resolvers) r();
  }

  /** Chờ tới khi hàng đợi rỗng. Dùng trong test và graceful shutdown. */
  drain() {
    if (this.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  /** Chờ một job cụ thể kết thúc. */
  waitFor(id) {
    const entry = this.active.get(id);
    if (entry && (entry.state === JOB_STATE.DONE || entry.state === JOB_STATE.FAILED)) {
      return Promise.resolve(entry);
    }
    return new Promise((resolve) => {
      const onDone = ({ id: jid }) => {
        if (jid !== id) return;
        cleanup();
        resolve(this.active.get(id));
      };
      const onFailed = ({ id: jid }) => {
        if (jid !== id) return;
        cleanup();
        resolve(this.active.get(id));
      };
      const cleanup = () => {
        this.off('done', onDone);
        this.off('failed', onFailed);
      };
      this.on('done', onDone);
      this.on('failed', onFailed);
    });
  }

  stateOf(id) {
    return this.active.get(id) || null;
  }
}

export default JobQueue;
