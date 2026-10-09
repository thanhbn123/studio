/**
 * Ánh xạ ĐẦU VÀO CHUẨN → payload `POST /product/202309/products` của TikTok Shop (hợp đồng §3).
 *
 * Nguồn trường: tài liệu công khai `partner.tiktokshop.com/docv2` mục Product → Create Product
 * (API 202309), tra 10/10/2026 — trang tài liệu chính thức KHÔNG mở được trong phiên viết (xem
 * `docs/VERIFICATION.md` §27) ⇒ từng trường ghi *(theo trí nhớ tài liệu, cần xác minh)*.
 *
 * Luật §3: không ánh xạ được ⇒ `unmapped[]`; mặc định không phải dữ liệu ⇒ `defaults_applied[]`.
 */

export function mapToTiktokShop(input) {
  const inp = input && typeof input === 'object' ? input : {};
  const unmapped = [];
  const defaults_applied = [];

  const payload = {
    // title: tối đa 255 ký tự (theo trí nhớ tài liệu, cần xác minh)
    title: inp.title ?? '',
    // description: cho phép HTML đơn giản; mình gửi văn bản thuần (theo trí nhớ tài liệu, cần xác minh)
    description: inp.description ?? '',
    // category_id: mã danh mục TikTok Shop — người bán tra từ sàn (`/product/202309/categories`)
    category_id: inp.category_id ?? null,
    // main_images: [{ uri }] — uri là ảnh ĐÃ UPLOAD qua `/product/202309/images/upload`.
    // Chưa có bước upload ⇒ rỗng + khai unmapped (không bịa uri).
    main_images: [],
    // skus: 1 SKU — giá VND dạng chuỗi + tồn theo kho (theo trí nhớ tài liệu, cần xác minh)
    skus: [
      {
        ...(inp.sku ? { seller_sku: String(inp.sku) } : {}),
        price: { amount: inp.price_vnd === null || inp.price_vnd === undefined ? null : String(inp.price_vnd), currency: 'VND' },
        inventory: [{ warehouse_id: null, quantity: inp.stock ?? null }],
      },
    ],
    // package_weight: { value, unit } — TikTok dùng KILOGRAM (theo trí nhớ tài liệu, cần xác minh)
    package_weight: inp.weight_g === null || inp.weight_g === undefined
      ? null
      : { value: String(Number((inp.weight_g / 1000).toFixed(3))), unit: 'KILOGRAM' },
    // save_mode: AS_DRAFT để sản phẩm KHÔNG lên kệ ngay; người bán kiểm rồi tự đăng trên Seller Center
    save_mode: 'AS_DRAFT',
  };
  defaults_applied.push({ field: 'save_mode', value: 'AS_DRAFT', reason: 'sản phẩm tạo ở dạng NHÁP trên sàn; người bán tự đưa lên kệ sau khi kiểm' });

  if (inp.brand) {
    unmapped.push({ field: 'brand_id', reason: `thương hiệu "${inp.brand}" cần brand_id từ danh mục thương hiệu TikTok Shop (/product/202309/brands); chưa ánh xạ` });
  }
  if ([inp.length_cm, inp.width_cm, inp.height_cm].every((d) => d !== null && d !== undefined)) {
    // package_dimensions: { length, width, height, unit: 'CENTIMETER' } (theo trí nhớ tài liệu)
    payload.package_dimensions = { length: String(inp.length_cm), width: String(inp.width_cm), height: String(inp.height_cm), unit: 'CENTIMETER' };
  }

  unmapped.push({ field: 'skus[0].inventory[0].warehouse_id', reason: 'cần warehouse_id của shop đọc từ TikTok Shop (/logistics/202309/warehouses) khi có token' });
  unmapped.push({ field: 'main_images[].uri', reason: `cần upload ${Array.isArray(inp.images) ? inp.images.length : 0} ảnh qua /product/202309/images/upload để lấy uri; sprint này giữ URL ở _vps_image_urls` });
  if (Array.isArray(inp.variants) && inp.variants.length) {
    unmapped.push({ field: 'skus[].sales_attributes', reason: `${inp.variants.length} biến thể từ nguồn chưa được ánh xạ (sprint này 1 SKU)` });
  }
  if (Array.isArray(inp.attributes) && inp.attributes.length) {
    unmapped.push({ field: 'product_attributes', reason: `${inp.attributes.length} thuộc tính từ nguồn chưa ánh xạ (cần attribute id theo danh mục TikTok Shop)` });
  }

  payload._vps_image_urls = Array.isArray(inp.images) ? [...inp.images] : [];
  payload._vps_price_vnd = inp.price_vnd ?? null;
  payload._vps_stock = inp.stock ?? null;
  payload._vps_source = inp.source ?? null;

  return { channel: 'tiktokshop', payload, unmapped, defaults_applied };
}

export default mapToTiktokShop;
