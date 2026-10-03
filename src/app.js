/**
 * Composition root — nơi duy nhất lắp ráp toàn bộ ứng dụng.
 *
 * Mọi thứ phụ thuộc được bơm vào từ đây (dependency injection thủ công), nên test
 * có thể dựng app với provider giả, DB in-memory, và connector giả mà không cần
 * chạm mạng.
 */

import { loadConfig } from './config.js';
import { createLogger, silentLogger } from './logger.js';
import { createStore } from './store/index.js';
import { createSessionProvider } from './session/browser-session.js';
import { ConnectorRegistry } from './sources/registry.js';
import { TaobaoConnector } from './sources/taobao.js';
import { Alibaba1688Connector } from './sources/alibaba1688.js';
import { PinduoduoConnector } from './sources/pinduoduo.js';
import { createVisionProvider } from './vision/vision-provider.js';
import { createContentEngine } from './content/engine.js';
import { Pipeline } from './jobs/pipeline.js';
import { JobQueue } from './jobs/queue.js';
import { MemoryRateLimiter } from './security/ratelimit.js';
import { buildRouter } from './http/routes.js';
import { createServer } from './http/server.js';

/**
 * @param {object} opts
 * @param {object} [opts.config]
 * @param {object} [opts.logger]
 * @param {object} [opts.store]        store đã dựng sẵn (test)
 * @param {Array}  [opts.connectors]   danh sách lớp connector (test)
 */
export async function createApp(opts = {}) {
  const config = opts.config || loadConfig();
  const logger = opts.logger || silentLogger;
  const rootLogger = opts.logger === null ? silentLogger : logger;

  const store = opts.store || (await createStore(config, rootLogger));
  const sessions = opts.sessions || (await createSessionProvider(config, rootLogger));

  const registry = new ConnectorRegistry({ config, logger: rootLogger, session: sessions });
  registry.registerAll(
    opts.connectors || [TaobaoConnector, Alibaba1688Connector, PinduoduoConnector],
  );

  const visionProvider = opts.visionProvider || createVisionProvider(config, { logger: rootLogger });
  const contentEngine = opts.contentEngine || createContentEngine(config, { logger: rootLogger });

  const queue = new JobQueue({
    concurrency: config.jobs.concurrency,
    maxAttempts: config.jobs.maxAttempts,
    logger: rootLogger,
  });

  // Nếu KHÔNG có người nghe sự kiện 'failed', một job ném lỗi sẽ để `jobs.status` mãi ở
  // 'running' (queue trong bộ nhớ báo failed, nhưng DB thì không) — và vì front-end chỉ
  // poll `job.status`, người dùng thấy vòng xoay vĩnh viễn mà không có thông báo lỗi nào.
  // Verifier độc lập đã dựng được đúng ca này.
  queue.on('failed', async ({ id, error }) => {
    try {
      await store.updateJob(id, {
        status: 'failed',
        stage: 'failed',
        error_code: error?.code || 'JOB_FAILED',
        error_message: error?.message || 'Job thất bại không rõ nguyên nhân.',
        finished_at: new Date().toISOString(),
      });
      rootLogger.error('queue.job_failed', { job_id: id, error });
    } catch (err) {
      // Không được để lỗi khi ghi trạng thái thất bại làm sập tiến trình.
      rootLogger.error('queue.failed_handler_error', { job_id: id, error: err });
    }
  });

  const pipeline = new Pipeline({
    config,
    logger: rootLogger,
    store,
    registry,
    visionProvider,
    contentEngine,
  });

  const rateLimiters = {
    requests: new MemoryRateLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.maxRequests }),
    jobs: new MemoryRateLimiter({ windowMs: config.rateLimit.windowMs, max: config.rateLimit.maxJobs }),
  };
  const sweep = setInterval(() => {
    rateLimiters.requests.sweep();
    rateLimiters.jobs.sweep();
  }, Math.max(config.rateLimit.windowMs, 30000));
  sweep.unref?.();

  const app = {
    config,
    logger: rootLogger,
    store,
    sessions,
    registry,
    visionProvider,
    contentEngine,
    pipeline,
    queue,
    rateLimiters,
  };

  app.router = buildRouter(app);
  app.server = createServer({ router: app.router, logger: rootLogger });

  app.close = async () => {
    clearInterval(sweep);
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        resolve();
      };
      app.server.close(finish);
      // `server.close()` chỉ gọi callback khi MỌI kết nối đã đóng, mà kết nối
      // keep-alive đang rảnh thì phải chờ hết `keepAliveTimeout` (65 giây!).
      // Đóng ngay các kết nối rảnh, và sau một khoảng ân hạn thì đóng nốt phần còn lại
      // để tắt êm không bao giờ bị treo.
      app.server.closeIdleConnections?.();
      const forceTimer = setTimeout(() => app.server.closeAllConnections?.(), 2000);
      forceTimer.unref?.();
    });
    await queue.drain().catch(() => {});
    await store.close().catch(() => {});
  };

  return app;
}

export default createApp;
