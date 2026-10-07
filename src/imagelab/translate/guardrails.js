/**
 * C2 — Guardrail cho bản dịch chữ trên ảnh.
 *
 * Đây là lớp kiểm CUỐI, chạy trên VĂN BẢN ĐÃ SINH (dù từ AI, từ từ điển, hay do người dùng sửa),
 * độc lập với prompt — prompt có thể bị model bỏ qua, lớp này thì không.
 *
 * Bốn luật bắt buộc (mỗi vi phạm là một câu tiếng Việt trong `violations`, và đặt NEEDS_REVIEW):
 *   a) `text_vi` chứa số liệu / đơn vị KHÔNG có trong `text_original`;
 *   b) `text_vi` vẫn còn ký tự CHƯA DỊCH — Hán (U+3400–U+4DBF, U+4E00–U+9FFF),
 *      kana Nhật (`\p{Script=Hiragana}`/`\p{Script=Katakana}`) và Hangul (`\p{Script=Hangul}`);
 *   c) `text_vi` chứa từ khẳng định thuộc nhóm cấm mà `text_original` không có;
 *   d) `text_vi` rỗng nhưng `translatable === true`.
 *
 * Siết thêm sau phản biện F-08 (giới hạn của phương pháp regex, đã ghi rõ để không ai
 * đọc thành "guardrail chặn mọi ca bịa"):
 *   - MỌI luật chạy trên văn bản đã bỏ ký tự vô hình (U+200B–U+200D, U+FEFF, U+2060) + NFC;
 *   - Số dùng `\p{Nd}` (bắt cả chữ số full-width １２ và các bộ chữ số khác);
 *   - Số VIẾT BẰNG CHỮ tiếng Việt đi kèm đơn vị/thời gian ("mười hai tháng") cũng bị coi
 *     là số liệu ⇒ vi phạm (a) nếu chữ gốc không có số đó.
 *
 * ⚠️ BÀI HỌC ĐÃ TRẢ GIÁ CỦA DỰ ÁN: `\b` của JavaScript chỉ hiểu [A-Za-z0-9_], nên
 * `\b(?:bảo hành|chống nước)\b` KHÔNG BAO GIỜ khớp. Vì vậy trong file này:
 *   - KHÔNG dùng `\b` quanh bất kỳ từ tiếng Việt / chữ Hán nào;
 *   - `\b` chỉ xuất hiện quanh token thuần ASCII (bh, iso, ce, ip68, 3c, số 1…);
 *   - chỗ cần biên từ của chữ có dấu thì dùng lookaround `(?<![\p{L}\p{N}])` / `(?![\p{L}\p{N}])`.
 */

import { TRANSLATE_STATUS } from './lines.js';

/* ───────────────── 0. Chuẩn hoá trước khi so khớp (F-08) ─────────────────
 *
 * Kẻ bịa có thể chèn ký tự VÔ HÌNH vào giữa từ khoá ("bảo\u200bhành") để regex
 * không khớp. Mọi luật vì vậy phải chạy trên văn bản đã BỎ ký tự vô hình (thay bằng
 * khoảng trắng để "bảo\u200bhành" vẫn tách thành "bảo hành") và đã chuẩn hoá Unicode
 * **NFKC** (vòng 3 — F-08c) — nhưng KHÔNG được sửa văn bản gốc của người dùng.
 *
 * Vì sao NFKC chứ không chỉ NFC: NFKC gộp thêm các biến thể TƯƠNG THÍCH — chữ
 * FULL-WIDTH Latin ("ｂảo hành" → "bảo hành"), chỉ số trên ("²" → "2"), số khoanh tròn
 * ("①" → "1"), ký hiệu đơn vị ghép ("㎖" → "ml") — đúng những đường lách của F-08b/c.
 */

/**
 * Bỏ dấu tiếng Việt (N-6, vòng 4) để bắt được câu bịa viết KHÔNG DẤU
 * ("Ao thun cotton bao hanh mot nam") — cùng nội dung với câu có dấu đã bị chặn.
 *
 * `đ` không phải dấu tổ hợp nên phải thay riêng. Giữ nguyên chữ Hán/kana/Hangul.
 */
export function deaccent(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFC');
}

/**
 * Văn bản có dấu tiếng Việt (hoặc dấu tổ hợp bất kỳ) hay không — N-10 (vòng 5).
 *
 * Nhánh so khớp KHÔNG DẤU chỉ được dùng khi câu ứng viên **không có dấu nào**; nếu câu đã
 * có dấu thì so khớp như cũ. Nếu không, các từ KHÁC NGHĨA nhưng trùng chuỗi bỏ dấu sẽ bị
 * tố oan: "Chỉnh hàng" → "chinh hang" (chính hãng), "Đất chuẩn bị trồng" → "dat chuan"
 * (đạt chuẩn), "Tột nhất" → "tot nhat" (tốt nhất).
 */
