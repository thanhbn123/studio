/**
 * Tài khoản & phiên đăng nhập — MVP-05, agent A1 (hợp đồng §3.1, ĐÓNG BĂNG).
 *
 * Phạm vi: băm mật khẩu, chuẩn hoá email, vòng đời người dùng và phiên (token).
 * KHÔNG thuộc file này: route HTTP (A4), bảng/wiring (A3), ví credit (A2), UI (A5).
 *
 * Luật bất di bất dịch:
 *  1. `password_hash` KHÔNG BAO GIỜ ra khỏi module này — mọi lối ra đi qua `toPublicUser`
 *     (whitelist field, không phải blacklist: thêm cột lạ vào DB cũng không rò ra).
 *  2. DB CHỈ lưu `sha256(token)`. Token thô chỉ tồn tại trong giá trị trả về của
 *     `register`/`login` đúng MỘT lần; không log, không lưu, không nhét vào `details`.
 *  3. Sai email và sai mật khẩu trả CÙNG một mã `BAD_CREDENTIALS` — không tiết lộ email
 *     nào đã tồn tại (kể cả qua thời gian phản hồi: nhánh "không có user" vẫn tiêu tốn
 *     một lượt scrypt với hash giả).
 *  4. Tự đăng ký LUÔN là `member`. `role` từ input bị bỏ qua hoàn toàn (chống leo thang
 *     đặc quyền); chỉ `setRole` (route admin) mới đổi được vai trò.
 *  5. Fail-closed: thiếu method store / tham số vô lý ⇒ ném `AccountError` có `code` rõ
 *     ràng. Không đoán, không trả giá trị mặc định "có vẻ đúng".
 *
 * ── HỢP ĐỒNG VỚI STORE (A3 — §3.4). Service gọi ĐÚNG các method sau ──────────────
 *   createUser({ id, email, displayName, role, passwordHash, status }) → user (row ĐẦY ĐỦ)
 *   getUserByEmail(email)                                   → user | null
 *   getUserById(id)                                         → user | null
 *   listUsers({ limit, offset })                            → user[]   (đã cắt trang)
 *   updateUser(id, patch)                                   → user | null (row sau cập nhật)
 *       patch ở đây chỉ là { role } hoặc { status }
 *   touchLastLogin(id, atIso)                               → (bỏ qua kết quả)
 *   createUserSession({ id, userId, tokenHash, createdAt, expiresAt, userAgent })
 *   getUserSessionByTokenHash(tokenHash)                    → session | null
 *       ⚠️ PHẢI trả cả dòng ĐÃ thu hồi / ĐÃ hết hạn (service tự kiểm `revoked_at`,
 *          `expires_at`). Nếu store lọc sẵn thì `logout` lần 2 sẽ trả `false` — sai hợp đồng.
 *   touchUserSession(id, atIso)                             → (bỏ qua kết quả)
 *   revokeUserSession(id, atIso)                            → idempotent: gọi lại vẫn OK
 *   revokeAllUserSessions(userId, atIso)                    → tuỳ chọn (chỉ dùng khi disable)
 *   countUsersByRole(role)                                  → number — TUỲ CHỌN: nếu không có,
 *       service tự đếm owner bằng cách phân trang `listUsers` (xem `#countOwners`).
 * Tên field trong row: snake_case theo §2.1 (display_name, password_hash, created_at,
 * last_login_at, token_hash, user_id, expires_at, last_seen_at, revoked_at). Service đọc
 * khoan dung cả camelCase để không mất dữ liệu nếu store hydrate khác kiểu.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, hashPassword, verifyPassword } from './password.js';

export { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH, SCRYPT_PARAMS, hashPassword, verifyPassword } from './password.js';

/** Vai trò hợp lệ — ĐÓNG BĂNG (A4 dùng cho `/api/config` và kiểm quyền). */
export const ROLES = Object.freeze(['owner', 'admin', 'member']);

/** Trạng thái tài khoản hợp lệ. */
export const USER_STATUSES = Object.freeze(['active', 'disabled']);

