/**
 * G09 — GUARDRAILS chống bịa cho nội dung sinh ra.
 *
 * Đây là lớp kiểm CUỐI, độc lập với prompt. Prompt có thể bị model bỏ qua;
 * lớp này thì không, vì nó chạy trên văn bản đã sinh.
 *
 * Cách làm: dựng "bằng chứng" (evidence) từ dữ liệu nguồn + vision, rồi soi nội
 * dung tìm các KHẲNG ĐỊNH ĐỊNH LƯỢNG/THUỘC TÍNH không có trong bằng chứng.
 */

import { sanitizeText } from '../security/sanitize.js';
import { PROVENANCE } from '../product-master.js';

/** Nhóm khẳng định bị soi. `allowIfEvidence` = true nghĩa là có bằng chứng thì cho qua. */
export const CLAIM_RULES = [
  {
    id: 'warranty',
    label: 'bảo hành',
    // KHÔNG dùng `\b` quanh từ tiếng Việt: `\b` của JS chỉ hiểu [A-Za-z0-9_], nên
    // `\b(?:…|đạt chuẩn|…)` KHÔNG BAO GIỜ khớp với "đạt chuẩn" — nhánh chết.
    // Chỉ giữ `\b` cho token thuần ASCII (bh).
    re: /bảo hành|bảo đảm\s*(?:trong\s*)?(?:\d+|một|1)\s*(?:năm|tháng|ngày)|bảo trì|đổi trả|hoàn tiền|1\s*đổi\s*1|cam kết bảo hành|\bbh\b/gi,
  },
  {
    id: 'certification',
    label: 'chứng nhận',
    re: /chứng nhận|đạt chuẩn|kiểm định|\biso\b|\bce\b|\bfda\b|\brohs\b|\bfcc\b|\bgmp\b|\bhaccp\b|an toàn thực phẩm|không chứa\s*bpa|\bbpa\b/gi,
  },
  {
    id: 'waterproof',
    label: 'chống nước',
    re: /chống nước|kháng nước|ngâm nước|không thấm nước|chống thấm|chống bụi nước|waterproof|đi mưa|kháng ẩm|chống ẩm|lặn sâu|rửa trực tiếp|vòi nước|\bipx?\d{1,2}\b|\b\d+atm\b/gi,
  },
  {
    id: 'spec_unit',
    label: 'đơn vị thông số',
    // Gồm cả cách nói thuần Việt: "miliampe", "oát", "ký", "phân", "xị", và dạng "1m8".
    // KHÔNG có `\b` ở cuối nhóm đầu: đơn vị tiếng Việt (ký, xị, phân) kết thúc bằng
    // ký tự non-ASCII nên `\b` không bao giờ khớp — đúng họ lỗi với `\b` phía trước.
    re: /\d+(?:[.,]\d+)?\s*(?:mAh|kWh|kW|W|V|Hz|inch|ml|kg|mm|cm|lít|miliampe|oát|watt|ký|gam|phân|xị|mét|m2|m3)|\b(?:mAh|kWh|IP\d{2}|IPX\d|Hz|ATM)\b|\d+\s*m\d|(?:pin|dùng|sử dụng|chạy|hoạt động)\s*(?:được|liên tục)?\s*\d+\s*(?:ngày|giờ|tuần|tháng|năm)/gi,
  },
  {
    id: 'capacity',
    label: 'dung tích/công suất',
    re: /\d+(?:[.,]\d+)?\s*(?:ml|l|L|mAh|W|kW|V|Hz|inch|cm|mm|kg|g|lít|xị|oát|watt|miliampe)/gi,
  },
  {
    id: 'material',
    label: 'chất liệu',
    re: /da thật|da bò|da pu|da microfiber|microfiber|cotton|nhôm|hợp kim|thép không gỉ|inox|titan|gỗ sồi|gỗ tự nhiên|gốm sứ|thủy tinh|cao su|silicon|nhựa abs|vàng \d+k|bạc \d{3}|carbon/gi,
  },
  {
    id: 'origin',
    label: 'nguồn gốc',
    re: /xuất xứ|nguồn gốc|nguồn hàng|made in|sản xuất tại|nhập khẩu|nội địa|chính hãng|xách tay|quảng châu|tận xưởng|tận gốc/gi,
  },
  {
    id: 'price_claim',
    label: 'giá/khuyến mãi',
    // Từ khoá khuyến mãi PHẢI đi kèm một con số/đơn vị cụ thể mới tính là lời chào bán.
    // Lý do: câu trung thực "giá có thể thay đổi theo chương trình khuyến mãi của sàn"
    // (nguyên văn ghi chú giá của chính Taobao) từng bị bắt oan chỉ vì có chữ "khuyến mãi".
    re: /(?:sale|giảm giá|giảm|ưu đãi|khuyến mãi|voucher|mã giảm|đồng giá|giá chỉ|giá sốc)\s*(?:đến\s*|chỉ\s*|từ\s*)?\d|\d+\s*%|flash sale|freeship|free ship|miễn phí (?:vận chuyển|giao hàng|ship)|tặng kèm|tặng ngay|mua \d+ tặng \d+|quà tặng|số lượng có hạn|chỉ còn\s*\d+|nhanh tay/gi,
  },
  {
    id: 'price_value',
    label: 'giá cụ thể',
    // Bắt MỌI con số tiền tệ. Nhóm này dùng `numeric: true` để được miễn nếu con số
    // đó thật sự có trong bằng chứng (giá sàn lấy được) — xem `checkContent`.
    numeric: true,
    re: /\d+(?:[.,]\d+)?\s*(?:đ|vnđ|vnd|usd|cny|¥|tệ|triệu|nghìn|k\b)/gi,
  },
  {
    id: 'rating',
    label: 'số liệu xã hội',
    re: /\d+(?:[.,]\d+)?\s*(?:k|nghìn|ngàn|trăm|triệu)?\+?\s*(?:khách hàng|người mua|người dùng|đánh giá|review|sao|đơn hàng|lượt mua|lượt bán)|\d+(?:[.,]\d+)?\s*\/\s*5|được đánh giá|được yêu thích|yêu thích nhất|tin dùng|bán chạy/gi,
  },
  {
    id: 'overclaim',
    label: 'cam kết quá mức / YMYL',
    // Nhóm này bắt các khẳng định TUYỆT ĐỐI và các tuyên bố sức khoẻ — loại rủi ro
    // pháp lý và đạo đức cao nhất, đồng thời gần như không bao giờ có bằng chứng.
    re: /tốt nhất thị trường|số 1 (?:việt nam|thị trường|châu)|độc quyền|duy nhất|tuyệt đối an toàn|an toàn tuyệt đối|chữa khỏi|chữa bệnh|trị bệnh|giảm cân|thần tốc|100% (?:an toàn|hiệu quả)|cam kết hiệu quả/gi,
  },
];

