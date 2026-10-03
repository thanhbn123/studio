/**
 * TEST HỒI QUY ĐỘC LẬP — F-03 (MAJOR) và F-04 (MINOR) sau phản biện.
 *
 * F-03: nhãn MOCK phải theo DẤU VẾT CỦA JOB. Dựng job bằng provider mock, rồi dựng
 *       app/server MỚI với provider thật trên CÙNG DB ⇒ `GET /api/imagelab/jobs/:id`
 *       vẫn trả `mock_steps` khác rỗng + `providers_snapshot` của lúc chạy, và UI thật
 *       (`renderIlWarnings` trích từ public/app.js) vẫn hiện cảnh báo MOCK.
 * F-04: session B gọi bốn route MVP-01 cũ trên job ImageLab của A ⇒ 404 ở TẤT CẢ,
 *       A vẫn 200; khách ẩn danh với job ImageLab cũng 404; job MVP-01 giữ nguyên hành vi.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { createApp } from '../src/app.js';
import { createStore } from '../src/store/index.js';
import { createImageStorage } from '../src/imagelab/storage.js';
import { createRenderProvider } from '../src/imagelab/render/index.js';
import { ImageTranslationPipeline } from '../src/imagelab/pipeline.js';
import { silent, testConfig, fakeVisionProvider, fakeContentEngine } from './helpers.js';
import {
  FakeImagelabConnector,
  cookie,
  headphones,
  j,
  postJson,
  putJson,
  startImagelabApp,
  tmpDir,
  waitJob,
} from './imagelab-helpers.js';
import { loadRenderIlWarnings } from './imagelab-ui-helpers.js';

const SID_A = 'f03SessionAAAA11112222';
const SID_B = 'f03SessionBBBB33334444';

const sharedDir = tmpDir('f03-shared-');
/** CÙNG DB + CÙNG thư mục ảnh cho cả hai máy chủ. */
const sharedConfig = () => testConfig({
  SQLITE_PATH: path.join(sharedDir, 'studio.db'),
  IMAGELAB_DIR: path.join(sharedDir, 'images'),
});

