/**
 * TEST MVP-05 · A4 — API (`src/http/routes.js`, hợp đồng §3.3/§3.4b) trên server THẬT.
 *
 * Phủ: vòng đời đăng ký/đăng nhập/đăng xuất + cookie; chống dò tài khoản (401 giống nhau);
 * tách dữ liệu theo tài khoản (IDOR ⇒ 404, kể cả route file ảnh); phân quyền quản trị
 * (401/403/200); ví 402 TRƯỚC khi tạo job (DB không tăng); hai cờ cấu hình AUTH_ENABLED /
 * AUTH_ANONYMOUS_ALLOWED.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { productImage } from './imagestudio-helpers.js';
import {
  startMvp05App,
  register,
  login,
  logout,
  me,
  request,
  j,
  waitJob,
  countRows,
  newJar,
  sha256,
  PASSWORD,
} from './mvp05-helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const authCookieOf = (res) => (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('vauth=')) ?? null;

describe('MVP-05 · API — đăng ký / đăng nhập / phiên', () => {
  let ctx;
  before(async () => {
    ctx = await startMvp05App();
  });
  after(async () => {
    await ctx.close();
  });

  test('register → 201, Set-Cookie HttpOnly/SameSite=Lax, email chuẩn hoá lowercase', async () => {
    const jar = newJar();
    const res = await request(ctx.base, '/api/auth/register', {
      method: 'POST',
      jar,
      body: { email: '  AtLeAsT@Example.COM ', password: PASSWORD, display_name: '  Nguyễn   Văn A ' },
    });
    assert.equal(res.status, 201);
    const cookie = authCookieOf(res);
    assert.ok(cookie, 'phải có Set-Cookie `vauth`');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=\d+/);
    assert.equal(/Secure/i.test(cookie), false, 'http thường thì không đặt Secure (chỉ khi PUBLIC_BASE_URL https)');

    const body = await j(res);
    assert.match(body.user.id, UUID_RE);
    assert.equal(body.user.email, 'atleast@example.com');
    assert.equal(body.user.display_name, 'Nguyễn Văn A');
    assert.equal(body.user.role, 'member', 'tự đăng ký luôn là member');
    assert.equal(body.user.status, 'active');
    assert.ok(Date.parse(body.expires_at) > Date.now());

    const raw = JSON.stringify(body);
    assert.equal('password_hash' in body.user, false);
    assert.equal(raw.includes(PASSWORD), false, 'response KHÔNG được chứa mật khẩu');
    assert.equal(cookie.includes('atleast@'), false, 'cookie KHÔNG được chứa email');
    assert.equal(cookie.includes(body.user.id), false, 'cookie KHÔNG được chứa id người dùng');
  });

  test('login → 200 + Set-Cookie; sai mật khẩu và email không tồn tại ⇒ CÙNG 401/CÙNG câu', async () => {
    const jar = newJar();
    const res = await request(ctx.base, '/api/auth/login', {
      method: 'POST',
      jar,
      body: { email: 'atleast@example.com', password: PASSWORD },
    });
    assert.equal(res.status, 200);
    assert.ok(authCookieOf(res));
    const body = await j(res);
    assert.equal(body.user.email, 'atleast@example.com');

    const wrong = await request(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'atleast@example.com', password: 'sai-mat-khau-dai-dai' } });
    const unknown = await request(ctx.base, '/api/auth/login', { method: 'POST', body: { email: 'khong-co-ai@example.com', password: 'sai-mat-khau-dai-dai' } });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    const wrongBody = await j(wrong);
    const unknownBody = await j(unknown);
    assert.equal(wrongBody.error.code, 'BAD_CREDENTIALS');
    assert.equal(unknownBody.error.code, 'BAD_CREDENTIALS');
    assert.equal(wrongBody.error.message, unknownBody.error.message, 'không được để lộ email nào tồn tại');
  });

  test('email trùng ⇒ 409 EMAIL_TAKEN; mật khẩu yếu ⇒ 400 WEAK_PASSWORD (nêu đúng sàn 10)', async () => {
    const dup = await request(ctx.base, '/api/auth/register', {
      method: 'POST',
      body: { email: 'ATLEAST@example.com', password: PASSWORD },
    });
    assert.equal(dup.status, 409);
    assert.equal((await j(dup)).error.code, 'EMAIL_TAKEN');

    const weak = await request(ctx.base, '/api/auth/register', {
      method: 'POST',
      body: { email: 'mat-khau-yeu@example.com', password: 'a'.repeat(9) },
    });
    assert.equal(weak.status, 400);
    const weakBody = await j(weak);
    assert.equal(weakBody.error.code, 'WEAK_PASSWORD');
    assert.match(weakBody.error.message, /10/, 'câu lỗi phải nêu đúng độ dài tối thiểu của hợp đồng');

    const missing = await request(ctx.base, '/api/auth/register', { method: 'POST', body: { email: 'thieu@example.com' } });
    assert.equal(missing.status, 400);
  });

  test('me: trước đăng nhập ⇒ ẩn danh; sau ⇒ user + số dư; sau logout ⇒ token cũ vô hiệu', async () => {
    const anon = await j(await me(ctx.base, newJar()));
    assert.deepEqual(anon, { user: null, anonymous: true, balance: null });

    const jar = newJar();
    const reg = await register(ctx.base, { email: 'phien-api@example.com', password: PASSWORD, jar });
    assert.equal(reg.res.status, 201);
    const token = jar.vauth;
    assert.ok(token);

    const signed = await j(await me(ctx.base, jar));
    assert.equal(signed.anonymous, false);
    assert.equal(signed.user.email, 'phien-api@example.com');
    assert.deepEqual(signed.balance, { amount: 0, currency: 'USD' }, 'ví mới mở ⇒ 0 credit (không bịa số dư)');

    const out = await logout(ctx.base, jar);
    assert.equal(out.status, 200);
    assert.deepEqual(await j(out), { ok: true });
    const cleared = authCookieOf(out);
    assert.ok(cleared, 'logout phải xoá cookie `vauth`');
    assert.match(cleared, /Max-Age=0/);
    assert.equal(jar.vauth, undefined, 'client không còn token sau logout');

    const oldJar = { vauth: token };
    const afterLogout = await j(await me(ctx.base, oldJar));
    assert.equal(afterLogout.anonymous, true, 'token cũ phải vô hiệu ngay');
    const session = await ctx.store.getUserSessionByTokenHash(sha256(token));
    assert.ok(session?.revoked_at, 'phiên phải bị thu hồi trong DB');

    const again = await logout(ctx.base, oldJar);
    assert.equal(again.status, 200, 'logout idempotent ở tầng HTTP');
  });

  test('GET /api/billing/ledger: ẩn danh ⇒ 401; đã đăng nhập ⇒ sổ của CHÍNH mình', async () => {
    const anon = await request(ctx.base, '/api/billing/ledger');
    assert.equal(anon.status, 401);
    assert.equal((await j(anon)).error.code, 'UNAUTHENTICATED');

    const jar = newJar();
    const reg = await register(ctx.base, { email: 'so-rieng@example.com', password: PASSWORD, jar });
    const userId = reg.body.user.id;
    await ctx.app.billingService.grant({ userId, amount: 2, reason: 'admin_grant', actorId: 'admin-test' });

    const res = await request(ctx.base, '/api/billing/ledger', { jar });
    assert.equal(res.status, 200);
    const body = await j(res);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].reason, 'admin_grant');
    assert.equal(body.items[0].amount, 2);
    assert.deepEqual(body.balance, { amount: 2, currency: 'USD' });
    assert.equal(JSON.stringify(body).includes('0000000000000004'), false, 'API cũng phải trả số đã làm tròn 6 chữ số');

    const other = newJar();
    await register(ctx.base, { email: 'so-nguoi-khac@example.com', password: PASSWORD, jar: other });
    const otherBody = await j(await request(ctx.base, '/api/billing/ledger', { jar: other }));
    assert.deepEqual(otherBody.items, [], 'sổ của người khác KHÔNG được lộ');
    assert.equal(otherBody.balance.amount, 0);
  });

  test('GET /api/billing/pricing là CÔNG KHAI và đủ 10 operation (CONTENT_REPAIR có giá)', async () => {
    const res = await request(ctx.base, '/api/billing/pricing');
    assert.equal(res.status, 200);
    const { pricing } = await j(res);
    assert.equal(pricing.length, 10);
    const repair = pricing.find((row) => row.operation === 'CONTENT_REPAIR');
    assert.ok(repair && repair.unit_price > 0, 'CONTENT_REPAIR PHẢI có giá');
    for (const row of pricing) {
      assert.ok(row.unit_price > 0, `${row.operation} phải có giá > 0`);
      assert.equal(row.currency, 'USD');
    }
  });
});

describe('MVP-05 · API — IDOR: user B không đọc được dữ liệu của user A (404)', () => {
  let ctx;
  let alice;
  let bob;
  let aliceJobId;
  let aliceAssetId;

  before(async () => {
    ctx = await startMvp05App();
    const a = await register(ctx.base, { email: 'alice@example.com', password: PASSWORD });
    const b = await register(ctx.base, { email: 'bob@example.com', password: PASSWORD });
    alice = { id: a.body.user.id, jar: a.jar };
    bob = { id: b.body.user.id, jar: b.jar };

    aliceJobId = await ctx.store.createJob({ sessionId: 'alice-session', userId: alice.id, kind: 'content', source: 'manual' });
    await ctx.store.recordUsage({ jobId: aliceJobId, sessionId: 'alice-session', operation: 'CONTENT_GENERATE', estimatedCost: 0.004 });
    aliceAssetId = await ctx.store.createImageAsset({
      jobId: aliceJobId, sessionId: 'alice-session', userId: alice.id, role: 'original',
      mime: 'image/png', bytes: 64, width: 8, height: 8, sha256: 'a'.repeat(64),
    });
    await ctx.store.appendLedger({ userId: alice.id, amount: 5, reason: 'admin_grant' });
  });
  after(async () => {
    await ctx.close();
  });

  test('GET /api/jobs/:id của A: B ⇒ 404; chính A ⇒ 200', async () => {
    const asBob = await request(ctx.base, `/api/jobs/${aliceJobId}`, { jar: bob.jar });
    assert.equal(asBob.status, 404);
    assert.equal((await j(asBob)).error.code, 'JOB_NOT_FOUND');
    const asAlice = await request(ctx.base, `/api/jobs/${aliceJobId}`, { jar: alice.jar });
    assert.equal(asAlice.status, 200);
    assert.equal((await j(asAlice)).id, aliceJobId);
  });

  test('GET /api/jobs (list) của B KHÔNG chứa job của A; list của A thì có', async () => {
    const asBob = await j(await request(ctx.base, '/api/jobs?limit=50', { jar: bob.jar }));
    assert.equal(asBob.items.some((item) => item.id === aliceJobId), false, 'danh sách của B không được lộ job của A');
    const asAlice = await j(await request(ctx.base, '/api/jobs?limit=50', { jar: alice.jar }));
    assert.ok(asAlice.items.some((item) => item.id === aliceJobId), 'A phải thấy job của chính mình');
  });

  test('GET /api/jobs/:id/usage của A: B ⇒ 404', async () => {
    const res = await request(ctx.base, `/api/jobs/${aliceJobId}/usage`, { jar: bob.jar });
    assert.equal(res.status, 404);
  });

  test('route FILE ảnh: B ⇒ 404 ở cả imagelab lẫn imagestudio; A đọc được metadata', async () => {
    const meta = await request(ctx.base, `/api/imagelab/assets/${aliceAssetId}`, { jar: alice.jar });
    assert.equal(meta.status, 200);

    const metaBob = await request(ctx.base, `/api/imagelab/assets/${aliceAssetId}`, { jar: bob.jar });
    assert.equal(metaBob.status, 404);
    assert.equal((await j(metaBob)).error.code, 'ASSET_NOT_FOUND');

    const fileBob = await request(ctx.base, `/api/imagelab/assets/${aliceAssetId}/file`, { jar: bob.jar });
    assert.equal(fileBob.status, 404);
    assert.equal((await j(fileBob)).error.code, 'ASSET_NOT_FOUND');

    const isFileBob = await request(ctx.base, `/api/imagestudio/assets/${aliceAssetId}/file`, { jar: bob.jar });
    assert.equal(isFileBob.status, 404);
    assert.equal((await j(isFileBob)).error.code, 'ASSET_NOT_FOUND');
  });

  test('sổ credit của A không lộ qua API của B; ghi trộm job của A cũng 404', async () => {
    const asBob = await j(await request(ctx.base, '/api/billing/ledger', { jar: bob.jar }));
    assert.deepEqual(asBob.items, []);
    assert.equal(asBob.balance.amount, 0);
    const asAlice = await j(await request(ctx.base, '/api/billing/ledger', { jar: alice.jar }));
    assert.ok(asAlice.items.length >= 1);

    const write = await request(ctx.base, `/api/jobs/${aliceJobId}/content`, {
      method: 'PUT',
      jar: bob.jar,
      body: { headline: 'B sửa trộm' },
    });
    assert.equal(write.status, 404, 'B không được GHI vào job của A');
  });
});

describe('MVP-05 · API — phân quyền quản trị (401/403/200) + cấp credit', () => {
  let ctx;
  let owner;
  let admin;
  let member;
  let targetId;

  before(async () => {
    ctx = await startMvp05App();
    const o = await register(ctx.base, { email: 'owner@example.com', password: PASSWORD });
    const a = await register(ctx.base, { email: 'admin@example.com', password: PASSWORD });
    const m = await register(ctx.base, { email: 'member@example.com', password: PASSWORD });
    const t = await register(ctx.base, { email: 'duoc-cap@example.com', password: PASSWORD });
    owner = { id: o.body.user.id, jar: o.jar };
    admin = { id: a.body.user.id, jar: a.jar };
    member = { id: m.body.user.id, jar: m.jar };
    targetId = t.body.user.id;
    await ctx.store.updateUser(owner.id, { role: 'owner' });
    await ctx.store.updateUser(admin.id, { role: 'admin' });
  });
  after(async () => {
    await ctx.close();
  });

  test('GET /api/admin/users: ẩn danh 401, member 403, owner/admin 200 (không lộ password_hash)', async () => {
    const anon = await request(ctx.base, '/api/admin/users');
    assert.equal(anon.status, 401);
    assert.equal((await j(anon)).error.code, 'UNAUTHENTICATED');

    const asMember = await request(ctx.base, '/api/admin/users', { jar: member.jar });
    assert.equal(asMember.status, 403);
    assert.equal((await j(asMember)).error.code, 'FORBIDDEN');

    for (const who of [owner, admin]) {
      const res = await request(ctx.base, '/api/admin/users?limit=10', { jar: who.jar });
      assert.equal(res.status, 200);
      const body = await j(res);
      assert.ok(Array.isArray(body.items) && body.items.length >= 4);
      assert.equal(typeof body.total, 'number');
      assert.equal(JSON.stringify(body).includes('password_hash'), false, 'danh sách KHÔNG được lộ password_hash');
    }
  });

  test('POST /api/admin/users/:id/credit: 403 với member; 201 với owner + số dư đổi; amount ≤ 0 ⇒ 400; user lạ ⇒ 404', async () => {
    const asMember = await request(ctx.base, `/api/admin/users/${targetId}/credit`, {
      method: 'POST', jar: member.jar, body: { amount: 5 },
    });
    assert.equal(asMember.status, 403);

    const ok = await request(ctx.base, `/api/admin/users/${targetId}/credit`, {
      method: 'POST', jar: owner.jar, body: { amount: 1.25, note: 'tặng thử nghiệm' },
    });
    assert.equal(ok.status, 201);
    const okBody = await j(ok);
    assert.equal(okBody.ledger.reason, 'admin_grant');
    assert.equal(okBody.ledger.amount, 1.25);
    assert.equal(okBody.balance.amount, 1.25);

    const balance = await j(await me(ctx.base, (await login(ctx.base, { email: 'duoc-cap@example.com', password: PASSWORD })).jar));
    assert.equal(balance.balance.amount, 1.25, 'số dư đổi thật, đọc lại từ API');

    // PB-07 (vòng 2): số ÂM nay là ĐIỀU CHỈNH GIẢM hợp lệ (UI vẫn ghi "âm = điều chỉnh giảm"),
    // nên chỉ 0 và giá trị không phải số mới là 400 BAD_AMOUNT.
    for (const amount of [0, 'khong-phai-so']) {
      const bad = await request(ctx.base, `/api/admin/users/${targetId}/credit`, {
        method: 'POST', jar: owner.jar, body: { amount },
      });
      assert.equal(bad.status, 400, `amount=${JSON.stringify(amount)} phải là 400`);
      assert.equal((await j(bad)).error.code, 'BAD_AMOUNT');
    }

    const minus = await request(ctx.base, `/api/admin/users/${targetId}/credit`, {
      method: 'POST', jar: owner.jar, body: { amount: -0.25, note: 'điều chỉnh giảm' },
    });
    assert.equal(minus.status, 201, 'PB-07: số âm phải được nhận (điều chỉnh giảm)');
    const minusBody = await j(minus);
    assert.equal(minusBody.ledger.reason, 'adjustment', 'số âm ⇒ reason = adjustment');
    assert.equal(minusBody.balance.amount, 1, 'số dư giảm đúng 0.25 (1.25 → 1)');

    const tooMuch = await request(ctx.base, `/api/admin/users/${targetId}/credit`, {
      method: 'POST', jar: owner.jar, body: { amount: -99 },
    });
    assert.equal(tooMuch.status, 400, 'giảm quá số dư ⇒ 400 (luật số dư không âm)');
    assert.equal((await j(tooMuch)).error.code, 'INSUFFICIENT_CREDIT');

    const missing = await request(ctx.base, `/api/admin/users/${'f'.repeat(8)}-1111-2222-3333-444444444444/credit`, {
      method: 'POST', jar: owner.jar, body: { amount: 5 },
    });
    assert.equal(missing.status, 404);
    assert.equal((await j(missing)).error.code, 'USER_NOT_FOUND');
  });

  test('GET /api/admin/usage: owner ⇒ rows THẬT theo 3 kiểu gộp; group_by lạ ⇒ 400', async () => {
    const jobId = await ctx.store.createJob({ sessionId: 'owner-s', userId: owner.id, kind: 'content' });
    await ctx.store.recordUsage({ jobId, sessionId: 'owner-s', operation: 'CONTENT_GENERATE', estimatedCost: 0.004, inputUnits: 7 });
    await ctx.store.recordUsage({ jobId, sessionId: 'owner-s', operation: 'TRANSLATION', estimatedCost: 0.0008, inputUnits: 2 });

    const cases = [
      ['day', (rows) => rows.some((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.group))],
      ['operation', (rows) => ['CONTENT_GENERATE', 'TRANSLATION'].every((op) => rows.some((row) => row.group === op))],
      ['user', (rows) => rows.some((row) => row.user_id === owner.id && row.events >= 2)],
    ];
    for (const [groupBy, check] of cases) {
      const res = await request(ctx.base, `/api/admin/usage?group_by=${groupBy}`, { jar: owner.jar });
      assert.equal(res.status, 200);
      const { rows } = await j(res);
      assert.ok(Array.isArray(rows) && rows.length >= 1, `group_by=${groupBy} phải có dữ liệu`);
      assert.ok(check(rows), `group_by=${groupBy} trả nhóm SAI: ${JSON.stringify(rows)}`);
      for (const row of rows) {
        assert.equal(typeof row.events, 'number');
        assert.equal(typeof row.estimated_cost, 'number');
      }
    }

    const bad = await request(ctx.base, '/api/admin/usage?group_by=thang', { jar: owner.jar });
    assert.equal(bad.status, 400);
    assert.equal((await j(bad)).error.code, 'BAD_GROUP_BY');

    const asMember = await request(ctx.base, '/api/admin/usage?group_by=day', { jar: member.jar });
    assert.equal(asMember.status, 403);
  });

  test('POST /api/admin/users/:id/role: đổi vai trò thật; hạ cấp owner CUỐI CÙNG ⇒ 409 LAST_OWNER', async () => {
    const promote = await request(ctx.base, `/api/admin/users/${targetId}/role`, {
      method: 'POST', jar: owner.jar, body: { role: 'admin' },
    });
    assert.equal(promote.status, 200);
    assert.equal((await j(promote)).user.role, 'admin');
    assert.equal((await ctx.store.getUserById(targetId)).role, 'admin');

    const badRole = await request(ctx.base, `/api/admin/users/${targetId}/role`, {
      method: 'POST', jar: owner.jar, body: { role: 'root' },
    });
    assert.equal(badRole.status, 400);
    assert.equal((await j(badRole)).error.code, 'BAD_ROLE');

    const demoteLastOwner = await request(ctx.base, `/api/admin/users/${owner.id}/role`, {
      method: 'POST', jar: owner.jar, body: { role: 'member' },
    });
    assert.equal(demoteLastOwner.status, 409);
    assert.equal((await j(demoteLastOwner)).error.code, 'LAST_OWNER');
    assert.equal((await ctx.store.getUserById(owner.id)).role, 'owner', 'DB không được đổi khi bị chặn');
  });
});

describe('MVP-05 · API — 402 TRƯỚC khi chạy job (DB không tăng)', () => {
  let ctx;
  let jar;
  let userId;
  let png;

  before(async () => {
    ctx = await startMvp05App();
    const reg = await register(ctx.base, { email: 'vi-trong@example.com', password: PASSWORD });
    jar = reg.jar;
    userId = reg.body.user.id;
    png = productImage();
  });
  after(async () => {
    await ctx.close();
  });

  test('ví 0 ⇒ POST /api/jobs trả 402 INSUFFICIENT_CREDIT + details; jobs/ảnh/regions KHÔNG tăng', async () => {
    const jobsBefore = await countRows(ctx.store, 'jobs');
    const assetsBefore = await countRows(ctx.store, 'image_assets');
    const regionsBefore = await countRows(ctx.store, 'ocr_regions');

    const res = await request(ctx.base, '/api/jobs', {
      method: 'POST', jar, body: { manual: { title: 'Không đủ credit', notes: 'x' } },
    });
    assert.equal(res.status, 402);
    const body = await j(res);
    assert.equal(body.error.code, 'INSUFFICIENT_CREDIT');
    assert.ok(body.error.details, 'phải kèm details');
    assert.ok(Number(body.error.details.required) > 0, 'details.required phải > 0');
    assert.equal(body.error.details.balance, 0);
    assert.equal(body.error.details.currency, 'USD');
    assert.match(body.error.message, /credit/i);

    assert.equal(await countRows(ctx.store, 'jobs'), jobsBefore, 'thiếu credit ⇒ KHÔNG tạo job');
    assert.equal(await countRows(ctx.store, 'image_assets'), assetsBefore);
    assert.equal(await countRows(ctx.store, 'ocr_regions'), regionsBefore);
    assert.equal(await countRows(ctx.store, 'wallet_ledger'), 0, 'thiếu credit ⇒ không dòng sổ nào');
  });

  test('ví 0 ⇒ POST /api/imagelab/jobs và /api/imagestudio/jobs cũng 402, không lưu ảnh nào', async () => {
    for (const path of ['/api/imagelab/jobs', '/api/imagestudio/jobs']) {
      const jobsBefore = await countRows(ctx.store, 'jobs');
      const assetsBefore = await countRows(ctx.store, 'image_assets');
      const res = await request(ctx.base, path, {
        method: 'POST',
        jar,
        body: { image: { base64: png.toString('base64'), filename: 'sp.png' }, options: {} },
      });
      assert.equal(res.status, 402, `${path} phải chặn TRƯỚC khi nhận ảnh`);
      assert.equal((await j(res)).error.code, 'INSUFFICIENT_CREDIT');
      assert.equal(await countRows(ctx.store, 'jobs'), jobsBefore, `${path}: không được tạo job`);
      assert.equal(await countRows(ctx.store, 'image_assets'), assetsBefore, `${path}: không được lưu ảnh`);
    }
  });

  test('ví thiếu MỘT PHẦN: 402 nêu ĐÚNG số cần (0.0083) / số có, ví KHÔNG bị trừ, không job nào được tạo', async () => {
    const reg = await register(ctx.base, { email: 'vi-thieu-mot-phan@example.com', password: PASSWORD });
    const uid = reg.body.user.id;
    await ctx.app.billingService.grant({ userId: uid, amount: 0.001, reason: 'admin_grant', actorId: 'admin-test' });

    const res = await request(ctx.base, '/api/jobs', {
      method: 'POST', jar: reg.jar, body: { manual: { title: 'Thiếu một phần', notes: 'x' } },
    });
    assert.equal(res.status, 402);
    const { error } = await j(res);
    // Job nội dung = SOURCE_EXTRACT 0.0005 + VISION_ANALYSIS 0.003 + TRANSLATION 0.0008 + CONTENT_GENERATE 0.004
    assert.equal(error.details.required, 0.0083, 'số CẦN phải là tổng đơn giá THẬT của bảng pricing');
    assert.equal(error.details.balance, 0.001, 'số CÓ phải là số dư thật');
    assert.equal(error.details.currency, 'USD');
    assert.equal((await ctx.app.billingService.balance(uid)).amount, 0.001, 'ví KHÔNG được trừ khi chưa chạy job');
    assert.equal(await ctx.store.countJobs({ userId: uid }), 0, 'không được tạo job nào');
  });

  test('có credit ⇒ job chạy được và sổ có dòng job_hold gắn đúng jobId', async () => {
    await ctx.app.billingService.grant({ userId, amount: 1, reason: 'admin_grant', actorId: 'admin-test' });
    const res = await request(ctx.base, '/api/jobs', {
      method: 'POST', jar, body: { manual: { title: 'Có credit', notes: 'chạy được' } },
    });
    assert.equal(res.status, 202);
    const { job_id: jobId } = await j(res);
    const rows = await ctx.store.listLedger({ userId, limit: 50 });
    const hold = rows.find((row) => row.reason === 'job_hold' && row.job_id === jobId);
    assert.ok(hold, 'phải có dòng job_hold gắn đúng job');
    assert.ok(hold.amount < 0, 'giữ tiền là dòng âm');
    assert.ok(hold.balance_after >= 0);

    const done = await waitJob(ctx.base, jobId, { jar });
    assert.equal(done.status, 'succeeded');
  });
});

describe('MVP-05 · API — cờ cấu hình AUTH_ENABLED / AUTH_ANONYMOUS_ALLOWED', () => {
  test('AUTH_ENABLED=false ⇒ /api/auth/* 503, nhưng job ẩn danh VẪN chạy', async () => {
    const ctx = await startMvp05App({ configOverrides: { AUTH_ENABLED: 'false' } });
    try {
      for (const [path, method] of [
        ['/api/auth/register', 'POST'],
        ['/api/auth/login', 'POST'],
        ['/api/auth/logout', 'POST'],
      ]) {
        const res = await request(ctx.base, path, { method, body: { email: 'a@b.com', password: PASSWORD } });
        assert.equal(res.status, 503, `${path} phải là 503 khi tắt xác thực`);
        assert.equal((await j(res)).error.code, 'AUTH_DISABLED');
      }
      const meRes = await request(ctx.base, '/api/auth/me');
      assert.equal(meRes.status, 503);
      assert.equal((await j(meRes)).error.code, 'AUTH_DISABLED');

      const config = await j(await request(ctx.base, '/api/config'));
      assert.equal(config.auth.enabled, false);
      assert.equal(config.accounts.available, false);
      assert.ok(config.accounts.reason, 'phải nói rõ VÌ SAO tắt');

      const jobRes = await request(ctx.base, '/api/jobs', {
        method: 'POST', body: { manual: { title: 'Ẩn danh khi tắt auth', notes: 'x' } },
      });
      assert.equal(jobRes.status, 202, 'tắt xác thực KHÔNG được chặn người dùng ẩn danh');
      const { job_id: id } = await j(jobRes);
      const done = await waitJob(ctx.base, id, {});
      assert.equal(done.status, 'succeeded');
    } finally {
      await ctx.close();
    }
  });

  test('AUTH_ANONYMOUS_ALLOWED=false ⇒ job 401, nhưng /api/health + /api/config vẫn 200 và đăng ký được', async () => {
    const ctx = await startMvp05App({ configOverrides: { AUTH_ANONYMOUS_ALLOWED: 'false' } });
    try {
      const job = await request(ctx.base, '/api/jobs', {
        method: 'POST', body: { manual: { title: 'Bị chặn', notes: 'x' } },
      });
      assert.equal(job.status, 401);
      assert.equal((await j(job)).error.code, 'UNAUTHENTICATED');

      const health = await request(ctx.base, '/api/health');
      assert.equal(health.status, 200);
      const config = await request(ctx.base, '/api/config');
      assert.equal(config.status, 200);
      assert.equal((await j(config)).auth.anonymous_allowed, false);

      const jar = newJar();
      const reg = await register(ctx.base, { email: 'bat-buoc@example.com', password: PASSWORD, jar });
      assert.equal(reg.res.status, 201, '/api/auth/* phải được miễn cổng "bắt buộc đăng nhập"');
      const userId = reg.body.user.id;
      await ctx.app.billingService.grant({ userId, amount: 1, reason: 'admin_grant', actorId: 'admin-test' });
      const ok = await request(ctx.base, '/api/jobs', {
        method: 'POST', jar, body: { manual: { title: 'Đã đăng nhập', notes: 'x' } },
      });
      assert.equal(ok.status, 202, 'đã đăng nhập ⇒ chạy được');
      const { job_id: jobId } = await j(ok);
      const hold = (await ctx.store.listLedger({ userId, limit: 50 })).find((row) => row.reason === 'job_hold' && row.job_id === jobId);
      assert.ok(hold, 'job phải được GIỮ TIỀN trước khi chạy (dòng job_hold có thật trong sổ)');
    } finally {
      await ctx.close();
    }
  });
});
