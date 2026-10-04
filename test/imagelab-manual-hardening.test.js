/**
 * TEST HỒI QUY — IL-08 vòng 6: vá 5 phát hiện của phản biện (IL08-01…IL08-05).
 *
 *   IL08-01  OCR đang chạy KHÔNG được ghi đè/xoá vùng nhập tay (2 tầng: 409 lúc đang chạy
 *            + `runOcr` đọc lại job trước khi ghi).
 *   IL08-02  `kind` do client khai chỉ được LEO THANG bảo vệ; muốn hạ phải có
 *            `allow_kind_downgrade` theo từng vùng + ghi vết.
 *   IL08-03  dấu vết OCR cũ sau khi bị thay phải được đánh dấu là LỊCH SỬ.
 *   IL08-04  trần vùng theo JOB (`options.max_regions`) phải được áp cho đường nhập tay.
 *   IL08-05  body vượt trần ⇒ JSON 413 (không phải ECONNRESET).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/store/index.js';
import { createImageStorage } from '../src/imagelab/storage.js';
import { createTranslator } from '../src/imagelab/translate/index.js';
import { createRenderProvider } from '../src/imagelab/render/index.js';
import { ImageTranslationPipeline } from '../src/imagelab/pipeline.js';
import { normalizeManualRegions } from '../src/imagelab/manual-regions.js';
import { silent } from './helpers.js';
import {
  cookie,
  headphones,
  imagelabConfig,
  j,
  postJson,
  putJson,
  startImagelabApp,
  waitJob,
} from './imagelab-helpers.js';

const SID = 'il08Round6SessionAAAA';
const PRICE_TEXT = '免运费'; // classifyRegion ⇒ price ⇒ KHOÁ (luật #3)
const DESC_TEXT = '纯棉短袖T恤'; // ⇒ descriptive ⇒ được dịch

/** OCR giả bị GIỮ ở cổng — để thứ tự "lưu vùng trước, OCR ghi sau" là CHẮC CHẮN, không may rủi. */
function gatedOcrProvider() {
  let release;
  let markStarted;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  return {
    release,
    started,
    provider: {
      name: 'gated-ocr',
      model: 'gated-1',
      isMock: true,
      configured: true,
      async detect() {
        markStarted();
        await gate;
        return {
          status: 'OK',
          provider: 'gated-ocr',
          model: 'gated-1',
          is_mock: true,
          regions: [{ text: '品牌旗舰店', box: { x: 10, y: 10, w: 100, h: 30 }, confidence: 0.9, lang: 'zh-Hans' }],
          dropped: [],
          warnings: [],
          usage: { input_units: 320 * 320, output_units: 1 },
          error_code: null,
          error_message: null,
        };
      },
    },
  };
}

