/**
 * Chuẩn hoá ĐẦU VÀO ẢNH/PIXEL cho tầng compose (E2) — dùng chung cho `compose.js` và `overlay.js`.
 *
 * Vì sao có file này: mask nền của E1 theo hợp đồng là PNG RGBA, nhưng khi chạy thật/test có thể
 * tới dưới dạng `{ data|pixels, width, height, channels }` đã giải mã sẵn. Một chỗ duy nhất lo
 * việc suy kênh màu + chuyển về RGBA (dùng lại `toRgba` của MVP-02) để hai tầng không lệch nhau.
 *
 * Hàm THUẦN: không I/O, không mạng, không đọc file; luôn trả buffer MỚI (không bao giờ sửa đầu vào).
 */

import { Buffer } from 'node:buffer';
import { toRgba } from '../../imagelab/render/index.js';
import { strictCoordinate } from '../../imagelab/geometry.js';

export const isBufferLike = (value) => Buffer.isBuffer(value) || value instanceof Uint8Array;

/** Ép Buffer/Uint8Array về Buffer nhìn thấy cùng vùng nhớ (không copy). */
export function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Lấy Buffer thô từ `{ buffer }`, Buffer, hoặc Uint8Array; null nếu không có. */
export function readInputBuffer(value) {
  if (isBufferLike(value)) return asBuffer(value);
  if (isBufferLike(value?.buffer)) return asBuffer(value.buffer);
  return null;
}

/** Suy số kênh từ độ dài dữ liệu (ưu tiên RGBA → RGB → gray+alpha → gray). */
function inferChannels(length, width, height) {
  for (const channels of [4, 3, 2, 1]) {
    if (length === width * height * channels) return channels;
  }
  return 0;
}

/**
 * Đọc pixel ĐÃ GIẢI MÃ: `{ data|pixels, width, height, channels? }` → RGBA (bản sao).
 * @returns {{pixels:Buffer,width:number,height:number}|null} null nếu thiếu/không khớp kích thước
 */
export function readRawRgba(value) {
  const data = isBufferLike(value?.pixels) ? value.pixels : isBufferLike(value?.data) ? value.data : null;
  if (!data) return null;
  const rawWidth = strictCoordinate(value?.width);
  const rawHeight = strictCoordinate(value?.height);
  if (rawWidth === null || rawHeight === null || rawWidth <= 0 || rawHeight <= 0) return null;
  const width = Math.floor(rawWidth);
  const height = Math.floor(rawHeight);
  const view = asBuffer(data);
  const declared = strictCoordinate(value?.channels);
  const channels = declared ?? inferChannels(view.length, width, height);
  if (![1, 2, 3, 4].includes(channels)) return null;
  if (view.length < width * height * channels) return null;
  return { pixels: toRgba({ width, height, channels, data: view }), width, height };
}
