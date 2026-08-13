import React from "react";

export type Status = "open" | "merged" | "failing" | "pending" | "draft";

/**
 * Lifecycle state. The only pill-shaped (fully rounded) element in the system;
 * rounding is what marks something as a live state. Each state is tinted by its
 * DS role token (open->emerald, merged->violet, failing->destructive,
 * pending->amber, draft->slate). `pulse` only for genuinely in-flight work.
 */
export function StatusPill({
  status = "open",
  label,
  pulse = false,
}: {
  status?: Status;
  label?: string;
  pulse?: boolean;
}) {
  return (
    <span
      className={`ds-status ds-status--${status} ${pulse ? "ds-status--pulse" : ""}`.trim()}
    >
      <span className="ds-status__dot" aria-hidden />
      {label ?? status}
    </span>
  );
}
