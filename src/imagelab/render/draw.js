/**
 * Vẽ các dòng chữ của một `LayoutResult` lên buffer pixel RGBA.
 *
 * Nguyên tắc:
 *  − Chỉ ghi vào `pixels` (buffer làm việc do provider tạo ra) — không bao giờ chạm buffer gốc.
 *  − Vẽ đúng vị trí `lines[i].x/y`, hệ số phóng `layout.font_size`.
 *  − Ký tự thiếu glyph thì BỎ QUA (không vẽ ô vuông thay thế) và báo lại qua `missing`
 *    để tầng provider fail-closed.
 */

import { fillRect } from './image.js';

/**
 * @param {Buffer|Uint8Array} pixels buffer RGBA (đã là bản sao)
 * @param {{font_size:number, lines:Array<{text:string,x:number,y:number,w:number,h:number}>}} layout
 * @param {object} params
 * @param {number} params.width
 * @param {number} params.height
 * @param {object} params.font đối tượng Font (có cellWidth/cellHeight/advance/getGlyph/measure)
 * @param {number[]} params.color màu mực RGBA
 * @param {boolean} [params.bold]
 * @returns {{pixels:number, missing:string[]}}
 */
export function drawLayout(pixels, layout, { width, height, font, color, bold = false } = {}) {
  if (!layout || !Array.isArray(layout.lines) || layout.lines.length === 0) {
    return { pixels: 0, missing: [] };
  }
  const scale = Math.max(1, Math.floor(Number(layout.font_size) || 1));
  const advance = font.advance * scale;
  const missing = [];
  let drawn = 0;

  // Đỉnh mực của TOÀN BỘ chuỗi đã xếp — dùng để đặt dòng glyph vào đúng ô của dòng.
  const metrics = font.measure(layout.lines.map((line) => line.text).join('\n'));
  const inkTop = metrics.inkTop;
  const boldOffset = bold ? 1 : 0;

  for (const line of layout.lines) {
    const chars = Array.from(String(line.text ?? ''));
    for (let index = 0; index < chars.length; index += 1) {
      const char = chars[index];
      const glyph = font.getGlyph(char);
      if (!glyph) {
        if (char.trim() && !missing.includes(char)) missing.push(char);
        continue;
      }
      if (glyph.inkTop < 0) continue; // dấu cách
      const gx = line.x + index * advance;
      for (let row = 0; row < glyph.rows.length; row += 1) {
        const bits = glyph.rows[row];
        if (!bits) continue;
        const rowOffset = row - inkTop;
        if (rowOffset < 0) continue; // không thể xảy ra (inkTop là min) — phòng thủ
        const gy = line.y + rowOffset * scale;
        for (let col = 0; col < font.cellWidth; col += 1) {
          if (!(bits & (1 << (font.cellWidth - 1 - col)))) continue;
          const px = gx + col * scale;
          const py = gy;
          fillRect(pixels, { width, height }, { x: px, y: py, w: scale, h: scale }, color);
          drawn += scale * scale;
          if (boldOffset) {
            fillRect(pixels, { width, height }, { x: px + boldOffset, y: py, w: scale, h: scale }, color);
          }
        }
      }
    }
  }
  return { pixels: drawn, missing };
}

export default drawLayout;
