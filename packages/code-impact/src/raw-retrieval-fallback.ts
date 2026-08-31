import { createHash } from "node:crypto";
import {
  createRawRetrievalRelationshipCandidate,
  type FettlerEndpointImpactResult,
  type RawRetrievalRelationshipCandidateAuthority,
  type RawRetrievalRelationshipCandidateV1,
} from "@mendpoint/graph-learn";
import type { ImpactReport } from "@mendpoint/shared";

export type RawRetrievalBoundsAndUsage = Readonly<{
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
  maxTraversalDepth: number;
  maxCandidates: number;
  filesInspected: number;
  bytesInspected: number;
}>;

export type RawRetrievalFallbackDecision = Readonly<{
  schemaVersion: "mendpoint.raw-retrieval-fallback-decision.v1";
  outcome: "not_required" | "completed" | "abstained";
  reasonCodes: string[];
  graphVersionId: string;
  graphContentDigest: string;
  graphResultDigest: string;
  impactReport: ImpactReport | null;
  impactReportDigest: string | null;
  retrieval: RawRetrievalBoundsAndUsage & Readonly<{ candidatesInspected: number }>;
  candidateDigests: string[];
  failureCode?:
    | "raw_retrieval_file_budget_exceeded"
    | "raw_retrieval_byte_budget_exceeded"
    | "raw_retrieval_traversal_depth_budget_exceeded"
    | "raw_retrieval_candidate_budget_exceeded";
  decisionDigest: string;
}>;

export type RawRetrievalFallbackResult = Readonly<{
  decision: RawRetrievalFallbackDecision;
  impactReport?: ImpactReport;
  relationshipCandidates: RawRetrievalRelationshipCandidateV1[];
}>;

export type ResolveBoundedRawRetrievalFallbackInput = Readonly<{
  graphImpact: FettlerEndpointImpactResult;
  rawReport: ImpactReport;
  authority: RawRetrievalRelationshipCandidateAuthority;
  observedAt: string;
  retrieval: RawRetrievalBoundsAndUsage;
  requiredReasonCodes?: readonly string[];
}>;

const compareCodeUnits = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

const digest = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex")}`;

function decision(
  input: Omit<RawRetrievalFallbackDecision, "schemaVersion" | "decisionDigest">,
): RawRetrievalFallbackDecision {
  const unsigned = {
    schemaVersion: "mendpoint.raw-retrieval-fallback-decision.v1" as const,
    ...input,
  };
  return Object.freeze({ ...unsigned, decisionDigest: digest(unsigned) });
}

function graphAuthorityMatches(input: ResolveBoundedRawRetrievalFallbackInput): boolean {
  return input.graphImpact.tenantId === input.authority.tenantId &&
    input.graphImpact.repositoryId === input.authority.repositoryId &&
    input.graphImpact.repositorySnapshotId === input.authority.repositorySnapshotId &&
    input.graphImpact.repositoryRevision === input.authority.repositoryRevision &&
    input.graphImpact.providerId === input.authority.providerId &&
    input.graphImpact.providerSnapshotId === input.authority.providerSnapshotId &&
    input.graphImpact.providerRevision === input.authority.providerRevision &&
    input.graphImpact.graphVersionId === input.authority.parentGraphVersionId &&
    input.graphImpact.graphContentDigest === input.authority.parentGraphContentDigest;
}

function normalizeImpactReport(report: ImpactReport): ImpactReport {
  const normalized = JSON.parse(JSON.stringify(canonicalValue(report))) as ImpactReport;
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  };
  freeze(normalized);
  return normalized;
}

function retrievalReasons(input: ResolveBoundedRawRetrievalFallbackInput): string[] {
  return [...new Set([
    ...input.graphImpact.coverage.reasons,
    ...(input.graphImpact.coverage.truncated ? ["query_truncated"] : []),
    ...(input.requiredReasonCodes ?? []),
  ])].sort(compareCodeUnits);
}

function unknownEmptyReport(
  report: ImpactReport,
  reasons: string[],
): ImpactReport {
  const priorGaps = report.coverage?.gaps ?? [];
  const detail = `Graph coverage was insufficient (${reasons.join(", ")}); an empty bounded raw retrieval is no known impact, not verified clean.`;
  // Map only causes represented by the shared typed vocabulary. In particular,
  // unresolved graph identity is not a truncated query and must never be
  // fabricated as one merely to populate `gaps`.
  const mappedReason = reasons.includes("query_truncated")
    ? "query_truncated" as const
    : reasons.some((reason) => reason.startsWith("language_parsing:"))
      ? "unsupported_language" as const
      : reasons.some((reason) => reason.startsWith("repository_discovery:"))
        ? "skipped_directory" as const
        : undefined;
  const fallbackGap = mappedReason ? { reason: mappedReason, detail } : undefined;
  return {
    ...report,
    overallConfidence: "unknown",
    coverage: {
      ...(report.coverage ?? { gaps: [] }),
      basis: "partial",
      reason: detail,
      gaps: fallbackGap && !priorGaps.some((gap) => gap.reason === fallbackGap.reason)
        ? [...priorGaps, fallbackGap]
        : priorGaps,
    },
  };
}

