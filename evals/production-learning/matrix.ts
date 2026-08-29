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
  coverageState: "covered" | "uncovered";
  gapReason: string | null;
  caseIds: string[];
  testRefs: string[];
  registerEvidenceRefs: string[];
  closureIssueRefs: string[];
  closurePullRequestRefs: string[];
  productionEvidenceIds: string[];
  productionEvidenceState: "verified" | "unknown";
  externalBlockers: unknown;
}

export function flattenRequirementRegister(register: RequirementRegister): RequirementRecord[] {
  return [
    ...register.requirements,
    ...(register.additionalRegisterSets ?? []).flatMap((set) => set.requirements),
  ];
}

function requirementsForCase(learningCase: LearningCase): string[] {
  const uncertainty = `${learningCase.pattern.family} ${learningCase.title}`.toLowerCase();
  if (learningCase.product === "fettler") {
    const ids = ["ME-WAR-001", "ME-WAR-002", "ME-WAR-005", "ME-FET-015", "ME-FET-016"];
    if (learningCase.pattern.evidenceState !== "verified" || /(negative|unknown|ambiguous|conflict|stale|partial|no-impact|not-applicable)/.test(uncertainty)) {
      ids.push("ME-FET-017", "ME-FET-018");
    }
    return ids;
  }
  const ids = ["ME-TRN-001", "ME-TRN-004", "ME-TRN-005", "ME-REG-015", "ME-REG-018"];
  if (learningCase.cohort === "edge") ids.push("ME-TRN-008");
  if (/(constraint|dependency|upgrade|migration|version|provider|runtime)/.test(uncertainty)) ids.push("ME-REG-016");
  if (learningCase.pattern.evidenceState !== "verified" || /(negative|unknown|ambiguous|conflict|stale|partial|no-impact|not-applicable)/.test(uncertainty)) {
    ids.push("ME-REG-017");
  }
  return ids;
}

export function buildRequirementCaseTraceability(input: {
  requirements: readonly RequirementRecord[];
  closureRows: readonly ClosureRow[];
  cases: readonly LearningCase[];
}): RequirementCaseTrace[] {
  const closureByRequirement = new Map(input.closureRows.map((row) => [row.requirementId, row]));
  return [...input.requirements].sort((a, b) => a.id.localeCompare(b.id)).map((requirement) => {
    const closure = closureByRequirement.get(requirement.id);
    const cases = input.cases.filter((item) => requirementsForCase(item).includes(requirement.id));
    const productionEvidenceIds = closure?.productionEvidenceIds ?? [];
    const coverageState = cases.length > 0 ? "covered" : "uncovered";
    return {
      requirementId: requirement.id,
      requirementTitle: requirement.title,
      registerStatus: requirement.implementationStatus,
      registerClaimState: requirement.claimState,
      coverageState,
      gapReason: coverageState === "covered" ? null : "No production-learning case has an explicit semantic binding to this requirement in the current slice.",
      caseIds: cases.map((item) => item.id),
      testRefs: [...new Set(cases.filter((item) => item.datasetSplit === "development").flatMap((item) => item.expected.oracleIds))],
      registerEvidenceRefs: requirement.acceptance.flatMap((acceptance) => acceptance.evidence.map((evidence) => evidence.locator)),
      closureIssueRefs: (closure?.issues ?? []).map((issue) => `https://github.com/gondalaimafia/mendpoint/issues/${issue}`),
      closurePullRequestRefs: (closure?.pullRequests ?? []).map((pr) => `https://github.com/gondalaimafia/mendpoint/pull/${pr}`),
      productionEvidenceIds,
      productionEvidenceState: "unknown",
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
    if (trace.coverageState === "covered" && trace.caseIds.length === 0) errors.push(`${trace.requirementId} covered trace must bind at least one case`);
    if (trace.coverageState === "covered" && trace.testRefs.length === 0) errors.push(`${trace.requirementId} covered trace must bind at least one oracle`);
    if (trace.coverageState === "uncovered" && (trace.caseIds.length > 0 || trace.testRefs.length > 0 || trace.gapReason === null)) {
      errors.push(`${trace.requirementId} uncovered trace must retain an explicit gap without case or oracle claims`);
    }
    for (const caseId of trace.caseIds) {
      if (!knownCases.has(caseId)) errors.push(`${trace.requirementId} references unknown case: ${caseId}`);
    }
    if (trace.productionEvidenceState === "verified" && trace.productionEvidenceIds.length === 0) {
      errors.push(`${trace.requirementId} cannot claim verified production evidence without an id`);
    }
  }
  return errors;
}
