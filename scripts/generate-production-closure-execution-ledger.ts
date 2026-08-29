/**
 * Regenerates docs/PRODUCTION_CLOSURE_EXECUTION_LEDGER.{json,md} from the
 * canonical register, closure matrix, and public-claims file plus the
 * handoff wave assignments. Does not change requirement status.
 *
 * Run: npx tsx scripts/generate-production-closure-execution-ledger.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isTestPath } from "./evidence-reachability-check.js";

const ROOT = resolve(import.meta.dirname, "..");
const OBSERVED_MAIN = "96801a319fc3d355cb2b28b4167b83023a192042";
const OBSERVED_AT = "2026-08-28T23:50:00.000Z";

type Requirement = {
  id: string;
  title: string;
  owner: string;
  implementationStatus: string;
  availability: string;
  claimState: string;
  closureWorkstream: string;
  acceptance: Array<{
    id: string;
    assertion: string;
    evidence: Array<{ id: string; type: string; locator: string }>;
  }>;
  externalBlockers: string[] | null;
};

type MatrixRow = {
  requirementId: string;
  registerSet: string;
  status: {
    implementationStatus: string;
    availability: string;
    claimState: string;
  };
  issues: number[];
  pullRequests: number[];
  testEvidenceIds: string[];
  productionEvidenceIds: string[];
};

type Claim = {
  id: string;
  requirementIds: string[];
  state: string;
  wording: string;
};

type LedgerRow = {
  requirementId: string;
  title: string;
  registerSet: string;
  workstream: string;
  implementationStatus: string;
  availability: string;
  claimState: string;
  acceptanceId: string;
  acceptanceAssertion: string;
  smallestUnmetGap: string;
  owningWave: number;
  owner: string;
  issue: number | null;
  pullRequests: number[];
  plannedPullRequest: string | null;
  reachableCodePath: string | null;
  mutationOrRegressionTest: string | null;
  productionEvidenceTarget: string;
  rollbackOrFailureProof: string;
  publicClaimEffect: string;
  externalDependency: string | null;
};

const WORKSTREAM_ISSUE: Record<string, number> = {
  "FC-00": 430,
  "FC-01": 437,
  "FC-02": 432,
  "FC-03": 431,
  "FC-04": 433,
  "FC-05": 434,
  "FC-06": 435,
  "FC-07": 436,
  "FC-08": 436,
  "FC-09": 439,
  "FC-10": 438,
};

const WAVE_BY_ID: Record<string, number> = {
  "ME-FND-001": 10, "ME-FND-002": 10, "ME-FND-003": 10, "ME-FND-004": 8,
  "ME-FND-005": 10, "ME-FND-006": 10, "ME-FND-007": 9, "ME-FND-008": 9,
  "ME-FND-009": 8, "ME-FND-010": 10,
  "ME-ING-001": 5, "ME-ING-002": 11, "ME-ING-003": 5, "ME-ING-004": 5,
  "ME-ING-005": 11, "ME-ING-006": 5, "ME-ING-007": 1, "ME-ING-008": 11,
  "ME-ING-009": 5,
  "ME-SCM-001": 11, "ME-SCM-002": 11, "ME-SCM-003": 5, "ME-SCM-004": 5,
  "ME-SCM-005": 11, "ME-SCM-006": 7,
  "ME-GRF-001": 6, "ME-GRF-002": 6, "ME-GRF-003": 11, "ME-GRF-004": 6,
  "ME-GRF-005": 6, "ME-GRF-006": 6, "ME-GRF-007": 6, "ME-GRF-008": 6,
  "ME-WAR-001": 5, "ME-WAR-002": 5, "ME-WAR-003": 11, "ME-WAR-004": 5,
  "ME-WAR-005": 5, "ME-WAR-006": 5, "ME-WAR-007": 11, "ME-WAR-008": 11,
  "ME-WAR-009": 5, "ME-WAR-010": 5,
  "ME-TRN-001": 7, "ME-TRN-002": 7, "ME-TRN-003": 11, "ME-TRN-004": 11,
  "ME-TRN-005": 3, "ME-TRN-006": 7, "ME-TRN-007": 11, "ME-TRN-008": 7,
  "ME-TRN-009": 7, "ME-TRN-010": 3, "ME-TRN-011": 11, "ME-TRN-012": 11,
  "ME-TRN-013": 11,
  "ME-RTR-001": 11, "ME-RTR-002": 11, "ME-RTR-003": 11, "ME-RTR-004": 11,
  "ME-RTR-005": 11, "ME-RTR-006": 8, "ME-RTR-007": 8, "ME-RTR-008": 8,
  "ME-RTR-009": 8,
  "ME-ENT-001": 10, "ME-ENT-002": 10, "ME-ENT-003": 10, "ME-ENT-004": 10,
  "ME-ENT-005": 1, "ME-ENT-006": 1, "ME-ENT-007": 1, "ME-ENT-008": 1,
  "ME-ENT-009": 10, "ME-ENT-010": 10, "ME-ENT-011": 10, "ME-ENT-012": 10,
  "ME-COM-001": 11, "ME-COM-002": 11, "ME-COM-003": 9, "ME-COM-004": 11,
  "ME-GTM-001": 11, "ME-GTM-002": 11, "ME-GTM-003": 10,
  "ME-FET-015": 1, "ME-FET-016": 5, "ME-FET-017": 5, "ME-FET-018": 5,
  "ME-REG-015": 7, "ME-REG-016": 7, "ME-REG-017": 1, "ME-REG-018": 7,
  "ME-CGR-001": 6,
  "ME-MSN-001": 4, "ME-MSN-002": 4, "ME-MSN-003": 4,
  "ME-MTE-001": 4, "ME-OMM-001": 4, "ME-PEV-001": 4, "ME-MCC-001": 4,
  "ME-SXT-001": 6,
};

const PLANNED_PR: Record<string, string> = {
  "ME-ING-007": "Drain and deploy #507 (release-dispatch), then prove a configured customer consumer on mendpoint-talal.",
  "ME-ENT-005": "Same as #507: tenant-bound dispatch events must appear in production health after deploy.",
  "ME-ENT-006": "Same as #507: fenced leases and shutdown boundaries on the live worker.",
  "ME-ENT-008": "Same as #507: backlog health and retryable provider failure on the live worker.",
  "ME-ENT-007": "Rebase and deploy #513 after #507; boot against a pre-change database and restore a signed receipt.",
  "ME-FET-015": "Deploy the #514 revision; keep this row partial. Do not mark verified.",
  "ME-REG-017": "Ship semantic package-lock authority, then rebase and deploy #512. Keep incomplete coverage as unknown.",
  "ME-FET-018": "New Fettler Wave 5 PR after Mission foundation: targeted raw retrieval when graph coverage is insufficient.",
  "ME-REG-015": "New ReGauge Wave 7 PR: hybrid relationship evidence (static/runtime/config/jobs/tests).",
  "ME-REG-016": "New ReGauge Wave 7 PR: MUST_PRECEDE / BLOCKS provenance distinct from planner hypotheses.",
  "ME-REG-018": "New ReGauge Wave 7 PR: plan from MissionGraphProjection before broad raw exploration.",
  "ME-CGR-001": "New Change Graph Wave 6 PR after Waves 4 and 5 tracer. Do not invent Graphify production.",
  "ME-WAR-010": "Blocked until an approved Fettler design-partner repository and observed acceptance exist.",
};

const GAPS: Record<string, string> = {
  "ME-FND-001": "Canonical v4 spec is enrolled, but the row is documented-only: no GA promotion and docs/PRODUCT_SPEC.md remains a compressed summary, not the authority.",
  "ME-FND-002": "GitHub-pilot / GitLab-GA boundary is written; GitLab production proof and the GA tier assignment are still undocumented as enforced release gates.",
  "ME-FND-003": "ReGauge pilot vs GA tiers exist in docs; the dedicated mendpoint-regauge-production app has no deployed image (Wave 3).",
  "ME-FND-004": "Training remains unshipped; the documented boundary is not yet backed by a promotion/canary/rollback ceremony on a consented dataset (Wave 8).",
  "ME-FND-005": "Self-host is documented as pilot; VPC remains scaffold (ME-ENT-011) with no approved cloud account.",
  "ME-FND-006": "Performance contract docs exist; production load/soak on the exact deployed revision does not.",
  "ME-FND-007": "Metric dictionary is documented; it is not the live MCU/billing authority used for customer invoices (Wave 9).",
  "ME-FND-008": "MCU model exists in code (ME-COM-001) but the documented reservation/settlement/invoice mapping is not finance-activated.",
  "ME-FND-009": "Default tenant-isolated learning is coded; shared-training opt-in, contamination, and deletion proofs are not production-live.",
  "ME-FND-010": "Register rows have targetRelease values; there is no atomic gate that refuses a mixed-tier promotion.",
  "ME-ING-007": "Register is verified, but production readback on 5ba70419 shows releasePollingConfigured:false. #507 is the drain; not merged or deployed.",
  "ME-ENT-005": "Partial observability exists; #507's tenant-bound dispatch traces are not on the deployed revision.",
  "ME-ENT-006": "SQLite single-node works; #507's fenced multi-worker drain is not deployed.",
  "ME-ENT-007": "Backup workflows exist; #513's authenticated release-ingestion restore authority is not merged. Customer backup issue #429 remains open.",
  "ME-ENT-008": "Router circuit breakers exist; #507's durable dispatch outage/backlog path is not deployed.",
  "ME-FET-015": "Partial on main via #514: tenant-authorized Fettler indexes persist. Smallest gap is exact-revision production evidence that materialization is used by a live impact caller. Do not mark verified.",
  "ME-FET-016": "Impact paths exist in graph-learn/code-impact; the live Fettler UI/review package does not always expose provider→code→verification lineage on a customer campaign.",
  "ME-FET-017": "queryFettlerEndpointImpact distinguishes no_impact vs unknown_impact; some producers still treat store_not_available / missing graph version as absence rather than unknown.",
  "ME-FET-018": "No production raw-retrieval fallback. Do not invent one that writes unverified edges into the current graph version.",
  "ME-REG-015": "DEPENDS_ON ingest and invariants exist; hybrid runtime/config/job/test relationship evidence is unimplemented.",
  "ME-REG-016": "Planner hypotheses are not persisted as distinct from observed MUST_PRECEDE / BLOCKS constraints.",
  "ME-REG-017": "#512 binds ReGauge dependency certainty to sealed workspace authority; main still risks empty dependsOn reading as 'no dependency'. After #512, remaining unknown-vs-absent cases stay Wave 7.",
  "ME-REG-018": "ReGauge plan consults graph when a file-backed GRAPH_LEARN_DB exists; it does not require a MissionGraphProjection before raw exploration.",
  "ME-CGR-001": "Change Graph pieces exist (versions, tenant views, impact query, MissionGraphProjection compiler). Production-grade acceptance — holdouts, Graphify qualification, temporal reconstruction, publication failure — is unimplemented.",
  "ME-MSN-001": "Mission rows bind repo/snapshot/graph version on some live paths; Fettler repair jobs can still run with no mission id, and restart/handoff does not yet prove the same Mission without transcript reconstruction.",
  "ME-MSN-002": "Typed decisions/exceptions/artifacts/handoffs exist. Open PRs #457/#466/#467 still carry compiler/handoff/artifact leftovers; do not collide. Decisions can be superseded in store; production caller coverage is incomplete.",
  "ME-MSN-003": "Compiler, resume, and policy inheritance exist. Exit proof (process restart + human handoff resume of the same Mission, inspectable lineage) is not production-proven.",
  "ME-MTE-001": "openTaskHandoff and job-bridge exist on merged Fettler/ReGauge review paths. #516 binds review resolution to the job task; #465/#499 are contended. Resume after human review is not proven across a process restart.",
  "ME-OMM-001": "Governed store and precedence resolver exist and are consulted on ReGauge plan and Mission compile. Memory is not yet emitted from both products' production outcome events (Wave 8).",
  "ME-PEV-001": "Versioned envelopes bind at Mission creation and compile into hard policy. Policy-evaluation evidence is not durably attached to the decision that used that envelope version.",
  "ME-MCC-001": "Compiler and worker producer exist. Leftover after #449: require mission.repositoryId === fallback.repositoryId; treat store_not_available/graph_projection_failed with a live endpointKey as context_not_loaded; gate published versions on gl_software_versions_v1, not gl_nodes. Blocked on #517 file overlap for mission-context.ts.",
  "ME-SXT-001": "Mendpoint-owned extractor contract exists. Graphify remains internal and unqualified; product APIs must not leak extractor types.",
  "ME-WAR-010": "Externally blocked: consented private customer repository and observed design-partner acceptance are missing.",
  "ME-WAR-005": "Policy enforcement on Fettler campaigns is scaffold; inherited Policy Envelope is not the live campaign gate.",
  "ME-TRN-005": "Real-repository execution is partial; dedicated ReGauge production app has no image (Wave 3).",
  "ME-TRN-010": "Workspace authority exists in #512; production ReGauge is disabled/inactive on 5ba70419.",
  "ME-SCM-003": "GitHub App lifecycle tests exist; production customer profile (real App, no seed, approved polling) is not the primary app configuration.",
  "ME-SCM-004": "GitLab adapters exist; an approved disposable private project and credentials do not.",
  "ME-COM-003": "Invoice-export contract is incomplete; live charging is forbidden without finance authority.",
};

const WAVE_TITLES: Record<number, string> = {
  0: "Restore the release control plane",
  1: "Drain the built queue",
  2: "Prove the sandbox trust root",
  3: "Dedicated ReGauge and DeepSeek advisory production",
  4: "Shared Mission intelligence foundation",
  5: "Fettler production activation",
  6: "Change Graph production maturity",
  7: "Complete the ReGauge product experience",
  8: "Governed learning and model lifecycle",
  9: "Economics and billing",
  10: "Enterprise trust, reliability, documentation, and public claims",
  11: "Final 101-of-101 qualification",
};

function defaultGap(req: Requirement): string {
  switch (req.implementationStatus) {
    case "verified":
      return "Implementation is verified on current main. Remaining gap is Wave 11: exact-revision production evidence, rollback proof, individual GA promotion, and claim update. Do not bulk-promote.";
    case "partial":
      return "Partial on current main. Smallest gap is a production caller that traces the acceptance assertion end-to-end, plus a mutation test on that caller, then exact-revision evidence.";
    case "documented":
      return "Specification/docs exist. Smallest gap is an enforceable implementation or a named production gate; documented is not verified.";
    case "unimplemented":
      return "No production implementation. Build the smallest tracer that satisfies the acceptance assertion without inventing adjacent subsystems.";
    case "scaffold":
      return "Scaffold only. Replace with a real production path or keep explicitly scaffolded; do not claim GA.";
    case "blocked_external":
      return "Repository-controlled work may proceed; GA is blocked on the named external owner proof.";
    default:
      return `Status ${req.implementationStatus} has no default gap; inspect the register row.`;
  }
}

/**
 * The first cited NON-TEST production source locator for a requirement, or null.
 *
 * This column is `reachableCodePath`: a test file here reads as proof that a
 * production code path exists, when it only proves a test exists (and the test
 * locator is already carried, verbatim, in `mutationOrRegressionTest`). Two
 * columns deriving from the same input is a tautology, so this MUST NOT fall
 * back to a test path. When no non-test production `.ts`/`.tsx` locator is
 * cited, the honest value is `null` — "no reachable production code path was
 * determined" — never the row's own test file dressed as production evidence.
 *
 * The test/source distinction MUST be the same judge the gate uses: the gate
 * (`production-closure-execution-ledger.ts`) rejects any `reachableCodePath`
 * for which `isTestPath` is true. If the generator judged "is this a test
 * file?" with a second, narrower rule (for example a bare `.includes(".test.")`
 * substring, which misses `.spec.ts` and `__tests__/` paths), it could emit a
 * value the gate hard-rejects, and no regeneration could satisfy both. So this
 * function filters non-test code locators through the exact same `isTestPath`.
 */
