/**
 * Policy engine (Phase B)
 *
 * Defaults:
 * - never auto-merge
 * - never touch denylisted paths (prod config, secrets, lockfiles, .env, etc.)
 * - require human review for breaking auth / high risk
 */
import type { ChangeRisk, Confidence, ImpactFinding, MigrationDraft } from "@mendpoint/shared";

export type PolicyConfig = {
  /** Default false — agents never auto-merge */
  autoMergeLowRisk: boolean;
  /** Paths (glob-ish substrings) the agent must never edit */
  neverTouchPaths: string[];
  /** If true, block PR open when any finding is auth/security related */
  requireTwoReviewersForAuth: boolean;
  /** Minimum confidence to include a site in auto-generated PR edits */
  minConfidenceForEdit: Confidence;
  /** Block opening PRs entirely (notification only) */
  notificationsOnly: boolean;
};

export const DEFAULT_POLICY: PolicyConfig = {
  autoMergeLowRisk: false,
  neverTouchPaths: [
    ".env",
    ".env.local",
    ".env.production",
    "secrets/",
    "credentials",
    "id_rsa",
    ".pem",
    "prod/",
    "production/",
    "k8s/prod",
    "terraform/",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "Cargo.lock",
  ],
  requireTwoReviewersForAuth: true,
  minConfidenceForEdit: "medium",
  notificationsOnly: false,
};

export type PolicyDecision = {
  allowPr: boolean;
  allowAutoMerge: boolean;
  blockedFiles: string[];
  allowedEdits: MigrationDraft["fileEdits"];
  reasons: string[];
  labels: string[];
};

function pathBlocked(path: string, neverTouch: string[]): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  return neverTouch.some((rule) => p.includes(rule.toLowerCase()));
}

export function mergePolicy(
  overrides?: Partial<PolicyConfig> | null,
): PolicyConfig {
  const o = overrides ?? {};
  return {
    ...DEFAULT_POLICY,
    ...o,
    // Baseline path protections are immutable; an override may only add rules.
    neverTouchPaths: [...new Set([
      ...DEFAULT_POLICY.neverTouchPaths,
      ...(o.neverTouchPaths ?? []),
    ])],
    autoMergeLowRisk: o.autoMergeLowRisk ?? DEFAULT_POLICY.autoMergeLowRisk,
    requireTwoReviewersForAuth:
      o.requireTwoReviewersForAuth ?? DEFAULT_POLICY.requireTwoReviewersForAuth,
    minConfidenceForEdit: o.minConfidenceForEdit ?? DEFAULT_POLICY.minConfidenceForEdit,
    notificationsOnly: o.notificationsOnly ?? DEFAULT_POLICY.notificationsOnly,
  };
}


/**
 * Evaluate policy against a proposed migration draft + findings.
 */
export function evaluatePolicy(
  draft: MigrationDraft,
  findings: ImpactFinding[],
  opts?: {
    policy?: Partial<PolicyConfig>;
    risk?: ChangeRisk;
  },
): PolicyDecision {
  const policy = mergePolicy(opts?.policy);
  const reasons: string[] = [];
  const labels: string[] = ["mendpoint"];
  const blockedFiles: string[] = [];

  // Never auto-merge by default — env hard-off unless ALLOW_AUTO_MERGE is explicitly enabled
  let allowAutoMerge = policy.autoMergeLowRisk === true && draft.risk === "non_breaking";
  if (
    process.env.ALLOW_AUTO_MERGE !== "1" &&
    process.env.ALLOW_AUTO_MERGE !== "true"
  ) {
    if (allowAutoMerge) {
      reasons.push("auto-merge hard-off (set ALLOW_AUTO_MERGE=1 to enable eligibility)");
    }
    allowAutoMerge = false;
  }
  if (!allowAutoMerge) {
    if (!reasons.some((r) => r.includes("auto-merge"))) {
      reasons.push("auto-merge disabled (human review required)");
    }
    labels.push("needs-human-review");
  } else {
    labels.push("auto-merge-eligible");
  }

  if (draft.risk === "breaking") labels.push("breaking-change");
  if (draft.risk === "new_capability") labels.push("feature-adoption");

  const authRelated = findings.some(
    (f) =>
      /auth|bearer|api-key|x-api-key|security|token/i.test(f.symbol) ||
      /auth|bearer|api-key/i.test(f.evidence) ||
      f.relatedOps?.includes("security_changed"),
  );
  if (authRelated && policy.requireTwoReviewersForAuth) {
    reasons.push("auth/security surface — require two reviewers");
    labels.push("needs-two-reviewers");
  }

  const confRank = { low: 0, medium: 1, high: 2 };
  const minR = confRank[policy.minConfidenceForEdit];

  const allowedEdits = draft.fileEdits.filter((e) => {
    if (pathBlocked(e.path, policy.neverTouchPaths)) {
      blockedFiles.push(e.path);
      return false;
    }
    // Keep edit if any finding on this file meets confidence, or no findings mapped
    // Anchor on a path separator so an edit to `src/notauth.ts` does not match a finding for `auth.ts`.
    // Prefixing both sides with "/" keeps the deliberate relative-vs-absolute tolerance.
    const fileFindings = findings.filter(
      (f) => ("/" + e.path).endsWith("/" + f.filePath) || ("/" + f.filePath).endsWith("/" + e.path),
    );
    if (!fileFindings.length) return true;
    return fileFindings.some((f) => confRank[f.confidence] >= minR);
  });

  if (blockedFiles.length) {
    reasons.push(`blocked paths: ${blockedFiles.join(", ")}`);
    labels.push("policy-path-blocked");
  }

  let allowPr = !policy.notificationsOnly && allowedEdits.length > 0;
  if (policy.notificationsOnly) {
    reasons.push("notifications-only policy — no PR open");
    allowPr = false;
  }
  if (!allowedEdits.length && draft.fileEdits.length) {
    reasons.push("all proposed edits blocked by policy");
    allowPr = false;
  }

  return {
    allowPr,
    allowAutoMerge,
    blockedFiles,
    allowedEdits,
    reasons,
    labels,
  };
}

export function filterFindingsByPolicy(
  findings: ImpactFinding[],
  policy?: Partial<PolicyConfig>,
): ImpactFinding[] {
  const p = mergePolicy(policy);
  const confRank = { low: 0, medium: 1, high: 2 };
  const minR = confRank[p.minConfidenceForEdit];
  return findings.filter((f) => {
    if (pathBlocked(f.filePath, p.neverTouchPaths)) return false;
    return confRank[f.confidence] >= minR;
  });
}

export * from "./warden-policy.js";
