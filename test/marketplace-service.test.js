/**
 * TEST MVP-08 · NGHIỆP VỤ + PROVIDER + CÔ LẬP (`src/marketplace/{registry,publish,providers/*}.js`).
 *
 * Chạy trên STORE THẬT (SQLite in-memory qua app dựng thật) với registry do test bơm, để đo đúng
 * các luật của hợp đồng §0/§6:
 *   - một sàn hỏng KHÔNG làm hỏng luồng chung (factory ném lỗi ⇒ kênh đó gãy, kênh khác vẫn chạy;
 *     provider trả lỗi ⇒ chỉ listing đó `failed`, listing khác vẫn đăng được);
 *   - dry-run chạy trọn luồng với **0 lời gọi mạng** (`globalThis.fetch` bị thay bằng hàm ném lỗi);
 *   - đăng 2 lần cùng run_key ⇒ 1 bản ghi, 1 lần gọi provider;
 *   - shopee/tiktokshop thiếu token ⇒ NOT_CONFIGURED, có token mà chưa bật live ⇒ LIVE_DISABLED —
 *     cả hai KHÔNG chạm mạng; có token + live + fetch giả ⇒ parse đúng/sai đúng kiểu, bí mật bị che.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startMvp05App, register, PASSWORD } from './mvp05-helpers.js';
import { seedJob } from './export-helpers.js';
import { createMarketplaceRegistry, brokenProvider } from '../src/marketplace/registry.js';
import { createMarketplaceService } from '../src/marketplace/publish.js';
import { createDryRunMarketplaceProvider } from '../src/marketplace/providers/dry-run.js';
import { createShopeeProvider } from '../src/marketplace/providers/shopee.js';
import { createTiktokShopProvider } from '../src/marketplace/providers/tiktokshop.js';
import { listingResult } from '../src/marketplace/provider.js';

const FULL = { price_vnd: 199000, stock: 7, weight_g: 250, category_id: '100001' };
const CONTENT = { product_name: 'Tai nghe thử', marketplace_description: 'Mô tả đủ dài cho sàn, gạch đầu dòng rõ ràng và trung thực.' };
const MASTER = { images: [{ url: 'https://img.example.com/a.jpg', status: 'FOUND' }], price: { raw: '¥12', currency: 'CNY', kind: 'fixed' }, variants: [], attributes: [] };

/** Provider giả "sàn thật" — cấu hình đủ, tự quyết thành công/thất bại theo `mode`. */
function fakeChannel(name, mode = 'ok') {
  const calls = [];
  return {
    name,
    configured: true,
    isMock: false,
    notice: 'giả lập cho test',
    capabilities: { createListing: true, updatePrice: true, updateStock: true, readListing: true },
    calls,
    async probe() { return { ok: true, name, configured: true }; },
    async createListing(payload) {
      calls.push({ op: 'createListing', payload });
      if (mode === 'throw') throw new Error(`${name} nổ`);
      if (mode === 'fail') return listingResult({ status: 'failed', provider: name, error_code: 'MARKETPLACE_ERROR', error_message: `${name}: error_param — invalid category`, raw: { body: '{"error":"error_param"}' } });
      return listingResult({ status: 'published', provider: name, external_id: `${name}-123`, url: `https://${name}.example/123`, raw: { ok: true } });
    },
    async updatePrice() { return listingResult({ status: 'published', provider: name, external_id: 'x' }); },
    async updateStock() { return listingResult({ status: 'published', provider: name, external_id: 'x' }); },
    async readListing(id) { calls.push({ op: 'readListing', id }); return listingResult({ status: 'published', provider: name, external_id: id, raw: { price: 210000, stock: 3 } }); },
  };
}

