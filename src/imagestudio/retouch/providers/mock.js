/**
 * Provider `mock` — KHÔNG retouch thật (hợp đồng §3.4, E1).
 *
 * Dùng để chạy thử luồng pipeline mà không cần thuật toán thật. Trung thực tuyệt đối:
 *   − KHÔNG sửa pixel nào ⇒ `status = 'NO_CHANGES'` (kể cả khi người dùng có truyền tham số),
 *     `error_code = 'MOCK_NO_CHANGE'` + cảnh báo nói thẳng.
 *   − Tham số vẫn được KẸP/ECHO đầy đủ (`params_effective`, `clamped`, `rejected`) để
 *     E3/E4 kiểm tra phần wiring ngưỡng mà không bịa là đã retouch.
 */

import { RetouchProvider } from '../provider.js';
import { RETOUCH_CODES } from '../errors.js';
import { RETOUCH_STATUS } from '../result.js';
import { RETOUCH_PARAM_NAMES } from '../limits.js';

export class MockRetouchProvider extends RetouchProvider {
  constructor({ model = 'mock/khong-retouch-that', limits, retouchLimits, logger } = {}) {
    super({ name: 'mock', model, isMock: true, configured: true, limits, retouchLimits, logger });
  }

  async applyImpl({ params }) {
    const detail = RETOUCH_PARAM_NAMES.filter((name) => params[name] !== 0)
      .map((name) => `${name} = ${params[name]}`)
      .join(', ');
    return {
      status: RETOUCH_STATUS.NO_CHANGES,
      output: null,
      error_code: RETOUCH_CODES.MOCK_NO_CHANGE,
      warnings: [
        'Provider mock: KHÔNG retouch thật — KHÔNG pixel nào bị đổi, không có ảnh retouch nào được tạo.',
        `Provider mock: tham số trong ngưỡng (${detail || 'không có'}) chỉ được GHI NHẬN, không áp dụng.`,
      ],
    };
  }
}

export default MockRetouchProvider;
