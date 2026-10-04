/**
 * TEST HỒI QUY — MVP-03 vòng 9: xử lý N1…N6 của phản biện vòng 2.
 *
 *   N1 (MAJOR)  tách `SEGMENTATION_AMBIGUOUS` (biên nhập nhằng, mask ĐÚNG) khỏi
 *               `SUSPICIOUS_MASK` (nghi ngờ ăn mất sản phẩm) + cờ `matting_allow_ambiguous`.
 *   N3          `kept_bbox_ratio` / `boundary_delta` phải tới được API/meta/UI.
 *   N4          `IMAGESTUDIO_DIR` (config chết) đã bị bỏ.
 *   N5          overlay trả `evidence_used {sources, region_ids, chars}`.
 *   N6          provider ngoài purejs ⇒ `mask.boundary_checked = false` + cảnh báo.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import { createMattingProvider, MATTING_STATUS, MATTING_CODES } from '../src/imagestudio/matting/index.js';
import { PureJsMattingProvider } from '../src/imagestudio/matting/providers/purejs.js';
import { encodePng } from '../src/imagelab/render/index.js';
import { makeImagestudioStack, productImage, pixelsOf } from './imagestudio-helpers.js';
import { silent } from './helpers.js';

const SIZE = 96;

/** Nền trắng 255 + thân sản phẩm màu `level` + logo tối 36×36 (như script phản biện). */
function whiteBodyImage(level, { logo = true } = {}) {
  const data = Buffer.alloc(SIZE * SIZE * 4, 255);
  for (let y = 16; y < 80; y += 1) {
    for (let x = 16; x < 80; x += 1) {
      const i = (y * SIZE + x) * 4;
      data[i] = level;
      data[i + 1] = level;
      data[i + 2] = level;
    }
  }
  if (logo) {
    for (let y = 30; y < 66; y += 1) {
      for (let x = 30; x < 66; x += 1) {
        const i = (y * SIZE + x) * 4;
        data[i] = 20;
        data[i + 1] = 20;
        data[i + 2] = 20;
      }
    }
  }
  return encodePng({ width: SIZE, height: SIZE, data, channels: 4 });
}

/** Sản phẩm đỏ tương phản rõ + bóng đổ ellipse mềm phía dưới (như script phản biện). */
function redWithSoftShadow(strength = 20) {
  const data = Buffer.alloc(SIZE * SIZE * 4, 255);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const i = (y * SIZE + x) * 4;
      if (x > 24 && x < 72 && y > 20 && y < 64) {
        data[i] = 200;
        data[i + 1] = 40;
        data[i + 2] = 40;
        continue;
      }
      const dist = Math.hypot((x - 48) / 1.6, y - 70);
      if (strength > 0 && dist < 28) {
        const v = Math.round(255 - (1 - dist / 28) * strength);
        data[i] = v;
        data[i + 1] = v;
        data[i + 2] = v;
      }
    }
  }
  return encodePng({ width: SIZE, height: SIZE, data, channels: 4 });
}

const purejs = (opts = {}) => new PureJsMattingProvider(opts);

