/**
 * `composeImage` — GHÉP NỀN MÔ PHỎNG vào vùng trong suốt của mask (E2, hợp đồng 3.2).
 *
 * LUẬT BẤT KHẢ XÂM PHẠM (MVP-03 §0.1 + §3.2):
 *   1. Ảnh ra **CÙNG KÍCH THƯỚC** ảnh vào — không resize, không crop, không warp.
 *   2. Nền chỉ được vẽ vào pixel có `alpha === 0` của ảnh matting (mask > 0 = vùng GIỮ LẠI).
 *      Mọi pixel giữ lại phải **Y HỆT từng byte** ảnh matting.
 *   3. Không đủ tự tin (thiếu mask, mask hỏng, mask lệch kích thước) ⇒ KHÔNG ghép: trả về
 *      **bản sao ảnh vào** kèm `warnings` tiếng Việt và `background_ratio = 0`.
 *
 * Hàm THUẦN: không I/O, không mạng, không đọc file; không bao giờ sửa buffer đầu vào
 * (mọi buffer làm việc đều là bản sao do `decodePng`/`toRgba`/`Buffer.from` tạo ra).
 */

import { Buffer } from 'node:buffer';
import { decodePng, encodePng, probeImage, sha256, toRgba } from '../../imagelab/render/index.js';
import { detectImageMime } from '../../imagelab/render/image.js';
import { ComposeError, COMPOSE_CODES } from './errors.js';
import { readInputBuffer, readRawRgba } from './image-input.js';
import { resolveTemplate, writeTemplatePixel } from './templates.js';

/**
 * Câu cảnh báo CHUẨN khi không có mask nền — E1/E3/E5 soi đúng câu này.
 * Cố ý chứa NGUYÊN VĂN cụm "không có mask nền — không ghép nền" (chữ thường) như hợp đồng 3.2.
 */
export const NO_MASK_WARNING = 'Ảnh giữ nguyên vì không có mask nền — không ghép nền.';

/** Làm tròn tỉ lệ về 4 chữ số thập phân cho dễ so sánh/ghi log. */
const round4 = (value) => Math.round(value * 10000) / 10000;

/**
 * Đọc mask nền từ `MattingResult` của E1 (hợp đồng 3.1).
 *
 * Chỉ nhận PNG có kênh alpha: alpha === 0 là NỀN cần thay, alpha > 0 là vùng GIỮ LẠI.
 * Mọi trường hợp không đọc được đều trả `null` (fail-closed) kèm lý do tiếng Việt.
 *
 * @returns {{pixels:Buffer,width:number,height:number}|null}
 */
function readMask(matting, reasons) {
  if (!matting || typeof matting !== 'object') {
    reasons.push('Job không có kết quả tách nền (matting = null).');
    return null;
  }
  // M03-05 (vòng 8): CHỈ ghép khi matting `OK`. Trước đây hàm này chỉ GHI LÝ DO rồi vẫn đọc
  // mask nếu có buffer — mask của một lượt matting ĐÃ THẤT BẠI (hoặc provider tự khai FAILED
  // mà vẫn kèm ảnh) đi thẳng vào ảnh ra. Nay: mọi trạng thái khác `OK` ⇒ trả `null` NGAY
  // (passthrough + lý do), kể cả khi có buffer.
  const status = matting.status;
  if (typeof status === 'string' && status !== 'OK') {
    reasons.push(`Tách nền không thành công (matting.status = ${status}) — KHÔNG ghép nền.`);
    return null;
  }
  // Chấp nhận cả `matting.output.buffer` (hợp đồng 3.1) lẫn mask thô (`matting` chính là buffer).
  const raw = readInputBuffer(matting.output) ?? readInputBuffer(matting);
  if (raw && raw.length > 0) {
    let decoded;
    try {
      decoded = decodePng(raw);
    } catch (error) {
      reasons.push(
        `Mask nền không giải mã được dưới dạng PNG RGBA (${error?.code ?? 'PNG_ERROR'}) — chỉ hỗ trợ mask PNG.`,
      );
      return null;
    }
    if (!decoded.hasAlpha) {
      reasons.push('Mask nền không có kênh alpha (ảnh đục hoàn toàn) — không xác định được vùng nền.');
    }
    return { pixels: toRgba(decoded), width: decoded.width, height: decoded.height };
  }
  // Dự phòng: mask đã giải mã sẵn dưới dạng { data|pixels, width, height, channels }.
  const rawPixels = readRawRgba(matting.output) ?? readRawRgba(matting);
  if (rawPixels) return rawPixels;
  reasons.push('Kết quả tách nền không có buffer mask.');
  return null;
}

