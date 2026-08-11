/**
 * Per-tenant request/operation quota (in-process sliding window).
 *
 * The per-IP / per-key rate limiter (rate-limit.ts) stops a single client from flooding the
 * node, but it does not stop one tenant — spread across many keys or IPs — from exhausting
 * shared capacity and starving every other tenant. This quota adds a second, tenant-scoped
 * budget alongside it.
 *
 * Env-gated and permissive by default: with `TENANT_QUOTA_MAX` unset or <= 0 the quota is
 * disabled and every request is allowed, so existing behavior is unchanged unless an operator
 * opts in. When configured, exceeding the budget denies with a clear code — there is no
 * fail-open branch: a quota that silently allowed on error would defeat its purpose.
 *
 * In-process state is appropriate for the single-node GA tier; a multi-node deploy should
 * back this with a shared store, but the deny-on-exceed contract stays the same.
 */
export type TenantQuotaResult = {
  /** Whether the quota is enforced at all (false when TENANT_QUOTA_MAX is unset/<=0). */
  enabled: boolean;
  allowed: boolean;
  remaining: number;
  resetMs: number;
  limit: number;
};

export type TenantQuotaOpts = {
  /** Max operations per tenant per window. */
  limit?: number;
  /** Window length ms. */
  windowMs?: number;
};

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let callsSinceSweep = 0;

function positiveNumber(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function configuredLimit(opts: TenantQuotaOpts): number {
  if (opts.limit !== undefined) return opts.limit;
  const raw = Number(process.env.TENANT_QUOTA_MAX ?? 0);
  return Number.isFinite(raw) ? raw : 0;
}

function sweepBuckets(now: number, maxBuckets: number): void {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
  while (buckets.size >= maxBuckets) {
    const oldest = buckets.keys().next().value as string | undefined;
    if (!oldest) break;
    buckets.delete(oldest);
  }
}

/**
 * Record one operation against `tenantId`'s budget and report whether it is allowed.
 *
 * A blank tenantId is rejected (`tenant_quota_tenant_required`) rather than silently sharing
 * one anonymous bucket — a missing tenant here is a caller bug, and pooling every unscoped
 * request into a single bucket would be its own cross-tenant availability hole.
 */
export function tenantQuota(
  tenantId: string,
  opts: TenantQuotaOpts = {},
): TenantQuotaResult {
  const limit = configuredLimit(opts);
  if (!(Number.isFinite(limit) && limit > 0)) {
    // Quota disabled — permissive default. Do not touch buckets.
    return { enabled: false, allowed: true, remaining: Number.POSITIVE_INFINITY, resetMs: 0, limit: 0 };
  }
  if (typeof tenantId !== "string" || tenantId.trim() === "") {
    throw new Error("tenant_quota_tenant_required");
  }
  const windowMs = positiveNumber(
    opts.windowMs ?? Number(process.env.TENANT_QUOTA_WINDOW_MS ?? 60_000),
    60_000,
  );
  const maxBuckets = positiveNumber(
    Number(process.env.TENANT_QUOTA_MAX_BUCKETS ?? 50_000),
    50_000,
  );
  const now = Date.now();
  callsSinceSweep++;
  if (callsSinceSweep >= 100 || buckets.size >= maxBuckets) {
    sweepBuckets(now, maxBuckets);
    callsSinceSweep = 0;
  }
  const key = `tenant:${tenantId}`;
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  const allowed = b.count <= limit;
  return {
    enabled: true,
    allowed,
    remaining: Math.max(0, limit - b.count),
    resetMs: Math.max(0, b.resetAt - now),
    limit,
  };
}

/** Test helper. */
export function clearTenantQuotas(): void {
  buckets.clear();
  callsSinceSweep = 0;
}

export function tenantQuotaBucketCount(): number {
  return buckets.size;
}
