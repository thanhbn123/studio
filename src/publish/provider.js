/**
 * P1 — CHỌN PROVIDER ĐĂNG BÀI theo cấu hình (hợp đồng §2.3).
 *
 * Soi gương `createOcrProvider` / `createRenderProvider` của MVP-02: tầng trên (app/route)
 * KHÔNG biết provider nào đang chạy, chỉ thấy một object cùng hình dạng (`PublishProvider`).
 *
 * ⚠️ FAIL-CLOSED: tên provider lạ ⇒ rơi về **`none`**, KHÔNG rơi về `dry-run`. Một lỗi chính tả
 * trong `.env` (`PUBLISH_PROVIDER=facebok`) không được âm thầm biến thành "đã đăng (giả)";
 * nó phải nói thẳng là chưa cấu hình.
 */

import { createDryRunProvider } from './providers/dry-run.js';
import { createFacebookPublishProvider } from './providers/facebook.js';
import { createNonePublishProvider } from './providers/none.js';

/** Tên provider hợp lệ (ĐÓNG BĂNG). */
export const PUBLISH_PROVIDER_NAMES = Object.freeze(['dry-run', 'facebook', 'none']);

/** Provider MẶC ĐỊNH của sprint này — chế độ thử, không gọi mạng. */
export const DEFAULT_PUBLISH_PROVIDER = 'dry-run';

export function createPublishProvider(config = {}, { logger = null, fetchImpl = undefined } = {}) {
  const raw = String(config?.publish?.provider ?? '').trim().toLowerCase() || DEFAULT_PUBLISH_PROVIDER;

  if (raw === 'dry-run') return createDryRunProvider(config, { logger });
  if (raw === 'facebook') return createFacebookPublishProvider(config, { logger, ...(fetchImpl ? { fetchImpl } : {}) });
  if (raw === 'none') return createNonePublishProvider(config, { logger });

  logger?.warn?.('publish.provider_unknown', {
    provider: raw.slice(0, 40),
    allowed: PUBLISH_PROVIDER_NAMES,
    message: 'Tên provider đăng bài không hợp lệ — fail-closed về "none" (KHÔNG rơi về dry-run).',
  });
  return createNonePublishProvider(config, {
    logger,
    reason:
      `PUBLISH_PROVIDER="${raw.slice(0, 40)}" không hợp lệ (chỉ nhận: ${PUBLISH_PROVIDER_NAMES.join(', ')}). `
      + 'Đường đăng bài đã TẮT để không đăng sai — sửa cấu hình rồi khởi động lại.',
  });
}

export default createPublishProvider;
