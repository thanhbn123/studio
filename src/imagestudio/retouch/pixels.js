/**
 * PHÉP RETOUCH PIXEL của provider `purejs` (hợp đồng §3.4, E1).
 *
 * Bốn phép, ĐÚNG thứ tự này (ghi rõ để test/E3 không đoán):
 *   1. `brightness`  — hệ số nhân trên từng kênh màu: `v * (1 + brightness)` (giống CSS `brightness(1+b)`).
 *   2. `contrast`    — kéo quanh mốc 128: `(v - 128) * (1 + contrast) + 128`.
 *   3. `saturation`  — trộn với độ sáng luma: `luma + (v - luma) * (1 + saturation)`,
 *                      `luma = 0.299R + 0.587G + 0.114B` (chuẩn BT.601).
 *   4. `sharpen`     — kernel 3×3 NHẸ (unsharp bằng Laplacian):
 *                      `out = v + amount * (4v - trên - dưới - trái - phải)`, biên ảnh lặp cạnh.
 *
 * Bất biến (luật MVP-03):
 *   − KHÔNG đổi kích thước, KHÔNG dịch pixel (mọi phép chỉ đọc/ghi tại chỗ theo toạ độ).
 *   − KHÔNG bao giờ ghi vào kênh alpha. Pixel có alpha = 0 (nền đã tách) được giữ
 *     NGUYÊN cả RGB lẫn alpha ⇒ nền đã tách vẫn trong suốt sau retouch.
 *   − Cả 4 tham số = 0 ⇒ ảnh RA Y HỆT ảnh vào (không nhánh nào chạy).
 *   − Trong kernel sharpen, pixel hàng xóm trong suốt được coi như BẰNG pixel trung tâm
 *     (không kéo màu nền trắng vào viền sản phẩm ⇒ không tạo quầng sáng giả).
 */

import { Buffer } from 'node:buffer';

/** Luma BT.601 (0..255) — dùng cho phép bão hoà. */
function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

const clampByte = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/**
 * Bảng tra (LUT) gộp brightness + contrast cho từng giá trị kênh 0..255.
 * Hai phép này độc lập từng kênh nên gộp được — nhanh hơn tính lại mỗi pixel.
 * `brightness = contrast = 0` ⇒ LUT đồng nhất `lut[v] === v`.
 */
export function buildToneLut(brightness = 0, contrast = 0) {
  const b = Number.isFinite(brightness) ? brightness : 0;
  const c = Number.isFinite(contrast) ? contrast : 0;
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v += 1) {
    let x = v * (1 + b);
    x = (x - 128) * (1 + c) + 128;
    lut[v] = clampByte(x);
  }
  return lut;
}

/**
 * Áp LUT lên 3 kênh màu, BỎ QUA pixel trong suốt (alpha = 0) và không bao giờ chạm alpha.
 * @param {Uint8Array|null} flags mảng đánh dấu pixel đã đổi (1 byte/pixel) hoặc null
 */
export function applyToneLut(pixels, lut, { width, height }, flags = null) {
  const total = width * height;
  for (let i = 0; i < total; i += 1) {
    const p = i * 4;
    if (pixels[p + 3] === 0) continue;
    const r = lut[pixels[p]];
    const g = lut[pixels[p + 1]];
    const b = lut[pixels[p + 2]];
    if (r !== pixels[p] || g !== pixels[p + 1] || b !== pixels[p + 2]) {
      if (flags) flags[i] = 1;
    }
    pixels[p] = r;
    pixels[p + 1] = g;
    pixels[p + 2] = b;
  }
}

/**
 * Đổi độ bão hoà quanh luma. `amount > 0` = rực hơn, `< 0` = nhạt hơn (0 = không đổi).
 */
export function applySaturation(pixels, amount, { width, height }, flags = null) {
  if (!Number.isFinite(amount) || amount === 0) return;
  const total = width * height;
  for (let i = 0; i < total; i += 1) {
    const p = i * 4;
    if (pixels[p + 3] === 0) continue;
    const r = pixels[p];
    const g = pixels[p + 1];
    const b = pixels[p + 2];
    const l = luma(r, g, b);
    const nr = clampByte(l + (r - l) * (1 + amount));
    const ng = clampByte(l + (g - l) * (1 + amount));
    const nb = clampByte(l + (b - l) * (1 + amount));
    if (nr !== r || ng !== g || nb !== b) {
      if (flags) flags[i] = 1;
    }
    pixels[p] = nr;
    pixels[p + 1] = ng;
    pixels[p + 2] = nb;
  }
}

