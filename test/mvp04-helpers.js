/**
 * Tiện ích dùng chung cho bộ test MVP-04 (Video Studio — phần OFFLINE).
 *
 * Hai nhóm chính:
 *  1. **Bộ ĐỌC GIF ĐỘC LẬP** (`decodeGifFile`) — tự parse khối GIF + tự giải LZW, KHÔNG dùng
 *     `src/videostudio/encode/lzw.js` hay `inspect.js`. Nhờ vậy test chứng minh được file do
 *     `encodeGif` ghi ra là GIF THẬT (số khung, bảng màu, chỉ số màu từng điểm ảnh) chứ không
 *     phải "hai bên cùng sai một kiểu rồi khớp nhau".
 *  2. **Dữ liệu tất định** (LCG + bảng màu nằm ĐÚNG ô histogram 5-bit) để mọi khẳng định về
 *     pixel lặp lại được byte-for-byte giữa các lần chạy.
 *
 * File này không có hậu tố `.test.js` nên `node --test test/*.test.js` không chạy nó.
 */

import { cookie, j } from './imagelab-helpers.js';

/* ───────────────────────────── dữ liệu tất định ───────────────────────────── */

/** Bộ sinh số giả ngẫu nhiên TẤT ĐỊNH (LCG) — cùng seed ⇒ cùng dãy byte. */
export function lcg(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * 8 màu mà histogram 5-bit của bộ lượng tử hoá biểu diễn CHÍNH XÁC (mỗi kênh là giá trị
 * `(bin << 3) | (bin >> 2)`), nhờ vậy lượng tử hoá median-cut không mất màu và phép so
 * pixel↔bảng màu là so ĐÚNG.
 */
export const EXACT_COLORS = Object.freeze([
  [0, 0, 0],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [33, 66, 99],
  [132, 165, 198],
  [231, 255, 33],
  [66, 132, 198],
]);

/** Khung RGBA tất định: mỗi điểm ảnh chọn một màu trong `colors` theo LCG. */
export function rgbaFromColors({ width, height, colors = EXACT_COLORS, seed = 1 } = {}) {
  const rand = lcg(seed);
  const buffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const color = colors[Math.floor(rand() * colors.length) % colors.length];
    buffer[i * 4] = color[0];
    buffer[i * 4 + 1] = color[1];
    buffer[i * 4 + 2] = color[2];
    buffer[i * 4 + 3] = color[3] ?? 255;
  }
  return buffer;
}

/** Khung RGBA một màu phẳng. */
export function solidRgba(width, height, rgba) {
  const buffer = Buffer.alloc(width * height * 4);
  const pattern = Buffer.from([rgba[0] & 0xff, rgba[1] & 0xff, rgba[2] & 0xff, rgba[3] ?? 255]);
  buffer.fill(pattern);
  return buffer;
}

/** Khung RGBA ngẫu nhiên nhiều màu (mặc định kênh 0..255 ⇒ gần như mọi điểm ảnh khác nhau). */
export function noisyRgba({ width, height, seed = 7, levels = 256 } = {}) {
  const rand = lcg(seed);
  const buffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    buffer[i * 4] = Math.floor(rand() * levels) & 0xff;
    buffer[i * 4 + 1] = Math.floor(rand() * levels) & 0xff;
    buffer[i * 4 + 2] = Math.floor(rand() * levels) & 0xff;
    buffer[i * 4 + 3] = 255;
  }
  return buffer;
}

/* ───────────────────────── bộ đọc GIF ĐỘC LẬP ───────────────────────── */

/**
 * Giải một dòng LZW của GIF (LSB-first, có nhánh KwKwK và nhánh từ điển đầy ⇒ clear).
 * Viết theo chuẩn, KHÔNG import mã nguồn của repo.
 *
 * @returns {{indices:Uint8Array, resets:number}} `resets` = số lần gặp clear code GIỮA dòng
 *          (bằng chứng đường "từ điển đầy 4096 ⇒ reset" đã chạy).
 */
