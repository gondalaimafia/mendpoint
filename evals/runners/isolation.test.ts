import { describe, it, expect } from "vitest";
import { assertCorpusIsolation, CorpusIsolationError, isInside } from "./isolation.js";

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
