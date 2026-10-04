/**
 * Lỗi của tầng RETOUCH (MVP-03, hợp đồng §3.4 — phần của agent E1).
 *
 * Luật: mọi lỗi có `code` máy đọc được, và `RetouchProvider.apply()` **KHÔNG BAO GIỜ**
 * ném lỗi ra ngoài — nó trả `status: 'FAILED'` + `error_code` (+ cảnh báo tiếng Việt,
 * vì `RetouchResult` không có field `error_message`).
 */

export class RetouchError extends Error {
  /**
   * @param {string} code mã lỗi (xem RETOUCH_CODES)
   * @param {string} message thông báo tiếng Việt cho người đọc
   * @param {object} [details] dữ liệu phụ trợ (KHÔNG chứa secret)
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RetouchError';
    this.code = code;
    this.details = details;
  }
}

/** Danh mục mã lỗi — đóng băng để agent khác (E3/E4/test) không đoán sai tên. */
export const RETOUCH_CODES = Object.freeze({
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
  // Trung thực: không có gì đổi thì KHÔNG được báo OK
  NO_CHANGES: 'NO_CHANGES',
  MOCK_NO_CHANGE: 'MOCK_NO_CHANGE',
  RETOUCH_BAD_RESPONSE: 'RETOUCH_BAD_RESPONSE',
  RETOUCH_OUTPUT_TOO_LARGE: 'RETOUCH_OUTPUT_TOO_LARGE',
  // Khác
  RETOUCH_FAILED: 'RETOUCH_FAILED',
});

/**
 * Những mã lỗi mang nghĩa "ảnh này không xử lý được" (khác "hệ thống lỗi").
 * `RetouchProvider` dùng bảng này để quyết định `status = 'UNSUPPORTED_IMAGE'`.
 */
export const RETOUCH_UNSUPPORTED_CODES = Object.freeze(
  new Set([
    RETOUCH_CODES.UNSUPPORTED_IMAGE,
    RETOUCH_CODES.IMAGE_TOO_LARGE,
    RETOUCH_CODES.PNG_UNSUPPORTED,
    RETOUCH_CODES.PNG_CORRUPT,
  ]),
);

export default RetouchError;
