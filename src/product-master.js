/**
 * G06 — PRODUCT MASTER: schema thống nhất cho cả 3 nguồn.
 *
 * Luật quan trọng nhất của file này: **KHÔNG BỊA FIELD**.
 * Mỗi field đều mang `status`. Field không lấy được phải ghi đúng lý do
 * (NOT_FOUND / LOGIN_REQUIRED / BLOCKED / UNSUPPORTED), tuyệt đối không để giá trị
 * suy diễn khoác áo dữ kiện.
 */

/** Trạng thái trích xuất của một field. */
export const STATUS = Object.freeze({
  FOUND: 'FOUND',
  NOT_FOUND: 'NOT_FOUND',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  BLOCKED: 'BLOCKED',
  UNSUPPORTED: 'UNSUPPORTED',
});

export const ALL_STATUSES = Object.freeze(Object.values(STATUS));

/** Nguồn gốc của dữ liệu — tách khỏi `status`. */
export const PROVENANCE = Object.freeze({
  SOURCE: 'source', // lấy trực tiếp từ trang sàn
  VISION: 'vision', // nhìn thấy trong ảnh
  INFERENCE: 'inference', // AI suy luận — PHẢI được đánh dấu
  USER: 'user', // người dùng nhập tay (G11 fallback)
});

export const IMAGE_TYPES = Object.freeze(['cover', 'gallery', 'detail']);

/** Các field bắt buộc phải khai báo trạng thái trong evidence. */
export const TRACKED_FIELDS = Object.freeze([
  'title_original',
  'images',
  'videos',
  'variants',
  'attributes',
  'price',
  'description_original',
  'store',
]);

export class ProductMasterError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ProductMasterError';
    this.code = 'INVALID_PRODUCT_MASTER';
    this.details = details;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asString = (v) => (v === null || v === undefined ? '' : String(v));

/**
 * Khung Product Master rỗng. Mọi field mặc định NOT_FOUND — nghĩa là
 * "chưa chứng minh được", chứ không phải "không có".
 */
export function createEmptyMaster({ source = '', sourceUrl = '', canonicalUrl = '', sourceProductId = '' } = {}) {
  return {
    source,
    source_url: sourceUrl,
    canonical_url: canonicalUrl,
    source_product_id: sourceProductId,

    title_original: '',
    title_original_status: STATUS.NOT_FOUND,

    images: [],
    videos: [],
    variants: [],
    attributes: [],

    price: { raw: '', currency: 'CNY', status: STATUS.NOT_FOUND, kind: 'unknown', tiers: [] },

    description_original: '',
    description_original_status: STATUS.NOT_FOUND,

    store: { name: '', id: '', url: '', status: STATUS.NOT_FOUND },

    extraction: {
      method: '',
      connector: '',
      extracted_at: '',
      warnings: [],
      missing_fields: [],
      found_fields: [],
      login_required: false,
      blocked_reason: '',
      http_status: null,
      final_url: '',
      bytes: 0,
      field_status: {}, // field -> STATUS
    },

    // Kết quả các tầng sau (G07/G08)
    vision: null,
    knowledge: null,
  };
}

export function image(url, type = 'gallery', status = STATUS.FOUND, provenance = PROVENANCE.SOURCE) {
  if (!IMAGE_TYPES.includes(type)) throw new ProductMasterError(`Loại ảnh không hợp lệ: ${type}`);
  return { url: asString(url), type, status, provenance };
}

export function video(url, type = 'main', status = STATUS.FOUND, provenance = PROVENANCE.SOURCE) {
  return { url: asString(url), type, status, provenance };
}

export function variant({ skuId = '', name = '', attributes = {}, priceRaw = '', status = STATUS.FOUND } = {}) {
  return { sku_id: asString(skuId), name: asString(name), attributes, price_raw: asString(priceRaw), status };
}

export function attribute({ name = '', value = '', status = STATUS.FOUND, provenance = PROVENANCE.SOURCE } = {}) {
  return { name: asString(name), value: asString(value), status, provenance };
}

