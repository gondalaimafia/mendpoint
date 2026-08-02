import Link from "next/link";
import {
  apiGet,
  type MigrationPr,
  type MigrationPrReview,
} from "../../../../lib/api";
import { FeedbackButtons } from "./feedback";
import { ReviewPanel } from "./reviews";

export const dynamic = "force-dynamic";

export default async function PrDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let pr: MigrationPr | null = null;
  let reviews: MigrationPrReview[] = [];
  let error: string | null = null;
  try {
    const [prResult, reviewResult] = await Promise.all([
      apiGet<MigrationPr>(`/prs/${id}`),
      apiGet<{ reviews: MigrationPrReview[] }>(`/prs/${id}/reviews`),
    ]);
    pr = prResult;
    reviews = reviewResult.reviews;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error || !pr) {
    return (
      <div>
        <p className="muted">{error ?? "Not found"}</p>
        <Link href="/consumer">← Back</Link>
      </div>
    );
  }

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

      <h2>PR body</h2>
      <pre>{pr.body}</pre>

      <h2>Patch</h2>
      <pre>{pr.patchUnified || "(empty patch)"}</pre>

      <ReviewPanel prId={pr.id} initialReviews={reviews} />

      <h2>Feedback</h2>
      <p className="muted">Learning signal for future generations (merge / close / request changes).</p>
      <FeedbackButtons prId={pr.id} />
    </div>
  );
}