export function lzwDecode(data, minCodeSize, expected) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  const prefix = new Int32Array(4096).fill(-1);
  const suffix = new Int32Array(4096);
  for (let i = 0; i < clear; i += 1) suffix[i] = i;

  const out = new Uint8Array(expected);
  let outLen = 0;
  let prev = -1;
  let resets = 0;
  let acc = 0;
  let accBits = 0;
  let pos = 0;
  const stack = new Uint8Array(4097);

  const readCode = () => {
    while (accBits < codeSize) {
      if (pos >= data.length) return -1;
      acc |= data[pos] << accBits;
      pos += 1;
      accBits += 8;
    }
    const code = acc & ((1 << codeSize) - 1);
    acc >>>= codeSize;
    accBits -= codeSize;
    return code;
  };

  for (;;) {
    const code = readCode();
    if (code < 0) throw new Error('dòng LZW hết bit trước mã kết thúc');
    if (code === clear) {
      if (prev >= 0) resets += 1;
      codeSize = minCodeSize + 1;
      next = end + 1;
      prev = -1;
      continue;
    }
    if (code === end) break;

    let sp = 0;
    let first;
    if (code < next) {
      let c = code;
      while (c >= clear) {
        stack[sp] = suffix[c];
        sp += 1;
        c = prefix[c];
        if (sp > 4096) throw new Error('chuỗi LZW có vòng lặp');
      }
      stack[sp] = c;
      sp += 1;
      first = c;
    } else if (code === next && prev >= 0) {
      // KwKwK: chuỗi = chuỗi trước + ký tự đầu của chính nó.
      sp = 1;
      let c = prev;
      while (c >= clear) {
        stack[sp] = suffix[c];
        sp += 1;
        c = prefix[c];
      }
      stack[sp] = c;
      sp += 1;
      first = c;
      stack[0] = first;
    } else {
      throw new Error(`mã LZW không hợp lệ: ${code} (từ điển có ${next} mã)`);
    }

    for (let i = sp - 1; i >= 0; i -= 1) {
      if (outLen >= expected) throw new Error('LZW giải ra nhiều điểm ảnh hơn khai báo');
      out[outLen] = stack[i];
      outLen += 1;
    }
    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = first;
      next += 1;
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    prev = code;
  }

  if (outLen !== expected) throw new Error(`LZW giải ra ${outLen} điểm ảnh, khai báo ${expected}`);
  return { indices: out, resets };
}

/**
 * Đọc TRỌN một file GIF bằng tay: header → LSD → GCT → extension (GCE/NETSCAPE) → khung → trailer.
 *
 * @returns {{version:string, width:number, height:number, gct:Buffer, gctEntries:number,
 *            loop:number|null, trailer:boolean, frames:Array<{indices:Uint8Array,delayCs:number,
 *            width:number,height:number,left:number,top:number,minCodeSize:number,resets:number}>}}
 */
