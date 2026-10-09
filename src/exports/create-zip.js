/**
 * `createZip` — BỘ GHI ZIP TỰ VIẾT (không thư viện, chỉ `node:zlib`).
 *
 * Hợp đồng §2 bắt buộc: ZIP THẬT, mở được bằng `unzip`/Finder. Điều đó có nghĩa là
 * phải ghi ĐỦ ba tầng của định dạng:
 *
 *   1. LOCAL FILE HEADER + dữ liệu   (offset 0 …)      chữ ký `PK\x03\x04`
 *   2. CENTRAL DIRECTORY             (sau dữ liệu)     chữ ký `PK\x01\x02`
 *   3. END OF CENTRAL DIRECTORY      (22 byte cuối)    chữ ký `PK\x05\x06`
 *
 * Ba cạm bẫy đã xử lý tường minh:
 *
 *  · **Tên tiếng Việt**: tên entry được ghi UTF-8 và BẬT CỜ BIT 11 (`0x0800`) trong
 *    `general purpose bit flag` ở CẢ local header LẪN central directory. Thiếu cờ này,
 *    `unzip`/Finder giải mã theo CP437 ⇒ "nội dung" thành "n?i dung". Đây là cờ DUY NHẤT
 *    được bật — không dùng data descriptor (bit 3) vì ta biết trước mọi kích thước.
 *
 *  · **CRC32 + kích thước**: CRC tính trên dữ liệu CHƯA nén; `compressed size` là kích
 *    thước THẬT của phần dữ liệu ghi ra (bằng `uncompressed size` khi method = 0).
 *    Ghi sai hai số này thì ZIP vẫn "mở được" nhưng giải nén ra rác/hỏng.
 *
 *  · **Chọn method**: `deflate` chỉ dùng khi nén RA NHỎ HƠN thật (ảnh PNG/JPEG vốn đã nén,
 *    đem đi deflate vừa tốn CPU vừa phình file). Method nào được ghi vào header chính là
 *    method đã dùng — không bao giờ khai một đằng ghi một nẻo.
 *
 * Giới hạn có chủ đích: KHÔNG hỗ trợ ZIP64. Vượt 65535 entry hoặc 4 GiB ⇒ ném
 * `ExportError('ZIP_TOO_LARGE')` thay vì ghi ra file hỏng.
 */

import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { crc32 } from './crc32.js';
import { ExportError, EXPORT_CODES } from './errors.js';

/* ─────────────────────────── hằng số định dạng ─────────────────────────── */

const SIG_LOCAL = 0x04034b50; // "PK\x03\x04"
const SIG_CENTRAL = 0x02014b50; // "PK\x01\x02"
const SIG_EOCD = 0x06054b50; // "PK\x05\x06"

/** Cờ bit 11 — tên entry là UTF-8 (điều kiện sống còn với tên tiếng Việt). */
export const ZIP_FLAG_UTF8 = 0x0800;
/** Phiên bản tối thiểu để giải nén: 2.0 (deflate ra đời ở 2.0). */
const VERSION_NEEDED = 20;
/** "Version made by": 3 = Unix, phiên bản 2.0 ⇒ `((3) << 8) | 20`. */
const VERSION_MADE_BY = (3 << 8) | 20;
/** Quyền file Unix ghi vào `external attributes`: 0644 (rw-r--r--). */
const EXTERNAL_ATTRS = (0o100644 << 16) >>> 0;

/** Trần cứng của ZIP không có ZIP64. */
const MAX_ENTRIES = 0xffff;
const MAX_NAME_BYTES = 0xffff;
const MAX_UINT32 = 0xffffffff;
/** Năm nhỏ nhất biểu diễn được bằng DOS time. */
const DOS_MIN_YEAR = 1980;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

export const DEFAULT_DEFLATE_LEVEL = 6;

/* ─────────────────────────── tiện ích nội bộ ─────────────────────────── */

/** Ép dữ liệu entry về Buffer; chuỗi ⇒ UTF-8. Ném `INVALID_BUFFER` nếu không hợp lệ. */
function toEntryBuffer(value, name) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new ExportError(
    EXPORT_CODES.INVALID_BUFFER,
    `Entry ${JSON.stringify(name)} có \`data\` không hợp lệ (chỉ nhận Buffer/Uint8Array/string).`,
    { name },
  );
}

