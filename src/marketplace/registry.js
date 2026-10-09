/**
 * MVP-08 — `MarketplaceRegistry`: một sàn hỏng KHÔNG làm hỏng luồng chung (hợp đồng §0, soi gương
 * `ConnectorRegistry` của MVP-01).
 *
 * Mỗi provider được dựng trong `try/catch` riêng. Factory ném lỗi (cấu hình rác, module hỏng…)
 * ⇒ thay bằng một provider "gãy": `configured: false` + `error` nói thẳng, mọi lời gọi trả
 * `PROVIDER_BROKEN`. Các kênh còn lại vẫn dùng bình thường.
 */

import { MARKETPLACE_CHANNELS, assertProviderShape, listingResult, providerInfo } from './provider.js';
import { createDryRunMarketplaceProvider } from './providers/dry-run.js';
import { createShopeeProvider } from './providers/shopee.js';
import { createTiktokShopProvider } from './providers/tiktokshop.js';

const FACTORIES = Object.freeze({
  'dry-run': createDryRunMarketplaceProvider,
  shopee: createShopeeProvider,
  tiktokshop: createTiktokShopProvider,
});

/** Provider thay thế khi factory hỏng — nói thẳng, không giả vờ chạy được. */
export function brokenProvider(name, err) {
  const message = String(err?.message || err || 'không rõ');
  const fail = async () => listingResult({ status: 'failed', provider: name, error_code: 'PROVIDER_BROKEN', error_message: `Provider ${name} không dựng được: ${message}` });
  return {
    name,
    configured: false,
    isMock: false,
    notice: `provider ${name} bị lỗi khi khởi tạo — kênh này tạm tắt (${message})`,
    error: { code: 'PROVIDER_BROKEN', message },
    capabilities: { createListing: false, updatePrice: false, updateStock: false, readListing: false },
    async probe() {
      return { ok: false, name, configured: false, is_mock: false, error_code: 'PROVIDER_BROKEN', detail: message };
    },
    createListing: fail,
    updatePrice: fail,
    updateStock: fail,
    readListing: fail,
  };
}

export class MarketplaceRegistry {
  constructor({ providers = new Map(), logger = null } = {}) {
    this.providers = providers;
    this.logger = logger;
  }

  has(name) {
    return this.providers.has(String(name ?? ''));
  }

  get(name) {
    return this.providers.get(String(name ?? '')) || null;
  }

  names() {
    return [...this.providers.keys()];
  }

  /** Danh sách cho `/api/marketplace/channels` — chỉ cờ, không bí mật. */
  list() {
    return this.names().map((n) => providerInfo(this.get(n)));
  }
}

/**
 * Dựng registry từ cấu hình. `factories` cho phép test bơm provider giả (kể cả factory ném lỗi
 * để chứng minh cô lập). `fetchImpl` bơm cho provider thật (test server nội bộ).
 */
export function createMarketplaceRegistry(config = {}, { logger = null, fetchImpl = undefined, factories = FACTORIES, channels = MARKETPLACE_CHANNELS } = {}) {
  const providers = new Map();
  for (const name of channels) {
    const factory = factories[name];
    try {
      if (typeof factory !== 'function') throw new Error(`không có factory cho kênh ${name}`);
      const p = assertProviderShape(factory(config, { logger, fetchImpl }));
      providers.set(name, p);
    } catch (err) {
      logger?.error?.('marketplace.provider_broken', { channel: name, error_name: err?.name || 'Error', error_message: String(err?.message || err).slice(0, 300) });
      providers.set(name, brokenProvider(name, err));
    }
  }
  return new MarketplaceRegistry({ providers, logger });
}

export default createMarketplaceRegistry;
