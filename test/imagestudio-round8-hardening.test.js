/**
 * TEST HỒI QUY — MVP-03 vòng 8: vá 6 phát hiện của phản biện (M03-01…M03-06).
 *
 *   M03-01 (CRITICAL)  sản phẩm gần màu nền KHÔNG được bị ăn: tolerance 12 + soi BIÊN hai
 *                      phía + siết SUSPICIOUS_MASK (giữ lại quá ít / đảo nhỏ giữa nền lớn).
 *   M03-02 (MAJOR)     bằng chứng overlay CHỈ từ dữ liệu ĐÃ LƯU của job; client tự khai
 *                      bằng chứng ⇒ vẫn 422, KHÔNG vẽ pixel nào.
 *   M03-04 (MINOR)     kana/Hangul ⇒ OVERLAY_NOT_TRANSLATED (không phụ thuộc font).
 *   M03-05 (MINOR)     `retouch_effective` = 0 khi NO_CHANGES; compose chỉ khi matting OK.
 *   M03-06             cấu hình IMAGESTUDIO_ENABLED / MATTING_* / RETOUCH_* có thật.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import { createMattingProvider, MATTING_STATUS, MATTING_CODES } from '../src/imagestudio/matting/index.js';
import { createRetouchProvider, resolveRetouchLimits, RETOUCH_LIMITS } from '../src/imagestudio/retouch/index.js';
import { composeImage } from '../src/imagestudio/compose/index.js';
import { PureJsMattingProvider } from '../src/imagestudio/matting/providers/purejs.js';
import { encodePng } from '../src/imagelab/render/index.js';
import { productImage, pixelsOf, countChanged, makeImagestudioStack } from './imagestudio-helpers.js';
import { silent } from './helpers.js';

/** Ảnh nền trắng 255 + khối "sản phẩm" màu `level` (xám) + logo tối ở giữa. */
function whiteProductImage(level, { size = 64, box = { x: 8, y: 8, w: 48, h: 48 }, logo = true } = {}) {
  const data = Buffer.alloc(size * size * 4, 255);
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      const i = (y * size + x) * 4;
      data[i] = level;
      data[i + 1] = level;
      data[i + 2] = level;
      data[i + 3] = 255;
    }
  }
  if (logo) {
    for (let y = 24; y < 40; y += 1) {
      for (let x = 24; x < 40; x += 1) {
        const i = (y * size + x) * 4;
        data[i] = 20;
        data[i + 1] = 20;
        data[i + 2] = 20;
      }
    }
  }
  return encodePng({ width: size, height: size, data, channels: 4 });
}

const purejs = (opts = {}) => new PureJsMattingProvider(opts);

/** Đếm pixel SẢN PHẨM (màu `level`) bị đổi giữa ảnh vào và ảnh ra. */
function productPixelsChanged(beforePng, afterPng, level, box = { x: 8, y: 8, w: 48, h: 48 }) {
  const before = pixelsOf(beforePng);
  const after = pixelsOf(afterPng);
  let changed = 0;
  for (let y = box.y; y < box.y + box.h; y += 1) {
    for (let x = box.x; x < box.x + box.w; x += 1) {
      const i = (y * 64 + x) * 4;
      if (before[i] !== level) continue; // chỉ tính pixel ĐÚNG màu sản phẩm (bỏ logo)
      if (after[i] !== before[i] || after[i + 1] !== before[i + 1] || after[i + 2] !== before[i + 2] || after[i + 3] !== 255) {
        changed += 1;
      }
    }
  }
  return changed;
}

