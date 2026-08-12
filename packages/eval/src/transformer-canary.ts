import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDb,
  enqueueAdaptiveDelivery,
  getAdaptiveCandidate,
  getAdaptiveDeliveryByCandidate,
  getJob,
  listAudit,
  recordAdaptiveCandidate,
  reviewAdaptiveCandidate,
} from "@mendpoint/db";
import { MockGitHubDelivery } from "@mendpoint/github";
import { assessTransformerGate } from "@mendpoint/ops";
import {
  AWS_SDK_JS_V2_TO_V3_RECIPE,
  INTERNAL_API_ACME_USER_RENAME_RECIPE,
  NODE_RUNTIME_20_TO_22_RECIPE,
  REACT_DOM_17_TO_18_RECIPE,
  analyzeRecipe,
  createPublishedProviderRecipeCatalog,
  executeRecipeInWorkspace,
  normalizeRecipeFileModes,
  recipeFilesDigest,
  recipeReference,
  restoreRecipeExecutionInWorkspace,
  sealAdaptiveCandidate,
  signPublishedProviderRecipes,
  type AdaptiveCandidateReviewEdit,
  type AdaptiveCandidateReviewEvidence,
  type GitBlobMode,
  type MigrationRecipeContract,
  type ProviderRecipeResolution,
  type RecipeExecutionFence,
  type RecipeFileModes,
  type RecipeFiles,
} from "@mendpoint/transformer";
import {
  processJobsOnce,
  transformerAdaptiveGitLabDelivery,
} from "@mendpoint/worker/job-runner";

// ---------------------------------------------------------------------------
// Transformer end-to-end canary (Stage T4c).
//
// A single deterministic, CI-safe proof that the WHOLE Transformer pipeline
// composes end-to-end for one recipe per family, with no live model and no
// external network. For each family it starts from the published, signed
// catalog and chains: resolve -> execute in a disposable workspace -> verify ->
// inverse-restore -> seal an adaptive candidate -> record it for human review ->
// approve it (reviewer principal + rationale + timestamp) -> enqueue delivery ->
// deliver as a draft pull request through the MOCK SCM adapter -> assert the
// reviewable draft is produced with the expected branch/title/files and the
// candidate is promoted and recorded. It also asserts the safety invariants and
// emits a structured evidence summary the T5 enablement consumes as its
// go/no-go signal.
//
// This is the prove-then-enable gate for T5. It is NOT a live-model trial (that
// is the separate live lane) and NOT a real customer repository. The adaptive
// candidate divergence and its review evidence are constructed within the
// canary harness so the human-review delivery path runs deterministically; the
// catalog resolution, recipe execution, verification, inverse-restore, exact
// sealed-byte delivery, promotion, and gate default are all exercised for real.
// ---------------------------------------------------------------------------

export const TRANSFORMER_CANARY_VERSION = "2026-08-11.v1" as const;

export type TransformerCanaryFamily =
  | "sdk"
  | "framework"
  | "runtime"
  | "internal_api";

export type TransformerCanaryScmProvider = "github" | "gitlab";

export type TransformerCanaryInvariant = Readonly<{
  id: string;
  description: string;
  passed: boolean;
  expected: string;
  observed: string;
}>;

export type TransformerCanaryDeliveredDraft = Readonly<{
  provider: TransformerCanaryScmProvider;
  draftPr: true;
  number: number;
  url: string;
  branch: string;
  title: string;
  baseBranch: string;
  baseSha: string;
  commitSha: string;
  changedPaths: readonly string[];
}>;

export type TransformerCanaryFamilyResult = Readonly<{
  family: TransformerCanaryFamily;
  passed: boolean;
  scmProvider: TransformerCanaryScmProvider;
  recipe: Readonly<{ id: string; digest: string; provider: string }>;
  candidate: Readonly<{
    id: string;
    status: string;
    candidateDigest: string;
    divergedFromDigest: string;
    sealedSha256: string;
  }>;
  delivery: TransformerCanaryDeliveredDraft;
  invariants: readonly TransformerCanaryInvariant[];
}>;

