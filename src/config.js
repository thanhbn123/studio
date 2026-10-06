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

/** Số thực (dùng cho tỉ lệ/ngưỡng); giá trị không phải số → fallback. */
const toNum = (raw, fallback) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
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

    // ── MVP-02: dịch chữ Trung trên ảnh sản phẩm ─────────────────────────────
    // Giới hạn dùng chung cho toàn bộ imagelab (C1..C5 đều đọc khối này).
    imagelab: {
      // Bật mặc định vì provider mặc định là mock/purejs: chạy offline, is_mock = true.
      enabled: toBool(env.IMAGELAB_ENABLED, true),
      dir: toStr(env.IMAGELAB_DIR, './data/imagelab'),
      maxImageBytes: toInt(env.IMAGELAB_MAX_IMAGE_BYTES, 8 * 1024 * 1024),
      maxPixels: toInt(env.IMAGELAB_MAX_PIXELS, 16_000_000),
      maxRegions: toInt(env.IMAGELAB_MAX_REGIONS, 200),
      minConfidence: toNum(env.IMAGELAB_MIN_CONFIDENCE, 0.5),
      fontScale: toNum(env.IMAGELAB_FONT_SCALE, 1),
      maxOutputBytes: toInt(env.IMAGELAB_MAX_OUTPUT_BYTES, 16 * 1024 * 1024),
    },

    // OCR (C1). Mặc định an toàn: mock — dữ liệu dựng tay, is_mock = true, không gọi mạng.
    ocr: {
      provider: toStr(env.OCR_PROVIDER, 'mock').toLowerCase(),
      apiKey: toStr(env.OCR_API_KEY, ''),
      baseUrl: toStr(env.OCR_BASE_URL, ''),
      model: toStr(env.OCR_MODEL, ''),
      timeoutMs: toInt(env.OCR_TIMEOUT_MS, 60000),
      mockFixture: toStr(env.OCR_MOCK_FIXTURE, 'src/imagelab/ocr/fixtures/mock-regions.json'),
    },

    // Render ảnh (C3). Mặc định an toàn: purejs — chạy offline, không cần key.
    render: {
      provider: toStr(env.RENDER_PROVIDER, 'purejs').toLowerCase(),
      apiKey: toStr(env.RENDER_API_KEY, ''),
      baseUrl: toStr(env.RENDER_BASE_URL, ''),
      model: toStr(env.RENDER_MODEL, ''),
      timeoutMs: toInt(env.RENDER_TIMEOUT_MS, 60000),
    },

    // ── MVP-03: tạo ảnh (tách nền → ghép nền → retouch → overlay) ───────────
    // Ba khối dưới đây là ĐƯỜNG CẤU HÌNH DUY NHẤT của MVP-03. Trước vòng 8, `src/config.js`
    // không có khoá nào trong số này nên `IMAGESTUDIO_ENABLED=false` bị bỏ qua và
    // `MATTING_PROVIDER`/`RETOUCH_PROVIDER` luôn rơi về `purejs` (lỗi do agent test tìm ra).
    imagestudio: {
      // Bật mặc định vì provider mặc định là purejs: chạy offline, không cần key.
      enabled: toBool(env.IMAGESTUDIO_ENABLED, true),
      // ⚠️ N4 (vòng 9): KHÔNG có `dir` riêng. Ảnh gốc VÀ ảnh tạo ra dùng CHUNG kho ảnh
      // `IMAGELAB_DIR` (`src/imagelab/storage.js`) — khai một biến thư mục riêng mà không
      // dòng mã nào đọc là config chết, dễ làm vận hành tin sai chỗ lưu ảnh.
    },

    // Tách nền. Mặc định an toàn: purejs (flood fill từ viền, chạy offline).
    // `tolerance`/`minUniformity` KHÔNG khai ở đây: chúng là ngưỡng CHẤT LƯỢNG của thuật toán
    // (mặc định trong `matting/background.js`), siết/nới qua môi trường là đổi luật fail-closed.
    matting: {
      provider: toStr(env.MATTING_PROVIDER, 'purejs').toLowerCase(),
      apiKey: toStr(env.MATTING_API_KEY, ''),
      baseUrl: toStr(env.MATTING_BASE_URL, ''),
      model: toStr(env.MATTING_MODEL, ''),
      timeoutMs: toInt(env.MATTING_TIMEOUT_MS, 60000),
    },

    // Retouch. KHÔNG có provider `http` (4 tham số ngưỡng áp ngay trong tiến trình).
    // `limits` chỉ được SIẾT so với `RETOUCH_LIMITS` của hợp đồng §3.4 — `resolveRetouchLimits`
    // lấy `min(cấu hình, hợp đồng)` nên khai số to hơn cũng KHÔNG nới được ngưỡng.
    retouch: {
      provider: toStr(env.RETOUCH_PROVIDER, 'purejs').toLowerCase(),
      model: toStr(env.RETOUCH_MODEL, ''),
      limits: {
        brightness: toNum(env.RETOUCH_MAX_BRIGHTNESS, 0.25),
        contrast: toNum(env.RETOUCH_MAX_CONTRAST, 0.25),
        saturation: toNum(env.RETOUCH_MAX_SATURATION, 0.3),
        sharpen: toNum(env.RETOUCH_MAX_SHARPEN, 0.5),
      },
    },

    // Dịch chữ trên ảnh (C2) — mặc định KẾ THỪA khối `ai` (giống cách `vision` kế thừa).
    translate: {
      provider: toStr(env.TRANSLATE_PROVIDER, aiProvider).toLowerCase(),
      apiKey: toStr(env.TRANSLATE_API_KEY, '') || toStr(env.AI_API_KEY, ''),
      baseUrl: toStr(env.TRANSLATE_BASE_URL, '') || toStr(env.AI_BASE_URL, ''),
      model: toStr(env.TRANSLATE_MODEL, '') || toStr(env.AI_MODEL, ''),
      timeoutMs: toInt(env.TRANSLATE_TIMEOUT_MS, toInt(env.AI_TIMEOUT_MS, 120000)),
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
      // MVP-02 — đơn giá ước tính cho 2 operation mới (chưa thu tiền thật).
      OCR_DETECT: Number(env.COST_OCR_DETECT ?? 0.0004),
      IMAGE_RENDER: Number(env.COST_IMAGE_RENDER ?? 0.0015),
      // MVP-03 — đơn giá ước tính cho 3 operation mới (chưa thu tiền thật).
      IMAGE_MATTING: Number(env.COST_IMAGE_MATTING ?? 0.002),
      IMAGE_COMPOSE: Number(env.COST_IMAGE_COMPOSE ?? 0.0005),
      IMAGE_RETOUCH: Number(env.COST_IMAGE_RETOUCH ?? 0.0005),
      currency: toStr(env.CREDIT_CURRENCY, 'USD'),
    },

    // ── MVP-05: tài khoản + ví credit (§2.3 của hợp đồng) ───────────────────
    // Đây là ĐƯỜNG CẤU HÌNH DUY NHẤT của MVP-05. A1 đọc `auth.*`, A2 đọc `billing.*`,
    // A4 đọc cả hai để dựng cookie và `/api/config`. Tên khoá ĐÓNG BĂNG — đổi là vỡ hợp đồng.
    auth: {
      enabled: toBool(env.AUTH_ENABLED, true),
      // PB-03 (vòng 2): email được BOOTSTRAP thành owner khi hệ thống chưa có owner/admin nào.
      // Rỗng = không bootstrap (chỉ ghi log warn hướng dẫn dùng CLI `npm run make-owner`).
      ownerEmail: toStr(env.OWNER_EMAIL, '').toLowerCase(),
      cookieName: /^[A-Za-z0-9._-]+$/.test(toStr(env.AUTH_COOKIE_NAME, 'vauth'))
        ? toStr(env.AUTH_COOKIE_NAME, 'vauth')
        : 'vauth', // tên cookie sai định dạng ⇒ rơi về mặc định, không đưa rác vào header
      sessionDays: Math.max(1, toInt(env.AUTH_SESSION_DAYS, 30)),
      // ⚠️ CHỈ SIẾT ĐƯỢC, KHÔNG NỚI: sàn 10 là hằng số hợp đồng
      // (`PASSWORD_MIN_LENGTH` §3.1). Khai `AUTH_PASSWORD_MIN_LENGTH=4` KHÔNG hạ được sàn.
      passwordMinLength: Math.max(10, toInt(env.AUTH_PASSWORD_MIN_LENGTH, 10)),
      // Mặc định an toàn: bật `Secure` khi PUBLIC_BASE_URL là https, kể cả khi
      // AUTH_SECURE_COOKIE không được khai (cookie phiên không bao giờ đi qua http thường).
      secureCookie:
        toBool(env.AUTH_SECURE_COOKIE, false) || /^https:/i.test(toStr(env.PUBLIC_BASE_URL, '')),
      // `false` ⇒ mọi route cần đăng nhập (TRỪ /api/auth/*). Mặc định `true` để luật #1
      // "không phá người dùng ẩn danh" và toàn bộ test MVP-01/02/03 vẫn xanh.
      anonymousAllowed: toBool(env.AUTH_ANONYMOUS_ALLOWED, true),
    },

    billing: {
      enabled: toBool(env.BILLING_ENABLED, true),
      // KHÔNG tạo khoá tiền tệ thứ hai: dùng CHUNG `CREDIT_CURRENCY` với `cost.currency`.
      currency: toStr(env.CREDIT_CURRENCY, 'USD'),
      // Credit tặng khi đăng ký. Kẹp >= 0: số âm là "thu tiền lúc đăng ký" — vô nghĩa.
      defaultGrant: Math.max(0, toNum(env.BILLING_DEFAULT_GRANT, 0)),
      holdBeforeJob: toBool(env.BILLING_HOLD_BEFORE_JOB, true),
      // PB-02 (vòng 2): trần số LƯỢT CHẠY có tính tiền cho mỗi job (chạy lần đầu + mọi lượt
      // chạy lại). Vượt ⇒ `RERUN_LIMIT_EXCEEDED` (HTTP 429). Kẹp >= 1: 0 sẽ khoá luôn lượt đầu.
      maxRunsPerJob: Math.max(1, toInt(env.BILLING_MAX_RUNS_PER_JOB, 10)),
      // PB-06: trần credit cho MỘT thao tác cấp/điều chỉnh (chặn `grant(1e308)` ⇒ sổ ghi 0).
      maxAmount: Math.max(1, toNum(env.BILLING_MAX_AMOUNT, 1e9)),
      // BR-08 (vòng 4): ngưỡng coi một lượt chạy là TREO (có `job_hold` mà không có dòng đóng).
      // Quá ngưỡng ⇒ `reconcileStuckRuns` HOÀN 100% khoản giữ và đóng lượt (job chạy lại được).
      // Mặc định 15 phút — đủ dài để không cắt ngang job đang chạy thật.
      //
      // BR-10 (vòng 5): ĐÁY AN TOÀN `minStuckRunMs` — cấu hình ngưỡng NGẮN HƠN thời gian chạy job
      // có thể cắt ngang job thật (đo được: 3 lượt chạy thật mà chỉ thu 2). Cấu hình chỉ được
      // NỚI, không được hạ dưới đáy; hạ xuống thì bị nâng lên + log WARN (`stuckRunMsRaised`).
      // Ngưỡng CẤU HÌNH (không kẹp ở đây): nó vẫn có hiệu lực cho các đường CÓ kiểm tra job
      // đang chạy hay không (`isJobActive` — xem §7.3), nhờ vậy vận hành vẫn phục hồi được job
      // chết nhanh. Đáy `minStuckRunMs` chỉ áp cho đường KHÔNG kiểm được trạng thái job.
      stuckRunMs: Math.max(0, toNum(env.BILLING_STUCK_RUN_MS, 15 * 60 * 1000)),
      minStuckRunMs: Math.max(0, toNum(env.BILLING_MIN_STUCK_RUN_MS, 60 * 1000)),
      stuckRunMsRaised:
        Math.max(0, toNum(env.BILLING_STUCK_RUN_MS, 15 * 60 * 1000)) <
        Math.max(0, toNum(env.BILLING_MIN_STUCK_RUN_MS, 60 * 1000)),
      // Seed bảng `pricing` từ `config.cost.*` của MVP-01 (nguồn giá mặc định).
      pricingFromCost: toBool(env.BILLING_PRICING_FROM_COST, true),
    },
  };

  if (!AI_PROVIDERS.includes(cfg.vision.provider)) {
    // Không throw ở đây: provider lạ sẽ do tầng provider báo lỗi rõ ràng.
    cfg.vision.providerUnknown = true;
  }

  if (!['mock', 'http', 'none'].includes(cfg.ocr.provider)) {
    // Provider OCR lạ sẽ fail-closed về `none` ở tầng provider; cờ này để chẩn đoán.
    cfg.ocr.providerUnknown = true;
  }

  return cfg;
}

export const config = loadConfig();

export default config;
