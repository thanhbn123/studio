/**
 * `drawOverlay` — CHÈN CHỮ VIỆT lên ảnh bằng chính engine font của MVP-02 (E2, hợp đồng 3.2 + 3.5).
 *
 * Nguyên tắc:
 *  1. **Không viết lại bộ font**: dùng `loadFont` + `layoutText` + `drawLayout` của
 *     `src/imagelab/render/**` (font bitmap 5x7 có dấu tiếng Việt, layout tự tìm cỡ vừa hộp).
 *  2. **CHỐNG BỊA (mục 3.5) — fail-closed**: trước khi vẽ phải chạy
 *     `checkClaimWords(nguồn, overlay.text)` + `checkNumericClaims(nguồn, overlay.text)`.
 *     Có vi phạm ⇒ **KHÔNG vẽ một pixel nào**, trả ảnh gốc (bản sao) + `reason = 'OVERLAY_UNSUPPORTED_CLAIM'`.
 *     `nguồn` rỗng ⇒ không có bằng chứng ⇒ mọi khẳng định bị chặn (guardrail tự bắt).
 *     `overlay.text` còn chữ Hán chưa dịch (`hasCjk`) ⇒ `reason = 'OVERLAY_NOT_TRANSLATED'`.
 *  3. **Trong biên ảnh**: hộp chữ được kẹp bằng `clampBox`/`intersectBoxWithImage` của
 *     `src/imagelab/geometry.js`; bị kẹp thì ghi `warnings`, không bao giờ tràn khung.
 *  4. **Bất biến ảnh gốc**: buffer ảnh vào không bao giờ bị sửa — mọi thao tác vẽ đều trên bản sao.
 *
 * Quy ước tham số (hợp đồng chỉ đóng băng tên hàm, không đóng băng hết field):
 *   `overlay = { text, x, y, size?, color?, align?, bold?, w?, h?, box? }`
 *   - `x`, `y`  : góc TRÊN-TRÁI của khối chữ (mặc định 0,0); bị kẹp vào biên ảnh.
 *   - `w`, `h`  : kích thước khối chữ (mặc định: từ (x,y) tới mép phải/đáy ảnh).
 *   - `size`    : TRẦN hệ số phóng font (truyền thẳng thành `maxFontSize`); bỏ trống = layout tự chọn.
 *   - `align`   : 'left' | 'center' | 'right' (mặc định 'left' vì `x` là mép trái khối chữ).
 *   - `color`   : '#rrggbb' hoặc [r,g,b(,a)] — chuẩn hoá bằng `normalizeColor`.
 *   Nguồn bằng chứng (chống bịa) nhận qua `overlay.source_text` — hoặc đối số thứ tư
 *   `source_text` / `source` / `evidence` / `ocr_text` / `product_name` / `notes`… TẤT CẢ nguồn
 *   tìm được đều được NỐI lại thành "text gốc của job" (OCR + tên sản phẩm + ghi chú người dùng);
 *   không có nguồn nào ⇒ rỗng ⇒ mọi khẳng định bị chặn.
 *
 * Hàm THUẦN: không I/O, không mạng, không đọc file.
 */

import { Buffer } from 'node:buffer';
import {
  clampBox,
  drawLayout,
  encodePng,
  layoutText,
  loadFont,
  normalizeColor,
  toRgba,
} from '../../imagelab/render/index.js';
import { decodePng } from '../../imagelab/render/png.js';
import { strictCoordinate } from '../../imagelab/geometry.js';
import { checkClaimWords, checkNumericClaims, hasCjk } from '../../imagelab/translate/guardrails.js';
import { asBuffer, isBufferLike, readInputBuffer, readRawRgba } from './image-input.js';

/** Mã lý do không vẽ — đóng băng để E3/E4/E5 và test không đoán sai chuỗi. */
export const OVERLAY_REASONS = Object.freeze({
  /** Vi phạm chống bịa: khẳng định/số liệu không có trong chứng cứ của job. */
  UNSUPPORTED_CLAIM: 'OVERLAY_UNSUPPORTED_CLAIM',
  /** Chữ overlay còn Hán/kana/Hangul chưa dịch. */
  NOT_TRANSLATED: 'OVERLAY_NOT_TRANSLATED',
  /** Không có nội dung để vẽ. */
  EMPTY: 'OVERLAY_EMPTY',
  /** Ảnh không đọc được (không phải PNG / PNG hỏng) — engine chỉ vẽ được trên PNG. */
  UNSUPPORTED_IMAGE: 'OVERLAY_UNSUPPORTED_IMAGE',
  /** Tên font lạ — `loadFont` fail-closed. */
  FONT_NOT_FOUND: 'OVERLAY_FONT_NOT_FOUND',
  /** Hộp chữ nằm hoàn toàn ngoài ảnh sau khi kẹp biên. */
  OUT_OF_BOUNDS: 'OVERLAY_OUT_OF_BOUNDS',
  /** Chữ không vừa hộp (layout fail-closed). */
  TEXT_TOO_LONG: 'OVERLAY_TEXT_TOO_LONG',
  /** Font thiếu glyph cho một ký tự — không vẽ nửa vời. */
  NO_GLYPH: 'OVERLAY_NO_GLYPH',
  /** Layout hợp lệ nhưng không ghi được pixel nào. */
  NO_PIXELS: 'OVERLAY_NO_PIXELS',
});

