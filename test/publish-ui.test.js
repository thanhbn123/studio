/**
 * TEST MVP-07 · P4 — UI MÀN “ĐĂNG BÀI” (`public/app.js`), hợp đồng §5.
 *
 * Cách làm giống `test/export-ui-helpers.js`: TRÍCH ĐÚNG mã hàm/const từ `public/app.js`
 * (không chép lại tay) rồi biên dịch trong Node với `state`/`document` giả. UI đổi cấu trúc ⇒
 * `loadUiFunction` NÉM LỖI RÕ RÀNG, không im lặng bỏ qua.
 *
 * `esc` được trích THẬT từ `public/app.js` để khẳng định escape XSS đúng bằng hàm mà trình
 * duyệt sẽ chạy.
 *
 * Ba điều UI BẮT BUỘC nói thật (hợp đồng §5) đều có test riêng ở đây:
 *   1. `dry-run` ⇒ “CHẾ ĐỘ THỬ — không đăng thật”.
 *   2. `facebook` chưa có token ⇒ “chưa cấu hình Facebook (cần Page ID + token)”.
 *   3. Bài chưa duyệt ⇒ nút ĐĂNG NGAY **disabled** + câu “phải được DUYỆT trước khi đăng”.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadUiConst, loadUiConstValue, loadUiFunction } from './imagelab-ui-helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const esc = () => loadUiFunction('esc', {});

/** State tối thiểu đúng hình dạng `state.pub` của app (không cần DOM). */
function makeState({ config = {}, pub = {}, me = null } = {}) {
  return {
    view: 'home',
    config,
    auth: { me, loaded: true, loading: false, error: null },
    pub: {
      items: [],
      total: 0,
      scope: 'mine',
      canApprove: false,
      filter: '',
      loading: false,
      creating: false,
      busyId: null,
      error: null,
      jobs: [],
      draft: { jobId: '', text: '' },
      ...pub,
    },
  };
}

/** Nạp các hàm THẬT của khối “Đăng bài”. */
function loadPublishUi(state) {
  const e = esc();
  const PUB_STATUS_LABEL = loadUiConst('PUB_STATUS_LABEL');
  const PUB_STATUS_CLASS = loadUiConst('PUB_STATUS_CLASS');
  const PUB_ERROR_HINT = loadUiConst('PUB_ERROR_HINT');
  const consts = {
    PUB_DRY_RUN_LINE: loadUiConstValue('PUB_DRY_RUN_LINE'),
    PUB_NOT_CONFIGURED_LINE: loadUiConstValue('PUB_NOT_CONFIGURED_LINE'),
    PUB_MANUAL_LINE: loadUiConstValue('PUB_MANUAL_LINE'),
    PUB_NEED_LOGIN_LINE: loadUiConstValue('PUB_NEED_LOGIN_LINE'),
    PUB_NOT_APPROVED_HINT: loadUiConstValue('PUB_NOT_APPROVED_HINT'),
  };
  const pubConfig = loadUiFunction('pubConfig', { state });
  const pubStatusBadge = loadUiFunction('pubStatusBadge', { esc: e, PUB_STATUS_LABEL, PUB_STATUS_CLASS });
  const pubProviderNotice = loadUiFunction('pubProviderNotice', {
    esc: e,
    pubConfig,
    PUB_DRY_RUN_LINE: consts.PUB_DRY_RUN_LINE,
    PUB_NOT_CONFIGURED_LINE: consts.PUB_NOT_CONFIGURED_LINE,
    PUB_MANUAL_LINE: consts.PUB_MANUAL_LINE,
  });
  const pubPreviewText = loadUiFunction('pubPreviewText', {});
  const pubMediaHtml = loadUiFunction('pubMediaHtml', { esc: e });
  const pubResultHtml = loadUiFunction('pubResultHtml', { esc: e });
  const pubLastErrorHtml = loadUiFunction('pubLastErrorHtml', { esc: e });
  const pubItemActions = loadUiFunction('pubItemActions', { esc: e, state, PUB_NOT_APPROVED_HINT: consts.PUB_NOT_APPROVED_HINT });
  const pubItemCard = loadUiFunction('pubItemCard', {
    esc: e,
    pubStatusBadge,
    pubPreviewText,
    pubMediaHtml,
    pubResultHtml,
    pubLastErrorHtml,
    pubItemActions,
  });
  const pubErrorText = loadUiFunction('pubErrorText', { PUB_ERROR_HINT });
  return { esc: e, ...consts, PUB_STATUS_LABEL, pubConfig, pubStatusBadge, pubProviderNotice, pubPreviewText, pubMediaHtml, pubResultHtml, pubLastErrorHtml, pubItemActions, pubItemCard, pubErrorText };
}

