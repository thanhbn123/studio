/**
 * TEST MVP-06 · nghiệp vụ + tầng dữ liệu (`src/billing/topup.js`, `src/store/index.js`).
 *
 * Phủ những luật KHÔNG đi qua HTTP được:
 *   - khác chủ ⇒ `TOPUP_NOT_FOUND` (404 — không tiết lộ là có tồn tại);
 *   - ĐỔI TỶ GIÁ sau khi duyệt ⇒ yêu cầu CŨ giữ nguyên `rate_vnd_per_credit` đã ghi (luật #3);
 *   - `decideTopupRequest` chỉ chuyển trạng thái MỘT LẦN (lần hai trả `null`, không thêm vết);
 *   - bảng `topup_*` là APPEND-ONLY về nội dung: trong CẢ mã nguồn không có UPDATE nào chạm
 *     `amount_vnd`/`reference`/`note`, và không có DELETE nào;
 *   - index + unique index của MVP-06 được tạo THẬT trên DB (tạo SAU migration).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './imagelab-helpers.js';
import { testConfig, silent } from './helpers.js';
import { createStore, topupRunKey, TOPUP_STATUSES } from '../src/store/index.js';
import { createBillingService } from '../src/billing/index.js';
import { createTopupService, TopupError, TOPUP_HONEST_NOTE } from '../src/billing/topup.js';

/** Một "thế giới" nhỏ: store SQLite in-memory + ví thật + service nạp credit thật. */
async function makeWorld({ topup = {}, billing = {} } = {}) {
  const config = testConfig();
  config.billing = { ...config.billing, ...billing, topup: { ...config.billing.topup, ...topup } };
  const store = await createStore(config, silent);
  const wallet = createBillingService(config, { store, logger: silent });
  const svc = createTopupService(config, { store, billing: wallet, logger: silent });
  const user = await store.createUser({ email: 'owner-of-wallet@example.com', passwordHash: 'scrypt$fake' });
  const other = await store.createUser({ email: 'someone-else@example.com', passwordHash: 'scrypt$fake' });
  const admin = await store.createUser({ email: 'admin@example.com', role: 'owner', passwordHash: 'scrypt$fake' });
  return { config, store, wallet, svc, user, other, admin, close: () => store.close() };
}

const err = async (fn) => {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  return null;
};

