/**
 * Tiện ích dùng chung cho bộ test MVP-07 “Đăng bài Facebook Page (duyệt tay)”.
 *
 * Nguyên tắc giống các helper khác của repo: KHÔNG cần mạng, KHÔNG cần API key, KHÔNG cần
 * token Facebook.
 *   - `startPublishApp()` dựng app THẬT (server thật, SQLite in-memory) qua `startMvp05App`,
 *     nên route → service → store → DB là đường THẬT, không phải bản chép lại tay.
 *   - `countingProvider()` là `PublishProvider` đúng hình dạng hợp đồng §2.1 có ĐẾM số lần gọi —
 *     đây là dụng cụ chứng minh luật "chưa duyệt ⇒ 0 lời gọi provider".
 *   - `startFakeGraphServer()` là server HTTP thật trên 127.0.0.1 giả làm Graph API, để kiểm
 *     provider `facebook` mà KHÔNG gọi Facebook (dự án chưa có token, chưa qua app review).
 *   - `noFetch()` thay `globalThis.fetch` bằng hàm NÉM LỖI — cách duy nhất chứng minh được
 *     "provider dry-run không gọi mạng" chứ không chỉ "có vẻ không gọi".
 *
 * File này KHÔNG có hậu tố `.test.js` nên `node --test test/*.test.js` không chạy nó.
 */

import http from 'node:http';

import { startMvp05App, register, request, newJar, j, PASSWORD } from './mvp05-helpers.js';
import { silent } from './helpers.js';

export { register, request, newJar, j, PASSWORD, silent };

/**
 * App THẬT đủ MVP-01..07.
 *
 * `publishProvider`/`publishService` được bơm qua `createApp` (điểm bơm đã có trong `src/app.js`)
 * để test thay provider mà KHÔNG phải sửa cấu hình tiến trình.
 */
export async function startPublishApp({ configOverrides = {}, publishProvider = null, publishService = null } = {}) {
  return startMvp05App({
    configOverrides,
    ...(publishProvider ? { publishProvider } : {}),
    ...(publishService ? { publishService } : {}),
  });
}

/**
 * `PublishProvider` giả CÓ ĐẾM — hình dạng đúng hợp đồng §2.1.
 *
 * `calls` là bằng chứng: test khẳng định `calls.length === 0` khi bài chưa được duyệt, và
 * `=== 1` sau khi duyệt + đăng hai lần (idempotency).
 */
export function countingProvider({
  name = 'fake-publish',
  isMock = true,
  configured = true,
  postId = 'fake-post-1',
  status = 'PUBLISHED',
  errorCode = null,
  errorMessage = '',
  url = null,
  fail = null,
} = {}) {
  const calls = [];
  return {
    name,
    channel: 'facebook_page',
    model: '',
    configured,
    isMock,
    notice: '',
    calls,
    async probe() {
      return { ok: configured, name, channel: 'facebook_page', configured, is_mock: isMock, page_id: '', error_code: configured ? null : 'NOT_CONFIGURED', message: '' };
    },
    async publish(input) {
      calls.push(input);
      if (fail) throw fail;
      const ok = status === 'PUBLISHED' || status === 'SCHEDULED';
      return {
        status,
        post_id: ok ? `${postId}-${calls.length}` : null,
        url: ok ? url : null,
        error_code: errorCode,
        error_message: errorMessage,
        is_mock: isMock,
        provider: name,
        scheduled_at: null,
        raw: { fake: true },
      };
    },
  };
}

/** `PublishService` giả dùng provider đếm ở trên nhưng store THẬT (dùng cho test route). */
export async function makePublishService(store, provider, { config = {} } = {}) {
  const { PublishService } = await import('../src/publish/index.js');
  return new PublishService({ store, provider, config, logger: silent });
}

/**
 * Server HTTP THẬT giả làm Graph API (không chạm Facebook).
 *
 * `handler(req, body)` trả `{ status, json }`. `requests` ghi lại NGUYÊN VĂN thân request để
 * test khẳng định provider gọi đúng edge (`/feed` hay `/photos`) và token nằm trong THÂN
 * (không nằm trong URL).
 */
export async function startFakeGraphServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, body, headers: { ...req.headers } });
      let out = { status: 200, json: { id: 'page_1', post_id: '12345_67890' } };
      try {
        out = (await handler?.(req, body)) || out;
      } catch (err) {
        out = { status: 500, json: { error: { message: String(err?.message ?? err) } } };
      }
      const payload = JSON.stringify(out.json ?? {});
      res.writeHead(out.status ?? 200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Thay `globalThis.fetch` bằng hàm NÉM LỖI trong lúc chạy `fn()`.
 *
 * Vì sao cần: "provider không gọi mạng" chỉ chứng minh được khi mọi đường mạng đều NỔ. Nếu
 * provider có một lời gọi `fetch` nào, test sẽ thấy lỗi `FETCH_FORBIDDEN_IN_TEST` chứ không
 * im lặng đi qua.
 */
export async function withoutNetwork(fn) {
  const original = globalThis.fetch;
  let attempted = 0;
  globalThis.fetch = (...args) => {
    attempted += 1;
    const err = new Error(`FETCH_FORBIDDEN_IN_TEST: test này cấm gọi mạng, nhưng có lời gọi tới ${String(args[0]).slice(0, 120)}`);
    err.code = 'FETCH_FORBIDDEN_IN_TEST';
    throw err;
  };
  try {
    return { result: await fn(), attempted: () => attempted };
  } finally {
    globalThis.fetch = original;
  }
}

/** Cấu hình tối thiểu cho provider (không cần cả `loadConfig`). */
export function publishConfig({ provider = 'dry-run', facebook = {}, maxTextLength = 63206, maxMedia = 1, maxAttempts = 3 } = {}) {
  return {
    publish: {
      enabled: true,
      provider,
      maxTextLength,
      maxMedia,
      maxAttempts,
      facebook: {
        pageId: '',
        accessToken: '',
        apiVersion: 'v21.0',
        baseUrl: 'https://graph.facebook.com',
        timeoutMs: 5000,
        allowPrivateNetwork: false,
        ...facebook,
      },
    },
  };
}

/** Tạo một job THẬT của `userId` trong store (bài đăng phải xuất phát từ job đã chạy). */
export async function seedContentJob(store, { userId = null, sessionId = 'publishTestSession1', content = null, productName = 'Sản phẩm đăng thử' } = {}) {
  // ⚠️ `Store#createJob` trả về CHUỖI id (không phải object) — dùng sai là `WHERE id = undefined`.
  const jobId = await store.createJob({ sessionId, source: '1688', sourceUrl: 'https://detail.1688.com/offer/777.html', kind: 'content', userId });
  await store.updateJob(jobId, {
    status: 'succeeded',
    product_name: productName,
    content: content ?? {
      product_name: productName,
      headline: 'Tiêu đề bán hàng thử',
      short_description: 'Mô tả ngắn cho bài đăng thử.',
      selling_points: ['Bền', 'Nhẹ'],
      hashtags: ['#thu', '#dangbai'],
    },
  });
  return store.getJob(jobId);
}

/** Nâng một user lên owner (để test cổng `requireAdmin` của route duyệt). */
export async function makeOwner(store, userId) {
  await store.updateUser(userId, { role: 'owner' });
  return store.getUserById(userId);
}
