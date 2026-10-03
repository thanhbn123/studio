/**
 * Codec PNG tự viết — KHÔNG dùng thư viện ảnh nào (luật số 5 của hợp đồng MVP-02).
 *
 * Chỉ dùng: `node:zlib` (inflate/deflate), `node:crypto` (sha256), `node:buffer`.
 *
 * Phạm vi hỗ trợ (đúng hợp đồng 4.3):
 *  - 8-bit, color type 0 (grayscale), 2 (RGB), 4 (gray+alpha), 6 (RGBA).
 *  - non-interlaced, đủ 5 filter type: None/Sub/Up/Average/Paeth.
 *  - 16-bit, interlaced, palette (color type 3), bit depth khác 8 → `PNG_UNSUPPORTED`.
 *  - CRC sai / IDAT hỏng / buffer cắt ngắn → `PNG_CORRUPT` (không crash, không treo).
 *
 * Chống bom nén & ảnh khổng lồ:
 *  - `width * height > maxPixels` → `IMAGE_TOO_LARGE` NGAY khi đọc IHDR, TRƯỚC khi cấp phát mảng.
 *  - `inflateSync` được gọi với `maxOutputLength` = đúng số byte mong đợi → bom nén nổ ra lỗi
 *    `PNG_CORRUPT` thay vì ngốn RAM.
 */

import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { RenderError, RENDER_CODES } from './errors.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Giới hạn mặc định khi gọi codec trực tiếp (provider luôn truyền giới hạn thật từ config). */
export const DEFAULT_MAX_PIXELS = 25_000_000;
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** Số kênh màu theo color type (bit depth 8). */
const CHANNELS_BY_COLOR_TYPE = Object.freeze({ 0: 1, 2: 3, 4: 2, 6: 4 });
/** Color type ghi ra khi encode — chỉ hỗ trợ 4 loại đọc được. */
const COLOR_TYPE_BY_CHANNELS = Object.freeze({ 1: 0, 2: 4, 3: 2, 4: 6 });

/** Bảng CRC32 (IEEE 802.3) — PNG bắt buộc kiểm CRC từng chunk. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC32 của một buffer. */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Băm sha256 (hex) của buffer/string.
 * Hợp đồng 4.3 yêu cầu export `sha256` để pipeline chứng minh ảnh gốc không đổi.
 */
