/**
 * GIỚI HẠN TÀI NGUYÊN của gói xuất bản — R6 (phản biện vòng 2, MEDIUM).
 *
 * Vấn đề đo được (script `/tmp/x-atk/a3c-resource.mjs` + `/tmp/x-atk2/**`): `GET /bundle` dựng
 * TRỌN gói trong RAM — 60 MB asset ⇒ **+270 MB RSS** (~4,5×) và ~1,8 s; trần cũ 512 MB ⇒ một
 * request hợp lệ có thể cấp phát ~2 GB, và KHÔNG có gì giới hạn số request **đồng thời**.
 *
 * Hai thứ trong file này vá đúng hai nửa của vấn đề:
 *
 *  1. `resolveExportLimits(env)` — TRẦN KÍCH THƯỚC GÓI có cấu hình (`EXPORT_MAX_BUNDLE_BYTES`,
 *     mặc định `DEFAULT_MAX_BUNDLE_BYTES` = 64 MiB). Vượt trần ⇒ `BUNDLE_TOO_LARGE`
 *     (route map **413**) kèm SỐ ĐO (`bytes`, `limit`), không bao giờ dựng tiếp để ăn hết RAM.
 *  2. `createExportGate()` — cổng giới hạn SỐ LƯỢT DỰNG GÓI ĐỒNG THỜI (`EXPORT_MAX_CONCURRENT_BUNDLES`,
 *     mặc định 1) + hàng đợi ngắn (`EXPORT_MAX_QUEUED_BUNDLES`, mặc định 4). Quá tải ⇒
 *     `EXPORT_BUSY` (route map **429**) NGAY, không xếp hàng vô hạn; chờ quá `EXPORT_MAX_WAIT_MS`
 *     cũng trả `EXPORT_BUSY` (có `retry_after_ms`) thay vì treo request.
 *
 * Vì sao mặc định là 1 lượt đồng thời: bộ nhớ đỉnh của một lượt ≈ 4,5× kích thước asset, nên
 * 2 lượt song song ở trần 64 MiB đã có thể chạm ~600 MB RSS — vượt xa mức an toàn của tiến trình.
 * Vận hành muốn nhanh hơn thì nâng `EXPORT_MAX_CONCURRENT_BUNDLES` và hạ `EXPORT_MAX_BUNDLE_BYTES`
 * cho tương xứng (số đo thật ở `docs/VERIFICATION.md` §24.5).
 *
 * KHÔNG import gì từ `src/app.js`/`src/config.js`: khối này đọc env qua tham số để test được và
 * để X2 (route) tự quyết điểm áp dụng.
 */

import { ExportError, EXPORT_CODES } from './errors.js';

/** Trần kích thước gói mặc định: 64 MiB (đo được: một lượt ~4,5× ⇒ ~290 MB RSS đỉnh). */
export const DEFAULT_MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/** Số lượt dựng gói ĐỒNG THỜI mặc định — 1 (xem lý do ở đầu file). */
export const DEFAULT_MAX_CONCURRENT_BUNDLES = 1;

/** Số request được XẾP HÀNG chờ một lượt trống (0 = quá tải là trả 429 ngay). */
export const DEFAULT_MAX_QUEUED_BUNDLES = 4;

/** Thời gian chờ tối đa trong hàng đợi trước khi trả `EXPORT_BUSY` (ms). */
export const DEFAULT_MAX_WAIT_MS = 30_000;

const toInt = (raw, fallback, { min = 1 } = {}) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
};

/**
 * Đọc giới hạn từ env. Giá trị sai/âm/không phải số ⇒ rơi về mặc định (KHÔNG bao giờ thành 0
 * hay NaN — "cấu hình hỏng" không được biến thành "không giới hạn").
 *
 * @param {object} [env] mặc định `process.env`
 * @returns {{maxBundleBytes: number, maxConcurrentBundles: number, maxQueuedBundles: number, maxWaitMs: number}}
 */
