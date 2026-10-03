/**
 * C1 — OCR PROVIDER (MVP-02).
 *
 * Phát hiện vùng chữ trên ảnh sản phẩm và trả về `OcrResult` ĐÓNG BĂNG theo hợp đồng 4.1.
 *
 * Nguyên tắc của module:
 *  - **Không bịa**: provider mock tự khai `is_mock = true`; không field nào được sinh ra
 *    mà không chứng minh được nguồn (chữ/hộp/độ tin cậy đến từ fixture hoặc từ REST API).
 *  - **Fail-closed**: `detect()` KHÔNG BAO GIỜ ném lỗi ra ngoài. Mọi sự cố trả về
 *    `status: 'FAILED'` kèm `error_code` rõ ràng (hoặc `NOT_CONFIGURED` /
 *    `UNSUPPORTED_IMAGE` khi đúng trường hợp).
 *  - **Không log secret**: `apiKey` chỉ nằm trong header Authorization, không vào log/lỗi.
 *  - Vùng chữ nguyên văn KHÔNG bị dịch ở đây; phân loại `kind` do `classifyRegion()` quyết
 *    định và nhãn hiệu/chứng nhận/giá luôn có `translatable = false` (luật 3).
 *
 * Trạng thái trả về: `OK` | `NO_TEXT` | `NOT_CONFIGURED` | `FAILED` | `UNSUPPORTED_IMAGE`.
 */

import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { safeFetch } from '../../security/fetcher.js';
import {
  KIND_REASONS,
  PROTECTION_RANK,
  REGION_KINDS,
  classifyRegion,
  containsCjk,
  reasonForKind,
} from './classify.js';
import { normalizeRegions } from './normalize.js';

export { KIND_REASONS, PROTECTION_RANK, REGION_KINDS, classifyRegion, containsCjk, normalizeRegions };

/** Trạng thái hợp lệ của OcrResult (đóng băng theo hợp đồng 4.1). */
export const OCR_STATUSES = Object.freeze([
  'OK',
  'NO_TEXT',
  'NOT_CONFIGURED',
  'FAILED',
  'UNSUPPORTED_IMAGE',
]);

/** Tên provider hợp lệ. */
export const OCR_PROVIDER_NAMES = Object.freeze(['mock', 'http', 'none']);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** Gốc repo, suy từ vị trí file (src/imagelab/ocr/index.js → ../../../). */
const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..', '..');

/** Fixture mock mặc định (đường dẫn tuyệt đối, không phụ thuộc cwd). */
export const DEFAULT_MOCK_FIXTURE = path.join(MODULE_DIR, 'fixtures', 'mock-regions.json');

/** Giá trị mặc định của `OCR_MOCK_FIXTURE`/`config.ocr.mockFixture` theo hợp đồng 4.1. */
export const CONTRACT_DEFAULT_FIXTURE_REL = 'src/imagelab/ocr/fixtures/mock-regions.json';

/** Lỗi có mã của module OCR. `detect()` bắt lỗi này và biến thành OcrResult FAILED. */
export class OcrError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OcrError';
    this.code = code;
    this.details = details;
  }
}

const hasValue = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/** Che đường dẫn nội bộ trong thông báo lỗi (chỉ hiện phần tương đối tính từ gốc repo). */
function shortPath(p) {
  const abs = path.resolve(p);
  return abs.startsWith(REPO_ROOT) ? path.relative(REPO_ROOT, abs) : path.basename(abs);
}

/** Nhận Buffer / Uint8Array / ArrayBuffer; KHÔNG sửa dữ liệu đầu vào. */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

/** Dựng OcrResult đủ mọi field của hợp đồng (không thêm, không bớt). */
function buildResult({
  status,
  provider,
  model,
  isMock,
  regions,
  dropped,
  warnings,
  usage,
  errorCode,
  errorMessage,
}) {
  const u =
    usage && Number.isFinite(usage.input_units) && Number.isFinite(usage.output_units)
      ? { input_units: usage.input_units, output_units: usage.output_units }
      : null;
  return {
    status,
    provider,
    model: model || '',
    is_mock: Boolean(isMock),
    regions: Array.isArray(regions) ? regions : [],
    dropped: Array.isArray(dropped) ? dropped : [],
    warnings: Array.isArray(warnings) ? warnings : [],
    usage: u,
    error_code: errorCode ?? null,
    error_message: errorMessage ?? null,
  };
}