const item = (over = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  job_id: 'job-1',
  channel: 'facebook_page',
  provider: 'dry-run',
  text: 'Nội dung bài',
  media_ids: [],
  status: 'draft',
  scheduled_at: null,
  approved_by: null,
  approved_at: null,
  rejected_by: null,
  rejected_at: null,
  reject_reason: null,
  published_at: null,
  external_post_id: null,
  external_url: null,
  is_mock: false,
  error_code: null,
  last_error: null,
  attempts: 0,
  created_at: '2026-10-09T00:00:00.000Z',
  updated_at: '2026-10-09T00:00:00.000Z',
  ...over,
});

/* ══════════════ băng trạng thái provider (luật §5) ══════════════ */

describe('MVP-07 UI — băng trạng thái provider nói THẬT (§5)', () => {
  test('provider `dry-run` ⇒ hiện rõ “CHẾ ĐỘ THỬ — không đăng thật”', () => {
    const state = makeState({ config: { publish: { available: true, provider: { name: 'dry-run', configured: true, is_mock: true } } } });
    const ui = loadPublishUi(state);
    const html = ui.pubProviderNotice();
    assert.match(html, /CHẾ ĐỘ THỬ — không đăng thật/);
    assert.match(html, /notice warn/);
    assert.match(html, /dry-/, 'phải nói rõ mã bài có tiền tố dry-');
    assert.match(html, /KHÔNG BAO GIỜ tự đăng/, 'phải nhắc luật duyệt tay');
  });

  test('provider `facebook` chưa có token ⇒ “chưa cấu hình Facebook (cần Page ID + token)”', () => {
    const state = makeState({ config: { publish: { available: true, provider: { name: 'facebook', configured: false, is_mock: false } } } });
    const ui = loadPublishUi(state);
    const html = ui.pubProviderNotice();
    assert.match(html, /chưa cấu hình Facebook \(cần Page ID \+ token\)/);
    assert.match(html, /notice error/);
    assert.match(html, /FACEBOOK_PAGE_ACCESS_TOKEN/, 'phải nói rõ biến môi trường cần khai');
    assert.ok(!/CHẾ ĐỘ THỬ/.test(html), 'chưa cấu hình KHÔNG được hiện là chế độ thử');
  });

  test('provider `facebook` ĐÃ cấu hình ⇒ cảnh báo bài sẽ đăng THẬT', () => {
    const state = makeState({ config: { publish: { available: true, provider: { name: 'facebook', configured: true, is_mock: false } } } });
    const ui = loadPublishUi(state);
    const html = ui.pubProviderNotice();
    assert.match(html, /đăng THẬT/);
    assert.match(html, /notice ok/);
  });

  test('khối publish không khả dụng ⇒ hiện LÝ DO thật của máy chủ', () => {
    const state = makeState({ config: { publish: { available: false, reason: 'Không nạp được module MVP-07.' } } });
    const ui = loadPublishUi(state);
    const html = ui.pubProviderNotice();
    assert.match(html, /PUBLISH_UNAVAILABLE/);
    assert.match(html, /Không nạp được module MVP-07/);
  });

  test('/api/config thiếu khối `publish` ⇒ nói “chưa biết trạng thái”, KHÔNG đoán là sẵn sàng', () => {
    const state = makeState({ config: {} });
    const ui = loadPublishUi(state);
    const html = ui.pubProviderNotice();
    assert.match(html, /Chưa biết trạng thái đăng bài/);
    assert.ok(!/Sẵn sàng/.test(html));
  });
});