export function resolveExportLimits(env = process.env) {
  return {
    maxBundleBytes: toInt(env?.EXPORT_MAX_BUNDLE_BYTES, DEFAULT_MAX_BUNDLE_BYTES),
    maxConcurrentBundles: toInt(env?.EXPORT_MAX_CONCURRENT_BUNDLES, DEFAULT_MAX_CONCURRENT_BUNDLES),
    // Hàng đợi được phép = 0 (quá tải ⇒ 429 ngay) nên sàn là 0, không phải 1.
    maxQueuedBundles: toInt(env?.EXPORT_MAX_QUEUED_BUNDLES, DEFAULT_MAX_QUEUED_BUNDLES, { min: 0 }),
    maxWaitMs: toInt(env?.EXPORT_MAX_WAIT_MS, DEFAULT_MAX_WAIT_MS, { min: 0 }),
  };
}

/**
 * Cổng giới hạn số lượt dựng gói đồng thời.
 *
 * @param {object} [options]
 * @param {number} [options.concurrency] số lượt chạy song song (kẹp ≥ 1)
 * @param {number} [options.queueLimit] số request được chờ (kẹp ≥ 0)
 * @param {number} [options.maxWaitMs] chờ tối đa trong hàng đợi (kẹp ≥ 0)
 * @param {() => number} [options.now] đồng hồ (test bơm được)
 * @returns {{run: (fn: Function) => Promise<*>, stats: () => object, concurrency: number,
 *   queueLimit: number, maxWaitMs: number}}
 */
export function createExportGate({ concurrency, queueLimit, maxWaitMs, now = Date.now } = {}) {
  const parseIntOr = (value, fallback) => {
    const n = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) ? n : fallback;
  };
  const limit = Math.max(1, parseIntOr(concurrency, DEFAULT_MAX_CONCURRENT_BUNDLES));
  const queueMax = Math.max(0, parseIntOr(queueLimit, DEFAULT_MAX_QUEUED_BUNDLES));
  const waitLimit = Math.max(0, parseIntOr(maxWaitMs, DEFAULT_MAX_WAIT_MS));
  let running = 0;
  const waiting = [];

  const stats = () => ({
    running,
    queued: waiting.length,
    concurrency: limit,
    queue_limit: queueMax,
  });

  const busy = (message, details) => new ExportError(EXPORT_CODES.EXPORT_BUSY, message, details);

  const acquire = () => {
    if (running < limit) {
      running += 1;
      return Promise.resolve();
    }
    if (waiting.length >= queueMax) {
      return Promise.reject(
        busy(
          `Máy chủ đang dựng ${running} gói xuất bản và hàng đợi đã đầy (${waiting.length}/${queueMax}) — từ chối thêm để không ăn hết bộ nhớ.`,
          { ...stats(), retry_after_ms: 2000 },
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null, at: now() };
      entry.timer = setTimeout(() => {
        const idx = waiting.indexOf(entry);
        if (idx >= 0) waiting.splice(idx, 1);
        reject(
          busy(
            `Chờ quá ${waitLimit} ms mà chưa có lượt dựng gói trống — từ chối để không treo request.`,
            { ...stats(), waited_ms: Math.max(0, now() - entry.at), retry_after_ms: 2000 },
          ),
        );
      }, waitLimit);
      entry.timer?.unref?.();
      waiting.push(entry);
    });
  };

  const release = () => {
    const next = waiting.shift();
    if (next) {
      // Nhường thẳng lượt cho người chờ đầu tiên — `running` giữ nguyên (không nhả rồi chiếm lại).
      clearTimeout(next.timer);
      next.resolve();
      return;
    }
    running = Math.max(0, running - 1);
  };

  return {
    /**
     * Chạy `fn` trong một lượt của cổng. `fn` ném lỗi ⇒ lỗi đó được truyền nguyên vẹn ra ngoài
     * (cổng chỉ quản lý LƯỢT, không nuốt lỗi nghiệp vụ).
     */
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    stats,
    concurrency: limit,
    queueLimit: queueMax,
    maxWaitMs: waitLimit,
  };
}

export default createExportGate;
