import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  listReleaseArtifacts,
  listReleaseDispatches,
  listReleaseObservations,
  openReleaseIngestionStore,
  rehydrateReleaseArtifact,
  type ReleaseIngestionStore,
} from "./release-ingestion.js";
import {
  RELEASE_POLL_CONTRACT_VERSION,
  pollReleaseSource,
  type ReleasePollConfigurationV1,
} from "./release-poll.js";

const NOW = "2026-08-02T12:00:00.000Z";
const RELEASE_POLL_MAX_BYTES = 1024 * 1024;
const rss = readFileSync(
  new URL("../fixtures/releases/stripe-rss.xml", import.meta.url),
  "utf8",
);
const stores: ReleaseIngestionStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function ledger(): ReleaseIngestionStore {
  const opened = openReleaseIngestionStore(":memory:", { clock: () => NOW });
  stores.push(opened);
  return opened;
}

function configuration(
  tenantId = "tenant-a",
  sourceUrl = "https://docs.stripe.com/changelog/feed",
): ReleasePollConfigurationV1 {
  return {
    contractVersion: RELEASE_POLL_CONTRACT_VERSION,
    tenantId,
    provider: { slug: "stripe" },
    adapter: "rss",
    source: { url: sourceUrl },
  };
}

function publicFetchOptions(body = rss) {
  return {
    production: true,
    resolveHostname: async () => ["93.184.216.34"],
    trustedTestOnlyPinnedFetchImpl: async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/rss+xml" },
    }),
  } as const;
}

