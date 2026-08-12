import type { Status } from "../ds/index.js";

/**
 * Reference data for the DS3 console views. Figures and copy are lifted verbatim
 * from the design handoff (design_handoff_web_app_ui/prototypes/app). This is a
 * static, typed fixture module so a later pass can swap in live-API data without
 * touching the views.
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

export type PullRequest = {
  repo: string;
  number: number;
  title: string;
  status: Status;
  additions: number;
  deletions: number;
  files: number;
  checks: "passing" | "failing" | "running";
  time: string;
};

export type PrTab = "all" | "review" | "failing" | "merged";

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

export const PR_TABS: { id: PrTab; label: string; count: number }[] = [
  { id: "all", label: "All", count: 42 },
  { id: "review", label: "Needs review", count: 31 },
  { id: "failing", label: "Failing", count: 2 },
  { id: "merged", label: "Merged", count: 9 },
];

export const PULL_REQUESTS: PullRequest[] = [
  {
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
  return PULL_REQUESTS.find((pr) => String(pr.number) === id);
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

export type CheckRow = { name: string; state: string };

export const PR_DETAIL_CHECKS: CheckRow[] = [
  { name: "unit", state: "passing" },
  { name: "integration", state: "passing" },
  { name: "typecheck", state: "passing" },
  { name: "lint", state: "passing" },
];
