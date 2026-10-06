/**
 * Tiện ích dùng chung cho bộ test MVP-05 (tài khoản + ví credit).
 *
 * Nguyên tắc giống `test/imagelab-helpers.js`: KHÔNG cần mạng, KHÔNG cần API key.
 * App được dựng THẬT (`createApp` + server thật trên 127.0.0.1) với store SQLite
 * in-memory, provider chạy offline, và wiring MVP-05 thật (`src/app.js` tự nạp
 * `src/accounts/**` + `src/billing/**`). Nhờ vậy test khẳng định HÀNH VI THẬT của
 * chuỗi route → hook → service → store → DB, không phải bản chép lại tay.
 *
 * File này KHÔNG có hậu tố `.test.js` nên `node --test test/*.test.js` không chạy nó.
 */

import { createHash } from 'node:crypto';

import { testConfig, silent } from './helpers.js';
import { startImagelabApp, j, tmpDir, cleanupTmp, imagelabConfig } from './imagelab-helpers.js';

export { testConfig, silent, j, tmpDir, cleanupTmp, imagelabConfig };

/** sha256 hex — đúng hàm A1 dùng để băm token trước khi lưu (`src/accounts/index.js`). */
export const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');

/** Mật khẩu mặc định của test: dài hơn sàn 10 ký tự của hợp đồng §3.1. */
export const PASSWORD = 'matkhau-du-phong-123';

/**
 * Dựng app THẬT đủ MVP-01/02/03 + wiring MVP-05.
 *
 * Nới rate limit mặc định vì một file test tạo nhiều job/đăng ký từ cùng một IP —
 * đó là chi tiết của bộ test, không phải hành vi đang được kiểm.
 */
export async function startMvp05App({ configOverrides = {}, ...rest } = {}) {
  return startImagelabApp({
    configOverrides: {
      RATE_LIMIT_MAX_JOBS: '2000',
      RATE_LIMIT_MAX_REQUESTS: '20000',
      ...configOverrides,
    },
    ...rest,
  });
}

/* ───────────────────────────── cookie jar ───────────────────────────── */

export function newJar() {
  return Object.create(null);
}

export function jarHeader(jar) {
  return Object.entries(jar)
    .filter(([, value]) => value !== '' && value !== null && value !== undefined)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/** Hấp thụ `Set-Cookie` của response vào jar (cookie rỗng = bị xoá, như `Max-Age=0`). */
export function absorbCookies(jar, res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const pair = String(raw).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    if (value === '') delete jar[name];
    else jar[name] = value;
  }
  return jar;
}

/** fetch có jar cookie + JSON body; KHÔNG tự thêm cookie `sid` nào. */
export async function request(base, path, { method = 'GET', body, jar, headers = {} } = {}) {
  const h = { ...headers };
  const cookie = jar ? jarHeader(jar) : '';
  if (cookie) h.cookie = cookie;
  let payload;
  if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers: h, body: payload });
  if (jar) absorbCookies(jar, res);
  return res;
}

/* ───────────────────────── luồng tài khoản ───────────────────────── */

export async function register(base, { email, password = PASSWORD, display_name, jar = newJar() } = {}) {
  const res = await request(base, '/api/auth/register', {
    method: 'POST',
    body: { email, password, ...(display_name ? { display_name } : {}) },
    jar,
  });
  return { res, body: await j(res), jar };
}

export async function login(base, { email, password = PASSWORD, jar = newJar() } = {}) {
  const res = await request(base, '/api/auth/login', { method: 'POST', body: { email, password }, jar });
  return { res, body: await j(res), jar };
}

export const logout = (base, jar) => request(base, '/api/auth/logout', { method: 'POST', jar });

export const me = (base, jar) => request(base, '/api/auth/me', { jar });

/** Token THÔ trong cookie `vauth` (chỉ có ở client — DB chỉ giữ sha256). */
export const authTokenOf = (jar) => jar?.vauth ?? null;

/* ───────────────────────── truy vấn DB thật ───────────────────────── */

export async function countRows(store, table, where = '') {
  const row = await store.driver.get(`SELECT COUNT(*) AS n FROM ${table}${where ? ` ${where}` : ''}`);
  return Number(row?.n ?? 0);
}

export const ledgerRows = (store, userId, extra = {}) => store.listLedger({ userId, limit: 500, ...extra });

export const ledgerCount = async (store, userId) => (await ledgerRows(store, userId)).length;

export const reasonCount = async (store, userId, reason) =>
  (await ledgerRows(store, userId)).filter((row) => row.reason === reason).length;

/**
 * Tổng sổ = số dư (làm tròn 6 chữ số như `roundMoney` của tầng billing).
 * Cộng thô các `amount` (REAL) vẫn sinh nhiễu float `0.1 + 0.2`, nên phải làm tròn —
 * đúng luật #2 của hợp đồng: tiền tệ là số có 6 chữ số thập phân.
 */
export const ledgerSum = async (store, userId) => {
  const total = (await ledgerRows(store, userId)).reduce((sum, row) => sum + row.amount, 0);
  return Math.round((total + Math.sign(total) * Number.EPSILON) * 1e6) / 1e6;
};

/* ───────────────────────── chờ job ───────────────────────── */

const RUNNING = new Set(['queued', 'running']);

/**
 * Poll trạng thái job như UI thật, dừng khi job rời `queued|running`.
 * `shape` = 'job' cho `/api/jobs/:id` (status ở gốc), 'wrapped' cho imagelab/imagestudio.
 */
export async function waitJob(base, jobId, { jar, path = '/api/jobs', shape = 'job', tries = 400, delay = 15 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    const res = await request(base, `${path}/${jobId}`, { jar });
    last = await j(res);
    const status = shape === 'wrapped' ? last?.job?.status : last?.status;
    if (!RUNNING.has(status)) return last;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`job ${jobId} không kết thúc kịp: ${JSON.stringify(last)?.slice(0, 300)}`);
}

export const statusOf = (data, shape = 'job') => (shape === 'wrapped' ? data?.job?.status : data?.status);
