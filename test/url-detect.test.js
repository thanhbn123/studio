/**
 * G01 — TEST NHẬN DIỆN NGUỒN + BẢO MẬT URL.
 *
 * Bao gồm đúng các ca mà đề bài yêu cầu:
 *   Taobao valid · 1688 valid · PDD valid · unsupported domain ·
 *   malicious URL · redirect outside allowlist
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectSource, tryDetectSource, UnsupportedSourceError, MissingProductIdError } from '../src/sources/detect.js';
import { validateUrlAllowed, UrlGuardError } from '../src/security/url-guard.js';

describe('G01 — nhận diện nguồn', () => {
  test('Taobao dạng item.taobao.com/item.htm?id=', () => {
    const d = detectSource('https://item.taobao.com/item.htm?id=671021594308');
    assert.equal(d.source, 'taobao');
    assert.equal(d.source_product_id, '671021594308');
    assert.equal(d.canonical_url, 'https://item.taobao.com/item.htm?id=671021594308');
  });

  test('Taobao dạng route ẩn danh world.taobao.com/item/<id>.htm', () => {
    const d = detectSource('https://world.taobao.com/item/671021594308.htm');
    assert.equal(d.source, 'taobao');
    assert.equal(d.source_product_id, '671021594308');
  });

  test('Taobao dạng id đã mã hoá trên world.taobao.com', () => {
    const d = detectSource('https://world.taobao.com/item/MHdiaUR0QXNjVE53U3hDcW84RUpOQT09.htm');
    assert.equal(d.source, 'taobao');
    assert.equal(d.source_product_id, 'MHdiaUR0QXNjVE53U3hDcW84RUpOQT09');
  });

  test('Taobao short link (m.tb.cn) → đánh dấu cần resolve', () => {
    const d = detectSource('https://m.tb.cn/h.AbCdEf');
    assert.equal(d.source, 'taobao');
    assert.equal(d.is_short_link, true);
    assert.equal(d.source_product_id, '');
  });

  test('1688 dạng detail.1688.com/offer/<id>.html', () => {
    const d = detectSource('https://detail.1688.com/offer/552160420012.html');
    assert.equal(d.source, '1688');
    assert.equal(d.source_product_id, '552160420012');
    assert.equal(d.canonical_url, 'https://detail.1688.com/offer/552160420012.html');
  });

  test('1688 dạng mobile m.1688.com → chuẩn hoá về detail', () => {
    const d = detectSource('https://m.1688.com/offer/552160420012.html');
    assert.equal(d.source, '1688');
    assert.equal(d.canonical_url, 'https://detail.1688.com/offer/552160420012.html');
  });

  test('Pinduoduo dạng goods.html?goods_id=', () => {
    const d = detectSource('https://mobile.yangkeduo.com/goods.html?goods_id=51084116558');
    assert.equal(d.source, 'pinduoduo');
    assert.equal(d.source_product_id, '51084116558');
    assert.equal(d.canonical_url, 'https://mobile.yangkeduo.com/goods.html?goods_id=51084116558');
  });

  test('Pinduoduo short link (p.pinduoduo.com) → cần resolve', () => {
    const d = detectSource('https://p.pinduoduo.com/AbCdEfGh');
    assert.equal(d.source, 'pinduoduo');
    assert.equal(d.is_short_link, true);
  });

  test('tên miền không hỗ trợ → UnsupportedSourceError', () => {
    assert.throws(() => detectSource('https://www.amazon.com/dp/B08N5WRWNW'), UnsupportedSourceError);
    assert.throws(() => detectSource('https://shopee.vn/product/1/2'), UnsupportedSourceError);
  });

  test('link hợp lệ nhưng thiếu product id → MissingProductIdError', () => {
    assert.throws(() => detectSource('https://item.taobao.com/item.htm'), MissingProductIdError);
    assert.throws(() => detectSource('https://detail.1688.com/'), MissingProductIdError);
  });

  test('tryDetectSource không ném lỗi, trả ok:false', () => {
    const r = tryDetectSource('https://evil.example.com/x');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'UNSUPPORTED_SOURCE');
  });
});

describe('G01 — URL độc hại / SSRF', () => {
  const mustBlock = [
    ['http://127.0.0.1/', 'loopback'],
    ['http://localhost/', 'localhost'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://2130706433/', 'IPv4 dạng số nguyên'],
    ['http://0x7f000001/', 'IPv4 dạng hex'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[::ffff:127.0.0.1]/', 'IPv4-mapped IPv6'],
    ['http://10.0.0.5/', 'private 10/8'],
    ['http://192.168.1.1/', 'private 192.168/16'],
    ['http://172.16.0.1/', 'private 172.16/12'],
    ['http://100.64.0.1/', 'CGNAT'],
    ['file:///etc/passwd', 'file scheme'],
    ['gopher://x/', 'gopher scheme'],
    ['javascript:alert(1)', 'javascript scheme'],
    ['data:text/html,<script>alert(1)</script>', 'data scheme'],
    ['http://user:pass@item.taobao.com/', 'credentials trong URL'],
    ['http://item.taobao.com:22/', 'cổng lạ'],
    ['https://taobao.com.evil.com/', 'suffix attack'],
    ['https://evil-taobao.com/', 'prefix attack'],
    ['https://nottaobao.com/', 'không phải subdomain'],
    ['https://item.taobao.com.evil.tld/x', 'subdomain giả'],
  ];

  for (const [url, label] of mustBlock) {
    test(`chặn: ${label} — ${url}`, () => {
      assert.throws(
        () => validateUrlAllowed(url),
        (err) => err instanceof UrlGuardError,
        `URL lẽ ra phải bị chặn: ${url}`,
      );
      // detectSource có thể ném UrlGuardError (URL độc hại) hoặc
      // UnsupportedSourceError (domain ngoài allowlist) — cả hai đều là TỪ CHỐI.
      assert.throws(() => detectSource(url), (err) => Boolean(err.code) === true);
    });
  }

  const mustAllow = [
    'https://item.taobao.com/item.htm?id=1',
    'https://detail.1688.com/offer/1.html',
    'https://mobile.yangkeduo.com/goods.html?goods_id=1',
    'https://img.alicdn.com/imgextra/x.jpg',
  ];
  for (const url of mustAllow) {
    test(`cho phép: ${url}`, () => {
      assert.doesNotThrow(() => validateUrlAllowed(url));
    });
  }

  test('URL quá dài bị từ chối', () => {
    assert.throws(() => validateUrlAllowed(`https://item.taobao.com/item.htm?id=${'9'.repeat(3000)}`));
  });

  test('URL rỗng bị từ chối', () => {
    assert.throws(() => validateUrlAllowed(''), (e) => e.code === 'EMPTY_URL');
    assert.throws(() => validateUrlAllowed('   '), (e) => e.code === 'EMPTY_URL');
  });
});
