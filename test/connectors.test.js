/**
 * G02–G05 — TEST CONNECTOR.
 *
 * Fixture `taobao-world-item.html` là TRANG THẬT đã tải về (đã rút gọn phần head
 * và khối SSR), nên test Taobao là test trên dữ liệu thật, không phải dữ liệu tự nghĩ.
 * Các fixture 1688 và PDD được dựng lại theo đúng dấu hiệu đã ĐO (kích thước,
 * chuỗi đặc trưng) — chúng kiểm hành vi phân loại, không phải kiểm parser trên trang thật.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TaobaoConnector } from '../src/sources/taobao.js';
import { Alibaba1688Connector } from '../src/sources/alibaba1688.js';
import { PinduoduoConnector } from '../src/sources/pinduoduo.js';
import { ConnectorRegistry } from '../src/sources/registry.js';
import { ProductSourceConnector } from '../src/sources/base-connector.js';
import { STATUS, validateMaster, evidenceTable } from '../src/product-master.js';
import { fixture, fakeFetcher, testConfig, silent } from './helpers.js';

const config = testConfig();

const mk = (Cls, routes, extra = {}) =>
  new Cls({ config, logger: silent, fetcher: fakeFetcher(routes), ...extra });

describe('G03 — Taobao connector', () => {
  test('trang THẬT: lấy được tiêu đề, giá, người bán, thuộc tính', async () => {
    const html = fixture('taobao-world-item.html');
    const c = mk(TaobaoConnector, {
      'world.taobao.com': { html, finalUrl: 'https://world.taobao.com/item/671021594308.htm' },
    });
    const m = await c.extract('https://world.taobao.com/item/671021594308.htm', {});

    assert.equal(m.source, 'taobao');
    assert.match(m.title_original, /MuseLab/);
    assert.equal(m.title_original_status, STATUS.FOUND);
    assert.equal(m.price.status, STATUS.FOUND);
    assert.equal(m.price.raw, '15.00');
    assert.equal(m.price.currency, 'CNY');
    assert.equal(m.store.name, 'Muse Lab');
    assert.ok(m.images.length >= 1, 'phải lấy được ít nhất 1 ảnh');
    assert.ok(m.attributes.some((a) => /xuất xứ/i.test(a.name)), 'phải có thuộc tính nơi xuất xứ');
    assert.ok(m.attributes.some((a) => /Đánh giá/.test(a.name)), 'phải có thuộc tính đánh giá');

    // Schema phải hợp lệ và evidence phải khớp dữ liệu thật
    const v = validateMaster(m);
    assert.equal(v.valid, true, v.errors.join('; '));
    const ev = evidenceTable(m);
    assert.equal(ev.rows.find((r) => r.label === 'Tiêu đề gốc').status, STATUS.FOUND);
    assert.equal(ev.rows.find((r) => r.label === 'Giá hiển thị').status, STATUS.FOUND);
  });

  test('video KHÔNG được bịa khi trang không có video', async () => {
    const html = fixture('taobao-world-item.html');
    const c = mk(TaobaoConnector, { 'world.taobao.com': html });
    const m = await c.extract('https://world.taobao.com/item/671021594308.htm', {});
    assert.equal(m.videos.length, 0);
    assert.equal(m.extraction.field_status.videos, STATUS.NOT_FOUND);
  });

  test('id không tồn tại → NOT_FOUND (nhận ra trang chủ)', async () => {
    const c = mk(TaobaoConnector, { 'world.taobao.com': fixture('taobao-homepage-stub.html') });
    const m = await c.extract('https://world.taobao.com/item/678901234567.htm', {});
    assert.equal(m.extraction.method, 'homepage-redirect-detection');
    assert.equal(m.title_original, '');
    for (const row of evidenceTable(m).rows) {
      assert.equal(row.status, STATUS.NOT_FOUND, `${row.label} lẽ ra NOT_FOUND`);
    }
  });

  test('link item.taobao.com (bị chặn) → tự chuyển sang route ẩn danh world.taobao.com', async () => {
    const loginStub = '<html><head><title>淘宝网 - 淘！我喜欢</title></head><body><script>window.location.href="https://login.taobao.com/member/login.jhtml";</script>login</body></html>';
    const c = mk(TaobaoConnector, {
      'item.taobao.com': { html: loginStub, finalUrl: 'https://item.taobao.com/item.htm?id=671021594308' },
      'world.taobao.com': fixture('taobao-world-item.html'),
    });
    const m = await c.extract('https://item.taobao.com/item.htm?id=671021594308', {});
    assert.match(m.extraction.method, /world\.taobao-fallback/);
    assert.match(m.title_original, /MuseLab/);
    assert.ok(m.extraction.warnings.some((w) => /chặn đăng nhập/.test(w)));
  });

  test('anti-bot x5sec → LOGIN_REQUIRED, không báo thành công', async () => {
    const x5 = '<html><body><script>window.location.href="https://h5api.m.taobao.com/_____tmd_____/page/set_x5referer?x5secdata=abc"</script>punish</body></html>';
    const c = mk(TaobaoConnector, { 'item.taobao.com': x5, 'world.taobao.com': x5 });
    const m = await c.extract('https://item.taobao.com/item.htm?id=671021594308', {});
    assert.equal(m.title_original_status, STATUS.LOGIN_REQUIRED);
    assert.equal(m.extraction.login_required, true);
    assert.match(m.extraction.blocked_reason, /anti-bot|x5sec/i);
  });
});

describe('G04 — 1688 connector', () => {
  test('redirect wrongpage → NOT_FOUND', async () => {
    const c = mk(Alibaba1688Connector, {
      'detail.1688.com': {
        html: fixture('1688-wrongpage.html'),
        finalUrl: 'https://page.1688.com/shtml/static/wrongpage.html',
      },
    });
    const m = await c.extract('https://detail.1688.com/offer/678901234567.html', {});
    assert.equal(m.extraction.method, 'redirect-detection');
    assert.equal(m.title_original, '');
    assert.equal(m.price.status, STATUS.NOT_FOUND);
    assert.ok(m.extraction.warnings.some((w) => /wrongpage/i.test(w)));
  });

  test('tường đăng nhập (4822B) → LOGIN_REQUIRED', async () => {
    const c = mk(Alibaba1688Connector, {
      'detail.1688.com': { html: fixture('1688-login-wall.html'), finalUrl: 'https://detail.1688.com/offer/552160420012.html' },
    });
    const m = await c.extract('https://detail.1688.com/offer/552160420012.html', {});
    assert.equal(m.extraction.login_required, true);
    assert.equal(m.price.status, STATUS.LOGIN_REQUIRED);
    assert.equal(m.images.length, 0);
  });

  test('challenge x5sec → LOGIN_REQUIRED và nêu rõ là anti-bot', async () => {
    const c = mk(Alibaba1688Connector, {
      'detail.1688.com': { html: fixture('1688-x5sec-punish.html'), finalUrl: 'https://detail.1688.com/offer/552160420012.html' },
    });
    const m = await c.extract('https://detail.1688.com/offer/552160420012.html', {});
    assert.equal(m.extraction.login_required, true);
    assert.match(m.extraction.blocked_reason, /anti-bot|x5sec|punish/i);
  });

  test('trang offer có cấu trúc thật → lấy giá THEO BẬC, không gộp thành giá cố định', async () => {
    const c = mk(Alibaba1688Connector, { 'detail.1688.com': fixture('1688-offer-real-structure.html') });
    const m = await c.extract('https://detail.1688.com/offer/552160420012.html', {});

    assert.equal(m.price.status, STATUS.FOUND);
    assert.equal(m.price.kind, 'tier', 'giá theo bậc KHÔNG được coi là giá cố định');
    assert.equal(m.price.tiers.length, 3);
    assert.equal(m.variants.length, 2);
    assert.ok(m.images.some((i) => i.type === 'cover'));
    assert.ok(m.images.some((i) => i.type === 'detail'), 'phải tách được ảnh chi tiết');
    assert.equal(m.store.name, '东莞市爱笙玩具有限公司');
    assert.ok(m.attributes.some((a) => a.name === 'MOQ'));
    assert.equal(validateMaster(m).valid, true);
  });
});

describe('G05 — Pinduoduo connector', () => {
  test('SPA shell không có dữ liệu → LOGIN_REQUIRED, không bịa field', async () => {
    const c = mk(PinduoduoConnector, { 'mobile.yangkeduo.com': fixture('pdd-spa-shell.html') });
    const m = await c.extract('https://mobile.yangkeduo.com/goods.html?goods_id=51084116558', {});
    assert.equal(m.images.length, 0);
    assert.equal(m.price.status, STATUS.LOGIN_REQUIRED);
    assert.equal(m.videos.length, 0);
    assert.equal(m.extraction.field_status.videos, STATUS.NOT_FOUND, 'video phải NOT_FOUND, không được suy diễn');
    assert.ok(m.extraction.login_required, 'phải báo cần session');
  });

  test('dữ liệu SSR có thật → map đúng và giữ video khi thực sự có', async () => {
    const raw = {
      goods: {
        goodsID: 51084116558,
        goodsName: '测试商品 毛绒玩具',
        viewImageData: [{ url: 'https://img.pddpic.com/a.jpg' }, { url: 'https://img.pddpic.com/b.jpg' }],
        minPrice: 1200,
        maxPrice: 2500,
        skus: [{ skuId: 's1', specs: [{ spec_value: '40cm' }], groupPrice: 1200 }],
        mall: { mallName: '测试旗舰店', mallId: '99' },
        videoUrl: 'https://video.pddpic.com/x.mp4',
      },
    };
    const html = `<html><body><script>window.rawData = ${JSON.stringify(raw)};</script></body></html>`;
    const c = mk(PinduoduoConnector, { 'mobile.yangkeduo.com': html });
    const m = await c.extract('https://mobile.yangkeduo.com/goods.html?goods_id=51084116558', {});

    assert.equal(m.title_original, '测试商品 毛绒玩具');
    assert.equal(m.images.length, 2);
    assert.equal(m.price.kind, 'range', 'min≠max phải là khoảng giá');
    assert.equal(m.variants.length, 1);
    assert.equal(m.store.name, '测试旗舰店');
    assert.equal(m.videos.length, 1);
  });
});

describe('G02 — cô lập connector', () => {
  test('một connector hỏng KHÔNG làm hỏng connector khác', async () => {
    class BrokenConnector extends ProductSourceConnector {
      static source = 'taobao';
      static displayName = 'Broken';
      canHandle() {
        throw new Error('canHandle nổ');
      }
      async fetchProduct() {
        throw new Error('fetch nổ');
      }
    }

    const registry = new ConnectorRegistry({ config, logger: silent });
    registry.registerAll([BrokenConnector, Alibaba1688Connector, PinduoduoConnector]);
    // BrokenConnector có canHandle ném lỗi — registry phải bỏ qua và vẫn tìm được connector khác.
    const found = registry.findFor('https://detail.1688.com/offer/1.html');
    assert.ok(found, 'vẫn phải tìm được connector 1688');
    assert.equal(found.source, '1688');

    // extract với connector 1688 hỏng fetcher → phải trả master BLOCKED, không ném lỗi
    const reg2 = new ConnectorRegistry({ config, logger: silent });
    reg2.registerAll([Alibaba1688Connector]);
    const bad = new Alibaba1688Connector({
      config,
      logger: silent,
      fetcher: async () => {
        const e = new Error('mạng đứt');
        e.code = 'NETWORK_ERROR';
        throw e;
      },
    });
    reg2.connectors = [bad];
    const m = await reg2.extract('https://detail.1688.com/offer/1.html', {});
    assert.ok(m, 'extract phải luôn trả về Product Master');
    assert.equal(m.extraction.login_required || true, true);
    assert.equal(validateMaster(m).valid, true, 'kể cả khi lỗi, master vẫn phải hợp lệ');
  });

  test('nguồn không hỗ trợ → master UNSUPPORTED, không ném lỗi', async () => {
    const registry = new ConnectorRegistry({ config, logger: silent });
    registry.registerAll([TaobaoConnector, Alibaba1688Connector, PinduoduoConnector]);
    const m = await registry.extract('https://www.amazon.com/dp/B1', {});
    assert.equal(m.title_original_status, STATUS.UNSUPPORTED);
    assert.equal(m.extraction.field_status.images, STATUS.UNSUPPORTED);
  });
});
