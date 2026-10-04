/**
 * TEST HỒI QUY — MVP-03 vòng 10: xử lý N7/N8/N9 của phản biện vòng 3.
 *
 *   N7 (MAJOR)  mẫu số của phép đo "nền bẩn" phải là VÙNG GIỮ LẠI (không phải khung ảnh) +
 *               tín hiệu "cắt sâu vào giữa hộp bao sản phẩm" ⇒ SUSPICIOUS_MASK (không phải
 *               nhập nhằng); câu chữ chỉ được nói điều ĐO ĐƯỢC; cờ không mở đường cho ca nguy hiểm.
 *   N8          không làm tròn mất tín hiệu (phân loại trên SỐ NGUYÊN pixel bẩn).
 *   N9          số đo mask phải tới được `GET`, `asset.meta` và UI THẬT (không chỉ trong bộ nhớ).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMattingProvider, MATTING_STATUS, MATTING_CODES } from '../src/imagestudio/matting/index.js';
import { PureJsMattingProvider } from '../src/imagestudio/matting/providers/purejs.js';
import { encodePng } from '../src/imagelab/render/index.js';
import { makeImagestudioStack } from './imagestudio-helpers.js';
import { makeIsState, loadIsUi, isConfigBlock } from './imagestudio-ui-helpers.js';
import { cookie, j, makeTestImage, postJson, startImagelabApp, waitJob } from './imagelab-helpers.js';

const purejs = () => new PureJsMattingProvider({});

/** Ảnh nền trắng có bảng màu do `paint(x,y)` quyết định. */
function png(W, H, paint) {
  const data = Buffer.alloc(W * H * 4, 255);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const px = paint(x, y);
      if (!px) continue;
      const i = (y * W + x) * 4;
      data[i] = px[0];
      data[i + 1] = px[1];
      data[i + 2] = px[2];
      if (px[3] !== undefined) data[i + 3] = px[3];
    }
  }
  return encodePng({ width: W, height: H, data, channels: 4 });
}

/** Ca N7 của phản biện: khung 300×300, 2 nẹp tối (giữ lại) + thân sáng ở giữa (bị ăn). */
const n7Frame = (level, size = 110) =>
  png(300, 300, (x, y) => {
    if (y >= 40 && y < 44 && x >= 20 && x < 280) return [20, 20, 20];
    if (y >= 256 && y < 260 && x >= 20 && x < 280) return [20, 20, 20];
    const x0 = Math.round((300 - size) / 2);
    const y0 = Math.round((300 - size) / 2);
    if (x >= x0 && x < x0 + size && y >= y0 && y < y0 + size) return [level, level, level];
    return null;
  });

/** Sản phẩm đỏ tương phản rõ + bóng đổ ellipse mềm dưới chân (ca "ảnh bình thường"). */
const softShadow = (strength = 20, size = 96) =>
  png(size, size, (x, y) => {
    if (x > 24 && x < 72 && y > 20 && y < 64) return [200, 40, 40];
    const dist = Math.hypot((x - 48) / 1.6, y - 70);
    if (strength > 0 && dist < 28) {
      const v = Math.round(255 - (1 - dist / 28) * strength);
      return [v, v, v];
    }
    return null;
  });

/** Sản phẩm trắng/kem + logo tối 36×36 (mask ĐÚNG — ca 244–248). */
const brightProduct = (level, size = 96) =>
  png(size, size, (x, y) => {
    if (x > 30 && x < 66 && y > 30 && y < 66) return [20, 20, 20];
    if (x > 16 && x < 80 && y > 16 && y < 80) return [level, level, level];
    return null;
  });

