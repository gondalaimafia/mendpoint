import Link from "next/link";
import { apiGet } from "../../../lib/api";
import { CandidateReview } from "./candidate-review";

export const dynamic = "force-dynamic";

type Run = {
  id: string;
  goal: string;
  status: string;
  filesChanged: string[];
  result: { candidate?: { summary?: string | null; expiresAt?: string | null } | null } | null;
};

type Candidate = {
  changedPaths: string[];
  expiresAt: string | null;
  files: Array<{
    path: string;
    before: string | null;
    after: string | null;
    beforeSha256: string | null;
    afterSha256: string | null;
  }>;
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
        {candidate?.files.map((file) => (
          <article key={file.path} className="stack">
            <h2>{file.path}</h2>
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
        {run.status === "candidate_ready" && candidate && <CandidateReview runId={run.id} />}
      </section>
    </div>
  );
}
