/**
 * MVP-02 — TEST TẦNG GIAO DIỆN (public/app.js) CHẠY TRONG NODE.
 *
 * Vì sao cần: UI là bề mặt DUY NHẤT mà mọi test khác không chạm tới (agent test đã ghi rõ "chưa
 * phủ UI"), trong khi nó vừa phải (a) chống XSS — chữ Trung trong ảnh là dữ liệu KHÔNG tin cậy,
 * vừa (b) nói THẬT với người dùng: vùng nhãn hiệu bị khoá, job chạy mock phải hiện nhãn MOCK
 * theo DẤU VẾT CỦA JOB (không theo cấu hình máy chủ đang chạy — lỗi F-03 mà phản biện từng bắt).
 *
 * Cách làm: trích ĐÚNG hàm từ `public/app.js` rồi chạy trong Node (xem `imagelab-ui-helpers.js`),
 * nên test này bám vào mã UI thật, không phải bản chép lại.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadRenderIlJob,
  loadRenderIlManual,
  loadRenderIlWarnings,
  loadSaveIlManualRegions,
  loadUiConst,
  loadUiFunction,
  makeIlState,
  uiDeps,
} from './imagelab-ui-helpers.js';

const XSS = '<img src=x onerror=alert(1)>';
const XSS2 = '"><script>alert(1)</script>';

/** `renderIlReview` thật, với `state` giả và `renderIlSaveResult` rỗng. */
function makeRenderIlReview(overrides = new Set(), renderBlocked = null) {
  const deps = uiDeps();
  return loadUiFunction('renderIlReview', {
    esc: deps.esc,
    IL_KIND_LABEL: deps.IL_KIND_LABEL,
    IL_LINE_STATUS: deps.IL_LINE_STATUS,
    ilLocked: deps.ilLocked,
    state: { il: { overrides, renderBlocked, lastSave: null } },
    renderIlSaveResult: () => '',
  });
}

const jobData = (lineOverrides = {}, regionOverrides = {}) => ({
  regions: [
    { id: 'r1', kind: 'brand', kind_reason: 'logo thương hiệu', confidence: 0.9, ...regionOverrides },
    { id: 'r2', kind: 'descriptive', kind_reason: 'chữ mô tả', confidence: 0.8 },
  ],
  lines: [
    {
      region_id: 'r1',
      text_original: '品牌旗舰店',
      text_vi: '',
      status: 'SKIPPED_BRAND',
      provenance: 'none',
      violations: [],
      edited_by_user: false,
      ...(lineOverrides.r1 || {}),
    },
    {
      region_id: 'r2',
      text_original: '纯棉短袖T恤',
      text_vi: 'Áo thun cotton',
      status: 'TRANSLATED',
      provenance: 'ai',
      violations: [],
      edited_by_user: false,
      ...(lineOverrides.r2 || {}),
    },
  ],
});

describe('MVP-02 UI · renderIlReview — escape toàn bộ dữ liệu không tin cậy (XSS)', () => {
  test('chữ do OCR/DB trả về KHÔNG được tạo thẻ HTML thật', () => {
    const html = makeRenderIlReview()(jobData({
      r1: { text_original: XSS, text_vi: XSS2 },
      r2: { text_original: `${XSS}纯棉`, text_vi: `${XSS2} Áo thun`, violations: [XSS], provenance: XSS2 },
    }, { kind_reason: XSS }));

    // Bất biến ĐÚNG: chuỗi tấn công NGUYÊN VĂN không bao giờ được xuất hiện trong HTML, và
    // không được có thẻ mở thật. (Không dùng regex kiểu `\sonerror=` vì chuỗi ĐÃ escape vẫn
    // chứa chữ "onerror" — đó là dương tính giả của chính phép kiểm.)
    assert.ok(!html.includes('<img'), `KHÔNG được có thẻ <img> nguyên văn:\n${html.slice(0, 400)}`);
    assert.ok(!html.includes('<script'), 'KHÔNG được có thẻ <script> nguyên văn');
    assert.ok(!html.includes(XSS), 'payload XSS nguyên văn không được lọt vào HTML');
    assert.ok(!html.includes(XSS2), 'payload XSS thứ hai nguyên văn không được lọt vào HTML');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'phải thấy dạng ĐÃ escape');
    assert.match(html, /&lt;script&gt;/, 'phải thấy dạng ĐÃ escape của script');
  });

  test('region_id (dùng trong data-*) cũng phải được escape', () => {
    const html = makeRenderIlReview()(jobData({ r2: { region_id: XSS2 } }));
    assert.ok(!html.includes('data-region=""><script'), 'region_id không được phá vỡ thuộc tính HTML');
    assert.match(html, /data-region="&quot;&gt;&lt;script&gt;/);
  });
});

