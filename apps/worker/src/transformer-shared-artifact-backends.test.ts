import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTransformerCheckpointArtifactStore } from "./transformer-checkpoint-artifacts.js";
import {
  createFilesystemTransformerArtifactBackend,
  createS3CompatibleTransformerArtifactBackend,
  type S3CompatibleArtifactTransport,
} from "./transformer-shared-artifact-backends.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const key = new Uint8Array(32).fill(7);
function config() { return { enabled: true, tenantPrefix: "tenant-", storagePrefix: "transformer", encryptionKey: key, maxArtifactBytes: 1_024, maxReadBytes: 2_048, maxOperations: 100 } as const; }

describe("shared Transformer artifact backends", () => {
  it("shares atomic create-only encrypted artifacts between local worker processes", async () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-shared-artifacts-"));
    roots.push(root);
    const first = createTransformerCheckpointArtifactStore(config(), createFilesystemTransformerArtifactBackend({ root, maxStoredBytes: 2_048 }));
    const second = createTransformerCheckpointArtifactStore(config(), createFilesystemTransformerArtifactBackend({ root, maxStoredBytes: 2_048 }));
    const bytes = new TextEncoder().encode("exact source");
    const published = await first.publishImmutable({ tenantId: "tenant-a", artifactKey: "source/revision-a", bytes });
    expect(await second.read({ tenantId: "tenant-a", storageKey: published.storageKey })).toEqual(bytes);
    await expect(second.publishImmutable({ tenantId: "tenant-a", artifactKey: "source/revision-a", bytes: new TextEncoder().encode("different") }))
      .rejects.toMatchObject({ code: "artifact_collision" });
  });

  it("uses S3 conditional create, reconciles response loss, and bounds streamed reads", async () => {
    const objects = new Map<string, Uint8Array>();
    const puts: Array<{ key: string; ifNoneMatch: "*" }> = [];
    let loseResponse = true;
    const transport: S3CompatibleArtifactTransport = {
      putObject: async (input) => {
        puts.push({ key: input.key, ifNoneMatch: input.ifNoneMatch });
        if (objects.has(input.key)) return { status: 412 };
        objects.set(input.key, new Uint8Array(input.body));
        if (loseResponse) { loseResponse = false; throw new Error("response_lost"); }
        return { status: 201 };
      },
      getObject: async ({ key: objectKey }) => {
        const value = objects.get(objectKey);
        if (!value) return { status: 404, body: null };
        return { status: 200, contentLength: value.byteLength, body: (async function* () { yield value.slice(0, 5); yield value.slice(5); })() };
      },
    };
    const backend = createS3CompatibleTransformerArtifactBackend({ bucket: "mendpoint-checkpoints", keyPrefix: "prod", maxStoredBytes: 2_048 }, transport);
    const store = createTransformerCheckpointArtifactStore(config(), backend);
    const bytes = new TextEncoder().encode("response loss is reconciled");
    const receipt = await store.publishImmutable({ tenantId: "tenant-a", artifactKey: "source/revision-a", bytes });
    expect(receipt.created).toBe(true);
    expect(puts[0]).toMatchObject({ ifNoneMatch: "*", key: `prod/${receipt.storageKey}` });

    const oversized = createS3CompatibleTransformerArtifactBackend({ bucket: "mendpoint-checkpoints", keyPrefix: "prod", maxStoredBytes: 4 }, transport);
    await expect(oversized.read(receipt.storageKey)).rejects.toThrow("s3_artifact_read_too_large");
  });

  it("distinguishes missing bucket and denied credentials without exposing provider bodies", async () => {
    const status = { get: 403, put: 403 };
    const transport: S3CompatibleArtifactTransport = {
      putObject: async () => ({ status: status.put }),
      getObject: async () => ({ status: status.get, body: new TextEncoder().encode("provider-secret") }),
    };
    const backend = createS3CompatibleTransformerArtifactBackend({ bucket: "mendpoint-checkpoints", keyPrefix: "prod", maxStoredBytes: 2_048 }, transport);

    await expect(backend.read("readiness/worker-a")).rejects.toThrow("s3_artifact_access_denied");
    await expect(backend.createOnly("readiness/worker-a", new Uint8Array([1]))).rejects.toThrow("s3_artifact_access_denied");
    status.get = 404;
    status.put = 404;
    expect(await backend.read("readiness/worker-a")).toBeNull();
    await expect(backend.createOnly("readiness/worker-a", new Uint8Array([1]))).rejects.toThrow("s3_artifact_bucket_not_found");
  });
});
