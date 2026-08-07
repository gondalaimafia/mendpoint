import type { Metadata } from "next";
import { AdaptiveCandidateReview } from "./candidate-review";

export const metadata: Metadata = {
  title: "Transformer adaptive candidate review",
  description: "Review the exact sealed files for a Transformer adaptive candidate.",
};

export default async function TransformerAdaptiveCandidatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AdaptiveCandidateReview candidateId={id} />;
}
