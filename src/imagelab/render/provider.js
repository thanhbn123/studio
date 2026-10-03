/**
 * `RenderProvider` — lớp cơ sở cho mọi provider render (hợp đồng 4.3).
 *
 * Lớp này giữ phần chung và KHÔNG BAO GIỜ ném lỗi ra ngoài `render()`:
 *   - luôn trả đủ hình dạng `RenderResult` (đóng băng field).
 *   - luôn tính `original_sha256` trên BẢN SAO buffer đầu vào → chứng minh ảnh gốc bất biến.
 *   - mọi lỗi được ánh xạ sang `status` + `error_code` (fail-closed, không fail-im lặng).
 *
 * Provider con chỉ cần cài `renderImpl()` và trả về phần thay đổi được:
 *   { status?, output?, applied?, skipped?, unsupported_glyphs?, warnings? }
 */

import { Buffer } from 'node:buffer';
import { RenderError, RENDER_CODES, UNSUPPORTED_IMAGE_CODES } from './errors.js';
import { probeImage, normalizeProtectedBoxes } from './image.js';
import { verifyProtectedPixels, PROTECTED_CHECK } from './verify.js';
import { sha256 } from './png.js';
import { normalizeOps } from './ops.js';

/** Trạng thái hợp lệ của RenderResult (đóng băng). */
export const RENDER_STATUS = Object.freeze({
  OK: 'OK',
  PARTIAL: 'PARTIAL',
  UNSUPPORTED_IMAGE: 'UNSUPPORTED_IMAGE',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  FAILED: 'FAILED',
});

/** Giới hạn mặc định — provider luôn được tiêm giới hạn thật từ config. */
export const DEFAULT_LIMITS = Object.freeze({
  maxPixels: 25_000_000,
  maxInputBytes: 8 * 1024 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
  fontScale: 1,
});

const asCopy = (value) => {
  if (Buffer.isBuffer(value)) return Buffer.from(value); // COPY: input không bao giờ bị sửa tại chỗ
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string' && value) return Buffer.from(value, 'base64');
  return null;
};

/**
 * Chuẩn hoá tham số `image` của render.
 * Nhận `{ buffer, mime }` hoặc thẳng một Buffer/Uint8Array. LUÔN copy buffer.
 */
export function normalizeImage(image) {
  if (image === undefined || image === null) return { buffer: null, mime: null };
  if (Buffer.isBuffer(image) || image instanceof Uint8Array) {
    return { buffer: asCopy(image), mime: null };
  }
  if (typeof image !== 'object') return { buffer: null, mime: null };
  const buffer =
    asCopy(image.buffer) ??
    asCopy(image.data) ??
    (typeof image.image_base64 === 'string' ? asCopy(image.image_base64) : null);
  const mime = typeof image.mime === 'string' && image.mime ? image.mime.toLowerCase() : null;
  return { buffer, mime };
}

export class RenderProvider {
  #name;
  #model;
  #isMock;
  #configured;
  #logger;

