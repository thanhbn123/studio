/**
 * Provider `http` — đẩy ảnh sang một service tách nền ngoài (hợp đồng §3.1, E1).
 *
 * Request : POST `${baseUrl}` body `{ image_base64, options }` (JSON)
 * Response: `{ image_base64, mask?, kept_bbox?, warnings? }`
 *
 * Bắt buộc đi qua `safeFetch` của `src/security/fetcher.js` (allowlist domain, ghim DNS,
 * timeout cứng, giới hạn byte đọc) — giống provider http của MVP-02.
 *
 * Trung thực: service KHÔNG trả `mask` thì các field số đo để `null` + cảnh báo,
 * TUYỆT ĐỐI không bịa `coverage`/`uniformity`. Ảnh trả về vẫn bị lớp cơ sở kiểm:
 * PNG thật, đúng kích thước ảnh gốc, và không được là bản sao y hệt ảnh vào.
 */

import { Buffer } from 'node:buffer';
import { safeFetch } from '../../../security/fetcher.js';
import { MattingProvider } from '../provider.js';
import { MattingError, MATTING_CODES } from '../errors.js';
import { MATTING_STATUS } from '../result.js';
import { clampBox, probeImage } from '../../../imagelab/render/image.js';
import { sha256 } from '../../../imagelab/render/png.js';

/** Kiểm base64 hợp lệ trước khi giải mã (không để Buffer.from nuốt rác). */
function decodeBase64Image(value) {
  const clean = String(value)
    .replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
    .replace(/\s+/g, '');
  if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
  const buffer = Buffer.from(clean, 'base64');
  return buffer.length > 0 ? buffer : null;
}

/** Chỉ nhận số hữu hạn; mọi thứ khác ⇒ null (không bịa số đo). */
function finiteOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class HttpMattingProvider extends MattingProvider {
  #apiKey;
  #timeoutMs;
  #allowPrivateNetwork;

  constructor({ baseUrl = '', apiKey = '', model = '', timeoutMs = 60000, limits, logger, allowPrivateNetwork = false } = {}) {
    const valid = HttpMattingProvider.#parseBaseUrl(baseUrl);
    super({ name: 'http', model: model || 'http', isMock: false, configured: Boolean(valid), limits, logger });
    this.baseUrl = valid ? valid.toString() : '';
    this.host = valid ? valid.hostname : '';
    this.#apiKey = apiKey;
    this.#timeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000;
    this.#allowPrivateNetwork = Boolean(allowPrivateNetwork);
  }

  static #parseBaseUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url;
    } catch {
      return null;
    }
  }

  async removeBackgroundImpl({ image, options }) {
    const warnings = [];
    const payload = JSON.stringify({
      image_base64: image.buffer.toString('base64'),
      options: options && typeof options === 'object' ? options : {},
    });

    let response;
    try {
      response = await safeFetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: payload,
        timeoutMs: this.#timeoutMs,
        // Body trả về là base64 của ảnh PNG (đã có alpha) ⇒ rộng hơn giới hạn ảnh ~1.4 lần.
        maxBytes: Math.ceil(this.limits.maxOutputBytes * 1.4) + 1024 * 1024,
        domains: [this.host],
        allowPrivateNetwork: this.#allowPrivateNetwork,
      });
    } catch (err) {
      const blocked = err?.code === 'DOMAIN_NOT_ALLOWED' || err?.code === 'DOWNGRADE_REDIRECT';
      throw new MattingError(
        blocked ? MATTING_CODES.MATTING_DOMAIN_NOT_ALLOWED : MATTING_CODES.MATTING_NETWORK,
        `Không gọi được provider tách nền http: ${err?.message ?? 'lỗi mạng'}`,
        { cause: err?.code ?? null, host: this.host },
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new MattingError(MATTING_CODES.MATTING_HTTP_STATUS, `Provider tách nền http trả HTTP ${response.status}.`, {
        status: response.status,
      });
    }

    let json = null;
    try {
      json = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new MattingError(MATTING_CODES.MATTING_BAD_RESPONSE, 'Provider tách nền http không trả JSON hợp lệ.');
    }

    const encoded = json?.image_base64 ?? json?.image ?? null;
    if (typeof encoded !== 'string' || !encoded) {
      throw new MattingError(MATTING_CODES.MATTING_BAD_RESPONSE, 'Provider tách nền http không trả `image_base64`.');
    }
    const outBuffer = decodeBase64Image(encoded);
    if (!outBuffer) {
      throw new MattingError(MATTING_CODES.MATTING_BAD_RESPONSE, '`image_base64` của provider tách nền không hợp lệ.');
    }
    if (outBuffer.length > this.limits.maxOutputBytes) {
      throw new MattingError(
        MATTING_CODES.MATTING_OUTPUT_TOO_LARGE,
        `Ảnh trả về ${outBuffer.length} byte vượt giới hạn ${this.limits.maxOutputBytes} byte.`,
        { bytes: outBuffer.length },
      );
    }

    for (const w of Array.isArray(json.warnings) ? json.warnings : []) {
      if (typeof w === 'string') warnings.push(w);
    }

    const rawMask = json.mask && typeof json.mask === 'object' ? json.mask : null;
    const mask = rawMask
      ? {
          coverage: finiteOrNull(rawMask.coverage),
          background_ratio: finiteOrNull(rawMask.background_ratio),
          uniformity: finiteOrNull(rawMask.uniformity),
          seed_colors: finiteOrNull(rawMask.seed_colors),
        }
      : { coverage: null, background_ratio: null, uniformity: null, seed_colors: null };
    if (!rawMask) {
      warnings.push(
        'Provider tách nền http không trả `mask` — KHÔNG có số đo để kiểm chứng (coverage/background_ratio/uniformity để null, không bịa).',
      );
    } else if (Object.values(mask).some((v) => v === null)) {
      warnings.push('Provider tách nền http trả `mask` thiếu field — phần thiếu để null, không bịa số.');
    }

    const inInfo = probeImage(image.buffer);
    const rawKept = json.kept_bbox ?? json.keptBox ?? null;
    const keptBox = rawKept ? clampBox(rawKept, { width: inInfo?.width, height: inInfo?.height }) : null;
    if (rawKept && !keptBox) {
      warnings.push('Provider tách nền http trả `kept_bbox` không hợp lệ — bỏ, để null.');
    }

    const info = probeImage(outBuffer);
    return {
      status: MATTING_STATUS.OK,
      output: {
        buffer: outBuffer,
        mime: 'image/png',
        width: info?.width ?? null,
        height: info?.height ?? null,
        sha256: sha256(outBuffer),
      },
      mask,
      kept_bbox: keptBox,
      warnings,
    };
  }
}

export default HttpMattingProvider;
