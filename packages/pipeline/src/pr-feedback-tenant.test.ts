import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  insertApiChange,
  insertApiVersion,
  insertConsumer,
  insertMigrationPr,
  insertProvider,
} from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";
import {
  createTenantGraphView,
  edgesFrom,
  openGraphLearnMemory,
  type GraphLearnDb,
} from "@mendpoint/graph-learn";
import { applyPrFeedback } from "./index.js";

const OUTCOME_KINDS = [
  "OUTCOME_MERGED",
  "OUTCOME_CLOSED",
  "OUTCOME_BROKE",
  "OUTCOME_WAIVED",
] as const;

const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (closers.length) {
    try {
      closers.pop()!();
    } catch {
      /* best-effort cleanup */
    }
  }
  while (dirs.length) {
    try {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeAppDb() {
  const dir = join(tmpdir(), `mendpoint-feedback-${newId()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const db = createDb(join(dir, "db.sqlite"));
  closers.push(() => db.raw.close?.());
  return db;
}

function makeGraphDb(): GraphLearnDb {
  const graphDb = openGraphLearnMemory();
  closers.push(() => graphDb.raw.close());
  return graphDb;
}

/**
 * Seed a consumer + resolved-eligible migration PR for one tenant so that
 * applyPrFeedback can label its outcome.
 */
function seedPr(
  db: ReturnType<typeof makeAppDb>,
  tenantId: string,
): { consumerId: string; changeId: string; prId: string } {
  const consumerId = newId();
  const changeId = newId();
  const prId = newId();
  const providerId = newId();
  const fromVersionId = newId();
  const toVersionId = newId();
  insertProvider(db, {
    id: providerId,
    slug: `acme-${providerId}`,
    name: "Acme",
    website: null,
    createdAt: nowIso(),
  });
  for (const [id, versionLabel] of [
    [fromVersionId, "1.0.0"],
    [toVersionId, "2.0.0"],
  ] as const) {
    insertApiVersion(db, {
      id,
      providerId,
      versionLabel,
      openapiJson: JSON.stringify({ version: versionLabel }),
      changelogMd: null,
      publishedAt: nowIso(),
    });
  }
  insertApiChange(db, {
    id: changeId,
    providerId,
    fromVersionId,
    toVersionId,
    risk: "breaking",
    summary: "rename amount_cents",
    diffJson: "{}",
    createdAt: nowIso(),
  });
  insertConsumer(db, {
    id: consumerId,
    name: `consumer-${tenantId}`,
    githubOwner: "org",
    githubRepo: `repo-${tenantId}`,
    installationId: null,
    tenantId,
    createdAt: nowIso(),
  });
  insertMigrationPr(db, {
    id: prId,
    changeId,
    consumerId,
    title: "rename amount_cents to amount",
    body: "Evidence: **amount_cents** rename.",
    branchName: `mendpoint/${prId}`,
    status: "open",
    risk: "breaking",
    patchUnified: "",
    createdAt: nowIso(),
  });
  return { consumerId, changeId, prId };
}

describe("applyPrFeedback outcome->graph loop is tenant-scoped", () => {
  it("records an outcome that is readable back through the tenant-scoped view", async () => {
    const db = makeAppDb();
    const graphDb = makeGraphDb();
    const { consumerId, changeId, prId } = seedPr(db, "tenant-a");

    await applyPrFeedback(db, prId, "merged", {
      tenantId: "tenant-a",
      graphDb,
    });

    // Read back ONLY through the fail-closed tenant view — a raw table read
    // would pass even with the tenant missing, which is how the defect hid.
    const view = createTenantGraphView(graphDb, { tenantId: "tenant-a" });
    closers.push(() => view.raw.close());
    const edges = edgesFrom(view, `consumer:${consumerId}`, [...OUTCOME_KINDS]);

    expect(edges.length).toBeGreaterThan(0);
    expect(
      edges.some(
        (edge) =>
          edge.kind === "OUTCOME_MERGED" &&
          edge.target === `change:${changeId}`,
      ),
    ).toBe(true);
  });

  it("does not leak tenant A's outcome into tenant B's view", async () => {
    const db = makeAppDb();
    const graphDb = makeGraphDb();
    const { consumerId, prId } = seedPr(db, "tenant-a");

    await applyPrFeedback(db, prId, "merged", {
      tenantId: "tenant-a",
      graphDb,
    });

    const viewB = createTenantGraphView(graphDb, { tenantId: "tenant-b" });
    closers.push(() => viewB.raw.close());
    const leaked = edgesFrom(viewB, `consumer:${consumerId}`, [...OUTCOME_KINDS]);
    expect(leaked).toHaveLength(0);
  });

  it("surfaces (logs) a graph write failure instead of silently swallowing it", async () => {
    const db = makeAppDb();
    const graphDb = makeGraphDb();
    const { prId } = seedPr(db, "tenant-a");

    // Force the graph write to throw by closing the graph db before the call.
    graphDb.raw.close();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // The PR status + audit writes must still succeed; the feedback call must
    // not reject just because the learning write failed (GitHub retries whole
    // deliveries), but the failure must be logged, not swallowed.
    await expect(
      applyPrFeedback(db, prId, "merged", { tenantId: "tenant-a", graphDb }),
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    const logged = errorSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(logged).toContain(prId);
    expect(logged).toContain("tenant-a");
  });
});
