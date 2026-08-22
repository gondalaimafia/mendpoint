/**
 * Warden trajectory persistence (Intelligence Ownership Phases 4 + 7). Evidence
 * that the worker bridge:
 *  - persists a trajectory whose (input -> output) pair is recoverable (blocker #1),
 *  - captures tool calls with args and results (blocker #4),
 *  - redacts every payload (raw secrets never land),
 *  - records a capture failure WITHOUT failing the attempt, and keeps the row so
 *    an empty trajectory is distinguishable from a task that never ran,
 *  - denies cross-tenant reads.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getTrajectory,
  getTrajectoryStepPair,
  listTrajectorySteps,
  type AppDb,
} from "@mendpoint/db";
import type { WardenAttemptCapture } from "@mendpoint/agent";
import { persistWardenTrajectory } from "./warden-trajectory.js";

const T0 = "2026-01-01T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

function fixture(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-warden-trajectory-"));
  const db = createDb(join(dir, "db.sqlite"));
  opened.push({ db, dir });
  db.raw
    .prepare(
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES ('t1','one','One','team','active',10,?), ('t2','two','Two','team','active',10,?)`,
    )
    .run(T0, T0);
  return db;
}

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    try {
      db.raw.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

function capture(overrides: Partial<WardenAttemptCapture> = {}): WardenAttemptCapture {
  return {
    schemaVersion: 1,
    product: "fettler",
    taskKind: "repair",
    taskSummary: "fix the failing endpoint",
    runId: "sess-1",
    availableTools: ["read_file", "write_file", "run_command", "finish"],
    assembledContext: JSON.stringify({ goal: "fix the failing endpoint", observedFiles: ["src/api.ts"] }),
    output: JSON.stringify({ status: "succeeded", changedFiles: [{ path: "src/api.ts", content: "const x = 2;" }] }),
    modelId: "muse-spark-1.2-contributor",
    modelMeasured: true,
    modelProvenance: [
      {
        model: "muse-spark-1.2-contributor",
        providerId: "muse",
        host: "gateway.example",
        protocol: "https:",
        bodyRequestId: "b1",
        headerRequestId: "h1",
        promptTokens: 100,
        completionTokens: 40,
        totalTokens: 140,
        costUsd: 0.0021,
      },
    ],
    toolSteps: [
      {
        stepIndex: 0,
        toolName: "read_file",
        args: JSON.stringify({ path: "src/api.ts" }),
        result: JSON.stringify({ ok: true, summary: "read", data: "const x = 1;" }),
        ok: true,
        error: null,
        failureClass: null,
        plannerSource: "model",
      },
      {
        stepIndex: 1,
        toolName: "write_file",
        args: JSON.stringify({ path: "src/api.ts", content: "const x = 2;" }),
        result: JSON.stringify({ ok: true, summary: "wrote src/api.ts" }),
        ok: true,
        error: null,
        failureClass: null,
        plannerSource: "model",
      },
    ],
    verifications: [
      { verdict: "passed", exitCode: 0, command: "npm test", sandboxBackend: "local" },
    ],
    sandboxBackend: "local",
    finalOutcome: "candidate_ready",
    costUsd: 0.0021,
    costMeasured: true,
    latencyMs: 4200,
    ...overrides,
  };
}

describe("persistWardenTrajectory", () => {
  it("recovers the (input -> output) pair and records tool calls", () => {
    const db = fixture();
    const result = persistWardenTrajectory(db, {
      tenantId: "t1",
      capture: capture(),
      jobId: "job-1",
      createdAt: T0,
      trajectoryId: "traj-1",
    });
    expect(result.ok).toBe(true);

    const trajectory = getTrajectory(db, "t1", "traj-1");
    expect(trajectory?.finalOutcome).toBe("candidate_ready");
    expect(trajectory?.costMeasured).toBe(true);
    expect(trajectory?.availableTools).toContain("write_file");
    expect(trajectory?.provenance.captureStatus).toBe("complete");
    expect(trajectory?.provenance.modelId).toBe("muse-spark-1.2-contributor");

    // Blocker #1: step 0 is the model-mediated pair, recoverable end to end.
    const pair = getTrajectoryStepPair(db, "t1", "traj-1", 0);
    expect(pair?.step.stepKind).toBe("model_call");
    expect(pair?.step.modelId).toBe("muse-spark-1.2-contributor");
    expect(pair?.input?.contentText).toContain("fix the failing endpoint");
    expect(pair?.output?.contentText).toContain("const x = 2;");

    // Blocker #4: the tool calls follow, with args and results.
    const steps = listTrajectorySteps(db, "t1", "traj-1");
    const toolSteps = steps.filter((s) => s.stepKind === "tool_call");
    expect(toolSteps.map((s) => s.toolName)).toEqual(["read_file", "write_file"]);
    const writePair = getTrajectoryStepPair(db, "t1", "traj-1", 2);
    expect(writePair?.step.toolName).toBe("write_file");
    expect(writePair?.input?.contentText).toContain("const x = 2;");
    expect(writePair?.output?.contentText).toContain("wrote src/api.ts");

    // Verification verdict, exit code, command, and sandbox backend all landed.
    const verify = steps.find((s) => s.stepKind === "verification");
    expect(verify?.verification?.verdict).toBe("passed");
    expect(verify?.verification?.exitCode).toBe(0);
    expect(verify?.verification?.command).toBe("npm test");
    expect(verify?.verification?.sandboxBackend).toBe("local");
    expect(verify?.verification?.signalClass).toBe("hard");
  });

  it("redacts secret material before it is stored", () => {
    const db = fixture();
    persistWardenTrajectory(db, {
      tenantId: "t1",
      capture: capture({
        toolSteps: [
          {
            stepIndex: 0,
            toolName: "read_file",
            args: JSON.stringify({ path: ".env" }),
            result: JSON.stringify({ ok: true, data: `AWS_KEY=${AWS_KEY}` }),
            ok: true,
            error: null,
            failureClass: null,
            plannerSource: "model",
          },
        ],
      }),
      jobId: "job-1",
      createdAt: T0,
      trajectoryId: "traj-redact",
    });
    const pair = getTrajectoryStepPair(db, "t1", "traj-redact", 1);
    expect(pair?.step.toolName).toBe("read_file");
    // Redaction ran; the raw secret never reaches storage (redacted or excluded).
    expect(pair?.output?.redactionApplied).toBe(true);
    const stored = pair?.output?.contentText ?? "";
    expect(stored).not.toContain(AWS_KEY);
  });

  it("records a capture failure without failing the attempt, keeping the row", () => {
    const db = fixture();
    // An empty tool name makes the store throw mid-persist, AFTER the trajectory
    // row and the model pair have been written.
    const result = persistWardenTrajectory(db, {
      tenantId: "t1",
      capture: capture({
        toolSteps: [
          {
            stepIndex: 0,
            toolName: "",
            args: "{}",
            result: "{}",
            ok: false,
            error: "boom",
            failureClass: "undetermined",
            plannerSource: "model",
          },
        ],
      }),
      jobId: "job-1",
      createdAt: T0,
      trajectoryId: "traj-fail",
    });
    expect(result.ok).toBe(false);
    // The row exists (task ran) and is explicitly marked as a capture failure,
    // so it is distinguishable from a task that never ran (no row at all).
    const trajectory = getTrajectory(db, "t1", "traj-fail");
    expect(trajectory).toBeDefined();
    expect(trajectory?.provenance.captureStatus).toBe("failed");
    expect(String(trajectory?.provenance.captureError ?? "")).toContain("tool_name");
  });

  it("denies cross-tenant reads", () => {
    const db = fixture();
    persistWardenTrajectory(db, {
      tenantId: "t1",
      capture: capture(),
      jobId: "job-1",
      createdAt: T0,
      trajectoryId: "traj-scope",
    });
    expect(getTrajectory(db, "t1", "traj-scope")).toBeDefined();
    expect(getTrajectory(db, "t2", "traj-scope")).toBeUndefined();
    expect(listTrajectorySteps(db, "t2", "traj-scope")).toHaveLength(0);
  });
});
