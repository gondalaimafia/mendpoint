import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openReleaseIngestionStore, type ReleaseIngestionStore } from "@mendpoint/catalog";
import { createDb, insertPrincipal, type AppDb } from "@mendpoint/db";
import { pagingEventForWorkerHeartbeat } from "@mendpoint/notify";
import {
  runReleaseDispatchRuntimeCycle,
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
    subject: "service:release-dispatch",
    displayName: "Release dispatch",
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
    releaseDispatchExpiredClaims: cycle.expiredClaims,
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
});