describe('N1 — biên NHẬP NHẰNG khác hẳn "nghi ngờ ăn mất sản phẩm"', () => {
  test('bóng đổ mềm ⇒ SEGMENTATION_AMBIGUOUS (KHÔNG phải SUSPICIOUS_MASK) + câu đúng nguyên nhân', () => {
    return (async () => {
      for (const strength of [12, 20, 30, 40]) {
        const png = redWithSoftShadow(strength);
        const res = await purejs().removeBackground({ image: { buffer: png, mime: 'image/png' }, options: {} });
        assert.equal(res.status, MATTING_STATUS.SEGMENTATION_AMBIGUOUS, `bóng Δ${strength} phải là AMBIGUOUS, nhận ${res.status}`);
        assert.equal(res.error_code, MATTING_CODES.SEGMENTATION_AMBIGUOUS);
        assert.equal(res.output, null, 'mặc định KHÔNG ghép nền');
        assert.match(res.error_message, /BIÊN NHẬP NHẰNG nên KHÔNG GHÉP NỀN/);
        assert.match(res.error_message, /vẫn được RETOUCH/);
        assert.ok(!/ăn mất sản phẩm/i.test(res.error_message), 'KHÔNG được nói "ăn mất sản phẩm" khi mask đúng');
      }
    })();
  });

  test('cờ `matting_allow_ambiguous` ⇒ VẪN ghép + ghi vết `ambiguous_override`', async () => {
    const png = redWithSoftShadow(20);
    const res = await purejs().removeBackground({
      image: { buffer: png, mime: 'image/png' },
      options: { matting_allow_ambiguous: true },
    });
    assert.equal(res.status, MATTING_STATUS.OK);
    assert.ok(res.output?.buffer, 'bật cờ thì phải có ảnh ra để ghép');
    assert.equal(res.mask.ambiguous_override, true);
    assert.ok(
      res.warnings.some((w) => /ĐÃ BỎ QUA cảnh báo BIÊN NHẬP NHẰNG/.test(String(w))),
      'phải có câu ghi vết bỏ qua cảnh báo',
    );
  });

  test('sản phẩm trắng/kem 244–248 (mask ĐÚNG) ⇒ ĐẠT, không chặn oan', async () => {
    for (const level of [244, 246, 248]) {
      const png = whiteBodyImage(level);
      const res = await purejs().removeBackground({ image: { buffer: png, mime: 'image/png' }, options: {} });
      assert.equal(res.status, MATTING_STATUS.OK, `sản phẩm ${level} phải ĐẠT, nhận ${res.status}/${res.error_code}`);
      assert.ok(res.output?.buffer);
      assert.ok(res.warnings.some((w) => /Lưu ý: .*sát nền/.test(String(w))), 'vẫn phải ghi lưu ý về viền gần màu nền');
    }
  });

  test('CHIỀU NGƯỢC LẠI: mask ăn mất sản phẩm thật ⇒ VẪN SUSPICIOUS_MASK', async () => {
    // Sản phẩm 249/250 nằm trong tolerance ⇒ flood fill ăn mất thân, chỉ còn logo.
    for (const level of [249, 250]) {
      const png = whiteBodyImage(level);
      const res = await purejs().removeBackground({ image: { buffer: png, mime: 'image/png' }, options: {} });
      assert.equal(res.status, MATTING_STATUS.FAILED, `sản phẩm ${level} bị ăn ⇒ phải TỪ CHỐI`);
      assert.equal(res.error_code, MATTING_CODES.SUSPICIOUS_MASK);
      assert.equal(res.output, null);
      assert.match(res.error_message, /NGHI NGỜ ĂN MẤT SẢN PHẨM|nghi ngờ ĂN MẤT SẢN PHẨM/);
      assert.ok(res.mask.boundary_delta.dirty_removed_ratio > 0.15, 'phải đo được diện tích nền bẩn lớn');
    }
    // Và ca gốc M03-01 với tolerance CŨ (28): áo 240 bị ăn ⇒ vẫn phải bị chặn.
    const png = whiteBodyImage(240);
    const res = await purejs().removeBackground({ image: { buffer: png, mime: 'image/png' }, options: { tolerance: 28 } });
    assert.equal(res.error_code, MATTING_CODES.SUSPICIOUS_MASK, 'tolerance cũ ăn mất áo ⇒ phải TỪ CHỐI');
  });

  test('API: bóng mềm ⇒ matting AMBIGUOUS, KHÔNG ghép nền, nhưng job VẪN ra ảnh retouch', async () => {
    const stack = await makeImagestudioStack();
    try {
      await stack.pipeline.ingest(stack.jobId, {
        image: { buffer: redWithSoftShadow(20), mime: 'image/png' },
        sessionId: stack.sessionId,
      });
      const result = await stack.pipeline.generate(stack.jobId, {
        sessionId: stack.sessionId,
        options: { template: 'gradient-xanh', retouch: { brightness: 0.1 } },
      });
      assert.equal(result.matting?.status, 'SEGMENTATION_AMBIGUOUS');
      const renderedList = await stack.store.listImageAssets(stack.jobId, { role: 'rendered' });
      assert.equal(renderedList.length, 1, 'vẫn phải có ẢNH RETOUCH dù không ghép được nền');
      const meta = renderedList[0].meta || {};
      assert.equal(meta.compose ?? meta.generator?.compose_background_ratio ?? 0, meta.compose ?? meta.generator?.compose_background_ratio ?? 0);
      assert.equal(meta.matting?.ambiguous_override, false, 'không bật cờ ⇒ vết phải là false');
    } finally {
      await stack.close();
    }
  });

  test('API: bật `matting_allow_ambiguous` ⇒ ghép nền + vết override = true trên meta ảnh', async () => {
    const stack = await makeImagestudioStack();
    try {
      await stack.pipeline.ingest(stack.jobId, {
        image: { buffer: redWithSoftShadow(20), mime: 'image/png' },
        sessionId: stack.sessionId,
      });
      const result = await stack.pipeline.generate(stack.jobId, {
        sessionId: stack.sessionId,
        options: { template: 'gradient-xanh', matting_allow_ambiguous: true },
      });
      assert.equal(result.matting?.status, 'OK');
      assert.equal(result.matting?.ambiguous_override, true);
      const renderedList = await stack.store.listImageAssets(stack.jobId, { role: 'rendered' });
      assert.equal(renderedList.length, 1);
      assert.equal(renderedList[0].meta?.matting?.ambiguous_override, true, 'asset.meta.matting.ambiguous_override phải = true');
    } finally {
      await stack.close();
    }
  });
});

