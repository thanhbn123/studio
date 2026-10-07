/**
 * `createVideoEncoder(config, { logger })` — chọn provider mã hoá (hợp đồng MVP-04 §2.2).
 *
 * Nhận CẢ HAI kiểu tham số để V3/V4 gọi kiểu nào cũng đúng:
 *   - toàn bộ config (`config.videostudio`, `config.imagelab`);
 *   - hoặc thẳng khối `config.videostudio` / `config.encode`.
 *
 * Tên provider đọc theo thứ tự: `videostudio.encoder` → `videostudio.encode.provider` →
 * `videostudio.provider` → `config.encoder` → `config.encode.provider` → biến môi trường
 * (`VIDEOSTUDIO_ENCODER` / `VIDEO_ENCODER_PROVIDER`) → mặc định **`purejs`** (GIF thật, offline).
 *
 * `videostudio.enabled === false` ⇒ provider `none` (`configured = false`, `NOT_CONFIGURED`).
 * Tên lạ ⇒ ném `VideoEncodeError('UNKNOWN_PROVIDER')` — fail-closed, không âm thầm đổi provider.
 */

import { VideoEncodeError, ENCODE_CODES } from './errors.js';
import { DEFAULT_ENCODE_LIMITS } from './encoder.js';
import { PureJsVideoEncoder } from './providers/purejs.js';
import { MockVideoEncoder } from './providers/mock.js';
import { FFmpegVideoEncoder } from './providers/ffmpeg.js';
import { NoneVideoEncoder } from './providers/none.js';

/** Tên provider hợp lệ (đóng băng). */
export const VIDEO_ENCODER_NAMES = Object.freeze(['purejs', 'mock', 'ffmpeg', 'none']);

const toInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const asObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);

/** Đọc tên provider từ nhiều hình dạng config khác nhau. */
export function resolveEncoderName(config = {}) {
  const root = asObject(config) ?? {};
  const studio = asObject(root.videostudio) ?? asObject(root.video) ?? {};
  const encoderBlock = studio.encoder ?? studio.encode ?? root.encoder ?? root.encode;
  const nested = asObject(encoderBlock) ?? {};
  const candidates = [
    typeof encoderBlock === 'string' ? encoderBlock : null,
    nested.provider,
    nested.name,
    studio.provider,
    studio.encoder_provider,
    root.video_provider,
    process.env.VIDEOSTUDIO_ENCODER,
    process.env.VIDEO_ENCODER_PROVIDER,
    process.env.VIDEOSTUDIO_PROVIDER,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim().toLowerCase();
  }
  return 'purejs';
}

/**
 * @param {object} config config đầy đủ hoặc khối `videostudio`
 * @param {{logger?:object}} [deps]
 * @returns {import('./encoder.js').VideoEncoder}
 */
export function createVideoEncoder(config = {}, { logger } = {}) {
  const root = asObject(config) ?? {};
  const studio = asObject(root.videostudio) ?? asObject(root.video) ?? {};
  const imagelabCfg = asObject(root.imagelab) ?? {};
  const encoderBlock = asObject(studio.encoder ?? studio.encode ?? root.encoder ?? root.encode) ?? {};

  const limits = {
    maxPixels: toInt(
      encoderBlock.maxPixels ?? studio.maxPixels ?? imagelabCfg.maxPixels,
      DEFAULT_ENCODE_LIMITS.maxPixels,
    ),
    maxFrames: toInt(encoderBlock.maxFrames ?? studio.maxFrames, DEFAULT_ENCODE_LIMITS.maxFrames),
    maxColors: Math.min(256, toInt(encoderBlock.paletteSize ?? studio.paletteSize, DEFAULT_ENCODE_LIMITS.maxColors)),
    maxBytes: toInt(encoderBlock.maxBytes ?? studio.maxOutputBytes, DEFAULT_ENCODE_LIMITS.maxBytes),
  };
  const common = { limits, logger };

  const name = studio.enabled === false ? 'none' : resolveEncoderName(root);
  switch (name) {
    case 'purejs':
    case 'local':
    case 'builtin':
    case 'gif':
      return new PureJsVideoEncoder({ ...common, model: encoderBlock.model || 'purejs/gif89a-lzw+mediancut' });
    case 'mock':
      return new MockVideoEncoder({ ...common, model: encoderBlock.model || 'mock/gif2frames' });
    case 'ffmpeg':
    case 'mp4':
      return new FFmpegVideoEncoder({
        ...common,
        binaryPath: encoderBlock.binaryPath ?? encoderBlock.binary ?? studio.ffmpegPath ?? process.env.FFMPEG_PATH ?? 'ffmpeg',
        fps: encoderBlock.fps ?? studio.fps,
        model: encoderBlock.model || 'ffmpeg/libx264',
      });
    case 'none':
    case 'off':
    case 'disabled':
      return new NoneVideoEncoder({ ...common, model: '' });
    default:
      throw new VideoEncodeError(
        ENCODE_CODES.UNKNOWN_PROVIDER,
        `Provider mã hoá video không được hỗ trợ: "${name}".`,
        { supported: VIDEO_ENCODER_NAMES },
      );
  }
}

export default createVideoEncoder;
