/**
 * `renderFrames(plan, { loadImage, drawText })` — VẼ TỪNG KHUNG của `VideoPlan` (hợp đồng §2.2).
 *
 * Đây là phần "biến kịch bản thành pixel" của V2. Nó CHỈ ĐỌC `VideoPlan` của V1 theo đúng
 * các field đã đóng băng ở §2.1 (`fit_box`, `pad_color`, `transition_in`, `motion`, `texts[]`…),
 * KHÔNG import `src/videostudio/plan/**` (V1 chưa giao) nên không có phụ thuộc vòng.
 *
 * Bốn luật được giữ ở tầng pixel:
 *   1. **Không bóp méo**: ảnh chỉ được phóng ĐỀU hai trục (`scale` chung cho x và y) —
 *      `fit:'pad'` dùng tỉ lệ `contain` (viền `pad_color`), `fit:'crop'` dùng tỉ lệ `cover`
 *      (cắt phần thừa). Không bao giờ kéo giãn một trục.
 *   2. **Kích thước khung KHÔNG ĐỔI** giữa các khung: mọi khung là `plan.width × plan.height`.
 *   3. **Ảnh nguồn bất biến**: `loadImage` được gọi một lần cho mỗi `asset_id`; phần RGBA nhận
 *      được là BẢN SAO (`toRgba`/`Buffer.from`) và chỉ được ĐỌC — người gọi tự băm `sha256`
 *      trước/sau để kiểm chứng (bộ vẽ không bao giờ ghi vào ảnh gốc).
 *   4. **Không bịa chữ**: glyph thiếu thì `drawLayout` bỏ qua ký tự đó và ta ghi cảnh báo;
 *      việc chặn khẳng định thiếu bằng chứng (`VIDEO_TEXT_UNSUPPORTED_CLAIM`) là việc của V3
 *      khi dựng `texts[]` — ở đây chỉ vẽ đúng những gì kịch bản đã có.
 *
 * Hàm nhận `loadImage`/`drawText` **đồng bộ hoặc bất đồng bộ**: nếu `loadImage` trả Promise thì
 * `renderFrames` trả Promise; nếu trả giá trị thường thì trả MẢNG ngay (đúng chữ ký §2.2
 * `→ [{ index, rgba, width, height }]`). Cảnh báo chẩn đoán nằm ở `frames.warnings`
 * (thuộc tính KHÔNG enumerable nên không phá hình dạng mảng).
 *
 * `drawText(ctx)` (tuỳ chọn) thay cho bộ vẽ mặc định; `ctx` gồm:
 *   `{ pixels, width, height, text, spec, scene, plan, time_ms, alpha, box, align, size, color,
 *      font, defaultDraw() }` và có thể trả `{ drawn, missing, reason }`.
 */

import { Buffer } from 'node:buffer';
import { VideoEncodeError, ENCODE_CODES } from './errors.js';
import { decodePng } from '../../imagelab/render/png.js';
import { detectImageMime, normalizeColor, toRgba } from '../../imagelab/render/image.js';
import { loadFont } from '../../imagelab/render/font/index.js';
import { layoutText } from '../../imagelab/render/layout.js';
import { drawLayout } from '../../imagelab/render/draw.js';
import { intersectBoxWithImage, strictCoordinate } from '../../imagelab/geometry.js';

/** Trần số khung một lần vẽ (chống treo). */
export const MAX_RENDER_FRAMES = 3600;
/** Biên độ zoom mặc định cho `zoom-in`/`zoom-out` (±8%). */
export const DEFAULT_ZOOM = 0.08;
/** Hệ số phóng thêm khi pan (để có chỗ trôi mà không lộ nền). */
export const DEFAULT_PAN_ZOOM = 1.06;
/** Biên độ pan mặc định (tỉ lệ bề rộng nguồn). */
export const DEFAULT_PAN = 0.12;
/** Thời gian mờ dần mặc định của chữ `fade-in` (ms). */
export const DEFAULT_TEXT_FADE_MS = 300;
/** Thời gian chuyển cảnh mặc định khi `transition_in='fade'` mà thiếu `transition_ms` (ms). */
export const DEFAULT_TRANSITION_MS = 300;
/** Màu nền mặc định khi cảnh không khai `pad_color`. */
export const DEFAULT_PAD_COLOR = '#000000';

