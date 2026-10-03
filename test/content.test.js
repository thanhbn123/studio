/**
 * G09/G12 — TEST CONTENT ENGINE + CHỐNG BỊA.
 *
 * Yêu cầu trọng tâm: "Content: No hallucinated mandatory claims."
 * Đây là bộ test quan trọng nhất về mặt nghiệp vụ, vì nội dung bịa là rủi ro
 * thương mại lớn nhất của sản phẩm này.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkContent, buildEvidenceText, stripViolatingSentences, CLAIM_RULES } from '../src/content/guardrails.js';
import { parseContentOptions, resolveStyle, resolveLength, STYLES, LENGTHS } from '../src/content/styles.js';
import { CONTENT_KEYS, ContentEngine, ContentError } from '../src/content/engine.js';
import { extractJson, estimateCostFromUsage, AiError } from '../src/ai/provider.js';
import { mergeKnowledge } from '../src/merge/knowledge-merge.js';
import { sampleMaster, realContentEngineWithMock, testConfig, silent } from './helpers.js';

const baseContent = (over = {}) => ({
  product_name: 'Đồ chơi毛绒',
  headline: 'Đồ chơi mềm cho bé',
  short_description: 'Món đồ chơi mềm mại.',
  selling_points: ['Mềm mại', 'Màu sắc rực rỡ'],
  detailed_description: 'Mô tả chi tiết.',
  facebook_caption: 'Bài Facebook',
  tiktok_caption: 'Caption TikTok',
  marketplace_description: 'Mô tả sàn',
  hashtags: ['#dochoi'],
  seo: { title: 'Đồ chơi mềm', meta_description: 'Mô tả', keywords: ['đồ chơi'] },
  ...over,
});

describe('Guardrails chống bịa', () => {
  const evidence = '厂家定制高品质七彩毛毛虫千足玩具公仔 产地 广东东莞';

  test('BẮT được khẳng định bảo hành không có bằng chứng', () => {
    const r = checkContent(baseContent({ short_description: 'Sản phẩm bảo hành 24 tháng.' }), { evidenceText: evidence });
    assert.equal(r.passed, false);
    assert.ok(r.violations.some((v) => v.rule === 'warranty'));
  });

  test('BẮT được chứng nhận (ISO/CE/FDA)', () => {
    const r = checkContent(baseContent({ detailed_description: 'Đạt chứng nhận ISO 9001 và CE.' }), { evidenceText: evidence });
    assert.equal(r.passed, false);
    assert.ok(r.violations.some((v) => v.rule === 'certification'));
  });

  test('BẮT được chống nước / IP68', () => {
    const r = checkContent(baseContent({ selling_points: ['Chống nước IP68 tuyệt đối'] }), { evidenceText: evidence });
    assert.equal(r.passed, false);
    assert.ok(r.violations.some((v) => v.rule === 'waterproof'));
  });

  test('BẮT được thông số kỹ thuật bịa (dung tích/công suất)', () => {
    const r = checkContent(baseContent({ detailed_description: 'Dung tích 500ml, công suất 1200W.' }), { evidenceText: evidence });
    assert.equal(r.passed, false);
    assert.ok(r.violations.some((v) => v.rule === 'capacity'));
  });

  test('BẮT được chất liệu bịa', () => {
    const r = checkContent(baseContent({ selling_points: ['Làm từ da thật cao cấp'] }), { evidenceText: evidence });
    assert.equal(r.passed, false);
    assert.ok(r.violations.some((v) => v.rule === 'material'));
  });

  test('BẮT được khuyến mãi / khan hiếm bịa', () => {
    const r = checkContent(baseContent({ facebook_caption: 'Giảm giá 50% hôm nay, số lượng có hạn!' }), { evidenceText: evidence });
    assert.equal(r.passed, false);
    assert.ok(r.violations.some((v) => v.rule === 'price_claim'));
  });

  test('BẮT được số liệu xã hội bịa (đánh giá, số khách)', () => {
    const r = checkContent(baseContent({ headline: '10.000 khách hàng hài lòng' }), { evidenceText: evidence });
    assert.equal(r.passed, false);
    assert.ok(r.violations.some((v) => v.rule === 'rating'));
  });

  test('CHO QUA khi khẳng định có bằng chứng trong dữ liệu nguồn', () => {
    const withEvidence = 'Sản phẩm đạt chứng nhận ISO 9001 theo công bố của nhà sản xuất.';
    const r = checkContent(baseContent({ detailed_description: withEvidence }), { evidenceText: withEvidence });
    assert.equal(r.passed, true, JSON.stringify(r.violations));
  });

  test('nội dung sạch thì PASS và không có vi phạm', () => {
    const r = checkContent(baseContent(), { evidenceText: evidence });
    assert.equal(r.passed, true);
    assert.equal(r.violations.length, 0);
  });

  test('phát hiện thiếu trường bắt buộc', () => {
    const r = checkContent({ product_name: 'x' }, { evidenceText: '' });
    assert.ok(r.warnings.some((w) => /Thiếu/.test(w)));
  });

  test('buildEvidenceText gom cả dữ liệu nguồn lẫn vision', () => {
    const master = sampleMaster();
    const k = mergeKnowledge(master, {
      analysis: { visible_features: ['đặc điểm nhìn thấy ABC'], visible_text: ['chữ trong ảnh XYZ'], colors: ['đỏ'] },
    });
    const text = buildEvidenceText(master, k, { analysis: { visible_text: ['XYZ'] } });
    assert.ok(text.includes('abc'), 'phải gom đặc điểm vision');
    assert.ok(text.includes('xyz'), 'phải gom chữ trong ảnh');
    assert.ok(text.includes('广东东莞'), 'phải gom dữ liệu nguồn');
  });

  test('stripViolatingSentences loại đúng câu vi phạm', () => {
    const text = 'Câu sạch thứ nhất. Sản phẩm bảo hành 24 tháng. Câu sạch thứ hai.';
    const out = stripViolatingSentences(text, [{ matched: 'bảo hành 24 tháng' }]);
    assert.ok(!out.includes('bảo hành'));
    assert.ok(out.includes('Câu sạch thứ nhất'));
    assert.ok(out.includes('Câu sạch thứ hai'));
  });

  test('có đủ 9 nhóm luật chống bịa', () => {
    assert.equal(CLAIM_RULES.length, 9);
    const ids = CLAIM_RULES.map((r) => r.id);
    for (const must of ['warranty', 'certification', 'waterproof', 'spec_unit', 'capacity', 'material', 'origin', 'price_claim', 'rating']) {
      assert.ok(ids.includes(must), `thiếu nhóm luật ${must}`);
    }
  });

  /**
   * REGRESSION — cách NÓI VÒNG của tiếng Việt.
   *
   * Bộ luật đầu tiên chỉ bắt cách nói thẳng ("bảo hành 24 tháng", "chống nước IP68").
   * Khi tự thử 23 cách diễn đạt lại thường gặp, **13 cách lọt lưới** — ví dụ "BH 12 tháng",
   * "đi mưa không sao", "Pin 5000 mAh", "Sale 50%", "Hơn 10 nghìn người mua".
   * Đây là lỗ hổng thật của một sản phẩm mà lời hứa cốt lõi là chống bịa, nên nó phải
   * có test thường trực. Thêm cách nói mới thì thêm dòng vào bảng dưới.
   */
  test('BẮT được các cách NÓI VÒNG phổ biến của tiếng Việt', () => {
    const paraphrases = [
      'Sản phẩm được BH 12 tháng tại hãng.',
      'Bảo đảm trong vòng 1 năm nếu lỗi.',
      'Hỗ trợ đổi trả trong 12 tháng.',
      'Ngâm nước thoải mái không hỏng.',
      'Đi mưa không sao, kháng ẩm tốt.',
      'Đạt chuẩn IP68.',
      'Chứa được 5 lít nước.',
      'Bình 500 ml tiện lợi.',
      'Pin 5000 mAh dùng cả ngày.',
      'Công suất 1200 W mạnh mẽ.',
      'Làm bằng da bò thật 100%.',
      'Vải cotton thoáng mát.',
      'Chất liệu inox 304.',
      'Hàng nội địa Trung, nhập khẩu chính hãng.',
      'Sản xuất tại Đức.',
      'Hơn 10 nghìn người mua tin dùng.',
      'Được đánh giá 4.9 sao.',
      '1000+ review 5 sao.',
      'Sale 50% toàn bộ.',
      'Tặng kèm túi đựng.',
      'Miễn phí giao hàng toàn quốc.',
      'Số lượng có hạn, nhanh tay!',
      'Giảm 30% hôm nay.',
    ];
    const missed = [];
    for (const text of paraphrases) {
      const r = checkContent(baseContent({ detailed_description: text }), { evidenceText: '' });
      if (r.passed) missed.push(text);
    }
    assert.deepEqual(missed, [], `các câu sau lọt lưới chống bịa:\n${missed.join('\n')}`);
  });

  test('KHÔNG bắt nhầm nội dung sạch (không có dương tính giả)', () => {
    const clean = baseContent({
      product_name: 'Tai nghe chụp tai không dây',
      headline: 'Êm ái cho học tập và làm việc',
      short_description: 'Thiết kế ôm trọn vành tai, đeo lâu không mỏi.',
      selling_points: ['Kết nối không dây tiện lợi', 'Kiểu dáng gọn gàng, dễ mang theo'],
      detailed_description: 'Phù hợp cho học tập, làm việc và giải trí hàng ngày.',
      facebook_caption: 'Một lựa chọn tiện lợi cho người cần đeo thoải mái cả ngày.',
      tiktok_caption: 'Đeo êm, mang đi học đi làm đều tiện.',
      marketplace_description: 'Thiết kế chụp tai, kết nối không dây.',
      hashtags: ['#tainghe', '#hoconline'],
      seo: { title: 'Tai nghe chụp tai không dây', meta_description: 'Thiết kế êm ái, tiện lợi.', keywords: ['tai nghe chụp tai'] },
    });
    const r = checkContent(clean, { evidenceText: '' });
    assert.equal(r.passed, true, `bắt nhầm: ${JSON.stringify(r.violations.map((v) => v.matched))}`);
  });
});

