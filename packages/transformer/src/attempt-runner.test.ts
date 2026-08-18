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
  TransformerAttemptCheckpointUncertainError,
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
import { createRecipeVerificationControl } from "./recipe-workspace-execution.js";

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
const FILE_MODES = Object.freeze(Object.fromEntries(
  Object.keys(FILES).map((path) => [path, path === ".nvmrc" ? "100755" : "100644"]),
) as Record<string, "100644" | "100755">);

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
    startedAt: "2026-08-05T10:00:00.000Z",
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
    adaptiveBudgetRemaining: {
      attempts: 10,
      plannerCalls: 100,
      modelCalls: 100,
      inputTokens: 1_000_000,
      outputTokens: 250_000,
      totalTokens: 1_250_000,
      actualCostUsd: 50,
      wallTimeMs: 600_000,
    },
    ...overrides,
  };
}

type CoordinatorSpies = Readonly<{
  claimNextAttempt: ReturnType<typeof vi.fn>;
  renewAttemptLease: ReturnType<typeof vi.fn>;
  assertCurrentAttemptFence: ReturnType<typeof vi.fn>;
  recordAdaptiveAttemptUsage: ReturnType<typeof vi.fn>;
  completeAttempt: ReturnType<typeof vi.fn>;
  recordAttemptFailure: ReturnType<typeof vi.fn>;
}>;

