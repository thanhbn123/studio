/**
 * `encodeGif` — BỘ MÃ HOÁ GIF89a THẬT, tự viết (hợp đồng MVP-04 §2.2).
 *
 * Không `gif-encoder`, không `sharp`, không `canvas`: chỉ `node:buffer` + LZW tự viết
 * (`./lzw.js`) + lượng tử hoá median-cut tự viết (`./quantize.js`).
 *
 * Cấu trúc file ghi ra (đúng chuẩn, mở được bằng trình xem ảnh thật):
 *
 *   "GIF89a"
 *   Logical Screen Descriptor (width, height, packed có cờ GCT, bg index, aspect)
 *   Global Color Table  — ≤ paletteSize màu, ĐỆM lên luỹ thừa 2 theo chuẩn
 *   Application Extension "NETSCAPE2.0"  → loop (0 = lặp vô hạn)
 *   với MỖI khung:
 *     Graphic Control Extension (disposal + delay = delayMs/10 đơn vị 1/100 giây)
 *     Image Descriptor (0,0,width,height — khung LUÔN phủ kín khung hình)
 *     LZW image data (minCodeSize + khối con ≤ 255 byte + 0x00)
 *   ";" (0x3B) — trailer
 *
 * Bảng màu là TOÀN CỤC cho mọi khung (một GCT) nên video không nhấp nháy bảng màu.
 * Cảnh báo (`warnings`) được ghi thẳng, không giấu: sai số màu trung bình vượt ngưỡng,
 * alpha bị làm phẳng, paletteSize bị kẹp trần 256, delay bị kẹp.
 */

import { Buffer } from 'node:buffer';
import { VideoEncodeError, ENCODE_CODES } from './errors.js';
import {
  DEFAULT_BACKGROUND,
  GIF_MAX_COLORS,
  averageColorError,
  buildHistogram,
  buildIndexLut,
  colorTableSize,
  mapFrames,
  medianCutPalette,
  minCodeSizeFor,
  normalizeBackground,
} from './quantize.js';
import { encodeLzwBlocks } from './lzw.js';

/** Ngưỡng sai số màu trung bình (0..255) — vượt thì PHẢI cảnh báo (hợp đồng §2.2). */
export const COLOR_ERROR_THRESHOLD = 8;
/** Trần số điểm ảnh một khung khi mã hoá trực tiếp (chống treo/RAM). */
export const MAX_GIF_PIXELS = 4096 * 4096;
/** Trần số khung một file GIF. */
export const MAX_GIF_FRAMES = 2000;

const toView = (value) =>
  Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : null;

const toInt = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : null;
};

/**
 * Chuẩn hoá `frames` — nhận CẢ HAI dạng (ghi rõ theo hợp đồng §2.2):
 *   1. `Buffer`/`Uint8Array` RGBA thuần;
 *   2. `{ rgba, delayMs }` (hoặc `{ data, delay_ms }`) — cho phép đặt delay riêng từng khung.
 *
 * @returns {{rgba:Buffer, delayMs:number|null}[]}
 */
export function normalizeGifFrames(frames) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new VideoEncodeError(ENCODE_CODES.BAD_INPUT, 'encodeGif cần `frames` là mảng không rỗng.');
  }
  if (frames.length > MAX_GIF_FRAMES) {
    throw new VideoEncodeError(
      ENCODE_CODES.TOO_MANY_FRAMES,
      `Quá nhiều khung cho một GIF: ${frames.length} (trần ${MAX_GIF_FRAMES}).`,
      { frames: frames.length, max: MAX_GIF_FRAMES },
    );
  }
  return frames.map((entry, index) => {
    if (entry === null || entry === undefined) {
      throw new VideoEncodeError(ENCODE_CODES.BAD_INPUT, `Khung #${index} rỗng.`, { index });
    }
    const view = toView(entry) ?? toView(entry.rgba ?? entry.data ?? entry.pixels ?? entry.buffer);
    if (!view) {
      throw new VideoEncodeError(
        ENCODE_CODES.BAD_INPUT,
        `Khung #${index} phải là Buffer RGBA hoặc { rgba, delayMs }.`,
        { index, keys: typeof entry === 'object' ? Object.keys(entry).slice(0, 10) : typeof entry },
      );
    }
    const rawDelay = entry.delayMs ?? entry.delay_ms ?? null;
    const delay = rawDelay === null ? null : Number(rawDelay);
    return { rgba: view, delayMs: Number.isFinite(delay) && delay >= 0 ? delay : null };
  });
}

/**
 * Mã hoá dãy khung RGBA thành GIF89a.
 *
 * @param {object} params
 * @param {Array<Buffer|Uint8Array|{rgba:Buffer,delayMs?:number}>} params.frames khung RGBA (w*h*4)
 * @param {number} [params.width]  bề rộng khung (thiếu thì lấy từ `frames[i].width`)
 * @param {number} [params.height] chiều cao khung
 * @param {number} [params.delayMs=100] thời gian mỗi khung (ms) — GCE ghi `round(delayMs/10)`
 * @param {number} [params.loop=0] 0 = lặp vô hạn (NETSCAPE2.0)
 * @param {number} [params.paletteSize=256] số màu tối đa của bảng màu toàn cục (2..256)
 * @param {boolean} [params.dither=false] bật Floyd–Steinberg (mặc định TẮT theo hợp đồng)
 * @param {number[]|string} [params.background='#000000'] màu nền khi phải làm phẳng alpha
 * @returns {{buffer:Buffer, mime:'image/gif', width:number, height:number, frames:number,
 *            bytes:number, palette_size:number, warnings:string[]}}
 */