export function sha256(buffer) {
  const hash = createHash('sha256');
  if (typeof buffer === 'string') hash.update(buffer, 'utf8');
  else if (Buffer.isBuffer(buffer)) hash.update(buffer);
  else if (buffer instanceof Uint8Array) hash.update(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  else throw new RenderError(RENDER_CODES.BAD_INPUT, 'sha256 chỉ nhận Buffer, Uint8Array hoặc string.');
  return hash.digest('hex');
}

/** Ép về Buffer KHÔNG copy nếu đã là Buffer (chỉ dùng để ĐỌC). */
function asView(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

const toInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * Đọc thông tin header PNG (IHDR) mà KHÔNG giải nén, KHÔNG cấp phát mảng pixel.
 *
 * An toàn với buffer cắt ngắn: mọi truy cập đều qua kiểm tra biên.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {{width:number,height:number,bitDepth:number,colorType:number,interlace:number,channels:number}|null}
 *          `null` nếu không phải PNG hoặc không đọc được header (KHÔNG ném lỗi).
 */
export function readPngHeader(buffer) {
  try {
    const buf = asView(buffer);
    if (!buf || buf.length < 33) return null;
    if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    // Chunk đầu tiên bắt buộc là IHDR: length(4) + 'IHDR'(4) + data(13) + crc(4)
    if (buf.toString('latin1', 12, 16) !== 'IHDR') return null;
    if (buf.readUInt32BE(8) !== 13) return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    const bitDepth = buf[24];
    const colorType = buf[25];
    const interlace = buf[28];
    if (!width || !height) return null;
    return {
      width,
      height,
      bitDepth,
      colorType,
      interlace,
      channels: CHANNELS_BY_COLOR_TYPE[colorType] ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Giải mã PNG 8-bit non-interlaced, color type 0/2/4/6.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {{maxPixels?:number, maxBytes?:number, verifyCrc?:boolean}} [options]
 * @returns {{width:number,height:number,channels:number,colorType:number,bitDepth:8,data:Buffer,hasAlpha:boolean}}
 */
export function decodePng(buffer, options = {}) {
  const buf = asView(buffer);
  if (!buf) {
    throw new RenderError(RENDER_CODES.PNG_BAD_INPUT, 'decodePng cần một Buffer/Uint8Array.');
  }
  const maxPixels = toInt(options.maxPixels, DEFAULT_MAX_PIXELS);
  const maxBytes = toInt(options.maxBytes, DEFAULT_MAX_BYTES);
  const verifyCrc = options.verifyCrc !== false;

  if (buf.length > maxBytes) {
    throw new RenderError(
      RENDER_CODES.IMAGE_TOO_LARGE,
      `Ảnh vượt giới hạn ${maxBytes} byte (nhận ${buf.length} byte).`,
      { bytes: buf.length, maxBytes },
    );
  }
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new RenderError(RENDER_CODES.PNG_CORRUPT, 'Không phải file PNG (sai magic bytes).', {
      expected: 'PNG signature 89 50 4E 47 0D 0A 1A 0A',
    });
  }
  if (buf.length < 33) {
    throw new RenderError(RENDER_CODES.PNG_CORRUPT, 'File PNG bị cắt ngắn: không đủ header IHDR.', {
      bytes: buf.length,
    });
  }
  if (buf.toString('latin1', 12, 16) !== 'IHDR' || buf.readUInt32BE(8) !== 13) {
    throw new RenderError(RENDER_CODES.PNG_CORRUPT, 'Chunk đầu tiên không phải IHDR hợp lệ.');
  }

  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  const compression = buf[26];
  const filterMethod = buf[27];
  const interlace = buf[28];

  // (1) Kiểm khả năng hỗ trợ TRƯỚC — để báo đúng lý do thay vì "ảnh quá lớn".
  if (bitDepth !== 8) {
    throw new RenderError(RENDER_CODES.PNG_UNSUPPORTED, `Chỉ hỗ trợ PNG 8-bit (nhận ${bitDepth}-bit).`, {
      bitDepth,
    });
  }
  if (!(colorType in CHANNELS_BY_COLOR_TYPE)) {
    const label = colorType === 3 ? 'palette (color type 3)' : `color type ${colorType}`;
    throw new RenderError(RENDER_CODES.PNG_UNSUPPORTED, `Không hỗ trợ PNG ${label}.`, { colorType });
  }
  if (interlace !== 0) {
    throw new RenderError(RENDER_CODES.PNG_UNSUPPORTED, 'Không hỗ trợ PNG interlaced (Adam7).', {
      interlace,
    });
  }
  if (compression !== 0 || filterMethod !== 0) {
    throw new RenderError(RENDER_CODES.PNG_UNSUPPORTED, 'Phương thức nén/lọc của PNG không được hỗ trợ.', {
      compression,
      filterMethod,
    });
  }
  if (!width || !height) {
    throw new RenderError(RENDER_CODES.PNG_CORRUPT, 'PNG khai báo kích thước 0.', { width, height });
  }

  // (2) Kiểm giới hạn pixel TRƯỚC khi cấp phát bất kỳ mảng nào (chống ảnh khổng lồ).
  const pixels = width * height;
  if (pixels > maxPixels) {
    throw new RenderError(
      RENDER_CODES.IMAGE_TOO_LARGE,
      `Ảnh ${width}x${height} = ${pixels} pixel vượt giới hạn ${maxPixels} pixel.`,
      { width, height, pixels, maxPixels },
    );
  }

  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  const stride = width * channels;
  const expectedRaw = height * (stride + 1); // mỗi dòng có 1 byte filter type

  // (3) Gom IDAT + kiểm CRC (có kiểm tra biên từng chunk — không tin độ dài do file khai).
  const idat = [];
  let idatBytes = 0;
  let offset = 8;
  let sawIend = false;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (length > 0x7fffffff || crcEnd > buf.length) {
      throw new RenderError(RENDER_CODES.PNG_CORRUPT, `Chunk ${type} vượt biên file (file bị cắt?).`, {
        type,
        length,
        offset,
      });
    }
    if (verifyCrc) {
      const stored = buf.readUInt32BE(dataEnd);
      const actual = crc32(buf.subarray(offset + 4, dataEnd));
      if (stored !== actual) {
        throw new RenderError(RENDER_CODES.PNG_CORRUPT, `CRC sai ở chunk ${type}.`, {
          type,
          offset,
          stored,
          actual,
        });
      }
    }
    if (type === 'IDAT') {
      idat.push(buf.subarray(dataStart, dataEnd));
      idatBytes += length;
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    }
    offset = crcEnd;
  }
  if (!sawIend) {
    throw new RenderError(RENDER_CODES.PNG_CORRUPT, 'PNG thiếu chunk IEND (file bị cắt?).');
  }
  if (idatBytes === 0) {
    throw new RenderError(RENDER_CODES.PNG_CORRUPT, 'PNG không có dữ liệu IDAT.');
  }

  // (4) Giải nén với trần đầu ra = đúng số byte mong đợi (chặn bom nén).
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat, idatBytes), { maxOutputLength: expectedRaw });
  } catch (err) {
    throw new RenderError(RENDER_CODES.PNG_CORRUPT, `Dữ liệu IDAT hỏng hoặc phình quá giới hạn: ${err.message}`, {
      cause: err.code ?? null,
      expectedRaw,
    });
  }
  if (raw.length !== expectedRaw) {
    throw new RenderError(
      RENDER_CODES.PNG_CORRUPT,
      `Dữ liệu giải nén sai kích thước (mong đợi ${expectedRaw}, nhận ${raw.length}).`,
      { expectedRaw, actual: raw.length },
    );
  }

  // (5) Bỏ filter — cấp phát pixel SAU khi mọi kiểm tra đã qua.
  const out = Buffer.allocUnsafe(stride * height);
  unfilterInto(raw, out, { width, height, channels, stride });

  const result = {
    width,
    height,
    channels,
    colorType,
    bitDepth: 8,
    data: out,
    hasAlpha: colorType === 4 || colorType === 6,
  };
  // Alias không-enumerable `pixels` (cùng buffer) để agent khác gọi tên nào cũng đúng,
  // nhưng KHÔNG làm phình object khi so sánh/duyệt khoá.
  Object.defineProperty(result, 'pixels', { get: () => result.data, enumerable: false });
  return result;
}

