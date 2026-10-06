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
 *
 * MVP-05: khối tài khoản (`src/accounts/**`) + ví credit (`src/billing/**`) nạp phòng thủ
 * y hệt. Hỏng/còn thiếu ⇒ `app.accountService`/`app.billingService` = null kèm lý do thật,
 * MVP-01/02/03 VẪN boot và chạy ở chế độ ẩn danh (luật #1: đăng nhập là tuỳ chọn).
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
 * Nạp MỘT module MVP-05 (tài khoản / ví credit) và gắn nhãn module vào lỗi — cùng khuôn
 * với hai hàm trên: log `accounts.wiring_failed` / `billing.wiring_failed` phải nói được
 * CHÍNH XÁC module nào hỏng. Message được lọc đường dẫn tuyệt đối trước khi vào log.
 */
async function importMvp05Module(label, specifier) {
  try {
    return await import(specifier);
  } catch (err) {
    const wrapped = new Error(`Không nạp được module MVP-05 "${specifier}" (${label}): ${scrubPaths(err?.message || err)}`);
    wrapped.mvp05Module = specifier;
    wrapped.mvp05Label = label;
    wrapped.cause = err;
    throw wrapped;
  }
}

/**
 * Operation DỰ KIẾN theo loại job — cơ sở để giữ tiền khi route chỉ truyền `kind`.
 *
 * Đây là ƯỚC TÍNH theo hướng GIỮ DƯ (upper bound): giữ thừa thì `settleForJob` hoàn lại
 * phần chênh theo usage THẬT, còn giữ thiếu thì job có thể chạy quá số dư. Vì vậy mỗi kind
 * liệt kê MỌI operation mà luồng đó có thể dùng, kể cả bước xảy ra sau (IMAGE_RENDER của
 * ImageLab chỉ chạy sau khi người dùng duyệt — vẫn nằm trong ước tính của job).
 */
const OPERATIONS_BY_KIND = Object.freeze({
  content: Object.freeze(['SOURCE_EXTRACT', 'VISION_ANALYSIS', 'TRANSLATION', 'CONTENT_GENERATE']),
  image_translation: Object.freeze(['OCR_DETECT', 'TRANSLATION', 'IMAGE_RENDER']),
  image_generation: Object.freeze(['IMAGE_MATTING', 'IMAGE_COMPOSE', 'IMAGE_RETOUCH']),
});

/**
 * Hook giữ tiền GỌI ĐƯỢC TỪ ROUTE (hợp đồng §3.4b) — object HẰNG, tồn tại kể cả khi
 * `billingService === null` để A4 gọi ổn định, không phải kiểm null.
 *
 * Vì sao cần: `POST /api/jobs` xếp hàng qua `queue.enqueue(...)`; handler có try/catch nên
 * lỗi ném từ TRONG pipeline không bao giờ ra tới HTTP ⇒ client nhận 202 rồi job `failed`,
 * tức là đã tiêu thời gian của người dùng rồi mới báo thiếu tiền. `beforeJob` được A4 gọi
 * NGAY TRONG REQUEST (sau `createJob`, trước `enqueue`) nên thiếu credit ⇒ **402 trước khi
 * job chạy**.
 *
 * Hai luật được giữ ở đây:
 *   #1 Ẩn danh (`userId` rỗng/null) ⇒ KHÔNG làm gì, không ví, không dòng sổ.
 *   #2 Sổ APPEND-ONLY + IDEMPOTENT THEO `jobId`: trước khi giữ/hoàn, hàm ĐỌC SỔ THẬT
 *      (`store.listLedger`) để biết job đã có dòng `job_hold`/`job_settle`/`job_refund` chưa.
 *      Nhờ vậy route gọi `beforeJob` rồi pipeline gọi lại (hoặc người dùng bấm hai lần) cũng
 *      KHÔNG BAO GIỜ giữ tiền hai lần — và điều đó được kiểm bằng DỮ LIỆU, không phải lời hứa.
 */
function createBillingHook({ service, store, logger, config, BillingError = null } = {}) {
  let disabledLogged = false;
  const configCurrency = () => String(config?.cost?.currency || 'USD');
  const currencyOf = (estimate) => String(estimate?.currency || configCurrency());

  /** Cảnh báo "ví tắt" đúng MỘT LẦN cho cả tiến trình (không spam theo từng job). */
  const noteDisabled = (step) => {
    if (disabledLogged) return;
    disabledLogged = true;
    logger?.warn?.('billing.disabled', {
      step,
      reason: 'Không có billingService — hook tính tiền bị bỏ qua, job vẫn chạy và không ai bị chặn.',
    });
  };

  /** Đọc sổ của MỘT job (rỗng nếu store không hỗ trợ) — nền tảng của tính idempotent. */
  const ledgerOfJob = async (userId, jobId) => {
    if (!userId || !jobId || typeof store?.listLedger !== 'function') return [];
    const rows = await store.listLedger({ userId, jobId, limit: 200 });
    return Array.isArray(rows) ? rows : [];
  };

  const heldAmount = (rows) => rows
    .filter((r) => r?.reason === 'job_hold')
    .reduce((sum, r) => sum + Math.abs(Number(r.amount) || 0), 0);

  const balanceOf = async (userId) => {
    if (typeof store?.ledgerBalance !== 'function') return null;
    const n = Number(await store.ledgerBalance(userId));
    return Number.isFinite(n) ? n : null;
  };

  /** Lỗi thiếu credit: dùng LẠI lỗi của A2 khi có (giữ đúng class BillingError), chỉ bù `details`. */
  const insufficient = (err, { required, balance, currency }) => {
    const message = 'Số dư credit không đủ để chạy job này.';
    const target = err && typeof err === 'object'
      ? err
      // Có class của A2 ⇒ ném ĐÚNG `BillingError` (để `instanceof` ở tầng trên vẫn đúng);
      // không có (service được bơm thủ công trong test) ⇒ lỗi thường mang `code` như hợp đồng.
      : (typeof BillingError === 'function'
        ? new BillingError('INSUFFICIENT_CREDIT', message)
        : Object.assign(new Error(message), { code: 'INSUFFICIENT_CREDIT' }));
    target.code = 'INSUFFICIENT_CREDIT';
    const details = target.details && typeof target.details === 'object' ? target.details : {};
    target.details = {
      ...details,
      required: Number.isFinite(Number(details.required)) ? Number(details.required) : required,
      balance: Number.isFinite(Number(details.balance)) ? Number(details.balance) : balance,
      currency: details.currency || currency,
    };
    return target;
  };

  const operationsOf = ({ kind, operations }) => {
    if (Array.isArray(operations) && operations.length > 0) return operations.map(String);
    return [...(OPERATIONS_BY_KIND[String(kind || 'content')] || OPERATIONS_BY_KIND.content)];
  };

  return {
    /** Giữ tiền TRƯỚC khi chạy. Thiếu credit ⇒ NÉM `INSUFFICIENT_CREDIT` (fail-closed có chủ ý). */
    async beforeJob({ userId = null, jobId = null, kind = 'content', sessionId = '', operations = null } = {}) {
      if (!service) {
        noteDisabled('beforeJob');
        return { held: 0, balance_after: null, currency: configCurrency() };
      }
      if (!userId) return { held: 0, balance_after: null, currency: configCurrency() }; // ẩn danh: luật #1
      if (!jobId) return { held: 0, balance_after: null, currency: configCurrency() };

      try {
        // IDEMPOTENT theo jobId: đã giữ rồi thì trả thông tin lần giữ CŨ, KHÔNG giữ nữa.
        const rows = await ledgerOfJob(userId, jobId);
        if (rows.some((r) => r?.reason === 'job_hold')) {
          return { held: heldAmount(rows), balance_after: await balanceOf(userId), currency: configCurrency(), skipped: true };
        }

        const ops = operationsOf({ kind, operations });
        const estimate = await service.estimate({ userId, operations: ops });
        const required = Number(estimate?.total ?? 0);
        const balance = await balanceOf(userId);
        // Kiểm TRƯỚC khi gọi A2 để `details` luôn có số đo THẬT, kể cả khi A2 ném lỗi trần.
        if (Number.isFinite(balance) && Number.isFinite(required) && balance < required) {
          throw insufficient(null, { required, balance, currency: currencyOf(estimate) });
        }
        let row = null;
        try {
          row = await service.holdForJob({ userId, jobId, estimate, operations: ops });
        } catch (err) {
          if (err?.code === 'INSUFFICIENT_CREDIT') {
            throw insufficient(err, { required, balance, currency: currencyOf(estimate) });
          }
          throw err;
        }
        const after = Number(row?.balance_after);
        return {
          held: Number.isFinite(Number(row?.amount)) ? Math.abs(Number(row.amount)) : required,
          balance_after: Number.isFinite(after) ? after : (Number.isFinite(balance) ? balance - required : null),
          currency: currencyOf(estimate),
          operation: ops.join('+'),
          job_id: jobId,
          session_id: sessionId || null,
        };
      } catch (err) {
        if (err?.code === 'INSUFFICIENT_CREDIT') throw err; // fail-closed: phải ra tới HTTP (402)
        // Lỗi ví khác (DB hỏng, A2 chưa sẵn sàng…) KHÔNG được biến thành job hỏng.
        logger?.warn?.('billing.hook_failed', {
          job_id: jobId,
          step: 'beforeJob',
          error_name: err?.name || 'Error',
          error_code: err?.code || null,
        });
        return { held: 0, balance_after: null, currency: configCurrency() };
      }
    },

    /** Kết thúc chu kỳ: `failed` ⇒ hoàn 100% phần đã giữ; ngược lại ⇒ quyết toán theo usage THẬT. */
    async afterJob({ userId = null, jobId = null, status = null, actualCost = null } = {}) {
      const out = { settled: false, refunded: 0 };
      if (!service) {
        noteDisabled('afterJob');
        return out;
      }
      if (!userId || !jobId) return out; // ẩn danh: không có ví để quyết toán

      try {
        const rows = await ledgerOfJob(userId, jobId);
        // IDEMPOTENT theo jobId: chu kỳ đã khép ⇒ không quyết toán/hoàn thêm lần nữa.
        if (rows.some((r) => r?.reason === 'job_settle' || r?.reason === 'job_refund')) {
          return { ...out, skipped: true };
        }
        const held = heldAmount(rows);

        if (String(status) === 'failed') {
          if (held <= 0) return { ...out, skipped: true }; // chưa giữ gì thì không có gì để hoàn
          const row = await service.refundForJob({ userId, jobId, reason: 'JOB_FAILED' });
          const refunded = Math.abs(Number(row?.amount));
          return { settled: false, refunded: Number.isFinite(refunded) && refunded > 0 ? refunded : held };
        }

        let cost = Number(actualCost);
        if (!Number.isFinite(cost)) {
          const summary = typeof store?.usageSummary === 'function' ? await store.usageSummary(jobId) : null;
          cost = Number(summary?.estimated_cost ?? 0);
        }
        await service.settleForJob({ userId, jobId, actualCost: cost });
        // `refunded` = phần GIỮ DƯ đã trả lại (0 nếu chi phí thật ≥ phần đã giữ).
        return { settled: true, refunded: Math.max(0, held - cost) };
      } catch (err) {
        logger?.warn?.('billing.hook_failed', {
          job_id: jobId,
          step: 'afterJob',
          error_name: err?.name || 'Error',
          error_code: err?.code || null,
        });
        return out;
      }
    },
  };
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
 * @param {object} [opts.accountService] [MVP-05] AccountService đã dựng sẵn (test)
 * @param {object} [opts.billingService] [MVP-05] BillingService đã dựng sẵn (test)
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

  /* ── MVP-05 (tài khoản + ví credit) — nạp PHÒNG THỦ, giống MVP-02/03 ─────────
   *
   * `src/accounts/**` (A1) và `src/billing/**` (A2) do agent khác viết song song nên có
   * thể CHƯA tồn tại lúc boot. Nạp lỗi ⇒ service = null, ghi log MỨC ERROR và ghi lý do
   * THẬT (đã lọc đường dẫn) vào `app.accountsUnavailableReason` / `app.billingUnavailableReason`.
   *
   * LUẬT #1 của MVP-05: đăng nhập là TUỲ CHỌN. Ví dụ ở đây chỉ ĐỔI việc có thu credit hay
   * không — MVP-01/02/03 vẫn boot và chạy đầy đủ ở chế độ ẩn danh (`billingService = null`
   * thì hook tính tiền tự bỏ qua, xem `#withBilling` trong 3 pipeline).
   *
   * Thứ tự cố ý: khối này đặt TRƯỚC khối ImageLab/ImageStudio để `billingService` được bơm
   * vào cả 3 pipeline ngay từ constructor (không phải gán ngược sau khi dựng).
   */
  const accounts = { service: null, reason: null };
  const billing = { service: null, reason: null };
  /** Class lỗi của A2 (nếu nạp được) — hook dùng để ném ĐÚNG `BillingError` (§3.4b). */
  let BillingErrorClass = null;

  if (config?.auth?.enabled === false) {
    accounts.reason = 'Tài khoản đang bị tắt bằng cấu hình (config.auth.enabled = false / AUTH_ENABLED=false).';
    rootLogger.info('accounts.disabled', { reason: accounts.reason });
  } else if (opts.accountService) {
    // Đã được bơm sẵn (test / tầng gộp) → dùng luôn, khỏi nạp module anh em.
    accounts.service = opts.accountService;
  } else {
    try {
      const accountsModule = await importMvp05Module('accounts', './accounts/index.js');
      if (typeof accountsModule.createAccountService !== 'function') {
        throw new Error('Module MVP-05 "./accounts/index.js" không xuất `createAccountService`.');
      }
      accounts.service = accountsModule.createAccountService(config, { store, logger: rootLogger });
    } catch (err) {
      accounts.service = null;
      const modulePath = err?.mvp05Module || './accounts/index.js';
      accounts.reason = `Không nạp được module MVP-05 "${modulePath}" — tính năng tài khoản bị tắt (chế độ ẩn danh vẫn chạy bình thường). Chi tiết ở log máy chủ (accounts.wiring_failed).`;
      rootLogger.error('accounts.wiring_failed', {
        module: modulePath,
        module_label: err?.mvp05Label || null,
        // Không đưa cả object lỗi vào log: stack/message của Node chứa đường dẫn tuyệt đối.
        error_name: err?.cause?.name || err?.name || 'Error',
        error_code: err?.cause?.code || err?.code || null,
        error_message: scrubPaths(err?.message || err),
      });
    }
  }

  if (config?.billing?.enabled === false) {
    billing.reason = 'Ví credit đang bị tắt bằng cấu hình (config.billing.enabled = false / BILLING_ENABLED=false).';
    rootLogger.info('billing.disabled', { reason: billing.reason });
  } else if (opts.billingService) {
    billing.service = opts.billingService;
  } else {
    try {
      const billingModule = await importMvp05Module('billing', './billing/index.js');
      if (typeof billingModule.createBillingService !== 'function') {
        throw new Error('Module MVP-05 "./billing/index.js" không xuất `createBillingService`.');
      }
      if (typeof billingModule.BillingError === 'function') BillingErrorClass = billingModule.BillingError;
      billing.service = billingModule.createBillingService(config, { store, logger: rootLogger });
    } catch (err) {
      billing.service = null;
      const modulePath = err?.mvp05Module || './billing/index.js';
      billing.reason = `Không nạp được module MVP-05 "${modulePath}" — ví credit bị tắt (job vẫn chạy, KHÔNG trừ credit). Chi tiết ở log máy chủ (billing.wiring_failed).`;
      rootLogger.error('billing.wiring_failed', {
        module: modulePath,
        module_label: err?.mvp05Label || null,
        error_name: err?.cause?.name || err?.name || 'Error',
        error_code: err?.cause?.code || err?.code || null,
        error_message: scrubPaths(err?.message || err),
      });
    }
  }

  /**
   * Hook giữ tiền gọi được từ route (§3.4b) — object HẰNG, có mặt kể cả khi ví tắt
   * (`billing.service = null`) để A4 gọi ổn định. Cùng object này cũng được bơm vào cả 3
   * pipeline để bước kết thúc (`afterJob`) chỉ có MỘT bản luật duy nhất.
   */
  const billingHook = createBillingHook({ service: billing.service, store, logger: rootLogger, config, BillingError: BillingErrorClass });

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
        // MVP-05: hook tính tiền (chỉ chạy khi job có `user_id`; null ⇒ bỏ qua hoàn toàn).
        billingService: billing.service,
        billingHook,
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
        // MVP-05: hook tính tiền (chỉ chạy khi job có `user_id`; null ⇒ bỏ qua hoàn toàn).
        billingService: billing.service,
        billingHook,
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
    // MVP-05: hook tính tiền (chỉ chạy khi job có `user_id`; null ⇒ bỏ qua hoàn toàn).
    billingService: billing.service,
    billingHook,
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
    // MVP-05: null nếu khối tài khoản/ví nạp lỗi hoặc bị tắt bằng cấu hình. `/api/config`
    // trả `accounts: { available: Boolean(app.accountService), reason: app.accountsUnavailableReason }`
    // (A4 dựng), và `GET /api/auth/me` trả `anonymous: true` khi service = null.
    accountService: accounts.service,
    billingService: billing.service,
    // §3.4b — A4 gọi `await app.billingHook.beforeJob({ userId, jobId, kind, sessionId })`
    // NGAY TRONG REQUEST (sau `createJob`, trước `queue.enqueue`); pipeline gọi `afterJob`
    // ở cuối mỗi lượt chạy thật. Object HẰNG, không bao giờ là null.
    billingHook,
    // Lý do THẬT (đã lọc đường dẫn) để `/api/health` + `/api/config` nói được VÌ SAO tính
    // năng tắt — im lặng là kiểu thất bại bị cấm. `null` = khả dụng.
    accountsUnavailableReason: accounts.reason,
    billingUnavailableReason: billing.reason,
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
