/**
 * E1 — MATTING (tách nền). Cổng vào DUY NHẤT của module (hợp đồng MVP-03 §3.1).
 *
 * Hợp đồng đóng băng — export đúng những tên sau:
 *   MattingError, MattingProvider, createMattingProvider
 *   (MattingResult là HÌNH DẠNG dữ liệu: `createMattingResult` dựng đủ field,
 *    `MATTING_RESULT_FIELDS` là bảng tên field để test/E3 đối chiếu)
 *
 * Export thêm (tiện cho test và cho E2/E3/E4, không thay thế tên nào ở trên):
 *   MATTING_STATUS, MATTING_CODES, MATTING_PROVIDER_NAMES, BACKGROUND_RATIO_BOUNDS,
 *   DEFAULT_TOLERANCE, DEFAULT_MIN_UNIFORMITY, colorDistance, measureBorderUniformity,
 *   createMattingResult, emptyMask, PureJsMattingProvider, MockMattingProvider,
 *   HttpMattingProvider, NoneMattingProvider
 *
 * Thuần offline: chỉ provider `http` (khi được cấu hình) mới gọi mạng, và chỉ qua
 * `safeFetch` có allowlist (src/security/fetcher.js).
 */

export { MattingError, MATTING_CODES, MATTING_UNSUPPORTED_CODES } from './errors.js';
export { MattingProvider, DEFAULT_MATTING_LIMITS } from './provider.js';
export { createMattingProvider, MATTING_PROVIDER_NAMES } from './factory.js';
export {
  MATTING_STATUS,
  BACKGROUND_RATIO_BOUNDS,
  MATTING_RESULT_FIELDS,
  MATTING_MASK_FIELDS,
  MattingResult,
  createMattingResult,
  emptyMask,
} from './result.js';
export {
  DEFAULT_TOLERANCE,
  DEFAULT_MIN_UNIFORMITY,
  colorDistance,
  normalizeTolerance,
  normalizeMinUniformity,
  measureBorderUniformity,
  buildSimilarityMap,
  floodFillFromBorder,
  applyAlphaMask,
  keptBoundingBox,
} from './background.js';
export { PureJsMattingProvider } from './providers/purejs.js';
export { MockMattingProvider, MOCK_MASK } from './providers/mock.js';
export { HttpMattingProvider } from './providers/http.js';
export { NoneMattingProvider } from './providers/none.js';
