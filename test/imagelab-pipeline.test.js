/**
 * TEST MVP-02 · PIPELINE (C4) — `src/imagelab/pipeline.js` + storage.
 *
 * Khẳng định luồng thật: ingest → runOcr (chờ duyệt, KHÔNG tự render) → duyệt →
 * renderApproved, cùng bốn luật bất khả xâm phạm:
 *  - ảnh gốc bất biến (file trên đĩa + sha256 trong DB);
 *  - brand/certification/price KHÔNG BAO GIỜ lọt vào danh sách op render, kể cả khi
 *    dòng dịch trong DB khai `TRANSLATED`;
 *  - lỗi provider ⇒ job `failed` + `error_code` + `finished_at` (không treo `running`);
 *  - bằng chứng `MANUAL_INPUT`, không bao giờ `LIVE_VERIFIED`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createStore, JOB_KINDS, JOB_STATUS } from '../src/store/index.js';
import { createImageStorage } from '../src/imagelab/storage.js';
import { createOcrProvider } from '../src/imagelab/ocr/index.js';
import { createTranslator } from '../src/imagelab/translate/index.js';
import { createRenderProvider, decodePng, sha256, toRgba } from '../src/imagelab/render/index.js';
import { ImageTranslationPipeline, pendingReviewLines } from '../src/imagelab/pipeline.js';
import { testConfig, silent } from './helpers.js';
import { fakeOcrProvider, fakeRenderProvider, headphones, imagelabConfig, region, tmpDir } from './imagelab-helpers.js';

/** Stack thật chạy offline: OCR mock, translator mock, render purejs, storage tmp. */
async function freshStack(configOverrides = {}) {
  const config = imagelabConfig(configOverrides);
  const store = await createStore(config, silent);
  const storage = createImageStorage(config, { logger: silent });
  const ocrProvider = createOcrProvider(config, { logger: silent });
  const translator = createTranslator(config, { logger: silent });
  const renderProvider = createRenderProvider(config, { logger: silent });
  const pipeline = new ImageTranslationPipeline({
    config,
    logger: silent,
    store,
    storage,
    ocrProvider,
    translator,
    renderProvider,
  });
  const jobId = await store.createJob({ sessionId: 'session-pipeline-01', kind: JOB_KINDS.IMAGE_TRANSLATION });
  return { config, store, storage, ocrProvider, translator, renderProvider, pipeline, jobId };
}

const line = (regionId, over = {}) => ({
  region_id: regionId,
  text_original: 'gốc',
  text_vi: 'Chữ Việt',
  status: 'TRANSLATED',
  provenance: 'ai',
  confidence: 0.9,
  violations: [],
  notes: '',
  edited_by_user: false,
  edited_at: null,
  ...over,
});

describe('MVP-02 pipeline — ingest (ảnh gốc bất biến)', () => {
  test('lưu asset gốc + sha256 + file trên đĩa đúng byte ảnh tải lên', async () => {
    const { pipeline, store, storage, jobId } = await freshStack();
    const buf = headphones();

    const res = await pipeline.ingest(jobId, {
      image: { base64: buf.toString('base64'), filename: 'tai-nghe.png' },
      sessionId: 'session-pipeline-01',
    });

    assert.ok(res.asset_id);
    assert.equal(res.sha256, sha256(buf));
    assert.equal(res.width, 320);
    assert.equal(res.height, 320);
    assert.equal(res.mime, 'image/png');

    const asset = await store.getImageAsset(res.asset_id);
    assert.equal(asset.role, 'original');
    assert.equal(asset.parent_id, null);
    assert.equal(asset.source, 'upload');
    assert.equal(asset.session_id, 'session-pipeline-01');
    assert.equal(asset.bytes, buf.length);
    assert.equal(asset.sha256, sha256(buf));
    assert.equal(asset.storage_path, `${jobId}/${res.asset_id}.png`);
    assert.ok(!asset.storage_path.includes('..'));

    assert.ok(await storage.exists(asset));
    assert.ok((await storage.read(asset)).equals(buf), 'file gốc phải đúng byte người dùng tải lên');
    await store.close();
  });

  test('ảnh không phải ảnh thật (HTML) → UNSUPPORTED_IMAGE + job failed, không treo', async () => {
    const { pipeline, store, jobId } = await freshStack();
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    await assert.rejects(
      () => pipeline.ingest(jobId, { image: { base64: html.toString('base64'), mime: 'image/png' }, sessionId: 's' }),
      (err) => err.code === 'UNSUPPORTED_IMAGE',
    );
    const job = await store.getJob(jobId);
    assert.equal(job.status, JOB_STATUS.FAILED);
    assert.ok(job.error_code);
    assert.ok(job.finished_at);
    await store.close();
  });

  test('base64 rác → INVALID_IMAGE, không ghi file rác', async () => {
    const { pipeline, store, jobId } = await freshStack();
    await assert.rejects(
      () => pipeline.ingest(jobId, { image: { base64: '!!!khong-phai-base64!!!' }, sessionId: 's' }),
      (err) => err.code === 'INVALID_IMAGE',
    );
    assert.deepEqual(await store.listImageAssets(jobId), []);
    await store.close();
  });
});

