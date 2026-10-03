/**
 * Làm sạch dữ liệu lấy từ nguồn ngoài trước khi lưu hoặc trả về UI.
 * Chống stored XSS và chống nhét ký tự điều khiển vào DB/log.
 */

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape HTML entity. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Làm sạch text thô từ nguồn: bỏ ký tự điều khiển, gộp khoảng trắng, cắt độ dài.
 * Không escape HTML ở đây — việc escape thuộc về tầng render.
 */
export function sanitizeText(value, { maxLength = 20000 } = {}) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  s = s.normalize('NFC').replace(CONTROL_CHARS, '');
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/[ \t\u00A0\u2000-\u200B]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  s = s.trim();
  if (s.length > maxLength) s = `${s.slice(0, maxLength)}…`;
  return s;
}

/** Làm sạch URL: chỉ giữ http/https, còn lại trả ''. */
export function sanitizeUrl(value, { maxLength = 2048 } = {}) {
  const raw = sanitizeText(value, { maxLength });
  if (!raw) return '';
  if (raw.startsWith('//')) return `https:${raw}`;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString();
  } catch {
    return '';
  }
}

/** Làm sạch tên file do người dùng gửi lên. */
export function sanitizeFilename(name, { fallback = 'upload' } = {}) {
  const base = String(name ?? '')
    .split(/[/\\]/)
    .pop()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return base || fallback;
}

const DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,/i;

/**
 * Làm sạch THAM CHIẾU ảnh — khác `sanitizeUrl` ở chỗ cho phép cả `data:image/...;base64,`.
 *
 * Vì sao cần hàm riêng: ảnh người dùng tải lên (G11) vào hệ thống dưới dạng data URL.
 * Nếu đem qua `sanitizeUrl` (chỉ nhận http/https) thì URL bị xoá thành rỗng, và hậu quả
 * là bước Vision âm thầm không bao giờ chạy — đúng lỗi đã xảy ra ở lượt chạy đầu.
 */
export function sanitizeImageRef(value, { maxLength = 8 * 1024 * 1024 } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.startsWith('data:')) {
    if (!DATA_IMAGE_RE.test(raw)) return '';
    if (raw.length > maxLength) return '';
    if (raw.indexOf(',') === -1) return '';
    return raw;
  }
  return sanitizeUrl(raw, { maxLength: 2048 });
}

/**
 * Phát hiện magic bytes của ảnh. Không tin `Content-Type` do client khai.
 * @returns {string|null} MIME thật, hoặc null nếu không nhận dạng được.
 */
export function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** Loại bỏ khoá nguy hiểm khi merge object từ JSON ngoài (prototype pollution). */
export function safeJsonParse(text, { fallback = null } = {}) {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return stripDangerousKeys(parsed);
  } catch {
    return fallback;
  }
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function stripDangerousKeys(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripDangerousKeys(v, depth + 1));
  const out = Object.create(null);
  for (const [k, v] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    out[k] = stripDangerousKeys(v, depth + 1);
  }
  return out;
}
