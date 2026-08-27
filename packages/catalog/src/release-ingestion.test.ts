import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimReleaseDispatch,
  completeReleaseDispatch,
  failReleaseDispatch,
  ingestReleaseDocument,
  listReleaseArtifacts,
  listReleaseDispatches,
  listReleaseObservations,
  openReleaseIngestionStore,
  recordReleaseReviewerOverride,
  rehydrateReleaseArtifact,
  type ReleaseIngestionStore,
} from "./release-ingestion.js";

const NOW = "2026-08-02T12:00:00.000Z";
const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/releases/${name}`, import.meta.url), "utf8");
const stores: ReleaseIngestionStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* restart tests close one handle early */ }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function store(path = ":memory:", clock: () => string = () => NOW): ReleaseIngestionStore {
  const opened = openReleaseIngestionStore(path, { clock });
  stores.push(opened);
  return opened;
}

function input(adapter: "rss" | "atom" | "github_releases" | "provider_page" | "sdk_registry", body: string) {
  return {
    tenantId: "tenant-a",
    providerSlug: "stripe",
    adapter,
    sourceUrl: adapter === "sdk_registry"
      ? "https://registry.npmjs.org/stripe"
      : "https://docs.stripe.com/changelog/feed",
    body,
    observedAt: NOW,
    now: NOW,
  } as const;
}

function createV1Database(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE release_ingestion_schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
    );
    INSERT INTO release_ingestion_schema_migrations (version, applied_at)
      VALUES (1, '2026-08-01T00:00:00.000Z');
    CREATE TABLE release_ingestion_artifacts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      provider_slug TEXT NOT NULL,
      adapter TEXT NOT NULL,
      collection_url TEXT NOT NULL,
      source_url TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      source_body_sha256 TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT,
      published_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      excerpt_location TEXT NOT NULL,
      confidence REAL NOT NULL,
      change_hints_json TEXT NOT NULL,
      sdk_json TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (tenant_id, adapter, collection_url, source_item_id, content_sha256),
      UNIQUE (id, tenant_id)
    );
    CREATE TABLE release_ingestion_overrides (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      reviewer_principal_id TEXT NOT NULL,
      confidence REAL NOT NULL,
      excerpt TEXT NOT NULL,
      excerpt_location TEXT NOT NULL,
      reason TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      UNIQUE (tenant_id, artifact_id, revision),
      FOREIGN KEY (artifact_id, tenant_id) REFERENCES release_ingestion_artifacts(id, tenant_id)
    );
    CREATE TRIGGER release_ingestion_artifacts_no_update BEFORE UPDATE ON release_ingestion_artifacts
      BEGIN SELECT RAISE(ABORT, 'release_ingestion_artifacts_append_only'); END;
    CREATE TRIGGER release_ingestion_artifacts_no_delete BEFORE DELETE ON release_ingestion_artifacts
      BEGIN SELECT RAISE(ABORT, 'release_ingestion_artifacts_append_only'); END;
    CREATE TRIGGER release_ingestion_overrides_no_update BEFORE UPDATE ON release_ingestion_overrides
      BEGIN SELECT RAISE(ABORT, 'release_ingestion_overrides_append_only'); END;
    CREATE TRIGGER release_ingestion_overrides_no_delete BEFORE DELETE ON release_ingestion_overrides
      BEGIN SELECT RAISE(ABORT, 'release_ingestion_overrides_append_only'); END;
  `);
  db.prepare(`INSERT INTO release_ingestion_artifacts
    (id, tenant_id, provider_slug, adapter, collection_url, source_url, source_item_id,
     source_body_sha256, content_sha256, title, version, published_at, observed_at,
     excerpt, excerpt_location, confidence, change_hints_json, sdk_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("rel_v1", "tenant-v1", "stripe", "rss", "https://docs.stripe.com/changelog/feed",
      "https://docs.stripe.com/changelog/legacy", "legacy", "a".repeat(64), "b".repeat(64),
      "Legacy release", null, "2026-08-01T00:00:00.000Z", "2026-08-01T01:00:00.000Z",
      "Legacy provider wording.", "rss.channel.item[0].description", 0.8, "{}", null,
      "2026-08-01T01:00:00.000Z");
  db.prepare(`INSERT INTO release_ingestion_artifacts
    (id, tenant_id, provider_slug, adapter, collection_url, source_url, source_item_id,
     source_body_sha256, content_sha256, title, version, published_at, observed_at,
     excerpt, excerpt_location, confidence, change_hints_json, sdk_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("rel_v1_replay", "tenant-v1", "stripe", "rss", "https://docs.stripe.com/changelog/feed",
      "https://docs.stripe.com/changelog/legacy", "legacy", "a".repeat(64), "c".repeat(64),
      "Legacy release", null, "2026-08-01T00:00:00.000Z", "2026-08-01T03:00:00.000Z",
      "Legacy provider wording.", "rss.channel.item[0].description", 0.8, "{}", null,
      "2026-08-01T03:00:00.000Z");
  db.prepare(`INSERT INTO release_ingestion_overrides
    (id, tenant_id, artifact_id, revision, reviewer_principal_id, confidence, excerpt,
     excerpt_location, reason, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("rov_v1", "tenant-v1", "rel_v1", 1, "human:v1", 0.9, "Reviewed legacy claim.",
      "review note, line 1", "Preserve during migration", "2026-08-01T02:00:00.000Z");
  db.close();
}

function createVersionZeroDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE release_ingestion_schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
    );
  `);
  db.close();
}

function nextChildMessage(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`release_ingestion_child_exited_${String(code)}`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function spawnStoreOpener(path: string): ChildProcess {
  const moduleUrl = new URL("./release-ingestion.ts", import.meta.url).href;
  const code = `
    import { openReleaseIngestionStore } from ${JSON.stringify(moduleUrl)};
    process.send?.("ready");
    process.once("message", () => {
      process.send?.("starting");
      process.once("message", () => {
        try {
          const opened = openReleaseIngestionStore(process.argv[1]);
          opened.close();
          process.send?.({ status: "ok" }, () => process.disconnect());
        } catch (error) {
          process.send?.(
            { status: "error", error: error instanceof Error ? error.message : String(error) },
            () => process.disconnect(),
          );
        }
      });
    });
  `;
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, path], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  });
}