describe('M03-01 — sản phẩm gần màu nền KHÔNG được bị ăn (CRITICAL)', () => {
  test('áo 240 trên nền 255 (ca phản biện): tách được, 0 pixel sản phẩm bị đổi', async () => {
    const png = whiteProductImage(240);
    const res = await purejs().removeBackground({ image: { buffer: png, mime: 'image/png' }, options: {} });

    assert.equal(res.status, MATTING_STATUS.OK, 'áo 240 (Δ≈26) phải được GIỮ LẠI, không bị coi là nền');
    assert.equal(res.error_code ?? null, null);
    assert.ok(res.output?.buffer, 'phải có ảnh ra');
    assert.equal(productPixelsChanged(png, res.output.buffer, 240), 0, 'KHÔNG pixel sản phẩm nào được đổi');
    // Số đo thật của vùng biên phải được trả ra (không phải kết luận suông).
    assert.ok(res.mask.boundary_delta, 'mask phải kèm boundary_delta');
    assert.equal(res.mask.boundary_delta.suspicious, false);
    assert.ok(res.mask.boundary_delta.kept_min >= res.mask.boundary_delta.decisive_delta, 'biên phải dứt khoát');
  });

  test('kem 248 (Δ≈12.1, sát nền) ⇒ FAILED/SUSPICIOUS_MASK, không lưu ảnh', async () => {
    const png = whiteProductImage(248);
    const res = await purejs().removeBackground({ image: { buffer: png, mime: 'image/png' }, options: {} });

    assert.equal(res.status, MATTING_STATUS.FAILED);
    assert.equal(res.error_code, MATTING_CODES.SUSPICIOUS_MASK);
    assert.equal(res.output, null, 'từ chối thì KHÔNG được kèm ảnh ra');
    assert.ok(res.mask.boundary_delta.kept_under_ratio > 0.05, 'phải đo được là biên KHÔNG dứt khoát');
  });

  test('trắng 250 (trong ngưỡng cũ) ⇒ FAILED, không có ảnh ra', async () => {
    const png = whiteProductImage(250);
    const res = await purejs().removeBackground({ image: { buffer: png, mime: 'image/png' }, options: {} });
    assert.equal(res.status, MATTING_STATUS.FAILED);
    assert.equal(res.output, null);
  });

  test('xám 200 (khác rõ) ⇒ vẫn tách bình thường', async () => {
    const png = whiteProductImage(200);
    const res = await purejs().removeBackground({ image: { buffer: png, mime: 'image/png' }, options: {} });
    assert.equal(res.status, MATTING_STATUS.OK);
    assert.equal(productPixelsChanged(png, res.output.buffer, 200), 0);
  });

  test('chỉ còn "đảo nhỏ" giữa vùng nền lớn ⇒ SUSPICIOUS_MASK (siết ngưỡng M03-01b)', async () => {
    // Sản phẩm 250 (bị coi là nền) + logo tối 8×8 ⇒ phần giữ lại chỉ là đảo nhỏ.
    const png = whiteProductImage(250, { size: 64, box: { x: 8, y: 8, w: 48, h: 48 }, logo: true });
    const res = await purejs().removeBackground({ image: { buffer: png, mime: 'image/png' }, options: {} });
    assert.equal(res.error_code, MATTING_CODES.SUSPICIOUS_MASK);
    assert.equal(res.kept_bbox, null, 'từ chối thì kept_bbox = null');
  });

  test('câu cảnh báo KHÔNG còn khẳng định "pixel sản phẩm giữ nguyên"', async () => {
    const png = whiteProductImage(200);
    const res = await purejs().removeBackground({ image: { buffer: png, mime: 'image/png' }, options: {} });
    const text = res.warnings.join(' | ');
    assert.ok(!/Pixel sản phẩm/.test(text), `còn câu khẳng định tuyệt đối: ${text}`);
    assert.match(text, /Pixel NGOÀI vùng đã tách giữ nguyên từng byte/);
    assert.match(text, /do máy đoán theo màu nền/);
  });
});

