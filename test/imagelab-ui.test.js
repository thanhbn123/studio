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
  loadRenderIlWarnings,
  loadUiConst,
  loadUiFunction,
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
