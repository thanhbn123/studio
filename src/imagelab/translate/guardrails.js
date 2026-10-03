/**
 * C2 — Guardrail cho bản dịch chữ trên ảnh.
 *
 * Đây là lớp kiểm CUỐI, chạy trên VĂN BẢN ĐÃ SINH (dù từ AI, từ từ điển, hay do người dùng sửa),
 * độc lập với prompt — prompt có thể bị model bỏ qua, lớp này thì không.
 *
 * Bốn luật bắt buộc (mỗi vi phạm là một câu tiếng Việt trong `violations`, và đặt NEEDS_REVIEW):
 *   a) `text_vi` chứa số liệu / đơn vị KHÔNG có trong `text_original`;
 *   b) `text_vi` vẫn còn ký tự CJK (U+3400–U+4DBF, U+4E00–U+9FFF) → "CHƯA DỊCH";
 *   c) `text_vi` chứa từ khẳng định thuộc nhóm cấm mà `text_original` không có;
 *   d) `text_vi` rỗng nhưng `translatable === true`.
 *
 * ⚠️ BÀI HỌC ĐÃ TRẢ GIÁ CỦA DỰ ÁN: `\b` của JavaScript chỉ hiểu [A-Za-z0-9_], nên
 * `\b(?:bảo hành|chống nước)\b` KHÔNG BAO GIỜ khớp. Vì vậy trong file này:
 *   - KHÔNG dùng `\b` quanh bất kỳ từ tiếng Việt / chữ Hán nào;
 *   - `\b` chỉ xuất hiện quanh token thuần ASCII (bh, iso, ce, ip68, 3c, số 1…).
 */

import { TRANSLATE_STATUS } from './lines.js';

/* ─────────────────────── 1. Phát hiện ký tự CJK ─────────────────────── */

const CJK_CLASS = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF';

/** `text_vi` còn chữ Hán ⇒ CHƯA DỊCH. */
export function hasCjk(text) {
  return new RegExp(`[${CJK_CLASS}]`).test(String(text ?? ''));
}

/** Trích vài đoạn chữ Hán còn sót để hiện lên UI (tối đa `maxRuns` đoạn). */
export function cjkSample(text, maxRuns = 3) {
  const runs = String(text ?? '').match(new RegExp(`[${CJK_CLASS}]+`, 'g')) || [];
  return runs.slice(0, maxRuns).join(' ');
}

/** Danh sách ký tự CJK duy nhất (để ghi log / đối chiếu). */
export function cjkChars(text) {
  const found = String(text ?? '').match(new RegExp(`[${CJK_CLASS}]`, 'g')) || [];
  return [...new Set(found)];
}

/* ─────────────────────── 2. Số liệu & đơn vị ─────────────────────── */

const CN_DIGITS = Object.freeze({
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
});

const CN_MULTIPLIERS = Object.freeze({ 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 });

const CN_NUMERAL_RUN = /[零〇一二两三四五六七八九十百千万亿]+/g;

function chineseRunToNumber(run) {
  const hasMultiplier = /[十百千万亿]/.test(run);
  if (!hasMultiplier) {
    // Chuỗi chữ số thuần: 一二三 → 123
    return [...run].map((c) => String(CN_DIGITS[c] ?? '')).join('');
  }
  let total = 0;
  let section = 0;
  let digit = 0;
  for (const ch of run) {
    if (CN_DIGITS[ch] !== undefined) {
      digit = CN_DIGITS[ch];
    } else if (CN_MULTIPLIERS[ch]) {
      const unit = CN_MULTIPLIERS[ch];
      if (unit >= 10000) {
        section = (section + digit) * unit;
        total += section;
        section = 0;
      } else {
        section += (digit || 1) * unit;
      }
      digit = 0;
    }
  }
  return String(total + section + digit);
}

/**
 * Đổi chữ số Hán sang Ả Rập để so sánh công bằng:
 * "七天" chứa số 7, "三合一" chứa 3 và 1 — nếu không đổi sẽ bắt oan bản dịch đúng.
 */
export function convertChineseNumerals(text) {
  return String(text ?? '').replace(CN_NUMERAL_RUN, (run) => ` ${chineseRunToNumber(run)} `);
}