/** Mã lỗi của `safeFetch`/url-guard được coi là "bị chặn bởi chính sách mạng". */
const GUARD_CODES = new Set([
  'DOMAIN_NOT_ALLOWED',
  'PRIVATE_IP',
  'BLOCKED_HOST',
  'DNS_FAILED',
  'DNS_EMPTY',
  'BAD_SCHEME',
  'MALFORMED_URL',
  'EMPTY_URL',
  'EMPTY_HOST',
  'BAD_PORT',
  'CREDENTIALS_IN_URL',
  'URL_TOO_LONG',
  'DOWNGRADE_REDIRECT',
]);

/** Đổi lỗi mạng thành OcrError có mã rõ ràng, không lộ secret. */
function mapFetchError(err, host, timeoutMs) {
  const raw = String(err?.code || '');
  if (raw === 'TIMEOUT') {
    return new OcrError('OCR_TIMEOUT', `Gọi máy chủ OCR quá hạn ${timeoutMs}ms (${host}).`, { cause: raw });
  }
  const guard = err?.name === 'UrlGuardError' || GUARD_CODES.has(raw);
  if (guard) {
    return new OcrError(
      'OCR_HTTP_BLOCKED',
      `Bị chặn bởi bảo vệ SSRF khi gọi ${host} (${raw || 'policy'}). Nếu OCR chạy trong mạng nội bộ, đặt ALLOW_PRIVATE_NETWORK=true.`,
      { cause: raw },
    );
  }
  return new OcrError(
    'OCR_HTTP_FAILED',
    `Không gọi được máy chủ OCR ${host}: ${err?.message || raw || 'lỗi không rõ'}`,
    { cause: raw },
  );
}

/** Cấu hình `baseUrl` hợp lệ (http/https) hay không. */
function parseHttpBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Lớp cơ sở của mọi OCR provider.
 *
 * `detect()` là lớp bọc an toàn: gọi `_detect()` của provider con và biến mọi lỗi thành
 * OcrResult `FAILED`. Provider con chỉ cần viết `_detect()`.
 */
export class OcrProvider {
  #name;
  #model;
  #isMock;
  #configured;
  #logger;
  #config;

  constructor({
    name = 'none',
    model = '',
    isMock = false,
    configured = false,
    logger = null,
    config = null,
  } = {}) {
    this.#name = name;
    this.#model = model;
    this.#isMock = Boolean(isMock);
    this.#configured = Boolean(configured);
    this.#logger = logger;
    this.#config = config;
  }

  get name() {
    return this.#name;
  }

  get model() {
    return this.#model;
  }

  /** BẮT BUỘC đúng sự thật: provider mock/dữ liệu dựng tay ⇒ true. */
  get isMock() {
    return this.#isMock;
  }

  /** Có đủ cấu hình để chạy thật hay không. */
  get configured() {
    return this.#configured;
  }

  /** Nội bộ — provider con dùng để đọc cấu hình chung (không phải API công khai). */
  get _config() {
    return this.#config;
  }

  /** Nội bộ. */
  get _logger() {
    return this.#logger;
  }

  /**
   * Phát hiện vùng chữ. KHÔNG BAO GIỜ ném lỗi.
   *
   * @param {{buffer?:Buffer|Uint8Array, mime?:string, width?:number, height?:number}} input
   * @param {{maxRegions?:number, minConfidence?:number}} [options]
   * @returns {Promise<object>} OcrResult (hợp đồng 4.1)
   */
  async detect(input = {}, options = {}) {
    try {
      return await this._detect(input || {}, options || {});
    } catch (err) {
      return this._failedResult(err);
    }
  }

