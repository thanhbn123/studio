/**
 * `createMattingProvider(config, { logger })` — chọn provider tách nền theo cấu hình
 * (hợp đồng §3.1, E1).
 *
 * Nhận được CẢ HAI kiểu tham số (giống `createRenderProvider` của MVP-02):
 *   - toàn bộ config (`config.matting`, `config.imagelab`, `config.net`)
 *   - hoặc thẳng khối `config.matting`
 *
 * Mặc định: `purejs` — tách nền THẬT, chạy offline, không cần key.
 * Tên provider lạ ⇒ ném `MattingError('UNKNOWN_PROVIDER')` để lỗi cấu hình lộ ra ngay,
 * KHÔNG âm thầm chạy sai provider (fail-closed).
 */

import { MattingError, MATTING_CODES } from './errors.js';
import { DEFAULT_MATTING_LIMITS } from './provider.js';
import { PureJsMattingProvider } from './providers/purejs.js';
import { MockMattingProvider } from './providers/mock.js';
import { HttpMattingProvider } from './providers/http.js';
import { NoneMattingProvider } from './providers/none.js';

export const MATTING_PROVIDER_NAMES = Object.freeze(['purejs', 'mock', 'http', 'none']);

const toInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const toNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * @param {object} config config đầy đủ hoặc khối `matting`
 * @param {{logger?: object}} [deps]
 * @returns {import('./provider.js').MattingProvider}
 */
export function createMattingProvider(config = {}, { logger } = {}) {
  const root = config && typeof config === 'object' ? config : {};
  const mattingCfg = root.matting && typeof root.matting === 'object' ? root.matting : root;
  const imagelabCfg = root.imagelab && typeof root.imagelab === 'object' ? root.imagelab : {};
  const netCfg = root.net && typeof root.net === 'object' ? root.net : {};

  const name = String(mattingCfg.provider ?? mattingCfg.name ?? 'purejs').trim().toLowerCase();

  // Giới hạn dùng chung với MVP-02 (khối `imagelab`) — không khai thêm biến môi trường mới.
  const limits = {
    maxPixels: toInt(imagelabCfg.maxPixels, DEFAULT_MATTING_LIMITS.maxPixels),
    maxInputBytes: toInt(imagelabCfg.maxImageBytes, DEFAULT_MATTING_LIMITS.maxInputBytes),
    maxOutputBytes: toInt(imagelabCfg.maxOutputBytes, DEFAULT_MATTING_LIMITS.maxOutputBytes),
  };
  const common = { limits, logger };

  switch (name) {
    case 'mock':
      return new MockMattingProvider({ ...common, model: mattingCfg.model || 'mock/khong-tach-that' });
    case 'purejs':
    case 'local':
    case 'builtin':
      return new PureJsMattingProvider({
        ...common,
        model: mattingCfg.model || 'purejs/floodfill-border',
        tolerance: mattingCfg.tolerance,
        minUniformity: mattingCfg.minUniformity,
        connectivity: toInt(mattingCfg.connectivity, 4),
        borderWidth: toInt(mattingCfg.borderWidth, 1),
      });
    case 'http':
    case 'remote':
      return new HttpMattingProvider({
        ...common,
        baseUrl: mattingCfg.baseUrl,
        apiKey: mattingCfg.apiKey,
        model: mattingCfg.model,
        timeoutMs: toNumber(mattingCfg.timeoutMs, 60000),
        allowPrivateNetwork: netCfg.allowPrivateNetwork === true,
      });
    case 'none':
    case 'off':
    case 'disabled':
      return new NoneMattingProvider({ ...common, model: mattingCfg.model || '' });
    default:
      throw new MattingError(
        MATTING_CODES.UNKNOWN_PROVIDER,
        `Provider tách nền không được hỗ trợ: "${name}".`,
        { supported: MATTING_PROVIDER_NAMES },
      );
  }
}

export default createMattingProvider;