  constructor({ name = 'none', model = '', isMock = false, configured = false, limits = {}, logger = null } = {}) {
    this.#name = String(name);
    this.#model = String(model ?? '');
    this.#isMock = Boolean(isMock);
    this.#configured = Boolean(configured);
    this.#logger = logger;
    this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...(limits ?? {}) });
  }

  get name() {
    return this.#name;
  }

  get model() {
    return this.#model;
  }

  /** BẮT BUỘC đúng sự thật (luật 1 của hợp đồng). */
  get isMock() {
    return this.#isMock;
  }

  get configured() {
    return this.#configured;
  }

  get logger() {
    return this.#logger;
  }

  /**
   * Dò kích thước ảnh từ header. KHÔNG BAO GIỜ ném lỗi (hợp đồng 4.3).
   * @returns {Promise<{width:number,height:number}|null>}
   */
  async probe({ buffer, mime } = {}) {
    try {
      const info = probeImage(buffer);
      if (!info) return null;
      return { width: info.width, height: info.height };
    } catch {
      return null;
    }
  }

  /**
   * Render — luôn trả RenderResult đầy đủ.
   *
   * `options.protected_boxes` (bổ sung sau phản biện F-01): mảng hộp pixel mà provider
   * THẬT SỰ ghi pixel KHÔNG được phép thay đổi — hàng rào cuối của luật #3, độc lập với
   * việc pipeline đã lọc op hay chưa. Được chuẩn hoá ở đây rồi truyền xuống provider con.
   *
   * @param {{image?:object|Buffer, ops?:Array, options?:object}} [params]
   */
  async render({ image, ops, options } = {}) {
    const started = Date.now();
    const img = normalizeImage(image);
    const originalSha = img.buffer && img.buffer.length ? sha256(img.buffer) : '';
    const normalized = normalizeOps(ops);
    const opts = options && typeof options === 'object' ? options : {};
    const protectedBoxes = normalizeProtectedBoxes(opts.protected_boxes);
    const warnings = [];

    const base = {
      status: RENDER_STATUS.FAILED,
      provider: this.name,
      model: this.model,
      is_mock: this.isMock,
      output: null,
      original_sha256: originalSha,
      applied: [],
      skipped: [...normalized.skipped],
      unsupported_glyphs: [],
      warnings,
      elapsed_ms: 0,
      error_code: null,
      error_message: null,
      // N-5: `true` = đã đo pixel vùng bảo vệ trên ảnh trả về; `false` = KHÔNG kiểm được
      // (định dạng khác PNG); `null` = không có hộp bảo vệ nào để kiểm.
      protected_pixels_verified: null,
    };
    const finish = (result) => ({ ...result, elapsed_ms: Date.now() - started });

    if (!this.configured) {
      return finish({
        ...base,
        status: RENDER_STATUS.NOT_CONFIGURED,
        error_code: RENDER_CODES.NOT_CONFIGURED,
        error_message: `Provider render "${this.name}" chưa được cấu hình (thiếu baseUrl/API key).`,
      });
    }

    try {
      const partial = (await this.renderImpl({
        image: img,
        ops: normalized.ops,
        opsSkipped: normalized.skipped,
        options: opts,
        protectedBoxes,
        originalSha256: originalSha,
      })) ?? {};
      const rawStatus = partial.status ?? RENDER_STATUS.OK;
      const skippedAll = [...normalized.skipped, ...(Array.isArray(partial.skipped) ? partial.skipped : [])];
      const partialWarnings = Array.isArray(partial.warnings) ? partial.warnings : [];
      const output = partial.output ?? null;
      const outputBuffer = output && Buffer.isBuffer(output.buffer)
        ? output.buffer
        : output && output.buffer
          ? Buffer.from(output.buffer)
          : null;

      let applied = Array.isArray(partial.applied) ? partial.applied : [];
      let status = rawStatus;
      let errorCode = partial.error_code ?? null;
      let errorMessage = partial.error_message ?? null;
      let protectedVerified = null;
      // Hộp bảo vệ KHÔNG thuộc vùng nào đang được vẽ: op của chính vùng đó là override CÓ VẾT
      // (F-02) nên được phép đổi pixel của nó; mọi hộp khác phải đóng băng.
      const guardBoxes = protectedBoxes.filter(
        (p) => p.region_id === null || !normalized.ops.some((op) => String(op.region_id) === String(p.region_id)),
      );

      // ── N-5 (vòng 4): KHÔNG TIN provider, nhất là `http` ─────────────────────
      const outputSha = outputBuffer ? sha256(outputBuffer) : null;
      const unchangedOutput = Boolean(outputSha && originalSha && outputSha === originalSha && ops.length > 0);

      if (unchangedOutput) {
        if (applied.length > 0) {
          partialWarnings.push(
            `Provider "${this.name}" khai đã áp dụng ${applied.length}/${ops.length} op nhưng ảnh trả về Y HỆT ảnh gốc (sha256 không đổi) — KHÔNG tính là đã vẽ; danh sách \`applied\` tự khai bị bỏ.`,
          );
        }
        applied = [];
        status = RENDER_STATUS.PARTIAL;
        errorCode = errorCode ?? RENDER_CODES.NO_OPS;
        partialWarnings.push('Ảnh trả về giống hệt ảnh gốc (0 pixel thay đổi) — đây KHÔNG phải kết quả đã render; cần kiểm tra provider.');
      } else if (applied.length > ops.length) {
        partialWarnings.push(
          `Provider khai áp dụng ${applied.length} op trong khi chỉ nhận ${ops.length} op — không tin phần khai thêm (giữ ${ops.length}).`,
        );
        applied = applied.slice(0, ops.length);
        status = RENDER_STATUS.PARTIAL;
        errorCode = errorCode ?? RENDER_CODES.RENDER_APPLIED_MISMATCH;
      }

      // Hậu kiểm PIXEL vùng bảo vệ trên chính ảnh trả về (chỉ khi có hộp cần bảo vệ).
      if (guardBoxes.length > 0 && outputBuffer && rawStatus !== RENDER_STATUS.FAILED) {
        const check = verifyProtectedPixels({
          originalBuffer: img.buffer,
          outputBuffer,
          protectedBoxes: guardBoxes.map((b) => b.box),
          maxPixels: this.limits.maxPixels,
        });

        if (check.reason === PROTECTED_CHECK.PROTECTED_PIXELS_CHANGED || check.reason === PROTECTED_CHECK.SIZE_MISMATCH) {
          const detail = check.reason === PROTECTED_CHECK.SIZE_MISMATCH
            ? check.detail
            : check.changed.map((c) => `${c.changed}/${c.total} pixel tại hộp ${JSON.stringify(c.box)}`).join('; ');
          const message =
            `Ảnh do provider "${this.name}" trả về KHÔNG giữ nguyên vùng bảo vệ (nhãn hiệu/chứng nhận/giá): ${detail}. ` +
            'TỪ CHỐI lưu ảnh này — ảnh gốc được giữ nguyên và không có ảnh render mới (luật bất khả xâm phạm #3).';
          partialWarnings.push(message);
          this.#logger?.warn?.('imagelab.render.protected_pixels_changed', { provider: this.name, reason: check.reason, detail });
          return finish({
            ...base,
            ...partial,
            status: RENDER_STATUS.FAILED,
            provider: this.name,
            model: this.model,
            is_mock: this.isMock,
            original_sha256: originalSha,
            output: null, // KHÔNG bao giờ trả ảnh đã làm hỏng vùng bảo vệ
            applied: [],
            skipped: skippedAll,
            warnings: [...warnings, ...partialWarnings],
            protected_pixels_verified: false,
            error_code: RENDER_CODES.PROTECTED_PIXELS_CHANGED,
            error_message: message,
          });
        }

        if (check.reason === PROTECTED_CHECK.OUTPUT_UNREADABLE) {
          const message = `Ảnh do provider "${this.name}" trả về không giải mã được (${check.detail}) — TỪ CHỐI lưu để không tạo ảnh hỏng.`;
          partialWarnings.push(message);
          return finish({
            ...base,
            ...partial,
            status: RENDER_STATUS.FAILED,
            provider: this.name,
            model: this.model,
            is_mock: this.isMock,
            original_sha256: originalSha,
            output: null,
            applied: [],
            skipped: skippedAll,
            warnings: [...warnings, ...partialWarnings],
            protected_pixels_verified: false,
            error_code: RENDER_CODES.PNG_CORRUPT,
            error_message: message,
          });
        }

        protectedVerified = check.verified;
        if (check.reason === PROTECTED_CHECK.OUTPUT_NOT_PNG) {
          // (N-5c) Không kiểm chứng được pixel trên định dạng này ⇒ vẫn lưu nhưng KHÔNG
          // được coi như đã kiểm: hạ xuống PARTIAL + nói thẳng bằng cảnh báo nổi bật.
          status = status === RENDER_STATUS.OK || status === RENDER_STATUS.PARTIAL ? RENDER_STATUS.PARTIAL : status;
          errorCode = errorCode ?? RENDER_CODES.PROTECTED_PIXELS_UNVERIFIED;
          partialWarnings.push(
            `⚠️ KHÔNG kiểm chứng được pixel vùng bảo vệ (nhãn hiệu/chứng nhận/giá) trên định dạng ${check.mime ?? 'không rõ'} do provider "${this.name}" trả về — chỉ kiểm được với PNG. Ảnh vẫn được lưu nhưng KHÔNG có bảo đảm nào ở tầng pixel.`,
          );
        }
      }

      // H-2 (vòng 3): KHÔNG vẽ được vùng nào thì TUYỆT ĐỐI không được báo "OK" im lặng.
      // Giữ nguyên ảnh (bản sao y hệt gốc) nhưng hạ trạng thái xuống PARTIAL, gắn
      // `error_code = NO_OPS` và kèm cảnh báo tiếng Việt nói thẳng sự thật.
      const nothingDrawn = applied.length === 0 && (status === RENDER_STATUS.OK || status === RENDER_STATUS.PARTIAL);
      if (nothingDrawn) {
        partialWarnings.push(
          ops.length === 0
            ? 'Không có op nào để vẽ (ops rỗng) — ảnh trả về y hệt ảnh gốc, KHÔNG phải kết quả đã render.'
            : `Không vẽ được vùng nào trong ${ops.length} op — ảnh trả về y hệt ảnh gốc (xem \`skipped\` để biết lý do).`,
        );
        status = RENDER_STATUS.PARTIAL;
        errorCode = errorCode ?? RENDER_CODES.NO_OPS;
      }

      return finish({
        ...base,
        ...partial,
        // Các field nhận dạng KHÔNG cho provider con ghi đè.
        status,
        provider: this.name,
        model: this.model,
        is_mock: this.isMock,
        original_sha256: originalSha,
        output,
        applied,
        skipped: skippedAll,
        unsupported_glyphs: Array.isArray(partial.unsupported_glyphs) ? partial.unsupported_glyphs : [],
        warnings: [...warnings, ...partialWarnings],
        error_code: errorCode,
        error_message: errorMessage,
        protected_pixels_verified: protectedVerified,
      });
    } catch (err) {
      const code = err instanceof RenderError ? err.code : (err && err.code) || RENDER_CODES.RENDER_FAILED;
      const message = err && err.message ? err.message : 'Lỗi không xác định khi render ảnh.';
      if (this.#logger && typeof this.#logger.warn === 'function') {
        this.#logger.warn('imagelab.render.failed', { provider: this.name, code, message });
      }
      return finish({
        ...base,
        status: UNSUPPORTED_IMAGE_CODES.has(code)
          ? RENDER_STATUS.UNSUPPORTED_IMAGE
          : RENDER_STATUS.FAILED,
        error_code: code,
        error_message: message,
      });
    }
  }

  /**
   * Provider con cài đặt phần thực thi. Mặc định: không hỗ trợ.
   * @returns {Promise<object>} partial RenderResult
   */
  async renderImpl() {
    throw new RenderError(RENDER_CODES.NOT_IMPLEMENTED, `Provider "${this.name}" chưa cài đặt render().`);
  }
}

export default RenderProvider;
