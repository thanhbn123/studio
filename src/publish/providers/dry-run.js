/**
 * Provider `dry-run` — MẶC ĐỊNH của MVP-07 (hợp đồng §2.3).
 *
 * VÌ SAO LÀ MẶC ĐỊNH: sprint này CHƯA có token Facebook. Mặc định phải là một provider
 * **không bao giờ gọi mạng** và **tự khai mình là giả**, để không có đường nào vô tình đăng
 * thật trong lúc đang phát triển.
 *
 * Ba điều provider này cam kết:
 *   1. **KHÔNG có một dòng `fetch` nào** trong file này (kiểm được bằng cách thay
 *      `globalThis.fetch` thành hàm ném lỗi rồi gọi `publish()` — vẫn chạy bình thường).
 *   2. `post_id` **luôn** có tiền tố `dry-` ⇒ không ai nhầm id thử với id bài thật.
 *   3. `is_mock: true` và `url: null` — KHÔNG bịa link bài (không có bài thì không có link).
 */

import { randomBytes } from 'node:crypto';

import { DEFAULT_CHANNEL, normalizePublishText, normalizeSchedule } from '../items.js';

/** Tiền tố BẮT BUỘC của mọi id bài do chế độ thử sinh ra. */
export const DRY_RUN_PREFIX = 'dry-';

/** Câu nói thật cho UI/log — dùng CHUNG một nguồn, không gõ lại ở chỗ khác. */
export const DRY_RUN_NOTICE =
  'CHẾ ĐỘ THỬ — không đăng thật. Bài KHÔNG được gửi lên Facebook; mã bài có tiền tố "dry-".';

/** Id bài giả: `dry-` + 16 ký tự hex ngẫu nhiên (đủ phân biệt, không giống id Facebook thật). */
export function dryRunPostId() {
  return `${DRY_RUN_PREFIX}${randomBytes(8).toString('hex')}`;
}

export function createDryRunProvider(config = {}, { logger = null } = {}) {
  const maxLength = Number(config?.publish?.maxTextLength) || 63206;
  const calls = [];

  return {
    name: 'dry-run',
    channel: DEFAULT_CHANNEL,
    model: '',
    configured: true,
    isMock: true,
    notice: DRY_RUN_NOTICE,
    /** Vết các lần gọi TRONG TIẾN TRÌNH (để test/chẩn đoán); không ghi nội dung bài. */
    calls,

    async probe() {
      return {
        ok: true,
        name: 'dry-run',
        channel: DEFAULT_CHANNEL,
        configured: true,
        is_mock: true,
        page_id: '',
        error_code: null,
        message: DRY_RUN_NOTICE,
      };
    },

    async publish({ text = '', media = [], scheduledAt = null } = {}) {
      const norm = normalizePublishText(text, { maxLength });
      const list = Array.isArray(media) ? media : [];
      const sched = normalizeSchedule(scheduledAt);
      calls.push({ text_length: norm.length, media_count: list.length, scheduled_at: sched.scheduledAt });

      // Chế độ thử vẫn phải TÔN TRỌNG luật đầu vào: nếu không, bài sai vẫn "đăng được" ở chế độ
      // thử rồi vỡ đúng lúc cắm token thật — đúng kiểu thất bại mà repo này cấm.
      if (!norm.text && list.length === 0) {
        return result({ status: 'FAILED', error_code: 'BAD_INPUT', error_message: 'Bài không có nội dung và cũng không có ảnh/video.' });
      }
      if (norm.tooLong) {
        return result({ status: 'FAILED', error_code: 'TEXT_TOO_LONG', error_message: `Nội dung dài ${norm.length} ký tự, vượt trần ${maxLength}.` });
      }
      if (sched.bad) {
        return result({ status: 'FAILED', error_code: 'BAD_SCHEDULE', error_message: 'Mốc hẹn giờ không phải thời điểm ISO-8601 trong tương lai.' });
      }

      logger?.info?.('publish.dry_run', { text_length: norm.length, media_count: list.length, scheduled: Boolean(sched.scheduledAt) });
      return result({
        status: sched.scheduledAt ? 'SCHEDULED' : 'PUBLISHED',
        post_id: dryRunPostId(),
        scheduled_at: sched.scheduledAt,
        raw: { dry_run: true, text_length: norm.length, media_count: list.length },
      });
    },
  };
}

/** Dựng `PublishResult` ĐÚNG hình dạng hợp đồng §2.1 — một nguồn duy nhất cho provider này. */
function result({ status, post_id = null, scheduled_at = null, error_code = null, error_message = '', raw = null }) {
  return {
    status,
    post_id,
    // Chế độ thử KHÔNG có link bài thật. Trả `null` thay vì một URL bịa.
    url: null,
    error_code,
    error_message,
    is_mock: true,
    provider: 'dry-run',
    scheduled_at,
    raw,
  };
}

export default createDryRunProvider;
