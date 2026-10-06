/**
 * LƯỢNG TỬ HOÁ MÀU cho GIF — **MEDIAN CUT** trên histogram 15-bit (hợp đồng MVP-04 §2.2).
 *
 * Chọn cách nào? → **median cut** (cắt trung vị), chạy trên histogram 5-bit/kênh
 * (32×32×32 = 32768 ô). Lý do:
 *   - Ảnh sản phẩm thường ít màu; median cut cho bảng màu toàn cục (một GCT cho MỌI khung)
 *     nên video không bị "nhấp nháy bảng màu" giữa các khung;
 *   - chi phí O(số ô) chứ không O(số điểm ảnh × số màu) ⇒ 30 khung 720×1280 vẫn nhanh;
 *   - màu của mỗi hộp = **trung bình có trọng số** theo số mẫu ⇒ sai số màu thấp hơn lấy trung vị.
 *
 * Sai số màu: `mapFrames` trả tổng |ΔR|+|ΔG|+|ΔB| của TỪNG điểm ảnh so với màu palette
 * thật sự được gán; `averageColorError()` chia 3 và chia số điểm ảnh ⇒ đơn vị 0..255.
 * `gif.js` ghi cảnh báo khi sai số trung bình vượt ngưỡng (mặc định 8/255).
 *
 * Alpha: GIF không có kênh alpha (chỉ có 1 chỉ số trong suốt 1-bit) nên mọi điểm ảnh có
 * alpha < 255 được **làm phẳng** lên một màu nền (`background`, mặc định đen). Số điểm ảnh
 * bị làm phẳng được đếm để `gif.js` cảnh báo — không giấu.
 *
 * Dither (Floyd–Steinberg) mặc định TẮT theo hợp đồng; bật thì sai số từng điểm ảnh có thể
 * cao hơn nhưng sai số *cảm nhận* thấp hơn — vì vậy cảnh báo sai số luôn kèm cờ `dither`.
 */

import { Buffer } from 'node:buffer';

/** Số bit mỗi kênh khi dựng histogram (5 bit ⇒ 32768 ô). */
export const HIST_BITS = 5;
/** Số ô của histogram. */
export const HIST_SIZE = 1 << (HIST_BITS * 3); // 32768
/** Số màu tối đa GIF cho phép. */
export const GIF_MAX_COLORS = 256;

const toView = (value) =>
  Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : null;

/** Màu nền mặc định khi phải làm phẳng alpha. */
export const DEFAULT_BACKGROUND = Object.freeze([0, 0, 0]);

/** Chuẩn hoá màu nền: nhận [r,g,b] hoặc '#rrggbb'; sai ⇒ đen. */
export function normalizeBackground(value) {
  if (Array.isArray(value) && value.length >= 3) {
    const nums = value.slice(0, 3).map((v) => Number(v));
    if (nums.every((v) => Number.isFinite(v))) {
      return nums.map((v) => Math.max(0, Math.min(255, Math.round(v))));
    }
    return [...DEFAULT_BACKGROUND];
  }
  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(hex)) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
  }
  return [...DEFAULT_BACKGROUND];
}

/** Nén 8 bit → 5 bit (làm tròn lên để không lệch tông). */
const toHist = (v) => (v >> 3) & 31;
/** Bung 5 bit → 8 bit (nhân bản bit thấp, đúng chuẩn mở rộng). */
const fromHist = (v5) => ((v5 << 3) | (v5 >> 2)) & 0xff;

/**
 * Dựng histogram 15-bit cho TOÀN BỘ khung (một bảng màu chung).
 *
 * @param {Array<Buffer|Uint8Array>} frames mỗi phần tử là RGBA thô (w*h*4)
 * @param {{width:number, height:number, background?:number[]}} params
 * @returns {{hist:Uint32Array, pixels:number, flattened:number}}
 */
export function buildHistogram(frames, { width, height, background = DEFAULT_BACKGROUND } = {}) {
  const hist = new Uint32Array(HIST_SIZE);
  const [br, bg, bb] = normalizeBackground(background);
  const need = width * height * 4;
  let pixels = 0;
  let flattened = 0;
  for (const frame of frames) {
    const view = toView(frame);
    if (!view || view.length < need) continue; // gif.js đã kiểm trước; ở đây bỏ qua an toàn
    for (let i = 0; i < need; i += 4) {
      const a = view[i + 3];
      let r = view[i];
      let g = view[i + 1];
      let b = view[i + 2];
      if (a !== 255) {
        // Làm phẳng alpha lên nền (source-over, alpha 0..255).
        const af = a / 255;
        r = Math.round(r * af + br * (1 - af));
        g = Math.round(g * af + bg * (1 - af));
        b = Math.round(b * af + bb * (1 - af));
        flattened += 1;
      }
      hist[(toHist(r) << 10) | (toHist(g) << 5) | toHist(b)] += 1;
      pixels += 1;
    }
  }
  return { hist, pixels, flattened };
}

