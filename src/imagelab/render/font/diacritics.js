/**
 * Ghép dấu tiếng Việt cho font bitmap.
 *
 * Cách làm: KHÔNG vẽ tay 134 ký tự Việt precomposed. Thay vào đó:
 *   1. Tách ký tự về dạng NFD (`'ế'.normalize('NFD')` → 'e' + U+0302 + U+0301).
 *   2. Lấy glyph cơ sở (ASCII) + chồng các dấu đã tính offset lên trên/xuống dưới.
 *   3. `đ`/`Đ` không có phân rã Unicode → xử lý riêng bằng nét ngang.
 *
 * Nhờ vậy mọi ký tự Việt precomposed (ă â đ ê ô ơ ư + 5 dấu thanh, cả hoa và thường)
 * đều render được, kể cả chuỗi ở dạng NFD do người dùng dán vào.
 *
 * Ký tự nào không tách được hoặc dấu lạ → KHÔNG vẽ bừa: `composeGlyph` trả `null`,
 * tầng trên đẩy vào `unsupported_glyphs` + `skipped: NO_GLYPH`.
 */

import { BASE_OFFSET, BASELINE_ROW, CELL_COLS, CELL_ROWS, GLYPH_W } from './glyphs5x7.js';

/** Dòng dấu nặng (dot below) — dưới chân chữ, không đè lên dấu khác. */
export const DOT_BELOW_ROW = 11;

/** Dấu thanh + dấu biến âm, mỗi dấu là các dòng 6 cột (x = 0..5). */
export const MARKS = Object.freeze({
  // 5 dấu thanh
  acute: { kind: 'tone', rows: ['...#..', '..#...'] }, // sắc
  grave: { kind: 'tone', rows: ['..#...', '...#..'] }, // huyền
  hook: { kind: 'tone', rows: ['..##..', '.#....'] }, // hỏi
  tilde: { kind: 'tone', rows: ['.##...', '...##.'] }, // ngã
  dot: { kind: 'tone-below', rows: ['..##..'] }, // nặng
  // 3 dấu biến âm
  circumflex: { kind: 'modifier', rows: ['..#...', '.#.#..'] }, // mũ (â, ê, ô)
  breve: { kind: 'modifier', rows: ['#...#.', '.###..'] }, // trăng (ă)
  horn: { kind: 'horn', rows: [] }, // móc (ơ, ư) — vẽ theo vị trí đỉnh chữ
});

/** Code point tổ hợp → tên dấu. */
export const MARK_BY_CODEPOINT = Object.freeze({
  '\u0301': 'acute',
  '\u0300': 'grave',
  '\u0309': 'hook',
  '\u0303': 'tilde',
  '\u0323': 'dot',
  '\u0302': 'circumflex',
  '\u0306': 'breve',
  '\u031b': 'horn',
});

/**
 * Chữ có nét riêng, KHÔNG phân rã được bằng NFD:
 *   - `đ`/`Đ`: nét ngang qua thân chữ.
 *   - `₫` (đồng): nét ngang + gạch chân (để phân biệt với `đ`).
 * `below` là các dòng vẽ ở hàng dấu nặng (dưới chân chữ).
 */
export const STROKE_LETTERS = Object.freeze({
  đ: { base: 'd', rows: ['00000', '11110', '00000', '00000', '00000', '00000', '00000'], below: [] },
  Đ: { base: 'D', rows: ['00000', '00000', '00000', '11100', '00000', '00000', '00000'], below: [] },
  '\u20ab': { base: 'd', rows: ['00000', '11110', '00000', '00000', '00000', '00000', '00000'], below: ['#####.'] },
});

/** Vị trí dấu móc: [(cột, dòng tương đối so với đỉnh chữ)] — đi lên phải. */
const HORN_PIXELS = Object.freeze([
  [4, -1],
  [5, 0],
]);

/**
 * Tách một ký tự thành { base, modifier, tone }.
 *
 * @param {string} char một ký tự (có thể là chuỗi tổ hợp NFD)
 * @returns {{base:string, modifier:string|null, tone:string|null, stroke:boolean}|null}
 */
