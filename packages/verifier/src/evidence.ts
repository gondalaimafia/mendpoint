import { redactSourceForModel } from "@mendpoint/shared";
import type {
  VerifierCandidate,
  VerifierEvidencePack,
  VerifierEvidencePackInput,
} from "./types.js";
import {
  boundedText,
  canonicalJson,
  codeUnitCompare,
  deepFreeze,
  exactDigest,
  exactIso,
  exactKeys,
  fail,
  identifier,
  rejectPrivateReasoning,
  sha256,
  sortedUnique,
} from "./utils.js";

const MAX_PACK_BYTES = 256 * 1024;
const MAX_SOURCE_CHARS = 16_384;
const MAX_CANDIDATE_CHARS = 64_000;

function normalizePath(value: string): string {
  const path = boundedText(value, "verifier_path_invalid", 1024).replace(/\\/g, "/");
  if (path.startsWith("/") || path.includes("//") || path.split("/").some((part) => part === "." || part === "..")) {
    fail("verifier_path_invalid");
  }
  return path;
}

function exactMember<T extends string>(value: unknown, allowed: readonly T[], code: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(code);
  return value as T;
}

export function createVerifierEvidencePack(raw: VerifierEvidencePackInput): VerifierEvidencePack {
  rejectPrivateReasoning(raw);
  const input = recordInput(raw);
  if (input.schemaVersion !== "2026-08-17.v1") fail("verifier_schema_version_invalid");
  const governance = input.governance;
  if (!governance.externalModelAllowed || !governance.mayLeaveTenantBoundary) {
    fail("verifier_governance_external_model_denied");
  }
  if (!governance.consentActive || !governance.consentId) fail("verifier_governance_consent_inactive");
  if (governance.requiredRegion !== governance.processingRegion) fail("verifier_governance_region_mismatch");

  const allowedChangedPaths = [...new Set(input.allowedChangedPaths.map(normalizePath))].sort(codeUnitCompare);
  if (!allowedChangedPaths.length || allowedChangedPaths.length !== input.allowedChangedPaths.length) {
    fail("verifier_allowed_paths_invalid");
  }

  if (!input.criteria.length || input.criteria.length > 32) fail("verifier_criteria_invalid");
  const criteria = input.criteria.map((criterion) => {
    exactKeys(criterion as unknown as Record<string, unknown>, ["id", "title", "description", "hard", "weight"], "verifier_criterion_fields_invalid");
    if (typeof criterion.hard !== "boolean" || !Number.isFinite(criterion.weight) || criterion.weight <= 0 || criterion.weight > 100) {
      fail("verifier_criterion_invalid");
    }
    return {
      id: identifier(criterion.id, "verifier_criterion_id_invalid"),
      title: boundedText(criterion.title, "verifier_criterion_title_invalid", 128),
      description: boundedText(criterion.description, "verifier_criterion_description_invalid", 2048),
      hard: criterion.hard,
      weight: criterion.weight,
    };
  }).sort((left, right) => codeUnitCompare(left.id, right.id));
  if (new Set(criteria.map(({ id }) => id)).size !== criteria.length) fail("verifier_criterion_duplicate");
  const criterionIds = new Set(criteria.map(({ id }) => id));

  if (!input.sources.length || input.sources.length > 128) fail("verifier_sources_invalid");
  const sources = input.sources.map((source) => {
    const redaction = redactSourceForModel(source.content, MAX_SOURCE_CHARS);
    if (redaction.excluded) fail("verifier_evidence_source_excluded");
    return {
      id: identifier(source.id, "verifier_source_id_invalid"),
      kind: exactMember(source.kind, ["repository_excerpt", "graph", "retrieval", "verification", "owner", "human"] as const, "verifier_source_kind_invalid"),
      digest: exactDigest(source.digest, "verifier_source_digest_invalid"),
      locator: boundedText(source.locator, "verifier_source_locator_invalid", 1024),
      content: redaction.text,
      contentDigest: sha256(redaction.text),
    };
  }).sort((left, right) => codeUnitCompare(left.id, right.id));
  if (new Set(sources.map(({ id }) => id)).size !== sources.length) fail("verifier_source_duplicate");

  if (!input.checks.length || input.checks.length > 128) fail("verifier_checks_invalid");
  const checks = input.checks.map((check) => {
    exactKeys(check as unknown as Record<string, unknown>, ["id", "status", "evidenceRefs", "candidateIds"], "verifier_check_fields_invalid");
    return {
      id: identifier(check.id, "verifier_check_id_invalid"),
      status: exactMember(check.status, ["passed", "failed", "incomplete"] as const, "verifier_check_status_invalid"),
      evidenceRefs: sortedUnique(check.evidenceRefs, "verifier_check_evidence_invalid", 64),
      candidateIds: check.candidateIds === null
        ? null
        : sortedUnique(check.candidateIds, "verifier_check_candidates_invalid", 20),
    };
  }).sort((left, right) => codeUnitCompare(left.id, right.id));
  if (new Set(checks.map(({ id }) => id)).size !== checks.length) fail("verifier_check_duplicate");
  const checkIds = new Set(checks.map(({ id }) => id));

  if (!input.candidates.length || input.candidates.length > 20) fail("verifier_candidates_invalid");
  const candidates = input.candidates.map((candidate) => {
    const output = redactSourceForModel(candidate.observableOutput, MAX_CANDIDATE_CHARS);
    if (output.excluded) fail("verifier_candidate_output_excluded");
    const deterministicCheckIds = sortedUnique(candidate.deterministicCheckIds, "verifier_candidate_checks_invalid", 128);
    if (!deterministicCheckIds.length || deterministicCheckIds.some((id) => !checkIds.has(id))) fail("verifier_candidate_check_unknown");
    const hardCriterionResults = candidate.hardCriterionResults.map((result) => ({
      criterionId: identifier(result.criterionId, "verifier_candidate_criterion_invalid"),
      status: exactMember(result.status, ["passed", "failed", "incomplete"] as const, "verifier_candidate_criterion_status_invalid"),
      evidenceRefs: sortedUnique(result.evidenceRefs, "verifier_candidate_criterion_evidence_invalid", 64),
    })).sort((left, right) => codeUnitCompare(left.criterionId, right.criterionId));
    if (new Set(hardCriterionResults.map(({ criterionId }) => criterionId)).size !== hardCriterionResults.length ||
      hardCriterionResults.some(({ criterionId }) => !criterionIds.has(criterionId))) {
      fail("verifier_candidate_criterion_unknown");
    }
    return {
      candidateId: identifier(candidate.candidateId, "verifier_candidate_id_invalid"),
      artifactDigest: exactDigest(candidate.artifactDigest, "verifier_candidate_digest_invalid"),
      kind: exactMember(candidate.kind, ["plan", "patch", "completion"] as const, "verifier_candidate_kind_invalid"),
      observableOutput: output.text,
      changedPaths: Object.freeze([...new Set(candidate.changedPaths.map(normalizePath))].sort(codeUnitCompare)),
      evidenceRefs: sortedUnique(candidate.evidenceRefs, "verifier_candidate_evidence_invalid", 128),
      deterministicCheckIds,
      hardCriterionResults: Object.freeze(hardCriterionResults),
    } satisfies VerifierCandidate;
  }).sort((left, right) => codeUnitCompare(left.candidateId, right.candidateId));
  if (new Set(candidates.map(({ candidateId }) => candidateId)).size !== candidates.length) fail("verifier_candidate_duplicate");
  const candidateIds = new Set(candidates.map(({ candidateId }) => candidateId));
  if (checks.some((check) => check.candidateIds !== null &&
    (!check.candidateIds.length || check.candidateIds.some((candidateId) => !candidateIds.has(candidateId))))) {
    fail("verifier_check_candidate_unknown");
  }

  const base = {
    schemaVersion: "2026-08-17.v1" as const,
    tenantId: identifier(input.tenantId, "verifier_tenant_id_invalid"),
    missionId: identifier(input.missionId, "verifier_mission_id_invalid"),
    taskId: identifier(input.taskId, "verifier_task_id_invalid"),
    product: exactMember(input.product, ["fettler", "regauge"] as const, "verifier_product_invalid"),
    repositoryId: identifier(input.repositoryId, "verifier_repository_id_invalid"),
    snapshotDigest: exactDigest(input.snapshotDigest, "verifier_snapshot_digest_invalid"),
    objective: boundedText(input.objective, "verifier_objective_invalid", 4096),
    risk: exactMember(input.risk, ["low", "medium", "high", "critical"] as const, "verifier_risk_invalid"),
    governance: {
      dataClassification: exactMember(governance.dataClassification, ["public", "internal", "confidential", "restricted"] as const, "verifier_governance_classification_invalid"),
      requiredRegion: identifier(governance.requiredRegion, "verifier_governance_region_invalid"),
      processingRegion: identifier(governance.processingRegion, "verifier_governance_region_invalid"),
      externalModelAllowed: governance.externalModelAllowed,
      mayLeaveTenantBoundary: governance.mayLeaveTenantBoundary,
      consentId: identifier(governance.consentId, "verifier_governance_consent_invalid"),
      consentActive: governance.consentActive,
    },
    allowedChangedPaths: Object.freeze(allowedChangedPaths),
    criteria: Object.freeze(criteria),
    sources: Object.freeze(sources),
    checks: Object.freeze(checks),
    candidates: Object.freeze(candidates),
    assembledAt: exactIso(input.assembledAt, "verifier_assembled_at_invalid"),
    assemblerVersion: boundedText(input.assemblerVersion, "verifier_assembler_version_invalid", 128),
  };
  const canonical = canonicalJson(base);
  if (Buffer.byteLength(canonical, "utf8") > MAX_PACK_BYTES) fail("verifier_evidence_pack_too_large");
  return deepFreeze({ ...base, packDigest: sha256(canonical) });
}