const isThenable = (value) => value !== null && typeof value === 'object' && typeof value.then === 'function';

/**
 * Chạy một generator "có thể đồng bộ, có thể bất đồng bộ": chỉ chuyển sang chế độ async khi
 * gặp Promise đầu tiên. Nhờ vậy `renderFrames` dùng được với cả `loadImage` sync lẫn async.
 * @private
 */
function runMaybeAsync(factory) {
  const iterator = factory();
  let step = iterator.next();
  if (step.done) return step.value;
  if (isThenable(step.value)) return continueAsync(iterator, step);
  for (;;) {
    step = iterator.next(step.value);
    if (step.done) return step.value;
    if (isThenable(step.value)) return continueAsync(iterator, step);
  }
}

/** @private */
async function continueAsync(iterator, step) {
  let current = step;
  while (!current.done) {
    // eslint-disable-next-line no-await-in-loop -- driver generator: phải chờ tuần tự
    const value = await current.value;
    current = iterator.next(value);
  }
  return current.value;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const finiteNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Tô kín một buffer RGBA bằng một màu. */
function fillColor(pixels, [r, g, b]) {
  const pattern = Buffer.from([r & 0xff, g & 0xff, b & 0xff, 0xff]);
  pixels.fill(pattern);
}

/** Tạo bản sao RGBA từ ảnh đã giải mã (KHÔNG bao giờ ghi ngược vào nguồn). */
function copyRgba(image) {
  return Buffer.from(image.data ?? image.rgba ?? image.pixels);
}

/**
 * Chuẩn hoá thứ mà `loadImage` trả về thành `{ width, height, rgba }`.
 * Nhận: Buffer/Uint8Array PNG (tự giải mã), ảnh đã giải mã `{width,height,channels,data}`,
 * hoặc `{width,height,rgba}`.
 */
/**
 * F3 — đếm điểm ảnh có `alpha < 255` của một ảnh nguồn đã chuẩn hoá (`{ width, height, rgba }`).
 * Trả `{ transparent, total }`; ảnh không có kênh alpha ⇒ `transparent = 0`.
 * @private
 */
function countSourceAlpha(source) {
  const total = Math.max(0, Number(source?.width) || 0) * Math.max(0, Number(source?.height) || 0);
  const rgba = source?.rgba;
  if (!rgba || total === 0) return { transparent: 0, total };
  let transparent = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 255) transparent += 1;
  }
  return { transparent, total };
}

function normalizeSource(loaded, assetId, { maxPixels, maxBytes } = {}) {
  if (!loaded) {
    throw new VideoEncodeError(
      ENCODE_CODES.IMAGE_LOAD_FAILED,
      `loadImage("${assetId}") không trả về dữ liệu ảnh.`,
      { asset_id: assetId },
    );
  }
  if (Buffer.isBuffer(loaded) || loaded instanceof Uint8Array) {
    const buf = Buffer.isBuffer(loaded)
      ? loaded
      : Buffer.from(loaded.buffer, loaded.byteOffset, loaded.byteLength);
    const mime = detectImageMime(buf);
    if (mime !== 'image/png') {
      throw new VideoEncodeError(
        ENCODE_CODES.IMAGE_UNSUPPORTED,
        `Ảnh "${assetId}" có định dạng ${mime ?? 'không nhận dạng'} — bộ vẽ chỉ giải mã được PNG ` +
          '(JPEG/WebP cần chuyển sang PNG trước).',
        { asset_id: assetId, mime },
      );
    }
    const decoded = decodePng(buf, { maxPixels, maxBytes });
    return { width: decoded.width, height: decoded.height, rgba: toRgba(decoded) };
  }
  if (typeof loaded === 'object' && finiteNumber(loaded.width) > 0 && finiteNumber(loaded.height) > 0) {
    const width = Math.floor(Number(loaded.width));
    const height = Math.floor(Number(loaded.height));
    if (loaded.rgba || loaded.pixels || loaded.data) {
      const data = loaded.rgba ?? loaded.pixels ?? loaded.data;
      const channels = Math.floor(Number(loaded.channels ?? 4)) || 4;
      if (channels === 4) return { width, height, rgba: copyRgba({ data }) };
      return { width, height, rgba: toRgba({ width, height, channels, data }) };
    }
  }
  throw new VideoEncodeError(
    ENCODE_CODES.IMAGE_UNSUPPORTED,
    `Dữ liệu ảnh của "${assetId}" không dùng được (cần Buffer PNG hoặc { width, height, data }).`,
    { asset_id: assetId },
  );
}

