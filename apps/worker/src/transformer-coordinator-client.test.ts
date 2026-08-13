import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TransformerCoordinatorClientError,
  createTransformerCoordinatorClient,
  type TransformerCoordinatorTransport,
} from "./transformer-coordinator-client.js";

const CHECKPOINT = { generation: 2 };
const CHECKPOINT_DIGEST = digest(CHECKPOINT);
const JSON_BODY = new TextEncoder().encode(JSON.stringify({
  status: "accepted",
  tenantId: "tenant-a",
  campaignId: "campaign-1",
  episodeId: "episode-1",
  operationId: "op-1",
  requestDigest: `sha256:${"a".repeat(64)}`,
  checkpointDigest: CHECKPOINT_DIGEST,
  replayed: false,
  checkpoint: CHECKPOINT,
}));

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function readInput() {
  return { tenantId: "tenant-a", campaignId: "campaign-1", episodeId: "episode-1", requestDigest: `sha256:${"a".repeat(64)}` } as const;
}

function casInput(overrides: Record<string, unknown> = {}) {
  return { tenantId: "tenant-a", campaignId: "campaign-1", episodeId: "episode-1", operationId: "op-1", idempotencyKey: "idem-1", requestDigest: `sha256:${"a".repeat(64)}`, expectedCheckpointDigest: `sha256:${"b".repeat(64)}`, checkpointDigest: CHECKPOINT_DIGEST, leaseGeneration: 1, nextCheckpoint: CHECKPOINT, ...overrides } as const;
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    checkpointMode: "required",
    baseUrl: "https://coordinator.internal",
    authToken: "secret-token-at-least-32-characters",
    workerId: "worker-a",
    tenantPrefix: "tenant-",
    timeoutMs: 100,
    maxResponseBytes: 8_192,
    maxOperations: 10,
    ...overrides,
  } as const;
}

function transport(handler: TransformerCoordinatorTransport["request"]): TransformerCoordinatorTransport {
  return { request: handler };
}

function errorCode(run: () => Promise<unknown>, code: string) {
  return expect(run()).rejects.toMatchObject({ code });
}

