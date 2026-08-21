import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  insertArtifactManifest,
  insertPrincipal,
  listMissionArtifactLineage,
  listMissionArtifacts,
  recordMissionArtifactLineage,
  registerMissionArtifact,
  traceMissionArtifactAncestry,
  verifyDomainEventIntegrity,
  type AppDb,
} from "./index.js";

const T0 = "2026-01-01T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string; path: string }> = [];

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

function base(db: AppDb) {
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1','one','One','team','active',10,?), ('t2','two','Two','team','active',10,?)`).run(T0, T0);
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com", displayName: "One", createdAt: T0 });
  insertPrincipal(db, { id: "p2", tenantId: "t2", kind: "human", subject: "two@example.com", displayName: "Two", createdAt: T0 });
  createMission(db, { id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
    objective: "Migrate off v1", ownerPrincipalId: "p1", eventId: "ev-m1", idempotencyKey: "cm-m1",
    correlationId: "corr", createdAt: T0 });
  createMission(db, { id: "m2", tenantId: "t2", product: "fettler", triggerKind: "provider_change",
    objective: "t2 mission", ownerPrincipalId: "p2", eventId: "ev-m2", idempotencyKey: "cm-m2",
    correlationId: "corr", createdAt: T0 });
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-mart-"));
  const path = join(dir, "a.sqlite");
  const db = createDb(path);
  opened.push({ db, dir, path });
  base(db);
  return db;
}