/**
 * Gom toàn bộ bằng chứng có thật thành một khối chữ để đối chiếu.
 */
export function buildEvidenceText(master, knowledge, vision) {
  const parts = [];
  const push = (v) => {
    if (v) parts.push(String(v));
  };

  push(master?.title_original);
  push(master?.description_original);
  for (const i of master?.images || []) push(i.url);
  for (const a of master?.attributes || []) {
    push(a.name);
    push(a.value);
  }
  for (const v of master?.variants || []) {
    push(v.name);
    push(v.price_raw);
  }
  push(master?.price?.raw);
  for (const t of master?.price?.tiers || []) push(JSON.stringify(t));
  push(master?.store?.name);

  // CẢNH BÁO — đây từng là lỗ hổng nghiêm trọng nhất của cả hệ thống.
  //
  // Bản dịch (`translation.title_vi`) do CHÍNH model sinh ra, và nó bị gắn nhãn `inference`.
  // Nếu đưa nó vào bằng chứng thì model chỉ cần "dịch" điều nó vừa bịa là đủ để lượt sinh
  // nội dung sau đó được miễn kiểm: đo được là "Bảo hành 12 tháng, chống nước IP68" cho
  // 4 vi phạm khi bằng chứng rỗng, nhưng **0 vi phạm** khi bản dịch của model đã nói điều đó trước.
  //
  // Luật: bằng chứng CHỈ được đến từ nguồn thật (source), từ ảnh (vision), hoặc từ người dùng (user).
  // Tuyệt đối không lấy văn bản do model sinh làm căn cứ để miễn kiểm cho văn bản do model sinh.
  for (const f of knowledge?.facts || []) {
    if (f.provenance === PROVENANCE.INFERENCE) continue;
    push(f.value);
  }
  for (const f of knowledge?.visual_features || []) push(f);
  for (const f of knowledge?.visual_text || []) push(f);
  for (const f of knowledge?.colors || []) push(f);
  for (const f of vision?.analysis?.visible_text || []) push(f);
  for (const f of vision?.analysis?.visible_features || []) push(f);

  return parts.join(' \n ').toLowerCase();
}

