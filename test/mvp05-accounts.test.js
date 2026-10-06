/**
 * TEST MVP-05 · A1 — Tài khoản, mật khẩu, phiên (`src/accounts/**`, hợp đồng §3.1).
 *
 * Chạy trên STORE THẬT (SQLite in-memory) + `AccountService` THẬT, nên mọi khẳng định
 * về "DB chỉ lưu hash", "token chỉ lưu sha256", "mật khẩu không bao giờ vào DB" đều là
 * khẳng định trên dữ liệu thật, không phải trên lời hứa của tài liệu.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createStore } from '../src/store/index.js';
import {
  AccountService,
  AccountError,
  PASSWORD_MIN_LENGTH,
  createAccountService,
  hashPassword,
  normalizeEmail,
  toPublicUser,
  verifyPassword,
} from '../src/accounts/index.js';
import { SCRYPT_PARAMS } from '../src/accounts/password.js';
import { testConfig, silent, sha256, PASSWORD } from './mvp05-helpers.js';

/** Một service + store mới cho mỗi describe (in-memory nên rẻ và tách biệt hoàn toàn). */
async function makeService(configOverrides = {}) {
  const config = testConfig(configOverrides);
  const store = await createStore(config, silent);
  const svc = createAccountService(config, { store, logger: silent });
  return { config, store, svc };
}

describe('MVP-05 · A1 — băm mật khẩu scrypt (password.js)', () => {
  test('hashPassword: đúng định dạng hợp đồng, verify đúng/sai', () => {
    const stored = hashPassword('mat-khau-that-dai');
    assert.match(stored, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/);
    const [scheme, N, r, p] = stored.split('$');
    assert.equal(scheme, 'scrypt');
    assert.equal(Number(N), SCRYPT_PARAMS.N);
    assert.equal(Number(r), SCRYPT_PARAMS.r);
    assert.equal(Number(p), SCRYPT_PARAMS.p);
    assert.equal(verifyPassword('mat-khau-that-dai', stored), true);
    assert.equal(verifyPassword('mat-khau-that-dai ', stored), false, 'khoảng trắng cuối là ký tự thật');
    assert.equal(verifyPassword('MAT-KHAU-THAT-DAI', stored), false);
    assert.equal(verifyPassword('', stored), false);
  });

  test('cùng một mật khẩu ⇒ salt khác nhau ⇒ hai chuỗi băm KHÁC nhau, cả hai verify được', () => {
    const password = 'cung-mot-mat-khau';
    const a = hashPassword(password);
    const b = hashPassword(password);
    assert.notEqual(a, b, 'salt phải ngẫu nhiên riêng cho mỗi lần băm');
    const saltA = a.split('$')[4];
    const saltB = b.split('$')[4];
    assert.notEqual(saltA, saltB);
    assert.equal(verifyPassword(password, a), true);
    assert.equal(verifyPassword(password, b), true);
  });

  test('verifyPassword KHÔNG BAO GIỜ ném — chuỗi lưu hỏng ⇒ false', () => {
    const valid = hashPassword('mat-khau-hop-le');
    const [scheme, N, r, p, salt, hash] = valid.split('$');
    const broken = [
      undefined, null, 123, {}, [], true, '', '   ', 'x', 'scrypt', 'scrypt$', 'khong-phai-scrypt',
      `bcrypt$14$8$1$${salt}$${hash}`,
      `scrypt$${N}$${r}$${p}$${salt}`, // thiếu phần hash
      `scrypt$${N}$${r}$${p}$${salt}$`,
      `scrypt$${N}$${r}$${p}$khong-phai-base64!$${hash}`,
      `scrypt$2$${r}$${p}$${salt}$${hash}`, // N < 1024
      `scrypt$1000$${r}$${p}$${salt}$${hash}`, // N không phải luỹ thừa của 2
      `scrypt$1073741824$${r}$${p}$${salt}$${hash}`, // N vượt trần tài nguyên
      `scrypt$${N}$64$${p}$${salt}$${hash}`, // r vượt trần
      `scrypt$${N}$${r}$99$${salt}$${hash}`, // p vượt trần
      `scrypt$${N}$${r}$${p}$${salt}$`, // hash rỗng
      `scrypt$${N}$${r}$${p}$${salt}$${hash.slice(0, -2)}`, // base64 KHÔNG chính tắc (mất '==')
      `scrypt$${N}$${r}$${p}$${salt.slice(0, -2)}$${hash}`, // salt không chính tắc
    ];
    for (const stored of broken) {
      assert.equal(verifyPassword('mat-khau-hop-le', stored), false, `phải từ chối: ${String(stored).slice(0, 60)}`);
    }
    // Đầu vào không phải chuỗi cũng không được ném.
    assert.equal(verifyPassword(null, valid), false);
    assert.equal(verifyPassword(undefined, valid), false);
    assert.equal(verifyPassword(123, valid), false);
    assert.equal(verifyPassword({}, valid), false);
  });
});