export function encodeGif({
  frames,
  width,
  height,
  delayMs = 100,
  loop = 0,
  paletteSize = GIF_MAX_COLORS,
  dither = false,
  background = DEFAULT_BACKGROUND,
} = {}) {
  const warnings = [];
  const list = normalizeGifFrames(frames);

  // ── Kích thước khung: ưu tiên tham số, thiếu thì lấy từ chính khung (mọi khung phải khớp) ──
  let w = toInt(width);
  let h = toInt(height);
  if (w === null || h === null) {
    const first = frames[0];
    const fw = toInt(first?.width);
    const fh = toInt(first?.height);
    if (fw && fh) {
      w = fw;
      h = fh;
    }
  }
  if (!w || !h || w <= 0 || h <= 0) {
    throw new VideoEncodeError(
      ENCODE_CODES.BAD_INPUT,
      'encodeGif cần width/height là số nguyên dương (hoặc khung có `width`/`height`).',
      { width, height },
    );
  }
  const pixels = w * h;
  if (pixels > MAX_GIF_PIXELS) {
    throw new VideoEncodeError(
      ENCODE_CODES.IMAGE_TOO_LARGE,
      `Khung ${w}x${h} = ${pixels} pixel vượt trần ${MAX_GIF_PIXELS} pixel của bộ mã hoá GIF.`,
      { width: w, height: h, pixels, max: MAX_GIF_PIXELS },
    );
  }
  const need = pixels * 4;
  list.forEach((frame, index) => {
    if (frame.rgba.length !== need) {
      throw new VideoEncodeError(
        ENCODE_CODES.FRAME_SIZE_MISMATCH,
        `Khung #${index} có ${frame.rgba.length} byte, cần đúng ${need} byte cho ${w}x${h} RGBA.`,
        { index, expected: need, actual: frame.rgba.length, width: w, height: h },
      );
    }
  });

  // ── Bảng màu: kẹp paletteSize vào [2, 256] (GIF không thể nhiều hơn 256 màu) ──
  let colors = toInt(paletteSize);
  if (colors === null || colors < 2) {
    throw new VideoEncodeError(
      ENCODE_CODES.BAD_INPUT,
      `paletteSize phải ≥ 2 (nhận ${JSON.stringify(paletteSize)}).`,
      { paletteSize },
    );
  }
  if (colors > GIF_MAX_COLORS) {
    warnings.push(`paletteSize ${colors} vượt trần GIF 256 màu — đã kẹp về 256.`);
    colors = GIF_MAX_COLORS;
  }
  const bgColor = normalizeBackground(background);

  // ── Lượng tử hoá: histogram 15-bit toàn cục → median cut → LUT → chỉ số từng khung ──
  const { hist, pixels: sampled, flattened } = buildHistogram(
    list.map((f) => f.rgba),
    { width: w, height: h, background: bgColor },
  );
  const { palette, colors: paletteColors } = medianCutPalette(hist, colors);
  const lut = buildIndexLut(hist, palette, paletteColors);
  const { indices, errorSum, errorPixels } = mapFrames(list.map((f) => f.rgba), {
    width: w,
    height: h,
    palette,
    colors: paletteColors,
    lut,
    background: bgColor,
    dither: dither === true,
  });

  const avgError = averageColorError(errorSum, errorPixels);
  if (avgError > COLOR_ERROR_THRESHOLD) {
    warnings.push(
      `Sai số màu trung bình ${avgError.toFixed(2)}/255 vượt ngưỡng ${COLOR_ERROR_THRESHOLD} ` +
        `(lượng tử hoá median-cut, ${paletteColors} màu${dither ? ', có dither' : ', không dither'}).`,
    );
  }
  if (flattened > 0) {
    warnings.push(
      `Đã làm phẳng ${flattened} điểm ảnh có alpha < 255 lên màu nền ` +
        `rgb(${bgColor.join(',')}) — GIF không có kênh alpha.`,
    );
  }
  if (sampled === 0) {
    // Không thể xảy ra với khung hợp lệ, nhưng nói thẳng thay vì im lặng.
    warnings.push('Không đọc được điểm ảnh nào để lượng tử hoá màu.');
  }

  // ── Ghi file ──
  const tableSize = colorTableSize(paletteColors);
  const sizeField = Math.log2(tableSize) - 1; // 0..7 (GCT 2..256 mục)
  const minCodeSize = minCodeSizeFor(paletteColors);

  const header = Buffer.from('GIF89a', 'latin1');
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(w, 0);
  lsd.writeUInt16LE(h, 2);
  // bit7 = có GCT, bit6-4 = color resolution (8 bit/kênh ⇒ 7), bit3 = sort (0), bit0-2 = size
  lsd[4] = 0x80 | 0x70 | (sizeField & 0x07);
  lsd[5] = 0x00; // background color index
  lsd[6] = 0x00; // pixel aspect ratio (0 = vuông)

  const gct = Buffer.alloc(tableSize * 3);
  palette.copy(gct, 0, 0, Math.min(gct.length, palette.length));

  const loopCount = Number.isFinite(Number(loop)) && Number(loop) >= 0 ? Math.floor(Number(loop)) : 0;
  const netscape = Buffer.alloc(19);
  netscape[0] = 0x21; // extension introducer
  netscape[1] = 0xff; // application extension
  netscape[2] = 0x0b; // block size 11
  netscape.write('NETSCAPE2.0', 3, 'latin1');
  netscape[14] = 0x03; // sub-block size
  netscape[15] = 0x01; // sub-block id: loop
  netscape.writeUInt16LE(Math.min(0xffff, loopCount), 16);
  netscape[18] = 0x00; // block terminator

  const defaultDelay = Number.isFinite(Number(delayMs)) && Number(delayMs) >= 0 ? Number(delayMs) : 100;
  const parts = [header, lsd, gct, netscape];
  let delayDrift = 0; // lệch lớn nhất giữa delay yêu cầu và delay GIF thật ghi được (ms)
  let playbackMs = 0; // F6: TỔNG thời gian phát THẬT theo delay đã ghi vào GCE

  for (let index = 0; index < list.length; index += 1) {
    const rawDelay = list[index].delayMs ?? defaultDelay;
    // GIF lưu delay theo đơn vị 1/100 giây; 0 bị nhiều trình xem hiểu thành 100ms ⇒ tối thiểu 1.
    const units = Math.max(1, Math.min(0xffff, Math.round(rawDelay / 10)));
    delayDrift = Math.max(delayDrift, Math.abs(units * 10 - rawDelay));
    playbackMs += units * 10;

    const gce = Buffer.alloc(8);
    gce[0] = 0x21;
    gce[1] = 0xf9;
    gce[2] = 0x04;
    // disposal = 2 (restore to background): khung phủ kín khung hình nên luôn sạch, không lem khung trước.
    gce[3] = 0x02 << 2;
    gce.writeUInt16LE(units, 4);
    gce[6] = 0x00; // transparent color index (không dùng)
    gce[7] = 0x00;

    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(0, 1);
    desc.writeUInt16LE(0, 3);
    desc.writeUInt16LE(w, 5);
    desc.writeUInt16LE(h, 7);
    desc[9] = 0x00; // không có LCT, không interlace, không sort

    parts.push(gce, desc, encodeLzwBlocks(indices[index], minCodeSize));
  }
  parts.push(Buffer.from([0x3b])); // trailer

  const buffer = Buffer.concat(parts);
  // F6 (phản biện MVP-04, MINOR): nhịp phát THẬT ngắn hơn khai báo tới ~4% (83,33ms → 80ms) mà
  // trước đây KHÔNG hề nói ra (ngưỡng cảnh báo cũ 5ms/khung > 3,33ms thực tế). Nay:
  //   · luôn trả `playback_ms` (tổng thời gian phát thật) để tầng trên ghi vào `encode_summary`;
  //   · cảnh báo khi lệch ≥ 3ms/khung (thay vì 5ms) — vẫn trên độ phân giải 10ms của GIF.
  const requestedMs = list.reduce((sum, entry, index) => sum + (entry.delayMs ?? defaultDelay), 0);
  const playbackDriftMs = playbackMs - requestedMs;
  if (Math.abs(playbackDriftMs) >= 1) {
    warnings.push(
      `Nhịp phát THẬT của GIF là ${(playbackMs / 1000).toFixed(2)}s (khai báo ${(requestedMs / 1000).toFixed(2)}s; ` +
        `lệch ${playbackDriftMs > 0 ? '+' : ''}${(playbackDriftMs / 1000).toFixed(2)}s) — GIF chỉ ghi được delay theo bội số 10ms.`,
    );
  }
  if (delayDrift >= 3) {
    // Chỉ cảnh báo khi lệch ĐÁNG KỂ (≥ 3ms/khung): GIF chỉ có độ phân giải delay 10ms.
    warnings.push(
      `Delay bị làm tròn về bội số 10ms của GIF — lệch tối đa ${delayDrift.toFixed(1)}ms mỗi khung ` +
        `(nhịp thật có thể nhanh/chậm hơn yêu cầu).`,
    );
  }

  return {
    buffer,
    mime: 'image/gif',
    width: w,
    height: h,
    frames: list.length,
    bytes: buffer.length,
    palette_size: paletteColors,
    // F6: nhịp phát THẬT (tổng delay đã ghi) + yêu cầu — để tầng trên ghi `encode_summary` và UI
    // hiện “nhịp thật ≈ X giây” thay vì lặng lẽ nói sai.
    playback_ms: playbackMs,
    requested_ms: requestedMs,
    delay_drift_ms: delayDrift,
    warnings,
  };
}

export default encodeGif;
