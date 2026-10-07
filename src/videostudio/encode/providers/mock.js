/**
 * Provider `mock` — GIF 2 khung màu, `is_mock = true` (hợp đồng MVP-04 §2.2).
 *
 * Dùng khi cần chạy thử đường ống mà KHÔNG muốn mã hoá ảnh thật (test, demo, CI).
 * File ra vẫn là GIF89a HỢP LỆ (đi qua đúng `encodeGif`) nhưng nội dung là hai khung màu
 * phẳng — vì vậy kết quả mang `is_mock: true` + cảnh báo nói thẳng, không giả vờ là video thật.
 */

import { Buffer } from 'node:buffer';
import { ENCODE_STATUS } from '../errors.js';
import { AUDIO_WARNING, VideoEncoder, createEncodeOutput, normalizeFrames, resolvePlanGeometry } from '../encoder.js';
import { encodeGif } from '../gif.js';

/** Kích thước dự phòng khi không có plan/khung nào để suy kích thước. */
export const MOCK_DEFAULT_SIZE = Object.freeze({ width: 320, height: 240 });

/** Dựng một khung RGBA màu phẳng. */
function solidFrame(width, height, [r, g, b]) {
  const buf = Buffer.alloc(width * height * 4);
  const pattern = Buffer.from([r & 0xff, g & 0xff, b & 0xff, 0xff]);
  buf.fill(pattern);
  return buf;
}

export class MockVideoEncoder extends VideoEncoder {
  constructor({ model = 'mock/gif2frames', limits, logger } = {}) {
    super({ name: 'mock', model, mime: 'image/gif', isMock: true, configured: true, limits, logger });
  }

  async _encode({ plan, frames, options }) {
    const warnings = ['Đây là GIF GIẢ LẬP (mock): hai khung màu phẳng, KHÔNG dùng ảnh sản phẩm thật.'];
    let list = [];
    if (Array.isArray(frames) && frames.length > 0) {
      list = normalizeFrames(frames, { limits: this.limits });
    }
    let geo;
    try {
      geo = resolvePlanGeometry(plan, list, options);
    } catch {
      geo = { ...MOCK_DEFAULT_SIZE, fps: 12, loop: 0 };
      warnings.push(`Không có plan/khung để suy kích thước — mock dùng ${MOCK_DEFAULT_SIZE.width}x${MOCK_DEFAULT_SIZE.height}.`);
    }

    const mockFrames = [
      solidFrame(geo.width, geo.height, [26, 62, 122]),
      solidFrame(geo.width, geo.height, [242, 176, 32]),
    ];
    const gif = encodeGif({
      frames: mockFrames,
      width: geo.width,
      height: geo.height,
      delayMs: 500, // 2 khung × 0,5s
      loop: 0,
      paletteSize: 2,
    });

    return {
      status: ENCODE_STATUS.OK,
      output: createEncodeOutput({ buffer: gif.buffer, mime: gif.mime, ext: 'gif' }),
      width: gif.width,
      height: gif.height,
      frames: gif.frames,
      palette_size: gif.palette_size,
      warnings: [...warnings, AUDIO_WARNING, ...gif.warnings],
      error_code: null,
    };
  }
}

export default MockVideoEncoder;