describe('G09/G12 — phong cách & độ dài', () => {
  test('mặc định là bán hàng + vừa', () => {
    const o = parseContentOptions({});
    assert.equal(o.style, 'ban-hang');
    assert.equal(o.length, 'vua');
    assert.equal(o.isDefaultStyle, true);
    assert.equal(o.isDefaultLength, true);
  });

  test('có đủ 6 phong cách và 3 độ dài', () => {
    assert.equal(Object.keys(STYLES).length, 6);
    assert.equal(Object.keys(LENGTHS).length, 3);
    for (const id of ['ban-hang', 'chuyen-nghiep', 'ngan-gon', 'viral-tiktok', 'seo', 'cao-cap']) {
      assert.ok(STYLES[id], `thiếu phong cách ${id}`);
    }
    for (const id of ['ngan', 'vua', 'chi-tiet']) assert.ok(LENGTHS[id], `thiếu độ dài ${id}`);
  });

  test('giá trị lạ rơi về mặc định, không ném lỗi', () => {
    assert.equal(resolveStyle('khong-ton-tai').id, 'ban-hang');
    assert.equal(resolveLength('khong-ton-tai').id, 'vua');
    assert.equal(parseContentOptions({ style: null, length: undefined }).style, 'ban-hang');
  });

  test('mỗi phong cách có chỉ dẫn riêng', () => {
    const seen = new Set();
    for (const s of Object.values(STYLES)) {
      assert.ok(s.guidance.length > 20);
      assert.ok(!seen.has(s.guidance), 'chỉ dẫn phải khác nhau');
      seen.add(s.guidance);
    }
  });
});

