/**
 * G01 — Nhận diện nguồn từ link người dùng dán.
 *
 * Trách nhiệm duy nhất: từ một URL thô, trả về
 *   { source, canonical_url, source_product_id }
 * hoặc ném lỗi rõ ràng nếu tên miền không được hỗ trợ.
 *
 * KHÔNG tải mạng ở đây. Việc resolve short-link do connector lo (G02/G03/G04/G05),
 * vì nó cần HTTP thật và allowlist.
 */

import { SOURCE_DOMAINS, hostMatchesDomain, normalizeHost, validateUrlSyntax } from '../security/url-guard.js';

export const SOURCES = ['taobao', '1688', 'pinduoduo'];

export class UnsupportedSourceError extends Error {
  constructor(url, host) {
    super(`Tên miền không được hỗ trợ: ${host || '(không xác định)'}`);
    this.name = 'UnsupportedSourceError';
    this.code = 'UNSUPPORTED_SOURCE';
    this.status = 400;
    this.details = { url: String(url).slice(0, 500), host: host || null };
  }
}

export class MissingProductIdError extends Error {
  constructor(source, url) {
    super(`Link ${source} hợp lệ nhưng không tìm thấy mã sản phẩm (product id).`);
    this.name = 'MissingProductIdError';
    this.code = 'MISSING_PRODUCT_ID';
    this.status = 422;
    this.details = { source, url: String(url).slice(0, 500) };
  }
}

/** Host short-link cần resolve trước khi biết product id. */
export const SHORT_LINK_HOSTS = [
  'm.tb.cn',
  'e.tb.cn',
  'tb.cn',
  'qr.1688.com',
  'm.1688.com',
  'p.pinduoduo.com',
  'yangkeduo.com',
  'pinduoduo.com',
];

/** Chuẩn hoá URL để so trùng: bỏ query rác, sắp xếp query, bỏ hash. */
export function canonicalizeUrl(rawUrl) {
  const url = validateUrlSyntax(rawUrl);
  const KEEP = {
    taobao: ['id'],
    '1688': ['offerId'],
    pinduoduo: ['goods_id'],
  };
  const detect = detectHostSource(url.hostname);
  const keep = detect ? KEEP[detect.source] || [] : [];
  const params = new URLSearchParams();
  for (const key of keep) {
    const v = url.searchParams.get(key);
    if (v) params.set(key, v);
  }
  const qs = params.toString();
  return `${url.origin}${url.pathname}${qs ? `?${qs}` : ''}`;
}

/** Đoán nguồn chỉ từ hostname (không cần path/query). */
export function detectHostSource(hostname) {
  const host = normalizeHost(hostname);
  for (const source of SOURCES) {
    if (SOURCE_DOMAINS[source].some((d) => hostMatchesDomain(host, d))) return { source, host };
  }
  return null;
}

export function isShortLinkHost(hostname) {
  const host = normalizeHost(hostname);
  return SHORT_LINK_HOSTS.some((d) => hostMatchesDomain(host, d));
}

/** Tìm product id trong query theo nhiều tên tham số khác nhau của từng sàn. */
function findIdParam(url, names) {
  for (const n of names) {
    const v = url.searchParams.get(n);
    if (v && /^[A-Za-z0-9_-]{3,64}$/.test(v)) return v;
  }
  return null;
}

/**
 * @typedef {{source:'taobao'|'1688'|'pinduoduo', canonical_url:string,
 *   source_product_id:string, host:string, is_short_link:boolean, warnings:string[]}} DetectionResult
 */

/**
 * Nhận diện nguồn + mã sản phẩm từ URL.
 * @param {string} rawUrl
 * @returns {DetectionResult}
 * @throws {UnsupportedSourceError|MissingProductIdError|import('../security/url-guard.js').UrlGuardError}
 */
