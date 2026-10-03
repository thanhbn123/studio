/**
 * G06/G08 — TEST CHUẨN HOÁ.
 *
 * Yêu cầu trọng tâm của đề bài: "3 nguồn → cùng Product Master schema" và
 * "không để frontend phải hiểu raw data của Taobao/1688/PDD".
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEmptyMaster,
  validateMaster,
  evidenceTable,
  mergeMasters,
  recomputeEvidence,
  STATUS,
  PROVENANCE,
} from '../src/product-master.js';
import { mergeKnowledge, buildFactSheet, fact } from '../src/merge/knowledge-merge.js';
import { sampleMaster } from './helpers.js';

const SCHEMA_KEYS = [
  'source',
  'source_url',
  'canonical_url',
  'source_product_id',
  'title_original',
  'images',
  'videos',
  'variants',
  'attributes',
  'price',
  'description_original',
  'store',
  'extraction',
];

describe('G06 — Product Master schema', () => {
  test('khung rỗng có ĐỦ khoá và mặc định NOT_FOUND (chưa chứng minh được)', () => {
    const m = createEmptyMaster();
    for (const k of SCHEMA_KEYS) assert.ok(k in m, `thiếu khoá ${k}`);
    assert.equal(m.title_original_status, STATUS.NOT_FOUND);
    assert.equal(m.price.status, STATUS.NOT_FOUND);
    assert.equal(m.store.status, STATUS.NOT_FOUND);
    assert.equal(m.description_original_status, STATUS.NOT_FOUND);
    assert.ok(Array.isArray(m.images) && Array.isArray(m.videos));
    assert.ok(Array.isArray(m.variants) && Array.isArray(m.attributes));
    assert.equal(m.price.currency, 'CNY');
  });

  test('3 nguồn khác nhau → CÙNG một bộ khoá', () => {
    const bases = [
      createEmptyMaster({ source: 'taobao' }),
      createEmptyMaster({ source: '1688' }),
      createEmptyMaster({ source: 'pinduoduo' }),
    ];
    const shapes = bases.map((b) => Object.keys(b).sort().join(','));
    assert.equal(new Set(shapes).size, 1, 'cả 3 nguồn phải cho cùng bộ khoá');
    for (const b of bases) {
      const v = validateMaster(b);
      assert.equal(v.valid, true, v.errors.join('; '));
    }
  });

  test('validateMaster bắt được master sai', () => {
    assert.equal(validateMaster(null).valid, false);
    assert.equal(validateMaster({ source: 'shopee' }).valid, false);
    const bad = createEmptyMaster({ source: 'taobao' });
    bad.price = { raw: '1', currency: 'CNY', status: 'KHONG_CO_TRONG_ENUM' };
    assert.equal(validateMaster(bad).valid, false);
    const badImg = createEmptyMaster({ source: 'taobao' });
    badImg.images = [{ url: 'x', type: 'khong-hop-le', status: 'FOUND' }];
    assert.equal(validateMaster(badImg).valid, false);
  });

  test('giá KHÔNG được gộp bậc thành giá cố định', () => {
    const m = createEmptyMaster({ source: '1688' });
    m.price = { raw: '¥7.2-12.5', currency: 'CNY', status: STATUS.FOUND, kind: 'tier', tiers: [{ min_quantity: 2, price: 12.5 }] };
    assert.equal(validateMaster(m).valid, true);
    assert.equal(m.price.kind, 'tier');
    const ev = evidenceTable(m);
    const priceRow = ev.rows.find((r) => r.label === 'Giá hiển thị');
    assert.match(priceRow.detail, /tier/);
  });

  test('evidence KHỚP dữ liệu thật (không hardcode NOT_FOUND)', () => {
    const m = createEmptyMaster({ source: 'pinduoduo' });
    // Trường hợp bị chặn: mọi field phải nói rõ lý do, không im lặng thành NOT_FOUND
    m.extraction.field_status = {
      images: STATUS.LOGIN_REQUIRED,
      variants: STATUS.LOGIN_REQUIRED,
      attributes: STATUS.LOGIN_REQUIRED,
      videos: STATUS.NOT_FOUND,
    };
    recomputeEvidence(m);
    const rows = Object.fromEntries(evidenceTable(m).rows.map((r) => [r.label, r.status]));
    assert.equal(rows['Ảnh'], STATUS.LOGIN_REQUIRED);
    assert.equal(rows['SKU / Biến thể'], STATUS.LOGIN_REQUIRED);
    assert.equal(rows['Thuộc tính'], STATUS.LOGIN_REQUIRED);
    assert.equal(rows['Video'], STATUS.NOT_FOUND);
  });

  test('mergeMasters không ghi đè bằng giá trị rỗng', () => {
    const base = sampleMaster();
    const later = createEmptyMaster({ source: 'manual' });
    later.title_original = ''; // rỗng → không được ghi đè
    const merged = mergeMasters(base, later);
    assert.equal(merged.title_original, base.title_original);
  });

  test('mergeMasters gộp ảnh thủ công vào master có sẵn', () => {
    const base = sampleMaster();
    const manual = createEmptyMaster({ source: 'manual' });
    manual.images = [{ url: 'https://x/y.jpg', type: 'gallery', status: STATUS.FOUND, provenance: PROVENANCE.USER }];
    const merged = mergeMasters(base, manual);
    assert.equal(merged.images.length, base.images.length + 1);
    assert.equal(validateMaster(merged).valid, true);
  });
});

describe('G08 — hợp nhất tri thức có gắn nhãn nguồn gốc', () => {
  const vision = {
    analysis: {
      product_type: 'đồ chơi毛绒',
      visible_features: ['hình con sâu nhiều chân', 'màu sắc rực rỡ'],
      visible_text: [],
      colors: ['đỏ', 'vàng'],
      likely_use_cases: ['trang trí phòng'],
      uncertain_claims: ['chưa xác định chất liệu'],
    },
    used: 2,
    provider: 'mock',
    model: 'mock-1',
  };

  test('thứ tự ưu tiên: source > vision > inference', () => {
    const k = mergeKnowledge(sampleMaster(), vision);
    const provs = k.facts.map((f) => f.provenance);
    const firstInference = provs.indexOf(PROVENANCE.INFERENCE);
    const lastSource = provs.lastIndexOf(PROVENANCE.SOURCE);
    const lastVision = provs.lastIndexOf(PROVENANCE.VISION);
    assert.ok(lastSource <= (firstInference === -1 ? Infinity : firstInference), 'source phải xếp trước inference');
    if (lastVision !== -1 && firstInference !== -1) {
      assert.ok(lastVision < firstInference, 'vision phải xếp trước inference');
    }
  });

  test('mọi fact đều CÓ nhãn provenance', () => {
    const k = mergeKnowledge(sampleMaster(), vision);
    for (const f of k.facts) {
      assert.ok(
        [PROVENANCE.SOURCE, PROVENANCE.VISION, PROVENANCE.INFERENCE, PROVENANCE.USER].includes(f.provenance),
        `fact thiếu nhãn hợp lệ: ${JSON.stringify(f)}`,
      );
      assert.ok(f.label && f.value);
    }
  });

  test('giá theo bậc sinh cảnh báo "không phải giá cố định"', () => {
    const k = mergeKnowledge(sampleMaster(), vision);
    assert.ok(
      k.uncertain_claims.some((u) => /giá|tier|khoảng/i.test(u)),
      'phải cảnh báo giá không cố định',
    );
    const priceFact = k.facts.find((f) => /Giá/.test(f.label));
    assert.match(priceFact.note, /bậc|KHOẢNG|không phải/i);
  });

  test('factSheet liệt kê điều CẤM thêm thông tin ngoài danh sách', () => {
    const sheet = buildFactSheet(sampleMaster(), mergeKnowledge(sampleMaster(), vision));
    assert.match(sheet, /TUYỆT ĐỐI không thêm/i);
    assert.match(sheet, /bảo hành/);
    assert.match(sheet, /xuất xứ/);
  });

  test('fact() cắt độ dài và làm sạch', () => {
    const f = fact('a', 'x'.repeat(10000), PROVENANCE.SOURCE);
    assert.ok(f.value.length <= 4001);
  });
});