describe('MVP-02 UI · renderIlReview — vùng khoá phải KHOÁ THẬT và nói rõ lý do', () => {
  test('vùng nhãn hiệu: input bị `disabled` + hiện ghi chú khoá', () => {
    const html = makeRenderIlReview()(jobData());
    assert.match(html, /class="il-input"[^>]*disabled/, 'ô nhập của vùng nhãn hiệu phải bị disabled');
    assert.match(html, /🔒/, 'phải hiện ghi chú khoá');
    assert.match(html, /vẫn dịch vùng này/, 'phải có nút cho phép dịch (có ghi vết)');
  });

  test('vùng mô tả: KHÔNG bị khoá', () => {
    const html = makeRenderIlReview()(jobData());
    // Có đúng 1 ô input bị disabled (vùng nhãn hiệu), vùng mô tả vẫn sửa được.
    const disabled = html.match(/class="il-input"[^>]*disabled/g) || [];
    assert.equal(disabled.length, 1, `chỉ vùng nhãn hiệu bị khoá, nhận ${disabled.length}`);
  });

  test('người dùng đã cho phép override: ô nhập MỞ và có ghi chú sẽ thay chữ trên ảnh', () => {
    const html = makeRenderIlReview(new Set(['r1']))(jobData());
    const disabled = html.match(/class="il-input"[^>]*disabled/g) || [];
    assert.equal(disabled.length, 0, 'sau khi override, vùng nhãn hiệu phải sửa được');
    assert.match(html, /meta\.overrides/, 'phải nói rõ sẽ ghi vết vào meta.overrides');
    assert.match(html, /huỷ cho phép dịch/, 'nút phải đổi thành huỷ override');
  });

  test('còn dòng cần duyệt: hiện cảnh báo chặn render + nút VẪN RENDER có ghi vết', () => {
    const html = makeRenderIlReview(new Set(), 'Còn 1 dòng cần bạn duyệt.')(jobData());
    assert.match(html, /Chưa thể render/);
    assert.match(html, /VẪN RENDER \(bỏ qua cảnh báo — có ghi vết\)/);
  });
});

describe('MVP-02 UI · nhãn MOCK phải theo DẤU VẾT CỦA JOB (hồi quy F-03)', () => {
  const historyItemHtml = () => {
    const deps = uiDeps();
    return loadUiFunction('historyItemHtml', {
      esc: deps.esc,
      SOURCE_LABEL: loadUiConst('SOURCE_LABEL'),
      STATUS_LABEL: loadUiConst('STATUS_LABEL'),
    });
  };

  const base = {
    id: 'job-1',
    product_name: 'Áo thun',
    source: 'imagelab',
    status: 'awaiting_review',
    created_at: new Date('2026-10-03T10:00:00Z').toISOString(),
  };

  test('job dịch ảnh chạy mock ⇒ có badge "Dịch ảnh" + "MOCK"', () => {
    const html = historyItemHtml()({ ...base, kind: 'image_translation', mock: true, mock_steps: ['ocr', 'translate'] });
    assert.match(html, /Dịch ảnh/);
    assert.match(html, /MOCK/);
  });

  test('job dịch ảnh KHÔNG mock ⇒ có badge "Dịch ảnh" nhưng KHÔNG có MOCK', () => {
    const html = historyItemHtml()({ ...base, kind: 'image_translation', mock: false, mock_steps: [] });
    assert.match(html, /Dịch ảnh/);
    assert.ok(!/MOCK/.test(html), 'không được dán nhãn MOCK cho job chạy provider thật');
  });

  test('job MVP-01 (kind content) ⇒ KHÔNG có badge Dịch ảnh', () => {
    const html = historyItemHtml()({ ...base, kind: 'content', source: 'taobao' });
    assert.ok(!/Dịch ảnh/.test(html));
  });

  test('tên sản phẩm độc hại vẫn bị escape trong lịch sử', () => {
    const html = historyItemHtml()({ ...base, product_name: XSS, kind: 'content' });
    assert.ok(!html.includes('<img'), 'lịch sử cũng phải escape');
    assert.match(html, /&lt;img/);
  });
});

