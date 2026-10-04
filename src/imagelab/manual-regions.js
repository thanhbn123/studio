/**
 * IL-08 — VÙNG CHỮ DO NGƯỜI DÙNG NHẬP TAY (manual OCR fallback) — hợp đồng §11.
 *
 * Vì sao có file này: với `OCR_PROVIDER=mock` (mặc định), vùng chữ trả về là fixture cố
 * định, KHÔNG liên quan tới ảnh người dùng dán vào — nên trên ảnh THẬT tính năng không
 * dùng được. Đường nhập tay gỡ đúng điểm chết đó: "OCR không được là điểm chết duy nhất".
 *
 * Nguyên tắc của file (giống `ocr/normalize.js`):
 *  - HÀM THUẦN: không đọc file, không gọi mạng, không chạm DB ⇒ dễ test.
 *  - KHÔNG BAO GIỜ ném lỗi vì dữ liệu bẩn: mọi vùng bị bỏ đều để lại vết trong `rejected`
 *    kèm `index` (vị trí trong mảng client gửi) + `code` máy đọc được + câu tiếng Việt.
 *  - KHÔNG tự viết lại luật hình học: dùng `strictCoordinate` + `intersectBoxWithImage`
 *    của `geometry.js` (một chỗ duy nhất cho luật kẹp hộp).
 *  - Bất biến của hợp đồng 3.2: `translatable === (kind === 'descriptive')`.
 */

import { sanitizeText } from '../security/sanitize.js';
import { intersectBoxWithImage, strictCoordinate } from './geometry.js';
import { REGION_KINDS, classifyRegion, containsCjk, dedupePriority, reasonForKind } from './ocr/classify.js';

/**
 * IL08-06 (vòng 7) — VẾT HẠ MỨC bảo vệ phải BỀN và ĐỌC LẠI ĐƯỢC.
 *
 * Vì sao: `kind_downgraded`/`kind_declared_by_user` chỉ sống trong mảng in-memory của hàm
 * thuần ⇒ lần lưu sau là mất, và vùng trong DB đọc lên như thể MÁY phân loại (dù máy đã nói
 * `price`). Vết được ghi vào CHÍNH bản ghi vùng qua `kind_reason` (bền, không cần đổi schema)
 * và vào `content_meta.imagelab.manual.kind_downgrades` (có cấu trúc, đọc lại được).
 */
export const KIND_DOWNGRADE_MARK = '[NGƯỜI DÙNG HẠ MỨC từ';

/** Câu vết gắn vào `kind_reason` của vùng bị hạ mức. */
export function kindDowngradeNote(classifiedByMachine) {
  return `${KIND_DOWNGRADE_MARK} ${classifiedByMachine}]`;
}

/**
 * Đọc vết hạ mức từ `kind_reason` đã lưu.
 * @returns {{downgraded: true, classified_by_machine: string}|null}
 */
export function parseKindDowngrade(kindReason) {
  const text = String(kindReason ?? '');
  const i = text.indexOf(KIND_DOWNGRADE_MARK);
  if (i < 0) return null;
  const rest = text.slice(i + KIND_DOWNGRADE_MARK.length);
  const m = /^\s*([A-Za-z_]+)\s*\]/.exec(rest);
  return { downgraded: true, classified_by_machine: m ? m[1].toLowerCase() : 'unknown' };
}

/**
 * Trang trí một `Region` (đã đọc từ DB) bằng vết hạ mức — dùng CHUNG cho PUT và GET
 * (cả hai đều đi qua `regionJson` của C5) nên không có chỗ nào quên.
 */
export function withKindDowngradeTrace(region) {
  if (!region || typeof region !== 'object') return region;
  const trace = parseKindDowngrade(region.kind_reason);
  if (!trace) return region;
  return {
    ...region,
    kind_downgraded: true,
    kind_declared_by_user: region.kind || null,
    kind_classified_by_machine: trace.classified_by_machine,
  };
}

/** Tiền tố id do server gán (§11.2 luật 5): `u1..uN`. */
export const MANUAL_ID_PREFIX = 'u';

/** Trần ký tự của một vùng chữ (§11.2 luật 1). */
export const MANUAL_MAX_TEXT_LENGTH = 500;

/** Độ tin cậy mặc định: người dùng tự nhập, KHÔNG phải máy đoán (§11.2 luật 4). */
export const MANUAL_DEFAULT_CONFIDENCE = 1;

/** Id do client gửi chỉ được giữ khi an toàn cho DB/render (giống `REGION_ID_RE` của C5). */
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Mã lý do bỏ vùng — hợp đồng §11.2 luật 10. `reason` trả về có dạng
 * `"<CODE>: <câu tiếng Việt>"` (theo đúng lệ đã dùng ở `render` với `BOX_OVERLAPS_PROTECTED`)
 * để UI hiện được câu tiếng Việt mà máy vẫn grep được mã.
 */
