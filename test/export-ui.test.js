/**
 * TEST MVP-06 · X3 — UI “Gói xuất bản (.zip)” (`public/app.js`), hợp đồng §4.
 *
 * Không mở trình duyệt: mọi hàm render được TRÍCH THẬT từ `public/app.js`
 * (xem `test/export-ui-helpers.js`) rồi chạy với `state`/`app` giả.
 *
 * Phủ: nút tải ở CẢ 4 màn job (MVP-01 `renderJob`, MVP-02 `renderImagelab`,
 * MVP-03 `renderImagestudio`, MVP-04 `vsRenderPage`) với ĐÚNG URL `…/jobs/<id>/bundle`;
 * escape XSS ở id/tên job; nhắc “job chưa xong”; `jobId = null` ⇒ nút KHOÁ;
 * màn KHÔNG có job ⇒ KHÔNG vẽ nút (đối chứng âm); 404/503 ⇒ câu lỗi THẬT (kèm lỗi máy chủ);
 * bản kê khai in nguyên văn (audio null, mock_steps, missing, warnings) và escape sạch.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadExportActions,
  loadExportScreens,
  loadExportUi,
  makeAppStub,
  makeDomStub,
  makeUiState,
} from './export-ui-helpers.js';

const JOB_ID = 'de71613c-0a21-2561-94c9-dcd22c376aee';
const HOSTILE = '<img src=x onerror=alert(1)>';
const BUNDLE_URL = `/api/exports/jobs/${JOB_ID}/bundle`;
const MANIFEST_URL = `/api/exports/jobs/${JOB_ID}/manifest`;

/** `state` có config THẬT của `/api/config` (§3). */
const configWith = (exports = { available: true, formats: ['zip'] }) => ({ exports });

/* ═══════════════════════ hàm dựng khối + URL ═══════════════════════ */

describe('MVP-06 UI — exportPanelHtml/URL', () => {
  test('URL đúng hợp đồng §3 và encode id (không nhồi base64/không nối chuỗi bừa)', () => {
    const ui = loadExportUi(makeUiState());
    assert.equal(ui.exportBundleUrl(JOB_ID), BUNDLE_URL);
    assert.equal(ui.exportManifestUrl(JOB_ID), MANIFEST_URL);
    assert.equal(ui.exportBundleUrl('a b/c?d'), '/api/exports/jobs/a%20b%2Fc%3Fd/bundle');
    assert.equal(ui.exportBundleUrl(null), '/api/exports/jobs//bundle');
  });

  test('jobId hợp lệ ⇒ nút TẢI bật, đúng data-export-url, có câu nói thật', () => {
    const state = makeUiState({ config: configWith() });
    const ui = loadExportUi(state);
    const html = ui.exportPanelHtml(JOB_ID, 'succeeded', { kind: 'image_translation' });

    assert.ok(html.includes(`data-export-url="${BUNDLE_URL}"`), 'nút phải mang ĐÚNG URL tải gói');
    assert.ok(html.includes(`data-export-id="${JOB_ID}"`));
    assert.ok(html.includes('TẢI GÓI XUẤT BẢN (.zip)'));
    assert.ok(html.includes('data-action="exportbundle"'));
    assert.ok(html.includes('data-action="exportmanifest"'));
    assert.ok(html.includes(ui.EXPORT_HONEST_LINE), 'phải có dòng nói thật về nội dung gói');
    assert.ok(!html.includes('disabled'), 'job xong ⇒ nút KHÔNG bị khoá');
    assert.equal(html.includes('[object Object]'), false);
    // Không nhồi dữ liệu gói vào state/HTML — chỉ URL.
    assert.ok(!/base64|data:application\/zip/i.test(html));
  });

  test('job ĐANG CHẠY (queued/running/awaiting_review) ⇒ nhắc “job chưa xong”', () => {
    const ui = loadExportUi(makeUiState({ config: configWith() }));
    for (const status of ['queued', 'running', 'awaiting_review']) {
      const html = ui.exportPanelHtml(JOB_ID, status, { kind: 'content' });
      assert.ok(html.includes(ui.EXPORT_RUNNING_LINE), `trạng thái ${status} phải nhắc job chưa xong`);
      assert.ok(html.includes(`data-export-url="${BUNDLE_URL}"`), 'vẫn phải tải được (chỉ nhắc, không chặn)');
    }
    const done = ui.exportPanelHtml(JOB_ID, 'succeeded', { kind: 'content' });
    assert.ok(!done.includes(ui.EXPORT_RUNNING_LINE));
  });

  test('jobId null/undefined/"" ⇒ nút KHOÁ + nói rõ lý do', () => {
    const ui = loadExportUi(makeUiState({ config: configWith() }));
    for (const id of [null, undefined, '', '   ']) {
      const html = ui.exportPanelHtml(id, 'succeeded', { kind: 'content' });
      assert.match(html, /disabled aria-disabled="true"/, `jobId=${JSON.stringify(id)} ⇒ nút tải phải bị khoá`);
      assert.ok(html.includes(ui.EXPORT_NO_ID_LINE), 'phải nói VÌ SAO khoá');
      assert.ok(html.includes('data-export-url=""'), 'không được trỏ tới URL rác');
    }
  });

  test('/api/config khai exports.available = false ⇒ cảnh báo trước, KHÔNG giả vờ tải được', () => {
    const ui = loadExportUi(makeUiState({ config: configWith({ available: false, formats: ['zip'] }) }));
    const html = ui.exportPanelHtml(JOB_ID, 'succeeded', { kind: 'content' });
    assert.ok(html.includes(ui.EXPORT_UNCONFIGURED_LINE), 'phải hiện lời máy chủ khai');
    assert.ok(html.includes(`data-export-url="${BUNDLE_URL}"`), 'vẫn để bấm được để thấy lỗi 503 THẬT');
  });

  test('escape XSS: id job chứa thẻ HTML không sống sót vào HTML', () => {
    const ui = loadExportUi(makeUiState({ config: configWith() }));
    const html = ui.exportPanelHtml(HOSTILE, 'succeeded', { kind: HOSTILE });
    assert.ok(!html.includes('<img src=x onerror'), 'id thô KHÔNG được vào HTML');
    assert.ok(!html.includes('<script>'), 'kind thô KHÔNG được vào HTML');
    assert.ok(html.includes('&lt;img'), 'phải escape thành thực thể HTML');
    assert.ok(html.includes('data-export-id="&lt;img'), 'thuộc tính data cũng phải escape');
  });
});