export function hasDiacritics(text) {
  const s = String(text ?? '');
  return deaccent(s) !== s;
}

/** Ký tự vô hình: zero-width space/non-joiner/joiner, BOM, word-joiner. */
const INVISIBLE_RE = /[\u200B-\u200D\uFEFF\u2060]/g;

/** Bỏ hẳn ký tự vô hình (dùng khi cần dán liền hai mảnh chữ). */
export function stripInvisible(text) {
  return String(text ?? '').replace(INVISIBLE_RE, '');
}

/**
 * HOMOGLYPH → Latin (vòng 6, sau phán quyết PASS): bản dịch có thể trốn từ khoá bằng ký tự
 * Kirin/Greek giống hình ("bảo hànһ", "сao cấp"). Bảng dưới chỉ chứa ký tự THẬT SỰ giống hình
 * chữ Latin dùng trong tiếng Việt; văn bản tiếng Việt thật hầu như không chứa Kirin/Greek, nên
 * rủi ro tố oan thấp — và kể cả khi bị tố oan thì hệ quả chỉ là `NEEDS_REVIEW` cho người duyệt.
 */
const HOMOGLYPH_MAP = new Map(
  Object.entries({
    // Kirin → Latin
    а: 'a', А: 'A', в: 'B', В: 'B', е: 'e', Е: 'E', ё: 'e', Ё: 'E', к: 'k', К: 'K',
    м: 'm', М: 'M', н: 'h', Н: 'H', о: 'o', О: 'O', р: 'p', Р: 'P', с: 'c', С: 'C',
    т: 't', Т: 'T', у: 'y', У: 'Y', х: 'x', Х: 'X', і: 'i', І: 'I', ј: 'j', Ј: 'J',
    һ: 'h', ԁ: 'd', ѕ: 's', Ѕ: 'S', ԛ: 'q', ԝ: 'w',
    // Greek → Latin
    α: 'a', Α: 'A', ε: 'e', Ε: 'E', ι: 'i', Ι: 'I', κ: 'k', Κ: 'K', ν: 'v', Ν: 'N',
    ο: 'o', Ο: 'O', ρ: 'p', Ρ: 'P', τ: 't', Τ: 'T', υ: 'u', Υ: 'Y', χ: 'x', Χ: 'X', ѵ: 'v',
    // Vài ký tự "gần giống" khác hay gặp khi copy từ nguồn lạ.
    // Lưu ý: NFKC chạy TRƯỚC khi gộp nên ϲ (U+03F2) đã thành ς (U+03C2) và Ϲ (U+03F9) thành Σ
    // (U+03A3) — vì vậy phải map cả các dạng SAU chuẩn hoá, không chỉ dạng gõ vào.
    ϲ: 'c', Ϲ: 'C', ς: 'c', Σ: 'C', σ: 'c', ɡ: 'g', ѡ: 'w', ⅰ: 'i', ⅼ: 'l',
    // MVP-04 vòng 3: bổ sung Hy Lạp hay bị dùng để nguỵ trang từ khoá tiếng Việt
    ν: 'v', Ν: 'N', α: 'a', Α: 'A', ε: 'e', Ε: 'E', ι: 'i', Ι: 'I', κ: 'k', Κ: 'K', μ: 'm', Μ: 'M',
  }),
);

/** Đổi ký tự giống hình về Latin (giữ nguyên mọi ký tự khác, không đụng chữ Hán/kana/Hangul). */
export function foldHomoglyphs(text) {
  let out = '';
  for (const ch of String(text ?? '')) out += HOMOGLYPH_MAP.get(ch) ?? ch;
  return out;
}

/**
 * Biến thể CHÍNH TẢ thường gặp của từ khoá khẳng định (vòng 6).
 * KHÔNG dùng `\b` quanh từ tiếng Việt (`\b` của JS chỉ hiểu ASCII — bài học đã trả giá ở MVP-01);
 * dùng lookaround với `\p{L}` (Unicode) nên mới đúng.
 */
const SPELLING_VARIANTS = [
  [/(?<![\p{L}])nhứt(?![\p{L}])/giu, 'nhất'], // "tốt nhứt" = "tốt nhất"
  [/(?<![\p{L}])hảng(?![\p{L}])/giu, 'hãng'], // "chính hảng" = "chính hãng"
];

/**
 * Chuẩn hoá văn bản để so khớp: ký tự vô hình → khoảng trắng, gộp khoảng trắng, NFKC,
 * gộp homoglyph Kirin/Greek về Latin, và chuẩn hoá vài biến thể chính tả.
 * Thay ký tự vô hình bằng khoảng trắng (không xoá hẳn) để từ khoá bị cắt vẫn khớp lại được.
 */
