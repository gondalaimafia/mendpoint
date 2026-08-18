import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, evaluatePolicy, filterFindingsByPolicy } from "./index.js";

const baseDraft = {
  title: "t",
  body: "b",
  branchName: "br",
  patch: "",
  risk: "breaking" as const,
  confidence: "high" as const,
  fileEdits: [
    { path: "src/api.ts", original: "a", updated: "b" },
    { path: ".env.production", original: "k=1", updated: "k=2" },
    { path: "config/prod/secrets.yaml", original: "x", updated: "y" },
  ],
};

afterEach(() => {
  delete process.env.ALLOW_AUTO_MERGE;
});

describe("policy engine", () => {
  it("defaults never auto-merge", () => {
    expect(DEFAULT_POLICY.autoMergeLowRisk).toBe(false);
    const d = evaluatePolicy(baseDraft, []);
    expect(d.allowAutoMerge).toBe(false);
    expect(d.labels).toContain("needs-human-review");
  });

  it("hard-offs auto-merge even when policy flag true without env", () => {
    const draft = { ...baseDraft, risk: "non_breaking" as const };
    const d = evaluatePolicy(draft, [], {
      policy: { autoMergeLowRisk: true },
    });
    expect(d.allowAutoMerge).toBe(false);
    expect(d.labels).toContain("needs-human-review");
    expect(d.reasons.some((r) => r.includes("auto-merge"))).toBe(true);
  });

  it("allows auto-merge only when env set and non_breaking with policy flag", () => {
    process.env.ALLOW_AUTO_MERGE = "true";
    const draft = { ...baseDraft, risk: "non_breaking" as const };
    const d = evaluatePolicy(draft, [], {
      policy: { autoMergeLowRisk: true },
    });
    expect(d.allowAutoMerge).toBe(true);
    expect(d.labels).toContain("auto-merge-eligible");
  });

  it("blocks denylisted paths", () => {
    const d = evaluatePolicy(baseDraft, [
      {
        filePath: "src/api.ts",
        lineStart: 1,
        lineEnd: 1,
        symbol: "x",
        confidence: "high",
        evidence: "x",
        relatedOps: [],
      },
    ]);
    expect(d.blockedFiles.some((p) => p.includes(".env") || p.includes("prod"))).toBe(true);
    expect(d.allowedEdits.every((e) => e.path === "src/api.ts")).toBe(true);
    expect(d.allowPr).toBe(true);
  });

  it("flags auth findings for two reviewers", () => {
    const d = evaluatePolicy(baseDraft, [
      {
        filePath: "src/api.ts",
        lineStart: 1,
        lineEnd: 1,
        symbol: "X-API-Key",
        confidence: "high",
        evidence: "Authorization header",
        relatedOps: ["security_changed"],
      },
    ]);
    expect(d.labels).toContain("needs-two-reviewers");
  });

  it("does not map an auth.ts finding onto an unrelated notauth.ts edit", () => {
    const draft = {
      ...baseDraft,
      fileEdits: [{ path: "src/notauth.ts", original: "a", updated: "b" }],
    };
    const d = evaluatePolicy(draft, [
      {
        filePath: "auth.ts",
        lineStart: 1,
        lineEnd: 1,
        symbol: "config",
        confidence: "low",
        evidence: "unrelated",
        relatedOps: [],
      },
    ]);
    // The edit has no finding of its own; the low-confidence auth.ts finding must not be mapped
    // onto src/notauth.ts (which merely ends in "auth.ts") and suppress it below minConfidenceForEdit.
    expect(d.allowedEdits.map((e) => e.path)).toEqual(["src/notauth.ts"]);
    expect(d.allowPr).toBe(true);
  });

  it("still maps a genuinely matching finding by path-segment suffix", () => {
    const draft = {
      ...baseDraft,
      fileEdits: [{ path: "src/auth.ts", original: "a", updated: "b" }],
    };
    const d = evaluatePolicy(draft, [
      {
        filePath: "auth.ts",
        lineStart: 1,
        lineEnd: 1,
        symbol: "config",
        confidence: "low",
        evidence: "unrelated",
        relatedOps: [],
      },
    ]);
    // Relative-vs-absolute tolerance preserved: a low-confidence finding on this very file
    // (auth.ts vs src/auth.ts) still maps and suppresses the edit.
    expect(d.allowedEdits).toHaveLength(0);
  });

  it("filterFindingsByPolicy drops low confidence and blocked paths", () => {
    const f = filterFindingsByPolicy([
      {
        filePath: ".env",
        lineStart: 1,
        lineEnd: 1,
        symbol: "KEY",
        confidence: "high",
        evidence: "x",
        relatedOps: [],
      },
      {
        filePath: "src/a.ts",
        lineStart: 1,
        lineEnd: 1,
        symbol: "x",
        confidence: "low",
        evidence: "x",
        relatedOps: [],
      },
      {
        filePath: "src/a.ts",
        lineStart: 2,
        lineEnd: 2,
        symbol: "y",
        confidence: "high",
        evidence: "y",
        relatedOps: [],
      },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.symbol).toBe("y");
  });
});

describe("baseline denylist is enforced at evaluatePolicy regardless of the override", () => {
  // The exact never_touch_paths row scripts/seed.ts writes for every seeded
  // consumer — a 5-entry list. It must ADD to, never REPLACE, the baseline.
  const SEEDED_NEVER_TOUCH = [
    ".env",
    ".env.production",
    "secrets/",
    "prod/",
    "package-lock.json",
  ];
  const PROTECTED_BY_BASELINE = [
    "terraform/main.tf",
    "app/credentials",
    "deploy/id_rsa",
    "certs/server.pem",
    ".env.local",
    "Cargo.lock",
    "k8s/prod/values.yaml",
    "production/config.json",
  ];

  it("blocks baseline-protected paths under the seeded consumer configuration", () => {
    const draft = {
      ...baseDraft,
      fileEdits: [
        { path: "src/api.ts", original: "a", updated: "b" },
        ...PROTECTED_BY_BASELINE.map((path) => ({ path, original: "x", updated: "y" })),
      ],
    };
    const decision = evaluatePolicy(draft, [], {
      policy: { neverTouchPaths: SEEDED_NEVER_TOUCH },
    });
    for (const path of PROTECTED_BY_BASELINE) {
      expect(decision.blockedFiles).toContain(path);
    }
    // The one legitimate edit still survives the filter.
    expect(decision.allowedEdits.map((e) => e.path)).toEqual(["src/api.ts"]);
  });

  it("blocks baseline-protected paths even when the override is []", () => {
    const draft = {
      ...baseDraft,
      fileEdits: [{ path: "terraform/main.tf", original: "x", updated: "y" }],
    };
    const decision = evaluatePolicy(draft, [], { policy: { neverTouchPaths: [] } });
    expect(decision.blockedFiles).toContain("terraform/main.tf");
    expect(decision.allowedEdits).toHaveLength(0);
  });

  it("still blocks a baseline path when a resolved policy layer sets neverTouchPaths to a single custom entry", () => {
    // Simulates a Warden branch layer resolving neverTouchPaths to ["branch-only/"].
    // mergePolicy keeps replacement semantics for the layer reducers, but the
    // baseline is unioned at enforcement, so a baseline path (terraform/) is still
    // blocked AND the layer's own entry (branch-only/) is honored.
    const draft = {
      ...baseDraft,
      fileEdits: [
        { path: "terraform/main.tf", original: "x", updated: "y" },
        { path: "branch-only/thing.ts", original: "a", updated: "b" },
        { path: "src/api.ts", original: "a", updated: "b" },
      ],
    };
    const decision = evaluatePolicy(draft, [], {
      policy: { neverTouchPaths: ["branch-only/"] },
    });
    expect(decision.blockedFiles).toContain("terraform/main.tf");
    expect(decision.blockedFiles).toContain("branch-only/thing.ts");
    expect(decision.allowedEdits.map((e) => e.path)).toEqual(["src/api.ts"]);
  });
});