/* ═══════════════════ 4 màn job đều có nút + đối chứng âm ═══════════════════ */

describe('MVP-06 UI — CẢ 4 màn job đều có nút tải ĐÚNG URL', () => {
  const jobView = (kind) => ({
    job: { id: JOB_ID, status: 'succeeded', kind, product_name: 'Sản phẩm', product_master: {} },
  });

  test('MVP-01 renderJob: có nút + đúng URL', () => {
    const state = makeUiState({ config: configWith(), job: jobView('content').job });
    const app = makeAppStub();
    const ui = loadExportUi(state);
    const screens = loadExportScreens(state, app, ui.exportPanelHtml);

    screens.renderJob();
    assert.ok(app.innerHTML.includes(`data-export-url="${BUNDLE_URL}"`), 'màn job MVP-01 phải có nút tải gói');
    assert.ok(app.innerHTML.includes('TẢI GÓI XUẤT BẢN (.zip)'));
  });

  test('MVP-02 renderImagelab: có nút + đúng URL', () => {
    const state = makeUiState({
      config: { exports: { available: true, formats: ['zip'] }, imagelab: { available: true, ocr: {}, translate: {}, render: {} } },
      il: { job: jobView('image_translation') },
    });
    const app = makeAppStub();
    const ui = loadExportUi(state);
    const screens = loadExportScreens(state, app, ui.exportPanelHtml);

    screens.renderImagelab();
    assert.ok(app.innerHTML.includes(`data-export-url="${BUNDLE_URL}"`), 'màn job MVP-02 phải có nút tải gói');
  });

  test('MVP-03 renderImagestudio: có nút + đúng URL', () => {
    const state = makeUiState({
      config: { exports: { available: true, formats: ['zip'] }, imagestudio: { available: false } },
      is: { job: jobView('image_generation') },
    });
    const app = makeAppStub();
    const ui = loadExportUi(state);
    const screens = loadExportScreens(state, app, ui.exportPanelHtml);

    screens.renderImagestudio();
    assert.ok(app.innerHTML.includes(`data-export-url="${BUNDLE_URL}"`), 'màn job MVP-03 phải có nút tải gói');
  });

  test('MVP-04 vsRenderPage: có nút + đúng URL', () => {
    const state = makeUiState({
      config: { exports: { available: true, formats: ['zip'] }, videostudio: { available: false } },
      vs: { job: jobView('video_generation') },
    });
    const app = makeAppStub();
    const ui = loadExportUi(state);
    const screens = loadExportScreens(state, app, ui.exportPanelHtml);

    screens.vsRenderPage();
    assert.ok(app.innerHTML.includes(`data-export-url="${BUNDLE_URL}"`), 'màn job MVP-04 phải có nút tải gói');
  });

  test('ĐỐI CHỨNG ÂM: màn KHÔNG có job ⇒ KHÔNG vẽ nút tải nào', () => {
    const state = makeUiState({
      config: { exports: { available: true, formats: ['zip'] }, imagelab: { available: true }, imagestudio: { available: false }, videostudio: { available: false } },
    });
    const app = makeAppStub();
    const ui = loadExportUi(state);
    const screens = loadExportScreens(state, app, ui.exportPanelHtml);

    for (const [name, render] of Object.entries(screens)) {
      app.innerHTML = '';
      render();
      assert.ok(!app.innerHTML.includes('data-action="exportbundle"'), `${name}: không có job ⇒ KHÔNG được vẽ nút tải`);
      assert.ok(!app.innerHTML.includes('/api/exports/jobs/'), `${name}: không có job ⇒ không được có URL gói`);
    }
  });

  test('job ĐANG CHẠY ở CẢ 4 màn ⇒ vẫn có nút nhưng kèm nhắc “chưa xong”', () => {
    const base = { exports: { available: true, formats: ['zip'] } };
    const runningJob = (kind) => ({ id: JOB_ID, status: 'running', kind });
    const screens = [
      ['MVP-01', 'renderJob', makeUiState({ config: base, job: runningJob('content') })],
      ['MVP-02', 'renderImagelab', makeUiState({ config: { ...base, imagelab: { available: true, ocr: {}, translate: {}, render: {} } }, il: { job: { job: runningJob('image_translation') } } })],
      ['MVP-03', 'renderImagestudio', makeUiState({ config: { ...base, imagestudio: { available: false } }, is: { job: { job: runningJob('image_generation') } } })],
      ['MVP-04', 'vsRenderPage', makeUiState({ config: { ...base, videostudio: { available: false } }, vs: { job: { job: runningJob('video_generation') } } })],
    ];
    for (const [label, fn, state] of screens) {
      const app = makeAppStub();
      const ui = loadExportUi(state);
      loadExportScreens(state, app, ui.exportPanelHtml)[fn]();
      assert.ok(app.innerHTML.includes(ui.EXPORT_RUNNING_LINE), `${label}: job đang chạy phải nhắc “chưa xong”`);
      assert.ok(app.innerHTML.includes(`data-export-url="${BUNDLE_URL}"`), `${label}: vẫn phải tải được (chỉ nhắc, không chặn)`);
    }
  });

  test('XSS ở tên job/URL của màn MVP-01: dữ liệu job không phá HTML', () => {
    const state = makeUiState({
      config: configWith(),
      job: { id: JOB_ID, status: 'failed', kind: 'content', product_name: HOSTILE, canonical_url: `javascript:${HOSTILE}` },
    });
    const app = makeAppStub();
    const ui = loadExportUi(state);
    const screens = loadExportScreens(state, app, ui.exportPanelHtml);
    screens.renderJob();
    assert.ok(!app.innerHTML.includes('<img src=x onerror'), 'tên sản phẩm/URL thô KHÔNG được vào HTML');
    assert.ok(!app.innerHTML.includes('<script>'));
  });
});