describe("Transformer coordinator client", () => {
  it("fails closed unless explicitly enabled with checkpoint-only complete configuration", () => {
    const noop = transport(async () => ({ status: 200, body: JSON_BODY }));
    expect(() => createTransformerCoordinatorClient(config({ enabled: false }), noop)).toThrowError(expect.objectContaining({ code: "coordinator_disabled" }));
    expect(() => createTransformerCoordinatorClient(config({ authToken: "" }), noop)).toThrowError(expect.objectContaining({ code: "coordinator_config_invalid" }));
    expect(() => createTransformerCoordinatorClient(config({ checkpointMode: "optional" }), noop)).toThrowError(expect.objectContaining({ code: "coordinator_checkpoint_required" }));
    expect(() => createTransformerCoordinatorClient({ ...config(), allowLegacyCompletion: true } as never, noop)).toThrowError(expect.objectContaining({ code: "coordinator_config_invalid" }));
  });

  it("authenticates checkpoint operations and accepts exact idempotent replay", async () => {
    const calls: Array<{ url: string; headers: Readonly<Record<string, string>>; body?: Uint8Array }> = [];
    const shared = new Map<string, Uint8Array>();
    const adapter = transport(async (request) => {
      calls.push(request);
      const parsed = JSON.parse(new TextDecoder().decode(request.body)) as { idempotencyKey: string; requestDigest: string; checkpointDigest: string; tenantId: string; campaignId: string; episodeId: string; operationId: string };
      const prior = shared.get(parsed.idempotencyKey);
      if (prior && new TextDecoder().decode(prior) !== new TextDecoder().decode(request.body)) return { status: 409, body: new Uint8Array() };
      shared.set(parsed.idempotencyKey, request.body!);
      return {
        status: 200,
        body: new TextEncoder().encode(JSON.stringify({ status: "accepted", tenantId: parsed.tenantId, campaignId: parsed.campaignId, episodeId: parsed.episodeId, operationId: parsed.operationId, requestDigest: parsed.requestDigest, checkpointDigest: parsed.checkpointDigest, replayed: prior !== undefined, checkpoint: CHECKPOINT })),
      };
    });
    const firstWorker = createTransformerCoordinatorClient(config({ workerId: "worker-a" }), adapter);
    const secondWorker = createTransformerCoordinatorClient(config({ workerId: "worker-b" }), adapter);
    const input = casInput();

    expect(await firstWorker.compareAndSwapCheckpoint(input)).toMatchObject({ replayed: false });
    expect(await secondWorker.compareAndSwapCheckpoint(input)).toMatchObject({ replayed: true, checkpoint: { generation: 2 } });
    expect(calls[0]?.url).toBe("https://coordinator.internal/v1/transformer/checkpoints/compare-and-swap");
    expect(calls[0]?.headers).toMatchObject({ authorization: `Bearer ${config().authToken}`, "x-mendpoint-worker-id": "worker-a", "x-idempotency-key": "idem-1" });
  });

  it("maps coordinator errors, timeout, and caller abort deterministically", async () => {
    for (const [status, code] of [[401, "coordinator_unauthorized"], [403, "coordinator_scope_denied"], [409, "coordinator_conflict"], [412, "coordinator_lease_rejected"], [429, "coordinator_rate_limited"], [503, "coordinator_unavailable"]] as const) {
      const client = createTransformerCoordinatorClient(config(), transport(async () => ({ status, body: new Uint8Array() })));
      await errorCode(() => client.compareAndSwapCheckpoint(casInput({ expectedCheckpointDigest: null })), code);
    }
    const waiting = transport((request) => new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })));
    await errorCode(() => createTransformerCoordinatorClient(config({ timeoutMs: 5 }), waiting).readCheckpoint(readInput()), "coordinator_timeout");
    const controller = new AbortController();
    controller.abort("cancelled");
    await errorCode(() => createTransformerCoordinatorClient(config(), waiting).readCheckpoint({ ...readInput(), signal: controller.signal }), "coordinator_aborted");

    const nonCooperative = transport(async () => new Promise(() => undefined));
    await errorCode(() => createTransformerCoordinatorClient(config({ timeoutMs: 5 }), nonCooperative).readCheckpoint(readInput()), "coordinator_timeout");
    const laterAbort = new AbortController();
    const aborted = createTransformerCoordinatorClient(config(), nonCooperative).readCheckpoint({ ...readInput(), signal: laterAbort.signal });
    laterAbort.abort("cancelled");
    await errorCode(() => aborted, "coordinator_aborted");
  });

  it("snapshots validated configuration and the transport callable", async () => {
    const mutable = { ...config() };
    const calls: string[] = [];
    const mutableTransport = {
      request: async (request: Parameters<TransformerCoordinatorTransport["request"]>[0]) => {
        calls.push(request.headers.authorization ?? "");
        return { status: 404, body: new Uint8Array() };
      },
    };
    const client = createTransformerCoordinatorClient(mutable, mutableTransport);
    (mutable as unknown as { authToken: string }).authToken = "changed-secret-at-least-32-characters";
    (mutable as unknown as { tenantPrefix: string }).tenantPrefix = "other-";
    (mutable as unknown as { maxOperations: number }).maxOperations = 0;
    mutableTransport.request = async () => { throw new Error("mutated"); };

    await expect(client.readCheckpoint(readInput())).resolves.toBeNull();
    expect(calls).toEqual([`Bearer ${config().authToken}`]);
  });

  it("rejects checkpoint reads whose exact scope and digest binding do not match", async () => {
    const checkpoint = { generation: 1 };
    const checkpointDigest = digest(checkpoint);
    const input = readInput();
    const validReceipt = { status: "found", tenantId: "tenant-a", campaignId: "campaign-1", episodeId: "episode-1", requestDigest: input.requestDigest, checkpointDigest, checkpoint };
    const valid = new TextEncoder().encode(JSON.stringify(validReceipt));
    const receipt = await createTransformerCoordinatorClient(config(), transport(async () => ({ status: 200, body: valid }))).readCheckpoint(input);
    expect(receipt).toEqual(validReceipt);
    expect(Object.isFrozen(receipt)).toBe(true);

    for (const body of [
      { ...validReceipt, tenantId: "tenant-b" },
      { ...validReceipt, campaignId: "campaign-2" },
      { ...validReceipt, episodeId: "episode-2" },
      { ...validReceipt, requestDigest: `sha256:${"d".repeat(64)}` },
      { ...validReceipt, checkpointDigest: `sha256:${"e".repeat(64)}` },
      { ...validReceipt, extra: true },
    ]) {
      const client = createTransformerCoordinatorClient(config(), transport(async () => ({ status: 200, body: new TextEncoder().encode(JSON.stringify(body)) })));
      await errorCode(() => client.readCheckpoint(input), "coordinator_response_invalid");
    }
  });

  it("enforces tenant isolation, exact responses, response bounds, and operation bounds", async () => {
    const client = createTransformerCoordinatorClient(config({ maxOperations: 1 }), transport(async () => ({ status: 200, body: JSON_BODY })));
    await errorCode(() => client.readCheckpoint({ ...readInput(), tenantId: "other" }), "coordinator_tenant_scope_denied");
    await client.compareAndSwapCheckpoint(casInput({ expectedCheckpointDigest: null }));
    await errorCode(() => client.readCheckpoint(readInput()), "coordinator_operation_limit");

    const oversized = createTransformerCoordinatorClient(config({ maxResponseBytes: 8 }), transport(async () => ({ status: 200, body: JSON_BODY })));
    await errorCode(() => oversized.readCheckpoint(readInput()), "coordinator_response_too_large");
    const mismatched = createTransformerCoordinatorClient(config(), transport(async () => ({ status: 200, body: new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(JSON_BODY)), tenantId: "tenant-b" })) })));
    await errorCode(() => mismatched.compareAndSwapCheckpoint(casInput({ expectedCheckpointDigest: null })), "coordinator_response_invalid");
  });

  it("rejects missing, coercive, non-finite, cyclic, and digest-mismatched checkpoints", async () => {
    const client = createTransformerCoordinatorClient(config(), transport(async () => ({ status: 200, body: JSON_BODY })));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let accessorInvoked = false;
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", { enumerable: true, get() { accessorInvoked = true; return 1; } });
    accessor.length = 1;
    for (const nextCheckpoint of [null, undefined, () => true, { missing: undefined }, { callable: () => true }, { nonFinite: Number.NaN }, new Date(), accessor] as unknown[]) {
      await errorCode(() => client.compareAndSwapCheckpoint(casInput({ nextCheckpoint })), "coordinator_request_invalid");
    }
    await errorCode(() => client.compareAndSwapCheckpoint(casInput({ nextCheckpoint: cyclic })), "coordinator_request_invalid");
    await errorCode(() => client.compareAndSwapCheckpoint(casInput({ checkpointDigest: `sha256:${"f".repeat(64)}` })), "coordinator_request_invalid");
    expect(accessorInvoked).toBe(false);
  });

  it("serializes equivalent checkpoint objects to exact deterministic replay bytes", async () => {
    const bodies: string[] = [];
    const adapter = transport(async (request) => {
      bodies.push(new TextDecoder().decode(request.body));
      const parsed = JSON.parse(bodies.at(-1)!) as Record<string, unknown>;
      return { status: 200, body: new TextEncoder().encode(JSON.stringify({ status: "accepted", tenantId: parsed.tenantId, campaignId: parsed.campaignId, episodeId: parsed.episodeId, operationId: parsed.operationId, requestDigest: parsed.requestDigest, checkpointDigest: parsed.checkpointDigest, replayed: bodies.length > 1, checkpoint: parsed.nextCheckpoint })) };
    });
    const first = { alpha: 1, beta: 2 };
    const second = { beta: 2, alpha: 1 };
    const checkpointDigest = digest(first);
    await createTransformerCoordinatorClient(config(), adapter).compareAndSwapCheckpoint(casInput({ checkpointDigest, nextCheckpoint: first }));
    await createTransformerCoordinatorClient(config(), adapter).compareAndSwapCheckpoint(casInput({ checkpointDigest, nextCheckpoint: second }));
    expect(bodies[1]).toBe(bodies[0]);
  });
});