export function normalizeForMatch(text) {
  let s = String(text ?? '')
    .replace(INVISIBLE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFKC');
  s = foldHomoglyphs(s);
  for (const [re, to] of SPELLING_VARIANTS) s = s.replace(re, to);
  return s;
}

/* ─────────────────────── 1. Phát hiện ký tự CHƯA DỊCH ─────────────────────── */

const CJK_CLASS = '\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF';

/**
 * Hệ chữ KHÁC không được phép còn lại trong bản dịch tiếng Việt (F-08):
 * kana Nhật (`\p{Script=Hiragana}`, `\p{Script=Katakana}`) và Hangul (`\p{Script=Hangul}`).
 */
const OTHER_SCRIPT_CLASS = '\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';

/** Lớp ký tự "chưa dịch": CJK + kana + Hangul. */
const UNTRANSLATED_CLASS = `${CJK_CLASS}${OTHER_SCRIPT_CLASS}`;

/** `text` còn chữ Hán ⇒ CHƯA DỊCH (giữ tên cũ cho tương thích). */
export function hasCjk(text) {
  return new RegExp(`[${CJK_CLASS}]`).test(normalizeForMatch(text));
}

/** `text` còn bất kỳ hệ chữ chưa dịch nào (Hán, kana, Hangul). */
export function hasUntranslatedScript(text) {
  return new RegExp(`[${UNTRANSLATED_CLASS}]`, 'u').test(normalizeForMatch(text));
}

/** Trích vài đoạn chữ Hán còn sót để hiện lên UI (tối đa `maxRuns` đoạn). */
export function cjkSample(text, maxRuns = 3) {
  const runs = normalizeForMatch(text).match(new RegExp(`[${CJK_CLASS}]+`, 'g')) || [];
  return runs.slice(0, maxRuns).join(' ');
}

/** Trích vài đoạn chữ CHƯA DỊCH (Hán/kana/Hangul) để hiện lên UI. */
export function untranslatedSample(text, maxRuns = 3) {
  const runs = normalizeForMatch(text).match(new RegExp(`[${UNTRANSLATED_CLASS}]+`, 'gu')) || [];
  return runs.slice(0, maxRuns).join(' ');
}

/** Danh sách ký tự CJK duy nhất (để ghi log / đối chiếu). */
export function cjkChars(text) {
  const found = normalizeForMatch(text).match(new RegExp(`[${CJK_CLASS}]`, 'g')) || [];
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

/**
 * Đổi MỌI chữ số thuộc hệ thập phân Unicode (`\p{Nd}`) về ASCII: chữ số full-width
 * `１２３` → `123`, chữ số Ả Rập - Ấn `١٢` → `12`… Nhờ vậy "１２ tháng" không lọt
 * qua luật (a) chỉ vì dùng bộ chữ số khác (F-08).
 */
export function toAsciiDigits(text) {
  return String(text ?? '').replace(/\p{Nd}/gu, (ch) => {
    const value = digitValueOf(ch);
    return value === null ? '' : String(value);
  });
}

/**
 * Điểm bắt đầu (ký tự "0") của 72 khối chữ số thập phân Unicode (`\p{Nd}`), Unicode 15.
 * Mọi khối đều dài bội số của 10, nên `(mã điểm - điểm bắt đầu) % 10` là giá trị chữ số.
 * (Không dùng `Number('１')` — V8 trả `NaN`; NFKC cũng chỉ phủ được một phần bộ chữ số.)
 */
const ND_BLOCK_STARTS = Object.freeze([
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66,
  0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90,
  0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0,
  0xff10, 0x104a0, 0x10d30, 0x10d40, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450,
  0x114d0, 0x11650, 0x116c0, 0x116d0, 0x11730, 0x118e0, 0x11950, 0x11bf0, 0x11c50, 0x11d50,
  0x11da0, 0x11de0, 0x11f50, 0x16130, 0x16a60, 0x16ac0, 0x16b50, 0x16d70, 0x1ccf0, 0x1d7ce,
  0x1e140, 0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950, 0x1fbf0,
]);

/** Giá trị 0..9 của một ký tự chữ số Unicode; `null` nếu không phải `\p{Nd}`. */
export function digitValueOf(ch) {
  const s = String(ch ?? '');
  if (!s || !/^\p{Nd}$/u.test(s)) return null;
  const cp = s.codePointAt(0);
  let start = ND_BLOCK_STARTS[0];
  for (const candidate of ND_BLOCK_STARTS) {
    if (candidate <= cp) start = candidate;
    else break;
  }
  return (cp - start) % 10;
}

/** Chuẩn hoá một token số để so khớp: "3,5" → "3.5"; "1.000" → "1000". */
export function normalizeNumberToken(token) {
  const t = String(token ?? '').trim();
  if (!t) return '';
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(t)) return t.replace(/[.,]/g, '');
  return t.replace(',', '.');
}

/** Tập hợp số có trong văn bản (đã đổi chữ số Hán + mọi bộ chữ số Unicode về ASCII). */
export function numbersIn(text) {
  const converted = toAsciiDigits(convertChineseNumerals(normalizeForMatch(text)));
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
  for (const m of toAsciiDigits(normalizeForMatch(text)).matchAll(/\d+(?:[.,]\d+)?/g)) {
    const n = normalizeNumberToken(m[0]);
    if (n) set.add(n);
  }
  return set;
}

/* ─── Số viết bằng CHỮ tiếng Việt (một…mười, mười hai, hai mươi, trăm, nghìn…) ───
 *
 * F-08: "Áo thun cotton mười hai tháng hậu mãi" từng lọt vì không có chữ số nào.
 * Luật bổ sung: cụm số-viết-bằng-chữ ĐI KÈM một đơn vị/thời gian trong danh sách
 * dưới đây ⇒ coi là số liệu; nếu giá trị đó không có trong chữ gốc ⇒ vi phạm (a).
 */

const VI_NUMBER_WORDS = Object.freeze({
  không: 0,
  linh: 0,
  lẻ: 0,
  một: 1,
  mốt: 1,
  hai: 2,
  ba: 3,
  bốn: 4,
  tư: 4,
  năm: 5,
  lăm: 5,
  sáu: 6,
  bảy: 7,
  tám: 8,
  chín: 9,
});

const VI_MULTIPLIERS = Object.freeze({
  chục: 10,
  mươi: 10,
  mười: 10,
  trăm: 100,
  nghìn: 1000,
  nghàn: 1000,
  ngàn: 1000,
  triệu: 1000000,
  tỷ: 1000000000,
  tỉ: 1000000000,
});

/** Cụm từ chỉ số bằng chữ; dài trước để regex không cắt sai. */
const VI_NUM_WORD_ALT =
  'không|linh|lẻ|một|mốt|hai|ba|bốn|tư|năm|lăm|sáu|bảy|tám|chín|chục|mươi|mười|trăm|nghìn|nghàn|ngàn|triệu|tỷ|tỉ';

/** Bảng tra KHÔNG DẤU của hai bảng trên (N-6): "mot nam" ≈ "một năm". */
const VI_NUMBER_WORDS_PLAIN = Object.freeze(
  Object.fromEntries(Object.entries(VI_NUMBER_WORDS).map(([k, v]) => [deaccent(k), v])),
);
const VI_MULTIPLIERS_PLAIN = Object.freeze(
  Object.fromEntries(Object.entries(VI_MULTIPLIERS).map(([k, v]) => [deaccent(k), v])),
);

const VI_NUM_WORD_RUN = `(?:${VI_NUM_WORD_ALT})(?:\\s+(?:${VI_NUM_WORD_ALT})){0,4}`;

/**
 * Đơn vị / mốc thời gian phải đi kèm thì cụm số-bằng-chữ mới bị coi là "số liệu".
 *
 * Vòng 3 (F-08a): bổ sung ĐƠN VỊ TIỀN TỆ Việt — "một trăm hai mươi nghìn đồng" từng lọt
 * vì `đồng`/`vnđ`/`đ` không có trong danh sách, còn `nghìn`/`triệu`/`tỷ` chỉ được coi là
 * hư từ ghép số nên cụm "…nghìn" trơ trọi không kích hoạt luật nào.
 */
const COUNTED_UNITS = Object.freeze([
  'tháng', 'năm', 'ngày', 'giờ', 'phút', 'lần', '%', 'kg', 'g', 'ml', 'l', 'cm', 'mm', 'm',
  'W', 'V', 'mAh',
  // Tiền tệ / mốc giá (F-08a)
  'đồng', 'vnđ', 'vnd', 'đ', 'nghìn', 'nghàn', 'ngàn', 'triệu', 'tỷ', 'tỉ',
  // N-7b (vòng 4): ĐÃ BỎ các DANH TỪ ĐẾM (chiếc, cái, bộ, hộp, gói) — "Một chiếc áo thun
  // cotton" là MẠO TỪ bất định, không phải số liệu; bắt nó là dương tính giả làm hỏng
  // trải nghiệm thật. Chỉ giữ đơn vị ĐO LƯỜNG / THỜI GIAN / TIỀN TỆ.
]);

const COUNTED_UNIT_ALT = COUNTED_UNITS
  .slice()
  .sort((a, b) => b.length - a.length)
  .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

const VI_WORD_NUMBER_UNIT_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(${VI_NUM_WORD_RUN})\\s*(${COUNTED_UNIT_ALT})(?![\\p{L}\\p{N}])`,
  'giu',
);

/* Bản KHÔNG DẤU của cùng bộ luật (N-6, vòng 4): câu bịa viết không dấu
 * ("Ao thun cotton bao hanh mot nam") phải bị bắt như bản có dấu. */
const VI_NUM_WORD_ALT_PLAIN = VI_NUM_WORD_ALT.split('|').map(deaccent).join('|');
const VI_NUM_WORD_RUN_PLAIN = `(?:${VI_NUM_WORD_ALT_PLAIN})(?:\\s+(?:${VI_NUM_WORD_ALT_PLAIN})){0,4}`;
const COUNTED_UNIT_ALT_PLAIN = COUNTED_UNITS
  .map(deaccent)
  .sort((a, b) => b.length - a.length)
  .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const VI_WORD_NUMBER_UNIT_RE_PLAIN = new RegExp(
  `(?<![\\p{L}\\p{N}])(${VI_NUM_WORD_RUN_PLAIN})\\s*(${COUNTED_UNIT_ALT_PLAIN})(?![\\p{L}\\p{N}])`,
  'giu',
);

/** Đổi cụm số-bằng-chữ tiếng Việt thành số: "mười hai" → 12, "hai mươi" → 20. */
export function vietnameseWordsToNumber(run) {
  const words = String(run ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  let total = 0;
  let section = 0;
  let digit = 0;
  let seen = false;
  for (const word of words) {
    // N-6 (vòng 4): tra được cả bản CÓ DẤU lẫn bản KHÔNG DẤU ("một" / "mot").
    const digitValue = VI_NUMBER_WORDS[word] ?? VI_NUMBER_WORDS_PLAIN[word];
    const multiplier = VI_MULTIPLIERS[word] ?? VI_MULTIPLIERS_PLAIN[word];
    if (digitValue !== undefined) {
      digit = digitValue;
      seen = true;
    } else if (multiplier !== undefined) {
      seen = true;
      if (multiplier >= 1000) {
        section = (section + digit) * multiplier;
        total += section;
        section = 0;
      } else {
        section += (digit || 1) * multiplier;
      }
      digit = 0;
    }
  }
  if (!seen) return null;
  return total + section + digit;
}

/**
 * Tìm các cụm "số viết bằng chữ + đơn vị" trong bản dịch.
 * @returns {{phrase: string, unit: string, value: number|null}[]}
 */
export function wordNumberUnitsIn(text) {
  const s = normalizeForMatch(text);
  const out = [];
  const seen = new Set();
  const push = (rawPhrase, rawRun, rawUnit) => {
    const phrase = String(rawPhrase).replace(/\s+/g, ' ').trim();
    const key = deaccent(phrase).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ phrase, unit: String(rawUnit), value: vietnameseWordsToNumber(rawRun) });
  };
  for (const m of s.matchAll(VI_WORD_NUMBER_UNIT_RE)) push(`${m[1]} ${m[2]}`, m[1], m[2]);
  // N-6 + N-10: bản KHÔNG DẤU ("mot nam", "hai thang"…) — chỉ khi câu KHÔNG có dấu nào,
  // để "Chỉnh hàng"/"một chiếc" kiểu có dấu không rơi vào nhánh này.
  if (!hasDiacritics(s)) {
    const plain = deaccent(s);
    for (const m of plain.matchAll(VI_WORD_NUMBER_UNIT_RE_PLAIN)) push(`${m[1]} ${m[2]}`, m[1], m[2]);
  }
  return out;
}

/* ─── Ký hiệu số KHÔNG thuộc \p{Nd} (F-08b — vòng 3) ───
 *
 * `\p{Nd}` chỉ phủ chữ số thập phân. Còn hai nhóm "số" khác lọt qua:
 *   - `\p{No}` (Number, other): số khoanh tròn ①②, phân số ½, chỉ số trên ², số Ả Rập - Ấn
 *     dạng ký hiệu (৴)… NFKC chỉ gỡ được MỘT PHẦN (① → "1", nhưng 773/915 ký tự No KHÔNG
 *     cho ra chữ số ASCII nào).
 *   - `\p{Nl}` (Number, letter): số La Mã Ⅰ Ⅱ Ⅻ — NFKC biến thành CHỮ ("XII") nên luật
 *     chữ số không bắt được.
 *
 * Luật: ký hiệu số có trong `text_vi` mà chữ gốc KHÔNG có ⇒ vi phạm "số liệu không có
 * trong chữ gốc". Ký hiệu nào NFKC đã quy về chữ số ASCII thì luật chữ số lo (không báo
 * trùng hai lần).
 */
const SPECIAL_NUMERAL_RE = /[\p{No}\p{Nl}]/gu;

/**
 * Ký hiệu "số" không thuộc `\p{No}`/`\p{Nl}` nhưng vẫn là số liệu khi xuất hiện:
 * `№` (numero sign) — N-6 (vòng 4). NFKC biến nó thành chữ "No" nên luật chữ số không thấy.
 */
const NUMERO_SIGN = '№';

/**
 * @param {string} textOriginal chữ gốc (nguyên văn, chưa NFKC)
 * @param {string} textVi chữ Việt (nguyên văn, chưa NFKC)
 * @returns {string[]} câu tiếng Việt
 */
export function checkSpecialNumerals(textOriginal, textVi) {
  const original = stripInvisible(textOriginal);
  const vi = stripInvisible(textVi);
  const out = [];
  if (vi.includes(NUMERO_SIGN) && !original.includes(NUMERO_SIGN)) {
    out.push(`Số liệu “${NUMERO_SIGN}” (ký hiệu số) không có trong chữ gốc — không được tự thêm số.`);
  }
  for (const ch of [...new Set(vi.match(SPECIAL_NUMERAL_RE) || [])]) {
    if (original.includes(ch)) continue; // chữ gốc có đúng ký hiệu đó ⇒ trung thực
    if (/[0-9]/.test(ch.normalize('NFKC'))) continue; // đã quy về chữ số ASCII ⇒ luật (a) lo
    const label = /\p{Nl}/u.test(ch) ? 'số La Mã' : 'ký hiệu số đặc biệt';
    out.push(`Số liệu “${ch}” (${label}) không có trong chữ gốc — không được tự thêm số.`);
  }
  return out;
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
  // N-9 (vòng 5): bổ sung đơn vị khối lượng/diện tích/điện mà bản dịch hay dùng
  [/吨/, 'tấn'],
  [/两/, 'lạng'],
  [/平方米/, 'm²'],
  [/立方米/, 'm³'],
  [/安培/, 'a'],
  [/赫兹/, 'hz'],
  [/摄氏度/, '°c'],
  [/克/, 'g'],
]);

/**
 * Mẫu "số + đơn vị" phía tiếng Việt.
 * Lookahead `(?![\p{L}\p{N}])` (Unicode) để "12 lần" KHÔNG bị hiểu thành "12 l".
 *
 * N-7a (vòng 4): bản cũ dùng `(?![a-zà-ỹ0-9])` — với cờ `/i`, lớp này khớp cả CHỮ HOA,
 * nên `纯棉100%T恤` (chữ Trung viết liền số) bị coi là KHÔNG có đơn vị `%` ⇒ bản dịch
 * trung thành "Áo thun cotton 100%" bị tố oan. Ký hiệu `%` không phải chữ cái nên còn
 * được kiểm thêm bằng `SYMBOL_UNITS` bên dưới (không phụ thuộc biên từ).
 */
const VI_UNIT_TOKENS = Object.freeze([
  // Khối lượng / thể tích (N-9 vòng 5: bổ sung gram, kilogam, tấn, tạ, yến, lạng, lít…)
  'kilogam', 'kilôgam', 'gram', 'gam', 'kg', 'mg', 'g', 'tấn', 'tạ', 'yến', 'lạng',
  'ml', 'lít', 'l',
  // Độ dài / diện tích / thể tích hình học
  'cm', 'mm', 'km', 'm²', 'm³', 'm', 'inch',
  // Điện / năng lượng / tần số / nhiệt độ
  'mAh', 'kWh', 'kW', 'Hz', 'W', 'V', 'A', '°C',
  // Thời gian
  'giờ', 'ngày', 'tuần', 'tháng', 'năm', 'phút', 'giây',
  // Khác
  'độ', 'đ', 'vnđ',
]);

/** Đơn vị Latin/đo lường: dài trước để 'm²' không bị cắt thành 'm'. */
const VI_UNIT_ALT = VI_UNIT_TOKENS
  .slice()
  .sort((a, b) => b.length - a.length)
  .map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/**
 * Mẫu "số + đơn vị" phía tiếng Việt.
 * Lookahead `(?![\p{L}\p{N}])` (Unicode) để "12 lần" KHÔNG bị hiểu thành "12 l".
 *
 * N-7a (vòng 4): bản cũ dùng `(?![a-zà-ỹ0-9])` — với cờ `/i`, lớp này khớp cả CHỮ HOA,
 * nên `纯棉100%T恤` (chữ Trung viết liền số) bị coi là KHÔNG có đơn vị `%` ⇒ bản dịch
 * trung thành "Áo thun cotton 100%" bị tố oan. Ký hiệu `%` không phải chữ cái nên còn
 * được kiểm thêm bằng `SYMBOL_UNITS` bên dưới (không phụ thuộc biên từ).
 */
const VI_NUM_UNIT_SOURCE = `(\\d+(?:[.,]\\d+)?)\\s*(${VI_UNIT_ALT})(?![\\p{L}\\p{N}])`;

/** Ký hiệu đơn vị KHÔNG phải chữ cái ⇒ không cần biên từ, chỉ cần đứng sau một con số. */
const SYMBOL_UNITS = Object.freeze([['%', '%']]);

/** Token → đơn vị chuẩn (so khớp giữa hai ngôn ngữ). */
const UNIT_CANON = Object.freeze({
  kilogam: 'kg',
  kilôgam: 'kg',
  kg: 'kg',
  gram: 'g',
  gam: 'g',
  g: 'g',
  mg: 'mg',
  tấn: 'tấn',
  tạ: 'tạ',
  yến: 'yến',
  lạng: 'lạng',
  ml: 'ml',
  lít: 'l',
  l: 'l',
  cm: 'cm',
  mm: 'mm',
  km: 'km',
  'm²': 'm²',
  'm³': 'm³',
  m: 'm',
  inch: 'inch',
  mah: 'mah',
  kwh: 'kwh',
  kw: 'kw',
  hz: 'hz',
  w: 'w',
  v: 'v',
  a: 'a',
  '°c': '°c',
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
  const s = normalizeForMatch(text);
  const set = new Set();
  // Cờ `u` là BẮT BUỘC: thiếu nó thì `\p{L}` trong lookahead bị hiểu thành lớp ký tự
  // thường ⇒ "12 lần" lại bị nhận nhầm thành "12 l".
  for (const m of s.matchAll(new RegExp(VI_NUM_UNIT_SOURCE, 'giu'))) {
    const u = canonicalUnit(m[2]);
    if (u) set.add(u);
  }
  for (const [symbol, canon] of SYMBOL_UNITS) {
    if (new RegExp(`\\d\\s*${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(s)) set.add(canon);
  }
  for (const [re, canon] of CN_UNIT_ALIASES) {
    if (re.test(s)) set.add(canon);
  }
  return set;
}

