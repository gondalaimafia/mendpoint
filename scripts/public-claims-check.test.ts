import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { PublicClaimIssue, PublicClaimRegistry } from "@mendpoint/contract";
import { detectStaleClaims } from "../packages/contract/src/public-claims.js";
import type { ProductRequirementManifest } from "../packages/contract/src/product-requirements.js";
import {
  applyEvidenceHolds,
  collectPublicClaimIssues,
  compareSurfaces,
  revisionReachabilityIssues,
  type PublicClaimEvidenceHold,
} from "./public-claims-check.js";

const REACHABLE = "a".repeat(40);
const UNREACHABLE = "b".repeat(40);

function registryWith(
  evidence: Array<Record<string, unknown>>,
): PublicClaimRegistry {
  return {
    claims: [{ id: "CLM-001", evidence }],
  } as unknown as PublicClaimRegistry;
}

describe("live evidence revision reachability", () => {
  it("flags a live revision that is not a commit in the repository", () => {
    const issues = revisionReachabilityIssues(
      registryWith([
        { id: "CLM-001-EV01", type: "live", locator: "https://x/livez", revision: UNREACHABLE },
      ]),
      (revision) => revision === REACHABLE,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("LIVE_EVIDENCE_REVISION_UNREACHABLE");
    expect(issues[0].subject).toBe("CLM-001-EV01");
    expect(issues[0].message).toContain(UNREACHABLE);
  });

  it("accepts a live revision that resolves to a commit", () => {
    const issues = revisionReachabilityIssues(
      registryWith([
        { id: "CLM-001-EV01", type: "live", locator: "https://x/livez", revision: REACHABLE },
      ]),
      (revision) => revision === REACHABLE,
    );
    expect(issues).toEqual([]);
  });

  it("ignores non-live evidence", () => {
    const issues = revisionReachabilityIssues(
      registryWith([
        { id: "CLM-001-EV01", type: "test", locator: "packages/contract/src/public-claims.test.ts" },
      ]),
      () => false,
    );
    expect(issues).toEqual([]);
  });

  it("leaves malformed revisions to the contract validator", () => {
    let probed = false;
    const issues = revisionReachabilityIssues(
      registryWith([
        { id: "CLM-001-EV01", type: "live", locator: "https://x/livez", revision: "not-a-sha" },
      ]),
      () => {
        probed = true;
        return true;
      },
    );
    expect(issues).toEqual([]);
    expect(probed).toBe(false);
  });

  it("passes on the published registry (every live revision is a real commit)", () => {
    const repoRoot = resolve(import.meta.dirname, "..");
    const registry = JSON.parse(
      readFileSync(resolve(repoRoot, "docs/PUBLIC_CLAIMS.json"), "utf8"),
    ) as PublicClaimRegistry;
    const issues = revisionReachabilityIssues(registry, (revision) => {
      try {
        execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
          cwd: repoRoot,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    });
    expect(issues).toEqual([]);
  });
});

// These suites build real temporary Git repositories rather than stubbing
// compareSurfaces, so the staleness mechanism is exercised end-to-end: its Git
// I/O, its NUL-delimited diff reading, and its wiring into the gate all run.
const GIT_TEST_TIMEOUT = 60_000;
const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Best-effort cleanup; Windows can briefly hold Git pack handles.
    }
  }
});

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initRepo(prefix = "public-claims-check-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  gitIn(root, ["init", "-q"]);
  gitIn(root, ["config", "user.email", "check@example.test"]);
  gitIn(root, ["config", "user.name", "Public Claims Check"]);
  gitIn(root, ["config", "commit.gpgsign", "false"]);
  gitIn(root, ["config", "core.autocrlf", "false"]);
  return root;
}

