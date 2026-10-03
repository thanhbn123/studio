/**
 * Driver PostgreSQL.
 *
 * Dùng package `pg` (không viết lại wire protocol). Điểm đáng chú ý: driver này
 * nhận CÙNG câu SQL với driver SQLite (placeholder `?`) rồi tự dịch sang `$1..$n`.
 * Nhờ vậy schema và tầng repository chỉ có một bản duy nhất.
 *
 * `pg` được import ĐỘNG: nếu môi trường không cài `pg` thì SQLite vẫn chạy bình
 * thường, và lỗi hiện ra rõ ràng chỉ khi thật sự chọn DB_DRIVER=postgres.
 */

export class PostgresDriver {
  /** @param {{url:string, sslMode?:string, poolMax?:number, logger?:object}} opts */
  constructor({ url, sslMode = 'disable', poolMax = 10, logger } = {}) {
    this.dialect = 'postgres';
    this.url = url;
    this.sslMode = sslMode;
    this.poolMax = poolMax;
    this.logger = logger;
    this.pool = null;
  }

  /** `?` → `$1, $2, ...` (bỏ qua dấu ? nằm trong chuỗi literal). */
  static toPgPlaceholders(sql) {
    let i = 0;
    let out = '';
    let inSingle = false;
    for (let c = 0; c < sql.length; c += 1) {
      const ch = sql[c];
      if (ch === "'") {
        // '' là escape hợp lệ trong SQL
        if (inSingle && sql[c + 1] === "'") {
          out += "''";
          c += 1;
          continue;
        }
        inSingle = !inSingle;
        out += ch;
        continue;
      }
      if (ch === '?' && !inSingle) {
        i += 1;
        out += `$${i}`;
        continue;
      }
      out += ch;
    }
    return out;
  }

  async connect() {
    if (this.pool) return this;
    if (!this.url) throw new Error('DATABASE_URL chưa được cấu hình cho DB_DRIVER=postgres.');
    let pg;
    try {
      pg = await import('pg');
    } catch (err) {
      throw new Error(
        `Không import được package "pg". Cài bằng \`npm install pg\` hoặc dùng DB_DRIVER=sqlite. Chi tiết: ${err.message}`,
      );
    }
    const { Pool } = pg.default ?? pg;
    const ssl =
      this.sslMode === 'require' || this.sslMode === 'verify-full'
        ? { rejectUnauthorized: this.sslMode === 'verify-full' }
        : false;
    this.pool = new Pool({ connectionString: this.url, max: this.poolMax, ssl });
    // Lỗi ở client nhàn rỗi không được làm sập tiến trình.
    this.pool.on('error', (err) => this.logger?.error('pg.pool_error', { error: err }));
    return this;
  }

  async exec(sql) {
    await this.connect();
    await this.pool.query(sql);
  }

  async run(sql, params = []) {
    await this.connect();
    const res = await this.pool.query(PostgresDriver.toPgPlaceholders(sql), params);
    return { changes: res.rowCount ?? 0, lastInsertRowid: null };
  }

  async all(sql, params = []) {
    await this.connect();
    const res = await this.pool.query(PostgresDriver.toPgPlaceholders(sql), params);
    return res.rows;
  }

  async get(sql, params = []) {
    const rows = await this.all(sql, params);
    return rows[0] ?? null;
  }

  async transaction(fn) {
    await this.connect();
    const client = await this.pool.connect();
    const scoped = {
      dialect: this.dialect,
      run: async (sql, params = []) => {
        const res = await client.query(PostgresDriver.toPgPlaceholders(sql), params);
        return { changes: res.rowCount ?? 0, lastInsertRowid: null };
      },
      all: async (sql, params = []) => (await client.query(PostgresDriver.toPgPlaceholders(sql), params)).rows,
      get: async (sql, params = []) =>
        (await client.query(PostgresDriver.toPgPlaceholders(sql), params)).rows[0] ?? null,
    };
    try {
      await client.query('BEGIN');
      const result = await fn(scoped);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* bỏ qua */
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    if (!this.pool) return;
    const p = this.pool;
    this.pool = null;
    await p.end();
  }
}

export default PostgresDriver;
