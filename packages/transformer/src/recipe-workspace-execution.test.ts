import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RecipeWorkspaceExecutionError,
  createRecipeVerificationControl,
  executeRecipeInWorkspace,
  restoreRecipeExecutionInWorkspace,
  runRecipeVerificationGate,
  type ExactSourceSnapshot,
  type RecipeCommandInvocation,
  type RecipeCommandRunner,
  type RecipeExecutionFence,
} from "./recipe-workspace-execution.js";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  applyRecipe,
  getRecipe,
  recipeFilesDigest,
  recipeReference,
  type RecipeFiles,
  type RecipeVerificationCommand,
} from "./recipe.js";

const roots: string[] = [];
const digest = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function replayed(
  command: RecipeVerificationCommand,
  result: Readonly<{ exitCode: number; stdout: string; stderr: string }>,
) {
  return {
    result,
    provenance: {
      kind: "checkpoint_replay" as const,
      commandDigest: digest(command.command),
      workspaceManifestDigest: digest("workspace-manifest"),
      effectResultDigest: digest(`effect:${command.id}`),
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FILES: RecipeFiles = {
  "src/server.js": "console.log('bounded migration')\n",
  "package.json": `${JSON.stringify(
    {
      name: "payments-api",
      private: true,
      engines: { node: ">=18 <19" },
    },
    null,
    2,
  )}\n`,
  ".nvmrc": "18\n",
  ".node-version": "18.20.4\n",
  Dockerfile: "FROM node:18-alpine\nWORKDIR /app\n",
};

const FENCE: RecipeExecutionFence = {
  tenantId: "tenant-a",
  campaignId: "campaign-a",
  unitId: "unit-a",
  attemptId: "attempt-a",
  leaseGeneration: 4,
  leaseToken: "lease-token-value-1234",
};

function source(files: RecipeFiles = FILES): ExactSourceSnapshot {
  return {
    repositoryId: "repository-a",
    revision: "a".repeat(40),
    digest: recipeFilesDigest(files),
    files,
    fileModes: Object.freeze(Object.fromEntries(
      Object.keys(files).map((path) => [path, path === "src/server.js" ? "100755" : "100644"]),
    ) as Record<string, "100644" | "100755">),
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "transformer-recipe-execution-test-"));
  roots.push(root);
  return {
    root,
    evidenceDirectory: join(root, "evidence"),
    tempRoot: join(root, "workspaces"),
  };
}

function successfulRunner(invocations: RecipeCommandInvocation[]): RecipeCommandRunner {
  return async (invocation) => {
    invocations.push(invocation);
    if (process.platform !== "win32") {
      expect(statSync(join(invocation.cwd, "src/server.js")).mode & 0o111).not.toBe(0);
    }
    return { exitCode: 0, stdout: "verified\n", stderr: "" };
  };
}

describe("bounded recipe workspace execution", () => {
  it("binds an exact snapshot, applies only recipe edits, and persists deterministic evidence", async () => {
    const paths = fixture();
    const invocations: RecipeCommandInvocation[] = [];
    const asserted: RecipeExecutionFence[] = [];
    const execute = () =>
      executeRecipeInWorkspace({
        fence: FENCE,
        assertFence: (fence) => {
          asserted.push(fence);
          return true;
        },
        source: source(),
        recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
        evidenceDirectory: paths.evidenceDirectory,
        tempRoot: paths.tempRoot,
        observedAt: "2026-08-01T20:00:00.000Z",
        commandRunner: successfulRunner(invocations),
      });

    const first = await execute();
    const second = await execute();

    expect(first).toEqual(second);
    expect(first.inputDigest).toBe(source().digest);
    expect(first.outputDigest).not.toBe(first.inputDigest);
    expect(JSON.parse(first.outputFiles["package.json"]!).engines.node).toBe(">=20 <21");
    expect(first.outputFiles["src/server.js"]).toBe(FILES["src/server.js"]);
    expect(first.outputFileModes).toEqual(source().fileModes);
    expect(first.operations.map((operation) => operation.path).sort()).toEqual([
      ".node-version",
      ".nvmrc",
      "Dockerfile",
      "package.json",
    ]);
    expect(first.evidence.path).toBe(second.evidence.path);
    expect(readFileSync(first.evidence.path, "utf8")).not.toContain("bounded migration");
    expect(readFileSync(first.evidence.path, "utf8")).not.toContain(FENCE.leaseToken);
    expect(first.evidence.record.source).toEqual({
      repositoryId: "repository-a",
      revision: "a".repeat(40),
      digest: source().digest,
      fileModes: source().fileModes,
    });
    expect(first.analysis).toMatchObject({
      status: "applicable",
      estimatedOperations: 4,
      cacheHit: false,
    });
    expect(first.evidence.record).toMatchObject({
      schemaVersion: 3,
      analysis: {
        status: "applicable",
        estimatedOperations: 4,
      },
    });
    expect(first.evidence.record.commands).toHaveLength(2);
    expect(asserted.length).toBeGreaterThanOrEqual(8);
    expect(invocations).toHaveLength(4);
    for (const invocation of invocations) {
      expect(invocation.executable).toBe(process.execPath);
      expect(invocation.args.slice(0, 2)).toEqual(["--no-warnings", "-e"]);
      expect(invocation.args.join(" ")).not.toContain("node -e \"");
      expect(invocation.cwd).toContain("mendpoint-transformer-recipe-");
      expect(existsSync(invocation.cwd)).toBe(false);
      expect(invocation.env).not.toHaveProperty("NODE_OPTIONS");
    }
  });

  it("replays an authenticated verifier prefix and executes only the remaining suffix", async () => {
    const paths = fixture();
    const snapshot = source();
    const recipe = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
    const application = applyRecipe(recipe, snapshot.files);
    const controlledIndexes: number[] = [];
    let runnerCalls = 0;
    const restoredFiles = { ...application.files };
    const restoredFileModes = { ...snapshot.fileModes };
    const recoveredResults = [replayed(application.verificationCommands[0]!, {
      exitCode: 0,
      stdout: "prefix verified\n",
      stderr: "",
    })];
    const verificationControl = createRecipeVerificationControl({
      restoredFiles,
      restoredFileModes,
      recoveredResults,
      execute: async ({ index, run }) => {
        controlledIndexes.push(index);
        return { result: await run(), provenance: { kind: "executed" } };
      },
    });
    restoredFiles["package.json"] = "{}\n";
    restoredFileModes["src/server.js"] = "100644";
    recoveredResults[0] = replayed(application.verificationCommands[0]!, {
      exitCode: 9,
      stdout: "mutated",
      stderr: "mutated",
    });

    const execution = await executeRecipeInWorkspace({
      fence: FENCE,
      assertFence: () => true,
      source: snapshot,
      recipe,
      evidenceDirectory: paths.evidenceDirectory,
      tempRoot: paths.tempRoot,
      observedAt: "2026-08-01T20:00:00.000Z",
      commandRunner: async () => {
        runnerCalls++;
        return { exitCode: 0, stdout: "suffix verified\n", stderr: "" };
      },
      verificationControl,
    });

    expect(runnerCalls).toBe(1);
    expect(controlledIndexes).toEqual([1]);
    expect(execution.commands).toHaveLength(2);
    expect(execution.commands[0]?.stdoutDigest).not.toBe(execution.commands[1]?.stdoutDigest);
    expect(execution.commands.map((command) => command.provenance.kind)).toEqual([
      "checkpoint_replay",
      "executed",
    ]);
    expect(execution.outputFileModes["src/server.js"]).toBe("100755");
  });

  it("fails closed on restored workspace drift and replays a consumed verifier failure", async () => {
    const paths = fixture();
    const snapshot = source();
    const recipe = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
    const application = applyRecipe(recipe, snapshot.files);
    let runnerCalls = 0;
    const base = {
      fence: FENCE,
      assertFence: () => true,
      source: snapshot,
      recipe,
      evidenceDirectory: paths.evidenceDirectory,
      tempRoot: paths.tempRoot,
      observedAt: "2026-08-01T20:00:00.000Z",
      commandRunner: async () => {
        runnerCalls++;
        return { exitCode: 0, stdout: "unexpected", stderr: "" };
      },
    } as const;

    const sparse = new Array(1) as Parameters<typeof createRecipeVerificationControl>[0]["recoveredResults"];
    expect(() => createRecipeVerificationControl({
      restoredFiles: application.files,
      restoredFileModes: snapshot.fileModes,
      recoveredResults: sparse,
      execute: async ({ run }) => ({
        result: await run(), provenance: { kind: "executed" },
      }),
    })).toThrow("recipe_execution_verification_control_invalid");

    await expect(executeRecipeInWorkspace({
      ...base,
      verificationControl: {
        restoredFiles: application.files,
        restoredFileModes: snapshot.fileModes,
        recoveredResults: application.verificationCommands.map((command) => replayed(command, {
          exitCode: 0, stdout: "forged pass", stderr: "",
        })),
        execute: async ({ run }) => ({
          result: await run(), provenance: { kind: "executed" },
        }),
      },
    })).rejects.toMatchObject({ code: "recipe_execution_verification_control_untrusted" });
    expect(runnerCalls).toBe(0);

    await expect(executeRecipeInWorkspace({
      ...base,
      verificationControl: createRecipeVerificationControl({
        restoredFiles: { ...application.files, "package.json": "{}\n" },
        restoredFileModes: snapshot.fileModes,
        recoveredResults: [],
        execute: async ({ run }) => ({
          result: await run(), provenance: { kind: "executed" },
        }),
      }),
    })).rejects.toMatchObject({ code: "recipe_execution_checkpoint_restore_mismatch" });
    expect(runnerCalls).toBe(0);

    await expect(executeRecipeInWorkspace({
      ...base,
      verificationControl: createRecipeVerificationControl({
        restoredFiles: application.files,
        restoredFileModes: snapshot.fileModes,
        recoveredResults: [replayed(application.verificationCommands[0]!, {
          exitCode: 9, stdout: "", stderr: "persisted failure",
        })],
        execute: async () => {
          throw new Error("later verifier must not run");
        },
      }),
    })).rejects.toMatchObject({
      code: "recipe_execution_verification_failed:runtime-declarations",
    });
    expect(runnerCalls).toBe(0);
  });

  it("rechecks the lease fence after checkpoint dispatch and before verifier execution", async () => {
    const paths = fixture();
    const snapshot = source();
    const recipe = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
    const application = applyRecipe(recipe, snapshot.files);
    let stale = false;
    let runnerCalls = 0;

    await expect(executeRecipeInWorkspace({
      fence: FENCE,
      assertFence: () => !stale,
      source: snapshot,
      recipe,
      evidenceDirectory: paths.evidenceDirectory,
      tempRoot: paths.tempRoot,
      observedAt: "2026-08-01T20:00:00.000Z",
      commandRunner: async () => {
        runnerCalls++;
        return { exitCode: 0, stdout: "unexpected", stderr: "" };
      },
      verificationControl: createRecipeVerificationControl({
        restoredFiles: application.files,
        restoredFileModes: snapshot.fileModes,
        recoveredResults: [],
        execute: async ({ run }) => {
          stale = true;
          return { result: await run(), provenance: { kind: "executed" } };
        },
      }),
    })).rejects.toMatchObject({ code: "recipe_execution_fence_stale" });

    expect(runnerCalls).toBe(0);
  });

  it("replays an authenticated adaptive gate prefix and executes only the suffix", async () => {
    const paths = fixture();
    const snapshot = source();
    const recipe = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
    const application = applyRecipe(recipe, snapshot.files);
    const adaptiveFiles = {
      ...application.files,
      "package.json": `${JSON.stringify({
        ...JSON.parse(application.files["package.json"]!),
        mendpointAdaptiveReview: "fixed",
      }, null, 2)}\n`,
    };
    let runnerCalls = 0;
    const controlledIndexes: number[] = [];
    const verificationControl = createRecipeVerificationControl({
      restoredFiles: adaptiveFiles,
      restoredFileModes: snapshot.fileModes,
      recoveredResults: [replayed(application.verificationCommands[0]!, {
        exitCode: 0,
        stdout: "replayed adaptive prefix\n",
        stderr: "",
      })],
      execute: async ({ index, run }) => {
        controlledIndexes.push(index);
        return { result: await run(), provenance: { kind: "executed" } };
      },
    });

    const result = await runRecipeVerificationGate({
      files: adaptiveFiles,
      fileModes: snapshot.fileModes,
      recipe,
      tempRoot: paths.tempRoot,
      commandRunner: async () => {
        runnerCalls++;
        return { exitCode: 0, stdout: "adaptive suffix verified\n", stderr: "" };
      },
      verificationControl,
    });

    expect(result.passed).toBe(true);
    expect(runnerCalls).toBe(1);
    expect(controlledIndexes).toEqual([1]);
  });

  it("fails closed on forged or mismatched adaptive gate checkpoints", async () => {
    const paths = fixture();
    const snapshot = source();
    const recipe = recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
    const application = applyRecipe(recipe, snapshot.files);
    let runnerCalls = 0;
    const base = {
      files: application.files,
      fileModes: snapshot.fileModes,
      recipe,
      tempRoot: paths.tempRoot,
      commandRunner: async () => {
        runnerCalls++;
        return { exitCode: 0, stdout: "unexpected", stderr: "" };
      },
    } as const;

    await expect(runRecipeVerificationGate({
      ...base,
      verificationControl: {
        restoredFiles: application.files,
        restoredFileModes: snapshot.fileModes,
        recoveredResults: [],
        execute: async ({ run }) => ({
          result: await run(), provenance: { kind: "executed" },
        }),
      },
    })).rejects.toThrow("recipe_execution_verification_control_untrusted");
    expect(runnerCalls).toBe(0);

    await expect(runRecipeVerificationGate({
      ...base,
      verificationControl: createRecipeVerificationControl({
        restoredFiles: { ...application.files, "package.json": "{}\n" },
        restoredFileModes: snapshot.fileModes,
        recoveredResults: [],
        execute: async ({ run }) => ({
          result: await run(), provenance: { kind: "executed" },
        }),
      }),
    })).rejects.toThrow("recipe_execution_checkpoint_restore_mismatch");
    expect(runnerCalls).toBe(0);

    await expect(runRecipeVerificationGate({
      ...base,
      verificationControl: createRecipeVerificationControl({
        restoredFiles: application.files,
        restoredFileModes: {
          ...snapshot.fileModes,
          "package.json": snapshot.fileModes?.["package.json"] === "100755" ? "100644" : "100755",
        },
        recoveredResults: [],
        execute: async ({ run }) => ({
          result: await run(), provenance: { kind: "executed" },
        }),
      }),
    })).rejects.toThrow("recipe_execution_checkpoint_restore_mismatch");
    expect(runnerCalls).toBe(0);

    await expect(runRecipeVerificationGate({
      ...base,
      verificationControl: createRecipeVerificationControl({
        restoredFiles: application.files,
        restoredFileModes: snapshot.fileModes,
        recoveredResults: [replayed(application.verificationCommands[1]!, {
          exitCode: 0,
          stdout: "wrong command replay",
          stderr: "",
        })],
        execute: async ({ run }) => ({
          result: await run(), provenance: { kind: "executed" },
        }),
      }),
    })).rejects.toThrow("recipe_execution_command_provenance_invalid");
    expect(runnerCalls).toBe(0);

    await expect(runRecipeVerificationGate({
      ...base,
      verificationControl: createRecipeVerificationControl({
        restoredFiles: application.files,
        restoredFileModes: snapshot.fileModes,
        recoveredResults: [],
        execute: async () => replayed(application.verificationCommands[1]!, {
          exitCode: 0,
          stdout: "wrong controlled command replay",
          stderr: "",
        }),
      }),
    })).rejects.toThrow("recipe_execution_command_provenance_invalid");
    expect(runnerCalls).toBe(0);

    const failed = await runRecipeVerificationGate({
      ...base,
      verificationControl: createRecipeVerificationControl({
        restoredFiles: application.files,
        restoredFileModes: snapshot.fileModes,
        recoveredResults: [replayed(application.verificationCommands[0]!, {
          exitCode: 9,
          stdout: "",
          stderr: "persisted adaptive failure",
        })],
        execute: async () => {
          throw new Error("later verifier must not run");
        },
      }),
    });
    expect(failed).toMatchObject({
      passed: false,
      failingCommandId: application.verificationCommands[0]!.id,
    });
    expect(failed.output).toContain("persisted adaptive failure");
    expect(runnerCalls).toBe(0);
  });

  it("verifies v2 runtime declarations with the real runner on the current host", async () => {
    const paths = fixture();
    const execution = await executeRecipeInWorkspace({
      fence: FENCE,
      assertFence: () => true,
      source: source(),
      recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
      evidenceDirectory: paths.evidenceDirectory,
      tempRoot: paths.tempRoot,
      observedAt: "2026-08-01T20:00:00.000Z",
    });

    expect(execution.recipe.version).toBe(2);
    expect(execution.commands.map((command) => command.id)).toEqual([
      "runtime-declarations",
      "package-engine",
    ]);
    expect(execution.commands.every((command) => command.exitCode === 0)).toBe(true);
  });

  it("keeps persisted v1 references on their exact signed command allowlist", async () => {
    const paths = fixture();
    const invocations: RecipeCommandInvocation[] = [];
    const legacy = getRecipe("node-runtime-18-to-20", 1);
    const execution = await executeRecipeInWorkspace({
      fence: FENCE,
      assertFence: () => true,
      source: source(),
      recipe: recipeReference(legacy),
      evidenceDirectory: paths.evidenceDirectory,
      tempRoot: paths.tempRoot,
      observedAt: "2026-08-01T20:00:00.000Z",
      commandRunner: successfulRunner(invocations),
    });

    expect(execution.recipe).toEqual(recipeReference(legacy));
    expect(execution.commands.map((command) => command.id)).toEqual([
      "node-major",
      "package-engine",
    ]);
    expect(invocations[0]?.args[2]).toContain("process.versions.node");
    expect(invocations[1]?.args[2]).toContain("require('./package.json')");
  });

  it("fails closed before execution when the source digest or exact revision is invalid", async () => {
    const paths = fixture();
    const invalidDigest = { ...source(), digest: `sha256:${"0".repeat(64)}` };
    await expect(
      executeRecipeInWorkspace({
        fence: FENCE,
        assertFence: () => true,
        source: invalidDigest,
        recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
        evidenceDirectory: paths.evidenceDirectory,
        observedAt: "2026-08-01T20:00:00.000Z",
        commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow("recipe_execution_source_digest_mismatch");

    await expect(
      executeRecipeInWorkspace({
        fence: FENCE,
        assertFence: () => true,
        source: { ...source(), revision: "main" },
        recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
        evidenceDirectory: paths.evidenceDirectory,
        observedAt: "2026-08-01T20:00:00.000Z",
        commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      }),
    ).rejects.toThrow("recipe_execution_revision_invalid");

    await expect(
      executeRecipeInWorkspace({
        fence: FENCE,
        assertFence: () => true,
        source: source(),
        recipe: {
          ...recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
          digest: `sha256:${"0".repeat(64)}`,
        },
        evidenceDirectory: paths.evidenceDirectory,
        observedAt: "2026-08-01T20:00:00.000Z",
      }),
    ).rejects.toThrow("recipe_digest_mismatch");
  });

  it("fails v2 verification when an optional runtime declaration does not target Node 20", async () => {
    const paths = fixture();
    const files = {
      ...FILES,
      Dockerfile: "FROM --platform=linux/amd64 node:18-alpine\nWORKDIR /app\n",
    };
    const error = await executeRecipeInWorkspace({
      fence: FENCE,
      assertFence: () => true,
      source: source(files),
      recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
      evidenceDirectory: paths.evidenceDirectory,
      tempRoot: paths.tempRoot,
      observedAt: "2026-08-01T20:00:00.000Z",
    }).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "recipe_execution_verification_failed:runtime-declarations",
      rollback: {
        attempted: true,
        inverseVerified: true,
        workspaceDiscarded: true,
      },
    });
  });

  it("checks the attempt fence at every side effect boundary", async () => {
    const paths = fixture();
    let assertions = 0;
    const error = await executeRecipeInWorkspace({
      fence: FENCE,
      assertFence: () => ++assertions < 2,
      source: source(),
      recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
      evidenceDirectory: paths.evidenceDirectory,
      tempRoot: paths.tempRoot,
      observedAt: "2026-08-01T20:00:00.000Z",
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(RecipeWorkspaceExecutionError);
    expect(error).toMatchObject({ code: "recipe_execution_fence_stale" });
    const executionError = error as RecipeWorkspaceExecutionError;
    expect(executionError.rollback.workspaceDiscarded).toBe(true);
    expect(executionError.rollback.attempted).toBe(false);
    expect(existsSync(paths.evidenceDirectory)).toBe(false);
  });

  it("detects command drift outside the file allowlist and discards the workspace", async () => {
    const paths = fixture();
    const error = await executeRecipeInWorkspace({
      fence: FENCE,
      assertFence: () => true,
      source: source(),
      recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
      evidenceDirectory: paths.evidenceDirectory,
      tempRoot: paths.tempRoot,
      observedAt: "2026-08-01T20:00:00.000Z",
      commandRunner: async (invocation) => {
        writeFileSync(join(invocation.cwd, "unexpected.txt"), "drift\n", "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(RecipeWorkspaceExecutionError);
    const executionError = error as RecipeWorkspaceExecutionError;
    expect(executionError.code).toBe(
      "recipe_workspace_drift:verification:runtime-declarations:paths",
    );
    expect(executionError.rollback).toMatchObject({
      attempted: true,
      inverseVerified: false,
      workspaceDiscarded: true,
    });
  });

  it("applies and verifies inverse rollback after a failed command", async () => {
    const paths = fixture();
    const error = await executeRecipeInWorkspace({
      fence: FENCE,
      assertFence: () => true,
      source: source(),
      recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
      evidenceDirectory: paths.evidenceDirectory,
      tempRoot: paths.tempRoot,
      observedAt: "2026-08-01T20:00:00.000Z",
      commandRunner: async () => ({ exitCode: 9, stdout: "", stderr: "failed" }),
    }).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      code: "recipe_execution_verification_failed:runtime-declarations",
      rollback: {
        attempted: true,
        inverseVerified: true,
        workspaceDiscarded: true,
      },
    });
  });

  it("restores the exact input in a fresh isolated workspace and persists restore evidence", async () => {
    const paths = fixture();
    const execution = await executeRecipeInWorkspace({
      fence: FENCE,
      assertFence: () => true,
      source: source(),
      recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
      evidenceDirectory: paths.evidenceDirectory,
      tempRoot: paths.tempRoot,
      observedAt: "2026-08-01T20:00:00.000Z",
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    const restored = await restoreRecipeExecutionInWorkspace({
      execution,
      currentFiles: execution.outputFiles,
      fence: FENCE,
      assertFence: () => true,
      evidenceDirectory: paths.evidenceDirectory,
      tempRoot: paths.tempRoot,
      observedAt: "2026-08-01T20:10:00.000Z",
    });

    expect(restored.restoredFiles).toEqual(FILES);
    expect(restored.outputDigest).toBe(execution.inputDigest);
    expect(restored.evidence.record).toMatchObject({
      kind: "transformer.recipe.restore",
      executionEvidenceDigest: execution.evidence.digest,
      restored: true,
    });
    expect(existsSync(restored.evidence.path)).toBe(true);
  });

  it("refuses restore after output drift or under a different fence", async () => {
    const paths = fixture();
    const execution = await executeRecipeInWorkspace({
      fence: FENCE,
      assertFence: () => true,
      source: source(),
      recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
      evidenceDirectory: paths.evidenceDirectory,
      observedAt: "2026-08-01T20:00:00.000Z",
      commandRunner: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });

    await expect(
      restoreRecipeExecutionInWorkspace({
        execution,
        currentFiles: { ...execution.outputFiles, Dockerfile: "FROM node:22-alpine\n" },
        fence: FENCE,
        assertFence: () => true,
        evidenceDirectory: paths.evidenceDirectory,
        observedAt: "2026-08-01T20:10:00.000Z",
      }),
    ).rejects.toThrow("recipe_restore_current_digest_mismatch");

    await expect(
      restoreRecipeExecutionInWorkspace({
        execution,
        currentFiles: execution.outputFiles,
        fence: { ...FENCE, leaseGeneration: FENCE.leaseGeneration + 1 },
        assertFence: () => true,
        evidenceDirectory: paths.evidenceDirectory,
        observedAt: "2026-08-01T20:10:00.000Z",
      }),
    ).rejects.toThrow("recipe_restore_fence_mismatch");

    writeFileSync(execution.evidence.path, "{}\n", "utf8");
    await expect(
      restoreRecipeExecutionInWorkspace({
        execution,
        currentFiles: execution.outputFiles,
        fence: FENCE,
        assertFence: () => true,
        evidenceDirectory: paths.evidenceDirectory,
        observedAt: "2026-08-01T20:10:00.000Z",
      }),
    ).rejects.toThrow("recipe_execution_evidence_digest_mismatch");
  });
});
