/**
 * TEST MVP-06 · API — NẠP CREDIT THỦ CÔNG (`docs/MVP-06-CONTRACT.md` §3/§5) trên server THẬT.
 *
 * Mọi khẳng định được đo trên DB THẬT (SQLite in-memory) qua app dựng thật: route → service →
 * store → `wallet_ledger`. Không mock tầng nào ở giữa, vì câu hỏi cần trả lời là câu hỏi TIỀN:
 *
 *   - tạo yêu cầu nạp ⇒ ví KHÔNG đổi (0 dòng sổ mới, số dư y nguyên) — luật #1;
 *   - xác nhận ⇒ ĐÚNG 1 dòng sổ, số dư = TỔNG SỔ, `run_key = topup:<id>` — §5;
 *   - xác nhận lần hai ⇒ 409 `TOPUP_ALREADY_DECIDED` và sổ KHÔNG đổi;
 *   - vượt trần `BILLING_MAX_BALANCE` ⇒ 400 `AMOUNT_TOO_LARGE`, yêu cầu VẪN `pending`, 0 dòng sổ;
 *   - trùng `reference` của cùng người dùng ⇒ 409 `TOPUP_REFERENCE_DUPLICATE`;
 *   - từ chối ⇒ 0 dòng sổ + lý do nằm trong `topup_events`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startMvp05App,
  register,
  request,
  j,
  countRows,
  ledgerRows,
  ledgerSum,
  PASSWORD,
} from './mvp05-helpers.js';

const TOPUP_PATH = '/api/billing/topup-requests';

/** Mã giao dịch ngân hàng duy nhất cho mỗi lần dùng (tránh 409 ngoài ý muốn). */
let refSeq = 0;
const nextRef = (prefix = 'FT') => `${prefix}-${Date.now()}-${(refSeq += 1)}`;

const createRequestFor = (base, jar, body) => request(base, TOPUP_PATH, { method: 'POST', jar, body });

async function newUser(ctx, email, { role = null } = {}) {
  const out = await register(ctx.base, { email, password: PASSWORD });
  assert.equal(out.res.status, 201, `đăng ký ${email} phải 201`);
  const user = { id: out.body.user.id, email, jar: out.jar };
  if (role) {
    await ctx.store.updateUser(user.id, { role });
    user.role = role;
  }
  return user;
}

