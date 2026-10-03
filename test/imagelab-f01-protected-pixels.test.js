/**
 * TEST HỒI QUY ĐỘC LẬP — F-01 (CRITICAL sau phản biện): vùng `brand/certification/price`
 * KHÔNG được đổi một pixel nào, kể cả khi hộp của vùng `descriptive` CHỒNG MỘT PHẦN,
 * LỒNG TRONG, hay TRÙNG HỘP với vùng được bảo vệ.
 *
 * Nguyên tắc (luật #1 — không bịa): mọi khẳng định "không xoá" đều được KIỂM BẰNG PIXEL
 * đếm từ buffer PNG thật (`countChangedPixels`), không chỉ tin vào `applied`/`skipped`
 * mà hệ thống tự khai.
 *
 * Hai tầng được kiểm ĐỘC LẬP:
 *   1. Tầng engine — gọi thẳng `render({ ops, options: { protected_boxes } })` với op
 *      cố tình phủ lên hộp bảo vệ (kể cả khi pipeline đã lọc).
 *   2. Tầng pipeline — `ingest → runOcr → renderApproved` với dữ liệu OCR đi qua ĐÚNG
 *      `normalizeRegions` như provider thật (id vùng do C1 gán lại theo thứ tự đọc).
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

const SID = 'f01SessionAAAA1111';
const BRAND = { x: 40, y: 40, w: 200, h: 40 };
const CERT = { x: 40, y: 250, w: 260, h: 34 };
const SAFE = { x: 40, y: 150, w: 200, h: 40 };
const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

/** Ảnh 320×320 với vùng nhãn hiệu (đỏ) + chứng nhận (xanh) để đếm pixel. */
const protectedImage = () => makeTestImage({
  width: 320,
  height: 320,
  fills: [{ box: BRAND, rgba: RED }, { box: CERT, rgba: BLUE }],
});

const engineProvider = () => createRenderProvider(imagelabConfig(), { logger: silent });

const op = (regionId, box, text = 'Ao thun cotton') => ({
  region_id: regionId,
  box,
  action: 'erase_and_draw',
  text,
  style: { align: 'center', padding: 2 },
});

/* ══════════════════════ 1. TẦNG ENGINE ══════════════════════ */

