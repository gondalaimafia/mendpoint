import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  adrResolves,
  analyzeRepository,
  FAIL_AFTER_DAYS,
  gradeAge,
  isConventionalRevert,
  isDeletionDominant,
  isReland,
  markerResolves,
  MIN_DELETIONS,
  parseObligationMarkers,
  parseRevertedRef,
  WARN_AFTER_DAYS,
  type CommitMeta,
} from "./revert-obligation-check.js";

describe("revert-obligation — detection shapes", () => {
  it("detects a conventional Revert subject", () => {
    expect(isConventionalRevert('Revert "Add widget (#88)" (#91)', "")).toBe(true);
  });

  it("detects a `This reverts commit` body when the subject hides it", () => {
    // 6a7b2f6's real shape: the subject is a restore-to-known-good, not `^Revert`.
    expect(isConventionalRevert("Restore last known healthy production source (#93)", "")).toBe(false);
    expect(
      isConventionalRevert("Restore last known healthy production source", "This reverts commit 2abe3ff0000000"),
    ).toBe(true);
  });

  it("treats a deletion-dominant commit as the batched-restore shape", () => {
    // 6a7b2f6: -7670/+42; the ADR removals: -3487/+192 and -1471/+172.
    expect(isDeletionDominant(42, 7670)).toBe(true);
    expect(isDeletionDominant(192, 3487)).toBe(true);
    expect(isDeletionDominant(172, 1471)).toBe(true);
  });

  it("does not treat feature or refactor commits as reverts", () => {
    expect(isDeletionDominant(6758, 4704)).toBe(false); // adds more than it removes
    expect(isDeletionDominant(564, 593)).toBe(false); // roughly balanced rename
    expect(isDeletionDominant(24, 493)).toBe(false); // below the deletion floor
    expect(isDeletionDominant(0, MIN_DELETIONS - 1)).toBe(false);
  });
});

describe("revert-obligation — resolution primitives", () => {
  it("parses the reverted work's title and PR from a conventional subject", () => {
    expect(parseRevertedRef('Revert "Preserve Warden checkpoint evidence (#88)" (#91)')).toEqual({
      title: "Preserve Warden checkpoint evidence",
      pr: "88",
    });
  });

  it("sees a re-land when a later non-revert commit reintroduces the reverted PR", () => {
    const later: CommitMeta[] = [
      { sha: "aaa", isoDate: "2026-08-14T00:00:00Z", subject: "Preserve Warden checkpoint evidence (#88) (#94)", body: "" },
    ];
    expect(isReland({ title: "Preserve Warden checkpoint evidence", pr: "88" }, later)).toBe(true);
  });

  it("does not count another revert as a re-land", () => {
    const later: CommitMeta[] = [
      { sha: "bbb", isoDate: "2026-08-14T00:00:00Z", subject: 'Revert "Preserve Warden checkpoint evidence (#88)" (#95)', body: "" },
    ];
    expect(isReland({ title: "Preserve Warden checkpoint evidence", pr: "88" }, later)).toBe(false);
  });

  it("parses recorded-decision markers, including inside an HTML comment", () => {
    expect(parseObligationMarkers("revert-obligation: 6a7b2f6 superseded by scope correction")).toEqual([
      { sha: "6a7b2f6", reason: "superseded by scope correction" },
    ]);
    expect(parseObligationMarkers("<!-- revert-obligation: deadbeef gone for good -->")).toEqual([
      { sha: "deadbeef", reason: "gone for good" },
    ]);
  });

  it("requires a non-empty reason and a matching sha prefix", () => {
    const markers = [{ sha: "6a7b2f6", reason: "superseded" }];
    expect(markerResolves("6a7b2f67fa72c59d79c44da4dd5a75e31d6c882f", markers)).toBe(true);
    expect(markerResolves("0000000deadbeef", markers)).toBe(false);
    expect(markerResolves("6a7b2f67fa", [{ sha: "6a7b2f6", reason: "" }])).toBe(false);
  });

  it("resolves via an ADR that names a distinctive removed file, not a generic one", () => {
    const adr = "We will delete `packages/platform/src/router-runtime.test.ts` and drop the barrel.";
    expect(adrResolves(["packages/platform/src/router-runtime.test.ts"], [adr])).toBe(true);
    // package.json alone must not resolve — every removal touches one.
    expect(adrResolves(["packages/foo/package.json"], ["Delete packages/foo/package.json"])).toBe(false);
  });

  it("grades age against the two-week grace window", () => {
    expect(gradeAge(WARN_AFTER_DAYS - 1)).toBe("within-grace");
    expect(gradeAge(WARN_AFTER_DAYS)).toBe("warn");
    expect(gradeAge(FAIL_AFTER_DAYS)).toBe("fail");
  });
});

