/**
 * Tiện ích pixel & dò kích thước ảnh — thuần Node, không thư viện ngoài.
 *
 * Hai nhóm việc:
 *  1. `probeImage(buffer)` — đọc header để lấy width/height của PNG/JPEG/GIF/WebP.
 *     Không giải mã pixel, không ném lỗi (trả `null` nếu không đọc được).
 *  2. Chuyển đổi hệ màu về RGBA để vẽ, cùng các hàm đọc/ghi pixel có kiểm tra biên.
 *
 * Lưu ý bất biến số 2 của dự án: mọi hàm ở đây CHỈ ghi vào buffer `pixels` do người gọi
 * đưa vào (buffer đã là bản sao), không bao giờ chạm vào buffer ảnh gốc của người dùng.
 */

import { Buffer } from 'node:buffer';
import { readPngHeader } from './png.js';

/** Magic bytes — khớp với `sniffImageMime` của src/security/sanitize.js (chỉ đọc, không sửa). */
function sniff(buffer) {
  if (!buffer || buffer.length < 12) return null;
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

/**
 * Nhận dạng MIME thật bằng magic bytes (KHÔNG tin `mime` do người gọi khai).
 * @param {Buffer|Uint8Array} buffer
 * @returns {'image/png'|'image/jpeg'|'image/gif'|'image/webp'|null}
 */
export function detectImageMime(buffer) {
  const view = Buffer.isBuffer(buffer)
    ? buffer
    : buffer instanceof Uint8Array
      ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : null;
  return view ? sniff(view) : null;
}

/**
 * Dò kích thước ảnh từ header.
 *
 * @param {Buffer|Uint8Array} input
 * @returns {{width:number,height:number,mime:string}|null} null nếu không nhận dạng/không đọc được
 */
export function probeImage(input) {
  try {
    const buf = Buffer.isBuffer(input)
      ? input
      : input instanceof Uint8Array
        ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
        : null;
    if (!buf) return null;
    const mime = sniff(buf);
    if (!mime) return null;
    let size = null;
    if (mime === 'image/png') size = probePng(buf);
    else if (mime === 'image/jpeg') size = probeJpeg(buf);
    else if (mime === 'image/gif') size = probeGif(buf);
    else if (mime === 'image/webp') size = probeWebp(buf);
    if (!size || !size.width || !size.height) return null;
    return { width: size.width, height: size.height, mime };
  } catch {
    return null;
  }
}

function probePng(buf) {
  const head = readPngHeader(buf);
  return head ? { width: head.width, height: head.height } : null;
}

/** Quét marker JPEG để tìm SOF (chứa kích thước). Có trần vòng lặp để không bị treo. */
function probeJpeg(buf) {
  let offset = 2; // bỏ SOI (FFD8)
  for (let guard = 0; guard < 10000; guard += 1) {
    if (offset + 4 > buf.length) return null;
    if (buf[offset] !== 0xff) return null;
    let marker = buf[offset + 1];
    // Marker độn FF FF ... FF <marker>
    while (marker === 0xff) {
      offset += 1;
      if (offset + 1 >= buf.length) return null;
      marker = buf[offset + 1];
    }
    offset += 2;
    // Các marker không có payload
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 2 > buf.length) return null;
    const length = buf.readUInt16BE(offset);
    if (length < 2) return null;
    const isSof =
      (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 7 > buf.length) return null;
      return { height: buf.readUInt16BE(offset + 3), width: buf.readUInt16BE(offset + 5) };
    }
    if (marker === 0xda) return null; // tới vùng nén mà chưa thấy SOF
    offset += length;
  }
  return null;
}

