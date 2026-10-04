/**
 * `MattingProvider` — lớp cơ sở cho mọi provider tách nền (hợp đồng §3.1, E1).
 *
 * Lớp này giữ phần chung và **KHÔNG BAO GIỜ ném lỗi ra ngoài `removeBackground()`**:
 *   - luôn trả đủ hình dạng `MattingResult` (đóng băng field, xem `result.js`).
 *   - ảnh vào luôn được COPY (không bao giờ sửa `image.buffer` tại chỗ).
 *   - mọi lỗi được ánh xạ sang `status` + `error_code` (fail-closed).
 *   - hậu kiểm kết quả provider con: PNG thật, ĐÚNG kích thước ảnh gốc, số đo mask
 *     hợp lệ, và "không đổi pixel nào" thì KHÔNG được coi là đã tách nền.
 *
 * Provider con chỉ cài `removeBackgroundImpl()` và trả về phần thay đổi được:
 *   { status?, output?, mask?, kept_bbox?, warnings?, error_code?, error_message? }
 */

import { Buffer } from 'node:buffer';
import { detectImageMime, probeImage } from '../../imagelab/render/image.js';
import { sha256 } from '../../imagelab/render/png.js';
import { normalizeImage } from '../../imagelab/render/provider.js';
import { MattingError, MATTING_CODES, MATTING_UNSUPPORTED_CODES } from './errors.js';
import { BACKGROUND_RATIO_BOUNDS, MATTING_STATUS, createMattingResult, emptyMask } from './result.js';

/** Giới hạn mặc định — provider luôn được tiêm giới hạn thật từ config (khối `imagelab`). */
export const DEFAULT_MATTING_LIMITS = Object.freeze({
  maxPixels: 16_000_000,
  maxInputBytes: 8 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
});

/** Kiểm một số đo mask có phải tỉ lệ 0..1 hữu hạn. */
const isRatio = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

