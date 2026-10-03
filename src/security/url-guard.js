/**
 * SSRF guard — bảo vệ chống Server-Side Request Forgery.
 *
 * Ba lớp phòng thủ (phải đủ cả ba, thiếu một là hở):
 *  1. Allowlist theo registrable domain (chỉ sàn được hỗ trợ + host hạ tầng của sàn).
 *  2. Validate scheme / port / credentials / hình dạng host.
 *  3. Phân giải DNS rồi CHỈ kết nối tới IP đã kiểm là công khai (chống DNS rebinding).
 *
 * Điểm quan trọng: lớp 3 phải được "ghim" (pin) vào socket thật, không chỉ kiểm
 * rồi gọi fetch bình thường — nếu không, kẻ tấn công đổi bản ghi DNS giữa hai bước.
 */

import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

/** Domain gốc được phép, gắn với từng nguồn. */
export const SOURCE_DOMAINS = {
  taobao: [
    'taobao.com',
    'tmall.com',
    'tb.cn',
    'taobao.net',
    'alibaba.com',
  ],
  '1688': ['1688.com', 'alibaba.com', 'alibaba.cn', 'alibabacorp.com'],
  pinduoduo: ['pinduoduo.com', 'yangkeduo.com', 'pddpic.com', 'pinduoduo.net'],
};

/** Host hạ tầng được phép cho việc tải ảnh (CDN của sàn). */
export const ASSET_DOMAINS = [
  'alicdn.com',
  'taobaocdn.com',
  'tbcdn.cn',
  '1688.com',
  'alibaba.com',
  'pddpic.com',
  'yangkeduo.com',
  'pinduoduo.com',
];

export const ALL_ALLOWED_DOMAINS = [
  ...new Set([...Object.values(SOURCE_DOMAINS).flat(), ...ASSET_DOMAINS]),
];

export class UrlGuardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'UrlGuardError';
    this.code = code;
    this.details = details;
  }
}

/** Chuẩn hoá host: bỏ dấu chấm cuối, lowercase, bỏ IPv6 bracket. */
export function normalizeHost(hostname) {
  let h = String(hostname || '').trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/** host có thuộc `domain` (bằng hoặc subdomain) hay không. */
export function hostMatchesDomain(host, domain) {
  const h = normalizeHost(host);
  const d = normalizeHost(domain);
  return h === d || h.endsWith(`.${d}`);
}

export function isHostAllowed(hostname, { domains = ALL_ALLOWED_DOMAINS } = {}) {
  return domains.some((d) => hostMatchesDomain(hostname, d));
}

/* ────────────────────────── IPv4 / IPv6 ────────────────────────── */

const IPV4_BLOCKS = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — gồm metadata cloud 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmark
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
  ['255.255.255.255', 32],
];

function ipv4ToInt(ip) {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inIpv4Block(ipInt, base, bits) {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1) >>> 0);
  return (ipInt & mask) === (baseInt & mask);
}

/** IPv4 có phải địa chỉ riêng/không định tuyến công khai? */
export function isPrivateIPv4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true; // không parse được => coi là nguy hiểm
  return IPV4_BLOCKS.some(([base, bits]) => inIpv4Block(n, base, bits));
}

