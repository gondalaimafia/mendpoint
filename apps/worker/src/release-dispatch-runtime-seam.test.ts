import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ingestReleaseDocument, openReleaseIngestionStore, type ReleaseIngestionStore } from "@mendpoint/catalog";
import { createDb, insertPrincipal, type AppDb } from "@mendpoint/db";
import { pagingEventForWorkerHeartbeat } from "@mendpoint/notify";
import { drainTelemetry, resetTelemetry } from "@mendpoint/ops";
import {
  recordReleaseDispatchRuntimeTelemetry,
  runReleaseDispatchRuntimeCycle,
  runReleaseDispatchServiceIteration,
  writeWorkerHeartbeat,
  type ReleaseDispatchRuntimeCycle,
  type WorkerHeartbeat,
} from "./cli.js";
import {
  RELEASE_DISPATCH_CONTRACT_VERSION,
} from "./release-dispatch-domain-event-sink.js";
import type { ReleaseDispatchConsumer } from "./release-dispatch-drainer.js";

const NOW = "2026-08-27T18:00:00.000Z";
const roots: string[] = [];
const stores: ReleaseIngestionStore[] = [];
const databases: AppDb[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const database of databases.splice(0)) database.raw.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): Readonly<{
  root: string;
  fenceRoot: string;
  store: ReleaseIngestionStore;
  db: AppDb;
  consumer: ReleaseDispatchConsumer;
}> {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-release-runtime-seam-"));
  roots.push(root);
  const store = openReleaseIngestionStore(":memory:", { clock: () => NOW });
  stores.push(store);
  const db = createDb(join(root, "app.sqlite"));
  databases.push(db);
  db.raw.prepare(`INSERT INTO tenants
    (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?)`)
    .run("2026-08-27T17:00:00.000Z");
  insertPrincipal(db, {
    id: "service-release-dispatch",
    tenantId: "tenant-a",
    kind: "service",
    subject: "release-dispatch",
    displayName: "Release dispatch worker",
    createdAt: "2026-08-27T17:00:00.000Z",
  });
  return Object.freeze({
    root,
    fenceRoot: join(root, "mutation-fence"),
    store,
    db,
    consumer: Object.freeze({
      contractVersion: RELEASE_DISPATCH_CONTRACT_VERSION,
      tenantId: "tenant-a",
      actorPrincipalId: "service-release-dispatch",
    }),
  });
}

function heartbeat(cycle: ReleaseDispatchRuntimeCycle): WorkerHeartbeat {
  return {
    ok: true,
    workerId: "worker-release-seam",
    recordedAt: NOW,
    jobs: { claimed: 0, succeeded: 0, failed: 0, retried: 0, inconclusive: 0 },
    feedPollingEnabled: true,
    feedPollOk: true,
    releasePollingConfigured: true,
    releasePollConfigurationCount: 1,
    feedScheduleStatus: "healthy",
    releaseConfigurationStatus: "healthy",
    releaseConfigurationFailed: 0,
    releaseDispatchConfigured: true,
    releaseDispatchConsumerCount: 1,
    releaseDispatchStatus: cycle.status,
    releaseDispatchPending: cycle.pending,
    releaseDispatchClaimed: cycle.claimed,
    releaseDispatchFailed: cycle.failed,
    releaseDispatchDue: cycle.due,
    releaseDispatchExpiredClaims: cycle.expiredClaims,
    releaseDispatchFailureStage: cycle.failureStage,
    releaseDispatchFailureCode: cycle.failureCode,
  };
}

