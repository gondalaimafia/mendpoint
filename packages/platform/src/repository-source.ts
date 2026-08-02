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
