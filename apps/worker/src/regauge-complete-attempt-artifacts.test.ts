import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  insertPrincipal,
  linkRegaugeCampaignToMission,
  listMissionArtifactLineage,
  listMissionArtifacts,
  type AppDb,
} from "@mendpoint/db";
import type { TransformerVerifiedCandidateCompletion } from "@mendpoint/transformer";
import { registerRegaugeVerifiedCandidateArtifacts } from "./transformer-pilot-lane.js";

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

function completion(db: AppDb, overrides: { tenantId?: string; campaignId?: string } = {}) {
  const candidateContent = JSON.stringify({ schemaVersion: 1, kind: "transformer.candidate" });
  const candidateSha256 = createHash("sha256").update(candidateContent).digest("hex");
  const candidatePath = join(opened.find((entry) => entry.db === db)!.dir, "candidate.json");
  writeFileSync(candidatePath, candidateContent);
  const executionContent = JSON.stringify({ schemaVersion: 3, kind: "transformer.recipe.execution" });
  const executionSha256 = createHash("sha256").update(executionContent).digest("hex");
  const executionPath = join(opened.find((entry) => entry.db === db)!.dir, "execution.json");
  writeFileSync(executionPath, executionContent);
  const executionId = `tre_execution_${executionSha256}`;
  return {
    lease: {
      tenantId: overrides.tenantId ?? "t1",
      campaignId: overrides.campaignId ?? "tf-1",
      unitId: "unit-1",
      snapshot: { snapshotId: "snap-1" },
    },
    artifact: {
      manifestPath: candidatePath,
      manifestDigest: `sha256:${candidateSha256}`,
      evidenceRefs: [`tcman_${candidateSha256}`, executionId],
    },
    execution: {
      evidence: {
        path: executionPath,
        digest: `sha256:${executionSha256}`,
        record: { schemaVersion: 3, evidenceId: executionId },
      },
    },
    observedAt: T0,
  } as unknown as TransformerVerifiedCandidateCompletion;
}

describe("registerRegaugeVerifiedCandidateArtifacts", () => {
  it("skips an unbound campaign before copying filesystem evidence", () => {
    const db = fixture();
    const value = completion(db, { campaignId: "unbound" });
    rmSync(value.artifact.manifestPath);
    rmSync(value.execution.evidence.path);
    expect(registerRegaugeVerifiedCandidateArtifacts(db, value)).toEqual({ status: "skipped_unbound" });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM artifact_manifests").get())
      .toEqual({ count: 0 });
  });

  it("persists and registers the authenticated candidate and verification artifacts", () => {
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
    const value = completion(db);
    const result = registerRegaugeVerifiedCandidateArtifacts(db, value);
    expect(result).toEqual({ status: "registered", missionId: "m-rg", count: 2 });
    const artifacts = listMissionArtifacts(db, "t1", "m-rg");
    expect(artifacts.map((artifact) => artifact.role).sort())
      .toEqual(["candidate_patch", "verification_report"]);
    expect(artifacts.every((artifact) => artifact.sourceSnapshot === "snap-1")).toBe(true);
    const candidate = artifacts.find((artifact) => artifact.role === "candidate_patch")!;
    const verification = artifacts.find((artifact) => artifact.role === "verification_report")!;
    expect(listMissionArtifactLineage(db, "t1", "m-rg")).toEqual([
      expect.objectContaining({ artifactId: verification.artifactId, parentArtifactId: candidate.artifactId }),
    ]);
    expect(db.raw.prepare(
      "SELECT kind, producer_principal_id FROM artifact_manifests ORDER BY kind",
    ).all()).toEqual([
      { kind: "regauge_candidate_manifest", producer_principal_id: "p1" },
      { kind: "regauge_recipe_execution", producer_principal_id: "p1" },
    ]);

    expect(registerRegaugeVerifiedCandidateArtifacts(db, value))
      .toEqual({ status: "registered", missionId: "m-rg", count: 2 });
    expect(listMissionArtifacts(db, "t1", "m-rg")).toHaveLength(2);
  });

  it("rejects a manifest whose bytes do not match the completed evidence", () => {
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
    const value = completion(db);
    writeFileSync(value.artifact.manifestPath, "tampered");
    expect(() => registerRegaugeVerifiedCandidateArtifacts(db, value))
      .toThrow("regauge_candidate_manifest_evidence_mismatch");
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM artifact_manifests").get())
      .toEqual({ count: 0 });
  });
});
