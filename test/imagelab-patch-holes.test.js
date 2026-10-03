/**
 * TEST SĂN LỖ HỔNG MỚI sau bản vá F-01…F-08 (`b35725d`).
 *
 * Phần XANH: những chỗ bản vá được cho là dễ "chặn oan" / tính sai hộp — kiểm để
 * chứng minh nó KHÔNG sai.
 *
 * Phần ĐỎ (đang `skip`): lỗ hổng thật tìm được khi săn. Bỏ `skip` là test đỏ ngay;
 * lý do nằm trong chính tên test và trong báo cáo của agent test. TUYỆT ĐỐI không
 * sửa `src/**` — đây là bằng chứng, không phải bản vá.
 *
 *   H-1  `normalizeRegions` kẹp hộp có toạ độ ÂM bằng cách DỜI gốc nhưng GIỮ w/h
 *        ⇒ hộp lưu DB phủ rộng hơn vùng chữ thật (và `box_normalized` cũng sai).
 *        Hệ quả MỚI do F-01: một vùng mô tả HỢP LỆ (không hề giao nhãn hiệu) bị
 *        `BOX_OVERLAPS_PROTECTED` chặn oan, có thể làm cả job `IMAGELAB_NO_LINES`.
 *   H-2  Engine `render({ ops: [] })` trả `OK` kèm ảnh y hệt ảnh gốc và KHÔNG cảnh
 *        báo gì — "OK" trong khi không vẽ gì. Đường pipeline thì đã fail-closed
 *        (ném `IMAGELAB_NO_LINES`), nên đây là lỗ hổng ở tầng API engine.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/store/index.js';
import { createImageStorage } from '../src/imagelab/storage.js';
import { createTranslator } from '../src/imagelab/translate/index.js';
import { createRenderProvider, sha256 } from '../src/imagelab/render/index.js';
import { normalizeRegions } from '../src/imagelab/ocr/normalize.js';
import { ImageTranslationPipeline } from '../src/imagelab/pipeline.js';
import { silent } from './helpers.js';
import {
  countChangedPixels,
  fakeOcrProvider,
  imagelabConfig,
  makeTestImage,
} from './imagelab-helpers.js';

const SID = 'holesSessionAAAA1111';
const RED = [255, 0, 0, 255];

const rawRegion = (text, box, kind) => ({
  id: 'x',
  box,
  text,
  lang: 'zh-Hans',
  confidence: 0.95,
  kind,
  kind_reason: `kind=${kind}`,
  translatable: kind === 'descriptive',
  source: 'ocr',
});

const idWhere = (regions, predicate) => {
  const hit = regions.find(predicate);
  return hit ? String(hit.id) : null;
};
const boxIs = (box) => (r) => r.box.x === box.x && r.box.y === box.y && r.box.w === box.w && r.box.h === box.h;
const isKind = (kind) => (r) => r.kind === kind;

/** Chạy pipeline thật với vùng OCR đi qua ĐÚNG `normalizeRegions`. */
async function runFixture(rawRegions, image, dims = { width: 320, height: 320 }) {
  const normalized = normalizeRegions(rawRegions, { ...dims, minConfidence: 0.5, maxRegions: 40 });
  const config = imagelabConfig();
  const store = await createStore(config, silent);
  const storage = createImageStorage(config, { logger: silent });
  const pipeline = new ImageTranslationPipeline({
    config,
    logger: silent,
    store,
    storage,
    ocrProvider: fakeOcrProvider({ regions: normalized.regions, isMock: true }),
    translator: createTranslator(config, { logger: silent }),
    renderProvider: createRenderProvider(config, { logger: silent }),
  });
  const jobId = await store.createJob({ sessionId: SID, kind: 'image_translation' });
  await pipeline.ingest(jobId, { image, sessionId: SID });
  const ocr = await pipeline.runOcr(jobId, { sessionId: SID });
  let result = null;
  let error = null;
  try {
    result = await pipeline.renderApproved(jobId, { sessionId: SID });
  } catch (err) {
    error = err;
  }
  const assets = await store.listImageAssets(jobId, {});
  await store.close();
  return { normalized, ocr, result, error, assets };
}

const appliedIds = (result) => result.asset.meta.applied.map((a) => String(a.region_id));