/** Chuẩn hoá một token số để so khớp: "3,5" → "3.5"; "1.000" → "1000". */
export function normalizeNumberToken(token) {
  const t = String(token ?? '').trim();
  if (!t) return '';
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(t)) return t.replace(/[.,]/g, '');
  return t.replace(',', '.');
}

/** Tập hợp số có trong văn bản (đã đổi chữ số Hán). */
export function numbersIn(text) {
  const converted = convertChineseNumerals(text);
  const set = new Set();
  for (const m of converted.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const n = normalizeNumberToken(m[0]);
    if (n) set.add(n);
  }
  return set;
}

/** Số Ả Rập (không đổi chữ số Hán) — dùng cho phía tiếng Việt. */
export function asciiNumbersIn(text) {
  const set = new Set();
  for (const m of String(text ?? '').matchAll(/\d+(?:[.,]\d+)?/g)) {
    const n = normalizeNumberToken(m[0]);
    if (n) set.add(n);
  }
  return set;
}

/** Đơn vị tiếng Trung → đơn vị chuẩn (không dùng cờ /g để tránh trạng thái lastIndex). */
const CN_UNIT_ALIASES = Object.freeze([
  [/毫安时|毫安/, 'mah'],
  [/毫升/, 'ml'],
  [/千克|公斤/, 'kg'],
  [/厘米/, 'cm'],
  [/毫米/, 'mm'],
  [/英寸/, 'inch'],
  [/千米|公里/, 'km'],
  [/小时|钟头/, 'giờ'],
  [/分钟/, 'phút'],
  [/个月/, 'tháng'],
  [/[天日]/, 'ngày'],
  [/年/, 'năm'],
  [/瓦特|瓦/, 'w'],
  [/伏特|伏/, 'v'],
  [/升/, 'l'],
  [/米/, 'm'],
  [/克/, 'g'],
]);

/**
 * Mẫu "số + đơn vị" phía tiếng Việt.
 * Lookahead `(?![a-zà-ỹ0-9])` để "12 lần" KHÔNG bị hiểu thành "12 l".
 */
const VI_NUM_UNIT_SOURCE =
  '(\\d+(?:[.,]\\d+)?)\\s*(mAh|kWh|kW|Hz|ml|kg|mg|mm|cm|km|inch|W|V|L|l|g|m|%|giờ|ngày|tuần|tháng|năm|phút|giây|độ|đ|vnđ)(?![a-zà-ỹ0-9])';

const UNIT_CANON = Object.freeze({
  mah: 'mah',
  kwh: 'kwh',
  kw: 'kw',
  w: 'w',
  v: 'v',
  hz: 'hz',
  ml: 'ml',
  kg: 'kg',
  mg: 'mg',
  mm: 'mm',
  cm: 'cm',
  km: 'km',
  m: 'm',
  l: 'l',
  g: 'g',
  inch: 'inch',
  '%': '%',
  'giờ': 'giờ',
  'ngày': 'ngày',
  'tuần': 'tuần',
  'tháng': 'tháng',
  'năm': 'năm',
  'phút': 'phút',
  'giây': 'giây',
  'độ': 'độ',
  'đ': 'đ',
  'vnđ': 'vnđ',
});

function canonicalUnit(raw) {
  return UNIT_CANON[String(raw ?? '').toLowerCase()] ?? null;
}

/** Tập hợp đơn vị có trong văn bản (cả đơn vị Latin lẫn từ chỉ đơn vị tiếng Trung). */
export function unitsIn(text) {
  const s = String(text ?? '');
  const set = new Set();
  for (const m of s.matchAll(new RegExp(VI_NUM_UNIT_SOURCE, 'gi'))) {
    const u = canonicalUnit(m[2]);
    if (u) set.add(u);
  }
  for (const [re, canon] of CN_UNIT_ALIASES) {
    if (re.test(s)) set.add(canon);
  }
  return set;
}

/**
 * Luật (a): số liệu / đơn vị trong `text_vi` mà `text_original` không có.
 * @returns {string[]} câu tiếng Việt
 */
