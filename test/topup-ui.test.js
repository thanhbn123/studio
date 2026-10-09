/**
 * TEST MVP-06 · UI (`public/app.js`) — hợp đồng §4.
 *
 * Cách làm giống `test/mvp05-ui.test.js`: TRÍCH ĐÚNG mã hàm thật từ `public/app.js` rồi biên
 * dịch trong Node với phụ thuộc bơm vào ⇒ test chạy trên mã UI THẬT, không phải bản chép tay.
 *
 * Phủ đúng những điều hợp đồng §4 bắt buộc:
 *   - số tài khoản LẤY TỪ `/api/config`, **không** hardcode trong `public/app.js`;
 *   - quản trị chưa điền thông tin ⇒ nói thật, KHÔNG hiện số tài khoản nào;
 *   - câu “tiền vào ví chỉ sau khi quản trị xác nhận” hiện ở cả tab Tài khoản và Quản trị;
 *   - nút XÁC NHẬN hiện số credit sẽ cộng + tỷ giá đang dùng; TỪ CHỐI bắt buộc lý do;
 *   - escape XSS cho mọi field do người dùng nhập (mã giao dịch, ghi chú).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './imagelab-helpers.js';
import { loadUiFunction, loadUiConst, loadUiConstValue } from './imagelab-ui-helpers.js';

const APP_SRC = () => fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

/** "Thế giới UI" tối thiểu cho khối MVP-06 (state thật, hàm thật). */
function makeUi(configTopup = null, topupState = {}) {
  const state = {
    config: { billing: configTopup === null ? {} : { topup: configTopup } },
    view: 'account',
    auth: { me: null, adminError: null, adminNotice: null },
    topup: {
      requests: null,
      loading: false,
      busy: false,
      draft: { amount_vnd: '', reference: '', note: '' },
      error: null,
      notice: null,
      admin: null,
      adminLoading: false,
      confirmId: null,
      rejectId: null,
      rejectDraft: '',
      ...topupState,
    },
  };
  const esc = loadUiFunction('esc');
  const fmtAmount = loadUiFunction('fmtAmount');
  const fmtTime = loadUiFunction('fmtTime');
  const fmtVnd = loadUiFunction('fmtVnd');
  const TOPUP_STATUS_LABEL = loadUiConst('TOPUP_STATUS_LABEL');
  const TOPUP_STATUS_CLASS = loadUiConstValue('TOPUP_STATUS_CLASS');
  const TOPUP_HONEST_NOTE = loadUiConstValue('TOPUP_HONEST_NOTE');
  const CREDIT_TOPUP_HINT = loadUiConstValue('CREDIT_TOPUP_HINT');
  const topupConfig = loadUiFunction('topupConfig', { state });
  const topupEnabled = loadUiFunction('topupEnabled', { topupConfig });
  const topupNote = loadUiFunction('topupNote', { topupConfig, TOPUP_HONEST_NOTE });
  const topupStatusLabel = loadUiFunction('topupStatusLabel', { TOPUP_STATUS_LABEL });
  const topupCredits = loadUiFunction('topupCredits', { topupConfig });
  const deps = {
    state, esc, fmtAmount, fmtTime, fmtVnd, topupConfig, topupEnabled, topupNote,
    topupStatusLabel, topupCredits, TOPUP_STATUS_CLASS, TOPUP_HONEST_NOTE, CREDIT_TOPUP_HINT,
  };
  return {
    state,
    deps,
    topupCredits,
    fmtVnd,
    renderTopupGuide: loadUiFunction('renderTopupGuide', deps),
    renderTopupTable: loadUiFunction('renderTopupTable', deps),
    renderTopupPanel: loadUiFunction('renderTopupPanel', { ...deps, renderTopupGuide: loadUiFunction('renderTopupGuide', deps), renderTopupTable: loadUiFunction('renderTopupTable', deps) }),
    renderAdminTopups: loadUiFunction('renderAdminTopups', deps),
  };
}