export function verifyVerifierEvidencePack(raw: VerifierEvidencePack): VerifierEvidencePack {
  exactKeys(raw as unknown as Record<string, unknown>, [
    "schemaVersion", "tenantId", "missionId", "taskId", "product", "repositoryId", "snapshotDigest",
    "objective", "risk", "governance", "allowedChangedPaths", "criteria", "sources", "checks",
    "candidates", "assembledAt", "assemblerVersion", "packDigest",
  ], "verifier_evidence_pack_fields_invalid");
  const claimedDigest = exactDigest(raw.packDigest, "verifier_evidence_pack_digest_invalid");
  const verified = createVerifierEvidencePack({
    schemaVersion: raw.schemaVersion,
    tenantId: raw.tenantId,
    missionId: raw.missionId,
    taskId: raw.taskId,
    product: raw.product,
    repositoryId: raw.repositoryId,
    snapshotDigest: raw.snapshotDigest,
    objective: raw.objective,
    risk: raw.risk,
    governance: structuredClone(raw.governance),
    allowedChangedPaths: [...raw.allowedChangedPaths],
    criteria: raw.criteria.map((criterion) => ({ ...criterion })),
    sources: raw.sources.map(({ contentDigest: _contentDigest, ...source }) => ({ ...source })),
    checks: raw.checks.map((check) => ({
      ...check,
      evidenceRefs: [...check.evidenceRefs],
      candidateIds: check.candidateIds === null ? null : [...check.candidateIds],
    })),
    candidates: raw.candidates.map((candidate) => ({
      ...candidate,
      changedPaths: [...candidate.changedPaths],
      evidenceRefs: [...candidate.evidenceRefs],
      deterministicCheckIds: [...candidate.deterministicCheckIds],
      hardCriterionResults: candidate.hardCriterionResults.map((result) => ({
        ...result,
        evidenceRefs: [...result.evidenceRefs],
      })),
    })),
    assembledAt: raw.assembledAt,
    assemblerVersion: raw.assemblerVersion,
  });
  if (verified.packDigest !== claimedDigest) fail("verifier_evidence_pack_digest_mismatch");
  return verified;
}

