/**
 * Lỗi của tầng MÃ HOÁ Video Studio (V2 — hợp đồng MVP-04 §2.2).
 *
 * Luật của dự án: fail-closed, KHÔNG fail-im lặng. Mọi lỗi đi ra khỏi
 * `src/videostudio/encode/**` đều mang `code` máy đọc được để V3/V4 ghi thẳng vào
 * `encode.error_code` / HTTP status mà không phải đoán theo chuỗi thông báo.
 *
 * Lưu ý: `VideoEncoder.encode()` **KHÔNG BAO GIỜ** ném lỗi ra ngoài — nó trả
 * `EncodeResult.status = 'FAILED'` + `error_code` (xem `encoder.js`), giống cách
 * `RetouchProvider` của MVP-03 làm. Lỗi ở đây dùng cho các hàm mã hoá/đọc/ghi
 * gọi trực tiếp (`encodeGif`, `writeFrameSequence`, `renderFrames`…).
 */

export class VideoEncodeError extends Error {
  /**
   * @param {string} code mã lỗi (xem ENCODE_CODES)
   * @param {string} message thông báo tiếng Việt cho người đọc
   * @param {object} [details] dữ liệu phụ trợ (KHÔNG chứa secret)
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VideoEncodeError';
    this.code = code;
    this.details = details;
  }
}

/** Danh mục mã lỗi — ĐÓNG BĂNG để V3/V4/test không đoán sai tên. */
export const ENCODE_CODES = Object.freeze({
  // Đầu vào / cấu hình
  BAD_INPUT: 'BAD_INPUT',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNKNOWN_PROVIDER: 'UNKNOWN_PROVIDER',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  // Ảnh / khung
  IMAGE_LOAD_FAILED: 'IMAGE_LOAD_FAILED',
  IMAGE_UNSUPPORTED: 'IMAGE_UNSUPPORTED',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  FRAME_SIZE_MISMATCH: 'FRAME_SIZE_MISMATCH',
  TOO_MANY_FRAMES: 'TOO_MANY_FRAMES',
  TEXT_DRAW_FAILED: 'TEXT_DRAW_FAILED',
  // GIF
  GIF_ENCODE_FAILED: 'GIF_ENCODE_FAILED',
  GIF_CORRUPT: 'GIF_CORRUPT',
  GIF_TOO_LARGE: 'GIF_TOO_LARGE',
  // mp4 / ffmpeg (phần CHƯA đo được ở máy này — hợp đồng §0)
  FFMPEG_NOT_AVAILABLE: 'FFMPEG_NOT_AVAILABLE',
  FFMPEG_FAILED: 'FFMPEG_FAILED',
  // Đường dẫn (không bao giờ ghi ra ngoài IMAGELAB_DIR)
  UNSAFE_PATH: 'UNSAFE_PATH',
  WRITE_FAILED: 'WRITE_FAILED',
  // Khác
  ENCODE_FAILED: 'ENCODE_FAILED',
});

/**
 * Trạng thái hợp lệ của `EncodeResult` (đóng băng).
 * KHÔNG có status `NOT_CONFIGURED`: trường hợp đó là `FAILED` + `error_code`
 * `NOT_CONFIGURED` (theo đúng tiền lệ `RetouchResult` của MVP-03).
 */
export const ENCODE_STATUS = Object.freeze({
  OK: 'OK',
  FAILED: 'FAILED',
});

/**
 * Những mã lỗi mang nghĩa "đầu vào không dùng được" (khác "hệ thống lỗi").
 * V3 dùng bảng này để quyết định `status = 'UNSUPPORTED_IMAGE'` nếu cần.
 */
export const ENCODE_UNSUPPORTED_CODES = Object.freeze(
  new Set([
    ENCODE_CODES.BAD_INPUT,
    ENCODE_CODES.IMAGE_UNSUPPORTED,
    ENCODE_CODES.IMAGE_TOO_LARGE,
    ENCODE_CODES.FRAME_SIZE_MISMATCH,
    ENCODE_CODES.TOO_MANY_FRAMES,
  ]),
);

export default VideoEncodeError;