describe('MVP-02 pipeline — runOcr (dừng ở awaiting_review)', () => {
  test('runOcr → awaiting_review, stage awaiting_review, finished_at = null, KHÔNG tự render', async () => {
    const { pipeline, store, jobId } = await freshStack();
    await pipeline.ingest(jobId, { image: headphones(), sessionId: 'session-pipeline-01' });

    const out = await pipeline.runOcr(jobId, { sessionId: 'session-pipeline-01' });
    assert.equal(out.status, JOB_STATUS.AWAITING_REVIEW);
    assert.equal(out.stage, 'awaiting_review');
    assert.ok(out.regions.length >= 1, 'phải có vùng OCR được lưu');
    assert.equal(out.lines.length, out.regions.length, 'mỗi vùng phải có một dòng dịch');

    const job = await store.getJob(jobId);
    assert.equal(job.status, JOB_STATUS.AWAITING_REVIEW);
    assert.equal(job.stage, 'awaiting_review');
    assert.equal(job.finished_at, null, 'chờ duyệt thì job CHƯA kết thúc');
    assert.equal(job.error_code, null);

    // Không có ảnh rendered nào — pipeline không được tự render.
    assert.deepEqual(await store.listImageAssets(jobId, { role: 'rendered' }), []);

    // Vùng nhãn hiệu/chứng nhận vẫn không dịch, và hộp phải nằm trong ảnh.
    const brand = out.regions.filter((r) => r.kind === 'brand');
    assert.ok(brand.length >= 1, 'fixture phải có vùng nhãn hiệu');
    for (const r of out.regions) {
      assert.equal(r.translatable, r.kind === 'descriptive');
      assert.ok(r.box.x >= 0 && r.box.y >= 0 && r.box.x + r.box.w <= 320 && r.box.y + r.box.h <= 320, `hộp ngoài ảnh: ${JSON.stringify(r.box)}`);
    }
    for (const l of out.lines.filter((x) => brand.some((b) => b.id === x.region_id))) {
      assert.equal(l.text_vi, '');
      assert.equal(l.status, 'SKIPPED_BRAND');
    }

    // Vết MOCK phải được khai thật
    assert.ok(out.mock_steps.includes('ocr'), 'bước OCR dùng mock phải được khai');
    assert.ok(job.content_meta.imagelab.mock_steps.includes('translate'));

    // usage_event OCR_DETECT: input = pixel, output = số region
    const usage = await store.listUsage(jobId);
    const ocrEvent = usage.find((e) => e.operation === 'OCR_DETECT');
    assert.ok(ocrEvent, 'phải có usage_event OCR_DETECT');
    assert.equal(ocrEvent.input_units, 320 * 320);
    assert.equal(ocrEvent.output_units, out.regions.length);
    await store.close();
  });

  test('provider OCR ném lỗi → job failed + error_code + finished_at (KHÔNG treo running)', async () => {
    const { pipeline, store, jobId } = await freshStack();
    await pipeline.ingest(jobId, { image: headphones(), sessionId: 's' });
    const boom = new Error('máy chủ OCR đứt kết nối');
    boom.code = 'OCR_HTTP_FAILED';
    pipeline.ocrProvider = fakeOcrProvider({ fail: boom });

    const out = await pipeline.runOcr(jobId, { sessionId: 's' });
    assert.equal(out.status, JOB_STATUS.FAILED);
    assert.equal(out.error_code, 'OCR_HTTP_FAILED');

    const job = await store.getJob(jobId);
    assert.equal(job.status, JOB_STATUS.FAILED);
    assert.equal(job.error_code, 'OCR_HTTP_FAILED');
    assert.ok(job.finished_at, 'job lỗi PHẢI có finished_at');
    assert.notEqual(job.status, JOB_STATUS.RUNNING);
    await store.close();
  });

  test('OCR provider chưa cấu hình → NOT_CONFIGURED, job failed (không bịa vùng chữ)', async () => {
    const { pipeline, store, jobId, config } = await freshStack();
    await pipeline.ingest(jobId, { image: headphones(), sessionId: 's' });
    pipeline.ocrProvider = createOcrProvider(testConfig({ ...config, OCR_PROVIDER: 'none' }), { logger: silent });

    const out = await pipeline.runOcr(jobId, { sessionId: 's' });
    assert.equal(out.status, JOB_STATUS.FAILED);
    assert.equal(out.error_code, 'NOT_CONFIGURED');
    assert.deepEqual(out.regions, []);
    assert.equal((await store.getJob(jobId)).status, JOB_STATUS.FAILED);
    await store.close();
  });

  test('OCR trả status FAILED có mã (thiếu fixture) → job failed với ĐÚNG mã đó', async () => {
    const { pipeline, store, jobId } = await freshStack();
    await pipeline.ingest(jobId, { image: headphones(), sessionId: 's' });
    pipeline.ocrProvider = fakeOcrProvider({ status: 'FAILED', errorCode: 'OCR_MOCK_FIXTURE_MISSING' });

    const out = await pipeline.runOcr(jobId, { sessionId: 's' });
    assert.equal(out.status, JOB_STATUS.FAILED);
    assert.equal(out.error_code, 'OCR_MOCK_FIXTURE_MISSING');
    assert.equal((await store.getJob(jobId)).error_code, 'OCR_MOCK_FIXTURE_MISSING');
    await store.close();
  });
});