describe('MVP-06 · tạo yêu cầu nạp — KHÔNG ĐỤNG VÍ (luật #1)', () => {
  let ctx;
  let member;
  before(async () => {
    ctx = await startMvp05App();
    member = await newUser(ctx, 'topup-member@example.com');
  });
  after(async () => {
    await ctx.close();
  });

  test('ẩn danh ⇒ 401 (cả tạo và xem); không có yêu cầu nào được ghi', async () => {
    const before = await countRows(ctx.store, 'topup_requests');
    const anonCreate = await request(ctx.base, TOPUP_PATH, {
      method: 'POST',
      body: { amount_vnd: 200000, reference: nextRef() },
    });
    assert.equal(anonCreate.status, 401);
    assert.equal((await j(anonCreate)).error?.code, 'UNAUTHENTICATED');

    const anonList = await request(ctx.base, TOPUP_PATH, {});
    assert.equal(anonList.status, 401);
    assert.equal(await countRows(ctx.store, 'topup_requests'), before, 'ẩn danh KHÔNG được ghi yêu cầu nào');
  });

  test('201 + status=pending + VÍ KHÔNG ĐỔI (0 dòng sổ mới, số dư y nguyên)', async () => {
    const ledgerBefore = (await ledgerRows(ctx.store, member.id)).length;
    const balanceBefore = await ledgerSum(ctx.store, member.id);

    const reference = nextRef();
    const res = await createRequestFor(ctx.base, member.jar, {
      amount_vnd: 260000,
      reference,
      note: 'chuyển Vietcombank 09/10',
    });
    assert.equal(res.status, 201);
    const body = await j(res);
    const req = body.request;
    assert.equal(req.status, 'pending');
    assert.equal(req.amount_vnd, 260000);
    assert.equal(req.method, 'bank_transfer');
    assert.equal(req.reference, reference);
    assert.equal(req.user_id, member.id);
    assert.equal(req.decided_at, null);
    assert.equal(req.ledger_entry_id, null, 'chưa duyệt ⇒ chưa có dòng sổ nào');
    // Tỷ giá mặc định 26.000 VND/credit ⇒ 260.000 VND = 10 credit (bản XEM TRƯỚC).
    assert.equal(req.rate_vnd_per_credit, 26000);
    assert.equal(req.credits, 10);
    assert.equal(body.wallet_touched, false);
    assert.match(String(body.note), /quản trị xác nhận/i);

    assert.equal((await ledgerRows(ctx.store, member.id)).length, ledgerBefore, 'SỔ KHÔNG ĐƯỢC THÊM DÒNG NÀO');
    assert.equal(await ledgerSum(ctx.store, member.id), balanceBefore, 'số dư KHÔNG ĐƯỢC ĐỔI');

    // Luật #2: tạo yêu cầu cũng là một lần chuyển trạng thái ⇒ phải có vết.
    const events = await ctx.store.listTopupEvents(req.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].from_status, null);
    assert.equal(events[0].to_status, 'pending');
  });

  test('`amount_vnd` ngoài [min,max] ⇒ 400 TOPUP_AMOUNT_OUT_OF_RANGE (kèm min/max thật)', async () => {
    for (const amount of [1000, 19999, 50000001]) {
      const res = await createRequestFor(ctx.base, member.jar, { amount_vnd: amount, reference: nextRef() });
      assert.equal(res.status, 400, `amount_vnd=${amount} phải bị từ chối`);
      const err = (await j(res)).error;
      assert.equal(err.code, 'TOPUP_AMOUNT_OUT_OF_RANGE');
      assert.equal(err.details.min_topup_vnd, 20000);
      assert.equal(err.details.max_topup_vnd, 50000000);
    }
  });

  test('`amount_vnd` không phải số nguyên / `reference` thiếu ⇒ 400 nói rõ lý do', async () => {
    for (const amount of [200000.5, 'nhiều', null, Number.NaN]) {
      const res = await createRequestFor(ctx.base, member.jar, { amount_vnd: amount, reference: nextRef() });
      assert.equal(res.status, 400, `amount_vnd=${JSON.stringify(amount)} phải 400`);
      assert.equal((await j(res)).error.code, 'TOPUP_AMOUNT_INVALID');
    }
    const noRef = await createRequestFor(ctx.base, member.jar, { amount_vnd: 200000, reference: '  ' });
    assert.equal(noRef.status, 400);
    assert.equal((await j(noRef)).error.code, 'TOPUP_REFERENCE_REQUIRED');
  });

  test('`reference` TRÙNG của CÙNG người dùng ⇒ 409 TOPUP_REFERENCE_DUPLICATE; người khác dùng được', async () => {
    const reference = nextRef('DUP');
    const first = await createRequestFor(ctx.base, member.jar, { amount_vnd: 100000, reference });
    assert.equal(first.status, 201);
    const rowsBefore = await countRows(ctx.store, 'topup_requests');

    const again = await createRequestFor(ctx.base, member.jar, { amount_vnd: 300000, reference });
    assert.equal(again.status, 409);
    assert.equal((await j(again)).error.code, 'TOPUP_REFERENCE_DUPLICATE');
    assert.equal(await countRows(ctx.store, 'topup_requests'), rowsBefore, 'yêu cầu trùng KHÔNG được ghi');

    const other = await newUser(ctx, 'topup-other@example.com');
    const ok = await createRequestFor(ctx.base, other.jar, { amount_vnd: 100000, reference });
    assert.equal(ok.status, 201, 'cùng mã nhưng KHÁC người dùng là hợp lệ');
  });
});

