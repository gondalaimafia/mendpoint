import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  insertArtifactManifest,
  insertPrincipal,
  linkRegaugeCampaignToMission,
  listMissionArtifacts,
  type AppDb,
} from "@mendpoint/db";
import { registerRegaugeCompleteAttemptArtifacts } from "./transformer-pilot-lane.js";

const T0 = "2026-01-01T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    try { db.raw.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-rg-art-"));
  const db = createDb(join(dir, "r.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('t1','one','One','team','active',10,?)`,
  ).run(T0);
  insertPrincipal(db, {
    id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com",
    displayName: "One", createdAt: T0,
  });
  return db;
}

function manifest(db: AppDb, id: string) {
  const content = "candidate";
  insertArtifactManifest(db, {
    id, tenantId: "t1", kind: "transformer-candidate", schemaVersion: 1,
    sha256: createHash("sha256").update(content).digest("hex"),
    mediaType: "text/plain", sizeBytes: Buffer.byteLength(content, "utf8"),
    storageRef: `mem://${id}`, content, createdAt: T0,
  });
}

describe("registerRegaugeCompleteAttemptArtifacts", () => {
  it("skips when evidence refs are not artifact_manifests rows", () => {
    const db = fixture();
    createMission(db, {
      id: "m-rg", tenantId: "t1", product: "regauge", triggerKind: "migration_objective",
      objective: "Modernize", ownerPrincipalId: "p1", eventId: "ev-rg",
      idempotencyKey: "cm-rg", correlationId: "corr-rg", createdAt: T0,
    });
    linkRegaugeCampaignToMission(db, {
      tenantId: "t1", missionId: "m-rg", regaugeCampaignId: "tf-1",
      actorPrincipalId: "p1", eventId: "linked-rg", idempotencyKey: "linked-rg",
      correlationId: "corr-rg", createdAt: T0,
    });
    const result = registerRegaugeCompleteAttemptArtifacts(db, {
      tenantId: "t1", campaignId: "tf-1", unitId: "unit-1",
      evidenceRefs: ["evidence-not-a-manifest"], createdAt: T0, producerPrincipalId: "p1",
    });
    expect(result).toEqual({ status: "skipped_no_artifacts" });
    expect(listMissionArtifacts(db, "t1", "m-rg")).toHaveLength(0);
  });

  it("registers existing manifests on a bound ReGauge Mission", () => {
    const db = fixture();
    createMission(db, {
      id: "m-rg", tenantId: "t1", product: "regauge", triggerKind: "migration_objective",
      objective: "Modernize", ownerPrincipalId: "p1", eventId: "ev-rg",
      idempotencyKey: "cm-rg", correlationId: "corr-rg", createdAt: T0,
    });
    linkRegaugeCampaignToMission(db, {
      tenantId: "t1", missionId: "m-rg", regaugeCampaignId: "tf-1",
      actorPrincipalId: "p1", eventId: "linked-rg", idempotencyKey: "linked-rg",
      correlationId: "corr-rg", createdAt: T0,
    });
    manifest(db, "art-rg");
    const result = registerRegaugeCompleteAttemptArtifacts(db, {
      tenantId: "t1", campaignId: "tf-1", unitId: "unit-1",
      evidenceRefs: ["art-rg", "evidence-not-a-manifest"],
      createdAt: T0, sourceSnapshot: "snap-1", producerPrincipalId: "p1",
    });
    expect(result).toEqual({ status: "registered", missionId: "m-rg", count: 1 });
    expect(listMissionArtifacts(db, "t1", "m-rg")).toEqual([
      expect.objectContaining({ artifactId: "art-rg", role: "candidate_patch", sourceSnapshot: "snap-1" }),
    ]);
  });
});