/** Mở rộng IPv6 thành 8 nhóm 16-bit. Trả null nếu không hợp lệ. */
export function expandIPv6(ip) {
  let s = String(ip).trim().toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone); // bỏ zone id
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  if (!s.includes(':')) return null;

  // IPv4-mapped / IPv4-embedded ở cuối (vd ::ffff:127.0.0.1)
  let embeddedV4 = null;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (isIP(tail) !== 4) return null;
    embeddedV4 = tail;
    const oct = tail.split('.').map((x) => Number.parseInt(x, 10));
    const hex1 = ((oct[0] << 8) | oct[1]).toString(16);
    const hex2 = ((oct[2] << 8) | oct[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hex1}:${hex2}`;
  }

  const dbl = s.indexOf('::');
  let head;
  let tailParts;
  if (dbl !== -1) {
    if (s.indexOf('::', dbl + 1) !== -1) return null; // chỉ một '::'
    head = s.slice(0, dbl).split(':').filter((x) => x !== '');
    tailParts = s.slice(dbl + 2).split(':').filter((x) => x !== '');
    const missing = 8 - head.length - tailParts.length;
    if (missing < 0) return null;
    const groups = [...head, ...Array(missing).fill('0'), ...tailParts];
    if (groups.length !== 8) return null;
    return { groups, embeddedV4 };
  }

  const groups = s.split(':');
  if (groups.length !== 8) return null;
  return { groups, embeddedV4 };
}

export function isPrivateIPv6(ip) {
  const parsed = expandIPv6(ip);
  if (!parsed) return true; // không parse được => nguy hiểm
  const { groups, embeddedV4 } = parsed;
  const g = groups.map((x) => Number.parseInt(x || '0', 16));
  if (g.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return true;

  // IPv4-mapped ::ffff:a.b.c.d  → kiểm chính IPv4 nhúng
  const isV4Mapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
  if (isV4Mapped && embeddedV4) return isPrivateIPv4(embeddedV4);

  // ::  và  ::1
  const allZero = g.every((x) => x === 0);
  if (allZero) return true;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // loopback

  // IPv4-compatible (đã bị deprecate): ::a.b.c.d hoặc dạng viết liền ::7f00:1.
  // Chỉ xử lý `::ffff:` là KHÔNG đủ — verifier tìm ra `::127.0.0.1` và
  // `0:0:0:0:0:0:7f00:1` đều lọt qua hàm này.
  const first6Zero = g.slice(0, 6).every((x) => x === 0);
  if (first6Zero && !allZero && !(g[7] === 1)) {
    const v4 = `${(g[6] >> 8) & 0xff}.${g[6] & 0xff}.${(g[7] >> 8) & 0xff}.${g[7] & 0xff}`;
    if (isPrivateIPv4(v4)) return true;
  }

  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 doc
  if (g[0] === 0x0064 && g[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64
  if (g[0] === 0x2002) return true; // 6to4 — có thể nhúng IPv4 riêng

  return false;
}

/** Địa chỉ IP (v4 hoặc v6) có phải nội bộ/không công khai? */
export function isPrivateAddress(ip) {
  const v = isIP(String(ip));
  if (v === 4) return isPrivateIPv4(String(ip));
  if (v === 6) return isPrivateIPv6(String(ip));
  return true; // không phải IP hợp lệ => từ chối
}

/* ────────────────────────── URL validation ────────────────────────── */

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

/**
 * Kiểm cú pháp URL (chưa đụng tới mạng).
 *
 * `allowPrivateNetwork` mặc định FALSE (fail-closed). Chỉ được bật cho test cục bộ
 * có kiểm soát — khi bật thì bỏ qua các chốt chặn host/IP nội bộ. Trước đây tuỳ chọn
 * này bị bỏ qua ở tầng cú pháp nên `ALLOW_PRIVATE_NETWORK=true` không có tác dụng.
 * @throws {UrlGuardError}
 */
export function validateUrlSyntax(rawUrl, { allowPrivateNetwork = false } = {}) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new UrlGuardError('EMPTY_URL', 'URL rỗng.');
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length > 2048) {
    throw new UrlGuardError('URL_TOO_LONG', 'URL quá dài (tối đa 2048 ký tự).');
  }
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new UrlGuardError('MALFORMED_URL', 'URL không hợp lệ.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlGuardError('BAD_SCHEME', `Giao thức không được phép: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new UrlGuardError('CREDENTIALS_IN_URL', 'URL chứa thông tin đăng nhập — bị từ chối.');
  }
  // Danh sách cổng cho phép là một lớp chặn SSRF (không cho quét cổng nội bộ).
  // Khi allowPrivateNetwork được bật rõ ràng cho test cục bộ thì bỏ lớp này, vì
  // server test luôn chạy trên cổng ngẫu nhiên.
  if (!allowPrivateNetwork && !ALLOWED_PORTS.has(url.port)) {
    throw new UrlGuardError('BAD_PORT', `Cổng không được phép: ${url.port}`);
  }
  const host = normalizeHost(url.hostname);
  if (!host) throw new UrlGuardError('EMPTY_HOST', 'URL thiếu host.');
  if (allowPrivateNetwork) return url;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new UrlGuardError('BLOCKED_HOST', `Host nội bộ bị chặn: ${host}`);
  }
  if (isIP(host) && isPrivateAddress(host)) {
    throw new UrlGuardError('PRIVATE_IP', `Địa chỉ IP nội bộ bị chặn: ${host}`);
  }
  return url;
}