// --- Integration: run the real analysis over throwaway git repositories. ---

const RUN_ID = `${process.pid}-${Date.now()}`;
const tempRoots: string[] = [];

function makeRepo(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `revert-${name}-`));
  tempRoots.push(root);
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  run(["init", "-q"]);
  run(["config", "user.email", "fixture@example.com"]);
  run(["config", "user.name", "Fixture"]);
  run(["config", "commit.gpgsign", "false"]);
  return root;
}

function writeFile(root: string, relative: string, content: string): void {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function commit(
  root: string,
  options: { message: string; date: string; add?: string[]; remove?: string[] },
): string {
  const env = { GIT_AUTHOR_DATE: options.date, GIT_COMMITTER_DATE: options.date };
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env } });
  for (const path of options.add ?? []) run(["add", "--", path]);
  for (const path of options.remove ?? []) run(["rm", "-q", "--", path]);
  run(["commit", "-q", "--no-gpg-sign", "-m", options.message]);
  return run(["rev-parse", "HEAD"]).trim();
}

const bigFile = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => `line ${i} of removed capability`).join("\n") + "\n";

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe("revert-obligation — analysis over real repositories", () => {
  const now = new Date("2026-09-30T00:00:00Z");

  it("FAILS on a deletion-dominant revert left unresolved past the grace period", () => {
    const root = makeRepo(`unresolved-${RUN_ID}`);
    writeFile(root, "src/feature.ts", bigFile(600));
    commit(root, { message: "Add feature", date: "2026-08-01T00:00:00Z", add: ["src/feature.ts"] });
    commit(root, {
      message: "Restore last known healthy production source",
      date: "2026-08-01T00:10:00Z", // ~60 days before `now`, well past FAIL_AFTER_DAYS
      remove: ["src/feature.ts"],
    });

    const analysis = analyzeRepository({ root, now });
    expect(analysis.status).toBe("fail");
    const open = analysis.obligations.find((o) => o.grade === "fail");
    expect(open?.shape).toBe("deletion-dominant");
    expect(open?.detail).toContain("re-land");
  });

  it("does not block a fresh revert still inside the grace window", () => {
    const root = makeRepo(`fresh-${RUN_ID}`);
    writeFile(root, "src/feature.ts", bigFile(600));
    commit(root, { message: "Add feature", date: "2026-09-27T00:00:00Z", add: ["src/feature.ts"] });
    commit(root, {
      message: "Restore last known healthy production source",
      date: "2026-09-28T00:00:00Z", // 2 days before `now`
      remove: ["src/feature.ts"],
    });

    const analysis = analyzeRepository({ root, now });
    expect(analysis.status).toBe("pass");
    expect(analysis.obligations.some((o) => o.grade === "within-grace")).toBe(true);
  });

  it("PASSES when the reverted work was re-landed", () => {
    const root = makeRepo(`reland-${RUN_ID}`);
    writeFile(root, "src/widget.ts", "export const widget = true;\n");
    commit(root, { message: "Add widget (#5)", date: "2026-08-01T00:00:00Z", add: ["src/widget.ts"] });
    writeFile(root, "src/widget.ts", "");
    commit(root, {
      message: 'Revert "Add widget (#5)" (#6)',
      date: "2026-08-01T00:10:00Z",
      add: ["src/widget.ts"],
    });
    writeFile(root, "src/widget.ts", "export const widget = true;\n");
    commit(root, { message: "Add widget (#5) (#9)", date: "2026-08-02T00:00:00Z", add: ["src/widget.ts"] });

    const analysis = analyzeRepository({ root, now });
    expect(analysis.status).toBe("pass");
    const revert = analysis.obligations.find((o) => o.shape === "conventional");
    expect(revert?.disposition).toBe("reland");
  });

  it("PASSES when an Accepted ADR records the removal decision", () => {
    const root = makeRepo(`adr-${RUN_ID}`);
    writeFile(root, "packages/dead/src/runtime.ts", bigFile(600));
    commit(root, {
      message: "Add dead runtime",
      date: "2026-08-01T00:00:00Z",
      add: ["packages/dead/src/runtime.ts"],
    });
    writeFile(
      root,
      "docs/adr/0001-remove-dead-runtime.md",
      "# ADR-0001: Remove the dead runtime\n\n- **Status:** Accepted\n\n" +
        "We will delete `packages/dead/src/runtime.ts`, which nothing calls.\n",
    );
    commit(root, {
      message: "Remove the dead runtime nothing calls",
      date: "2026-08-01T00:10:00Z",
      add: ["docs/adr/0001-remove-dead-runtime.md"],
      remove: ["packages/dead/src/runtime.ts"],
    });

    const analysis = analyzeRepository({ root, now });
    expect(analysis.status).toBe("pass");
    expect(analysis.obligations.some((o) => o.disposition === "adr")).toBe(true);
  });

  it("PASSES when a recorded-decision marker names the reverting commit", () => {
    const root = makeRepo(`recorded-${RUN_ID}`);
    writeFile(root, "src/slice.ts", bigFile(600));
    commit(root, { message: "Add slice", date: "2026-08-01T00:00:00Z", add: ["src/slice.ts"] });
    const revertSha = commit(root, {
      message: "Restore last known healthy production source",
      date: "2026-08-01T00:10:00Z",
      remove: ["src/slice.ts"],
    });
    writeFile(
      root,
      "docs/revert-ledger.md",
      `revert-obligation: ${revertSha.slice(0, 7)} superseded by the scope correction; not restoring\n`,
    );
    commit(root, {
      message: "Record revert decision",
      date: "2026-08-02T00:00:00Z",
      add: ["docs/revert-ledger.md"],
    });

    const analysis = analyzeRepository({ root, now });
    expect(analysis.status).toBe("pass");
    expect(analysis.obligations.some((o) => o.disposition === "recorded")).toBe(true);
  });

  it("fails closed as could-not-determine on a shallow clone", () => {
    const source = makeRepo(`shallow-src-${RUN_ID}`);
    writeFile(source, "a.txt", "one\n");
    commit(source, { message: "one", date: "2026-08-01T00:00:00Z", add: ["a.txt"] });
    writeFile(source, "b.txt", "two\n");
    commit(source, { message: "two", date: "2026-08-02T00:00:00Z", add: ["b.txt"] });

    const shallow = mkdtempSync(join(tmpdir(), `revert-shallow-${RUN_ID}-`));
    tempRoots.push(shallow);
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${source.split("\\").join("/")}`, "."], {
      cwd: shallow,
      encoding: "utf8",
    });

    const analysis = analyzeRepository({ root: shallow, now });
    expect(analysis.status).toBe("undetermined");
    expect(analysis.reason).toContain("shallow");
  });
});

describe("revert-obligation — current tree", () => {
  it("passes on this repository with every revert discharged", () => {
    const root = resolve(import.meta.dirname, "..");
    const analysis = analyzeRepository({ root });
    const undischarged = analysis.obligations.filter(
      (o) => o.grade === "fail" || o.grade === "warn",
    );
    expect(undischarged).toEqual([]);
    expect(analysis.status).toBe("pass");
  }, 120_000);

  it("recognises 6a7b2f6 as a resolved revert, not a false alarm", () => {
    const root = resolve(import.meta.dirname, "..");
    const analysis = analyzeRepository({ root });
    const known = analysis.obligations.find((o) => o.sha.startsWith("6a7b2f6"));
    expect(known).toBeDefined();
    expect(known?.disposition).not.toBe("unresolved");
    expect(known?.grade).toBe("resolved");
  }, 120_000);
});
