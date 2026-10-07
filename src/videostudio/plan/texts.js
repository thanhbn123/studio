/**
 * CHUẨN HOÁ CHỮ TRÊN VIDEO (V1) — kẹp vị trí/cỡ/thời gian vào trong khung và trong cảnh.
 *
 * Luật:
 *  1. Chữ RỖNG (hoặc chỉ khoảng trắng) ⇒ **BỎ**, chỉ để lại `warnings` — không bao giờ tạo
 *     `texts[]` rỗng cho V2 vẽ.
 *  2. `x`, `y`, `size` bị KẸP để khối chữ nằm TRONG khung; hộp chữ cuối cùng đi qua
 *     `intersectBoxWithImage` của `src/imagelab/geometry.js` (nguồn duy nhất của phép kẹp hộp).
 *  3. `start_ms`/`end_ms` bị kẹp trong `[0, duration_ms]` của CHÍNH cảnh đó (sau khi cắt trần).
 *  4. `animation` chỉ nhận `'none'` / `'fade-in'`; giá trị lạ ⇒ `'none'` + cảnh báo (fail-closed,
 *     không đoán hiệu ứng).
 *
 * Đo chữ bằng CHÍNH font bitmap 5×7 của MVP-02 (`loadFont` — bảng glyph NHÚNG trong mã nguồn,
 * không đọc file, không I/O) để biết bề rộng/bề cao mực thật, nhờ đó kẹp cỡ chữ không bịa.
 *
 * File thuần: không I/O, không mạng, không đọc file.
 */

import { intersectBoxWithImage, strictCoordinate } from '../../imagelab/geometry.js';
import { loadFont } from '../../imagelab/render/font/index.js';
import { DEFAULT_TEXT_SIZE, MAX_TEXT_SIZE } from './presets.js';
import { isHexColor, normalizeHexColor } from './fit.js';

/** Font bitmap của MVP-02 — nạp một lần, chỉ đọc bảng glyph nhúng trong mã. */
const FONT = loadFont('5x7');

/** Căn lề hợp lệ của khối chữ. */
export const TEXT_ALIGNS = Object.freeze(['left', 'center', 'right']);

/** Hiệu ứng chữ hợp lệ (`fade-in` do V2 pha trộn theo khung). */
export const TEXT_ANIMATIONS = Object.freeze(['none', 'fade-in']);

/** Màu chữ mặc định (trắng) khi người gọi không nêu. */
export const DEFAULT_TEXT_COLOR = '#FFFFFF';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/**
 * Đọc câu chữ từ một mục `texts[]` (chuỗi, hoặc đối tượng `{ text }`/`{ content }`).
 * KHÔNG đọc bất cứ khoá bằng chứng nào trong đó (xem `claims.js`).
 * @returns {string}
 */
/**
 * Trần ĐỘ DÀI một đoạn chữ được vẽ (ký tự) — MỘT hằng dùng chung cho cả chuỗi:
 * route sanitize (`src/http/routes.js`) → plan/`summarizePlan` (V3) → UI (`public/app.js`).
 *
 * F8 (phản biện MVP-04, MINOR): `plan_summary` từng cắt ở 300 trong khi video vẽ tới 500 ⇒ mở lại
 * job thấy chữ KHÁC chữ trên video. Không được để hai con số khác nhau cho cùng một dữ liệu.
 */
export const VIDEOSTUDIO_TEXT_MAX = 500;

