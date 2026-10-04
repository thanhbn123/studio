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
import { normalizeManualRegions, withKindDowngradeTrace } from '../src/imagelab/manual-regions.js';
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
      // IL08-07: câu chặn nay nêu ĐÚNG bước đang chạy (job này stage = 'ocr').
      (err) => err.code === 'IMAGELAB_JOB_RUNNING'
        && /chạy bước nhận dạng chữ \(OCR\)/.test(err.message)
        && /chờ bước này xong rồi hãy nhập vùng chữ/.test(err.message),
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

/* ═══════════════ VÒNG 7 — IL08-06 / IL08-07 ═══════════════ */

describe('IL08-06 — vết hạ mức bảo vệ phải BỀN và ĐỌC LẠI ĐƯỢC', () => {
  test('hàm thuần: vết nằm trong `kind_reason` nên đọc lại được từ bản ghi DB', () => {
    const out = normalizeManualRegions(
      [{ box: { x: 10, y: 10, w: 100, h: 20 }, text: PRICE_TEXT, kind: 'descriptive', allow_kind_downgrade: true }],
      { width: 200, height: 200, maxRegions: 5 },
    );
    const r = out.regions[0];
    assert.equal(r.kind, 'descriptive');
    assert.equal(r.kind_downgraded, true);
    assert.equal(r.kind_declared_by_user, 'descriptive');
    assert.equal(r.kind_classified_by_machine, 'price');
    assert.match(r.kind_reason, /NGƯỜI DÙNG HẠ MỨC từ price/);

    // Đọc lại y như thể vừa lấy từ DB (chỉ có `kind` + `kind_reason`).
    const traced = withKindDowngradeTrace({ id: r.id, kind: r.kind, kind_reason: r.kind_reason });
    assert.equal(traced.kind_downgraded, true);
    assert.equal(traced.kind_classified_by_machine, 'price');
    // Vùng KHÔNG hạ mức thì không được có vết (không bịa).
    assert.equal(withKindDowngradeTrace({ kind: 'descriptive', kind_reason: 'chữ mô tả thông thường' }).kind_downgraded, undefined);
  });

  test('API: vết ra tới response + content_meta, và CÒN sau lần lưu kế tiếp', async () => {
    const ctx = await startImagelabApp();
    try {
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: headphones().toString('base64') },
      }, SID));
      await waitJob(ctx.base, created.job_id, SID);

      const r1 = await j(await putJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/regions`, {
        regions: [{ box: { x: 10, y: 10, w: 100, h: 20 }, text: PRICE_TEXT, kind: 'descriptive', allow_kind_downgrade: true }],
        replace: true,
      }, SID));
      assert.equal(r1.regions[0].kind_downgraded, true, 'response phải mang vết ngay lượt lưu đầu');
      assert.equal(r1.regions[0].kind_declared_by_user, 'descriptive');
      assert.equal(r1.regions[0].kind_classified_by_machine, 'price');

      const meta1 = (await ctx.store.getJob(created.job_id)).content_meta?.imagelab;
      const list1 = meta1?.manual?.kind_downgrades || [];
      assert.equal(list1.length, 1, 'content_meta.imagelab.manual.kind_downgrades phải có vết');
      assert.equal(list1[0].kind_downgraded, true);
      assert.equal(list1[0].classified_by_machine, 'price');
      assert.ok(meta1.warnings.some((w) => /HẠ MỨC/.test(String(w))));

      // LƯU LẦN KẾ TIẾP (ghi thêm một vùng sạch) — vết của vùng cũ KHÔNG được biến mất.
      await putJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/regions`, {
        regions: [{ box: { x: 120, y: 150, w: 40, h: 15 }, text: DESC_TEXT, kind: 'descriptive' }],
        replace: false,
      }, SID);

      const meta2 = (await ctx.store.getJob(created.job_id)).content_meta?.imagelab;
      assert.equal((meta2?.manual?.kind_downgrades || []).length, 1, 'vết phải BỀN qua lần lưu sau');
      assert.ok(
        (meta2.warnings || []).some((w) => /vẫn đang ở mức/.test(String(w))),
        'lần lưu sau vẫn phải nhắc lại vết hạ mức còn hiệu lực',
      );

      // Người dùng MỞ LẠI trang: vết phải đọc được từ GET.
      const got = await j(await fetch(`${ctx.base}/api/imagelab/jobs/${created.job_id}`, { headers: cookie(SID) }));
      assert.equal((got.kind_downgrades || []).length, 1, 'GET phải trả vết có cấu trúc');
      const u1 = got.regions.find((r) => r.kind_downgraded === true);
      assert.ok(u1, 'GET phải trả vùng mang vết');
      assert.equal(u1.kind_classified_by_machine, 'price');
      assert.ok(got.regions.some((r) => r.kind_downgraded === undefined), 'vùng không hạ mức KHÔNG được gắn cờ');
    } finally {
      await ctx.close();
    }
  });
});