function manifest(db: AppDb, tenant: string, id: string, kind: string, content: string) {
  const sha256 = createHash("sha256").update(content).digest("hex");
  insertArtifactManifest(db, {
    id, tenantId: tenant, kind, schemaVersion: 1, sha256, mediaType: "text/plain",
    sizeBytes: Buffer.byteLength(content, "utf8"), storageRef: `mem://${id}`, content, createdAt: T0,
  });
  return sha256;
}

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    try { db.raw.close(); } catch { /* already closed by a test */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("mission artifact registry", () => {
  // CONTROL: an output is referenced, not copied, and its lineage is
  // recoverable. The registry row carries the manifest id + sha256 only; the
  // bytes stay in artifact_manifests. If recordMissionArtifactLineage were a
  // no-op, the ancestry assertion below returns [] and fails.
  it("references artifacts without copying and recovers lineage", () => {
    const db = fixture();
    const impactSha = manifest(db, "t1", "art-impact", "impact-report", "the impact report body");
    const patchSha = manifest(db, "t1", "art-patch", "candidate-edit", "the candidate patch bytes");
    const prSha = manifest(db, "t1", "art-pr", "pull-request", "the pull request payload");

    registerMissionArtifact(db, { tenantId: "t1", missionId: "m1", role: "impact_report",
      artifactId: "art-impact", label: "impact", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(1) });
    registerMissionArtifact(db, { tenantId: "t1", missionId: "m1", role: "candidate_patch",
      artifactId: "art-patch", label: "patch", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(2) });
    registerMissionArtifact(db, { tenantId: "t1", missionId: "m1", role: "pull_request",
      artifactId: "art-pr", label: "pr", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(3) });

    // Lineage: patch derived_from impact; pr derived_from patch.
    recordMissionArtifactLineage(db, { tenantId: "t1", missionId: "m1", artifactId: "art-patch",
      parentArtifactId: "art-impact", recordedByPrincipalId: "p1", correlationId: "corr", createdAt: at(4) });
    recordMissionArtifactLineage(db, { tenantId: "t1", missionId: "m1", artifactId: "art-pr",
      parentArtifactId: "art-patch", recordedByPrincipalId: "p1", correlationId: "corr", createdAt: at(5) });

    const registered = listMissionArtifacts(db, "t1", "m1");
    expect(registered).toHaveLength(3);
    // The registry stores the reference + canonical digest, and matches the
    // manifest's own sha256 — it did not invent or copy content.
    const patchRow = registered.find((a) => a.artifactId === "art-patch")!;
    expect(patchRow.artifactSha256).toBe(patchSha);

    // The bytes live ONLY in artifact_manifests, not duplicated into the registry.
    const registryColumns = (db.raw.prepare("PRAGMA table_info(mission_artifacts)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(registryColumns).not.toContain("content_text");
    expect(registryColumns).not.toContain("content");
    const stillInManifest = db.raw.prepare("SELECT content_text FROM artifact_manifests WHERE id = 'art-patch'")
      .get() as { content_text: string };
    expect(stillInManifest.content_text).toBe("the candidate patch bytes");

    // Lineage is recoverable: the PR traces back through the patch to the impact
    // report.
    const ancestry = traceMissionArtifactAncestry(db, "t1", "m1", "art-pr");
    expect(ancestry.sort()).toEqual(["art-impact", "art-patch"].sort());
    expect(impactSha).toBe(registered.find((a) => a.artifactId === "art-impact")!.artifactSha256);
    expect(prSha).toBe(registered.find((a) => a.artifactId === "art-pr")!.artifactSha256);

    expect(listMissionArtifactLineage(db, "t1", "m1")).toHaveLength(2);
  });

  // CONTROL: cross-tenant reads and writes are impossible. The composite FK and
  // requireTenantArtifact enforce same-tenant references; dropping the tenant
  // predicate would let these leak or succeed.
  it("cannot cross tenant boundaries", () => {
    const db = fixture();
    manifest(db, "t1", "art-t1", "impact-report", "t1 body");
    manifest(db, "t2", "art-t2", "impact-report", "t2 body");
    registerMissionArtifact(db, { tenantId: "t1", missionId: "m1", role: "impact_report",
      artifactId: "art-t1", label: "impact", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(1) });

    // t2 cannot see t1's registered outputs.
    expect(listMissionArtifacts(db, "t2", "m1")).toEqual([]);

    // A t2 manifest cannot be registered onto t1's mission.
    expect(() => registerMissionArtifact(db, { tenantId: "t1", missionId: "m1", role: "impact_report",
      artifactId: "art-t2", label: "x", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(2) }))
      .toThrow("mission_artifact_manifest_not_found");

    // t2 cannot register against t1's mission (mission not found for t2).
    expect(() => registerMissionArtifact(db, { tenantId: "t2", missionId: "m1", role: "impact_report",
      artifactId: "art-t2", label: "x", producerPrincipalId: "p2", correlationId: "corr", createdAt: at(2) }))
      .toThrow("mission_record_mission_not_found");
  });

  // CONTROL: the lineage graph is acyclic. Self-loops (CHECK + code) and longer
  // cycles (wouldCreateCycle) are rejected, so ancestry always terminates.
  it("rejects self-loops and cycles in lineage", () => {
    const db = fixture();
    manifest(db, "t1", "art-a", "impact-report", "a");
    manifest(db, "t1", "art-b", "candidate-edit", "b");
    registerMissionArtifact(db, { tenantId: "t1", missionId: "m1", role: "impact_report",
      artifactId: "art-a", label: "a", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(1) });
    registerMissionArtifact(db, { tenantId: "t1", missionId: "m1", role: "candidate_patch",
      artifactId: "art-b", label: "b", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(2) });

    expect(() => recordMissionArtifactLineage(db, { tenantId: "t1", missionId: "m1", artifactId: "art-a",
      parentArtifactId: "art-a", recordedByPrincipalId: "p1", correlationId: "corr", createdAt: at(3) }))
      .toThrow("mission_artifact_lineage_self_loop");

    // b derived_from a; then a derived_from b would close a cycle.
    recordMissionArtifactLineage(db, { tenantId: "t1", missionId: "m1", artifactId: "art-b",
      parentArtifactId: "art-a", recordedByPrincipalId: "p1", correlationId: "corr", createdAt: at(4) });
    expect(() => recordMissionArtifactLineage(db, { tenantId: "t1", missionId: "m1", artifactId: "art-a",
      parentArtifactId: "art-b", recordedByPrincipalId: "p1", correlationId: "corr", createdAt: at(5) }))
      .toThrow("mission_artifact_lineage_cycle");
  });

  // CONTROL: both stores are append-only, enforced by triggers. Removing either
  // trigger lets these mutations through.
  it("is append-only", () => {
    const db = fixture();
    manifest(db, "t1", "art-a", "impact-report", "a");
    const reg = registerMissionArtifact(db, { tenantId: "t1", missionId: "m1", role: "impact_report",
      artifactId: "art-a", label: "a", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(1) });
    expect(() => db.raw.prepare("UPDATE mission_artifacts SET label = 'x' WHERE id = ?").run(reg.id))
      .toThrow("mission_artifacts_append_only");
    expect(() => db.raw.prepare("DELETE FROM mission_artifacts WHERE id = ?").run(reg.id))
      .toThrow("mission_artifacts_append_only");

    manifest(db, "t1", "art-b", "candidate-edit", "b");
    registerMissionArtifact(db, { tenantId: "t1", missionId: "m1", role: "candidate_patch",
      artifactId: "art-b", label: "b", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(2) });
    const edge = recordMissionArtifactLineage(db, { tenantId: "t1", missionId: "m1", artifactId: "art-b",
      parentArtifactId: "art-a", recordedByPrincipalId: "p1", correlationId: "corr", createdAt: at(3) });
    expect(() => db.raw.prepare("UPDATE mission_artifact_lineage SET relation = 'derived_from' WHERE id = ?").run(edge.id))
      .toThrow("mission_artifact_lineage_append_only");
    expect(() => db.raw.prepare("DELETE FROM mission_artifact_lineage WHERE id = ?").run(edge.id))
      .toThrow("mission_artifact_lineage_append_only");
  });

  it("replays identical registrations and lineage idempotently", () => {
    const db = fixture();
    manifest(db, "t1", "art-a", "impact-report", "a");
    manifest(db, "t1", "art-b", "candidate-edit", "b");
    const first = registerMissionArtifact(db, { tenantId: "t1", missionId: "m1", role: "impact_report",
      artifactId: "art-a", label: "a", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(1) });
    const again = registerMissionArtifact(db, { tenantId: "t1", missionId: "m1", role: "impact_report",
      artifactId: "art-a", label: "a", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(1) });
    expect(again.id).toBe(first.id);
    expect(listMissionArtifacts(db, "t1", "m1")).toHaveLength(1);

    // A second, differently-timed registration of the same (mission, role,
    // artifact) is a conflict, not a silent duplicate.
    expect(() => registerMissionArtifact(db, { tenantId: "t1", missionId: "m1", role: "impact_report",
      artifactId: "art-a", label: "a", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(2) }))
      .toThrow("mission_artifact_already_registered");

    registerMissionArtifact(db, { tenantId: "t1", missionId: "m1", role: "candidate_patch",
      artifactId: "art-b", label: "b", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(2) });
    const e1 = recordMissionArtifactLineage(db, { tenantId: "t1", missionId: "m1", artifactId: "art-b",
      parentArtifactId: "art-a", recordedByPrincipalId: "p1", correlationId: "corr", createdAt: at(3) });
    const e2 = recordMissionArtifactLineage(db, { tenantId: "t1", missionId: "m1", artifactId: "art-b",
      parentArtifactId: "art-a", recordedByPrincipalId: "p1", correlationId: "corr", createdAt: at(3) });
    expect(e2.id).toBe(e1.id);
    expect(listMissionArtifactLineage(db, "t1", "m1")).toHaveLength(1);
  });

  it("rejects lineage endpoints that are not registered outputs of the mission", () => {
    const db = fixture();
    manifest(db, "t1", "art-a", "impact-report", "a");
    manifest(db, "t1", "art-b", "candidate-edit", "b");
    registerMissionArtifact(db, { tenantId: "t1", missionId: "m1", role: "impact_report",
      artifactId: "art-a", label: "a", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(1) });
    // art-b exists as a manifest but is not registered to the mission.
    expect(() => recordMissionArtifactLineage(db, { tenantId: "t1", missionId: "m1", artifactId: "art-b",
      parentArtifactId: "art-a", recordedByPrincipalId: "p1", correlationId: "corr", createdAt: at(2) }))
      .toThrow("mission_artifact_lineage_child_unregistered");
  });

  // CONTROL: convergence from a PRE-CHANGE volume, and pre-existing hash-chained
  // rows still verify. We simulate a database created before this change by
  // dropping the new objects (keeping the existing hash-chained domain_events),
  // then reopen via createDb — whose idempotent CREATE ... IF NOT EXISTS DDL must
  // reconverge with no ALTER and no error, leaving the old chain intact.
  it("converges from a pre-change volume and preserves the existing hash chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-martc-"));
    const path = join(dir, "c.sqlite");
    // First db is closed within the test; only the reopened db is registered for
    // afterEach cleanup, so the dir is never rmSync'd while a handle is still open
    // (that races an open WAL handle on Windows -> EPERM).
    const db = createDb(path);
    base(db);
    // A hash-chained event already exists (mission.created for m1).
    expect(verifyDomainEventIntegrity(db, "t1").ok).toBe(true);
    // Simulate the pre-change shape: the registry objects did not exist yet.
    db.raw.exec("DROP TABLE mission_artifact_lineage");
    db.raw.exec("DROP TABLE mission_artifacts");
    db.raw.exec("DROP INDEX artifact_manifests_id_tenant_uidx");
    db.raw.close();

    // Reopen: the additive DDL reconverges the dropped objects.
    const reopened = createDb(path);
    opened.push({ db: reopened, dir, path });
    // The pre-existing chained rows still verify after convergence.
    expect(verifyDomainEventIntegrity(reopened, "t1").ok).toBe(true);
    // The reconverged registry is usable.
    manifest(reopened, "t1", "art-a", "impact-report", "a");
    const reg = registerMissionArtifact(reopened, { tenantId: "t1", missionId: "m1", role: "impact_report",
      artifactId: "art-a", label: "a", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(1) });
    expect(reg.artifactId).toBe("art-a");
    expect(listMissionArtifacts(reopened, "t1", "m1")).toHaveLength(1);
  });
});
