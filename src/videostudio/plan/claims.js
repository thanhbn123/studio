/**
 * CHỐNG BỊA cho chữ trên video (mục 0 luật 3 của MVP-04; dùng lại guardrail của MVP-03).
 *
 * Vì sao file này tồn tại: V1 chỉ *chuẩn bị* — V3 (pipeline) và V4 (API) phải có một hàm THUẦN
 * để hỏi "câu chữ này có được phép vẽ lên video không?" trước khi tốn công dựng khung.
 * Câu trả lời: chỉ những khẳng định/số liệu **có trong bằng chứng ĐÃ LƯU của job**.
 *
 * ⚠️ BẰNG CHỨNG CHỈ ĐẾN TỪ THAM SỐ `evidence` DO SERVER TRUYỀN (dữ liệu đã lưu: `product_name`,
 * vùng chữ OCR / người dùng nhập, ghi chú). Hàm này **KHÔNG** đọc bằng chứng từ đối tượng chữ
 * của request (bài học M03-02 của MVP-03: client vừa phát ngôn vừa tự cấp bằng chứng thì
 * guardrail chỉ còn là thủ tục hình thức). V4 phải gom bằng chứng từ store rồi mới gọi hàm này.
 *
 * Hai dạng gọi đều được nhận (để V3 và V4 không phải đoán chữ ký):
 *   `collectClaimViolations(text, { evidence })`  — chữ ký hợp đồng;
 *   `collectClaimViolations({ evidence, texts, job })` — bundle do SERVER dựng (V4 thử trước).
 *
 * Dùng lại ĐÚNG các hàm của `src/imagelab/translate/guardrails.js` (không viết lại luật):
 * `checkClaimWords`, `checkNumericClaims`, `hasUntranslatedScript`.
 *
 * File thuần: không I/O, không mạng, không đọc file.
 */

import {
  checkClaimWords,
  checkNumericClaims,
  hasUntranslatedScript,
} from '../../imagelab/translate/guardrails.js';
import { VIDEO_CODES } from './errors.js';

/** Loại vi phạm — đóng băng để V3/V4/test không đoán sai chuỗi. */
export const CLAIM_VIOLATION_RULES = Object.freeze({
  /** Chữ còn Hán/kana/Hangul chưa dịch — bằng chứng KHÔNG cứu được. */
  UNTRANSLATED: 'untranslated',
  /** Khẳng định thuộc nhóm cấm (bảo hành, chứng nhận, số 1…) không có trong bằng chứng. */
  CLAIM_WORDS: 'claim_words',
  /** Số liệu/đơn vị không có trong bằng chứng. */
  NUMERIC_CLAIMS: 'numeric_claims',
});

/**
 * Khoá bằng chứng hợp lệ trong GÓI DO SERVER GOM (dữ liệu đã lưu của job).
 * Danh sách này KHÔNG phải "khoá client được phép gửi" — nó là hình dạng bundle mà tầng
 * pipeline dựng ra từ store rồi truyền xuống.
 */
export const EVIDENCE_TEXT_KEYS = Object.freeze([
  'product_name',
  'productName',
  'product',
  'name',
  'title',
  'text',
  'content',
  'source_text',
  'sourceText',
  'job_text',
  'jobText',
  'ocr_text',
  'ocrText',
  'ocr',
  'lines',
  'regions',
  'region_texts',
  'notes',
  'note',
  'user_note',
  'userNote',
  'caption',
  'tiktok_caption',
  'selling_points',
  'price',
  'price_text',
  'evidence',
  'evidence_used',
]);

/**
 * Khoá bằng chứng mà CLIENT từng gửi kèm trong đối tượng chữ — chỉ để NÓI RA là đã bỏ qua,
 * KHÔNG bao giờ dùng làm bằng chứng (xem đầu file).
 */
export const CLIENT_EVIDENCE_KEYS = Object.freeze([
  'source_text',
  'sourceText',
  'source',
  'text_source',
  'text_original',
  'job_text',
  'evidence',
  'evidence_text',
  'evidence_texts',
  'original_text',
  'ocr_text',
  'product_name',
  'user_note',
  'note',
  'notes',
]);

const MAX_EVIDENCE_DEPTH = 3;

/**
 * Liệt kê khoá bằng chứng client gửi kèm trong một đối tượng (chữ) — để cảnh báo, KHÔNG để dùng.
 * @returns {string[]}
 */
export function clientEvidenceKeysIn(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const out = [];
  for (const key of CLIENT_EVIDENCE_KEYS) {
    const item = value[key];
    if (typeof item === 'string' && item.trim()) out.push(key);
    else if (Array.isArray(item) && item.some((line) => typeof line === 'string' && line.trim())) out.push(key);
    else if (item && typeof item === 'object' && Object.keys(item).length > 0) out.push(key);
  }
  return out;
}

