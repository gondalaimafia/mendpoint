/**
 * Offline tests for the real-repository harness.
 *
 * These never clone and never touch the network: they exercise the harness
 * plumbing (answer-key loading, injection integrity, isolation, grading, and —
 * most importantly — the ran / found-nothing / did-not-run discriminator)
 * against the committed spec pair and tiny in-tmp fixtures. The live end-to-end
 * evidence run is `tsx evals/real-repo/run.ts`, kept out of CI so an absent
 * clone never turns a network failure into a false result.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSealedAnswerKey,
  loadInjectedSurfaces,
  assertInjectionMatchesKey,
  assertAnswerKeyUnreachable,
  type SealedAnswerKey,
} from "./inject.js";
import { runRealRepoOnPreparedRepository } from "./harness.js";
import { OPENAI_QUICKSTART, REPO_ROOT } from "./manifest.js";

const CTX = { gitCommit: "test", productVersion: "test" };

const tmpDirs: string[] = [];
function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "realrepo-harness-test-"));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return root;
}
afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe("sealed answer key", () => {
  it("loads and validates, with the injection provenance recorded", () => {
    const key = loadSealedAnswerKey(OPENAI_QUICKSTART);
    expect(key.scenario_id).toBe(OPENAI_QUICKSTART.scenarioId);
    expect(key.correct_behavior).toBe("flag_files");
    expect(key.expected_findings).toHaveLength(5);
    expect(key.false_positive_traps).toHaveLength(9);
    expect(key.injected_change.kind).toBe("endpoint_removed");
    expect(key.injected_change.path).toBe("/v1/chat/completions");
    expect(key.impacted_call_sites).toHaveLength(5);
    // Expected findings and traps must be disjoint.
    const overlap = key.expected_findings.filter((f) =>
      key.false_positive_traps.includes(f),
    );
    expect(overlap).toEqual([]);
  });
});

describe("injection integrity", () => {
  it("the spec pair encodes a breaking removal of the declared endpoint plus its successor", () => {
    const key = loadSealedAnswerKey(OPENAI_QUICKSTART);
    const surfaces = assertInjectionMatchesKey(OPENAI_QUICKSTART, key);
    const removed = surfaces.find(
      (s) => s.op === "path_removed" && s.path === "/v1/chat/completions",
    );
    expect(removed).toBeDefined();
    expect(removed!.severity).toBe("breaking");
    expect(
      surfaces.some((s) => s.op === "path_added" && s.path === "/v1/responses"),
    ).toBe(true);
    // No field-level surface should touch the untouched sibling endpoints.
    const fieldOps = surfaces.filter((s) => s.op.includes("field"));
    expect(fieldOps).toEqual([]);
  });
});

describe("answer-key isolation", () => {
  it("rejects a repo-under-test that contains the sealed key", () => {
    // The sealed key lives inside REPO_ROOT, so REPO_ROOT as the repo-under-test
    // would let a staged product read its own answer key.
    expect(() => assertAnswerKeyUnreachable(OPENAI_QUICKSTART, REPO_ROOT)).toThrow(
      /isolation violated/,
    );
  });
  it("accepts a repo-under-test outside the key's tree", () => {
    const outside = makeRepo({ "x.js": "// nothing" });
    expect(() =>
      assertAnswerKeyUnreachable(OPENAI_QUICKSTART, outside),
    ).not.toThrow();
  });
});

describe("grading against a prepared repository", () => {
  it("scores a true positive without flagging a same-provider distractor", async () => {
    const repo = makeRepo({
      "a/chat.js":
        'import OpenAI from "openai";\nasync function run(){\n  const openai = new OpenAI();\n  await openai.chat.completions.create({ model: "x", messages: [] });\n}\nrun();\n',
      "b/embed.js":
        'import OpenAI from "openai";\nasync function run(){\n  const openai = new OpenAI();\n  await openai.embeddings.create({ model: "x", input: "y" });\n}\nrun();\n',
    });
    const { surfaces } = loadInjectedSurfaces(OPENAI_QUICKSTART);
    const key: SealedAnswerKey = {
      ...loadSealedAnswerKey(OPENAI_QUICKSTART),
      expected_findings: ["a/chat.js"],
      acceptable_findings: [],
      false_positive_traps: ["b/embed.js"],
    };
    const result = await runRealRepoOnPreparedRepository(
      repo,
      OPENAI_QUICKSTART,
      key,
      surfaces,
      CTX,
    );
    expect(result.outcome).not.toBe("did_not_run");
    expect(result.truePositives).toEqual(["a/chat.js"]);
    expect(result.trapHits).toEqual([]);
    expect(result.falseNegatives).toEqual([]);
  });

  it("distinguishes did_not_run (empty index) from a clean miss", async () => {
    const empty = makeRepo({ "notes.txt": "no source here" });
    const { surfaces } = loadInjectedSurfaces(OPENAI_QUICKSTART);
    const key = loadSealedAnswerKey(OPENAI_QUICKSTART);
    const result = await runRealRepoOnPreparedRepository(
      empty,
      OPENAI_QUICKSTART,
      key,
      surfaces,
      CTX,
    );
    expect(result.outcome).toBe("did_not_run");
    // A did-not-run records every expected file as a miss, never as "clean".
    expect(result.falseNegatives.sort()).toEqual(
      key.expected_findings.slice().sort(),
    );
    expect(result.passed).toBe(false);
  });
});