/* ═══════════════════ câu lỗi THẬT (404/503/400/429) ═══════════════════ */

describe('MVP-06 UI — exportErrorText nói ĐÚNG lỗi máy chủ trả', () => {
  test('404 (job không tồn tại / khác chủ) ⇒ nêu 404 + câu thật của máy chủ', () => {
    const ui = loadExportUi(makeUiState());
    const text = ui.exportErrorText({ status: 404, code: 'JOB_NOT_FOUND', payload: { message: 'Không tìm thấy job.' } });
    assert.match(text, /404/);
    assert.match(text, /Không tìm thấy job/);
    assert.match(text, /phiên hoặc tài khoản khác/);
  });

  test('503 EXPORT_UNAVAILABLE ⇒ nêu 503 + lý do thật + không mời bấm lại vô ích', () => {
    const ui = loadExportUi(makeUiState());
    const text = ui.exportErrorText({ status: 503, code: 'EXPORT_UNAVAILABLE', payload: { message: 'Khối gói xuất bản chưa nạp được.' } });
    assert.match(text, /503/);
    assert.match(text, /EXPORT_UNAVAILABLE/);
    assert.match(text, /Khối gói xuất bản chưa nạp được/);
    assert.match(text, /vẫn xem bình thường/);
  });

  test('400 id rác / 429 quá tần suất / lỗi khác ⇒ câu tương ứng, có mã thật', () => {
    const ui = loadExportUi(makeUiState());
    assert.match(ui.exportErrorText({ status: 400, code: 'BAD_JOB_ID', payload: { message: 'Mã job không hợp lệ.' } }), /400.*Mã job không hợp lệ/s);
    assert.match(ui.exportErrorText({ status: 429, code: 'RATE_LIMITED' }), /429.*giới hạn tần suất/s);
    assert.match(ui.exportErrorText({ status: 500, code: 'EXPORT_FAILED', payload: { message: 'Không dựng được gói xuất bản.' } }), /500.*Không dựng được gói/s);
    // Thân không phải bản kê khai ⇒ nói thẳng, KHÔNG tải bừa thành .zip.
    assert.equal(ui.exportErrorText({ code: 'EXPORT_BAD_MANIFEST' }), ui.EXPORT_NOT_MANIFEST_LINE);
    assert.ok(ui.exportErrorText({}).length > 0, 'lỗi không rõ vẫn phải có câu');
  });

  test('exportPaintError ghi câu lỗi THẬT vào panel (404 còn gợi ý tải trực tiếp, 503 thì không)', () => {
    const boxes = { box: { innerHTML: '' } };
    const doc = { querySelector: (sel) => (sel === '[data-export-error]' ? boxes.box : null) };
    const ui = loadExportUi(makeUiState(), { document: doc });

    const notFound = ui.exportPaintError({ status: 404, code: 'JOB_NOT_FOUND', payload: { message: 'Không tìm thấy job.' } }, JOB_ID);
    assert.match(notFound, /Không tìm thấy job/);
    assert.ok(boxes.box.innerHTML.includes('Không tìm thấy job'), 'panel phải hiện câu thật');
    assert.ok(boxes.box.innerHTML.includes('data-export-url=') === false, 'panel lỗi không vẽ nút tải');
    assert.ok(boxes.box.innerHTML.includes(ui.EXPORT_FALLBACK_LINE), '404 ⇒ còn cách tải trực tiếp');

    boxes.box.innerHTML = '';
    const unavailable = ui.exportPaintError({ status: 503, code: 'EXPORT_UNAVAILABLE' }, JOB_ID);
    assert.match(unavailable, /503/);
    assert.ok(boxes.box.innerHTML.includes('503'));
    assert.ok(!boxes.box.innerHTML.includes(ui.EXPORT_FALLBACK_LINE), '503 ⇒ KHÔNG mời bấm lại vô ích');
  });

  test('exportDownloadName: gợi ý tên tệp an toàn, không id ⇒ rỗng', () => {
    const ui = loadExportUi(makeUiState());
    assert.equal(ui.exportDownloadName({ job: { kind: 'image_generation' } }, JOB_ID), `image_generation-${JOB_ID.slice(0, 8)}.zip`);
    // `kind` là dữ liệu ngoài: phải lọc về ký tự an toàn, KHÔNG nhét thẳng vào tên tệp.
    const hostileName = ui.exportDownloadName({ job: { kind: `<b>${HOSTILE}</b>` } }, JOB_ID);
    assert.match(hostileName, /^[A-Za-z0-9._-]+\.zip$/, `tên tệp gợi ý phải an toàn, nhận ${hostileName}`);
    assert.ok(hostileName.includes(JOB_ID.slice(0, 8)));
    assert.equal(ui.exportDownloadName({}, null), '');
    assert.equal(ui.exportDownloadName({}, ''), '');
  });
});

