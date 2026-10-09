/**
 * MVP-08 — `buildListingInput()` + `preflight()` (hợp đồng §0 luật #1, §3).
 *
 * LUẬT #1 — KHÔNG BỊA DỮ LIỆU SÀN. Product Master (MVP-01) đến từ trang Trung Quốc: giá bằng CNY,
 * không có tồn kho, không có cân nặng, không có danh mục của sàn Việt. Những trường đó **chỉ**
 * người bán mới biết ⇒ phải đi qua `overrides` (người dùng nhập). Thiếu ⇒ `issues[]` nêu ĐÚNG tên
 * trường và chặn đăng; tuyệt đối không điền mặc định im lặng.
 *
 * `provenance` ghi mỗi trường lấy từ đâu (`override` / `content` / `master`) để người duyệt biết
 * mình đang duyệt cái gì.
 */

import { isMarketplaceChannel } from './provider.js';

/**
 * Giới hạn của từng sàn dùng ở preflight. Nguồn: tài liệu công khai của Shopee Open Platform v2
 * (`product/add_item`) và TikTok Shop Open Platform 202309 (`Create Product`), tra 10/10/2026 —
 * bảng trường chính thức không mở được trong phiên viết nên các con số là **theo trí nhớ tài liệu,
 * cần xác minh** khi có tài khoản (xem `docs/VERIFICATION.md` §29). Kênh `dry-run` dùng mức CHẶT
 * hơn của hai sàn để một bài qua được chế độ thử thì cũng qua được cả hai sàn thật.
 */
export const CHANNEL_LIMITS = Object.freeze({
  shopee: Object.freeze({ title_max: 120, description_min: 20, description_max: 3000, images_max: 9, weight_unit: 'kg', price_min_vnd: 1000 }),
  tiktokshop: Object.freeze({ title_max: 255, description_min: 20, description_max: 10000, images_max: 9, weight_unit: 'g', price_min_vnd: 1000 }),
  'dry-run': Object.freeze({ title_max: 120, description_min: 20, description_max: 3000, images_max: 9, weight_unit: 'g', price_min_vnd: 1000 }),
});

/** Trường người bán ĐƯỢC PHÉP ghi đè/bổ sung (danh sách trắng: cấu trúc payload do mình kiểm soát). */
export const OVERRIDE_FIELDS = Object.freeze([
  'title', 'description', 'price_vnd', 'stock', 'weight_g', 'category_id', 'brand', 'sku',
  'length_cm', 'width_cm', 'height_cm', 'images',
]);