describe('MVP-02 F-01 · engine render(): mặt nạ protected_boxes giữ nguyên pixel', () => {
  test('op nằm TRỌN trong hộp bảo vệ → skipped PROTECTED_BOX_MASKED, 0 pixel đổi', async () => {
    const provider = engineProvider();
    const img = protectedImage();
    const res = await provider.render({
      image: img,
      ops: [op('r2', { x: 50, y: 50, w: 100, h: 20 })],
      options: { protected_boxes: [{ region_id: 'r1', box: BRAND }] },
    });

    assert.equal(res.status, 'PARTIAL', 'phải là PARTIAL vì có op không vẽ được');
    assert.deepEqual(res.applied, [], 'không op nào được coi là đã áp dụng');
    assert.equal(res.skipped.length, 1);
    assert.equal(res.skipped[0].region_id, 'r2');
    assert.equal(res.skipped[0].reason, 'PROTECTED_BOX_MASKED');

    const brand = countChangedPixels(img, res.output.buffer, BRAND);
    const cert = countChangedPixels(img, res.output.buffer, CERT);
    assert.equal(brand.changed, 0, `hộp nhãn hiệu bị đổi ${brand.changed} pixel: ${JSON.stringify(brand.first)}`);
    assert.equal(cert.changed, 0, 'hộp chứng nhận không được đụng tới');
    assert.equal(res.output.sha256, sha256(img), 'không vẽ gì thì ảnh ra phải y hệt ảnh gốc');
  });

  test('op chồng MỘT PHẦN → vẫn vẽ ngoài hộp bảo vệ nhưng 0 pixel TRONG hộp bảo vệ đổi', async () => {
    const provider = engineProvider();
    const img = protectedImage();
    const opBox = { x: 30, y: 30, w: 240, h: 120 };
    const res = await provider.render({
      image: img,
      ops: [op('r2', opBox)],
      options: { protected_boxes: [{ region_id: 'r1', box: BRAND }] },
    });

    assert.equal(res.status, 'PARTIAL');
    assert.equal(res.applied.length, 1);
    assert.equal(res.applied[0].masked, true, 'op bị mặt nạ một phần phải tự khai `masked`');

    const brand = countChangedPixels(img, res.output.buffer, BRAND);
    assert.equal(brand.changed, 0, `hộp nhãn hiệu bị đổi ${brand.changed} pixel: ${JSON.stringify(brand.first)}`);
    // Chứng minh op THẬT SỰ có tác dụng ở phần ngoài hộp bảo vệ (không phải bị bỏ luôn).
    const outside = countChangedPixels(img, res.output.buffer, { x: 30, y: 90, w: 240, h: 60 });
    assert.ok(outside.changed > 0, 'phần ngoài hộp bảo vệ phải được vẽ thật');
    assert.ok(res.warnings.some((w) => /MẶT NẠ/.test(w)), 'phải có cảnh báo nói rõ bị mặt nạ chặn một phần');
  });

  test('nhiều op liên tiếp: op sau không xoá mất thành quả op trước, hộp bảo vệ vẫn nguyên', async () => {
    const provider = engineProvider();
    const img = protectedImage();
    const boxA = { x: 30, y: 30, w: 240, h: 120 };
    const boxB = { x: 30, y: 200, w: 240, h: 40 };
    const res = await provider.render({
      image: img,
      ops: [op('r2', boxA, 'MOT HAI BA'), op('r3', boxB, 'BON')],
      options: { protected_boxes: [{ region_id: 'r1', box: BRAND }] },
    });
    assert.equal(res.applied.length, 2);
    assert.equal(countChangedPixels(img, res.output.buffer, BRAND).changed, 0);
    assert.equal(countChangedPixels(img, res.output.buffer, CERT).changed, 0);
    assert.ok(countChangedPixels(img, res.output.buffer, { x: 30, y: 90, w: 240, h: 60 }).changed > 0, 'op1 phải vẽ được ngoài hộp bảo vệ');
    assert.ok(countChangedPixels(img, res.output.buffer, boxB).changed > 0, 'op2 phải vẽ được');
  });

  test('hộp bảo vệ 1×1, toạ độ ÂM và TRÀN BIÊN vẫn được giữ nguyên', async () => {
    const provider = engineProvider();

    // (a) hộp 1×1
    const tiny = makeTestImage({ width: 120, height: 120, fills: [{ box: { x: 60, y: 60, w: 1, h: 1 }, rgba: RED }] });
    const rTiny = await provider.render({
      image: tiny,
      ops: [op('r2', { x: 50, y: 50, w: 40, h: 40 }, 'AB')],
      options: { protected_boxes: [{ region_id: 'r1', box: { x: 60, y: 60, w: 1, h: 1 } }] },
    });
    assert.equal(countChangedPixels(tiny, rTiny.output.buffer, { x: 60, y: 60, w: 1, h: 1 }).changed, 0);

    // (b) hộp bảo vệ có toạ độ âm + tràn biên
    const neg = makeTestImage({ width: 160, height: 160, fills: [{ box: { x: 0, y: 0, w: 60, h: 60 }, rgba: RED }] });
    const rNeg = await provider.render({
      image: neg,
      ops: [op('r2', { x: -20, y: -20, w: 300, h: 300 }, 'ABCDEF')],
      options: { protected_boxes: [{ region_id: 'r1', box: { x: -30, y: -30, w: 90, h: 90 } }] },
    });
    const negDiff = countChangedPixels(neg, rNeg.output.buffer, { x: 0, y: 0, w: 60, h: 60 });
    assert.equal(negDiff.changed, 0, `vùng [0,0,60,60] bị đổi ${negDiff.changed} pixel: ${JSON.stringify(negDiff.first)}`);
    assert.equal(rNeg.output.width, 160, 'ảnh ra phải giữ nguyên kích thước');
    assert.equal(rNeg.output.height, 160);
  });

  test('KHÔNG chặn oan: op chỉ CHẠM CẠNH hộp bảo vệ vẫn được vẽ bình thường', async () => {
    const provider = engineProvider();
    const img = protectedImage();
    const touching = { x: BRAND.x + BRAND.w, y: BRAND.y, w: 60, h: BRAND.h };
    const res = await provider.render({
      image: img,
      ops: [op('r2', touching, 'AB')],
      options: { protected_boxes: [{ region_id: 'r1', box: BRAND }] },
    });
    assert.equal(res.status, 'OK', 'không được coi là bị mặt nạ khi chỉ chạm cạnh');
    assert.equal(res.applied.length, 1);
    assert.equal(res.applied[0].masked, undefined);
    assert.equal(countChangedPixels(img, res.output.buffer, BRAND).changed, 0);
    assert.ok(countChangedPixels(img, res.output.buffer, touching).changed > 0, 'vùng hợp lệ phải được vẽ');
  });

  test('fuzz tất định 120 ca (hộp âm/tràn/1×1 ngẫu nhiên): 0 pixel trong hộp bảo vệ bị đổi', async () => {
    const provider = engineProvider();
    const W = 120;
    const H = 120;
    let seed = 20261003;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const ri = (a, b) => Math.floor(rnd() * (b - a + 1)) + a;

    for (let i = 0; i < 120; i += 1) {
      const pbox = { x: ri(-40, W + 40), y: ri(-40, H + 40), w: ri(1, 70), h: ri(1, 70) };
      const x0 = Math.max(0, pbox.x);
      const y0 = Math.max(0, pbox.y);
      const x1 = Math.min(W, pbox.x + pbox.w);
      const y1 = Math.min(H, pbox.y + pbox.h);
      const visible = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
      const img = visible.w > 0 && visible.h > 0
        ? makeTestImage({ width: W, height: H, fills: [{ box: visible, rgba: RED }] })
        : makeTestImage({ width: W, height: H });

      const res = await provider.render({
        image: img,
        ops: [{
          region_id: 'rN',
          box: { x: ri(-60, W + 60), y: ri(-60, H + 60), w: ri(1, 160), h: ri(1, 160) },
          action: rnd() < 0.5 ? 'erase' : 'erase_and_draw',
          text: 'Xin chao',
          style: { align: 'center', padding: 2 },
        }],
        options: { protected_boxes: [{ region_id: 'rP', box: pbox }] },
      });
      if (visible.w > 0 && visible.h > 0) {
        const diff = countChangedPixels(img, res.output.buffer, visible);
        assert.equal(
          diff.changed,
          0,
          `ca #${i} pbox=${JSON.stringify(pbox)} bị đổi ${diff.changed} pixel: ${JSON.stringify(diff.first)}`,
        );
      }
      assert.ok(res.output?.buffer?.length > 0, `ca #${i}: output rỗng`);
    }
  });
});