/** Dựng app THẬT với provider do test chỉ định (giống startImagelabApp nhưng không tự chọn provider). */
async function startAppWithProviders(config, providers = {}) {
  const store = await createStore(config, silent);
  const storage = createImageStorage(config, { logger: silent });
  const renderProvider = providers.renderProvider || createRenderProvider(config, { logger: silent });
  const pipeline = new ImageTranslationPipeline({
    config,
    logger: silent,
    store,
    storage,
    ocrProvider: providers.ocrProvider || null,
    translator: providers.translator || null,
    renderProvider,
  });
  const app = await createApp({
    config,
    logger: silent,
    store,
    connectors: [FakeImagelabConnector],
    visionProvider: fakeVisionProvider(),
    contentEngine: fakeContentEngine(),
    ocrProvider: providers.ocrProvider || null,
    translator: providers.translator || null,
    renderProvider,
    storage,
    imagelabPipeline: pipeline,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return {
    config,
    store,
    storage,
    pipeline,
    app,
    base: `http://127.0.0.1:${app.server.address().port}`,
    async close() {
      await app.close();
    },
  };
}

/** Translator "THẬT" (không mock) tối thiểu — đủ để app khởi động và tự khai is_mock = false. */
const realTranslatorStub = () => ({
  name: 'real-ai',
  model: 'real-model-1',
  configured: true,
  isMock: false,
  async translateRegions() {
    return {
      status: 'OK',
      provider: 'real-ai',
      model: 'real-model-1',
      is_mock: false,
      lines: [],
      warnings: [],
      usage: null,
      error_code: null,
      error_message: null,
    };
  },
});

/** OCR "THẬT" (không mock) tối thiểu. */
const realOcrStub = () => ({
  name: 'real-ocr',
  model: 'real-ocr-1',
  configured: true,
  isMock: false,
  async detect() {
    return { status: 'NO_TEXT', provider: 'real-ocr', model: 'real-ocr-1', is_mock: false, regions: [], dropped: [], warnings: [], usage: null, error_code: null, error_message: null };
  },
});

describe('MVP-02 F-03 · nhãn MOCK theo dấu vết của JOB, không theo cấu hình máy chủ', () => {
  let mockApp;
  let realApp;
  let jobId;

  before(async () => {
    // Máy chủ #1: provider MOCK (mặc định của bộ test) — tạo job.
    mockApp = await startImagelabApp({ config: sharedConfig() });
    const created = await j(await postJson(mockApp.base, '/api/imagelab/jobs', {
      image: { base64: headphones().toString('base64'), filename: 'tai-nghe.png' },
    }, SID_A));
    jobId = created.job_id;
    await waitJob(mockApp.base, jobId, SID_A);

    // Máy chủ #2: CÙNG DB + CÙNG thư mục ảnh, nhưng provider THẬT (is_mock = false).
    realApp = await startAppWithProviders(sharedConfig(), {
      ocrProvider: realOcrStub(),
      translator: realTranslatorStub(),
    });
  });

  after(async () => {
    if (realApp) await realApp.close();
    if (mockApp) await mockApp.close();
  });

  test('job chạy bằng provider mock: mock_steps đủ bước + providers_snapshot ghi lúc chạy', async () => {
    const res = await fetch(`${mockApp.base}/api/imagelab/jobs/${jobId}`, { headers: cookie(SID_A) });
    assert.equal(res.status, 200);
    const data = await j(res);
    assert.deepEqual(data.mock_steps, ['ocr', 'translate']);
    assert.equal(data.providers_snapshot.ocr.is_mock, true);
    assert.equal(data.providers_snapshot.translate.is_mock, true);
    assert.equal(data.providers_snapshot.ocr.name, 'mock');
    assert.ok(data.providers_snapshot.recorded_at, 'phải ghi thời điểm chạy');
    assert.equal(data.asset.meta.ocr.is_mock, true, 'meta ảnh gốc cũng phải là dấu vết thật');
    assert.equal(data.providers.render.is_mock, false, 'render purejs không phải mock');
  });

  test('máy chủ MỚI provider THẬT trên cùng DB: mock_steps vẫn khác rỗng, providers nói ngược lại', async () => {
    const res = await fetch(`${realApp.base}/api/imagelab/jobs/${jobId}`, { headers: cookie(SID_A) });
    assert.equal(res.status, 200);
    const data = await j(res);

    // Cấu hình HIỆN TẠI là provider thật…
    assert.equal(data.providers.ocr.is_mock, false);
    assert.equal(data.providers.ocr.name, 'real-ocr');
    assert.equal(data.providers.translate.is_mock, false);
    // …nhưng dấu vết của JOB vẫn nói sự thật.
    assert.deepEqual(data.mock_steps, ['ocr', 'translate'], 'mock_steps phải đọc từ job, không từ cấu hình');
    assert.equal(data.providers_snapshot.ocr.is_mock, true, 'snapshot phải là provider LÚC CHẠY');
    assert.equal(data.providers_snapshot.ocr.name, 'mock');
    assert.equal(data.asset.meta.ocr.is_mock, true);
  });

  test('UI thật (public/app.js) vẫn hiện cảnh báo MOCK cho job cũ', async () => {
    const data = await j(await fetch(`${realApp.base}/api/imagelab/jobs/${jobId}`, { headers: cookie(SID_A) }));
    const html = loadRenderIlWarnings()(data);
    assert.match(html, /MOCK — job này đã chạy/, 'UI phải hiện nhãn MOCK theo JOB');
    assert.match(html, /KHÔNG còn là mock/, 'UI phải nói rõ cấu hình hiện tại không còn là mock');
    assert.ok(!/LIVE_VERIFIED/.test(html), 'không bao giờ được có nhãn LIVE');
  });

  test('render trên máy chủ provider thật: job succeeded, render_summary.is_mock = false nhưng mock_steps giữ nguyên', async () => {
    const res = await postJson(realApp.base, `/api/imagelab/jobs/${jobId}/render`, {}, SID_A);
    assert.equal(res.status, 202);
    const done = await waitJob(realApp.base, jobId, SID_A);
    assert.equal(done.job.status, 'succeeded');
    assert.equal(done.render_summary.is_mock, false, 'render chạy bằng purejs (không mock)');
    assert.deepEqual(done.mock_steps, ['ocr', 'translate'], 'dấu vết mock của OCR/dịch vẫn phải còn');
    assert.equal(done.providers_snapshot.render.is_mock, false);
    assert.equal(done.providers_snapshot.render.status, 'OK');
    // UI sau render cũng vẫn phải cảnh báo MOCK theo job.
    assert.match(loadRenderIlWarnings()(done), /MOCK/);
  });
});

describe('MVP-02 F-04 · chặn truy cập job ImageLab qua route MVP-01 cũ', () => {
  let ctx;
  let jobId;
  let contentJobId;

  before(async () => {
    ctx = await startImagelabApp();
    const created = await j(await postJson(ctx.base, '/api/imagelab/jobs', {
      image: { base64: headphones().toString('base64') },
    }, SID_A));
    jobId = created.job_id;
    await waitJob(ctx.base, jobId, SID_A);
    // Job MVP-01 (không phải image_translation) để chứng minh hành vi cũ không đổi.
    contentJobId = await ctx.store.createJob({ sessionId: SID_A, source: '1688', kind: 'content' });
  });

  after(async () => {
    await ctx.close();
  });

  test('session B: GET job, PUT content, POST regenerate, GET usage → 404 hết', async () => {
    const cases = [
      ['GET /api/jobs/:id', () => fetch(`${ctx.base}/api/jobs/${jobId}`, { headers: cookie(SID_B) })],
      ['PUT /api/jobs/:id/content', () => putJson(ctx.base, `/api/jobs/${jobId}/content`, { headline: 'B SỬA TRỘM' }, SID_B)],
      ['POST /api/jobs/:id/regenerate', () => postJson(ctx.base, `/api/jobs/${jobId}/regenerate`, {}, SID_B)],
      ['GET /api/jobs/:id/usage', () => fetch(`${ctx.base}/api/jobs/${jobId}/usage`, { headers: cookie(SID_B) })],
    ];
    for (const [label, run] of cases) {
      const res = await run();
      assert.equal(res.status, 404, `${label} của session khác lệ ra phải 404, nhận ${res.status}`);
      const body = await j(res);
      assert.equal(body.error.code, 'JOB_NOT_FOUND');
    }
  });

  test('B KHÔNG ghi được gì: nội dung job của A vẫn nguyên', async () => {
    const before = await j(await fetch(`${ctx.base}/api/jobs/${jobId}`, { headers: cookie(SID_A) }));
    await putJson(ctx.base, `/api/jobs/${jobId}/content`, { headline: 'B SỬA TRỘM' }, SID_B);
    const after = await j(await fetch(`${ctx.base}/api/jobs/${jobId}`, { headers: cookie(SID_A) }));
    assert.deepEqual(after.content, before.content);
    assert.ok(!JSON.stringify(after).includes('B SỬA TRỘM'), 'không được lọt nội dung do B ghi');
  });

  test('session A vẫn 200 trên cả bốn route; regenerate của A đi tiếp tới lỗi nghiệp vụ (409)', async () => {
    assert.equal((await fetch(`${ctx.base}/api/jobs/${jobId}`, { headers: cookie(SID_A) })).status, 200);
    assert.equal((await fetch(`${ctx.base}/api/jobs/${jobId}/usage`, { headers: cookie(SID_A) })).status, 200);
    const put = await putJson(ctx.base, `/api/jobs/${jobId}/content`, { headline: 'A sửa nội dung' }, SID_A);
    assert.equal(put.status, 200);
    const regen = await postJson(ctx.base, `/api/jobs/${jobId}/regenerate`, {}, SID_A);
    assert.equal(regen.status, 409, 'A phải đi qua cửa kiểm quyền rồi mới tới lỗi nghiệp vụ NO_MASTER');
    assert.equal((await j(regen)).error.code, 'NO_MASTER');
  });

  test('khách ẩn danh (không cookie): job ImageLab → 404; job MVP-01 giữ nguyên hành vi cũ', async () => {
    assert.equal((await fetch(`${ctx.base}/api/jobs/${jobId}`)).status, 404, 'job ImageLab luôn đòi session khớp');
    assert.equal((await fetch(`${ctx.base}/api/jobs/${contentJobId}`)).status, 200, 'MVP-01 không cookie vẫn đọc được');
    assert.equal((await fetch(`${ctx.base}/api/jobs/${contentJobId}`, { headers: cookie(SID_B) })).status, 404);
  });
});
