import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  appendDomainEvent,
  insertArtifactManifest,
  insertEvidenceRecord,
  insertPrincipal,
  listDomainEvents,
  type AppDb,
} from "@mendpoint/db";
import {
  assignMigrationPrReviewers,
  commentOnMigrationPrReview,
  listMigrationPrReviews,
  reconcileMigrationPrNativeReview,
  submitMigrationPrReview,
} from "./reviews.js";

const dbs: AppDb[] = [];
const dirs: string[] = [];
const at = "2026-08-01T18:00:00.000Z";

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-api-reviews-"));
  dirs.push(dir);
  const db = createDb(join(dir, "reviews.sqlite"));
  dbs.push(db);
  insertArtifactManifest(db, {
    id: "candidate-a",
    tenantId: "tenant-a",
    kind: "candidate-edit",
    schemaVersion: 1,
    sha256: sha("candidate-a"),
    mediaType: "application/json",
    sizeBytes: 11,
    storageRef: "artifact://tenant-a/candidate-a",
    createdAt: at,
  });
  insertArtifactManifest(db, {
    id: "verification-a",
    tenantId: "tenant-a",
    kind: "verification-result",
    schemaVersion: 1,
    sha256: sha("verification-a"),
    mediaType: "application/json",
    sizeBytes: 14,
    storageRef: "artifact://tenant-a/verification-a",
    createdAt: at,
  });
  insertEvidenceRecord(db, {
    id: "evidence-a",
    tenantId: "tenant-a",
    subjectType: "migration_pr",
    subjectId: "pr-a",
    artifactId: "verification-a",
    inputArtifactId: "candidate-a",
    tool: "test",
    verdict: "passed",
    createdAt: at,
  });
  return db;
}

