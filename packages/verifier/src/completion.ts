import { createVerifierEvidencePack } from "./evidence.js";
import { criteriaForProduct } from "./policy.js";
import type { VerifierEvidencePack, VerifierGovernanceInput, VerifierProduct, VerifierRisk } from "./types.js";
import { boundedText, canonicalJson, codeUnitCompare, exactDigest, fail, identifier, sha256, sortedUnique } from "./utils.js";

export function createCompletionVerifierEvidencePack(input: Readonly<{
  tenantId: string;
  missionId: string;
  taskId: string;
  product: VerifierProduct;
  repositoryId: string;
  snapshotDigest: string;
  objective: string;
  risk: VerifierRisk;
  governance: VerifierGovernanceInput;
  governanceEvidenceRef: string;
  allowedChangedPaths: readonly string[];
  candidateId: string;
  candidateDigest: string;
  changedPaths: readonly string[];
  observableSummary: string;
  deterministicEvidenceDigest: string;
  deterministicEvidenceRefs: readonly string[];
  assembledAt: string;
  assemblerVersion: string;
}>): VerifierEvidencePack {
  const allowed = sortedUnique(input.allowedChangedPaths, "verifier_completion_allowed_paths_invalid", 10_000);
  const changed = sortedUnique(input.changedPaths, "verifier_completion_changed_paths_invalid", 10_000);
  const allowedSet = new Set(allowed);
  if (changed.some((path) => !allowedSet.has(path))) fail("verifier_completion_path_outside_scope");
  const evidenceRefs = sortedUnique(input.deterministicEvidenceRefs, "verifier_completion_evidence_invalid", 128);
  if (!evidenceRefs.length) fail("verifier_completion_evidence_invalid");
  const governanceEvidenceRef = boundedText(input.governanceEvidenceRef, "verifier_completion_governance_evidence_invalid", 1024);
  const completionEvidence = canonicalJson({
    candidateDigest: exactDigest(input.candidateDigest, "verifier_completion_candidate_digest_invalid"),
    changedPaths: changed,
    evidenceRefs,
    summary: boundedText(input.observableSummary, "verifier_completion_summary_invalid", 32_000),
  });
  return createVerifierEvidencePack({
    schemaVersion: "2026-08-17.v1",
    tenantId: identifier(input.tenantId, "verifier_tenant_id_invalid"),
    missionId: identifier(input.missionId, "verifier_mission_id_invalid"),
    taskId: identifier(input.taskId, "verifier_task_id_invalid"),
    product: input.product,
    repositoryId: identifier(input.repositoryId, "verifier_repository_id_invalid"),
    snapshotDigest: exactDigest(input.snapshotDigest, "verifier_snapshot_digest_invalid"),
    objective: boundedText(input.objective, "verifier_objective_invalid", 4096),
    risk: input.risk,
    governance: structuredClone(input.governance),
    allowedChangedPaths: [...allowed],
    criteria: criteriaForProduct(input.product).map((criterion) => ({ ...criterion })),
    sources: [
      { id: "deterministic_completion", kind: "verification", digest: exactDigest(input.deterministicEvidenceDigest, "verifier_completion_evidence_digest_invalid"), locator: evidenceRefs.join(","), content: completionEvidence },
      { id: "external_verifier_authority", kind: "owner", digest: sha256(governanceEvidenceRef), locator: governanceEvidenceRef, content: `External verifier authority: ${governanceEvidenceRef}` },
    ],
    checks: [{ id: "deterministic_completion", status: "passed", evidenceRefs: [...evidenceRefs], candidateIds: null }],
    candidates: [{
      candidateId: identifier(input.candidateId, "verifier_candidate_id_invalid"),
      artifactDigest: exactDigest(input.candidateDigest, "verifier_completion_candidate_digest_invalid"),
      kind: "completion",
      observableOutput: completionEvidence,
      changedPaths: [...changed],
      evidenceRefs: ["deterministic_completion", "external_verifier_authority", ...evidenceRefs].sort(codeUnitCompare),
      deterministicCheckIds: ["deterministic_completion"],
      hardCriterionResults: [],
    }],
    assembledAt: input.assembledAt,
    assemblerVersion: input.assemblerVersion,
  });
}
