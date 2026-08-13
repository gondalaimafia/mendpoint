import type { DiffHunk, Status } from "../ds/index.js";

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
};

export type PrTab = "all" | "review" | "failing" | "merged";

export type CheckRow = { name: string; state: string };

/** Everything `/prs/[id]` (PrDetailView) renders, mapped from a live PR. */
export type PrDetailData = {
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

// ── Run console (/runs) ──────────────────────────────────────────────────────

/** One row in the run list, mapped from the live `/self-serve/runs` feed. */
export type RunSummary = {
  id: string;
  type: string;
  status: Status;
  statusLabel: string;
  target: string | null;
  goal: string | null;
  triggeredBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  timeLabel: string;
  durationLabel: string | null;
  canCancel: boolean;
  cancelReason: string | null;
  canRetry: boolean;
  retryReason: string | null;
};

export type RunPlanStep = { title: string; action: string; status: string };

/** Everything `/runs/[id]` (RunDetailView) renders, mapped from a live run. */
export type RunDetailData = {
  run: RunSummary;
  plan: { title: string; goal: string; steps: RunPlanStep[] } | null;
  log: string | null;
  verification: CheckRow[];
  changedPaths: string[];
  diffs: Array<{
    path: string;
    hunks: DiffHunk[];
    additions: number;
    deletions: number;
  }>;
  prs: Array<{ number: number | null; url: string | null; status: string }>;
  reviewHref: string | null;
};

export const RUN_TABS: { id: RunTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "failed", label: "Failed" },
  { id: "done", label: "Done" },
];

export type RunTab = "all" | "active" | "failed" | "done";

/** Client-side status filter for the run list; mirrors the DS `Status` mapping. */
export function filterRuns(runs: RunSummary[], tab: RunTab): RunSummary[] {
  switch (tab) {
    case "active":
      return runs.filter((r) => r.status === "pending");
    case "failed":
      return runs.filter((r) => r.status === "failing");
    case "done":
      return runs.filter((r) => r.status === "merged" || r.status === "draft");
    case "all":
    default:
      return runs;
  }
}

export const SAMPLE_RUNS: RunSummary[] = [
  {
    id: "warden-job-a1",
    type: "warden.run",
    status: "failing",
    statusLabel: "failed",
    target: "acme/payments-sdk",
    goal: "Fix charge()",
    triggeredBy: "human:owner-a@example.com",
    createdAt: "2026-08-13T12:00:00.000Z",
    startedAt: "2026-08-13T12:00:01.000Z",
    finishedAt: "2026-08-13T12:03:00.000Z",
    timeLabel: "3m ago",
    durationLabel: "2m 59s",
    canCancel: true,
    cancelReason: null,
    canRetry: true,
    retryReason: null,
  },
  {
    id: "scan-job-a1",
    type: "pipeline.fanout",
    status: "pending",
    statusLabel: "pending",
    target: "alpha",
    goal: null,
    triggeredBy: null,
    createdAt: "2026-08-13T12:01:00.000Z",
    startedAt: null,
    finishedAt: null,
    timeLabel: "2m ago",
    durationLabel: null,
    canCancel: true,
    cancelReason: null,
    canRetry: false,
    retryReason: "Run is still active",
  },
];

export const SAMPLE_RUN_DETAIL: RunDetailData = {
  run: SAMPLE_RUNS[0]!,
  plan: {
    title: "Migrate charge()",
    goal: "Fix charge()",
    steps: [
      { title: "Locate call sites", action: "search", status: "done" },
      { title: "Rewrite", action: "edit", status: "done" },
    ],
  },
  log: "### Trajectory warden-run-a1\n- edit src/api/client.ts",
  verification: [
    { name: "npm test", state: "passed" },
    { name: "review", state: "approve" },
  ],
  changedPaths: ["src/api/client.ts"],
  diffs: [
    {
      path: "src/api/client.ts",
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: "@@ -1,2 +1,2 @@",
          lines: [
            { type: "del", line: 1, text: "await pay.charge(total);" },
            { type: "add", line: 1, text: "await pay.charges.create({ amount: total });" },
          ],
        },
      ],
    },
  ],
  prs: [
    { number: 4821, url: "https://github.com/acme/payments-sdk/pull/4821", status: "delivered" },
  ],
  reviewHref: "/prs/pr-a1",
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
  repo: "acme/payments-sdk",
  title: "Migrate charge() → charges.create()",
  number: 4821,
  status: "open",
  githubUrl: "https://github.com/acme/payments-sdk/pull/4821",
  alert: {
    title: "Breaking change · POST /v1/charges",
    body: "charge() was removed in v3.0.0. Transformer rewrote 6 call sites and left inline notes where behavior changed.",
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
