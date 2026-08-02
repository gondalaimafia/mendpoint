import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import type { SecretMaterial } from "./credentials.js";

export type RepositorySourcePolicy = {
  allowDirtyWorktree?: boolean;
  allowSubmodules?: boolean;
  allowLfsPointers?: boolean;
  allowSymlinks?: boolean;
  maxFileBytes?: number;
  maxSnapshotBytes?: number;
  sparsePaths?: string[];
};

export type RepositoryProbe = {
  provider: string;
  repositoryId: string;
  defaultBranch: string | null;
  headSha: string | null;
  dirty: boolean;
  hasSubmodules: boolean;
  hasLfsPointers: boolean;
};

export type ResolvedRepositoryRef = {
  provider: string;
  repositoryId: string;
  requestedRef: string;
  sha: string;
  /** Present when the requested ref can move and must be checked for drift. */
  observedRef: string | null;
};

export type SnapshotFile = {
  path: string;
  mode: string;
  kind: "file" | "symlink";
  size: number;
  sha256: string;
};

export type SnapshotSubmodule = {
  path: string;
  sha: string;
};

export type ImmutableRepositorySnapshot = {
  provider: string;
  repositoryId: string;
  requestedRef: string;
  sha: string;
  root: string;
  manifestSha256: string;
  files: readonly SnapshotFile[];
  submodules: readonly SnapshotSubmodule[];
  lfsPointers: readonly string[];
  sparsePaths: readonly string[];
};

export type DiscoveredDocument = {
  path: string;
  content: string;
};

export type DiscoveredCiConfig = {
  provider:
    | "github_actions"
    | "gitlab_ci"
    | "bitbucket_pipelines"
    | "azure_pipelines"
    | "circleci"
    | "jenkins";
  path: string;
};

export type DiscoveredVerificationCommand = {
  command: string;
  source: string;
  kind: "test" | "typecheck" | "lint" | "build" | "check" | "verify" | "ci";
};

export type RepositoryDiscovery = {
  codeowners: readonly DiscoveredDocument[];
  ci: readonly DiscoveredCiConfig[];
  verificationCommands: readonly DiscoveredVerificationCommand[];
};

export interface RepositorySource {
  readonly provider: string;
  probe(): Promise<RepositoryProbe>;
  resolveRef(ref: string): Promise<ResolvedRepositoryRef>;
  materialize(
    resolvedRef: ResolvedRepositoryRef,
    destination: string,
  ): Promise<ImmutableRepositorySnapshot>;
  discover(snapshot: ImmutableRepositorySnapshot): Promise<RepositoryDiscovery>;
}

export type RepositorySourceErrorCode =
  | "NOT_REPOSITORY"
  | "DIRTY_WORKTREE"
  | "REF_NOT_FOUND"
  | "REF_DRIFT"
  | "SOURCE_MISMATCH"
  | "SUBMODULE_UNSUPPORTED"
  | "LFS_UNSUPPORTED"
  | "SYMLINK_UNSUPPORTED"
  | "UNSAFE_PATH"
  | "UNSAFE_DESTINATION"
  | "SNAPSHOT_TARGET_EXISTS"
  | "SNAPSHOT_LIMIT_EXCEEDED"
  | "SNAPSHOT_MUTATED"
  | "AUTHENTICATION_FAILED"
  | "PERMISSION_DENIED"
  | "REPOSITORY_NOT_AUTHORIZED"
  | "REMOTE_RESPONSE_INVALID"
  | "REMOTE_TREE_TRUNCATED"
  | "GIT_COMMAND_FAILED";

export class RepositorySourceError extends Error {
  constructor(
    readonly code: RepositorySourceErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RepositorySourceError";
  }
}

type GitTreeEntry = {
  mode: string;
  type: string;
  object: string;
  path: string;
};

const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const LFS_HEADER = "version https://git-lfs.github.com/spec/v1\n";
const EXACT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export type GitHubTransportRequest = Readonly<{
  installationId: string;
  method: "GET";
  path: string;
  credential: SecretMaterial;
}>;

export type GitHubTransportResponse = Readonly<{
  status: number;
  body: unknown;
}>;

export interface GitHubRepositoryTransport {
  /** Test transports must never be counted as proven live capability health. */
  readonly provenance: "live" | "test";
  request(input: GitHubTransportRequest): Promise<GitHubTransportResponse>;
}

export class FetchGitHubRepositoryTransport implements GitHubRepositoryTransport {
  readonly provenance = "live" as const;

  constructor(private readonly baseUrl = "https://api.github.com") {}

