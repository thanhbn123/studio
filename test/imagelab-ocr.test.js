/**
 * TEST MVP-02 · OCR (C1) — `src/imagelab/ocr/**`.
 *
 * Ba nhóm hành vi được khẳng định ở đây:
 *  1. `classifyRegion` — đủ 5 loại, và FAIL-CLOSED: không chắc thì `unknown`
 *     + `translatable = false` (luật 3 + luật 4 của hợp đồng).
 *  2. `normalizeRegions` — dữ liệu bẩn không được ném lỗi, không được biến mất
 *     im lặng: mọi vùng bị bỏ phải có mặt trong `dropped` kèm lý do.
 *  3. Provider thật: `none` → NOT_CONFIGURED; `mock` thiếu fixture → FAILED
 *     (KHÔNG fallback im lặng).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  HttpOcrProvider,
  OcrProvider,
  REGION_KINDS,
  classifyRegion,
  createOcrProvider,
  normalizeRegions,
} from '../src/imagelab/ocr/index.js';
import { testConfig, silent } from './helpers.js';
import { tmpDir } from './imagelab-helpers.js';

const providerConfig = (overrides = {}) => testConfig({ OCR_PROVIDER: 'mock', ...overrides });

describe('MVP-02 OCR — classifyRegion (5 loại + fail-closed)', () => {
  test('nhận đúng 4 loại có dấu hiệu rõ ràng', () => {
    const cases = [
      ['纯棉短袖T恤', 'descriptive'],
      ['厂家直销 一件代发', 'descriptive'],
      ['品牌旗舰店', 'brand'],
      ['®', 'brand'],
      ['™', 'brand'],
      ['官方', 'brand'],
      ['商标', 'brand'],
      ['3C认证 合格证齐全', 'certification'],
      ['CE', 'certification'],
      ['FDA', 'certification'],
      ['ISO9001', 'certification'],
      ['RoHS', 'certification'],
      ['检验报告', 'certification'],
      ['¥39.9 包邮', 'price'],
      ['￥129', 'price'],
      ['元', 'price'],
      ['价格 39', 'price'],
      ['包邮 39.9', 'price'],
    ];
    for (const [text, expected] of cases) {
      const got = classifyRegion(text);
      assert.equal(got.kind, expected, `“${text}” phải là ${expected}, nhận ${got.kind}`);
      assert.equal(got.translatable, expected === 'descriptive', `translatable của “${text}” sai`);
      assert.ok(got.kind_reason && got.kind_reason.length > 0, `“${text}” phải có kind_reason`);
    }
  });

  test('chuỗi rỗng / chỉ khoảng trắng → unknown + không dịch', () => {
    for (const text of ['', '   ', '\n\t', null, undefined]) {
      const got = classifyRegion(text);
      assert.equal(got.kind, 'unknown');
      assert.equal(got.translatable, false);
    }
  });

  test('chuỗi chỉ có số / ký hiệu → unknown + không dịch (không có chữ để dịch)', () => {
    for (const text of ['138-8888-6666', '℡138-8888-6666', '2024/03', '#12', '——']) {
      const got = classifyRegion(text);
      assert.equal(got.kind, 'unknown', `“${text}” lẽ ra phải là unknown`);
      assert.equal(got.translatable, false);
    }
  });

  test('`包邮` KHÔNG kèm số → unknown (fail-closed), kèm số → price', () => {
    const bare = classifyRegion('包邮');
    assert.equal(bare.kind, 'unknown');
    assert.equal(bare.translatable, false);
    assert.equal(classifyRegion('包邮 39.9').kind, 'price');
    assert.equal(classifyRegion('全国包邮').kind, 'unknown');
  });

  test('BẤT BIẾN: translatable === (kind === "descriptive") trên mọi mẫu', () => {
    const samples = [
      '纯棉', '', '品牌', '认证', '¥12', '包邮', '138-8888', '®', '™', 'ISO', '元',
      '厂家直销 一件代发', '未知文字', 'ABC', '包邮 12', '价格', 'CE 认证', '旗舰店',
    ];
    for (const s of samples) {
      const got = classifyRegion(s);
      assert.ok(REGION_KINDS.includes(got.kind), `kind lạ: ${got.kind}`);
      assert.equal(
        got.translatable,
        got.kind === 'descriptive',
        `bất biến translatable bị phá ở “${s}” (kind=${got.kind})`,
      );
    }
  });
});

describe('MVP-02 OCR — normalizeRegions (chuẩn hoá + vết dropped)', () => {
  const raw = (over = {}) => ({ text: '纯棉', box: { x: 10, y: 20, w: 100, h: 30 }, confidence: 0.9, ...over });

  test('vùng hợp lệ: id r1.., hộp số nguyên, box_normalized 6 chữ số, đúng thứ tự đọc', () => {
    const { regions, dropped } = normalizeRegions(
      [
        raw({ text: 'Dưới phải', box: { x: 500, y: 900, w: 100, h: 20 } }),
        raw({ text: 'Trên phải', box: { x: 500, y: 100, w: 100, h: 20 } }),
        raw({ text: 'Trên trái', box: { x: 10, y: 100, w: 100, h: 20 } }),
      ],
      { width: 1000, height: 1000, minConfidence: 0.5, maxRegions: 40 },
    );
    assert.deepEqual(dropped, []);
    assert.deepEqual(regions.map((r) => r.id), ['r1', 'r2', 'r3']);
    assert.deepEqual(regions.map((r) => r.text), ['Trên trái', 'Trên phải', 'Dưới phải']);
    for (const r of regions) {
      assert.ok(Number.isInteger(r.box.x) && Number.isInteger(r.box.y), 'toạ độ phải là số nguyên');
      assert.ok(Number.isInteger(r.box.w) && Number.isInteger(r.box.h));
      assert.equal(r.box_normalized.x, Number((r.box.x / 1000).toFixed(6)));
      assert.equal(r.box_normalized.w, Number((r.box.w / 1000).toFixed(6)));
      assert.equal(r.translatable, r.kind === 'descriptive');
      assert.equal(r.source, 'ocr');
    }
  });

  test('toạ độ lẻ bị cắt thành số nguyên; hộp tràn biên bị kẹp vào ảnh', () => {
    const { regions, dropped } = normalizeRegions(
      [
        raw({ text: 'Lẻ', box: { x: 10.7, y: 20.2, w: 30.9, h: 40.5 } }),
        raw({ text: 'Tràn', box: { x: 950, y: 80, w: 400, h: 500 } }),
        raw({ text: 'Âm', box: { x: -50, y: -30, w: 100, h: 60 } }),
      ],
      { width: 1000, height: 100, minConfidence: 0, maxRegions: 40 },
    );
    assert.equal(dropped.length, 0);
    const byText = Object.fromEntries(regions.map((r) => [r.text, r.box]));
    assert.deepEqual(byText['Lẻ'], { x: 10, y: 20, w: 30, h: 40 });
    assert.deepEqual(byText['Tràn'], { x: 950, y: 80, w: 50, h: 20 });
    // SỬA THEO H-1 (vòng 3): kỳ vọng cũ { x: 0, y: 0, w: 100, h: 60 } mã hoá đúng LỖI —
    // hộp { x: -50, w: 100 } phủ x ∈ [-50, 50) nên phần nằm TRONG ảnh chỉ còn w = 50
    // (tương tự y: h = 30). Giữ nguyên w/h sau khi dời gốc là NỚI RỘNG hộp, đúng thứ
    // đã làm vùng mô tả hợp lệ bị BOX_OVERLAPS_PROTECTED chặn oan.
    assert.deepEqual(byText['Âm'], { x: 0, y: 0, w: 50, h: 30 });
    for (const r of regions) {
      assert.ok(r.box.x >= 0 && r.box.y >= 0);
      assert.ok(r.box.x + r.box.w <= 1000 && r.box.y + r.box.h <= 100);
    }
  });

  test('mọi vùng bị bỏ đều có mặt trong dropped kèm lý do (không mất im lặng)', () => {
    const list = [
      raw({ text: 'Giữ lại', box: { x: 10, y: 10, w: 100, h: 20 } }),
      raw({ text: '   ', box: { x: 10, y: 40, w: 100, h: 20 } }), // rỗng
      raw({ text: 'Tin cậy thấp', box: { x: 10, y: 70, w: 100, h: 20 }, confidence: 0.2 }),
      raw({ text: 'Rộng 0', box: { x: 10, y: 100, w: 0, h: 20 } }),
      raw({ text: 'Cao âm', box: { x: 10, y: 130, w: 100, h: -5 } }),
      raw({ text: 'Ngoài biên', box: { x: 5000, y: 5000, w: 100, h: 20 } }),
      raw({ text: 'Giữ lại', box: { x: 10, y: 10, w: 100, h: 20 } }), // trùng khít "Giữ lại"
      raw({ text: 'Thiếu hộp', box: undefined }),
    ];
    const { regions, dropped } = normalizeRegions(list, {
      width: 1000,
      height: 1000,
      minConfidence: 0.5,
      maxRegions: 40,
    });

    assert.deepEqual(regions.map((r) => r.text), ['Giữ lại']);
    // Không vùng nào được phép biến mất mà không để lại vết.
    assert.equal(regions.length + dropped.length, list.length, 'số vùng giữ + bỏ phải bằng số vùng vào');
    for (const d of dropped) {
      assert.equal(typeof d.reason, 'string');
      assert.ok(d.reason.trim().length > 0, 'mỗi vùng bị bỏ phải có lý do');
    }
    const reasons = dropped.map((d) => d.reason).join(' | ');
    assert.match(reasons, /rỗng|khoảng trắng/);
    assert.match(reasons, /tin cậy .*thấp hơn ngưỡng/);
    assert.match(reasons, /w<=0 hoặc h<=0/);
    assert.match(reasons, /ngoài biên/);
    assert.match(reasons, /trùng khít/);
    assert.match(reasons, /hộp bao/);
  });

  test('cắt theo maxRegions và ghi lại phần bị cắt', () => {
    const list = Array.from({ length: 5 }, (_, i) =>
      raw({ text: `Vùng ${i}`, box: { x: 10, y: 10 + i * 30, w: 100, h: 20 } }),
    );
    const { regions, dropped } = normalizeRegions(list, { width: 1000, height: 1000, maxRegions: 3 });
    assert.equal(regions.length, 3);
    assert.equal(dropped.length, 2);
    for (const d of dropped) assert.match(d.reason, /vượt giới hạn 3 vùng/);
    // Cắt theo THỨ TỰ ĐỌC: giữ 3 vùng trên cùng.
    assert.deepEqual(regions.map((r) => r.text), ['Vùng 0', 'Vùng 1', 'Vùng 2']);
  });

  test('width/height = 0 hoặc thiếu → KHÔNG ném lỗi, bỏ hết vùng kèm lý do', () => {
    const list = [raw(), raw({ text: 'Hai', box: { x: 0, y: 0, w: 10, h: 10 } })];
    for (const dims of [
      { width: 0, height: 0 },
      { width: 0, height: 100 },
      { width: 100, height: 0 },
      { width: undefined, height: undefined },
      { width: -10, height: 100 },
    ]) {
      const out = normalizeRegions(list, dims);
      assert.deepEqual(out.regions, [], `dims=${JSON.stringify(dims)} lẽ ra không giữ vùng nào`);
      assert.equal(out.dropped.length, list.length);
      assert.ok(out.warnings.length > 0, 'phải cảnh báo vì đã bỏ toàn bộ vùng');
    }
  });

  test('đầu vào không phải mảng → không ném lỗi, có cảnh báo', () => {
    for (const bad of [null, undefined, 'không phải mảng', 42, {}]) {
      const out = normalizeRegions(bad, { width: 100, height: 100 });
      assert.deepEqual(out.regions, []);
      assert.ok(out.warnings.length >= 1);
    }
  });

  test('kind do provider khai chỉ được LEO THANG bảo vệ, không được hạ cấp', () => {
    // (Hộp phải KHÁC nhau: từ F-01, hai vùng TRÙNG hộp mà khác chữ bị khử trùng theo
    //  mức bảo vệ — xem describe "khử trùng theo hộp" bên dưới.)
    const { regions } = normalizeRegions(
      [
        raw({ text: '纯棉短袖', kind: 'brand', kind_reason: 'provider nói nhãn hiệu', box: { x: 10, y: 20, w: 100, h: 30 } }),
        raw({ text: '品牌旗舰店', kind: 'descriptive', kind_reason: 'provider nói dịch được', box: { x: 10, y: 60, w: 100, h: 30 } }),
        raw({ text: 'Chữ mô tả', kind: 'unknown', box: { x: 10, y: 100, w: 100, h: 30 } }),
      ],
      { width: 1000, height: 1000, minConfidence: 0 },
    );
    const byText = Object.fromEntries(regions.map((r) => [r.text, r]));
    assert.equal(byText['纯棉短袖'].kind, 'brand', 'provider khai bảo vệ cao hơn thì giữ');
    assert.equal(byText['品牌旗舰店'].kind, 'brand', 'provider KHÔNG được hạ cấp vùng nhãn hiệu');
    assert.equal(byText['品牌旗舰店'].translatable, false);
    assert.equal(byText['Chữ mô tả'].kind, 'unknown');
  });
});

describe('MVP-02 OCR — khử trùng theo HỘP + cảnh báo hộp giao nhau (F-01)', () => {
  const raw = (over = {}) => ({ text: '纯棉', box: { x: 10, y: 20, w: 100, h: 30 }, confidence: 0.9, ...over });
  const dims = { width: 1000, height: 1000, minConfidence: 0 };

  test('CÙNG hộp nhưng khác chữ → giữ vùng có mức bảo vệ cao nhất (brand > descriptive)', () => {
    const { regions, dropped, warnings } = normalizeRegions(
      [
        raw({ text: '纯棉短袖T恤', box: { x: 40, y: 40, w: 200, h: 40 } }),
        raw({ text: '品牌旗舰店', box: { x: 40, y: 40, w: 200, h: 40 } }),
      ],
      dims,
    );
    assert.equal(regions.length, 1, 'chỉ được giữ MỘT vùng cho một hộp');
    assert.equal(regions[0].kind, 'brand');
    assert.equal(regions[0].text, '品牌旗舰店');
    assert.equal(dropped.length, 1);
    assert.match(dropped[0].reason, /trùng hộp nhưng khác chữ/);
    assert.equal(dropped[0].text, '纯棉短袖T恤');
    assert.equal(warnings.some((w) => /giao nhau/.test(w)), false, 'một hộp thì không có cặp giao nhau');
  });

  test('brand đến TRƯỚC, descriptive đến SAU cũng không được thay thế vùng bảo vệ', () => {
    const { regions, dropped } = normalizeRegions(
      [
        raw({ text: '品牌旗舰店', box: { x: 40, y: 40, w: 200, h: 40 } }),
        raw({ text: '纯棉短袖T恤', box: { x: 40, y: 40, w: 200, h: 40 } }),
      ],
      dims,
    );
    assert.deepEqual(regions.map((r) => r.text), ['品牌旗舰店']);
    assert.equal(dropped.length, 1);
    assert.match(dropped[0].reason, /mức bảo vệ cao hơn hoặc bằng/);
  });

  test('cùng hộp + cùng chữ → vẫn khử như cũ (lý do "trùng khít")', () => {
    const { regions, dropped } = normalizeRegions(
      [raw({ text: 'Giữ lại', box: { x: 10, y: 10, w: 100, h: 20 } }), raw({ text: 'Giữ lại', box: { x: 10, y: 10, w: 100, h: 20 } })],
      dims,
    );
    assert.equal(regions.length, 1);
    assert.equal(dropped.length, 1);
    assert.match(dropped[0].reason, /trùng khít/);
  });

  test('hộp GIAO NHAU (chồng một phần / lồng nhau) → cảnh báo liệt kê cặp, KHÔNG bỏ vùng', () => {
    const { regions, warnings } = normalizeRegions(
      [
        raw({ text: '纯棉短袖T恤', box: { x: 30, y: 30, w: 240, h: 120 } }),
        raw({ text: '品牌旗舰店', box: { x: 40, y: 40, w: 200, h: 40 } }),
        raw({ text: '3C认证', box: { x: 40, y: 250, w: 260, h: 34 } }),
      ],
      dims,
    );
    assert.equal(regions.length, 3, 'hộp giao nhau KHÔNG bị bỏ (pipeline chặn ở tầng op)');
    const overlapWarning = warnings.find((w) => /giao nhau/.test(w));
    assert.ok(overlapWarning, 'phải có cảnh báo hộp giao nhau');
    assert.match(overlapWarning, /r\d+ \(brand\) × r\d+|r\d+ \(descriptive\) × r\d+ \(brand\)/);
    assert.match(overlapWarning, /KHÔNG được xoá\/vẽ đè/);
  });

  test('hộp CHẠM CẠNH (không có diện tích chung) không bị coi là giao nhau', () => {
    const { regions, warnings } = normalizeRegions(
      [
        raw({ text: '品牌旗舰店', box: { x: 10, y: 10, w: 100, h: 20 } }),
        raw({ text: '纯棉短袖T恤', box: { x: 110, y: 10, w: 100, h: 20 } }),
      ],
      dims,
    );
    assert.equal(regions.length, 2);
    assert.equal(warnings.some((w) => /giao nhau/.test(w)), false);
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * SIẾT LẠI Ý ĐỊNH CỦA TEST "kind do provider khai chỉ được LEO THANG"
   * (test phía trên đã phải đổi 3 vùng sang 3 hộp KHÁC nhau vì luật khử trùng mới).
   *
   * Hai test dưới chứng minh việc đổi hộp là do HỢP ĐỒNG MỚI, không phải để test dễ
   * xanh: (1) kịch bản CŨ (3 vùng cùng hộp) giờ bị khử trùng — và bị khử trùng ĐÚNG
   * theo mức bảo vệ; (2) luật leo thang kind vẫn đúng khi các hộp chỉ giao MỘT PHẦN.
   * ───────────────────────────────────────────────────────────────────────── */
  test('kịch bản CŨ (3 vùng CÙNG hộp): luật khử trùng mới giữ vùng bảo vệ cao nhất, có vết trong dropped', () => {
    const sameBox = { x: 10, y: 20, w: 100, h: 30 };
    const { regions, dropped, warnings } = normalizeRegions(
      [
        raw({ text: '纯棉短袖', kind: 'brand', kind_reason: 'provider nói nhãn hiệu', box: sameBox }),
        raw({ text: '品牌旗舰店', kind: 'descriptive', kind_reason: 'provider nói dịch được', box: sameBox }),
        raw({ text: 'Chữ mô tả', kind: 'unknown', box: sameBox }),
      ],
      dims,
    );
    assert.equal(regions.length, 1, 'một hộp chỉ được giữ MỘT vùng');
    assert.equal(regions[0].text, '纯棉短袖');
    assert.equal(regions[0].kind, 'brand', 'kind do provider khai vẫn KHÔNG bị hạ cấp');
    assert.equal(regions[0].translatable, false);
    assert.equal(dropped.length, 2, 'hai vùng bị khử trùng phải có vết, không mất im lặng');
    for (const d of dropped) assert.match(d.reason, /trùng hộp nhưng khác chữ/);
    assert.deepEqual(dropped.map((d) => d.text).sort(), ['Chữ mô tả', '品牌旗舰店'].sort());
    assert.ok(warnings.some((w) => /Đã bỏ 2 vùng/.test(w)));
  });

  test('hộp chỉ GIAO MỘT PHẦN (khác hộp): luật leo thang kind vẫn nguyên cho mọi vùng', () => {
    const { regions } = normalizeRegions(
      [
        raw({ text: '纯棉短袖', kind: 'brand', box: { x: 10, y: 20, w: 100, h: 30 } }),
        raw({ text: '品牌旗舰店', kind: 'descriptive', box: { x: 20, y: 25, w: 100, h: 30 } }),
        raw({ text: 'Chữ mô tả', kind: 'unknown', box: { x: 10, y: 100, w: 100, h: 30 } }),
      ],
      dims,
    );
    assert.equal(regions.length, 3, 'hộp giao một phần KHÔNG bị khử trùng');
    const byText = Object.fromEntries(regions.map((r) => [r.text, r]));
    assert.equal(byText['纯棉短袖'].kind, 'brand', 'provider khai bảo vệ cao hơn thì giữ');
    assert.equal(byText['品牌旗舰店'].kind, 'brand', 'provider KHÔNG được hạ cấp vùng nhãn hiệu (auto đã là brand)');
    assert.equal(byText['品牌旗舰店'].translatable, false);
    assert.equal(byText['Chữ mô tả'].kind, 'unknown');
  });
});

