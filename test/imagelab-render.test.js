/**
 * TEST MVP-02 · RENDER & PIXEL (C3) — `src/imagelab/render/**`.
 *
 * Đây là tầng dễ sai nhất, nên test khẳng định bằng PIXEL và HÌNH HỌC thật:
 *  - PNG round-trip (byte-identical với fixture 320×320 RGB và với ảnh RGBA tự sinh);
 *  - PNG lạ (interlaced / palette / bit-depth ≠ 8) → PNG_UNSUPPORTED;
 *  - PNG hỏng (CRC sai / cắt ngắn / rác) → PNG_CORRUPT, không crash, không treo;
 *  - ảnh gốc BẤT BIẾN: buffer vào không bị sửa, pixel NGOÀI mọi hộp không đổi;
 *  - `layoutText`: `fits === true` ⇒ mọi đường bao nằm TRONG hộp (thử 200 hộp ngẫu nhiên
 *    có seed cố định + các hộp biên);
 *  - vùng NO_GLYPH / TEXT_TOO_LONG KHÔNG bị xoá (giữ nguyên chữ gốc) và có trong `skipped`.
 *
 * Test không cần mạng, không cần API key.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  RenderError,
  createRenderProvider,
  decodePng,
  encodePng,
  layoutText,
  loadFont,
  sha256,
  toRgba,
} from '../src/imagelab/render/index.js';
import { headphones } from './imagelab-helpers.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Liệt kê chunk PNG (offset đầu chunk, type, offset dữ liệu, độ dài). */
function pngChunks(buf) {
  const out = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    out.push({ offset, type, dataStart: offset + 8, length });
    offset += 12 + length;
  }
  return out;
}

const idatOf = (buf) => pngChunks(buf).find((c) => c.type === 'IDAT');

const purejs = (overrides = {}) =>
  createRenderProvider({ render: { provider: 'purejs' }, imagelab: { maxPixels: 16_000_000, ...overrides } });

const pixelAt = (rgba, width, x, y) => {
  const i = (y * width + x) * 4;
  return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
};

const inAnyBox = (boxes, x, y) => boxes.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h);

