import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalGitRepositorySource,
  validateRepositoryRelativePath,
} from "./repository-source.js";

const temporaryDirectories: string[] = [];

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mendpoint-repository-source-"));
  temporaryDirectories.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Mendpoint Test");
  git(root, "config", "user.email", "test@mendpoint.invalid");
  return root;
}

function commit(root: string, message = "fixture"): string {
  git(root, "add", "--all");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await chmod(directory, 0o755).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("local Git repository source", () => {
  it("resolves and materializes an exact immutable snapshot with repository constraints", async () => {
    const root = await repository();
    await mkdir(join(root, ".github", "workflows"), { recursive: true });
    await writeFile(join(root, ".github", "CODEOWNERS"), "* @platform\n");
    await writeFile(
      join(root, ".github", "workflows", "ci.yml"),
      "jobs:\n  test:\n    steps:\n      - run: npm run test\n",
    );
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }),
    );
    await writeFile(join(root, "service.ts"), "export const service = true;\n");
    const sha = commit(root);

    const source = await createLocalGitRepositorySource({ repositoryPath: root });
    await expect(source.probe()).resolves.toMatchObject({
      provider: "local-git",
      defaultBranch: "main",
      headSha: sha,
      dirty: false,
      hasSubmodules: false,
      hasLfsPointers: false,
    });
    const resolved = await source.resolveRef("main");
    expect(resolved).toMatchObject({ requestedRef: "main", sha, observedRef: "main" });

    const snapshot = await source.materialize(resolved, join(root, "..", `${root.split(/[\\/]/).pop()}-snapshot`));
    temporaryDirectories.push(snapshot.root);
    expect(snapshot.sha).toBe(sha);
    expect(snapshot.files.map((file) => file.path)).toEqual([
      ".github/CODEOWNERS",
      ".github/workflows/ci.yml",
      "package.json",
      "service.ts",
    ]);
    await expect(readFile(join(snapshot.root, "service.ts"), "utf8")).resolves.toBe(
      "export const service = true;\n",
    );

    const discovery = await source.discover(snapshot);
    expect(discovery.codeowners).toEqual([
      { path: ".github/CODEOWNERS", content: "* @platform\n" },
    ]);
    expect(discovery.ci).toEqual([
      { path: ".github/workflows/ci.yml", provider: "github_actions" },
    ]);
    expect(discovery.verificationCommands).toEqual(
      expect.arrayContaining([
        { command: "npm run test", source: "package.json", kind: "test" },
        { command: "npm run typecheck", source: "package.json", kind: "typecheck" },
      ]),
    );

    const sparse = await createLocalGitRepositorySource({
      repositoryPath: root,
      policy: { sparsePaths: ["service.ts"] },
    });
    const sparseSnapshot = await sparse.materialize(
      await sparse.resolveRef(sha),
      join(root, "..", `${root.split(/[\\/]/).pop()}-sparse-snapshot`),
    );
    temporaryDirectories.push(sparseSnapshot.root);
    expect(sparseSnapshot.files.map((file) => file.path)).toEqual(["service.ts"]);
    expect(sparseSnapshot.sparsePaths).toEqual(["service.ts"]);
    expect(sparseSnapshot.manifestSha256).not.toBe(snapshot.manifestSha256);
  });

  it("rejects dirty worktree ambiguity unless explicitly allowed", async () => {
    const root = await repository();
    await writeFile(join(root, "tracked.txt"), "committed\n");
    commit(root);
    await writeFile(join(root, "tracked.txt"), "dirty\n");

    const strict = await createLocalGitRepositorySource({ repositoryPath: root });
    await expect(strict.resolveRef("HEAD")).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });

    const explicit = await createLocalGitRepositorySource({
      repositoryPath: root,
      policy: { allowDirtyWorktree: true },
    });
    const resolved = await explicit.resolveRef("HEAD");
    const destination = join(root, "..", `${root.split(/[\\/]/).pop()}-dirty-snapshot`);
    const snapshot = await explicit.materialize(resolved, destination);
    temporaryDirectories.push(snapshot.root);
    await expect(readFile(join(snapshot.root, "tracked.txt"), "utf8")).resolves.toBe("committed\n");
  });

  it("rejects a branch that moves after resolution", async () => {
    const root = await repository();
    await writeFile(join(root, "version.txt"), "one\n");
    commit(root, "one");
    const source = await createLocalGitRepositorySource({ repositoryPath: root });
    const resolved = await source.resolveRef("main");

    await writeFile(join(root, "version.txt"), "two\n");
    commit(root, "two");

    await expect(
      source.materialize(
        resolved,
        join(root, "..", `${root.split(/[\\/]/).pop()}-drift-snapshot`),
      ),
    ).rejects.toMatchObject({ code: "REF_DRIFT" });
  });

  it("rejects Git LFS pointers unless policy explicitly allows pointer materialization", async () => {
    const root = await repository();
    const pointer = [
      "version https://git-lfs.github.com/spec/v1",
      `oid sha256:${"a".repeat(64)}`,
      "size 42",
      "",
    ].join("\n");
    await writeFile(join(root, "model.bin"), pointer);
    commit(root);

    const strict = await createLocalGitRepositorySource({ repositoryPath: root });
    const strictRef = await strict.resolveRef("HEAD");
    await expect(
      strict.materialize(
        strictRef,
        join(root, "..", `${root.split(/[\\/]/).pop()}-lfs-strict`),
      ),
    ).rejects.toMatchObject({ code: "LFS_UNSUPPORTED" });

    const explicit = await createLocalGitRepositorySource({
      repositoryPath: root,
      policy: { allowLfsPointers: true },
    });
    const snapshot = await explicit.materialize(
      await explicit.resolveRef("HEAD"),
      join(root, "..", `${root.split(/[\\/]/).pop()}-lfs-allowed`),
    );
    temporaryDirectories.push(snapshot.root);
    expect(snapshot.lfsPointers).toEqual(["model.bin"]);
  });

  it("rejects submodules unless policy explicitly allows immutable gitlink metadata", async () => {
    const root = await repository();
    await writeFile(join(root, "README.md"), "root\n");
    commit(root);
    git(
      root,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${"1".repeat(40)},vendor/library`,
    );
    git(root, "commit", "-m", "add gitlink");

    const strict = await createLocalGitRepositorySource({
      repositoryPath: root,
      policy: { allowDirtyWorktree: true },
    });
    await expect(
      strict.materialize(
        await strict.resolveRef("HEAD"),
        join(root, "..", `${root.split(/[\\/]/).pop()}-submodule-strict`),
      ),
    ).rejects.toMatchObject({ code: "SUBMODULE_UNSUPPORTED" });

    const explicit = await createLocalGitRepositorySource({
      repositoryPath: root,
      policy: { allowDirtyWorktree: true, allowSubmodules: true },
    });
    const snapshot = await explicit.materialize(
      await explicit.resolveRef("HEAD"),
      join(root, "..", `${root.split(/[\\/]/).pop()}-submodule-allowed`),
    );
    temporaryDirectories.push(snapshot.root);
    expect(snapshot.submodules).toEqual([
      { path: "vendor/library", sha: "1".repeat(40) },
    ]);
  });

  it("rejects traversal and symlinks that escape the snapshot", async () => {
    expect(() => validateRepositoryRelativePath("../outside")).toThrowError(
      expect.objectContaining({ code: "UNSAFE_PATH" }),
    );
    expect(() => validateRepositoryRelativePath("safe/../../outside")).toThrowError(
      expect.objectContaining({ code: "UNSAFE_PATH" }),
    );
    expect(() => validateRepositoryRelativePath("safe\\..\\outside")).toThrowError(
      expect.objectContaining({ code: "UNSAFE_PATH" }),
    );
    expect(() => validateRepositoryRelativePath("safe\nfile")).toThrowError(
      expect.objectContaining({ code: "UNSAFE_PATH" }),
    );

    const root = await repository();
    await writeFile(join(root, "escape"), "../../outside");
    git(root, "add", "escape");
    const blob = git(root, "rev-parse", ":escape");
    git(root, "update-index", "--cacheinfo", `120000,${blob},escape`);
    git(root, "commit", "-m", "add unsafe symlink");
    const source = await createLocalGitRepositorySource({
      repositoryPath: root,
      policy: { allowSymlinks: true },
    });
    await expect(
      source.materialize(
        await source.resolveRef("HEAD"),
        join(root, "..", `${root.split(/[\\/]/).pop()}-symlink-snapshot`),
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });

  it("detects snapshot mutation before returning discovered constraints", async () => {
    const root = await repository();
    await writeFile(join(root, "CODEOWNERS"), "* @original\n");
    commit(root);
    const source = await createLocalGitRepositorySource({ repositoryPath: root });
    const snapshot = await source.materialize(
      await source.resolveRef("HEAD"),
      join(root, "..", `${root.split(/[\\/]/).pop()}-mutation-snapshot`),
    );
    temporaryDirectories.push(snapshot.root);
    const codeowners = join(snapshot.root, "CODEOWNERS");
    await chmod(codeowners, 0o644);
    await writeFile(codeowners, "* @attacker\n");

    await expect(source.discover(snapshot)).rejects.toMatchObject({ code: "SNAPSHOT_MUTATED" });
  });
});
