import { describe, expect, it } from "vitest";
import {
  TransformerCheckpointArtifactError,
  createTransformerCheckpointArtifactStore,
  type TransformerCheckpointArtifactBackend,
} from "./transformer-checkpoint-artifacts.js";

function backend() {
  const objects = new Map<string, Uint8Array>();
  const marks: string[] = [];
  const value: TransformerCheckpointArtifactBackend = {
    async createOnly(key, bytes) {
      if (objects.has(key)) return "exists";
      objects.set(key, new Uint8Array(bytes));
      return "created";
    },
    async read(key) { return objects.get(key) ? new Uint8Array(objects.get(key)!) : null; },
    async mark(key, state) { marks.push(`${state}:${key}`); },
  };
  return { value, objects, marks };
}

function config(overrides: Record<string, unknown> = {}) {
  return { enabled: true, tenantPrefix: "tenant-", storagePrefix: "transformer-checkpoints/v1", encryptionKey: new Uint8Array(32).fill(7), maxArtifactBytes: 1_024, maxReadBytes: 2_048, maxOperations: 20, ...overrides } as const;
}

function denied(run: () => Promise<unknown>, code: string) { return expect(run()).rejects.toMatchObject({ code }); }

describe("Transformer checkpoint artifact store", () => {
  it("fails closed on disabled or incomplete encryption configuration", () => {
    const store = backend();
    expect(() => createTransformerCheckpointArtifactStore(config({ enabled: false }), store.value)).toThrowError(expect.objectContaining({ code: "artifact_store_disabled" }));
    expect(() => createTransformerCheckpointArtifactStore(config({ encryptionKey: new Uint8Array(16) }), store.value)).toThrowError(expect.objectContaining({ code: "artifact_store_config_invalid" }));
    expect(() => createTransformerCheckpointArtifactStore({ ...config(), deleteEnabled: true } as never, store.value)).toThrowError(expect.objectContaining({ code: "artifact_store_config_invalid" }));
  });

  it("encrypts immutable create-only artifacts and replays only identical plaintext", async () => {
    const raw = backend();
    const store = createTransformerCheckpointArtifactStore(config(), raw.value);
    const bytes = new TextEncoder().encode("checkpoint-state");
    const first = await store.publishImmutable({ tenantId: "tenant-a", artifactKey: "episode-1/head", bytes });
    const replay = await store.publishImmutable({ tenantId: "tenant-a", artifactKey: "episode-1/head", bytes });

    expect(first.created).toBe(true);
    expect(replay).toMatchObject({ created: false, digest: first.digest, storageKey: first.storageKey });
    expect(new TextDecoder().decode(raw.objects.get(first.storageKey))).not.toContain("checkpoint-state");
    expect(await store.read({ tenantId: "tenant-a", storageKey: first.storageKey })).toEqual(bytes);
    await denied(() => store.publishImmutable({ tenantId: "tenant-a", artifactKey: "episode-1/head", bytes: new TextEncoder().encode("different") }), "artifact_collision");
  });

  it("recovers exact response loss by authenticated readback", async () => {
    const raw = backend();
    let first = true;
    const responseLoss: TransformerCheckpointArtifactBackend = {
      ...raw.value,
      async createOnly(key, bytes) {
        const result = await raw.value.createOnly(key, bytes);
        if (first) { first = false; throw new Error("response_lost"); }
        return result;
      },
    };
    const store = createTransformerCheckpointArtifactStore(config(), responseLoss);
    const bytes = new TextEncoder().encode("durable");

    expect(await store.publishImmutable({ tenantId: "tenant-a", artifactKey: "episode-1/head", bytes })).toMatchObject({ created: true });
    expect(await store.read({ tenantId: "tenant-a", storageKey: "transformer-checkpoints/v1/tenant-a/episode-1/head" })).toEqual(bytes);
  });

  it("classifies a different-byte response-loss readback as an immutable collision", async () => {
    const raw = backend();
    const seeded = createTransformerCheckpointArtifactStore(config(), raw.value);
    await seeded.publishImmutable({ tenantId: "tenant-a", artifactKey: "episode-1/head", bytes: new TextEncoder().encode("original") });
    let firstRead = true;
    const responseLoss: TransformerCheckpointArtifactBackend = {
      ...raw.value,
      async read(key) {
        if (firstRead) { firstRead = false; return null; }
        return raw.value.read(key);
      },
      async createOnly() { throw new Error("response_lost"); },
    };
    const store = createTransformerCheckpointArtifactStore(config(), responseLoss);
    await denied(() => store.publishImmutable({ tenantId: "tenant-a", artifactKey: "episode-1/head", bytes: new TextEncoder().encode("different") }), "artifact_collision");
  });

  it("enforces tenant and prefix isolation, authenticated tamper detection, and bounds", async () => {
    const raw = backend();
    const store = createTransformerCheckpointArtifactStore(config({ maxOperations: 2, maxArtifactBytes: 4 }), raw.value);
    await denied(() => store.publishImmutable({ tenantId: "other", artifactKey: "a", bytes: new Uint8Array([1]) }), "artifact_scope_denied");
    await denied(() => store.publishImmutable({ tenantId: "tenant-a", artifactKey: "../escape", bytes: new Uint8Array([1]) }), "artifact_key_invalid");
    await denied(() => store.publishImmutable({ tenantId: "tenant-a", artifactKey: "large", bytes: new Uint8Array(5) }), "artifact_too_large");
    const published = await store.publishImmutable({ tenantId: "tenant-a", artifactKey: "safe", bytes: new Uint8Array([1, 2]) });
    raw.objects.get(published.storageKey)![20] ^= 1;
    await denied(() => store.read({ tenantId: "tenant-a", storageKey: published.storageKey }), "artifact_authentication_failed");
    await denied(() => store.read({ tenantId: "tenant-a", storageKey: published.storageKey }), "artifact_operation_limit");
  });

  it("records pending, referenced, and unreferenced lifecycle only and exposes no deletion authority", async () => {
    const raw = backend();
    const store = createTransformerCheckpointArtifactStore(config(), raw.value);
    const storageKey = "transformer-checkpoints/v1/tenant-a/episode-1/head";
    await store.recordPending({ tenantId: "tenant-a", storageKey });
    await store.recordReferenced({ tenantId: "tenant-a", storageKey });
    await store.recordUnreferenced({ tenantId: "tenant-a", storageKey });
    expect(raw.marks).toEqual([`pending:${storageKey}`, `referenced:${storageKey}`, `unreferenced:${storageKey}`]);
    expect("delete" in store).toBe(false);
    expect("delete" in raw.value).toBe(false);
  });

  it("rejects ambiguous prefix segments and snapshots config and backend callables", async () => {
    const raw = backend();
    expect(() => createTransformerCheckpointArtifactStore(config({ storagePrefix: "../outside" }), raw.value)).toThrowError(expect.objectContaining({ code: "artifact_store_config_invalid" }));
    expect(() => createTransformerCheckpointArtifactStore(config({ storagePrefix: "safe/./outside" }), raw.value)).toThrowError(expect.objectContaining({ code: "artifact_store_config_invalid" }));
    expect(() => createTransformerCheckpointArtifactStore(config({ tenantPrefix: "tenant" }), raw.value)).toThrowError(expect.objectContaining({ code: "artifact_store_config_invalid" }));

    const mutable = { ...config(), encryptionKey: new Uint8Array(32).fill(7) };
    const store = createTransformerCheckpointArtifactStore(mutable, raw.value);
    (mutable as unknown as { storagePrefix: string }).storagePrefix = "changed";
    (mutable as unknown as { tenantPrefix: string }).tenantPrefix = "other-";
    (mutable as unknown as { maxOperations: number }).maxOperations = 0;
    mutable.encryptionKey.fill(9);
    (raw.value as { read: TransformerCheckpointArtifactBackend["read"] }).read = async () => { throw new Error("mutated"); };
    const result = await store.publishImmutable({ tenantId: "tenant-a", artifactKey: "safe", bytes: new Uint8Array([1]) });
    expect(result.storageKey).toBe("transformer-checkpoints/v1/tenant-a/safe");
    await expect(store.read({ tenantId: "tenant-a", storageKey: result.storageKey })).resolves.toEqual(new Uint8Array([1]));
  });
});
