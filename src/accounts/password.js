/**
 * Băm & kiểm mật khẩu — `scrypt` của `node:crypto` (hợp đồng MVP-05 §3.1, A1).
 *
 * Vì sao KHÔNG dùng thư viện ngoài (bcrypt/argon2): ràng buộc sprint chỉ cho `pg` +
 * built-in Node. `scrypt` là KDF có sẵn, chống GPU/ASIC tốt hơn PBKDF2 cùng chi phí.
 *
 * Định dạng lưu (một chuỗi duy nhất, KHÔNG lưu tham số ở nơi khác):
 *   scrypt$N$r$p$<salt-b64>$<hash-b64>
 * Tham số nằm ngay trong chuỗi nên sau này nâng N/r/p vẫn kiểm được mật khẩu cũ
 * (`verifyPassword` đọc tham số TỪ CHUỖI LƯU, không dùng hằng số hiện hành).
 *
 * Nguyên tắc fail-closed: `verifyPassword` KHÔNG BAO GIỜ ném. Chuỗi lưu hỏng, tham số
 * vô lý, đầu vào không phải chuỗi ⇒ `false`. Ném lỗi ở đây sẽ biến một dòng DB hỏng
 * thành lỗi 500 (lộ thông tin nội bộ) thay vì một lần đăng nhập bị từ chối.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Độ dài tối thiểu của mật khẩu — HỢP ĐỒNG §3.1 chốt 10, không được hạ xuống. */
export const PASSWORD_MIN_LENGTH = 10;

/**
 * Trần độ dài mật khẩu (chặn trong tiến trình). Không phải quy tắc bảo mật mà là
 * chốt chặn tài nguyên: một "mật khẩu" 50 MB vẫn bị scrypt băm, tốn CPU vô ích.
 */
export const PASSWORD_MAX_LENGTH = 4096;

/** Tham số scrypt ĐÓNG BĂNG cho hash mới (N=16384, r=8, p=1, salt 16 byte). */
export const SCRYPT_PARAMS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  keylen: 64,
  saltBytes: 16,
});

// ── Trần tài nguyên khi ĐỌC chuỗi đã lưu ──────────────────────────────────────
// `verifyPassword` nhận tham số từ chuỗi trong DB. Nếu kẻ tấn công ghi được vào DB
// (SQL injection ở nơi khác, file backup bị sửa) thì N=2^30 sẽ làm sập tiến trình.
// Mọi giá trị vượt trần ⇒ `false` ngay, KHÔNG gọi scrypt.
const MAX_N = 1 << 18; // 262144
const MAX_R = 16;
const MAX_P = 8;
const MAX_SCRYPT_BYTES = 64 * 1024 * 1024; // 128 * N * r <= 64 MB
const MIN_SALT_BYTES = 8;
const MAX_SALT_BYTES = 64;
const MIN_KEY_BYTES = 16;
const MAX_KEY_BYTES = 128;

/**
 * Hình dạng chuỗi lưu hợp lệ. Base64 chuẩn (có `+` `/` `=`), KHÔNG phải base64url —
 * đúng như ví dụ `scrypt$N$r$p$<salt-b64>$<hash-b64>` của hợp đồng.
 */
const STORED_RE =
  /^scrypt\$(\d{1,7})\$(\d{1,3})\$(\d{1,3})\$([A-Za-z0-9+/]{8,120}={0,2})\$([A-Za-z0-9+/]{16,240}={0,2})$/;

/** Băm mật khẩu mới. Đồng bộ theo hợp đồng (`→ string`), salt NGẪU NHIÊN mỗi lần gọi. */
export function hashPassword(password) {
  if (typeof password !== 'string') {
    // Lỗi lập trình, không phải lỗi người dùng: ném để lộ ngay tại tầng gọi.
    const err = new Error('hashPassword cần một chuỗi mật khẩu.');
    err.code = 'INVALID_PASSWORD';
    throw err;
  }
  const { N, r, p, keylen, saltBytes } = SCRYPT_PARAMS;
  const salt = randomBytes(saltBytes);
  const hash = scryptSync(password, salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Giải mã base64 CHÍNH TẮC — chỉ nhận đúng dạng mà `hashPassword` ghi ra.
 *
 * `Buffer.from(x, 'base64')` rất khoan dung: chuỗi THIẾU `=` vẫn giải mã ra đúng số byte
 * cũ (ví dụ cắt 2 ký tự `==` ở cuối vẫn cho lại đúng hash 64 byte ⇒ `verifyPassword`
 * trả `true` cho một chuỗi KHÁC với chuỗi gốc), và ký tự cuối của nhóm base64 có 4 bit
 * "không quan trọng" nên nhiều biến thể cùng giải ra một giá trị. Ta chỉ chấp nhận dạng
 * chính tắc: mã hoá lại phải ra ĐÚNG chuỗi ban đầu. Mọi biến thể ⇒ coi là chuỗi hỏng.
 */
function decodeCanonicalBase64(text) {
  const buffer = Buffer.from(text, 'base64');
  return buffer.toString('base64') === text ? buffer : null;
}

/**
 * Kiểm mật khẩu với chuỗi đã lưu. Trả `boolean`, KHÔNG BAO GIỜ ném.
 * So sánh bằng `timingSafeEqual` (không rò rỉ tiền tố đúng qua thời gian).
 */
export function verifyPassword(password, stored) {
  try {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;

    const match = STORED_RE.exec(stored.trim());
    if (!match) return false;

    const N = Number(match[1]);
    const r = Number(match[2]);
    const p = Number(match[3]);

    // N phải là luỹ thừa của 2 (yêu cầu của scrypt) và nằm trong trần tài nguyên.
    if (!Number.isSafeInteger(N) || N < 1024 || N > MAX_N || (N & (N - 1)) !== 0) return false;
    if (!Number.isSafeInteger(r) || r < 1 || r > MAX_R) return false;
    if (!Number.isSafeInteger(p) || p < 1 || p > MAX_P) return false;
    if (128 * N * r > MAX_SCRYPT_BYTES) return false;

    const salt = decodeCanonicalBase64(match[4]);
    const expected = decodeCanonicalBase64(match[5]);
    if (!salt || !expected) return false;
    if (salt.length < MIN_SALT_BYTES || salt.length > MAX_SALT_BYTES) return false;
    if (expected.length < MIN_KEY_BYTES || expected.length > MAX_KEY_BYTES) return false;

    const actual = scryptSync(password, salt, expected.length, { N, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    // Chuỗi lưu hỏng / tham số không hợp lệ / lỗi bộ nhớ ⇒ từ chối, KHÔNG ném.
    return false;
  }
}
