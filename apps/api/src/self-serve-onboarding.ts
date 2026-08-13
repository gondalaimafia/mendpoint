/**
 * Self-serve guided onboarding status (S1.3).
 *
 * A tenant-scoped, flag-gated read that powers the guided first-run flow
 * (connect -> first impact scan -> first reviewable PR) so a customer can
 * complete setup with no FDE and no support ticket. It never mutates: every
 * step's done/next/blocked state is DERIVED from the caller's own tenant data
 * (its tenant row, connected repositories, monitored providers, scan jobs, and
 * migration PRs) so a step is "done" because the data says so, never because a
 * flag was hardcoded true.
 *
 * The whole route is inert (404) unless the self-serve stack is on
 * (MENDPOINT_SELF_SERVE_SIGNUP + _CONNECT + _WARDEN), so default behavior stays
 * byte-identical and the existing operator /install page is untouched.
 */
import {
  getTenant,
  listConnectedRepositories,
  listJobs,
  listPrs,
  listTenantMonitoredProviders,
  type AppDb,
} from "@mendpoint/db";
import { Hono, type Context } from "hono";
import type { ApiEnv } from "./auth.js";
import { selfServeConnectEnabled } from "./repository-connect.js";
import { selfServeWardenEnabled } from "./self-serve-scan.js";
import { selfServeSignupEnabled } from "./self-serve-signup.js";

/** The self-serve scan trigger keys every job it enqueues with this prefix. */
const SCAN_JOB_PREFIX = "scan-job-";

/** Migration PR states a customer can actually open and review. */
const REVIEWABLE_PR_STATUSES = new Set(["open", "low_confidence", "draft"]);

/**
 * The guided onboarding surface is only live when the full self-serve stack is
 * on. A single helper keeps the three foundation flags in lock-step, so a
 * partial rollout never strands a customer on a step whose action route 404s.
 */
export function selfServeOnboardingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    selfServeSignupEnabled(env) &&
    selfServeConnectEnabled(env) &&
    selfServeWardenEnabled(env)
  );
}

export type OnboardingStepId = "workspace" | "connect" | "spec" | "scan" | "review";
export type OnboardingStepState = "done" | "next" | "blocked";
export type OnboardingActionKind = "none" | "connect" | "scan" | "link" | "coming_next";

export type OnboardingStep = Readonly<{
  id: OnboardingStepId;
  title: string;
  /** What this step is. */
  summary: string;
  /** Why it matters to the customer. */
  why: string;
  state: OnboardingStepState;
  /** Live status line derived from the tenant's own data. */
  detail: string;
  /** When blocked, an actionable fix (never a raw API error string). */
  blockedReason: string | null;
  action: Readonly<{ kind: OnboardingActionKind; label: string; href: string | null }>;
  /** Small facts the UI links to (job id, PR id, status), all tenant-scoped. */
  meta: Readonly<Record<string, string>> | null;
}>;

export type OnboardingStatus = Readonly<{
  tenantId: string;
  workspaceName: string;
  plan: string;
  completedSteps: number;
  totalSteps: number;
  steps: readonly OnboardingStep[];
}>;

type StepPlan = Readonly<{
  id: OnboardingStepId;
  title: string;
  summary: string;
  why: string;
  done: boolean;
  detail: string;
  action: OnboardingStep["action"];
  meta: OnboardingStep["meta"];
}>;

/**
 * Derive the guided onboarding status for one tenant from real tenant-scoped
 * reads. Pure and side-effect free: callers pass the authenticated tenant id and
 * every query is filtered to it, so one tenant can never observe another's
 * connect / provider / scan / PR state.
 */