describe('MVP-06 · service — quyền xem, tỷ giá đóng băng lúc duyệt', () => {
  let w;
  before(async () => {
    w = await makeWorld();
  });
  after(async () => {
    await w.close();
  });

  test('yêu cầu của người KHÁC ⇒ TOPUP_NOT_FOUND (không phân biệt với "không tồn tại")', async () => {
    const req = await w.svc.createRequest({ userId: w.user.id, amountVnd: 260000, reference: 'REF-OWNERSHIP' });
    const mine = await w.svc.get({ requestId: req.id, requesterId: w.user.id });
    assert.equal(mine.id, req.id);

    const stolen = await err(() => w.svc.get({ requestId: req.id, requesterId: w.other.id }));
    assert.ok(stolen instanceof TopupError);
    assert.equal(stolen.code, 'TOPUP_NOT_FOUND');

    const missing = await err(() => w.svc.get({ requestId: 'khong-ton-tai', requesterId: w.user.id }));
    assert.equal(missing.code, 'TOPUP_NOT_FOUND', 'cùng MỘT mã lỗi ⇒ không dò được id của người khác');

    // Admin vẫn xem được (đó là người phải đối soát với sao kê ngân hàng).
    assert.equal((await w.svc.get({ requestId: req.id, isAdmin: true })).id, req.id);
  });

  test('ẩn danh KHÔNG tạo được yêu cầu (chốt thứ hai sau 401 của HTTP)', async () => {
    const e = await err(() => w.svc.createRequest({ userId: '', amountVnd: 260000, reference: 'REF-ANON' }));
    assert.equal(e.code, 'TOPUP_ANONYMOUS');
    assert.equal(await w.store.countTopupRequests({ userId: null }), 1, 'chỉ còn yêu cầu của ca trước');
  });

  test('ĐỔI TỶ GIÁ sau khi duyệt ⇒ yêu cầu CŨ giữ nguyên tỷ giá đã ghi (luật #3)', async () => {
    const req = await w.svc.createRequest({ userId: w.user.id, amountVnd: 260000, reference: 'REF-RATE' });
    assert.equal(req.rate_vnd_per_credit, 26000);
    const { request: confirmed } = await w.svc.confirm({ requestId: req.id, actorId: w.admin.id });
    assert.equal(confirmed.rate_vnd_per_credit, 26000);
    assert.equal(confirmed.credits, 10);

    // Quản trị đổi tỷ giá (dữ liệu CẤU HÌNH, không phải cột DB) — yêu cầu cũ KHÔNG được đổi theo.
    w.config.billing.topup.rateVndPerCredit = 40000;
    assert.equal(w.svc.rate(), 40000, 'tỷ giá mới có hiệu lực cho yêu cầu MỚI');
    const reread = await w.store.getTopupRequest(req.id);
    assert.equal(reread.rate_vnd_per_credit, 26000, 'lịch sử KHÔNG được sửa theo tỷ giá mới');
    assert.equal(reread.credits, 10);

    const next = await w.svc.createRequest({ userId: w.user.id, amountVnd: 400000, reference: 'REF-RATE-2' });
    assert.equal(next.rate_vnd_per_credit, 40000);
    assert.equal(next.credits, 10);
    w.config.billing.topup.rateVndPerCredit = 26000;
  });

  test('cấu hình rác ⇒ mặc định an toàn (tỷ giá > 0, min/max đảo chỗ được sửa)', async () => {
    const bad = await makeWorld({ topup: { rateVndPerCredit: 0, minVnd: 900000, maxVnd: 100000 } });
    try {
      assert.equal(bad.svc.rate(), 26000, 'tỷ giá 0 sẽ là credit miễn phí ⇒ phải rơi về mặc định');
      assert.deepEqual(bad.svc.limits(), { min: 100000, max: 900000 });
      assert.equal(bad.svc.publicConfig().note, TOPUP_HONEST_NOTE);
    } finally {
      await bad.close();
    }
  });

  test('ví chưa sẵn sàng ⇒ TOPUP_UNAVAILABLE (fail-closed, KHÔNG duyệt mà không cộng được tiền)', async () => {
    const noWallet = createTopupService(w.config, { store: w.store, billing: null, logger: silent });
    const req = await w.svc.createRequest({ userId: w.user.id, amountVnd: 200000, reference: 'REF-NOWALLET' });
    const e = await err(() => noWallet.confirm({ requestId: req.id, actorId: w.admin.id }));
    assert.equal(e.code, 'TOPUP_UNAVAILABLE');
    assert.equal((await w.store.getTopupRequest(req.id)).status, 'pending');
  });
});