export function detectSource(rawUrl) {
  const url = validateUrlSyntax(rawUrl);
  const host = normalizeHost(url.hostname);
  const hostSource = detectHostSource(host);

  if (!hostSource) {
    throw new UnsupportedSourceError(rawUrl, host);
  }

  const warnings = [];
  const source = hostSource.source;
  const short = isShortLinkHost(host);

  // ── Taobao ────────────────────────────────────────────────────────────────
  if (source === 'taobao') {
    let id = findIdParam(url, ['id', 'itemId', 'item_id']);
    // Dạng đường dẫn: world.taobao.com/item/<id>.htm — đây là route TRUY CẬP ẨN DANH
    // duy nhất chạy được; `item.taobao.com/item.htm` chặn đăng nhập với MỌI id
    // (đã đo: id thật và id giả đều trả cùng một stub 5044 byte).
    // <id> có thể là số, hoặc chuỗi đã mã hoá (vd MHdiaUR0QXNjVE53U3hDcW84RUpOQT09).
    if (!id) {
      const m = url.pathname.match(/\/item\/([A-Za-z0-9_=.+-]{6,90})\.html?$/i);
      if (m) id = decodeURIComponent(m[1]);
    }
    if (short && !id) {
      return {
        source,
        canonical_url: url.toString(),
        source_product_id: '',
        host,
        is_short_link: true,
        warnings: ['Short link Taobao — cần resolve để lấy product id.'],
      };
    }
    if (!id) throw new MissingProductIdError('taobao', rawUrl);
    const numeric = /^\d{6,20}$/.test(id);
    return {
      source,
      // canonical_url giữ đúng trang sản phẩm gốc của Taobao. Route ẩn danh
      // (world.taobao.com) được connector dùng để TẢI, ghi lại ở `extraction`.
      canonical_url: numeric
        ? `https://item.taobao.com/item.htm?id=${id}`
        : `https://world.taobao.com/item/${id}.htm`,
      source_product_id: id,
      host,
      is_short_link: short,
      warnings:
        numeric && !host.startsWith('world.')
          ? ['item.taobao.com chặn đăng nhập với mọi id — connector sẽ thử route ẩn danh world.taobao.com.']
          : warnings,
    };
  }

  // ── 1688 ──────────────────────────────────────────────────────────────────
  if (source === '1688') {
    // Dạng chuẩn: /offer/<id>.html
    const m = url.pathname.match(/\/offer\/(\d{6,})\.html/);
    let id = m ? m[1] : null;
    if (!id) id = findIdParam(url, ['offerId', 'offer_id', 'id']);
    if (!id && short) {
      return {
        source,
        canonical_url: url.toString(),
        source_product_id: '',
        host,
        is_short_link: true,
        warnings: ['Short link 1688 — cần resolve để lấy offer id.'],
      };
    }
    if (!id) throw new MissingProductIdError('1688', rawUrl);
    return {
      source,
      canonical_url: `https://detail.1688.com/offer/${id}.html`,
      source_product_id: id,
      host,
      is_short_link: short,
      warnings,
    };
  }

  // ── Pinduoduo ─────────────────────────────────────────────────────────────
  const id = findIdParam(url, ['goods_id', 'goodsId', 'gid', 'goodsID']);
  if (id) {
    return {
      source: 'pinduoduo',
      canonical_url: `https://mobile.yangkeduo.com/goods.html?goods_id=${id}`,
      source_product_id: id,
      host,
      is_short_link: false,
      warnings,
    };
  }
  // /duo_xxx.html hoặc short link chia sẻ (p.pinduoduo.com/xxx) — cần resolve.
  const duo = url.pathname.match(/\/duo_[A-Za-z0-9]+/);
  if (duo || short) {
    return {
      source: 'pinduoduo',
      canonical_url: url.toString(),
      source_product_id: '',
      host,
      is_short_link: true,
      warnings: ['Link chia sẻ Pinduoduo — cần resolve để lấy goods_id.'],
    };
  }
  throw new MissingProductIdError('pinduoduo', rawUrl);
}

/** Bọc detectSource, trả `null` thay vì ném lỗi (tiện cho API "kiểm tra link"). */
export function tryDetectSource(rawUrl) {
  try {
    return { ok: true, detection: detectSource(rawUrl) };
  } catch (err) {
    return { ok: false, code: err.code || 'INVALID_URL', message: err.message };
  }
}

export default detectSource;
