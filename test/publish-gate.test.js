/**
 * TEST MVP-07 · CỔNG DUYỆT + IDEMPOTENCY (`src/publish/service.js` + `src/store/index.js`).
 *
 * Đây là bộ test QUAN TRỌNG NHẤT của sprint — nó kiểm đúng ba điều kiện "XONG" số 1/2/3:
 *
 *   1. **Không duyệt ⇒ KHÔNG gọi provider.** Đo bằng `countingProvider().calls.length === 0`,
 *      không phải bằng "đọc mã thấy có if".
 *   2. **Duyệt ⇒ gọi provider đúng 1 lần**, bài sang `published`, có 1 dòng `publish_logs`.
 *   3. **Gọi publish 2 lần ⇒ provider vẫn 1 lời gọi**, lần hai trả `idempotent: true`.
 *
 * Dùng store THẬT (SQLite in-memory) để cổng duyệt được kiểm ở ĐÚNG tầng nó sống: câu
 * `UPDATE … WHERE status IN ('approved','failed')` trong `Store#claimPublishItem`.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createStore } from '../src/store/index.js';
import { PublishService, PUBLISH_CODES } from '../src/publish/index.js';
import { testConfig, silent } from './helpers.js';
import { countingProvider, publishConfig, seedContentJob, withoutNetwork } from './publish-helpers.js';

const USER_A = 'user-a-publish';
const USER_ADMIN = 'admin-publish';

async function makeStore() {
  return createStore(testConfig({ SQLITE_PATH: ':memory:' }), silent);
}

/** Dựng service + một bài nháp sẵn (status `pending_review`). */
async function fixture({ provider = countingProvider(), config = publishConfig() } = {}) {
  const store = await makeStore();
  const service = new PublishService({ store, provider, config, logger: silent });
  const job = await seedContentJob(store, { userId: USER_A });
  const { item } = await service.createItem({ job, userId: USER_A, text: 'Nội dung bài thử', submit: true });
  return { store, service, provider, job, item };
}

/* ══════════════ điều kiện 1 — chưa duyệt ⇒ 0 lời gọi provider ══════════════ */

describe('MVP-07 — CHƯA DUYỆT thì KHÔNG BAO GIỜ gọi provider (§6 điều kiện 1)', () => {
  test('bài `pending_review` ⇒ NOT_APPROVED và provider.calls = 0', async () => {
    const { service, provider, item, store } = await fixture();
    await assert.rejects(
      () => service.publishItem(item.id),
      (err) => {
        assert.equal(err.code, PUBLISH_CODES.NOT_APPROVED);
        assert.match(err.message, /CHƯA được duyệt/);
        return true;
      },
    );
    assert.equal(provider.calls.length, 0, 'provider KHÔNG được gọi khi bài chưa duyệt');
    // Bài KHÔNG được chuyển trạng thái, KHÔNG tăng `attempts` (claim đã thất bại trước đó).
    const after = await store.getPublishItem(item.id);
    assert.equal(after.status, 'pending_review');
    assert.equal(after.attempts, 0);
    assert.equal(after.external_post_id, null);
    assert.equal((await store.listPublishLogs(item.id)).length, 0, 'không gọi provider ⇒ không có dòng log nào');
    await store.close();
  });

  test('bài `draft` ⇒ NOT_APPROVED và provider.calls = 0', async () => {
    const store = await makeStore();
    const provider = countingProvider();
    const service = new PublishService({ store, provider, config: publishConfig(), logger: silent });
    const job = await seedContentJob(store, { userId: USER_A });
    const { item } = await service.createItem({ job, userId: USER_A, text: 'Bài nháp' });
    assert.equal(item.status, 'draft');
    await assert.rejects(() => service.publishItem(item.id), (e) => e.code === PUBLISH_CODES.NOT_APPROVED);
    assert.equal(provider.calls.length, 0);
    await store.close();
  });

  test('bài `rejected` ⇒ ITEM_REJECTED và provider.calls = 0', async () => {
    const { service, provider, item, store } = await fixture();
    await service.reject(item.id, { by: USER_ADMIN, reason: 'sai giá' });
    await assert.rejects(() => service.publishItem(item.id), (e) => e.code === PUBLISH_CODES.ITEM_REJECTED);
    assert.equal(provider.calls.length, 0);
    await store.close();
  });

  test('bài `publishing` (lượt khác đang giữ) ⇒ PUBLISH_IN_PROGRESS, provider.calls = 0', async () => {
    const { store, service, provider, item } = await fixture();
    await service.approve(item.id, { by: USER_ADMIN });
    // Giả lập một lượt khác đã claim xong và đang chạy.
    const claimed = await store.claimPublishItem(item.id, { provider: 'fake-publish' });
    assert.equal(claimed.status, 'publishing');
    await assert.rejects(() => service.publishItem(item.id), (e) => e.code === PUBLISH_CODES.PUBLISH_IN_PROGRESS);
    assert.equal(provider.calls.length, 0);
    await store.close();
  });

  test('KHÔNG có đường nào tạo ra bài `approved` ngay lúc tạo (kể cả submit = true)', async () => {
    const store = await makeStore();
    const service = new PublishService({ store, provider: countingProvider(), config: publishConfig(), logger: silent });
    const job = await seedContentJob(store, { userId: USER_A });
    const a = await service.createItem({ job, userId: USER_A, text: 'x', submit: false });
    const b = await service.createItem({ job, userId: USER_A, text: 'y', submit: true });
    assert.equal(a.item.status, 'draft');
    assert.equal(b.item.status, 'pending_review');
    assert.equal(a.item.approved_by, null);
    assert.equal(b.item.approved_by, null);
    await store.close();
  });

  test('`claimPublishItem` TỰ NÓ từ chối mọi trạng thái chưa duyệt (cổng ở tầng DB)', async () => {
    const store = await makeStore();
    const job = await seedContentJob(store, { userId: USER_A });
    for (const status of ['draft', 'pending_review', 'publishing', 'published', 'rejected']) {
      const item = await store.createPublishItem({ jobId: job.id, userId: USER_A, text: 'x', status });
      assert.equal(await store.claimPublishItem(item.id, { provider: 'p' }), null, `claim phải thất bại với status=${status}`);
    }
    // Ngược lại: `approved` thì claim được.
    const ok = await store.createPublishItem({ jobId: job.id, userId: USER_A, text: 'x', status: 'approved' });
    const claimed = await store.claimPublishItem(ok.id, { provider: 'p' });
    assert.equal(claimed.status, 'publishing');
    assert.equal(claimed.attempts, 1);
    assert.equal(claimed.run_key, `${ok.id}#1`, 'run_key phải mang danh tính lượt đăng');
    await store.close();
  });
});