describe('MVP-02 render — PNG codec (round-trip + ảnh không hỗ trợ + ảnh hỏng)', () => {
  test('round-trip BYTE-IDENTICAL với fixture headphones.png (320×320, RGB color type 2)', () => {
    const original = headphones();
    const header = decodePng(original);
    assert.equal(header.width, 320);
    assert.equal(header.height, 320);
    assert.equal(header.channels, 3);
    assert.equal(header.colorType, 2);
    assert.equal(header.data.length, 320 * 320 * 3);

    const reencoded = encodePng({
      width: header.width,
      height: header.height,
      data: header.data,
      channels: header.channels,
    });
    assert.equal(reencoded.length, original.length);
    assert.ok(reencoded.equals(original), 'encodePng(decodePng(x)) phải cho lại đúng byte của x');

    const again = decodePng(reencoded);
    assert.ok(again.data.equals(header.data), 'pixel sau round-trip phải y hệt');
  });

  test('round-trip ảnh RGBA tự sinh: giữ đúng alpha và byte-identical khi mã hoá lại', () => {
    const width = 4;
    const height = 3;
    const data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 37) % 256;

    const png = encodePng({ width, height, data, channels: 4 });
    const decoded = decodePng(png);
    assert.equal(decoded.channels, 4);
    assert.equal(decoded.colorType, 6);
    assert.equal(decoded.hasAlpha, true);
    assert.ok(decoded.data.equals(data), 'pixel RGBA phải round-trip y hệt (kể cả alpha)');
    assert.ok(encodePng({ width, height, data: decoded.data, channels: 4 }).equals(png));
  });

  test('interlaced / palette / bit-depth ≠ 8 → RenderError PNG_UNSUPPORTED', () => {
    const variants = [
      ['16-bit', 24, 16],
      ['bit depth 4', 24, 4],
      ['palette (color type 3)', 25, 3],
      ['interlaced', 28, 1],
    ];
    for (const [label, offset, value] of variants) {
      const bad = Buffer.from(headphones());
      bad[offset] = value;
      assert.throws(
        () => decodePng(bad),
        (err) => err instanceof RenderError && err.code === 'PNG_UNSUPPORTED',
        `${label} lẽ ra phải là PNG_UNSUPPORTED`,
      );
    }
  });

  test('CRC hỏng / cắt ngắn / rác → PNG_CORRUPT (không crash, không treo)', () => {
    const crcBad = Buffer.from(headphones());
    const idat = idatOf(crcBad);
    crcBad[idat.dataStart + 3] ^= 0xff; // lật một byte trong dữ liệu IDAT, CRC giữ nguyên

    const garbled = Buffer.concat([PNG_MAGIC, Buffer.from('khong-phai-png-du-lieu-rac-'.repeat(8))]);
    const zeroed = Buffer.concat([PNG_MAGIC, Buffer.alloc(64)]);

    const cases = [
      ['CRC sai', crcBad, 'PNG_CORRUPT'],
      ['cắt ngắn 200 byte', headphones().subarray(0, 200), 'PNG_CORRUPT'],
      ['cắt ngắn 40 byte', headphones().subarray(0, 40), 'PNG_CORRUPT'],
      ['rác sau magic bytes', garbled, 'PNG_CORRUPT'],
      ['toàn số 0', zeroed, 'PNG_CORRUPT'],
      ['không phải PNG', Buffer.from('day khong phai anh'), 'PNG_CORRUPT'],
    ];
    for (const [label, buf, code] of cases) {
      assert.throws(
        () => decodePng(buf),
        (err) => err instanceof RenderError && err.code === code,
        `${label} lẽ ra phải ném ${code}`,
      );
    }
  });

  test('vượt maxPixels → IMAGE_TOO_LARGE (chặn trước khi cấp phát pixel)', () => {
    assert.throws(
      () => decodePng(headphones(), { maxPixels: 1000 }),
      (err) => err instanceof RenderError && err.code === 'IMAGE_TOO_LARGE',
    );
  });

  test('encodePng từ chối input sai một cách có mã lỗi (fail-closed)', () => {
    assert.throws(() => encodePng({ width: 0, height: 10, data: Buffer.alloc(4), channels: 3 }), /PNG_BAD_INPUT|width/);
    assert.throws(() => encodePng({ width: 2, height: 2, data: Buffer.alloc(4), channels: 9 }), (e) => e.code === 'PNG_BAD_INPUT');
    assert.throws(() => encodePng({ width: 2, height: 2, data: Buffer.alloc(2), channels: 3 }), (e) => e.code === 'PNG_BAD_INPUT');
  });
});

