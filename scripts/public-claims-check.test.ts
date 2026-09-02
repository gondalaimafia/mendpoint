import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PublicClaimRegistry } from "@mendpoint/contract";
import { revisionReachabilityIssues } from "./public-claims-check.js";

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
