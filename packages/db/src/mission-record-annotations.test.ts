import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  insertArtifactManifest,
  insertPrincipal,
  raiseMissionException,
  recordMissionDecision,
  registerMissionArtifact,
  type AppDb,
} from "./index.js";

const T0 = "2026-01-01T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-ann-"));
  const db = createDb(join(dir, "a.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1','one','One','team','active',10,?)`).run(T0);
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com", displayName: "One", createdAt: T0 });
  createMission(db, { id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
    objective: "Migrate", ownerPrincipalId: "p1", eventId: "ev-m1", idempotencyKey: "cm-m1",
    correlationId: "corr", createdAt: T0 });
  return db;
}

describe("§8.19–8.21 annotation columns", () => {
  it("stores decision_type without changing the content digest", () => {
    const db = fixture();
    const unlabeled = recordMissionDecision(db, {
      tenantId: "t1", missionId: "m1", decision: "use a shim", scope: "phase-1",
      authorPrincipalId: "p1", correlationId: "corr", createdAt: T0,
    });
    expect(unlabeled.decisionType).toBeNull();
    const labeled = recordMissionDecision(db, {
      tenantId: "t1", missionId: "m1", decision: "keep generated SDK frozen", scope: "sdk",
      authorPrincipalId: "p1", correlationId: "corr", createdAt: T0, decisionType: "migration",
    });
    expect(labeled.decisionType).toBe("migration");
    expect(labeled.id).toBe(labeled.contentDigest);
    const replay = recordMissionDecision(db, {
      tenantId: "t1", missionId: "m1", decision: "keep generated SDK frozen", scope: "sdk",
      authorPrincipalId: "p1", correlationId: "corr", createdAt: T0, decisionType: "architecture",
    });
    expect(replay.id).toBe(labeled.id);
    expect(replay.decisionType).toBe("migration");
    expect(() => recordMissionDecision(db, {
      tenantId: "t1", missionId: "m1", decision: "no", scope: "x",
      authorPrincipalId: "p1", correlationId: "corr", createdAt: T0, decisionType: "not-a-type",
    })).toThrow("mission_decision_type_invalid");
  });

  it("stores exception task_id and category without changing the digest", () => {
    const db = fixture();
    const raised = raiseMissionException(db, {
      tenantId: "t1", missionId: "m1", reason: "graph incomplete for payments",
      impact: "cannot plan edits", ownerPrincipalId: "p1",
      resolutionPath: "await_human_resolution", blocking: true,
      correlationId: "corr", createdAt: T0,
      taskId: "task-1", category: "graph_incomplete",
    });
    expect(raised.taskId).toBe("task-1");
    expect(raised.category).toBe("graph_incomplete");
    expect(raised.id).toBe(raised.contentDigest);
    const replay = raiseMissionException(db, {
      tenantId: "t1", missionId: "m1", reason: "graph incomplete for payments",
      impact: "cannot plan edits", ownerPrincipalId: "p1",
      resolutionPath: "await_human_resolution", blocking: true,
      correlationId: "corr", createdAt: T0,
    });
    expect(replay.id).toBe(raised.id);
    expect(replay.taskId).toBe("task-1");
  });

  it("stores artifact task_id and source_snapshot without changing the digest", () => {
    const db = fixture();
    const content = "impact body";
    const sha256 = createHash("sha256").update(content).digest("hex");
    insertArtifactManifest(db, {
      id: "art-1", tenantId: "t1", kind: "impact-report", schemaVersion: 1, sha256,
      mediaType: "text/plain", sizeBytes: Buffer.byteLength(content), storageRef: "mem://art-1",
      content, createdAt: T0,
    });
    const registered = registerMissionArtifact(db, {
      tenantId: "t1", missionId: "m1", role: "impact_report", artifactId: "art-1",
      label: "impact", producerPrincipalId: "p1", correlationId: "corr", createdAt: T0,
      taskId: "task-1", sourceSnapshot: "snapshot-a",
    });
    expect(registered.taskId).toBe("task-1");
    expect(registered.sourceSnapshot).toBe("snapshot-a");
    const replay = registerMissionArtifact(db, {
      tenantId: "t1", missionId: "m1", role: "impact_report", artifactId: "art-1",
      label: "impact", producerPrincipalId: "p1", correlationId: "corr", createdAt: T0,
    });
    expect(replay.id).toBe(registered.id);
    expect(replay.taskId).toBe("task-1");
  });

  it("converges annotation columns on an aged volume via ADD COLUMN", () => {
    const additiveColumns = [
      ["mission_decisions", "decision_type"],
      ["mission_exceptions", "task_id"],
      ["mission_exceptions", "category"],
      ["mission_artifacts", "task_id"],
      ["mission_artifacts", "source_snapshot"],
    ] as const;
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-ann-upgrade-"));
    const path = join(dir, "aged.sqlite");

    // Seed a current-schema volume, then strip the annotation columns to emulate a
    // database created before §8.19–8.21 shipped. Using the real DROP COLUMN path
    // (not a fresh createDb) is what makes this exercise the ADD COLUMN upgrade.
    const seeded = createDb(path);
    seeded.raw.close();
    const legacy = new DatabaseSync(path);
    for (const [table, column] of additiveColumns) {
      legacy.exec(`ALTER TABLE ${table} DROP COLUMN ${column};`);
    }
    for (const [table, column] of additiveColumns) {
      const names = (legacy.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((row) => row.name);
      expect(names).not.toContain(column);
    }
    legacy.close();

    // Reopening runs ensureTables, whose additive path must ADD COLUMN each
    // annotation back onto the aged volume.
    const migrated = createDb(path);
    opened.push({ db: migrated, dir });
    for (const [table, column] of additiveColumns) {
      const names = (migrated.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((row) => row.name);
      expect(names).toContain(column);
    }
  });
});
