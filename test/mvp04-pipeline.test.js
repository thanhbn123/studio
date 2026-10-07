/**
 * TEST — MVP-04 · V3 “Pipeline + store + wiring” (`src/videostudio/pipeline.js`, hợp đồng §2.3 + §3).
 *
 * Dựng APP THẬT (`createApp` + server thật, SQLite in-memory, provider offline) rồi chạy đúng
 * chuỗi `ingest → generate` của pipeline — không mock store/storage/encoder.
 *
 * Khoá lại:
 *   · job ẩn danh 1 ảnh ⇒ `succeeded`, asset `rendered` có `parent_id` + `mime = image/gif`, GIF
 *     hợp lệ theo `inspectGif`, ẢNH GỐC TRÊN ĐĨA BẤT BIẾN;
 *   · LUẬT 2: `audio = null` + ĐÚNG MỘT câu cảnh báo “KHÔNG có tiếng” (khử trùng V1/V3);
 *   · usage ĐÚNG 2 dòng `VIDEO_RENDER` + `VIDEO_ENCODE`, không có usage nào khác;
 *   · evidence `videostudio` / `upload+video` / `MANUAL_INPUT` — KHÔNG BAO GIỜ `LIVE_VERIFIED`;
 *   · LUẬT 3: chữ khẳng định thiếu bằng chứng ⇒ `VIDEO_TEXT_UNSUPPORTED_CLAIM`, job `failed` +
 *     `finished_at`, 0 asset video, 0 usage;
 *   · ảnh không phải PNG ⇒ fail-closed có mã lỗi;
 *   · `config.videostudio.enabled = false` ⇒ pipeline `null` nhưng MVP-01/02/03/05 vẫn boot.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { startImagelabApp, makeTestImage, tmpDir, j } from './imagelab-helpers.js';
import { testConfig, silent } from './helpers.js';
import { inspectGif, encodeGif } from '../src/videostudio/encode/index.js';
import {
  VideoStudioPipeline,
  VIDEOSTUDIO_KIND,
  VIDEOSTUDIO_UNAVAILABLE,
} from '../src/videostudio/pipeline.js';
import { VIDEO_AUDIO_WARNING } from '../src/videostudio/plan/index.js';

const SID = 'sess-mvp04-pipeline-0001';
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const png = (rgb, width = 120, height = 90) => makeTestImage({ width, height, background: [...rgb, 255] });

describe('MVP-04 · V3 — pipeline video (app thật + SQLite in-memory)', () => {
  let ctx;
  let jobId;
  let ingest;
  let original;
  let diskBefore;
  let diskAfter;
  let result;
  let job;
  let assets;
  let rendered;
  let usage;
  let evidence;

  before(async () => {
    ctx = await startImagelabApp({ configOverrides: { RATE_LIMIT_MAX_JOBS: '2000', RATE_LIMIT_MAX_REQUESTS: '20000' } });
    jobId = await ctx.store.createJob({ sessionId: SID, kind: VIDEOSTUDIO_KIND });
    ingest = await ctx.app.videostudioPipeline.ingest(jobId, { image: png([200, 30, 30]), sessionId: SID });
    original = await ctx.store.getImageAsset(ingest.asset_id);
    diskBefore = await ctx.storage.read(original);
    result = await ctx.app.videostudioPipeline.generate(jobId, {
      sessionId: SID,
      options: { preset: 'vuong-1x1', scenes: [{ duration_ms: 250, text: 'Ao thun nam' }] },
    });
    job = await ctx.store.getJob(jobId);
    assets = await ctx.store.listImageAssets(jobId, {});
    rendered = assets.filter((asset) => asset.role === 'rendered');
    usage = await ctx.store.listUsage(jobId);
    evidence = await ctx.store.getEvidence(jobId);
    diskAfter = await ctx.storage.read(original);
  });

  after(async () => {
    await ctx.close();
  });

  test('job ẩn danh 1 ảnh ⇒ succeeded, stage done, finished_at có thật', () => {
    assert.equal(result.status, 'succeeded', `generate phải thành công: ${JSON.stringify(result.error_code ?? '')}`);
    assert.equal(result.stage, 'done');
    assert.equal(result.error_code, null);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.stage, 'done');
    assert.equal(job.kind, VIDEOSTUDIO_KIND);
    assert.ok(job.finished_at, 'job kết thúc PHẢI có finished_at');
    assert.equal(job.session_id, SID);
    assert.equal(job.user_id, null, 'job ẩn danh ⇒ user_id null (luật #1: không ví)');
  });

  test('asset `rendered`: parent_id = ảnh gốc, mime image/gif, meta.audio = null, GIF hợp lệ theo inspectGif', async () => {
    assert.equal(rendered.length, 1, 'mỗi lượt tạo ĐÚNG một video (không ghi đè lượt cũ)');
    const out = rendered[0];
    assert.equal(out.parent_id, ingest.asset_id, 'parent_id phải trỏ ảnh gốc đầu tiên');
    assert.equal(out.mime, 'image/gif');
    assert.equal(out.role, 'rendered');
    assert.equal(out.source, 'generate');
    assert.equal(out.meta?.kind, VIDEOSTUDIO_KIND);
    assert.equal(out.meta?.audio, null, 'meta.audio phải là null (§0 luật 2)');
    assert.equal(out.meta?.scene_count, 1);
    assert.equal(out.meta?.preset?.id, 'vuong-1x1');
    assert.equal(out.parent_id, original.id);

    const buffer = await ctx.storage.read(out);
    assert.equal(buffer.length, out.bytes);
    assert.equal(sha256(buffer), out.sha256);
    const info = inspectGif(buffer);
    assert.equal(info.valid, true, `GIF lưu trên đĩa phải hợp lệ: ${JSON.stringify(info.errors)}`);
    assert.equal(info.version, '89a');
    assert.equal(info.width, 900);
    assert.equal(info.height, 900);
    assert.equal(info.frames, result.plan.frame_count, 'số khung GIF phải khớp plan');
    assert.equal(info.frames, 3, '1 cảnh × 250ms × 12fps = 3 khung');
    assert.equal(info.loop, 0);
  });

  test('ẢNH GỐC bất biến trên đĩa: sha256 lúc ingest = lúc generate xong = asset.sha256', () => {
    assert.equal(sha256(diskBefore), ingest.sha256);
    assert.equal(sha256(diskAfter), ingest.sha256, 'generate KHÔNG được sửa ảnh gốc (luật #1)');
    assert.equal(original.sha256, ingest.sha256);
    assert.equal(original.role, 'original');
    assert.equal(original.parent_id, null);
    assert.equal(original.meta?.scene_index, 0);
  });

  test('§0 luật 2: audio = null + ĐÚNG MỘT câu cảnh báo “KHÔNG có tiếng” (khử trùng V1/V3)', () => {
    assert.equal(result.audio, null);
    assert.equal(result.no_audio, true);
    assert.equal(result.plan.audio, null);
    assert.equal(rendered[0].meta?.no_audio, true);

    const warnings = result.warnings;
    assert.deepEqual(warnings, [...new Set(warnings)], `danh sách cảnh báo KHÔNG được trùng câu: ${JSON.stringify(warnings)}`);
    const noAudio = warnings.filter((w) => /KHÔNG có tiếng/i.test(String(w)));
    assert.equal(noAudio.length, 1, `đúng MỘT câu cảnh báo không tiếng, nhận ${JSON.stringify(noAudio)}`);
    // Câu của V3 thắng (nói rõ hệ quả + cách khắc phục) — câu của V1 bị quy về chính câu đó.
    assert.ok(!warnings.includes(VIDEO_AUDIO_WARNING), 'câu của V1 phải được quy về câu duy nhất của V3');
    assert.equal(noAudio[0], 'Video KHÔNG có tiếng (GIF không chứa âm thanh) — muốn có tiếng cần dịch vụ TTS/ffmpeg (chưa bật)');
  });

  test('usage ĐÚNG 2 dòng VIDEO_RENDER + VIDEO_ENCODE (và KHÔNG có usage nào khác)', () => {
    assert.deepEqual(
      usage.map((row) => row.operation).sort(),
      ['VIDEO_ENCODE', 'VIDEO_RENDER'],
      `chỉ hai bước chạy thật được ghi usage, nhận ${JSON.stringify(usage.map((r) => r.operation))}`,
    );
    const render = usage.find((row) => row.operation === 'VIDEO_RENDER');
    const encode = usage.find((row) => row.operation === 'VIDEO_ENCODE');
    assert.equal(render.input_units, 3, 'VIDEO_RENDER: input = số khung');
    assert.equal(render.output_units, 1, 'VIDEO_RENDER: output = 1 video');
    assert.equal(render.model, 'vuong-1x1');
    assert.equal(encode.input_units, 3, 'VIDEO_ENCODE: input = số khung');
    assert.equal(encode.output_units, rendered[0].bytes, 'VIDEO_ENCODE: output = số byte video');
    assert.equal(encode.model, 'image/gif');
    assert.equal(encode.provider, 'purejs');
    assert.equal(render.provider, 'purejs');
    assert.ok(usage.every((row) => row.job_id === jobId), 'usage phải gắn ĐÚNG job');
  });

  test('evidence: videostudio / upload+video / MANUAL_INPUT — KHÔNG BAO GIỜ LIVE_VERIFIED', () => {
    assert.ok(evidence.length >= 1, 'phải có bản ghi extraction_evidence');
    for (const row of evidence) {
      assert.equal(row.connector, 'videostudio');
      assert.equal(row.extraction_method, 'upload+video');
      assert.equal(row.verification, 'MANUAL_INPUT');
      assert.notEqual(row.verification, 'LIVE_VERIFIED');
    }
    const success = evidence.find((row) =>
      row.found_fields.some((field) => String(field).startsWith('image_asset:rendered')),
    );
    assert.ok(success, `phải có bản ghi evidence của lượt THÀNH CÔNG (có ảnh ra): ${JSON.stringify(evidence.map((r) => r.found_fields))}`);
    assert.ok(success.found_fields.includes('audio:none'));
    assert.ok(Number(success.bytes) > 0);
  });

  test('chữ khẳng định + bằng chứng RỖNG ⇒ VIDEO_TEXT_UNSUPPORTED_CLAIM, job failed + finished_at, 0 asset video, 0 usage', async () => {
    const claimJob = await ctx.store.createJob({ sessionId: SID, kind: VIDEOSTUDIO_KIND });
    await ctx.app.videostudioPipeline.ingest(claimJob, { image: png([10, 120, 60]), sessionId: SID });

    await assert.rejects(
      () =>
        ctx.app.videostudioPipeline.generate(claimJob, {
          sessionId: SID,
          options: { preset: 'vuong-1x1', scenes: [{ duration_ms: 250, text: 'Bảo hành 12 tháng' }] },
        }),
      (err) => {
        assert.equal(err.code, 'VIDEO_TEXT_UNSUPPORTED_CLAIM');
        assert.ok(Array.isArray(err.details?.violations) && err.details.violations.length > 0, 'lỗi phải kèm danh sách vi phạm');
        return true;
      },
    );

    const failed = await ctx.store.getJob(claimJob);
    assert.equal(failed.status, 'failed', 'job phải failed, KHÔNG treo running/queued');
    assert.equal(failed.error_code, 'VIDEO_TEXT_UNSUPPORTED_CLAIM');
    assert.ok(failed.finished_at, 'job lỗi PHẢI có finished_at');
    assert.equal(failed.content_meta?.videostudio?.audio, null, 'kể cả khi lỗi, audio vẫn phải null');

    const list = await ctx.store.listImageAssets(claimJob, {});
    assert.equal(list.filter((asset) => asset.role === 'rendered').length, 0, 'KHÔNG được lưu video nào (0 byte video)');
    assert.equal((await ctx.store.listUsage(claimJob)).length, 0, 'KHÔNG ghi usage cho lượt không chạy thật');
  });

  test('ảnh KHÔNG phải PNG ⇒ fail-closed có mã lỗi, job failed, KHÔNG lưu asset gốc', async () => {
    const badJob = await ctx.store.createJob({ sessionId: SID, kind: VIDEOSTUDIO_KIND });
    const gif = encodeGif({ frames: [Buffer.alloc(8 * 8 * 4, 255)], width: 8, height: 8, delayMs: 100 }).buffer;

    await assert.rejects(
      () => ctx.app.videostudioPipeline.ingest(badJob, { image: gif, sessionId: SID }),
      (err) => {
        assert.equal(err.code, 'UNSUPPORTED_IMAGE');
        assert.ok(String(err.message).includes('PNG'), 'thông báo phải nói rõ chỉ nhận PNG');
        return true;
      },
    );

    const failed = await ctx.store.getJob(badJob);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_code, 'UNSUPPORTED_IMAGE');
    assert.ok(failed.finished_at, 'ingest lỗi cũng phải có finished_at');
    assert.equal((await ctx.store.listImageAssets(badJob, {})).length, 0, 'ảnh sai định dạng KHÔNG được lưu');
  });

  test('encoder = null ⇒ generate fail-closed VIDEOSTUDIO_UNAVAILABLE (không bịa video)', async () => {
    const bare = new VideoStudioPipeline({
      config: ctx.config,
      logger: silent,
      store: ctx.store,
      storage: ctx.storage,
      encoder: null,
    });
    const bareJob = await ctx.store.createJob({ sessionId: SID, kind: VIDEOSTUDIO_KIND });
    await bare.ingest(bareJob, { image: png([90, 90, 10]), sessionId: SID });

    await assert.rejects(
      () => bare.generate(bareJob, { sessionId: SID, options: { preset: 'vuong-1x1' } }),
      (err) => err.code === VIDEOSTUDIO_UNAVAILABLE,
    );
    const failed = await ctx.store.getJob(bareJob);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_code, VIDEOSTUDIO_UNAVAILABLE);
    assert.ok(failed.finished_at);
    assert.equal((await ctx.store.listImageAssets(bareJob, {})).filter((a) => a.role === 'rendered').length, 0);
  });
});

describe('MVP-04 · V3 — tắt bằng cấu hình: pipeline null nhưng MVP-01/02/03/05 vẫn boot', () => {
  let ctx;

  before(async () => {
    const config = testConfig({ IMAGELAB_DIR: tmpDir('vps-vs-off-'), RATE_LIMIT_MAX_JOBS: '2000' });
    config.videostudio = { enabled: false };
    ctx = await startImagelabApp({ config });
  });

  after(async () => {
    await ctx.close();
  });

  test('app.videostudioPipeline = null; imagelab/imagestudio/content/ví+tài khoản vẫn nạp', () => {
    assert.equal(ctx.app.videostudioPipeline, null);
    assert.ok(ctx.app.videostudioUnavailableReason, 'phải có lý do thật cho UI');
    assert.ok(ctx.app.imagelabPipeline, 'MVP-02 vẫn phải nạp');
    assert.ok(ctx.app.imagestudioPipeline, 'MVP-03 vẫn phải nạp');
    assert.ok(ctx.app.contentEngine, 'MVP-01 vẫn phải nạp');
    assert.ok(ctx.app.accountService, 'MVP-05 (tài khoản) vẫn phải nạp');
    assert.ok(ctx.app.billingService, 'MVP-05 (ví) vẫn phải nạp');
  });

  test('/api/health và /api/config vẫn 200; config.videostudio.available = false', async () => {
    const health = await fetch(`${ctx.base}/api/health`);
    assert.equal(health.status, 200);
    const config = await j(await fetch(`${ctx.base}/api/config`));
    assert.equal(config.videostudio.available, false);
    assert.equal(config.videostudio.audio, false);
    assert.equal(config.imagelab.available, true, 'MVP-02 không được hồi quy');
    assert.equal(config.imagestudio.available, true, 'MVP-03 không được hồi quy');
    assert.equal(config.auth.available, true, 'MVP-05 không được hồi quy');
  });
});
