import {
  createHash,
} from "node:crypto";
import {
  existsSync,
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
import { ABSENT_FILE_EVIDENCE_DIGEST } from "./agent.js";
import type { WardenCheckpointJournal, WardenCheckpointJournalRecord } from "./checkpoint.js";
import {
  runWardenAttempt,
  scanTree,
  wardenNpmFallbackEnvironment,
  type WardenAttemptInput,
  type WardenAttemptLimits,
} from "./attempt-engine.js";
import { EXCLUDED_DIRECTORIES } from "./policies.js";

const REVISION = "a".repeat(40);
const POLICY_DIGEST = `sha256:${"c".repeat(64)}`;
const SECRET_SENTINEL = "github_pat_warden_attempt_secret_must_not_escape_123456789";
const roots: string[] = [];

function checkpointJournal(): WardenCheckpointJournal & {
  setLease(value: number): void;
  failReadAfterGeneration(value: number): void;
  record(): WardenCheckpointJournalRecord;
} {
  let record: WardenCheckpointJournalRecord = {
    envelope: null,
    sealedRuntimeState: null,
    activeWriterLeaseGeneration: 1,
  };
  let failReadGeneration: number | null = null;
  let failNextRead = false;
  return {
    async read() {
      if (failNextRead) {
        failNextRead = false;
        throw new Error("worker_crashed_after_checkpoint_commit");
      }
      return record;
    },
    async compareAndSwap(input) {
      if (record.activeWriterLeaseGeneration !== input.expectedActiveWriterLeaseGeneration ||
          record.envelope?.payloadDigest !== input.expectedPayloadDigest &&
          !(record.envelope === null && input.expectedPayloadDigest === null)) {
        return false;
      }
      record = {
        envelope: input.nextEnvelope,
        sealedRuntimeState: input.nextSealedRuntimeState,
        activeWriterLeaseGeneration: record.activeWriterLeaseGeneration,
      };
      if (input.nextEnvelope.payload.generation === failReadGeneration) {
        failNextRead = true;
      }
      return true;
    },
    setLease(value) {
      record = { ...record, activeWriterLeaseGeneration: value };
    },
    failReadAfterGeneration(value) {
      failReadGeneration = value;
    },
    record() {
      return record;
    },
  };
}

// An attempt this file spawns can still be releasing its working directory when
// cleanup runs, and on Windows that surfaces as an EPERM/EBUSY that rmSync's own
// maxRetries does not retry. Retry manually so the just-terminated child's
// directory handle is released instead of leaking the temp tree; a directory
// that stays locked past the budget still throws rather than being swallowed.
function removeTreeSync(target: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY") && attempt < 50) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        continue;
      }
      throw error;
    }
  }
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) removeTreeSync(root);
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
      // Mirror scanTree: symbolic links are never followed or hashed.
      if (info.isSymbolicLink()) continue;
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

function planner(
  onFirstPlan?: () => void,
  intentRisk: "low" | "medium" | "high" | "critical" = "low",
): AgentPlanner {
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
        usage: PER_CALL_USAGE,
      };
    }
    if (!tools.includes("replace_in_file")) {
      const target = input.observedEvidenceDigests?.find((item) => item.path === "client.js");
      if (!target) throw new Error("planner did not receive the current client.js digest");
      return {
        call: {
          tool: "replace_in_file",
          args: { path: "client.js", from: "chargess", to: "charges" },
          thought: "Apply the source grounded path correction",
          intent: {
            schemaVersion: 1,
            hypothesis: "The duplicated s in the observed charge path causes the target failure.",
            targetPath: "client.js",
            targetSymbol: "path",
            targetDigest: target.digest,
            evidenceRefs: [{ path: target.path, digest: target.digest }],
            precondition: "The observed client still contains /v1/chargess.",
            expectedObservation: "The exact observed path literal can be replaced once.",
            postcondition: "The candidate uses /v1/charges and all configured checks pass.",
            rollback: "Restore the exact observed client.js bytes.",
            confidence: 0.94,
            risk: intentRisk,
            stopCondition: "Stop if the target digest changes or any verifier fails.",
          },
        },
        usage: PER_CALL_USAGE,
      };
    }
    return {
      call: {
        tool: "run_command",
        args: { command: "node check.mjs" },
        thought: "Verify the candidate",
      },
      usage: PER_CALL_USAGE,
    };
  };
}

function deletionPlanner(onDelete?: () => void): AgentPlanner {
  return async (input) => {
    const tools = input.recentSteps.map((step) => step.tool);
    if (!tools.includes("read_file")) {
      return {
        call: {
          tool: "read_file",
          args: { path: "obsolete.js" },
          thought: "Observe the complete obsolete file before removing it",
        },
        usage: PER_CALL_USAGE,
      };
    }
    if (!tools.includes("delete_file")) {
      const target = input.observedEvidenceDigests?.find((item) => item.path === "obsolete.js");
      if (!target) throw new Error("planner did not receive the obsolete.js digest");
      onDelete?.();
      return {
        call: {
          tool: "delete_file",
          args: { path: "obsolete.js" },
          thought: "Remove only the fully observed obsolete file",
          intent: {
            schemaVersion: 1,
            hypothesis: "The tracked obsolete module must be absent for the repository check to pass.",
            targetPath: "obsolete.js",
            targetSymbol: null,
            targetDigest: target.digest,
            evidenceRefs: [{ path: target.path, digest: target.digest }],
            precondition: "The exact observed obsolete.js digest remains current.",
            expectedObservation: "The tracked regular file becomes absent.",
            postcondition: "The candidate omits obsolete.js and all configured checks pass.",
            rollback: "Restore the exact observed bytes and file mode.",
            confidence: 0.98,
            risk: "high",
            stopCondition: "Stop if the source digest changes or deletion is not exact.",
          },
        },
        usage: PER_CALL_USAGE,
      };
    }
    return {
      call: {
        tool: "run_command",
        args: { command: "node check.mjs" },
        thought: "Verify the exact absence and all configured checks",
      },
      usage: PER_CALL_USAGE,
    };
  };
}

const PER_CALL_USAGE = Object.freeze({
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  costUsd: 0.0025,
});

