/**
 * Tiện ích dùng chung cho bộ test MVP-03 (ImageStudio).
 *
 * Nguyên tắc giống `test/imagelab-helpers.js`: KHÔNG cần mạng, KHÔNG cần API key.
 * Mọi provider đều là bản THẬT chạy offline (`purejs`, `mock`, `none`) — không có
 * provider giả nào tự bịa kết quả tách nền/retouch.
 *
 * Ảnh test được SINH BẰNG CÔNG THỨC (tất định, byte-for-byte giống nhau giữa các lần chạy)
 * để mọi khẳng định về pixel đều lặp lại được:
 *   - `productImage()`   — nền đồng nhất + vật thể ở giữa (tách nền được).
 *   - `noisyImage()`     — nền nhiễu xác định (KHÔNG tách nền được ⇒ fail-closed).
 *   - `transparentImage()` — nền đã tách (alpha = 0) để kiểm bất biến alpha khi retouch.
 *
 * File này không có hậu tố `.test.js` nên `node --test test/*.test.js` không chạy nó.
 */

import { createStore } from '../src/store/index.js';
import { createImageStorage } from '../src/imagelab/storage.js';
import { encodePng, decodePng, toRgba, probeImage } from '../src/imagelab/render/index.js';
import { createMattingProvider } from '../src/imagestudio/matting/index.js';
import { createRetouchProvider } from '../src/imagestudio/retouch/index.js';
import { ImageGenerationPipeline } from '../src/imagestudio/pipeline.js';
import { testConfig, silent } from './helpers.js';
import { imagelabConfig, tmpDir } from './imagelab-helpers.js';

/* ───────────────────────── ảnh tổng hợp (tất định) ───────────────────────── */

/** Bộ sinh số giả ngẫu nhiên TẤT ĐỊNH (LCG) — cùng seed ⇒ cùng dãy byte. */
function lcg(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Ảnh PNG RGBA tổng hợp: nền `background`, tô đặc vật thể trong `box` bằng `rgba`.
 * @returns {Buffer} PNG RGBA (đục hoàn toàn theo mặc định)
 */
export function productImage({
  width = 64,
  height = 64,
  background = [255, 255, 255, 255],
  box = { x: 20, y: 20, w: 24, h: 24 },
  rgba = [200, 30, 40, 255],
} = {}) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = background[0];
    data[i * 4 + 1] = background[1];
    data[i * 4 + 2] = background[2];
    data[i * 4 + 3] = background[3] ?? 255;
  }
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = rgba[0];
      data[i + 1] = rgba[1];
      data[i + 2] = rgba[2];
      data[i + 3] = rgba[3] ?? 255;
    }
  }
  return encodePng({ width, height, data, channels: 4 });
}

/** Ảnh có NỀN NHIỄU (mỗi pixel viền một màu khác) — tách nền phải bị TỪ CHỐI. */
export function noisyImage({ width = 64, height = 64, box = { x: 20, y: 20, w: 24, h: 24 }, seed = 7 } = {}) {
  const rand = lcg(seed);
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = Math.floor(rand() * 256);
    data[i * 4 + 1] = Math.floor(rand() * 256);
    data[i * 4 + 2] = Math.floor(rand() * 256);
    data[i * 4 + 3] = 255;
  }
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = 200;
      data[i + 1] = 30;
      data[i + 2] = 40;
      data[i + 3] = 255;
    }
  }
  return encodePng({ width, height, data, channels: 4 });
}

/** Ảnh toàn MỘT màu (không có sản phẩm) — mask phải bị nghi ngờ (`SUSPICIOUS_MASK`). */
export function solidImage({ width = 64, height = 64, rgba = [255, 255, 255, 255] } = {}) {
  return productImage({ width, height, background: rgba, box: { x: 0, y: 0, w: 0, h: 0 } });
}

/**
 * Ảnh PNG có vùng TRONG SUỐT (alpha = 0) — mô phỏng đầu ra tách nền / nền đã tách.
 * `opaqueBox` là vùng sản phẩm còn lại; RGB của vùng trong suốt là màu `hiddenRgb`
 * (khác hẳn sản phẩm) để test bắt được nếu có phép nào đó "tô" vào vùng nền.
 */