type MutableReleasePollConfiguration = {
  contractVersion: string;
  tenantId: string;
  provider: { slug: string };
  adapter: string;
  source: { url: string; maxBytes?: number };
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function durableSourceUrl(value: string): string {
  const canonical = new URL(value.trim()).toString();
  return `${new URL(canonical).origin}/.well-known/mendpoint/release-source/${sha256(canonical)}`;
}

describe("release source polling", () => {
  it("binds persisted release and outbox identities to the explicit tenant, provider, adapter, and source", async () => {
    const store = ledger();
    const config = configuration();

    const result = await pollReleaseSource(store, config, {
      at: NOW,
      fetchOptions: publicFetchOptions(),
    });

    expect(result).toMatchObject({
      status: "ingested",
      contractVersion: "release-poll.v1",
      tenantId: "tenant-a",
      providerSlug: "stripe",
      adapter: "rss",
      sourceUrl: durableSourceUrl(config.source.url),
      sourceMaxBytes: null,
      inserted: 1,
      artifacts: [{
        artifactId: expect.stringMatching(/^rel_[a-f0-9]{32}$/),
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }],
      dispatches: [{
        dispatchId: expect.stringMatching(/^rdi_[a-f0-9]{32}$/),
        artifactId: expect.stringMatching(/^rel_[a-f0-9]{32}$/),
        artifactContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }],
    });
    expect(listReleaseArtifacts(store, "tenant-a")[0]).toMatchObject({
      providerSlug: "stripe",
      adapter: "rss",
      collectionUrl: durableSourceUrl(config.source.url),
    });
    expect(listReleaseArtifacts(store, "tenant-b")).toEqual([]);
    expect(listReleaseDispatches(store, "tenant-b")).toEqual([]);
  });

  it("returns digest references that rehydrate only within the configured tenant", async () => {
    const store = ledger();
    const result = await pollReleaseSource(store, configuration(), {
      at: NOW,
      fetchOptions: publicFetchOptions(),
    });
    expect(result.status).toBe("ingested");
    if (result.status === "failed" || result.status === "invalid_configuration") {
      throw new Error(result.error);
    }
    const reference = result.artifacts[0]!;

    expect(rehydrateReleaseArtifact(store, {
      tenantId: "tenant-a",
      artifactId: reference.artifactId,
      expectedContentSha256: reference.contentSha256,
    })).toMatchObject({ id: reference.artifactId, contentSha256: reference.contentSha256 });
    expect(() => rehydrateReleaseArtifact(store, {
      tenantId: "tenant-b",
      artifactId: reference.artifactId,
      expectedContentSha256: reference.contentSha256,
    })).toThrow("release_artifact_not_found");
  });

  it("replays the same fetched release without duplicating the artifact or dispatch", async () => {
    const store = ledger();
    const config = configuration();
    const options = { at: NOW, fetchOptions: publicFetchOptions() } as const;

    const first = await pollReleaseSource(store, config, options);
    const replay = await pollReleaseSource(store, config, options);

    expect(first.status).toBe("ingested");
    expect(replay).toMatchObject({ status: "unchanged", inserted: 0 });
    expect(replay.artifacts).toEqual(first.artifacts);
    expect(replay.dispatches).toEqual(first.dispatches);
    expect(listReleaseArtifacts(store, "tenant-a")).toHaveLength(1);
    expect(listReleaseDispatches(store, "tenant-a")).toHaveLength(1);
    expect(listReleaseObservations(
      store,
      "tenant-a",
      listReleaseArtifacts(store, "tenant-a")[0]!.id,
    )).toHaveLength(1);
  });

  it("inherits protected destination rejection before invoking the network fetcher", async () => {
    const store = ledger();
    let fetches = 0;

    const result = await pollReleaseSource(
      store,
      configuration("tenant-a", "https://127.0.0.1/releases"),
      {
        at: NOW,
        fetchOptions: {
          production: true,
          trustedTestOnlyPinnedFetchImpl: async () => {
            fetches++;
            throw new Error("blocked destination was fetched");
          },
        },
      },
    );

    expect(result).toMatchObject({
      status: "failed",
      tenantId: "tenant-a",
      providerSlug: "stripe",
      adapter: "rss",
      sourceUrl: durableSourceUrl("https://127.0.0.1/releases"),
      sourceMaxBytes: null,
      error: "production feed URL resolves to a blocked address",
    });
    expect(fetches).toBe(0);
    expect(listReleaseArtifacts(store, "tenant-a")).toEqual([]);
  });

  it.each([
    ["contract version", { contractVersion: "release-poll.v2" }, "release_poll_contract_version_unsupported"],
    ["adapter", { adapter: "webhook" }, "release_poll_adapter_unsupported"],
  ] as const)("represents a rejected %s without fabricating a valid polling identity", async (
    _field,
    patch,
    error,
  ) => {
    const store = ledger();
    const raw = {
      ...configuration(),
      ...patch,
    } as unknown as ReleasePollConfigurationV1;

    const result = await pollReleaseSource(store, raw, { at: NOW });

    expect(result).toMatchObject({
      status: "invalid_configuration",
      error,
      identity: null,
      configurationBinding: { tenantId: "tenant-a", providerSlug: "stripe" },
      sourceReference: {
        origin: "https://docs.stripe.com",
        suppliedSha256: sha256("https://docs.stripe.com/changelog/feed"),
      },
      inserted: 0,
      artifacts: [],
      dispatches: [],
    });
    expect(result).not.toHaveProperty("contractVersion");
    expect(result).not.toHaveProperty("adapter");
    expect(result).not.toHaveProperty("sourceUrl");
  });

  it.each([
    ["query token", "https://docs.example.com/releases?channel=token-secret", "https://docs.example.com"],
    ["userinfo credentials", "https://user:password-secret@docs.example.com/releases", "https://docs.example.com"],
    ["fragment", "https://docs.example.com/releases#fragment-secret", "https://docs.example.com"],
    ["secret path", "http://docs.example.com/private/path-secret", "http://docs.example.com"],
    ["malformed URL", "not a URL malformed-secret", null],
  ] as const)("redacts an invalid source containing a %s", async (_case, supplied, origin) => {
    const store = ledger();
    const result = await pollReleaseSource(store, configuration("tenant-a", supplied), { at: NOW });
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      status: "invalid_configuration",
      identity: null,
      configurationBinding: { tenantId: "tenant-a", providerSlug: "stripe" },
      sourceReference: { origin, suppliedSha256: sha256(supplied) },
    });
    for (const secret of ["token-secret", "password-secret", "fragment-secret", "path-secret", "malformed-secret"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(listReleaseArtifacts(store, "tenant-a")).toEqual([]);
  });

  it.each([
    [Number.MAX_SAFE_INTEGER],
    [Number.POSITIVE_INFINITY],
    [RELEASE_POLL_MAX_BYTES + 1],
  ])("rejects an out-of-range release byte limit %s", async (maxBytes) => {
    const store = ledger();
    const result = await pollReleaseSource(store, {
      ...configuration(),
      source: { ...configuration().source, maxBytes },
    });
    expect(result).toMatchObject({
      status: "invalid_configuration",
      error: "release_poll_source_max_bytes_invalid",
      identity: null,
    });
  });

  it("accepts the hard byte boundary and rejects a chunked body that crosses it", async () => {
    const store = ledger();
    const boundaryBody = `${rss}${" ".repeat(RELEASE_POLL_MAX_BYTES - Buffer.byteLength(rss))}`;
    const accepted = await pollReleaseSource(store, {
      ...configuration(),
      source: { ...configuration().source, maxBytes: RELEASE_POLL_MAX_BYTES },
    }, {
      at: NOW,
      fetchOptions: publicFetchOptions(boundaryBody),
    });
    expect(accepted.status).toBe("ingested");

    const rejected = await pollReleaseSource(store, configuration("tenant-b"), {
      at: NOW,
      fetchOptions: {
        production: true,
        maxBytes: Number.MAX_SAFE_INTEGER,
        resolveHostname: async () => ["93.184.216.34"],
        trustedTestOnlyPinnedFetchImpl: async () => new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(RELEASE_POLL_MAX_BYTES));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        })),
      },
    });
    expect(rejected).toMatchObject({ status: "failed" });
    expect(rejected.status === "failed" ? rejected.error : "").toContain(
      `exceeds the ${RELEASE_POLL_MAX_BYTES}-byte limit`,
    );
    expect(listReleaseArtifacts(store, "tenant-b")).toEqual([]);
  });

  it.each([
    ["tenant", (config: MutableReleasePollConfiguration) => { config.tenantId = "tenant-b"; }],
    ["provider", (config: MutableReleasePollConfiguration) => { config.provider.slug = "openai"; }],
    ["adapter", (config: MutableReleasePollConfiguration) => { config.adapter = "atom"; }],
    ["source", (config: MutableReleasePollConfiguration) => {
      config.source.url = "https://platform.openai.com/docs/changelog.atom";
    }],
    ["size limit", (config: MutableReleasePollConfiguration) => { config.source.maxBytes = 1; }],
    ["contract version", (config: MutableReleasePollConfiguration) => {
      config.contractVersion = "release-poll.v2";
    }],
  ] as const)("snapshots %s identity before the asynchronous fetch boundary", async (_field, mutate) => {
    const store = ledger();
    const config = configuration() as unknown as MutableReleasePollConfiguration;
    const result = await pollReleaseSource(
      store,
      config as ReleasePollConfigurationV1,
      {
        at: NOW,
        fetchOptions: {
          production: true,
          resolveHostname: async () => ["93.184.216.34"],
          trustedTestOnlyPinnedFetchImpl: async () => {
            mutate(config);
            return new Response(rss, { status: 200 });
          },
        },
      },
    );

    expect(result).toMatchObject({
      status: "ingested",
      contractVersion: RELEASE_POLL_CONTRACT_VERSION,
      tenantId: "tenant-a",
      providerSlug: "stripe",
      adapter: "rss",
      sourceUrl: durableSourceUrl("https://docs.stripe.com/changelog/feed"),
      sourceMaxBytes: null,
      inserted: 1,
    });
    expect(listReleaseArtifacts(store, "tenant-a")[0]).toMatchObject({
      tenantId: "tenant-a",
      providerSlug: "stripe",
      adapter: "rss",
      collectionUrl: durableSourceUrl("https://docs.stripe.com/changelog/feed"),
    });
    expect(listReleaseArtifacts(store, "tenant-b")).toEqual([]);
  });

  it("uses one canonical identity for normalized configuration, results, ledger, and rehydration", async () => {
    const store = ledger();
    const config = {
      contractVersion: RELEASE_POLL_CONTRACT_VERSION,
      tenantId: "tenant-a",
      provider: { slug: "stripe" },
      adapter: "rss",
      source: {
        url: "  HTTPS://DOCS.STRIPE.COM:443/changelog/../changelog/feed  ",
      },
    } satisfies ReleasePollConfigurationV1;

    const result = await pollReleaseSource(store, config, {
      at: NOW,
      fetchOptions: publicFetchOptions(),
    });

    expect(result).toMatchObject({
      status: "ingested",
      tenantId: "tenant-a",
      providerSlug: "stripe",
      adapter: "rss",
      sourceUrl: durableSourceUrl("https://docs.stripe.com/changelog/feed"),
      sourceMaxBytes: null,
    });
    if (result.status === "failed" || result.status === "invalid_configuration") {
      throw new Error(result.error);
    }
    const reference = result.artifacts[0]!;
    expect(rehydrateReleaseArtifact(store, {
      tenantId: result.tenantId,
      artifactId: reference.artifactId,
      expectedContentSha256: reference.contentSha256,
    })).toMatchObject({
      tenantId: result.tenantId,
      providerSlug: result.providerSlug,
      adapter: result.adapter,
      collectionUrl: result.sourceUrl,
    });
  });
});
