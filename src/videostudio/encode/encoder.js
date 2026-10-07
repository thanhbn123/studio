/**
 * `VideoEncoder` — lớp cơ sở của tầng mã hoá (hợp đồng MVP-04 §2.2).
 *
 * Trách nhiệm của lớp này (để mọi provider không phải tự lo):
 *   - giữ `name` / `isMock` / `configured`;
 *   - `encode()` **KHÔNG BAO GIỜ ném lỗi**: mọi thất bại trả `EncodeResult` với
 *     `status:'FAILED'` + `error_code` + `warnings` (tiếng Việt) — theo đúng tiền lệ
 *     `RetouchProvider` của MVP-03;
 *   - đo `elapsed_ms` và LUÔN trả ĐÚNG bộ field của `EncodeResult`:
 *     `{status, provider, is_mock, output, width, height, frames, palette_size,
 *       warnings, elapsed_ms, error_code}`.
 *
 * Provider `configured = false` ⇒ `FAILED` + `NOT_CONFIGURED` (không giả vờ chạy được).
 *
 * Lưu ý về LUẬT "không có tiếng thì phải NÓI RÕ" (§0.2): mọi kết quả mã hoá đều kèm cảnh báo
 * `AUDIO_WARNING`. Field `audio: null` thuộc về kết quả job/asset của V3 (hợp đồng §2.3 ghi
 * `meta.audio = null`) — `EncodeResult` ở §2.2 KHÔNG có field đó nên tầng này không tự thêm.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { VideoEncodeError, ENCODE_CODES, ENCODE_STATUS } from './errors.js';

/** Tên field ĐÓNG BĂNG của `EncodeResult` — V3/V4/test đối chiếu bằng bảng này. */
export const ENCODE_RESULT_FIELDS = Object.freeze([
  'status',
  'provider',
  'is_mock',
  'output',
  'width',
  'height',
  'frames',
  'palette_size',
  'warnings',
  'elapsed_ms',
  'error_code',
  // N2 (phản biện MVP-04 vòng 3): nhịp phát THẬT phải là số máy đọc được, không chỉ một câu cảnh báo.
  'playback_ms',
  'requested_ms',
  'delay_drift_ms',
]);

/** Tên field ĐÓNG BĂNG của `output`. */
export const ENCODE_OUTPUT_FIELDS = Object.freeze(['buffer', 'mime', 'ext', 'sha256', 'bytes']);

/** Cảnh báo bắt buộc của luật số 2 (§0.2). */
export const AUDIO_WARNING =
  'video KHÔNG có tiếng — bản dựng MVP-04 không chứa âm thanh (voice-over/nhạc nền là phần trả tiền).';

/** Giới hạn mặc định của tầng mã hoá. */
export const DEFAULT_ENCODE_LIMITS = Object.freeze({
  maxPixels: 16_000_000, // mỗi khung
  maxFrames: 3600,
  maxColors: 256,
  maxBytes: 64 * 1024 * 1024, // mỗi file ra
});

/** Bọc `output` đúng 5 field hợp đồng (sha256 + bytes tự tính). */
export function createEncodeOutput({ buffer, mime, ext }) {
  const data = Buffer.isBuffer(buffer)
    ? buffer
    : buffer instanceof Uint8Array
      ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : null;
  if (!data) throw new VideoEncodeError(ENCODE_CODES.BAD_INPUT, 'output.buffer phải là Buffer/Uint8Array.');
  return {
    buffer: data,
    mime: String(mime),
    ext: String(ext),
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.length,
  };
}

