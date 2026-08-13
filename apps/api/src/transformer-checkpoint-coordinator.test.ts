import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type AppDb } from "@mendpoint/db";
import {
  createTransformerCoordinatorClient,
  type TransformerCoordinatorTransport,
} from "@mendpoint/worker/transformer-coordinator-client";
import type { ApiEnv } from "./auth.js";
import {
  createTransformerCheckpointCoordinatorRoutes,
  TransformerCheckpointCoordinatorStore,
} from "./transformer-checkpoint-coordinator.js";

const dbs: AppDb[] = [];
const dirs: string[] = [];
afterEach(() => { while (dbs.length) dbs.pop()?.raw.close(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function digest(value: unknown): string {
  const canonical = JSON.stringify(value, Object.keys(value as object).sort());
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function fixture(now: () => string, authorized = true) {
  const dir = mkdtempSync(join(tmpdir(), "transformer-coordinator-"));
  dirs.push(dir);
  const db = createDb(join(dir, "coordinator.sqlite"));
  dbs.push(db);
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "request-test");
    if (authorized) {
      c.set("principal", { id: "api-key:worker-key", tenantId: "tenant-a", role: "agent" });
      c.set("authScopes", ["transformer:worker"]);
    }
    await next();
  });
  const store = new TransformerCheckpointCoordinatorStore(db, { now });
  app.route("/v1/transformer/checkpoints", createTransformerCheckpointCoordinatorRoutes({ enabled: true, store }));
  const transport: TransformerCoordinatorTransport = {
    request: async (input) => {
      const request = new Request(input.url.replace("https://coordinator.test", "http://local.test"), {
        method: input.method,
        headers: input.headers,
        body: input.body,
        signal: input.signal,
      });
      const response = await app.fetch(request);
      return { status: response.status, body: new Uint8Array(await response.arrayBuffer()) };
    },
  };
  const client = (workerId: string, tenantPrefix = "tenant-") => createTransformerCoordinatorClient({
    enabled: true,
    checkpointMode: "required",
    baseUrl: "https://coordinator.test",
    authToken: "a".repeat(32),
    workerId,
    tenantPrefix,
    timeoutMs: 1_000,
    maxResponseBytes: 100_000,
    maxOperations: 100,
  }, transport);
  return { app, client };
}

describe("Transformer checkpoint coordinator RPC", () => {
  it("fails closed without an authenticated scoped worker", async () => {
    const { client } = fixture(() => "2026-08-12T12:00:00.000Z", false);
    await expect(client("worker-a").readCheckpoint({
      tenantId: "tenant-a", campaignId: "campaign-a", episodeId: "episode-a",
      requestDigest: `sha256:${"a".repeat(64)}`,
    })).rejects.toMatchObject({ code: "coordinator_unauthorized" });
  });

  it("issues server-time fences and rejects another worker before expiry", async () => {
    let now = "2026-08-12T12:00:00.000Z";
    const { client } = fixture(() => now);
    const input = {
      tenantId: "tenant-a", campaignId: "campaign-a", episodeId: "episode-a",
      requestDigest: `sha256:${"a".repeat(64)}`, operationId: "claim-a",
      idempotencyKey: "claim-a", leaseDurationMs: 1_000,
    } as const;
    const first = await client("worker-a").claimCheckpointLease(input);
    expect(first).toMatchObject({ workerId: "worker-a", leaseGeneration: 1, serverTime: now, replayed: false });
    await expect(client("worker-b").claimCheckpointLease({ ...input, operationId: "claim-b", idempotencyKey: "claim-b" }))
      .rejects.toMatchObject({ code: "coordinator_lease_rejected" });

    now = "2026-08-12T12:00:01.001Z";
    const takeover = await client("worker-b").claimCheckpointLease({ ...input, operationId: "claim-b", idempotencyKey: "claim-b" });
    expect(takeover).toMatchObject({ workerId: "worker-b", leaseGeneration: 2, serverTime: now });
  });

  it("performs immutable idempotent CAS behind the current unexpired fence", async () => {
    let now = "2026-08-12T12:00:00.000Z";
    const { client } = fixture(() => now);
    const worker = client("worker-a");
    const base = { tenantId: "tenant-a", campaignId: "campaign-a", episodeId: "episode-a", requestDigest: `sha256:${"a".repeat(64)}` };
    const lease = await worker.claimCheckpointLease({ ...base, operationId: "claim-a", idempotencyKey: "claim-a", leaseDurationMs: 5_000 });
    const checkpoint = { status: "complete", resultArtifact: "artifacts/tenant-a/result" };
    const checkpointDigest = digest(checkpoint);
    const request = {
      ...base, operationId: "cas-a", idempotencyKey: "cas-a", expectedCheckpointDigest: null,
      checkpointDigest, nextCheckpoint: checkpoint, leaseGeneration: lease.leaseGeneration,
    };
    const accepted = await worker.compareAndSwapCheckpoint(request);
    expect(accepted).toMatchObject({ checkpoint, checkpointDigest, serverTime: now, replayed: false });
    expect(await worker.compareAndSwapCheckpoint(request)).toMatchObject({ replayed: true });
    expect(await worker.readCheckpoint(base)).toMatchObject({ checkpoint, checkpointDigest, serverTime: now });

    now = "2026-08-12T12:00:06.000Z";
    await expect(worker.compareAndSwapCheckpoint({ ...request, operationId: "cas-b", idempotencyKey: "cas-b" }))
      .rejects.toMatchObject({ code: "coordinator_lease_rejected" });
  });
});
