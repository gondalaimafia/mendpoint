import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  refreshDueness,
  refreshLiveEvidence,
  SEVEN_DAYS_MS,
  type LiveObservation,
  type RefreshInput,
} from "./refresh-live-evidence.js";
import type {
  ClaimStalenessComparison,
  PublicClaimRegistry,
} from "../packages/contract/src/public-claims.js";
import type { ProductRequirementManifest } from "../packages/contract/src/product-requirements.js";

const root = resolve(import.meta.dirname, "..");

// The real, contract-valid registry, but with the production host swapped for an
// obviously fake one. The pure core never makes a request, so the host is only
// data here; keeping the rest of the file real means the produced registry is
// exercised against the actual contract validator and the actual requirements.
const REAL_REGISTRY = readFileSync(resolve(root, "docs/PUBLIC_CLAIMS.json"), "utf8");
const FIXTURE = REAL_REGISTRY.replaceAll(
  "mendpoint-fettler-production.fly.dev",
  "prod.example.invalid",
);
const REQUIREMENTS = JSON.parse(
  readFileSync(resolve(root, "docs/PRODUCT_REQUIREMENTS.json"), "utf8"),
) as ProductRequirementManifest;

const NOW = new Date("2026-10-15T18:00:00.000Z");
const DEPLOYED = "1234567890abcdef1234567890abcdef12345678";

/** The three live observations, healthy, with distinct millisecond instants. */
function healthyObservations(): LiveObservation[] {
  return [
    {
      evidenceId: "CLM-001-EV01",
      locator: "https://prod.example.invalid/livez",
      httpStatus: 200,
      observedAt: "2026-10-15T17:34:44.551Z",
    },
    {
      evidenceId: "CLM-013-EV01",
      locator: "https://prod.example.invalid/access",
      httpStatus: 200,
      observedAt: "2026-10-15T17:34:45.114Z",
    },
    {
      evidenceId: "CLM-013-EV02",
      locator: "https://prod.example.invalid/healthz",
      httpStatus: 200,
      observedAt: "2026-10-15T17:34:45.953Z",
      healthzOk: true,
    },
  ];
}

/** A clean OLD-to-deployed comparison: every claim present, nothing changed. */
function cleanComparison(registryText: string): ClaimStalenessComparison {
  const registry = JSON.parse(registryText) as PublicClaimRegistry;
  const auditedSurfacePathsByClaim = new Map<string, readonly string[]>();
  for (const claim of registry.claims) {
    auditedSurfacePathsByClaim.set(claim.id, claim.surfacePaths);
  }
  return {
    status: "comparable",
    headRevision: DEPLOYED,
    changedPaths: [],
    auditedSurfacePathsByClaim,
  };
}

function baseInput(overrides: Partial<RefreshInput> = {}): RefreshInput {
  return {
    registryText: FIXTURE,
    observations: healthyObservations(),
    deployedRevision: DEPLOYED,
    versionBefore: DEPLOYED,
    versionAfter: DEPLOYED,
    deployedRevisionIsAncestorOfMain: true,
    auditedRevisionIsAncestorOfDeployed: true,
    now: NOW,
    comparison: cleanComparison(FIXTURE),
    requirements: REQUIREMENTS,
    ...overrides,
  };
}

/** Indices of lines that differ between two texts of equal line count. */
function changedLineIndices(before: string, after: string): number[] {
  const b = before.split("\n");
  const a = after.split("\n");
  expect(a.length).toBe(b.length);
  const changed: number[] = [];
  for (let i = 0; i < b.length; i += 1) if (a[i] !== b[i]) changed.push(i);
  return changed;
}