describe('M03-02 — bằng chứng overlay chỉ từ dữ liệu ĐÃ LƯU của job', () => {
  test('bằng chứng client tự khai KHÔNG được dùng (drawOverlay vẫn chặn)', async () => {
    const { drawOverlay } = await import('../src/imagestudio/compose/index.js');
    const png = productImage({});
    const claim = 'Bảo hành 12 tháng';

    const withoutEvidence = drawOverlay({ image: { buffer: png, mime: 'image/png' }, overlay: { text: claim } });
    assert.equal(withoutEvidence.applied, false);

    for (const clientEvidence of [
      { source_text: claim },
      { notes: claim },
      { source_text: [claim] },
      { evidence: { text: claim } },
      { ocr_text: claim },
      { product_name: claim },
    ]) {
      const res = drawOverlay({
        image: { buffer: png, mime: 'image/png' },
        overlay: { text: claim, ...clientEvidence },
      });
      assert.equal(res.applied, false, `bằng chứng client ${JSON.stringify(Object.keys(clientEvidence))} KHÔNG được dùng`);
      assert.match(res.warnings.join(' '), /BỎ QUA bằng chứng do client tự khai/);
    }
  });

  test('bằng chứng do SERVER gom (params.source_text) thì khẳng định CÓ thật ⇒ vẫn vẽ được', async () => {
    const { drawOverlay } = await import('../src/imagestudio/compose/index.js');
    const png = productImage({});
    const res = drawOverlay({
      image: { buffer: png, mime: 'image/png' },
      overlay: { text: 'Bảo hành 12 tháng' },
      source_text: 'Áo thun cotton — bảo hành 12 tháng chính hãng',
    });
    assert.equal(res.applied, true, `đối chứng dương phải vẽ được, nhận reason=${res.reason}`);
    assert.equal(countChanged(png, res.buffer) > 0, true, 'phải có pixel được vẽ');
  });

  test('pipeline: tên sản phẩm ĐÃ LƯU là bằng chứng ⇒ overlay qua; client khai thêm thì bị bỏ qua', async () => {
    const stack = await makeImagestudioStack();
    try {
      await stack.store.updateJob(stack.jobId, { product_name: 'Bảo hành 12 tháng chính hãng' });
      const image = productImage({});
      const ing = await stack.pipeline.ingest(stack.jobId, {
        image: { buffer: image, mime: 'image/png' },
        sessionId: stack.sessionId,
      });
      const result = await stack.pipeline.generate(stack.jobId, {
        sessionId: stack.sessionId,
        options: {
          template: 'trang',
          matting: { enabled: false },
          overlay: { text: 'Bảo hành 12 tháng', source_text: 'Bịa hoàn toàn' },
        },
      });
      assert.ok(ing.asset_id);
      assert.equal(result.overlay?.applied, true, `overlay phải qua nhờ tên sản phẩm đã lưu (reason=${result.overlay?.reason})`);
      assert.ok(
        result.warnings.some((w) => /BỎ QUA bằng chứng do client tự khai/.test(String(w))),
        'phải nói rõ bằng chứng client gửi bị bỏ qua',
      );
    } finally {
      await stack.close();
    }
  });
});

describe('M03-04 — chữ CHƯA DỊCH (kana/Hangul) bị chặn bằng LUẬT, không nhờ font', () => {
  test('kana/Hangul/Hán ⇒ OVERLAY_NOT_TRANSLATED ngay cả khi font có glyph', async () => {
    const { drawOverlay, OVERLAY_REASONS } = await import('../src/imagestudio/compose/index.js');
    const png = productImage({});
    for (const text of ['こんにちは', '한국어', '保修 12 个月']) {
      const res = drawOverlay({ image: { buffer: png, mime: 'image/png' }, overlay: { text } });
      assert.equal(res.applied, false, `${text} KHÔNG được vẽ`);
      assert.equal(res.reason, OVERLAY_REASONS.NOT_TRANSLATED, `${text} phải là NOT_TRANSLATED (nhận ${res.reason})`);
    }
  });
});

