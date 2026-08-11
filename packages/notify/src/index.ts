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

export type WardenEvent = "pr_opened" | "change_detected" | "warden_finished";

const EVENT_LABEL: Record<WardenEvent, string> = {
  pr_opened: "PR opened",
  change_detected: "Change detected",
  warden_finished: "Warden finished",
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
