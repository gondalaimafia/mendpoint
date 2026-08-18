import type { Metadata } from "next";
import { apiGet, type Consumer, type MigrationPr } from "../../../../lib/api";
import { PrDetailView } from "../../../components/console/pr-detail-view";
import type { PrDetailData } from "../../../components/console/fixtures";
import { mapPrStatus, parseUnifiedDiff } from "../../../components/console/pr-map";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pull request review" };

type DiffEntry = {
  op: string;
  path?: string;
  method?: string;
  field?: string;
  fromField?: string;
  toField?: string;
  detail?: string;
  breaking: boolean;
};

type ChangeDetail = {
  id: string;
  risk: string;
  summary: string;
  diff: { entries: DiffEntry[]; risk: string; summary: string };
};

function endpointFor(entry: DiffEntry): string {
  const method = entry.method ? `${entry.method.toUpperCase()} ` : "";
  if (entry.path) return `${method}${entry.path}`.trim();
  if (entry.field) return entry.field;
  if (entry.fromField) return entry.fromField;
  return entry.op;
}

function buildAlert(change: ChangeDetail | null): PrDetailData["alert"] {
  if (!change) return null;
  const breaking = change.diff.entries.find((e) => e.breaking);
  if (change.risk !== "breaking" && !breaking) return null;
  const endpoint = breaking ? endpointFor(breaking) : null;
  return {
    title: endpoint ? `Breaking change · ${endpoint}` : "Breaking change",
    body: change.summary || change.diff.summary || "This change is flagged breaking.",
  };
}

export default async function PullRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let pr: MigrationPr | null = null;
  try {
    pr = await apiGet<MigrationPr>(`/prs/${id}`);
  } catch {
    pr = null;
  }

  if (!pr) {
    const empty: PrDetailData = {
      id: null,
      repo: "unknown",
      title: "Pull request unavailable",
      number: null,
      // The PR failed to load, so its real status is unknown. "failing" would be
      // a fabricated red negative; "pending" (amber, indeterminate) reflects that
      // we could not determine the status rather than asserting the PR is broken.
      status: "pending",
      githubUrl: null,
      alert: null,
      diffs: [],
      checks: [],
    };
    return <PrDetailView pr={empty} />;
  }

  const [consumersResult, changeResult] = await Promise.allSettled([
    apiGet<Consumer[]>("/consumers"),
    apiGet<ChangeDetail>(`/changes/${pr.changeId}`),
  ]);

  const consumers = consumersResult.status === "fulfilled" ? consumersResult.value : [];
  const change = changeResult.status === "fulfilled" ? changeResult.value : null;
  const consumer = consumers.find((c) => c.id === pr.consumerId) ?? null;

  const diffs = parseUnifiedDiff(pr.patchUnified).map((file) => ({
    path: file.path,
    hunks: file.hunks,
    additions: file.additions,
    deletions: file.deletions,
  }));

  const data: PrDetailData = {
    id: pr.id,
    repo: consumer ? `${consumer.githubOwner}/${consumer.githubRepo}` : pr.branchName || "unknown",
    title: pr.title,
    number: pr.githubPrNumber,
    status: mapPrStatus(pr.status),
    githubUrl: pr.githubPrUrl,
    alert: buildAlert(change),
    diffs,
    // No CI-check GET endpoint exists; surface the real review gates (status +
    // risk) as the nearest available signal.
    checks: [
      { name: "review status", state: pr.status },
      { name: "risk", state: pr.risk },
    ],
  };

  return <PrDetailView pr={data} />;
}