describe('MVP-02 UI · thông báo MOCK và thông báo lỗi nói thật', () => {
  test('ilMockNotice: có bước mock ⇒ cảnh báo MOCK; không có ⇒ chuỗi rỗng', () => {
    const deps = uiDeps();
    const ilMockNotice = loadUiFunction('ilMockNotice', { esc: deps.esc });
    const withMock = ilMockNotice({ ocr: { is_mock: true }, translate: { is_mock: false } });
    assert.match(withMock, /MOCK/);
    assert.match(withMock, /Không dùng để đánh giá chất lượng hoặc đăng bán/);
    assert.equal(ilMockNotice({ ocr: { is_mock: false }, translate: { is_mock: false } }), '');
    assert.equal(ilMockNotice({}), '');
  });

  test('ilErrorText: mã 5xx đã biết ⇒ dùng câu gợi ý tiếng Việt, KHÔNG dùng câu chung của server', () => {
    const deps = uiDeps();
    const ilErrorText = loadUiFunction('ilErrorText', { IL_ERROR_HINT: deps.IL_ERROR_HINT });
    const text = ilErrorText({ code: 'NOT_CONFIGURED', status: 502, message: 'Lỗi hệ thống. Vui lòng thử lại.' });
    assert.match(text, /^NOT_CONFIGURED: /);
    assert.match(text, /Provider OCR \/ dịch \/ render chưa được cấu hình/);
    assert.ok(!/Lỗi hệ thống/.test(text), 'không được hiện câu chung khi đã có gợi ý thật');
  });

  test('ilErrorText: mã lạ ⇒ rơi về message thật; lỗi 4xx ⇒ KHÔNG dùng bảng gợi ý 5xx', () => {
    const deps = uiDeps();
    const ilErrorText = loadUiFunction('ilErrorText', { IL_ERROR_HINT: deps.IL_ERROR_HINT });
    assert.match(ilErrorText({ code: 'LA_MA', status: 500, message: 'Hỏng gì đó' }), /Hỏng gì đó/);
    // 4xx: message của server là câu đã viết cho người dùng nên phải giữ nguyên.
    const four = ilErrorText({ code: 'NOT_CONFIGURED', status: 400, message: 'Thiếu ảnh.' });
    assert.match(four, /Thiếu ảnh\./);
  });
});

describe('MVP-02 UI · renderIlWarnings — cảnh báo thật, không giấu', () => {
  test('hiện glyph thiếu, vùng bị bỏ và trạng thái PARTIAL', () => {
    const renderIlWarnings = loadRenderIlWarnings();
    const html = renderIlWarnings({
      warnings: ['Provider khai đã áp dụng 1/1 op nhưng PIXEL trong hộp các op KHÔNG đổi'],
      ocr: { dropped: [{ reason: 'dưới ngưỡng tin cậy', text: 'x' }], warnings: ['OCR có cảnh báo'] },
      render_summary: {
        status: 'PARTIAL',
        error_code: 'NO_OPS',
        unsupported_glyphs: ['€'],
        skipped: [{ region_id: 'r1', reason: 'BOX_OVERLAPS_PROTECTED: r2 (brand)' }],
      },
    });
    assert.match(html, /PARTIAL/);
    assert.match(html, /€/, 'glyph thiếu phải hiện ra');
    assert.match(html, /BOX_OVERLAPS_PROTECTED/);
    assert.match(html, /dưới ngưỡng tin cậy/);
  });

  test('data rỗng ⇒ vẫn trả chuỗi HTML (không ném lỗi)', () => {
    const renderIlWarnings = loadRenderIlWarnings();
    assert.equal(typeof renderIlWarnings({}), 'string');
    assert.equal(typeof renderIlWarnings(null), 'string');
  });
});

/* ═══════════════════════ IL-08 — NHẬP VÙNG CHỮ BẰNG TAY (§11.3) ═══════════════════════
 *
 * Vì sao phủ riêng: đây là đường dùng được trên ẢNH THẬT khi OCR còn là mock. Chữ trong
 * bảng do NGƯỜI DÙNG gõ (dữ liệu không tin cậy) nên phải escape; và khi job đã có bản sửa
 * tay thì UI phải cảnh báo trước khi thay vùng, không được thay im lặng.
 *
 * Mọi hàm dưới đây được TRÍCH từ `public/app.js` (xem `imagelab-ui-helpers.js`) — không chép tay.
 */

