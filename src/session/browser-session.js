/**
 * G05 — Session cho sàn cần đăng nhập.
 *
 * Ba chế độ, khai qua `SESSION_MODE`:
 *   none  → chỉ truy cập ẩn danh; gặp tường đăng nhập thì báo LOGIN_REQUIRED.
 *   file  → đọc cookie từ file NGOÀI git (SESSION_COOKIE_FILE).
 *   cdp   → nối vào Chrome thật qua Chrome DevTools Protocol, dùng profile đang
 *           đăng nhập. Đây là chế độ mạnh nhất: vừa lấy được cookie, vừa render
 *           được trang bằng JS thật (cần cho Pinduoduo).
 *
 * LUẬT BẢO MẬT (bắt buộc, không thoả hiệp):
 *   - KHÔNG BAO GIỜ ghi cookie/token vào log, vào DB, hay vào Product Master.
 *   - KHÔNG export cookie vào repo. File cookie phải nằm trong .gitignore.
 *   - Chỉ gửi cookie tới đúng domain của sàn, không gửi sang CDN/domain khác.
 */

import fs from 'node:fs';
import path from 'node:path';

export class SessionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
    this.details = details;
  }
}

/* ───────────────────────── Cookie parsing ───────────────────────── */

/**
 * Parse file cookie. Hỗ trợ 3 định dạng phổ biến:
 *  1. JSON array:  [{name,value,domain,path}]
 *  2. JSON object: {cookies:[...]}  (định dạng extension "EditThisCookie"/CDP)
 *  3. Netscape:    domain \t flag \t path \t secure \t expiry \t name \t value
 * @returns {{name:string,value:string,domain:string,path:string}[]}
 */
export function parseCookieFile(content) {
  const text = String(content ?? '').trim();
  if (!text) return [];

  if (text.startsWith('[') || text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new SessionError('COOKIE_PARSE_FAILED', `File cookie JSON không hợp lệ: ${err.message}`);
    }
    const arr = Array.isArray(parsed) ? parsed : parsed.cookies;
    if (!Array.isArray(arr)) {
      throw new SessionError('COOKIE_PARSE_FAILED', 'File cookie JSON thiếu mảng `cookies`.');
    }
    return arr
      .filter((c) => c && c.name)
      .map((c) => ({
        name: String(c.name),
        value: String(c.value ?? ''),
        domain: String(c.domain || ''),
        path: String(c.path || '/'),
      }));
  }

  // Netscape cookies.txt
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;
    out.push({
      name: parts[5],
      value: parts[6],
      domain: parts[0],
      path: parts[2] || '/',
    });
  }
  return out;
}

/** Cookie có áp dụng cho host này không (khớp domain kiểu cookie chuẩn). */
export function cookieAppliesToHost(cookieDomain, host) {
  const cd = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  const h = String(host || '').toLowerCase();
  if (!cd) return false;
  return h === cd || h.endsWith(`.${cd}`);
}

/** Ghép danh sách cookie thành header `Cookie:` cho một URL. */
export function buildCookieHeader(cookies, url, { domains = [] } = {}) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (domains.length > 0) {
    const ok = domains.some((d) => {
      const dd = String(d).replace(/^\./, '').toLowerCase();
      return host === dd || host.endsWith(`.${dd}`);
    });
    if (!ok) return null;
  }
  const applicable = cookies.filter((c) => cookieAppliesToHost(c.domain, host));
  if (applicable.length === 0) return null;
  return applicable.map((c) => `${c.name}=${c.value}`).join('; ');
}

/* ───────────────────────── Providers ───────────────────────── */

export class SessionProvider {
  constructor({ config, logger } = {}) {
    this.config = config;
    this.logger = logger;
    this.mode = 'none';
  }

  /** Trả header Cookie cho URL, hoặc null. KHÔNG log giá trị. */
  // eslint-disable-next-line no-unused-vars
  async cookieHeaderFor(url, opts = {}) {
    return null;
  }

