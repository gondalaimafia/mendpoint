import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendDomainEvent,
  createDb,
  insertPrincipal,
  listDomainEvents,
  type AppDb,
} from "@mendpoint/db";
import {
  RELEASE_DISPATCH_CONTRACT_VERSION,
  RELEASE_DISPATCH_SINK_FAILURE_CODES,
  acceptReleaseDispatchDomainEvent,
  assertActiveReleaseDispatchPrincipal,
  ensureReleaseDispatchPrincipal,
  parseReleaseDispatchEnvelope,
} from "./release-dispatch-domain-event-sink.js";

const NOW = "2026-08-27T15:00:00.000Z";
const DIGEST = "a".repeat(64);
const opened: AppDb[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) db.raw.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function database(): AppDb {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-release-sink-"));
  directories.push(directory);
  const db = createDb(join(directory, "app.sqlite"));
  opened.push(db);
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    db.raw.prepare(`INSERT INTO tenants
      (id, slug, name, plan, billing_status, seat_limit, created_at)
      VALUES (?, ?, ?, 'team', 'active', 10, ?)`)
      .run(tenantId, tenantId, tenantId, "2026-08-27T14:00:00.000Z");
  }
  return db;
}

function principal(db: AppDb, input: Readonly<{
  id?: string;
  tenantId?: string;
  kind?: "human" | "service";
  subject?: string;
  createdAt?: string;
  revokedAt?: string | null;
  expiresAt?: string | null;
}> = {}): string {
  const id = input.id ?? "release-service-a";
  insertPrincipal(db, {
    id,
    tenantId: input.tenantId ?? "tenant-a",
    kind: input.kind ?? "service",
    subject: input.subject ?? "release-dispatch",
    displayName: "Release dispatch worker",
    createdAt: input.createdAt ?? "2026-08-27T14:00:00.000Z",
    revokedAt: input.revokedAt,
    expiresAt: input.expiresAt,
  });
  return id;
}

function envelope(tenantId = "tenant-a") {
  return {
    contractVersion: RELEASE_DISPATCH_CONTRACT_VERSION,
    tenantId,
    dispatchId: "rds_dispatch-a",
    artifactId: "rel_artifact-a",
    artifactContentSha256: DIGEST,
  } as const;
}