describe('MVP-08 · registry — cô lập provider hỏng', () => {
  test('factory ném lỗi ⇒ kênh đó gãy (PROVIDER_BROKEN) mà dry-run vẫn dùng được', async () => {
    const reg = createMarketplaceRegistry({}, {
      factories: {
        'dry-run': createDryRunMarketplaceProvider,
        shopee: () => { throw new Error('cấu hình rác'); },
        tiktokshop: () => ({ name: 'tiktokshop' }), // sai hình dạng (thiếu hàm)
      },
    });
    const info = Object.fromEntries(reg.list().map((c) => [c.name, c]));
    assert.equal(info['dry-run'].configured, true);
    assert.equal(info.shopee.configured, false);
    assert.equal(info.shopee.error.code, 'PROVIDER_BROKEN');
    assert.match(info.shopee.error.message, /cấu hình rác/);
    assert.equal(info.tiktokshop.error.code, 'PROVIDER_BROKEN');
    const r = await reg.get('shopee').createListing({});
    assert.equal(r.status, 'failed');
    assert.equal(r.error_code, 'PROVIDER_BROKEN');
    const ok = await reg.get('dry-run').createListing({ a: 1 });
    assert.equal(ok.status, 'dry_run');
  });

  test('brokenProvider đúng hình dạng interface', async () => {
    const p = brokenProvider('x', new Error('y'));
    for (const fn of ['probe', 'createListing', 'updatePrice', 'updateStock', 'readListing']) assert.equal(typeof p[fn], 'function');
    assert.equal((await p.probe()).ok, false);
  });
});

