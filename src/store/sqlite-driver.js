/**
 * Driver SQLite — dùng `node:sqlite` có sẵn trong Node (>=22.5), KHÔNG cần npm.
 *
 * Vì sao chọn built-in thay vì better-sqlite3: repo giữ ít phụ thuộc, CI không phải
 * biên dịch native module, và Docker image nhẹ. Đánh đổi: API đồng bộ, nên driver
 * bọc lại thành async để hai driver (SQLite/PostgreSQL) dùng chung một hình dạng.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export class SqliteDriver {
  /** @param {{path:string, logger?:object}} opts */
  constructor({ path: file, logger, config = null } = {}) {
    this.dialect = 'sqlite';
    this.file = file || ':memory:';
    this.logger = logger;
    this.config = config;
    this.db = null;
  }

  async connect() {
    if (this.db) return this;
    if (this.file !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
    }
    // A1 (phản biện R1 vòng 2, VỪA–CAO) — THỨ TỰ PRAGMA QUAN TRỌNG:
    // `busy_timeout` phải được đặt TRƯỚC TIÊN. Trước đây cả ba pragma nằm trong MỘT `try`: khi
    // `PRAGMA journal_mode = WAL` gặp `SQLITE_BUSY` (nhiều tiến trình boot cùng lúc trên DB trắng),
    // lỗi bị nuốt và **busy_timeout không bao giờ được đặt** ⇒ mọi câu DDL sau đó fail sau 0ms ⇒
    // `Store.init()` ném `database is locked` và tiến trình CHẾT (đo được: 6/16 lần boot chết).
    this.db = new DatabaseSync(this.file, { timeout: this.busyTimeoutMs });
    this.#pragma('busy_timeout', `PRAGMA busy_timeout = ${this.busyTimeoutMs};`, { critical: true });
    // FK phải bật thủ công trong SQLite; lỗi ở đây KHÔNG được làm mất timeout đã đặt.
    this.#pragma('foreign_keys', 'PRAGMA foreign_keys = ON;');
    // WAL cho phép đọc/ghi song song tốt hơn — nhưng là pragma "đổi chế độ ghi", có thể gặp
    // SQLITE_BUSY khi tiến trình khác đang mở; thử lại vài lần rồi mới chịu thua (không chết).
    this.#pragmaWithRetry('journal_mode', 'PRAGMA journal_mode = WAL;', { attempts: 10, baseMs: 100, maxMs: 500 });
    return this;
  }

  /** Số ms chờ khoá ghi của SQLite (A1/A5): `config.queue.lockTimeoutMs` hoặc 5000. */
  get busyTimeoutMs() {
    const raw = Number(this.config?.queue?.lockTimeoutMs ?? this.config?.db?.busyTimeoutMs);
    if (Number.isFinite(raw) && raw > 0) return Math.min(60000, Math.trunc(raw));
    return 5000;
  }

  /** Đặt MỘT pragma, lỗi chỉ ghi log (trừ `critical` — khi đó ném để tầng trên biết). @private */
  #pragma(name, sql, { critical = false } = {}) {
    try {
      this.db.exec(sql);
      return true;
    } catch (err) {
      this.logger?.warn('sqlite.pragma_failed', { pragma: name, error_code: err?.code ?? null, error: String(err?.message ?? err) });
      if (critical) throw err;
      return false;
    }
  }

  /** Pragma có thể gặp SQLITE_BUSY khi nhiều tiến trình boot: thử lại với backoff. @private */
  #pragmaWithRetry(name, sql, { attempts = 10, baseMs = 100, maxMs = 500 } = {}) {
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (this.#pragma(name, sql)) return true;
      last = attempt;
      // `Atomics.wait` đồng bộ: hàm này chạy trong `connect()` (đồng bộ) nên không await được.
      const wait = Math.min(maxMs, baseMs * attempt);
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
      } catch {
        /* không có SharedArrayBuffer ⇒ bỏ qua chờ, thử lại ngay */
      }
    }
    this.logger?.warn('sqlite.pragma_give_up', { pragma: name, attempts: last });
    return false;
  }

  async exec(sql) {
    await this.connect();
    this.db.exec(sql);
  }

  async run(sql, params = []) {
    await this.connect();
    const stmt = this.db.prepare(sql);
    const res = stmt.run(...params);
    return {
      changes: Number(res.changes ?? 0),
      lastInsertRowid: res.lastInsertRowid === undefined ? null : Number(res.lastInsertRowid),
    };
  }

  async all(sql, params = []) {
    await this.connect();
    return this.db.prepare(sql).all(...params);
  }

  async get(sql, params = []) {
    await this.connect();
    const row = this.db.prepare(sql).get(...params);
    return row ?? null;
  }

  /**
   * Chạy nhiều câu trong một transaction.
   * node:sqlite không có helper transaction, nên tự phát BEGIN/COMMIT/ROLLBACK.
   */
  async transaction(fn) {
    await this.connect();
    this.db.exec('BEGIN');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* rollback có thể lỗi nếu transaction đã hỏng — bỏ qua */
      }
      throw err;
    }
  }

  async close() {
    if (!this.db) return;
    try {
      this.db.close();
    } finally {
      this.db = null;
    }
  }
}

export default SqliteDriver;