function harness(options: Readonly<{
  lease?: TransformerExecutableAttemptLease;
  source?: Readonly<{
    repositoryId: string;
    revision: string;
    digest: string;
    files: RecipeFiles;
    fileModes?: Readonly<Record<string, "100644" | "100755">>;
  }>;
  assertFence?: () => boolean | void;
  commandRunner?: RunTransformerAttemptInput["commandRunner"];
  observedAt?: RunTransformerAttemptInput["observedAt"];
}> = {}) {
  const root = mkdtempSync(join(tmpdir(), "transformer-attempt-runner-"));
  roots.push(root);
  const claimed = options.lease ?? lease();
  const spies: CoordinatorSpies = {
    claimNextAttempt: vi.fn(async () => claimed),
    renewAttemptLease: vi.fn(async () => ({
      leaseGeneration: claimed.leaseGeneration,
      leaseTokenDigest: claimed.leaseTokenDigest,
      leaseExpiresAt: "2026-08-05T10:06:00.000Z",
    })),
    assertCurrentAttemptFence: vi.fn(async () => options.assertFence?.() ?? true),
    recordAdaptiveAttemptUsage: vi.fn(async () => undefined),
    completeAttempt: vi.fn(async () => undefined),
    recordAttemptFailure: vi.fn(async () => undefined),
  };
  const source = options.source ? { fileModes: FILE_MODES, ...options.source } : {
    repositoryId: "repo-a",
    revision: SOURCE_REVISION,
    digest: SOURCE_DIGEST,
    files: FILES,
    fileModes: FILE_MODES,
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
    observedAt: options.observedAt ?? ((phase) => ({
      claim: "2026-08-05T10:00:00.000Z",
      execute: "2026-08-05T10:01:00.000Z",
      renew: "2026-08-05T10:01:00.000Z",
      usage: "2026-08-05T10:01:00.000Z",
      complete: "2026-08-05T10:02:00.000Z",
      failure: "2026-08-05T10:03:00.000Z",
    })[phase]),
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

  it("runs the advisory verifier observer only after authoritative completion", async () => {
    const { input, spies } = harness();
    const observer = vi.fn(async () => {
      expect(spies.completeAttempt).toHaveBeenCalledTimes(1);
    });
    const result = await runTransformerAttempt({ ...input, onVerifiedCandidateCompleted: observer });
    expect(result.status).toBe("completed");
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({
      lease: expect.objectContaining({ campaignId: "campaign-a" }),
      execution: expect.objectContaining({ outputDigest: APPLICATION.outputDigest }),
      artifact: expect.objectContaining({ outputDigest: APPLICATION.outputDigest }),
    }));
    expect(result.verifierShadowError).toBeUndefined();
  });

  it("keeps a completed attempt authoritative when the advisory observer fails", async () => {
    const { input, spies } = harness();
    const result = await runTransformerAttempt({
      ...input,
      onVerifiedCandidateCompleted: async () => { throw new Error("observer unavailable"); },
    });
    expect(result).toMatchObject({ status: "completed", verifierShadowError: "transformer_verifier_shadow_failed" });
    expect(spies.completeAttempt).toHaveBeenCalledTimes(1);
    expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
  });

  it("replays an authenticated verifier prefix and delegates atomic checkpoint completion", async () => {
    const commandRunner = vi.fn(async () => ({ exitCode: 0, stdout: "suffix ok", stderr: "" }));
    const checkpointComplete = vi.fn(async () => undefined);
    const checkpointOpen = vi.fn(async () => ({
      verificationControl: createRecipeVerificationControl({
        restoredFiles: APPLICATION.files,
        restoredFileModes: FILE_MODES,
        recoveredResults: [{
          result: { exitCode: 0, stdout: "prefix ok", stderr: "" },
          provenance: {
            kind: "checkpoint_replay" as const,
            commandDigest: sha256(APPLICATION.verificationCommands[0]!.command),
            workspaceManifestDigest: sha256("restored-workspace"),
            effectResultDigest: sha256("restored-result"),
          },
        }],
        execute: async ({ run }) => ({
          result: await run(),
          provenance: { kind: "executed" as const },
        }),
      }),
      complete: checkpointComplete,
    }));
    const { input, spies } = harness({ commandRunner });

    const result = await runTransformerAttempt({
      ...input,
      checkpoint: { open: checkpointOpen },
    });

    expect(result.status).toBe("completed");
    expect(checkpointOpen).toHaveBeenCalledTimes(1);
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(checkpointComplete).toHaveBeenCalledWith(expect.objectContaining({
      execution: expect.objectContaining({ outputDigest: APPLICATION.outputDigest }),
      artifact: expect.objectContaining({ outputDigest: APPLICATION.outputDigest }),
      actualCostUsd: 0.12,
      accounting: expect.objectContaining({ actualCostUsd: 0.12 }),
    }));
    expect(spies.completeAttempt).not.toHaveBeenCalled();
    expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
  });

  it("does not record a conflicting failure while checkpoint completion is uncertain", async () => {
    const checkpointComplete = vi.fn(async () => {
      throw new TransformerAttemptCheckpointUncertainError(
        "transformer_attempt_checkpoint_commit_uncertain",
      );
    });
    const { input, spies } = harness();
    const result = await runTransformerAttempt({
      ...input,
      checkpoint: {
        open: async () => ({
          verificationControl: createRecipeVerificationControl({
            restoredFiles: APPLICATION.files,
            restoredFileModes: FILE_MODES,
            recoveredResults: [],
            execute: async ({ run }) => ({
              result: await run(),
              provenance: { kind: "executed" as const },
            }),
          }),
          complete: checkpointComplete,
        }),
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      recoveryCode: "worker_crash",
      errorCode: "transformer_attempt_checkpoint_commit_uncertain",
    });
    expect(checkpointComplete).toHaveBeenCalledTimes(2);
    expect(spies.completeAttempt).not.toHaveBeenCalled();
    expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
  });

  it("reconciles an uncertain checkpoint completion before reporting success", async () => {
    const checkpointComplete = vi.fn()
      .mockRejectedValueOnce(new TransformerAttemptCheckpointUncertainError(
        "transformer_attempt_checkpoint_commit_uncertain",
      ))
      .mockResolvedValueOnce(undefined);
    const { input, spies } = harness();
    const result = await runTransformerAttempt({
      ...input,
      checkpoint: {
        open: async () => ({
          verificationControl: createRecipeVerificationControl({
            restoredFiles: APPLICATION.files,
            restoredFileModes: FILE_MODES,
            recoveredResults: [],
            execute: async ({ run }) => ({
              result: await run(),
              provenance: { kind: "executed" as const },
            }),
          }),
          complete: checkpointComplete,
        }),
      },
    });

    expect(result.status).toBe("completed");
    expect(checkpointComplete).toHaveBeenCalledTimes(2);
    expect(spies.completeAttempt).not.toHaveBeenCalled();
    expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
  });

  it("treats a checkpoint head race as stale without failing the winning attempt", async () => {
    const { input, spies } = harness();
    const result = await runTransformerAttempt({
      ...input,
      checkpoint: {
        open: async () => {
          throw new Error("transformer_attempt_checkpoint_head_conflict");
        },
      },
    });

    expect(result.status).toBe("stale");
    expect(spies.completeAttempt).not.toHaveBeenCalled();
    expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
  });

  it("keeps post-open verification failures checkpoint-owned", async () => {
    const { input, spies } = harness();
    const result = await runTransformerAttempt({
      ...input,
      checkpoint: {
        open: async () => ({
          verificationControl: createRecipeVerificationControl({
            restoredFiles: APPLICATION.files,
            restoredFileModes: FILE_MODES,
            recoveredResults: [],
            execute: async () => {
              throw new Error("checkpoint verifier storage unavailable");
            },
          }),
          complete: async () => undefined,
        }),
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      recoveryCode: "worker_crash",
    });
    expect(spies.completeAttempt).not.toHaveBeenCalled();
    expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
  });

  it("bounds checkpoint open and leaves a hung store checkpoint-owned", async () => {
    const { input, spies } = harness();
    let operationSignal: AbortSignal | undefined;
    let lateMutation = false;
    const result = await runTransformerAttempt({
      ...input,
      checkpoint: {
        operationTimeoutMs: 10,
        open: async ({ signal }) => {
          operationSignal = signal;
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (!signal.aborted) lateMutation = true;
          throw signal.reason;
        },
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      recoveryCode: "worker_crash",
      errorCode: "transformer_attempt_checkpoint_operation_timeout",
    });
    expect(operationSignal?.aborted).toBe(true);
    expect(lateMutation).toBe(false);
    expect(spies.completeAttempt).not.toHaveBeenCalled();
    expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
  }, 1_000);

  it("bounds checkpoint completion and preserves the resumable checkpoint", async () => {
    const { input, spies } = harness();
    let operationSignal: AbortSignal | undefined;
    let lateMutation = false;
    const result = await runTransformerAttempt({
      ...input,
      checkpoint: {
        operationTimeoutMs: 10,
        open: async () => ({
          verificationControl: createRecipeVerificationControl({
            restoredFiles: APPLICATION.files,
            restoredFileModes: FILE_MODES,
            recoveredResults: [],
            execute: async ({ run }) => ({
              result: await run(),
              provenance: { kind: "executed" as const },
            }),
          }),
          complete: async ({ signal }) => {
            operationSignal = signal;
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            if (!signal.aborted) lateMutation = true;
            throw signal.reason;
          },
        }),
      },
    });
    expect(operationSignal?.aborted).toBe(true);
    expect(lateMutation).toBe(false);

    expect(result).toMatchObject({
      status: "failed",
      recoveryCode: "worker_crash",
      errorCode: "transformer_attempt_checkpoint_operation_timeout",
    });
    expect(spies.completeAttempt).not.toHaveBeenCalled();
    expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
  });

  it("aborts checkpoint I/O when lease renewal authority becomes uncertain", async () => {
    vi.useFakeTimers();
    let markOpenStarted!: () => void;
    const openStarted = new Promise<void>((resolve) => {
      markOpenStarted = resolve;
    });
    const { input, spies } = harness();
    spies.renewAttemptLease.mockRejectedValueOnce(new Error("coordinator unavailable"));
    try {
      const running = runTransformerAttempt({
        ...input,
        checkpoint: {
          operationTimeoutMs: 30_000,
          open: async ({ signal }) => {
            markOpenStarted();
            return await new Promise<never>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          },
        },
      });
      await openStarted;
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(running).resolves.toMatchObject({
        status: "failed",
        recoveryCode: "worker_crash",
        errorCode: "transformer_attempt_checkpoint_operation_aborted",
      });
      expect(spies.completeAttempt).not.toHaveBeenCalled();
      expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews one lease while a verification command remains in flight", async () => {
    vi.useFakeTimers();
    let releaseCommand!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
    let markCommandStarted!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
      markCommandStarted = resolve;
    });
    const command = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      releaseCommand = resolve;
    });
    const commandRunner = vi.fn(async () => {
      markCommandStarted();
      return await command;
    });
    const { input, spies } = harness({ commandRunner });
    try {
      const running = runTransformerAttempt(input);
      await commandStarted;
      expect(commandRunner).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(spies.renewAttemptLease).toHaveBeenCalledTimes(1);
      expect(spies.renewAttemptLease).toHaveBeenCalledWith(expect.objectContaining({
        unitId: "unit-a",
        leaseGeneration: 1,
        leaseToken: LEASE_TOKEN,
        leaseDurationMs: 60_000,
        idempotencyKey: expect.stringContaining(":renew:"),
      }));
      releaseCommand({ exitCode: 0, stdout: "ok", stderr: "" });
      await expect(running).resolves.toMatchObject({ status: "completed" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews a nearly expired returned lease before starting repository work", async () => {
    const commandRunner = vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }));
    const { input, spies, loadExactSource } = harness({
      lease: lease({ leaseExpiresAt: "2026-08-05T10:01:05.000Z" }),
      commandRunner,
    });

    const result = await runTransformerAttempt(input);

    expect(result.status).toBe("completed");
    expect(spies.renewAttemptLease).toHaveBeenCalledTimes(1);
    expect(spies.renewAttemptLease.mock.invocationCallOrder[0]).toBeLessThan(
      loadExactSource.mock.invocationCallOrder[0]!,
    );
    expect(spies.renewAttemptLease.mock.invocationCallOrder[0]).toBeLessThan(
      commandRunner.mock.invocationCallOrder[0]!,
    );
  });

  it("returns stale when the returned lease has expired before renewal", async () => {
    const { input, spies, loadExactSource } = harness({
      lease: lease({ leaseExpiresAt: "2026-08-05T10:01:00.000Z" }),
    });

    const result = await runTransformerAttempt(input);

    expect(result.status).toBe("stale");
    expect(spies.renewAttemptLease).not.toHaveBeenCalled();
    expect(loadExactSource).not.toHaveBeenCalled();
    expect(spies.completeAttempt).not.toHaveBeenCalled();
    expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
  });

  it("uses distinct idempotency ordinals for repeated lease renewals", async () => {
    vi.useFakeTimers();
    let releaseCommand!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
    let markCommandStarted!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
      markCommandStarted = resolve;
    });
    const command = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      releaseCommand = resolve;
    });
    const { input, spies } = harness({
      commandRunner: async () => {
        markCommandStarted();
        return await command;
      },
    });
    spies.renewAttemptLease
      .mockResolvedValueOnce({
        leaseGeneration: 1,
        leaseTokenDigest: sha256(LEASE_TOKEN),
        leaseExpiresAt: "2026-08-05T10:06:00.000Z",
      })
      .mockResolvedValueOnce({
        leaseGeneration: 1,
        leaseTokenDigest: sha256(LEASE_TOKEN),
        leaseExpiresAt: "2026-08-05T10:07:00.000Z",
      });
    try {
      const running = runTransformerAttempt(input);
      await commandStarted;
      await vi.advanceTimersByTimeAsync(40_000);
      expect(spies.renewAttemptLease).toHaveBeenCalledTimes(2);
      const firstKey = spies.renewAttemptLease.mock.calls[0]![0].idempotencyKey;
      const secondKey = spies.renewAttemptLease.mock.calls[1]![0].idempotencyKey;
      expect(firstKey).not.toBe(secondKey);
      releaseCommand({ exitCode: 0, stdout: "ok", stderr: "" });
      await expect(running).resolves.toMatchObject({ status: "completed" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a hung renewal within the current lease window", async () => {
    vi.useFakeTimers();
    const { input, spies } = harness({
      lease: lease({ leaseExpiresAt: "2026-08-05T10:01:05.000Z" }),
    });
    spies.renewAttemptLease.mockImplementationOnce(async () => await new Promise(() => undefined));
    try {
      const running = runTransformerAttempt(input);
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(running).resolves.toMatchObject({
        status: "failed",
        recoveryCode: "worker_crash",
        errorCode: "transformer_attempt_lease_renewal_failed",
      });
      expect(spies.completeAttempt).not.toHaveBeenCalled();
      expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "transformer_pilot_fence_stale",
    "transformer_pilot_fence_expired",
  ])("returns stale without completion or failure writes when renewal is rejected: %s", async (code) => {
    vi.useFakeTimers();
    let releaseCommand!: (value: { exitCode: number; stdout: string; stderr: string }) => void;
    let markCommandStarted!: () => void;
    const commandStarted = new Promise<void>((resolve) => {
      markCommandStarted = resolve;
    });
    const command = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      releaseCommand = resolve;
    });
    const commandRunner = vi.fn(async () => {
      markCommandStarted();
      return await command;
    });
    const { input, spies } = harness({ commandRunner });
    spies.renewAttemptLease.mockRejectedValueOnce(new Error(code));
    try {
      const running = runTransformerAttempt(input);
      await commandStarted;
      expect(commandRunner).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20_000);
      releaseCommand({ exitCode: 0, stdout: "ok", stderr: "" });
      await expect(running).resolves.toMatchObject({ status: "stale" });
      expect(spies.completeAttempt).not.toHaveBeenCalled();
      expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
        claim: "2026-08-05T10:02:30.000Z",
        execute: "2026-08-05T10:03:00.000Z",
        renew: "2026-08-05T10:03:00.000Z",
        usage: "2026-08-05T10:03:00.000Z",
        complete: "2026-08-05T10:04:00.000Z",
        failure: "2026-08-05T10:04:30.000Z",
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
    expect(result.adaptive!.convergedCandidate!.changedPaths).toEqual(
      APPLICATION.operations.map((operation) => operation.path).sort(),
    );
    expect(result.adaptive!.convergedCandidate!.adaptiveChangedPaths).toEqual(["package.json"]);
    expect(result.adaptive!.convergedFiles!["package.json"]).toContain("adaptively-fixed");
    expect(spies.recordAttemptFailure).toHaveBeenCalledWith(expect.objectContaining({ code: "verification_failed" }));
  });

  it("records the verification failure when the adaptive planner throws before any usage checkpoint", async () => {
    // A planner that throws on its first iteration leaves usage.complete === false
    // while neither a usage checkpoint nor an external-model reservation was ever
    // accepted (the default coordinator omits reserve/settle). The failure path
    // must still reach recordAttemptFailure and must not launder the genuine
    // verification failure into a worker_crash.
    const planner = vi.fn<AdaptiveRepairPlanner>(async () => {
      throw new Error("adaptive planner backend unreachable");
    });
    const gate: AdaptiveGate = async (): Promise<AdaptiveVerifierResult> => ({
      passed: false,
      failingCommandId: "engine-check",
      output: "engine-check: still failing",
      implicatedPaths: ["package.json"],
    });
    const { input, spies } = harness({
      commandRunner: async () => ({ exitCode: 9, stdout: "", stderr: "verifier failed" }),
    });

    const result = await runTransformerAttempt({ ...input, adaptiveRepair: { planner, gate } });

    expect(planner).toHaveBeenCalledTimes(1);
    // The true recovery code survives: the operator is told to review the
    // verification evidence, not to resolve worker health.
    expect(result).toMatchObject({
      status: "failed",
      recoveryCode: "verification_failed",
    });
    expect(result.errorCode).toContain("recipe_execution_verification_failed");
    expect(result.errorCode).not.toContain("usage_accounting_incomplete");
    // The unit's failure is durably recorded rather than left running until the
    // lease-expiry sweep. The recorded accounting excludes the untrustworthy
    // incomplete adaptive usage (it falls back to the execution cost only).
    expect(spies.recordAttemptFailure).toHaveBeenCalledTimes(1);
    expect(spies.recordAttemptFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "verification_failed",
      accounting: expect.objectContaining({ actualCostUsd: 0.12 }),
    }));
    // Durable failure evidence is written and preserves the incomplete-usage
    // diagnostic instead of silently dropping it.
    const failureEvidence = result.failureEvidence!;
    expect(failureEvidence).toBeDefined();
    const persisted = readFileSync(failureEvidence.path, "utf8");
    expect(sha256(persisted)).toBe(failureEvidence.digest);
    expect(JSON.parse(persisted)).toMatchObject({
      kind: "transformer.attempt.failure",
      recoveryCode: "verification_failed",
      adaptiveUsageAccountingIncomplete: true,
    });
    // The incomplete-usage fact also survives on the returned adaptive summary.
    expect(result.adaptive).toMatchObject({ usage: { complete: false } });
  });

  it("aborts adaptive planner work when lease renewal authority becomes uncertain", async () => {
    vi.useFakeTimers();
    let markPlannerStarted!: () => void;
    const plannerStarted = new Promise<void>((resolve) => {
      markPlannerStarted = resolve;
    });
    const planner = vi.fn<AdaptiveRepairPlanner>(async (_loopInput, options) => {
      markPlannerStarted();
      return await new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(new Error("planner_aborted_after_lease_loss")),
          { once: true },
        );
      });
    });
    const { input, spies } = harness({
      commandRunner: async () => ({ exitCode: 9, stdout: "", stderr: "verifier failed" }),
    });
    spies.renewAttemptLease.mockRejectedValueOnce(new Error("transformer_coordinator_unavailable"));
    try {
      const running = runTransformerAttempt({ ...input, adaptiveRepair: { planner } });
      await plannerStarted;
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(running).resolves.toMatchObject({
        status: "failed",
        recoveryCode: "worker_crash",
        errorCode: "transformer_attempt_lease_renewal_failed",
      });
      expect(spies.completeAttempt).not.toHaveBeenCalled();
      expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a regeneration closed before planner use without external review authorization", async () => {
    const rationale = "Synthetic reviewer feedback: preserve scripts while changing only the runtime range.";
    const planner = vi.fn<AdaptiveRepairPlanner>(async () => ({
      plan: { edits: [], markUnfixable: true, rationale: "not called" },
    }));
    const gate: AdaptiveGate = async () => ({
      passed: false,
      failingCommandId: "engine-check",
      output: "engine-check: still failing",
      implicatedPaths: ["package.json"],
    });
    const { input } = harness({
      lease: lease({
        regenerationReview: {
          candidateId: "tfadaptive_synthetic_review",
          reviewerPrincipalId: "human:synthetic-reviewer",
          rationale,
          rationaleDigest: sha256(rationale),
          requestedAt: "2026-08-05T09:59:00.000Z",
        },
      }),
      commandRunner: async () => ({ exitCode: 9, stdout: "", stderr: "verifier failed" }),
    });

    const result = await runTransformerAttempt({ ...input, adaptiveRepair: { planner, gate } });

    expect(planner).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "failed",
      recoveryCode: "verification_failed",
      errorCode: "transformer_regeneration_review_external_processing_not_approved",
    });
  });

  it("assigns a regular mode to adaptive new files and preserves executable source modes", async () => {
    const newPath = "scripts/check.sh";
    const gate: AdaptiveGate = async (files: RecipeFiles): Promise<AdaptiveVerifierResult> => ({
      passed: files[newPath] === "#!/bin/sh\nexit 0\n",
      failingCommandId: files[newPath] ? null : "missing-check-script",
      output: files[newPath] ? "ok" : "missing scripts/check.sh",
      implicatedPaths: [newPath],
    });
    const planner: AdaptiveRepairPlanner = async () => ({
      plan: {
        edits: [{
          path: newPath,
          observedContentDigest: sha256(""),
          nextContent: "#!/bin/sh\nexit 0\n",
        }],
      },
      usage: { modelCalled: false },
    });
    type AdaptiveCandidateHandoff = Parameters<
      NonNullable<RunTransformerAttemptInput["onAdaptiveCandidateConverged"]>
    >[0];
    const handoffs: AdaptiveCandidateHandoff[] = [];
    const onAdaptiveCandidateConverged = vi.fn(async (handoff: AdaptiveCandidateHandoff) => {
      handoffs.push(handoff);
    });
    const { input } = harness({
      commandRunner: async () => ({ exitCode: 9, stdout: "", stderr: "verifier failed" }),
    });

    const result = await runTransformerAttempt({
      ...input,
      onAdaptiveCandidateConverged,
      adaptiveRepair: {
        planner,
        gate,
        allowedMutationPaths: [...Object.keys(FILES), newPath],
      },
    });

    expect(result.adaptive?.outcome).toBe("converged");
    expect(onAdaptiveCandidateConverged).toHaveBeenCalledTimes(1);
    const handoff = handoffs[0]!;
    expect(handoff.fileModes[newPath]).toBe("100644");
    expect(handoff.fileModes[".nvmrc"]).toBe("100755");
    expect(Object.keys(handoff.fileModes).sort()).toEqual(Object.keys(handoff.files).sort());
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
        usage: { modelCalled: false },
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

  it("refuses adaptive repair when the reconstructed recipe output is not the leased candidate", async () => {
    const mismatched = lease({ candidateDigest: `sha256:${"0".repeat(64)}` });
    const planner = vi.fn<AdaptiveRepairPlanner>(async () => ({
      plan: { edits: [], markUnfixable: true },
    }));
    const gate: AdaptiveGate = async () => ({
      passed: false,
      failingCommandId: "engine-check",
      output: "failed",
      implicatedPaths: ["package.json"],
    });
    const { input, spies } = harness({
      lease: mismatched,
      commandRunner: async () => ({ exitCode: 9, stdout: "", stderr: "verifier failed" }),
    });

    const result = await runTransformerAttempt({
      ...input,
      adaptiveRepair: { planner, gate },
    });

    expect(result).toMatchObject({
      status: "failed",
      recoveryCode: "candidate_drift",
      errorCode: "transformer_attempt_candidate_digest_mismatch",
    });
    expect(result.adaptive).toBeUndefined();
    expect(planner).not.toHaveBeenCalled();
    expect(spies.recordAttemptFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "candidate_drift" }),
    );
  });

  it("refuses adaptive repair when reconstructed changed paths differ from the lease", async () => {
    const mismatched = lease({ changedPaths: ["package.json"] });
    const planner = vi.fn<AdaptiveRepairPlanner>(async () => ({
      plan: { edits: [], markUnfixable: true },
    }));
    const gate: AdaptiveGate = async () => ({
      passed: false,
      failingCommandId: "engine-check",
      output: "failed",
      implicatedPaths: ["package.json"],
    });
    const { input, spies } = harness({
      lease: mismatched,
      commandRunner: async () => ({ exitCode: 9, stdout: "", stderr: "verifier failed" }),
    });

    const result = await runTransformerAttempt({
      ...input,
      adaptiveRepair: { planner, gate },
    });

    expect(result).toMatchObject({
      status: "failed",
      recoveryCode: "candidate_drift",
      errorCode: "transformer_attempt_changed_paths_mismatch",
    });
    expect(result.adaptive).toBeUndefined();
    expect(planner).not.toHaveBeenCalled();
    expect(spies.recordAttemptFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "candidate_drift" }),
    );
  });

  it("does not hand off a converged adaptive candidate after its lease fence is stale", async () => {
    let adaptationConverged = false;
    const gate: AdaptiveGate = async (files) => {
      const passed = (files["package.json"] ?? "").includes("adaptively-fixed");
      if (passed) adaptationConverged = true;
      return {
        passed,
        failingCommandId: passed ? null : "engine-check",
        output: passed ? "ok" : "failed",
        implicatedPaths: ["package.json"],
      };
    };
    const planner: AdaptiveRepairPlanner = async (loopInput) => {
      const file = loopInput.context.find((entry) => entry.path === "package.json")!;
      return {
        plan: {
          edits: [{
            path: "package.json",
            observedContentDigest: file.digest,
            nextContent: `${file.content}\n// adaptively-fixed\n`,
          }],
        },
        usage: { modelCalled: false },
      };
    };
    const onAdaptiveCandidateConverged = vi.fn();
    const { input, spies } = harness({
      assertFence: () => !adaptationConverged,
      commandRunner: async () => ({ exitCode: 9, stdout: "", stderr: "verifier failed" }),
    });

    const result = await runTransformerAttempt({
      ...input,
      adaptiveRepair: { planner, gate },
      onAdaptiveCandidateConverged,
    });

    expect(result.status).toBe("stale");
    expect(onAdaptiveCandidateConverged).not.toHaveBeenCalled();
    expect(spies.recordAttemptFailure).not.toHaveBeenCalled();
  });

  it("records a worker failure when the pre-handoff fence check itself fails", async () => {
    let adaptationConverged = false;
    let fenceFailureInjected = false;
    const gate: AdaptiveGate = async (files) => {
      const passed = (files["package.json"] ?? "").includes("adaptively-fixed");
      if (passed) adaptationConverged = true;
      return {
        passed,
        failingCommandId: passed ? null : "engine-check",
        output: passed ? "ok" : "failed",
        implicatedPaths: ["package.json"],
      };
    };
    const planner: AdaptiveRepairPlanner = async (loopInput) => {
      const file = loopInput.context.find((entry) => entry.path === "package.json")!;
      return {
        plan: {
          edits: [{
            path: "package.json",
            observedContentDigest: file.digest,
            nextContent: `${file.content}\n// adaptively-fixed\n`,
          }],
        },
        usage: { modelCalled: false },
      };
    };
    const onAdaptiveCandidateConverged = vi.fn();
    const { input, spies } = harness({
      assertFence: () => {
        if (adaptationConverged && !fenceFailureInjected) {
          fenceFailureInjected = true;
          throw new Error("coordinator unavailable");
        }
        return true;
      },
      commandRunner: async () => ({ exitCode: 9, stdout: "", stderr: "verifier failed" }),
    });

    const result = await runTransformerAttempt({
      ...input,
      adaptiveRepair: { planner, gate },
      onAdaptiveCandidateConverged,
    });

    expect(result).toMatchObject({
      status: "failed",
      recoveryCode: "worker_crash",
      errorCode: "transformer_attempt_worker_crash",
    });
    expect(onAdaptiveCandidateConverged).not.toHaveBeenCalled();
    expect(spies.recordAttemptFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "worker_crash" }),
    );
  });

  it("fails the fenced attempt when adaptive candidate persistence fails", async () => {
    const gate: AdaptiveGate = async (files) => {
      const passed = (files["package.json"] ?? "").includes("adaptively-fixed");
      return {
        passed,
        failingCommandId: passed ? null : "engine-check",
        output: passed ? "ok" : "failed",
        implicatedPaths: ["package.json"],
      };
    };
    const planner: AdaptiveRepairPlanner = async (loopInput) => {
      const file = loopInput.context.find((entry) => entry.path === "package.json")!;
      return {
        plan: {
          edits: [{
            path: "package.json",
            observedContentDigest: file.digest,
            nextContent: `${file.content}\n// adaptively-fixed\n`,
          }],
        },
        usage: { modelCalled: false },
      };
    };
    const persistenceSecret = "adaptive candidate persistence secret";
    const onAdaptiveCandidateConverged = vi.fn(async () => {
      throw new Error(persistenceSecret);
    });
    const { input, spies } = harness({
      commandRunner: async () => ({ exitCode: 9, stdout: "", stderr: "verifier failed" }),
    });

    const result = await runTransformerAttempt({
      ...input,
      adaptiveRepair: { planner, gate },
      onAdaptiveCandidateConverged,
    });

    expect(result).toMatchObject({
      status: "failed",
      recoveryCode: "worker_crash",
      errorCode: "transformer_adaptive_candidate_persistence_failed",
      adaptive: { outcome: "converged" },
    });
    expect(onAdaptiveCandidateConverged).toHaveBeenCalledTimes(1);
    expect(spies.recordAttemptFailure).toHaveBeenCalledWith(
      expect.objectContaining({ code: "worker_crash" }),
    );
    expect(result.failureEvidence).toBeDefined();
    if (!result.failureEvidence) return;
    const serialized = readFileSync(result.failureEvidence.path, "utf8");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(16 * 1024);
    expect(serialized).not.toContain(persistenceSecret);
  });

  it("clamps campaign planner and model headroom to the loop limits", async () => {
    const gate: AdaptiveGate = async () => ({
      passed: false,
      failingCommandId: "engine-check",
      output: "still failing",
      implicatedPaths: ["package.json"],
    });
    const planner = vi.fn<AdaptiveRepairPlanner>(async (loopInput) => ({
      plan: { edits: [], markUnfixable: true },
      usage: { modelCalled: false },
    }));
    const constrainedLease = lease({
      adaptiveBudgetRemaining: {
        attempts: 1,
        plannerCalls: 7,
        modelCalls: 2,
        inputTokens: 101,
        outputTokens: 11,
        totalTokens: 112,
        actualCostUsd: 0.2,
        wallTimeMs: 90_000,
      },
    });
    const { input } = harness({
      lease: constrainedLease,
      commandRunner: async () => ({ exitCode: 9, stdout: "", stderr: "failed" }),
    });

    await runTransformerAttempt({
      ...input,
      adaptiveRepair: {
        planner,
        gate,
        bounds: { maxPlannerCalls: 3, maxModelCalls: 1 },
      },
    });

    expect(planner).toHaveBeenCalledTimes(1);
    expect(planner.mock.calls[0]![0].budget).toMatchObject({
      plannerCalls: 3,
      modelCalls: 1,
      inputTokens: 101,
      outputTokens: 11,
      totalTokens: 112,
    });
    expect(planner.mock.calls[0]![0].budget!.actualCostUsd).toBeCloseTo(0.08, 12);
  });
});