/**
 * Giá có cấu trúc phân biệt RÕ ba kiểu biểu diễn.
 * Sàn Trung Quốc hay hiển thị "¥12.00 - ¥25.00" hoặc bảng giá theo bậc số lượng —
 * hai kiểu đó KHÔNG phải giá cố định. Ghi sai kiểu là biến khoảng thành fact.
 */
export function price({ raw = '', currency = 'CNY', status = STATUS.NOT_FOUND, kind = 'unknown', tiers = [] } = {}) {
  const validKinds = ['fixed', 'range', 'tier', 'unknown'];
  if (!validKinds.includes(kind)) throw new ProductMasterError(`kind giá không hợp lệ: ${kind}`);
  return { raw: asString(raw), currency: asString(currency) || 'CNY', status, kind, tiers };
}

/** Thêm cảnh báo vào extraction (đã khử trùng lặp). */
export function addWarning(master, message) {
  const msg = asString(message).trim();
  if (msg && !master.extraction.warnings.includes(msg)) master.extraction.warnings.push(msg);
  return master;
}

export function addMissing(master, field) {
  if (!master.extraction.missing_fields.includes(field)) master.extraction.missing_fields.push(field);
  return master;
}

export function addFound(master, field) {
  if (!master.extraction.found_fields.includes(field)) master.extraction.found_fields.push(field);
  return master;
}

/**
 * Tính lại `found_fields` / `missing_fields` / `field_status` từ dữ liệu thật.
 * Gọi ở cuối mỗi connector để evidence luôn khớp với nội dung — không ai phải
 * nhớ cập nhật tay hai nơi.
 */
export function recomputeEvidence(master) {
  const status = {};
  const found = [];
  const missing = [];

  const mark = (field, st) => {
    status[field] = st;
    if (st === STATUS.FOUND) found.push(field);
    else missing.push(field);
  };

  // Khi field RỖNG, phải tôn trọng status đã được đặt sẵn (BLOCKED/LOGIN_REQUIRED/UNSUPPORTED).
  // Trước đây luôn ghi đè thành NOT_FOUND, tạo mâu thuẫn ngay trong CÙNG một object:
  // field_status.title_original = NOT_FOUND trong khi evidenceTable báo UNSUPPORTED.
  mark(
    'title_original',
    master.title_original
      ? master.title_original_status || STATUS.FOUND
      : master.title_original_status || STATUS.NOT_FOUND,
  );

  const imgFound = master.images.filter((i) => i.status === STATUS.FOUND);
  mark('images', imgFound.length > 0 ? STATUS.FOUND : master.extraction.field_status?.images || STATUS.NOT_FOUND);

  const vidFound = master.videos.filter((v) => v.status === STATUS.FOUND);
  mark('videos', vidFound.length > 0 ? STATUS.FOUND : master.extraction.field_status?.videos || STATUS.NOT_FOUND);

  mark('variants', master.variants.length > 0 ? STATUS.FOUND : master.extraction.field_status?.variants || STATUS.NOT_FOUND);
  mark('attributes', master.attributes.length > 0 ? STATUS.FOUND : master.extraction.field_status?.attributes || STATUS.NOT_FOUND);
  mark('price', master.price.status || STATUS.NOT_FOUND);
  mark(
    'description_original',
    master.description_original
      ? master.description_original_status || STATUS.FOUND
      : master.description_original_status || STATUS.NOT_FOUND,
  );
  mark('store', master.store?.name ? master.store.status || STATUS.FOUND : master.store?.status || STATUS.NOT_FOUND);

  master.extraction.field_status = status;
  master.extraction.found_fields = found;
  master.extraction.missing_fields = missing;
  master.extraction.login_required =
    Boolean(master.extraction.login_required) ||
    Object.values(status).some((s) => s === STATUS.LOGIN_REQUIRED);
  return master;
}

/**
 * Kiểm tính hợp lệ của Product Master trước khi đưa vào pipeline.
 * @returns {{valid:boolean, errors:string[]}}
 */
