/**
 * Lỗi của tầng GHÉP NỀN (E2 — Compose, MVP-03).
 *
 * Luật của dự án: "fail-closed, không fail-im lặng". Mọi lỗi lập trình (thiếu dữ liệu,
 * id mẫu nền sai) đều ném `ComposeError` có `code` máy đọc được. Còn các tình huống
 * KHÔNG ĐỦ TỰ TIN để ghép (mask thiếu/không giải mã được/kích thước lệch) thì KHÔNG ném —
 * hàm trả về ảnh gốc kèm `warnings` tiếng Việt, đúng tinh thần "thà không ghép còn hơn ghép bừa".
 *
 * File thuần: không I/O, không mạng, không đọc file.
 */

export class ComposeError extends Error {
  /**
   * @param {string} code mã lỗi (xem COMPOSE_CODES)
   * @param {string} message thông báo tiếng Việt cho người đọc
   * @param {object} [details] dữ liệu phụ trợ (KHÔNG chứa secret)
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ComposeError';
    this.code = code;
    this.details = details;
  }
}

/** Danh mục mã lỗi — đóng băng để E3/E4/test không đoán sai tên. */
export const COMPOSE_CODES = Object.freeze({
  /** Đầu vào sai kiểu (thiếu buffer ảnh, width/height không hợp lệ…). */
  BAD_INPUT: 'BAD_INPUT',
  /** Không tìm thấy mẫu nền theo `id` (kèm danh sách id hợp lệ trong `details.available`). */
  TEMPLATE_NOT_FOUND: 'TEMPLATE_NOT_FOUND',
  /** Ảnh cần vẽ overlay không đọc được (không phải PNG / PNG hỏng). */
  IMAGE_UNREADABLE: 'IMAGE_UNREADABLE',
  /** Mask nền (matting output) không giải mã được — chỉ hỗ trợ PNG RGBA. */
  MASK_UNREADABLE: 'MASK_UNREADABLE',
  /** Mask nền khác kích thước ảnh gốc — không được resize/crop (luật 1), nên từ chối ghép. */
  MASK_SIZE_MISMATCH: 'MASK_SIZE_MISMATCH',
});

export default ComposeError;
