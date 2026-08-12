import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchTransformerMultinodeTransport, createTransformerMultinodeService, type TransformerMultinodeTransport } from "./transformer-multinode-service.js";
import type { TransformerCheckpointArtifactBackend } from "./transformer-checkpoint-artifacts.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const backend: TransformerCheckpointArtifactBackend = Object.freeze({ async createOnly() { return "created"; }, async read() { return null; }, async mark() {} });
const gate = JSON.stringify({ schemaVersion: "2026-08-02.v1", tenantAllowlist: ["tenant-a"], environmentAllowlist: ["test"], grants: [{ tenantId: "tenant-a", environment: "test", boundaries: ["api_control_plane", "worker_action", "delivery", "ui"], acceptanceEvidenceRefs: ["acceptance:transformer-pilot:v1"], productionDeliveryApprovalRefs: [] }] });
const base = { enabled: true, mode: "checkpoint_required" as const, workerId: "worker-a", tenantId: "tenant-a", campaignId: "campaign-a", environment: "test", evidenceRoot: "C:\\evidence", candidateRoot: "C:\\candidate", leaseDurationMs: 60_000, executorDigest: `sha256:${"e".repeat(64)}`, encryptionKey: new Uint8Array(32).fill(1), operationSecret: new Uint8Array(32).fill(2), evidenceRefs: ["evidence:runner"], gateConfig: gate };

describe("Transformer multi-node service", () => {
  it("is default off and snapshots stable replay identity across coordinator clock changes", async () => {
    expect(() => createTransformerMultinodeService({ ...base, enabled: false }, { request: async () => ({}) }, backend)).toThrow("transformer_multinode_service_disabled");
    const claims: unknown[] = [];
    let claimAttempts = 0;
    let tick = 0;
    const transport: TransformerMultinodeTransport = { request: async ({ path, body }) => {
      tick += 1;
      if (path.endsWith("claimNextAttempt")) { claims.push(body); claimAttempts += 1; if (claimAttempts === 1) throw new Error("response_lost"); }
      return { result: path.endsWith("claimNextAttempt") ? null : { ready: true }, serverTime: new Date(Date.UTC(2026, 7, 12, 12, 0, tick)).toISOString() };
    } };
    const service = createTransformerMultinodeService(base, transport, backend);
    await service.runOnce().catch(() => undefined);
    await service.runOnce();
    expect((claims[0] as { idempotencyKey: string }).idempotencyKey).toBe((claims[1] as { idempotencyKey: string }).idempotencyKey);
  });

  it("hard-times out and honors caller abort with a noncooperative fetch", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    const transport = createFetchTransformerMultinodeTransport({ baseUrl: "https://coordinator.example/", authToken: "x".repeat(32), workerId: "worker-a", timeoutMs: 25, maxResponseBytes: 1024 });
    const timed = transport.request({ path: "/readyz", body: {} });
    const timedAssertion = expect(timed).rejects.toThrow("transformer_multinode_timeout");
    await vi.advanceTimersByTimeAsync(25);
    await timedAssertion;
    const controller = new AbortController();
    const aborted = transport.request({ path: "/readyz", body: {}, signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toThrow("transformer_multinode_aborted");
  });

  it("snapshots validated nested secrets and transport callables", async () => {
    const mutable = { ...base, encryptionKey: new Uint8Array(base.encryptionKey), operationSecret: new Uint8Array(base.operationSecret), evidenceRefs: [...base.evidenceRefs] };
    let requests = 0;
    const transport = { request: async ({ path }: { path: string }) => { requests += 1; return { result: path.endsWith("claimNextAttempt") ? null : { ready: true }, serverTime: "2026-08-12T12:00:00.000Z" }; } };
    const service = createTransformerMultinodeService(mutable, transport, backend);
    mutable.operationSecret.fill(9); mutable.encryptionKey.fill(9); mutable.evidenceRefs[0] = "mutated";
    transport.request = async () => { throw new Error("mutated_transport"); };
    await expect(service.runOnce()).resolves.toMatchObject({ status: "idle" });
    expect(requests).toBeGreaterThan(0);
  });
});