/** Job imagelab tối thiểu đúng hình dạng API trả về, có sẵn 1 vùng nhập tay. */
const manualJob = (over = {}) => ({
  job: { id: 'job-1', status: 'awaiting_review', stage: 'awaiting_review' },
  asset: { id: 'a1', width: 320, height: 320 },
  regions: [
    { id: 'u1', box: { x: 10, y: 20, w: 100, h: 30 }, text: '纯棉短袖T恤', kind: 'descriptive', translatable: true, source: 'user' },
  ],
  lines: [
    {
      region_id: 'u1',
      text_original: '纯棉短袖T恤',
      text_vi: 'Áo thun cotton',
      status: 'GLOSSARY',
      provenance: 'glossary',
      edited_by_user: false,
      violations: [],
    },
  ],
  ...over,
});

/** `state` + bảng nhập tay đã có 1 dòng hợp lệ (đúng thứ người dùng gõ). */
const il08State = ({ manual = {}, ...over } = {}) =>
  makeIlState({
    job: manualJob(),
    manual: {
      open: true,
      rows: [{ x: '10', y: '20', w: '100', h: '30', text: '纯棉短袖T恤', kind: 'descriptive' }],
      ...manual,
    },
    ...over,
  });

describe('IL-08 UI · bảng nhập vùng chữ — escape toàn bộ chữ người dùng gõ (XSS)', () => {
  test('(a) chữ trong ô nhập KHÔNG tạo thẻ HTML thật, chỉ có dạng đã escape', () => {
    const state = il08State({
      manual: { rows: [{ x: '1', y: '2', w: '10', h: '20', text: XSS, kind: 'descriptive' }] },
    });
    const html = loadRenderIlManual(state)(state.il.job);

    assert.match(html, /id="il-manual"/, 'phải render khối nhập tay');
    assert.ok(!html.includes('<img'), `KHÔNG được có thẻ <img> nguyên văn:\n${html.slice(0, 500)}`);
    assert.ok(!html.includes(XSS), 'payload XSS nguyên văn không được lọt vào HTML');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'phải thấy dạng ĐÃ escape');
  });

  test('(a2) lý do `rejected` do máy chủ trả cũng bị escape', () => {
    const state = il08State({
      manual: { rejected: { items: [{ index: 0, row: 1, reason: `${XSS2} lý do thật` }] } },
    });
    const html = loadRenderIlManual(state)(state.il.job);

    assert.ok(!html.includes('<script'), 'lý do từ chối không được tạo thẻ script');
    assert.ok(!html.includes(XSS2), 'payload nguyên văn không được lọt vào HTML');
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('IL-08 UI · 409 MANUAL_EDITS_WOULD_BE_LOST — cảnh báo rõ + nút xác nhận', () => {
  test('(b1) có xung đột ⇒ hiện cảnh báo và nút "Vẫn thay (mất bản sửa tay)"', () => {
    const state = il08State({
      manual: { conflict: { message: 'Job đang có 1 dòng người dùng đã sửa tay (u1) — thay toàn bộ vùng sẽ làm MẤT bản sửa đó.' } },
    });
    const html = loadRenderIlManual(state)(state.il.job);

    assert.match(html, /MANUAL_EDITS_WOULD_BE_LOST/);
    assert.match(html, /Vẫn thay \(mất bản sửa tay\)/);
    assert.match(html, /data-action="ilmanualforce"/, 'nút xác nhận phải có hành động thật');
    assert.match(html, /1 dòng người dùng đã sửa tay/, 'phải hiện câu máy chủ giải thích');
  });

  test('(b2) lần lưu đầu gặp 409 ⇒ ghi `conflict` (KHÔNG phải lỗi chung) và KHÔNG tự xác nhận thay', async () => {
    const state = il08State();
    const err = Object.assign(new Error('Job đang có 1 dòng người dùng đã sửa tay'), { code: 'MANUAL_EDITS_WOULD_BE_LOST' });
    const { save, apiCalls } = loadSaveIlManualRegions(state, { apiError: err });

    await save(false);

    assert.equal(apiCalls.length, 1);
    assert.equal(apiCalls[0].url, '/api/imagelab/jobs/job-1/regions');
    assert.equal(apiCalls[0].opts.method, 'PUT');
    assert.equal(apiCalls[0].opts.body.replace, true, 'lưu vùng là thay toàn bộ (replace: true)');
    assert.equal(apiCalls[0].opts.body.confirm_replace_edited, undefined, 'lần đầu KHÔNG được tự xác nhận thay');
    assert.equal(state.il.manual.error, null, 'xung đột không phải lỗi chung');
    assert.match(state.il.manual.conflict.message, /sửa tay/);

    const html = loadRenderIlManual(state)(state.il.job);
    assert.match(html, /data-action="ilmanualforce"/);
  });

  test('(b3) bấm "Vẫn thay" ⇒ gửi confirm_replace_edited: true và xoá xung đột', async () => {
    const state = il08State();
    const err = Object.assign(new Error('mất bản sửa tay'), { code: 'MANUAL_EDITS_WOULD_BE_LOST' });
    await loadSaveIlManualRegions(state, { apiError: err }).save(false);
    assert.ok(state.il.manual.conflict, 'phải đang ở trạng thái xung đột');

    const second = loadSaveIlManualRegions(state, {
      apiResult: { regions: [{ id: 'u9', box: { x: 10, y: 20, w: 100, h: 30 }, text: '纯棉短袖T恤', kind: 'descriptive', source: 'user' }], lines: [], rejected: [], warnings: [] },
    });
    await second.save(true);

    assert.equal(second.apiCalls[0].opts.body.confirm_replace_edited, true, 'phải gửi xác nhận thay');
    assert.equal(second.apiCalls[0].opts.body.replace, true);
    assert.equal(state.il.manual.conflict, null, 'thành công thì xoá cảnh báo xung đột');
    assert.match(state.il.manual.notice, /nguồn = người dùng/);
  });
});

describe('IL-08 UI · `rejected` — hiện "dòng N" + lý do từ chối', () => {
  test('(c) index 0-based của máy chủ được đổi thành số dòng 1-based và hiện kèm lý do', async () => {
    const state = il08State({
      manual: {
        rows: [
          { x: '10', y: '20', w: '100', h: '30', text: '纯棉短袖T恤', kind: 'descriptive' },
          { x: '900', y: '900', w: '50', h: '50', text: '外景', kind: 'descriptive' },
        ],
      },
    });
    const { save } = loadSaveIlManualRegions(state, {
      apiResult: {
        regions: [{ id: 'u1', box: { x: 10, y: 20, w: 100, h: 30 }, text: '纯棉短袖T恤', kind: 'descriptive', source: 'user' }],
        lines: [],
        rejected: [{ index: 1, reason: 'BOX_OUTSIDE_IMAGE: hộp nằm ngoài khung ảnh (giao rỗng sau khi cắt)' }],
        warnings: ['Vùng #2 bị cắt vào biên ảnh.'],
      },
    });

    await save(false);

    assert.equal(state.il.manual.rejected.items.length, 1);
    assert.equal(state.il.manual.rejected.items[0].index, 1);
    assert.equal(state.il.manual.rejected.items[0].row, 2, 'index 1 (0-based) = dòng 2 trong bảng');
    assert.match(state.il.manual.notice, /1 vùng bị máy chủ từ chối/);

    const html = loadRenderIlManual(state)(state.il.job);
    assert.match(html, /dòng 2/, 'phải nói rõ dòng nào trong bảng');
    assert.match(html, /BOX_OUTSIDE_IMAGE/, 'phải hiện mã lý do');
    assert.match(html, /hộp nằm ngoài khung ảnh/, 'phải hiện câu tiếng Việt cho người dùng');
    assert.match(html, /Vùng #2 bị cắt vào biên ảnh/, 'cảnh báo của máy chủ cũng phải hiện');
  });
});

describe('IL-08 UI · renderIlJob — khối nhập tay nằm trong màn job và nói THẬT về nguồn/khoá', () => {
  test('(d) renderIlJob thật có khối nhập tay + câu nguồn = người dùng + nhãn hiệu/chứng nhận/giá vẫn bị KHOÁ', () => {
    const state = il08State();
    const html = loadRenderIlJob(state)();

    assert.match(html, /Nhập vùng chữ bằng tay/);
    assert.match(html, /nguồn = người dùng/);
    assert.match(html, /nhãn hiệu \/ chứng nhận \/ giá vẫn bị KHOÁ/);
    assert.match(html, /LƯU VÙNG &amp; DỊCH/);
  });

  test('(d2) job chưa có vùng nào ⇒ khối mở sẵn và nói rõ vì sao mở', () => {
    const state = makeIlState({ job: manualJob({ regions: [], lines: [] }) });
    const html = loadRenderIlJob(state)();

    assert.match(html, /Chưa có dòng nào/, 'bảng phải mở sẵn để người dùng nhập ngay');
    assert.match(html, /job chưa có vùng chữ nào/, 'phải nói rõ vì sao khối mở sẵn');
  });
});
