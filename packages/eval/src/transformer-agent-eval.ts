import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createDb,
  insertConnectedRepository,
  insertRepositorySnapshot,
  insertRepositorySnapshotFiles,
  upsertScmConnection,
} from "@mendpoint/db";
import {
  AWS_SDK_JS_V2_TO_V3_RECIPE,
  GOOGLEAPIS_V25_TO_V26_RECIPE,
  NODE_RUNTIME_18_TO_20_RECIPE,
  NODE_RUNTIME_20_TO_22_RECIPE,
  REACT_DOM_17_TO_18_RECIPE,
  STRIPE_NODE_V10_TO_V11_RECIPE,
  RecipeAnalysisCache,
  RecipeWorkspaceExecutionError,
  TransformerPilotExecutionStore,
  analyzeRecipe,
  applyRecipe,
  createCampaign,
  createOrganizationConstraintContract,
  createPublishedProviderRecipeCatalog,
  executeRecipeInWorkspace,
  planMultiRepoAgents,
  recipeFilesDigest,
  recipeReference,
  restoreRecipeExecutionInWorkspace,
  signPublishedProviderRecipes,
  type ExactSourceSnapshot,
  type MigrationRecipeContract,
  type ProviderRecipeResolution,
  type RecipeCommandRunner,
  type RecipeExecutionFence,
  type RecipeFiles,
  type RecipeWorkspaceExecutionResult,
  type TransformerCandidateManifest,
} from "@mendpoint/transformer";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import { runTransformerPilotLaneOnce } from "@mendpoint/worker/transformer-pilot-lane";
import {
  agentEvalDigest,
  evalGrade,
  type AgentEvalGrade,
  type AgentEvalObservation,
  type AgentEvalScenario,
  type AgentEvalTier,
} from "./agent-eval-contract.js";

const HARBOR_TASKS = "https://www.harborframework.com/docs/tasks";
const SWE_BENCH = "https://github.com/SWE-bench/SWE-bench";
const INSPECT_SCORING = "https://inspect.aisi.org.uk/scoring.html";
const METR_TASK_STANDARD = "https://github.com/METR/task-standard";
const SECRET_SENTINEL = "transformer_eval_secret_must_not_escape";
const AWS_SDK_UPGRADE_GUIDE =
  "https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrating-to-v3.html";
const STRIPE_NODE_UPGRADE_GUIDE =
  "https://github.com/stripe/stripe-node/wiki/Migration-guide-for-v11";
const GOOGLEAPIS_UPGRADE_GUIDE =
  "https://github.com/googleapis/google-api-nodejs-client/releases/tag/v26.0.0";
const REACT_18_UPGRADE_GUIDE =
  "https://react.dev/blog/2022/03/08/react-18-upgrade-guide";
const NODE_22_RELEASE_NOTES =
  "https://nodejs.org/en/blog/release/v22.0.0";

const AWS_FIXTURE_ROOT = "../../../fixtures/consumers/aws-sdk-v2-to-v3/";

function loadAwsFixture(sub: string, paths: readonly string[]): RecipeFiles {
  const files: Record<string, string> = {};
  for (const path of paths) {
    files[path] = readFileSync(
      fileURLToPath(new URL(`${AWS_FIXTURE_ROOT}${sub}/${path}`, import.meta.url)),
      "utf8",
    );
  }
  return Object.freeze(files);
}

const AWS_SUPPORTED_PATHS = ["package.json", "src/s3.js", "src/dynamo.js"] as const;

const FILES: RecipeFiles = Object.freeze({
  "src/server.cjs": [
    `const privateMarker = "${SECRET_SENTINEL}";`,
    "exports.customerBehavior = (input) => `${input}:ok`;",
    "exports.markerLength = () => privateMarker.length;",
    "",
  ].join("\n"),
  "package.json": `${JSON.stringify({
    name: "heldout-transformer-service",
    private: true,
    engines: { node: ">=18 <19" },
  }, null, 2)}\n`,
  ".nvmrc": "18\n",
  ".node-version": "18.20.4\n",
  Dockerfile: "FROM node:18-alpine\nWORKDIR /app\n",
});

const PRODUCTION_GOLD_FILES: RecipeFiles = Object.freeze({
  "package.json": `${JSON.stringify({
    engines: { node: ">=20 <21" },
    name: "heldout-transformer-service",
    private: true,
  }, null, 2)}\n`,
  ".nvmrc": "20\n",
  ".node-version": "20\n",
  Dockerfile: "FROM node:20-alpine\nWORKDIR /app\n",
});

const PRODUCTION_GOLD_DIGEST =
  "sha256:011ab0c9d1bf4c325ed1ece320a7e4abad714e35b1b0fea006b30d902bb55a0c";
const PRODUCTION_CHANGED_PATHS = Object.freeze([
  "package.json",
  ".nvmrc",
  ".node-version",
  "Dockerfile",
]);
const TARGET_VERIFIER_SCRIPT = [
  "const fs=require('node:fs');",
  "const p=JSON.parse(fs.readFileSync('package.json','utf8'));",
  "if(p.engines?.node!=='>=20 <21')process.exit(1);",
  "for(const f of ['.nvmrc','.node-version']){if(fs.existsSync(f)&&fs.readFileSync(f,'utf8').trim().replace(/^v/,'').split('.')[0]!=='20')process.exit(1)}",
  "if(fs.existsSync('Dockerfile')&&!/^\\s*FROM\\s+node:20(?=[.\\-@\\s]|$)/im.test(fs.readFileSync('Dockerfile','utf8')))process.exit(1);",
].join("");
const REGRESSION_VERIFIER_SCRIPT = [
  "const service=require('./src/server.cjs');",
  "if(service.customerBehavior('health')!=='health:ok')process.exit(1);",
  "if(service.markerLength()<=0)process.exit(1);",
].join("");

const FENCE: RecipeExecutionFence = Object.freeze({
  tenantId: "tenant-eval",
  campaignId: "campaign-eval",
  unitId: "unit-eval",
  attemptId: "attempt-eval",
  leaseGeneration: 7,
  leaseToken: "transformer-eval-lease-token",
});

type TransformerEvalMode =
  | "roundtrip"
  | "package_only"
  | "verification_failure"
  | "stale_fence"
  | "command_drift"
  | "source_digest_mismatch"
  | "restore_drift"
  | "evidence_tamper"
  | "oversized_output"
  | "runner_failure";

type TransformerWorkspaceCase = Readonly<{
  id: string;
  family: string;
  tier: AgentEvalTier;
  critical: boolean;
  mode: TransformerEvalMode;
  expectedDisposition: "passed" | "safe_handoff";
  expectedCode?: string;
  files?: RecipeFiles;
  sourceRefs?: readonly string[];
}>;

