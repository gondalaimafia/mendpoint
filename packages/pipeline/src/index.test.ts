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
import { MockGitHubDelivery } from "@mendpoint/github";
import {
  changeSubjectDigest,
  issueVerificationWaiver,
  type SecurityScanAttestation,
} from "@mendpoint/contract";
import { applyPrFeedback, runChangePipeline } from "./index.js";
import {
  getSoftwareGraphHead,
  openGraphLearnMemory,
  readSoftwareGraphVersion,
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
  input: {
    name: string;
    repo: string;
    localPath: string;
    tenantId?: string;
    defaultBranch?: string;
  },
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

      override async createBranch(
        owner: string,
        repo: string,
        branch: string,
        fromBranch?: string,
      ): Promise<void> {
        this.sourceBranches.push(fromBranch);
        await super.createBranch(owner, repo, branch);
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

    expect(report.consumers[0]?.prStatus).toBe("draft");
    expect(github.sourceBranches).toEqual(["trunk"]);
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
    expect(report.consumers[0].graphVersionId).toMatch(/^sgv1:[a-f0-9]{64}$/);
    expect(readSoftwareGraphVersion(
      graphDb,
      "tenant_default",
      consumerRepoId,
      report.consumers[0].graphVersionId!,
    ).repositoryId).toBe(consumerRepoId);
    expect(report.consumers[0].graphContextArtifactId).toMatch(/^artifact_/);
    expect(report.consumers[0].prStatus).toBe("draft");
    expect(listPrs(db).length).toBe(1);
    expect(listAudit(db).some((a) => a.action === "change.normalized")).toBe(true);
    expect(listAudit(db).some((a) => a.action === "pr.draft_opened")).toBe(true);
    const graphAnalyzed = listAudit(db).find((event) => event.action === "impact.analyzed");
    expect(graphAnalyzed).toBeDefined();
    expect(JSON.parse(graphAnalyzed!.metadata_json!).fallback).toBeUndefined();

    const prId = report.consumers[0].prId!;
    const artifacts = listArtifactManifests(db, "tenant_default");
    expect(artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining([
        "change-source-openapi",
        "candidate-edit",
        "verification-result",
        "structured-pr-package",
        "fettler-change-graph-context",
      ]),
    );
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
    ).toContain("change_graph.context_recorded");
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
    expect(delivered.body).toContain("### Change Graph evidence");
    expect(delivered.body).toContain(report.consumers[0].graphVersionId!);
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
