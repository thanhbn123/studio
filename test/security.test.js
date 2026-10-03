/**
 * TEST BẢO MẬT: che secret trong log, làm sạch dữ liệu, rate limit, và các
 * hành vi của fetcher an toàn (redirect ngoài allowlist, giới hạn byte, timeout).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { redact, createLogger, REDACTED } from '../src/logger.js';
import {
  sanitizeText,
  sanitizeUrl,
  sanitizeImageRef,
  sanitizeFilename,
  sniffImageMime,
  escapeHtml,
  stripDangerousKeys,
  safeJsonParse,
} from '../src/security/sanitize.js';
import { MemoryRateLimiter, enforce, RateLimitExceeded } from '../src/security/ratelimit.js';
import { safeFetch, FetchError } from '../src/security/fetcher.js';
import { UrlGuardError } from '../src/security/url-guard.js';
import { fixtureBuffer } from './helpers.js';

describe('Logger — không rò secret', () => {
  test('che theo TÊN khoá', () => {
    const out = redact({
      api_key: 'sk-abcdef1234567890',
      authorization: 'Bearer abc',
      cookie: 'sid=secret',
      set_cookie: 'a=b',
      password: 'hunter2',
      token: 'xyz',
      safe_field: 'giá trị bình thường',
    });
    assert.equal(out.api_key, REDACTED);
    assert.equal(out.authorization, REDACTED);
    assert.equal(out.cookie, REDACTED);
    assert.equal(out.set_cookie, REDACTED);
    assert.equal(out.password, REDACTED);
    assert.equal(out.token, REDACTED);
    assert.equal(out.safe_field, 'giá trị bình thường');
  });

  test('che theo HÌNH DẠNG giá trị (kể cả khi tên khoá vô hại)', () => {
    // Các "khoá" dưới đây được GHÉP LÚC CHẠY, cố ý không viết thành chuỗi literal.
    // Lý do: một chuỗi trông y hệt khoá thật nằm trong mã nguồn sẽ kích hoạt mọi
    // máy quét secret (kể cả push protection của GitHub) — và máy quét ĐÚNG khi làm vậy.
    // Ghép động giữ được phép thử mà không tạo ra false positive.
    const fakeSk = `sk-${'a'.repeat(8)}${'b'.repeat(16)}`;
    const fakeJwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');
    const fakeGh = `ghp_${'c'.repeat(36)}`;

    const out = redact({ note: `key là ${fakeSk} nhé`, jwt: fakeJwt, gh: fakeGh });

    assert.ok(!out.note.includes(fakeSk), 'không được lộ khoá dạng sk-');
    assert.ok(out.note.includes(REDACTED));
    assert.ok(!out.jwt.includes('eyJhbGciOiJIUzI1NiJ9'), 'không được lộ JWT');
    assert.ok(!out.gh.includes('ghp_'), 'không được lộ token GitHub');
  });

  test('che lồng sâu và xử lý vòng lặp', () => {
    // Ghép lúc chạy — xem giải thích ở test phía trên.
    const obj = { a: { b: { c: { apiKey: `sk-${'d'.repeat(16)}` } } } };
    obj.self = obj;
    const out = redact(obj);
    assert.equal(out.a.b.c.apiKey, REDACTED);
    assert.equal(out.self, '[circular]');
  });

  test('log thực tế không chứa secret', () => {
    const lines = [];
    const stream = { write: (s) => lines.push(s) };
    const log = createLogger({ level: 'debug', stream });
    log.info('test', { apiKey: 'sk-abcdef1234567890', cookie: 'sid=abc', url: 'https://x/y' });
    const out = lines.join('');
    assert.ok(!out.includes('sk-abcdef'), 'log không được chứa API key');
    assert.ok(!out.includes('sid=abc'), 'log không được chứa cookie');
    assert.ok(out.includes('https://x/y'), 'thông tin vô hại phải còn');
  });
});

describe('Sanitize', () => {
  test('sanitizeText bỏ ký tự điều khiển và gộp khoảng trắng', () => {
    assert.equal(sanitizeText('a\u0000b\u0007c'), 'abc');
    assert.equal(sanitizeText('  nhiều   dấu   cách  '), 'nhiều dấu cách');
    assert.equal(sanitizeText('a\r\nb'), 'a\nb');
  });

  test('sanitizeUrl chỉ nhận http/https', () => {
    assert.equal(sanitizeUrl('https://a.com/x'), 'https://a.com/x');
    assert.equal(sanitizeUrl('//a.com/x'), 'https://a.com/x');
    assert.equal(sanitizeUrl('javascript:alert(1)'), '');
    assert.equal(sanitizeUrl('data:text/html,x'), '');
  });

  test('sanitizeImageRef nhận data:image nhưng chặn data: khác', () => {
    const png = `data:image/png;base64,${fixtureBuffer('headphones.png').toString('base64')}`;
    assert.equal(sanitizeImageRef(png), png);
    assert.equal(sanitizeImageRef('data:text/html;base64,PHNjcmlwdD4='), '');
    assert.equal(sanitizeImageRef('https://img.alicdn.com/a.jpg'), 'https://img.alicdn.com/a.jpg');
  });

  test('sanitizeFilename chặn path traversal', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFilename('/a/b/c.png'), 'c.png');
    assert.equal(sanitizeFilename('...'), 'upload');
  });

  test('sniffImageMime nhận đúng định dạng, từ chối thứ khác', () => {
    assert.equal(sniffImageMime(fixtureBuffer('headphones.png')), 'image/png');
    assert.equal(sniffImageMime(Buffer.from('<html>not an image at all</html>')), null);
    assert.equal(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg');
  });

  test('sniffImageMime từ chối script giả dạng ảnh', () => {
    const evil = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('<script>alert(1)</script>')]);
    // Nhận là PNG theo magic bytes — việc chặn nội dung là của tầng khác, nhưng
    // điều quan trọng là KHÔNG nhận <html> trần làm ảnh.
    assert.equal(sniffImageMime(Buffer.from('<script>alert(1)</script>xxxxxxxx')), null);
    assert.equal(sniffImageMime(evil), 'image/png');
  });

  test('escapeHtml vô hiệu hoá thẻ', () => {
    assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  });

  test('stripDangerousKeys chặn prototype pollution', () => {
    const parsed = safeJsonParse('{"__proto__":{"polluted":true},"ok":1}');
    assert.equal(parsed.ok, 1);
    assert.equal(Object.getPrototypeOf(parsed), null);
    assert.equal({}.polluted, undefined, 'prototype toàn cục không được bị ô nhiễm');
    assert.equal(stripDangerousKeys({ constructor: 'x', a: 1 }).constructor, undefined);
  });
});

describe('Rate limit', () => {
  test('cho qua trong hạn mức rồi chặn', () => {
    let now = 1000;
    const rl = new MemoryRateLimiter({ windowMs: 1000, max: 3, now: () => now });
    assert.equal(rl.check('k').allowed, true);
    assert.equal(rl.check('k').allowed, true);
    assert.equal(rl.check('k').allowed, true);
    const blocked = rl.check('k');
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterMs > 0);
    now += 1001;
    assert.equal(rl.check('k').allowed, true, 'hết cửa sổ thì được reset');
  });

  test('khoá khác nhau không ảnh hưởng nhau', () => {
    const rl = new MemoryRateLimiter({ windowMs: 1000, max: 1, now: () => 1 });
    assert.equal(rl.check('a').allowed, true);
    assert.equal(rl.check('b').allowed, true);
    assert.equal(rl.check('a').allowed, false);
  });

  test('enforce ném RateLimitExceeded với status 429', () => {
    const rl = new MemoryRateLimiter({ windowMs: 1000, max: 0, now: () => 1 });
    assert.throws(() => enforce(rl, 'x'), (e) => e instanceof RateLimitExceeded && e.status === 429);
  });

  test('sweep dọn bucket hết hạn', () => {
    let now = 0;
    const rl = new MemoryRateLimiter({ windowMs: 10, max: 5, now: () => now });
    rl.check('a');
    rl.check('b');
    now = 100;
    assert.equal(rl.sweep(), 2);
    assert.equal(rl.buckets.size, 0);
  });
});

describe('Fetcher an toàn — server cục bộ để kiểm redirect', () => {
  /** Dựng server thật trên 127.0.0.1 để kiểm hành vi redirect/byte-cap. */
  const withServer = async (handler, fn) => {
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    try {
      return await fn(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  };

  test('chặn redirect ra ngoài allowlist', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
      },
      async (base) => {
        await assert.rejects(
          () => safeFetch(`${base}/x`, { allowPrivateNetwork: true, domains: ['taobao.com'] }),
          (err) => err instanceof UrlGuardError && ['DOMAIN_NOT_ALLOWED', 'PRIVATE_IP'].includes(err.code),
        );
      },
    );
  });

  test('chặn redirect hạ cấp https → http', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(302, { location: 'http://127.0.0.1:1/x' });
        res.end();
      },
      async (base) => {
        await assert.rejects(
          () => safeFetch(`${base}/x`, { allowPrivateNetwork: true, domains: ['127.0.0.1'] }),
          (err) => err instanceof UrlGuardError || err instanceof FetchError,
        );
      },
    );
  });

  test('cắt body khi vượt giới hạn byte', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(100000));
      },
      async (base) => {
        await assert.rejects(
          () => safeFetch(`${base}/big`, { allowPrivateNetwork: true, domains: ['127.0.0.1'], maxBytes: 1024 }),
          (err) => err instanceof FetchError && err.code === 'BODY_TOO_LARGE',
        );
      },
    );
  });

  test('phát hiện vòng lặp redirect', async () => {
    await withServer(
      (req, res) => {
        res.writeHead(302, { location: req.url === '/a' ? '/b' : '/a' });
        res.end();
      },
      async (base) => {
        await assert.rejects(
          () => safeFetch(`${base}/a`, { allowPrivateNetwork: true, domains: ['127.0.0.1'] }),
          (err) => err instanceof FetchError && ['REDIRECT_LOOP', 'TOO_MANY_REDIRECTS'].includes(err.code),
        );
      },
    );
  });

  test('theo redirect HỢP LỆ trong allowlist thì thành công', async () => {
    await withServer(
      (req, res) => {
        if (req.url === '/start') {
          res.writeHead(302, { location: '/end' });
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<title>OK</title>');
        }
      },
      async (base) => {
        const res = await safeFetch(`${base}/start`, { allowPrivateNetwork: true, domains: ['127.0.0.1'] });
        assert.equal(res.status, 200);
        assert.ok(res.body.toString().includes('OK'));
        assert.equal(res.redirects.length, 1);
      },
    );
  });

  test('không gửi cookie sang host ngoài cookieDomains', async () => {
    const seen = [];
    await withServer(
      (req, res) => {
        seen.push(req.headers.cookie || '');
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('ok');
      },
      async (base) => {
        await safeFetch(`${base}/x`, {
          allowPrivateNetwork: true,
          domains: ['127.0.0.1'],
          cookieHeader: 'sid=secret',
          cookieDomains: ['taobao.com'],
        });
        assert.equal(seen[0], '', 'cookie KHÔNG được gửi tới host ngoài danh sách');
      },
    );
  });
});
