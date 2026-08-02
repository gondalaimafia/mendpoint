import { getPr, recordAudit, type AppDb } from "@mendpoint/db";
import { can, type Permission, type Principal } from "@mendpoint/platform";
import { newId, nowIso } from "@mendpoint/shared";
import { Hono, type Context } from "hono";
import type { ApiEnv } from "./auth.js";
import {
  HUMAN_REVIEW_DECISIONS,
  assignMigrationPrReviewers,
  commentOnMigrationPrReview,
  listMigrationPrReviews,
  submitMigrationPrReview,
  type HumanReviewDecision,
} from "./reviews.js";

type ReviewRouteDependencies = {
  db: AppDb;
  createId?: () => string;
  now?: () => string;
};

function authorized(c: Context<ApiEnv>, permission: Permission): Principal | Response {
  const principal = c.get("principal");
  if (!principal) {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (!can(principal, permission)) {
    return c.json({ error: "rbac_denied", need: permission, role: principal.role }, 403);
  }
  return principal;
}

function reviewError(c: Context<ApiEnv>, error: unknown): Response {
  const message = error instanceof Error ? error.message : "review_failed";
  if (
    message === "human_review_identity_required" ||
    message === "review_attributed_identity_required"
  ) {
    return c.json({ error: message }, 403);
  }
  if (
    message === "review_candidate_not_found" ||
    message === "domain_event_idempotency_conflict"
  ) {
    return c.json({ error: message }, 409);
  }
  if (
    message === "review_decision_invalid" ||
    message === "review_rationale_invalid" ||
    message === "review_waiver_expiry_invalid" ||
    message === "review_waiver_expiry_unexpected" ||
    message === "review_assignment_invalid" ||
    message === "review_comment_id_invalid" ||
    message === "review_comment_invalid"
  ) {
    return c.json({ error: message }, 400);
  }
  throw error instanceof Error ? error : new Error(message);
}

function auditReviewMutation(
  c: Context<ApiEnv>,
  db: AppDb,
  input: {
    action: string;
    prId: string;
    metadata: Record<string, unknown>;
  },
) {
  const principal = c.get("principal");
  if (!principal) throw new Error("authenticated_principal_required");
  recordAudit(db, {
    tenantId: principal.tenantId,
    principalId: principal.id,
    apiKeyId: c.get("apiKeyId") ?? null,
    requestId: c.get("requestId") ?? null,
    actor: principal.id,
    action: input.action,
    resourceType: "migration_pr",
    resourceId: input.prId,
    metadata: input.metadata,
  });
}

export function createMigrationPrReviewRoutes(deps: ReviewRouteDependencies) {
  const routes = new Hono<ApiEnv>();
  const createId = deps.createId ?? newId;
  const now = deps.now ?? nowIso;

  routes.get("/:id/reviews", (c) => {
    const principal = authorized(c, "graph:read");
    if (principal instanceof Response) return principal;
    const pr = getPr(deps.db, c.req.param("id"), principal.tenantId);
    if (!pr) return c.json({ error: "not found" }, 404);
    return c.json({ reviews: listMigrationPrReviews(deps.db, principal.tenantId, pr.id) });
  });

  routes.post("/:id/reviews", async (c) => {
    const principal = authorized(c, "pr:write");
    if (principal instanceof Response) return principal;
    const pr = getPr(deps.db, c.req.param("id"), principal.tenantId);
    if (!pr) return c.json({ error: "not found" }, 404);
    const body = await c.req
      .json<{ decision?: unknown; rationale?: unknown; waiverExpiresAt?: unknown }>()
      .catch(() => ({} as { decision?: unknown; rationale?: unknown; waiverExpiresAt?: unknown }));
    if (
      typeof body.decision !== "string" ||
      !HUMAN_REVIEW_DECISIONS.includes(body.decision as HumanReviewDecision)
    ) {
      return c.json({ error: "review_decision_invalid" }, 400);
    }
    if (
      body.waiverExpiresAt !== undefined &&
      body.waiverExpiresAt !== null &&
      typeof body.waiverExpiresAt !== "string"
    ) {
      return c.json({ error: "review_waiver_expiry_invalid" }, 400);
    }
    const ownsTransaction = !deps.db.raw.isTransaction;
    if (ownsTransaction) deps.db.raw.exec("BEGIN IMMEDIATE");
    try {
      const review = submitMigrationPrReview(deps.db, {
        tenantId: principal.tenantId,
        prId: pr.id,
        authenticatedPrincipalId: principal.id,
        decision: body.decision as HumanReviewDecision,
        rationale: typeof body.rationale === "string" ? body.rationale : "",
        waiverExpiresAt: body.waiverExpiresAt as string | null | undefined,
        reviewId: createId(),
        eventId: createId(),
        correlationId: c.get("requestId"),
        createdAt: now(),
      });
      auditReviewMutation(c, deps.db, {
        action: `migration_pr.review.${review.decision}`,
        prId: pr.id,
        metadata: {
          reviewId: review.id,
          candidateArtifactId: review.candidateArtifactId,
          waiverExpiresAt: review.waiverExpiresAt,
          supersedesId: review.supersedesId,
        },
      });
      if (ownsTransaction) deps.db.raw.exec("COMMIT");
      return c.json(review, 201);
    } catch (error) {
      if (ownsTransaction && deps.db.raw.isTransaction) {
        deps.db.raw.exec("ROLLBACK");
      }
      return reviewError(c, error);
    }
  });

  routes.post("/:id/reviewers", async (c) => {
    const principal = authorized(c, "tenant:admin");
    if (principal instanceof Response) return principal;
    const pr = getPr(deps.db, c.req.param("id"), principal.tenantId);
    if (!pr) return c.json({ error: "not found" }, 404);
    const body = await c.req
      .json<{ reviewerPrincipalIds?: unknown; requiredReviewerCount?: unknown }>()
      .catch(() => ({} as { reviewerPrincipalIds?: unknown; requiredReviewerCount?: unknown }));
    if (
      !Array.isArray(body.reviewerPrincipalIds) ||
      !body.reviewerPrincipalIds.every((value) => typeof value === "string") ||
      typeof body.requiredReviewerCount !== "number"
    ) {
      return c.json({ error: "review_assignment_invalid" }, 400);
    }
    try {
      const assignment = assignMigrationPrReviewers(deps.db, {
        tenantId: principal.tenantId,
        prId: pr.id,
        authenticatedPrincipalId: principal.id,
        reviewerPrincipalIds: body.reviewerPrincipalIds,
        requiredReviewerCount: body.requiredReviewerCount,
        eventId: createId(),
        correlationId: c.get("requestId"),
        createdAt: now(),
      });
      auditReviewMutation(c, deps.db, {
        action: "migration_pr.reviewers.assigned",
        prId: pr.id,
        metadata: assignment,
      });
      return c.json(assignment, 201);
    } catch (error) {
      return reviewError(c, error);
    }
  });

  routes.post("/:id/review-comments", async (c) => {
    const principal = authorized(c, "pr:write");
    if (principal instanceof Response) return principal;
    const pr = getPr(deps.db, c.req.param("id"), principal.tenantId);
    if (!pr) return c.json({ error: "not found" }, 404);
    const body = await c.req
      .json<{ commentId?: unknown; body?: unknown; causationId?: unknown }>()
      .catch(() => ({} as { commentId?: unknown; body?: unknown; causationId?: unknown }));
    if (
      typeof body.commentId !== "string" ||
      typeof body.body !== "string" ||
      (body.causationId !== undefined &&
        body.causationId !== null &&
        typeof body.causationId !== "string")
    ) {
      return c.json({ error: "review_comment_invalid" }, 400);
    }
    try {
      const comment = commentOnMigrationPrReview(deps.db, {
        tenantId: principal.tenantId,
        prId: pr.id,
        authenticatedPrincipalId: principal.id,
        commentId: body.commentId,
        body: body.body,
        causationId: body.causationId as string | null | undefined,
        eventId: createId(),
        correlationId: c.get("requestId"),
        createdAt: now(),
      });
      auditReviewMutation(c, deps.db, {
        action: "migration_pr.review.comment",
        prId: pr.id,
        metadata: {
          commentId: comment.commentId,
          candidateArtifactId: comment.candidateArtifactId,
          bodySha256: comment.bodySha256,
          eventId: comment.eventId,
        },
      });
      return c.json(comment, 201);
    } catch (error) {
      return reviewError(c, error);
    }
  });

  return routes;
}