  /** Provider con hiện thực. Mặc định: chưa hiện thực → FAILED (không im lặng). */
  async _detect() {
    return this._result({
      status: 'FAILED',
      errorCode: 'OCR_NOT_IMPLEMENTED',
      errorMessage: 'Provider OCR cơ sở chưa hiện thực _detect().',
    });
  }

  /** Dựng OcrResult với danh tính của provider này. */
  _result(partial = {}) {
    return buildResult({
      status: partial.status || 'FAILED',
      provider: this.name,
      model: this.model,
      isMock: this.isMock,
      ...partial,
    });
  }

  /** Biến lỗi thành OcrResult FAILED + ghi log (logger đã che secret). */
  _failedResult(err) {
    let code = 'OCR_INTERNAL_ERROR';
    if (err instanceof OcrError) code = err.code;
    else if (typeof err?.code === 'string' && err.code.startsWith('OCR_')) code = err.code;

    const message = err instanceof Error ? err.message : String(err);
    this.#logger?.warn?.('imagelab.ocr.failed', {
      provider: this.name,
      error_code: code,
      error: message,
    });
    return this._result({
      status: 'FAILED',
      errorCode: code,
      errorMessage: message.slice(0, 500),
    });
  }

  /** Kích thước ảnh dùng được (số nguyên > 0) hay không. */
  _resolveImageSize(width, height) {
    const w = Number(width);
    const h = Number(height);
    const ok = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
    return { ok, width: ok ? Math.trunc(w) : 0, height: ok ? Math.trunc(h) : 0 };
  }

  /** Giới hạn số vùng / ngưỡng tin cậy: ưu tiên tham số gọi, rồi tới `config.imagelab`. */
  _normOptions({ maxRegions, minConfidence } = {}) {
    const cfg = this.#config?.imagelab || {};
    const capRaw = hasValue(maxRegions) ? Number(maxRegions) : Number(cfg.maxRegions);
    const minRaw = hasValue(minConfidence) ? Number(minConfidence) : Number(cfg.minConfidence);
    return {
      maxRegions: Number.isFinite(capRaw) && capRaw > 0 ? Math.trunc(capRaw) : 200,
      minConfidence: Number.isFinite(minRaw) ? minRaw : 0.5,
    };
  }
}

/**
 * Provider `mock` — đọc vùng chữ từ fixture JSON.
 *
 * Đây là dữ liệu DỰNG TAY (xem trường `note` trong fixture), KHÔNG phải OCR thật:
 * `is_mock = true`, `provider = 'mock'`. Dùng để chạy/test toàn luồng mà không cần API.
 */
export class MockOcrProvider extends OcrProvider {
  #fixturePath;
  #fixture = null;

  constructor({
    fixturePath = null,
    model = 'mock-ocr-v1',
    logger = null,
    config = null,
    maxRegions,
    minConfidence,
  } = {}) {
    super({ name: 'mock', model, isMock: true, configured: true, logger, config });
    this.#fixturePath =
      (typeof fixturePath === 'string' && fixturePath.trim()) || config?.ocr?.mockFixture || DEFAULT_MOCK_FIXTURE;
    this._defaultMaxRegions = maxRegions;
    this._defaultMinConfidence = minConfidence;
  }

  /** Đường dẫn fixture đang dùng (tiện cho log/chẩn đoán; không chứa secret). */
  get fixturePath() {
    return this.#fixturePath;
  }