/* ═══════════════════ bản kê khai in nguyên văn ═══════════════════ */

describe('MVP-06 UI — exportManifestHtml in NGUYÊN VĂN (không tô hồng)', () => {
  const data = {
    manifest: {
      generated_at: '2026-10-07T10:20:30.000Z',
      job: { id: JOB_ID, kind: 'image_translation', status: 'succeeded' },
      verification: 'MOCK_VERIFIED',
      verification_detail: { label: 'MOCK_VERIFIED', live_service_called: false },
      audio: null,
      mock_steps: ['ocr', 'translate', 'render'],
      counts: { assets: 3, images: 1, videos: 1, lines: 3, usage: 2 },
      providers: { imagelab: { ocr: { name: 'mock', is_mock: true } } },
      warnings: ['cảnh báo từ manifest'],
      missing: ['video/ — job này không tạo video.'],
    },
    warnings: ['cảnh báo từ API'],
    missing: ['bang-chung/usage.json — job chưa ghi dòng usage_events nào'],
  };

  test('hiện nhãn kiểm chứng, audio null, mock_steps, counts, providers, warnings + missing (cả hai nguồn)', () => {
    const ui = loadExportUi(makeUiState());
    const html = ui.exportManifestHtml(data);
    for (const needle of [
      'MOCK_VERIFIED',
      'audio: KHÔNG có tiếng',
      'ocr', 'translate', 'render',
      'assets=3', 'videos=1', 'lines=3',
      'mock',
      'cảnh báo từ manifest', 'cảnh báo từ API',
      'video/ — job này không tạo video.',
      'bang-chung/usage.json — job chưa ghi dòng usage_events nào',
      JOB_ID, 'image_translation',
    ]) {
      assert.ok(html.includes(needle), `bản kê khai phải in "${needle}"`);
    }
    assert.ok(html.includes('mock_steps'), 'phải ghi rõ tên mục mock_steps');
  });

  test('KHÔNG tự nâng nhãn: chỉ hiện đúng thứ máy chủ khai; thiếu mục ⇒ nói thẳng là rỗng', () => {
    const ui = loadExportUi(makeUiState());
    const empty = ui.exportManifestHtml({ manifest: { job: { id: JOB_ID, kind: 'content', status: 'queued' } } });
    assert.ok(!empty.includes('LIVE_VERIFIED'), 'UI KHÔNG được tự sinh nhãn LIVE');
    assert.ok(empty.includes('máy chủ không khai'), 'thiếu nhãn ⇒ nói thẳng');
    assert.ok(empty.includes('KHÔNG thiếu mục nào') || empty.includes('Máy chủ'), 'mục rỗng phải được nói rõ');
    assert.ok(!ui.exportManifestHtml({}).includes('undefined'));
    assert.ok(!ui.exportManifestHtml(null).includes('undefined'));
  });

  test('escape XSS trong bản kê khai (cảnh báo/mục thiếu/tên job đều là dữ liệu ngoài)', () => {
    const ui = loadExportUi(makeUiState());
    const html = ui.exportManifestHtml({
      manifest: {
        job: { id: HOSTILE, kind: HOSTILE, status: HOSTILE },
        verification: HOSTILE,
        audio: null,
        mock_steps: [HOSTILE],
        counts: { [HOSTILE]: HOSTILE },
        warnings: [HOSTILE],
        missing: [HOSTILE],
        providers: HOSTILE,
      },
      warnings: [HOSTILE],
      missing: [HOSTILE],
    });
    assert.ok(!html.includes('<img src=x onerror'), 'cảnh báo/mục thiếu thô KHÔNG được vào HTML');
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;img src=x onerror'), 'phải escape');
  });

  test('LIVE_VERIFIED do máy chủ khai thì hiện đúng (UI không được ỉm đi)', () => {
    const ui = loadExportUi(makeUiState());
    const html = ui.exportManifestHtml({ manifest: { job: { id: JOB_ID, kind: 'content', status: 'succeeded' }, verification: 'LIVE_VERIFIED', audio: null } });
    assert.ok(html.includes('LIVE_VERIFIED'), 'nhãn do MÁY CHỦ khai phải hiện nguyên văn');
  });
});