describe('MVP-06 · xem danh sách — chính chủ thấy của mình, admin thấy tất cả', () => {
  let ctx;
  let member;
  let other;
  let owner;
  before(async () => {
    ctx = await startMvp05App();
    member = await newUser(ctx, 'list-member@example.com');
    other = await newUser(ctx, 'list-other@example.com');
    owner = await newUser(ctx, 'list-owner@example.com', { role: 'owner' });
    await createRequestFor(ctx.base, member.jar, { amount_vnd: 200000, reference: nextRef('M') });
    await createRequestFor(ctx.base, other.jar, { amount_vnd: 300000, reference: nextRef('O') });
  });
  after(async () => {
    await ctx.close();
  });

  test('member chỉ thấy yêu cầu của mình (KHÔNG thấy của người khác)', async () => {
    const res = await request(ctx.base, TOPUP_PATH, { jar: member.jar });
    assert.equal(res.status, 200);
    const body = await j(res);
    assert.equal(body.scope, 'mine');
    assert.equal(body.is_admin, false);
    assert.equal(body.items.length, 1);
    assert.ok(body.items.every((it) => it.user_id === member.id), 'KHÔNG được lọt yêu cầu của người khác');
  });

  test('admin thấy TẤT CẢ; `?mine=1` chỉ của mình; `?status=` lọc thật; status lạ ⇒ 400', async () => {
    const all = await j(await request(ctx.base, TOPUP_PATH, { jar: owner.jar }));
    assert.equal(all.scope, 'all');
    assert.equal(all.items.length, 2);
    assert.equal(all.total, 2);

    const mine = await j(await request(ctx.base, `${TOPUP_PATH}?mine=1`, { jar: owner.jar }));
    assert.equal(mine.scope, 'mine');
    assert.equal(mine.items.length, 0, 'owner chưa tạo yêu cầu nào');

    const pending = await j(await request(ctx.base, `${TOPUP_PATH}?status=pending`, { jar: owner.jar }));
    assert.equal(pending.items.length, 2);
    const confirmed = await j(await request(ctx.base, `${TOPUP_PATH}?status=confirmed`, { jar: owner.jar }));
    assert.equal(confirmed.items.length, 0);

    const bad = await request(ctx.base, `${TOPUP_PATH}?status=dang-cho`, { jar: owner.jar });
    assert.equal(bad.status, 400);
    assert.equal((await j(bad)).error.code, 'BAD_STATUS');
  });
});

