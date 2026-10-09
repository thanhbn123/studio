/**
 * Provider `tiktokshop` — TikTok Shop Open Platform, API phiên bản `202309` (hợp đồng §2).
 *
 * ⚠️ CHƯA ĐO VỚI API THẬT (chưa có tài khoản người bán + app Partner Center được duyệt). Viết theo
 * tài liệu công khai `partner.tiktokshop.com/docv2` (tra 10/10/2026; trang tài liệu chính thức
 * không mở được trong phiên viết — xem `docs/VERIFICATION.md` §29). Tên trường, cách ký và đường
 * dẫn là **cần xác minh** khi có token; kiến trúc không đổi, chỉ sửa trong file này.
 *
 * Cách ký (theo tài liệu công khai): lấy mọi tham số query TRỪ `sign` và `access_token`, sắp theo
 * khoá, nối `key+value`; chuỗi = path + chuỗi tham số (+ body JSON nếu có); bọc `app_secret` hai
 * đầu; sign = HMAC-SHA256(app_secret, chuỗi) hex. Token đi trong header `x-tts-access-token`.
 */

import { createHmac } from 'node:crypto';

import { listingResult, notConfiguredResult } from '../provider.js';
import { baseUrlProblem, fetchJson, liveDisabledResult, transportFailure } from './http.js';

export const TIKTOK_DEFAULT_BASE_URL = 'https://open-api.tiktokglobalshop.com';
export const TIKTOK_HOSTS = Object.freeze(['tiktokglobalshop.com', 'tiktokshop.com']);
export const TIKTOK_API_VERSION = '202309';

export const TIKTOK_PATHS = Object.freeze({
  createProduct: `/product/${TIKTOK_API_VERSION}/products`,
  getProduct: (id) => `/product/${TIKTOK_API_VERSION}/products/${encodeURIComponent(id)}`,
  updatePrice: (id) => `/product/${TIKTOK_API_VERSION}/products/${encodeURIComponent(id)}/prices/update`,
  updateInventory: (id) => `/product/${TIKTOK_API_VERSION}/products/${encodeURIComponent(id)}/inventory/update`,
});

/** Chữ ký TikTok Shop — tách ra để test bằng vector cố định. `query` KHÔNG chứa sign/access_token. */
export function tiktokSign({ appSecret, path, query = {}, body = undefined }) {
  const keys = Object.keys(query).filter((k) => k !== 'sign' && k !== 'access_token').sort();
  const params = keys.map((k) => `${k}${query[k]}`).join('');
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const base = `${appSecret}${path}${params}${bodyText}${appSecret}`;
  return createHmac('sha256', String(appSecret)).update(base).digest('hex');
}

