/**
 * E2 — NỀN + GHÉP + OVERLAY (MVP-03, hợp đồng 3.2 + 3.5). Cổng vào DUY NHẤT của tầng này.
 *
 * Hợp đồng đóng băng (đúng tên, đúng chữ ký):
 *   TEMPLATES, ComposeError, applyTemplate({width,height,template}),
 *   composeImage({image,matting,template,options}), drawOverlay({image,overlay,font})
 *
 * KHÔNG có provider: đây là các hàm THUẦN (không I/O, không mạng, không đọc file) — E3 gọi trực tiếp.
 *
 * Ba luật riêng của MVP-03 được giữ ở tầng này:
 *  1. Ảnh ra CÙNG kích thước ảnh vào; pixel GIỮ LẠI y hệt ảnh matting (so từng byte).
 *  2. Mọi nền sinh ra có `synthetic: true` + tên mẫu (nền MÔ PHỎNG, không phải ảnh thật).
 *  3. Fail-closed: thiếu mask nền ⇒ không ghép; overlay thiếu bằng chứng/chưa dịch ⇒ không vẽ.
 */

export { ComposeError, COMPOSE_CODES } from './errors.js';
export {
  TEMPLATES,
  TEMPLATE_IDS,
  findTemplate,
  resolveTemplate,
  templateColorAt,
  writeTemplatePixel,
  applyTemplate,
} from './templates.js';
export { composeImage, NO_MASK_WARNING } from './compose.js';
export { drawOverlay, OVERLAY_REASONS } from './overlay.js';