describe("release ingestion", () => {
  it("normalizes RSS and Atom fixtures with complete source evidence", () => {
    const ledger = store();
    const rss = ingestReleaseDocument(ledger, input("rss", fixture("stripe-rss.xml")));
    const atom = ingestReleaseDocument(ledger, {
      ...input("atom", fixture("openai-atom.xml")),
      providerSlug: "openai",
      sourceUrl: "https://platform.openai.com/docs/changelog.atom",
    });

    expect(rss.inserted).toBe(1);
    expect(rss.artifacts[0]).toMatchObject({
      tenantId: "tenant-a",
      adapter: "rss",
      collectionUrl: "https://docs.stripe.com/changelog/feed",
      sourceUrl: "https://docs.stripe.com/changelog/charges-2026-08-01",
      sourceItemId: "charges-2026-08-01",
      excerptLocation: "rss.channel.item[0].description",
      confidence: 0.9,
      reviewerOverride: null,
    });
    expect(rss.artifacts[0]?.sourceBodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rss.artifacts[0]?.changeHints.replacements).toContainEqual({ from: "amount_cents", to: "amount" });
    expect(atom.artifacts[0]?.sourceItemId).toBe("urn:openai:release:responses-2026-08-01");
    expect(atom.artifacts[0]?.changeHints.replacements).toContainEqual({ from: "max_tokens", to: "max_output_tokens" });
  });

  it("normalizes GitHub releases and a constrained provider page fixture", () => {
    const ledger = store();
    const github = ingestReleaseDocument(ledger, input("github_releases", fixture("github-releases.json")));
    const page = ingestReleaseDocument(ledger, input("provider_page", fixture("provider-page.html")));

    expect(github.artifacts[0]).toMatchObject({
      version: "v3.2.0",
      sourceUrl: "https://github.com/acme/payments/releases/tag/v3.2.0",
      excerptLocation: "github.release[0].body",
    });
    expect(page.artifacts[0]).toMatchObject({
      sourceItemId: "charges-v2",
      sourceUrl: "https://docs.stripe.com/changelog/charges-v2",
      excerptLocation: "provider_page.article[0]",
    });
  });

  it("records SDK version, export, client, runtime, and emitted change evidence", () => {
    const ledger = store();
    const result = ingestReleaseDocument(ledger, input("sdk_registry", fixture("stripe-npm-registry.json")));
    const sdk = result.artifacts[0]?.sdk;

    expect(sdk).toMatchObject({
      ecosystem: "npm",
      packageName: "stripe",
      version: "16.0.0",
      previousVersion: "15.0.0",
      runtimeCompatibility: { previousNode: ">=16", currentNode: ">=18", changed: true },
    });
    expect(sdk?.exportDiff.removed).toEqual(["./legacy"]);
    expect(sdk?.exportDiff.added).toEqual(["./webhooks"]);
    expect(sdk?.clientDiff).toEqual({
      source: "package_exports_proxy",
      ...sdk!.exportDiff,
    });
    expect(sdk?.emittedChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "export_removed", breaking: true, subject: "./legacy" }),
      expect.objectContaining({ kind: "runtime_changed", breaking: true, subject: "node" }),
    ]));
  });

  it("is idempotent, tenant scoped, append only, and durable across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-release-ingestion-"));
    directories.push(directory);
    const path = join(directory, "release.sqlite");
    const first = store(path);
    const document = input("rss", fixture("stripe-rss.xml"));
    expect(ingestReleaseDocument(first, document).inserted).toBe(1);
    expect(ingestReleaseDocument(first, document).inserted).toBe(0);
    expect(ingestReleaseDocument(first, { ...document, tenantId: "tenant-b" }).inserted).toBe(1);
    const artifact = listReleaseArtifacts(first, "tenant-a")[0]!;
    expect(recordReleaseReviewerOverride(first, {
      tenantId: "tenant-a",
      artifactId: artifact.id,
      expectedRevision: 0,
      reviewerPrincipalId: "human:reviewer",
      confidence: 0.98,
      excerpt: "Verified provider wording.",
      excerptLocation: "review note, line 1",
      reason: "Compared with provider migration guide",
      reviewedAt: NOW,
    })).toMatchObject({ status: "applied", artifact: { id: artifact.id } });
    expect(() => recordReleaseReviewerOverride(first, {
      tenantId: "tenant-b",
      artifactId: artifact.id,
      expectedRevision: 1,
      reviewerPrincipalId: "human:reviewer",
      confidence: 0.9,
      excerpt: "Wrong tenant",
      excerptLocation: "review note, line 1",
      reason: "Must fail",
      reviewedAt: NOW,
    })).toThrow("release_artifact_not_found");
    expect(recordReleaseReviewerOverride(first, {
      tenantId: "tenant-a",
      artifactId: artifact.id,
      expectedRevision: 0,
      reviewerPrincipalId: "human:reviewer",
      confidence: 0.9,
      excerpt: "Stale revision",
      excerptLocation: "review note, line 1",
      reason: "Must fail",
      reviewedAt: NOW,
    })).toEqual({ status: "revision_conflict", expectedRevision: 0, actualRevision: 1 });
    expect(() => first.raw.prepare("UPDATE release_ingestion_artifacts SET title = 'changed'").run())
      .toThrow(/release_ingestion_artifacts_append_only/);
    first.close();
    stores.splice(stores.indexOf(first), 1);

    const reopened = store(path);
    expect(listReleaseArtifacts(reopened, "tenant-a")[0]?.reviewerOverride).toMatchObject({
      revision: 1,
      reviewerPrincipalId: "human:reviewer",
      confidence: 0.98,
    });
    expect(listReleaseArtifacts(reopened, "tenant-b")).toHaveLength(1);
    expect(listReleaseArtifacts(reopened, "tenant-c")).toHaveLength(0);
  });

  it("keeps claim identity independent of observation time and appends each observation", () => {
    const ledger = store();
    const document = input("rss", fixture("stripe-rss.xml"));
    const first = ingestReleaseDocument(ledger, document);
    const later = ingestReleaseDocument(ledger, {
      ...document,
      observedAt: "2026-08-02T12:05:00.000Z",
      now: "2026-08-02T12:05:00.000Z",
    });

    expect(first.inserted).toBe(1);
    expect(later.inserted).toBe(0);
    expect(later.artifacts[0]).toEqual(first.artifacts[0]);
    expect(first.artifacts[0]?.normalizedClaimSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(listReleaseObservations(ledger, "tenant-a", first.artifacts[0]!.id))
      .toMatchObject([
        { observedAt: NOW, artifactId: first.artifacts[0]!.id },
        { observedAt: "2026-08-02T12:05:00.000Z", artifactId: first.artifacts[0]!.id },
      ]);
    expect(listReleaseDispatches(ledger, "tenant-a")).toHaveLength(1);
    expect(() => ledger.raw.prepare("UPDATE release_ingestion_observations SET observed_at = 'changed'").run())
      .toThrow(/release_ingestion_observations_append_only/);
    expect(() => ledger.raw.prepare("DELETE FROM release_ingestion_observations").run())
      .toThrow(/release_ingestion_observations_append_only/);
  });

  it("binds artifact identity to the exact provider and collection", () => {
    const ledger = store();
    const document = input("rss", fixture("stripe-rss.xml"));
    const original = ingestReleaseDocument(ledger, document).artifacts[0]!;
    const otherProvider = ingestReleaseDocument(ledger, {
      ...document,
      providerSlug: "stripe-compatible",
    }).artifacts[0]!;
    const otherCollection = ingestReleaseDocument(ledger, {
      ...document,
      sourceUrl: "https://docs.stripe.com/changelog/archive.xml",
    }).artifacts[0]!;

    expect(new Set([original.id, otherProvider.id, otherCollection.id]).size).toBe(3);
    expect(otherProvider.providerSlug).toBe("stripe-compatible");
    expect(otherCollection.collectionUrl).toBe("https://docs.stripe.com/changelog/archive.xml");
    expect(listReleaseArtifacts(ledger, "tenant-a")).toHaveLength(3);
  });

  it("creates a new artifact when the normalized claim changes", () => {
    const ledger = store();
    const body = fixture("stripe-rss.xml");
    const first = ingestReleaseDocument(ledger, input("rss", body)).artifacts[0]!;
    const changed = ingestReleaseDocument(ledger, input("rss", body.replace("amount_cents", "amount_minor"))).artifacts[0]!;

    expect(changed.id).not.toBe(first.id);
    expect(changed.normalizedClaimSha256).not.toBe(first.normalizedClaimSha256);
    expect(listReleaseArtifacts(ledger, "tenant-a")).toHaveLength(2);
    expect(listReleaseDispatches(ledger, "tenant-a")).toHaveLength(2);
  });

  it("converges concurrent ingestion to one artifact and one deterministic dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-release-concurrent-"));
    directories.push(directory);
    const path = join(directory, "release.sqlite");
    const first = store(path);
    const second = store(path);
    const document = input("rss", fixture("stripe-rss.xml"));

    const [left, right] = await Promise.all([
      Promise.resolve().then(() => ingestReleaseDocument(first, document)),
      Promise.resolve().then(() => ingestReleaseDocument(second, document)),
    ]);

    expect(left.artifacts[0]?.id).toBe(right.artifacts[0]?.id);
    expect(left.inserted + right.inserted).toBe(1);
    expect(listReleaseArtifacts(first, "tenant-a")).toHaveLength(1);
    expect(listReleaseDispatches(first, "tenant-a")).toHaveLength(1);
  });

  it("rolls back the artifact when the deterministic dispatch identity is occupied", () => {
    const targetDocument = input("rss", fixture("stripe-rss.xml"));
    const probe = store();
    ingestReleaseDocument(probe, targetDocument);
    const targetDispatchId = listReleaseDispatches(probe, "tenant-a")[0]!.id;

    const ledger = store();
    const differentDocument = {
      ...targetDocument,
      body: targetDocument.body.replace("amount_cents", "amount_minor"),
    };
    ingestReleaseDocument(ledger, differentDocument);
    ledger.raw.prepare("UPDATE release_ingestion_dispatches SET id = ?").run(targetDispatchId);

    expect(() => ingestReleaseDocument(ledger, targetDocument)).toThrow("release_dispatch_write_failed");
    expect(listReleaseArtifacts(ledger, "tenant-a")).toHaveLength(1);
    expect(listReleaseObservations(ledger, "tenant-a", listReleaseArtifacts(ledger, "tenant-a")[0]!.id))
      .toHaveLength(1);
  });

  it("returns one applied reviewer CAS and one explicit revision conflict", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-release-override-"));
    directories.push(directory);
    const path = join(directory, "release.sqlite");
    const first = store(path);
    const artifact = ingestReleaseDocument(first, input("rss", fixture("stripe-rss.xml"))).artifacts[0]!;
    const second = store(path);
    const override = (reviewerPrincipalId: string) => ({
      tenantId: "tenant-a",
      artifactId: artifact.id,
      expectedRevision: 0,
      reviewerPrincipalId,
      confidence: 0.95,
      excerpt: "Verified provider wording.",
      excerptLocation: "review note, line 1",
      reason: "Compared with provider source",
      reviewedAt: NOW,
    });

    const results = await Promise.all([
      Promise.resolve().then(() => recordReleaseReviewerOverride(first, override("human:first"))),
      Promise.resolve().then(() => recordReleaseReviewerOverride(second, override("human:second"))),
    ]);

    expect(results.filter((result) => result.status === "applied")).toHaveLength(1);
    expect(results.filter((result) => result.status === "revision_conflict"))
      .toEqual([{ status: "revision_conflict", expectedRevision: 0, actualRevision: 1 }]);
  });

  it("fences dispatch claims, rehydration, overrides, completion, and failure by tenant and lease", () => {
    let clock = NOW;
    const ledger = store(":memory:", () => clock);
    const tenantA = ingestReleaseDocument(ledger, input("rss", fixture("stripe-rss.xml"))).artifacts[0]!;
    const tenantB = ingestReleaseDocument(ledger, {
      ...input("rss", fixture("stripe-rss.xml")),
      tenantId: "tenant-b",
    }).artifacts[0]!;

    expect(() => rehydrateReleaseArtifact(ledger, {
      tenantId: "tenant-b", artifactId: tenantA.id, expectedContentSha256: tenantA.contentSha256,
    })).toThrow("release_artifact_not_found");
    expect(() => rehydrateReleaseArtifact(ledger, {
      tenantId: "tenant-a", artifactId: tenantA.id, expectedContentSha256: "f".repeat(64),
    })).toThrow("release_artifact_digest_mismatch");
    expect(rehydrateReleaseArtifact(ledger, {
      tenantId: "tenant-a", artifactId: tenantA.id, expectedContentSha256: tenantA.contentSha256,
    }).id).toBe(tenantA.id);
    expect(() => recordReleaseReviewerOverride(ledger, {
      tenantId: "tenant-b", artifactId: tenantA.id, expectedRevision: 0,
      reviewerPrincipalId: "human:wrong", confidence: 0.8, excerpt: "Wrong tenant",
      excerptLocation: "review note", reason: "Must fail", reviewedAt: NOW,
    })).toThrow("release_artifact_not_found");

    const firstClaim = claimReleaseDispatch(ledger, {
      tenantId: "tenant-a", workerId: "worker-a", leaseDurationMs: 1_000,
    })!;
    expect(firstClaim.tenantId).toBe("tenant-a");
    expect(claimReleaseDispatch(ledger, {
      tenantId: "tenant-c", workerId: "worker-c", leaseDurationMs: 1_000,
    })).toBeNull();
    clock = "2026-08-02T12:00:02.000Z";
    const takeover = claimReleaseDispatch(ledger, {
      tenantId: "tenant-a", workerId: "worker-b", leaseDurationMs: 1_000,
    })!;
    expect(takeover.leaseGeneration).toBe(firstClaim.leaseGeneration + 1);
    expect(() => completeReleaseDispatch(ledger, {
      tenantId: "tenant-a", dispatchId: firstClaim.id, workerId: "worker-a",
      leaseGeneration: firstClaim.leaseGeneration,
    })).toThrow("release_dispatch_lease_lost");
    expect(() => completeReleaseDispatch(ledger, {
      tenantId: "tenant-b", dispatchId: takeover.id, workerId: "worker-b",
      leaseGeneration: takeover.leaseGeneration,
    })).toThrow("release_dispatch_lease_lost");
    expect(completeReleaseDispatch(ledger, {
      tenantId: "tenant-a", dispatchId: takeover.id, workerId: "worker-b",
      leaseGeneration: takeover.leaseGeneration,
    }).status).toBe("completed");

    const failureClaim = claimReleaseDispatch(ledger, {
      tenantId: "tenant-b", workerId: "worker-b", leaseDurationMs: 1_000,
    })!;
    expect(() => failReleaseDispatch(ledger, {
      tenantId: "tenant-b", dispatchId: failureClaim.id, workerId: "worker-b",
      leaseGeneration: failureClaim.leaseGeneration + 1,
      failureCode: "provider_unavailable", retryable: false,
    })).toThrow("release_dispatch_lease_lost");
    expect(failReleaseDispatch(ledger, {
      tenantId: "tenant-b", dispatchId: failureClaim.id, workerId: "worker-b",
      leaseGeneration: failureClaim.leaseGeneration,
      failureCode: "provider_unavailable", retryable: false,
    }).status).toBe("failed");
    expect(tenantB.tenantId).toBe("tenant-b");
  });

  it("persists bounded retry and backoff state across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-release-dispatch-retry-"));
    directories.push(directory);
    const path = join(directory, "release.sqlite");
    let clock = NOW;
    let ledger = store(path, () => clock);
    ingestReleaseDocument(ledger, input("rss", fixture("stripe-rss.xml")));

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claim = claimReleaseDispatch(ledger, {
        tenantId: "tenant-a", workerId: `worker-${attempt}`, leaseDurationMs: 10_000,
      })!;
      expect(claim).toMatchObject({ attemptCount: attempt, maxAttempts: 5 });
      const failed = failReleaseDispatch(ledger, {
        tenantId: "tenant-a", dispatchId: claim.id, workerId: `worker-${attempt}`,
        leaseGeneration: claim.leaseGeneration, failureCode: "provider_unavailable", retryable: true,
      });
      expect(failed).toMatchObject({
        status: attempt < 5 ? "pending" : "failed",
        attemptCount: attempt,
        lastFailureAt: clock,
        lastFailureCode: "provider_unavailable",
      });
      if (attempt === 1) {
        ledger.close();
        stores.splice(stores.indexOf(ledger), 1);
        ledger = store(path, () => clock);
        expect(listReleaseDispatches(ledger, "tenant-a")[0]).toMatchObject({
          status: "pending", attemptCount: 1, availableAt: "2026-08-02T12:00:01.000Z",
        });
      }
      if (attempt < 5) {
        expect(claimReleaseDispatch(ledger, {
          tenantId: "tenant-a", workerId: "worker-early", leaseDurationMs: 10_000,
        })).toBeNull();
        clock = failed.availableAt;
      }
    }
    clock = "2026-08-03T12:00:00.000Z";
    expect(claimReleaseDispatch(ledger, {
      tenantId: "tenant-a", workerId: "worker-after-limit", leaseDurationMs: 10_000,
    })).toBeNull();
  });

  it("keeps explicit terminal failures terminal", () => {
    let clock = NOW;
    const ledger = store(":memory:", () => clock);
    ingestReleaseDocument(ledger, input("rss", fixture("stripe-rss.xml")));
    const claim = claimReleaseDispatch(ledger, {
      tenantId: "tenant-a", workerId: "worker-a", leaseDurationMs: 10_000,
    })!;
    expect(failReleaseDispatch(ledger, {
      tenantId: "tenant-a", dispatchId: claim.id, workerId: "worker-a",
      leaseGeneration: claim.leaseGeneration, failureCode: "invalid_payload", retryable: false,
    })).toMatchObject({ status: "failed", failedAt: NOW, failureCode: "invalid_payload" });
    clock = "2026-08-03T12:00:00.000Z";
    expect(claimReleaseDispatch(ledger, {
      tenantId: "tenant-a", workerId: "worker-b", leaseDurationMs: 10_000,
    })).toBeNull();
  });

  it("terminates an expired final attempt instead of leaving an unclaimable lease", () => {
    let clock = NOW;
    const ledger = store(":memory:", () => clock);
    ingestReleaseDocument(ledger, input("rss", fixture("stripe-rss.xml")));
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(claimReleaseDispatch(ledger, {
        tenantId: "tenant-a", workerId: `worker-${attempt}`, leaseDurationMs: 1_000,
      })).toMatchObject({ attemptCount: attempt, status: "claimed" });
      clock = new Date(Date.parse(clock) + 1_000).toISOString();
    }
    expect(claimReleaseDispatch(ledger, {
      tenantId: "tenant-a", workerId: "worker-after-limit", leaseDurationMs: 1_000,
    })).toBeNull();
    expect(listReleaseDispatches(ledger, "tenant-a")[0]).toMatchObject({
      status: "failed",
      attemptCount: 5,
      failedAt: clock,
      failureCode: "dispatch_attempts_exhausted",
      lastFailureCode: "dispatch_attempts_exhausted",
    });
  });

  it("uses only the store clock for lease takeover and completion authority", () => {
    let clock = NOW;
    const ledger = store(":memory:", () => clock);
    ingestReleaseDocument(ledger, input("rss", fixture("stripe-rss.xml")));
    const original = claimReleaseDispatch(ledger, {
      tenantId: "tenant-a", workerId: "worker-a", leaseDurationMs: 1_000,
    })!;
    expect(claimReleaseDispatch(ledger, {
      tenantId: "tenant-a", workerId: "worker-b", leaseDurationMs: 1_000,
      now: "2099-01-01T00:00:00.000Z",
    } as Parameters<typeof claimReleaseDispatch>[1])).toBeNull();

    clock = "2026-08-02T12:00:02.000Z";
    expect(() => completeReleaseDispatch(ledger, {
      tenantId: "tenant-a", dispatchId: original.id, workerId: "worker-a",
      leaseGeneration: original.leaseGeneration, completedAt: "2020-01-01T00:00:00.000Z",
    } as Parameters<typeof completeReleaseDispatch>[1])).toThrow("release_dispatch_lease_lost");
    const takeover = claimReleaseDispatch(ledger, {
      tenantId: "tenant-a", workerId: "worker-b", leaseDurationMs: 1_000,
    })!;
    const completed = completeReleaseDispatch(ledger, {
      tenantId: "tenant-a", dispatchId: takeover.id, workerId: "worker-b",
      leaseGeneration: takeover.leaseGeneration, completedAt: "2020-01-01T00:00:00.000Z",
    } as Parameters<typeof completeReleaseDispatch>[1]);
    expect(completed).toMatchObject({ status: "completed", completedAt: clock });
  });

  it("migrates v1 artifacts and overrides without loss and converges across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-release-v1-"));
    directories.push(directory);
    const path = join(directory, "release.sqlite");
    createV1Database(path);

    const migrated = store(path);
    const artifacts = listReleaseArtifacts(migrated, "tenant-v1");
    const artifact = artifacts.find((candidate) => candidate.id === "rel_v1")!;
    expect(artifacts).toHaveLength(2);
    expect(artifacts.filter((candidate) => candidate.identityCanonical)).toHaveLength(1);
    expect(artifact).toMatchObject({
      id: "rel_v1",
      contentSha256: "b".repeat(64),
      normalizedClaimSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      reviewerOverride: { revision: 1, reviewerPrincipalId: "human:v1" },
    });
    expect(listReleaseObservations(migrated, "tenant-v1", "rel_v1")).toHaveLength(1);
    expect(listReleaseObservations(migrated, "tenant-v1", "rel_v1_replay")).toHaveLength(1);
    expect(listReleaseDispatches(migrated, "tenant-v1")).toHaveLength(1);
    expect(migrated.raw.prepare("SELECT MAX(version) AS version FROM release_ingestion_schema_migrations").get())
      .toEqual({ version: 2 });
    migrated.close();
    stores.splice(stores.indexOf(migrated), 1);

    const restarted = store(path);
    expect(listReleaseArtifacts(restarted, "tenant-v1")).toEqual(artifacts);
    expect(listReleaseObservations(restarted, "tenant-v1", "rel_v1")).toHaveLength(1);
    expect(listReleaseDispatches(restarted, "tenant-v1")).toHaveLength(1);
  });

  it("converges simultaneous first opens of a new database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-release-first-open-"));
    directories.push(directory);
    const path = join(directory, "release.sqlite");
    const children = Array.from({ length: 4 }, () => spawnStoreOpener(path));
    try {
      expect(await Promise.all(children.map(nextChildMessage))).toEqual(Array(4).fill("ready"));
      const starting = children.map(nextChildMessage);
      for (const child of children) child.send("prepare");
      expect(await Promise.all(starting)).toEqual(Array(4).fill("starting"));
      const results = children.map(nextChildMessage);
      for (const child of children) child.send("open");
      expect(await Promise.all(results)).toEqual(Array(4).fill({ status: "ok" }));
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.connected) child.disconnect();
      }
    }
    const converged = store(path);
    expect(converged.raw.prepare(
      "SELECT MAX(version) AS version FROM release_ingestion_schema_migrations",
    ).get()).toEqual({ version: 2 });
  }, 15_000);

  it.each(["version-zero", "version-one"] as const)(
    "serializes concurrent %s schema convergence under the SQLite write lock",
    async (startingVersion) => {
      const directory = mkdtempSync(join(tmpdir(), "mendpoint-release-upgrade-race-"));
      directories.push(directory);
      const path = join(directory, "release.sqlite");
      if (startingVersion === "version-zero") createVersionZeroDatabase(path);
      else createV1Database(path);
      const blocker = new DatabaseSync(path);
      blocker.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
      const children = Array.from({ length: 4 }, () => spawnStoreOpener(path));
      try {
        expect(await Promise.all(children.map(nextChildMessage))).toEqual(Array(4).fill("ready"));
        const starting = children.map(nextChildMessage);
        for (const child of children) child.send("go");
        expect(await Promise.all(starting)).toEqual(Array(4).fill("starting"));
        const results = children.map(nextChildMessage);
        for (const child of children) child.send("open");
        await new Promise((resolve) => setTimeout(resolve, 200));
        blocker.exec("COMMIT");
        expect(await Promise.all(results)).toEqual(Array(4).fill({ status: "ok" }));
      } finally {
        if (blocker.isTransaction) blocker.exec("ROLLBACK");
        blocker.close();
        for (const child of children) {
          if (child.exitCode === null && child.connected) child.disconnect();
        }
      }
      const converged = store(path);
      expect(converged.raw.prepare(
        "SELECT MAX(version) AS version FROM release_ingestion_schema_migrations",
      ).get()).toEqual({ version: 2 });
    },
    15_000,
  );

  it.each([
    ["malformed RSS", "rss", "<rss><channel><item></rss>", /release_xml_malformed/],
    ["ambiguous XML", "rss", "<rss><feed><item></item><entry></entry></feed></rss>", /release_xml_adapter_ambiguous/],
    ["malformed registry", "sdk_registry", "{", /release_json_malformed/],
  ] as const)("fails closed for %s", (_label, adapter, body, error) => {
    const ledger = store();
    expect(() => ingestReleaseDocument(ledger, input(adapter, body))).toThrow(error);
    expect(listReleaseArtifacts(ledger, "tenant-a")).toHaveLength(0);
  });

  it("rejects oversized, stale, unsafe, and ambiguous SDK documents before writing", () => {
    const ledger = store();
    expect(() => ingestReleaseDocument(ledger, input("rss", "x".repeat(1_048_577))))
      .toThrow("release_document_too_large");
    expect(() => ingestReleaseDocument(ledger, {
      ...input("rss", fixture("stripe-rss.xml")),
      observedAt: "2026-07-30T12:00:00.000Z",
    })).toThrow("release_document_stale");
    expect(() => ingestReleaseDocument(ledger, {
      ...input("rss", fixture("stripe-rss.xml")),
      sourceUrl: "http://localhost/feed",
    })).toThrow("release_source_url_unsafe");
    const ambiguous = JSON.parse(fixture("stripe-npm-registry.json"));
    ambiguous["dist-tags"].latest = "99.0.0";
    expect(() => ingestReleaseDocument(ledger, input("sdk_registry", JSON.stringify(ambiguous))))
      .toThrow("sdk_latest_version_missing");
    expect(listReleaseArtifacts(ledger, "tenant-a")).toHaveLength(0);
  });
});