/* ══════════════ nút ĐĂNG NGAY chỉ bật khi đã duyệt ══════════════ */

describe('MVP-07 UI — nút ĐĂNG NGAY chỉ BẬT khi bài đã duyệt (§5)', () => {
  const cfg = { publish: { available: true, can_approve: true, provider: { name: 'dry-run', configured: true, is_mock: true } } };

  test('bài `draft`/`pending_review` ⇒ nút ĐĂNG NGAY bị `disabled` + câu giải thích', () => {
    for (const status of ['draft', 'pending_review']) {
      const state = makeState({ config: cfg, pub: { canApprove: true } });
      const ui = loadPublishUi(state);
      const html = ui.pubItemActions(item({ status }));
      assert.match(html, /data-action="pubpublish"[^>]*disabled/, `status=${status}: nút đăng phải bị khoá`);
      assert.match(html, /phải được DUYỆT trước khi đăng/i, `status=${status}: phải giải thích lý do`);
    }
  });

  test('bài `approved` ⇒ nút ĐĂNG NGAY BẬT, không còn câu nhắc duyệt', () => {
    const state = makeState({ config: cfg, pub: { canApprove: true } });
    const ui = loadPublishUi(state);
    const html = ui.pubItemActions(item({ status: 'approved', approved_by: 'admin-1' }));
    assert.match(html, /data-action="pubpublish"/);
    assert.ok(!/data-action="pubpublish"[^>]*disabled/.test(html), 'bài đã duyệt thì nút đăng phải bật');
    assert.ok(!/phải được DUYỆT/.test(html));
  });

  test('bài `failed` ⇒ vẫn đăng lại được (đã từng duyệt)', () => {
    const state = makeState({ config: cfg, pub: { canApprove: true } });
    const ui = loadPublishUi(state);
    const html = ui.pubItemActions(item({ status: 'failed', approved_by: 'admin-1' }));
    assert.ok(!/data-action="pubpublish"[^>]*disabled/.test(html));
  });

  test('bài `published`/`rejected` ⇒ KHÔNG còn nút đăng nào', () => {
    for (const status of ['published', 'rejected']) {
      const state = makeState({ config: cfg, pub: { canApprove: true } });
      const ui = loadPublishUi(state);
      const html = ui.pubItemActions(item({ status }));
      assert.ok(!/data-action="pubpublish"/.test(html), `status=${status}: không được còn nút đăng`);
    }
  });

  test('`member` (không có quyền duyệt) ⇒ KHÔNG hiện nút DUYỆT / TỪ CHỐI', () => {
    // `can_approve` của máy chủ là nguồn DUY NHẤT: đặt `true` trong /api/config (chỗ máy chủ
    // KHÔNG hề gửi) cũng không được mở nút duyệt ra.
    const state = makeState({
      config: { publish: { available: true, can_approve: true, provider: { name: 'dry-run', configured: true, is_mock: true } } },
      pub: { canApprove: false },
    });
    const ui = loadPublishUi(state);
    const html = ui.pubItemActions(item({ status: 'pending_review' }));
    assert.ok(!/data-action="pubapprove"/.test(html), 'member không được thấy nút DUYỆT');
    assert.ok(!/data-action="pubreject"/.test(html), 'member không được thấy nút TỪ CHỐI');
    assert.match(html, /data-action="pubpublish"[^>]*disabled/);
  });

  test('owner/admin ⇒ có nút DUYỆT và TỪ CHỐI cho bài chờ duyệt', () => {
    const state = makeState({ config: cfg, pub: { canApprove: true } });
    const ui = loadPublishUi(state);
    const html = ui.pubItemActions(item({ status: 'pending_review' }));
    assert.match(html, /data-action="pubapprove"/);
    assert.match(html, /data-action="pubreject"/);
  });

  test('đang có thao tác chạy (`busyId`) ⇒ mọi nút của bài đó bị khoá', () => {
    const it = item({ status: 'approved' });
    const state = makeState({ config: cfg, pub: { canApprove: true, busyId: it.id } });
    const ui = loadPublishUi(state);
    const html = ui.pubItemActions(it);
    assert.match(html, /data-action="pubpublish"[^>]*disabled/);
  });
});

