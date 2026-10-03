/**
 * TEST MVP-02 · DỊCH & DUYỆT (C2) — `src/imagelab/translate/**`.
 *
 * Trọng tâm là LUẬT 3 và LUẬT 1 của hợp đồng:
 *  - vùng brand/certification/price/unknown KHÔNG BAO GIỜ được gửi cho provider
 *    (đếm số lần gọi provider thật = 0, và chuỗi vùng khoá không lọt vào prompt);
 *  - guardrail 4 luật bắt được cả "cách nói vòng" tiếng Việt, nhưng KHÔNG bắt oan
 *    bản dịch trung thực (`保修12个月` → "Bảo hành 12 tháng");
 *  - `applyReviewEdits`: sửa vùng khoá phải bị TỪ CHỐI thật (không đổi dữ liệu),
 *    override có vết, edit rác không ném lỗi, và không sửa input tại chỗ.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  GLOSSARY,
  NEVER_TRANSLATE,
  TRANSLATE_STATUS,
  applyReviewEdits,
  createTranslator,
  enforceTranslationGuardrails,
} from '../src/imagelab/translate/index.js';
import { testConfig, silent } from './helpers.js';
import { fakeAiProvider } from './imagelab-helpers.js';

/** Translator chế độ AI với provider giả — đếm được từng lượt gọi. */
function aiTranslator(options = {}) {
  const provider = fakeAiProvider(options);
  const translator = createTranslator(
    testConfig({ TRANSLATE_PROVIDER: 'ai', AI_PROVIDER: 'mock' }),
    { logger: silent, aiProvider: provider },
  );
  return { provider, translator };
}

const promptText = (call) => call.messages.map((m) => String(m.text ?? '')).join('\n');

const lockedRegion = (id, kind, text) => ({ id, kind, text, translatable: false, confidence: 0.9 });

