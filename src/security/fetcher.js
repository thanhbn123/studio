/**
 * HTTP fetcher an toàn — dùng cho mọi request ra ngoài Internet.
 *
 * Đặc tính bắt buộc:
 *  - Allowlist domain (mặc định: domain của các sàn).
 *  - Redirect thủ công: TỪNG hop đều phải qua allowlist (chống open-redirect SSRF).
 *  - DNS được phân giải và GHIM trước khi mở socket (chống DNS rebinding).
 *  - Timeout cứng + giới hạn số byte đọc được (chống treo/DoS bộ nhớ).
 *  - Không theo redirect sang scheme khác, không gửi cookie sang host khác.
 */

import http from 'node:http';
import https from 'node:https';
import { Buffer } from 'node:buffer';
import {
  ALL_ALLOWED_DOMAINS,
  UrlGuardError,
  isHostAllowed,
  normalizeHost,
  pinLookup,
  resolvePublicAddresses,
  validateUrlSyntax,
} from './url-guard.js';

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class FetchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.details = details;
  }
}

/** Đọc body có giới hạn byte và timeout. */
function readBody(res, { maxBytes, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(arg);
    };
    const timer = setTimeout(() => {
      res.destroy();
      finish(reject, new FetchError('TIMEOUT', `Đọc dữ liệu quá hạn ${timeoutMs}ms.`));
    }, timeoutMs);

    res.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        res.destroy();
        finish(reject, new FetchError('BODY_TOO_LARGE', `Vượt giới hạn ${maxBytes} byte.`));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => finish(resolve, Buffer.concat(chunks)));
    res.on('error', (err) => finish(reject, new FetchError('NETWORK_ERROR', err.message, { cause: err.code })));
  });
}

/**
 * Thực hiện MỘT request tới URL đã được validate, ghim DNS.
 */
async function requestOnce(urlStr, { method, headers, body, timeoutMs, maxBytes, allowPrivateNetwork }) {
  const url = validateUrlSyntax(urlStr, { allowPrivateNetwork });
  const host = normalizeHost(url.hostname);
  const addresses = await resolvePublicAddresses(host, { allowPrivateNetwork });
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const options = {
    method,
    protocol: url.protocol,
    hostname: host,
    port: url.port || (isHttps ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    headers: { host: url.host, ...headers },
    // Ghim DNS: socket chỉ được nối tới IP đã kiểm.
    lookup: pinLookup(addresses),
    servername: isHttps ? host : undefined,
    timeout: timeoutMs,
    // Không dùng agent toàn cục để tránh tái sử dụng socket sai host.
    agent: false,
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    const req = transport.request(options, (res) => {
      readBody(res, { maxBytes, timeoutMs })
        .then((buffer) =>
          done(resolve, {
            status: res.statusCode,
            headers: res.headers,
            body: buffer,
            finalUrl: url.toString(),
            // `transport: 'http'` là BẰNG CHỨNG rằng dữ liệu này thật sự đi qua mạng.
            // Không có nó thì không được phép gọi kết quả là LIVE_VERIFIED.
            transport: 'http',
          }),
        )
        .catch((err) => done(reject, err));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new FetchError('TIMEOUT', `Hết hạn ${timeoutMs}ms khi gọi ${host}.`));
    });
    req.on('error', (err) => {
      if (err instanceof FetchError) done(reject, err);
      else done(reject, new FetchError('NETWORK_ERROR', err.message, { cause: err.code, host }));
    });

    if (body) req.write(body);
    req.end();
  });
}

/**
 * Fetch an toàn, tự xử lý redirect theo cách thủ công.
 *
 * @param {string} rawUrl
 * @param {object} opts
 * @returns {Promise<{status:number, headers:object, body:Buffer, finalUrl:string, redirects:string[]}>}
 */
export async function safeFetch(rawUrl, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeoutMs = 20000,
    maxBytes = 8 * 1024 * 1024,
    maxRedirects = 5,
    allowPrivateNetwork = false,
    domains = ALL_ALLOWED_DOMAINS,
    // Cookie chỉ được gửi tới host trong danh sách này (không rò sang CDN/host khác).
    cookieHeader = null,
    cookieDomains = [],
  } = opts;

  let current = validateUrlSyntax(rawUrl, { allowPrivateNetwork }).toString();
  const redirects = [];
  const visited = new Set();

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = validateUrlSyntax(current, { allowPrivateNetwork });
    const host = normalizeHost(url.hostname);

    if (!isHostAllowed(host, { domains })) {
      throw new UrlGuardError(
        'DOMAIN_NOT_ALLOWED',
        `Chặn request tới tên miền ngoài allowlist: ${host}`,
        { host, hop },
      );
    }
    if (visited.has(url.toString())) {
      throw new FetchError('REDIRECT_LOOP', `Vòng lặp redirect tại ${url.toString()}`);
    }
    visited.add(url.toString());

    const sendCookie =
      cookieHeader &&
      (cookieDomains.length === 0 || cookieDomains.some((d) => host === d || host.endsWith(`.${d}`)));

    const reqHeaders = {
      'user-agent': headers['user-agent'] || DEFAULT_USER_AGENT,
      accept: headers.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': headers['accept-language'] || 'zh-CN,zh;q=0.9,en;q=0.8',
      'accept-encoding': 'identity',
      ...headers,
    };
    if (sendCookie) reqHeaders.cookie = cookieHeader;

    const res = await requestOnce(url.toString(), {
      method,
      headers: reqHeaders,
      body,
      timeoutMs,
      maxBytes,
      allowPrivateNetwork,
    });

    const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
    if (!isRedirect) {
      return { ...res, redirects };
    }

    const location = res.headers.location;
    if (!location) {
      return { ...res, redirects };
    }
    if (hop === maxRedirects) {
      throw new FetchError('TOO_MANY_REDIRECTS', `Vượt ${maxRedirects} lần redirect.`, { redirects });
    }

    let next;
    try {
      next = new URL(location, url).toString();
    } catch {
      throw new FetchError('BAD_REDIRECT', `Redirect không hợp lệ: ${location}`);
    }
    // Chặn đổi scheme (https → http) để không hạ cấp bảo mật.
    const nextUrl = validateUrlSyntax(next, { allowPrivateNetwork });
    if (url.protocol === 'https:' && nextUrl.protocol !== 'https:') {
      throw new UrlGuardError('DOWNGRADE_REDIRECT', `Redirect hạ cấp giao thức: ${next}`, {
        from: url.toString(),
        to: next,
      });
    }
    redirects.push(next);
    current = next;
  }

  throw new FetchError('TOO_MANY_REDIRECTS', 'Vượt số lần redirect cho phép.');
}

/** Tải tài liệu HTML/text. */
export async function fetchDocument(url, opts = {}) {
  const res = await safeFetch(url, opts);
  return { ...res, text: res.body.toString('utf8') };
}

/** Tải JSON. */
export async function fetchJson(url, opts = {}) {
  const res = await safeFetch(url, opts);
  const text = res.body.toString('utf8');
  let json = null;
  let parseError = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    parseError = err.message;
  }
  return { ...res, text, json, parseError };
}
