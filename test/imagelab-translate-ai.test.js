/**
 * MVP-02 — TRANSLATOR VỚI PROVIDER AI (`TRANSLATE_PROVIDER=ai`).
 *
 * Đây là nhánh sẽ chạy THẬT khi Owner cắm provider AI trả tiền, nhưng trong repo nó gần như
 * chưa được phủ (`src/imagelab/translate/index.js` ~80% dòng). Test dùng provider AI GIẢ
 * (không gọi mạng, không tốn tiền) nhưng đi qua ĐÚNG đường mã của nhánh `ai`.
 *
 * Những gì phải đúng — và đây cũng là các luật của dự án:
 *   1. Vùng KHÔNG được phép dịch (nhãn hiệu / chứng nhận / giá / unknown) **không bao giờ**
 *      được gửi cho provider (kiểm bằng chính chuỗi prompt provider nhận được).
 *   2. Provider bỏ sót vùng ⇒ không được im lặng: từ điển cứu được thì `GLOSSARY` (truy nguồn),
 *      không cứu được thì `NEEDS_REVIEW` + cảnh báo.
 *   3. Provider trả `region_id` lạ ⇒ bỏ qua + cảnh báo (không tin dữ liệu thừa).
 *   4. Provider trả JSON hỏng / ném lỗi ⇒ `FAILED` + `error_code`, KHÔNG lộ chi tiết nội bộ.
 *   5. `usage` là SỐ KÝ TỰ (input = ký tự chữ gốc cần dịch, output = ký tự bản dịch).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createTranslator } from '../src/imagelab/translate/index.js';
import { TRANSLATE_STATUS } from '../src/imagelab/translate/lines.js';
import { testConfig, silent } from './helpers.js';

/** Vùng theo đúng hình dạng `Region` của hợp đồng §3.2. */
const region = (id, text, kind = 'descriptive') => ({
  id,
  box: { x: 10, y: 10 + Number(String(id).slice(1) || 0) * 40, w: 120, h: 30 },
  box_normalized: { x: 0.03, y: 0.03, w: 0.37, h: 0.09 },
  text,
  lang: 'zh-Hans',
  confidence: 0.9,
  kind,
  kind_reason: `loại ${kind}`,
  translatable: kind === 'descriptive',
  source: 'ocr',
});

/** Provider AI giả: ghi lại NGUYÊN VĂN messages để test kiểm được prompt. */
function fakeAi({ lines = [], fail = null, raw = null } = {}) {
  const calls = [];
  return {
    name: 'fake-ai',
    model: 'fake-ai-1',
    configured: true,
    isMock: false,
    calls,
    async chat(messages, opts = {}) {
      calls.push({ messages, opts });
      if (fail) throw fail;
      const content = raw !== null ? raw : JSON.stringify({ lines });
      return { content, model: 'fake-ai-1', usage: { prompt_tokens: 11, completion_tokens: 22 } };
    },
  };
}

const translatorWith = (ai) =>
  createTranslator(testConfig({ TRANSLATE_PROVIDER: 'ai' }), { logger: silent, aiProvider: ai });

const promptTextOf = (ai) => ai.calls.flatMap((c) => c.messages.map((m) => String(m.text || ''))).join('\n');

