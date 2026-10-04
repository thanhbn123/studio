/**
 * TEST MVP-03 · E2 — NỀN + GHÉP + OVERLAY (`src/imagestudio/compose/**`), hợp đồng §3.2 + §3.5.
 *
 * Ba luật được kiểm bằng PIXEL THẬT:
 *  1. 5 mẫu nền đều `synthetic: true` (nền MÔ PHỎNG, không phải ảnh thật);
 *  2. pixel GIỮ LẠI (mask > 0) y hệt ảnh vào — đếm pixel đổi NGOÀI vùng sản phẩm phải = 0;
 *     nền chỉ được ghi vào pixel alpha = 0;
 *  3. overlay thiếu bằng chứng / còn chữ Hán ⇒ KHÔNG vẽ một pixel nào (sha ảnh ra = sha ảnh vào).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { sha256 } from '../src/imagelab/render/index.js';
import {
  TEMPLATES,
  TEMPLATE_IDS,
  composeImage,
  drawOverlay,
  applyTemplate,
  ComposeError,
  COMPOSE_CODES,
  NO_MASK_WARNING,
  OVERLAY_REASONS,
} from '../src/imagestudio/compose/index.js';
import { createMattingProvider } from '../src/imagestudio/matting/index.js';
import { silent } from './helpers.js';
import {
  productImage,
  transparentImage,
  pixelAt,
  pixelsOf,
  countChangedInsideOutside,
  countChanged,
  sizeOf,
} from './imagestudio-helpers.js';

const BOX = { x: 20, y: 20, w: 24, h: 24 };
const INPUT = () => productImage({ box: BOX });

/** Kết quả tách nền THẬT của provider purejs (dùng làm mask cho compose). */
async function mattingFor(buffer) {
  return createMattingProvider({}, { logger: silent }).removeBackground({ image: { buffer, mime: 'image/png' } });
}

describe('MVP-03 compose — bộ mẫu nền MÔ PHỎNG', () => {
  test('đúng 5 mẫu, id đóng băng, MỌI mẫu đều synthetic = true', () => {
    assert.deepEqual([...TEMPLATE_IDS], ['trang', 'xam-nhat', 'gradient-xanh', 'gradient-hong', 'san-go']);
    assert.equal(TEMPLATES.length, 5);
    assert.ok(Object.isFrozen(TEMPLATES));
    for (const template of TEMPLATES) {
      assert.equal(template.synthetic, true, `mẫu ${template.id} phải khai synthetic = true`);
      assert.ok(template.label && template.kind, `mẫu ${template.id} phải có label + kind`);
    }
  });

  test('mẫu lạ ⇒ ComposeError có mã + danh sách mẫu hợp lệ (fail-closed, không thay bằng nền trắng)', async () => {
    const matting = await mattingFor(INPUT());
    assert.throws(
      () => composeImage({ image: { buffer: INPUT(), mime: 'image/png' }, matting, template: 'khong-co-mau-nay' }),
      (err) =>
        err instanceof ComposeError &&
        err.code === COMPOSE_CODES.TEMPLATE_NOT_FOUND &&
        Array.isArray(err.details?.available) &&
        err.details.available.length === 5,
    );
  });

  test('applyTemplate từ chối width/height không hợp lệ (BAD_INPUT)', () => {
    assert.throws(() => applyTemplate({ width: 0, height: 10, template: 'trang' }), (err) => err.code === COMPOSE_CODES.BAD_INPUT);
  });
});

describe('MVP-03 compose — pixel GIỮ LẠI bất khả xâm phạm (5 mẫu)', () => {
  for (const template of TEMPLATE_IDS) {
    test(`mẫu "${template}": nền chỉ ghi vào vùng trong suốt, sản phẩm y hệt ảnh vào`, async () => {
      const input = INPUT();
      const matting = await mattingFor(input);
      assert.equal(matting.status, 'OK');

      const maskSha = sha256(matting.output.buffer);
      const result = composeImage({ image: { buffer: input, mime: 'image/png' }, matting, template });

      assert.equal(result.template.id, template);
      assert.equal(result.template.synthetic, true, 'mọi nền sinh ra phải khai MÔ PHỎNG');
      assert.equal(result.background_ratio, 0.8594);
      assert.deepEqual(sizeOf(result.output.buffer), { width: 64, height: 64, mime: 'image/png' });
      assert.equal(result.output.sha256, sha256(result.output.buffer));

      // Đếm pixel THẬT: không một pixel nào ngoài vùng sản phẩm được giữ nguyên.
      const { inside, outside } = countChangedInsideOutside(matting.output.buffer, result.output.buffer, BOX);
      assert.equal(inside, 0, 'pixel sản phẩm KHÔNG được đổi');
      assert.equal(outside, 64 * 64 - BOX.w * BOX.h, 'toàn bộ vùng nền phải được ghép nền mới');

      // So với ẢNH GỐC: vùng sản phẩm vẫn y hệt từng byte.
      const a = pixelsOf(input);
      const b = pixelsOf(result.output.buffer);
      for (let y = BOX.y; y < BOX.y + BOX.h; y += 1) {
        for (let x = BOX.x; x < BOX.x + BOX.w; x += 1) {
          const i = (y * 64 + x) * 4;
          assert.deepEqual([b.data[i], b.data[i + 1], b.data[i + 2], b.data[i + 3]], [a.data[i], a.data[i + 1], a.data[i + 2], a.data[i + 3]]);
        }
      }
      // Mask đầu vào KHÔNG bị sửa tại chỗ.
      assert.equal(sha256(matting.output.buffer), maskSha, 'compose không được sửa mask đầu vào');
    });
  }

  test('màu nền đúng theo mẫu (trang = trắng, xam-nhat = #ececec)', async () => {
    const input = INPUT();
    const matting = await mattingFor(input);
    const white = composeImage({ image: { buffer: input, mime: 'image/png' }, matting, template: 'trang' });
    const grey = composeImage({ image: { buffer: input, mime: 'image/png' }, matting, template: 'xam-nhat' });
    assert.deepEqual(pixelAt(white.output.buffer, 0, 0), [255, 255, 255, 255]);
    assert.deepEqual(pixelAt(grey.output.buffer, 0, 0), [236, 236, 236, 255]);
  });

  test('thiếu mask ⇒ KHÔNG ghép: trả bản sao y nguyên + background_ratio = 0 + cảnh báo chuẩn', () => {
    const input = INPUT();
    const result = composeImage({ image: { buffer: input, mime: 'image/png' }, matting: null, template: 'trang' });
    assert.equal(result.background_ratio, 0);
    assert.equal(countChanged(input, result.output.buffer), 0, 'không pixel nào được đổi');
    assert.ok(result.warnings.includes(NO_MASK_WARNING), 'phải có câu cảnh báo chuẩn của hợp đồng §3.2');
  });

  test('mask LỆCH kích thước ⇒ KHÔNG ghép (không resize/crop) + cảnh báo', async () => {
    const small = transparentImage({ width: 32, height: 32, opaqueBox: { x: 8, y: 8, w: 12, h: 12 } });
    const bigMask = await mattingFor(INPUT()); // mask 64×64
    const result = composeImage({ image: { buffer: small, mime: 'image/png' }, matting: bigMask, template: 'trang' });
    assert.equal(result.background_ratio, 0);
    assert.equal(countChanged(small, result.output.buffer), 0);
    assert.ok(
      result.warnings.some((w) => w.includes('lệch kích thước')),
      'phải nói thẳng mask lệch kích thước',
    );
  });
});

