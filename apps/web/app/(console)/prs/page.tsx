import type { Metadata } from "next";
import { apiGet, type Consumer, type MigrationPr } from "../../../lib/api";
import { PrsView } from "../../components/console/prs-view";
import type { PullRequest } from "../../components/console/fixtures";
import type { Status } from "../../components/ds/index";
import { mapPrStatus, patchStats, relativeTime } from "../../components/console/pr-map";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pull requests" };

export default async function PullRequestsPage() {
  const [prsResult, consumersResult] = await Promise.allSettled([
    apiGet<MigrationPr[]>("/prs"),
    apiGet<Consumer[]>("/consumers"),
  ]);

  const prs = prsResult.status === "fulfilled" ? prsResult.value : [];
  const consumers = consumersResult.status === "fulfilled" ? consumersResult.value : [];
  const repoByConsumer = new Map(
    consumers.map((c) => [c.id, `${c.githubOwner}/${c.githubRepo}`]),
  );

  const rows: PullRequest[] = prs.map((pr) => {
    const { additions, deletions, files } = patchStats(pr.patchUnified);
    return {
      id: pr.id,
      repo: repoByConsumer.get(pr.consumerId) ?? pr.branchName ?? "unknown",
      number: pr.githubPrNumber,
      title: pr.title,
      status: mapPrStatus(pr.status) as Status,
      additions,
      deletions,
      files,
      time: relativeTime(pr.createdAt),
    };
  });

  return <PrsView prs={rows} />;
}
