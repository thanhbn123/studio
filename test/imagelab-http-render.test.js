/**
 * MVP-02 — PROVIDER RENDER `http`, TEST THƯỜNG TRỰC.
 *
 * Vì sao cần: phản biện độc lập đã chứng minh nhóm lỗi N-5/N-8/N-12/N-13 **chỉ lộ ra ở đường
 * `RENDER_PROVIDER=http`** — mà đường này trước đây chỉ được kiểm bằng script tạm của phản biện
 * (`/tmp/atk*`), trong repo thì `src/imagelab/render/providers/http.js` gần như **0% hàm** (các
 * test cũ dùng lớp giả kế thừa `RenderProvider`, tức bỏ qua toàn bộ tầng HTTP).
 *
 * File này dựng một **service render giả chạy thật trên localhost** và khoá lại hợp đồng:
 *   request : POST `{image_base64, mime, ops}` · response: `{image_base64, applied?, ...}`
 *   + mọi nhánh trung thực: không `applied` ⇒ PARTIAL (không bịa), JSON hỏng/HTTP 500/rác ⇒ mã lỗi
 *     rõ, ảnh sai kích thước ⇒ TỪ CHỐI lưu, ảnh không phải PNG ⇒ nói thẳng là chưa kiểm chứng được.
 *
 * Không cần mạng ngoài: server là `node:http` trên 127.0.0.1, và `ALLOW_PRIVATE_NETWORK` được bật
 * có kiểm soát (đúng như ghi chú của C1 cho test http).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { HttpRenderProvider } from '../src/imagelab/render/providers/http.js';
import { RenderProvider } from '../src/imagelab/render/provider.js';
import { decodePng, encodePng, toRgba } from '../src/imagelab/render/index.js';
import { silent } from './helpers.js';
import { makeTestImage } from './imagelab-helpers.js';

const W = 64;
const H = 64;
const OP_BOX = { x: 8, y: 8, w: 32, h: 16 };
const OP = { region_id: 'r1', box: OP_BOX, action: 'erase_and_draw', text: 'AB' };
const LIMITS = { maxPixels: 16_000_000, maxOutputBytes: 8 * 1024 * 1024, maxImageBytes: 8 * 1024 * 1024 };

const baseImage = () => makeTestImage({ width: W, height: H, fills: [{ box: OP_BOX, rgba: [255, 0, 0, 255] }] });

/** Ảnh "đã render" hợp lệ: đổi màu trong hộp op (RGB đổi thật ⇒ không rơi vào nhánh NO_OPS). */
function drawnImage() {
  const data = Buffer.from(toRgba(decodePng(baseImage())));
  for (let y = OP_BOX.y; y < OP_BOX.y + OP_BOX.h; y += 1) {
    for (let x = OP_BOX.x; x < OP_BOX.x + OP_BOX.w; x += 1) {
      const i = (y * W + x) * 4;
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 255;
      data[i + 3] = 255;
    }
  }
  return encodePng({ width: W, height: H, channels: 4, data });
}

const tinyJpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

/** Service render giả: mỗi test đặt một handler, và ghi lại request nhận được. */
function fakeService(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      seen.push({ headers: req.headers, body: parsed, raw: body });
      handler({ req, res, body: parsed, raw: body });
    });
  });
  return { server, seen };
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

const providerFor = (port, extra = {}) =>
  new HttpRenderProvider({
    baseUrl: `http://127.0.0.1:${port}/render`,
    limits: LIMITS,
    logger: silent,
    allowPrivateNetwork: true,
    ...extra,
  });

const sendJson = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