describe('MVP-02 · săn lỗ hổng: KHÔNG chặn oan vùng hợp lệ (phần xanh)', () => {
  test('hộp mô tả CHẠM CẠNH hộp bảo vệ (không diện tích chung) vẫn được dịch và vẽ', async () => {
    const BRAND = { x: 40, y: 40, w: 200, h: 40 };
    const ADJ = { x: 240, y: 40, w: 60, h: 40 };
    const image = makeTestImage({ width: 320, height: 320, fills: [{ box: BRAND, rgba: RED }] });
    const { result, error, ocr } = await runFixture(
      [
        rawRegion('品牌旗舰店', BRAND, 'brand'),
        rawRegion('纯棉短袖T恤', ADJ, 'descriptive'),
        rawRegion('纯棉短袖T恤', { x: 40, y: 150, w: 200, h: 40 }, 'descriptive'),
      ],
      image,
    );
    assert.equal(error, null, `không được chặn oan: ${error?.message}`);
    const adjId = idWhere(ocr.regions, boxIs(ADJ));
    assert.ok(appliedIds(result).includes(adjId), 'vùng chỉ chạm cạnh phải được vẽ');
    assert.equal(countChangedPixels(image, result.render.output.buffer, BRAND).changed, 0, 'nhãn hiệu vẫn phải nguyên');
    assert.ok(countChangedPixels(image, result.render.output.buffer, ADJ).changed > 0, 'vùng hợp lệ phải được vẽ thật');
  });

  test('hộp bảo vệ 1×1 ở tầng pipeline: op phủ lên bị chặn, đúng 1 pixel được giữ nguyên', async () => {
    const PIX = { x: 100, y: 100, w: 1, h: 1 };
    const image = makeTestImage({ width: 320, height: 320, fills: [{ box: PIX, rgba: RED }] });
    const { result, error, ocr } = await runFixture(
      [
        rawRegion('品牌旗舰店', PIX, 'brand'),
        rawRegion('纯棉短袖T恤', { x: 90, y: 90, w: 60, h: 60 }, 'descriptive'),
        rawRegion('纯棉短袖T恤', { x: 40, y: 240, w: 200, h: 40 }, 'descriptive'),
      ],
      image,
    );
    assert.equal(error, null);
    const coveringId = idWhere(ocr.regions, (r) => r.kind === 'descriptive' && r.box.h === 60);
    assert.ok(!appliedIds(result).includes(coveringId), 'op phủ lên hộp bảo vệ 1×1 phải bị chặn');
    assert.match(
      String(result.skipped.find((s) => String(s.region_id) === coveringId)?.reason),
      /^BOX_OVERLAPS_PROTECTED/,
    );
    assert.equal(countChangedPixels(image, result.render.output.buffer, PIX).changed, 0, 'pixel nhãn hiệu 1×1 phải nguyên vẹn');
  });
});

