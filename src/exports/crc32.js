/**
 * CRC32 (IEEE 802.3, đa thức 0xEDB88320) — TỰ DỰNG BẢNG, không dùng thư viện.
 *
 * ZIP buộc mỗi entry phải có CRC32 của dữ liệu CHƯA nén trong header; `unzip`, Finder,
 * Windows Explorer đều kiểm giá trị này khi giải nén. Sai CRC ⇒ công cụ ngoài báo
 * "file hỏng" dù cấu trúc ZIP đúng.
 *
 * Cùng đa thức với `crc32` của `src/imagelab/render/png.js` (PNG cũng dùng CRC32 IEEE)
 * nhưng đây là bản của `src/exports/**` — X1 không sửa/không phụ thuộc module anh em.
 */

/** Bảng tra 256 mục: mục thứ n = CRC32 của một byte n. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** Ép về Buffer CHỈ ĐỂ ĐỌC (không copy khi đã là Buffer). */
function asView(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === 'string') return Buffer.from(input, 'utf8');
  return null;
}

/**
 * CRC32 của một buffer (hoặc chuỗi UTF-8).
 *
 * @param {Buffer|Uint8Array|string} buffer
 * @returns {number} số nguyên không dấu 0..4294967295 (KHÔNG trả số âm có dấu)
 */
export function crc32(buffer) {
  const view = asView(buffer);
  if (!view) {
    const err = new TypeError('crc32 chỉ nhận Buffer, Uint8Array hoặc string.');
    err.code = 'INVALID_BUFFER';
    throw err;
  }
  let c = 0xffffffff;
  for (let i = 0; i < view.length; i += 1) c = CRC_TABLE[(c ^ view[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * CRC32 tính KIỂU KHÁC (từng bit, không bảng) — dùng riêng cho `inspectZip`.
 *
 * Vì sao cần bản thứ hai: `inspectZip` là BỘ ĐỌC ĐỘC LẬP. Nếu nó dùng chung bảng tra với
 * bộ ghi thì một lỗi trong bảng (hoặc trong cách nạp bảng) sẽ khiến hai bên "khớp" với nhau
 * và lời chứng minh trở thành vô nghĩa. Bản này đi đường thuật toán khác (không bảng) nên
 * sai sót ở bảng của bộ ghi sẽ LỘ RA thành CRC mismatch.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {number}
 */
export function crc32Bitwise(buffer) {
  const view = asView(buffer);
  if (!view) throw new TypeError('crc32Bitwise chỉ nhận Buffer/Uint8Array.');
  let c = 0xffffffff;
  for (let i = 0; i < view.length; i += 1) {
    c ^= view[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

export default crc32;