/**
 * Chuẩn hoá ảnh đầu vào về RGBA (bản sao) — nhận `{ buffer }` (PNG), Buffer thô,
 * hoặc `{ data|pixels, width, height, channels? }` đã giải mã sẵn.
 * @returns {{pixels:Buffer,width:number,height:number,originalBuffer:Buffer|null}|null}
 */
function readImageInput(image) {
  const raw = readInputBuffer(image);
  if (raw) {
    const decoded = decodePng(raw); // ném RenderError nếu không phải PNG hỗ trợ được
    return { pixels: toRgba(decoded), width: decoded.width, height: decoded.height, originalBuffer: raw };
  }
  const rawPixels = readRawRgba(image);
  return rawPixels ? { ...rawPixels, originalBuffer: null } : null;
}

/** Rút text bằng chứng từ một giá trị bất kỳ (chuỗi / mảng dòng / object có field text). */
function evidenceFrom(candidate) {
  if (typeof candidate === 'string') return candidate.trim() === '' ? '' : candidate;
  if (Array.isArray(candidate)) {
    return candidate.filter((line) => typeof line === 'string' && line.trim() !== '').join('\n');
  }
  if (candidate && typeof candidate === 'object') {
    const parts = [];
    for (const key of ['text', 'content', 'source_text', 'job_text', 'product_name', 'notes']) {
      const nested = candidate[key];
      if (typeof nested === 'string' && nested.trim() !== '') parts.push(nested);
      else if (Array.isArray(nested)) parts.push(nested.filter((l) => typeof l === 'string').join('\n'));
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Gom "text gốc của job" (mục 3.5) = OCR + tên sản phẩm + ghi chú người dùng.
 *
 * Nhận nhiều cách gọi khác nhau (E3 chỉ cần truyền MỘT trong số đó) và **NỐI** tất cả
 * nguồn tìm được, đúng định nghĩa "ghép các vùng chữ OCR + tên sản phẩm + ghi chú".
 * Không tìm được nguồn nào ⇒ trả `''` = KHÔNG có bằng chứng ⇒ guardrail chặn mọi khẳng định.
 */
function resolveSourceText(overlay, params) {
  const keys = [
    'source_text',
    'sourceText',
    'source',
    'text_source',
    'text_original',
    'job_text',
    'job_source',
    'evidence',
    'evidence_text',
    'evidence_texts',
    'original_text',
    'ocr_text',
    'product_name',
    'user_note',
    'note',
    'notes',
  ];
  const parts = [];
  for (const holder of [params, overlay]) {
    if (!holder || typeof holder !== 'object') continue;
    for (const key of keys) {
      const text = evidenceFrom(holder[key]);
      if (text) parts.push(text);
    }
  }
  return parts.join('\n');
}

/** Nhận font dưới 3 dạng: đối tượng font đã nạp, tên font ('5x7'), hoặc `{ name }`. */
const resolveFontObject = (font) => {
  if (font && typeof font === 'object' && typeof font.getGlyph === 'function') return font;
  if (font && typeof font === 'object' && typeof font.name === 'string') return loadFont(font.name);
  return loadFont(font == null ? '5x7' : String(font));
};

export function drawOverlay({ image, overlay, font, ...params } = {}) {
  const warnings = [];
  const text = String(overlay?.text ?? '');

  /** Trả kết quả KHÔNG vẽ — luôn kèm ảnh gốc (bản sao) và lý do tiếng Việt. */
  const blocked = (input, reason, message, violations = []) => {
    if (message) warnings.push(message);
    const buffer = input?.originalBuffer
      ? Buffer.from(input.originalBuffer) // bản sao y nguyên byte ảnh vào
      : encodePng({ width: input.width, height: input.height, data: input.pixels, channels: 4 });
    return { buffer, applied: false, reason, violations, warnings };
  };

  let input;
  try {
    input = readImageInput(image);
  } catch (error) {
    input = null;
    warnings.push(`Ảnh không giải mã được (${error?.code ?? 'IMAGE_ERROR'}) — chỉ hỗ trợ PNG.`);
  }
  if (!input) {
    const fallback = isBufferLike(image) ? asBuffer(image) : isBufferLike(image?.buffer) ? asBuffer(image.buffer) : Buffer.alloc(0);
    return {
      buffer: Buffer.from(fallback),
      applied: false,
      reason: OVERLAY_REASONS.UNSUPPORTED_IMAGE,
      violations: [],
      warnings: [...warnings, 'Ảnh không đọc được — KHÔNG vẽ overlay.'],
    };
  }
  const { pixels: sourcePixels, width, height } = input;

  if (text.trim() === '') {
    return blocked(input, OVERLAY_REASONS.EMPTY, 'Overlay không có nội dung — KHÔNG vẽ.');
  }

  // (1) Chống bịa — chữ CHƯA DỊCH bị chặn tuyệt đối (không phụ thuộc bằng chứng).
  if (hasCjk(text)) {
    return blocked(
      input,
      OVERLAY_REASONS.NOT_TRANSLATED,
      'Overlay còn chữ Hán chưa dịch — KHÔNG vẽ (mục 3.5).',
    );
  }

  // (2) Chống bịa — khẳng định/số liệu phải có trong text gốc của job.
  const source = resolveSourceText(overlay, params);
  const violations = [...checkClaimWords(source, text), ...checkNumericClaims(source, text)];
  if (violations.length > 0) {
    return blocked(
      input,
      OVERLAY_REASONS.UNSUPPORTED_CLAIM,
      'Overlay chứa khẳng định/số liệu không có bằng chứng trong text gốc — KHÔNG vẽ (mục 3.5).',
      violations,
    );
  }

  // (3) Font: dùng nguyên engine MVP-02; tên font lạ ⇒ không vẽ.
  let fontObj;
  try {
    fontObj = resolveFontObject(font ?? overlay?.font);
  } catch (error) {
    return blocked(input, OVERLAY_REASONS.FONT_NOT_FOUND, `Không nạp được font (${error?.code ?? 'FONT_ERROR'}) — KHÔNG vẽ.`);
  }

  // (4) Thiếu glyph ⇒ không vẽ nửa vời (giống provider purejs của MVP-02).
  const missing = [];
  for (const char of Array.from(text)) {
    if (!char.trim()) continue;
    if (!fontObj.hasGlyph(char) && !missing.includes(char)) missing.push(char);
  }
  if (missing.length > 0) {
    return blocked(input, OVERLAY_REASONS.NO_GLYPH, `Font thiếu glyph cho "${missing.join(' ')}" — KHÔNG vẽ.`);
  }

  // (5) Hộp chữ: kẹp vào biên ảnh bằng hình học dùng chung — không bao giờ tràn khung.
  const anchorX = strictCoordinate(overlay?.x) ?? 0;
  const anchorY = strictCoordinate(overlay?.y) ?? 0;
  const boxInput =
    overlay?.box && typeof overlay.box === 'object'
      ? overlay.box
      : {
          x: anchorX,
          y: anchorY,
          w: strictCoordinate(overlay?.w ?? overlay?.width) ?? width - anchorX,
          h: strictCoordinate(overlay?.h ?? overlay?.height) ?? height - anchorY,
        };
  const box = clampBox(boxInput, { width, height });
  if (!box) {
    return blocked(input, OVERLAY_REASONS.OUT_OF_BOUNDS, `Hộp overlay nằm ngoài ảnh (${width}x${height}) — KHÔNG vẽ.`);
  }
  if (box.x !== Math.round(anchorX) || box.y !== Math.round(anchorY)) {
    warnings.push(`Vị trí overlay bị KẸP vào biên ảnh: (${Math.round(anchorX)}, ${Math.round(anchorY)}) → (${box.x}, ${box.y}).`);
  }

  const size = strictCoordinate(overlay?.size);
  const align = ['left', 'center', 'right'].includes(overlay?.align) ? overlay.align : 'left';
  const bold = overlay?.bold === true;
  const layout = layoutText({
    text,
    box,
    font: fontObj,
    options: {
      padding: 0,
      align,
      valign: 'top',
      bold,
      ...(size !== null && size >= 1 ? { maxFontSize: Math.max(1, Math.floor(size)) } : {}),
    },
  });
  if (!layout.fits || layout.lines.length === 0) {
    return blocked(
      input,
      OVERLAY_REASONS.TEXT_TOO_LONG,
      `Chữ overlay không vừa hộp (${layout.reason ?? 'TEXT_TOO_LONG'}) — KHÔNG vẽ.`,
    );
  }

  // (6) Vẽ trên BẢN SAO — buffer ảnh vào không bao giờ bị chạm.
  const pixels = Buffer.from(sourcePixels);
  const drawn = drawLayout(pixels, layout, {
    width,
    height,
    font: fontObj,
    color: normalizeColor(overlay?.color),
    bold,
  });
  if (drawn.pixels === 0) {
    return blocked(input, OVERLAY_REASONS.NO_PIXELS, 'Layout hợp lệ nhưng không ghi được pixel nào — KHÔNG trả ảnh đã vẽ.');
  }
  if (drawn.missing.length > 0) {
    // Không thể xảy ra (đã kiểm glyph ở bước 4) — nếu có thì ghi vết, không im lặng.
    warnings.push(`Glyph "${drawn.missing.join(' ')}" không vẽ được ở bước cuối.`);
  }
  warnings.push(`Đã vẽ overlay bằng font "${fontObj.name}" (cỡ ×${layout.font_size}) trong hộp ${box.w}x${box.h}.`);

  return {
    buffer: encodePng({ width, height, data: pixels, channels: 4 }),
    applied: true,
    reason: null,
    violations: [],
    warnings,
  };
}

export default drawOverlay;