describe('MVP-08 · service trên store thật — dry-run trọn luồng, 0 mạng, idempotent, cô lập lỗi', () => {
  let ctx; let user; let jobId; let svc; let dry; let bad; let good;
  const realFetch = globalThis.fetch;
  before(async () => {
    ctx = await startMvp05App();
    const reg = await register(ctx.base, { email: 'svc@example.com', password: PASSWORD });
    user = reg.body.user;
    ({ jobId } = await seedJob(ctx, { sid: 'svcSessionAAAAAAAAAA1', userId: user.id, content: CONTENT }));
    await ctx.store.updateJob(jobId, { product_master: MASTER });
    dry = createDryRunMarketplaceProvider({});
    bad = fakeChannel('shopee', 'fail');
    good = fakeChannel('tiktokshop', 'ok');
    const registry = createMarketplaceRegistry({}, { factories: { 'dry-run': () => dry, shopee: () => bad, tiktokshop: () => good } });
    svc = createMarketplaceService(ctx.app.config, { store: ctx.store, registry, logger: null });
    // Chốt 0 mạng: mọi fetch ra ngoài đều nổ — nếu dry-run chạm mạng, test dưới hỏng ngay.
    globalThis.fetch = async (url) => { throw new Error(`KHÔNG ĐƯỢC GỌI MẠNG: ${url}`); };
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await ctx.close();
  });

  test('tạo → duyệt → đăng (dry) → đồng bộ: có vết đầy đủ, 0 lời gọi mạng, external_id tiền tố dry-', async () => {
    const job = await ctx.store.getJob(jobId);
    const created = await svc.createListing({ job, userId: user.id, channel: 'dry-run', overrides: FULL });
    assert.equal(created.listing.status, 'pending_review');
    assert.equal(created.idempotent, false);
    await assert.rejects(svc.publish({ id: created.listing.id, requesterId: user.id }), (e) => e.code === 'NOT_APPROVED');
    assert.equal(dry.calls.length, 0, 'chưa duyệt ⇒ provider KHÔNG được gọi');
    const approved = await svc.approve({ id: created.listing.id, actorId: user.id });
    assert.equal(approved.status, 'approved');
    const pub = await svc.publish({ id: created.listing.id, requesterId: user.id });
    assert.equal(pub.called, true);
    assert.equal(pub.listing.status, 'published');
    assert.match(pub.listing.external_id, /^dry-[0-9a-f]{16}$/);
    assert.equal(pub.listing.is_mock, true);
    assert.equal(pub.listing.external_url, null, 'không bịa link');
    const sync = await svc.sync({ id: created.listing.id, requesterId: user.id });
    assert.equal(sync.snapshot.price, 199000);
    assert.equal(sync.snapshot.is_mock, true);
    const events = await svc.events(created.listing.id);
    assert.deepEqual(events.map((e) => e.kind), ['created', 'approved', 'publish_started', 'published', 'synced']);
    assert.ok(events.every((e, i) => e.seq === i + 1), 'seq tăng dần');
  });

  test('đăng lần hai cùng listing ⇒ idempotent, provider KHÔNG được gọi thêm', async () => {
    const job = await ctx.store.getJob(jobId);
    const { listing } = await svc.createListing({ job, userId: user.id, channel: 'dry-run', overrides: FULL });
    const before = dry.calls.filter((c) => c.op === 'createListing').length;
    const again = await svc.publish({ id: listing.id, requesterId: user.id });
    assert.equal(again.idempotent, true);
    assert.equal(again.called, false);
    assert.equal(dry.calls.filter((c) => c.op === 'createListing').length, before);
  });

  test('tạo lần hai cùng (job, kênh, run_key) ⇒ CÙNG MỘT bản ghi (idempotent=true), đếm DB = 1', async () => {
    const job = await ctx.store.getJob(jobId);
    const a = await svc.createListing({ job, userId: user.id, channel: 'tiktokshop', overrides: FULL, runKey: 'rk-1' });
    const b = await svc.createListing({ job, userId: user.id, channel: 'tiktokshop', overrides: FULL, runKey: 'rk-1' });
    assert.equal(a.listing.id, b.listing.id);
    assert.equal(b.idempotent, true);
    assert.equal(await ctx.store.countMarketplaceListings({ jobId, channel: 'tiktokshop' }), 1);
  });

  test('cô lập lỗi: sàn A trả lỗi ⇒ chỉ listing A `failed` (lỗi giữ nguyên văn), listing B trên sàn B vẫn đăng được', async () => {
    const job = await ctx.store.getJob(jobId);
    const la = (await svc.createListing({ job, userId: user.id, channel: 'shopee', overrides: FULL, runKey: 'iso-a' })).listing;
    const lb = (await svc.createListing({ job, userId: user.id, channel: 'tiktokshop', overrides: FULL, runKey: 'iso-b' })).listing;
    await svc.approve({ id: la.id, actorId: user.id });
    await svc.approve({ id: lb.id, actorId: user.id });
    await assert.rejects(svc.publish({ id: la.id, requesterId: user.id }), (e) => {
      assert.equal(e.code, 'MARKETPLACE_ERROR');
      assert.match(e.details.raw.body, /error_param/, 'nguyên văn của sàn còn nguyên');
      assert.equal(e.details.channel, 'shopee');
      return true;
    });
    const fa = await ctx.store.getMarketplaceListing(la.id);
    assert.equal(fa.status, 'failed');
    assert.equal(fa.error_code, 'MARKETPLACE_ERROR');
    assert.match(fa.last_error, /invalid category/);
    assert.equal(fa.attempts, 1);
    const pb = await svc.publish({ id: lb.id, requesterId: user.id });
    assert.equal(pb.listing.status, 'published');
    assert.equal(pb.listing.external_id, 'tiktokshop-123');
    assert.equal(pb.listing.is_mock, false);
    // Thử lại listing A: `failed` được claim lại cho tới trần attempts, rồi dừng (không spam sàn).
    await assert.rejects(svc.publish({ id: la.id, requesterId: user.id }), (e) => e.code === 'MARKETPLACE_ERROR');
    await assert.rejects(svc.publish({ id: la.id, requesterId: user.id }), (e) => e.code === 'MARKETPLACE_ERROR');
    await assert.rejects(svc.publish({ id: la.id, requesterId: user.id }), (e) => e.code === 'ATTEMPTS_EXCEEDED');
    assert.equal(bad.calls.filter((c) => c.op === 'createListing').length, 3, 'đúng trần 3 lời gọi');
  });

  test('provider NÉM lỗi (không trả ListingResult) ⇒ vẫn thành `failed` có mã, không treo, không nuốt', async () => {
    const job = await ctx.store.getJob(jobId);
    const thrower = fakeChannel('shopee', 'throw');
    const registry = createMarketplaceRegistry({}, { factories: { 'dry-run': () => dry, shopee: () => thrower, tiktokshop: () => good } });
    const svc2 = createMarketplaceService(ctx.app.config, { store: ctx.store, registry });
    const l = (await svc2.createListing({ job, userId: user.id, channel: 'shopee', overrides: FULL, runKey: 'throw-1' })).listing;
    await svc2.approve({ id: l.id, actorId: user.id });
    await assert.rejects(svc2.publish({ id: l.id, requesterId: user.id }), (e) => e.code === 'MARKETPLACE_ERROR' && /nổ/.test(e.message));
    assert.equal((await ctx.store.getMarketplaceListing(l.id)).status, 'failed');
  });

  test('từ chối cần lý do; từ chối xong thì KHÔNG đăng được; khác chủ ⇒ LISTING_NOT_FOUND', async () => {
    const job = await ctx.store.getJob(jobId);
    const l = (await svc.createListing({ job, userId: user.id, channel: 'dry-run', overrides: FULL, runKey: 'rej-1' })).listing;
    await assert.rejects(svc.reject({ id: l.id, actorId: user.id, reason: '  ' }), (e) => e.code === 'REASON_REQUIRED');
    const r = await svc.reject({ id: l.id, actorId: user.id, reason: 'mô tả chưa đúng' });
    assert.equal(r.status, 'rejected');
    await assert.rejects(svc.publish({ id: l.id, requesterId: user.id }), (e) => e.code === 'NOT_APPROVED');
    await assert.rejects(svc.get({ id: l.id, requesterId: 'nguoi-khac' }), (e) => e.code === 'LISTING_NOT_FOUND');
    assert.equal(await ctx.store.claimMarketplaceListing(l.id), null, 'cổng DB: rejected không claim được');
  });

  test('preflight chặn ⇒ KHÔNG tạo bản ghi nào', async () => {
    const job = await ctx.store.getJob(jobId);
    const n = await ctx.store.countMarketplaceListings({ jobId });
    await assert.rejects(svc.createListing({ job, userId: user.id, channel: 'dry-run', overrides: {}, runKey: 'pf-1' }), (e) => {
      assert.equal(e.code, 'PREFLIGHT_FAILED');
      assert.ok(e.details.issues.some((i) => i.field === 'price_vnd'));
      return true;
    });
    assert.equal(await ctx.store.countMarketplaceListings({ jobId }), n);
  });
});

