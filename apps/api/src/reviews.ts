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
  "waive",
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

function attributedPrincipal(
  db: AppDb,
  input: {
    tenantId: string;
    authenticatedPrincipalId: string;
    createdAt: string;
    allowedKinds?: readonly ("human" | "webhook")[];
  },
) {
  const splitAt = input.authenticatedPrincipalId.indexOf(":");
  const kind = input.authenticatedPrincipalId.slice(0, splitAt) as "human" | "webhook";
  const subject = input.authenticatedPrincipalId.slice(splitAt + 1);
  if (!input.allowedKinds?.includes(kind) || !subject) {
    throw new Error("review_attributed_identity_required");
  }
  return getPrincipalBySubject(db, input.tenantId, kind, subject) ??
    insertPrincipal(db, {
      id: `${kind === "human" ? "principal-human" : "principal-webhook"}-${createHash("sha256")
        .update(`${input.tenantId}\n${kind}\n${subject}`)
        .digest("hex")
        .slice(0, 32)}`,
      tenantId: input.tenantId,
      kind,
      subject,
      displayName: subject,
      createdAt: input.createdAt,
    });
}

function requiredReviewText(value: string, field: string, max = 2_000): string {
  if (typeof value !== "string") throw new Error(`${field}_invalid`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw new Error(`${field}_invalid`);
  return trimmed;
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

type SubmitMigrationPrReviewInput = {
  tenantId: string;
  prId: string;
  authenticatedPrincipalId: string;
  decision: HumanReviewDecision;
  rationale: string;
  reviewId: string;
  eventId: string;
  correlationId: string;
  createdAt: string;
  waiverExpiresAt?: string | null;
};

export function submitMigrationPrReview(
  db: AppDb,
  input: SubmitMigrationPrReviewInput,
) {
  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const result = submitMigrationPrReviewInTransaction(db, input);
    if (ownsTransaction) db.raw.exec("COMMIT");
    return result;
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function submitMigrationPrReviewInTransaction(
  db: AppDb,
  input: SubmitMigrationPrReviewInput,
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
  );
  const previousForCandidate = previous
    .filter((row) => row.candidate_artifact_id === candidate.id)
    .at(-1);
  const priorCandidate = previous.filter((row) => row.candidate_artifact_id !== candidate.id).at(-1);
  if (input.decision === "waive") {
    const expiresAt = Date.parse(input.waiverExpiresAt ?? "");
    const createdAt = Date.parse(input.createdAt);
    if (
      !Number.isFinite(expiresAt) ||
      expiresAt <= createdAt ||
      expiresAt - createdAt > 24 * 60 * 60 * 1_000
    ) throw new Error("review_waiver_expiry_invalid");
  } else if (input.waiverExpiresAt) {
    throw new Error("review_waiver_expiry_unexpected");
  }
  const review = insertReviewDecision(db, {
    id: input.reviewId,
    tenantId: input.tenantId,
    subjectType: "migration_pr",
    subjectId: input.prId,
    candidateArtifactId: candidate.id,
    reviewerPrincipalId: reviewer.id,
    decision: input.decision,
    rationale,
    waiverExpiresAt: input.waiverExpiresAt ?? null,
    supersedesId: previousForCandidate?.id ?? null,
    createdAt: input.createdAt,
  });
  if (priorCandidate) {
    appendDomainEvent(db, {
      id: `${input.eventId}:candidate-superseded`,
      tenantId: input.tenantId,
      schemaVersion: 1,
      eventType: "migration_pr.candidate.superseded",
      aggregateType: "migration_pr",
      aggregateId: input.prId,
      actorPrincipalId: reviewer.id,
      correlationId: input.correlationId,
      causationId: input.eventId,
      idempotencyKey: `migration_pr:${input.prId}:candidate:${candidate.id}:supersedes:${priorCandidate.candidate_artifact_id}`,
      payload: {
        candidateArtifactId: candidate.id,
        supersededCandidateArtifactId: priorCandidate.candidate_artifact_id,
        supersededReviewId: priorCandidate.id,
      },
      createdAt: input.createdAt,
    });
  }
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
      waiverExpiresAt: input.waiverExpiresAt ?? null,
      supersedesId: previousForCandidate?.id ?? null,
    },
    createdAt: input.createdAt,
  });
  return reviewToApi(db, input.tenantId, review);
}

