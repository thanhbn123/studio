/**
 * MVP-08 — `MarketplaceService`: tạo listing → kiểm tra → DUYỆT TAY → đăng → đồng bộ, kèm vết
 * (`marketplace_events`) và idempotency (hợp đồng §0 bốn luật, §4).
 *
 * Đây là chỗ DUY NHẤT trong mã nguồn được gọi `provider.createListing()` (soi gương `PublishService`
 * của MVP-07). Thứ tự trong `publish()` KHÔNG ĐƯỢC ĐẢO:
 *   1. Kiểm kênh có cấu hình chưa — chưa thì 409 `CHANNEL_NOT_CONFIGURED`, KHÔNG đổi trạng thái.
 *   2. `store.claimMarketplaceListing()` — câu `UPDATE … WHERE status IN ('approved','failed') AND
 *      external_id IS NULL AND attempts < max` ở TẦNG DB: không claim được ⇒ không có đường nào gọi sàn.
 *   3. Claim xong MỚI gọi provider; MỌI kết quả (kể cả lỗi) ghi `marketplace_events`.
 *
 * Luật #3 (không đăng hai lần): `createListing` idempotent theo `(job_id, channel, run_key)` nhờ
 * unique index ở DB; `publish` lần hai khi đã có `external_id` ⇒ trả bản cũ, `called: false`.
 * Luật #4 (lỗi nói rõ sàn nào, mã nào): `error_code` chuẩn hoá + `raw` nguyên văn đã che bí mật.
 */

import { randomUUID } from 'node:crypto';

import { MARKETPLACE_CODES, MarketplaceError } from './errors.js';
import { DEFAULT_CHANNEL, isMarketplaceChannel, providerInfo } from './provider.js';
import { buildListingInput, hasBlockingIssue, preflight, OVERRIDE_FIELDS } from './preflight.js';
import { mapToShopee } from './mapping/shopee.js';
import { mapToTiktokShop } from './mapping/tiktokshop.js';

export const LISTING_STATUSES = Object.freeze(['draft', 'pending_review', 'approved', 'publishing', 'published', 'failed', 'rejected']);

/** `run_key` mặc định — tất định theo (job, kênh) để lần tạo thứ hai trả bản cũ (luật #3). */
export function defaultRunKey(jobId, channel) {
  return `${String(jobId ?? '')}#${String(channel ?? '')}`;
}

/** Chỉ giữ các khoá được phép, bỏ rác. */
export function sanitizeOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const k of OVERRIDE_FIELDS) if (k in raw) out[k] = raw[k];
  return out;
}

/** Payload theo kênh. `dry-run` giữ đầu vào chuẩn + bản xem trước cho CẢ hai sàn để người dùng soi. */
export function mapForChannel(channel, input) {
  if (channel === 'shopee') return mapToShopee(input);
  if (channel === 'tiktokshop') return mapToTiktokShop(input);
  const shopee = mapToShopee(input);
  const tiktok = mapToTiktokShop(input);
  return {
    channel: 'dry-run',
    payload: {
      dry_run: true,
      listing: input,
      previews: { shopee: shopee.payload, tiktokshop: tiktok.payload },
      _vps_price_vnd: input?.price_vnd ?? null,
      _vps_stock: input?.stock ?? null,
    },
    unmapped: [
      ...shopee.unmapped.map((u) => ({ ...u, channel: 'shopee' })),
      ...tiktok.unmapped.map((u) => ({ ...u, channel: 'tiktokshop' })),
    ],
    defaults_applied: [
      ...shopee.defaults_applied.map((d) => ({ ...d, channel: 'shopee' })),
      ...tiktok.defaults_applied.map((d) => ({ ...d, channel: 'tiktokshop' })),
    ],
  };
}

export class MarketplaceService {
  constructor({ store = null, registry = null, config = null, logger = null } = {}) {
    this.store = store;
    this.registry = registry;
    this.config = config || {};
    this.logger = logger;
  }

  get maxAttempts() {
    const n = Number(this.config?.marketplace?.maxAttempts);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 3;
  }

  get liveEnabled() {
    return this.config?.marketplace?.liveEnabled === true;
  }

  get defaultChannel() {
    const raw = String(this.config?.marketplace?.defaultChannel ?? '').trim();
    return isMarketplaceChannel(raw) ? raw : DEFAULT_CHANNEL;
  }

