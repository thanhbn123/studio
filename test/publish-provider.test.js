/**
 * TEST MVP-07 · P1 — PROVIDER + LUẬT TRẠNG THÁI (`src/publish/**`), hợp đồng §2.
 *
 * Phủ đúng những điều kiện "XONG" số 4, 5, 6 của hợp đồng §6:
 *   - `dry-run` (MẶC ĐỊNH): `post_id` có tiền tố `dry-`, `is_mock: true`, `url: null`,
 *     và **0 lời gọi mạng** (đo bằng cách thay `globalThis.fetch` thành hàm NÉM LỖI).
 *   - `facebook` THIẾU token ⇒ `NOT_CONFIGURED`, **0 lời gọi mạng**, KHÔNG bịa `post_id`.
 *   - `facebook` có token GIẢ + server GIẢ ⇒ gọi đúng `/{page-id}/feed` và `/{page-id}/photos`,
 *     lỗi nền tảng giữ **NGUYÊN VĂN**, và **token không lọt ra** log/kết quả/URL.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PUBLISHABLE_STATUSES,
  PUBLISH_STATUSES,
  canTransition,
  createPublishProvider,
  draftTextFromJob,
  maskToken,
  normalizeMediaIds,
  normalizePublishText,
  normalizeSchedule,
  DRY_RUN_PREFIX,
} from '../src/publish/index.js';
import { publishConfig, startFakeGraphServer, withoutNetwork } from './publish-helpers.js';

/* ══════════════════ luật trạng thái (cổng duyệt ở dạng thuần) ══════════════════ */

describe('MVP-07 P1 — luật chuyển trạng thái (§2.2)', () => {
  test('bảy trạng thái đúng hợp đồng, không thiếu không thừa', () => {
    assert.deepEqual([...PUBLISH_STATUSES], [
      'draft', 'pending_review', 'approved', 'publishing', 'published', 'failed', 'rejected',
    ]);
  });

  test('CHỈ `approved` và `failed` được phép gọi provider', () => {
    assert.deepEqual([...PUBLISHABLE_STATUSES], ['approved', 'failed']);
    for (const s of ['draft', 'pending_review', 'publishing', 'published', 'rejected']) {
      assert.equal(PUBLISHABLE_STATUSES.includes(s), false, `${s} KHÔNG được nằm trong danh sách đăng được`);
    }
  });

  test('không có đường nào từ `draft`/`pending_review` nhảy thẳng sang `publishing`', () => {
    assert.equal(canTransition('draft', 'publishing'), false);
    assert.equal(canTransition('pending_review', 'publishing'), false);
    assert.equal(canTransition('approved', 'publishing'), true);
    assert.equal(canTransition('failed', 'publishing'), true);
  });

  test('`published` và `rejected` là trạng thái KẾT THÚC', () => {
    for (const to of PUBLISH_STATUSES) {
      assert.equal(canTransition('published', to), false, `published → ${to} phải bị cấm`);
      assert.equal(canTransition('rejected', to), false, `rejected → ${to} phải bị cấm`);
    }
  });

  test('trạng thái lạ ⇒ fail-closed (false), không đoán', () => {
    assert.equal(canTransition('approved', 'da_dang'), false);
    assert.equal(canTransition('', 'published'), false);
    assert.equal(canTransition(null, undefined), false);
  });
});

