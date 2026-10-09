/**
 * P1 — `PublishService`: CỔNG DUYỆT + IDEMPOTENCY + VẾT (hợp đồng MVP-07 §2.4).
 *
 * Đây là chỗ DUY NHẤT trong mã nguồn được phép gọi `provider.publish()`. Mọi đường khác
 * (route, UI, cron) phải đi qua `publishItem()` — nhờ vậy luật "không bao giờ tự đăng khi chưa
 * duyệt" chỉ cần đúng ở một chỗ.
 *
 * Thứ tự trong `publishItem()` KHÔNG ĐƯỢC ĐẢO:
 *   1. `store.claimPublishItem()` — câu UPDATE có điều kiện ở tầng DB (cổng duyệt).
 *   2. Claim thất bại ⇒ đọc lại bản ghi, trả lý do đúng — **chưa một dòng mạng nào chạy**.
 *   3. Claim thành công ⇒ GIỜ MỚI gọi provider.
 *   4. Ghi `publish_logs` cho MỌI lời gọi (thành công hay thất bại), rồi chốt `publish_items`.
 */

import { randomUUID } from 'node:crypto';

import { PublishError, PUBLISH_CODES } from './errors.js';
import {
  APPROVABLE_STATUSES,
  DEFAULT_CHANNEL,
  canTransition,
  draftTextFromJob,
  isPublishChannel,
  normalizeMediaIds,
  normalizePublishText,
  normalizeSchedule,
} from './items.js';

export class PublishService {
  constructor({ store, provider, config = {}, logger = null } = {}) {
    if (!store || typeof store.createPublishItem !== 'function') {
      throw new PublishError(PUBLISH_CODES.BAD_INPUT, 'PublishService cần `store` có các hàm publish_* (store quá cũ?).');
    }
    if (!provider || typeof provider.publish !== 'function') {
      throw new PublishError(PUBLISH_CODES.BAD_INPUT, 'PublishService cần `provider` đúng hình dạng PublishProvider.');
    }
    this.store = store;
    this.provider = provider;
    this.config = config || {};
    this.logger = logger;
  }

  get maxTextLength() {
    const n = Number(this.config?.publish?.maxTextLength);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 63206;
  }

  get maxMedia() {
    const n = Number(this.config?.publish?.maxMedia);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
  }

  get maxAttempts() {
    const n = Number(this.config?.publish?.maxAttempts);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 3;
  }

  /** Thông tin provider cho `/api/config` — CHỈ cờ, KHÔNG token, KHÔNG Page ID. */
  providerInfo() {
    return {
      name: String(this.provider?.name || 'none'),
      channel: String(this.provider?.channel || DEFAULT_CHANNEL),
      configured: Boolean(this.provider?.configured),
      is_mock: Boolean(this.provider?.isMock),
      notice: String(this.provider?.notice || ''),
    };
  }

  /** `probe()` của provider — không bao giờ ném ra ngoài. */
  async probe() {
    try {
      return await this.provider.probe();
    } catch (err) {
      return {
        ok: false,
        name: String(this.provider?.name || 'none'),
        channel: String(this.provider?.channel || DEFAULT_CHANNEL),
        configured: Boolean(this.provider?.configured),
        is_mock: Boolean(this.provider?.isMock),
        page_id: '',
        error_code: String(err?.code || PUBLISH_CODES.PROVIDER_FAILED),
        message: String(err?.message ?? err).slice(0, 500),
      };
    }
  }