export function createTiktokShopProvider(config = {}, { logger = null, fetchImpl = undefined } = {}) {
  const cfg = config?.marketplace?.tiktokshop && typeof config.marketplace.tiktokshop === 'object' ? config.marketplace.tiktokshop : {};
  const appKey = String(cfg.appKey ?? '').trim();
  const appSecret = String(cfg.appSecret ?? '').trim();
  const shopCipher = String(cfg.shopCipher ?? '').trim();
  const accessToken = String(cfg.accessToken ?? '').trim();
  const baseUrl = String(cfg.baseUrl || TIKTOK_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = Number(cfg.timeoutMs) || 30000;
  const liveEnabled = config?.marketplace?.liveEnabled === true;
  const allowPrivateNetwork = config?.marketplace?.allowPrivateNetwork === true;
  const configured = Boolean(appKey && appSecret && shopCipher && accessToken);
  const secrets = [appSecret, accessToken];
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));

  const notice = !configured
    ? 'chưa có token TikTok Shop (cần tài khoản người bán được duyệt + app Partner Center: app key, app secret, shop cipher, access token)'
    : !liveEnabled
      ? 'đã có cấu hình TikTok Shop nhưng MARKETPLACE_LIVE_ENABLED=false — chưa gọi sàn thật'
      : 'TikTok Shop — gọi API THẬT (chưa từng được đo trong sprint này)';

  const gate = () => {
    if (!configured) return notConfiguredResult('tiktokshop', notice);
    if (!liveEnabled) return liveDisabledResult('tiktokshop');
    const problem = baseUrlProblem(baseUrl, { allowedHostSuffixes: TIKTOK_HOSTS, allowPrivateNetwork });
    if (problem) return listingResult({ status: 'failed', provider: 'tiktokshop', error_code: 'BAD_BASE_URL', error_message: problem });
    return null;
  };

  const call = async (path, { method, body }) => {
    const query = { app_key: appKey, timestamp: String(Math.floor(Date.now() / 1000)), shop_cipher: shopCipher };
    const sign = tiktokSign({ appSecret, path, query, body });
    const q = new URLSearchParams({ ...query, sign });
    return fetchJson(doFetch, `${baseUrl}${path}?${q.toString()}`, {
      method,
      body,
      headers: { 'x-tts-access-token': accessToken },
      timeoutMs,
      secrets,
    });
  };

  /** TikTok trả `{ code: 0, message: 'Success', data: {...} }`; `code !== 0` = lỗi nghiệp vụ. */
  const parse = (res, pickId, extraRaw = () => ({})) => {
    if (res.error || !res.ok) return transportFailure('tiktokshop', res);
    const body = res.json || {};
    if (Number(body.code) !== 0) {
      return listingResult({
        status: 'failed',
        provider: 'tiktokshop',
        error_code: 'MARKETPLACE_ERROR',
        error_message: `TikTok Shop: code ${body.code ?? '?'} — ${body.message || ''}`.trim(),
        raw: { http_status: res.status, body: res.text },
      });
    }
    const id = pickId(body.data || {});
    return listingResult({
      status: 'published',
      provider: 'tiktokshop',
      external_id: id ?? null,
      // TikTok không trả link công khai cố định trong phản hồi tạo sản phẩm ⇒ KHÔNG bịa URL.
      url: null,
      raw: { http_status: res.status, data: body.data ?? null, ...extraRaw(body.data || {}) },
    });
  };

  return {
    name: 'tiktokshop',
    configured,
    isMock: false,
    notice,
    capabilities: { createListing: true, updatePrice: true, updateStock: true, readListing: true },

    async probe() {
      const blocked = gate();
      if (blocked) return { ok: false, name: 'tiktokshop', configured, is_mock: false, error_code: blocked.error_code, detail: blocked.error_message };
      return { ok: true, name: 'tiktokshop', configured: true, is_mock: false, detail: 'cấu hình đủ và live đã bật — chưa đo API thật' };
    },

    async createListing(payload) {
      const blocked = gate();
      if (blocked) return blocked;
      const body = Object.fromEntries(Object.entries(payload || {}).filter(([k]) => !k.startsWith('_vps_')));
      logger?.info?.('marketplace.tiktokshop.create_product', { title_length: String(body.title || '').length });
      const res = await call(TIKTOK_PATHS.createProduct, { method: 'POST', body });
      return parse(res, (d) => d.product_id);
    },

    async updatePrice(externalId, price) {
      const blocked = gate();
      if (blocked) return blocked;
      const body = { skus: [{ price: { amount: String(price), currency: 'VND' } }] };
      const res = await call(TIKTOK_PATHS.updatePrice(externalId), { method: 'POST', body });
      return parse(res, () => externalId);
    },

    async updateStock(externalId, qty) {
      const blocked = gate();
      if (blocked) return blocked;
      const body = { skus: [{ inventory: [{ quantity: Number(qty) }] }] };
      const res = await call(TIKTOK_PATHS.updateInventory(externalId), { method: 'POST', body });
      return parse(res, () => externalId);
    },

    async readListing(externalId) {
      const blocked = gate();
      if (blocked) return blocked;
      const res = await call(TIKTOK_PATHS.getProduct(externalId), { method: 'GET' });
      return parse(res, () => externalId, (d) => ({
        // Giá/tồn là DỮ LIỆU CỦA SÀN (luật #2) — thiếu thì để null, không suy diễn.
        price: d?.skus?.[0]?.price?.sale_price ?? d?.skus?.[0]?.price?.amount ?? null,
        stock: d?.skus?.[0]?.inventory?.[0]?.quantity ?? null,
        product_status: d?.status ?? null,
      }));
    },
  };
}

export default createTiktokShopProvider;