export function transparentImage({
  width = 64,
  height = 64,
  opaqueBox = { x: 20, y: 20, w: 24, h: 24 },
  opaqueRgba = [200, 30, 40, 255],
  hiddenRgb = [10, 220, 90],
} = {}) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = hiddenRgb[0];
    data[i * 4 + 1] = hiddenRgb[1];
    data[i * 4 + 2] = hiddenRgb[2];
    data[i * 4 + 3] = 0;
  }
  for (let y = opaqueBox.y; y < opaqueBox.y + opaqueBox.h; y += 1) {
    for (let x = opaqueBox.x; x < opaqueBox.x + opaqueBox.w; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = opaqueRgba[0];
      data[i + 1] = opaqueRgba[1];
      data[i + 2] = opaqueRgba[2];
      data[i + 3] = opaqueRgba[3] ?? 255;
    }
  }
  return encodePng({ width, height, data, channels: 4 });
}

/* ───────────────────────── đọc pixel ───────────────────────── */

/** RGBA đã giải mã của một PNG (ném lỗi nếu không giải mã được). */
export function pixelsOf(buffer) {
  const decoded = decodePng(buffer);
  return { width: decoded.width, height: decoded.height, data: toRgba(decoded), decoded };
}

/** Kích thước thật của ảnh (null nếu không đọc được header). */
export function sizeOf(buffer) {
  const info = probeImage(buffer);
  return info ? { width: info.width, height: info.height, mime: info.mime } : null;
}

/** Pixel tại (x, y) dưới dạng [r,g,b,a]. */
export function pixelAt(buffer, x, y) {
  const { width, data } = pixelsOf(buffer);
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

/** Đếm pixel ĐỔI (so cả 4 kênh) giữa hai ảnh PNG cùng kích thước. */
export function countChanged(before, after) {
  const a = pixelsOf(before);
  const b = pixelsOf(after);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`hai ảnh khác kích thước: ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  }
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) {
      changed += 1;
    }
  }
  return changed;
}

/**
 * Đếm pixel đổi BÊN NGOÀI một hộp (dùng để chứng minh "pixel giữ lại y hệt ảnh vào").
 * @returns {{outside:number, inside:number}}
 */
export function countChangedInsideOutside(before, after, box) {
  const a = pixelsOf(before);
  const b = pixelsOf(after);
  if (a.width !== b.width || a.height !== b.height) throw new Error('hai ảnh khác kích thước');
  let inside = 0;
  let outside = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      const i = (y * a.width + x) * 4;
      const diff =
        a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3];
      if (!diff) continue;
      const inBox = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      if (inBox) inside += 1;
      else outside += 1;
    }
  }
  return { inside, outside };
}

/* ───────────────────────── stack pipeline thật ───────────────────────── */

/**
 * Dựng store (SQLite in-memory) + storage tmp + provider THẬT + pipeline MVP-03.
 * Provider mặc định là `purejs` (tách nền / retouch thật, chạy offline).
 */
export async function makeImagestudioStack({
  configOverrides = {},
  config: provided,
  mattingProvider,
  retouchProvider,
  sessionId = 'imagestudio-session-01',
  kind = 'image_generation',
} = {}) {
  const config = provided || imagelabConfig(configOverrides);
  const store = await createStore(config, silent);
  const storage = createImageStorage(config, { logger: silent });
  const matting = mattingProvider ?? createMattingProvider(config, { logger: silent });
  const retouch = retouchProvider ?? createRetouchProvider(config, { logger: silent });
  const pipeline = new ImageGenerationPipeline({
    config,
    logger: silent,
    store,
    storage,
    mattingProvider: matting,
    retouchProvider: retouch,
  });
  const jobId = await store.createJob({ sessionId, kind });
  return {
    config,
    store,
    storage,
    mattingProvider: matting,
    retouchProvider: retouch,
    pipeline,
    jobId,
    sessionId,
    async close() {
      await store.close();
    },
  };
}

export { imagelabConfig, testConfig, silent, tmpDir };