/** Hạn phiên mặc định (ngày) — khớp `AUTH_SESSION_DAYS` của §2.3. */
const DEFAULT_SESSION_DAYS = 30;

/** Trần cứng số bản ghi một trang `list()` (giống `store.listJobs`). */
const MAX_LIST_LIMIT = 200;

/** Token: 32 byte ngẫu nhiên → base64url (43 ký tự). Chặn trần để không băm chuỗi rác khổng lồ. */
const TOKEN_RE = /^[A-Za-z0-9_.\-+/=]{8,512}$/;

/** Lỗi nghiệp vụ tài khoản — luôn có `code`, tuỳ chọn `details` (KHÔNG chứa secret). */
export class AccountError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AccountError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const sha256Hex = (value) => createHash('sha256').update(String(value)).digest('hex');

/**
 * Chuẩn hoá email: `trim` + `toLowerCase`, kiểm hình dạng CƠ BẢN; `''` nếu không hợp lệ.
 *
 * Đúng §3.1: có `@`, không khoảng trắng, ≤ 254 ký tự. Thêm đúng hai điều kiện mà chữ
 * "có @" tự nó đã hàm ý: phần trước `@` và phần sau `@` đều KHÔNG rỗng, và chỉ có MỘT `@`.
 * Cố ý KHÔNG đòi dấu chấm ở tên miền và KHÔNG dùng regex RFC 5322: hợp đồng chốt "cơ bản",
 * còn xác thực email thật (gửi thư xác nhận) không thuộc MVP-05. Thêm luật riêng ở đây là
 * tự ý siết hợp đồng đóng băng.
 */
export function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  const value = email.trim().toLowerCase();
  if (!value || value.length > 254) return '';
  if (/\s/.test(value)) return '';
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return '';
  if (at === value.length - 1) return '';
  return value;
}

/**
 * Bản an toàn để trả ra ngoài (API/UI). WHITELIST field theo §2.1 — mọi thứ khác
 * (đặc biệt `password_hash`) bị bỏ, kể cả khi store trả về row thừa cột.
 * `role` thiếu ⇒ `member` (quyền thấp nhất); `status` thiếu ⇒ `null` để tầng gọi
 * fail-closed thay vì mặc định "active".
 */
export function toPublicUser(user) {
  if (!user || typeof user !== 'object') return null;
  const pick = (snake, camel) => user[snake] ?? user[camel] ?? null;
  return {
    id: pick('id', 'id'),
    email: pick('email', 'email'),
    display_name: pick('display_name', 'displayName'),
    role: pick('role', 'role') ?? 'member',
    status: pick('status', 'status'),
    created_at: pick('created_at', 'createdAt'),
    updated_at: pick('updated_at', 'updatedAt'),
    last_login_at: pick('last_login_at', 'lastLoginAt'),
  };
}

/** Tên hiển thị: gộp khoảng trắng, cắt 120 ký tự; rỗng ⇒ `null` (không lưu chuỗi rỗng). */
function cleanDisplayName(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return [...text].slice(0, 120).join('');
}

/** User-Agent: chỉ để đối soát phiên; bỏ ký tự xuống dòng, cắt 300 ký tự. */
function cleanUserAgent(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/[\r\n\t]+/g, ' ').trim();
  return text ? text.slice(0, 300) : null;
}

const toPositiveInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Hash GIẢ để cân bằng thời gian khi email không tồn tại. Tính LƯỜI một lần rồi cache:
 * trả giá một lượt scrypt ở lần đăng nhập sai đầu tiên, không làm chậm lúc `import`.
 */
let dummyHashCache = null;
function dummyPasswordHash() {
  if (!dummyHashCache) dummyHashCache = hashPassword(randomBytes(24).toString('base64url'));
  return dummyHashCache;
}

