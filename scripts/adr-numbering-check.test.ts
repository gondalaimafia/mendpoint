import { describe, expect, it } from "vitest";
import {
  LAST_SEQUENTIAL_ADR,
  classifyAdrFile,
  scanAdrDirectory,
  scanAdrFiles,
  type AdrEntry,
} from "./adr-numbering-check.js";

const reasonsOf = (files: readonly string[]): string[] =>
  scanAdrFiles(files).violations.map((violation) => `${violation.file}: ${violation.reason}`);

describe("ADR numbering — dated scheme (new ADRs)", () => {
  it("accepts a well-formed dated ADR", () => {
    const result = classifyAdrFile("2026-08-22-change-graph-authority.md");
    expect(result).toEqual<AdrEntry>({
      file: "2026-08-22-change-graph-authority.md",
      scheme: "dated",
      identifier: "2026-08-22-change-graph-authority",
    });
  });

  it("rejects an impossible calendar date", () => {
    const result = classifyAdrFile("2026-13-02-bad-month.md");
    expect(result).toMatchObject({ reason: expect.stringContaining("invalid calendar date") });
  });

  it("rejects a non-existent day", () => {
    const result = classifyAdrFile("2026-02-30-bad-day.md");
    expect(result).toMatchObject({ reason: expect.stringContaining("invalid calendar date") });
  });

  it("two dated ADRs authored the same day about different decisions do not collide", () => {
    expect(
      reasonsOf(["2026-08-22-first-decision.md", "2026-08-22-second-decision.md"]),
    ).toEqual([]);
  });
});

describe("ADR numbering — sequential range is closed", () => {
  it("tolerates a grandfathered sequential ADR", () => {
    expect(classifyAdrFile("0009-mission-context-compiler.md")).toEqual<AdrEntry>({
      file: "0009-mission-context-compiler.md",
      scheme: "sequential",
      identifier: "0009",
    });
  });

  it("tolerates the template at 0000", () => {
    expect(classifyAdrFile("0000-template.md")).toMatchObject({ scheme: "sequential" });
  });

  it("tolerates the boundary number itself", () => {
    expect(
      classifyAdrFile(`${String(LAST_SEQUENTIAL_ADR).padStart(4, "0")}-boundary.md`),
    ).toMatchObject({ scheme: "sequential" });
  });

  it("rejects a new sequential number above the boundary — this is the closed race", () => {
    const next = String(LAST_SEQUENTIAL_ADR + 1).padStart(4, "0");
    expect(classifyAdrFile(`${next}-new-decision.md`)).toMatchObject({
      reason: expect.stringContaining("extends the closed range"),
    });
  });
});

describe("ADR numbering — duplicate identifiers", () => {
  it("flags two sequential ADRs that claim one number (the historical 0009 collision)", () => {
    const reasons = reasonsOf(["0009-first-author.md", "0009-second-author.md"]);
    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain('identifier "0009" is claimed by 2 ADRs');
  });

  it("does not flag distinct sequential numbers", () => {
    expect(reasonsOf(["0001-a.md", "0002-b.md", "0003-c.md"])).toEqual([]);
  });
});

describe("ADR numbering — malformed names", () => {
  it("rejects a name that is neither dated nor sequential", () => {
    expect(classifyAdrFile("draft-notes.md")).toMatchObject({
      reason: expect.stringContaining("neither the dated scheme"),
    });
  });

  it("ignores README.md as a non-ADR file", () => {
    expect(reasonsOf(["README.md", "0001-real.md"])).toEqual([]);
  });
});

describe("ADR numbering — current tree", () => {
  it("passes cleanly on the repository with no suppression list", () => {
    const { violations } = scanAdrDirectory();
    expect(violations).toEqual([]);
  });
});