/**
 * Ký tự ĐIỀU KHIỂN / điều khiển hướng hiển thị bị CẤM trong tên entry — R3 (phản biện vòng 2, LOW).
 *
 * Vòng vá D6 mới chặn CR/LF, nhưng cùng loại "chèn dòng giả / bịa tên tệp" còn tới được bằng
 * NEL (U+0085), LS/PS (U+2028/9), VT, FF, ESC, DEL và RLO (U+202E — đảo chiều hiển thị để giả
 * đuôi tệp): `"\n".join(namelist()).splitlines()` của Python biến 8 tên thành 13 dòng.
 *
 * Tập bị chặn = `\p{Cc}` (mọi ký tự điều khiển C0/C1, gồm NEL) + `\p{Zl}`/`\p{Zp}` (LS/PS) +
 * các ký tự ĐIỀU KHIỂN HƯỚNG HIỂN THỊ (`Cf` nguy hiểm: LRE/RLE/PDF/LRO/RLO, các isolate,
 * LRM/RLM/ALM) + BOM. CỐ Ý KHÔNG chặn toàn bộ `\p{Cf}` vì `Cf` bao gồm ZWJ (U+200D) — chặn nó
 * là phá tên tệp emoji ghép (👨‍👩‍👧) mà hợp đồng yêu cầu giữ nguyên.
 */
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c\ufeff]/u;

/** Tên thông dụng của vài ký tự điều khiển hay gặp (để `details` đọc được, không nhét ký tự thô). */
const CONTROL_CHAR_NAMES = Object.freeze({
  0x09: 'TAB', 0x0a: 'LF', 0x0b: 'VT', 0x0c: 'FF', 0x0d: 'CR', 0x1b: 'ESC', 0x7f: 'DEL', 0x85: 'NEL',
  0x061c: 'ALM', 0x200e: 'LRM', 0x200f: 'RLM', 0x2028: 'LS', 0x2029: 'PS', 0x202a: 'LRE', 0x202b: 'RLE',
  0x202c: 'PDF', 0x202d: 'LRO', 0x202e: 'RLO', 0x2066: 'LRI', 0x2067: 'RLI', 0x2068: 'FSI', 0x2069: 'PDI',
  0xfeff: 'BOM/ZWNBSP',
});

/** Mô tả MÁY ĐỌC ĐƯỢC của ký tự vi phạm: `{ char, code_point, name, position }`. */
function controlCharDetails(char, position) {
  const cp = char.codePointAt(0) ?? 0;
  const hex = cp.toString(16).toUpperCase().padStart(4, '0');
  return {
    char: `\\u${hex}`,
    code_point: `U+${hex}`,
    name: CONTROL_CHAR_NAMES[cp] || null,
    position,
  };
}

/**
 * Kiểm và chuẩn hoá tên entry:
 *  - không rỗng, không NUL;
 *  - KHÔNG chứa ký tự điều khiển/điều khiển hướng hiển thị (R3 — xem `UNSAFE_NAME_CHARS`);
 *  - đường dẫn TƯƠNG ĐỐI (chặn `/etc/…`, `C:\…`, `../…` — zip-slip);
 *  - không kết thúc bằng `/` (repository này không sinh entry thư mục rỗng);
 *  - dài ≤ 65535 byte UTF-8.
 *
 * HAI MÃ LỖI, có lý do khác nhau (R4 — hợp đồng §9.6 khai "CR/LF/NUL ⇒ BAD_ENTRY_NAME" là SAI):
 *  · `ZIP_NAME_INVALID`   — tên không dùng được làm ĐƯỜNG DẪN entry. NUL thuộc nhóm này: byte 0
 *    không biểu diễn được trong ZIP (mọi công cụ đọc theo C-string sẽ cắt tên tại đó) và mã này
 *    đã được dùng cho NUL từ trước vòng D6 — giữ nguyên để không phá client đang bắt mã đó.
 *  · `BAD_ENTRY_NAME`     — tên ĐÚNG dạng đường dẫn nhưng chứa KÝ TỰ ĐIỀU KHIỂN (CR/LF/NEL/LS/PS/
 *    VT/FF/ESC/DEL/RLO…) ⇒ chèn dòng giả vào mọi danh sách in ra văn bản, hoặc bịa đuôi tệp.
 *    `details` nêu rõ ký tự vi phạm (`char`, `code_point`, `name`, `position`).
 */