describe('MVP-05 · A1 — chuẩn hoá email + toPublicUser', () => {
  test('normalizeEmail: trim + lowercase; rác ⇒ chuỗi rỗng', () => {
    assert.equal(normalizeEmail('  MiXeD@Example.COM '), 'mixed@example.com');
    assert.equal(normalizeEmail('a@b'), 'a@b', 'hợp đồng chốt kiểm CƠ BẢN, không đòi dấu chấm ở tên miền');
    for (const bad of ['', '   ', 'no-at', '@b.com', 'a@', 'a b@c.com', 'a@@b.com', 'a@b@c.com', null, undefined, 42, {}]) {
      assert.equal(normalizeEmail(bad), '', `phải là rỗng: ${JSON.stringify(bad)}`);
    }
    assert.equal(normalizeEmail('x'.repeat(250) + '@b.com'), '', 'quá 254 ký tự ⇒ rỗng');
  });

  test('toPublicUser là WHITELIST: không có password_hash, vai trò thiếu ⇒ member', () => {
    const publicUser = toPublicUser({
      id: 'u1',
      email: 'a@b.com',
      display_name: 'A',
      role: 'admin',
      status: 'active',
      password_hash: 'scrypt$...',
      token: 'bi-mat',
      secret: 'bi-mat',
      created_at: 'x',
      updated_at: 'y',
      last_login_at: null,
    });
    assert.deepEqual(Object.keys(publicUser).sort(), [
      'created_at', 'display_name', 'email', 'id', 'last_login_at', 'role', 'status', 'updated_at',
    ]);
    for (const leaked of ['password_hash', 'passwordHash', 'token', 'secret']) {
      assert.equal(leaked in publicUser, false, `toPublicUser không được trả ${leaked}`);
    }
    assert.equal(toPublicUser({ id: 'u2', email: 'b@c.com' }).role, 'member', 'thiếu role ⇒ quyền thấp nhất');
    assert.equal(toPublicUser(null), null);
  });
});

