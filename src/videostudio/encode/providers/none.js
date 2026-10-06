/**
 * Provider `none` — KHÔNG bật mã hoá video (hợp đồng MVP-04 §2.2).
 *
 * `configured = false` nên `encode()` luôn trả `FAILED` + `error_code = 'NOT_CONFIGURED'`.
 * `EncodeResult` KHÔNG có status `NOT_CONFIGURED` (giống `RetouchResult` của MVP-03):
 * mã lỗi nằm ở `error_code`, trạng thái nằm ở `status`.
 */

import { VideoEncoder } from '../encoder.js';

export class NoneVideoEncoder extends VideoEncoder {
  constructor({ model = '', limits, logger } = {}) {
    super({ name: 'none', model, mime: '', isMock: false, configured: false, limits, logger });
  }
}

export default NoneVideoEncoder;
