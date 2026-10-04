/**
 * TEST MVP-03 · E1 — MATTING (`src/imagestudio/matting/`), hợp đồng §3.1.
 *
 * Provider chạy THẬT, offline: `purejs` (flood fill từ viền), `mock`, `none`.
 * Mọi khẳng định đều đọc PIXEL THẬT của ảnh ra (không tin `status` tự khai):
 *  - nền đồng nhất ⇒ `OK`, alpha nền = 0, pixel sản phẩm KHÔNG đổi một byte;
 *  - nền không đồng nhất ⇒ `UNIFORM_BACKGROUND_NOT_FOUND` + `output = null` + số đo thật;
 *  - ảnh toàn một màu ⇒ `SUSPICIOUS_MASK` (fail-closed, không cắt bừa);
 *  - ảnh không phải PNG ⇒ `UNSUPPORTED_IMAGE`; thiếu cấu hình ⇒ `NOT_CONFIGURED`;
 *  - `mock` ⇒ `is_mock = true` và KHÔNG tách thật (ảnh ra là bản sao y nguyên);
 *  - sha256 ảnh VÀO không đổi sau mọi lời gọi.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { encodePng, sha256 } from '../src/imagelab/render/index.js';
import {
  createMattingProvider,
  MATTING_STATUS,
  MATTING_CODES,
  MattingError,
  MOCK_MASK,
  MATTING_RESULT_FIELDS,
  MATTING_MASK_FIELDS,
  MATTING_MASK_EXTRA_FIELDS,
} from '../src/imagestudio/matting/index.js';
import { silent } from './helpers.js';
import { productImage, noisyImage, solidImage, pixelsOf, sizeOf } from './imagestudio-helpers.js';

const purejs = () => createMattingProvider({}, { logger: silent });

/** Ảnh nền GRADIENT (mỗi pixel viền một màu khác) — tất định, không dùng ngẫu nhiên. */
function gradientImage({ width = 64, height = 64, box = { x: 20, y: 20, w: 24, h: 24 } } = {}) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = x * 4;
      data[i + 1] = y * 4;
      data[i + 2] = 128;
      data[i + 3] = 255;
    }
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

const jpegBytes = () =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]), Buffer.alloc(8)]);
const gifBytes = () => Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(12)]);
const webpBytes = () => {
  const buf = Buffer.alloc(24);
  buf.write('RIFF', 0, 'latin1');
  buf.write('WEBP', 8, 'latin1');
  return buf;
};

