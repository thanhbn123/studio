/**
 * `RetouchProvider` — lớp cơ sở cho provider retouch (hợp đồng §3.4, E1).
 *
 * Lớp này giữ phần chung và **KHÔNG BAO GIỜ ném lỗi ra ngoài `apply()`**:
 *   - luôn trả đủ hình dạng `RetouchResult` (đóng băng field, xem `result.js`).
 *   - ảnh vào luôn được COPY (không bao giờ sửa `image.buffer` tại chỗ).
 *   - KẸP tham số vào `RETOUCH_LIMITS` trước khi chạy; tên bị kẹp ghi vào `clamped[]`,
 *     tham số rác/không nhận ra ghi vào `rejected[]` (coi như không truyền).
 *   - sau khi kẹp mà KHÔNG còn tham số nào ⇒ `status = 'NO_CHANGES'` (KHÔNG bịa là đã retouch).
 *   - hậu kiểm ảnh ra: PNG thật, ĐÚNG kích thước ảnh gốc; "không đổi pixel nào" ⇒ `NO_CHANGES`.
 */

import { Buffer } from 'node:buffer';
import { detectImageMime, probeImage } from '../../imagelab/render/image.js';
import { sha256 } from '../../imagelab/render/png.js';
import { normalizeImage } from '../../imagelab/render/provider.js';
import { RetouchError, RETOUCH_CODES, RETOUCH_UNSUPPORTED_CODES } from './errors.js';
import { RETOUCH_LIMITS, RETOUCH_PARAM_NAMES, clampRetouchParams, zeroRetouchParams } from './limits.js';
import { RETOUCH_STATUS, createRetouchResult } from './result.js';

/** Giới hạn mặc định dùng chung với MVP-02 (khối `imagelab`). */
export const DEFAULT_RETOUCH_LIMITS = Object.freeze({
  maxPixels: 16_000_000,
  maxInputBytes: 8 * 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
});

/**
 * Cấu hình CHỈ ĐƯỢC SIẾT ngưỡng, không bao giờ được nới quá `RETOUCH_LIMITS`
 * (hợp đồng §3.4 là mức trần bất khả xâm phạm).
 */
export function resolveRetouchLimits(configLimits = {}) {
  const out = {};
  for (const name of RETOUCH_PARAM_NAMES) {
    const raw = Number(configLimits?.[name]);
    out[name] = Number.isFinite(raw) && raw > 0 ? Math.min(raw, RETOUCH_LIMITS[name]) : RETOUCH_LIMITS[name];
  }
  return out;
}

export class RetouchProvider {
  #name;
  #model;
  #isMock;
  #configured;
  #logger;

  constructor({ name = 'none', model = '', isMock = false, configured = false, limits = {}, retouchLimits = {}, logger = null } = {}) {
    this.#name = String(name);
    this.#model = String(model ?? '');
    this.#isMock = Boolean(isMock);
    this.#configured = Boolean(configured);
    this.#logger = logger;
    this.limits = Object.freeze({ ...DEFAULT_RETOUCH_LIMITS, ...(limits ?? {}) });
    /** Ngưỡng hiệu lực = min(cấu hình, RETOUCH_LIMITS) — xem `resolveRetouchLimits`. */
    this.retouchLimits = Object.freeze(resolveRetouchLimits(retouchLimits));
  }

  get name() {
    return this.#name;
  }

  get model() {
    return this.#model;
  }

