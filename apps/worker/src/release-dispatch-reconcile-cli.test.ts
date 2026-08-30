import { mkdtempSync, rmSync } from "node:fs";
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
import { createDb, getPrincipal, insertPrincipal } from "@mendpoint/db";
import { runReleaseDispatchReconciliationCommand } from "./release-dispatch-reconcile-cli.js";

const NOW = "2026-08-27T15:00:00.000Z";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-release-reconcile-cli-"));
  directories.push(directory);
  let clock = NOW;
  const store = openReleaseIngestionStore(join(directory, "release.sqlite"), { clock: () => clock });
  const db = createDb(join(directory, "app.sqlite"));
  db.raw.prepare(`INSERT INTO tenants
    (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?)`)
    .run("2026-08-27T14:00:00.000Z");
  insertPrincipal(db, {
    id: "operator-a",
    tenantId: "tenant-a",
    kind: "human",
    subject: "operator@example.test",
    displayName: "Release operator",
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
  return { directory, db, store, failed };
}

describe("release dispatch reconciliation command", () => {
  it("uses the exact tenant consumer authority and emits identifiers only", () => {
    const { db, store, failed } = fixture();
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
        write: (value) => output.push(value),
      });
      expect(result).toMatchObject({ dispatchId: failed.id, action: "requeue" });
      expect(output).toEqual([JSON.stringify(result)]);
      expect(output[0]).not.toContain("invalid_payload");
      expect(output[0]).not.toContain("aaaaaaaa");
      expect(getPrincipal(db, "tenant-a", "operator-a")).toMatchObject({
        kind: "human", subject: "operator@example.test",
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
    const { db, store, failed } = fixture();
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
      })).toThrow("release_dispatch_reconciliation_consumer_binding_required");
      expect(() => runReleaseDispatchReconciliationCommand({
        argv: [...base.slice(0, -2), "--tenant", "tenant-a"],
        env: { MENDPOINT_RELEASE_DISPATCH_CONSUMERS_JSON: "[]" },
        db,
        store,
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
      })).toThrow("release_dispatch_reconciliation_authority_binding_required");
      expect(() => runReleaseDispatchReconciliationCommand({
        argv: base.map((value) => value === "operator-a" ? "missing-operator" : value),
        env: {
          ...boundEnv,
          MENDPOINT_RELEASE_DISPATCH_RECONCILIATION_PRINCIPAL_ID: "missing-operator",
        },
        db,
        store,
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
      })).toThrow("release_dispatch_reconciliation_stale_failure");
    } finally {
      store.close();
      db.raw.close();
    }
  });
});