export class AccountService {
  constructor({ store, logger, config } = {}) {
    if (!store || typeof store !== 'object') {
      throw new AccountError('STORE_UNAVAILABLE', 'AccountService cần một `store` hợp lệ (§3.4).');
    }
    this.store = store;
    this.logger = logger?.child?.({ component: 'accounts' }) ?? logger ?? null;

    const auth = config?.auth && typeof config.auth === 'object' ? config.auth : {};
    // Mặc định AN TOÀN theo §2.3: bật xác thực, phiên 30 ngày, tối thiểu 10 ký tự.
    this.enabled = auth.enabled !== false;
    this.cookieName = typeof auth.cookieName === 'string' && auth.cookieName.trim() ? auth.cookieName.trim() : 'vauth';
    this.sessionDays = Math.min(toPositiveInt(auth.sessionDays, DEFAULT_SESSION_DAYS), 3650);
    // Trần dưới là HẰNG SỐ HỢP ĐỒNG: cấu hình chỉ được SIẾT, không được NỚI.
    this.passwordMinLength = Math.max(PASSWORD_MIN_LENGTH, toPositiveInt(auth.passwordMinLength, PASSWORD_MIN_LENGTH));
    this.secureCookie = auth.secureCookie === true;
    this.anonymousAllowed = auth.anonymousAllowed !== false;
  }

  /* ───────────────────────── Đăng ký / đăng nhập ───────────────────────── */

  /**
   * Tự đăng ký. `role` trong input bị BỎ QUA (luôn `member`).
   * @returns {Promise<{user: object, token: string, expiresAt: string}>} token THÔ — chỉ trả 1 lần.
   */
  async register({ email, password, displayName } = {}) {
    // Kiểm "đang tắt" TRƯỚC khi kiểm store: tắt xác thực thì mọi lối vào đều đóng,
    // kể cả khi wiring store chưa xong.
    if (!this.enabled) throw new AccountError('AUTH_DISABLED', 'Chức năng tài khoản đang tắt (AUTH_ENABLED=false).');
    this.#require('getUserByEmail', 'createUser', 'createUserSession');

    const normalized = normalizeEmail(email);
    if (!normalized) throw new AccountError('BAD_EMAIL', 'Email không hợp lệ.');

    this.#assertPassword(password);

    const existing = await this.store.getUserByEmail(normalized);
    if (existing) throw new AccountError('EMAIL_TAKEN', 'Email này đã được đăng ký.');

    let user;
    try {
      user = await this.store.createUser({
        id: randomUUID(),
        email: normalized,
        displayName: cleanDisplayName(displayName),
        role: 'member', // KHÔNG nhận từ input — chống leo thang đặc quyền.
        passwordHash: hashPassword(password),
        status: 'active',
      });
    } catch (err) {
      // Đua nhau đăng ký cùng email: DB ném vi phạm UNIQUE. Vẫn là EMAIL_TAKEN, không phải 500.
      if (isUniqueViolation(err)) throw new AccountError('EMAIL_TAKEN', 'Email này đã được đăng ký.');
      throw asAccountError(err, 'STORE_ERROR', 'Không tạo được tài khoản.');
    }

    // Store phải trả row ĐẦY ĐỦ (đã hydrate). Thiếu `status` mà vẫn cho qua thì user tạo
    // xong sẽ không bao giờ đăng nhập được (`login` kiểm `status !== 'active'`) — hỏng âm
    // thầm. Thà nổ ngay tại đây với mã rõ ràng.
    if (!user || typeof user !== 'object' || !user.id || !user.email || !user.status) {
      throw new AccountError('STORE_ERROR', 'Store.createUser không trả về bản ghi người dùng đầy đủ (id/email/status).');
    }

    const issued = await this.#issueSession(user);
    this.logger?.info('accounts.registered', { userId: user.id });
    return issued;
  }