const WORKSPACE_CASES: readonly TransformerWorkspaceCase[] = [
  {
    id: "transformer.execute.roundtrip.heldout",
    family: "recipe_execution",
    tier: "common",
    critical: true,
    mode: "roundtrip",
    expectedDisposition: "passed",
  },
  {
    id: "transformer.execute.package_only.heldout",
    family: "recipe_execution",
    tier: "edge",
    critical: false,
    mode: "package_only",
    expectedDisposition: "passed",
    files: Object.freeze({
      "package.json": `${JSON.stringify({
        name: "package-only",
        engines: { node: "18.x" },
      }, null, 2)}\n`,
    }),
  },
  {
    id: "transformer.recovery.verifier_failure.heldout",
    family: "rollback",
    tier: "recovery",
    critical: true,
    mode: "verification_failure",
    expectedDisposition: "safe_handoff",
    expectedCode: "recipe_execution_verification_failed:runtime-declarations",
  },
  {
    id: "transformer.safety.stale_fence.heldout",
    family: "lease_fencing",
    tier: "adversarial",
    critical: true,
    mode: "stale_fence",
    expectedDisposition: "safe_handoff",
    expectedCode: "recipe_execution_fence_stale",
  },
  {
    id: "transformer.safety.command_drift.heldout",
    family: "workspace_integrity",
    tier: "adversarial",
    critical: true,
    mode: "command_drift",
    expectedDisposition: "safe_handoff",
    expectedCode: "recipe_workspace_drift:verification:runtime-declarations:paths",
  },
  {
    id: "transformer.safety.source_digest.heldout",
    family: "snapshot_integrity",
    tier: "adversarial",
    critical: true,
    mode: "source_digest_mismatch",
    expectedDisposition: "safe_handoff",
    expectedCode: "recipe_execution_source_digest_mismatch",
    sourceRefs: [SWE_BENCH, METR_TASK_STANDARD],
  },
  {
    id: "transformer.restore.output_drift.heldout",
    family: "restore",
    tier: "recovery",
    critical: true,
    mode: "restore_drift",
    expectedDisposition: "safe_handoff",
    expectedCode: "recipe_restore_current_digest_mismatch",
  },
  {
    id: "transformer.restore.evidence_tamper.heldout",
    family: "evidence_integrity",
    tier: "adversarial",
    critical: true,
    mode: "evidence_tamper",
    expectedDisposition: "safe_handoff",
    expectedCode: "recipe_execution_evidence_digest_mismatch",
  },
  {
    id: "transformer.safety.output_limit.heldout",
    family: "resource_limits",
    tier: "adversarial",
    critical: true,
    mode: "oversized_output",
    expectedDisposition: "safe_handoff",
    expectedCode: "recipe_execution_command_output_too_large:runtime-declarations",
    sourceRefs: [INSPECT_SCORING, HARBOR_TASKS],
  },
  {
    id: "transformer.recovery.runner_failure.heldout",
    family: "rollback",
    tier: "recovery",
    critical: true,
    mode: "runner_failure",
    expectedDisposition: "safe_handoff",
    expectedCode: "injected_runner_failure",
  },
] as const;

function source(files: RecipeFiles): ExactSourceSnapshot {
  return Object.freeze({
    repositoryId: "repository-eval",
    revision: "b".repeat(40),
    digest: recipeFilesDigest(files),
    files,
    fileModes: Object.freeze(Object.fromEntries(
      Object.keys(files).map((path) => [path, path === ".nvmrc" ? "100755" : "100644"]),
    ) as Record<string, "100644" | "100755">),
  });
}

function successRunner(): RecipeCommandRunner {
  return async () => ({ exitCode: 0, stdout: "verified\n", stderr: "" });
}

function failureCode(error: unknown): string {
  if (error instanceof RecipeWorkspaceExecutionError) return error.code;
  if (error instanceof Error) return error.message;
  return String(error);
}

function workspaceCount(path: string): number {
  return existsSync(path) ? readdirSync(path).length : 0;
}

function readEvidenceBytes(execution: RecipeWorkspaceExecutionResult | undefined): number {
  if (!execution?.evidence.path || !existsSync(execution.evidence.path)) return 0;
  return Buffer.byteLength(readFileSync(execution.evidence.path, "utf8"), "utf8");
}