/**
 * Kiểm URL có nằm trong allowlist domain hay không.
 * @throws {UrlGuardError}
 */
export function validateUrlAllowed(rawUrl, { domains = ALL_ALLOWED_DOMAINS, allowPrivateNetwork = false } = {}) {
  const url = validateUrlSyntax(rawUrl, { allowPrivateNetwork });
  const host = normalizeHost(url.hostname);
  if (!isHostAllowed(host, { domains })) {
    throw new UrlGuardError('DOMAIN_NOT_ALLOWED', `Tên miền không nằm trong allowlist: ${host}`, {
      host,
    });
  }
  return url;
}

/**
 * Phân giải DNS và trả về danh sách IP công khai.
 * Nếu MỘT BẢN GHI là nội bộ => từ chối toàn bộ (chống split-horizon DNS).
 * @returns {Promise<string[]>}
 */
export async function resolvePublicAddresses(hostname, { allowPrivateNetwork = false, resolver = dnsLookup } = {}) {
  const host = normalizeHost(hostname);
  if (isIP(host)) {
    if (!allowPrivateNetwork && isPrivateAddress(host)) {
      throw new UrlGuardError('PRIVATE_IP', `IP nội bộ bị chặn: ${host}`);
    }
    return [host];
  }

  let records;
  try {
    records = await resolver(host, { all: true, verbatim: true });
  } catch (err) {
    throw new UrlGuardError('DNS_FAILED', `Không phân giải được tên miền: ${host}`, {
      cause: err?.code || err?.message,
    });
  }
  const list = Array.isArray(records) ? records : [records];
  const addresses = list.map((r) => r?.address).filter(Boolean);
  if (addresses.length === 0) {
    throw new UrlGuardError('DNS_EMPTY', `Tên miền không có bản ghi địa chỉ: ${host}`);
  }
  if (!allowPrivateNetwork) {
    const bad = addresses.filter((a) => isPrivateAddress(a));
    if (bad.length > 0) {
      throw new UrlGuardError('PRIVATE_IP', `Tên miền trỏ tới IP nội bộ: ${host} → ${bad.join(', ')}`, {
        host,
        addresses: bad,
      });
    }
  }
  return addresses;
}

/**
 * Ghim DNS: trả về hàm `lookup` chỉ trả đúng IP đã kiểm.
 * Đây là lớp chống DNS rebinding — socket không bao giờ tự phân giải lại.
 */
export function pinLookup(addresses) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const wantAll = typeof options === 'object' && options && options.all;
    const family = typeof options === 'object' && options ? options.family : undefined;
    const pool = addresses
      .map((address) => ({ address, family: isIP(address) }))
      .filter((a) => a.family !== 0)
      .filter((a) => (family ? a.family === Number(family) : true));
    const chosen = pool.length > 0 ? pool : addresses.map((address) => ({ address, family: isIP(address) }));
    if (chosen.length === 0) {
      const err = new Error(`Không có địa chỉ hợp lệ để ghim cho ${hostname}`);
      err.code = 'ENOTFOUND';
      cb(err);
      return;
    }
    if (wantAll) cb(null, chosen);
    else cb(null, chosen[0].address, chosen[0].family);
  };
}
