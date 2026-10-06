/**
 * Lỗi của tầng KỊCH BẢN (V1 — `src/videostudio/plan/**`, MVP-04).
 *
 * Luật của dự án: "fail-closed, không fail-im lặng". Mọi tình huống KHÔNG ĐỦ TỰ TIN để dựng
 * kịch bản (preset lạ, không có cảnh nào, ảnh nguồn thiếu kích thước, chế độ ghép ảnh lạ…)
 * đều ném `VideoError` có `code` máy đọc được — KHÔNG đoán bừa, KHÔNG kéo giãn ảnh cho xong.
 *
 * File thuần: không I/O, không mạng, không đọc file.
 */

export class VideoError extends Error {
  /**
   * @param {string} code mã lỗi (xem VIDEO_CODES)
   * @param {string} message thông báo tiếng Việt cho người đọc
   * @param {object} [details] dữ liệu phụ trợ (KHÔNG chứa secret)
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VideoError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Danh mục mã lỗi — đóng băng để V2/V3/V4/V5 và agent test không đoán sai chuỗi.
 * Ba mã đầu là hợp đồng 2.1; các mã sau là phần "chuẩn bị" của luật chống bịa (§0 luật 3).
 */
export const VIDEO_CODES = Object.freeze({
  /** `preset` không có trong `VIDEO_PRESETS` (kèm `details.available`). */
  UNKNOWN_PRESET: 'UNKNOWN_PRESET',
  /** `scenes` rỗng hoặc không phải mảng ⇒ không có gì để dựng. */
  NO_SCENES: 'NO_SCENES',
  /** Cảnh thiếu kích thước ảnh nguồn (`source.width/height`) ⇒ không tính được khung ghép. */
  BAD_SOURCE: 'BAD_SOURCE',
  /** `fit` lạ (không thuộc `FIT_MODES`) — từ chối thay vì đoán, vì đoán sai là bóp méo ảnh. */
  BAD_FIT: 'BAD_FIT',
  /** Đối tượng plan hỏng/không đọc được số khung (`planFrameCount`). */
  BAD_PLAN: 'BAD_PLAN',
  /** Chữ trên video có khẳng định/số liệu không có bằng chứng (luật 3) — V3/V4 trả 422. */
  VIDEO_TEXT_UNSUPPORTED_CLAIM: 'VIDEO_TEXT_UNSUPPORTED_CLAIM',
  /** Chữ trên video còn Hán/kana/Hangul CHƯA DỊCH — không bao giờ được vẽ. */
  NOT_TRANSLATED: 'NOT_TRANSLATED',
});

export default VideoError;
