import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newId, nowIso, type ImpactCoverage } from "@mendpoint/shared";
import {
  createDb,
  insertApiChange,
  insertApiVersion,
  insertConsumer,
  insertMigrationPr,
  insertProvider,
  listPrsForChange,
  prToApi,
} from "./index.js";

/**
 * §11.7 / §12.4: the coverage/basis of an analysis must survive to the API so a
 * clean result and an unknown one are distinguishable in the console, even for a
 * PR row that carries zero findings. This round-trips the coverage discriminator
 * through insertMigrationPr → migration_prs → prToApi.
 */

const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];

afterEach(() => {
  while (dbs.length) {
    try {
      dbs.pop()?.raw.close?.();
    } catch {
      /* ignore */
    }
  }
  while (dirs.length) {
    const d = dirs.pop();
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore lock races on Windows */
      }
    }
  }
});

function seedChangeAndConsumer(db: ReturnType<typeof createDb>): {
  changeId: string;
  consumerId: string;
} {
  const t0 = nowIso();
  const providerId = newId();
  insertProvider(db, {
    id: providerId,
    slug: "acme",
    name: "Acme",
    website: null,
    createdAt: t0,
  });
  const v1 = newId();
  const v2 = newId();
  insertApiVersion(db, { id: v1, providerId, versionLabel: "1", openapiJson: "{}", publishedAt: t0 });
  insertApiVersion(db, {
    id: v2,
    providerId,
    versionLabel: "2",
    openapiJson: "{\"openapi\":\"3.1.0\"}",
    publishedAt: t0,
  });
  const changeId = newId();
  insertApiChange(db, {
    id: changeId,
    providerId,
    fromVersionId: v1,
    toVersionId: v2,
    risk: "breaking",
    summary: "s",
    diffJson: "[]",
    createdAt: t0,
  });
  const consumerId = newId();
  insertConsumer(db, {
    id: consumerId,
    name: "Shop",
    githubOwner: "acme",
    githubRepo: "shop",
    tenantId: "tenant_default",
    createdAt: t0,
  });
  return { changeId, consumerId };
}

describe("migration_prs coverage persistence", () => {
  it("round-trips the coverage discriminator to the API shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-cov-"));
    dirs.push(dir);
    const db = createDb(join(dir, "c.sqlite"));
    dbs.push(db);
    const { changeId, consumerId } = seedChangeAndConsumer(db);

    const coverage: ImpactCoverage = {
      basis: "partial",
      reason: "1 in-scope source file(s) in language(s) with no analysis front-end: ruby",
      gaps: [{ reason: "unsupported_language", detail: "ruby", count: 1 }],
      filesInspected: 3,
      filesInScope: 3,
      languagesSupported: ["python", "typescript"],
      languagesPresent: ["ruby", "typescript"],
    };

    insertMigrationPr(db, {
      id: newId(),
      changeId,
      consumerId,
      title: "PR with coverage",
      body: "body",
      branchName: "mendpoint/acme",
      status: "low_confidence",
      risk: "breaking",
      patchUnified: "",
      createdAt: nowIso(),
      coverageJson: JSON.stringify(coverage),
    });

    const [row] = listPrsForChange(db, changeId, "tenant_default");
    expect(row).toBeDefined();
    const api = prToApi(row!) as { coverage: ImpactCoverage | null };
    expect(api.coverage).not.toBeNull();
    expect(api.coverage!.basis).toBe("partial");
    expect(api.coverage!.gaps?.[0]?.reason).toBe("unsupported_language");
  });

  it("reads null coverage for a PR written without it (backward compatible)", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-cov-"));
    dirs.push(dir);
    const db = createDb(join(dir, "c.sqlite"));
    dbs.push(db);
    const { changeId, consumerId } = seedChangeAndConsumer(db);

    insertMigrationPr(db, {
      id: newId(),
      changeId,
      consumerId,
      title: "PR without coverage",
      body: "body",
      branchName: "mendpoint/acme",
      status: "open",
      risk: "breaking",
      patchUnified: "",
      createdAt: nowIso(),
    });

    const [row] = listPrsForChange(db, changeId, "tenant_default");
    const api = prToApi(row!) as { coverage: unknown };
    expect(api.coverage).toBeNull();
  });
});
