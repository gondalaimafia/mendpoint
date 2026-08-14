import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, listDomainEvents, type AppDb } from "@mendpoint/db";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import {
  CredentialBroker,
  MemorySecretProvider,
  type GitHubRepositoryTransport,
  type GitHubTransportRequest,
  type GitHubTransportResponse,
} from "@mendpoint/platform";
import { NODE_RUNTIME_20_TO_22_RECIPE } from "@mendpoint/transformer";
import { bootstrapRegaugeProductionCampaign } from "./regauge-production-bootstrap.js";
import {
  createRegaugeProductionBootstrapRuntime,
  regaugeProductionBootstrapInputFromEnvironment,
} from "./regauge-production-bootstrap-runtime.js";
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
const APPROVAL = "approval:regauge:20260814";

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
    const missions = new TransformerMissionService(
      control,
      executions,
      authority.repositories,
      authority.organizations,
      [NODE_RUNTIME_20_TO_22_RECIPE],
      "production",
      () => new Date().toISOString(),
    );
    const secrets = new MemorySecretProvider({ installation: "test-installation-token" });
    const broker = new CredentialBroker({ providers: [secrets], audit: () => undefined });
    const baseRuntime = createRegaugeProductionBootstrapRuntime({
      db,
      control,
      executions,
      missions,
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
    });
    let preparedDigest = "";
    const runtime = {
      ...baseRuntime,
      async prepareRepository(input: Parameters<typeof baseRuntime.prepareRepository>[0]) {
        const prepared = await baseRuntime.prepareRepository(input);
        preparedDigest = prepared.snapshotDigest;
        return prepared;
      },
      async plan(input: Parameters<typeof baseRuntime.plan>[0]) {
        const planned = await baseRuntime.plan(input);
        expect(planned.snapshotDigest).toBe(preparedDigest);
        return planned;
      },
    };

    const first = await bootstrapRegaugeProductionCampaign(
      regaugeProductionBootstrapInputFromEnvironment(environment()),
      runtime,
    );
    const second = await bootstrapRegaugeProductionCampaign(
      regaugeProductionBootstrapInputFromEnvironment(environment()),
      runtime,
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
  }, 20_000);
});
