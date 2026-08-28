/**
 * Optional paging sink for CRITICAL operational events.
 *
 * No-ops (skipped: true) when PAGING_WEBHOOK_URL is not set, mirroring the Slack
 * notifier. Posts to any generic webhook that accepts JSON (Opsgenie, a custom
 * relay, or similar); the sink is opt-in and stays a no-op until configured.
 *
 * Fail-open: a transport error or non-2xx response is caught and logged, never
 * thrown, so a paging failure can never break a request or job.
 */
import { postJson } from "./post-json.js";

export type PagingEventType =
  | "readiness_fail"
  | "backup_failure"
  | "dr_drill_fail"
  | "dead_letter_growth"
  | "expired_lease_uncertain_side_effect"
  | "worker_heartbeat_stale"
  | "release_dispatch_degraded"
  | "egress_receipt_expiring"
  | "egress_receipt_renewal_failed";

export type PagingSeverity = "critical" | "error" | "warning";

export type PagingEvent = {
  type: PagingEventType;
  summary: string;
  severity?: PagingSeverity;
  dedupeKey?: string;
  source?: string;
  details?: Record<string, unknown>;
};

export type PagingDelivery = {
  sink: "webhook";
  ok: boolean;
  status: number;
  error?: string;
};

export type NotifyPagingResult =
  | { ok: true; skipped: true; reason: "unconfigured" | "deduped" }
  | { ok: boolean; skipped?: false; deliveries: PagingDelivery[] };

const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const MAX_PAGING_COUNT = 1_000_000_000;

const dedupeSeen = new Map<string, number>();

function dedupeWindowMs(): number {
  const raw = process.env.PAGING_DEDUPE_WINDOW_MS?.trim();
  if (!raw) return DEFAULT_DEDUPE_WINDOW_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DEDUPE_WINDOW_MS;
}

/** Reset in-memory dedupe state (test helper; mirrors clearRateLimits/clearAlerts). */
export function clearPagingDedupe(): void {
  dedupeSeen.clear();
}

function resolveDedupeKey(event: PagingEvent): string {
  return event.dedupeKey?.trim() || `${event.type}:${event.summary}`;
}

function boundedPagingCount(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value === undefined || value < 0) return 0;
  return Math.min(value, MAX_PAGING_COUNT);
}

/**
 * Read-only check: has this key already been *successfully* paged within the
 * window? Unlike a check-and-set, this never stamps the key, so a page that
 * fails to deliver cannot suppress its own retry.
 */
function wasRecentlyPaged(key: string, now: number, windowMs: number): boolean {
  const previous = dedupeSeen.get(key);
  return previous !== undefined && now - previous < windowMs;
}

/**
 * Stamp a key as delivered now. Called only after at least one sink accepted the
 * page. Opportunistically prunes expired entries so the map cannot grow unbounded.
 */
function markPaged(key: string, now: number, windowMs: number): void {
  dedupeSeen.set(key, now);
  if (dedupeSeen.size > 1000) {
    for (const [existingKey, seenAt] of dedupeSeen) {
      if (now - seenAt >= windowMs) dedupeSeen.delete(existingKey);
    }
  }
}

function webhookPayload(event: PagingEvent, dedupeKey: string, ts: string): Record<string, unknown> {
  return {
    type: event.type,
    severity: event.severity ?? "critical",
    summary: event.summary,
    dedupeKey,
    source: event.source ?? "mendpoint",
    details: event.details ?? {},
    ts,
  };
}

async function post(
  sink: PagingDelivery["sink"],
  url: string,
  body: Record<string, unknown>,
): Promise<PagingDelivery> {
  try {
    const res = await postJson(url, body);
    if (!res.ok) {
      console.error(`paging_${sink}_rejected: status ${res.status}`);
    }
    return { sink, ok: res.ok, status: res.status };
  } catch (error) {
    const message = error instanceof Error ? error.message : "paging_post_failed";
    console.error(`paging_${sink}_error: ${message}`);
    return { sink, ok: false, status: 0, error: message };
  }
}

/**
 * Fire a paging notification for a critical operational event. Returns without
 * throwing under every failure mode.
 */
