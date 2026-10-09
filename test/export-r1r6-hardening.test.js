/**
 * TEST MVP-06 · VÒNG VÁ R1…R6 — 6 phát hiện của vòng phản biện 2 (`docs/EXPORT-REVIEW.md` §6.2).
 *
 * Mỗi mục có test khẳng định ĐÚNG hành vi đã sửa, và cố ý dựng lại ĐÚNG dữ liệu dị dạng mà
 * script phản biện `/tmp/x-atk2/{b1-matrix,b3-zipnames}.mjs` đã dùng:
 *
 *   R1  `mockStepsFor` đọc cờ `is_mock` lồng trong `content_meta.imagelab.*` + CHỐT CHẶN: không
 *       bao giờ có `providers.*.is_mock = true` mà `mock_steps` rỗng (bí ⇒ `"unknown"` + chú thích).
 *   R2  cổng nhãn kiểm chứng CHUẨN HOÁ trước khi xét (`live_verified`, `LIVE_VERIFIED `, object
 *       `{level}`…); UI chỉ hiện badge XANH khi nhãn đã qua cổng + có bằng chứng `transport=http`.
 *   R3  mọi ký tự điều khiển Unicode trong tên entry ⇒ `BAD_ENTRY_NAME` kèm ký tự vi phạm.
 *   R4  HAI mã lỗi có lý do khác nhau (NUL ⇒ `ZIP_NAME_INVALID`, ký tự điều khiển khác ⇒
 *       `BAD_ENTRY_NAME`) — khớp hợp đồng §9.6 sau khi sửa.
 *   R5  `mock_steps=[null]` KHÔNG được hoá thành "KHÔNG có bước giả" (manifest ghi `"unknown"`,
 *       UI nói "KHÔNG kiểm được").
 *   R6  trần kích thước gói có cấu hình (`EXPORT_MAX_BUNDLE_BYTES`) ⇒ 413 `BUNDLE_TOO_LARGE` kèm
 *       SỐ ĐO; cổng giới hạn số lượt dựng gói đồng thời ⇒ 429 `EXPORT_BUSY`.
 *
 * File này CHỈ THÊM test (không sửa test cũ). Chạy: `node --test test/export-r1r6-hardening.test.js`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import {
  createExportGate,
  createZip,
  inspectZip,
  manifestFor,
  mockStepsFor,
  mockStepsFromProviders,
  normalizeVerificationLevel,
  normalizeZipName,
  providersFor,
  resolveExportLimits,
  verificationFor,
  DEFAULT_MAX_BUNDLE_BYTES,
  DEFAULT_MAX_CONCURRENT_BUNDLES,
  UNKNOWN_MOCK_STEP,
  usableMockSteps,
} from '../src/exports/index.js';
import { startExportApp, seedJob, cookie, j } from './export-helpers.js';
import { loadExportUi, makeUiState, makeDomStub } from './export-ui-helpers.js';

/* ═══════════════════════ R1 — mock_steps không mâu thuẫn providers ═══════════════════════ */