/** Dựng `ComposeResult` đúng hợp đồng 3.2 (buffer đã là bản sao của bên gọi). */
function buildResult({ buffer, mime, width, height, template, backgroundRatio, warnings, started }) {
  return {
    output: { buffer, mime, width, height, sha256: sha256(buffer) },
    template, // mẫu ĐÓNG BĂNG gốc: { id, label, kind, synthetic: true, colors }
    background_ratio: backgroundRatio,
    warnings,
    elapsed_ms: Date.now() - started,
  };
}

/** Ảnh vào được trả NGUYÊN BẢN (bản sao) — dùng cho mọi nhánh fail-closed. */
function passthroughResult({ imageBuffer, imageInfo, maskInfo, template, warnings, started }) {
  const buffer = Buffer.from(imageBuffer); // bản sao: người gọi sửa buffer trả về cũng không chạm ảnh gốc
  return buildResult({
    buffer,
    mime: imageInfo?.mime ?? detectImageMime(imageBuffer) ?? 'application/octet-stream',
    width: imageInfo?.width ?? maskInfo?.width ?? null,
    height: imageInfo?.height ?? maskInfo?.height ?? null,
    template,
    backgroundRatio: 0,
    warnings,
    started,
  });
}

/**
 * `composeImage({ image, matting, template, options })` → `ComposeResult`.
 *
 * @param {object} params
 * @param {{buffer:Buffer|Uint8Array,mime?:string}|Buffer|Uint8Array} params.image ảnh GỐC (bất biến)
 * @param {object} [params.matting] `MattingResult` của E1 (hợp đồng 3.1); thiếu/`output=null` ⇒ không ghép
 * @param {string|object} [params.template] id mẫu nền (mặc định `trang`); id lạ ⇒ `ComposeError`
 * @param {object} [params.options] `{ template? }` — dự phòng khi `template` không truyền trực tiếp
 * @returns {{output:{buffer:Buffer,mime:string,width:number|null,height:number|null,sha256:string},
 *            template:object, background_ratio:number, warnings:string[], elapsed_ms:number}}
 * @throws {ComposeError} BAD_INPUT khi thiếu buffer ảnh; TEMPLATE_NOT_FOUND khi id mẫu nền lạ
 */
