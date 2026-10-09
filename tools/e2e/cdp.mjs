/**
 * Khách CDP tối giản — KHÔNG thêm dependency nào.
 *
 * Vì sao tự viết: luật repo cấm thêm `dependencies` (chỉ có `pg`) và yêu cầu hỏi
 * trước khi thêm `devDependencies`. Node 24+ đã có `WebSocket` toàn cục và máy có
 * Google Chrome thật, nên điều khiển trình duyệt THẬT qua Chrome DevTools Protocol
 * không cần Playwright/Puppeteer.
 *
 * Trình duyệt dùng: /Applications/Google Chrome.app (ghi đè bằng CHROME_PATH).
 * Mặc định chạy có cửa sổ thật; đặt E2E_HEADLESS=1 để dùng `--headless=new`
 * (vẫn là cùng một engine Chrome, cùng DOM, cùng mạng — không phải jsdom).
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chờ `fn()` trả giá trị thật (không null/false) trong `timeoutMs`, nếu không thì ném lỗi. */
export async function waitFor(label, fn, { timeoutMs = 20000, everyMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timeout (${timeoutMs}ms): ${label} — lần cuối: ${JSON.stringify(last)}`);
    }
    await sleep(everyMs);
  }
}

export function chromePath() {
  const p = process.env.CHROME_PATH || DEFAULT_CHROME;
  if (!existsSync(p)) throw new Error(`Không thấy Chrome tại ${p} — đặt CHROME_PATH=<đường dẫn>`);
  return p;
}

/** Bật Chrome thật với cổng debug; trả về { proc, wsUrl, version, userDataDir }. */
export async function launchChrome({ port = 0, downloadDir } = {}) {
  const bin = chromePath();
  const userDataDir = mkdtempSync(join(tmpdir(), 'vps-e2e-chrome-'));
  const args = [
    `--remote-debugging-port=${port || 9444}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1440,1000',
    'about:blank',
  ];
  if (process.env.E2E_HEADLESS === '1') args.unshift('--headless=new');
  if (downloadDir) mkdirSync(downloadDir, { recursive: true });

  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += String(d);
  });

  const base = `http://127.0.0.1:${port || 9444}`;
  const version = await waitFor(
    'Chrome mở cổng DevTools',
    async () => {
      if (proc.exitCode !== null) throw new Error(`Chrome chết sớm (exit ${proc.exitCode}): ${stderr.slice(-400)}`);
      const res = await fetch(`${base}/json/version`);
      return res.ok ? res.json() : null;
    },
    { timeoutMs: 25000, everyMs: 300 },
  );
  return { proc, base, version, userDataDir, chromeBinary: bin };
}