describe('ContentEngine với provider giả', () => {
  test('sinh đủ 10 trường nội dung bắt buộc', async () => {
    const engine = realContentEngineWithMock([
      JSON.stringify(baseContent()),
    ]);
    const master = sampleMaster();
    const knowledge = mergeKnowledge(master, null);
    const out = await engine.generate(master, knowledge, { style: 'ban-hang', length: 'vua' });
    for (const k of CONTENT_KEYS) assert.ok(k in out.content, `thiếu trường ${k}`);
    assert.ok(out.content.hashtags.every((h) => h.startsWith('#')));
    assert.equal(out.guardrails.passed, true);
  });

  test('JSON bọc trong ``` vẫn parse được', async () => {
    const engine = realContentEngineWithMock(['```json\n' + JSON.stringify(baseContent()) + '\n```']);
    const out = await engine.generate(sampleMaster(), mergeKnowledge(sampleMaster(), null), {});
    assert.equal(out.content.product_name, 'Đồ chơi毛绒');
  });

  test('JSON hỏng → ContentError rõ ràng', async () => {
    const engine = realContentEngineWithMock(['đây không phải JSON']);
    await assert.rejects(
      () => engine.generate(sampleMaster(), mergeKnowledge(sampleMaster(), null), {}),
      (e) => e instanceof ContentError && e.code === 'CONTENT_BAD_JSON',
    );
  });

  test('vi phạm guardrails → TỰ ĐỘNG gọi lượt sửa', async () => {
    const bad = baseContent({ short_description: 'Bảo hành 24 tháng, chống nước IP68.' });
    const fixed = baseContent({ short_description: 'Món đồ chơi mềm mại, màu sắc rực rỡ.' });
    const engine = realContentEngineWithMock([JSON.stringify(bad), JSON.stringify(fixed)]);
    const out = await engine.generate(sampleMaster(), mergeKnowledge(sampleMaster(), null), {});
    assert.equal(out.meta.repair_attempted, true);
    assert.equal(out.guardrails.passed, true, 'bản sửa phải sạch');
    assert.ok(!out.content.short_description.includes('bảo hành'));
  });

  test('bản sửa TỆ HƠN thì giữ nguyên bản gốc và vẫn báo vi phạm', async () => {
    const bad = baseContent({ short_description: 'Bảo hành 24 tháng.' });
    const worse = baseContent({ short_description: 'Bảo hành 36 tháng, chống nước IP68, đạt ISO 9001.' });
    const engine = realContentEngineWithMock([JSON.stringify(bad), JSON.stringify(worse)]);
    const out = await engine.generate(sampleMaster(), mergeKnowledge(sampleMaster(), null), {});
    assert.equal(out.guardrails.passed, false, 'phải trung thực báo CHƯA sạch');
    assert.ok(out.guardrails.violations.length > 0);
  });

  test('thiếu cấu hình AI → AiError AI_NOT_CONFIGURED', async () => {
    const engine = new ContentEngine({ provider: { configured: false, name: 'none', model: '' }, logger: silent, config: testConfig() });
    await assert.rejects(
      () => engine.generate(sampleMaster(), mergeKnowledge(sampleMaster(), null), {}),
      (e) => e instanceof AiError && e.code === 'AI_NOT_CONFIGURED',
    );
  });

  test('dịch: bỏ qua khi không có văn bản gốc', async () => {
    const engine = realContentEngineWithMock([]);
    const empty = sampleMaster({ title_original: '', description_original: '' });
    const r = await engine.translate(empty);
    assert.equal(r.skipped, true);
  });
});

describe('Tiện ích provider', () => {
  test('extractJson lấy được JSON từ văn bản lẫn tạp', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('Đây là kết quả:\n{"a":1}\nHết.'), { a: 1 });
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.equal(extractJson('không có json'), null);
    assert.equal(extractJson(null), null);
  });

  test('estimateCostFromUsage tính được với model đã biết, trả null với model lạ', () => {
    const c = estimateCostFromUsage('gpt-4o-mini', { prompt_tokens: 1_000_000, completion_tokens: 0 });
    assert.equal(c, 0.15);
    assert.equal(estimateCostFromUsage('model-hoan-toan-la', { prompt_tokens: 100 }), null);
    assert.equal(estimateCostFromUsage('gpt-4o-mini', null), null);
  });
});
