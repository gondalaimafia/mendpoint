/**
 * Trajectory capture (Intelligence Ownership Phases 4 + 7). Evidence that:
 *  - a trajectory round-trips with its (input -> output) pair recoverable (blocker #1),
 *  - redaction is applied and fails closed (raw secrets never land),
 *  - tool calls are captured (blocker #4),
 *  - the new tables converge from a PRE-CHANGE schema (not just a fresh install),
 *  - cross-tenant reads are denied.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  finalizeTrajectory,
  getTrajectory,
  getTrajectoryByRun,
  getTrajectoryStepPair,
  insertPrincipal,
  listTrajectories,
  listTrajectorySteps,
  putTrajectoryBlob,
  readTrajectoryBlob,
  recordModelCall,
  recordToolCall,
  recordTrajectory,
  recordVerificationStep,
  type AppDb,
} from "./index.js";

const opened: Array<{ db: AppDb; dir: string }> = [];
const T0 = "2026-01-01T00:00:00.000Z";

function seedTenants(db: AppDb) {
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1', 'one', 'One', 'team', 'active', 10, ?),
           ('t2', 'two', 'Two', 'team', 'active', 10, ?)`).run(T0, T0);
}

function fixture(): { db: AppDb; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-trajectory-"));
  const path = join(dir, "trajectory.sqlite");
  const db = createDb(path);
  opened.push({ db, dir });
  seedTenants(db);
  return { db, path };
}

function tableExists(db: AppDb, name: string): boolean {
  return Boolean(
    db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name),
  );
}

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    try {
      db.raw.close();
    } catch {
      /* already closed by the test */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function openTrajectory(db: AppDb, overrides: Partial<Parameters<typeof recordTrajectory>[1]> = {}) {
  return recordTrajectory(db, {
    id: "traj-1",
    tenantId: "t1",
    product: "fettler",
    taskKind: "warden.repair",
    taskSummary: "Migrate consumers off the removed charges.create overload",
    availableTools: ["list_dir", "read_file", "search", "write_file", "run_command", "finish"],
    createdAt: T0,
    ...overrides,
  });
}

