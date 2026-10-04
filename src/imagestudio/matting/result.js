/**
 * `MattingResult` — hình dạng ĐÓNG BĂNG theo hợp đồng §3.1 (MVP-03).
 *
 * Mọi provider matting PHẢI trả về đúng bộ field này, không thêm không bớt, để
 * E3 (pipeline) và E4 (API) đọc được mà không phải đoán. Hàm dựng ở đây là chỗ
 * DUY NHẤT tạo object kết quả ⇒ không có provider nào "quên" field.
 *
 * Lưu ý trung thực: `mask` chỉ có 4 field đóng băng; khi provider không đo được
 * (ví dụ provider http không trả mask), giá trị là `null` — KHÔNG bịa số.
 */

/** Trạng thái hợp lệ của MattingResult (đóng băng). */
export const MATTING_STATUS = Object.freeze({
  OK: 'OK',
  UNIFORM_BACKGROUND_NOT_FOUND: 'UNIFORM_BACKGROUND_NOT_FOUND',
  UNSUPPORTED_IMAGE: 'UNSUPPORTED_IMAGE',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  FAILED: 'FAILED',
});

/**
 * Ngưỡng nghi ngờ mặt nạ (đóng băng theo hợp đồng §3.1).
 * `background_ratio` ra ngoài khoảng này ⇒ không tách được / ảnh toàn nền ⇒ fail-closed.
 */
export const BACKGROUND_RATIO_BOUNDS = Object.freeze({ min: 0.05, max: 0.98 });

/** `mask` rỗng (chưa đo được gì) — dùng khi từ chối hoặc provider không trả số đo. */
export function emptyMask() {
  return { coverage: null, background_ratio: null, uniformity: null, seed_colors: null };
}

/** Tên field ĐÓNG BĂNG của `MattingResult` (hợp đồng §3.1) — test/E3 đối chiếu bằng bảng này. */
export const MATTING_RESULT_FIELDS = Object.freeze([
  'status',
  'provider',
  'model',
  'is_mock',
  'output',
  'mask',
  'kept_bbox',
  'warnings',
  'elapsed_ms',
  'error_code',
  'error_message',
]);

/** Tên field ĐÓNG BĂNG của `mask` (hợp đồng §3.1). */
export const MATTING_MASK_FIELDS = Object.freeze(['coverage', 'background_ratio', 'uniformity', 'seed_colors']);

/**
 * Số đo MỞ RỘNG của `mask` (thêm ở vòng 8 — M03-01a). KHÔNG thay 4 field đóng băng ở trên;
 * đây là SỐ ĐO THẬT của vùng biên, chỉ provider nào đo được mới trả:
 *   - `kept_bbox_ratio`: diện tích hộp bao phần giữ lại / diện tích ảnh;
 *   - `boundary_delta` : `{max, p95, over_ratio, safe_delta, kept_count, kept_min, kept_p95,
 *     kept_under_ratio, decisive_delta, suspicious}` — căn cứ để TỪ CHỐI khi đường cắt
 *     không dứt khoát. Provider không đo ⇒ field VẮNG MẶT (không bịa số 0).
 */
export const MATTING_MASK_EXTRA_FIELDS = Object.freeze(['kept_bbox_ratio', 'boundary_delta']);

/**
 * `MattingResult` — KHUÔN ĐÓNG BĂNG của kết quả (hợp đồng §3.1, giá trị trung tính).
 *
 * Đây là hình dạng dữ liệu, KHÔNG phải lớp: mọi kết quả thật do `createMattingResult()`
 * dựng ra đều có ĐÚNG bộ field này, cùng thứ tự. Test/E3 so `Object.keys(MattingResult)`
 * với `Object.keys(result)` là khớp.
 */
export const MattingResult = Object.freeze({
  status: null,
  provider: '',
  model: '',
  is_mock: false,
  output: null,
  mask: Object.freeze(emptyMask()),
  kept_bbox: null,
  warnings: Object.freeze([]),
  elapsed_ms: 0,
  error_code: null,
  error_message: null,
});

/**
 * Dựng `MattingResult` đủ field, đúng thứ tự hợp đồng.
 *
 * @param {object} partial các field muốn ghi đè
 * @returns {{status:string, provider:string, model:string, is_mock:boolean, output:object|null,
 *            mask:object, kept_bbox:object|null, warnings:string[], elapsed_ms:number,
 *            error_code:string|null, error_message:string|null}}
 */
export function createMattingResult(partial = {}) {
  const mask = partial.mask && typeof partial.mask === 'object' ? partial.mask : emptyMask();
  return {
    status: partial.status ?? MATTING_STATUS.FAILED,
    provider: partial.provider ?? 'none',
    model: partial.model ?? '',
    is_mock: Boolean(partial.is_mock),
    output: partial.output ?? null,
    // 4 field đóng băng + số đo MỞ RỘNG (chỉ khi provider thật sự đo được); field lạ khác
    // vẫn bị bỏ để không ai nhét dữ liệu tuỳ ý vào hợp đồng.
    mask: {
      coverage: mask.coverage ?? null,
      background_ratio: mask.background_ratio ?? null,
      uniformity: mask.uniformity ?? null,
      seed_colors: mask.seed_colors ?? null,
      ...Object.fromEntries(
        MATTING_MASK_EXTRA_FIELDS.filter((key) => mask[key] !== undefined && mask[key] !== null).map((key) => [key, mask[key]]),
      ),
    },
    kept_bbox: partial.kept_bbox ?? null,
    warnings: Array.isArray(partial.warnings) ? partial.warnings.filter((w) => typeof w === 'string') : [],
    elapsed_ms: Number.isFinite(Number(partial.elapsed_ms)) ? Number(partial.elapsed_ms) : 0,
    error_code: partial.error_code ?? null,
    error_message: partial.error_message ?? null,
  };
}

export default createMattingResult;
