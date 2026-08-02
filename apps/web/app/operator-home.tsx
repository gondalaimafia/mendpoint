import Link from "next/link";
import claimRegistry from "../../../docs/PUBLIC_CLAIMS.json";
import { apiGet } from "../lib/api";

export const dynamic = "force-dynamic";

type SystemStatus = {
  status: string;
  release?: { version: string; channel: string };
};

type RecoverySummary = {
  pending: number;
  retryScheduled: number;
  running: number;
  deadLetter: number;
  recovered: number;
  done: number;
  oldestPendingAgeMs: number | null;
};

type Job = {
  id: string;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  errorCode: string | null;
};

function jobLabel(type: string): string {
  if (type === "agent.run") return "Warden investigation";
  if (type === "repair.run") return "Verified repair";
  if (type === "pipeline.fanout") return "Change analysis";
  return type.replaceAll(".", " ");
}

function stateLabel(status: string): string {
  const labels: Record<string, string> = {
    pending: "Planning",
    running: "Repairing",
    done: "Ready",
    cancelled: "Cancelled",
    dead_letter: "Needs review",
    failed: "Needs review",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function tone(status: string): string {
  if (status === "done") return "success";
  if (status === "dead_letter" || status === "failed") return "danger";
  if (status === "running") return "active";
  return "neutral";
}

export default async function OperatorHome() {
  const figuresClaim = claimRegistry.claims.find((claim) => claim.id === "CLM-011");
  if (!figuresClaim) throw new Error("Missing public claim CLM-011");
  const [statusResult, recoveryResult, jobsResult] = await Promise.allSettled([
    apiGet<SystemStatus>("/status"),
    apiGet<RecoverySummary>("/recovery/summary"),
    apiGet<Job[]>("/jobs"),
  ]);
  const status = statusResult.status === "fulfilled" ? statusResult.value : null;
  const recovery = recoveryResult.status === "fulfilled" ? recoveryResult.value : null;
  const jobs = jobsResult.status === "fulfilled" ? jobsResult.value.slice(0, 6) : [];
  const operational = status?.status === "ok";
  const needsReview = recovery?.deadLetter ?? 0;
  const systemNeedsAttention = status !== null && !operational;
  const attentionCount = needsReview + (systemNeedsAttention ? 1 : 0);
  const active = (recovery?.running ?? 0) + (recovery?.pending ?? 0);

  return (
    <div className="workspace-page">
      <header className="command-header">
        <div>
          <p className="eyebrow">Operator workspace</p>
          <h1>Keep every API change moving</h1>
          <p className="lead">
            Investigate impact, run bounded repairs, and review proof before any change reaches a
            customer repository.
          </p>
        </div>
        <div className="command-actions" aria-label="Primary actions">
          <Link className="btn primary" href="/agent" prefetch={false}>Start investigation</Link>
          <Link className="btn" href="/provider" prefetch={false}>Analyze a change</Link>
        </div>
      </header>

      <section className="metric-grid" aria-label="Workspace summary">
        <Link className="metric-card" href="/status" prefetch={false}>
          <span className="metric-label">System</span>
          <strong>{operational ? "Operational" : status?.status ?? "Unavailable"}</strong>
          <span className="metric-detail">
            <span className={`status-dot ${operational ? "ok-dot" : "warn-dot"}`} aria-hidden />
            {status?.release?.channel ?? "Health needs attention"}
          </span>
        </Link>
        <Link className="metric-card" href="/status#recovery" prefetch={false}>
          <span className="metric-label">Needs you</span>
          <strong className={attentionCount > 0 ? "danger-text" : undefined}>{attentionCount}</strong>
          <span className="metric-detail">System and recovery review</span>
        </Link>
        <Link className="metric-card" href="/status#recovery" prefetch={false}>
          <span className="metric-label">In progress</span>
          <strong>{active}</strong>
          <span className="metric-detail">Running or waiting</span>
        </Link>
        <Link className="metric-card" href="/status#recovery" prefetch={false}>
          <span className="metric-label">Verified</span>
          <strong>{recovery?.recovered ?? 0}</strong>
          <span className="metric-detail">Successful recoveries</span>
        </Link>
      </section>
      <p className="muted small">{figuresClaim.wording}</p>

      <div className="cockpit-grid">
        <section className="surface attention-surface">
          <div className="section-head">
            <div>
              <p className="eyebrow">Attention</p>
              <h2>What needs a decision</h2>
            </div>
            <Link href="/status" prefetch={false}>Open status</Link>
          </div>
          {attentionCount === 0 && operational ? (
            <div className="calm-state">
              <span className="calm-mark" aria-hidden>✓</span>
              <div>
                <strong>No operator action required</strong>
                <p>All bounded recovery work is healthy. Mendpoint will surface failed work here.</p>
              </div>
            </div>
          ) : (
            <div className="attention-callout" role="status">
              <strong>{attentionCount || 1} item{attentionCount === 1 ? "" : "s"} need review</strong>
              <p>
                {needsReview > 0
                  ? "Inspect recovery evidence, retry safely, or cancel the work."
                  : "Open system status to inspect the degraded check before starting customer work."}
              </p>
              <Link className="btn" href={needsReview > 0 ? "/status#recovery" : "/status"} prefetch={false}>
                {needsReview > 0 ? "Review recovery" : "Review system"}
              </Link>
            </div>
          )}
          <div className="guardrail-row">
            <div><span>01</span><strong>Analyze</strong><small>Map the blast radius</small></div>
            <div><span>02</span><strong>Repair</strong><small>Apply bounded changes</small></div>
            <div><span>03</span><strong>Verify</strong><small>Run focused checks</small></div>
            <div><span>04</span><strong>Review</strong><small>Approve the pull request</small></div>
          </div>
        </section>

        <section className="surface activity-surface">
          <div className="section-head">
            <div>
              <p className="eyebrow">Worklog</p>
              <h2>Recent activity</h2>
            </div>
            <Link href="/status#work" prefetch={false}>View all</Link>
          </div>
          {jobs.length === 0 ? (
            <div className="empty-state compact">
              <p>No work has run yet.</p>
              <Link href="/agent" prefetch={false}>Start the first investigation</Link>
            </div>
          ) : (
            <ol className="activity-list">
              {jobs.map((job) => (
                <li key={job.id}>
                  <span className={`activity-marker ${tone(job.status)}`} aria-hidden />
                  <div className="activity-copy">
                    <strong>{jobLabel(job.type)}</strong>
                    <span>{job.errorCode ? `${job.errorCode}. ` : ""}Attempt {job.attempts} of {job.maxAttempts}</span>
                  </div>
                  <div className="activity-meta">
                    <span className={`state-pill ${tone(job.status)}`}>{stateLabel(job.status)}</span>
                    <time dateTime={job.createdAt}>{new Date(job.createdAt).toLocaleString()}</time>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <section className="next-actions deferred" aria-labelledby="next-actions-title">
        <div>
          <p className="eyebrow">Next action</p>
          <h2 id="next-actions-title">Move from signal to reviewed change</h2>
        </div>
        <div className="action-links">
          <Link href="/install" prefetch={false}><strong>Connect a repository</strong><span>Scope access before analysis</span></Link>
          <Link href="/provider" prefetch={false}><strong>Publish an API change</strong><span>Classify risk and impact</span></Link>
          <Link href="/graph" prefetch={false}><strong>Inspect evidence</strong><span>Explore the affected graph</span></Link>
        </div>
      </section>
    </div>
  );
}