  async _detect({ width, height } = {}, options = {}) {
    const fixture = await this.#loadFixture();
    const opts = this._normOptions({
      maxRegions: options.maxRegions ?? this._defaultMaxRegions,
      minConfidence: options.minConfidence ?? this._defaultMinConfidence,
    });

    const providedSize = this._resolveImageSize(width, height);
    const callerGaveSize = hasValue(width) || hasValue(height);
    let size = providedSize;
    let sizeFromFixture = false;
    if (!size.ok && !callerGaveSize) {
      // Người gọi không khai kích thước: dùng kích thước do CHÍNH FIXTURE khai
      // (dữ liệu mock, đã ghi rõ trong fixture) — không suy diễn gì thêm.
      size = this._resolveImageSize(fixture.width, fixture.height);
      sizeFromFixture = size.ok;
    }

    const norm = normalizeRegions(fixture.regions, {
      width: size.ok ? size.width : width,
      height: size.ok ? size.height : height,
      maxRegions: opts.maxRegions,
      minConfidence: opts.minConfidence,
    });

    if (!size.ok) {
      return this._result({
        status: 'UNSUPPORTED_IMAGE',
        dropped: norm.dropped,
        warnings: norm.warnings,
        errorCode: 'OCR_UNSUPPORTED_IMAGE',
        errorMessage:
          'Ảnh không có kích thước hợp lệ (width/height thiếu, bằng 0 hoặc âm) — không thể quy đổi hộp chữ.',
      });
    }

    const warnings = [...norm.warnings];
    if (sizeFromFixture) {
      warnings.push(
        'Không nhận được width/height — provider mock dùng kích thước do fixture mock tự khai (dữ liệu MOCK).',
      );
    }
    const status = norm.regions.length > 0 ? 'OK' : 'NO_TEXT';
    if (status === 'NO_TEXT') {
      warnings.push('Fixture OCR mock không có vùng chữ nào dùng được.');
    }

    return this._result({
      status,
      regions: norm.regions,
      dropped: norm.dropped,
      warnings,
      usage: { input_units: size.width * size.height, output_units: norm.regions.length },
    });
  }

  /** Các đường dẫn sẽ thử, theo thứ tự: cấu hình (tuyệt đối/gốc repo/cwd) → mặc định. */
  #fixtureCandidates() {
    const configured = String(this.#fixturePath ?? '').trim();
    if (!configured) return [DEFAULT_MOCK_FIXTURE];

    const out = path.isAbsolute(configured)
      ? [configured]
      : [path.resolve(REPO_ROOT, configured), path.resolve(process.cwd(), configured)];
    const uniq = [...new Set(out)];

    // CHỈ khi cấu hình đang trỏ tới fixture MẶC ĐỊNH của hợp đồng thì mới thêm đường dẫn
    // tuyệt đối nội bộ làm phương án dự phòng (để không phụ thuộc cwd/dấu đường dẫn).
    // Đường dẫn riêng do người vận hành khai mà không tồn tại thì phải FAILED —
    // không được fallback im lặng (luật 4: fail-closed, không fail-im lặng).
    const isContractDefault =
      configured.replace(/\\/g, '/').replace(/^\.\//, '') === CONTRACT_DEFAULT_FIXTURE_REL ||
      uniq.includes(DEFAULT_MOCK_FIXTURE);
    if (isContractDefault) uniq.push(DEFAULT_MOCK_FIXTURE);
    return [...new Set(uniq)];
  }

  /** Nạp fixture (cache theo instance). Sai/thiếu → OcrError có mã rõ ràng. */
  async #loadFixture() {
    if (this.#fixture) return this.#fixture;

    const tried = [];
    for (const candidate of this.#fixtureCandidates()) {
      tried.push(shortPath(candidate));
      let text;
      try {
        text = await readFile(candidate, 'utf8');
      } catch (err) {
        if (err?.code === 'ENOENT') continue;
        throw new OcrError(
          'OCR_MOCK_FIXTURE_UNREADABLE',
          `Không đọc được fixture OCR mock (${shortPath(candidate)}): ${err?.code || err?.message || 'lỗi không rõ'}.`,
        );
      }

      let json;
      try {
        json = JSON.parse(text);
      } catch (err) {
        throw new OcrError(
          'OCR_MOCK_FIXTURE_BAD_JSON',
          `Fixture OCR mock không phải JSON hợp lệ (${shortPath(candidate)}): ${err.message}`,
        );
      }
      if (!json || typeof json !== 'object' || !Array.isArray(json.regions)) {
        throw new OcrError(
          'OCR_MOCK_FIXTURE_BAD_JSON',
          `Fixture OCR mock thiếu mảng "regions" (${shortPath(candidate)}).`,
        );
      }
      if (json.is_mock !== true) {
        throw new OcrError(
          'OCR_MOCK_FIXTURE_NOT_MOCK',
          `Fixture phải tự khai "is_mock": true (luật 1 — không bịa) (${shortPath(candidate)}).`,
        );
      }

      this.#fixture = json;
      return json;
    }

    throw new OcrError(
      'OCR_MOCK_FIXTURE_MISSING',
      `Không tìm thấy fixture OCR mock (đã thử: ${tried.join(', ')}). Đặt OCR_MOCK_FIXTURE trỏ tới file JSON có mảng "regions".`,
    );
  }
}

/**
 * Provider `http` — adapter REST tổng quát.
 *
 * POST `${baseUrl}` với body `{ image_base64, mime, width, height, max_regions }`,
 * chờ JSON `{ regions: [...] }`. Đi qua `safeFetch` (allowlist = đúng host của baseUrl,
 * chặn IP nội bộ trừ khi `ALLOW_PRIVATE_NETWORK=true`). `is_mock = false`.
 */
export class HttpOcrProvider extends OcrProvider {
  #baseUrl;
  #host;
  #apiKey;
  #timeoutMs;
  #fetchImpl;