  /**
   * Đăng nhập. Sai email/mật khẩu ⇒ CÙNG một `BAD_CREDENTIALS`; tài khoản bị khoá ⇒
   * `ACCOUNT_DISABLED` (chỉ sau khi mật khẩu ĐÚNG, để không lộ email nào tồn tại).
   */
  async login({ email, password, userAgent } = {}) {
    if (!this.enabled) throw new AccountError('AUTH_DISABLED', 'Chức năng tài khoản đang tắt (AUTH_ENABLED=false).');
    this.#require('getUserByEmail', 'createUserSession');

    const normalized = normalizeEmail(email);
    const user = normalized ? await this.store.getUserByEmail(normalized) : null;

    if (!user) {
      // Tiêu tốn đúng một lượt scrypt như nhánh có user ⇒ không lộ email qua thời gian.
      verifyPassword(typeof password === 'string' ? password : '', dummyPasswordHash());
      throw new AccountError('BAD_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');
    }

    const stored = user.password_hash ?? user.passwordHash;
    const ok = typeof password === 'string' && verifyPassword(password, stored);
    if (!ok) throw new AccountError('BAD_CREDENTIALS', 'Email hoặc mật khẩu không đúng.');

    if (user.status !== 'active') {
      throw new AccountError('ACCOUNT_DISABLED', 'Tài khoản đã bị khoá.');
    }

    const nowIso = new Date().toISOString();
    try {
      await this.store.touchLastLogin?.(user.id, nowIso);
    } catch (err) {
      // Ghi nhận "lần đăng nhập cuối" không được phép chặn việc đăng nhập.
      this.logger?.warn('accounts.touch_last_login_failed', { userId: user.id, error: err });
    }

    const issued = await this.#issueSession(user, { userAgent });
    this.logger?.info('accounts.login', { userId: user.id });
    return issued;
  }

