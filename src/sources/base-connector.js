/**
 * G02 — Kiến trúc connector.
 *
 * `ProductSourceConnector` là lớp cơ sở cho cả 3 sàn. Nó cố ý CHỈ làm việc trích xuất:
 *
 *   can_handle(url)  → connector này có nhận URL không
 *   resolve_url(url) → đi theo redirect (kể cả short link) để tới URL chuẩn
 *   fetch_product(url/session_context) → tải HTML/JSON thô, CÓ session nếu cần
 *   normalize(raw)   → biến dữ liệu thô thành Product Master thống nhất
 *
 * Ba luật thiết kế:
 *  1. Connector KHÔNG chứa logic sinh nội dung (đó là việc của G09).
 *  2. Core AI KHÔNG được biết cấu trúc HTML của sàn — chỉ nhận Product Master.
 *  3. Một connector hỏng KHÔNG được làm hỏng connector khác (xem `registry.js`).
 */

import { createEmptyMaster, recomputeEvidence, addWarning, STATUS } from '../product-master.js';
import { safeFetch, FetchError, DEFAULT_USER_AGENT } from '../security/fetcher.js';
import { UrlGuardError } from '../security/url-guard.js';
import { detectSource, detectHostSource } from './detect.js';

export class ConnectorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.details = details;
  }
}

/** Chuyển lỗi hạ tầng thành trạng thái field đúng nghĩa. */
export function statusForError(err) {
  if (err instanceof UrlGuardError) return STATUS.BLOCKED;
  if (err instanceof FetchError) {
    if (err.code === 'TIMEOUT') return STATUS.BLOCKED;
    return STATUS.BLOCKED;
  }
  return STATUS.BLOCKED;
}

/** Dấu hiệu trang yêu cầu đăng nhập / bị chặn anti-bot. */
const LOGIN_MARKERS = [
  'login.taobao.com',
  'login.tmall.com',
  'passport.',
  '请登录',
  '亲，请登录',
  'login-form',
  'J_LoginBox',
  'havanaId',
  'fm-login',
  '账号登录',
  '扫码登录',
];

const ANTIBOT_MARKERS = [
  'x5secdata',
  '_____tmd_____',
  'punish',
  'captcha',
  'nocaptcha',
  '滑块',
  '验证码',
  'baxia',
  'bx-ua',
  '需要验证',
  '访问受限',
  'security check',
];

/**
 * Soi nội dung trang để phân loại nguyên nhân thất bại.
 * @returns {{login:boolean, antibot:boolean, markers:string[]}}
 */
export function classifyPage(text, { url = '' } = {}) {
  const haystack = `${url}\n${String(text || '').slice(0, 400_000)}`;
  const markers = [];
  let login = false;
  let antibot = false;

  for (const m of LOGIN_MARKERS) {
    if (haystack.includes(m)) {
      login = true;
      markers.push(m);
    }
  }
  for (const m of ANTIBOT_MARKERS) {
    if (haystack.toLowerCase().includes(m.toLowerCase())) {
      antibot = true;
      markers.push(m);
    }
  }
  return { login, antibot, markers: [...new Set(markers)].slice(0, 10) };
}

/** Trích JSON được nhúng trong <script> theo tên biến. */
export function extractInlineJson(html, varNames) {
  for (const name of varNames) {
    // window.NAME = {...};  |  var NAME = {...};
    const re = new RegExp(
      `(?:window\\.|var\\s+|const\\s+|let\\s+)?${name}\\s*=\\s*`,
      'i',
    );
    const m = re.exec(html);
    if (!m) continue;
    const start = html.indexOf('{', m.index + m[0].length);
    if (start === -1) continue;
    const json = readBalancedJson(html, start);
    if (json) return json;
  }
  return null;
}

/**
 * Đọc object JSON cân bằng ngoặc từ vị trí `start`.
 * Tự viết thay vì regex vì JSON lồng nhau thì regex không đáng tin.
 */