describe('MVP-02 render — provider purejs (ảnh gốc bất biến, pixel, hình học)', () => {
  test('render không sửa buffer đầu vào; original_sha256 đúng; output là ảnh mới', async () => {
    const input = headphones();
    const before = Buffer.from(input);
    const beforeHash = sha256(input);

    const provider = purejs();
    const res = await provider.render({
      image: { buffer: input, mime: 'image/png' },
      ops: [{ region_id: 'r1', box: { x: 20, y: 20, w: 140, h: 40 }, action: 'erase_and_draw', text: 'Áo thun cotton' }],
    });

    assert.equal(res.status, 'OK');
    assert.equal(res.is_mock, false, 'purejs là render THẬT, không được khai mock');
    assert.equal(res.original_sha256, beforeHash);
    assert.ok(input.equals(before), 'buffer đầu vào KHÔNG được sửa tại chỗ');
    assert.equal(sha256(input), beforeHash);
    assert.ok(res.output && Buffer.isBuffer(res.output.buffer));
    assert.equal(res.output.sha256, sha256(res.output.buffer));
    assert.notEqual(res.output.sha256, beforeHash, 'ảnh render phải là bản MỚI khác ảnh gốc');
    assert.equal(res.output.width, 320);
    assert.equal(res.output.height, 320);
  });

  test('pixel NGOÀI mọi hộp không đổi; pixel TRONG hộp có đổi (không phải test rỗng)', async () => {
    const original = headphones();
    const boxes = [
      { x: 20, y: 20, w: 140, h: 40 },
      { x: 170, y: 200, w: 130, h: 50 },
    ];
    const provider = purejs();
    const res = await provider.render({
      image: { buffer: original, mime: 'image/png' },
      ops: [
        { region_id: 'r1', box: boxes[0], action: 'erase_and_draw', text: 'Áo thun cotton' },
        { region_id: 'r2', box: boxes[1], action: 'erase_and_draw', text: 'Đường phố' },
      ],
    });
    assert.equal(res.status, 'OK');
    assert.equal(res.applied.length, 2);

    const before = toRgba(decodePng(original));
    const after = toRgba(decodePng(res.output.buffer));
    assert.equal(before.length, after.length);

    let changedOutside = 0;
    let changedInside = 0;
    for (let y = 0; y < 320; y += 1) {
      for (let x = 0; x < 320; x += 1) {
        const same = pixelAt(before, 320, x, y).every((v, i) => v === pixelAt(after, 320, x, y)[i]);
        if (same) continue;
        if (inAnyBox(boxes, x, y)) changedInside += 1;
        else changedOutside += 1;
      }
    }
    assert.equal(changedOutside, 0, `có ${changedOutside} pixel NGOÀI hộp bị đổi — render tràn vùng`);
    assert.ok(changedInside > 0, 'không pixel nào trong hộp đổi — render không thực sự vẽ gì');
  });

  test('op chỉ `erase` cũng không được đụng pixel ngoài hộp của chính nó', async () => {
    const original = headphones();
    const box = { x: 100, y: 100, w: 60, h: 30 };
    const res = await purejs().render({
      image: { buffer: original, mime: 'image/png' },
      ops: [{ region_id: 'r1', box, action: 'erase' }],
    });
    assert.equal(res.status, 'OK');
    const before = toRgba(decodePng(original));
    const after = toRgba(decodePng(res.output.buffer));
    for (let y = 0; y < 320; y += 1) {
      for (let x = 0; x < 320; x += 1) {
        if (inAnyBox([box], x, y)) continue;
        assert.deepEqual(pixelAt(after, 320, x, y), pixelAt(before, 320, x, y), `pixel (${x},${y}) ngoài hộp bị đổi`);
      }
    }
  });

  test('thiếu glyph (中文) → PARTIAL + NO_GLYPH, và vùng đó KHÔNG bị xoá', async () => {
    const original = headphones();
    const box = { x: 40, y: 40, w: 160, h: 60 };
    const res = await purejs().render({
      image: { buffer: original, mime: 'image/png' },
      ops: [{ region_id: 'r1', box, action: 'erase_and_draw', text: '中文标识' }],
    });

    assert.equal(res.status, 'PARTIAL');
    assert.deepEqual(res.applied, []);
    assert.deepEqual(res.skipped, [{ region_id: 'r1', reason: 'NO_GLYPH' }]);
    assert.ok(res.unsupported_glyphs.includes('中'));
    assert.ok(res.warnings.some((w) => /KHÔNG xoá/.test(w)));

    const before = toRgba(decodePng(original));
    const after = toRgba(decodePng(res.output.buffer));
    for (let y = box.y; y < box.y + box.h; y += 1) {
      for (let x = box.x; x < box.x + box.w; x += 1) {
        assert.deepEqual(pixelAt(after, 320, x, y), pixelAt(before, 320, x, y), `pixel (${x},${y}) trong vùng NO_GLYPH bị đổi`);
      }
    }
  });

  test('chữ không vừa hộp → PARTIAL + TEXT_TOO_LONG/BOX_TOO_SMALL, vùng đó KHÔNG bị xoá', async () => {
    const original = headphones();
    const cases = [
      [{ x: 10, y: 10, w: 200, h: 14 }, 'Áo thun tay ngắn cotton thoáng mát quanh năm cho mọi người'],
      [{ x: 10, y: 10, w: 30, h: 12 }, 'Áo thun cotton'],
    ];
    for (const [box, text] of cases) {
      const res = await purejs().render({
        image: { buffer: original, mime: 'image/png' },
        ops: [{ region_id: 'r1', box, action: 'erase_and_draw', text }],
      });
      assert.equal(res.status, 'PARTIAL', `hộp ${JSON.stringify(box)} lẽ ra PARTIAL`);
      assert.equal(res.skipped.length, 1);
      assert.ok(['TEXT_TOO_LONG', 'BOX_TOO_SMALL'].includes(res.skipped[0].reason), `reason lạ: ${res.skipped[0].reason}`);

      const before = toRgba(decodePng(original));
      const after = toRgba(decodePng(res.output.buffer));
      for (let y = box.y; y < box.y + box.h; y += 1) {
        for (let x = box.x; x < box.x + box.w; x += 1) {
          assert.deepEqual(pixelAt(after, 320, x, y), pixelAt(before, 320, x, y), 'vùng không vừa hộp bị xoá');
        }
      }
    }
  });

  test('JPEG / WebP / GIF → UNSUPPORTED_IMAGE + error_code rõ, KHÔNG báo thành công', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8X'), Buffer.alloc(20)]);
    const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(20)]);

    for (const [label, buf] of [['JPEG', jpeg], ['WebP', webp], ['GIF', gif]]) {
      const res = await purejs().render({ image: { buffer: buf }, ops: [] });
      assert.equal(res.status, 'UNSUPPORTED_IMAGE', `${label} lẽ ra UNSUPPORTED_IMAGE`);
      assert.equal(res.error_code, 'RENDER_JPEG_UNSUPPORTED');
      assert.equal(res.output, null, 'không được trả ảnh khi không xử lý được');
      assert.match(res.error_message, /http/i, 'thông báo phải nói cần provider http');
      assert.notEqual(res.status, 'OK');
    }
  });

  test('vượt maxPixels của provider → UNSUPPORTED_IMAGE + IMAGE_TOO_LARGE', async () => {
    const res = await purejs({ maxPixels: 1000 }).render({ image: { buffer: headphones() }, ops: [] });
    assert.equal(res.status, 'UNSUPPORTED_IMAGE');
    assert.equal(res.error_code, 'IMAGE_TOO_LARGE');
    assert.equal(res.output, null);
  });

  test('render không có ảnh → FAILED + BAD_INPUT (không bao giờ báo OK rỗng)', async () => {
    const res = await purejs().render({ ops: [] });
    assert.equal(res.status, 'FAILED');
    assert.equal(res.error_code, 'BAD_INPUT');
    assert.equal(res.output, null);
  });
});

