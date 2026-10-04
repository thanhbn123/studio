/**
 * Provider `none` — KHÔNG có provider tách nền nào được bật (hợp đồng §3.1, E1).
 *
 * `configured = false` nên `removeBackground()` luôn trả `NOT_CONFIGURED` kèm
 * `error_code`. Đây là mặc định an toàn khi cấu hình tắt hẳn: từ chối, không giả vờ.
 */

import { MattingProvider } from '../provider.js';

export class NoneMattingProvider extends MattingProvider {
  constructor({ model = '', limits, logger } = {}) {
    super({ name: 'none', model, isMock: false, configured: false, limits, logger });
  }
}

export default NoneMattingProvider;