describe('MVP-02 dịch — vùng khoá KHÔNG BAO GIỜ tới provider', () => {
  test('tập chỉ có vùng brand/certification/price/unknown → 0 lượt gọi provider', async () => {
    const { provider, translator } = aiTranslator({ lines: [] });
    const regions = [
      lockedRegion('r1', 'brand', '品牌旗舰店'),
      lockedRegion('r2', 'certification', '3C认证 合格证齐全'),
      lockedRegion('r3', 'price', '¥39.9 包邮'),
      lockedRegion('r4', 'unknown', '℡138-8888-6666'),
    ];
    const res = await translator.translateRegions(regions);

    assert.equal(provider.calls.length, 0, 'provider không được gọi một lần nào');
    assert.equal(res.usage, null, 'không được tính usage khi không gọi provider');
    assert.equal(res.lines.length, 4);
    const byId = Object.fromEntries(res.lines.map((l) => [l.region_id, l]));
    assert.equal(byId.r1.status, TRANSLATE_STATUS.SKIPPED_BRAND);
    assert.equal(byId.r2.status, TRANSLATE_STATUS.SKIPPED_CERTIFICATION);
    assert.equal(byId.r3.status, TRANSLATE_STATUS.SKIPPED_PRICE);
    assert.equal(byId.r4.status, TRANSLATE_STATUS.NEEDS_REVIEW);
    for (const line of res.lines) {
      assert.equal(line.text_vi, '', 'vùng khoá phải có text_vi rỗng');
      assert.equal(line.provenance, 'none');
      assert.equal(line.status === TRANSLATE_STATUS.TRANSLATED, false);
    }
  });

  test('tập TRỘN: chuỗi vùng khoá KHÔNG xuất hiện trong prompt gửi provider', async () => {
    const { provider, translator } = aiTranslator({ lines: [{ region_id: 'r2', text_vi: 'Áo thun cotton' }] });
    const res = await translator.translateRegions([
      lockedRegion('r1', 'brand', '品牌旗舰店'),
      { id: 'r2', kind: 'descriptive', text: '纯棉短袖T恤', translatable: true, confidence: 0.9 },
      lockedRegion('r3', 'price', '￥129 包邮'),
    ]);

    assert.equal(provider.calls.length, 1, 'chỉ được gọi provider đúng 1 lượt');
    const prompt = promptText(provider.calls[0]);
    assert.ok(prompt.includes('纯棉短袖T恤'), 'prompt phải chứa vùng được phép dịch');
    assert.ok(!prompt.includes('品牌旗舰店'), 'prompt KHÔNG được chứa chữ vùng nhãn hiệu');
    assert.ok(!prompt.includes('￥129'), 'prompt KHÔNG được chứa chữ vùng giá');

    const byId = Object.fromEntries(res.lines.map((l) => [l.region_id, l]));
    assert.equal(byId.r1.status, TRANSLATE_STATUS.SKIPPED_BRAND);
    assert.equal(byId.r3.status, TRANSLATE_STATUS.SKIPPED_PRICE);
    assert.equal(byId.r2.status, TRANSLATE_STATUS.TRANSLATED);
    assert.equal(byId.r2.text_vi, 'Áo thun cotton');
    assert.equal(byId.r2.provenance, 'ai');
  });

  test('vùng khai `descriptive` nhưng chữ khớp mẫu CẤM dịch cũng không tới provider', async () => {
    const { provider, translator } = aiTranslator({ lines: [] });
    const res = await translator.translateRegions([
      { id: 'r1', kind: 'descriptive', text: 'Chính hãng Nike', translatable: true, confidence: 0.9 },
    ]);
    assert.equal(provider.calls.length, 0);
    assert.equal(res.lines[0].text_vi, '');
    assert.notEqual(res.lines[0].status, TRANSLATE_STATUS.TRANSLATED);
  });

  test('provider dịch thiếu key → NOT_CONFIGURED, không bịa bản dịch', async () => {
    const translator = createTranslator(testConfig({ TRANSLATE_PROVIDER: 'none', AI_PROVIDER: 'none' }), { logger: silent });
    assert.equal(translator.configured, false);
    const res = await translator.translateRegions([
      { id: 'r1', kind: 'descriptive', text: '纯棉短袖T恤', translatable: true, confidence: 0.9 },
    ]);
    assert.equal(res.status, 'NOT_CONFIGURED');
    assert.equal(res.lines[0].text_vi, '');
    assert.equal(res.lines[0].status, TRANSLATE_STATUS.FAILED);
    assert.ok(res.error_code);
  });

  test('GLOSSARY / NEVER_TRANSLATE đúng kiểu dữ liệu hợp đồng (Map + RegExp[] không rỗng)', () => {
    assert.ok(GLOSSARY instanceof Map && GLOSSARY.size > 20, 'GLOSSARY phải là Map thuật ngữ');
    assert.ok(Array.isArray(NEVER_TRANSLATE) && NEVER_TRANSLATE.length > 3);
    for (const re of NEVER_TRANSLATE) assert.ok(re instanceof RegExp);
  });
});