export function filePathFromLocator(locator: string): string {
  const hash = locator.indexOf("#");
  return hash === -1 ? locator : locator.slice(0, hash);
}

export function firstCodeLocator(req: Requirement): string | null {
  const locators = req.acceptance.flatMap((criterion) =>
    criterion.evidence
      .filter((item) => item.type === "code" || item.type === "unit" || item.type === "integration" || item.type === "security")
      .map((item) => item.locator)
      .filter((locator) => !locator.startsWith("planned:") && !locator.startsWith("external:")),
  );
  // Strip #symbol fragments before judging the path. A locator such as
  // `packages/codebase-index/src/index.ts#materializeCodebaseIndex` is a real
  // production file; treating the fragment as part of the extension would
  // record null and read as "no production path" when the register cited one.
  // `isTestPath` is the single shared judge with the gate, so a `.spec.ts` or
  // `__tests__/` locator is excluded here rather than emitted and then rejected.
  const code = locators
    .map(filePathFromLocator)
    .find((path) => /\.(ts|tsx)$/.test(path) && !isTestPath(path));
  return code ?? null;
}

function firstTestLocator(req: Requirement): string | null {
  const locators = req.acceptance.flatMap((criterion) =>
    criterion.evidence
      .filter((item) => item.type === "unit" || item.type === "integration" || item.type === "security" || item.type === "e2e" || item.type === "benchmark")
      .map((item) => item.locator),
  );
  return locators.find((locator) => locator.includes(".test.")) ?? locators[0] ?? null;
}

