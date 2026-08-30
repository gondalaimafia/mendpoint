import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ingestReleaseDocument,
  listReleaseDispatches,
  openReleaseIngestionStore,
  type ReleaseIngestionStore,
} from "@mendpoint/catalog";
import {
  createDb,
  getPrincipal,
  insertPrincipal,
  listDomainEvents,
  type AppDb,
} from "@mendpoint/db";
import {
  RELEASE_DISPATCH_CONSUMER_CONFIGURATIONS_ENV,
  drainReleaseDispatchesOnce,
  parseReleaseDispatchConsumersFromEnv,
  type ReleaseDispatchConsumer,
} from "./release-dispatch-drainer.js";
import {
  RELEASE_DISPATCH_CONTRACT_VERSION,
  RELEASE_DISPATCH_SINK_FAILURE_CODES,
  acceptReleaseDispatchDomainEvent,
} from "./release-dispatch-domain-event-sink.js";

const NOW = "2026-08-27T15:00:00.000Z";
const BEFORE = "2026-08-27T14:00:00.000Z";
const rss = readFileSync(
  new URL("../../../packages/catalog/fixtures/releases/stripe-rss.xml", import.meta.url),
  "utf8",
);
const stores: ReleaseIngestionStore[] = [];
const databases: AppDb[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const db of databases.splice(0)) db.raw.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function store(clock: () => string = () => NOW): ReleaseIngestionStore {
  const value = openReleaseIngestionStore(":memory:", { clock });
  stores.push(value);
  return value;
}

function db(): AppDb {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-release-drainer-"));
  directories.push(directory);
  const value = createDb(join(directory, "app.sqlite"));
  databases.push(value);
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    value.raw.prepare(`INSERT INTO tenants
      (id, slug, name, plan, billing_status, seat_limit, created_at)
      VALUES (?, ?, ?, 'team', 'active', 10, ?)`)
      .run(tenantId, tenantId, tenantId, BEFORE);
  }
  return value;
}

function addPrincipal(database: AppDb, input: Readonly<{
  tenantId: string;
  id: string;
  kind?: "human" | "service";
  createdAt?: string;
  revokedAt?: string | null;
  expiresAt?: string | null;
}>): void {
  insertPrincipal(database, {
    id: input.id,
    tenantId: input.tenantId,
    kind: input.kind ?? "service",
    subject: "release-dispatch",
    displayName: "Release dispatch worker",
    createdAt: input.createdAt ?? BEFORE,
    revokedAt: input.revokedAt,
    expiresAt: input.expiresAt,
  });
}

function consumer(tenantId: string, actorPrincipalId: string): ReleaseDispatchConsumer {
  return Object.freeze({
    contractVersion: RELEASE_DISPATCH_CONTRACT_VERSION,
    tenantId,
    actorPrincipalId,
  });
}

function ingest(value: ReleaseIngestionStore, tenantId: string, variant = "a"): void {
  const body = variant === "a" ? rss : rss
    .replaceAll("charges-2026-08-01", `charges-2026-08-01-${variant}`)
    .replace("Use amount.", `Use amount. Variant ${variant}.`);
  ingestReleaseDocument(value, {
    tenantId,
    providerSlug: "stripe",
    adapter: "rss",
    sourceUrl: "https://docs.stripe.com/changelog/feed",
    body,
    observedAt: NOW,
    now: NOW,
  });
}

function run(input: Readonly<{
  store: ReleaseIngestionStore;
  db: AppDb;
  consumers: readonly ReleaseDispatchConsumer[];
  maxClaimsPerConsumer?: number;
  now?: () => string;
  sink?: typeof acceptReleaseDispatchDomainEvent;
  shouldContinue?: () => boolean;
}>) {
  return drainReleaseDispatchesOnce({
    ...input,
    workerId: "release-worker-a",
    leaseDurationMs: 1_000,
    maxClaimsPerConsumer: input.maxClaimsPerConsumer ?? 10,
  });
}

