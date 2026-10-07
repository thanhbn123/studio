/**
 * Provider `purejs` — GIF89a THẬT, chạy hoàn toàn offline (hợp đồng MVP-04 §2.2).
 *
 * Đây là provider mặc định: không cần `ffmpeg`, không cần mạng, không dịch vụ trả tiền.
 * Nó chỉ gọi `encodeGif` (LZW tự viết) và trả `EncodeResult` đúng hợp đồng.
 */

import { VideoEncodeError, ENCODE_CODES, ENCODE_STATUS } from '../errors.js';
import {
  AUDIO_WARNING,
  VideoEncoder,
  collectFrameWarnings,
  createEncodeOutput,
  normalizeFrames,
  resolvePlanGeometry,
} from '../encoder.js';
import { encodeGif } from '../gif.js';

export class PureJsVideoEncoder extends VideoEncoder {
  constructor({ model = 'purejs/gif89a-lzw+mediancut', limits, logger } = {}) {
    super({ name: 'purejs', model, mime: 'image/gif', isMock: false, configured: true, limits, logger });
  }

  async _encode({ plan, frames, options }) {
    const limits = this.limits;
    const list = normalizeFrames(frames, { limits });
    const { width, height, fps, loop } = resolvePlanGeometry(plan, list, options);
    if (width * height > limits.maxPixels) {
      throw new VideoEncodeError(
        ENCODE_CODES.IMAGE_TOO_LARGE,
        `Khung ${width}x${height} vượt trần ${limits.maxPixels} pixel của tầng mã hoá.`,
        { width, height, maxPixels: limits.maxPixels },
      );
    }
    const delayMs = Number.isFinite(Number(options.delayMs))
      ? Math.max(0, Number(options.delayMs))
      : Math.max(10, Math.round(1000 / fps));
    const paletteSize = Number.isFinite(Number(options.paletteSize))
      ? Number(options.paletteSize)
      : limits.maxColors;

    const gif = encodeGif({
      frames: list,
      width,
      height,
      delayMs,
      loop,
      paletteSize,
      dither: options.dither === true,
    });
    if (gif.bytes > limits.maxBytes) {
      throw new VideoEncodeError(
        ENCODE_CODES.GIF_TOO_LARGE,
        `GIF ra ${gif.bytes} byte, vượt trần ${limits.maxBytes} byte.`,
        { bytes: gif.bytes, maxBytes: limits.maxBytes },
      );
    }
    return {
      status: ENCODE_STATUS.OK,
      output: createEncodeOutput({ buffer: gif.buffer, mime: gif.mime, ext: 'gif' }),
      width: gif.width,
      height: gif.height,
      frames: gif.frames,
      palette_size: gif.palette_size,
      // N2: nhịp phát thật (tổng delay GIF) vs yêu cầu — để tầng trên ghi vào encode_summary.
      playback_ms: gif.playback_ms ?? null,
      requested_ms: gif.requested_ms ?? null,
      delay_drift_ms: gif.delay_drift_ms ?? null,
      warnings: [AUDIO_WARNING, ...collectFrameWarnings(frames), ...gif.warnings],
      error_code: null,
    };
  }
}

export default PureJsVideoEncoder;
