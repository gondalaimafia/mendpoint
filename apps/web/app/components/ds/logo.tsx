import React from "react";
import { BrandMark } from "../../brand-mark.js";

/**
 * The Mendpoint lockup: the approved website arrow mark at `size`, the wordmark
 * at 0.78x, gap 0.34x. Reuses the app's existing `BrandMark` glyph (the same
 * one the marketing nav ships) rather than the design-system trace mark.
 */
export function Logo({
  size = 26,
  wordmark = true,
  className = "",
}: {
  size?: number;
  wordmark?: boolean;
  className?: string;
}) {
  return (
    <span className={`ds-logo ${className}`.trim()} style={{ gap: size * 0.34 }}>
      <span className="ds-logo__mark" style={{ width: size, height: size }}>
        <BrandMark className="ds-logo__glyph" />
      </span>
      {wordmark && (
        <span className="ds-logo__word" style={{ fontSize: size * 0.78 }}>
          Mendpoint
        </span>
      )}
    </span>
  );
}