/* ══════════════ xem trước + nói thật về id thử ══════════════ */

describe('MVP-07 UI — xem trước nội dung, ảnh, kết quả (§5)', () => {
  const state = () => makeState({ config: { publish: { available: true, can_approve: true, provider: { name: 'dry-run', configured: true, is_mock: true } } } });

  test('mã bài `dry-` ⇒ nói rõ “id thử — không có bài thật”, KHÔNG có link Facebook', () => {
    const ui = loadPublishUi(state());
    const html = ui.pubResultHtml(item({ status: 'published', external_post_id: 'dry-abc123', is_mock: true }));
    assert.match(html, /dry-abc123/);
    assert.match(html, /id thử — không có bài thật/);
    assert.ok(!/facebook\.com/.test(html), 'id thử KHÔNG được kèm link bài');
  });

  test('mã bài THẬT ⇒ có link mở bài trên Facebook', () => {
    const ui = loadPublishUi(state());
    const html = ui.pubResultHtml(item({ status: 'published', external_post_id: '999_111', external_url: 'https://www.facebook.com/999_111', is_mock: false }));
    assert.match(html, /mở bài trên Facebook/);
    assert.match(html, /https:\/\/www\.facebook\.com\/999_111/);
    assert.ok(!/id thử/.test(html));
  });

  test('lỗi lần đăng gần nhất hiện NGUYÊN VĂN (không nuốt)', () => {
    const ui = loadPublishUi(state());
    const msg = '(#200) The user hasn\'t authorized the application';
    const html = ui.pubLastErrorHtml(item({ status: 'failed', error_code: 'PROVIDER_FAILED', last_error: msg }));
    assert.match(html, /PROVIDER_FAILED/);
    assert.match(html, /authorized the application/);
  });

  test('bài không có media ⇒ nói rõ “chỉ có chữ”, không vẽ thẻ ảnh rỗng', () => {
    const ui = loadPublishUi(state());
    const html = ui.pubMediaHtml(item({ media_ids: [] }));
    assert.match(html, /chỉ có chữ/);
    assert.ok(!/<img/.test(html));
  });

  test('bài có media ⇒ dùng ĐÚNG route tệp ảnh của MVP-02 (không ghép đường dẫn đĩa)', () => {
    const ui = loadPublishUi(state());
    const html = ui.pubMediaHtml(item({ media_ids: ['asset-1'] }));
    assert.match(html, /\/api\/imagelab\/assets\/asset-1\/file/);
    assert.ok(!/data\/imagelab/.test(html), 'KHÔNG được lộ đường dẫn đĩa');
  });

  test('xem trước cắt gọn nội dung dài nhưng KHÔNG sửa chữ', () => {
    const ui = loadPublishUi(state());
    assert.equal(ui.pubPreviewText('abc'), 'abc');
    const long = ui.pubPreviewText('x'.repeat(500), { max: 10 });
    assert.equal(long, `${'x'.repeat(10)}…`);
  });
});

/* ══════════════ XSS: mọi text động đi qua esc() ══════════════ */

