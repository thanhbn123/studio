/**
 * P1 — TRẠNG THÁI + LUẬT CHUYỂN TRẠNG THÁI của bài đăng (MVP-07 §2.2).
 *
 * File này KHÔNG gọi DB, KHÔNG gọi mạng: chỉ là luật thuần, nhờ vậy cổng duyệt được kiểm bằng
 * test đơn vị mà không cần dựng app.
 *
 * Luật quan trọng nhất của cả sprint nằm ở `PUBLISHABLE_STATUSES`: ĐÚNG hai trạng thái
 * (`approved`, `failed`) được phép gọi provider. Mọi chỗ khác trong mã nguồn phải đọc hằng này,
 * KHÔNG được viết lại danh sách — bản sao luật là thứ dễ lệch nhất (bài học `applyReviewEdits`
 * của MVP-02).
 */

/** Trạng thái hợp lệ của một bài đăng (hợp đồng §3.1). */
export const PUBLISH_STATUSES = Object.freeze([
  'draft',
  'pending_review',
  'approved',
  'publishing',
  'published',
  'failed',
  'rejected',
]);

/** Kênh đăng. Sprint này CHỈ Facebook Page (chủ dự án đã chốt làm Facebook trước). */
export const PUBLISH_CHANNELS = Object.freeze(['facebook_page']);
export const DEFAULT_CHANNEL = 'facebook_page';

/** Trạng thái KẾT THÚC — không chuyển đi đâu được nữa. */
export const PUBLISH_TERMINAL = Object.freeze(['published', 'rejected']);

/**
 * ⚠️ CỔNG DUYỆT — trạng thái nào được phép gọi provider.
 *
 * `approved`: người có quyền đã bấm DUYỆT.
 * `failed`:   đã từng được duyệt, lượt đăng trước lỗi ⇒ được đăng lại (vẫn giữ `approved_by` cũ),
 *             NHƯNG chỉ khi `external_post_id IS NULL` (luật §0.4 — một bài chỉ đăng một lần).
 *
 * KHÔNG nới danh sách này. `draft`/`pending_review`/`rejected`/`publishing`/`published` ⇒ 0 lời gọi.
 */
export const PUBLISHABLE_STATUSES = Object.freeze(['approved', 'failed']);

/** Trạng thái mà owner/admin được phép DUYỆT. */
export const APPROVABLE_STATUSES = Object.freeze(['draft', 'pending_review']);

/** Bảng chuyển trạng thái (hợp đồng §2.2). Ngoài bảng ⇒ `BAD_STATE`. */
const TRANSITIONS = Object.freeze({
  draft: Object.freeze(['pending_review', 'approved', 'rejected']),
  pending_review: Object.freeze(['approved', 'rejected']),
  approved: Object.freeze(['publishing', 'rejected']),
  publishing: Object.freeze(['published', 'failed']),
  failed: Object.freeze(['publishing', 'rejected']),
  published: Object.freeze([]),
  rejected: Object.freeze([]),
});

/** Trạng thái `s` có trong hợp đồng hay không. */
export function isPublishStatus(s) {
  return PUBLISH_STATUSES.includes(String(s ?? ''));
}

/** Kênh `c` có trong hợp đồng hay không. */
export function isPublishChannel(c) {
  return PUBLISH_CHANNELS.includes(String(c ?? ''));
}

/**
 * Chuyển `from → to` có hợp lệ hay không. Trạng thái lạ ⇒ `false` (fail-closed: không biết thì
 * từ chối, không đoán).
 */
export function canTransition(from, to) {
  const f = String(from ?? '');
  const t = String(to ?? '');
  if (!isPublishStatus(f) || !isPublishStatus(t)) return false;
  return TRANSITIONS[f].includes(t);
}

/** Bài ở trạng thái này có được gọi provider hay không (chỉ đọc `PUBLISHABLE_STATUSES`). */
export function isPublishable(status) {
  return PUBLISHABLE_STATUSES.includes(String(status ?? ''));
}

/**
 * Chuẩn hoá nội dung bài đăng.
 *
 * KHÔNG viết lại chữ của người dùng: chỉ chuẩn hoá CR/LF (Facebook nhận `\n`), bỏ ký tự điều
 * khiển vô hình (có thể dùng để che nội dung thật khi người duyệt đọc), và cắt khoảng trắng hai
 * đầu. Vượt trần ⇒ KHÔNG tự cắt (cắt âm thầm là sửa nội dung đã duyệt): báo lại cho tầng trên.
 *
 * @returns {{ text: string, length: number, tooLong: boolean, warnings: string[] }}
 */
