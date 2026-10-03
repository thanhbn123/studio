/**
 * C2 — Từ điển thuật ngữ thương mại điện tử Trung → Việt + danh sách mẫu chữ CẤM dịch.
 *
 * Luật số 3 của hợp đồng MVP-02: NHÃN HIỆU / CHỨNG NHẬN KHÔNG BAO GIỜ bị dịch.
 * Vì vậy ngoài từ điển dịch, file này còn giữ:
 *   - `NEVER_TRANSLATE`: mảng RegExp các mẫu chữ tuyệt đối không được đưa cho AI dịch.
 *   - `classifyForbiddenText()`: biến một lần khớp mẫu cấm thành trạng thái bỏ qua cụ thể
 *     (SKIPPED_BRAND / SKIPPED_CERTIFICATION / SKIPPED_PRICE / NEEDS_REVIEW) kèm lý do tiếng Việt.
 *
 * Không có mạng, không có side effect — file này chỉ là dữ liệu + hàm thuần.
 */

/**
 * Thuật ngữ TMĐT Trung (giản thể) → tiếng Việt.
 * Chỉ ghi những cặp mình CHẮC nghĩa; thà thiếu còn hơn dịch sai.
 */
const TERMS = [
  // — Vận chuyển / tồn kho / đặt hàng —
  ['包邮', 'Miễn phí vận chuyển'],
  ['现货', 'Hàng có sẵn'],
  ['预售', 'Hàng đặt trước'],
  ['库存', 'Tồn kho'],
  ['缺货', 'Hết hàng'],
  ['发货', 'Gửi hàng'],
  ['快递', 'Chuyển phát nhanh'],
  ['免运费', 'Miễn phí vận chuyển'],
  ['支持货到付款', 'Hỗ trợ thanh toán khi nhận hàng'],

  // — Nguồn hàng / kênh bán —
  ['厂家直销', 'Nhà máy bán trực tiếp'],
  ['批发', 'Bán buôn'],
  ['零售', 'Bán lẻ'],
  ['支持一件代发', 'Hỗ trợ dropship'],
  ['一件代发', 'Hỗ trợ dropship'],
  ['代发', 'Dropship'],
  ['拼团', 'Mua chung'],
  ['产地', 'Xuất xứ'],
  ['进口', 'Nhập khẩu'],
  ['手工制作', 'Làm thủ công'],
  ['定制', 'Đặt làm theo yêu cầu'],

  // — Chính sách / dịch vụ —
  ['七天无理由退换', 'Đổi trả trong 7 ngày'],
  ['保修', 'Bảo hành'],
  ['质保', 'Bảo hành'],
  ['全国联保', 'Bảo hành toàn quốc'],
  ['售后服务', 'Dịch vụ sau bán hàng'],
  ['优惠券', 'Mã giảm giá'],
  ['秒杀', 'Flash sale'],

  // — Thuộc tính sản phẩm —
  ['品牌', 'Thương hiệu'],
  ['正品', 'Hàng chính hãng'],
  ['新款', 'Phiên bản mới'],
  ['新款上市', 'Hàng mới về'],
  ['热卖', 'Bán chạy'],
  ['爆款', 'Sản phẩm bán chạy'],
  ['品质', 'Chất lượng'],
  ['优质', 'Chất lượng cao'],
  ['高端', 'Cao cấp'],
  ['特价', 'Giá đặc biệt'],
  ['全国包邮', 'Miễn phí vận chuyển toàn quốc'],
  ['免邮', 'Miễn phí vận chuyển'],
  ['保暖', 'Giữ ấm'],
  ['服务', 'Dịch vụ'],
  ['保障', 'Bảo đảm'],
  ['支持退换', 'Hỗ trợ đổi trả'],
  ['材质', 'Chất liệu'],
  ['规格', 'Quy cách'],
  ['型号', 'Mã sản phẩm'],
  ['尺寸', 'Kích thước'],
  ['重量', 'Khối lượng'],
  ['容量', 'Dung tích'],
  ['功率', 'Công suất'],
  ['电压', 'Điện áp'],
  ['电池', 'Pin'],
  ['充电', 'Sạc'],
  ['颜色分类', 'Phân loại màu'],
  ['尺码', 'Kích cỡ'],
  ['大码', 'Size lớn'],
  ['材质舒适', 'Chất liệu êm ái'],
  ['纯棉', 'Cotton nguyên chất'],
  ['真皮', 'Da thật'],
  ['不锈钢', 'Thép không gỉ'],
  ['防水', 'Chống nước'],
  ['防滑', 'Chống trượt'],
  ['加厚', 'Dày hơn'],
  ['多功能', 'Đa năng'],
  ['便携', 'Cầm tay'],
  ['家用', 'Dùng trong nhà'],
  ['户外', 'Ngoài trời'],
  ['柔软', 'Mềm mại'],
  ['透气', 'Thoáng khí'],
  ['舒适', 'Êm ái'],
  ['弹力', 'Co giãn'],
  ['时尚', 'Thời trang'],
  ['简约', 'Tối giản'],
  ['儿童', 'Trẻ em'],
  ['礼品', 'Quà tặng'],
  ['套装', 'Bộ sản phẩm'],
  ['多色可选', 'Nhiều màu để chọn'],
  ['数量有限', 'Số lượng có hạn'],
  ['短袖', 'Tay ngắn'],
  ['长袖', 'Tay dài'],
  ['圆领', 'Cổ tròn'],
  ['拉链', 'Khoá kéo'],
  ['保温', 'Giữ nhiệt'],
  ['充电宝', 'Pin sạc dự phòng'],
  ['数据线', 'Cáp dữ liệu'],
  ['无线', 'Không dây'],
  ['蓝牙', 'Bluetooth'],
  ['耳机', 'Tai nghe'],
  ['手表', 'Đồng hồ'],
  ['手机壳', 'Ốp điện thoại'],
  ['钢化膜', 'Miếng dán cường lực'],
  ['收纳盒', 'Hộp đựng đồ'],
  ['折叠', 'Gấp gọn'],
  ['静音', 'Không ồn'],
  ['耐用', 'Bền'],
];