describe("trajectory capture", () => {
  it("round-trips a trajectory with its (input -> output) pair recoverable", () => {
    const { db } = fixture();
    openTrajectory(db);

    const prompt = "system: you are Warden\nuser: fix charges.create in src/pay.ts";
    const completion = JSON.stringify({ tool: "read_file", args: { path: "src/pay.ts" } });
    const modelStep = recordModelCall(db, {
      id: "step-0",
      tenantId: "t1",
      trajectoryId: "traj-1",
      stepIndex: 0,
      input: prompt,
      output: completion,
      modelId: "gpt-4o-mini-2024-07-18",
      reservationRef: "resv-1",
      routerDecisionRef: "ledger-1",
      plannerSource: "model",
      createdAt: T0,
    });
    expect(modelStep.stepKind).toBe("model_call");
    // model_id records what the call ACTUALLY used (provider echo), not a hardcoded name.
    expect(modelStep.modelId).toBe("gpt-4o-mini-2024-07-18");
    // Cross-boundary references are by id only.
    expect(modelStep.routerDecisionRef).toBe("ledger-1");
    expect(modelStep.reservationRef).toBe("resv-1");

    const pair = getTrajectoryStepPair(db, "t1", "traj-1", 0);
    expect(pair?.input?.contentText).toBe(prompt);
    expect(pair?.output?.contentText).toBe(completion);
    // The stored address is the digest of the ORIGINAL bytes (joinable to other digests).
    expect(pair?.step.inputBlobSha256).toHaveLength(64);
    expect(pair?.step.outputBlobSha256).toHaveLength(64);

    const trajectory = getTrajectory(db, "t1", "traj-1");
    expect(trajectory?.taskKind).toBe("warden.repair");
    expect(trajectory?.availableTools).toContain("run_command");
  });

  it("applies redaction to a persisted pair and never stores the raw secret", () => {
    const { db } = fixture();
    openTrajectory(db);
    const secret = "ghp_" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78";
    const prompt = `context file src/config.ts:\nconst token = "${secret}";`;
    recordModelCall(db, {
      id: "step-0",
      tenantId: "t1",
      trajectoryId: "traj-1",
      stepIndex: 0,
      input: prompt,
      output: "ok",
      createdAt: T0,
    });
    const pair = getTrajectoryStepPair(db, "t1", "traj-1", 0);
    expect(pair?.input?.redactionApplied).toBe(true);
    expect(pair?.input?.contentText).not.toContain(secret);
    // Redaction fired (the secret-assignment rule wins over the token rule here);
    // what matters is a marker is present and no fragment of the secret survives.
    expect(pair?.input?.contentText).toContain("[REDACTED_");
  });

  it("fails closed: an ambiguous high-entropy payload is excluded, not partially exposed", () => {
    const { db } = fixture();
    openTrajectory(db);
    const opaque = "aB3dE6fG9hJ2kL5mN8pQ1rS4tV7wX0yZ".repeat(2);
    const ref = putTrajectoryBlob(db, {
      tenantId: "t1",
      content: `const opaque = "${opaque}";`,
      createdAt: T0,
    });
    expect(ref.redactionExcluded).toBe(true);
    expect(ref.redactionReason).toBe("ambiguous_high_entropy_token");
    const blob = readTrajectoryBlob(db, "t1", ref.contentSha256);
    // Fail-closed: no content survives, only the digest and the reason.
    expect(blob?.contentText).toBeNull();
    expect(blob?.contentText ?? "").not.toContain(opaque);
    expect(ref.contentSha256).toHaveLength(64);
  });

  it("captures tool calls with their arguments and results", () => {
    const { db } = fixture();
    openTrajectory(db);
    const toolStep = recordToolCall(db, {
      id: "step-1",
      tenantId: "t1",
      trajectoryId: "traj-1",
      stepIndex: 1,
      toolName: "read_file",
      args: JSON.stringify({ path: "src/pay.ts", offset: 0 }),
      result: JSON.stringify({ ok: true, summary: "read 42 lines" }),
      ok: true,
      latencyMs: 12,
      startedAt: T0,
      endedAt: "2026-01-01T00:00:00.012Z",
      createdAt: T0,
    });
    expect(toolStep.stepKind).toBe("tool_call");
    expect(toolStep.toolName).toBe("read_file");
    expect(toolStep.latencyMs).toBe(12);

    const pair = getTrajectoryStepPair(db, "t1", "traj-1", 1);
    expect(JSON.parse(pair!.input!.contentText!)).toEqual({ path: "src/pay.ts", offset: 0 });
    expect(JSON.parse(pair!.output!.contentText!)).toEqual({ ok: true, summary: "read 42 lines" });

    const steps = listTrajectorySteps(db, "t1", "traj-1");
    expect(steps.map((s) => s.toolName)).toContain("read_file");
  });

  it("captures a verification step with exit code, sandbox backend, and signal class", () => {
    const { db } = fixture();
    openTrajectory(db);
    const step = recordVerificationStep(db, {
      id: "step-2",
      tenantId: "t1",
      trajectoryId: "traj-1",
      stepIndex: 2,
      verification: {
        verifierId: "warden-verifier",
        verifierModelId: null,
        verdict: "failed",
        signalClass: "hard",
        exitCode: 1,
        command: "npm test",
        sandboxBackend: "fly_machines",
        confidence: null,
        rationaleRef: null,
        latencyMs: 4210,
        costUsd: null,
      },
      ok: false,
      createdAt: T0,
    });
    expect(step.verification?.exitCode).toBe(1);
    expect(step.verification?.sandboxBackend).toBe("fly_machines");
    expect(step.verification?.signalClass).toBe("hard");
  });

  it("finalizes terminal fields and links to a mission", () => {
    const { db } = fixture();
    insertPrincipal(db, {
      id: "p1",
      tenantId: "t1",
      kind: "human",
      subject: "one@example.com",
      displayName: "One",
      createdAt: T0,
    });
    const mission = createMission(db, {
      id: "m-1",
      tenantId: "t1",
      product: "fettler",
      triggerKind: "provider_change",
      objective: "Migrate off v1",
      ownerPrincipalId: "p1",
      eventId: "e-m1",
      idempotencyKey: "m1",
      correlationId: "corr",
      createdAt: T0,
    });
    openTrajectory(db, { missionId: mission.id });
    const finalized = finalizeTrajectory(db, {
      tenantId: "t1",
      trajectoryId: "traj-1",
      finalOutcome: "verify_passed",
      accepted: "accepted",
      sandboxBackend: "local",
      costUsd: 0.0123,
      costMeasured: true,
      latencyMs: 8123,
    });
    expect(finalized.finalOutcome).toBe("verify_passed");
    expect(finalized.accepted).toBe("accepted");
    expect(finalized.costMeasured).toBe(true);
    expect(finalized.missionId).toBe("m-1");
    expect(listTrajectories(db, "t1", { missionId: "m-1" }).map((t) => t.id)).toContain("traj-1");
  });

  it("deduplicates identical content by digest across steps", () => {
    const { db } = fixture();
    openTrajectory(db);
    const content = "identical evidence packet";
    const a = putTrajectoryBlob(db, { tenantId: "t1", content, createdAt: T0 });
    const b = putTrajectoryBlob(db, { tenantId: "t1", content, createdAt: "2026-02-02T00:00:00.000Z" });
    expect(a.contentSha256).toBe(b.contentSha256);
    const count = db.raw
      .prepare(`SELECT COUNT(*) AS n FROM trajectory_blobs WHERE tenant_id = 't1'`)
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it("rejects a conflicting redefinition of the same trajectory id", () => {
    const { db } = fixture();
    openTrajectory(db);
    expect(openTrajectory(db)).toBeDefined(); // idempotent re-open
    expect(() => openTrajectory(db, { product: "regauge" })).toThrow("trajectory_id_conflict");
  });

  it("denies cross-tenant reads and writes", () => {
    const { db } = fixture();
    openTrajectory(db); // tenant t1
    recordModelCall(db, {
      id: "s0",
      tenantId: "t1",
      trajectoryId: "traj-1",
      stepIndex: 0,
      input: "secret-ish context",
      output: "out",
      createdAt: T0,
    });
    // t2 cannot read t1's trajectory, steps, or blobs.
    expect(getTrajectory(db, "t2", "traj-1")).toBeUndefined();
    expect(listTrajectorySteps(db, "t2", "traj-1")).toHaveLength(0);
    expect(getTrajectoryStepPair(db, "t2", "traj-1", 0)).toBeUndefined();
    const t1step = getTrajectoryStepPair(db, "t1", "traj-1", 0)!;
    expect(readTrajectoryBlob(db, "t2", t1step.step.inputBlobSha256!)).toBeUndefined();
    // t2 cannot append a step to t1's trajectory (scope check throws).
    expect(() =>
      recordToolCall(db, {
        id: "x",
        tenantId: "t2",
        trajectoryId: "traj-1",
        stepIndex: 1,
        toolName: "read_file",
        args: "{}",
        result: "{}",
        createdAt: T0,
      }),
    ).toThrow("trajectory_not_found");
    // t2 cannot finalize t1's trajectory.
    expect(() =>
      finalizeTrajectory(db, { tenantId: "t2", trajectoryId: "traj-1", finalOutcome: "x" }),
    ).toThrow("trajectory_not_found");
  });

  it("resolves a trajectory by run id, tenant-scoped, distinct from a missing run", () => {
    const { db } = fixture();
    openTrajectory(db, { runId: "run-1" }); // tenant t1, run-1

    const resolved = getTrajectoryByRun(db, "t1", "run-1");
    expect(resolved?.id).toBe("traj-1");
    expect(resolved?.runId).toBe("run-1");

    // A run with no trajectory resolves to undefined — the caller reads this as
    // "not recorded", never as "nothing was supplied".
    expect(getTrajectoryByRun(db, "t1", "run-unknown")).toBeUndefined();

    // Tenant scoping: t2 cannot resolve t1's run even by the same run id. Seed a
    // t2 trajectory under the SAME run id to prove the scope, not the id, isolates.
    recordTrajectory(db, {
      id: "traj-2",
      tenantId: "t2",
      product: "fettler",
      taskKind: "warden.repair",
      taskSummary: "another tenant, same run id",
      runId: "run-1",
      createdAt: T0,
    });
    expect(getTrajectoryByRun(db, "t2", "run-1")?.id).toBe("traj-2");
    // t1 still resolves only its own row, never t2's.
    expect(getTrajectoryByRun(db, "t1", "run-1")?.id).toBe("traj-1");
  });

  it("rejects linking a mission owned by another tenant", () => {
    const { db } = fixture();
    // No mission m-x exists for t1; the FK/scope check must reject it.
    expect(() => openTrajectory(db, { missionId: "m-x" })).toThrow(
      "trajectory_mission_tenant_mismatch",
    );
  });

  it("converges the new tables from a PRE-CHANGE schema, preserving existing data", () => {
    // A database created BEFORE this change has no trajectory_* tables. Simulate that
    // predecessor by dropping them, then prove that reopening (which re-execs the
    // idempotent DDL) recreates them without disturbing pre-existing rows.
    const { db, path } = fixture();
    // Baseline data that must survive the upgrade (createDb seeds a system tenant, so
    // the exact count is not hardcoded; what matters is it is unchanged after upgrade).
    const before = db.raw.prepare(`SELECT COUNT(*) AS n FROM tenants`).get() as { n: number };
    expect(before.n).toBeGreaterThanOrEqual(2);

    db.raw.exec("PRAGMA foreign_keys = OFF");
    db.raw.exec("DROP TABLE IF EXISTS trajectory_steps");
    db.raw.exec("DROP TABLE IF EXISTS trajectories");
    db.raw.exec("DROP TABLE IF EXISTS trajectory_blobs");
    expect(tableExists(db, "trajectories")).toBe(false);
    expect(tableExists(db, "trajectory_blobs")).toBe(false);
    expect(tableExists(db, "trajectory_steps")).toBe(false);
    db.raw.close();

    // Reopen the SAME file: this is the real upgrade path (createDb re-execs the DDL).
    const upgraded = createDb(path);
    // Hand the live handle to the existing cleanup entry (the original db is already
    // closed above); avoids a duplicate dir removal that races the open WAL on Windows.
    opened[opened.length - 1].db = upgraded;
    expect(tableExists(upgraded, "trajectories")).toBe(true);
    expect(tableExists(upgraded, "trajectory_blobs")).toBe(true);
    expect(tableExists(upgraded, "trajectory_steps")).toBe(true);
    // Pre-existing rows survived the upgrade unchanged.
    const after = upgraded.raw.prepare(`SELECT COUNT(*) AS n FROM tenants`).get() as { n: number };
    expect(after.n).toBe(before.n);
    // Capture works against the converged schema.
    const trajectory = recordTrajectory(upgraded, {
      id: "post-upgrade",
      tenantId: "t1",
      product: "regauge",
      taskKind: "transformer.repair",
      taskSummary: "runtime upgrade",
      createdAt: T0,
    });
    expect(trajectory.id).toBe("post-upgrade");
    recordToolCall(upgraded, {
      id: "s0",
      tenantId: "t1",
      trajectoryId: "post-upgrade",
      stepIndex: 0,
      toolName: "list_dir",
      args: "{}",
      result: "{}",
      createdAt: T0,
    });
    expect(listTrajectorySteps(upgraded, "t1", "post-upgrade")).toHaveLength(1);
  });

  it("persists a tool step's failure class and reads null on success", () => {
    const { db } = fixture();
    openTrajectory(db);
    recordToolCall(db, {
      id: "fail-step",
      tenantId: "t1",
      trajectoryId: "traj-1",
      stepIndex: 1,
      toolName: "run_command",
      args: JSON.stringify({ command: "node check.mjs" }),
      result: JSON.stringify({ ok: false, summary: "exit 1", failureClass: "target_failure" }),
      ok: false,
      error: "verification failed",
      failureClass: "target_failure",
      createdAt: T0,
    });
    recordToolCall(db, {
      id: "ok-step",
      tenantId: "t1",
      trajectoryId: "traj-1",
      stepIndex: 2,
      toolName: "read_file",
      args: JSON.stringify({ path: "src/pay.ts" }),
      result: JSON.stringify({ ok: true, summary: "read 42 lines" }),
      ok: true,
      createdAt: T0,
    });

    const steps = listTrajectorySteps(db, "t1", "traj-1");
    const failed = steps.find((s) => s.id === "fail-step");
    const succeeded = steps.find((s) => s.id === "ok-step");
    expect(failed!.failureClass).toBe("target_failure");
    // Null on success: a successful step must never read as a fabricated class,
    // and null is distinguishable from any of the recorded failure worlds.
    expect(succeeded!.failureClass).toBeNull();
  });

  it("converges failure_class from a PRE-CHANGE volume that has the table but not the column", () => {
    // A database created BEFORE this change has trajectory_steps WITHOUT
    // failure_class. Simulate that predecessor in place (drop just the column,
    // keeping the table and its rows), then prove reopening adds it back via the
    // additive migration and a failure class round-trips against the converged
    // shape. This is the additive-column path, distinct from a full table drop.
    const { db, path } = fixture();
    openTrajectory(db);
    recordToolCall(db, {
      id: "legacy-step",
      tenantId: "t1",
      trajectoryId: "traj-1",
      stepIndex: 0,
      toolName: "list_dir",
      args: "{}",
      result: "{}",
      ok: true,
      createdAt: T0,
    });

    db.raw.exec("ALTER TABLE trajectory_steps DROP COLUMN failure_class");
    const columnsBefore = db.raw
      .prepare(`PRAGMA table_info(trajectory_steps)`)
      .all() as Array<{ name: string }>;
    expect(columnsBefore.some((c) => c.name === "failure_class")).toBe(false);
    db.raw.close();

    // Reopen the SAME file: createDb re-runs the additive migration.
    const upgraded = createDb(path);
    opened[opened.length - 1].db = upgraded;
    const columnsAfter = upgraded.raw
      .prepare(`PRAGMA table_info(trajectory_steps)`)
      .all() as Array<{ name: string }>;
    expect(columnsAfter.some((c) => c.name === "failure_class")).toBe(true);
    // The pre-change row survived and reads null (no failure class recorded).
    const legacy = listTrajectorySteps(upgraded, "t1", "traj-1").find(
      (s) => s.id === "legacy-step",
    );
    expect(legacy!.failureClass).toBeNull();
    // A new failure class writes and reads back against the converged schema.
    recordToolCall(upgraded, {
      id: "post-upgrade-step",
      tenantId: "t1",
      trajectoryId: "traj-1",
      stepIndex: 1,
      toolName: "run_command",
      args: "{}",
      result: JSON.stringify({ ok: false, failureClass: "infra_failure" }),
      ok: false,
      failureClass: "infra_failure",
      createdAt: T0,
    });
    const upgradedStep = listTrajectorySteps(upgraded, "t1", "traj-1").find(
      (s) => s.id === "post-upgrade-step",
    );
    expect(upgradedStep!.failureClass).toBe("infra_failure");
  });
});