export async function notifyPaging(event: PagingEvent): Promise<NotifyPagingResult> {
  const webhookUrl = process.env.PAGING_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    return { ok: true, skipped: true, reason: "unconfigured" };
  }

  const dedupeKey = resolveDedupeKey(event);
  const now = Date.now();
  const windowMs = dedupeWindowMs();
  if (wasRecentlyPaged(dedupeKey, now, windowMs)) {
    return { ok: true, skipped: true, reason: "deduped" };
  }

  const ts = new Date().toISOString();
  const deliveries: PagingDelivery[] = [
    await post("webhook", webhookUrl, webhookPayload(event, dedupeKey, ts)),
  ];
  // Stamp the dedupe key only after a page actually reached the sink. On a
  // delivery failure we leave the key unset so the next call (e.g. the 30s
  // retry) tries again instead of returning a phantom "deduped" success.
  if (deliveries.some((delivery) => delivery.ok)) {
    markPaged(dedupeKey, now, windowMs);
  }
  return { ok: deliveries.every((delivery) => delivery.ok), deliveries };
}

/**
 * Adapter: build a paging event from a readiness probe result. Returns null when
 * the probe is not failing (structural input avoids a dependency on @mendpoint/ops).
 */
export function pagingEventForReadiness(probe: {
  status: string;
  checks: ReadonlyArray<{ name: string; ok: boolean }>;
}): PagingEvent | null {
  if (probe.status !== "fail") return null;
  const failed = probe.checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    type: "readiness_fail",
    severity: "critical",
    summary: `Readiness probe failing: ${failed.join(", ") || "unknown"}`,
    dedupeKey: `readiness_fail:${failed.sort().join(",")}`,
    details: { failedChecks: failed },
  };
}

/**
 * Adapter: build a paging event from a worker heartbeat when it is stale or when
 * dead-letter / expired-lease counts indicate uncertain side effects.
 */
export function pagingEventForWorkerHeartbeat(input: {
  workerId: string;
  ok: boolean;
  stale: boolean;
  deadLetter?: number;
  expiredLeases?: number;
  releaseDispatchDegraded?: boolean;
  releaseDispatchPending?: number;
  releaseDispatchClaimed?: number;
  releaseDispatchFailed?: number;
  releaseDispatchExpiredClaims?: number;
}): PagingEvent | null {
  const deadLetter = input.deadLetter ?? 0;
  const expiredLeases = input.expiredLeases ?? 0;
  if (input.stale) {
    return {
      type: "worker_heartbeat_stale",
      severity: "critical",
      summary: `Worker ${input.workerId} heartbeat stale`,
      dedupeKey: `worker_heartbeat_stale:${input.workerId}`,
      details: { deadLetter, expiredLeases, ok: input.ok, stale: input.stale },
    };
  }
  if (input.releaseDispatchDegraded) {
    return {
      type: "release_dispatch_degraded",
      severity: "critical",
      summary: `Worker ${input.workerId} release dispatch degraded`,
      dedupeKey: `release_dispatch_degraded:${input.workerId}`,
      details: {
        pending: boundedPagingCount(input.releaseDispatchPending),
        claimed: boundedPagingCount(input.releaseDispatchClaimed),
        failed: boundedPagingCount(input.releaseDispatchFailed),
        expiredClaims: boundedPagingCount(input.releaseDispatchExpiredClaims),
      },
    };
  }
  if (!input.ok) {
    return {
      type: "worker_heartbeat_stale",
      severity: "critical",
      summary: `Worker ${input.workerId} heartbeat stale`,
      dedupeKey: `worker_heartbeat_stale:${input.workerId}`,
      details: { deadLetter, expiredLeases, ok: input.ok, stale: input.stale },
    };
  }
  if (expiredLeases > 0) {
    return {
      type: "expired_lease_uncertain_side_effect",
      severity: "critical",
      summary: `Worker ${input.workerId} has ${expiredLeases} expired lease(s) with uncertain side effects`,
      dedupeKey: `expired_lease_uncertain_side_effect:${input.workerId}`,
      details: { expiredLeases, deadLetter },
    };
  }
  if (deadLetter > 0) {
    return {
      type: "dead_letter_growth",
      severity: "error",
      summary: `Worker ${input.workerId} dead-letter queue at ${deadLetter}`,
      dedupeKey: `dead_letter_growth:${input.workerId}`,
      details: { deadLetter },
    };
  }
  return null;
}

/**
 * Adapter: build a paging event from the sandbox-egress receipt's freshness.
 *
 * The receipt is a boot requirement AND a readiness condition: when it lapses,
 * workers crash-loop and health goes red. A renewal that fails silently — a
 * failed scheduled run, or a run that never happened — is equivalent to no
 * renewal, so the alarm is driven by the receipt's OWN expiry, not by whether a
 * renewal ran. It fires while there is still time to act: once `now` is within
 * `leadMs` of `expiresAt` (and also once the receipt has already expired). A
 * healthy margin returns null (no page).
 *
 * An unreadable expiry timestamp is itself a critical alarm rather than a silent
 * pass — a receipt whose freshness cannot be established must be treated as at
 * risk, never as fresh.
 */
