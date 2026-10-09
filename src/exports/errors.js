/**
 * Lỗi của GÓI XUẤT BẢN (X1 — `src/exports/**`).
 *
 * Vì sao cần `code` + `details` chứ không chỉ `message`: tầng HTTP (X2) phải map lỗi
 * sang mã trạng thái MÀ KHÔNG ĐOÁN. `JOB_NOT_FOUND` ⇒ 404, `BAD_INPUT` ⇒ 400, còn lại
 * ⇒ 500. Nếu chỉ có chuỗi tiếng Việt thì X2 buộc phải so khớp chuỗi — kiểu phụ thuộc
 * sẽ vỡ ngay lần đầu ai đó sửa câu chữ.
 *
 * Quy ước giống `StorageError` (`src/imagelab/storage.js`) và `VideoStudioError`:
 *   - `name = 'ExportError'`
 *   - `code` là CHUỖI HẰNG, không bao giờ rỗng
 *   - `details` chỉ gắn khi có (không gắn `undefined` để `JSON.stringify` sạch)
 */

/** Mã lỗi dùng chung của gói xuất bản. Khai báo tập trung để không gõ sai chính tả. */
export const EXPORT_CODES = Object.freeze({
  /** Tham số đầu vào sai (thiếu store/storage/jobId, entries không phải mảng…). */
  BAD_INPUT: 'BAD_INPUT',
  /** Job không tồn tại trong store ⇒ X2 map 404. */
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  /** Không đọc được dữ liệu job từ store (lỗi DB thật) — khác hẳn "job rỗng". */
  STORE_READ_FAILED: 'STORE_READ_FAILED',
  /** Tên entry không hợp lệ (rỗng, tuyệt đối, có `..`, có NUL, kết thúc bằng `/`). */
  ZIP_NAME_INVALID: 'ZIP_NAME_INVALID',
  /** Tên entry chứa CR/LF (D6) — chèn được dòng giả vào mọi danh sách in ra văn bản. */
  BAD_ENTRY_NAME: 'BAD_ENTRY_NAME',
  /** Tên entry dài quá 65535 byte UTF-8 — định dạng ZIP cổ điển không biểu diễn được. */
  ZIP_NAME_TOO_LONG: 'ZIP_NAME_TOO_LONG',
  /** Hai entry trùng tên — gói sẽ mơ hồ khi giải nén, phải chặn từ lúc ghi. */
  ZIP_DUPLICATE_NAME: 'ZIP_DUPLICATE_NAME',
  /** Vượt giới hạn của ZIP không có ZIP64 (quá 65535 entry / quá 4 GiB). */
  ZIP_TOO_LARGE: 'ZIP_TOO_LARGE',
  /** `method` không thuộc {store, deflate, auto}. */
  ZIP_METHOD_INVALID: 'ZIP_METHOD_INVALID',
  /** Tự kiểm sau khi ghi: `inspectZip` đọc lại buffer mà không khớp ⇒ KHÔNG trả gói hỏng. */
  ZIP_SELF_CHECK_FAILED: 'ZIP_SELF_CHECK_FAILED',
  /** Tổng dữ liệu đóng gói vượt trần an toàn của tiến trình. */
  BUNDLE_TOO_LARGE: 'BUNDLE_TOO_LARGE',
  /** Dữ liệu entry không phải Buffer/Uint8Array/string. */
  INVALID_BUFFER: 'INVALID_BUFFER',
});

export class ExportError extends Error {
  /**
   * @param {string} code mã lỗi (dùng `EXPORT_CODES`)
   * @param {string} message câu tiếng Việt nói rõ chuyện gì xảy ra
   * @param {*} [details] dữ liệu máy đọc được (jobId, entry, limit…) — KHÔNG chứa đường dẫn đĩa
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ExportError';
    this.code = String(code || 'EXPORT_ERROR');
    if (details !== undefined) this.details = details;
  }
}

export default ExportError;