export function normalizeZipName(raw) {
  const value = typeof raw === 'string' ? raw : '';
  if (!value.trim()) {
    throw new ExportError(EXPORT_CODES.ZIP_NAME_INVALID, 'Tên entry rỗng — ZIP cần tên thật.', { name: String(raw ?? '') });
  }
  if (value.includes('\0')) {
    throw new ExportError(EXPORT_CODES.ZIP_NAME_INVALID, 'Tên entry chứa ký tự NUL.', { name: value.slice(0, 120), ...controlCharDetails('\0', value.indexOf('\0')) });
  }
  // R3 (phản biện vòng 2, LOW): mọi ký tự điều khiển KHÁC NUL ⇒ `BAD_ENTRY_NAME` kèm ký tự vi phạm.
  const unsafe = UNSAFE_NAME_CHARS.exec(value);
  if (unsafe) {
    const info = controlCharDetails(unsafe[0], unsafe.index);
    const label = info.name ? `${info.name} (${info.char})` : info.char;
    throw new ExportError(
      EXPORT_CODES.BAD_ENTRY_NAME,
      `Tên entry chứa ký tự điều khiển ${label} — ký tự này chèn được dòng giả vào danh sách tệp hoặc bịa được đuôi tệp, không hợp lệ trong ZIP.`,
      { name: value.slice(0, 120), ...info },
    );
  }
  const name = value.replace(/\\/g, '/');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new ExportError(EXPORT_CODES.ZIP_NAME_INVALID, `Tên entry phải là đường dẫn TƯƠNG ĐỐI: ${name.slice(0, 120)}`, { name: name.slice(0, 120) });
  }
  const segments = name.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new ExportError(
      EXPORT_CODES.ZIP_NAME_INVALID,
      `Tên entry có đoạn rỗng/"."/".." (nguy cơ ghi đè ngoài thư mục giải nén): ${name.slice(0, 120)}`,
      { name: name.slice(0, 120) },
    );
  }
  if (name.endsWith('/')) {
    throw new ExportError(EXPORT_CODES.ZIP_NAME_INVALID, `Không ghi entry thư mục (tên kết thúc bằng "/"): ${name.slice(0, 120)}`, { name: name.slice(0, 120) });
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    throw new ExportError(EXPORT_CODES.ZIP_NAME_TOO_LONG, `Tên entry dài quá ${MAX_NAME_BYTES} byte UTF-8.`, { name: name.slice(0, 120) });
  }
  return name;
}

/**
 * Mã hoá thời gian theo DOS (2 số 16-bit): ZIP dùng giờ ĐỊA PHƯƠNG, mốc 1980.
 * Kẹp năm < 1980 lên 1980 để không ghi ra giá trị tràn ngược.
 */
function toDosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(DOS_MIN_YEAR, Math.min(2107, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - DOS_MIN_YEAR) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Chuẩn hoá lựa chọn method: 'auto' | 'store' | 'deflate' | 0 | 8. */
function normalizeMethodChoice(value, where) {
  if (value === undefined || value === null || value === '' || value === 'auto') return 'auto';
  if (value === 0 || value === 'store' || value === '0') return 'store';
  if (value === 8 || value === 'deflate' || value === '8') return 'deflate';
  throw new ExportError(EXPORT_CODES.ZIP_METHOD_INVALID, `Method không hợp lệ ở ${where}: ${JSON.stringify(value)} (chỉ nhận 'auto' | 'store' | 'deflate' | 0 | 8).`, { value: String(value) });
}

/** Nén raw-deflate (không header zlib/gzip — ZIP yêu cầu đúng dạng này). */
function deflateRaw(data, level) {
  return zlib.deflateRawSync(data, { level });
}

/* ───────────────────────────── API chính ───────────────────────────── */

/**
 * Ghi một file ZIP hoàn chỉnh vào Buffer.
 *
 * @param {object} options
 * @param {Array<{name: string, data: Buffer|Uint8Array|string, method?: number|string, date?: Date}>} options.entries
 *        Danh sách entry theo ĐÚNG thứ tự sẽ ghi (thứ tự này cũng là thứ tự trong central
 *        directory). `date` của từng entry ghi đè `date` chung.
 * @param {Date} [options.date] mốc thời gian dùng cho mọi entry (mặc định: bây giờ)
 * @param {number|string} [options.method] 'auto' (mặc định) | 'store' | 0 | 'deflate' | 8
 * @param {number} [options.level] mức nén 0..9 khi dùng deflate (mặc định 6)
 * @returns {Buffer} ZIP hợp lệ
 */
export function createZip({ entries, date = new Date(), method = 'auto', level = DEFAULT_DEFLATE_LEVEL } = {}) {
  if (!Array.isArray(entries)) {
    throw new ExportError(EXPORT_CODES.BAD_INPUT, 'createZip cần `entries` là MẢNG các entry {name, data}.', { type: typeof entries });
  }
  if (entries.length > MAX_ENTRIES) {
    throw new ExportError(EXPORT_CODES.ZIP_TOO_LARGE, `ZIP không có ZIP64 chỉ chứa được ${MAX_ENTRIES} entry (đang có ${entries.length}).`, { entries: entries.length, limit: MAX_ENTRIES });
  }
  const defaultMethod = normalizeMethodChoice(method, 'createZip');
  const lvl = Number.isInteger(level) && level >= 0 && level <= 9 ? level : DEFAULT_DEFLATE_LEVEL;

  const chunks = []; // các khối ghi tuần tự: local header + tên + dữ liệu
  const central = []; // các bản ghi central directory
  const seen = new Set();
  let offset = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] && typeof entries[i] === 'object' ? entries[i] : {};
    const name = normalizeZipName(entry.name);
    if (seen.has(name)) {
      throw new ExportError(EXPORT_CODES.ZIP_DUPLICATE_NAME, `Hai entry cùng tên trong một ZIP: ${name.slice(0, 120)}`, { name });
    }
    seen.add(name);

    const raw = toEntryBuffer(entry.data, name);
    if (raw.length > MAX_UINT32) {
      throw new ExportError(EXPORT_CODES.ZIP_TOO_LARGE, `Entry ${name.slice(0, 120)} lớn hơn 4 GiB — cần ZIP64 (chưa hỗ trợ).`, { name, bytes: raw.length });
    }

    // ── Chọn method: chỉ deflate khi THẬT SỰ nhỏ hơn ──
    const wanted = normalizeMethodChoice(entry.method ?? defaultMethod, `entry ${name.slice(0, 120)}`);
    let usedMethod = METHOD_STORE;
    let body = raw;
    if (wanted !== 'store') {
      const deflated = deflateRaw(raw, lvl);
      if (wanted === 'deflate' || deflated.length < raw.length) {
        usedMethod = METHOD_DEFLATE;
        body = deflated;
      }
    }

    const checksum = crc32(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const stamp = toDosDateTime(entry.date instanceof Date ? entry.date : date);

    // ── 1. Local file header (30 byte + tên) ──
    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(ZIP_FLAG_UTF8, 6); // bit 11: tên UTF-8
    local.writeUInt16LE(usedMethod, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18); // compressed size
    local.writeUInt32LE(raw.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    chunks.push(local, nameBuf, body);

    // ── 2. Central directory record (46 byte + tên) ──
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(VERSION_MADE_BY, 4);
    cd.writeUInt16LE(VERSION_NEEDED, 6);
    cd.writeUInt16LE(ZIP_FLAG_UTF8, 8); // bit 11 phải khớp local header
    cd.writeUInt16LE(usedMethod, 10);
    cd.writeUInt16LE(stamp.time, 12);
    cd.writeUInt16LE(stamp.date, 14);
    cd.writeUInt32LE(checksum, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // số đĩa bắt đầu
    cd.writeUInt16LE(0, 36); // internal attributes
    cd.writeUInt32LE(EXTERNAL_ATTRS, 38);
    cd.writeUInt32LE(offset, 42); // offset của local header
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
    if (offset > MAX_UINT32) {
      throw new ExportError(EXPORT_CODES.ZIP_TOO_LARGE, 'Tổng dữ liệu vượt 4 GiB — cần ZIP64 (chưa hỗ trợ).', { bytes: offset });
    }
  }

  // ── 3. Central directory + EOCD ──
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4); // số đĩa
  eocd.writeUInt16LE(0, 6); // đĩa chứa central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16); // nơi central directory bắt đầu
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

export default createZip;
