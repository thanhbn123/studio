/**
 * C2 — Trạng thái + hình dạng dòng đã dịch (TranslatedLine).
 *
 * ⚠️ Hợp đồng MVP-02 §3.3 ĐÓNG BĂNG: TranslatedLine có ĐÚNG 10 field, không thêm không bớt.
 * Mọi dòng do module này sinh ra chỉ có 10 field đó (C4 lưu DB, C5 hiển thị, test có thể so khít).
 */

/** Tám trạng thái hợp lệ — không được sinh ra giá trị nào khác. */
export const TRANSLATE_STATUS = Object.freeze({
  TRANSLATED: 'TRANSLATED',
  GLOSSARY: 'GLOSSARY',
  SKIPPED_BRAND: 'SKIPPED_BRAND',
  SKIPPED_CERTIFICATION: 'SKIPPED_CERTIFICATION',
  SKIPPED_PRICE: 'SKIPPED_PRICE',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  USER_EDITED: 'USER_EDITED',
  FAILED: 'FAILED',
});

export const TRANSLATE_STATUS_LIST = Object.freeze(Object.values(TRANSLATE_STATUS));

/** Các trạng thái "bỏ qua vì không được phép dịch". */
export const SKIPPED_STATUSES = Object.freeze([
  TRANSLATE_STATUS.SKIPPED_BRAND,
  TRANSLATE_STATUS.SKIPPED_CERTIFICATION,
  TRANSLATE_STATUS.SKIPPED_PRICE,
]);

/** Trạng thái dòng được phép render (C4 dùng để dựng RenderOp). */
export const RENDERABLE_STATUSES = Object.freeze([
  TRANSLATE_STATUS.TRANSLATED,
  TRANSLATE_STATUS.GLOSSARY,
  TRANSLATE_STATUS.USER_EDITED,
]);

/** Danh sách field ĐÓNG BĂNG của TranslatedLine (theo đúng thứ tự hợp đồng). */
export const LINE_FIELDS = Object.freeze([
  'region_id',
  'text_original',
  'text_vi',
  'status',
  'provenance',
  'confidence',
  'violations',
  'edited_by_user',
  'edited_at',
  'notes',
]);

/** Trần ký tự cho một dòng chữ Việt (khớp với ràng buộc của bảng duyệt). */
export const MAX_LINE_CHARS = 500;

/** Nguồn gốc bản dịch hợp lệ. */
export const PROVENANCE = Object.freeze({
  AI: 'ai',
  GLOSSARY: 'glossary',
  USER: 'user',
  NONE: 'none',
});

/** Lý do tiếng Việt cho từng loại vùng bị bỏ qua (hiện thẳng lên UI). */
export const SKIP_REASONS = Object.freeze({
  brand: 'Vùng được nhận diện là NHÃN HIỆU — không dịch để giữ nguyên thương hiệu trên ảnh.',
  certification: 'Vùng được nhận diện là CHỨNG NHẬN — không dịch để tránh sai lệch nội dung chứng nhận.',
  price: 'Vùng được nhận diện là GIÁ — không dịch (giá do người bán quyết định).',
  unknown: 'Không xác định được loại vùng — không dịch (fail-closed), cần người duyệt.',
});

/** Chuẩn hoá trạng thái: giá trị lạ ⇒ NEEDS_REVIEW (fail-closed), không bao giờ trả status ngoài hợp đồng. */
export function normalizeStatus(status) {
  const s = String(status ?? '');
  return TRANSLATE_STATUS_LIST.includes(s) ? s : TRANSLATE_STATUS.NEEDS_REVIEW;
}

/** Kẹp confidence vào 0..1; giá trị không phải số ⇒ fallback. */
export function clampConfidence(value, fallback = 0) {
  // null/undefined/'' nghĩa là "không có số liệu", KHÔNG phải 0 (Number(null) === 0).
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** Trạng thái bỏ qua theo `kind` của Region. */
export function skipStatusForKind(kind) {
  switch (String(kind ?? '').toLowerCase()) {
    case 'brand':
      return TRANSLATE_STATUS.SKIPPED_BRAND;
    case 'certification':
      return TRANSLATE_STATUS.SKIPPED_CERTIFICATION;
    case 'price':
      return TRANSLATE_STATUS.SKIPPED_PRICE;
    default:
      return TRANSLATE_STATUS.NEEDS_REVIEW;
  }
}

function regionIdOf(region) {
  const id = region?.id ?? region?.region_id ?? '';
  return id === null || id === undefined ? '' : String(id);
}

function textOf(region) {
  return String(region?.text ?? region?.text_original ?? '');
}

/**
 * Tạo TranslatedLine đủ 10 field.
 * Chỉ nhận patch thuộc LINE_FIELDS ⇒ không thể vô tình thêm field lạ vào dữ liệu đã đóng băng.
 */
export function createLine(region, patch = {}) {
  const base = {
    region_id: regionIdOf(region),
    text_original: textOf(region),
    text_vi: '',
    status: TRANSLATE_STATUS.NEEDS_REVIEW,
    provenance: PROVENANCE.NONE,
    confidence: clampConfidence(region?.confidence, 0),
    violations: [],
    edited_by_user: false,
    edited_at: null,
    notes: '',
  };
  return patchLine(base, patch);
}

/** Ghi đè một phần dòng, chỉ với các field hợp lệ. */
export function patchLine(line, patch = {}) {
  const next = { ...line };
  for (const key of LINE_FIELDS) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  next.status = normalizeStatus(next.status);
  next.confidence = clampConfidence(next.confidence, 0);
  next.violations = Array.isArray(next.violations) ? [...next.violations] : [];
  next.edited_by_user = next.edited_by_user === true;
  next.edited_at = next.edited_at ?? null;
  next.notes = next.notes === null || next.notes === undefined ? '' : String(next.notes);
  next.text_vi = next.text_vi === null || next.text_vi === undefined ? '' : String(next.text_vi);
  next.text_original = next.text_original === null || next.text_original === undefined ? '' : String(next.text_original);
  next.region_id = next.region_id === null || next.region_id === undefined ? '' : String(next.region_id);
  return next;
}

/**
 * Dòng cho vùng KHÔNG được phép dịch (nhãn hiệu / chứng nhận / giá / unknown).
 * Luật số 3: `text_vi = ''`, `provenance = 'none'`, và KHÔNG gọi AI.
 */
export function createSkippedLine(region, { status, notes } = {}) {
  const kind = String(region?.kind ?? 'unknown').toLowerCase();
  return createLine(region, {
    text_vi: '',
    status: normalizeStatus(status ?? skipStatusForKind(kind)),
    provenance: PROVENANCE.NONE,
    confidence: 0,
    violations: [],
    notes: notes ?? SKIP_REASONS[kind] ?? SKIP_REASONS.unknown,
  });
}

/** Dòng lỗi provider — `FAILED` + lý do nằm ở `notes` (TranslatedLine không có field error_code). */
export function createFailedLine(region, { notes, errorCode } = {}) {
  return createLine(region, {
    text_vi: '',
    status: TRANSLATE_STATUS.FAILED,
    provenance: PROVENANCE.NONE,
    confidence: 0,
    violations: [],
    notes: errorCode ? `${notes ?? 'Provider lỗi.'} (mã lỗi: ${errorCode})` : (notes ?? 'Provider lỗi.'),
  });
}

export default createLine;