describe("release dispatch domain event sink", () => {
  it("appends one deterministic identifier-only event and accepts an exact crash replay", () => {
    const db = database();
    const actorPrincipalId = principal(db);
    const first = acceptReleaseDispatchDomainEvent({
      db, actorPrincipalId, envelope: envelope(), observedAt: NOW,
    });
    const replay = acceptReleaseDispatchDomainEvent({
      db, actorPrincipalId, envelope: envelope(), observedAt: "2026-08-27T15:01:00.000Z",
    });
    expect(first).toMatchObject({ inserted: true });
    expect(replay).toEqual({ eventId: first.eventId, inserted: false });
    const events = listDomainEvents(db, "tenant-a");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: first.eventId,
      schema_version: 1,
      event_type: "catalog.release_dispatch.accepted",
      aggregate_type: "catalog_release_dispatch",
      aggregate_id: "rds_dispatch-a",
      correlation_id: "rds_dispatch-a",
      causation_id: "rel_artifact-a",
      idempotency_key: "catalog-release:rds_dispatch-a",
    });
    expect(JSON.parse(events[0]!.payload_json)).toEqual(envelope());
    expect(events[0]!.payload_json).not.toContain("sourceUrl");
    expect(events[0]!.payload_json).not.toContain("excerpt");
  });

  it("rejects an exact crash replay under a different service principal", () => {
    const db = database();
    const originalPrincipalId = principal(db, { id: "release-service-original" });
    const first = acceptReleaseDispatchDomainEvent({
      db, actorPrincipalId: originalPrincipalId, envelope: envelope(), observedAt: NOW,
    });

    db.raw.prepare("UPDATE principals SET revoked_at = ? WHERE tenant_id = ? AND id = ?")
      .run("2026-08-27T15:00:30.000Z", "tenant-a", originalPrincipalId);
    const replacementPrincipalId = principal(db, {
      id: "release-service-replacement",
      subject: "release-dispatch-replacement",
      createdAt: "2026-08-27T15:00:30.000Z",
    });

    expect(() => acceptReleaseDispatchDomainEvent({
      db,
      actorPrincipalId: replacementPrincipalId,
      envelope: envelope(),
      observedAt: "2026-08-27T15:01:00.000Z",
    })).toThrow(RELEASE_DISPATCH_SINK_FAILURE_CODES.authorityInvalid);
    const events = listDomainEvents(db, "tenant-a");
    expect(events).toHaveLength(1);
    expect(events[0]!.actor_principal_id).toBe(originalPrincipalId);
  });

  it("provisions the exact tenant service principal and refuses a conflicting identity", () => {
    const db = database();
    expect(() => ensureReleaseDispatchPrincipal({
      db, tenantId: "tenant-a", actorPrincipalId: "release-service-a", observedAt: NOW,
    })).not.toThrow();
    expect(() => assertActiveReleaseDispatchPrincipal({
      db, tenantId: "tenant-a", actorPrincipalId: "release-service-a", observedAt: NOW,
    })).not.toThrow();
    principal(db, { id: "wrong-service", tenantId: "tenant-b" });
    expect(() => ensureReleaseDispatchPrincipal({
      db, tenantId: "tenant-a", actorPrincipalId: "wrong-service", observedAt: NOW,
    })).toThrow(RELEASE_DISPATCH_SINK_FAILURE_CODES.authorityInvalid);
  });

  it("rejects extra keys, malformed digests, and cross-tenant authority", () => {
    const db = database();
    const actorPrincipalId = principal(db);
    expect(() => parseReleaseDispatchEnvelope({ ...envelope(), repositoryContent: "private" }))
      .toThrow(RELEASE_DISPATCH_SINK_FAILURE_CODES.validationFailed);
    expect(() => parseReleaseDispatchEnvelope({ ...envelope(), artifactContentSha256: DIGEST.toUpperCase() }))
      .toThrow(RELEASE_DISPATCH_SINK_FAILURE_CODES.validationFailed);
    expect(() => acceptReleaseDispatchDomainEvent({
      db, actorPrincipalId, envelope: envelope("tenant-b"), observedAt: NOW,
    })).toThrow(RELEASE_DISPATCH_SINK_FAILURE_CODES.authorityInvalid);
    expect(listDomainEvents(db, "tenant-b")).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["human", { kind: "human" as const }],
    ["created later", { createdAt: "2026-08-27T15:00:00.001Z" }],
    ["revoked", { revokedAt: NOW }],
    ["expired", { expiresAt: NOW }],
  ])("rejects a %s service-principal binding", (_label, attributes) => {
    const db = database();
    const actorPrincipalId = attributes ? principal(db, attributes) : "missing-service";
    expect(() => assertActiveReleaseDispatchPrincipal({
      db, tenantId: "tenant-a", actorPrincipalId, observedAt: NOW,
    })).toThrow(RELEASE_DISPATCH_SINK_FAILURE_CODES.authorityInvalid);
  });

  it("detects replay fields the generic event appender does not compare", () => {
    const db = database();
    const actorPrincipalId = principal(db);
    appendDomainEvent(db, {
      id: "wrong-event-id",
      tenantId: "tenant-a",
      schemaVersion: 7,
      eventType: "catalog.release_dispatch.accepted",
      aggregateType: "catalog_release_dispatch",
      aggregateId: "rds_dispatch-a",
      actorPrincipalId,
      correlationId: "wrong-correlation",
      causationId: null,
      idempotencyKey: "catalog-release:rds_dispatch-a",
      payload: envelope(),
      createdAt: NOW,
    });
    expect(() => acceptReleaseDispatchDomainEvent({
      db, actorPrincipalId, envelope: envelope(), observedAt: NOW,
    })).toThrow(RELEASE_DISPATCH_SINK_FAILURE_CODES.idempotencyConflict);
    expect(listDomainEvents(db, "tenant-a")).toHaveLength(1);
  });

  it("maps database failures to a retryable fixed code without leaking the raw error", () => {
    const db = database();
    const actorPrincipalId = principal(db);
    db.raw.close();
    opened.splice(opened.indexOf(db), 1);
    let caught: unknown;
    try {
      acceptReleaseDispatchDomainEvent({ db, actorPrincipalId, envelope: envelope(), observedAt: NOW });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      message: RELEASE_DISPATCH_SINK_FAILURE_CODES.infrastructureUnavailable,
      code: RELEASE_DISPATCH_SINK_FAILURE_CODES.infrastructureUnavailable,
      retryable: true,
    });
  });
});
