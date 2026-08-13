"use client";

import { explainError, type ExplainErrorInput } from "@mendpoint/shared";
import { GuidanceDetails } from "./error-guidance";

/**
 * Renders self-service guidance for a failure instead of a raw code or JSON
 * string. Accepts anything a fetch/catch surface has on hand (a caught error, a
 * code string, or an error envelope); `explainError` degrades unknown codes
 * gracefully, so this never shows a blank.
 */
export function ErrorGuidanceNote({ error }: { error: unknown }) {
  const guidance = explainError(error as ExplainErrorInput);
  return (
    <div className="surface guidance-note" role="alert">
      <strong>{guidance.title}</strong>
      <GuidanceDetails guidance={guidance} />
    </div>
  );
}