describe('MVP-02 translate · provider AI', () => {
  test('CHỈ vùng mô tả được gửi đi; vùng nhãn hiệu/chứng nhận/giá/unknown KHÔNG lọt prompt', async () => {
    const ai = fakeAi({ lines: [{ region_id: 'r2', text_vi: 'Áo thun cotton' }] });
    const translator = translatorWith(ai);

    const regions = [
      region('r1', '品牌旗舰店', 'brand'),
      region('r2', '纯棉短袖T恤', 'descriptive'),
      region('r3', '3C认证', 'certification'),
      region('r4', '¥39.9', 'price'),
      region('r5', '??', 'unknown'),
    ];
    const res = await translator.translateRegions(regions, { context: 'ảnh áo thun' });

    const prompt = promptTextOf(ai);
    assert.match(prompt, /纯棉短袖T恤/, 'vùng mô tả phải có trong prompt');
    for (const [id, text] of [['r1', '品牌旗舰店'], ['r3', '3C认证'], ['r4', '¥39.9'], ['r5', '??']]) {
      assert.ok(!prompt.includes(text), `chuỗi của vùng khoá ${id} ("${text}") KHÔNG được có trong prompt`);
    }
    assert.equal(ai.calls.length, 1, 'chỉ gọi provider 1 lần');

    const byId = new Map(res.lines.map((l) => [l.region_id, l]));
    assert.equal(byId.get('r2').status, TRANSLATE_STATUS.TRANSLATED);
    assert.equal(byId.get('r2').text_vi, 'Áo thun cotton');
    assert.equal(byId.get('r1').status, TRANSLATE_STATUS.SKIPPED_BRAND);
    assert.equal(byId.get('r1').text_vi, '');
    assert.equal(byId.get('r3').status, TRANSLATE_STATUS.SKIPPED_CERTIFICATION);
    assert.equal(byId.get('r4').status, TRANSLATE_STATUS.SKIPPED_PRICE);
    assert.equal(byId.get('r5').status, TRANSLATE_STATUS.NEEDS_REVIEW);
    assert.equal(res.usage.input_units, '纯棉短袖T恤'.length, 'input_units = số ký tự chữ gốc CẦN dịch');
    assert.equal(res.usage.output_units, 'Áo thun cotton'.length, 'output_units = số ký tự bản dịch');
  });

  test('provider bỏ sót vùng: từ điển cứu được ⇒ GLOSSARY (có truy nguồn) + cảnh báo', async () => {
    // `厂家直销` có trong từ điển thuật ngữ của dự án.
    const ai = fakeAi({ lines: [{ region_id: 'r1', text_vi: 'Áo thun' }] });
    const translator = translatorWith(ai);

    const res = await translator.translateRegions([region('r1', '纯棉T恤'), region('r2', '厂家直销')], {});

    const r2 = res.lines.find((l) => l.region_id === 'r2');
    assert.equal(r2.status, TRANSLATE_STATUS.GLOSSARY);
    assert.equal(r2.provenance, 'glossary', 'bản dịch cứu từ từ điển phải truy được nguồn');
    assert.ok(r2.text_vi.length > 0, 'phải có chữ Việt từ từ điển');
    assert.match(res.warnings.join(' '), /từ điển thuật ngữ/i);
  });

  test('provider bỏ sót vùng KHÔNG cứu được ⇒ NEEDS_REVIEW + cảnh báo (không bịa)', async () => {
    const ai = fakeAi({ lines: [] });
    const translator = translatorWith(ai);

    const res = await translator.translateRegions([region('r1', '纯棉T恤')], {});

    const r1 = res.lines.find((l) => l.region_id === 'r1');
    assert.equal(r1.status, TRANSLATE_STATUS.NEEDS_REVIEW);
    assert.equal(r1.text_vi, '', 'không được tự bịa bản dịch');
    assert.equal(r1.provenance, 'none');
    assert.match(res.warnings.join(' '), /không được provider trả bản dịch/i);
  });

  test('provider trả `region_id` LẠ ⇒ bỏ qua + cảnh báo', async () => {
    const ai = fakeAi({
      lines: [
        { region_id: 'r1', text_vi: 'Áo thun' },
        { region_id: 'khong-ton-tai', text_vi: 'Bịa đặt' },
      ],
    });
    const translator = translatorWith(ai);

    const res = await translator.translateRegions([region('r1', '纯棉T恤')], {});

    assert.equal(res.lines.length, 1, 'chỉ có 1 vùng được yêu cầu thì chỉ được có 1 dòng');
    assert.ok(!JSON.stringify(res.lines).includes('Bịa đặt'), 'dữ liệu thừa không được lọt vào kết quả');
    assert.match(res.warnings.join(' '), /region_id không có trong yêu cầu/i);
  });

  test('provider trả JSON hỏng ⇒ FAILED + error_code, dòng ở trạng thái FAILED, không lộ chi tiết', async () => {
    const ai = fakeAi({ raw: 'day khong phai JSON {{' });
    const translator = translatorWith(ai);

    const res = await translator.translateRegions([region('r1', '纯棉T恤')], {});

    assert.equal(res.status, 'FAILED');
    assert.equal(res.error_code, 'TRANSLATE_BAD_JSON');
    const r1 = res.lines.find((l) => l.region_id === 'r1');
    assert.equal(r1.status, TRANSLATE_STATUS.FAILED);
    assert.match(res.warnings.join(' '), /Provider dịch lỗi/i);
    // Không được lộ prompt/secret trong thông báo lỗi.
    assert.ok(!res.error_message.includes('纯棉T恤'), 'thông báo lỗi không được chứa nội dung gửi đi');
  });

  test('provider NÉM lỗi (mạng/timeout) ⇒ FAILED + mã lỗi của provider', async () => {
    const err = new Error('ETIMEDOUT gọi API');
    err.code = 'AI_TIMEOUT';
    const ai = fakeAi({ fail: err });
    const translator = translatorWith(ai);

    const res = await translator.translateRegions([region('r1', '纯棉T恤'), region('r2', '纯棉T恤2')], {});

    assert.equal(res.status, 'FAILED');
    assert.equal(res.error_code, 'AI_TIMEOUT');
    for (const line of res.lines) {
      assert.equal(line.status, TRANSLATE_STATUS.FAILED);
      assert.equal(line.text_vi, '');
    }
  });

  test('không có vùng nào cần dịch ⇒ KHÔNG gọi provider (không tốn tiền)', async () => {
    const ai = fakeAi({ lines: [] });
    const translator = translatorWith(ai);

    const res = await translator.translateRegions([region('r1', '品牌旗舰店', 'brand')], {});

    assert.equal(ai.calls.length, 0, 'không có vùng translatable thì không được gọi API');
    assert.equal(res.lines[0].status, TRANSLATE_STATUS.SKIPPED_BRAND);
    assert.equal(res.usage, null);
  });

  test('prompt chứa ngữ cảnh nhưng KHÔNG chứa vùng bị khoá, và có chỉ dẫn không bịa', async () => {
    const ai = fakeAi({ lines: [{ region_id: 'r1', text_vi: 'Áo thun' }] });
    const translator = translatorWith(ai);

    await translator.translateRegions([region('r1', '纯棉T恤'), region('r9', '品牌旗舰店', 'brand')], {
      context: 'Ảnh sản phẩm áo thun nam',
    });

    const prompt = promptTextOf(ai);
    assert.match(prompt, /Ảnh sản phẩm áo thun nam/, 'ngữ cảnh được truyền để hiểu ảnh');
    assert.ok(!prompt.includes('品牌旗舰店'), 'vùng bị khoá không được lọt vào prompt dù có ngữ cảnh');
    assert.match(prompt, /JSON/i, 'prompt phải yêu cầu trả JSON theo hợp đồng');
  });
});
