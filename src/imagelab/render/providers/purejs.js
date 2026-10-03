/**
 * Provider `purejs` — render THẬT, chạy offline, chỉ với PNG (hợp đồng 4.3).
 *
 * Luồng: decodePng → chuyển RGBA (bản sao) → với từng op: xoá vùng (trung vị viền) và/hoặc
 * vẽ chữ Việt (font bitmap) → encodePng. Buffer đầu vào KHÔNG bao giờ bị ghi đè.
 *
 * Fail-closed:
 *  − Input không phải PNG → `RENDER_JPEG_UNSUPPORTED` (nói rõ cần cắm provider `http`).
 *  − Thiếu glyph → KHÔNG xoá, KHÔNG vẽ vùng đó (giữ nguyên chữ gốc), ghi `NO_GLYPH` + PARTIAL.
 *  − Chữ không vừa hộp → KHÔNG xoá vùng đó, ghi `TEXT_TOO_LONG`/`BOX_TOO_SMALL` + PARTIAL.
 */

import { Buffer } from 'node:buffer';
import { RenderProvider, RENDER_STATUS } from '../provider.js';
import { RenderError, RENDER_CODES } from '../errors.js';
import { clampBox, detectImageMime, normalizeColor, probeImage, toRgba } from '../image.js';
import { decodePng, encodePng, sha256 } from '../png.js';
import { estimateBackground, eraseBox } from '../inpaint.js';
import { layoutText } from '../layout.js';
import { drawLayout } from '../draw.js';
import { loadFont } from '../font/index.js';

const DEFAULT_PADDING = 2;

export class PureJsRenderProvider extends RenderProvider {
  constructor({ model = 'purejs/png+font5x7', limits, logger } = {}) {
    super({ name: 'purejs', model, isMock: false, configured: true, limits, logger });
  }

