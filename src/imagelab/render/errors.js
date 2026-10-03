/**
 * Lỗi của tầng render (C3 — Render & pixel).
 *
 * Luật của dự án: "fail-closed, không fail-im lặng". Vì vậy MỌI lỗi đi ra khỏi
 * `src/imagelab/render/**` đều phải là `RenderError` có `code` máy đọc được,
 * để pipeline ghi vào `RenderResult.error_code` thay vì nuốt lỗi.
 */

export class RenderError extends Error {
  /**
   * @param {string} code mã lỗi (xem RENDER_CODES)
   * @param {string} message thông báo tiếng Việt cho người đọc
   * @param {object} [details] dữ liệu phụ trợ (KHÔNG chứa secret)
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
    this.details = details;
  }
}

/** Danh mục mã lỗi — đóng băng để agent khác không đoán sai tên. */
export const RENDER_CODES = Object.freeze({
  // Lỗi đầu vào / cấu hình
  BAD_INPUT: 'BAD_INPUT',
  UNKNOWN_PROVIDER: 'UNKNOWN_PROVIDER',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  FONT_NOT_FOUND: 'FONT_NOT_FOUND',
  // Lỗi ảnh
  RENDER_JPEG_UNSUPPORTED: 'RENDER_JPEG_UNSUPPORTED',
  PNG_UNSUPPORTED: 'PNG_UNSUPPORTED',
  PNG_CORRUPT: 'PNG_CORRUPT',
  PNG_BAD_INPUT: 'PNG_BAD_INPUT',
  IMAGE_TOO_LARGE: 'IMAGE_TOO_LARGE',
  RENDER_OUTPUT_TOO_LARGE: 'RENDER_OUTPUT_TOO_LARGE',
  // Lỗi provider http
  RENDER_NETWORK: 'RENDER_NETWORK',
  RENDER_HTTP_STATUS: 'RENDER_HTTP_STATUS',
  RENDER_BAD_RESPONSE: 'RENDER_BAD_RESPONSE',
  RENDER_DOMAIN_NOT_ALLOWED: 'RENDER_DOMAIN_NOT_ALLOWED',
  // Lỗi khác
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  RENDER_FAILED: 'RENDER_FAILED',
  /**
   * Vòng 3 (H-2): render chạy xong nhưng KHÔNG vẽ được vùng nào (`applied` rỗng) —
   * kết quả KHÔNG phải "OK", ảnh trả về y hệt ảnh gốc và phải kèm cảnh báo tiếng Việt.
   */
  NO_OPS: 'NO_OPS',
});

/**
 * Những mã lỗi mang nghĩa "ảnh này không xử lý được" (khác với "hệ thống lỗi").
 * RenderProvider dùng bảng này để quyết định `status = 'UNSUPPORTED_IMAGE'`.
 */
export const UNSUPPORTED_IMAGE_CODES = Object.freeze(
  new Set([
    RENDER_CODES.RENDER_JPEG_UNSUPPORTED,
    RENDER_CODES.PNG_UNSUPPORTED,
    RENDER_CODES.PNG_CORRUPT,
    RENDER_CODES.IMAGE_TOO_LARGE,
    RENDER_CODES.RENDER_OUTPUT_TOO_LARGE,
  ]),
);

export default RenderError;