describe('MVP-03 matting — nền đồng nhất: tách THẬT, sản phẩm không đổi', () => {
  const box = { x: 20, y: 20, w: 24, h: 24 };

  test('status = OK, output PNG cùng khung, alpha nền = 0, pixel sản phẩm y hệt', async () => {
    const buffer = productImage({ box });
    const before = sha256(buffer);
    const result = await purejs().removeBackground({ image: { buffer, mime: 'image/png' } });

    assert.equal(result.status, MATTING_STATUS.OK);
    assert.equal(result.error_code, null);
    assert.ok(result.output, 'phải có ảnh ra');
    assert.equal(result.output.mime, 'image/png');
    assert.equal(result.output.width, 64);
    assert.equal(result.output.height, 64);
    assert.equal(sizeOf(result.output.buffer).width, 64);

    // (1) Nền (alpha = 0) và sản phẩm (alpha > 0) — kiểm PIXEL THẬT.
    const out = pixelsOf(result.output.buffer);
    const src = pixelsOf(buffer);
    assert.equal(out.data[3], 0, 'pixel góc trên-trái là nền ⇒ alpha phải = 0');
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const i = (y * 64 + x) * 4;
        const inObject = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
        if (inObject) {
          assert.deepEqual(
            [out.data[i], out.data[i + 1], out.data[i + 2], out.data[i + 3]],
            [src.data[i], src.data[i + 1], src.data[i + 2], src.data[i + 3]],
            `pixel sản phẩm (${x},${y}) KHÔNG được đổi`,
          );
        } else {
          assert.equal(out.data[i + 3], 0, `pixel nền (${x},${y}) phải trong suốt`);
        }
      }
    }
    assert.ok(result.output.sha256 && result.output.sha256 !== before, 'ảnh ra phải khác ảnh vào (có pixel nền bị tách)');
    assert.equal(sha256(result.output.buffer), result.output.sha256, 'sha256 ảnh ra do CHÍNH provider tính, không tin lời khai');
  });

  test('mask có SỐ ĐO THẬT + kept_bbox khớp vùng sản phẩm', async () => {
    const image2 = productImage({ box });
    const result = await purejs().removeBackground({ image: { buffer: image2, mime: 'image/png' } });

    // 24×24 / (64×64) = 0.140625 — số đo phải khớp hình học thật, không phải hằng số.
    assert.equal(result.mask.coverage, 0.1406);
    assert.equal(result.mask.background_ratio, 0.8594);
    assert.equal(Math.round((result.mask.coverage + result.mask.background_ratio) * 10000) / 10000, 1, 'coverage + background_ratio = 1');
    assert.equal(result.mask.uniformity, 1, 'nền trắng đồng nhất tuyệt đối');
    assert.equal(result.mask.seed_colors, 1);
    assert.deepEqual(result.kept_bbox, { x: 20, y: 20, w: 24, h: 24 });
    assert.ok(result.warnings.length > 0, 'phải có cảnh báo nói rõ số đo thật');
    assert.ok(
      result.warnings.some((w) => w.includes('Hộp bao phần giữ lại')),
      'cảnh báo phải nêu hộp bao phần giữ lại',
    );
  });

  test('sha256 + byte ảnh VÀO không đổi sau khi tách nền', async () => {
    const buffer = productImage({ box });
    const copy = Buffer.from(buffer);
    const result = await purejs().removeBackground({ image: { buffer, mime: 'image/png' } });
    assert.equal(result.status, MATTING_STATUS.OK);
    assert.equal(sha256(buffer), sha256(copy), 'sha256 ảnh vào phải giữ nguyên');
    assert.ok(buffer.equals(copy), 'buffer ảnh vào KHÔNG được sửa tại chỗ');
  });

  test('kết quả đúng bộ field ĐÓNG BĂNG của MattingResult', async () => {
    const result = await purejs().removeBackground({ image: { buffer: productImage({ box }), mime: 'image/png' } });
    assert.deepEqual(Object.keys(result), [...MATTING_RESULT_FIELDS]);
    // M03-01a (vòng 8): `mask` có 4 số đo ĐÓNG BĂNG + các số đo MỞ RỘNG do provider đo được
    // (`kept_bbox_ratio`, `boundary_delta`) — phần mở rộng phải nằm trong danh sách cho phép.
    const maskKeys = Object.keys(result.mask);
    assert.deepEqual(maskKeys.slice(0, MATTING_MASK_FIELDS.length), [...MATTING_MASK_FIELDS]);
    for (const key of maskKeys.slice(MATTING_MASK_FIELDS.length)) {
      assert.ok(MATTING_MASK_EXTRA_FIELDS.includes(key), `khoá mask lạ: ${key}`);
    }
    assert.equal(typeof result.elapsed_ms, 'number');
    assert.ok(result.elapsed_ms >= 0);
  });
});

describe('MVP-03 matting — fail-closed: nền không đồng nhất', () => {
  test('nền gradient ⇒ UNIFORM_BACKGROUND_NOT_FOUND + output = null + số đo thật', async () => {
    const buffer = gradientImage();
    const result = await purejs().removeBackground({ image: { buffer, mime: 'image/png' } });

    assert.equal(result.status, MATTING_STATUS.UNIFORM_BACKGROUND_NOT_FOUND);
    assert.equal(result.error_code, MATTING_CODES.UNIFORM_BACKGROUND_NOT_FOUND);
    assert.equal(result.output, null, 'TỪ CHỐI thì KHÔNG được kèm ảnh ra');
    assert.equal(result.kept_bbox, null);
    assert.ok(result.mask.uniformity < 0.75, `uniformity phải là số đo thật (< 0.75), nhận ${result.mask.uniformity}`);
    assert.ok(result.mask.seed_colors > 1, 'viền gradient có nhiều cụm màu');
    assert.equal(result.mask.coverage, null, 'không đo được coverage thì để null, KHÔNG bịa');
  });

  test('nền nhiễu ⇒ UNIFORM_BACKGROUND_NOT_FOUND + output = null', async () => {
    const buffer = noisyImage();
    const result = await purejs().removeBackground({ image: { buffer, mime: 'image/png' } });
    assert.equal(result.status, MATTING_STATUS.UNIFORM_BACKGROUND_NOT_FOUND);
    assert.equal(result.output, null);
    assert.ok(result.mask.uniformity < 0.5, `nền nhiễu ⇒ uniformity rất thấp, nhận ${result.mask.uniformity}`);
    assert.ok(result.error_message && result.error_message.includes('TỪ CHỐI'), 'câu từ chối phải nói thẳng');
  });

  test('ảnh toàn một màu ⇒ SUSPICIOUS_MASK (mask dị thường) + output = null', async () => {
    const buffer = solidImage();
    const result = await purejs().removeBackground({ image: { buffer, mime: 'image/png' } });
    assert.equal(result.status, MATTING_STATUS.FAILED);
    assert.equal(result.error_code, MATTING_CODES.SUSPICIOUS_MASK);
    assert.equal(result.output, null);
    assert.equal(result.mask.background_ratio, 1, 'toàn ảnh là nền ⇒ tỉ lệ nền = 1 (ngoài khoảng an toàn)');
  });
});