describe("refreshDueness", () => {
  it("is not due when the earliest live entry is further away than the threshold", () => {
    // The fixture's live entries were observed at 2026-09-23 with a 7-day window,
    // so relative to an early clock they are far from expiry.
    const now = new Date("2026-09-24T00:00:00.000Z");
    const result = refreshDueness(FIXTURE, now, { withinHours: 72, force: false });
    expect(result.due).toBe(false);
    expect(result.earliestEvidenceId).toBe("CLM-001-EV01");
    expect(result.earliestFreshUntil).toContain("2026-09-30");
  });

  it("is due when the earliest live entry expires within the threshold", () => {
    const now = new Date("2026-09-28T00:00:00.000Z"); // ~2.6 days before expiry
    expect(refreshDueness(FIXTURE, now, { withinHours: 72, force: false }).due).toBe(true);
  });

  it("is due when forced even if nothing is close to expiring", () => {
    const now = new Date("2026-09-24T00:00:00.000Z");
    expect(refreshDueness(FIXTURE, now, { withinHours: 72, force: true }).due).toBe(true);
  });

  it("treats an unparseable freshUntil as due, never as not-expiring", () => {
    const now = new Date("2026-09-24T00:00:00.000Z"); // far from the real 09-30 expiry
    const broken = FIXTURE.replace('"freshUntil": "2026-09-30T17:34:44.551Z"', '"freshUntil": "not-a-date"');
    expect(broken).not.toBe(FIXTURE);
    expect(refreshDueness(broken, now, { withinHours: 72, force: false }).due).toBe(true);
  });
});