describe('MVP-03 overlay — chống bịa + chữ chưa dịch', () => {
  test('overlay HỢP LỆ (có bằng chứng) ⇒ applied = true và có pixel đổi TRONG hộp', () => {
    const input = INPUT();
    const result = drawOverlay({
      image: { buffer: input, mime: 'image/png' },
      overlay: { text: 'Tai nghe', x: 2, y: 2, w: 40, h: 20, size: 10, color: '#000000' },
      source_text: 'Tai nghe Bluetooth chống ồn',
    });
    assert.equal(result.applied, true);
    assert.equal(result.reason, null);
    assert.deepEqual(result.violations, []);
    const { inside, outside } = countChangedInsideOutside(input, result.buffer, { x: 2, y: 2, w: 40, h: 20 });
    assert.ok(inside > 0, 'phải có pixel được vẽ trong hộp overlay');
    assert.equal(outside, 0, 'KHÔNG được vẽ ra ngoài hộp overlay');
  });

  for (const text of ['Bảo hành 12 tháng', 'chính hãng']) {
    test(`overlay "${text}" + nguồn RỖNG ⇒ applied = false, OVERLAY_UNSUPPORTED_CLAIM, 0 pixel đổi`, () => {
      const input = INPUT();
      const result = drawOverlay({
        image: { buffer: input, mime: 'image/png' },
        overlay: { text, x: 2, y: 2, w: 60, h: 20, size: 10 },
      });
      assert.equal(result.applied, false);
      assert.equal(result.reason, OVERLAY_REASONS.UNSUPPORTED_CLAIM);
      assert.ok(result.violations.length > 0, 'phải kèm danh sách vi phạm cụ thể');
      assert.equal(countChanged(input, result.buffer), 0, 'KHÔNG được vẽ một pixel nào');
      assert.equal(sha256(result.buffer), sha256(input), 'ảnh ra phải y hệt ảnh vào');
    });
  }

  test('overlay có chữ Hán chưa dịch ⇒ OVERLAY_NOT_TRANSLATED + 0 pixel đổi', () => {
    const input = INPUT();
    const result = drawOverlay({
      image: { buffer: input, mime: 'image/png' },
      overlay: { text: '保修 12 个月', x: 2, y: 2, w: 60, h: 20, size: 10 },
      source_text: '保修 12 个月',
    });
    assert.equal(result.applied, false);
    assert.equal(result.reason, OVERLAY_REASONS.NOT_TRANSLATED);
    assert.equal(countChanged(input, result.buffer), 0);
    assert.equal(sha256(result.buffer), sha256(input));
  });

  test('cùng khẳng định NHƯNG có bằng chứng trong chữ gốc ⇒ được vẽ (không chặn oan)', () => {
    const input = INPUT();
    const result = drawOverlay({
      image: { buffer: input, mime: 'image/png' },
      overlay: { text: 'Bảo hành 12 tháng', x: 2, y: 2, w: 60, h: 20, size: 10 },
      source_text: 'Bảo hành 12 tháng theo phiếu trong hộp',
    });
    assert.equal(result.applied, true);
    assert.ok(countChanged(input, result.buffer) > 0);
  });

  test('ảnh không giải mã được ⇒ không vẽ (OVERLAY_UNSUPPORTED_IMAGE)', () => {
    const junk = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
    const result = drawOverlay({ image: { buffer: junk, mime: 'image/jpeg' }, overlay: { text: 'Tai nghe', x: 0, y: 0 } });
    assert.equal(result.applied, false);
    assert.equal(result.reason, OVERLAY_REASONS.UNSUPPORTED_IMAGE);
  });
});