export function checkNumericClaims(textOriginal, textVi) {
  const out = [];
  const originalNumbers = numbersIn(textOriginal);
  const viNumbers = asciiNumbersIn(textVi);

  const missing = [...viNumbers].filter((n) => !originalNumbers.has(n));
  if (missing.length > 0) {
    const shown = missing.slice(0, 3).map((n) => `“${n}”`).join(', ');
    out.push(`Số liệu ${shown} không có trong chữ gốc — không được tự thêm số.`);
    if (missing.length > 3) {
      out.push(`Còn ${missing.length - 3} số liệu khác không có trong chữ gốc — cần người duyệt.`);
    }
  }

  const originalUnits = unitsIn(textOriginal);
  const missingUnits = [...unitsIn(textVi)].filter((u) => !originalUnits.has(u));
  if (missingUnits.length > 0) {
    const shown = missingUnits.slice(0, 3).map((u) => `“${u}”`).join(', ');
    out.push(`Đơn vị ${shown} không có trong chữ gốc — không được tự thêm đơn vị.`);
  }

  return out;
}

/* ─────────────────────── 3. Khẳng định thuộc nhóm cấm ─────────────────────── */

/**
 * Nhóm khẳng định bị soi (luật c).
 * `vi`: mẫu bắt trong bản dịch — KHÔNG có `\b` quanh từ tiếng Việt.
 * `zh`: mẫu tương đương trong CHỮ GỐC — nếu chữ gốc đã nói điều đó thì bản dịch hợp lệ.
 */
export const CLAIM_GROUPS = Object.freeze([
  {
    id: 'warranty',
    label: 'bảo hành/đổi trả',
    vi: /bảo hành|bảo đảm|bảo trì|đổi trả|đổi mới|hoàn tiền|trả hàng|cam kết|\bbh\b/gi,
    zh: /保修|质保|保固|联保|三包|退换|包退|包换|售后|退款|退货|承诺|保障|保证/,
  },
  {
    id: 'certification',
    label: 'chứng nhận',
    vi: /chứng nhận|đạt chuẩn|kiểm định|chứng chỉ|\biso\b|\bce\b|\bfda\b|\brohs\b|\bfcc\b|\bgmp\b|\bhaccp\b|\b3c\b/gi,
    zh: /认证|合格证|检验|质检|检测报告|执行标准|防伪|ISO|CE|FDA|RoHS|FCC|GMP|HACCP|3C/,
  },
  {
    id: 'waterproof',
    label: 'chống nước',
    vi: /chống nước|kháng nước|ngâm nước|không thấm nước|chống thấm|chống bụi nước|waterproof|đi mưa|không sợ mưa|rửa trực tiếp|lặn sâu|\bipx?\d{1,2}\b|\b\d+\s*atm\b/gi,
    zh: /防水|防泼水|防雨|IPX?\d{1,2}|\d+\s*ATM/i,
  },
  {
    id: 'genuine',
    label: 'chính hãng',
    vi: /chính hãng|hàng thật|hàng auth|authentic|hàng chuẩn/gi,
    zh: /正品|行货|真品|官方正品/,
  },
  {
    id: 'number_one',
    label: 'số 1',
    vi: /số\s*1\b|số một|top\s*1\b|đứng đầu|dẫn đầu|bán chạy nhất/gi,
    zh: /第一|销量第一|排名第一|冠军|榜首/,
  },
  {
    id: 'best',
    label: 'tốt nhất',
    vi: /tốt nhất|hay nhất|ưu việt nhất|hoàn hảo nhất/gi,
    zh: /最好|最佳|最优|最棒/,
  },
  {
    id: 'premium',
    label: 'cao cấp nhất',
    vi: /cao cấp nhất|sang trọng nhất|đẳng cấp nhất|cao cấp số 1/gi,
    zh: /最高级|最高端|顶级|至尊/,
  },
  {
    id: 'absolute_safe',
    label: 'an toàn tuyệt đối',
    vi: /an toàn tuyệt đối|tuyệt đối an toàn|100%\s*an toàn|an toàn 100%/gi,
    zh: /绝对安全|100%安全|百分百安全/,
  },
]);

/**
 * Luật (c): khẳng định trong `text_vi` mà `text_original` không hề nói tới.
 * @returns {string[]} câu tiếng Việt
 */