function validateRetrievalBounds(retrieval: RawRetrievalBoundsAndUsage): void {
  const invalid =
    !Number.isSafeInteger(retrieval.maxFiles) || retrieval.maxFiles < 1 || retrieval.maxFiles > 10_000 ||
    !Number.isSafeInteger(retrieval.maxBytes) || retrieval.maxBytes < 1 || retrieval.maxBytes > 1_000_000_000 ||
    !Number.isSafeInteger(retrieval.maxFileBytes) || retrieval.maxFileBytes < 1 || retrieval.maxFileBytes > 5_242_880 ||
    !Number.isSafeInteger(retrieval.maxTraversalDepth) || retrieval.maxTraversalDepth < 1 || retrieval.maxTraversalDepth > 64 ||
    !Number.isSafeInteger(retrieval.maxCandidates) || retrieval.maxCandidates < 1 || retrieval.maxCandidates > 50_000 ||
    !Number.isSafeInteger(retrieval.filesInspected) || retrieval.filesInspected < 0 ||
    !Number.isSafeInteger(retrieval.bytesInspected) || retrieval.bytesInspected < 0;
  if (invalid) throw new Error("raw_retrieval_bounds_invalid");
}

/**
 * Decide whether the raw analysis produced alongside one graph observation may
 * be used as a bounded fallback. Candidate output is non-authoritative and can
 * only be considered by a later graph-version validation step.
 */
export function resolveBoundedRawRetrievalFallback(
  input: ResolveBoundedRawRetrievalFallbackInput,
): RawRetrievalFallbackResult {
  if (!graphAuthorityMatches(input)) {
    throw new Error("raw_retrieval_fallback_graph_scope_mismatch");
  }
  validateRetrievalBounds(input.retrieval);
  const graphComplete = input.graphImpact.coverage.basis === "complete" &&
    !input.graphImpact.coverage.truncated &&
    (input.requiredReasonCodes?.length ?? 0) === 0;
  if (graphComplete) {
    return Object.freeze({
      decision: decision({
        outcome: "not_required",
        reasonCodes: [],
        graphVersionId: input.graphImpact.graphVersionId,
        graphContentDigest: input.graphImpact.graphContentDigest,
        graphResultDigest: input.graphImpact.resultDigest,
        impactReport: null,
        impactReportDigest: null,
        retrieval: {
          ...input.retrieval,
          filesInspected: 0,
          bytesInspected: 0,
          candidatesInspected: 0,
        },
        candidateDigests: [],
      }),
      relationshipCandidates: [],
    });
  }

  const reasons = retrievalReasons(input);
  const candidatesInspected = input.rawReport.candidateCount;
  const failureCode = input.retrieval.filesInspected > input.retrieval.maxFiles
    ? "raw_retrieval_file_budget_exceeded" as const
    : input.retrieval.bytesInspected > input.retrieval.maxBytes
      ? "raw_retrieval_byte_budget_exceeded" as const
      : candidatesInspected > input.retrieval.maxCandidates
        ? "raw_retrieval_candidate_budget_exceeded" as const
        : undefined;
  if (failureCode) {
    return Object.freeze({
      decision: decision({
        outcome: "abstained",
        reasonCodes: reasons,
        graphVersionId: input.graphImpact.graphVersionId,
        graphContentDigest: input.graphImpact.graphContentDigest,
        graphResultDigest: input.graphImpact.resultDigest,
        impactReport: null,
        impactReportDigest: null,
        retrieval: { ...input.retrieval, candidatesInspected },
        candidateDigests: [],
        failureCode,
      }),
      relationshipCandidates: [],
    });
  }

  const relationshipCandidates = input.rawReport.sites
    .filter((site) => site.confidence === "high")
    .map((site) => createRawRetrievalRelationshipCandidate({
      ...input.authority,
      observedAt: input.observedAt,
      retrieval: {
        ...input.retrieval,
        candidatesInspected,
        reasonCodes: reasons.length ? reasons : ["graph_coverage_incomplete"],
      },
      discovery: {
        filePath: site.filePath,
        lineStart: site.lineStart,
        lineEnd: site.lineEnd,
        symbol: site.symbol,
        surfaceIds: site.surfaceIds?.length
          ? site.surfaceIds
          : input.rawReport.surfaces.map((surface) => surface.id),
        evidenceRefs: [site.evidence],
        confidence: site.confidence,
      },
    }));
  const impactReport = normalizeImpactReport(input.rawReport.sites.length === 0
    ? unknownEmptyReport(input.rawReport, reasons)
    : input.rawReport);
  const impactReportDigest = digest(impactReport);
  const completedDecision = decision({
    outcome: "completed",
    reasonCodes: reasons,
    graphVersionId: input.graphImpact.graphVersionId,
    graphContentDigest: input.graphImpact.graphContentDigest,
    graphResultDigest: input.graphImpact.resultDigest,
    impactReport,
    impactReportDigest,
    retrieval: { ...input.retrieval, candidatesInspected },
    candidateDigests: relationshipCandidates.map((candidate) => candidate.candidateDigest),
  });
  return Object.freeze({
    decision: completedDecision,
    impactReport: completedDecision.impactReport ?? undefined,
    relationshipCandidates,
  });
}
