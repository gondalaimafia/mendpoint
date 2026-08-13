import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, type AppDb } from "@mendpoint/db";
import {
  createTransformerCheckpointArtifactStore,
} from "@mendpoint/worker/transformer-checkpoint-artifacts";
import { createTransformerCheckpointProvider } from "@mendpoint/worker/transformer-checkpoint-provider";
import { createTransformerCoordinatorClient, type TransformerCoordinatorTransport } from "@mendpoint/worker/transformer-coordinator-client";
import { createFilesystemTransformerArtifactBackend } from "@mendpoint/worker/transformer-shared-artifact-backends";
import {
  createDeterministicTransformerService,
  transformerTaskRequestDigest,
} from "@mendpoint/worker/transformer-service";
import type { ApiEnv } from "./auth.js";
import { createTransformerCheckpointCoordinatorRoutes, TransformerCheckpointCoordinatorStore } from "./transformer-checkpoint-coordinator.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];
afterEach(() => { while (dbs.length) dbs.pop()?.raw.close(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe("joined multi-node Transformer service", () => {
  it("materializes exact shared source and completes on a second worker after fenced crash takeover", async () => {
    let now = "2026-08-12T12:00:00.000Z";
    const dir = mkdtempSync(join(tmpdir(), "transformer-multinode-"));
    dirs.push(dir);
    const db = createDb(join(dir, "coordinator.sqlite"));
    dbs.push(db);
    const app = new Hono<ApiEnv>();
    app.use("*", async (c, next) => {
      c.set("requestId", "joined-test");
      c.set("principal", { id: "api-key:worker-key", tenantId: "tenant-a", role: "agent" });
      c.set("authScopes", ["transformer:worker"]);
      await next();
    });
    app.route("/v1/transformer/checkpoints", createTransformerCheckpointCoordinatorRoutes({
      enabled: true,
      store: new TransformerCheckpointCoordinatorStore(db, { now: () => now }),
    }));
    const transport: TransformerCoordinatorTransport = { request: async (input) => {
      const response = await app.fetch(new Request(input.url.replace("https://coordinator.test", "http://local.test"), { method: input.method, headers: input.headers, body: input.body, signal: input.signal }));
      return { status: response.status, body: new Uint8Array(await response.arrayBuffer()) };
    } };
    const encryptionKey = new Uint8Array(32).fill(9);
    const backend = () => createFilesystemTransformerArtifactBackend({ root: join(dir, "shared-artifacts"), maxStoredBytes: 8_192 });
    const provider = (workerId: string) => createTransformerCheckpointProvider({
      enabled: true,
      mode: "checkpoint_required",
      coordinator: { enabled: true, checkpointMode: "required", baseUrl: "https://coordinator.test", authToken: "a".repeat(32), workerId, tenantPrefix: "tenant-", timeoutMs: 1_000, maxResponseBytes: 8_192, maxOperations: 100 },
      artifacts: { enabled: true, tenantPrefix: "tenant-", storagePrefix: "transformer", encryptionKey, maxArtifactBytes: 4_096, maxReadBytes: 8_192, maxOperations: 100 },
    }, { coordinatorTransport: transport, artifactBackend: backend() });
    const sourceStore = createTransformerCheckpointArtifactStore({ enabled: true, tenantPrefix: "tenant-", storagePrefix: "transformer", encryptionKey, maxArtifactBytes: 4_096, maxReadBytes: 8_192, maxOperations: 100 }, backend());
    const sourceBytes = new TextEncoder().encode("exact legacy source\n");
    const source = await sourceStore.publishImmutable({ tenantId: "tenant-a", artifactKey: "sources/revision-a", bytes: sourceBytes });
    const taskBase = { tenantId: "tenant-a", campaignId: "campaign-a", episodeId: "episode-a", operation: "uppercase-v1", source: { storageKey: source.storageKey, digest: source.digest } } as const;
    const task = { ...taskBase, requestDigest: transformerTaskRequestDigest(taskBase) };

    const crashing = vi.fn(async () => { throw new Error("worker_crashed"); });
    const first = createDeterministicTransformerService({ enabled: true, mode: "checkpoint_required", workerId: "worker-a", leaseDurationMs: 1_000 }, provider("worker-a"), crashing);
    await expect(first.run(task)).rejects.toThrow("worker_crashed");
    expect(crashing).toHaveBeenCalledOnce();
    await expect(createDeterministicTransformerService({ enabled: true, mode: "checkpoint_required", workerId: "worker-b", leaseDurationMs: 1_000 }, provider("worker-b"), async (bytes) => bytes).run(task))
      .rejects.toMatchObject({ code: "coordinator_lease_rejected" });

    now = "2026-08-12T12:00:01.001Z";
    const execute = vi.fn(async (bytes: Uint8Array) => new TextEncoder().encode(new TextDecoder().decode(bytes).toUpperCase()));
    const second = createDeterministicTransformerService({ enabled: true, mode: "checkpoint_required", workerId: "worker-b", leaseDurationMs: 1_000 }, provider("worker-b"), execute);
    const completed = await second.run(task);
    expect(completed).toMatchObject({ status: "completed", workerId: "worker-b", leaseGeneration: 2, sourceDigest: source.digest });
    expect(new TextDecoder().decode(await sourceStore.read({ tenantId: "tenant-a", storageKey: completed.resultArtifact.storageKey }))).toBe("EXACT LEGACY SOURCE\n");

    const replay = await createDeterministicTransformerService({ enabled: true, mode: "checkpoint_required", workerId: "worker-a", leaseDurationMs: 1_000 }, provider("worker-a"), async () => { throw new Error("must_not_execute"); }).run(task);
    expect(replay).toMatchObject({ status: "completed", replayed: true, resultArtifact: completed.resultArtifact });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("fails closed when service or checkpoint mode is not explicitly enabled", () => {
    const coordinator = createTransformerCoordinatorClient as unknown;
    expect(() => createDeterministicTransformerService({ enabled: false, mode: "checkpoint_required", workerId: "worker-a", leaseDurationMs: 1_000 }, coordinator as never, async (bytes) => bytes)).toThrow("transformer_service_disabled");
    expect(() => createDeterministicTransformerService({ enabled: true, mode: "legacy" as never, workerId: "worker-a", leaseDurationMs: 1_000 }, coordinator as never, async (bytes) => bytes)).toThrow("transformer_service_mode_invalid");
  });
});
