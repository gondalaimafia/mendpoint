import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ApiRequestError, apiGet } from "../../../lib/api";
import { RunsView } from "../../components/console/runs-view";
import type { RunSummary } from "../../components/console/fixtures";
import { mapRunStatus, runDuration } from "../../components/console/run-map";
import { relativeTime } from "../../components/console/pr-map";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Runs" };

/** The tenant-scoped, flag-gated run list DTO (`GET /self-serve/runs`). */
type RunListDto = {
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

function toSummary(dto: RunListDto): RunSummary {
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

export default async function RunsPage() {
  let runs: RunSummary[] = [];
  try {
    const body = await apiGet<{ runs: RunListDto[] }>("/self-serve/runs");
    runs = body.runs.map(toSummary);
  } catch (error) {
    // Flag OFF ⇒ the API route is absent (404); the console route 404s too.
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }
  return <RunsView runs={runs} />;
}
