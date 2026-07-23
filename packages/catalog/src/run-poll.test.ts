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
      { db, runPipeline: false, monorepoRoot: root },
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
      { db, runPipeline: false, monorepoRoot: root },
    );
    expect(r2.status).toBe("unchanged");

    const p = getProviderBySlug(db, "acme-payments")!;
    expect(listVersionsForProvider(db, p.id).length).toBeGreaterThanOrEqual(1);
  });
});
