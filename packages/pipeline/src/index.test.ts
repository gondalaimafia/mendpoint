import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getPrincipalBySubject,
  insertPrincipal,
  insertProvider,
  insertApiVersion,
  insertConsumer,
  insertConsumerRepo,
  insertConnectedRepository,
  upsertScmConnection,
  upsertGitHubInstallation,
  insertMonitoredApi,
  insertPolicy,
  getConsumerRepo,
  listCapabilityAdoptionOpportunities,
  listPrs,
  listChanges,
  listFindingsForChange,
  listAudit,
  listArtifactManifests,
  listDomainEvents,
  listEvidenceRecords,
  listSuppressedPatterns,
  verifyAuditIntegrity,
  verifyDomainEventIntegrity,
} from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";
import { MockGitHubDelivery, type GitHubDelivery } from "@mendpoint/github";
import { analyzeImpactWithSoftwareGraph } from "@mendpoint/code-impact";
import {
  changeSubjectDigest,
  issueVerificationWaiver,
  type SecurityScanAttestation,
} from "@mendpoint/contract";
import { applyPrFeedback, createPipelineDeliveryResolver, runChangePipeline } from "./index.js";
import {
  getSoftwareGraphHead,
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

function restrictProviderVersionsToCharges(db: ReturnType<typeof seedProviderVersions>, providerId: string): void {
  for (const [versionLabel, file] of [
    ["1.0.0", "openapi-v1.json"],
    ["2.0.0", "openapi-v2.json"],
  ] as const) {
    const spec = JSON.parse(readFileSync(join(acme, file), "utf8")) as {
      paths: Record<string, unknown>;
    };
    spec.paths = { "/v1/charges": spec.paths["/v1/charges"] };
    db.raw.prepare(
      "UPDATE api_versions SET openapi_json = ? WHERE provider_id = ? AND version_label = ?",
    ).run(JSON.stringify(spec), providerId, versionLabel);
  }
}

function addMonitoredConsumer(
  db: ReturnType<typeof createDb>,
  providerId: string,
  input: {
    name: string;
    repo: string;
    localPath: string;
    tenantId?: string;
    defaultBranch?: string;
    installationId?: string | null;
  },
) {
  const consumerId = newId();
  insertConsumer(db, {
    id: consumerId,
    name: input.name,
    githubOwner: "org",
    githubRepo: input.repo,
    installationId: input.installationId ?? null,
    tenantId: input.tenantId ?? "tenant_default",
    createdAt: nowIso(),
  });
  insertConsumerRepo(db, {
    id: newId(),
    consumerId,
    localPath: input.localPath,
    defaultBranch: input.defaultBranch ?? "main",
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
  it("composes the durable outage queue over the primary production database", () => {
    const db = seedProviderVersions();
    const prior = {
      mode: process.env.GITHUB_MODE,
      appId: process.env.GITHUB_APP_ID,
      key: process.env.GITHUB_APP_PRIVATE_KEY,
    };
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GITHUB_MODE = "real";
    process.env.GITHUB_APP_ID = "4718395";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    try {
      expect(createPipelineDeliveryResolver({
        tenantId: "tenant_default",
        providerSlug: "acme-payments",
        dependencyOutagePolicy: () => { throw new Error("decision_not_expected"); },
      }, db)).toBeTypeOf("function");
      expect(db.raw.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'dependency_outage_operations'",
      ).get()).toEqual({ name: "dependency_outage_operations" });
    } finally {
      if (prior.mode === undefined) delete process.env.GITHUB_MODE;
      else process.env.GITHUB_MODE = prior.mode;
      if (prior.appId === undefined) delete process.env.GITHUB_APP_ID;
      else process.env.GITHUB_APP_ID = prior.appId;
      if (prior.key === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
      else process.env.GITHUB_APP_PRIVATE_KEY = prior.key;
    }
  });
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

  it("relabels a pre-existing 'Warden pipeline' principal to 'Fettler pipeline' via the real pipeline path (production regression)", async () => {
    const db = seedProviderVersions();
    // Production shape: the deterministic pipeline principal was created before
    // the Warden -> Fettler product rename. The identity is (tenant, kind,
    // subject), so runChangePipeline finds it by subject and must relabel it in
    // place instead of dead-lettering every fan-out job on identity conflict.
    insertPrincipal(db, {
      id: "principal-warden-pipeline-seed",
      tenantId: "tenant_default",
      kind: "service",
      subject: "warden-pipeline",
      displayName: "Warden pipeline",
      audience: "pipeline",
      createdAt: nowIso(),
    });
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "shop", localPath: shop });
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-relabel-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);

    await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github: new MockGitHubDelivery(deliveryRoot),
      persistIndex: false,
    });

    expect(getPrincipalBySubject(db, "tenant_default", "service", "warden-pipeline")?.display_name)
      .toBe("Fettler pipeline");
  });

  it("reconstructs complete notification evidence when a worker crashes before handoff", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    const exactVersions = db.raw
      .prepare("SELECT id, version_label FROM api_versions WHERE provider_id = ? ORDER BY published_at, id")
      .all(provider.id) as Array<{ id: string; version_label: string }>;
    insertApiVersion(db, {
      id: newId(),
      providerId: provider.id,
      versionLabel: "3.0.0",
      openapiJson: `${readFileSync(join(acme, "openapi-v1.json"), "utf8")}\n`,
      publishedAt: "2026-08-01T00:00:00.000Z",
    });
    const consumerId = addMonitoredConsumer(db, provider.id, {
      name: "Replay Shop",
      repo: "replay-shop",
      localPath: shop,
    });

    const first = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      fromVersionId: exactVersions[0]!.id,
      fromVersionLabel: exactVersions[0]!.version_label,
      toVersionId: exactVersions[1]!.id,
      toVersionLabel: exactVersions[1]!.version_label,
      db,
      graphDb: testGraphDb(),
      consumerIds: [consumerId],
      notificationsOnly: true,
      persistIndex: false,
      contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
      securityScanAttested: true,
    });
    expect(first.consumers[0]).toMatchObject({
      consumerId,
      prStatus: "notification_only",
      impactReport: expect.objectContaining({ overallConfidence: expect.any(String) }),
    });
    expect(first).toMatchObject({
      fromVersionId: exactVersions[0]!.id,
      toVersionId: exactVersions[1]!.id,
      toVersionLabel: "2.0.0",
    });
    expect(listPrs(db)).toHaveLength(1);

    // This is the exact retry state after the pipeline has persisted its
    // notification row but the worker has not yet committed its agent.run.
    const replay = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      fromVersionId: exactVersions[0]!.id,
      fromVersionLabel: exactVersions[0]!.version_label,
      toVersionId: exactVersions[1]!.id,
      toVersionLabel: exactVersions[1]!.version_label,
      db,
      graphDb: testGraphDb(),
      consumerIds: [consumerId],
      notificationsOnly: true,
      persistIndex: false,
      contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
      securityScanAttested: true,
    });
    expect(replay.changeId).toBe(first.changeId);
    expect(replay.consumers[0]).toMatchObject({
      consumerId,
      prStatus: "notification_only",
      prId: first.consumers[0]!.prId,
      impactReport: expect.objectContaining({
        overallConfidence: first.consumers[0]!.impactReport!.overallConfidence,
      }),
    });
    expect(listPrs(db)).toHaveLength(1);
  });

  it("creates the migration branch from the persisted default branch", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, {
      name: "Trunk Shop",
      repo: "trunk-shop",
      localPath: shop,
      defaultBranch: "trunk",
    });

    class RecordingDelivery extends MockGitHubDelivery {
      readonly sourceBranches: Array<string | undefined> = [];

      override async deliverExactDraft(
        input: Parameters<MockGitHubDelivery["deliverExactDraft"]>[0],
      ): ReturnType<MockGitHubDelivery["deliverExactDraft"]> {
        this.sourceBranches.push(input.baseBranch);
        return super.deliverExactDraft(input);
      }

      override async createBranch(): Promise<void> {
        throw new Error("legacy_create_branch_bypassed_outage_queue");
      }

      override async commitFiles(): Promise<void> {
        throw new Error("legacy_commit_files_bypassed_outage_queue");
      }

      override async openPullRequest(): Promise<never> {
        throw new Error("legacy_open_pull_request_bypassed_outage_queue");
      }
    }

    const deliveryRoot = join(
      tmpdir(),
      `mendpoint-pipe-default-branch-${Date.now()}-${Math.random()}`,
    );
    dirs.push(deliveryRoot);
    const github = new RecordingDelivery(deliveryRoot);
    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
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
      securityScanAttested: true,
    });

    expect(report.consumers[0]?.prStatus, JSON.stringify(report.consumers[0])).toBe("draft");
    expect(github.sourceBranches).toEqual(["trunk"]);
  });

  it("delivers a no-history (content-manifest) repo through main's legacy path, not exact-draft", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    // A clone with no git history resolves a content-manifest revision (a
    // digest, not a commit). Copy the fixture into a tmp dir outside any git
    // repository so `git rev-parse HEAD` fails and revisionKind is content_manifest.
    const cmRepo = join(tmpdir(), `mendpoint-cm-repo-${Date.now()}-${Math.random()}`);
    dirs.push(cmRepo);
    cpSync(shop, cmRepo, { recursive: true });
    rmSync(join(cmRepo, ".git"), { recursive: true, force: true });
    addMonitoredConsumer(db, provider.id, { name: "No-git Shop", repo: "nogit-shop", localPath: cmRepo });

    class LegacyRecordingDelivery extends MockGitHubDelivery {
      readonly calls: string[] = [];
      override async deliverExactDraft(): Promise<never> {
        throw new Error("exact_draft_used_for_content_manifest_repo");
      }
      override async createBranch(...args: Parameters<MockGitHubDelivery["createBranch"]>): Promise<void> {
        this.calls.push("createBranch");
        return super.createBranch(...args);
      }
      override async commitFiles(...args: Parameters<MockGitHubDelivery["commitFiles"]>): Promise<void> {
        this.calls.push("commitFiles");
        return super.commitFiles(...args);
      }
      override async openPullRequest(
        ...args: Parameters<MockGitHubDelivery["openPullRequest"]>
      ): ReturnType<MockGitHubDelivery["openPullRequest"]> {
        this.calls.push("openPullRequest");
        return super.openPullRequest(...args);
      }
    }

    const deliveryRoot = join(tmpdir(), `mendpoint-cm-delivery-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);
    const github = new LegacyRecordingDelivery(deliveryRoot);
    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github,
      persistIndex: false,
      contractCases: [
        { id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } },
      ],
      securityScanAttested: true,
    });

    const consumer = report.consumers.find((c) => c.name === "No-git Shop");
    expect(consumer?.prStatus, JSON.stringify(consumer)).toBe("draft");
    // Delivered exactly as on main: legacy branch/commit/PR, never exact-draft.
    expect(github.calls).toEqual(["createBranch", "commitFiles", "openPullRequest"]);
  });

  it("refreshes an App-bound git base before generation and anchors delivery to the refreshed head", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "shop", localPath: shop, installationId: "12345" });
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-refresh-ok-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);
    const refreshedHead = "c".repeat(40);
    const github = new MockGitHubDelivery(deliveryRoot);
    // The mock enforces the base against the current remote head on a new branch.
    // Setting it to the refreshed head means delivery succeeds ONLY if the
    // pipeline anchored to the refreshed head (headSha), not the stale clone head.
    github.setRemoteBranchHead("org", "shop", "main", refreshedHead);
    const refreshCalls: Array<Record<string, unknown>> = [];
    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github,
      persistIndex: false,
      contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
      securityScanAttested: true,
      refreshRepositoryBase: async (input) => {
        refreshCalls.push({ ...input });
        return { status: "refreshed", headSha: refreshedHead };
      },
    });
    expect(report.consumers[0]?.prStatus, JSON.stringify(report.consumers[0])).toBe("draft");
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]).toMatchObject({
      tenantId: "tenant_default",
      repoRoot: shop,
      owner: "org",
      repo: "shop",
      defaultBranch: "main",
      installationId: "12345",
    });
  });

  it("skips the refresh for a non-App-bound consumer and still delivers", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    // No installation id => not GitHub-App-bound => refresh must not run.
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "shop", localPath: shop, installationId: null });
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-refresh-skip-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);
    let refreshCalled = false;
    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github: new MockGitHubDelivery(deliveryRoot),
      persistIndex: false,
      contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
      securityScanAttested: true,
      refreshRepositoryBase: async () => { refreshCalled = true; return { status: "not_applicable" }; },
    });
    expect(refreshCalled).toBe(false);
    expect(report.consumers[0]?.prStatus, JSON.stringify(report.consumers[0])).toBe("draft");
  });

  it("keeps analysis running and skips only delivery when the base refresh fails", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "shop", localPath: shop, installationId: "12345" });

    class NoDeliveryAllowed extends MockGitHubDelivery {
      override async deliverExactDraft(): Promise<never> {
        throw new Error("delivery_attempted_after_refresh_failure");
      }
      override async createBranch(): Promise<never> {
        throw new Error("delivery_attempted_after_refresh_failure");
      }
    }
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-refresh-fail-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);
    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github: new NoDeliveryAllowed(deliveryRoot),
      persistIndex: false,
      contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
      securityScanAttested: true,
      refreshRepositoryBase: async () => ({ status: "failed", code: "github_repository_base_refresh_fetch_failed" }),
    });
    const consumer = report.consumers[0];
    // Analysis still ran: findings are produced (main would report ~20, not 0).
    expect(consumer?.findings ?? 0).toBeGreaterThan(0);
    // Only delivery was skipped, with the retryable named code and no PR.
    expect(consumer?.prStatus).toBe("delivery_failed");
    expect(consumer?.deliveryError).toBe("github_repository_base_refresh_fetch_failed");
    expect(consumer?.prUrl).toBeUndefined();
  });

  it("drifts (retryable) when the mock base moved, then delivers after the base is current", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "shop", localPath: shop });
    const cloneHead = execFileSync("git", ["-C", shop, "rev-parse", "HEAD"], { encoding: "utf8" })
      .trim().toLowerCase();
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-drift-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);
    const github = new MockGitHubDelivery(deliveryRoot);
    const common = {
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github,
      persistIndex: false,
      contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
      securityScanAttested: true,
    };

    // Attempt 1: the remote default head moved past the clone head → drift.
    github.setRemoteBranchHead("org", "shop", "main", "f".repeat(40));
    const first = await runChangePipeline(common);
    expect(first.consumers[0]?.prStatus).toBe("delivery_failed");
    expect(first.consumers[0]?.prUrl).toBeUndefined();

    // Attempt 2: the base is now current, so the retryable pr re-delivers.
    github.setRemoteBranchHead("org", "shop", "main", cloneHead);
    const second = await runChangePipeline(common);
    expect(second.consumers[0]?.prStatus, JSON.stringify(second.consumers[0])).toBe("draft");
  });

  it("reconciles the same draft branch after a lost delivery response (one PR total)", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "lostshop", localPath: shop });

    // Attempt 1 creates the branch and PR on the remote, then loses the response
    // (the caller never learns it succeeded), so the pipeline records
    // delivery_failed and retries.
    class LostResponseDelivery extends MockGitHubDelivery {
      attempts = 0;
      readonly bodies: string[] = [];
      override async deliverExactDraft(
        input: Parameters<MockGitHubDelivery["deliverExactDraft"]>[0],
      ): ReturnType<MockGitHubDelivery["deliverExactDraft"]> {
        this.attempts += 1;
        this.bodies.push(input.body);
        const result = await super.deliverExactDraft(input);
        if (this.attempts === 1) throw new Error("lost_response_after_create");
        return result;
      }
    }
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-lost-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);
    const github = new LostResponseDelivery(deliveryRoot);
    const common = {
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github,
      persistIndex: false,
      contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
      securityScanAttested: true,
    };

    const first = await runChangePipeline(common);
    expect(first.consumers[0]?.prStatus).toBe("delivery_failed");

    const second = await runChangePipeline(common);
    expect(second.consumers[0]?.prStatus, JSON.stringify(second.consumers[0])).toBe("draft");
    expect(github.attempts).toBe(2);

    // The deterministic branch let attempt 2 reconcile the existing draft: the
    // remote holds exactly one pull request, not a duplicate.
    const pullsDir = join(deliveryRoot, "org", "lostshop", "pulls");
    const pulls = readdirSync(pullsDir).filter((name) => /^[1-9][0-9]*\.json$/.test(name));
    expect(pulls).toHaveLength(1);
    // The replay delivered the byte-identical body of the created draft.
    expect(github.bodies).toHaveLength(2);
    expect(github.bodies[1]).toBe(github.bodies[0]);
  });

  it("reconciles a lost-response PR even after the remote default branch moves (persisted base)", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "movedshop", localPath: shop, installationId: "12345" });
    const baseX = "1".repeat(40);
    const baseY = "2".repeat(40);

    // Attempt 1 anchors to base X, creates the PR, then loses the response. The
    // remote default branch then moves to Y, so the refresh returns Y next time.
    let refreshCalls = 0;
    const refreshRepositoryBase = async () => {
      refreshCalls += 1;
      return { status: "refreshed" as const, headSha: refreshCalls === 1 ? baseX : baseY };
    };
    class LostThenReconcile extends MockGitHubDelivery {
      attempts = 0;
      override async deliverExactDraft(
        input: Parameters<MockGitHubDelivery["deliverExactDraft"]>[0],
      ): ReturnType<MockGitHubDelivery["deliverExactDraft"]> {
        this.attempts += 1;
        const result = await super.deliverExactDraft(input);
        if (this.attempts === 1) throw new Error("lost_response_after_create");
        return result;
      }
    }
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-moved-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);
    const github = new LostThenReconcile(deliveryRoot);
    github.setRemoteBranchHead("org", "movedshop", "main", baseX);
    const common = {
      tenantId: "tenant_default", providerSlug: "acme-payments", db, graphDb: testGraphDb(),
      github, persistIndex: false,
      contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
      securityScanAttested: true, refreshRepositoryBase,
    };

    const first = await runChangePipeline(common);
    expect(first.consumers[0]?.prStatus).toBe("delivery_failed");

    // Remote moves to Y before the retry.
    github.setRemoteBranchHead("org", "movedshop", "main", baseY);
    const second = await runChangePipeline(common);
    // Without the persisted base, attempt 2 would re-anchor to Y and diverge; the
    // persisted base X lets it reconstruct the same commit and reconcile.
    expect(second.consumers[0]?.prStatus, JSON.stringify(second.consumers[0])).toBe("draft");
    expect(second.consumers[0]?.prUrl).toBeTruthy();
    const pulls = readdirSync(join(deliveryRoot, "org", "movedshop", "pulls"))
      .filter((name) => /^[1-9][0-9]*\.json$/.test(name));
    expect(pulls).toHaveLength(1);
    const row = db.raw.prepare("SELECT github_pr_url, delivery_base_sha FROM migration_prs LIMIT 1")
      .get() as { github_pr_url: string | null; delivery_base_sha: string | null };
    expect(row.github_pr_url).toBeTruthy();
    expect(row.delivery_base_sha).toBe(baseX);
  });

  it("keeps the anchor on the first pre-creation failure (no drift), then re-anchors once the base moves (mock, no ledger)", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "precreate", localPath: shop, installationId: "12345" });
    const baseX = "1".repeat(40);
    const baseY = "2".repeat(40);

    // Attempt 1 anchors to base X and persists it, but fails BEFORE the branch
    // is created. No drift has been observed yet (the base equals the refreshed
    // head), so the anchor is KEPT so the identical operation can retry. The
    // remote default head then moves to Y.
    let refreshCalls = 0;
    const refreshRepositoryBase = async () => {
      refreshCalls += 1;
      return { status: "refreshed" as const, headSha: refreshCalls === 1 ? baseX : baseY };
    };
    class PreCreateThenDeliver extends MockGitHubDelivery {
      attempts = 0;
      override async deliverExactDraft(
        input: Parameters<MockGitHubDelivery["deliverExactDraft"]>[0],
      ): ReturnType<MockGitHubDelivery["deliverExactDraft"]> {
        this.attempts += 1;
        if (this.attempts === 1) throw new Error("pre_create_failure");
        return super.deliverExactDraft(input);
      }
    }
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-precreate-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);
    const github = new PreCreateThenDeliver(deliveryRoot);
    github.setRemoteBranchHead("org", "precreate", "main", baseX);
    const common = {
      tenantId: "tenant_default", providerSlug: "acme-payments", db, graphDb: testGraphDb(),
      github, persistIndex: false,
      contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
      securityScanAttested: true, refreshRepositoryBase,
    };

    const first = await runChangePipeline(common);
    expect(first.consumers[0]?.prStatus).toBe("delivery_failed");
    // No drift yet: the anchor is KEPT so the identical operation retries.
    const afterFirst = db.raw.prepare("SELECT delivery_base_sha FROM migration_prs LIMIT 1")
      .get() as { delivery_base_sha: string | null };
    expect(afterFirst.delivery_base_sha).toBe(baseX);

    // Remote moves to Y. Attempt 2 replays base X, the mock drifts (remote head
    // Y != base X) with the branch still absent, so the stale anchor is cleared.
    github.setRemoteBranchHead("org", "precreate", "main", baseY);
    const second = await runChangePipeline(common);
    expect(second.consumers[0]?.prStatus).toBe("delivery_failed");
    const afterSecond = db.raw.prepare("SELECT delivery_base_sha FROM migration_prs LIMIT 1")
      .get() as { delivery_base_sha: string | null };
    expect(afterSecond.delivery_base_sha).toBeNull();

    // Attempt 3 re-anchors to the refreshed head Y and delivers exactly one PR.
    const third = await runChangePipeline(common);
    expect(third.consumers[0]?.prStatus, JSON.stringify(third.consumers[0])).toBe("draft");
    const pulls = readdirSync(join(deliveryRoot, "org", "precreate", "pulls"))
      .filter((name) => /^[1-9][0-9]*\.json$/.test(name));
    expect(pulls).toHaveLength(1);
    const row = db.raw.prepare("SELECT delivery_base_sha FROM migration_prs LIMIT 1")
      .get() as { delivery_base_sha: string | null };
    expect(row.delivery_base_sha).toBe(baseY);
  });

  it("keeps the anchor and records both errors when the branch-existence lookup fails under drift (never clears on unknown)", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "lookupfail", localPath: shop, installationId: "12345" });
    const baseX = "3".repeat(40);
    const baseY = "4".repeat(40);
    let refreshCalls = 0;
    const refreshRepositoryBase = async () => {
      refreshCalls += 1;
      return { status: "refreshed" as const, headSha: refreshCalls === 1 ? baseX : baseY };
    };

    // Delivery always fails, and the branch-existence lookup itself fails, so
    // even under observed drift the anchor must be kept — never cleared on an
    // unknown — with the original error kept as the primary cause and the
    // lookup failure appended.
    class LookupUnavailable extends MockGitHubDelivery {
      override async deliverExactDraft(): Promise<never> {
        throw new Error("transient_delivery_failure");
      }
      override async branchExists(): Promise<boolean> {
        throw new Error("branch_lookup_unavailable");
      }
    }
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-lookupfail-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);
    const github = new LookupUnavailable(deliveryRoot);
    github.setRemoteBranchHead("org", "lookupfail", "main", baseX);
    const common = {
      tenantId: "tenant_default", providerSlug: "acme-payments", db, graphDb: testGraphDb(),
      github, persistIndex: false,
      contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
      securityScanAttested: true, refreshRepositoryBase,
    };
    // Attempt 1 anchors base X (no drift, lookup not consulted).
    const first = await runChangePipeline(common);
    expect(first.consumers[0]?.prStatus).toBe("delivery_failed");
    expect(first.consumers[0]?.deliveryError).toBe("transient_delivery_failure");
    // Attempt 2: remote moved to Y (drift), lookup throws → keep base X.
    const report = await runChangePipeline(common);
    expect(report.consumers[0]?.prStatus).toBe("delivery_failed");
    expect(report.consumers[0]?.deliveryError).toBe(
      "transient_delivery_failure | github_delivery_branch_existence_lookup_failed",
    );
    const row = db.raw.prepare("SELECT delivery_base_sha FROM migration_prs LIMIT 1")
      .get() as { delivery_base_sha: string | null };
    expect(row.delivery_base_sha).toBe(baseX);
  });

  it("keeps the anchor under drift when the transport exposes no branchExists (never clears on unknown)", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "nolookup", localPath: shop, installationId: "12345" });
    const baseX = "5".repeat(40);
    const baseY = "6".repeat(40);
    let refreshCalls = 0;
    const refreshRepositoryBase = async () => {
      refreshCalls += 1;
      return { status: "refreshed" as const, headSha: refreshCalls === 1 ? baseX : baseY };
    };
    // A transport with deliverExactDraft but NO branchExists: under drift the
    // branch state is unknown, so the anchor is kept (never cleared on unknown).
    const deliver = async () => { throw new Error("transient_delivery_failure"); };
    const github = { deliverExactDraft: deliver } as unknown as GitHubDelivery;
    const common = {
      tenantId: "tenant_default", providerSlug: "acme-payments", db, graphDb: testGraphDb(),
      github, persistIndex: false,
      contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
      securityScanAttested: true, refreshRepositoryBase,
    };
    const first = await runChangePipeline(common);
    expect(first.consumers[0]?.prStatus).toBe("delivery_failed");
    // Attempt 2 observes drift but cannot look up the branch → keep base X.
    const second = await runChangePipeline(common);
    expect(second.consumers[0]?.prStatus).toBe("delivery_failed");
    const row = db.raw.prepare("SELECT delivery_base_sha FROM migration_prs LIMIT 1")
      .get() as { delivery_base_sha: string | null };
    expect(row.delivery_base_sha).toBe(baseX);
  });

  it("appends distinct status events for two delivery_failed attempts with different errors (no idempotency conflict)", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "twicefail", localPath: shop });

    class TwoErrors extends MockGitHubDelivery {
      attempts = 0;
      override async deliverExactDraft(): Promise<never> {
        this.attempts += 1;
        throw new Error(this.attempts === 1 ? "first_transient_error" : "second_transient_error");
      }
    }
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-twicefail-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);
    const common = {
      tenantId: "tenant_default", providerSlug: "acme-payments", db, graphDb: testGraphDb(),
      github: new TwoErrors(deliveryRoot), persistIndex: false,
      contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
      securityScanAttested: true,
    };
    const first = await runChangePipeline(common);
    expect(first.consumers[0]?.prStatus).toBe("delivery_failed");
    // The same pr reaches delivery_failed twice with different errors; the status
    // event is keyed by outcome, so the second run must not throw
    // domain_event_idempotency_conflict.
    const second = await runChangePipeline(common);
    expect(second.consumers[0]?.prStatus).toBe("delivery_failed");
    expect(second.consumers[0]?.deliveryError).toBe("second_transient_error");
  });

  it("passes the resolver-validated repository id to the refresher (repository-scoped token)", async () => {
    const prior = { mode: process.env.GITHUB_MODE, appId: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY, bindings: process.env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS };
    try {
      const db = seedProviderVersions();
      const provider = db.raw.prepare("SELECT id FROM providers WHERE slug = ?").get("acme-payments") as { id: string };
      process.env.GITHUB_MODE = "real";
      process.env.GITHUB_APP_ID = "99";
      process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      process.env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS = '{"7123456":"tenant_default"}';
      upsertScmConnection(db, { id: "conn-r1", tenantId: "tenant_default", provider: "github", credentialRef: "github-app://installation/12345", externalAccountId: "12345", displayName: "Org", createdAt: nowIso(), updatedAt: nowIso() });
      insertConnectedRepository(db, { id: "repo-r1", tenantId: "tenant_default", connectionId: "conn-r1", remoteId: "200", owner: "org", name: "scoped-shop", defaultBranch: "main", status: "ready", createdAt: nowIso(), updatedAt: nowIso() });
      upsertGitHubInstallation(db, { id: "inst-r1", installationId: "12345", accountId: "7123456", accountLogin: "org", tenantId: "tenant_default", repositorySelection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write", checks: "read" }, repositories: [{ id: 200, owner: "org", name: "scoped-shop" }], createdAt: nowIso(), updatedAt: nowIso() });
      const cid = addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "scoped-shop", localPath: shop, installationId: "12345" });
      db.raw.prepare("UPDATE consumer_repos SET scm_connection_id = 'conn-r1', connected_repository_id = 'repo-r1' WHERE consumer_id = ?").run(cid);

      const refreshCalls: Array<Record<string, unknown>> = [];
      const report = await runChangePipeline({
        tenantId: "tenant_default", providerSlug: "acme-payments", db, graphDb: testGraphDb(),
        persistIndex: false, dependencyOutagePolicy: () => { throw new Error("decide_not_expected"); },
        contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
        securityScanAttested: true,
        // Return failed so delivery is skipped (no real GitHub call); we only
        // assert the repository id the pipeline threaded into the refresh.
        refreshRepositoryBase: async (input) => { refreshCalls.push({ ...input }); return { status: "failed", code: "github_repository_base_refresh_fetch_failed" }; },
      });
      expect(report.consumers[0]?.prStatus).toBe("delivery_failed");
      expect(refreshCalls).toHaveLength(1);
      // The resolver's validated remote id, not null (installation-wide).
      expect(refreshCalls[0]!.repositoryId).toBe("200");
    } finally {
      for (const [k, v] of Object.entries({ GITHUB_MODE: prior.mode, GITHUB_APP_ID: prior.appId, GITHUB_APP_PRIVATE_KEY: prior.key, GITHUB_APP_ACCOUNT_TENANT_BINDINGS: prior.bindings })) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it("does not mint a refresh token when the delivery resolver rejects the installation (suspended)", async () => {
    const prior = { mode: process.env.GITHUB_MODE, appId: process.env.GITHUB_APP_ID, key: process.env.GITHUB_APP_PRIVATE_KEY, bindings: process.env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS };
    try {
      const db = seedProviderVersions();
      const provider = db.raw.prepare("SELECT id FROM providers WHERE slug = ?").get("acme-payments") as { id: string };
      process.env.GITHUB_MODE = "real";
      process.env.GITHUB_APP_ID = "99";
      process.env.GITHUB_APP_PRIVATE_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      process.env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS = '{"7123456":"tenant_default"}';
      upsertScmConnection(db, { id: "conn-r2", tenantId: "tenant_default", provider: "github", credentialRef: "github-app://installation/12345", externalAccountId: "12345", displayName: "Org", createdAt: nowIso(), updatedAt: nowIso() });
      insertConnectedRepository(db, { id: "repo-r2", tenantId: "tenant_default", connectionId: "conn-r2", remoteId: "200", owner: "org", name: "suspended-shop", defaultBranch: "main", status: "ready", createdAt: nowIso(), updatedAt: nowIso() });
      upsertGitHubInstallation(db, { id: "inst-r2", installationId: "12345", accountId: "7123456", accountLogin: "org", tenantId: "tenant_default", repositorySelection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write", checks: "read" }, repositories: [{ id: 200, owner: "org", name: "suspended-shop" }], createdAt: nowIso(), updatedAt: nowIso() });
      db.raw.prepare("UPDATE github_installations SET suspended_at = '2026-01-01T00:00:00.000Z' WHERE installation_id = '12345'").run();
      const cid = addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "suspended-shop", localPath: shop, installationId: "12345" });
      db.raw.prepare("UPDATE consumer_repos SET scm_connection_id = 'conn-r2', connected_repository_id = 'repo-r2' WHERE consumer_id = ?").run(cid);

      let refreshCalled = false;
      const report = await runChangePipeline({
        tenantId: "tenant_default", providerSlug: "acme-payments", db, graphDb: testGraphDb(),
        persistIndex: false, dependencyOutagePolicy: () => { throw new Error("decide_not_expected"); },
        contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
        securityScanAttested: true,
        refreshRepositoryBase: async () => { refreshCalled = true; return { status: "not_applicable" }; },
      });
      // The resolver's suspension check runs before the refresh, so no token is
      // minted for a rejected installation; delivery fails.
      expect(refreshCalled).toBe(false);
      expect(report.consumers[0]?.prStatus).toBe("delivery_failed");
    } finally {
      for (const [k, v] of Object.entries({ GITHUB_MODE: prior.mode, GITHUB_APP_ID: prior.appId, GITHUB_APP_PRIVATE_KEY: prior.key, GITHUB_APP_ACCOUNT_TENANT_BINDINGS: prior.bindings })) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it("regenerates the full body (with the package section) when a base-refresh failure is followed by success", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "refreshshop", localPath: shop, installationId: "12345" });
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-refresh2s-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);
    const github = new MockGitHubDelivery(deliveryRoot);
    let refreshCalls = 0;
    const common = {
      tenantId: "tenant_default", providerSlug: "acme-payments", db, graphDb: testGraphDb(),
      github, persistIndex: false,
      contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
      securityScanAttested: true,
      refreshRepositoryBase: async () => {
        refreshCalls += 1;
        return refreshCalls === 1
          ? { status: "failed" as const, code: "github_repository_base_refresh_fetch_failed" }
          : { status: "not_applicable" as const };
      },
    };

    // Attempt 1: refresh fails → delivery skipped, no branch/PR, no persisted base.
    const first = await runChangePipeline(common);
    expect(first.consumers[0]?.prStatus).toBe("delivery_failed");

    // Attempt 2: refresh not applicable → fresh delivery, full body regenerated.
    const second = await runChangePipeline(common);
    expect(second.consumers[0]?.prStatus, JSON.stringify(second.consumers[0])).toBe("draft");
    const pullFile = readdirSync(join(deliveryRoot, "org", "refreshshop", "pulls"))
      .find((name) => /^[1-9][0-9]*\.json$/.test(name))!;
    const body = (JSON.parse(readFileSync(join(deliveryRoot, "org", "refreshshop", "pulls", pullFile), "utf8")) as { body: string }).body;
    // The delivered body is the freshly regenerated one, including the required
    // structured package section — never the attempt-1 body that lacked it.
    expect(body).toContain("Structured package artifact:");
  });

  it("emits and persists a capability-adoption opportunity for an unused new capability", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "shop", localPath: shop });
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-capop-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);

    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github: new MockGitHubDelivery(deliveryRoot),
      persistIndex: false,
    });

    // acme v1->v2 adds /v1/balance, which shop-app does not use -> opportunity.
    const opportunities = listCapabilityAdoptionOpportunities(db, "tenant_default", {
      providerSlug: "acme-payments",
    });
    const balance = opportunities.find((o) => o.path === "/v1/balance");
    expect(balance).toBeDefined();
    expect(balance!.adoptingCount).toBe(0);
    expect(balance!.nonAdoptingCount).toBeGreaterThanOrEqual(1);
    expect(balance!.nonAdoptingConsumers.map((cn) => cn.consumerName)).toContain("Shop");
    expect(balance!.suggestedAction).toContain("adopt-PR");
    expect(listAudit(db).some((event) => event.action === "capability.opportunities")).toBe(true);
    // The per-consumer delivery loop still produced its result.
    expect(report.consumers.length).toBe(1);
  });

  it("never fails the pipeline when the capability-adoption step throws", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "shop", localPath: shop });
    // Force persistence inside the capability-adoption step to throw.
    db.raw.exec("DROP TABLE capability_adoption_opportunities");
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-capop-fail-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);

    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github: new MockGitHubDelivery(deliveryRoot),
      persistIndex: false,
      contractCases: [
        { id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } },
      ],
      securityScanAttested: true,
    });

    // Delivery completed despite the capability-adoption step failing.
    expect(report.consumers[0]?.prStatus).toBe("draft");
    expect(
      listAudit(db).some((event) => event.action === "capability.opportunities_failed"),
    ).toBe(true);
  });

  it("abstains from delivery when the graph analyzer fails", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    restrictProviderVersionsToCharges(db, provider.id);
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "shop", localPath: shop });
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-graph-fail-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);

    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github: new MockGitHubDelivery(deliveryRoot),
      persistIndex: false,
      softwareGraphAnalyzer: async () => {
        throw new Error("software_graph_materializer_entity_collision");
      },
      contractCases: [
        { id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } },
      ],
      securityScanAttested: true,
    });

    expect(report.consumers[0]?.prStatus).toBe("package_failed");
    expect(report.consumers[0]?.graphVersionId).toBeUndefined();
    expect(existsSync(join(deliveryRoot, "org", "shop", "pulls"))).toBe(false);
    const analysisFailure = listAudit(db).find((event) => event.action === "graph.analysis_failed");
    expect(analysisFailure).toBeDefined();
    expect(JSON.parse(analysisFailure!.metadata_json!)).toEqual({
      code: "software_graph_materializer_entity_collision",
    });
  });

  it("records a bounded raw-retrieval fallback without advancing the current graph", async () => {
    const dir = join(tmpdir(), `mendpoint-pipe-raw-fallback-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    restrictProviderVersionsToCharges(db, provider.id);
    const consumerId = addMonitoredConsumer(db, provider.id, {
      name: "Fallback Shop",
      repo: "fallback-shop",
      localPath: shop,
    });
    const repositoryId = getConsumerRepo(db, consumerId, "tenant_default")!.id;
    const graphDb = testGraphDb();
    let headAtFallback: ReturnType<typeof getSoftwareGraphHead>;
    const incompleteAnalyzer: typeof analyzeImpactWithSoftwareGraph = async (...args) => {
      const result = await analyzeImpactWithSoftwareGraph(...args);
      headAtFallback = getSoftwareGraphHead(
        graphDb,
        "tenant_default",
        repositoryId,
        provider.id,
      );
      return {
        ...result,
        graphImpact: {
          ...result.graphImpact,
          impact: "unknown_impact" as const,
          coverage: {
            basis: "partial" as const,
            reasons: ["language_parsing:partial"],
            truncated: false,
          },
        },
      };
    };
    const common = {
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb,
      github: new MockGitHubDelivery(join(dir, "delivery")),
      persistIndex: false,
      softwareGraphAnalyzer: incompleteAnalyzer,
      contractCases: [{
        id: "fixture",
        name: "fixture",
        requiredKeys: ["id"],
        responseBody: { id: "ok" },
      }],
      securityScanAttested: true,
    };

    const first = await runChangePipeline(common);

    expect(first.consumers[0]?.prStatus).toBe("draft");
    expect(getSoftwareGraphHead(
      graphDb,
      "tenant_default",
      repositoryId,
      provider.id,
    )).toEqual(headAtFallback);
    const fallbackArtifacts = listArtifactManifests(
      db,
      "tenant_default",
      "fettler-raw-retrieval-fallback",
    );
    expect(fallbackArtifacts).toHaveLength(1);
    const fallback = JSON.parse(fallbackArtifacts[0]!.content_text!) as {
      decision: { outcome: string; reasonCodes: string[]; decisionDigest: string };
      relationshipCandidates: Array<{ status: string; parentGraphVersionId: string }>;
    };
    expect(fallback.decision).toMatchObject({
      outcome: "completed",
      reasonCodes: [
        "graph_projection_change_class_unrepresented",
        "language_parsing:partial",
      ],
    });
    expect(fallback.relationshipCandidates).not.toHaveLength(0);
    expect(fallback.relationshipCandidates.every(
      (candidate) => candidate.status === "pending_validation" &&
        candidate.parentGraphVersionId === headAtFallback?.versionId,
    )).toBe(true);
    expect(listAudit(db, "tenant_default").some(
      (entry) => entry.action === "graph.raw_retrieval_fallback_recorded",
    )).toBe(true);
    const fallbackEvents = listDomainEvents(
      db,
      "tenant_default",
      "api_change",
      first.changeId,
    ).filter((event) => event.event_type === "change_graph.raw_retrieval_recorded");
    expect(fallbackEvents).toHaveLength(1);

    await runChangePipeline(common);

    expect(listArtifactManifests(
      db,
      "tenant_default",
      "fettler-raw-retrieval-fallback",
    )).toHaveLength(1);
    expect(listDomainEvents(
      db,
      "tenant_default",
      "api_change",
      first.changeId,
    ).filter((event) => event.event_type === "change_graph.raw_retrieval_recorded"))
      .toHaveLength(1);
    expect(getSoftwareGraphHead(
      graphDb,
      "tenant_default",
      repositoryId,
      provider.id,
    )).toEqual(headAtFallback);
  }, 15_000);

  it("does not invent a graph when no tenant handle is ready", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, { name: "Shop", repo: "shop", localPath: shop });
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-graph-unavail-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);
    const previous = process.env.GRAPH_LEARN_DB;
    delete process.env.GRAPH_LEARN_DB;
    try {
      const report = await runChangePipeline({
        tenantId: "tenant_default",
        providerSlug: "acme-payments",
        db,
        github: new MockGitHubDelivery(deliveryRoot),
        persistIndex: false,
        contractCases: [
          { id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } },
        ],
        securityScanAttested: true,
      });
      expect(report.consumers[0]?.graphVersionId).toBeUndefined();
      const unavailable = listAudit(db).find((event) => event.action === "graph.handle_unavailable");
      expect(unavailable).toBeDefined();
      expect(JSON.parse(unavailable!.metadata_json!).reason).toBe("path_missing");
      expect(listAudit(db).some((event) => event.action === "graph.updated")).toBe(false);
      const analyzed = listAudit(db).find((event) => event.action === "impact.analyzed");
      expect(analyzed).toBeDefined();
      expect(JSON.parse(analyzed!.metadata_json!).fallback).toBe("raw_retrieval");
    } finally {
      if (previous === undefined) delete process.env.GRAPH_LEARN_DB;
      else process.env.GRAPH_LEARN_DB = previous;
    }
  });

  for (const budgetCase of [
    {
      name: "file",
      bounds: { maxFiles: 1 },
      failureCode: "raw_retrieval_file_budget_exceeded",
      metric: "files",
    },
    {
      name: "byte",
      bounds: { maxBytes: 1 },
      failureCode: "raw_retrieval_byte_budget_exceeded",
      metric: "bytes",
    },
    {
      name: "file byte",
      bounds: { maxFileBytes: 1 },
      failureCode: "raw_retrieval_byte_budget_exceeded",
      metric: "fileBytes",
    },
    {
      name: "candidate",
      bounds: { maxCandidates: 1 },
      failureCode: "raw_retrieval_candidate_budget_exceeded",
      metric: "candidates",
    },
  ] as const) {
    it(`persists an idempotent abstention before delivery on ${budgetCase.name} budget exhaustion`, async () => {
      const db = seedProviderVersions();
      const provider = db.raw
        .prepare("SELECT id FROM providers WHERE slug = ?")
        .get("acme-payments") as { id: string };
      addMonitoredConsumer(db, provider.id, {
        name: `${budgetCase.name} budget shop`,
        repo: `${budgetCase.name}-budget-shop`,
        localPath: shop,
      });
      const deliveryRoot = join(
        tmpdir(),
        `mendpoint-pipe-${budgetCase.name}-budget-${Date.now()}-${Math.random()}`,
      );
      dirs.push(deliveryRoot);
      const priorGraphPath = process.env.GRAPH_LEARN_DB;
      delete process.env.GRAPH_LEARN_DB;
      try {
        const common = {
          tenantId: "tenant_default",
          providerSlug: "acme-payments",
          db,
          github: new MockGitHubDelivery(deliveryRoot),
          persistIndex: false,
          rawRetrievalBounds: budgetCase.bounds,
          contractCases: [{
            id: "fixture",
            name: "fixture",
            requiredKeys: ["id"],
            responseBody: { id: "ok" },
          }],
          securityScanAttested: true,
        };
        const first = await runChangePipeline(common);
        const second = await runChangePipeline(common);

        expect(first.consumers[0]?.prStatus).toBe("package_failed");
        expect(first.consumers[0]?.deliveryError).toBe(budgetCase.failureCode);
        expect(second.consumers[0]?.deliveryError).toBe(budgetCase.failureCode);
        expect(existsSync(join(deliveryRoot, "org"))).toBe(false);
        const artifacts = listArtifactManifests(
          db,
          "tenant_default",
          "fettler-raw-retrieval-fallback",
        );
        expect(artifacts).toHaveLength(1);
        const stored = JSON.parse(artifacts[0]!.content_text!) as {
          decision: {
            outcome: string;
            failureCode: string;
            decisionDigest: string;
            usage: { metric: string; limit: number; actual: number };
            identityUsage: { filesInspected: number; bytesInspected: number };
          };
          relationshipCandidates: unknown[];
        };
        expect(stored.decision).toMatchObject({
          outcome: "abstained",
          failureCode: budgetCase.failureCode,
          usage: { metric: budgetCase.metric },
        });
        expect(stored.decision.usage.actual).toBeGreaterThan(stored.decision.usage.limit);
        if (budgetCase.name === "file") {
          expect(stored.decision.identityUsage.filesInspected).toBeLessThanOrEqual(1);
        }
        if (budgetCase.name === "byte") {
          expect(stored.decision.identityUsage.bytesInspected).toBeLessThanOrEqual(1);
        }
        expect(stored.relationshipCandidates).toEqual([]);
        expect(listEvidenceRecords(db, "tenant_default", "api_change", first.changeId).filter(
          (evidence) => evidence.tool === "mendpoint-raw-retrieval-fallback" &&
            evidence.verdict === "failed",
        )).toHaveLength(1);
        expect(listDomainEvents(db, "tenant_default", "api_change", first.changeId).filter(
          (event) => event.event_type === "change_graph.raw_retrieval_recorded",
        )).toHaveLength(1);
      } finally {
        if (priorGraphPath === undefined) delete process.env.GRAPH_LEARN_DB;
        else process.env.GRAPH_LEARN_DB = priorGraphPath;
      }
    }, 15_000);
  }

  it("persists traversal-depth exhaustion with all five bounds and exact snapshot identity", async () => {
    const dir = join(tmpdir(), `mendpoint-pipe-depth-budget-${Date.now()}-${Math.random()}`);
    const repoDir = join(dir, "shop");
    mkdirSync(join(repoDir, "one", "two"), { recursive: true });
    writeFileSync(
      join(repoDir, "one", "two", "client.ts"),
      'export function createCharge() { return fetch("/v1/charges"); }\n',
      "utf8",
    );
    dirs.push(dir);
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    restrictProviderVersionsToCharges(db, provider.id);
    addMonitoredConsumer(db, provider.id, {
      name: "Depth budget shop",
      repo: "depth-budget-shop",
      localPath: repoDir,
    });
    const previous = process.env.GRAPH_LEARN_DB;
    delete process.env.GRAPH_LEARN_DB;
    try {
      const bounds = {
        maxFiles: 100,
        maxBytes: 1_000_000,
        maxFileBytes: 10_000,
        maxTraversalDepth: 1,
        maxCandidates: 100,
      };
      const common = {
        tenantId: "tenant_default",
        providerSlug: "acme-payments",
        db,
        github: new MockGitHubDelivery(join(dir, "delivery")),
        persistIndex: false,
        rawRetrievalBounds: bounds,
        contractCases: [{
          id: "fixture",
          name: "fixture",
          requiredKeys: ["id"],
          responseBody: { id: "ok" },
        }],
        securityScanAttested: true,
      };
      const first = await runChangePipeline(common);
      const second = await runChangePipeline(common);
      expect(first.consumers[0]?.deliveryError)
        .toBe("raw_retrieval_traversal_depth_budget_exceeded");
      expect(second.consumers[0]?.deliveryError)
        .toBe("raw_retrieval_traversal_depth_budget_exceeded");
      const artifacts = listArtifactManifests(
        db,
        "tenant_default",
        "fettler-raw-retrieval-fallback",
      );
      expect(artifacts).toHaveLength(1);
      const stored = JSON.parse(artifacts[0]!.content_text!) as {
        decision: {
          bounds: typeof bounds;
          usage: { metric: string; limit: number; actual: number };
          repositorySnapshotId: string;
          repositoryRevision: string;
          repositoryContentDigest: string;
          identityUsage: { filesInspected: number; bytesInspected: number };
        };
      };
      expect(stored.decision.bounds).toEqual(bounds);
      expect(stored.decision.usage).toEqual({
        metric: "traversalDepth",
        limit: 1,
        actual: 2,
      });
      expect(stored.decision.repositorySnapshotId).toMatch(/^repository-snapshot:[a-f0-9]{64}$/);
      expect(stored.decision.repositoryRevision).toMatch(/^[a-f0-9]{64}$/);
      expect(stored.decision.repositoryContentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(stored.decision.identityUsage).toEqual({ filesInspected: 0, bytesInspected: 0 });
    } finally {
      if (previous === undefined) delete process.env.GRAPH_LEARN_DB;
      else process.env.GRAPH_LEARN_DB = previous;
    }
  }, 15_000);

  it("binds early budget abstention replay to changed repository content", async () => {
    const dir = join(tmpdir(), `mendpoint-budget-identity-${Date.now()}-${Math.random()}`);
    const repoDir = join(dir, "shop");
    mkdirSync(dir, { recursive: true });
    cpSync(shop, repoDir, { recursive: true });
    dirs.push(dir);
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    restrictProviderVersionsToCharges(db, provider.id);
    addMonitoredConsumer(db, provider.id, {
      name: "Identity budget shop",
      repo: "identity-budget-shop",
      localPath: repoDir,
    });
    const previous = process.env.GRAPH_LEARN_DB;
    delete process.env.GRAPH_LEARN_DB;
    try {
      const common = {
        tenantId: "tenant_default",
        providerSlug: "acme-payments",
        db,
        github: new MockGitHubDelivery(join(dir, "delivery")),
        persistIndex: false,
        rawRetrievalBounds: { maxFiles: 1 },
        contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
        securityScanAttested: true,
      };
      const first = await runChangePipeline(common);
      const readDecisions = () => listArtifactManifests(
        db,
        "tenant_default",
        "fettler-raw-retrieval-fallback",
      ).map((artifact) => (JSON.parse(artifact.content_text!) as {
        decision: {
          decisionDigest: string;
          repositorySnapshotId: string;
          repositoryRevision: string;
          repositoryContentDigest: string;
        };
      }).decision);
      const firstDecision = readDecisions()[0]!;
      const readmePath = join(repoDir, "check.mjs");
      const before = readFileSync(readmePath, "utf8");
      const replacement = before.startsWith("A") ? "B" : "A";
      writeFileSync(readmePath, `${replacement}${before.slice(1)}`, "utf8");
      expect(readFileSync(readmePath).byteLength).toBe(Buffer.byteLength(before));

      const second = await runChangePipeline(common);
      const decisions = readDecisions();
      expect(first.consumers[0]?.deliveryError).toBe("raw_retrieval_file_budget_exceeded");
      expect(second.consumers[0]?.deliveryError).toBe("raw_retrieval_file_budget_exceeded");
      expect(decisions).toHaveLength(2);
      expect(new Set(decisions.map((decision) => decision.decisionDigest))).toHaveLength(2);
      expect(new Set(decisions.map((decision) => decision.repositorySnapshotId))).toHaveLength(2);
      expect(new Set(decisions.map((decision) => decision.repositoryRevision))).toHaveLength(2);
      expect(new Set(decisions.map((decision) => decision.repositoryContentDigest))).toHaveLength(2);
      expect(decisions).toContainEqual(firstDecision);
      expect(listEvidenceRecords(db, "tenant_default", "api_change", first.changeId).filter(
        (evidence) => evidence.tool === "mendpoint-raw-retrieval-fallback",
      )).toHaveLength(2);
      expect(listDomainEvents(db, "tenant_default", "api_change", first.changeId).filter(
        (event) => event.event_type === "change_graph.raw_retrieval_recorded",
      )).toHaveLength(2);
    } finally {
      if (previous === undefined) delete process.env.GRAPH_LEARN_DB;
      else process.env.GRAPH_LEARN_DB = previous;
    }
  }, 15_000);

  it("applies the same bounds when a change has no endpoint surface", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, {
      name: "No endpoint shop",
      repo: "no-endpoint-shop",
      localPath: shop,
    });
    const v1 = readFileSync(join(acme, "openapi-v1.json"), "utf8");
    db.raw.prepare(
      "UPDATE api_versions SET openapi_json = ? WHERE provider_id = ? AND version_label = ?",
    ).run(`${v1}\n`, provider.id, "2.0.0");
    const priorGraphPath = process.env.GRAPH_LEARN_DB;
    delete process.env.GRAPH_LEARN_DB;
    try {
      const report = await runChangePipeline({
        tenantId: "tenant_default",
        providerSlug: "acme-payments",
        db,
        graphDb: testGraphDb(),
        github: new MockGitHubDelivery(join(tmpdir(), `mendpoint-no-endpoint-${Date.now()}`)),
        persistIndex: false,
        rawRetrievalBounds: { maxFiles: 1 },
        contractCases: [],
        securityScanAttested: true,
      });
      expect(report.surfaces).toBe(0);
      expect(report.consumers[0]?.deliveryError).toBe("raw_retrieval_file_budget_exceeded");
    } finally {
      if (priorGraphPath === undefined) delete process.env.GRAPH_LEARN_DB;
      else process.env.GRAPH_LEARN_DB = priorGraphPath;
    }
  });

  it("fails closed before SCM delivery when reviewer ownership is incomplete", async () => {
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    const consumerId = addMonitoredConsumer(db, provider.id, {
      name: "Unowned Shop",
      repo: "unowned-shop",
      localPath: shop,
    });
    insertPolicy(db, {
      id: newId(),
      consumerId,
      key: "pr_reviewer_principal_ids",
      valueJson: "[]",
    });
    const deliveryRoot = join(tmpdir(), `mendpoint-pipe-unowned-${Date.now()}-${Math.random()}`);
    dirs.push(deliveryRoot);

    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github: new MockGitHubDelivery(deliveryRoot),
      persistIndex: false,
      contractCases: [{ id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } }],
      securityScanAttested: true,
    });

    expect(report.consumers[0]?.prStatus).toBe("package_failed");
    expect(existsSync(join(deliveryRoot, "org", "unowned-shop", "pulls"))).toBe(false);
    expect(listAudit(db).some((event) => event.action === "pr.package_failed")).toBe(true);
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
    const consumerRepoId = newId();
    insertConsumerRepo(db, {
      id: consumerRepoId,
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
    const graphDb = testGraphDb();
    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb,
      github: new MockGitHubDelivery(ghRoot),
      contractCases: [
        {
          id: "fixture",
          name: "fixture",
          requiredKeys: ["id"],
          responseBody: { id: "ok" },
        },
      ],
      securityScanAttested: true,
    });

    expect(report.risk).toBe("breaking");
    expect(report.surfaces).toBeGreaterThan(0);
    expect(report.consumers.length).toBe(1);
    expect(report.consumers[0].findings).toBeGreaterThan(0);
    expect(report.consumers[0].candidates).toBeGreaterThan(0);
    expect(report.consumers[0].graphVersionId).toBeUndefined();
    expect(getSoftwareGraphHead(
      graphDb,
      "tenant_default",
      consumerRepoId,
      providerId,
    )).toBeUndefined();
    expect(report.consumers[0].graphContextArtifactId).toBeUndefined();
    expect(report.consumers[0].prStatus).toBe("draft");
    expect(listPrs(db).length).toBe(1);
    expect(listAudit(db).some((a) => a.action === "change.normalized")).toBe(true);
    expect(listAudit(db).some((a) => a.action === "pr.draft_opened")).toBe(true);
    const graphAnalyzed = listAudit(db).find((event) => event.action === "impact.analyzed");
    expect(graphAnalyzed).toBeDefined();
    expect(JSON.parse(graphAnalyzed!.metadata_json!).fallback).toBe("raw_retrieval");
    const storedFindings = listFindingsForChange(db, report.changeId, "tenant_default")
      .map((finding) => JSON.parse(finding.evidence_json) as {
        surfaceIds?: string[];
        relatedOps?: string[];
      });
    expect(storedFindings.length).toBeGreaterThan(0);
    expect(storedFindings.every(
      (finding) => (finding.surfaceIds?.length ?? 0) < report.surfaces,
    )).toBe(true);
    expect(storedFindings.some(
      (finding) => !(finding.relatedOps ?? []).includes("path_added"),
    )).toBe(true);

    const prId = report.consumers[0].prId!;
    const artifacts = listArtifactManifests(db, "tenant_default");
    expect(artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining([
        "change-source-openapi",
        "candidate-edit",
        "verification-result",
        "structured-pr-package",
      ]),
    );
    expect(artifacts.some((artifact) => artifact.kind === "fettler-change-graph-context"))
      .toBe(false);
    expect(artifacts.every((artifact) => artifact.content_text)).toBe(true);
    const structuredPackage = JSON.parse(
      artifacts.find((artifact) => artifact.kind === "structured-pr-package")!.content_text!,
    ) as { snapshot: { revisionKind: string; resolvedSha: string } };
    expect(structuredPackage.snapshot.revisionKind).toBe("git_commit");
    expect(structuredPackage.snapshot.resolvedSha).toMatch(/^[a-f0-9]{40}$/);
    const evidence = listEvidenceRecords(
      db,
      "tenant_default",
      "migration_pr",
      prId,
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0].verdict).toBe("passed");
    expect(listArtifactManifests(db, "tenant_other")).toEqual([]);
    expect(
      listDomainEvents(db, "tenant_default", "api_change", report.changeId).map(
        (event) => event.event_type,
      ),
    ).not.toContain("change_graph.context_recorded");
    expect(listDomainEvents(db, "tenant_default", "migration_pr", prId).map((event) => event.event_type)).toEqual([
      "migration_pr.candidate_recorded",
      "migration_pr.package_recorded",
      "migration_pr.draft",
    ]);
    const delivered = JSON.parse(
      readFileSync(join(ghRoot, "org", "shop", "pulls", "1.json"), "utf8"),
    ) as { draft: boolean; body: string };
    expect(delivered.draft).toBe(true);
    expect(delivered.body).toContain("### Structured Fettler draft package");
    expect(delivered.body).toContain("#### Exact files");
    expect(delivered.body).toContain("#### Verification results");
    expect(delivered.body).toContain("Automatic merge: disabled");
    expect(delivered.body).toContain("Automatic deployment: disabled");
    expect(delivered.body).not.toContain("### Change Graph evidence");
    // Gap 2 provenance: the caller-attested security scan reaches the PR evidence
    // labelled as an attestation, never as an independently verified result.
    expect(delivered.body).toContain("**security-scan** _(attested, not verified)_");
    expect(delivered.body).toContain(
      "Gates marked _(attested, not verified)_ reflect a caller-supplied assertion",
    );
    expect(verifyDomainEventIntegrity(db, "tenant_default").ok).toBe(true);
    expect(verifyAuditIntegrity(db, "tenant_default").ok).toBe(true);
    await applyPrFeedback(db, prId, "closed", {
      tenantId: "tenant_default",
      graphDb,
    });
    const suppressionCount = listSuppressedPatterns(db, {
      tenantId: "tenant_default",
    }).length;
    await applyPrFeedback(db, prId, "closed", {
      tenantId: "tenant_default",
      graphDb,
    });
    expect(listSuppressedPatterns(db, { tenantId: "tenant_default" })).toHaveLength(
      suppressionCount,
    );
    expect(
      listAudit(db).filter((event) => event.action === "pr.feedback.closed"),
    ).toHaveLength(1);
    expect(
      listAudit(db).filter((event) => event.action === "patterns.suppressed"),
    ).toHaveLength(1);

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
      securityScanAttested: true,
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

    const signingKey = "test-waiver-signing-key-with-sufficient-entropy";
    const issuedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const waiver = issueVerificationWaiver(
      {
        waiverId: "waiver-gated-shop",
        scope: {
          tenantId: "tenant_default",
          runId: "run-gated-shop",
          checkId: "delivery-verification",
        },
        issuedBy: { kind: "human", id: "reviewer-1" },
        reason: "The provider test environment is unavailable for this bounded pilot run.",
        issuedAt,
        expiresAt,
      },
      signingKey,
      { requireHumanActor: true },
    );
    const waived = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github: new MockGitHubDelivery(deliveryRoot),
      persistIndex: false,
      verificationWaiver: { runId: "run-gated-shop", waiver, signingKey },
    });
    expect(waived.consumers[0]?.prStatus).toBe("draft");
    expect(existsSync(join(deliveryRoot, "org", "gated-shop", "pulls"))).toBe(true);
    expect(
      listArtifactManifests(db, "tenant_default").some(
        (artifact) => artifact.kind === "verification-waiver",
      ),
    ).toBe(true);
    expect(
      listEvidenceRecords(db, "tenant_default", "migration_pr", waived.consumers[0]!.prId!)
        .some((evidence) => evidence.verdict === "waived"),
    ).toBe(true);
    const packageArtifact = listArtifactManifests(db, "tenant_default")
      .filter((artifact) => artifact.kind === "structured-pr-package")
      .at(-1)!;
    const packageRecord = JSON.parse(packageArtifact.content_text!) as {
      snapshot: { revisionKind: string; resolvedSha: string };
    };
    expect(packageRecord.snapshot.revisionKind).toBe("content_manifest");
    expect(packageRecord.snapshot.resolvedSha).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed on an absent security attestation even when contract evidence passes (Gap 2)", async () => {
    const dir = join(tmpdir(), `mendpoint-pipe-sec-gate-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const repoDir = join(dir, "shop");
    cpSync(shop, repoDir, { recursive: true });
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, {
      name: "Sec Gate Shop",
      repo: "sec-gate-shop",
      localPath: repoDir,
    });
    const deliveryRoot = join(dir, "delivery");
    // Contract evidence is supplied so the contract-suite gate passes; the only
    // missing gate is the caller's security attestation. Delivery must still be
    // blocked, proving the attestation is fail-closed on its own.
    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github: new MockGitHubDelivery(deliveryRoot),
      persistIndex: false,
      contractCases: [
        {
          id: "fixture",
          name: "fixture",
          requiredKeys: ["id"],
          responseBody: { id: "ok" },
        },
      ],
      // securityScanAttested intentionally omitted (unattested).
    });
    expect(report.consumers[0]?.prStatus).toBe("gates_failed");
    expect(existsSync(join(deliveryRoot, "org", "sec-gate-shop", "pulls"))).toBe(false);

    // The same run with the attestation supplied delivers the draft PR.
    const attested = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github: new MockGitHubDelivery(deliveryRoot),
      persistIndex: false,
      contractCases: [
        {
          id: "fixture",
          name: "fixture",
          requiredKeys: ["id"],
          responseBody: { id: "ok" },
        },
      ],
      securityScanAttested: true,
    });
    expect(attested.consumers[0]?.prStatus).toBe("draft");
    expect(existsSync(join(deliveryRoot, "org", "sec-gate-shop", "pulls"))).toBe(true);
  }, 15_000);

  it("writes a durable audit record of a scanner attestation (who/when/subject/tier/outcome)", async () => {
    const dir = join(tmpdir(), `mendpoint-pipe-sec-audit-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const repoDir = join(dir, "shop");
    cpSync(shop, repoDir, { recursive: true });
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    addMonitoredConsumer(db, provider.id, {
      name: "Audit Shop",
      repo: "audit-shop",
      localPath: repoDir,
    });
    const oldSpec = JSON.parse(readFileSync(join(acme, "openapi-v1.json"), "utf8"));
    const newSpec = JSON.parse(readFileSync(join(acme, "openapi-v2.json"), "utf8"));
    const subject = changeSubjectDigest(oldSpec, newSpec);
    const attestation: SecurityScanAttestation = {
      tier: "scanner",
      principal: "ci-scanner@acme",
      attestedAt: "2026-07-02T00:00:00.000Z",
      subject: { algo: "sha256", digest: subject },
      tool: { name: "scanalot", version: "3.2.1" },
      evidenceRef: "s3://evidence/acme-v2.json",
    };
    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      indexStorageRoot: join(dir, "index-storage"),
      github: new MockGitHubDelivery(join(dir, "delivery")),
      persistIndex: false,
      contractCases: [
        { id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } },
      ],
      securityScanAttestation: attestation,
    });
    expect(report.consumers[0]?.prStatus).toBe("draft");

    const events = listDomainEvents(db, "tenant_default", "api_change", report.changeId);
    const record = events.find((e) => e.event_type === "change.security_attestation");
    expect(record).toBeDefined();
    const payload = JSON.parse(record!.payload_json) as Record<string, unknown>;
    expect(payload.tier).toBe("scanner");
    // The pipeline dereferences no scanner evidence, so a caller-supplied scanner
    // attestation is recorded and satisfies the default (claim-tier) gate, but is
    // never independently verified.
    expect(payload.verified).toBe(false);
    expect(payload.satisfied).toBe(true);
    expect(payload.attestingPrincipal).toBe("ci-scanner@acme");
    expect(payload.attestedAt).toBe("2026-07-02T00:00:00.000Z");
    expect(payload.subjectDigest).toBe(subject);
    expect(payload.evidenceRef).toBe("s3://evidence/acme-v2.json");
    expect(record!.actor_principal_id).toBeTruthy();
    expect(verifyDomainEventIntegrity(db, "tenant_default").ok).toBe(true);
  });

  it("customer-profile policy blocks a bare claim, and the operator override accepts it as a logged downgrade", async () => {
    const dir = join(tmpdir(), `mendpoint-pipe-sec-policy-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const repoDir = join(dir, "shop");
    cpSync(shop, repoDir, { recursive: true });
    const priorProfile = process.env.MENDPOINT_DEPLOYMENT_PROFILE;
    const priorOverride = process.env.MENDPOINT_SECURITY_ATTESTATION_ALLOW_UNVERIFIED;
    const contractCases = [
      { id: "fixture", name: "fixture", requiredKeys: ["id"], responseBody: { id: "ok" } },
    ];
    try {
      // Customer profile requires a verified scanner result: a bare claim blocks.
      process.env.MENDPOINT_DEPLOYMENT_PROFILE = "customer";
      delete process.env.MENDPOINT_SECURITY_ATTESTATION_ALLOW_UNVERIFIED;
      const db = seedProviderVersions();
      const provider = db.raw
        .prepare("SELECT id FROM providers WHERE slug = ?")
        .get("acme-payments") as { id: string };
      addMonitoredConsumer(db, provider.id, {
        name: "Policy Shop",
        repo: "policy-shop",
        localPath: repoDir,
      });
      const deliveryRoot = join(dir, "delivery");
      const blocked = await runChangePipeline({
        tenantId: "tenant_default",
        providerSlug: "acme-payments",
        db,
        graphDb: testGraphDb(),
        github: new MockGitHubDelivery(deliveryRoot),
        persistIndex: false,
        contractCases,
        securityScanAttested: true,
      });
      expect(blocked.consumers[0]?.prStatus).toBe("gates_failed");
      expect(existsSync(join(deliveryRoot, "org", "policy-shop", "pulls"))).toBe(false);
      const blockedEvents = listDomainEvents(db, "tenant_default", "api_change", blocked.changeId);
      const blockedRecord = blockedEvents.find(
        (e) => e.event_type === "change.security_attestation",
      );
      const blockedPayload = JSON.parse(blockedRecord!.payload_json) as Record<string, unknown>;
      expect(blockedPayload.satisfied).toBe(false);
      expect(blockedPayload.requiredTier).toBe("scanner");
      expect(blockedPayload.code).toBe("policy_insufficient");

      // With the operator override set, the same bare claim is accepted and the
      // downgrade is recorded in both the audit record and the PR evidence.
      process.env.MENDPOINT_SECURITY_ATTESTATION_ALLOW_UNVERIFIED = "1";
      const db2 = seedProviderVersions();
      const provider2 = db2.raw
        .prepare("SELECT id FROM providers WHERE slug = ?")
        .get("acme-payments") as { id: string };
      addMonitoredConsumer(db2, provider2.id, {
        name: "Override Shop",
        repo: "override-shop",
        localPath: repoDir,
      });
      const deliveryRoot2 = join(dir, "delivery2");
      const accepted = await runChangePipeline({
        tenantId: "tenant_default",
        providerSlug: "acme-payments",
        db: db2,
        graphDb: testGraphDb(),
        github: new MockGitHubDelivery(deliveryRoot2),
        persistIndex: false,
        contractCases,
        securityScanAttested: true,
      });
      expect(accepted.consumers[0]?.prStatus).toBe("draft");
      const acceptedEvents = listDomainEvents(db2, "tenant_default", "api_change", accepted.changeId);
      const acceptedRecord = acceptedEvents.find(
        (e) => e.event_type === "change.security_attestation",
      );
      const acceptedPayload = JSON.parse(acceptedRecord!.payload_json) as Record<string, unknown>;
      expect(acceptedPayload.satisfied).toBe(true);
      expect(acceptedPayload.downgradeApplied).toBe(true);
      expect(acceptedPayload.policySource).toBe("operator_override");
      const delivered = JSON.parse(
        readFileSync(join(deliveryRoot2, "org", "override-shop", "pulls", "1.json"), "utf8"),
      ) as { body: string };
      expect(delivered.body).toMatch(/operator override/i);
    } finally {
      if (priorProfile === undefined) delete process.env.MENDPOINT_DEPLOYMENT_PROFILE;
      else process.env.MENDPOINT_DEPLOYMENT_PROFILE = priorProfile;
      if (priorOverride === undefined)
        delete process.env.MENDPOINT_SECURITY_ATTESTATION_ALLOW_UNVERIFIED;
      else process.env.MENDPOINT_SECURITY_ATTESTATION_ALLOW_UNVERIFIED = priorOverride;
    }
  });

  it("records authority-bound index materialization in audit and domain events", async () => {
    const dir = join(tmpdir(), `mendpoint-pipe-index-authority-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const repoDir = join(dir, "shop");
    cpSync(shop, repoDir, { recursive: true });
    rmSync(join(repoDir, ".mendpoint"), { recursive: true, force: true });
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    const consumerId = addMonitoredConsumer(db, provider.id, {
      name: "Indexed Shop",
      repo: "indexed-shop",
      localPath: repoDir,
    });
    const repositoryId = getConsumerRepo(db, consumerId, "tenant_default")!.id;

    const report = await runChangePipeline({
      tenantId: "tenant_default",
      providerSlug: "acme-payments",
      db,
      graphDb: testGraphDb(),
      github: new MockGitHubDelivery(join(dir, "delivery")),
      contractCases: [{
        id: "fixture",
        name: "fixture",
        requiredKeys: ["id"],
        responseBody: { id: "ok" },
      }],
      securityScanAttested: true,
    });

    const audit = listAudit(db, "tenant_default")
      .find((entry) => entry.action === "codebase_index.materialized");
    expect(audit).toBeDefined();
    expect(JSON.parse(audit!.metadata_json!)).toMatchObject({
      classification: "rebuilt",
      tenantId: "tenant_default",
      repositoryId,
      rejectedReason: "missing",
      generation: 1,
    });
    const event = listDomainEvents(db, "tenant_default", "api_change", report.changeId)
      .find((entry) => entry.event_type === "codebase_index.materialized");
    expect(event).toBeDefined();
    expect(JSON.parse(event!.payload_json)).toMatchObject({
      consumerId,
      classification: "rebuilt",
      repositoryId,
      generation: 1,
    });
  }, 15_000);

  it("persists delivery failure and does not duplicate completed consumers on rerun", async () => {
    const dir = join(tmpdir(), `mendpoint-pipe-resume-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    const db = seedProviderVersions();
    const provider = db.raw
      .prepare("SELECT id FROM providers WHERE slug = ?")
      .get("acme-payments") as { id: string };
    restrictProviderVersionsToCharges(db, provider.id);
    addMonitoredConsumer(db, provider.id, {
      name: "A Shop",
      repo: "a-shop",
      localPath: shop,
    });
    const retryingConsumerId = addMonitoredConsumer(db, provider.id, {
      name: "B Shop",
      repo: "b-shop",
      localPath: shop,
    });
    const retryingRepositoryId = getConsumerRepo(
      db,
      retryingConsumerId,
      "tenant_default",
    )!.id;

    class SelectiveFailureDelivery extends MockGitHubDelivery {
      readonly opened: string[] = [];

      override async deliverExactDraft(
        input: Parameters<MockGitHubDelivery["deliverExactDraft"]>[0],
      ): ReturnType<MockGitHubDelivery["deliverExactDraft"]> {
        this.opened.push(input.repo);
        if (input.repo === "b-shop") throw new Error("SCM unavailable");
        return super.deliverExactDraft(input);
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
      securityScanAttested: true,
    };

    const graphDb = testGraphDb();
    const first = await runChangePipeline({ ...common, graphDb });
    expect(first.consumers.map((consumer) => consumer.prStatus)).toEqual([
      "draft",
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
    const firstGraphHead = getSoftwareGraphHead(
      graphDb,
      "tenant_default",
      retryingRepositoryId,
      provider.id,
    );
    expect(firstGraphHead).toBeDefined();

    const second = await runChangePipeline({ ...common, graphDb });
    expect(second.changeId).toBe(first.changeId);
    expect(second.consumers.map((consumer) => consumer.prStatus)).toEqual([
      "draft",
      "delivery_failed",
    ]);
    expect(github.opened).toEqual(["a-shop", "b-shop", "b-shop"]);
    expect(listPrs(db, "tenant_default")).toHaveLength(2);
    expect(listChanges(db)).toHaveLength(1);
    expect(
      listFindingsForChange(db, first.changeId, "tenant_default"),
    ).toHaveLength(findingsAfterFirst);
    expect(
      getSoftwareGraphHead(
        graphDb,
        "tenant_default",
        retryingRepositoryId,
        provider.id,
      ),
    ).toEqual(firstGraphHead);
  });
});
