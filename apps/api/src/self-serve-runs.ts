/**
 * Self-serve run console (S3).
 *
 * A tenant-scoped, flag-gated read surface that unifies a customer's agent work
 * into one "run" model so they can monitor, review, and (via the existing
 * controls) pause/retry it themselves. It REUSES the data the platform already
 * records — queue jobs (`jobs`), Warden agent runs (`agent_runs`), candidate
 * deliveries, and the local plan/trajectory artifacts — and never invents any:
 * a datum a given run type does not have comes back as null so the console can
 * render an honest empty state.
 *
 * The route reads nothing cross-tenant (every DB accessor is passed the caller's
 * tenantId) and mutates nothing: pause/cancel and retry stay on the existing
 * `/jobs/:id/cancel` and `/jobs/:id/retry` endpoints, and start stays on
 * `/self-serve/scan`. The whole route is inert (404) unless
 * MENDPOINT_SELF_SERVE_WARDEN=1, so default behavior stays byte-identical.
 */
import {
  agentRunToApi,
  getAgentRunByJobId,
  getConsumer,
  getJob,
  getWardenCandidateDeliveryByRun,
  listJobs,
  listPrs,
  type AppDb,
  type JobRow,
} from "@mendpoint/db";
import { getPlan, viewTrajectory } from "@mendpoint/harness";
import { Hono, type Context } from "hono";
import type { ApiEnv } from "./auth.js";

/** A job status is cancellable exactly when `cancelJob` would change a row. */
const CANCELLABLE = new Set(["pending", "dead_letter", "failed"]);
/** A job status is retriable exactly when `retryJob` would change a row. */
const RETRIABLE = new Set(["dead_letter", "failed", "cancelled"]);

export type SelfServeRunsRoutesOptions = Readonly<{
  db: AppDb;
  enabled: boolean;
  /** Base dir the plan/trajectory artifacts live under; defaults to process.cwd(). */
  cwd?: string;
}>;

function runsTenantId(c: Context<ApiEnv>): string {
  const principal = c.get("principal");
  if (!principal) throw new Error("authenticated_principal_required");
  // A blank tenantId must never reach a tenant-scoped query where a fail-open
  // branch could drop the filter and read across tenants. Fail closed instead.
  if (principal.tenantId.trim() === "") throw new Error("tenant_scope_required");
  return principal.tenantId;
}

function cancelReasonFor(status: string): string | null {
  if (CANCELLABLE.has(status)) return null;
  if (status === "running") return "Run is in progress and cannot be cancelled";
  if (status === "cancelled") return "Run is already cancelled";
  if (status === "done" || status === "succeeded") return "Run already finished";
  return `Run is ${status} and cannot be cancelled`;
}

function retryReasonFor(status: string): string | null {
  if (RETRIABLE.has(status)) return null;
  if (status === "pending" || status === "running") return "Run is still active";
  if (status === "done" || status === "succeeded") return "Run completed successfully";
  return `Run is ${status} and cannot be retried`;
}

function parsePayload(job: JobRow): { providerSlug?: string; consumerId?: string } {
  try {
    const parsed = JSON.parse(job.payload_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const value = parsed as Record<string, unknown>;
      return {
        providerSlug: typeof value.providerSlug === "string" ? value.providerSlug : undefined,
        consumerId: typeof value.consumerId === "string" ? value.consumerId : undefined,
      };
    }
  } catch {
    // A malformed payload is not fatal to listing the run; leave target unresolved.
  }
  return {};
}

/**
 * Resolve a human "target" for a run strictly from tenant-owned data: the
 * consumer repo when the payload names one, otherwise the provider slug.
 */
function resolveTarget(
  db: AppDb,
  job: JobRow,
  tenantId: string,
): { target: string | null; providerSlug: string | null } {
  const { providerSlug, consumerId } = parsePayload(job);
  if (consumerId) {
    const consumer = getConsumer(db, consumerId, tenantId);
    if (consumer) {
      return {
        target: `${consumer.github_owner}/${consumer.github_repo}`,
        providerSlug: providerSlug ?? null,
      };
    }
  }
  return { target: providerSlug ?? null, providerSlug: providerSlug ?? null };
}

type RunSummary = ReturnType<typeof toSummary>;

function toSummary(db: AppDb, job: JobRow, tenantId: string) {
  const agentRun = getAgentRunByJobId(db, job.id, tenantId);
  const { target, providerSlug } = resolveTarget(db, job, tenantId);
  // Triggering user is only recorded on the run when a Warden candidate delivery
  // captured the requesting principal; scans record none, so we return null and
  // let the console show an honest "not recorded" rather than inventing an actor.
  const delivery = agentRun
    ? getWardenCandidateDeliveryByRun(db, tenantId, agentRun.id)
    : undefined;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    errorCode: job.error_code ?? (job.error ? "job_failed" : null),
    target,
    providerSlug,
    goal: agentRun?.goal ?? null,
    triggeredBy: delivery?.requesterPrincipalId ?? null,
    agentRunId: agentRun?.id ?? null,
    canCancel: CANCELLABLE.has(job.status),
    cancelReason: cancelReasonFor(job.status),
    canRetry: RETRIABLE.has(job.status),
    retryReason: retryReasonFor(job.status),
  };
}