function productionTarget(req: Requirement, matrix: MatrixRow): string {
  if (matrix.productionEvidenceIds.length > 0) {
    return `Existing productionEvidenceIds ${matrix.productionEvidenceIds.join(", ")} must be re-read on the exact deployed revision after the next merge. Current observed main is ${OBSERVED_MAIN}.`;
  }
  if (req.implementationStatus === "blocked_external") {
    return `No production evidence until the named external owner supplies the missing proof. Synthetic or demo evidence must not promote this row. Current observed main ${OBSERVED_MAIN} does not satisfy this row.`;
  }
  return `After the owning-wave PR is merged and deployed: read back mendpoint-talal (and mendpoint-regauge-production when ReGauge) at the exact revision, /livez /healthz /readyz, and a capability-specific canary. Current observed main ${OBSERVED_MAIN} does not prove this row.`;
}

function rollbackProof(req: Requirement): string {
  if (req.implementationStatus === "unimplemented" || req.implementationStatus === "scaffold") {
    return "Fail closed: do not emit success or proven-absence when the capability is missing. Revert the implementing PR; no production data migration is authorized until a later wave says so.";
  }
  return "Revert the implementing PR. Preserve volumes and durable Mission/graph/learning state. Do not rebuild completed authenticated model work. Fail closed if the replacement path is absent.";
}

