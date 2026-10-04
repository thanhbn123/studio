/**
 * LÕI TÁCH NỀN của provider `purejs` (hợp đồng §3.1 — E1).
 *
 * Thuật toán: **flood fill từ VIỀN ảnh** theo khoảng cách màu Euclid trên RGB.
 *
 * Vì sao flood fill từ viền mà không phải "xoá mọi pixel giống màu nền":
 *   chỉ những pixel **nối với viền ảnh** bằng một đường đi toàn pixel hợp lệ mới
 *   bị coi là nền. Một mảng màu trắng nằm GIỮA sản phẩm (nhãn, highlight, chữ)
 *   không nối được với viền qua các pixel nền ⇒ KHÔNG BAO GIỜ bị ăn mất.
 *
 * Kết nối dùng mặc định **4 hướng** (trên/dưới/trái/phải) — chặt hơn 8 hướng:
 * vùng nền chỉ dính nhau qua một góc chéo (vách mỏng 1 pixel chéo) sẽ KHÔNG bị
 * loang xuyên qua, nên không cắt lẹm vào sản phẩm. `options.connectivity = 8`
 * được phép nhưng phải khai rõ (nới lỏng = loang mạnh hơn).
 *
 * Hàm thuần, chạy offline, không đọc file/mạng; KHÔNG sửa buffer đầu vào.
 */

import { Buffer } from 'node:buffer';

/** Ngưỡng màu mặc định trên thang 0..255 (≈ 28/255 như hợp đồng §3.1). */
export const DEFAULT_TOLERANCE = 28;
/** Tỉ lệ pixel viền tối thiểu thuộc cụm màu chủ đạo để coi nền là "đồng nhất". */
export const DEFAULT_MIN_UNIFORMITY = 0.75;
/** Số ô lượng tử màu cho mỗi kênh khi gom cụm (16 ⇒ 16×16×16 = 4096 ô). */
const QUANT_STEP = 16;
const QUANT_BUCKETS = 4096;

/**
 * Khoảng cách màu Euclid trên 3 kênh RGB (0..255 mỗi kênh).
 * Alpha KHÔNG tham gia: nền trong suốt sẵn vẫn được xử lý riêng (xem `buildSimilarityMap`).
 */
export function colorDistance(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Chuẩn hoá `options.tolerance` về thang 0..255.
 *
 * Nhận cả hai cách khai (ghi rõ để người gọi không đoán):
 *   - `0 < t <= 1`  → hiểu là tỉ lệ chuẩn hoá ⇒ × 255 (ví dụ 0.11 ⇒ 28.05)
 *   - `t > 1`       → hiểu là giá trị thật trên thang 0..255
 *   - `t === 0`     → 0 (chỉ nhận pixel giống hệt màu nền)
 * Giá trị không hữu hạn / âm ⇒ dùng mặc định (fail-closed, không nới ngưỡng bừa).
 *
 * @returns {{tolerance:number, normalized:boolean, invalid:boolean}}
 */
export function normalizeTolerance(value, fallback = DEFAULT_TOLERANCE) {
  if (value === undefined || value === null || value === '') {
    return { tolerance: fallback, normalized: false, invalid: false };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return { tolerance: fallback, normalized: false, invalid: true };
  if (n === 0) return { tolerance: 0, normalized: false, invalid: false };
  if (n <= 1) return { tolerance: n * 255, normalized: true, invalid: false };
  return { tolerance: Math.min(n, 255), normalized: false, invalid: false };
}

/** Chuẩn hoá `options.minUniformity` (0..1). Giá trị lạ ⇒ mặc định. */
export function normalizeMinUniformity(value, fallback = DEFAULT_MIN_UNIFORMITY) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n > 1 && n <= 100) return n / 100; // người gọi khai phần trăm (75 ⇒ 0.75)
  return Math.max(0, Math.min(1, n));
}

