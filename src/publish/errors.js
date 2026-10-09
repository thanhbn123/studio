/**
 * Lỗi của khối ĐĂNG BÀI (P1 — `src/publish/**`), hợp đồng MVP-07 §2.6.
 *
 * Vì sao cần `code` + `details` chứ không chỉ `message`: tầng HTTP (P3) phải map lỗi sang mã
 * trạng thái MÀ KHÔNG ĐOÁN — `NOT_APPROVED` ⇒ 409, `ITEM_NOT_FOUND` ⇒ 404, `NOT_CONFIGURED` ⇒ 409.
 * Nếu chỉ có chuỗi tiếng Việt thì P3 buộc phải so khớp chuỗi, và kiểu phụ thuộc đó vỡ ngay lần
 * đầu ai đó sửa câu chữ.
 *
 * Quy ước giống `ExportError` (`src/exports/errors.js`) và `OcrError`:
 *   - `name = 'PublishError'`
 *   - `code` là CHUỖI HẰNG, không bao giờ rỗng
 *   - `details` chỉ gắn khi có (không gắn `undefined` để `JSON.stringify` sạch)
 *   - KHÔNG BAO GIỜ chứa access token hay đường dẫn đĩa
 */

/** Mã lỗi dùng chung của khối đăng bài (hợp đồng §2.6). Khai tập trung để không gõ sai chính tả. */
export const PUBLISH_CODES = Object.freeze({
  /** Thiếu/sai tham số đầu vào (không có job, text rỗng mà cũng không có media…) ⇒ 400. */
  BAD_INPUT: 'BAD_INPUT',
  /** Chuyển trạng thái không có trong bảng §2.2 ⇒ 409. */
  BAD_STATE: 'BAD_STATE',
  /** `scheduledAt` không phải ISO-8601 trong tương lai ⇒ 400. */
  BAD_SCHEDULE: 'BAD_SCHEDULE',
  /** Nội dung vượt `publish.maxTextLength` ⇒ 400. */
  TEXT_TOO_LONG: 'TEXT_TOO_LONG',
  /** Số media vượt `publish.maxMedia` ⇒ 400. */
  MEDIA_TOO_MANY: 'MEDIA_TOO_MANY',
  /** Ảnh chỉ có trên đĩa, chưa có URL công khai (§2.5 — multipart CHƯA làm) ⇒ 422. */
  MEDIA_NOT_PUBLIC: 'MEDIA_NOT_PUBLIC',
  /** Không có bài đó, hoặc bài không thuộc người gọi ⇒ 404 (không xác nhận sự tồn tại). */
  ITEM_NOT_FOUND: 'ITEM_NOT_FOUND',
  /** CHƯA DUYỆT ⇒ cấm đăng (luật §0.1) ⇒ 409. Đây là mã quan trọng nhất của sprint. */
  NOT_APPROVED: 'NOT_APPROVED',
  /** Bài đã bị từ chối ⇒ 409. */
  ITEM_REJECTED: 'ITEM_REJECTED',
  /** Lượt đăng khác đang giữ bài (`status = 'publishing'`) ⇒ 409. */
  PUBLISH_IN_PROGRESS: 'PUBLISH_IN_PROGRESS',
  /** Đã đăng rồi — KHÔNG phải lỗi: service trả kết quả cũ kèm `idempotent: true` ⇒ 200. */
  ALREADY_PUBLISHED: 'ALREADY_PUBLISHED',
  /** Provider thiếu Page ID / access token ⇒ chưa đăng được ⇒ 409. KHÔNG bịa thành công. */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  /** `provider = none` hoặc `PUBLISH_ENABLED=false` ⇒ 503. */
  PROVIDER_DISABLED: 'PROVIDER_DISABLED',
  /** Nền tảng trả lỗi / mạng lỗi — nguyên văn nằm trong `publish_logs.error_message` ⇒ 502. */
  PROVIDER_FAILED: 'PROVIDER_FAILED',
  /** Vượt `publish.maxAttempts` ⇒ 429. */
  ATTEMPTS_EXHAUSTED: 'ATTEMPTS_EXHAUSTED',
  /** Lỗi DB thật (khác hẳn "không tìm thấy") ⇒ 500. */
  STORE_WRITE_FAILED: 'STORE_WRITE_FAILED',
});

export class PublishError extends Error {
  /**
   * @param {string} code mã lỗi (dùng `PUBLISH_CODES`)
   * @param {string} message câu tiếng Việt nói rõ chuyện gì xảy ra (KHÔNG chứa token)
   * @param {*} [details] dữ liệu máy đọc được (itemId, status, limit…)
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'PublishError';
    this.code = String(code || 'PUBLISH_ERROR');
    if (details !== undefined) this.details = details;
  }
}

export default PublishError;
