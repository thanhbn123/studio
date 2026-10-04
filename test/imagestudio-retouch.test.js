/**
 * TEST MVP-03 · E1 — RETOUCH (`src/imagestudio/retouch/`), hợp đồng §3.4.
 *
 * Bốn luật được kiểm bằng PIXEL THẬT và bằng bảng ngưỡng ĐÓNG BĂNG:
 *  1. vượt `RETOUCH_LIMITS` ⇒ KẸP (không từ chối âm thầm) + ghi tên vào `clamped[]`,
 *     `params_effective` luôn nằm TRONG ngưỡng;
 *  2. tham số không phải số hữu hạn (`NaN`, `'0.2'`, `[]`, `{}`, `Infinity`) ⇒ `rejected[]`;
 *  3. không tham số ⇒ `NO_CHANGES` + `output = null` (không bịa là đã retouch);
 *  4. KHÔNG đổi kích thước, KHÔNG dịch pixel, KHÔNG đổi kênh alpha (nền đã tách giữ alpha = 0),
 *     và sha256 ảnh VÀO không đổi.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { sha256 } from '../src/imagelab/render/index.js';
import {
  createRetouchProvider,
  RETOUCH_LIMITS,
  RETOUCH_PARAM_NAMES,
  RETOUCH_RESULT_FIELDS,
  RETOUCH_STATUS,
  clampRetouchParams,
} from '../src/imagestudio/retouch/index.js';
import { silent } from './helpers.js';
import { productImage, transparentImage, pixelsOf, pixelAt, countChangedInsideOutside, sizeOf } from './imagestudio-helpers.js';

const BOX = { x: 20, y: 20, w: 24, h: 24 };
const purejs = (opts) => createRetouchProvider(opts ?? {}, { logger: silent });
const jpegBytes = () =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]), Buffer.alloc(8)]);

describe('MVP-03 retouch — ngưỡng ĐÓNG BĂNG + kẹp tham số', () => {
  test('RETOUCH_LIMITS đúng hợp đồng §3.4 và bị đóng băng', () => {
    assert.deepEqual({ ...RETOUCH_LIMITS }, { brightness: 0.25, contrast: 0.25, saturation: 0.3, sharpen: 0.5 });
    assert.ok(Object.isFrozen(RETOUCH_LIMITS));
    assert.deepEqual([...RETOUCH_PARAM_NAMES], ['brightness', 'contrast', 'saturation', 'sharpen']);
  });

  test('vượt ngưỡng ⇒ clamped[] đúng tên + params_effective nằm TRONG ngưỡng', async () => {
    const provider = purejs();
    const result = await provider.apply({
      image: { buffer: productImage({ box: BOX }), mime: 'image/png' },
      params: { brightness: 5, contrast: -9, saturation: 0.3, sharpen: -0.5 },
    });

    assert.equal(result.status, RETOUCH_STATUS.OK);
    assert.deepEqual(result.clamped, ['brightness', 'contrast']);
    assert.equal(result.params_effective.brightness, RETOUCH_LIMITS.brightness);
    assert.equal(result.params_effective.contrast, -RETOUCH_LIMITS.contrast);
    assert.equal(result.params_effective.saturation, 0.3, 'trong ngưỡng thì giữ nguyên');
    assert.equal(result.params_effective.sharpen, -0.5);
    for (const name of RETOUCH_PARAM_NAMES) {
      assert.ok(
        Math.abs(result.params_effective[name]) <= RETOUCH_LIMITS[name] + 1e-12,
        `${name} = ${result.params_effective[name]} VƯỢT ngưỡng ${RETOUCH_LIMITS[name]}`,
      );
    }
    assert.deepEqual(result.rejected, []);
    assert.ok(
      result.warnings.some((w) => w.includes('KẸP') && w.includes('brightness')),
      'cảnh báo phải nói rõ tham số bị kẹp',
    );
  });

  test('clampRetouchParams: giá trị vượt biên bị kẹp ĐÚNG biên, giá trị trong biên giữ nguyên', () => {
    const { params, clamped, rejected } = clampRetouchParams({
      brightness: -1,
      contrast: 1,
      saturation: 0.1,
      sharpen: 0,
    });
    assert.deepEqual(clamped, ['brightness', 'contrast']);
    assert.deepEqual(rejected, []);
    assert.deepEqual(params, { brightness: -0.25, contrast: 0.25, saturation: 0.1, sharpen: 0 });
  });

  test('provider KHÔNG BAO GIỜ nới ngưỡng dù cấu hình đòi rộng hơn', () => {
    const provider = createRetouchProvider(
      { retouch: { provider: 'purejs', limits: { brightness: 9, contrast: 9, saturation: 9, sharpen: 9 } } },
      { logger: silent },
    );
    assert.deepEqual({ ...provider.retouchLimits }, { ...RETOUCH_LIMITS });
  });
});

describe('MVP-03 retouch — tham số rác bị TỪ CHỐI', () => {
  test('NaN / chuỗi / mảng / object / Infinity ⇒ rejected[], coi như không truyền', async () => {
    const provider = purejs();
    const result = await provider.apply({
      image: { buffer: productImage({ box: BOX }), mime: 'image/png' },
      params: { brightness: Number.NaN, contrast: '0.2', saturation: [], sharpen: {}, sharpen2: Infinity },
    });

    // Bốn tên hợp lệ + tên lạ đều phải lộ ra, KHÔNG im lặng.
    assert.deepEqual(result.rejected, ['brightness', 'contrast', 'saturation', 'sharpen', 'sharpen2']);
    assert.deepEqual({ ...result.params_effective }, { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 });
    assert.equal(result.status, RETOUCH_STATUS.NO_CHANGES, 'không còn tham số nào ⇒ KHÔNG bịa là đã retouch');
    assert.equal(result.output, null);
    assert.ok(
      result.warnings.some((w) => w.includes('BỎ')),
      'phải có cảnh báo nói rõ tham số rác bị bỏ',
    );
  });

  test('Infinity ở giá trị hợp lệ ⇒ rejected, KHÔNG bị kẹp thành ngưỡng', async () => {
    const { params, clamped, rejected } = clampRetouchParams({ brightness: Infinity, contrast: -Infinity });
    assert.deepEqual(rejected, ['brightness', 'contrast']);
    assert.deepEqual(clamped, []);
    assert.deepEqual(params, { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 });
  });

  test('không truyền tham số ⇒ NO_CHANGES + output = null', async () => {
    const provider = purejs();
    for (const params of [undefined, {}, { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 }]) {
      const result = await provider.apply({ image: { buffer: productImage({ box: BOX }), mime: 'image/png' }, params });
      assert.equal(result.status, RETOUCH_STATUS.NO_CHANGES, `params=${JSON.stringify(params)} phải là NO_CHANGES`);
      assert.equal(result.output, null);
      assert.equal(result.error_code, 'NO_CHANGES');
    }
  });
});

describe('MVP-03 retouch — bất biến pixel', () => {
  test('KHÔNG đổi kích thước, KHÔNG dịch pixel (nền đen giữ nguyên, chỉ vật thể đổi)', async () => {
    // Nền ĐEN: mọi phép nhân độ sáng giữ 0 ⇒ pixel nền không đổi. Nếu có phép DỊCH pixel,
    // vùng đen sẽ bị "vẽ" sang giá trị khác ⇒ test bắt được ngay.
    const buffer = productImage({ box: BOX, background: [0, 0, 0, 255], rgba: [200, 30, 40, 255] });
    const result = await purejs().apply({ image: { buffer, mime: 'image/png' }, params: { brightness: 0.25 } });

    assert.equal(result.status, RETOUCH_STATUS.OK);
    assert.deepEqual(sizeOf(result.output.buffer), { width: 64, height: 64, mime: 'image/png' });
    assert.deepEqual([result.output.width, result.output.height], [64, 64]);
    const { inside, outside } = countChangedInsideOutside(buffer, result.output.buffer, BOX);
    assert.equal(outside, 0, 'KHÔNG pixel nào ngoài vật thể được đổi ⇒ không dịch, không vẽ tràn');
    assert.equal(inside, BOX.w * BOX.h, 'toàn bộ vật thể phải đổi màu theo độ sáng');
    assert.deepEqual(pixelAt(result.output.buffer, 0, 0), [0, 0, 0, 255], 'nền đen tuyệt đối giữ nguyên');
  });

  test('alpha vùng nền ĐÃ TÁCH giữ nguyên 0 (không kênh alpha nào bị đổi)', async () => {
    const buffer = transparentImage({ opaqueBox: BOX });
    const before = pixelsOf(buffer);
    const result = await purejs().apply({ image: { buffer, mime: 'image/png' }, params: { brightness: 0.2, saturation: 0.3 } });

    assert.equal(result.status, RETOUCH_STATUS.OK);
    const after = pixelsOf(result.output.buffer);
    assert.deepEqual([after.width, after.height], [before.width, before.height]);
    for (let i = 3; i < before.data.length; i += 4) {
      assert.equal(after.data[i], before.data[i], `alpha pixel ${(i - 3) / 4} KHÔNG được đổi`);
    }
    assert.equal(pixelAt(result.output.buffer, 2, 2)[3], 0, 'nền đã tách vẫn trong suốt');
    assert.deepEqual(
      pixelAt(result.output.buffer, 2, 2).slice(0, 3),
      pixelAt(buffer, 2, 2).slice(0, 3),
      'pixel trong suốt giữ nguyên RGB (không tô màu vào nền)',
    );
    // Vùng đục thì phải THẬT SỰ đổi (không được "retouch giả").
    assert.notDeepEqual(pixelAt(result.output.buffer, 30, 30), pixelAt(buffer, 30, 30));
  });

  test('sha256 + byte ảnh VÀO không đổi sau retouch', async () => {
    const buffer = productImage({ box: BOX });
    const copy = Buffer.from(buffer);
    await purejs().apply({ image: { buffer, mime: 'image/png' }, params: { contrast: 0.15 } });
    assert.equal(sha256(buffer), sha256(copy));
    assert.ok(buffer.equals(copy), 'buffer ảnh vào KHÔNG được sửa tại chỗ');
  });

  test('ảnh không phải PNG ⇒ UNSUPPORTED_IMAGE + output = null', async () => {
    const result = await purejs().apply({ image: { buffer: jpegBytes(), mime: 'image/jpeg' }, params: { brightness: 0.1 } });
    assert.equal(result.status, RETOUCH_STATUS.UNSUPPORTED_IMAGE);
    assert.equal(result.output, null);
  });

  test('kết quả đúng bộ field ĐÓNG BĂNG của RetouchResult', async () => {
    const result = await purejs().apply({ image: { buffer: productImage({ box: BOX }), mime: 'image/png' }, params: { sharpen: 0.3 } });
    assert.deepEqual(Object.keys(result), [...RETOUCH_RESULT_FIELDS]);
    assert.equal(typeof result.elapsed_ms, 'number');
  });
});