describe('MVP-02 OCR — provider (none / mock / fixture hỏng)', () => {
  test('provider "none" → NOT_CONFIGURED, không có vùng nào', async () => {
    const provider = createOcrProvider(testConfig({ OCR_PROVIDER: 'none' }), { logger: silent });
    assert.equal(provider.name, 'none');
    assert.equal(provider.configured, false);
    const res = await provider.detect({ buffer: Buffer.from('x'), width: 10, height: 10 });
    assert.equal(res.status, 'NOT_CONFIGURED');
    assert.deepEqual(res.regions, []);
    assert.equal(res.error_code, 'OCR_NOT_CONFIGURED');
    assert.equal(res.is_mock, false);
  });

  test('provider mock đọc fixture thật: is_mock = true, đủ 5 kind, usage = pixel × vùng', async () => {
    const provider = createOcrProvider(providerConfig(), { logger: silent });
    assert.equal(provider.name, 'mock');
    assert.equal(provider.isMock, true);
    assert.equal(provider.configured, true);

    const res = await provider.detect({ buffer: Buffer.alloc(10), mime: 'image/png', width: 800, height: 800 });
    assert.equal(res.status, 'OK');
    assert.equal(res.is_mock, true, 'provider mock PHẢI tự khai is_mock');
    assert.equal(res.provider, 'mock');
    assert.equal(res.regions.length, 6);
    assert.deepEqual(res.regions.map((r) => r.id), ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);

    const kinds = new Set(res.regions.map((r) => r.kind));
    for (const k of REGION_KINDS) assert.ok(kinds.has(k), `fixture phải phủ kind ${k}`);
    assert.equal(res.usage.input_units, 800 * 800);
    assert.equal(res.usage.output_units, res.regions.length);

    const brand = res.regions.find((r) => r.kind === 'brand');
    assert.equal(brand.translatable, false);
    assert.equal(brand.text, '品牌旗舰店', 'chữ gốc phải được giữ nguyên văn, không dịch');
    for (const r of res.regions) assert.equal(r.translatable, r.kind === 'descriptive');
  });

  test('mock + width/height = 0 → UNSUPPORTED_IMAGE, không ném lỗi', async () => {
    const provider = createOcrProvider(providerConfig(), { logger: silent });
    const res = await provider.detect({ buffer: Buffer.alloc(10), width: 0, height: 0 });
    assert.equal(res.status, 'UNSUPPORTED_IMAGE');
    assert.equal(res.error_code, 'OCR_UNSUPPORTED_IMAGE');
  });

  test('fixture thiếu → FAILED + OCR_MOCK_FIXTURE_MISSING (KHÔNG fallback về fixture mặc định)', async () => {
    const missing = path.join(tmpDir(), 'khong-ton-tai.json');
    const provider = createOcrProvider(providerConfig({ OCR_MOCK_FIXTURE: missing }), { logger: silent });
    const res = await provider.detect({ buffer: Buffer.alloc(10), width: 800, height: 800 });
    assert.equal(res.status, 'FAILED');
    assert.equal(res.error_code, 'OCR_MOCK_FIXTURE_MISSING');
    assert.deepEqual(res.regions, []);
    assert.ok(res.error_message.length > 0);
  });

  test('fixture hỏng JSON / thiếu cờ is_mock → FAILED có mã, không đoán', async () => {
    const dir = tmpDir();
    const badJson = path.join(dir, 'bad.json');
    fs.writeFileSync(badJson, '{ khong-phai-json', 'utf8');
    const notMock = path.join(dir, 'not-mock.json');
    fs.writeFileSync(notMock, JSON.stringify({ regions: [{ text: '纯棉', box: { x: 0, y: 0, w: 10, h: 10 } }] }), 'utf8');

    const cases = [
      [badJson, 'OCR_MOCK_FIXTURE_BAD_JSON'],
      [notMock, 'OCR_MOCK_FIXTURE_NOT_MOCK'],
    ];
    for (const [fixture, code] of cases) {
      const provider = createOcrProvider(providerConfig({ OCR_MOCK_FIXTURE: fixture }), { logger: silent });
      const res = await provider.detect({ buffer: Buffer.alloc(10), width: 800, height: 800 });
      assert.equal(res.status, 'FAILED', `${path.basename(fixture)} lẽ ra phải FAILED`);
      assert.equal(res.error_code, code);
    }
  });

  test('provider http thiếu key/baseUrl → NOT_CONFIGURED (không gọi mạng)', async () => {
    const provider = createOcrProvider(testConfig({ OCR_PROVIDER: 'http', OCR_BASE_URL: '', OCR_API_KEY: '' }), { logger: silent });
    assert.equal(provider.configured, false);
    const res = await provider.detect({ buffer: Buffer.alloc(10), width: 800, height: 800 });
    assert.equal(res.status, 'NOT_CONFIGURED');
    assert.equal(res.regions.length, 0);
  });

  test('OcrProvider cơ sở: detect() không bao giờ ném lỗi ra ngoài', async () => {
    class BoomProvider extends OcrProvider {
      async _detect() {
        throw new Error('nổ giả lập');
      }
    }
    const provider = new BoomProvider({ name: 'boom', configured: true });
    const res = await provider.detect({ width: 10, height: 10 });
    assert.equal(res.status, 'FAILED');
    assert.equal(res.error_code, 'OCR_INTERNAL_ERROR');
    assert.deepEqual(res.regions, []);
  });
});