describe('N7 — ĂN SẢN PHẨM (kể cả khung lớn) phải là NGUY HIỂM, không phải "nhập nhằng"', () => {
  test('khung 300×300 + thân 249 (13.4% khung) ⇒ SUSPICIOUS_MASK + số đo theo VÙNG GIỮ LẠI', async () => {
    const image = n7Frame(249);
    const res = await purejs().removeBackground({ image: { buffer: image, mime: 'image/png' }, options: {} });

    assert.equal(res.status, MATTING_STATUS.FAILED, `phải TỪ CHỐI, nhận ${res.status}/${res.error_code}`);
    assert.equal(res.error_code, MATTING_CODES.SUSPICIOUS_MASK);
    assert.equal(res.output, null);
    assert.match(res.error_message, /ĂN MẤT SẢN PHẨM/);
    assert.match(res.error_message, /DIỆN TÍCH VÙNG GIỮ LẠI/);
    assert.ok(res.mask.boundary_delta.dirty_ratio_kept > 1, 'tỉ lệ theo vùng giữ phải ≫ 1');
    assert.ok(res.mask.boundary_delta.dirty_inside_bbox > 0, 'phải đo được pixel bẩn nằm sâu trong hộp bao');
    assert.ok(!/sản phẩm vẫn được giữ nguyên/.test(res.error_message), 'KHÔNG được khẳng định sản phẩm còn nguyên');
  });

  test('CỜ `matting_allow_ambiguous` KHÔNG mở đường cho ca nguy hiểm', async () => {
    const image = n7Frame(249);
    const res = await purejs().removeBackground({
      image: { buffer: image, mime: 'image/png' },
      options: { matting_allow_ambiguous: true },
    });
    assert.equal(res.status, MATTING_STATUS.FAILED);
    assert.equal(res.error_code, MATTING_CODES.SUSPICIOUS_MASK);
    assert.equal(res.output, null, 'bật cờ vẫn KHÔNG được ghép nền ăn sản phẩm');
    assert.equal(res.mask.ambiguous_override, undefined);
  });

  test('CHIỀU NGƯỢC: bóng đổ mềm ⇒ SEGMENTATION_AMBIGUOUS + câu chỉ nói điều ĐO ĐƯỢC', async () => {
    for (const strength of [12, 20, 40]) {
      const res = await purejs().removeBackground({ image: { buffer: softShadow(strength), mime: 'image/png' }, options: {} });
      assert.equal(res.status, MATTING_STATUS.SEGMENTATION_AMBIGUOUS, `bóng Δ${strength}: nhận ${res.status}`);
      assert.match(res.error_message, /CHƯA ĐỦ CHẮC/);
      assert.match(res.error_message, /dirty_removed/);
      assert.match(res.error_message, /TRƯỚC\|SAU/);
      assert.ok(
        !/sản phẩm vẫn được giữ nguyên/.test(res.error_message),
        'N7b: không được khẳng định "sản phẩm vẫn được giữ nguyên"',
      );
    }
  });

  test('CHIỀU THỨ BA: sản phẩm sáng 244–248 (mask ĐÚNG) ⇒ ĐẠT', async () => {
    for (const level of [244, 246, 248]) {
      const res = await purejs().removeBackground({ image: { buffer: brightProduct(level), mime: 'image/png' }, options: {} });
      assert.equal(res.status, MATTING_STATUS.OK, `sản phẩm ${level}: nhận ${res.status}/${res.error_code}`);
      assert.equal(res.mask.boundary_delta.dirty_removed, 0, 'không có pixel nền bẩn nào ⇒ mới được ĐẠT');
    }
  });
});

describe('N8 — không làm tròn mất tín hiệu', () => {
  test('khung 1000×1000 với 42 px bẩn (0.000042 khung) ⇒ KHÔNG được OK', async () => {
    // Bẫy cũ: `toFixed(4)` biến 0.000042 thành 0 ⇒ không nhánh nào kích hoạt ⇒ OK + ảnh ra.
    const image = png(1000, 1000, (x, y) => {
      if (y >= 100 && y < 120) return [20, 20, 20]; // nẹp giữ lại
      if (y >= 500 && y < 506 && x >= 500 && x < 507) return [249, 249, 249]; // 42 px "sản phẩm" bị ăn
      return null;
    });
    const res = await purejs().removeBackground({ image: { buffer: image, mime: 'image/png' }, options: {} });

    assert.notEqual(res.status, MATTING_STATUS.OK, `42 px bẩn KHÔNG được coi là ĐẠT (nhận ${res.status})`);
    assert.equal(res.output, null);
    assert.equal(res.mask.boundary_delta.dirty_removed > 0, true, 'phải giữ SỐ NGUYÊN pixel bẩn');
    assert.ok(res.mask.boundary_delta.dirty_removed_ratio > 0, 'tỉ lệ phải giữ đủ chữ số (không làm tròn về 0)');
  });
});

