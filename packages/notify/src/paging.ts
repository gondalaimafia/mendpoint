/**
 * Optional paging sink for CRITICAL operational events.
 *
 * No-ops (skipped: true) when neither PAGING_WEBHOOK_URL nor PAGERDUTY_ROUTING_KEY
 * is set, mirroring the Slack notifier. Compatible with the PagerDuty Events API
 * v2 (routing key) and any generic webhook that accepts JSON (Opsgenie, custom).
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
  | "worker_heartbeat_stale";

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
  sink: "pagerduty" | "webhook";
  ok: boolean;
  status: number;
  error?: string;
};

export type NotifyPagingResult =
  | { ok: true; skipped: true; reason: "unconfigured" | "deduped" }
  | { ok: boolean; skipped?: false; deliveries: PagingDelivery[] };

const PAGERDUTY_ENQUEUE_URL = "https://events.pagerduty.com/v2/enqueue";
const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

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

function isDuplicate(key: string, now: number, windowMs: number): boolean {
  const previous = dedupeSeen.get(key);
  if (previous !== undefined && now - previous < windowMs) return true;
  dedupeSeen.set(key, now);
  // Opportunistic prune so the map cannot grow without bound.
  if (dedupeSeen.size > 1000) {
    for (const [existingKey, seenAt] of dedupeSeen) {
      if (now - seenAt >= windowMs) dedupeSeen.delete(existingKey);
    }
  }
  return false;
}

function pagerDutyPayload(event: PagingEvent, dedupeKey: string): Record<string, unknown> {
  return {
    routing_key: process.env.PAGERDUTY_ROUTING_KEY,
    event_action: "trigger",
    dedup_key: dedupeKey,
    payload: {
      summary: event.summary,
      source: event.source ?? "mendpoint",
      severity: event.severity ?? "critical",
      component: event.type,
      custom_details: event.details ?? {},
    },
  };
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
  const routingKey = process.env.PAGERDUTY_ROUTING_KEY?.trim();
  if (!webhookUrl && !routingKey) {
    return { ok: true, skipped: true, reason: "unconfigured" };
  }

  const dedupeKey = resolveDedupeKey(event);
  if (isDuplicate(dedupeKey, Date.now(), dedupeWindowMs())) {
    return { ok: true, skipped: true, reason: "deduped" };
  }

  const ts = new Date().toISOString();
  const deliveries: PagingDelivery[] = [];
  if (routingKey) {
    deliveries.push(await post("pagerduty", PAGERDUTY_ENQUEUE_URL, pagerDutyPayload(event, dedupeKey)));
  }
  if (webhookUrl) {
    deliveries.push(await post("webhook", webhookUrl, webhookPayload(event, dedupeKey, ts)));
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
}): PagingEvent | null {
  const deadLetter = input.deadLetter ?? 0;
  const expiredLeases = input.expiredLeases ?? 0;
  if (input.stale || !input.ok) {
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
