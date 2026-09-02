import { createHash } from "node:crypto";
import type { LearningCase } from "./schema.js";
import {
  revalidateSignedAuthorityContext,
  signedAuthorityEnvelopeDigest,
  verifySignedAuthorityEnvelope,
  type SignedAuthorityEnvelope,
  type VerifiedAuthorityContext,
} from "./authority.js";
import {
  requireVerifiedProductionLearningAuthority,
  type VerifiedProductionLearningAuthority,
} from "./preflight.js";

export interface RequirementRecord {
  id: string;
  title: string;
  implementationStatus: string;
  claimState: string;
  acceptance: Array<{ id: string; assertion: string; evidence: Array<{ id: string; type: string; locator: string }> }>;
  externalBlockers: unknown;
}

export interface ClosureRow {
  requirementId: string;
  status: { implementationStatus: string; availability: string; claimState: string };
  issues: number[];
  pullRequests: number[];
  testEvidenceIds: string[];
  productionEvidenceIds: string[];
}

export interface RequirementRegister {
  requirements: RequirementRecord[];
  additionalRegisterSets?: Array<{ key: string; requirements: RequirementRecord[] }>;
}

export interface RequirementCaseTrace {
  requirementId: string;
  requirementTitle: string;
  registerStatus: string;
  registerClaimState: string;
  planningState: "planned" | "unplanned";
  planningGapReason: string | null;
  plannedCaseIds: string[];
  plannedOracleIds: string[];
  verificationState: "verified" | "unverified";
  verificationGapReason: string | null;
  receiptEvidenceState: "absent" | "rejected" | "verified" | "mixed";
  executionReceiptIds: string[];
  rejectedExecutionReceipts: Array<{
    receiptId: string;
    authorityEnvelopeDigest: string | null;
    reason: string;
  }>;
  verifiedCaseIds: string[];
  verifiedOracleEvidenceIds: string[];
  registerEvidenceRefs: string[];
  closureIssueRefs: string[];
  closurePullRequestRefs: string[];
  closureTestEvidenceIds: string[];
  closureProductionEvidenceIds: string[];
  verifiedProductionEvidenceIds: string[];
  productionEvidenceState: "verified" | "unknown";
  externalBlockers: unknown;
}

export interface CaseExecutionReceipt {
  id: string;
  caseId: string;
  requirementIds: string[];
  oracleEvidence: Array<{ oracleId: string; evidenceId: string }>;
  productionEvidenceIds: string[];
  admissionState: "admitted" | "blocked";
  executionState: "planned" | "completed" | "failed";
}

export interface CaseExecutionEvidenceAuthorityPayload {
  schemaVersion: "mendpoint.case-execution-evidence-authority.v1";
  productionRevision: string;
  receiptId: string;
  caseId: string;
  product: LearningCase["product"];
  tenantId: string;
  repositoryId: string;
  repositoryCommit: string;
  snapshotDigest: string;
  fixtureManifestDigest: string;
  fixtureManifestId: string;
  oracleEvidence: Array<{ oracleId: string; evidenceId: string }>;
  executionDigest: string;
  productionReceiptAuthorityDigest: string;
  requirementIds: string[];
  productionEvidenceIds: string[];
  admissionState: "admitted";
  executionState: "completed";
}

const VERIFIED_CASE_EXECUTION_RECEIPT: unique symbol = Symbol("verified-case-execution-receipt");
export type VerifiedCaseExecutionReceipt = Readonly<CaseExecutionReceipt> & {
  readonly authorityEnvelopeDigest: string;
  readonly [VERIFIED_CASE_EXECUTION_RECEIPT]: true;
};
const verifiedCaseExecutionReceipts = new WeakSet<object>();
const caseExecutionReceiptContexts = new WeakMap<object, VerifiedAuthorityContext>();
const caseExecutionProductionAuthorities = new WeakMap<object, VerifiedProductionLearningAuthority>();
interface CaseExecutionReceiptBinding {
  caseCatalogDigest: string;
  tenantId: string;
  repositoryId: string;
  repositoryCommit: string;
  snapshotDigest: string;
  fixtureManifestDigest: string;
  executionDigest: string;
}
const caseExecutionReceiptBindings = new WeakMap<object, Readonly<CaseExecutionReceiptBinding>>();