/** Kết nối tới browser endpoint; mở page mới và trả về đối tượng Page. */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => this.#onMessage(String(ev.data)));
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`Không kết nối được WebSocket CDP: ${wsUrl}`)), {
        once: true,
      });
    });
    return new Cdp(ws);
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const key = msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method;
      for (const k of [key, msg.method]) {
        for (const fn of this.handlers.get(k) || []) fn(msg.params || {}, msg.sessionId);
      }
    }
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  send(method, params = {}, sessionId) {
    this.id += 1;
    const id = this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP hết thời gian chờ: ${method}`));
        }
      }, 60000);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Một tab thật, kèm thu gom log console/ngoại lệ/lỗi mạng.
 * `errors` chỉ chứa lỗi THẬT: console.error, exception chưa bắt, request thất bại,
 * phản hồi HTTP >= 400 (trừ những mã mà UI chủ ý kiểm tra, xem `ignoreHttp`).
 */
export class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.console = [];
    this.errors = [];
    this.network = [];
    this.downloads = [];
  }

  static async open(cdp, { downloadDir } = {}) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(cdp, sessionId);
    page.targetId = targetId;

    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Log.enable');
    await page.send('Network.enable');
    await page.send('DOM.enable');

    cdp.on(`${sessionId}:Runtime.consoleAPICalled`, (p) => {
      const text = (p.args || [])
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
        .join(' ');
      const rec = { kind: 'console', level: p.type, text };
      page.console.push(rec);
      if (p.type === 'error') page.errors.push(rec);
    });
    cdp.on(`${sessionId}:Runtime.exceptionThrown`, (p) => {
      const d = p.exceptionDetails || {};
      const text = d.exception?.description || d.text || 'ngoại lệ không rõ';
      const rec = { kind: 'exception', level: 'error', text };
      page.console.push(rec);
      page.errors.push(rec);
    });
    cdp.on(`${sessionId}:Log.entryAdded`, (p) => {
      const e = p.entry || {};
      const rec = { kind: `log.${e.source}`, level: e.level, text: `${e.text} ${e.url || ''}`.trim() };
      page.console.push(rec);
      if (e.level === 'error') page.errors.push(rec);
    });
    cdp.on(`${sessionId}:Network.loadingFailed`, (p) => {
      if (p.type === 'Document' || p.type === 'Script' || p.type === 'Stylesheet' || p.type === 'XHR' || p.type === 'Fetch') {
        const rec = { kind: 'network', level: 'error', text: `loadingFailed ${p.type}: ${p.errorText}` };
        page.console.push(rec);
        page.errors.push(rec);
      }
    });
    cdp.on(`${sessionId}:Network.responseReceived`, (p) => {
      const r = p.response || {};
      page.network.push({ url: r.url, status: r.status, type: p.type });
    });

    if (downloadDir) {
      mkdirSync(downloadDir, { recursive: true });
      await page.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: downloadDir,
        eventsEnabled: true,
      });
      cdp.on(`${sessionId}:Page.downloadWillBegin`, (p) => {
        page.downloads.push({ guid: p.guid, url: p.url, suggested: p.suggestedFilename, state: 'begin' });
      });
      cdp.on(`${sessionId}:Page.downloadProgress`, (p) => {
        const d = page.downloads.find((x) => x.guid === p.guid);
        if (d) d.state = p.state;
      });
    }
    return page;
  }

  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }

  /** Lỗi console THẬT, đã bỏ các mã HTTP mà UI chủ ý thử (ví dụ 402/404 khi kiểm tra). */
  realErrors({ ignore = [] } = {}) {
    return this.errors.filter((e) => !ignore.some((re) => re.test(e.text)));
  }

  async goto(url, { waitMs = 1200 } = {}) {
    const loaded = new Promise((resolve) => {
      const once = () => resolve();
      this.cdp.on(`${this.sessionId}:Page.loadEventFired`, once);
      setTimeout(resolve, 20000);
    });
    await this.send('Page.navigate', { url });
    await loaded;
    await sleep(waitMs);
  }

  /** Chạy JS trong trang, trả giá trị JSON. Ném lỗi nếu JS ném. */
  async eval(expr, { awaitPromise = true } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expr} })()`,
      returnByValue: true,
      awaitPromise,
    });
    if (res.exceptionDetails) {
      throw new Error(
        `eval lỗi: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`,
      );
    }
    return res.result?.value;
  }

  /** Toạ độ tâm của phần tử (CSS selector), hoặc null nếu không thấy / không hiện. */
  box(selector) {
    return this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    `);
  }

  /** CHUỘT THẬT: gửi mousePressed/mouseReleased qua Input — không phải el.click(). */
  async click(selector, { timeoutMs = 10000 } = {}) {
    const b = await waitFor(`phần tử hiện ra để bấm: ${selector}`, () => this.box(selector), { timeoutMs });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1, buttons: 0,
    });
    return b;
  }

  /** BÀN PHÍM THẬT: focus rồi gõ từng ký tự qua Input.insertText. */
  async type(selector, text) {
    await this.eval(`document.querySelector(${JSON.stringify(selector)}).focus();`);
    await this.send('Input.insertText', { text: String(text) });
    await this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    `);
  }

  async setSelect(selector, value) {
    return this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value === ${JSON.stringify(String(value))};
    `);
  }

  /** Chọn tệp vào <input type=file> — đi qua đường FileList thật của Chrome. */
  async setFiles(selector, files) {
    const { root } = await this.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`không thấy input file: ${selector}`);
    await this.send('DOM.setFileInputFiles', { files, nodeId });
  }

  /** KÉO-THẢ THẬT: Input.dispatchDragEvent mang theo tệp, đúng đường dataTransfer.files. */
  async dropFiles(selector, files) {
    const b = await waitFor(`vùng thả hiện ra: ${selector}`, () => this.box(selector));
    const dragData = {
      items: files.map(() => ({ mimeType: 'application/octet-stream', data: '' })),
      files,
      dragOperationsMask: 1,
    };
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await this.send('Input.dispatchDragEvent', { type, x: b.x, y: b.y, data: dragData });
      await sleep(120);
    }
  }

  async text(selector = 'body') {
    return this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? el.innerText : '';
    `);
  }

  /** Cuộn phần tử vào giữa màn hình — để ẢNH CHỤP thật sự nhìn thấy bằng chứng. */
  async scrollTo(selector) {
    await this.eval(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.scrollIntoView({ block: 'center' });
      return Boolean(el);
    `);
    await sleep(350);
  }

  async screenshot(file) {
    mkdirSync(join(file, '..'), { recursive: true });
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }
}
