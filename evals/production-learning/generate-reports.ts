import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { learningCases, assertCatalogComplete, catalogSummary } from "./catalog.js";
import { buildRequirementCaseTraceability, flattenRequirementRegister, validateRequirementCaseTraceability, type ClosureRow, type RequirementRegister } from "./matrix.js";
import { admissionCandidates, rejectedCandidates, repositories } from "./repositories.js";
import { publicCaseProjection } from "./sealing.js";

const PROGRAM_BASE_REVISION = "96801a319fc3d355cb2b28b4167b83023a192042";
const generatedAt = new Date().toISOString();
const outputDirectory = resolve(process.argv[2] ?? "evals/reports/production-learning");
const register = JSON.parse(readFileSync("docs/PRODUCT_REQUIREMENTS.json", "utf8")) as RequirementRegister;
const requirements = flattenRequirementRegister(register);
const closure = JSON.parse(readFileSync("docs/PRODUCTION_CLOSURE_MATRIX.json", "utf8")) as { requirements: ClosureRow[] };

assertCatalogComplete();
mkdirSync(outputDirectory, { recursive: true });

const traceability = buildRequirementCaseTraceability({
  requirements,
  closureRows: closure.requirements,
  cases: learningCases,
});
const traceabilityErrors = validateRequirementCaseTraceability({
  traces: traceability,
  expectedRequirementIds: requirements.map((requirement) => requirement.id),
  expectedCaseIds: learningCases.map((item) => item.id),
});
if (traceabilityErrors.length > 0) {
  throw new Error(`production_learning_traceability_invalid:${traceabilityErrors.join("|")}`);
}

const fixtureManifestLedger = learningCases.map((learningCase) => ({
  schemaVersion: "mendpoint.fixture-manifest-plan.v1",
  caseId: learningCase.id,
  repositoryProvenanceId: learningCase.repository.provenanceId,
  manifestId: learningCase.fixture.manifestId,
  mutationId: learningCase.fixture.mutationId,
  seededFailure: learningCase.pattern.seededFailure,
  expectedImpactGraph: learningCase.datasetSplit === "holdout" ? null : learningCase.pattern.expectedImpactGraph,
  deterministicOracleIds: learningCase.datasetSplit === "holdout" ? [] : learningCase.expected.oracleIds,
  allowedEditPaths: learningCase.fixture.allowedEditPaths,
  expectedFixOrMigration: learningCase.datasetSplit === "holdout" ? null : learningCase.expected.repairOrMigration,
  rollbackId: learningCase.fixture.rollbackId,
  cleanupId: learningCase.fixture.cleanupId,
  answerKeyState: learningCase.datasetSplit === "holdout" ? "assigned_unsealed_withheld" : "development_visible",
  admissionState: "blocked" as const,
  pristineSnapshotSha256: null,
  patchPath: null,
  patchSha256: null,
  deterministicOracleEvidenceRef: null,
  blockers: [
    "repository content screening is not yet conclusive",
    "pristine tracked snapshot digest is not yet retained",
    "exact mutation patch and reverse patch digest are not yet retained",
    "deterministic failing oracle has not yet produced a retained receipt",
  ],
}));

const status = {
  schemaVersion: "mendpoint.production-learning-status.v1",
  generatedAt,
  programBaseRevision: PROGRAM_BASE_REVISION,
  catalog: catalogSummary(),
  requirements: {
    total: traceability.length,
    covered: traceability.filter((trace) => trace.coverageState === "covered").length,
    uncovered: traceability.filter((trace) => trace.coverageState === "uncovered").length,
    productionEvidenceState: "unknown",
  },
  sourceEvidence: { retainedContentSnapshots: 0, evidenceState: "unknown" },
  holdouts: {
    assigned: learningCases.filter((item) => item.datasetSplit === "holdout").length,
    sealed: 0,
    evidenceState: "unknown",
  },
  repositoryProvenance: {
    candidates: admissionCandidates.length,
    admitted: repositories.length,
    rejected: rejectedCandidates.length,
    evidenceState: repositories.length === admissionCandidates.length ? "verified" : "unknown",
  },
  fixtures: {
    planned: fixtureManifestLedger.length,
    admitted: 0,
    evidenceState: "unknown",
  },
  productionEvaluation: {
    requiredRuns: learningCases.length * 5,
    completedRuns: 0,
    evidenceState: "unknown",
    arms: ["production_baseline", "deterministic_recipe", "configured_model_router", "advisory_verifier", "oracle"],
  },
  claims: {
    repositoryControlledContractsImplemented: true,
    repositoriesProductionAdmitted: false,
    fixturesComplete: false,
    productionRunsExecuted: false,
    customerReady: false,
  },
};

function json(name: string, value: unknown): void {
  writeFileSync(resolve(outputDirectory, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

json("case-catalog.json", { schemaVersion: "mendpoint.case-catalog.v1", generatedAt, programBaseRevision: PROGRAM_BASE_REVISION, cases: learningCases.map(publicCaseProjection) });
json("repository-provenance.json", { schemaVersion: "mendpoint.repository-provenance-ledger.v1", generatedAt, candidates: admissionCandidates, admitted: repositories, rejected: rejectedCandidates });
json("fixture-manifest-ledger.json", { schemaVersion: "mendpoint.fixture-manifest-ledger.v1", generatedAt, manifests: fixtureManifestLedger });
json("requirement-case-test-production-matrix.json", { schemaVersion: "mendpoint.requirement-case-traceability.v1", generatedAt, rows: traceability });
json("evaluation-status.json", status);

const caseRows = learningCases.map((item) => {
  const source = item.sources[0]!;
  return `| ${item.id} | ${item.product} | ${item.cohort} | ${item.datasetSplit} | ${item.title.replace(/\|/g, "\\|")} | ${item.pattern.family} | [${source.publisher}](${source.url}) | ${item.repository.provenanceId} |`;
});
const markdown = `# Fettler and ReGauge production learning catalog\n\nGenerated: ${generatedAt}\n\nProgram base revision: \`${PROGRAM_BASE_REVISION}\`\n\nThis artifact contains 150 source-referenced cases: 50 common and 25 edge cases for each product. Structural catalog validation is deterministic. Source snapshots are not yet content-addressed. Repository content screening, protected holdout storage, exact fixture patches, production runs, deployment evidence, and rollback evidence remain separate gates and are not claimed by this report.\n\n## Current evidence boundary\n\n- Catalog: 150 of 150 structurally valid.\n- Holdout candidates: 30 assigned; protected seals: 0.\n- Repository candidates: ${admissionCandidates.length}; production admitted: ${repositories.length}.\n- Fixture plans: ${fixtureManifestLedger.length}; admitted exact mutation manifests: 0.\n- Required equal arm runs: ${learningCases.length * 5}; completed production runs: 0.\n- Customer readiness: not claimed.\n\n## Case ledger\n\n| Case | Product | Cohort | Split | Title | Pattern | Primary source | Repository candidate |\n|---|---|---|---|---|---|---|---|\n${caseRows.join("\n")}\n`;
writeFileSync(resolve(outputDirectory, "case-catalog.md"), markdown, "utf8");

process.stdout.write(`${JSON.stringify({ outputDirectory, status }, null, 2)}\n`);
