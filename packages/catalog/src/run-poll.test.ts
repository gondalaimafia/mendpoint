import { mkdtempSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, findMonorepoRoot, listVersionsForProvider, getProviderBySlug } from "@mendpoint/db";
import { pollOneFeed } from "./run-poll.js";

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];

afterEach(() => {
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
