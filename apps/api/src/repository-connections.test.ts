import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  createSecretLifecycle,
  getConsumerRepo,
  getRepositorySnapshotPolicy,
  insertConsumer,
  insertConsumerRepo,
  listRepositorySnapshotFiles,
  listRepositorySnapshots,
  recordRepositorySnapshotDeletion,
  revokeSecretLifecycle,
  rotateSecretLifecycle,
  type AppDb,
} from "@mendpoint/db";
import {
  CredentialBroker,
  DisabledExternalVaultProvider,
  EnvelopeKeyLifecycleRegistry,
  EnvelopeSecretVault,
  EnvSecretProvider,
  LocalEnvelopeKeyProvider,
  MemorySecretProvider,
  type CredentialAccessAuditEvent,
  type CredentialDescriptor,
  type EnvelopeAccessAuditEvent,
  type GitHubRepositoryTransport,
  type GitHubTransportRequest,
  type GitHubTransportResponse,
} from "@mendpoint/platform";
import {
  materializeConnectedRepository,
  createRepositoryCredentialDependencies,
  purgeExpiredSnapshots,
  registerConnectedRepository,
  registerScmConnection,
  revokeConnection,
  scmOverview,
} from "./repository-connections.js";

const roots: string[] = [];
const canonicalRoots: string[] = [];
const dbs: AppDb[] = [];
const previousReposDir = process.env.MENDPOINT_REPOS_DIR;
const previousNodeEnv = process.env.NODE_ENV;
const GITHUB_COMMIT = "1".repeat(40);
const GITHUB_TREE = "2".repeat(40);
const GITHUB_BLOB = "3".repeat(40);

class FakeGitHubTransport implements GitHubRepositoryTransport {
  readonly provenance = "test" as const;
  readonly requests: GitHubTransportRequest[] = [];
  readonly credentials: string[] = [];

  constructor(private readonly forbidden = false) {}

  async request(input: GitHubTransportRequest): Promise<GitHubTransportResponse> {
    this.requests.push(input);
    this.credentials.push(input.credential.reveal());
    if (this.forbidden) return { status: 403, body: { message: "secret-installation-token" } };
    if (input.path === "/repositories/98765") {
      return {
        status: 200,
        body: {
          id: 98765,
          full_name: "acme/service",
          default_branch: "main",
          permissions: { pull: true, push: false },
        },
      };
    }
    if (input.path === "/repos/acme/service/git/ref/heads/main") {
      return { status: 200, body: { object: { type: "commit", sha: GITHUB_COMMIT } } };
    }
    if (input.path === `/repos/acme/service/git/commits/${GITHUB_COMMIT}`) {
      return { status: 200, body: { sha: GITHUB_COMMIT, tree: { sha: GITHUB_TREE } } };
    }
    if (input.path === `/repos/acme/service/git/trees/${GITHUB_TREE}?recursive=1`) {
      const content = Buffer.from(JSON.stringify({ scripts: { test: "vitest run" } }));
      return {
        status: 200,
        body: {
          truncated: false,
          tree: [{
            path: "package.json",
            mode: "100644",
            type: "blob",
            sha: GITHUB_BLOB,
            size: content.length,
          }],
        },
      };
    }
    if (input.path === `/repos/acme/service/git/blobs/${GITHUB_BLOB}`) {
      const content = Buffer.from(JSON.stringify({ scripts: { test: "vitest run" } }));
      return {
        status: 200,
        body: { encoding: "base64", size: content.length, content: content.toString("base64") },
      };
    }
    return { status: 404, body: { message: "Not Found" } };
  }
}

