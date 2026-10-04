/**
 * Provider `purejs` — tách nền THẬT, chạy offline, chỉ với PNG (hợp đồng §3.1, E1).
 *
 * Luồng: kiểm magic bytes → `decodePng` → RGBA (bản sao) → đo độ đồng nhất của VIỀN
 * → flood fill 4 hướng từ viền theo khoảng cách màu → đặt alpha = 0 cho vùng nền
 * → `encodePng`. Buffer ảnh vào KHÔNG bao giờ bị ghi đè.
 *
 * Fail-closed (thà từ chối còn hơn cắt bừa):
 *   − Không phải PNG (JPEG/WebP/GIF/không nhận dạng được) ⇒ `UNSUPPORTED_IMAGE`.
 *   − Nền không đồng nhất (`uniformity < minUniformity`, mặc định 0.75) ⇒
 *     `UNIFORM_BACKGROUND_NOT_FOUND`, `output = null`, kèm SỐ ĐO THẬT.
 *   − Nền tách được < 5% hoặc > 98% ⇒ `FAILED` + `SUSPICIOUS_MASK` (ảnh gần như
 *     toàn nền, hoặc gần như không tách được gì), `output = null`.
 */

import { Buffer } from 'node:buffer';
import { MattingProvider } from '../provider.js';
import { MattingError, MATTING_CODES, MATTING_UNSUPPORTED_CODES } from '../errors.js';
import { BACKGROUND_RATIO_BOUNDS, MATTING_STATUS } from '../result.js';

/**
 * Ngưỡng NGHI NGỜ của M03-01b (vòng 8) — ghi rõ trong hợp đồng §3.1:
 *   - `SUSPICIOUS_COVERAGE_MIN = 0.02`: giữ lại dưới 2% ảnh ⇒ gần như đã xoá sạch sản phẩm;
 *   - `SUSPICIOUS_BACKGROUND_RATIO = 0.80` + `SUSPICIOUS_KEPT_BBOX_RATIO = 0.10`: nền đã tách
 *     > 80% mà hộp bao phần giữ lại < 10% khung ⇒ dấu hiệu "chỉ còn logo sống sót".
 * Vì sao chọn các số này: ảnh TMĐT thật có sản phẩm chiếm ≥ 10% khung; dưới ngưỡng đó thì
 * thà trả ảnh chỉ-retouch (luật #3 fail-closed) còn hơn giao ảnh mất sản phẩm.
 */
export const SUSPICIOUS_COVERAGE_MIN = 0.02;
export const SUSPICIOUS_BACKGROUND_RATIO = 0.8;
export const SUSPICIOUS_KEPT_BBOX_RATIO = 0.1;
import { clampBox, detectImageMime, toRgba } from '../../../imagelab/render/image.js';
import { decodePng, encodePng, sha256 } from '../../../imagelab/render/png.js';
import {
  BOUNDARY_OVER_RATIO_MAX,
  DEFAULT_TOLERANCE,
  applyAlphaMask,
  buildSimilarityMap,
  floodFillFromBorder,
  keptBoundingBox,
  measureBorderUniformity,
  measureBoundaryDelta,
  normalizeMinUniformity,
  normalizeTolerance,
} from '../background.js';

export class PureJsMattingProvider extends MattingProvider {
  #defaults;

