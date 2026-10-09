/**
 * Provider `dry-run` — MẶC ĐỊNH của MVP-08 (hợp đồng §2).
 *
 * Ba cam kết, kiểm được bằng test:
 *   1. **KHÔNG có một dòng `fetch`** trong file này (test thay `globalThis.fetch` bằng hàm ném lỗi
 *      rồi chạy trọn luồng — vẫn chạy).
 *   2. `external_id` **luôn** có tiền tố `dry-` + băm payload ⇒ không ai nhầm với id trên sàn thật;
 *      `url: null` (không có bài thật thì không có link thật); `is_mock: true`.
 *   3. Payload đã qua `preflight` được **giữ nguyên** (`raw.payload`) để người dùng soi.
 *
 * `readListing`/`updatePrice`/`updateStock` làm việc trên một bảng TRONG BỘ NHỚ của tiến trình —
 * khởi động lại là mất, và đó là đúng: chế độ thử không có "sàn" nào để nhớ.
 */

import { createHash } from 'node:crypto';

import { listingResult } from '../provider.js';

export const DRY_RUN_PREFIX = 'dry-';

export const DRY_RUN_NOTICE = 'CHẾ ĐỘ THỬ — không đăng thật. Không gửi gì lên sàn; mã bài có tiền tố "dry-".';

export function dryRunExternalId(payload) {
  const hash = createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
  return `${DRY_RUN_PREFIX}${hash.slice(0, 16)}`;
}

export function createDryRunMarketplaceProvider(config = {}, { logger = null } = {}) {
  const calls = [];
  /** external_id → { payload, price, stock } — bảng giả trong bộ nhớ. */
  const memory = new Map();

  return {
    name: 'dry-run',
    configured: true,
    isMock: true,
    notice: DRY_RUN_NOTICE,
    capabilities: { createListing: true, updatePrice: true, updateStock: true, readListing: true },
    calls,

    async probe() {
      return { ok: true, name: 'dry-run', configured: true, is_mock: true, detail: DRY_RUN_NOTICE };
    },

    async createListing(payload) {
      calls.push({ op: 'createListing' });
      if (!payload || typeof payload !== 'object') {
        return listingResult({ status: 'failed', provider: 'dry-run', is_mock: true, error_code: 'BAD_INPUT', error_message: 'Payload rỗng.' });
      }
      const id = dryRunExternalId(payload);
      memory.set(id, { payload, price: payload?._vps_price_vnd ?? null, stock: payload?._vps_stock ?? null });
      logger?.info?.('marketplace.dry_run.create', { external_id: id });
      return listingResult({ status: 'dry_run', provider: 'dry-run', is_mock: true, external_id: id, url: null, raw: { dry_run: true, payload } });
    },

    async updatePrice(externalId, price) {
      calls.push({ op: 'updatePrice' });
      const row = memory.get(String(externalId));
      if (!row) return listingResult({ status: 'failed', provider: 'dry-run', is_mock: true, error_code: 'NOT_FOUND', error_message: 'Chế độ thử không nhớ bài này (tiến trình đã khởi động lại?).' });
      row.price = price;
      return listingResult({ status: 'dry_run', provider: 'dry-run', is_mock: true, external_id: externalId, raw: { dry_run: true, price } });
    },

    async updateStock(externalId, qty) {
      calls.push({ op: 'updateStock' });
      const row = memory.get(String(externalId));
      if (!row) return listingResult({ status: 'failed', provider: 'dry-run', is_mock: true, error_code: 'NOT_FOUND', error_message: 'Chế độ thử không nhớ bài này (tiến trình đã khởi động lại?).' });
      row.stock = qty;
      return listingResult({ status: 'dry_run', provider: 'dry-run', is_mock: true, external_id: externalId, raw: { dry_run: true, stock: qty } });
    },

    async readListing(externalId) {
      calls.push({ op: 'readListing' });
      const row = memory.get(String(externalId));
      if (!row) return listingResult({ status: 'failed', provider: 'dry-run', is_mock: true, error_code: 'NOT_FOUND', error_message: 'Chế độ thử không nhớ bài này (tiến trình đã khởi động lại?).' });
      return listingResult({
        status: 'dry_run',
        provider: 'dry-run',
        is_mock: true,
        external_id: externalId,
        raw: { dry_run: true, price: row.price, stock: row.stock, read_at: new Date().toISOString() },
      });
    },
  };
}

export default createDryRunMarketplaceProvider;