/** Danh sách chỉ số pixel của khung viền dày `borderWidth` (không lặp pixel). */
function borderIndices(width, height, borderWidth) {
  const out = [];
  const maxBorder = Math.max(1, Math.floor(Math.min(width, height) / 2));
  const bw = Math.max(1, Math.min(Math.floor(borderWidth) || 1, maxBorder));
  for (let y = 0; y < height; y += 1) {
    const inVerticalBand = y < bw || y >= height - bw;
    if (inVerticalBand) {
      for (let x = 0; x < width; x += 1) out.push(y * width + x);
    } else {
      for (let x = 0; x < bw; x += 1) {
        out.push(y * width + x);
        out.push(y * width + (width - 1 - x));
      }
    }
  }
  return out;
}

/**
 * Đo mức ĐỒNG NHẤT của viền ảnh.
 *
 * `uniformity` = tỉ lệ pixel viền nằm trong cụm màu chủ đạo (khoảng cách tới màu
 * trung bình của cụm ≤ `tolerance`). Nền studio trắng/xám ⇒ ≈ 1; nền gradient
 * nhiễu / ảnh cảnh thật ⇒ thấp ⇒ bị TỪ CHỐI (fail-closed).
 *
 * @returns {{dominant:{r:number,g:number,b:number}, uniformity:number, seed_colors:number,
 *            border_pixels:number, opaque_border_pixels:number}}
 */
export function measureBorderUniformity(pixels, { width, height, tolerance, borderWidth = 1 }) {
  const counts = new Int32Array(QUANT_BUCKETS);
  const sumR = new Float64Array(QUANT_BUCKETS);
  const sumG = new Float64Array(QUANT_BUCKETS);
  const sumB = new Float64Array(QUANT_BUCKETS);
  const indices = borderIndices(width, height, borderWidth);
  let opaque = 0;
  for (const i of indices) {
    const p = i * 4;
    const r = pixels[p];
    const g = pixels[p + 1];
    const b = pixels[p + 2];
    const bucket = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    counts[bucket] += 1;
    sumR[bucket] += r;
    sumG[bucket] += g;
    sumB[bucket] += b;
    if (pixels[p + 3] > 0) opaque += 1;
  }

  let bestBucket = -1;
  let bestCount = 0;
  for (let b = 0; b < QUANT_BUCKETS; b += 1) {
    if (counts[b] > bestCount) {
      bestCount = counts[b];
      bestBucket = b;
    }
  }
  const dominant = bestBucket < 0
    ? { r: 255, g: 255, b: 255 }
    : {
        r: Math.round(sumR[bestBucket] / bestCount),
        g: Math.round(sumG[bestBucket] / bestCount),
        b: Math.round(sumB[bestBucket] / bestCount),
      };

  let within = 0;
  for (const i of indices) {
    const p = i * 4;
    if (colorDistance(pixels[p], pixels[p + 1], pixels[p + 2], dominant.r, dominant.g, dominant.b) <= tolerance) {
      within += 1;
    }
  }

  // `seed_colors` = số CỤM màu khác nhau trên viền có đủ đông (≥ 0.5% pixel viền, tối thiểu 2 pixel).
  // Nền studio đồng nhất ⇒ 1; nền gradient/nhiễu ⇒ hàng chục (nói thẳng là viền lộn xộn).
  const minSeed = Math.max(2, Math.round(indices.length * 0.005));
  let seedColors = 0;
  for (let b = 0; b < QUANT_BUCKETS; b += 1) if (counts[b] >= minSeed) seedColors += 1;

  return {
    dominant,
    uniformity: indices.length > 0 ? within / indices.length : 0,
    seed_colors: Math.max(seedColors, 1),
    border_pixels: indices.length,
    opaque_border_pixels: opaque,
  };
}

/**
 * Bản đồ "pixel này giống màu nền" (1 = giống, 0 = không).
 * Pixel có alpha = 0 sẵn được coi là nền (ảnh đã tách từ trước).
 */
export function buildSimilarityMap(pixels, { width, height, tolerance, target }) {
  const total = width * height;
  const similar = new Uint8Array(total);
  const t2 = tolerance * tolerance; // so bình phương để khỏi khai căn mỗi pixel
  for (let i = 0; i < total; i += 1) {
    const p = i * 4;
    if (pixels[p + 3] === 0) {
      similar[i] = 1; // đã trong suốt sẵn ⇒ là nền
      continue;
    }
    const dr = pixels[p] - target.r;
    const dg = pixels[p + 1] - target.g;
    const db = pixels[p + 2] - target.b;
    if (dr * dr + dg * dg + db * db <= t2) similar[i] = 1;
  }
  return similar;
}