describe('MVP-02 dịch — guardrail 4 luật (bắt bịa, kể cả nói vòng)', () => {
  const line = (text_original, text_vi) => ({ text_original, text_vi, status: TRANSLATE_STATUS.TRANSLATED });
  const region = { kind: 'descriptive', translatable: true };

  const mustReview = [
    ['纯棉T恤', 'Bảo hành 12 tháng', /số liệu|bảo hành/i],
    ['纯棉T恤', 'BH 12 tháng', /bảo hành|số liệu/i],
    ['纯棉T恤', 'Bảo hành một năm', /bảo hành/i],
    ['纯棉T恤', 'đi mưa không sao', /chống nước/i],
    ['纯棉T恤', 'chống nước IP68', /chống nước/i],
    ['纯棉T恤', 'hơn 10 nghìn người mua', /số liệu/i],
    ['纯棉T恤', 'Áo thun 500ml', /đơn vị|số liệu/i],
    ['纯棉T恤', 'Sản phẩm chính hãng', /chính hãng/i],
    ['纯棉T恤', 'Tốt nhất thị trường', /tốt nhất/i],
    ['纯棉T恤', 'Số 1 Việt Nam', /số 1/i],
    ['纯棉短袖T恤', 'Áo thun 纯棉', /CHƯA DỊCH/],
    ['纯棉短袖T恤', 'Áo thun 100% cotton', /số liệu|đơn vị/i],
  ];

  for (const [original, vi, pattern] of mustReview) {
    test(`“${vi}” cho “${original}” → NEEDS_REVIEW (${pattern.source})`, () => {
      const out = enforceTranslationGuardrails(line(original, vi), { region });
      assert.equal(out.line.status, TRANSLATE_STATUS.NEEDS_REVIEW);
      assert.ok(out.violations.length > 0, 'phải có ít nhất một vi phạm');
      assert.match(out.violations.join(' | '), pattern);
      for (const v of out.violations) assert.ok(v.trim().length > 0 && typeof v === 'string');
    });
  }

  test('text_vi rỗng nhưng translatable = true → NEEDS_REVIEW', () => {
    const out = enforceTranslationGuardrails(line('纯棉短袖T恤', ''), { region });
    assert.equal(out.line.status, TRANSLATE_STATUS.NEEDS_REVIEW);
    assert.match(out.violations.join(' '), /rỗng/i);
  });

  test('ÂM TÍNH (không bắt oan): “保修12个月”→“Bảo hành 12 tháng” và “500毫升”→“500 ml” vẫn TRANSLATED', () => {
    const cases = [
      ['保修12个月', 'Bảo hành 12 tháng'],
      ['500毫升', '500 ml'],
      ['三合一数据线', 'Cáp 3 trong 1'],
    ];
    for (const [original, vi] of cases) {
      const out = enforceTranslationGuardrails(line(original, vi), { region });
      assert.deepEqual(out.violations, [], `“${vi}” bị bắt oan: ${out.violations.join(' | ')}`);
      assert.equal(out.line.status, TRANSLATE_STATUS.TRANSLATED, `“${vi}” lẽ ra phải TRANSLATED`);
    }
  });

  test('vùng khoá: guardrail không tự "cần dịch" dù cờ translatable bị đặt sai', () => {
    const out = enforceTranslationGuardrails(
      { text_original: '品牌旗舰店', text_vi: '', status: TRANSLATE_STATUS.SKIPPED_BRAND },
      { region: { kind: 'brand', translatable: false } },
    );
    assert.notEqual(out.line.status, TRANSLATE_STATUS.NEEDS_REVIEW);
    assert.deepEqual(out.violations, []);
  });
});

