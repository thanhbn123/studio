/**
 * Tiện ích dùng chung cho bộ test `test/pg-*.test.js` — NGHIỆP VỤ THẬT TRÊN POSTGRESQL.
 *
 * Vì sao cần: mọi bộ test khác ép `DB_DRIVER=sqlite` + `SQLITE_PATH=:memory:` (xem
 * `test/helpers.js#testConfig`), nên các bảng mới của MVP-03/04/05 và R1 chỉ được chứng minh
 * trên SQLite. CI có job PostgreSQL 16 thật nhưng trước sprint này chỉ chạy **schema +
 * migration**, không chạy nghiệp vụ. Các file `pg-*.test.js` bịt đúng lỗ đó.
 *
 * Hai luật của bộ test này:
 *   1. **BỎ QUA CÓ KIỂM SOÁT** khi thiếu `DATABASE_URL` (giống `test/store.test.js` và
 *      `test/imagelab-store-postgres.test.js`) ⇒ máy không có PostgreSQL vẫn chạy hết bộ test.
 *   2. **DỌN SẠCH** mọi dòng mình tạo, kể cả khi test đỏ — DB PostgreSQL là DB DÙNG CHUNG,
 *      không được để rác lại cho lần chạy sau.
 *
 * File này KHÔNG có hậu tố `.test.js` nên `node --test test/*.test.js` không chạy nó.
 */

import { randomUUID } from 'node:crypto';

import { testConfig, silent } from './helpers.js';

export { silent };

/** Có PostgreSQL thật hay không — quyết định bỏ qua cả file. */
export const hasPg = Boolean(process.env.DATABASE_URL);

/** Lý do bỏ qua, dùng cho `{ skip: skipNoPg }` của `node:test`. */
export const skipNoPg = hasPg ? false : 'không có DATABASE_URL — bỏ qua (giống test/store.test.js)';

/** Cấu hình store PostgreSQL thật (các field khác giữ nguyên mặc định test: không mạng, không API key). */
export const pgConfig = (overrides = {}) =>
  testConfig({ DB_DRIVER: 'postgres', DATABASE_URL: process.env.DATABASE_URL, ...overrides });

/** Cấu hình SQLite in-memory — dùng để so sánh HAI DIALECT trong cùng một test. */
export const sqliteConfig = (overrides = {}) => testConfig(overrides);

/* ───────────────────────── danh tính riêng cho mỗi lần chạy ───────────────────────── */

/**
 * Tiền tố DUY NHẤT cho một lần chạy test. Mọi `user_id`/`job_id` đều mang tiền tố này nên
 * hai lần chạy song song (hoặc rác của lần chạy trước) KHÔNG lẫn vào nhau.
 */
export const RUN_TAG = `pgt-${randomUUID().slice(0, 8)}`;

export const newUserId = (label = 'u') => `${RUN_TAG}-${label}-${randomUUID()}`;
export const newJobId = (label = 'j') => `${RUN_TAG}-${label}-${randomUUID()}`;

/* ───────────────────────── dọn dẹp ───────────────────────── */

/**
 * Xoá mọi dòng do lần chạy này tạo ra, theo `RUN_TAG`.
 *
 * Thứ tự xoá theo chiều phụ thuộc (bảng con trước). Mỗi câu `catch` riêng: bảng thiếu ở DB cũ
 * không được làm hỏng phần dọn còn lại.
 */
export async function purgeRunRows(store) {
  const like = `${RUN_TAG}-%`;
  for (const sql of [
    'DELETE FROM translation_lines WHERE job_id LIKE ?',
    'DELETE FROM ocr_regions WHERE job_id LIKE ?',
    'DELETE FROM image_assets WHERE job_id LIKE ?',
    'DELETE FROM usage_events WHERE job_id LIKE ?',
    'DELETE FROM extraction_evidence WHERE job_id LIKE ?',
    'DELETE FROM uploads WHERE job_id LIKE ?',
    'DELETE FROM job_queue WHERE job_id LIKE ?',
    'DELETE FROM wallet_ledger WHERE user_id LIKE ? OR job_id LIKE ?',
    'DELETE FROM user_sessions WHERE user_id LIKE ?',
    'DELETE FROM jobs WHERE id LIKE ? OR user_id LIKE ?',
    'DELETE FROM users WHERE id LIKE ?',
  ]) {
    const params = (sql.match(/\?/g) || []).map(() => like);
    await store.driver.run(sql, params).catch(() => {});
  }
}

/* ───────────────────────── đọc sổ credit ───────────────────────── */

export const ledgerRows = (store, userId) => store.listLedger({ userId, limit: 500 });

/** Tổng sổ tính Ở TẦNG JS (không nhờ SQL) — để đối chiếu với `store.ledgerBalance`. */
export const jsLedgerSum = async (store, userId) => {
  const rows = await ledgerRows(store, userId);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  return Math.round(total * 1e6) / 1e6;
};

/* ───────────────────────── hàng đợi ───────────────────────── */

/**
 * Xếp một mục hàng đợi rồi ĐẨY `created_at` về QUÁ KHỨ XA (năm 1990 + thứ tự).
 *
 * Vì sao phải backdate: `claimNextJob` nhặt mục `queued` CŨ NHẤT **trên toàn bảng** — nó không
 * có tham số lọc theo test. Trên DB dùng chung, rác `queued` của lần chạy trước sẽ bị nhặt
 * trước mục của test và làm test đỏ oan. Backdate bảo đảm mục của test luôn ở ĐẦU hàng đợi,
 * mà KHÔNG phải xoá dữ liệu của người khác (`DELETE FROM job_queue` trần là thao tác phá hoại
 * nếu `DATABASE_URL` trỏ vào DB thật).
 */
export async function enqueueBackdated(store, { jobId, handler = 'run', kind = 'content', maxAttempts = 3, order = 0, payload = null } = {}) {
  const item = await store.enqueueJob({ jobId, handler, kind, maxAttempts, payload });
  const createdAt = `1990-01-01T00:00:${String(order % 60).padStart(2, '0')}.${String(order).padStart(3, '0').slice(-3)}Z`;
  await store.driver.run('UPDATE job_queue SET created_at = ? WHERE id = ?', [createdAt, item.id]);
  return { ...item, created_at: createdAt };
}

/** Đặt nhịp tim / mốc khoá của một mục về QUÁ KHỨ để `requeueStaleJobs` coi là mất nhịp. */
export const makeStale = (store, id, at = '1990-01-01T00:00:00.000Z') =>
  store.driver.run('UPDATE job_queue SET heartbeat_at = ?, locked_at = ?, updated_at = ? WHERE id = ?', [at, at, at, id]);

export const queueRow = (store, id) => store.driver.get('SELECT * FROM job_queue WHERE id = ?', [id]);