describe('MVP-06 · XÁC NHẬN / TỪ CHỐI (chỉ admin) — tiền vào ví đúng MỘT lần', () => {
  let ctx;
  let member;
  let owner;
  before(async () => {
    ctx = await startMvp05App();
    member = await newUser(ctx, 'decide-member@example.com');
    owner = await newUser(ctx, 'decide-owner@example.com', { role: 'owner' });
  });
  after(async () => {
    await ctx.close();
  });

  const openRequest = async (amountVnd = 260000) => {
    const res = await createRequestFor(ctx.base, member.jar, { amount_vnd: amountVnd, reference: nextRef('C') });
    assert.equal(res.status, 201);
    return (await j(res)).request;
  };

  test('member cố xác nhận/từ chối ⇒ 403 FORBIDDEN, sổ không đổi', async () => {
    const req = await openRequest();
    const rowsBefore = (await ledgerRows(ctx.store, member.id)).length;
    for (const verb of ['confirm', 'reject']) {
      const res = await request(ctx.base, `${TOPUP_PATH}/${req.id}/${verb}`, {
        method: 'POST', jar: member.jar, body: { reason: 'tôi tự duyệt' },
      });
      assert.equal(res.status, 403, `${verb} bằng member phải 403`);
      assert.equal((await j(res)).error.code, 'FORBIDDEN');
    }
    assert.equal((await ledgerRows(ctx.store, member.id)).length, rowsBefore);
    assert.equal((await ctx.store.getTopupRequest(req.id)).status, 'pending');
  });

  test('XÁC NHẬN ⇒ ĐÚNG 1 dòng sổ, số dư = tổng sổ, run_key = topup:<id>, tỷ giá được ghi lại', async () => {
    const req = await openRequest(260000);
    const rowsBefore = await ledgerRows(ctx.store, member.id);
    const balanceBefore = await ledgerSum(ctx.store, member.id);

    const res = await request(ctx.base, `${TOPUP_PATH}/${req.id}/confirm`, {
      method: 'POST', jar: owner.jar, body: { note: 'đã thấy tiền trong sao kê' },
    });
    assert.equal(res.status, 200);
    const body = await j(res);
    assert.equal(body.request.status, 'confirmed');
    assert.equal(body.request.credits, 10);
    assert.equal(body.request.rate_vnd_per_credit, 26000);
    assert.equal(body.request.decided_by, owner.id);
    assert.ok(body.request.decided_at, 'phải ghi thời điểm quyết định');
    assert.ok(body.ledger?.id, 'phải trả về dòng sổ vừa sinh');
    assert.equal(body.request.ledger_entry_id, body.ledger.id, 'yêu cầu phải trỏ đúng dòng sổ');

    const rowsAfter = await ledgerRows(ctx.store, member.id);
    assert.equal(rowsAfter.length, rowsBefore.length + 1, 'ĐÚNG MỘT dòng sổ được thêm');
    const row = rowsAfter.find((r) => r.id === body.ledger.id);
    assert.equal(row.reason, 'admin_grant');
    assert.equal(row.amount, 10);
    assert.equal(row.run_key, `topup:${req.id}`, 'dòng sổ phải mang khoá chống cộng 2 lần');

    const balanceAfter = await ledgerSum(ctx.store, member.id);
    assert.equal(balanceAfter, Math.round((balanceBefore + 10) * 1e6) / 1e6);
    assert.equal(body.balance.amount, balanceAfter, 'số dư API trả = TỔNG SỔ');
    assert.equal(row.balance_after, balanceAfter, '`balance_after` của dòng cuối = tổng sổ');

    const events = await ctx.store.listTopupEvents(req.id);
    assert.deepEqual(events.map((e) => e.to_status), ['pending', 'confirmed']);
    assert.equal(events[1].actor_user_id, owner.id);
  });

  test('XÁC NHẬN LẦN HAI ⇒ 409 TOPUP_ALREADY_DECIDED và SỔ KHÔNG ĐỔI', async () => {
    const req = await openRequest(260000);
    const first = await request(ctx.base, `${TOPUP_PATH}/${req.id}/confirm`, { method: 'POST', jar: owner.jar, body: {} });
    assert.equal(first.status, 200);
    const rowsAfterFirst = await ledgerRows(ctx.store, member.id);
    const balanceAfterFirst = await ledgerSum(ctx.store, member.id);

    const second = await request(ctx.base, `${TOPUP_PATH}/${req.id}/confirm`, { method: 'POST', jar: owner.jar, body: {} });
    assert.equal(second.status, 409);
    const err = (await j(second)).error;
    assert.equal(err.code, 'TOPUP_ALREADY_DECIDED');
    assert.equal(err.details.status, 'confirmed');

    assert.equal((await ledgerRows(ctx.store, member.id)).length, rowsAfterFirst.length, 'KHÔNG được ghi dòng thứ hai');
    assert.equal(await ledgerSum(ctx.store, member.id), balanceAfterFirst, 'số dư KHÔNG ĐỔI');
    // Và vết chỉ có đúng hai dòng: pending → confirmed (không có lần chuyển thứ ba).
    assert.equal((await ctx.store.listTopupEvents(req.id)).length, 2);
  });

  test('XÁC NHẬN ĐỒNG THỜI hai lần ⇒ chỉ MỘT lần thành công, đúng 1 dòng sổ', async () => {
    const req = await openRequest(260000);
    const rowsBefore = (await ledgerRows(ctx.store, member.id)).length;
    const [a, b] = await Promise.all([
      request(ctx.base, `${TOPUP_PATH}/${req.id}/confirm`, { method: 'POST', jar: owner.jar, body: {} }),
      request(ctx.base, `${TOPUP_PATH}/${req.id}/confirm`, { method: 'POST', jar: owner.jar, body: {} }),
    ]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [200, 409], `phải là 200 + 409, nhận ${JSON.stringify(codes)}`);
    assert.equal((await ledgerRows(ctx.store, member.id)).length, rowsBefore + 1, 'ĐÚNG MỘT dòng sổ');
    assert.equal((await ctx.store.getTopupRequest(req.id)).status, 'confirmed');
  });

  test('TỪ CHỐI ⇒ 0 dòng sổ, có lý do trong `topup_events`; thiếu lý do ⇒ 400; đã quyết định ⇒ 409', async () => {
    const req = await openRequest(200000);
    const rowsBefore = (await ledgerRows(ctx.store, member.id)).length;

    const noReason = await request(ctx.base, `${TOPUP_PATH}/${req.id}/reject`, { method: 'POST', jar: owner.jar, body: { reason: '   ' } });
    assert.equal(noReason.status, 400);
    assert.equal((await j(noReason)).error.code, 'TOPUP_REASON_REQUIRED');
    assert.equal((await ctx.store.getTopupRequest(req.id)).status, 'pending', 'từ chối thiếu lý do KHÔNG đổi trạng thái');

    const res = await request(ctx.base, `${TOPUP_PATH}/${req.id}/reject`, {
      method: 'POST', jar: owner.jar, body: { reason: 'không thấy tiền trong sao kê ngân hàng' },
    });
    assert.equal(res.status, 200);
    const body = await j(res);
    assert.equal(body.request.status, 'rejected');
    assert.equal(body.ledger, null);
    assert.equal(body.request.ledger_entry_id, null);
    assert.equal((await ledgerRows(ctx.store, member.id)).length, rowsBefore, 'TỪ CHỐI KHÔNG ĐƯỢC SINH DÒNG SỔ NÀO');

    const events = await ctx.store.listTopupEvents(req.id);
    assert.equal(events.at(-1).to_status, 'rejected');
    assert.match(events.at(-1).reason, /sao kê/);

    const again = await request(ctx.base, `${TOPUP_PATH}/${req.id}/confirm`, { method: 'POST', jar: owner.jar, body: {} });
    assert.equal(again.status, 409, 'đã từ chối thì không xác nhận được nữa');
    assert.equal((await j(again)).error.code, 'TOPUP_ALREADY_DECIDED');
    assert.equal((await ledgerRows(ctx.store, member.id)).length, rowsBefore);
  });

  test('yêu cầu không tồn tại ⇒ 404 TOPUP_NOT_FOUND (không tiết lộ gì thêm)', async () => {
    const res = await request(ctx.base, `${TOPUP_PATH}/00000000-0000-4000-8000-000000000000/confirm`, {
      method: 'POST', jar: owner.jar, body: {},
    });
    assert.equal(res.status, 404);
    assert.equal((await j(res)).error.code, 'TOPUP_NOT_FOUND');
  });

  test('admin ghi đè `credits` ⇒ dòng sổ đúng số ghi đè (tỷ giá vẫn được ghi lại)', async () => {
    const req = await openRequest(200000);
    const res = await request(ctx.base, `${TOPUP_PATH}/${req.id}/confirm`, {
      method: 'POST', jar: owner.jar, body: { credits: 7.5, note: 'khuyến mãi cộng thêm' },
    });
    assert.equal(res.status, 200);
    const body = await j(res);
    assert.equal(body.request.credits, 7.5);
    assert.equal(body.ledger.amount, 7.5);
    assert.equal(body.request.rate_vnd_per_credit, 26000);
  });
});

