import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimReleaseDispatch,
  failReleaseDispatch,
  ingestReleaseDocument,
  listReleaseDispatchReconciliations,
  openReleaseIngestionStore,
} from "@mendpoint/catalog";
import {
  createDb,
  createTenantMembership,
  getPrincipal,
  insertArtifactManifest,
  insertEvidenceRecord,
  insertPrincipal,
} from "@mendpoint/db";
import { inspectMutationFence } from "@mendpoint/ops";
import {
  runReleaseDispatchReconciliationCommand,
  runReleaseDispatchReconciliationProcess,
} from "./release-dispatch-reconcile-cli.js";

const NOW = "2026-08-27T15:00:00.000Z";
const OIDC_ISSUER = "https://identity.example.test";
const OIDC_SUBJECT = "operator-subject";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(options: Readonly<{ expiresAt?: string }> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-release-reconcile-cli-"));
  directories.push(directory);
  let clock = NOW;
  let clockRead = () => clock;
  const store = openReleaseIngestionStore(join(directory, "release.sqlite"), { clock: () => clockRead() });
  const db = createDb(join(directory, "app.sqlite"));
  db.raw.prepare(`INSERT INTO tenants
    (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?)`)
    .run("2026-08-27T14:00:00.000Z");
  insertPrincipal(db, {
    id: "operator-a",
    tenantId: "tenant-a",
    kind: "human",
    subject: `${OIDC_ISSUER}|${OIDC_SUBJECT}`,
    displayName: "Release operator",
    audience: OIDC_ISSUER,
    expiresAt: options.expiresAt,
    createdAt: "2026-08-27T14:00:00.000Z",
  });
  createTenantMembership(db, {
    tenantId: "tenant-a",
    issuer: OIDC_ISSUER,
    subject: OIDC_SUBJECT,
    email: "operator@example.test",
    displayName: "Release operator",
    role: "owner",
    createdAt: "2026-08-27T14:00:00.000Z",
  });
  ingestReleaseDocument(store, {
    tenantId: "tenant-a",
    providerSlug: "stripe",
    adapter: "rss",
    sourceUrl: "https://docs.example.com/releases.xml",
    body: `<?xml version="1.0"?><rss><channel><item><guid>v1</guid><title>Release v1</title>
      <link>https://docs.example.com/releases/v1</link>
      <pubDate>Thu, 27 Aug 2026 15:00:00 GMT</pubDate>
      <description>Renames amount_cents.</description></item></channel></rss>`,
    observedAt: NOW,
    now: NOW,
  });
  const claim = claimReleaseDispatch(store, {
    tenantId: "tenant-a", workerId: "worker-a", leaseDurationMs: 10_000,
  })!;
  clock = "2026-08-27T15:00:01.000Z";
  const failed = failReleaseDispatch(store, {
    tenantId: "tenant-a",
    dispatchId: claim.id,
    workerId: "worker-a",
    leaseGeneration: claim.leaseGeneration,
    failureCode: "invalid_payload",
    retryable: false,
  });
  const evidenceCreatedAt = "2026-08-27T15:00:01.500Z";
  for (const [index, evidenceSha256] of ["a".repeat(64), "b".repeat(64)].entries()) {
    const artifactId = `reconciliation-artifact-${index}`;
    insertArtifactManifest(db, {
      id: artifactId,
      tenantId: "tenant-a",
      kind: "release_dispatch_reconciliation",
      schemaVersion: 1,
      sha256: evidenceSha256,
      mediaType: "application/json",
      sizeBytes: 1,
      storageRef: `evidence://${artifactId}`,
      producerPrincipalId: "operator-a",
      createdAt: evidenceCreatedAt,
    });
    insertEvidenceRecord(db, {
      id: `reconciliation-evidence-${index}`,
      tenantId: "tenant-a",
      subjectType: "release_dispatch_reconciliation",
      subjectId: failed.id,
      artifactId,
      producerPrincipalId: "operator-a",
      tool: "operator-review",
      command: JSON.stringify({
        action: index === 0 ? "requeue" : "acknowledge",
        dispatchId: failed.id,
        expectedLeaseGeneration: failed.leaseGeneration,
        expectedFailedAt: failed.failedAt,
        expectedFailureCode: failed.failureCode,
      }),
      verdict: "passed",
      createdAt: evidenceCreatedAt,
    });
  }
  clock = "2026-08-27T15:00:01.750Z";
  return {
    directory,
    mutationFenceRoot: join(directory, "mutation-fence"),
    db,
    store,
    failed,
    setClockRead: (next: () => string) => { clockRead = next; },
  };
}