  constructor({
    baseUrl = '',
    apiKey = '',
    model = '',
    timeoutMs = 60000,
    logger = null,
    config = null,
    fetchImpl = safeFetch,
  } = {}) {
    const url = parseHttpBaseUrl(baseUrl);
    super({
      name: 'http',
      model,
      isMock: false,
      configured: Boolean(url && String(apiKey ?? '').trim()),
      logger,
      config,
    });
    this.#baseUrl = url ? url.toString() : String(baseUrl ?? '').trim();
    this.#host = url ? url.hostname : '';
    this.#apiKey = String(apiKey ?? '').trim();
    this.#timeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000;
    this.#fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : safeFetch;
  }

  async _detect({ buffer, mime, width, height } = {}, options = {}) {
    const opts = this._normOptions(options);

    if (!this.configured) {
      const missing = this.#host ? 'OCR_API_KEY' : 'OCR_BASE_URL (http/https hợp lệ)';
      return this._result({
        status: 'NOT_CONFIGURED',
        warnings: ['OCR chưa được cấu hình — không có vùng chữ nào được phát hiện.'],
        errorCode: 'OCR_NOT_CONFIGURED',
        errorMessage: `Provider OCR 'http' chưa được cấu hình: thiếu ${missing}.`,
      });
    }

    const size = this._resolveImageSize(width, height);
    if (!size.ok) {
      const norm = normalizeRegions([], { width, height, maxRegions: opts.maxRegions, minConfidence: opts.minConfidence });
      return this._result({
        status: 'UNSUPPORTED_IMAGE',
        dropped: norm.dropped,
        warnings: norm.warnings,
        errorCode: 'OCR_UNSUPPORTED_IMAGE',
        errorMessage:
          'Ảnh không có kích thước hợp lệ (width/height thiếu, bằng 0 hoặc âm) — không gọi OCR vì không thể quy đổi toạ độ vùng chữ.',
      });
    }

    const image = toBuffer(buffer);
    if (!image || image.length === 0) {
      return this._result({
        status: 'FAILED',
        errorCode: 'OCR_BAD_IMAGE',
        errorMessage: 'Thiếu dữ liệu ảnh (buffer rỗng hoặc không phải Buffer/Uint8Array) — không có gì để OCR.',
      });
    }

    const body = JSON.stringify({
      image_base64: image.toString('base64'),
      mime: mime || '',
      width: size.width,
      height: size.height,
      max_regions: opts.maxRegions,
    });

    let res;
    try {
      res = await this.#fetchImpl(this.#baseUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.#apiKey}`,
        },
        body,
        timeoutMs: this.#timeoutMs,
        maxBytes: Number(this._config?.net?.maxFetchBytes) > 0 ? Number(this._config.net.maxFetchBytes) : 8 * 1024 * 1024,
        allowPrivateNetwork: this._config?.net?.allowPrivateNetwork === true,
        // Allowlist = đúng host do người vận hành cấu hình trong OCR_BASE_URL.
        domains: [this.#host],
      });
    } catch (err) {
      throw mapFetchError(err, this.#host, this.#timeoutMs);
    }

    if (!(res && res.status >= 200 && res.status < 300)) {
      throw new OcrError('OCR_HTTP_FAILED', `Máy chủ OCR trả HTTP ${res?.status ?? 'không rõ'}.`, {
        status: res?.status ?? null,
      });
    }

    let json;
    try {
      json = JSON.parse(res.body.toString('utf8'));
    } catch (err) {
      throw new OcrError('OCR_BAD_JSON', `Máy chủ OCR trả về JSON không hợp lệ: ${err.message}`);
    }
    if (!json || typeof json !== 'object' || !Array.isArray(json.regions)) {
      throw new OcrError('OCR_BAD_RESPONSE', 'JSON của máy chủ OCR thiếu mảng "regions".', {
        keys: json && typeof json === 'object' ? Object.keys(json).slice(0, 10) : [],
      });
    }

    const norm = normalizeRegions(json.regions, {
      width: size.width,
      height: size.height,
      maxRegions: opts.maxRegions,
      minConfidence: opts.minConfidence,
    });
    const status = norm.regions.length > 0 ? 'OK' : 'NO_TEXT';
    const warnings = [...norm.warnings];
    if (status === 'NO_TEXT') {
      warnings.push('Máy chủ OCR không trả về vùng chữ nào dùng được.');
    }

    return this._result({
      status,
      regions: norm.regions,
      dropped: norm.dropped,
      warnings,
      usage: { input_units: size.width * size.height, output_units: norm.regions.length },
    });
  }
}