export function checkClaimWords(textOriginal, textVi) {
  const out = [];
  const original = String(textOriginal ?? '');
  const viText = String(textVi ?? '');
  for (const group of CLAIM_GROUPS) {
    const re = new RegExp(group.vi.source, group.vi.flags.includes('g') ? group.vi.flags : `${group.vi.flags}g`);
    const hits = [...new Set([...viText.matchAll(re)].map((m) => m[0]))];
    if (hits.length === 0) continue;
    // Chữ gốc đã có khẳng định tương đương (tiếng Trung) ⇒ bản dịch trung thực, không bịa.
    if (new RegExp(group.zh.source, group.zh.flags.replace('g', '')).test(original)) continue;
    for (const hit of hits) {
      if (original.toLowerCase().includes(hit.toLowerCase())) continue;
      out.push(`Khẳng định “${hit}” (nhóm ${group.label}) không có trong chữ gốc — cần người duyệt.`);
    }
  }
  return out;
}

/* ─────────────────────── 4. Hàm kiểm tổng ─────────────────────── */

/** Suy ra `translatable` một cách fail-closed: chỉ vùng mô tả mới được dịch. */
export function resolveTranslatable(line, region) {
  const kind = String(region?.kind ?? line?.kind ?? '').toLowerCase();
  // LUẬT 3 thắng mọi cờ khác: nhãn hiệu/chứng nhận/giá/không rõ loại thì không bao giờ "cần dịch".
  if (kind === 'brand' || kind === 'certification' || kind === 'price' || kind === 'unknown') return false;
  if (line?.status === TRANSLATE_STATUS.SKIPPED_BRAND) return false;
  if (line?.status === TRANSLATE_STATUS.SKIPPED_CERTIFICATION) return false;
  if (line?.status === TRANSLATE_STATUS.SKIPPED_PRICE) return false;
  if (typeof line?.translatable === 'boolean') return line.translatable;
  if (typeof region?.translatable === 'boolean') return region.translatable;
  return kind === 'descriptive' || kind === '';
}

/**
 * Kiểm một dòng đã dịch.
 * @param {object} line TranslatedLine (có thể kèm field phụ của C4 — được giữ nguyên)
 * @param {{region?: object}} [options]
 * @returns {{line: object, violations: string[]}}
 */
export function enforceTranslationGuardrails(line, { region } = {}) {
  const base = { ...(line || {}) };
  const textOriginal = String(base.text_original ?? region?.text ?? '');
  const textVi = String(base.text_vi ?? '');
  const translatable = resolveTranslatable(base, region);

  const violations = [...(Array.isArray(base.violations) ? base.violations : [])];

  // (a) số liệu / đơn vị không có trong chữ gốc
  violations.push(...checkNumericClaims(textOriginal, textVi));

  // (b) còn ký tự CJK → CHƯA DỊCH
  if (hasCjk(textVi)) {
    violations.push(
      `CHƯA DỊCH: bản dịch còn ký tự Trung Quốc (${cjkSample(textVi)}) — phải dịch hết hoặc để người duyệt.`,
    );
  }

  // (c) khẳng định không có trong chữ gốc
  violations.push(...checkClaimWords(textOriginal, textVi));

  // (d) rỗng nhưng phải dịch. Bỏ qua dòng FAILED: lỗi provider đã có mã lỗi riêng (luật 4 của hợp đồng).
  if (translatable && textVi.trim() === '' && base.status !== TRANSLATE_STATUS.FAILED) {
    violations.push('Bản dịch rỗng nhưng vùng này phải dịch (translatable = true) — cần người duyệt.');
  }

  const unique = [...new Set(violations)];
  let status = base.status;
  if (status === undefined || status === null) {
    status = textVi.trim() === '' ? TRANSLATE_STATUS.NEEDS_REVIEW : TRANSLATE_STATUS.TRANSLATED;
  }
  // Có vi phạm ⇒ NEEDS_REVIEW. Ngoại lệ duy nhất: dòng FAILED giữ nguyên trạng thái lỗi provider.
  if (unique.length > 0 && status !== TRANSLATE_STATUS.FAILED) status = TRANSLATE_STATUS.NEEDS_REVIEW;

  const next = { ...base, status, violations: unique };
  return { line: next, violations: unique };
}

export default enforceTranslationGuardrails;