  /** Render trang bằng trình duyệt thật (chỉ CDP mới làm được). */
  // eslint-disable-next-line no-unused-vars
  async renderPage(url, opts = {}) {
    return null;
  }

  get capabilities() {
    return { cookies: false, render: false };
  }

  async status() {
    return { mode: this.mode, available: false, capabilities: this.capabilities };
  }
}

export class NoSessionProvider extends SessionProvider {
  constructor(opts) {
    super(opts);
    this.mode = 'none';
  }
}

export class FileCookieProvider extends SessionProvider {
  constructor({ config, logger, file } = {}) {
    super({ config, logger });
    this.mode = 'file';
    this.file = file || config?.session?.cookieFile || './.session/cookies.json';
    this.cookies = null;
    this.loadedAt = 0;
  }

  load() {
    if (!fs.existsSync(this.file)) {
      throw new SessionError('COOKIE_FILE_MISSING', `Không thấy file cookie: ${this.file}`);
    }
    const content = fs.readFileSync(this.file, 'utf8');
    this.cookies = parseCookieFile(content);
    this.loadedAt = Date.now();
    // Chỉ log SỐ LƯỢNG, tuyệt đối không log nội dung.
    this.logger?.info('session.cookie_file_loaded', { count: this.cookies.length, file: this.file });
    return this.cookies;
  }

  getCookies() {
    if (!this.cookies || Date.now() - this.loadedAt > 60_000) this.load();
    return this.cookies;
  }

  async cookieHeaderFor(url, { domains = [] } = {}) {
    return buildCookieHeader(this.getCookies(), url, { domains });
  }

  get capabilities() {
    return { cookies: true, render: false };
  }

  async status() {
    try {
      const n = this.getCookies().length;
      return { mode: this.mode, available: n > 0, cookies: n, capabilities: this.capabilities };
    } catch (err) {
      return { mode: this.mode, available: false, error: err.message, capabilities: this.capabilities };
    }
  }
}

/**
 * Client CDP tối giản — chỉ dùng WebSocket có sẵn trong Node (>=22).
 * Không cần thư viện puppeteer/playwright.
 */
