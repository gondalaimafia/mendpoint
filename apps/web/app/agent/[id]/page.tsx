import Link from "next/link";
import { apiGet } from "../../../lib/api";
import { CandidateReview } from "./candidate-review";

export const dynamic = "force-dynamic";

type Run = {
  id: string;
  goal: string;
  status: string;
  filesChanged: string[];
  result: {
    candidate?: { summary?: string | null; expiresAt?: string | null } | null;
    review?: {
      decision: string | null;
      rationale: string | null;
      reviewedAt: string | null;
      reviewerPrincipalId: string | null;
      supersedingRunId: string | null;
    } | null;
    lineage?: { supersedesRunId: string | null; supersededByRunId: string | null };
  } | null;
  delivery?: Candidate["delivery"];
};

type Candidate = {
  changedPaths: string[];
  expiresAt: string | null;
  reviewEvidence?: {
    schemaVersion: 1;
    summary: string;
    verification: {
      summary: string;
      commands: Array<{ command: string; ok: true; exitCode: 0; outputSha256: string }>;
    };
    edits: Array<{
      path: string;
      rationale: string | null;
      category: string | null;
      risk: "low" | "medium" | "high" | null;
      confidence: number | null;
      assessmentSource: "planner" | "verifier" | "unavailable";
      verification: {
        summary: string;
        commandOutputSha256: string[];
      };
    }>;
  };
  files: Array<{
    path: string;
    before: string | null;
    after: string | null;
    beforeSha256: string | null;
    afterSha256: string | null;
  }>;
  delivery?: {
    status: "delivery_pending" | "delivered" | "delivery_failed";
    draftPrUrl: string | null;
    errorCode: string | null;
  } | null;
};

export default async function WardenCandidatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await apiGet<Run>(`/agent/runs/${id}`);
  let candidate: Candidate | null = null;
  let candidateError: string | null = null;
  if (run.status === "candidate_ready" || run.status === "candidate_approved") {
    try {
      candidate = await apiGet<Candidate>(`/agent/runs/${id}/candidate`, 60_000);
    } catch (error) {
      candidateError = String(error);
    }
  }
  const delivery = candidate?.delivery ?? run.delivery ?? null;
  const review = run.result?.review ?? null;
  const lineage = run.result?.lineage;
  const editEvidence = new Map(candidate?.reviewEvidence?.edits.map((edit) => [edit.path, edit]) ?? []);

  return (
    <div className="page">
      <div className="page-header">
        <Link href="/agent">Back to Warden</Link>
        <h1>Warden candidate</h1>
        <p className="muted">{run.goal}</p>
      </div>
      <section className="card stack">
        <p><strong>Status:</strong> {run.status}</p>
        {run.result?.candidate?.summary && <p>{run.result.candidate.summary}</p>}
        {candidate?.expiresAt && (
          <p className="muted">Review before {new Date(candidate.expiresAt).toLocaleString()}.</p>
        )}
        {candidateError && <p className="error">Candidate files are unavailable: {candidateError}</p>}
        {review && (
          <div className="card stack">
            <strong>Human review</strong>
            <p>Decision: {review.decision ?? "Recorded"}</p>
            {review.rationale && <p>{review.rationale}</p>}
            {review.reviewerPrincipalId && <p className="muted">Reviewer: {review.reviewerPrincipalId}</p>}
            {review.reviewedAt && <p className="muted">Reviewed {new Date(review.reviewedAt).toLocaleString()}</p>}
          </div>
        )}
        {(lineage?.supersedesRunId || lineage?.supersededByRunId || review?.supersedingRunId) && (
          <div className="card stack">
            <strong>Candidate history</strong>
            {lineage?.supersedesRunId && <Link href={`/agent/${lineage.supersedesRunId}`}>Open the earlier candidate</Link>}
            {(lineage?.supersededByRunId ?? review?.supersedingRunId) && (
              <Link href={`/agent/${lineage?.supersededByRunId ?? review?.supersedingRunId}`}>Open the regenerated candidate</Link>
            )}
          </div>
        )}
        {candidate?.files.map((file) => (
          <article key={file.path} className="stack">
            <h2>{file.path}</h2>
            {editEvidence.get(file.path) && (
              <div className="card stack">
                <strong>Review evidence for this file</strong>
                <p>{editEvidence.get(file.path)!.rationale ?? "A per file rationale was not measured by this planner run."}</p>
                <p className="muted">
                  Category: {editEvidence.get(file.path)!.category?.replaceAll("_", " ") ?? "not measured"}.
                  Risk: {editEvidence.get(file.path)!.risk ?? "not measured"}.
                  Confidence: {editEvidence.get(file.path)!.confidence === null
                    ? "not measured"
                    : `${Math.round(editEvidence.get(file.path)!.confidence! * 100)} percent`}.
                </p>
                <p>{editEvidence.get(file.path)!.verification.summary}</p>
                {candidate.reviewEvidence!.verification.commands.map((command) => (
                  <code key={`${file.path}:${command.command}`}>{command.command}</code>
                ))}
              </div>
            )}
            <div className="grid two">
              <div>
                <h3>Before</h3>
                <pre className="code-block">{file.before ?? "File did not exist"}</pre>
              </div>
              <div>
                <h3>After</h3>
                <pre className="code-block">{file.after ?? "File was deleted"}</pre>
              </div>
            </div>
          </article>
        ))}
        {delivery && (
          <div className="card stack" role="status">
            <strong>
              {delivery.status === "delivery_pending"
                ? "Draft pull request delivery is queued"
                : delivery.status === "delivered"
                  ? "Draft pull request delivered"
                  : "Draft pull request delivery needs attention"}
            </strong>
            <p className="muted">Approval never merges or deploys the change.</p>
            {delivery.errorCode && <code>{delivery.errorCode}</code>}
            {delivery.draftPrUrl && (
              <a className="btn" href={delivery.draftPrUrl} target="_blank" rel="noreferrer">
                Open draft pull request
              </a>
            )}
          </div>
        )}
        {run.status === "candidate_ready" && candidate && <CandidateReview runId={run.id} />}
      </section>
    </div>
  );
}