  async renderImpl({ image, ops, opsSkipped, options }) {
    const buffer = image.buffer;
    if (!buffer || buffer.length === 0) {
      throw new RenderError(RENDER_CODES.BAD_INPUT, 'Thiếu dữ liệu ảnh để render.');
    }

    // (1) Chỉ nhận PNG — ảnh khác thì nói thẳng, không đoán.
    const mime = detectImageMime(buffer) ?? image.mime ?? null;
    if (mime && mime !== 'image/png') {
      throw new RenderError(
        RENDER_CODES.RENDER_JPEG_UNSUPPORTED,
        `Provider "purejs" chỉ xử lý PNG (nhận ${mime}). Ảnh JPEG/WebP/GIF cần cắm provider "http" (RENDER_PROVIDER=http).`,
        { mime },
      );
    }

    // (2) Giải mã (có chặn bom nén / ảnh khổng lồ TRƯỚC khi cấp phát pixel).
    const decoded = decodePng(buffer, {
      maxPixels: this.limits.maxPixels,
      maxBytes: this.limits.maxInputBytes,
    });
    const dims = { width: decoded.width, height: decoded.height, channels: 4 };
    const pixels = toRgba(decoded); // buffer MỚI — không dính tới input

    const font = loadFont(options.fontName ?? options.font ?? '5x7');
    const warnings = [];
    const applied = [];
    const skipped = [];
    const unsupported = [];

    for (const op of ops) {
      const box = clampBox(op.box, dims);
      if (!box) {
        skipped.push({ region_id: op.region_id, reason: 'BAD_BOX' });
        warnings.push(`Vùng ${op.region_id}: hộp không hợp lệ hoặc nằm ngoài ảnh — bỏ qua.`);
        continue;
      }
      const padding = Number.isFinite(Number(op.style.padding)) ? Math.max(0, Number(op.style.padding)) : DEFAULT_PADDING;
      const color = normalizeColor(op.style.color);
      const align = ['left', 'center', 'right'].includes(op.style.align) ? op.style.align : 'center';
      const bold = op.style.bold === true;

      // (2a) Chỉ xoá: tô lại vùng bằng màu nền ước lượng từ viền ngoài hộp.
      if (op.action === 'erase') {
        const background = estimateBackground(pixels, box, dims);
        const erased = eraseBox(pixels, box, background, dims);
        if (!erased) {
          skipped.push({ region_id: op.region_id, reason: 'BAD_BOX' });
          continue;
        }
        applied.push({ region_id: op.region_id, action: 'erase', box: erased });
        continue;
      }

      // (2b) Có vẽ chữ: kiểm glyph TRƯỚC khi xoá — thiếu glyph thì giữ nguyên chữ gốc.
      const missing = [];
      for (const char of Array.from(op.text)) {
        if (!char.trim()) continue;
        if (!font.hasGlyph(char) && !missing.includes(char)) missing.push(char);
      }
      if (missing.length > 0) {
        for (const char of missing) if (!unsupported.includes(char)) unsupported.push(char);
        skipped.push({ region_id: op.region_id, reason: 'NO_GLYPH' });
        warnings.push(
          `Vùng ${op.region_id}: thiếu glyph cho "${missing.join(' ')}" — KHÔNG xoá và KHÔNG vẽ, giữ nguyên chữ gốc.`,
        );
        continue;
      }

      const layout = layoutText({
        text: op.text,
        box,
        font,
        options: {
          padding,
          align,
          bold,
          fontScale: options.fontScale ?? this.limits.fontScale,
          ...(options.minFontSize !== undefined ? { minFontSize: options.minFontSize } : {}),
          ...(options.maxFontSize !== undefined ? { maxFontSize: options.maxFontSize } : {}),
          ...(options.lineHeight !== undefined ? { lineHeight: options.lineHeight } : {}),
          ...(options.lineGap !== undefined ? { lineGap: options.lineGap } : {}),
          ...(options.valign !== undefined ? { valign: options.valign } : {}),
        },
      });
      if (!layout.fits || layout.lines.length === 0) {
        const reason = layout.reason ?? 'TEXT_TOO_LONG';
        skipped.push({ region_id: op.region_id, reason });
        warnings.push(
          `Vùng ${op.region_id}: chữ không vừa hộp (${reason}) — KHÔNG xoá, giữ nguyên vùng ảnh gốc.`,
        );
        continue;
      }

      // (2c) Xoá rồi vẽ — chỉ trong ĐÚNG hộp của op này.
      if (op.action === 'erase_and_draw') {
        const background = estimateBackground(pixels, box, dims);
        eraseBox(pixels, box, background, dims);
      }
      const drawn = drawLayout(pixels, layout, {
        width: dims.width,
        height: dims.height,
        font,
        color,
        bold,
      });
      if (drawn.missing.length > 0) {
        // Không thể xảy ra (đã kiểm ở trên) — nếu có thì ghi vết, không im lặng.
        for (const char of drawn.missing) if (!unsupported.includes(char)) unsupported.push(char);
        warnings.push(`Vùng ${op.region_id}: glyph "${drawn.missing.join(' ')}" không vẽ được ở bước cuối.`);
      }
      applied.push({
        region_id: op.region_id,
        action: op.action,
        box,
        font_size: layout.font_size,
        lines: layout.lines.map((line) => line.text),
        text: op.text,
      });
    }

    // (3) Kết quả: không op nào áp dụng được → trả bản sao y nguyên byte gốc.
    const nothingApplied = applied.length === 0;
    let outBuffer;
    if (nothingApplied) {
      outBuffer = Buffer.from(buffer);
      if (ops.length > 0) warnings.push('Không op nào áp dụng được — ảnh giữ nguyên byte gốc.');
    } else {
      outBuffer = encodePng({ width: dims.width, height: dims.height, data: pixels, channels: 4 });
      if (outBuffer.length > this.limits.maxOutputBytes) {
        throw new RenderError(
          RENDER_CODES.RENDER_OUTPUT_TOO_LARGE,
          `Ảnh kết quả ${outBuffer.length} byte vượt giới hạn ${this.limits.maxOutputBytes} byte.`,
          { bytes: outBuffer.length, maxOutputBytes: this.limits.maxOutputBytes },
        );
      }
    }

    return {
      status: skipped.length > 0 || unsupported.length > 0 ? RENDER_STATUS.PARTIAL : RENDER_STATUS.OK,
      output: {
        buffer: outBuffer,
        mime: 'image/png',
        width: dims.width,
        height: dims.height,
        sha256: sha256(outBuffer),
      },
      applied,
      skipped,
      unsupported_glyphs: unsupported,
      warnings,
    };
  }

  /** Dò kích thước: dùng header cục bộ (không tốn mạng). */
  async probe(params = {}) {
    const local = await super.probe(params);
    if (local) return local;
    const info = probeImage(params?.buffer);
    return info ? { width: info.width, height: info.height } : null;
  }
}

export default PureJsRenderProvider;
