import Link from "next/link";
import {
  apiGet,
  type ChangeImpactCoverage,
  type MigrationPr,
  type MigrationPrReview,
} from "../../../../lib/api";
import { ImpactLineageCard } from "../../../components/console/impact-lineage-card";
import { buildImpactLineage, type ChangeImpactFinding } from "../../../components/console/impact-lineage";
import { FeedbackButtons } from "./feedback";
import { ReviewPanel } from "./reviews";
import { parsePrEvidence } from "./evidence";

export const dynamic = "force-dynamic";

type ChangeDetail = {
  createdAt?: string;
  // Required: `changeDetailBody` always sends it. Declaring it optional let a
  // body with no findings key render as a verified no-impact result.
  findings: ChangeImpactFinding[];
  impactCoverage?: ChangeImpactCoverage;
};

export default async function PrDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let pr: MigrationPr | null = null;
  let reviews: MigrationPrReview[] = [];
  let prError: string | null = null;
  let reviewError: string | null = null;
  try {
    pr = await apiGet<MigrationPr>(`/prs/${id}`);
  } catch (e) {
    prError = e instanceof Error ? e.message : String(e);
  }
  let change: ChangeDetail | null = null;
  if (pr) {
    const [reviewsResult, changeResult] = await Promise.allSettled([
      apiGet<{ reviews: MigrationPrReview[] }>(`/prs/${id}/reviews`),
      apiGet<ChangeDetail>(`/changes/${pr.changeId}`),
    ]);
    if (reviewsResult.status === "fulfilled") {
      reviews = reviewsResult.value.reviews;
    } else {
      reviewError = "Review history is temporarily unavailable. Decisions are paused until it can be loaded.";
    }
    change = changeResult.status === "fulfilled" ? changeResult.value : null;
  }

  if (prError || !pr) {
    return (
      <div>
        <h1>Pull request unavailable</h1>
        <p className="muted">The pull request could not be loaded. Retry or check system status.</p>
        <p className="btn-row"><Link className="btn primary" href={`/consumer/prs/${id}`}>Retry</Link><Link className="btn" href="/status">System status</Link></p>
        <Link href="/consumer">← Back</Link>
      </div>
    );
  }

  const evidence = parsePrEvidence(pr.body);
  const lineage = buildImpactLineage({
    change,
    consumerId: pr.consumerId,
    prBody: pr.body,
    prCoverageBasis: pr.coverage?.basis ?? null,
  });

  return (
    <div>
      <p className="muted">
        <Link href="/consumer">← Consumer</Link>
      </p>
      <h1>{pr.title}</h1>
      <div className="btn-row">
        <span className={`badge ${pr.risk}`}>{pr.risk}</span>
        <span className={`badge ${pr.status}`}>{pr.status}</span>
        {pr.githubPrUrl && (
          <a href={pr.githubPrUrl} target="_blank" rel="noreferrer">
            GitHub PR ↗
          </a>
        )}
      </div>

      <ImpactLineageCard lineage={lineage} />

      <h2>Review evidence</h2>
      {evidence.complete ? (
        <div className="grid">
          {evidence.sections.map((section) => (
            <section className="card" key={section.title}>
              <h3>{section.title === "Evidence" ? "Source evidence" : section.title}</h3>
              <pre>{section.content}</pre>
            </section>
          ))}
        </div>
      ) : (
        <div className="card" style={{ borderColor: "rgba(248,113,113,0.4)" }}>
          <h3>Evidence package incomplete</h3>
          <p className="muted">Approval is unavailable until verification, risks, rollback, ownership, and source evidence are recorded.</p>
        </div>
      )}

      <h2>Patch</h2>
      <pre>{pr.patchUnified || "(empty patch)"}</pre>

      <ReviewPanel
        prId={pr.id}
        initialReviews={reviews}
        evidenceReady={evidence.complete}
        disabledReason={reviewError ?? undefined}
      />

      <h2>Feedback</h2>
      <p className="muted">Learning signal for future generations (merge / close / request changes).</p>
      <FeedbackButtons prId={pr.id} />
    </div>
  );
}
