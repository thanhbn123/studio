/**
 * C3 — Render & pixel (MVP-02). Cổng vào DUY NHẤT của tầng này.
 *
 * Hợp đồng 4.3 (đóng băng) — export đúng những tên sau:
 *   RenderError, RenderProvider, createRenderProvider, layoutText, loadFont, sha256
 *
 * Export thêm (tiện cho test và cho agent khác, không thay thế tên nào ở trên):
 *   decodePng, encodePng, readPngHeader, estimateBackground, eraseBox, probeImage, drawLayout,
 *   normalizeOps, RENDER_STATUS, RENDER_CODES
 *
 * Bất biến số 2 của dự án được giữ ở tầng này: `render()` luôn nhận BẢN SAO buffer đầu vào,
 * không bao giờ sửa tại chỗ, và luôn trả `original_sha256` để pipeline chứng minh ảnh gốc bất biến.
 */

export { RenderError, RENDER_CODES, UNSUPPORTED_IMAGE_CODES } from './errors.js';
export {
  RenderProvider,
  RENDER_STATUS,
  DEFAULT_LIMITS,
  normalizeImage,
} from './provider.js';
export { createRenderProvider, RENDER_PROVIDER_NAMES } from './factory.js';
export { layoutText } from './layout.js';
export { loadFont, BitmapFont } from './font/index.js';
export { sha256, decodePng, encodePng, readPngHeader, crc32 } from './png.js';
export { estimateBackground, eraseBox } from './inpaint.js';
export { probeImage, toRgba, clampBox, normalizeColor, getPixel, setPixel, blendPixel, fillRect } from './image.js';
export { drawLayout } from './draw.js';
export { normalizeOps, RENDER_ACTIONS } from './ops.js';
export { MockRenderProvider } from './providers/mock.js';
export { PureJsRenderProvider } from './providers/purejs.js';
export { HttpRenderProvider } from './providers/http.js';
export { NoneRenderProvider } from './providers/none.js';