  /**
   * Tạo bài NHÁP từ một job.
   *
   * `text` rỗng ⇒ lấy GỢI Ý từ nội dung job (`draftTextFromJob`) — job chưa có nội dung thì gợi ý
   * cũng rỗng và ta báo `BAD_INPUT`, KHÔNG bịa chữ.
   *
   * `submit: true` ⇒ tạo luôn ở `pending_review`. KHÔNG có đường nào tạo ra `approved`: duyệt
   * phải là một hành động RIÊNG của owner/admin (luật §0.1).
   */
  async createItem({ job = null, userId = null, text = '', mediaIds = [], channel = DEFAULT_CHANNEL, scheduledAt = null, submit = false } = {}) {
    const uid = String(userId ?? '').trim();
    if (!uid) throw new PublishError(PUBLISH_CODES.BAD_INPUT, 'Bài đăng phải có chủ (cần đăng nhập) — đăng bài là hành động ra ngoài, phải có người chịu trách nhiệm.');
    if (!job || !job.id) throw new PublishError(PUBLISH_CODES.BAD_INPUT, 'Thiếu job nguồn cho bài đăng.');
    const ch = String(channel || DEFAULT_CHANNEL);
    if (!isPublishChannel(ch)) {
      throw new PublishError(PUBLISH_CODES.BAD_INPUT, `Kênh "${ch.slice(0, 40)}" chưa được hỗ trợ (sprint này chỉ Facebook Page).`, { channel: ch });
    }

    const raw = String(text ?? '').trim() ? text : draftTextFromJob(job);
    const norm = normalizePublishText(raw, { maxLength: this.maxTextLength });
    const media = normalizeMediaIds(mediaIds, { maxMedia: this.maxMedia });
    const sched = normalizeSchedule(scheduledAt);

    if (!norm.text && media.mediaIds.length === 0) {
      throw new PublishError(
        PUBLISH_CODES.BAD_INPUT,
        'Bài đăng không có nội dung và cũng không có ảnh/video. Job này chưa có nội dung để gợi ý — hãy tự viết nội dung.',
        { job_id: job.id },
      );
    }
    if (norm.tooLong) {
      throw new PublishError(PUBLISH_CODES.TEXT_TOO_LONG, `Nội dung dài ${norm.length} ký tự, vượt trần ${this.maxTextLength}.`, { length: norm.length, max: this.maxTextLength });
    }
    if (media.tooMany) {
      throw new PublishError(PUBLISH_CODES.MEDIA_TOO_MANY, `Bài có ${media.mediaIds.length} media, vượt trần ${this.maxMedia}.`, { count: media.mediaIds.length, max: this.maxMedia });
    }
    if (sched.bad) {
      throw new PublishError(PUBLISH_CODES.BAD_SCHEDULE, 'Mốc hẹn giờ phải là thời điểm ISO-8601 trong tương lai.');
    }

    const item = await this.store.createPublishItem({
      id: randomUUID(),
      jobId: job.id,
      userId: uid,
      channel: ch,
      text: norm.text,
      mediaIds: media.mediaIds,
      status: submit === true ? 'pending_review' : 'draft',
      scheduledAt: sched.scheduledAt,
    });
    this.logger?.info?.('publish.item_created', {
      item_id: item?.id,
      job_id: job.id,
      status: item?.status,
      text_length: norm.length,
      media_count: media.mediaIds.length,
    });
    return { item, warnings: norm.warnings, dropped_media: media.dropped };
  }

  /** `draft` → `pending_review` (chủ bài gửi duyệt). */
  async submit(itemId, { actorId = null } = {}) {
    const item = await this.#requireItem(itemId);
    if (!canTransition(item.status, 'pending_review')) {
      throw this.#badState(item, 'pending_review');
    }
    const next = await this.store.setPublishItemStatus(item.id, { from: ['draft'], to: 'pending_review' });
    if (!next) throw await this.#raceError(item.id, 'pending_review');
    this.logger?.info?.('publish.item_submitted', { item_id: item.id, actor: actorId ? 'user' : 'unknown' });
    return next;
  }

  /**
   * DUYỆT — chỉ owner/admin (tầng HTTP đã kiểm `requireAdmin`; ở đây kiểm `by` để service dùng
   * được ngoài HTTP mà vẫn ghi được AI đã duyệt).
   */
  async approve(itemId, { by = null } = {}) {
    const approver = String(by ?? '').trim();
    if (!approver) throw new PublishError(PUBLISH_CODES.BAD_INPUT, 'Duyệt bài phải ghi được AI duyệt (thiếu `by`).');
    const item = await this.#requireItem(itemId);
    if (!canTransition(item.status, 'approved')) throw this.#badState(item, 'approved');
    const next = await this.store.setPublishItemStatus(item.id, {
      from: [...APPROVABLE_STATUSES],
      to: 'approved',
      patch: { approved_by: approver, approved_at: new Date().toISOString(), rejected_by: null, rejected_at: null, reject_reason: null },
    });
    if (!next) throw await this.#raceError(item.id, 'approved');
    this.logger?.info?.('publish.item_approved', { item_id: item.id, approved_by: approver });
    return next;
  }

