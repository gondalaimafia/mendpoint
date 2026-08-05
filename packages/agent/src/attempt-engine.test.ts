import {
  createHash,
} from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentPlanner, AgentTask } from "./types.js";
import {
  runWardenAttempt,
  type WardenAttemptInput,
  type WardenAttemptLimits,
} from "./attempt-engine.js";

const REVISION = "a".repeat(40);
const POLICY_DIGEST = `sha256:${"c".repeat(64)}`;
const SECRET_SENTINEL = "github_pat_warden_attempt_secret_must_not_escape_123456789";
const roots: string[] = [];

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, "utf8");
  }
}

function snapshotManifest(root: string): string {
  const files: Array<{
    path: string;
    mode: string;
    kind: "file";
    size: number;
    sha256: string;
  }> = [];
  const visit = (directory: string, prefix = ""): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const path = prefix ? `${prefix}/${name}` : name;
      const info = lstatSync(absolute);
      if (info.isDirectory()) {
        visit(absolute, path);
        continue;
      }
      const content = readFileSync(absolute);
      files.push({
        path,
        mode: (info.mode & 0o111) !== 0 ? "100755" : "100644",
        kind: "file",
        size: content.byteLength,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
  };
  visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return createHash("sha256")
    .update(JSON.stringify({ files, submodules: [], sparsePaths: [] }))
    .digest("hex");
}

function fixture(name: string, client = "export const path = '/v1/chargess';\n") {
  const base = mkdtempSync(join(tmpdir(), `mendpoint-warden-attempt-${name}-`));
  roots.push(base);
  const sourceRoot = join(base, "source");
  const candidateRoot = join(base, "candidates");
  const evidenceRoot = join(base, "evidence");
  writeTree(sourceRoot, {
    "client.js": client,
    "check.mjs": [
      "import { path } from './client.js';",
      "if (path !== '/v1/charges') process.exit(1);",
      "",
    ].join("\n"),
    "check-regression.mjs": "process.exit(0);\n",
    "check-security.mjs": "process.exit(0);\n",
    "package.json": JSON.stringify({
      scripts: {
        test: "node check.mjs",
        typecheck: "node check-regression.mjs",
        lint: "node check-security.mjs",
      },
      type: "module",
    }),
  });
  mkdirSync(candidateRoot, { recursive: true });
  mkdirSync(evidenceRoot, { recursive: true });
  return { base, sourceRoot, candidateRoot, evidenceRoot };
}

function planner(onFirstPlan?: () => void): AgentPlanner {
  let planned = false;
  return async (input) => {
    if (!planned) {
      planned = true;
      onFirstPlan?.();
    }
    const tools = input.recentSteps.map((step) => step.tool);
    if (!tools.includes("read_file")) {
      return {
        call: {
          tool: "read_file",
          args: { path: "client.js" },
          thought: "Inspect the exact client path before editing",
        },
      };
    }
    if (!tools.includes("replace_in_file")) {
      return {
        call: {
          tool: "replace_in_file",
          args: { path: "client.js", from: "chargess", to: "charges" },
          thought: "Apply the source grounded path correction",
        },
      };
    }
    return {
      call: {
        tool: "run_command",
        args: { command: "node check.mjs" },
        thought: "Verify the candidate",
      },
    };
  };
}

const LIMITS: WardenAttemptLimits = Object.freeze({
  maxSourceFiles: 40,
  maxSourceFileBytes: 1024 * 1024,
  maxSourceBytes: 4 * 1024 * 1024,
  maxTreeDepth: 12,
  maxChangedFiles: 2,
  maxChangedBytes: 64 * 1024,
  maxEvidenceBytes: 64 * 1024,
  verificationTimeoutMs: 15_000,
  allowedChangedPaths: Object.freeze(["client.js"]),
});

function task(value: AgentPlanner): Omit<AgentTask, "repoRoot" | "tenantId"> {
  return {
    goal: "Repair the API path. The correct endpoint is /v1/charges.",
    errorLog: "HTTP 404 for /v1/chargess, expected /v1/charges",
    maxSteps: 10,
    useLlm: true,
    planner: value,
    modelRequired: true,
    allowModelSource: true,
    modelSourcePolicy: {
      approved: true,
      tenantId: "tenant-a",
      policyDigest: POLICY_DIGEST,
      provider: "test-provider",
      model: "test-model",
      endpoint: "planner://test-provider/test-model",
    },
  };
}

function input(
  value: ReturnType<typeof fixture>,
  overrides: Partial<WardenAttemptInput> = {},
): WardenAttemptInput {
  return {
    scope: { tenantId: "tenant-a", attemptId: "attempt-a" },
    source: {
      repositoryId: "repository-a",
      snapshotId: "snapshot-a",
      revision: REVISION,
      manifestSha256: snapshotManifest(value.sourceRoot),
      sparsePaths: [],
      root: value.sourceRoot,
    },
    candidateRoot: value.candidateRoot,
    evidenceRoot: value.evidenceRoot,
    task: task(planner()),
    verification: {
      targetCommand: "node check.mjs",
      regressionCommands: ["npm run typecheck"],
      securityCommands: ["npm run lint"],
    },
    limits: LIMITS,
    ...overrides,
  };
}

describe("Warden attempt engine", () => {
  it("repairs only a private candidate and leaves the frozen source unchanged", async () => {
    const value = fixture("valid");
    const sourceBefore = readFileSync(join(value.sourceRoot, "client.js"), "utf8");

    const result = await runWardenAttempt(input(value));

    if (result.status === "rejected") throw new Error(`${result.code}: ${result.summary}`);
    expect(result.status).toBe("succeeded");
    expect(result.changedPaths).toEqual(["client.js"]);
    expect(result.artifacts.candidateWorkspace.startsWith(value.candidateRoot)).toBe(true);
    expect(readFileSync(join(result.artifacts.candidateWorkspace, "client.js"), "utf8"))
      .toContain("/v1/charges");
    expect(readFileSync(join(value.sourceRoot, "client.js"), "utf8")).toBe(sourceBefore);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.artifacts)).toBe(true);
  });

  it("rejects an already green target and removes the candidate workspace", async () => {
    const value = fixture("already-green", "export const path = '/v1/charges';\n");

    const result = await runWardenAttempt(input(value));

    expect(result).toMatchObject({
      status: "rejected",
      code: "warden_attempt_baseline_target_green",
      artifacts: { candidateWorkspace: null },
    });
    expect(readdirSync(value.candidateRoot)).toEqual([]);
  });

  it("rejects source content that does not match the stored snapshot manifest", async () => {
    const value = fixture("manifest-mismatch");
    const attempt = input(value);

    const result = await runWardenAttempt({
      ...attempt,
      source: { ...attempt.source, manifestSha256: "b".repeat(64) },
    });

    expect(result).toMatchObject({
      status: "rejected",
      code: "warden_attempt_snapshot_manifest_mismatch",
      artifacts: { candidateWorkspace: null },
    });
    expect(readdirSync(value.candidateRoot)).toEqual([]);
  });

  it("rejects a post edit regression and removes the candidate workspace", async () => {
    const value = fixture("regression");
    writeFileSync(
      join(value.sourceRoot, "check-regression.mjs"),
      [
        "import { path } from './client.js';",
        "if (path !== '/v1/chargess') process.exit(1);",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runWardenAttempt(input(value));

    expect(result).toMatchObject({
      status: "rejected",
      code: "warden_attempt_regression_failed",
      artifacts: { candidateWorkspace: null },
    });
    expect(readdirSync(value.candidateRoot)).toEqual([]);
  });

  it("blocks a symbolic link anywhere in the immutable source tree", async () => {
    const value = fixture("symlink");
    const external = join(value.base, "external.js");
    writeFileSync(external, "export const outside = true;\n", "utf8");
    try {
      symlinkSync(external, join(value.sourceRoot, "linked.js"), "file");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return;
      }
      throw error;
    }

    const result = await runWardenAttempt(input(value));

    expect(result).toMatchObject({ status: "rejected", code: "warden_attempt_source_symlink" });
    expect(readdirSync(value.candidateRoot)).toEqual([]);
  });

  it("detects immutable source mutation during agent execution", async () => {
    const value = fixture("source-mutation");
    const mutatingPlanner = planner(() => {
      writeFileSync(join(value.sourceRoot, "client.js"), "export const path = '/mutated';\n", "utf8");
    });

    const result = await runWardenAttempt(input(value, { task: task(mutatingPlanner) }));

    expect(result).toMatchObject({
      status: "rejected",
      code: "warden_attempt_source_mutated",
      artifacts: { candidateWorkspace: null },
    });
    expect(readdirSync(value.candidateRoot)).toEqual([]);
  });

  it("drops the workspace when the execution fence is lost", async () => {
    const value = fixture("fence-lost");
    let current = true;
    const fencedTask = {
      ...task(planner(() => { current = false; })),
      shouldContinue: () => current,
    };

    const result = await runWardenAttempt(input(value, { task: fencedTask }));

    expect(result).toMatchObject({
      status: "rejected",
      code: "warden_attempt_cancelled",
      artifacts: { candidateWorkspace: null },
    });
    expect(readdirSync(value.candidateRoot)).toEqual([]);
    expect(readdirSync(value.evidenceRoot)).toEqual([]);
  });

  it("blocks a repair outside the allowed changed path budget", async () => {
    const value = fixture("path-budget");
    const limits: WardenAttemptLimits = {
      ...LIMITS,
      allowedChangedPaths: ["src/approved.js"],
    };

    const result = await runWardenAttempt(input(value, { limits }));

    expect(result).toMatchObject({
      status: "rejected",
      code: "warden_attempt_changed_path_blocked",
      artifacts: { candidateWorkspace: null },
    });
  });

  it("rejects tests and verifier controls from the mutation scope", async () => {
    const value = fixture("verifier-scope");
    const limits: WardenAttemptLimits = {
      ...LIMITS,
      allowedChangedPaths: ["check.mjs"],
    };

    const result = await runWardenAttempt(input(value, { limits }));

    expect(result).toMatchObject({
      status: "rejected",
      code: "warden_attempt_verification_path_blocked",
    });
    expect(readdirSync(value.candidateRoot)).toEqual([]);
  });

  it("isolates concurrent attempts in distinct private workspaces", async () => {
    const value = fixture("concurrent");
    const [first, second] = await Promise.all([
      runWardenAttempt(input(value, {
        scope: { tenantId: "tenant-a", attemptId: "attempt-one" },
        task: task(planner()),
      })),
      runWardenAttempt(input(value, {
        scope: { tenantId: "tenant-a", attemptId: "attempt-two" },
        task: task(planner()),
      })),
    ]);

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    if (first.status !== "succeeded" || second.status !== "succeeded") return;
    expect(first.artifacts.candidateWorkspace).not.toBe(second.artifacts.candidateWorkspace);
    expect(readFileSync(join(first.artifacts.candidateWorkspace, "client.js"), "utf8"))
      .toBe(readFileSync(join(second.artifacts.candidateWorkspace, "client.js"), "utf8"));
  });

  it("never writes repository secret values into manifest or evidence artifacts", async () => {
    const value = fixture("secret-artifacts");
    writeFileSync(join(value.sourceRoot, ".env"), `TOKEN=${SECRET_SENTINEL}\n`, "utf8");

    const result = await runWardenAttempt(input(value));

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;
    const manifest = readFileSync(result.artifacts.candidateManifest, "utf8");
    const evidence = readFileSync(result.artifacts.evidence, "utf8");
    expect(manifest).not.toContain(SECRET_SENTINEL);
    expect(evidence).not.toContain(SECRET_SENTINEL);
    expect(manifest).toContain("sha256:");
    expect(evidence).toContain("sourceDigest");
  });
});