/** Gom text bằng chứng từ một giá trị bất kỳ (chuỗi / mảng / object có khoá bằng chứng). */
function evidenceFrom(candidate, depth) {
  if (depth > MAX_EVIDENCE_DEPTH) return '';
  if (typeof candidate === 'string') return candidate;
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  if (Array.isArray(candidate)) {
    return candidate
      .map((item) => evidenceFrom(item, depth + 1))
      .filter((part) => part !== '')
      .join('\n');
  }
  if (candidate && typeof candidate === 'object') {
    const parts = [];
    for (const key of EVIDENCE_TEXT_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
      const part = evidenceFrom(candidate[key], depth + 1);
      if (part !== '') parts.push(part);
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * "Text gốc của job" dùng làm bằng chứng — CHỈ nhận từ bundle do server truyền.
 * Không gom được gì ⇒ `''` = KHÔNG có bằng chứng ⇒ mọi khẳng định/số liệu đều bị chặn.
 *
 * @param {string|string[]|object} [evidence]
 * @returns {string}
 */
export function resolveEvidenceText(evidence) {
  return evidenceFrom(evidence, 0);
}

/** Đọc câu chữ từ một mục bất kỳ (chuỗi / số / `{ text }`). */
function textOfValue(raw) {
  if (raw === undefined || raw === null) return '';
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = raw.text ?? raw.content ?? raw.label ?? raw.value;
    return value === undefined || value === null ? '' : String(value);
  }
  return String(raw);
}

/**
 * Một mục vi phạm.
 *
 * `toString()` (KHÔNG đếm được khi duyệt khoá) trả về đúng câu tiếng Việt, để tầng gọi chỉ cần
 * `String(violation)` / `violations.map(String)` vẫn ra thông báo đọc được (V4 đang làm vậy),
 * còn tầng cần dữ liệu có cấu trúc thì đọc `code`/`rule`/`detail`/`text` (V3 đang làm vậy).
 */
function makeViolation(code, rule, message, text) {
  const item = { code, rule, message, detail: message, text };
  // Hai tiện ích KIỂU CHUỖI (không đếm được khi duyệt khoá) để tầng gọi đang xem vi phạm như
  // chuỗi vẫn đọc được: `String(v)`, `v.includes('bảo hành')`.
  Object.defineProperty(item, 'toString', { value: () => message, enumerable: false });
  Object.defineProperty(item, 'includes', {
    value: (needle) => message.toLowerCase().includes(String(needle).toLowerCase()),
    enumerable: false,
  });
  return item;
}

/**
 * Thu thập vi phạm chống bịa của một hoặc nhiều câu chữ sẽ vẽ lên video.
 *
 * Nhận HAI dạng gọi (để V3 gọi `(text, {evidence})` và V4 gọi `({evidence, texts, job})` đều đúng):
 *  1. `collectClaimViolations(text, { evidence })` — chữ ký hợp đồng (một câu, mảng câu, hoặc mục `{text}`);
 *  2. `collectClaimViolations({ evidence, texts, job })` — bundle do SERVER dựng (V4 thử dạng này trước).
 * Với dạng (1), MỌI khoá bằng chứng nằm trong chính mục chữ đều bị BỎ QUA (chống "bằng chứng vòng",
 * bài học M03-02); bằng chứng chỉ lấy từ tham số thứ hai do server truyền.
 *
 * @param {string|string[]|{text?:string,content?:string}|{evidence?:any,texts:Array}} text
 * @param {{evidence?: string|string[]|object}} [params] `evidence` do SERVER truyền (dữ liệu đã lưu)
 * @returns {Array<{code:string, rule:string, message:string, detail:string, text:string}>} rỗng = được phép vẽ
 */
export function collectClaimViolations(text, { evidence } = {}) {
  const holder = text && typeof text === 'object' && !Array.isArray(text) ? text : null;
  // Dạng bundle của V4: `{ evidence, texts, job }`. Bằng chứng trong bundle là do SERVER dựng
  // (`collectVideostudioEvidence(job)`) — KHÔNG phải khoá client nhét vào một mục chữ.
  const bundle = holder && Array.isArray(holder.texts) ? holder : null;
  let evidenceValue = evidence;
  let values;
  if (bundle) {
    values = bundle.texts;
    if (evidenceValue === undefined && Object.prototype.hasOwnProperty.call(bundle, 'evidence')) {
      evidenceValue = bundle.evidence;
    }
  } else if (holder) {
    values = [holder.text ?? holder.content ?? ''];
  } else {
    values = Array.isArray(text) ? text : [text];
  }

  const source = resolveEvidenceText(evidenceValue);
  const out = [];
  const seen = new Set();
  const push = (item) => {
    const key = `${item.code}|${item.rule}|${item.message}|${item.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  for (const raw of values) {
    const value = textOfValue(raw);
    if (value.trim() === '') continue;

    // (1) Chữ CHƯA DỊCH bị chặn tuyệt đối, không phụ thuộc bằng chứng.
    if (hasUntranslatedScript(value)) {
      push(
        makeViolation(
          VIDEO_CODES.NOT_TRANSLATED,
          CLAIM_VIOLATION_RULES.UNTRANSLATED,
          'Chữ còn Hán/kana/Hangul chưa dịch — KHÔNG được vẽ lên video (mục 0 luật 3).',
          value,
        ),
      );
    }

    // (2) Khẳng định thuộc nhóm cấm.
    for (const message of checkClaimWords(source, value)) {
      push(makeViolation(VIDEO_CODES.VIDEO_TEXT_UNSUPPORTED_CLAIM, CLAIM_VIOLATION_RULES.CLAIM_WORDS, message, value));
    }

    // (3) Số liệu/đơn vị không có trong bằng chứng.
    for (const message of checkNumericClaims(source, value)) {
      push(makeViolation(VIDEO_CODES.VIDEO_TEXT_UNSUPPORTED_CLAIM, CLAIM_VIOLATION_RULES.NUMERIC_CLAIMS, message, value));
    }
  }
  return out;
}

/** Có vi phạm nào không (tiện cho V3/V4 rẽ nhánh nhanh). */
export function hasClaimViolations(text, params) {
  return collectClaimViolations(text, params).length > 0;
}

export default collectClaimViolations;
