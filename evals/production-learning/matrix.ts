import type { LearningCase } from "./schema.js";

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
  executionReceiptIds: string[];
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
  oracleEvidenceIds: string[];
  productionEvidenceIds: string[];
  admissionState: "admitted" | "blocked";
  executionState: "planned" | "completed" | "failed";
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
  executionReceipts?: readonly CaseExecutionReceipt[];
}): RequirementCaseTrace[] {
  const closureByRequirement = new Map(input.closureRows.map((row) => [row.requirementId, row]));
  const admittedExecutionReceipts = (input.executionReceipts ?? []).filter((receipt) =>
    receipt.admissionState === "admitted"
    && receipt.executionState === "completed"
    && receipt.oracleEvidenceIds.length > 0
    && input.cases.some((item) => item.id === receipt.caseId),
  );
  return [...input.requirements].sort((a, b) => a.id.localeCompare(b.id)).map((requirement) => {
    const closure = closureByRequirement.get(requirement.id);
    const plannedCases = input.cases.filter((item) => item.planning.requirementIds.includes(requirement.id));
    const verifiedReceipts = admittedExecutionReceipts.filter((receipt) =>
      receipt.requirementIds.includes(requirement.id)
      && plannedCases.some((item) => item.id === receipt.caseId),
    );
    const planningState = plannedCases.length > 0 ? "planned" : "unplanned";
    const verificationState = verifiedReceipts.length > 0 ? "verified" : "unverified";
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
      verificationGapReason: verificationState === "verified" ? null : "No admitted completed execution receipt verifies this requirement.",
      executionReceiptIds: verifiedReceipts.map((receipt) => receipt.id),
      verifiedCaseIds: [...new Set(verifiedReceipts.map((receipt) => receipt.caseId))],
      verifiedOracleEvidenceIds: [...new Set(verifiedReceipts.flatMap((receipt) => receipt.oracleEvidenceIds))],
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
    if (trace.productionEvidenceState === "verified" && trace.verifiedProductionEvidenceIds.length === 0) {
      errors.push(`${trace.requirementId} cannot claim verified production evidence without an id`);
    }
  }
  return errors;
}