export class CdpClient {
  constructor({ endpoint, logger, timeoutMs = 15000 } = {}) {
    this.endpoint = String(endpoint || 'http://127.0.0.1:9222').replace(/\/+$/, '');
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    if (this.ws && this.ws.readyState === 1) return this;
    const res = await fetch(`${this.endpoint}/json/version`, {
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((err) => {
      throw new SessionError('CDP_UNREACHABLE', `Không nối được Chrome DevTools tại ${this.endpoint}: ${err.message}`);
    });
    if (!res.ok) {
      throw new SessionError('CDP_UNREACHABLE', `Chrome DevTools trả về HTTP ${res.status}`);
    }
    const info = await res.json();
    const wsUrl = info.webSocketDebuggerUrl;
    if (!wsUrl) throw new SessionError('CDP_NO_WS', 'Chrome DevTools không trả về webSocketDebuggerUrl.');

    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SessionError('CDP_TIMEOUT', 'Hết hạn kết nối WebSocket CDP.')), this.timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', (ev) => {
        clearTimeout(timer);
        reject(new SessionError('CDP_WS_ERROR', `Lỗi WebSocket CDP: ${ev?.message || 'unknown'}`));
      });
    });

    ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    return this;
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch {
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new SessionError('CDP_CALL_FAILED', `${entry.method}: ${msg.error.message}`));
    else entry.resolve(msg.result);
  }

  send(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.ws || this.ws.readyState !== 1) {
      return Promise.reject(new SessionError('CDP_NOT_CONNECTED', 'CDP chưa kết nối.'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SessionError('CDP_CALL_TIMEOUT', `${method} quá hạn ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* bỏ qua */
    }
    this.ws = null;
  }
}

/**
 * Provider dùng Chrome thật qua CDP.
 *
 * Hai khả năng:
 *  - cookieHeaderFor(): lấy cookie đang đăng nhập từ profile Chrome.
 *  - renderPage(): mở trang bằng JS thật rồi trả HTML sau khi render — cần cho
 *    Pinduoduo vì dữ liệu sản phẩm chỉ xuất hiện sau khi JS chạy.
 */
export class CdpSessionProvider extends SessionProvider {
  constructor({ config, logger, cdp } = {}) {
    super({ config, logger });
    this.mode = 'cdp';
    this.cdp = cdp || new CdpClient({ endpoint: config?.session?.cdpEndpoint, logger });
    this._lastStatus = null;
  }

  async cookieHeaderFor(url, { domains = [] } = {}) {
    await this.cdp.connect();
    const result = await this.cdp.send('Storage.getCookies', {});
    const all = (result?.cookies || []).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
    }));
    return buildCookieHeader(all, url, { domains });
  }

  /**
   * Mở URL trong tab mới của Chrome đang chạy, đợi mạng ổn định, trả HTML.
   * Dùng cho Pinduoduo và các trang render phía client.
   */
  async renderPage(url, { waitMs = 3500, timeoutMs = 30000 } = {}) {
    await this.cdp.connect();
    const target = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
    const targetId = target.targetId;
    try {
      const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const send = (method, params) =>
        this.cdp.send(method, params, { timeoutMs }).then((r) => r);

      // Gửi lệnh gắn sessionId vào message: cần gửi trực tiếp qua ws.
      const sendSession = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const id = this.cdp.nextId++;
          const timer = setTimeout(() => {
            this.cdp.pending.delete(id);
            reject(new SessionError('CDP_CALL_TIMEOUT', `${method} quá hạn`));
          }, timeoutMs);
          this.cdp.pending.set(id, { resolve, reject, timer, method });
          this.cdp.ws.send(JSON.stringify({ id, method, params, sessionId }));
        });

      await sendSession('Page.enable');
      await sendSession('Runtime.enable');
      await sendSession('Page.navigate', { url });
      await new Promise((r) => setTimeout(r, waitMs));
      const html = await sendSession('Runtime.evaluate', {
        expression: 'document.documentElement.outerHTML',
        returnByValue: true,
      });
      const finalUrl = await sendSession('Runtime.evaluate', {
        expression: 'window.location.href',
        returnByValue: true,
      });
      return {
        html: html?.result?.value || '',
        finalUrl: finalUrl?.result?.value || url,
        method: 'cdp-render',
      };
    } finally {
      await this.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }

  get capabilities() {
    return { cookies: true, render: true };
  }

  async status() {
    try {
      await this.cdp.connect();
      const version = await fetch(`${this.cdp.endpoint}/json/version`, {
        signal: AbortSignal.timeout(5000),
      }).then((r) => r.json());
      this._lastStatus = {
        mode: this.mode,
        available: true,
        browser: version.Browser,
        capabilities: this.capabilities,
      };
    } catch (err) {
      this._lastStatus = {
        mode: this.mode,
        available: false,
        error: err.message,
        capabilities: this.capabilities,
      };
    }
    return this._lastStatus;
  }
}

/** Tạo provider theo cấu hình. Không bao giờ ném lỗi vì session là tuỳ chọn. */
export async function createSessionProvider(config, logger) {
  const mode = String(config?.session?.mode || 'none').toLowerCase();
  try {
    if (mode === 'file') return new FileCookieProvider({ config, logger });
    if (mode === 'cdp') return new CdpSessionProvider({ config, logger });
    return new NoSessionProvider({ config, logger });
  } catch (err) {
    logger?.warn('session.provider_init_failed', { mode, error: err });
    return new NoSessionProvider({ config, logger });
  }
}

export default createSessionProvider;