describe('MVP-07 UI — escape XSS bằng `esc()` THẬT của app (§5)', () => {
  const state = () => makeState({ config: { publish: { available: true, can_approve: true, provider: { name: '<img src=x onerror=alert(1)>', configured: true, is_mock: true } } } });

  test('nội dung bài chứa thẻ HTML ⇒ bị escape, không lọt thẻ thật', () => {
    const ui = loadPublishUi(state());
    const html = ui.pubItemCard(item({ text: '<script>alert(1)</script>', status: 'draft' }));
    assert.ok(!html.includes('<script>'), 'thẻ script KHÔNG được lọt vào DOM');
    assert.match(html, /&lt;script&gt;/);
  });

  test('tên provider độc hại trong /api/config cũng bị escape', () => {
    const ui = loadPublishUi(state());
    const html = ui.pubProviderNotice();
    assert.ok(!html.includes('<img src=x'), 'tên provider phải được escape');
    assert.match(html, /&lt;img src=x/);
  });

  test('lý do từ chối + lỗi nền tảng cũng bị escape', () => {
    const ui = loadPublishUi(state());
    const html = ui.pubItemCard(item({ status: 'rejected', rejected_by: 'a"><b>', reject_reason: '<i>x</i>', last_error: '<u>y</u>' }));
    assert.ok(!html.includes('<b>'));
    assert.ok(!html.includes('<i>'));
    assert.ok(!html.includes('<u>'));
  });

  test('mã bài độc hại cũng bị escape (không tạo được link giả)', () => {
    const ui = loadPublishUi(state());
    const html = ui.pubResultHtml(item({ status: 'published', external_post_id: '"><script>x</script>', is_mock: false }));
    assert.ok(!html.includes('<script>'));
  });
});

/* ══════════════ nhãn trạng thái + câu lỗi ══════════════ */

describe('MVP-07 UI — nhãn trạng thái và câu lỗi', () => {
  test('bảy trạng thái của hợp đồng đều có nhãn tiếng Việt', () => {
    const ui = loadPublishUi(makeState());
    for (const s of ['draft', 'pending_review', 'approved', 'publishing', 'published', 'failed', 'rejected']) {
      assert.ok(String(ui.PUB_STATUS_LABEL[s] || '').length > 0, `thiếu nhãn cho trạng thái ${s}`);
    }
  });

  test('`NOT_APPROVED` ⇒ câu nói rõ phải duyệt trước', () => {
    const ui = loadPublishUi(makeState());
    const text = ui.pubErrorText({ code: 'NOT_APPROVED', status: 409, message: 'Bài CHƯA được duyệt nên hệ thống không đăng.' });
    assert.match(text, /DUYỆT/i);
    assert.match(text, /409/);
    assert.match(text, /CHƯA được duyệt/);
  });

  test('`UNAUTHENTICATED` ⇒ câu nói cần đăng nhập', () => {
    const ui = loadPublishUi(makeState());
    assert.match(ui.pubErrorText({ code: 'UNAUTHENTICATED', status: 401 }), /đăng nhập/i);
  });

  test('`NOT_CONFIGURED` ⇒ câu nói chưa cấu hình Facebook', () => {
    const ui = loadPublishUi(makeState());
    assert.match(ui.pubErrorText({ code: 'NOT_CONFIGURED', status: 409 }), /Page ID/);
  });

  test('mã lạ ⇒ vẫn in HTTP status thật, KHÔNG nuốt lỗi', () => {
    const ui = loadPublishUi(makeState());
    assert.match(ui.pubErrorText({ code: 'LA_LUNG', status: 500 }), /HTTP 500 LA_LUNG/);
  });
});

/* ══════════════ tab điều hướng + lời khai trung thực trong index.html ══════════════ */

describe('MVP-07 UI — tab “Đăng bài” và lời khai trong index.html', () => {
  test('index.html có nút điều hướng “Đăng bài”', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    assert.match(html, /data-action="publish"[^>]*>Đăng bài</);
  });

  test('index.html nói THẬT: duyệt tay + mặc định chế độ thử (chưa có token)', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    assert.match(html, /DUYỆT TAY/);
    assert.match(html, /CHẾ ĐỘ THỬ/);
    assert.match(html, /chưa có Page ID \+ token/);
  });

  test('app.js có route hash `#/dangbai` và 6 handler nút của khối đăng bài', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    assert.match(src, /hash\.startsWith\('#\/dangbai'\)/);
    for (const action of ['pubreload', 'pubfilter', 'pubcreate', 'pubsubmit', 'pubapprove', 'pubreject', 'pubpublish']) {
      assert.match(src, new RegExp(`\\n\\s+${action}:`), `thiếu handler data-action="${action}"`);
    }
  });
});
