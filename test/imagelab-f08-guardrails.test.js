/**
 * TEST HỒI QUY ĐỘC LẬP — F-08 (MINOR) sau phản biện: guardrail dịch phải bắt được
 * những biến thể "bịa" từng lọt, VÀ vẫn KHÔNG bắt oan câu dịch trung thực.
 *
 * Năm biến thể từng lọt (theo docs/MVP-02-REVIEW.md §2 F-08):
 *   1. số viết bằng CHỮ tiếng Việt   — "mười hai tháng hậu mãi"
 *   2. chữ số FULL-WIDTH (Unicode)   — "１２ tháng"
 *   3. kana Nhật                     — "こんにちは" / "カタカナ"
 *   4. Hangul                        — "한국어" / "안녕하세요"
 *   5. ký tự VÔ HÌNH cắt từ khoá     — "bảo\u200bhành"
 *
 * Mỗi ca ĐỘC LẬP với bộ test của agent gộp (chữ gốc và câu dịch khác).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  enforceTranslationGuardrails,
  hasUntranslatedScript,
  toAsciiDigits,
} from '../src/imagelab/translate/guardrails.js';
import { TRANSLATE_STATUS } from '../src/imagelab/translate/lines.js';

const REGION = { kind: 'descriptive', translatable: true };

const check = (textOriginal, textVi) => enforceTranslationGuardrails(
  {
    region_id: 'r1',
    text_original: textOriginal,
    text_vi: textVi,
    status: TRANSLATE_STATUS.TRANSLATED,
    provenance: 'ai',
    confidence: 0.9,
    violations: [],
    notes: '',
    edited_by_user: false,
    edited_at: null,
  },
  { region: REGION },
);

describe('MVP-02 F-08 · guardrail bắt biến thể từng lọt', () => {
  const mustCatch = [
    // [chữ gốc, bản dịch bịa, mẫu vi phạm]
    ['纯棉T恤', 'Áo thun cotton mười hai tháng hậu mãi', /Số liệu/],
    ['纯棉T恤', 'Áo thun cotton ba năm bảo hành', /Số liệu/],
    ['纯棉T恤', 'Áo thun cotton hai mươi lần giặt', /Số liệu/],
    ['纯棉T恤', 'Áo thun cotton １２ tháng hậu mãi', /Số liệu/],
    ['纯棉T恤', 'Áo thun cotton ١٢ tháng hậu mãi', /Số liệu/],
    ['纯棉T恤', 'Áo thun cotton ๑๒ tháng hậu mãi', /Số liệu/],
    ['纯棉T恤', 'Áo thun cotton १२ महीने', /Số liệu/],
    ['纯棉T恤', 'Áo thun cotton こんにちは', /CHƯA DỊCH/],
    ['纯棉T恤', 'Áo thun cotton カタカナ', /CHƯA DỊCH/],
    ['纯棉T恤', 'Áo thun cotton 한국어', /CHƯA DỊCH/],
    ['纯棉T恤', 'Áo thun cotton 안녕하세요', /CHƯA DỊCH/],
    ['纯棉T恤', 'Áo thun cotton bảo\u200bhành 12 tháng', /bảo hành/i],
    ['纯棉T恤', 'Áo thun cotton bảo\u200dhành', /bảo hành/i],
    ['纯棉T恤', 'Áo thun cotton bảo\u2060hành', /bảo hành/i],
    ['纯棉T恤', 'Áo thun cotton 1\u200b2 tháng', /Số liệu/],
  ];

  for (const [original, vi, pattern] of mustCatch) {
    test(`BẮT ${JSON.stringify(vi)} cho ${JSON.stringify(original)} (${pattern.source})`, () => {
      const out = check(original, vi);
      assert.equal(out.line.status, TRANSLATE_STATUS.NEEDS_REVIEW, `phải là NEEDS_REVIEW, nhận ${out.line.status}`);
      assert.ok(out.violations.length > 0, 'phải có ít nhất một vi phạm');
      assert.match(out.violations.join(' | '), pattern);
    });
  }

  const mustPass = [
    // [chữ gốc, bản dịch TRUNG THỰC]
    ['纯棉短袖T恤', 'Áo thun cotton thoáng mát, đường may chắc chắn'],
    ['500毫升', '500 ml'],
    ['保修12个月', 'Bảo hành 12 tháng'],
    ['三年质保', 'Bảo hành ba năm'], // số viết bằng chữ NHƯNG chữ gốc có đúng số đó
    ['七天内发货', 'Giao hàng trong 7 ngày'],
    ['防水IP68', 'Chống nước IP68'],
  ];

  for (const [original, vi] of mustPass) {
    test(`KHÔNG bắt oan ${JSON.stringify(vi)} cho ${JSON.stringify(original)}`, () => {
      const out = check(original, vi);
      assert.deepEqual(out.violations, [], `bị bắt oan: ${out.violations.join(' | ')}`);
      assert.equal(out.line.status, TRANSLATE_STATUS.TRANSLATED);
    });
  }

  test('chuẩn hoá chữ số Unicode: mọi bộ \\p{Nd} đều về ASCII (không phụ thuộc NFKC)', () => {
    assert.equal(toAsciiDigits('１２３'), '123');
    assert.equal(toAsciiDigits('١٢٣'), '123');
    assert.equal(toAsciiDigits('๑๒๓'), '123');
    assert.equal(toAsciiDigits('१२३'), '123');
    assert.equal(toAsciiDigits('abc 12'), 'abc 12');
  });

  test('phát hiện hệ chữ chưa dịch: Hán, kana (kể cả halfwidth), Hangul/Jamo', () => {
    for (const s of ['纯棉', 'こんにちは', 'カタカナ', 'ﾊﾝｶｸ', '한국어', 'ㄱㄴㄷ']) {
      assert.equal(hasUntranslatedScript(s), true, `phải nhận ra chữ chưa dịch: ${s}`);
    }
    for (const s of ['Áo thun cotton', 'Bảo hành 12 tháng', '500 ml']) {
      assert.equal(hasUntranslatedScript(s), false, `không được báo nhầm: ${s}`);
    }
  });

  /* ─────────── BA LỖ HỔNG F-08 ĐÃ ĐƯỢC VÁ (vòng 3) ───────────
   *
   * Ba test dưới đây từng bị `skip` vì mã cũ để lọt; agent gộp vòng 3 đã vá
   * (F-08a đơn vị tiền tệ · F-08b `\p{No}`/`\p{Nl}` · F-08c NFKC) và GỠ `skip`.
   * Nội dung khẳng định giữ nguyên — chỉ bỏ cờ skip và đổi tên cho khỏi nói sai.
   */
  // F-08a — ĐÃ VÁ (vòng 3): thêm đơn vị tiền tệ vào COUNTED_UNITS. Cờ `skip` đã được gỡ.
  test('giá bịa bằng CHỮ + đơn vị tiền tệ ("…nghìn đồng") phải bị bắt', () => {
    const out = check('纯棉T恤', 'Áo thun cotton một trăm hai mươi nghìn đồng');
    assert.equal(out.line.status, TRANSLATE_STATUS.NEEDS_REVIEW);
    assert.match(out.violations.join(' | '), /Số liệu/);
  });

  // F-08b — ĐÃ VÁ (vòng 3): NFKC + luật riêng cho `\p{No}`/`\p{Nl}`. Cờ `skip` đã được gỡ.
  test('chữ số khoanh tròn ①② phải bị bắt', () => {
    const out = check('纯棉T恤', 'Áo thun cotton ①② tháng');
    assert.equal(out.line.status, TRANSLATE_STATUS.NEEDS_REVIEW);
  });

  // F-08c — ĐÃ VÁ (vòng 3): `normalizeForMatch` dùng NFKC. Cờ `skip` đã được gỡ.
  test('từ khoá viết bằng chữ FULL-WIDTH Latin ("ｂảo hành") phải bị bắt', () => {
    const out = check('纯棉T恤', 'Áo thun cotton ｂảo hành');
    assert.equal(out.line.status, TRANSLATE_STATUS.NEEDS_REVIEW);
    assert.match(out.violations.join(' | '), /bảo hành/i);
  });
});