function recordInput(raw: VerifierEvidencePackInput): VerifierEvidencePackInput {
  exactKeys(raw as unknown as Record<string, unknown>, [
    "schemaVersion", "tenantId", "missionId", "taskId", "product", "repositoryId", "snapshotDigest",
    "objective", "risk", "governance", "allowedChangedPaths", "criteria", "sources", "checks",
    "candidates", "assembledAt", "assemblerVersion",
  ], "verifier_evidence_fields_invalid");
  return structuredClone(raw);
}

export type DeterministicFilterResult = Readonly<{
  eligible: readonly VerifierCandidate[];
  rejected: readonly Readonly<{ candidateId: string; reasons: readonly string[] }>[];
}>;

export function filterDeterministicCandidates(pack: VerifierEvidencePack): DeterministicFilterResult {
  const allowed = new Set(pack.allowedChangedPaths);
  const checks = new Map(pack.checks.map((check) => [check.id, check]));
  const hardCriteria = new Set(pack.criteria.filter((criterion) => criterion.hard).map((criterion) => criterion.id));
  const eligible: VerifierCandidate[] = [];
  const rejected: Array<{ candidateId: string; reasons: readonly string[] }> = [];
  for (const candidate of pack.candidates) {
    const reasons = new Set<string>();
    for (const check of pack.checks) {
      if (check.candidateIds !== null && !check.candidateIds.includes(candidate.candidateId)) continue;
      if (check.status === "failed") reasons.add("deterministic_check_failed");
      if (check.status === "incomplete") reasons.add("deterministic_check_incomplete");
    }
    if (candidate.changedPaths.some((path) => !allowed.has(path))) reasons.add("changed_path_outside_scope");
    for (const checkId of candidate.deterministicCheckIds) {
      const status = checks.get(checkId)?.status;
      if (status === "failed") reasons.add("deterministic_check_failed");
      if (status === "incomplete" || status === undefined) reasons.add("deterministic_check_incomplete");
    }
    const results = new Map(candidate.hardCriterionResults.map((result) => [result.criterionId, result.status]));
    for (const criterionId of hardCriteria) {
      const status = results.get(criterionId);
      if (status === "failed") reasons.add("hard_criterion_failed");
      if (status === "incomplete" || status === undefined) reasons.add("hard_criterion_incomplete");
    }
    if (reasons.size) rejected.push({ candidateId: candidate.candidateId, reasons: Object.freeze([...reasons].sort(codeUnitCompare)) });
    else eligible.push(candidate);
  }
  return deepFreeze({ eligible, rejected });
}