describe('R1 — mock_steps phải khớp providers.is_mock (không tự mâu thuẫn)', () => {
  const mkJob = (over = {}) => ({ id: 'job-r1', kind: 'image_translation', status: 'succeeded', ...over });
  const mkUsage = (operation, provider, meta = null) => ({ operation, provider, model: 'm-r1', meta: meta === null ? null : JSON.stringify(meta) });
  const manifestOf = ({ job = mkJob(), assets = [], usage = [], evidence = [] } = {}) =>
    manifestFor({ job, assets, lines: [], usage, evidence });

  /** Đếm MỌI đường dẫn có `is_mock === true` trong `providers` (giống bất biến của script b1). */
  const mockPaths = (providers) => {
    const out = [];
    const walk = (node, path) => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'is_mock' && value === true) out.push(path);
        else if (value && typeof value === 'object') walk(value, `${path}.${key}`);
      }
    };
    walk(providers, 'providers');
    return out;
  };

  test('đọc cờ is_mock LỒNG trong content_meta.imagelab.{ocr,translate,render} (ca G của b1)', () => {
    const m = manifestOf({
      job: mkJob({ content_meta: { imagelab: { ocr: { is_mock: true }, translate: { is_mock: true }, render: { is_mock: true } } } }),
    });
    assert.deepEqual(m.mock_steps, ['ocr', 'translate', 'render'], 'ba cờ lồng phải thành ba bước mock');
    assert.equal(m.providers.imagelab.ocr.is_mock, true);
    assert.equal(m.providers.imagelab.translate.is_mock, true);
    assert.equal(m.providers.imagelab.render.is_mock, true);
    assert.equal(m.verification_detail.contains_mock, true, 'contains_mock phải theo mock_steps');
    assert.equal(mockPaths(m.providers).length, 3);
  });

  test('BẤT BIẾN: providers có is_mock=true ⇒ mock_steps KHÔNG BAO GIỜ rỗng (ma trận 10 ca)', () => {
    const cases = {
      'content_meta.is_mock': { job: mkJob({ content_meta: { provider: 'mock', is_mock: true } }) },
      'content_meta.provider=mock (thiếu cờ)': { job: mkJob({ content_meta: { provider: 'mock', model: 'mock-1' } }) },
      'usage provider=mock': { usage: [mkUsage('OCR_DETECT', 'mock', { used: 1 })] },
      'usage openai + meta.is_mock': { usage: [mkUsage('CONTENT_GENERATE', 'openai', { is_mock: true })] },
      'imagelab.mock_steps': { job: mkJob({ content_meta: { imagelab: { mock_steps: ['ocr'] } } }) },
      'imagelab.ocr.is_mock': { job: mkJob({ content_meta: { imagelab: { ocr: { is_mock: true } } } }) },
      'imagestudio.matting.is_mock': { job: mkJob({ content_meta: { imagestudio: { providers: { matting: { is_mock: true } } } } }) },
      'videostudio.encoder.is_mock': { job: mkJob({ content_meta: { videostudio: { providers: { encoder: { is_mock: true } } } } }) },
      'asset meta.is_mock': { assets: [{ id: 'a-r1', role: 'rendered', meta: { is_mock: true } }] },
      'asset meta.generator.encoder_is_mock': { assets: [{ id: 'a-r1b', role: 'rendered', mime: 'video/mp4', meta: { kind: 'video_generation', generator: { encoder_is_mock: true } } }] },
    };
    for (const [label, params] of Object.entries(cases)) {
      const m = manifestOf(params);
      const flags = mockPaths(m.providers);
      assert.ok(
        flags.length === 0 || m.mock_steps.length > 0,
        `${label}: providers khai is_mock=true tại ${JSON.stringify(flags)} nhưng mock_steps=${JSON.stringify(m.mock_steps)}`,
      );
    }
  });

  test('bí bước cụ thể (usage provider=mock, operation rỗng) ⇒ "unknown" + cảnh báo, KHÔNG để rỗng', () => {
    const m = manifestOf({ usage: [mkUsage('', 'mock', null)] });
    assert.deepEqual(m.mock_steps, [UNKNOWN_MOCK_STEP]);
    assert.equal(m.verification_detail.contains_mock, true);
    assert.ok(
      m.warnings.some((w) => w.includes('unknown')),
      `phải có chú thích vì sao ghi "unknown": ${m.warnings.join(' · ')}`,
    );
    assert.equal(mockPaths(m.providers).length, 1);
  });

  test('hàm phụ trợ: mockStepsFromProviders + usableMockSteps xử lý dữ liệu dị dạng', () => {
    assert.deepEqual(mockStepsFromProviders(providersFor({ id: 'x', content_meta: { imagelab: { render: { is_mock: true } } } })).steps, ['render']);
    assert.equal(mockStepsFromProviders({ content: { is_mock: true } }).unknown, false);
    const weird = usableMockSteps([null, '', 'ocr', { step: 'render' }, 7]);
    assert.deepEqual(weird.steps, ['ocr', 'render']);
    assert.equal(weird.unusable, 3);
    assert.equal(weird.present, true);
    assert.deepEqual(usableMockSteps([]), { steps: [], unusable: 0, present: true });
    assert.equal(usableMockSteps(undefined).present, false);
    assert.deepEqual(mockStepsFor({ id: 'x', content_meta: { imagelab: { mock_steps: [null] } } }, [], []), [UNKNOWN_MOCK_STEP]);
  });
});

