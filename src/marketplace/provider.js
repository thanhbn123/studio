/**
 * MVP-08 — INTERFACE PROVIDER SÀN (ĐÓNG BĂNG, `docs/MVP-08-CONTRACT.md` §2).
 *
 * Mọi provider phải có:
 *   { name, configured, isMock, capabilities: { createListing, updatePrice, updateStock, readListing },
 *     notice, async probe(), async createListing(payload), async updatePrice(externalId, price),
 *     async updateStock(externalId, qty), async readListing(externalId) }
 *
 * Kết quả của MỌI lời gọi là một `ListingResult` cùng hình dạng (xem `listingResult()`):
 *   status: 'published' | 'dry_run' | 'failed' — không có "thành công một phần".
 *   external_id / url: `null` khi không có bài thật (KHÔNG bịa link).
 *   error_code: mã chuẩn hoá của mình; `raw`: lỗi/dữ liệu NGUYÊN VĂN của sàn (đã che bí mật).
 */

export const MARKETPLACE_CHANNELS = Object.freeze(['dry-run', 'shopee', 'tiktokshop']);

export const DEFAULT_CHANNEL = 'dry-run';

export const LISTING_RESULT_STATUSES = Object.freeze(['published', 'dry_run', 'failed']);

export function isMarketplaceChannel(name) {
  return MARKETPLACE_CHANNELS.includes(String(name ?? ''));
}

/** Dựng `ListingResult` đúng hợp đồng — một nguồn duy nhất cho mọi provider. */
export function listingResult({
  status,
  provider = 'none',
  external_id = null,
  url = null,
  error_code = null,
  error_message = '',
  raw = null,
  is_mock = false,
} = {}) {
  const st = LISTING_RESULT_STATUSES.includes(status) ? status : 'failed';
  return {
    status: st,
    provider: String(provider || 'none'),
    external_id: st === 'failed' ? null : (external_id === null || external_id === undefined ? null : String(external_id)),
    url: st === 'failed' || !url ? null : String(url),
    error_code: st === 'failed' ? String(error_code || 'MARKETPLACE_ERROR') : null,
    error_message: st === 'failed' ? String(error_message || '') : '',
    raw: raw ?? null,
    is_mock: Boolean(is_mock),
  };
}

/** Kết quả "chưa cấu hình" — dùng chung cho shopee/tiktokshop (fail-closed, KHÔNG gọi mạng). */
export function notConfiguredResult(provider, reason) {
  return listingResult({
    status: 'failed',
    provider,
    error_code: 'NOT_CONFIGURED',
    error_message: reason || `Kênh ${provider} chưa cấu hình (thiếu token/partner id) — không gọi sàn.`,
  });
}

/** Kiểm hình dạng provider lúc đăng ký — provider sai hình dạng bị cô lập, không làm hỏng registry. */
export function assertProviderShape(p) {
  const need = ['probe', 'createListing', 'updatePrice', 'updateStock', 'readListing'];
  if (!p || typeof p !== 'object') throw new Error('provider không phải object');
  if (!p.name) throw new Error('provider thiếu `name`');
  for (const fn of need) {
    if (typeof p[fn] !== 'function') throw new Error(`provider "${p.name}" thiếu hàm \`${fn}\``);
  }
  if (!p.capabilities || typeof p.capabilities !== 'object') throw new Error(`provider "${p.name}" thiếu \`capabilities\``);
  return p;
}

/** Thông tin provider cho `/api/config` + `GET /api/marketplace/channels` — CHỈ cờ, KHÔNG bí mật. */
export function providerInfo(p) {
  return {
    name: String(p?.name || 'none'),
    configured: Boolean(p?.configured),
    is_mock: Boolean(p?.isMock),
    capabilities: {
      createListing: Boolean(p?.capabilities?.createListing),
      updatePrice: Boolean(p?.capabilities?.updatePrice),
      updateStock: Boolean(p?.capabilities?.updateStock),
      readListing: Boolean(p?.capabilities?.readListing),
    },
    notice: String(p?.notice || ''),
    error: p?.error ? { code: String(p.error.code || 'PROVIDER_BROKEN'), message: String(p.error.message || '') } : null,
  };
}

export default listingResult;
