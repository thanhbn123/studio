/**
 * `layoutText` — xếp chữ vào một hộp pixel, tự tìm cỡ chữ lớn nhất vừa hộp.
 *
 * Hợp đồng 4.3 (đóng băng):
 *   LayoutResult = { fits, font_size, line_height, lines: [{text,x,y,w,h}], reason }
 *
 * Bất biến quan trọng nhất: khi `fits === true`, MỌI đường bao dòng chữ phải nằm TRONG `box`.
 * Đường bao ở đây là hình chữ nhật bao trọn vùng mực sẽ vẽ (đã tính cả dấu tiếng Việt và
 * cả nét đậm giả bằng cách tô lệch 1px). Trước khi trả kết quả, hàm tự kiểm hình học bằng
 * `verifyLines`; nếu một dòng lọt ra ngoài thì coi như không vừa (fail-closed).
 *
 * `font_size` là HỆ SỐ PHÓNG của font bitmap (1 = ô 6x12 px), không phải cỡ chữ vector.
 */

import { loadFont } from './font/index.js';

const MAX_FONT_SIZE = 64; // trần cứng để không lặp vô hạn với hộp khổng lồ
const MAX_WRAP_LINES = 4096; // trần số dòng khi ngắt (chống chuỗi cực dài)

const toNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** Chuẩn hoá font: nhận đối tượng Font hoặc tên font. */
function resolveFont(font) {
  if (font && typeof font === 'object' && typeof font.getGlyph === 'function') return font;
  if (font === undefined || font === null) return loadFont('5x7');
  return loadFont(String(font));
}

/**
 * Gom tuỳ chọn từ cả `options` lẫn các khoá phẳng trên đối số đầu (dễ gọi, khó sai).
 */
function collectOptions(root, options) {
  const fromRoot = {};
  for (const key of [
    'padding',
    'pad',
    'minFontSize',
    'maxFontSize',
    'min_font_size',
    'max_font_size',
    'lineHeight',
    'line_height',
    'lineGap',
    'line_gap',
    'align',
    'valign',
    'bold',
    'fontScale',
    'font',
  ]) {
    if (root && root[key] !== undefined) fromRoot[key] = root[key];
  }
  return { ...fromRoot, ...(options && typeof options === 'object' ? options : {}) };
}

/**
 * Ngắt văn bản thành các dòng vừa `maxChars` ký tự (theo từ; từ quá dài bị cắt an toàn).
 * @returns {string[]}
 */
function wrapText(text, maxChars, limit = MAX_WRAP_LINES) {
  const out = [];
  const paragraphs = String(text).split('\n');
  for (const paragraph of paragraphs) {
    if (out.length >= limit) break;
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push(''); // dòng trống do người dùng gõ vẫn được giữ
      continue;
    }
    // Cắt từ dài hơn một dòng thành nhiều khúc (không tràn ngang).
    const chunks = [];
    for (const word of words) {
      const chars = Array.from(word);
      if (chars.length <= maxChars) {
        chunks.push(chars.join(''));
      } else {
        for (let i = 0; i < chars.length; i += maxChars) chunks.push(chars.slice(i, i + maxChars).join(''));
      }
    }
    let current = '';
    for (const chunk of chunks) {
      const candidate = current ? `${current} ${chunk}` : chunk;
      if (Array.from(candidate).length <= maxChars) {
        current = candidate;
      } else {
        if (current) out.push(current);
        current = chunk;
      }
      if (out.length >= limit) break;
    }
    if (current && out.length < limit) out.push(current);
  }
  return out.slice(0, limit);
}

/** Kiểm mọi dòng nằm trong hộp (bất biến số 1 của layout). */
function verifyLines(lines, box) {
  return lines.every(
    (line) =>
      Number.isFinite(line.x) &&
      Number.isFinite(line.y) &&
      line.x >= box.x &&
      line.y >= box.y &&
      line.x + line.w <= box.x + box.w &&
      line.y + line.h <= box.y + box.h,
  );
}

/**
 * Xếp chữ vào hộp.
 *
 * @param {{text?:string, box?:{x:number,y:number,w:number,h:number}, font?:object|string, options?:object}} params
 * @returns {{fits:boolean, font_size:number, line_height:number, lines:Array<{text:string,x:number,y:number,w:number,h:number}>, reason:null|'TEXT_TOO_LONG'|'BOX_TOO_SMALL'|'BAD_BOX'}}
 */
