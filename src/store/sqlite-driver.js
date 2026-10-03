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
  constructor({ path: file, logger } = {}) {
    this.dialect = 'sqlite';
    this.file = file || ':memory:';
    this.logger = logger;
    this.db = null;
  }

  async connect() {
    if (this.db) return this;
    if (this.file !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
    }
    this.db = new DatabaseSync(this.file);
    // WAL cho phép đọc/ghi song song tốt hơn; FK phải bật thủ công trong SQLite.
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA foreign_keys = ON;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
    } catch (err) {
      this.logger?.warn('sqlite.pragma_failed', { error: err });
    }
    return this;
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
