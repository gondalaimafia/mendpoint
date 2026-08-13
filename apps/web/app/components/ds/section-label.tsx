import React from "react";

type Tone = "accent" | "muted" | "warden";

/**
 * The signature eyebrow. Wraps the DS1 `.section-label` utility. `accent`
 * (default) carries the indigo->cyan dash and opens a marketing section;
 * `muted` drops the dash and accent for product chrome (stat captions, rail
 * headings); `warden` recolors the dash and text to cyan.
 */
export function SectionLabel({
  children,
  tone = "accent",
  className = "",
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const toneClass =
    tone === "muted"
      ? "section-label--muted"
      : tone === "warden"
        ? "section-label--warden"
        : "section-label--accent";
  return (
    <div className={`section-label ${toneClass} ${className}`.trim()}>
      {children}
    </div>
  );
}
