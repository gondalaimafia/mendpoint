import { createHash } from "node:crypto";
import {
  appendDomainEvent,
  getLatestCandidateArtifactForSubject,
  getPrincipal,
  getPrincipalBySubject,
  insertPrincipal,
  insertReviewDecision,
  listReviewDecisions,
  type AppDb,
  type ReviewDecisionRow,
} from "@mendpoint/db";

export const HUMAN_REVIEW_DECISIONS = [
  "approve",
  "reject",
  "request_changes",
  "regenerate",
] as const;

export type HumanReviewDecision = (typeof HUMAN_REVIEW_DECISIONS)[number];

function humanSubject(principalId: string): string {
  if (!principalId.startsWith("human:")) {
    throw new Error("human_review_identity_required");
  }
  const subject = principalId.slice("human:".length);
  if (!subject) throw new Error("human_review_identity_required");
  return subject;
}

function principalId(tenantId: string, subject: string): string {
  return `principal-human-${createHash("sha256")
    .update(`${tenantId}\n${subject}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function reviewToApi(db: AppDb, tenantId: string, row: ReviewDecisionRow) {
  const reviewer = getPrincipal(db, tenantId, row.reviewer_principal_id);
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    candidateArtifactId: row.candidate_artifact_id,
    reviewer: reviewer
      ? { subject: reviewer.subject, displayName: reviewer.display_name }
      : { subject: "unknown", displayName: "Unknown reviewer" },
    decision: row.decision,
    rationale: row.rationale,
    waiverExpiresAt: row.waiver_expires_at,
    supersedesId: row.supersedes_id,
    createdAt: row.created_at,
  };
}

export function listMigrationPrReviews(db: AppDb, tenantId: string, prId: string) {
  return listReviewDecisions(db, tenantId, "migration_pr", prId).map((row) =>
    reviewToApi(db, tenantId, row),
  );
}

export function submitMigrationPrReview(
  db: AppDb,
  input: {
    tenantId: string;
    prId: string;
    authenticatedPrincipalId: string;
    decision: HumanReviewDecision;
    rationale: string;
    reviewId: string;
    eventId: string;
    correlationId: string;
    createdAt: string;
  },
) {
  if (!HUMAN_REVIEW_DECISIONS.includes(input.decision)) {
    throw new Error("review_decision_invalid");
  }
  if (typeof input.rationale !== "string") throw new Error("review_rationale_invalid");
  const rationale = input.rationale.trim();
  if (rationale.length < 3 || rationale.length > 2_000) {
    throw new Error("review_rationale_invalid");
  }
  const subject = humanSubject(input.authenticatedPrincipalId);
  const candidate = getLatestCandidateArtifactForSubject(
    db,
    input.tenantId,
    "migration_pr",
    input.prId,
  );
  if (!candidate) throw new Error("review_candidate_not_found");
  const reviewer =
    getPrincipalBySubject(db, input.tenantId, "human", subject) ??
    insertPrincipal(db, {
      id: principalId(input.tenantId, subject),
      tenantId: input.tenantId,
      kind: "human",
      subject,
      displayName: subject,
      createdAt: input.createdAt,
    });
  const previous = listReviewDecisions(
    db,
    input.tenantId,
    "migration_pr",
    input.prId,
  ).filter((row) => row.candidate_artifact_id === candidate.id).at(-1);
  const review = insertReviewDecision(db, {
    id: input.reviewId,
    tenantId: input.tenantId,
    subjectType: "migration_pr",
    subjectId: input.prId,
    candidateArtifactId: candidate.id,
    reviewerPrincipalId: reviewer.id,
    decision: input.decision,
    rationale,
    supersedesId: previous?.id ?? null,
    createdAt: input.createdAt,
  });
  appendDomainEvent(db, {
    id: input.eventId,
    tenantId: input.tenantId,
    schemaVersion: 1,
    eventType: `migration_pr.review.${input.decision}`,
    aggregateType: "migration_pr",
    aggregateId: input.prId,
    actorPrincipalId: reviewer.id,
    correlationId: input.correlationId,
    idempotencyKey: `migration_pr:${input.prId}:review:${review.id}`,
    payload: {
      reviewId: review.id,
      candidateArtifactId: candidate.id,
      decision: input.decision,
      supersedesId: previous?.id ?? null,
    },
    createdAt: input.createdAt,
  });
  return reviewToApi(db, input.tenantId, review);
}