describe('MVP-06 · TRẦN SỐ DƯ — xác nhận vượt trần ⇒ 400 và yêu cầu VẪN pending', () => {
  let ctx;
  let member;
  let owner;
  before(async () => {
    // Trần số dư 5 credit: xác nhận 260.000 VND (= 10 credit) chắc chắn vượt trần.
    ctx = await startMvp05App({ configOverrides: { BILLING_MAX_BALANCE: '5' } });
    member = await newUser(ctx, 'cap-member@example.com');
    owner = await newUser(ctx, 'cap-owner@example.com', { role: 'owner' });
  });
  after(async () => {
    await ctx.close();
  });

  test('vượt trần ⇒ 400 AMOUNT_TOO_LARGE, 0 dòng sổ, yêu cầu còn `pending` (duyệt lại được sau)', async () => {
    const created = await createRequestFor(ctx.base, member.jar, { amount_vnd: 260000, reference: nextRef('CAP') });
    assert.equal(created.status, 201);
    const req = (await j(created)).request;
    const rowsBefore = (await ledgerRows(ctx.store, member.id)).length;

    const res = await request(ctx.base, `${TOPUP_PATH}/${req.id}/confirm`, { method: 'POST', jar: owner.jar, body: {} });
    assert.equal(res.status, 400);
    const err = (await j(res)).error;
    assert.equal(err.code, 'AMOUNT_TOO_LARGE');
    assert.equal(err.details.max_balance, 5);

    assert.equal((await ledgerRows(ctx.store, member.id)).length, rowsBefore, 'KHÔNG được ghi dòng sổ nào');
    const after = await ctx.store.getTopupRequest(req.id);
    assert.equal(after.status, 'pending', 'không cộng được tiền thì KHÔNG được coi là đã duyệt');
    assert.equal(after.ledger_entry_id, null);
    assert.equal((await ctx.store.listTopupEvents(req.id)).length, 1, 'không có lần chuyển trạng thái nào thêm');

    // Duyệt lại với số credit nằm trong trần ⇒ thành công, đúng 1 dòng sổ.
    const ok = await request(ctx.base, `${TOPUP_PATH}/${req.id}/confirm`, {
      method: 'POST', jar: owner.jar, body: { credits: 2, note: 'duyệt một phần, phần còn lại hoàn chuyển khoản' },
    });
    assert.equal(ok.status, 200);
    assert.equal((await ledgerRows(ctx.store, member.id)).length, rowsBefore + 1);
  });
});