/* ═══════════════════ luồng bấm nút THẬT (async handler) ═══════════════════ */

describe('MVP-06 UI — downloadExportBundle/openExportManifest (luồng bấm nút thật)', () => {
  /** Hàm gọi API giả: ghi lại URL đã gọi, trả `result` hoặc ném `error`. */
  function fakeApi({ result = null, error = null } = {}) {
    const calls = [];
    const api = async (url, opts) => {
      calls.push({ url, opts });
      if (error) throw error;
      return result;
    };
    api.calls = calls;
    return api;
  }

  const manifestResult = { manifest: { job: { id: JOB_ID, kind: 'image_generation', status: 'succeeded' }, audio: null }, warnings: [], missing: [] };

  test('bấm tải: hỏi /manifest TRƯỚC, rồi mới tải .zip bằng thẻ <a download> (không nhồi state)', async () => {
    const state = makeUiState({ config: configWith() });
    const dom = makeDomStub();
    const api = fakeApi({ result: manifestResult });
    const ui = loadExportActions(state, dom, api);

    const out = await ui.downloadExportBundle(JOB_ID);
    assert.deepEqual(api.calls.map((c) => c.url), [MANIFEST_URL], 'phải kiểm tra /manifest trước khi tải');
    assert.equal(out.ok, true);
    assert.deepEqual(dom.log.clicks, [{ href: BUNDLE_URL, download: `image_generation-${JOB_ID.slice(0, 8)}.zip` }], 'phải bấm tải ĐÚNG URL gói');
    assert.equal(dom.log.appended.length, 1, 'thẻ <a> phải được gắn vào DOM để bấm được');
    assert.deepEqual(dom.log.toasts, ['Đang tải gói xuất bản (.zip)…']);
    assert.equal(dom.errorBox.innerHTML, '', 'không được hiện lỗi khi tải thành công');
  });

  test('404/503 từ máy chủ ⇒ KHÔNG tải, hiện câu lỗi THẬT trong panel', async () => {
    const state = makeUiState({ config: configWith() });
    for (const [status, code, message, needle] of [
      [404, 'JOB_NOT_FOUND', 'Không tìm thấy job.', /Không tìm thấy job/],
      [503, 'EXPORT_UNAVAILABLE', 'Khối gói xuất bản chưa nạp được.', /503/],
    ]) {
      const dom = makeDomStub();
      const ui = loadExportActions(state, dom, fakeApi({ error: Object.assign(new Error(`HTTP ${status}`), { status, code, payload: { message } }) }));
      const out = await ui.downloadExportBundle(JOB_ID);
      assert.equal(out.ok, false);
      assert.equal(dom.log.clicks.length, 0, `${status}: KHÔNG được tải file khi máy chủ báo lỗi`);
      assert.match(dom.errorBox.innerHTML, needle, `${status}: panel phải hiện câu lỗi thật`);
      assert.ok(!dom.errorBox.innerHTML.includes('undefined'));
    }
  });

  test('thân trả về KHÔNG phải bản kê khai (trang HTML) ⇒ chặn, không tải bừa thành .zip', async () => {
    const state = makeUiState({ config: configWith() });
    const dom = makeDomStub();
    const ui = loadExportActions(state, dom, fakeApi({ result: { __raw: '<html>login</html>' } }));
    const out = await ui.downloadExportBundle(JOB_ID);
    assert.equal(out.ok, false);
    assert.equal(out.code, 'EXPORT_BAD_MANIFEST');
    assert.equal(dom.log.clicks.length, 0);
    assert.ok(dom.errorBox.innerHTML.includes('KHÔNG phải bản kê khai'));
  });

  test('jobId rỗng ⇒ báo khoá, KHÔNG gọi API, KHÔNG tải', async () => {
    const state = makeUiState({ config: configWith() });
    const dom = makeDomStub();
    const api = fakeApi({ result: manifestResult });
    const ui = loadExportActions(state, dom, api);
    const out = await ui.downloadExportBundle(null);
    assert.equal(out.ok, false);
    assert.deepEqual(api.calls, []);
    assert.equal(dom.log.clicks.length, 0);
    assert.ok(dom.errorBox.innerHTML.includes(ui.EXPORT_NO_ID_LINE));
  });

  test('mở bản kê khai: in nguyên văn thứ máy chủ trả; lỗi thì ẩn panel + hiện lỗi thật', async () => {
    const state = makeUiState({ config: configWith() });
    const dom = makeDomStub();
    const api = fakeApi({ result: manifestResult });
    const ui = loadExportActions(state, dom, api);

    const ok = await ui.openExportManifest(JOB_ID);
    assert.equal(ok.ok, true);
    assert.deepEqual(api.calls.map((c) => c.url), [MANIFEST_URL]);
    assert.equal(dom.manifestBox.hidden, false, 'phải mở panel bản kê khai');
    assert.ok(dom.manifestBox.innerHTML.includes(JOB_ID));

    const badDom = makeDomStub();
    const badUi = loadExportActions(state, badDom, fakeApi({ error: Object.assign(new Error('HTTP 503'), { status: 503, code: 'EXPORT_UNAVAILABLE' }) }));
    const bad = await badUi.openExportManifest(JOB_ID);
    assert.equal(bad.ok, false);
    assert.equal(badDom.manifestBox.hidden, true, 'lỗi ⇒ ẩn panel bản kê khai cũ');
    assert.equal(badDom.manifestBox.innerHTML, '');
    assert.match(badDom.errorBox.innerHTML, /503/);
  });
});
