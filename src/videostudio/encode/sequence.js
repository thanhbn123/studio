/**
 * `writeFrameSequence` — ghi chuỗi khung PNG ra đĩa (hợp đồng MVP-04 §2.2).
 *
 * Luật cứng: **không bao giờ ghi ra ngoài `IMAGELAB_DIR`**. Thư mục đích được
 * `path.resolve` rồi kiểm phải nằm TRONG thư mục gốc (`rootDir`, mặc định lấy từ
 * `IMAGELAB_DIR` / `config.imagelab.dir`) — nếu không ⇒ `UNSAFE_PATH`.
 *
 * Hàm chạy ĐỒNG BỘ (trả thẳng `{ files, bytes }`) nên `await` cũng dùng được — hợp đồng
 * §2.2 ghi `→ { files, bytes }` không có Promise. Ghi kiểu nguyên tử: file tạm `.tmp`
 * rồi `rename`, quyền 0o600, thư mục 0o700 (giống `src/imagelab/storage.js`).
 *
 * Tên file: `<prefix>_<số thứ tự>.png`, số thứ tự bắt đầu từ 1 và đệm `digits` chữ số
 * (mặc định `frame_0001.png`) — khớp mẫu `%04d` mà ffmpeg hiểu.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { VideoEncodeError, ENCODE_CODES } from './errors.js';
import { encodePng } from '../../imagelab/render/png.js';

/** Ký tự an toàn cho tiền tố tên file. */
const PREFIX_RE = /^[A-Za-z0-9_-]{1,32}$/;
/** Trần số khung ghi ra đĩa một lần. */
export const MAX_SEQUENCE_FRAMES = 3600;

const toView = (value) =>
  Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : null;

/** Thư mục gốc cho phép ghi: `rootDir` → `IMAGELAB_DIR` → `./data/imagelab`. */
export function resolveSequenceRoot(rootDir) {
  const explicit = typeof rootDir === 'string' && rootDir.trim() !== '' ? rootDir : null;
  const fromEnv = typeof process.env.IMAGELAB_DIR === 'string' && process.env.IMAGELAB_DIR.trim() !== ''
    ? process.env.IMAGELAB_DIR
    : null;
  return path.resolve(explicit ?? fromEnv ?? './data/imagelab');
}

/**
 * Ghi chuỗi khung RGBA thành các file PNG.
 *
 * @param {object} params
 * @param {Array<Buffer|Uint8Array|{rgba:Buffer,width?:number,height?:number}>} params.frames
 * @param {string} params.dir thư mục đích (BẮT BUỘC nằm trong `IMAGELAB_DIR`)
 * @param {string} [params.prefix='frame']
 * @param {number} [params.digits=4]
 * @param {number} [params.width]  bề rộng khung (nếu khung không tự khai)
 * @param {number} [params.height] chiều cao khung
 * @param {string} [params.rootDir] ghi đè thư mục gốc cho phép (mặc định `IMAGELAB_DIR`)
 * @returns {{files:string[], bytes:number}}
 */
export function writeFrameSequence({
  frames,
  dir,
  prefix = 'frame',
  digits = 4,
  width,
  height,
  rootDir,
} = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new VideoEncodeError(ENCODE_CODES.BAD_INPUT, 'writeFrameSequence cần `frames` là mảng không rỗng.');
  }
  if (frames.length > MAX_SEQUENCE_FRAMES) {
    throw new VideoEncodeError(
      ENCODE_CODES.TOO_MANY_FRAMES,
      `Quá nhiều khung để ghi ra đĩa: ${frames.length} (trần ${MAX_SEQUENCE_FRAMES}).`,
      { frames: frames.length, max: MAX_SEQUENCE_FRAMES },
    );
  }
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new VideoEncodeError(ENCODE_CODES.BAD_INPUT, 'writeFrameSequence cần `dir` là đường dẫn thư mục.');
  }
  if (!PREFIX_RE.test(String(prefix))) {
    throw new VideoEncodeError(
      ENCODE_CODES.BAD_INPUT,
      `prefix không hợp lệ (chỉ [A-Za-z0-9_-], tối đa 32 ký tự): ${JSON.stringify(String(prefix))}`,
    );
  }
  const pad = Math.floor(Number(digits));
  if (!Number.isFinite(pad) || pad < 1 || pad > 8) {
    throw new VideoEncodeError(ENCODE_CODES.BAD_INPUT, `digits phải trong 1..8 (nhận ${digits}).`);
  }

  const root = resolveSequenceRoot(rootDir);
  const target = path.resolve(dir);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new VideoEncodeError(
      ENCODE_CODES.UNSAFE_PATH,
      `Từ chối ghi ngoài IMAGELAB_DIR: "${target}" không nằm trong "${root}".`,
      { dir: target, root },
    );
  }

  try {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new VideoEncodeError(
      ENCODE_CODES.WRITE_FAILED,
      `Không tạo được thư mục "${target}": ${err.message}`,
      { dir: target },
    );
  }

  const sharedWidth = Math.floor(Number(width)) || 0;
  const sharedHeight = Math.floor(Number(height)) || 0;
  const files = [];
  let bytes = 0;

  for (let index = 0; index < frames.length; index += 1) {
    const entry = frames[index];
    const view = toView(entry) ?? toView(entry?.rgba ?? entry?.data ?? entry?.pixels);
    if (!view) {
      throw new VideoEncodeError(
        ENCODE_CODES.BAD_INPUT,
        `Khung #${index} phải là Buffer RGBA hoặc { rgba, width, height }.`,
        { index },
      );
    }
    const w = Math.floor(Number(entry?.width)) || sharedWidth;
    const h = Math.floor(Number(entry?.height)) || sharedHeight;
    if (!w || !h) {
      throw new VideoEncodeError(
        ENCODE_CODES.BAD_INPUT,
        `Khung #${index} thiếu width/height (truyền width/height cho cả chuỗi khung).`,
        { index },
      );
    }
    if (view.length !== w * h * 4) {
      throw new VideoEncodeError(
        ENCODE_CODES.FRAME_SIZE_MISMATCH,
        `Khung #${index} có ${view.length} byte, cần ${w * h * 4} byte cho ${w}x${h} RGBA.`,
        { index, expected: w * h * 4, actual: view.length },
      );
    }

    const png = encodePng({ width: w, height: h, data: view, channels: 4 });
    const name = `${prefix}_${String(index + 1).padStart(pad, '0')}.png`;
    const file = path.join(target, name);
    const tmp = path.join(target, `.${name}.${process.pid}.tmp`);
    try {
      fs.writeFileSync(tmp, png, { flag: 'w', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* dọn file tạm thất bại — không che lỗi chính */
      }
      throw new VideoEncodeError(
        ENCODE_CODES.WRITE_FAILED,
        `Không ghi được khung #${index} ("${file}"): ${err.message}`,
        { file },
      );
    }
    files.push(file);
    bytes += png.length;
  }

  return { files, bytes };
}

export default writeFrameSequence;
