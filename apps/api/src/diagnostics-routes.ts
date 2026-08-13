/**
 * S3 self-service diagnostics (read-only, tenant-scoped).
 *
 * GET / runs a set of LIVE preflight checks against the calling tenant's own
 * setup and reports pass/warn/fail for each, with the same actionable guidance
 * catalog the rest of the console uses (`explainError`). Every check derives
 * from REAL state read through tenant-scoped `@mendpoint/db` readers, the
 * shared `scmOverview` connection/snapshot view, and the `@mendpoint/ops`
 * readiness probe. Nothing is mutated and nothing is hardcoded to pass.
 *
 * Consistent with other customer read routes: an authenticated principal is
 * required, results are scoped to that principal's tenant (each caller sees
 * only their own setup), and the response is `no-store`.
 */
import {
  getTenant,
  getUsageSummary,
  listAgentRuns,
  listTenantMonitoredProviders,
  type AppDb,
} from "@mendpoint/db";
import { explainError, nowIso, type ExplainedError } from "@mendpoint/shared";
import { readiness } from "@mendpoint/ops";
import { Hono } from "hono";
import type { ApiEnv } from "./auth.js";
import { scmOverview } from "./repository-connections.js";

export type DiagnosticStatus = "pass" | "warn" | "fail";
export type DiagnosticCategory =
  | "setup"
  | "authentication"
  | "integration"
  | "execution";

export type DiagnosticCheck = Readonly<{
  id: string;
  title: string;
  category: DiagnosticCategory;
  status: DiagnosticStatus;
  /** Human-readable, real-state summary of what this check observed. */
  detail: string;
  /** Actionable guidance when the check did not pass. */
  guidance: ExplainedError | null;
}>;

export type DiagnosticsReport = Readonly<{
  tenantId: string;
  generatedAt: string;
  status: "pass" | "attention" | "fail";
  summary: Readonly<{ pass: number; warn: number; fail: number }>;
  checks: readonly DiagnosticCheck[];
}>;

export type DiagnosticsRoutesOptions = Readonly<{
  db: AppDb;
  now?: () => string;
}>;

// Agent-run statuses that represent an execution failure worth surfacing (as
// opposed to normal terminal outcomes like candidate_approved / cancelled).
const RUN_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  "failed",
  "error",
  "budget_exceeded",
  "rate_limited",
  "request_timeout",
  "response_invalid",
  "response_too_large",
  "corrupt",
]);

const SHA_LIKE = /^[a-f0-9]{7,64}$/i;

// Sentinel used only to detect whether explainError produced its generic
// fallback (so we can prefer the on-point diagnostics guidance instead).
const GENERIC_TITLE = explainError("__diagnostics_unknown_probe__").title;

function check(
  id: string,
  title: string,
  category: DiagnosticCategory,
  status: DiagnosticStatus,
  detail: string,
  guidance: ExplainedError | null = null,
): DiagnosticCheck {
  return { id, title, category, status, detail, guidance };
}