export function computeOnboardingStatus(db: AppDb, tenantId: string): OnboardingStatus {
  const tenant = getTenant(db, tenantId);
  const repositories = listConnectedRepositories(db, tenantId);
  const providers = listTenantMonitoredProviders(db, tenantId);
  const scanJob = listJobs(db, 200, tenantId).find((job) => job.id.startsWith(SCAN_JOB_PREFIX));
  const reviewablePr = listPrs(db, tenantId).find((pr) => REVIEWABLE_PR_STATUSES.has(pr.status));

  const connectedRepo = repositories[0];
  const provider = providers[0];

  const plans: StepPlan[] = [
    {
      id: "workspace",
      title: "Create your workspace",
      summary: "Your tenant is the isolation boundary every repository, spec, and run lives inside.",
      why: "Everything below is scoped to this workspace, so nobody else can see your code or changes.",
      done: Boolean(tenant),
      detail: tenant
        ? `Workspace ${tenant.name} is on the ${tenant.plan} plan.`
        : "No workspace found for this identity yet.",
      action: tenant
        ? { kind: "none", label: "", href: null }
        : { kind: "link", label: "Create workspace", href: "/signup" },
      meta: tenant ? { plan: tenant.plan } : null,
    },
    {
      id: "connect",
      title: "Connect a repository",
      summary: "Link the repository you want Mendpoint to watch and open pull requests against.",
      why: "Connecting clones a scoped checkout so scans and fixes run against your real code.",
      done: repositories.length > 0,
      detail:
        repositories.length > 0
          ? `Connected ${repositories.length} ${repositories.length === 1 ? "repository" : "repositories"}${
              connectedRepo ? ` (${connectedRepo.owner}/${connectedRepo.name})` : ""
            }.`
          : "No repository connected yet.",
      action:
        repositories.length > 0
          ? { kind: "link", label: "Connect another repository", href: "/consumer" }
          : { kind: "connect", label: "Connect repository", href: null },
      meta: connectedRepo
        ? { repository: `${connectedRepo.owner}/${connectedRepo.name}`, status: connectedRepo.status }
        : null,
    },
    {
      id: "spec",
      title: "Add an API spec",
      summary: "Point Mendpoint at the provider API your repository depends on.",
      why: "A monitored provider is what turns an upstream breaking change into an impact scan for you.",
      done: providers.length > 0,
      detail:
        providers.length > 0
          ? `Monitoring ${providers.length} ${providers.length === 1 ? "provider" : "providers"}${
              provider ? ` (${provider.providerName})` : ""
            }.`
          : "No monitored provider yet. Auto-detect an API on your connected repository to add one.",
      // Tenant-scoped self-serve spec publishing (S1.1) is not in this branch yet;
      // until it lands, auto-detect on the connected repository is how a provider
      // gets monitored, so we route there and mark the direct-publish path as next.
      action:
        providers.length > 0
          ? { kind: "link", label: "View monitored providers", href: "/consumer" }
          : { kind: "coming_next", label: "Auto-detect an API", href: "/consumer" },
      meta: provider ? { provider: provider.providerName } : null,
    },
    {
      id: "scan",
      title: "Run the first scan",
      summary: "Kick off an impact scan across your connected repositories for the latest provider change.",
      why: "The scan finds exactly where the change breaks your code and drafts the fix.",
      done: Boolean(scanJob),
      detail: scanJob
        ? `Scan ${scanJob.id} is ${scanJob.status}.`
        : "No scan has run yet.",
      action: scanJob
        ? { kind: "link", label: "View runs", href: "/jobs" }
        : { kind: "scan", label: "Run first scan", href: null },
      meta: scanJob ? { jobId: scanJob.id, status: scanJob.status } : null,
    },
    {
      id: "review",
      title: "Review the first pull request",
      summary: "Open the pull request Mendpoint drafted and approve, request changes, or reject it.",
      why: "You stay in control: nothing merges until you review the proposed fix.",
      done: Boolean(reviewablePr),
      detail: reviewablePr
        ? `Pull request "${reviewablePr.title}" is ready for review.`
        : "No reviewable pull request yet. It appears here once the scan drafts a fix.",
      action: reviewablePr
        ? { kind: "link", label: "Review pull request", href: `/consumer/prs/${reviewablePr.id}` }
        : { kind: "none", label: "", href: null },
      meta: reviewablePr
        ? { prId: reviewablePr.id, status: reviewablePr.status, risk: reviewablePr.risk }
        : null,
    },
  ];

  // The first not-done step is the actionable "next"; every later not-done step
  // is "blocked" until it is reached, with a fix that names the step to finish.
  const firstIncomplete = plans.findIndex((plan) => !plan.done);
  const nextTitle = firstIncomplete >= 0 ? plans[firstIncomplete]!.title : null;

  const steps: OnboardingStep[] = plans.map((plan, index) => {
    let state: OnboardingStepState;
    let blockedReason: string | null = null;
    if (plan.done) {
      state = "done";
    } else if (index === firstIncomplete) {
      state = "next";
    } else {
      state = "blocked";
      blockedReason = nextTitle
        ? `Finish "${nextTitle}" first, then this step unlocks.`
        : "Finish the previous step first, then this step unlocks.";
    }
    return {
      id: plan.id,
      title: plan.title,
      summary: plan.summary,
      why: plan.why,
      state,
      detail: plan.detail,
      blockedReason,
      // A blocked step never invites the action directly; it points at the fix.
      action: state === "blocked" ? { kind: "none", label: "", href: null } : plan.action,
      meta: plan.meta,
    };
  });

  return {
    tenantId,
    workspaceName: tenant?.name ?? "",
    plan: tenant?.plan ?? "free",
    completedSteps: plans.filter((plan) => plan.done).length,
    totalSteps: plans.length,
    steps,
  };
}

export type SelfServeOnboardingRoutesOptions = Readonly<{
  db: AppDb;
  enabled: boolean;
}>;

function onboardingTenantId(c: Context<ApiEnv>): string {
  const principal = c.get("principal");
  if (!principal) throw new Error("authenticated_principal_required");
  // A blank tenantId must never reach a tenant-scoped query where a fail-open
  // branch could drop the filter and read across tenants. Fail closed instead.
  if (principal.tenantId.trim() === "") throw new Error("tenant_scope_required");
  return principal.tenantId;
}

/**
 * Self-serve onboarding status route. Mounted always but inert (404) unless the
 * full self-serve stack is on. Read-only: GET returns the caller's own guided
 * onboarding status, derived from that tenant's data.
 */
export function createSelfServeOnboardingRoutes(
  options: SelfServeOnboardingRoutesOptions,
): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  if (!options.enabled) {
    routes.all("*", (c) => c.json({ error: "not_found" }, 404));
    return routes;
  }

  routes.get("/", (c) => {
    let tenantId: string;
    try {
      tenantId = onboardingTenantId(c);
    } catch (error) {
      const code = error instanceof Error ? error.message : "authenticated_principal_required";
      return c.json({ error: code }, 401);
    }
    return c.json(computeOnboardingStatus(options.db, tenantId));
  });

  return routes;
}