export function createSelfServeRunsRoutes(
  options: SelfServeRunsRoutesOptions,
): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  if (!options.enabled) {
    routes.all("*", (c) => c.json({ error: "not_found" }, 404));
    return routes;
  }
  const { db } = options;
  const cwd = options.cwd ?? process.cwd();

  routes.get("/", (c) => {
    let tenantId: string;
    try {
      tenantId = runsTenantId(c);
    } catch (error) {
      const code = error instanceof Error ? error.message : "authenticated_principal_required";
      return c.json({ error: code }, 401);
    }
    const runs = listJobs(db, 50, tenantId).map((job) => toSummary(db, job, tenantId));
    return c.json({ runs });
  });

  routes.get("/:id", (c) => {
    let tenantId: string;
    try {
      tenantId = runsTenantId(c);
    } catch (error) {
      const code = error instanceof Error ? error.message : "authenticated_principal_required";
      return c.json({ error: code }, 401);
    }

    const job = getJob(db, c.req.param("id"), tenantId);
    if (!job) return c.json({ error: "not_found" }, 404);

    const run: RunSummary = toSummary(db, job, tenantId);
    const artifactKey = run.agentRunId ?? job.id;

    // Plan — best effort from the local HITL artifact for this run. Absent for a
    // run type (a scan) that never produced one → null → honest empty state.
    let plan:
      | { title: string; goal: string; steps: Array<{ title: string; action: string; status: string }> }
      | null = null;
    try {
      const loaded = getPlan(cwd, artifactKey);
      plan = {
        title: loaded.title,
        goal: loaded.goal,
        steps: loaded.steps.map((s) => ({ title: s.title, action: s.action, status: s.status })),
      };
    } catch {
      plan = null;
    }

    // Execution log — the trajectory viewer returns a "run not found" sentinel
    // when nothing was recorded; treat that as no log rather than rendering it.
    const rawLog = viewTrajectory(cwd, artifactKey);
    const log = rawLog.startsWith(`run not found: ${artifactKey}`) ? null : rawLog;

    // Warden enrichment (verification, changed files, review handoff, PR).
    const agentRunRow = run.agentRunId ? getAgentRunByJobId(db, job.id, tenantId) : undefined;
    const agentRun = agentRunRow ? agentRunToApi(agentRunRow) : null;

    const verification: Array<{ name: string; state: string }> = [];
    if (agentRun?.result?.verifier) {
      verification.push({
        name: agentRun.result.verifier.command ?? "verify",
        state: agentRun.result.verifier.status ?? "unknown",
      });
    }
    if (agentRun?.result?.review?.decision) {
      verification.push({ name: "review", state: agentRun.result.review.decision });
    }

    const changedPaths =
      agentRun?.result?.candidate?.changedPaths?.length
        ? agentRun.result.candidate.changedPaths
        : (agentRun?.filesChanged ?? []);

    // Resulting PR(s). A Warden run records a candidate delivery (draft PR by
    // number/url/status). We attach the real unified patch ONLY when a migration
    // PR of the same tenant matches that draft PR number exactly, so DiffView
    // renders real code and never a fabricated diff.
    const prs: Array<{ number: number | null; url: string | null; status: string; patchUnified: string | null }> = [];
    const review: { href: string | null; kind: "warden" | "pr" | null } = {
      href: run.agentRunId ? `/agent/${run.agentRunId}` : null,
      kind: run.agentRunId ? "warden" : null,
    };
    if (run.agentRunId) {
      const delivery = getWardenCandidateDeliveryByRun(db, tenantId, run.agentRunId);
      if (delivery && (delivery.draftPrNumber != null || delivery.draftPrUrl)) {
        const matched =
          delivery.draftPrNumber != null
            ? listPrs(db, tenantId).find((pr) => pr.github_pr_number === delivery.draftPrNumber)
            : undefined;
        prs.push({
          number: delivery.draftPrNumber,
          url: delivery.draftPrUrl,
          status: delivery.status,
          patchUnified: matched?.patch_unified ?? null,
        });
        if (matched) {
          review.href = `/prs/${matched.id}`;
          review.kind = "pr";
        }
      }
    }

    return c.json({
      run,
      plan,
      log,
      verification,
      changedPaths,
      prs,
      review,
    });
  });

  return routes;
}
