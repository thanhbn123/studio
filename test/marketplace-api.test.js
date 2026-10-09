/**
 * TEST MVP-08 · API (`src/http/routes.js`, hợp đồng §4) trên SERVER THẬT (SQLite in-memory).
 *
 * Phủ: ẩn danh ⇒ 401 · job của người khác ⇒ 404 · thiếu trường ⇒ 422 PREFLIGHT_FAILED kèm issues[] ·
 * đăng khi chưa duyệt ⇒ 409 NOT_APPROVED · member duyệt ⇒ 403 · admin duyệt ⇒ đăng (dry) ⇒ id `dry-`,
 * is_mock · đăng lần hai ⇒ idempotent · kênh chưa cấu hình ⇒ 409 CHANNEL_NOT_CONFIGURED · từ chối
 * bắt buộc lý do · đồng bộ · phân quyền danh sách · `/api/config.marketplace` · tắt bằng cấu hình ⇒ 503.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startMvp05App, register, request, j, PASSWORD } from './mvp05-helpers.js';
import { seedJob } from './export-helpers.js';

const FULL = { price_vnd: 199000, stock: 7, weight_g: 250, category_id: '100001' };
const CONTENT = { product_name: 'Tai nghe thử', marketplace_description: 'Mô tả đủ dài cho sàn, gạch đầu dòng rõ ràng và trung thực.' };
const MASTER = { images: [{ url: 'https://img.example.com/a.jpg', status: 'FOUND' }], price: { raw: '¥12', currency: 'CNY', kind: 'fixed' }, variants: [], attributes: [] };

describe('MVP-08 · API đăng sàn', () => {
  let ctx; let owner; let member; let jobId; let memberJobId;
  const realFetch = globalThis.fetch;
  before(async () => {
    ctx = await startMvp05App();
    owner = await register(ctx.base, { email: 'owner-mk@example.com', password: PASSWORD });
    await ctx.store.updateUser(owner.body.user.id, { role: 'owner' });
    member = await register(ctx.base, { email: 'member-mk@example.com', password: PASSWORD });
    ({ jobId } = await seedJob(ctx, { sid: 'apiSessionAAAAAAAAAA1', userId: owner.body.user.id, content: CONTENT }));
    await ctx.store.updateJob(jobId, { product_master: MASTER });
    ({ jobId: memberJobId } = await seedJob(ctx, { sid: 'apiSessionBBBBBBBBBB2', userId: member.body.user.id, content: CONTENT, id: '22222222-2222-4222-8222-222222222222' }));
    await ctx.store.updateJob(memberJobId, { product_master: MASTER });
    // Mọi fetch RA NGOÀI máy chủ thử ⇒ nổ: chứng minh dry-run không chạm mạng ngay cả qua HTTP thật.
    globalThis.fetch = async (url, opts) => {
      if (String(url).startsWith(ctx.base)) return realFetch(url, opts);
      throw new Error(`KHÔNG ĐƯỢC GỌI MẠNG: ${url}`);
    };
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await ctx.close();
  });

  test('/api/config.marketplace và GET /channels: chỉ cờ, không bí mật; dry-run là mock, shopee/tiktokshop chưa cấu hình', async () => {
    const cfg = await j(await request(ctx.base, '/api/config'));
    assert.equal(cfg.marketplace.enabled, true);
    assert.equal(cfg.marketplace.live_enabled, false);
    assert.equal(cfg.marketplace.default_channel, 'dry-run');
    const by = Object.fromEntries(cfg.marketplace.channels.map((c) => [c.name, c]));
    assert.equal(by['dry-run'].is_mock, true);
    assert.equal(by.shopee.configured, false);
    assert.match(by.shopee.notice, /chưa có token Shopee/);
    assert.match(by.tiktokshop.notice, /chưa có token TikTok Shop/);
    const raw = JSON.stringify(cfg.marketplace);
    for (const k of ['partnerKey', 'accessToken', 'appSecret', 'access_token']) assert.equal(raw.includes(k), false, `lộ ${k}`);
    const ch = await j(await request(ctx.base, '/api/marketplace/channels'));
    assert.equal(ch.channels.length, 3);
  });

  test('ẩn danh ⇒ 401 ở tạo/xem/đăng', async () => {
    for (const [path, method] of [['/api/marketplace/listings', 'POST'], ['/api/marketplace/listings', 'GET'], ['/api/marketplace/listings/x/publish', 'POST']]) {
      const res = await request(ctx.base, path, { method, body: method === 'POST' ? { job_id: jobId } : undefined });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });

  test('job của người khác ⇒ 404 (không tiết lộ tồn tại); job_id sai ⇒ 400', async () => {
    const res = await request(ctx.base, '/api/marketplace/listings', { method: 'POST', jar: member.jar, body: { job_id: jobId, overrides: FULL } });
    assert.equal(res.status, 404);
    assert.equal((await j(res)).error.code, 'JOB_NOT_FOUND');
    const bad = await request(ctx.base, '/api/marketplace/listings', { method: 'POST', jar: member.jar, body: { job_id: 'x' } });
    assert.equal(bad.status, 400);
  });

  test('thiếu trường ⇒ 422 PREFLIGHT_FAILED kèm issues[] nêu đúng tên trường; không tạo bản ghi', async () => {
    const res = await request(ctx.base, '/api/marketplace/listings', { method: 'POST', jar: owner.jar, body: { job_id: jobId, channel: 'dry-run' } });
    assert.equal(res.status, 422);
    const body = await j(res);
    assert.equal(body.error.code, 'PREFLIGHT_FAILED');
    const fields = body.error.details.issues.filter((i) => i.severity !== 'warn').map((i) => i.field).sort();
    assert.deepEqual(fields, ['category_id', 'price_vnd', 'stock', 'weight_g']);
    assert.equal(body.error.details.input.price_vnd, null);
    assert.equal(await ctx.store.countMarketplaceListings({ jobId }), 0);
    const unknown = await request(ctx.base, '/api/marketplace/listings', { method: 'POST', jar: owner.jar, body: { job_id: jobId, channel: 'lazada', overrides: FULL } });
    assert.equal(unknown.status, 400);
    assert.equal((await j(unknown)).error.code, 'CHANNEL_UNKNOWN');
  });

  let listingId;
  test('tạo 201 pending_review → đăng khi chưa duyệt 409 NOT_APPROVED → member duyệt 403 → owner duyệt → đăng (dry) 200', async () => {
    const res = await request(ctx.base, '/api/marketplace/listings', { method: 'POST', jar: owner.jar, body: { job_id: jobId, channel: 'dry-run', overrides: FULL } });
    assert.equal(res.status, 201);
    const body = await j(res);
    listingId = body.listing.id;
    assert.equal(body.listing.status, 'pending_review');
    assert.equal(body.listing.price_vnd, 199000);
    assert.ok(body.issues.every((i) => i.severity === 'warn'));

    const early = await request(ctx.base, `/api/marketplace/listings/${listingId}/publish`, { method: 'POST', jar: owner.jar });
    assert.equal(early.status, 409);
    assert.equal((await j(early)).error.code, 'NOT_APPROVED');

    const forbidden = await request(ctx.base, `/api/marketplace/listings/${listingId}/approve`, { method: 'POST', jar: member.jar });
    assert.equal(forbidden.status, 403);

    const ok = await request(ctx.base, `/api/marketplace/listings/${listingId}/approve`, { method: 'POST', jar: owner.jar });
    assert.equal(ok.status, 200);
    assert.equal((await j(ok)).listing.status, 'approved');

    const pub = await request(ctx.base, `/api/marketplace/listings/${listingId}/publish`, { method: 'POST', jar: owner.jar });
    assert.equal(pub.status, 200);
    const pb = await j(pub);
    assert.equal(pb.status, 'published');
    assert.match(pb.external_id, /^dry-/);
    assert.equal(pb.is_mock, true);
    assert.equal(pb.url, null);
    assert.equal(pb.called, true);
  });

  test('đăng lần hai ⇒ idempotent, called=false; tạo lại cùng job+kênh ⇒ 200 trả bản cũ', async () => {
    const pub = await j(await request(ctx.base, `/api/marketplace/listings/${listingId}/publish`, { method: 'POST', jar: owner.jar }));
    assert.equal(pub.idempotent, true);
    assert.equal(pub.called, false);
    const again = await request(ctx.base, '/api/marketplace/listings', { method: 'POST', jar: owner.jar, body: { job_id: jobId, channel: 'dry-run', overrides: FULL } });
    assert.equal(again.status, 200);
    const b = await j(again);
    assert.equal(b.idempotent, true);
    assert.equal(b.listing.id, listingId);
  });

  test('GET /listings/:id: payload giữ nguyên + unmapped + events; member xem bài của owner ⇒ 404', async () => {
    const res = await request(ctx.base, `/api/marketplace/listings/${listingId}`, { jar: owner.jar });
    assert.equal(res.status, 200);
    const d = await j(res);
    assert.equal(d.listing.payload.dry_run, true);
    assert.equal(d.listing.payload.previews.shopee.original_price, 199000);
    assert.ok(d.listing.unmapped.length > 0);
    assert.deepEqual(d.events.map((e) => e.kind), ['created', 'approved', 'publish_started', 'published']);
    const other = await request(ctx.base, `/api/marketplace/listings/${listingId}`, { jar: member.jar });
    assert.equal(other.status, 404);
  });

  test('sync dry-run ⇒ snapshot giá/tồn (mock); listing chưa đăng ⇒ 409 SYNC_UNAVAILABLE', async () => {
    const res = await request(ctx.base, `/api/marketplace/listings/${listingId}/sync`, { method: 'POST', jar: owner.jar });
    assert.equal(res.status, 200);
    const d = await j(res);
    assert.equal(d.snapshot.price, 199000);
    assert.equal(d.is_mock, true);
    const fresh = await j(await request(ctx.base, '/api/marketplace/listings', { method: 'POST', jar: owner.jar, body: { job_id: jobId, channel: 'dry-run', overrides: FULL, run_key: 'sync-2' } }));
    const no = await request(ctx.base, `/api/marketplace/listings/${fresh.listing.id}/sync`, { method: 'POST', jar: owner.jar });
    assert.equal(no.status, 409);
    assert.equal((await j(no)).error.code, 'SYNC_UNAVAILABLE');
  });

  test('kênh shopee chưa cấu hình: tạo được, duyệt được, ĐĂNG ⇒ 409 CHANNEL_NOT_CONFIGURED, trạng thái vẫn approved', async () => {
    const c = await j(await request(ctx.base, '/api/marketplace/listings', { method: 'POST', jar: owner.jar, body: { job_id: jobId, channel: 'shopee', overrides: FULL } }));
    await request(ctx.base, `/api/marketplace/listings/${c.listing.id}/approve`, { method: 'POST', jar: owner.jar });
    const res = await request(ctx.base, `/api/marketplace/listings/${c.listing.id}/publish`, { method: 'POST', jar: owner.jar });
    assert.equal(res.status, 409);
    const b = await j(res);
    assert.equal(b.error.code, 'CHANNEL_NOT_CONFIGURED');
    assert.match(b.error.details.notice, /chưa có token Shopee/);
    assert.equal((await ctx.store.getMarketplaceListing(c.listing.id)).status, 'approved');
    assert.equal((await ctx.store.getMarketplaceListing(c.listing.id)).attempts, 0, 'không tốn lượt');
  });

  test('từ chối: thiếu lý do ⇒ 400 REASON_REQUIRED; có lý do ⇒ rejected; đăng sau đó ⇒ 409', async () => {
    const c = await j(await request(ctx.base, '/api/marketplace/listings', { method: 'POST', jar: member.jar, body: { job_id: memberJobId, channel: 'dry-run', overrides: FULL } }));
    const no = await request(ctx.base, `/api/marketplace/listings/${c.listing.id}/reject`, { method: 'POST', jar: owner.jar, body: {} });
    assert.equal(no.status, 400);
    assert.equal((await j(no)).error.code, 'REASON_REQUIRED');
    const ok = await request(ctx.base, `/api/marketplace/listings/${c.listing.id}/reject`, { method: 'POST', jar: owner.jar, body: { reason: '<b>mô tả</b> sai' } });
    assert.equal(ok.status, 200);
    assert.equal((await j(ok)).listing.reject_reason, '<b>mô tả</b> sai', 'lý do giữ nguyên, UI escape');
    const pub = await request(ctx.base, `/api/marketplace/listings/${c.listing.id}/publish`, { method: 'POST', jar: member.jar });
    assert.equal(pub.status, 409);
  });

  test('danh sách: member chỉ thấy của mình; owner thấy tất cả, mine=1 ⇒ của mình; lọc status', async () => {
    const mine = await j(await request(ctx.base, '/api/marketplace/listings', { jar: member.jar }));
    assert.equal(mine.scope, 'mine');
    assert.ok(mine.items.every((i) => i.user_id === member.body.user.id));
    const all = await j(await request(ctx.base, '/api/marketplace/listings', { jar: owner.jar }));
    assert.equal(all.scope, 'all');
    assert.ok(all.items.some((i) => i.user_id === member.body.user.id));
    const own = await j(await request(ctx.base, '/api/marketplace/listings?mine=1', { jar: owner.jar }));
    assert.ok(own.items.every((i) => i.user_id === owner.body.user.id));
    const pub = await j(await request(ctx.base, '/api/marketplace/listings?status=published', { jar: owner.jar }));
    assert.ok(pub.items.length >= 1 && pub.items.every((i) => i.status === 'published'));
    assert.equal(typeof all.total, 'number');
  });
});

describe('MVP-08 · MARKETPLACE_ENABLED=false ⇒ 503 nói thẳng, /api/config.marketplace = null', () => {
  let ctx;
  before(async () => {
    ctx = await startMvp05App({ configOverrides: { MARKETPLACE_ENABLED: 'false' } });
  });
  after(async () => {
    await ctx.close();
  });
  test('route trả 503 MARKETPLACE_UNAVAILABLE; config null', async () => {
    const res = await request(ctx.base, '/api/marketplace/channels');
    assert.equal(res.status, 503);
    assert.equal((await j(res)).error.code, 'MARKETPLACE_UNAVAILABLE');
    const cfg = await j(await request(ctx.base, '/api/config'));
    assert.equal(cfg.marketplace, null);
  });
});
