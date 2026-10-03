/**
 * Cấu hình tập trung — đọc từ biến môi trường.
 *
 * Nguyên tắc:
 *  - KHÔNG hardcode secret trong mã nguồn.
 *  - `loadConfig()` nhận env giả để test được mà không cần đụng process.env.
 *  - Giá trị mặc định phải an toàn (fail-closed), đặc biệt với bảo mật mạng.
 */

const toInt = (raw, fallback) => {
  const n = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};

const toBool = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
};

const toStr = (raw, fallback = '') => {
  const v = raw === undefined || raw === null ? '' : String(raw).trim();
  return v === '' ? fallback : v;
};

const toList = (raw, fallback = []) => {
  const v = toStr(raw);
  if (!v) return fallback;
  return v
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
};

export const AI_PROVIDERS = ['deepseek', 'openai', 'anthropic', 'gemini', 'mock'];

export function loadConfig(env = process.env) {
  const aiProvider = toStr(env.AI_PROVIDER, 'deepseek').toLowerCase();
  const visionProvider = toStr(env.VISION_PROVIDER, aiProvider).toLowerCase();

  const cfg = {
    env: toStr(env.NODE_ENV, 'development'),
    host: toStr(env.HOST, '127.0.0.1'),
    port: toInt(env.PORT, 3000),
    publicBaseUrl: toStr(env.PUBLIC_BASE_URL, ''),
    logLevel: toStr(env.LOG_LEVEL, 'info').toLowerCase(),

    db: {
      driver: toStr(env.DB_DRIVER, 'sqlite').toLowerCase(),
      sqlitePath: toStr(env.SQLITE_PATH, './data/studio.db'),
      url: toStr(env.DATABASE_URL, ''),
      sslMode: toStr(env.PGSSLMODE, 'disable').toLowerCase(),
      poolMax: toInt(env.PG_POOL_MAX, 10),
    },

    ai: {
      provider: aiProvider,
      apiKey: toStr(env.AI_API_KEY, ''),
      baseUrl: toStr(env.AI_BASE_URL, ''),
      model: toStr(env.AI_MODEL, ''),
      timeoutMs: toInt(env.AI_TIMEOUT_MS, 120000),
      maxOutputTokens: toInt(env.AI_MAX_OUTPUT_TOKENS, 4096),
      temperature: Number.isFinite(Number(env.AI_TEMPERATURE))
        ? Number(env.AI_TEMPERATURE)
        : 0.4,
    },

    vision: {
      provider: visionProvider,
      // Kế thừa cấu hình AI nếu không khai riêng.
      apiKey: toStr(env.VISION_API_KEY, '') || toStr(env.AI_API_KEY, ''),
      baseUrl: toStr(env.VISION_BASE_URL, '') || toStr(env.AI_BASE_URL, ''),
      model: toStr(env.VISION_MODEL, '') || toStr(env.AI_MODEL, ''),
      timeoutMs: toInt(env.VISION_TIMEOUT_MS, toInt(env.AI_TIMEOUT_MS, 120000)),
      maxImages: toInt(env.VISION_MAX_IMAGES, 6),
    },

    session: {
      mode: toStr(env.SESSION_MODE, 'none').toLowerCase(),
      cookieFile: toStr(env.SESSION_COOKIE_FILE, './.session/cookies.json'),
      cdpEndpoint: toStr(env.CDP_ENDPOINT, 'http://127.0.0.1:9222'),
      requiredSources: toList(env.SESSION_REQUIRED_SOURCES, ['pinduoduo', 'taobao']),
    },

    net: {
      allowPrivateNetwork: toBool(env.ALLOW_PRIVATE_NETWORK, false),
      fetchTimeoutMs: toInt(env.FETCH_TIMEOUT_MS, 20000),
      maxRedirects: toInt(env.FETCH_MAX_REDIRECTS, 5),
      maxFetchBytes: toInt(env.MAX_FETCH_BYTES, 8 * 1024 * 1024),
      maxUploadBytes: toInt(env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024),
      maxUploadFiles: toInt(env.MAX_UPLOAD_FILES, 12),
      allowedImageMime: toList(env.ALLOWED_IMAGE_MIME, [
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
      ]),
    },

    rateLimit: {
      windowMs: toInt(env.RATE_LIMIT_WINDOW_MS, 60000),
      maxJobs: toInt(env.RATE_LIMIT_MAX_JOBS, 10),
      maxRequests: toInt(env.RATE_LIMIT_MAX_REQUESTS, 120),
    },

    jobs: {
      concurrency: Math.max(1, toInt(env.JOB_CONCURRENCY, 2)),
      maxAttempts: Math.max(1, toInt(env.JOB_MAX_ATTEMPTS, 2)),
    },

    cost: {
      SOURCE_EXTRACT: Number(env.COST_SOURCE_EXTRACT ?? 0.0005),
      VISION_ANALYSIS: Number(env.COST_VISION_ANALYSIS ?? 0.003),
      TRANSLATION: Number(env.COST_TRANSLATION ?? 0.0008),
      CONTENT_GENERATE: Number(env.COST_CONTENT_GENERATE ?? 0.004),
      currency: toStr(env.CREDIT_CURRENCY, 'USD'),
    },
  };

  if (!AI_PROVIDERS.includes(cfg.vision.provider)) {
    // Không throw ở đây: provider lạ sẽ do tầng provider báo lỗi rõ ràng.
    cfg.vision.providerUnknown = true;
  }

  return cfg;
}

export const config = loadConfig();

export default config;
