/**
 * `inspectGif` — BỘ ĐỌC GIF ĐỘC LẬP (hợp đồng MVP-04 §2.2).
 *
 * Vì sao phải "độc lập": hợp đồng §2.2 yêu cầu dùng chính bộ đọc này để CHỨNG MINH file
 * do `encodeGif` ghi ra là thật. Nếu bộ đọc gọi lại hàm ghi (hoặc dùng chung bảng mã LZW)
 * thì lời chứng minh là vô nghĩa — hai bên cùng sai một kiểu vẫn "khớp".
 * Vì vậy file này:
 *   - parse khối GIF bằng tay (header → LSD → GCT → extension/ảnh → trailer);
 *   - có bộ GIẢI MÃ LZW riêng, viết theo luật đối xứng (`next === 1 << codeSize` ⇒ đọc
 *     rộng thêm 1 bit) chứ KHÔNG import `./lzw.js`;
 *   - giải mã tới đúng `width*height` chỉ số màu mỗi khung rồi kiểm:
 *     file cụt / thiếu trailer / thiếu điểm ảnh / mã LZW sai / chỉ số vượt bảng màu.
 *
 * Trả ĐÚNG 8 field theo hợp đồng:
 *   `{ valid, version, width, height, frames, loop, bytes, errors }`
 *   - `version`: '87a' | '89a' (null nếu không nhận dạng được);
 *   - `loop`: số lần lặp của khối NETSCAPE2.0 (0 = vô hạn), `null` nếu file không khai;
 *   - `valid`: true CHỈ KHI parse trọn vẹn, có trailer, ≥ 1 khung và mọi khung giải mã đủ pixel.
 */

import { Buffer } from 'node:buffer';

/** Trần số khung khi kiểm (chống file khổng lồ). */
export const INSPECT_MAX_FRAMES = 2000;
/**
 * Trần tổng điểm ảnh giải mã khi kiểm (chống bom nén).
 *
 * ⚠️ F2 (phản biện MVP-04, MAJOR): trần cũ `64_000_000` NHỎ HƠN năng lực thật của preset
 * (`max_seconds: 30` × `fps: 12` × 1280×720 = **331 776 000** điểm ảnh) ⇒ mọi video dài hơn
 * ~5,75–6,58 giây bị `inspectGif` coi là HỎNG và job `failed` với `VIDEO_GIF_INVALID` **đổ lỗi cho
 * GIF trong khi GIF hợp lệ** (4 công cụ ngoài đọc đủ 360 khung).
 *
 * Trần mới bao trùm MỌI preset ở thời lượng tối đa, vẫn là rào chống tệp khổng lồ:
 *   30s × 12fps × 1280×720 = 331,8M ⇒ đặt 512M (dư ~54%).
 */
export const INSPECT_MAX_PIXELS = 512_000_000;
/** Ngân sách kiểm TỐI THIỂU phải bao trùm một video ở trần preset (dùng cho kiểm trước render). */
export const INSPECT_MIN_BUDGET_PIXELS = 30 * 12 * 1280 * 720;
/** Trần dữ liệu ảnh một khung. */
export const INSPECT_MAX_IMAGE_BYTES = 64 * 1024 * 1024;

const toView = (value) =>
  Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : null;

/**
 * Đọc các KHỐI CON của GIF (mỗi khối ≤ 255 byte, kết thúc bằng khối 0).
 *
 * @returns {{parts:Buffer[], next:number}|{error:string}}
 */
function readSubBlocks(view, start, limit) {
  const parts = [];
  let total = 0;
  let offset = start;
  for (;;) {
    if (offset >= view.length) return { error: `khối con vượt biên file tại offset ${offset} (file bị cắt?)` };
    const size = view[offset];
    offset += 1;
    if (size === 0) break;
    if (offset + size > view.length) {
      return { error: `khối con dài ${size} byte vượt biên file tại offset ${offset} (file bị cắt?)` };
    }
    total += size;
    if (total > limit) return { error: `dữ liệu khối con vượt trần ${limit} byte` };
    parts.push(view.subarray(offset, offset + size));
    offset += size;
  }
  return { parts, next: offset };
}

