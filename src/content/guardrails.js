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
    re: /bảo hành\s*(?:\d+|\d+\s*(?:năm|tháng|ngày))|cam kết bảo hành|\b\d+\s*năm bảo hành/gi,
  },
  {
    id: 'certification',
    label: 'chứng nhận',
    re: /\b(?:chứng nhận|đạt chuẩn|tiêu chuẩn)\s*(?:ISO|CE|FDA|RoHS|FCC|GMP|HACCP)\b|\b(?:ISO|CE|FDA|RoHS|FCC)\s*\d*/gi,
  },
  {
    id: 'waterproof',
    label: 'chống nước',
    re: /chống nước|kháng nước|ngâm nước|waterproof|\bIP\d{2}\b/gi,
  },
  {
    id: 'capacity',
    label: 'dung tích/công suất',
    re: /\b\d+(?:[.,]\d+)?\s*(?:ml|l|L|mAh|W|kW|V|Hz|inch|cm|mm|kg|g)\b/g,
  },
  {
    id: 'material',
    label: 'chất liệu',
    re: /da thật|da bò|100%\s*cotton|nhôm nguyên khối|thép không gỉ|inox|titan|gốm sứ cao cấp/gi,
  },
  {
    id: 'origin',
    label: 'nguồn gốc',
    re: /xuất xứ|nguồn gốc|made in|sản xuất tại|nhập khẩu (?:từ|nguyên chiếc)/gi,
  },
  {
    id: 'price_claim',
    label: 'giá/khuyến mãi',
    re: /giảm giá\s*\d+%|giảm\s*\d+%|freeship|miễn phí vận chuyển|tặng kèm|quà tặng|số lượng có hạn|chỉ còn\s*\d+/gi,
  },
  {
    id: 'rating',
    label: 'số liệu xã hội',
    re: /\b\d{2,}(?:[.,]\d+)?\s*(?:khách hàng|người mua|đánh giá|review|sao)\b|\b\d+(?:[.,]\d+)?\/5\b/gi,
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