describe('MVP-02 dịch — applyReviewEdits (duyệt từng dòng)', () => {
  const descriptive = () => ({
    region_id: 'r2',
    text_original: '纯棉短袖T恤',
    text_vi: 'Áo thun cotton',
    status: TRANSLATE_STATUS.TRANSLATED,
    provenance: 'ai',
    confidence: 0.8,
    violations: [],
    edited_by_user: false,
    edited_at: null,
    notes: '',
  });
  const brand = () => ({
    region_id: 'r1',
    text_original: '品牌旗舰店',
    text_vi: '',
    status: TRANSLATE_STATUS.SKIPPED_BRAND,
    provenance: 'none',
    confidence: 0,
    violations: [],
    edited_by_user: false,
    edited_at: null,
    notes: 'vùng nhãn hiệu',
  });

  test('sửa vùng nhãn hiệu khi THIẾU allowBrandOverride → rejected + KHÔNG đổi dữ liệu', () => {
    const lines = [brand(), descriptive()];
    const snapshot = JSON.stringify(lines);
    const before = lines[0];
    const { lines: out, rejected } = applyReviewEdits(lines, [
      { region_id: 'r1', text_vi: 'Thương hiệu X', action: 'edit' },
    ]);

    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].region_id, 'r1');
    assert.match(rejected[0].reason, /nhãn hiệu/i);
    assert.equal(out[0].text_vi, '', 'dữ liệu trả về không được đổi');
    assert.equal(out[0].edited_by_user, false);
    assert.equal(out[0].provenance, 'none');
    assert.equal(JSON.stringify(lines), snapshot, 'input KHÔNG được sửa tại chỗ');
    assert.equal(lines[0], before);
  });

  test('có allowBrandOverride → áp dụng + để lại vết user', () => {
    const lines = [brand()];
    const { lines: out, rejected, warnings } = applyReviewEdits(
      lines,
      [{ region_id: 'r1', text_vi: 'Thương hiệu X', action: 'edit' }],
      { allowBrandOverride: true },
    );
    assert.deepEqual(rejected, []);
    assert.equal(out[0].text_vi, 'Thương hiệu X');
    assert.equal(out[0].edited_by_user, true);
    assert.equal(out[0].provenance, 'user');
    assert.ok(out[0].edited_at && !Number.isNaN(Date.parse(out[0].edited_at)), 'edited_at phải là ISO-8601');
    assert.match(out[0].notes, /GHI ĐÈ|override/i);
    assert.ok(warnings.some((w) => /ghi đè/i.test(w)));
    assert.equal(lines[0].text_vi, '', 'input gốc vẫn nguyên');
  });

  test('action = edit PHẢI chạy lại guardrail (người dùng cũng không được bịa)', () => {
    const lines = [descriptive()];
    const { lines: out } = applyReviewEdits(lines, [
      { region_id: 'r2', text_vi: 'Bảo hành 12 tháng', action: 'edit' },
    ]);
    assert.equal(out[0].status, TRANSLATE_STATUS.NEEDS_REVIEW, 'vi phạm guardrail ⇒ NEEDS_REVIEW');
    assert.ok(out[0].violations.length > 0);
    assert.equal(out[0].edited_by_user, true);
    assert.equal(out[0].text_vi, 'Bảo hành 12 tháng');
  });

  test('edits rác → rejected, KHÔNG ném lỗi, các dòng khác vẫn nguyên', () => {
    const lines = [descriptive(), brand()];
    const { lines: out, rejected, warnings } = applyReviewEdits(lines, [
      null,
      {},
      { region_id: 'khong-ton-tai', text_vi: 'x', action: 'edit' },
      { region_id: 'r2', text_vi: 'x', action: 'xoa-tat-ca' },
      { region_id: 'r2', text_vi: 'x'.repeat(501), action: 'edit' },
    ]);
    assert.equal(rejected.length, 5, `phải từ chối đủ 5 chỉnh sửa rác, nhận ${rejected.length}`);
    for (const r of rejected) assert.ok(r.reason && r.reason.length > 0);
    assert.equal(out.length, lines.length);
    assert.equal(out[0].text_vi, 'Áo thun cotton', 'dòng hợp lệ không bị đụng');
    assert.equal(out[0].edited_by_user, false);
    assert.ok(warnings.length > 0);
  });

  // SỬA THEO F-06: `skip` là quyết định CỦA NGƯỜI DÙNG nên phải là `SKIPPED_BY_USER`
  // (không còn là `NEEDS_REVIEW`, vốn là trạng thái do guardrail chặn). Nhờ vậy dòng bị
  // bỏ qua không chặn cổng 409 nhưng vẫn được kể ra trong `skipped` khi render.
  test('action = skip → SKIPPED_BY_USER (không chặn render) và vẫn để vết người dùng', () => {
    const lines = [descriptive()];
    const { lines: out } = applyReviewEdits(lines, [{ region_id: 'r2', action: 'skip' }]);
    assert.equal(out[0].text_vi, '');
    assert.equal(out[0].status, TRANSLATE_STATUS.SKIPPED_BY_USER);
    assert.notEqual(out[0].status, TRANSLATE_STATUS.NEEDS_REVIEW, 'skip KHÔNG phải là "cần duyệt"');
    assert.equal(out[0].edited_by_user, true);
    assert.equal(out[0].provenance, 'user');
    assert.ok(out[0].edited_at, 'phải có vết thời điểm');
    assert.match(out[0].notes, /bỏ qua/i);
    assert.deepEqual(out[0].violations, [], 'bỏ qua theo ý người dùng không phải vi phạm guardrail');
  });

  test('accept không đổi nội dung; accept kèm text_vi khác bị bỏ qua (chỉ edit mới sửa)', () => {
    const lines = [descriptive()];
    const { lines: out, warnings } = applyReviewEdits(lines, [
      { region_id: 'r2', text_vi: 'Chữ khác', action: 'accept' },
    ]);
    assert.equal(out[0].text_vi, 'Áo thun cotton');
    assert.equal(out[0].edited_by_user, false);
    assert.ok(warnings.some((w) => /accept/i.test(w)));
  });

  test('danh sách dòng không hợp lệ → không ném lỗi, trả mảng rỗng + cảnh báo', () => {
    const res = applyReviewEdits(null, [{ region_id: 'r1', action: 'accept' }]);
    assert.deepEqual(res.lines, []);
    assert.ok(res.warnings.length > 0);
  });
});

