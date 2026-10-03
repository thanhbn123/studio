/**
 * Provider `http` — đẩy ảnh + ops sang một service render ngoài (hợp đồng 4.3).
 *
 * Request : POST `${baseUrl}` body `{ image_base64, mime, ops }` (JSON)
 * Response: `{ image_base64, applied?, unsupported_glyphs?, warnings? }`
 *
 * Bắt buộc đi qua `safeFetch` của src/security/fetcher.js: allowlist domain (chỉ đúng host
 * đã cấu hình), ghim DNS, timeout cứng, giới hạn byte đọc.
 *
 * Trung thực: nếu service không trả `applied` thì KHÔNG tự bịa danh sách đã áp dụng —
 * `applied = []`, `status = 'PARTIAL'` và ghi cảnh báo.
 */

import { Buffer } from 'node:buffer';
import { safeFetch } from '../../../security/fetcher.js';
import { RenderProvider, RENDER_STATUS } from '../provider.js';
import { RenderError, RENDER_CODES } from '../errors.js';
import { detectImageMime, probeImage } from '../image.js';
import { sha256 } from '../png.js';

/** Kiểm base64 hợp lệ trước khi giải mã (không để Buffer.from nuốt rác). */
function decodeBase64Image(value) {
  const clean = String(value).replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').replace(/\s+/g, '');
  if (!clean || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
  const buffer = Buffer.from(clean, 'base64');
  return buffer.length > 0 ? buffer : null;
}

/** Serialize op gửi đi — chỉ những field hợp đồng cho phép. */
function serializeOp(op) {
  return {
    region_id: op.region_id,
    action: op.action,
    box: op.box,
    ...(op.text ? { text: op.text } : {}),
    ...(op.style && Object.keys(op.style).length ? { style: op.style } : {}),
  };
}

export class HttpRenderProvider extends RenderProvider {
  constructor({ baseUrl = '', apiKey = '', model = '', timeoutMs = 60000, limits, logger, allowPrivateNetwork = false } = {}) {
    const valid = HttpRenderProvider.#parseBaseUrl(baseUrl);
    super({
      name: 'http',
      model: model || 'http',
      isMock: false,
      configured: Boolean(valid),
      limits,
      logger,
    });
    this.baseUrl = valid ? valid.toString() : '';
    this.host = valid ? valid.hostname : '';
    this.#apiKey = apiKey;
    this.#timeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000;
    this.#allowPrivateNetwork = Boolean(allowPrivateNetwork);
  }

  #apiKey;
  #timeoutMs;
  #allowPrivateNetwork;

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

  async renderImpl({ image, ops }) {
    if (!image.buffer || image.buffer.length === 0) {
      throw new RenderError(RENDER_CODES.BAD_INPUT, 'Thiếu dữ liệu ảnh để render (provider http).');
    }
    const mime = detectImageMime(image.buffer) ?? image.mime ?? null;
    const payload = JSON.stringify({
      image_base64: image.buffer.toString('base64'),
      mime,
      ops: ops.map(serializeOp),
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
        // Body trả về là base64 của ảnh → rộng hơn giới hạn ảnh ~1.4 lần.
        maxBytes: Math.ceil(this.limits.maxOutputBytes * 1.4) + 1024 * 1024,
        domains: [this.host],
        allowPrivateNetwork: this.#allowPrivateNetwork,
      });
    } catch (err) {
      // Bị allowlist chặn là lỗi CẤU HÌNH, khác với lỗi mạng — trả mã riêng cho dễ chẩn đoán.
      const blocked = err?.code === 'DOMAIN_NOT_ALLOWED' || err?.code === 'DOWNGRADE_REDIRECT';
      throw new RenderError(
        blocked ? RENDER_CODES.RENDER_DOMAIN_NOT_ALLOWED : RENDER_CODES.RENDER_NETWORK,
        `Không gọi được provider render http: ${err?.message ?? 'lỗi mạng'}`,
        { cause: err?.code ?? null, host: this.host },
      );
    }

    if (response.status < 200 || response.status >= 300) {
      throw new RenderError(RENDER_CODES.RENDER_HTTP_STATUS, `Provider render http trả HTTP ${response.status}.`, {
        status: response.status,
      });
    }

    let json = null;
    try {
      json = JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new RenderError(RENDER_CODES.RENDER_BAD_RESPONSE, 'Provider render http không trả JSON hợp lệ.');
    }
    const encoded = json?.image_base64 ?? json?.image ?? null;
    if (typeof encoded !== 'string' || !encoded) {
      throw new RenderError(RENDER_CODES.RENDER_BAD_RESPONSE, 'Provider render http không trả `image_base64`.');
    }
    const outBuffer = decodeBase64Image(encoded);
    if (!outBuffer) {
      throw new RenderError(RENDER_CODES.RENDER_BAD_RESPONSE, '`image_base64` của provider render không hợp lệ.');
    }
    if (outBuffer.length > this.limits.maxOutputBytes) {
      throw new RenderError(
        RENDER_CODES.RENDER_OUTPUT_TOO_LARGE,
        `Ảnh trả về ${outBuffer.length} byte vượt giới hạn ${this.limits.maxOutputBytes} byte.`,
        { bytes: outBuffer.length },
      );
    }

    const info = probeImage(outBuffer);
    const warnings = Array.isArray(json.warnings) ? json.warnings.filter((w) => typeof w === 'string') : [];
    const unsupported = Array.isArray(json.unsupported_glyphs)
      ? json.unsupported_glyphs.filter((g) => typeof g === 'string')
      : [];
    let applied = [];
    let status = RENDER_STATUS.OK;
    if (Array.isArray(json.applied)) {
      applied = json.applied.filter((item) => item && typeof item === 'object');
      if (applied.length < ops.length || unsupported.length > 0) status = RENDER_STATUS.PARTIAL;
    } else {
      status = RENDER_STATUS.PARTIAL;
      warnings.push(
        'Provider http không trả `applied` — không chứng minh được op nào đã áp dụng, nên KHÔNG liệt kê (không bịa).',
      );
    }

    return {
      status,
      output: {
        buffer: outBuffer,
        mime: info?.mime ?? 'image/png',
        width: info?.width ?? null,
        height: info?.height ?? null,
        sha256: sha256(outBuffer),
      },
      applied,
      skipped: [],
      unsupported_glyphs: unsupported,
      warnings,
    };
  }
}

export default HttpRenderProvider;
