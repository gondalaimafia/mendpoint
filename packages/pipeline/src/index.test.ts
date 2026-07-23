import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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
  listAudit,
} from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";
import { MockGitHubDelivery } from "@mendpoint/github";
import { runChangePipeline } from "./index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const acme = join(root, "fixtures/providers/acme-payments");
const shop = join(root, "fixtures/consumers/shop-app");
const dirs: string[] = [];
const dbs: Array<{ raw: { close?: () => void } }> = [];

afterEach(() => {
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

    const ghRoot = join(dir, "gh");
    const report = await runChangePipeline({
      providerSlug: "acme-payments",
      db,
      github: new MockGitHubDelivery(ghRoot),
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
});
