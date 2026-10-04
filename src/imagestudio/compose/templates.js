/**
 * BỘ MẪU NỀN MÔ PHỎNG (E2 — Compose, MVP-03) + hàm tạo buffer nền.
 *
 * LUẬT RIÊNG CỦA MVP-03 (mục 0.2 của hợp đồng): mọi nền do hệ thống sinh ra là
 * **MÔ PHỎNG**, không phải ảnh chụp thật ⇒ mọi mẫu ở đây mang `synthetic: true` và UI
 * phải hiện "nền MÔ PHỎNG (không phải ảnh thật)". Không có mẫu nào tải ảnh từ đĩa/mạng.
 *
 * `san-go` KHÔNG phải ảnh gỗ thật: đó là gradient nâu + **đường sàn** mô phỏng chân tường
 * (2 px tối hơn ở ranh giới tường/sàn) + vài vân ván dọc rất mảnh — tất cả đều là pixel
 * do công thức sinh ra, thuần tuý mô phỏng.
 *
 * File thuần: không I/O, không mạng, không đọc file. Mọi hàm đều xác định (deterministic):
 * cùng (width, height, template) ⇒ cùng buffer byte-for-byte.
 */

import { Buffer } from 'node:buffer';
import { normalizeColor } from '../../imagelab/render/image.js';
import { ComposeError, COMPOSE_CODES } from './errors.js';

/** Trần cấp phát cho một buffer nền (khớp `DEFAULT_MAX_PIXELS` của codec PNG). */
const MAX_TEMPLATE_PIXELS = 25_000_000;

/** Đóng băng sâu một mẫu nền để không agent nào sửa được bảng luật dùng chung. */
function freezeTemplate({ id, label, kind, colors }) {
  return Object.freeze({
    id,
    label,
    kind,
    synthetic: true, // LUẬT: nền sinh ra luôn là mô phỏng — không bao giờ khai là ảnh thật
    colors: Object.freeze([...colors]),
  });
}

/**
 * Danh sách mẫu nền — **id đóng băng theo hợp đồng 3.2**:
 * `trang`, `xam-nhat`, `gradient-xanh`, `gradient-hong`, `san-go`.
 */
export const TEMPLATES = Object.freeze([
  freezeTemplate({ id: 'trang', label: 'Trắng', kind: 'solid', colors: ['#ffffff'] }),
  freezeTemplate({ id: 'xam-nhat', label: 'Xám nhạt', kind: 'solid', colors: ['#ececec'] }),
  freezeTemplate({ id: 'gradient-xanh', label: 'Gradient xanh', kind: 'gradient', colors: ['#eaf4ff', '#7fb2ea'] }),
  freezeTemplate({ id: 'gradient-hong', label: 'Gradient hồng', kind: 'gradient', colors: ['#fff1f6', '#f2a3c0'] }),
  freezeTemplate({ id: 'san-go', label: 'Sàn gỗ', kind: 'floor', colors: ['#573a24', '#8a5a33', '#c9a26b'] }),
]);

/** Id hợp lệ, theo đúng thứ tự khai báo (E4/E5 hiện lên UI theo thứ tự này). */
export const TEMPLATE_IDS = Object.freeze(TEMPLATES.map((template) => template.id));

const BY_ID = new Map(TEMPLATES.map((template) => [template.id, template]));

/** Bảng màu đã tách kênh cho từng mẫu (tránh parse hex lặp lại cho từng pixel). */
const PALETTE = new WeakMap();

function paletteOf(template) {
  let colors = PALETTE.get(template);
  if (!colors) {
    colors = (template.colors ?? []).map((color) => normalizeColor(color, [255, 255, 255, 255]).slice(0, 3));
    if (colors.length === 0) colors = [[255, 255, 255]];
    PALETTE.set(template, colors);
  }
  return colors;
}

/**
 * Tìm mẫu nền theo id (không phân biệt hoa/thường, bỏ khoảng trắng thừa).
 * @param {string} id
 * @returns {object|null} mẫu ĐÓNG BĂNG gốc trong `TEMPLATES`, hoặc null
 */
export function findTemplate(id) {
  if (typeof id !== 'string') return null;
  return BY_ID.get(id.trim().toLowerCase()) ?? null;
}

/**
 * Chuẩn hoá tham số `template` của hợp đồng 3.2 — nhận:
 *   - `undefined`/`null`  → mẫu mặc định `trang`;
 *   - chuỗi id            → phải khớp một id trong `TEMPLATES`;
 *   - object có `id`      → trả về mẫu ĐÓNG BĂNG gốc (không tin object do người gọi đưa).
 *
 * Id lạ ⇒ `ComposeError('TEMPLATE_NOT_FOUND')` kèm `details.available` (fail-closed:
 * KHÔNG âm thầm thay bằng nền trắng để rồi E3 ghi sai `meta.template`).
 *
 * @returns {object} mẫu nền đóng băng
 */
export function resolveTemplate(template) {
  if (template === undefined || template === null || template === '') return BY_ID.get('trang');
  const id = typeof template === 'string' ? template : template?.id;
  const found = findTemplate(id);
  if (!found) {
    throw new ComposeError(
      COMPOSE_CODES.TEMPLATE_NOT_FOUND,
      `Không có mẫu nền "${String(id)}". Hiện có: ${TEMPLATE_IDS.join(', ')}.`,
      { requested: id ?? null, available: [...TEMPLATE_IDS] },
    );
  }
  return found;
}

