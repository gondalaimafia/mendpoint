import type { DiffHunk, Status } from "../ds/index.js";
import type { CoverageSummary } from "./pr-map.js";
import type { MigrationPr } from "../../../lib/api.js";

/**
 * Typed shapes for the DS console views, plus reference fixtures. The views are
 * now prop-driven: the `(console)/*` server pages fetch live data via `apiGet`
 * and pass it in. These fixtures remain as the canonical shapes and as sample
 * data for the view tests; nothing here is rendered when the API has data.
 */

export type Severity = "breaking" | "deprecated" | "safe";

export type SpecChange = {
  severity: Severity;
  endpoint: string;
  note: string;
  repos: number;
  calls: number;
};

export type Stat = {
  label: string;
  value: string;
  tone: "amber" | "cyan" | "indigo";
};

/** Everything `/changes` (ChangesView) renders, mapped from a live change. */
export type ChangesData = {
  target: string;
  stats: Stat[];
  changes: SpecChange[];
};

export type PullRequest = {
  id: string;
  repo: string;
  number: number | null;
  title: string;
  status: Status;
  additions: number;
  deletions: number;
  files: number;
  checks?: "passing" | "failing" | "running";
  time: string;
  /** Impact-coverage view-model; absent for rows recorded before the channel existed. */
  coverage?: CoverageSummary;
  /** Digest verified Fettler delivery evidence. Absent on legacy migration rows. */
  candidateEvidence?: NonNullable<MigrationPr["candidateDelivery"]>;
  /** Remote draft created by the delivery worker. Never a merge action. */
  githubUrl?: string | null;
};

export type PrTab = "all" | "review" | "failing" | "merged";

export type CheckRow = { name: string; state: string };

/** Everything `/prs/[id]` (PrDetailView) renders, mapped from a live PR. */
export type PrDetailData = {
  /** The PR id used to record reviews; null when the PR is unavailable. */
  id: string | null;
  repo: string;
  title: string;
  number: number | string | null;
  status: Status;
  githubUrl: string | null;
  alert: { title: string; body: string } | null;
  diffs: Array<{
    path: string;
    hunks: DiffHunk[];
    additions: number;
    deletions: number;
  }>;
  checks: CheckRow[];
  /** Impact-coverage view-model; absent when the PR is unavailable. */
  coverage?: CoverageSummary;
};

/** Everything `/settings` (SettingsView) seeds from, mapped from live config. */
export type SettingsData = {
  specUrl: string;
  targetVersion: string;
  versionOptions: string[];
  drafts: boolean;
  autoOpen: boolean;
  notifySlack: boolean;
};

export const SPEC_TARGET = "payments-api · v2.9.4 → v3.0.0";

export const OVERVIEW_STATS: Stat[] = [
  { label: "Breaking changes", value: "6", tone: "amber" },
  { label: "Repositories affected", value: "42", tone: "cyan" },
  { label: "Call sites resolved", value: "412", tone: "cyan" },
  { label: "PRs staged", value: "42", tone: "indigo" },
];

export const SPEC_CHANGES: SpecChange[] = [
  {
    severity: "breaking",
    endpoint: "POST /v1/charges",
    note: "charge() removed — use charges.create()",
    repos: 42,
    calls: 412,
  },
  {
    severity: "breaking",
    endpoint: "GET /v1/customers/{id}",
    note: "response.email now nullable",
    repos: 18,
    calls: 96,
  },
  {
    severity: "breaking",
    endpoint: "POST /v1/refunds",
    note: "amount is required",
    repos: 11,
    calls: 44,
  },
  {
    severity: "deprecated",
    endpoint: "GET /v1/balance",
    note: "removed in v3.2.0",
    repos: 27,
    calls: 130,
  },
  {
    severity: "safe",
    endpoint: "POST /v1/payouts",
    note: "additive field: metadata",
    repos: 8,
    calls: 20,
  },
];

/** Sample `ChangesData` for view tests (mirrors the old static overview). */
export const SAMPLE_CHANGES_DATA: ChangesData = {
  target: SPEC_TARGET,
  stats: OVERVIEW_STATS,
  changes: SPEC_CHANGES,
};

export const PR_TABS: { id: PrTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "review", label: "Needs review" },
  { id: "failing", label: "Failing" },
  { id: "merged", label: "Merged" },
];

