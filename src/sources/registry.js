/**
 * G02 — Registry connector + CÔ LẬP LỖI.
 *
 * Yêu cầu bắt buộc: "Một connector hỏng không được làm hỏng connector khác."
 *
 * Cách làm: registry không bao giờ để lỗi của một connector thoát ra ngoài. Mọi
 * connector được gọi trong try/catch riêng, và registry còn tự bắt lỗi KHI KHỞI TẠO
 * (một connector không khởi tạo được vẫn không chặn các connector còn lại).
 */

import { ProductSourceConnector } from './base-connector.js';
import { detectSource, detectHostSource } from './detect.js';
import { createEmptyMaster, recomputeEvidence, addWarning, STATUS } from '../product-master.js';

export class ConnectorRegistry {
  constructor({ config, logger, session } = {}) {
    this.config = config;
    this.logger = logger;
    this.session = session;
    /** @type {ProductSourceConnector[]} */
    this.connectors = [];
    /** @type {{source:string, error:string}[]} */
    this.initFailures = [];
  }

  /**
   * Nạp connector theo lớp, cô lập lỗi khởi tạo.
   * @param {Array<typeof ProductSourceConnector>} ConnectorClasses
   */
  registerAll(ConnectorClasses = []) {
    for (const Cls of ConnectorClasses) {
      const name = Cls?.name || '(unknown)';
      try {
        const instance = new Cls({ config: this.config, logger: this.logger, session: this.session });
        if (typeof instance.canHandle !== 'function' || typeof instance.normalize !== 'function') {
          throw new Error('Connector thiếu canHandle()/normalize().');
        }
        this.connectors.push(instance);
      } catch (err) {
        this.initFailures.push({ source: name, error: err.message });
        this.logger?.error('registry.connector_init_failed', { connector: name, error: err });
        // KHÔNG rethrow — cô lập.
      }
    }
    return this;
  }

  register(instance) {
    this.connectors.push(instance);
    return this;
  }

  /** @returns {ProductSourceConnector|null} */
  findFor(url) {
    for (const c of this.connectors) {
      try {
        if (c.canHandle(url)) return c;
      } catch (err) {
        // Lỗi trong canHandle của connector này không được chặn việc thử connector khác.
        this.logger?.warn('registry.can_handle_failed', { connector: c.displayName, error: err });
      }
    }
    return null;
  }

  list() {
    return this.connectors.map((c) => ({
      source: c.source,
      display_name: c.displayName,
      class: c.constructor.name,
    }));
  }

  /**
   * Trích xuất an toàn. KHÔNG BAO GIỜ ném lỗi.
   * @returns {Promise<object>} Product Master (có thể là master bị BLOCKED)
   */
  async extract(url, ctx = {}) {
    let detection = null;
    let hostSource = null;
    try {
      hostSource = detectHostSource(new URL(url).hostname);
    } catch {
      hostSource = null;
    }
    try {
      detection = detectSource(url);
    } catch (err) {
      // Tên miền lạ → chặn hẳn. Nhưng nếu TÊN MIỀN hợp lệ mà chỉ id dị thường thì
      // KHÔNG được bỏ cuộc: phải để connector xử lý và báo lỗi chính xác. Trước đây
      // registry trả về master với `source` rỗng, làm mất luôn thông tin nguồn.
      if (!hostSource) {
        return this.blockedMaster(url, {
          source: 'unknown',
          reason: err.code === 'UNSUPPORTED_SOURCE' ? 'UNSUPPORTED' : 'INVALID_URL',
          message: err.message,
        });
      }
    }

    const sourceName = detection?.source || hostSource?.source || 'unknown';
    const connector = this.findFor(url);
    if (!connector) {
      return this.blockedMaster(url, {
        source: sourceName,
        reason: 'UNSUPPORTED',
        message: `Không có connector nào xử lý được nguồn ${sourceName}.`,
        detection,
      });
    }

    try {
      const master = await connector.extract(url, ctx);
      if (!master.extraction.connector) master.extraction.connector = connector.displayName;
      return master;
    } catch (err) {
      // Lớp chắn cuối: connector ném lỗi bất ngờ vẫn phải trả về master hợp lệ.
      this.logger?.error('registry.extract_unhandled', {
        connector: connector.displayName,
        source: sourceName,
        error: err,
      });
      return this.blockedMaster(url, {
        source: sourceName,
        reason: err.code || err.name || 'CONNECTOR_ERROR',
        message: err.message,
        detection,
        connectorName: connector.displayName,
      });
    }
  }

  /** Tạo Product Master "bị chặn" hợp lệ — đủ để pipeline rơi vào manual fallback (G11). */
  blockedMaster(url, { source, reason, message, detection = null, connectorName = '' }) {
    const st = reason === 'UNSUPPORTED' ? STATUS.UNSUPPORTED : STATUS.BLOCKED;
    const master = createEmptyMaster({
      source: source === 'unknown' ? '' : source,
      sourceUrl: url,
      canonicalUrl: detection?.canonical_url || url,
      sourceProductId: detection?.source_product_id || '',
    });
    master.extraction.connector = connectorName || source;
    master.extraction.method = 'none';
    master.extraction.blocked_reason = `${reason}: ${message}`;
    master.extraction.extracted_at = new Date().toISOString();
    master.title_original_status = st;
    master.description_original_status = st;
    master.price.status = st;
    master.store.status = st;
    master.extraction.field_status = {
      title_original: st,
      images: st,
      videos: st,
      variants: st,
      attributes: st,
      price: st,
      description_original: st,
      store: st,
    };
    addWarning(master, message);
    return recomputeEvidence(master);
  }
}

export default ConnectorRegistry;