/**
 * Loang từ VIỀN trên bản đồ tương đồng (BFS, hàng đợi vòng Int32Array).
 *
 * `similar[i]` sau khi chạy: 2 = nền đã tách (nối với viền), 1 = giống màu nền
 * nhưng KHÔNG nối với viền (giữ lại — chống ăn vào giữa sản phẩm), 0 = giữ lại.
 *
 * @returns {number} số pixel nền đã tách
 */
export function floodFillFromBorder(similar, { width, height, connectivity = 4 }) {
  const total = width * height;
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const push = (i) => {
    similar[i] = 2;
    queue[tail] = i;
    tail += 1;
  };

  // Hạt giống: mọi pixel thuộc KHUNG NGOÀI CÙNG (dày 1 pixel) giống màu nền —
  // kể cả pixel đã trong suốt sẵn. Với ảnh 1 pixel, top và bottom trùng nhau;
  // điều kiện `similar[i] === 1` (đã đổi thành 2 sau khi đẩy) tự chặn đẩy trùng.
  const bw = 1;
  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < bw; y += 1) {
      const top = y * width + x;
      const bottom = (height - 1 - y) * width + x;
      if (similar[top] === 1) push(top);
      if (similar[bottom] === 1) push(bottom);
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < bw; x += 1) {
      const left = y * width + x;
      const right = y * width + (width - 1 - x);
      if (similar[left] === 1) push(left);
      if (similar[right] === 1) push(right);
    }
  }

  const eightWay = Number(connectivity) === 8;
  let filled = 0;
  while (head < tail) {
    const i = queue[head];
    head += 1;
    filled += 1;
    const x = i % width;
    const y = (i - x) / width;
    // 4 hướng mặc định: chỉ lan theo cạnh, không lan qua góc chéo.
    if (x > 0 && similar[i - 1] === 1) push(i - 1);
    if (x + 1 < width && similar[i + 1] === 1) push(i + 1);
    if (y > 0 && similar[i - width] === 1) push(i - width);
    if (y + 1 < height && similar[i + width] === 1) push(i + width);
    if (eightWay) {
      if (x > 0 && y > 0 && similar[i - width - 1] === 1) push(i - width - 1);
      if (x + 1 < width && y > 0 && similar[i - width + 1] === 1) push(i - width + 1);
      if (x > 0 && y + 1 < height && similar[i + width - 1] === 1) push(i + width - 1);
      if (x + 1 < width && y + 1 < height && similar[i + width + 1] === 1) push(i + width + 1);
    }
  }
  return filled;
}

/**
 * Áp mặt nạ `similar[i] === 2` thành PNG RGBA: nền đã tách ⇒ alpha = 0.
 *
 * Pixel GIỮ LẠI: giữ NGUYÊN cả 4 kênh (không đổi màu sản phẩm).
 * Pixel nền: alpha = 0, giữ nguyên RGB (không tô đen — tránh viền đen khi UI
 * phóng to ảnh trong suốt).
 *
 * @returns {Buffer} buffer RGBA mới (không dính tới buffer đầu vào)
 */
export function applyAlphaMask(pixels, similar, { width, height }) {
  const out = Buffer.from(pixels); // BẢN SAO — không bao giờ sửa buffer ảnh vào
  const total = width * height;
  for (let i = 0; i < total; i += 1) {
    if (similar[i] === 2) out[i * 4 + 3] = 0;
  }
  return out;
}

/**
 * Hộp bao của phần GIỮ LẠI (pixel không thuộc nền đã tách).
 * @returns {{x:number,y:number,w:number,h:number}|null} null nếu không còn pixel nào giữ lại
 */
export function keptBoundingBox(similar, { width, height }) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (similar[y * width + x] === 2) continue; // nền ⇒ không tính
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export default measureBorderUniformity;
