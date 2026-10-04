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
  AMBIGUOUS_DIRTY_RATIO_MAX,
  DIRTY_DEEP_MIN_DISTANCE,
  DIRTY_INSIDE_BBOX_TOLERANCE,
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
    // Ba dấu hiệu NGUY HIỂM (M03-01b) — giữ nguyên ngưỡng đã ghi trong hợp đồng §3.1.
    const tooLittleKept = coverage < SUSPICIOUS_COVERAGE_MIN;
    const tinyKeptIsland = backgroundRatio > SUSPICIOUS_BACKGROUND_RATIO && keptBoxRatio < SUSPICIOUS_KEPT_BBOX_RATIO;

    // ── PHÂN LOẠI (N1, vòng 9): NGUY HIỂM vs NHẬP NHẰNG vs ĐẠT ────────────────
    // Trước đây cả hai bị gộp vào `SUSPICIOUS_MASK` ⇒ ảnh có bóng đổ mềm (mask ĐÚNG) bị tố
    // là "nghi ngờ ăn mất sản phẩm" — sai nguyên nhân và chặn oan ảnh bình thường.
    //   · NGUY HIỂM (đã ăn mất thứ gì đó): tỉ lệ nền ngoài khoảng an toàn, giữ lại < 2%,
    //     "đảo nhỏ" giữa nền lớn, hoặc DIỆN TÍCH NỀN BẨN > 15% (ăn mất một mảng không-phải-nền);
    //   · NHẬP NHẰNG (mask bao đúng sản phẩm, chỉ mờ ở viền): có pixel nền bẩn nhưng ít
    //     (bóng đổ/viền mờ) ⇒ không ghép nền mặc định, VẪN cho retouch.
    // N7 (vòng 10): đo theo VÙNG GIỮ LẠI (không phải toàn khung) + tín hiệu "khoét sâu vào
    // giữa hộp bao sản phẩm". Ăn hết một sản phẩm nhỏ trên khung lớn ⇒ tỉ lệ theo vùng giữ ≫ 1.
    const dirtyAreaFrame = Number(boundary.dirty_removed_ratio ?? 0);
    const dirtyRatioKept = Number(boundary.dirty_ratio_kept ?? 0);
    const dirtyInsideBbox = Number(boundary.dirty_inside_bbox ?? 0);
    const dirtyInsideRatio = Number(boundary.dirty_inside_bbox_ratio ?? 0);
    const tooDirtyRemoved = dirtyRatioKept > AMBIGUOUS_DIRTY_RATIO_MAX;
    // "Khoét vào giữa sản phẩm" cũng so theo VÙNG GIỮ LẠI (không phải số tuyệt đối): dải bóng
    // đổ luôn có vài chục pixel lọt vào góc lõm của hộp bao, còn cắt vào giữa sản phẩm thì
    // khối lượng bẩn bên trong hộp bao lớn hơn hẳn phần giữ lại.
    const cutIntoProduct = dirtyInsideBbox > DIRTY_INSIDE_BBOX_TOLERANCE
      && dirtyInsideRatio > AMBIGUOUS_DIRTY_RATIO_MAX;
    const boundaryFuzzy =
      boundary.count > 0 && boundary.over_ratio > BOUNDARY_OVER_RATIO_MAX;

    const dangerReasons = [];
    if (tooLittleKept) {
      dangerReasons.push(
        `GIỮ LẠI QUÁ ÍT: chỉ ${(coverage * 100).toFixed(2)}% pixel được giữ (ngưỡng ${(SUSPICIOUS_COVERAGE_MIN * 100).toFixed(0)}%)`,
      );
    }
    if (tinyKeptIsland) {
      dangerReasons.push(
        `VÙNG GIỮ LẠI QUÁ NHỎ SO VỚI NỀN: hộp bao phần giữ lại chỉ chiếm ${(keptBoxRatio * 100).toFixed(2)}% khung ảnh ` +
          `(ngưỡng ${(SUSPICIOUS_KEPT_BBOX_RATIO * 100).toFixed(0)}%) trong khi nền đã tách ${(backgroundRatio * 100).toFixed(1)}%`,
      );
    }
    if (tooDirtyRemoved) {
      dangerReasons.push(
        `NỀN ĐÃ TÁCH KHÔNG SẠCH: ${boundary.dirty_removed} pixel bị coi là nền mà lệch màu nền quá ` +
          `${boundary.safe_delta}/255 = ${(dirtyRatioKept * 100).toFixed(1)}% DIỆN TÍCH VÙNG GIỮ LẠI ` +
          `(ngưỡng ${(AMBIGUOUS_DIRTY_RATIO_MAX * 100).toFixed(0)}%; ${(dirtyAreaFrame * 100).toFixed(2)}% khung ảnh) — nhiều khả năng đã ăn mất một phần sản phẩm`,
      );
    }
    if (cutIntoProduct) {
      dangerReasons.push(
        `CẮT SÂU VÀO SẢN PHẨM: ${dirtyInsideBbox} pixel bị coi là nền nằm SÂU BÊN TRONG hộp bao vùng giữ ` +
          `(${keptBoxRaw ? `${keptBoxRaw.w}×${keptBoxRaw.h} tại (${keptBoxRaw.x}, ${keptBoxRaw.y})` : 'không có hộp bao'}), ` +
          `cách vùng giữ ≥ ${DIRTY_DEEP_MIN_DISTANCE} px = ${(dirtyInsideRatio * 100).toFixed(1)}% diện tích vùng giữ lại — ` +
          'flood fill đã khoét vào giữa sản phẩm',
      );
    }

    const ambiguousReasons = [];
    if (boundaryFuzzy) {
      ambiguousReasons.push(
        `${(boundary.over_ratio * 100).toFixed(1)}% pixel nền nằm sát vùng giữ lại lệch màu nền trong dải ` +
          `${boundary.safe_delta}–${tol.tolerance.toFixed(1)}/255 (Δmax ${boundary.max}, Δp95 ${boundary.p95}) — thường là bóng đổ mềm/viền mờ`,
      );
    }
    // N8 (vòng 10): điều kiện dùng SỐ NGUYÊN `dirty_removed > 0` — không phụ thuộc tỉ lệ đã
    // làm tròn, nên trên khung 16 MP chỉ ~700 pixel bẩn vẫn kích hoạt (không còn lọt thành OK).
    if (boundary.dirty_removed > 0) {
      ambiguousReasons.push(
        `${boundary.dirty_removed} pixel bị coi là nền nhưng lệch màu nền quá ${boundary.safe_delta}/255 ` +
          `(${(dirtyRatioKept * 100).toFixed(1)}% diện tích vùng giữ lại, ${(dirtyAreaFrame * 100).toFixed(2)}% khung ảnh) — ` +
          'nằm SÁT vùng giữ lại (nghi bóng đổ mềm/viền mờ), KHÔNG có pixel bẩn nào nằm sâu trong hộp bao',
      );
    }
    // Viền sản phẩm nằm trong dải gần màu nền (sản phẩm trắng/kem 244–248) KHÔNG phải lý do
    // để chặn: phía NỀN vẫn sạch (không pixel nền bẩn) nghĩa là flood fill đã giữ ĐÚNG sản
    // phẩm — chỉ là viền của nó gần màu nền. Ghi nhận để người dùng kiểm, KHÔNG hạ trạng thái.
    if (boundary.kept_under_ratio > BOUNDARY_OVER_RATIO_MAX) {
      warnings.push(
        `Lưu ý: ${(boundary.kept_under_ratio * 100).toFixed(1)}% pixel ĐƯỢC GIỮ LẠI nằm sát nền mà chỉ khác nền dưới ` +
          `${boundary.decisive_delta}/255 (Δmin ${boundary.kept_min}) — sản phẩm/vùng sáng gần màu nền; ` +
          'hãy kiểm ảnh TRƯỚC|SAU kỹ ở viền sản phẩm.',
      );
    }

    // CHỈ coi là nhập nhằng khi phía NỀN có dấu hiệu bẩn (đã ăn vào dải lưng chừng). Nếu phía
    // nền sạch mà chỉ viền sản phẩm gần màu nền ⇒ mask ĐÚNG ⇒ để ĐẠT (có ghi lưu ý ở trên).
    const ambiguous = dangerReasons.length === 0 && ambiguousReasons.length > 0;
    const allowAmbiguous = options.matting_allow_ambiguous === true
      || options.mattingAllowAmbiguous === true
      || options.allowAmbiguous === true
      || options.allow_ambiguous === true;

    if (dangerReasons.length > 0) {
      const message =
        `TỪ CHỐI kết quả tách nền (nghi ngờ ĂN MẤT SẢN PHẨM): ${dangerReasons.join('; ')}. ` +
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
          boundary_checked: true,
        },
        kept_bbox: null,
        warnings: [...warnings, message],
        error_code: MATTING_CODES.SUSPICIOUS_MASK,
        error_message: message,
      };
    }

    if (ambiguous && !allowAmbiguous) {
      // N7b (vòng 10): CHỈ nói điều ĐO ĐƯỢC. Không được khẳng định "sản phẩm vẫn được giữ
      // nguyên" — máy chỉ đo được số liệu tổng hợp, không biết chắc pixel nào là sản phẩm.
      const message =
        `CHƯA ĐỦ CHẮC để tách nền an toàn: đo được ${boundary.dirty_removed} pixel có thể thuộc sản phẩm ` +
        `ở sát/trong vùng giữ (${(dirtyRatioKept * 100).toFixed(1)}% diện tích vùng giữ lại; ` +
        `${(dirtyAreaFrame * 100).toFixed(2)}% khung ảnh). KHÔNG ghép nền. ` +
        `Số đo: coverage ${coverage}, background_ratio ${backgroundRatio}, kept_bbox ` +
        `${keptBoxRaw ? `${keptBoxRaw.w}×${keptBoxRaw.h} tại (${keptBoxRaw.x}, ${keptBoxRaw.y})` : 'null'}, ` +
        `dirty_removed ${boundary.dirty_removed}, dirty_inside_bbox ${dirtyInsideBbox}. ` +
        'Ảnh của bạn vẫn được RETOUCH theo tham số; hãy mở ảnh TRƯỚC|SAU để kiểm, hoặc dùng ảnh có nền phẳng hơn. ' +
        'Nếu vẫn muốn ghép nền cho lượt này: bật "vẫn ghép nền dù biên nhập nhằng" (matting_allow_ambiguous = true — có ghi vết).';
      return {
        status: MATTING_STATUS.SEGMENTATION_AMBIGUOUS,
        output: null,
        mask: {
          coverage,
          background_ratio: backgroundRatio,
          uniformity,
          seed_colors: stats.seed_colors,
          kept_bbox_ratio: keptBoxRatio,
          boundary_delta: boundary,
          boundary_checked: true,
        },
        // Dùng hộp bao TRƯỚC khi kẹp biên (biến `keptBox` chỉ được tính ở bước (7)) — vẫn là
        // số đo thật, và `clampBox` là hàm dùng chung của imagelab nên không lệch luật.
        kept_bbox: clampBox(keptBoxRaw, dims),
        warnings: [...warnings, message],
        error_code: MATTING_CODES.SEGMENTATION_AMBIGUOUS,
        error_message: message,
      };
    }

    if (ambiguous && allowAmbiguous) {
      warnings.push(
        `⚠️ ĐÃ BỎ QUA cảnh báo BIÊN NHẬP NHẰNG theo yêu cầu người dùng (matting_allow_ambiguous = true) — ` +
          `vẫn ghép nền. Căn cứ đã bỏ qua: ${ambiguousReasons.join('; ')}. HÃY KIỂM ẢNH TRƯỚC|SAU.`,
      );
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
        boundary_checked: true,
        ...(ambiguous && allowAmbiguous ? { ambiguous_override: true } : {}),
      },
      kept_bbox: keptBox,
      warnings,
    };
  }

}

export default PureJsMattingProvider;
