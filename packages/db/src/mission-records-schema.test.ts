import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  getActiveMissionDecisions,
  insertPrincipal,
  recordMissionDecision,
  type AppDb,
} from "./index.js";

const T0 = "2026-01-01T00:00:00.000Z";
const dirs: string[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.raw.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tableNames(db: AppDb): string[] {
  return (db.raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
    .map((r) => r.name);
}

const NEW_TABLES = ["mission_decisions", "mission_exceptions", "mission_verifications"];

describe("mission durable-records schema convergence", () => {
  // CONTROL: the three tables must appear in the static DDL so a PRE-CHANGE
  // database volume (one created before this change, therefore lacking them)
  // converges on boot purely through CREATE TABLE IF NOT EXISTS — with no ALTER
  // and no disturbance to existing rows. A green fresh-install proves nothing
  // about upgrades; this simulates the upgrade path.
  it("recreates the new tables on boot against a pre-change volume, preserving existing data", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-mrsc-"));
    dirs.push(dir);
    const path = join(dir, "vol.sqlite");

    // Boot once, seed a mission and a decision.
    const first = createDb(path);
    first.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
      VALUES ('t1','one','One','team','active',10,?)`).run(T0);
    insertPrincipal(first, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com", displayName: "One", createdAt: T0 });
    createMission(first, { id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
      objective: "Migrate off v1", ownerPrincipalId: "p1", eventId: "ev-m1", idempotencyKey: "cm-m1", correlationId: "corr", createdAt: T0 });
    recordMissionDecision(first, { tenantId: "t1", missionId: "m1", decision: "keep the shim", scope: "phase-1",
      authorPrincipalId: "p1", correlationId: "corr", createdAt: T0 });

    // Simulate a PRE-CHANGE volume: drop the three new tables (and their
    // triggers/indexes fall with them) while leaving the mission row intact, as
    // if this volume had been created by code that never defined them.
    for (const table of NEW_TABLES) first.raw.exec(`DROP TABLE ${table}`);
    expect(tableNames(first)).toEqual(expect.not.arrayContaining(NEW_TABLES));
    expect(first.raw.prepare(`SELECT id FROM mission WHERE id = 'm1'`).get()).toBeTruthy();
    first.raw.close();

    // Re-open (boot the current code against that pre-change volume).
    const second = createDb(path);
    dbs.push(second);
    // The three tables converge back purely through the static DDL...
    expect(tableNames(second)).toEqual(expect.arrayContaining(NEW_TABLES));
    // ...the pre-existing mission row is untouched...
    expect(second.raw.prepare(`SELECT objective FROM mission WHERE id = 'm1'`).get()).toMatchObject({ objective: "Migrate off v1" });
    // ...and the store is immediately usable again.
    const d = recordMissionDecision(second, { tenantId: "t1", missionId: "m1", decision: "advance to phase 2", scope: "phase-2",
      authorPrincipalId: "p1", correlationId: "corr", createdAt: "2026-01-05T00:00:00.000Z" });
    expect(getActiveMissionDecisions(second, "t1", "m1").map((x) => x.id)).toContain(d.id);
  });

  it("boots idempotently: opening the same volume twice does not error", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-mrsc2-"));
    dirs.push(dir);
    const path = join(dir, "vol.sqlite");
    const a = createDb(path);
    a.raw.close();
    const b = createDb(path);
    dbs.push(b);
    expect(tableNames(b)).toEqual(expect.arrayContaining(NEW_TABLES));
  });
});
