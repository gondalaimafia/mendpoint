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
  readMissionTimeline,
  recordMissionVerification,
  registerMissionArtifact,
  transitionMission,
  type AppDb,
} from "./index.js";

const T0 = "2026-01-01T00:00:00.000Z";
const MANIFEST_A = "a".repeat(64);
const opened: Array<{ db: AppDb; dir: string }> = [];

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-mtl-"));
  const db = createDb(join(dir, "t.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1','one','One','team','active',10,?), ('t2','two','Two','team','active',10,?)`).run(T0, T0);
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com", displayName: "One", createdAt: T0 });
  insertPrincipal(db, { id: "p2", tenantId: "t2", kind: "human", subject: "two@example.com", displayName: "Two", createdAt: T0 });
  db.raw.prepare(`INSERT INTO scm_connections (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES ('c1','t1','github','me://ref','acct','Acme',?,?)`).run(T0, T0);
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch, environment, retention_days, status, created_at, updated_at)
    VALUES ('r1','t1','c1','1','acme','svc','main','main','production',30,'ready',?,?)`).run(T0, T0);
  db.raw.prepare(`INSERT INTO repository_snapshots
    (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
     submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
    VALUES ('snapA','t1','r1','main',?,?,'C:/tmp/snapA','reject','reject','[]',1,?,'2026-02-01T00:00:00.000Z')`)
    .run("1".repeat(40), MANIFEST_A, T0);
  return db;
}

function manifest(db: AppDb, tenant: string, id: string, kind: string, content: string, at_ = T0) {
  const sha256 = createHash("sha256").update(content).digest("hex");
  insertArtifactManifest(db, {
    id, tenantId: tenant, kind, schemaVersion: 1, sha256, mediaType: "text/plain",
    sizeBytes: Buffer.byteLength(content, "utf8"), storageRef: `mem://${id}`, content, createdAt: at_,
  });
  return sha256;
}

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("mission timeline projection", () => {
  it("reflects real recorded events for a mission, in append-only order", () => {
    const db = fixture();
    createMission(db, { id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
      objective: "Migrate off v1", ownerPrincipalId: "p1", eventId: "ev-m1", idempotencyKey: "cm-m1",
      correlationId: "corr", createdAt: at(0) });
    const m = transitionMission(db, { tenantId: "t1", missionId: "m1", expectedRevision: 1, to: "discovering",
      actorPrincipalId: "p1", eventId: "ev-m1-t1", idempotencyKey: "tm-m1-1", correlationId: "corr", createdAt: at(1) });
    transitionMission(db, { tenantId: "t1", missionId: "m1", expectedRevision: m.revision, to: "scoped",
      actorPrincipalId: "p1", eventId: "ev-m1-t2", idempotencyKey: "tm-m1-2", correlationId: "corr", createdAt: at(2) });
    recordMissionVerification(db, { tenantId: "t1", missionId: "m1", verification: "integration tests",
      scope: "stage-1", snapshotId: "snapA", resolvedSha: "1".repeat(40), manifestSha256: MANIFEST_A,
      status: "passed", verifierPrincipalId: "p1", correlationId: "corr", createdAt: at(3) });

    const timeline = readMissionTimeline(db, "t1", "m1");
    expect(timeline.status).toBe("ok");
    if (timeline.status !== "ok") return;
    expect(timeline.missionExists).toBe(true);
    expect(timeline.integrity.verified).toBe(true);
    expect(timeline.entries.map((e) => e.eventType)).toEqual([
      "mission.created",
      "mission.transitioned",
      "mission.transitioned",
      "mission.verification_recorded",
    ]);
    // Strictly ascending sequence = the recorded happened-before order.
    const seqs = timeline.entries.map((e) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  // CONTROL: a broken hash chain must be reported as broken, never rendered as a
  // clean timeline. Deleting the `if (!integrity.ok)` short-circuit in
  // readMissionTimeline makes this return status "ok" with entries — this test
  // then fails on both the status assertion and the absence of `entries`.
  it("reports a broken hash chain as broken and returns no entries", () => {
    const db = fixture();
    createMission(db, { id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
      objective: "Migrate off v1", ownerPrincipalId: "p1", eventId: "ev-m1", idempotencyKey: "cm-m1",
      correlationId: "corr", createdAt: at(0) });
    // domain_events is append-only (installTrustImmutability triggers block
    // UPDATE/DELETE), so tamper by APPENDING a row whose chain linkage is wrong:
    // a valid next sequence but a broken prev_hash. verifyDomainEventIntegrity
    // walks the whole tenant chain and rejects it.
    const max = (db.raw.prepare("SELECT MAX(event_sequence) AS m FROM domain_events WHERE tenant_id = 't1'")
      .get() as { m: number }).m;
    const payloadJson = "{}";
    db.raw.prepare(`INSERT INTO domain_events
      (id, tenant_id, event_sequence, schema_version, event_type, aggregate_type, aggregate_id,
       actor_principal_id, correlation_id, causation_id, idempotency_key, payload_json, payload_sha256,
       prev_hash, event_hash, created_at)
      VALUES ('tampered','t1',?,1,'mission.transitioned','mission','m1','p1','corr',NULL,'tamper-key',?,?,?,?,?)`)
      .run(max + 1, payloadJson, createHash("sha256").update(payloadJson).digest("hex"),
        "0".repeat(64), "f".repeat(64), at(1));

    const timeline = readMissionTimeline(db, "t1", "m1");
    expect(timeline.status).toBe("chain_broken");
    if (timeline.status !== "chain_broken") return;
    expect(timeline.integrity.verified).toBe(false);
    expect(timeline.integrity.error).toContain("domain_event");
    // No authoritative history is exposed on a broken chain.
    expect((timeline as { entries?: unknown }).entries).toBeUndefined();
  });

  // CONTROL: "no events recorded" must be distinguishable from "events could not
  // be read". If the reader's try/catch were removed, or if it collapsed a read
  // failure into an empty-but-ok result, the two branches below would not differ.
  it("distinguishes no-events from unreadable", () => {
    const db = fixture();
    // (a) No mission, no events: a valid, empty, verified timeline.
    const empty = readMissionTimeline(db, "t1", "missing");
    expect(empty.status).toBe("ok");
    if (empty.status !== "ok") return;
    expect(empty.missionExists).toBe(false);
    expect(empty.entries).toEqual([]);
    expect(empty.eventCount).toBe(0);

    // (b) The event store itself cannot be read: distinct from "nothing recorded".
    createMission(db, { id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
      objective: "Migrate off v1", ownerPrincipalId: "p1", eventId: "ev-m1", idempotencyKey: "cm-m1",
      correlationId: "corr", createdAt: at(0) });
    db.raw.exec("DROP TABLE domain_events");
    const unreadable = readMissionTimeline(db, "t1", "m1");
    expect(unreadable.status).toBe("unreadable");
    if (unreadable.status !== "unreadable") return;
    expect(unreadable.reason.length).toBeGreaterThan(0);
    // The two states are genuinely different values, not the same shape.
    expect(unreadable.status).not.toBe(empty.status);
  });

  // CONTROL: a mission id from another tenant must never surface this tenant's
  // events. listDomainEvents filters on tenant_id; dropping that predicate would
  // leak t1's events into a t2 read and fail this test.
  it("cannot read another tenant's mission timeline", () => {
    const db = fixture();
    createMission(db, { id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
      objective: "t1 mission", ownerPrincipalId: "p1", eventId: "ev-m1", idempotencyKey: "cm-m1",
      correlationId: "corr", createdAt: at(0) });
    createMission(db, { id: "m2", tenantId: "t2", product: "fettler", triggerKind: "provider_change",
      objective: "t2 mission", ownerPrincipalId: "p2", eventId: "ev-m2", idempotencyKey: "cm-m2",
      correlationId: "corr", createdAt: at(0) });

    // t2 asking for t1's mission id sees nothing of t1.
    const leak = readMissionTimeline(db, "t2", "m1");
    expect(leak.status).toBe("ok");
    if (leak.status !== "ok") return;
    expect(leak.missionExists).toBe(false);
    expect(leak.entries).toEqual([]);

    // Each tenant sees only its own mission's events.
    const own = readMissionTimeline(db, "t1", "m1");
    expect(own.status).toBe("ok");
    if (own.status !== "ok") return;
    expect(own.entries).toHaveLength(1);
    expect(own.entries[0].eventType).toBe("mission.created");
  });

  it("registered artifacts and lineage appear on the mission timeline", () => {
    const db = fixture();
    createMission(db, { id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
      objective: "Migrate off v1", ownerPrincipalId: "p1", eventId: "ev-m1", idempotencyKey: "cm-m1",
      correlationId: "corr", createdAt: at(0) });
    manifest(db, "t1", "art-impact", "impact-report", "impact report body");
    registerMissionArtifact(db, { tenantId: "t1", missionId: "m1", role: "impact_report",
      artifactId: "art-impact", label: "impact", producerPrincipalId: "p1", correlationId: "corr", createdAt: at(1) });

    const timeline = readMissionTimeline(db, "t1", "m1");
    expect(timeline.status).toBe("ok");
    if (timeline.status !== "ok") return;
    expect(timeline.entries.map((e) => e.eventType)).toContain("mission.artifact_registered");
  });
});