/* ═══════════════════════ R2 — cổng nhãn kiểm chứng ═══════════════════════ */

describe('R2 — nhãn kiểm chứng được CHUẨN HOÁ trước khi xét cổng', () => {
  const withHttp = { id: 'job-r2', kind: 'content', product_master: { extraction: { transport: 'http' } } };
  const noTransport = { id: 'job-r2b', kind: 'content' };

  test('nhãn không chuẩn KHÔNG lọt cổng khi thiếu bằng chứng transport', () => {
    const raws = ['live_verified', 'LIVE_VERIFIED ', '  Live_Verified  ', { level: 'LIVE_VERIFIED' }, { status: 'live_verified' }, { label: 'AUTHENTICATED_LIVE_VERIFIED' }];
    for (const raw of raws) {
      const { label, detail } = verificationFor(noTransport, [{ verification: raw }], []);
      assert.equal(label, null, `${JSON.stringify(raw)} KHÔNG được giữ nhãn LIVE khi thiếu transport`);
      assert.equal(detail.live_service_called, false);
      assert.ok(detail.notes.length >= 1, `${JSON.stringify(raw)}: bỏ nhãn phải kèm lý do`);
      assert.equal(detail.suggested_level, 'MOCK_VERIFIED');
      assert.equal(detail.contains_mock, false);
    }
  });

  test('có transport=http ⇒ nhãn chuẩn hoá VẪN được giữ (không bỏ oan)', () => {
    for (const raw of ['live_verified', ' LIVE_VERIFIED ', { level: 'live_verified' }, 'AUTHENTICATED_LIVE_VERIFIED']) {
      const { label, detail } = verificationFor(withHttp, [{ verification: raw }], []);
      assert.equal(label, typeof raw === 'string' && raw.trim().toUpperCase() === 'AUTHENTICATED_LIVE_VERIFIED' ? 'AUTHENTICATED_LIVE_VERIFIED' : 'LIVE_VERIFIED');
      assert.equal(detail.live_service_called, true);
      assert.equal(detail.suggested_level, null);
    }
  });

  test('object/kiểu lạ KHÔNG đọc được mức ⇒ không có nhãn + ghi rõ lý do (không tự dịch)', () => {
    for (const raw of [{}, { level: 42 }, { level: '  ' }, ['LIVE_VERIFIED'], true, 7]) {
      const { label, detail } = verificationFor(noTransport, [{ verification: raw }], []);
      assert.equal(label, null, `${JSON.stringify(raw)} không được thành nhãn`);
      assert.equal(detail.recorded_level_normalized, null);
      assert.ok(detail.notes.some((n) => n.includes('KHÔNG có nhãn')), `${JSON.stringify(raw)}: ${detail.notes.join(' · ')}`);
      assert.equal(detail.suggested_level, null, 'không đọc được mức thì cũng không được tự gợi mức');
    }
    assert.deepEqual(normalizeVerificationLevel({ level: 'LIVE_VERIFIED' }).level, 'LIVE_VERIFIED');
    assert.deepEqual(normalizeVerificationLevel(' live_verified ').level, 'LIVE_VERIFIED');
    assert.equal(normalizeVerificationLevel('   ').level, null);
    assert.equal(normalizeVerificationLevel(null).level, null);
  });

  test('gói thật: bằng chứng là OBJECT mà thiếu transport ⇒ verification=null, giữ nguyên bản để truy vết', () => {
    const m = manifestFor({ job: noTransport, evidence: [{ verification: { level: 'LIVE_VERIFIED' } }] });
    assert.equal(m.verification, null, 'không được khẳng định LIVE chỉ vì object có khoá level');
    assert.deepEqual(m.verification_detail.recorded_level, { level: 'LIVE_VERIFIED' });
    assert.equal(m.verification_detail.recorded_level_normalized, 'LIVE_VERIFIED');
    assert.equal(m.verification_detail.suggested_level, 'MOCK_VERIFIED');
    assert.ok(m.verification_detail.notes.some((n) => n.includes('OBJECT')));
  });

  test('UI: object/giá trị lạ KHÔNG thành badge; badge XANH chỉ khi QUA CỔNG', () => {
    const ui = loadExportUi(makeUiState());
    const objNoProof = ui.exportManifestHtml({
      manifest: { job: { id: 'job-r2' }, verification: { level: 'LIVE_VERIFIED' }, verification_detail: { live_service_called: false } },
    });
    assert.ok(!objNoProof.includes('badge ok'), 'object KHÔNG được tô badge XANH');
    assert.ok(objNoProof.includes('máy chủ không khai'), 'object ⇒ coi như KHÔNG có nhãn');
    assert.ok(objNoProof.includes('KHÔNG phải chuỗi'), 'phải ghi lý do vì sao không hiện nhãn');

    const strNoProof = ui.exportManifestHtml({
      manifest: { job: { id: 'job-r2' }, verification: 'LIVE_VERIFIED', verification_detail: { live_service_called: false } },
    });
    assert.ok(!strNoProof.includes('badge ok'), 'nhãn LIVE thiếu bằng chứng KHÔNG được tô XANH');
    assert.ok(strNoProof.includes('KHÔNG hiện badge LIVE'), 'phải ghi lý do không hiện badge');

    const proven = ui.exportManifestHtml({
      manifest: { job: { id: 'job-r2' }, verification: 'live_verified', verification_detail: { live_service_called: true } },
    });
    assert.ok(proven.includes('badge ok'), 'nhãn chuẩn hoá + bằng chứng transport=http ⇒ badge XANH');
    assert.ok(proven.includes('live_verified'), 'vẫn phải in nguyên văn nhãn máy chủ khai');
    assert.ok(proven.includes('CHUẨN HOÁ'), 'phải nói rõ nhãn đã được chuẩn hoá trước khi xét cổng');
  });
});