function commandInput(value: ReturnType<typeof fixture>, overrides: Readonly<{
  evidenceSha256?: string;
  idempotencyKey?: string;
}> = {}) {
  return {
    argv: [
      "--tenant", "tenant-a",
      "--dispatch", value.failed.id,
      "--action", "acknowledge",
      "--evidence-sha256", overrides.evidenceSha256 ?? "b".repeat(64),
      "--expected-lease-generation", String(value.failed.leaseGeneration),
      "--expected-failed-at", value.failed.failedAt!,
      "--expected-failure-code", value.failed.failureCode!,
      "--idempotency-key", overrides.idempotencyKey ?? "operator:ack:hostile",
      "--actor-principal-id", "operator-a",
    ],
    env: {
      MENDPOINT_RELEASE_DISPATCH_CONSUMERS_JSON: JSON.stringify([{
        contractVersion: "catalog.release-dispatch.v1",
        tenantId: "tenant-a",
        actorPrincipalId: "release-service-a",
      }]),
      MENDPOINT_RELEASE_DISPATCH_RECONCILIATION_PRINCIPAL_ID: "operator-a",
    },
    db: value.db,
    store: value.store,
    mutationFenceRoot: value.mutationFenceRoot,
  } as const;
}

describe("release dispatch reconciliation command", () => {
  it("uses the exact tenant consumer authority and emits identifiers only", () => {
    const { db, store, failed, mutationFenceRoot } = fixture();
    const output: string[] = [];
    try {
      const result = runReleaseDispatchReconciliationCommand({
        argv: [
          "--tenant", "tenant-a",
          "--dispatch", failed.id,
          "--action", "requeue",
          "--evidence-sha256", "a".repeat(64),
          "--expected-lease-generation", String(failed.leaseGeneration),
          "--expected-failed-at", failed.failedAt!,
          "--expected-failure-code", failed.failureCode!,
          "--idempotency-key", "operator:requeue:1",
          "--actor-principal-id", "operator-a",
        ],
        env: {
          MENDPOINT_RELEASE_DISPATCH_CONSUMERS_JSON: JSON.stringify([{
            contractVersion: "catalog.release-dispatch.v1",
            tenantId: "tenant-a",
            actorPrincipalId: "release-service-a",
          }]),
          MENDPOINT_RELEASE_DISPATCH_RECONCILIATION_PRINCIPAL_ID: "operator-a",
        },
        db,
        store,
        mutationFenceRoot,
        write: (value) => output.push(value),
      });
      expect(result).toMatchObject({ dispatchId: failed.id, action: "requeue" });
      expect(output).toEqual([JSON.stringify(result)]);
      expect(output[0]).not.toContain("invalid_payload");
      expect(output[0]).not.toContain("aaaaaaaa");
      expect(getPrincipal(db, "tenant-a", "operator-a")).toMatchObject({
        kind: "human", subject: `${OIDC_ISSUER}|${OIDC_SUBJECT}`, audience: OIDC_ISSUER,
      });
      expect(listReleaseDispatchReconciliations(store, "tenant-a", failed.id)).toEqual([
        expect.objectContaining({ actorPrincipalId: "operator-a" }),
      ]);
    } finally {
      store.close();
      db.raw.close();
    }
  });

  it("fails closed for missing tenant authority, duplicate flags, and stale failure evidence", () => {
    const { db, store, failed, mutationFenceRoot } = fixture();
    const base = [
      "--tenant", "tenant-a",
      "--dispatch", failed.id,
      "--action", "acknowledge",
      "--evidence-sha256", "b".repeat(64),
      "--expected-lease-generation", String(failed.leaseGeneration),
      "--expected-failed-at", failed.failedAt!,
      "--expected-failure-code", failed.failureCode!,
      "--idempotency-key", "operator:ack:1",
      "--actor-principal-id", "operator-a",
    ];
    try {
      expect(() => runReleaseDispatchReconciliationCommand({
        argv: base,
        env: {},
        db,
        store,
        mutationFenceRoot,
      })).toThrow("release_dispatch_reconciliation_consumer_binding_required");
      expect(() => runReleaseDispatchReconciliationCommand({
        argv: [...base.slice(0, -2), "--tenant", "tenant-a"],
        env: { MENDPOINT_RELEASE_DISPATCH_CONSUMERS_JSON: "[]" },
        db,
        store,
        mutationFenceRoot,
      })).toThrow("release_dispatch_reconciliation_arguments_invalid");
      const boundEnv = {
        MENDPOINT_RELEASE_DISPATCH_CONSUMERS_JSON: JSON.stringify([{
          contractVersion: "catalog.release-dispatch.v1",
          tenantId: "tenant-a",
          actorPrincipalId: "release-service-a",
        }]),
        MENDPOINT_RELEASE_DISPATCH_RECONCILIATION_PRINCIPAL_ID: "operator-a",
      };
      expect(() => runReleaseDispatchReconciliationCommand({
        argv: base.map((value) => value === "operator-a" ? "release-service-a" : value),
        env: {
          ...boundEnv,
          MENDPOINT_RELEASE_DISPATCH_RECONCILIATION_PRINCIPAL_ID: "release-service-a",
        },
        db,
        store,
        mutationFenceRoot,
      })).toThrow("release_dispatch_reconciliation_authority_binding_required");
      expect(() => runReleaseDispatchReconciliationCommand({
        argv: base.map((value) => value === "operator-a" ? "missing-operator" : value),
        env: {
          ...boundEnv,
          MENDPOINT_RELEASE_DISPATCH_RECONCILIATION_PRINCIPAL_ID: "missing-operator",
        },
        db,
        store,
        mutationFenceRoot,
      })).toThrow("release_dispatch_reconciliation_authority_invalid");
      expect(() => runReleaseDispatchReconciliationCommand({
        argv: base.map((value) => value === failed.failedAt ? NOW : value),
        env: {
          MENDPOINT_RELEASE_DISPATCH_CONSUMERS_JSON: JSON.stringify([{
            contractVersion: "catalog.release-dispatch.v1",
            tenantId: "tenant-a",
            actorPrincipalId: "release-service-a",
          }]),
          MENDPOINT_RELEASE_DISPATCH_RECONCILIATION_PRINCIPAL_ID: "operator-a",
        },
        db,
        store,
        mutationFenceRoot,
      })).toThrow("release_dispatch_reconciliation_evidence_unreachable");
    } finally {
      store.close();
      db.raw.close();
    }
  });

  it("requires reachable tenant-bound evidence and rejects digest-only or cross-tenant claims", () => {
    const value = fixture();
    try {
      expect(() => runReleaseDispatchReconciliationCommand(commandInput(value, {
        evidenceSha256: "c".repeat(64),
      }))).toThrow("release_dispatch_reconciliation_evidence_unreachable");

      value.db.raw.prepare(`INSERT INTO tenants
        (id, slug, name, plan, billing_status, seat_limit, created_at)
        VALUES ('tenant-b', 'tenant-b', 'Tenant B', 'team', 'active', 10, ?)`)
        .run("2026-08-27T14:00:00.000Z");
      insertArtifactManifest(value.db, {
        id: "cross-tenant-reconciliation-artifact",
        tenantId: "tenant-b",
        kind: "release_dispatch_reconciliation",
        schemaVersion: 1,
        sha256: "c".repeat(64),
        mediaType: "application/json",
        sizeBytes: 1,
        storageRef: "evidence://cross-tenant",
        createdAt: "2026-08-27T15:00:00.500Z",
      });
      insertEvidenceRecord(value.db, {
        id: "cross-tenant-reconciliation-evidence",
        tenantId: "tenant-b",
        subjectType: "release_dispatch_reconciliation",
        subjectId: value.failed.id,
        artifactId: "cross-tenant-reconciliation-artifact",
        tool: "operator-review",
        verdict: "passed",
        createdAt: "2026-08-27T15:00:00.500Z",
      });
      expect(() => runReleaseDispatchReconciliationCommand(commandInput(value, {
        evidenceSha256: "c".repeat(64),
        idempotencyKey: "operator:ack:cross-tenant",
      }))).toThrow("release_dispatch_reconciliation_evidence_unreachable");
    } finally {
      value.store.close();
      value.db.raw.close();
    }
  });

  it("holds the mutation fence and requires a current owner or admin authority", () => {
    const fenced = fixture();
    try {
      mkdirSync(fenced.mutationFenceRoot, { recursive: true });
      writeFileSync(join(fenced.mutationFenceRoot, "exclusive.json"), "{}\n");
      expect(() => runReleaseDispatchReconciliationCommand(commandInput(fenced)))
        .toThrow("release_dispatch_reconciliation_mutation_fence_unavailable");
      expect(listReleaseDispatchReconciliations(fenced.store, "tenant-a", fenced.failed.id)).toEqual([]);
    } finally {
      fenced.store.close();
      fenced.db.raw.close();
    }

    const engineer = fixture();
    try {
      engineer.db.raw.prepare(`UPDATE tenant_memberships SET role = 'engineer'
        WHERE tenant_id = 'tenant-a' AND issuer = ? AND subject = ?`).run(OIDC_ISSUER, OIDC_SUBJECT);
      expect(() => runReleaseDispatchReconciliationCommand(commandInput(engineer)))
        .toThrow("release_dispatch_reconciliation_authority_invalid");
      expect(listReleaseDispatchReconciliations(engineer.store, "tenant-a", engineer.failed.id)).toEqual([]);
    } finally {
      engineer.store.close();
      engineer.db.raw.close();
    }
  });

  it("binds a human principal to the exact OIDC issuer and raw subject", () => {
    const value = fixture();
    try {
      value.db.raw.prepare(`UPDATE tenant_memberships SET role = 'engineer'
        WHERE tenant_id = 'tenant-a' AND issuer = ? AND subject = ?`).run(OIDC_ISSUER, OIDC_SUBJECT);
      createTenantMembership(value.db, {
        tenantId: "tenant-a",
        issuer: "https://hostile-identity.example.test",
        subject: OIDC_SUBJECT,
        email: "hostile@example.test",
        displayName: "Hostile same subject",
        role: "owner",
        createdAt: "2026-08-27T15:00:01.600Z",
      });

      expect(() => runReleaseDispatchReconciliationCommand(commandInput(value)))
        .toThrow("release_dispatch_reconciliation_authority_invalid");
      expect(listReleaseDispatchReconciliations(value.store, "tenant-a", value.failed.id)).toEqual([]);
    } finally {
      value.store.close();
      value.db.raw.close();
    }
  });

  it("rejects old or incompletely bound reconciliation evidence", () => {
    const cases = [
      { sql: "UPDATE evidence_records SET command = NULL WHERE id = 'reconciliation-evidence-1'" },
      { sql: `UPDATE evidence_records SET command = replace(command,
        '"action":"acknowledge"', '"action":"requeue"')
        WHERE id = 'reconciliation-evidence-1'` },
      { sql: "UPDATE evidence_records SET producer_principal_id = NULL WHERE id = 'reconciliation-evidence-1'" },
      { sql: "UPDATE artifact_manifests SET producer_principal_id = NULL WHERE id = 'reconciliation-artifact-1'" },
      { sql: "UPDATE artifact_manifests SET kind = 'other-kind' WHERE id = 'reconciliation-artifact-1'" },
      { sql: "UPDATE evidence_records SET created_at = '2026-08-27T15:00:00.500Z' WHERE id = 'reconciliation-evidence-1'" },
      { sql: "UPDATE artifact_manifests SET created_at = '2026-08-27T15:00:00.500Z' WHERE id = 'reconciliation-artifact-1'" },
    ] as const;
    for (const [index, hostile] of cases.entries()) {
      const value = fixture();
      try {
        value.db.raw.exec(`DROP TRIGGER IF EXISTS evidence_records_append_only_update;
          DROP TRIGGER IF EXISTS artifact_manifests_append_only_update;`);
        value.db.raw.prepare(hostile.sql).run();
        expect(() => runReleaseDispatchReconciliationCommand(commandInput(value, {
          idempotencyKey: `operator:ack:hostile-binding:${index}`,
        }))).toThrow("release_dispatch_reconciliation_evidence_unreachable");
        expect(listReleaseDispatchReconciliations(value.store, "tenant-a", value.failed.id)).toEqual([]);
      } finally {
        value.store.close();
        value.db.raw.close();
      }
    }
  });

  it("rolls back both databases when authority expires before mutation completion", () => {
    const value = fixture({ expiresAt: "2026-08-27T15:00:02.000Z" });
    let reads = 0;
    value.setClockRead(() => ++reads < 3
      ? "2026-08-27T15:00:01.750Z"
      : "2026-08-27T15:00:03.000Z");
    try {
      expect(() => runReleaseDispatchReconciliationCommand(commandInput(value)))
        .toThrow("release_dispatch_reconciliation_authority_invalid");
      expect(listReleaseDispatchReconciliations(value.store, "tenant-a", value.failed.id)).toEqual([]);
    } finally {
      value.store.close();
      value.db.raw.close();
    }
  });

  it("does not let a wall-clock rollback resurrect authority after the durable watermark crosses expiry", () => {
    const value = fixture({ expiresAt: "2026-08-27T15:00:02.000Z" });
    const reads = [
      "2026-08-27T15:00:01.750Z",
      "2026-08-27T15:00:03.000Z",
      "2026-08-27T15:00:01.750Z",
    ];
    value.setClockRead(() => reads.shift() ?? "2026-08-27T15:00:01.750Z");
    try {
      expect(() => runReleaseDispatchReconciliationCommand(commandInput(value)))
        .toThrow("release_store_clock_rollback");
      expect(listReleaseDispatchReconciliations(value.store, "tenant-a", value.failed.id)).toEqual([]);
    } finally {
      value.store.close();
      value.db.raw.close();
    }
  });

  it("holds one mutation fence across both store opens, reconciliation, and close", () => {
    const value = fixture();
    const seenWriterCounts: number[] = [];
    const input = commandInput(value, { idempotencyKey: "operator:ack:fence-span" });
    const result = runReleaseDispatchReconciliationProcess({
      argv: input.argv,
      env: input.env,
      mutationFenceRoot: value.mutationFenceRoot,
      openDb: () => {
        seenWriterCounts.push(inspectMutationFence(value.mutationFenceRoot).writers.length);
        return value.db;
      },
      openStore: () => {
        seenWriterCounts.push(inspectMutationFence(value.mutationFenceRoot).writers.length);
        return value.store;
      },
      write: () => {
        seenWriterCounts.push(inspectMutationFence(value.mutationFenceRoot).writers.length);
      },
    });
    expect(result).toMatchObject({ dispatchId: value.failed.id, action: "acknowledge" });
    expect(seenWriterCounts).toEqual([1, 1, 1]);
    expect(inspectMutationFence(value.mutationFenceRoot).writers).toEqual([]);
    expect(() => value.db.raw.prepare("SELECT 1")).toThrow();
    expect(() => value.store.raw.prepare("SELECT 1")).toThrow();
  });

  it("closes a partially opened app store before releasing the mutation fence", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-release-reconcile-partial-open-"));
    directories.push(directory);
    const mutationFenceRoot = join(directory, "mutation-fence");
    const db = createDb(join(directory, "app.sqlite"));
    expect(() => runReleaseDispatchReconciliationProcess({
      argv: [],
      env: {},
      mutationFenceRoot,
      openDb: () => db,
      openStore: () => {
        expect(inspectMutationFence(mutationFenceRoot).writers).toHaveLength(1);
        throw new Error("release_store_open_failed");
      },
    })).toThrow("release_store_open_failed");
    expect(inspectMutationFence(mutationFenceRoot).writers).toEqual([]);
    expect(() => db.raw.prepare("SELECT 1")).toThrow();
  });
});
