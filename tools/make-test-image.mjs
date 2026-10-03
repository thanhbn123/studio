/**
 * Sinh ảnh PNG không cần thư viện ngoài — dùng để tạo fixture test.
 *
 * Có ích vì: test Vision cần ảnh thật, mà repo phải giữ nhẹ và không phụ thuộc
 * mạng khi chạy CI. Ảnh sinh ra có hình dạng và màu xác định trước, nên test
 * kiểm được "vision có nhìn ra thứ có thật trong ảnh hay không".
 */

import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {(x:number,y:number)=>[number,number,number]} painter
 * @returns {Buffer} PNG bytes
 */
export function encodePng(width, height, painter) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y += 1) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = painter(x, y);
      raw[o++] = r & 0xff;
      raw[o++] = g & 0xff;
      raw[o++] = b & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const WHITE = [255, 255, 255];
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

/**
 * Ảnh "sản phẩm" tổng hợp: một tai nghe over-ear cách điệu trên nền trắng.
 * Gồm các đặc trưng thị giác rõ ràng: vành khuyên đen, hai đệm màu xanh, dây cáp.
 */
export function drawHeadphones(size = 320) {
  const cx = size / 2;
  return encodePng(size, size, (x, y) => {
    const dx = x - cx;
    const dy = y - cx;
    const r = Math.sqrt(dx * dx + dy * dy);
    const bandOuter = size * 0.42;
    const bandInner = size * 0.35;
    // Vành khuyên (band) phía trên
    if (y < cx && r <= bandOuter && r >= bandInner) return [24, 24, 28];
    // Hai đệm tai (ear cups) màu xanh dương
    const inLeft = inEllipse(x, y, cx - size * 0.34, cx + size * 0.08, size * 0.13, size * 0.17);
    const inRight = inEllipse(x, y, cx + size * 0.34, cx + size * 0.08, size * 0.13, size * 0.17);
    if (inLeft || inRight) return [30, 90, 200];
    // Dây cáp màu đỏ thẫm chạy xuống
    if (Math.abs(dx) < 2.5 && y > cx + size * 0.15) return [180, 30, 40];
    return WHITE;
  });
}

const isMain =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const out = process.argv[2] || 'test/fixtures/headphones.png';
  const png = drawHeadphones(320);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}
