/**
 * Rate-limit abstraction.
 *
 * Bản MVP dùng bộ đếm trong bộ nhớ (đủ cho 1 tiến trình). Khi lên production
 * nhiều instance, thay `MemoryRateLimiter` bằng bản Redis — interface giữ nguyên.
 */

export class MemoryRateLimiter {
  /**
   * @param {{windowMs?: number, max?: number, now?: () => number}} opts
   */
  constructor({ windowMs = 60000, max = 60, now = () => Date.now() } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.now = now;
    this.buckets = new Map();
  }

  /** @returns {{allowed: boolean, remaining: number, resetAt: number, retryAfterMs: number}} */
  check(key) {
    const t = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || t >= bucket.resetAt) {
      const resetAt = t + this.windowMs;
      // max <= 0 nghĩa là chặn TẤT CẢ. Nếu không xử lý riêng, request đầu tiên
      // vẫn lọt qua vì nhánh "tạo bucket mới" luôn trả allowed: true.
      if (!(this.max > 0)) {
        this.buckets.set(key, { count: 1, resetAt });
        return { allowed: false, remaining: 0, resetAt, retryAfterMs: this.windowMs };
      }
      this.buckets.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: this.max - 1, resetAt, retryAfterMs: 0 };
    }
    if (bucket.count >= this.max) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: bucket.resetAt,
        retryAfterMs: Math.max(0, bucket.resetAt - t),
      };
    }
    bucket.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, this.max - bucket.count),
      resetAt: bucket.resetAt,
      retryAfterMs: 0,
    };
  }

  /** Dọn bucket hết hạn — gọi định kỳ để không phình bộ nhớ. */
  sweep() {
    const t = this.now();
    let removed = 0;
    for (const [k, b] of this.buckets) {
      if (t >= b.resetAt) {
        this.buckets.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  reset(key) {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }
}

/** Lấy khoá định danh client: ưu tiên X-Forwarded-For khi có proxy tin cậy. */
export function clientKey(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const xff = req.headers?.['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

export class RateLimitExceeded extends Error {
  constructor(retryAfterMs) {
    super('Vượt quá giới hạn tần suất. Vui lòng thử lại sau.');
    this.name = 'RateLimitExceeded';
    this.code = 'RATE_LIMITED';
    this.status = 429;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Bọc một hàm async bằng rate limit.
 * @throws {RateLimitExceeded}
 */
export function enforce(limiter, key) {
  const res = limiter.check(key);
  if (!res.allowed) throw new RateLimitExceeded(res.retryAfterMs);
  return res;
}