describe('N9 — số đo mask tới được GET / asset.meta / UI THẬT', () => {
  test('GET job: `matting.mask` có đủ số đo; `asset.meta.matting.mask` cũng vậy', async () => {
    const ctx = await startImagelabApp();
    try {
      const created = await j(await postJson(ctx.base, '/api/imagestudio/jobs', {
        image: { base64: makeTestImage({ width: 96, height: 96, fills: [{ box: { x: 24, y: 20, w: 48, h: 44 }, rgba: [200, 40, 40, 255] }] }).toString('base64') },
        options: { template: 'trang' },
      }, 'sessN9AAAAAAAAAAAAAA'));
      await waitJob(ctx.base, created.job_id, 'sessN9AAAAAAAAAAAAAA');
      const data = await j(await fetch(`${ctx.base}/api/imagestudio/jobs/${created.job_id}`, {
        headers: cookie('sessN9AAAAAAAAAAAAAA'),
      }));

      assert.ok(data.matting, 'GET phải có khối matting');
      assert.ok(data.matting.mask, 'N9: GET matting.mask KHÔNG được undefined');
      assert.equal(typeof data.matting.mask.kept_bbox_ratio, 'number');
      assert.ok(data.matting.mask.boundary_delta, 'GET phải có boundary_delta');
      assert.equal(typeof data.matting.mask.boundary_delta.dirty_removed, 'number');
      assert.equal(data.matting.boundary_checked, true);

      const renderedList = Array.isArray(data.rendered) ? data.rendered : [];
      const last = renderedList[renderedList.length - 1] || null;
      if (last) {
        assert.ok(last.meta?.matting?.mask, 'asset.meta.matting.mask phải có số đo (không chỉ 3 field)');
        assert.equal(typeof last.meta.matting.mask.boundary_delta.p95, 'number');
      }
    } finally {
      await ctx.close();
    }
  });

  test('UI THẬT (renderIsWarnings): khối "Số đo vùng tách nền" phải HIỆN khi có mask', async () => {
    const state = makeIsState({ config: isConfigBlock() });
    const ui = loadIsUi(state);
    const mask = {
      coverage: 0.24,
      background_ratio: 0.76,
      uniformity: 1,
      seed_colors: 1,
      kept_bbox_ratio: 0.2397,
      boundary_delta: {
        count: 188,
        max: 0,
        p95: 10.39,
        over_ratio: 0.4,
        kept_under_ratio: 0.1,
        kept_min: 12.2,
        dirty_removed: 42,
        dirty_removed_ratio: 0.000042,
        dirty_ratio_kept: 0.02,
        dirty_inside_bbox: 0,
      },
      boundary_checked: true,
    };
    // (a) số đo tới từ GET data.matting (ảnh đã tạo)
    const fromGet = ui.renderIsWarnings({ job: {}, matting: { status: 'OK', mask, boundary_checked: true }, rendered: [] });
    assert.match(fromGet, /Số đo vùng tách nền/, 'khối số đo phải hiện khi GET trả mask');
    assert.match(fromGet, /Δp95/);
    assert.match(fromGet, /dirty_removed|KHÔNG sạch màu nền/);
    // (b) số đo chỉ có trong meta ảnh đã lưu
    const fromMeta = ui.renderIsWarnings({ job: {}, rendered: [{ meta: { matting: { status: 'OK', mask } } }] });
    assert.match(fromMeta, /Số đo vùng tách nền/, 'khối số đo phải hiện khi chỉ có meta ảnh');
    // (c) số đo của LƯỢT CHẠY gần nhất (lượt không tạo ảnh mới — ca NHẬP NHẰNG)
    const fromLastRun = ui.renderIsWarnings({ job: {}, matting: null, rendered: [], last_run: { matting: { status: 'SEGMENTATION_AMBIGUOUS', mask } } });
    assert.match(fromLastRun, /Số đo vùng tách nền/, 'khối số đo phải hiện cả khi lượt chạy không tạo ảnh');
  });

  test('UI THẬT: mã SEGMENTATION_AMBIGUOUS có câu giải thích riêng (không nói "ăn mất sản phẩm")', () => {
    const state = makeIsState({ config: isConfigBlock() });
    const ui = loadIsUi(state);
    const html = ui.renderIsWarnings({
      job: {},
      matting: { status: 'SEGMENTATION_AMBIGUOUS', error_code: 'SEGMENTATION_AMBIGUOUS', mask: null },
      rendered: [],
    });
    assert.match(html, /KHÔNG GHÉP NỀN vì biên nhập nhằng/);
    assert.ok(!/ăn mất sản phẩm/i.test(html), 'nhánh nhập nhằng KHÔNG được doạ "ăn mất sản phẩm"');
  });
});

describe('N9 — pipeline: bản tóm tắt matting trong meta/last_run là bản ĐẦY ĐỦ', () => {
  test('content_meta + meta ảnh đều mang mask có số đo', async () => {
    const stack = await makeImagestudioStack();
    try {
      await stack.pipeline.ingest(stack.jobId, {
        image: { buffer: brightProduct(200), mime: 'image/png' },
        sessionId: stack.sessionId,
      });
      await stack.pipeline.generate(stack.jobId, { sessionId: stack.sessionId, options: { template: 'trang' } });

      const job = await stack.store.getJob(stack.jobId);
      const is = job.content_meta?.imagestudio || {};
      assert.ok(is.matting?.mask?.boundary_delta, 'content_meta.imagestudio.matting phải có mask + boundary_delta');

      const renderedList = await stack.store.listImageAssets(stack.jobId, { role: 'rendered' });
      assert.ok(renderedList.length >= 1);
      const meta = renderedList[renderedList.length - 1].meta || {};
      assert.ok(meta.matting?.mask, 'asset.meta.matting phải có mask');
      assert.equal(typeof meta.matting.mask.boundary_delta.dirty_ratio_kept, 'number', 'phải có số đo N7');
    } finally {
      await stack.close();
    }
  });
});