/** Provider `none` — chưa cấu hình (mặc định an toàn, không bịa vùng chữ nào). */
export class NoneOcrProvider extends OcrProvider {
  #requested;

  constructor({ requested = null, model = '', logger = null, config = null } = {}) {
    super({ name: 'none', model, isMock: false, configured: false, logger, config });
    this.#requested = requested ? String(requested).slice(0, 40) : null;
  }

  async _detect() {
    return this._result({
      status: 'NOT_CONFIGURED',
      warnings: ['Chưa cấu hình OCR — không có vùng chữ nào được phát hiện.'],
      errorCode: 'OCR_NOT_CONFIGURED',
      errorMessage: this.#requested
        ? `Provider OCR không được hỗ trợ: '${this.#requested}'. Dùng 'mock', 'http' hoặc 'none'.`
        : "Chưa cấu hình OCR provider (OCR_PROVIDER=none). Đặt OCR_PROVIDER=mock để chạy thử, hoặc 'http' kèm OCR_BASE_URL + OCR_API_KEY để OCR thật.",
    });
  }
}

/**
 * Tạo OCR provider từ cấu hình (`config.ocr`).
 *
 * @param {object} config cấu hình đã load (`loadConfig()`)
 * @param {{logger?:object}} [deps]
 * @returns {OcrProvider}
 */
export function createOcrProvider(config, { logger } = {}) {
  const cfg = config?.ocr || {};
  const provider =
    cfg.provider === undefined || cfg.provider === null ? 'mock' : String(cfg.provider).trim().toLowerCase();

  if (provider === 'mock') {
    return new MockOcrProvider({
      fixturePath: cfg.mockFixture,
      model: cfg.model || 'mock-ocr-v1',
      logger,
      config,
    });
  }
  if (provider === 'http') {
    return new HttpOcrProvider({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model || '',
      timeoutMs: cfg.timeoutMs,
      logger,
      config,
    });
  }
  if (provider === '' || provider === 'none') {
    return new NoneOcrProvider({ model: cfg.model || '', logger, config });
  }

  // Provider lạ: KHÔNG đoán — fail-closed về `none` và ghi log để người vận hành biết.
  logger?.warn?.('imagelab.ocr.unknown_provider', { provider });
  return new NoneOcrProvider({ requested: provider, model: cfg.model || '', logger, config });
}

export default createOcrProvider;