describe('MVP-02 render — layoutText (bất biến hình học)', () => {
  const font = loadFont('5x7');
  const insideBox = (line, box) =>
    line.x >= box.x && line.y >= box.y && line.x + line.w <= box.x + box.w && line.y + line.h <= box.y + box.h;

  test('200 hộp ngẫu nhiên (seed cố định): mọi đường bao luôn nằm trong hộp', () => {
    let seed = 20261004;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const texts = [
      'Áo thun tay ngắn cotton',
      'Ừ',
      'Đường phố Hà Nội',
      'x'.repeat(200),
      'Áo thun cotton thoáng mát quanh năm cho mọi người',
      'Ơn gọi',
    ];

    let fits = 0;
    let checked = 0;
    for (let i = 0; i < 200; i += 1) {
      const box = {
        x: Math.floor(rnd() * 300) - 20,
        y: Math.floor(rnd() * 300) - 20,
        w: 1 + Math.floor(rnd() * 220),
        h: 1 + Math.floor(rnd() * 90),
      };
      const text = texts[i % texts.length];
      const res = layoutText({ text, box, font });
      checked += 1;
      if (res.fits) fits += 1;
      for (const line of res.lines) {
        assert.ok(insideBox(line, box), `dòng tràn hộp (fits=${res.fits}, reason=${res.reason}): ${JSON.stringify({ box, line })}`);
      }
    }
    assert.equal(checked, 200);
    assert.ok(fits > 20, `quá ít ca fits=true (${fits}) — test hình học sẽ rỗng nghĩa`);
  });

  test('hộp biên: 10×6, w=0, hộp âm, hộp NaN, chữ 1 ký tự, chữ 200 ký tự', () => {
    const cases = [
      { text: 'A', box: { x: 0, y: 0, w: 10, h: 6 } },
      { text: 'A', box: { x: 0, y: 0, w: 0, h: 20 } },
      { text: 'A', box: { x: -30, y: -30, w: 60, h: 30 } },
      { text: 'A', box: { x: 5, y: 5, w: Number.NaN, h: 20 } },
      { text: 'x'.repeat(200), box: { x: 0, y: 0, w: 40, h: 20 } },
      { text: '', box: { x: 0, y: 0, w: 40, h: 20 } },
      { text: 'Đường', box: { x: 950, y: 950, w: 100, h: 60 } },
    ];
    for (const c of cases) {
      const res = layoutText({ text: c.text, box: c.box, font });
      assert.equal(typeof res.fits, 'boolean');
      assert.ok(Array.isArray(res.lines));
      for (const line of res.lines) assert.ok(insideBox(line, c.box), `tràn hộp: ${JSON.stringify({ c, line })}`);
      if (!res.fits) assert.ok(['TEXT_TOO_LONG', 'BOX_TOO_SMALL', 'BAD_BOX'].includes(res.reason), `reason lạ: ${res.reason}`);
      if (c.box.w === 0 || Number.isNaN(c.box.w)) {
        assert.equal(res.fits, false);
        assert.equal(res.reason, 'BAD_BOX');
        assert.deepEqual(res.lines, []);
      }
    }
  });

  test('chữ Việt có dấu không bị mất glyph và không tràn hộp', () => {
    const res = layoutText({ text: 'Đường Ớt Ừ', box: { x: 0, y: 0, w: 200, h: 40 }, font });
    assert.equal(res.fits, true);
    assert.equal(res.lines.length, 1);
    assert.equal(res.lines[0].text, 'Đường Ớt Ừ');
    assert.ok(insideBox(res.lines[0], { x: 0, y: 0, w: 200, h: 40 }));
  });

  test('hộp nhỏ hơn padding → BOX_TOO_SMALL, không vẽ gì', () => {
    const res = layoutText({ text: 'Áo', box: { x: 0, y: 0, w: 3, h: 3 }, font, options: { padding: 5 } });
    assert.equal(res.fits, false);
    assert.equal(res.reason, 'BOX_TOO_SMALL');
    assert.deepEqual(res.lines, []);
  });
});