describe("release dispatch drainer", () => {
  it("parses a frozen exact-key configuration and rejects duplicates, extras, and oversized lists", () => {
    const parsed = parseReleaseDispatchConsumersFromEnv({
      [RELEASE_DISPATCH_CONSUMER_CONFIGURATIONS_ENV]: JSON.stringify([
        consumer("tenant-a", "release-service-a"),
      ]),
    });
    expect(parsed).toEqual([consumer("tenant-a", "release-service-a")]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0])).toBe(true);
    expect(() => parseReleaseDispatchConsumersFromEnv({
      [RELEASE_DISPATCH_CONSUMER_CONFIGURATIONS_ENV]: "[]",
    })).toThrow("release_dispatch_consumers_invalid");
    expect(() => parseReleaseDispatchConsumersFromEnv({
      [RELEASE_DISPATCH_CONSUMER_CONFIGURATIONS_ENV]: JSON.stringify([
        consumer("tenant-a", "one"), consumer("tenant-a", "two"),
      ]),
    })).toThrow("release_dispatch_consumers_invalid");
    expect(() => parseReleaseDispatchConsumersFromEnv({
      [RELEASE_DISPATCH_CONSUMER_CONFIGURATIONS_ENV]: JSON.stringify([
        { ...consumer("tenant-a", "one"), enabled: true },
      ]),
    })).toThrow("release_dispatch_consumers_invalid");
    expect(() => parseReleaseDispatchConsumersFromEnv({
      [RELEASE_DISPATCH_CONSUMER_CONFIGURATIONS_ENV]: JSON.stringify(
        Array.from({ length: 501 }, (_, index) => consumer(`tenant-${index}`, `service-${index}`)),
      ),
    })).toThrow("release_dispatch_consumers_invalid");
  });

  it.each([
    ["human", { kind: "human" as const }],
    ["revoked", { revokedAt: NOW }],
    ["expired", { expiresAt: NOW }],
  ])("reports an empty-backlog %s principal as a configuration failure without claiming", (_label, attributes) => {
    const releaseStore = store();
    const appDb = db();
    if (attributes) addPrincipal(appDb, { tenantId: "tenant-a", id: "release-service-a", ...attributes });
    const summary = run({
      store: releaseStore,
      db: appDb,
      consumers: [consumer("tenant-a", "release-service-a")],
      now: () => NOW,
    });
    expect(summary).toEqual({
      configured: 1,
      configurationFailed: 1,
      claimed: 0,
      completed: 0,
      failed: 0,
      retried: 0,
      exhausted: 0,
    });
  });

  it("provisions a missing empty-backlog service principal without claiming", () => {
    const releaseStore = store();
    const appDb = db();
    expect(run({
      store: releaseStore,
      db: appDb,
      consumers: [consumer("tenant-a", "release-service-a")],
      now: () => NOW,
    })).toEqual({
      configured: 1,
      configurationFailed: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
      retried: 0,
      exhausted: 0,
    });
    expect(getPrincipal(appDb, "tenant-a", "release-service-a")).toMatchObject({
      kind: "service",
      subject: "release-dispatch",
      display_name: "Release dispatch worker",
    });
  });

  it("drains a bounded count per tenant without crossing tenant state", () => {
    const releaseStore = store();
    const appDb = db();
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      ingest(releaseStore, tenantId, "a");
      ingest(releaseStore, tenantId, "b");
      addPrincipal(appDb, { tenantId, id: `release-service-${tenantId}` });
    }
    const summary = run({
      store: releaseStore,
      db: appDb,
      consumers: [
        consumer("tenant-a", "release-service-tenant-a"),
        consumer("tenant-b", "release-service-tenant-b"),
      ],
      maxClaimsPerConsumer: 1,
    });
    expect(summary).toEqual({
      configured: 2,
      configurationFailed: 0,
      claimed: 2,
      completed: 2,
      failed: 0,
      retried: 0,
      exhausted: 0,
    });
    expect(listReleaseDispatches(releaseStore, "tenant-a").map((item) => item.status).sort())
      .toEqual(["completed", "pending"]);
    expect(listReleaseDispatches(releaseStore, "tenant-b").map((item) => item.status).sort())
      .toEqual(["completed", "pending"]);
    expect(listDomainEvents(appDb, "tenant-a")).toHaveLength(1);
    expect(listDomainEvents(appDb, "tenant-b")).toHaveLength(1);
  });

  it("accepts a previously appended event after a crash and completes without duplicate work", () => {
    const releaseStore = store();
    const appDb = db();
    ingest(releaseStore, "tenant-a");
    addPrincipal(appDb, { tenantId: "tenant-a", id: "release-service-a" });
    const dispatch = listReleaseDispatches(releaseStore, "tenant-a")[0]!;
    acceptReleaseDispatchDomainEvent({
      db: appDb,
      actorPrincipalId: "release-service-a",
      envelope: {
        contractVersion: RELEASE_DISPATCH_CONTRACT_VERSION,
        tenantId: "tenant-a",
        dispatchId: dispatch.id,
        artifactId: dispatch.artifactId,
        artifactContentSha256: dispatch.artifactContentSha256,
      },
      observedAt: NOW,
    });
    expect(run({
      store: releaseStore,
      db: appDb,
      consumers: [consumer("tenant-a", "release-service-a")],
    })).toMatchObject({ claimed: 1, completed: 1 });
    expect(listDomainEvents(appDb, "tenant-a")).toHaveLength(1);
    expect(listReleaseDispatches(releaseStore, "tenant-a")[0]).toMatchObject({ status: "completed" });
  });

  it("stops before settlement and safely replays the completed sink after lease expiry", () => {
    let clock = NOW;
    const releaseStore = store(() => clock);
    const appDb = db();
    ingest(releaseStore, "tenant-a");
    addPrincipal(appDb, { tenantId: "tenant-a", id: "release-service-a" });
    let boundaryChecks = 0;
    const interrupted = run({
      store: releaseStore,
      db: appDb,
      consumers: [consumer("tenant-a", "release-service-a")],
      now: () => clock,
      shouldContinue: () => {
        boundaryChecks += 1;
        return boundaryChecks < 4;
      },
    });
    expect(interrupted).toMatchObject({ claimed: 1, completed: 0, failed: 0 });
    expect(listReleaseDispatches(releaseStore, "tenant-a")[0]).toMatchObject({
      status: "claimed",
      claimedAt: NOW,
      leaseGeneration: 1,
    });
    expect(listDomainEvents(appDb, "tenant-a")).toHaveLength(1);

    clock = "2026-08-27T15:00:01.001Z";
    expect(run({
      store: releaseStore,
      db: appDb,
      consumers: [consumer("tenant-a", "release-service-a")],
      now: () => clock,
    })).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(listReleaseDispatches(releaseStore, "tenant-a")[0]).toMatchObject({
      status: "completed",
      leaseGeneration: 2,
    });
    expect(listDomainEvents(appDb, "tenant-a")).toHaveLength(1);
  });

  it("fails a dispatch nonretryably when exact artifact rehydration detects a digest mismatch", () => {
    const releaseStore = store();
    const appDb = db();
    ingest(releaseStore, "tenant-a");
    addPrincipal(appDb, { tenantId: "tenant-a", id: "release-service-a" });
    releaseStore.raw.prepare(
      "UPDATE release_ingestion_dispatches SET artifact_content_sha256 = ? WHERE tenant_id = ?",
    ).run("f".repeat(64), "tenant-a");
    expect(run({
      store: releaseStore,
      db: appDb,
      consumers: [consumer("tenant-a", "release-service-a")],
    })).toMatchObject({ claimed: 1, failed: 1, retried: 0 });
    expect(listReleaseDispatches(releaseStore, "tenant-a")[0]).toMatchObject({
      status: "failed",
      failureCode: RELEASE_DISPATCH_SINK_FAILURE_CODES.validationFailed,
    });
    expect(listDomainEvents(appDb, "tenant-a")).toEqual([]);
  });

  it("records unknown programming failures as terminal fixed-code failures without retry", () => {
    const releaseStore = store();
    const appDb = db();
    ingest(releaseStore, "tenant-a", "a");
    ingest(releaseStore, "tenant-a", "b");
    addPrincipal(appDb, { tenantId: "tenant-a", id: "release-service-a" });
    const dispatches = listReleaseDispatches(releaseStore, "tenant-a");
    releaseStore.raw.prepare("UPDATE release_ingestion_dispatches SET max_attempts = 1 WHERE id = ?")
      .run(dispatches[1]!.id);
    const failingSink = (() => { throw new Error("raw provider credentials and stack"); }) as typeof acceptReleaseDispatchDomainEvent;
    const summary = run({
      store: releaseStore,
      db: appDb,
      consumers: [consumer("tenant-a", "release-service-a")],
      maxClaimsPerConsumer: 2,
      sink: failingSink,
    });
    expect(summary).toMatchObject({ claimed: 2, retried: 0, exhausted: 0, failed: 2 });
    const settled = listReleaseDispatches(releaseStore, "tenant-a");
    expect(settled.map((item) => item.lastFailureCode))
      .toEqual([RELEASE_DISPATCH_SINK_FAILURE_CODES.internalFailure,
        RELEASE_DISPATCH_SINK_FAILURE_CODES.internalFailure]);
    expect(JSON.stringify(settled)).not.toContain("credentials");
  });

  it("revalidates authority at each claim and rejects a principal that expires during the drain", () => {
    const releaseStore = store();
    const appDb = db();
    ingest(releaseStore, "tenant-a");
    addPrincipal(appDb, {
      tenantId: "tenant-a",
      id: "release-service-a",
      expiresAt: "2026-08-27T15:00:00.500Z",
    });
    const times = [NOW, "2026-08-27T15:00:01.000Z"];
    const summary = run({
      store: releaseStore,
      db: appDb,
      consumers: [consumer("tenant-a", "release-service-a")],
      now: () => times.shift() ?? "2026-08-27T15:00:01.000Z",
    });
    expect(summary).toMatchObject({
      configurationFailed: 0,
      claimed: 1,
      failed: 1,
      completed: 0,
    });
    expect(listReleaseDispatches(releaseStore, "tenant-a")[0]).toMatchObject({
      status: "failed",
      failureCode: RELEASE_DISPATCH_SINK_FAILURE_CODES.authorityInvalid,
    });
    expect(listDomainEvents(appDb, "tenant-a")).toEqual([]);
  });

  it("surfaces lease loss instead of reporting a completed or failed dispatch", () => {
    let releaseClock = NOW;
    const releaseStore = store(() => releaseClock);
    const appDb = db();
    ingest(releaseStore, "tenant-a");
    addPrincipal(appDb, { tenantId: "tenant-a", id: "release-service-a" });
    const sink = ((input: Parameters<typeof acceptReleaseDispatchDomainEvent>[0]) => {
      const result = acceptReleaseDispatchDomainEvent(input);
      releaseClock = "2026-08-27T15:00:02.000Z";
      return result;
    }) as typeof acceptReleaseDispatchDomainEvent;
    expect(() => run({
      store: releaseStore,
      db: appDb,
      consumers: [consumer("tenant-a", "release-service-a")],
      sink,
    })).toThrow("release_dispatch_lease_lost");
    expect(listReleaseDispatches(releaseStore, "tenant-a")[0]).toMatchObject({
      status: "claimed",
      attemptCount: 1,
    });
    expect(listDomainEvents(appDb, "tenant-a")).toHaveLength(1);
  });
});