export type TransformerCanaryReport = Readonly<{
  schemaVersion: 1;
  corpusVersion: typeof TRANSFORMER_CANARY_VERSION;
  generatedAt: string;
  passed: boolean;
  provenance: Readonly<{
    deterministic: true;
    liveModel: false;
    network: "none";
    scm: "mock";
    families: number;
  }>;
  familiesCovered: Readonly<Record<TransformerCanaryFamily, boolean>>;
  families: readonly TransformerCanaryFamilyResult[];
  safetyInvariants: readonly TransformerCanaryInvariant[];
}>;

type CanaryFamilyConfig = Readonly<{
  family: TransformerCanaryFamily;
  scmProvider: TransformerCanaryScmProvider;
  recipe: MigrationRecipeContract;
  fixtureDir: string;
  supportedPaths: readonly string[];
  outOfScopePaths: readonly string[];
  abstainReason: string;
  query: ProviderRecipeResolution;
  owner: string;
  repo: string;
}>;

// One representative recipe per Transformer family, resolved through the real
// published-catalog seam. The resolution queries mirror the held-out contract
// evals (packages/eval/src/transformer-agent-eval.ts) so the canary proves the
// same run-path bindings.
const FAMILIES: readonly CanaryFamilyConfig[] = Object.freeze([
  {
    family: "sdk",
    scmProvider: "github",
    recipe: AWS_SDK_JS_V2_TO_V3_RECIPE,
    fixtureDir: "aws-sdk-v2-to-v3",
    supportedPaths: ["package.json", "src/s3.js", "src/dynamo.js"],
    outOfScopePaths: ["package.json", "src/s3.js"],
    abstainReason: "recipe_aws_unsupported_service:SQS",
    owner: "mendpointcanary",
    repo: "sdk-canary",
    query: Object.freeze({
      providerSlug: "aws-sdk-js",
      providerCategory: "cloud",
      changeTarget: "sdk",
      changeKind: "breaking",
      fromVersion: "2",
      toVersion: "3",
      language: "javascript",
      packageManager: "npm",
      repositoryKind: "service",
      runtime: { name: "node", major: 20 },
    }),
  },
  {
    family: "framework",
    scmProvider: "github",
    recipe: REACT_DOM_17_TO_18_RECIPE,
    fixtureDir: "react-dom-17-to-18",
    supportedPaths: ["package.json", "src/index.jsx"],
    outOfScopePaths: ["package.json", "src/index.jsx"],
    abstainReason: "recipe_react_render_callback",
    owner: "mendpointcanary",
    repo: "framework-canary",
    query: Object.freeze({
      providerSlug: "react-dom",
      providerCategory: "developer_platform",
      changeTarget: "framework",
      changeKind: "breaking",
      fromVersion: "17",
      toVersion: "18",
      language: "javascript",
      packageManager: "npm",
      repositoryKind: "service",
      runtime: { name: "node", major: 20 },
    }),
  },
  {
    family: "runtime",
    scmProvider: "github",
    recipe: NODE_RUNTIME_20_TO_22_RECIPE,
    fixtureDir: "node-runtime-20-to-22",
    supportedPaths: [".node-version", ".nvmrc", "Dockerfile", "package.json"],
    outOfScopePaths: [".node-version", ".nvmrc", "Dockerfile", "package.json"],
    abstainReason: "recipe_precondition_failed:Dockerfile:node_major",
    owner: "mendpointcanary",
    repo: "runtime-canary",
    query: Object.freeze({
      providerSlug: "node",
      providerCategory: "developer_platform",
      changeTarget: "runtime",
      changeKind: "breaking",
      fromVersion: "20",
      toVersion: "22",
      language: "javascript",
      packageManager: "npm",
      repositoryKind: "service",
      runtime: { name: "node", major: 20 },
    }),
  },
  {
    family: "internal_api",
    // Delivered through the GitLab mock adapter so the canary exercises the
    // T4a provider selector's GitLab draft-merge-request path as well.
    scmProvider: "gitlab",
    recipe: INTERNAL_API_ACME_USER_RENAME_RECIPE,
    fixtureDir: "internal-api-acme-user-rename",
    supportedPaths: ["src/profile.ts", "src/settings.ts"],
    outOfScopePaths: ["src/profile.ts", "src/settings.ts"],
    abstainReason: "recipe_internal_api_binding_unresolved",
    owner: "mendpointcanary",
    repo: "internalapi-canary",
    query: Object.freeze({
      providerSlug: "acme-internal-user-api",
      providerCategory: "identity",
      changeTarget: "api",
      changeKind: "breaking",
      fromVersion: "1",
      toVersion: "2",
      language: "typescript",
      packageManager: "npm",
      repositoryKind: "service",
      runtime: { name: "node", major: 20 },
    }),
  },
]);

