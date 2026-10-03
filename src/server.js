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

/** Tắt êm: đóng server, đợi job đang chạy, đóng DB. */
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
