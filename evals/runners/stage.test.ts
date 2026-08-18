import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import {
  assertDirectDeterministicRepoSafe,
  isAnswerKeyFile,
  listFilesRecursive,
  stageRepo,
  withStagedRepo,
} from "./stage.js";
import { SCENARIOS } from "../scenarios/index.js";

/** Build a throwaway repo on disk and return its path + a cleanup. */
function makeRepo(files: Record<string, string>): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "stage-src-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("isAnswerKeyFile", () => {
  it("matches the grading-key filenames", () => {
    expect(isAnswerKeyFile("EXPECTED.md")).toBe(true);
    expect(isAnswerKeyFile("expected.md")).toBe(true);
    expect(isAnswerKeyFile("EXPECTED.fettler.md")).toBe(true);
    expect(isAnswerKeyFile("SYNTHETIC_REPO_NOTES.md")).toBe(true);
    expect(isAnswerKeyFile("some/dir/EXPECTED.md")).toBe(true);
    expect(isAnswerKeyFile("GROUND_TRUTH.json")).toBe(true);
    expect(isAnswerKeyFile("ANSWER_KEY.txt")).toBe(true);
  });

  it("does NOT match ordinary repository files", () => {
    expect(isAnswerKeyFile("README.md")).toBe(false);
    expect(isAnswerKeyFile("CHANGELOG.md")).toBe(false);
    expect(isAnswerKeyFile("docs/expectations.md")).toBe(false);
    expect(isAnswerKeyFile("src/index.ts")).toBe(false);
    expect(isAnswerKeyFile("notes.md")).toBe(false);
  });
});

describe("stageRepo (hermetic)", () => {
  it("allows a non-indexable Markdown key but rejects an indexable JSON key", () => {
    const safe = makeRepo({ "EXPECTED.md": "grading key", "src/a.ts": "export const x = 1;" });
    const unsafe = makeRepo({ "GROUND_TRUTH.json": "{}", "src/a.ts": "export const x = 1;" });
    try {
      expect(() => assertDirectDeterministicRepoSafe(safe.root)).not.toThrow();
      expect(() => assertDirectDeterministicRepoSafe(unsafe.root)).toThrow(
        "direct_repo_indexable_answer_key:GROUND_TRUTH.json",
      );
    } finally {
      safe.cleanup();
      unsafe.cleanup();
    }
  });

  it("always removes the staged tree when the product operation throws", async () => {
    const { root, cleanup } = makeRepo({
      "EXPECTED.md": "grading key",
      "src/a.ts": "export const x = 1;",
    });
    let stagedPath = "";
    try {
      await expect(
        withStagedRepo(root, async (staged) => {
          stagedPath = staged.stagedPath;
          expect(existsSync(stagedPath)).toBe(true);
          throw new Error("product_failed");
        }),
      ).rejects.toThrow("product_failed");
      expect(stagedPath).not.toBe("");
      expect(existsSync(stagedPath)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("excludes answer-key files but preserves ordinary content", () => {
    const { root, cleanup } = makeRepo({
      "EXPECTED.md": "# grading key — payment_method",
      "SYNTHETIC_REPO_NOTES.md": "# notes — the answer is src/a.ts",
      "nested/EXPECTED.md": "nested key",
      "README.md": "# real readme",
      "CHANGELOG.md": "# changes",
      "src/a.ts": "export const x = 1;",
      "node_modules/dep/index.js": "module.exports = {};",
      ".git/config": "[core]",
    });
    try {
      const staged = stageRepo(root);
      const files = listFilesRecursive(staged.stagedPath);

      // GATE 6: no answer-key file survives into the staged tree.
      expect(files.filter((f) => isAnswerKeyFile(f))).toEqual([]);

      // Ordinary content preserved.
      expect(files).toContain("README.md");
      expect(files).toContain("CHANGELOG.md");
      expect(files).toContain("src/a.ts");

      // Dependency/VCS trees pruned (never read by a product anyway).
      expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
      expect(files.some((f) => f.startsWith(".git/"))).toBe(false);

      // The excluded keys are recorded, not silently dropped.
      expect(staged.excludedAnswerKeys).toContain("EXPECTED.md");
      expect(staged.excludedAnswerKeys).toContain("SYNTHETIC_REPO_NOTES.md");
      expect(staged.excludedAnswerKeys).toContain("nested/EXPECTED.md");

      staged.cleanup();
      expect(existsSync(staged.stagedPath)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("keeps a holdout answer key — including its importChain — out of the staged tree", () => {
    // The task-family classifier reads blast_radius_truth.importChain to place a
    // scenario on the reference-vs-relationship axis. That chain is an ANSWER KEY:
    // if it reached the repo a product sees, a holdout scenario would leak the
    // very relationship the experiment is testing. Staging must strip it.
    const { root, cleanup } = makeRepo({
      "EXPECTED.md": "importChain: wrapper.ts -> core.ts -> sink.ts\nexpected: src/sink.ts",
      "SYNTHETIC_REPO_NOTES.md": "holdout: relationship-heavy; answer traverses the wrapper chain",
      "src/wrapper.ts": "export const w = 1;",
      "src/core.ts": "export const c = 1;",
      "src/sink.ts": "export const s = 1;",
    });
    try {
      const staged = stageRepo(root);
      const files = listFilesRecursive(staged.stagedPath);
      // No answer-key file survives, so the chain it encodes cannot be read on disk.
      expect(files.filter((f) => isAnswerKeyFile(f))).toEqual([]);
      // The ordinary source the chain traverses is preserved for the product.
      expect(files).toContain("src/wrapper.ts");
      expect(files).toContain("src/sink.ts");
      // The keys are recorded as excluded, not silently dropped.
      expect(staged.excludedAnswerKeys).toContain("EXPECTED.md");
      expect(staged.excludedAnswerKeys).toContain("SYNTHETIC_REPO_NOTES.md");
      staged.cleanup();
    } finally {
      cleanup();
    }
  });

  it("never mutates the source repo", () => {
    const { root, cleanup } = makeRepo({ "EXPECTED.md": "key", "src/a.ts": "x" });
    try {
      const staged = stageRepo(root);
      staged.cleanup();
      // Source key still present after staging + cleanup.
      expect(existsSync(join(root, "EXPECTED.md"))).toBe(true);
      expect(readFileSync(join(root, "EXPECTED.md"), "utf8")).toBe("key");
    } finally {
      cleanup();
    }
  });
});

describe("stageRepo (real corpus, when present)", () => {
  it(
    "strips the grading key from every corpus repo it can reach",
    () => {
      // Skip the huge-monorepo scale repo: staging its ~26k-file source tree is
      // the point of the scale scenario, not this guarantee, and copying it here
      // would dominate the test. Its leak guarantee is covered by the hermetic
      // test and by every other corpus repo below (all carry EXPECTED.md).
      const present = SCENARIOS.filter(
        (s) => existsSync(s.repoPath) && s.scenario_id !== "fettler-edge-huge-monorepo",
      );
      if (present.length === 0) {
        // Corpus lives outside the git repo; skip cleanly where it is absent.
        expect(true).toBe(true);
        return;
      }
      for (const cfg of present) {
        const staged = stageRepo(cfg.repoPath);
        try {
          const files = listFilesRecursive(staged.stagedPath);
          const leaked = files.filter((f) => isAnswerKeyFile(f));
          expect(leaked, `answer key leaked into staged ${cfg.scenario_id}`).toEqual([]);
        } finally {
          staged.cleanup();
        }
      }
    },
    60_000,
  );
});
