/**
 * Best-effort Mission artifact registration against already-persisted
 * artifact_manifests. Registration is metadata: unbound Missions skip, missing
 * Missions skip, and store faults never throw to the producing job.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  createWardenCampaign,
  insertArtifactManifest,
  insertPrincipal,
  linkFettlerCampaignToMission,
  listMissionArtifactLineage,
  listMissionArtifacts,
  type AppDb,
} from "@mendpoint/db";
import {
  tryRegisterBoundMissionArtifacts,
  tryRegisterFettlerCampaignMissionArtifacts,
} from "./mission-artifact-register.js";

const T0 = "2026-01-01T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

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

function fixture(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-mission-art-reg-"));
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
  createMission(db, {
    id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
    objective: "Migrate off v1", ownerPrincipalId: "p1", eventId: "ev-m1",
    idempotencyKey: "cm-m1", correlationId: "corr", createdAt: T0,
  });
  return db;
}

function manifest(db: AppDb, id: string, kind: string, content: string) {
  const sha256 = createHash("sha256").update(content).digest("hex");
  insertArtifactManifest(db, {
    id, tenantId: "t1", kind, schemaVersion: 1, sha256, mediaType: "text/plain",
    sizeBytes: Buffer.byteLength(content, "utf8"), storageRef: `mem://${id}`, content, createdAt: T0,
  });
}

describe("tryRegisterBoundMissionArtifacts", () => {
  it("skips when no mission is bound", () => {
    const db = fixture();
    manifest(db, "art-patch", "candidate-edit", "patch");
    const result = tryRegisterBoundMissionArtifacts(db, {
      tenantId: "t1",
      missionId: null,
      producerPrincipalId: "p1",
      correlationId: "corr",
      createdAt: T0,
      artifacts: [{ role: "candidate_patch", artifactId: "art-patch", label: "patch" }],
    });
    expect(result).toEqual({ status: "skipped_unbound" });
    expect(listMissionArtifacts(db, "t1", "m1")).toHaveLength(0);
  });

  it("skips (does not throw) when a claimed mission id does not resolve", () => {
    const db = fixture();
    manifest(db, "art-patch", "candidate-edit", "patch");
    const result = tryRegisterBoundMissionArtifacts(db, {
      tenantId: "t1",
      missionId: "mission-does-not-exist",
      producerPrincipalId: "p1",
      correlationId: "corr",
      createdAt: T0,
      artifacts: [{ role: "candidate_patch", artifactId: "art-patch", label: "patch" }],
    });
    expect(result).toEqual({ status: "skipped_mission_not_found", missionId: "mission-does-not-exist" });
    expect(listMissionArtifacts(db, "t1", "m1")).toHaveLength(0);
  });

  it("registers referenced manifests and lineage on a bound Mission", () => {
    const db = fixture();
    manifest(db, "art-patch", "candidate-edit", "patch");
    manifest(db, "art-pr", "structured-pr-package", "pr");
    const result = tryRegisterBoundMissionArtifacts(db, {
      tenantId: "t1",
      missionId: "m1",
      producerPrincipalId: "p1",
      correlationId: "corr",
      createdAt: T0,
      sourceSnapshot: "snap-1",
      artifacts: [
        { role: "candidate_patch", artifactId: "art-patch", label: "patch" },
        { role: "pull_request", artifactId: "art-pr", label: "pr", parentArtifactId: "art-patch" },
      ],
    });
    expect(result).toEqual({ status: "registered", missionId: "m1", count: 2 });
    const registered = listMissionArtifacts(db, "t1", "m1");
    expect(registered.map((row) => row.role).sort()).toEqual(["candidate_patch", "pull_request"]);
    expect(registered.every((row) => row.sourceSnapshot === "snap-1")).toBe(true);
    expect(listMissionArtifactLineage(db, "t1", "m1")).toEqual([
      expect.objectContaining({ artifactId: "art-pr", parentArtifactId: "art-patch" }),
    ]);
  });

  it("does not throw when registration fails (missing manifest)", () => {
    const db = fixture();
    const result = tryRegisterBoundMissionArtifacts(db, {
      tenantId: "t1",
      missionId: "m1",
      producerPrincipalId: "p1",
      correlationId: "corr",
      createdAt: T0,
      artifacts: [{ role: "candidate_patch", artifactId: "missing-manifest", label: "patch" }],
    });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("unreachable");
    expect(result.reason).toMatch(/mission_artifact/);
    expect(listMissionArtifacts(db, "t1", "m1")).toHaveLength(0);
  });
});

describe("tryRegisterFettlerCampaignMissionArtifacts", () => {
  it("skips when the campaign is not linked to a Mission", () => {
    const db = fixture();
    createWardenCampaign(db, {
      id: "campaign-a", tenantId: "t1", name: "Payments update", ownerPrincipalId: "p1",
      concurrencyLimit: 1, completionPolicy: "all", eventId: "campaign-created",
      idempotencyKey: "campaign-created", correlationId: "campaign-a", createdAt: T0,
    });
    manifest(db, "art-patch", "candidate-edit", "patch");
    const result = tryRegisterFettlerCampaignMissionArtifacts(db, {
      tenantId: "t1",
      campaignId: "campaign-a",
      producerPrincipalId: "p1",
      createdAt: T0,
      artifacts: [{ role: "candidate_patch", artifactId: "art-patch", label: "patch" }],
    });
    expect(result).toEqual({ status: "skipped_unbound" });
  });

  it("registers against the campaign-linked Mission", () => {
    const db = fixture();
    createWardenCampaign(db, {
      id: "campaign-a", tenantId: "t1", name: "Payments update", ownerPrincipalId: "p1",
      concurrencyLimit: 1, completionPolicy: "all", eventId: "campaign-created",
      idempotencyKey: "campaign-created", correlationId: "campaign-a", createdAt: T0,
    });
    linkFettlerCampaignToMission(db, {
      tenantId: "t1", campaignId: "campaign-a", missionId: "m1", actorPrincipalId: "p1",
      eventId: "linked", idempotencyKey: "linked", correlationId: "campaign-a", createdAt: T0,
    });
    manifest(db, "art-patch", "candidate-edit", "patch");
    const result = tryRegisterFettlerCampaignMissionArtifacts(db, {
      tenantId: "t1",
      campaignId: "campaign-a",
      producerPrincipalId: "p1",
      createdAt: T0,
      artifacts: [{ role: "candidate_patch", artifactId: "art-patch", label: "patch" }],
    });
    expect(result).toEqual({ status: "registered", missionId: "m1", count: 1 });
    expect(listMissionArtifacts(db, "t1", "m1")).toHaveLength(1);
  });
});
