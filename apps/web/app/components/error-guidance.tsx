import Link from "next/link";
import type { ExplainedError } from "@mendpoint/shared";

/**
 * Presentational rendering of a single {@link ExplainedError}. No client state,
 * so it renders in both server and client components. Used by the diagnostics
 * page (server) and the self-serve error note (client).
 */
export function GuidanceDetails({ guidance }: { guidance: ExplainedError }) {
  return (
    <div className="guidance">
      <p className="muted small">{guidance.whatHappened}</p>
      <p className="small">
        <strong>Likely cause:</strong> {guidance.likelyCause}
      </p>
      <p className="small">
        <strong>How to fix</strong>
      </p>
      <ul className="small">
        {guidance.howToFix.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ul>
      {guidance.docsHref && (
        <p className="small">
          <Link href={guidance.docsHref} prefetch={false}>
            Open the recommended step
          </Link>
        </p>
      )}
      <p className="mono small muted">Reference code: {guidance.code}</p>
    </div>
  );
}