  /**
   * PB-03 (vòng 2) — BOOTSTRAP OWNER ĐẦU TIÊN.
   *
   * Vì sao: tự đăng ký luôn là `member`; mọi route `/api/admin/*` đòi `owner|admin`; không có
   * route/CLI/env nào phong owner đầu tiên ⇒ trên cài đặt mới KHÔNG ai cấp được credit ⇒ ví
   * vĩnh viễn 0 ⇒ mọi job 402 (tính năng không dùng được). Đây là đường bootstrap CÓ CHỦ ĐÍCH:
   *
   *   - đã có owner/admin ⇒ KHÔNG làm gì (idempotent, không bao giờ hạ cấp ai);
   *   - `email` được chỉ định và user ĐÃ tồn tại ⇒ nâng lên `owner`;
   *   - chưa tồn tại ⇒ TẠO user owner với mật khẩu NGẪU NHIÊN, trả về đúng MỘT LẦN để tầng gọi
   *     in ra log kèm cảnh báo đổi mật khẩu (mật khẩu KHÔNG được lưu ở đâu khác);
   *   - không có `email` ⇒ trả `{ created: false, reason: 'NO_OWNER_EMAIL' }` để tầng boot ghi
   *     log mức WARN hướng dẫn dùng `npm run make-owner -- <email>`.
   *
   * @returns {Promise<{created:boolean, promoted:boolean, user?:object, password?:string,
   *                    reason?:string, owners?:number}>}
   */
  async bootstrapOwner({ email = '', password = null } = {}) {
    this.#require('getUserByEmail', 'createUser');
    const owners = await this.#countOwners().catch(() => null);
    if (Number.isFinite(owners) && owners > 0) return { created: false, promoted: false, owners };

    const normalized = normalizeEmail(email);
    if (!normalized) return { created: false, promoted: false, owners: Number.isFinite(owners) ? owners : 0, reason: 'NO_OWNER_EMAIL' };

    const existing = await this.store.getUserByEmail(normalized);
    if (existing) {
      if (existing.role === 'owner') return { created: false, promoted: false, user: toPublicUser(existing), owners: 1 };
      const updated = await this.store.updateUser(existing.id, { role: 'owner' });
      const user = updated && typeof updated === 'object' ? updated : { ...existing, role: 'owner' };
      if (!user.status) user.status = existing.status;
      this.logger?.warn('accounts.bootstrap_owner_promoted', { userId: existing.id });
      return { created: false, promoted: true, user: toPublicUser(user), owners: 1 };
    }

    const generated = typeof password === 'string' && password.length >= PASSWORD_MIN_LENGTH
      ? password
      : generateTemporaryPassword();
    let user;
    try {
      user = await this.store.createUser({
        id: randomUUID(),
        email: normalized,
        displayName: 'Owner',
        role: 'owner',
        passwordHash: hashPassword(generated),
        status: 'active',
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AccountError('EMAIL_TAKEN', 'Email này đã được đăng ký.');
      throw asAccountError(err, 'STORE_ERROR', 'Không tạo được tài khoản owner.');
    }
    if (!user || typeof user !== 'object' || !user.id || !user.status) {
      throw new AccountError('STORE_ERROR', 'Store.createUser không trả về bản ghi người dùng đầy đủ (id/email/status).');
    }
    this.logger?.warn('accounts.bootstrap_owner_created', { userId: user.id });
    return { created: true, promoted: false, user: toPublicUser(user), password: generated, owners: 1 };
  }

  /** Thu hồi phiên. Idempotent: gọi lần hai vẫn `true` và KHÔNG ném. */
  async logout(token) {
    this.#require('getUserSessionByTokenHash', 'revokeUserSession');
    const raw = this.#readToken(token);
    if (!raw) return false;

    const session = await this.store.getUserSessionByTokenHash(sha256Hex(raw));
    if (!session || !session.id) return false;
    if (session.revoked_at ?? session.revokedAt) return true; // đã thu hồi rồi ⇒ vẫn là "đã đăng xuất"

    await this.store.revokeUserSession(session.id, new Date().toISOString());
    return true;
  }

  /**
   * Xác thực token thô → user công khai, hoặc `null`.
   * `null` khi: token rỗng/rác, không có phiên, đã thu hồi, đã hết hạn, user không tồn tại
   * hoặc `status !== 'active'`. Không ném vì đây là middleware chạy trên MỌI request.
   */
  async authenticate(token) {
    // Tắt xác thực ⇒ không ai là "đã đăng nhập" (mọi request chạy ở chế độ ẩn danh),
    // và middleware không được ném lỗi trên đường nóng này.
    if (!this.enabled) return null;
    this.#require('getUserSessionByTokenHash', 'getUserById');
    const raw = this.#readToken(token);
    if (!raw) return null;

    const session = await this.store.getUserSessionByTokenHash(sha256Hex(raw));
    if (!session) return null;
    if (session.revoked_at ?? session.revokedAt) return null;

    const expiresAt = Date.parse(session.expires_at ?? session.expiresAt ?? '');
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

    const user = await this.store.getUserById(session.user_id ?? session.userId);
    // Thiếu `status` ⇒ coi như KHÔNG active (fail-closed), không mặc định cho qua.
    if (!user || user.status !== 'active') return null;

    const nowIso = new Date().toISOString();
    try {
      await this.store.touchUserSession?.(session.id, nowIso);
    } catch (err) {
      // "Lần cuối thấy" chỉ là số liệu — lỗi ghi không được làm hỏng xác thực.
      this.logger?.warn('accounts.touch_session_failed', { error: err });
    }
    return toPublicUser(user);
  }

  /* ─────────────────────────── Đọc / quản trị ─────────────────────────── */

  /** Lấy user theo id (KHÔNG lọc `status` — route quyết định; xác thực dùng `authenticate`). */
  async getById(id) {
    this.#require('getUserById');
    if (typeof id !== 'string' || !id.trim()) return null;
    const user = await this.store.getUserById(id.trim());
    return user ? toPublicUser(user) : null;
  }

  /** Danh sách user cho trang quản trị. `limit` luôn bị kẹp trong [1, 200]. */
  async list({ limit = 50, offset = 0 } = {}) {
    this.#require('listUsers');
    const lim = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIST_LIMIT);
    const off = Math.max(Number(offset) || 0, 0);
    const rows = await this.store.listUsers({ limit: lim, offset: off });
    return Array.isArray(rows) ? rows.map(toPublicUser).filter(Boolean) : [];
  }

  /** Đổi vai trò. Không cho hạ cấp owner CUỐI CÙNG (⇒ `LAST_OWNER`). */
  async setRole(id, role) {
    this.#require('getUserById', 'updateUser');
    if (!ROLES.includes(role)) {
      throw new AccountError('BAD_ROLE', `Vai trò không hợp lệ: ${JSON.stringify(String(role))}.`, { roles: [...ROLES] });
    }

    const current = await this.#mustGet(id);
    if (current.role === role) return toPublicUser(current);

    if (current.role === 'owner' && role !== 'owner') {
      const owners = await this.#countOwners();
      if (owners <= 1) {
        throw new AccountError('LAST_OWNER', 'Không thể hạ cấp owner cuối cùng — hệ thống sẽ không còn ai quản trị.');
      }
    }

    const updated = await this.store.updateUser(current.id, { role });
    return this.#mustUpdate(updated);
  }

  /** Đổi trạng thái. Khoá tài khoản ⇒ thu hồi mọi phiên (best-effort, không chặn kết quả). */
  async setStatus(id, status) {
    this.#require('getUserById', 'updateUser');
    if (!USER_STATUSES.includes(status)) {
      throw new AccountError('BAD_STATUS', `Trạng thái không hợp lệ: ${JSON.stringify(String(status))}.`, {
        statuses: [...USER_STATUSES],
      });
    }

    const current = await this.#mustGet(id);
    const updated = await this.store.updateUser(current.id, { status });
    const user = this.#mustUpdate(updated);

    if (status === 'disabled' && typeof this.store.revokeAllUserSessions === 'function') {
      try {
        await this.store.revokeAllUserSessions(current.id, new Date().toISOString());
      } catch (err) {
        // `authenticate` đã kiểm `status` nên phiên cũ vẫn vô hiệu; đây chỉ là dọn thêm.
        this.logger?.warn('accounts.revoke_all_failed', { userId: current.id, error: err });
      }
    }
    return user;
  }

  /* ───────────────────────────── Nội bộ ───────────────────────────── */

  /** Tạo phiên mới + trả token THÔ đúng một lần. Không log token. */
  async #issueSession(user, { userAgent } = {}) {
    const now = new Date();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.sessionDays * 86_400_000).toISOString();