  /** TỪ CHỐI — chỉ owner/admin. `rejected` là trạng thái KẾT THÚC. */
  async reject(itemId, { by = null, reason = '' } = {}) {
    const actor = String(by ?? '').trim();
    if (!actor) throw new PublishError(PUBLISH_CODES.BAD_INPUT, 'Từ chối bài phải ghi được AI từ chối (thiếu `by`).');
    const item = await this.#requireItem(itemId);
    if (!canTransition(item.status, 'rejected')) throw this.#badState(item, 'rejected');
    const next = await this.store.setPublishItemStatus(item.id, {
      from: ['draft', 'pending_review', 'approved', 'failed'],
      to: 'rejected',
      patch: { rejected_by: actor, rejected_at: new Date().toISOString(), reject_reason: String(reason ?? '').slice(0, 1000) },
    });
    if (!next) throw await this.#raceError(item.id, 'rejected');
    this.logger?.info?.('publish.item_rejected', { item_id: item.id, rejected_by: actor });
    return next;
  }

  /**
   * ĐĂNG — đường DUY NHẤT gọi tới provider.
   *
   * @returns {{ item, result, called, idempotent }} `called = false` nghĩa là provider KHÔNG
   *          được gọi (đã đăng trước đó) — tầng trên dùng field này để khẳng định luật §0.4.
   */
  async publishItem(itemId, { actorId = null, media = null } = {}) {
    const before = await this.#requireItem(itemId);

    // §0.4 — ĐÃ ĐĂNG: trả lại kết quả cũ, KHÔNG gọi provider lần hai. Không phải lỗi.
    if (before.status === 'published' || before.external_post_id) {
      this.logger?.info?.('publish.item_already_published', { item_id: before.id, external_post_id: before.external_post_id });
      return {
        item: before,
        result: {
          status: 'PUBLISHED',
          post_id: before.external_post_id,
          url: before.external_url ?? null,
          error_code: null,
          error_message: '',
          is_mock: Boolean(before.is_mock),
          provider: before.provider ?? this.provider.name,
          scheduled_at: before.scheduled_at ?? null,
          raw: null,
        },
        called: false,
        idempotent: true,
      };
    }

    // Provider tắt hẳn ⇒ nói thẳng TRƯỚC khi claim (claim rồi mới biết thì bài mắc ở `publishing`).
    if (String(this.provider.name) === 'none') {
      throw new PublishError(PUBLISH_CODES.PROVIDER_DISABLED, String(this.provider.notice || 'Đường đăng bài đang tắt.'), { provider: 'none' });
    }
    if (before.attempts >= this.maxAttempts) {
      throw new PublishError(
        PUBLISH_CODES.ATTEMPTS_EXHAUSTED,
        `Bài đã thử đăng ${before.attempts} lần, chạm trần ${this.maxAttempts}. Hãy xem lỗi gần nhất rồi tạo bài mới.`,
        { attempts: before.attempts, max: this.maxAttempts },
      );
    }

    /* ── BƯỚC 1: CỔNG DUYỆT ở tầng DB. Tới đây CHƯA có dòng mạng nào chạy. ── */
    const claimed = await this.store.claimPublishItem(before.id, { provider: this.provider.name });
    if (!claimed) {
      // BƯỚC 2: claim thất bại ⇒ đọc lại và nói ĐÚNG lý do.
      throw await this.#claimFailure(before.id);
    }

    /* ── BƯỚC 3: GIỜ MỚI được gọi provider. ── */
    const mediaRefs = Array.isArray(media) ? media : [];
    let result;
    try {
      result = await this.provider.publish({
        text: claimed.text,
        media: mediaRefs,
        scheduledAt: claimed.scheduled_at,
      });
    } catch (err) {
      // Hợp đồng §2.1: `publish()` KHÔNG được ném. Provider nào ném thì coi là FAILED, không để
      // bài mắc mãi ở `publishing`.
      result = {
        status: 'FAILED',
        post_id: null,
        url: null,
        error_code: String(err?.code || PUBLISH_CODES.PROVIDER_FAILED),
        error_message: String(err?.message ?? err).slice(0, 1000),
        is_mock: Boolean(this.provider.isMock),
        provider: String(this.provider.name),
        scheduled_at: null,
        raw: null,
      };
    }

    /* ── BƯỚC 4: ghi vết MỌI lời gọi, rồi chốt trạng thái. ── */
    const ok = result?.status === 'PUBLISHED' || result?.status === 'SCHEDULED';
    try {
      await this.store.appendPublishLog({
        itemId: claimed.id,
        attempt: claimed.attempts,
        runKey: claimed.run_key,
        provider: String(result?.provider || this.provider.name),
        channel: claimed.channel,
        status: String(result?.status ?? 'FAILED'),
        externalPostId: result?.post_id ?? null,
        errorCode: result?.error_code ?? null,
        errorMessage: String(result?.error_message ?? ''),
        isMock: Boolean(result?.is_mock),
        requestSummary: {
          endpoint: result?.raw?.endpoint ?? null,
          http_status: result?.raw?.http_status ?? null,
          text_length: [...String(claimed.text ?? '')].length,
          media_count: mediaRefs.length,
          scheduled: Boolean(claimed.scheduled_at),
        },
      });
    } catch (err) {
      // Ghi vết lỗi KHÔNG được làm mất kết quả đăng (bài đã lên Facebook rồi).
      this.logger?.error?.('publish.log_write_failed', { item_id: claimed.id, error_code: err?.code || null });
    }

    const finished = await this.store.finishPublishItem(claimed.id, {
      status: ok ? 'published' : 'failed',
      externalPostId: ok ? result.post_id : null,
      externalUrl: ok ? result.url ?? null : null,
      publishedAt: ok ? new Date().toISOString() : null,
      errorCode: ok ? null : String(result?.error_code ?? PUBLISH_CODES.PROVIDER_FAILED),
      lastError: ok ? null : String(result?.error_message ?? '').slice(0, 2000),
      isMock: Boolean(result?.is_mock),
      provider: String(result?.provider || this.provider.name),
    });

    this.logger?.[ok ? 'info' : 'error']?.('publish.item_finished', {
      item_id: claimed.id,
      status: ok ? 'published' : 'failed',
      provider: String(result?.provider || this.provider.name),
      is_mock: Boolean(result?.is_mock),
      attempt: claimed.attempts,
      error_code: ok ? null : result?.error_code ?? null,
    });

    return {
      item: finished || (await this.store.getPublishItem(claimed.id)),
      result,
      called: true,
      idempotent: false,
    };
  }