/**
 * `GLOSSARY` vừa dùng được như Map, vừa tra được như object:
 *   GLOSSARY.get('包邮') === 'Miễn phí vận chuyển'
 *   GLOSSARY['包邮']     === 'Miễn phí vận chuyển'
 *   Object.keys(GLOSSARY).length >= 30
 * Lý do: hợp đồng chỉ ghi "Map/Object", nên giữ cả hai kiểu truy cập để agent khác không vỡ.
 */
export const GLOSSARY = new Map(TERMS);
for (const [zh, vi] of TERMS) {
  Object.defineProperty(GLOSSARY, zh, {
    value: vi,
    enumerable: true,
    writable: false,
    configurable: false,
  });
}

/**
 * Mẫu chữ CẤM DỊCH (nhãn hiệu, chứng nhận, giá, mã model).
 * Lưu ý: `\b` chỉ dùng cho token thuần ASCII — TUYỆT ĐỐI không dùng `\b` quanh chữ tiếng Việt
 * hay chữ Hán, vì `\b` của JavaScript chỉ hiểu [A-Za-z0-9_].
 */
export const NEVER_TRANSLATE = Object.freeze([
  // Ký hiệu nhãn hiệu / bản quyền
  /[®™©]/,
  // Từ khoá nhãn hiệu, kênh bán chính thức (tiếng Trung)
  /商标|品牌|旗舰店|专卖店|官方|直营/,
  // Từ khoá chứng nhận / kiểm định (tiếng Trung)
  /认证|合格证|检验|质检|检测报告|执行标准|防伪/,
  // Giá tiền (tiếng Trung)
  /[¥￥]\s*\d|\d+(?:[.,]\d+)?\s*(?:元|块钱|块)|价格|售价|原价|现价|券后|到手价/,
  // Mã hiệu sản phẩm kiểu ASCII: AB-1234, XL200, HD1080
  /\b[A-Z]{2,}-?\d{2,}\b/,
  // Mã chuẩn quốc tế (chứng nhận) — `\b` an toàn vì thuần ASCII
  /\b(?:ISO|CE|FDA|RoHS|FCC|GMP|HACCP)\b|\b3C\b/i,
  /\bISO\s?\d{3,5}\b/i,
  /\bIPX?\d{1,2}\b/i,
  // Nhãn hiệu Latin phổ biến
  /\b(?:Apple|iPhone|Samsung|Galaxy|Xiaomi|Huawei|Honor|Oppo|Vivo|Nike|Adidas|Puma|Sony|JBL|Anker|Baseus|Philips|Dyson|Logitech|Uniqlo|Gucci|Chanel|Dior|Lego|Casio|Nintendo)\b/i,
  // Nhãn hiệu Trung Quốc phổ biến
  /华为|小米|格力|美的|海尔|九阳|苏泊尔|南极人|恒源祥|回力|李宁|安踏|波司登|太平鸟|七匹狼|花花公子|雅戈尔|富安娜|罗莱|水星|洁丽雅|得力|晨光|公牛|飞科|小熊/,
]);

