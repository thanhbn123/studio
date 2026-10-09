/**
 * TEST MVP-07 · P3 — API ĐĂNG BÀI (`src/http/routes.js`), hợp đồng §4.
 *
 * App THẬT + server thật trên 127.0.0.1 + SQLite in-memory (như `test/export-api.test.js`).
 *
 * Phủ: 8 route mới · bắt buộc đăng nhập (ẩn danh ⇒ 401) · IDOR (bài người khác ⇒ 404) ·
 * `member` gọi approve ⇒ 403 · **chưa duyệt ⇒ 409 NOT_APPROVED và provider 0 lời gọi** ·
 * duyệt ⇒ 1 lời gọi · gọi publish 2 lần ⇒ vẫn 1 lời gọi (`called: false`, `idempotent: true`) ·
 * `/api/config.publish` · vết `publish_logs` trả qua API · 503 khi khối publish bị tắt.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  countingProvider,
  j,
  makePublishService,
  makeOwner,
  publishConfig,
  register,
  request,
  seedContentJob,
  startPublishApp,
} from './publish-helpers.js';

const UNKNOWN_ITEM = '00000000-0000-4000-8000-00000000dead';

/** Dựng app với provider ĐẾM được bơm vào, trả cả ctx lẫn provider để soi `calls`. */
async function startWithCountingProvider(opts = {}) {
  const provider = countingProvider(opts);
  // `publishService` phải dùng CHÍNH store của app ⇒ dựng app trước rồi thay service.
  const ctx = await startPublishApp({ publishProvider: provider });
  ctx.app.publishProvider = provider;
  ctx.app.publishService = await makePublishService(ctx.store, provider, { config: publishConfig() });
  return { ctx, provider };
}

/** Đăng ký một tài khoản + tạo job thật của tài khoản đó. */
async function withUser(ctx, email, { owner = false } = {}) {
  const { body, jar } = await register(ctx.base, { email });
  const userId = body?.user?.id;
  assert.ok(userId, `đăng ký ${email} phải trả về user.id`);
  if (owner) await makeOwner(ctx.store, userId);
  const job = await seedContentJob(ctx.store, { userId });
  return { userId, jar, job };
}

/* ══════════════════ /api/config ══════════════════ */

describe('MVP-07 API — /api/config khối `publish` (§4)', () => {
  let ctx;

  before(async () => {
    ctx = await startPublishApp();
  });

  after(async () => {
    await ctx.close();
  });

  test('mặc định: available, provider `dry-run`, is_mock = true, duyệt tay BẮT BUỘC', async () => {
    const cfg = await j(await fetch(`${ctx.base}/api/config`));
    assert.equal(cfg.publish.available, true);
    assert.equal(cfg.publish.enabled, true);
    assert.equal(cfg.publish.channel, 'facebook_page');
    assert.equal(cfg.publish.manual_approval_required, true, 'UI phải biết hệ thống KHÔNG BAO GIỜ tự đăng');
    assert.equal(cfg.publish.provider.name, 'dry-run');
    assert.equal(cfg.publish.provider.is_mock, true);
    assert.deepEqual(cfg.publish.statuses, ['draft', 'pending_review', 'approved', 'publishing', 'published', 'failed', 'rejected']);
    assert.equal(typeof cfg.publish.limits.max_text_length, 'number');
  });

  test('KHÔNG lộ token/Page ID trong /api/config', async () => {
    const text = await (await fetch(`${ctx.base}/api/config`)).text();
    assert.ok(!/access_token/i.test(text), '/api/config không được chứa access_token');
    assert.ok(!/page_id/i.test(text), '/api/config không được trả page_id');
  });
});

/* ══════════════════ bắt buộc đăng nhập ══════════════════ */

