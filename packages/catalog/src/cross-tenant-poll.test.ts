/**
 * Cross-tenant feed-poll isolation (tenant-isolation audit fix, defect 4).
 *
 * POST /feeds/poll runs pollAllFeeds for the CALLING tenant. Previously listPollableFeeds read
 * every provider tenant-blind, so tenant A's poll both listed and WROTE a new version into
 * tenant B's private provider (a globally-unique slug is enough). listPollableFeeds is now
 * tenant-scoped and drops any slug owned privately by another tenant, and ensureProvider
 * refuses to write to a non-visible provider, so A's poll can never read or mutate B's private
 * provider. Reverting listPollableFeeds to the tenant-blind read fails these tests.
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  findMonorepoRoot,
  insertProvider,
  listVersionsForProvider,
  type AppDb,
} from "@mendpoint/db";
import { listPollableFeeds, pollAllFeeds } from "./run-poll.js";

const NOW = "2026-09-23T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    try {
      db.raw.close();
    } catch {
      /* */
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-cross-tenant-poll-"));
  const db = createDb(join(directory, "poll.sqlite"));
  opened.push({ db, directory });
  const root = findMonorepoRoot();
  const spec = join(directory, "spec.json");
  copyFileSync(join(root, "fixtures/providers/acme-payments/openapi-v2.json"), spec);
  const fileUrl = `file:${spec}`;

  db.raw
    .prepare(
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES (?, ?, ?, 'enterprise', 'active', 20, ?)`,
    )
    .run("tenant-a", "tenant-a", "Tenant A", NOW);
  db.raw
    .prepare(
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES (?, ?, ?, 'enterprise', 'active', 20, ?)`,
    )
    .run("tenant-b", "tenant-b", "Tenant B", NOW);

  // B's private provider, pollable by URL (globally-unique slug).
  insertProvider(db, {
    id: "provider-b-private",
    slug: "b-private",
    name: "Provider b-private",
    openapiUrl: fileUrl,
    tenantId: "tenant-b",
    createdAt: NOW,
  });
  // A shared provider A is allowed to poll (positive control).
  insertProvider(db, {
    id: "provider-shared",
    slug: "shared-vendor",
    name: "Provider shared-vendor",
    openapiUrl: fileUrl,
    tenantId: null,
    createdAt: NOW,
  });
  return { db, root };
}

describe("cross-tenant feed-poll isolation", () => {
  it("listPollableFeeds excludes another tenant's private provider but keeps shared ones", () => {
    const { db } = fixture();
    const forA = listPollableFeeds(db, "tenant-a").map((f) => f.slug);
    expect(forA).toContain("shared-vendor");
    expect(forA).not.toContain("b-private");
    // The system enumeration (schedule reconciliation) still sees every provider.
    const system = listPollableFeeds(db).map((f) => f.slug);
    expect(system).toContain("b-private");
    // B itself still sees its own private provider.
    expect(listPollableFeeds(db, "tenant-b").map((f) => f.slug)).toContain("b-private");
  });

  it("tenant A's poll of B's private slug writes nothing to B's provider", async () => {
    const { db, root } = fixture();
    const before = listVersionsForProvider(db, "provider-b-private").length;

    const results = await pollAllFeeds({
      db,
      tenantId: "tenant-a",
      localOnly: true,
      runPipeline: false,
      slugs: ["b-private"],
      monorepoRoot: root,
    });

    // b-private is not in A's pollable set, so nothing is polled …
    expect(results.find((r) => r.slug === "b-private")).toBeUndefined();
    // … and B's private provider is byte-for-byte unchanged.
    expect(listVersionsForProvider(db, "provider-b-private").length).toBe(before);
  });

  it("tenant A can still poll a shared provider (positive control)", async () => {
    const { db, root } = fixture();
    const results = await pollAllFeeds({
      db,
      tenantId: "tenant-a",
      localOnly: true,
      runPipeline: false,
      slugs: ["shared-vendor"],
      monorepoRoot: root,
    });
    const shared = results.find((r) => r.slug === "shared-vendor");
    expect(shared?.status).toBe("new_version");
    expect(listVersionsForProvider(db, "provider-shared").length).toBeGreaterThanOrEqual(1);
  });
});
