import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SecretMaterial } from "./credentials.js";
import {
  RepositorySourceError,
  createGitHubRepositorySource,
  type GitHubRepositoryTransport,
  type GitHubTransportRequest,
  type GitHubTransportResponse,
} from "./repository-source.js";

const COMMIT = "1".repeat(40);
const TREE = "2".repeat(40);
const BLOB_A = "3".repeat(40);
const BLOB_B = "4".repeat(40);
const BLOB_C = "5".repeat(40);
const INSTALLATION_ID = "12345";
const REPOSITORY_ID = "98765";
const LFS_POINTER = Buffer.from(
  "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 1\n",
);
const roots: string[] = [];

type TreeEntry = {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
};

class FakeGitHubTransport implements GitHubRepositoryTransport {
  readonly provenance = "test" as const;
  readonly requests: GitHubTransportRequest[] = [];

  constructor(
    private readonly handler: (
      input: GitHubTransportRequest,
    ) => GitHubTransportResponse | Promise<GitHubTransportResponse>,
  ) {}

  async request(input: GitHubTransportRequest): Promise<GitHubTransportResponse> {
    this.requests.push(input);
    return this.handler(input);
  }
}

function json(status: number, body: unknown): GitHubTransportResponse {
  return { status, body };
}

function fixtureTransport(
  entries: TreeEntry[],
  blobs: Readonly<Record<string, Buffer>>,
  override?: (input: GitHubTransportRequest) => GitHubTransportResponse | undefined,
): FakeGitHubTransport {
  return new FakeGitHubTransport((input) => {
    const overridden = override?.(input);
    if (overridden) return overridden;
    if (input.path === `/repositories/${REPOSITORY_ID}`) {
      return json(200, {
        id: Number(REPOSITORY_ID),
        full_name: "acme/service",
        default_branch: "main",
        permissions: { pull: true, push: false },
      });
    }
    if (input.path === "/repos/acme/service/git/ref/heads/main") {
      return json(200, { object: { type: "commit", sha: COMMIT } });
    }
    if (input.path === `/repos/acme/service/git/commits/${COMMIT}`) {
      return json(200, { sha: COMMIT, tree: { sha: TREE } });
    }
    if (input.path === `/repos/acme/service/git/trees/${TREE}?recursive=1`) {
      return json(200, { truncated: false, tree: entries });
    }
    const blobSha = input.path.split("/").at(-1)!;
    const blob = blobs[blobSha];
    if (input.path.includes("/git/blobs/") && blob) {
      return json(200, {
        encoding: "base64",
        size: blob.length,
        content: blob.toString("base64"),
      });
    }
    return json(404, { message: "Not Found" });
  });
}

async function source(
  transport: GitHubRepositoryTransport,
  policy?: Parameters<typeof createGitHubRepositorySource>[0]["policy"],
) {
  return createGitHubRepositorySource({
    installationId: INSTALLATION_ID,
    repositoryId: REPOSITORY_ID,
    owner: "acme",
    name: "service",
    credential: new SecretMaterial("installation-token-secret"),
    transport,
    policy,
  });
}

function destination(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-github-source-"));
  roots.push(root);
  return join(root, name);
}

function makeFixtureTreeWritable(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o755);
    for (const entry of readdirSync(path)) {
      makeFixtureTreeWritable(join(path, entry));
    }
    return;
  }
  chmodSync(path, 0o644);
}

