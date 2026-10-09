/**
 * ĐĂNG BÀI FACEBOOK PAGE (MVP-07) — mặt tiền của `src/publish/**` (P1).
 *
 * Hợp đồng `docs/MVP-07-CONTRACT.md` chốt đúng những thứ dưới đây; P3 (route) và P4 (UI) chỉ
 * cần import từ file này.
 *
 * ```js
 * import { createPublishProvider, PublishService, PublishError, PUBLISH_CODES } from '../publish/index.js';
 *
 * const provider = createPublishProvider(config, { logger });        // mặc định: 'dry-run'
 * const service  = new PublishService({ store, provider, config, logger });
 *
 * // Tạo nháp từ job:
 * const { item } = await service.createItem({ job, userId, text, mediaIds, submit: true });
 *
 * // owner/admin duyệt:
 * await service.approve(item.id, { by: admin.id });
 *
 * // Chỉ SAU khi duyệt mới đăng được; chưa duyệt ⇒ PublishError('NOT_APPROVED'):
 * const { result, called, idempotent } = await service.publishItem(item.id, { media });
 * ```
 *
 * ⚠️ TRẠNG THÁI THẬT (09/10/2026): dự án **CHƯA có Page ID + Page Access Token** (cần Facebook
 * app review), nên provider mặc định là **`dry-run`** và **chưa có bài nào được đăng thật**.
 * Cách cắm token khi có — không sửa một dòng mã nào:
 *
 * ```sh
 * PUBLISH_PROVIDER=facebook
 * FACEBOOK_PAGE_ID=<id của Page>
 * FACEBOOK_PAGE_ACCESS_TOKEN=<Page Access Token sau app review>
 * ```
 *
 * Hợp đồng dữ liệu cho P3/P4 (ĐÓNG BĂNG trong sprint này):
 *
 *  · `PublishProvider` = `{ name, channel, model, configured, isMock, probe(), publish() }`.
 *  · `publish({ text, media, scheduledAt })` trả
 *    `{ status, post_id, url, error_code, error_message, is_mock, provider, scheduled_at, raw }`
 *    với `status ∈ { PUBLISHED, SCHEDULED, NOT_CONFIGURED, FAILED }` — **không bao giờ ném lỗi**.
 *  · `service.publishItem()` trả `{ item, result, called, idempotent }`; `called = false` nghĩa là
 *    provider KHÔNG được gọi (bài đã đăng trước đó — luật "một bài chỉ đăng một lần").
 *  · Lỗi: `PublishError` có `.code` thuộc `PUBLISH_CODES` — P3 map sang HTTP theo §2.6
 *    (`NOT_APPROVED` ⇒ 409, `ITEM_NOT_FOUND` ⇒ 404, `NOT_CONFIGURED` ⇒ 409, …).
 *  · `PublishError` KHÔNG BAO GIỜ chứa access token hay đường dẫn đĩa.
 */

export { PublishError, PUBLISH_CODES } from './errors.js';
export {
  PUBLISH_STATUSES,
  PUBLISH_CHANNELS,
  PUBLISH_TERMINAL,
  PUBLISHABLE_STATUSES,
  APPROVABLE_STATUSES,
  DEFAULT_CHANNEL,
  canTransition,
  draftTextFromJob,
  isPublishable,
  isPublishChannel,
  isPublishStatus,
  normalizeMediaIds,
  normalizePublishText,
  normalizeSchedule,
  publishRunKey,
} from './items.js';
export {
  createPublishProvider,
  PUBLISH_PROVIDER_NAMES,
  DEFAULT_PUBLISH_PROVIDER,
} from './provider.js';
export { createDryRunProvider, dryRunPostId, DRY_RUN_PREFIX, DRY_RUN_NOTICE } from './providers/dry-run.js';
export {
  createFacebookPublishProvider,
  maskToken,
  graphHostOf,
  DEFAULT_API_VERSION,
  DEFAULT_GRAPH_BASE_URL,
  FACEBOOK_NOT_CONFIGURED_MESSAGE,
} from './providers/facebook.js';
export { createNonePublishProvider, NONE_MESSAGE } from './providers/none.js';
export { PublishService } from './service.js';
