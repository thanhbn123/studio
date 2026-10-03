/**
 * HẬU KIỂM ẢNH RENDER TRẢ VỀ — không tin lời khai của provider (N-5, vòng 4).
 *
 * Vì sao cần: với `RENDER_PROVIDER=http`, repo chỉ bảo đảm luật #3 ở phía YÊU CẦU (không
 * gửi op chồng hộp bảo vệ). Phía KẾT QUẢ thì trước đây không kiểm một pixel nào: một
 * service inpainting "vẽ lại cả ảnh" xoá mất logo mà hệ thống vẫn báo `OK`, `skipped` vẫn
 * nói "Vùng nhãn hiệu — không xoá". File này là hàng rào CUỐI: đo pixel thật.
 *
 * Luật:
 *  - Không có hộp bảo vệ nào ⇒ không có gì để kiểm (`verified = null`).
 *  - Ảnh trả về KHÔNG phải PNG ⇒ không giải mã được ⇒ `verified = false` (nói thẳng là
 *    KHÔNG kiểm chứng được, không được coi như đã kiểm).
 *  - PNG: so từng pixel trong các hộp bảo vệ với ảnh gốc.
 *      · khác kích thước ảnh ⇒ TỪ CHỐI (không thể chứng minh pixel còn nguyên);
 *      · có pixel đổi      ⇒ TỪ CHỐI;
 *      · không đổi         ⇒ `verified = true`.
 *
 * Thuần hàm, không đọc file/mạng.
 */

import { clampBox, detectImageMime, toRgba } from './image.js';
import { decodePng } from './png.js';

/** Lý do của kết quả hậu kiểm (máy đọc được). */
export const PROTECTED_CHECK = Object.freeze({
  OK: 'OK',
  NO_PROTECTED_BOXES: 'NO_PROTECTED_BOXES',
  OUTPUT_NOT_PNG: 'OUTPUT_NOT_PNG',
  OUTPUT_UNREADABLE: 'OUTPUT_UNREADABLE',
  SIZE_MISMATCH: 'SIZE_MISMATCH',
  PROTECTED_PIXELS_CHANGED: 'PROTECTED_PIXELS_CHANGED',
});

/** Đếm pixel khác nhau trong một hộp giữa hai ảnh RGBA cùng kích thước. */
function countChangedInBox(before, after, box, width) {
  let changed = 0;
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      const i = (y * width + x) * 4;
      if (before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2] || before[i + 3] !== after[i + 3]) {
        changed += 1;
      }
    }
  }
  return changed;
}

/**
 * SOI PIXEL ảnh render trả về (N-5 vòng 4 + N-8 vòng 5) — MỘT lần giải mã cho cả hai việc:
 *   1. hộp BẢO VỆ có bị đổi pixel không (luật #3);
 *   2. hộp của TỪNG op gửi đi có THỰC SỰ đổi pixel không (chống remote khai khống / chỉ
 *      decode-rồi-encode lại: ảnh khác byte nhưng y hệt pixel).
 *
 * @param {{originalBuffer: Buffer, outputBuffer: Buffer,
 *          protectedBoxes?: Array, opBoxes?: Array, maxPixels?: number}} params
 * @returns {{readable: boolean, reason: string, mime: string|null,
 *            protectedChanged: Array, opBoxesChanged: number, opBoxesTotal: number, detail?: string}}
 */
export function inspectRenderedPixels({ originalBuffer, outputBuffer, protectedBoxes = [], opBoxes = [], maxPixels } = {}) {
  const pBoxes = Array.isArray(protectedBoxes) ? protectedBoxes.filter(Boolean) : [];
  const oBoxes = Array.isArray(opBoxes) ? opBoxes.filter(Boolean) : [];
  const empty = {
    readable: false,
    reason: PROTECTED_CHECK.OUTPUT_UNREADABLE,
    mime: null,
    protectedChanged: [],
    opBoxesChanged: 0,
    opBoxesTotal: oBoxes.length,
  };
  if (!originalBuffer || !outputBuffer) return { ...empty, detail: 'thiếu buffer ảnh gốc hoặc ảnh trả về' };

  const mime = detectImageMime(outputBuffer);
  if (mime !== 'image/png') {
    return { ...empty, reason: PROTECTED_CHECK.OUTPUT_NOT_PNG, mime };
  }

  let before;
  let after;
  let decodedBefore;
  let decodedAfter;
  try {
    decodedBefore = decodePng(originalBuffer, { maxPixels });
    before = toRgba(decodedBefore);
  } catch (err) {
    return { ...empty, mime, detail: `không giải mã được ẢNH GỐC: ${String(err?.message ?? err).slice(0, 160)}` };
  }
  try {
    decodedAfter = decodePng(outputBuffer, { maxPixels });
    after = toRgba(decodedAfter);
  } catch (err) {
    return { ...empty, mime, detail: `không giải mã được ẢNH TRẢ VỀ: ${String(err?.message ?? err).slice(0, 160)}` };
  }

  if (decodedAfter.width !== decodedBefore.width || decodedAfter.height !== decodedBefore.height) {
    return {
      ...empty,
      mime,
      reason: PROTECTED_CHECK.SIZE_MISMATCH,
      detail: `ảnh trả về ${decodedAfter.width}×${decodedAfter.height} khác ảnh gốc ${decodedBefore.width}×${decodedBefore.height}`,
    };
  }

  const dims = { width: decodedAfter.width, height: decodedAfter.height };
  const protectedChanged = [];
  for (const raw of pBoxes) {
    const box = clampBox(raw, dims);
    if (!box) continue;
    const n = countChangedInBox(before, after, box, dims.width);
    if (n > 0) protectedChanged.push({ box, changed: n, total: box.w * box.h });
  }

  let opBoxesChanged = 0;
  for (const raw of oBoxes) {
    const box = clampBox(raw, dims);
    if (!box) continue;
    if (countChangedInBox(before, after, box, dims.width) > 0) opBoxesChanged += 1;
  }

  return {
    readable: true,
    reason: protectedChanged.length > 0 ? PROTECTED_CHECK.PROTECTED_PIXELS_CHANGED : PROTECTED_CHECK.OK,
    mime,
    protectedChanged,
    opBoxesChanged,
    opBoxesTotal: oBoxes.length,
  };
}

/**
 * Hậu kiểm HỘP BẢO VỆ (N-5 vòng 4) — giữ nguyên hình dạng kết quả cũ cho tương thích.
 * @param {{originalBuffer: Buffer, outputBuffer: Buffer, protectedBoxes: Array, maxPixels?: number}} params
 * @returns {{verified: boolean|null, reason: string, mime?: string|null, changed?: Array, detail?: string}}
 */
export function verifyProtectedPixels({ originalBuffer, outputBuffer, protectedBoxes = [], maxPixels } = {}) {
  const boxes = Array.isArray(protectedBoxes) ? protectedBoxes.filter(Boolean) : [];
  if (boxes.length === 0) {
    return { verified: null, reason: PROTECTED_CHECK.NO_PROTECTED_BOXES, changed: [] };
  }
  const scan = inspectRenderedPixels({ originalBuffer, outputBuffer, protectedBoxes: boxes, maxPixels });
  if (scan.reason === PROTECTED_CHECK.OK) {
    return { verified: true, reason: PROTECTED_CHECK.OK, mime: scan.mime, changed: [] };
  }
  return {
    verified: false,
    reason: scan.reason,
    mime: scan.mime ?? null,
    detail: scan.detail,
    changed: scan.protectedChanged,
  };
}

export default verifyProtectedPixels;