async function durableCredential(
  db: AppDb,
  provider: LocalEnvelopeKeyProvider,
  input: {
    credentialId: string;
    sourceRef: string;
    generation: number;
    value: string;
    rotate?: boolean;
  },
) {
  const key = {
    provider: "local-envelope",
    keyId: "tenant-key",
    version: String(input.generation),
    customerManaged: false,
  } as const;
  provider.putKey("tenant-a", key, Buffer.alloc(32, input.generation));
  const lifecycle = new EnvelopeKeyLifecycleRegistry();
  lifecycle.register({
    tenantId: "tenant-a",
    key,
    generation: input.generation,
    state: "active",
    createdAt: `2026-08-0${input.generation}T00:00:00.000Z`,
  });
  const vault = new EnvelopeSecretVault(lifecycle, [provider], () => undefined);
  const envelope = await vault.encrypt(input.credentialId, input.value, key, {
    tenantId: "tenant-a",
    actorId: "service:provisioner",
    correlationId: `provision-${input.generation}`,
    purpose: input.rotate ? "rotate scm credential" : "create scm credential",
    at: `2026-08-0${input.generation}T00:00:00.000Z`,
  });
  const version = {
    tenantId: "tenant-a",
    credentialId: input.credentialId,
    sourceRef: input.sourceRef,
    generation: input.generation,
    audiences: ["github:installation:12345"],
    expiresAt: "2026-09-01T00:00:00.000Z",
    issuedAt: `2026-08-0${input.generation}T00:00:00.000Z`,
    key,
    materialLineageId: "c".repeat(64),
    envelope: {
      schemaVersion: envelope.schemaVersion,
      algorithm: envelope.algorithm,
      wrappedDataKey: envelope.wrappedDataKey,
      iv: envelope.iv,
      authTag: envelope.authTag,
      ciphertext: envelope.ciphertext,
      createdAt: envelope.createdAt,
      keyAttestationSha256: envelope.keyAttestationSha256,
    },
  };
  if (input.rotate) {
    return rotateSecretLifecycle(db, {
      expectedGeneration: input.generation - 1,
      rotatedAt: `2026-08-0${input.generation}T00:00:00.000Z`,
      next: version,
    });
  }
  return createSecretLifecycle(db, version);
}

function githubRuntime(input: {
  transport?: GitHubRepositoryTransport;
  descriptor?: CredentialDescriptor;
} = {}) {
  const audits: CredentialAccessAuditEvent[] = [];
  const secrets = new MemorySecretProvider({
    "github/installations/12345": "secret-installation-token",
  });
  const broker = new CredentialBroker({
    providers: [secrets],
    audit: (event) => {
      audits.push(event);
    },
  });
  return {
    audits,
    dependencies: {
      credentialBroker: broker,
      githubTransport: input.transport ?? new FakeGitHubTransport(),
      credentialDescriptor: input.descriptor
        ? () => input.descriptor!
        : undefined,
      actorId: "operator:test",
      requestId: "request-test",
    },
  };
}

