import {
  createStructuredPrPackageV1,
  type StructuredPrPackageV1,
  type StructuredPrPackageV1Input,
} from "@mendpoint/contract";

function bullets(values: readonly string[]): string[] {
  return values.map((value) => `- ${value}`);
}

export function createWardenDraftPrPackage(
  input: StructuredPrPackageV1Input,
): Readonly<{ package: StructuredPrPackageV1; markdown: string }> {
  const packageRecord = createStructuredPrPackageV1(input);
  const verification = packageRecord.verification.results.flatMap((result) => [
    `- **${result.checkId}:** ${result.status}`,
    ...result.evidenceRecordIds.map((id) => `  - Evidence: \`${id}\``),
  ]);
  const reviewers = packageRecord.review.reviewerPrincipalIds.map(
    (principalId) => `- Reviewer: \`${principalId}\``,
  );
  const owners = packageRecord.ownership.ownerPrincipalIds.map(
    (principalId) => `- Owner: \`${principalId}\``,
  );
  const evidence = [
    ...packageRecord.findings.flatMap((finding) => finding.evidenceArtifactIds),
    ...packageRecord.verification.artifactIds,
    ...packageRecord.verification.evidenceRecordIds,
  ].sort((left, right) => left.localeCompare(right));

  return Object.freeze({
    package: packageRecord,
    markdown: [
      "### Structured Fettler draft package",
      "",
      "#### Summary",
      packageRecord.summary,
      "",
      "#### Why",
      packageRecord.rationale,
      "",
      "#### Exact files",
      ...packageRecord.candidate.edits.map((edit) => `- \`${edit.path}\``),
      "",
      "#### Verification results",
      ...verification,
      "",
      "#### Risks",
      ...bullets(packageRecord.risks),
      "",
      "#### Rollback",
      `- Strategy: \`${packageRecord.rollback.strategy}\``,
      `- Instructions: ${packageRecord.rollback.instructions}`,
      "",
      "#### Evidence",
      `- Snapshot revision kind: \`${packageRecord.snapshot.revisionKind}\``,
      `- Snapshot revision: \`${packageRecord.snapshot.resolvedSha}\``,
      ...evidence.map((id) => `- \`${id}\``),
      "",
      "#### Reviewer ownership",
      ...owners,
      ...reviewers,
      `- Required reviewer count: ${packageRecord.review.requiredReviewerCount}`,
      "",
      "#### Delivery controls",
      "- Draft pull request only",
      "- Automatic merge: disabled",
      "- Automatic deployment: disabled",
      `- Package digest: \`${packageRecord.integrity.digest}\``,
    ].join("\n"),
  });
}