describe("refreshLiveEvidence — due and healthy", () => {
  it("changes exactly auditedRevision and the three live entries, byte-identical elsewhere", () => {
    const outcome = refreshLiveEvidence(baseInput());
    expect(outcome.status).toBe("refreshed");
    if (outcome.status !== "refreshed") return;

    const changed = changedLineIndices(FIXTURE, outcome.text);
    // One auditedRevision line + three live evidence lines, nothing else.
    expect(changed).toHaveLength(4);

    const beforeLines = FIXTURE.split("\n");
    const afterLines = outcome.text.split("\n");
    const changedText = changed.map((i) => afterLines[i]);
    expect(changedText.filter((line) => line.includes('"auditedRevision"'))).toHaveLength(1);
    for (const id of ["CLM-001-EV01", "CLM-013-EV01", "CLM-013-EV02"]) {
      expect(changedText.filter((line) => line.includes(`"id": "${id}"`))).toHaveLength(1);
    }

    // Every changed line now carries the deployed revision; the auditedRevision
    // line and each live entry's revision moved to it.
    for (const i of changed) expect(afterLines[i]).toContain(DEPLOYED);
    // The OLD revision is gone entirely (auditedRevision + 3 live revisions all moved).
    const oldRevision = (JSON.parse(FIXTURE) as PublicClaimRegistry).auditedRevision;
    expect(outcome.text).not.toContain(oldRevision);

    // freshUntil == observedAt + 7 days for each entry.
    for (const change of outcome.changes) {
      expect(Date.parse(change.freshUntil) - Date.parse(change.observedAt)).toBe(SEVEN_DAYS_MS);
    }

    // Every non-changed line is byte-identical.
    for (let i = 0; i < beforeLines.length; i += 1) {
      if (!changed.includes(i)) expect(afterLines[i]).toBe(beforeLines[i]);
    }
  });

  it("never modifies lastVerifiedAt", () => {
    const outcome = refreshLiveEvidence(baseInput());
    expect(outcome.status).toBe("refreshed");
    if (outcome.status !== "refreshed") return;
    const count = (text: string) => (text.match(/"lastVerifiedAt"/g) ?? []).length;
    const values = (text: string) =>
      [...text.matchAll(/"lastVerifiedAt":\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(count(outcome.text)).toBe(count(FIXTURE));
    expect(values(outcome.text)).toEqual(values(FIXTURE));
  });

  it("produces a registry that passes contract validation", () => {
    const outcome = refreshLiveEvidence(baseInput());
    expect(outcome.status).toBe("refreshed");
    if (outcome.status !== "refreshed") return;
    // Re-running the core on the produced text with fresh observations is a no-op
    // shaped change, and it must still refresh (not refuse), proving validity.
    const again = refreshLiveEvidence(
      baseInput({ registryText: outcome.text, comparison: cleanComparison(outcome.text) }),
    );
    expect(again.status).toBe("refreshed");
  });
});

describe("refreshLiveEvidence — refusals", () => {
  it("refuses on a non-200 observation", () => {
    const observations = healthyObservations();
    observations[0] = { ...observations[0], httpStatus: 503 };
    const outcome = refreshLiveEvidence(baseInput({ observations }));
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("HTTP 503");
  });

  it("refuses when the healthz surface does not return ok: true", () => {
    const observations = healthyObservations();
    observations[2] = { ...observations[2], healthzOk: false };
    const outcome = refreshLiveEvidence(baseInput({ observations }));
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("ok: true");
  });

  it("refuses when /version changed mid-run", () => {
    const outcome = refreshLiveEvidence(
      baseInput({ versionAfter: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" }),
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("version changed mid-run");
  });

  it("refuses when the deployed revision is not an ancestor of origin/main", () => {
    const outcome = refreshLiveEvidence(baseInput({ deployedRevisionIsAncestorOfMain: false }));
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("not an ancestor");
  });

  it("refuses when the move would take auditedRevision backward", () => {
    const outcome = refreshLiveEvidence({
      ...baseInput(),
      auditedRevisionIsAncestorOfDeployed: false,
    });
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("would move auditedRevision backward");
  });

  it("refuses when a claim is surface-stale between the audited and deployed revisions", () => {
    const registry = JSON.parse(FIXTURE) as PublicClaimRegistry;
    const auditedSurfacePathsByClaim = new Map<string, readonly string[]>();
    for (const claim of registry.claims) auditedSurfacePathsByClaim.set(claim.id, claim.surfacePaths);
    // A surface CLM-013 currently maps changed between old and deployed.
    const comparison: ClaimStalenessComparison = {
      status: "comparable",
      headRevision: DEPLOYED,
      changedPaths: ["apps/web/app/access/page.tsx"],
      auditedSurfacePathsByClaim,
    };
    const outcome = refreshLiveEvidence(baseInput({ comparison }));
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.reason).toContain("surface-stale");
      expect(outcome.reason).toContain("CLAIM_SURFACE_STALE");
    }
  });

  it("refuses when the staleness comparison is indeterminate", () => {
    const outcome = refreshLiveEvidence(
      baseInput({ comparison: { status: "indeterminate", reason: "shallow clone" } }),
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("CLAIM_STALENESS_INDETERMINATE");
  });

  it("refuses when the resulting registry would fail the claims check", () => {
    // A non-live field is invalid (a disallowed marketing absolute). The core
    // does not touch it, so the produced registry fails contract validation —
    // distinct from the staleness refusal above.
    const broken = FIXTURE.replace(
      "Mendpoint is available as a Private Design Partner Preview.",
      "Mendpoint is always available as a Private Design Partner Preview.",
    );
    const outcome = refreshLiveEvidence(
      baseInput({ registryText: broken, comparison: cleanComparison(broken) }),
    );
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") {
      expect(outcome.reason).toContain("would fail the claims check");
      expect(outcome.reason).toContain("UNSUPPORTED_ABSOLUTE");
    }
  });

  it("refuses when two observations share the same instant (not distinct ms)", () => {
    const observations = healthyObservations();
    observations[1] = { ...observations[1], observedAt: observations[0].observedAt };
    const outcome = refreshLiveEvidence(baseInput({ observations }));
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("shared across observations");
  });

  it("refuses when an observedAt is in the future", () => {
    const observations = healthyObservations();
    observations[0] = { ...observations[0], observedAt: "2026-10-15T18:30:00.000Z" };
    const outcome = refreshLiveEvidence(baseInput({ observations }));
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("future");
  });

  it("refuses when the observations do not match the registry's live evidence", () => {
    const observations = healthyObservations().slice(0, 2);
    const outcome = refreshLiveEvidence(baseInput({ observations }));
    expect(outcome.status).toBe("refused");
    if (outcome.status === "refused") expect(outcome.reason).toContain("do not match");
  });
});
