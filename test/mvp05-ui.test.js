/**
 * TEST MVP-05 · A5 — UI (`public/app.js`), hợp đồng §3.5.
 *
 * Cách làm giống `test/imagelab-ui.test.js`: TRÍCH ĐÚNG mã hàm từ `public/app.js` rồi biên
 * dịch trong Node với phụ thuộc bơm vào (`loadUiFunction` của `test/imagelab-ui-helpers.js`).
 * Nhờ vậy test chạy trên mã UI THẬT mà không cần DOM/trình duyệt.
 *
 * Phủ: escape XSS (email / ghi chú cấp credit / lý do sổ / `value=""`), câu lỗi 409/400,
 * băng báo 402 (số cần – số có – thiếu), link "Quản trị" chỉ hiện với owner/admin,
 * bảng sổ dịch đủ 6 `reason` + dấu +/−, và `password_min_length` lấy từ `/api/config`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './imagelab-helpers.js';
import { loadUiFunction, loadUiConst, loadUiConstValue, uiDeps } from './imagelab-ui-helpers.js';
import { startMvp05App, request, j } from './mvp05-helpers.js';

const APP_SRC = () => fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

/** Cắt mã nguồn THẬT của một hàm UI (để kiểm cấu trúc, không chỉ hành vi). */
function uiSourceOf(name) {
  const src = APP_SRC();
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `public/app.js: không tìm thấy hàm ${name}`);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end >= 0, `public/app.js: không xác định được thân hàm ${name}`);
  return src.slice(start, end + 3);
}

/**
 * "Thế giới UI" tối thiểu: các hàm THẬT của `public/app.js` + một `state` thay đổi được
 * (hàm được trích giữ tham chiếu tới CHÍNH object này nên mọi thay đổi đều có hiệu lực).
 */
function makeUi() {
  const state = {
    config: {},
    auth: { me: null, mode: 'login', form: {}, ledger: null, pricing: null, users: null, usage: null, creditTarget: null, creditDraft: null },
  };
  const ui = uiDeps();
  const esc = ui.esc;
  const LEDGER_REASON_LABEL = loadUiConst('LEDGER_REASON_LABEL');
  const ROLE_LABEL = loadUiConst('ROLE_LABEL');
  const OPERATION_LABEL = loadUiConst('OPERATION_LABEL');
  const AUTH_ERROR_HINT = loadUiConst('AUTH_ERROR_HINT');
  const CREDIT_HONEST_NOTE = loadUiConstValue('CREDIT_HONEST_NOTE');

  const fmtAmount = loadUiFunction('fmtAmount');
  const isAdminRole = loadUiFunction('isAdminRole');
  const roleLabel = loadUiFunction('roleLabel', { ROLE_LABEL });
  const operationLabel = loadUiFunction('operationLabel', { OPERATION_LABEL });
  const creditText = loadUiFunction('creditText', { fmtAmount });
  const ledgerReasonLabel = loadUiFunction('ledgerReasonLabel', { LEDGER_REASON_LABEL });
  const ledgerAmountText = loadUiFunction('ledgerAmountText', { fmtAmount });
  const ledgerAmountClass = loadUiFunction('ledgerAmountClass');
  const fmtTime = loadUiFunction('fmtTime');
  const passwordMinLength = loadUiFunction('passwordMinLength', { state });
  const passwordRuleText = loadUiFunction('passwordRuleText', { passwordMinLength });
  const creditShortfall = loadUiFunction('creditShortfall', { state });
  const creditShortfallText = loadUiFunction('creditShortfallText', { creditShortfall, fmtAmount });
  const apiErrorText = loadUiFunction('apiErrorText', { AUTH_ERROR_HINT, creditShortfallText });
  const authErrorText = loadUiFunction('authErrorText', { passwordMinLength, AUTH_ERROR_HINT, creditShortfallText });
  const authEnabled = loadUiFunction('authEnabled', { state });
  const accountsUnavailableText = loadUiFunction('accountsUnavailableText', { state });
  const renderAuthBody = loadUiFunction('renderAuthBody', {
    state, esc, passwordMinLength, authEnabled, accountsUnavailableText, passwordRuleText,
  });
  const renderLedgerTable = loadUiFunction('renderLedgerTable', {
    esc, fmtTime, ledgerReasonLabel, operationLabel, ledgerAmountClass, ledgerAmountText, fmtAmount,
  });
  const renderAccountBar = loadUiFunction('renderAccountBar', { state, esc, isAdminRole, roleLabel, creditText });
  const renderAdminCreditForm = loadUiFunction('renderAdminCreditForm', { state, esc, fmtAmount, CREDIT_HONEST_NOTE });

  return {
    state, esc, LEDGER_REASON_LABEL, AUTH_ERROR_HINT, CREDIT_HONEST_NOTE,
    fmtAmount, roleLabel, operationLabel, creditText, ledgerReasonLabel, ledgerAmountText, ledgerAmountClass,
    passwordMinLength, passwordRuleText, creditShortfall, creditShortfallText, apiErrorText, authErrorText,
    renderAuthBody, renderLedgerTable, renderAccountBar, renderAdminCreditForm,
  };
}

