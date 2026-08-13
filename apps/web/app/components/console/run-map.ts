import type { Status } from "../ds/index.js";

/**
 * Server-side mapping helpers for the `/runs` console. They translate the live
 * `/self-serve/runs` shape (queue-job status, timestamps) into the props the DS
 * components expect. The DS `Status` has five lifecycle states, so several queue
 * statuses collapse onto the nearest one while `statusLabel` keeps the exact
 * queue word for honesty.
 */

/** Queue job status -> DS `Status` + the exact queue label. */
export function mapRunStatus(status: string): { status: Status; label: string } {
  switch (status) {
    case "pending":
      return { status: "pending", label: "pending" };
    case "running":
      return { status: "pending", label: "running" };
    case "done":
    case "succeeded":
      return { status: "merged", label: status };
    case "failed":
    case "dead_letter":
      return { status: "failing", label: status };
    case "cancelled":
      return { status: "draft", label: "cancelled" };
    default:
      return { status: "pending", label: status };
  }
}

/** Whether a run is still in flight (drives the status-pill pulse). */
export function isRunActive(status: string): boolean {
  return status === "pending" || status === "running";
}

const UNITS: Array<[string, number]> = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1_000],
];

/** Compact "2m 59s" duration between two ISO timestamps (max two units). */
export function formatDuration(fromIso: string, toIso: string): string | null {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  let ms = to - from;
  const parts: string[] = [];
  for (const [suffix, size] of UNITS) {
    if (ms >= size || (suffix === "s" && parts.length === 0)) {
      const value = Math.floor(ms / size);
      ms -= value * size;
      if (value > 0 || (suffix === "s" && parts.length === 0)) parts.push(`${value}${suffix}`);
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ") || "0s";
}

/**
 * The best-available duration label: elapsed run time when finished, otherwise
 * null (an unfinished or unstarted run has no honest duration).
 */
export function runDuration(
  startedAt: string | null,
  finishedAt: string | null,
): string | null {
  if (startedAt && finishedAt) return formatDuration(startedAt, finishedAt);
  return null;
}
