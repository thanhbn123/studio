/**
 * Nạp biến môi trường từ `.env` mà không cần thư viện ngoài.
 *
 * Vì sao tự viết thay vì dùng `dotenv`: repo này cố ý giữ ít phụ thuộc, và
 * `node --env-file` chỉ có từ Node 20.6+ nhưng lại không cho phép nạp có điều kiện
 * theo ý muốn (bỏ qua file thiếu, không ghi đè biến đã có).
 *
 * Quy tắc: biến đã có trong process.env LUÔN thắng file `.env`.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Parse nội dung .env thành object. Hỗ trợ comment, nháy đơn/kép, giá trị rỗng. */
export function parseEnv(content) {
  const out = {};
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // Bỏ comment cuối dòng chỉ khi không nằm trong nháy
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Nạp `.env` (và tuỳ chọn `.env.local`, `.env.<NODE_ENV>`) vào process.env.
 * @returns {string[]} danh sách file đã nạp
 */
export function loadDotEnv({ cwd = process.cwd(), env = process.env, files } = {}) {
  const candidates =
    files ??
    ['.env.local', `.env.${env.NODE_ENV || 'development'}`, '.env'].map((f) => path.resolve(cwd, f));

  const loaded = [];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let parsed;
    try {
      parsed = parseEnv(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // KHÔNG được `catch { continue; }` ở đây. Nuốt lỗi nghĩa là một `.env` hỏng
      // (sai quyền, ký tự lạ) khiến ứng dụng chạy bằng giá trị MẶC ĐỊNH trong im lặng —
      // người vận hành tưởng đã cấu hình mà thật ra chưa. Dừng ngay và nói rõ file nào.
      const e = new Error(`Không đọc được file cấu hình "${file}": ${err.message}`);
      e.code = 'ENV_FILE_UNREADABLE';
      throw e;
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (env[k] === undefined || env[k] === '') env[k] = v;
    }
    loaded.push(file);
  }
  return loaded;
}

export default loadDotEnv;
