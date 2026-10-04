/**
 * Composition root — nơi duy nhất lắp ráp toàn bộ ứng dụng.
 *
 * Mọi thứ phụ thuộc được bơm vào từ đây (dependency injection thủ công), nên test
 * có thể dựng app với provider giả, DB in-memory, và connector giả mà không cần
 * chạm mạng.
 *
 * MVP-02: khối ImageLab được nạp PHÒNG THỦ (hợp đồng 4.6) — module anh em do bốn
 * agent khác viết song song nên có thể chưa tồn tại lúc boot. Nạp lỗi thì MVP-01
 * vẫn phải khởi động và chạy bình thường.
 *
 * MVP-03: khối ImageStudio (matting/retouch/pipeline tạo ảnh) cũng được nạp PHÒNG THỦ
 * theo đúng cách đó và độc lập với khối ImageLab — hỏng MVP-03 thì MVP-01/MVP-02 vẫn boot.
 */

import { loadConfig } from './config.js';
import { createLogger, silentLogger, scrubPaths } from './logger.js';
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
 * Nạp MỘT module MVP-02 và gắn nhãn module vào lỗi, để log `imagelab.wiring_failed`
 * nói được CHÍNH XÁC module nào hỏng (nạp cả cụm bằng một `Promise.all` thì lỗi
 * không cho biết thủ phạm). Message được lọc đường dẫn tuyệt đối (`scrubPaths`)
 * trước khi vào log/`/api/health`.
 */
async function importImagelabModule(label, specifier) {
  try {
    return await import(specifier);
  } catch (err) {
    const wrapped = new Error(`Không nạp được module MVP-02 "${specifier}" (${label}): ${scrubPaths(err?.message || err)}`);
    wrapped.imagelabModule = specifier;
    wrapped.imagelabLabel = label;
    wrapped.cause = err;
    throw wrapped;
  }
}

/**
 * Nạp MỘT module MVP-03 (ImageStudio) và gắn nhãn module vào lỗi — cùng lý do với
 * `importImagelabModule`: log `imagestudio.wiring_failed` phải nói được module nào hỏng.
 */
async function importImagestudioModule(label, specifier) {
  try {
    return await import(specifier);
  } catch (err) {
    const wrapped = new Error(`Không nạp được module MVP-03 "${specifier}" (${label}): ${scrubPaths(err?.message || err)}`);
    wrapped.imagestudioModule = specifier;
    wrapped.imagestudioLabel = label;
    wrapped.cause = err;
    throw wrapped;
  }
}

