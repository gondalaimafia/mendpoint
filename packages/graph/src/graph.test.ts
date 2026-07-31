import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApiChangeGraph } from "./api-surface.js";
import { buildImpactGraph } from "./impact.js";
import {
  createDb,
  findMonorepoRoot,
  insertProvider,
  insertApiVersion,
  insertApiChange,
  insertConsumer,
  insertConsumerRepo,
  insertImpactFinding,
} from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";
import { buildChangeImpactGraph, buildProductKnowledgeGraph } from "./index.js";

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

describe("api change graph", () => {
  it("links rename fields", () => {
    const g = buildApiChangeGraph({
      risk: "breaking",
      summary: "rename amount_cents",
      entries: [
        {
          op: "request_field_renamed",
          path: "/v1/charges",
          method: "post",
          fromField: "amount_cents",
          toField: "amount",
          breaking: true,
        },
      ],
    });
    expect(g.nodes.some((n) => n.kind === "field" && n.label === "amount_cents")).toBe(true);
    expect(g.edges.some((e) => e.kind === "RENAMES_TO")).toBe(true);
  });
});

describe("impact graph", () => {
  it("connects change to findings and files", () => {
    const g = buildImpactGraph({
      changeId: "c1",
      summary: "test change",
      risk: "breaking",
      findings: [
        {
          id: "f1",
          filePath: "src/payments.ts",
          lineStart: 10,
          symbol: "amount_cents",
          confidence: "high",
        },
      ],
      surfaces: [
        {
          id: "s1",
          fromField: "amount_cents",
          toField: "amount",
          path: "/v1/charges",
          op: "request_field_renamed",
        },
      ],
    });
    expect(g.nodes.some((n) => n.kind === "finding")).toBe(true);
    expect(g.edges.some((e) => e.kind === "IMPACTS")).toBe(true);
    expect(g.stats?.nodeCount).toBeGreaterThan(2);
  });
});

describe("product knowledge graph", () => {
  it("projects providers and consumers", () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-prod-"));
    dirs.push(dir);
    const db = createDb(join(dir, "g.sqlite"));
    dbs.push(db);
    insertProvider(db, {
      id: newId(),
      slug: "acme",
      name: "Acme",
      website: null,
      createdAt: nowIso(),
    });
    insertConsumer(db, {
      id: newId(),
      name: "Shop",
      githubOwner: "o",
      githubRepo: "r",
      tenantId: "tenant_default",
      createdAt: nowIso(),
    });
    const g = buildProductKnowledgeGraph(db);
    expect(g.nodes.some((n) => n.kind === "provider")).toBe(true);
    expect(g.nodes.some((n) => n.kind === "consumer")).toBe(true);
  });

  it("does not project another tenant's consumers or installations", () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-tenant-"));
    dirs.push(dir);
    const db = createDb(join(dir, "g.sqlite"));
    dbs.push(db);
    const at = nowIso();
    for (const suffix of ["a", "b"]) {
      insertConsumer(db, {
        id: `consumer-${suffix}`,
        name: `secret-${suffix}`,
        githubOwner: `owner-${suffix}`,
        githubRepo: `repo-${suffix}`,
        tenantId: `tenant-${suffix}`,
        createdAt: at,
      });
      db.raw
        .prepare(
          `INSERT INTO github_installations
           (id, installation_id, account_login, tenant_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          `install-${suffix}`,
          `installation-${suffix}`,
          `account-${suffix}`,
          `tenant-${suffix}`,
          at,
          at,
        );
    }
    const g = buildProductKnowledgeGraph(db, { type: "all" }, "tenant-a");
    expect(g.nodes.some((n) => n.label === "secret-a")).toBe(true);
    expect(g.nodes.some((n) => n.label === "account-a")).toBe(true);
    expect(g.nodes.some((n) => n.label === "secret-b")).toBe(false);
    expect(g.nodes.some((n) => n.label === "account-b")).toBe(false);
  });
});

describe("change impact from db", () => {
  it("builds merged graph for stored change", () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-ch-"));
    dirs.push(dir);
    const db = createDb(join(dir, "c.sqlite"));
    dbs.push(db);
    const pid = newId();
    const v1 = newId();
    const v2 = newId();
    const cid = newId();
    const consId = newId();
    insertProvider(db, {
      id: pid,
      slug: "acme-payments",
      name: "Acme",
      createdAt: nowIso(),
    });
    insertApiVersion(db, {
      id: v1,
      providerId: pid,
      versionLabel: "1.0",
      openapiJson: "{}",
      publishedAt: nowIso(),
    });
    insertApiVersion(db, {
      id: v2,
      providerId: pid,
      versionLabel: "2.0",
      openapiJson: "{\"openapi\":\"3.1.0\"}",
      publishedAt: nowIso(),
    });
    insertApiChange(db, {
      id: cid,
      providerId: pid,
      fromVersionId: v1,
      toVersionId: v2,
      risk: "breaking",
      summary: "amount_cents rename",
      diffJson: JSON.stringify({
        risk: "breaking",
        summary: "amount_cents rename",
        entries: [
          {
            op: "request_field_renamed",
            path: "/v1/charges",
            fromField: "amount_cents",
            toField: "amount",
            breaking: true,
          },
        ],
        surfaces: [
          {
            id: "s1",
            fromField: "amount_cents",
            toField: "amount",
            path: "/v1/charges",
          },
        ],
      }),
      createdAt: nowIso(),
    });
    const root = findMonorepoRoot();
    insertConsumer(db, {
      id: consId,
      name: "Shop",
      githubOwner: "o",
      githubRepo: "shop",
      tenantId: "tenant_default",
      createdAt: nowIso(),
    });
    insertConsumerRepo(db, {
      id: newId(),
      consumerId: consId,
      localPath: join(root, "fixtures/consumers/shop-app"),
      defaultBranch: "main",
      createdAt: nowIso(),
    });
    insertImpactFinding(db, {
      id: newId(),
      changeId: cid,
      consumerId: consId,
      filePath: "src/payments.ts",
      lineStart: 8,
      lineEnd: 8,
      symbol: "amount_cents",
      confidence: "high",
      evidenceJson: "{}",
    });
    const g = buildChangeImpactGraph(db, cid);
    expect(g).not.toBeNull();
    expect(g!.nodes.length).toBeGreaterThan(3);
    expect(g!.edges.length).toBeGreaterThan(0);
    expect(g!.nodes.some((n) => n.kind === "finding" || n.kind === "field")).toBe(true);
    // Merged API+impact graph should retain structural links
    const kinds = new Set(g!.edges.map((e) => e.kind));
    expect(
      kinds.has("IMPACTS") ||
        kinds.has("HAS_SURFACE") ||
        kinds.has("RENAMES_TO") ||
        kinds.has("OP") ||
        kinds.has("BREAKING_OP"),
    ).toBe(true);
  });
});