const asText = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const asInt = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) ? n : Number.isFinite(n) ? n : null;
};
const asNum = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isHttpsUrl = (u) => /^https:\/\/[^\s"'<>]+$/i.test(String(u ?? ''));

/**
 * Dựng ĐẦU VÀO chuẩn hoá cho mọi sàn từ job (Product Master + nội dung tiếng Việt MVP-01) và
 * `overrides` của người bán. KHÔNG dịch/viết lại nội dung ở đây (hợp đồng §3).
 */
export function buildListingInput(job, overrides = {}) {
  const master = job?.product_master && typeof job.product_master === 'object' ? job.product_master : {};
  const content = job?.content && typeof job.content === 'object' ? job.content : {};
  const ov = overrides && typeof overrides === 'object' ? overrides : {};
  const provenance = {};
  const pick = (field, candidates) => {
    for (const [source, value] of candidates) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && !value.trim()) continue;
      if (Array.isArray(value) && value.length === 0) continue;
      provenance[field] = source;
      return value;
    }
    provenance[field] = null;
    return null;
  };

  const title = asText(pick('title', [['override', ov.title], ['content', content.product_name], ['content', content.headline], ['job', job?.product_name]]), 1000);
  const description = asText(pick('description', [['override', ov.description], ['content', content.marketplace_description], ['content', content.detailed_description], ['content', content.short_description]]), 20000);

  const masterImages = Array.isArray(master.images)
    ? master.images.filter((im) => im && im.status !== 'NOT_FOUND' && isHttpsUrl(im.url)).map((im) => String(im.url))
    : [];
  const overrideImages = Array.isArray(ov.images) ? ov.images.filter(isHttpsUrl).map(String) : [];
  const images = [...new Set(pick('images', [['override', overrideImages], ['master', masterImages]]) || [])];

  // Giá CNY của Product Master KHÔNG phải giá bán VND ⇒ không tự quy đổi (tỷ giá, phí, lãi là
  // quyết định của người bán). Giữ `source_price` để người bán tham khảo khi nhập `price_vnd`.
  const price_vnd = asInt(pick('price_vnd', [['override', ov.price_vnd]]));
  const stock = asInt(pick('stock', [['override', ov.stock]]));
  const weight_g = asNum(pick('weight_g', [['override', ov.weight_g]]));
  const category_id = asText(pick('category_id', [['override', ov.category_id]]), 64) || null;
  const brand = asText(pick('brand', [['override', ov.brand]]), 120) || null;
  const sku = asText(pick('sku', [['override', ov.sku], ['master', master.source_product_id]]), 64) || null;
  const length_cm = asNum(pick('length_cm', [['override', ov.length_cm]]));
  const width_cm = asNum(pick('width_cm', [['override', ov.width_cm]]));
  const height_cm = asNum(pick('height_cm', [['override', ov.height_cm]]));

  const variants = Array.isArray(master.variants)
    ? master.variants.map((v) => ({ sku_id: String(v?.sku_id ?? ''), name: String(v?.name ?? ''), price_raw: String(v?.price_raw ?? '') }))
    : [];
  const attributes = Array.isArray(master.attributes)
    ? master.attributes.filter((a) => a && a.name).map((a) => ({ name: String(a.name), value: String(a.value ?? '') }))
    : [];

  return {
    job_id: job?.id ?? null,
    title,
    description,
    images,
    price_vnd,
    stock,
    weight_g,
    category_id,
    brand,
    sku,
    length_cm,
    width_cm,
    height_cm,
    variants,
    attributes,
    source: {
      platform: master.source || job?.source || null,
      url: master.canonical_url || master.source_url || job?.canonical_url || null,
      price_raw: master.price?.raw || null,
      price_currency: master.price?.currency || null,
      price_kind: master.price?.kind || null,
    },
    provenance,
  };
}

/** Một dòng `issues[]`: `{ field, code, message, severity }`. */
function issue(field, code, message, severity = 'error') {
  return { field, code, message, severity };
}

/**
 * KIỂM TRA TRƯỚC KHI ĐĂNG — chạy TRƯỚC mọi lời gọi mạng. Trả `issues[]`; có dòng `severity: 'error'`
 * nào thì KHÔNG được tạo listing (route trả 422 `PREFLIGHT_FAILED`).
 */
