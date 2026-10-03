/**
 * G09/G12 — NỘI DUNG: phong cách và độ dài.
 *
 * 6 phong cách, 3 độ dài. Mặc định: style = "bán hàng", length = "vừa".
 * Mỗi phong cách là một CHỈ DẪN cho model, không phải một template cứng — vì
 * template cứng làm nội dung đọc như máy.
 */

export const STYLES = Object.freeze({
  'ban-hang': {
    id: 'ban-hang',
    label: 'Bán hàng',
    description: 'Giọng bán hàng trực tiếp, nhấn lợi ích, có lời kêu gọi hành động rõ.',
    guidance:
      'Giọng bán hàng trực tiếp, hướng lợi ích người mua. Câu ngắn, dễ đọc. Kết bằng lời kêu gọi hành động (CTA) rõ ràng. Được dùng từ ngữ tạo động lực nhưng KHÔNG được bịa khuyến mãi, giảm giá, số lượng có hạn hay quà tặng.',
  },
  'chuyen-nghiep': {
    id: 'chuyen-nghiep',
    label: 'Chuyên nghiệp',
    description: 'Trang trọng, rõ ràng, tập trung thông tin và độ tin cậy.',
    guidance:
      'Giọng trang trọng, khách quan, mạch lạc. Ưu tiên thông tin cụ thể và cấu trúc rõ. Hạn chế từ cảm thán. Không dùng ngôn ngữ giật gân.',
  },
  'ngan-gon': {
    id: 'ngan-gon',
    label: 'Ngắn gọn',
    description: 'Cô đọng, đi thẳng vào ý chính, ít chữ nhất có thể.',
    guidance:
      'Cực kỳ cô đọng. Mỗi câu một ý. Cắt mọi từ thừa. Vẫn phải giữ đủ ý chính và CTA.',
  },
  'viral-tiktok': {
    id: 'viral-tiktok',
    label: 'Viral/TikTok',
    description: 'Nhịp nhanh, hook mạnh, phù hợp video ngắn.',
    guidance:
      'Nhịp nhanh, câu ngắn, có hook mở đầu gây tò mò. Dùng ngôn ngữ đời thường của người Việt trẻ. Phù hợp đọc thành lời thoại video ngắn. KHÔNG được hứa hẹn kết quả, không bịa trào lưu hay số liệu.',
  },
  seo: {
    id: 'seo',
    label: 'SEO',
    description: 'Tối ưu từ khoá tự nhiên, cấu trúc rõ, phục vụ tìm kiếm.',
    guidance:
      'Tối ưu cho tìm kiếm nhưng phải đọc tự nhiên. Đưa từ khoá chính vào đầu tiêu đề và đoạn mở. Dùng cấu trúc H2/H3 trong mô tả chi tiết. KHÔNG nhồi từ khoá, KHÔNG lặp vô nghĩa.',
  },
  'cao-cap': {
    id: 'cao-cap',
    label: 'Cao cấp',
    description: 'Tinh tế, sang trọng, nhấn trải nghiệm và chất lượng cảm nhận.',
    guidance:
      'Giọng tinh tế, sang trọng, tiết chế. Nhấn vào trải nghiệm sử dụng và cảm nhận chất lượng. Câu văn có nhịp. Tránh từ ngữ bình dân và tránh giảm giá. KHÔNG được tự nhận là "cao cấp" thay cho việc mô tả lý do.',
  },
});

export const LENGTHS = Object.freeze({
  ngan: {
    id: 'ngan',
    label: 'Ngắn',
    guidance: 'Ngắn: mô tả ngắn 1–2 câu; mô tả chi tiết khoảng 80–140 từ; 4 điểm bán hàng.',
    shortSentenceRange: [1, 2],
    sellingPointCount: 4,
  },
  vua: {
    id: 'vua',
    label: 'Vừa',
    guidance: 'Vừa: mô tả ngắn 2–4 câu; mô tả chi tiết khoảng 180–300 từ; 5–6 điểm bán hàng.',
    shortSentenceRange: [2, 4],
    sellingPointCount: 6,
  },
  'chi-tiet': {
    id: 'chi-tiet',
    label: 'Chi tiết',
    guidance: 'Chi tiết: mô tả ngắn 3–5 câu; mô tả chi tiết khoảng 350–600 từ; 6–8 điểm bán hàng.',
    shortSentenceRange: [3, 5],
    sellingPointCount: 8,
  },
});

export const DEFAULT_STYLE = 'ban-hang';
export const DEFAULT_LENGTH = 'vua';

export function resolveStyle(id) {
  const key = String(id || DEFAULT_STYLE).toLowerCase();
  return STYLES[key] || STYLES[DEFAULT_STYLE];
}

export function resolveLength(id) {
  const key = String(id || DEFAULT_LENGTH).toLowerCase();
  return LENGTHS[key] || LENGTHS[DEFAULT_LENGTH];
}

/** Nhận id phong cách/độ dài từ body request, không ném lỗi. */
export function parseContentOptions({ style, length } = {}) {
  const s = resolveStyle(style);
  const l = resolveLength(length);
  return {
    style: s.id,
    styleLabel: s.label,
    length: l.id,
    lengthLabel: l.label,
    styleGuidance: s.guidance,
    lengthGuidance: l.guidance,
    sellingPointCount: l.sellingPointCount,
    shortSentenceRange: l.shortSentenceRange,
    isDefaultStyle: s.id === DEFAULT_STYLE,
    isDefaultLength: l.id === DEFAULT_LENGTH,
  };
}

export default { STYLES, LENGTHS, parseContentOptions };