const CONFIG = {
  rate_vnd_per_credit: 26000,
  min_topup_vnd: 20000,
  max_topup_vnd: 50000000,
  method: 'bank_transfer',
  note: 'Tiền vào ví chỉ sau khi quản trị xác nhận — hệ thống không tự biết tiền đã về tài khoản.',
  bank: {
    bank_name: 'Ngân hàng Thử Nghiệm',
    account_number: '0123456789',
    account_holder: 'NGUYEN VAN A',
    transfer_note: 'VPS user@example.com',
    instructions: 'Duyệt trong giờ làm việc.',
    configured: true,
  },
};

describe('MVP-06 · UI — hướng dẫn chuyển khoản LẤY TỪ CẤU HÌNH', () => {
  test('`public/app.js` KHÔNG hardcode số tài khoản / tên ngân hàng', () => {
    const src = APP_SRC();
    // Mọi chuỗi số dài 8–20 chữ số trong mã UI đều là dấu hiệu của số tài khoản bị nhúng.
    const digits = (src.match(/["'`]\d{8,20}["'`]/g) || []).filter((m) => !/\d{13,}/.test(m));
    assert.deepEqual(digits, [], `public/app.js không được chứa số tài khoản: ${digits.join(', ')}`);
    // Giao diện phải đọc thông tin ngân hàng từ khối cấu hình của máy chủ.
    assert.match(src, /state\.config\?\.billing\?\.topup/, 'phải lấy khối topup từ /api/config');
    assert.match(src, /bank\.account_number/, 'số tài khoản phải lấy từ cấu hình máy chủ');
  });

  test('có cấu hình ⇒ hiện đủ 4 dòng hướng dẫn (escape nội dung)', () => {
    const ui = makeUi({
      ...CONFIG,
      bank: { ...CONFIG.bank, account_holder: '<script>x</script>', transfer_note: 'VPS "a"&b' },
    });
    const html = ui.renderTopupGuide();
    assert.match(html, /Ngân hàng Thử Nghiệm/);
    assert.match(html, /0123456789/);
    assert.match(html, /Duyệt trong giờ làm việc\./);
    assert.equal(html.includes('<script>'), false, 'KHÔNG được chèn thẻ script của dữ liệu cấu hình');
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&quot;a&quot;&amp;b/);
  });

  test('chưa khai TOPUP_BANK_* ⇒ nói thật, KHÔNG hiện số tài khoản nào', () => {
    const ui = makeUi({ ...CONFIG, bank: { bank_name: '', account_number: '', account_holder: '', transfer_note: '', instructions: '', configured: false } });
    const html = ui.renderTopupGuide();
    assert.match(html, /Quản trị chưa điền thông tin chuyển khoản/);
    assert.match(html, /TOPUP_BANK_/);
    assert.equal(/\d{8,}/.test(html), false, 'không được có chuỗi số nào trông như số tài khoản');
  });
});

describe('MVP-06 · UI — form nạp ở tab Tài khoản', () => {
  test('hiện câu NÓI THẬT + tỷ giá + khoảng tiền + bản xem trước credit', () => {
    const ui = makeUi(CONFIG, { draft: { amount_vnd: '260000', reference: 'FT-1', note: '' } });
    const html = ui.renderTopupPanel();
    assert.match(html, /không tự biết tiền đã về tài khoản/i, 'phải nói thẳng hệ thống không tự biết tiền về');
    assert.match(html, /26\.000\s*₫/, 'hiện tỷ giá đang dùng');
    assert.match(html, /20\.000\s*₫/, 'hiện số tiền nạp tối thiểu');
    assert.match(html, /50\.000\.000\s*₫/, 'hiện số tiền nạp tối đa');
    assert.match(html, /<strong>10<\/strong> credit/, '260.000 VND ÷ 26.000 = 10 credit');
    assert.match(html, /data-action="topupsubmit"/);
    assert.match(html, /id="topup-amount"/);
    assert.match(html, /id="topup-reference"/);
    assert.match(html, /Tỷ giá được GHI LẠI lúc quản trị duyệt/);
  });

  test('máy chủ chưa bật chức năng ⇒ ẩn form, nói thật (không hiện ô nhập nào)', () => {
    const ui = makeUi(null);
    const html = ui.renderTopupPanel();
    assert.match(html, /chưa bật trên máy chủ này/i);
    assert.equal(html.includes('id="topup-amount"'), false);
    assert.equal(html.includes('data-action="topupsubmit"'), false);
  });

  test('bản nháp của người dùng được escape khi vẽ lại (XSS qua `value=""`)', () => {
    const ui = makeUi(CONFIG, { draft: { amount_vnd: '200000', reference: '"><img src=x onerror=alert(1)>', note: "'><b>x" } });
    const html = ui.renderTopupPanel();
    assert.equal(html.includes('<img src=x'), false);
    assert.match(html, /&quot;&gt;&lt;img/);
    assert.equal(html.includes("'><b>x"), false);
  });

  test('bảng yêu cầu của tôi: chưa tải ⇒ "đang tải", rỗng ⇒ nói rõ, có dữ liệu ⇒ đủ cột + nhãn trạng thái', () => {
    const ui = makeUi(CONFIG);
    assert.match(ui.renderTopupTable(null), /Đang tải/);
    assert.match(ui.renderTopupTable([]), /chưa có yêu cầu nạp nào/i);
    const html = ui.renderTopupTable([
      { created_at: '2026-10-09T03:00:00.000Z', amount_vnd: 260000, credits: 10, reference: 'FT-9', status: 'pending', decided_at: null },
      { created_at: '2026-10-08T03:00:00.000Z', amount_vnd: 520000, credits: 20, reference: 'FT-8', status: 'confirmed', decided_at: '2026-10-08T04:00:00.000Z' },
      { created_at: '2026-10-07T03:00:00.000Z', amount_vnd: 100000, credits: null, reference: '<b>x</b>', status: 'rejected', decided_at: '2026-10-07T05:00:00.000Z' },
    ]);
    assert.match(html, /Chờ quản trị xác nhận/);
    assert.match(html, /Đã cộng credit/);
    assert.match(html, /Bị từ chối/);
    assert.match(html, /260\.000\s*₫/);
    assert.equal(html.includes('<b>x</b>'), false, 'mã giao dịch phải được escape');
  });

  test('quy đổi VND → credit: thiếu/0 tỷ giá ⇒ `null` (KHÔNG tự bịa tỷ giá)', () => {
    const ui = makeUi(CONFIG);
    assert.equal(ui.topupCredits(260000), 10);
    assert.equal(ui.topupCredits('abc'), null);
    assert.equal(ui.topupCredits(260000, 0), null);
    assert.equal(ui.topupCredits(260000, undefined), 10);
    const noCfg = makeUi(null);
    assert.equal(noCfg.topupCredits(260000), null);
  });
});

describe('MVP-06 · UI — duyệt yêu cầu ở tab Quản trị', () => {
  const pending = {
    id: 'req-1',
    user_id: 'user-1',
    amount_vnd: 260000,
    credits: 10,
    reference: 'FT-7',
    note: 'chuyển lúc 14:05',
    status: 'pending',
    created_at: '2026-10-09T03:00:00.000Z',
  };

  test('danh sách pending: hai nút XÁC NHẬN… / TỪ CHỐI… + số credit sẽ cộng', () => {
    const ui = makeUi(CONFIG, { admin: [pending] });
    const html = ui.renderAdminTopups();
    assert.match(html, /data-action="topupreview"/);
    assert.match(html, /data-action="topuprejectopen"/);
    assert.match(html, /FT-7/);
    assert.match(html, /260\.000\s*₫/);
    assert.match(html, />10</, 'cột "Credit sẽ cộng" phải hiện 10');
  });

  test('bấm XÁC NHẬN… ⇒ hộp xem lại hiện SỐ CREDIT + TỶ GIÁ + nhắc đối soát sao kê', () => {
    const ui = makeUi(CONFIG, { admin: [pending], confirmId: 'req-1' });
    const html = ui.renderAdminTopups();
    assert.match(html, /Xác nhận cộng 10 credit/);
    assert.match(html, /26\.000\s*₫ = 1 credit/);
    assert.match(html, /đối soát mã giao dịch/i);
    assert.match(html, /hệ thống không tự biết tiền đã về/i);
    assert.match(html, /data-action="topupconfirm" data-id="req-1"/);
    assert.match(html, /data-action="topupcancel"/);
  });

  test('bấm TỪ CHỐI… ⇒ ô lý do BẮT BUỘC (nhãn nói rõ) + nút từ chối', () => {
    const ui = makeUi(CONFIG, { admin: [pending], rejectId: 'req-1', rejectDraft: 'không thấy trong sao kê' });
    const html = ui.renderAdminTopups();
    assert.match(html, /Lý do từ chối \(bắt buộc\)/);
    assert.match(html, /id="topup-reject-reason"/);
    assert.match(html, /value="không thấy trong sao kê"/);
    assert.match(html, /data-action="topupreject" data-id="req-1"/);
  });

  test('đang xử lý (busy) ⇒ nút bị disable để không bấm hai lần', () => {
    const ui = makeUi(CONFIG, { admin: [pending], confirmId: 'req-1', busy: true });
    assert.match(ui.renderAdminTopups(), /data-action="topupconfirm"[^>]*disabled/);
  });

  test('không có yêu cầu nào / chưa bật chức năng ⇒ nói rõ, không bảng rỗng im lặng', () => {
    assert.match(makeUi(CONFIG, { admin: [] }).renderAdminTopups(), /Không có yêu cầu nạp nào đang chờ/);
    assert.match(makeUi(CONFIG, { admin: null }).renderAdminTopups(), /Đang tải/);
    assert.match(makeUi(null, { admin: [] }).renderAdminTopups(), /chưa bật chức năng nạp credit/i);
  });

  test('dữ liệu người dùng nhập được escape trong bảng quản trị (XSS)', () => {
    const ui = makeUi(CONFIG, {
      admin: [{ ...pending, reference: '<img src=x onerror=alert(1)>', note: '<script>evil()</script>' }],
    });
    const html = ui.renderAdminTopups();
    assert.equal(html.includes('<img src=x'), false);
    assert.equal(html.includes('<script>'), false);
    assert.match(html, /&lt;script&gt;evil\(\)&lt;\/script&gt;/);
  });
});

describe('MVP-06 · UI — nối hành động và dọn dữ liệu riêng tư', () => {
  test('mọi `data-action` của MVP-06 đều có handler thật', () => {
    const src = APP_SRC();
    for (const action of [
      'topupsubmit', 'topupreload', 'topupadminreload', 'topupreview',
      'topuprejectopen', 'topupcancel', 'topupconfirm', 'topupreject',
    ]) {
      assert.match(src, new RegExp(`data-action="${action}"`), `UI phải có nút ${action}`);
      assert.match(src, new RegExp(`\\n    ${action}: \\(\\) =>`), `phải có handler cho ${action}`);
    }
  });

  test('đăng xuất ⇒ xoá sạch yêu cầu nạp (dữ liệu tiền của một người)', () => {
    const src = APP_SRC();
    const start = src.indexOf('function clearPrivateState()');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    for (const line of ['state.topup.requests = null', 'state.topup.admin = null', 'state.topup.draft =']) {
      assert.ok(body.includes(line), `clearPrivateState phải dọn \`${line}\``);
    }
  });

  test('vào tab Tài khoản / Quản trị đều tải danh sách yêu cầu nạp', () => {
    const src = APP_SRC();
    assert.match(src, /loadLedger\(true\), loadPricing\(true\), loadTopups\(true\)/);
    assert.match(src, /loadAdminUsers\(true\), loadAdminUsage\(true\), loadAdminTopups\(true\)/);
  });
});