describe('MVP-02 pipeline — renderApproved (cổng duyệt + luật 3)', () => {
  /** Job đã OCR xong, với 4 vùng đủ loại (brand/descriptive/certification/price). */
  async function prepared() {
    const stack = await freshStack();
    const regions = [
      region({ id: 'r1', text: '品牌旗舰店', kind: 'brand', box: { x: 10, y: 10, w: 120, h: 30 } }),
      region({ id: 'r2', text: '纯棉短袖T恤', kind: 'descriptive', box: { x: 10, y: 60, w: 160, h: 40 } }),
      region({ id: 'r3', text: '3C认证 合格证齐全', kind: 'certification', box: { x: 10, y: 120, w: 140, h: 30 } }),
      region({ id: 'r4', text: '¥39.9 包邮', kind: 'price', box: { x: 10, y: 170, w: 120, h: 30 } }),
    ];
    stack.pipeline.ocrProvider = fakeOcrProvider({ regions });
    await stack.pipeline.ingest(stack.jobId, { image: headphones(), sessionId: 's' });
    await stack.pipeline.runOcr(stack.jobId, { sessionId: 's' });
    return { ...stack, regions };
  }

  test('còn dòng NEEDS_REVIEW chưa duyệt → ném REVIEW_REQUIRED, job KHÔNG bị đánh failed', async () => {
    const { pipeline, store, jobId } = await prepared();
    await store.saveTranslationLines(jobId, [
      line('r2', { text_vi: 'Áo thun cotton' }),
      line('r1', { text_vi: 'Nhãn hiệu X', status: 'NEEDS_REVIEW', violations: ['cần người duyệt'] }),
    ]);

    await assert.rejects(
      () => pipeline.renderApproved(jobId, { sessionId: 's' }),
      (err) => err.code === 'REVIEW_REQUIRED' && /duyệt/i.test(err.message),
    );
    const job = await store.getJob(jobId);
    assert.equal(job.status, JOB_STATUS.AWAITING_REVIEW, 'cổng duyệt không được biến job thành failed');
    assert.deepEqual(await store.listImageAssets(jobId, { role: 'rendered' }), []);
    await store.close();
  });

  test('force = true → render chạy được và để lại vết meta.forced', async () => {
    const { pipeline, store, jobId } = await prepared();
    await store.saveTranslationLines(jobId, [
      line('r2', { text_vi: 'Áo thun cotton', text_original: '纯棉短袖T恤' }),
      line('r1', { text_vi: 'Nhãn hiệu X', text_original: '品牌旗舰店', status: 'NEEDS_REVIEW', violations: ['cần người duyệt'] }),
    ]);

    const res = await pipeline.renderApproved(jobId, { sessionId: 's', force: true });
    assert.equal(res.status, JOB_STATUS.SUCCEEDED);
    assert.ok(res.asset.meta.forced, 'phải ghi lý do force vào meta ảnh render');
    assert.match(String(res.asset.meta.forced), /force/i);
    assert.ok(res.warnings.some((w) => /force/i.test(w)));

    const job = await store.getJob(jobId);
    assert.equal(job.status, JOB_STATUS.SUCCEEDED);
    assert.equal(job.stage, 'done');
    assert.ok(job.finished_at);
    await store.close();
  });

  test('brand/certification/price KHÔNG BAO GIỜ vào danh sách op, dù DB khai TRANSLATED', async () => {
    const { pipeline, store, jobId, regions } = await prepared();
    // Trạng thái "xấu": mọi dòng đều TRANSLATED + có chữ Việt (như thể bị ghi đè sai).
    await store.saveTranslationLines(
      jobId,
      regions.map((r) => line(r.id, { text_original: r.text, text_vi: `Chữ Việt ${r.id}` })),
    );
    const stored = await store.listTranslationLines(jobId);
    assert.equal(stored.find((l) => l.region_id === 'r1').status, 'TRANSLATED', 'điều kiện test: dòng brand khai TRANSLATED');

    const res = await pipeline.renderApproved(jobId, { sessionId: 's' });
    const opIds = res.ops.map((o) => o.region_id);
    assert.deepEqual(opIds, ['r2'], `chỉ vùng mô tả được vẽ, nhận ${opIds.join(',')}`);
    for (const locked of ['r1', 'r3', 'r4']) {
      assert.ok(!opIds.includes(locked), `vùng ${locked} không được có op render`);
      const skipped = res.skipped.find((s) => s.region_id === locked);
      assert.ok(skipped, `vùng ${locked} phải có mặt trong skipped kèm lý do`);
      assert.match(skipped.reason, /luật #3|nhãn hiệu|chứng nhận|giá/i);
    }
    assert.ok(!JSON.stringify(res.asset.meta.applied).includes('"r1"'), 'meta.applied không được chứa vùng brand');
    await store.close();
  });

  test('render provider lỗi → job failed + error_code + finished_at (không treo rendering)', async () => {
    const { pipeline, store, jobId } = await prepared();
    await store.saveTranslationLines(jobId, [line('r2', { text_vi: 'Áo thun cotton', text_original: '纯棉短袖T恤' })]);
    pipeline.renderProvider = fakeRenderProvider({
      result: { status: 'FAILED', error_code: 'RENDER_BOOM', error_message: 'provider render nổ giả lập' },
    });

    const out = await pipeline.renderApproved(jobId, { sessionId: 's' });
    assert.equal(out.status, JOB_STATUS.FAILED);
    assert.equal(out.error_code, 'RENDER_BOOM');

    const job = await store.getJob(jobId);
    assert.equal(job.status, JOB_STATUS.FAILED);
    assert.equal(job.error_code, 'RENDER_BOOM');
    assert.ok(job.finished_at);
    assert.notEqual(job.status, JOB_STATUS.RUNNING);
    assert.deepEqual(await store.listImageAssets(jobId, { role: 'rendered' }), [], 'render lỗi thì không có ảnh mới');
    await store.close();
  });

  test('job chưa có dòng dịch → IMAGELAB_NO_LINES', async () => {
    const { pipeline, store, jobId } = await freshStack();
    await pipeline.ingest(jobId, { image: headphones(), sessionId: 's' });
    await assert.rejects(
      () => pipeline.renderApproved(jobId, { sessionId: 's' }),
      (err) => err.code === 'IMAGELAB_NO_LINES',
    );
    await store.close();
  });
});

describe('MVP-02 pipeline — bằng chứng, usage, ảnh gốc sau toàn luồng', () => {
  test('luồng đầy đủ: ảnh gốc KHÔNG đổi, ảnh render là bản ghi mới có parent_id', async () => {
    const { pipeline, store, storage, jobId } = await freshStack();
    const buf = headphones();
    const ingest = await pipeline.ingest(jobId, { image: buf, sessionId: 'session-pipeline-01' });
    const original = await store.getImageAsset(ingest.asset_id);
    const hashBefore = sha256(await storage.read(original));

    await pipeline.runOcr(jobId, { sessionId: 'session-pipeline-01' });
    const lines = await store.listTranslationLines(jobId);
    const renderable = lines.filter((l) => l.status === 'GLOSSARY' || l.status === 'TRANSLATED');
    assert.ok(renderable.length >= 1, 'fixture phải dịch được ít nhất một vùng mô tả');

    const res = await pipeline.renderApproved(jobId, { sessionId: 'session-pipeline-01' });
    assert.equal(res.status, JOB_STATUS.SUCCEEDED);

    // (1) Ảnh gốc trên đĩa không đổi
    assert.equal(sha256(await storage.read(original)), hashBefore, 'file ảnh gốc bị đổi sau khi render');
    assert.equal((await store.getImageAsset(original.id)).sha256, ingest.sha256);
    assert.ok((await storage.read(original)).equals(buf));

    // (2) Ảnh render là bản ghi MỚI
    const rendered = res.asset;
    assert.ok(rendered && rendered.id !== original.id);
    assert.equal(rendered.role, 'rendered');
    assert.equal(rendered.parent_id, original.id);
    assert.equal(rendered.job_id, jobId);
    assert.equal(rendered.source, 'render');
    assert.notEqual(rendered.sha256, original.sha256);
    assert.notEqual(rendered.storage_path, original.storage_path);
    assert.ok(await storage.exists(rendered));
    assert.equal(rendered.meta.is_mock, false, 'purejs là render thật');
    assert.equal(rendered.meta.status, 'OK');
    assert.ok(rendered.meta.applied.length >= 1);

    // (3) usage_event IMAGE_RENDER
    const usage = await store.listUsage(jobId);
    const ops = usage.map((e) => e.operation);
    assert.ok(ops.includes('OCR_DETECT'));
    assert.ok(ops.includes('IMAGE_RENDER'));
    const renderEvent = usage.find((e) => e.operation === 'IMAGE_RENDER');
    assert.equal(renderEvent.input_units, res.ops.length);
    assert.equal(renderEvent.output_units, rendered.meta.applied.length);

    // (4) Bằng chứng: MANUAL_INPUT, tuyệt đối không LIVE_VERIFIED
    const evidence = await store.getEvidence(jobId);
    assert.ok(evidence.length >= 1, 'phải có extraction_evidence');
    for (const row of evidence) {
      assert.equal(row.verification, 'MANUAL_INPUT');
      assert.notEqual(row.verification, 'LIVE_VERIFIED');
      assert.equal(row.connector, 'imagelab');
    }
    assert.ok(!JSON.stringify(evidence).includes('LIVE_VERIFIED'));
    await store.close();
  });

  test('provider mock ở mọi bước: nhãn MOCK được khai thật trong meta/evidence', async () => {
    const { pipeline, store, jobId } = await freshStack({ OCR_PROVIDER: 'mock', RENDER_PROVIDER: 'mock', TRANSLATE_PROVIDER: 'mock' });
    await pipeline.ingest(jobId, { image: headphones(), sessionId: 's' });
    await pipeline.runOcr(jobId, { sessionId: 's' });
    const renderable = (await store.listTranslationLines(jobId)).filter((l) => String(l.text_vi).trim() !== '');
    assert.ok(renderable.length >= 1, 'phải có dòng dịch được để render');
    await store.saveTranslationLines(jobId, renderable);

    const res = await pipeline.renderApproved(jobId, { sessionId: 's', force: true });
    assert.equal(res.asset.meta.is_mock, true, 'render provider mock PHẢI khai is_mock');
    assert.ok(res.mock_steps.includes('render'));

    const job = await store.getJob(jobId);
    assert.ok(job.content_meta.imagelab.mock_steps.length >= 1);
    const evidence = await store.getEvidence(jobId);
    assert.ok(evidence.some((e) => /MOCK/.test(e.blocked_reason || '')), 'phải ghi rõ bước nào chạy MOCK');
    for (const row of evidence) assert.notEqual(row.verification, 'LIVE_VERIFIED');
    await store.close();
  });

  test('storage chặn path traversal qua jobId/assetId', async () => {
    const config = imagelabConfig();
    const storage = createImageStorage(config, { logger: silent });
    await assert.rejects(() => storage.save({ jobId: '../../etc', assetId: 'a', ext: 'png', buffer: Buffer.from('x') }), /INVALID_ID|không hợp lệ/);
    await assert.rejects(() => storage.save({ jobId: 'ok', assetId: '../a', ext: 'png', buffer: Buffer.from('x') }), /INVALID_ID|không hợp lệ/);
    await assert.rejects(() => storage.read({ storage_path: '../../etc/passwd' }), /UNSAFE_PATH|không hợp lệ/);
    await assert.rejects(() => storage.read({ storage_path: 'mot-doan/passwd' }), /INVALID_PATH|thiếu phần mở rộng/);
    // Ghi hợp lệ thì nằm trong imagelab.dir của tmp
    const saved = await storage.save({ jobId: 'job1', assetId: 'asset1', ext: 'png', buffer: Buffer.from('abc') });
    assert.equal(saved.storage_path, 'job1/asset1.png');
    assert.ok(path.resolve(storage.dir, saved.storage_path).startsWith(`${path.resolve(storage.dir)}${path.sep}`));
    assert.equal(saved.sha256, sha256(Buffer.from('abc')));
  });
});

describe('MVP-02 pipeline — VÙNG BẢO VỆ + override có vết (F-01/F-02/F-06 hồi quy)', () => {
  const W = 320;
  const H = 320;
  const BRAND_BOX = { x: 40, y: 40, w: 200, h: 40 };
  const NESTED_BOX = { x: 30, y: 30, w: 240, h: 120 }; // bao quanh + lồng vùng brand

  /** Stack thật với 3 vùng: brand (bị bao quanh), mô tả CHỒNG brand, mô tả an toàn. */
  async function overlapStack() {
    const stack = await freshStack();
    const regions = [
      region({ id: 'r1', text: '品牌旗舰店', kind: 'brand', box: BRAND_BOX }),
      region({ id: 'r2', text: '纯棉短袖T恤', kind: 'descriptive', box: NESTED_BOX }),
      region({ id: 'r3', text: '厂家直销 一件代发', kind: 'descriptive', box: { x: 20, y: 200, w: 200, h: 40 } }),
    ];
    stack.pipeline.ocrProvider = fakeOcrProvider({ regions });
    await stack.pipeline.ingest(stack.jobId, { image: headphones(), sessionId: 's' });
    await stack.pipeline.runOcr(stack.jobId, { sessionId: 's' });
    return { ...stack, regions };
  }

  const rgbaOf = (buffer) => toRgba(decodePng(buffer));

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

  test('F-01: op của vùng mô tả CHỒNG hộp brand KHÔNG được dựng; pixel brand không đổi', async () => {
    const { pipeline, store, storage, jobId } = await overlapStack();
    await store.saveTranslationLines(jobId, [
      line('r1', { text_original: '品牌旗舰店', text_vi: '', status: 'SKIPPED_BRAND', provenance: 'none' }),
      line('r2', { text_original: '纯棉短袖T恤', text_vi: 'Áo thun cotton' }),
      line('r3', { text_original: '厂家直销 一件代发', text_vi: 'Nhà máy bán trực tiếp' }),
    ]);

    const res = await pipeline.renderApproved(jobId, { sessionId: 's' });
    assert.equal(res.status, JOB_STATUS.SUCCEEDED);
    assert.deepEqual(res.ops.map((o) => o.region_id), ['r3'], 'chỉ vùng KHÔNG giao vùng bảo vệ mới được dựng op');

    const skippedR2 = res.skipped.find((s) => s.region_id === 'r2');
    assert.ok(skippedR2, 'vùng chồng lấn phải vào skipped, không được im lặng');
    assert.match(skippedR2.reason, /^BOX_OVERLAPS_PROTECTED: r1 \(brand\)/);
    assert.ok(!JSON.stringify(res.asset.meta.applied).includes('"r2"'), 'meta.applied không được chứa vùng chồng lấn');

    // Bằng chứng PIXEL: ảnh render không được đổi một pixel nào trong hộp brand.
    const [original] = await store.listImageAssets(jobId, { role: 'original' });
    const before = rgbaOf(await storage.read(original));
    const after = rgbaOf(await storage.read(res.asset));
    assert.equal(diffInBox(before, after, BRAND_BOX), 0, 'pixel vùng nhãn hiệu phải NGUYÊN VẸN');
    assert.ok(diffInBox(before, after, { x: 20, y: 200, w: 200, h: 40 }) > 0, 'vùng an toàn vẫn phải được vẽ');
    await store.close();
  });

  test('F-02 (âm): dòng brand khai TRANSLATED + có chữ Việt nhưng KHÔNG có vết → không vẽ, pixel không đổi', async () => {
    const { pipeline, store, storage, jobId } = await overlapStack();
    await store.saveTranslationLines(jobId, [
      // Trạng thái "xấu": có chữ Việt, TRANSLATED, nhưng provenance = ai và không edited_by_user.
      line('r1', { text_original: '品牌旗舰店', text_vi: 'Chữ bịa không có vết' }),
      line('r3', { text_original: '厂家直销 一件代发', text_vi: 'Nhà máy bán trực tiếp' }),
    ]);

    const res = await pipeline.renderApproved(jobId, { sessionId: 's' });
    assert.ok(!res.ops.some((o) => o.region_id === 'r1'), 'vùng brand KHÔNG được vào op khi thiếu vết');
    assert.match(res.skipped.find((s) => s.region_id === 'r1').reason, /nhãn hiệu/i);
    assert.deepEqual(res.asset.meta.overrides, [], 'không có override nào được dùng');

    const [original] = await store.listImageAssets(jobId, { role: 'original' });
    const before = rgbaOf(await storage.read(original));
    const after = rgbaOf(await storage.read(res.asset));
    assert.equal(diffInBox(before, after, BRAND_BOX), 0);
    await store.close();
  });

  test('F-02 (dương): override CÓ VẾT → vùng brand được vẽ, có applied[].override + meta.overrides + warning', async () => {
    const { pipeline, store, storage, jobId } = await overlapStack();
    await store.saveTranslationLines(jobId, [
      line('r1', {
        text_original: '品牌旗舰店',
        text_vi: 'Thương hiệu ABC',
        status: 'USER_EDITED',
        provenance: 'user',
        edited_by_user: true,
        edited_at: '2026-10-03T00:00:00.000Z',
      }),
      line('r3', { text_original: '厂家直销 一件代发', text_vi: 'Nhà máy bán trực tiếp' }),
    ]);

    const res = await pipeline.renderApproved(jobId, { sessionId: 's' });
    assert.ok(res.ops.some((o) => o.region_id === 'r1'), 'override có vết PHẢI được dựng op');
    const appliedR1 = res.asset.meta.applied.find((a) => a.region_id === 'r1');
    assert.equal(appliedR1.override, true, 'applied của vùng override phải mang cờ override');

    assert.deepEqual(res.asset.meta.overrides, [
      { region_id: 'r1', kind: 'brand', edited_at: '2026-10-03T00:00:00.000Z' },
    ]);
    assert.ok(
      res.warnings.some((w) => /ĐÃ BỊ THAY CHỮ TRÊN ẢNH theo yêu cầu người dùng/.test(w)),
      'phải có cảnh báo tiếng Việt nói rõ vùng nhãn hiệu đã bị thay',
    );

    const [original] = await store.listImageAssets(jobId, { role: 'original' });
    const before = rgbaOf(await storage.read(original));
    const after = rgbaOf(await storage.read(res.asset));
    assert.ok(diffInBox(before, after, BRAND_BOX) > 0, 'override có vết phải thay được chữ trên ảnh');
    await store.close();
  });

  test('F-06: pendingReviewLines KHÔNG miễn trừ theo edited_by_user; SKIPPED_BY_USER không chặn', () => {
    const base = { region_id: 'r1', text_vi: '', status: 'NEEDS_REVIEW' };
    assert.equal(pendingReviewLines([{ ...base, edited_by_user: false }]).length, 1);
    assert.equal(
      pendingReviewLines([{ ...base, edited_by_user: true }]).length,
      1,
      'dòng bị guardrail chặn thì DÙ người dùng đã sửa vẫn phải chặn render',
    );
    assert.equal(pendingReviewLines([{ ...base, status: 'SKIPPED_BY_USER', edited_by_user: true }]).length, 0);
  });

  test('F-06: dòng NEEDS_REVIEW (đã sửa) → 409 REVIEW_REQUIRED; force → vào skipped + cảnh báo rõ', async () => {
    const { pipeline, store, jobId } = await overlapStack();
    await store.saveTranslationLines(jobId, [
      line('r3', { text_original: '厂家直销 一件代发', text_vi: 'Nhà máy bán trực tiếp' }),
      line('r2', {
        text_original: '纯棉短袖T恤',
        text_vi: 'Áo thun bảo hành 12 tháng',
        status: 'NEEDS_REVIEW',
        provenance: 'user',
        edited_by_user: true,
        violations: ['Số liệu “12” không có trong chữ gốc — không được tự thêm số.'],
      }),
    ]);

    await assert.rejects(
      () => pipeline.renderApproved(jobId, { sessionId: 's' }),
      (err) => err.code === 'REVIEW_REQUIRED',
    );

    const res = await pipeline.renderApproved(jobId, { sessionId: 's', force: true });
    assert.equal(res.status, JOB_STATUS.SUCCEEDED);
    const skippedR2 = res.skipped.find((s) => s.region_id === 'r2');
    assert.match(skippedR2.reason, /guardrail/i);
    assert.ok(
      res.warnings.some((w) => /bị guardrail chặn nên KHÔNG được vẽ/.test(w)),
      'force phải kèm cảnh báo nổi bật rằng dòng bị chặn không được vẽ',
    );
    await store.close();
  });

  test('F-06: dòng SKIPPED_BY_USER không chặn render và xuất hiện trong skipped với lý do rõ', async () => {
    const { pipeline, store, jobId } = await overlapStack();
    await store.saveTranslationLines(jobId, [
      line('r3', { text_original: '厂家直销 一件代发', text_vi: 'Nhà máy bán trực tiếp' }),
      line('r2', {
        text_original: '纯棉短袖T恤',
        text_vi: '',
        status: 'SKIPPED_BY_USER',
        provenance: 'user',
        edited_by_user: true,
        edited_at: '2026-10-03T00:00:00.000Z',
      }),
    ]);

    const res = await pipeline.renderApproved(jobId, { sessionId: 's' });
    assert.equal(res.status, JOB_STATUS.SUCCEEDED);
    assert.match(res.skipped.find((s) => s.region_id === 'r2').reason, /Người dùng đã bỏ qua/);
    await store.close();
  });
});
