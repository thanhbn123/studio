/**
 * GHÉP ẢNH VÀO KHUNG — `pad` (thêm viền) hoặc `crop` (cắt bớt). **KHÔNG BAO GIỜ KÉO GIÃN**
 * (luật 1 của MVP-04, mục 0).
 *
 * Ý tưởng: chỉ có MỘT hệ số phóng `scale` dùng cho CẢ HAI trục. Nhờ vậy:
 *  − `pad`  : ảnh thu nhỏ vừa khung (contain) ⇒ `fit_box` = chính ảnh đã phóng, tỉ lệ bằng tỉ lệ ảnh gốc;
 *  − `crop` : ảnh phóng đủ phủ khung (cover)  ⇒ `fit_box` = phần NHÌN THẤY = giao của ảnh đã phóng
 *    với khung; vùng ảnh nguồn tương ứng (`source_region`) cũng đúng tỉ lệ `fit_box` và được phóng
 *    bằng đúng `scale` đó ⇒ ảnh vào khung không bị bóp méo, chỉ bị cắt bớt.
 *
 * Mọi hộp trả ra đều đi qua `intersectBoxWithImage` của `src/imagelab/geometry.js` (nguồn duy nhất
 * của phép kẹp hộp trong repo) nên LUÔN nằm trong khung.
 *
 * File thuần: không I/O, không mạng, không đọc file.
 */

import { intersectBoxWithImage } from '../../imagelab/geometry.js';

/** Chuẩn hoá màu `#RGB`/`#RRGGBB` về `#RRGGBB` in hoa; giá trị lạ ⇒ `fallback`. */
export function normalizeHexColor(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const hex = value.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex.toUpperCase()}`;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex
      .split('')
      .map((char) => char + char)
      .join('')
      .toUpperCase()}`;
  }
  return fallback;
}

/** Chuỗi này có phải màu hex hợp lệ (`#RGB` / `#RRGGBB`) hay không. */
export function isHexColor(value) {
  if (typeof value !== 'string') return false;
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

/**
 * Tính hình học ghép một ảnh nguồn vào khung.
 *
 * @param {object} params
 * @param {number} params.source_width  bề rộng ảnh nguồn (px, > 0)
 * @param {number} params.source_height bề cao ảnh nguồn (px, > 0)
 * @param {number} params.width         bề rộng khung (px, > 0)
 * @param {number} params.height        bề cao khung (px, > 0)
 * @param {'pad'|'crop'} [params.fit='pad']
 * @returns {{
 *   fit:'pad'|'crop',
 *   scale:number,
 *   scaled:{x:number,y:number,w:number,h:number},
 *   fit_box:{x:number,y:number,w:number,h:number},
 *   source_region:{x:number,y:number,w:number,h:number}
 * }}
 *  − `scaled`       : hình chữ nhật của ẢNH ĐÃ PHÓNG trong hệ toạ độ khung (crop có thể tràn khung);
 *  − `fit_box`      : phần nhìn thấy trong khung (đây là field `fit_box` của `VideoPlan`);
 *  − `source_region`: vùng ảnh NGUỒN (px nguồn, có thể lẻ) ứng với `fit_box` — LUÔN có
 *    `source_region.w / source_region.h === fit_box.w / fit_box.h` (một `scale` cho cả hai trục).
 */
export function fitImageInFrame({ source_width: sw, source_height: sh, width: W, height: H, fit = 'pad' }) {
  if (fit === 'crop') {
    // COVER: phóng đủ để phủ kín khung rồi cắt phần thừa (căn giữa).
    const scale = Math.max(W / sw, H / sh);
    const scaled = {
      x: Math.round((W - sw * scale) / 2),
      y: Math.round((H - sh * scale) / 2),
      w: Math.max(1, Math.round(sw * scale)),
      h: Math.max(1, Math.round(sh * scale)),
    };
    const fitBox = intersectBoxWithImage(scaled, W, H) ?? { x: 0, y: 0, w: W, h: H };
    return {
      fit: 'crop',
      scale,
      scaled,
      fit_box: fitBox,
      source_region: {
        x: (sw - fitBox.w / scale) / 2,
        y: (sh - fitBox.h / scale) / 2,
        w: fitBox.w / scale,
        h: fitBox.h / scale,
      },
    };
  }

  // CONTAIN (mặc định): phóng vừa khung, phần dư là viền `pad_color`.
  const scale = Math.min(W / sw, H / sh);
  const w = Math.max(1, Math.min(W, Math.round(sw * scale)));
  const h = Math.max(1, Math.min(H, Math.round(sh * scale)));
  const x = Math.floor((W - w) / 2);
  const y = Math.floor((H - h) / 2);
  const scaled = { x, y, w, h };
  return {
    fit: 'pad',
    scale,
    scaled,
    // `intersectBoxWithImage` ở đây là lưới an toàn: hộp đã nằm trong khung nên giao = chính nó.
    fit_box: intersectBoxWithImage(scaled, W, H) ?? { x: 0, y: 0, w: W, h: H },
    source_region: { x: 0, y: 0, w: sw, h: sh },
  };
}

export default fitImageInFrame;