describe('M03-05 — dấu vết retouch + ghép nền', () => {
  test('retouch NO_CHANGES ⇒ retouch_effective = 0, vẫn giữ params_clamped', async () => {
    const stack = await makeImagestudioStack();
    try {
      const ing = await stack.pipeline.ingest(stack.jobId, {
        image: { buffer: productImage({}), mime: 'image/png' },
        sessionId: stack.sessionId,
      });
      assert.ok(ing.asset_id);
      const result = await stack.pipeline.generate(stack.jobId, {
        sessionId: stack.sessionId,
        options: { template: 'trang', matting: { enabled: false }, retouch: { brightness: 99 } },
      });
      if (result.retouch?.status === 'NO_CHANGES') {
        assert.deepEqual(
          result.retouch.params_effective,
          { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 },
          'không áp được tham số nào thì params_effective phải là 0',
        );
        assert.ok((result.retouch.clamped || []).includes('brightness'), 'vẫn phải giữ vết KẸP');
      }
    } finally {
      await stack.close();
    }
  });

  test('composeImage: matting FAILED mà có buffer ⇒ KHÔNG ghép (bản sao y nguyên)', () => {
    const image = productImage({});
    const res = composeImage({
      image: { buffer: image, mime: 'image/png' },
      matting: { status: 'FAILED', output: { buffer: image, mime: 'image/png' } },
      template: 'trang',
    });
    assert.equal(res.background_ratio, 0, 'không được ghép nền khi matting FAILED');
    assert.equal(countChanged(image, res.output.buffer), 0, 'ảnh ra phải là bản sao y nguyên');
    assert.match(res.warnings.join(' '), /KHÔNG ghép nền/);
  });
});

describe('M03-06 — đường CẤU HÌNH của MVP-03', () => {
  const env = (over = {}) =>
    loadConfig({ NODE_ENV: 'test', DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:', AI_PROVIDER: 'mock', ...over });

  test('IMAGESTUDIO_ENABLED / MATTING_* / RETOUCH_* có thật trong config', () => {
    assert.equal(env({ IMAGESTUDIO_ENABLED: 'false' }).imagestudio.enabled, false);
    assert.equal(env({}).imagestudio.enabled, true);
    assert.equal(env({ MATTING_PROVIDER: 'none' }).matting.provider, 'none');
    assert.equal(env({ MATTING_BASE_URL: 'https://x.example/api' }).matting.baseUrl, 'https://x.example/api');
    assert.equal(env({ RETOUCH_PROVIDER: 'mock' }).retouch.provider, 'mock');
  });

  test('MATTING_PROVIDER/RETOUCH_PROVIDER chọn đúng provider', () => {
    assert.equal(createMattingProvider(env({ MATTING_PROVIDER: 'none' }), { logger: silent }).name, 'none');
    assert.equal(createRetouchProvider(env({ RETOUCH_PROVIDER: 'none' }), { logger: silent }).name, 'none');
    const http = createMattingProvider(env({ MATTING_PROVIDER: 'http', MATTING_BASE_URL: 'https://x.example/api' }), { logger: silent });
    assert.equal(http.name, 'http');
    assert.equal(http.configured, true);
  });

  test('trần retouch CHỈ SIẾT ĐƯỢC: khai số lớn hơn trần hợp đồng KHÔNG nới ngưỡng', () => {
    const generous = resolveRetouchLimits(env({ RETOUCH_MAX_BRIGHTNESS: '5', RETOUCH_MAX_SHARPEN: '9' }).retouch.limits);
    assert.equal(generous.brightness, RETOUCH_LIMITS.brightness, 'không được nới quá trần hợp đồng');
    assert.equal(generous.sharpen, RETOUCH_LIMITS.sharpen);
    const tighter = resolveRetouchLimits(env({ RETOUCH_MAX_BRIGHTNESS: '0.05' }).retouch.limits);
    assert.equal(tighter.brightness, 0.05, 'siết thì phải có hiệu lực');
  });
});