describe('MVP-05 · UI — escape XSS (email / note / lý do sổ / value="")', () => {
  const ui = makeUi();

  test('email trong form đăng ký được escape trong `value=""`', () => {
    ui.state.auth.mode = 'register';
    ui.state.auth.form = { email: '"><img src=x onerror=alert(1)>', display_name: '" onfocus="alert(1)' };
    const html = ui.renderAuthBody();
    assert.equal(html.includes('<img src=x'), false, 'email KHÔNG được nhét thô vào HTML');
    assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'), 'phải escape đúng ký tự');
    assert.ok(html.includes('value="&quot; onfocus=&quot;alert(1)"'), 'tên hiển thị cũng phải escape');
    assert.equal(html.includes('onfocus="alert(1)"'), false);
  });

  test('ghi chú cấp credit + email đích trong trang quản trị được escape', () => {
    ui.state.auth.creditTarget = { userId: 'u-1', email: '"><script>alert(1)</script>' };
    ui.state.auth.creditDraft = { amount: '1', note: '"><script>alert(2)</script>' };
    ui.state.auth.creditConfirm = null;
    const html = ui.renderAdminCreditForm();
    assert.equal(html.includes('<script>'), false, 'note/email KHÔNG được xuất hiện thô');
    assert.ok(html.includes('&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;'));
    assert.ok(html.includes('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('value="&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;"'), 'note nằm trong value="" phải escape');
  });

  test('lý do sổ và job_id trong bảng sổ được escape', () => {
    const html = ui.renderLedgerTable([
      { created_at: '2026-01-02T03:04:05.000Z', reason: '<script>alert(3)</script>', amount: -1, currency: 'USD', job_id: '<img src=y onerror=alert(4)>', balance_after: 1 },
    ]);
    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('<img src=y'), false);
    assert.ok(html.includes('&lt;script&gt;alert(3)&lt;/script&gt;'));
    assert.ok(html.includes('&lt;img src=y onerror=alert(4)&gt;'));
  });
});

describe('MVP-05 · UI — thông điệp lỗi 409 / 400 / 402', () => {
  const ui = makeUi();

  test('409 EMAIL_TAKEN hiện đúng thông điệp (kèm câu của máy chủ)', () => {
    const server = 'Email này đã được đăng ký — hãy đăng nhập hoặc dùng email khác.';
    const text = ui.authErrorText({ status: 409, code: 'EMAIL_TAKEN', message: server }, { mode: 'register' });
    assert.ok(text.includes(ui.AUTH_ERROR_HINT.EMAIL_TAKEN), `phải có gợi ý EMAIL_TAKEN: ${text}`);
    assert.ok(text.includes(server), 'không được nuốt câu của máy chủ');
  });

  test('400 WEAK_PASSWORD nêu ĐÚNG số ký tự tối thiểu lấy từ /api/config', () => {
    ui.state.config = { auth: { enabled: true, password_min_length: 12 } };
    const a = ui.authErrorText({ status: 400, code: 'WEAK_PASSWORD', message: 'Mật khẩu quá ngắn: cần tối thiểu 12 ký tự.' }, { mode: 'register' });
    assert.ok(a.includes('12 ký tự'), a);
    ui.state.config = { auth: { enabled: true, password_min_length: 15 } };
    const b = ui.authErrorText({ status: 400, code: 'WEAK_PASSWORD', message: 'Mật khẩu quá ngắn: cần tối thiểu 15 ký tự.' }, { mode: 'register' });
    assert.ok(b.includes('15 ký tự'), b);
    assert.notEqual(a, b, 'câu chữ phải ĐỔI theo cấu hình — không hardcode');
  });

  test('402 hiện đủ số CẦN / số CÓ / số THIẾU, không bịa khi máy chủ thiếu số', () => {
    ui.state.auth.me = { user: { email: 'a@b.com', role: 'member' }, balance: { amount: 2, currency: 'USD' } };
    const err = {
      status: 402,
      code: 'INSUFFICIENT_CREDIT',
      message: 'Số dư credit không đủ để chạy job này: cần 5, hiện có 2.',
      payload: { details: { required: 5, balance: 2, currency: 'USD' } },
    };
    assert.deepEqual(ui.creditShortfall(err), { need: 5, have: 2, haveCached: false, short: 3, currency: 'USD' });
    const text = ui.creditShortfallText(err);
    assert.ok(text.includes('cần 5'), text);
    assert.ok(text.includes('bạn đang có 2'), text);
    assert.ok(text.includes('thiếu 3'), text);
    assert.ok(text.includes('USD'), text);
    assert.equal(ui.apiErrorText(err), text, 'mọi trang gọi API dùng chung một câu 402');

    // Máy chủ chỉ kèm số CẦN ⇒ số CÓ lấy từ số dư gần nhất giao diện biết, và NÓI RÕ nguồn.
    const partial = { status: 402, code: 'INSUFFICIENT_CREDIT', payload: { details: { required: 5 } } };
    const s2 = ui.creditShortfall(partial);
    assert.equal(s2.need, 5);
    assert.equal(s2.have, 2);
    assert.equal(s2.haveCached, true);
    assert.ok(ui.creditShortfallText(partial).includes('số dư gần nhất giao diện biết'));

    // Không có số nào ⇒ nói THẬT là không có số, KHÔNG bịa.
    const empty = { status: 402, code: 'INSUFFICIENT_CREDIT' };
    ui.state.auth.me = { user: { email: 'a@b.com', role: 'member' }, balance: null };
    const s3 = ui.creditShortfall(empty);
    assert.deepEqual([s3.need, s3.have, s3.short], [null, null, null]);
    assert.ok(ui.creditShortfallText(empty).includes('máy chủ không kèm số cần / số đang có'));
  });
});

describe('MVP-05 · UI — link "Quản trị" chỉ hiện với owner/admin', () => {
  const ui = makeUi();

  test('member ⇒ KHÔNG có link; owner/admin ⇒ CÓ; khách ẩn danh ⇒ KHÔNG', () => {
    ui.state.auth.me = { user: { email: 'member@example.com', role: 'member' }, balance: { amount: 0, currency: 'USD' } };
    const memberHtml = ui.renderAccountBar();
    assert.equal(memberHtml.includes('data-action="admin"'), false, 'member KHÔNG được thấy link Quản trị');
    assert.ok(memberHtml.includes('member@example.com'));

    for (const role of ['owner', 'admin']) {
      ui.state.auth.me = { user: { email: `${role}@example.com`, role }, balance: { amount: 1.5, currency: 'USD' } };
      const html = ui.renderAccountBar();
      assert.ok(html.includes('data-action="admin"'), `${role} PHẢI thấy link Quản trị`);
      assert.ok(html.includes('Quản trị'));
      assert.ok(html.includes('1.5 credit'));
    }

    ui.state.auth.me = { user: null };
    const anonHtml = ui.renderAccountBar();
    assert.ok(anonHtml.includes('Khách ẩn danh'));
    assert.equal(anonHtml.includes('data-action="admin"'), false);
    assert.ok(anonHtml.includes('Dữ liệu chỉ theo phiên trình duyệt này.'));
  });

  test('email hiển thị ở header cũng được escape', () => {
    ui.state.auth.me = { user: { email: '"><b>x</b>@example.com', role: 'member' }, balance: null };
    const html = ui.renderAccountBar();
    assert.equal(html.includes('<b>x</b>'), false);
    assert.ok(html.includes('&quot;&gt;&lt;b&gt;x&lt;/b&gt;'));
  });
});

describe('MVP-05 · UI — bảng sổ credit: đủ 6 reason + dấu +/−', () => {
  const ui = makeUi();

  test('dịch đúng 6 giá trị `reason` của hợp đồng §2.1', () => {
    const reasons = Object.keys(ui.LEDGER_REASON_LABEL).sort();
    assert.deepEqual(reasons, ['adjustment', 'admin_grant', 'grant', 'job_hold', 'job_refund', 'job_settle']);
    const expected = {
      grant: 'Tặng',
      admin_grant: 'Quản trị cấp',
      job_hold: 'Giữ cho job',
      job_settle: 'Quyết toán',
      job_refund: 'Hoàn tiền',
      adjustment: 'Điều chỉnh',
    };
    for (const [reason, label] of Object.entries(expected)) {
      assert.equal(ui.ledgerReasonLabel(reason), label);
      assert.ok(ui.renderLedgerTable([{ reason, amount: 1, currency: 'USD', balance_after: 1 }]).includes(label), `bảng phải hiện "${label}"`);
    }
    assert.equal(ui.ledgerReasonLabel('reason-la-hoac'), 'reason-la-hoac', 'giá trị lạ giữ nguyên, không bịa nhãn');
    assert.equal(ui.ledgerReasonLabel(null), 'Không rõ');
  });

  test('dấu +/− đúng: trừ là credit-minus, cộng là credit-plus, 0 là credit-zero', () => {
    assert.equal(ui.ledgerAmountText(-1.5, 'USD'), '-1.5 USD');
    assert.equal(ui.ledgerAmountText(2.25, 'USD'), '+2.25 USD');
    assert.equal(ui.ledgerAmountClass(-1.5), 'credit-minus');
    assert.equal(ui.ledgerAmountClass(2.25), 'credit-plus');
    assert.equal(ui.ledgerAmountClass(0), 'credit-zero');
    assert.equal(ui.ledgerAmountClass('rac'), 'credit-zero');

    const html = ui.renderLedgerTable([
      { created_at: '2026-01-02T03:04:05.000Z', reason: 'job_hold', amount: -0.0083, currency: 'USD', job_id: 'job-1', balance_after: 0.9917 },
      { created_at: '2026-01-02T03:05:05.000Z', reason: 'job_refund', amount: 0.0083, currency: 'USD', job_id: 'job-1', balance_after: 1 },
    ]);
    assert.ok(html.includes('credit-minus') && html.includes('-0.0083'));
    assert.ok(html.includes('credit-plus') && html.includes('+0.0083'));
    assert.ok(html.includes('Giữ cho job') && html.includes('Hoàn tiền'));
    assert.ok(html.includes('job-1'));
    assert.equal(html.includes('0000000000000004'), false);

    assert.ok(ui.renderLedgerTable([]).includes('Sổ credit còn trống'));
    assert.ok(ui.renderLedgerTable(null).includes('Đang tải sổ credit'));
  });
});

describe('MVP-05 · UI — password_min_length lấy từ /api/config (không hardcode)', () => {
  const ui = makeUi();

  test('đổi số trong config ⇒ câu chữ đổi theo; thiếu config ⇒ nói thật là chưa biết', () => {
    ui.state.config = { auth: { enabled: true, password_min_length: 12 } };
    assert.equal(ui.passwordMinLength(), 12);
    assert.equal(ui.passwordRuleText(), 'Mật khẩu cần ít nhất 12 ký tự (theo cấu hình máy chủ).');
    ui.state.config = { auth: { enabled: true, password_min_length: 15 } };
    assert.equal(ui.passwordMinLength(), 15);
    assert.equal(ui.passwordRuleText(), 'Mật khẩu cần ít nhất 15 ký tự (theo cấu hình máy chủ).');
    ui.state.config = {};
    assert.equal(ui.passwordMinLength(), null);
    assert.ok(ui.passwordRuleText().includes('chưa tải được cấu hình'));
  });

  test('form đăng ký: thuộc tính `minlength` và câu gợi ý theo ĐÚNG cấu hình máy chủ', () => {
    ui.state.config = { auth: { enabled: true, password_min_length: 12 } };
    ui.state.auth.mode = 'register';
    ui.state.auth.form = {};
    const html12 = ui.renderAuthBody();
    assert.ok(html12.includes('minlength="12"'), 'phải đặt minlength theo config');
    assert.ok(html12.includes('ít nhất 12 ký tự'));
    assert.equal(html12.includes('ít nhất 10 ký tự'), false, 'KHÔNG được hardcode sàn 10');

    ui.state.config = { auth: { enabled: true, password_min_length: 15 } };
    const html15 = ui.renderAuthBody();
    assert.ok(html15.includes('minlength="15"'));
    assert.notEqual(html12, html15, 'HTML phải đổi khi config đổi');
  });

  test('mã nguồn THẬT của passwordRuleText/passwordMinLength không chứa số cứng', () => {
    const rule = uiSourceOf('passwordRuleText');
    assert.equal(/\d/.test(rule), false, `passwordRuleText không được chứa số cứng:\n${rule}`);
    assert.ok(rule.includes('passwordMinLength'), 'phải lấy từ passwordMinLength()');
    const min = uiSourceOf('passwordMinLength');
    assert.ok(min.includes('state.config'), 'phải đọc từ /api/config (state.config)');
  });

  test('server THẬT: AUTH_PASSWORD_MIN_LENGTH=13 ⇒ /api/config trả 13 và UI hiện 13', async () => {
    const ctx = await startMvp05App({ configOverrides: { AUTH_PASSWORD_MIN_LENGTH: '13' } });
    try {
      const config = await j(await request(ctx.base, '/api/config'));
      assert.equal(config.auth.password_min_length, 13);
      ui.state.config = config;
      assert.equal(ui.passwordMinLength(), 13);
      const html = ui.renderAuthBody();
      assert.ok(html.includes('minlength="13"'));
      assert.ok(html.includes('ít nhất 13 ký tự'));
    } finally {
      await ctx.close();
    }
  });
});