describe('MVP-02 render — provider mock & factory', () => {
  test('provider mock: bản sao byte-identical + is_mock = true', async () => {
    const input = headphones();
    const before = Buffer.from(input);
    const provider = createRenderProvider({ render: { provider: 'mock' } });
    assert.equal(provider.name, 'mock');
    assert.equal(provider.isMock, true);

    const res = await provider.render({
      image: { buffer: input, mime: 'image/png' },
      ops: [{ region_id: 'r1', box: { x: 0, y: 0, w: 10, h: 10 }, action: 'erase_and_draw', text: 'Áo' }],
    });
    assert.equal(res.status, 'PARTIAL');
    // SỬA THEO N-5 (vòng 4): provider mock KHÔNG đổi pixel nào ⇒ ảnh trả về y hệt ảnh gốc
    // ⇒ engine KHÔNG được báo `OK` (báo OK khi không vẽ gì là nói dối). Kết quả đúng là
    // PARTIAL + `NO_OPS` + cảnh báo nói thẳng; các khẳng định còn lại giữ nguyên.
    assert.equal(res.error_code, 'NO_OPS');
    assert.match(res.warnings.join(' '), /y hệt ảnh gốc|KHÔNG phải kết quả đã render/i);
    assert.equal(res.is_mock, true);
    assert.equal(res.output.sha256, sha256(input));
    assert.ok(res.output.buffer.equals(input), 'mock phải trả bản sao y nguyên byte');
    assert.ok(input.equals(before));
    // ...và vì ảnh KHÔNG đổi một pixel nào nên danh sách `applied` do mock tự khai bị BỎ
    // (N-5d: không tin lời khai khi sha256 ảnh trả về trùng ảnh gốc).
    assert.equal(res.applied.length, 0);
    assert.match(res.warnings.join(' '), /mock/i);
    assert.match(res.warnings.join(' '), /KHÔNG tính là đã vẽ/i);
  });

  test('factory: tên provider lạ → ném RenderError UNKNOWN_PROVIDER', () => {
    assert.throws(
      () => createRenderProvider({ render: { provider: 'provider-khong-ton-tai' } }),
      (err) => err instanceof RenderError && err.code === 'UNKNOWN_PROVIDER',
    );
  });

  test('factory: provider "none" → NOT_CONFIGURED, không tạo ảnh giả', async () => {
    const provider = createRenderProvider({ render: { provider: 'none' } });
    assert.equal(provider.configured, false);
    const res = await provider.render({ image: { buffer: headphones() }, ops: [] });
    assert.equal(res.status, 'NOT_CONFIGURED');
    assert.equal(res.output, null);
    assert.ok(res.error_code);
  });
});