/** A planner that attaches measured token usage + cost to every plan. */
function meteredPlanner(): AgentPlanner {
  const base = planner();
  return async (value, options) => ({
    ...(await base(value, options)),
    usage: PER_CALL_USAGE,
  });
}

const LIMITS: WardenAttemptLimits = Object.freeze({
  maxSourceFiles: 40,
  maxSourceFileBytes: 1024 * 1024,
  maxSourceBytes: 4 * 1024 * 1024,
  maxTreeDepth: 12,
  maxChangedFiles: 2,
  maxChangedFileBytes: 256 * 1024,
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
    externalModelAccounting: {
      executionScopeId: `sha256:${"d".repeat(64)}`,
      maximumCostUsd: 1,
      reserve: async () => undefined,
      settle: async () => undefined,
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

describe("Warden attempt engine", { timeout: 15_000 }, () => {
  it("persists an evidence grounded mission plan and revises it after verifier feedback", async () => {
    const value = fixture(
      "runtime-mission-plan",
      "export const path = '/v1/chargess';\nexport const method = 'GETT';\n",
    );
    writeFileSync(join(value.sourceRoot, "check.mjs"), [
      "import { method, path } from './client.js';",
      "if (path !== '/v1/charges' || method !== 'GET') process.exit(1);",
      "",
    ].join("\n"), "utf8");
    const journal = checkpointJournal();
    const plannedInputs: Parameters<AgentPlanner>[0][] = [];
    const missionPlanner: AgentPlanner = async (plannerInput) => {
      plannedInputs.push(plannerInput);
      const recent = plannerInput.recentSteps;
      const replacements = recent.filter((step) => step.tool === "replace_in_file");
      const current = plannerInput.observedEvidenceDigests?.find((entry) =>
        entry.path === "client.js"
      );
      const reads = recent.filter((step) => step.tool === "read_file");
      if (reads.length === 0) {
        return {
          call: {
            tool: "read_file",
            args: { path: "client.js" },
            thought: "Inspect the exact failing client before planning a repair",
          },
          usage: PER_CALL_USAGE,
        };
      }
      if (reads.length === 1) {
        return {
          call: {
            tool: "read_file",
            args: { path: "check.mjs" },
            thought: "Inspect the exact target verifier before editing",
          },
          usage: PER_CALL_USAGE,
        };
      }
      if (replacements.length === 0) {
        if (!current) throw new Error("missing evidence for the path correction");
        return {
          call: {
            tool: "replace_in_file",
            args: { path: "client.js", from: "chargess", to: "charges" },
            thought: "Correct the observed endpoint typo",
            intent: {
              schemaVersion: 1,
              hypothesis: "The observed duplicated s causes the endpoint failure.",
              targetPath: "client.js",
              targetSymbol: "path",
              targetDigest: current.digest,
              evidenceRefs: [{ ...current }],
              precondition: "The exact observed endpoint typo is still present.",
              expectedObservation: "The endpoint literal changes exactly once.",
              postcondition: "The endpoint is correct and the verifier advances.",
              rollback: "Restore the exact observed client bytes.",
              confidence: 0.96,
              risk: "low",
              stopCondition: "Stop if the source digest changes.",
            },
          },
          usage: PER_CALL_USAGE,
        };
      }
      const verifierRuns = recent.filter((step) => step.tool === "run_command");
      if (replacements.length === 1 && verifierRuns.length < 2) {
        return {
          call: {
            tool: "run_command",
            args: { command: plannerInput.verifyCommand },
            thought: "Test the first hypothesis against the target verifier",
          },
          usage: PER_CALL_USAGE,
        };
      }
      if (replacements.length === 1) {
        if (!current) throw new Error("missing evidence for the method correction");
        return {
          call: {
            tool: "replace_in_file",
            args: { path: "client.js", from: "GETT", to: "GET" },
            thought: "Revise the plan from the remaining verifier failure",
            intent: {
              schemaVersion: 1,
              hypothesis: "The endpoint fix was insufficient because the observed method is invalid.",
              targetPath: "client.js",
              targetSymbol: "method",
              targetDigest: current.digest,
              evidenceRefs: [{ ...current }],
              precondition: "The candidate still contains the exact invalid method literal.",
              expectedObservation: "The method literal changes exactly once.",
              postcondition: "The corrected endpoint and method pass the verifier.",
              rollback: "Restore the exact post-endpoint-repair client bytes.",
              confidence: 0.93,
              risk: "low",
              stopCondition: "Stop if the candidate digest changes.",
            },
          },
          usage: PER_CALL_USAGE,
        };
      }
      return {
        call: {
          tool: "run_command",
          args: { command: plannerInput.verifyCommand },
          thought: "Verify the revised repair plan",
        },
        usage: PER_CALL_USAGE,
      };
    };
    const plannedTask = task(missionPlanner);
    const result = await runWardenAttempt(input(value, {
      task: {
        ...plannedTask,
        goal: "Repair the endpoint and HTTP method using exact repository evidence.",
        errorLog: "The target verifier reports an endpoint or method mismatch.",
        maxSteps: 12,
      },
      runtime: {
        jobId: "job-runtime-mission-plan",
        journal,
        key: Buffer.alloc(32, 13),
        writerLeaseGeneration: 1,
        executorDigest: `sha256:${"e".repeat(64)}`,
      },
    }));

    if (result.status === "rejected") throw new Error(`${result.code}: ${result.summary}`);
    expect(plannedInputs.length).toBe(6);
    expect(result.agent.missionPlan).toMatchObject({
      schemaVersion: 1,
      activeRevision: 6,
      outcome: "verified",
      blockerReason: null,
      revisions: [
        { revision: 1, parentRevision: null, action: { tool: "read_file" } },
        { revision: 2, parentRevision: 1, action: { tool: "read_file" } },
        {
          revision: 3,
          parentRevision: 2,
          hypothesis: "The observed duplicated s causes the endpoint failure.",
          confidence: 0.96,
          risk: "high",
          acceptanceChecks: {
            precondition: "The exact observed endpoint typo is still present.",
            postcondition: "The endpoint is correct and the verifier advances.",
          },
          action: { tool: "replace_in_file", targetPath: "client.js", status: "succeeded" },
          evidenceRefs: [expect.objectContaining({ path: "client.js" })],
        },
        { revision: 4, parentRevision: 3, action: { tool: "run_command", status: "failed" } },
        {
          revision: 5,
          parentRevision: 4,
          hypothesis: "The endpoint fix was insufficient because the observed method is invalid.",
          action: { tool: "replace_in_file", targetPath: "client.js", status: "succeeded" },
        },
        { revision: 6, parentRevision: 5, action: { tool: "run_command", status: "succeeded" } },
      ],
    });
    const revisions = result.agent.missionPlan!.revisions;
    expect(revisions.every((revision) => /^sha256:[a-f0-9]{64}$/.test(revision.plannerEffectId)))
      .toBe(true);
    expect(revisions[4].verifierFeedbackDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(revisions[4].verifierFeedbackDigest).not.toBe(revisions[2].verifierFeedbackDigest);
    expect(result.agent.reportMarkdown).toContain("#### Mission plan");
    expect(result.agent.reportMarkdown).toContain("Revision 5: The endpoint fix was insufficient");
    expect(() => {
      (result.agent.missionPlan as { activeRevision: number }).activeRevision = 99;
    }).toThrow();
    const evidence = JSON.parse(readFileSync(result.artifacts.evidence, "utf8")) as {
      agent: { missionPlan: unknown };
    };
    expect(evidence.agent.missionPlan).toEqual(result.agent.missionPlan);
  }, 30_000);

  it("records the blocker and refuses a planned mutation with stale evidence", async () => {
    const value = fixture("runtime-mission-plan-stale");
    const before = readFileSync(join(value.sourceRoot, "client.js"), "utf8");
    const stalePlanner: AgentPlanner = async (plannerInput) => {
      if (!plannerInput.recentSteps.some((step) => step.tool === "list_dir")) {
        return {
          call: { tool: "list_dir", args: { path: "." }, thought: "Inspect the repository root" },
          usage: PER_CALL_USAGE,
        };
      }
      return {
        call: {
          tool: "write_file",
          args: { path: "helper.js", content: "export const value = 42;\n" },
          thought: "Attempt a stale evidence mutation",
          intent: {
            schemaVersion: 1,
            hypothesis: "helper.js is absent and may be created only from current evidence.",
            targetPath: "helper.js",
            targetSymbol: "value",
            targetDigest: ABSENT_FILE_EVIDENCE_DIGEST,
            evidenceRefs: [
              { path: "helper.js", digest: ABSENT_FILE_EVIDENCE_DIGEST },
              { path: "forged.js", digest: `sha256:${"0".repeat(64)}` },
            ],
            precondition: "The observed repository has no helper.js.",
            expectedObservation: "Every evidence reference matches the repository.",
            postcondition: "helper.js exports value.",
            rollback: "Remove helper.js.",
            confidence: 0.7,
            risk: "low",
            stopCondition: "Stop on stale evidence.",
          },
        },
        usage: PER_CALL_USAGE,
      };
    };
    const staleTask = task(stalePlanner);
    const result = await runWardenAttempt(input(value, {
      task: staleTask,
      runtime: {
        jobId: "job-runtime-mission-plan-stale",
        journal: checkpointJournal(),
        key: Buffer.alloc(32, 14),
        writerLeaseGeneration: 1,
        executorDigest: `sha256:${"e".repeat(64)}`,
      },
    }));

    expect(result).toMatchObject({
      status: "rejected",
      code: "warden_attempt_agent_failed",
      agent: {
        stoppedReason: "mutation_intent_evidence_stale",
        missionPlan: {
          outcome: "failed",
          blockerReason: "mutation_intent_evidence_stale",
          activeRevision: 2,
          revisions: [
            { revision: 1, action: { tool: "list_dir", status: "succeeded" } },
            { revision: 2, action: { tool: "write_file", status: "planned" } },
          ],
        },
      },
    });
    expect(readFileSync(join(value.sourceRoot, "client.js"), "utf8")).toBe(before);
    expect(() => readFileSync(join(value.sourceRoot, "helper.js"), "utf8")).toThrow();
  }, 30_000);

  it("replays a paid planner receipt after rebuilding the candidate on takeover", async () => {
    const value = fixture("runtime-planner-replay");
    writeFileSync(join(value.sourceRoot, "check.mjs"), [
      "import { path } from './client.js';",
      "console.error(`baseline-${Date.now()}-${process.cwd()}`);",
      "if (path !== '/v1/charges') process.exit(1);",
      "",
    ].join("\n"), "utf8");
    const journal = checkpointJournal();
    let plannerCalls = 0;
    let reservations = 0;
    let settlements = 0;
    const finishPlanner: AgentPlanner = async () => {
      plannerCalls++;
      return {
        call: { tool: "finish", args: { ok: false, message: "review required" } },
        usage: PER_CALL_USAGE,
      };
    };
    const firstTask = task(finishPlanner);
    const firstInput = input(value, {
      task: {
        ...firstTask,
        externalModelAccounting: {
          ...firstTask.externalModelAccounting!,
          reserve: async () => { reservations++; },
          settle: async () => { settlements++; },
        },
      },
      runtime: {
        jobId: "job-runtime-planner-replay",
        journal,
        key: Buffer.alloc(32, 7),
        writerLeaseGeneration: 1,
        executorDigest: `sha256:${"e".repeat(64)}`,
      },
    });
    // Genesis is generation 1. The checkpoint-owned baseline verifier consumes
    // generations 2 through 5 and the paid planner consumes 6 through 9.
    journal.failReadAfterGeneration(9);

    const interrupted = await runWardenAttempt(firstInput);
    expect(interrupted).toMatchObject({
      status: "rejected",
      code: "warden_attempt_internal_error",
      summary: "worker_crashed_after_checkpoint_commit",
    });
    expect(plannerCalls).toBe(1);
    expect(reservations).toBe(1);
    expect(settlements).toBe(1);

    journal.setLease(2);
    const second = await runWardenAttempt({
      ...firstInput,
      task: {
        ...firstInput.task,
        externalModelAccounting: {
          ...firstInput.task.externalModelAccounting!,
          executionScopeId: `sha256:${"f".repeat(64)}`,
        },
      },
      runtime: { ...firstInput.runtime!, writerLeaseGeneration: 2 },
    });

    expect(second).toMatchObject({ status: "rejected", code: "warden_attempt_agent_failed" });
    expect(second.agent?.missionPlan).toMatchObject({
      schemaVersion: 1,
      activeRevision: 1,
      revisions: [{ revision: 1, parentRevision: null, action: { tool: "finish" } }],
    });
    expect(plannerCalls).toBe(1);
    expect(reservations).toBe(1);
    expect(settlements).toBe(1);
  });

  it("rebuilds a deleted workspace from a committed mutation without applying it twice", async () => {
    const value = fixture("runtime-mutation-replay");
    const journal = checkpointJournal();
    let plannerCalls = 0;
    let reservations = 0;
    let settlements = 0;
    const repairPlanner = planner();
    const trackedPlanner: AgentPlanner = async (request, options) => {
      plannerCalls++;
      return await repairPlanner(request, options);
    };
    const trackedTask = task(trackedPlanner);
    const firstInput = input(value, {
      task: {
        ...trackedTask,
        externalModelAccounting: {
          ...trackedTask.externalModelAccounting!,
          reserve: async () => { reservations++; },
          settle: async () => { settlements++; },
        },
      },
      runtime: {
        jobId: "job-runtime-mutation-replay",
        journal,
        key: Buffer.alloc(32, 8),
        writerLeaseGeneration: 1,
        executorDigest: `sha256:${"e".repeat(64)}`,
      },
    });
    // Baseline: 2 to 5. Planner/read/planner/mutation each consume four
    // generations, so generation 21 is the committed mutation receipt.
    journal.failReadAfterGeneration(21);

    const interrupted = await runWardenAttempt(firstInput);
    expect(interrupted).toMatchObject({
      status: "rejected",
      code: "warden_attempt_internal_error",
      summary: "worker_crashed_after_checkpoint_commit",
    });
    expect(plannerCalls).toBe(2);
    expect(reservations).toBe(2);
    expect(settlements).toBe(2);

    journal.setLease(2);
    const recovered = await runWardenAttempt({
      ...firstInput,
      runtime: { ...firstInput.runtime!, writerLeaseGeneration: 2 },
    });

    if (recovered.status === "rejected") {
      throw new Error(`${recovered.code}: ${recovered.summary}`);
    }
    expect(recovered.changedPaths).toEqual(["client.js"]);
    expect(readFileSync(join(recovered.artifacts.candidateWorkspace, "client.js"), "utf8"))
      .toContain("/v1/charges");
    expect(plannerCalls).toBe(3);
    expect(reservations).toBe(3);
    expect(settlements).toBe(3);
  }, 30_000);

  it("replays a committed exact deletion after takeover and preserves review evidence", async () => {
    const value = fixture("runtime-deletion-replay");
    writeFileSync(join(value.sourceRoot, "obsolete.js"), "export const obsolete = true;\n", "utf8");
    writeFileSync(join(value.sourceRoot, "check.mjs"), [
      "import { existsSync } from 'node:fs';",
      "if (existsSync(new URL('./obsolete.js', import.meta.url))) process.exit(1);",
      "",
    ].join("\n"), "utf8");
    const journal = checkpointJournal();
    let plannedDeletes = 0;
    const deleteTask = task(deletionPlanner(() => { plannedDeletes++; }));
    const firstInput = input(value, {
      task: {
        ...deleteTask,
        goal: "Remove the fully observed obsolete module and verify the repository.",
        errorLog: "The target check fails while obsolete.js remains tracked.",
      },
      limits: { ...LIMITS, allowedChangedPaths: ["obsolete.js"] },
      runtime: {
        jobId: "job-runtime-deletion-replay",
        journal,
        key: Buffer.alloc(32, 14),
        writerLeaseGeneration: 1,
        executorDigest: `sha256:${"e".repeat(64)}`,
      },
    });
    journal.failReadAfterGeneration(21);

    const interrupted = await runWardenAttempt(firstInput);
    expect(interrupted).toMatchObject({
      status: "rejected",
      code: "warden_attempt_internal_error",
      summary: "worker_crashed_after_checkpoint_commit",
    });

    journal.setLease(2);
    const recovered = await runWardenAttempt({
      ...firstInput,
      runtime: { ...firstInput.runtime!, writerLeaseGeneration: 2 },
    });
    if (recovered.status === "rejected") {
      throw new Error(`${recovered.code}: ${recovered.summary}`);
    }
    expect(recovered.changedPaths).toEqual(["obsolete.js"]);
    expect(existsSync(join(recovered.artifacts.candidateWorkspace, "obsolete.js"))).toBe(false);
    const evidence = JSON.parse(readFileSync(recovered.artifacts.evidence, "utf8")) as {
      review: { edits: Array<{ path: string; sourceEvidence: Array<{ path: string }> }> };
    };
    expect(evidence.review.edits).toEqual([
      expect.objectContaining({
        path: "obsolete.js",
        sourceEvidence: [expect.objectContaining({ path: "obsolete.js" })],
      }),
    ]);
    expect(plannedDeletes).toBe(1);
  }, 30_000);

  it("replays a committed verifier result after takeover without running it twice", async () => {
    const value = fixture("runtime-verifier-replay");
    const counterPath = join(value.base, "verifier-count.txt").replace(/\\/g, "\\\\");
    writeFileSync(join(value.sourceRoot, "check.mjs"), [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import { path } from './client.js';",
      `const counter = '${counterPath}';`,
      "let count = 0;",
      "try { count = Number(readFileSync(counter, 'utf8')); } catch {}",
      "writeFileSync(counter, String(count + 1));",
      "if (path !== '/v1/charges') process.exit(1);",
      "",
    ].join("\n"), "utf8");
    const journal = checkpointJournal();
    const trackedTask = task(planner());
    const firstInput = input(value, {
      task: trackedTask,
      runtime: {
        jobId: "job-runtime-verifier-replay",
        journal,
        key: Buffer.alloc(32, 9),
        writerLeaseGeneration: 1,
        executorDigest: `sha256:${"e".repeat(64)}`,
      },
    });
    // After baseline, two planners, read, and mutation, the third planner ends
    // at generation 25. Generation 28 contains the verifier result but not its
    // consumed receipt.
    journal.failReadAfterGeneration(28);

    const interrupted = await runWardenAttempt(firstInput);
    expect(interrupted).toMatchObject({ status: "rejected", code: "warden_attempt_internal_error" });
    expect(Number(readFileSync(join(value.base, "verifier-count.txt"), "utf8"))).toBe(3);

    journal.setLease(2);
    const recovered = await runWardenAttempt({
      ...firstInput,
      runtime: { ...firstInput.runtime!, writerLeaseGeneration: 2 },
    });

    if (recovered.status === "rejected") {
      throw new Error(`${recovered.code}: ${recovered.summary}`);
    }
    expect(Number(readFileSync(join(value.base, "verifier-count.txt"), "utf8"))).toBe(5);
  });

  it("defers sealing the independently verified candidate until atomic completion", async () => {
    const value = fixture("runtime-terminal-evidence");
    const journal = checkpointJournal();
    const result = await runWardenAttempt(input(value, {
      runtime: {
        jobId: "job-runtime-terminal-evidence",
        journal,
        key: Buffer.alloc(32, 10),
        writerLeaseGeneration: 1,
        executorDigest: `sha256:${"e".repeat(64)}`,
      },
    }));

    if (result.status === "rejected") throw new Error(`${result.code}: ${result.summary}`);
    expect(journal.record().envelope?.payload.phase).toBe("agent_running");
    const terminalCheckpoint = await result.finalizeTerminal!();
    expect(terminalCheckpoint).toEqual({
      envelope: journal.record().envelope,
      sealedRuntimeState: journal.record().sealedRuntimeState,
    });
    expect(terminalCheckpoint).toMatchObject({
      envelope: {
        payload: { phase: "terminal" },
        payloadDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
      sealedRuntimeState: {
        algorithm: "AES-256-GCM",
        checkpointPayloadDigest: terminalCheckpoint.envelope.payloadDigest,
      },
    });
  });

  it("repairs only a private candidate and leaves the frozen source unchanged", async () => {
    const value = fixture("valid");
    const sourceBefore = readFileSync(join(value.sourceRoot, "client.js"), "utf8");

    const result = await runWardenAttempt(input(value));

    if (result.status === "rejected") throw new Error(`${result.code}: ${result.summary}`);
    expect(result.status).toBe("succeeded");
    expect(result.changedPaths).toEqual(["client.js"]);
    expect(result.artifacts).toMatchObject({
      candidateManifestSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      evidenceSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(result.artifacts.candidateWorkspace.startsWith(value.candidateRoot)).toBe(true);
    expect(readFileSync(join(result.artifacts.candidateWorkspace, "client.js"), "utf8"))
      .toContain("/v1/charges");
    expect(readFileSync(join(value.sourceRoot, "client.js"), "utf8")).toBe(sourceBefore);
    const evidence = JSON.parse(readFileSync(result.artifacts.evidence, "utf8")) as { review: unknown };
    expect(evidence.review).toMatchObject({
      schemaVersion: 2,
      verification: {
        commands: [
          { command: "node check.mjs", ok: true, exitCode: 0 },
          { command: "npm run typecheck", ok: true, exitCode: 0 },
          { command: "npm run lint", ok: true, exitCode: 0 },
        ],
      },
      edits: [{
        path: "client.js",
        hypothesis: "The duplicated s in the observed charge path causes the target failure.",
        targetSymbol: "path",
        sourceEvidence: [{
          path: "client.js",
          digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }],
        precondition: "The observed client still contains /v1/chargess.",
        expectedObservation: "The exact observed path literal can be replaced once.",
        postcondition: "The candidate uses /v1/charges and all configured checks pass.",
        rollback: "Restore the exact observed client.js bytes.",
        stopCondition: "Stop if the target digest changes or any verifier fails.",
        risk: "high",
        confidence: 0.94,
        assessmentSource: "planner",
        verification: {
          commandOutputSha256: [
            expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          ],
        },
      }],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.artifacts)).toBe(true);
  });

  it("records a failed verification on the reject path instead of dropping it", async () => {
    const value = fixture("reject-verification-failure");
    // The agent runs and passes the target on the repaired candidate, so it
    // produces a candidate and the engine reaches its own regression gate. That
    // regression verifier passes on the still-broken source (baseline) but fails
    // on the repaired candidate, so the attempt rejects at the regression gate
    // with a genuine failed verification the reject path must record.
    writeFileSync(join(value.sourceRoot, "check-regression.mjs"), [
      "import { path } from './client.js';",
      "if (path === '/v1/charges') process.exit(1);",
      "",
    ].join("\n"), "utf8");

    const result = await runWardenAttempt(input(value));

    expect(result).toMatchObject({ status: "rejected", code: "warden_attempt_regression_failed" });
    const verifications = result.capture?.verifications ?? [];
    // The observed failure is durably captured, not lost: the reject path carries
    // the regression verification with its three-state verdict and real exit code,
    // alongside the target it did pass.
    const target = verifications.find((entry) => entry.command === "node check.mjs");
    expect(target?.verdict).toBe("passed");
    const regression = verifications.find((entry) => entry.command === "npm run typecheck");
    expect(regression).toBeDefined();
    expect(regression?.verdict).toBe("failed");
    expect(regression?.exitCode).toBe(1);
  });

  it("rejects a changed file that cannot fit the review and seal contract", async () => {
    const value = fixture("changed-file-review-limit");

    const result = await runWardenAttempt(input(value, {
      limits: { ...LIMITS, maxChangedFileBytes: 16 },
    }));

    expect(result).toMatchObject({
      status: "rejected",
      code: "warden_attempt_changed_file_byte_limit",
    });
    expect(readdirSync(value.candidateRoot)).toEqual([]);
  });

  it("passes only operational keys to the development npm fallback", () => {
    expect(wardenNpmFallbackEnvironment({
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      NODE_ENV: "test",
      CI: "1",
      GITHUB_TOKEN: "github_pat_secret",
      OPENAI_API_KEY: "sk-secret",
      DATABASE_URL: "postgres://secret",
      MENDPOINT_API_KEY: "mendpoint-secret",
      npm_config_userconfig: "C:\\secret\\.npmrc",
      NODE_OPTIONS: "--require C:\\secret\\capture.cjs",
    })).toEqual({
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      NODE_ENV: "test",
      CI: "1",
    });
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

  it("executes an explicitly authorized feature task from a fully green baseline", async () => {
    const value = fixture(
      "feature-green",
      "export const path = '/v1/charges';\nconst clientLabel = 'legacy';\n",
    );
    const featurePlanner: AgentPlanner = async (plannerInput) => {
      const tools = plannerInput.recentSteps.map((step) => step.tool);
      if (!tools.includes("read_file")) {
        return {
          call: {
            tool: "read_file",
            args: { path: "client.js" },
            thought: "Inspect the exact client before adding the requested feature",
          },
          usage: PER_CALL_USAGE,
        };
      }
      if (!tools.includes("replace_in_file")) {
        const target = plannerInput.observedEvidenceDigests?.find((item) =>
          item.path === "client.js"
        );
        if (!target) throw new Error("feature planner did not receive client evidence");
        return {
          call: {
            tool: "replace_in_file",
            args: {
              path: "client.js",
              from: "const clientLabel = 'legacy';",
              to: "const clientLabel = 'payments';",
            },
            thought: "Add the bounded client label requested by the feature task",
            intent: {
              schemaVersion: 1,
              hypothesis: "The requested client label value differs from the observed client module.",
              targetPath: "client.js",
              targetSymbol: "clientLabel",
              targetDigest: target.digest,
              evidenceRefs: [{ path: target.path, digest: target.digest }],
              precondition: "The observed client label is legacy.",
              expectedObservation: "The client label changes once without changing the charges path.",
              postcondition: "The feature is present and every approved verifier remains green.",
              rollback: "Restore the exact observed client.js bytes.",
              confidence: 0.95,
              risk: "low",
              stopCondition: "Stop if the target digest changes or a verifier fails.",
            },
          },
          usage: PER_CALL_USAGE,
        };
      }
      return {
        call: {
          tool: "run_command",
          args: { command: "node check.mjs" },
          thought: "Verify the feature candidate",
        },
        usage: PER_CALL_USAGE,
      };
    };

    const result = await runWardenAttempt(input(value, {
      mode: "feature",
      task: {
        ...task(featurePlanner),
        goal: "Add a clientLabel constant set to payments without changing the charges path.",
        errorLog: undefined,
      },
    }));

    expect(result).toMatchObject({
      status: "succeeded",
      changedPaths: ["client.js"],
    });
    if (result.status !== "succeeded") return;
    const evidence = JSON.parse(readFileSync(result.artifacts.evidence, "utf8")) as {
      taskMode?: string;
      baseline?: { target?: { ok?: boolean } };
    };
    expect(evidence.taskMode).toBe("feature");
    expect(evidence.baseline?.target?.ok).toBe(true);
  });

  it("rejects a feature task with a failing baseline before planner execution", async () => {
    const value = fixture("feature-red-baseline");
    let plannerCalls = 0;
    const basePlanner = planner();
    const featurePlanner: AgentPlanner = async (plannerInput, options) => {
      plannerCalls++;
      return basePlanner(plannerInput, options);
    };

    const result = await runWardenAttempt(input(value, {
      mode: "feature",
      task: {
        ...task(featurePlanner),
        goal: "Add a new client feature from a clean baseline.",
        errorLog: undefined,
      },
    }));

    expect(result).toMatchObject({
      status: "rejected",
      code: "warden_attempt_feature_baseline_failed",
      artifacts: { candidateWorkspace: null },
    });
    expect(plannerCalls).toBe(0);
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

  it("refuses a symbolic link whose target escapes the immutable source root", async () => {
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

  it("surfaces measured model cost and tokens from a model backed run", async () => {
    const value = fixture("metered");

    const result = await runWardenAttempt(input(value, { task: task(meteredPlanner()) }));

    if (result.status === "rejected") throw new Error(`${result.code}: ${result.summary}`);
    expect(result.status).toBe("succeeded");
    const calls = result.agent.modelCalls;
    expect(calls).toBeGreaterThan(0);
    expect(result.agent.usage.measured).toBe(true);
    expect(result.agent.usage.promptTokens).toBe(calls * PER_CALL_USAGE.promptTokens);
    expect(result.agent.usage.completionTokens).toBe(calls * PER_CALL_USAGE.completionTokens);
    expect(result.agent.usage.totalTokens).toBe(calls * PER_CALL_USAGE.totalTokens);
    expect(result.agent.usage.costUsd).toBeCloseTo(calls * PER_CALL_USAGE.costUsd, 10);
  });

  it("reports null cost and absent tokens for a deterministic heuristic only run", async () => {
    const value = fixture("heuristic-only");
    const heuristicTask: Omit<AgentTask, "repoRoot" | "tenantId"> = {
      goal: "Repair the API path. The correct endpoint is /v1/charges.",
      errorLog: "HTTP 404 for /v1/chargess, expected /v1/charges",
      maxSteps: 20,
      useLlm: false,
    };

    const result = await runWardenAttempt(input(value, { task: heuristicTask }));

    // The heuristic-only run reaches the agent (baseline target is red) but never
    // calls a model, so cost is null and tokens are absent rather than a measured
    // zero — regardless of whether the heuristic ultimately repairs the source.
    expect(result.agent).toBeDefined();
    expect(result.agent?.modelCalls).toBe(0);
    expect(result.agent?.usage.measured).toBe(false);
    expect(result.agent?.usage.costUsd).toBeNull();
    expect(result.agent?.usage.promptTokens).toBeNull();
    expect(result.agent?.usage.completionTokens).toBeNull();
    expect(result.agent?.usage.totalTokens).toBeNull();
    if (result.status === "succeeded") {
      const evidence = JSON.parse(readFileSync(result.artifacts.evidence, "utf8")) as {
        review: { edits: Array<Record<string, unknown>> };
      };
      expect(evidence.review.edits[0]).toMatchObject({
        risk: "high",
        confidence: 0,
        assessmentSource: "heuristic",
        sourceEvidence: [{ path: "client.js", digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }],
        rollback: "Restore the observed bytes for client.js.",
      });
    }
  });

  it("rejects a verifier-created changed file with no accepted mutation intent", async () => {
    const originalClient = "export const path = '/v1/chargess';\n";
    const value = fixture("verifier-side-effect", originalClient);
    writeFileSync(join(value.sourceRoot, "helper.js"), "original\n", "utf8");
    writeFileSync(join(value.sourceRoot, "check.mjs"), [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8');",
      "if (source.includes('/v1/chargess')) process.exit(1);",
      "writeFileSync(new URL('./helper.js', import.meta.url), 'mutated\\n');",
      "process.exit(0);",
      "",
    ].join("\n"));
    const candidateClient = "export const path = '/v1/charges';\n";
    const sideEffectPlanner: AgentPlanner = async (plannerInput) => {
      const tools = plannerInput.recentSteps.map((step) => step.tool);
      if (!tools.includes("read_file")) {
        return {
          call: { tool: "read_file", args: { path: "client.js" } },
          usage: PER_CALL_USAGE,
        };
      }
      if (!tools.includes("write_file")) {
        const target = (plannerInput.observedEvidenceDigests ?? [])
          .find((item) => item.path === "client.js");
        if (!target) throw new Error("planner did not receive the current client.js digest");
        return {
          call: {
            tool: "write_file",
            args: {
              path: "client.js",
              content: candidateClient,
            },
            intent: {
              schemaVersion: 1,
              hypothesis: "The client path is incorrect.",
              targetPath: "client.js",
              targetSymbol: "path",
              targetDigest: target.digest,
              evidenceRefs: [{ path: target.path, digest: target.digest }],
              precondition: "The observed client exports /v1/chargess.",
              expectedObservation: "The client module can be replaced.",
              postcondition: "The target verifier passes.",
              rollback: "Restore the observed client.js bytes.",
              confidence: 0.9,
              risk: "low",
              stopCondition: "Stop if the target digest changes.",
            },
          },
          usage: PER_CALL_USAGE,
        };
      }
      return {
        call: { tool: "run_command", args: { command: plannerInput.verifyCommand } },
        usage: PER_CALL_USAGE,
      };
    };

    const result = await runWardenAttempt(input(value, {
      task: task(sideEffectPlanner),
      limits: {
        ...LIMITS,
        allowedChangedPaths: Object.freeze(["client.js", "helper.js"]),
      },
    }));

    expect(result).toMatchObject({
      status: "rejected",
      code: "warden_attempt_mutation_intent_missing",
    });
    expect(readFileSync(join(value.sourceRoot, "helper.js"), "utf8")).toBe("original\n");
  });

  it("rejects an in-agent verifier that rewrites an intent-covered path", async () => {
    const value = fixture("verifier-rewrites-intended-path");
    writeFileSync(join(value.sourceRoot, "check.mjs"), [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const url = new URL('./client.js', import.meta.url);",
      "const source = readFileSync(url, 'utf8');",
      "if (source.includes('/v1/chargess')) process.exit(1);",
      "writeFileSync(url, \"export const path = '/v1/malicious';\\n\");",
      "process.exit(0);",
      "",
    ].join("\n"));

    const result = await runWardenAttempt(input(value));

    expect(result).toMatchObject({
      status: "rejected",
      code: "warden_attempt_verifier_mutated_candidate",
    });
  });

  it("fails closed instead of downgrading a critical-risk mutation for review", async () => {
    const value = fixture("critical-risk");

    const result = await runWardenAttempt(input(value, {
      task: task(planner(undefined, "critical")),
    }));

    expect(result).toMatchObject({
      status: "rejected",
      code: "warden_attempt_critical_risk_requires_escalation",
    });
  });

  it("continues an attempt when the immutable source contains an in-tree symbolic link", async () => {
    const value = fixture("symlink-in-tree");
    try {
      symlinkSync(
        join(value.sourceRoot, "client.js"),
        join(value.sourceRoot, "client-link.js"),
        "file",
      );
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return;
      }
      throw error;
    }

    const result = await runWardenAttempt(input(value));

    expect(result.status).toBe("succeeded");
    expect(result.changedPaths).toEqual(["client.js"]);
  });

});

describe("Warden source tree scanner", () => {
  function scanLimits(overrides: Partial<WardenAttemptLimits> = {}): WardenAttemptLimits {
    return { ...LIMITS, ...overrides };
  }

  // A candidate scan (the private workspace after verifiers install deps and
  // emit build output) with nothing tracked to preserve.
  const candidateExclusion = {
    excludeGenerated: EXCLUDED_DIRECTORIES,
    keepDirectories: new Set<string>(),
  } as const;

  it("candidate scan omits generated directories without tripping the cap", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-scan-exclusions-"));
    roots.push(root);
    writeTree(root, {
      "README.md": "# repo\n",
      "src/index.ts": "export const a = 1;\n",
      "src/util.ts": "export const b = 2;\n",
    });
    // A dependency tree far larger than the file cap: excluded, it must be
    // neither read nor counted.
    for (let index = 0; index < 500; index += 1) {
      const target = join(root, "node_modules", "dep", `file-${index}.js`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "module.exports = {};\n");
    }
    for (const excluded of ["dist", ".git", "coverage", ".turbo", ".next"]) {
      mkdirSync(join(root, excluded), { recursive: true });
      writeFileSync(join(root, excluded, "artifact.js"), "x".repeat(1_024));
    }

    const manifest = scanTree(
      root,
      scanLimits({ maxSourceFiles: 40 }),
      "warden_attempt_candidate_symlink",
      candidateExclusion,
    );

    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "README.md",
      "src/index.ts",
      "src/util.ts",
    ]);
    expect(
      manifest.entries.some((entry) =>
        ["node_modules", "dist", ".git", "coverage", ".turbo", ".next"].some((name) =>
          entry.path.split("/").includes(name),
        ),
      ),
    ).toBe(false);
  });

  it("source scan is faithful and does not exclude any directory", () => {
    // The immutable source digest must match the stored snapshot manifest, which
    // covers every tracked file. A committed vendor/ or node_modules/ therefore
    // has to appear in a source scan (no exclusion argument).
    const root = mkdtempSync(join(tmpdir(), "mendpoint-scan-source-faithful-"));
    roots.push(root);
    writeTree(root, {
      "src/index.ts": "export const a = 1;\n",
      "vendor/provider.json": "{}\n",
      "node_modules/dep/index.js": "module.exports = {};\n",
    });

    const manifest = scanTree(root, scanLimits(), "warden_attempt_source_symlink");

    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "node_modules/dep/index.js",
      "src/index.ts",
      "vendor/provider.json",
    ]);
  });

  it("candidate scan keeps a tracked directory but still drops a generated one", () => {
    // vendor/ is committed source (in keepDirectories); node_modules is a
    // verifier-installed artifact that must be skipped.
    const root = mkdtempSync(join(tmpdir(), "mendpoint-scan-tracked-keep-"));
    roots.push(root);
    writeTree(root, {
      "src/index.ts": "export const a = 1;\n",
      "vendor/provider.json": "{}\n",
    });
    for (let index = 0; index < 50; index += 1) {
      const target = join(root, "node_modules", "dep", `file-${index}.js`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "module.exports = {};\n");
    }

    const manifest = scanTree(root, scanLimits(), "warden_attempt_candidate_symlink", {
      excludeGenerated: EXCLUDED_DIRECTORIES,
      keepDirectories: new Set(["vendor"]),
    });

    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "src/index.ts",
      "vendor/provider.json",
    ]);
  });

  it("candidate scan prunes shared dependency dirs (a Python .venv) but keeps tracked vendor/build", () => {
    // Proves the agent consumes the one shared prune list: an untracked .venv
    // (a shared dependency dir) is dropped, while a committed vendor/ and build/
    // survive because keepDirectories carries their tracked prefixes.
    const root = mkdtempSync(join(tmpdir(), "mendpoint-scan-shared-list-"));
    roots.push(root);
    writeTree(root, {
      "src/index.ts": "export const a = 1;\n",
      "vendor/provider.json": "{}\n",
      "build/committed.ts": "export const b = 2;\n",
      ".venv/pyvenv.cfg": "home = /usr/bin\n",
      ".venv/lib/site-packages/dep.py": "def dep():\n    return 1\n",
      "__pycache__/index.cpython-311.pyc": "cache\n",
    });

    const manifest = scanTree(root, scanLimits(), "warden_attempt_candidate_symlink", {
      excludeGenerated: EXCLUDED_DIRECTORIES,
      keepDirectories: new Set(["vendor", "build"]),
    });

    expect(manifest.entries.map((entry) => entry.path)).toEqual([
      "build/committed.ts",
      "src/index.ts",
      "vendor/provider.json",
    ]);
    expect(
      manifest.entries.some((entry) =>
        entry.path.split("/").some((seg) => seg === ".venv" || seg === "__pycache__"),
      ),
    ).toBe(false);
  });

  it("skips and records a symbolic link that stays inside the repo root", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-scan-symlink-in-"));
    roots.push(root);
    writeTree(root, { "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" });
    try {
      symlinkSync(join(root, "a.ts"), join(root, "link.ts"), "file");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return;
      }
      throw error;
    }

    const manifest = scanTree(root, scanLimits(), "warden_attempt_source_symlink");

    expect(manifest.entries.map((entry) => entry.path)).toEqual(["a.ts", "b.ts"]);
    expect(manifest.symlinks).toEqual(["link.ts"]);
  });

  it("refuses a symbolic link whose target escapes the repo root", () => {
    const base = mkdtempSync(join(tmpdir(), "mendpoint-scan-symlink-escape-"));
    roots.push(base);
    const root = join(base, "source");
    writeTree(root, { "a.ts": "export const a = 1;\n" });
    const outside = join(base, "outside.ts");
    writeFileSync(outside, "export const secret = true;\n");
    try {
      symlinkSync(outside, join(root, "escape.ts"), "file");
    } catch (error) {
      if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return;
      }
      throw error;
    }

    expect(() => scanTree(root, scanLimits(), "warden_attempt_source_symlink")).toThrowError(
      /escapes its bound root/,
    );
  });

  it("honours a lowered file cap and lets a large synthetic tree through under raised limits", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-scan-caps-"));
    roots.push(root);
    const sourceDir = join(root, "src");
    mkdirSync(sourceDir, { recursive: true });
    const sourceCount = 5_000;
    for (let index = 0; index < sourceCount; index += 1) {
      writeFileSync(
        join(sourceDir, `mod-${String(index).padStart(5, "0")}.ts`),
        `export const n${index} = ${index};\n`,
      );
    }
    // A dependency tree that would blow any cap if it were not excluded.
    const depDir = join(root, "node_modules", "dep");
    mkdirSync(depDir, { recursive: true });
    for (let index = 0; index < 2_000; index += 1) {
      writeFileSync(join(depDir, `d-${index}.js`), "module.exports = {};\n");
    }

    // Lowered cap: the tracked tree alone exceeds a tiny ceiling.
    expect(() =>
      scanTree(root, scanLimits({ maxSourceFiles: 2 }), "warden_attempt_candidate_symlink", candidateExclusion),
    ).toThrowError(/attempt limit/);

    // Raised ceiling: the same large tree scans cleanly and excludes the deps.
    const manifest = scanTree(
      root,
      scanLimits({
        maxSourceFiles: 100_000,
        maxSourceBytes: 768 * 1024 * 1024,
        maxTreeDepth: 64,
      }),
      "warden_attempt_candidate_symlink",
      candidateExclusion,
    );
    expect(manifest.entries).toHaveLength(sourceCount);
    expect(manifest.entries.every((entry) => entry.path.startsWith("src/"))).toBe(true);
  }, 30_000);
});