describe('MVP-02 · provider render `http` (service giả trên localhost)', () => {
  let port;
  let service;
  let current;

  before(async () => {
    service = fakeService((ctx) => current(ctx));
    port = await listen(service.server);
  });

  after(async () => {
    await close(service.server);
  });

  test('luồng hợp lệ: gửi đúng hợp đồng, nhận ảnh đã vẽ, applied giữ nguyên', async () => {
    const drawn = drawnImage();
    current = ({ res }) => sendJson(res, 200, { image_base64: drawn.toString('base64'), applied: [{ region_id: 'r1', box: OP_BOX }] });

    const provider = providerFor(port);
    const res = await provider.render({ image: { buffer: baseImage(), mime: 'image/png' }, ops: [OP] });

    assert.equal(res.status, 'OK');
    assert.equal(res.is_mock, false, 'provider http KHÔNG phải mock');
    assert.equal(res.provider, 'http');
    assert.deepEqual(res.applied.map((a) => a.region_id), ['r1']);
    assert.equal(res.output.width, W);
    assert.equal(res.output.height, H);

    // Request gửi đi phải đúng hợp đồng: có image_base64 + ops + mime.
    const sent = service.seen.at(-1).body;
    assert.equal(sent.mime, 'image/png');
    assert.equal(sent.ops.length, 1);
    assert.equal(sent.ops[0].region_id, 'r1');
    assert.equal(sent.ops[0].action, 'erase_and_draw');
    assert.equal(sent.ops[0].text, 'AB');
    assert.ok(sent.image_base64.length > 0);
  });

  test('gửi kèm Authorization khi có apiKey (không log ra ngoài)', async () => {
    current = ({ res }) => sendJson(res, 200, { image_base64: drawnImage().toString('base64'), applied: [{ region_id: 'r1' }] });

    const provider = providerFor(port, { apiKey: 'khoa-gia-trong-test' });
    await provider.render({ image: { buffer: baseImage(), mime: 'image/png' }, ops: [OP] });

    assert.equal(service.seen.at(-1).headers.authorization, 'Bearer khoa-gia-trong-test');
  });

  test('service KHÔNG trả `applied` ⇒ PARTIAL + cảnh báo, KHÔNG bịa danh sách đã vẽ', async () => {
    current = ({ res }) => sendJson(res, 200, { image_base64: drawnImage().toString('base64') });

    const res = await providerFor(port).render({ image: { buffer: baseImage(), mime: 'image/png' }, ops: [OP] });

    assert.equal(res.status, 'PARTIAL');
    assert.deepEqual(res.applied, [], 'không có `applied` thì không được liệt kê gì');
    assert.match(res.warnings.join(' '), /không trả `applied`/i);
  });

  test('service trả `applied` THIẾU so với ops ⇒ PARTIAL (không tin lời khai)', async () => {
    current = ({ res }) => sendJson(res, 200, { image_base64: drawnImage().toString('base64'), applied: [] });

    const res = await providerFor(port).render({ image: { buffer: baseImage(), mime: 'image/png' }, ops: [OP] });
    assert.equal(res.status, 'PARTIAL');
  });

  test('HTTP 500 ⇒ FAILED + RENDER_HTTP_STATUS (không lưu ảnh)', async () => {
    current = ({ res }) => sendJson(res, 500, { error: 'no' });

    const res = await providerFor(port).render({ image: { buffer: baseImage(), mime: 'image/png' }, ops: [OP] });
    assert.equal(res.status, 'FAILED');
    assert.equal(res.error_code, 'RENDER_HTTP_STATUS');
    assert.equal(res.output, null);
  });

  test('body không phải JSON ⇒ FAILED + RENDER_BAD_RESPONSE', async () => {
    current = ({ res }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>khong phai json</html>');
    };

    const res = await providerFor(port).render({ image: { buffer: baseImage(), mime: 'image/png' }, ops: [OP] });
    assert.equal(res.status, 'FAILED');
    assert.equal(res.error_code, 'RENDER_BAD_RESPONSE');
  });

  test('image_base64 rác ⇒ FAILED + RENDER_BAD_RESPONSE (không lưu asset rác)', async () => {
    current = ({ res }) => sendJson(res, 200, { image_base64: '!!!khong-phai-base64!!!' });

    const res = await providerFor(port).render({ image: { buffer: baseImage(), mime: 'image/png' }, ops: [OP] });
    assert.equal(res.status, 'FAILED');
    assert.equal(res.error_code, 'RENDER_BAD_RESPONSE');
    assert.equal(res.output, null);
  });

  test('ảnh trả về SAI KÍCH THƯỚC ⇒ FAILED + RENDER_SIZE_MISMATCH', async () => {
    const small = encodePng({ width: 16, height: 16, channels: 4, data: Buffer.alloc(16 * 16 * 4, 255) });
    current = ({ res }) => sendJson(res, 200, { image_base64: small.toString('base64'), applied: [{ region_id: 'r1' }] });

    const res = await providerFor(port).render({ image: { buffer: baseImage(), mime: 'image/png' }, ops: [OP] });
    assert.equal(res.status, 'FAILED');
    assert.equal(res.error_code, 'RENDER_SIZE_MISMATCH');
    assert.equal(res.output, null);
  });

  test('ảnh JPEG trả về (không giải mã được) + CÓ vùng bảo vệ ⇒ PARTIAL + PROTECTED_PIXELS_UNVERIFIED', async () => {
    current = ({ res }) => sendJson(res, 200, { image_base64: tinyJpeg().toString('base64'), applied: [{ region_id: 'r1' }] });

    const res = await providerFor(port).render({
      image: { buffer: baseImage(), mime: 'image/png' },
      ops: [OP],
      options: { protected_boxes: [{ region_id: 'r2', box: { x: 40, y: 40, w: 10, h: 10 } }] },
    });

    assert.notEqual(res.status, 'OK', 'JPEG thì không được báo OK như đã kiểm');
    assert.equal(res.status, 'PARTIAL');
    assert.equal(res.protected_pixels_verified, false);
    assert.equal(res.error_code, 'PROTECTED_PIXELS_UNVERIFIED');
    assert.match(res.warnings.join(' '), /KHÔNG kiểm chứng được pixel/i);
    // Ảnh KHÁC kích thước thật (JPEG header 0×0) nhưng ở đây kiểm điều quan trọng: không OK.
    assert.ok(res.warnings.length > 0);
  });

  test('không cấu hình baseUrl ⇒ NOT_CONFIGURED (không gọi mạng)', async () => {
    const provider = new HttpRenderProvider({ baseUrl: '', limits: LIMITS, logger: silent });
    assert.equal(provider.configured, false);
    const res = await provider.render({ image: { buffer: baseImage(), mime: 'image/png' }, ops: [OP] });
    assert.equal(res.status, 'NOT_CONFIGURED');
    assert.equal(res.error_code, 'NOT_CONFIGURED');
  });

  test('ALLOW_PRIVATE_NETWORK=false ⇒ chặn gọi vào localhost (SSRF), mã lỗi rõ', async () => {
    current = () => {
      throw new Error('KHÔNG được gọi tới service khi đã bị allowlist chặn');
    };

    const provider = new HttpRenderProvider({
      baseUrl: `http://127.0.0.1:${port}/render`,
      limits: LIMITS,
      logger: silent,
      allowPrivateNetwork: false,
    });
    const res = await provider.render({ image: { buffer: baseImage(), mime: 'image/png' }, ops: [OP] });

    assert.equal(res.status, 'FAILED');
    assert.ok(
      ['RENDER_NETWORK', 'RENDER_DOMAIN_NOT_ALLOWED'].includes(res.error_code),
      `phải là lỗi mạng/bị chặn, nhận ${res.error_code}`,
    );
    assert.equal(res.output, null);
  });

  test('baseUrl sai định dạng (ftp:, rác) ⇒ coi như chưa cấu hình', () => {
    assert.equal(new HttpRenderProvider({ baseUrl: 'ftp://x/y', limits: LIMITS, logger: silent }).configured, false);
    assert.equal(new HttpRenderProvider({ baseUrl: 'khong-phai-url', limits: LIMITS, logger: silent }).configured, false);
  });

  test('provider http là lớp con của RenderProvider (dùng chung hậu kiểm)', () => {
    assert.ok(providerFor(port) instanceof RenderProvider);
  });

  test('thiếu dữ liệu ảnh đầu vào ⇒ FAILED + BAD_INPUT (không gọi service)', async () => {
    current = () => {
      throw new Error('không được gọi service khi thiếu ảnh');
    };

    const res = await providerFor(port).render({ image: { buffer: Buffer.alloc(0), mime: 'image/png' }, ops: [OP] });
    assert.equal(res.status, 'FAILED');
    assert.equal(res.error_code, 'BAD_INPUT');
  });

  test('response thiếu `image_base64` ⇒ FAILED + RENDER_BAD_RESPONSE', async () => {
    current = ({ res }) => sendJson(res, 200, { applied: [{ region_id: 'r1' }] });

    const res = await providerFor(port).render({ image: { buffer: baseImage(), mime: 'image/png' }, ops: [OP] });
    assert.equal(res.status, 'FAILED');
    assert.equal(res.error_code, 'RENDER_BAD_RESPONSE');
  });

  test('ảnh trả về vượt `maxOutputBytes` ⇒ FAILED + RENDER_OUTPUT_TOO_LARGE', async () => {
    current = ({ res }) => sendJson(res, 200, { image_base64: drawnImage().toString('base64'), applied: [{ region_id: 'r1' }] });

    // Giới hạn output tí hon để ép đúng nhánh chặn (ảnh thật lớn hơn 100 byte).
    const provider = new HttpRenderProvider({
      baseUrl: `http://127.0.0.1:${port}/render`,
      limits: { ...LIMITS, maxOutputBytes: 100 },
      logger: silent,
      allowPrivateNetwork: true,
    });
    const res = await provider.render({ image: { buffer: baseImage(), mime: 'image/png' }, ops: [OP] });

    // `RENDER_OUTPUT_TOO_LARGE` nằm trong nhóm "ảnh này không xử lý được" nên trạng thái là
    // `UNSUPPORTED_IMAGE` (không phải FAILED) — đúng thiết kế, xem `UNSUPPORTED_IMAGE_CODES`.
    assert.equal(res.status, 'UNSUPPORTED_IMAGE');
    assert.equal(res.error_code, 'RENDER_OUTPUT_TOO_LARGE');
    assert.equal(res.output, null);
  });
});