describe('MVP-02 · săn lỗ hổng: phát hiện được (test ĐỎ nếu bỏ skip)', () => {
  test('H-1a: kẹp hộp có toạ độ ÂM phải giữ đúng vùng chữ thật (không nới rộng)', { skip: 'H-1: normalizeRegions dời gốc nhưng giữ w/h — test này ĐỎ với mã hiện tại' }, () => {
    const { regions } = normalizeRegions(
      [{ text: '纯棉短袖T恤', box: { x: -30, y: 150, w: 240, h: 40 }, confidence: 0.95, lang: 'zh-Hans' }],
      { width: 320, height: 320, minConfidence: 0.5, maxRegions: 40 },
    );
    assert.equal(regions.length, 1);
    // Vùng thật phủ x ∈ [-30, 210) ⇒ sau khi kẹp vào ảnh chỉ còn x ∈ [0, 210).
    assert.deepEqual(regions[0].box, { x: 0, y: 150, w: 210, h: 40 });
    assert.equal(regions[0].box_normalized.w, Math.round((210 / 320) * 1e6) / 1e6);
  });

  test('H-1b: vùng mô tả KHÔNG giao nhãn hiệu (chỉ do hộp bị nới) phải vẫn được dịch', { skip: 'H-1: hệ quả của lỗi kẹp hộp — vùng hợp lệ bị BOX_OVERLAPS_PROTECTED chặn oan; test này ĐỎ với mã hiện tại' }, async () => {
    const BRAND = { x: 215, y: 150, w: 60, h: 40 };
    const WIDE = { x: -30, y: 150, w: 240, h: 40 }; // thật: [0,210) — KHÔNG chạm brand [215,275)
    const image = makeTestImage({ width: 320, height: 320, fills: [{ box: BRAND, rgba: RED }] });
    const { result, error, ocr } = await runFixture(
      [
        rawRegion('品牌旗舰店', BRAND, 'brand'),
        rawRegion('纯棉短袖T恤', WIDE, 'descriptive'),
        rawRegion('纯棉短袖T恤', { x: 40, y: 240, w: 200, h: 40 }, 'descriptive'),
      ],
      image,
    );
    assert.equal(error, null);
    const wideId = idWhere(ocr.regions, boxIs({ x: 0, y: 150, w: 210, h: 40 })) || idWhere(ocr.regions, (r) => r.kind === 'descriptive' && r.box.y === 150);
    assert.ok(appliedIds(result).includes(wideId), 'vùng không giao nhãn hiệu phải được vẽ');
    assert.ok(!result.skipped.some((s) => /BOX_OVERLAPS_PROTECTED/.test(String(s.reason))), 'không được chặn oan');
    assert.equal(countChangedPixels(image, result.render.output.buffer, BRAND).changed, 0, 'nhãn hiệu vẫn phải nguyên');
  });

  test('H-1c: hộp âm ghi THẲNG vào DB cũng bị tầng pipeline nới rộng (clampBox thứ hai)', { skip: 'H-1: pipeline.js#clampBox cũng dời gốc mà giữ w/h — test này ĐỎ với mã hiện tại' }, async () => {
    const config = imagelabConfig();
    const store = await createStore(config, silent);
    const storage = createImageStorage(config, { logger: silent });
    const pipeline = new ImageTranslationPipeline({
      config,
      logger: silent,
      store,
      storage,
      ocrProvider: fakeOcrProvider({ regions: [], isMock: true }),
      translator: createTranslator(config, { logger: silent }),
      renderProvider: createRenderProvider(config, { logger: silent }),
    });
    const jobId = await store.createJob({ sessionId: SID, kind: 'image_translation' });
    const ing = await pipeline.ingest(jobId, { image: makeTestImage({ width: 320, height: 320 }), sessionId: SID });
    // Ghi thẳng vùng có toạ độ âm vào DB (bỏ qua normalizeRegions) — như provider ngoài luồng.
    await store.saveOcrRegions(jobId, ing.asset_id, [
      { id: 'r1', box: { x: -30, y: 150, w: 240, h: 40 }, text: '纯棉短袖T恤', lang: 'zh-Hans', confidence: 0.95, kind: 'descriptive', kind_reason: '', translatable: true, source: 'ocr' },
    ]);
    await store.saveTranslationLines(jobId, [
      { region_id: 'r1', text_original: '纯棉短袖T恤', text_vi: 'Ao thun cotton', status: 'TRANSLATED', provenance: 'ai', confidence: 0.9, violations: [], notes: '', edited_by_user: false, edited_at: null },
    ]);
    const res = await pipeline.renderApproved(jobId, { sessionId: SID });
    const built = res.ops.find((o) => String(o.region_id) === 'r1');
    // Vùng thật phủ x ∈ [-30, 210) ⇒ kẹp vào ảnh phải còn w = 210, không phải 240.
    assert.deepEqual(built.box, { x: 0, y: 150, w: 210, h: 40 });
    await store.close();
  });

  test('H-2: render với 0 op không được báo OK im lặng', { skip: 'H-2: engine trả OK + ảnh y hệt gốc, warnings rỗng — test này ĐỎ với mã hiện tại' }, async () => {
    const provider = createRenderProvider(imagelabConfig(), { logger: silent });
    const image = makeTestImage({ width: 64, height: 64 });
    const res = await provider.render({ image, ops: [], options: {} });
    assert.notEqual(res.status, 'OK', 'không vẽ gì thì không được báo OK');
    assert.equal(res.output.sha256, sha256(image));
  });
});
