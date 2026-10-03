#!/usr/bin/env node
/**
 * Chạy migration (tạo bảng) cho driver đang cấu hình.
 *
 * Dùng: node src/store/migrate.js [--driver sqlite|postgres]
 */

import { loadDotEnv } from '../env.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createStore } from './index.js';

await loadDotEnv();

const args = process.argv.slice(2);
const driverFlag = args.indexOf('--driver');
const config = loadConfig(process.env);
if (driverFlag !== -1 && args[driverFlag + 1]) config.db.driver = args[driverFlag + 1];

const logger = createLogger({ level: config.logLevel });

try {
  const store = await createStore(config, logger);
  logger.info('migrate.done', { dialect: store.dialect, driver: config.db.driver });
  // Kiểm chứng thật: đếm bảng đã tạo, không chỉ tin lệnh đã chạy.
  const tables = store.isPostgres
    ? await store.driver.all("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")
    : await store.driver.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  console.log(JSON.stringify({ dialect: store.dialect, tables: tables.map((t) => t.name) }, null, 2));
  await store.close();
  process.exit(0);
} catch (err) {
  logger.error('migrate.failed', { error: err });
  console.error(`Migration thất bại: ${err.message}`);
  process.exit(1);
}
