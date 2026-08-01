import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendDomainEvent,
  createDb,
  insertArtifactManifest,
  insertEvidenceRecord,
  insertPrincipal,
  insertReviewDecision,
  listArtifactManifests,
  listDomainEvents,
  listEvidenceRecords,
  listReviewDecisions,
  recordAudit,
  verifyAuditIntegrity,
  verifyDomainEventIntegrity,
} from "./index.js";

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];
const at = "2026-08-01T12:00:00.000Z";

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close?.();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-trust-"));
  dirs.push(dir);
  const db = createDb(join(dir, "trust.sqlite"));
  dbs.push(db);
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    insertPrincipal(db, {
      id: `principal-${tenantId}`,
      tenantId,
      kind: "human",
      subject: `user-${tenantId}`,
      displayName: `Reviewer ${tenantId}`,
      createdAt: at,
    });
  }
  return db;
}

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

describe("trust records", () => {
  it("backfills and seals legacy audit rows during startup migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-audit-migration-"));
    dirs.push(dir);
    const path = join(dir, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        principal_id TEXT,
        api_key_id TEXT,
        request_id TEXT,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO audit_events
      (id, tenant_id, actor, action, resource_type, metadata_json, created_at)
      VALUES
      ('legacy-audit', 'tenant-a', 'legacy', 'started', 'system', '{"ok":true}', '${at}');
    `);
    legacy.close();

    const db = createDb(path);
    dbs.push(db);
    expect(verifyAuditIntegrity(db, "tenant-a")).toEqual({ ok: true, checked: 1 });
    const row = db.raw
      .prepare(
        `SELECT event_sequence, schema_version, prev_hash, event_hash, metadata_sha256
         FROM audit_events WHERE id = 'legacy-audit'`,
      )
      .get() as Record<string, unknown>;
    expect(row.event_sequence).toBe(1);
    expect(row.schema_version).toBe(1);
    expect(row.prev_hash).toBeNull();
    expect(String(row.event_hash)).toHaveLength(64);
    expect(String(row.metadata_sha256)).toHaveLength(64);
  });

  it("keeps immutable artifacts and evidence tenant scoped", () => {
    const db = setup();
    const artifactA = insertArtifactManifest(db, {
      id: "artifact-a",
      tenantId: "tenant-a",
      kind: "verification-log",
      schemaVersion: 1,
      sha256: sha("tenant-a-log"),
      mediaType: "text/plain",
      sizeBytes: 12,
      storageRef: "artifact://tenant-a/log",
      producerPrincipalId: "principal-tenant-a",
      createdAt: at,
    });
    insertArtifactManifest(db, {
      id: "artifact-b",
      tenantId: "tenant-b",
      kind: "verification-log",
      schemaVersion: 1,
      sha256: sha("tenant-b-log"),
      mediaType: "text/plain",
      sizeBytes: 12,
      storageRef: "artifact://tenant-b/log",
      producerPrincipalId: "principal-tenant-b",
      createdAt: at,
    });

    expect(artifactA.inserted).toBe(true);
    expect(
      insertArtifactManifest(db, {
        id: "artifact-a-replay",
        tenantId: "tenant-a",
        kind: "verification-log",
        schemaVersion: 1,
        sha256: sha("tenant-a-log"),
        mediaType: "text/plain",
        sizeBytes: 12,
        storageRef: "artifact://tenant-a/log",
        producerPrincipalId: "principal-tenant-a",
        createdAt: at,
      }).inserted,
    ).toBe(false);
    expect(listArtifactManifests(db, "tenant-a").map((row) => row.id)).toEqual([
      "artifact-a",
    ]);

    expect(() =>
      insertEvidenceRecord(db, {
        id: "evidence-cross-tenant",
        tenantId: "tenant-a",
        subjectType: "candidate",
        subjectId: "candidate-1",
        artifactId: "artifact-b",
        tool: "vitest",
        verdict: "passed",
        createdAt: at,
      }),
    ).toThrow("artifact_manifests_tenant_mismatch");

    insertEvidenceRecord(db, {
      id: "evidence-a",
      tenantId: "tenant-a",
      subjectType: "candidate",
      subjectId: "candidate-1",
      artifactId: "artifact-a",
      producerPrincipalId: "principal-tenant-a",
      tool: "vitest",
      command: "npm test",
      toolVersion: "3.2.7",
      commitSha: "a".repeat(40),
      verdict: "passed",
      createdAt: at,
    });
    expect(listEvidenceRecords(db, "tenant-a", "candidate", "candidate-1")).toHaveLength(1);
    expect(listEvidenceRecords(db, "tenant-b", "candidate", "candidate-1")).toEqual([]);
    expect(() =>
      db.raw.prepare("UPDATE artifact_manifests SET storage_ref = 'changed' WHERE id = 'artifact-a'").run(),
    ).toThrow("artifact_manifests_append_only");
    expect(() =>
      db.raw.prepare("DELETE FROM evidence_records WHERE id = 'evidence-a'").run(),
    ).toThrow("evidence_records_append_only");
  });

  it("binds immutable review decisions to the exact candidate and reviewer", () => {
    const db = setup();
    insertArtifactManifest(db, {
      id: "candidate-a",
      tenantId: "tenant-a",
      kind: "candidate-patch",
      schemaVersion: 1,
      sha256: sha("patch-a"),
      mediaType: "text/x-diff",
      sizeBytes: 7,
      storageRef: "artifact://tenant-a/patch-a",
      createdAt: at,
    });
    expect(() =>
      insertReviewDecision(db, {
        id: "waiver-a",
        tenantId: "tenant-a",
        subjectType: "migration_pr",
        subjectId: "pr-a",
        candidateArtifactId: "candidate-a",
        reviewerPrincipalId: "principal-tenant-a",
        decision: "waive",
        rationale: "Temporary exception",
        createdAt: at,
      }),
    ).toThrow("review_waiver_expiry_required");
    insertReviewDecision(db, {
      id: "review-a",
      tenantId: "tenant-a",
      subjectType: "migration_pr",
      subjectId: "pr-a",
      candidateArtifactId: "candidate-a",
      reviewerPrincipalId: "principal-tenant-a",
      decision: "approve",
      rationale: "Verified evidence is complete",
      createdAt: at,
    });
    expect(listReviewDecisions(db, "tenant-a", "migration_pr", "pr-a")).toHaveLength(1);
    expect(() =>
      db.raw.prepare("UPDATE review_decisions SET rationale = 'changed' WHERE id = 'review-a'").run(),
    ).toThrow("review_decisions_append_only");
  });

  it("hash chains domain events and rejects conflicting replays", () => {
    const db = setup();
    const input = {
      id: "event-a",
      tenantId: "tenant-a",
      schemaVersion: 1,
      eventType: "candidate.verified",
      aggregateType: "candidate",
      aggregateId: "candidate-a",
      actorPrincipalId: "principal-tenant-a",
      correlationId: "correlation-a",
      idempotencyKey: "candidate-a:verified:1",
      payload: { verdict: "passed" },
      createdAt: at,
    };
    expect(appendDomainEvent(db, input).inserted).toBe(true);
    expect(appendDomainEvent(db, { ...input, id: "event-a-replay" }).inserted).toBe(false);
    expect(() =>
      appendDomainEvent(db, {
        ...input,
        id: "event-a-conflict",
        payload: { verdict: "failed" },
      }),
    ).toThrow("domain_event_idempotency_conflict");
    appendDomainEvent(db, {
      ...input,
      id: "event-b",
      idempotencyKey: "candidate-a:delivered:1",
      eventType: "candidate.delivered",
      causationId: "event-a",
      payload: { pullRequest: 42 },
    });
    expect(listDomainEvents(db, "tenant-a").map((row) => row.event_sequence)).toEqual([1, 2]);
    expect(listDomainEvents(db, "tenant-b")).toEqual([]);
    expect(verifyDomainEventIntegrity(db, "tenant-a")).toEqual({ ok: true, checked: 2 });
    expect(() =>
      db.raw.prepare("DELETE FROM domain_events WHERE id = 'event-a'").run(),
    ).toThrow("domain_events_append_only");
  });

  it("makes audit entries append only, replay safe, and integrity verifiable", () => {
    const db = setup();
    recordAudit(db, {
      id: "audit-a",
      tenantId: "tenant-a",
      actor: "test",
      action: "candidate.verified",
      resourceType: "candidate",
      resourceId: "candidate-a",
      metadata: { verdict: "passed" },
    });
    recordAudit(db, {
      id: "audit-a",
      tenantId: "tenant-a",
      actor: "test",
      action: "candidate.verified",
      resourceType: "candidate",
      resourceId: "candidate-a",
      metadata: { verdict: "passed" },
    });
    expect(() =>
      recordAudit(db, {
        id: "audit-a",
        tenantId: "tenant-a",
        actor: "test",
        action: "candidate.verified",
        resourceType: "candidate",
        resourceId: "candidate-a",
        metadata: { verdict: "failed" },
      }),
    ).toThrow("audit_event_id_conflict");
    recordAudit(db, {
      id: "audit-b",
      tenantId: "tenant-a",
      actor: "test",
      action: "candidate.delivered",
      resourceType: "candidate",
      resourceId: "candidate-a",
    });
    expect(verifyAuditIntegrity(db, "tenant-a")).toEqual({ ok: true, checked: 2 });
    expect(() =>
      db.raw.prepare("UPDATE audit_events SET action = 'changed' WHERE id = 'audit-a'").run(),
    ).toThrow("audit_events_append_only");

    db.raw.exec("DROP TRIGGER audit_events_append_only_update");
    db.raw.prepare("UPDATE audit_events SET metadata_json = '{\"changed\":true}' WHERE id = 'audit-b'").run();
    expect(verifyAuditIntegrity(db, "tenant-a")).toMatchObject({
      ok: false,
      error: "audit_chain_hash:audit-b",
    });
  });
});
