/**
 * `RetouchResult` — hình dạng ĐÓNG BĂNG theo hợp đồng §3.4 (MVP-03, E1).
 *
 * Lưu ý: hợp đồng KHÔNG có field `error_message` cho retouch ⇒ mọi lời giải thích
 * tiếng Việt nằm trong `warnings[]` (không được nuốt lỗi).
 */

/** Trạng thái hợp lệ của RetouchResult (đóng băng). */
export const RETOUCH_STATUS = Object.freeze({
  OK: 'OK',
  NO_CHANGES: 'NO_CHANGES',
  UNSUPPORTED_IMAGE: 'UNSUPPORTED_IMAGE',
  FAILED: 'FAILED',
});

/** Tên field ĐÓNG BĂNG của `RetouchResult` — test/E3 đối chiếu bằng bảng này. */
export const RETOUCH_RESULT_FIELDS = Object.freeze([
  'status',
  'output',
  'params_effective',
  'clamped',
  'rejected',
  'warnings',
  'elapsed_ms',
  'error_code',
]);

/**
 * `RetouchResult` — KHUÔN ĐÓNG BĂNG của kết quả (hợp đồng §3.4, giá trị trung tính).
 *
 * Đây là hình dạng dữ liệu, KHÔNG phải lớp: mọi kết quả thật do `createRetouchResult()`
 * dựng ra đều có ĐÚNG bộ field này, cùng thứ tự.
 */
export const RetouchResult = Object.freeze({
  status: null,
  output: null,
  params_effective: Object.freeze({ brightness: 0, contrast: 0, saturation: 0, sharpen: 0 }),
  clamped: Object.freeze([]),
  rejected: Object.freeze([]),
  warnings: Object.freeze([]),
  elapsed_ms: 0,
  error_code: null,
});

/**
 * Dựng `RetouchResult` đủ field, đúng thứ tự hợp đồng.
 *
 * @param {object} partial
 * @returns {{status:string, output:object|null, params_effective:object, clamped:string[],
 *            rejected:string[], warnings:string[], elapsed_ms:number, error_code:string|null}}
 */
export function createRetouchResult(partial = {}) {
  return {
    status: partial.status ?? RETOUCH_STATUS.FAILED,
    output: partial.output ?? null,
    params_effective:
      partial.params_effective && typeof partial.params_effective === 'object'
        ? partial.params_effective
        : { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 },
    clamped: Array.isArray(partial.clamped) ? partial.clamped.filter((c) => typeof c === 'string') : [],
    rejected: Array.isArray(partial.rejected) ? partial.rejected.filter((r) => typeof r === 'string') : [],
    warnings: Array.isArray(partial.warnings) ? partial.warnings.filter((w) => typeof w === 'string') : [],
    elapsed_ms: Number.isFinite(Number(partial.elapsed_ms)) ? Number(partial.elapsed_ms) : 0,
    error_code: partial.error_code ?? null,
  };
}

export default createRetouchResult;