/**
 * GIẢI MÃ LZW (bản độc lập của bộ đọc) — đếm số chỉ số màu giải ra và kiểm tính hợp lệ.
 *
 * @param {Buffer} data dòng byte LZW đã gộp khối con
 * @param {number} minCodeSize
 * @param {{maxSymbols:number, paletteEntries:number|null}} options
 * @returns {{count:number, resets:number, error:string|null}} `resets` = số lần từ điển LZW ĐẦY
 *          phải phát clear code giữa dòng (bằng chứng đường reset 4096 hoạt động).
 */
export function decodeLzwCount(data, minCodeSize, { maxSymbols, paletteEntries = null } = {}) {
  if (!(minCodeSize >= 2 && minCodeSize <= 8)) {
    return { count: 0, resets: 0, error: `minCodeSize không hợp lệ: ${minCodeSize} (chuẩn GIF cho 2..8)` };
  }
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4100);

  let codeSize = minCodeSize + 1;
  let next = endCode + 1;
  let prev = -1;
  let count = 0;
  let acc = 0;
  let accBits = 0;
  let pos = 0;
  let sawEnd = false;
  let resets = 0; // số lần gặp clear code SAU mã đầu (bằng chứng từ điển LZW đã ĐẦY rồi reset)

  /** Đọc một mã LSB-first từ dòng byte; -1 = hết bit. */
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
    if (code < 0 || code > 4095) {
      return { count, resets, error: 'dòng LZW hết bit trước khi gặp mã kết thúc (file bị cắt?)' };
    }
    if (code === clearCode) {
      if (count > 0 || prev >= 0) resets += 1; // clear GIỮA dòng = từ điển đã đầy rồi reset
      codeSize = minCodeSize + 1;
      next = endCode + 1;
      prev = -1;
      continue;
    }
    if (code === endCode) {
      sawEnd = true;
      break;
    }

    let firstSymbol;
    let sp = 0;
    let emitCount;
    if (code < next) {
      // Mã đã có trong từ điển: bung chuỗi ra stack (đảo ngược).
      let c = code;
      while (c >= clearCode) {
        if (sp >= stack.length) return { count, resets, error: 'chuỗi LZW vượt giới hạn từ điển' };
        stack[sp] = suffix[c];
        sp += 1;
        c = prefix[c];
      }
      stack[sp] = c;
      firstSymbol = c;
      emitCount = sp + 1;
    } else if (code === next && prev >= 0) {
      // Ca "KwKwK": mã chưa có trong từ điển = chuỗi trước + ký tự đầu của chính nó.
      let c = prev;
      while (c >= clearCode) {
        if (sp >= stack.length) return { count, resets, error: 'chuỗi LZW vượt giới hạn từ điển' };
        stack[sp] = suffix[c];
        sp += 1;
        c = prefix[c];
      }
      stack[sp] = c;
      firstSymbol = c;
      emitCount = sp + 2; // chuỗi trước + ký tự đầu lặp lại
    } else {
      return { count, resets, error: `mã LZW không hợp lệ: ${code} (từ điển mới có ${next} mã)` };
    }

    // Kiểm chỉ số màu nằm trong bảng màu (nếu biết số mục bảng màu).
    if (paletteEntries !== null) {
      for (let i = 0; i <= sp; i += 1) {
        if (stack[i] >= paletteEntries) {
          return { count, resets, error: `chỉ số màu ${stack[i]} vượt bảng màu ${paletteEntries} mục` };
        }
      }
    }

    count += emitCount;
    if (count > maxSymbols) {
      return {
        count,
        resets,
        error: `LZW giải ra hơn ${maxSymbols} điểm ảnh khai báo (nghi dữ liệu hỏng/bom nén)`,
      };
    }

    if (prev >= 0 && next < 4096) {
      prefix[next] = prev;
      suffix[next] = firstSymbol;
      next += 1;
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    prev = code;
  }

  if (!sawEnd) return { count, resets, error: 'thiếu mã kết thúc LZW' };
  return { count, resets, error: null };
}

