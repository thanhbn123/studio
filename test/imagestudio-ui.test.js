/**
 * TEST MVP-03 · E5 — UI tab “Tạo ảnh” (`public/app.js`), hợp đồng §3.7.
 *
 * Không mở trình duyệt: mọi hàm render được TRÍCH THẬT từ `public/app.js` (xem
 * `test/imagestudio-ui-helpers.js`) rồi chạy với `state` giả. Vì vậy test bắt được
 * cả lỗi logic lẫn lỗi quên `esc()`.
 *
 * Phủ: escape XSS ở MỌI trường; cảnh báo nền không tách được; tham số bị kẹp hiện
 * TÊN + GIÁ TRỊ HIỆU LỰC; overlay bị chặn hiện reason + violations; thanh trượt lấy
 * min/max từ `retouch_limits` CỦA MÁY CHỦ (đổi số ⇒ đổi theo, thiếu ⇒ khoá lại);
 * nhãn “nền MÔ PHỎNG” khi `synthetic_background = true`.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RETOUCH_LIMITS } from '../src/imagestudio/retouch/index.js';
import { makeIsState, isConfigBlock, loadIsUi } from './imagestudio-ui-helpers.js';

const LIMITS = { brightness: 0.25, contrast: 0.25, saturation: 0.3, sharpen: 0.5 };

/** `state` đầy đủ cho một job đã xong, có ảnh trước/sau. */
function doneState({ job = {}, asset = {}, rendered = {}, matting = {}, compose = {}, retouch = {}, extraIs = {} } = {}) {
  const state = makeIsState({
    config: isConfigBlock({ retouch_limits: LIMITS, templates: [{ id: 'trang', label: 'Trắng', synthetic: true }] }),
    is: {
      limits: LIMITS,
      templates: [{ id: 'trang', label: 'Trắng', synthetic: true }],
      providers: { matting: { name: 'purejs', is_mock: false, configured: true }, retouch: { name: 'purejs', is_mock: false, configured: true } },
      job: {
        job: { id: '11111111-2222-3333-4444-555555555555', status: 'succeeded', stage: 'done', error_code: null, ...job },
        asset: { id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', role: 'original', mime: 'image/png', width: 64, height: 64, sha256: 'a'.repeat(64), ...asset },
        rendered: [
          {
            id: 'ffffffff-0000-1111-2222-333333333333',
            role: 'rendered',
            mime: 'image/png',
            width: 64,
            height: 64,
            sha256: 'b'.repeat(64),
            parent_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            meta: { kind: 'image_generation', template: { id: 'trang', label: 'Trắng', synthetic: true }, synthetic_background: true },
            ...rendered,
          },
        ],
        matting: { status: 'OK', provider: 'purejs', is_mock: false, mask: { coverage: 0.1406, background_ratio: 0.8594, uniformity: 1, seed_colors: 1 }, warnings: [], ...matting },
        compose: { applied: true, template: { id: 'trang', label: 'Trắng', synthetic: true }, background_ratio: 0.8594, warnings: [], ...compose },
        retouch: { status: 'OK', params_effective: { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 }, clamped: [], rejected: [], warnings: [], ...retouch },
        warnings: [],
        providers: { matting: { name: 'purejs', is_mock: false, configured: true }, retouch: { name: 'purejs', is_mock: false, configured: true } },
      },
      ...extraIs,
    },
  });
  return state;
}

describe('MVP-03 UI — escape XSS ở MỌI trường', () => {
  const HOSTILE = '<img src=x onerror=alert(1)>';

  test('job/asset/cảnh báo/overlay vi phạm/template đều bị escape', () => {
    const state = doneState({
      job: { id: `${HOSTILE}`, status: 'failed', stage: 'failed', error_code: '<b>NO_CHANGES</b>', error_message: '<script>alert(1)</script>' },
      asset: { id: `${HOSTILE}`, mime: 'image/png"><script>alert(2)</script>', sha256: `<${HOSTILE}`, width: 64, height: 64 },
      rendered: { id: `${HOSTILE}`, meta: { synthetic_background: true, template: { id: 'trang', label: HOSTILE, synthetic: true } } },
      compose: { template: { id: 'trang', label: HOSTILE, synthetic: true }, warnings: [`<svg onload=alert(3)>`] },
      retouch: { clamped: ['<b>brightness</b>'], params_effective: { '<b>brightness</b>': 0.25 }, rejected: [`<i>contrast</i>`] },
      matting: { status: 'UNIFORM_BACKGROUND_NOT_FOUND', error_code: 'UNIFORM_BACKGROUND_NOT_FOUND', error_message: `<em>${HOSTILE}</em>`, warnings: [`<u>${HOSTILE}</u>`] },
      extraIs: {
        templates: [{ id: `${HOSTILE}`, label: HOSTILE, synthetic: true }],
        error: HOSTILE,
        overlayBlocked: { code: 'OVERLAY_UNSUPPORTED_CLAIM', reason: HOSTILE, violations: [HOSTILE] },
        options: { template: `${HOSTILE}`, remove_background: true, retouch: { brightness: 0.25, contrast: 0, saturation: 0, sharpen: 0 }, overlay_text: HOSTILE },
      },
    });
    const ui = loadIsUi(state);
    const html = `${ui.renderImagestudioBody()}${ui.renderIsOverlayBlocked()}${ui.renderIsWarnings(state.is.job)}`;

    // Bất biến của esc(): chuỗi NGUY HIỂM thô KHÔNG BAO GIỜ sống sót vào HTML.
    // (`<img ...>` hợp lệ của khối Trước/Sau vẫn còn, nhưng mọi giá trị từ DỮ LIỆU đều bị escape.)
    const forbidden = [
      HOSTILE,
      '<script>alert(1)</script>',
      '<script>alert(2)</script>',
      '<svg onload=alert(3)>',
      '<b>NO_CHANGES</b>',
      '<b>brightness</b>',
      '<i>contrast</i>',
      `<em>${HOSTILE}</em>`,
      `<u>${HOSTILE}</u>`,
    ];
    for (const raw of forbidden) {
      assert.ok(!html.includes(raw), `HTML còn chứa chuỗi thô "${raw}" — thiếu esc() ở đâu đó`);
    }
    assert.ok(!html.includes('<script'), 'không được có thẻ <script> do dữ liệu sinh ra');
    assert.ok(html.includes('&lt;img'), 'phải escape thành &lt;img');
  });

  test('ảnh đang chọn (pending) — dataUrl/tên tệp cũng bị escape', () => {
    const state = makeIsState({
      config: isConfigBlock(),
      is: {
        pending: {
          name: '<script>ten-tep</script>',
          bytes: 1234,
          mime: 'image/png',
          dataUrl: `"><script>alert(1)</script>`,
        },
      },
    });
    const ui = loadIsUi(state);
    const html = ui.renderImagestudioBody();
    assert.ok(!html.includes('<script'));
    assert.ok(!html.includes('"><script'));
    assert.ok(html.includes('&lt;script&gt;ten-tep'));
  });

  test('lỗi lấy mẫu nền (templatesError) cũng bị escape', () => {
    const state = makeIsState({ config: isConfigBlock(), is: { templates: [], templatesError: '<script>err</script>' } });
    const ui = loadIsUi(state);
    const html = ui.renderIsTemplates();
    assert.ok(!html.includes('<script'));
    assert.ok(html.includes('&lt;script&gt;err'));
  });
});

describe('MVP-03 UI — cảnh báo THẬT không bị ẩn', () => {
  test('nền không tách được ⇒ hiện câu giải thích + SỐ ĐO THẬT của mask', () => {
    const state = doneState({
      matting: {
        status: 'UNIFORM_BACKGROUND_NOT_FOUND',
        error_code: 'UNIFORM_BACKGROUND_NOT_FOUND',
        error_message: 'Nền KHÔNG đồng nhất: chỉ 4.4% pixel viền thuộc cụm màu chủ đạo',
        mask: { uniformity: 0.044, background_ratio: null, coverage: null, seed_colors: 68 },
      },
    });
    const html = loadIsUi(state).renderIsWarnings(state.is.job);
    assert.ok(html.includes('Không tách được nền'), 'phải nói thẳng là không tách được nền');
    assert.ok(html.includes('TỪ CHỐI cắt'), 'phải giải thích vì sao từ chối cắt');
    assert.ok(html.includes('Độ đồng nhất nền đo được: 0.044'), 'phải hiện số đo THẬT');
    assert.ok(html.includes('Số cụm màu nền: 68'));
  });

  test('nền MÔ PHỎNG: nhãn xuất hiện khi synthetic_background = true (kể cả khi compose không khai)', () => {
    const on = doneState({
      rendered: { meta: { synthetic_background: true, template: null } },
      compose: { template: null },
    });
    const uiOn = loadIsUi(on);
    assert.ok(uiOn.renderIsCompare(on.is.job).includes('nền MÔ PHỎNG'), 'khối Trước/Sau phải có nhãn MÔ PHỎNG');
    assert.ok(uiOn.renderIsWarnings(on.is.job).includes('nền MÔ PHỎNG'), 'khối cảnh báo phải có nhãn MÔ PHỎNG');

    const off = doneState({
      rendered: { meta: { synthetic_background: false, template: null } },
      compose: { template: null },
    });
    const uiOff = loadIsUi(off);
    assert.ok(!uiOff.renderIsCompare(off.is.job).includes('nền MÔ PHỎNG'), 'không ghép nền thì KHÔNG được dán nhãn MÔ PHỎNG');
    assert.ok(!uiOff.renderIsWarnings(off.is.job).includes('nền MÔ PHỎNG'));
  });

  test('tham số bị KẸP ⇒ hiện TÊN + GIÁ TRỊ HIỆU LỰC + ngưỡng của máy chủ', () => {
    const state = doneState({
      retouch: { status: 'OK', clamped: ['brightness'], params_effective: { brightness: 0.25, contrast: 0, saturation: 0, sharpen: 0 } },
    });
    const html = loadIsUi(state).renderIsWarnings(state.is.job);
    assert.ok(html.includes('bị KẸP'), 'phải có cảnh báo kẹp');
    assert.ok(html.includes('Độ sáng'), 'phải hiện TÊN tham số');
    assert.ok(html.includes('(brightness)'));
    assert.ok(html.includes('+0.25'), 'phải hiện GIÁ TRỊ HIỆU LỰC');
    assert.ok(html.includes('ngưỡng ±0.25'), 'phải hiện ngưỡng của máy chủ');
  });

  test('overlay bị CHẶN ⇒ hiện reason + TỪNG vi phạm, khử trùng lặp', () => {
    const state = doneState({
      retouch: { status: null, clamped: [], rejected: [], params_effective: null },
      extraIs: {
        overlayBlocked: {
          code: 'OVERLAY_UNSUPPORTED_CLAIM',
          reason: 'Chữ overlay chứa khẳng định không có bằng chứng trong chữ gốc của job.',
          violations: ['Khẳng định “Bảo hành” không có trong chữ gốc', 'Khẳng định “Bảo hành” không có trong chữ gốc'],
        },
      },
    });
    const ui = loadIsUi(state);
    const html = ui.renderIsOverlayBlocked();
    assert.ok(html.includes('Chữ overlay bị CHẶN'));
    assert.ok(html.includes('OVERLAY_UNSUPPORTED_CLAIM'));
    assert.ok(html.includes('chứa khẳng định không có bằng chứng'), 'phải hiện reason của máy chủ');
    assert.equal(html.split('Khẳng định “Bảo hành” không có trong chữ gốc').length - 1, 2, 'vi phạm trùng chỉ hiện một lần + một lần trong câu mẫu');
  });

  test('job thất bại ⇒ hiện mã lỗi + câu giải thích; job đang chạy ⇒ hiện tiến trình', () => {
    const failed = doneState({ job: { status: 'failed', stage: 'failed', error_code: 'ORIGINAL_MUTATED', error_message: 'Ảnh gốc đã BỊ ĐỔI trong lúc tạo ảnh' } });
    const failedHtml = loadIsUi(failed).renderIsJob();
    assert.ok(failedHtml.includes('ORIGINAL_MUTATED'));
    assert.ok(failedHtml.includes('Ảnh gốc đã BỊ ĐỔI'));

    const running = doneState({ job: { status: 'running', stage: 'composing' } });
    const runningUi = loadIsUi(running);
    const runningHtml = runningUi.renderIsJob();
    assert.ok(runningHtml.includes('Đang ghép nền MÔ PHỎNG'));
    assert.ok(runningHtml.includes('Ghép nền MÔ PHỎNG'));
  });

  test('ảnh ra KHÁC kích thước ảnh gốc ⇒ cảnh báo lỗi (lưới an toàn luật #1)', () => {
    const state = doneState({ rendered: { width: 32, height: 32 } });
    const html = loadIsUi(state).renderIsWarnings(state.is.job);
    assert.ok(html.includes('KHÁC KÍCH THƯỚC ẢNH GỐC'));
    assert.ok(html.includes('KHÔNG dùng ảnh này để đăng bán'));
  });
});

describe('MVP-03 UI — thanh trượt lấy ngưỡng từ MÁY CHỦ', () => {
  test('min/max/step lấy đúng retouch_limits; đổi số trong dữ liệu ⇒ markup đổi theo', () => {
    const state = doneState({ extraIs: { limits: { ...RETOUCH_LIMITS } } });
    const ui = loadIsUi(state);
    const html = ui.renderIsParam('brightness');
    assert.match(html, /min="-0\.25"/);
    assert.match(html, /max="0\.25"/);
    assert.match(html, /step="0\.01"/);
    assert.ok(html.includes('ngưỡng ±0.25'));

    // Máy chủ siết ngưỡng ⇒ UI phải theo, KHÔNG hardcode.
    state.is.limits = { brightness: 0.1, contrast: 0.25, saturation: 0.3, sharpen: 0.5 };
    const tightened = loadIsUi(state).renderIsParam('brightness');
    assert.match(tightened, /min="-0\.1"/);
    assert.match(tightened, /max="0\.1"/);
    assert.ok(tightened.includes('ngưỡng ±0.1'));
  });

  test('chưa có ngưỡng từ máy chủ ⇒ thanh trượt BỊ KHOÁ, không bịa số', () => {
    const state = makeIsState({ config: isConfigBlock({ retouch_limits: null }) });
    const ui = loadIsUi(state);
    assert.equal(ui.isLimitFor('brightness'), null);
    const html = ui.renderIsParam('brightness');
    assert.ok(!html.includes('type="range"'), 'KHÔNG được render thanh trượt khi chưa biết ngưỡng');
    assert.ok(html.includes('UI không tự bịa ngưỡng') || html.includes('UI KHÔNG tự bịa ngưỡng'));
    assert.ok(ui.isLimitsNotice().includes('UI KHÔNG tự bịa ngưỡng'));
  });

  test('renderIsOptions nói rõ mọi mẫu nền là MÔ PHỎNG', () => {
    const state = doneState();
    const html = loadIsUi(state).renderIsOptions('create');
    assert.ok(html.includes('nền MÔ PHỎNG (không phải ảnh thật)'));
    assert.ok(html.includes('không resize / crop / bóp méo sản phẩm'));
  });

  test('template không khai synthetic ⇒ KHÔNG dán nhãn MÔ PHỎNG', () => {
    const state = makeIsState({ config: isConfigBlock(), is: { templates: [{ id: 'la', label: 'Lạ', synthetic: false }] } });
    const html = loadIsUi(state).renderIsTemplates();
    assert.ok(html.includes('Lạ'));
    assert.ok(!html.includes('MÔ PHỎNG'), 'mẫu không khai synthetic thì không được gán nhãn thay nó');
  });
});

describe('MVP-03 UI — options gửi lên API', () => {
  test('chỉ gửi tham số KHÁC 0; overlay chỉ gửi khi có chữ', () => {
    const state = doneState();
    const ui = loadIsUi(state);
    assert.deepEqual(ui.isJobOptions(), { template: 'trang', remove_background: true });

    state.is.options = { template: 'san-go', remove_background: false, retouch: { brightness: 0.1, contrast: 0, saturation: -0.3, sharpen: 0 }, overlay_text: '  Tai nghe  ' };
    assert.deepEqual(loadIsUi(state).isJobOptions(), {
      template: 'san-go',
      remove_background: false,
      retouch: { brightness: 0.1, saturation: -0.3 },
      overlay: { text: 'Tai nghe' },
    });
  });

  test('trạng thái busy ⇒ nút/nhập liệu bị khoá, đổi nhãn', () => {
    const state = doneState({ extraIs: { busy: true } });
    const html = loadIsUi(state).renderIsOptions('regenerate');
    assert.ok(html.includes('ĐANG GỬI…'));
    assert.match(html, /data-is-overlay\s+disabled/);
  });
});