describe('MVP-07 API — ẩn danh ⇒ 401 cho MỌI route (§4)', () => {
  let ctx;

  before(async () => {
    ctx = await startPublishApp();
  });

  after(async () => {
    await ctx.close();
  });

  test('tất cả 8 route đều 401 UNAUTHENTICATED khi không đăng nhập', async () => {
    const calls = [
      ['GET', '/api/publish/items'],
      ['GET', `/api/publish/items/${UNKNOWN_ITEM}`],
      ['POST', '/api/publish/items'],
      ['POST', `/api/publish/items/${UNKNOWN_ITEM}/submit`],
      ['POST', `/api/publish/items/${UNKNOWN_ITEM}/approve`],
      ['POST', `/api/publish/items/${UNKNOWN_ITEM}/reject`],
      ['POST', `/api/publish/items/${UNKNOWN_ITEM}/publish`],
      ['GET', '/api/publish/provider'],
    ];
    for (const [method, path] of calls) {
      const res = await request(ctx.base, path, { method, ...(method === 'POST' ? { body: {} } : {}) });
      assert.equal(res.status, 401, `${method} ${path} phải trả 401, nhận ${res.status}`);
      assert.equal((await j(res))?.error?.code, 'UNAUTHENTICATED');
    }
  });
});

/* ══════════════════ cổng duyệt qua HTTP (điều kiện XONG 1/2/3) ══════════════════ */