  /* ───────────────────────────── nội bộ ───────────────────────────── */

  async #requireItem(itemId) {
    const id = String(itemId ?? '').trim();
    if (!id) throw new PublishError(PUBLISH_CODES.BAD_INPUT, 'Thiếu mã bài đăng.');
    const item = await this.store.getPublishItem(id);
    if (!item) throw new PublishError(PUBLISH_CODES.ITEM_NOT_FOUND, 'Không tìm thấy bài đăng.', { item_id: id });
    return item;
  }

  #badState(item, to) {
    return new PublishError(
      PUBLISH_CODES.BAD_STATE,
      `Bài đang ở trạng thái "${item.status}" nên không chuyển sang "${to}" được.`,
      { item_id: item.id, from: item.status, to },
    );
  }

  /** `UPDATE` đụng 0 dòng = người khác vừa đổi trạng thái ⇒ đọc lại rồi nói đúng lý do. */
  async #raceError(itemId, to) {
    const now = await this.store.getPublishItem(itemId);
    if (!now) return new PublishError(PUBLISH_CODES.ITEM_NOT_FOUND, 'Không tìm thấy bài đăng.', { item_id: itemId });
    return this.#badState(now, to);
  }

  /**
   * Lý do THẬT khi không claim được — đây là chỗ phát biểu luật §0.1 ra thành câu người đọc được.
   * Quan trọng: hàm này chạy SAU khi claim thất bại, nên provider CHẮC CHẮN chưa được gọi.
   */
  async #claimFailure(itemId) {
    const now = await this.store.getPublishItem(itemId);
    if (!now) return new PublishError(PUBLISH_CODES.ITEM_NOT_FOUND, 'Không tìm thấy bài đăng.', { item_id: itemId });
    if (now.status === 'published' || now.external_post_id) {
      return new PublishError(PUBLISH_CODES.ALREADY_PUBLISHED, 'Bài này đã được đăng rồi.', { item_id: now.id, external_post_id: now.external_post_id });
    }
    if (now.status === 'publishing') {
      return new PublishError(PUBLISH_CODES.PUBLISH_IN_PROGRESS, 'Một lượt đăng khác đang xử lý bài này — chờ nó xong đã.', { item_id: now.id });
    }
    if (now.status === 'rejected') {
      return new PublishError(PUBLISH_CODES.ITEM_REJECTED, 'Bài này đã bị từ chối nên không được đăng.', { item_id: now.id });
    }
    // draft / pending_review ⇒ CHƯA DUYỆT. Đây là mã lỗi quan trọng nhất của sprint.
    return new PublishError(
      PUBLISH_CODES.NOT_APPROVED,
      'Bài CHƯA được duyệt nên hệ thống không đăng. Phải có owner/admin bấm DUYỆT trước.',
      { item_id: now.id, status: now.status },
    );
  }
}

export default PublishService;