export function pagingEventForEgressReceipt(input: {
  expiresAt: string;
  now: string;
  leadMs: number;
}): PagingEvent | null {
  const expires = Date.parse(input.expiresAt);
  const now = Date.parse(input.now);
  if (!Number.isFinite(expires) || !Number.isFinite(now)) {
    return {
      type: "egress_receipt_expiring",
      severity: "critical",
      summary: "Sandbox egress receipt expiry is unreadable — cannot prove freshness",
      dedupeKey: "egress_receipt_expiring:unreadable",
      details: { expiresAt: input.expiresAt, now: input.now },
    };
  }
  const remainingMs = expires - now;
  const lead = Number.isFinite(input.leadMs) && input.leadMs > 0 ? input.leadMs : 0;
  if (remainingMs > lead) return null;
  const lapsed = remainingMs <= 0;
  const remainingMinutes = Math.floor(remainingMs / 60000);
  return {
    type: "egress_receipt_expiring",
    severity: "critical",
    summary: lapsed
      ? `Sandbox egress receipt has lapsed (expired ${input.expiresAt}); verification is unavailable`
      : `Sandbox egress receipt expires in ${remainingMinutes} min (${input.expiresAt}); renewal has not refreshed it`,
    dedupeKey: `egress_receipt_expiring:${input.expiresAt}`,
    details: { expiresAt: input.expiresAt, now: input.now, remainingMs, lapsed },
  };
}

/**
 * Best-effort page when the sandbox-egress receipt is approaching or past
 * expiry. Returns null (no page) while the receipt has healthy margin. Never
 * throws: `notifyPaging` is fail-open.
 */
export async function pageEgressReceiptFreshness(input: {
  expiresAt: string;
  now: string;
  leadMs: number;
}): Promise<NotifyPagingResult | null> {
  const event = pagingEventForEgressReceipt(input);
  return event ? notifyPaging(event) : null;
}

/**
 * Best-effort page for a failed egress-receipt renewal run, via the optional
 * runtime webhook sink. The renewal workflow itself no longer calls this: it now
 * surfaces a failed renewal as a GitHub issue in the repo (see the "Alert on
 * renewal failure" step in sandbox-egress-acceptance.yml), which needs no
 * external secret. This helper remains for any caller that wants the same page
 * delivered through a configured `PAGING_WEBHOOK_URL`.
 */
export async function pageEgressReceiptRenewalFailed(input: {
  runUrl?: string;
  detail?: string;
}): Promise<NotifyPagingResult> {
  return notifyPaging({
    type: "egress_receipt_renewal_failed",
    severity: "critical",
    summary: "Sandbox egress receipt renewal FAILED — receipt will lapse without a fresh mint",
    dedupeKey: "egress_receipt_renewal_failed",
    details: {
      runUrl: input.runUrl ?? "",
      detail: input.detail ?? "",
    },
  });
}

/**
 * Best-effort page for a readiness probe result. Fires a `readiness_fail` page
 * when the probe is failing and returns null (no page) otherwise. Never throws:
 * `notifyPaging` is fail-open, so a paging outage cannot break the probe path
 * that calls this.
 */
export async function pageReadiness(probe: {
  status: string;
  checks: ReadonlyArray<{ name: string; ok: boolean }>;
}): Promise<NotifyPagingResult | null> {
  const event = pagingEventForReadiness(probe);
  return event ? notifyPaging(event) : null;
}

/**
 * Best-effort page for a worker heartbeat snapshot. Fires the matching page
 * (`worker_heartbeat_stale`, `release_dispatch_degraded`,
 * `expired_lease_uncertain_side_effect`, or `dead_letter_growth`) when the
 * snapshot is unhealthy and returns null otherwise. Never throws, for the same
 * reason as `pageReadiness`.
 */
export async function pageWorkerHeartbeat(input: {
  workerId: string;
  ok: boolean;
  stale: boolean;
  deadLetter?: number;
  expiredLeases?: number;
  releaseDispatchDegraded?: boolean;
  releaseDispatchPending?: number;
  releaseDispatchClaimed?: number;
  releaseDispatchFailed?: number;
  releaseDispatchExpiredClaims?: number;
}): Promise<NotifyPagingResult | null> {
  const event = pagingEventForWorkerHeartbeat(input);
  return event ? notifyPaging(event) : null;
}
