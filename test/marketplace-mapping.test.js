/**
 * TEST MVP-08 · ÁNH XẠ + PREFLIGHT (`src/marketplace/{preflight,mapping/*}.js`) — hợp đồng §3.
 *
 * Đối chứng HAI CHIỀU: đủ trường ⇒ payload đúng từng trường cho cả hai sàn; thiếu trường ⇒ `issues[]`
 * nêu ĐÚNG tên trường thiếu. Giá CNY của nguồn KHÔNG bao giờ được tự biến thành giá VND.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { buildListingInput, preflight, hasBlockingIssue, CHANNEL_LIMITS, OVERRIDE_FIELDS } from '../src/marketplace/preflight.js';
import { mapToShopee } from '../src/marketplace/mapping/shopee.js';
import { mapToTiktokShop } from '../src/marketplace/mapping/tiktokshop.js';
import { mapForChannel, defaultRunKey, sanitizeOverrides } from '../src/marketplace/publish.js';
import { shopeeSign } from '../src/marketplace/providers/shopee.js';
import { tiktokSign } from '../src/marketplace/providers/tiktokshop.js';

const JOB = {
  id: '11111111-1111-4111-8111-111111111111',
  source: '1688',
  product_name: 'Tai nghe chụp tai',
  product_master: {
    source: '1688',
    canonical_url: 'https://detail.1688.com/offer/1.html',
    images: [
      { url: 'https://img.example.com/a.jpg', status: 'FOUND' },
      { url: 'http://img.example.com/khong-https.jpg', status: 'FOUND' },
      { url: 'https://img.example.com/b.jpg', status: 'NOT_FOUND' },
    ],
    price: { raw: '¥12.00 - ¥25.00', currency: 'CNY', kind: 'range', status: 'FOUND' },
    variants: [{ sku_id: 's1', name: 'Đỏ', price_raw: '¥12' }],
    attributes: [{ name: 'Chất liệu', value: 'Nhựa' }],
    source_product_id: '1',
  },
  content: {
    product_name: 'Tai nghe chụp tai không dây',
    headline: 'Tiêu đề bán hàng',
    marketplace_description: 'Mô tả cho sàn: gạch đầu dòng rõ ràng, trung thực, đủ dài hơn hai mươi ký tự.',
  },
};

const FULL = { price_vnd: 199000, stock: 7, weight_g: 250, category_id: '100001', brand: 'VIP', length_cm: 10, width_cm: 5, height_cm: 3 };

describe('MVP-08 · buildListingInput — nguồn gốc từng trường', () => {
  test('tên/mô tả lấy từ nội dung tiếng Việt; ảnh chỉ nhận https + FOUND; giá/tồn/cân nặng CHỈ từ overrides', () => {
    const inp = buildListingInput(JOB, FULL);
    assert.equal(inp.title, 'Tai nghe chụp tai không dây');
    assert.equal(inp.provenance.title, 'content');
    assert.match(inp.description, /^Mô tả cho sàn/);
    assert.deepEqual(inp.images, ['https://img.example.com/a.jpg'], 'bỏ ảnh http và ảnh NOT_FOUND');
    assert.equal(inp.provenance.images, 'master');
    assert.equal(inp.price_vnd, 199000);
    assert.equal(inp.provenance.price_vnd, 'override');
    assert.equal(inp.source.price_raw, '¥12.00 - ¥25.00', 'giá CNY giữ làm tham khảo, KHÔNG thành price_vnd');
    assert.equal(inp.sku, '1', 'SKU rơi về source_product_id khi không ghi đè');
    assert.equal(inp.variants.length, 1);
  });

  test('không overrides ⇒ price_vnd/stock/weight_g/category_id = null (KHÔNG tự quy đổi từ CNY)', () => {
    const inp = buildListingInput(JOB, {});
    assert.equal(inp.price_vnd, null);
    assert.equal(inp.stock, null);
    assert.equal(inp.weight_g, null);
    assert.equal(inp.category_id, null);
    assert.equal(inp.provenance.price_vnd, null);
  });

  test('override tên/mô tả thắng nội dung job; chuỗi có ký tự điều khiển bị lọc', () => {
    const inp = buildListingInput(JOB, { title: 'Tên\u0000 ghi đè', description: 'x'.repeat(30) });
    assert.equal(inp.title, 'Tên ghi đè');
    assert.equal(inp.provenance.title, 'override');
    assert.equal(inp.provenance.description, 'override');
  });

  test('sanitizeOverrides chỉ giữ khoá trong danh sách trắng', () => {
    const ov = sanitizeOverrides({ price_vnd: 1, user_id: 'x', __proto__: { a: 1 }, status: 'published' });
    assert.deepEqual(Object.keys(ov), ['price_vnd']);
    assert.ok(OVERRIDE_FIELDS.includes('price_vnd'));
  });
});

describe('MVP-08 · preflight — thiếu trường ⇒ issues[] nêu đúng tên trường', () => {
  test('đủ trường ⇒ chỉ còn cảnh báo (variants), KHÔNG lỗi chặn', () => {
    const issues = preflight('shopee', buildListingInput(JOB, FULL));
    assert.equal(hasBlockingIssue(issues), false, JSON.stringify(issues));
    assert.deepEqual(issues.map((i) => i.field), ['variants']);
    assert.equal(issues[0].severity, 'warn');
  });

  test('không overrides ⇒ nêu đúng price_vnd, stock, weight_g, category_id (+ cảnh báo kích thước)', () => {
    const issues = preflight('shopee', buildListingInput(JOB, {}));
    const blocking = issues.filter((i) => i.severity !== 'warn').map((i) => i.field).sort();
    assert.deepEqual(blocking, ['category_id', 'price_vnd', 'stock', 'weight_g']);
    assert.ok(issues.every((i) => i.message && i.code), 'mỗi dòng có mã + câu');
    assert.ok(hasBlockingIssue(issues));
  });

  test('job không có nội dung và không có ảnh ⇒ nêu title, description, images', () => {
    const issues = preflight('tiktokshop', buildListingInput({ id: 'x', product_master: { images: [] }, content: null }, FULL));
    const fields = issues.filter((i) => i.severity !== 'warn').map((i) => i.field);
    for (const f of ['title', 'description', 'images']) assert.ok(fields.includes(f), `thiếu ${f}: ${fields}`);
  });

  test('giới hạn theo sàn: tiêu đề 121 ký tự vượt Shopee (120) nhưng qua TikTok (255)', () => {
    const inp = buildListingInput(JOB, { ...FULL, title: 'T'.repeat(121) });
    assert.ok(preflight('shopee', inp).some((i) => i.field === 'title' && i.code === 'TOO_LONG'));
    assert.ok(!preflight('tiktokshop', inp).some((i) => i.field === 'title'));
    assert.equal(CHANNEL_LIMITS.shopee.title_max, 120);
    assert.equal(CHANNEL_LIMITS['dry-run'].title_max, 120, 'dry-run dùng mức CHẶT hơn để qua thử là qua thật');
  });

  test('giá/tồn/cân nặng sai kiểu ⇒ INVALID (không làm tròn im lặng)', () => {
    const issues = preflight('dry-run', buildListingInput(JOB, { ...FULL, price_vnd: 199000.5, stock: -1, weight_g: 0 }));
    const byField = Object.fromEntries(issues.map((i) => [i.field, i.code]));
    assert.equal(byField.price_vnd, 'INVALID');
    assert.equal(byField.stock, 'INVALID');
    assert.equal(byField.weight_g, 'INVALID');
  });

  test('kích thước thiếu một chiều ⇒ INCOMPLETE; thiếu cả ba ⇒ chỉ cảnh báo', () => {
    assert.ok(preflight('dry-run', buildListingInput(JOB, { ...FULL, height_cm: undefined })).some((i) => i.field === 'dimensions' && i.code === 'INCOMPLETE'));
    const { length_cm, width_cm, height_cm, ...noDims } = FULL;
    const warn = preflight('dry-run', buildListingInput(JOB, noDims)).find((i) => i.field === 'dimensions');
    assert.equal(warn.severity, 'warn');
  });

  test('kênh lạ ⇒ CHANNEL_UNKNOWN', () => {
    assert.equal(preflight('lazada', buildListingInput(JOB, FULL))[0].code, 'CHANNEL_UNKNOWN');
  });
});

describe('MVP-08 · ánh xạ Shopee / TikTok Shop — đủ trường ⇒ payload đúng từng trường', () => {
  const input = buildListingInput(JOB, FULL);

  test('Shopee: item_name/description/original_price/seller_stock/weight(kg)/category_id/dimension/brand; ảnh + logistic khai unmapped', () => {
    const { payload, unmapped, defaults_applied } = mapToShopee(input);
    assert.equal(payload.item_name, 'Tai nghe chụp tai không dây');
    assert.equal(payload.original_price, 199000);
    assert.deepEqual(payload.seller_stock, [{ stock: 7 }]);
    assert.equal(payload.weight, 0.25, 'gram → kg');
    assert.equal(payload.category_id, 100001, 'mã số ⇒ Number');
    assert.deepEqual(payload.dimension, { package_length: 10, package_width: 5, package_height: 3 });
    assert.equal(payload.brand.original_brand_name, 'VIP');
    assert.equal(payload.item_sku, '1');
    assert.deepEqual(payload.image.image_id_list, [], 'KHÔNG bịa image_id');
    assert.deepEqual(payload._vps_image_urls, ['https://img.example.com/a.jpg']);
    const fields = unmapped.map((u) => u.field);
    for (const f of ['logistic_info', 'image.image_id_list', 'tier_variation/model', 'attribute_list', 'brand.brand_id']) assert.ok(fields.includes(f), `unmapped thiếu ${f}`);
    assert.ok(defaults_applied.some((d) => d.field === 'item_status' && d.value === 'UNLIST'), 'mặc định UNLIST được khai ra, không im lặng');
  });

  test('TikTok Shop: title/description/skus[0].price.amount (chuỗi VND)/inventory.quantity/package_weight KILOGRAM/save_mode AS_DRAFT', () => {
    const { payload, unmapped, defaults_applied } = mapToTiktokShop(input);
    assert.equal(payload.title, 'Tai nghe chụp tai không dây');
    assert.equal(payload.category_id, '100001');
    assert.deepEqual(payload.skus[0].price, { amount: '199000', currency: 'VND' });
    assert.equal(payload.skus[0].inventory[0].quantity, 7);
    assert.equal(payload.skus[0].inventory[0].warehouse_id, null, 'warehouse_id KHÔNG bịa');
    assert.deepEqual(payload.package_weight, { value: '0.25', unit: 'KILOGRAM' });
    assert.deepEqual(payload.package_dimensions, { length: '10', width: '5', height: '3', unit: 'CENTIMETER' });
    assert.deepEqual(payload.main_images, []);
    assert.equal(payload.save_mode, 'AS_DRAFT');
    const fields = unmapped.map((u) => u.field);
    for (const f of ['skus[0].inventory[0].warehouse_id', 'main_images[].uri', 'brand_id']) assert.ok(fields.includes(f), `unmapped thiếu ${f}`);
    assert.ok(defaults_applied.some((d) => d.field === 'save_mode'));
  });

  test('thiếu trường ⇒ payload KHÔNG điền mặc định cho dữ liệu (null), và preflight đã chặn từ trước', () => {
    const thin = buildListingInput(JOB, {});
    assert.equal(mapToShopee(thin).payload.original_price, null);
    assert.deepEqual(mapToShopee(thin).payload.seller_stock, []);
    assert.equal(mapToTiktokShop(thin).payload.package_weight, null);
    assert.equal(mapToTiktokShop(thin).payload.skus[0].price.amount, null);
  });

  test('dry-run: payload giữ đầu vào + bản xem trước CẢ hai sàn; unmapped gắn tên kênh', () => {
    const m = mapForChannel('dry-run', input);
    assert.equal(m.payload.dry_run, true);
    assert.equal(m.payload.listing.title, input.title);
    assert.equal(m.payload.previews.shopee.item_name, input.title);
    assert.equal(m.payload.previews.tiktokshop.title, input.title);
    assert.ok(m.unmapped.every((u) => ['shopee', 'tiktokshop'].includes(u.channel)));
  });

  test('run_key mặc định tất định theo (job, kênh)', () => {
    assert.equal(defaultRunKey(JOB.id, 'shopee'), `${JOB.id}#shopee`);
  });
});

describe('MVP-08 · chữ ký provider thật — tất định, đổi path/body là đổi chữ ký', () => {
  test('Shopee: HMAC-SHA256 hex 64 ký tự, ổn định, đổi path ⇒ khác', () => {
    const a = shopeeSign({ partnerId: '1001', partnerKey: 'k', path: '/api/v2/product/add_item', timestamp: 1700000000, accessToken: 't', shopId: '9' });
    const b = shopeeSign({ partnerId: '1001', partnerKey: 'k', path: '/api/v2/product/add_item', timestamp: 1700000000, accessToken: 't', shopId: '9' });
    const c = shopeeSign({ partnerId: '1001', partnerKey: 'k', path: '/api/v2/product/update_price', timestamp: 1700000000, accessToken: 't', shopId: '9' });
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  test('TikTok: bỏ sign/access_token khỏi tham số, sắp theo khoá, body ảnh hưởng chữ ký', () => {
    const base = { appSecret: 's', path: '/product/202309/products', query: { timestamp: '1', app_key: 'k', shop_cipher: 'c', sign: 'x', access_token: 'y' } };
    const a = tiktokSign(base);
    const b = tiktokSign({ ...base, query: { shop_cipher: 'c', app_key: 'k', timestamp: '1' } });
    const c = tiktokSign({ ...base, body: { title: 'x' } });
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, b, 'thứ tự khoá và sign/access_token không ảnh hưởng');
    assert.notEqual(a, c);
  });
});