afterEach(() => {
  while (roots.length) {
    const root = roots.pop()!;
    makeFixtureTreeWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("GitHub repository source", () => {
  it("authorizes an installation repository and materializes an exact immutable commit", async () => {
    const packageJson = Buffer.from(JSON.stringify({ scripts: { test: "vitest run" } }));
    const codeowners = Buffer.from("* @acme/platform\n");
    const workflow = Buffer.from("steps:\n  - run: npm test\n");
    const transport = fixtureTransport(
      [
        { path: "package.json", mode: "100644", type: "blob", sha: BLOB_A, size: packageJson.length },
        { path: ".github/CODEOWNERS", mode: "100644", type: "blob", sha: BLOB_B, size: codeowners.length },
        { path: ".github/workflows/ci.yml", mode: "100644", type: "blob", sha: BLOB_C, size: workflow.length },
      ],
      { [BLOB_A]: packageJson, [BLOB_B]: codeowners, [BLOB_C]: workflow },
    );
    const github = await source(transport);
    const resolved = await github.resolveRef("main");
    expect(resolved).toMatchObject({
      provider: "github",
      repositoryId: `github:${REPOSITORY_ID}`,
      requestedRef: "main",
      sha: COMMIT,
      observedRef: "main",
    });

    const snapshot = await github.materialize(resolved, destination("snapshot"));
    const discovery = await github.discover(snapshot);

    expect(snapshot).toMatchObject({
      provider: "github",
      repositoryId: `github:${REPOSITORY_ID}`,
      requestedRef: "main",
      sha: COMMIT,
    });
    expect(snapshot.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.files).toHaveLength(3);
    expect(snapshot.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(discovery.codeowners).toEqual([
      { path: ".github/CODEOWNERS", content: "* @acme/platform\n" },
    ]);
    expect(discovery.ci).toEqual([
      { path: ".github/workflows/ci.yml", provider: "github_actions" },
    ]);
    expect(discovery.verificationCommands).toContainEqual({
      command: "npm run test",
      source: "package.json",
      kind: "test",
    });
    expect(JSON.stringify({ resolved, snapshot, requests: transport.requests }))
      .not.toContain("installation-token-secret");
    expect(transport.requests.every((request) => request.installationId === INSTALLATION_ID))
      .toBe(true);
  });

  it("fails closed when the installation cannot read the selected repository", async () => {
    const transport = fixtureTransport([], {}, (input) =>
      input.path === `/repositories/${REPOSITORY_ID}`
        ? json(200, {
            id: Number(REPOSITORY_ID),
            full_name: "other/repository",
            default_branch: "main",
            permissions: { pull: true },
          })
        : undefined,
    );
    await expect((await source(transport)).resolveRef("main"))
      .rejects.toMatchObject({ code: "REPOSITORY_NOT_AUTHORIZED" });
  });

  it("maps permission failures without exposing the credential", async () => {
    const transport = fixtureTransport([], {}, (input) =>
      input.path === `/repositories/${REPOSITORY_ID}`
        ? json(403, { message: "installation-token-secret" })
        : undefined,
    );
    const error = await (await source(transport)).resolveRef("main").catch((cause) => cause);
    expect(error).toMatchObject({ code: "PERMISSION_DENIED" });
    expect(JSON.stringify(error)).not.toContain("installation-token-secret");
  });

  it.each([
    {
      name: "submodules",
      entry: { path: "vendor/lib", mode: "160000", type: "commit", sha: BLOB_A } as TreeEntry,
      blobs: {},
      code: "SUBMODULE_UNSUPPORTED",
    },
    {
      name: "Git LFS pointers",
      entry: { path: "model.bin", mode: "100644", type: "blob", sha: BLOB_A, size: LFS_POINTER.length } as TreeEntry,
      blobs: { [BLOB_A]: LFS_POINTER },
      code: "LFS_UNSUPPORTED",
    },
    {
      name: "symlinks",
      entry: { path: "current", mode: "120000", type: "blob", sha: BLOB_A, size: 9 } as TreeEntry,
      blobs: { [BLOB_A]: Buffer.from("target.ts") },
      code: "SYMLINK_UNSUPPORTED",
    },
  ])("rejects $name by default and cleans partial output", async ({ entry, blobs, code }) => {
    const first = Buffer.from("export const ok = true;\n");
    const entries: TreeEntry[] = [
      { path: "first.ts", mode: "100644", type: "blob", sha: BLOB_B, size: first.length },
      entry,
    ];
    const target = destination("rejected");
    const github = await source(fixtureTransport(entries, { ...blobs, [BLOB_B]: first }));
    const resolved = await github.resolveRef("main");
    await expect(github.materialize(resolved, target)).rejects.toMatchObject({ code });
    expect(existsSync(target)).toBe(false);
  });

  it("rejects traversal paths and declared files above the size bound", async () => {
    const traversalTarget = destination("traversal");
    const traversal = await source(fixtureTransport([
      { path: "../escape", mode: "100644", type: "blob", sha: BLOB_A, size: 1 },
    ], { [BLOB_A]: Buffer.from("x") }));
    await expect(traversal.materialize(await traversal.resolveRef("main"), traversalTarget))
      .rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(existsSync(traversalTarget)).toBe(false);

    const sizeTarget = destination("size");
    const oversized = await source(fixtureTransport([
      { path: "large.bin", mode: "100644", type: "blob", sha: BLOB_A, size: 11 },
    ], { [BLOB_A]: Buffer.alloc(11) }), { maxFileBytes: 10, maxSnapshotBytes: 10 });
    await expect(oversized.materialize(await oversized.resolveRef("main"), sizeTarget))
      .rejects.toMatchObject({ code: "SNAPSHOT_LIMIT_EXCEEDED" });
    expect(existsSync(sizeTarget)).toBe(false);
  });

  it("detects branch movement before finalizing the snapshot", async () => {
    const movedCommit = "9".repeat(40);
    let refReads = 0;
    const file = Buffer.from("ok\n");
    const transport = fixtureTransport(
      [{ path: "file.txt", mode: "100644", type: "blob", sha: BLOB_A, size: file.length }],
      { [BLOB_A]: file },
      (input) => {
        if (input.path === "/repos/acme/service/git/ref/heads/main") {
          refReads += 1;
          return json(200, { object: { type: "commit", sha: refReads >= 3 ? movedCommit : COMMIT } });
        }
        if (input.path === `/repos/acme/service/git/commits/${movedCommit}`) {
          return json(200, { sha: movedCommit, tree: { sha: TREE } });
        }
        return undefined;
      },
    );
    const github = await source(transport);
    const resolved = await github.resolveRef("main");
    const target = destination("drift");
    await expect(github.materialize(resolved, target)).rejects.toMatchObject({ code: "REF_DRIFT" });
    expect(existsSync(target)).toBe(false);
  });

  it("rejects a truncated GitHub tree", async () => {
    const transport = fixtureTransport([], {}, (input) =>
      input.path === `/repos/acme/service/git/trees/${TREE}?recursive=1`
        ? json(200, { truncated: true, tree: [] })
        : undefined,
    );
    const github = await source(transport);
    await expect(github.materialize(await github.resolveRef("main"), destination("truncated")))
      .rejects.toMatchObject({ code: "REMOTE_TREE_TRUNCATED" });
  });
});