function caseCatalogBindingDigest(learningCase: LearningCase): string {
  return createHash("sha256").update(JSON.stringify(learningCase)).digest("hex");
}

function validateEvidenceIds(values: readonly string[], field: string, errors: string[]): void {
  if (values.length === 0) errors.push(`${field} must be non-empty`);
  if (new Set(values).size !== values.length) errors.push(`${field} must be unique`);
  if (values.some((value) => value.trim().length === 0)) errors.push(`${field} must not contain empty values`);
}

export function verifyCaseExecutionReceipt(
  envelope: SignedAuthorityEnvelope<CaseExecutionEvidenceAuthorityPayload>,
  productionAuthority: VerifiedProductionLearningAuthority,
  learningCase: LearningCase,
): VerifiedCaseExecutionReceipt {
  const verifiedEnvelope = verifySignedAuthorityEnvelope(envelope, "case_execution_evidence");
  const authority = requireVerifiedProductionLearningAuthority(productionAuthority);
  const payload = verifiedEnvelope.payload;
  const errors: string[] = [];
  const sha256 = /^[0-9a-f]{64}$/;
  const gitSha = /^[0-9a-f]{40}$/;
  if (payload.schemaVersion !== "mendpoint.case-execution-evidence-authority.v1") errors.push("evidence authority schema is invalid");
  if (!gitSha.test(payload.productionRevision) || !gitSha.test(payload.repositoryCommit)) errors.push("evidence revisions must be git shas");
  for (const [field, value] of [
    ["snapshotDigest", payload.snapshotDigest],
    ["fixtureManifestDigest", payload.fixtureManifestDigest],
    ["executionDigest", payload.executionDigest],
    ["productionReceiptAuthorityDigest", payload.productionReceiptAuthorityDigest],
  ] as const) if (!sha256.test(value)) errors.push(`evidence ${field} must be sha256`);
  for (const [field, value] of [
    ["receiptId", payload.receiptId],
    ["caseId", payload.caseId],
    ["tenantId", payload.tenantId],
    ["repositoryId", payload.repositoryId],
    ["fixtureManifestId", payload.fixtureManifestId],
  ] as const) if (value.trim().length === 0) errors.push(`evidence ${field} must be non-empty`);
  validateEvidenceIds(payload.requirementIds, "evidence requirementIds", errors);
  validateEvidenceIds(payload.oracleEvidence.map((item) => item.oracleId), "evidence oracleIds", errors);
  validateEvidenceIds(payload.oracleEvidence.map((item) => item.evidenceId), "evidence oracleEvidenceIds", errors);
  validateEvidenceIds(payload.productionEvidenceIds, "evidence productionEvidenceIds", errors);
  if (payload.admissionState !== "admitted" || payload.executionState !== "completed") {
    errors.push("evidence receipt must be admitted and completed");
  }
  const productionBindings: Array<[string, unknown, unknown]> = [
    ["productionRevision", payload.productionRevision, authority.productionRevision],
    ["caseId", payload.caseId, authority.caseId],
    ["product", payload.product, authority.product],
    ["tenantId", payload.tenantId, authority.tenantId],
    ["repositoryId", payload.repositoryId, authority.repositoryId],
    ["repositoryCommit", payload.repositoryCommit, authority.repositoryCommit],
    ["snapshotDigest", payload.snapshotDigest, authority.snapshotDigest],
    ["fixtureManifestDigest", payload.fixtureManifestDigest, authority.fixtureManifestDigest],
    ["executionDigest", payload.executionDigest, authority.executionDigest],
    ["productionReceiptAuthorityDigest", payload.productionReceiptAuthorityDigest, authority.authorityEnvelopeDigest],
  ];
  for (const [field, actual, expected] of productionBindings) {
    if (actual !== expected) errors.push(`evidence ${field} must match trusted production authority`);
  }
  if (payload.caseId !== learningCase.id || payload.product !== learningCase.product) {
    errors.push("evidence case identity must match the learning case");
  }
  if (payload.repositoryId !== learningCase.repository.provenanceId) {
    errors.push("evidence repositoryId must match the learning case");
  }
  if (payload.fixtureManifestId !== learningCase.fixture.manifestId) {
    errors.push("evidence fixtureManifestId must match the learning case");
  }
  for (const requirementId of payload.requirementIds) {
    if (!learningCase.planning.requirementIds.includes(requirementId)) errors.push(`evidence requirement is not planned by the learning case: ${requirementId}`);
  }
  for (const { oracleId } of payload.oracleEvidence) {
    if (!learningCase.expected.oracleIds.includes(oracleId)) errors.push(`evidence oracle is not declared by the learning case: ${oracleId}`);
  }
  if (errors.length > 0) throw new Error(`case_execution_evidence_invalid:${errors.join("|")}`);
  const token = Object.freeze({
    id: payload.receiptId,
    caseId: payload.caseId,
    requirementIds: Object.freeze([...payload.requirementIds]),
    oracleEvidence: Object.freeze(payload.oracleEvidence.map((item) => Object.freeze({ ...item }))),
    productionEvidenceIds: Object.freeze([...payload.productionEvidenceIds]),
    admissionState: payload.admissionState,
    executionState: payload.executionState,
    authorityEnvelopeDigest: signedAuthorityEnvelopeDigest(envelope),
    [VERIFIED_CASE_EXECUTION_RECEIPT]: true,
  }) as VerifiedCaseExecutionReceipt;
  verifiedCaseExecutionReceipts.add(token);
  caseExecutionReceiptContexts.set(token, verifiedEnvelope.context);
  caseExecutionProductionAuthorities.set(token, authority);
  caseExecutionReceiptBindings.set(token, Object.freeze({
    caseCatalogDigest: caseCatalogBindingDigest(learningCase),
    tenantId: payload.tenantId,
    repositoryId: payload.repositoryId,
    repositoryCommit: payload.repositoryCommit,
    snapshotDigest: payload.snapshotDigest,
    fixtureManifestDigest: payload.fixtureManifestDigest,
    executionDigest: payload.executionDigest,
  }));
  return token;
}