export function buildTenantDiagnostics(
  db: AppDb,
  tenantId: string,
  now: string,
): DiagnosticsReport {
  const checks: DiagnosticCheck[] = [];

  // ── Authentication ─────────────────────────────────────────────────────
  const tenant = getTenant(db, tenantId);
  checks.push(
    check(
      "authentication",
      "Authentication",
      "authentication",
      "pass",
      `Request authenticated for workspace ${tenantId}.`,
    ),
  );

  // ── Setup: workspace exists ────────────────────────────────────────────
  if (tenant) {
    checks.push(
      check(
        "workspace",
        "Workspace",
        "setup",
        "pass",
        `Workspace "${tenant.name}" is active on the ${tenant.plan} plan.`,
      ),
    );
  } else {
    checks.push(
      check(
        "workspace",
        "Workspace",
        "setup",
        "fail",
        "No workspace record matches this authenticated tenant.",
        explainError("diagnostics_workspace_missing"),
      ),
    );
  }

  // ── Integration: repository connected ──────────────────────────────────
  const scm = scmOverview(db, tenantId);
  const activeConnections = scm.connections.filter(
    (connection) => !connection.revokedAt,
  );
  if (activeConnections.length > 0) {
    checks.push(
      check(
        "repository_connected",
        "Repository connection",
        "integration",
        "pass",
        `${activeConnections.length} active source-control connection${
          activeConnections.length === 1 ? "" : "s"
        }.`,
      ),
    );
  } else {
    checks.push(
      check(
        "repository_connected",
        "Repository connection",
        "integration",
        "fail",
        scm.connections.length > 0
          ? "Every source-control connection for this workspace has been revoked."
          : "No source-control connection exists for this workspace.",
        explainError("diagnostics_repository_not_connected"),
      ),
    );
  }

  // ── Setup: checkout materialized ───────────────────────────────────────
  const availableSnapshots = scm.repositories
    .flatMap((repository) => repository.snapshots)
    .filter((snapshot) => snapshot.available && SHA_LIKE.test(snapshot.exactCommit));
  if (availableSnapshots.length > 0) {
    checks.push(
      check(
        "checkout_materialized",
        "Repository checkout",
        "setup",
        "pass",
        `${availableSnapshots.length} materialized checkout snapshot${
          availableSnapshots.length === 1 ? "" : "s"
        } available.`,
      ),
    );
  } else {
    checks.push(
      check(
        "checkout_materialized",
        "Repository checkout",
        "setup",
        "fail",
        scm.repositories.length > 0
          ? "Connected repositories have no available checkout snapshot."
          : "No repository has been connected, so no checkout exists.",
        explainError("diagnostics_checkout_not_materialized"),
      ),
    );
  }

  // ── Integration: provider monitored ────────────────────────────────────
  const monitored = listTenantMonitoredProviders(db, tenantId);
  if (monitored.length > 0) {
    checks.push(
      check(
        "provider_monitored",
        "Provider monitoring",
        "integration",
        "pass",
        `Monitoring ${monitored.length} provider${
          monitored.length === 1 ? "" : "s"
        }: ${monitored.map((provider) => provider.providerSlug).join(", ")}.`,
      ),
    );
  } else {
    checks.push(
      check(
        "provider_monitored",
        "Provider monitoring",
        "integration",
        "warn",
        "No API provider is monitored by this workspace.",
        explainError("diagnostics_no_monitored_provider"),
      ),
    );
  }

  // ── Execution: model provider posture ──────────────────────────────────
  const egress = readiness().modelEgress;
  if (egress && egress.localOnly && !egress.localOnlySatisfied) {
    checks.push(
      check(
        "model_provider",
        "Model provider",
        "execution",
        "fail",
        "Local-only model egress is enforced but no permitted endpoint is configured.",
        explainError("diagnostics_model_provider_unconfigured"),
      ),
    );
  } else {
    checks.push(
      check(
        "model_provider",
        "Model provider",
        "execution",
        "pass",
        egress
          ? `Model egress mode is ${egress.mode}; endpoint ${
              egress.endpointConfigured ? "configured" : "using provider default"
            }.`
          : "Model egress posture is available.",
      ),
    );
  }

  // ── Execution: quota / entitlement ─────────────────────────────────────
  const usage = getUsageSummary(db, tenantId, now);
  if (!usage.entitlement) {
    checks.push(
      check(
        "quota_entitlement",
        "Usage entitlement",
        "execution",
        "fail",
        "No active plan or usage entitlement for this workspace.",
        explainError("usage_entitlement_required"),
      ),
    );
  } else if (
    usage.availableMcuMicros !== null &&
    usage.availableMcuMicros <= 0
  ) {
    checks.push(
      check(
        "quota_entitlement",
        "Usage entitlement",
        "execution",
        "warn",
        "The active entitlement has no remaining metered capacity this period.",
        explainError("usage_quota_exceeded"),
      ),
    );
  } else {
    checks.push(
      check(
        "quota_entitlement",
        "Usage entitlement",
        "execution",
        "pass",
        usage.availableMcuMicros !== null
          ? `${usage.availableMcuMicros} metered units remaining on the active entitlement.`
          : "An active entitlement is present.",
      ),
    );
  }

  // ── Execution: recent run failures ─────────────────────────────────────
  const runs = listAgentRuns(db, 20, tenantId);
  const failures = runs.filter((run) => RUN_FAILURE_STATUSES.has(run.status));
  if (failures.length === 0) {
    checks.push(
      check(
        "recent_runs",
        "Recent runs",
        "execution",
        "pass",
        runs.length > 0
          ? `No failures in the last ${runs.length} run${
              runs.length === 1 ? "" : "s"
            }.`
          : "No runs have been recorded yet.",
      ),
    );
  } else {
    const latestFailure = failures[0]!;
    const mostRecentRunFailed = runs[0]
      ? RUN_FAILURE_STATUSES.has(runs[0].status)
      : false;
    // Prefer the run's own explained error; if that status has no specific
    // guidance, fall back to the on-point recent-run guidance.
    const explainedRun = explainError(latestFailure.status);
    const guidance =
      explainedRun.title === GENERIC_TITLE
        ? explainError("diagnostics_recent_run_failed")
        : explainedRun;
    checks.push(
      check(
        "recent_runs",
        "Recent runs",
        "execution",
        mostRecentRunFailed ? "fail" : "warn",
        `${failures.length} recent run${
          failures.length === 1 ? "" : "s"
        } failed; latest failing run ${latestFailure.id} reported "${latestFailure.status}".`,
        guidance,
      ),
    );
  }

  const summary = {
    pass: checks.filter((item) => item.status === "pass").length,
    warn: checks.filter((item) => item.status === "warn").length,
    fail: checks.filter((item) => item.status === "fail").length,
  };
  const status: DiagnosticsReport["status"] =
    summary.fail > 0 ? "fail" : summary.warn > 0 ? "attention" : "pass";

  return { tenantId, generatedAt: now, status, summary, checks };
}

export function createDiagnosticsRoutes(
  options: DiagnosticsRoutesOptions,
): Hono<ApiEnv> {
  const { db } = options;
  const now = options.now ?? nowIso;
  const routes = new Hono<ApiEnv>({ strict: false });

  routes.get("/", (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
    // Fail closed on a blank tenant so a scoped read can never widen to all tenants.
    if (principal.tenantId.trim() === "") {
      return c.json({ error: "tenant_scope_required" }, 403);
    }
    const report = buildTenantDiagnostics(db, principal.tenantId, now());
    c.header("Cache-Control", "no-store");
    return c.json(report);
  });

  return routes;
}
