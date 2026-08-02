import { mkdtempSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  feedPollToApi,
  findMonorepoRoot,
  getProviderBySlug,
  insertProvider,
  listFeedPolls,
  listVersionsForProvider,
} from "@mendpoint/db";
import { pollAllFeeds, pollOneFeed } from "./run-poll.js";

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (dbs.length) {
    try {
      dbs.pop()?.raw.close?.();
    } catch {
      /* */
    }
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  }
});

describe("run-poll", () => {
  it("polls file feed and stores version once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poll-run-"));
    dirs.push(dir);
    const db = createDb(join(dir, "p.sqlite"));
    dbs.push(db);

    const root = findMonorepoRoot();
    const fixture = join(root, "fixtures/providers/acme-payments/openapi-v2.json");
    const local = join(dir, "spec.json");
    copyFileSync(fixture, local);

    const r1 = await pollOneFeed(
      {
        slug: "acme-payments",
        name: "Acme",
        openapiUrl: `file:${local}`,
        source: "catalog",
      },
      { db, tenantId: "tenant_default", runPipeline: false, monorepoRoot: root },
    );
    expect(r1.status).toBe("new_version");
    expect(r1.contentHash).toBeTruthy();

    const r2 = await pollOneFeed(
      {
        slug: "acme-payments",
        name: "Acme",
        openapiUrl: `file:${local}`,
        source: "catalog",
      },
      { db, tenantId: "tenant_default", runPipeline: false, monorepoRoot: root },
    );
    expect(r2.status).toBe("unchanged");

    const p = getProviderBySlug(db, "acme-payments")!;
    expect(listVersionsForProvider(db, p.id).length).toBeGreaterThanOrEqual(1);
    expect(feedPollToApi(listFeedPolls(db)[0]!)).toMatchObject({
      status: "unchanged",
      validation: {
        source: "catalog",
        format: "json",
        formatStatus: "accepted",
        schemaStatus: "accepted",
        status: "accepted",
        contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });

  it("persists rejected validation evidence without creating a version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poll-rejected-"));
    dirs.push(dir);
    const db = createDb(join(dir, "p.sqlite"));
    dbs.push(db);
    const local = join(dir, "invalid.json");
    writeFileSync(local, "not valid json", "utf8");
    const result = await pollOneFeed(
      {
        slug: "invalid-provider",
        name: "Invalid Provider",
        openapiUrl: `file:${local}`,
        source: "provider",
      },
      { db, tenantId: "tenant_default", runPipeline: false },
    );
    expect(result.status).toBe("error");
    expect(feedPollToApi(listFeedPolls(db)[0]!)).toMatchObject({
      status: "error",
      validation: {
        source: "provider",
        format: "unknown",
        formatStatus: "rejected",
        schemaStatus: "not_observed",
        sizeBytes: 14,
        status: "rejected",
        contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        error: expect.stringContaining("not valid JSON"),
      },
    });
    const provider = getProviderBySlug(db, "invalid-provider")!;
    expect(listVersionsForProvider(db, provider.id)).toEqual([]);
  });

  it("retries a failed pipeline without storing a duplicate version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poll-retry-"));
    dirs.push(dir);
    const db = createDb(join(dir, "p.sqlite"));
    dbs.push(db);
    const local = join(dir, "spec.json");
    writeFileSync(
      local,
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Retry", version: "1.0.0" },
        paths: {},
      }),
    );
    const feed = {
      slug: "retry",
      name: "Retry",
      openapiUrl: `file:${local}`,
      source: "provider" as const,
    };
    const failed = await pollOneFeed(feed, {
      db,
      tenantId: "tenant_default",
      pipeline: async () => {
        throw new Error("pipeline failed");
      },
    });
    expect(failed.error).toBe("pipeline failed");

    const retried = await pollOneFeed(feed, {
      db,
      tenantId: "tenant_default",
      pipeline: async () => ({ changeId: "change-1" }),
    });
    expect(retried.status).toBe("pipeline_ran");
    expect(retried.changeId).toBe("change-1");
    const provider = getProviderBySlug(db, "retry")!;
    expect(listVersionsForProvider(db, provider.id)).toHaveLength(1);
  });

  it("records queued pipeline dispatch once for an unchanged feed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poll-queued-"));
    dirs.push(dir);
    const db = createDb(join(dir, "p.sqlite"));
    dbs.push(db);
    const local = join(dir, "spec.json");
    writeFileSync(
      local,
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Queued", version: "1.0.0" },
        paths: {},
      }),
    );
    let dispatches = 0;
    const feed = {
      slug: "queued",
      name: "Queued",
      openapiUrl: `file:${local}`,
      source: "provider" as const,
    };
    const pipeline = async () => {
      dispatches++;
      return { jobId: "job-queued-1" };
    };

    const first = await pollOneFeed(feed, {
      db,
      tenantId: "tenant_default",
      pipeline,
    });
    const second = await pollOneFeed(feed, {
      db,
      tenantId: "tenant_default",
      pipeline,
    });

    expect(first).toMatchObject({
      status: "pipeline_enqueued",
      jobId: "job-queued-1",
    });
    expect(second.status).toBe("unchanged");
    expect(dispatches).toBe(1);
  });

  it("dispatches identical provider content once for each tenant", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poll-tenants-"));
    dirs.push(dir);
    const db = createDb(join(dir, "p.sqlite"));
    dbs.push(db);
    db.raw
      .prepare(
        `INSERT INTO tenants
           (id, slug, name, plan, billing_status, seat_limit, created_at)
         VALUES ('tenant-b', 'tenant-b', 'Tenant B', 'pilot', 'active', 5, ?)`,
      )
      .run(new Date().toISOString());
    const local = join(dir, "spec.json");
    writeFileSync(
      local,
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Tenant dispatch", version: "1.0.0" },
        paths: {},
      }),
    );
    const feed = {
      slug: "tenant-dispatch",
      name: "Tenant dispatch",
      openapiUrl: `file:${local}`,
      source: "provider" as const,
    };
    const dispatches: string[] = [];
    const run = (tenantId: string) =>
      pollOneFeed(feed, {
        db,
        tenantId,
        pipeline: async (_slug, _database, context) => {
          dispatches.push(context.tenantId);
          return { jobId: `job-${context.tenantId}` };
        },
      });

    expect(await run("tenant_default")).toMatchObject({
      status: "pipeline_enqueued",
      jobId: "job-tenant_default",
    });
    expect(await run("tenant-b")).toMatchObject({
      status: "pipeline_enqueued",
      jobId: "job-tenant-b",
    });
    expect((await run("tenant_default")).status).toBe("unchanged");
    expect((await run("tenant-b")).status).toBe("unchanged");
    expect(dispatches).toEqual(["tenant_default", "tenant-b"]);
  });

  it("bounds concurrent feed polling and preserves result order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poll-bounded-"));
    dirs.push(dir);
    const db = createDb(join(dir, "p.sqlite"));
    dbs.push(db);
    const slugs = ["bounded-1", "bounded-2", "bounded-3", "bounded-4"];
    for (const slug of slugs) {
      insertProvider(db, {
        id: `provider-${slug}`,
        slug,
        name: slug,
        website: null,
        openapiUrl: `https://example.test/${slug}.json`,
        changelogUrl: null,
        createdAt: "2026-08-02T00:00:00.000Z",
      });
    }

    let active = 0;
    let maximumActive = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        const slug = new URL(String(input)).pathname.split("/").pop()!.replace(".json", "");
        return new Response(
          JSON.stringify({
            openapi: "3.0.0",
            info: { title: slug, version: "1.0.0" },
            paths: {},
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const results = await pollAllFeeds({
      db,
      tenantId: "tenant_default",
      slugs,
      runPipeline: false,
      concurrency: 2,
    });

    expect(maximumActive).toBe(2);
    expect(results.map((result) => result.slug)).toEqual(slugs);
    expect(results.every((result) => result.status === "new_version")).toBe(true);
  });

  it("serializes concurrent polls for the same feed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "poll-concurrent-"));
    dirs.push(dir);
    const dbPath = join(dir, "p.sqlite");
    const db = createDb(dbPath);
    const db2 = createDb(dbPath);
    dbs.push(db, db2);
    const local = join(dir, "spec.json");
    writeFileSync(
      local,
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Concurrent", version: "1.0.0" },
        paths: {},
      }),
    );
    const feed = {
      slug: "concurrent",
      name: "Concurrent",
      openapiUrl: `file:${local}`,
      source: "provider" as const,
    };
    const results = await Promise.all([
      pollOneFeed(feed, { db, tenantId: "tenant_default", runPipeline: false }),
      pollOneFeed(feed, { db: db2, tenantId: "tenant_default", runPipeline: false }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["new_version", "unchanged"]);
    const provider = getProviderBySlug(db, "concurrent")!;
    expect(listVersionsForProvider(db, provider.id)).toHaveLength(1);
  });
});