    await this.store.createUserSession({
      id: randomUUID(),
      userId: user.id,
      tokenHash: sha256Hex(token), // DB chỉ thấy sha256 — KHÔNG BAO GIỜ token thô.
      createdAt: now.toISOString(),
      expiresAt,
      userAgent: cleanUserAgent(userAgent),
    });

    return { user: toPublicUser(user), token, expiresAt };
  }

  /** Token thô hợp lệ để tra cứu? Rỗng/rác/quá dài ⇒ `null` (không băm, không truy vấn). */
  #readToken(token) {
    if (typeof token !== 'string') return null;
    const raw = token.trim();
    if (!raw || raw.length > 512 || !TOKEN_RE.test(raw)) return null;
    return raw;
  }

  #assertPassword(password) {
    if (typeof password !== 'string') {
      throw new AccountError('WEAK_PASSWORD', `Mật khẩu phải là chuỗi, tối thiểu ${this.passwordMinLength} ký tự.`, {
        minLength: this.passwordMinLength,
      });
    }
    const length = [...password].length;
    if (length < this.passwordMinLength) {
      throw new AccountError('WEAK_PASSWORD', `Mật khẩu quá ngắn: cần tối thiểu ${this.passwordMinLength} ký tự.`, {
        minLength: this.passwordMinLength,
      });
    }
    if (length > PASSWORD_MAX_LENGTH) {
      throw new AccountError('WEAK_PASSWORD', `Mật khẩu quá dài: tối đa ${PASSWORD_MAX_LENGTH} ký tự.`, {
        maxLength: PASSWORD_MAX_LENGTH,
      });
    }
  }

  async #mustGet(id) {
    if (typeof id !== 'string' || !id.trim()) throw new AccountError('USER_NOT_FOUND', 'Không tìm thấy người dùng.');
    const user = await this.store.getUserById(id.trim());
    if (!user) throw new AccountError('USER_NOT_FOUND', 'Không tìm thấy người dùng.');
    return user;
  }

  #mustUpdate(updated) {
    if (!updated || typeof updated !== 'object') {
      throw new AccountError('STORE_ERROR', 'Store.updateUser không trả về bản ghi sau cập nhật.');
    }
    return toPublicUser(updated);
  }

  /**
   * Đếm số owner. Ưu tiên `countUsersByRole` nếu A3 có; nếu không thì phân trang
   * `listUsers`. Chạm trần phân trang ⇒ ném `OWNER_COUNT_UNAVAILABLE` (fail-closed:
   * thà từ chối hạ cấp còn hơn để hệ thống mất owner cuối cùng).
   */
  async #countOwners() {
    if (typeof this.store.countUsersByRole === 'function') {
      const n = await this.store.countUsersByRole('owner');
      if (Number.isFinite(Number(n))) return Number(n);
      throw new AccountError('OWNER_COUNT_UNAVAILABLE', 'Store.countUsersByRole trả về giá trị không phải số.');
    }
    this.#require('listUsers');

    const pageSize = MAX_LIST_LIMIT;
    const MAX_PAGES = 200; // 200 × 200 = 40.000 user
    let owners = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const rows = await this.store.listUsers({ limit: pageSize, offset: page * pageSize });
      if (!Array.isArray(rows) || rows.length === 0) return owners;
      owners += rows.filter((row) => row?.role === 'owner').length;
      if (rows.length < pageSize) return owners;
    }
    throw new AccountError(
      'OWNER_COUNT_UNAVAILABLE',
      'Không đếm được số owner (vượt trần phân trang) — từ chối hạ cấp để bảo toàn owner cuối cùng.',
    );
  }

  /** Kiểm method store tồn tại TRƯỚC khi gọi — thiếu ⇒ lỗi có mã, không phải `TypeError`. */
  #require(...names) {
    const missing = names.filter((name) => typeof this.store?.[name] !== 'function');
    if (missing.length > 0) {
      throw new AccountError('STORE_UNAVAILABLE', `Store thiếu method bắt buộc: ${missing.join(', ')} (§3.4).`, {
        missing,
      });
    }
  }
}