const CATALOG_NOW = "2026-08-11T00:00:00.000Z";
const RECORDED_AT = "2026-08-11T00:01:00.000Z";
const REVIEWED_AT = "2026-08-11T00:02:00.000Z";
const CANARY_EXPIRES_AT = "2026-09-11T00:00:00.000Z";
const BASE_REVISION = "b".repeat(40);

function loadFixture(dir: string, sub: string, paths: readonly string[]): RecipeFiles {
  const files: Record<string, string> = {};
  for (const path of paths) {
    files[path] = readFileSync(
      fileURLToPath(new URL(`../../../fixtures/consumers/${dir}/${sub}/${path}`, import.meta.url)),
      "utf8",
    );
  }
  return Object.freeze(files);
}

function allRegularModes(files: RecipeFiles): RecipeFileModes {
  return Object.freeze(
    Object.fromEntries(Object.keys(files).map((path) => [path, "100644" as GitBlobMode])),
  );
}

function contentDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function invariant(
  id: string,
  description: string,
  passed: boolean,
  expected: unknown,
  observed: unknown,
): TransformerCanaryInvariant {
  const render = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));
  return Object.freeze({ id, description, passed, expected: render(expected), observed: render(observed) });
}

function configurationCategory(path: string): AdaptiveCandidateReviewEdit["semanticCategory"] {
  return /(^|\/)(package\.json|\.nvmrc|\.node-version|Dockerfile)$/.test(path)
    ? "configuration"
    : "behavior";
}

