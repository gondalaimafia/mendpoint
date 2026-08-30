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
  retrieval: RawRetrievalBoundsAndUsage & Readonly<{ candidatesInspected: number }>;
  candidateDigests: string[];
  failureCode?: "raw_retrieval_candidate_budget_exceeded";
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
    input.graphImpact.graphVersionId === input.authority.parentGraphVersionId &&
    input.graphImpact.graphContentDigest === input.authority.parentGraphContentDigest;
}

function retrievalReasons(impact: FettlerEndpointImpactResult): string[] {
  return [...new Set([
    ...impact.coverage.reasons,
    ...(impact.coverage.truncated ? ["query_truncated"] : []),
  ])].sort(compareCodeUnits);
}

function unknownEmptyReport(
  report: ImpactReport,
  reasons: string[],
): ImpactReport {
  const priorGaps = report.coverage?.gaps ?? [];
  const fallbackGap = {
    reason: "query_truncated" as const,
    detail: `Graph coverage was insufficient (${reasons.join(", ")}); an empty bounded raw retrieval is no known impact, not verified clean.`,
  };
  return {
    ...report,
    overallConfidence: "unknown",
    coverage: {
      ...(report.coverage ?? { gaps: [] }),
      basis: "partial",
      reason: fallbackGap.detail,
      gaps: priorGaps.some((gap) => gap.reason === "query_truncated")
        ? priorGaps
        : [...priorGaps, fallbackGap],
    },
  };
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
  const graphComplete = input.graphImpact.coverage.basis === "complete" &&
    !input.graphImpact.coverage.truncated;
  if (graphComplete) {
    return Object.freeze({
      decision: decision({
        outcome: "not_required",
        reasonCodes: [],
        graphVersionId: input.graphImpact.graphVersionId,
        graphContentDigest: input.graphImpact.graphContentDigest,
        graphResultDigest: input.graphImpact.resultDigest,
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

  const reasons = retrievalReasons(input.graphImpact);
  const candidatesInspected = input.rawReport.candidateCount;
  const exceeded =
    !Number.isSafeInteger(input.retrieval.maxFiles) || input.retrieval.maxFiles < 1 ||
    !Number.isSafeInteger(input.retrieval.maxBytes) || input.retrieval.maxBytes < 1 ||
    !Number.isSafeInteger(input.retrieval.maxCandidates) || input.retrieval.maxCandidates < 1 ||
    !Number.isSafeInteger(input.retrieval.filesInspected) || input.retrieval.filesInspected < 0 ||
    !Number.isSafeInteger(input.retrieval.bytesInspected) || input.retrieval.bytesInspected < 0 ||
    input.retrieval.filesInspected > input.retrieval.maxFiles ||
    input.retrieval.bytesInspected > input.retrieval.maxBytes ||
    candidatesInspected > input.retrieval.maxCandidates;
  if (exceeded) {
    return Object.freeze({
      decision: decision({
        outcome: "abstained",
        reasonCodes: reasons,
        graphVersionId: input.graphImpact.graphVersionId,
        graphContentDigest: input.graphImpact.graphContentDigest,
        graphResultDigest: input.graphImpact.resultDigest,
        retrieval: { ...input.retrieval, candidatesInspected },
        candidateDigests: [],
        failureCode: "raw_retrieval_candidate_budget_exceeded",
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
  const impactReport = input.rawReport.sites.length === 0
    ? unknownEmptyReport(input.rawReport, reasons)
    : input.rawReport;
  return Object.freeze({
    decision: decision({
      outcome: "completed",
      reasonCodes: reasons,
      graphVersionId: input.graphImpact.graphVersionId,
      graphContentDigest: input.graphImpact.graphContentDigest,
      graphResultDigest: input.graphImpact.resultDigest,
      retrieval: { ...input.retrieval, candidatesInspected },
      candidateDigests: relationshipCandidates.map((candidate) => candidate.candidateDigest),
    }),
    impactReport,
    relationshipCandidates,
  });
}
