import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertArtifactManifest,
  insertEvidenceRecord,
  listDomainEvents,
  type AppDb,
} from "@mendpoint/db";
import {
  listMigrationPrReviews,
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
});