describe('MVP-08 · provider thật — fail-closed, không chạm mạng khi chưa đủ điều kiện', () => {
  const boom = async (url) => { throw new Error(`KHÔNG ĐƯỢC GỌI MẠNG: ${url}`); };

  test('shopee/tiktokshop thiếu token ⇒ configured=false, createListing/readListing trả NOT_CONFIGURED (fetch không được gọi)', async () => {
    for (const make of [createShopeeProvider, createTiktokShopProvider]) {
      const p = make({ marketplace: { liveEnabled: true } }, { fetchImpl: boom });
      assert.equal(p.configured, false);
      assert.match(p.notice, /chưa có token/);
      const r = await p.createListing({ item_name: 'x' });
      assert.equal(r.status, 'failed');
      assert.equal(r.error_code, 'NOT_CONFIGURED');
      assert.equal((await p.readListing('1')).error_code, 'NOT_CONFIGURED');
      assert.equal((await p.probe()).ok, false);
    }
  });

  test('đủ token nhưng liveEnabled=false (mặc định) ⇒ LIVE_DISABLED, fetch không được gọi', async () => {
    const cfg = {
      marketplace: {
        liveEnabled: false,
        shopee: { partnerId: '1', partnerKey: 'k', shopId: '2', accessToken: 't' },
        tiktokshop: { appKey: 'a', appSecret: 's', shopCipher: 'c', accessToken: 't' },
      },
    };
    for (const make of [createShopeeProvider, createTiktokShopProvider]) {
      const p = make(cfg, { fetchImpl: boom });
      assert.equal(p.configured, true);
      const r = await p.createListing({});
      assert.equal(r.error_code, 'LIVE_DISABLED');
    }
  });

  test('live bật + URL gốc không phải https/host sàn ⇒ BAD_BASE_URL (chống SSRF), fetch không được gọi', async () => {
    const p = createShopeeProvider({ marketplace: { liveEnabled: true, shopee: { partnerId: '1', partnerKey: 'k', shopId: '2', accessToken: 't', baseUrl: 'http://127.0.0.1:9' } } }, { fetchImpl: boom });
    assert.equal((await p.createListing({})).error_code, 'BAD_BASE_URL');
  });

  test('Shopee live + fetch giả: phản hồi OK ⇒ published + item_id; `error` ⇒ MARKETPLACE_ERROR giữ nguyên văn; bí mật bị che; trường _vps_ bị bỏ', async () => {
    const seen = [];
    const fetchImpl = async (url, opts) => {
      seen.push({ url: String(url), body: JSON.parse(opts.body) });
      const text = seen.length === 1
        ? JSON.stringify({ error: '', message: '', response: { item_id: 987 } })
        : JSON.stringify({ error: 'error_param', message: 'weight invalid; token=SECRET-TOKEN-1234' });
      return { ok: true, status: 200, text: async () => text };
    };
    const p = createShopeeProvider({ marketplace: { liveEnabled: true, shopee: { partnerId: '1', partnerKey: 'k', shopId: '2', accessToken: 'SECRET-TOKEN-1234' } } }, { fetchImpl });
    const ok = await p.createListing({ item_name: 'x', _vps_image_urls: ['https://a'] });
    assert.equal(ok.status, 'published');
    assert.equal(ok.external_id, '987');
    assert.match(seen[0].url, /partner_id=1&timestamp=\d+&sign=[0-9a-f]{64}&access_token=SECRET-TOKEN-1234&shop_id=2/);
    assert.equal('_vps_image_urls' in seen[0].body, false, 'trường nội bộ không được gửi đi');
    const bad = await p.createListing({ item_name: 'y' });
    assert.equal(bad.status, 'failed');
    assert.equal(bad.error_code, 'MARKETPLACE_ERROR');
    assert.match(bad.error_message, /error_param/);
    assert.ok(!bad.raw.body.includes('SECRET-TOKEN-1234'), 'token bị che trong raw');
    assert.ok(bad.raw.body.includes('***'));
  });

  test('TikTok live + fetch giả: code 0 ⇒ published + product_id, url null (không bịa); code ≠ 0 ⇒ failed', async () => {
    let n = 0;
    const fetchImpl = async (url, opts) => {
      n += 1;
      assert.equal(opts.headers['x-tts-access-token'], 'tok');
      assert.match(String(url), /app_key=a&timestamp=\d+&shop_cipher=c&sign=[0-9a-f]{64}/);
      const text = n === 1 ? JSON.stringify({ code: 0, message: 'Success', data: { product_id: 'p1' } }) : JSON.stringify({ code: 12052901, message: 'category invalid' });
      return { ok: true, status: 200, text: async () => text };
    };
    const p = createTiktokShopProvider({ marketplace: { liveEnabled: true, tiktokshop: { appKey: 'a', appSecret: 's', shopCipher: 'c', accessToken: 'tok' } } }, { fetchImpl });
    const ok = await p.createListing({ title: 'x' });
    assert.equal(ok.status, 'published');
    assert.equal(ok.external_id, 'p1');
    assert.equal(ok.url, null);
    const bad = await p.createListing({ title: 'y' });
    assert.equal(bad.status, 'failed');
    assert.match(bad.error_message, /12052901/);
  });

  test('lỗi vận chuyển (fetch ném) ⇒ failed với mã TIMEOUT/MARKETPLACE_ERROR, không ném ra ngoài', async () => {
    const p = createTiktokShopProvider({ marketplace: { liveEnabled: true, tiktokshop: { appKey: 'a', appSecret: 's', shopCipher: 'c', accessToken: 'tok' } } }, { fetchImpl: async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); } });
    const r = await p.createListing({ title: 'x' });
    assert.equal(r.status, 'failed');
    assert.match(r.error_message, /socket hang up/);
  });
});
