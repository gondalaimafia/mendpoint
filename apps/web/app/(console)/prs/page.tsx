import type { Metadata } from "next";
import { apiGet, type Consumer, type MigrationPr } from "../../../lib/api";
import { PrsView } from "../../components/console/prs-view";
import type { PullRequest } from "../../components/console/fixtures";
import type { Status } from "../../components/ds/index";
import {
  coverageSummary,
  mapPrStatus,
  patchStats,
  relativeTime,
} from "../../components/console/pr-map";

function mapCandidateStatus(candidate: NonNullable<MigrationPr["candidateDelivery"]>): Status {
  if (candidate.deliveryStatus === "delivery_pending") return "pending";
  if (candidate.deliveryStatus === "delivery_failed") return "failing";
  if (candidate.outcome === "merged") return "merged";
  if (candidate.outcome === "closed_unmerged" || candidate.outcome === "reverted") return "failing";
  return "draft";
}

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pull requests" };

export default async function PullRequestsPage() {
  const [prsResult, consumersResult] = await Promise.allSettled([
    apiGet<MigrationPr[]>("/prs"),
    apiGet<Consumer[]>("/consumers"),
  ]);

  // A rejected `/prs` fetch is unknown, not empty: surface an explicit
  // unavailable state rather than the "No pull requests staged yet." empty copy.
  const prsUnavailable = prsResult.status === "rejected";
  const prs = prsResult.status === "fulfilled" ? prsResult.value : [];
  const consumers = consumersResult.status === "fulfilled" ? consumersResult.value : [];
  const repoByConsumer = new Map(
    consumers.map((c) => [c.id, `${c.githubOwner}/${c.githubRepo}`]),
  );

  const rows: PullRequest[] = prs.map((pr) => {
    const { additions, deletions, files } = patchStats(pr.patchUnified);
    const candidate = pr.candidateDelivery;
    return {
      id: pr.id,
      repo: candidate?.repositoryId ?? repoByConsumer.get(pr.consumerId) ?? pr.branchName ?? "unknown",
      number: pr.githubPrNumber,
      title: pr.title,
      status: candidate ? mapCandidateStatus(candidate) : mapPrStatus(pr.status, pr.coverage) as Status,
      additions,
      deletions,
      files: candidate?.changedPaths.length ?? files,
      time: relativeTime(pr.createdAt),
      // Carry the coverage state so the row can distinguish a verified-clean
      // result from an unanalyzed one — a distinction the status pill alone
      // cannot make. Defaults to unknown when the channel is absent.
      coverage: candidate ? undefined : coverageSummary(pr.status, pr.coverage),
      candidateEvidence: candidate,
      githubUrl: pr.githubPrUrl,
    };
  });

  return <PrsView prs={rows} unavailable={prsUnavailable} />;
}
