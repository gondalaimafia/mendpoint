import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, upsertFeedSchedule, type AppDb } from "@mendpoint/db";
import { afterEach, describe, expect, it } from "vitest";
import {
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

function unchangedRelease(config: ReleasePollConfigurationV1): ReleasePollResult {
  return {
    contractVersion: config.contractVersion,
    tenantId: config.tenantId,
    providerSlug: config.provider.slug,
    adapter: config.adapter,
    sourceUrl: config.source.url,
    sourceMaxBytes: config.source.maxBytes ?? null,
    status: "unchanged",
    inserted: 0,
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
        fetchImpl: async () => new Response(`<?xml version="1.0"?><rss><channel><item>
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
      sourceUrl: "https://docs.example.com/releases.xml",
      sourceMaxBytes: null,
      status: "failed",
      error: "release HTTP 503",
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
      error: "release: release HTTP 503",
      openApiOutcome: { status: "succeeded", result: { status: "unchanged" } },
      releaseOutcome: { status: "failed", error: "release HTTP 503", result: releaseFailure },
    });
  });

  it("keeps the successful release outcome visible when OpenAPI polling fails", async () => {
    const db = fixture();
    const store = releaseStore();
    const configuredFeeds = feeds(1);
    const releaseSuccess: ReleasePollResult = {
      contractVersion: RELEASE_POLL_CONTRACT_VERSION,
      tenantId: "tenant_default",
      providerSlug: "provider-1",
      adapter: "rss",
      sourceUrl: "https://docs.example.com/releases.xml",
      sourceMaxBytes: null,
      status: "unchanged",
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
    const releaseSuccess: ReleasePollResult = {
      contractVersion: RELEASE_POLL_CONTRACT_VERSION,
      tenantId: "tenant_default",
      providerSlug: "release-only",
      adapter: "rss",
      sourceUrl: config.source.url,
      sourceMaxBytes: null,
      status: "unchanged",
      inserted: 0,
      artifacts: [],
      dispatches: [],
    };

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
        return {
          contractVersion: config.contractVersion,
          tenantId: config.tenantId,
          providerSlug: config.provider.slug,
          adapter: config.adapter,
          sourceUrl: config.source.url,
          sourceMaxBytes: config.source.maxBytes ?? null,
          status: "unchanged",
          inserted: 0,
          artifacts: [],
          dispatches: [],
        };
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
        return unchangedRelease(config);
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
        return unchangedRelease(config);
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
      sourceUrl: config.source.url,
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
        error: "release: release_poll_result_identity_mismatch",
        openApiOutcome: { status: "succeeded", result: { status: "unchanged" } },
        releaseOutcome: {
          status: "failed",
          error: "release_poll_result_identity_mismatch",
          result: spoofed,
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
      sourceUrl: config.source.url,
      sourceMaxBytes: null,
      status: "failed",
      error: "release HTTP 502",
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
        error: "OpenAPI: OpenAPI HTTP 503; release: release HTTP 502",
        openApiOutcome: { status: "failed", error: "OpenAPI HTTP 503" },
        releaseOutcome: { status: "failed", error: "release HTTP 502", result: releaseFailure },
      }],
      health: {
        status: "degraded",
        counts: { healthy: 0, stale: 0, failed: 1 },
        schedules: [{ lastError: "OpenAPI: OpenAPI HTTP 503; release: release HTTP 502" }],
      },
    });
  });
});