export class MattingProvider {
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
    this.limits = Object.freeze({ ...DEFAULT_MATTING_LIMITS, ...(limits ?? {}) });
  }

  get name() {
    return this.#name;
  }

  get model() {
    return this.#model;
  }

  /** BẮT BUỘC đúng sự thật: `true` = provider KHÔNG tách nền thật. */
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
   * Dò kích thước ảnh từ header. KHÔNG BAO GIỜ ném lỗi (hợp đồng §3.1).
   * @returns {Promise<{width:number,height:number}|null>}
   */
  async probe({ buffer } = {}) {
    try {
      const info = probeImage(buffer);
      return info ? { width: info.width, height: info.height } : null;
    } catch {
      return null;
    }
  }

  /**
   * Tách nền — luôn trả `MattingResult` đầy đủ.
   * @param {{image?: object|Buffer|Uint8Array|string, options?: object}} [params]
   */
  async removeBackground({ image, options } = {}) {
    const started = Date.now();
    const img = normalizeImage(image);
    const opts = options && typeof options === 'object' ? options : {};
    const warnings = [];
    const finish = (partial) => createMattingResult({ ...partial, elapsed_ms: Date.now() - started });

    const identity = { provider: this.name, model: this.model, is_mock: this.isMock };
    const emptyStats = emptyMask();

    if (!this.configured) {
      return finish({
        ...identity,
        status: MATTING_STATUS.NOT_CONFIGURED,
        mask: emptyStats,
        warnings,
        error_code: MATTING_CODES.NOT_CONFIGURED,
        error_message: `Provider tách nền "${this.name}" chưa được cấu hình (thiếu baseUrl/API key).`,
      });
    }
    if (!img.buffer || img.buffer.length === 0) {
      return finish({
        ...identity,
        status: MATTING_STATUS.FAILED,
        mask: emptyStats,
        warnings,
        error_code: MATTING_CODES.BAD_INPUT,
        error_message: 'Thiếu dữ liệu ảnh để tách nền (image.buffer rỗng).',
      });
    }

    let partial;
    try {
      partial = (await this.removeBackgroundImpl({ image: img, options: opts })) ?? {};
    } catch (err) {
      const code = err instanceof MattingError ? err.code : (err && err.code) || MATTING_CODES.MATTING_FAILED;
      const message = err && err.message ? err.message : 'Lỗi không xác định khi tách nền.';
      this.#logger?.warn?.('imagestudio.matting.failed', { provider: this.name, code, message });
      return finish({
        ...identity,
        status: MATTING_UNSUPPORTED_CODES.has(code)
          ? MATTING_STATUS.UNSUPPORTED_IMAGE
          : code === MATTING_CODES.NOT_CONFIGURED
            ? MATTING_STATUS.NOT_CONFIGURED
            : MATTING_STATUS.FAILED,
        mask: emptyStats,
        warnings,
        error_code: code,
        error_message: message,
      });
    }

    const partialWarnings = Array.isArray(partial.warnings) ? partial.warnings : [];
    let status = partial.status ?? MATTING_STATUS.OK;
    let errorCode = partial.error_code ?? null;
    let errorMessage = partial.error_message ?? null;
    let output = partial.output ?? null;
    let mask = partial.mask && typeof partial.mask === 'object' ? partial.mask : emptyStats;
    const keptBox = partial.kept_bbox ?? null;

    // (1) Từ chối là phải sạch: status không OK ⇒ KHÔNG được kèm ảnh ra.
    if (status !== MATTING_STATUS.OK && output) {
      partialWarnings.push(
        `Provider "${this.name}" khai \`output\` trong khi status = ${status} — bỏ ảnh ra để không ai lưu nhầm ảnh chưa tách nền.`,
      );
      output = null;
    }

    if (status === MATTING_STATUS.OK) {
      // (2) Số đo mask: có thì phải hợp lệ (không tin lời khai); thiếu thì nói thẳng là thiếu.
      const stats = {
        coverage: mask.coverage ?? null,
        background_ratio: mask.background_ratio ?? null,
        uniformity: mask.uniformity ?? null,
        seed_colors: mask.seed_colors ?? null,
      };
      const ratiosOk = [stats.coverage, stats.background_ratio, stats.uniformity].every(
        (v) => v === null || isRatio(v),
      );
      const seedsOk = stats.seed_colors === null || (Number.isInteger(stats.seed_colors) && stats.seed_colors >= 0);
      if (!ratiosOk || !seedsOk) {
        const message = `Provider "${this.name}" trả số đo mask không hợp lệ (${JSON.stringify(stats)}) — TỪ CHỐI kết quả.`;
        partialWarnings.push(message);
        return finish({
          ...identity,
          status: MATTING_STATUS.FAILED,
          mask: emptyStats,
          warnings: [...warnings, ...partialWarnings],
          error_code: MATTING_CODES.MATTING_BAD_RESPONSE,
          error_message: message,
        });
      }
      // M03-01a (vòng 8): GIỮ các số đo MỞ RỘNG mà provider trả (số đo thật của vùng biên,
      // tỉ lệ hộp bao…) — chúng là căn cứ để người dùng/phản biện đọc, không phải lời khai
      // về ảnh. Chỉ 4 số đo hợp đồng ở trên mới bị kiểm kiểu; phần mở rộng đi nguyên.
      for (const [key, value] of Object.entries(mask)) {
        if (key in stats) continue;
        if (value === null || value === undefined) continue;
        if (key === 'kept_bbox_ratio' && !isRatio(value)) continue;
        stats[key] = value;
      }
      mask = stats;
      if (Object.values(stats).some((v) => v === null)) {
        partialWarnings.push(
          `Provider "${this.name}" không trả đủ số đo mask (field null) — KHÔNG bịa số; phần thiếu để trống.`,
        );
      }

      // (3) Ảnh ra: phải là PNG thật (magic bytes), đúng kích thước ảnh gốc, đúng hash.
      const outBuffer = output && Buffer.isBuffer(output.buffer) ? output.buffer : null;
      if (!outBuffer || outBuffer.length === 0) {
        const message = `Provider "${this.name}" khai status = OK nhưng KHÔNG trả ảnh ra — TỪ CHỐI.`;
        partialWarnings.push(message);
        return finish({
          ...identity,
          status: MATTING_STATUS.FAILED,
          mask: emptyStats,
          warnings: [...warnings, ...partialWarnings],
          error_code: MATTING_CODES.MATTING_BAD_RESPONSE,
          error_message: message,
        });
      }
      const outMime = detectImageMime(outBuffer);
      if (outMime !== 'image/png') {
        const message = `Ảnh do provider "${this.name}" trả về không phải PNG (nhận ${outMime ?? 'không rõ định dạng'}) — nền trong suốt chỉ đáng tin với PNG.`;
        partialWarnings.push(message);
        return finish({
          ...identity,
          status: MATTING_STATUS.FAILED,
          mask: emptyStats,
          warnings: [...warnings, ...partialWarnings],
          error_code: MATTING_CODES.MATTING_BAD_RESPONSE,
          error_message: message,
        });
      }
      const inInfo = probeImage(img.buffer);
      const outInfo = probeImage(outBuffer);
      if (inInfo && outInfo && (inInfo.width !== outInfo.width || inInfo.height !== outInfo.height)) {
        const message =
          `Ảnh ra ${outInfo.width}×${outInfo.height} KHÁC ảnh gốc ${inInfo.width}×${inInfo.height} — ` +
          'TỪ CHỐI (luật MVP-03: đầu ra cùng khung hình với ảnh gốc).';
        partialWarnings.push(message);
        return finish({
          ...identity,
          status: MATTING_STATUS.FAILED,
          mask: emptyStats,
          warnings: [...warnings, ...partialWarnings],
          error_code: MATTING_CODES.MASK_SIZE_MISMATCH,
          error_message: message,
        });
      }
      if (outBuffer.length > this.limits.maxOutputBytes) {
        const message = `Ảnh ra ${outBuffer.length} byte vượt giới hạn ${this.limits.maxOutputBytes} byte.`;
        partialWarnings.push(message);
        return finish({
          ...identity,
          status: MATTING_STATUS.FAILED,
          mask: emptyStats,
          warnings: [...warnings, ...partialWarnings],
          error_code: MATTING_CODES.MATTING_OUTPUT_TOO_LARGE,
          error_message: message,
        });
      }

      // (4) "Không đổi pixel nào" KHÔNG phải là đã tách nền (chỉ áp cho provider THẬT;
      //     provider mock được phép trả bản sao nhưng phải tự khai is_mock = true).
      const outSha = sha256(outBuffer);
      if (!this.isMock && sha256(img.buffer) === outSha) {
        const message =
          `Provider "${this.name}" trả về ảnh Y HỆT ảnh gốc (sha256 không đổi) ⇒ KHÔNG có pixel nền nào được tách — KHÔNG tính là OK.`;
        partialWarnings.push(message);
        return finish({
          ...identity,
          status: MATTING_STATUS.FAILED,
          mask: emptyStats,
          warnings: [...warnings, ...partialWarnings],
          error_code: MATTING_CODES.MASK_UNCHANGED,
          error_message: message,
        });
      }

      // (5) Ngưỡng nghi ngờ mặt nạ (luật §3.1): đo được thì áp cho MỌI provider.
      const ratio = mask.background_ratio;
      if (typeof ratio === 'number') {
        if (ratio < BACKGROUND_RATIO_BOUNDS.min || ratio > BACKGROUND_RATIO_BOUNDS.max) {
          const message =
            `Tỉ lệ nền tách được ${(ratio * 100).toFixed(1)}% nằm ngoài khoảng an toàn ` +
            `[${BACKGROUND_RATIO_BOUNDS.min * 100}%, ${BACKGROUND_RATIO_BOUNDS.max * 100}%] — nghi ngờ mặt nạ ` +
            '(ảnh gần như toàn nền hoặc không tách được gì) ⇒ TỪ CHỐI, giữ nguyên ảnh gốc.';
          partialWarnings.push(message);
          return finish({
            ...identity,
            status: MATTING_STATUS.FAILED,
            mask,
            kept_bbox: null,
            warnings: [...warnings, ...partialWarnings],
            error_code: MATTING_CODES.SUSPICIOUS_MASK,
            error_message: message,
          });
        }
      }

      // Ảnh ra hợp lệ ⇒ chuẩn hoá lại `output` (sha256 do CHÍNH ta tính, không tin provider).
      output = {
        buffer: outBuffer,
        mime: 'image/png',
        width: outInfo?.width ?? null,
        height: outInfo?.height ?? null,
        sha256: outSha,
      };
    } else {
      // Từ chối / lỗi: giữ số đo THẬT nếu provider con đo được (để người dùng hiểu vì sao bị từ chối).
      mask = mask && typeof mask === 'object' ? { ...emptyStats, ...mask } : emptyStats;
    }

    return finish({
      ...identity,
      status,
      output,
      mask,
      kept_bbox: keptBox,
      warnings: [...warnings, ...partialWarnings],
      error_code: errorCode,
      error_message: errorMessage,
    });
  }

  /** Provider con cài đặt phần thực thi. Mặc định: không hỗ trợ. */
  async removeBackgroundImpl() {
    throw new MattingError(MATTING_CODES.NOT_IMPLEMENTED, `Provider "${this.name}" chưa cài đặt removeBackground().`);
  }
}

export default MattingProvider;
