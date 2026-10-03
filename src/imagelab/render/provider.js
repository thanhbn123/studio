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
      const applied = Array.isArray(partial.applied) ? partial.applied : [];
      const rawStatus = partial.status ?? RENDER_STATUS.OK;
      const skippedAll = [...normalized.skipped, ...(Array.isArray(partial.skipped) ? partial.skipped : [])];
      const partialWarnings = Array.isArray(partial.warnings) ? partial.warnings : [];
      const output = partial.output ?? null;

      // H-2 (vòng 3): KHÔNG vẽ được vùng nào thì TUYỆT ĐỐI không được báo "OK" im lặng.
      // Giữ nguyên ảnh (bản sao y hệt gốc) nhưng hạ trạng thái xuống PARTIAL, gắn
      // `error_code = NO_OPS` và kèm cảnh báo tiếng Việt nói thẳng sự thật.
      const nothingDrawn = applied.length === 0 && (rawStatus === RENDER_STATUS.OK || rawStatus === RENDER_STATUS.PARTIAL);
      if (nothingDrawn) {
        partialWarnings.push(
          ops.length === 0
            ? 'Không có op nào để vẽ (ops rỗng) — ảnh trả về y hệt ảnh gốc, KHÔNG phải kết quả đã render.'
            : `Không vẽ được vùng nào trong ${ops.length} op — ảnh trả về y hệt ảnh gốc (xem \`skipped\` để biết lý do).`,
        );
      }

      return finish({
        ...base,
        ...partial,
        // Các field nhận dạng KHÔNG cho provider con ghi đè.
        status: nothingDrawn ? RENDER_STATUS.PARTIAL : rawStatus,
        provider: this.name,
        model: this.model,
        is_mock: this.isMock,
        original_sha256: originalSha,
        output,
        applied,
        skipped: skippedAll,
        unsupported_glyphs: Array.isArray(partial.unsupported_glyphs) ? partial.unsupported_glyphs : [],
        warnings: [...warnings, ...partialWarnings],
        error_code: partial.error_code ?? (nothingDrawn ? RENDER_CODES.NO_OPS : null),
        error_message: partial.error_message ?? null,
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
