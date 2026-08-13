import React from "react";

export type BadgeTone = "neutral" | "danger" | "warn" | "emerald" | "accent";

/**
 * Minimal mono badge — the app has no shadcn `Badge`, so this is the DS-styled
 * equivalent `PullRequestCard` (and the DS3 views) lean on. Square-ish radius
 * keeps it distinct from the fully-rounded `StatusPill`. Amber (`warn`) is
 * reserved for breaking-change severity; emerald for passing/adds.
 */
export function Badge({
  children,
  tone = "neutral",
  className = "",
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span className={`ds-badge ds-badge--${tone} ${className}`.trim()}>
      {children}
    </span>
  );
}