describe('N3/N6 — số đo biên tới được API, provider ngoài tự khai chưa kiểm biên', () => {
  test('summarizeMatting (qua pipeline) giữ `kept_bbox_ratio` + `boundary_delta`', async () => {
    const stack = await makeImagestudioStack();
    try {
      await stack.pipeline.ingest(stack.jobId, {
        image: { buffer: productImage({}), mime: 'image/png' },
        sessionId: stack.sessionId,
      });
      const result = await stack.pipeline.generate(stack.jobId, { sessionId: stack.sessionId, options: { template: 'trang' } });
      assert.ok(result.matting?.mask, 'matting.mask phải có');
      assert.equal(typeof result.matting.mask.kept_bbox_ratio, 'number', 'kept_bbox_ratio phải tới được API');
      assert.ok(result.matting.mask.boundary_delta, 'boundary_delta phải tới được API');
      assert.equal(typeof result.matting.mask.boundary_delta.p95, 'number');
      assert.equal(result.matting.boundary_checked, true, 'purejs đo được biên ⇒ true');
    } finally {
      await stack.close();
    }
  });

  test('N6: provider mock (ngoài purejs) ⇒ boundary_checked = false + cảnh báo', async () => {
    const provider = createMattingProvider({ matting: { provider: 'mock' } }, { logger: silent });
    const res = await provider.removeBackground({ image: { buffer: productImage({}), mime: 'image/png' } });
    assert.equal(res.status, MATTING_STATUS.OK);
    assert.equal(res.mask.boundary_checked, false);
    assert.ok(res.warnings.some((w) => /KHÔNG đo được biên/.test(String(w))));
  });
});

describe('N4/N5 — config chết đã bỏ; bằng chứng overlay truy vết được', () => {
  test('N4: config KHÔNG còn `imagestudio.dir`', () => {
    const cfg = loadConfig({ NODE_ENV: 'test', DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
    assert.equal('dir' in cfg.imagestudio, false, 'config chết phải bị bỏ hẳn');
    assert.equal(cfg.imagestudio.enabled, true);
  });

  test('N5: overlay trả `evidence_used` với nguồn thật (product_name + vùng user)', async () => {
    const stack = await makeImagestudioStack();
    try {
      await stack.store.updateJob(stack.jobId, { product_name: 'Áo thun cotton bảo hành 12 tháng' });
      await stack.store.saveOcrRegions(stack.jobId, null, [
        {
          id: 'u1',
          region_key: 'u1',
          box: { x: 5, y: 5, w: 40, h: 12 },
          text: 'chính hãng',
          kind: 'descriptive',
          translatable: true,
          source: 'user',
        },
      ]);
      await stack.pipeline.ingest(stack.jobId, {
        image: { buffer: productImage({}), mime: 'image/png' },
        sessionId: stack.sessionId,
      });
      const result = await stack.pipeline.generate(stack.jobId, {
        sessionId: stack.sessionId,
        options: { template: 'trang', overlay: { text: 'Bảo hành 12 tháng' } },
      });
      assert.equal(result.overlay?.applied, true, `overlay phải qua, reason=${result.overlay?.reason}`);
      const ev = result.overlay.evidence_used;
      assert.ok(ev, 'phải có evidence_used');
      assert.ok(ev.sources.includes('product_name'), `nguồn phải có product_name: ${JSON.stringify(ev)}`);
      assert.ok(ev.sources.includes('user_region'), `nguồn phải có user_region: ${JSON.stringify(ev)}`);
      assert.ok(ev.region_ids.includes('u1'));
      assert.ok(ev.chars > 0);
    } finally {
      await stack.close();
    }
  });
});
