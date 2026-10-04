/**
 * MVP-03 — PROBE (chạy tay): KHÔNG có đường CẤU HÌNH nào cho khối tạo ảnh.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CÁCH CHẠY:  node test/imagestudio-config-gap.probe.mjs
 * HIỆN TRẠNG : ❌ ĐỎ — cần một bản sửa trong `src/config.js` (agent gộp quyết định).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Vì sao đây là `.probe.mjs` chứ KHÔNG phải `.test.js`: `npm test` chạy `test/*.test.js` và
 * bắt buộc phải XANH. Đây là bằng chứng ĐỎ (mã nguồn thiếu), tách ra để không làm đỏ bộ test
 * chuẩn — chạy tay để thấy thất bại, kèm bằng chứng cụ thể.
 *
 * LỖI (2 phần, cùng một gốc: `loadConfig` không có khoá `imagestudio` / `matting` / `retouch`):
 *
 *  (1) `IMAGESTUDIO_ENABLED=false` KHÔNG có tác dụng.
 *      `src/http/routes.js` và `src/app.js` đều đọc `config.imagestudio?.enabled === false`,
 *      nhưng `src/config.js` KHÔNG ánh xạ biến môi trường nào vào khoá đó ⇒ không vận hành
 *      viên nào tắt được MVP-03 mà không sửa mã. (Ngược lại `IMAGELAB_ENABLED=false` thì
 *      chạy đúng — nên đây là thiếu sót của riêng khối MVP-03.)
 *
 *  (2) `MATTING_PROVIDER` / `RETOUCH_PROVIDER` (và mọi khoá `matting.*` / `retouch.*`)
 *      KHÔNG tồn tại trong config ⇒ `createMattingProvider(config)` rơi vào nhánh
 *      "config không có khối matting" và LUÔN chọn `purejs`; `createRetouchProvider` cũng vậy.
 *      Hệ quả: hợp đồng §3.1 ("`http`/`none`: thiếu cấu hình ⇒ NOT_CONFIGURED") và đường
 *      `MATTING_PROVIDER=http` KHÔNG dùng được ở môi trường thật; cũng không có cách tắt
 *      provider lỗi bằng cấu hình. Test chỉ chạm được các provider khác bằng cách bơm
 *      `opts.mattingProvider` trong mã — thứ mà deployment không có.
 *
 * Hướng sửa gợi ý (agent gộp chọn MỘT, thêm vào `src/config.js`):
 *   imagestudio: { enabled: toBool(env.IMAGESTUDIO_ENABLED, true) },
 *   matting: { provider: toStr(env.MATTING_PROVIDER, 'purejs').toLowerCase(),
 *              baseUrl: toStr(env.MATTING_BASE_URL, ''), apiKey: toStr(env.MATTING_API_KEY, ''),
 *              model: toStr(env.MATTING_MODEL, '') },
 *   retouch: { provider: toStr(env.RETOUCH_PROVIDER, 'purejs').toLowerCase(),
 *              limits: { brightness: toNum(env.RETOUCH_MAX_BRIGHTNESS, 0.25), ... } }
 * (ngưỡng retouch chỉ được SIẾT, không bao giờ nới — `resolveRetouchLimits` đã lo phần đó.)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.js';
import { createMattingProvider } from '../src/imagestudio/matting/index.js';
import { createRetouchProvider } from '../src/imagestudio/retouch/index.js';
import { startImagelabApp, cookie } from './imagelab-helpers.js';
import { silent } from './helpers.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-isprobe-'));

const env = (over = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    IMAGELAB_DIR: TMP,
    DB_DRIVER: 'sqlite',
    SQLITE_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    AI_PROVIDER: 'mock',
    ...over,
  });

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✔ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, message: err.message });
    console.log(`✖ ${name}\n    ${err.message}`);
  }
};

console.log('— MVP-03: đường cấu hình (probe ĐỎ, chạy tay) —\n');

await check('IMAGESTUDIO_ENABLED=false ⇒ /api/imagestudio/templates trả 503', async () => {
  const config = env({ IMAGESTUDIO_ENABLED: 'false' });
  const app = await startImagelabApp({ config });
  try {
    const res = await fetch(`${app.base}/api/imagestudio/templates`, { headers: cookie('probe-session') });
    const body = await res.json().catch(() => ({}));
    assert.equal(
      res.status,
      503,
      `nhận HTTP ${res.status} (${body?.error?.code || body?.code || 'không mã'}) — IMAGESTUDIO_ENABLED=false bị BỎ QUA ` +
        `(config.imagestudio = ${JSON.stringify(config.imagestudio)})`,
    );
  } finally {
    await app.close();
  }
});

await check('IMAGESTUDIO_ENABLED=false ⇒ /api/config báo imagestudio.enabled = false', async () => {
  const config = env({ IMAGESTUDIO_ENABLED: 'false' });
  const app = await startImagelabApp({ config });
  try {
    const cfg = await (await fetch(`${app.base}/api/config`, { headers: cookie('probe-session') })).json();
    assert.equal(cfg.imagestudio.enabled, false, `/api/config trả enabled = ${JSON.stringify(cfg.imagestudio.enabled)}`);
  } finally {
    await app.close();
  }
});

await check('IMAGELAB_ENABLED=false (đường ĐÃ có) tắt được cả MVP-03 — đối chứng dương', async () => {
  const config = env({ IMAGELAB_ENABLED: 'false' });
  const app = await startImagelabApp({ config });
  try {
    const res = await fetch(`${app.base}/api/imagestudio/templates`, { headers: cookie('probe-session') });
    assert.equal(res.status, 503, `nhận HTTP ${res.status}`);
  } finally {
    await app.close();
  }
});

await check('MATTING_PROVIDER=none ⇒ provider tách nền là "none" (NOT_CONFIGURED)', () => {
  const provider = createMattingProvider(env({ MATTING_PROVIDER: 'none' }), { logger: silent });
  assert.equal(provider.name, 'none', `nhận "${provider.name}" — biến MATTING_PROVIDER bị BỎ QUA`);
  assert.equal(provider.configured, false);
});

await check('MATTING_PROVIDER=http + MATTING_BASE_URL ⇒ provider http ĐÃ cấu hình', () => {
  const provider = createMattingProvider(env({ MATTING_PROVIDER: 'http', MATTING_BASE_URL: 'https://cat-nen.example.com/api' }), {
    logger: silent,
  });
  assert.equal(provider.name, 'http', `nhận "${provider.name}" — không chọn được provider http từ môi trường`);
  assert.equal(provider.configured, true, 'http có baseUrl nhưng vẫn configured = false');
});

await check('RETOUCH_PROVIDER=none ⇒ provider retouch là "none"', () => {
  const provider = createRetouchProvider(env({ RETOUCH_PROVIDER: 'none' }), { logger: silent });
  assert.equal(provider.name, 'none', `nhận "${provider.name}" — biến RETOUCH_PROVIDER bị BỎ QUA`);
});

console.log('\n— Kết luận —');
const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? '✅ TẤT CẢ XANH — đường cấu hình MVP-03 đã có.'
    : `❌ ${failed.length}/${results.length} mục ĐỎ: không có khoá cấu hình nào cho khối tạo ảnh MVP-03 ` +
      '(xem hướng sửa ở đầu file). Các đường KHÁC đều đã xanh: 503 khi thiếu pipeline, provider purejs/mock/none ' +
      'hoạt động đúng khi được bơm bằng mã.',
);
process.exit(failed.length === 0 ? 0 : 1);
