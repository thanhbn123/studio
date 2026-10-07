#!/usr/bin/env node
/**
 * Điểm khởi động ứng dụng.
 *
 * Dùng: node src/server.js
 */

import { loadDotEnv } from './env.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createApp } from './app.js';
import { createScheduler } from './scheduler.js';

const loadedEnvFiles = await loadDotEnv();
const config = loadConfig(process.env);
const logger = createLogger({ level: config.logLevel });

let app;
try {
  app = await createApp({ config, logger });
} catch (err) {
  logger.error('startup.failed', { error: err });
  console.error(`Không khởi động được ứng dụng: ${err.message}`);
  process.exit(1);
}

const { server } = app;

/**
 * R1 (§4) — CRON DỌN DẸP: thu hồi lượt chạy treo (MVP-05) + trả mục hàng đợi chết về hàng đợi
 * (R1-Q). Tạo SAU khi app sẵn sàng (store/DB đã mở). `runOnce()` gọi được thủ công để test
 * không cần thời gian thật; timer của `start()` đã `unref()` nên không giữ tiến trình sống.
 *
 * Vẫn TẠO scheduler khi bị tắt bằng cấu hình — để `/api/health` nói được `enabled: false`
 * thay vì im lặng (im lặng là kiểu thất bại bị cấm).
 */
const scheduler = createScheduler({ app, store: app.store, config, logger });
app.scheduler = scheduler;
// `app.close()` phải tắt cron TRƯỚC khi đóng server/DB — bọc lại thay vì sửa `src/app.js`
// (file của R1-Q). Nhờ vậy cả `shutdown()` lẫn nơi gọi `app.close()` khác đều tắt sạch.
const closeApp = app.close.bind(app);
app.close = async () => {
  await scheduler.stop();
  return closeApp();
};
if (config.scheduler?.enabled !== false) {
  scheduler.start();
} else {
  logger.info('scheduler.disabled', {
    message: 'SCHEDULER_ENABLED=false — không chạy nhịp dọn dẹp nào (không có timer).',
  });
}

server.listen(config.port, config.host, () => {
  logger.info('server.listening', {
    url: `http://${config.host}:${config.port}`,
    env: config.env,
    db_driver: config.db.driver,
    db_dialect: app.store.dialect,
    env_files: loadedEnvFiles.map((f) => f.split('/').pop()),
    content_provider: app.contentEngine.providerName,
    content_configured: Boolean(app.contentEngine.configured),
    vision_provider: app.visionProvider.name,
    vision_configured: Boolean(app.visionProvider.configured),
    session_mode: config.session.mode,
    connectors: app.registry.list().map((c) => c.source),
    connector_init_failures: app.registry.initFailures,
    // R1 (§4): cron có đang chạy không + nhịp bao nhiêu (không lộ bí mật/đường dẫn).
    scheduler_enabled: config.scheduler?.enabled !== false,
    scheduler_running: scheduler.stats().running,
    scheduler_interval_ms: config.scheduler?.intervalMs ?? null,
  });
  // Cảnh báo rõ nếu thiếu AI — người dùng cần biết TRƯỚC khi dán link.
  if (!app.contentEngine.configured) {
    logger.warn('startup.no_ai_provider', {
      message: 'Chưa cấu hình AI_API_KEY — pipeline vẫn trích xuất được nhưng KHÔNG sinh được nội dung tiếng Việt.',
    });
  }
});

server.on('error', (err) => {
  logger.error('server.error', { error: err });
  process.exit(1);
});

/** Tắt êm: tắt cron (qua `app.close` đã bọc), đóng server, đợi job đang chạy, đóng DB. */
async function shutdown(signal) {
  logger.info('server.shutdown', { signal });
  const timer = setTimeout(() => {
    logger.warn('server.shutdown_forced', { signal });
    process.exit(1);
  }, 10000);
  timer.unref?.();
  try {
    await app.close();
  } catch (err) {
    logger.error('server.shutdown_error', { error: err });
  }
  clearTimeout(timer);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('process.unhandled_rejection', { error: reason });
});
process.on('uncaughtException', (err) => {
  logger.error('process.uncaught_exception', { error: err });
});