export function decodeGifFile(buffer) {
  const view = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const signature = view.toString('latin1', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') throw new Error(`không phải GIF: "${signature}"`);
  const width = view.readUInt16LE(6);
  const height = view.readUInt16LE(8);
  const packed = view[10];
  const gctEntries = packed & 0x80 ? 1 << ((packed & 0x07) + 1) : 0;
  const gct = view.subarray(13, 13 + gctEntries * 3);
  let offset = 13 + gctEntries * 3;

  const frames = [];
  let loop = null;
  let trailer = false;
  let pendingDelayCs = 0;

  const readSubBlocks = () => {
    const parts = [];
    for (;;) {
      if (offset >= view.length) throw new Error('khối con vượt biên file');
      const size = view[offset];
      offset += 1;
      if (size === 0) break;
      parts.push(view.subarray(offset, offset + size));
      offset += size;
    }
    return Buffer.concat(parts);
  };

  while (offset < view.length) {
    const introducer = view[offset];
    if (introducer === 0x3b) {
      trailer = true;
      break;
    }
    if (introducer === 0x21) {
      const label = view[offset + 1];
      offset += 2;
      if (label === 0xf9) {
        const size = view[offset];
        if (size !== 4) throw new Error(`Graphic Control Extension sai kích thước: ${size}`);
        const delayCs = view.readUInt16LE(offset + 2);
        offset += 1 + size;
        if (view[offset] !== 0) throw new Error('Graphic Control Extension thiếu terminator');
        offset += 1;
        pendingDelayCs = delayCs;
      } else {
        const size = view[offset];
        const appId = view.toString('latin1', offset + 1, offset + 1 + size);
        offset += 1 + size;
        const data = readSubBlocks();
        if ((appId.startsWith('NETSCAPE2.0') || appId.startsWith('ANIMEXTS1.0')) && data[0] === 0x01) {
          loop = data.readUInt16LE(1);
        }
      }
      continue;
    }
    if (introducer === 0x2c) {
      const left = view.readUInt16LE(offset + 1);
      const top = view.readUInt16LE(offset + 3);
      const fw = view.readUInt16LE(offset + 5);
      const fh = view.readUInt16LE(offset + 7);
      const fPacked = view[offset + 9];
      offset += 10;
      if (fPacked & 0x80) offset += (1 << ((fPacked & 0x07) + 1)) * 3; // bảng màu cục bộ
      const minCodeSize = view[offset];
      offset += 1;
      const data = readSubBlocks();
      const decoded = lzwDecode(data, minCodeSize, fw * fh);
      frames.push({
        left,
        top,
        width: fw,
        height: fh,
        minCodeSize,
        indices: decoded.indices,
        resets: decoded.resets,
        delayCs: pendingDelayCs,
      });
      pendingDelayCs = 0;
      continue;
    }
    throw new Error(`khối GIF không nhận dạng: 0x${introducer.toString(16)}`);
  }

  return { version: signature.slice(3), width, height, gct, gctEntries, loop, trailer, frames };
}

/** Màu RGB của một điểm ảnh trong khung đã giải (tra bảng màu toàn cục). */
export function gifPixel(parsed, frameIndex, x, y) {
  const frame = parsed.frames[frameIndex];
  const index = frame.indices[y * frame.width + x];
  return [parsed.gct[index * 3], parsed.gct[index * 3 + 1], parsed.gct[index * 3 + 2]];
}

/* ───────────────────────── HTTP tiện ích (MVP-04) ───────────────────────── */

/** Session id hợp lệ (cookie `sid`) — cố định để test tất định. */
export const VS_SID = 'sessVSAAAAA0000000001';
export const VS_SID_OTHER = 'sessVSBBBBB0000000002';

/** Gọi HTTP JSON thô với cookie `sid` (không dùng jar). */
export async function vsHttp(base, path, { method = 'GET', body, sid = VS_SID, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...cookie(sid), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res;
}

/** Tạo job video; trả `{ http_status, ...body }` (field `status` của 202 là trạng thái JOB). */
export async function createVideoJob(base, body, sid = VS_SID) {
  const res = await vsHttp(base, '/api/videostudio/jobs', { method: 'POST', body, sid });
  return { http_status: res.status, ...(await j(res)) };
}

/** Poll job video tới khi rời `queued|running` (như UI thật). */
export async function waitVideoJob(base, jobId, sid = VS_SID, { tries = 1200, delay = 25 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    last = await j(await vsHttp(base, `/api/videostudio/jobs/${jobId}`, { sid }));
    const status = last?.job?.status;
    if (status && !['queued', 'running'].includes(status)) return last;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`job video ${jobId} không kết thúc kịp: ${JSON.stringify(last)?.slice(0, 300)}`);
}

/** Tải tệp của một asset video về Buffer (kèm mã HTTP + content-type). */
export async function fetchVideoAsset(base, assetId, sid = VS_SID) {
  const res = await fetch(`${base}/api/videostudio/assets/${encodeURIComponent(String(assetId))}/file`, {
    headers: cookie(sid),
  });
  const buffer = res.status === 200 ? Buffer.from(await res.arrayBuffer()) : null;
  return { status: res.status, content_type: res.headers.get('content-type'), buffer };
}

/** Kích thước PNG trong bộ nhớ (không cần thư viện): đọc IHDR. */
export function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  if (buffer.toString('latin1', 1, 4) !== 'PNG') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
