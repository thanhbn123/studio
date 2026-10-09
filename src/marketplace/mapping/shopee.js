/**
 * Ánh xạ ĐẦU VÀO CHUẨN (xem `preflight.js#buildListingInput`) → payload `product/add_item` của
 * Shopee Open Platform v2 (hợp đồng §3).
 *
 * Nguồn trường: tài liệu công khai `open.shopee.com/documents` mục Product → `v2.product.add_item`,
 * tra 10/10/2026 — bảng trường chính thức KHÔNG mở được trong phiên viết (xem
 * `docs/VERIFICATION.md` §27), nên từng trường dưới đây ghi *(theo trí nhớ tài liệu, cần xác minh)*.
 *
 * Luật §3: trường nào KHÔNG ánh xạ được thì khai vào `unmapped[]` (không bỏ im lặng); giá trị mặc
 * định KHÔNG phải dữ liệu (trạng thái niêm yết, tình trạng hàng) khai vào `defaults_applied[]`.
 * Trường nội bộ tiền tố `_vps_` chỉ để người dùng soi ở chế độ thử, provider thật bỏ đi trước khi gửi.
 */

export function mapToShopee(input) {
  const inp = input && typeof input === 'object' ? input : {};
  const unmapped = [];
  const defaults_applied = [];

  const payload = {
    // item_name: tên sản phẩm, tối đa 120 ký tự (theo trí nhớ tài liệu, cần xác minh)
    item_name: inp.title ?? '',
    // description: mô tả thuần văn bản (theo trí nhớ tài liệu, cần xác minh)
    description: inp.description ?? '',
    // category_id: mã danh mục Shopee — do người bán tra từ sàn (`v2.product.get_category`)
    category_id: inp.category_id !== null && inp.category_id !== undefined && /^\d+$/.test(String(inp.category_id)) ? Number(inp.category_id) : inp.category_id ?? null,
    // original_price: giá niêm yết, đơn vị tiền của shop (VND) (theo trí nhớ tài liệu, cần xác minh)
    original_price: inp.price_vnd ?? null,
    // seller_stock: tồn kho theo kho (sprint này 1 kho mặc định) (theo trí nhớ tài liệu, cần xác minh)
    seller_stock: inp.stock === null || inp.stock === undefined ? [] : [{ stock: inp.stock }],
    // weight: KILOGRAM (theo trí nhớ tài liệu, cần xác minh) — đầu vào của mình là gram
    weight: inp.weight_g === null || inp.weight_g === undefined ? null : Number((inp.weight_g / 1000).toFixed(3)),
    // image.image_id_list: Shopee cần ảnh ĐÃ UPLOAD qua `v2.media_space.upload_image` → image_id.
    // Sprint này chưa có bước upload ⇒ danh sách rỗng + khai vào unmapped (không bịa image_id).
    image: { image_id_list: [] },
    // item_status: 'UNLIST' để bài tạo ra KHÔNG hiện bán ngay — người bán kiểm trên sàn rồi tự bật.
    item_status: 'UNLIST',
    // condition: NEW/USED — hàng nhập mới
    condition: 'NEW',
  };
  defaults_applied.push({ field: 'item_status', value: 'UNLIST', reason: 'bài tạo xong KHÔNG hiện bán ngay; người bán tự bật trên sàn sau khi kiểm' });
  defaults_applied.push({ field: 'condition', value: 'NEW', reason: 'mặc định hàng mới' });

  if (inp.sku) payload.item_sku = String(inp.sku);
  if (inp.brand) {
    // brand: { brand_id, original_brand_name } — brand_id 0 = "không có thương hiệu" theo trí nhớ tài liệu
    payload.brand = { brand_id: 0, original_brand_name: String(inp.brand) };
    unmapped.push({ field: 'brand.brand_id', reason: 'Shopee đòi brand_id từ danh mục thương hiệu của sàn; sprint này gửi tên gốc với brand_id=0 (cần xác minh)' });
  }
  if ([inp.length_cm, inp.width_cm, inp.height_cm].every((d) => d !== null && d !== undefined)) {
    // dimension: { package_length, package_width, package_height } đơn vị cm (theo trí nhớ tài liệu)
    payload.dimension = { package_length: inp.length_cm, package_width: inp.width_cm, package_height: inp.height_cm };
  }

  // logistic_info: danh sách kênh vận chuyển đã bật của shop — PHẢI đọc từ sàn khi có token
  // (`v2.logistics.get_channel_list`). Không bịa.
  unmapped.push({ field: 'logistic_info', reason: 'cần đọc danh sách kênh vận chuyển đã bật của shop từ Shopee (v2.logistics.get_channel_list) khi có token' });
  unmapped.push({ field: 'image.image_id_list', reason: `cần upload ${Array.isArray(inp.images) ? inp.images.length : 0} ảnh qua v2.media_space.upload_image để lấy image_id; sprint này giữ URL ở _vps_image_urls` });
  if (Array.isArray(inp.variants) && inp.variants.length) {
    unmapped.push({ field: 'tier_variation/model', reason: `${inp.variants.length} biến thể từ nguồn chưa được ánh xạ (sprint này 1 SKU)` });
  }
  if (Array.isArray(inp.attributes) && inp.attributes.length) {
    unmapped.push({ field: 'attribute_list', reason: `${inp.attributes.length} thuộc tính từ nguồn chưa ánh xạ (cần attribute_id theo danh mục Shopee)` });
  }

  payload._vps_image_urls = Array.isArray(inp.images) ? [...inp.images] : [];
  payload._vps_price_vnd = inp.price_vnd ?? null;
  payload._vps_stock = inp.stock ?? null;
  payload._vps_source = inp.source ?? null;

  return { channel: 'shopee', payload, unmapped, defaults_applied };
}

export default mapToShopee;
