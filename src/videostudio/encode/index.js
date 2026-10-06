/**
 * V2 — MÃ HOÁ VIDEO (hợp đồng MVP-04 §2.2). Cổng vào DUY NHẤT của module.
 *
 * Hợp đồng đóng băng — export đúng những tên sau:
 *   `encodeGif`, `inspectGif`, `writeFrameSequence`, `VideoEncoder`, `createVideoEncoder`,
 *   `renderFrames`
 *
 * Export thêm (tiện cho V3/V4/test, KHÔNG thay thế tên nào ở trên):
 *   `VideoEncodeError`, `ENCODE_CODES`, `ENCODE_STATUS`, `ENCODE_RESULT_FIELDS`,
 *   `ENCODE_OUTPUT_FIELDS`, `createEncodeResult`, `createEncodeOutput`, `AUDIO_WARNING`,
 *   `VIDEO_ENCODER_NAMES`, `PureJsVideoEncoder`, `MockVideoEncoder`, `FFmpegVideoEncoder`,
 *   `NoneVideoEncoder`, `COLOR_ERROR_THRESHOLD`, `decodeLzwCount`, `defaultDrawText`,
 *   `MAX_RENDER_FRAMES`, `resolveEncoderName`
 *
 * Toàn bộ module chạy OFFLINE: không mạng, không dependency ngoài `node:*`. GIF do
 * `encodeGif` ghi ra là GIF89a thật (LZW tự viết); `inspectGif` là bộ đọc ĐỘC LẬP để chứng minh.
 */

// ── Hợp đồng §2.2 ──
export { encodeGif, COLOR_ERROR_THRESHOLD, MAX_GIF_FRAMES, MAX_GIF_PIXELS, normalizeGifFrames } from './gif.js';
export { inspectGif, decodeLzwCount, INSPECT_MAX_FRAMES, INSPECT_MAX_PIXELS } from './inspect.js';
export { writeFrameSequence, resolveSequenceRoot, MAX_SEQUENCE_FRAMES } from './sequence.js';
export {
  VideoEncoder,
  createEncodeResult,
  createEncodeOutput,
  normalizeFrames,
  normalizeFrame,
  collectFrameWarnings,
  resolvePlanGeometry,
  ENCODE_RESULT_FIELDS,
  ENCODE_OUTPUT_FIELDS,
  DEFAULT_ENCODE_LIMITS,
  AUDIO_WARNING,
} from './encoder.js';
export { createVideoEncoder, resolveEncoderName, VIDEO_ENCODER_NAMES } from './factory.js';
export {
  renderFrames,
  defaultDrawText,
  sceneAtTime,
  textBoxFor,
  MAX_RENDER_FRAMES,
  DEFAULT_ZOOM,
  DEFAULT_PAN,
  DEFAULT_PAN_ZOOM,
  DEFAULT_TEXT_FADE_MS,
  DEFAULT_TRANSITION_MS,
} from './frames.js';

// ── Lỗi & trạng thái ──
export { VideoEncodeError, ENCODE_CODES, ENCODE_STATUS, ENCODE_UNSUPPORTED_CODES } from './errors.js';

// ── Provider cụ thể (V4 có thể cần `probe()` của ffmpeg) ──
export { PureJsVideoEncoder } from './providers/purejs.js';
export { MockVideoEncoder } from './providers/mock.js';
export { FFmpegVideoEncoder, runProcess } from './providers/ffmpeg.js';
export { NoneVideoEncoder } from './providers/none.js';

// ── Lượng tử hoá & LZW (test/đo chất lượng) ──
export {
  GIF_MAX_COLORS,
  HIST_SIZE,
  averageColorError,
  buildHistogram,
  buildIndexLut,
  colorTableSize,
  mapFrames,
  medianCutPalette,
  minCodeSizeFor,
  nearestIndex,
} from './quantize.js';
export { encodeLzw, encodeLzwBlocks, toSubBlocks, LZW_MAX_CODE, GIF_SUB_BLOCK } from './lzw.js';
