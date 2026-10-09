/**
 * `inspectZip` — BỘ ĐỌC ZIP ĐỘC LẬP (hợp đồng §2, §5).
 *
 * Vì sao phải "độc lập": hợp đồng §5 yêu cầu dùng chính bộ đọc này để CHỨNG MINH gói do
 * `createZip` ghi ra là ZIP thật, mở được bằng công cụ ngoài. Nếu bộ đọc gọi lại bộ ghi
 * (hoặc dùng chung bảng CRC32 của bộ ghi) thì lời chứng minh là vô nghĩa — hai bên cùng
 * sai một kiểu vẫn "khớp" với nhau. Vì vậy file này:
 *
 *   · parse CENTRAL DIRECTORY bằng tay (`PK\x01\x02` → từng bản ghi 46 byte + tên), KHÔNG
 *     import `./create-zip.js`;
 *   · kiểm chéo từng LOCAL FILE HEADER với bản ghi central (chữ ký, method, tên, kích thước);
 *   · tự GIẢI NÉN lại dữ liệu (`zlib.inflateRawSync`) và tính CRC32 bằng bản KHÔNG BẢNG
 *     (`crc32Bitwise`) rồi so với CRC trong header;
 *   · coi file CỤT/HỎNG là `valid: false` kèm LÝ DO cụ thể (không ném lỗi, không treo).
 *
 * Chống bom nén: `inflateRawSync` luôn được gọi với `maxOutputLength` = đúng kích thước
 * chưa nén mà header khai ⇒ dữ liệu phình to hơn khai báo sẽ ném lỗi thay vì ngốn RAM.
 *
 * Trả ĐÚNG 4 field theo hợp đồng: `{ valid, entries: [{ name, size, crc32, method }], bytes, errors }`.
 */

import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { crc32Bitwise } from './crc32.js';

const SIG_LOCAL = 0x04034b50; // "PK\x03\x04"
const SIG_CENTRAL = 0x02014b50; // "PK\x01\x02"
const SIG_EOCD = 0x06054b50; // "PK\x05\x06"

const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
/** Bit 3 của cờ: kích thước/CRC nằm ở data descriptor SAU dữ liệu (không kiểm ở local header). */
const FLAG_DATA_DESCRIPTOR = 0x0008;

/** Trần an toàn khi kiểm (chống file khổng lồ) — vượt ⇒ báo lỗi chứ không cấp phát. */
export const INSPECT_MAX_ENTRY_BYTES = 512 * 1024 * 1024;

/** Ép về Buffer CHỈ ĐỂ ĐỌC. */
const toView = (value) =>
  Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : null;

/** `true` nếu đọc được 4 byte tại `offset`. */
const canRead32 = (buf, offset) => offset >= 0 && offset + 4 <= buf.length;
/** `true` nếu đọc được 2 byte tại `offset`. */
const canRead16 = (buf, offset) => offset >= 0 && offset + 2 <= buf.length;

/**
 * Tìm bản ghi EOCD ở CUỐI file.
 *
 * EOCD nằm trong 22 byte cuối + tối đa 65535 byte comment; ta quét ngược và chỉ nhận
 * ứng viên có `offset + 22 + commentLength === buffer.length` — tức EOCD KẾT THÚC ĐÚNG
 * byte cuối cùng của file. Nhờ vậy một mẩu dữ liệu rác tình cờ chứa chữ ký `PK\x05\x06`
 * cũng không được coi là ZIP hợp lệ, và file bị CẮT luôn rơi vào nhánh "không thấy EOCD".
 *
 * @returns {number} offset của EOCD, hoặc -1
 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - EOCD_SIZE - MAX_COMMENT);
  for (let pos = buf.length - EOCD_SIZE; pos >= min; pos -= 1) {
    if (!canRead32(buf, pos) || buf.readUInt32LE(pos) !== SIG_EOCD) continue;
    const commentLen = buf.readUInt16LE(pos + 20);
    if (pos + EOCD_SIZE + commentLen === buf.length) return pos;
  }
  return -1;
}

/**
 * Kiểm một buffer ZIP.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {{valid: boolean, entries: Array<{name: string, size: number, crc32: number, method: number}>, bytes: number, errors: string[]}}
 *          `size` = kích thước CHƯA nén; `crc32` = giá trị ghi trong header; `method` = 0 | 8.
 *          `valid` CHỈ true khi parse trọn vẹn, mọi entry giải nén đúng kích thước VÀ đúng CRC.
 */