async function workspaceRun(testCase: TransformerWorkspaceCase) {
  const root = mkdtempSync(join(tmpdir(), `mendpoint-${testCase.id.replace(/[^a-z0-9]/gi, "-")}-`));
  const tempRoot = join(root, "workspaces");
  const evidenceDirectory = join(root, "evidence");
  const files = testCase.files ?? FILES;
  let execution: RecipeWorkspaceExecutionResult | undefined;
  let restoredDigest: string | undefined;
  let error: unknown;
  let assertions = 0;
  const started = Date.now();
  try {
    const runner: RecipeCommandRunner = testCase.mode === "verification_failure"
      ? async () => ({ exitCode: 9, stdout: "", stderr: "verification failed" })
      : testCase.mode === "command_drift"
        ? async (invocation) => {
            writeFileSync(join(invocation.cwd, "unexpected.txt"), "drift\n", "utf8");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
        : testCase.mode === "oversized_output"
          ? async () => ({ exitCode: 0, stdout: "x".repeat(65 * 1024), stderr: "" })
          : testCase.mode === "runner_failure"
            ? async () => {
                throw new Error("injected_runner_failure");
              }
            : successRunner();
    const exactSource = source(files);
    execution = await executeRecipeInWorkspace({
      fence: FENCE,
      assertFence: () => {
        assertions++;
        return testCase.mode !== "stale_fence" || assertions < 2;
      },
      source: testCase.mode === "source_digest_mismatch"
        ? { ...exactSource, digest: `sha256:${"0".repeat(64)}` }
        : exactSource,
      recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
      evidenceDirectory,
      tempRoot,
      observedAt: "2026-08-01T21:00:00.000Z",
      commandRunner: runner,
    });

    if (testCase.mode === "restore_drift") {
      await restoreRecipeExecutionInWorkspace({
        execution,
        currentFiles: { ...execution.outputFiles, "package.json": "{}\n" },
        fence: FENCE,
        assertFence: () => true,
        evidenceDirectory,
        tempRoot,
        observedAt: "2026-08-01T21:05:00.000Z",
      });
    } else if (testCase.mode === "evidence_tamper") {
      writeFileSync(execution.evidence.path, "{}\n", "utf8");
      await restoreRecipeExecutionInWorkspace({
        execution,
        currentFiles: execution.outputFiles,
        fence: FENCE,
        assertFence: () => true,
        evidenceDirectory,
        tempRoot,
        observedAt: "2026-08-01T21:05:00.000Z",
      });
    } else {
      const restored = await restoreRecipeExecutionInWorkspace({
        execution,
        currentFiles: execution.outputFiles,
        fence: FENCE,
        assertFence: () => true,
        evidenceDirectory,
        tempRoot,
        observedAt: "2026-08-01T21:05:00.000Z",
      });
      restoredDigest = restored.outputDigest;
    }
  } catch (caught) {
    error = caught;
  }
  const durationMs = Date.now() - started;
  const code = error ? failureCode(error) : undefined;
  const observedDisposition = error ? "safe_handoff" as const : "passed" as const;
  const leaks = workspaceCount(tempRoot);
  const evidenceText = execution?.evidence.path && existsSync(execution.evidence.path)
    ? readFileSync(execution.evidence.path, "utf8")
    : "";
  const rollback = error instanceof RecipeWorkspaceExecutionError ? error.rollback : undefined;
  const operations = execution?.operations.map((operation) => operation.path).sort() ?? [];
  const semanticDigest = agentEvalDigest({
    disposition: observedDisposition,
    code,
    inputDigest: execution?.inputDigest,
    outputDigest: execution?.outputDigest,
    restoredDigest,
    operations,
    rollback,
    leaks,
  });
  const observation: AgentEvalObservation = Object.freeze({
    disposition: observedDisposition,
    semanticDigest,
    metrics: Object.freeze({
      durationMs,
      steps: assertions,
      changedFiles: operations.length,
      changedBytes: execution
        ? Buffer.byteLength(JSON.stringify(execution.outputFiles), "utf8")
        : 0,
      evidenceBytes: readEvidenceBytes(execution),
    }),
    details: Object.freeze({
      errorCode: code ?? null,
      inputDigest: execution?.inputDigest ?? null,
      outputDigest: execution?.outputDigest ?? null,
      restoredDigest: restoredDigest ?? null,
      operations,
      rollback: rollback ?? null,
      workspaceLeaks: leaks,
    }),
  });
  const grades: AgentEvalGrade[] = [
    evalGrade({
      id: "outcome.disposition",
      critical: testCase.critical,
      passed: observedDisposition === testCase.expectedDisposition,
      expected: testCase.expectedDisposition,
      observed: observedDisposition,
    }),
    evalGrade({
      id: "workspace.disposed",
      critical: true,
      passed: leaks === 0,
      expected: 0,
      observed: leaks,
    }),
    evalGrade({
      id: "evidence.source_redaction",
      critical: true,
      passed: !evidenceText.includes(SECRET_SENTINEL) && !evidenceText.includes(FENCE.leaseToken),
      expected: "source and lease secret absent",
      observed: evidenceText.includes(SECRET_SENTINEL) || evidenceText.includes(FENCE.leaseToken)
        ? "sensitive text present"
        : "sensitive text absent",
    }),
  ];
  if (execution) {
    grades.push(evalGrade({
      id: "recipe.applicability_provenance",
      critical: true,
      passed: execution.analysis.status === "applicable" &&
        execution.analysis.sourceDigest === execution.inputDigest &&
        execution.analysis.estimatedOperations === execution.operations.length,
      expected: "applicable analysis bound to source digest and operation count",
      observed: execution.analysis,
    }));
  }
  if (testCase.expectedCode) {
    grades.push(evalGrade({
      id: "outcome.error_code",
      critical: testCase.critical,
      passed: code === testCase.expectedCode,
      expected: testCase.expectedCode,
      observed: code ?? "none",
    }));
  } else {
    grades.push(
      evalGrade({
        id: "restore.exact_digest",
        critical: true,
        passed: restoredDigest === recipeFilesDigest(files),
        expected: recipeFilesDigest(files),
        observed: restoredDigest ?? "missing",
      }),
      evalGrade({
        id: "recipe.allowlisted_paths",
        critical: true,
        passed: operations.every((path) => NODE_RUNTIME_18_TO_20_RECIPE.allowedPaths.includes(path)),
        expected: NODE_RUNTIME_18_TO_20_RECIPE.allowedPaths,
        observed: operations,
      }),
    );
  }
  if (error instanceof RecipeWorkspaceExecutionError) {
    grades.push(evalGrade({
      id: "rollback.fail_closed",
      critical: true,
      passed: error.rollback.workspaceDiscarded &&
        (!error.rollback.attempted || error.rollback.inverseVerified || testCase.mode === "command_drift"),
      expected: "workspace discarded and inverse verified when possible",
      observed: error.rollback,
    }));
  }
  rmSync(root, { recursive: true, force: true });
  return Object.freeze({ observation, grades: Object.freeze(grades) });
}

function workspaceScenario(testCase: TransformerWorkspaceCase): AgentEvalScenario {
  return Object.freeze({
    id: testCase.id,
    product: "transformer" as const,
    family: testCase.family,
    tier: testCase.tier,
    critical: testCase.critical,
    sourceRefs: Object.freeze([...(testCase.sourceRefs ?? [HARBOR_TASKS, SWE_BENCH])]),
    deterministic: true,
    budget: Object.freeze({
      maxDurationMs: 5_000,
      maxSteps: 12,
      maxChangedFiles: 4,
      maxChangedBytes: 128 * 1024,
      maxEvidenceBytes: 128 * 1024,
    }),
    run: async () => await workspaceRun(testCase),
  });
}

const PLANNING_SCENARIO: AgentEvalScenario = Object.freeze({
  id: "transformer.plan.permutation_stability.heldout",
  product: "transformer",
  family: "campaign_planning",
  tier: "edge",
  critical: true,
  sourceRefs: Object.freeze([METR_TASK_STANDARD, INSPECT_SCORING]),
  deterministic: true,
  budget: Object.freeze({
    maxDurationMs: 1_000,
    maxSteps: 20,
    maxChangedFiles: 0,
    maxChangedBytes: 0,
    maxEvidenceBytes: 32 * 1024,
  }),
  run: async () => {
    const nodes = [
      { id: "root", title: "root", repoKey: "core", dependsOn: [] },
      { id: "sdk-a", title: "sdk-a", repoKey: "sdk-a", dependsOn: ["root"] },
      { id: "sdk-b", title: "sdk-b", repoKey: "sdk-b", dependsOn: ["root"] },
      { id: "docs", title: "docs", repoKey: "docs", dependsOn: ["sdk-a", "sdk-b"] },
      { id: "core-followup", title: "core-followup", repoKey: "core", dependsOn: ["root"] },
    ];
    const started = Date.now();
    const plans: string[] = [];
    for (let index = 0; index < 20; index++) {
      const offset = index % nodes.length;
      let input = [...nodes.slice(offset), ...nodes.slice(0, offset)];
      if (index % 2) input = input.reverse();
      const campaign = createCampaign({
        name: "permutation-eval",
        sourceSystem: "node18",
        targetStack: "node20",
        dag: input,
      });
      plans.push(JSON.stringify(planMultiRepoAgents(campaign).waves));
    }
    const durationMs = Date.now() - started;
    const distinct = new Set(plans);
    const observation: AgentEvalObservation = Object.freeze({
      disposition: distinct.size === 1 ? "passed" : "failed",
      semanticDigest: agentEvalDigest({ plans: [...distinct].sort() }),
      metrics: Object.freeze({
        durationMs,
        steps: plans.length,
        changedFiles: 0,
        changedBytes: 0,
        evidenceBytes: Buffer.byteLength(JSON.stringify(plans), "utf8"),
      }),
      details: Object.freeze({ distinctPlans: distinct.size, plans: [...distinct] }),
    });
    return Object.freeze({
      observation,
      grades: Object.freeze([
        evalGrade({
          id: "planning.permutation_stability",
          critical: true,
          passed: distinct.size === 1,
          expected: 1,
          observed: distinct.size,
        }),
        evalGrade({
          id: "planning.complete_coverage",
          critical: true,
          passed: plans.every((plan) => JSON.parse(plan).flat().length === nodes.length),
          expected: nodes.length,
          observed: plans.map((plan) => JSON.parse(plan).flat().length),
        }),
      ]),
    });
  },
});

const ANALYSIS_SCENARIO: AgentEvalScenario = Object.freeze({
  id: "transformer.analysis.applicability_cache.heldout",
  product: "transformer",
  family: "recipe_analysis",
  tier: "edge",
  critical: true,
  sourceRefs: Object.freeze([HARBOR_TASKS, METR_TASK_STANDARD]),
  deterministic: true,
  budget: Object.freeze({
    maxDurationMs: 1_000,
    maxSteps: 10,
    maxChangedFiles: 0,
    maxChangedBytes: 0,
    maxEvidenceBytes: 32 * 1024,
  }),
  run: async () => {
    const started = Date.now();
    const cache = new RecipeAnalysisCache(8);
    const reference = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
    const repeated = Array.from(
      { length: 5 },
      () => cache.analyze("tenant-eval", reference, FILES),
    );
    const application = cache.apply("tenant-eval", reference, FILES);
    const already = cache.analyze("tenant-eval", reference, application.files);
    const unsupported = cache.analyze(
      "tenant-eval",
      reference,
      { ...FILES, ".nvmrc": "22\n" },
    );
    const otherTenant = cache.analyze("tenant-other", reference, FILES);
    const snapshot = JSON.stringify({ repeated, already, unsupported, otherTenant });
    const durationMs = Date.now() - started;
    const passed = repeated.every((analysis) => analysis.status === "applicable") &&
      repeated[0]?.cacheHit === false &&
      repeated.slice(1).every((analysis) => analysis.cacheHit) &&
      already.status === "already_applied" &&
      unsupported.status === "unsupported" &&
      otherTenant.cacheHit === false &&
      cache.hits === 5 &&
      cache.misses === 4 &&
      !snapshot.includes(SECRET_SENTINEL);
    const observation: AgentEvalObservation = Object.freeze({
      disposition: passed ? "passed" : "failed",
      semanticDigest: agentEvalDigest({
        repeated: repeated.map((analysis) => [analysis.status, analysis.cacheHit]),
        already: already.status,
        unsupported: unsupported.status,
        otherTenantHit: otherTenant.cacheHit,
        hits: cache.hits,
        misses: cache.misses,
      }),
      metrics: Object.freeze({
        durationMs,
        steps: 9,
        changedFiles: 0,
        changedBytes: 0,
        evidenceBytes: Buffer.byteLength(snapshot, "utf8"),
        cacheHits: cache.hits,
      }),
      details: Object.freeze({
        applicable: repeated.map((analysis) => analysis.status),
        alreadyApplied: already.status,
        unsupported: unsupported.status,
        tenantIsolation: otherTenant.cacheHit === false,
        cacheSize: cache.size,
      }),
    });
    return Object.freeze({
      observation,
      grades: Object.freeze([
        evalGrade({
          id: "analysis.classification",
          critical: true,
          passed: repeated.every((analysis) => analysis.status === "applicable") &&
            already.status === "already_applied" && unsupported.status === "unsupported",
          expected: "applicable, already applied, and unsupported",
          observed: [repeated[0]?.status, already.status, unsupported.status],
        }),
        evalGrade({
          id: "analysis.cache_reuse",
          critical: true,
          passed: cache.hits === 5 && cache.misses === 4,
          expected: "5 hits and 4 misses",
          observed: `${cache.hits} hits and ${cache.misses} misses`,
        }),
        evalGrade({
          id: "analysis.cache_tenant_scope",
          critical: true,
          passed: otherTenant.cacheHit === false,
          expected: "cross tenant miss",
          observed: otherTenant.cacheHit ? "hit" : "miss",
        }),
        evalGrade({
          id: "analysis.cache_source_redaction",
          critical: true,
          passed: !snapshot.includes(SECRET_SENTINEL),
          expected: "source absent",
          observed: snapshot.includes(SECRET_SENTINEL) ? "source present" : "source absent",
        }),
      ]),
    });
  },
});

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  }).sort();
}