/** Bỏ filter 5 loại (None/Sub/Up/Average/Paeth) tại chỗ trên `out`. */
export function unfilterInto(raw, out, { width, height, channels, stride }) {
  const bpp = channels; // bit depth 8 → 1 byte/kênh
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filterType = raw[rowStart];
    const src = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const dst = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    switch (filterType) {
      case 0: // None
        src.copy(dst);
        break;
      case 1: // Sub
        for (let i = 0; i < stride; i += 1) {
          const a = i >= bpp ? dst[i - bpp] : 0;
          dst[i] = (src[i] + a) & 0xff;
        }
        break;
      case 2: // Up
        for (let i = 0; i < stride; i += 1) {
          const b = prev ? prev[i] : 0;
          dst[i] = (src[i] + b) & 0xff;
        }
        break;
      case 3: // Average
        for (let i = 0; i < stride; i += 1) {
          const a = i >= bpp ? dst[i - bpp] : 0;
          const b = prev ? prev[i] : 0;
          dst[i] = (src[i] + ((a + b) >> 1)) & 0xff;
        }
        break;
      case 4: // Paeth
        for (let i = 0; i < stride; i += 1) {
          const a = i >= bpp ? dst[i - bpp] : 0;
          const b = prev ? prev[i] : 0;
          const c = prev && i >= bpp ? prev[i - bpp] : 0;
          dst[i] = (src[i] + paeth(a, b, c)) & 0xff;
        }
        break;
      default:
        throw new RenderError(RENDER_CODES.PNG_CORRUPT, `Filter type không hợp lệ: ${filterType} (dòng ${y}).`, {
          filterType,
          row: y,
        });
    }
  }
}

/** Bộ dự đoán Paeth của PNG. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Mã hoá PNG 8-bit non-interlaced (filter None cho mọi dòng).
 *
 * @param {{width:number,height:number,data:Buffer|Uint8Array,channels:number, level?:number}} params
 * @returns {Buffer}
 */
export function encodePng({ width, height, data, channels, level = 9 } = {}) {
  const w = toInt(width, 0);
  const h = toInt(height, 0);
  const ch = toInt(channels, 0);
  if (!w || !h) {
    throw new RenderError(RENDER_CODES.PNG_BAD_INPUT, 'encodePng cần width/height là số nguyên dương.', {
      width,
      height,
    });
  }
  if (!(ch in COLOR_TYPE_BY_CHANNELS)) {
    throw new RenderError(RENDER_CODES.PNG_BAD_INPUT, `encodePng chỉ nhận 1/2/3/4 kênh (nhận ${channels}).`, {
      channels,
    });
  }
  // Nhận Buffer/Uint8Array, và cả mảng số thuần cho tiện gọi từ test/pipeline.
  const view = asView(data) ?? (Array.isArray(data) ? Buffer.from(data) : null);
  if (!view) {
    throw new RenderError(RENDER_CODES.PNG_BAD_INPUT, 'encodePng cần data là Buffer/Uint8Array/Array.');
  }
  const need = w * h * ch;
  if (view.length < need) {
    throw new RenderError(
      RENDER_CODES.PNG_BAD_INPUT,
      `Dữ liệu pixel thiếu: cần ${need} byte cho ${w}x${h}x${ch} kênh, nhận ${view.length}.`,
      { need, actual: view.length },
    );
  }

  const stride = w * ch;
  const raw = Buffer.allocUnsafe(h * (stride + 1));
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0; // filter None
    view.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = COLOR_TYPE_BY_CHANNELS[ch];
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw, { level: Math.min(9, Math.max(0, Number(level) || 9)) });

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Đóng gói một chunk PNG kèm CRC. */
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])), 0);
  return Buffer.concat([head, data, crc]);
}