describe("release dispatch runtime fence to heartbeat to paging seam", () => {
  it("degrades under an exclusive fence, pages distinctly, then drains and recovers", () => {
    const value = fixture();
    mkdirSync(value.fenceRoot, { recursive: true });
    const exclusive = join(value.fenceRoot, "exclusive.json");
    writeFileSync(exclusive, "{}\n");

    const blocked = runReleaseDispatchRuntimeCycle({
      store: value.store,
      db: value.db,
      consumers: [value.consumer],
      workerId: "worker-release-seam",
      leaseDurationMs: 30_000,
      maxClaimsPerConsumer: 16,
      mutationFenceRoot: value.fenceRoot,
    });
    expect(blocked).toMatchObject({ fenceAvailable: false, status: "degraded" });

    const heartbeatPath = join(value.root, "heartbeat.json");
    writeWorkerHeartbeat(heartbeatPath, heartbeat(blocked));
    expect(JSON.parse(readFileSync(heartbeatPath, "utf8"))).toMatchObject({
      releaseDispatchConfigured: true,
      releaseDispatchStatus: "degraded",
    });
    expect(pagingEventForWorkerHeartbeat({
      workerId: "worker-release-seam",
      ok: true,
      stale: false,
      releaseDispatchDegraded: blocked.status === "degraded",
      releaseDispatchPending: blocked.pending,
      releaseDispatchClaimed: blocked.claimed,
      releaseDispatchFailed: blocked.failed,
      releaseDispatchDue: blocked.due,
      releaseDispatchExpiredClaims: blocked.expiredClaims,
    })).toMatchObject({ type: "release_dispatch_degraded" });

    unlinkSync(exclusive);
    const recovered = runReleaseDispatchRuntimeCycle({
      store: value.store,
      db: value.db,
      consumers: [value.consumer],
      workerId: "worker-release-seam",
      leaseDurationMs: 30_000,
      maxClaimsPerConsumer: 16,
      mutationFenceRoot: value.fenceRoot,
      previous: blocked,
    });
    expect(recovered).toMatchObject({ fenceAvailable: true, status: "healthy" });
    writeWorkerHeartbeat(heartbeatPath, heartbeat(recovered));
    expect(JSON.parse(readFileSync(heartbeatPath, "utf8"))).toMatchObject({
      releaseDispatchStatus: "healthy",
    });
    expect(pagingEventForWorkerHeartbeat({
      workerId: "worker-release-seam",
      ok: true,
      stale: false,
      releaseDispatchDegraded: false,
    })).toBeNull();
  });

  it("preserves unknown state through the real heartbeat and paging seam", () => {
    const value = fixture();
    value.store.close();
    stores.splice(stores.indexOf(value.store), 1);
    const iteration = runReleaseDispatchServiceIteration({
      store: value.store,
      db: value.db,
      consumers: [value.consumer],
      workerId: "worker-release-seam",
      leaseDurationMs: 30_000,
      maxClaimsPerConsumer: 16,
    });
    expect(iteration.cycle).toBeNull();
    const unknown = iteration.state;
    expect(unknown).toMatchObject({
      failureStage: "claim",
      failureCode: "release_dispatch_claim_unavailable",
    });
    const snapshot = heartbeat({
      fenceAvailable: false,
      backoffRequired: true,
      drained: null,
      ...unknown,
    });
    const heartbeatPath = join(value.root, "heartbeat-unknown.json");
    writeWorkerHeartbeat(heartbeatPath, snapshot);
    expect(JSON.parse(readFileSync(heartbeatPath, "utf8"))).toMatchObject({
      ok: true,
      releaseDispatchStatus: "unknown",
      releaseDispatchPending: null,
      releaseDispatchClaimed: null,
      releaseDispatchFailed: null,
      releaseDispatchDue: null,
      releaseDispatchExpiredClaims: null,
    });
    expect(pagingEventForWorkerHeartbeat({
      workerId: "worker-release-seam",
      ok: false,
      stale: false,
      releaseDispatchDegraded: true,
      releaseDispatchPending: unknown.pending,
      releaseDispatchClaimed: unknown.claimed,
      releaseDispatchFailed: unknown.failed,
      releaseDispatchDue: unknown.due,
      releaseDispatchExpiredClaims: unknown.expiredClaims,
    })).toMatchObject({
      type: "release_dispatch_degraded",
      details: { pending: null, claimed: null, failed: null, due: null, expiredClaims: null },
    });
  });

  it("degrades when the bounded drain leaves overdue work", () => {
    const value = fixture();
    for (const version of ["v1", "v2"]) {
      ingestReleaseDocument(value.store, {
        tenantId: "tenant-a",
        providerSlug: "stripe",
        adapter: "rss",
        sourceUrl: `https://docs.example.test/${version}.xml`,
        body: `<?xml version="1.0"?><rss><channel><item><guid>${version}</guid><title>${version}</title><link>https://docs.example.test/${version}</link><pubDate>Thu, 27 Aug 2026 18:00:00 GMT</pubDate><description>${version}</description></item></channel></rss>`,
        observedAt: NOW,
        now: NOW,
      });
    }

    const cycle = runReleaseDispatchRuntimeCycle({
      store: value.store,
      db: value.db,
      consumers: [value.consumer],
      workerId: "worker-release-seam",
      leaseDurationMs: 30_000,
      maxClaimsPerConsumer: 1,
      mutationFenceRoot: value.fenceRoot,
    });
    expect(cycle).toMatchObject({
      status: "degraded",
      due: 1,
      failureStage: "backlog",
      failureCode: "release_dispatch_overdue",
    });
  });

  it("reports a bounded residual backlog without requesting exponential backoff", () => {
    const value = fixture();
    for (let index = 0; index < 17; index += 1) {
      const version = `bounded-${index}`;
      ingestReleaseDocument(value.store, {
        tenantId: "tenant-a",
        providerSlug: "stripe",
        adapter: "rss",
        sourceUrl: `https://docs.example.test/${version}.xml`,
        body: `<?xml version="1.0"?><rss><channel><item><guid>${version}</guid><title>${version}</title><link>https://docs.example.test/${version}</link><pubDate>Thu, 27 Aug 2026 18:00:00 GMT</pubDate><description>${version}</description></item></channel></rss>`,
        observedAt: NOW,
        now: NOW,
      });
    }

    const cycle = runReleaseDispatchRuntimeCycle({
      store: value.store,
      db: value.db,
      consumers: [value.consumer],
      workerId: "worker-release-seam",
      leaseDurationMs: 30_000,
      maxClaimsPerConsumer: 16,
      mutationFenceRoot: value.fenceRoot,
    });
    expect(cycle).toMatchObject({
      status: "degraded",
      due: 1,
      failureStage: "backlog",
      failureCode: "release_dispatch_overdue",
      backoffRequired: false,
      drained: { claimed: 16, completed: 16 },
    });
  });

  it("replaces a stale fence identity with the current backlog cause", () => {
    const value = fixture();
    for (const version of ["current-a", "current-b"]) {
      ingestReleaseDocument(value.store, {
        tenantId: "tenant-a",
        providerSlug: "stripe",
        adapter: "rss",
        sourceUrl: `https://docs.example.test/${version}.xml`,
        body: `<?xml version="1.0"?><rss><channel><item><guid>${version}</guid><title>${version}</title><link>https://docs.example.test/${version}</link><pubDate>Thu, 27 Aug 2026 18:00:00 GMT</pubDate><description>${version}</description></item></channel></rss>`,
        observedAt: NOW,
        now: NOW,
      });
    }

    const cycle = runReleaseDispatchRuntimeCycle({
      store: value.store,
      db: value.db,
      consumers: [value.consumer],
      workerId: "worker-release-seam",
      leaseDurationMs: 30_000,
      maxClaimsPerConsumer: 1,
      mutationFenceRoot: value.fenceRoot,
      previous: {
        pending: null,
        claimed: null,
        failed: null,
        due: null,
        expiredClaims: null,
        failureStage: "fence",
        failureCode: "release_dispatch_mutation_fence_unavailable",
      },
    });
    expect(cycle).toMatchObject({
      status: "degraded",
      failureStage: "backlog",
      failureCode: "release_dispatch_overdue",
    });
  });

  it("records the same bounded failure identity in telemetry", () => {
    const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://otel.example.test";
    resetTelemetry();
    try {
      recordReleaseDispatchRuntimeTelemetry({
        status: "unknown",
        failureStage: "claim",
        failureCode: "release_dispatch_claim_unavailable",
      });
      expect(drainTelemetry().counters).toEqual([
        expect.objectContaining({
          name: "release_dispatch_cycle_total",
          value: 1,
          attributes: {
            status: "unknown",
            failure_stage: "claim",
            failure_code: "release_dispatch_claim_unavailable",
          },
        }),
      ]);
    } finally {
      resetTelemetry();
      if (previousEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previousEndpoint;
    }
  });
});