/* ══════════════════════ 2. TẦNG PIPELINE ══════════════════════ */

const rawRegion = (id, text, box, kind) => ({
  id,
  box,
  text,
  lang: 'zh-Hans',
  confidence: 0.95,
  kind,
  kind_reason: `kind=${kind}`,
  translatable: kind === 'descriptive',
  source: 'ocr',
});

/**
 * Dựng fixture qua ĐÚNG `normalizeRegions` (như provider thật) rồi chạy pipeline thật.
 * `normalizeRegions` gán lại id theo thứ tự đọc (r1…rN) nên test phải tra id từ
 * `ocr.regions`, KHÔNG được hardcode id của dữ liệu thô.
 */
async function runFixture(rawRegions, image, { mutateLines = null, dims = { width: 320, height: 320 } } = {}) {
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
  if (mutateLines) await mutateLines(store, jobId, ocr);

  let result = null;
  let error = null;
  try {
    result = await pipeline.renderApproved(jobId, { sessionId: SID });
  } catch (err) {
    error = err;
  }
  const job = await store.getJob(jobId);
  const assets = await store.listImageAssets(jobId, {});
  await store.close();
  return { normalized, ocr, result, error, job, assets };
}

/** id vùng (do C1 gán) theo điều kiện trên vùng ĐÃ LƯU trong DB. */
const idWhere = (regions, predicate) => {
  const hit = regions.find(predicate);
  return hit ? String(hit.id) : null;
};
const boxIs = (box) => (r) => r.box.x === box.x && r.box.y === box.y && r.box.w === box.w && r.box.h === box.h;
const isKind = (kind) => (r) => r.kind === kind;
const appliedIds = (result) => result.asset.meta.applied.map((a) => String(a.region_id));

