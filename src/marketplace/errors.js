/**
 * MVP-08 — mã lỗi của tầng ĐĂNG SÀN (`docs/MVP-08-CONTRACT.md` §4).
 *
 * Mã lỗi LÀ HỢP ĐỒNG: tầng HTTP ánh xạ `code` → mã trạng thái, UI ánh xạ `code` → câu tiếng Việt.
 * Không thêm mã mới mà không ghi vào bảng ở `src/http/routes.js` (`mapMarketplaceError`).
 */

export const MARKETPLACE_CODES = Object.freeze({
  BAD_INPUT: 'BAD_INPUT',
  CHANNEL_UNKNOWN: 'CHANNEL_UNKNOWN',
  CHANNEL_NOT_CONFIGURED: 'CHANNEL_NOT_CONFIGURED',
  PREFLIGHT_FAILED: 'PREFLIGHT_FAILED',
  NOT_FOUND: 'LISTING_NOT_FOUND',
  NOT_APPROVED: 'NOT_APPROVED',
  ALREADY_DECIDED: 'LISTING_ALREADY_DECIDED',
  PUBLISH_IN_PROGRESS: 'PUBLISH_IN_PROGRESS',
  ATTEMPTS_EXCEEDED: 'ATTEMPTS_EXCEEDED',
  MARKETPLACE_ERROR: 'MARKETPLACE_ERROR',
  LIVE_DISABLED: 'LIVE_DISABLED',
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  SYNC_UNAVAILABLE: 'SYNC_UNAVAILABLE',
  UNAVAILABLE: 'MARKETPLACE_UNAVAILABLE',
  REASON_REQUIRED: 'REASON_REQUIRED',
});

export class MarketplaceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'MarketplaceError';
    this.code = String(code || MARKETPLACE_CODES.UNAVAILABLE);
    if (details && typeof details === 'object') this.details = details;
  }
}

/**
 * Che bí mật trong chuỗi lỗi THÔ của sàn trước khi ghi DB/log/trả API (luật #4: giữ nguyên văn
 * nhưng KHÔNG lộ token). Thay từng giá trị bí mật bằng `***`.
 */
export function maskSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    const v = String(s ?? '');
    if (v.length < 4) continue;
    out = out.split(v).join('***');
  }
  return out;
}

export default MarketplaceError;