/** Chọn cảnh theo mốc thời gian (ms) — chịu được khe hở và mốc nằm ngoài. */
export function sceneAtTime(scenes, timeMs) {
  for (const scene of scenes) {
    if (timeMs >= scene.start_ms && timeMs < scene.end_ms) return scene;
  }
  let best = scenes[0];
  for (const scene of scenes) {
    if (scene.start_ms <= timeMs) best = scene;
  }
  return best;
}

/**
 * Hộp vẽ chữ — khớp ĐÚNG cách V1 (`plan/texts.js`) tính:
 *   - `x`,`y` là **góc trên-trái của hộp chữ** (V1 đã kẹp `x ≤ width - bề rộng chữ`);
 *   - hộp được ĐO bằng chính font 5x7 với cỡ `size` (V1 đo y hệt), nên chữ vẽ ra bắt đầu
 *     đúng tại `(x, y)` và không bao giờ tràn khung;
 *   - `align` áp dụng BÊN TRONG hộp (giống layout của MVP-02); vì hộp đúng bằng bề rộng chữ
 *     nên align gần như không dịch chữ — đúng như hộp mà V1 đã tính.
 * Thiếu `x`/`y` ⇒ canh giữa khung như mặc định của V1.
 *
 * @returns {{x:number,y:number,w:number,h:number,align:string,size:number}}
 */
export function textBoxFor(spec, width, height, { font = null, size = null } = {}) {
  const fontObj = font && typeof font.measure === 'function' ? font : loadFont('5x7');
  const align = ['left', 'center', 'right'].includes(spec?.align) ? spec.align : 'center';
  const scale = Math.max(1, Math.min(64, Math.round(finiteNumber(size ?? spec?.size) ?? 24)));
  const text = String(spec?.text ?? '');
  const rows = text.split('\n');
  const metrics = fontObj.measure(text);
  const inkHeight = Math.max(1, metrics.inkHeight);
  const stride = (inkHeight + 1) * scale;
  const maxChars = Math.max(1, ...rows.map((row) => Array.from(row).length));
  const measuredW = Math.min(width, maxChars * fontObj.advance * scale + 2);
  const measuredH = Math.min(height, rows.length * stride + 2);

  const defaultX = Math.floor((width - measuredW) / 2);
  const defaultY = Math.floor((height - measuredH) / 2);
  const x = Math.max(0, Math.min(Math.max(0, width - 1), Math.round(finiteNumber(spec?.x) ?? defaultX)));
  const y = Math.max(0, Math.min(Math.max(0, height - 1), Math.round(finiteNumber(spec?.y) ?? defaultY)));
  return {
    x,
    y,
    w: Math.max(1, Math.min(width - x, measuredW)),
    h: Math.max(1, Math.min(height - y, measuredH)),
    align,
    size: scale,
  };
}

/**
 * Vẽ bộ vẽ chữ MẶC ĐỊNH (font 5x7 tiếng Việt của MVP-02).
 * @returns {{drawn:number, missing:string[], reason:string|null}}
 */