/**
 * Median cut trên histogram ⇒ bảng màu (mảng byte RGB).
 *
 * @param {Uint32Array} hist
 * @param {number} maxColors 2..256
 * @returns {{palette:Buffer, colors:number}} `palette` dài `colors*3`
 */
export function medianCutPalette(hist, maxColors) {
  const limit = Math.max(1, Math.min(GIF_MAX_COLORS, Math.floor(Number(maxColors) || GIF_MAX_COLORS)));

  // (1) Liệt kê các ô CÓ mẫu (tối đa 32768 ô) — chỉ làm việc trên đó.
  let total = 0;
  for (let i = 0; i < HIST_SIZE; i += 1) if (hist[i] > 0) total += 1;
  if (total === 0) {
    // Không có điểm ảnh nào (không xảy ra với khung hợp lệ) — trả 1 màu đen để không sập.
    return { palette: Buffer.from([0, 0, 0]), colors: 1 };
  }
  const keys = new Uint16Array(total);
  const counts = new Uint32Array(total);
  let at = 0;
  for (let i = 0; i < HIST_SIZE; i += 1) {
    if (hist[i] > 0) {
      keys[at] = i;
      counts[at] = hist[i];
      at += 1;
    }
  }
  // `order` là hoán vị của các chỉ số 0..total-1; mỗi hộp là một đoạn liên tiếp [start, end).
  const order = new Uint16Array(total);
  for (let i = 0; i < total; i += 1) order[i] = i;
  const scratch = new Uint16Array(total);

  /** Tính biên mỗi kênh + tổng mẫu của một đoạn. */
  const boundsOf = (start, end) => {
    let rMin = 31;
    let rMax = 0;
    let gMin = 31;
    let gMax = 0;
    let bMin = 31;
    let bMax = 0;
    let count = 0;
    for (let i = start; i < end; i += 1) {
      const key = keys[order[i]];
      const r = (key >> 10) & 31;
      const g = (key >> 5) & 31;
      const b = key & 31;
      if (r < rMin) rMin = r;
      if (r > rMax) rMax = r;
      if (g < gMin) gMin = g;
      if (g > gMax) gMax = g;
      if (b < bMin) bMin = b;
      if (b > bMax) bMax = b;
      count += counts[order[i]];
    }
    return { start, end, rMin, rMax, gMin, gMax, bMin, bMax, count };
  };

  let boxes = [boundsOf(0, total)];
  const split = (box) => {
    // Thử lần lượt các kênh theo biên RỘNG nhất; kênh không cắt được thì thử kênh kế.
    const ranges = [box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin];
    const channels = [0, 1, 2].sort((a, b) => ranges[b] - ranges[a]);
    for (const channel of channels) {
      if (ranges[channel] <= 0) continue; // hộp đơn sắc trên kênh này
      const shift = channel === 0 ? 10 : channel === 1 ? 5 : 0;

      // Đếm 32 ô của kênh đó: `binCount` để PHÂN HOẠCH, `sampleCount` để chọn TRUNG VỊ.
      const binCount = new Uint32Array(32);
      const sampleCount = new Uint32Array(32);
      for (let i = box.start; i < box.end; i += 1) {
        const idx = order[i];
        const b = (keys[idx] >> shift) & 31;
        binCount[b] += 1;
        sampleCount[b] += counts[idx];
      }

      // Ranh giới cắt b ∈ [0, 30] (giữ ô cuối ở bên phải): chọn chỗ tích luỹ mẫu gần nửa nhất,
      // hai bên đều phải còn mẫu — nếu không, hộp sẽ sinh ra hộp rỗng (lỗi cũ: bucket đếm Ô
      // thay vì MẪU nên ảnh 5 màu bị gộp thành 1 màu).
      const half = box.count / 2;
      let cut = -1;
      let bestDiff = Infinity;
      let acc = 0;
      for (let b = 0; b < 31; b += 1) {
        acc += sampleCount[b];
        if (acc === 0 || acc >= box.count) continue; // một bên rỗng ⇒ không phải ranh giới hợp lệ
        const diff = Math.abs(acc - half);
        if (diff < bestDiff) {
          bestDiff = diff;
          cut = b;
        }
      }
      if (cut < 0) continue; // kênh này dồn hết vào một ô ⇒ thử kênh khác

      // Phân hoạch ỔN ĐỊNH đoạn [start, end) theo ô ≤ cut / > cut (counting sort).
      const offsets = new Uint32Array(33);
      offsets[0] = box.start;
      for (let b = 0; b < 32; b += 1) offsets[b + 1] = offsets[b] + binCount[b];
      const cursor = Uint32Array.from(offsets);
      for (let i = box.start; i < box.end; i += 1) {
        const idx = order[i];
        const b = (keys[idx] >> shift) & 31;
        scratch[cursor[b]] = idx;
        cursor[b] += 1;
      }
      for (let i = box.start; i < box.end; i += 1) order[i] = scratch[i];

      const splitAt = offsets[cut + 1];
      if (splitAt <= box.start || splitAt >= box.end) continue;
      return [boundsOf(box.start, splitAt), boundsOf(splitAt, box.end)];
    }
    return null;
  };

  // (2) Tách dần: luôn chọn hộp "đáng tách nhất" = nhiều mẫu nhất mà còn biên màu.
  while (boxes.length < limit) {
    let pick = -1;
    let bestScore = -1;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      if (box.end - box.start < 2) continue;
      const span = Math.max(box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin);
      if (span <= 0) continue;
      const score = box.count * (span + 1);
      if (score > bestScore) {
        bestScore = score;
        pick = i;
      }
    }
    if (pick < 0) break; // mọi hộp đã đơn sắc ⇒ dùng ít màu hơn yêu cầu (không bịa màu)
    const parts = split(boxes[pick]);
    if (!parts) {
      // Hộp này không tách được nữa: đánh dấu bằng cách bỏ qua vĩnh viễn.
      boxes[pick] = { ...boxes[pick], end: boxes[pick].start, count: 0 };
      continue;
    }
    boxes.splice(pick, 1, parts[0], parts[1]);
  }

  // (3) Màu của mỗi hộp = trung bình có trọng số (làm tròn).
  const palette = Buffer.allocUnsafe(boxes.length * 3);
  let written = 0;
  for (const box of boxes) {
    if (box.end <= box.start) continue; // hộp rỗng (đã đánh dấu ở trên)
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let sw = 0;
    for (let i = box.start; i < box.end; i += 1) {
      const idx = order[i];
      const key = keys[idx];
      const w = counts[idx];
      sr += fromHist((key >> 10) & 31) * w;
      sg += fromHist((key >> 5) & 31) * w;
      sb += fromHist(key & 31) * w;
      sw += w;
    }
    if (sw === 0) continue;
    palette[written * 3] = Math.round(sr / sw);
    palette[written * 3 + 1] = Math.round(sg / sw);
    palette[written * 3 + 2] = Math.round(sb / sw);
    written += 1;
  }
  return { palette: palette.subarray(0, written * 3), colors: Math.max(1, written) };
}