/** Dựng `EncodeResult` đủ field, đúng thứ tự hợp đồng. */
export function createEncodeResult(partial = {}) {
  const toCount = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  };
  return {
    status: partial.status === ENCODE_STATUS.OK ? ENCODE_STATUS.OK : ENCODE_STATUS.FAILED,
    provider: String(partial.provider ?? 'none'),
    is_mock: partial.is_mock === true,
    output: partial.output ?? null,
    width: toCount(partial.width),
    height: toCount(partial.height),
    frames: toCount(partial.frames),
    palette_size: toCount(partial.palette_size),
    warnings: Array.isArray(partial.warnings) ? partial.warnings.filter((w) => typeof w === 'string') : [],
    elapsed_ms: toCount(partial.elapsed_ms),
    error_code: partial.error_code ?? null,
  };
}

/**
 * Gom cảnh báo CHẨN ĐOÁN của `renderFrames` (thuộc tính không-enumerable `frames.warnings`)
 * để nhét vào `EncodeResult.warnings` — nhờ vậy cảnh báo của tầng vẽ (thiếu glyph, chữ ngoài
 * cảnh, fit_box thiếu…) KHÔNG bị mất trên đường tới `meta.warnings` của job (V3).
 */
export function collectFrameWarnings(frames) {
  const list = frames?.warnings;
  if (!Array.isArray(list)) return [];
  return list.filter((w) => typeof w === 'string');
}

/** Ép một khung bất kỳ về `{rgba, width?, height?, delayMs?}`; sai ⇒ `BAD_INPUT`. */
export function normalizeFrame(entry, index) {
  const toView = (value) =>
    Buffer.isBuffer(value)
      ? value
      : value instanceof Uint8Array
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : null;
  if (entry === null || entry === undefined) {
    throw new VideoEncodeError(ENCODE_CODES.BAD_INPUT, `Khung #${index} rỗng.`, { index });
  }
  const view = toView(entry) ?? toView(entry.rgba ?? entry.data ?? entry.pixels ?? entry.buffer);
  if (!view) {
    throw new VideoEncodeError(
      ENCODE_CODES.BAD_INPUT,
      `Khung #${index} phải là Buffer RGBA hoặc { rgba, delayMs }.`,
      { index },
    );
  }
  const delay = Number(entry.delayMs ?? entry.delay_ms);
  return {
    rgba: view,
    width: Number.isFinite(Number(entry.width)) ? Math.floor(Number(entry.width)) : null,
    height: Number.isFinite(Number(entry.height)) ? Math.floor(Number(entry.height)) : null,
    delayMs: Number.isFinite(delay) && delay >= 0 ? delay : null,
  };
}

/** Chuẩn hoá danh sách khung của `encode({frames})`. */
export function normalizeFrames(frames, { limits = DEFAULT_ENCODE_LIMITS } = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new VideoEncodeError(ENCODE_CODES.BAD_INPUT, 'encode() cần `frames` là mảng khung không rỗng.');
  }
  const maxFrames = Math.max(1, Math.floor(Number(limits.maxFrames) || DEFAULT_ENCODE_LIMITS.maxFrames));
  if (frames.length > maxFrames) {
    throw new VideoEncodeError(
      ENCODE_CODES.TOO_MANY_FRAMES,
      `Số khung ${frames.length} vượt trần ${maxFrames}.`,
      { frames: frames.length, max: maxFrames },
    );
  }
  return frames.map((entry, index) => normalizeFrame(entry, index));
}

/**
 * Suy ra `{width, height, fps, loop}` từ `plan` / `options` / chính các khung.
 * Ưu tiên: `plan` (V1) → `options` → kích thước khai trên khung.
 */