/**
 * Kiểm một file GIF.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {{decode?:boolean}} [options] `decode:false` ⇒ chỉ parse khối, không giải mã LZW
 * @returns {{valid:boolean, version:string|null, width:number|null, height:number|null,
 *            frames:number, loop:number|null, bytes:number, errors:string[]}}
 */
export function inspectGif(buffer, options = {}) {
  const decode = options.decode !== false;
  const errors = [];
  const result = {
    valid: false,
    version: null,
    width: null,
    height: null,
    frames: 0,
    loop: null,
    bytes: 0,
    errors,
  };

  const view = toView(buffer);
  if (!view) {
    errors.push('Không phải Buffer/Uint8Array — không kiểm được.');
    return result;
  }
  result.bytes = view.length;
  if (view.length < 14) {
    errors.push(`File quá ngắn (${view.length} byte) — không thể là GIF hợp lệ.`);
    return result;
  }

  const signature = view.toString('latin1', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') {
    errors.push(`Sai magic bytes: "${signature}" (cần "GIF87a" hoặc "GIF89a").`);
    return result;
  }
  result.version = signature.slice(3);

  const width = view.readUInt16LE(6);
  const height = view.readUInt16LE(8);
  result.width = width;
  result.height = height;
  if (width <= 0 || height <= 0) {
    errors.push(`Kích thước khung hình không hợp lệ: ${width}x${height}.`);
    return result;
  }

  const packed = view[10];
  const hasGct = (packed & 0x80) !== 0;
  const gctEntries = hasGct ? 1 << ((packed & 0x07) + 1) : 0;
  let offset = 13 + gctEntries * 3;
  if (offset > view.length) {
    errors.push(
      `Bảng màu toàn cục (${gctEntries} mục) vượt biên file — file bị cắt ở header.`,
    );
    return result;
  }

  let sawTrailer = false;
  let totalPixels = 0;
  let stop = false;

  while (!stop) {
    if (offset >= view.length) {
      errors.push(`Hết file tại offset ${offset} mà CHƯA gặp trailer 0x3B (file bị cắt?).`);
      break;
    }
    const introducer = view[offset];

    if (introducer === 0x3b) {
      sawTrailer = true;
      offset += 1;
      break;
    }

    if (introducer === 0x21) {
      // ── Khối mở rộng ──
      if (offset + 2 > view.length) {
        errors.push(`Khối mở rộng bị cắt tại offset ${offset}.`);
        break;
      }
      const label = view[offset + 1];
      if (label === 0xf9) {
        // Graphic Control Extension: 0x21 0xF9 0x04 packed delay(2) transparent(1) 0x00
        if (offset + 8 > view.length) {
          errors.push(`Graphic Control Extension bị cắt tại offset ${offset}.`);
          break;
        }
        if (view[offset + 2] !== 0x04) {
          errors.push(`Graphic Control Extension sai kích thước khối: ${view[offset + 2]} (cần 4).`);
          break;
        }
        offset += 8;
      } else if (label === 0xff) {
        // Application Extension — cần thấy NETSCAPE2.0 để đọc số lần lặp.
        if (offset + 3 > view.length) {
          errors.push(`Application Extension bị cắt tại offset ${offset}.`);
          break;
        }
        const size = view[offset + 2];
        if (offset + 3 + size > view.length) {
          errors.push(`Application Extension vượt biên tại offset ${offset}.`);
          break;
        }
        const appId = view.toString('latin1', offset + 3, offset + 3 + size);
        const sub = readSubBlocks(view, offset + 3 + size, 1024);
        if (sub.error) {
          errors.push(`Application Extension "${appId.slice(0, 11)}": ${sub.error}`);
          break;
        }
        if (appId.startsWith('NETSCAPE2.0') || appId.startsWith('ANIMEXTS1.0')) {
          for (const part of sub.parts) {
            if (part.length >= 3 && part[0] === 0x01) {
              result.loop = part.readUInt16LE(1);
            }
          }
        }
        offset = sub.next;
      } else {
        // Mọi khối mở rộng khác: bỏ qua theo cấu trúc khối con.
        const sub = readSubBlocks(view, offset + 2, INSPECT_MAX_IMAGE_BYTES);
        if (sub.error) {
          errors.push(`Khối mở rộng 0x${label.toString(16)}: ${sub.error}`);
          break;
        }
        offset = sub.next;
      }
      continue;
    }

    if (introducer === 0x2c) {
      // ── Khung ảnh ──
      if (offset + 10 > view.length) {
        errors.push(`Image Descriptor bị cắt tại offset ${offset}.`);
        break;
      }
      const left = view.readUInt16LE(offset + 1);
      const top = view.readUInt16LE(offset + 3);
      const fw = view.readUInt16LE(offset + 5);
      const fh = view.readUInt16LE(offset + 7);
      const fPacked = view[offset + 9];
      const hasLct = (fPacked & 0x80) !== 0;
      const lctEntries = hasLct ? 1 << ((fPacked & 0x07) + 1) : 0;
      offset += 10;
      if (left + fw > width || top + fh > height) {
        errors.push(
          `Khung #${result.frames} vượt khung hình: rect ${fw}x${fh}+${left}+${top} > ${width}x${height}.`,
        );
        break;
      }
      if (fw <= 0 || fh <= 0) {
        errors.push(`Khung #${result.frames} có kích thước 0.`);
        break;
      }
      offset += lctEntries * 3;
      if (offset >= view.length) {
        errors.push(`Khung #${result.frames}: thiếu dữ liệu ảnh (file bị cắt?).`);
        break;
      }
      const minCodeSize = view[offset];
      offset += 1;
      const sub = readSubBlocks(view, offset, INSPECT_MAX_IMAGE_BYTES);
      if (sub.error) {
        errors.push(`Khung #${result.frames}: ${sub.error}`);
        break;
      }
      offset = sub.next;
      result.frames += 1;

      const palette = hasLct ? lctEntries : hasGct ? gctEntries : 0;
      const framePixels = fw * fh;
      totalPixels += framePixels;

      if (decode) {
        if (totalPixels > INSPECT_MAX_PIXELS) {
          errors.push(`Tổng điểm ảnh ${totalPixels} vượt trần kiểm ${INSPECT_MAX_PIXELS}.`);
          break;
        }
        const data = sub.parts.length === 1 ? sub.parts[0] : Buffer.concat(sub.parts);
        const decoded = decodeLzwCount(data, minCodeSize, {
          maxSymbols: framePixels,
          paletteEntries: palette > 0 ? palette : null,
        });
        if (decoded.error) {
          errors.push(`Khung #${result.frames - 1}: ${decoded.error}.`);
          break;
        }
        if (decoded.count !== framePixels) {
          errors.push(
            `Khung #${result.frames - 1}: LZW giải ra ${decoded.count} điểm ảnh, khai báo ${framePixels}.`,
          );
          break;
        }
      }
      continue;
    }

    errors.push(
      `Khối không nhận dạng 0x${introducer.toString(16).padStart(2, '0')} tại offset ${offset} — file hỏng.`,
    );
    break;
  }

  if (!sawTrailer && errors.length === 0) {
    errors.push('Thiếu trailer 0x3B — file bị cắt.');
  }
  if (result.frames === 0 && errors.length === 0) {
    errors.push('GIF không có khung ảnh nào.');
  }
  if (result.frames > INSPECT_MAX_FRAMES) {
    errors.push(`Số khung ${result.frames} vượt trần kiểm ${INSPECT_MAX_FRAMES}.`);
  }

  result.valid = errors.length === 0 && sawTrailer && result.frames > 0;
  return result;
}

export default inspectGif;
