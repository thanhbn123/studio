/**
 * MVP-06 — NẠP CREDIT THỦ CÔNG (`docs/MVP-06-CONTRACT.md`).
 *
 * Quyết định của Owner (09/10/2026): **chuyển khoản ngân hàng tay + quản trị viên cấp credit**.
 * KHÔNG cổng thanh toán, KHÔNG webhook ngân hàng, KHÔNG hoá đơn. Vì vậy ở đây TUYỆT ĐỐI không
 * có mã nào "thấy tiền về thì tự cộng": hệ thống không kết nối ngân hàng nào, nên nó KHÔNG BIẾT
 * tiền đã về hay chưa — chỉ con người biết.
 *
 * BA LUẬT (hợp đồng §0) và chỗ chúng được giữ trong file này:
 *
 *   #1 KHÔNG TỰ CỘNG TIỀN. `createRequest()` chỉ ghi `topup_requests` + `topup_events`; nó
 *      KHÔNG gọi `grant()`, KHÔNG gọi `appendLedger()`. Credit vào ví qua ĐÚNG MỘT đường:
 *      `confirm()` (chỉ admin) → `billing.grant()`.
 *
 *   #2 YÊU CẦU NẠP PHẢI CÓ VẾT. Mọi lần chuyển trạng thái đi qua `store.decideTopupRequest()`,
 *      hàm này ghi kèm một dòng `topup_events` trong CÙNG transaction. Không có hàm nào sửa
 *      `amount_vnd`/`reference` hay xoá một yêu cầu.
 *
 *   #3 SỐ TIỀN TRÊN YÊU CẦU ≠ TIỀN TRONG VÍ. `amount_vnd` là VND người dùng chuyển; credit vào
 *      ví = `amount_vnd / rate_vnd_per_credit`, và TỶ GIÁ ĐƯỢC GHI LẠI vào chính yêu cầu TẠI
 *      THỜI ĐIỂM DUYỆT ⇒ đổi `TOPUP_RATE_VND_PER_CREDIT` ngày mai KHÔNG làm sai yêu cầu cũ.
 *
 * CHỐNG CỘNG 2 LẦN (hợp đồng §3) — ba lớp, không phải một:
 *   1. `confirm()` đọc trạng thái và từ chối sớm nếu không còn `pending` (409).
 *   2. Chuyển trạng thái là MỘT câu `UPDATE … WHERE status='pending'`; kẻ thua cuộc đua nhận
 *      `changes = 0` ⇒ ném `TOPUP_ALREADY_DECIDED` ⇒ transaction ROLLBACK ⇒ dòng sổ vừa ghi
 *      BIẾN MẤT (grant và chuyển trạng thái nằm trong CÙNG `store.withLedgerLock`).
 *   3. Unique index `uniq_wallet_ledger_topup_run (user_id, run_key)` ở tầng DB: `run_key` của
 *      dòng sổ là `topup:<request_id>` nên dòng thứ hai không thể tồn tại dù có lỗi logic.
 */

import { MONEY_DECIMALS, roundMoney, toFiniteNumber } from './money.js';
import { topupRunKey, TOPUP_STATUSES } from '../store/index.js';

/** Cách nạp duy nhất của giai đoạn này. */
export const TOPUP_METHOD = 'bank_transfer';

/** Tỷ giá mặc định: 26.000 VND = 1 credit (1 credit ≈ 1 USD — xem `config.billing.currency`). */
export const DEFAULT_RATE_VND_PER_CREDIT = 26000;
export const DEFAULT_MIN_TOPUP_VND = 20000;
export const DEFAULT_MAX_TOPUP_VND = 50000000;

/** Độ dài tối đa của các trường người dùng nhập (chặn body phình + rác vào DB). */
const REFERENCE_MAX = 64;
const REFERENCE_MIN = 4;
const NOTE_MAX = 300;
const REASON_MAX = 300;

/**
 * Câu NÓI THẬT, dùng chung cho API và UI: hệ thống không biết tiền đã về hay chưa.
 * Đây là nội dung hợp đồng §4 yêu cầu phải hiện ra, không phải lời tiếp thị.
 */
export const TOPUP_HONEST_NOTE =
  'Tiền vào ví chỉ sau khi quản trị xác nhận — hệ thống không tự biết tiền đã về tài khoản '
  + '(không có cổng thanh toán, không có webhook ngân hàng).';

