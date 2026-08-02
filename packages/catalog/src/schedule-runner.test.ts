import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, upsertFeedSchedule, type AppDb } from "@mendpoint/db";
import { afterEach, describe, expect, it } from "vitest";
import { runFeedSchedules } from "./schedule-runner.js";
import type { PollableFeed } from "./poll.js";

const opened: Array<{ db: AppDb; directory: string }> = [];

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

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
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
});
