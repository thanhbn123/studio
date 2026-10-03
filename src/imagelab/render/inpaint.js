/**
 * Inpainting mức đơn giản nhưng THẬT (hợp đồng 4.3):
 *
 *   estimateBackground(pixels, box, {width,height,channels}) → màu trung vị của VIỀN NGOÀI hộp
 *   eraseBox(pixels, box, color, {width,height,channels})    → tô lại ĐÚNG vùng hộp bằng màu đó
 *
 * Vì sao trung vị màu viền: với ảnh sản phẩm (nền phẳng, chữ đè lên), màu nền quanh hộp là
 * ước lượng tốt cho "chữ cũ nằm trên nền gì", và trung vị bền với outlier (không bị một vài
 * pixel viền lọt vào chữ kéo lệch như trung bình cộng).
 *
 * Ràng buộc:
 *  − Chỉ được sửa ĐÚNG vùng `box` của op đang xét, không tràn sang vùng khác.
 *  − Chỉ nhận buffer RGBA (4 kênh) hoặc grayscale (1 kênh) do tầng provider đưa xuống;
 *    hàm vẫn kiểm tra `channels` để không ghi sai bước nhảy.
 */

import { RenderError, RENDER_CODES } from './errors.js';
import { clampBox } from './image.js';

const RING_WIDTH = 2; // bề dày viền lấy mẫu (1–2 pixel theo hợp đồng)

/** Kiểm tra tham số chung, trả về bước nhảy byte của một pixel. */
function resolveGeometry(pixels, { width, height, channels }) {
  if (!pixels || typeof pixels.length !== 'number') {
    throw new RenderError(RENDER_CODES.BAD_INPUT, 'inpaint cần buffer pixel.');
  }
  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  const ch = Math.floor(Number(channels));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new RenderError(RENDER_CODES.BAD_INPUT, 'inpaint cần width/height nguyên dương.', { width, height });
  }
  if (![1, 3, 4].includes(ch)) {
    throw new RenderError(RENDER_CODES.BAD_INPUT, `inpaint chỉ hỗ trợ 1/3/4 kênh (nhận ${channels}).`, {
      channels,
    });
  }
  if (pixels.length < w * h * ch) {
    throw new RenderError(RENDER_CODES.BAD_INPUT, 'Buffer pixel nhỏ hơn kích thước khai báo.', {
      need: w * h * ch,
      actual: pixels.length,
    });
  }
  return { width: w, height: h, channels: ch };
}

/** Trung vị của mảng số (sắp xếp bản sao, không sửa mảng gốc). */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Ước lượng màu nền của một hộp = trung vị màu của viền NGOÀI hộp (2 pixel).
 *
 * Trả về mảng đúng `channels` phần tử (mỗi kênh một trung vị, 0..255).
 * Nếu hộp phủ kín ảnh (không có viền) → lấy trung vị toàn ảnh; ảnh rỗng → màu trắng.
 *
 * @param {Buffer|Uint8Array} pixels
 * @param {{x:number,y:number,w:number,h:number}} box
 * @param {{width:number,height:number,channels:number}} geometry
 * @returns {number[]}
 */