/** Lỗi nghiệp vụ của MVP-06 — `code` là hợp đồng (tầng HTTP ánh xạ sang mã trạng thái). */
export class TopupError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TopupError';
    this.code = String(code || 'TOPUP_ERROR');
    if (details && typeof details === 'object') this.details = details;
  }
}

/** Chuỗi do người dùng nhập: cắt khoảng trắng, gom khoảng trắng, chặn ký tự điều khiển. */
function cleanText(value, max) {
  const raw = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped.slice(0, max);
}

export class TopupService {
  constructor({ store = null, billing = null, config = null, logger = null } = {}) {
    this.store = store;
    this.billing = billing;
    this.config = config || {};
    this.logger = logger;
  }

  /* ───────────────────────────── cấu hình ───────────────────────────── */

  #topupConfig() {
    const billing = this.config?.billing && typeof this.config.billing === 'object' ? this.config.billing : {};
    return billing.topup && typeof billing.topup === 'object' ? billing.topup : {};
  }

  /** Tỷ giá ĐANG hiệu lực (VND cho 1 credit). Cấu hình rác ⇒ mặc định (KHÔNG bao giờ 0). */
  rate() {
    const raw = toFiniteNumber(this.#topupConfig().rateVndPerCredit);
    return raw !== null && raw > 0 ? raw : DEFAULT_RATE_VND_PER_CREDIT;
  }

  /** Khoảng tiền VND cho MỘT yêu cầu. `min > max` ⇒ đổi chỗ (cấu hình sai không được khoá cứng). */
  limits() {
    const cfg = this.#topupConfig();
    const rawMin = toFiniteNumber(cfg.minVnd);
    const rawMax = toFiniteNumber(cfg.maxVnd);
    let min = rawMin !== null && rawMin > 0 ? Math.trunc(rawMin) : DEFAULT_MIN_TOPUP_VND;
    let max = rawMax !== null && rawMax > 0 ? Math.trunc(rawMax) : DEFAULT_MAX_TOPUP_VND;
    if (min > max) [min, max] = [max, min];
    return { min, max };
  }

  /**
   * Hướng dẫn chuyển khoản — LẤY TỪ CẤU HÌNH, không hardcode số tài khoản nào (hợp đồng §4).
   * Chưa khai cấu hình ⇒ các field rỗng + `configured: false` để UI nói thật "quản trị chưa
   * điền thông tin chuyển khoản" thay vì hiện một số tài khoản bịa.
   */
  bankInstructions() {
    const cfg = this.#topupConfig();
    const bank = {
      bank_name: cleanText(cfg.bankName, 120),
      account_number: cleanText(cfg.accountNumber, 64),
      account_holder: cleanText(cfg.accountHolder, 120),
      transfer_note: cleanText(cfg.transferNote, 200),
      instructions: cleanText(cfg.instructions, 500),
    };
    return { ...bank, configured: Boolean(bank.bank_name && bank.account_number && bank.account_holder) };
  }

  /** Khối cấu hình cho `/api/config` (§3) — CHỈ con số + hướng dẫn, không có bí mật nào. */
  publicConfig() {
    const { min, max } = this.limits();
    return {
      rate_vnd_per_credit: this.rate(),
      min_topup_vnd: min,
      max_topup_vnd: max,
      method: TOPUP_METHOD,
      bank: this.bankInstructions(),
      note: TOPUP_HONEST_NOTE,
    };
  }

  /** Quy đổi VND → credit theo tỷ giá đang hiệu lực (làm tròn 6 chữ số như mọi tiền khác). */
  quote(amountVnd, rate = this.rate()) {
    const amount = toFiniteNumber(amountVnd);
    if (amount === null) return null;
    return roundMoney(amount / rate);
  }

  /* ───────────────────────────── kiểm tra đầu vào ───────────────────────────── */

  #requireStore(method) {
    const store = this.store;
    if (!store || typeof store[method] !== 'function') {
      throw new TopupError(
        'TOPUP_UNAVAILABLE',
        `Chức năng nạp credit chưa dùng được: store thiếu \`${method}\`.`,
        { method },
      );
    }
    return store;
  }

  #requireUserId(userId) {
    const uid = String(userId ?? '').trim();
    if (!uid) {
      // Luật ẩn danh: KHÔNG ví, KHÔNG nạp. Tầng HTTP đã chặn 401 trước đó; đây là chốt thứ hai.
      throw new TopupError('TOPUP_ANONYMOUS', 'Người dùng ẩn danh không có ví nên không nạp được credit.');
    }
    return uid;
  }

  /** `amount_vnd`: số NGUYÊN trong `[min, max]` (ngoài khoảng ⇒ `TOPUP_AMOUNT_OUT_OF_RANGE`). */
  #checkAmountVnd(value) {
    const raw = toFiniteNumber(value);
    if (raw === null || !Number.isInteger(raw)) {
      throw new TopupError(
        'TOPUP_AMOUNT_INVALID',
        '`amount_vnd` phải là số NGUYÊN (đồng VND), ví dụ 200000.',
        { amount_vnd: raw },
      );
    }
    const { min, max } = this.limits();
    if (raw < min || raw > max) {
      throw new TopupError(
        'TOPUP_AMOUNT_OUT_OF_RANGE',
        `Số tiền nạp phải trong khoảng ${min}–${max} VND (bạn nhập ${raw}).`,
        { amount_vnd: raw, min_topup_vnd: min, max_topup_vnd: max },
      );
    }
    return raw;
  }

  /** Mã giao dịch ngân hàng — BẮT BUỘC: không có nó thì không đối soát được với sao kê. */
  #checkReference(value) {
    const reference = cleanText(value, REFERENCE_MAX);
    if (reference.length < REFERENCE_MIN) {
      throw new TopupError(
        'TOPUP_REFERENCE_REQUIRED',
        `Cần \`reference\` — mã giao dịch / nội dung chuyển khoản (ít nhất ${REFERENCE_MIN} ký tự) để quản trị đối soát với sao kê.`,
        { min_length: REFERENCE_MIN, max_length: REFERENCE_MAX },
      );
    }
    return reference;
  }

  /* ───────────────────────────── nghiệp vụ ───────────────────────────── */

  /**
   * TẠO YÊU CẦU NẠP — **KHÔNG ĐỤNG VÍ** (luật #1).
   *
   * `credits`/`rate_vnd_per_credit` ghi vào yêu cầu ở đây chỉ là BẢN XEM TRƯỚC theo tỷ giá hiện
   * hành (để người dùng thấy mình sẽ nhận bao nhiêu); con số CÓ HIỆU LỰC được ghi lại lúc duyệt.
   */
  async createRequest({ userId, amountVnd = null, amount_vnd = null, reference = '', note = '' } = {}) {
    const store = this.#requireStore('createTopupRequest');
    const uid = this.#requireUserId(userId);
    const amount = this.#checkAmountVnd(amountVnd ?? amount_vnd);
    const ref = this.#checkReference(reference);
    const rate = this.rate();
    const request = await store.createTopupRequest({
      userId: uid,
      amountVnd: amount,
      credits: this.quote(amount, rate),
      rateVndPerCredit: rate,
      method: TOPUP_METHOD,
      reference: ref,
      note: cleanText(note, NOTE_MAX),
      status: 'pending',
    });
    this.logger?.info?.('topup.request_created', {
      request_id: request?.id ?? null,
      user_id: uid,
      amount_vnd: amount,
      // Nói rõ trong log điều mà hợp đồng bắt nói rõ trong UI: ví KHÔNG hề bị chạm.
      wallet_touched: false,
    });
    return request;
  }

  /** Yêu cầu của CHÍNH người dùng (hoặc tất cả khi `all = true` — chỉ đường admin truyền vậy). */
  async list({ userId = null, status = null, limit = 50, offset = 0, all = false } = {}) {
    const store = this.#requireStore('listTopupRequests');
    const filter = {
      userId: all ? null : this.#requireUserId(userId),
      status: status && TOPUP_STATUSES.includes(String(status)) ? String(status) : null,
      limit,
      offset,
    };
    const items = await store.listTopupRequests(filter);
    let total = Array.isArray(items) ? items.length + Number(offset || 0) : 0;
    if (typeof store.countTopupRequests === 'function') {
      try {
        const n = await store.countTopupRequests({ userId: filter.userId, status: filter.status });
        if (Number.isFinite(Number(n))) total = Number(n);
      } catch (err) {
        // Không đếm được thì vẫn trả danh sách — KHÔNG bịa `total`, chỉ dùng ước lượng trang.
        this.logger?.warn?.('topup.count_failed', { error_name: err?.name || 'Error' });
      }
    }
    return { items: Array.isArray(items) ? items : [], total };
  }

  /**
   * Một yêu cầu cụ thể. `requesterId` + `isAdmin` quyết định quyền xem:
   * khác chủ và không phải admin ⇒ `TOPUP_NOT_FOUND` (404 — KHÔNG tiết lộ là có tồn tại).
   */
  async get({ requestId, requesterId = null, isAdmin = false } = {}) {
    const store = this.#requireStore('getTopupRequest');
    const request = await store.getTopupRequest(requestId);
    if (!request) throw new TopupError('TOPUP_NOT_FOUND', 'Không tìm thấy yêu cầu nạp.', { request_id: String(requestId ?? '') });
    if (!isAdmin && String(request.user_id ?? '') !== String(requesterId ?? '')) {
      throw new TopupError('TOPUP_NOT_FOUND', 'Không tìm thấy yêu cầu nạp.', { request_id: String(requestId ?? '') });
    }
    return request;
  }

  /** Vết chuyển trạng thái của một yêu cầu (append-only) — cùng luật xem như `get()`. */
  async events({ requestId, requesterId = null, isAdmin = false } = {}) {
    const request = await this.get({ requestId, requesterId, isAdmin });
    const store = this.store;
    if (typeof store?.listTopupEvents !== 'function') return [];
    return store.listTopupEvents(request.id);
  }

  /** Số credit sẽ cộng khi duyệt: admin có thể ghi đè, mặc định quy đổi theo tỷ giá hiện hành. */
  #creditsForConfirm(request, override, rate) {
    if (override === null || override === undefined || override === '') return this.quote(request.amount_vnd, rate);
    const value = toFiniteNumber(override);
    if (value === null) {
      throw new TopupError('TOPUP_CREDITS_INVALID', '`credits` phải là số hữu hạn (hoặc bỏ trống để dùng tỷ giá).', { credits: override });
    }
    return roundMoney(value);
  }

  /**
   * XÁC NHẬN (CHỈ admin) — đường DUY NHẤT credit vào ví.
   *
   * Nguyên tử: `grant()` và `UPDATE … WHERE status='pending'` nằm trong CÙNG
   * `store.withLedgerLock(user_id)` ⇒ cùng một transaction. Hệ quả có thể kiểm chứng:
   *   - thua cuộc đua (đã có người duyệt) ⇒ `TOPUP_ALREADY_DECIDED` và sổ KHÔNG có dòng nào mới;
   *   - vượt trần số dư (`BILLING_MAX_BALANCE`) ⇒ `AMOUNT_TOO_LARGE` (HTTP 400) và yêu cầu VẪN
   *     `pending` (admin xử lý tay), chứ không phải "đã duyệt mà không có tiền".
   */
  async confirm({ requestId, actorId = null, credits = null, note = '' } = {}) {
    const store = this.#requireStore('decideTopupRequest');
    const billing = this.billing;
    if (!billing || typeof billing.grant !== 'function') {
      throw new TopupError('TOPUP_UNAVAILABLE', 'Ví credit chưa sẵn sàng — chưa cộng được credit cho yêu cầu này.');
    }
    if (typeof store.withLedgerLock !== 'function') {
      // Fail-closed: không có khoá sổ ở tầng DB thì KHÔNG duyệt (thà không cộng còn hơn cộng hai lần).
      throw new TopupError('TOPUP_UNAVAILABLE', 'Store không có `withLedgerLock` — từ chối duyệt để không cộng tiền hai lần.');
    }
    const request = await this.get({ requestId, isAdmin: true });
    if (request.status !== 'pending') throw this.#alreadyDecided(request);
    const ownerId = String(request.user_id ?? '');
    if (!ownerId) {
      throw new TopupError('TOPUP_NO_OWNER', 'Yêu cầu nạp không có chủ (user_id rỗng) — không biết cộng credit cho ai.', { request_id: request.id });
    }
    const rate = this.rate();
    const amount = this.#creditsForConfirm(request, credits, rate);
    if (!(amount > 0)) {
      throw new TopupError(
        'TOPUP_CREDITS_INVALID',
        `Số credit phải > 0 (quy đổi ${request.amount_vnd} VND theo tỷ giá ${rate} ra ${amount}; làm tròn ${MONEY_DECIMALS} chữ số).`,
        { credits: amount, amount_vnd: request.amount_vnd, rate_vnd_per_credit: rate },
      );
    }
    const reason = cleanText(note, REASON_MAX);
    const out = await store.withLedgerLock(ownerId, async () => {
      // Đọc LẠI trong khoá: trạng thái có thể vừa đổi giữa lần đọc trên và lúc này.
      const fresh = await store.getTopupRequest(request.id);
      if (!fresh) throw new TopupError('TOPUP_NOT_FOUND', 'Không tìm thấy yêu cầu nạp.', { request_id: request.id });
      if (fresh.status !== 'pending') throw this.#alreadyDecided(fresh);
      const ledger = await billing.grant({
        userId: ownerId,
        amount,
        reason: 'admin_grant',
        actorId: actorId ?? null,
        note: `nạp credit (chuyển khoản tay) · yêu cầu ${fresh.id}${reason ? ` · ${reason}` : ''}`,
        runKey: topupRunKey(fresh.id),
      });
      const decided = await store.decideTopupRequest(fresh.id, {
        toStatus: 'confirmed',
        actorUserId: actorId ?? null,
        reason: reason || 'quản trị xác nhận đã nhận chuyển khoản',
        // Luật #3: tỷ giá + số credit được GHI LẠI tại thời điểm duyệt.
        credits: amount,
        rateVndPerCredit: rate,
        ledgerEntryId: ledger?.id ?? null,
      });
      // `null` = đã có người quyết định trước ⇒ ném ⇒ ROLLBACK ⇒ dòng `grant` vừa ghi biến mất.
      if (!decided) throw this.#alreadyDecided(fresh);
      return { request: decided, ledger };
    });
    this.logger?.info?.('topup.confirmed', {
      request_id: out?.request?.id ?? null,
      user_id: ownerId,
      actor_id: actorId ?? null,
      amount_vnd: request.amount_vnd,
      credits: amount,
      rate_vnd_per_credit: rate,
      ledger_id: out?.ledger?.id ?? null,
    });
    return out;
  }

  /** TỪ CHỐI (CHỈ admin) — BẮT BUỘC có lý do, và KHÔNG ghi dòng sổ nào. */
  async reject({ requestId, actorId = null, reason = '' } = {}) {
    const store = this.#requireStore('decideTopupRequest');
    const text = cleanText(reason, REASON_MAX);
    if (!text) {
      throw new TopupError('TOPUP_REASON_REQUIRED', 'Từ chối phải có lý do (người dùng cần biết vì sao).');
    }
    const request = await this.get({ requestId, isAdmin: true });
    if (request.status !== 'pending') throw this.#alreadyDecided(request);
    const decided = await store.decideTopupRequest(request.id, {
      toStatus: 'rejected',
      actorUserId: actorId ?? null,
      reason: text,
    });
    if (!decided) throw this.#alreadyDecided(request);
    this.logger?.info?.('topup.rejected', {
      request_id: decided.id,
      user_id: decided.user_id,
      actor_id: actorId ?? null,
      // Nói rõ: từ chối KHÔNG sinh dòng sổ nào.
      ledger_rows: 0,
    });
    return { request: decided };
  }

  #alreadyDecided(request) {
    return new TopupError(
      'TOPUP_ALREADY_DECIDED',
      `Yêu cầu nạp này đã được quyết định (${request?.status ?? 'không rõ'}) — không xử lý lại, sổ credit không đổi.`,
      {
        request_id: request?.id ?? null,
        status: request?.status ?? null,
        decided_at: request?.decided_at ?? null,
        ledger_entry_id: request?.ledger_entry_id ?? null,
      },
    );
  }
}

/** Factory theo đúng kiểu `createBillingService(config, { store, logger })` của MVP-05. */
export function createTopupService(config = {}, { store = null, billing = null, logger = null } = {}) {
  return new TopupService({ config, store, billing, logger });
}

export default TopupService;
