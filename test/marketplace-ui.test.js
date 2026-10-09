/**
 * TEST MVP-08 · UI (`public/app.js`) — hợp đồng §5 + luật cứng UI (docs/UI-HANDOVER.md §3).
 *
 * Trích ĐÚNG mã hàm thật từ `public/app.js` (loadUiFunction) — chạy trên mã UI thật, không chép tay.
 * Phủ: băng “CHẾ ĐỘ THỬ — không đăng thật” cho kênh dry-run; “chưa có token…” cho kênh chưa cấu hình;
 * `issues[]` hiện TỪNG DÒNG; nút khoá kèm LÝ DO; escape XSS cho tiêu đề / mã lỗi sàn / external_id /
 * lý do từ chối / issues; nhãn THỬ cho kết quả mock.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { loadUiFunction, loadUiConst, loadUiConstValue } from './imagelab-ui-helpers.js';

const XSS = '"><img src=x onerror=alert(1)>';

function makeUi({ channels = null, liveEnabled = false, mk = {} } = {}) {
  const state = {
    config: {
      marketplace: {
        enabled: true,
        live_enabled: liveEnabled,
        default_channel: 'dry-run',
        channels: channels || [
          { name: 'dry-run', configured: true, is_mock: true, capabilities: { createListing: true, readListing: true }, notice: 'CHẾ ĐỘ THỬ — không đăng thật. Không gửi gì lên sàn; mã bài có tiền tố "dry-".', error: null },
          { name: 'shopee', configured: false, is_mock: false, capabilities: { createListing: true, readListing: true }, notice: 'chưa có token Shopee (cần tài khoản người bán được duyệt trên Shopee Open Platform: partner id, partner key, shop id, access token)', error: null },
          { name: 'tiktokshop', configured: true, is_mock: false, capabilities: { createListing: true, readListing: true }, notice: 'đã có cấu hình TikTok Shop nhưng MARKETPLACE_LIVE_ENABLED=false — chưa gọi sàn thật', error: null },
        ],
      },
    },
    mk: { listings: null, total: null, jobs: null, loading: false, busy: false, draft: { job_id: '', channel: '' }, issues: null, error: null, notice: null, listError: null, filter: { status: '' }, payloadId: null, payloadData: null, rejectId: null, rejectDraft: '', ...mk },
  };
  const esc = loadUiFunction('esc');
  const fmtAmount = loadUiFunction('fmtAmount');
  const fmtTime = loadUiFunction('fmtTime');
  const MK_STATUS_LABEL = loadUiConst('MK_STATUS_LABEL');
  const MK_STATUS_CLASS = loadUiConstValue('MK_STATUS_CLASS');
  const MK_DRY_RUN_BANNER = loadUiConstValue('MK_DRY_RUN_BANNER');
  const MK_ERROR_HINT = loadUiConst('MK_ERROR_HINT');
  const mkConfig = loadUiFunction('mkConfig', { state });
  const mkChannelInfo = loadUiFunction('mkChannelInfo', { mkConfig });
  const mkStatusLabel = loadUiFunction('mkStatusLabel', { MK_STATUS_LABEL });
  const mkVnd = loadUiFunction('mkVnd');
  const mkBannerHtml = loadUiFunction('mkBannerHtml', { esc, mkChannelInfo, mkConfig, MK_DRY_RUN_BANNER });
  const mkIssuesHtml = loadUiFunction('mkIssuesHtml', { esc });
  const mkButton = loadUiFunction('mkButton', { esc });
  const renderMkChannels = loadUiFunction('renderMkChannels', { esc, mkConfig });
  const renderMkTable = loadUiFunction('renderMkTable', { state, esc, fmtTime, mkChannelInfo, mkStatusLabel, mkIssuesHtml, mkButton, mkVnd, MK_STATUS_CLASS });
  const renderMkPayload = loadUiFunction('renderMkPayload', { state, esc, fmtTime, mkBannerHtml, mkIssuesHtml });
  return { state, mkBannerHtml, mkIssuesHtml, renderMkChannels, renderMkTable, renderMkPayload, mkStatusLabel, mkVnd, MK_ERROR_HINT, MK_DRY_RUN_BANNER };
}

const LISTING = (over = {}) => ({
  id: 'L1', job_id: 'J1', user_id: 'U1', channel: 'dry-run', status: 'pending_review', external_id: null, external_url: null, is_mock: false,
  error_code: null, last_error: null, attempts: 0, issues: [], title: 'Tai nghe', price_vnd: 199000, stock: 7, created_at: '2026-10-10T00:00:00Z', ...over,
});

describe('MVP-08 · UI — băng nói thật theo kênh', () => {
  const ui = makeUi();
  test('kênh dry-run ⇒ “CHẾ ĐỘ THỬ — không đăng thật”', () => {
    const html = ui.mkBannerHtml('dry-run');
    assert.match(html, /CHẾ ĐỘ THỬ — không đăng thật/);
    assert.match(html, /data-mk-banner="dry-run"/);
    assert.equal(ui.MK_DRY_RUN_BANNER, 'CHẾ ĐỘ THỬ — không đăng thật');
  });
  test('kênh chưa cấu hình ⇒ nói “chưa có token Shopee … tài khoản người bán được duyệt”, KHÔNG có chữ LIVE', () => {
    const html = ui.mkBannerHtml('shopee');
    assert.match(html, /chưa có token Shopee/);
    assert.match(html, /tài khoản người bán được duyệt/);
    assert.match(html, /data-mk-banner="not-configured"/);
    assert.doesNotMatch(html, /gọi API THẬT/);
  });
  test('kênh có cấu hình nhưng live tắt ⇒ nói rõ MARKETPLACE_LIVE_ENABLED=false; live bật ⇒ “gọi API THẬT”', () => {
    assert.match(ui.mkBannerHtml('tiktokshop'), /chưa bật gọi sàn thật/);
    const live = makeUi({ liveEnabled: true });
    assert.match(live.mkBannerHtml('tiktokshop'), /gọi API THẬT/);
  });
  test('kênh lỗi khởi tạo ⇒ hiện mã + câu, không giả vờ chạy', () => {
    const broken = makeUi({ channels: [{ name: 'shopee', configured: false, is_mock: false, error: { code: 'PROVIDER_BROKEN', message: 'cấu hình rác' }, notice: '' }] });
    assert.match(broken.mkBannerHtml('shopee'), /PROVIDER_BROKEN/);
    assert.match(broken.mkBannerHtml('shopee'), /cấu hình rác/);
  });
  test('renderMkChannels: thiếu khối marketplace ⇒ nói thật máy chủ chưa bật; có ⇒ mỗi kênh một badge', () => {
    assert.match(ui.renderMkChannels(), /dry-run · chế độ thử/);
    assert.match(ui.renderMkChannels(), /shopee · chưa có token/);
    ui.state.config.marketplace = null;
    assert.match(ui.renderMkChannels(), /chưa bật được chức năng đăng sàn/);
  });
});

describe('MVP-08 · UI — issues[] từng dòng + escape', () => {
  const ui = makeUi();
  test('mỗi issue một <li> với trường · mã · câu; cảnh báo ghi rõ không chặn; XSS bị escape', () => {
    const html = ui.mkIssuesHtml([
      { field: 'price_vnd', code: 'MISSING', message: 'Thiếu giá bán VND' },
      { field: 'variants', code: 'UNMAPPED', message: `Nguồn có ${XSS}`, severity: 'warn' },
    ]);
    assert.equal((html.match(/<li/g) || []).length, 2);
    assert.match(html, /data-mk-issue="price_vnd"/);
    assert.match(html, /cảnh báo, không chặn/);
    assert.equal(html.includes('<img'), false);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
  test('rỗng ⇒ không render gì', () => {
    assert.equal(ui.mkIssuesHtml([]), '');
    assert.equal(ui.mkIssuesHtml(null), '');
  });
});

describe('MVP-08 · UI — bảng listing: nút khoá kèm lý do, nhãn THỬ, lỗi sàn hiện nguyên văn (đã escape)', () => {
  test('member + pending_review: DUYỆT/TỪ CHỐI khoá (chỉ owner/admin), ĐĂNG khoá (chưa duyệt), ĐỒNG BỘ khoá (chưa có mã)', () => {
    const ui = makeUi();
    const html = ui.renderMkTable([LISTING()], { isAdmin: false });
    assert.match(html, /data-action="mkapprove"[^>]*disabled[^>]*data-mk-reason="Chỉ owner\/admin được duyệt"/);
    assert.match(html, /data-action="mkpublish"[^>]*disabled[^>]*data-mk-reason="Bài chưa được DUYỆT"/);
    assert.match(html, /data-action="mksync"[^>]*disabled[^>]*data-mk-reason="Chưa có mã trên sàn"/);
    assert.match(html, /data-action="mkpayload"(?![^>]*disabled)/, 'XEM PAYLOAD luôn bấm được');
  });
  test('admin + approved + kênh dry-run ⇒ ĐĂNG bấm được; kênh shopee chưa token ⇒ ĐĂNG khoá với lý do chứa “chưa có token”', () => {
    const ui = makeUi();
    const ok = ui.renderMkTable([LISTING({ status: 'approved' })], { isAdmin: true });
    assert.match(ok, /data-action="mkpublish"(?![^>]*disabled)/);
    const no = ui.renderMkTable([LISTING({ status: 'approved', channel: 'shopee' })], { isAdmin: true });
    assert.match(no, /data-action="mkpublish"[^>]*disabled[^>]*data-mk-reason="Kênh shopee chưa cấu hình \(chưa có token Shopee/);
  });
  test('đã đăng (mock) ⇒ nhãn THỬ, mã dry-… hiện, ĐĂNG khoá “không đăng lại”, ĐỒNG BỘ bấm được', () => {
    const ui = makeUi();
    const html = ui.renderMkTable([LISTING({ status: 'published', external_id: 'dry-abc', is_mock: true })], { isAdmin: true });
    assert.match(html, /badge warn[^>]*>THỬ</);
    assert.match(html, /dry-abc/);
    assert.match(html, /data-action="mkpublish"[^>]*disabled[^>]*data-mk-reason="Bài đã có mã trên sàn — không đăng lại"/);
    assert.match(html, /data-action="mksync"(?![^>]*disabled)/);
  });
  test('đăng lỗi ⇒ mã + nguyên văn của sàn hiện ra (escape); không có nhãn THỬ', () => {
    const ui = makeUi();
    const html = ui.renderMkTable([LISTING({ status: 'failed', channel: 'tiktokshop', error_code: 'MARKETPLACE_ERROR', last_error: `TikTok: code 12052901 — ${XSS}` })], { isAdmin: true });
    assert.match(html, /MARKETPLACE_ERROR/);
    assert.match(html, /12052901/);
    assert.equal(html.includes('<img'), false);
    assert.doesNotMatch(html, />THỬ</);
  });
  test('XSS trong tiêu đề / external_id / lý do từ chối / issues bị escape; trạng thái dịch tiếng Việt', () => {
    const ui = makeUi();
    const html = ui.renderMkTable([LISTING({ status: 'rejected', title: XSS, external_id: XSS, reject_reason: XSS, issues: [{ field: XSS, code: 'X', message: XSS, severity: 'warn' }] })], { isAdmin: true });
    assert.equal(html.includes('<img'), false);
    assert.ok((html.match(/&lt;img/g) || []).length >= 4);
    assert.match(html, /Bị từ chối/);
    assert.equal(ui.mkStatusLabel('publishing'), 'Đang đăng…');
    assert.equal(ui.mkVnd(199000), '199.000 ₫');
  });
  test('null ⇒ “Đang tải…”, rỗng ⇒ “Chưa có bài…”', () => {
    const ui = makeUi();
    assert.match(ui.renderMkTable(null), /Đang tải/);
    assert.match(ui.renderMkTable([]), /Chưa có bài/);
  });
  test('ô từ chối mở ⇒ có input lý do + nút TỪ CHỐI thật', () => {
    const ui = makeUi({ mk: { rejectId: 'L1', rejectDraft: XSS } });
    const html = ui.renderMkTable([LISTING()], { isAdmin: true });
    assert.match(html, /id="mk-reject-reason"/);
    assert.match(html, /data-action="mkreject"/);
    assert.equal(html.includes('<img'), false);
  });
});

describe('MVP-08 · UI — hộp XEM PAYLOAD', () => {
  test('payload JSON giữ nguyên (escape), unmapped + mặc định + vết hiện; ghi rõ chưa đo API thật', () => {
    const ui = makeUi({
      mk: {
        payloadId: 'L1',
        payloadData: {
          listing: { id: 'L1', channel: 'shopee', title: 'Tai nghe', payload: { item_name: XSS, original_price: 199000 }, unmapped: [{ field: 'logistic_info', reason: 'cần đọc từ sàn' }], defaults_applied: [{ field: 'item_status', value: 'UNLIST', reason: 'không hiện bán ngay' }], issues: [] },
          events: [{ created_at: '2026-10-10T00:00:00Z', kind: 'created', to_status: 'pending_review' }],
        },
      },
    });
    const html = ui.renderMkPayload();
    assert.match(html, /original_price/);
    assert.equal(html.includes('<img'), false);
    assert.match(html, /logistic_info/);
    assert.match(html, /UNLIST/);
    assert.match(html, /chưa đo với API thật/);
    assert.match(html, /created/);
    assert.match(html, /chưa có token Shopee/, 'băng của kênh hiện cả trong hộp payload');
  });
  test('không chọn bài ⇒ rỗng; đang tải ⇒ nói đang tải', () => {
    assert.equal(makeUi().renderMkPayload(), '');
    assert.match(makeUi({ mk: { payloadId: 'L1', payloadData: null } }).renderMkPayload(), /Đang tải payload/);
  });
});

describe('MVP-08 · UI — bảng gợi ý lỗi phủ đủ mã của hợp đồng', () => {
  test('mỗi mã lỗi HTTP của MVP-08 có câu tiếng Việt', () => {
    const { MK_ERROR_HINT } = makeUi();
    for (const code of ['PREFLIGHT_FAILED', 'CHANNEL_NOT_CONFIGURED', 'NOT_APPROVED', 'MARKETPLACE_ERROR', 'LISTING_NOT_FOUND', 'ATTEMPTS_EXCEEDED', 'PUBLISH_IN_PROGRESS', 'SYNC_UNAVAILABLE']) {
      assert.ok(MK_ERROR_HINT[code], `thiếu gợi ý cho ${code}`);
    }
  });
});