export function defaultDrawText(ctx) {
  const { pixels, width, height, spec, box, font, alpha } = ctx;
  if (!spec || !spec.text || String(spec.text).trim() === '' || alpha <= 0) {
    return { drawn: 0, missing: [], reason: null };
  }
  const size = Math.max(1, Math.min(64, Math.round(finiteNumber(spec.size) ?? 24)));
  const layout = layoutText({
    text: spec.text,
    box: { x: box.x, y: box.y, w: box.w, h: box.h },
    font,
    options: { align: box.align, valign: 'top', maxFontSize: size, minFontSize: 1, padding: 0, lineGap: 1 },
  });
  if (!layout.lines || layout.lines.length === 0) {
    return { drawn: 0, missing: [], reason: layout.reason ?? 'TEXT_TOO_LONG' };
  }
  const ink = normalizeColor(spec.color);
  const color = [ink[0], ink[1], ink[2], Math.max(0, Math.min(255, Math.round(255 * alpha)))];
  const out = drawLayout(pixels, layout, { width, height, font, color });
  return { drawn: out.pixels, missing: out.missing, reason: null };
}

/**
 * Vẽ ảnh của một cảnh vào `pixels` theo `fit_box` (nội suy SONG TUYẾN tính + motion).
 * @private
 */
function drawSceneImage(pixels, width, height, source, scene) {
  const box = scene.box;
  const sw = source.width;
  const sh = source.height;
  const bw = box.w;
  const bh = box.h;
  const contain = Math.min(bw / sw, bh / sh);
  const cover = Math.max(bw / sw, bh / sh);
  let scale = scene.fit === 'crop' ? cover : contain;

  const progress = clamp01(scene.progress);
  let panX = 0;
  switch (scene.motion) {
    case 'zoom-in':
      scale *= 1 + scene.zoom * progress;
      break;
    case 'zoom-out':
      scale *= 1 + scene.zoom * (1 - progress);
      break;
    case 'pan-left':
    case 'pan-right': {
      scale *= scene.panZoom;
      const direction = scene.motion === 'pan-left' ? 1 : -1;
      panX = direction * scene.pan * sw * (progress - 0.5);
      break;
    }
    default:
      break;
  }

  const drawW = sw * scale;
  const drawH = sh * scale;
  const originX = box.x + (bw - drawW) / 2 - panX * scale;
  const originY = box.y + (bh - drawH) / 2;
  const invScale = 1 / scale;
  const crop = scene.fit === 'crop';
  const src = source.rgba;

  for (let dy = box.y; dy < box.y + bh; dy += 1) {
    const syRaw = (dy + 0.5 - originY) * invScale - 0.5;
    if (!crop && (syRaw < -0.5 || syRaw > sh - 0.5)) continue; // ngoài ảnh ⇒ giữ màu nền (pad)
    let v = syRaw;
    if (v < 0) v = 0;
    else if (v > sh - 1) v = sh - 1;
    const y0 = Math.floor(v);
    const y1 = Math.min(y0 + 1, sh - 1);
    const fy = v - y0;
    const row0 = y0 * sw;
    const row1 = y1 * sw;
    const dstBase = dy * width;

    for (let dx = box.x; dx < box.x + bw; dx += 1) {
      const sxRaw = (dx + 0.5 - originX) * invScale - 0.5;
      if (!crop && (sxRaw < -0.5 || sxRaw > sw - 0.5)) continue;
      let u = sxRaw;
      if (u < 0) u = 0;
      else if (u > sw - 1) u = sw - 1;
      const x0 = Math.floor(u);
      const x1 = Math.min(x0 + 1, sw - 1);
      const fx = u - x0;

      const i00 = (row0 + x0) * 4;
      const i10 = (row0 + x1) * 4;
      const i01 = (row1 + x0) * 4;
      const i11 = (row1 + x1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const alpha =
        (src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11) / 255;
      if (alpha <= 0) continue;
      const r = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
      const g = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
      const b = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
      const di = (dstBase + dx) * 4;
      if (alpha >= 0.999) {
        pixels[di] = r + 0.5;
        pixels[di + 1] = g + 0.5;
        pixels[di + 2] = b + 0.5;
        pixels[di + 3] = 255;
      } else {
        pixels[di] = r * alpha + pixels[di] * (1 - alpha) + 0.5;
        pixels[di + 1] = g * alpha + pixels[di + 1] * (1 - alpha) + 0.5;
        pixels[di + 2] = b * alpha + pixels[di + 2] * (1 - alpha) + 0.5;
        pixels[di + 3] = 255;
      }
    }
  }
}

/** Trộn hai lớp: `dst = prev*(1-alpha) + cur*alpha`. @private */
function blendLayers(dst, prev, alpha) {
  const keep = 1 - alpha;
  for (let i = 0; i < dst.length; i += 1) {
    dst[i] = prev[i] * keep + dst[i] * alpha + 0.5;
  }
}

/**
 * VẼ các khung của một `VideoPlan`.
 *
 * @param {object} plan `VideoPlan` (§2.1) — chỉ đọc
 * @param {{loadImage?:Function, drawText?:Function, options?:object}} [deps]
 * @returns {Array<{index:number, rgba:Buffer, width:number, height:number}>|Promise<...>}
 */
export function renderFrames(plan, deps = {}) {
  const { loadImage, drawText } = deps;
  // `font` nhận ở CẢ HAI chỗ: `deps.font` (V3 truyền thẳng) và `deps.options.font`.
  const options =
    deps.options && typeof deps.options === 'object'
      ? { font: deps.font, ...deps.options }
      : { font: deps.font };
  return runMaybeAsync(function* render() {
    const warnings = [];
    if (!plan || typeof plan !== 'object') {
      throw new VideoEncodeError(ENCODE_CODES.BAD_INPUT, 'renderFrames cần một VideoPlan.');
    }
    const width = Math.floor(finiteNumber(plan.width) ?? 0);
    const height = Math.floor(finiteNumber(plan.height) ?? 0);
    if (width <= 0 || height <= 0) {
      throw new VideoEncodeError(
        ENCODE_CODES.BAD_INPUT,
        `VideoPlan thiếu width/height hợp lệ (nhận ${plan.width}x${plan.height}).`,
        { width: plan.width, height: plan.height },
      );
    }
    const scenesIn = Array.isArray(plan.scenes) ? plan.scenes : [];
    if (scenesIn.length === 0) {
      throw new VideoEncodeError(ENCODE_CODES.BAD_INPUT, 'VideoPlan không có cảnh nào (scenes rỗng).');
    }

    const fpsRaw = finiteNumber(plan.fps);
    const fps = fpsRaw && fpsRaw > 0 ? fpsRaw : 12;
    if (!fpsRaw || fpsRaw <= 0) warnings.push(`VideoPlan thiếu fps — dùng mặc định ${fps}.`);

    let frameCount = Math.floor(finiteNumber(plan.frame_count) ?? 0);
    if (frameCount <= 0) {
      const durationMs = finiteNumber(plan.duration_ms);
      if (durationMs && durationMs > 0) frameCount = Math.round((durationMs / 1000) * fps);
      else frameCount = Math.round((Math.max(...scenesIn.map((s) => finiteNumber(s?.end_ms) ?? 0)) / 1000) * fps);
      if (frameCount > 0) warnings.push(`VideoPlan thiếu frame_count — suy ra ${frameCount} khung từ fps.`);
    }
    if (frameCount <= 0) {
      throw new VideoEncodeError(
        ENCODE_CODES.BAD_INPUT,
        'Không xác định được số khung (thiếu frame_count/duration_ms).',
      );
    }
    if (frameCount > MAX_RENDER_FRAMES) {
      throw new VideoEncodeError(
        ENCODE_CODES.TOO_MANY_FRAMES,
        `VideoPlan yêu cầu ${frameCount} khung, vượt trần vẽ ${MAX_RENDER_FRAMES}.`,
        { frame_count: frameCount, max: MAX_RENDER_FRAMES },
      );
    }

    const font =
      options.font && typeof options.font.getGlyph === 'function'
        ? options.font
        : loadFont(typeof options.font === 'string' ? options.font : '5x7');
    const zoom = finiteNumber(options.zoom) ?? DEFAULT_ZOOM;
    const panZoom = finiteNumber(options.panZoom) ?? DEFAULT_PAN_ZOOM;
    const pan = finiteNumber(options.pan) ?? DEFAULT_PAN;
    const textFadeMs = Math.max(1, finiteNumber(options.textFadeMs) ?? DEFAULT_TEXT_FADE_MS);

    // ── (1) Chuẩn bị cảnh: mốc thời gian, hộp vẽ, màu nền, cửa sổ chữ ──
    const scenes = [];
    for (let i = 0; i < scenesIn.length; i += 1) {
      const raw = scenesIn[i] ?? {};
      const index = Number.isFinite(Number(raw.index)) ? Number(raw.index) : i;
      const startMs = finiteNumber(raw.start_ms) ?? (i === 0 ? 0 : scenes[i - 1].end_ms);
      const durationMs = finiteNumber(raw.duration_ms);
      let endMs = finiteNumber(raw.end_ms);
      if (endMs === null) endMs = startMs + (durationMs && durationMs > 0 ? durationMs : 1000 / fps);
      if (endMs <= startMs) {
        warnings.push(`Cảnh #${index} có end_ms ≤ start_ms — đã nới thành 1 khung.`);
        endMs = startMs + 1000 / fps;
      }

      const fit = raw.fit === 'crop' ? 'crop' : 'pad';
      const padIn = raw.pad_color;
      const pad = normalizeColor(padIn ?? DEFAULT_PAD_COLOR, [0, 0, 0, 255]);
      if (padIn !== undefined && padIn !== null && String(padIn).trim() !== '' && !/^#?[0-9a-f]{3}([0-9a-f]{3})?$/i.test(String(padIn).trim())) {
        warnings.push(`Cảnh #${index}: pad_color ${JSON.stringify(padIn)} không đọc được — dùng màu đen.`);
      }

      // Hộp ảnh: ưu tiên `fit_box` của V1; thiếu/sai thì suy ra và nói rõ.
      let box = null;
      const fb = raw.fit_box;
      if (fb && typeof fb === 'object') {
        const candidate = {
          x: strictCoordinate(fb.x),
          y: strictCoordinate(fb.y),
          w: strictCoordinate(fb.w),
          h: strictCoordinate(fb.h),
        };
        if ([candidate.x, candidate.y, candidate.w, candidate.h].every((v) => v !== null) && candidate.w > 0 && candidate.h > 0) {
          box = intersectBoxWithImage(
            { x: Math.round(candidate.x), y: Math.round(candidate.y), w: Math.round(candidate.w), h: Math.round(candidate.h) },
            width,
            height,
          );
        }
      }
      if (!box) {
        box = { x: 0, y: 0, w: width, h: height };
        warnings.push(`Cảnh #${index}: thiếu fit_box hợp lệ — dùng toàn khung ${width}x${height}.`);
      }

      const transitionIn = raw.transition_in === 'fade' ? 'fade' : 'cut';
      const transitionMs = Math.max(0, finiteNumber(raw.transition_ms) ?? DEFAULT_TRANSITION_MS);
      if (transitionIn === 'fade' && i === 0) {
        warnings.push('Cảnh đầu khai transition_in="fade" nhưng không có cảnh trước — vẽ như "cut".');
      }

      const texts = [];
      for (const spec of Array.isArray(raw.texts) ? raw.texts : []) {
        if (!spec || typeof spec !== 'object') continue;
        if (!spec.text || String(spec.text).trim() === '') continue;
        // MỐC THỜI GIAN CHỮ: V1 (`plan/texts.js`) ghi mốc **TƯƠNG ĐỐI trong cảnh**
        // (`start_ms`/`end_ms` bị kẹp trong `[0, duration_ms]` của chính cảnh). Ta mặc định
        // hiểu theo TƯƠNG ĐỐI, nhưng nếu cửa sổ đó không giao cảnh thì thử hiểu TUYỆT ĐỐI —
        // nhờ vậy nhận được cả hai kiểu kịch bản mà không cần V1/V3 phải khai báo gì thêm.
        const rawStart = finiteNumber(spec.start_ms);
        const rawEnd = finiteNumber(spec.end_ms);
        let s = rawStart === null ? startMs : startMs + rawStart;
        let e = rawEnd === null ? endMs : startMs + rawEnd;
        if (e <= startMs || s >= endMs) {
          const absS = rawStart === null ? startMs : rawStart;
          const absE = rawEnd === null ? endMs : rawEnd;
          if (absE > startMs && absS < endMs) {
            s = absS;
            e = absE;
          } else {
            warnings.push(
              `Cảnh #${index}: chữ "${String(spec.text).slice(0, 24)}" nằm ngoài cảnh ` +
                `(${rawStart ?? 0}..${rawEnd ?? 0}ms) — không vẽ.`,
            );
            continue;
          }
        }
        const boxText = textBoxFor(spec, width, height, { font, size: spec.size });
        if (boxText.w < 8 || boxText.h < 4) {
          warnings.push(`Cảnh #${index}: hộp chữ "${String(spec.text).slice(0, 24)}" quá nhỏ — bỏ qua.`);
          continue;
        }
        const animation = spec.animation === 'fade-in' ? 'fade-in' : 'none';
        texts.push({
          spec,
          start: s,
          end: e,
          box: boxText,
          animation,
          fadeMs: animation === 'fade-in' ? Math.min(textFadeMs, Math.max(1, e - s)) : 0,
        });
      }

      scenes.push({
        index,
        start_ms: startMs,
        end_ms: endMs,
        duration_ms: endMs - startMs,
        fit,
        box,
        pad,
        motion: typeof raw.motion === 'string' ? raw.motion : 'none',
        transitionIn,
        transitionMs,
        asset_id: raw.asset_id ?? null,
        source: null,
        zoom,
        pan,
        panZoom,
        progress: 0,
        texts,
      });
    }

    // ── (2) Nạp ảnh (mỗi asset_id một lần) — KHÔNG sửa ảnh nguồn ──
    const cache = new Map();
    for (const scene of scenes) {
      if (!scene.asset_id) continue;
      if (cache.has(scene.asset_id)) {
        scene.source = cache.get(scene.asset_id);
        continue;
      }
      if (typeof loadImage !== 'function') {
        throw new VideoEncodeError(
          ENCODE_CODES.IMAGE_LOAD_FAILED,
          `Cảnh #${scene.index} cần ảnh "${scene.asset_id}" nhưng renderFrames không được truyền loadImage.`,
          { asset_id: scene.asset_id },
        );
      }
      let loaded;
      try {
        loaded = yield loadImage(scene.asset_id);
      } catch (err) {
        if (err instanceof VideoEncodeError) throw err;
        throw new VideoEncodeError(
          ENCODE_CODES.IMAGE_LOAD_FAILED,
          `Không nạp được ảnh cho cảnh #${scene.index}: ${err?.message ?? err}`,
          { asset_id: scene.asset_id },
        );
      }
      const source = normalizeSource(loaded, scene.asset_id, options);
      cache.set(scene.asset_id, source);
      scene.source = source;
    }

    // ── (2b) F3 (phản biện MVP-04, MAJOR): ALPHA CỦA ẢNH NGUỒN ──
    // GIF không có kênh alpha ⇒ pixel `alpha < 255` bị LÀM PHẲNG lên màu nền của cảnh
    // (`pad_color`) ngay trong `drawSceneImage`. Trước đây KHÔNG có cảnh báo nào ⇒ PNG trong suốt
    // (ví dụ đầu ra đã tách nền của MVP-03, alpha = 0) cho ra video NỀN ĐEN mà người dùng không
    // biết vì sao. Đếm MỘT LẦN cho mỗi ảnh nguồn (theo `asset_id`) rồi cảnh báo cho từng cảnh.
    const alphaWarned = new Set();
    for (const scene of scenes) {
      if (!scene.source || !scene.asset_id || alphaWarned.has(scene.asset_id)) continue;
      alphaWarned.add(scene.asset_id);
      const stats = countSourceAlpha(scene.source);
      if (stats.transparent === 0) continue;
      const hex = `#${[scene.pad[0], scene.pad[1], scene.pad[2]].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
      const fully = stats.transparent === stats.total;
      warnings.push(
        `Cảnh #${scene.index}: ảnh nguồn có ${stats.transparent}/${stats.total} điểm ảnh TRONG SUỐT hoặc bán trong suốt (alpha < 255)` +
          `${fully ? ' — ảnh trong suốt HOÀN TOÀN' : ''}. GIF không có kênh alpha nên các điểm ảnh đó đã được LÀM PHẲNG lên màu nền ${hex}` +
          ` (đặt \`plan.scenes[${scene.index}].pad_color\` để đổi màu nền).`,
      );
    }

    // ── (3) Vẽ từng khung ──
    const canvas = Buffer.alloc(width * height * 4);
    const previous = Buffer.alloc(width * height * 4);
    const frames = [];

    const drawLayer = (target, scene, timeMs) => {
      fillColor(target, scene.pad);
      scene.progress = clamp01((timeMs - scene.start_ms) / Math.max(1, scene.duration_ms));
      if (scene.source) drawSceneImage(target, width, height, scene.source, scene);
      for (const item of scene.texts) {
        if (timeMs < item.start || timeMs > item.end) continue;
        const alpha = item.fadeMs > 0 ? clamp01((timeMs - item.start) / item.fadeMs) : 1;
        if (alpha <= 0) continue;
        const ctx = {
          pixels: target,
          width,
          height,
          text: String(item.spec.text),
          spec: item.spec,
          scene,
          plan,
          time_ms: timeMs,
          alpha,
          box: item.box,
          align: item.box.align,
          size: Math.max(1, Math.min(64, Math.round(finiteNumber(item.spec.size) ?? 24))),
          color: normalizeColor(item.spec.color),
          font,
          defaultDraw: () => defaultDrawText(ctx),
        };
        let result;
        try {
          result = typeof drawText === 'function' ? drawText(ctx) : defaultDrawText(ctx);
        } catch (err) {
          throw new VideoEncodeError(
            ENCODE_CODES.TEXT_DRAW_FAILED,
            `Vẽ chữ thất bại ở cảnh #${scene.index}: ${err?.message ?? err}`,
            { text: String(item.spec.text).slice(0, 60) },
          );
        }
        if (result && Array.isArray(result.missing) && result.missing.length > 0) {
          const note = `Cảnh #${scene.index}: chữ "${String(item.spec.text).slice(0, 24)}" thiếu glyph ${result.missing.join(' ')} — đã bỏ qua ký tự đó.`;
          if (!warnings.includes(note)) warnings.push(note);
        }
        if (result && result.reason) {
          const note = `Cảnh #${scene.index}: không xếp được chữ "${String(item.spec.text).slice(0, 24)}" (${result.reason}).`;
          if (!warnings.includes(note)) warnings.push(note);
        }
      }
    };

    for (let index = 0; index < frameCount; index += 1) {
      const timeMs = (index * 1000) / fps;
      const scene = sceneAtTime(scenes, timeMs);
      drawLayer(canvas, scene, timeMs);

      if (scene.transitionIn === 'fade' && scene.transitionMs > 0) {
        const position = scenes.indexOf(scene);
        const prev = position > 0 ? scenes[position - 1] : null;
        if (prev) {
          const alpha = clamp01((timeMs - scene.start_ms) / scene.transitionMs);
          if (alpha < 1) {
            drawLayer(previous, prev, Math.max(prev.start_ms, prev.end_ms - 1));
            blendLayers(canvas, previous, alpha);
          }
        }
      }
      frames.push({ index, rgba: Buffer.from(canvas), width, height });
    }

    // Cảnh báo chẩn đoán: thuộc tính KHÔNG enumerable ⇒ không phá hình dạng mảng của hợp đồng.
    Object.defineProperty(frames, 'warnings', { value: warnings, enumerable: false });
    Object.defineProperty(frames, 'meta', {
      value: { width, height, fps, frame_count: frameCount, scenes: scenes.length },
      enumerable: false,
    });
    return frames;
  });
}

export default renderFrames;