  #requireStore(method) {
    if (!this.store || typeof this.store[method] !== 'function') {
      throw new MarketplaceError(MARKETPLACE_CODES.UNAVAILABLE, `Chức năng đăng sàn chưa dùng được: store thiếu \`${method}\`.`, { method });
    }
    return this.store;
  }

  #provider(channel) {
    const ch = String(channel ?? '');
    if (!isMarketplaceChannel(ch) || !this.registry?.has?.(ch)) {
      throw new MarketplaceError(MARKETPLACE_CODES.CHANNEL_UNKNOWN, `Kênh "${ch.slice(0, 40)}" không hợp lệ (nhận: ${this.registry?.names?.().join(', ') || 'dry-run'}).`, { channel: ch });
    }
    return this.registry.get(ch);
  }

  /** Khối cho `/api/config.marketplace` + `GET /api/marketplace/channels` — chỉ cờ. */
  channelsInfo() {
    return {
      enabled: this.config?.marketplace?.enabled !== false,
      live_enabled: this.liveEnabled,
      default_channel: this.defaultChannel,
      max_attempts: this.maxAttempts,
      channels: this.registry ? this.registry.list() : [],
    };
  }

  /* ───────────────────────── tạo + kiểm tra ───────────────────────── */

  /**
   * Tạo listing từ job. Chạy `preflight` TRƯỚC: có lỗi chặn ⇒ ném `PREFLIGHT_FAILED` kèm `issues[]`
   * + `input` (để UI chỉ đúng trường thiếu) và KHÔNG tạo bản ghi nào.
   */
  async createListing({ job = null, userId = null, channel = null, overrides = null, runKey = null } = {}) {
    const store = this.#requireStore('createMarketplaceListing');
    const uid = String(userId ?? '').trim();
    if (!uid) throw new MarketplaceError(MARKETPLACE_CODES.BAD_INPUT, 'Đăng sàn cần tài khoản (hành động ra ngoài phải có người chịu trách nhiệm).');
    if (!job || !job.id) throw new MarketplaceError(MARKETPLACE_CODES.BAD_INPUT, 'Thiếu job nguồn.');
    const ch = String(channel || this.defaultChannel);
    this.#provider(ch); // CHANNEL_UNKNOWN nếu sai tên
    const ov = sanitizeOverrides(overrides);
    const input = buildListingInput(job, ov);
    const issues = preflight(ch, input);
    if (hasBlockingIssue(issues)) {
      throw new MarketplaceError(
        MARKETPLACE_CODES.PREFLIGHT_FAILED,
        `Chưa đủ dữ liệu để đăng lên ${ch}: ${issues.filter((i) => i.severity !== 'warn').map((i) => i.field).join(', ')}.`,
        { channel: ch, issues, input },
      );
    }
    const mapped = mapForChannel(ch, input);
    const key = String(runKey ?? '').trim() || defaultRunKey(job.id, ch);
    const existing = typeof store.findMarketplaceListingByRunKey === 'function'
      ? await store.findMarketplaceListingByRunKey({ jobId: job.id, channel: ch, runKey: key })
      : null;
    if (existing) {
      return { listing: existing, issues: existing.issues || issues, idempotent: true };
    }
    const listing = await store.createMarketplaceListing({
      id: randomUUID(),
      jobId: job.id,
      userId: uid,
      channel: ch,
      status: 'pending_review',
      runKey: key,
      input,
      overrides: ov,
      payload: mapped.payload,
      issues,
      unmapped: mapped.unmapped,
      defaultsApplied: mapped.defaults_applied,
    });
    await this.#event(listing.id, { kind: 'created', fromStatus: null, toStatus: listing.status, actorUserId: uid, detail: { channel: ch, run_key: key, warnings: issues.length } });
    this.logger?.info?.('marketplace.listing_created', { listing_id: listing.id, job_id: job.id, channel: ch, idempotent: Boolean(listing.idempotent) });
    return { listing, issues, idempotent: Boolean(listing.idempotent) };
  }

  async list({ userId = null, all = false, jobId = null, channel = null, status = null, limit = 50, offset = 0 } = {}) {
    const store = this.#requireStore('listMarketplaceListings');
    const filter = {
      userId: all ? null : String(userId ?? ''),
      jobId: jobId || null,
      channel: channel && isMarketplaceChannel(channel) ? channel : null,
      status: status && LISTING_STATUSES.includes(status) ? status : null,
      limit,
      offset,
    };
    if (!all && !filter.userId) throw new MarketplaceError(MARKETPLACE_CODES.BAD_INPUT, 'Thiếu người dùng.');
    const items = await store.listMarketplaceListings(filter);
    let total = Array.isArray(items) ? items.length + Number(offset || 0) : 0;
    if (typeof store.countMarketplaceListings === 'function') {
      try {
        const n = await store.countMarketplaceListings(filter);
        if (Number.isFinite(Number(n))) total = Number(n);
      } catch (err) {
        this.logger?.warn?.('marketplace.count_failed', { error_name: err?.name || 'Error' });
      }
    }
    return { items: Array.isArray(items) ? items : [], total };
  }

  /** Khác chủ và không phải admin ⇒ `LISTING_NOT_FOUND` (404 — không tiết lộ tồn tại). */
  async get({ id, requesterId = null, isAdmin = false } = {}) {
    const store = this.#requireStore('getMarketplaceListing');
    const listing = await store.getMarketplaceListing(id);
    if (!listing || (!isAdmin && String(listing.user_id ?? '') !== String(requesterId ?? ''))) {
      throw new MarketplaceError(MARKETPLACE_CODES.NOT_FOUND, 'Không tìm thấy listing.', { listing_id: String(id ?? '') });
    }
    return listing;
  }

  async events(listingId) {
    const store = this.store;
    if (typeof store?.listMarketplaceEvents !== 'function') return [];
    return store.listMarketplaceEvents(listingId);
  }

  /* ───────────────────────── duyệt tay ───────────────────────── */

  async approve({ id, actorId = null } = {}) {
    const store = this.#requireStore('updateMarketplaceListing');
    const listing = await this.get({ id, isAdmin: true });
    if (listing.status !== 'pending_review') {
      throw new MarketplaceError(MARKETPLACE_CODES.ALREADY_DECIDED, `Listing đang ở trạng thái "${listing.status}" — chỉ duyệt được bài đang chờ duyệt.`, { listing_id: listing.id, status: listing.status });
    }
    // Kiểm LẠI ngay trước khi duyệt: luật của sàn có thể đã siết (hoặc dữ liệu được sửa tay trong DB).
    const issues = preflight(listing.channel, listing.input || {});
    if (hasBlockingIssue(issues)) {
      throw new MarketplaceError(MARKETPLACE_CODES.PREFLIGHT_FAILED, 'Listing không còn qua được kiểm tra — không duyệt.', { listing_id: listing.id, issues });
    }
    const updated = await store.updateMarketplaceListing(listing.id, { status: 'approved', approved_by: actorId ?? null, approved_at: new Date().toISOString(), issues }, { fromStatus: 'pending_review' });
    if (!updated) throw new MarketplaceError(MARKETPLACE_CODES.ALREADY_DECIDED, 'Listing vừa được người khác quyết định.', { listing_id: listing.id });
    await this.#event(listing.id, { kind: 'approved', fromStatus: 'pending_review', toStatus: 'approved', actorUserId: actorId });
    return updated;
  }

  async reject({ id, actorId = null, reason = '' } = {}) {
    const store = this.#requireStore('updateMarketplaceListing');
    const text = String(reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text) throw new MarketplaceError(MARKETPLACE_CODES.REASON_REQUIRED, 'Từ chối phải có lý do.');
    const listing = await this.get({ id, isAdmin: true });
    if (!['pending_review', 'approved', 'failed'].includes(listing.status)) {
      throw new MarketplaceError(MARKETPLACE_CODES.ALREADY_DECIDED, `Listing đang ở trạng thái "${listing.status}" — không từ chối được.`, { listing_id: listing.id, status: listing.status });
    }
    const updated = await store.updateMarketplaceListing(listing.id, { status: 'rejected', rejected_by: actorId ?? null, rejected_at: new Date().toISOString(), reject_reason: text }, { fromStatus: listing.status });
    if (!updated) throw new MarketplaceError(MARKETPLACE_CODES.ALREADY_DECIDED, 'Listing vừa đổi trạng thái.', { listing_id: listing.id });
    await this.#event(listing.id, { kind: 'rejected', fromStatus: listing.status, toStatus: 'rejected', actorUserId: actorId, detail: { reason: text } });
    return updated;
  }

  /* ───────────────────────── đăng ───────────────────────── */

  /**
   * ĐĂNG — chỉ chạy khi listing đã `approved` (hoặc `failed` để thử lại, dưới trần `maxAttempts`).
   * Trả `{ listing, result, called, idempotent }`. Sàn báo lỗi ⇒ listing `failed` + ném
   * `MARKETPLACE_ERROR` kèm `raw` (route trả 502); KHÔNG nuốt.
   */
  async publish({ id, actorId = null, requesterId = null, isAdmin = false } = {}) {
    const store = this.#requireStore('claimMarketplaceListing');
    const listing = await this.get({ id, requesterId, isAdmin });
    if (listing.external_id) {
      return { listing, result: listing.last_result || null, called: false, idempotent: true };
    }
    const provider = this.#provider(listing.channel);
    if (!provider.configured) {
      throw new MarketplaceError(MARKETPLACE_CODES.CHANNEL_NOT_CONFIGURED, `Kênh ${listing.channel} chưa cấu hình: ${provider.notice || 'thiếu token'}.`, { listing_id: listing.id, channel: listing.channel, notice: provider.notice || '' });
    }
    const claimed = await store.claimMarketplaceListing(listing.id, { maxAttempts: this.maxAttempts });
    if (!claimed) {
      const fresh = await store.getMarketplaceListing(listing.id);
      const st = fresh?.status || listing.status;
      if (fresh?.external_id) return { listing: fresh, result: fresh.last_result || null, called: false, idempotent: true };
      if (st === 'publishing') throw new MarketplaceError(MARKETPLACE_CODES.PUBLISH_IN_PROGRESS, 'Listing đang được đăng bởi một lượt khác.', { listing_id: listing.id });
      if ((st === 'approved' || st === 'failed') && Number(fresh?.attempts) >= this.maxAttempts) {
        throw new MarketplaceError(MARKETPLACE_CODES.ATTEMPTS_EXCEEDED, `Đã thử đăng ${fresh.attempts} lượt (trần ${this.maxAttempts}) — dừng để không spam sàn.`, { listing_id: listing.id, attempts: fresh.attempts, max_attempts: this.maxAttempts });
      }
      throw new MarketplaceError(MARKETPLACE_CODES.NOT_APPROVED, `Listing đang ở trạng thái "${st}" — phải được DUYỆT trước khi đăng.`, { listing_id: listing.id, status: st });
    }
    const runKey = `${listing.id}#${claimed.attempts}`;
    await this.#event(listing.id, { kind: 'publish_started', fromStatus: listing.status, toStatus: 'publishing', actorUserId: actorId, detail: { attempt: claimed.attempts, run_key: runKey, provider: provider.name } });

    let result;
    try {
      result = await provider.createListing(claimed.payload);
    } catch (err) {
      result = { status: 'failed', provider: provider.name, external_id: null, url: null, error_code: 'MARKETPLACE_ERROR', error_message: String(err?.message || err).slice(0, 1000), raw: { thrown: true }, is_mock: Boolean(provider.isMock) };
    }
    const ok = result?.status === 'published' || result?.status === 'dry_run';
    const patch = ok
      ? { status: 'published', external_id: result.external_id, external_url: result.url ?? null, is_mock: result.is_mock ? 1 : 0, error_code: null, last_error: null, published_at: new Date().toISOString(), last_result: result }
      : { status: 'failed', error_code: String(result?.error_code || 'MARKETPLACE_ERROR'), last_error: String(result?.error_message || ''), last_result: result };
    const updated = await store.updateMarketplaceListing(listing.id, patch, { fromStatus: 'publishing' });
    await this.#event(listing.id, {
      kind: ok ? 'published' : 'publish_failed',
      fromStatus: 'publishing',
      toStatus: patch.status,
      actorUserId: actorId,
      detail: { attempt: claimed.attempts, run_key: runKey, provider: provider.name, external_id: result?.external_id ?? null, error_code: result?.error_code ?? null, is_mock: Boolean(result?.is_mock) },
    });
    this.logger?.[ok ? 'info' : 'warn']?.('marketplace.publish_result', { listing_id: listing.id, channel: listing.channel, status: patch.status, error_code: result?.error_code ?? null, is_mock: Boolean(result?.is_mock) });
    if (!ok) {
      throw new MarketplaceError(MARKETPLACE_CODES.MARKETPLACE_ERROR, `Sàn ${listing.channel} từ chối: ${result?.error_message || result?.error_code || 'không rõ'}`, {
        listing_id: listing.id,
        channel: listing.channel,
        error_code: String(result?.error_code || 'MARKETPLACE_ERROR'),
        raw: result?.raw ?? null,
        attempts: claimed.attempts,
        max_attempts: this.maxAttempts,
        listing: updated || null,
      });
    }
    return { listing: updated || claimed, result, called: true, idempotent: false };
  }

  /* ───────────────────────── đồng bộ (chỉ đọc) ───────────────────────── */

  /** Đọc giá/tồn từ sàn để ĐỐI CHIẾU (luật #2 — không ghi gì lên sàn). */
  async sync({ id, actorId = null, requesterId = null, isAdmin = false } = {}) {
    const store = this.#requireStore('updateMarketplaceListing');
    const listing = await this.get({ id, requesterId, isAdmin });
    const provider = this.#provider(listing.channel);
    if (!provider.configured || !provider.capabilities?.readListing) {
      throw new MarketplaceError(MARKETPLACE_CODES.CHANNEL_NOT_CONFIGURED, `Kênh ${listing.channel} chưa cấu hình hoặc không hỗ trợ đọc — không đồng bộ được.`, { listing_id: listing.id, channel: listing.channel });
    }
    if (!listing.external_id) {
      throw new MarketplaceError(MARKETPLACE_CODES.SYNC_UNAVAILABLE, 'Listing chưa có mã trên sàn — chưa đăng thì không có gì để đồng bộ.', { listing_id: listing.id, status: listing.status });
    }
    let result;
    try {
      result = await provider.readListing(listing.external_id);
    } catch (err) {
      result = { status: 'failed', provider: provider.name, error_code: 'MARKETPLACE_ERROR', error_message: String(err?.message || err).slice(0, 1000), raw: { thrown: true }, is_mock: Boolean(provider.isMock) };
    }
    const ok = result?.status === 'published' || result?.status === 'dry_run';
    const snapshot = ok ? { price: result.raw?.price ?? null, stock: result.raw?.stock ?? null, status: result.raw?.item_status ?? result.raw?.product_status ?? null, raw: result.raw ?? null, is_mock: Boolean(result.is_mock) } : null;
    const updated = ok
      ? await store.updateMarketplaceListing(listing.id, { remote_snapshot: snapshot, synced_at: new Date().toISOString() })
      : listing;
    await this.#event(listing.id, { kind: ok ? 'synced' : 'sync_failed', fromStatus: listing.status, toStatus: listing.status, actorUserId: actorId, detail: { error_code: result?.error_code ?? null, is_mock: Boolean(result?.is_mock) } });
    if (!ok) {
      throw new MarketplaceError(MARKETPLACE_CODES.MARKETPLACE_ERROR, `Sàn ${listing.channel} không trả được dữ liệu: ${result?.error_message || result?.error_code || 'không rõ'}`, { listing_id: listing.id, channel: listing.channel, error_code: String(result?.error_code || 'MARKETPLACE_ERROR'), raw: result?.raw ?? null });
    }
    return { listing: updated || listing, snapshot, result };
  }

  async #event(listingId, { kind, fromStatus = null, toStatus = null, actorUserId = null, detail = null } = {}) {
    if (typeof this.store?.appendMarketplaceEvent !== 'function') return null;
    try {
      return await this.store.appendMarketplaceEvent({ listingId, kind, fromStatus, toStatus, actorUserId, detail });
    } catch (err) {
      // Vết là bắt buộc: ghi vết hỏng thì phải thấy trong log, không nuốt.
      this.logger?.error?.('marketplace.event_failed', { listing_id: listingId, kind, error_name: err?.name || 'Error', error_message: String(err?.message || err).slice(0, 300) });
      return null;
    }
  }
}

export function createMarketplaceService(config = {}, { store = null, registry = null, logger = null } = {}) {
  return new MarketplaceService({ config, store, registry, logger });
}

export { providerInfo };
export default MarketplaceService;
