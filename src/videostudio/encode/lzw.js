/**
 * NÉN LZW của GIF — tự viết, không thư viện (hợp đồng MVP-04 §2.2).
 *
 * Định dạng dòng mã (đúng chuẩn GIF, LSB-first):
 *   - `minCodeSize` = số bit mã hoá 1 điểm ảnh = max(2, log2(số màu bảng màu)).
 *   - `clearCode = 1 << minCodeSize`, `endCode = clearCode + 1`, từ điển bắt đầu ở
 *     `endCode + 1`.
 *   - Độ dài mã (`codeSize`) tăng 1 khi từ điển sắp vượt `1 << codeSize`; khi từ điển
 *     ĐẦY (4096 mã) thì phát `clearCode` rồi RESET từ điển về `endCode + 1` và
 *     `codeSize = minCodeSize + 1` (không bao giờ vượt 12 bit).
 *   - Dòng bit được đóng thành các khối con ≤ 255 byte, kết thúc bằng khối 0x00.
 *
 * Quy tắc tăng độ dài mã ở đây lấy ĐÚNG thứ tự của bộ mã hoá tham chiếu (omggif/giflib):
 * phát mã CŨ trước, rồi mới nới `codeSize`, rồi mới gán mã mới. Bộ giải mã độc lập ở
 * `inspect.js` được viết theo luật đối xứng (`next === 1 << codeSize` ⇒ đọc rộng thêm 1 bit),
 * nên hai bên khớp nhau mà KHÔNG dùng chung mã nguồn.
 *
 * Không dùng `node:zlib` — LZW của GIF khác LZW của TIFF/`compress`.
 */

import { Buffer } from 'node:buffer';

/** Số mã tối đa của LZW GIF (12 bit). */
export const LZW_MAX_CODE = 4096;
/** Kích thước tối đa một khối con GIF. */
export const GIF_SUB_BLOCK = 255;

/**
 * Bộ gom byte có thể phình dần (tránh cấp phát 2 lần).
 * @private
 */
class ByteSink {
  constructor(initial = 1 << 16) {
    this.buf = new Uint8Array(Math.max(16, initial));
    this.length = 0;
  }

  push(byte) {
    if (this.length === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.length] = byte & 0xff;
    this.length += 1;
  }

  /** Ảnh (view) của phần đã ghi — KHÔNG copy. */
  view() {
    return this.buf.subarray(0, this.length);
  }
}

/**
 * Nén một mảng chỉ số màu (index palette) thành dòng LZW thô (chưa đóng khối con).
 *
 * @param {Uint8Array|Buffer|number[]} indices chỉ số palette của từng điểm ảnh (hàng-major)
 * @param {number} minCodeSize số bit tối thiểu (≥ 2)
 * @returns {Uint8Array} dòng byte LZW thô (đã flush bit cuối)
 */
export function encodeLzw(indices, minCodeSize) {
  const bits = Math.max(2, Math.floor(Number(minCodeSize) || 0));
  const clearCode = 1 << bits;
  const endCode = clearCode + 1;

  const sink = new ByteSink(Math.max(64, indices.length >> 1));
  let codeSize = bits + 1;
  let nextCode = endCode + 1;
  let cur = 0; // thanh ghi bit (LSB-first)
  let curBits = 0;

  /** Phát một mã với độ dài `codeSize` hiện tại. */
  const emit = (code) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      sink.push(cur & 0xff);
      cur >>= 8;
      curBits -= 8;
    }
  };

  // Từ điển: khoá = (mã tiền tố << 8) | chỉ số điểm ảnh kế tiếp.
  // `Map` số nguyên cho tốc độ ổn định; mỗi khung được reset (clear) nên tối đa 4096 mục.
  let table = new Map();

  emit(clearCode);
  const total = indices.length;
  if (total === 0) {
    emit(endCode);
  } else {
    let curCode = indices[0] & 0xff;
    for (let i = 1; i < total; i += 1) {
      const k = indices[i] & 0xff;
      const key = (curCode << 8) | k;
      const found = table.get(key);
      if (found !== undefined) {
        curCode = found;
        continue;
      }
      emit(curCode);
      if (nextCode === LZW_MAX_CODE) {
        // Từ điển ĐẦY ⇒ clear + reset (bộ giải mã cũng reset theo).
        emit(clearCode);
        table = new Map();
        nextCode = endCode + 1;
        codeSize = bits + 1;
      } else {
        // Nới độ dài mã TRƯỚC khi gán mã mới (xem đầu file).
        if (nextCode >= 1 << codeSize && codeSize < 12) codeSize += 1;
        table.set(key, nextCode);
        nextCode += 1;
      }
      curCode = k;
    }
    emit(curCode);
    emit(endCode);
  }

  // Flush số bit còn lại (đệm 0 — bộ giải mã bỏ qua bit đệm).
  if (curBits > 0) sink.push(cur & 0xff);
  return sink.view();
}

/**
 * Đóng dòng byte thành các khối con GIF (≤ 255 byte + khối kết thúc 0x00).
 *
 * @param {Uint8Array|Buffer} data
 * @returns {Buffer}
 */
export function toSubBlocks(data) {
  const parts = [];
  for (let offset = 0; offset < data.length; offset += GIF_SUB_BLOCK) {
    const size = Math.min(GIF_SUB_BLOCK, data.length - offset);
    parts.push(Buffer.from([size]), Buffer.from(data.subarray(offset, offset + size)));
  }
  parts.push(Buffer.from([0x00])); // block terminator
  return Buffer.concat(parts);
}

/**
 * Nén + đóng khối con trong một lần gọi (tiện cho `gif.js`).
 * @param {Uint8Array|Buffer|number[]} indices
 * @param {number} minCodeSize
 * @returns {Buffer} `minCodeSize` + các khối con + 0x00
 */
export function encodeLzwBlocks(indices, minCodeSize) {
  const bits = Math.max(2, Math.floor(Number(minCodeSize) || 0));
  const raw = encodeLzw(indices, bits);
  return Buffer.concat([Buffer.from([bits]), toSubBlocks(raw)]);
}

export default encodeLzw;