export function composeImage({ image, matting, template, options } = {}) {
  const started = Date.now();
  const warnings = [];

  const imageBuffer = readInputBuffer(image);
  if (!imageBuffer || imageBuffer.length === 0) {
    throw new ComposeError(COMPOSE_CODES.BAD_INPUT, 'composeImage cần `image.buffer` là Buffer/Uint8Array không rỗng.');
  }
  const resolvedTemplate = resolveTemplate(template ?? options?.template);
  const imageInfo = probeImage(imageBuffer); // null nếu không đọc được header — không chặn ghép mask

  // (1) Không đủ tự tin ⇒ không ghép (fail-closed), trả bản sao ảnh vào.
  const reasons = [];
  const maskInfo = readMask(matting, reasons);
  if (!maskInfo) {
    warnings.push(NO_MASK_WARNING, ...reasons, 'Ảnh ra là bản sao y nguyên ảnh vào — không pixel nào bị đổi.');
    return passthroughResult({ imageBuffer, imageInfo, maskInfo: null, template: resolvedTemplate, warnings, started });
  }
  if (imageInfo && (imageInfo.width !== maskInfo.width || imageInfo.height !== maskInfo.height)) {
    warnings.push(
      `Mask nền lệch kích thước ảnh gốc (${maskInfo.width}x${maskInfo.height} ≠ ${imageInfo.width}x${imageInfo.height}) — KHÔNG ghép nền (luật 1: không resize/crop).`,
      'Ảnh ra là bản sao y nguyên ảnh vào — không pixel nào bị đổi.',
    );
    return passthroughResult({ imageBuffer, imageInfo, maskInfo, template: resolvedTemplate, warnings, started });
  }

  // (2) Ghép: nền MÔ PHỎNG chỉ ghi vào pixel alpha === 0; pixel NGOÀI vùng đã tách giữ
  //     nguyên từng byte. (Vùng "đã tách" là do MÁY đoán theo màu nền — xem cảnh báo bên dưới.)
  //
  // M03-05 (vòng 8): mask có alpha MỘT PHẦN (0 < alpha < 255) nghĩa là pixel sản phẩm sẽ ra
  // bán trong suốt. Vẫn ghép (dịch vụ matting thật hay trả alpha mềm) nhưng phải ĐO và NÓI RA.
  let partialAlpha = 0;
  for (let i = 3; i < maskInfo.pixels.length; i += 4) {
    const a = maskInfo.pixels[i];
    if (a !== 0 && a !== 255) partialAlpha += 1;
  }
  if (partialAlpha > 0) {
    warnings.push(
      `Mask nền có ${partialAlpha} pixel alpha MỘT PHẦN (0 < alpha < 255) — vùng đó sẽ ra bán trong suốt; ` +
        'hãy kiểm ảnh TRƯỚC|SAU (mask mềm thường đến từ dịch vụ tách nền ngoài).',
    );
  }

  const width = maskInfo.width;
  const height = maskInfo.height;
  const total = width * height;
  const pixels = Buffer.from(maskInfo.pixels); // bản sao — không sửa mask đầu vào
  let backgroundPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      if (pixels[offset + 3] !== 0) continue; // vùng GIỮ LẠI: bất khả xâm phạm
      writeTemplatePixel(pixels, offset, resolvedTemplate, x, y, width, height);
      backgroundPixels += 1;
    }
  }
  const backgroundRatio = total > 0 ? round4(backgroundPixels / total) : 0;

  if (backgroundPixels === 0) {
    warnings.push(
      'Mask nền không có pixel trong suốt (alpha = 0) — không có vùng nền nào để ghép.',
      'Ảnh ra là bản sao y nguyên ảnh vào — không pixel nào bị đổi.',
    );
    return passthroughResult({ imageBuffer, imageInfo, maskInfo, template: resolvedTemplate, warnings, started });
  }

  warnings.push(
    // M03-01c (vòng 8): KHÔNG khẳng định "pixel sản phẩm giữ nguyên" — vùng giữ lại do MÁY
    // đoán theo màu nền; chỉ nói điều ĐO ĐƯỢC (pixel NGOÀI vùng đã tách) và mời người dùng kiểm.
    `Đã ghép nền MÔ PHỎNG "${resolvedTemplate.label}" vào ${backgroundPixels}/${total} pixel nền (tỉ lệ ${backgroundRatio}); ` +
      'pixel NGOÀI vùng đã tách giữ nguyên từng byte — vùng đã tách do máy đoán theo màu nền, hãy mở ảnh TRƯỚC|SAU để kiểm.',
    'Nền do hệ thống sinh ra là MÔ PHỎNG (không phải ảnh thật).',
  );

  const buffer = encodePng({ width, height, data: pixels, channels: 4 });
  return buildResult({
    buffer,
    mime: 'image/png',
    width,
    height,
    template: resolvedTemplate,
    backgroundRatio,
    warnings,
    started,
  });
}

export default composeImage;
