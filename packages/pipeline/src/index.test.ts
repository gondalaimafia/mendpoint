import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertProvider,
  insertApiVersion,
  insertConsumer,
  insertConsumerRepo,
  insertMonitoredApi,
  listPrs,
  listChanges,
  listFindingsForChange,
  listAudit,
} from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";
import { MockGitHubDelivery } from "@mendpoint/github";
import { runChangePipeline } from "./index.js";
import {
  openGraphLearnMemory,
  resetGraphLearnDbForTests,
  type GraphLearnDb,
} from "@mendpoint/graph-learn";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const acme = join(root, "fixtures/providers/acme-payments");
const shop = join(root, "fixtures/consumers/shop-app");
const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];
const graphDbs: GraphLearnDb[] = [];

function testGraphDb(): GraphLearnDb {
  const graphDb = openGraphLearnMemory();
  graphDbs.push(graphDb);
  return graphDb;
}

function seedProviderVersions() {
  const dir = join(tmpdir(), `mendpoint-pipe-versions-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  const db = createDb(join(dir, "db.sqlite"));
  dbs.push(db);
  const providerId = newId();
  insertProvider(db, {
    id: providerId,
    slug: "acme-payments",
    name: "Acme Payments",
    website: null,
    createdAt: nowIso(),
  });
  for (const [versionLabel, file, publishedAt] of [
    ["1.0.0", "openapi-v1.json", "2026-01-01T00:00:00.000Z"],
    ["2.0.0", "openapi-v2.json", "2026-07-01T00:00:00.000Z"],
  ] as const) {
    insertApiVersion(db, {
      id: newId(),
      providerId,
      versionLabel,
      openapiJson: readFileSync(join(acme, file), "utf8"),
      changelogMd: null,
      publishedAt,
    });
  }
  return db;
}

function addMonitoredConsumer(
  db: ReturnType<typeof createDb>,
  providerId: string,
  input: { name: string; repo: string; localPath: string; tenantId?: string },
) {
  const consumerId = newId();
  insertConsumer(db, {
    id: consumerId,
    name: input.name,
    githubOwner: "org",
    githubRepo: input.repo,
    installationId: null,
    tenantId: input.tenantId ?? "tenant_default",
    createdAt: nowIso(),
  });
  insertConsumerRepo(db, {
    id: newId(),
    consumerId,
    localPath: input.localPath,
    defaultBranch: "main",
    createdAt: nowIso(),
  });
  insertMonitoredApi(db, {
    id: newId(),
    consumerId,
    providerId,
    detectionSource: "manual",
  });
  return consumerId;
}

afterEach(() => {
  resetGraphLearnDbForTests();
  while (graphDbs.length) {
    try {
      graphDbs.pop()?.raw.close();
    } catch {
      /* ignore */
    }
  }
  while (dbs.length) {
    const db = dbs.pop();
    try {
      db?.raw.close?.();
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
        /* Windows may hold file locks briefly */
      }
    }
  }
});


describe("pipeline", () => {
  it("rejects an explicitly requested version that does not exist", async () => {
    const db = seedProviderVersions();
    await expect(
      runChangePipeline({
        tenantId: "tenant_default",
        providerSlug: "acme-payments",
        fromVersionLabel: "missing",
        db,
        graphDb: testGraphDb(),
      }),
    ).rejects.toThrow("Unknown from version missing");
  });

  it("runs end-to-end on fixtures", async () => {
    const dir = join(tmpdir(), `mendpoint-pipe-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const db = createDb(join(dir, "db.sqlite"));
    dbs.push(db);
    const providerId = newId();
    const consumerId = newId();
    insertProvider(db, {
      id: providerId,
      slug: "acme-payments",
      name: "Acme Payments",
      website: null,
      createdAt: nowIso(),
    });
    insertApiVersion(db, {
      id: newId(),
      providerId,
      versionLabel: "1.0.0",
      openapiJson: readFileSync(join(acme, "openapi-v1.json"), "utf8"),
      changelogMd: null,
      publishedAt: "2026-01-01T00:00:00.000Z",
    });
    insertApiVersion(db, {
      id: newId(),
      providerId,
      versionLabel: "2.0.0",
      openapiJson: readFileSync(join(acme, "openapi-v2.json"), "utf8"),
      changelogMd: null,
      publishedAt: "2026-07-01T00:00:00.000Z",
    });
    insertConsumer(db, {
      id: consumerId,
      name: "Shop",
      githubOwner: "org",
      githubRepo: "shop",
      installationId: null,
      tenantId: "tenant_default",
      createdAt: nowIso(),
    });
    insertConsumerRepo(db, {
      id: newId(),
      consumerId,
      localPath: shop,
      defaultBranch: "main",
      createdAt: nowIso(),
    });
    insertMonitoredApi(db, {
      id: newId(),
      consumerId,
      providerId,
      detectionSource: "manual",
    });
    const otherTenantConsumerId = newId();
    insertConsumer(db, {
      id: otherTenantConsumerId,
      name: "Other Tenant Shop",
      githubOwner: "other",
      githubRepo: "shop",
      installationId: null,
      tenantId: "tenant_other",
      createdAt: nowIso(),
    });
    insertConsumerRepo(db, {
      id: newId(),
      consumerId: otherTenantConsumerId,
      localPath: shop,
      defaultBranch: "main",
      createdAt: nowIso(),
    });
    insertMonitoredApi(db, {
      id: newId(),
      consumerId: otherTenantConsumerId,
      providerId,
      detectionSource: "manual",
    });

    const ghRoot = join(dir, "gh");
    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github: new MockGitHubDelivery(ghRoot),
      contractCases: [
        {
          id: "fixture",
          name: "fixture",
          requiredKeys: ["id"],
          responseBody: { id: "ok" },
        },
      ],
      securityScanOk: true,
    });

    expect(report.risk).toBe("breaking");
    expect(report.surfaces).toBeGreaterThan(0);
    expect(report.consumers.length).toBe(1);
    expect(report.consumers[0].findings).toBeGreaterThan(0);
    expect(report.consumers[0].candidates).toBeGreaterThan(0);
    expect(report.consumers[0].prStatus).toBe("open");
    expect(listPrs(db).length).toBe(1);
    expect(listAudit(db).some((a) => a.action === "change.normalized")).toBe(true);
    expect(listAudit(db).some((a) => a.action === "pr.opened")).toBe(true);

    writeFileSync(join(dir, "ok"), "1");
  });

  it("rolls back local edits and blocks delivery when repair verification fails", async () => {
    const dir = join(tmpdir(), `mendpoint-pipe-repair-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const repoDir = join(dir, "shop");
    cpSync(shop, repoDir, { recursive: true });
    const originalPayments = readFileSync(join(repoDir, "src", "payments.ts"), "utf8");
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    const consumerId = newId();
    insertConsumer(db, {
      id: consumerId,
      name: "Repair Shop",
      githubOwner: "org",
      githubRepo: "repair-shop",
      installationId: null,
      tenantId: "tenant_default",
      createdAt: nowIso(),
    });
    insertConsumerRepo(db, {
      id: newId(),
      consumerId,
      localPath: repoDir,
      defaultBranch: "main",
      createdAt: nowIso(),
    });
    insertMonitoredApi(db, {
      id: newId(),
      consumerId,
      providerId: provider.id,
      detectionSource: "manual",
    });
    const deliveryRoot = join(dir, "delivery");
    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github: new MockGitHubDelivery(deliveryRoot),
      agenticRepair: true,
      repairVerifyCommands: ["unsupported"],
      persistIndex: false,
      contractCases: [
        {
          id: "fixture",
          name: "fixture",
          requiredKeys: ["id"],
          responseBody: { id: "ok" },
        },
      ],
      securityScanOk: true,
    });

    expect(report.consumers[0]?.repair?.ok).toBe(false);
    expect(report.consumers[0]?.prStatus).toBe("repair_failed");
    expect(report.consumers[0]?.prUrl).toBeUndefined();
    expect(readFileSync(join(repoDir, "src", "payments.ts"), "utf8")).toBe(originalPayments);
    expect(existsSync(join(deliveryRoot, "org", "repair-shop", "pulls"))).toBe(false);
  });

  it("blocks delivery when contract and security evidence is absent", async () => {
    const dir = join(tmpdir(), `mendpoint-pipe-gates-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const repoDir = join(dir, "shop");
    cpSync(shop, repoDir, { recursive: true });
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    const consumerId = newId();
    insertConsumer(db, {
      id: consumerId,
      name: "Gated Shop",
      githubOwner: "org",
      githubRepo: "gated-shop",
      installationId: null,
      tenantId: "tenant_default",
      createdAt: nowIso(),
    });
    insertConsumerRepo(db, {
      id: newId(),
      consumerId,
      localPath: repoDir,
      defaultBranch: "main",
      createdAt: nowIso(),
    });
    insertMonitoredApi(db, {
      id: newId(),
      consumerId,
      providerId: provider.id,
      detectionSource: "manual",
    });
    const deliveryRoot = join(dir, "delivery");
    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github: new MockGitHubDelivery(deliveryRoot),
      persistIndex: false,
    });
    expect(report.consumers[0]?.prStatus).toBe("gates_failed");
    expect(existsSync(join(deliveryRoot, "org", "gated-shop", "pulls"))).toBe(false);
  });

  it("persists delivery failure and does not duplicate completed consumers on rerun", async () => {
    const dir = join(tmpdir(), `mendpoint-pipe-resume-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, {
      name: "A Shop",
      repo: "a-shop",
      localPath: shop,
    });
    addMonitoredConsumer(db, provider.id, {
      name: "B Shop",
      repo: "b-shop",
      localPath: shop,
    });

    class SelectiveFailureDelivery extends MockGitHubDelivery {
      readonly opened: string[] = [];

      override async openPullRequest(
        owner: string,
        repo: string,
        branch: string,
        title: string,
        body: string,
        base?: string,
      ) {
        this.opened.push(repo);
        if (repo === "b-shop") throw new Error("SCM unavailable");
        return super.openPullRequest(owner, repo, branch, title, body, base);
      }
    }

    const github = new SelectiveFailureDelivery(join(dir, "delivery"));
    const common = {
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      github,
      persistIndex: false,
      contractCases: [
        {
          id: "fixture",
          name: "fixture",
          requiredKeys: ["id"],
          responseBody: { id: "ok" },
        },
      ],
      securityScanOk: true,
    };

    const first = await runChangePipeline({ ...common, graphDb: testGraphDb() });
    expect(first.consumers.map((consumer) => consumer.prStatus)).toEqual([
      "open",
      "delivery_failed",
    ]);
    expect(github.opened).toEqual(["a-shop", "b-shop"]);
    expect(listPrs(db, "tenant_default")).toHaveLength(2);
    expect(listChanges(db)).toHaveLength(1);
    const findingsAfterFirst = listFindingsForChange(
      db,
      first.changeId,
      "tenant_default",
    ).length;

    const second = await runChangePipeline({ ...common, graphDb: testGraphDb() });
    expect(second.changeId).toBe(first.changeId);
    expect(second.consumers.map((consumer) => consumer.prStatus)).toEqual([
      "open",
      "delivery_failed",
    ]);
    expect(github.opened).toEqual(["a-shop", "b-shop"]);
    expect(listPrs(db, "tenant_default")).toHaveLength(2);
    expect(listChanges(db)).toHaveLength(1);
    expect(
      listFindingsForChange(db, first.changeId, "tenant_default"),
    ).toHaveLength(findingsAfterFirst);
  });
});