/**
 * Bảng tra ô-màu → chỉ số palette gần nhất (khoảng cách Euclid bình phương).
 * Chỉ tính cho các ô CÓ trong histogram ⇒ rẻ và đủ dùng (mọi điểm ảnh đều rơi vào ô có mẫu).
 *
 * @returns {Int16Array} dài 32768, -1 = chưa tính
 */
export function buildIndexLut(hist, palette, colors) {
  const lut = new Int16Array(HIST_SIZE).fill(-1);
  for (let key = 0; key < HIST_SIZE; key += 1) {
    if (hist[key] === 0) continue;
    const r = fromHist((key >> 10) & 31);
    const g = fromHist((key >> 5) & 31);
    const b = fromHist(key & 31);
    lut[key] = nearestIndex(palette, colors, r, g, b);
  }
  return lut;
}

/** Chỉ số màu gần nhất trong palette (quét tuyến tính — palette ≤ 256). */
export function nearestIndex(palette, colors, r, g, b) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < colors; i += 1) {
    const dr = r - palette[i * 3];
    const dg = g - palette[i * 3 + 1];
    const db = b - palette[i * 3 + 2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
      if (dist === 0) break;
    }
  }
  return best;
}

/**
 * Ánh xạ MỌI khung RGBA → chỉ số palette, đồng thời cộng dồn sai số màu.
 *
 * @param {Array<Buffer|Uint8Array>} frames
 * @param {{width:number,height:number,palette:Buffer,colors:number,lut:Int16Array,
 *          background?:number[],dither?:boolean}} params
 * @returns {{indices:Uint8Array[], errorSum:number, errorPixels:number}}
 */