export function requireVerifiedCaseExecutionReceipt(
  receipt: VerifiedCaseExecutionReceipt,
  learningCase?: LearningCase,
): VerifiedCaseExecutionReceipt {
  if (!verifiedCaseExecutionReceipts.has(receipt)) throw new Error("case_execution_receipt_not_verified");
  const context = caseExecutionReceiptContexts.get(receipt);
  const authority = caseExecutionProductionAuthorities.get(receipt);
  if (context === undefined || authority === undefined) throw new Error("case_execution_receipt_context_missing");
  revalidateSignedAuthorityContext(context);
  requireVerifiedProductionLearningAuthority(authority);
  const binding = caseExecutionReceiptBindings.get(receipt);
  if (binding === undefined) throw new Error("case_execution_receipt_binding_missing");
  if (learningCase !== undefined && binding.caseCatalogDigest !== caseCatalogBindingDigest(learningCase)) {
    throw new Error("case_execution_receipt_case_catalog_mismatch");
  }
  return receipt;
}

export function flattenRequirementRegister(register: RequirementRegister): RequirementRecord[] {
  return [
    ...register.requirements,
    ...(register.additionalRegisterSets ?? []).flatMap((set) => set.requirements),
  ];
}

export function buildRequirementCaseTraceability(input: {
  requirements: readonly RequirementRecord[];
  closureRows: readonly ClosureRow[];
  cases: readonly LearningCase[];
  executionReceipts?: readonly VerifiedCaseExecutionReceipt[];
}): RequirementCaseTrace[] {
  const closureByRequirement = new Map(input.closureRows.map((row) => [row.requirementId, row]));
  const receiptEvaluations = (input.executionReceipts ?? []).map((receipt) => {
    try {
      const learningCase = input.cases.find((item) => item.id === receipt.caseId);
      if (learningCase === undefined) throw new Error("case_execution_receipt_case_not_found");
      requireVerifiedCaseExecutionReceipt(receipt, learningCase);
      if (
        receipt.admissionState !== "admitted"
        || receipt.executionState !== "completed"
        || receipt.oracleEvidence.length === 0
      ) throw new Error("case_execution_receipt_state_invalid");
      return { receipt, rejection: null };
    } catch (error) {
      return {
        receipt,
        rejection: {
          receiptId: receipt.id,
          authorityEnvelopeDigest: verifiedCaseExecutionReceipts.has(receipt) ? receipt.authorityEnvelopeDigest : null,
          reason: error instanceof Error ? error.message.split(":", 1)[0]! : "case_execution_receipt_verification_failed",
        },
      };
    }
  });
  const admittedExecutionReceipts = receiptEvaluations.filter((item) => item.rejection === null).map((item) => item.receipt);
  return [...input.requirements].sort((a, b) => a.id.localeCompare(b.id)).map((requirement) => {
    const closure = closureByRequirement.get(requirement.id);
    const plannedCases = input.cases.filter((item) => item.planning.requirementIds.includes(requirement.id));
    const verifiedReceipts = admittedExecutionReceipts.filter((receipt) =>
      receipt.requirementIds.includes(requirement.id)
      && plannedCases.some((item) => item.id === receipt.caseId),
    );
    const rejectedExecutionReceipts = receiptEvaluations
      .filter((item) => item.rejection !== null && item.receipt.requirementIds.includes(requirement.id))
      .map((item) => item.rejection!);
    const planningState = plannedCases.length > 0 ? "planned" : "unplanned";
    const verificationState = verifiedReceipts.length > 0 ? "verified" : "unverified";
    const receiptEvidenceState = verifiedReceipts.length > 0
      ? (rejectedExecutionReceipts.length > 0 ? "mixed" : "verified")
      : (rejectedExecutionReceipts.length > 0 ? "rejected" : "absent");
    const verifiedProductionEvidenceIds = [...new Set(verifiedReceipts.flatMap((receipt) => receipt.productionEvidenceIds))];
    return {
      requirementId: requirement.id,
      requirementTitle: requirement.title,
      registerStatus: requirement.implementationStatus,
      registerClaimState: requirement.claimState,
      planningState,
      planningGapReason: planningState === "planned" ? null : "No production-learning case declares a planned binding to this requirement in the current slice.",
      plannedCaseIds: plannedCases.map((item) => item.id),
      plannedOracleIds: [...new Set(plannedCases.filter((item) => item.datasetSplit === "development").flatMap((item) => item.expected.oracleIds))],
      verificationState,
      verificationGapReason: verificationState === "verified"
        ? null
        : rejectedExecutionReceipts.length > 0
          ? "Execution receipt evidence was present but rejected or revoked; see rejectedExecutionReceipts."
          : "No protected-verifier-authenticated completed execution receipt verifies this requirement.",
      receiptEvidenceState,
      executionReceiptIds: verifiedReceipts.map((receipt) => receipt.id),
      rejectedExecutionReceipts,
      verifiedCaseIds: [...new Set(verifiedReceipts.map((receipt) => receipt.caseId))],
      verifiedOracleEvidenceIds: [...new Set(verifiedReceipts.flatMap((receipt) => receipt.oracleEvidence.map((item) => item.evidenceId)))],
      registerEvidenceRefs: requirement.acceptance.flatMap((acceptance) => acceptance.evidence.map((evidence) => evidence.locator)),
      closureIssueRefs: (closure?.issues ?? []).map((issue) => `https://github.com/gondalaimafia/mendpoint/issues/${issue}`),
      closurePullRequestRefs: (closure?.pullRequests ?? []).map((pr) => `https://github.com/gondalaimafia/mendpoint/pull/${pr}`),
      closureTestEvidenceIds: closure?.testEvidenceIds ?? [],
      closureProductionEvidenceIds: closure?.productionEvidenceIds ?? [],
      verifiedProductionEvidenceIds,
      productionEvidenceState: verifiedProductionEvidenceIds.length > 0 ? "verified" : "unknown",
      externalBlockers: requirement.externalBlockers,
    };
  });
}