/* ─────────────────── Phân loại chữ bị cấm dịch ─────────────────── */

const PROTECTED_PATTERNS = [
  {
    kind: 'brand',
    status: 'SKIPPED_BRAND',
    reason: (hit) =>
      `Chứa nhãn hiệu/thương hiệu (“${hit}”) — nhãn hiệu không bao giờ bị dịch, phải giữ nguyên trên ảnh.`,
    re: /[®™©]|商标|品牌|旗舰店|专卖店|官方|直营/,
  },
  {
    kind: 'certification',
    status: 'SKIPPED_CERTIFICATION',
    reason: (hit) => `Chứa chứng nhận/kiểm định (“${hit}”) — không dịch để tránh sai lệch chứng nhận.`,
    re: /认证|合格证|检验|质检|检测报告|执行标准|防伪/,
  },
  {
    kind: 'certification',
    status: 'SKIPPED_CERTIFICATION',
    reason: (hit) => `Chứa mã chuẩn/chứng nhận (“${hit}”) — giữ nguyên, không dịch.`,
    re: /\b(?:ISO|CE|FDA|RoHS|FCC|GMP|HACCP)\b|\b3C\b|\bISO\s?\d{3,5}\b|\bIPX?\d{1,2}\b/i,
  },
  {
    kind: 'price',
    status: 'SKIPPED_PRICE',
    reason: (hit) => `Chứa giá tiền (“${hit}”) — không dịch, giá do người bán quyết định.`,
    re: /[¥￥]\s*\d|\d+(?:[.,]\d+)?\s*(?:元|块钱|块)|价格|售价|原价|现价|券后|到手价/,
  },
  {
    kind: 'brand',
    status: 'SKIPPED_BRAND',
    reason: (hit) => `Chứa mã hiệu/nhãn hiệu (“${hit}”) — giữ nguyên, không dịch.`,
    re: /\b[A-Z]{2,}-?\d{2,}\b/,
  },
  {
    kind: 'brand',
    status: 'SKIPPED_BRAND',
    reason: (hit) => `Chứa tên nhãn hiệu (“${hit}”) — giữ nguyên, không dịch.`,
    re: /\b(?:Apple|iPhone|Samsung|Galaxy|Xiaomi|Huawei|Honor|Oppo|Vivo|Nike|Adidas|Puma|Sony|JBL|Anker|Baseus|Philips|Dyson|Logitech|Uniqlo|Gucci|Chanel|Dior|Lego|Casio|Nintendo)\b/i,
  },
  {
    kind: 'brand',
    status: 'SKIPPED_BRAND',
    reason: (hit) => `Chứa tên nhãn hiệu Trung Quốc (“${hit}”) — giữ nguyên, không dịch.`,
    re: /华为|小米|格力|美的|海尔|九阳|苏泊尔|南极人|恒源祥|回力|李宁|安踏|波司登|太平鸟|七匹狼|花花公子|雅戈尔|富安娜|罗莱|水星|洁丽雅|得力|晨光|公牛|飞科|小熊/,
  },
];

/** Trả về true nếu `text` khớp BẤT KỲ mẫu chữ cấm dịch nào. */
export function isForbiddenText(text) {
  const s = String(text ?? '');
  if (!s) return false;
  return NEVER_TRANSLATE.some((re) => new RegExp(re.source, re.flags.replace('g', '')).test(s));
}

/**
 * Phân loại chữ bị cấm dịch thành trạng thái bỏ qua cụ thể.
 * @returns {{status:string, kind:string, reason:string, matched:string}|null}
 */
export function classifyForbiddenText(text) {
  const s = String(text ?? '');
  if (!s) return null;
  for (const p of PROTECTED_PATTERNS) {
    const m = new RegExp(p.re.source, p.re.flags.replace('g', '')).exec(s);
    if (m) {
      return { status: p.status, kind: p.kind, matched: m[0], reason: p.reason(m[0]) };
    }
  }
  // Có khớp NEVER_TRANSLATE nhưng chưa phân loại được → fail-closed, để người duyệt.
  const m = NEVER_TRANSLATE.map((re) => new RegExp(re.source, re.flags.replace('g', '')).exec(s)).find(Boolean);
  if (m) {
    return {
      status: 'NEEDS_REVIEW',
      kind: 'unknown',
      matched: m[0],
      reason: `Chứa mẫu chữ cấm dịch (“${m[0]}”) nhưng chưa phân loại được — cần người duyệt.`,
    };
  }
  return null;
}

export default GLOSSARY;