describe('MVP-02 render — MẶT NẠ vùng bảo vệ (F-01 lớp 2: pixel bất khả xâm phạm)', () => {
  const W = 64;
  const H = 64;
  const BRAND = { x: 8, y: 8, w: 48, h: 16 };

  /** Ảnh 64×64 nền trắng, một dải ĐỎ đặc đúng bằng hộp "nhãn hiệu". */
  function makeImage() {
    const data = Buffer.alloc(W * H * 4, 255);
    for (let y = BRAND.y; y < BRAND.y + BRAND.h; y += 1) {
      for (let x = BRAND.x; x < BRAND.x + BRAND.w; x += 1) {
        const i = (y * W + x) * 4;
        data[i] = 255;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
    return encodePng({ width: W, height: H, channels: 4, data });
  }

  const rgbaOf = (buffer) => toRgba(decodePng(buffer));

  /** Đếm pixel KHÁC nhau trong một hộp giữa hai ảnh RGBA. */
  function diffInBox(a, b, box) {
    let n = 0;
    for (let y = box.y; y < box.y + box.h; y += 1) {
      for (let x = box.x; x < box.x + box.w; x += 1) {
        const i = (y * W + x) * 4;
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n += 1;
      }
    }
    return n;
  }

  test('op nằm TRỌN trong vùng bảo vệ → skipped PROTECTED_BOX_MASKED, 0 pixel đổi', async () => {
    const image = makeImage();
    const res = await purejs().render({
      image: { buffer: image, mime: 'image/png' },
      ops: [{ region_id: 'r9', box: BRAND, action: 'erase_and_draw', text: 'AB', style: {} }],
      options: { protected_boxes: [{ region_id: 'r1', box: BRAND }] },
    });

    assert.equal(res.status, 'PARTIAL');
    assert.deepEqual(res.applied, [], 'không được coi là đã áp dụng');
    assert.equal(res.skipped.find((s) => s.region_id === 'r9')?.reason, 'PROTECTED_BOX_MASKED');
    assert.match(res.warnings.join(' '), /TRỌN trong vùng được bảo vệ/);
    assert.equal(sha256(res.output.buffer), sha256(image), 'không op nào áp dụng ⇒ trả nguyên byte gốc');
  });

  test('op CHỒNG MỘT PHẦN vùng bảo vệ → chỉ vẽ ngoài vùng bảo vệ, pixel trong đó KHÔNG đổi', async () => {
    const image = makeImage();
    const leftHalf = { x: 8, y: 8, w: 24, h: 16 };
    const rightHalf = { x: 32, y: 8, w: 24, h: 16 };

    const res = await purejs().render({
      image: { buffer: image, mime: 'image/png' },
      ops: [{ region_id: 'r9', box: BRAND, action: 'erase_and_draw', text: 'AB', style: {} }],
      options: { protected_boxes: [{ region_id: 'r1', box: leftHalf }] },
    });

    assert.equal(res.status, 'PARTIAL');
    assert.equal(res.applied.length, 1);
    assert.equal(res.applied[0].masked, true, 'op bị mặt nạ chặn một phần phải được ghi vết');
    assert.match(res.warnings.join(' '), /MẶT NẠ vùng bảo vệ chặn một phần/);

    const before = rgbaOf(image);
    const after = rgbaOf(res.output.buffer);
    assert.equal(diffInBox(before, after, leftHalf), 0, 'nửa được bảo vệ phải NGUYÊN VẸN');
    assert.ok(diffInBox(before, after, rightHalf) > 0, 'nửa không bị bảo vệ vẫn phải được vẽ');
  });

  test('hộp bảo vệ KHÔNG kèm region_id → chặn MỌI op, kể cả op cùng vùng', async () => {
    const image = makeImage();
    const res = await purejs().render({
      image: { buffer: image, mime: 'image/png' },
      ops: [{ region_id: 'r1', box: BRAND, action: 'erase_and_draw', text: 'AB', style: {} }],
      options: { protected_boxes: [BRAND] },
    });
    assert.deepEqual(res.applied, []);
    assert.equal(res.skipped.find((s) => s.region_id === 'r1')?.reason, 'PROTECTED_BOX_MASKED');
  });

  test('op của CHÍNH vùng được bảo vệ (override có vết) vẫn vẽ được lên vùng đó', async () => {
    const image = makeImage();
    const res = await purejs().render({
      image: { buffer: image, mime: 'image/png' },
      ops: [{ region_id: 'r1', box: BRAND, action: 'erase_and_draw', text: 'AB', style: {} }],
      options: { protected_boxes: [{ region_id: 'r1', box: BRAND }] },
    });
    assert.equal(res.applied.length, 1);
    assert.equal(res.applied[0].masked, undefined);
    const before = rgbaOf(image);
    const after = rgbaOf(res.output.buffer);
    assert.ok(diffInBox(before, after, BRAND) > 0, 'override có vết phải thay được chữ trong vùng của nó');
  });

  test('op của vùng A KHÔNG được chạm vùng bảo vệ của vùng B (dù cùng lần render)', async () => {
    const image = makeImage();
    const res = await purejs().render({
      image: { buffer: image, mime: 'image/png' },
      ops: [{ region_id: 'r2', box: BRAND, action: 'erase_and_draw', text: 'AB', style: {} }],
      options: {
        protected_boxes: [
          { region_id: 'r1', box: BRAND }, // vùng khác ⇒ phải chặn
        ],
      },
    });
    assert.deepEqual(res.applied, []);
    assert.equal(sha256(res.output.buffer), sha256(image));
  });
});