export function resolvePlanGeometry(plan, frames, options = {}) {
  const list = Array.isArray(frames) ? frames : [];
  const first = list[0] ?? {};
  const pick = (...values) => {
    for (const value of values) {
      const n = Math.floor(Number(value));
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  };
  const width = pick(plan?.width, options.width, first.width);
  const height = pick(plan?.height, options.height, first.height);
  if (!width || !height) {
    throw new VideoEncodeError(
      ENCODE_CODES.BAD_INPUT,
      'Không xác định được width/height (plan thiếu và khung không khai kích thước).',
      { width: plan?.width ?? null, height: plan?.height ?? null },
    );
  }
  const fpsRaw = Number(plan?.fps ?? options.fps);
  const fps = Number.isFinite(fpsRaw) && fpsRaw > 0 ? fpsRaw : 12;
  const loopRaw = Number(plan?.loop ?? options.loop ?? 0);
  const loop = Number.isFinite(loopRaw) && loopRaw >= 0 ? Math.floor(loopRaw) : 0;
  return { width, height, fps, loop };
}

/**
 * Lớp cơ sở. Provider con cài `_encode({plan, frames, options})` và trả partial của
 * `EncodeResult` (không cần tự đo `elapsed_ms`).
 */
export class VideoEncoder {
  #name;
  #model;
  #mime;
  #isMock;
  #configured;
  #limits;
  #logger;

  constructor({ name = 'none', model = '', mime = '', isMock = false, configured = false, limits, logger } = {}) {
    this.#name = String(name);
    this.#model = String(model ?? '');
    this.#mime = String(mime ?? '');
    this.#isMock = isMock === true;
    this.#configured = configured === true;
    this.#limits = { ...DEFAULT_ENCODE_LIMITS, ...(limits && typeof limits === 'object' ? limits : {}) };
    this.#logger = logger ?? null;
  }

  get name() {
    return this.#name;
  }

  get model() {
    return this.#model;
  }

  /** MIME mà provider này tạo ra ('image/gif' | 'video/mp4') — V3/V4 đọc để khai Content-Type. */
  get mime() {
    return this.#mime;
  }

  get isMock() {
    return this.#isMock;
  }

  get configured() {
    return this.#configured;
  }

  get limits() {
    return { ...this.#limits };
  }

  /** Provider con có thể ghi đè để tự kiểm tra (vd ffmpeg có binary hay không). */
  // eslint-disable-next-line class-methods-use-this -- API cho provider con
  async probe() {
    return { available: this.#configured, version: null };
  }

  /**
   * Mã hoá. KHÔNG BAO GIỜ ném lỗi — trả `EncodeResult`.
   * @param {{plan?:object, frames?:Array, options?:object}} params
   * @returns {Promise<object>}
   */
  async encode({ plan, frames, options } = {}) {
    const started = Date.now();
    if (!this.#configured) {
      return createEncodeResult({
        status: ENCODE_STATUS.FAILED,
        provider: this.name,
        is_mock: this.isMock,
        warnings: [`Provider "${this.name}" chưa được cấu hình (configured = false).`, AUDIO_WARNING],
        elapsed_ms: Date.now() - started,
        error_code: ENCODE_CODES.NOT_CONFIGURED,
      });
    }
    try {
      const partial = await this._encode({ plan, frames, options: options ?? {} });
      return createEncodeResult({
        ...partial,
        provider: this.name,
        is_mock: this.isMock,
        elapsed_ms: Date.now() - started,
      });
    } catch (err) {
      const code = err instanceof VideoEncodeError ? err.code : ENCODE_CODES.ENCODE_FAILED;
      const message = err?.message ?? String(err);
      this.#logger?.warn?.('videostudio.encode.failed', { provider: this.name, code, message });
      return createEncodeResult({
        status: ENCODE_STATUS.FAILED,
        provider: this.name,
        is_mock: this.isMock,
        width: Number(plan?.width) || 0,
        height: Number(plan?.height) || 0,
        frames: Array.isArray(frames) ? frames.length : 0,
        warnings: [`Mã hoá thất bại (${code}): ${message}`, AUDIO_WARNING],
        elapsed_ms: Date.now() - started,
        error_code: code,
      });
    }
  }

  /** @abstract */
  // eslint-disable-next-line class-methods-use-this -- API cho provider con
  async _encode() {
    throw new VideoEncodeError(
      ENCODE_CODES.NOT_IMPLEMENTED,
      'VideoEncoder cơ sở không tự mã hoá — hãy dùng provider cụ thể.',
    );
  }
}

export default VideoEncoder;
