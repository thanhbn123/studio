/**
 * Tiện ích HTTP dùng chung cho provider sàn THẬT (shopee / tiktokshop).
 *
 * ⚠️ Hai provider thật trong sprint này **CHƯA TỪNG ĐƯỢC ĐO VỚI API THẬT** (chưa có tài khoản
 * người bán được duyệt — `docs/OWNER-DECISIONS.md` §3). Mã ở đây viết theo tài liệu công khai và
 * được bảo vệ bởi HAI chốt trước khi một byte nào rời máy:
 *   1. `configured === false` (thiếu token/partner id) ⇒ `NOT_CONFIGURED`, không dựng URL.
 *   2. `config.marketplace.liveEnabled !== true` ⇒ `LIVE_DISABLED` — mặc định TẮT, bật bằng tay.
 *
 * Chống SSRF: chỉ cho `https://` và host của sàn (hoặc `allowPrivateNetwork` để trỏ server thử).
 */

import { listingResult } from '../provider.js';
import { maskSecrets } from '../errors.js';

/** Kiểm URL gốc: https + host hợp lệ. Trả `null` nếu hợp lệ, ngược lại là lý do. */
export function baseUrlProblem(baseUrl, { allowedHostSuffixes = [], allowPrivateNetwork = false } = {}) {
  let u;
  try {
    u = new URL(String(baseUrl || ''));
  } catch {
    return 'URL gốc của sàn không hợp lệ.';
  }
  if (allowPrivateNetwork) return null;
  if (u.protocol !== 'https:') return 'URL gốc của sàn phải là https://.';
  const host = u.hostname.toLowerCase();
  if (!allowedHostSuffixes.some((s) => host === s || host.endsWith(`.${s}`))) {
    return `Host "${host}" không thuộc sàn (cho phép: ${allowedHostSuffixes.join(', ')}). Bật MARKETPLACE_ALLOW_PRIVATE_NETWORK chỉ khi trỏ server thử.`;
  }
  return null;
}

/**
 * Gọi JSON có timeout; KHÔNG ném — trả `{ ok, status, json, text, error }` để provider tự dựng
 * `ListingResult` với lỗi NGUYÊN VĂN (đã che bí mật).
 */
export async function fetchJson(fetchImpl, url, { method = 'GET', headers = {}, body = undefined, timeoutMs = 30000, secrets = [] } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Number(timeoutMs) || 30000));
  timer.unref?.();
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text: maskSecrets(text.slice(0, 4000), secrets), error: null };
  } catch (err) {
    const name = err?.name === 'AbortError' ? 'TIMEOUT' : (err?.code || err?.name || 'FETCH_FAILED');
    return { ok: false, status: 0, json: null, text: '', error: { code: String(name), message: maskSecrets(String(err?.message || err), secrets) } };
  } finally {
    clearTimeout(timer);
  }
}

/** Kết quả "chưa bật live" — dùng chung. */
export function liveDisabledResult(provider) {
  return listingResult({
    status: 'failed',
    provider,
    error_code: 'LIVE_DISABLED',
    error_message: `Kênh ${provider} đã có cấu hình nhưng MARKETPLACE_LIVE_ENABLED=false — chưa gọi sàn thật. Đây là chốt an toàn mặc định; bật bằng tay khi đã sẵn sàng.`,
  });
}

/** Kết quả lỗi vận chuyển (mạng/timeout) — giữ nguyên văn lỗi. */
export function transportFailure(provider, res) {
  return listingResult({
    status: 'failed',
    provider,
    error_code: res?.error?.code === 'TIMEOUT' ? 'TIMEOUT' : 'MARKETPLACE_ERROR',
    error_message: res?.error?.message || `HTTP ${res?.status}`,
    raw: { http_status: res?.status ?? 0, body: res?.text ?? '', transport_error: res?.error ?? null },
  });
}
