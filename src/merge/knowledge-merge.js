/**
 * G08 — PRODUCT KNOWLEDGE MERGE.
 *
 * Kết hợp ba nguồn thành "Vietnamese Product Master":
 *      connector data  +  vision analysis  +  Chinese source text
 *
 * THỨ TỰ ƯU TIÊN (bắt buộc, không được đảo):
 *   1. Dữ liệu TRỰC TIẾP từ nguồn (connector)   → provenance = 'source'
 *   2. Thông tin NHÌN THẤY RÕ từ ảnh (vision)   → provenance = 'vision'
 *   3. Suy luận của AI                          → provenance = 'inference'  (PHẢI đánh dấu)
 *
 * Luật bất khả xâm phạm: KHÔNG biến suy đoán thành fact. Mỗi giá trị trong
 * `knowledge.facts` đều mang `provenance`, và UI/report phải hiển thị nhãn đó.
 */

import { PROVENANCE } from '../product-master.js';
import { sanitizeText } from '../security/sanitize.js';

/** Tạo một "fact" có gắn nhãn nguồn gốc. */
export function fact(label, value, provenance, { confidence = 'high', note = '' } = {}) {
  return {
    label: sanitizeText(label, { maxLength: 200 }),
    value: sanitizeText(typeof value === 'string' ? value : JSON.stringify(value), { maxLength: 4000 }),
    provenance,
    confidence,
    note: sanitizeText(note, { maxLength: 500 }),
  };
}

const PROVENANCE_ORDER = {
  [PROVENANCE.SOURCE]: 0,
  [PROVENANCE.USER]: 0,
  [PROVENANCE.VISION]: 1,
  [PROVENANCE.INFERENCE]: 2,
};

/**
 * Gộp dữ liệu thành Vietnamese Product Master.
 *
 * @param {object} master        Product Master từ connector (G06)
 * @param {object|null} vision   Kết quả VisionProvider (G07)
 * @param {object} opts
 * @returns {object} knowledge
 */
export function mergeKnowledge(master, vision = null, { translation = null, warnings = [] } = {}) {
  const facts = [];
  const uncertain = [];
  const outWarnings = [...warnings];

  // ── 1. Dữ liệu trực tiếp từ nguồn (ưu tiên cao nhất) ──────────────────────
  if (master.title_original_status === 'FOUND' && master.title_original) {
    facts.push(fact('Tên sản phẩm (nguyên bản)', master.title_original, PROVENANCE.SOURCE));
  }
  if (translation?.title_vi) {
    facts.push(
      fact('Tên sản phẩm (dịch)', translation.title_vi, translation.provenance || PROVENANCE.INFERENCE, {
        confidence: translation.confidence || 'medium',
        note: 'Bản dịch do AI thực hiện từ tên gốc.',
      }),
    );
  }

  for (const a of master.attributes || []) {
    if (a.status !== 'FOUND') continue;
    facts.push(fact(a.name, a.value, a.provenance || PROVENANCE.SOURCE));
  }

  if (master.price?.status === 'FOUND' && master.price.raw) {
    const kindNote =
      master.price.kind === 'tier'
        ? `Giá theo bậc số lượng (${master.price.tiers?.length || 0} bậc) — KHÔNG phải giá cố định.`
        : master.price.kind === 'range'
          ? 'Giá hiển thị dạng KHOẢNG — không phải giá cố định.'
          : 'Giá hiển thị trên trang.';
    facts.push(fact('Giá hiển thị', `${master.price.raw} (${master.price.currency})`, PROVENANCE.SOURCE, { note: kindNote }));
    if (master.price.kind !== 'fixed') {
      uncertain.push(
        `Giá không phải dạng cố định (${master.price.kind}). Cần xác nhận giá bán thực tế trước khi đăng.`,
      );
    }
  }

  if (master.store?.name) {
    facts.push(fact('Nhà cung cấp / cửa hàng', master.store.name, PROVENANCE.SOURCE));
  }

  const variantCount = (master.variants || []).length;
  if (variantCount > 0) {
    facts.push(fact('Số biến thể / SKU', String(variantCount), PROVENANCE.SOURCE));
  }

  // ── 2. Thông tin nhìn thấy từ ảnh (ưu tiên sau) ───────────────────────────
  if (vision?.analysis) {
    const va = vision.analysis;
    if (va.product_type) {
      facts.push(
        fact('Loại sản phẩm (từ ảnh)', va.product_type, PROVENANCE.VISION, {
          confidence: 'medium',
          note: 'Suy ra từ hình ảnh, không phải dữ liệu sàn công bố.',
        }),
      );
    }
    for (const f of va.visible_features || []) {
      facts.push(fact('Đặc điểm nhìn thấy', f, PROVENANCE.VISION, { confidence: 'medium' }));
    }
    for (const t of va.visible_text || []) {
      facts.push(fact('Chữ trong ảnh', t, PROVENANCE.VISION, { confidence: 'medium' }));
    }
    for (const c of va.colors || []) {
      facts.push(fact('Màu nhìn thấy', c, PROVENANCE.VISION, { confidence: 'medium' }));
    }
    for (const u of va.likely_use_cases || []) {
      facts.push(fact('Công dụng suy đoán', u, PROVENANCE.INFERENCE, { confidence: 'low' }));
    }
    for (const uc of va.uncertain_claims || []) uncertain.push(uc);
  }

  // ── 3. Tổng hợp ───────────────────────────────────────────────────────────
  facts.sort((a, b) => (PROVENANCE_ORDER[a.provenance] ?? 9) - (PROVENANCE_ORDER[b.provenance] ?? 9));

  const knowledge = {
    product_type: vision?.analysis?.product_type || '',
    product_name_vi: translation?.title_vi || '',
    product_name_original: master.title_original || '',
    facts,
    visual_features: vision?.analysis?.visible_features || [],
    visual_text: vision?.analysis?.visible_text || [],
    colors: vision?.analysis?.colors || [],
    use_cases: vision?.analysis?.likely_use_cases || [],
    uncertain_claims: [...new Set(uncertain)],
    warnings: outWarnings,
    evidence: {
      source_title: Boolean(master.title_original),
      source_images: (master.images || []).filter((i) => i.status === 'FOUND').length,
      source_variants: variantCount,
      source_attributes: (master.attributes || []).filter((a) => a.status === 'FOUND').length,
      vision_used_images: vision?.used ?? 0,
      vision_provider: vision?.provider || '',
      vision_model: vision?.model || '',
    },
  };

  return knowledge;
}

