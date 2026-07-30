/**
 * Phase B instrumentation — product metrics from migration_prs + audit_events.
 */
import type { AppDb } from "./index.js";

export type ProductMetrics = {
  prsOpened: number;
  prsMerged: number;
  prsClosed: number;
  prsOpen: number;
  prsLowConfidence: number;
  mergeRate: number | null;
  /** closed without merge / (merged+closed) — proxy for false-positive / rejected PRs */
  closeWithoutMergeRate: number | null;
  /** median hours open→resolved for merged PRs */
  medianTimeToMergeHours: number | null;
  realGithubPrs: number;
  mockOrLocalPrs: number;
  auditEvents: number;
  recent: Array<{
    id: string;
    title: string;
    status: string;
    risk: string;
    githubPrUrl: string | null;
    createdAt: string;
    resolvedAt: string | null;
  }>;
  computedAt: string;
};

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function computeProductMetrics(db: AppDb, tenantId?: string): ProductMetrics {
  const prs = db.raw
    .prepare(
      `SELECT pr.id, pr.title, pr.status, pr.risk, pr.github_pr_url,
              pr.github_pr_number, pr.created_at, pr.resolved_at, pr.branch_name
       FROM migration_prs pr
       ${tenantId ? "JOIN" : "LEFT JOIN"} consumers c ON c.id = pr.consumer_id
       ${tenantId ? "WHERE c.tenant_id = ?" : ""}
       ORDER BY pr.created_at DESC`,
    )
    .all(...(tenantId ? [tenantId] : [])) as Array<{
    id: string;
    title: string;
    status: string;
    risk: string;
    github_pr_url: string | null;
    github_pr_number: number | null;
    created_at: string;
    resolved_at: string | null;
    branch_name: string;
  }>;

  const auditCount = (
    db.raw
      .prepare(
        `SELECT COUNT(*) as c FROM audit_events
         ${tenantId ? "WHERE tenant_id = ?" : ""}`,
      )
      .get(...(tenantId ? [tenantId] : [])) as { c: number }
  ).c;

  let merged = 0;
  let closed = 0;
  let open = 0;
  let low = 0;
  let real = 0;
  let mock = 0;
  const ttm: number[] = [];

  for (const p of prs) {
    if (p.status === "merged") {
      merged++;
      if (p.resolved_at && p.created_at) {
        const ms = Date.parse(p.resolved_at) - Date.parse(p.created_at);
        if (Number.isFinite(ms) && ms >= 0) ttm.push(ms / 36e5);
      }
    } else if (p.status === "closed") closed++;
    else if (p.status === "open" || p.status === "draft") open++;
    else if (p.status === "low_confidence") low++;

    if (p.github_pr_url && !p.github_pr_url.includes("example-org") && p.github_pr_number) {
      // real if looks like github.com and not purely mock placeholder without number issues
      if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(p.github_pr_url)) {
        // still count mock-github style URLs as mock if from mock delivery pattern — mock also uses github.com URLs
        // Phase A real PRs are fine; mock uses github.com too. Use audit for real:
        real++;
      }
    } else {
      mock++;
    }
  }

  // Refine real vs mock using audit
  const realAudit = (
    db.raw
      .prepare(
        `SELECT COUNT(*) as c FROM audit_events
         WHERE action = 'pr.opened.real'
         ${tenantId ? "AND tenant_id = ?" : ""}`,
      )
      .get(...(tenantId ? [tenantId] : [])) as { c: number }
  ).c;

  const decided = merged + closed;
  return {
    prsOpened: prs.length,
    prsMerged: merged,
    prsClosed: closed,
    prsOpen: open,
    prsLowConfidence: low,
    mergeRate: decided ? merged / decided : null,
    closeWithoutMergeRate: decided ? closed / decided : null,
    medianTimeToMergeHours: median(ttm),
    realGithubPrs: realAudit || real,
    mockOrLocalPrs: Math.max(0, prs.length - (realAudit || 0)),
    auditEvents: auditCount,
    recent: prs.slice(0, 15).map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      risk: p.risk,
      githubPrUrl: p.github_pr_url,
      createdAt: p.created_at,
      resolvedAt: p.resolved_at,
    })),
    computedAt: new Date().toISOString(),
  };
}