describe('IL08-01 — job OCR đang chạy KHÔNG được xoá vùng nhập tay', () => {
  test('tầng (a): job đang chạy ⇒ 409 IMAGELAB_JOB_RUNNING và KHÔNG ghi gì', async () => {
    const config = imagelabConfig();
    const store = await createStore(config, silent);
    const storage = createImageStorage(config, { logger: silent });
    const gated = gatedOcrProvider();
    const pipeline = new ImageTranslationPipeline({
      config,
      logger: silent,
      store,
      storage,
      ocrProvider: gated.provider,
      translator: createTranslator(config, { logger: silent }),
      renderProvider: createRenderProvider(config, { logger: silent }),
    });
    const jobId = await store.createJob({ sessionId: SID, kind: 'image_translation' });
    await pipeline.ingest(jobId, { image: { base64: headphones().toString('base64') }, sessionId: SID });
    const ocrRun = pipeline.runOcr(jobId, { sessionId: SID }).catch((err) => err);
    await gated.started;

    const jobWhileRunning = await store.getJob(jobId);
    assert.equal(jobWhileRunning.status, 'running');

    await assert.rejects(
      () => pipeline.setManualRegions(jobId, {
        sessionId: SID,
        regions: [{ box: { x: 5, y: 5, w: 50, h: 20 }, text: DESC_TEXT }],
      }),
      (err) => err.code === 'IMAGELAB_JOB_RUNNING' && /chờ xong rồi hãy nhập vùng chữ/.test(err.message),
      'job đang chạy ⇒ phải TỪ CHỐI bằng IMAGELAB_JOB_RUNNING',
    );
    assert.deepEqual(await store.listOcrRegions(jobId), [], 'bị từ chối thì không được ghi vùng nào');

    gated.release();
    await ocrRun;
    const afterOcr = await store.listOcrRegions(jobId);
    assert.ok(afterOcr.length > 0 && afterOcr.every((r) => r.source === 'ocr'), 'OCR xong vẫn ghi bình thường');
    await store.close();
  });

  test('tầng (b): OCR chạy LẠI sau khi có vùng người dùng ⇒ không ghi đè + có cảnh báo + giữ awaiting_review', async () => {
    const ctx = await startImagelabApp();
    try {
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: headphones().toString('base64') },
      }, SID));
      await waitJob(ctx.base, created.job_id, SID);

      const saved = await putJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/regions`, {
        regions: [{ box: { x: 5, y: 5, w: 50, h: 20 }, text: DESC_TEXT }],
      }, SID);
      assert.equal(saved.status, 200);

      // OCR chạy lại trên job đã có vùng người dùng — mô phỏng lần ghi OCR đến muộn.
      await ctx.pipeline.runOcr(created.job_id, { sessionId: SID });

      const regions = await ctx.store.listOcrRegions(created.job_id);
      const job = await ctx.store.getJob(created.job_id);
      assert.equal(regions.filter((r) => r.source === 'user').length, 1, 'vùng người dùng KHÔNG được bị xoá');
      assert.ok(regions.some((r) => r.text === DESC_TEXT), 'chữ người dùng nhập phải còn');
      assert.equal(job.content_meta?.imagelab?.manual_regions, true, 'dấu vết manual_regions phải còn');
      assert.equal(job.status, 'awaiting_review', 'job vẫn ở trạng thái chờ duyệt');
      assert.ok(
        (job.content_meta?.imagelab?.warnings || []).some((w) => /KHÔNG ghi đè/.test(String(w))),
        'phải có cảnh báo nói rõ KHÔNG ghi đè',
      );
      assert.equal(job.content_meta?.imagelab?.ocr_superseded?.skipped_write, true, 'phải ghi vết lần OCR bị bỏ');
    } finally {
      await ctx.close();
    }
  });
});

describe('IL08-02 — kind client khai chỉ được LEO THANG bảo vệ', () => {
  const norm = (raw, maxRegions = 10) => normalizeManualRegions([raw], { width: 320, height: 320, maxRegions });

  test('khai `descriptive` cho chữ GIÁ ⇒ máy nâng lên `price`, KHÔNG dịch/không xoá pixel', () => {
    const out = norm({ box: { x: 10, y: 10, w: 100, h: 30 }, text: PRICE_TEXT, kind: 'descriptive' });
    assert.equal(out.regions.length, 1);
    assert.equal(out.regions[0].kind, 'price');
    assert.equal(out.regions[0].translatable, false, 'bất biến: translatable === (kind === descriptive)');
    assert.match(out.warnings.join(' '), /giữ mức BẢO VỆ CAO HƠN \(price\)/);
    assert.equal(out.regions[0].kind_downgraded, undefined, 'không có cờ thì KHÔNG được hạ');
  });

  test('không khai kind ⇒ y như cũ (máy tự phân loại)', () => {
    const out = norm({ box: { x: 10, y: 10, w: 100, h: 30 }, text: PRICE_TEXT });
    assert.equal(out.regions[0].kind, 'price');
    assert.deepEqual(out.warnings, []);
  });

  test('có `allow_kind_downgrade` ⇒ hạ được NHƯNG phải ghi vết + cảnh báo', () => {
    const out = norm({ box: { x: 10, y: 10, w: 100, h: 30 }, text: PRICE_TEXT, kind: 'descriptive', allow_kind_downgrade: true });
    assert.equal(out.regions[0].kind, 'descriptive');
    assert.equal(out.regions[0].translatable, true);
    assert.equal(out.regions[0].kind_downgraded, true);
    assert.equal(out.regions[0].kind_declared_by_user, 'descriptive');
    assert.match(out.warnings.join(' '), /HẠ MỨC bảo vệ/);
  });

  test('client khai mức CAO HƠN (brand) cho chữ mô tả ⇒ tôn trọng, không cảnh báo', () => {
    const out = norm({ box: { x: 10, y: 10, w: 100, h: 30 }, text: DESC_TEXT, kind: 'brand' });
    assert.equal(out.regions[0].kind, 'brand');
    assert.equal(out.regions[0].translatable, false);
    assert.deepEqual(out.warnings, []);
  });

  test('API: PUT vùng `免运费` khai descriptive ⇒ dòng bị KHOÁ (SKIPPED_PRICE), không có GLOSSARY', async () => {
    const ctx = await startImagelabApp();
    try {
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: headphones().toString('base64') },
      }, SID));
      await waitJob(ctx.base, created.job_id, SID);
      const res = await putJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/regions`, {
        regions: [{ box: { x: 10, y: 10, w: 100, h: 30 }, text: PRICE_TEXT, kind: 'descriptive' }],
      }, SID);
      assert.equal(res.status, 200);
      const body = await j(res);
      assert.equal(body.regions[0].kind, 'price');
      assert.equal(body.lines[0].status, 'SKIPPED_PRICE');
      assert.equal(body.lines[0].text_vi, '');
      assert.match(body.warnings.join(' '), /BẢO VỆ CAO HƠN/);
    } finally {
      await ctx.close();
    }
  });
});

