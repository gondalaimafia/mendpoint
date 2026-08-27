import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  findActiveLearningConsent,
  getMissionPolicyEnvelope,
  insertRepositorySnapshot,
  listDomainEvents,
  listMissionTasks,
  listRepositorySnapshots,
  resolveMissionForRegaugeCampaign,
  revokeLearningConsent,
  verifyDomainEventIntegrity,
  type AppDb,
} from "@mendpoint/db";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import { listNodesByKind, openGraphLearnMemory } from "@mendpoint/graph-learn";
import { reconcileVerifierAdvisoryPolicyAuthority } from "@mendpoint/pipeline";
import {
  CredentialBroker,
  MemorySecretProvider,
  type GitHubRepositoryTransport,
  type GitHubTransportRequest,
  type GitHubTransportResponse,
} from "@mendpoint/platform";
import {
  NODE_RUNTIME_20_TO_22_RECIPE,
  recipeFilesDigest,
  type TransformerBlueprint,
} from "@mendpoint/transformer";
import { bootstrapRegaugeProductionCampaign } from "./regauge-production-bootstrap.js";
import {
  createRegaugeProductionBootstrapRuntime,
  regaugeLaunchMissionTaskId,
  regaugeProductionBootstrapInputFromEnvironment,
} from "./regauge-production-bootstrap-runtime.js";
import {
  REGAUGE_VERIFIER_CONSENT_PURPOSE,
  regaugeVerifierConsentAuthorityFromEnvironment,
} from "./regauge-verifier-consent.js";
import { TransformerCampaignService } from "./transformer-control-plane.js";
import { createAppDbTransformerMissionAuthority } from "./transformer-mission-authority.js";
import { TransformerMissionService } from "./transformer-missions.js";
import { TransformerPilotExecutionService } from "./transformer-pilot-executions.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const services: Array<{ close(): void }> = [];
const previousReposDir = process.env.MENDPOINT_REPOS_DIR;
const previousNodeEnv = process.env.NODE_ENV;
const REVISION = "1".repeat(40);
const TREE = "2".repeat(40);
const APPROVAL = [
  "approval:regauge",
  "tenant_regauge_canary",
  "campaign_regauge_canary_20260814",
  "repository:1319732323",
  `revision:${REVISION}`,
  "draft:1",
  "run:32513731026",
  "attempt:1",
].join(":");

const files = {
  "package.json": `${JSON.stringify({
    name: "mendpoint-canary-drill",
    private: true,
    type: "module",
    scripts: { test: "node verify.mjs" },
    engines: { node: ">=20 <21" },
  }, null, 2)}\n`,
  ".node-version": "20\n",
  ".nvmrc": "20\n",
  "Dockerfile": "FROM node:20.19.4-alpine\nWORKDIR /app\nCOPY . .\nCMD [\"node\", \"verify.mjs\"]\n",
  "verify.mjs": "console.log('verified');\n",
  ".github/CODEOWNERS": "* @gondalaimafia\n",
  ".github/workflows/verify.yml": "jobs:\n  verify:\n    steps:\n      - run: npm test\n",
};

class GitHubSnapshotTransport implements GitHubRepositoryTransport {
  readonly provenance = "test" as const;
  readonly blobs = new Map<string, Buffer>();
  readonly tree: Array<{ path: string; mode: string; type: string; sha: string; size: number }>;

  constructor() {
    this.tree = Object.entries(files).map(([path, content], index) => {
      const bytes = Buffer.from(content);
      const sha = (index + 3).toString(16).repeat(40).slice(0, 40);
      this.blobs.set(sha, bytes);
      return { path, mode: "100644", type: "blob", sha, size: bytes.length };
    });
  }

