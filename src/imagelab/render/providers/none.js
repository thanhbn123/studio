/**
 * Provider `none` — KHÔNG có provider render nào được bật (hợp đồng 4.3).
 *
 * `configured = false` nên `render()` luôn trả `NOT_CONFIGURED` kèm `error_code`.
 * Đây là mặc định an toàn: thiếu cấu hình thì từ chối, không giả vờ render.
 */

import { RenderProvider } from '../provider.js';

export class NoneRenderProvider extends RenderProvider {
  constructor({ model = '', limits, logger } = {}) {
    super({ name: 'none', model, isMock: false, configured: false, limits, logger });
  }
}

export default NoneRenderProvider;