/* ══════════════ điều kiện 2 — duyệt ⇒ gọi đúng 1 lần ══════════════ */

describe('MVP-07 — ĐÃ DUYỆT thì gọi provider đúng 1 lần (§6 điều kiện 2)', () => {
  test('approve → publish ⇒ 1 lời gọi, status `published`, 1 dòng log', async () => {
    const { store, service, provider, item } = await fixture();
    const approved = await service.approve(item.id, { by: USER_ADMIN });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approved_by, USER_ADMIN);
    assert.ok(approved.approved_at, 'phải ghi được thời điểm duyệt');

    const out = await service.publishItem(item.id);
    assert.equal(out.called, true);
    assert.equal(out.idempotent, false);
    assert.equal(provider.calls.length, 1, 'provider phải được gọi ĐÚNG một lần');
    assert.equal(provider.calls[0].text, 'Nội dung bài thử', 'provider nhận ĐÚNG nội dung đã duyệt');
    assert.equal(out.item.status, 'published');
    assert.equal(out.item.external_post_id, 'fake-post-1-1');
    assert.ok(out.item.published_at);
    assert.equal(out.item.attempts, 1);
    assert.equal(out.item.is_mock, true);

    const logs = await store.listPublishLogs(item.id);
    assert.equal(logs.length, 1, 'mỗi lời gọi provider phải có ĐÚNG một dòng vết');
    assert.equal(logs[0].status, 'PUBLISHED');
    assert.equal(logs[0].external_post_id, 'fake-post-1-1');
    assert.equal(logs[0].attempt, 1);
    assert.equal(logs[0].run_key, `${item.id}#1`);
    await store.close();
  });

  test('provider trả FAILED ⇒ bài sang `failed`, lỗi NGUYÊN VĂN được lưu, vẫn có vết', async () => {
    const provider = countingProvider({ status: 'FAILED', errorCode: 'PROVIDER_FAILED', errorMessage: '(#200) Permissions error — nguyên văn' });
    const { store, service, item } = await fixture({ provider });
    await service.approve(item.id, { by: USER_ADMIN });
    const out = await service.publishItem(item.id);
    assert.equal(out.called, true);
    assert.equal(out.item.status, 'failed');
    assert.equal(out.item.external_post_id, null, 'thất bại thì KHÔNG được ghi id bài');
    assert.equal(out.item.error_code, 'PROVIDER_FAILED');
    assert.equal(out.item.last_error, '(#200) Permissions error — nguyên văn');
    const logs = await store.listPublishLogs(item.id);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].error_message, '(#200) Permissions error — nguyên văn');
    await store.close();
  });

  test('`failed` được đăng LẠI (đã duyệt trước đó) và giữ `approved_by` cũ', async () => {
    const provider = countingProvider({ status: 'FAILED', errorCode: 'PROVIDER_FAILED', errorMessage: 'lỗi tạm' });
    const { store, service, item } = await fixture({ provider });
    await service.approve(item.id, { by: USER_ADMIN });
    await service.publishItem(item.id);
    const failed = await store.getPublishItem(item.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.approved_by, USER_ADMIN, 'lượt lỗi KHÔNG được xoá dấu vết đã duyệt');

    const out = await service.publishItem(item.id);
    assert.equal(out.called, true);
    assert.equal(provider.calls.length, 2, 'đăng lại là một lượt gọi THẬT mới');
    assert.equal(out.item.attempts, 2);
    assert.equal((await store.listPublishLogs(item.id)).length, 2);
    await store.close();
  });

  test('provider NÉM lỗi (vi phạm hợp đồng) ⇒ bài sang `failed`, KHÔNG mắc ở `publishing`', async () => {
    const provider = countingProvider({ fail: Object.assign(new Error('provider nổ'), { code: 'BOOM' }) });
    const { store, service, item } = await fixture({ provider });
    await service.approve(item.id, { by: USER_ADMIN });
    const out = await service.publishItem(item.id);
    assert.equal(out.item.status, 'failed');
    assert.equal(out.item.error_code, 'BOOM');
    await store.close();
  });

  test('provider `none` ⇒ PROVIDER_DISABLED và bài KHÔNG bị kẹt ở `publishing`', async () => {
    const { createNonePublishProvider } = await import('../src/publish/index.js');
    const store = await makeStore();
    const service = new PublishService({ store, provider: createNonePublishProvider({}), config: publishConfig({ provider: 'none' }), logger: silent });
    const job = await seedContentJob(store, { userId: USER_A });
    const { item } = await service.createItem({ job, userId: USER_A, text: 'x', submit: true });
    await service.approve(item.id, { by: USER_ADMIN });
    await assert.rejects(() => service.publishItem(item.id), (e) => e.code === PUBLISH_CODES.PROVIDER_DISABLED);
    assert.equal((await store.getPublishItem(item.id)).status, 'approved', 'bài phải giữ nguyên `approved`, không kẹt `publishing`');
    await store.close();
  });

  test('chạm trần `maxAttempts` ⇒ ATTEMPTS_EXHAUSTED, KHÔNG gọi provider nữa', async () => {
    const provider = countingProvider({ status: 'FAILED', errorCode: 'PROVIDER_FAILED', errorMessage: 'lỗi' });
    const { store, service, item } = await fixture({ provider, config: publishConfig({ maxAttempts: 2 }) });
    await service.approve(item.id, { by: USER_ADMIN });
    await service.publishItem(item.id);
    await service.publishItem(item.id);
    assert.equal(provider.calls.length, 2);
    await assert.rejects(() => service.publishItem(item.id), (e) => e.code === PUBLISH_CODES.ATTEMPTS_EXHAUSTED);
    assert.equal(provider.calls.length, 2, 'chạm trần thì KHÔNG được gọi thêm lần nào');
    await store.close();
  });
});