export const PULL_REQUESTS: PullRequest[] = [
  {
    id: "4821",
    repo: "acme/payments-sdk",
    number: 4821,
    title: "Migrate charge() → charges.create()",
    status: "open",
    additions: 12,
    deletions: 9,
    files: 6,
    checks: "passing",
    time: "4m ago",
  },
  {
    id: "771",
    repo: "northwind/billing-svc",
    number: 771,
    title: "Handle nullable customer.email",
    status: "open",
    additions: 8,
    deletions: 4,
    files: 3,
    checks: "running",
    time: "6m ago",
  },
  {
    id: "233",
    repo: "cedar/ledger-api",
    number: 233,
    title: "Pass required amount to refunds",
    status: "failing",
    additions: 5,
    deletions: 5,
    files: 2,
    checks: "failing",
    time: "9m ago",
  },
  {
    id: "1902",
    repo: "acme/dashboard",
    number: 1902,
    title: "Migrate charge() → charges.create()",
    status: "merged",
    additions: 21,
    deletions: 17,
    files: 9,
    checks: "passing",
    time: "1h ago",
  },
  {
    id: "88",
    repo: "vela/payouts-worker",
    number: 88,
    title: "Adopt metadata on payouts",
    status: "draft",
    additions: 3,
    deletions: 0,
    files: 1,
    checks: "passing",
    time: "2h ago",
  },
];

export function findPullRequest(id: string): PullRequest | undefined {
  return PULL_REQUESTS.find((pr) => pr.id === id || String(pr.number) === id);
}

export function filterPullRequests(prs: PullRequest[], tab: PrTab): PullRequest[] {
  switch (tab) {
    case "failing":
      return prs.filter((pr) => pr.status === "failing");
    case "merged":
      return prs.filter((pr) => pr.status === "merged");
    case "review":
      return prs.filter((pr) => pr.status === "open" || pr.status === "draft");
    case "all":
    default:
      return prs;
  }
}

export const PR_DETAIL_CHECKS: CheckRow[] = [
  { name: "unit", state: "passing" },
  { name: "integration", state: "passing" },
  { name: "typecheck", state: "passing" },
  { name: "lint", state: "passing" },
];

/** Sample `PrDetailData` for view tests (mirrors the old static detail). */
export const SAMPLE_PR_DETAIL: PrDetailData = {
  id: "4821",
  repo: "acme/payments-sdk",
  title: "Migrate charge() → charges.create()",
  number: 4821,
  status: "open",
  githubUrl: "https://github.com/acme/payments-sdk/pull/4821",
  alert: {
    title: "Breaking change · POST /v1/charges",
    body: "charge() was removed in v3.0.0. Regauge rewrote 6 call sites and left inline notes where behavior changed.",
  },
  diffs: [
    {
      path: "src/api/client.ts",
      additions: 12,
      deletions: 9,
      hunks: [
        {
          header: "@@ -14,7 +14,7 @@",
          lines: [
            { type: "ctx", line: 14, text: "  const pay = new Payments(process.env.KEY);" },
            { type: "del", line: 15, text: "  await pay.charge(order.total, 'usd');" },
            { type: "add", line: 15, text: "  await pay.charges.create({ amount: order.total });" },
            { type: "ctx", line: 16, text: "  return { ok: true };" },
          ],
        },
      ],
    },
    {
      path: "src/checkout/session.ts",
      additions: 4,
      deletions: 4,
      hunks: [
        {
          header: "@@ -62,4 +62,4 @@",
          lines: [
            { type: "del", line: 62, text: "  const c = await pay.charge(total, currency);" },
            { type: "add", line: 62, text: "  const c = await pay.charges.create({ amount: total, currency });" },
          ],
        },
      ],
    },
  ],
  checks: PR_DETAIL_CHECKS,
};

/** Sample `SettingsData` for view tests (mirrors the old static form). */
export const SAMPLE_SETTINGS: SettingsData = {
  specUrl: "https://api.acme.dev/openapi.yaml",
  targetVersion: "v3.0.0",
  versionOptions: ["v3.0.0", "v2.9.4"],
  drafts: true,
  autoOpen: true,
  notifySlack: false,
};
