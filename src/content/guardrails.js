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

/** Nhóm khẳng định bị soi. `allowIfEvidence` = true nghĩa là có bằng chứng thì cho qua. */
export const CLAIM_RULES = [
  {
    id: 'warranty',
    label: 'bảo hành',
    // Gồm cả cách viết tắt và cách nói vòng: "BH 12 tháng", "bảo đảm 1 năm", "đổi trả 12 tháng".
    re: /(?:\bbh\b|bảo hành|bảo đảm|bảo trì|đổi trả|hoàn tiền|1\s*đổi\s*1)\s*(?:trong\s*)?(?:\d+|\d+\s*(?:năm|tháng|ngày))?|cam kết bảo hành|\b\d+\s*(?:năm|tháng)\s*bảo hành/gi,
  },
  {
    id: 'certification',
    label: 'chứng nhận',
    re: /\b(?:chứng nhận|đạt chuẩn|tiêu chuẩn|kiểm định|công bố)\s*(?:ISO|CE|FDA|RoHS|FCC|GMP|HACCP|IEC|TUV)?\b|\b(?:ISO|CE|FDA|RoHS|FCC|GMP|HACCP)\s*\d*/gi,
  },
  {
    id: 'waterproof',
    label: 'chống nước',
    // "ngâm nước", "đi mưa", "kháng ẩm" là những cách nói vòng phổ biến của tiếng Việt.
    re: /chống nước|kháng nước|ngâm nước|không thấm nước|waterproof|đi mưa|kháng ẩm|chống ẩm|\bIP\d{2}\b/gi,
  },
  {
    id: 'spec_unit',
    label: 'đơn vị thông số',
    // Đơn vị kỹ thuật gần như không xuất hiện trong văn bản bán hàng thường — thấy là nghi ngay.
    re: /\b\d+(?:[.,]\d+)?\s*(?:mAh|kWh|kW|W|V|Hz|inch|ml|kg|mm|cm|lít|L)\b|\b(?:mAh|kWh|IP\d{2}|Hz)\b/gi,
  },
  {
    id: 'capacity',
    label: 'dung tích/công suất',
    re: /\b\d+(?:[.,]\d+)?\s*(?:ml|l|L|mAh|W|kW|V|Hz|inch|cm|mm|kg|g|lít)\b/gi,
  },
  {
    id: 'material',
    label: 'chất liệu',
    re: /da thật|da bò|da cá sấu|cotton|nhôm nguyên khối|thép không gỉ|inox|titan|gốm sứ|cao su|silicon|nhựa ABS|gỗ tự nhiên|carbon/gi,
  },
  {
    id: 'origin',
    label: 'nguồn gốc',
    re: /xuất xứ|nguồn gốc|made in|sản xuất tại|nhập khẩu|nội địa|chính hãng|hàng chính hãng/gi,
  },
  {
    id: 'price_claim',
    label: 'giá/khuyến mãi',
    re: /\b(?:sale|giảm giá|giảm|ưu đãi|khuyến mãi|voucher|mã giảm)\s*(?:đến\s*)?\d+\s*%|\b\d+\s*%\s*(?:off|giảm)?|freeship|miễn phí (?:vận chuyển|giao hàng|ship)|tặng kèm|quà tặng|số lượng có hạn|chỉ còn\s*\d+|nhanh tay/gi,
  },
  {
    id: 'rating',
    label: 'số liệu xã hội',
    // "nghìn người mua", "4.9 sao", "1000+ review" — kể cả khi không ghi chữ "đánh giá".
    re: /\b\d+(?:[.,]\d+)?\s*(?:k|nghìn|ngàn|trăm|triệu)?\+?\s*(?:khách hàng|người mua|người dùng|đánh giá|review|sao|lượt mua|lượt bán)\b|\b\d+(?:[.,]\d+)?\s*\/\s*5\b|\bđược đánh giá\b|\btin dùng\b|\bbán chạy\b/gi,
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

  for (const f of knowledge?.facts || []) push(f.value);
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

      // Với rule định lượng: nếu con số trong hit xuất hiện trong bằng chứng thì bỏ qua.
      if (rule.id === 'capacity') {
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
