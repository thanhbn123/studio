/**
 * Lỗi của tầng MATTING (MVP-03, hợp đồng §3.1 — phần của agent E1).
 *
 * Luật của dự án: fail-closed, không fail-im lặng. Mọi lỗi đi ra khỏi
 * `src/imagestudio/matting/**` đều là `MattingError` có `code` máy đọc được,
 * để provider ánh xạ sang `status` + `error_code` của `MattingResult`
 * (KHÔNG ném ra ngoài `removeBackground()`).
 */

export class MattingError extends Error {
  /**
   * @param {string} code mã lỗi (xem MATTING_CODES)
   * @param {string} message thông báo tiếng Việt cho người đọc
   * @param {object} [details] dữ liệu phụ trợ (KHÔNG chứa secret)
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MattingError';
    this.code = code;
    this.details = details;
  }
}

/** Danh mục mã lỗi — đóng băng để agent khác (E3/E4/test) không đoán sai tên. */
export const MATTING_CODES = Object.freeze({
  // Đầu vào / cấu hình
  BAD_INPUT: 'BAD_INPUT',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNKNOWN_PROVIDER: 'UNKNOWN_PROVIDER',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  // Ảnh không xử lý được (⇒ status `UNSUPPORTED_IMAGE`)
  UNSUPPORTED_IMAGE: 'UNSUPPORTED_IMAGE',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  PNG_UNSUPPORTED: 'PNG_UNSUPPORTED',
  PNG_CORRUPT: 'PNG_CORRUPT',
  // Từ chối tách nền (fail-closed — KHÔNG cắt bừa)
  UNIFORM_BACKGROUND_NOT_FOUND: 'UNIFORM_BACKGROUND_NOT_FOUND',
  SUSPICIOUS_MASK: 'SUSPICIOUS_MASK',
  MASK_UNCHANGED: 'MASK_UNCHANGED',
  MASK_SIZE_MISMATCH: 'MASK_SIZE_MISMATCH',
  // Provider http
  MATTING_NETWORK: 'MATTING_NETWORK',
  MATTING_HTTP_STATUS: 'MATTING_HTTP_STATUS',
  MATTING_BAD_RESPONSE: 'MATTING_BAD_RESPONSE',
  MATTING_DOMAIN_NOT_ALLOWED: 'MATTING_DOMAIN_NOT_ALLOWED',
  MATTING_OUTPUT_TOO_LARGE: 'MATTING_OUTPUT_TOO_LARGE',
  // Khác
  MATTING_FAILED: 'MATTING_FAILED',
});

/**
 * Những mã lỗi mang nghĩa "ảnh này không xử lý được" (khác "hệ thống lỗi").
 * `MattingProvider` dùng bảng này để quyết định `status = 'UNSUPPORTED_IMAGE'`.
 */
export const MATTING_UNSUPPORTED_CODES = Object.freeze(
  new Set([
    MATTING_CODES.UNSUPPORTED_IMAGE,
    MATTING_CODES.IMAGE_TOO_LARGE,
    MATTING_CODES.PNG_UNSUPPORTED,
    MATTING_CODES.PNG_CORRUPT,
  ]),
);

export default MattingError;