function write(root: string, relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function commitAll(root: string, message: string): string {
  gitIn(root, ["add", "-A"]);
  gitIn(root, ["commit", "-qm", message]);
  return gitIn(root, ["rev-parse", "HEAD"]);
}

function registryJson(
  claims: Array<{ id: string; surfacePaths: string[] }>,
): string {
  return JSON.stringify({ claims });
}

function currentClaims(root: string): PublicClaimRegistry["claims"] {
  return (
    JSON.parse(
      readFileSync(join(root, "docs/PUBLIC_CLAIMS.json"), "utf8"),
    ) as PublicClaimRegistry
  ).claims;
}

describe("compareSurfaces against a real repository", () => {
  it(
    "returns the real changed set and audited surfaces (a constant-empty comparable cannot)",
    () => {
      const root = initRepo();
      write(root, "docs/PUBLIC_CLAIMS.json", registryJson([{ id: "CLM-001", surfacePaths: ["surface.tsx"] }]));
      write(root, "surface.tsx", "// CLM-001 v1\n");
      const audited = commitAll(root, "audit");
      write(root, "surface.tsx", "// CLM-001 v2\n");
      commitAll(root, "edit surface");

      const comparison = compareSurfaces(root, audited);
      expect(comparison.status).toBe("comparable");
      if (comparison.status !== "comparable") throw new Error("expected a comparable result");
      expect(comparison.changedPaths).toContain("surface.tsx");
      expect(comparison.auditedSurfacePathsByClaim.get("CLM-001")).toEqual(["surface.tsx"]);
    },
    GIT_TEST_TIMEOUT,
  );

  it(
    "flags an audited surface dropped from a claim in the same commit that edits it (the bypass)",
    () => {
      const root = initRepo();
      write(root, "docs/PUBLIC_CLAIMS.json", registryJson([{ id: "CLM-001", surfacePaths: ["surface.tsx"] }]));
      write(root, "surface.tsx", "// CLM-001 audited\n");
      write(root, "decoy.tsx", "// CLM-001 decoy\n");
      const audited = commitAll(root, "audit");
      // Edit the audited surface and retarget the claim to an unchanged decoy in
      // the same commit. Intersecting only the current surfaces with the changed
      // set is empty, so the pre-fix check passed; the audited baseline still
      // sees the dropped surface.
      write(root, "surface.tsx", "// CLM-001 edited after audit\n");
      write(root, "docs/PUBLIC_CLAIMS.json", registryJson([{ id: "CLM-001", surfacePaths: ["decoy.tsx"] }]));
      commitAll(root, "drop audited surface");

      const comparison = compareSurfaces(root, audited);
      const issues = detectStaleClaims(
        { auditedRevision: audited, claims: currentClaims(root) },
        comparison,
      );
      const retargeted = issues.filter((issue) => issue.code === "CLAIM_SURFACE_RETARGETED");
      expect(retargeted.map((issue) => issue.subject)).toEqual(["CLM-001"]);
      expect(retargeted[0].message).toContain("surface.tsx");
    },
    GIT_TEST_TIMEOUT,
  );

  it(
    "matches anchored, dot-relative, and non-ASCII surface spellings against Git's own paths",
    () => {
      const root = initRepo();
      write(
        root,
        "docs/PUBLIC_CLAIMS.json",
        registryJson([
          { id: "CLM-001", surfacePaths: ["surface.tsx"] },
          { id: "CLM-002", surfacePaths: ["sub/page.tsx"] },
          { id: "CLM-003", surfacePaths: ["café.tsx"] },
        ]),
      );
      write(root, "surface.tsx", "// CLM-001 v1\n");
      write(root, "sub/page.tsx", "// CLM-002 v1\n");
      write(root, "café.tsx", "// CLM-003 v1\n");
      const audited = commitAll(root, "audit");
      write(root, "surface.tsx", "// CLM-001 v2\n");
      write(root, "sub/page.tsx", "// CLM-002 v2\n");
      write(root, "café.tsx", "// CLM-003 v2\n");
      commitAll(root, "edit surfaces");

      const comparison = compareSurfaces(root, audited);
      // Current registry spells the same paths awkwardly; each must still match
      // Git's own repo-relative output: a `#L10` anchor, a `./` prefix, and a
      // non-ASCII path that plain `--name-only` would octal-quote.
      const claims = [
        { id: "CLM-001", surfacePaths: ["surface.tsx#L10"] },
        { id: "CLM-002", surfacePaths: ["./sub/page.tsx"] },
        { id: "CLM-003", surfacePaths: ["café.tsx"] },
      ] as unknown as PublicClaimRegistry["claims"];
      const issues = detectStaleClaims({ auditedRevision: audited, claims }, comparison);
      const stale = issues
        .filter((issue) => issue.code === "CLAIM_SURFACE_STALE")
        .map((issue) => issue.subject)
        .sort();
      expect(stale).toEqual(["CLM-001", "CLM-002", "CLM-003"]);
      expect(issues.some((issue) => issue.code === "CLAIM_SURFACE_RETARGETED")).toBe(false);
    },
    GIT_TEST_TIMEOUT,
  );
});

describe("compareSurfaces fails closed", () => {
  it(
    "on a malformed auditedRevision, before it reaches any Git argument",
    () => {
      const root = initRepo();
      write(root, "docs/PUBLIC_CLAIMS.json", registryJson([]));
      write(root, "surface.tsx", "x\n");
      commitAll(root, "c1");
      const comparison = compareSurfaces(root, "not-a-valid-revision");
      expect(comparison.status).toBe("indeterminate");
      if (comparison.status !== "indeterminate") throw new Error("expected indeterminate");
      expect(comparison.reason).toContain("well-formed");
    },
    GIT_TEST_TIMEOUT,
  );

  it(
    "when auditedRevision is a well-formed hash that is not a commit object",
    () => {
      const root = initRepo();
      write(root, "docs/PUBLIC_CLAIMS.json", registryJson([]));
      write(root, "surface.tsx", "x\n");
      commitAll(root, "c1");
      const comparison = compareSurfaces(root, "0".repeat(40));
      expect(comparison.status).toBe("indeterminate");
      if (comparison.status !== "indeterminate") throw new Error("expected indeterminate");
      expect(comparison.reason).toContain("not a known commit object");
    },
    GIT_TEST_TIMEOUT,
  );

  it(
    "when auditedRevision is not an ancestor of HEAD",
    () => {
      const root = initRepo();
      write(root, "docs/PUBLIC_CLAIMS.json", registryJson([]));
      write(root, "a.txt", "1\n");
      commitAll(root, "base");
      const defaultBranch = gitIn(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
      gitIn(root, ["checkout", "-q", "-b", "divergent"]);
      write(root, "b.txt", "1\n");
      const divergent = commitAll(root, "divergent");
      gitIn(root, ["checkout", "-q", defaultBranch]);
      const comparison = compareSurfaces(root, divergent);
      expect(comparison.status).toBe("indeterminate");
      if (comparison.status !== "indeterminate") throw new Error("expected indeterminate");
      expect(comparison.reason).toContain("not an ancestor");
    },
    GIT_TEST_TIMEOUT,
  );

  it(
    "on a shallow clone whose history omits the audited object",
    () => {
      const source = initRepo("public-claims-check-source-");
      write(source, "docs/PUBLIC_CLAIMS.json", registryJson([]));
      write(source, "a.txt", "1\n");
      const first = commitAll(source, "first");
      write(source, "a.txt", "2\n");
      commitAll(source, "second");
      const shallow = mkdtempSync(join(tmpdir(), "public-claims-check-shallow-"));
      tempRoots.push(shallow);
      execFileSync(
        "git",
        ["clone", "--depth", "1", pathToFileURL(source).href, shallow],
        { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
      );
      expect(gitIn(shallow, ["rev-parse", "--is-shallow-repository"])).toBe("true");
      const comparison = compareSurfaces(shallow, first);
      expect(comparison.status).toBe("indeterminate");
      if (comparison.status !== "indeterminate") throw new Error("expected indeterminate");
      expect(comparison.reason).toContain("shallow clone");
    },
    GIT_TEST_TIMEOUT,
  );
});

describe("collectPublicClaimIssues wires staleness into the gate", () => {
  it(
    "reports CLAIM_SURFACE_STALE for a claim whose surface changed since the audit",
    () => {
      const root = initRepo();
      write(root, "docs/PUBLIC_CLAIMS.json", registryJson([{ id: "CLM-001", surfacePaths: ["surface.tsx"] }]));
      write(root, "surface.tsx", "// CLM-001 v1\n");
      const audited = commitAll(root, "audit");
      write(root, "surface.tsx", "// CLM-001 v2\n");
      commitAll(root, "edit surface");

      const registry = {
        auditedRevision: audited,
        claims: [{ id: "CLM-001", surfacePaths: ["surface.tsx"], evidence: [] }],
      } as unknown as PublicClaimRegistry;
      const requirements = { requirements: [] } as unknown as ProductRequirementManifest;
      const issues = collectPublicClaimIssues(root, registry, requirements);
      expect(
        issues.some(
          (issue) => issue.code === "CLAIM_SURFACE_STALE" && issue.subject === "CLM-001",
        ),
      ).toBe(true);
    },
    GIT_TEST_TIMEOUT,
  );
});

// applyEvidenceHolds is a pure partition of already-collected issues against a
// set of recorded holds, so it needs no working tree. The registry is consulted
// only to learn which evidence IDs are "live"; a minimal hand-built registry
// with one non-live entry is enough to drive every branch, and an explicit
// `now` keeps recordedAt/expiresAt deterministic across runners.
describe("applyEvidenceHolds", () => {
  const holdRegistry = {
    claims: [
      {
        id: "CLM-001",
        evidence: [
          { id: "EV-STALE-1", type: "live", locator: "https://x/livez", revision: REACHABLE },
          { id: "EV-STALE-2", type: "live", locator: "https://x/readyz", revision: REACHABLE },
          { id: "EV-FRESH", type: "live", locator: "https://x/healthz", revision: REACHABLE },
          {
            id: "EV-NONLIVE",
            type: "test",
            locator: "packages/contract/src/public-claims.test.ts",
          },
        ],
      },
    ],
  } as unknown as PublicClaimRegistry;

  const HOLD_NOW = new Date("2026-09-13T00:00:00.000Z");

  function staleIssue(subject: string): PublicClaimIssue {
    return {
      code: "LIVE_EVIDENCE_STALE",
      subject,
      message: `live evidence ${subject} was last observed too long ago`,
    };
  }

  // A well-formed hold on the stale entry EV-STALE-1: recorded 3 days before
  // `now` and expiring 2 days after it, a 5-day window inside the 7-day ceiling.
  // Overrides mutate exactly one field per invalid case.
  function validHold(overrides: Record<string, unknown> = {}): PublicClaimEvidenceHold {
    return {
      evidenceId: "EV-STALE-1",
      recordedAt: "2026-09-10T00:00:00.000Z",
      expiresAt: "2026-09-15T00:00:00.000Z",
      reason: "production probe unreachable during a planned migration",
      authorizedBy: "release-captain",
      ...overrides,
    } as unknown as PublicClaimEvidenceHold;
  }

  function apply(issues: PublicClaimIssue[], holds: readonly PublicClaimEvidenceHold[]) {
    return applyEvidenceHolds(issues, holds, { registry: holdRegistry, now: HOLD_NOW });
  }

  it("moves a stale issue to held under a valid, unexpired hold and blocks nothing", () => {
    const { blocking, held } = apply([staleIssue("EV-STALE-1")], [validHold()]);
    expect(blocking).toEqual([]);
    expect(held).toHaveLength(1);
    expect(held[0].code).toBe("LIVE_EVIDENCE_STALE_HELD");
    expect(held[0].subject).toBe("EV-STALE-1");
    expect(held[0].message).toContain("2026-09-15T00:00:00.000Z");
  });

  it("blocks EVIDENCE_HOLD_EXPIRED when an expired hold still names stale evidence", () => {
    const { blocking, held } = apply(
      [staleIssue("EV-STALE-1")],
      [validHold({ recordedAt: "2026-09-05T00:00:00.000Z", expiresAt: "2026-09-10T00:00:00.000Z" })],
    );
    expect(held).toEqual([]);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].code).toBe("EVIDENCE_HOLD_EXPIRED");
    expect(blocking[0].subject).toBe("EV-STALE-1");
    // Stale evidence cannot hide behind a lapsed hold: the original staleness is
    // carried into the expiry message so the gate still blocks on it.
    expect(blocking[0].message).toContain("was last observed too long ago");
  });

  it("reports a non-blocking EVIDENCE_HOLD_UNUSED for a hold on fresh evidence", () => {
    const { blocking, held } = apply([], [validHold({ evidenceId: "EV-FRESH" })]);
    expect(blocking).toEqual([]);
    expect(held).toHaveLength(1);
    expect(held[0].code).toBe("EVIDENCE_HOLD_UNUSED");
    expect(held[0].subject).toBe("EV-FRESH");
  });

  it("reports EVIDENCE_HOLD_NOT_YET_EFFECTIVE (non-blocking) for a future-dated hold, and the stale issue still blocks", () => {
    const { blocking, held } = apply(
      [staleIssue("EV-STALE-1")],
      [validHold({ recordedAt: "2026-09-20T00:00:00.000Z", expiresAt: "2026-09-21T00:00:00.000Z" })],
    );
    expect(held).toHaveLength(1);
    expect(held[0].code).toBe("EVIDENCE_HOLD_NOT_YET_EFFECTIVE");
    expect(held[0].subject).toBe("EV-STALE-1");
    // A future-dated hold is inert until its recordedAt, so it extends no cover:
    // the staleness it names stays blocking.
    expect(blocking).toHaveLength(1);
    expect(blocking[0].code).toBe("LIVE_EVIDENCE_STALE");
    expect(blocking[0].subject).toBe("EV-STALE-1");
  });

  it("reports EVIDENCE_HOLD_NOT_YET_EFFECTIVE (non-blocking) for a future-dated hold on fresh evidence, with nothing blocking", () => {
    const { blocking, held } = apply(
      [],
      [validHold({ evidenceId: "EV-FRESH", recordedAt: "2026-09-20T00:00:00.000Z", expiresAt: "2026-09-21T00:00:00.000Z" })],
    );
    expect(blocking).toEqual([]);
    expect(held).toHaveLength(1);
    expect(held[0].code).toBe("EVIDENCE_HOLD_NOT_YET_EFFECTIVE");
    expect(held[0].subject).toBe("EV-FRESH");
  });

  // Each malformed or unauthorized hold is rejected outright with its own
  // message; because a rejected hold provides no cover, the staleness it named
  // stays blocking. Duplicates are covered separately since they need a
  // preceding valid hold.
  const invalidHoldCases: Array<{ name: string; holds: PublicClaimEvidenceHold[]; message: string }> = [
    {
      name: "a hold longer than 7 days",
      holds: [validHold({ recordedAt: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-12T00:00:00.000Z" })],
      message: "a hold may not exceed 7 days",
    },
    {
      name: "a hold whose expiresAt is not after recordedAt",
      holds: [validHold({ recordedAt: "2026-09-10T00:00:00.000Z", expiresAt: "2026-09-10T00:00:00.000Z" })],
      message: "expiresAt must be after recordedAt",
    },
    {
      name: "a hold with a blank reason",
      holds: [validHold({ reason: "   " })],
      message: "reason must be a non-empty string",
    },
    {
      name: "a hold with a missing authorizedBy",
      holds: [validHold({ authorizedBy: undefined })],
      message: "authorizedBy must be a non-empty string",
    },
    {
      name: "a hold with a malformed recordedAt",
      holds: [validHold({ recordedAt: "2026-09-10" })],
      message: "recordedAt must be an ISO 8601 instant",
    },
    {
      name: "a hold with a malformed expiresAt",
      holds: [validHold({ expiresAt: "not-a-timestamp" })],
      message: "expiresAt must be an ISO 8601 instant",
    },
    {
      name: "a hold on an unknown evidence ID",
      holds: [validHold({ evidenceId: "EV-UNKNOWN" })],
      message: "evidenceId EV-UNKNOWN is not a live evidence entry in the registry",
    },
    {
      name: "a hold on a non-live evidence ID",
      holds: [validHold({ evidenceId: "EV-NONLIVE" })],
      message: "evidenceId EV-NONLIVE is not a live evidence entry in the registry",
    },
  ];

  for (const testCase of invalidHoldCases) {
    it(`blocks EVIDENCE_HOLD_INVALID for ${testCase.name}, and the stale issue still blocks`, () => {
      const { blocking, held } = apply([staleIssue("EV-STALE-1")], testCase.holds);
      const invalid = blocking.filter((issue) => issue.code === "EVIDENCE_HOLD_INVALID");
      expect(invalid).toHaveLength(1);
      expect(invalid[0].message).toBe(testCase.message);
      expect(
        blocking.some(
          (issue) => issue.code === "LIVE_EVIDENCE_STALE" && issue.subject === "EV-STALE-1",
        ),
      ).toBe(true);
      expect(held).toEqual([]);
    });
  }

  it("gives every invalid rejection a distinct, non-empty message", () => {
    const messages = invalidHoldCases.map(
      (testCase) =>
        apply([staleIssue("EV-STALE-1")], testCase.holds).blocking.find(
          (issue) => issue.code === "EVIDENCE_HOLD_INVALID",
        )?.message,
    );
    expect(messages.every((message) => typeof message === "string" && message.length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("blocks a duplicate hold while the first valid hold still holds the stale issue", () => {
    const { blocking, held } = apply([staleIssue("EV-STALE-1")], [validHold(), validHold()]);
    const invalid = blocking.filter((issue) => issue.code === "EVIDENCE_HOLD_INVALID");
    expect(invalid).toHaveLength(1);
    expect(invalid[0].message).toBe("duplicate evidenceId");
    expect(invalid[0].subject).toBe("EV-STALE-1");
    // The first, valid occurrence still downgrades the staleness to held; only
    // the redundant second occurrence is rejected.
    expect(held.map((issue) => issue.code)).toEqual(["LIVE_EVIDENCE_STALE_HELD"]);
  });

  it("holds the first stale entry while a second stale entry without a hold still blocks", () => {
    const { blocking, held } = apply(
      [staleIssue("EV-STALE-1"), staleIssue("EV-STALE-2")],
      [validHold()],
    );
    expect(held.map((issue) => issue.subject)).toEqual(["EV-STALE-1"]);
    expect(held[0].code).toBe("LIVE_EVIDENCE_STALE_HELD");
    expect(blocking).toHaveLength(1);
    expect(blocking[0].code).toBe("LIVE_EVIDENCE_STALE");
    expect(blocking[0].subject).toBe("EV-STALE-2");
  });

  // A hold only ever downgrades LIVE_EVIDENCE_STALE. Every other issue code stays
  // blocking even when a valid hold names the same subject; the hold is then a
  // mere unused notice.
  for (const code of ["SURFACE_PATH_MISSING", "EVIDENCE_MISSING", "LIVE_EVIDENCE_REVISION_UNREACHABLE"]) {
    it(`keeps ${code} blocking even when a valid hold names its subject`, () => {
      const { blocking, held } = apply(
        [{ code, subject: "EV-STALE-1", message: `${code} for EV-STALE-1` }],
        [validHold()],
      );
      expect(blocking.some((issue) => issue.code === code && issue.subject === "EV-STALE-1")).toBe(true);
      expect(held.map((issue) => issue.code)).toEqual(["EVIDENCE_HOLD_UNUSED"]);
    });
  }

  it("blocks every issue unchanged when there are no holds (empty or null)", () => {
    const issues: PublicClaimIssue[] = [
      staleIssue("EV-STALE-1"),
      { code: "SURFACE_PATH_MISSING", subject: "CLM-001", message: "surface.tsx does not exist" },
    ];
    for (const holds of [[], null as unknown as PublicClaimEvidenceHold[]]) {
      const { blocking, held } = apply(issues, holds);
      expect(held).toEqual([]);
      expect(blocking).toHaveLength(2);
      expect(blocking).toEqual(expect.arrayContaining(issues));
    }
  });
});