/* ══════════════ điều kiện 3 — idempotency: một bài chỉ đăng một lần ══════════════ */

describe('MVP-07 — MỘT BÀI CHỈ ĐĂNG MỘT LẦN (§6 điều kiện 3)', () => {
  test('gọi publish HAI lần ⇒ provider vẫn 1 lời gọi, lần hai `idempotent: true`', async () => {
    const { store, service, provider, item } = await fixture();
    await service.approve(item.id, { by: USER_ADMIN });

    const first = await service.publishItem(item.id);
    const second = await service.publishItem(item.id);

    assert.equal(provider.calls.length, 1, 'ĐÚNG MỘT lời gọi provider cho hai lần bấm đăng');
    assert.equal(first.called, true);
    assert.equal(first.idempotent, false);
    assert.equal(second.called, false, 'lần hai KHÔNG được gọi provider');
    assert.equal(second.idempotent, true);
    assert.equal(second.result.post_id, first.result.post_id, 'lần hai phải trả lại ĐÚNG id bài cũ');
    assert.equal(second.item.attempts, 1, '`attempts` không tăng khi không gọi provider');
    assert.equal((await store.listPublishLogs(item.id)).length, 1, 'chỉ có một dòng vết');
    await store.close();
  });

  test('HAI lượt ĐỒNG THỜI trên cùng bài ⇒ provider vẫn chỉ 1 lời gọi', async () => {
    const { store, service, provider, item } = await fixture();
    await service.approve(item.id, { by: USER_ADMIN });
    const results = await Promise.allSettled([service.publishItem(item.id), service.publishItem(item.id)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const called = fulfilled.filter((r) => r.value.called === true);
    assert.equal(provider.calls.length, 1, `hai lượt đồng thời chỉ được gọi provider 1 lần (đo: ${provider.calls.length})`);
    assert.equal(called.length, 1, 'đúng một lượt thật sự gọi provider');
    assert.equal((await store.getPublishItem(item.id)).status, 'published');
    await store.close();
  });

  test('`claimPublishItem` từ chối khi ĐÃ CÓ `external_post_id` (kể cả status `failed`)', async () => {
    const store = await makeStore();
    const job = await seedContentJob(store, { userId: USER_A });
    const item = await store.createPublishItem({ jobId: job.id, userId: USER_A, text: 'x', status: 'approved' });
    await store.claimPublishItem(item.id, { provider: 'p' });
    await store.finishPublishItem(item.id, { status: 'published', externalPostId: 'post_1', publishedAt: new Date().toISOString() });
    // Tay giả lập một bản ghi `failed` nhưng đã có id bài: KHÔNG được đăng lại.
    await store.driver.run("UPDATE publish_items SET status = 'failed' WHERE id = ?", [item.id]);
    assert.equal(await store.claimPublishItem(item.id, { provider: 'p' }), null, 'đã có external_post_id ⇒ không claim được');
    await store.close();
  });

  test('`finishPublishItem` KHÔNG ghi đè bài đã bị lượt khác kết thúc', async () => {
    const store = await makeStore();
    const job = await seedContentJob(store, { userId: USER_A });
    const item = await store.createPublishItem({ jobId: job.id, userId: USER_A, text: 'x', status: 'approved' });
    await store.claimPublishItem(item.id, { provider: 'p' });
    const first = await store.finishPublishItem(item.id, { status: 'published', externalPostId: 'post_1', publishedAt: new Date().toISOString() });
    assert.equal(first.status, 'published');
    const second = await store.finishPublishItem(item.id, { status: 'failed', errorCode: 'X', lastError: 'muộn' });
    assert.equal(second, null, 'kết quả của lượt đã bị cướp KHÔNG được ghi đè');
    assert.equal((await store.getPublishItem(item.id)).status, 'published');
    await store.close();
  });
});

/* ══════════════ luật duyệt / từ chối ══════════════ */

describe('MVP-07 — luật duyệt / từ chối / gửi duyệt', () => {
  let store;
  let service;
  let job;

  before(async () => {
    store = await makeStore();
    service = new PublishService({ store, provider: countingProvider(), config: publishConfig(), logger: silent });
    job = await seedContentJob(store, { userId: USER_A });
  });

  after(async () => {
    await store.close();
  });

  test('duyệt phải ghi được AI duyệt (thiếu `by` ⇒ BAD_INPUT)', async () => {
    const { item } = await service.createItem({ job, userId: USER_A, text: 'x', submit: true });
    await assert.rejects(() => service.approve(item.id, {}), (e) => e.code === PUBLISH_CODES.BAD_INPUT);
  });

  test('duyệt bài ĐÃ ĐĂNG ⇒ BAD_STATE (published là trạng thái kết thúc)', async () => {
    const { item } = await service.createItem({ job, userId: USER_A, text: 'x', submit: true });
    await service.approve(item.id, { by: USER_ADMIN });
    await service.publishItem(item.id);
    await assert.rejects(() => service.approve(item.id, { by: USER_ADMIN }), (e) => e.code === PUBLISH_CODES.BAD_STATE);
  });

  test('từ chối ghi `rejected_by` + lý do; từ chối hai lần ⇒ BAD_STATE', async () => {
    const { item } = await service.createItem({ job, userId: USER_A, text: 'x', submit: true });
    const rejected = await service.reject(item.id, { by: USER_ADMIN, reason: 'câu chữ sai' });
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejected_by, USER_ADMIN);
    assert.equal(rejected.reject_reason, 'câu chữ sai');
    await assert.rejects(() => service.reject(item.id, { by: USER_ADMIN }), (e) => e.code === PUBLISH_CODES.BAD_STATE);
  });

  test('duyệt sau khi đã từ chối ⇒ BAD_STATE (rejected là kết thúc)', async () => {
    const { item } = await service.createItem({ job, userId: USER_A, text: 'x', submit: true });
    await service.reject(item.id, { by: USER_ADMIN });
    await assert.rejects(() => service.approve(item.id, { by: USER_ADMIN }), (e) => e.code === PUBLISH_CODES.BAD_STATE);
  });

  test('gửi duyệt: draft → pending_review; gửi lần hai ⇒ BAD_STATE', async () => {
    const { item } = await service.createItem({ job, userId: USER_A, text: 'x' });
    const sent = await service.submit(item.id);
    assert.equal(sent.status, 'pending_review');
    await assert.rejects(() => service.submit(item.id), (e) => e.code === PUBLISH_CODES.BAD_STATE);
  });

  test('bài không tồn tại ⇒ ITEM_NOT_FOUND cho mọi thao tác', async () => {
    const ghost = '00000000-0000-4000-8000-00000000dead';
    for (const fn of [
      () => service.submit(ghost),
      () => service.approve(ghost, { by: USER_ADMIN }),
      () => service.reject(ghost, { by: USER_ADMIN }),
      () => service.publishItem(ghost),
    ]) {
      await assert.rejects(fn, (e) => e.code === PUBLISH_CODES.ITEM_NOT_FOUND);
    }
  });

  test('tạo bài không có chữ và không media ⇒ BAD_INPUT (không bịa nội dung)', async () => {
    const createdId = await store.createJob({ sessionId: 's', source: '1688', kind: 'content', userId: USER_A });
    const emptyJob = await store.getJob(createdId);
    await assert.rejects(
      () => service.createItem({ job: emptyJob, userId: USER_A, text: '' }),
      (e) => e.code === PUBLISH_CODES.BAD_INPUT,
    );
  });

  test('tạo bài không có `userId` ⇒ BAD_INPUT (bài đăng phải có chủ)', async () => {
    await assert.rejects(() => service.createItem({ job, userId: null, text: 'x' }), (e) => e.code === PUBLISH_CODES.BAD_INPUT);
  });

  test('kênh lạ ⇒ BAD_INPUT (sprint này chỉ Facebook Page)', async () => {
    await assert.rejects(() => service.createItem({ job, userId: USER_A, text: 'x', channel: 'tiktok' }), (e) => e.code === PUBLISH_CODES.BAD_INPUT);
  });

  test('text rỗng ⇒ lấy GỢI Ý từ nội dung job (không bịa thêm)', async () => {
    const { item } = await service.createItem({ job, userId: USER_A, text: '' });
    assert.match(item.text, /Tiêu đề bán hàng thử/);
    assert.match(item.text, /#thu/);
  });
});

/* ══════════════ cả đường dry-run đi qua service KHÔNG gọi mạng ══════════════ */

describe('MVP-07 — đường MẶC ĐỊNH (dry-run) qua service: không một byte ra mạng', () => {
  test('tạo → duyệt → đăng với `fetch` bị cấm ⇒ vẫn `published`, post_id `dry-`', async () => {
    const { createPublishProvider } = await import('../src/publish/index.js');
    const store = await makeStore();
    const config = publishConfig({ provider: 'dry-run' });
    const service = new PublishService({ store, provider: createPublishProvider(config, { logger: silent }), config, logger: silent });
    const job = await seedContentJob(store, { userId: USER_A });

    const { result, attempted } = await withoutNetwork(async () => {
      const { item } = await service.createItem({ job, userId: USER_A, text: 'Bài chế độ thử', submit: true });
      await service.approve(item.id, { by: USER_ADMIN });
      return service.publishItem(item.id);
    });

    assert.equal(attempted(), 0, 'cả luồng dry-run KHÔNG được gọi fetch lần nào');
    assert.equal(result.item.status, 'published');
    assert.ok(String(result.item.external_post_id).startsWith('dry-'));
    assert.equal(result.item.is_mock, true, 'bài đăng bằng provider giả phải được đánh dấu is_mock');
    await store.close();
  });
});
