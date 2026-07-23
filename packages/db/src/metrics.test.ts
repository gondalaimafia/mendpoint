import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, insertMigrationPr, recordAudit } from "./index.js";
import { computeProductMetrics } from "./metrics.js";
import { newId, nowIso } from "@mendpoint/shared";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
});

describe("product metrics", () => {
  it("computes funnel rates", () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-"));
    dirs.push(dir);
    const db = createDb(join(dir, "t.sqlite"));
    // skip FKs by raw insert without parent rows — may fail FK
    // use exec to disable FK for test
    db.raw.exec("PRAGMA foreign_keys = OFF");
    const t0 = nowIso();
    insertMigrationPr(db, {
      id: newId(),
      changeId: "c1",
      consumerId: "u1",
      title: "a",
      body: "b",
      branchName: "br",
      status: "merged",
      risk: "breaking",
      patchUnified: "",
      githubPrNumber: 1,
      githubPrUrl: "https://github.com/o/r/pull/1",
      createdAt: t0,
      resolvedAt: new Date(Date.parse(t0) + 7200_000).toISOString(),
    });
    insertMigrationPr(db, {
      id: newId(),
      changeId: "c1",
      consumerId: "u1",
      title: "b",
      body: "b",
      branchName: "br2",
      status: "closed",
      risk: "breaking",
      patchUnified: "",
      createdAt: t0,
      resolvedAt: t0,
    });
    recordAudit(db, {
      actor: "phase-a",
      action: "pr.opened.real",
      resourceType: "migration_pr",
    });
    const m = computeProductMetrics(db);
    expect(m.prsOpened).toBe(2);
    expect(m.prsMerged).toBe(1);
    expect(m.mergeRate).toBe(0.5);
    expect(m.closeWithoutMergeRate).toBe(0.5);
    expect(m.medianTimeToMergeHours).toBe(2);
    expect(m.realGithubPrs).toBe(1);
  });
});