function loadRequirements(): Array<Requirement & { registerSet: string }> {
  const register = JSON.parse(
    readFileSync(resolve(ROOT, "docs/PRODUCT_REQUIREMENTS.json"), "utf8"),
  ) as {
    requirements: Requirement[];
    additionalRegisterSets: Array<{ key: string; requirements: Requirement[] }>;
  };
  return [
    ...register.requirements.map((row) => ({ ...row, registerSet: "foundational" })),
    ...register.additionalRegisterSets.flatMap((set) =>
      set.requirements.map((row) => ({ ...row, registerSet: set.key })),
    ),
  ];
}

export function buildExecutionLedger(): {
  schemaVersion: 1;
  source: string;
  observedMainRevision: string;
  observedAt: string;
  requirementCount: number;
  rows: LedgerRow[];
} {
  const requirements = loadRequirements();
  const matrix = JSON.parse(
    readFileSync(resolve(ROOT, "docs/PRODUCTION_CLOSURE_MATRIX.json"), "utf8"),
  ) as { requirements: MatrixRow[] };
  const claims = JSON.parse(
    readFileSync(resolve(ROOT, "docs/PUBLIC_CLAIMS.json"), "utf8"),
  ) as { claims: Claim[] };
  const matrixById = new Map(matrix.requirements.map((row) => [row.requirementId, row]));
  const claimsByRequirement = new Map<string, Claim[]>();
  for (const claim of claims.claims) {
    for (const id of claim.requirementIds) {
      const list = claimsByRequirement.get(id) ?? [];
      list.push(claim);
      claimsByRequirement.set(id, list);
    }
  }

  const rows: LedgerRow[] = requirements.map((req) => {
    const matrixRow = matrixById.get(req.id);
    if (!matrixRow) throw new Error(`matrix missing ${req.id}`);
    const acceptance = req.acceptance[0];
    if (!acceptance) throw new Error(`acceptance missing ${req.id}`);
    const wave = WAVE_BY_ID[req.id];
    if (!wave) throw new Error(`wave missing ${req.id}`);
    const linkedClaims = claimsByRequirement.get(req.id) ?? [];
    const publicClaimEffect = linkedClaims.length === 0
      ? "none"
      : linkedClaims
          .map((claim) => `${claim.id} (${claim.state}): do not change wording until this row is individually promoted`)
          .join("; ");
    const issue = matrixRow.issues[0] ?? WORKSTREAM_ISSUE[req.closureWorkstream] ?? null;
    return {
      requirementId: req.id,
      title: req.title,
      registerSet: req.registerSet,
      workstream: req.closureWorkstream,
      implementationStatus: matrixRow.status.implementationStatus,
      availability: matrixRow.status.availability,
      claimState: matrixRow.status.claimState,
      acceptanceId: acceptance.id,
      acceptanceAssertion: acceptance.assertion,
      smallestUnmetGap: GAPS[req.id] ?? defaultGap(req),
      owningWave: wave,
      owner: req.owner,
      issue,
      pullRequests: matrixRow.pullRequests,
      plannedPullRequest: PLANNED_PR[req.id] ?? null,
      reachableCodePath: firstCodeLocator(req),
      mutationOrRegressionTest: firstTestLocator(req),
      productionEvidenceTarget: productionTarget(req, matrixRow),
      rollbackOrFailureProof: rollbackProof(req),
      publicClaimEffect,
      externalDependency: req.externalBlockers?.join("; ") ?? null,
    };
  });

  return {
    schemaVersion: 1,
    source: "CURSOR_MENDPOINT_101_PRODUCTION_CLOSURE_HANDOFF.md Wave 0 task 6",
    observedMainRevision: OBSERVED_MAIN,
    observedAt: OBSERVED_AT,
    requirementCount: rows.length,
    rows,
  };
}

