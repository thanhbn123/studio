/**
 * TEST MVP-03 · E3 — PIPELINE (`src/imagestudio/pipeline.js`), hợp đồng §3.3 + §4.
 *
 * Chạy trên app THẬT: `createApp` (qua `startImagelabApp`), store SQLite in-memory, storage tmp,
 * provider mặc định `purejs` do `src/app.js` tự nối. Mọi khẳng định đọc dữ liệu THẬT đã lưu:
 * file trên đĩa, `image_assets`, `usage_events`, `extraction_evidence`, pixel ảnh ra.
 *
 * Ba luật MVP-03 được kiểm:
 *  1. ẢNH GỐC BẤT BIẾN (sha256 trên đĩa y hệt trước/sau) + ảnh ra CÙNG kích thước;
 *  2. nền sinh ra khai `synthetic: true` / `meta.synthetic_background`;
 *  3. fail-closed nhưng KHÔNG chết job: matting từ chối ⇒ `PARTIAL` + vẫn retouch + usage chỉ
 *     ghi operation THẬT SỰ chạy; không đổi gì ⇒ `NO_CHANGES` + KHÔNG lưu ảnh mới.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { sha256 } from '../src/imagelab/render/index.js';
import {
  ImageGenerationPipeline,
  ImageStudioError,
  IMAGESTUDIO_STAGES,
  IMAGESTUDIO_KIND,
  IMAGESTUDIO_CONNECTOR,
  IMAGESTUDIO_EXTRACTION_METHOD,
  IMAGESTUDIO_VERIFICATION,
  IMAGESTUDIO_NO_CHANGES,
  IMAGESTUDIO_PARTIAL,
  clampRetouchParams,
} from '../src/imagestudio/pipeline.js';
import { RETOUCH_LIMITS, clampRetouchParams as clampFromRetouch } from '../src/imagestudio/retouch/index.js';
import { USAGE_OPERATIONS, JOB_STATUS } from '../src/store/index.js';
import { startImagelabApp } from './imagelab-helpers.js';
import { productImage, noisyImage, pixelAt, pixelsOf, sizeOf } from './imagestudio-helpers.js';

const BOX = { x: 20, y: 20, w: 24, h: 24 };
const SESSION = 'imagestudio-pipeline-session-1';

describe('MVP-03 pipeline — ingest + generate trên app THẬT (purejs)', () => {
  let ctx;

  before(async () => {
    ctx = await startImagelabApp();
  });
  after(async () => {
    await ctx.close();
  });

  const newJob = () => ctx.store.createJob({ sessionId: SESSION, kind: IMAGESTUDIO_KIND });
  const onDisk = (asset) => fs.readFileSync(path.join(ctx.config.imagelab.dir, asset.storage_path));
  const usageOps = async (jobId) => (await ctx.store.listUsage(jobId)).map((u) => u.operation).sort();

  test('job chạy trọn: succeeded + ảnh rendered có parent_id = ảnh gốc, ảnh gốc BẤT BIẾN', async () => {
    // App THẬT tự nối provider mặc định — không test nào bơm provider giả vào đường này.
    assert.equal(ctx.app.mattingProvider.name, 'purejs');
    assert.equal(ctx.app.mattingProvider.isMock, false);
    assert.equal(ctx.app.retouchProvider.name, 'purejs');
    assert.ok(ctx.app.imagestudioPipeline instanceof ImageGenerationPipeline);

    const jobId = await newJob();
    const input = productImage({ box: BOX });

    const ingest = await ctx.app.imagestudioPipeline.ingest(jobId, {
      image: { buffer: input, filename: 'san-pham.png' },
      sessionId: SESSION,
    });
    assert.ok(ingest.asset_id, 'ingest phải trả asset_id THẬT');
    assert.equal(ingest.width, 64);
    assert.equal(ingest.height, 64);
    assert.equal(ingest.sha256, sha256(input));

    const original = await ctx.store.getImageAsset(ingest.asset_id);
    const diskBefore = sha256(onDisk(original));
    assert.equal(diskBefore, sha256(input));

    const result = await ctx.app.imagestudioPipeline.generate(jobId, { sessionId: SESSION, options: { template: 'trang' } });

    assert.equal(result.status, JOB_STATUS.SUCCEEDED);
    assert.equal(result.error_code, null);
    assert.equal(result.stage, 'done');
    assert.ok(result.asset, 'phải có ảnh MỚI');
    assert.equal(result.asset.role, 'rendered');
    assert.equal(result.asset.parent_id, original.id, 'ảnh ra phải trỏ về ảnh gốc');
    assert.equal(result.asset.mime, 'image/png');
    assert.equal(result.asset.width, 64);
    assert.equal(result.asset.height, 64);

    // (1) Ảnh ra CÙNG kích thước ảnh gốc.
    assert.deepEqual([result.asset.width, result.asset.height], [original.width, original.height]);
    assert.deepEqual(sizeOf(onDisk(result.asset)), { width: 64, height: 64, mime: 'image/png' });
    assert.equal(result.asset.sha256, sha256(onDisk(result.asset)));

    // (2) Meta đã lưu đúng hợp đồng §3.3.
    assert.equal(result.asset.meta.kind, IMAGESTUDIO_KIND);
    assert.deepEqual(
      { id: result.asset.meta.template.id, synthetic: result.asset.meta.template.synthetic },
      { id: 'trang', synthetic: true },
    );
    assert.equal(result.asset.meta.synthetic_background, true, 'nền ghép từ mẫu ⇒ phải khai MÔ PHỎNG');
    assert.ok(result.asset.meta.retouch_effective, 'phải ghi tham số hiệu lực');

    // (3) ẢNH GỐC BẤT BIẾN: file trên đĩa + sha trong DB y hệt trước/sau.
    assert.equal(sha256(onDisk(original)), diskBefore, 'file ảnh gốc trên đĩa KHÔNG được đổi');
    const originalAfter = await ctx.store.getImageAsset(original.id);
    assert.equal(originalAfter.sha256, original.sha256);
    assert.equal(originalAfter.storage_path, original.storage_path);

    // (4) Job kết thúc sạch.
    const job = await ctx.store.getJob(jobId);
    assert.equal(job.status, JOB_STATUS.SUCCEEDED);
    assert.equal(job.stage, 'done');
    assert.ok(job.finished_at, 'job xong phải có finished_at');
    assert.equal(job.kind, IMAGESTUDIO_KIND);

    // (5) Pixel: vùng nền = nền MÔ PHỎNG, vùng sản phẩm y hệt ảnh gốc.
    assert.deepEqual(pixelAt(onDisk(result.asset), 0, 0), [255, 255, 255, 255]);
    assert.deepEqual(pixelAt(onDisk(result.asset), 30, 30), pixelAt(input, 30, 30));

    // (6) Usage: chỉ 2 bước THẬT SỰ chạy (không retouch ⇒ KHÔNG có IMAGE_RETOUCH).
    assert.deepEqual(await usageOps(jobId), ['IMAGE_COMPOSE', 'IMAGE_MATTING']);

    // (7) Evidence: MANUAL_INPUT, không bao giờ LIVE_VERIFIED.
    const evidence = await ctx.store.getEvidence(jobId);
    assert.ok(evidence.length >= 1);
    for (const row of evidence) {
      assert.equal(row.connector, IMAGESTUDIO_CONNECTOR);
      assert.equal(row.extraction_method, IMAGESTUDIO_EXTRACTION_METHOD);
      assert.equal(row.verification, IMAGESTUDIO_VERIFICATION);
    }
    assert.ok(!JSON.stringify(evidence).includes('LIVE_VERIFIED'));
  });

  test('nền NHIỄU ⇒ PARTIAL + cảnh báo + VẪN retouch + usage CHỈ IMAGE_RETOUCH', async () => {
    const jobId = await newJob();
    const input = noisyImage();
    await ctx.app.imagestudioPipeline.ingest(jobId, { image: { buffer: input }, sessionId: SESSION });

    const result = await ctx.app.imagestudioPipeline.generate(jobId, {
      sessionId: SESSION,
      options: { template: 'xam-nhat', retouch: { saturation: 0.2 } },
    });

    assert.equal(result.status, IMAGESTUDIO_PARTIAL, 'không được báo succeeded khi tách nền thất bại');
    assert.equal(result.error_code, 'UNIFORM_BACKGROUND_NOT_FOUND');
    assert.equal(result.matting.status, 'UNIFORM_BACKGROUND_NOT_FOUND');
    assert.equal(result.compose.applied, false, 'không có mask ⇒ KHÔNG ghép nền');
    assert.equal(result.synthetic_background, false);
    assert.equal(result.retouch.status, 'OK', 'vẫn phải retouch trên ẢNH GỐC');
    assert.equal((await ctx.store.getJob(jobId)).content_meta.imagestudio.retouched, true, 'phải ghi vết ĐÃ retouch thật');
    assert.ok(
      result.warnings.some((w) => w.includes('Không tách được nền')),
      'phải nói thẳng là không tách được nền',
    );
    assert.ok(
      result.warnings.some((w) => w.includes('Vẫn chạy retouch trên ẢNH GỐC')),
      'phải nói rõ vẫn retouch trên ảnh gốc',
    );

    // Usage: KHÔNG được bịa IMAGE_MATTING / IMAGE_COMPOSE khi bước đó không chạy.
    assert.deepEqual(await usageOps(jobId), ['IMAGE_RETOUCH']);
    const job = await ctx.store.getJob(jobId);
    assert.equal(job.status, IMAGESTUDIO_PARTIAL);
    assert.ok(job.finished_at, 'PARTIAL vẫn phải có finished_at');
    assert.notEqual(job.stage, 'matting', 'không được treo ở giữa luồng');
    assert.equal(job.stage, 'done');

    // Ảnh gốc vẫn y hệt ảnh người dùng tải lên (retouch chỉ tạo ảnh MỚI).
    const original = (await ctx.store.listImageAssets(jobId, { role: 'original' }))[0];
    assert.equal(sha256(onDisk(original)), sha256(input));
  });

  test('retouch VƯỢT NGƯỠNG ⇒ meta.retouch_effective nằm TRONG ngưỡng + có clamped', async () => {
    const jobId = await newJob();
    await ctx.app.imagestudioPipeline.ingest(jobId, { image: { buffer: productImage({ box: BOX }) }, sessionId: SESSION });

    const result = await ctx.app.imagestudioPipeline.generate(jobId, {
      sessionId: SESSION,
      options: { template: 'san-go', retouch: { brightness: 5, sharpen: -9 } },
    });

    assert.equal(result.asset.meta.retouch_effective.brightness, RETOUCH_LIMITS.brightness);
    assert.equal(result.asset.meta.retouch_effective.sharpen, -RETOUCH_LIMITS.sharpen);
    for (const [name, limit] of Object.entries(RETOUCH_LIMITS)) {
      assert.ok(Math.abs(result.asset.meta.retouch_effective[name]) <= limit, `${name} vượt ngưỡng đã lưu`);
    }
    assert.deepEqual([...result.asset.meta.retouch_clamped].sort(), ['brightness', 'sharpen']);
    assert.ok(result.warnings.some((w) => w.includes('KẸP')), 'phải có cảnh báo nói rõ bị kẹp');
    assert.deepEqual(await usageOps(jobId), ['IMAGE_COMPOSE', 'IMAGE_MATTING', 'IMAGE_RETOUCH']);
  });

  test('không đổi gì ⇒ PARTIAL + error_code NO_CHANGES + KHÔNG lưu ảnh mới', async () => {
    const jobId = await newJob();
    await ctx.app.imagestudioPipeline.ingest(jobId, { image: { buffer: noisyImage() }, sessionId: SESSION });

    const result = await ctx.app.imagestudioPipeline.generate(jobId, { sessionId: SESSION, options: { template: 'trang' } });

    assert.equal(result.status, IMAGESTUDIO_PARTIAL);
    assert.equal(result.error_code, IMAGESTUDIO_NO_CHANGES);
    assert.equal(result.asset, null, 'KHÔNG được lưu ảnh mới');
    assert.deepEqual(await ctx.store.listImageAssets(jobId, { role: 'rendered' }), []);
    assert.deepEqual(await usageOps(jobId), [], 'không bước nào chạy ⇒ không usage nào');
    const job = await ctx.store.getJob(jobId);
    assert.equal(job.error_code, IMAGESTUDIO_NO_CHANGES);
    assert.equal(job.status, IMAGESTUDIO_PARTIAL);
    assert.ok(job.finished_at);
  });

  test('overlay bị CHẶN ⇒ PARTIAL, KHÔNG vẽ pixel nào (sha y hệt bản đối chứng không overlay)', async () => {
    const input = productImage({ box: BOX });
    const run = async (options) => {
      const jobId = await newJob();
      await ctx.app.imagestudioPipeline.ingest(jobId, { image: { buffer: input }, sessionId: SESSION });
      const result = await ctx.app.imagestudioPipeline.generate(jobId, { sessionId: SESSION, options });
      return { jobId, result };
    };

    const control = await run({ template: 'trang' });
    const blocked = await run({ template: 'trang', overlay: { text: 'Bảo hành 12 tháng', x: 2, y: 2, size: 10 } });

    assert.equal(control.result.status, JOB_STATUS.SUCCEEDED);
    assert.ok(blocked.result.asset, 'phần ghép nền vẫn phải được lưu');
    assert.equal(blocked.result.overlay.applied, false);
    assert.equal(blocked.result.overlay.reason, 'OVERLAY_UNSUPPORTED_CLAIM');
    assert.ok(blocked.result.overlay.violations.length > 0, 'phải kèm danh sách vi phạm');
    assert.equal(blocked.result.status, IMAGESTUDIO_PARTIAL);
    assert.equal(blocked.result.error_code, 'OVERLAY_UNSUPPORTED_CLAIM');
    assert.equal(
      blocked.result.asset.sha256,
      control.result.asset.sha256,
      'overlay bị chặn ⇒ ảnh ra phải Y HỆT bản không overlay (không vẽ một pixel nào)',
    );
    assert.equal(blocked.result.asset.meta.overlay.applied, false);
    assert.ok(
      blocked.result.warnings.some((w) => w.includes('KHÔNG vẽ overlay')),
      'cảnh báo phải nói rõ không vẽ overlay',
    );
  });

  test('overlay HỢP LỆ (có bằng chứng) ⇒ applied = true + có pixel đổi trong hộp', async () => {
    const jobId = await newJob();
    const input = productImage({ box: BOX });
    const ingest = await ctx.app.imagestudioPipeline.ingest(jobId, { image: { buffer: input }, sessionId: SESSION });
    const result = await ctx.app.imagestudioPipeline.generate(jobId, {
      sessionId: SESSION,
      options: {
        template: 'trang',
        overlay: { text: 'Tai nghe', x: 2, y: 2, w: 40, h: 20, size: 10, color: '#000000', source_text: 'Tai nghe Bluetooth' },
      },
    });

    assert.equal(result.overlay.applied, true);
    assert.equal(result.asset.meta.overlay.applied, true);
    const originalFile = onDisk(await ctx.store.getImageAsset(ingest.asset_id));
    assert.equal(sha256(originalFile), sha256(input), 'ảnh gốc vẫn bất biến');
    const out = pixelsOf(onDisk(result.asset));
    const src = pixelsOf(input);
    let changedInBox = 0;
    for (let y = 2; y < 22; y += 1) {
      for (let x = 2; x < 42; x += 1) {
        const i = (y * 64 + x) * 4;
        if (out.data[i] !== src.data[i] || out.data[i + 1] !== src.data[i + 1] || out.data[i + 2] !== src.data[i + 2]) changedInBox += 1;
      }
    }
    assert.ok(changedInBox > 0, 'overlay hợp lệ phải vẽ được pixel thật');
  });

  test('job lỗi: chưa ingest ⇒ failed + error_code + finished_at (KHÔNG treo running)', async () => {
    const jobId = await newJob();
    await assert.rejects(
      () => ctx.app.imagestudioPipeline.generate(jobId, { sessionId: SESSION, options: {} }),
      (err) => err instanceof ImageStudioError && err.code === 'IMAGESTUDIO_NO_ASSET',
    );
    const job = await ctx.store.getJob(jobId);
    assert.equal(job.status, JOB_STATUS.FAILED);
    assert.equal(job.error_code, 'IMAGESTUDIO_NO_ASSET');
    assert.equal(job.stage, 'failed');
    assert.ok(job.finished_at, 'job lỗi PHẢI có finished_at');
  });

  test('job lỗi: ảnh gốc bị đổi trên đĩa ⇒ dừng, báo ORIGINAL_HASH_MISMATCH, không lưu ảnh mới', async () => {
    const jobId = await newJob();
    const ingest = await ctx.app.imagestudioPipeline.ingest(jobId, {
      image: { buffer: productImage({ box: BOX }) },
      sessionId: SESSION,
    });
    const original = await ctx.store.getImageAsset(ingest.asset_id);
    const file = path.join(ctx.config.imagelab.dir, original.storage_path);
    fs.writeFileSync(file, productImage({ box: BOX, rgba: [1, 2, 3, 255] })); // giả lập đĩa bị sửa

    await assert.rejects(
      () => ctx.app.imagestudioPipeline.generate(jobId, { sessionId: SESSION, options: { template: 'trang' } }),
      (err) => err instanceof ImageStudioError && err.code === 'ORIGINAL_HASH_MISMATCH',
    );
    const job = await ctx.store.getJob(jobId);
    assert.equal(job.status, JOB_STATUS.FAILED);
    assert.equal(job.error_code, 'ORIGINAL_HASH_MISMATCH');
    assert.ok(job.finished_at);
    assert.deepEqual(await ctx.store.listImageAssets(jobId, { role: 'rendered' }), []);
  });

  test('hai lượt generate ⇒ ảnh MỚI, ảnh cũ VẪN CÒN (chỉ ghi thêm, không ghi đè)', async () => {
    const jobId = await newJob();
    await ctx.app.imagestudioPipeline.ingest(jobId, { image: { buffer: productImage({ box: BOX }) }, sessionId: SESSION });
    const first = await ctx.app.imagestudioPipeline.generate(jobId, { sessionId: SESSION, options: { template: 'trang' } });
    const second = await ctx.app.imagestudioPipeline.generate(jobId, { sessionId: SESSION, options: { template: 'gradient-xanh' } });

    assert.notEqual(first.asset.id, second.asset.id);
    const rendered = await ctx.store.listImageAssets(jobId, { role: 'rendered' });
    assert.equal(rendered.length, 2, 'cả hai ảnh đều còn trong lịch sử');
    assert.deepEqual(rendered.map((a) => a.parent_id), [first.original_asset.id, first.original_asset.id]);
    assert.notEqual(first.asset.sha256, second.asset.sha256, 'hai mẫu nền khác nhau ⇒ hai ảnh khác nhau');
    assert.ok(second.warnings.some((w) => w.includes('ảnh MỚI')), 'phải nói rõ lượt này thêm ảnh mới');
  });

  test('hai lượt generate CHỒNG nhau ⇒ lượt sau bị chặn (IMAGESTUDIO_JOB_RUNNING), không ghi ảnh thứ hai', async () => {
    const jobId = await newJob();
    await ctx.app.imagestudioPipeline.ingest(jobId, { image: { buffer: productImage({ box: BOX }) }, sessionId: SESSION });

    // Khoá chống chạy chồng được đặt NGAY (đồng bộ) ở đầu `generate()` nên tất định, không flaky.
    const first = ctx.app.imagestudioPipeline.generate(jobId, { sessionId: SESSION, options: { template: 'trang' } });
    await assert.rejects(
      () => ctx.app.imagestudioPipeline.generate(jobId, { sessionId: SESSION, options: { template: 'trang' } }),
      (err) => err instanceof ImageStudioError && err.code === 'IMAGESTUDIO_JOB_RUNNING',
    );
    const done = await first;
    assert.equal(done.status, JOB_STATUS.SUCCEEDED);
    assert.equal((await ctx.store.listImageAssets(jobId, { role: 'rendered' })).length, 1, 'chỉ MỘT ảnh được ghi');
  });
});

describe('MVP-03 pipeline — hằng số hợp đồng', () => {
  test('IMAGESTUDIO_STAGES / KIND / evidence khớp §3.3', () => {
    assert.deepEqual(
      [...IMAGESTUDIO_STAGES],
      ['queued', 'storing', 'matting', 'composing', 'retouching', 'done', 'failed'],
    );
    assert.equal(IMAGESTUDIO_KIND, 'image_generation');
    assert.equal(IMAGESTUDIO_CONNECTOR, 'imagestudio');
    assert.equal(IMAGESTUDIO_EXTRACTION_METHOD, 'upload+generate');
    assert.equal(IMAGESTUDIO_VERIFICATION, 'MANUAL_INPUT');
  });

  test('USAGE_OPERATIONS có 3 operation MỚI và VẪN GIỮ mọi operation cũ', () => {
    for (const op of ['IMAGE_MATTING', 'IMAGE_COMPOSE', 'IMAGE_RETOUCH']) {
      assert.ok(USAGE_OPERATIONS.includes(op), `thiếu operation mới ${op}`);
    }
    for (const op of [
      'SOURCE_EXTRACT',
      'VISION_ANALYSIS',
      'TRANSLATION',
      'CONTENT_GENERATE',
      'CONTENT_REPAIR',
      'OCR_DETECT',
      'IMAGE_RENDER',
    ]) {
      assert.ok(USAGE_OPERATIONS.includes(op), `MẤT operation cũ ${op} — hồi quy MVP-01/MVP-02`);
    }
    assert.ok(Object.isFrozen(USAGE_OPERATIONS));
  });

  test('clampRetouchParams tái xuất ở pipeline là CÙNG một bản luật với tầng retouch', () => {
    assert.equal(clampRetouchParams, clampFromRetouch);
    const { params, clamped } = clampRetouchParams({ saturation: 9 });
    assert.deepEqual(clamped, ['saturation']);
    assert.equal(params.saturation, RETOUCH_LIMITS.saturation);
  });

  test('ImageGenerationPipeline thiếu store/storage ⇒ NOT_CONFIGURED (không chạy nửa vời)', async () => {
    const empty = new ImageGenerationPipeline({ config: {}, logger: null });
    await assert.rejects(
      () => empty.generate('00000000-0000-0000-0000-000000000000', {}),
      (err) => err.code === 'NOT_CONFIGURED',
    );
  });
});