describe('IL08-03 — dấu vết OCR cũ phải nói rõ đã bị thay', () => {
  test('GET job sau khi thay bằng vùng nhập tay ⇒ ocr.superseded_by_manual_regions = true + note', async () => {
    const ctx = await startImagelabApp();
    try {
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: headphones().toString('base64') },
      }, SID));
      await waitJob(ctx.base, created.job_id, SID);
      const saved = await putJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/regions`, {
        regions: [{ box: { x: 5, y: 5, w: 50, h: 20 }, text: DESC_TEXT }],
      }, SID);
      assert.equal(saved.status, 200);

      const got = await j(await fetch(`${ctx.base}/api/imagelab/jobs/${created.job_id}`, { headers: cookie(SID) }));
      assert.equal(got.ocr.superseded_by_manual_regions, true, 'cờ đã-bị-thay phải ra tới client');
      assert.match(String(got.ocr.note), /đã bị thay bởi vùng nhập tay/);
      assert.match(String(got.ocr.note), /KHÔNG mô tả vùng chữ đang có/);
    } finally {
      await ctx.close();
    }
  });
});

describe('IL08-04 — trần vùng theo JOB', () => {
  test('job khai options.max_regions = 1 ⇒ PUT 2 vùng nhập tay bị 413 (không nhận thêm)', async () => {
    const ctx = await startImagelabApp();
    try {
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: headphones().toString('base64') },
        options: { max_regions: 1 },
      }, SID));
      await waitJob(ctx.base, created.job_id, SID);
      // Trần của job phải được LƯU lại (nếu không, bước OCR xong là nó biến mất).
      const job = await ctx.store.getJob(created.job_id);
      assert.equal(job.content_meta?.imagelab?.limits?.max_regions, 1, 'trần theo job phải được ghi vào content_meta');

      const tooMany = await putJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/regions`, {
        regions: [
          { box: { x: 5, y: 5, w: 50, h: 20 }, text: DESC_TEXT },
          { box: { x: 60, y: 5, w: 50, h: 20 }, text: DESC_TEXT },
        ],
      }, SID);
      assert.equal(tooMany.status, 413);
      const body = await j(tooMany);
      assert.equal(body.error.code, 'TOO_MANY_REGIONS');
      assert.equal(body.error.details?.max_regions, 1);

      // Đúng 1 vùng thì vẫn nhận.
      const ok = await putJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/regions`, {
        regions: [{ box: { x: 5, y: 5, w: 50, h: 20 }, text: DESC_TEXT }],
      }, SID);
      assert.equal(ok.status, 200);
      assert.equal((await j(ok)).regions.length, 1);
    } finally {
      await ctx.close();
    }
  });
});

describe('IL08-05 — body vượt trần ⇒ JSON 413', () => {
  test('PUT .../regions với body ~600 KB ⇒ 413 PAYLOAD_TOO_LARGE (không reset kết nối)', async () => {
    const ctx = await startImagelabApp();
    try {
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: headphones().toString('base64') },
      }, SID));
      await waitJob(ctx.base, created.job_id, SID);

      const huge = 'x'.repeat(600 * 1024);
      const res = await fetch(`${ctx.base}/api/imagelab/jobs/${created.job_id}/regions`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...cookie(SID) },
        body: JSON.stringify({ regions: [{ box: { x: 1, y: 1, w: 10, h: 10 }, text: DESC_TEXT }], filler: huge }),
      });
      assert.equal(res.status, 413, 'phải trả JSON 413, không được ngắt kết nối');
      const body = await j(res);
      assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');

      // Server vẫn sống và dữ liệu job KHÔNG bị đụng.
      const after = await j(await fetch(`${ctx.base}/api/imagelab/jobs/${created.job_id}`, { headers: cookie(SID) }));
      assert.ok(after.job, 'server phải còn phục vụ sau khi từ chối body quá lớn');
    } finally {
      await ctx.close();
    }
  });
});