export function inspectZip(buffer) {
  const errors = [];
  const entries = [];
  const result = { valid: false, entries, bytes: 0, errors };

  const buf = toView(buffer);
  if (!buf) {
    errors.push('Không phải Buffer/Uint8Array — không kiểm được ZIP.');
    return result;
  }
  result.bytes = buf.length;
  if (buf.length < EOCD_SIZE) {
    errors.push(`File quá ngắn (${buf.length} byte) — tối thiểu một ZIP rỗng đã cần ${EOCD_SIZE} byte.`);
    return result;
  }

  /* ── 1. EOCD ─────────────────────────────────────────────────────────── */
  const eocd = findEocd(buf);
  if (eocd < 0) {
    errors.push('Không tìm thấy End Of Central Directory (chữ ký "PK\\x05\\x06") ở cuối file — ZIP bị cắt hoặc không phải ZIP.');
    return result;
  }
  const diskNumber = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const entriesThisDisk = buf.readUInt16LE(eocd + 8);
  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (diskNumber !== 0 || cdDisk !== 0) {
    errors.push(`ZIP nhiều đĩa (disk=${diskNumber}, cd_disk=${cdDisk}) — bộ đọc này chỉ hỗ trợ một đĩa.`);
  }
  if (entriesThisDisk !== totalEntries) {
    errors.push(`Số entry trên đĩa (${entriesThisDisk}) khác tổng số entry (${totalEntries}) — EOCD không nhất quán.`);
  }
  if (totalEntries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    errors.push('ZIP64 (0xFFFF/0xFFFFFFFF trong EOCD) — bộ đọc này chưa hỗ trợ.');
    return result;
  }
  if (cdOffset + cdSize !== eocd) {
    errors.push(`Vùng central directory không khớp EOCD: offset ${cdOffset} + size ${cdSize} ≠ ${eocd}.`);
  }
  if (cdOffset > buf.length || cdOffset + cdSize > buf.length) {
    errors.push(`Central directory vượt biên file: cần tới byte ${cdOffset + cdSize}, file chỉ có ${buf.length} byte (file bị cắt?).`);
    return result;
  }

  /* ── 2. Central directory ────────────────────────────────────────────── */
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    if (!canRead32(buf, p) || p + 46 > buf.length) {
      errors.push(`Bản ghi central directory #${i} vượt biên file tại offset ${p} (file bị cắt?).`);
      break;
    }
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) {
      errors.push(`Sai chữ ký central directory tại offset ${p} (entry #${i}) — file hỏng.`);
      break;
    }

    const method = buf.readUInt16LE(p + 10);
    const expectedCrc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const nameStart = p + 46;

    if (nameStart + nameLen > buf.length) {
      errors.push(`Tên entry #${i} vượt biên file (cần ${nameLen} byte tại offset ${nameStart}).`);
      break;
    }
    // Bit 11 bật ⇒ chắc chắn UTF-8. Không bật (ZIP của công cụ khác) thì vẫn thử UTF-8:
    // tệ hơn CP437 chỉ khi tên có ký tự 8-bit, còn tên ASCII thì hai cách trùng nhau.
    const nameBytes = buf.subarray(nameStart, nameStart + nameLen);
    const name = nameBytes.toString('utf8');
    p = nameStart + nameLen + extraLen + commentLen;
    if (p > buf.length) {
      errors.push(`Bản ghi central directory #${i} (extra/comment) vượt biên file.`);
      break;
    }

    const record = { name, size: uncompressedSize, crc32: expectedCrc, method };
    entries.push(record);

    /* ── 3. Local file header phải khớp bản ghi central ── */
    if (!canRead32(buf, localOffset) || localOffset + 30 > buf.length) {
      errors.push(`Entry "${name}": local file header vượt biên file (offset ${localOffset}).`);
      continue;
    }
    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      errors.push(`Entry "${name}": sai chữ ký local file header tại offset ${localOffset}.`);
      continue;
    }
    const localFlags = buf.readUInt16LE(localOffset + 6);
    const localMethod = buf.readUInt16LE(localOffset + 8);
    if (localMethod !== method) {
      errors.push(`Entry "${name}": method lệch nhau (local ${localMethod} ≠ central ${method}).`);
      continue;
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    if (localNameStart + localNameLen > buf.length) {
      errors.push(`Entry "${name}": tên trong local header vượt biên file.`);
      continue;
    }
    if (buf.toString('utf8', localNameStart, localNameStart + localNameLen) !== name) {
      errors.push(`Entry "${name}": tên trong local header khác central directory.`);
      continue;
    }
    // Bit 3 (data descriptor) ⇒ kích thước/CRC ở local header bằng 0 theo chuẩn; chỉ kiểm
    // khi cờ này TẮT (mọi ZIP do `createZip` ghi ra đều tắt).
    const hasDescriptor = (localFlags & FLAG_DATA_DESCRIPTOR) !== 0;
    if (!hasDescriptor) {
      const localCrc = buf.readUInt32LE(localOffset + 14);
      const localComp = buf.readUInt32LE(localOffset + 18);
      const localUncomp = buf.readUInt32LE(localOffset + 22);
      if (localCrc !== expectedCrc || localComp !== compressedSize || localUncomp !== uncompressedSize) {
        errors.push(`Entry "${name}": CRC/kích thước ở local header khác central directory.`);
        continue;
      }
    }

    /* ── 4. Giải nén lại + kiểm CRC bằng bản KHÔNG BẢNG ── */
    const dataStart = localNameStart + localNameLen + localExtraLen;
    if (dataStart + compressedSize > buf.length) {
      errors.push(`Entry "${name}": dữ liệu vượt biên file (cần tới byte ${dataStart + compressedSize}, file có ${buf.length}) — file bị cắt?`);
      continue;
    }
    if (uncompressedSize > INSPECT_MAX_ENTRY_BYTES) {
      errors.push(`Entry "${name}": kích thước chưa nén ${uncompressedSize} vượt trần kiểm ${INSPECT_MAX_ENTRY_BYTES} byte.`);
      continue;
    }
    const body = buf.subarray(dataStart, dataStart + compressedSize);
    let data = null;
    if (method === 0) {
      data = body;
    } else if (method === 8) {
      try {
        // `maxOutputLength` = đúng số byte header khai ⇒ bom nén nổ ra lỗi, không ngốn RAM.
        data = zlib.inflateRawSync(body, { maxOutputLength: uncompressedSize > 0 ? uncompressedSize : 1 });
      } catch (err) {
        errors.push(`Entry "${name}": không giải nén được (${err?.code || err?.message || 'lỗi zlib'}) — dữ liệu hỏng hoặc vượt kích thước khai báo.`);
        continue;
      }
    } else {
      errors.push(`Entry "${name}": method ${method} không được hỗ trợ (chỉ nhận 0 = store, 8 = deflate).`);
      continue;
    }

    if (data.length !== uncompressedSize) {
      errors.push(`Entry "${name}": giải nén ra ${data.length} byte, header khai ${uncompressedSize} byte.`);
      continue;
    }
    const actualCrc = crc32Bitwise(data);
    if (actualCrc !== expectedCrc) {
      errors.push(`Entry "${name}": CRC32 sai (header ${expectedCrc} ≠ thực tế ${actualCrc}) — dữ liệu hỏng.`);
      continue;
    }
    // Ghi chú về cờ: bit 11 (UTF-8) KHÔNG được coi là điều kiện hợp lệ — ZIP của công cụ
    // khác (Python `zipfile`, `zip`) không bật cờ này cho tên thuần ASCII, và bộ đọc vẫn
    // giải mã UTF-8 nên tên ASCII luôn đúng. Điều kiện "tên tiếng Việt hiển thị đúng" của
    // gói do `createZip` ghi ra được kiểm ở phía bộ ghi + công cụ ngoài (`unzip -l`).
  }

  if (entries.length !== totalEntries) {
    errors.push(`Đọc được ${entries.length}/${totalEntries} entry từ central directory.`);
  } else if (p !== eocd) {
    errors.push(`Central directory kết thúc ở byte ${p} nhưng EOCD bắt đầu ở byte ${eocd} — vùng đệm thừa/thiếu.`);
  }

  result.valid = errors.length === 0;
  return result;
}

export default inspectZip;
