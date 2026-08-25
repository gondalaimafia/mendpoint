import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, createMission, insertPrincipal, type AppDb } from "@mendpoint/db";
import { boundMissionIdFromPayload } from "./job-bound-mission.js";

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

describe("boundMissionIdFromPayload", () => {
  it("returns the Mission id when the payload claims a real row", () => {
    const db = fixture();
    expect(boundMissionIdFromPayload(db, "t1", "mission-a")).toBe("mission-a");
  });

  it("omits the id when the payload is unbound or the row is missing", () => {
    const db = fixture();
    expect(boundMissionIdFromPayload(db, "t1", undefined)).toBeUndefined();
    expect(boundMissionIdFromPayload(db, "t1", "")).toBeUndefined();
    expect(boundMissionIdFromPayload(db, "t1", "mission-missing")).toBeUndefined();
    expect(boundMissionIdFromPayload(db, "t2", "mission-a")).toBeUndefined();
  });
});
