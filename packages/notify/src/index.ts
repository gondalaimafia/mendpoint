/**
 * Optional Slack notifications for Warden / Mendpoint events.
 * No-ops (skipped: true) when SLACK_WEBHOOK_URL is unset.
 */

export type NotifySlackInput = {
  text: string;
  blocks?: unknown[];
};

export type NotifySlackResult =
  | { ok: true; skipped: true }
  | { ok: boolean; status: number; skipped?: false };

export async function notifySlack(
  input: NotifySlackInput,
): Promise<NotifySlackResult> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    return { ok: true, skipped: true };
  }

  const body: Record<string, unknown> = { text: input.text };
  if (input.blocks?.length) {
    body.blocks = input.blocks;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return { ok: res.ok, status: res.status };
}

export type WardenEvent =
  | "pr_opened"
  | "change_detected"
  | "warden_finished"
  | "capability_adoption_opportunity";

const EVENT_LABEL: Record<WardenEvent, string> = {
  pr_opened: "PR opened",
  change_detected: "Change detected",
  warden_finished: "Warden finished",
  capability_adoption_opportunity: "Capability adoption opportunity",
};

export async function notifyWardenEvent(
  event: WardenEvent,
  detail: string,
): Promise<NotifySlackResult> {
  const label = EVENT_LABEL[event] ?? event;
  return notifySlack({
    text: `*Warden* — ${label}: ${detail}`,
  });
}

/**
 * Payload for a capability-adoption opportunity alert: a NEW provider capability
 * that linked consumers are not yet using. Consumer counts/names come from real
 * linkage + static code-presence measurement, not fabricated numbers.
 */
export type CapabilityAdoptionAlert = {
  provider: string;
  /** Human capability label, e.g. "POST /v1/payment_links". */
  capability: string;
  endpoint: string;
  adoptingConsumers: string[];
  nonAdoptingConsumers: string[];
  /** Suggested next action (does not auto-open PRs). */
  suggestedAction: string;
  /** Opportunity reach: number of linked consumers not yet using it. */
  priority: number;
};

/**
 * Emit a capability-adoption opportunity through the existing notify path.
 * No-ops (skipped: true) when SLACK_WEBHOOK_URL is unset, like every other event.
 */
export async function notifyCapabilityAdoptionOpportunity(
  alert: CapabilityAdoptionAlert,
): Promise<NotifySlackResult> {
  const nonAdopting = alert.nonAdoptingConsumers.length
    ? alert.nonAdoptingConsumers.join(", ")
    : "none";
  const adopting = alert.adoptingConsumers.length
    ? alert.adoptingConsumers.join(", ")
    : "none";
  const text = [
    `*Warden* — ${EVENT_LABEL.capability_adoption_opportunity}: ${alert.provider} ${alert.capability}`,
    `Not yet adopted by ${alert.nonAdoptingConsumers.length} consumer(s): ${nonAdopting}`,
    `Already using it: ${adopting}`,
    `Suggested: ${alert.suggestedAction}`,
  ].join("\n");
  return notifySlack({ text });
}

export {
  notifyPaging,
  clearPagingDedupe,
  pagingEventForReadiness,
  pagingEventForWorkerHeartbeat,
  type PagingEvent,
  type PagingEventType,
  type PagingSeverity,
  type PagingDelivery,
  type NotifyPagingResult,
} from "./paging.js";