describe('IL08-07 — chẩn đoán đúng bước đang chạy + không chặn vĩnh viễn job kẹt', () => {
  test('có việc THẬT trong hàng đợi: 409 nêu đúng bước (không hardcode OCR/dịch)', async () => {
    const config = imagelabConfig();
    const store = await createStore(config, silent);
    const gated = gatedOcrProvider();
    const pipeline = new ImageTranslationPipeline({
      config,
      logger: silent,
      store,
      storage: createImageStorage(config, { logger: silent }),
      ocrProvider: gated.provider,
      translator: createTranslator(config, { logger: silent }),
      renderProvider: createRenderProvider(config, { logger: silent }),
    });
    const jobId = await store.createJob({ sessionId: SID, kind: 'image_translation' });
    await pipeline.ingest(jobId, { image: { base64: headphones().toString('base64') }, sessionId: SID });
    await store.updateJob(jobId, { status: 'running', stage: 'rendering' }); // job đang RENDER

    await assert.rejects(
      () => pipeline.setManualRegions(jobId, {
        sessionId: SID,
        regions: [{ box: { x: 5, y: 5, w: 50, h: 20 }, text: DESC_TEXT }],
        ocrPending: true, // hàng đợi CÓ việc thật
      }),
      (err) => err.code === 'IMAGELAB_JOB_RUNNING'
        && /chạy bước render ảnh/.test(err.message)
        && !/OCR\/dịch/.test(err.message),
      'câu chặn phải nêu đúng bước đang chạy',
    );
    await store.close();
  });

  test('job KẸT `running` mà hàng đợi rỗng (mồ côi) ⇒ CHO lưu + cảnh báo, không chặn vĩnh viễn', async () => {
    const ctx = await startImagelabApp();
    try {
      const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
        image: { base64: headphones().toString('base64') },
      }, SID));
      await waitJob(ctx.base, created.job_id, SID);

      // Mô phỏng tiến trình CHẾT giữa lúc OCR: DB nói đang chạy, hàng đợi KHÔNG còn việc nào.
      await ctx.store.updateJob(created.job_id, { status: 'running', stage: 'ocr' });
      assert.equal(ctx.app.queue.isPending(created.job_id), false, 'tiền đề: hàng đợi rỗng');

      const res = await putJson(ctx.base, `/api/imagelab/jobs/${created.job_id}/regions`, {
        regions: [{ box: { x: 5, y: 5, w: 50, h: 20 }, text: DESC_TEXT }],
      }, SID);
      assert.equal(res.status, 200, 'job mồ côi KHÔNG được chặn vĩnh viễn');
      const body = await j(res);
      assert.ok(
        body.warnings.some((w) => /HÀNG ĐỢI không còn việc nào/.test(String(w))),
        'phải NÓI THẬT là job mồ côi, không im lặng',
      );
      const regions = await ctx.store.listOcrRegions(created.job_id);
      assert.equal(regions.filter((r) => r.source === 'user').length, 1, 'dữ liệu người dùng phải được ghi');
      const job = await ctx.store.getJob(created.job_id);
      assert.equal(job.status, 'awaiting_review', 'job thoát khỏi trạng thái kẹt');
    } finally {
      await ctx.close();
    }
  });
});