function renderMarkdown(ledger: ReturnType<typeof buildExecutionLedger>): string {
  const byWave = new Map<number, LedgerRow[]>();
  for (const row of ledger.rows) {
    const list = byWave.get(row.owningWave) ?? [];
    list.push(row);
    byWave.set(row.owningWave, list);
  }
  const counts = {
    verified: ledger.rows.filter((row) => row.implementationStatus === "verified").length,
    partial: ledger.rows.filter((row) => row.implementationStatus === "partial").length,
    documented: ledger.rows.filter((row) => row.implementationStatus === "documented").length,
    unimplemented: ledger.rows.filter((row) => row.implementationStatus === "unimplemented").length,
    scaffold: ledger.rows.filter((row) => row.implementationStatus === "scaffold").length,
    blocked_external: ledger.rows.filter((row) => row.implementationStatus === "blocked_external").length,
  };
  const lines = [
    "# Production closure execution ledger",
    "",
    "This is the Wave 0 exhaustive 101-row ledger. It does not replace the approved eleven-phase plan or change any requirement status.",
    "",
    `- Observed main: \`${ledger.observedMainRevision}\``,
    `- Observed at: ${ledger.observedAt}`,
    `- Rows: ${ledger.requirementCount}`,
    `- Status mix: ${counts.verified} verified, ${counts.partial} partial, ${counts.documented} documented, ${counts.unimplemented} unimplemented, ${counts.scaffold} scaffold, ${counts.blocked_external} blocked_external`,
    "",
    "Machine-readable source: `docs/PRODUCTION_CLOSURE_EXECUTION_LEDGER.json`.",
    "Regenerate with `npx tsx scripts/generate-production-closure-execution-ledger.ts`.",
    "",
    "Wave 0 control-plane work (not a requirement row): Claude owns the #515 authority repair. Cursor does not push to `fix-open-pr-head-oracle` or other authority files.",
    "",
  ];
  for (const wave of [...byWave.keys()].sort((left, right) => left - right)) {
    const rows = byWave.get(wave)!;
    lines.push(`## Wave ${wave}: ${WAVE_TITLES[wave]}`, "");
    lines.push("| ID | Status | Smallest unmet gap | Issue | Next PR |");
    lines.push("|---|---|---|---|---|");
    for (const row of rows) {
      const gap = row.smallestUnmetGap.replace(/\|/g, "\\|");
      const next = (row.plannedPullRequest ?? "from current main after dependencies").replace(/\|/g, "\\|");
      lines.push(`| \`${row.requirementId}\` | ${row.implementationStatus} | ${gap} | ${row.issue ?? "—"} | ${next} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export const HANDOFF_WAVE_ASSIGNMENTS = WAVE_BY_ID;

export function writeExecutionLedger(): ReturnType<typeof buildExecutionLedger> {
  const ledger = buildExecutionLedger();
  if (ledger.requirementCount !== 101) {
    throw new Error(`expected 101 rows, got ${ledger.requirementCount}`);
  }
  writeFileSync(
    resolve(ROOT, "docs/PRODUCTION_CLOSURE_EXECUTION_LEDGER.json"),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
  writeFileSync(resolve(ROOT, "docs/PRODUCTION_CLOSURE_EXECUTION_LEDGER.md"), renderMarkdown(ledger));
  return ledger;
}

const invokedDirectly = process.argv[1]?.includes("generate-production-closure-execution-ledger");
if (invokedDirectly) {
  const ledger = writeExecutionLedger();
  process.stdout.write(`wrote ${ledger.requirementCount} ledger rows\n`);
}