describe('MVP-07 API — cổng duyệt qua HTTP (§6 điều kiện 1/2/3)', () => {
  let ctx;
  let provider;
  let owner;

  before(async () => {
    ({ ctx, provider } = await startWithCountingProvider());
    owner = await withUser(ctx, 'owner-publish-api@example.com', { owner: true });
  });

  after(async () => {
    await ctx.close();
  });

  test('tạo bài ⇒ 201 và status `draft` (KHÔNG BAO GIỜ `approved`)', async () => {
    const res = await request(ctx.base, '/api/publish/items', { method: 'POST', body: { job_id: owner.job.id }, jar: owner.jar });
    assert.equal(res.status, 201);
    const body = await j(res);
    assert.equal(body.item.status, 'draft');
    assert.equal(body.item.approved_by, null);
    assert.equal(body.item.attempts, 0);
    assert.match(body.item.text, /Tiêu đề bán hàng thử/, 'text rỗng ⇒ lấy gợi ý từ nội dung job');
    // Phản hồi KHÔNG được lộ session/chủ sở hữu.
    assert.equal(body.item.user_id, undefined, 'API không trả user_id');
    assert.equal(body.item.session_id, undefined);
  });

  test('thiếu `job_id` ⇒ 400; job id rác ⇒ 400; job của người khác ⇒ 404', async () => {
    const miss = await request(ctx.base, '/api/publish/items', { method: 'POST', body: {}, jar: owner.jar });
    assert.equal(miss.status, 400);
    const bad = await request(ctx.base, '/api/publish/items', { method: 'POST', body: { job_id: '!!!' }, jar: owner.jar });
    assert.equal(bad.status, 400);

    const other = await withUser(ctx, 'other-job-owner@example.com');
    const foreign = await request(ctx.base, '/api/publish/items', { method: 'POST', body: { job_id: other.job.id }, jar: owner.jar });
    assert.equal(foreign.status, 404, 'tạo bài từ job của người khác phải 404');
  });

  test('CHƯA DUYỆT ⇒ POST …/publish trả 409 NOT_APPROVED và provider.calls KHÔNG tăng', async () => {
    const before = provider.calls.length;
    const created = await j(await request(ctx.base, '/api/publish/items', { method: 'POST', body: { job_id: owner.job.id, submit: true }, jar: owner.jar }));
    assert.equal(created.item.status, 'pending_review');

    const res = await request(ctx.base, `/api/publish/items/${created.item.id}/publish`, { method: 'POST', body: {}, jar: owner.jar });
    assert.equal(res.status, 409);
    const body = await j(res);
    assert.equal(body.error.code, 'NOT_APPROVED');
    assert.match(body.error.message, /CHƯA được duyệt/);
    assert.equal(provider.calls.length, before, 'bài chưa duyệt ⇒ 0 lời gọi provider');

    // Trạng thái bài không bị đổi, không tăng attempts.
    const after = await j(await request(ctx.base, `/api/publish/items/${created.item.id}`, { jar: owner.jar }));
    assert.equal(after.item.status, 'pending_review');
    assert.equal(after.item.attempts, 0);
    assert.equal(after.logs.length, 0, 'không gọi provider ⇒ không có dòng vết');
  });

  test('DUYỆT ⇒ đăng được: 1 lời gọi provider, status `published`, 1 dòng vết', async () => {
    const before = provider.calls.length;
    const created = await j(await request(ctx.base, '/api/publish/items', { method: 'POST', body: { job_id: owner.job.id, submit: true }, jar: owner.jar }));

    const approved = await request(ctx.base, `/api/publish/items/${created.item.id}/approve`, { method: 'POST', body: {}, jar: owner.jar });
    assert.equal(approved.status, 200);
    const approvedBody = await j(approved);
    assert.equal(approvedBody.item.status, 'approved');
    assert.equal(approvedBody.item.approved_by, owner.userId, 'phải ghi ĐÚNG ai đã duyệt');

    const res = await request(ctx.base, `/api/publish/items/${created.item.id}/publish`, { method: 'POST', body: {}, jar: owner.jar });
    assert.equal(res.status, 200);
    const body = await j(res);
    assert.equal(body.called, true);
    assert.equal(body.idempotent, false);
    assert.equal(body.item.status, 'published');
    assert.ok(body.result.post_id);
    assert.equal(provider.calls.length, before + 1, 'ĐÚNG một lời gọi provider');

    const detail = await j(await request(ctx.base, `/api/publish/items/${created.item.id}`, { jar: owner.jar }));
    assert.equal(detail.logs.length, 1);
    assert.equal(detail.logs[0].status, 'PUBLISHED');
  });

  test('ĐĂNG HAI LẦN ⇒ provider vẫn 1 lời gọi, lần hai `called: false` + `idempotent: true`', async () => {
    const before = provider.calls.length;
    const created = await j(await request(ctx.base, '/api/publish/items', { method: 'POST', body: { job_id: owner.job.id, submit: true }, jar: owner.jar }));
    await request(ctx.base, `/api/publish/items/${created.item.id}/approve`, { method: 'POST', body: {}, jar: owner.jar });

    const first = await j(await request(ctx.base, `/api/publish/items/${created.item.id}/publish`, { method: 'POST', body: {}, jar: owner.jar }));
    const secondRes = await request(ctx.base, `/api/publish/items/${created.item.id}/publish`, { method: 'POST', body: {}, jar: owner.jar });
    assert.equal(secondRes.status, 200, 'đăng lại bài đã đăng KHÔNG phải lỗi — chỉ là không làm gì');
    const second = await j(secondRes);

    assert.equal(provider.calls.length, before + 1, `hai lần bấm đăng chỉ được gọi provider 1 lần (đo: ${provider.calls.length - before})`);
    assert.equal(first.called, true);
    assert.equal(second.called, false);
    assert.equal(second.idempotent, true);
    assert.equal(second.result.post_id, first.result.post_id);
    assert.equal((await j(await request(ctx.base, `/api/publish/items/${created.item.id}`, { jar: owner.jar }))).logs.length, 1);
  });

  test('TỪ CHỐI ⇒ bài `rejected`, đăng vào ⇒ 409 ITEM_REJECTED, provider 0 lời gọi', async () => {
    const before = provider.calls.length;
    const created = await j(await request(ctx.base, '/api/publish/items', { method: 'POST', body: { job_id: owner.job.id, submit: true }, jar: owner.jar }));
    const rejected = await j(await request(ctx.base, `/api/publish/items/${created.item.id}/reject`, { method: 'POST', body: { reason: 'câu chữ sai' }, jar: owner.jar }));
    assert.equal(rejected.item.status, 'rejected');
    assert.equal(rejected.item.reject_reason, 'câu chữ sai');
    const res = await request(ctx.base, `/api/publish/items/${created.item.id}/publish`, { method: 'POST', body: {}, jar: owner.jar });
    assert.equal(res.status, 409);
    assert.equal((await j(res)).error.code, 'ITEM_REJECTED');
    assert.equal(provider.calls.length, before);
  });

  test('GỬI DUYỆT: draft → pending_review; gửi lần hai ⇒ 409 BAD_STATE', async () => {
    const created = await j(await request(ctx.base, '/api/publish/items', { method: 'POST', body: { job_id: owner.job.id }, jar: owner.jar }));
    const sent = await j(await request(ctx.base, `/api/publish/items/${created.item.id}/submit`, { method: 'POST', body: {}, jar: owner.jar }));
    assert.equal(sent.item.status, 'pending_review');
    const again = await request(ctx.base, `/api/publish/items/${created.item.id}/submit`, { method: 'POST', body: {}, jar: owner.jar });
    assert.equal(again.status, 409);
    assert.equal((await j(again)).error.code, 'BAD_STATE');
  });

  test('bài không tồn tại ⇒ 404; mã bài rác ⇒ 400', async () => {
    assert.equal((await request(ctx.base, `/api/publish/items/${UNKNOWN_ITEM}/publish`, { method: 'POST', body: {}, jar: owner.jar })).status, 404);
    assert.equal((await request(ctx.base, '/api/publish/items/!!!/publish', { method: 'POST', body: {}, jar: owner.jar })).status, 400);
  });

  test('`GET /api/publish/provider` (owner) trả provider + probe, không token', async () => {
    const res = await request(ctx.base, '/api/publish/provider', { jar: owner.jar });
    assert.equal(res.status, 200);
    const body = await j(res);
    assert.equal(body.provider.name, 'fake-publish');
    assert.equal(typeof body.probe.ok, 'boolean');
    assert.ok(!JSON.stringify(body).includes('access_token'));
  });

  test('status lọc sai ⇒ 400 BAD_STATUS (không im lặng trả rỗng)', async () => {
    const res = await request(ctx.base, '/api/publish/items?status=da_dang', { jar: owner.jar });
    assert.equal(res.status, 400);
    assert.equal((await j(res)).error.code, 'BAD_STATUS');
  });
});