export function readTextValue(raw) {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
  if (raw && typeof raw === 'object') {
    const value = raw.text ?? raw.content ?? raw.label ?? raw.value;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

/** Ước lượng khối mực của một câu chữ tại một cỡ (hệ số phóng font). */
function measureText(text, size) {
  const metrics = FONT.measure(text);
  return {
    advance: Math.max(1, metrics.width),
    inkHeight: Math.max(1, metrics.inkHeight),
    missing: metrics.missing,
    width: Math.max(1, metrics.width) * size,
    height: Math.max(1, metrics.inkHeight) * size,
  };
}

/**
 * Chuẩn hoá danh sách chữ của MỘT cảnh.
 *
 * @param {object} params
 * @param {Array|string|object} params.texts   mục chữ thô (chuỗi, đối tượng, hoặc mảng trộn)
 * @param {number} params.width                bề rộng khung
 * @param {number} params.height               bề cao khung
 * @param {number} params.duration_ms          thời lượng THẬT của cảnh sau khi cắt trần
 * @param {number} [params.scene_index=0]      số thứ tự cảnh (cho cảnh báo)
 * @param {string[]} [params.warnings=[]]      nơi ghi cảnh báo tiếng Việt
 * @returns {Array<{text:string,x:number,y:number,size:number,align:string,color:string,start_ms:number,end_ms:number,animation:string}>}
 */
export function normalizeSceneTexts({
  texts,
  width,
  height,
  duration_ms,
  scene_index = 0,
  warnings = [],
} = {}) {
  if (texts === undefined || texts === null) return [];
  const list = Array.isArray(texts) ? texts : [texts];
  const out = [];
  const label = `Cảnh #${scene_index}`;

  for (const raw of list) {
    const text = readTextValue(raw).trim();
    if (text === '') {
      warnings.push(`${label}: bỏ 1 mục chữ rỗng — không tạo text rỗng trên video.`);
      continue;
    }
    const holder = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

    // (1) Cỡ chữ: kẹp theo khung, không bao giờ tràn.
    const requestedSize = strictCoordinate(holder.size ?? holder.font_size ?? holder.fontSize);
    const probe = measureText(text, 1);
    const maxByFrame = Math.max(
      1,
      Math.min(
        MAX_TEXT_SIZE,
        Math.floor(width / probe.advance),
        Math.floor(height / probe.inkHeight),
      ),
    );
    const wanted = requestedSize !== null && requestedSize >= 1 ? Math.round(requestedSize) : DEFAULT_TEXT_SIZE;
    const size = clamp(wanted, 1, maxByFrame);
    if (size !== wanted) {
      warnings.push(`${label}: cỡ chữ “${text}” bị kẹp ${wanted} → ${size} cho vừa khung ${width}×${height}.`);
    }
    const measured = measureText(text, size);

    // (2) Vị trí: mặc định căn giữa khung; kẹp để khối chữ nằm trong khung.
    const rawX = strictCoordinate(holder.x);
    const rawY = strictCoordinate(holder.y);
    const defaultX = Math.floor((width - measured.width) / 2);
    const defaultY = Math.floor((height - measured.height) / 2);
    const wantedX = rawX === null ? defaultX : Math.round(rawX);
    const wantedY = rawY === null ? defaultY : Math.round(rawY);
    const x = clamp(wantedX, 0, Math.max(0, width - measured.width));
    const y = clamp(wantedY, 0, Math.max(0, height - measured.height));
    if (x !== wantedX || y !== wantedY) {
      warnings.push(
        `${label}: vị trí chữ “${text}” bị kẹp (${wantedX}, ${wantedY}) → (${x}, ${y}) trong khung ${width}×${height}.`,
      );
    }
    // Lưới an toàn hình học dùng chung: hộp chữ PHẢI nằm trong khung.
    const box = intersectBoxWithImage({ x, y, w: measured.width, h: measured.height }, width, height);
    if (!box) {
      warnings.push(`${label}: chữ “${text}” nằm ngoài khung ${width}×${height} — bỏ.`);
      continue;
    }

    // (3) Thời gian: kẹp trong chính cảnh này.
    const rawStart = strictCoordinate(holder.start_ms ?? holder.start);
    const rawEnd = strictCoordinate(holder.end_ms ?? holder.end);
    const wantedStart = rawStart === null ? 0 : Math.round(rawStart);
    const wantedEnd = rawEnd === null ? duration_ms : Math.round(rawEnd);
    const start = clamp(wantedStart, 0, Math.max(0, duration_ms - 1));
    const end = clamp(wantedEnd, start + 1, duration_ms);
    if (start !== wantedStart || end !== wantedEnd) {
      warnings.push(
        `${label}: thời gian chữ “${text}” bị kẹp ${wantedStart}..${wantedEnd}ms → ${start}..${end}ms (cảnh dài ${duration_ms}ms).`,
      );
    }

    // (4) Căn lề / màu / hiệu ứng: giá trị lạ ⇒ mặc định + cảnh báo (không đoán).
    const rawAlign = holder.align === undefined || holder.align === null ? '' : String(holder.align).trim().toLowerCase();
    const align = TEXT_ALIGNS.includes(rawAlign) ? rawAlign : 'center';
    if (rawAlign !== '' && !TEXT_ALIGNS.includes(rawAlign)) {
      warnings.push(`${label}: căn lề “${holder.align}” không hợp lệ — dùng “center”.`);
    }
    const color = normalizeHexColor(holder.color, DEFAULT_TEXT_COLOR);
    if (holder.color !== undefined && holder.color !== null && !isHexColor(holder.color)) {
      warnings.push(`${label}: màu chữ “${String(holder.color)}” không phải #RRGGBB — dùng ${DEFAULT_TEXT_COLOR}.`);
    }
    const rawAnimation =
      holder.animation === undefined || holder.animation === null
        ? ''
        : String(holder.animation).trim().toLowerCase();
    const animation = TEXT_ANIMATIONS.includes(rawAnimation) ? rawAnimation : 'none';
    if (rawAnimation !== '' && !TEXT_ANIMATIONS.includes(rawAnimation)) {
      warnings.push(`${label}: hiệu ứng chữ “${holder.animation}” không hợp lệ — dùng “none”.`);
    }

    if (measured.missing.length > 0) {
      warnings.push(
        `${label}: font ${FONT.name} THIẾU glyph cho “${measured.missing.join(' ')}” — các ký tự đó sẽ không được vẽ.`,
      );
    }

    out.push({
      text,
      x: box.x,
      y: box.y,
      size,
      align,
      color,
      start_ms: start,
      end_ms: end,
      animation,
    });
  }
  return out;
}

export default normalizeSceneTexts;
