/**
 * `createRetouchProvider(config, { logger })` — chọn provider retouch theo cấu hình
 * (hợp đồng §3.4, E1).
 *
 * Nhận CẢ HAI kiểu tham số (giống `createRenderProvider` của MVP-02):
 *   - toàn bộ config (`config.retouch`, `config.imagelab`)
 *   - hoặc thẳng khối `config.retouch`
 *
 * Mặc định: `purejs` — retouch THẬT, chạy offline. Danh sách provider: `purejs`, `mock`, `none`.
 * KHÔNG có provider `http` cho retouch: 4 tham số ngưỡng được áp NGAY TRONG TIẾN TRÌNH
 * (đẩy ảnh sang service ngoài chỉ để đổi độ sáng là rủi ro vô ích). Cấu hình `http` ⇒
 * ném `RetouchError('UNKNOWN_PROVIDER')` kèm giải thích, KHÔNG âm thầm chạy provider khác.
 *
 * Ngưỡng: `config.retouch.limits` chỉ được SIẾT (xem `resolveRetouchLimits`), không bao giờ
 * nới quá `RETOUCH_LIMITS` của hợp đồng.
 */

import { RetouchError, RETOUCH_CODES } from './errors.js';
import { DEFAULT_RETOUCH_LIMITS } from './provider.js';
import { PureJsRetouchProvider } from './providers/purejs.js';
import { MockRetouchProvider } from './providers/mock.js';
import { NoneRetouchProvider } from './providers/none.js';

export const RETOUCH_PROVIDER_NAMES = Object.freeze(['purejs', 'mock', 'none']);

const toInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * @param {object} config config đầy đủ hoặc khối `retouch`
 * @param {{logger?: object}} [deps]
 * @returns {import('./provider.js').RetouchProvider}
 */
export function createRetouchProvider(config = {}, { logger } = {}) {
  const root = config && typeof config === 'object' ? config : {};
  const retouchCfg = root.retouch && typeof root.retouch === 'object' ? root.retouch : root;
  const imagelabCfg = root.imagelab && typeof root.imagelab === 'object' ? root.imagelab : {};

  const name = String(retouchCfg.provider ?? retouchCfg.name ?? 'purejs').trim().toLowerCase();

  const limits = {
    maxPixels: toInt(imagelabCfg.maxPixels, DEFAULT_RETOUCH_LIMITS.maxPixels),
    maxInputBytes: toInt(imagelabCfg.maxImageBytes, DEFAULT_RETOUCH_LIMITS.maxInputBytes),
    maxOutputBytes: toInt(imagelabCfg.maxOutputBytes, DEFAULT_RETOUCH_LIMITS.maxOutputBytes),
  };
  const retouchLimits = retouchCfg.limits && typeof retouchCfg.limits === 'object' ? retouchCfg.limits : {};
  const common = { limits, retouchLimits, logger };

  switch (name) {
    case 'purejs':
    case 'local':
    case 'builtin':
      return new PureJsRetouchProvider({ ...common, model: retouchCfg.model || 'purejs/lut+3x3' });
    case 'mock':
      return new MockRetouchProvider({ ...common, model: retouchCfg.model || 'mock/khong-retouch-that' });
    case 'none':
    case 'off':
    case 'disabled':
      return new NoneRetouchProvider({ ...common, model: retouchCfg.model || '' });
    case 'http':
    case 'remote':
      throw new RetouchError(
        RETOUCH_CODES.UNKNOWN_PROVIDER,
        'Provider retouch "http" KHÔNG được hỗ trợ: retouch chỉ gồm 4 tham số ngưỡng và được áp ngay trong tiến trình.',
        { supported: RETOUCH_PROVIDER_NAMES },
      );
    default:
      throw new RetouchError(RETOUCH_CODES.UNKNOWN_PROVIDER, `Provider retouch không được hỗ trợ: "${name}".`, {
        supported: RETOUCH_PROVIDER_NAMES,
      });
  }
}

export default createRetouchProvider;