  async request(input: GitHubTransportRequest): Promise<GitHubTransportResponse> {
    if (input.path === "/repositories/1319732323") {
      return { status: 200, body: { id: 1319732323, full_name: "gondalaimafia/mendpoint-canary-drill-20260801", default_branch: "main", permissions: { pull: true, push: false } } };
    }
    if (input.path === "/repos/gondalaimafia/mendpoint-canary-drill-20260801/git/ref/heads/main" ||
        input.path === "/repos/gondalaimafia/mendpoint-canary-drill-20260801/git/ref/heads/codex%2Fregauge-canary-baseline") {
      return { status: 200, body: { object: { type: "commit", sha: REVISION } } };
    }
    if (input.path === `/repos/gondalaimafia/mendpoint-canary-drill-20260801/git/commits/${REVISION}`) {
      return { status: 200, body: { sha: REVISION, tree: { sha: TREE } } };
    }
    if (input.path === `/repos/gondalaimafia/mendpoint-canary-drill-20260801/git/trees/${TREE}?recursive=1`) {
      return { status: 200, body: { truncated: false, tree: this.tree } };
    }
    const blob = /\/git\/blobs\/([a-f0-9]{40})$/.exec(input.path)?.[1];
    if (blob && this.blobs.has(blob)) {
      const bytes = this.blobs.get(blob)!;
      return { status: 200, body: { encoding: "base64", size: bytes.length, content: bytes.toString("base64") } };
    }
    return { status: 404, body: { message: "Not Found" } };
  }
}

function gate(): string {
  return JSON.stringify({
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantAllowlist: ["tenant_regauge_canary"],
    environmentAllowlist: ["production"],
    grants: [{
      tenantId: "tenant_regauge_canary",
      environment: "production",
      boundaries: ["api_control_plane", "worker_action", "delivery"],
      acceptanceEvidenceRefs: ["evidence:regauge:acceptance"],
      productionDeliveryApprovalRefs: [APPROVAL],
    }],
  });
}

function environment() {
  return {
    MENDPOINT_REGAUGE_TENANT_ID: "tenant_regauge_canary",
    MENDPOINT_REGAUGE_CAMPAIGN_ID: "campaign_regauge_canary_20260814",
    MENDPOINT_REGAUGE_ENVIRONMENT: "production",
    MENDPOINT_REGAUGE_CANARY_OWNER: "gondalaimafia",
    MENDPOINT_REGAUGE_CANARY_REPOSITORY: "mendpoint-canary-drill-20260801",
    MENDPOINT_REGAUGE_CANARY_REPOSITORY_ID: "1319732323",
    MENDPOINT_REGAUGE_CANARY_DEFAULT_BRANCH: "main",
    MENDPOINT_REGAUGE_CANARY_BRANCH: "codex/regauge-canary-baseline",
    MENDPOINT_REGAUGE_CANARY_REVISION: REVISION,
    MENDPOINT_REGAUGE_GITHUB_INSTALLATION_ID: "7123456",
    MENDPOINT_REGAUGE_REVIEWER_ISSUER: "https://github.com",
    MENDPOINT_REGAUGE_REVIEWER_SUBJECT: "gondalaimafia",
    MENDPOINT_REGAUGE_REVIEWER_DISPLAY_NAME: "Talal Gondal",
    MENDPOINT_REGAUGE_PRODUCTION_APPROVAL_REF: APPROVAL,
    MENDPOINT_REGAUGE_GATE: gate(),
    MENDPOINT_REGAUGE_EVIDENCE_REFS: `${APPROVAL},evidence:regauge:acceptance`,
    MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON: JSON.stringify({
      schemaVersion: "2026-08-17.v1",
      entries: [{
        tenantId: "tenant_regauge_canary",
        products: ["regauge"],
        consentId: "consent_regauge_20260824",
        evidenceRef: "approval:user:2026-08-24",
        requiredRegion: "cn",
        processingRegion: "cn",
        externalModelAllowed: true,
        mayLeaveTenantBoundary: true,
        consentActive: true,
      }],
    }),
    MENDPOINT_REGAUGE_VERIFIER_CONSENT_EFFECTIVE_AT: "2026-08-24T00:00:00.000Z",
    MENDPOINT_REGAUGE_VERIFIER_CONSENT_EXPIRES_AT: "2026-11-20T23:59:59.000Z",
    MENDPOINT_REGAUGE_VERIFIER_POLICY_ENVELOPE_JSON: JSON.stringify({
      policyEnvelopeId: "regauge-deepseek-v4-flash-advisory-20260824",
      tenantId: "tenant_regauge_canary",
      version: 2,
      repositoryScope: ["gondalaimafia/mendpoint-canary-drill-20260801"],
      branchScope: ["codex/regauge-canary-baseline"],
      forbiddenZones: [],
      allowedTools: ["deepseek-verifier"],
      allowedModelClasses: ["rented_specialist"],
      externalProcessingAllowed: true,
      residency: "cn",
      riskCeiling: "high",
      reviewRequired: true,
      deploymentAllowed: false,
      trainingDataAllowed: false,
      retentionDays: 90,
      createdAt: "2026-08-24T00:00:00.000Z",
    }),
    GITHUB_APP_ACCOUNT_TENANT_BINDINGS: '{"7654321":"tenant_regauge_canary"}',
  };
}