/**
 * Lỗi DB do vi phạm UNIQUE. Nhận cả 3 dạng gặp trên thực tế:
 *   - SQLite: `SQLITE_CONSTRAINT_UNIQUE`;
 *   - PostgreSQL: `23505`;
 *   - store A3 đã dịch sẵn thành `{ code: 'EMAIL_TAKEN' }` (kèm `cause` là lỗi driver).
 */
/** Mật khẩu TẠM ngẫu nhiên cho owner bootstrap — in một lần, người dùng phải đổi ngay. */
function generateTemporaryPassword(length = 20) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^&*-_';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function isUniqueViolation(err) {
  const code = String(err?.code ?? '');
  if (code === 'EMAIL_TAKEN' || code === '23505' || /SQLITE_CONSTRAINT/i.test(code)) return true;
  const text = `${String(err?.message ?? '')} ${String(err?.cause?.message ?? '')}`;
  return /UNIQUE constraint failed|duplicate key value/i.test(text);
}

/**
 * Bọc lỗi store thành `AccountError` có mã.
 *
 * Cố ý KHÔNG nhét `err.message` của driver vào message: lỗi SQLite/PostgreSQL có thể chứa
 * tham số truy vấn (email, thậm chí `password_hash`), mà message này có thể đi thẳng ra
 * HTTP response. Lỗi gốc vẫn được giữ ở `cause` để tầng log đọc được.
 */
function asAccountError(err, code, message) {
  if (err instanceof AccountError) return err;
  const wrapped = new AccountError(code, message);
  wrapped.cause = err;
  return wrapped;
}

/** Factory theo phong cách các module khác trong repo (config trước, deps sau). */
export function createAccountService(config, { store, logger } = {}) {
  return new AccountService({ store, logger, config });
}

export default createAccountService;