export function readBalancedJson(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) {
        const slice = text.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Lấy <title> của trang. */
export function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

/** Chuẩn hoá URL ảnh: bỏ tiền tố `//`, nâng lên https. */
export function normalizeImageUrl(u, base) {
  if (!u || typeof u !== 'string') return '';
  let s = u.trim();
  if (!s) return '';
  if (s.startsWith('//')) s = `https:${s}`;
  else if (s.startsWith('/')) {
    try {
      s = new URL(s, base).toString();
    } catch {
      return '';
    }
  }
  if (!/^https?:\/\//i.test(s)) return '';
  // Bỏ hậu tố thumbnail của CDN Alibaba để lấy ảnh gốc.
  s = s.replace(/_\d+x\d+(?:q\d+)?(?:\.(?:jpg|jpeg|png|webp))?$/i, (m) =>
    m.includes('.') ? m.slice(m.lastIndexOf('.')) : '',
  );
  s = s.replace(/\.(jpg|jpeg|png|webp)_\.webp$/i, '.$1');
  return s;
}

export class ProductSourceConnector {
  /** @type {'taobao'|'1688'|'pinduoduo'} */
  static source = 'base';
  static displayName = 'Base';

  constructor({ config, logger, session, fetcher = safeFetch } = {}) {
    this.config = config;
    this.logger = logger;
    this.session = session;
    this._fetch = fetcher;
    this.source = /** @type {any} */ (this.constructor).source;
    this.displayName = /** @type {any} */ (this.constructor).displayName;
  }

  /**
   * `canHandle` chỉ hỏi "connector này phụ trách TÊN MIỀN này không", KHÔNG hỏi
   * "id có hợp lệ không". Trước đây dùng detectSource() nên một URL đúng sàn nhưng
   * id dị thường khiến MỌI connector từ chối, và registry trả về UNSUPPORTED sai.
   * Id không hợp lệ được báo ở bước extract với thông báo chính xác hơn.
   */
  canHandle(url) {
    try {
      const host = new URL(url).hostname;
      return detectHostSource(host)?.source === this.source;
    } catch {
      return false;
    }
  }

  /** Đi theo redirect để tới URL chuẩn (mặc định: không làm gì). */
  async resolveUrl(url) {
    return { url, redirects: [] };
  }

  /** Tải tài liệu thô. Lớp con override khi cần header/API riêng. */
  async fetchProduct(url, ctx = {}) {
    const cookieHeader = await this.getCookieHeader(url, ctx);
    const res = await this._fetch(url, {
      timeoutMs: this.config?.net?.fetchTimeoutMs ?? 20000,
      maxBytes: this.config?.net?.maxFetchBytes ?? 8 * 1024 * 1024,
      maxRedirects: this.config?.net?.maxRedirects ?? 5,
      allowPrivateNetwork: this.config?.net?.allowPrivateNetwork ?? false,
      headers: this.headers(ctx),
      cookieHeader,
      cookieDomains: this.cookieDomains(),
    });
    return {
      html: res.body.toString('utf8'),
      status: res.status,
      finalUrl: res.finalUrl,
      redirects: res.redirects,
      bytes: res.body.length,
      method: 'http-get',
      // Chỉ `safeFetch` thật mới gắn 'http'. Fetcher giả trong test không gắn,
      // nên tầng kiểm chứng phân biệt được dữ liệu THẬT với dữ liệu fixture.
      transport: res.transport || 'unknown',
    };
  }

  /** Header mặc định gửi ra sàn. */
  headers(ctx = {}) {
    return {
      'user-agent': ctx.userAgent || DEFAULT_USER_AGENT,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      referer: ctx.referer || `${new URL(this.homeUrl()).origin}/`,
    };
  }

  homeUrl() {
    return 'https://example.com';
  }

  /** Domain được phép nhận cookie (mặc định: không gửi cookie đi đâu cả). */
  cookieDomains() {
    return [];
  }

  async getCookieHeader(url, ctx = {}) {
    if (!this.session) return null;
    try {
      return await this.session.cookieHeaderFor(url, {
        domains: this.cookieDomains(),
        source: this.source,
        required: (this.config?.session?.requiredSources ?? []).includes(this.source),
        ...ctx,
      });
    } catch (err) {
      this.logger?.warn('session.cookie_failed', { source: this.source, error: err });
      return null;
    }
  }

  /** @abstract Biến dữ liệu thô thành Product Master. */
  normalize() {
    throw new ConnectorError('NOT_IMPLEMENTED', `${this.displayName}: normalize() chưa được cài đặt.`);
  }

  /**
   * Khuôn mẫu chạy trọn một lần trích xuất: resolve → fetch → normalize → evidence.
   * Không ném lỗi ra ngoài: luôn trả về Product Master với trạng thái đúng sự thật,
   * để pipeline còn chạy tiếp được (đây là nền tảng của G11 manual fallback).
   */
  async extract(url, ctx = {}) {
    const startedAt = new Date().toISOString();
    let detection = null;
    try {
      detection = detectSource(url);
    } catch {
      detection = null;
    }

    const master = createEmptyMaster({
      source: this.source,
      sourceUrl: url,
      canonicalUrl: detection?.canonical_url || url,
      sourceProductId: detection?.source_product_id || '',
    });
    master.extraction.connector = this.displayName;
    master.extraction.extracted_at = startedAt;

    try {
      const resolved = await this.resolveUrl(url, ctx);
      const target = resolved?.url || url;
      if (target !== url) {
        master.canonical_url = target;
        try {
          const redetected = detectSource(target);
          if (redetected?.source === this.source) {
            master.source_product_id = redetected.source_product_id || master.source_product_id;
            master.canonical_url = redetected.canonical_url || target;
          } else if (redetected && redetected.source !== this.source) {
            addWarning(master, `Link chuyển hướng sang nguồn khác: ${redetected.source}.`);
          }
        } catch {
          addWarning(master, 'Sau khi resolve, không nhận diện lại được mã sản phẩm.');
        }
      }

      const raw = await this.fetchProduct(target, ctx);
      master.extraction.http_status = raw.status;
      master.extraction.final_url = raw.finalUrl || target;
      master.extraction.bytes = raw.bytes ?? 0;
      master.extraction.method = raw.method || 'http-get';
      master.extraction.transport = raw.transport || 'unknown';
      if (raw.redirects?.length) master.extraction.redirects = raw.redirects;

      const cls = classifyPage(raw.html, { url: raw.finalUrl || target });
      if (cls.antibot) {
        master.extraction.blocked_reason = `Anti-bot challenge phát hiện: ${cls.markers.slice(0, 3).join(', ')}`;
      }

      this.normalize(raw, master, ctx);
    } catch (err) {
      const st = statusForError(err);
      master.extraction.blocked_reason =
        master.extraction.blocked_reason || `${err.code || err.name}: ${err.message}`;
      // Không có field nào chứng minh được → mọi field ở trạng thái thất bại tương ứng.
      master.title_original_status = st;
      master.description_original_status = st;
      master.price.status = st;
      master.store.status = st;
      master.extraction.error_code = err.code || err.name;
      master.extraction.transport = 'none';
      // Trạng thái field phải NHẤT QUÁN: mọi field đều thất bại cùng một lý do.
      // Trước đây chỉ 4/8 field được đặt, 4 field còn lại rơi về NOT_FOUND —
      // trông như "trang không có field này" trong khi thật ra là bị chặn.
      master.extraction.field_status = {
        ...(master.extraction.field_status || {}),
        images: st,
        videos: st,
        variants: st,
        attributes: st,
        title_original: st,
        description_original: st,
        price: st,
        store: st,
      };
      addWarning(master, `Trích xuất thất bại: ${err.message}`);
      this.logger?.warn('connector.extract_failed', {
        source: this.source,
        code: err.code || err.name,
        error: err,
      });
    }

    return recomputeEvidence(master);
  }

  /** Tiện ích: đánh dấu toàn bộ field là LOGIN_REQUIRED. */
  markLoginRequired(master, reason = 'Trang yêu cầu đăng nhập.') {
    master.extraction.login_required = true;
    master.extraction.blocked_reason = master.extraction.blocked_reason || reason;
    for (const f of ['title_original', 'description_original']) {
      if (!master[f]) master[`${f}_status`] = STATUS.LOGIN_REQUIRED;
    }
    if (!master.price.raw) master.price.status = STATUS.LOGIN_REQUIRED;
    if (!master.store.name) master.store.status = STATUS.LOGIN_REQUIRED;
    // KHÔNG ghi đè trạng thái đã được xác lập rõ ràng trước đó (vd NOT_FOUND cho
    // video khi biết chắc trang không có video). Việc ghi đè ở đây từng làm mất sự
    // thật: PDD SPA shell bị đổi "video NOT_FOUND" thành "video LOGIN_REQUIRED".
    const prev = master.extraction.field_status || {};
    const setIfUnset = (key, value) => {
      if (prev[key] === undefined) prev[key] = value;
    };
    setIfUnset('images', master.images.length ? STATUS.FOUND : STATUS.LOGIN_REQUIRED);
    setIfUnset('videos', master.videos.length ? STATUS.FOUND : STATUS.LOGIN_REQUIRED);
    setIfUnset('variants', master.variants.length ? STATUS.FOUND : STATUS.LOGIN_REQUIRED);
    setIfUnset('attributes', master.attributes.length ? STATUS.FOUND : STATUS.LOGIN_REQUIRED);
    master.extraction.field_status = prev;
    return master;
  }

  /** Tiện ích: đánh dấu field không tồn tại trên trang (khác với bị chặn). */
  markNotFound(master, fields) {
    const map = {
      title_original: 'title_original_status',
      description_original: 'description_original_status',
    };
    for (const f of fields) {
      if (map[f]) master[map[f]] = STATUS.NOT_FOUND;
      else {
        master.extraction.field_status = {
          ...(master.extraction.field_status || {}),
          [f]: STATUS.NOT_FOUND,
        };
      }
    }
    return master;
  }
}

export default ProductSourceConnector;