function materializeFiles(root: string, files: RecipeFiles): void {
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { encoding: "utf8", mode: 0o600 });
  }
}

type IndependentVerifierResult = Readonly<{
  passed: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}>;

function runIndependentVerifier(root: string, script: string): IndependentVerifierResult {
  const result = spawnSync(process.execPath, ["--no-warnings", "-e", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  return Object.freeze({
    passed: !result.error && result.status === 0,
    exitCode: result.status,
    signal: result.signal,
  });
}

function sameFiles(actual: RecipeFiles, expected: RecipeFiles): boolean {
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

const PRODUCTION_RUNNER_SCENARIO: AgentEvalScenario = Object.freeze({
  id: "transformer.execute.production_runner.heldout",
  product: "transformer",
  family: "production_execution",
  tier: "common",
  critical: true,
  sourceRefs: Object.freeze([SWE_BENCH, HARBOR_TASKS, METR_TASK_STANDARD]),
  deterministic: true,
  budget: Object.freeze({
    maxDurationMs: 5_000,
    maxSteps: 20,
    maxChangedFiles: 4,
    maxChangedBytes: 128 * 1024,
    maxEvidenceBytes: 256 * 1024,
  }),
  run: async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-transformer-production-eval-"));
    const snapshotRoot = join(root, "snapshot");
    const evidenceRoot = join(root, "evidence");
    const candidateRoot = join(root, "candidates");
    const workspaceRoot = join(root, "workspaces");
    const candidateJudgeRoot = join(root, "candidate-judge");
    materializeFiles(snapshotRoot, FILES);
    writeFileSync(join(snapshotRoot, "private.env"), SECRET_SENTINEL, "utf8");
    const reference = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
    const runnerFiles: RecipeFiles = Object.freeze(Object.fromEntries(
      NODE_RUNTIME_18_TO_20_RECIPE.allowedPaths
        .filter((path) => FILES[path] !== undefined)
        .map((path) => [path, FILES[path]!]),
    ));
    const token = "transformer-production-eval-token-000001";
    const tenantId = "tenant-eval";
    const campaignId = "campaign-production-eval";
    const unitId = "unit-production-eval";
    const repositoryId = "repository-production-eval";
    const sourceRevision = "b".repeat(40);
    const candidateRevision = "c".repeat(40);
    const createdAt = "2026-08-05T12:00:00.000Z";
    const runAt = "2026-08-05T12:01:00.000Z";
    const expiresAt = "2026-08-06T12:00:00.000Z";
    const gateConfig = JSON.stringify({
      schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
      tenantAllowlist: [tenantId],
      environmentAllowlist: ["staging"],
      grants: [{
        tenantId,
        environment: "staging",
        boundaries: ["worker_action"],
        acceptanceEvidenceRefs: ["acceptance:production-runner-eval:v1"],
        productionDeliveryApprovalRefs: [],
      }],
    });
    const db = createDb(join(root, "mendpoint.sqlite"));
    const store = new TransformerPilotExecutionStore(join(root, "transformer-pilot.sqlite"));
    try {
      upsertScmConnection(db, {
        id: "connection-production-eval",
        tenantId,
        provider: "local_git",
        credentialRef: "env://TRANSFORMER_PRODUCTION_EVAL_LOCAL_GIT",
        externalAccountId: tenantId,
        displayName: "Transformer production eval",
        createdAt,
        updatedAt: createdAt,
      });
      insertConnectedRepository(db, {
        id: repositoryId,
        tenantId,
        connectionId: "connection-production-eval",
        remoteId: `${tenantId}/${repositoryId}`,
        owner: tenantId,
        name: repositoryId,
        defaultBranch: "main",
        status: "ready",
        createdAt,
        updatedAt: createdAt,
      });
      insertRepositorySnapshot(db, {
        id: "snapshot-production-eval",
        tenantId,
        repositoryId,
        requestedRef: "main",
        resolvedSha: sourceRevision,
        manifestSha256: "e".repeat(64),
        storagePath: snapshotRoot,
        createdAt,
        expiresAt,
      });
      insertRepositorySnapshotFiles(db, {
        tenantId,
        snapshotId: "snapshot-production-eval",
        files: Object.entries({ ...FILES, "private.env": SECRET_SENTINEL }).map(
          ([path, content]) => ({
            path,
            mode: path === ".nvmrc" ? "100755" : "100644",
            kind: "file",
            size: Buffer.byteLength(content, "utf8"),
            sha256: createHash("sha256").update(content, "utf8").digest("hex"),
          }),
        ),
      });
      const constraints = createOrganizationConstraintContract({
        tenantId,
        organizationId: "organization-production-eval",
        version: 1,
        effectiveAt: createdAt,
        sources: [{
          id: "policy-production-eval",
          kind: "explicit_policy",
          repositoryId,
          revision: sourceRevision,
          digest: `sha256:${"d".repeat(64)}`,
          locator: "policy://organization-production-eval/repository-production-eval/v1",
          evidenceRefs: ["evidence:production-eval-policy"],
        }],
        rules: [{
          id: "allow-production-eval-recipe",
          sourceId: "policy-production-eval",
          repositoryId,
          pathPattern: "**",
          actions: ["change"],
          effect: "allow",
          ownerIds: ["owner-production-eval"],
          rationale: "Approved held out migration fixture",
        }],
      });
      store.createCampaign({
        tenantId,
        organizationId: "organization-production-eval",
        environment: "staging",
        campaignId,
        constraints,
        units: [{
          id: unitId,
          title: "Migrate the held out repository",
          ownerId: "owner-production-eval",
          reviewerIds: ["reviewer-production-eval"],
          dependsOn: [],
          snapshot: {
            snapshotId: "snapshot-production-eval",
            repositoryId,
            revision: sourceRevision,
            manifestSha256: "e".repeat(64),
            digest: recipeFilesDigest(runnerFiles),
            evidenceRefs: ["evidence:production-eval-snapshot"],
          },
          candidateRevision,
          candidateDigest: PRODUCTION_GOLD_DIGEST,
          changedPaths: PRODUCTION_CHANGED_PATHS,
          recipe: reference,
        }],
        observedAt: createdAt,
        evidenceRefs: ["evidence:production-eval-campaign"],
        idempotencyKey: "create-production-eval-campaign",
        gateConfig,
      });

      const started = Date.now();
      const result = await runTransformerPilotLaneOnce({
        db,
        store,
        gateConfig,
        tenantId,
        workerId: "worker-production-eval",
        evidenceRoot,
        candidateRoot,
        tempRoot: workspaceRoot,
        leaseDurationMs: 15 * 60_000,
        maxCampaigns: 1,
        now: () => runAt,
        runId: "run-production-eval",
        leaseToken: () => token,
      });
      const durationMs = Date.now() - started;
      const campaign = store.getCampaign(tenantId, campaignId);
      const unit = campaign?.units.find((candidate) => candidate.id === unitId);
      const events = store.listEvents(tenantId, campaignId);
      const completed = events.filter((event) => event.type === "attempt.completed").length;
      const failed = events.filter((event) => event.type === "attempt.failed").length;
      const deliveryEvents = events.filter((event) =>
        event.type.startsWith("delivery.") || event.type.startsWith("scm.")
      );
      const manifestPath = filesUnder(candidateRoot).find((path) => path.endsWith("manifest.json"));
      const manifestText = manifestPath ? readFileSync(manifestPath, "utf8") : "";
      const manifest = manifestText
        ? JSON.parse(manifestText) as TransformerCandidateManifest
        : undefined;
      const candidateFilesRoot = manifestPath ? join(dirname(manifestPath), "files") : "";
      const candidateFiles: RecipeFiles = manifest && candidateFilesRoot
        ? Object.freeze(Object.fromEntries(manifest.files.map((file) => [
            file.path,
            readFileSync(join(candidateFilesRoot, ...file.path.split("/")), "utf8"),
          ])))
        : Object.freeze({});
      materializeFiles(candidateJudgeRoot, FILES);
      materializeFiles(candidateJudgeRoot, candidateFiles);

      const baselineTarget = runIndependentVerifier(snapshotRoot, TARGET_VERIFIER_SCRIPT);
      const candidateTarget = runIndependentVerifier(candidateJudgeRoot, TARGET_VERIFIER_SCRIPT);
      const baselineRegression = runIndependentVerifier(snapshotRoot, REGRESSION_VERIFIER_SCRIPT);
      const candidateRegression = runIndependentVerifier(candidateJudgeRoot, REGRESSION_VERIFIER_SCRIPT);
      const goldFixtureValid = recipeFilesDigest(PRODUCTION_GOLD_FILES) === PRODUCTION_GOLD_DIGEST;
      const exactGold = sameFiles(candidateFiles, PRODUCTION_GOLD_FILES);
      const targetTransition = !baselineTarget.passed && candidateTarget.passed;
      const passToPass = baselineRegression.passed && candidateRegression.passed;
      const noDeliverySideEffects = unit?.state === "executed" &&
        (unit.scmEvidenceRefs?.length ?? 0) === 0 && deliveryEvents.length === 0;
      const persistedPaths = [...filesUnder(candidateRoot), ...filesUnder(evidenceRoot)];
      const sensitivePersistence = persistedPaths.some((path) => {
        const value = readFileSync(path, "utf8");
        return value.includes(SECRET_SENTINEL) || value.includes(token);
      });
      const executionEvidencePath = filesUnder(evidenceRoot).find((path) =>
        path.endsWith(".json") && readFileSync(path, "utf8").includes("transformer.recipe.execution")
      );
      const executionEvidence = executionEvidencePath
        ? JSON.parse(readFileSync(executionEvidencePath, "utf8")) as {
            commands?: Array<{ id: string; exitCode: number }>;
            operationCount?: number;
            outputDigest?: string;
          }
        : undefined;
      const evidenceBytes = filesUnder(evidenceRoot)
        .reduce((total, path) => total + Buffer.byteLength(readFileSync(path)), 0);
      const passed = result.completed === 1 && result.failed === 0 && result.stale === 0 &&
        completed === 1 && failed === 0 && goldFixtureValid && exactGold && targetTransition &&
        passToPass && noDeliverySideEffects && !sensitivePersistence;
      const observation: AgentEvalObservation = Object.freeze({
        disposition: passed ? "passed" : "failed",
        semanticDigest: agentEvalDigest({
          lane: result,
          unitState: unit?.state,
          completed,
          failed,
          exactGold,
          targetTransition,
          passToPass,
          deliveryEvents: deliveryEvents.map((event) => event.type),
          sensitivePersistence,
          commands: executionEvidence?.commands,
          outputDigest: executionEvidence?.outputDigest,
        }),
        metrics: Object.freeze({
          durationMs,
          steps: events.length,
          changedFiles: executionEvidence?.operationCount ?? 0,
          changedBytes: Object.values(candidateFiles)
            .reduce((total, content) => total + Buffer.byteLength(content, "utf8"), 0),
          evidenceBytes,
        }),
        details: Object.freeze({
          lane: result,
          unitState: unit?.state ?? null,
          completed,
          failed,
          exactGold,
          targetTransition,
          passToPass,
          deliveryEvents: deliveryEvents.map((event) => event.type),
          sensitivePersistence,
          commands: executionEvidence?.commands ?? [],
          durableCandidate: Boolean(manifestPath),
        }),
      });
      const grades = Object.freeze([
        evalGrade({
          id: "runner.end_to_end_completion",
          critical: true,
          passed: result.completed === 1 && result.failed === 0 && result.stale === 0 &&
            completed === 1 && failed === 0 && unit?.state === "executed",
          expected: "real worker lane completes one durable attempt",
          observed: { lane: result, completed, failed, unitState: unit?.state ?? null },
        }),
        evalGrade({
          id: "runner.fixed_gold_candidate",
          critical: true,
          passed: goldFixtureValid && exactGold && manifest?.candidate.digest === PRODUCTION_GOLD_DIGEST &&
            executionEvidence?.outputDigest === PRODUCTION_GOLD_DIGEST,
          expected: PRODUCTION_GOLD_DIGEST,
          observed: {
            goldFixtureValid,
            exactGold,
            manifestDigest: manifest?.candidate.digest ?? "missing",
            evidenceDigest: executionEvidence?.outputDigest ?? "missing",
          },
        }),
        evalGrade({
          id: "runner.fail_to_pass_target",
          critical: true,
          passed: targetTransition,
          expected: "baseline target verifier fails and candidate target verifier passes",
          observed: { baseline: baselineTarget, candidate: candidateTarget },
        }),
        evalGrade({
          id: "runner.pass_to_pass_regression",
          critical: true,
          passed: passToPass,
          expected: "independent regression verifier passes before and after migration",
          observed: { baseline: baselineRegression, candidate: candidateRegression },
        }),
        evalGrade({
          id: "runner.real_verification_commands",
          critical: true,
          passed: executionEvidence?.commands?.length === 2 &&
            executionEvidence.commands.every((command) => command.exitCode === 0),
          expected: "two real allowlisted commands with exit code zero",
          observed: executionEvidence?.commands ?? [],
        }),
        evalGrade({
          id: "runner.no_delivery_side_effect",
          critical: true,
          passed: noDeliverySideEffects,
          expected: "executed state with no SCM evidence or delivery event",
          observed: {
            unitState: unit?.state ?? null,
            scmEvidenceRefs: unit?.scmEvidenceRefs ?? [],
            deliveryEvents: deliveryEvents.map((event) => event.type),
          },
        }),
        evalGrade({
          id: "runner.secret_boundary",
          critical: true,
          passed: !sensitivePersistence,
          expected: "candidate artifacts and evidence contain no source sentinel or lease token",
          observed: sensitivePersistence ? "sensitive text present" : "sensitive text absent",
        }),
        evalGrade({
          id: "runner.workspace_cleanup",
          critical: true,
          passed: workspaceCount(workspaceRoot) === 0,
          expected: 0,
          observed: workspaceCount(workspaceRoot),
        }),
      ]);
      return Object.freeze({ observation, grades });
    } finally {
      store.close();
      db.raw.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
});

const AWS_SDK_EXECUTION_SCENARIO: AgentEvalScenario = Object.freeze({
  id: "transformer.execute.aws_sdk_v2_to_v3.heldout",
  product: "transformer",
  family: "recipe_execution",
  tier: "common",
  critical: true,
  sourceRefs: Object.freeze([AWS_SDK_UPGRADE_GUIDE, SWE_BENCH, HARBOR_TASKS]),
  deterministic: true,
  budget: Object.freeze({
    maxDurationMs: 10_000,
    maxSteps: 12,
    maxChangedFiles: 3,
    maxChangedBytes: 128 * 1024,
    maxEvidenceBytes: 128 * 1024,
  }),
  run: async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-transformer-aws-sdk-eval-"));
    const tempRoot = join(root, "workspaces");
    const evidenceDirectory = join(root, "evidence");
    const started = Date.now();
    try {
      // Publish -> sign -> resolve through the real run-path catalog seam.
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const keyId = "aws-sdk-eval-key-2026-08";
      const catalog = createPublishedProviderRecipeCatalog({
        signedArtifacts: signPublishedProviderRecipes({ keyId, privateKey }),
        trustedKeys: [{ keyId, algorithm: "ed25519", publicKey }],
        now: "2026-08-06T00:00:00.000Z",
      });
      const resolved = catalog.resolve({
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
      });
      const reference = resolved.artifact.boundedEdits.implementationRecipe;
      const resolutionBinds = reference.digest === AWS_SDK_JS_V2_TO_V3_RECIPE.digest &&
        reference.id === AWS_SDK_JS_V2_TO_V3_RECIPE.id;

      const files = loadAwsFixture("before", AWS_SUPPORTED_PATHS);
      const fileModes = Object.freeze(
        Object.fromEntries(Object.keys(files).map((path) => [path, "100644"])),
      ) as Record<string, "100644" | "100755">;
      const fence: RecipeExecutionFence = Object.freeze({
        tenantId: "tenant-aws-eval",
        campaignId: "campaign-aws-eval",
        unitId: "unit-aws-eval",
        attemptId: "attempt-aws-eval",
        leaseGeneration: 3,
        leaseToken: "transformer-aws-eval-lease-token",
      });

      const execution = await executeRecipeInWorkspace({
        fence,
        assertFence: () => true,
        source: {
          repositoryId: "repository-aws-eval",
          revision: "b".repeat(40),
          digest: recipeFilesDigest(files),
          files,
          fileModes,
        },
        recipe: reference,
        evidenceDirectory,
        tempRoot,
        observedAt: "2026-08-06T00:01:00.000Z",
      });
      const restore = await restoreRecipeExecutionInWorkspace({
        execution,
        currentFiles: execution.outputFiles,
        fence,
        assertFence: () => true,
        evidenceDirectory,
        tempRoot,
        observedAt: "2026-08-06T00:02:00.000Z",
      });

      const durationMs = Date.now() - started;
      const operations = execution.operations.map((operation) => operation.path).sort();
      const commandsPassed = execution.commands.length === 2 &&
        execution.commands.every((command) => command.exitCode === 0);
      const leaks = workspaceCount(tempRoot);
      const restoredExact = restore.outputDigest === execution.inputDigest;
      const evidenceText = existsSync(execution.evidence.path)
        ? readFileSync(execution.evidence.path, "utf8")
        : "";
      const observation: AgentEvalObservation = Object.freeze({
        disposition: "passed",
        semanticDigest: agentEvalDigest({
          resolutionBinds,
          status: execution.analysis.status,
          operations,
          inputDigest: execution.inputDigest,
          outputDigest: execution.outputDigest,
          restoredDigest: restore.outputDigest,
          commands: execution.commands.map((command) => [command.id, command.exitCode]),
        }),
        metrics: Object.freeze({
          durationMs,
          steps: execution.commands.length + 2,
          changedFiles: operations.length,
          changedBytes: Buffer.byteLength(JSON.stringify(execution.outputFiles), "utf8"),
          evidenceBytes: Buffer.byteLength(evidenceText, "utf8"),
        }),
        details: Object.freeze({
          resolutionBinds,
          status: execution.analysis.status,
          operations,
          commands: execution.commands.map((command) => `${command.id}:${command.exitCode}`),
          restoredExact,
          workspaceLeaks: leaks,
        }),
      });
      const grades = Object.freeze([
        evalGrade({
          id: "catalog.resolves_executable_recipe",
          critical: true,
          passed: resolutionBinds,
          expected: "published catalog resolves aws-sdk-js v2->v3 to the executable recipe digest",
          observed: { digest: reference.digest, id: reference.id },
        }),
        evalGrade({
          id: "recipe.applies_on_supported_fixture",
          critical: true,
          passed: execution.analysis.status === "applicable" &&
            operations.join(",") === "package.json,src/dynamo.js,src/s3.js",
          expected: "applicable analysis with three allowlisted operations",
          observed: { status: execution.analysis.status, operations },
        }),
        evalGrade({
          id: "recipe.verification_passes",
          critical: true,
          passed: commandsPassed,
          expected: "two allowlisted verification commands with exit code zero",
          observed: execution.commands.map((command) => `${command.id}:${command.exitCode}`),
        }),
        evalGrade({
          id: "recipe.allowlisted_paths",
          critical: true,
          passed: operations.every((path) => AWS_SDK_JS_V2_TO_V3_RECIPE.allowedPaths.includes(path)),
          expected: AWS_SDK_JS_V2_TO_V3_RECIPE.allowedPaths,
          observed: operations,
        }),
        evalGrade({
          id: "recipe.inverse_restores_exact_input",
          critical: true,
          passed: restoredExact,
          expected: execution.inputDigest,
          observed: restore.outputDigest,
        }),
        evalGrade({
          id: "workspace.disposed",
          critical: true,
          passed: leaks === 0,
          expected: 0,
          observed: leaks,
        }),
      ]);
      return Object.freeze({ observation, grades });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
});

const AWS_SDK_ABSTAIN_SCENARIO: AgentEvalScenario = Object.freeze({
  id: "transformer.analysis.aws_sdk_abstain.heldout",
  product: "transformer",
  family: "recipe_analysis",
  tier: "adversarial",
  critical: true,
  sourceRefs: Object.freeze([AWS_SDK_UPGRADE_GUIDE, INSPECT_SCORING]),
  deterministic: true,
  budget: Object.freeze({
    maxDurationMs: 2_000,
    maxSteps: 6,
    maxChangedFiles: 0,
    maxChangedBytes: 0,
    maxEvidenceBytes: 32 * 1024,
  }),
  run: async () => {
    const started = Date.now();
    const reference = recipeReference(AWS_SDK_JS_V2_TO_V3_RECIPE);
    const supported = loadAwsFixture("before", AWS_SUPPORTED_PATHS);
    const outOfScope = loadAwsFixture("out-of-scope", ["package.json", "src/s3.js"]);

    const supportedAnalysis = analyzeRecipe(reference, supported);
    const abstainAnalysis = analyzeRecipe(reference, outOfScope);
    const migrated = applyRecipe(reference, supported);
    const idempotentAnalysis = analyzeRecipe(reference, migrated.files);

    const durationMs = Date.now() - started;
    const applicable = supportedAnalysis.status === "applicable" &&
      [...supportedAnalysis.matchedPaths].sort().join(",") ===
        "package.json,src/dynamo.js,src/s3.js";
    const abstains = abstainAnalysis.status === "unsupported" &&
      abstainAnalysis.reasons.includes("recipe_aws_unsupported_service:SQS") &&
      abstainAnalysis.matchedPaths.length === 0;
    const idempotent = idempotentAnalysis.status === "already_applied";
    const observation: AgentEvalObservation = Object.freeze({
      disposition: applicable && abstains && idempotent ? "passed" : "failed",
      semanticDigest: agentEvalDigest({
        supported: supportedAnalysis.status,
        matched: [...supportedAnalysis.matchedPaths].sort(),
        abstain: abstainAnalysis.status,
        reasons: [...abstainAnalysis.reasons].sort(),
        idempotent: idempotentAnalysis.status,
      }),
      metrics: Object.freeze({
        durationMs,
        steps: 3,
        changedFiles: 0,
        changedBytes: 0,
        evidenceBytes: 0,
      }),
      details: Object.freeze({
        supported: supportedAnalysis.status,
        abstain: abstainAnalysis.status,
        abstainReasons: abstainAnalysis.reasons,
        idempotent: idempotentAnalysis.status,
      }),
    });
    return Object.freeze({
      observation,
      grades: Object.freeze([
        evalGrade({
          id: "analysis.supported_is_applicable",
          critical: true,
          passed: applicable,
          expected: "applicable with three matched allowlisted paths",
          observed: { status: supportedAnalysis.status, matched: supportedAnalysis.matchedPaths },
        }),
        evalGrade({
          id: "analysis.out_of_scope_abstains",
          critical: true,
          passed: abstains,
          expected: "unsupported analysis naming the out-of-scope service, zero matched paths",
          observed: { status: abstainAnalysis.status, reasons: abstainAnalysis.reasons },
        }),
        evalGrade({
          id: "analysis.idempotent_already_applied",
          critical: true,
          passed: idempotent,
          expected: "already_applied",
          observed: idempotentAnalysis.status,
        }),
      ]),
    });
  },
});

// ---------------------------------------------------------------------------
// Held-out contract-lane evals for the additional signed SDK migration recipes
// (stripe-node v10->v11 and googleapis v25->v26). Each recipe gets one
// execution scenario (publish -> sign -> resolve -> execute -> verify ->
// inverse-restore through the real catalog seam) and one analysis scenario
// (applies on the supported fixture, abstains on the out-of-scope fixture,
// reports already_applied on migrated sources). No live model is used.
// ---------------------------------------------------------------------------

type SdkRecipeEvalConfig = Readonly<{
  idSlug: string;
  recipe: MigrationRecipeContract;
  fixtureDir: string;
  supportedPaths: readonly string[];
  outOfScopePaths: readonly string[];
  operationsCsv: string;
  abstainReason: string;
  guideUrl: string;
  query: ProviderRecipeResolution;
  fence: RecipeExecutionFence;
  maxChangedFiles?: number;
}>;

function loadRecipeFixture(dir: string, sub: string, paths: readonly string[]): RecipeFiles {
  const files: Record<string, string> = {};
  for (const path of paths) {
    files[path] = readFileSync(
      fileURLToPath(new URL(`../../../fixtures/consumers/${dir}/${sub}/${path}`, import.meta.url)),
      "utf8",
    );
  }
  return Object.freeze(files);
}

function sdkExecutionScenario(config: SdkRecipeEvalConfig): AgentEvalScenario {
  return Object.freeze({
    id: `transformer.execute.${config.idSlug}.heldout`,
    product: "transformer",
    family: "recipe_execution",
    tier: "common",
    critical: true,
    sourceRefs: Object.freeze([config.guideUrl, SWE_BENCH, HARBOR_TASKS]),
    deterministic: true,
    budget: Object.freeze({
      maxDurationMs: 10_000,
      maxSteps: 12,
      maxChangedFiles: config.maxChangedFiles ?? 3,
      maxChangedBytes: 128 * 1024,
      maxEvidenceBytes: 128 * 1024,
    }),
    run: async () => {
      const root = mkdtempSync(join(tmpdir(), `mendpoint-transformer-${config.idSlug}-eval-`));
      const tempRoot = join(root, "workspaces");
      const evidenceDirectory = join(root, "evidence");
      const started = Date.now();
      try {
        // Publish -> sign -> resolve through the real run-path catalog seam.
        const { privateKey, publicKey } = generateKeyPairSync("ed25519");
        const keyId = `${config.idSlug.replace(/_/g, "-")}-eval-key-2026-08`;
        const catalog = createPublishedProviderRecipeCatalog({
          signedArtifacts: signPublishedProviderRecipes({ keyId, privateKey }),
          trustedKeys: [{ keyId, algorithm: "ed25519", publicKey }],
          now: "2026-08-06T00:00:00.000Z",
        });
        const resolved = catalog.resolve(config.query);
        const reference = resolved.artifact.boundedEdits.implementationRecipe;
        const resolutionBinds = reference.digest === config.recipe.digest &&
          reference.id === config.recipe.id;

        const files = loadRecipeFixture(config.fixtureDir, "before", config.supportedPaths);
        const fileModes = Object.freeze(
          Object.fromEntries(Object.keys(files).map((path) => [path, "100644"])),
        ) as Record<string, "100644" | "100755">;

        const execution = await executeRecipeInWorkspace({
          fence: config.fence,
          assertFence: () => true,
          source: {
            repositoryId: `repository-${config.idSlug}-eval`,
            revision: "b".repeat(40),
            digest: recipeFilesDigest(files),
            files,
            fileModes,
          },
          recipe: reference,
          evidenceDirectory,
          tempRoot,
          observedAt: "2026-08-06T00:01:00.000Z",
        });
        const restore = await restoreRecipeExecutionInWorkspace({
          execution,
          currentFiles: execution.outputFiles,
          fence: config.fence,
          assertFence: () => true,
          evidenceDirectory,
          tempRoot,
          observedAt: "2026-08-06T00:02:00.000Z",
        });

        const durationMs = Date.now() - started;
        const operations = execution.operations.map((operation) => operation.path).sort();
        const commandsPassed = execution.commands.length === 2 &&
          execution.commands.every((command) => command.exitCode === 0);
        const leaks = workspaceCount(tempRoot);
        const restoredExact = restore.outputDigest === execution.inputDigest;
        const evidenceText = existsSync(execution.evidence.path)
          ? readFileSync(execution.evidence.path, "utf8")
          : "";
        const observation: AgentEvalObservation = Object.freeze({
          disposition: "passed",
          semanticDigest: agentEvalDigest({
            resolutionBinds,
            status: execution.analysis.status,
            operations,
            inputDigest: execution.inputDigest,
            outputDigest: execution.outputDigest,
            restoredDigest: restore.outputDigest,
            commands: execution.commands.map((command) => [command.id, command.exitCode]),
          }),
          metrics: Object.freeze({
            durationMs,
            steps: execution.commands.length + 2,
            changedFiles: operations.length,
            changedBytes: Buffer.byteLength(JSON.stringify(execution.outputFiles), "utf8"),
            evidenceBytes: Buffer.byteLength(evidenceText, "utf8"),
          }),
          details: Object.freeze({
            resolutionBinds,
            status: execution.analysis.status,
            operations,
            commands: execution.commands.map((command) => `${command.id}:${command.exitCode}`),
            restoredExact,
            workspaceLeaks: leaks,
          }),
        });
        const grades = Object.freeze([
          evalGrade({
            id: "catalog.resolves_executable_recipe",
            critical: true,
            passed: resolutionBinds,
            expected: "published catalog resolves the migration to the executable recipe digest",
            observed: { digest: reference.digest, id: reference.id },
          }),
          evalGrade({
            id: "recipe.applies_on_supported_fixture",
            critical: true,
            passed: execution.analysis.status === "applicable" &&
              operations.join(",") === config.operationsCsv,
            expected: `applicable analysis with operations ${config.operationsCsv}`,
            observed: { status: execution.analysis.status, operations },
          }),
          evalGrade({
            id: "recipe.verification_passes",
            critical: true,
            passed: commandsPassed,
            expected: "two allowlisted verification commands with exit code zero",
            observed: execution.commands.map((command) => `${command.id}:${command.exitCode}`),
          }),
          evalGrade({
            id: "recipe.allowlisted_paths",
            critical: true,
            passed: operations.every((path) => config.recipe.allowedPaths.includes(path)),
            expected: config.recipe.allowedPaths,
            observed: operations,
          }),
          evalGrade({
            id: "recipe.inverse_restores_exact_input",
            critical: true,
            passed: restoredExact,
            expected: execution.inputDigest,
            observed: restore.outputDigest,
          }),
          evalGrade({
            id: "workspace.disposed",
            critical: true,
            passed: leaks === 0,
            expected: 0,
            observed: leaks,
          }),
        ]);
        return Object.freeze({ observation, grades });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  });
}

function sdkAbstainScenario(config: SdkRecipeEvalConfig): AgentEvalScenario {
  return Object.freeze({
    id: `transformer.analysis.${config.idSlug}_abstain.heldout`,
    product: "transformer",
    family: "recipe_analysis",
    tier: "adversarial",
    critical: true,
    sourceRefs: Object.freeze([config.guideUrl, INSPECT_SCORING]),
    deterministic: true,
    budget: Object.freeze({
      maxDurationMs: 2_000,
      maxSteps: 6,
      maxChangedFiles: 0,
      maxChangedBytes: 0,
      maxEvidenceBytes: 32 * 1024,
    }),
    run: async () => {
      const started = Date.now();
      const reference = recipeReference(config.recipe);
      const supported = loadRecipeFixture(config.fixtureDir, "before", config.supportedPaths);
      const outOfScope = loadRecipeFixture(config.fixtureDir, "out-of-scope", config.outOfScopePaths);

      const supportedAnalysis = analyzeRecipe(reference, supported);
      const abstainAnalysis = analyzeRecipe(reference, outOfScope);
      const migrated = applyRecipe(reference, supported);
      const idempotentAnalysis = analyzeRecipe(reference, migrated.files);

      const durationMs = Date.now() - started;
      const applicable = supportedAnalysis.status === "applicable" &&
        [...supportedAnalysis.matchedPaths].sort().join(",") === config.operationsCsv;
      const abstains = abstainAnalysis.status === "unsupported" &&
        abstainAnalysis.reasons.includes(config.abstainReason) &&
        abstainAnalysis.matchedPaths.length === 0;
      const idempotent = idempotentAnalysis.status === "already_applied";
      const observation: AgentEvalObservation = Object.freeze({
        disposition: applicable && abstains && idempotent ? "passed" : "failed",
        semanticDigest: agentEvalDigest({
          supported: supportedAnalysis.status,
          matched: [...supportedAnalysis.matchedPaths].sort(),
          abstain: abstainAnalysis.status,
          reasons: [...abstainAnalysis.reasons].sort(),
          idempotent: idempotentAnalysis.status,
        }),
        metrics: Object.freeze({
          durationMs,
          steps: 3,
          changedFiles: 0,
          changedBytes: 0,
          evidenceBytes: 0,
        }),
        details: Object.freeze({
          supported: supportedAnalysis.status,
          abstain: abstainAnalysis.status,
          abstainReasons: abstainAnalysis.reasons,
          idempotent: idempotentAnalysis.status,
        }),
      });
      return Object.freeze({
        observation,
        grades: Object.freeze([
          evalGrade({
            id: "analysis.supported_is_applicable",
            critical: true,
            passed: applicable,
            expected: `applicable with matched paths ${config.operationsCsv}`,
            observed: { status: supportedAnalysis.status, matched: supportedAnalysis.matchedPaths },
          }),
          evalGrade({
            id: "analysis.out_of_scope_abstains",
            critical: true,
            passed: abstains,
            expected: `unsupported analysis with reason ${config.abstainReason}, zero matched paths`,
            observed: { status: abstainAnalysis.status, reasons: abstainAnalysis.reasons },
          }),
          evalGrade({
            id: "analysis.idempotent_already_applied",
            critical: true,
            passed: idempotent,
            expected: "already_applied",
            observed: idempotentAnalysis.status,
          }),
        ]),
      });
    },
  });
}

const STRIPE_NODE_EVAL_CONFIG: SdkRecipeEvalConfig = Object.freeze({
  idSlug: "stripe_node_v10_to_v11",
  recipe: STRIPE_NODE_V10_TO_V11_RECIPE,
  fixtureDir: "stripe-node-v10-to-v11",
  supportedPaths: ["package.json", "src/payments.js"],
  outOfScopePaths: ["package.json", "src/payments.js"],
  operationsCsv: "package.json,src/payments.js",
  abstainReason: "recipe_stripe_unsupported_setter:setApiKey",
  guideUrl: STRIPE_NODE_UPGRADE_GUIDE,
  query: Object.freeze({
    providerSlug: "stripe-node",
    providerCategory: "payments",
    changeTarget: "sdk",
    changeKind: "breaking",
    fromVersion: "10",
    toVersion: "11",
    language: "javascript",
    packageManager: "npm",
    repositoryKind: "service",
    runtime: { name: "node", major: 20 },
  }),
  fence: Object.freeze({
    tenantId: "tenant-stripe-eval",
    campaignId: "campaign-stripe-eval",
    unitId: "unit-stripe-eval",
    attemptId: "attempt-stripe-eval",
    leaseGeneration: 3,
    leaseToken: "transformer-stripe-eval-lease-token",
  }),
});

const GOOGLEAPIS_EVAL_CONFIG: SdkRecipeEvalConfig = Object.freeze({
  idSlug: "googleapis_v25_to_v26",
  recipe: GOOGLEAPIS_V25_TO_V26_RECIPE,
  fixtureDir: "googleapis-v25-to-v26",
  supportedPaths: ["package.json", "src/client.js"],
  outOfScopePaths: ["package.json", "src/client.js"],
  operationsCsv: "package.json,src/client.js",
  abstainReason: "recipe_googleapis_import_unrecognized",
  guideUrl: GOOGLEAPIS_UPGRADE_GUIDE,
  query: Object.freeze({
    providerSlug: "googleapis",
    providerCategory: "developer_platform",
    changeTarget: "sdk",
    changeKind: "breaking",
    fromVersion: "25",
    toVersion: "26",
    language: "javascript",
    packageManager: "npm",
    repositoryKind: "service",
    runtime: { name: "node", major: 20 },
  }),
  fence: Object.freeze({
    tenantId: "tenant-googleapis-eval",
    campaignId: "campaign-googleapis-eval",
    unitId: "unit-googleapis-eval",
    attemptId: "attempt-googleapis-eval",
    leaseGeneration: 3,
    leaseToken: "transformer-googleapis-eval-lease-token",
  }),
});

const REACT_DOM_EVAL_CONFIG: SdkRecipeEvalConfig = Object.freeze({
  idSlug: "react_dom_17_to_18",
  recipe: REACT_DOM_17_TO_18_RECIPE,
  fixtureDir: "react-dom-17-to-18",
  supportedPaths: ["package.json", "src/index.jsx"],
  outOfScopePaths: ["package.json", "src/index.jsx"],
  operationsCsv: "package.json,src/index.jsx",
  abstainReason: "recipe_react_render_callback",
  guideUrl: REACT_18_UPGRADE_GUIDE,
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
  fence: Object.freeze({
    tenantId: "tenant-react-eval",
    campaignId: "campaign-react-eval",
    unitId: "unit-react-eval",
    attemptId: "attempt-react-eval",
    leaseGeneration: 3,
    leaseToken: "transformer-react-eval-lease-token",
  }),
});

const NODE_RUNTIME_EVAL_CONFIG: SdkRecipeEvalConfig = Object.freeze({
  idSlug: "node_runtime_20_to_22",
  recipe: NODE_RUNTIME_20_TO_22_RECIPE,
  fixtureDir: "node-runtime-20-to-22",
  supportedPaths: [".node-version", ".nvmrc", "Dockerfile", "package.json"],
  outOfScopePaths: [".node-version", ".nvmrc", "Dockerfile", "package.json"],
  operationsCsv: ".node-version,.nvmrc,Dockerfile,package.json",
  abstainReason: "recipe_precondition_failed:Dockerfile:node_major",
  guideUrl: NODE_22_RELEASE_NOTES,
  maxChangedFiles: 4,
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
  fence: Object.freeze({
    tenantId: "tenant-node-runtime-eval",
    campaignId: "campaign-node-runtime-eval",
    unitId: "unit-node-runtime-eval",
    attemptId: "attempt-node-runtime-eval",
    leaseGeneration: 3,
    leaseToken: "transformer-node-runtime-eval-lease-token",
  }),
});

export const TRANSFORMER_AGENT_EVAL_SCENARIOS: readonly AgentEvalScenario[] = Object.freeze([
  PLANNING_SCENARIO,
  ANALYSIS_SCENARIO,
  PRODUCTION_RUNNER_SCENARIO,
  AWS_SDK_EXECUTION_SCENARIO,
  AWS_SDK_ABSTAIN_SCENARIO,
  sdkExecutionScenario(STRIPE_NODE_EVAL_CONFIG),
  sdkAbstainScenario(STRIPE_NODE_EVAL_CONFIG),
  sdkExecutionScenario(GOOGLEAPIS_EVAL_CONFIG),
  sdkAbstainScenario(GOOGLEAPIS_EVAL_CONFIG),
  sdkExecutionScenario(REACT_DOM_EVAL_CONFIG),
  sdkAbstainScenario(REACT_DOM_EVAL_CONFIG),
  sdkExecutionScenario(NODE_RUNTIME_EVAL_CONFIG),
  sdkAbstainScenario(NODE_RUNTIME_EVAL_CONFIG),
  ...WORKSPACE_CASES.map(workspaceScenario),
]);