/* ══════════════════ phân quyền: member vs owner ══════════════════ */

describe('MVP-07 API — phân quyền duyệt + IDOR (§4)', () => {
  let ctx;
  let provider;
  let member;
  let other;
  let owner;

  before(async () => {
    ({ ctx, provider } = await startWithCountingProvider());
    member = await withUser(ctx, 'member-publish@example.com');
    other = await withUser(ctx, 'other-publish@example.com');
    owner = await withUser(ctx, 'owner2-publish@example.com', { owner: true });
  });

  after(async () => {
    await ctx.close();
  });

  test('`member` gọi approve ⇒ 403 FORBIDDEN, provider 0 lời gọi', async () => {
    const before = provider.calls.length;
    const created = await j(await request(ctx.base, '/api/publish/items', { method: 'POST', body: { job_id: member.job.id, submit: true }, jar: member.jar }));
    const res = await request(ctx.base, `/api/publish/items/${created.item.id}/approve`, { method: 'POST', body: {}, jar: member.jar });
    assert.equal(res.status, 403);
    assert.equal((await j(res)).error.code, 'FORBIDDEN');
    assert.equal(provider.calls.length, before);
  });

  test('`member` gọi reject ⇒ 403 FORBIDDEN', async () => {
    const created = await j(await request(ctx.base, '/api/publish/items', { method: 'POST', body: { job_id: member.job.id, submit: true }, jar: member.jar }));
    assert.equal((await request(ctx.base, `/api/publish/items/${created.item.id}/reject`, { method: 'POST', body: {}, jar: member.jar })).status, 403);
  });

  test('`member` gọi /api/publish/provider ⇒ 403', async () => {
    assert.equal((await request(ctx.base, '/api/publish/provider', { jar: member.jar })).status, 403);
  });

  test('IDOR: bài của người khác ⇒ 404 cho member (mọi route)', async () => {
    const created = await j(await request(ctx.base, '/api/publish/items', { method: 'POST', body: { job_id: member.job.id, submit: true }, jar: member.jar }));
    for (const [method, suffix] of [['GET', ''], ['POST', '/submit'], ['POST', '/publish']]) {
      const res = await request(ctx.base, `/api/publish/items/${created.item.id}${suffix}`, { method, ...(method === 'POST' ? { body: {} } : {}), jar: other.jar });
      assert.equal(res.status, 404, `${method} …${suffix} từ tài khoản khác phải 404`);
      assert.equal((await j(res)).error.code, 'ITEM_NOT_FOUND');
    }
  });

  test('danh sách: member CHỈ thấy bài của mình (`scope: mine`, `can_approve: false`)', async () => {
    await request(ctx.base, '/api/publish/items', { method: 'POST', body: { job_id: other.job.id }, jar: other.jar });
    const mine = await j(await request(ctx.base, '/api/publish/items', { jar: member.jar }));
    assert.equal(mine.scope, 'mine');
    assert.equal(mine.can_approve, false);
    assert.ok(mine.items.length > 0);
    const otherList = await j(await request(ctx.base, '/api/publish/items', { jar: other.jar }));
    const mineIds = new Set(mine.items.map((i) => i.id));
    for (const it of otherList.items) assert.equal(mineIds.has(it.id), false, 'danh sách không được trộn bài hai tài khoản');
  });

  test('owner/admin thấy TOÀN BỘ hàng đợi duyệt (`scope: all`, `can_approve: true`)', async () => {
    const all = await j(await request(ctx.base, '/api/publish/items', { jar: owner.jar }));
    assert.equal(all.scope, 'all');
    assert.equal(all.can_approve, true);
    const mine = await j(await request(ctx.base, '/api/publish/items', { jar: member.jar }));
    assert.ok(all.total >= mine.total, 'hàng đợi của owner phải bao gồm bài của member');
  });

  test('owner DUYỆT được bài của member, và member đăng được sau khi đã duyệt', async () => {
    const before = provider.calls.length;
    const created = await j(await request(ctx.base, '/api/publish/items', { method: 'POST', body: { job_id: member.job.id, submit: true }, jar: member.jar }));
    const approved = await j(await request(ctx.base, `/api/publish/items/${created.item.id}/approve`, { method: 'POST', body: {}, jar: owner.jar }));
    assert.equal(approved.item.status, 'approved');
    assert.equal(approved.item.approved_by, owner.userId);
    const res = await j(await request(ctx.base, `/api/publish/items/${created.item.id}/publish`, { method: 'POST', body: {}, jar: member.jar }));
    assert.equal(res.called, true);
    assert.equal(res.item.status, 'published');
    assert.equal(provider.calls.length, before + 1);
  });

  test('lọc theo trạng thái trả đúng tập (hàng đợi "chờ duyệt" của owner)', async () => {
    const created = await j(await request(ctx.base, '/api/publish/items', { method: 'POST', body: { job_id: member.job.id, submit: true }, jar: member.jar }));
    const pending = await j(await request(ctx.base, '/api/publish/items?status=pending_review', { jar: owner.jar }));
    assert.ok(pending.items.some((i) => i.id === created.item.id));
    for (const it of pending.items) assert.equal(it.status, 'pending_review');
  });
});