describe('MVP-05 · A1 — đăng ký / đăng nhập trên store thật', () => {
  let ctx;
  before(async () => {
    ctx = await makeService();
  });
  after(async () => {
    await ctx.store.close();
  });

  test('register: token thô trả ĐÚNG MỘT LẦN, user công khai, DB chỉ có hash', async () => {
    const password = 'MatKhau-Rat-DacBiet-9911';
    const out = await ctx.svc.register({ email: '  NguoiDung@Example.COM ', password, displayName: '  Nguyễn   Văn A ' });
    assert.ok(out.token && typeof out.token === 'string');
    assert.match(out.token, /^[A-Za-z0-9_-]{43}$/, 'token = 32 byte ngẫu nhiên → base64url 43 ký tự');
    assert.equal(out.user.email, 'nguoidung@example.com', 'email phải được chuẩn hoá lowercase');
    assert.equal(out.user.display_name, 'Nguyễn Văn A', 'tên hiển thị gộp khoảng trắng');
    assert.equal(out.user.role, 'member');
    assert.equal(out.user.status, 'active');
    assert.equal('password_hash' in out.user, false);
    assert.ok(Date.parse(out.expiresAt) > Date.now(), 'hạn phiên phải ở tương lai');

    const row = await ctx.store.getUserByEmail('nguoidung@example.com');
    assert.notEqual(row.password_hash, password, 'DB KHÔNG được chứa mật khẩu thô');
    assert.match(row.password_hash, /^scrypt\$/);
    assert.equal(verifyPassword(password, row.password_hash), true);
  });

  test('tự đăng ký với role owner/admin ⇒ vẫn member (chống leo thang đặc quyền)', async () => {
    for (const [index, role] of ['owner', 'admin', 'OWNER', 'root'].entries()) {
      const email = `leo-thang-${index}@example.com`;
      const out = await ctx.svc.register({ email, password: PASSWORD, role });
      assert.equal(out.user.role, 'member', `role=${role} từ input phải bị bỏ qua`);
      assert.equal((await ctx.store.getUserByEmail(email)).role, 'member', 'DB cũng phải là member');
    }
  });

  test('mật khẩu KHÔNG BAO GIỜ xuất hiện trong DB (quét toàn bảng users)', async () => {
    const password = 'Quet-DB-Khong-Thay-Toi-123';
    const { user } = await ctx.svc.register({ email: 'quet-db@example.com', password });
    const rows = await ctx.store.driver.all('SELECT * FROM users');
    assert.ok(rows.length >= 2);
    const dump = JSON.stringify(rows);
    assert.equal(dump.includes(password), false, 'dump bảng users không được chứa mật khẩu thô');
    for (const row of rows) {
      assert.match(row.password_hash, /^scrypt\$\d+\$\d+\$\d+\$/, 'mọi dòng phải là hash scrypt có tham số');
      assert.notEqual(row.password_hash, password);
    }
    const me = await ctx.svc.getById(user.id);
    assert.equal('password_hash' in me, false);
    const listed = await ctx.svc.list({ limit: 50 });
    for (const item of listed) assert.equal('password_hash' in item, false, 'list() cũng phải lọc password_hash');
  });

  test('login: đúng ⇒ token mới; sai mật khẩu và email không tồn tại ⇒ CÙNG BAD_CREDENTIALS/CÙNG câu', async () => {
    const email = 'dang-nhap@example.com';
    await ctx.svc.register({ email, password: PASSWORD });
    const ok = await ctx.svc.login({ email: email.toUpperCase(), password: PASSWORD, userAgent: 'test-agent' });
    assert.ok(ok.token);
    assert.equal(ok.user.email, email, 'login cũng chuẩn hoá email');

    const wrong = await ctx.svc.login({ email, password: 'sai-mat-khau-nhung-du-dai' }).catch((err) => err);
    const unknown = await ctx.svc.login({ email: 'khong-ton-tai@example.com', password: 'sai-mat-khau-nhung-du-dai' }).catch((err) => err);
    assert.ok(wrong instanceof AccountError);
    assert.ok(unknown instanceof AccountError);
    assert.equal(wrong.code, 'BAD_CREDENTIALS');
    assert.equal(unknown.code, 'BAD_CREDENTIALS');
    assert.equal(wrong.message, unknown.message, 'hai ca phải trả CÙNG một câu — không lộ email nào tồn tại');
    assert.equal(wrong.message, 'Email hoặc mật khẩu không đúng.');
  });

  test('email trùng ⇒ EMAIL_TAKEN; mật khẩu yếu ⇒ WEAK_PASSWORD; cấu hình chỉ SIẾT được sàn 10', async () => {
    await ctx.svc.register({ email: 'trung@example.com', password: PASSWORD });
    const dup = await ctx.svc.register({ email: 'TRUNG@example.com', password: PASSWORD }).catch((err) => err);
    assert.equal(dup.code, 'EMAIL_TAKEN', 'email trùng sau chuẩn hoá phải bị chặn');

    const short = await ctx.svc.register({ email: 'ngan@example.com', password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1) }).catch((err) => err);
    assert.equal(short.code, 'WEAK_PASSWORD');
    assert.equal(short.details.minLength, PASSWORD_MIN_LENGTH);
    const boundary = await ctx.svc.register({ email: 'vua-du@example.com', password: 'a'.repeat(PASSWORD_MIN_LENGTH) });
    assert.ok(boundary.user.id, 'đúng bằng sàn thì phải đăng ký được');

    const badEmail = await ctx.svc.register({ email: 'khong-phai-email', password: PASSWORD }).catch((err) => err);
    assert.equal(badEmail.code, 'BAD_EMAIL');
  });
});