function registerGitHub(db: AppDb) {
  const connection = registerScmConnection(db, {
    tenantId: "tenant-a",
    provider: "github",
    credentialRef: "memory://github/installations/12345",
    externalAccountId: "12345",
    displayName: "Acme GitHub",
  });
  const repository = registerConnectedRepository(db, {
    tenantId: "tenant-a",
    connectionId: connection.id,
    remoteId: "98765",
    owner: "acme",
    name: "service",
    defaultBranch: "main",
    retentionDays: 14,
  });
  return { connection, repository };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

// Building the customer git repository costs ~8 subprocess spawns. Doing that in
// every test in this file stampedes git under parallel CI load, which is what
// tips these filesystem-heavy tests past their timeouts even though each passes
// in isolation. Build one canonical repository the first time it is needed, then
// hand every test an isolated on-disk copy (a plain recursive file copy, no
// subprocess) with its own repos dir and database. The committed tree, exec
// bits, and commit SHA are identical to the previous per-test build, and no
// absolute path is stored inside .git, so each copy is a faithful, independent
// repository a test may freely mutate.
let canonicalRepositoryCache: { path: string; sha: string } | undefined;

function canonicalRepository(): { path: string; sha: string } {
  if (canonicalRepositoryCache) return canonicalRepositoryCache;
  const home = mkdtempSync(join(tmpdir(), "mendpoint-connection-canonical-"));
  canonicalRoots.push(home);
  const repositoryPath = join(home, "customer-repo");
  mkdirSync(join(repositoryPath, ".github", "workflows"), { recursive: true });
  mkdirSync(join(repositoryPath, "scripts"), { recursive: true });
  git(repositoryPath, "init", "-b", "main");
  git(repositoryPath, "config", "user.name", "Mendpoint Test");
  git(repositoryPath, "config", "user.email", "test@mendpoint.invalid");
  writeFileSync(join(repositoryPath, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  writeFileSync(join(repositoryPath, ".github", "CODEOWNERS"), "* @customer\n");
  writeFileSync(join(repositoryPath, ".github", "workflows", "ci.yml"), "jobs:\n  test:\n    steps:\n      - run: npm test\n");
  const checkScriptPath = join(repositoryPath, "scripts", "check.sh");
  writeFileSync(checkScriptPath, "#!/bin/sh\nnpm test\n");
  chmodSync(checkScriptPath, 0o755);
  git(repositoryPath, "add", "--all");
  git(repositoryPath, "update-index", "--chmod=+x", "scripts/check.sh");
  git(repositoryPath, "commit", "-m", "customer fixture");
  if (git(repositoryPath, "status", "--porcelain")) {
    throw new Error("repository_connection_fixture_not_clean");
  }
  canonicalRepositoryCache = { path: repositoryPath, sha: git(repositoryPath, "rev-parse", "HEAD") };
  return canonicalRepositoryCache;
}

function fixture() {
  const source = canonicalRepository();
  const root = mkdtempSync(join(tmpdir(), "mendpoint-connection-"));
  roots.push(root);
  const repositoryPath = join(root, "customer-repo");
  cpSync(source.path, repositoryPath, { recursive: true });
  process.env.MENDPOINT_REPOS_DIR = root;
  process.env.NODE_ENV = "test";
  const db = createDb(join(root, "connections.sqlite"));
  dbs.push(db);
  return { root, repositoryPath, db, sha: source.sha };
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
  // On Windows an open handle or an antivirus scan can briefly lock a file as
  // EPERM/EBUSY, which rmSync's own maxRetries does not retry. Retry manually so
  // the lock clears instead of leaking the repository tree; a directory that
  // stays locked past the budget still throws rather than being swallowed.
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY") && attempt < 50) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        continue;
      }
      throw error;
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
  while (dbs.length) dbs.pop()?.raw.close();
  process.env.MENDPOINT_REPOS_DIR = previousReposDir;
  process.env.NODE_ENV = previousNodeEnv;
  while (roots.length) {
    const root = roots.pop();
    if (root) {
      removeFixtureRoot(root);
    }
  }
});

afterAll(() => {
  canonicalRepositoryCache = undefined;
  while (canonicalRoots.length) {
    const home = canonicalRoots.pop();
    if (home) {
      removeFixtureRoot(home);
    }
  }
});

describe("repository connection service", () => {
  it("materializes, discovers, persists, and binds an exact tenant snapshot", async () => {
    const { db, root, sha } = fixture();
    const connection = registerScmConnection(db, {
      tenantId: "tenant-a",
      provider: "local_git",
      externalAccountId: "local-customer",
      displayName: "Customer repository",
    });
    const repository = registerConnectedRepository(db, {
      tenantId: "tenant-a",
      connectionId: connection.id,
      remoteId: "customer-repo",
      owner: "customer",
      name: "service",
      defaultBranch: "main",
      retentionDays: 14,
    });
    insertConsumer(db, {
      id: "consumer-a",
      name: "Customer",
      githubOwner: "customer",
      githubRepo: "service",
      tenantId: "tenant-a",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    insertConsumerRepo(db, {
      id: "consumer-repo-a",
      consumerId: "consumer-a",
      localPath: join(root, "customer-repo"),
      defaultBranch: "main",
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    const result = await materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
      consumerRepoId: "consumer-repo-a",
    });

    expect(result.snapshot.exactCommit).toBe(sha);
    expect(JSON.stringify(result)).not.toContain(root);
    expect(result.constraints.codeowners[0]?.content).toBe("* @customer\n");
    expect(result.constraints.ci[0]?.provider).toBe("github_actions");
    expect(getConsumerRepo(db, "consumer-a", "tenant-a")).toMatchObject({
      snapshot_id: result.snapshot.id,
      exact_commit: sha,
    });
    expect(getRepositorySnapshotPolicy(db, "tenant-a", result.snapshot.id)).toBeDefined();
    expect(listRepositorySnapshotFiles(db, "tenant-a", result.snapshot.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "package.json",
          mode: "100644",
          kind: "file",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          path: "scripts/check.sh",
          mode: "100755",
          kind: "file",
          size: 19,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    );
    expect(listRepositorySnapshotFiles(db, "tenant-b", result.snapshot.id)).toEqual([]);
    const overview = scmOverview(db, "tenant-a");
    expect(JSON.stringify(overview)).not.toContain("local://filesystem");
    expect(overview.connections[0]?.health).toMatchObject({
      authenticated: true,
      readAccess: true,
      writeAccess: false,
      ciVisible: true,
    });
    expect(overview.repositories[0]?.snapshots[0]?.exactCommit).toBe(sha);
    expect(scmOverview(db, "tenant-b")).toMatchObject({ connections: [], repositories: [] });

    const storedPath = listRepositorySnapshots(db, "tenant-a", repository.id)[0]!.storage_path;
    expect(existsSync(storedPath)).toBe(true);
    await expect(
      purgeExpiredSnapshots(db, {
        tenantId: "tenant-b",
        actorPrincipalId: "service:retention",
        at: "2027-08-01T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ evaluated: 0, deleted: 0 });
    await expect(
      purgeExpiredSnapshots(db, {
        tenantId: "tenant-a",
        actorPrincipalId: "service:retention",
        at: "2027-08-01T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ evaluated: 1, deleted: 1, failed: 0 });
    expect(existsSync(storedPath)).toBe(false);
    expect(scmOverview(db, "tenant-a").repositories[0]?.snapshots[0]).toMatchObject({
      available: false,
      retentionStatus: "deleted",
    });
  }, 15_000);

  it("revokes a connection without exposing or reactivating its credential", () => {
    const { db } = fixture();
    const connection = registerScmConnection(db, {
      tenantId: "tenant-a",
      provider: "github",
      credentialRef: "vault://tenant-a/github/customer",
      externalAccountId: "12345",
      displayName: "Customer GitHub",
    });
    const revoked = revokeConnection(db, "tenant-a", connection.id);
    expect(revoked).toMatchObject({
      credentialConfigured: true,
      health: { revoked: true, authenticated: false },
    });
    expect(JSON.stringify(revoked)).not.toContain("vault://");
  });

  it("materializes an authorized GitHub commit idempotently without claiming test health", async () => {
    const { db } = fixture();
    const { connection, repository } = registerGitHub(db);
    const runtime = githubRuntime();

    const first = await materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
    }, runtime.dependencies);
    const second = await materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
    }, runtime.dependencies);

    expect(first).toMatchObject({
      reused: false,
      snapshot: { exactCommit: GITHUB_COMMIT },
      source: { provider: "github", defaultBranch: "main", headSha: GITHUB_COMMIT },
    });
    expect(second).toMatchObject({ reused: true, snapshot: { id: first.snapshot.id } });
    expect(listRepositorySnapshots(db, "tenant-a", repository.id)).toHaveLength(1);
    const storedPackage = join(
      listRepositorySnapshots(db, "tenant-a", repository.id)[0]!.storage_path,
      "package.json",
    );
    if (process.platform !== "win32") {
      expect(statSync(storedPackage).mode & 0o222).toBe(0);
    }
    expect(runtime.audits.every((event) => event.outcome === "granted")).toBe(true);
    expect(runtime.audits[0]).toMatchObject({
      actorId: "operator:test",
      audience: "github:installation:12345",
      purpose: "materialize_read_only_repository_snapshot",
      requestId: "request-test",
    });
    const overview = scmOverview(db, "tenant-a");
    expect(overview.providers.find((provider) => provider.provider === "github"))
      .toMatchObject({ snapshots: false, pullRequests: false });
    expect(overview.connections[0]).toMatchObject({
      id: connection.id,
      health: {
        authenticated: false,
        readAccess: false,
        lastSyncAt: null,
        errorCode: "github_snapshot_unproven",
      },
    });
    expect(JSON.stringify({ first, second, overview, audits: runtime.audits }))
      .not.toContain("secret-installation-token");
    await expect(materializeConnectedRepository(db, {
      tenantId: "tenant-b",
      repositoryId: repository.id,
    }, runtime.dependencies)).rejects.toThrow("connected_repository_tenant_mismatch");
  });

  it("rejects a GitHub branch head that differs from the approved revision before materialization", async () => {
    const { db } = fixture();
    const { repository } = registerGitHub(db);
    const transport = new FakeGitHubTransport();
    const runtime = githubRuntime({ transport });

    await expect(materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
      expectedRevision: "9".repeat(40),
    }, runtime.dependencies)).rejects.toThrow("connected_repository_revision_mismatch");

    expect(listRepositorySnapshots(db, "tenant-a", repository.id)).toHaveLength(0);
    expect(scmOverview(db, "tenant-a").repositories[0]).toMatchObject({ status: "pending" });
    expect(transport.requests.some((request) => request.path.includes("/git/trees/"))).toBe(false);
  });

  it("does not reuse identical content materialized from a different selected branch", async () => {
    const { db, repositoryPath } = fixture();
    git(repositoryPath, "branch", "release");
    const connection = registerScmConnection(db, {
      tenantId: "tenant-a",
      provider: "local_git",
      externalAccountId: "local-customer",
      displayName: "Customer repository",
    });
    const repository = registerConnectedRepository(db, {
      tenantId: "tenant-a",
      connectionId: connection.id,
      remoteId: "customer-repo",
      owner: "customer",
      name: "service",
      defaultBranch: "main",
      retentionDays: 14,
    });
    const first = await materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
    });
    db.raw.prepare(
      "UPDATE connected_repositories SET selected_branch = 'release' WHERE id = ?",
    ).run(repository.id);

    const second = await materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
    });

    expect(second).toMatchObject({ reused: false, snapshot: { requestedRef: "release" } });
    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    expect(listRepositorySnapshots(db, "tenant-a", repository.id)).toHaveLength(2);
  }, 15_000);

  it("rematerializes identical content after the reusable snapshot expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00.000Z"));
    const { db } = fixture();
    const connection = registerScmConnection(db, {
      tenantId: "tenant-a",
      provider: "local_git",
      externalAccountId: "local-customer",
      displayName: "Customer repository",
    });
    const repository = registerConnectedRepository(db, {
      tenantId: "tenant-a",
      connectionId: connection.id,
      remoteId: "customer-repo",
      owner: "customer",
      name: "service",
      defaultBranch: "main",
      retentionDays: 1,
    });
    const first = await materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
    });
    vi.setSystemTime(new Date("2026-08-03T00:00:00.000Z"));

    const second = await materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
    });

    expect(second.reused).toBe(false);
    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    expect(listRepositorySnapshots(db, "tenant-a", repository.id)).toHaveLength(2);
  }, 15_000);

  it.each(["missing", "corrupt", "deleted", "legacy"] as const)(
    "rematerializes identical content when reusable storage is %s",
    async (condition) => {
      const { db } = fixture();
      const connection = registerScmConnection(db, {
        tenantId: "tenant-a",
        provider: "local_git",
        externalAccountId: "local-customer",
        displayName: "Customer repository",
      });
      const repository = registerConnectedRepository(db, {
        tenantId: "tenant-a",
        connectionId: connection.id,
        remoteId: "customer-repo",
        owner: "customer",
        name: "service",
        defaultBranch: "main",
        retentionDays: 14,
      });
      const first = await materializeConnectedRepository(db, {
        tenantId: "tenant-a",
        repositoryId: repository.id,
      });
      const stored = listRepositorySnapshots(db, "tenant-a", repository.id)[0]!;
      if (condition === "missing") {
        removeFixtureRoot(stored.storage_path);
      } else if (condition === "corrupt") {
        makeFixtureTreeWritable(stored.storage_path);
        writeFileSync(join(stored.storage_path, "package.json"), "corrupt\n");
      } else if (condition === "deleted") {
        recordRepositorySnapshotDeletion(db, {
          id: "deletion-planned",
          tenantId: "tenant-a",
          snapshotId: stored.id,
          status: "planned",
          actorPrincipalId: "service:retention",
          createdAt: "2026-08-06T00:00:00.000Z",
        });
        recordRepositorySnapshotDeletion(db, {
          id: "deletion-complete",
          tenantId: "tenant-a",
          snapshotId: stored.id,
          status: "deleted",
          actorPrincipalId: "service:retention",
          createdAt: "2026-08-06T00:00:01.000Z",
        });
        removeFixtureRoot(stored.storage_path);
      } else {
        db.raw.exec("DROP TRIGGER repository_snapshots_append_only_update");
        db.raw.prepare(
          "UPDATE repository_snapshots SET file_manifest_version = 0 WHERE id = ?",
        ).run(stored.id);
      }

      const second = await materializeConnectedRepository(db, {
        tenantId: "tenant-a",
        repositoryId: repository.id,
      });

      expect(second.reused).toBe(false);
      expect(second.snapshot.id).not.toBe(first.snapshot.id);
      expect(listRepositorySnapshots(db, "tenant-a", repository.id)).toHaveLength(2);
      expect(existsSync(listRepositorySnapshots(db, "tenant-a", repository.id)[0]!.storage_path))
        .toBe(true);
    },
    15_000,
  );

  it("removes an owned fixture tree after snapshot permissions make nested content read only", () => {
    const root = mkdtempSync(join(tmpdir(), "mendpoint-read-only-cleanup-"));
    roots.push(root);
    const nested = join(root, "snapshot", "nested");
    mkdirSync(nested, { recursive: true });
    const packagePath = join(nested, "package.json");
    writeFileSync(packagePath, "{}\n");
    chmodSync(packagePath, 0o444);
    chmodSync(nested, 0o555);
    chmodSync(join(root, "snapshot"), 0o555);

    removeFixtureRoot(root);

    expect(existsSync(root)).toBe(false);
  });

  it("fails closed on revoked credentials and GitHub permission loss", async () => {
    const { db } = fixture();
    const { connection, repository } = registerGitHub(db);
    const revokedDescriptor: CredentialDescriptor = {
      credentialId: connection.id,
      secret: { provider: "memory", id: "github/installations/12345" },
      audiences: ["github:installation:12345"],
      revocation: { revokedAt: "2026-08-01T00:00:00.000Z", reason: "installation removed" },
      rotation: { generation: 1, issuedAt: "2026-07-01T00:00:00.000Z" },
    };
    const revoked = githubRuntime({ descriptor: revokedDescriptor });
    await expect(materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
    }, revoked.dependencies)).rejects.toThrow("github_credential_revoked");
    expect(scmOverview(db, "tenant-a").connections[0]?.health).toMatchObject({
      authenticated: false,
      readAccess: false,
      errorCode: "github_credential_revoked",
    });
    expect(listRepositorySnapshots(db, "tenant-a", repository.id)).toHaveLength(0);

    const denied = githubRuntime({ transport: new FakeGitHubTransport(true) });
    await expect(materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
    }, denied.dependencies)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    expect(scmOverview(db, "tenant-a").connections[0]?.health).toMatchObject({
      authenticated: false,
      readAccess: false,
      errorCode: "github_snapshot_permission_denied",
    });
    expect(JSON.stringify(scmOverview(db, "tenant-a"))).not.toContain("secret-installation-token");
  });

  it("uses durable lifecycle metadata, observes rotation, and denies revocation before transport", async () => {
    const { db } = fixture();
    const { connection, repository } = registerGitHub(db);
    const keyProvider = new LocalEnvelopeKeyProvider();
    await durableCredential(db, keyProvider, {
      credentialId: connection.id,
      sourceRef: "memory://github/installations/12345",
      generation: 1,
      value: "durable-token-one",
    });
    const transport = new FakeGitHubTransport();
    const credentialAudits: CredentialAccessAuditEvent[] = [];
    const envelopeAudits: EnvelopeAccessAuditEvent[] = [];
    let accessTime = new Date("2026-08-10T00:00:00.000Z");
    const dependencies = createRepositoryCredentialDependencies(db, {
      tenantId: "tenant-a",
      actorId: "operator:test",
      requestId: "request-test",
      keyProviders: [keyProvider],
      githubTransport: transport,
      credentialAudit: (event) => {
        credentialAudits.push(event);
      },
      envelopeAudit: (event) => {
        envelopeAudits.push(event);
      },
      now: () => accessTime,
    });

    await materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
    }, dependencies);
    expect(new Set(transport.credentials)).toEqual(new Set(["durable-token-one"]));
    expect(credentialAudits.at(-1)).toMatchObject({
      outcome: "granted",
      rotation: { generation: 1 },
    });
    expect(envelopeAudits.at(-1)).toMatchObject({ operation: "decrypt", outcome: "granted" });

    await durableCredential(db, keyProvider, {
      credentialId: connection.id,
      sourceRef: "memory://github/installations/12345",
      generation: 2,
      value: "durable-token-two",
      rotate: true,
    });
    transport.credentials.length = 0;
    await materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
    }, dependencies);
    expect(new Set(transport.credentials)).toEqual(new Set(["durable-token-two"]));
    expect(credentialAudits.at(-1)).toMatchObject({
      outcome: "granted",
      rotation: { generation: 2 },
    });

    accessTime = new Date("2026-09-01T00:00:00.000Z");
    transport.credentials.length = 0;
    transport.requests.length = 0;
    await expect(materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
    }, dependencies)).rejects.toThrow("github_credential_expired");
    expect(transport.requests).toHaveLength(0);
    expect(credentialAudits.at(-1)).toMatchObject({ outcome: "denied", reason: "expired" });

    revokeSecretLifecycle(db, {
      tenantId: "tenant-a",
      credentialId: connection.id,
      generation: 2,
      revokedAt: "2026-08-11T00:00:00.000Z",
      reason: "incident response",
    });
    accessTime = new Date("2026-08-11T00:00:00.000Z");
    transport.credentials.length = 0;
    transport.requests.length = 0;
    await expect(materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
    }, dependencies)).rejects.toThrow("github_credential_revoked");
    expect(transport.requests).toHaveLength(0);
    expect(credentialAudits.at(-1)).toMatchObject({ outcome: "denied", reason: "revoked" });
  });

  it("denies tenant-selected deployment env secrets and another tenant lifecycle reference before transport", async () => {
    const { db } = fixture();
    const envConnection = registerScmConnection(db, {
      tenantId: "tenant-a",
      provider: "github",
      credentialRef: "env://GITHUB_TOKEN",
      externalAccountId: "12345",
      displayName: "Tenant A GitHub",
    });
    const envRepository = registerConnectedRepository(db, {
      tenantId: "tenant-a",
      connectionId: envConnection.id,
      remoteId: "98765",
      owner: "acme",
      name: "service",
      defaultBranch: "main",
    });
    const envTransport = new FakeGitHubTransport();
    const dependencies = createRepositoryCredentialDependencies(db, {
      tenantId: "tenant-a",
      actorId: "operator-a",
      keyProviders: [new DisabledExternalVaultProvider("local-envelope")],
      fallbackProviders: [new EnvSecretProvider({ GITHUB_TOKEN: "deployment-global-token" })],
      githubTransport: envTransport,
      credentialAudit: () => undefined,
      envelopeAudit: () => undefined,
    } as any);
    await expect(materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: envRepository.id,
    }, dependencies)).rejects.toThrow("github_credential_lifecycle_required");
    expect(envTransport.requests).toHaveLength(0);

    const provider = new LocalEnvelopeKeyProvider();
    await durableCredential(db, provider, {
      credentialId: "tenant-a-credential",
      sourceRef: "vault://github/installations/tenant-a",
      generation: 1,
      value: "tenant-a-token",
    });
    const tenantBConnection = registerScmConnection(db, {
      tenantId: "tenant-b",
      provider: "github",
      credentialRef: "vault://github/installations/tenant-a",
      externalAccountId: "67890",
      displayName: "Tenant B GitHub",
    });
    const tenantBRepository = registerConnectedRepository(db, {
      tenantId: "tenant-b",
      connectionId: tenantBConnection.id,
      remoteId: "45678",
      owner: "other",
      name: "service",
      defaultBranch: "main",
    });
    const tenantBTransport = new FakeGitHubTransport();
    await expect(materializeConnectedRepository(db, {
      tenantId: "tenant-b",
      repositoryId: tenantBRepository.id,
    }, createRepositoryCredentialDependencies(db, {
      tenantId: "tenant-b",
      actorId: "operator-b",
      keyProviders: [provider],
      githubTransport: tenantBTransport,
      credentialAudit: () => undefined,
      envelopeAudit: () => undefined,
    }))).rejects.toThrow("github_credential_lifecycle_required");
    expect(tenantBTransport.requests).toHaveLength(0);
  });

  it("denies plaintext before GitHub transport when canonical access audit fails", async () => {
    const { db } = fixture();
    const { connection, repository } = registerGitHub(db);
    const keyProvider = new LocalEnvelopeKeyProvider();
    await durableCredential(db, keyProvider, {
      credentialId: connection.id,
      sourceRef: "memory://github/installations/12345",
      generation: 1,
      value: "durable-token-one",
    });
    const transport = new FakeGitHubTransport();
    const dependencies = createRepositoryCredentialDependencies(db, {
      tenantId: "tenant-a",
      actorId: "operator:test",
      requestId: "request-test",
      keyProviders: [keyProvider],
      githubTransport: transport,
      envelopeAudit: () => undefined,
      credentialAudit: () => {
        throw new Error("audit unavailable");
      },
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    });

    await expect(materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
    }, dependencies)).rejects.toThrow("github_credential_audit_failed");
    expect(transport.requests).toHaveLength(0);
  });

  it("rolls back database state and removes GitHub output after a later binding failure", async () => {
    const { db, root } = fixture();
    const { repository } = registerGitHub(db);
    const runtime = githubRuntime();

    await expect(materializeConnectedRepository(db, {
      tenantId: "tenant-a",
      repositoryId: repository.id,
      consumerRepoId: "missing-consumer-repository",
    }, runtime.dependencies)).rejects.toThrow("consumer_repository_tenant_mismatch");

    expect(listRepositorySnapshots(db, "tenant-a", repository.id)).toHaveLength(0);
    const snapshotRoot = join(root, ".mendpoint-snapshots", "tenant-a");
    expect(existsSync(snapshotRoot) ? readdirSync(snapshotRoot) : []).toEqual([]);
  });

  it("requires numeric installation and repository IDs for GitHub selection", () => {
    const { db } = fixture();
    expect(() => registerScmConnection(db, {
      tenantId: "tenant-a",
      provider: "github",
      credentialRef: "memory://github/installations/not-numeric",
      externalAccountId: "customer-org",
      displayName: "Customer GitHub",
    })).toThrow("github_installation_id_invalid");

    const connection = registerScmConnection(db, {
      tenantId: "tenant-a",
      provider: "github",
      credentialRef: "memory://github/installations/12345",
      externalAccountId: "12345",
      displayName: "Customer GitHub",
    });
    expect(() => registerConnectedRepository(db, {
      tenantId: "tenant-a",
      connectionId: connection.id,
      remoteId: "acme/service",
      owner: "acme",
      name: "service",
      defaultBranch: "main",
    })).toThrow("github_repository_id_invalid");
  });
});