export const MANUAL_REJECT_CODES = Object.freeze({
  NOT_OBJECT: 'NOT_OBJECT',
  TEXT_EMPTY: 'TEXT_EMPTY',
  BAD_BOX: 'BAD_BOX',
  BOX_OUTSIDE_IMAGE: 'BOX_OUTSIDE_IMAGE',
  TOO_MANY_REGIONS: 'TOO_MANY_REGIONS',
  NO_IMAGE_SIZE: 'NO_IMAGE_SIZE',
});

/** Làm tròn 6 chữ số thập phân theo hợp đồng 3.2 (`box_normalized`). */
const round6 = (n) => Number(n.toFixed(6));

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** Id client gửi chỉ được giữ khi là chuỗi an toàn; mọi thứ khác coi như không khai. */
function safeId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return SAFE_ID_RE.test(id) ? id : null;
}

/**
 * Chuẩn hoá danh sách vùng chữ do người dùng nhập thành `Region` (hợp đồng 3.2).
 *
 * @param {Array<object>} input vùng thô từ client: `{ id?, box:{x,y,w,h}, text, kind?, confidence? }`
 * @param {object} [options]
 * @param {number} [options.width]  chiều rộng ẢNH GỐC (pixel) — thiếu/không hợp lệ ⇒ bỏ toàn bộ vùng
 * @param {number} [options.height] chiều cao ẢNH GỐC (pixel)
 * @param {number|null} [options.maxRegions] trần số vùng ĐƯỢC NHẬN; phần vượt ⇒ `TOO_MANY_REGIONS`.
 *        `undefined`/`null` = không giới hạn (KHÁC `0` = không còn chỗ cho vùng nào).
 * @param {string} [options.idPrefix] tiền tố id server gán (mặc định `u`)
 * @param {Array<string>} [options.usedIds] id ĐÃ DÙNG ở nơi khác (chế độ ghi thêm, §11.2 luật 6)
 *        — bổ sung của C-A để id mới không đụng id cũ; mặc định rỗng.
 * @returns {{regions: object[], rejected: {index:number, code:string, reason:string, text?:string}[], warnings: string[]}}
 */