/** Bất biến: mọi vùng được báo `applied` phải KHÔNG giao với hộp được bảo vệ. */
function assertAppliedNeverTouchesProtected(result) {
  const protectedBoxes = [BRAND, CERT];
  const opBoxById = new Map((result.ops || []).map((o) => [String(o.region_id), o.box]));
  for (const applied of result.asset.meta.applied) {
    const box = opBoxById.get(String(applied.region_id)) || applied.box;
    for (const p of protectedBoxes) {
      const overlap = box.x < p.x + p.w && p.x < box.x + box.w && box.y < p.y + p.h && p.y < box.y + box.h;
      assert.equal(overlap, false, `vùng ${applied.region_id} được báo đã vẽ nhưng giao hộp bảo vệ ${JSON.stringify(p)}`);
    }
  }
}

describe('MVP-02 F-01 · pipeline: hộp mô tả chồng / lồng / trùng hộp vùng bảo vệ', () => {
  const fixtureRegions = () => [
    rawRegion('X1', '品牌旗舰店', BRAND, 'brand'),
    rawRegion('X2', '3C认证 合格证齐全', CERT, 'certification'),
    rawRegion('X3', '纯棉短袖T恤', SAFE, 'descriptive'),
  ];

  test('CHỒNG MỘT PHẦN: vùng mô tả không được vẽ, 0 pixel nhãn hiệu/chứng nhận bị đổi, skipped nói thật', async () => {
    const image = protectedImage();
    const { result, error, normalized, ocr } = await runFixture(
      [...fixtureRegions(), rawRegion('X4', '纯棉短袖T恤', { x: 30, y: 30, w: 240, h: 120 }, 'descriptive')],
      image,
    );
    assert.equal(error, null, `render không được ném lỗi: ${error?.message}`);
    assert.equal(result.status, 'succeeded');
    assert.ok(normalized.warnings.some((w) => /giao nhau/.test(w)), 'normalizeRegions phải cảnh báo có cặp hộp giao nhau');

    const out = result.render.output.buffer;
    assert.equal(countChangedPixels(image, out, BRAND).changed, 0, 'nhãn hiệu bị đổi pixel');
    assert.equal(countChangedPixels(image, out, CERT).changed, 0, 'chứng nhận bị đổi pixel');

    const brandId = idWhere(ocr.regions, isKind('brand'));
    const safeId = idWhere(ocr.regions, boxIs(SAFE));
    const overlapId = idWhere(ocr.regions, (r) => r.kind === 'descriptive' && r.box.h === 120);
    assert.ok(brandId && safeId && overlapId, `không tra được id vùng: ${JSON.stringify(ocr.regions.map((r) => [r.id, r.kind, r.box]))}`);
    assert.deepEqual(appliedIds(result), [safeId], 'chỉ vùng mô tả KHÔNG giao hộp bảo vệ được vẽ');
    const skippedOverlap = result.skipped.find((s) => String(s.region_id) === overlapId);
    assert.ok(skippedOverlap, 'vùng bị chặn phải xuất hiện trong skipped');
    assert.match(
      String(skippedOverlap.reason),
      new RegExp(`^BOX_OVERLAPS_PROTECTED: ${brandId} \\(brand\\)`),
      'lý do phải nói rõ chồng lên vùng nào',
    );
    assertAppliedNeverTouchesProtected(result);
  });

  test('LỒNG NHAU (mô tả nằm trọn trong nhãn hiệu): không vẽ, 0 pixel đổi', async () => {
    const image = protectedImage();
    const { result, error, ocr } = await runFixture(
      [...fixtureRegions(), rawRegion('X4', '纯棉短袖T恤', { x: 60, y: 45, w: 100, h: 25 }, 'descriptive')],
      image,
    );
    assert.equal(error, null);
    const out = result.render.output.buffer;
    assert.equal(countChangedPixels(image, out, BRAND).changed, 0);
    assert.equal(countChangedPixels(image, out, CERT).changed, 0);
    const brandId = idWhere(ocr.regions, isKind('brand'));
    const safeId = idWhere(ocr.regions, boxIs(SAFE));
    const overlapId = idWhere(ocr.regions, (r) => r.kind === 'descriptive' && r.box.h === 25);
    assert.deepEqual(appliedIds(result), [safeId]);
    assert.match(String(result.skipped.find((s) => String(s.region_id) === overlapId).reason), new RegExp(`BOX_OVERLAPS_PROTECTED: ${brandId}`));
    assertAppliedNeverTouchesProtected(result);
  });

  test('CÙNG HỘP KHÁC CHỮ: khử trùng theo mức bảo vệ ở tầng OCR, nhãn hiệu thắng', async () => {
    const image = protectedImage();
    const { normalized, result, error, ocr } = await runFixture(
      [...fixtureRegions(), rawRegion('X4', '纯棉短袖T恤', BRAND, 'descriptive')],
      image,
    );
    assert.equal(error, null);
    // Vùng mô tả trùng hộp bị BỎ ngay từ C1 (có vết trong `dropped`), không thành dòng dịch.
    const atBrandBox = normalized.regions.filter((r) => boxIs(BRAND)(r));
    assert.equal(atBrandBox.length, 1, 'một hộp chỉ được giữ một vùng');
    assert.equal(atBrandBox[0].kind, 'brand', 'vùng được giữ phải là vùng bảo vệ cao nhất');
    assert.ok(normalized.dropped.some((d) => d.text === '纯棉短袖T恤'), 'vùng mô tả trùng hộp phải vào dropped kèm chữ gốc');
    assert.match(String(normalized.dropped[0].reason), /trùng hộp nhưng khác chữ/);

    const out = result.render.output.buffer;
    assert.equal(countChangedPixels(image, out, BRAND).changed, 0);
    assert.deepEqual(appliedIds(result), [idWhere(ocr.regions, boxIs(SAFE))]);
    assertAppliedNeverTouchesProtected(result);
  });

  test('MỌI vùng vẽ được đều bị chặn → ném IMAGELAB_NO_LINES, KHÔNG tạo ảnh rỗng giả', async () => {
    const image = protectedImage();
    const { result, error, job, assets } = await runFixture(
      [
        rawRegion('X1', '品牌旗舰店', BRAND, 'brand'),
        rawRegion('X4', '纯棉短袖T恤', { x: 30, y: 30, w: 240, h: 120 }, 'descriptive'),
      ],
      image,
    );
    assert.equal(result, null, 'không được trả kết quả render giả');
    assert.ok(error, 'phải ném lỗi để job không thành công giả');
    assert.equal(error.code, 'IMAGELAB_NO_LINES');
    assert.match(String(error.message), /BOX_OVERLAPS_PROTECTED/);
    assert.notEqual(job.status, 'succeeded', 'job KHÔNG được coi là thành công');
    assert.equal(assets.filter((a) => a.role === 'rendered').length, 0, 'KHÔNG được lưu ảnh render rỗng giả');
    assert.ok(error.details?.skipped?.length > 0, 'chi tiết lý do phải được mang theo lỗi');
  });

  test('nhãn hiệu có hộp toạ độ ÂM (bị kẹp vào ảnh) vẫn được bảo vệ pixel', async () => {
    const image = makeTestImage({ width: 320, height: 320, fills: [{ box: { x: 0, y: 0, w: 40, h: 40 }, rgba: RED }] });
    const { result, error, normalized, ocr } = await runFixture(
      [
        rawRegion('X1', '品牌旗舰店', { x: -30, y: -30, w: 70, h: 70 }, 'brand'),
        rawRegion('X4', '纯棉短袖T恤', { x: -60, y: -60, w: 200, h: 200 }, 'descriptive'),
        rawRegion('X3', '纯棉短袖T恤', SAFE, 'descriptive'),
      ],
      image,
    );
    assert.equal(error, null, `không được vỡ: ${error?.message}`);
    assert.ok(normalized.regions.every((r) => r.box.x >= 0 && r.box.y >= 0), 'hộp lưu DB phải nằm trong ảnh');
    const out = result.render.output.buffer;
    assert.equal(countChangedPixels(image, out, { x: 0, y: 0, w: 40, h: 40 }).changed, 0, 'pixel nhãn hiệu bị đổi');
    assert.deepEqual(appliedIds(result), [idWhere(ocr.regions, boxIs(SAFE))]);
  });

  test('dòng nhãn hiệu bị provider dịch trộm (status TRANSLATED + chữ Việt) vẫn KHÔNG được vẽ', async () => {
    const image = protectedImage();
    const { result, error, ocr } = await runFixture(fixtureRegions(), image, {
      mutateLines: async (store, jobId, current) => {
        const brandId = idWhere(current.regions, isKind('brand'));
        const safeId = idWhere(current.regions, boxIs(SAFE));
        await store.saveTranslationLines(jobId, [
          { region_id: brandId, text_original: '品牌旗舰店', text_vi: 'DICH TROM BRAND', status: 'TRANSLATED', provenance: 'ai', confidence: 0.9, violations: [], notes: '', edited_by_user: false, edited_at: null },
          { region_id: safeId, text_original: '纯棉短袖T恤', text_vi: 'Ao thun cotton', status: 'TRANSLATED', provenance: 'ai', confidence: 0.9, violations: [], notes: '', edited_by_user: false, edited_at: null },
        ]);
      },
    });
    assert.equal(error, null);
    const out = result.render.output.buffer;
    assert.equal(countChangedPixels(image, out, BRAND).changed, 0, 'pixel nhãn hiệu bị đổi vì dòng dịch trộm');
    const brandId = idWhere(ocr.regions, isKind('brand'));
    assert.deepEqual(appliedIds(result), [idWhere(ocr.regions, boxIs(SAFE))]);
    assert.match(String(result.skipped.find((s) => String(s.region_id) === brandId).reason), /nhãn hiệu/i);
  });

  test('tín hiệu bảo vệ thứ hai: dòng đổi sang SKIPPED_BY_USER thì vùng vẫn được bảo vệ theo KIND', async () => {
    const image = protectedImage();
    const { result, error, ocr } = await runFixture(fixtureRegions(), image, {
      mutateLines: async (store, jobId, current) => {
        const brandId = idWhere(current.regions, isKind('brand'));
        const safeId = idWhere(current.regions, boxIs(SAFE));
        await store.updateTranslationLines(jobId, [
          { region_id: brandId, text_original: '品牌旗舰店', text_vi: '', status: 'SKIPPED_BY_USER', provenance: 'user', confidence: 0.9, violations: [], notes: 'người dùng bỏ qua', edited_by_user: true, edited_at: '2026-10-03T00:00:00.000Z' },
          { region_id: safeId, text_original: '纯棉短袖T恤', text_vi: 'Ao thun cotton', status: 'TRANSLATED', provenance: 'ai', confidence: 0.9, violations: [], notes: '', edited_by_user: false, edited_at: null },
        ]);
      },
    });
    assert.equal(error, null);
    const out = result.render.output.buffer;
    assert.equal(countChangedPixels(image, out, BRAND).changed, 0, 'mất status SKIPPED_BRAND thì kind=brand vẫn phải bảo vệ');
    assert.deepEqual(appliedIds(result), [idWhere(ocr.regions, boxIs(SAFE))]);
  });

  test('vùng GIÁ cũng là vùng bảo vệ: op chồng lên bị chặn kèm đúng tên kind, pixel giá không đổi', async () => {
    const PRICE = { x: 40, y: 285, w: 200, h: 25 };
    const GREEN = [0, 128, 0, 255];
    const image = makeTestImage({
      width: 320,
      height: 320,
      fills: [{ box: PRICE, rgba: GREEN }, { box: SAFE, rgba: [255, 255, 0, 255] }],
    });
    const { result, error, ocr } = await runFixture(
      [
        rawRegion('X5', '￥199.00', PRICE, 'price'),
        rawRegion('X4', '纯棉短袖T恤', { x: 30, y: 280, w: 240, h: 34 }, 'descriptive'), // chồng vùng GIÁ
        rawRegion('X3', '纯棉短袖T恤', SAFE, 'descriptive'),
      ],
      image,
    );
    assert.equal(error, null, `không được vỡ: ${error?.message}`);
    const priceId = idWhere(ocr.regions, isKind('price'));
    const safeId = idWhere(ocr.regions, boxIs(SAFE));
    const overlapId = idWhere(ocr.regions, (r) => r.kind === 'descriptive' && r.box.y === 280);
    assert.ok(priceId && overlapId, `không tra được id vùng: ${JSON.stringify(ocr.regions.map((r) => [r.id, r.kind, r.box]))}`);
    assert.ok(!appliedIds(result).includes(priceId), 'vùng giá không bao giờ được nằm trong applied');
    assert.ok(!appliedIds(result).includes(overlapId), 'op chồng vùng giá phải bị chặn');
    assert.match(
      String(result.skipped.find((s) => String(s.region_id) === overlapId)?.reason),
      new RegExp(`^BOX_OVERLAPS_PROTECTED: ${priceId} \\(price\\)`),
    );
    assert.equal(countChangedPixels(image, result.render.output.buffer, PRICE).changed, 0, 'pixel vùng giá bị đổi');
    assert.deepEqual(appliedIds(result), [safeId], 'chỉ vùng an toàn được vẽ');
  });
});
