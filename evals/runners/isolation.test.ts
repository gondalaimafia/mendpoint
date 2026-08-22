import { describe, it, expect } from "vitest";
import {
  assertCorpusIsolation,
  assertCorpusRunIsolation,
  CorpusIsolationError,
  isInside,
} from "./isolation.js";

describe("isInside", () => {
  it("is true for identical paths", () => {
    expect(isInside("/repo", "/repo")).toBe(true);
  });
  it("is true for a nested child", () => {
    expect(isInside("/repo", "/repo/evals/corpus")).toBe(true);
  });
  it("is false for a sibling outside the parent", () => {
    expect(isInside("/repo", "/corpus")).toBe(false);
    expect(isInside("/home/x/repo", "/home/x/corpus")).toBe(false);
  });
  it("is false for a parent of the repo", () => {
    expect(isInside("/repo/inner", "/repo")).toBe(false);
  });
});

describe("assertCorpusIsolation", () => {
  it("passes when the corpus resolves outside the repo", () => {
    expect(() => assertCorpusIsolation("/home/dev", "/home/dev/mendpoint")).not.toThrow();
  });

  it("throws when the corpus resolves inside the repo (answer-key leak)", () => {
    expect(() => assertCorpusIsolation("/home/dev/mendpoint/evals/corpus", "/home/dev/mendpoint")).toThrow(
      CorpusIsolationError,
    );
  });

  it("throws when the corpus IS the repo root", () => {
    expect(() => assertCorpusIsolation("/home/dev/mendpoint", "/home/dev/mendpoint")).toThrow(
      CorpusIsolationError,
    );
  });
});

describe("assertCorpusRunIsolation", () => {
  const repoRoot = "/home/dev/mendpoint";
  const externalCorpus = ["/home/dev/synthetic-payments-svc", "/home/dev/synthetic-corpus/go"];
  const alwaysExists = () => true;
  const neverExists = () => false;

  it("fires on a genuinely contaminated corpus (a scenario repo committed inside the tree)", () => {
    // The control: a corpus repo that actually resolves inside the repo root and
    // exists on disk MUST fail — a staged product could read evals/ground-truth.
    expect(() =>
      assertCorpusRunIsolation({
        corpusRoot: repoRoot,
        configured: false,
        corpusRepoPaths: ["/home/dev/mendpoint/evals/corpus/payments"],
        repoRoot,
        exists: alwaysExists,
      }),
    ).toThrow(CorpusIsolationError);
  });

  it("does NOT fire on a runner with no corpus present (the nightly benign case)", () => {
    // Empty/unset MENDPOINT_CORPUS_ROOT collapses CORPUS_ROOT onto the repo root,
    // but nothing is staged, so there is nothing to leak — degrade cleanly.
    expect(() =>
      assertCorpusRunIsolation({
        corpusRoot: repoRoot,
        configured: false,
        corpusRepoPaths: ["/home/dev/mendpoint/synthetic-payments-svc"],
        repoRoot,
        exists: neverExists,
      }),
    ).not.toThrow();
  });

  it("passes when external corpus repos exist outside the tree", () => {
    expect(() =>
      assertCorpusRunIsolation({
        corpusRoot: "/home/dev",
        configured: true,
        corpusRepoPaths: externalCorpus,
        repoRoot,
        exists: alwaysExists,
      }),
    ).not.toThrow();
  });

  it("fires when an explicitly configured corpus root resolves inside the tree, even before dirs materialize", () => {
    expect(() =>
      assertCorpusRunIsolation({
        corpusRoot: "/home/dev/mendpoint/evals",
        configured: true,
        corpusRepoPaths: [],
        repoRoot,
        exists: neverExists,
      }),
    ).toThrow(CorpusIsolationError);
  });
});