  constructor({ model = 'purejs/floodfill-border', limits, logger, tolerance, minUniformity, connectivity, borderWidth } = {}) {
    super({ name: 'purejs', model, isMock: false, configured: true, limits, logger });
    this.#defaults = {
      tolerance,
      minUniformity,
      connectivity: Number(connectivity) === 8 ? 8 : 4,
      borderWidth: Number.isFinite(Number(borderWidth)) && Number(borderWidth) >= 1 ? Math.floor(Number(borderWidth)) : 1,
    };
  }

  async removeBackgroundImpl({ image, options }) {
    const buffer = image.buffer;
    const warnings = [];

    // (1) Chỉ nhận PNG — định dạng khác thì NÓI THẲNG, không đoán, không cắt bừa.
    const mime = detectImageMime(buffer) ?? image.mime ?? null;
    if (mime !== 'image/png') {
      throw new MattingError(
        MATTING_CODES.UNSUPPORTED_IMAGE,
        `Provider "purejs" chỉ tách nền được PNG (nhận ${mime ?? 'không nhận dạng được định dạng'}). ` +
          'Ảnh JPEG/WebP/GIF cần cắm provider "http" (MATTING_PROVIDER=http) — không đoán để tránh cắt bừa.',
        { mime },
      );
    }

    // (2) Giải mã PNG (chặn bom nén / ảnh khổng lồ TRƯỚC khi cấp phát pixel).
    let decoded;
    try {
      decoded = decodePng(buffer, { maxPixels: this.limits.maxPixels, maxBytes: this.limits.maxInputBytes });
    } catch (err) {
      const code = MATTING_UNSUPPORTED_CODES.has(err?.code) ? err.code : MATTING_CODES.MATTING_FAILED;
      throw new MattingError(code, `Không giải mã được PNG để tách nền: ${err?.message ?? 'lỗi không rõ'}`, {
        cause: err?.code ?? null,
      });
    }
    const dims = { width: decoded.width, height: decoded.height, channels: 4 };
    const pixels = toRgba(decoded); // buffer MỚI — không dính tới buffer ảnh vào

    // (3) Tham số: options ưu tiên hơn cấu hình provider; giá trị lạ ⇒ dùng mặc định + cảnh báo.
    const tol = normalizeTolerance(options.tolerance ?? this.#defaults.tolerance, DEFAULT_TOLERANCE);
    if (tol.invalid) {
      warnings.push(
        `Ngưỡng màu khai không hợp lệ ⇒ dùng mặc định ${DEFAULT_TOLERANCE}/255 (không tự nới ngưỡng).`,
      );
    }
    const minUniformity = normalizeMinUniformity(options.minUniformity ?? this.#defaults.minUniformity);
    const connectivity = Number.isFinite(Number(options.connectivity))
      ? (Number(options.connectivity) === 8 ? 8 : 4)
      : this.#defaults.connectivity;
    const borderWidth = Number.isFinite(Number(options.borderWidth))
      ? Math.max(1, Math.floor(Number(options.borderWidth)))
      : this.#defaults.borderWidth;

    // (4) Đo độ ĐỒNG NHẤT của viền TRƯỚC khi loang — không đồng nhất thì dừng ngay.
    const stats = measureBorderUniformity(pixels, { width: dims.width, height: dims.height, tolerance: tol.tolerance, borderWidth });
    const dominantLabel = `rgb(${stats.dominant.r}, ${stats.dominant.g}, ${stats.dominant.b})`;
    const uniformity = Number(stats.uniformity.toFixed(4));

    warnings.push(
      `Đo viền (${borderWidth}px, ${stats.border_pixels} pixel): màu chủ đạo ${dominantLabel}, ` +
        `${(uniformity * 100).toFixed(1)}% pixel viền nằm trong cụm màu này, ${stats.seed_colors} cụm màu trên viền.`,
    );
    if (tol.normalized) {
      warnings.push(`Ngưỡng màu được khai theo tỉ lệ chuẩn hoá ⇒ dùng ${tol.tolerance.toFixed(1)}/255 (Euclid RGB).`);
    }

    if (uniformity < minUniformity) {
      const message =
        `Nền KHÔNG đồng nhất: chỉ ${(uniformity * 100).toFixed(1)}% pixel viền thuộc cụm màu chủ đạo ${dominantLabel} ` +
        `(cần ≥ ${(minUniformity * 100).toFixed(1)}%), viền có ${stats.seed_colors} cụm màu. ` +
        'TỪ CHỐI tách nền (fail-closed) — ảnh gốc giữ nguyên, không cắt bừa.';
      return {
        status: MATTING_STATUS.UNIFORM_BACKGROUND_NOT_FOUND,
        output: null,
        mask: { coverage: null, background_ratio: null, uniformity, seed_colors: stats.seed_colors },
        kept_bbox: null,
        warnings: [...warnings, message],
        error_code: MATTING_CODES.UNIFORM_BACKGROUND_NOT_FOUND,
        error_message: message,
      };
    }

    // (5) Loang từ viền: 4 hướng (mặc định, chặt) hoặc 8 hướng (nới lỏng, phải khai rõ).
    const similar = buildSimilarityMap(pixels, {
      width: dims.width,
      height: dims.height,
      tolerance: tol.tolerance,
      target: stats.dominant,
    });
    const filled = floodFillFromBorder(similar, { width: dims.width, height: dims.height, connectivity });
    const total = dims.width * dims.height;
    const backgroundRatio = Number((filled / total).toFixed(4));
    const coverage = Number((1 - filled / total).toFixed(4));

    if (backgroundRatio < BACKGROUND_RATIO_BOUNDS.min || backgroundRatio > BACKGROUND_RATIO_BOUNDS.max) {
      const message =
        `Vùng nền loang được chiếm ${(backgroundRatio * 100).toFixed(1)}% ảnh — nằm ngoài khoảng an toàn ` +
        `[${BACKGROUND_RATIO_BOUNDS.min * 100}%, ${BACKGROUND_RATIO_BOUNDS.max * 100}%] ` +
        (backgroundRatio > BACKGROUND_RATIO_BOUNDS.max
          ? '(gần như TOÀN BỘ ảnh bị coi là nền ⇒ có thể đã ăn mất sản phẩm)'
          : '(gần như KHÔNG tách được pixel nền nào)') +
        '. TỪ CHỐI kết quả, ảnh gốc giữ nguyên.';
      return {
        status: MATTING_STATUS.FAILED,
        output: null,
        mask: { coverage, background_ratio: backgroundRatio, uniformity, seed_colors: stats.seed_colors },
        kept_bbox: null,
        warnings: [...warnings, message],
        error_code: MATTING_CODES.SUSPICIOUS_MASK,
        error_message: message,
      };
    }

    // (5b) SOI BIÊN vùng đã tách (M03-01a) + TRẦN "GIỮ LẠI QUÁ NHỎ" (M03-01b).
    // Đây là lưới chặn cho đúng lớp lỗi "sản phẩm gần màu nền bị ăn": tolerance thấp đã
    // chặn phần lớn, nhưng vẫn còn vùng mà đường cắt do pixel "lưng chừng" quyết định.
    const boundary = measureBoundaryDelta(pixels, similar, {
      width: dims.width,
      height: dims.height,
      target: stats.dominant,
    });
    const keptBoxRaw = keptBoundingBox(similar, dims);
    const keptBoxRatio = keptBoxRaw ? Number(((keptBoxRaw.w * keptBoxRaw.h) / total).toFixed(4)) : 0;

    const boundarySuspicious = boundary.suspicious === true;
    const tooLittleKept = coverage < SUSPICIOUS_COVERAGE_MIN;
    const tinyKeptIsland = backgroundRatio > SUSPICIOUS_BACKGROUND_RATIO && keptBoxRatio < SUSPICIOUS_KEPT_BBOX_RATIO;

    warnings.push(
      `Soi biên vùng đã tách: phía NỀN ${boundary.count} pixel kề sản phẩm (Δmax ${boundary.max}/255, Δp95 ${boundary.p95}/255, ` +
        `vượt ${boundary.safe_delta}/255: ${(boundary.over_ratio * 100).toFixed(1)}%); phía GIỮ LẠI ${boundary.kept_count} pixel kề nền ` +
        `(Δmin ${boundary.kept_min}/255, dưới ngưỡng dứt khoát ${boundary.decisive_delta}/255: ${(boundary.kept_under_ratio * 100).toFixed(1)}%).`,
    );

    if (boundarySuspicious || tooLittleKept || tinyKeptIsland) {
      const reasons = [];
      if (boundarySuspicious) {
        const parts = [];
        if (boundary.over_ratio > BOUNDARY_OVER_RATIO_MAX) {
          parts.push(
            `${(boundary.over_ratio * 100).toFixed(1)}% pixel nền sát sản phẩm lệch màu nền quá ${boundary.safe_delta}/255 ` +
              `(Δmax ${boundary.max}, Δp95 ${boundary.p95})`,
          );
        }
        if (boundary.kept_under_ratio > BOUNDARY_OVER_RATIO_MAX) {
          parts.push(
            `${(boundary.kept_under_ratio * 100).toFixed(1)}% pixel ĐƯỢC GIỮ LẠI nằm sát nền mà chỉ khác nền dưới ` +
              `${boundary.decisive_delta}/255 (Δmin ${boundary.kept_min}) — không phân biệt được sản phẩm với nền/bóng đổ`,
          );
        }
        reasons.push(`BIÊN KHÔNG DỨT KHOÁT: ${parts.join('; ')}`);
      }
      if (tooLittleKept) {
        reasons.push(
          `GIỮ LẠI QUÁ ÍT: chỉ ${(coverage * 100).toFixed(2)}% pixel được giữ (ngưỡng ${(SUSPICIOUS_COVERAGE_MIN * 100).toFixed(0)}%)`,
        );
      }
      if (tinyKeptIsland) {
        reasons.push(
          `VÙNG GIỮ LẠI QUÁ NHỎ SO VỚI NỀN: hộp bao phần giữ lại chỉ chiếm ${(keptBoxRatio * 100).toFixed(2)}% khung ảnh ` +
            `(ngưỡng ${(SUSPICIOUS_KEPT_BBOX_RATIO * 100).toFixed(0)}%) trong khi nền đã tách ${(backgroundRatio * 100).toFixed(1)}%`,
        );
      }
      const message =
        `TỪ CHỐI kết quả tách nền (nghi ngờ ăn mất sản phẩm): ${reasons.join('; ')}. ` +
        'Ảnh gốc giữ nguyên — không lưu ảnh đã cắt bừa (fail-closed, luật #3 của MVP-03).';
      return {
        status: MATTING_STATUS.FAILED,
        output: null,
        mask: {
          coverage,
          background_ratio: backgroundRatio,
          uniformity,
          seed_colors: stats.seed_colors,
          kept_bbox_ratio: keptBoxRatio,
          boundary_delta: boundary,
        },
        kept_bbox: null,
        warnings: [...warnings, message],
        error_code: MATTING_CODES.SUSPICIOUS_MASK,
        error_message: message,
      };
    }

    // (6) Ghi alpha = 0 cho vùng nền; pixel giữ lại y nguyên (không đổi màu sản phẩm).
    const outPixels = applyAlphaMask(pixels, similar, dims);
    const outBuffer = encodePng({ width: dims.width, height: dims.height, data: outPixels, channels: 4 });
    if (outBuffer.length > this.limits.maxOutputBytes) {
      throw new MattingError(
        MATTING_CODES.MATTING_OUTPUT_TOO_LARGE,
        `Ảnh tách nền ${outBuffer.length} byte vượt giới hạn ${this.limits.maxOutputBytes} byte.`,
        { bytes: outBuffer.length },
      );
    }

    // (7) Hộp bao phần GIỮ LẠI — kẹp vào biên ảnh bằng `clampBox` dùng chung của imagelab.
    const keptBox = clampBox(keptBoundingBox(similar, dims), dims);

    warnings.push(
      `Đã tách nền bằng flood fill ${connectivity} hướng từ viền (ngưỡng màu ${tol.tolerance.toFixed(1)}/255, Euclid RGB): ` +
        `nền ${(backgroundRatio * 100).toFixed(1)}% pixel đã đặt alpha = 0, sản phẩm giữ lại ${(coverage * 100).toFixed(1)}%.`,
    );
    if (keptBox) {
      warnings.push(`Hộp bao phần giữ lại: ${keptBox.w}×${keptBox.h} tại (${keptBox.x}, ${keptBox.y}) trong khung ${dims.width}×${dims.height}.`);
    }
    // M03-01c (vòng 8): KHÔNG khẳng định "pixel sản phẩm giữ nguyên" — vùng "sản phẩm" do
    // MÁY ĐOÁN theo màu nền; chỉ được nói điều ĐO ĐƯỢC: pixel NGOÀI vùng đã tách không đổi.
    warnings.push(
      'Pixel NGOÀI vùng đã tách giữ nguyên từng byte; vùng đã tách do máy đoán theo màu nền — ' +
        'hãy mở ảnh TRƯỚC|SAU để kiểm.',
    );
    if (connectivity === 8) {
      warnings.push('Đang dùng loang 8 hướng (nới lỏng hơn 4 hướng) — nền có thể loang qua góc chéo.');
    }

    return {
      status: MATTING_STATUS.OK,
      output: {
        buffer: outBuffer,
        mime: 'image/png',
        width: dims.width,
        height: dims.height,
        sha256: sha256(outBuffer),
      },
      // M03-01a: SỐ ĐO THẬT của vùng biên luôn được trả ra (kể cả khi đạt) để người dùng
      // và phản biện đọc được căn cứ, không phải tin vào kết luận suông.
      mask: {
        coverage,
        background_ratio: backgroundRatio,
        uniformity,
        seed_colors: stats.seed_colors,
        kept_bbox_ratio: keptBoxRatio,
        boundary_delta: boundary,
      },
      kept_bbox: keptBox,
      warnings,
    };
  }

}

export default PureJsMattingProvider;
