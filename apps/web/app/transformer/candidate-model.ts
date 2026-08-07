export type AdaptiveCandidateStatus =
  | "review_pending"
  | "approved"
  | "rejected"
  | "superseded"
  | "promoted"
  | "expired";

export type AdaptiveCandidateSummary = Readonly<{
  id: string;
  kind: "adaptive";
  status: AdaptiveCandidateStatus;
  campaignId: string;
  unitId: string;
  attemptId: string;
  repositoryId: string;
  snapshotId: string;
  baseBranch: string;
  expectedBaseRevision: string;
  candidateDigest: string;
  divergedFromDigest: string;
  failingCommandId: string | null;
  changedFileCount: number;
  expiresAt: string;
  createdAt: string;
  reviewedAt: string | null;
  promotedAt: string | null;
  reviewerPrincipalId: string | null;
  reviewDecision: "approve" | "reject" | "regenerate" | null;
  reviewRationale: string | null;
  supersedesCandidateId: string | null;
  supersededByCandidateId: string | null;
  generation: number;
  regeneration?: AdaptiveRegenerationView;
  delivery?: AdaptiveDeliveryView;
}>;

export type AdaptiveCandidateFile = Readonly<{
  path: string;
  action: "write";
  proposedContent: string;
  mode: "100644" | "100755";
  sha256: string;
  bytes: number;
}>;

export type AdaptiveSemanticCategory =
  | "behavior"
  | "tests"
  | "configuration"
  | "dependencies"
  | "security"
  | "documentation"
  | "other";

export type AdaptiveReviewRisk = "low" | "medium" | "high";

export type AdaptiveSemanticReviewEdit = Readonly<{
  path: string;
  changeType: "add" | "modify";
  beforeContent: string | null;
  afterContent: string;
  beforeDigest: string;
  afterDigest: string;
  beforeMode: "100644" | "100755" | null;
  afterMode: "100644" | "100755";
  rationale: string;
  risk: AdaptiveReviewRisk;
  confidence: number;
  bytes: Readonly<{
    before: number;
    after: number;
  }>;
}>;

export type AdaptiveSemanticReviewGroup = Readonly<{
  category: AdaptiveSemanticCategory;
  edits: readonly AdaptiveSemanticReviewEdit[];
}>;

export type AdaptiveSemanticReview = Readonly<{
  groups: readonly AdaptiveSemanticReviewGroup[];
  verification: Readonly<{
    passed: true;
    commandId: string;
    summary: string;
    outputDigest: string;
  }>;
  overallRisk: AdaptiveReviewRisk;
  confidence: number;
}>;

export type AdaptiveCandidateDetail = Omit<
  AdaptiveCandidateSummary,
  "createdAt" | "promotedAt"
> & Readonly<{
  changedPaths: readonly string[];
  sealVerified: boolean;
  evidenceStatus: "verified" | "retention_cleaned" | "corrupt";
  evidenceErrorCode: string | null;
  reviewEvidenceComplete: boolean;
  semanticReview: AdaptiveSemanticReview | null;
  previewComplete: boolean;
  totalBytes: number;
  files: readonly AdaptiveCandidateFile[];
  omittedPaths: readonly string[];
  delivery?: AdaptiveDeliveryView;
}>;

export type AdaptiveDeliveryView = Readonly<{
  id: string;
  status: "delivery_pending" | "delivered" | "delivery_failed";
  jobId: string;
  branchName: string | null;
  baseBranch: string;
  baseRevision: string | null;
  commitSha: string | null;
  draftPr: boolean | null;
  draftPrNumber: number | null;
  draftPrUrl: string | null;
  errorCode: string | null;
  requestedAt: string;
  deliveredAt: string | null;
}>;

export type AdaptiveRegenerationView = Readonly<{
  id: string;
  candidateId: string;
  campaignId: string;
  unitId: string;
  reviewerPrincipalId: string;
  rationale: string;
  rationaleDigest: string;
  status: "pending" | "scheduled" | "completed";
  attemptCount: number;
  lastErrorCode: string | null;
  externalProcessingAuthorizationRequired: boolean;
  authorizationMessage: string | null;
  supersedingCandidateId: string | null;
  requestedAt: string;
  scheduledAt: string | null;
  completedAt: string | null;
}>;

export type AdaptiveReviewResponse = Readonly<{
  id: string;
  status: AdaptiveCandidateStatus;
  reviewDecision: "approve" | "reject" | "regenerate";
  reviewerPrincipalId: string;
  reviewedAt: string;
  statement: string;
  delivery?: AdaptiveDeliveryView;
  regeneration?: AdaptiveRegenerationView;
}>;

export type AdaptiveCandidateInboxPage = Readonly<{
  attention: readonly AdaptiveCandidateSummary[];
  history: readonly AdaptiveCandidateSummary[];
  nextHistoryCursor: string | null;
}>;

