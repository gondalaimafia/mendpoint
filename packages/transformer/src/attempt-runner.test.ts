import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import {
  runTransformerAttempt,
  type RunTransformerAttemptInput,
  type TransformerAttemptCoordinatorPort,
  type TransformerExecutableAttemptLease,
} from "./attempt-runner.js";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  applyRecipe,
  recipeFilesDigest,
  recipeReference,
  type RecipeFiles,
} from "./recipe.js";
import type {
  AdaptiveGate,
  AdaptiveRepairPlanner,
  AdaptiveVerifierResult,
} from "./adaptive-loop.js";
import { TransformerPilotExecutionStore } from "./pilot-execution.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FILES: RecipeFiles = Object.freeze({
  "package.json": `${JSON.stringify({
    name: "transformer-runner-fixture",
    private: true,
    engines: { node: ">=18 <19" },
  }, null, 2)}\n`,
  ".nvmrc": "18\n",
  ".node-version": "18.20.4\n",
  Dockerfile: "FROM node:18-alpine\nWORKDIR /app\n",
  "src/server.js": "export const ready = true;\n",
});

const LEASE_TOKEN = "lease-token-transformer-attempt-00000001";
const SOURCE_REVISION = "a".repeat(40);
const CANDIDATE_REVISION = "c".repeat(40);
const SOURCE_DIGEST = recipeFilesDigest(FILES);
const RECIPE = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
const APPLICATION = applyRecipe(RECIPE, FILES);

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function gateConfig(): string {
  return JSON.stringify({
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantAllowlist: ["tenant-a"],
    environmentAllowlist: ["staging"],
    grants: [{
      tenantId: "tenant-a",
      environment: "staging",
      boundaries: ["worker_action"],
      acceptanceEvidenceRefs: ["acceptance:transformer-runner:v1"],
      productionDeliveryApprovalRefs: [],
    }],
  });
}

function lease(overrides: Partial<TransformerExecutableAttemptLease> = {}): TransformerExecutableAttemptLease {
  return {
    type: "execute_recipe",
    tenantId: "tenant-a",
    campaignId: "campaign-a",
    unitId: "unit-a",
    attemptNumber: 1,
    leaseGeneration: 1,
    leaseTokenDigest: sha256(LEASE_TOKEN),
    leaseExpiresAt: "2026-08-05T10:05:00.000Z",
    snapshot: {
      snapshotId: "snapshot-repo-a",
      repositoryId: "repo-a",
      revision: SOURCE_REVISION,
      manifestSha256: "a".repeat(64),
      digest: SOURCE_DIGEST,
      evidenceRefs: ["evidence:snapshot:repo-a"],
    },
    recipe: RECIPE,
    constraintVersion: 7,
    constraintDigest: `sha256:${"7".repeat(64)}`,
    gateEvidenceRefs: ["acceptance:transformer-runner:v1"],
    candidateRevision: CANDIDATE_REVISION,
    candidateDigest: APPLICATION.outputDigest,
    changedPaths: APPLICATION.operations.map((operation) => operation.path),
    ...overrides,
  };
}

type CoordinatorSpies = Readonly<{
  claimNextAttempt: ReturnType<typeof vi.fn>;
  assertCurrentAttemptFence: ReturnType<typeof vi.fn>;
  completeAttempt: ReturnType<typeof vi.fn>;
  recordAttemptFailure: ReturnType<typeof vi.fn>;
}>;

function harness(options: Readonly<{
  lease?: TransformerExecutableAttemptLease;
  source?: Readonly<{ repositoryId: string; revision: string; digest: string; files: RecipeFiles }>;
  assertFence?: () => boolean | void;
  commandRunner?: RunTransformerAttemptInput["commandRunner"];
}> = {}) {
  const root = mkdtempSync(join(tmpdir(), "transformer-attempt-runner-"));
  roots.push(root);
  const claimed = options.lease ?? lease();
  const spies: CoordinatorSpies = {
    claimNextAttempt: vi.fn(async () => claimed),
    assertCurrentAttemptFence: vi.fn(async () => options.assertFence?.() ?? true),
    completeAttempt: vi.fn(async () => undefined),
    recordAttemptFailure: vi.fn(async () => undefined),
  };
  const source = options.source ?? {
    repositoryId: "repo-a",
    revision: SOURCE_REVISION,
    digest: SOURCE_DIGEST,
    files: FILES,
  };
  const loadExactSource = vi.fn(async () => source);
  const input: RunTransformerAttemptInput = {
    scope: { tenantId: "tenant-a", environment: "staging", campaignId: "campaign-a" },
    gateConfig: gateConfig(),
    coordinator: spies as unknown as TransformerAttemptCoordinatorPort,
    loadExactSource,
    evidenceRoot: join(root, "evidence"),
    candidateRoot: join(root, "candidates"),
    leaseDurationMs: 60_000,
    tempRoot: join(root, "workspaces"),
    observedAt: (phase) => ({
      claim: "2026-08-05T10:00:00.000Z",
      execute: "2026-08-05T10:01:00.000Z",
      complete: "2026-08-05T10:02:00.000Z",
      failure: "2026-08-05T10:03:00.000Z",
    })[phase],
    idempotencyKey: (phase, attemptId) => `runner:${phase}:${attemptId ?? "claim"}`,
    leaseToken: () => LEASE_TOKEN,
    commandRunner: options.commandRunner ?? (async () => ({ exitCode: 0, stdout: "ok", stderr: "" })),
    actualCostUsd: 0.12,
  };
  return { root, claimed, spies, loadExactSource, input };
}

