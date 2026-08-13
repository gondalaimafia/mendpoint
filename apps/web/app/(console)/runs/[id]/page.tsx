import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ApiRequestError, apiGet } from "../../../../lib/api";
import { RunDetailView } from "../../../components/console/run-detail-view";
import type { RunDetailData, RunSummary } from "../../../components/console/fixtures";
import { mapRunStatus, runDuration } from "../../../components/console/run-map";
import { relativeTime, parseUnifiedDiff } from "../../../components/console/pr-map";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Run" };

type RunSummaryDto = {
  id: string;
  type: string;
  status: string;
  target: string | null;
  goal: string | null;
  triggeredBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  canCancel: boolean;
  cancelReason: string | null;
  canRetry: boolean;
  retryReason: string | null;
};

/** The tenant-scoped, flag-gated run detail DTO (`GET /self-serve/runs/:id`). */
type RunDetailDto = {
  run: RunSummaryDto;
  plan: { title: string; goal: string; steps: Array<{ title: string; action: string; status: string }> } | null;
  log: string | null;
  verification: Array<{ name: string; state: string }>;
  changedPaths: string[];
  prs: Array<{ number: number | null; url: string | null; status: string; patchUnified: string | null }>;
  review: { href: string | null; kind: "warden" | "pr" | null };
};

function toSummary(dto: RunSummaryDto): RunSummary {
  const mapped = mapRunStatus(dto.status);
  return {
    id: dto.id,
    type: dto.type,
    status: mapped.status,
    statusLabel: mapped.label,
    target: dto.target,
    goal: dto.goal,
    triggeredBy: dto.triggeredBy,
    createdAt: dto.createdAt,
    startedAt: dto.startedAt,
    finishedAt: dto.finishedAt,
    timeLabel: relativeTime(dto.createdAt),
    durationLabel: runDuration(dto.startedAt, dto.finishedAt),
    canCancel: dto.canCancel,
    cancelReason: dto.cancelReason,
    canRetry: dto.canRetry,
    retryReason: dto.retryReason,
  };
}

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let dto: RunDetailDto;
  try {
    dto = await apiGet<RunDetailDto>(`/self-serve/runs/${id}`);
  } catch (error) {
    // Flag OFF or a run outside the tenant ⇒ 404, so the console route 404s too.
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }

  // DiffView renders only real unified patches (from a matched PR); everything
  // else falls back to the changed-file list so no diff is ever fabricated.
  const diffs = dto.prs
    .filter((pr) => pr.patchUnified)
    .flatMap((pr) =>
      parseUnifiedDiff(pr.patchUnified as string).map((file) => ({
        path: file.path,
        hunks: file.hunks,
        additions: file.additions,
        deletions: file.deletions,
      })),
    );

  const data: RunDetailData = {
    run: toSummary(dto.run),
    plan: dto.plan,
    log: dto.log,
    verification: dto.verification,
    changedPaths: dto.changedPaths,
    diffs,
    prs: dto.prs.map((pr) => ({ number: pr.number, url: pr.url, status: pr.status })),
    reviewHref: dto.review.href,
  };

  return <RunDetailView data={data} />;
}
