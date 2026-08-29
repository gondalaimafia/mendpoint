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
  caseIds: string[];
  testRefs: string[];
  registerEvidenceRefs: string[];
  closureIssueRefs: string[];
  closurePullRequestRefs: string[];
  productionEvidenceIds: string[];
  productionEvidenceState: "verified" | "unknown";
  externalBlockers: unknown;
}

function productScope(requirementId: string): "fettler" | "regauge" | "both" {
  const family = requirementId.split("-")[1];
  if (family === "WAR" || family === "ING" || family === "FET") return "fettler";
  if (family === "TRN" || family === "REG") return "regauge";
  return "both";
}

export function flattenRequirementRegister(register: RequirementRegister): RequirementRecord[] {
  return [
    ...register.requirements,
    ...(register.additionalRegisterSets ?? []).flatMap((set) => set.requirements),
  ];
}

function testRefs(requirementId: string): string[] {
  const family = requirementId.split("-")[1];
  const common = ["evals/production-learning/catalog.test.ts", "evals/production-learning/schema.test.ts"];
  if (family === "FND") return common;
  if (family === "RTR") return [...common, "evals/production-learning/learning.test.ts", "evals/production-learning/evaluation.test.ts"];
  if (family === "ENT" || family === "SCM") return [...common, "evals/production-learning/fixture.test.ts"];
  if (family === "COM" || family === "GTM") return [...common, "evals/production-learning/evaluation.test.ts"];
  return [...common, "evals/production-learning/fixture.test.ts", "evals/production-learning/evaluation.test.ts"];
}

export function buildRequirementCaseTraceability(input: {
  requirements: readonly RequirementRecord[];
  closureRows: readonly ClosureRow[];
  cases: readonly LearningCase[];
}): RequirementCaseTrace[] {
  const closureByRequirement = new Map(input.closureRows.map((row) => [row.requirementId, row]));
  return [...input.requirements].sort((a, b) => a.id.localeCompare(b.id)).map((requirement) => {
    const closure = closureByRequirement.get(requirement.id);
    const scope = productScope(requirement.id);
    const cases = input.cases.filter((item) => scope === "both" || item.product === scope);
    const productionEvidenceIds = closure?.productionEvidenceIds ?? [];
    return {
      requirementId: requirement.id,
      requirementTitle: requirement.title,
      registerStatus: requirement.implementationStatus,
      registerClaimState: requirement.claimState,
      caseIds: cases.map((item) => item.id),
      testRefs: testRefs(requirement.id),
      registerEvidenceRefs: requirement.acceptance.flatMap((acceptance) => acceptance.evidence.map((evidence) => evidence.locator)),
      closureIssueRefs: (closure?.issues ?? []).map((issue) => `https://github.com/gondalaimafia/mendpoint/issues/${issue}`),
      closurePullRequestRefs: (closure?.pullRequests ?? []).map((pr) => `https://github.com/gondalaimafia/mendpoint/pull/${pr}`),
      productionEvidenceIds,
      productionEvidenceState: productionEvidenceIds.length > 0 ? "verified" : "unknown",
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
    if (trace.caseIds.length === 0) errors.push(`${trace.requirementId} must bind at least one case`);
    if (trace.testRefs.length === 0) errors.push(`${trace.requirementId} must bind at least one test`);
    for (const caseId of trace.caseIds) {
      if (!knownCases.has(caseId)) errors.push(`${trace.requirementId} references unknown case: ${caseId}`);
    }
    if (trace.productionEvidenceState === "verified" && trace.productionEvidenceIds.length === 0) {
      errors.push(`${trace.requirementId} cannot claim verified production evidence without an id`);
    }
    if (trace.productionEvidenceState === "unknown" && trace.productionEvidenceIds.length > 0) {
      errors.push(`${trace.requirementId} production evidence ids require verified state`);
    }
  }
  return errors;
}