export function decomposeChar(char) {
  if (STROKE_LETTERS[char]) {
    return { base: STROKE_LETTERS[char].base, modifier: null, tone: null, stroke: true };
  }
  const parts = Array.from(String(char).normalize('NFD'));
  if (parts.length === 0) return null;
  const base = parts[0];
  let modifier = null;
  let tone = null;
  for (const part of parts.slice(1)) {
    const name = MARK_BY_CODEPOINT[part];
    if (!name) return null; // dấu lạ → không đoán
    const kind = MARKS[name].kind;
    if (kind === 'modifier') {
      if (modifier) return null; // hai dấu biến âm là vô nghĩa
      modifier = name;
    } else if (kind === 'horn') {
      if (modifier) return null;
      modifier = name;
    } else {
      if (tone) return null; // hai dấu thanh là vô nghĩa
      tone = name;
    }
  }
  return { base, modifier, tone, stroke: false };
}

/** Ký tự được coi là "có mực" trong bảng dấu: chấp nhận cả '#' lẫn '1'. */
const isInk = (ch) => ch === '#' || ch === '1';

const bitmask = (row) => {
  let bits = 0;
  for (let c = 0; c < GLYPH_W; c += 1) if (isInk(row[c])) bits |= 1 << (CELL_COLS - 1 - c);
  return bits;
};

function applyRows(rows, mask, startRow, width = CELL_COLS) {
  for (let i = 0; i < rows.length; i += 1) {
    const rowIndex = startRow + i;
    if (rowIndex < 0 || rowIndex >= CELL_ROWS) continue;
    let bits = 0;
    for (let c = 0; c < Math.min(width, rows[i].length); c += 1) {
      if (isInk(rows[i][c])) bits |= 1 << (CELL_COLS - 1 - c);
    }
    mask[rowIndex] |= bits;
  }
}

/**
 * Ghép glyph hoàn chỉnh cho một ký tự (có thể kèm dấu tiếng Việt).
 *
 * @param {string} char
 * @param {Map<string, Uint8Array>} baseMasks bảng glyph ASCII (đã đặt vào ô 12 dòng)
 * @param {(text:string)=>void} [onMissingBase] gọi khi thiếu glyph cơ sở
 * @returns {Uint8Array|null} mask 12 dòng, hoặc null nếu không có glyph
 */
export function composeGlyph(char, baseMasks, onMissingBase) {
  // Mọi ký tự khoảng trắng Unicode (NBSP, thin space…) đều vẽ như dấu cách:
  // nếu không quy về đây thì cả vùng chữ sẽ bị bỏ oan vì NO_GLYPH.
  const normalized = char !== ' ' && /\s/u.test(String(char)) ? ' ' : String(char);
  const info = decomposeChar(normalized);
  if (!info) return null;
  const baseMask = baseMasks.get(info.base);
  if (!baseMask) {
    if (onMissingBase) onMissingBase(info.base);
    return null;
  }

  const mask = Uint8Array.from(baseMask);

  // Nét ngang của đ/Đ và nét ngang + gạch chân của ₫.
  if (info.stroke) {
    const stroke = STROKE_LETTERS[normalized];
    for (let r = 0; r < stroke.rows.length; r += 1) {
      const rowIndex = BASE_OFFSET + r;
      if (rowIndex >= CELL_ROWS) continue;
      mask[rowIndex] |= bitmask(stroke.rows[r]);
    }
    for (const row of stroke.below ?? []) {
      mask[DOT_BELOW_ROW] |= bitmask(row);
    }
  }

  // Đỉnh chữ thực tế (dòng có mực đầu tiên) — dùng để đặt dấu cho đúng.
  let inkTop = -1;
  for (let r = 0; r < CELL_ROWS; r += 1) {
    if (mask[r]) {
      inkTop = r;
      break;
    }
  }
  if (inkTop < 0) return mask; // glyph trắng (dấu cách) — không cần dấu

  let modifierTop = null;
  if (info.modifier === 'horn') {
    for (const [col, delta] of HORN_PIXELS) {
      const rowIndex = inkTop + delta;
      if (rowIndex < 0 || rowIndex >= CELL_ROWS) continue;
      mask[rowIndex] |= 1 << (CELL_COLS - 1 - col);
    }
  } else if (info.modifier) {
    modifierTop = inkTop - MARKS[info.modifier].rows.length;
    applyRows(MARKS[info.modifier].rows, mask, modifierTop);
  }

  if (info.tone === 'dot') {
    applyRows(MARKS.dot.rows, mask, DOT_BELOW_ROW);
  } else if (info.tone) {
    const toneTop = modifierTop !== null ? modifierTop - MARKS[info.tone].rows.length : inkTop - MARKS[info.tone].rows.length;
    applyRows(MARKS[info.tone].rows, mask, toneTop);
  }

  return mask;
}

/** Dòng chân chữ (đường cơ sở) — export lại cho tầng layout/draw. */
export const FONT_BASELINE_ROW = BASELINE_ROW;