export function validateRequirementCaseTraceability(input: {
  traces: readonly RequirementCaseTrace[];
  expectedRequirementIds: readonly string[];
  expectedCaseIds: readonly string[];
}): string[] {
  const errors: string[] = [];
  const traceIds = input.traces.map((trace) => trace.requirementId);
  for (const id of input.expectedRequirementIds) {
    if (!traceIds.includes(id)) errors.push(`missing requirement trace: ${id}`);
  }
  for (const id of traceIds) {
    if (!input.expectedRequirementIds.includes(id)) errors.push(`unknown requirement trace: ${id}`);
  }
  const knownCases = new Set(input.expectedCaseIds);
  for (const trace of input.traces) {
    if (trace.planningState === "planned" && trace.plannedCaseIds.length === 0) errors.push(`${trace.requirementId} planned trace must bind at least one case`);
    if (trace.planningState === "planned" && trace.plannedOracleIds.length === 0) errors.push(`${trace.requirementId} planned trace must bind at least one planned oracle`);
    if (trace.planningState === "unplanned" && (trace.plannedCaseIds.length > 0 || trace.plannedOracleIds.length > 0 || trace.planningGapReason === null)) {
      errors.push(`${trace.requirementId} unplanned trace must retain an explicit gap without case or oracle plans`);
    }
    for (const caseId of [...trace.plannedCaseIds, ...trace.verifiedCaseIds]) {
      if (!knownCases.has(caseId)) errors.push(`${trace.requirementId} references unknown case: ${caseId}`);
    }
    if (trace.verificationState === "verified" && (trace.executionReceiptIds.length === 0 || trace.verifiedCaseIds.length === 0 || trace.verifiedOracleEvidenceIds.length === 0)) {
      errors.push(`${trace.requirementId} cannot claim verified coverage without admitted execution, case, and oracle evidence ids`);
    }
    if (trace.verificationState === "unverified" && (trace.executionReceiptIds.length > 0 || trace.verifiedCaseIds.length > 0 || trace.verifiedOracleEvidenceIds.length > 0 || trace.verifiedProductionEvidenceIds.length > 0 || trace.verificationGapReason === null)) {
      errors.push(`${trace.requirementId} unverified trace must not retain verified execution claims`);
    }
    const expectedReceiptEvidenceState = trace.executionReceiptIds.length > 0
      ? (trace.rejectedExecutionReceipts.length > 0 ? "mixed" : "verified")
      : (trace.rejectedExecutionReceipts.length > 0 ? "rejected" : "absent");
    if (trace.receiptEvidenceState !== expectedReceiptEvidenceState) {
      errors.push(`${trace.requirementId} receiptEvidenceState does not match retained receipt evidence`);
    }
    if (trace.rejectedExecutionReceipts.some((receipt) => receipt.receiptId.trim().length === 0 || receipt.reason.trim().length === 0)) {
      errors.push(`${trace.requirementId} rejected execution receipts must retain identity and reason`);
    }
    if (trace.productionEvidenceState === "verified" && trace.verifiedProductionEvidenceIds.length === 0) {
      errors.push(`${trace.requirementId} cannot claim verified production evidence without an id`);
    }
  }
  return errors;
}
