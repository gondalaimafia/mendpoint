import { apiGet } from "../../lib/api";
import Link from "next/link";
import type { ExplainedError } from "@mendpoint/shared";
import { StatusPill, type Status } from "../components/ds";
import { GuidanceDetails } from "../components/error-guidance";

export const dynamic = "force-dynamic";

type DiagnosticStatus = "pass" | "warn" | "fail";

type DiagnosticCheck = {
  id: string;
  title: string;
  category: "setup" | "authentication" | "integration" | "execution";
  status: DiagnosticStatus;
  detail: string;
  guidance: ExplainedError | null;
};

type DiagnosticsReport = {
  tenantId: string;
  generatedAt: string;
  status: "pass" | "attention" | "fail";
  summary: { pass: number; warn: number; fail: number };
  checks: DiagnosticCheck[];
};

const CHECK_PILL: Record<DiagnosticStatus, Status> = {
  pass: "open",
  warn: "pending",
  fail: "failing",
};

const CHECK_LABEL: Record<DiagnosticStatus, string> = {
  pass: "Pass",
  warn: "Attention",
  fail: "Action needed",
};

const OVERALL_PILL: Record<DiagnosticsReport["status"], Status> = {
  pass: "open",
  attention: "pending",
  fail: "failing",
};

const OVERALL_LABEL: Record<DiagnosticsReport["status"], string> = {
  pass: "All checks passing",
  attention: "Needs attention",
  fail: "Action needed",
};

export default async function DiagnosticsPage() {
  let report: DiagnosticsReport | null = null;
  let error: string | null = null;
  try {
    report = await apiGet<DiagnosticsReport>("/diagnostics");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div>
      <h1>Diagnostics</h1>
      <p className="lead">
        Self-service checks against your workspace setup, authentication,
        integration, and recent runs. Each check reads your own live state, and
        anything that is not passing comes with concrete steps you can take
        yourself.
      </p>

      {error && (
        <div className="card">
          <p className="muted">Diagnostics are unavailable: {error}</p>
          <p className="small muted">
            Confirm you are signed in, then reload. If the API is unreachable,
            check <Link href="/status">system status</Link>.
          </p>
        </div>
      )}

      {report && (
        <>
          <div className="surface" style={{ marginBottom: "1rem" }}>
            <div className="section-head">
              <div>
                <p className="eyebrow">Workspace {report.tenantId}</p>
                <h2>Overall</h2>
              </div>
              <StatusPill
                status={OVERALL_PILL[report.status]}
                label={OVERALL_LABEL[report.status]}
              />
            </div>
            <p className="muted small">
              {report.summary.pass} passing, {report.summary.warn} need
              attention, {report.summary.fail} need action. Generated{" "}
              {new Date(report.generatedAt).toLocaleString()}.
            </p>
          </div>

          <div className="diagnostics-checks">
            {report.checks.map((check) => (
              <section
                key={check.id}
                className="surface"
                aria-labelledby={`check-${check.id}`}
              >
                <div className="section-head">
                  <div>
                    <p className="eyebrow">{check.category}</p>
                    <h3 id={`check-${check.id}`} style={{ margin: 0 }}>
                      {check.title}
                    </h3>
                  </div>
                  <StatusPill
                    status={CHECK_PILL[check.status]}
                    label={CHECK_LABEL[check.status]}
                  />
                </div>
                <p className="muted small">{check.detail}</p>
                {check.guidance && <GuidanceDetails guidance={check.guidance} />}
              </section>
            ))}
          </div>
        </>
      )}

      <p style={{ marginTop: "1.5rem" }}>
        <Link href="/status">System status</Link> ·{" "}
        <Link href="/install">Connect GitHub</Link> ·{" "}
        <Link href="/consumer">Repositories</Link>
      </p>
    </div>
  );
}