function probeGif(buf) {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** WebP: VP8X (canvas mở rộng), VP8L (lossless), VP8 (lossy). */
function probeWebp(buf) {
  let offset = 12;
  for (let guard = 0; guard < 64 && offset + 8 <= buf.length; guard += 1) {
    const fourcc = buf.toString('latin1', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (size < 0 || data + size > buf.length) return null;
    if (fourcc === 'VP8X') {
      if (size < 10) return null;
      const width = 1 + (buf[data + 4] | (buf[data + 5] << 8) | (buf[data + 6] << 16));
      const height = 1 + (buf[data + 7] | (buf[data + 8] << 8) | (buf[data + 9] << 16));
      return { width, height };
    }
    if (fourcc === 'VP8L') {
      if (size < 5 || buf[data] !== 0x2f) return null;
      const bits = buf.readUInt32LE(data + 1);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (fourcc === 'VP8 ') {
      if (size < 10) return null;
      if (!(buf[data + 3] === 0x9d && buf[data + 4] === 0x01 && buf[data + 5] === 0x2a)) return null;
      return {
        width: buf.readUInt16LE(data + 6) & 0x3fff,
        height: buf.readUInt16LE(data + 8) & 0x3fff,
      };
    }
    offset = data + size + (size % 2); // chunk WebP canh chẵn
  }
  return null;
}

/**
 * Chuẩn hoá ảnh đã giải mã về RGBA (4 kênh) — luôn là buffer MỚI.
 * Gray/RGB thiếu alpha → alpha = 255.
 */
export function toRgba(image) {
  const { width, height, channels, data } = image;
  const pixels = width * height;
  const out = Buffer.allocUnsafe(pixels * 4);
  switch (channels) {
    case 4:
      data.copy(out, 0, 0, pixels * 4);
      break;
    case 3:
      for (let i = 0, j = 0; i < pixels; i += 1, j += 3) {
        out[i * 4] = data[j];
        out[i * 4 + 1] = data[j + 1];
        out[i * 4 + 2] = data[j + 2];
        out[i * 4 + 3] = 255;
      }
      break;
    case 2:
      for (let i = 0; i < pixels; i += 1) {
        const g = data[i * 2];
        out[i * 4] = g;
        out[i * 4 + 1] = g;
        out[i * 4 + 2] = g;
        out[i * 4 + 3] = data[i * 2 + 1];
      }
      break;
    default: // 1 kênh: grayscale
      for (let i = 0; i < pixels; i += 1) {
        const g = data[i];
        out[i * 4] = g;
        out[i * 4 + 1] = g;
        out[i * 4 + 2] = g;
        out[i * 4 + 3] = 255;
      }
      break;
  }
  return out;
}

/**
 * Kẹp hộp vào biên ảnh và làm tròn về số nguyên.
 * @returns {{x:number,y:number,w:number,h:number}|null} null nếu hộp rỗng/không hợp lệ
 */
export function clampBox(box, { width, height } = {}) {
  if (!box || typeof box !== 'object') return null;
  const values = [box.x, box.y, box.w, box.h].map((v) => Number(v));
  if (values.some((v) => !Number.isFinite(v))) return null;
  let [x, y, w, h] = values;
  if (w <= 0 || h <= 0) return null;
  x = Math.round(x);
  y = Math.round(y);
  w = Math.round(w);
  h = Math.round(h);
  if (w <= 0 || h <= 0) return null;
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(width, x + w);
  const y1 = Math.min(height, y + h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Đọc pixel (RGBA) tại (x, y) — trả mảng 4 số, hoặc null nếu ngoài biên. */
export function getPixel(pixels, { width, height }, x, y) {
  if (x < 0 || y < 0 || x >= width || y >= height) return null;
  const i = (y * width + x) * 4;
  return [pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]];
}

/** Ghi đè pixel RGBA tại (x, y) — không trộn alpha. */
export function setPixel(pixels, { width, height }, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const i = (y * width + x) * 4;
  pixels[i] = color[0] & 0xff;
  pixels[i + 1] = color[1] & 0xff;
  pixels[i + 2] = color[2] & 0xff;
  pixels[i + 3] = (color[3] ?? 255) & 0xff;
}

/** Trộn pixel RGBA theo alpha nguồn (source-over, alpha 0..255). */
export function blendPixel(pixels, { width, height }, x, y, color) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const alpha = (color[3] ?? 255) / 255;
  if (alpha <= 0) return;
  const i = (y * width + x) * 4;
  if (alpha >= 1) {
    pixels[i] = color[0] & 0xff;
    pixels[i + 1] = color[1] & 0xff;
    pixels[i + 2] = color[2] & 0xff;
    pixels[i + 3] = 255;
    return;
  }
  pixels[i] = Math.round(pixels[i] * (1 - alpha) + color[0] * alpha);
  pixels[i + 1] = Math.round(pixels[i + 1] * (1 - alpha) + color[1] * alpha);
  pixels[i + 2] = Math.round(pixels[i + 2] * (1 - alpha) + color[2] * alpha);
  pixels[i + 3] = Math.max(pixels[i + 3], Math.round(255 * alpha));
}

/** Tô một hình chữ nhật RGBA (đã kẹp biên). */
export function fillRect(pixels, { width, height }, rect, color) {
  const box = clampBox(rect, { width, height });
  if (!box) return 0;
  let count = 0;
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      blendPixel(pixels, { width, height }, x, y, color);
      count += 1;
    }
  }
  return count;
}

/**
 * Chuẩn hoá màu từ style của RenderOp: [r,g,b] hoặc [r,g,b,a] hoặc '#rrggbb'.
 * Trả [r,g,b,a] đã kẹp 0..255; mặc định màu mực gần đen [20,20,20,255].
 */
export function normalizeColor(value, fallback = [20, 20, 20, 255]) {
  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
        255,
      ];
    }
    if (/^[0-9a-f]{3}$/i.test(hex)) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
        255,
      ];
    }
    return fallback;
  }
  if (Array.isArray(value) && value.length >= 3) {
    const nums = value.slice(0, 4).map((v) => Number(v));
    if (nums.some((v) => !Number.isFinite(v))) return fallback;
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
    return [clamp(nums[0]), clamp(nums[1]), clamp(nums[2]), nums.length > 3 ? clamp(nums[3]) : 255];
  }
  return fallback;
}