export function normalizePublishText(raw, { maxLength = 63206 } = {}) {
  const warnings = [];
  let text = String(raw ?? '')
    .replace(/\r\n?/g, '\n')
    // Ký tự điều khiển (trừ \n và \t) — không hiển thị nhưng vẫn được đăng đi.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // Ký tự định hướng/zero-width: người duyệt thấy một đằng, Facebook nhận một nẻo.
    .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '');
  if (text !== String(raw ?? '')) warnings.push('Đã bỏ ký tự điều khiển/vô hình khỏi nội dung.');
  text = text.replace(/[ \t]+$/gm, '').trim();
  const limit = Number.isFinite(Number(maxLength)) && Number(maxLength) > 0 ? Math.trunc(Number(maxLength)) : 63206;
  // Đo bằng [...text] (điểm mã) để emoji không bị tính thành 2 ký tự.
  const length = [...text].length;
  return { text, length, tooLong: length > limit, warnings };
}

/**
 * Chuẩn hoá danh sách id media: bỏ trùng, bỏ rỗng, chỉ nhận hình dạng id của repo
 * (`image_assets.id` là uuid hoặc chuỗi an toàn) — id rác KHÔNG được đi tới câu SQL nào.
 *
 * @returns {{ mediaIds: string[], tooMany: boolean, dropped: number }}
 */
export function normalizeMediaIds(raw, { maxMedia = 1 } = {}) {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw];
  const seen = new Set();
  let dropped = 0;
  for (const value of list) {
    const id = String(value ?? '').trim();
    if (!id || !/^[0-9a-fA-F-]{36}$|^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      dropped += 1;
      continue;
    }
    seen.add(id);
  }
  const mediaIds = [...seen];
  const limit = Number.isFinite(Number(maxMedia)) && Number(maxMedia) > 0 ? Math.trunc(Number(maxMedia)) : 1;
  return { mediaIds, tooMany: mediaIds.length > limit, dropped };
}

/**
 * `scheduledAt` phải là ISO-8601 trong TƯƠNG LAI. `null`/rỗng = đăng ngay.
 * @returns {{ scheduledAt: string|null, bad: boolean }}
 */
export function normalizeSchedule(raw, { now = Date.now() } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { scheduledAt: null, bad: false };
  const ms = Date.parse(String(raw).trim());
  if (!Number.isFinite(ms)) return { scheduledAt: null, bad: true };
  // Facebook yêu cầu mốc hẹn giờ ở tương lai; quá khứ là "đăng ngay" ngụy trang ⇒ từ chối.
  if (ms <= Number(now)) return { scheduledAt: null, bad: true };
  return { scheduledAt: new Date(ms).toISOString(), bad: false };
}

/**
 * GỢI Ý nội dung từ một job MVP-01 — chỉ ghép những field ĐÃ CÓ trong `jobs.content`.
 *
 * KHÔNG sinh thêm chữ nào: job chưa có nội dung ⇒ trả chuỗi rỗng để UI/API nói thẳng "chưa có
 * nội dung, hãy tự viết". Đây là chỗ dễ sa vào "bịa cho đẹp" nhất, nên cố ý làm thật nghèo.
 */
export function draftTextFromJob(job) {
  const c = job?.content;
  if (!c || typeof c !== 'object') return '';
  const parts = [];
  const push = (v) => {
    const s = String(v ?? '').trim();
    if (s) parts.push(s);
  };
  push(c.headline);
  push(c.short_description);
  if (Array.isArray(c.selling_points)) {
    const bullets = c.selling_points.map((p) => String(p ?? '').trim()).filter(Boolean).map((p) => `• ${p}`);
    if (bullets.length) parts.push(bullets.join('\n'));
  }
  push(c.facebook_caption);
  if (Array.isArray(c.hashtags)) {
    const tags = c.hashtags.map((t) => String(t ?? '').trim()).filter(Boolean);
    if (tags.length) parts.push(tags.join(' '));
  }
  return parts.join('\n\n').trim();
}

/** `run_key` của MỘT lượt đăng: `<itemId>#<attempt>` — soi gương `wallet_ledger.run_key`. */
export function publishRunKey(itemId, attempt) {
  const n = Number.isFinite(Number(attempt)) ? Math.trunc(Number(attempt)) : 0;
  return `${String(itemId ?? '')}#${n}`;
}