export function preflight(channel, input) {
  const ch = String(channel ?? '');
  const issues = [];
  if (!isMarketplaceChannel(ch)) {
    issues.push(issue('channel', 'CHANNEL_UNKNOWN', `Kênh "${ch.slice(0, 40)}" không hợp lệ.`));
    return issues;
  }
  const lim = CHANNEL_LIMITS[ch];
  const inp = input && typeof input === 'object' ? input : {};

  if (!inp.title) issues.push(issue('title', 'MISSING', 'Thiếu tên sản phẩm (job chưa có nội dung tiếng Việt, hoặc nhập `title` ở phần bổ sung).'));
  else if (inp.title.length > lim.title_max) issues.push(issue('title', 'TOO_LONG', `Tên sản phẩm dài ${inp.title.length} ký tự, vượt trần ${lim.title_max} của kênh ${ch}.`));

  if (!inp.description) issues.push(issue('description', 'MISSING', 'Thiếu mô tả sản phẩm (job chưa có `marketplace_description`, hoặc nhập `description` ở phần bổ sung).'));
  else if (inp.description.length < lim.description_min) issues.push(issue('description', 'TOO_SHORT', `Mô tả chỉ ${inp.description.length} ký tự, sàn ${ch} đòi tối thiểu ${lim.description_min}.`));
  else if (inp.description.length > lim.description_max) issues.push(issue('description', 'TOO_LONG', `Mô tả dài ${inp.description.length} ký tự, vượt trần ${lim.description_max} của kênh ${ch}.`));

  const images = Array.isArray(inp.images) ? inp.images : [];
  if (images.length === 0) issues.push(issue('images', 'MISSING', 'Không có ảnh nào (Product Master không có ảnh https hợp lệ và không nhập `images`).'));
  else if (images.length > lim.images_max) issues.push(issue('images', 'TOO_MANY', `Có ${images.length} ảnh, vượt trần ${lim.images_max} của kênh ${ch} — hãy chọn lại ảnh.`));
  for (const u of images) if (!isHttpsUrl(u)) issues.push(issue('images', 'BAD_URL', `Ảnh "${String(u).slice(0, 80)}" không phải URL https.`));

  if (inp.price_vnd === null || inp.price_vnd === undefined) issues.push(issue('price_vnd', 'MISSING', 'Thiếu giá bán VND — giá CNY từ nguồn KHÔNG được tự quy đổi; người bán phải nhập `price_vnd`.'));
  else if (!Number.isInteger(inp.price_vnd) || inp.price_vnd < lim.price_min_vnd) issues.push(issue('price_vnd', 'INVALID', `Giá bán phải là số nguyên VND ≥ ${lim.price_min_vnd} (đang là ${inp.price_vnd}).`));

  if (inp.stock === null || inp.stock === undefined) issues.push(issue('stock', 'MISSING', 'Thiếu tồn kho — hệ thống không biết bạn có bao nhiêu hàng; nhập `stock`.'));
  else if (!Number.isInteger(inp.stock) || inp.stock < 0) issues.push(issue('stock', 'INVALID', `Tồn kho phải là số nguyên ≥ 0 (đang là ${inp.stock}).`));

  if (inp.weight_g === null || inp.weight_g === undefined) issues.push(issue('weight_g', 'MISSING', 'Thiếu cân nặng (gram) — sàn cần để tính phí vận chuyển; nhập `weight_g`.'));
  else if (!(inp.weight_g > 0)) issues.push(issue('weight_g', 'INVALID', `Cân nặng phải > 0 gram (đang là ${inp.weight_g}).`));

  if (!inp.category_id) issues.push(issue('category_id', 'MISSING', `Thiếu mã danh mục của sàn ${ch} — hệ thống KHÔNG đoán danh mục; nhập \`category_id\` lấy từ sàn.`));

  const dims = [inp.length_cm, inp.width_cm, inp.height_cm];
  const dimsGiven = dims.filter((d) => d !== null && d !== undefined).length;
  if (dimsGiven > 0 && dimsGiven < 3) issues.push(issue('dimensions', 'INCOMPLETE', 'Kích thước gói hàng phải đủ cả dài/rộng/cao (cm) hoặc để trống cả ba.'));
  else if (dimsGiven === 0) issues.push(issue('dimensions', 'OPTIONAL_MISSING', 'Chưa có kích thước gói hàng (cm) — sàn có thể đòi khi tính phí vận chuyển.', 'warn'));

  if (Array.isArray(inp.variants) && inp.variants.length > 0) {
    issues.push(issue('variants', 'UNMAPPED', `Nguồn có ${inp.variants.length} biến thể (SKU) — sprint này đăng MỘT SKU; biến thể không được ánh xạ, hãy kiểm lại sau khi đăng.`, 'warn'));
  }
  return issues;
}

export function hasBlockingIssue(issues) {
  return (Array.isArray(issues) ? issues : []).some((i) => i?.severity !== 'warn');
}

export default preflight;