/* ═══════════════════════ R3/R4 — tên entry ═══════════════════════ */

describe('R3/R4 — ký tự điều khiển trong tên entry + hai mã lỗi có lý do', () => {
  const CONTROL_NAMES = [
    ['LF', 'a\nb.txt', 'U+000A'],
    ['CR', 'a\rb.txt', 'U+000D'],
    ['CRLF', 'a\r\nb.txt', 'U+000D'],
    ['NEL U+0085', 'a\u0085b.txt', 'U+0085'],
    ['LS U+2028', 'a\u2028b.txt', 'U+2028'],
    ['PS U+2029', 'a\u2029b.txt', 'U+2029'],
    ['VT \\x0b', 'a\x0bb.txt', 'U+000B'],
    ['FF \\x0c', 'a\x0cb.txt', 'U+000C'],
    ['ESC \\x1b', 'a\x1bb.txt', 'U+001B'],
    ['DEL \\x7f', 'a\x7fb.txt', 'U+007F'],
    ['RLO U+202E (giả đuôi)', 'anh-tao-1\u202egnp.exe', 'U+202E'],
    ['LRM U+200E (vô hình)', 'anh-tao-1\u200e.png', 'U+200E'],
    ['BOM U+FEFF', '\ufeffa.txt', 'U+FEFF'],
  ];

  test('MỌI ký tự điều khiển ⇒ BAD_ENTRY_NAME + details nêu ĐÚNG ký tự vi phạm', () => {
    for (const [label, name, codePoint] of CONTROL_NAMES) {
      assert.throws(
        () => normalizeZipName(name),
        (err) => {
          assert.equal(err.code, 'BAD_ENTRY_NAME', label);
          assert.equal(err.details.code_point, codePoint, `${label}: phải nêu đúng ký tự vi phạm`);
          assert.match(err.details.char, /^\\u[0-9A-F]{4}$/, label);
          assert.ok(Number.isInteger(err.details.position) && err.details.position >= 0, `${label}: phải nêu vị trí`);
          return true;
        },
        `${label} phải bị chặn`,
      );
      assert.throws(() => createZip({ entries: [{ name, data: 'x' }] }), (err) => err.code === 'BAD_ENTRY_NAME', `${label}: createZip cũng phải chặn`);
    }
  });

  test('R4 — HAI mã lỗi, lý do khác nhau: NUL ⇒ ZIP_NAME_INVALID, ký tự khác ⇒ BAD_ENTRY_NAME', () => {
    assert.throws(() => normalizeZipName('x\0y.txt'), (err) => err.code === 'ZIP_NAME_INVALID' && err.details.code_point === 'U+0000');
    for (const [, name] of CONTROL_NAMES) {
      assert.throws(() => normalizeZipName(name), (err) => err.code === 'BAD_ENTRY_NAME');
    }
  });

  test('KHÔNG chặn nhầm chữ có dấu / emoji (kể cả emoji ghép ZWJ) và ZIP vẫn hợp lệ', () => {
    const names = ['nội-dung/noi-dung.txt', 'anh/ảnh-gốc-1.png', 'video/😀-video-1.gif', 'video/👨‍👩‍👧-video-2.gif'];
    for (const name of names) assert.equal(normalizeZipName(name), name, `${name} phải được giữ nguyên`);
    const zip = createZip({ entries: names.map((name, i) => ({ name, data: `dữ liệu ${i}` })) });
    const check = inspectZip(zip);
    assert.equal(check.valid, true, check.errors.join(' · '));
    assert.deepEqual(check.entries.map((e) => e.name), names);
    // Bất biến R3: không tên nào còn ký tự khiến `splitlines()` (Python) tách thêm dòng giả.
    assert.equal(names.join('\n').split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).length, names.length);
  });
});