function recursiveNames(root: string, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? [name, ...recursiveNames(join(root, entry.name), name)] : [name];
  }).sort();
}

describe("Transformer production attempt runner", () => {
  it("accepts the durable pilot store as its structural coordinator port", () => {
    const store = new TransformerPilotExecutionStore();
    const port: TransformerAttemptCoordinatorPort = store;
    expect(port).toBe(store);
    store.close();
  });

  it("executes, fences, and durably persists a canonical candidate before completion", async () => {
    const { input, spies } = harness();
    const result = await runTransformerAttempt(input);

    expect(result.status).toBe("completed");
    expect(result.recoveryCode).toBeUndefined();
    expect(result.artifacts).toHaveLength(1);
    const artifact = result.artifacts[0]!;
    expect(artifact.reused).toBe(false);
    expect(artifact.outputDigest).toBe(APPLICATION.outputDigest);
    expect(readFileSync(artifact.manifestDigestPath, "utf8")).toBe(`${artifact.manifestDigest}\n`);
    const manifest = JSON.parse(readFileSync(artifact.manifestPath, "utf8"));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: "transformer.candidate",
      scope: { tenantId: "tenant-a", campaignId: "campaign-a", unitId: "unit-a" },
      candidate: { revision: CANDIDATE_REVISION, digest: APPLICATION.outputDigest },
      executionEvidence: { id: expect.stringMatching(/^tre_execution_/) },
    });
    for (const [path, content] of Object.entries(APPLICATION.files)) {
      expect(readFileSync(join(artifact.filesDirectory, ...path.split("/")), "utf8")).toBe(content);
    }
    expect(spies.completeAttempt).toHaveBeenCalledWith(expect.objectContaining({
      candidateDigest: APPLICATION.outputDigest,
      verificationPassed: true,
      actualCostUsd: 0.12,
      evidenceRefs: artifact.evidenceRefs,
    }));
    expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
  });

  it("records source drift before executing commands or creating candidate artifacts", async () => {
    const commandRunner = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const source = {
      repositoryId: "repo-a",
      revision: "b".repeat(40),
      digest: SOURCE_DIGEST,
      files: FILES,
    };
    const { input, spies } = harness({ source, commandRunner });
    const result = await runTransformerAttempt(input);

    expect(result).toMatchObject({ status: "failed", recoveryCode: "source_drift" });
    expect(commandRunner).not.toHaveBeenCalled();
    expect(spies.completeAttempt).not.toHaveBeenCalled();
    expect(spies.recordAttemptFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "source_drift",
    }));
    const failureEvidence = result.failureEvidence!;
    const persisted = readFileSync(failureEvidence.path, "utf8");
    expect(sha256(persisted)).toBe(failureEvidence.digest);
    expect(JSON.parse(persisted)).toMatchObject({
      kind: "transformer.attempt.failure",
      evidenceId: failureEvidence.evidenceId,
      recoveryCode: "source_drift",
      errorCode: "transformer_attempt_source_drift",
      rollback: { attempted: false, inverseVerified: false, workspaceDiscarded: true },
    });
    expect(persisted).not.toContain(LEASE_TOKEN);
    expect(spies.recordAttemptFailure).toHaveBeenCalledWith(expect.objectContaining({
      evidenceRefs: expect.arrayContaining([failureEvidence.evidenceId]),
    }));
    expect(recursiveNames(input.candidateRoot)).toEqual([]);
  });

  it("rejects an executed output that does not match the leased candidate digest", async () => {
    const mismatched = lease({ candidateDigest: `sha256:${"0".repeat(64)}` });
    const { input, spies } = harness({ lease: mismatched });
    const result = await runTransformerAttempt(input);

    expect(result).toMatchObject({
      status: "failed",
      recoveryCode: "candidate_drift",
      errorCode: "transformer_attempt_candidate_digest_mismatch",
    });
    expect(spies.completeAttempt).not.toHaveBeenCalled();
    expect(spies.recordAttemptFailure).toHaveBeenCalledWith(expect.objectContaining({ code: "candidate_drift" }));
    expect(recursiveNames(input.candidateRoot)).toEqual([]);
  });

  it("preserves rollback evidence when verification fails", async () => {
    const { input, spies } = harness({
      commandRunner: async () => ({ exitCode: 9, stdout: "", stderr: "verification failed" }),
    });
    const result = await runTransformerAttempt(input);

    expect(result).toMatchObject({
      status: "failed",
      recoveryCode: "verification_failed",
      rollback: { attempted: true, inverseVerified: true, workspaceDiscarded: true },
    });
    expect(spies.recordAttemptFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "verification_failed",
    }));
    const failureEvidence = result.failureEvidence!;
    const persisted = readFileSync(failureEvidence.path, "utf8");
    expect(sha256(persisted)).toBe(failureEvidence.digest);
    expect(JSON.parse(persisted)).toMatchObject({
      recoveryCode: "verification_failed",
      errorCode: expect.stringContaining("recipe_execution_verification_failed"),
      rollback: { attempted: true, inverseVerified: true, workspaceDiscarded: true },
    });
    expect(persisted).not.toContain("verification failed");
    expect(persisted).not.toContain(LEASE_TOKEN);
    expect(spies.completeAttempt).not.toHaveBeenCalled();
  });

  it("contains a stale fence without execution or failure recording", async () => {
    const commandRunner = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const { input, spies, loadExactSource } = harness({ assertFence: () => false, commandRunner });
    const result = await runTransformerAttempt(input);

    expect(result).toMatchObject({ status: "stale" });
    expect(loadExactSource).not.toHaveBeenCalled();
    expect(commandRunner).not.toHaveBeenCalled();
    expect(spies.completeAttempt).not.toHaveBeenCalled();
    expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
  });

  it("rejects source path traversal without writing outside managed roots", async () => {
    const commandRunner = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const { root, input, spies } = harness({
      source: {
        repositoryId: "repo-a",
        revision: SOURCE_REVISION,
        digest: SOURCE_DIGEST,
        files: { "../escape.txt": "escape" },
      },
      commandRunner,
    });
    const result = await runTransformerAttempt(input);

    expect(result).toMatchObject({ status: "failed", recoveryCode: "source_drift" });
    expect(commandRunner).not.toHaveBeenCalled();
    expect(existsSync(join(dirname(root), "escape.txt"))).toBe(false);
    expect(spies.recordAttemptFailure).toHaveBeenCalledTimes(1);
  });

  it("reuses an identical candidate replay without replacing durable artifacts", async () => {
    const { input, spies } = harness();
    const first = await runTransformerAttempt(input);
    const firstArtifact = first.artifacts[0]!;
    const beforeManifest = readFileSync(firstArtifact.manifestPath, "utf8");
    const beforeTree = recursiveNames(input.candidateRoot);

    const replay = await runTransformerAttempt({
      ...input,
      observedAt: (phase) => ({
        claim: "2026-08-05T10:10:00.000Z",
        execute: "2026-08-05T10:11:00.000Z",
        complete: "2026-08-05T10:12:00.000Z",
        failure: "2026-08-05T10:13:00.000Z",
      })[phase],
    });

    expect(replay).toMatchObject({ status: "completed" });
    expect(replay.artifacts[0]).toMatchObject({ directory: firstArtifact.directory, reused: true });
    expect(readFileSync(firstArtifact.manifestPath, "utf8")).toBe(beforeManifest);
    expect(recursiveNames(input.candidateRoot)).toEqual(beforeTree);
    expect(recursiveNames(input.candidateRoot).some((path) => path.includes(".candidate-tmp-"))).toBe(false);
    expect(spies.completeAttempt).toHaveBeenCalledTimes(2);
    expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
  });

  it("fails closed when a replay finds candidate artifact tampering", async () => {
    const { input, spies } = harness();
    const first = await runTransformerAttempt(input);
    const artifact = first.artifacts[0]!;
    writeFileSync(artifact.manifestPath, "{}\n", "utf8");

    const replay = await runTransformerAttempt(input);

    expect(replay).toMatchObject({
      status: "failed",
      recoveryCode: "candidate_drift",
      errorCode: "transformer_candidate_manifest_conflict",
    });
    expect(spies.completeAttempt).toHaveBeenCalledTimes(1);
    expect(spies.recordAttemptFailure).toHaveBeenCalledWith(expect.objectContaining({ code: "candidate_drift" }));
  });

  it("leaves the deterministic success path untouched when adaptive repair is configured", async () => {
    const planner = vi.fn<AdaptiveRepairPlanner>();
    const { input } = harness();
    const result = await runTransformerAttempt({
      ...input,
      adaptiveRepair: { planner },
    });

    // Recipe succeeded, so the adaptive loop never engaged.
    expect(result.status).toBe("completed");
    expect(result.adaptive).toBeUndefined();
    expect(planner).not.toHaveBeenCalled();
  });

  it("engages adaptive repair after verification failure and reports the converged fix", async () => {
    const gate: AdaptiveGate = async (files: RecipeFiles): Promise<AdaptiveVerifierResult> => {
      const app = files["package.json"] ?? "";
      const passed = app.includes("adaptively-fixed");
      return {
        passed,
        failingCommandId: passed ? null : "engine-check",
        output: passed ? "ok" : "engine-check: package.json not adaptively repaired",
        implicatedPaths: ["package.json"],
      };
    };
    const planner: AdaptiveRepairPlanner = async (loopInput) => {
      const file = loopInput.context.find((entry) => entry.path === "package.json")!;
      return {
        plan: {
          edits: [
            {
              path: "package.json",
              observedContentDigest: file.digest,
              nextContent: `${file.content}\n// adaptively-fixed\n`,
            },
          ],
        },
        usage: { modelCalled: true, promptTokens: 64, completionTokens: 12, totalTokens: 76, costUsd: 0.0009 },
      };
    };
    const { input, spies } = harness({
      commandRunner: async () => ({ exitCode: 9, stdout: "", stderr: "verifier failed" }),
    });
    const result = await runTransformerAttempt({ ...input, adaptiveRepair: { planner, gate } });

    // The lease-bound deterministic attempt still fails (the candidate diverges
    // from the pre-approved digest); the adaptive fix is carried in the summary.
    expect(result.status).toBe("failed");
    expect(result.recoveryCode).toBe("verification_failed");
    expect(result.adaptive).toBeDefined();
    expect(result.adaptive).toMatchObject({
      engaged: true,
      outcome: "converged",
      unitsFixedAdaptively: 1,
      unitsMarkedUnfixable: 0,
      usage: { measured: true, modelCalls: 1, totalTokens: 76 },
    });
    expect(result.adaptive!.convergedCandidate!.changedPaths).toEqual(["package.json"]);
    expect(result.adaptive!.convergedFiles!["package.json"]).toContain("adaptively-fixed");
    expect(spies.recordAttemptFailure).toHaveBeenCalledWith(expect.objectContaining({ code: "verification_failed" }));
  });

  it("stops adaptive repair on bound exhaustion and carries a structured unfixable marker", async () => {
    const gate: AdaptiveGate = async (): Promise<AdaptiveVerifierResult> => ({
      passed: false,
      failingCommandId: "engine-check",
      output: "engine-check: still failing",
      implicatedPaths: ["package.json"],
    });
    let counter = 0;
    const planner: AdaptiveRepairPlanner = async (loopInput) => {
      const file = loopInput.context.find((entry) => entry.path === "package.json")!;
      return {
        plan: {
          edits: [
            {
              path: "package.json",
              observedContentDigest: file.digest,
              nextContent: `${file.content}\n// attempt ${(counter += 1)}\n`,
            },
          ],
        },
      };
    };
    const { input } = harness({
      commandRunner: async () => ({ exitCode: 9, stdout: "", stderr: "verifier failed" }),
    });
    const result = await runTransformerAttempt({
      ...input,
      adaptiveRepair: { planner, gate, bounds: { maxIterationsPerUnit: 1 } },
    });

    expect(result.status).toBe("failed");
    expect(result.adaptive).toMatchObject({
      engaged: true,
      outcome: "unfixable",
      unitsMarkedUnfixable: 1,
      boundExhaustion: ["iterations_per_unit"],
    });
    expect(result.adaptive!.markers).toHaveLength(1);
    expect(result.adaptive!.markers[0]).toMatchObject({
      kind: "transformer.adaptive.unfixable",
      reason: "iterations_per_unit_exhausted",
      unitId: "unit-a",
    });
    // Honest measurement: the scripted planner reported no model call.
    expect(result.adaptive!.usage.measured).toBe(false);
    expect(result.adaptive!.bestAttemptFiles!["package.json"]).toContain("attempt 1");
  });
});