describe('MVP-07 P1 — chuẩn hoá đầu vào (§2.2)', () => {
  test('bỏ ký tự điều khiển/vô hình nhưng KHÔNG viết lại chữ của người dùng', () => {
    const out = normalizePublishText('Xin​chào\r\nbạn\u0007');
    assert.equal(out.text, 'Xinchào\nbạn');
    assert.ok(out.warnings.length > 0, 'phải cảnh báo đã bỏ ký tự');
  });

  test('vượt trần ⇒ `tooLong` (KHÔNG tự cắt: cắt âm thầm là sửa nội dung đã duyệt)', () => {
    const out = normalizePublishText('x'.repeat(50), { maxLength: 10 });
    assert.equal(out.tooLong, true);
    assert.equal(out.length, 50, 'nội dung phải giữ nguyên độ dài, không bị cắt');
  });

  test('đo độ dài theo ĐIỂM MÃ nên emoji không bị tính thành 2 ký tự', () => {
    assert.equal(normalizePublishText('😀😀').length, 2);
  });

  test('media id rác bị loại, trùng bị gộp', () => {
    const out = normalizeMediaIds(['abc', '', null, '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111'], { maxMedia: 5 });
    assert.deepEqual(out.mediaIds, ['11111111-1111-4111-8111-111111111111']);
    assert.ok(out.dropped >= 3);
  });

  test('hẹn giờ trong QUÁ KHỨ bị từ chối (không phải "đăng ngay" ngụy trang)', () => {
    assert.equal(normalizeSchedule('2020-01-01T00:00:00.000Z').bad, true);
    assert.equal(normalizeSchedule('khong-phai-ngay').bad, true);
    assert.equal(normalizeSchedule(null).bad, false);
    const future = new Date(Date.now() + 3600_000).toISOString();
    assert.equal(normalizeSchedule(future).scheduledAt, future);
  });

  test('job CHƯA có nội dung ⇒ gợi ý RỖNG (không bịa chữ)', () => {
    assert.equal(draftTextFromJob(null), '');
    assert.equal(draftTextFromJob({ id: 'x' }), '');
    assert.equal(draftTextFromJob({ content: {} }), '');
  });

  test('job có nội dung ⇒ gợi ý ghép từ ĐÚNG field đã lưu', () => {
    const text = draftTextFromJob({ content: { headline: 'Tiêu đề', selling_points: ['A', 'B'], hashtags: ['#x'] } });
    assert.match(text, /Tiêu đề/);
    assert.match(text, /• A\n• B/);
    assert.match(text, /#x/);
  });
});

/* ══════════════════ chọn provider ══════════════════ */

describe('MVP-07 P1 — chọn provider (§2.3)', () => {
  test('MẶC ĐỊNH (không khai gì) là `dry-run`, is_mock = true', () => {
    const p = createPublishProvider({});
    assert.equal(p.name, 'dry-run');
    assert.equal(p.isMock, true);
    assert.equal(p.configured, true);
  });

  test('tên provider LẠ ⇒ fail-closed về `none`, KHÔNG rơi về `dry-run`', () => {
    const warns = [];
    const p = createPublishProvider(publishConfig({ provider: 'facebok' }), { logger: { warn: (e, d) => warns.push([e, d]) } });
    assert.equal(p.name, 'none');
    assert.equal(p.configured, false);
    assert.equal(warns[0][0], 'publish.provider_unknown');
  });

  test('`none` ⇒ mọi publish trả NOT_CONFIGURED, không post_id', async () => {
    const p = createPublishProvider(publishConfig({ provider: 'none' }));
    const r = await p.publish({ text: 'xin chào' });
    assert.equal(r.status, 'NOT_CONFIGURED');
    assert.equal(r.post_id, null);
    assert.equal(r.error_code, 'NOT_CONFIGURED');
  });
});

/* ══════════════════ dry-run: KHÔNG gọi mạng, tự khai là giả ══════════════════ */

describe('MVP-07 P1 — provider `dry-run` (§6 điều kiện 4)', () => {
  test('post_id có tiền tố `dry-`, is_mock = true, url = null', async () => {
    const p = createPublishProvider(publishConfig({ provider: 'dry-run' }));
    const r = await p.publish({ text: 'Bài thử' });
    assert.equal(r.status, 'PUBLISHED');
    assert.ok(String(r.post_id).startsWith(DRY_RUN_PREFIX), `post_id phải bắt đầu bằng "${DRY_RUN_PREFIX}", nhận được ${r.post_id}`);
    assert.equal(r.is_mock, true);
    assert.equal(r.url, null, 'chế độ thử KHÔNG được bịa link bài');
    assert.equal(r.provider, 'dry-run');
  });

  test('KHÔNG gọi mạng: chạy được cả khi `fetch` bị thay bằng hàm NÉM LỖI', async () => {
    const p = createPublishProvider(publishConfig({ provider: 'dry-run' }));
    const { result, attempted } = await withoutNetwork(async () => {
      const probe = await p.probe();
      const published = await p.publish({ text: 'Bài thử không mạng', media: [] });
      return { probe, published };
    });
    assert.equal(attempted(), 0, 'dry-run KHÔNG được gọi fetch một lần nào');
    assert.equal(result.probe.ok, true);
    assert.equal(result.published.status, 'PUBLISHED');
  });

  test('vẫn TÔN TRỌNG luật đầu vào (bài rỗng / quá dài / hẹn giờ sai)', async () => {
    const p = createPublishProvider(publishConfig({ provider: 'dry-run', maxTextLength: 10 }));
    assert.equal((await p.publish({ text: '' })).error_code, 'BAD_INPUT');
    assert.equal((await p.publish({ text: 'x'.repeat(50) })).error_code, 'TEXT_TOO_LONG');
    assert.equal((await p.publish({ text: 'ok', scheduledAt: '2020-01-01T00:00:00Z' })).error_code, 'BAD_SCHEDULE');
  });

  test('hẹn giờ tương lai ⇒ SCHEDULED kèm mốc thật', async () => {
    const p = createPublishProvider(publishConfig({ provider: 'dry-run' }));
    const at = new Date(Date.now() + 7200_000).toISOString();
    const r = await p.publish({ text: 'Hẹn giờ', scheduledAt: at });
    assert.equal(r.status, 'SCHEDULED');
    assert.equal(r.scheduled_at, at);
  });

  test('hai lần gọi ⇒ hai post_id KHÁC nhau (id thử vẫn phải phân biệt được)', async () => {
    const p = createPublishProvider(publishConfig({ provider: 'dry-run' }));
    const a = await p.publish({ text: 'a' });
    const b = await p.publish({ text: 'b' });
    assert.notEqual(a.post_id, b.post_id);
  });
});

/* ══════════════════ facebook: thiếu token ⇒ không mạng, không bịa ══════════════════ */

describe('MVP-07 P1 — provider `facebook` CHƯA cấu hình (§6 điều kiện 5)', () => {
  test('thiếu cả Page ID và token ⇒ configured = false', () => {
    const p = createPublishProvider(publishConfig({ provider: 'facebook' }));
    assert.equal(p.name, 'facebook');
    assert.equal(p.configured, false);
    assert.equal(p.isMock, false, 'provider thật KHÔNG được tự nhận là mock');
  });

  test('chỉ có Page ID (thiếu token) ⇒ vẫn configured = false', () => {
    const p = createPublishProvider(publishConfig({ provider: 'facebook', facebook: { pageId: '123' } }));
    assert.equal(p.configured, false);
  });

  test('publish khi chưa cấu hình ⇒ NOT_CONFIGURED, KHÔNG post_id, KHÔNG gọi mạng', async () => {
    const p = createPublishProvider(publishConfig({ provider: 'facebook' }));
    const { result, attempted } = await withoutNetwork(async () => ({
      probe: await p.probe(),
      published: await p.publish({ text: 'Bài sẽ không được gửi' }),
    }));
    assert.equal(attempted(), 0, 'chưa cấu hình thì KHÔNG được gọi fetch');
    assert.equal(result.probe.ok, false);
    assert.equal(result.probe.error_code, 'NOT_CONFIGURED');
    assert.equal(result.probe.page_id, '', 'probe chưa cấu hình KHÔNG được trả page_id');
    assert.equal(result.published.status, 'NOT_CONFIGURED');
    assert.equal(result.published.post_id, null, 'KHÔNG BAO GIỜ bịa post_id');
    assert.equal(result.published.is_mock, false);
    assert.match(result.published.error_message, /Page ID/);
  });
});

/* ══════════════════ facebook: server GIẢ (không chạm Facebook) ══════════════════ */

describe('MVP-07 P1 — provider `facebook` với Graph API GIẢ (§6 điều kiện 6)', () => {
  const TOKEN = 'EAAG-fake-token-khong-phai-that-0123456789';

  const makeProvider = (baseUrl, extra = {}) =>
    createPublishProvider(publishConfig({
      provider: 'facebook',
      facebook: { pageId: '999000111', accessToken: TOKEN, baseUrl, allowPrivateNetwork: true, ...extra },
    }), { logger: { info() {}, warn() {}, error() {} } });

  test('bài chỉ có chữ ⇒ POST `/{page-id}/feed`, token trong THÂN (không trong URL)', async () => {
    const fake = await startFakeGraphServer(() => ({ status: 200, json: { id: '999000111_555' } }));
    try {
      const p = makeProvider(fake.baseUrl);
      const r = await p.publish({ text: 'Bài chỉ có chữ' });
      assert.equal(r.status, 'PUBLISHED');
      assert.equal(r.post_id, '999000111_555');
      assert.equal(r.is_mock, false);
      assert.equal(r.url, 'https://www.facebook.com/999000111_555');

      assert.equal(fake.requests.length, 1);
      const req = fake.requests[0];
      assert.equal(req.method, 'POST');
      assert.match(req.url, /^\/v21\.0\/999000111\/feed$/);
      assert.ok(!req.url.includes(TOKEN), 'token KHÔNG được nằm trong URL (URL vào access log)');
      assert.ok(req.body.includes(`access_token=${encodeURIComponent(TOKEN)}`), 'token phải nằm trong thân request');
      assert.match(req.body, /message=/);
    } finally {
      await fake.close();
    }
  });

  test('bài có 1 ảnh CÓ url công khai ⇒ POST `/{page-id}/photos` và lấy `post_id`', async () => {
    const fake = await startFakeGraphServer(() => ({ status: 200, json: { id: 'photo_1', post_id: '999000111_777' } }));
    try {
      const p = makeProvider(fake.baseUrl);
      const r = await p.publish({ text: 'Có ảnh', media: [{ id: 'a1', mime: 'image/png', url: 'https://example.com/a.png' }] });
      assert.equal(r.status, 'PUBLISHED');
      assert.equal(r.post_id, '999000111_777', '`/photos` trả cả `id` và `post_id` — phải lấy `post_id` (id BÀI)');
      assert.match(fake.requests[0].url, /\/photos$/);
      assert.match(fake.requests[0].body, /caption=/);
      assert.match(fake.requests[0].body, /url=https/);
    } finally {
      await fake.close();
    }
  });

  test('hẹn giờ ⇒ gửi `published=false` + `scheduled_publish_time` (giây unix)', async () => {
    const fake = await startFakeGraphServer(() => ({ status: 200, json: { id: 'p_sched' } }));
    try {
      const p = makeProvider(fake.baseUrl);
      const at = new Date(Date.now() + 86400_000).toISOString();
      const r = await p.publish({ text: 'Hẹn giờ thật', scheduledAt: at });
      assert.equal(r.status, 'SCHEDULED');
      assert.match(fake.requests[0].body, /published=false/);
      assert.match(fake.requests[0].body, /scheduled_publish_time=\d{10}/);
    } finally {
      await fake.close();
    }
  });

  test('Facebook trả LỖI ⇒ giữ NGUYÊN VĂN message + code/subcode, KHÔNG bịa thành công', async () => {
    const fbMessage = '(#200) The user hasn\'t authorized the application to perform this action';
    const fake = await startFakeGraphServer(() => ({
      status: 403,
      json: { error: { message: fbMessage, type: 'OAuthException', code: 200, error_subcode: 1349004, fbtrace_id: 'Axyz' } },
    }));
    try {
      const p = makeProvider(fake.baseUrl);
      const r = await p.publish({ text: 'Bài sẽ bị từ chối' });
      assert.equal(r.status, 'FAILED');
      assert.equal(r.post_id, null);
      assert.equal(r.error_code, 'PROVIDER_FAILED');
      assert.equal(r.error_message, fbMessage, 'lỗi nền tảng phải NGUYÊN VĂN, không dịch lại');
      assert.equal(r.raw.error.code, 200);
      assert.equal(r.raw.error.error_subcode, 1349004);
      assert.equal(r.raw.http_status, 403);
    } finally {
      await fake.close();
    }
  });

  test('Facebook trả 200 nhưng KHÔNG có id ⇒ FAILED (không coi là đã đăng)', async () => {
    const fake = await startFakeGraphServer(() => ({ status: 200, json: { ok: true } }));
    try {
      const p = makeProvider(fake.baseUrl);
      const r = await p.publish({ text: 'Thiếu id' });
      assert.equal(r.status, 'FAILED');
      assert.equal(r.post_id, null);
    } finally {
      await fake.close();
    }
  });

  test('token LỌT vào thông báo lỗi của Facebook ⇒ bị `maskToken` che', async () => {
    const fake = await startFakeGraphServer(() => ({
      status: 400,
      json: { error: { message: `Invalid OAuth access token: ${TOKEN}`, code: 190 } },
    }));
    try {
      const p = makeProvider(fake.baseUrl);
      const r = await p.publish({ text: 'Token hết hạn' });
      assert.ok(!r.error_message.includes(TOKEN), 'token KHÔNG được lọt ra error_message');
      assert.match(r.error_message, /<token>/);
      assert.ok(!JSON.stringify(r.raw).includes(TOKEN), 'token KHÔNG được lọt vào `raw`');
    } finally {
      await fake.close();
    }
  });

  test('`maskToken` che cả chuỗi `access_token=…` lạc vào từ nơi khác', () => {
    assert.equal(maskToken('loi: access_token=ABCDEF123 het han', ''), 'loi: access_token=<token> het han');
    assert.equal(maskToken('abc', 'abc'), 'abc', 'token quá ngắn (<6) thì không thay bừa');
  });

  test('ảnh CHỈ có trên đĩa (không url) ⇒ MEDIA_NOT_PUBLIC, nói thẳng là CHƯA làm multipart', async () => {
    const fake = await startFakeGraphServer(() => ({ status: 200, json: { id: 'x' } }));
    try {
      const p = makeProvider(fake.baseUrl);
      const r = await p.publish({ text: 'Có ảnh nhưng không công khai', media: [{ id: 'a1', url: '' }] });
      assert.equal(r.status, 'FAILED');
      assert.equal(r.error_code, 'MEDIA_NOT_PUBLIC');
      assert.equal(fake.requests.length, 0, 'không được gọi Graph khi biết chắc sẽ sai');
    } finally {
      await fake.close();
    }
  });

  test('nhiều hơn 1 ảnh ⇒ MEDIA_TOO_MANY (attached_media CHƯA làm), không đăng thiếu ảnh', async () => {
    const fake = await startFakeGraphServer(() => ({ status: 200, json: { id: 'x' } }));
    try {
      const p = makeProvider(fake.baseUrl);
      const r = await p.publish({ text: 'Hai ảnh', media: [{ id: 'a', url: 'https://e/1.png' }, { id: 'b', url: 'https://e/2.png' }] });
      assert.equal(r.error_code, 'MEDIA_TOO_MANY');
      assert.equal(fake.requests.length, 0);
    } finally {
      await fake.close();
    }
  });

  test('SSRF: baseUrl nội bộ mà KHÔNG bật allowPrivateNetwork ⇒ FAILED, không ra khỏi máy', async () => {
    const fake = await startFakeGraphServer(() => ({ status: 200, json: { id: 'x' } }));
    try {
      const p = createPublishProvider(publishConfig({
        provider: 'facebook',
        facebook: { pageId: '1', accessToken: TOKEN, baseUrl: fake.baseUrl, allowPrivateNetwork: false },
      }), { logger: { info() {}, warn() {}, error() {} } });
      const r = await p.publish({ text: 'thử SSRF' });
      assert.equal(r.status, 'FAILED', 'mạng nội bộ phải bị chặn khi chưa bật cờ');
      assert.equal(fake.requests.length, 0);
    } finally {
      await fake.close();
    }
  });

  test('mạng chết (server đã tắt) ⇒ FAILED, KHÔNG ném lỗi ra ngoài', async () => {
    const fake = await startFakeGraphServer(() => ({ status: 200, json: { id: 'x' } }));
    const base = fake.baseUrl;
    await fake.close();
    const p = makeProvider(base);
    const r = await p.publish({ text: 'server đã tắt' });
    assert.equal(r.status, 'FAILED');
    assert.ok(String(r.error_code).length > 0);
  });

  test('`probe()` khi đã cấu hình ⇒ GET Page, token trong header Bearer (KHÔNG trong URL)', async () => {
    const fake = await startFakeGraphServer(() => ({ status: 200, json: { id: '999000111', name: 'Trang thử' } }));
    try {
      const p = makeProvider(fake.baseUrl);
      const probe = await p.probe();
      assert.equal(probe.ok, true);
      assert.equal(probe.page_id, '999000111');
      const req = fake.requests[0];
      assert.equal(req.method, 'GET', 'đọc Page phải là GET thật, không dùng mẹo method-override');
      assert.match(req.url, /^\/v21\.0\/999000111\?fields=id%2Cname$/);
      assert.ok(!req.url.includes(TOKEN), 'token KHÔNG được nằm trong URL (URL vào access log)');
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(req.body, '', 'GET không có thân request');
    } finally {
      await fake.close();
    }
  });

  test('`probe()` khi token đã hết hạn ⇒ ok = false và nói nguyên văn (token bị che)', async () => {
    const fake = await startFakeGraphServer(() => ({
      status: 401,
      json: { error: { message: `Error validating access token: ${TOKEN}`, code: 190 } },
    }));
    try {
      const p = makeProvider(fake.baseUrl);
      const probe = await p.probe();
      assert.equal(probe.ok, false);
      assert.equal(probe.error_code, 'PROVIDER_FAILED');
      assert.match(probe.message, /validating access token/);
      assert.ok(!probe.message.includes(TOKEN), 'token KHÔNG được lọt ra probe.message');
    } finally {
      await fake.close();
    }
  });
});
