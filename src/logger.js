/**
 * Structured logging (JSON một dòng) + che secret.
 *
 * Yêu cầu bảo mật: "no secrets in logs", "no cookies in logs".
 * Mọi object đi qua `redact()` trước khi serialize.
 */

const SECRET_KEY_RE =
  /(api[_-]?key|authorization|auth|token|secret|password|passwd|pwd|cookie|set-cookie|session|credential|signature|sig|bearer)/i;

const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g, // OpenAI / DeepSeek style
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g, // Anthropic
  /\bAIza[0-9A-Za-z_-]{20,}\b/g, // Google
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, // GitHub
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
];

const MAX_DEPTH = 6;
const MAX_STRING = 4000;

export const REDACTED = '[REDACTED]';

function scrubString(value) {
  let out = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

/**
 * Bỏ ĐƯỜNG DẪN TUYỆT ĐỐI của máy chủ khỏi một chuỗi (message/stack của Node luôn
 * chứa chúng). Dùng ở tầng HTTP và tầng lắp ráp MVP-02: log không được tiết lộ cấu
 * trúc thư mục nội bộ, và `/api/health` càng không.
 *
 * Cố ý KHÔNG nhúng vào `redact()`: `redact` chỉ che secret, còn việc lọc đường dẫn
 * phải là quyết định tường minh ở nơi ghi log.
 */
export function scrubPaths(text) {
  return String(text ?? '')
    .replace(/file:\/\/\S+/g, '<path>')
    .replace(/\/(?:Users|home|private|tmp|var|opt|mnt|Volumes|Applications|usr|etc)\/[^\s'"(),;]*/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s'"(),;]*/g, '<path>');
}

/** Che secret theo tên khoá và theo hình dạng giá trị. Trả về bản sao an toàn. */
export function redact(input, depth = 0, seen = new WeakSet()) {
  if (input === null || input === undefined) return input;
  const t = typeof input;
  if (t === 'string') return scrubString(input);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return input;
  if (t === 'function' || t === 'symbol') return `[${t}]`;
  if (input instanceof Error) {
    return {
      name: input.name,
      message: scrubString(input.message),
      code: input.code,
      stack: input.stack ? scrubString(input.stack) : undefined,
    };
  }
  if (input instanceof Date) return input.toISOString();
  if (Buffer.isBuffer(input)) return `[Buffer ${input.length}B]`;
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (seen.has(input)) return '[circular]';
  seen.add(input);

  if (Array.isArray(input)) {
    return input.slice(0, 200).map((v) => redact(v, depth + 1, seen));
  }

  const out = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger({ level = 'info', stream = process.stdout, base = {} } = {}) {
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;

  const emit = (lvl, msg, ctx) => {
    if ((LEVELS[lvl] ?? 0) < threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: scrubString(String(msg)),
      ...redact(base),
      ...(ctx === undefined ? {} : { ctx: redact(ctx) }),
    };
    try {
      stream.write(`${JSON.stringify(record)}\n`);
    } catch {
      // Logging không bao giờ được làm sập ứng dụng.
    }
  };

  return {
    level,
    debug: (m, c) => emit('debug', m, c),
    info: (m, c) => emit('info', m, c),
    warn: (m, c) => emit('warn', m, c),
    error: (m, c) => emit('error', m, c),
    child(extra) {
      return createLogger({ level, stream, base: { ...base, ...extra } });
    },
  };
}

/** Logger câm — dùng trong test để không làm bẩn output. */
export const silentLogger = createLogger({ level: 'silent' });

export const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });

export default logger;
