/**
 * Font bitmap 5x7 + ghép dấu tiếng Việt.
 *
 * `loadFont(name = '5x7')` trả về một đối tượng Font bất biến (đã cache) với:
 *   - `glyphs`   : bảng mask của các glyph ASCII (12 dòng × 6 cột)
 *   - `hasGlyph` : ký tự này có vẽ được không (đã tính cả dấu tiếng Việt)
 *   - `getGlyph` : mask 12 dòng của ký tự, hoặc null
 *   - `measure`  : đo bề rộng + khoảng mực trên/dưới của một chuỗi
 *
 * Ký tự không có glyph KHÔNG được vẽ bừa: `getGlyph` trả `null`, tầng provider đẩy ký tự đó
 * vào `unsupported_glyphs` rồi bỏ qua cả vùng với `reason: 'NO_GLYPH'`.
 */

import { RenderError, RENDER_CODES } from '../errors.js';
import {
  BASE_OFFSET,
  BASELINE_ROW,
  BASE_GLYPHS,
  CELL_COLS,
  CELL_ROWS,
  GLYPH_H,
  GLYPH_W,
  buildBaseMasks,
} from './glyphs5x7.js';
import { composeGlyph } from './diacritics.js';

export { BASE_GLYPHS, CELL_COLS, CELL_ROWS, GLYPH_W, GLYPH_H, BASELINE_ROW };

/** Bề rộng ô của một ký tự = bước nhảy (advance) khi vẽ ở scale 1. */
export const CELL_ADVANCE = CELL_COLS; // 6 px: 5 px thân chữ + 1 px khe tự nhiên

/** Tên font hợp lệ. Chỉ có một font thật; các alias dưới đây trỏ về cùng font đó. */
const FONT_ALIASES = Object.freeze(['5x7', '5x7-vi', 'default', 'builtin', 'vip5x7']);

export class BitmapFont {
  constructor(name = '5x7') {
    this.name = name;
    this.width = GLYPH_W; // bề rộng thân chữ
    this.height = GLYPH_H; // chiều cao thân chữ (5x7)
    this.cellWidth = CELL_COLS; // ô vẽ thật (có cột dành cho dấu móc)
    this.cellHeight = CELL_ROWS; // ô vẽ thật (có vùng dấu)
    this.advance = CELL_ADVANCE;
    this.baseline = BASELINE_ROW;
    this.baseOffset = BASE_OFFSET;
    this.#cache = new Map();
  }

  #cache;

  /** Bảng glyph ASCII → mask 12 dòng (dùng để tra cứu/kiểm thử). */
  get glyphs() {
    const out = {};
    for (const [char, mask] of this.#baseMasks()) out[char] = mask;
    return out;
  }

  #baseMasksInstance = null;

  #baseMasks() {
    if (!this.#baseMasksInstance) this.#baseMasksInstance = buildBaseMasks();
    return this.#baseMasksInstance;
  }

  /**
   * Lấy glyph đã ghép dấu.
   * @param {string} char
   * @returns {{char:string, rows:Uint8Array, advance:number, width:number, inkTop:number, inkBottom:number}|null}
   */
  getGlyph(char) {
    const key = String(char);
    if (this.#cache.has(key)) return this.#cache.get(key);
    let rows = null;
    try {
      const composed = composeGlyph(key, this.#baseMasks());
      rows = composed ? Uint8Array.from(composed) : null;
    } catch {
      rows = null; // font không bao giờ được làm sập render — không có glyph thì báo thiếu
    }
    let glyph = null;
    if (rows) {
      let inkTop = -1;
      let inkBottom = -1;
      for (let r = 0; r < rows.length; r += 1) {
        if (rows[r]) {
          if (inkTop < 0) inkTop = r;
          inkBottom = r;
        }
      }
      glyph = {
        char: key,
        rows,
        advance: this.advance,
        width: this.cellWidth,
        inkTop,
        inkBottom,
      };
    }
    this.#cache.set(key, glyph);
    return glyph;
  }

  /** Ký tự có vẽ được không (đã tính cả dấu tiếng Việt và ký tự tổ hợp NFD). */
  hasGlyph(char) {
    return this.getGlyph(char) !== null;
  }

  /**
   * Đo một chuỗi ở scale 1.
   * @param {string} text
   * @returns {{width:number, inkTop:number, inkBottom:number, inkHeight:number, missing:string[], chars:number}}
   */
  measure(text) {
    const chars = Array.from(String(text ?? ''));
    const missing = [];
    let inkTop = -1;
    let inkBottom = -1;
    for (const char of chars) {
      if (char === '\n' || char === '\r') continue;
      const glyph = this.getGlyph(char);
      if (!glyph) {
        if (!missing.includes(char)) missing.push(char);
        continue;
      }
      if (glyph.inkTop < 0) continue; // dấu cách: không có mực
      if (inkTop < 0 || glyph.inkTop < inkTop) inkTop = glyph.inkTop;
      if (glyph.inkBottom > inkBottom) inkBottom = glyph.inkBottom;
    }
    if (inkTop < 0) {
      // Chuỗi toàn khoảng trắng: lấy mực "chuẩn" của chữ hoa để line box không bằng 0.
      inkTop = BASE_OFFSET;
      inkBottom = BASELINE_ROW;
    }
    return {
      width: chars.filter((c) => c !== '\n').length * this.advance,
      inkTop,
      inkBottom,
      inkHeight: inkBottom - inkTop + 1,
      missing,
      chars: chars.length,
    };
  }
}

const FONT_CACHE = new Map();

/**
 * Nạp font bitmap. Hiện chỉ có font '5x7' (kèm dấu tiếng Việt).
 * Tên lạ → `RenderError('FONT_NOT_FOUND')` (fail-closed, không âm thầm thay font khác).
 *
 * @param {string} [name]
 * @returns {BitmapFont}
 */
export function loadFont(name = '5x7') {
  const key = String(name ?? '5x7').toLowerCase();
  if (!FONT_ALIASES.includes(key)) {
    throw new RenderError(RENDER_CODES.FONT_NOT_FOUND, `Không có font "${name}". Hiện có: 5x7.`, {
      available: ['5x7'],
    });
  }
  if (!FONT_CACHE.has(key)) FONT_CACHE.set(key, new BitmapFont('5x7'));
  return FONT_CACHE.get(key);
}

export default loadFont;