describe('MVP-02 dịch — guardrail siết biến thể (F-08 sau phản biện)', () => {
  const line = (text_original, text_vi) => ({ text_original, text_vi, status: TRANSLATE_STATUS.TRANSLATED });
  const region = { kind: 'descriptive', translatable: true };
  const check = (original, vi) => enforceTranslationGuardrails(line(original, vi), { region });

  const mustCatch = [
    ['纯棉T恤', 'Áo thun cotton mười hai tháng hậu mãi', /Số liệu/], // số viết bằng CHỮ
    ['纯棉T恤', 'Áo thun cotton hai mươi lần giặt', /Số liệu/],
    ['纯棉T恤', 'Áo thun cotton １２ tháng hậu mãi', /Số liệu/], // chữ số full-width (\p{Nd})
    ['纯棉T恤', 'Áo thun cotton ١٢ tháng hậu mãi', /Số liệu/], // bộ chữ số Ả Rập - Ấn
    ['纯棉T恤', 'Áo thun cotton こんにちは', /CHƯA DỊCH/], // kana
    ['纯棉T恤', 'Áo thun cotton 韓国어', /CHƯA DỊCH/], // Hangul
    ['纯棉T恤', 'Áo thun cotton bảo\u200bhành', /bảo hành/i], // ký tự vô hình cắt từ khoá
    ['纯棉T恤', 'Áo thun cotton bảo\u2060hành 12 tháng', /bảo hành/i],
  ];

  for (const [original, vi, pattern] of mustCatch) {
    test(`BẮT “${vi}” cho “${original}” (${pattern.source})`, () => {
      const out = check(original, vi);
      assert.equal(out.line.status, TRANSLATE_STATUS.NEEDS_REVIEW);
      assert.match(out.violations.join(' | '), pattern);
    });
  }

  test('KHÔNG bắt oan câu sạch không có số/đơn vị', () => {
    for (const vi of [
      'Áo thun cotton thoáng mát, đường may chắc chắn',
      'Chất liệu cotton mềm mại, phù hợp mặc hằng ngày',
      'Nhà máy bán trực tiếp, hỗ trợ dropship',
    ]) {
      const out = check('纯棉短袖T恤', vi);
      assert.deepEqual(out.violations, [], `“${vi}” bị bắt oan: ${out.violations.join(' | ')}`);
      assert.equal(out.line.status, TRANSLATE_STATUS.TRANSLATED);
    }
  });

  test('KHÔNG bắt oan khi chữ gốc ĐÃ có đúng số đó (kể cả số viết bằng chữ)', () => {
    const cases = [
      ['保修12个月', 'Bảo hành 12 tháng'],
      ['500毫升', '500 ml'],
      ['十二个月保修', 'Bảo hành mười hai tháng'],
      ['七天内发货', 'Giao hàng trong 7 ngày'],
    ];
    for (const [original, vi] of cases) {
      const out = check(original, vi);
      assert.deepEqual(out.violations, [], `“${vi}” bị bắt oan: ${out.violations.join(' | ')}`);
    }
  });

  test('số bị cắt bằng ký tự vô hình vẫn bị bắt (không lách được luật số)', () => {
    const out = check('纯棉T恤', 'Áo thun cotton 1\u200b2 tháng');
    assert.equal(out.line.status, TRANSLATE_STATUS.NEEDS_REVIEW);
  });
});
