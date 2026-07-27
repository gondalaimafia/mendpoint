/**
 * In-process sliding-window rate limiter (per IP / API key).
 * Suitable for single-node GA deploy; put a reverse proxy in multi-node.
 */
export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  limit: number;
};

export type RateLimitOpts = {
  /** Max requests per window */
  limit?: number;
  /** Window length ms */
  windowMs?: number;
};

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export function rateLimit(
  key: string,
  opts: RateLimitOpts = {},
): RateLimitResult {
  const limit = opts.limit ?? Number(process.env.RATE_LIMIT_MAX ?? 120);
  const windowMs = opts.windowMs ?? Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  const allowed = b.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - b.count),
    resetMs: Math.max(0, b.resetAt - now),
    limit,
  };
}

export function rateLimitKeyFromRequest(input: {
  apiKeyId?: string;
  ip?: string;
}): string {
  if (input.apiKeyId) return `key:${input.apiKeyId}`;
  return `ip:${input.ip ?? "unknown"}`;
}

/** Test helper */
export function clearRateLimits(): void {
  buckets.clear();
}
