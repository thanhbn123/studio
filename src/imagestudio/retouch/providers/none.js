/**
 * Provider `none` — KHÔNG có provider retouch nào được bật (hợp đồng §3.4, E1).
 *
 * `configured = false` nên `apply()` luôn trả `FAILED` + `error_code = 'NOT_CONFIGURED'`
 * (`RetouchResult` không có status `NOT_CONFIGURED`; xem bảng trạng thái ở §3.4).
 */

import { RetouchProvider } from '../provider.js';

export class NoneRetouchProvider extends RetouchProvider {
  constructor({ model = '', limits, retouchLimits, logger } = {}) {
    super({ name: 'none', model, isMock: false, configured: false, limits, retouchLimits, logger });
  }
}

export default NoneRetouchProvider;