/* ═══════════════════════ R5 — mock_steps có phần tử nhưng không đọc được ═══════════════════════ */

describe('R5 — `mock_steps=[null]` không được hoá thành "KHÔNG có bước giả"', () => {
  test('manifest: mảng có phần tử nhưng không đọc được tên ⇒ "unknown" + cảnh báo', () => {
    const m = manifestFor({ job: { id: 'job-r5', kind: 'image_translation', content_meta: { imagelab: { mock_steps: [null, ''] } } } });
    assert.deepEqual(m.mock_steps, [UNKNOWN_MOCK_STEP]);
    assert.equal(m.verification_detail.contains_mock, true);
    assert.ok(m.warnings.some((w) => w.includes('unknown')));
  });

  test('manifest: mảng RỖNG thật thì vẫn là "không có bước giả" (không thêm nhiễu)', () => {
    const m = manifestFor({ job: { id: 'job-r5b', kind: 'content', content_meta: { imagelab: { mock_steps: [] } } } });
    assert.deepEqual(m.mock_steps, []);
    assert.equal(m.verification_detail.contains_mock, false);
  });

  test('UI: `[null]` ⇒ "KHÔNG kiểm được"; `[]` mới được in câu khẳng định', () => {
    const ui = loadExportUi(makeUiState());
    const bad = ui.exportManifestHtml({ manifest: { job: { id: 'job-r5' }, mock_steps: [null] } });
    assert.ok(!bad.includes('KHÔNG có bước nào dùng dữ liệu giả'), 'UI không được khẳng định suông');
    assert.ok(bad.includes('KHÔNG kiểm được'), 'phải nói thẳng là không kiểm được');

    const empty = ui.exportManifestHtml({ manifest: { job: { id: 'job-r5c' }, mock_steps: [] } });
    assert.ok(empty.includes('KHÔNG có bước nào dùng dữ liệu giả'), 'mảng rỗng THẬT thì câu khẳng định là đúng');

    const missingKey = ui.exportManifestHtml({ manifest: { job: { id: 'job-r5d' } } });
    assert.ok(!missingKey.includes('KHÔNG có bước nào dùng dữ liệu giả'));
    assert.ok(missingKey.includes('KHÔNG kiểm được'));

    const asString = ui.exportManifestHtml({ manifest: { job: { id: 'job-r5e' }, mock_steps: 'content' } });
    assert.ok(asString.includes('content'), 'chuỗi đơn vẫn phải hiện (không được ỉm dấu vết mock)');
  });
});

