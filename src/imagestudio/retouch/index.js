/**
 * E1 — RETOUCH (chỉnh ảnh trong ngưỡng). Cổng vào DUY NHẤT của module (hợp đồng MVP-03 §3.4).
 *
 * Hợp đồng đóng băng — export đúng những tên sau:
 *   RetouchProvider, createRetouchProvider, RETOUCH_LIMITS, RetouchResult
 *   (`RetouchResult` là HÌNH DẠNG dữ liệu: `createRetouchResult` dựng đủ field,
 *    `RETOUCH_RESULT_FIELDS` là bảng tên field để test/E3 đối chiếu)
 *
 * Export thêm (tiện cho test và cho E3/E4, không thay thế tên nào ở trên):
 *   RetouchError, RETOUCH_CODES, RETOUCH_STATUS, RETOUCH_PROVIDER_NAMES,
 *   RETOUCH_PARAM_NAMES, clampRetouchParams, resolveRetouchLimits, zeroRetouchParams,
 *   buildToneLut, applyRetouch, PureJsRetouchProvider, MockRetouchProvider, NoneRetouchProvider
 *
 * Thuần offline: KHÔNG có nhánh nào gọi mạng (không có provider http cho retouch).
 */

export { RetouchError, RETOUCH_CODES, RETOUCH_UNSUPPORTED_CODES } from './errors.js';
export { RetouchProvider, DEFAULT_RETOUCH_LIMITS, resolveRetouchLimits } from './provider.js';
export { createRetouchProvider, RETOUCH_PROVIDER_NAMES } from './factory.js';
export { RETOUCH_STATUS, RETOUCH_RESULT_FIELDS, RetouchResult, createRetouchResult } from './result.js';
export { RETOUCH_LIMITS, RETOUCH_PARAM_NAMES, clampRetouchParams, zeroRetouchParams } from './limits.js';
export { buildToneLut, applyToneLut, applySaturation, applySharpen, applyRetouch } from './pixels.js';
export { PureJsRetouchProvider } from './providers/purejs.js';
export { MockRetouchProvider } from './providers/mock.js';
export { NoneRetouchProvider } from './providers/none.js';