export function estimateBackground(pixels, box, geometry = {}) {
  const { width, height, channels } = resolveGeometry(pixels, geometry);
  const clamped = clampBox(box, { width, height });
  if (!clamped) {
    // Hộp không hợp lệ: vẫn trả màu trung vị toàn ảnh để người gọi không bị kẹt.
    return wholeImageMedian(pixels, { width, height, channels });
  }

  const samples = [];
  // Viền trên & dưới (mở rộng sang trái/phải RING_WIDTH để bắt góc).
  const x0 = Math.max(0, clamped.x - RING_WIDTH);
  const x1 = Math.min(width, clamped.x + clamped.w + RING_WIDTH);
  for (let y = Math.max(0, clamped.y - RING_WIDTH); y < Math.min(height, clamped.y); y += 1) {
    collectRow(samples, pixels, { width, channels }, y, x0, x1);
  }
  for (let y = clamped.y + clamped.h; y < Math.min(height, clamped.y + clamped.h + RING_WIDTH); y += 1) {
    collectRow(samples, pixels, { width, channels }, y, x0, x1);
  }
  // Viền trái & phải.
  const yStart = Math.max(0, clamped.y);
  const yEnd = Math.min(height, clamped.y + clamped.h);
  for (let y = yStart; y < yEnd; y += 1) {
    collectRow(samples, pixels, { width, channels }, y, Math.max(0, clamped.x - RING_WIDTH), clamped.x);
    collectRow(samples, pixels, { width, channels }, y, clamped.x + clamped.w, Math.min(width, clamped.x + clamped.w + RING_WIDTH));
  }

  if (samples.length === 0) return wholeImageMedian(pixels, { width, height, channels });
  const out = [];
  for (let c = 0; c < channels; c += 1) {
    out.push(median(samples.map((px) => px[c])));
  }
  return out;
}

function collectRow(samples, pixels, { width, channels }, y, xStart, xEnd) {
  for (let x = xStart; x < xEnd; x += 1) {
    const i = (y * width + x) * channels;
    const px = new Array(channels);
    for (let c = 0; c < channels; c += 1) px[c] = pixels[i + c];
    samples.push(px);
  }
}

function wholeImageMedian(pixels, { width, height, channels }) {
  const out = [];
  for (let c = 0; c < channels; c += 1) {
    const values = new Array(width * height);
    for (let i = 0; i < width * height; i += 1) values[i] = pixels[i * channels + c];
    out.push(median(values));
  }
  return out;
}

/**
 * Tô lại vùng hộp bằng `color` (mặc định: tự ước lượng nền).
 *
 * Chấp nhận 2 kiểu gọi để agent khác khó gọi sai:
 *   eraseBox(pixels, box, color, {width,height,channels})
 *   eraseBox(pixels, box, {width,height,channels,color})
 *
 * @returns {{x:number,y:number,w:number,h:number}|null} vùng đã tô (null nếu hộp rỗng)
 */
export function eraseBox(pixels, box, colorOrOptions = null, maybeOptions = {}) {
  let color = colorOrOptions;
  let options = maybeOptions;
  if (colorOrOptions && !Array.isArray(colorOrOptions) && typeof colorOrOptions === 'object') {
    options = colorOrOptions;
    color = colorOrOptions.color ?? null;
  }
  const { width, height, channels } = resolveGeometry(pixels, options);
  const clamped = clampBox(box, { width, height });
  if (!clamped) return null;

  const fill = normalizeFill(color, channels, () =>
    estimateBackground(pixels, clamped, { width, height, channels }),
  );

  for (let y = clamped.y; y < clamped.y + clamped.h; y += 1) {
    for (let x = clamped.x; x < clamped.x + clamped.w; x += 1) {
      const i = (y * width + x) * channels;
      for (let c = 0; c < channels; c += 1) pixels[i + c] = fill[c] ?? fill[fill.length - 1] ?? 0;
    }
  }
  return clamped;
}

/** Chuẩn hoá màu tô cho khớp số kênh (RGB → gray bằng trung bình; alpha giữ 255). */
function normalizeFill(color, channels, fallbackFn) {
  const source = Array.isArray(color) && color.length ? color : fallbackFn();
  const nums = source.map((v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : 0;
  });
  if (channels === 4) return [nums[0] ?? 255, nums[1] ?? 255, nums[2] ?? 255, nums[3] ?? 255];
  if (channels === 3) return [nums[0] ?? 255, nums[1] ?? 255, nums[2] ?? 255];
  // 1 kênh: nếu nguồn là RGB thì lấy trung bình cho hợp lý
  if (nums.length >= 3) return [Math.round((nums[0] + nums[1] + nums[2]) / 3)];
  return [nums[0] ?? 255];
}

export default { estimateBackground, eraseBox };
