import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, upsertFeedSchedule, type AppDb } from "@mendpoint/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  ingestReleaseDocument,
  listReleaseDispatches,
  openReleaseIngestionStore,
  type ReleaseIngestionStore,
} from "./release-ingestion.js";
import {
  RELEASE_POLL_CONTRACT_VERSION,
  type ReleasePollConfigurationV1,
  type ReleasePollResult,
} from "./release-poll.js";
import { runFeedSchedules } from "./schedule-runner.js";
import type { PollableFeed } from "./poll.js";

const opened: Array<{ db: AppDb; directory: string }> = [];
const releaseStores: ReleaseIngestionStore[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-feed-schedules-"));
  const db = createDb(join(directory, "schedules.sqlite"));
  opened.push({ db, directory });
  return db;
}

function feeds(count: number): PollableFeed[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `provider-${index + 1}`,
    name: `Provider ${index + 1}`,
    openapiUrl: `file:provider-${index + 1}.json`,
    source: "provider" as const,
  }));
}

function releaseConfiguration(
  tenantId = "tenant_default",
  providerSlug = "provider-1",
): ReleasePollConfigurationV1 {
  return {
    contractVersion: RELEASE_POLL_CONTRACT_VERSION,
    tenantId,
    provider: { slug: providerSlug },
    adapter: "rss",
    source: { url: "https://docs.example.com/releases.xml" },
  };
}

function durableSourceUrl(value: string): string {
  const canonical = new URL(value).toString();
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `${new URL(canonical).origin}/.well-known/mendpoint/release-source/${digest}`;
}

function unchangedRelease(
  config: ReleasePollConfigurationV1,
): ReleasePollResult & { status: "unchanged"; inserted: 0 } {
  return {
    contractVersion: config.contractVersion,
    tenantId: config.tenantId,
    providerSlug: config.provider.slug,
    adapter: config.adapter,
    sourceUrl: durableSourceUrl(config.source.url),
    sourceMaxBytes: config.source.maxBytes ?? null,
    status: "unchanged",
    inserted: 0 as const,
    artifacts: [],
    dispatches: [],
  };
}

function releaseStore(): ReleaseIngestionStore {
  const store = openReleaseIngestionStore(":memory:", {
    clock: () => "2026-08-02T12:00:30.000Z",
  });
  releaseStores.push(store);
  return store;
}

function persistedRelease(
  store: ReleaseIngestionStore,
  config: ReleasePollConfigurationV1,
  status: "ingested" | "unchanged" = "ingested",
): ReleasePollResult {
  const ingested = ingestReleaseDocument(store, {
    tenantId: config.tenantId,
    providerSlug: config.provider.slug,
    adapter: config.adapter,
    sourceUrl: durableSourceUrl(config.source.url),
    body: `<?xml version="1.0"?><rss><channel><item>
      <guid>persisted-${config.tenantId}-${config.provider.slug}</guid>
      <title>Persisted release</title><link>https://docs.example.com/release</link>
      <pubDate>Sat, 02 Aug 2026 12:00:00 GMT</pubDate>
      <description>Changed one field.</description></item></channel></rss>`,
    observedAt: "2026-08-02T12:00:30.000Z",
    now: "2026-08-02T12:00:30.000Z",
  });
  const artifactIds = new Set(ingested.artifacts.map((artifact) => artifact.id));
  const dispatches = listReleaseDispatches(store, config.tenantId)
    .filter((dispatch) => artifactIds.has(dispatch.artifactId));
  return {
    contractVersion: config.contractVersion,
    tenantId: config.tenantId,
    providerSlug: config.provider.slug,
    adapter: config.adapter,
    sourceUrl: durableSourceUrl(config.source.url),
    sourceMaxBytes: config.source.maxBytes ?? null,
    status,
    inserted: status === "ingested" ? ingested.inserted : 0,
    artifacts: ingested.artifacts.map((artifact) => ({
      artifactId: artifact.id,
      contentSha256: artifact.contentSha256,
    })),
    dispatches: dispatches.map((dispatch) => ({
      dispatchId: dispatch.id,
      artifactId: dispatch.artifactId,
      artifactContentSha256: dispatch.artifactContentSha256,
    })),
  };
}

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
  for (const store of releaseStores.splice(0)) store.close();
});