/** Trích các số xuất hiện trong bằng chứng — để đối chiếu nhanh con số. */
function numbersIn(text) {
  return new Set((String(text).match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(',', '.')));
}

/**
 * Kiểm nội dung đã sinh.
 * @returns {{violations:Array, warnings:string[], passed:boolean, checked:string[]}}
 */
export function checkContent(content, { evidenceText = '', strict = true } = {}) {
  const violations = [];
  const warnings = [];
  const checked = [];

  const flat = JSON.stringify(content || {}).toLowerCase();
  const evidence = String(evidenceText || '').toLowerCase();
  const evidenceNumbers = numbersIn(evidence);

  for (const rule of CLAIM_RULES) {
    checked.push(rule.id);
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
    const hits = [...flat.matchAll(re)].map((m) => m[0]).filter(Boolean);
    for (const hit of [...new Set(hits)]) {
      // Có trong bằng chứng (nguồn/vision) => hợp lệ.
      if (evidence.includes(hit.toLowerCase())) continue;

      // Với luật định lượng: nếu MỌI con số trong hit đều có trong bằng chứng thì bỏ qua.
      // (Trước đây chỉ áp cho 'capacity' — nay dùng cờ `numeric` để áp cho cả giá.)
      if (rule.numeric || rule.id === 'capacity' || rule.id === 'spec_unit') {
        const nums = numbersIn(hit);
        const allKnown = [...nums].every((n) => evidenceNumbers.has(n));
        if (allKnown && nums.size > 0) continue;
      }
      violations.push({
        rule: rule.id,
        label: rule.label,
        matched: sanitizeText(hit, { maxLength: 120 }),
        reason: `Nội dung khẳng định "${rule.label}" nhưng không có bằng chứng trong dữ liệu nguồn/ảnh.`,
      });
    }
  }

  // Kiểm cấu trúc tối thiểu
  const required = [
    'product_name',
    'headline',
    'short_description',
    'selling_points',
    'detailed_description',
    'facebook_caption',
    'tiktok_caption',
    'marketplace_description',
    'hashtags',
    'seo',
  ];
  for (const key of required) {
    const v = content?.[key];
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0) || v === '') {
      warnings.push(`Thiếu trường bắt buộc: ${key}`);
    }
  }
  if (content?.seo) {
    for (const k of ['title', 'meta_description', 'keywords']) {
      if (!content.seo[k] || (Array.isArray(content.seo[k]) && content.seo[k].length === 0)) {
        warnings.push(`Thiếu SEO.${k}`);
      }
    }
  }

  const passed = strict ? violations.length === 0 : violations.length === 0 || warnings.length === 0;

  return { violations, warnings, passed, checked };
}

/**
 * Loại bỏ câu chứa khẳng định không có bằng chứng.
 * Dùng khi `strict` bật và Owner muốn bản sạch thay vì bản bị cảnh báo.
 */
export function stripViolatingSentences(text, violations) {
  if (!text || !violations?.length) return text;
  const sentences = String(text).split(/(?<=[.!?…])\s+/);
  const kept = sentences.filter(
    (s) => !violations.some((v) => v.matched && s.toLowerCase().includes(v.matched.toLowerCase())),
  );
  return kept.join(' ');
}

export default checkContent;
