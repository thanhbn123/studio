/**
 * Provider `shopee` — Shopee Open Platform v2 (hợp đồng §2).
 *
 * ⚠️ CHƯA ĐO VỚI API THẬT (chưa có tài khoản người bán được duyệt). Viết theo tài liệu công khai
 * `open.shopee.com/developer-guide` (tra 10/10/2026; bảng trường chính thức không mở được trong
 * phiên viết — xem `docs/VERIFICATION.md` §27). Mọi tên trường/cách ký ở đây là **cần xác minh**
 * khi có token; kiến trúc không đổi, chỉ sửa trong file này.
 *
 * Cách ký (theo tài liệu công khai): base = partner_id + path + timestamp + access_token + shop_id;
 * sign = HMAC-SHA256(partner_key, base) dạng hex; truyền `partner_id, timestamp, sign, access_token,
 * shop_id` trên query string.
 *
 * Fail-closed: thiếu một trong bốn giá trị cấu hình ⇒ `configured: false`, mọi lời gọi trả
 * `NOT_CONFIGURED` TRƯỚC khi dựng URL. Có cấu hình mà chưa bật `liveEnabled` ⇒ `LIVE_DISABLED`.
 */

import { createHmac } from 'node:crypto';

import { listingResult, notConfiguredResult } from '../provider.js';
import { baseUrlProblem, fetchJson, liveDisabledResult, transportFailure } from './http.js';

export const SHOPEE_DEFAULT_BASE_URL = 'https://partner.shopeemobile.com';
export const SHOPEE_HOSTS = Object.freeze(['shopeemobile.com', 'shopee.com', 'shopee.vn']);

export const SHOPEE_PATHS = Object.freeze({
  addItem: '/api/v2/product/add_item',
  getItemBaseInfo: '/api/v2/product/get_item_base_info',
  updatePrice: '/api/v2/product/update_price',
  updateStock: '/api/v2/product/update_stock',
});

/** Chữ ký Shopee v2 — tách ra để test được bằng vector cố định. */
export function shopeeSign({ partnerId, partnerKey, path, timestamp, accessToken = '', shopId = '' }) {
  const base = `${partnerId}${path}${timestamp}${accessToken}${shopId}`;
  return createHmac('sha256', String(partnerKey)).update(base).digest('hex');
}

