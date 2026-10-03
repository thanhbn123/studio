/**
 * `createRenderProvider(config, { logger })` — chọn provider theo cấu hình (hợp đồng 4.3).
 *
 * Nhận được CẢ HAI kiểu tham số để agent khác gọi kiểu nào cũng đúng:
 *   - toàn bộ config (`config.render`, `config.imagelab`, `config.net`)
 *   - hoặc thẳng khối `config.render`
 *
 * Mặc định: `purejs` (render thật, offline). Tên provider lạ → ném `RenderError('UNKNOWN_PROVIDER')`
 * để lỗi cấu hình lộ ra ngay thay vì âm thầm chạy sai provider.
 */

import { RenderError, RENDER_CODES } from './errors.js';
import { DEFAULT_LIMITS } from './provider.js';
import { MockRenderProvider } from './providers/mock.js';
import { PureJsRenderProvider } from './providers/purejs.js';
import { HttpRenderProvider } from './providers/http.js';
import { NoneRenderProvider } from './providers/none.js';

export const RENDER_PROVIDER_NAMES = Object.freeze(['purejs', 'mock', 'http', 'none']);

const toInt = (value, fallback) => {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const toNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * @param {object} config config đầy đủ hoặc khối `render`
 * @param {{logger?:object}} [deps]
 * @returns {import('./provider.js').RenderProvider}
 */
export function createRenderProvider(config = {}, { logger } = {}) {
  const root = config && typeof config === 'object' ? config : {};
  const renderCfg = root.render && typeof root.render === 'object' ? root.render : root;
  const imagelabCfg = root.imagelab && typeof root.imagelab === 'object' ? root.imagelab : {};
  const netCfg = root.net && typeof root.net === 'object' ? root.net : {};

  const name = String(renderCfg.provider ?? renderCfg.name ?? 'purejs').trim().toLowerCase();

  // Giới hạn lấy từ `imagelab`, thiếu thì lấy mặc định của tầng net.
  const limits = {
    maxPixels: toInt(imagelabCfg.maxPixels, DEFAULT_LIMITS.maxPixels),
    maxInputBytes: toInt(imagelabCfg.maxImageBytes, toInt(netCfg.maxUploadBytes, DEFAULT_LIMITS.maxInputBytes)),
    maxOutputBytes: toInt(imagelabCfg.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes),
    fontScale: toNumber(imagelabCfg.fontScale, DEFAULT_LIMITS.fontScale),
  };
  const common = { limits, logger };

  switch (name) {
    case 'mock':
      return new MockRenderProvider({ ...common, model: renderCfg.model || 'mock' });
    case 'purejs':
    case 'local':
    case 'builtin':
      return new PureJsRenderProvider({ ...common, model: renderCfg.model || 'purejs/png+font5x7' });
    case 'http':
    case 'remote':
      return new HttpRenderProvider({
        ...common,
        baseUrl: renderCfg.baseUrl,
        apiKey: renderCfg.apiKey,
        model: renderCfg.model,
        timeoutMs: toInt(renderCfg.timeoutMs, 60000),
        allowPrivateNetwork: netCfg.allowPrivateNetwork === true,
      });
    case 'none':
    case 'off':
    case 'disabled':
      return new NoneRenderProvider({ ...common, model: renderCfg.model || '' });
    default:
      throw new RenderError(RENDER_CODES.UNKNOWN_PROVIDER, `Provider render không được hỗ trợ: "${name}".`, {
        supported: RENDER_PROVIDER_NAMES,
      });
  }
}

export default createRenderProvider;