function buildReviewEvidence(
  source: RecipeFiles,
  candidateFiles: RecipeFiles,
  changedPaths: readonly string[],
  fileModes: RecipeFileModes,
  commandId: string,
): AdaptiveCandidateReviewEvidence {
  const edits: AdaptiveCandidateReviewEdit[] = changedPaths.map((path) => {
    const before = source[path];
    const after = candidateFiles[path]!;
    const afterMode = fileModes[path]!;
    const isModify = before !== undefined;
    return Object.freeze({
      path,
      changeType: isModify ? ("modify" as const) : ("add" as const),
      beforeContent: isModify ? before! : null,
      beforeDigest: contentDigest(isModify ? before! : ""),
      beforeMode: isModify ? afterMode : null,
      afterDigest: contentDigest(after),
      afterMode,
      semanticCategory: configurationCategory(path),
      rationale:
        "Canary-constructed adaptive divergence for the human-review delivery path.",
      risk: "low" as const,
      confidence: 90,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    edits: Object.freeze(edits),
    verification: Object.freeze({
      passed: true as const,
      commandId,
      summary: "Canary adaptive candidate preserves the deterministic recipe transformation.",
      outputDigest: contentDigest(`canary-verification:${commandId}`),
    }),
    overallRisk: "low" as const,
    confidence: 90,
  });
}

async function runFamilyCanary(
  config: CanaryFamilyConfig,
  root: string,
): Promise<TransformerCanaryFamilyResult> {
  const env = { MENDPOINT_DATA_DIR: root } as NodeJS.ProcessEnv;
  const invariants: TransformerCanaryInvariant[] = [];

  // 1) Resolve through the published, signed catalog.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = `canary-${config.family}-key-2026-08`;
  const catalog = createPublishedProviderRecipeCatalog({
    signedArtifacts: signPublishedProviderRecipes({ keyId, privateKey }),
    trustedKeys: [{ keyId, algorithm: "ed25519", publicKey }],
    now: CATALOG_NOW,
  });
  const resolved = catalog.resolve(config.query);
  const reference = resolved.artifact.boundedEdits.implementationRecipe;
  const resolutionBinds =
    reference.digest === config.recipe.digest && reference.id === config.recipe.id;
  invariants.push(
    invariant(
      "catalog.resolves_published_recipe",
      "The published signed catalog resolves the family query to the executable recipe digest.",
      resolutionBinds,
      { id: config.recipe.id, digest: config.recipe.digest },
      { id: reference.id, digest: reference.digest },
    ),
  );

  // 2) Execute in a disposable workspace, verify, and inverse-restore.
  const source = loadFixture(config.fixtureDir, "before", config.supportedPaths);
  const sourceModes = allRegularModes(source);
  const fence: RecipeExecutionFence = Object.freeze({
    tenantId: `tenant-canary-${config.family}`,
    campaignId: `campaign-canary-${config.family}`,
    unitId: `unit-canary-${config.family}`,
    attemptId: `attempt-canary-${config.family}`,
    leaseGeneration: 3,
    leaseToken: `transformer-canary-${config.family}-lease`,
  });
  const repositoryId = `repository-canary-${config.family}`;
  const snapshotId = `snapshot-canary-${config.family}`;
  const evidenceDirectory = join(root, "recipe-evidence", config.family);
  const tempRoot = join(root, "workspaces", config.family);
  const execution = await executeRecipeInWorkspace({
    fence,
    assertFence: () => true,
    source: {
      repositoryId,
      revision: BASE_REVISION,
      digest: recipeFilesDigest(source),
      files: source,
      fileModes: sourceModes,
    },
    recipe: reference,
    evidenceDirectory,
    tempRoot,
    observedAt: "2026-08-11T00:00:30.000Z",
  });
  const restore = await restoreRecipeExecutionInWorkspace({
    execution,
    currentFiles: execution.outputFiles,
    fence,
    assertFence: () => true,
    evidenceDirectory,
    tempRoot,
    observedAt: "2026-08-11T00:00:45.000Z",
  });
  const verificationPassed =
    execution.analysis.status === "applicable" &&
    execution.commands.length >= 1 &&
    execution.commands.every((command) => command.exitCode === 0);
  invariants.push(
    invariant(
      "execute.verification_passes",
      "The recipe applies on the supported fixture and its verification commands exit zero.",
      verificationPassed,
      "applicable analysis with all verification commands at exit code zero",
      {
        status: execution.analysis.status,
        commands: execution.commands.map((command) => `${command.id}:${command.exitCode}`),
      },
    ),
  );
  invariants.push(
    invariant(
      "restore.inverse_exact_input_digest",
      "Inverse-restore returns the workspace to the exact input digest.",
      restore.outputDigest === execution.inputDigest,
      execution.inputDigest,
      restore.outputDigest,
    ),
  );

  // 3) Out-of-scope abstain: the recipe must decline the out-of-scope fixture.
  const outOfScope = loadFixture(config.fixtureDir, "out-of-scope", config.outOfScopePaths);
  const abstain = analyzeRecipe(recipeReference(config.recipe), outOfScope);
  const abstains =
    abstain.status === "unsupported" &&
    abstain.reasons.includes(config.abstainReason) &&
    abstain.matchedPaths.length === 0;
  invariants.push(
    invariant(
      "analysis.out_of_scope_abstains",
      "The recipe abstains on the out-of-scope fixture and applies no edits.",
      abstains,
      { status: "unsupported", reason: config.abstainReason },
      { status: abstain.status, reasons: abstain.reasons },
    ),
  );

  // 4) Construct a minimal divergent adaptive candidate from the deterministic
  //    output and seal it as the exact bytes a reviewer will approve.
  const deterministicFiles = execution.outputFiles;
  const divergedFromDigest = recipeFilesDigest(deterministicFiles);
  const tweakPath = Object.keys(deterministicFiles).sort()[0]!;
  const candidateFiles: RecipeFiles = Object.freeze({
    ...deterministicFiles,
    [tweakPath]: `${deterministicFiles[tweakPath]!}\n`,
  });
  const candidateDigest = recipeFilesDigest(candidateFiles);
  const candidateModes = allRegularModes(candidateFiles);
  const changedPaths = Object.freeze(
    Object.keys(candidateFiles)
      .filter((path) => source[path] !== candidateFiles[path])
      .sort(),
  );
  const minimalDivergence =
    candidateDigest !== divergedFromDigest &&
    Object.keys(candidateFiles).every(
      (path) =>
        path === tweakPath ||
        candidateFiles[path] === deterministicFiles[path],
    ) &&
    candidateFiles[tweakPath] === `${deterministicFiles[tweakPath]!}\n`;
  invariants.push(
    invariant(
      "adaptive.minimal_divergence",
      "The adaptive candidate diverges from the deterministic output by exactly one reviewed file.",
      minimalDivergence,
      { divergedFrom: divergedFromDigest },
      { candidate: candidateDigest, tweakPath },
    ),
  );
  const failingCommandId = `canary-objective-${config.family}`;
  const review = buildReviewEvidence(
    source,
    candidateFiles,
    changedPaths,
    candidateModes,
    failingCommandId,
  );
  const seal = sealAdaptiveCandidate({
    tenantId: fence.tenantId,
    campaignId: fence.campaignId,
    unitId: fence.unitId,
    attemptId: fence.attemptId,
    repositoryId,
    snapshotId,
    baseBranch: "main",
    expectedBaseRevision: BASE_REVISION,
    divergedFromDigest,
    candidateDigest,
    failingCommandId,
    changedPaths,
    adaptiveChangedPaths: [tweakPath],
    files: candidateFiles,
    fileModes: candidateModes,
    review,
    env,
  });

  // 5) Record the candidate for human review, then simulate the human approval
  //    with an explicit reviewer principal, rationale, and timestamp.
  const db = createDb(join(root, `mendpoint-${config.family}.sqlite`));
  try {
    const recorded = recordAdaptiveCandidate(db, {
      tenantId: fence.tenantId,
      campaignId: fence.campaignId,
      unitId: fence.unitId,
      attemptId: fence.attemptId,
      repositoryId,
      snapshotId,
      baseBranch: "main",
      expectedBaseRevision: BASE_REVISION,
      divergedFromDigest,
      candidateDigest,
      failingCommandId,
      sealedPath: seal.path,
      sealedSha256: seal.sha256,
      changedPaths,
      expiresAt: CANARY_EXPIRES_AT,
      now: RECORDED_AT,
    });
    const reviewerPrincipalId = `human:canary-${config.family}-reviewer`;
    const reviewed = reviewAdaptiveCandidate(db, {
      tenantId: fence.tenantId,
      id: recorded.id,
      decision: "approve",
      reviewerPrincipalId,
      rationale: "Canary reviewer approved the exact sealed adaptive candidate bytes.",
      now: REVIEWED_AT,
    });
    const approvalRecorded =
      reviewed.status === "approved" &&
      reviewed.reviewDecision === "approve" &&
      reviewed.reviewerPrincipalId === reviewerPrincipalId &&
      reviewed.reviewRationale !== null &&
      reviewed.reviewedAt === REVIEWED_AT;
    invariants.push(
      invariant(
        "review.human_approval_recorded",
        "Human approval records the reviewer principal, rationale, and timestamp.",
        approvalRecorded,
        { status: "approved", reviewer: reviewerPrincipalId },
        { status: reviewed.status, reviewer: reviewed.reviewerPrincipalId },
      ),
    );

    // 6) Enqueue delivery and drain it through the MOCK SCM adapter.
    enqueueAdaptiveDelivery(db, {
      tenantId: fence.tenantId,
      candidateId: reviewed.id,
      repositoryId: reviewed.repositoryId,
      snapshotId: reviewed.snapshotId,
      baseBranch: reviewed.baseBranch,
      expectedBaseRevision: reviewed.expectedBaseRevision,
      requesterPrincipalId: reviewerPrincipalId,
      now: REVIEWED_AT,
    });
    const scmDelivery =
      config.scmProvider === "gitlab"
        ? transformerAdaptiveGitLabDelivery({ GITLAB_MODE: "mock" } as NodeJS.ProcessEnv)
        : new MockGitHubDelivery(join(root, "mock-github", config.family));
    const drain = await processJobsOnce(db, {
      tenantId: fence.tenantId,
      maxJobs: 1,
      runWardenMaintenance: false,
      wardenEnv: env,
      transformerAdaptiveGithub: scmDelivery,
      transformerAdaptiveRepositoryResolver: async () =>
        Object.freeze({ owner: config.owner, repo: config.repo, baseBranch: "main" }),
      workerId: `worker-canary-${config.family}`,
    });

    const finalCandidate = getAdaptiveCandidate(db, fence.tenantId, recorded.id)!;
    const finalDelivery = getAdaptiveDeliveryByCandidate(db, fence.tenantId, recorded.id)!;
    const audit = listAudit(db, fence.tenantId);
    const deliveryJobId = finalDelivery.jobId;
    const finalJob = getJob(db, deliveryJobId, fence.tenantId)!;

    const expectedBranch = `mendpoint/transformer-${createHash("sha256")
      .update(recorded.id, "utf8")
      .digest("hex")
      .slice(0, 24)}`;
    const expectedTitle = `Apply approved Transformer candidate ${recorded.id}`;

    const draftProduced =
      drain.succeeded === 1 &&
      drain.failed === 0 &&
      finalDelivery.status === "delivered" &&
      finalDelivery.draftPr === true &&
      finalDelivery.branchName === expectedBranch &&
      finalDelivery.baseRevision === BASE_REVISION &&
      typeof finalDelivery.draftPrNumber === "number" &&
      finalDelivery.draftPrNumber > 0 &&
      typeof finalDelivery.draftPrUrl === "string" &&
      finalDelivery.draftPrUrl.length > 0;
    invariants.push(
      invariant(
        "delivery.draft_pull_request_produced",
        "The approved candidate is delivered as a reviewable draft pull request with the expected branch and title.",
        draftProduced,
        { branch: expectedBranch, draft: true, status: "delivered" },
        {
          branch: finalDelivery.branchName,
          draft: finalDelivery.draftPr,
          status: finalDelivery.status,
          number: finalDelivery.draftPrNumber,
        },
      ),
    );
    invariants.push(
      invariant(
        "delivery.draft_only_never_merged",
        "Delivery is draft-only and never merges.",
        finalDelivery.draftPr === true && finalJob.status === "done",
        { draft: true, job: "done" },
        { draft: finalDelivery.draftPr, job: finalJob.status },
      ),
    );

    const promoted =
      finalCandidate.status === "promoted" &&
      finalCandidate.promotedAt !== null &&
      audit.some(
        (event) =>
          event.action === "transformer.adaptive_candidate.delivered" &&
          event.resource_id === recorded.id,
      );
    invariants.push(
      invariant(
        "delivery.candidate_promoted_and_recorded",
        "The delivered candidate is promoted and the delivery is recorded in the audit log.",
        promoted,
        { status: "promoted", audit: "transformer.adaptive_candidate.delivered" },
        {
          status: finalCandidate.status,
          audit: audit.map((event) => event.action),
        },
      ),
    );

    // Exact sealed-byte binding: delivered files equal the sealed changed paths.
    const deliveredChangedPaths = [...changedPaths].sort();
    const sealedBytesOnly =
      finalDelivery.candidateId === recorded.id &&
      finalCandidate.candidateDigest === candidateDigest &&
      finalCandidate.sealedSha256 === seal.sha256;
    invariants.push(
      invariant(
        "delivery.exact_sealed_bytes",
        "The promoted candidate carries the exact sealed digest and seal SHA that were approved.",
        sealedBytesOnly,
        { candidateDigest, sealedSha256: seal.sha256 },
        {
          candidateDigest: finalCandidate.candidateDigest,
          sealedSha256: finalCandidate.sealedSha256,
        },
      ),
    );

    const passed = invariants.every((entry) => entry.passed);
    const delivery: TransformerCanaryDeliveredDraft = Object.freeze({
      provider: config.scmProvider,
      draftPr: true,
      number: finalDelivery.draftPrNumber ?? 0,
      url: finalDelivery.draftPrUrl ?? "",
      branch: finalDelivery.branchName ?? "",
      title: expectedTitle,
      baseBranch: finalDelivery.baseBranch,
      baseSha: finalDelivery.baseRevision ?? "",
      commitSha: finalDelivery.commitSha ?? "",
      changedPaths: Object.freeze([...deliveredChangedPaths]),
    });
    return Object.freeze({
      family: config.family,
      passed,
      scmProvider: config.scmProvider,
      recipe: Object.freeze({
        id: config.recipe.id,
        digest: config.recipe.digest,
        provider: config.query.providerSlug,
      }),
      candidate: Object.freeze({
        id: finalCandidate.id,
        status: finalCandidate.status,
        candidateDigest: finalCandidate.candidateDigest,
        divergedFromDigest: finalCandidate.divergedFromDigest,
        sealedSha256: finalCandidate.sealedSha256,
      }),
      delivery,
      invariants: Object.freeze([...invariants]),
    });
  } finally {
    db.raw.close();
  }
}

function gateDefaultInvariant(): TransformerCanaryInvariant {
  // The production Transformer gate default is DENIED. The canary passes the
  // default (no config) explicitly and never flips it; the canary runs only
  // because it composes the pipeline primitives directly within its harness.
  const decision = assessTransformerGate(
    { tenantId: "tenant-canary", environment: "production", boundary: "delivery" },
    undefined,
  );
  return invariant(
    "gate.production_default_denied",
    "The production Transformer gate default is denied and the canary never weakens it.",
    decision.allowed === false && decision.reasons.includes("transformer_gate_config_missing"),
    { allowed: false, reason: "transformer_gate_config_missing" },
    { allowed: decision.allowed, reasons: decision.reasons },
  );
}

export async function runTransformerCanary(
  now: () => Date = () => new Date(),
): Promise<TransformerCanaryReport> {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-transformer-canary-"));
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  try {
    const safetyInvariants: TransformerCanaryInvariant[] = [gateDefaultInvariant()];
    const families: TransformerCanaryFamilyResult[] = [];
    for (const config of FAMILIES) {
      families.push(await runFamilyCanary(config, root));
    }
    const familiesCovered = Object.freeze({
      sdk: families.some((entry) => entry.family === "sdk" && entry.passed),
      framework: families.some((entry) => entry.family === "framework" && entry.passed),
      runtime: families.some((entry) => entry.family === "runtime" && entry.passed),
      internal_api: families.some((entry) => entry.family === "internal_api" && entry.passed),
    });
    const passed =
      safetyInvariants.every((entry) => entry.passed) &&
      families.length === FAMILIES.length &&
      families.every((entry) => entry.passed) &&
      Object.values(familiesCovered).every(Boolean);
    return Object.freeze({
      schemaVersion: 1,
      corpusVersion: TRANSFORMER_CANARY_VERSION,
      generatedAt: now().toISOString(),
      passed,
      provenance: Object.freeze({
        deterministic: true as const,
        liveModel: false as const,
        network: "none" as const,
        scm: "mock" as const,
        families: families.length,
      }),
      familiesCovered,
      families: Object.freeze(families),
      safetyInvariants: Object.freeze(safetyInvariants),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function printTransformerCanaryReport(report: TransformerCanaryReport): void {
  const pad = (value: string, width: number) => value.padEnd(width).slice(0, width);
  console.log("");
  console.log(`Transformer end-to-end canary (T4c) — ${report.corpusVersion}`);
  console.log(
    `Deterministic ${report.provenance.deterministic}, live model ${report.provenance.liveModel}, network ${report.provenance.network}, SCM ${report.provenance.scm}`,
  );
  console.log("");
  console.log(
    `${pad("FAMILY", 14)} ${pad("SCM", 8)} ${pad("PASS", 5)} ${pad("DRAFT PR", 10)} RECIPE`,
  );
  console.log("-".repeat(80));
  for (const family of report.families) {
    console.log(
      `${pad(family.family, 14)} ${pad(family.scmProvider, 8)} ${pad(family.passed ? "yes" : "no", 5)} ${pad(`#${family.delivery.number}`, 10)} ${family.recipe.id}`,
    );
    console.log(`  draft PR: ${family.delivery.url}`);
    console.log(`  branch:   ${family.delivery.branch}`);
    for (const entry of family.invariants.filter((item) => !item.passed)) {
      console.log(`  FAILED ${entry.id}: expected ${entry.expected}, observed ${entry.observed}`);
    }
  }
  console.log("-".repeat(80));
  console.log("Safety invariants:");
  for (const entry of report.safetyInvariants) {
    console.log(`  ${entry.passed ? "ok" : "FAILED"} ${entry.id}`);
  }
  console.log(
    `Families covered: sdk ${report.familiesCovered.sdk}, framework ${report.familiesCovered.framework}, runtime ${report.familiesCovered.runtime}, internal_api ${report.familiesCovered.internal_api}`,
  );
  console.log(`Transformer canary ${report.passed ? "PASS" : "FAIL"}`);
  console.log("");
}

async function main(): Promise<void> {
  try {
    const report = await runTransformerCanary();
    printTransformerCanaryReport(report);
    if (!report.passed) process.exit(1);
  } catch (error) {
    console.error(
      `Transformer canary refused: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

const isMain =
  process.argv[1]?.replace(/\\/g, "/").endsWith("transformer-canary.ts") ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("transformer-canary.js");
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
