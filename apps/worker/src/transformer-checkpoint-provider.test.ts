import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTransformerCheckpointProvider } from "./transformer-checkpoint-provider.js";
import type { TransformerCheckpointArtifactBackend } from "./transformer-checkpoint-artifacts.js";
import type { TransformerCoordinatorTransport } from "./transformer-coordinator-client.js";

const coordinatorTransport: TransformerCoordinatorTransport = { request: async () => ({ status: 404, body: new Uint8Array() }) };
const artifactBackend: TransformerCheckpointArtifactBackend = { createOnly: async () => "created", read: async () => null, mark: async () => undefined };

function config(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    mode: "checkpoint_required",
    coordinator: { enabled: true, checkpointMode: "required", baseUrl: "https://coordinator.internal", authToken: "secret-token-at-least-32-characters", workerId: "worker-a", tenantPrefix: "tenant-", timeoutMs: 100, maxResponseBytes: 8_192, maxOperations: 10 },
    artifacts: { enabled: true, tenantPrefix: "tenant-", storagePrefix: "transformer-checkpoints/v1", encryptionKey: new Uint8Array(32).fill(7), maxArtifactBytes: 1_024, maxReadBytes: 2_048, maxOperations: 10 },
    ...overrides,
  } as const;
}

describe("Transformer checkpoint provider foundation", () => {
  it("requires explicit complete checkpoint-only enablement", () => {
    expect(() => createTransformerCheckpointProvider(config({ enabled: false }), { coordinatorTransport, artifactBackend })).toThrowError(expect.objectContaining({ code: "checkpoint_provider_disabled" }));
    expect(() => createTransformerCheckpointProvider(config({ mode: "legacy_complete" }), { coordinatorTransport, artifactBackend })).toThrowError(expect.objectContaining({ code: "checkpoint_provider_mode_invalid" }));
    expect(() => createTransformerCheckpointProvider({ ...config(), adaptiveFallback: true } as never, { coordinatorTransport, artifactBackend })).toThrowError(expect.objectContaining({ code: "checkpoint_provider_config_invalid" }));
  });

  it("composes stateless shared clients without granting completion or deletion authority", () => {
    const provider = createTransformerCheckpointProvider(config(), { coordinatorTransport, artifactBackend });
    expect(provider.mode).toBe("checkpoint_required");
    expect("completeLegacy" in provider).toBe(false);
    expect("adaptive" in provider).toBe(false);
    expect("delete" in provider.artifacts).toBe(false);
  });

  it("snapshots nested configuration before exposing the composed provider", async () => {
    const objects = new Map<string, Uint8Array>();
    const mutableBackend: TransformerCheckpointArtifactBackend = {
      async createOnly(key, bytes) {
        if (objects.has(key)) return "exists";
        objects.set(key, new Uint8Array(bytes));
        return "created";
      },
      async read(key) { return objects.get(key) ? new Uint8Array(objects.get(key)!) : null; },
      async mark() {},
    };
    const mutable = {
      ...config(),
      coordinator: { ...config().coordinator },
      artifacts: { ...config().artifacts, encryptionKey: new Uint8Array(32).fill(7) },
    };
    const provider = createTransformerCheckpointProvider(mutable, { coordinatorTransport, artifactBackend: mutableBackend });
    (mutable as unknown as { mode: string }).mode = "legacy_complete";
    (mutable.coordinator as unknown as { tenantPrefix: string }).tenantPrefix = "other-";
    (mutable.artifacts as unknown as { storagePrefix: string }).storagePrefix = "changed";
    await expect(provider.coordinator.readCheckpoint({ tenantId: "tenant-a", campaignId: "campaign-1", episodeId: "episode-1", requestDigest: `sha256:${"a".repeat(64)}` })).resolves.toBeNull();
    expect((await provider.artifacts.publishImmutable({ tenantId: "tenant-a", artifactKey: "safe", bytes: new Uint8Array([1]) })).storageKey).toBe("transformer-checkpoints/v1/tenant-a/safe");
  });

  it("remains unreachable from the existing run service", () => {
    const cli = readFileSync(join(import.meta.dirname, "cli.ts"), "utf8");
    const runtime = readFileSync(join(import.meta.dirname, "transformer-pilot-runtime.ts"), "utf8");
    expect(cli).not.toContain("transformer-checkpoint-provider");
    expect(runtime).not.toContain("transformer-checkpoint-provider");
  });
});
