/**
 * C1 — Phân loại vùng chữ OCR (MVP-02).
 *
 * Vì sao phải phân loại: luật 3 của hợp đồng MVP-02 nói nhãn hiệu và chứng nhận
 * **KHÔNG BAO GIỜ** được dịch hay xoá. Phân loại sai theo hướng "dịch được" là lỗi
 * nặng nhất của module này, nên khi không đủ căn cứ ta trả `unknown` và
 * `translatable = false` (fail-closed: không dịch thứ mình không hiểu).
 *
 * Bất biến của module: `translatable` LUÔN `=== (kind === 'descriptive')`.
 * Không có nhánh nào được phép phá bất biến này.
 *
 * Lưu ý: module này KHÔNG gọi mạng, KHÔNG đọc file — thuần hàm, dễ test.
 */

/** 5 loại vùng theo hợp đồng 3.2 (đóng băng). */
export const REGION_KINDS = Object.freeze([
  'descriptive',
  'brand',
  'certification',
  'price',
  'unknown',
]);

/**
 * Thứ tự "độ bảo vệ" của từng loại.
 *
 * Dùng khi hợp nhất kind do provider khai với kind do ta tự phân loại: chỉ được
 * LEO THANG bảo vệ (descriptive → unknown → brand/certification/price), tuyệt đối
 * không được hạ cấp. Provider nói "dịch được" nhưng chữ có dấu hiệu nhãn hiệu thì
 * ta vẫn chặn.
 */
export const PROTECTION_RANK = Object.freeze({
  descriptive: 0,
  unknown: 1,
  brand: 2,
  certification: 2,
  price: 2,
});

/** Lý do hiển thị thẳng lên UI (tiếng Việt, không chứa secret). */
export const KIND_REASONS = Object.freeze({
  // Nguyên văn ví dụ trong hợp đồng 3.2.
  descriptive: 'chữ mô tả thông thường',
  brand: 'có dấu hiệu nhãn hiệu/thương hiệu — KHÔNG dịch, KHÔNG xoá',
  certification: 'có dấu hiệu chứng nhận/tiêu chuẩn — KHÔNG dịch, KHÔNG xoá',
  price: 'có dấu hiệu giá/khuyến mãi vận chuyển — KHÔNG dịch (giá do người bán quyết)',
  unknown: 'không đủ căn cứ phân loại — không dịch để an toàn (fail-closed)',
});

/** Dấu hiệu nhãn hiệu/thương hiệu. `旗舰` bao trùm `旗舰店` (cờ hiệu). */
const BRAND_RE = /[®™]|商标|品牌|官方|旗舰/u;

/**
 * Dấu hiệu chứng nhận/tiêu chuẩn.
 *
 * `\bISO` cố ý KHÔNG có biên phải để bắt được cả `ISO9001`; `CE`/`FDA` phải là
 * từ riêng (`\bCE\b`) để không bắt nhầm chữ như "CENTER".
 */
const CERTIFICATION_RE = /\bCE\b|\bFDA\b|\bISO|\bRoHS\b|\b3C\b|认证|認証|合格证|合格證|检验|檢驗|质检|質檢|检测|檢測/i;

/** Dấu hiệu giá tiền (đã đủ nghĩa dù không kèm con số). */
const PRICE_RE = /[¥￥]|元|价格|價格|售价|售價|价钱|價錢|运费|運費/u;

/**
 * Dấu hiệu vận chuyển/khuyến mãi.
 *
 * Theo hợp đồng 4.1, `包邮` chỉ được coi là giá khi ĐI KÈM con số; `包邮` trơ trọi
 * không đủ căn cứ (không rõ là giá, là cam kết vận chuyển hay khẩu hiệu) nên rơi
 * vào `unknown` — không dịch.
 */
const SHIPPING_RE = /包邮|包郵|免邮|免郵|运费|運費/u;

/** Chữ Hán (giản thể + phồn thể + mở rộng A + tương thích). */
const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u;

/** Có ít nhất một chữ cái (bất kỳ hệ chữ nào) — dùng để phát hiện chuỗi chỉ có số/ký hiệu. */
const LETTER_RE = /\p{L}/u;

/** Text có chứa chữ Hán hay không (dùng để suy ra `lang` khi provider không khai). */
export function containsCjk(value) {
  return CJK_RE.test(String(value ?? ''));
}

/** Lý do mặc định của một kind (đã đóng băng chuỗi, tránh gõ lại sai chính tả). */
export function reasonForKind(kind) {
  return KIND_REASONS[kind] || KIND_REASONS.unknown;
}

/** Đóng băng kết quả — bất biến `translatable === (kind === 'descriptive')`. */
function verdict(kind, kindReason) {
  return Object.freeze({
    kind,
    kind_reason: kindReason,
    translatable: kind === 'descriptive',
  });
}

/**
 * Phân loại một vùng chữ.
 *
 * Thứ tự ưu tiên: brand → certification → price → (không có chữ) unknown → descriptive.
 * Ưu tiên brand trước vì "官方认证"/"品牌认证" là chữ của nhãn hiệu, và luật 3 bảo vệ
 * nhãn hiệu mạnh nhất.
 *
 * @param {string} text chữ NGUYÊN VĂN đọc được từ ảnh
 * @returns {{kind: string, kind_reason: string, translatable: boolean}}
 */
export function classifyRegion(text) {
  const value = String(text ?? '').normalize('NFC').trim();

  if (!value) {
    return verdict('unknown', 'vùng rỗng hoặc chỉ có khoảng trắng — không có gì để dịch');
  }
  if (BRAND_RE.test(value)) {
    return verdict('brand', KIND_REASONS.brand);
  }
  if (CERTIFICATION_RE.test(value)) {
    return verdict('certification', KIND_REASONS.certification);
  }
  if (PRICE_RE.test(value)) {
    return verdict('price', KIND_REASONS.price);
  }
  if (SHIPPING_RE.test(value)) {
    // `包邮` + số → giá. Không có số → không đủ căn cứ (fail-closed).
    if (/\d/.test(value)) return verdict('price', KIND_REASONS.price);
    return verdict(
      'unknown',
      'có từ ngữ vận chuyển/khuyến mãi nhưng thiếu con số — không đủ căn cứ, không dịch (fail-closed)',
    );
  }
  if (!LETTER_RE.test(value)) {
    return verdict('unknown', 'chuỗi chỉ có số/ký hiệu, không có chữ để dịch — không dịch (fail-closed)');
  }
  return verdict('descriptive', KIND_REASONS.descriptive);
}

export default classifyRegion;