/**
 * Ký hiệu đơn vị có XUẤT HIỆN NGUYÊN VĂN trong chữ gốc hay không (N-7a, vòng 4).
 *
 * Đây là "lần kiểm thứ hai" độc lập với việc trích số: chữ Trung hay viết liền
 * (`纯棉100%`, `含棉95%`) nên chỉ dựa vào danh sách số trích ra là chưa đủ.
 */
const UNIT_LITERALS = Object.freeze({
  '%': ['%', '％', '百分比', '含量'],
  'độ': ['°', 'độ', '度'],
  'đ': ['đ', 'đồng'],
  'vnđ': ['vnđ', 'VND', 'đồng', '元', '￥', '¥'],
});

/** @returns {boolean} */
export function unitAppearsInText(text, unit) {
  const literals = UNIT_LITERALS[unit];
  if (!literals) return false;
  const s = normalizeForMatch(text);
  return literals.some((lit) => s.includes(lit));
}

/**
 * Luật (a): số liệu / đơn vị trong `text_vi` mà `text_original` không có.
 *
 * F-08: ngoài chữ số (mọi bộ chữ số Unicode), còn bắt SỐ VIẾT BẰNG CHỮ tiếng Việt
 * khi nó đi kèm đơn vị/thời gian ("mười hai tháng", "hai mươi lần"…) — nếu giá trị
 * đó không có trong chữ gốc thì vẫn là bịa số liệu.
 *
 * @returns {string[]} câu tiếng Việt
 */