  /** `true` = provider KHÔNG retouch thật (chỉ để chạy thử luồng). */
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
   * Retouch — luôn trả `RetouchResult` đầy đủ, không bao giờ ném lỗi.
   * @param {{image?: object|Buffer|Uint8Array|string, params?: object}} [input]
   */
  async apply({ image, params } = {}) {
    const started = Date.now();
    const img = normalizeImage(image);
    const clampedParams = clampRetouchParams(params, this.retouchLimits);
    const effective = clampedParams.params;
    const clamped = clampedParams.clamped;
    const rejected = clampedParams.rejected;
    const warnings = [];
    // `...rest` đứng TRƯỚC các field do lớp cơ sở quản lý ⇒ provider con không thể
    // ghi đè `params_effective`/`clamped`/`rejected`/`warnings`/`elapsed_ms`.
    const finish = (partial) => {
      const { warnings: extraWarnings, ...rest } = partial ?? {};
      return createRetouchResult({
        params_effective: effective,
        clamped,
        rejected,
        ...rest,
        warnings: [...warnings, ...(Array.isArray(extraWarnings) ? extraWarnings : [])],
        elapsed_ms: Date.now() - started,
      });
    };

    if (!this.configured) {
      return finish({
        status: RETOUCH_STATUS.FAILED,
        error_code: RETOUCH_CODES.NOT_CONFIGURED,
        warnings: [`Provider retouch "${this.name}" chưa được cấu hình — không retouch gì cả.`],
      });
    }
    if (!img.buffer || img.buffer.length === 0) {
      return finish({
        status: RETOUCH_STATUS.FAILED,
        error_code: RETOUCH_CODES.BAD_INPUT,
        warnings: ['Thiếu dữ liệu ảnh để retouch (image.buffer rỗng).'],
      });
    }

    // (1) Kẹp/rác: nói THẲNG số đo thật, không im lặng.
    if (rejected.length > 0) {
      warnings.push(
        `Tham số không phải số hữu hạn hoặc không nhận ra đã bị BỎ (coi như không truyền): ${rejected.join(', ')}.`,
      );
    }
    if (clamped.length > 0) {
      const raw = params && typeof params === 'object' ? params : {};
      const detail = clamped
        .map((name) => `${name}: ${Number(raw[name])} ⇒ ${effective[name]} (ngưỡng ±${this.retouchLimits[name]})`)
        .join('; ');
      warnings.push(`Tham số vượt ngưỡng đã bị KẸP: ${detail}.`);
    }

    // (2) Sau khi kẹp mà không còn tham số nào ⇒ KHÔNG có gì để làm (không bịa).
    const hasWork = RETOUCH_PARAM_NAMES.some((name) => effective[name] !== 0);
    if (!hasWork) {
      return finish({
        status: RETOUCH_STATUS.NO_CHANGES,
        error_code: RETOUCH_CODES.NO_CHANGES,
        warnings: [
          'Không có tham số retouch nào trong ngưỡng ⇒ KHÔNG retouch gì cả, ảnh giữ nguyên (NO_CHANGES, không phải OK).',
          'Không giải mã ảnh vì không có gì để làm — trạng thái này KHÔNG nói gì về định dạng ảnh đầu vào.',
        ],
      });
    }

    let partial;
    try {
      partial = (await this.applyImpl({ image: img, params: effective, clamped, rejected })) ?? {};
    } catch (err) {
      const code = err instanceof RetouchError ? err.code : (err && err.code) || RETOUCH_CODES.RETOUCH_FAILED;
      const message = err && err.message ? err.message : 'Lỗi không xác định khi retouch.';
      this.#logger?.warn?.('imagestudio.retouch.failed', { provider: this.name, code, message });
      return finish({
        status: RETOUCH_UNSUPPORTED_CODES.has(code) ? RETOUCH_STATUS.UNSUPPORTED_IMAGE : RETOUCH_STATUS.FAILED,
        error_code: code,
        warnings: [message],
      });
    }

    const partialWarnings = Array.isArray(partial.warnings) ? partial.warnings : [];
    let status = partial.status ?? RETOUCH_STATUS.OK;
    let errorCode = partial.error_code ?? null;
    let output = partial.output ?? null;

    if (status !== RETOUCH_STATUS.OK && output) {
      partialWarnings.push(
        `Provider "${this.name}" khai \`output\` trong khi status = ${status} — bỏ ảnh ra để không ai lưu nhầm là đã retouch.`,
      );
      output = null;
    }

    if (status === RETOUCH_STATUS.OK) {
      const outBuffer = output && Buffer.isBuffer(output.buffer) ? output.buffer : null;
      const outMime = outBuffer ? detectImageMime(outBuffer) : null;
      const inInfo = probeImage(img.buffer);
      const outInfo = outBuffer ? probeImage(outBuffer) : null;
      const fail = (code, message) => finish({ status: RETOUCH_STATUS.FAILED, error_code: code, warnings: [...partialWarnings, message] });

      if (!outBuffer || outBuffer.length === 0) {
        return fail(RETOUCH_CODES.RETOUCH_BAD_RESPONSE, `Provider "${this.name}" khai status = OK nhưng KHÔNG trả ảnh ra — TỪ CHỐI.`);
      }
      if (outMime !== 'image/png') {
        return fail(
          RETOUCH_CODES.RETOUCH_BAD_RESPONSE,
          `Ảnh retouch trả về không phải PNG (nhận ${outMime ?? 'không rõ định dạng'}) — TỪ CHỐI để không lưu ảnh không kiểm được pixel.`,
        );
      }
      if (inInfo && outInfo && (inInfo.width !== outInfo.width || inInfo.height !== outInfo.height)) {
        return fail(
          RETOUCH_CODES.RETOUCH_BAD_RESPONSE,
          `Ảnh retouch ${outInfo.width}×${outInfo.height} KHÁC ảnh gốc ${inInfo.width}×${inInfo.height} — TỪ CHỐI (retouch không được đổi kích thước).`,
        );
      }
      if (outBuffer.length > this.limits.maxOutputBytes) {
        return fail(
          RETOUCH_CODES.RETOUCH_OUTPUT_TOO_LARGE,
          `Ảnh retouch ${outBuffer.length} byte vượt giới hạn ${this.limits.maxOutputBytes} byte — TỪ CHỐI.`,
        );
      }
      const outSha = sha256(outBuffer);
      if (outSha === sha256(img.buffer)) {
        partialWarnings.push(
          `Provider "${this.name}" trả về ảnh Y HỆT ảnh gốc (sha256 không đổi) ⇒ KHÔNG có pixel nào được retouch — hạ xuống NO_CHANGES, không báo OK.`,
        );
        return finish({
          status: RETOUCH_STATUS.NO_CHANGES,
          error_code: RETOUCH_CODES.NO_CHANGES,
          warnings: partialWarnings,
        });
      }
      output = {
        buffer: outBuffer,
        mime: 'image/png',
        width: outInfo?.width ?? null,
        height: outInfo?.height ?? null,
        sha256: outSha,
      };
    }

    return finish({ status, output, error_code: errorCode, warnings: partialWarnings });
  }

  /** Provider con cài đặt phần thực thi. Mặc định: không hỗ trợ. */
  async applyImpl() {
    throw new RetouchError(RETOUCH_CODES.NOT_IMPLEMENTED, `Provider "${this.name}" chưa cài đặt apply().`);
  }
}

export { zeroRetouchParams };

export default RetouchProvider;