describe("migration pull request reviews", () => {
  it("requires a delegated human and records an attributed immutable event", () => {
    const db = setup();
    expect(() =>
      submitMigrationPrReview(db, {
        tenantId: "tenant-a",
        prId: "pr-a",
        authenticatedPrincipalId: "api-key:web",
        decision: "approve",
        rationale: "Evidence is complete",
        reviewId: "review-service",
        eventId: "event-service",
        correlationId: "request-service",
        createdAt: at,
      }),
    ).toThrow("human_review_identity_required");

    const review = submitMigrationPrReview(db, {
      tenantId: "tenant-a",
      prId: "pr-a",
      authenticatedPrincipalId: "human:reviewer@example.com",
      decision: "approve",
      rationale: "  Evidence is complete  ",
      reviewId: "review-a",
      eventId: "event-a",
      correlationId: "request-a",
      createdAt: at,
    });
    expect(review).toMatchObject({
      decision: "approve",
      rationale: "Evidence is complete",
      reviewer: { subject: "reviewer@example.com" },
      candidateArtifactId: "candidate-a",
    });
    expect(listMigrationPrReviews(db, "tenant-a", "pr-a")).toHaveLength(1);
    expect(listMigrationPrReviews(db, "tenant-b", "pr-a")).toEqual([]);
    expect(listDomainEvents(db, "tenant-a", "migration_pr", "pr-a")).toHaveLength(1);
  });

  it("rolls back the review when its immutable event cannot be appended", () => {
    const db = setup();
    insertPrincipal(db, {
      id: "principal-reviewer",
      tenantId: "tenant-a",
      kind: "human",
      subject: "reviewer@example.com",
      displayName: "Reviewer",
      createdAt: at,
    });
    appendDomainEvent(db, {
      id: "event-collision",
      tenantId: "tenant-a",
      schemaVersion: 1,
      eventType: "fixture.created",
      aggregateType: "fixture",
      aggregateId: "fixture-a",
      actorPrincipalId: "principal-reviewer",
      correlationId: "request-fixture",
      idempotencyKey: "fixture:event-collision",
      payload: {},
      createdAt: at,
    });

    expect(() =>
      submitMigrationPrReview(db, {
        tenantId: "tenant-a",
        prId: "pr-a",
        authenticatedPrincipalId: "human:reviewer@example.com",
        decision: "approve",
        rationale: "Evidence is complete",
        reviewId: "review-rolled-back",
        eventId: "event-collision",
        correlationId: "request-review",
        createdAt: at,
      }),
    ).toThrow();
    expect(listMigrationPrReviews(db, "tenant-a", "pr-a")).toEqual([]);
  });

  it("supersedes only the latest decision for the current candidate", () => {
    const db = setup();
    for (const [index, decision] of (["request_changes", "approve"] as const).entries()) {
      submitMigrationPrReview(db, {
        tenantId: "tenant-a",
        prId: "pr-a",
        authenticatedPrincipalId: "human:reviewer@example.com",
        decision,
        rationale: index === 0 ? "Add rollback coverage" : "Rollback coverage is present",
        reviewId: `review-${index}`,
        eventId: `event-${index}`,
        correlationId: `request-${index}`,
        createdAt: `2026-08-01T18:0${index}:00.000Z`,
      });
    }
    const reviews = listMigrationPrReviews(db, "tenant-a", "pr-a");
    expect(reviews[1]).toMatchObject({
      decision: "approve",
      supersedesId: "review-0",
    });
  });

  it("persists reviewer assignments and attributed comments as replay safe events", () => {
    const db = setup();
    const assignment = assignMigrationPrReviewers(db, {
      tenantId: "tenant-a",
      prId: "pr-a",
      authenticatedPrincipalId: "human:owner@example.com",
      reviewerPrincipalIds: ["human:reviewer-b@example.com", "human:reviewer-a@example.com"],
      requiredReviewerCount: 2,
      eventId: "event-assignment",
      correlationId: "request-assignment",
      createdAt: at,
    });
    expect(assignment).toMatchObject({ candidateArtifactId: "candidate-a", requiredReviewerCount: 2 });
    expect(assignment.reviewerPrincipalIds).toHaveLength(2);
    const comment = commentOnMigrationPrReview(db, {
      tenantId: "tenant-a",
      prId: "pr-a",
      authenticatedPrincipalId: "human:reviewer-a@example.com",
      commentId: "comment-1",
      body: "  Add a rollback assertion before approval.  ",
      eventId: "event-comment",
      correlationId: "request-assignment",
      causationId: "event-assignment",
      createdAt: "2026-08-01T18:01:00.000Z",
    });
    expect(comment.body).toBe("Add a rollback assertion before approval.");
    expect(comment.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    const events = listDomainEvents(db, "tenant-a", "migration_pr", "pr-a");
    expect(events.map((event) => event.event_type)).toEqual([
      "migration_pr.reviewers.assigned",
      "migration_pr.review.comment",
    ]);
    expect(events[1]?.causation_id).toBe("event-assignment");
    expect(() => assignMigrationPrReviewers(db, {
      ...{
        tenantId: "tenant-a",
        prId: "pr-a",
        authenticatedPrincipalId: "human:owner@example.com",
        reviewerPrincipalIds: ["human:reviewer-a@example.com"],
        requiredReviewerCount: 2,
        eventId: "event-bad-assignment",
        correlationId: "request-bad-assignment",
        createdAt: at,
      },
    })).toThrow("review_assignment_invalid");
  });

  it("records short lived human waivers and rejects expired or unrelated expiry", () => {
    const db = setup();
    const waiver = submitMigrationPrReview(db, {
      tenantId: "tenant-a",
      prId: "pr-a",
      authenticatedPrincipalId: "human:security@example.com",
      decision: "waive",
      rationale: "Controlled exception for the scheduled release window",
      waiverExpiresAt: "2026-08-01T20:00:00.000Z",
      reviewId: "review-waiver",
      eventId: "event-waiver",
      correlationId: "request-waiver",
      createdAt: at,
    });
    expect(waiver).toMatchObject({
      decision: "waive",
      waiverExpiresAt: "2026-08-01T20:00:00.000Z",
    });
    expect(() => submitMigrationPrReview(db, {
      tenantId: "tenant-a",
      prId: "pr-a",
      authenticatedPrincipalId: "human:security@example.com",
      decision: "approve",
      rationale: "Evidence is complete",
      waiverExpiresAt: "2026-08-01T20:00:00.000Z",
      reviewId: "review-expiry-unexpected",
      eventId: "event-expiry-unexpected",
      correlationId: "request-expiry-unexpected",
      createdAt: at,
    })).toThrow("review_waiver_expiry_unexpected");
  });

  it("links a new candidate to the candidate version it supersedes", () => {
    const db = setup();
    submitMigrationPrReview(db, {
      tenantId: "tenant-a",
      prId: "pr-a",
      authenticatedPrincipalId: "human:reviewer@example.com",
      decision: "request_changes",
      rationale: "Add rollback coverage",
      reviewId: "review-old-candidate",
      eventId: "event-old-candidate",
      correlationId: "request-candidate-chain",
      createdAt: at,
    });
    insertArtifactManifest(db, {
      id: "candidate-b",
      tenantId: "tenant-a",
      kind: "candidate-edit",
      schemaVersion: 1,
      sha256: sha("candidate-b"),
      mediaType: "application/json",
      sizeBytes: 11,
      storageRef: "artifact://tenant-a/candidate-b",
      createdAt: "2026-08-01T18:02:00.000Z",
    });
    insertArtifactManifest(db, {
      id: "verification-b",
      tenantId: "tenant-a",
      kind: "verification-result",
      schemaVersion: 1,
      sha256: sha("verification-b"),
      mediaType: "application/json",
      sizeBytes: 14,
      storageRef: "artifact://tenant-a/verification-b",
      createdAt: "2026-08-01T18:02:00.000Z",
    });
    insertEvidenceRecord(db, {
      id: "evidence-b",
      tenantId: "tenant-a",
      subjectType: "migration_pr",
      subjectId: "pr-a",
      artifactId: "verification-b",
      inputArtifactId: "candidate-b",
      tool: "test",
      verdict: "passed",
      createdAt: "2026-08-01T18:02:00.000Z",
    });
    submitMigrationPrReview(db, {
      tenantId: "tenant-a",
      prId: "pr-a",
      authenticatedPrincipalId: "human:reviewer@example.com",
      decision: "approve",
      rationale: "Rollback coverage is present",
      reviewId: "review-new-candidate",
      eventId: "event-new-candidate",
      correlationId: "request-candidate-chain",
      createdAt: "2026-08-01T18:03:00.000Z",
    });
    const events = listDomainEvents(db, "tenant-a", "migration_pr", "pr-a");
    const superseded = events.find((event) => event.event_type === "migration_pr.candidate.superseded");
    expect(JSON.parse(superseded!.payload_json)).toEqual({
      candidateArtifactId: "candidate-b",
      supersededCandidateArtifactId: "candidate-a",
      supersededReviewId: "review-old-candidate",
    });
    expect(superseded?.causation_id).toBe("event-new-candidate");
  });

  it("reconciles authenticated native SCM observations against the current candidate", () => {
    const db = setup();
    submitMigrationPrReview(db, {
      tenantId: "tenant-a",
      prId: "pr-a",
      authenticatedPrincipalId: "human:reviewer@example.com",
      decision: "approve",
      rationale: "Evidence is complete",
      reviewId: "review-local",
      eventId: "event-local",
      correlationId: "request-native",
      createdAt: at,
    });
    const matching = reconcileMigrationPrNativeReview(db, {
      tenantId: "tenant-a",
      prId: "pr-a",
      authenticatedPrincipalId: "webhook:github-installation-42",
      provider: "github",
      externalReviewId: "native-review-9",
      externalRevision: "revision-1",
      candidateArtifactId: "candidate-a",
      state: "approve",
      nativeActor: "octocat",
      evidenceArtifactId: "artifact-native-review-9",
      eventId: "event-native-match",
      correlationId: "request-native",
      causationId: "event-local",
      observedAt: "2026-08-01T18:04:00.000Z",
    });
    expect(matching).toEqual({ eventId: "event-native-match", localReviewId: "review-local", reconciled: true });
    const mismatch = reconcileMigrationPrNativeReview(db, {
      tenantId: "tenant-a",
      prId: "pr-a",
      authenticatedPrincipalId: "webhook:gitlab-project-42",
      provider: "gitlab",
      externalReviewId: "native-review-10",
      externalRevision: "revision-1",
      candidateArtifactId: "candidate-a",
      state: "request_changes",
      nativeActor: "reviewer-2",
      evidenceArtifactId: "artifact-native-review-10",
      eventId: "event-native-mismatch",
      correlationId: "request-native",
      observedAt: "2026-08-01T18:05:00.000Z",
    });
    expect(mismatch.reconciled).toBe(false);
    expect(() => reconcileMigrationPrNativeReview(db, {
      tenantId: "tenant-a",
      prId: "pr-a",
      authenticatedPrincipalId: "webhook:github-installation-42",
      provider: "github",
      externalReviewId: "native-review-stale",
      externalRevision: "revision-1",
      candidateArtifactId: "candidate-stale",
      state: "approve",
      nativeActor: "octocat",
      evidenceArtifactId: "artifact-native-review-stale",
      eventId: "event-native-stale",
      correlationId: "request-native",
      observedAt: "2026-08-01T18:06:00.000Z",
    })).toThrow("native_review_candidate_stale");
  });
});