describe('MVP-06 · /api/config — tỷ giá + hướng dẫn chuyển khoản LẤY TỪ CẤU HÌNH', () => {
  let ctx;
  before(async () => {
    ctx = await startMvp05App({
      configOverrides: {
        TOPUP_RATE_VND_PER_CREDIT: '25000',
        TOPUP_MIN_VND: '50000',
        TOPUP_MAX_VND: '10000000',
        TOPUP_BANK_NAME: 'Ngân hàng Thử Nghiệm',
        TOPUP_BANK_ACCOUNT_NUMBER: '0123456789',
        TOPUP_BANK_ACCOUNT_HOLDER: 'NGUYEN VAN A',
        TOPUP_TRANSFER_NOTE: 'VPS <email của bạn>',
      },
    });
  });
  after(async () => {
    await ctx.close();
  });

  test('`billing.topup` trả đúng cấu hình; KHÔNG có số tài khoản nào hardcode trong mã nguồn', async () => {
    const cfg = await j(await request(ctx.base, '/api/config', {}));
    const topup = cfg.billing.topup;
    assert.equal(topup.rate_vnd_per_credit, 25000);
    assert.equal(topup.min_topup_vnd, 50000);
    assert.equal(topup.max_topup_vnd, 10000000);
    assert.equal(topup.method, 'bank_transfer');
    assert.equal(topup.bank.bank_name, 'Ngân hàng Thử Nghiệm');
    assert.equal(topup.bank.account_number, '0123456789');
    assert.equal(topup.bank.account_holder, 'NGUYEN VAN A');
    assert.equal(topup.bank.configured, true);
    assert.match(topup.note, /không tự biết tiền đã về/i);
  });

  test('tỷ giá cấu hình được dùng THẬT khi tạo yêu cầu (bản xem trước 50.000 VND = 2 credit)', async () => {
    const user = await newUser(ctx, 'cfg-member@example.com');
    const res = await createRequestFor(ctx.base, user.jar, { amount_vnd: 50000, reference: nextRef('CFG') });
    assert.equal(res.status, 201);
    const req = (await j(res)).request;
    assert.equal(req.rate_vnd_per_credit, 25000);
    assert.equal(req.credits, 2);
  });

  test('chưa khai TOPUP_BANK_* ⇒ `configured: false` (UI nói thật, KHÔNG bịa số tài khoản)', async () => {
    const plain = await startMvp05App();
    try {
      const cfg = await j(await request(plain.base, '/api/config', {}));
      assert.equal(cfg.billing.topup.bank.configured, false);
      assert.equal(cfg.billing.topup.bank.account_number, '');
      assert.equal(cfg.billing.topup.rate_vnd_per_credit, 26000, 'mặc định của repo');
    } finally {
      await plain.close();
    }
  });
});