describe('MVP-05 · A1 — phiên & token: DB chỉ lưu sha256, hết hạn/thu hồi ⇒ null', () => {
  let ctx;
  before(async () => {
    ctx = await makeService();
  });
  after(async () => {
    await ctx.store.close();
  });

  test('DB user_sessions CHỈ lưu sha256(token): token_hash !== token và === sha256(token)', async () => {
    const { token, user } = await ctx.svc.register({ email: 'phien@example.com', password: PASSWORD });
    const byRaw = await ctx.store.getUserSessionByTokenHash(token);
    assert.equal(byRaw, null, 'tra thẳng token thô KHÔNG được ra phiên nào');
    const row = await ctx.store.getUserSessionByTokenHash(sha256(token));
    assert.ok(row, 'phải tra được bằng sha256(token)');
    assert.equal(row.token_hash, sha256(token));
    assert.notEqual(row.token_hash, token);
    assert.equal(row.user_id, user.id);

    const dump = JSON.stringify(await ctx.store.driver.all('SELECT * FROM user_sessions'));
    assert.equal(dump.includes(token), false, 'dump bảng user_sessions không được chứa token thô');

    const authed = await ctx.svc.authenticate(token);
    assert.equal(authed.id, user.id);
    assert.equal('password_hash' in authed, false);
  });

  test('authenticate: token sai/rác/không tồn tại ⇒ null (không ném)', async () => {
    for (const bad of ['khong-co-phien-nay', '', '   ', null, undefined, 123, {}, 'a'.repeat(600)]) {
      assert.equal(await ctx.svc.authenticate(bad), null, `token ${String(bad).slice(0, 20)} ⇒ null`);
    }
  });

  test('authenticate: token HẾT HẠN ⇒ null (mốc thời gian xác định, không sleep)', async () => {
    const { user } = await ctx.svc.register({ email: 'het-han@example.com', password: PASSWORD });
    const token = `het-han-${randomUUID()}`;
    await ctx.store.createUserSession({
      id: randomUUID(),
      userId: user.id,
      tokenHash: sha256(token),
      createdAt: new Date(Date.now() - 7200_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    assert.equal(await ctx.svc.authenticate(token), null);
  });

  test('logout: token cũ vô hiệu, gọi lại vẫn true (idempotent); token rác ⇒ false', async () => {
    const { token } = await ctx.svc.register({ email: 'dang-xuat@example.com', password: PASSWORD });
    assert.ok(await ctx.svc.authenticate(token));
    assert.equal(await ctx.svc.logout(token), true);
    assert.equal(await ctx.svc.authenticate(token), null, 'token đã đăng xuất không dùng lại được');
    assert.equal(await ctx.svc.logout(token), true, 'đăng xuất lần hai vẫn là "đã đăng xuất"');
    assert.equal(await ctx.svc.logout(''), false);
    assert.equal(await ctx.svc.logout(null), false);
    assert.equal(await ctx.svc.logout('khong-ton-tai'), false);
  });

  test('user disabled ⇒ authenticate null và login bị ACCOUNT_DISABLED; phiên bị thu hồi thật', async () => {
    const email = 'bi-khoa@example.com';
    const { token, user } = await ctx.svc.register({ email, password: PASSWORD });
    const updated = await ctx.svc.setStatus(user.id, 'disabled');
    assert.equal(updated.status, 'disabled');
    assert.equal(await ctx.svc.authenticate(token), null, 'tài khoản bị khoá ⇒ token chết');

    const session = await ctx.store.getUserSessionByTokenHash(sha256(token));
    assert.ok(session.revoked_at, 'setStatus(disabled) phải thu hồi mọi phiên');

    const err = await ctx.svc.login({ email, password: PASSWORD }).catch((e) => e);
    assert.equal(err.code, 'ACCOUNT_DISABLED', 'mật khẩu ĐÚNG nhưng tài khoản khoá ⇒ ACCOUNT_DISABLED');

    // Mở lại tài khoản: phiên CŨ vẫn chết (đã thu hồi), phải đăng nhập lại.
    await ctx.svc.setStatus(user.id, 'active');
    assert.equal(await ctx.svc.authenticate(token), null, 'phiên đã thu hồi không hồi sinh');
    const again = await ctx.svc.login({ email, password: PASSWORD });
    assert.ok(await ctx.svc.authenticate(again.token));

    const badStatus = await ctx.svc.setStatus(user.id, 'ngu-qua').catch((e) => e);
    assert.equal(badStatus.code, 'BAD_STATUS');
  });
});

describe('MVP-05 · A1 — quản trị vai trò: không hạ cấp owner CUỐI CÙNG', () => {
  let ctx;
  before(async () => {
    ctx = await makeService();
  });
  after(async () => {
    await ctx.store.close();
  });

  test('setRole: vai trò lạ ⇒ BAD_ROLE; owner cuối cùng ⇒ LAST_OWNER; còn owner khác ⇒ hạ được', async () => {
    const first = await ctx.svc.register({ email: 'owner-1@example.com', password: PASSWORD });
    const second = await ctx.svc.register({ email: 'owner-2@example.com', password: PASSWORD });

    const badRole = await ctx.svc.setRole(first.user.id, 'root').catch((e) => e);
    assert.equal(badRole.code, 'BAD_ROLE');

    await ctx.store.updateUser(first.user.id, { role: 'owner' });
    const lastOwner = await ctx.svc.setRole(first.user.id, 'member').catch((e) => e);
    assert.equal(lastOwner.code, 'LAST_OWNER');
    assert.equal((await ctx.store.getUserById(first.user.id)).role, 'owner', 'hạ cấp thất bại KHÔNG được đổi DB');

    await ctx.store.updateUser(second.user.id, { role: 'owner' });
    const demoted = await ctx.svc.setRole(first.user.id, 'member');
    assert.equal(demoted.role, 'member');
    assert.equal(demoted.id, first.user.id);
    assert.equal('password_hash' in demoted, false);

    const same = await ctx.svc.setRole(second.user.id, 'owner');
    assert.equal(same.role, 'owner', 'đặt lại đúng vai trò hiện tại là no-op hợp lệ');
  });

  test('AccountService fail-closed: thiếu store ⇒ STORE_UNAVAILABLE (không phải TypeError)', async () => {
    assert.throws(() => new AccountService({}), (err) => err.code === 'STORE_UNAVAILABLE');
    const hollow = new AccountService({ store: {}, logger: silent, config: testConfig() });
    const err = await hollow.register({ email: 'a@b.com', password: PASSWORD }).catch((e) => e);
    assert.equal(err.code, 'STORE_UNAVAILABLE');
    assert.ok(Array.isArray(err.details.missing) && err.details.missing.length > 0);
  });

  test('AUTH_ENABLED=false ⇒ register/login/authenticate đều đóng, KHÔNG ném ở authenticate', async () => {
    const off = await makeService({ AUTH_ENABLED: 'false' });
    try {
      assert.equal(off.svc.enabled, false);
      const reg = await off.svc.register({ email: 'a@b.com', password: PASSWORD }).catch((e) => e);
      assert.equal(reg.code, 'AUTH_DISABLED');
      const log = await off.svc.login({ email: 'a@b.com', password: PASSWORD }).catch((e) => e);
      assert.equal(log.code, 'AUTH_DISABLED');
      assert.equal(await off.svc.authenticate('bat-ky-token-nao'), null);
    } finally {
      await off.store.close();
    }
  });

  test('cấu hình mật khẩu chỉ được SIẾT: AUTH_PASSWORD_MIN_LENGTH=12 chặn 11 ký tự', async () => {
    const strict = await makeService({ AUTH_PASSWORD_MIN_LENGTH: '12' });
    try {
      assert.equal(strict.svc.passwordMinLength, 12);
      const short = await strict.svc.register({ email: 'a@b.com', password: 'a'.repeat(11) }).catch((e) => e);
      assert.equal(short.code, 'WEAK_PASSWORD');
      const ok = await strict.svc.register({ email: 'a@b.com', password: 'a'.repeat(12) });
      assert.ok(ok.user.id);
    } finally {
      await strict.store.close();
    }

    const loose = await makeService({ AUTH_PASSWORD_MIN_LENGTH: '4' });
    try {
      assert.equal(loose.svc.passwordMinLength, PASSWORD_MIN_LENGTH, 'cấu hình KHÔNG được nới dưới sàn hợp đồng');
    } finally {
      await loose.store.close();
    }
  });
});