export function assignMigrationPrReviewers(
  db: AppDb,
  input: {
    tenantId: string;
    prId: string;
    authenticatedPrincipalId: string;
    reviewerPrincipalIds: readonly string[];
    requiredReviewerCount: number;
    eventId: string;
    correlationId: string;
    createdAt: string;
  },
) {
  const actor = attributedPrincipal(db, { ...input, allowedKinds: ["human"] });
  const candidate = getLatestCandidateArtifactForSubject(db, input.tenantId, "migration_pr", input.prId);
  if (!candidate) throw new Error("review_candidate_not_found");
  const reviewerIds = [...new Set(input.reviewerPrincipalIds)].sort();
  if (
    reviewerIds.length === 0 ||
    !Number.isSafeInteger(input.requiredReviewerCount) ||
    input.requiredReviewerCount < 1 ||
    input.requiredReviewerCount > reviewerIds.length
  ) throw new Error("review_assignment_invalid");
  const reviewers = reviewerIds.map((authenticatedPrincipalId) =>
    attributedPrincipal(db, {
      tenantId: input.tenantId,
      authenticatedPrincipalId,
      createdAt: input.createdAt,
      allowedKinds: ["human"],
    }));
  const event = appendDomainEvent(db, {
    id: input.eventId,
    tenantId: input.tenantId,
    schemaVersion: 1,
    eventType: "migration_pr.reviewers.assigned",
    aggregateType: "migration_pr",
    aggregateId: input.prId,
    actorPrincipalId: actor.id,
    correlationId: input.correlationId,
    idempotencyKey: `migration_pr:${input.prId}:reviewers:${candidate.id}:${input.eventId}`,
    payload: {
      candidateArtifactId: candidate.id,
      reviewerPrincipalIds: reviewers.map((reviewer) => reviewer.id),
      requiredReviewerCount: input.requiredReviewerCount,
    },
    createdAt: input.createdAt,
  });
  return {
    candidateArtifactId: candidate.id,
    reviewerPrincipalIds: reviewers.map((reviewer) => reviewer.id),
    requiredReviewerCount: input.requiredReviewerCount,
    eventId: event.row.id,
  };
}

export function commentOnMigrationPrReview(
  db: AppDb,
  input: {
    tenantId: string;
    prId: string;
    authenticatedPrincipalId: string;
    commentId: string;
    body: string;
    eventId: string;
    correlationId: string;
    causationId?: string | null;
    createdAt: string;
  },
) {
  const actor = attributedPrincipal(db, { ...input, allowedKinds: ["human"] });
  const candidate = getLatestCandidateArtifactForSubject(db, input.tenantId, "migration_pr", input.prId);
  if (!candidate) throw new Error("review_candidate_not_found");
  requiredReviewText(input.commentId, "review_comment_id");
  const body = requiredReviewText(input.body, "review_comment", 10_000);
  const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex");
  const event = appendDomainEvent(db, {
    id: input.eventId,
    tenantId: input.tenantId,
    schemaVersion: 1,
    eventType: "migration_pr.review.comment",
    aggregateType: "migration_pr",
    aggregateId: input.prId,
    actorPrincipalId: actor.id,
    correlationId: input.correlationId,
    causationId: input.causationId,
    idempotencyKey: `migration_pr:${input.prId}:comment:${input.commentId}`,
    payload: { commentId: input.commentId, candidateArtifactId: candidate.id, body, bodySha256 },
    createdAt: input.createdAt,
  });
  return { commentId: input.commentId, candidateArtifactId: candidate.id, body, bodySha256, eventId: event.row.id };
}

export type NativeReviewState = "approve" | "reject" | "request_changes" | "comment";

export function reconcileMigrationPrNativeReview(
  db: AppDb,
  input: {
    tenantId: string;
    prId: string;
    authenticatedPrincipalId: string;
    provider: "github" | "gitlab";
    externalReviewId: string;
    externalRevision: string;
    candidateArtifactId: string;
    state: NativeReviewState;
    nativeActor: string;
    evidenceArtifactId: string;
    eventId: string;
    correlationId: string;
    causationId?: string | null;
    observedAt: string;
  },
) {
  const actor = attributedPrincipal(db, {
    tenantId: input.tenantId,
    authenticatedPrincipalId: input.authenticatedPrincipalId,
    createdAt: input.observedAt,
    allowedKinds: ["human", "webhook"],
  });
  const candidate = getLatestCandidateArtifactForSubject(db, input.tenantId, "migration_pr", input.prId);
  if (!candidate || candidate.id !== input.candidateArtifactId) {
    throw new Error("native_review_candidate_stale");
  }
  requiredReviewText(input.externalReviewId, "native_review_id");
  requiredReviewText(input.externalRevision, "native_review_revision");
  requiredReviewText(input.nativeActor, "native_review_actor");
  requiredReviewText(input.evidenceArtifactId, "native_review_evidence");
  if (!new Set<NativeReviewState>(["approve", "reject", "request_changes", "comment"]).has(input.state)) {
    throw new Error("native_review_state_invalid");
  }
  const latestLocal = listReviewDecisions(db, input.tenantId, "migration_pr", input.prId)
    .filter((row) => row.candidate_artifact_id === candidate.id)
    .at(-1);
  const reconciled = input.state === "comment"
    ? true
    : latestLocal?.decision === input.state;
  const event = appendDomainEvent(db, {
    id: input.eventId,
    tenantId: input.tenantId,
    schemaVersion: 1,
    eventType: "migration_pr.review.native_reconciled",
    aggregateType: "migration_pr",
    aggregateId: input.prId,
    actorPrincipalId: actor.id,
    correlationId: input.correlationId,
    causationId: input.causationId,
    idempotencyKey: `migration_pr:${input.prId}:native-review:${input.provider}:${input.externalReviewId}:${input.externalRevision}`,
    payload: {
      provider: input.provider,
      externalReviewId: input.externalReviewId,
      externalRevision: input.externalRevision,
      candidateArtifactId: candidate.id,
      state: input.state,
      nativeActor: input.nativeActor,
      evidenceArtifactId: input.evidenceArtifactId,
      localReviewId: latestLocal?.id ?? null,
      reconciled,
    },
    createdAt: input.observedAt,
  });
  return { eventId: event.row.id, localReviewId: latestLocal?.id ?? null, reconciled };
}