const clampByte = (value) => (value < 0 ? 0 : value > 255 ? 255 : Math.round(value));

/** Nội suy tuyến tính hai màu [r,g,b] theo `t` ∈ [0,1]. */
function lerpColor(from, to, t) {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return [
    clampByte(from[0] + (to[0] - from[0]) * k),
    clampByte(from[1] + (to[1] - from[1]) * k),
    clampByte(from[2] + (to[2] - from[2]) * k),
  ];
}

/** Làm tối một màu theo hệ số `factor` (0..1) — dùng cho đường sàn/vân gỗ mô phỏng. */
function darken(color, factor) {
  return [clampByte(color[0] * factor), clampByte(color[1] * factor), clampByte(color[2] * factor)];
}

/**
 * Màu nền MÔ PHỎNG tại một pixel — NGUỒN SỰ THẬT DUY NHẤT cho cả `applyTemplate` lẫn
 * `composeImage`, để hai đường đi không bao giờ lệch màu nhau.
 *
 * @param {object} template mẫu đã chuẩn hoá (xem `resolveTemplate`)
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @returns {number[]} [r,g,b] (alpha luôn đục — nền mô phỏng không trong suốt)
 */
export function templateColorAt(template, x, y, width, height) {
  const colors = paletteOf(template);
  const kind = template?.kind;

  if (kind === 'gradient') {
    const t = height <= 1 ? 0 : y / (height - 1);
    return lerpColor(colors[0], colors[1] ?? colors[0], t);
  }

  if (kind === 'floor') {
    // MÔ PHỎNG sàn gỗ: phần trên là "tường" gradient nâu, phần dưới là "sàn" sáng hơn,
    // ranh giới là ĐƯỜNG SÀN (mô phỏng chân tường), dưới đó có vân ván dọc rất mảnh.
    const wallTop = colors[0];
    const mid = colors[1] ?? colors[0];
    const floorBottom = colors[2] ?? mid;
    const horizon = height >= 2 ? Math.max(1, Math.min(height - 2, Math.round(height * 0.62))) : 0;
    let color;
    if (y < horizon) {
      const t = horizon <= 1 ? 0 : y / (horizon - 1);
      color = lerpColor(wallTop, mid, t);
    } else {
      const span = height - 1 - horizon;
      const t = span <= 0 ? 0 : (y - horizon) / span;
      color = lerpColor(mid, floorBottom, t);
    }
    // Đường sàn: 2 px tối hơn ngay trên/dưới ranh giới (mô phỏng, không phải ảnh thật).
    if (y === horizon || y === horizon - 1) color = darken(color, 0.72);
    // Vân ván gỗ mô phỏng: một khe dọc mảnh, lặp theo bề rộng ảnh (bước ≥ 24 px).
    if (y >= horizon) {
      const step = Math.max(24, Math.round(width / 6));
      if (x % step === Math.floor(step / 2)) color = darken(color, 0.86);
    }
    return color;
  }

  // solid (mặc định): một màu phẳng.
  return [colors[0][0], colors[0][1], colors[0][2]];
}

/**
 * Ghi màu nền mô phỏng vào một pixel RGBA (alpha = 255) của `pixels` tại `offset`.
 * Hàm phụ trợ nội bộ — `composeImage` gọi thẳng để không phải cấp phát buffer nền riêng.
 */
export function writeTemplatePixel(pixels, offset, template, x, y, width, height) {
  const [r, g, b] = templateColorAt(template, x, y, width, height);
  pixels[offset] = r;
  pixels[offset + 1] = g;
  pixels[offset + 2] = b;
  pixels[offset + 3] = 255;
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * `applyTemplate({ width, height, template })` → Buffer RGBA của NỀN MÔ PHỎNG.
 *
 * Hàm THUẦN: cùng đầu vào ⇒ cùng buffer; không đọc file/mạng; không sửa gì bên ngoài.
 *
 * @param {{width:number,height:number,template?:string|object}} params
 * @returns {Buffer} buffer RGBA dài `width*height*4`
 * @throws {ComposeError} BAD_INPUT khi width/height không phải số nguyên dương (hoặc quá lớn)
 * @throws {ComposeError} TEMPLATE_NOT_FOUND khi id mẫu nền lạ
 */
export function applyTemplate({ width, height, template } = {}) {
  const w = toPositiveInt(width);
  const h = toPositiveInt(height);
  if (!w || !h) {
    throw new ComposeError(COMPOSE_CODES.BAD_INPUT, 'applyTemplate cần width/height là số nguyên dương.', {
      width,
      height,
    });
  }
  if (w * h > MAX_TEMPLATE_PIXELS) {
    throw new ComposeError(
      COMPOSE_CODES.BAD_INPUT,
      `applyTemplate từ chối ảnh ${w}x${h} (vượt trần ${MAX_TEMPLATE_PIXELS} pixel).`,
      { width: w, height: h, maxPixels: MAX_TEMPLATE_PIXELS },
    );
  }
  const resolved = resolveTemplate(template);
  const out = Buffer.allocUnsafe(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      writeTemplatePixel(out, (y * w + x) * 4, resolved, x, y, w, h);
    }
  }
  return out;
}

export default applyTemplate;
