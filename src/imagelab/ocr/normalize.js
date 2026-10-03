/**
 * C1 — Chuẩn hoá vùng OCR thô thành `Region` đúng hợp đồng 3.2 (MVP-02).
 *
 * Nhiệm vụ: biến dữ liệu "bẩn" của provider (hộp ngoài biên, toạ độ lẻ, vùng rỗng,
 * vùng trùng, quá nhiều vùng…) thành danh sách Region an toàn để C4 lưu DB và C5
 * hiển thị — và **không bao giờ ném lỗi vì dữ liệu bẩn**.
 *
 * Nguyên tắc fail-closed: mọi vùng bị bỏ đều phải để lại vết trong `dropped` kèm lý
 * do tiếng Việt (luật 4 — không fail im lặng).
 */

import { sanitizeText } from '../../security/sanitize.js';
import { boxesIntersect, intersectBoxWithImage } from '../geometry.js';
import {
  REGION_KINDS,
  PROTECTION_RANK,
  classifyRegion,
  containsCjk,
  dedupePriority,
  reasonForKind,
} from './classify.js';

/** Ngôn ngữ được phép theo hợp đồng 3.2. Giá trị lạ → coi như không khai. */
const ALLOWED_LANGS = Object.freeze(['zh', 'zh-Hans', 'zh-Hant', 'und']);

/** Độ dài tối đa của text một vùng (chữ trên ảnh sản phẩm không thể dài hơn). */
const MAX_TEXT_LENGTH = 2000;

/** Làm tròn 6 chữ số thập phân theo hợp đồng 3.2 (`box_normalized`). */
const round6 = (n) => Number(n.toFixed(6));

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/** Lấy một trường số từ object thô; trả null nếu không phải số hữu hạn. */
function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Trích hộp bao từ một vùng thô. Chấp nhận các dạng phổ biến của adapter OCR:
 *  - `{ box: { x, y, w, h } }`   (dạng chuẩn của hợp đồng)
 *  - `{ bbox: [x, y, w, h] }`    (nhiều OCR engine dùng mảng)
 *  - `{ bbox: { x, y, w, h } }`
 *  - `{ x, y, w, h }`            (phẳng)
 *  - `{ x1, y1, x2, y2 }`        (góc đối diện)
 *
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
function extractBox(raw) {
  let x = null;
  let y = null;
  let w = null;
  let h = null;

  const src = raw.box && typeof raw.box === 'object' ? raw.box : null;
  if (src) {
    x = num(src.x);
    y = num(src.y);
    w = num(src.w ?? src.width);
    h = num(src.h ?? src.height);
  } else if (Array.isArray(raw.bbox) && raw.bbox.length >= 4) {
    x = num(raw.bbox[0]);
    y = num(raw.bbox[1]);
    w = num(raw.bbox[2]);
    h = num(raw.bbox[3]);
  } else if (raw.bbox && typeof raw.bbox === 'object') {
    x = num(raw.bbox.x);
    y = num(raw.bbox.y);
    w = num(raw.bbox.w ?? raw.bbox.width);
    h = num(raw.bbox.h ?? raw.bbox.height);
  } else if (raw.x1 !== undefined && raw.y1 !== undefined && raw.x2 !== undefined && raw.y2 !== undefined) {
    const x1 = num(raw.x1);
    const y1 = num(raw.y1);
    const x2 = num(raw.x2);
    const y2 = num(raw.y2);
    if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
      x = Math.min(x1, x2);
      y = Math.min(y1, y2);
      // +1 vì toạ độ góc là inclusive; đây là quy ước của chính input, không phải suy diễn.
      w = Math.abs(x2 - x1) + 1;
      h = Math.abs(y2 - y1) + 1;
    }
  } else {
    x = num(raw.x);
    y = num(raw.y);
    w = num(raw.w ?? raw.width);
    h = num(raw.h ?? raw.height);
  }

  if (x === null || y === null || w === null || h === null) return null;
  return { x, y, w, h };
}

/** Một mục `dropped` theo hợp đồng: `{ reason, text? }` — không thêm field khác. */
function dropEntry(reason, text) {
  const clean = typeof text === 'string' ? text : '';
  return clean ? { reason, text: clean.slice(0, 200) } : { reason };
}

/**
 * Chuẩn hoá danh sách vùng thô.
 *
 * @param {Array<object>} rawRegions vùng do provider trả về (có thể bẩn/không phải mảng)
 * @param {{width?:number,height?:number,maxRegions?:number,minConfidence?:number}} [options]
 * @returns {{regions: object[], dropped: {reason:string,text?:string}[], warnings: string[]}}
 */