export function layoutText({ text, box, font, options, ...rest } = {}) {
  const opts = collectOptions({ ...rest, box, text, font }, options);
  // Font có thể được truyền ở tham số `font`, hoặc lồng trong `options.font`.
  const fontObj = resolveFont(font ?? opts.font);

  const rawText = text === undefined || text === null ? '' : String(text).replace(/\r\n?/g, '\n');
  const bx = toNumber(box?.x, NaN);
  const by = toNumber(box?.y, NaN);
  const bw = toNumber(box?.w, NaN);
  const bh = toNumber(box?.h, NaN);

  const minFontSize = Math.max(1, Math.floor(toNumber(opts.minFontSize ?? opts.min_font_size, 1)));
  const requestedMax = Math.floor(toNumber(opts.maxFontSize ?? opts.max_font_size, 0));
  const fontScale = Math.max(0.1, toNumber(opts.fontScale, 1));
  const padding = Math.max(0, Math.floor(toNumber(opts.padding ?? opts.pad, 2)));
  const align = ['left', 'center', 'right'].includes(opts.align) ? opts.align : 'center';
  const valign = ['top', 'middle', 'bottom'].includes(opts.valign) ? opts.valign : 'middle';
  const bold = Boolean(opts.bold);

  const metrics = fontObj.measure(rawText);
  const inkHeight = metrics.inkHeight;
  const lineGapOption = toNumber(opts.lineGap ?? opts.line_gap, 1);
  const lineHeightOption = toNumber(opts.lineHeight ?? opts.line_height, NaN);

  /** Bước nhảy dòng (px) tại một scale. */
  const strideFor = (scale) => {
    const ink = inkHeight * scale;
    const gap = Math.max(0, Math.round(lineGapOption)) * scale;
    let stride = ink + gap;
    if (Number.isFinite(lineHeightOption) && lineHeightOption > 0) {
      // Quy ước: < 6 → hệ số nhân của chiều cao mực; >= 6 → số pixel tuyệt đối.
      const requested =
        lineHeightOption < 6 ? Math.ceil(lineHeightOption * ink) : Math.round(lineHeightOption);
      stride = Math.max(ink, requested);
    }
    return Math.max(1, stride);
  };

  // Hộp không hợp lệ → BAD_BOX, không vẽ gì.
  if (!Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bw) || !Number.isFinite(bh) || bw <= 0 || bh <= 0) {
    return {
      fits: false,
      font_size: minFontSize,
      line_height: strideFor(minFontSize),
      lines: [],
      reason: 'BAD_BOX',
    };
  }

  const availW = bw - padding * 2;
  const availH = bh - padding * 2;
  if (availW <= 0 || availH <= 0) {
    return {
      fits: false,
      font_size: minFontSize,
      line_height: strideFor(minFontSize),
      lines: [],
      reason: 'BOX_TOO_SMALL',
    };
  }

  // Chuỗi rỗng: "vừa" theo nghĩa không có dòng nào để tràn (vacuous truth).
  if (rawText.trim() === '') {
    return { fits: true, font_size: minFontSize, line_height: strideFor(minFontSize), lines: [], reason: null };
  }

  const boldExtra = bold ? 1 : 0;

  /** Thử xếp ở một scale; trả cả lý do không vừa để chọn `reason` cuối cùng. */
  const attempt = (scale) => {
    const advance = fontObj.advance * scale;
    const maxChars = Math.floor((availW - boldExtra) / advance);
    const stride = strideFor(scale);
    if (maxChars < 1) return { fits: false, scale, stride, lines: [], maxChars, capacity: 0 };
    const capacity = Math.floor(availH / stride);
    if (capacity < 1) return { fits: false, scale, stride, lines: [], maxChars, capacity };
    const rawLines = wrapText(rawText, maxChars, Math.min(MAX_WRAP_LINES, capacity + 1));
    const widthOf = (lineText) => Array.from(lineText).length * advance + boldExtra;
    const tooWide = rawLines.some((lineText) => widthOf(lineText) > availW);
    const kept = rawLines.slice(0, capacity);
    const totalH = kept.length * stride;
    let blockTop = by + padding;
    if (valign === 'middle') blockTop += Math.floor((availH - totalH) / 2);
    else if (valign === 'bottom') blockTop += availH - totalH;
    const lines = kept.map((lineText, index) => {
      const w = widthOf(lineText);
      const slack = availW - w;
      const x =
        bx +
        padding +
        (align === 'center' ? Math.floor(slack / 2) : align === 'right' ? slack : 0);
      return { text: lineText, x, y: blockTop + index * stride, w, h: stride };
    });
    const fits = !tooWide && rawLines.length <= capacity && kept.length === rawLines.length && verifyLines(lines, box);
    return { fits, scale, stride, lines, maxChars, capacity };
  };

  // Trần cỡ chữ: ưu tiên tuỳ chọn của người gọi, nếu không thì suy từ hộp.
  const autoMax = Math.max(
    minFontSize,
    Math.min(
      MAX_FONT_SIZE,
      Math.floor(availH / Math.max(1, inkHeight + Math.max(0, Math.round(lineGapOption)))),
      Math.floor(availW / fontObj.advance),
    ),
  );
  const maxFontSize = Math.max(
    minFontSize,
    requestedMax > 0 ? requestedMax : Math.max(minFontSize, Math.floor(autoMax * fontScale)),
  );

  // Tìm nhị phân cỡ chữ lớn nhất còn vừa (đơn điệu theo scale).
  let lo = minFontSize;
  let hi = maxFontSize;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const result = attempt(mid);
    if (result.fits) {
      best = result;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best) {
    return {
      fits: true,
      font_size: best.scale,
      line_height: best.stride,
      lines: best.lines,
      reason: null,
    };
  }

  // Không vừa: trả về các dòng ĐÃ CẮT an toàn (không dòng nào tràn hộp).
  const fallback = attempt(minFontSize);
  const reason =
    fallback.maxChars < 1 || fallback.capacity < 1 ? 'BOX_TOO_SMALL' : 'TEXT_TOO_LONG';
  const safeLines = (verifyLines(fallback.lines, box) ? fallback.lines : []).map((line) => ({ ...line }));
  return {
    fits: false,
    font_size: minFontSize,
    line_height: fallback.stride,
    lines: safeLines,
    reason,
  };
}

export default layoutText;