function makeFixtureTreeWritable(root: string): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    chmodSync(root, 0o644);
    return;
  }
  chmodSync(root, 0o755);
  for (const entry of readdirSync(root)) {
    makeFixtureTreeWritable(join(root, entry));
  }
}

function removeFixtureRoot(root: string): void {
  makeFixtureTreeWritable(root);
  rmSync(root, { recursive: true, force: true });
}

afterEach(() => {
  while (services.length) services.pop()!.close();
  while (dbs.length) dbs.pop()!.raw.close();
  while (roots.length) removeFixtureRoot(roots.pop()!);
  process.env.MENDPOINT_REPOS_DIR = previousReposDir;
  process.env.NODE_ENV = previousNodeEnv;
});

describe("Regauge production bootstrap runtime", () => {
  it("parses an exact protected environment input without secret material", () => {
    const parsed = regaugeProductionBootstrapInputFromEnvironment(environment());
    expect(parsed).toMatchObject({
      tenantId: "tenant_regauge_canary",
      campaignId: "campaign_regauge_canary_20260814",
      repository: { remoteRepositoryId: "1319732323", expectedRevision: REVISION, accountId: "7654321" },
      productionApprovalRef: APPROVAL,
    });
    expect(JSON.stringify(parsed)).not.toMatch(/api[_-]?key|private[_-]?key|webhook/i);
  });

  it("materializes, plans, reviews, launches, and durably replays the real production recipe", async () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-regauge-bootstrap-"));
    roots.push(root);
    process.env.MENDPOINT_REPOS_DIR = join(root, "repos");
    mkdirSync(process.env.MENDPOINT_REPOS_DIR, { recursive: true });
    process.env.NODE_ENV = "test";
    const db = createDb(join(root, "app.sqlite"));
    dbs.push(db);
    const control = new TransformerCampaignService(join(root, "control.sqlite"));
    const executions = new TransformerPilotExecutionService(join(root, "pilot.sqlite"), {
      rawGateConfig: gate(),
      environment: "production",
      now: () => new Date().toISOString(),
    });
    services.push(control, executions);
    const authority = createAppDbTransformerMissionAuthority(db);
    const dependencyGraph = openGraphLearnMemory();
    services.push({ close: () => dependencyGraph.raw.close() });
    const missions = new TransformerMissionService(
      control,
      executions,
      authority.repositories,
      authority.organizations,
      [NODE_RUNTIME_20_TO_22_RECIPE],
      "production",
      () => new Date().toISOString(),
      { graph: dependencyGraph },
    );
    const secrets = new MemorySecretProvider({ installation: "test-installation-token" });
    const broker = new CredentialBroker({ providers: [secrets], audit: () => undefined });
    const protectedEnvironment = environment();
    const verifierConsentAuthority = regaugeVerifierConsentAuthorityFromEnvironment(
      protectedEnvironment,
      "tenant_regauge_canary",
    );
    const runtimeOptions = {
      db,
      control,
      executions,
      missions,
      dependencyGraph,
      repositoryDependencies: {
        credentialBroker: broker,
        githubTransport: new GitHubSnapshotTransport(),
        credentialDescriptor: () => ({
          credentialId: "github-installation-test",
          secret: { provider: "memory", id: "installation" },
          audiences: ["github:installation:7123456"],
          rotation: { generation: 1, issuedAt: "2026-08-14T17:00:00.000Z" },
        }),
      },
      listInstallationRepositories: async () => [{
        id: 1319732323,
        owner: "gondalaimafia",
        name: "mendpoint-canary-drill-20260801",
        fullName: "gondalaimafia/mendpoint-canary-drill-20260801",
        defaultBranch: "main",
        private: true,
        archived: false,
        disabled: false,
      }],
      now: () => new Date().toISOString(),
    } as const;
    const legacyBaseRuntime = createRegaugeProductionBootstrapRuntime(runtimeOptions);
    const baseRuntime = createRegaugeProductionBootstrapRuntime({
      ...runtimeOptions,
      verifierConsentAuthority,
      verifierPolicyAuthority: {
        policyEnvelopeJson: protectedEnvironment.MENDPOINT_REGAUGE_VERIFIER_POLICY_ENVELOPE_JSON,
        repositoryScope: "gondalaimafia/mendpoint-canary-drill-20260801",
        branch: "codex/regauge-canary-baseline",
        processingRegion: verifierConsentAuthority.residencyRegion,
      },
    });
    let preparedDigest = "";
    const runtime = {
      ...legacyBaseRuntime,
      async prepareRepository(input: Parameters<typeof legacyBaseRuntime.prepareRepository>[0]) {
        const prepared = await legacyBaseRuntime.prepareRepository(input);
        preparedDigest = prepared.snapshotDigest;
        return prepared;
      },
      async plan(input: Parameters<typeof legacyBaseRuntime.plan>[0]) {
        const planned = await legacyBaseRuntime.plan(input);
        expect(planned.snapshotDigest).toBe(preparedDigest);
        return planned;
      },
    };

    const first = await bootstrapRegaugeProductionCampaign(
      regaugeProductionBootstrapInputFromEnvironment(environment()),
      runtime,
    );
    const campaign = control.store.getCampaign("tenant_regauge_canary", first.campaignId)!;
    const blueprint = control.store.getBlueprint("tenant_regauge_canary", campaign.blueprintId)!;
    const dependencyEvidence = (blueprint.content as unknown as TransformerBlueprint).evidence.dependencies;
    expect(dependencyEvidence).toMatchObject({
      tenantId: "tenant_regauge_canary",
      requestedRepositoryIds: [first.repositoryId],
      repositories: [{
        repositoryId: first.repositoryId,
        coverage: "complete",
        reason: "manifest_ingest_complete",
        dependsOnRepositoryIds: [],
        evidenceRefs: [expect.stringMatching(/^manifest-ingest:sha256:/)],
        manifestPath: "package.json",
        manifestContentDigest: `sha256:${createHash("sha256").update(files["package.json"], "utf8").digest("hex")}`,
        manifestVersionId: expect.stringMatching(/^sha256:/),
        snapshotRevision: REVISION,
        snapshotDigest: recipeFilesDigest(files),
      }],
      contentDigest: expect.stringMatching(/^sha256:/),
    });
    expect(listNodesByKind(dependencyGraph, "Service")).toEqual([
      expect.objectContaining({
        repo_id: first.repositoryId,
        label: "mendpoint-canary-drill",
        props: expect.objectContaining({
          tenant_id: "tenant_regauge_canary",
          manifest_ingest_status: "complete",
        }),
      }),
    ]);
    expect(findActiveLearningConsent(db, {
      tenantId: "tenant_regauge_canary",
      purpose: REGAUGE_VERIFIER_CONSENT_PURPOSE,
      at: new Date().toISOString(),
    })).toBeUndefined();
    const legacyMission = resolveMissionForRegaugeCampaign(
      db,
      "tenant_regauge_canary",
      "campaign_regauge_canary_20260814",
    )!;
    expect(getMissionPolicyEnvelope(db, "tenant_regauge_canary", legacyMission.id)).toMatchObject({
      policyEnvelopeId: expect.stringMatching(/^pe-default-/),
      version: 1,
    });
    const storedSnapshot = listRepositorySnapshots(
      db,
      "tenant_regauge_canary",
      first.repositoryId,
    ).find((snapshot) => snapshot.id === first.snapshotId)!;
    insertRepositorySnapshot(db, {
      id: "duplicate-same-revision-snapshot",
      tenantId: "tenant_regauge_canary",
      repositoryId: first.repositoryId,
      requestedRef: storedSnapshot.requested_ref,
      resolvedSha: storedSnapshot.resolved_sha,
      manifestSha256: storedSnapshot.manifest_sha256,
      storagePath: storedSnapshot.storage_path,
      submodulesPolicy: storedSnapshot.submodules_policy,
      lfsPolicy: storedSnapshot.lfs_policy,
      sparsePaths: JSON.parse(storedSnapshot.sparse_paths_json) as string[],
      fileManifestVersion: 1,
      createdAt: "2026-08-14T17:01:00.000Z",
      expiresAt: "2026-09-13T17:01:00.000Z",
    });
    await expect(baseRuntime.readRepositoryAuthority({
      bootstrap: regaugeProductionBootstrapInputFromEnvironment(environment()),
      repository: {
        repositoryId: first.repositoryId,
        snapshotId: first.snapshotId,
        revision: first.revision,
        snapshotDigest: first.snapshotDigest,
      },
    })).resolves.toMatchObject({ snapshotId: first.snapshotId, revision: REVISION });
    const second = await bootstrapRegaugeProductionCampaign(
      regaugeProductionBootstrapInputFromEnvironment(environment()),
      baseRuntime,
    );

    expect(second).toEqual(first);
    expect(first).toMatchObject({ state: "running", revision: REVISION, eventHash: expect.stringMatching(/^sha256:/) });
    expect(executions.store.getCampaign("tenant_regauge_canary", "campaign_regauge_canary_20260814"))
      .toMatchObject({ state: "running", units: [expect.objectContaining({
        snapshot: expect.objectContaining({ revision: REVISION }),
        changedPaths: [".node-version", ".nvmrc", "Dockerfile", "package.json"],
      })] });
    expect(listDomainEvents(db, "tenant_regauge_canary", "regauge_production_bootstrap", "campaign_regauge_canary_20260814"))
      .toHaveLength(1);
    const storedDigest = createHash("sha256").update(first.requestDigest).digest("hex");
    expect(storedDigest).toMatch(/^[a-f0-9]{64}$/);

    // The Mission is created AND bound at the live launch seam: it carries the
    // exact verified snapshot the campaign launched (not a HEAD re-resolution),
    // and it has advanced out of `created` to `executing` on the real lifecycle.
    const launchedUnit = executions.store
      .getCampaign("tenant_regauge_canary", "campaign_regauge_canary_20260814")!.units[0]!;
    const mission = resolveMissionForRegaugeCampaign(
      db,
      "tenant_regauge_canary",
      "campaign_regauge_canary_20260814",
    );
    expect(mission).toBeDefined();
    expect(mission!.state).toBe("executing");
    expect(mission!.product).toBe("regauge");
    expect(mission!.repositoryId).toBe(launchedUnit.snapshot.repositoryId);
    expect(mission!.snapshotId).toBe(launchedUnit.snapshot.snapshotId);
    // The hash-chained domain_events stay verifiable across create + link + the
    // four lifecycle transitions.
    expect(verifyDomainEventIntegrity(db, "tenant_regauge_canary").ok).toBe(true);
    const missionEvents = listDomainEvents(db, "tenant_regauge_canary", "mission", mission!.id)
      .map((event) => event.event_type);
    expect(missionEvents).toContain("mission.created");
    expect(missionEvents).toContain("mission.regauge_campaign_linked");
    expect(missionEvents).toContain("mission.policy_envelope_bound");
    expect(missionEvents).toContain("mission.policy_envelope_advanced");
    expect(missionEvents.filter((type) => type === "mission.transitioned")).toHaveLength(4);
    // Spec §6.7: the launched Mission references a versioned Policy Envelope.
    expect(mission!.policyEnvelopeVersion).toBe("2");
    expect(mission!.graphVersionId).toBeNull();
    expect(missionEvents).not.toContain("mission.graph_version_bound");
    const inheritedPolicy = getMissionPolicyEnvelope(db, "tenant_regauge_canary", mission!.id);
    expect(inheritedPolicy).toMatchObject({
      policyEnvelopeId: "regauge-deepseek-v4-flash-advisory-20260824",
      version: 2,
    });
    expect(() => reconcileVerifierAdvisoryPolicyAuthority(db, {
      completion: {
        tenantId: "tenant_regauge_canary",
        missionId: mission!.id,
        taskId: "campaign_regauge_canary_20260814:unit-1",
        product: "regauge",
        repositoryId: launchedUnit.snapshot.repositoryId,
        snapshotId: launchedUnit.snapshot.snapshotId,
        snapshotDigest: launchedUnit.snapshot.digest,
        objective: "Verify the completed migration.",
        risk: "high",
        allowedChangedPaths: ["package.json"],
        candidateId: "candidate-regauge-bootstrap",
        candidateDigest: `sha256:${"a".repeat(64)}`,
        changedPaths: ["package.json"],
        observableSummary: "The exact bootstrap candidate passed deterministic verification.",
        deterministicEvidenceDigest: `sha256:${"b".repeat(64)}`,
        deterministicEvidenceRefs: ["evidence:regauge:acceptance"],
        observedAt: new Date().toISOString(),
      },
      policyEnvelopeJson: protectedEnvironment.MENDPOINT_REGAUGE_VERIFIER_POLICY_ENVELOPE_JSON,
      actorPrincipalId: mission!.ownerPrincipalId,
      branch: "codex/regauge-canary-baseline",
      repositoryScope: "gondalaimafia/mendpoint-canary-drill-20260801",
      processingRegion: "cn",
      createdAt: new Date().toISOString(),
    })).not.toThrow();
    expect(listMissionTasks(db, "tenant_regauge_canary", mission!.id)).toEqual([
      expect.objectContaining({
        id: regaugeLaunchMissionTaskId(mission!.id, launchedUnit.snapshot.repositoryId),
        taskType: "code_migration",
        status: "unassigned",
      }),
    ]);

    const consent = findActiveLearningConsent(db, {
      tenantId: "tenant_regauge_canary",
      purpose: REGAUGE_VERIFIER_CONSENT_PURPOSE,
      at: new Date().toISOString(),
    })!;
    revokeLearningConsent(db, {
      id: "consent_regauge_revoked_after_bootstrap",
      tenantId: "tenant_regauge_canary",
      consentId: consent.id,
      consentVersion: consent.consent_version + 1,
      authorizedByPrincipalId: consent.authorized_by_principal_id,
      reason: "Operator revoked DeepSeek advisory processing.",
      idempotencyKey: "regauge-bootstrap-consent-revoked",
      createdAt: new Date().toISOString(),
    });
    await expect(baseRuntime.prepareRepository({
      bootstrap: regaugeProductionBootstrapInputFromEnvironment(environment()),
      reviewerActorId: "human:https://github.com|gondalaimafia",
      requestDigest: first.requestDigest,
    })).resolves.toMatchObject({ repositoryId: first.repositoryId });
    expect(findActiveLearningConsent(db, {
      tenantId: "tenant_regauge_canary",
      purpose: REGAUGE_VERIFIER_CONSENT_PURPOSE,
      at: new Date().toISOString(),
    })).toBeUndefined();
    expect((db.raw.prepare("SELECT COUNT(*) count FROM learning_consents").get() as { count: number }).count)
      .toBe(2);
  }, 20_000);
});