export function mapFrames(frames, { width, height, palette, colors, lut, background = DEFAULT_BACKGROUND, dither = false }) {
  const [br, bg, bb] = normalizeBackground(background);
  const need = width * height * 4;
  const out = [];
  let errorSum = 0;
  let errorPixels = 0;

  for (const frame of frames) {
    const view = toView(frame);
    const indices = new Uint8Array(width * height);
    if (!view || view.length < need) {
      out.push(indices);
      continue;
    }
    // Hàng sai số cho Floyd–Steinberg: chỉ cần hàng hiện tại + hàng kế tiếp.
    const errCur = dither ? new Float32Array(width * 3) : null;
    const errNext = dither ? new Float32Array(width * 3) : null;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const a = view[i + 3];
        // Màu GỐC sau khi làm phẳng alpha — TRƯỚC khi cộng bù dither (dùng để đo sai số).
        let baseR = view[i];
        let baseG = view[i + 1];
        let baseB = view[i + 2];
        if (a !== 255) {
          const af = a / 255;
          baseR = Math.round(baseR * af + br * (1 - af));
          baseG = Math.round(baseG * af + bg * (1 - af));
          baseB = Math.round(baseB * af + bb * (1 - af));
        }
        let r = baseR;
        let g = baseG;
        let b = baseB;
        if (dither) {
          const e = x * 3;
          r = clamp8(r + errCur[e]);
          g = clamp8(g + errCur[e + 1]);
          b = clamp8(b + errCur[e + 2]);
        }
        const key = (toHist(r) << 10) | (toHist(g) << 5) | toHist(b);
        let index = lut[key];
        if (index < 0) index = nearestIndex(palette, colors, r, g, b);
        indices[y * width + x] = index;
        const pr = palette[index * 3];
        const pg = palette[index * 3 + 1];
        const pb = palette[index * 3 + 2];
        if (dither) {
          // Sai số ĐO TRÊN MÀU GỐC so với màu palette gần nhất (không tính phần bù của dither):
          // dither làm lệch từng điểm ảnh nhưng giữ trung bình cục bộ, nên đo sau dither sẽ
          // thổi phồng con số và cảnh báo mất nghĩa.
          const baseKey = (toHist(baseR) << 10) | (toHist(baseG) << 5) | toHist(baseB);
          let baseIndex = lut[baseKey];
          if (baseIndex < 0) baseIndex = nearestIndex(palette, colors, baseR, baseG, baseB);
          errorSum +=
            Math.abs(baseR - palette[baseIndex * 3]) +
            Math.abs(baseG - palette[baseIndex * 3 + 1]) +
            Math.abs(baseB - palette[baseIndex * 3 + 2]);
        } else {
          errorSum += Math.abs(r - pr) + Math.abs(g - pg) + Math.abs(b - pb);
        }
        errorPixels += 1;
        if (dither) {
          const e = x * 3;
          const dr = r - pr;
          const dg = g - pg;
          const db = b - pb;
          // Phân bổ 7/16 sang phải, 3/16 và 5/16 xuống dưới, 1/16 chéo.
          const push = (arr, off, wr, wg, wb) => {
            if (off + 2 >= arr.length || off < 0) return;
            arr[off] += dr * wr;
            arr[off + 1] += dg * wg;
            arr[off + 2] += db * wb;
          };
          push(errCur, e + 3, 7 / 16, 7 / 16, 7 / 16);
          push(errNext, e - 3, 3 / 16, 3 / 16, 3 / 16);
          push(errNext, e, 5 / 16, 5 / 16, 5 / 16);
          push(errNext, e + 3, 1 / 16, 1 / 16, 1 / 16);
        }
      }
      if (dither) {
        errCur.set(errNext);
        errNext.fill(0);
      }
    }
    out.push(indices);
  }
  return { indices: out, errorSum, errorPixels };
}

/** Kẹp 0..255. */
function clamp8(v) {
  const n = Math.round(Number(v) || 0);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/**
 * Sai số màu TRUNG BÌNH trên mỗi kênh (0..255).
 * @param {number} errorSum tổng |ΔR|+|ΔG|+|ΔB|
 * @param {number} pixels số điểm ảnh đã đo
 */
export function averageColorError(errorSum, pixels) {
  if (!Number.isFinite(errorSum) || !Number.isFinite(pixels) || pixels <= 0) return 0;
  return errorSum / 3 / pixels;
}

/** Số bit mã hoá 1 điểm ảnh theo số màu của bảng màu (≥ 2 theo chuẩn GIF). */
export function minCodeSizeFor(colors) {
  let bits = 1;
  while (1 << bits < colors) bits += 1;
  return Math.max(2, bits);
}

/** Số mục bảng màu (GCT) phải là luỹ thừa 2, tối thiểu 2 — đúng chuẩn GIF. */
export function colorTableSize(colors) {
  let size = 2;
  while (size < colors) size <<= 1;
  return size;
}
