/**
 * Provider `purejs` — retouch THẬT, chạy offline, chỉ với PNG (hợp đồng §3.4, E1).
 *
 * Luồng: kiểm magic bytes → `decodePng` → RGBA (bản sao) → áp 4 phép trong ngưỡng
 * (brightness/contrast/saturation/sharpen, xem `pixels.js`) → tự kiểm kênh alpha
 * KHÔNG đổi → `encodePng`.
 *
 * Fail-closed:
 *   − Không phải PNG (JPEG/WebP/GIF/không nhận dạng) ⇒ `UNSUPPORTED_IMAGE`
 *     (retouch tại chỗ cần đọc/ghi pixel; ảnh không giải mã được thì KHÔNG đoán).
 *   − Thuật toán lỡ đổi kênh alpha (điều cấm của §3.4) ⇒ TỪ CHỐI kết quả, không trả ảnh.
 *   − Không pixel nào đổi thật (tham số quá nhỏ) ⇒ `NO_CHANGES`, không báo OK.
 */

import { RetouchProvider } from '../provider.js';
import { RetouchError, RETOUCH_CODES, RETOUCH_UNSUPPORTED_CODES } from '../errors.js';
import { RETOUCH_STATUS } from '../result.js';
import { detectImageMime, toRgba } from '../../../imagelab/render/image.js';
import { decodePng, encodePng, sha256 } from '../../../imagelab/render/png.js';
import { applyRetouch } from '../pixels.js';
import { RETOUCH_PARAM_NAMES } from '../limits.js';

export class PureJsRetouchProvider extends RetouchProvider {
  constructor({ model = 'purejs/lut+3x3', limits, retouchLimits, logger } = {}) {
    super({ name: 'purejs', model, isMock: false, configured: true, limits, retouchLimits, logger });
  }

  async applyImpl({ image, params }) {
    const buffer = image.buffer;

    // (1) Chỉ nhận PNG — định dạng khác thì nói thẳng.
    const mime = detectImageMime(buffer) ?? image.mime ?? null;
    if (mime !== 'image/png') {
      throw new RetouchError(
        RETOUCH_CODES.UNSUPPORTED_IMAGE,
        `Provider "purejs" chỉ retouch được PNG (nhận ${mime ?? 'không nhận dạng được định dạng'}) — ` +
          'JPEG/WebP/GIF không giải mã được nên KHÔNG đoán pixel.',
        { mime },
      );
    }

    // (2) Giải mã (chặn bom nén / ảnh khổng lồ TRƯỚC khi cấp phát pixel).
    let decoded;
    try {
      decoded = decodePng(buffer, { maxPixels: this.limits.maxPixels, maxBytes: this.limits.maxInputBytes });
    } catch (err) {
      const code = RETOUCH_UNSUPPORTED_CODES.has(err?.code) ? err.code : RETOUCH_CODES.RETOUCH_FAILED;
      throw new RetouchError(code, `Không giải mã được PNG để retouch: ${err?.message ?? 'lỗi không rõ'}`, {
        cause: err?.code ?? null,
      });
    }
    const dims = { width: decoded.width, height: decoded.height, channels: 4 };
    const pixels = toRgba(decoded); // buffer MỚI — không dính tới buffer ảnh vào
    // Chỉ giữ kênh alpha (1 byte/pixel, nhẹ hơn copy cả RGBA) để đối chiếu sau khi retouch.
    const originalAlpha = new Uint8Array(dims.width * dims.height);
    for (let i = 0; i < originalAlpha.length; i += 1) originalAlpha[i] = pixels[i * 4 + 3];

    // (3) Chạy 4 phép (params đã được lớp cơ sở KẸP vào ngưỡng).
    const { changed_pixels: changedPixels, ops_applied: opsApplied } = applyRetouch(pixels, dims, params);
    const warnings = [];

    // (4) Bất biến §3.4: kênh alpha KHÔNG được đổi (nền đã tách phải giữ alpha = 0).
    let alphaChanged = 0;
    for (let i = 0; i < dims.width * dims.height; i += 1) {
      if (originalAlpha[i] !== pixels[i * 4 + 3]) alphaChanged += 1;
    }
    if (alphaChanged > 0) {
      throw new RetouchError(
        RETOUCH_CODES.RETOUCH_FAILED,
        `Thuật toán retouch đã đổi kênh alpha ở ${alphaChanged} pixel — TỪ CHỐI kết quả (điều cấm của hợp đồng §3.4).`,
        { alpha_changed: alphaChanged },
      );
    }
    warnings.push(
      `Đã kiểm kênh alpha: 0/${dims.width * dims.height} pixel bị đổi alpha (nền đã tách giữ nguyên alpha = 0).`,
    );

    // (5) Không pixel nào đổi thật ⇒ NO_CHANGES (tham số quá nhỏ so với 8-bit).
    if (changedPixels === 0) {
      const detail = RETOUCH_PARAM_NAMES.filter((name) => params[name] !== 0)
        .map((name) => `${name} = ${params[name]}`)
        .join(', ');
      return {
        status: RETOUCH_STATUS.NO_CHANGES,
        output: null,
        error_code: RETOUCH_CODES.NO_CHANGES,
        warnings: [
          ...warnings,
          `Tham số (${detail}) quá nhỏ để đổi dù chỉ 1 pixel 8-bit ⇒ KHÔNG có gì thay đổi, không trả ảnh retouch.`,
        ],
      };
    }

    // (6) Mã hoá PNG và trả kết quả.
    const outBuffer = encodePng({ width: dims.width, height: dims.height, data: pixels, channels: 4 });
    if (outBuffer.length > this.limits.maxOutputBytes) {
      throw new RetouchError(
        RETOUCH_CODES.RETOUCH_OUTPUT_TOO_LARGE,
        `Ảnh retouch ${outBuffer.length} byte vượt giới hạn ${this.limits.maxOutputBytes} byte.`,
        { bytes: outBuffer.length },
      );
    }
    warnings.push(
      `Đã retouch ${opsApplied.length} phép (${opsApplied.join(', ')}): ${changedPixels}/${dims.width * dims.height} pixel đổi màu; ` +
        `kích thước giữ nguyên ${dims.width}×${dims.height}, không dịch pixel.`,
    );

    return {
      status: RETOUCH_STATUS.OK,
      output: {
        buffer: outBuffer,
        mime: 'image/png',
        width: dims.width,
        height: dims.height,
        sha256: sha256(outBuffer),
      },
      warnings,
    };
  }
}

export default PureJsRetouchProvider;