export function validateMaster(master) {
  const errors = [];
  if (!isPlainObject(master)) return { valid: false, errors: ['Product Master không phải object.'] };

  if (!master.source) errors.push('Thiếu `source`.');
  else if (!['taobao', '1688', 'pinduoduo', 'manual'].includes(master.source)) {
    errors.push(`\`source\` không hợp lệ: ${master.source}`);
  }

  for (const key of ['images', 'videos', 'variants', 'attributes']) {
    if (!Array.isArray(master[key])) errors.push(`\`${key}\` phải là mảng.`);
  }
  if (!isPlainObject(master.price)) errors.push('Thiếu `price`.');
  else if (!ALL_STATUSES.includes(master.price.status)) {
    errors.push(`\`price.status\` không hợp lệ: ${master.price.status}`);
  }
  if (!isPlainObject(master.store)) errors.push('Thiếu `store`.');
  if (!isPlainObject(master.extraction)) errors.push('Thiếu `extraction`.');

  if (Array.isArray(master.images)) {
    master.images.forEach((img, i) => {
      if (!img || typeof img.url !== 'string') errors.push(`images[${i}].url không hợp lệ.`);
      if (img && !IMAGE_TYPES.includes(img.type)) errors.push(`images[${i}].type không hợp lệ: ${img?.type}`);
      if (img && !ALL_STATUSES.includes(img.status)) errors.push(`images[${i}].status không hợp lệ: ${img?.status}`);
    });
  }

  if (Array.isArray(master.attributes)) {
    master.attributes.forEach((a, i) => {
      if (!a || typeof a.name !== 'string' || typeof a.value !== 'string') {
        errors.push(`attributes[${i}] phải có name/value dạng chuỗi.`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Gộp nhiều Product Master (vd: extract + bổ sung thủ công ở G11).
 * `later` thắng khi có dữ liệu; field rỗng không được ghi đè field đã có.
 */
export function mergeMasters(base, later) {
  const out = structuredClone(base);
  if (!later) return out;
  const take = (key) => {
    const v = later[key];
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v) && v.length === 0) return;
    if (isPlainObject(v) && Object.keys(v).length === 0) return;
    out[key] = v;
  };
  for (const key of [
    'title_original',
    'title_original_status',
    'description_original',
    'description_original_status',
    'price',
    'store',
  ]) {
    take(key);
  }
  for (const key of ['images', 'videos', 'variants', 'attributes']) {
    if (Array.isArray(later[key]) && later[key].length > 0) out[key] = [...out[key], ...later[key]];
  }
  out.extraction = {
    ...out.extraction,
    ...later.extraction,
    warnings: [...new Set([...(out.extraction?.warnings || []), ...(later.extraction?.warnings || [])])],
    found_fields: [...new Set([...(out.extraction?.found_fields || []), ...(later.extraction?.found_fields || [])])],
    missing_fields: [...new Set([...(out.extraction?.missing_fields || []), ...(later.extraction?.missing_fields || [])])],
  };
  return recomputeEvidence(out);
}

/**
 * Bảng bằng chứng cho UI (G14). Phải luôn suy ra từ dữ liệu thật.
 * Trả về đúng những dòng Owner cần thấy, kèm số đếm thật.
 */
export function evidenceTable(master) {
  const countStatus = (arr, st) => arr.filter((x) => x.status === st).length;
  const row = (label, st, detail) => ({ label, status: st, detail });

  // Trạng thái của một field phải NHẤT QUÁN: có dữ liệu → FOUND; không có thì lấy
  // lý do thật từ `field_status` (LOGIN_REQUIRED / BLOCKED / …), cuối cùng mới NOT_FOUND.
  // Trước đây chỉ mỗi dòng "Video" tra field_status, còn Ảnh/SKU/Thuộc tính hardcode
  // NOT_FOUND — che mất sự thật là trang bị chặn.
  const fs = master.extraction?.field_status || {};

  /**
   * Trạng thái của một dòng bằng chứng.
   *
   * Hai luật, cả hai đều sinh ra từ lỗi thật mà verifier độc lập tìm ra:
   *  1. `count` phải là SỐ PHẦN TỬ CÓ status === FOUND, không phải độ dài mảng. Bản trước
   *     lấy `master.images.length`, nên một ảnh mang status LOGIN_REQUIRED vẫn hiện
   *     "Ảnh FOUND (1 FOUND)" trong khi `summary.images_found = 0`.
   *  2. `field_status` phải THẮNG giá trị NOT_FOUND mặc định. Nếu nó nói LOGIN_REQUIRED /
   *     BLOCKED / UNSUPPORTED thì đó mới là lý do thật; để NOT_FOUND hiện ra là che mất
   *     sự thật "trang bị chặn" và biến nó thành "trang không có field này".
   */
  const resolveStatus = (explicit, key, arrived, arr = []) => {
    if (arrived) return STATUS.FOUND;
    const fromField = fs[key];
    if (fromField && fromField !== STATUS.NOT_FOUND) return fromField;
    // Lý do có thể nằm ngay trên CHÍNH các phần tử: một ảnh mang status LOGIN_REQUIRED
    // tự nó đã nói "cần đăng nhập", không cần field_status nhắc lại.
    const fromItem = arr.find((x) => x && x.status && x.status !== STATUS.FOUND)?.status;
    if (fromItem) return fromItem;
    return explicit || fromField || STATUS.NOT_FOUND;
  };
  const arrivedCount = (arr) => countStatus(arr, STATUS.FOUND);

  const rows = [
    row('Ảnh', resolveStatus(null, 'images', arrivedCount(master.images), master.images), `${arrivedCount(master.images)} FOUND`),
    row('Video', resolveStatus(null, 'videos', arrivedCount(master.videos), master.videos), `${arrivedCount(master.videos)} FOUND`),
    row('SKU / Biến thể', resolveStatus(null, 'variants', arrivedCount(master.variants), master.variants), `${arrivedCount(master.variants)} FOUND`),
    row('Thuộc tính', resolveStatus(null, 'attributes', arrivedCount(master.attributes), master.attributes), `${arrivedCount(master.attributes)} FOUND`),
    row(
      'Tiêu đề gốc',
      resolveStatus(master.title_original_status, 'title_original', Boolean(master.title_original)),
      master.title_original ? 'FOUND' : 'NOT_FOUND',
    ),
    row('Giá hiển thị', resolveStatus(master.price?.status, 'price', Boolean(master.price?.raw)), master.price?.raw ? `${master.price.kind}: ${master.price.raw}` : 'NOT_FOUND'),
    row(
      'Mô tả',
      resolveStatus(master.description_original_status, 'description_original', Boolean(master.description_original)),
      master.description_original ? `${master.description_original.length} ký tự` : 'NOT_FOUND',
    ),
    row('Cửa hàng', resolveStatus(master.store?.status, 'store', Boolean(master.store?.name)), master.store?.name || '—'),
  ];


  return {
    connector: master.extraction?.connector || master.source,
    extraction_method: master.extraction?.method || '',
    login_required: Boolean(master.extraction?.login_required),
    blocked_reason: master.extraction?.blocked_reason || '',
    http_status: master.extraction?.http_status ?? null,
    error_code: master.extraction?.error_code || '',
    rows,
    summary: {
      images_found: countStatus(master.images, STATUS.FOUND),
      videos_found: countStatus(master.videos, STATUS.FOUND),
      variants_found: countStatus(master.variants, STATUS.FOUND),
      attributes_found: countStatus(master.attributes, STATUS.FOUND),
      found_fields: master.extraction?.found_fields?.length || 0,
      missing_fields: master.extraction?.missing_fields?.length || 0,
    },
    warnings: master.extraction?.warnings || [],
  };
}

export default {
  STATUS,
  PROVENANCE,
  createEmptyMaster,
  validateMaster,
  recomputeEvidence,
  evidenceTable,
  mergeMasters,
};
