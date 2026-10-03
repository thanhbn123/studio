/**
 * HTTP server tối giản — router + phục vụ file tĩnh + header bảo mật.
 * Không dùng framework: repo giữ ít phụ thuộc, và bề mặt tấn công nhỏ hơn.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { URL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.resolve(HERE, '../../public');

export const MAX_BODY_BYTES_DEFAULT = 12 * 1024 * 1024; // 12MB — đủ cho vài ảnh base64

export class HttpError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Router rất nhỏ: hỗ trợ tham số `:name` trong đường dẫn. */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    // Escape ký tự đặc biệt của regex TRƯỚC, rồi mới thay `:param`. Thứ tự này
    // quan trọng: `:` không nằm trong tập cần escape nên vẫn khớp được,
    // còn nếu thay `:param` sau khi escape thì phải tìm `\\:` — sẽ không bao giờ khớp.
    let src = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    src = src.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    });
    src = src.replace(/\\\*/g, '(.*)');
    const regex = new RegExp(`^${src}/?$`);
    this.routes.push({ method: method.toUpperCase(), regex, keys, handler });
    return this;
  }

  get(p, h) {
    return this.add('GET', p, h);
  }

  post(p, h) {
    return this.add('POST', p, h);
  }

  put(p, h) {
    return this.add('PUT', p, h);
  }

  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method.toUpperCase()) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { handler: r.handler, params };
    }
    return null;
  }

  /** Có đường dẫn khớp nhưng khác method? (để trả 405 thay vì 404) */
  hasPath(pathname) {
    return this.routes.some((r) => r.regex.test(pathname));
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Phục vụ file tĩnh có chống path traversal.
 * Trả `true` nếu đã xử lý request.
 */
export async function serveStatic(req, res, pathname, { root = PUBLIC_DIR } = {}) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // Chuẩn hoá rồi xác nhận đường dẫn cuối vẫn nằm trong root.
  const normalized = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const target = path.resolve(root, `.${normalized.startsWith('/') ? '' : '/'}${normalized}`);
  const rootResolved = path.resolve(root);

  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new HttpError(403, 'FORBIDDEN', 'Đường dẫn không hợp lệ.');
  }

  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
  fs.createReadStream(target).pipe(res);
  return true;
}

/** Đọc body có giới hạn byte. */
export function readBody(req, { maxBytes = MAX_BODY_BYTES_DEFAULT } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        fail(new HttpError(413, 'PAYLOAD_TOO_LARGE', `Body vượt giới hạn ${maxBytes} byte.`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => fail(new HttpError(400, 'REQUEST_ERROR', err.message)));
  });
}

export async function readJson(req, opts = {}) {
  const buf = await readBody(req, opts);
  if (buf.length === 0) return {};
  const text = buf.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'BAD_JSON', 'Body không phải JSON hợp lệ.');
  }
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res, err) {
  const status = err?.status || (err?.code === 'RATE_LIMITED' ? 429 : 500);
  // Thông báo lỗi an toàn: không lộ stack, không lộ đường dẫn nội bộ, không lộ secret.
  const isServer = status >= 500;
  const payload = {
    error: {
      code: err?.code || (isServer ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
      message: isServer && !err?.expose
        ? 'Lỗi hệ thống. Vui lòng thử lại.'
        : err?.message || 'Lỗi không xác định.',
      ...(err?.details && status < 500 ? { details: err.details } : {}),
    },
  };
  if (err?.retryAfterMs) payload.error.retry_after_ms = err.retryAfterMs;
  sendJson(res, status, payload);
}

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'geolocation=(), microphone=(), camera=()',
  // Ảnh sản phẩm nằm trên CDN ngoài nên img-src phải cho phép https.
  'content-security-policy': [
    "default-src 'self'",
    "img-src 'self' data: blob: https:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
};

/** Đọc/khởi tạo session id từ cookie. Chỉ dùng để PHÂN VÙNG lịch sử, không phải xác thực. */
export function sessionId(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  let sid = cookies.sid;
  if (!sid || !/^[A-Za-z0-9_-]{16,64}$/.test(sid)) {
    sid = randomUUID().replace(/-/g, '');
    res.setHeader('set-cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  }
  return sid;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Tạo HTTP server với router cho trước.
 * @param {{router:Router, logger:object, onError?:Function, staticRoot?:string}} opts
 */
export function createServer({ router, logger, staticRoot = PUBLIC_DIR } = {}) {
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    let pathname = '/';
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      pathname = url.pathname;
      req.query = url.searchParams;

      const matched = router.match(req.method, pathname);
      if (matched) {
        await matched.handler(req, res, matched.params);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        const served = await serveStatic(req, res, pathname, { root: staticRoot });
        if (!served) {
          if (router.hasPath(pathname)) sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Phương thức không được phép.' } });
          else sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Không tìm thấy.' } });
        }
      } else if (router.hasPath(pathname)) {
        sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Phương thức không được phép.' } });
      } else {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Không tìm thấy.' } });
      }
    } catch (err) {
      logger?.error('http.request_failed', { path: pathname, method: req.method, error: err });
      if (!res.headersSent) sendError(res, err);
      else res.end();
    } finally {
      logger?.debug('http.request', { path: pathname, method: req.method, ms: Date.now() - started, status: res.statusCode });
    }
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  return server;
}

export default createServer;