describe('MVP-02 OCR — provider http (adapter REST, fetcher giả, không cần mạng)', () => {
  const cfg = () =>
    testConfig({ OCR_PROVIDER: 'http', OCR_BASE_URL: 'https://ocr.example.test/detect', OCR_API_KEY: 'khoa-gia-123' });

  const httpProvider = (fetchImpl) => {
    const config = cfg();
    return {
      config,
      provider: new HttpOcrProvider({
        baseUrl: config.ocr.baseUrl,
        apiKey: config.ocr.apiKey,
        model: 'ocr-rest-1',
        config,
        fetchImpl,
      }),
    };
  };

  test('gửi đúng body hợp đồng 4.1 và chuẩn hoá vùng trả về; is_mock = false', async () => {
    const calls = [];
    const { config, provider } = httpProvider(async (url, opts) => {
      calls.push({ url, opts });
      return {
        status: 200,
        headers: {},
        body: Buffer.from(
          JSON.stringify({
            regions: [{ text: '纯棉短袖T恤', box: { x: 10, y: 20, w: 100, h: 30 }, confidence: 0.9 }],
          }),
        ),
      };
    });

    const res = await provider.detect({ buffer: Buffer.from('anh-gia'), mime: 'image/png', width: 100, height: 100 });
    assert.equal(calls.length, 1, 'phải gọi đúng 1 lần');
    assert.equal(calls[0].url, config.ocr.baseUrl);
    assert.equal(calls[0].opts.method, 'POST');

    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.image_base64, Buffer.from('anh-gia').toString('base64'));
    assert.equal(body.mime, 'image/png');
    assert.equal(body.width, 100);
    assert.equal(body.height, 100);
    assert.ok(Number.isInteger(body.max_regions) && body.max_regions > 0);
    assert.match(String(calls[0].opts.headers.authorization), /^Bearer /);

    assert.equal(res.status, 'OK');
    assert.equal(res.provider, 'http');
    assert.equal(res.is_mock, false, 'provider http KHÔNG được khai mock');
    assert.equal(res.regions.length, 1);
    assert.equal(res.regions[0].kind, 'descriptive');
    assert.equal(res.usage.input_units, 100 * 100);
    assert.ok(!JSON.stringify(res).includes(config.ocr.apiKey), 'kết quả KHÔNG được lộ API key');
  });

  test('HTTP lỗi / JSON hỏng / thiếu regions / bị chặn SSRF → FAILED có mã, không ném ra ngoài', async () => {
    const cases = [
      [async () => ({ status: 500, body: Buffer.from('loi he thong') }), 'OCR_HTTP_FAILED'],
      [async () => ({ status: 200, body: Buffer.from('{ khong-phai-json') }), 'OCR_BAD_JSON'],
      [async () => ({ status: 200, body: Buffer.from(JSON.stringify({ ok: true })) }), 'OCR_BAD_RESPONSE'],
      [
        async () => {
          const err = new Error('địa chỉ nội bộ bị chặn');
          err.code = 'PRIVATE_IP';
          throw err;
        },
        'OCR_HTTP_BLOCKED',
      ],
    ];
    for (const [fetchImpl, code] of cases) {
      const { config, provider } = httpProvider(fetchImpl);
      const res = await provider.detect({ buffer: Buffer.alloc(20), mime: 'image/png', width: 100, height: 100 });
      assert.equal(res.status, 'FAILED', `${code}: lẽ ra FAILED`);
      assert.equal(res.error_code, code);
      assert.deepEqual(res.regions, []);
      assert.ok(!String(res.error_message).includes(config.ocr.apiKey), 'thông báo lỗi không được chứa API key');
    }
  });
});
