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
    fetchImpl: async () => new Response(body, {
      status: 200,
      headers: { "content-type": "application/rss+xml" },
    }),
  } as const;
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
      sourceUrl: "https://docs.stripe.com/changelog/feed",
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
      collectionUrl: config.source.url,
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
    if (result.status === "failed") throw new Error(result.error);
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
          fetchImpl: async () => {
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
      sourceUrl: "https://127.0.0.1/releases",
      error: "production feed URL resolves to a blocked address",
    });
    expect(fetches).toBe(0);
    expect(listReleaseArtifacts(store, "tenant-a")).toEqual([]);
  });
});