/**
 * Sinh "nguồn sự thật" để Content Engine bám vào.
 * Đây là danh sách ĐÓNG: Content Engine không được sinh thêm fact ngoài danh sách này
 * cho các thuộc tính định lượng.
 */
export function buildFactSheet(master, knowledge) {
  const lines = [];
  const push = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    lines.push(`- ${label}: ${value}`);
  };

  push('Loại sản phẩm', knowledge.product_type);
  push('Tên gốc (tiếng Trung)', master.title_original);
  push('Tên tiếng Việt (nếu có)', knowledge.product_name_vi);

  const price = master.price?.status === 'FOUND' ? `${master.price.raw} ${master.price.currency}` : '';
  push('Giá hiển thị trên sàn', price ? `${price} (kiểu: ${master.price.kind})` : '');

  if ((master.attributes || []).length > 0) {
    const attrs = master.attributes
      .filter((a) => a.status === 'FOUND')
      .slice(0, 30)
      .map((a) => `${a.name}=${a.value}`)
      .join('; ');
    push('Thuộc tính từ sàn', attrs);
  }
  if ((master.variants || []).length > 0) {
    push('Biến thể', master.variants.slice(0, 20).map((v) => v.name).filter(Boolean).join('; '));
  }
  if ((knowledge.visual_features || []).length > 0) {
    push('Đặc điểm nhìn thấy trong ảnh', knowledge.visual_features.join('; '));
  }
  if ((knowledge.colors || []).length > 0) push('Màu sắc', knowledge.colors.join(', '));
  if ((knowledge.visual_text || []).length > 0) {
    push('Chữ đọc được trong ảnh', knowledge.visual_text.slice(0, 20).join(' | '));
  }

  lines.push(
    '- LƯU Ý: TUYỆT ĐỐI không thêm thông số kỹ thuật, chất liệu, công suất, dung lượng, chứng nhận, bảo hành, xuất xứ hoặc giá nào KHÁC ngoài danh sách trên.',
  );

  return lines.join('\n');
}

export default mergeKnowledge;