export function createShopeeProvider(config = {}, { logger = null, fetchImpl = undefined } = {}) {
  const cfg = config?.marketplace?.shopee && typeof config.marketplace.shopee === 'object' ? config.marketplace.shopee : {};
  const partnerId = String(cfg.partnerId ?? '').trim();
  const partnerKey = String(cfg.partnerKey ?? '').trim();
  const shopId = String(cfg.shopId ?? '').trim();
  const accessToken = String(cfg.accessToken ?? '').trim();
  const baseUrl = String(cfg.baseUrl || SHOPEE_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = Number(cfg.timeoutMs) || 30000;
  const liveEnabled = config?.marketplace?.liveEnabled === true;
  const allowPrivateNetwork = config?.marketplace?.allowPrivateNetwork === true;
  const configured = Boolean(partnerId && partnerKey && shopId && accessToken);
  const secrets = [partnerKey, accessToken];
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));

  const notice = !configured
    ? 'chưa có token Shopee (cần tài khoản người bán được duyệt trên Shopee Open Platform: partner id, partner key, shop id, access token)'
    : !liveEnabled
      ? 'đã có cấu hình Shopee nhưng MARKETPLACE_LIVE_ENABLED=false — chưa gọi sàn thật'
      : 'Shopee — gọi API THẬT (chưa từng được đo trong sprint này)';

  /** Chốt chung trước mọi lời gọi: cấu hình → live → URL. Trả `ListingResult` lỗi hoặc `null`. */
  const gate = () => {
    if (!configured) return notConfiguredResult('shopee', notice);
    if (!liveEnabled) return liveDisabledResult('shopee');
    const problem = baseUrlProblem(baseUrl, { allowedHostSuffixes: SHOPEE_HOSTS, allowPrivateNetwork });
    if (problem) return listingResult({ status: 'failed', provider: 'shopee', error_code: 'BAD_BASE_URL', error_message: problem });
    return null;
  };

  const signedUrl = (path, extraQuery = {}) => {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = shopeeSign({ partnerId, partnerKey, path, timestamp, accessToken, shopId });
    const q = new URLSearchParams({ partner_id: partnerId, timestamp: String(timestamp), sign, access_token: accessToken, shop_id: shopId, ...extraQuery });
    return `${baseUrl}${path}?${q.toString()}`;
  };

  /** Shopee trả `{ error: '', message: '', response: {...} }`; `error` khác rỗng = lỗi nghiệp vụ. */
  const parse = (res, pickId) => {
    if (res.error || !res.ok) return transportFailure('shopee', res);
    const body = res.json || {};
    if (body.error) {
      return listingResult({
        status: 'failed',
        provider: 'shopee',
        error_code: 'MARKETPLACE_ERROR',
        error_message: `Shopee: ${body.error} — ${body.message || ''}`.trim(),
        raw: { http_status: res.status, body: res.text },
      });
    }
    const id = pickId(body.response || {});
    return listingResult({
      status: 'published',
      provider: 'shopee',
      external_id: id ?? null,
      url: id ? `https://shopee.vn/product/${shopId}/${id}` : null,
      raw: { http_status: res.status, response: body.response ?? null },
    });
  };

  return {
    name: 'shopee',
    configured,
    isMock: false,
    notice,
    capabilities: { createListing: true, updatePrice: true, updateStock: true, readListing: true },

    async probe() {
      const blocked = gate();
      if (blocked) return { ok: false, name: 'shopee', configured, is_mock: false, error_code: blocked.error_code, detail: blocked.error_message };
      return { ok: true, name: 'shopee', configured: true, is_mock: false, detail: 'cấu hình đủ và live đã bật — chưa đo API thật' };
    },

    async createListing(payload) {
      const blocked = gate();
      if (blocked) return blocked;
      // Bỏ các trường nội bộ (tiền tố `_vps_`) trước khi gửi: chúng chỉ để người dùng soi ở chế độ thử.
      const body = Object.fromEntries(Object.entries(payload || {}).filter(([k]) => !k.startsWith('_vps_')));
      logger?.info?.('marketplace.shopee.add_item', { item_name_length: String(body.item_name || '').length });
      const res = await fetchJson(doFetch, signedUrl(SHOPEE_PATHS.addItem), { method: 'POST', body, timeoutMs, secrets });
      return parse(res, (r) => r.item_id);
    },

    async updatePrice(externalId, price) {
      const blocked = gate();
      if (blocked) return blocked;
      const body = { item_id: Number(externalId), price_list: [{ model_id: 0, original_price: Number(price) }] };
      const res = await fetchJson(doFetch, signedUrl(SHOPEE_PATHS.updatePrice), { method: 'POST', body, timeoutMs, secrets });
      return parse(res, () => externalId);
    },

    async updateStock(externalId, qty) {
      const blocked = gate();
      if (blocked) return blocked;
      const body = { item_id: Number(externalId), stock_list: [{ model_id: 0, seller_stock: [{ stock: Number(qty) }] }] };
      const res = await fetchJson(doFetch, signedUrl(SHOPEE_PATHS.updateStock), { method: 'POST', body, timeoutMs, secrets });
      return parse(res, () => externalId);
    },

    async readListing(externalId) {
      const blocked = gate();
      if (blocked) return blocked;
      const res = await fetchJson(doFetch, signedUrl(SHOPEE_PATHS.getItemBaseInfo, { item_id_list: String(externalId) }), { method: 'GET', timeoutMs, secrets });
      if (res.error || !res.ok) return transportFailure('shopee', res);
      const body = res.json || {};
      if (body.error) {
        return listingResult({ status: 'failed', provider: 'shopee', error_code: 'MARKETPLACE_ERROR', error_message: `Shopee: ${body.error} — ${body.message || ''}`.trim(), raw: { http_status: res.status, body: res.text } });
      }
      const item = Array.isArray(body.response?.item_list) ? body.response.item_list[0] : null;
      return listingResult({
        status: 'published',
        provider: 'shopee',
        external_id: externalId,
        raw: {
          http_status: res.status,
          // Giá/tồn là DỮ LIỆU CỦA SÀN — chỉ đọc để đối chiếu (luật #2), không suy diễn khi thiếu.
          price: item?.price_info?.[0]?.original_price ?? null,
          stock: item?.stock_info_v2?.summary_info?.total_available_stock ?? null,
          item_status: item?.item_status ?? null,
          item: item ?? null,
        },
      });
    },
  };
}

export default createShopeeProvider;