describe("feed schedule runner", () => {
  it("bounds concurrency and replays a claimed time window without executing twice", async () => {
    const db = fixture();
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    const configuredFeeds = feeds(4);
    const execute = async (feed: PollableFeed) => {
      calls++;
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return { slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const };
    };
    const first = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:00:30.000Z",
      defaultIntervalMs: 60_000,
      defaultStaleAfterMs: 120_000,
      maxConcurrency: 2,
      feeds: configuredFeeds,
      execute,
    });
    expect(first).toMatchObject({
      maxConcurrency: 2,
      claimed: 4,
      succeeded: 4,
      failed: 0,
      alreadyClaimed: 0,
      health: { status: "healthy", counts: { healthy: 4, stale: 0, failed: 0 } },
    });
    expect(maximumActive).toBe(2);
    expect(calls).toBe(4);

    const replay = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:00:59.000Z",
      defaultIntervalMs: 60_000,
      defaultStaleAfterMs: 120_000,
      maxConcurrency: 2,
      feeds: configuredFeeds,
      execute,
    });
    expect(replay).toMatchObject({
      claimed: 0,
      succeeded: 0,
      failed: 0,
      alreadyClaimed: 4,
    });
    expect(calls).toBe(4);
  });

  it("surfaces a failed source and clears the alert on the next successful window", async () => {
    const db = fixture();
    const configuredFeeds = feeds(1);
    let fail = true;
    const execute = async (feed: PollableFeed) => fail
      ? { slug: feed.slug, url: feed.openapiUrl, status: "error" as const, error: "HTTP 503" }
      : { slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const };
    const failed = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:00:30.000Z",
      defaultIntervalMs: 60_000,
      defaultStaleAfterMs: 120_000,
      feeds: configuredFeeds,
      execute,
    });
    expect(failed).toMatchObject({
      failed: 1,
      health: {
        status: "degraded",
        counts: { healthy: 0, stale: 0, failed: 1 },
        schedules: [{ alertState: "failed", lastSuccessAt: null, lastError: "HTTP 503" }],
      },
    });

    fail = false;
    const recovered = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:01:30.000Z",
      defaultIntervalMs: 60_000,
      defaultStaleAfterMs: 120_000,
      feeds: configuredFeeds,
      execute,
    });
    expect(recovered).toMatchObject({
      succeeded: 1,
      health: {
        status: "healthy",
        schedules: [{
          alertState: "healthy",
          lastSuccessAt: "2026-08-02T12:01:30.000Z",
          consecutiveFailures: 0,
          lastError: null,
        }],
      },
    });
  });

  it("services existing schedules for every tenant when no tenant filter is configured", async () => {
    const db = fixture();
    const configuredFeeds = feeds(1);
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      db.raw
        .prepare(
          `INSERT INTO tenants
             (id, slug, name, plan, billing_status, seat_limit, created_at)
           VALUES (?, ?, ?, 'pilot', 'active', 5, ?)`,
        )
        .run(tenantId, tenantId, tenantId, "2026-08-02T12:00:00.000Z");
      upsertFeedSchedule(db, {
        id: `schedule-${tenantId}`,
        tenantId,
        providerSlug: configuredFeeds[0]!.slug,
        intervalMs: 60_000,
        staleAfterMs: 120_000,
        createdAt: "2026-08-02T12:00:00.000Z",
      });
    }
    const serviced: string[] = [];

    const result = await runFeedSchedules({
      db,
      at: "2026-08-02T12:00:30.000Z",
      feeds: configuredFeeds,
      execute: async (feed, schedule) => {
        serviced.push(schedule.tenant_id);
        return { slug: feed.slug, url: feed.openapiUrl, status: "unchanged" };
      },
    });

    expect(serviced.sort()).toEqual(["tenant-a", "tenant-b"]);
    expect(result).toMatchObject({
      claimed: 2,
      succeeded: 2,
      failed: 0,
      health: { counts: { healthy: 2, stale: 0, failed: 0 } },
    });
  });

  it("fetches one provider document per schedule cycle and dispatches every tenant", async () => {
    const db = fixture();
    const configuredFeeds = feeds(1);
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      db.raw.prepare(
        `INSERT INTO tenants
           (id, slug, name, plan, billing_status, seat_limit, created_at)
         VALUES (?, ?, ?, 'pilot', 'active', 5, ?)`,
      ).run(tenantId, tenantId, tenantId, "2026-08-02T12:00:00.000Z");
      upsertFeedSchedule(db, {
        id: `shared-${tenantId}`,
        tenantId,
        providerSlug: configuredFeeds[0]!.slug,
        intervalMs: 60_000,
        staleAfterMs: 120_000,
        createdAt: "2026-08-02T12:00:00.000Z",
      });
    }
    let fetches = 0;
    const result = await runFeedSchedules({
      db,
      at: "2026-08-02T12:00:30.000Z",
      feeds: configuredFeeds,
      sourceDocumentLoader: async (url) => {
        fetches++;
        return {
          ok: true,
          url,
          body: JSON.stringify({ openapi: "3.1.0", info: { title: "Shared", version: "1" }, paths: {} }),
          contentHash: "shared-content-hash",
          versionLabel: "1",
          httpStatus: 200,
          sizeBytes: 80,
        };
      },
    });
    expect(fetches).toBe(1);
    expect(result).toMatchObject({ claimed: 2, succeeded: 2, failed: 0 });
  });

  it("runs a tenant-matched release source through the existing schedule window", async () => {
    const db = fixture();
    const store = releaseStore();
    const configuredFeeds = feeds(1);
    const result = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:00:30.000Z",
      feeds: configuredFeeds,
      execute: async (feed) => ({
        slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const,
      }),
      releaseStore: store,
      releaseFeeds: [releaseConfiguration()],
      releaseFetchOptions: {
        production: true,
        resolveHostname: async () => ["93.184.216.34"],
        trustedTestOnlyPinnedFetchImpl: async () => new Response(`<?xml version="1.0"?><rss><channel><item>
          <guid>release-1</guid><title>Release 1</title>
          <link>https://docs.example.com/releases/1</link>
          <pubDate>Sat, 02 Aug 2026 12:00:00 GMT</pubDate>
          <description>Renamed old_field to new_field.</description>
        </item></channel></rss>`, { status: 200 }),
      },
    });

    expect(result).toMatchObject({
      claimed: 1,
      succeeded: 1,
      failed: 0,
      executions: [{
        status: "succeeded",
        poll: { status: "unchanged" },
        openApiOutcome: { status: "succeeded", result: { status: "unchanged" } },
        releaseOutcome: { status: "succeeded", result: { status: "ingested", inserted: 1 } },
      }],
    });
    expect(listReleaseDispatches(store, "tenant_default")).toHaveLength(1);
  });

  it("keeps the successful OpenAPI outcome visible when release polling fails", async () => {
    const db = fixture();
    const store = releaseStore();
    const configuredFeeds = feeds(1);
    const releaseFailure: ReleasePollResult = {
      contractVersion: RELEASE_POLL_CONTRACT_VERSION,
      tenantId: "tenant_default",
      providerSlug: "provider-1",
      adapter: "rss",
      sourceUrl: durableSourceUrl("https://docs.example.com/releases.xml"),
      sourceMaxBytes: null,
      status: "failed",
      error: "release_poll_fetch_failed",
      inserted: 0,
      artifacts: [],
      dispatches: [],
    };

    const result = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:00:30.000Z",
      feeds: configuredFeeds,
      execute: async (feed) => ({
        slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const,
      }),
      releaseStore: store,
      releaseFeeds: [releaseConfiguration()],
      releaseExecute: async () => releaseFailure,
    });

    expect(result.executions[0]).toMatchObject({
      status: "failed",
      poll: { status: "unchanged" },
      error: "release: release_poll_fetch_failed",
      openApiOutcome: { status: "succeeded", result: { status: "unchanged" } },
      releaseOutcome: { status: "failed", error: "release_poll_fetch_failed", result: releaseFailure },
    });
  });

  it("keeps the successful release outcome visible when OpenAPI polling fails", async () => {
    const db = fixture();
    const store = releaseStore();
    const configuredFeeds = feeds(1);
    const releaseSuccess = persistedRelease(store, releaseConfiguration(), "unchanged");

    const result = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:00:30.000Z",
      feeds: configuredFeeds,
      execute: async (feed) => ({
        slug: feed.slug, url: feed.openapiUrl, status: "error" as const, error: "OpenAPI HTTP 503",
      }),
      releaseStore: store,
      releaseFeeds: [releaseConfiguration()],
      releaseExecute: async () => releaseSuccess,
    });

    expect(result.executions[0]).toMatchObject({
      status: "failed",
      poll: { status: "error", error: "OpenAPI HTTP 503" },
      error: "OpenAPI: OpenAPI HTTP 503",
      openApiOutcome: { status: "failed", error: "OpenAPI HTTP 503" },
      releaseOutcome: { status: "succeeded", result: releaseSuccess },
    });
  });

  it("schedules a configured release source when no OpenAPI source exists", async () => {
    const db = fixture();
    const store = releaseStore();
    const config = releaseConfiguration("tenant_default", "release-only");
    const releaseSuccess = persistedRelease(store, config, "unchanged");

    const result = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:00:30.000Z",
      feeds: [],
      releaseStore: store,
      releaseFeeds: [config],
      releaseExecute: async () => releaseSuccess,
    });

    expect(result).toMatchObject({
      claimed: 1,
      succeeded: 1,
      failed: 0,
      executions: [{
        providerSlug: "release-only",
        status: "succeeded",
        openApiOutcome: { status: "not_configured" },
        releaseOutcome: { status: "succeeded", result: releaseSuccess },
      }],
    });
  });

  it.each([
    ["unsupported contract version", { contractVersion: "release-poll.v2" }, "release_poll_contract_version_unsupported"],
    ["unsupported adapter", { adapter: "webhook" }, "release_poll_adapter_unsupported"],
  ] as const)("isolates an %s as a typed release failure while OpenAPI still runs", async (
    _case,
    patch,
    error,
  ) => {
    const db = fixture();
    const store = releaseStore();
    const invalid = {
      ...releaseConfiguration(),
      ...patch,
    } as unknown as ReleasePollConfigurationV1;
    let openApiCalls = 0;
    let releaseCalls = 0;

    const result = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:00:30.000Z",
      feeds: feeds(1),
      execute: async (feed) => {
        openApiCalls++;
        return { slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const };
      },
      releaseStore: store,
      releaseFeeds: [invalid],
      releaseExecute: async () => {
        releaseCalls++;
        throw new Error("invalid release configuration was executed");
      },
    });

    expect(openApiCalls).toBe(1);
    expect(releaseCalls).toBe(0);
    expect(result).toMatchObject({
      claimed: 1,
      succeeded: 0,
      failed: 1,
      executions: [{
        status: "failed",
        poll: { status: "unchanged" },
        openApiOutcome: { status: "succeeded", result: { status: "unchanged" } },
        releaseOutcome: {
          status: "failed",
          error,
          result: {
            status: "invalid_configuration",
            error,
            identity: null,
            configurationBinding: { tenantId: "tenant_default", providerSlug: "provider-1" },
          },
        },
      }],
    });
  });

  it("keeps unrelated tenant schedules and valid releases running beside an invalid configuration", async () => {
    const db = fixture();
    const store = releaseStore();
    for (const [tenantId, providerSlug] of [["tenant-a", "provider-1"], ["tenant-b", "provider-2"]]) {
      db.raw.prepare(
        `INSERT INTO tenants
           (id, slug, name, plan, billing_status, seat_limit, created_at)
         VALUES (?, ?, ?, 'pilot', 'active', 5, ?)`,
      ).run(tenantId, tenantId, tenantId, "2026-08-02T12:00:00.000Z");
      upsertFeedSchedule(db, {
        id: `release-isolation-${tenantId}`,
        tenantId,
        providerSlug,
        intervalMs: 60_000,
        staleAfterMs: 120_000,
        createdAt: "2026-08-02T12:00:00.000Z",
      });
    }
    const valid = releaseConfiguration("tenant-a", "provider-1");
    const invalid = {
      ...releaseConfiguration("tenant-b", "provider-2"),
      adapter: "webhook",
    } as unknown as ReleasePollConfigurationV1;
    let openApiCalls = 0;
    let releaseCalls = 0;

    const result = await runFeedSchedules({
      db,
      at: "2026-08-02T12:00:30.000Z",
      feeds: feeds(2),
      execute: async (feed) => {
        openApiCalls++;
        return { slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const };
      },
      releaseStore: store,
      releaseFeeds: [valid, invalid],
      releaseExecute: async (_store, config) => {
        releaseCalls++;
        return persistedRelease(store, config, "unchanged");
      },
    });

    expect(openApiCalls).toBe(2);
    expect(releaseCalls).toBe(1);
    expect(result).toMatchObject({ claimed: 2, succeeded: 1, failed: 1 });
    expect(result.executions.find((execution) => execution.providerSlug === "provider-1")).toMatchObject({
      status: "succeeded",
      openApiOutcome: { status: "succeeded" },
      releaseOutcome: { status: "succeeded", result: { status: "unchanged" } },
    });
    expect(result.executions.find((execution) => execution.providerSlug === "provider-2")).toMatchObject({
      status: "failed",
      openApiOutcome: { status: "succeeded" },
      releaseOutcome: {
        status: "failed",
        error: "release_poll_adapter_unsupported",
        result: { status: "invalid_configuration", identity: null },
      },
    });
  });

  it("turns three same-tenant duplicate bindings into one scoped failure and runs unrelated work", async () => {
    const db = fixture();
    const store = releaseStore();
    const duplicates = ["duplicate-a-secret", "duplicate-b-secret", "duplicate-c-secret"].map(
      (path) => ({
        ...releaseConfiguration("tenant_default", "provider-1"),
        source: { url: `https://docs.example.com/private/${path}` },
      } satisfies ReleasePollConfigurationV1),
    );
    const unrelated = releaseConfiguration("tenant_default", "provider-2");
    let openApiCalls = 0;
    const releaseCalls: string[] = [];

    const result = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:00:30.000Z",
      feeds: feeds(2),
      execute: async (feed) => {
        openApiCalls++;
        return { slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const };
      },
      releaseStore: store,
      releaseFeeds: [...duplicates, unrelated],
      releaseExecute: async (_store, config) => {
        releaseCalls.push(config.provider.slug);
        return persistedRelease(store, config, "unchanged");
      },
    });

    expect(openApiCalls).toBe(2);
    expect(releaseCalls).toEqual(["provider-2"]);
    expect(result).toMatchObject({ claimed: 2, succeeded: 1, failed: 1 });
    const duplicateExecution = result.executions.find(
      (execution) => execution.providerSlug === "provider-1",
    );
    expect(duplicateExecution).toMatchObject({
      status: "failed",
      openApiOutcome: { status: "succeeded", result: { status: "unchanged" } },
      releaseOutcome: {
        status: "failed",
        error: "release_poll_configuration_duplicate",
        result: {
          status: "invalid_configuration",
          error: "release_poll_configuration_duplicate",
          identity: null,
          configurationBinding: { tenantId: "tenant_default", providerSlug: "provider-1" },
          sourceReference: null,
        },
      },
    });
    const serialized = JSON.stringify(duplicateExecution);
    for (const secret of ["duplicate-a-secret", "duplicate-b-secret", "duplicate-c-secret"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(result.executions.find((execution) => execution.providerSlug === "provider-2")).toMatchObject({
      status: "succeeded",
      openApiOutcome: { status: "succeeded" },
      releaseOutcome: { status: "succeeded", result: { status: "unchanged" } },
    });
  });

  it("scopes duplicate provider bindings by tenant and preserves the other tenant release", async () => {
    const db = fixture();
    const store = releaseStore();
    for (const tenantId of ["tenant-a", "tenant-b"]) {
      db.raw.prepare(
        `INSERT INTO tenants
           (id, slug, name, plan, billing_status, seat_limit, created_at)
         VALUES (?, ?, ?, 'pilot', 'active', 5, ?)`,
      ).run(tenantId, tenantId, tenantId, "2026-08-02T12:00:00.000Z");
      upsertFeedSchedule(db, {
        id: `duplicate-scope-${tenantId}`,
        tenantId,
        providerSlug: "provider-1",
        intervalMs: 60_000,
        staleAfterMs: 120_000,
        createdAt: "2026-08-02T12:00:00.000Z",
      });
    }
    const tenantADuplicates = ["first-secret", "second-secret"].map((path) => ({
      ...releaseConfiguration("tenant-a", "provider-1"),
      source: { url: `https://docs.example.com/private/${path}` },
    } satisfies ReleasePollConfigurationV1));
    const tenantB = releaseConfiguration("tenant-b", "provider-1");
    const openApiTenants: string[] = [];
    const releaseTenants: string[] = [];

    const result = await runFeedSchedules({
      db,
      at: "2026-08-02T12:00:30.000Z",
      feeds: feeds(1),
      execute: async (feed, schedule) => {
        openApiTenants.push(schedule.tenant_id);
        return { slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const };
      },
      releaseStore: store,
      releaseFeeds: [...tenantADuplicates, tenantB],
      releaseExecute: async (_store, config) => {
        releaseTenants.push(config.tenantId);
        return persistedRelease(store, config, "unchanged");
      },
    });

    expect(openApiTenants.sort()).toEqual(["tenant-a", "tenant-b"]);
    expect(releaseTenants).toEqual(["tenant-b"]);
    expect(result).toMatchObject({ claimed: 2, succeeded: 1, failed: 1 });
    expect(result.executions.find((execution) => execution.scheduleId === "duplicate-scope-tenant-a")).toMatchObject({
      status: "failed",
      openApiOutcome: { status: "succeeded" },
      releaseOutcome: {
        status: "failed",
        error: "release_poll_configuration_duplicate",
        result: { status: "invalid_configuration", identity: null, sourceReference: null },
      },
    });
    expect(result.executions.find((execution) => execution.scheduleId === "duplicate-scope-tenant-b")).toMatchObject({
      status: "succeeded",
      openApiOutcome: { status: "succeeded" },
      releaseOutcome: { status: "succeeded", result: { tenantId: "tenant-b" } },
    });
  });

  it.each([
    ["unknown status", { status: "mystery-status" }],
    ["missing status", { status: undefined }],
    ["missing failure error", { status: "failed", error: undefined }],
    ["foreign failure tenant", { status: "failed", error: "safe failure", tenantId: "foreign" }],
    ["foreign failure provider", { status: "failed", error: "safe failure", providerSlug: "foreign" }],
    ["foreign failure adapter", { status: "failed", error: "safe failure", adapter: "atom" }],
    ["foreign failure source", { status: "failed", error: "safe failure", sourceUrl: "https://foreign.invalid/source" }],
    ["foreign failure version", { status: "failed", error: "safe failure", contractVersion: "release-poll.v2" }],
    ["malformed source reference", { sourceReference: { origin: "https://private.example/path-secret" } }],
    ["private body payload", { body: "executor-body-secret" }],
  ] as const)("rejects an executor result with %s without echoing its content", async (_case, patch) => {
    const db = fixture();
    const store = releaseStore();
    const config = releaseConfiguration();
    const untrusted = { ...unchangedRelease(config), ...patch } as unknown as ReleasePollResult;

    const result = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:00:30.000Z",
      feeds: feeds(1),
      execute: async (feed) => ({
        slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const,
      }),
      releaseStore: store,
      releaseFeeds: [config],
      releaseExecute: async () => untrusted,
    });

    expect(result).toMatchObject({
      succeeded: 0,
      failed: 1,
      executions: [{
        status: "failed",
        openApiOutcome: { status: "succeeded" },
        releaseOutcome: {
          status: "failed",
          error: "release_poll_executor_result_invalid",
          result: {
            status: "invalid_configuration",
            error: "release_poll_executor_result_invalid",
            identity: null,
            configurationBinding: { tenantId: "tenant_default", providerSlug: "provider-1" },
            sourceReference: null,
          },
        },
      }],
    });
    const serialized = JSON.stringify(result.executions[0]?.releaseOutcome);
    expect(serialized).not.toContain("executor-body-secret");
    expect(serialized).not.toContain("path-secret");
    expect(serialized).not.toContain("foreign");
    expect(serialized).not.toContain("mystery-status");
  });

  it.each(["failed result", "thrown exception"] as const)(
  "redacts release executor secrets from every %s output and durable error field",
  async (failureMode) => {
    const db = fixture();
    const store = releaseStore();
    const config = releaseConfiguration();
    const secret = "password=release-executor-secret body-private";
    const failedResult = {
      ...unchangedRelease(config),
      status: "failed" as const,
      error: secret,
    } as unknown as ReleasePollResult;
    const result = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:00:30.000Z",
      feeds: feeds(1),
      execute: async (feed) => ({ slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const }),
      releaseStore: store,
      releaseFeeds: [config],
      releaseExecute: async () => {
        if (failureMode === "thrown exception") throw new Error(secret);
        return failedResult;
      },
    });
    expect(result).toMatchObject({
      succeeded: 0,
      failed: 1,
      executions: [{
        status: "failed",
        error: "release: release_poll_executor_failed",
        releaseOutcome: { status: "failed", error: "release_poll_executor_failed" },
      }],
    });
    const durable = db.raw.prepare(`SELECT error FROM feed_schedule_windows
      UNION ALL SELECT last_error AS error FROM feed_schedules`).all();
    expect(JSON.stringify({ result, durable })).not.toContain(secret);
    expect(JSON.stringify({ result, durable })).not.toContain("body-private");
  });

  it.each([
    "absent artifact",
    "mismatched artifact digest",
    "absent dispatch",
    "inserted count exceeds references",
    "cross-tenant artifact",
    "foreign provider artifact",
  ] as const)("rejects %s executor references before terminal success", async (failureMode) => {
    const db = fixture();
    const store = releaseStore();
    const config = releaseConfiguration();
    const persisted = persistedRelease(store, config, "ingested") as ReleasePollResult & { status: "ingested" };
    const digest = "f".repeat(64);
    let forged: ReleasePollResult = persisted;
    if (failureMode === "absent artifact") {
      forged = { ...persisted, artifacts: [{ artifactId: "rel_ffffffffffffffffffffffffffffffff", contentSha256: digest }] };
    } else if (failureMode === "mismatched artifact digest") {
      forged = { ...persisted, artifacts: [{ ...persisted.artifacts[0]!, contentSha256: digest }] };
    } else if (failureMode === "absent dispatch") {
      forged = { ...persisted, dispatches: [{
        dispatchId: "rdi_ffffffffffffffffffffffffffffffff",
        artifactId: persisted.artifacts[0]!.artifactId,
        artifactContentSha256: persisted.artifacts[0]!.contentSha256,
      }] };
    } else if (failureMode === "inserted count exceeds references") {
      forged = { ...persisted, inserted: persisted.artifacts.length + 1 };
    } else {
      const foreign = failureMode === "cross-tenant artifact"
        ? releaseConfiguration("tenant-foreign", config.provider.slug)
        : releaseConfiguration(config.tenantId, "provider-foreign");
      const foreignResult = persistedRelease(store, foreign, "ingested") as ReleasePollResult & { status: "ingested" };
      forged = { ...persisted, artifacts: foreignResult.artifacts, dispatches: foreignResult.dispatches };
    }
    const result = await runFeedSchedules({
      db,
      tenantId: config.tenantId,
      at: "2026-08-02T12:00:30.000Z",
      feeds: feeds(1),
      execute: async (feed) => ({ slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const }),
      releaseStore: store,
      releaseFeeds: [config],
      releaseExecute: async () => forged,
    });
    expect(result).toMatchObject({
      succeeded: 0,
      failed: 1,
      executions: [{
        status: "failed",
        releaseOutcome: {
          status: "failed",
          error: "release_poll_executor_result_invalid",
          result: { status: "invalid_configuration", identity: null },
        },
      }],
    });
  });

  it.each(["ingested", "unchanged"] as const)(
  "accepts a %s executor result only when every reference is ledger-backed",
  async (status) => {
    const db = fixture();
    const store = releaseStore();
    const config = releaseConfiguration();
    const persisted = persistedRelease(store, config, status);
    const result = await runFeedSchedules({
      db,
      tenantId: config.tenantId,
      at: "2026-08-02T12:00:30.000Z",
      feeds: feeds(1),
      execute: async (feed) => ({ slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const }),
      releaseStore: store,
      releaseFeeds: [config],
      releaseExecute: async () => persisted,
    });
    expect(result).toMatchObject({
      succeeded: 1,
      failed: 0,
      executions: [{ status: "succeeded", releaseOutcome: { status: "succeeded", result: persisted } }],
    });
  });

  it("rejects an unchanged executor result that omits its artifact's durable dispatch", async () => {
    const db = fixture();
    const store = releaseStore();
    const config = releaseConfiguration();
    const persisted = persistedRelease(store, config, "unchanged") as ReleasePollResult & {
      status: "unchanged";
    };
    const withoutDispatchAuthority: ReleasePollResult = { ...persisted, dispatches: [] };

    const result = await runFeedSchedules({
      db,
      tenantId: config.tenantId,
      at: "2026-08-02T12:00:30.000Z",
      feeds: feeds(1),
      execute: async (feed) => ({ slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const }),
      releaseStore: store,
      releaseFeeds: [config],
      releaseExecute: async () => withoutDispatchAuthority,
    });

    expect(result).toMatchObject({
      succeeded: 0,
      failed: 1,
      executions: [{
        status: "failed",
        releaseOutcome: {
          status: "failed",
          error: "release_poll_executor_result_invalid",
          result: { status: "invalid_configuration", identity: null },
        },
      }],
    });
  });

  it("reports unbound redacted configuration failures without suppressing valid schedules", async () => {
    const db = fixture();
    const store = releaseStore();
    const collisionInputs = [
      {
        ...releaseConfiguration("tenant-a\nprovider-b", "provider-c"),
        source: { url: "https://docs.example.com/private/first-unbound-secret" },
      },
      {
        ...releaseConfiguration("tenant-a", "provider-b\nprovider-c"),
        source: { url: "https://docs.example.com/private/second-unbound-secret" },
      },
    ] as unknown as ReleasePollConfigurationV1[];
    let openApiCalls = 0;
    let releaseCalls = 0;

    const result = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:00:30.000Z",
      feeds: feeds(1),
      execute: async (feed) => {
        openApiCalls++;
        return { slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const };
      },
      releaseStore: store,
      releaseFeeds: [releaseConfiguration(), ...collisionInputs],
      releaseExecute: async (_store, config) => {
        releaseCalls++;
        return persistedRelease(store, config, "unchanged");
      },
    });

    expect(openApiCalls).toBe(1);
    expect(releaseCalls).toBe(1);
    expect(result).toMatchObject({
      status: "degraded",
      succeeded: 1,
      failed: 0,
      configurationFailed: 2,
      configurationHealth: { status: "degraded", failed: 2 },
      releaseConfigurationFailures: [
        { status: "invalid_configuration", identity: null, configurationBinding: null },
        { status: "invalid_configuration", identity: null, configurationBinding: null },
      ],
      executions: [{ status: "succeeded" }],
      health: { status: "healthy", counts: { healthy: 1, stale: 0, failed: 0 } },
    });
    expect(result.executions).toHaveLength(1);
    const serialized = JSON.stringify(result.releaseConfigurationFailures);
    expect(serialized).not.toContain("first-unbound-secret");
    expect(serialized).not.toContain("second-unbound-secret");
    expect(serialized).not.toContain("tenant-a\\nprovider-b");
  });

  it("reports only-invalid unbound configurations without fabricating schedule counts", async () => {
    const db = fixture();
    const invalid = [
      { ...releaseConfiguration("bad tenant", "provider-a"), source: { url: "https://example.com/secret-a" } },
      { ...releaseConfiguration("tenant-b", "bad provider"), source: { url: "https://example.com/secret-b" } },
    ] as unknown as ReleasePollConfigurationV1[];
    const result = await runFeedSchedules({
      db,
      at: "2026-08-02T12:00:30.000Z",
      feeds: [],
      releaseFeeds: invalid,
    });
    expect(result).toMatchObject({
      status: "degraded",
      claimed: 0,
      succeeded: 0,
      failed: 0,
      alreadyClaimed: 0,
      configurationFailed: 2,
      configurationHealth: { status: "degraded", failed: 2 },
      executions: [],
      health: { status: "healthy", counts: { healthy: 0, stale: 0, failed: 0 } },
    });
    expect(result.releaseConfigurationFailures).toHaveLength(2);
  });

  it.each([
    ["unchanged release and successful OpenAPI", "unchanged", false],
    ["ingested release and successful OpenAPI", "ingested", false],
    ["failed release and failed OpenAPI", "failed", true],
  ] as const)("reports lost terminal authority for %s", async (_case, releaseStatus, openApiFails) => {
    const db = fixture();
    const store = releaseStore();
    const config = releaseConfiguration();
    const releaseResult = releaseStatus === "failed"
      ? { ...unchangedRelease(config), status: "failed" as const, error: "release_poll_executor_failed" as const }
      : persistedRelease(store, config, releaseStatus);

    const result = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:00:30.000Z",
      feeds: feeds(1),
      execute: async (feed) => openApiFails
        ? { slug: feed.slug, url: feed.openapiUrl, status: "error" as const, error: "OpenAPI failure" }
        : { slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const },
      releaseStore: store,
      releaseFeeds: [config],
      releaseExecute: async (_store, _config, schedule) => {
        db.raw.prepare(`UPDATE feed_schedule_windows
          SET status = 'failed', error = 'durable concurrent winner', completed_at = ?
          WHERE schedule_id = ? AND window_started_at = ? AND status = 'running'`)
          .run("2026-08-02T12:00:29.000Z", schedule.id, "2026-08-02T12:00:00.000Z");
        db.raw.prepare(`UPDATE feed_schedules
          SET alert_state = 'failed', consecutive_failures = consecutive_failures + 1,
              last_error = 'durable concurrent winner', updated_at = ? WHERE id = ?`)
          .run("2026-08-02T12:00:29.000Z", schedule.id);
        return releaseResult;
      },
    });

    expect(result).toMatchObject({
      succeeded: 0,
      failed: 1,
      executions: [{
        status: "failed",
        error: "release_poll_schedule_authority_lost",
        openApiOutcome: { status: openApiFails ? "failed" : "succeeded" },
        releaseOutcome: { status: releaseStatus === "failed" ? "failed" : "succeeded" },
      }],
      health: {
        status: "degraded",
        schedules: [{ lastError: "durable concurrent winner", consecutiveFailures: 1 }],
      },
    });
  });

  it.each([
    ["contract version", { contractVersion: "release-poll.v2" }],
    ["tenant", { tenantId: "tenant-spoof" }],
    ["provider", { providerSlug: "provider-spoof" }],
    ["adapter", { adapter: "atom" }],
    ["source", { sourceUrl: "https://docs.example.com/spoofed.xml" }],
    ["source size limit", { sourceMaxBytes: 1024 }],
  ] as const)("rejects a successful release executor with spoofed %s identity", async (_field, patch) => {
    const db = fixture();
    const store = releaseStore();
    const config = releaseConfiguration();
    const spoofed = {
      contractVersion: RELEASE_POLL_CONTRACT_VERSION,
      tenantId: config.tenantId,
      providerSlug: config.provider.slug,
      adapter: config.adapter,
      sourceUrl: durableSourceUrl(config.source.url),
      sourceMaxBytes: null,
      status: "unchanged",
      inserted: 0,
      artifacts: [],
      dispatches: [],
      ...patch,
    } as unknown as ReleasePollResult;

    const result = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:00:30.000Z",
      feeds: feeds(1),
      execute: async (feed) => ({
        slug: feed.slug, url: feed.openapiUrl, status: "unchanged" as const,
      }),
      releaseStore: store,
      releaseFeeds: [config],
      releaseExecute: async () => spoofed,
    });

    expect(result).toMatchObject({
      succeeded: 0,
      failed: 1,
      health: { status: "degraded", counts: { healthy: 0, stale: 0, failed: 1 } },
      executions: [{
        status: "failed",
        poll: { status: "unchanged" },
        error: "release: release_poll_executor_result_invalid",
        openApiOutcome: { status: "succeeded", result: { status: "unchanged" } },
        releaseOutcome: {
          status: "failed",
          error: "release_poll_executor_result_invalid",
          result: {
            status: "invalid_configuration",
            error: "release_poll_executor_result_invalid",
            identity: null,
            configurationBinding: { tenantId: "tenant_default", providerSlug: "provider-1" },
            sourceReference: null,
          },
        },
      }],
    });
  });

  it("retains both source failures and an honest aggregate outcome", async () => {
    const db = fixture();
    const store = releaseStore();
    const config = releaseConfiguration();
    const releaseFailure: ReleasePollResult = {
      contractVersion: RELEASE_POLL_CONTRACT_VERSION,
      tenantId: config.tenantId,
      providerSlug: config.provider.slug,
      adapter: config.adapter,
      sourceUrl: durableSourceUrl(config.source.url),
      sourceMaxBytes: null,
      status: "failed",
      error: "release_poll_executor_failed",
      inserted: 0,
      artifacts: [],
      dispatches: [],
    };

    const result = await runFeedSchedules({
      db,
      tenantId: "tenant_default",
      at: "2026-08-02T12:00:30.000Z",
      feeds: feeds(1),
      execute: async (feed) => ({
        slug: feed.slug, url: feed.openapiUrl, status: "error" as const, error: "OpenAPI HTTP 503",
      }),
      releaseStore: store,
      releaseFeeds: [config],
      releaseExecute: async () => releaseFailure,
    });

    expect(result).toMatchObject({
      succeeded: 0,
      failed: 1,
      executions: [{
        status: "failed",
        poll: { status: "error", error: "OpenAPI HTTP 503" },
        error: "OpenAPI: OpenAPI HTTP 503; release: release_poll_executor_failed",
        openApiOutcome: { status: "failed", error: "OpenAPI HTTP 503" },
        releaseOutcome: { status: "failed", error: "release_poll_executor_failed", result: releaseFailure },
      }],
      health: {
        status: "degraded",
        counts: { healthy: 0, stale: 0, failed: 1 },
        schedules: [{ lastError: "OpenAPI: OpenAPI HTTP 503; release: release_poll_executor_failed" }],
      },
    });
  });
});