/**
 * @param {object} opts
 * @param {object} [opts.config]
 * @param {object} [opts.logger]
 * @param {object} [opts.store]        store đã dựng sẵn (test)
 * @param {Array}  [opts.connectors]   danh sách lớp connector (test)
 * @param {object} [opts.ocrProvider]  [MVP-02] provider OCR đã dựng sẵn (test)
 * @param {object} [opts.translator]   [MVP-02] translator đã dựng sẵn (test)
 * @param {object} [opts.renderProvider] [MVP-02] render provider đã dựng sẵn (test)
 * @param {object} [opts.storage]      [MVP-02/MVP-03] image storage đã dựng sẵn (test)
 * @param {object} [opts.imagelabPipeline] [MVP-02] pipeline đã dựng sẵn (test)
 * @param {object} [opts.mattingProvider]  [MVP-03] provider tách nền đã dựng sẵn (test)
 * @param {object} [opts.retouchProvider]  [MVP-03] provider retouch đã dựng sẵn (test)
 * @param {object} [opts.imagestudioPipeline] [MVP-03] pipeline tạo ảnh đã dựng sẵn (test)
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

  /* ── MVP-02 (ImageLab) — nạp phòng thủ, không được làm chết boot MVP-01 ─── */
  const imagelab = {
    ocrProvider: null,
    translator: null,
    renderProvider: null,
    storage: null,
    imagelabPipeline: null,
    // Lý do THẬT khiến ImageLab không chạy được (null = đang chạy bình thường).
    // Được trả ra `/api/health` + `/api/config` để người vận hành biết VÌ SAO tính
    // năng tắt — im lặng là kiểu thất bại bị luật #4 cấm.
    reason: null,
  };

  if (config?.imagelab?.enabled === false) {
    imagelab.reason = 'Tính năng dịch ảnh đang bị tắt bằng cấu hình (config.imagelab.enabled = false / IMAGELAB_ENABLED=false).';
    rootLogger.info('imagelab.disabled', { reason: imagelab.reason });
  } else if (opts.imagelabPipeline && opts.storage) {
    // Đã được bơm sẵn (test hoặc tầng gộp) → dùng luôn, khỏi nạp module anh em.
    imagelab.ocrProvider = opts.ocrProvider || null;
    imagelab.translator = opts.translator || null;
    imagelab.renderProvider = opts.renderProvider || null;
    imagelab.storage = opts.storage;
    imagelab.imagelabPipeline = opts.imagelabPipeline;
  } else {
    try {
      const [ocrModule, translateModule, renderModule, storageModule, pipelineModule] = await Promise.all([
        importImagelabModule('ocr', './imagelab/ocr/index.js'),
        importImagelabModule('translate', './imagelab/translate/index.js'),
        importImagelabModule('render', './imagelab/render/index.js'),
        importImagelabModule('storage', './imagelab/storage.js'),
        importImagelabModule('pipeline', './imagelab/pipeline.js'),
      ]);

      const ocrProvider = opts.ocrProvider || ocrModule.createOcrProvider(config, { logger: rootLogger });
      const translator = opts.translator || translateModule.createTranslator(config, { logger: rootLogger });
      const renderProvider = opts.renderProvider || renderModule.createRenderProvider(config, { logger: rootLogger });
      const storage = opts.storage || storageModule.createImageStorage(config, { logger: rootLogger });

      imagelab.ocrProvider = ocrProvider;
      imagelab.translator = translator;
      imagelab.renderProvider = renderProvider;
      imagelab.storage = storage;
      imagelab.imagelabPipeline = new pipelineModule.ImageTranslationPipeline({
        config,
        logger: rootLogger,
        store,
        storage,
        ocrProvider,
        translator,
        renderProvider,
      });
      rootLogger.info('imagelab.wired', {
        ocr: ocrProvider?.name || 'none',
        ocr_mock: Boolean(ocrProvider?.isMock),
        translate: translator?.name || 'none',
        translate_mock: Boolean(translator?.isMock),
        render: renderProvider?.name || 'none',
        render_mock: Boolean(renderProvider?.isMock),
      });
    } catch (err) {
      // Module anh em chưa tồn tại / lỗi lúc nạp → ImageLab coi như không có mặt.
      imagelab.ocrProvider = null;
      imagelab.translator = null;
      imagelab.renderProvider = null;
      imagelab.storage = null;
      imagelab.imagelabPipeline = null;
      const modulePath = err?.imagelabModule || '(không xác định)';
      imagelab.reason = `Không nạp được module MVP-02 "${modulePath}" — tính năng dịch ảnh bị tắt. Chi tiết ở log máy chủ (imagelab.wiring_failed).`;
      rootLogger.error('imagelab.wiring_failed', {
        module: modulePath,
        module_label: err?.imagelabLabel || null,
        // Không đưa cả object lỗi vào log: stack/message của Node chứa đường dẫn
        // tuyệt đối của máy. Chỉ ghi thông tin đã lọc.
        error_name: err?.cause?.name || err?.name || 'Error',
        error_code: err?.cause?.code || err?.code || null,
        error_message: scrubPaths(err?.message || err),
      });
    }
  }

  /* ── MVP-03 (ImageStudio) — nạp phòng thủ, KHÔNG được làm chết boot MVP-01/02 ──
   *
   * Module anh em (matting/retouch/pipeline) có thể chưa tồn tại hoặc lỗi cú pháp lúc
   * boot. Nạp lỗi ⇒ cả ba về `null`, ghi log `imagestudio.wiring_failed` mức error và
   * ghi lý do thật vào `app.imagestudioUnavailableReason` — MVP-01/MVP-02 vẫn chạy.
   * Storage dùng CHUNG với MVP-02 khi có (cùng `config.imagelab.dir`), nhưng KHÔNG phụ
   * thuộc vào việc khối ImageLab nạp thành công: hỏng thì tự nạp `imagelab/storage.js`.
   */
  const imagestudio = {
    mattingProvider: null,
    retouchProvider: null,
    imagestudioPipeline: null,
    storage: null,
    reason: null,
  };

  if (config?.imagestudio?.enabled === false) {
    imagestudio.reason = 'Tính năng tạo ảnh đang bị tắt bằng cấu hình (config.imagestudio.enabled = false / IMAGESTUDIO_ENABLED=false).';
    rootLogger.info('imagestudio.disabled', { reason: imagestudio.reason });
  } else if (opts.imagestudioPipeline && (opts.storage || imagelab.storage)) {
    // Đã được bơm sẵn (test hoặc tầng gộp) → dùng luôn, khỏi nạp module anh em.
    imagestudio.mattingProvider = opts.mattingProvider || null;
    imagestudio.retouchProvider = opts.retouchProvider || null;
    imagestudio.storage = opts.storage || imagelab.storage;
    imagestudio.imagestudioPipeline = opts.imagestudioPipeline;
  } else {
    try {
      const [mattingModule, retouchModule, storageModule, pipelineModule] = await Promise.all([
        importImagestudioModule('matting', './imagestudio/matting/index.js'),
        importImagestudioModule('retouch', './imagestudio/retouch/index.js'),
        importImagestudioModule('storage', './imagelab/storage.js'),
        importImagestudioModule('pipeline', './imagestudio/pipeline.js'),
      ]);

      const mattingProvider = opts.mattingProvider || mattingModule.createMattingProvider(config, { logger: rootLogger });
      const retouchProvider = opts.retouchProvider || retouchModule.createRetouchProvider(config, { logger: rootLogger });
      const storage = opts.storage || imagelab.storage || storageModule.createImageStorage(config, { logger: rootLogger });

      imagestudio.mattingProvider = mattingProvider;
      imagestudio.retouchProvider = retouchProvider;
      imagestudio.storage = storage;
      imagestudio.imagestudioPipeline = new pipelineModule.ImageGenerationPipeline({
        config,
        logger: rootLogger,
        store,
        storage,
        mattingProvider,
        retouchProvider,
      });
      rootLogger.info('imagestudio.wired', {
        matting: mattingProvider?.name || 'none',
        matting_mock: Boolean(mattingProvider?.isMock),
        retouch: retouchProvider?.name || 'none',
        retouch_mock: Boolean(retouchProvider?.isMock),
        storage: storage === imagelab.storage ? 'imagelab' : 'rieng',
      });
    } catch (err) {
      // Module anh em chưa tồn tại / lỗi lúc nạp → ImageStudio coi như không có mặt.
      imagestudio.mattingProvider = null;
      imagestudio.retouchProvider = null;
      imagestudio.imagestudioPipeline = null;
      imagestudio.storage = null;
      const modulePath = err?.imagestudioModule || '(không xác định)';
      imagestudio.reason = `Không nạp được module MVP-03 "${modulePath}" — tính năng tạo ảnh bị tắt. Chi tiết ở log máy chủ (imagestudio.wiring_failed).`;
      rootLogger.error('imagestudio.wiring_failed', {
        module: modulePath,
        module_label: err?.imagestudioLabel || null,
        // Không đưa cả object lỗi vào log: stack/message của Node chứa đường dẫn tuyệt đối.
        error_name: err?.cause?.name || err?.name || 'Error',
        error_code: err?.cause?.code || err?.code || null,
        error_message: scrubPaths(err?.message || err),
      });
    }
  }

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
    // MVP-02: null nếu khối ImageLab nạp lỗi (hợp đồng 4.6) — C5 phải kiểm trước khi dùng.
    ocrProvider: imagelab.ocrProvider,
    translator: imagelab.translator,
    renderProvider: imagelab.renderProvider,
    storage: imagelab.storage,
    imagelabPipeline: imagelab.imagelabPipeline,
    // Lý do THẬT (đã lọc đường dẫn) để `/api/health` + `/api/config` nói được vì sao
    // tính năng dịch ảnh không khả dụng. null = khả dụng.
    imagelabUnavailableReason: imagelab.reason,
    // MVP-03: null nếu khối ImageStudio nạp lỗi (E4 phải kiểm trước khi dùng → 503
    // IMAGESTUDIO_UNAVAILABLE), kèm lý do thật cho `/api/config`.
    mattingProvider: imagestudio.mattingProvider,
    retouchProvider: imagestudio.retouchProvider,
    imagestudioPipeline: imagestudio.imagestudioPipeline,
    imagestudioUnavailableReason: imagestudio.reason,
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