/**
 * Làm nét nhẹ bằng kernel 3×3 (Laplacian unsharp), biên ảnh lặp cạnh (edge replicate).
 *
 * @param {Buffer|Uint8Array} source ảnh ĐẦU VÀO của phép nét (đọc)
 * @param {Buffer|Uint8Array} out     ảnh ĐẦU RA (bản sao — ghi), alpha giữ nguyên
 * @param {number} amount             > 0 = nét hơn, < 0 = mềm hơn
 */
export function applySharpen(source, out, amount, { width, height }, flags = null) {
  if (!Number.isFinite(amount) || amount === 0) return;
  const at = (x, y, center) => {
    const p = (y * width + x) * 4;
    // Hàng xóm trong suốt ⇒ coi như bằng pixel trung tâm (không kéo màu nền vào viền).
    if (source[p + 3] === 0) return center;
    return [source[p], source[p + 1], source[p + 2]];
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      if (source[p + 3] === 0) continue; // giữ nguyên vùng trong suốt
      const center = [source[p], source[p + 1], source[p + 2]];
      const up = at(x, y > 0 ? y - 1 : y, center);
      const down = at(x, y + 1 < height ? y + 1 : y, center);
      const left = at(x > 0 ? x - 1 : x, y, center);
      const right = at(x + 1 < width ? x + 1 : x, y, center);
      const nr = clampByte(center[0] + amount * (4 * center[0] - up[0] - down[0] - left[0] - right[0]));
      const ng = clampByte(center[1] + amount * (4 * center[1] - up[1] - down[1] - left[1] - right[1]));
      const nb = clampByte(center[2] + amount * (4 * center[2] - up[2] - down[2] - left[2] - right[2]));
      if (nr !== center[0] || ng !== center[1] || nb !== center[2]) {
        if (flags) flags[y * width + x] = 1;
      }
      out[p] = nr;
      out[p + 1] = ng;
      out[p + 2] = nb;
      // alpha: `out` đã là bản sao ⇒ giữ nguyên, không ghi.
    }
  }
}

/**
 * Chạy trọn bộ retouch trên buffer RGBA (đã là bản sao của ảnh vào).
 *
 * @param {Buffer|Uint8Array} pixels buffer RGBA (bị sửa TẠI CHỖ — người gọi phải copy trước)
 * @param {{width:number,height:number}} dims
 * @param {{brightness:number,contrast:number,saturation:number,sharpen:number}} params tham số ĐÃ kẹp
 * @returns {{changed_pixels:number, ops_applied:string[]}} `changed_pixels` = số pixel có MÀU đổi
 *          (theo dõi bằng cờ 1 byte/pixel, không đếm trùng giữa các phép)
 */
export function applyRetouch(pixels, dims, params) {
  const total = dims.width * dims.height;
  const flags = new Uint8Array(total);
  const opsApplied = [];

  // (1)+(2) brightness rồi contrast, gộp trong MỘT LUT.
  if (params.brightness !== 0 || params.contrast !== 0) {
    applyToneLut(pixels, buildToneLut(params.brightness, params.contrast), dims, flags);
    if (params.brightness !== 0) opsApplied.push('brightness');
    if (params.contrast !== 0) opsApplied.push('contrast');
  }

  // (3) bão hoà.
  if (params.saturation !== 0) {
    applySaturation(pixels, params.saturation, dims, flags);
    opsApplied.push('saturation');
  }

  // (4) làm nét: cần ảnh TRƯỚC phép nét ⇒ chụp bản sao rồi ghi vào chính buffer đó.
  if (params.sharpen !== 0) {
    const source = Buffer.from(pixels);
    applySharpen(source, pixels, params.sharpen, dims, flags);
    opsApplied.push('sharpen');
  }

  let changed = 0;
  for (let i = 0; i < total; i += 1) if (flags[i] === 1) changed += 1;

  return { changed_pixels: changed, ops_applied: opsApplied };
}

export default applyRetouch;