export function mergeAdaptiveCandidateHistory(
  current: readonly AdaptiveCandidateSummary[],
  nextPage: readonly AdaptiveCandidateSummary[],
): AdaptiveCandidateSummary[] {
  const seen = new Set(current.map((candidate) => candidate.id));
  return [
    ...current,
    ...nextPage.filter((candidate) => {
      if (seen.has(candidate.id)) return false;
      seen.add(candidate.id);
      return true;
    }),
  ];
}

export function pendingAdaptiveCandidates(
  candidates: readonly AdaptiveCandidateSummary[],
): AdaptiveCandidateSummary[] {
  return candidates
    .filter((candidate) => candidate.status === "review_pending")
    .sort((left, right) => {
      const expiryOrder = Date.parse(left.expiresAt) - Date.parse(right.expiresAt);
      return expiryOrder || left.id.localeCompare(right.id);
    });
}

export function organizeAdaptiveCandidates(
  candidates: readonly AdaptiveCandidateSummary[],
): Readonly<{
  attention: AdaptiveCandidateSummary[];
  history: AdaptiveCandidateSummary[];
}> {
  const attentionPriority = (candidate: AdaptiveCandidateSummary): number => {
    if (candidate.status === "review_pending") return 0;
    if (candidate.delivery?.status === "delivery_failed") return 1;
    return 2;
  };
  const attention = candidates
    .filter((candidate) => candidate.status === "review_pending" || candidate.status === "approved")
    .sort((left, right) => {
      const priority = attentionPriority(left) - attentionPriority(right);
      if (priority) return priority;
      if (left.status === "review_pending" && right.status === "review_pending") {
        const expiryOrder = Date.parse(left.expiresAt) - Date.parse(right.expiresAt);
        if (expiryOrder) return expiryOrder;
      }
      return left.id.localeCompare(right.id);
    });
  const history = candidates
    .filter((candidate) => candidate.status !== "review_pending" && candidate.status !== "approved")
    .sort((left, right) => {
      const leftTime = Date.parse(left.promotedAt ?? left.reviewedAt ?? left.createdAt);
      const rightTime = Date.parse(right.promotedAt ?? right.reviewedAt ?? right.createdAt);
      return rightTime - leftTime || left.id.localeCompare(right.id);
    });
  return { attention, history };
}

export function candidateLifecycle(candidate: AdaptiveCandidateSummary): Readonly<{
  label: string;
  tone: "active" | "success" | "danger" | "neutral";
  action: string;
}> {
  if (candidate.status === "review_pending") {
    return { label: "Review pending", tone: "active", action: "Review files" };
  }
  if (candidate.status === "approved" && candidate.delivery?.status === "delivery_failed") {
    return { label: "Draft delivery failed", tone: "danger", action: "View failure" };
  }
  if (candidate.status === "approved") {
    return { label: "Draft delivery pending", tone: "active", action: "View delivery" };
  }
  if (candidate.status === "promoted" && candidate.delivery?.status === "delivered") {
    return { label: "Draft delivered", tone: "success", action: "View evidence" };
  }
  if (candidate.status === "promoted") {
    return { label: "Promoted", tone: "success", action: "View evidence" };
  }
  if (candidate.status === "rejected") {
    return { label: "Rejected", tone: "neutral", action: "View decision" };
  }
  if (candidate.status === "superseded") {
    if (candidate.regeneration?.externalProcessingAuthorizationRequired) {
      return { label: "Awaiting customer authorization", tone: "active", action: "View requirement" };
    }
    return { label: "Regeneration requested", tone: "neutral", action: "View lineage" };
  }
  return { label: "Expired", tone: "neutral", action: "View record" };
}

export function candidateStatusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

export function reviewReadiness(candidate: AdaptiveCandidateDetail): Readonly<{
  canApprove: boolean;
  canReject: boolean;
  canRegenerate: boolean;
  blockers: readonly string[];
}> {
  const blockers: string[] = [];
  if (candidate.status !== "review_pending") blockers.push("This candidate is no longer awaiting review.");
  if (!candidate.sealVerified) blockers.push("The sealed candidate could not be verified.");
  if (!candidate.previewComplete) blockers.push("The full proposed change is not available for review.");
  if (!candidate.reviewEvidenceComplete || !candidate.semanticReview) {
    blockers.push("The complete explanation and verification evidence is not available for review.");
  }
  return {
    canApprove: blockers.length === 0,
    canReject: candidate.status === "review_pending",
    canRegenerate: candidate.status === "review_pending",
    blockers,
  };
}

export function adaptiveReviewActionEnabled(input: Readonly<{
  decision: "approve" | "reject" | "regenerate";
  humanIdentity: boolean | null;
  busy: boolean;
  rationale: string;
  readiness: ReturnType<typeof reviewReadiness> | null;
}>): boolean {
  if (
    input.humanIdentity !== true ||
    input.busy ||
    input.rationale.trim().length === 0 ||
    !input.readiness
  ) {
    return false;
  }
  if (input.decision === "approve") return input.readiness.canApprove;
  return input.decision === "regenerate"
    ? input.readiness.canRegenerate
    : input.readiness.canReject;
}

export function formatCandidateBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