describe('MVP-06 · store — chuyển trạng thái MỘT LẦN + vết đầy đủ', () => {
  let w;
  before(async () => {
    w = await makeWorld();
  });
  after(async () => {
    await w.close();
  });

  test('`decideTopupRequest` lần hai ⇒ `null` và KHÔNG thêm dòng `topup_events`', async () => {
    const req = await w.store.createTopupRequest({ userId: w.user.id, amountVnd: 200000, reference: 'S-ONCE' });
    assert.equal(req.status, 'pending');
    assert.equal(req.run_key, topupRunKey(req.id));

    const first = await w.store.decideTopupRequest(req.id, { toStatus: 'rejected', actorUserId: w.admin.id, reason: 'sai nội dung' });
    assert.equal(first.status, 'rejected');
    assert.equal((await w.store.listTopupEvents(req.id)).length, 2);

    const second = await w.store.decideTopupRequest(req.id, { toStatus: 'confirmed', actorUserId: w.admin.id, reason: 'đổi ý' });
    assert.equal(second, null, 'đã quyết định ⇒ KHÔNG chuyển được nữa');
    assert.equal((await w.store.listTopupEvents(req.id)).length, 2, 'không có vết thứ ba');
    assert.equal((await w.store.getTopupRequest(req.id)).status, 'rejected');
  });

  test('trạng thái đích không hợp lệ ⇒ INVALID_TOPUP_STATUS; `pending` không phải đích', async () => {
    const req = await w.store.createTopupRequest({ userId: w.user.id, amountVnd: 200000, reference: 'S-BADSTATUS' });
    for (const bad of ['pending', 'dang-cho', '']) {
      const e = await err(() => w.store.decideTopupRequest(req.id, { toStatus: bad }));
      assert.equal(e.code, 'INVALID_TOPUP_STATUS', `toStatus=${JSON.stringify(bad)} phải bị chặn`);
    }
    assert.deepEqual([...TOPUP_STATUSES], ['pending', 'confirmed', 'rejected', 'expired']);
  });

  test('thiếu `userId`/`amount_vnd` ⇒ lỗi nghiệp vụ, KHÔNG ghi dòng nào', async () => {
    const before = await w.store.countTopupRequests({});
    assert.equal((await err(() => w.store.createTopupRequest({ amountVnd: 200000 }))).code, 'INVALID_TOPUP_REQUEST');
    assert.equal((await err(() => w.store.createTopupRequest({ userId: w.user.id, amountVnd: 'nhiều' }))).code, 'INVALID_TOPUP_AMOUNT');
    assert.equal(await w.store.countTopupRequests({}), before);
  });

  test('index + unique index của MVP-06 có THẬT trên DB (tạo SAU migration)', async () => {
    const rows = await w.store.driver.all(
      "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_topup%' OR name LIKE 'uniq_topup%' OR name = 'uniq_wallet_ledger_topup_run'",
    );
    const names = rows.map((r) => r.name);
    for (const expected of [
      'idx_topup_requests_user',
      'idx_topup_requests_status',
      'idx_topup_events_request',
      'uniq_topup_requests_reference',
      'uniq_wallet_ledger_topup_run',
    ]) {
      assert.ok(names.includes(expected), `thiếu index ${expected} (có: ${names.join(', ')})`);
    }
    // `schema.sql` TUYỆT ĐỐI không được chứa index của hai bảng này (bài học `wallet_ledger.seq`).
    const schema = fs.readFileSync(path.join(ROOT, 'src', 'store', 'schema.sql'), 'utf8')
      .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
    assert.equal(
      /CREATE\s+(UNIQUE\s+)?INDEX[^;]*topup/i.test(schema),
      false,
      'index của topup_* phải nằm trong migration, KHÔNG trong schema.sql',
    );
  });

  test('mã nguồn KHÔNG có đường sửa/xoá nội dung yêu cầu nạp (luật #2)', async () => {
    const files = ['src/store/index.js', 'src/billing/topup.js', 'src/http/routes.js'];
    for (const rel of files) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assert.equal(/DELETE\s+FROM\s+topup_/i.test(src), false, `${rel}: không được có DELETE trên bảng topup_*`);
      assert.equal(/UPDATE\s+topup_events/i.test(src), false, `${rel}: vết chuyển trạng thái là APPEND-ONLY`);
      // UPDATE duy nhất được phép là câu chuyển trạng thái; nó KHÔNG chạm các cột nội dung.
      for (const m of src.match(/UPDATE\s+topup_requests[\s\S]{0,400}?WHERE[^;]*/gi) || []) {
        for (const column of ['amount_vnd', 'reference', 'note', 'created_at', 'user_id']) {
          assert.equal(
            new RegExp(`SET[\\s\\S]*\\b${column}\\s*=`, 'i').test(m),
            false,
            `${rel}: câu UPDATE không được sửa cột \`${column}\``,
          );
        }
        assert.match(m, /WHERE id = \? AND status = 'pending'/, `${rel}: chuyển trạng thái phải có điều kiện \`status='pending'\``);
      }
    }
  });
});