/* ══════════════════ provider `facebook` chưa cấu hình, qua HTTP ══════════════════ */

describe('MVP-07 API — provider `facebook` CHƯA có token (ca THẬT của sprint này)', () => {
  let ctx;
  let owner;

  before(async () => {
    ctx = await startPublishApp({ configOverrides: { PUBLISH_PROVIDER: 'facebook' } });
    owner = await withUser(ctx, 'owner-fb-notoken@example.com', { owner: true });
  });

  after(async () => {
    await ctx.close();
  });

  test('/api/config nói THẬT: provider `facebook`, configured = false, is_mock = false', async () => {
    const cfg = await j(await fetch(`${ctx.base}/api/config`));
    assert.equal(cfg.publish.provider.name, 'facebook');
    assert.equal(cfg.publish.provider.configured, false);
    assert.equal(cfg.publish.provider.is_mock, false, 'provider thật KHÔNG được tự nhận là mock');
    assert.match(cfg.publish.provider.notice, /Page ID/);
  });

  test('bài đã duyệt nhưng thiếu token ⇒ bài sang `failed` + NOT_CONFIGURED, KHÔNG bịa post_id', async () => {
    const created = await j(await request(ctx.base, '/api/publish/items', { method: 'POST', body: { job_id: owner.job.id, submit: true }, jar: owner.jar }));
    await request(ctx.base, `/api/publish/items/${created.item.id}/approve`, { method: 'POST', body: {}, jar: owner.jar });
    const body = await j(await request(ctx.base, `/api/publish/items/${created.item.id}/publish`, { method: 'POST', body: {}, jar: owner.jar }));
    assert.equal(body.result.status, 'NOT_CONFIGURED');
    assert.equal(body.result.post_id, null, 'KHÔNG BAO GIỜ bịa mã bài khi chưa cấu hình');
    assert.equal(body.item.status, 'failed');
    assert.equal(body.item.external_post_id, null);
    assert.match(body.item.last_error, /Page ID/);
  });
});

