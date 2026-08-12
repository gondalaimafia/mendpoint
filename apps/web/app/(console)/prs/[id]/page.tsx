import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PrDetailView } from "../../../components/console/pr-detail-view";
import { findPullRequest } from "../../../components/console/fixtures";

export const metadata: Metadata = { title: "Pull request review" };

export default async function PullRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const pr = findPullRequest(id);
  if (!pr) notFound();

  return <PrDetailView pr={pr} />;
}