export function normalizeManualRegions(input, { width, height, maxRegions, idPrefix = MANUAL_ID_PREFIX, usedIds } = {}) {
  const list = Array.isArray(input) ? input : [];
  /** @type {{index:number, code:string, reason:string, text?:string}[]} */
  const rejected = [];
  const warnings = [];

  if (!Array.isArray(input)) {
    warnings.push('Danh sách vùng nhập tay không phải mảng — coi như không có vùng nào.');
  }

  /** Ghi vết một vùng bị bỏ: index trong mảng GỐC + mã + câu tiếng Việt (không im lặng). */
  const reject = (index, code, message, text) => {
    const entry = { index, code, reason: `${code}: ${message}` };
    const clean = typeof text === 'string' ? text : '';
    if (clean) entry.text = clean.slice(0, 200);
    rejected.push(entry);
  };

  const W = strictCoordinate(width);
  const H = strictCoordinate(height);
  const dimsOk = W !== null && H !== null && W > 0 && H > 0;

  // `maxRegions` đọc NGHIÊM NGẶT: `null`/`undefined`/`''` = không giới hạn, `0` = hết chỗ.
  const capRaw = strictCoordinate(maxRegions);
  const cap = capRaw === null ? null : Math.max(0, Math.trunc(capRaw));

  // Không có kích thước ảnh ⇒ không kẹp được hộp vào khung ảnh (luật 11.2 số 2) và cũng
  // không tính được `box_normalized`. Fail-closed: bỏ TOÀN BỘ vùng kèm lý do, không đoán.
  if (!dimsOk) {
    for (let index = 0; index < list.length; index += 1) {
      const raw = list[index];
      const text = raw && typeof raw === 'object' ? sanitizeText(raw.text, { maxLength: MANUAL_MAX_TEXT_LENGTH }) : '';
      reject(index, MANUAL_REJECT_CODES.NO_IMAGE_SIZE, 'ảnh gốc không có kích thước hợp lệ (width/height thiếu, bằng 0 hoặc âm) — không thể kẹp hộp vào khung ảnh', text);
    }
    if (list.length > 0) {
      warnings.push('Ảnh gốc không có kích thước hợp lệ: đã bỏ toàn bộ vùng nhập tay.');
    }
    return { regions: [], rejected, warnings };
  }

  // Tập id đã dùng: id cũ của job (ghi thêm) + id client gửi + id server gán.
  const used = new Set();
  for (const value of Array.isArray(usedIds) ? usedIds : []) {
    const id = safeId(typeof value === 'string' ? value : String(value ?? ''));
    if (id) used.add(id);
  }

  const prefix = typeof idPrefix === 'string' && idPrefix.trim() ? idPrefix.trim() : MANUAL_ID_PREFIX;
  let seq = 1;
  /** Sinh id kế tiếp chưa bị chiếm — id nhập tay phải TIẾP TỤC dãy `u…`, không đụng id cũ. */
  const nextId = () => {
    let id = `${prefix}${seq}`;
    while (used.has(id)) {
      seq += 1;
      id = `${prefix}${seq}`;
    }
    seq += 1;
    used.add(id);
    return id;
  };

  const regions = [];

  list.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      reject(index, MANUAL_REJECT_CODES.NOT_OBJECT, 'vùng không phải object (cần { box, text })');
      return;
    }

    // ── text (bắt buộc) ───────────────────────────────────────────────────
    const rawText = raw.text;
    const scalarText = typeof rawText === 'string' || typeof rawText === 'number';
    const text = scalarText ? sanitizeText(rawText, { maxLength: MANUAL_MAX_TEXT_LENGTH }) : '';
    if (!text) {
      reject(index, MANUAL_REJECT_CODES.TEXT_EMPTY, 'thiếu chữ hoặc chữ rỗng sau khi làm sạch (không có gì để dịch)');
      return;
    }

    // ── box (bắt buộc, 4 số hữu hạn) ──────────────────────────────────────
    const rawBox = raw.box && typeof raw.box === 'object' && !Array.isArray(raw.box) ? raw.box : null;
    if (!rawBox) {
      reject(index, MANUAL_REJECT_CODES.BAD_BOX, 'thiếu hoặc sai định dạng hộp bao `box` (cần { x, y, w, h })', text);
      return;
    }
    const x = strictCoordinate(rawBox.x);
    const y = strictCoordinate(rawBox.y);
    const w = strictCoordinate(rawBox.w ?? rawBox.width);
    const h = strictCoordinate(rawBox.h ?? rawBox.height);
    if (x === null || y === null || w === null || h === null) {
      reject(index, MANUAL_REJECT_CODES.BAD_BOX, 'toạ độ hộp phải là 4 số hữu hạn (x, y, w, h) — NULL/rác KHÔNG được coi là 0', text);
      return;
    }
    if (!(w > 0) || !(h > 0)) {
      reject(index, MANUAL_REJECT_CODES.BAD_BOX, 'hộp có w <= 0 hoặc h <= 0 (không có diện tích)', text);
      return;
    }

    // Hộp pixel là số nguyên (hợp đồng 3.2) — làm tròn TRƯỚC khi giao với khung ảnh để
    // hộp lưu xuống DB đúng bằng hộp sẽ dùng khi render.
    const rx = Math.round(x);
    const ry = Math.round(y);
    const rw = Math.round(w);
    const rh = Math.round(h);
    if (!(rw > 0) || !(rh > 0)) {
      reject(index, MANUAL_REJECT_CODES.BAD_BOX, 'hộp nhỏ hơn 1 pixel sau khi làm tròn toạ độ', text);
      return;
    }

    // Luật kẹp hộp nằm ở MỘT chỗ: `intersectBoxWithImage` (giao của hộp với khung ảnh).
    const box = intersectBoxWithImage({ x: rx, y: ry, w: rw, h: rh }, W, H);
    if (!box) {
      reject(index, MANUAL_REJECT_CODES.BOX_OUTSIDE_IMAGE, 'hộp nằm ngoài khung ảnh (giao rỗng sau khi cắt)', text);
      return;
    }
    if (box.x !== rx || box.y !== ry || box.w !== rw || box.h !== rh) {
      // Luật 11.2 số 2: hộp bị cắt thì GHI LẠI hộp ĐÃ CẮT — và nói ra, không im lặng.
      warnings.push(
        `Vùng #${index + 1} bị cắt vào biên ảnh: hộp ${rx},${ry} ${rw}×${rh} → ${box.x},${box.y} ${box.w}×${box.h}.`,
      );
    }

    // ── trần số vùng ──────────────────────────────────────────────────────
    // Đếm theo số vùng ĐƯỢC NHẬN (vùng rác ở trên không chiếm chỗ): phần vượt trần vẫn
    // vào `rejected` với lý do rõ ràng, KHÔNG cắt im lặng.
    if (cap !== null && regions.length >= cap) {
      reject(index, MANUAL_REJECT_CODES.TOO_MANY_REGIONS, `vượt giới hạn ${cap} vùng được nhận cho lần nhập này`, text);
      return;
    }

    // ── kind (IL08-02, vòng 6) ────────────────────────────────────────────
    // LUÔN tự phân loại (`classifyRegion`) rồi hợp nhất với kind client khai theo luật
    // CHỈ LEO THANG BẢO VỆ — đúng như `ocr/normalize.js` của đường OCR. Trước đây client
    // khai `descriptive` cho chữ mà máy phân loại là `price`/`brand`/`certification` thì
    // hệ thống TIN LỜI KHAI ⇒ dịch + xoá pixel vùng lẽ ra bị luật #3 khoá (lách luật).
    //
    // Muốn hạ mức THẬT thì phải gửi `allow_kind_downgrade: true` cho TỪNG vùng; khi đó
    // mới dùng kind client khai và BẮT BUỘC để lại vết (`kind_downgraded` +
    // `kind_declared_by_user` + warning nổi bật) — không có cờ thì KHÔNG hạ.
    const declaredKind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : '';
    const declaredValid = REGION_KINDS.includes(declaredKind);
    const auto = classifyRegion(text);
    const allowDowngrade = raw.allow_kind_downgrade === true;
    let kind = auto.kind;
    let kindReason = auto.kind_reason;
    let kindDowngraded = false;
    let kindDeclaredByUser = null;
    if (declaredValid && declaredKind === auto.kind) {
      kind = declaredKind;
      kindReason = reasonForKind(kind);
    } else if (declaredValid && dedupePriority(declaredKind) >= dedupePriority(auto.kind)) {
      // Client khai mức bảo vệ CAO HƠN hoặc BẰNG ⇒ tôn trọng (không bao giờ hạ an toàn).
      kind = declaredKind;
      kindReason = reasonForKind(kind);
    } else if (declaredValid && allowDowngrade) {
      kind = declaredKind;
      // Vết BỀN nằm ngay trong `kind_reason` của bản ghi vùng (không chỉ trong mảng in-memory).
      kindReason = `${reasonForKind(kind)} ${kindDowngradeNote(auto.kind)}`;
      kindDowngraded = true;
      kindDeclaredByUser = declaredKind;
      warnings.push(
        `⚠️ Vùng #${index + 1}: người dùng HẠ MỨC bảo vệ từ "${auto.kind}" xuống "${declaredKind}" (allow_kind_downgrade = true) — vùng này sẽ được dịch/xoá như vùng mô tả; đã ghi vết.`,
      );
    } else if (declaredValid) {
      warnings.push(
        `Vùng #${index + 1}: client khai "${declaredKind}" nhưng máy phân loại là "${auto.kind}" — giữ mức BẢO VỆ CAO HƠN (${auto.kind}). Gửi allow_kind_downgrade = true nếu thật sự muốn hạ.`,
      );
    }
    // BẤT BIẾN của hợp đồng 3.2 — không nhánh nào được phá.
    const translatable = kind === 'descriptive';

    // ── confidence: mặc định 1 (người dùng tự nhập), clamp 0..1 ───────────
    const confRaw = strictCoordinate(raw.confidence);
    const confidence = confRaw === null ? MANUAL_DEFAULT_CONFIDENCE : clamp01(confRaw);

    // ── id: giữ id client gửi nếu an toàn VÀ chưa bị chiếm; còn lại server gán ──
    const wantedId = safeId(raw.id);
    let id;
    if (wantedId && !used.has(wantedId)) {
      id = wantedId;
      used.add(id);
    } else {
      if (wantedId) {
        warnings.push(`Vùng #${index + 1}: id "${wantedId}" đã được dùng — server gán id mới để không trùng.`);
      }
      id = nextId();
    }

    const entry = {
      id,
      box,
      box_normalized: {
        x: round6(box.x / W),
        y: round6(box.y / H),
        w: round6(box.w / W),
        h: round6(box.h / H),
      },
      text,
      lang: containsCjk(text) ? 'zh' : 'und',
      confidence,
      kind,
      kind_reason: kindReason,
      translatable,
      source: 'user',
      // IL08-02: vết CHỈ có khi người dùng thật sự hạ mức bảo vệ (có cờ từng vùng).
      ...(kindDowngraded
        ? { kind_downgraded: true, kind_declared_by_user: kindDeclaredByUser, kind_classified_by_machine: auto.kind }
        : {}),
    };
    regions.push(entry);
  });

  if (rejected.length > 0) {
    warnings.push(`Đã bỏ ${rejected.length} vùng nhập tay không dùng được (lý do nằm trong "rejected").`);
  }

  return { regions, rejected, warnings };
}

export default normalizeManualRegions;