export function normalizeRegions(rawRegions, { width, height, maxRegions, minConfidence } = {}) {
  const dropped = [];
  const warnings = [];
  const raw = Array.isArray(rawRegions) ? rawRegions : [];

  if (!Array.isArray(rawRegions)) {
    warnings.push('Danh sách vùng OCR không phải mảng — coi như không có vùng nào.');
  }

  const W = num(width);
  const H = num(height);
  const dimsOk = W !== null && H !== null && W > 0 && H > 0;

  const minConf = isFiniteNumber(num(minConfidence)) ? num(minConfidence) : 0;
  const capNum = num(maxRegions);
  const cap = capNum !== null && capNum > 0 ? Math.trunc(capNum) : Infinity;

  // Không có kích thước ảnh ⇒ không thể clamp hộp, cũng không thể tính box_normalized.
  // KHÔNG ném lỗi (yêu cầu hợp đồng): bỏ toàn bộ vùng kèm lý do.
  if (!dimsOk) {
    for (const r of raw) {
      dropped.push(
        dropEntry(
          'ảnh không có kích thước hợp lệ (width/height thiếu, bằng 0 hoặc âm) — không thể quy đổi toạ độ',
          r && typeof r === 'object' ? sanitizeText(r.text, { maxLength: 200 }) : '',
        ),
      );
    }
    if (raw.length > 0) {
      warnings.push('Ảnh không có kích thước hợp lệ: đã bỏ toàn bộ vùng OCR.');
    }
    return { regions: [], dropped, warnings };
  }

  // Khử trùng theo HỘP (bổ sung sau phản biện F-01):
  //  - cùng hộp + cùng chữ  → bỏ vùng đến sau (như cũ);
  //  - cùng hộp + KHÁC chữ  → giữ vùng "hạn chế nhất" (brand|certification|price >
  //    unknown > descriptive), vùng còn lại vào `dropped` kèm lý do. Nếu không xử lý,
  //    một vùng `descriptive` có thể chiếm đúng hộp của vùng `brand` và op của nó sẽ
  //    xoá sạch nhãn hiệu (đúng ca CRITICAL mà phản biện dựng được).
  const boxSlot = new Map();
  const kept = [];
  let outOfRangeConfidence = 0;

  raw.forEach((r, index) => {
    if (!r || typeof r !== 'object') {
      dropped.push(dropEntry('vùng không phải object'));
      return;
    }

    const text = sanitizeText(r.text, { maxLength: MAX_TEXT_LENGTH });
    if (!text) {
      dropped.push(dropEntry('vùng rỗng hoặc chỉ có khoảng trắng', text));
      return;
    }

    const box = extractBox(r);
    if (!box) {
      dropped.push(dropEntry('thiếu hoặc sai kiểu hộp bao (box/bbox)', text));
      return;
    }
    if (!(box.w > 0) || !(box.h > 0)) {
      dropped.push(dropEntry('hộp có kích thước w<=0 hoặc h<=0', text));
      return;
    }

    // Kẹp vào biên ảnh = GIAO của hộp với khung ảnh (H-1: phải cắt bớt w/h, KHÔNG được
    // dời gốc rồi giữ nguyên kích thước — làm vậy hộp bị nới rộng và chặn oan vùng khác).
    // Toạ độ là số nguyên (trunc) như trước; hàm dùng chung với pipeline/render.
    const box_ = intersectBoxWithImage(
      {
        x: Math.trunc(box.x),
        y: Math.trunc(box.y),
        w: Math.trunc(box.w),
        h: Math.trunc(box.h),
      },
      W,
      H,
    );
    if (!box_) {
      dropped.push(dropEntry('hộp nằm ngoài biên ảnh sau khi cắt (không còn diện tích)', text));
      return;
    }
    const { x, y, w, h } = box_;

    // Độ tin cậy: chỉ nhận 0..1. Giá trị ngoài khoảng bị kẹp (KHÔNG đoán thang 0-100).
    const confRaw = num(r.confidence);
    let confidence = 0;
    if (confRaw !== null) {
      confidence = clamp(confRaw, 0, 1);
      if (confRaw < 0 || confRaw > 1) outOfRangeConfidence += 1;
    }
    if (confidence < minConf) {
      dropped.push(dropEntry(`độ tin cậy ${confidence} thấp hơn ngưỡng ${minConf}`, text));
      return;
    }

    // Phân loại: tự phân loại trước, rồi hợp nhất với kind provider khai — chỉ leo thang.
    const auto = classifyRegion(text);
    const providedKind = REGION_KINDS.includes(r.kind) ? r.kind : null;
    let kind = auto.kind;
    let kindReason = auto.kind_reason;
    if (providedKind && providedKind !== auto.kind) {
      const providedRank = PROTECTION_RANK[providedKind] ?? 0;
      const autoRank = PROTECTION_RANK[auto.kind] ?? 0;
      if (providedRank >= autoRank) {
        kind = providedKind;
        kindReason = sanitizeText(r.kind_reason, { maxLength: 300 }) || reasonForKind(providedKind);
      }
      // else: giữ auto (leo thang bảo vệ — provider không được phép hạ cấp).
    }

    // Trùng HỘP (sau khi đã clamp): xử lý theo mức bảo vệ của `kind`.
    const boxKey = `${x},${y},${w},${h}`;
    const existing = boxSlot.get(boxKey);
    if (existing) {
      if (existing.text === text) {
        dropped.push(dropEntry('trùng khít vùng đã có (cùng chữ và cùng hộp)', text));
        return;
      }
      const newPriority = dedupePriority(kind);
      const oldPriority = dedupePriority(existing.kind);
      if (newPriority > oldPriority) {
        // Vùng mới hạn chế hơn ⇒ bỏ vùng cũ, giữ vùng mới.
        existing.dropped = true;
        dropped.push(
          dropEntry(
            `trùng hộp nhưng khác chữ — bỏ vùng này vì vùng mới có mức bảo vệ cao hơn (${kind} > ${existing.kind})`,
            existing.text,
          ),
        );
      } else {
        dropped.push(
          dropEntry(
            `trùng hộp nhưng khác chữ — bỏ vùng này vì vùng đã giữ có mức bảo vệ cao hơn hoặc bằng (${existing.kind} ≥ ${kind})`,
            text,
          ),
        );
        return;
      }
    }

    const providedLang = typeof r.lang === 'string' ? r.lang.trim() : '';
    const lang = ALLOWED_LANGS.includes(providedLang)
      ? providedLang
      : containsCjk(text)
        ? 'zh'
        : 'und';

    const entry = {
      index,
      x,
      y,
      w,
      h,
      text,
      lang,
      confidence,
      kind,
      kind_reason: kindReason,
      source: r.source === 'user' ? 'user' : 'ocr',
      dropped: false,
    };
    kept.push(entry);
    boxSlot.set(boxKey, entry);
  });

  if (outOfRangeConfidence > 0) {
    warnings.push(
      `Có ${outOfRangeConfidence} vùng khai độ tin cậy ngoài khoảng 0..1 — đã kẹp về 0..1 (không đoán thang điểm).`,
    );
  }

  // Thứ tự đọc: trên → dưới, trái → phải (hoà thì giữ nguyên thứ tự gốc).
  // Vùng đã bị vùng khác "chiếm hộp" (mức bảo vệ thấp hơn) không được giữ lại.
  const survivors = kept.filter((r) => r.dropped !== true);
  const ordered = survivors.sort((a, b) => a.y - b.y || a.x - b.x || a.index - b.index);

  const limited = Number.isFinite(cap) ? ordered.slice(0, cap) : ordered;
  for (const extra of Number.isFinite(cap) ? ordered.slice(cap) : []) {
    dropped.push(
      dropEntry(`vượt giới hạn ${cap} vùng mỗi ảnh — cắt bớt theo thứ tự đọc`, extra.text),
    );
  }

  const regions = limited.map((r, i) => ({
    id: `r${i + 1}`,
    box: { x: r.x, y: r.y, w: r.w, h: r.h },
    box_normalized: {
      x: round6(r.x / W),
      y: round6(r.y / H),
      w: round6(r.w / W),
      h: round6(r.h / H),
    },
    text: r.text,
    lang: r.lang,
    confidence: r.confidence,
    kind: r.kind,
    kind_reason: r.kind_reason,
    translatable: r.kind === 'descriptive',
    source: r.source,
  }));

  if (dropped.length > 0) {
    warnings.push(`Đã bỏ ${dropped.length} vùng OCR không dùng được (lý do nằm trong "dropped").`);
  }

  // Cảnh báo hộp GIAO NHAU (bổ sung sau phản biện F-01): hộp chồng lấn là dấu hiệu
  // dữ liệu OCR có vấn đề, và là đường vào của lỗi "op vùng mô tả xoá pixel nhãn hiệu".
  // Pipeline đã chặn cứng ở tầng dựng op, nhưng người vận hành vẫn phải được biết.
  const overlaps = [];
  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      if (boxesIntersect(regions[i].box, regions[j].box)) {
        overlaps.push(`${regions[i].id} (${regions[i].kind}) × ${regions[j].id} (${regions[j].kind})`);
      }
    }
  }
  if (overlaps.length > 0) {
    const shown = overlaps.slice(0, 5).join('; ');
    warnings.push(
      `Có ${overlaps.length} cặp hộp vùng OCR giao nhau — dữ liệu OCR có vấn đề: ${shown}${
        overlaps.length > 5 ? `; … còn ${overlaps.length - 5} cặp nữa` : ''
      }. Vùng giao với nhãn hiệu/chứng nhận/giá sẽ KHÔNG được xoá/vẽ đè (luật #3).`,
    );
  }

  return { regions, dropped, warnings };
}

export default normalizeRegions;