export function checkNumericClaims(textOriginal, textVi) {
  const out = [];
  const original = normalizeForMatch(textOriginal);
  const vi = normalizeForMatch(textVi);
  const originalNumbers = numbersIn(original);
  const viNumbers = asciiNumbersIn(vi);

  const missing = [...viNumbers].filter((n) => !originalNumbers.has(n));
  if (missing.length > 0) {
    const shown = missing.slice(0, 3).map((n) => `“${n}”`).join(', ');
    out.push(`Số liệu ${shown} không có trong chữ gốc — không được tự thêm số.`);
    if (missing.length > 3) {
      out.push(`Còn ${missing.length - 3} số liệu khác không có trong chữ gốc — cần người duyệt.`);
    }
  }

  // Số viết bằng chữ tiếng Việt + đơn vị (F-08).
  for (const hit of wordNumberUnitsIn(vi)) {
    const value = hit.value;
    if (value === null || !Number.isFinite(value)) continue;
    if (originalNumbers.has(String(value))) continue; // chữ gốc có đúng số đó
    const label = `“${hit.phrase}”${String(value) !== hit.phrase ? ` (= ${value})` : ''}`;
    const violation = `Số liệu ${label} không có trong chữ gốc — không được tự thêm số.`;
    if (!out.includes(violation)) out.push(violation);
  }

  const originalUnits = unitsIn(original);
  const missingUnits = [...unitsIn(vi)].filter((u) => !originalUnits.has(u));
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
  // F-08: bỏ ký tự vô hình trước khi so khớp ("bảo\u200bhành" vẫn là "bảo hành").
  const original = normalizeForMatch(textOriginal);
  const viText = normalizeForMatch(textVi);
  // N-6 (vòng 4) + N-10 (vòng 5): soi thêm bản KHÔNG DẤU — nhưng CHỈ khi câu ứng viên
  // không có dấu tiếng Việt nào (nếu không sẽ tố oan "Chỉnh hàng"/"Đất chuẩn bị trồng").
  const usePlainMatch = !hasDiacritics(viText);
  const originalPlain = deaccent(original);
  const viPlain = usePlainMatch ? deaccent(viText) : viText;
  for (const group of CLAIM_GROUPS) {
    const flags = group.vi.flags.includes('g') ? group.vi.flags : `${group.vi.flags}g`;
    // Gộp hai dạng về MỘT mục cho mỗi khẳng định (ưu tiên hiển thị bản CÓ DẤU) để không
    // báo trùng hai lần cùng một lỗi ("bảo hành" + "bao hanh").
    const hits = new Map();
    for (const m of viText.matchAll(new RegExp(group.vi.source, flags))) hits.set(deaccent(m[0]).toLowerCase(), m[0]);
    if (usePlainMatch) {
      for (const m of viPlain.matchAll(new RegExp(deaccent(group.vi.source), flags))) {
        const key = deaccent(m[0]).toLowerCase();
        if (!hits.has(key)) hits.set(key, m[0]);
      }
    }
    if (hits.size === 0) continue;
    // Chữ gốc đã có khẳng định tương đương (tiếng Trung) ⇒ bản dịch trung thực, không bịa.
    if (new RegExp(group.zh.source, group.zh.flags.replace('g', '')).test(original)) continue;
    for (const hit of hits.values()) {
      if (original.toLowerCase().includes(hit.toLowerCase())) continue;
      if (originalPlain.toLowerCase().includes(deaccent(hit).toLowerCase())) continue;
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
  if (line?.status === TRANSLATE_STATUS.SKIPPED_BY_USER) return false;
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
  // F-08: mọi phép so khớp chạy trên văn bản đã bỏ ký tự vô hình + NFKC (vòng 3); văn bản
  // trong `line` KHÔNG bị sửa (giữ nguyên thứ người dùng gõ).
  const rawOriginal = String(base.text_original ?? region?.text ?? '');
  const rawVi = String(base.text_vi ?? '');
  const textOriginal = normalizeForMatch(rawOriginal);
  const textVi = normalizeForMatch(rawVi);
  const translatable = resolveTranslatable(base, region);

  const violations = [...(Array.isArray(base.violations) ? base.violations : [])];

  // (a) số liệu / đơn vị không có trong chữ gốc
  violations.push(...checkNumericClaims(textOriginal, textVi));
  // (a2) ký hiệu số ngoài `\p{Nd}` (khoanh tròn ①, số La Mã Ⅻ…) — phải soi trên văn bản
  // GỐC vì NFKC đã biến đổi chúng trước khi tới `checkNumericClaims` (F-08b).
  violations.push(...checkSpecialNumerals(rawOriginal, rawVi));

  // (b) còn ký tự CHƯA DỊCH (Hán, kana, Hangul) → CHƯA DỊCH
  if (hasUntranslatedScript(textVi)) {
    violations.push(
      `CHƯA DỊCH: bản dịch còn ký tự chưa dịch (${untranslatedSample(textVi)}) — phải dịch hết hoặc để người duyệt.`,
    );
  }

  // (c) khẳng định không có trong chữ gốc
  violations.push(...checkClaimWords(textOriginal, textVi));

  // (d) rỗng nhưng phải dịch. Bỏ qua dòng FAILED (lỗi provider đã có mã riêng) và
  // dòng SKIPPED_BY_USER (người dùng CHỦ ĐỘNG bỏ qua — không phải vi phạm).
  if (
    translatable &&
    textVi.trim() === '' &&
    base.status !== TRANSLATE_STATUS.FAILED &&
    base.status !== TRANSLATE_STATUS.SKIPPED_BY_USER
  ) {
    violations.push('Bản dịch rỗng nhưng vùng này phải dịch (translatable = true) — cần người duyệt.');
  }

  const unique = [...new Set(violations)];
  let status = base.status;
  if (status === undefined || status === null) {
    status = textVi.trim() === '' ? TRANSLATE_STATUS.NEEDS_REVIEW : TRANSLATE_STATUS.TRANSLATED;
  }
  // Có vi phạm ⇒ NEEDS_REVIEW. Ngoại lệ: dòng FAILED (lỗi provider) và SKIPPED_BY_USER
  // (quyết định của người dùng) giữ nguyên trạng thái của chúng.
  if (
    unique.length > 0 &&
    status !== TRANSLATE_STATUS.FAILED &&
    status !== TRANSLATE_STATUS.SKIPPED_BY_USER
  ) {
    status = TRANSLATE_STATUS.NEEDS_REVIEW;
  }

  const next = { ...base, status, violations: unique };
  return { line: next, violations: unique };
}

export default enforceTranslationGuardrails;
