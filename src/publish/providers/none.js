/**
 * Provider `none` — TẮT HẲN đường đăng bài (hợp đồng §2.3).
 *
 * Dùng cho hai ca:
 *   1. Chủ hệ thống khai `PUBLISH_PROVIDER=none` để chắc chắn không có gì đăng đi đâu.
 *   2. **Fail-closed khi cấu hình SAI**: `PUBLISH_PROVIDER` là tên lạ ⇒ `createPublishProvider`
 *      rơi về ĐÂY, KHÔNG rơi về `dry-run`. Lý do: một lỗi chính tả trong `.env` không được âm
 *      thầm biến thành "đã đăng" (kể cả đăng giả) — nó phải nói thẳng là chưa cấu hình.
 *
 * Không gọi mạng, không sinh `post_id`, không ném lỗi.
 */

import { DEFAULT_CHANNEL } from '../items.js';

export const NONE_MESSAGE =
  'Đường đăng bài đang TẮT (PUBLISH_PROVIDER=none hoặc tên provider không hợp lệ). Chưa có bài nào được đăng.';

export function createNonePublishProvider(config = {}, { logger = null, reason = '' } = {}) {
  const message = String(reason || '').trim() || NONE_MESSAGE;
  return {
    name: 'none',
    channel: DEFAULT_CHANNEL,
    model: '',
    configured: false,
    isMock: false,
    notice: message,

    async probe() {
      return {
        ok: false,
        name: 'none',
        channel: DEFAULT_CHANNEL,
        configured: false,
        is_mock: false,
        page_id: '',
        error_code: 'NOT_CONFIGURED',
        message,
      };
    },

    async publish() {
      logger?.warn?.('publish.provider_none', { message });
      return {
        status: 'NOT_CONFIGURED',
        post_id: null,
        url: null,
        error_code: 'NOT_CONFIGURED',
        error_message: message,
        is_mock: false,
        provider: 'none',
        scheduled_at: null,
        raw: null,
      };
    },
  };
}

export default createNonePublishProvider;
