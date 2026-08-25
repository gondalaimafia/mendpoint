import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, createMission, insertPrincipal, type AppDb } from "@mendpoint/db";
import { resolveBoundMission } from "./job-bound-mission.js";

const at = "2026-08-25T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-job-bound-mission-"));
  const db = createDb(join(dir, "app.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('t1','one','One','team','active',10,?)`,
  ).run(at);
  insertPrincipal(db, {
    id: "p1",
    tenantId: "t1",
    kind: "human",
    subject: "owner@example.com",
    displayName: "Owner",
    createdAt: at,
  });
  createMission(db, {
    id: "mission-a",
    tenantId: "t1",
    product: "fettler",
    triggerKind: "provider_change",
    objective: "Remediate the payments field rename",
    ownerPrincipalId: "p1",
    eventId: "e-mission-a",
    idempotencyKey: "c-mission-a",
    correlationId: "corr",
    createdAt: at,
  });
  return db;
}

describe("resolveBoundMission", () => {
  it("binds the Mission id when the payload claims a real row", () => {
    const db = fixture();
    expect(resolveBoundMission(db, "t1", "mission-a")).toEqual({
      kind: "bound",
      missionId: "mission-a",
    });
  });

  it("treats an absent or empty claim as an unbound (NULL) run", () => {
    const db = fixture();
    expect(resolveBoundMission(db, "t1", undefined)).toEqual({ kind: "none" });
    expect(resolveBoundMission(db, "t1", "")).toEqual({ kind: "none" });
    expect(resolveBoundMission(db, "t1", "   ")).toEqual({ kind: "none" });
  });

  it("rejects a missing or cross-tenant claim instead of collapsing it to NULL", () => {
    const db = fixture();
    expect(resolveBoundMission(db, "t1", "mission-missing")).toEqual({
      kind: "rejected",
      claimedMissionId: "mission-missing",
    });
    // "mission-a" exists, but for tenant t1 — a t2 claim must not resolve.
    expect(resolveBoundMission(db, "t2", "mission-a")).toEqual({
      kind: "rejected",
      claimedMissionId: "mission-a",
    });
  });
});