/* ══════════════════ khối publish bị TẮT ⇒ 503 nói thẳng ══════════════════ */

describe('MVP-07 API — khối đăng bài bị TẮT (§4)', () => {
  test('PUBLISH_ENABLED=false ⇒ /api/config.available = false và route trả 503', async () => {
    const ctx = await startPublishApp({ configOverrides: { PUBLISH_ENABLED: 'false' } });
    try {
      const cfg = await j(await fetch(`${ctx.base}/api/config`));
      assert.equal(cfg.publish.available, false);
      assert.equal(cfg.publish.enabled, false);
      assert.ok(String(cfg.publish.reason || '').length > 0, 'phải nói LÝ DO thật, không im lặng');

      const { jar } = await register(ctx.base, { email: 'owner-publish-off@example.com' });
      const res = await request(ctx.base, '/api/publish/items', { jar });
      assert.equal(res.status, 503);
      assert.equal((await j(res)).error.code, 'PUBLISH_UNAVAILABLE');
    } finally {
      await ctx.close();
    }
  });

  test('`app.publishService = null` (module nạp lỗi) ⇒ 503, server vẫn sống', async () => {
    const ctx = await startPublishApp();
    try {
      ctx.app.publishService = null;
      ctx.app.publishUnavailableReason = 'Không nạp được module MVP-07 (mô phỏng trong test).';
      const { jar } = await register(ctx.base, { email: 'owner-publish-broken@example.com' });
      const res = await request(ctx.base, '/api/publish/items', { jar });
      assert.equal(res.status, 503);
      const body = await j(res);
      assert.equal(body.error.code, 'PUBLISH_UNAVAILABLE');
      assert.match(body.error.message, /mô phỏng trong test/, 'phải trả LÝ DO THẬT, không câu chung chung');
      // MVP-01 vẫn chạy bình thường.
      assert.equal((await fetch(`${ctx.base}/api/health`)).status, 200);
    } finally {
      await ctx.close();
    }
  });
});