  async request(input: GitHubTransportRequest): Promise<GitHubTransportResponse> {
    const response = await fetch(new URL(input.path, this.baseUrl), {
      method: input.method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.credential.reveal()}`,
        "User-Agent": "mendpoint-repository-source",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitBuffer(repositoryPath: string, args: readonly string[]): Buffer {
  try {
    return execFileSync("git", ["-C", repositoryPath, ...args], {
      encoding: null,
      maxBuffer: DEFAULT_MAX_SNAPSHOT_BYTES,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    throw new RepositorySourceError(
      "GIT_COMMAND_FAILED",
      `Git command failed: git ${args.join(" ")}`,
      cause,
    );
  }
}

function gitText(repositoryPath: string, args: readonly string[]): string {
  return gitBuffer(repositoryPath, args).toString("utf8").trim();
}

function tryGitText(repositoryPath: string, args: readonly string[]): string | null {
  try {
    return gitText(repositoryPath, args);
  } catch {
    return null;
  }
}

/** Shared path validation for local and remote RepositorySource implementations. */
export function validateRepositoryRelativePath(candidate: string): string {
  if (
    !candidate ||
    candidate.includes("\0") ||
    /[\x01-\x1f\x7f]/.test(candidate) ||
    candidate.includes("\\") ||
    isAbsolute(candidate) ||
    /^[a-zA-Z]:/.test(candidate)
  ) {
    throw new RepositorySourceError("UNSAFE_PATH", `Unsafe repository path: ${candidate}`);
  }
  const normalized = posix.normalize(candidate);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized !== candidate ||
    candidate.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new RepositorySourceError("UNSAFE_PATH", `Unsafe repository path: ${candidate}`);
  }
  return normalized;
}

function safeDestination(root: string, repositoryPath: string): string {
  const absolute = resolve(root);
  const fromRepository = relative(repositoryPath, absolute);
  if (fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
    throw new RepositorySourceError(
      "UNSAFE_DESTINATION",
      "Snapshot destination must be outside the source repository",
    );
  }
  return absolute;
}

function destinationFor(root: string, repositoryPath: string): string {
  const safePath = validateRepositoryRelativePath(repositoryPath);
  const target = resolve(root, ...safePath.split("/"));
  const fromRoot = relative(root, target);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new RepositorySourceError("UNSAFE_PATH", `Repository path escapes snapshot: ${safePath}`);
  }
  return target;
}

function parseTree(buffer: Buffer): GitTreeEntry[] {
  const records = buffer.toString("utf8").split("\0").filter(Boolean);
  return records.map((record) => {
    if (record.includes("\ufffd")) {
      throw new RepositorySourceError("UNSAFE_PATH", "Repository path is not valid UTF-8");
    }
    const tab = record.indexOf("\t");
    const metadata = tab < 0 ? [] : record.slice(0, tab).split(" ");
    const path = tab < 0 ? "" : record.slice(tab + 1);
    if (metadata.length !== 3 || !path) {
      throw new RepositorySourceError("GIT_COMMAND_FAILED", "Git returned a malformed tree entry");
    }
    validateRepositoryRelativePath(path);
    return { mode: metadata[0]!, type: metadata[1]!, object: metadata[2]!, path };
  });
}

function treeAt(repositoryPath: string, sha: string): GitTreeEntry[] {
  return parseTree(gitBuffer(repositoryPath, ["ls-tree", "-r", "-z", "--full-tree", sha]));
}

function isLfsPointer(content: Buffer): boolean {
  return content.subarray(0, LFS_HEADER.length).toString("utf8") === LFS_HEADER;
}

function validateSymlinkTarget(linkPath: string, target: string): void {
  if (
    !target ||
    target.includes("\0") ||
    /[\x01-\x1f\x7f]/.test(target) ||
    target.includes("\\") ||
    posix.isAbsolute(target) ||
    /^[a-zA-Z]:/.test(target)
  ) {
    throw new RepositorySourceError(
      "UNSAFE_PATH",
      `Symlink ${linkPath} has an unsafe target: ${target}`,
    );
  }
  const resolvedTarget = posix.normalize(posix.join(posix.dirname(linkPath), target));
  if (
    resolvedTarget === ".." ||
    resolvedTarget.startsWith("../") ||
    resolvedTarget.startsWith("/")
  ) {
    throw new RepositorySourceError(
      "UNSAFE_PATH",
      `Symlink ${linkPath} escapes the repository snapshot`,
    );
  }
}

function manifestDigest(
  files: readonly SnapshotFile[],
  submodules: readonly SnapshotSubmodule[],
  sparsePaths: readonly string[],
): string {
  return sha256(
    JSON.stringify({
      files: [...files].sort((a, b) => a.path.localeCompare(b.path)),
      submodules: [...submodules].sort((a, b) => a.path.localeCompare(b.path)),
      sparsePaths: [...sparsePaths].sort(),
    }),
  );
}

function currentDirtyState(repositoryPath: string): boolean {
  return gitBuffer(repositoryPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    .length > 0;
}

function resolveCommit(repositoryPath: string, ref: string): string {
  if (!ref || ref.includes("\0") || /[\r\n]/.test(ref)) {
    throw new RepositorySourceError("REF_NOT_FOUND", "Repository ref is empty or invalid");
  }
  const sha = tryGitText(repositoryPath, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  if (!sha || !EXACT_OBJECT_ID.test(sha)) {
    throw new RepositorySourceError("REF_NOT_FOUND", `Repository ref does not resolve: ${ref}`);
  }
  return sha.toLowerCase();
}

function ciProvider(path: string): DiscoveredCiConfig["provider"] | null {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path)) return "github_actions";
  if (path === ".gitlab-ci.yml") return "gitlab_ci";
  if (path === "bitbucket-pipelines.yml") return "bitbucket_pipelines";
  if (path === "azure-pipelines.yml" || /^\.azure-pipelines\/[^/]+\.ya?ml$/i.test(path)) {
    return "azure_pipelines";
  }
  if (path === ".circleci/config.yml") return "circleci";
  if (path === "Jenkinsfile") return "jenkins";
  return null;
}

function commandKind(name: string): DiscoveredVerificationCommand["kind"] | null {
  const normalized = name.toLowerCase();
  if (normalized === "test" || normalized.startsWith("test:")) return "test";
  if (normalized === "typecheck" || normalized === "type-check") return "typecheck";
  if (normalized === "lint" || normalized.startsWith("lint:")) return "lint";
  if (normalized === "build" || normalized.startsWith("build:")) return "build";
  if (normalized === "check" || normalized.startsWith("check:")) return "check";
  if (normalized === "verify" || normalized.startsWith("verify:")) return "verify";
  if (normalized === "ci") return "ci";
  return null;
}

function packageRunner(paths: Set<string>, packageManager?: string): string {
  if (packageManager?.startsWith("pnpm@") || paths.has("pnpm-lock.yaml")) return "pnpm";
  if (packageManager?.startsWith("yarn@") || paths.has("yarn.lock")) return "yarn";
  if (packageManager?.startsWith("bun@") || paths.has("bun.lock") || paths.has("bun.lockb")) {
    return "bun";
  }
  return "npm";
}

async function freezeSnapshot(root: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        await chmod(path, 0o555);
      } else if (!entry.isSymbolicLink()) {
        const current = await lstat(path);
        await chmod(path, current.mode & 0o111 ? 0o555 : 0o444);
      }
    }
  };
  await visit(root);
  await chmod(root, 0o555);
}

export async function createLocalGitRepositorySource(input: {
  repositoryPath: string;
  policy?: RepositorySourcePolicy;
}): Promise<RepositorySource> {
  let repositoryPath: string;
  try {
    repositoryPath = await realpath(input.repositoryPath);
  } catch (cause) {
    throw new RepositorySourceError("NOT_REPOSITORY", "Repository path does not exist", cause);
  }
  const root = tryGitText(repositoryPath, ["rev-parse", "--show-toplevel"]);
  if (!root) {
    throw new RepositorySourceError("NOT_REPOSITORY", "Path is not inside a Git worktree");
  }
  repositoryPath = await realpath(root);
  const bare = tryGitText(repositoryPath, ["rev-parse", "--is-bare-repository"]);
  if (bare !== "false") {
    throw new RepositorySourceError("NOT_REPOSITORY", "Local source requires a Git worktree");
  }

  const policy = input.policy ?? {};
  const repositoryId = `local-git:${repositoryPath}`;
  const maxFileBytes = policy.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxSnapshotBytes = policy.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  const sparsePaths = [...new Set((policy.sparsePaths ?? []).map(validateRepositoryRelativePath))]
    .sort();
  if (maxFileBytes <= 0 || maxSnapshotBytes <= 0 || maxFileBytes > maxSnapshotBytes) {
    throw new RepositorySourceError("SNAPSHOT_LIMIT_EXCEEDED", "Invalid snapshot size policy");
  }

  const assertClean = (): void => {
    if (!policy.allowDirtyWorktree && currentDirtyState(repositoryPath)) {
      throw new RepositorySourceError(
        "DIRTY_WORKTREE",
        "Local worktree has uncommitted or untracked changes; use an exact clean source",
      );
    }
  };

  const assertSource = (ref: ResolvedRepositoryRef): void => {
    if (ref.provider !== "local-git" || ref.repositoryId !== repositoryId) {
      throw new RepositorySourceError(
        "SOURCE_MISMATCH",
        "Resolved ref belongs to a different repository source",
      );
    }
  };

  const assertNoDrift = (ref: ResolvedRepositoryRef): void => {
    if (ref.observedRef && resolveCommit(repositoryPath, ref.observedRef) !== ref.sha) {
      throw new RepositorySourceError(
        "REF_DRIFT",
        `Repository ref moved after resolution: ${ref.observedRef}`,
      );
    }
  };

  const source: RepositorySource = {
    provider: "local-git",

    async probe() {
      const headSha = tryGitText(repositoryPath, ["rev-parse", "--verify", "HEAD"]);
      const entries = headSha && EXACT_OBJECT_ID.test(headSha) ? treeAt(repositoryPath, headSha) : [];
      let hasLfsPointers = false;
      for (const entry of entries) {
        if (entry.type !== "blob") continue;
        const size = Number(gitText(repositoryPath, ["cat-file", "-s", entry.object]));
        if (size <= 512 && isLfsPointer(gitBuffer(repositoryPath, ["cat-file", "blob", entry.object]))) {
          hasLfsPointers = true;
          break;
        }
      }
      return {
        provider: "local-git",
        repositoryId,
        defaultBranch: tryGitText(repositoryPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
        headSha: headSha?.toLowerCase() ?? null,
        dirty: currentDirtyState(repositoryPath),
        hasSubmodules: entries.some((entry) => entry.mode === "160000"),
        hasLfsPointers,
      };
    },

    async resolveRef(ref) {
      assertClean();
      const sha = resolveCommit(repositoryPath, ref);
      return {
        provider: "local-git",
        repositoryId,
        requestedRef: ref,
        sha,
        observedRef: EXACT_OBJECT_ID.test(ref) ? null : ref,
      };
    },

    async materialize(ref, destination) {
      assertSource(ref);
      assertClean();
      assertNoDrift(ref);
      const targetRoot = safeDestination(destination, repositoryPath);
      const parent = await realpath(dirname(targetRoot)).catch((cause) => {
        throw new RepositorySourceError(
          "UNSAFE_DESTINATION",
          "Snapshot destination parent must already exist",
          cause,
        );
      });
      if (resolve(parent, basename(targetRoot)) !== targetRoot) {
        throw new RepositorySourceError("UNSAFE_DESTINATION", "Snapshot destination is ambiguous");
      }
      try {
        await lstat(targetRoot);
        throw new RepositorySourceError(
          "SNAPSHOT_TARGET_EXISTS",
          "Snapshot destination must not already exist",
        );
      } catch (cause) {
        if (cause instanceof RepositorySourceError) throw cause;
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }

      const entries = treeAt(repositoryPath, ref.sha).filter(
        (entry) =>
          sparsePaths.length === 0 ||
          sparsePaths.some((path) => entry.path === path || entry.path.startsWith(`${path}/`)),
      );
      const seenPortablePaths = new Set<string>();
      const files: SnapshotFile[] = [];
      const submodules: SnapshotSubmodule[] = [];
      const lfsPointers: string[] = [];
      let totalBytes = 0;
      await mkdir(targetRoot);
      try {
        for (const entry of entries) {
          const portablePath = entry.path.toLowerCase();
          if (seenPortablePaths.has(portablePath)) {
            throw new RepositorySourceError(
              "UNSAFE_PATH",
              `Repository paths collide on a case-insensitive filesystem: ${entry.path}`,
            );
          }
          seenPortablePaths.add(portablePath);

          if (entry.mode === "160000") {
            if (!policy.allowSubmodules) {
              throw new RepositorySourceError(
                "SUBMODULE_UNSUPPORTED",
                `Repository contains submodule ${entry.path}; explicit policy is required`,
              );
            }
            submodules.push({ path: entry.path, sha: entry.object });
            continue;
          }
          if (entry.type !== "blob") {
            throw new RepositorySourceError(
              "GIT_COMMAND_FAILED",
              `Unsupported Git tree object ${entry.type} at ${entry.path}`,
            );
          }

          const content = gitBuffer(repositoryPath, ["cat-file", "blob", entry.object]);
          if (content.length > maxFileBytes || totalBytes + content.length > maxSnapshotBytes) {
            throw new RepositorySourceError(
              "SNAPSHOT_LIMIT_EXCEEDED",
              `Snapshot size policy exceeded at ${entry.path}`,
            );
          }
          totalBytes += content.length;
          const target = destinationFor(targetRoot, entry.path);
          await mkdir(dirname(target), { recursive: true });

          if (entry.mode === "120000") {
            const linkTarget = content.toString("utf8");
            validateSymlinkTarget(entry.path, linkTarget);
            if (!policy.allowSymlinks) {
              throw new RepositorySourceError(
                "SYMLINK_UNSUPPORTED",
                `Repository contains symlink ${entry.path}; explicit policy is required`,
              );
            }
            await symlink(linkTarget, target);
            files.push({
              path: entry.path,
              mode: entry.mode,
              kind: "symlink",
              size: content.length,
              sha256: sha256(content),
            });
            continue;
          }

          if (isLfsPointer(content)) {
            if (!policy.allowLfsPointers) {
              throw new RepositorySourceError(
                "LFS_UNSUPPORTED",
                `Repository contains Git LFS pointer ${entry.path}; explicit policy is required`,
              );
            }
            lfsPointers.push(entry.path);
          }
          await writeFile(target, content, { mode: entry.mode === "100755" ? 0o755 : 0o644 });
          files.push({
            path: entry.path,
            mode: entry.mode,
            kind: "file",
            size: content.length,
            sha256: sha256(content),
          });
        }
        assertNoDrift(ref);
        const snapshot: ImmutableRepositorySnapshot = {
          provider: "local-git",
          repositoryId,
          requestedRef: ref.requestedRef,
          sha: ref.sha,
          root: await realpath(targetRoot),
          manifestSha256: manifestDigest(files, submodules, sparsePaths),
          files: Object.freeze(files.map((file) => Object.freeze({ ...file }))),
          submodules: Object.freeze(submodules.map((item) => Object.freeze({ ...item }))),
          lfsPointers: Object.freeze([...lfsPointers]),
          sparsePaths: Object.freeze([...sparsePaths]),
        };
        await freezeSnapshot(targetRoot);
        return Object.freeze(snapshot);
      } catch (cause) {
        await chmod(targetRoot, 0o755).catch(() => undefined);
        await rm(targetRoot, { recursive: true, force: true });
        throw cause;
      }
    },

    async discover(snapshot) {
      if (snapshot.provider !== "local-git" || snapshot.repositoryId !== repositoryId) {
        throw new RepositorySourceError(
          "SOURCE_MISMATCH",
          "Snapshot belongs to a different repository source",
        );
      }
      if (
        manifestDigest(snapshot.files, snapshot.submodules, snapshot.sparsePaths) !==
        snapshot.manifestSha256
      ) {
        throw new RepositorySourceError("SNAPSHOT_MUTATED", "Snapshot manifest has changed");
      }
      const snapshotRoot = await realpath(snapshot.root);
      const filesByPath = new Map(snapshot.files.map((file) => [file.path, file]));
      const paths = new Set(filesByPath.keys());

      const readTrackedText = async (path: string): Promise<string> => {
        const manifest = filesByPath.get(path);
        if (!manifest || manifest.kind !== "file") {
          throw new RepositorySourceError("SNAPSHOT_MUTATED", `Snapshot file is unavailable: ${path}`);
        }
        const target = destinationFor(snapshotRoot, path);
        const stat = await lstat(target).catch((cause) => {
          throw new RepositorySourceError("SNAPSHOT_MUTATED", `Snapshot file is missing: ${path}`, cause);
        });
        if (!stat.isFile() || stat.isSymbolicLink()) {
          throw new RepositorySourceError("SNAPSHOT_MUTATED", `Snapshot path changed type: ${path}`);
        }
        const actual = await realpath(target);
        const fromRoot = relative(snapshotRoot, actual);
        if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
          throw new RepositorySourceError("SNAPSHOT_MUTATED", `Snapshot path escaped its root: ${path}`);
        }
        const content = await readFile(actual);
        if (sha256(content) !== manifest.sha256) {
          throw new RepositorySourceError("SNAPSHOT_MUTATED", `Snapshot file changed: ${path}`);
        }
        return content.toString("utf8");
      };

      const codeownerPaths = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
      const codeowners: DiscoveredDocument[] = [];
      for (const path of codeownerPaths) {
        if (paths.has(path)) codeowners.push({ path, content: await readTrackedText(path) });
      }

      const ci = [...paths]
        .map((path) => ({ path, provider: ciProvider(path) }))
        .filter((item): item is DiscoveredCiConfig => item.provider !== null)
        .sort((a, b) => a.path.localeCompare(b.path));

      const commands: DiscoveredVerificationCommand[] = [];
      if (paths.has("package.json")) {
        const parsed = JSON.parse(await readTrackedText("package.json")) as {
          packageManager?: string;
          scripts?: Record<string, unknown>;
        };
        const runner = packageRunner(paths, parsed.packageManager);
        for (const name of Object.keys(parsed.scripts ?? {}).sort()) {
          const kind = commandKind(name);
          if (kind && typeof parsed.scripts?.[name] === "string") {
            commands.push({ command: `${runner} run ${name}`, source: "package.json", kind });
          }
        }
      }

      if (paths.has("Makefile")) {
        const makefile = await readTrackedText("Makefile");
        for (const match of makefile.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?![=])/gm)) {
          const name = match[1]!;
          const kind = commandKind(name);
          if (kind) commands.push({ command: `make ${name}`, source: "Makefile", kind });
        }
      }

      const conventional: Array<[string, string, DiscoveredVerificationCommand["kind"]]> = [
        ["Cargo.toml", "cargo test", "test"],
        ["go.mod", "go test ./...", "test"],
        ["pom.xml", "mvn test", "test"],
        ["gradlew", "./gradlew test", "test"],
        ["pytest.ini", "pytest", "test"],
      ];
      for (const [path, command, kind] of conventional) {
        if (paths.has(path)) commands.push({ command, source: path, kind });
      }

      for (const config of ci) {
        const content = await readTrackedText(config.path);
        for (const match of content.matchAll(/^\s*(?:-\s*)?run:\s*["']?([^\r\n"']+)["']?\s*$/gm)) {
          const command = match[1]!.trim();
          const kind = ["test", "typecheck", "lint", "build", "check", "verify"]
            .map(commandKind)
            .find((candidate, index) => candidate && command.toLowerCase().includes(
              ["test", "typecheck", "lint", "build", "check", "verify"][index]!,
            ));
          if (kind) commands.push({ command, source: config.path, kind });
        }
      }

      const deduped = new Map<string, DiscoveredVerificationCommand>();
      for (const command of commands) {
        deduped.set(`${command.command}\0${command.source}`, command);
      }
      return {
        codeowners,
        ci,
        verificationCommands: [...deduped.values()].sort(
          (a, b) => a.source.localeCompare(b.source) || a.command.localeCompare(b.command),
        ),
      };
    },
  };

  return source;
}

type JsonRecord = Record<string, unknown>;

type GitHubRepositoryMetadata = Readonly<{
  id: string;
  fullName: string;
  defaultBranch: string;
}>;

type GitHubTreeEntry = Readonly<{
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size: number | null;
}>;

function jsonRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function requiredString(record: JsonRecord, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new RepositorySourceError(
      "REMOTE_RESPONSE_INVALID",
      `GitHub response is missing ${field}`,
    );
  }
  return value;
}

function requiredObjectId(record: JsonRecord, field: string): string {
  const value = requiredString(record, field).toLowerCase();
  if (!EXACT_OBJECT_ID.test(value)) {
    throw new RepositorySourceError(
      "REMOTE_RESPONSE_INVALID",
      `GitHub response has an invalid ${field}`,
    );
  }
  return value;
}

async function githubJson(
  transport: GitHubRepositoryTransport,
  installationId: string,
  credential: SecretMaterial,
  path: string,
  notFound: RepositorySourceErrorCode = "REMOTE_RESPONSE_INVALID",
): Promise<JsonRecord> {
  let response: GitHubTransportResponse;
  try {
    response = await transport.request({
      installationId,
      method: "GET",
      path,
      credential,
    });
  } catch (cause) {
    throw new RepositorySourceError(
      "REMOTE_RESPONSE_INVALID",
      "GitHub request failed",
      cause,
    );
  }
  if (response.status === 401) {
    throw new RepositorySourceError("AUTHENTICATION_FAILED", "GitHub credential was rejected");
  }
  if (response.status === 403) {
    throw new RepositorySourceError("PERMISSION_DENIED", "GitHub repository read permission denied");
  }
  if (response.status === 404) {
    throw new RepositorySourceError(notFound, "GitHub resource was not found or is not authorized");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new RepositorySourceError(
      "REMOTE_RESPONSE_INVALID",
      `GitHub returned HTTP ${response.status}`,
    );
  }
  const body = jsonRecord(response.body);
  if (!body) {
    throw new RepositorySourceError("REMOTE_RESPONSE_INVALID", "GitHub returned malformed JSON");
  }
  return body;
}

function githubPathPart(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) || value === "." || value === "..") {
    throw new RepositorySourceError("REPOSITORY_NOT_AUTHORIZED", `Invalid GitHub ${field}`);
  }
  return encodeURIComponent(value);
}

function githubRefPath(value: string): string {
  if (
    value.length < 1 ||
    value.length > 255 ||
    value.includes("\0") ||
    /[\x01-\x20\x7f~^:?*[\\]/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock")
  ) {
    throw new RepositorySourceError("REF_NOT_FOUND", "GitHub ref is invalid");
  }
  return encodeURIComponent(value);
}

function parseGitHubTree(body: JsonRecord): GitHubTreeEntry[] {
  if (body.truncated === true) {
    throw new RepositorySourceError(
      "REMOTE_TREE_TRUNCATED",
      "GitHub truncated the repository tree; bounded snapshot cannot continue",
    );
  }
  if (!Array.isArray(body.tree)) {
    throw new RepositorySourceError("REMOTE_RESPONSE_INVALID", "GitHub tree is missing entries");
  }
  return body.tree.map((value): GitHubTreeEntry => {
    const entry = jsonRecord(value);
    if (!entry) {
      throw new RepositorySourceError("REMOTE_RESPONSE_INVALID", "GitHub tree entry is malformed");
    }
    const path = validateRepositoryRelativePath(requiredString(entry, "path"));
    const mode = requiredString(entry, "mode");
    const type = requiredString(entry, "type");
    if (type !== "blob" && type !== "tree" && type !== "commit") {
      throw new RepositorySourceError(
        "REMOTE_RESPONSE_INVALID",
        `GitHub tree entry has unsupported type at ${path}`,
      );
    }
    const rawSize = entry.size;
    const size = rawSize === undefined || rawSize === null
      ? null
      : Number.isSafeInteger(rawSize) && Number(rawSize) >= 0
        ? Number(rawSize)
        : NaN;
    if (Number.isNaN(size)) {
      throw new RepositorySourceError(
        "REMOTE_RESPONSE_INVALID",
        `GitHub tree entry has invalid size at ${path}`,
      );
    }
    return { path, mode, type, sha: requiredObjectId(entry, "sha"), size };
  });
}

function decodeGitHubBlob(body: JsonRecord, expectedSize: number | null): Buffer {
  if (body.encoding !== "base64") {
    throw new RepositorySourceError("REMOTE_RESPONSE_INVALID", "GitHub blob encoding is unsupported");
  }
  const encoded = requiredString(body, "content").replace(/[\r\n]/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new RepositorySourceError("REMOTE_RESPONSE_INVALID", "GitHub blob content is malformed");
  }
  const content = Buffer.from(encoded, "base64");
  const responseSize = body.size;
  if (
    (expectedSize !== null && content.length !== expectedSize) ||
    (responseSize !== undefined && (!Number.isSafeInteger(responseSize) || responseSize !== content.length))
  ) {
    throw new RepositorySourceError("REMOTE_RESPONSE_INVALID", "GitHub blob size does not match");
  }
  return content;
}

async function discoverImmutableSnapshot(
  snapshot: ImmutableRepositorySnapshot,
  provider: string,
  repositoryId: string,
): Promise<RepositoryDiscovery> {
  if (snapshot.provider !== provider || snapshot.repositoryId !== repositoryId) {
    throw new RepositorySourceError(
      "SOURCE_MISMATCH",
      "Snapshot belongs to a different repository source",
    );
  }
  if (
    manifestDigest(snapshot.files, snapshot.submodules, snapshot.sparsePaths) !==
    snapshot.manifestSha256
  ) {
    throw new RepositorySourceError("SNAPSHOT_MUTATED", "Snapshot manifest has changed");
  }
  const snapshotRoot = await realpath(snapshot.root);
  const filesByPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const paths = new Set(filesByPath.keys());

  const readTrackedText = async (path: string): Promise<string> => {
    const manifest = filesByPath.get(path);
    if (!manifest || manifest.kind !== "file") {
      throw new RepositorySourceError("SNAPSHOT_MUTATED", `Snapshot file is unavailable: ${path}`);
    }
    const target = destinationFor(snapshotRoot, path);
    const stat = await lstat(target).catch((cause) => {
      throw new RepositorySourceError("SNAPSHOT_MUTATED", `Snapshot file is missing: ${path}`, cause);
    });
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new RepositorySourceError("SNAPSHOT_MUTATED", `Snapshot path changed type: ${path}`);
    }
    const actual = await realpath(target);
    const fromRoot = relative(snapshotRoot, actual);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new RepositorySourceError("SNAPSHOT_MUTATED", `Snapshot path escaped its root: ${path}`);
    }
    const content = await readFile(actual);
    if (sha256(content) !== manifest.sha256) {
      throw new RepositorySourceError("SNAPSHOT_MUTATED", `Snapshot file changed: ${path}`);
    }
    return content.toString("utf8");
  };

  const codeowners: DiscoveredDocument[] = [];
  for (const path of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    if (paths.has(path)) codeowners.push({ path, content: await readTrackedText(path) });
  }
  const ci = [...paths]
    .map((path) => ({ path, provider: ciProvider(path) }))
    .filter((item): item is DiscoveredCiConfig => item.provider !== null)
    .sort((a, b) => a.path.localeCompare(b.path));
  const commands: DiscoveredVerificationCommand[] = [];
  if (paths.has("package.json")) {
    const parsed = JSON.parse(await readTrackedText("package.json")) as {
      packageManager?: string;
      scripts?: Record<string, unknown>;
    };
    const runner = packageRunner(paths, parsed.packageManager);
    for (const name of Object.keys(parsed.scripts ?? {}).sort()) {
      const kind = commandKind(name);
      if (kind && typeof parsed.scripts?.[name] === "string") {
        commands.push({ command: `${runner} run ${name}`, source: "package.json", kind });
      }
    }
  }
  if (paths.has("Makefile")) {
    const makefile = await readTrackedText("Makefile");
    for (const match of makefile.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?![=])/gm)) {
      const name = match[1]!;
      const kind = commandKind(name);
      if (kind) commands.push({ command: `make ${name}`, source: "Makefile", kind });
    }
  }
  const conventional: Array<[string, string, DiscoveredVerificationCommand["kind"]]> = [
    ["Cargo.toml", "cargo test", "test"],
    ["go.mod", "go test ./...", "test"],
    ["pom.xml", "mvn test", "test"],
    ["gradlew", "./gradlew test", "test"],
    ["pytest.ini", "pytest", "test"],
  ];
  for (const [path, command, kind] of conventional) {
    if (paths.has(path)) commands.push({ command, source: path, kind });
  }
  for (const config of ci) {
    const content = await readTrackedText(config.path);
    for (const match of content.matchAll(/^\s*(?:-\s*)?run:\s*["']?([^\r\n"']+)["']?\s*$/gm)) {
      const command = match[1]!.trim();
      const kind = ["test", "typecheck", "lint", "build", "check", "verify"]
        .map(commandKind)
        .find((candidate, index) => candidate && command.toLowerCase().includes(
          ["test", "typecheck", "lint", "build", "check", "verify"][index]!,
        ));
      if (kind) commands.push({ command, source: config.path, kind });
    }
  }
  const deduped = new Map<string, DiscoveredVerificationCommand>();
  for (const command of commands) deduped.set(`${command.command}\0${command.source}`, command);
  return {
    codeowners,
    ci,
    verificationCommands: [...deduped.values()].sort(
      (a, b) => a.source.localeCompare(b.source) || a.command.localeCompare(b.command),
    ),
  };
}

/** Read-only GitHub installation source pinned to an authorized repository ID. */
export async function createGitHubRepositorySource(input: {
  installationId: string;
  repositoryId: string;
  owner: string;
  name: string;
  credential: SecretMaterial;
  transport?: GitHubRepositoryTransport;
  policy?: RepositorySourcePolicy;
}): Promise<RepositorySource> {
  if (!/^[1-9][0-9]{0,19}$/.test(input.installationId)) {
    throw new RepositorySourceError("REPOSITORY_NOT_AUTHORIZED", "GitHub installation ID is invalid");
  }
  if (!/^[1-9][0-9]{0,19}$/.test(input.repositoryId)) {
    throw new RepositorySourceError("REPOSITORY_NOT_AUTHORIZED", "GitHub repository ID is invalid");
  }
  const owner = githubPathPart(input.owner, "owner");
  const name = githubPathPart(input.name, "repository name");
  const repositoryId = `github:${input.repositoryId}`;
  const transport = input.transport ?? new FetchGitHubRepositoryTransport();
  const policy = input.policy ?? {};
  const maxFileBytes = policy.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxSnapshotBytes = policy.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  const sparsePaths = [...new Set((policy.sparsePaths ?? []).map(validateRepositoryRelativePath))]
    .sort();
  if (maxFileBytes <= 0 || maxSnapshotBytes <= 0 || maxFileBytes > maxSnapshotBytes) {
    throw new RepositorySourceError("SNAPSHOT_LIMIT_EXCEEDED", "Invalid snapshot size policy");
  }

  const authorize = async (): Promise<GitHubRepositoryMetadata> => {
    const body = await githubJson(
      transport,
      input.installationId,
      input.credential,
      `/repositories/${input.repositoryId}`,
      "REPOSITORY_NOT_AUTHORIZED",
    );
    const id = String(body.id ?? "");
    const fullName = requiredString(body, "full_name");
    const permissions = jsonRecord(body.permissions);
    if (
      id !== input.repositoryId ||
      fullName.toLowerCase() !== `${input.owner}/${input.name}`.toLowerCase() ||
      permissions?.pull !== true
    ) {
      throw new RepositorySourceError(
        "REPOSITORY_NOT_AUTHORIZED",
        "GitHub installation does not authorize the selected repository",
      );
    }
    return {
      id,
      fullName,
      defaultBranch: requiredString(body, "default_branch"),
    };
  };

  const commit = async (sha: string): Promise<{ sha: string; treeSha: string }> => {
    const body = await githubJson(
      transport,
      input.installationId,
      input.credential,
      `/repos/${owner}/${name}/git/commits/${sha}`,
      "REF_NOT_FOUND",
    );
    const tree = jsonRecord(body.tree);
    if (!tree) {
      throw new RepositorySourceError("REMOTE_RESPONSE_INVALID", "GitHub commit tree is missing");
    }
    return { sha: requiredObjectId(body, "sha"), treeSha: requiredObjectId(tree, "sha") };
  };

  const resolveRemoteRef = async (ref: string): Promise<ResolvedRepositoryRef> => {
    await authorize();
    if (EXACT_OBJECT_ID.test(ref)) {
      const resolved = await commit(ref.toLowerCase());
      return {
        provider: "github",
        repositoryId,
        requestedRef: ref,
        sha: resolved.sha,
        observedRef: null,
      };
    }
    const body = await githubJson(
      transport,
      input.installationId,
      input.credential,
      `/repos/${owner}/${name}/git/ref/heads/${githubRefPath(ref)}`,
      "REF_NOT_FOUND",
    );
    const object = jsonRecord(body.object);
    if (!object) {
      throw new RepositorySourceError("REMOTE_RESPONSE_INVALID", "GitHub ref object is missing");
    }
    const resolved = await commit(requiredObjectId(object, "sha"));
    return {
      provider: "github",
      repositoryId,
      requestedRef: ref,
      sha: resolved.sha,
      observedRef: ref,
    };
  };

  const tree = async (commitSha: string): Promise<GitHubTreeEntry[]> => {
    const resolved = await commit(commitSha);
    const body = await githubJson(
      transport,
      input.installationId,
      input.credential,
      `/repos/${owner}/${name}/git/trees/${resolved.treeSha}?recursive=1`,
    );
    return parseGitHubTree(body);
  };

  const blob = async (entry: GitHubTreeEntry): Promise<Buffer> => {
    const body = await githubJson(
      transport,
      input.installationId,
      input.credential,
      `/repos/${owner}/${name}/git/blobs/${entry.sha}`,
    );
    return decodeGitHubBlob(body, entry.size);
  };

  const assertSource = (ref: ResolvedRepositoryRef): void => {
    if (ref.provider !== "github" || ref.repositoryId !== repositoryId) {
      throw new RepositorySourceError(
        "SOURCE_MISMATCH",
        "Resolved ref belongs to a different repository source",
      );
    }
  };

  const assertNoDrift = async (ref: ResolvedRepositoryRef): Promise<void> => {
    if (ref.observedRef) {
      const current = await resolveRemoteRef(ref.observedRef);
      if (current.sha !== ref.sha) {
        throw new RepositorySourceError(
          "REF_DRIFT",
          `GitHub ref moved after resolution: ${ref.observedRef}`,
        );
      }
    }
  };

  const source: RepositorySource = {
    provider: "github",

    async probe() {
      const metadata = await authorize();
      const resolved = await resolveRemoteRef(metadata.defaultBranch);
      const entries = await tree(resolved.sha);
      let hasLfsPointers = false;
      for (const entry of entries) {
        if (entry.type !== "blob" || entry.size === null || entry.size > 512) continue;
        if (isLfsPointer(await blob(entry))) {
          hasLfsPointers = true;
          break;
        }
      }
      return {
        provider: "github",
        repositoryId,
        defaultBranch: metadata.defaultBranch,
        headSha: resolved.sha,
        dirty: false,
        hasSubmodules: entries.some((entry) => entry.mode === "160000"),
        hasLfsPointers,
      };
    },

    resolveRef: resolveRemoteRef,

    async materialize(ref, destination) {
      assertSource(ref);
      await authorize();
      await assertNoDrift(ref);
      const targetRoot = resolve(destination);
      const parent = await realpath(dirname(targetRoot)).catch((cause) => {
        throw new RepositorySourceError(
          "UNSAFE_DESTINATION",
          "Snapshot destination parent must already exist",
          cause,
        );
      });
      if (resolve(parent, basename(targetRoot)) !== targetRoot) {
        throw new RepositorySourceError("UNSAFE_DESTINATION", "Snapshot destination is ambiguous");
      }
      try {
        await lstat(targetRoot);
        throw new RepositorySourceError(
          "SNAPSHOT_TARGET_EXISTS",
          "Snapshot destination must not already exist",
        );
      } catch (cause) {
        if (cause instanceof RepositorySourceError) throw cause;
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }

      const entries = (await tree(ref.sha)).filter(
        (entry) =>
          entry.type !== "tree" &&
          (sparsePaths.length === 0 ||
            sparsePaths.some((path) => entry.path === path || entry.path.startsWith(`${path}/`))),
      );
      const files: SnapshotFile[] = [];
      const submodules: SnapshotSubmodule[] = [];
      const lfsPointers: string[] = [];
      const seenPortablePaths = new Set<string>();
      let totalBytes = 0;
      await mkdir(targetRoot);
      try {
        for (const entry of entries) {
          const portablePath = entry.path.toLowerCase();
          if (seenPortablePaths.has(portablePath)) {
            throw new RepositorySourceError(
              "UNSAFE_PATH",
              `Repository paths collide on a case-insensitive filesystem: ${entry.path}`,
            );
          }
          seenPortablePaths.add(portablePath);
          if (entry.mode === "160000" || entry.type === "commit") {
            if (entry.mode !== "160000" || entry.type !== "commit") {
              throw new RepositorySourceError(
                "REMOTE_RESPONSE_INVALID",
                `GitHub returned an invalid submodule entry at ${entry.path}`,
              );
            }
            if (!policy.allowSubmodules) {
              throw new RepositorySourceError(
                "SUBMODULE_UNSUPPORTED",
                `Repository contains submodule ${entry.path}; explicit policy is required`,
              );
            }
            submodules.push({ path: entry.path, sha: entry.sha });
            continue;
          }
          if (entry.type !== "blob") {
            throw new RepositorySourceError(
              "REMOTE_RESPONSE_INVALID",
              `GitHub returned unsupported tree object at ${entry.path}`,
            );
          }
          if (
            entry.size === null ||
            entry.size > maxFileBytes ||
            totalBytes + entry.size > maxSnapshotBytes
          ) {
            throw new RepositorySourceError(
              "SNAPSHOT_LIMIT_EXCEEDED",
              `Snapshot size policy exceeded at ${entry.path}`,
            );
          }
          const content = await blob(entry);
          totalBytes += content.length;
          const target = destinationFor(targetRoot, entry.path);
          await mkdir(dirname(target), { recursive: true });
          if (entry.mode === "120000") {
            const linkTarget = content.toString("utf8");
            validateSymlinkTarget(entry.path, linkTarget);
            if (!policy.allowSymlinks) {
              throw new RepositorySourceError(
                "SYMLINK_UNSUPPORTED",
                `Repository contains symlink ${entry.path}; explicit policy is required`,
              );
            }
            await symlink(linkTarget, target);
            files.push({
              path: entry.path,
              mode: entry.mode,
              kind: "symlink",
              size: content.length,
              sha256: sha256(content),
            });
            continue;
          }
          if (entry.mode !== "100644" && entry.mode !== "100755") {
            throw new RepositorySourceError(
              "REMOTE_RESPONSE_INVALID",
              `GitHub returned unsupported file mode at ${entry.path}`,
            );
          }
          if (isLfsPointer(content)) {
            if (!policy.allowLfsPointers) {
              throw new RepositorySourceError(
                "LFS_UNSUPPORTED",
                `Repository contains Git LFS pointer ${entry.path}; explicit policy is required`,
              );
            }
            lfsPointers.push(entry.path);
          }
          await writeFile(target, content, { mode: entry.mode === "100755" ? 0o755 : 0o644 });
          files.push({
            path: entry.path,
            mode: entry.mode,
            kind: "file",
            size: content.length,
            sha256: sha256(content),
          });
        }
        await assertNoDrift(ref);
        const snapshot: ImmutableRepositorySnapshot = {
          provider: "github",
          repositoryId,
          requestedRef: ref.requestedRef,
          sha: ref.sha,
          root: await realpath(targetRoot),
          manifestSha256: manifestDigest(files, submodules, sparsePaths),
          files: Object.freeze(files.map((file) => Object.freeze({ ...file }))),
          submodules: Object.freeze(submodules.map((item) => Object.freeze({ ...item }))),
          lfsPointers: Object.freeze([...lfsPointers]),
          sparsePaths: Object.freeze([...sparsePaths]),
        };
        await freezeSnapshot(targetRoot);
        return Object.freeze(snapshot);
      } catch (cause) {
        await chmod(targetRoot, 0o755).catch(() => undefined);
        await rm(targetRoot, { recursive: true, force: true });
        throw cause;
      }
    },

    async discover(snapshot) {
      return discoverImmutableSnapshot(snapshot, "github", repositoryId);
    },
  };
  return source;
}