/* ═══════════════════════ R6 — trần gói + giới hạn đồng thời ═══════════════════════ */

describe('R6 — trần kích thước gói và số lượt dựng gói đồng thời', () => {
  test('resolveExportLimits: mặc định an toàn; env hợp lệ được nhận; env hỏng ⇒ KHÔNG thành "vô hạn"', () => {
    const defaults = resolveExportLimits({});
    assert.equal(defaults.maxBundleBytes, DEFAULT_MAX_BUNDLE_BYTES);
    assert.equal(defaults.maxConcurrentBundles, DEFAULT_MAX_CONCURRENT_BUNDLES);
    assert.ok(DEFAULT_MAX_BUNDLE_BYTES <= 64 * 1024 * 1024, 'mặc định không được quay lại mức 512 MiB');

    assert.deepEqual(
      resolveExportLimits({ EXPORT_MAX_BUNDLE_BYTES: '1048576', EXPORT_MAX_CONCURRENT_BUNDLES: '2', EXPORT_MAX_QUEUED_BUNDLES: '0', EXPORT_MAX_WAIT_MS: '250' }),
      { maxBundleBytes: 1048576, maxConcurrentBundles: 2, maxQueuedBundles: 0, maxWaitMs: 250 },
    );
    for (const bad of ['abc', '-1', '0', 'NaN', '']) {
      assert.equal(resolveExportLimits({ EXPORT_MAX_BUNDLE_BYTES: bad }).maxBundleBytes, DEFAULT_MAX_BUNDLE_BYTES, `env "${bad}" phải rơi về mặc định`);
      assert.equal(resolveExportLimits({ EXPORT_MAX_CONCURRENT_BUNDLES: bad }).maxConcurrentBundles, DEFAULT_MAX_CONCURRENT_BUNDLES, `env "${bad}" phải rơi về mặc định`);
    }
  });

  test('cổng: KHÔNG bao giờ chạy quá `concurrency` lượt; hàng đợi đầy/chờ lâu ⇒ EXPORT_BUSY', async () => {
    const gate = createExportGate({ concurrency: 1, queueLimit: 2, maxWaitMs: 1000 });
    let active = 0;
    let peak = 0;
    const work = () =>
      gate.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return 'ok';
      });
    const results = await Promise.all([work(), work(), work()]);
    assert.deepEqual(results, ['ok', 'ok', 'ok'], 'trong hàng đợi thì vẫn phải chạy được, chỉ là tuần tự');
    assert.equal(peak, 1, 'hai lượt KHÔNG được chồng lên nhau');
    assert.deepEqual(gate.stats(), { running: 0, queued: 0, concurrency: 1, queue_limit: 2 });

    // Hàng đợi = 0 ⇒ quá tải là từ chối NGAY (không xếp hàng vô hạn).
    const strict = createExportGate({ concurrency: 1, queueLimit: 0, maxWaitMs: 100 });
    let release;
    const held = strict.run(() => new Promise((resolve) => { release = resolve; }));
    const rejected = await strict.run(async () => 'never').then(() => null, (err) => err);
    assert.equal(rejected?.code, 'EXPORT_BUSY');
    assert.equal(rejected?.details.running, 1);
    assert.ok(rejected?.details.retry_after_ms > 0);
    release();
    await held;

    // Chờ quá `maxWaitMs` ⇒ cũng EXPORT_BUSY (không treo request).
    const slow = createExportGate({ concurrency: 1, queueLimit: 5, maxWaitMs: 20 });
    let releaseSlow;
    const heldSlow = slow.run(() => new Promise((resolve) => { releaseSlow = resolve; }));
    const timedOut = await slow.run(async () => 'never').then(() => null, (err) => err);
    assert.equal(timedOut?.code, 'EXPORT_BUSY');
    assert.ok(timedOut?.details.waited_ms >= 0);
    releaseSlow();
    await heldSlow;
  });

  test('API: gói vượt trần ⇒ 413 BUNDLE_TOO_LARGE kèm SỐ ĐO (không phải 500, không dựng tiếp)', async () => {
    const ctx = await startExportApp();
    try {
      // Trần 8 KiB: chỉ cần một asset 32 KiB là vượt — đo được cả `bytes` lẫn `limit`.
      ctx.app.exportLimits = { maxBundleBytes: 8 * 1024 };
      const seeded = await seedJob(ctx, { sid: 'r6TooLargeSessionAAAA1', kind: 'content', content: { product_name: 'To' }, originals: 1 });
      await addOriginalAsset(ctx, seeded.jobId, 'r6TooLargeSessionAAAA1', randomBytes(32 * 1024));

      const res = await fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/bundle`, { headers: cookie('r6TooLargeSessionAAAA1') });
      assert.equal(res.status, 413);
      const body = await j(res);
      assert.equal(body.error.code, 'BUNDLE_TOO_LARGE');
      assert.equal(body.error.details.limit, 8 * 1024);
      assert.ok(body.error.details.bytes > body.error.details.limit, `phải kèm số đo thật: ${JSON.stringify(body.error.details)}`);
      assert.ok(res.headers.get('content-type')?.includes('application/json'));
    } finally {
      await ctx.close();
    }
  });

  test('API: request thứ hai khi đang dựng gói ⇒ 429 EXPORT_BUSY; request đầu vẫn 200', async () => {
    const SID_R6 = 'r6BusySessionAAAAAAAAA1';
    const ctx = await startExportApp();
    try {
      ctx.app.exportLimits = { maxConcurrentBundles: 1, maxQueuedBundles: 0, maxWaitMs: 5000 };
      const seeded = await seedJob(ctx, { sid: SID_R6, kind: 'content', content: { product_name: 'Bận' }, originals: 1 });

      // Giữ request đầu NGAY TRONG lúc đọc asset để ca "đồng thời" là tất định, không phải đua may rủi.
      const storage = ctx.app.storage;
      const originalRead = storage.read;
      let releaseHold;
      const hold = new Promise((resolve) => { releaseHold = resolve; });
      let markStarted;
      const started = new Promise((resolve) => { markStarted = resolve; });
      storage.read = async (asset) => {
        markStarted();
        await hold;
        return originalRead.call(storage, asset);
      };
      try {
        const first = fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/bundle`, { headers: cookie(SID_R6) });
        await started;
        const second = await fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/bundle`, { headers: cookie(SID_R6) });
        assert.equal(second.status, 429);
        const body = await j(second);
        assert.equal(body.error.code, 'EXPORT_BUSY');
        assert.ok(body.error.details.running >= 1);
        assert.ok(body.error.retry_after_ms > 0);

        releaseHold();
        const firstRes = await first;
        assert.equal(firstRes.status, 200, 'request đang dựng gói KHÔNG được bị đuổi');
        const buf = Buffer.from(await firstRes.arrayBuffer());
        assert.equal(inspectZip(buf).valid, true);
      } finally {
        storage.read = originalRead;
        releaseHold?.();
      }
    } finally {
      await ctx.close();
    }
  });

  test('API: module X1 KHÔNG có `createExportGate` ⇒ route vẫn giới hạn (cổng dự phòng), không fail-open', async () => {
    const ctx = await startExportApp();
    try {
      // Bơm module "bản cũ": có hàm dựng gói nhưng KHÔNG có cổng/giới hạn của bản vá R6.
      const real = await import('../src/exports/index.js');
      ctx.app.exports = { buildExportBundle: real.buildExportBundle, buildExportManifest: real.buildExportManifest };
      ctx.app.exportLimits = { maxConcurrentBundles: 1, maxQueuedBundles: 0 };
      const SID_OLD = 'r6FallbackGateSessionAA1';
      const seeded = await seedJob(ctx, { sid: SID_OLD, kind: 'content', content: { product_name: 'Cũ' }, originals: 1 });

      const storage = ctx.app.storage;
      const originalRead = storage.read;
      let releaseHold;
      const hold = new Promise((resolve) => { releaseHold = resolve; });
      let markStarted;
      const started = new Promise((resolve) => { markStarted = resolve; });
      storage.read = async (asset) => {
        markStarted();
        await hold;
        return originalRead.call(storage, asset);
      };
      try {
        const first = fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/bundle`, { headers: cookie(SID_OLD) });
        await started;
        const second = await fetch(`${ctx.base}/api/exports/jobs/${seeded.jobId}/bundle`, { headers: cookie(SID_OLD) });
        assert.equal(second.status, 429, 'cổng dự phòng vẫn phải chặn request chồng lên nhau');
        assert.equal((await j(second)).error.code, 'EXPORT_BUSY');
        releaseHold();
        const firstRes = await first;
        assert.equal(firstRes.status, 200);
        assert.equal(inspectZip(Buffer.from(await firstRes.arrayBuffer())).valid, true);
      } finally {
        storage.read = originalRead;
        releaseHold?.();
      }
    } finally {
      await ctx.close();
    }
  });

  test('UI: 413 và 429 EXPORT_BUSY được nói ĐÚNG loại lỗi + không mời "thử tải trực tiếp"', () => {
    const ui = loadExportUi(makeUiState());
    const err413 = Object.assign(new Error('HTTP 413'), {
      status: 413,
      code: 'BUNDLE_TOO_LARGE',
      payload: { message: 'Gói vượt trần kích thước máy chủ cho phép.', details: { bytes: 80 * 1024 * 1024, limit: 64 * 1024 * 1024 } },
    });
    const text413 = ui.exportErrorText(err413);
    assert.match(text413, /413/);
    assert.match(text413, /80 MB/);
    assert.match(text413, /64 MB/);

    const err429 = Object.assign(new Error('HTTP 429'), {
      status: 429,
      code: 'EXPORT_BUSY',
      payload: { message: 'Máy chủ đang dựng một gói xuất bản khác.', retry_after_ms: 3000 },
    });
    const text429 = ui.exportErrorText(err429);
    assert.match(text429, /EXPORT_BUSY/);
    assert.match(text429, /3 giây/);

    for (const err of [err413, err429]) {
      const dom = makeDomStub();
      loadExportUi(makeUiState(), { document: dom.document }).exportPaintError(err, 'job-r6');
      assert.ok(dom.errorBox.innerHTML.includes(err.code), `${err.code}: panel phải hiện câu lỗi thật`);
      assert.ok(!dom.errorBox.innerHTML.includes('Vẫn thử tải trực tiếp'), `${err.code}: KHÔNG được mời bấm tải lại vô ích`);
    }
  });
});

/** Thêm một ảnh gốc cỡ lớn vào job (dùng cho ca vượt trần R6). */
async function addOriginalAsset(ctx, jobId, sid, buffer) {
  const assetId = randomUUID();
  const saved = await ctx.storage.save({ jobId, assetId, ext: 'png', mime: 'image/png', buffer });
  await ctx.store.createImageAsset({
    id: assetId,
    jobId,
    sessionId: sid,
    userId: null,
    role: 'original',
    mime: 'image/png',
    bytes: saved.bytes,
    width: 8,
    height: 8,
    sha256: saved.sha256,
    storagePath: saved.storage_path,
    source: 'upload',
    meta: {},
  });
  return saved;
}