describe('MVP-03 matting — ảnh không hỗ trợ & cấu hình thiếu', () => {
  for (const [name, make] of [
    ['JPEG', jpegBytes],
    ['GIF', gifBytes],
    ['WebP', webpBytes],
  ]) {
    test(`ảnh ${name} ⇒ UNSUPPORTED_IMAGE + output = null`, async () => {
      const buffer = make();
      const before = sha256(buffer);
      const result = await purejs().removeBackground({ image: { buffer, mime: `image/${name.toLowerCase()}` } });
      assert.equal(result.status, MATTING_STATUS.UNSUPPORTED_IMAGE);
      assert.equal(result.error_code, MATTING_CODES.UNSUPPORTED_IMAGE);
      assert.equal(result.output, null, 'không được trả ảnh khi không xử lý được');
      assert.equal(sha256(buffer), before);
    });
  }

  test('thiếu cấu hình (provider none) ⇒ NOT_CONFIGURED', async () => {
    const provider = createMattingProvider({ matting: { provider: 'none' } }, { logger: silent });
    assert.equal(provider.configured, false);
    const result = await provider.removeBackground({ image: { buffer: productImage(), mime: 'image/png' } });
    assert.equal(result.status, MATTING_STATUS.NOT_CONFIGURED);
    assert.equal(result.error_code, MATTING_CODES.NOT_CONFIGURED);
    assert.equal(result.output, null);
  });

  test('provider http thiếu baseUrl ⇒ NOT_CONFIGURED (không gọi mạng)', async () => {
    const provider = createMattingProvider({ matting: { provider: 'http' } }, { logger: silent });
    assert.equal(provider.name, 'http');
    assert.equal(provider.configured, false);
    const result = await provider.removeBackground({ image: { buffer: productImage(), mime: 'image/png' } });
    assert.equal(result.status, MATTING_STATUS.NOT_CONFIGURED);
    assert.equal(result.error_code, MATTING_CODES.NOT_CONFIGURED);
  });

  test('provider lạ ⇒ MattingError UNKNOWN_PROVIDER (fail-closed, không âm thầm đổi provider)', () => {
    assert.throws(
      () => createMattingProvider({ matting: { provider: 'khong-co-that' } }, { logger: silent }),
      (err) => err instanceof MattingError && err.code === MATTING_CODES.UNKNOWN_PROVIDER,
    );
  });

  test('probe() không bao giờ ném lỗi, trả null với dữ liệu rác', async () => {
    const provider = purejs();
    assert.deepEqual(await provider.probe({ buffer: productImage() }), { width: 64, height: 64 });
    assert.equal(await provider.probe({ buffer: Buffer.from('rác') }), null);
    assert.equal(await provider.probe({}), null);
  });
});

describe('MVP-03 matting — provider mock KHÔNG tách thật', () => {
  test('is_mock = true, ảnh ra là BẢN SAO y nguyên (không pixel nền nào bị tách)', async () => {
    const provider = createMattingProvider({ matting: { provider: 'mock' } }, { logger: silent });
    assert.equal(provider.isMock, true);
    const buffer = productImage();
    const result = await provider.removeBackground({ image: { buffer, mime: 'image/png' } });

    assert.equal(result.status, MATTING_STATUS.OK);
    assert.equal(result.is_mock, true);
    assert.equal(result.provider, 'mock');
    assert.equal(sha256(result.output.buffer), sha256(buffer), 'mock trả bản sao ⇒ sha256 y hệt ảnh vào');
    assert.deepEqual(result.mask, { ...MOCK_MASK });
    assert.ok(
      result.warnings.some((w) => w.includes('KHÔNG tách nền thật')),
      'mock phải tự khai là không tách thật',
    );
    // Ảnh vào vẫn nguyên vẹn.
    assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0);
  });

  test('mock vẫn từ chối ảnh không phải PNG ⇒ UNSUPPORTED_IMAGE', async () => {
    const provider = createMattingProvider({ matting: { provider: 'mock' } }, { logger: silent });
    const result = await provider.removeBackground({ image: { buffer: jpegBytes(), mime: 'image/jpeg' } });
    assert.equal(result.status, MATTING_STATUS.UNSUPPORTED_IMAGE);
    assert.equal(result.output, null);
  });
});
