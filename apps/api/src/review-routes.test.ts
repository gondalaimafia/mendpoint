import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  insertApiChange,
  insertApiVersion,
  insertArtifactManifest,
  insertConsumer,
  insertEvidenceRecord,
  insertMigrationPr,
  insertProvider,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiEnv } from "./auth.js";
import { createMigrationPrReviewRoutes } from "./review-routes.js";

const NOW = "2026-08-02T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

function sha(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function seedPr(db: AppDb, tenantId: string, suffix: string) {
  const providerId = `provider-${suffix}`;
  const fromVersionId = `version-${suffix}-1`;
  const toVersionId = `version-${suffix}-2`;
  const changeId = `change-${suffix}`;
  const consumerId = `consumer-${suffix}`;
  const prId = `pr-${suffix}`;
  insertProvider(db, {
    id: providerId,
    slug: `provider-${suffix}`,
    name: `Provider ${suffix}`,
    createdAt: NOW,
  });
  insertApiVersion(db, {
    id: fromVersionId,
    providerId,
    versionLabel: "1",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: suffix, version: "1" } }),
    publishedAt: NOW,
  });
  insertApiVersion(db, {
    id: toVersionId,
    providerId,
    versionLabel: "2",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: suffix, version: "2" } }),
    publishedAt: NOW,
  });
  insertApiChange(db, {
    id: changeId,
    providerId,
    fromVersionId,
    toVersionId,
    risk: "breaking",
    summary: "Review route fixture",
    diffJson: "[]",
    createdAt: NOW,
  });
  insertConsumer(db, {
    id: consumerId,
    name: `Consumer ${suffix}`,
    githubOwner: "customer",
    githubRepo: `repo-${suffix}`,
    tenantId,
    createdAt: NOW,
  });
  insertMigrationPr(db, {
    id: prId,
    changeId,
    consumerId,
    title: "Review migration",
    body: "Candidate is ready for review.",
    branchName: `mendpoint/${suffix}`,
    status: "draft",
    risk: "breaking",
    patchUnified: "",
    createdAt: NOW,
  });
  const candidateId = `candidate-${suffix}`;
  const verificationId = `verification-${suffix}`;
  insertArtifactManifest(db, {
    id: candidateId,
    tenantId,
    kind: "candidate-edit",
    schemaVersion: 1,
    sha256: sha(candidateId),
    mediaType: "application/json",
    sizeBytes: candidateId.length,
    storageRef: `artifact://${tenantId}/${candidateId}`,
    createdAt: NOW,
  });
  insertArtifactManifest(db, {
    id: verificationId,
    tenantId,
    kind: "verification-result",
    schemaVersion: 1,
    sha256: sha(verificationId),
    mediaType: "application/json",
    sizeBytes: verificationId.length,
    storageRef: `artifact://${tenantId}/${verificationId}`,
    createdAt: NOW,
  });
  insertEvidenceRecord(db, {
    id: `evidence-${suffix}`,
    tenantId,
    subjectType: "migration_pr",
    subjectId: prId,
    artifactId: verificationId,
    inputArtifactId: candidateId,
    tool: "route-test",
    verdict: "passed",
    createdAt: NOW,
  });
  return prId;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-review-routes-"));
  const db = createDb(join(directory, "api.sqlite"));
  opened.push({ db, directory });
  db.raw
    .prepare(
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?),
              ('tenant-b', 'tenant-b', 'Tenant B', 'team', 'active', 10, ?)`,
    )
    .run(NOW, NOW);
  const prA = seedPr(db, "tenant-a", "a");
  seedPr(db, "tenant-b", "b");
  const identities = {
    "owner-a": { id: "human:owner@example.com", tenantId: "tenant-a", role: "owner" as const },
    "engineer-a": { id: "human:engineer@example.com", tenantId: "tenant-a", role: "engineer" as const },
    "viewer-a": { id: "human:viewer@example.com", tenantId: "tenant-a", role: "viewer" as const },
    "owner-b": { id: "human:owner-b@example.com", tenantId: "tenant-b", role: "owner" as const },
    "service-a": { id: "api-key:service", tenantId: "tenant-a", role: "owner" as const },
  };
  let sequence = 0;
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "") as
      | keyof typeof identities
      | undefined;
    const principal = token ? identities[token] : undefined;
    if (principal) {
      c.set("principal", principal);
      c.set("requestId", c.req.header("X-Request-Id") ?? `request-${token}`);
    }
    return next();
  });
  app.route(
    "/prs",
    createMigrationPrReviewRoutes({
      db,
      createId: () => `review-route-id-${++sequence}`,
      now: () => NOW,
    }),
  );
  return { app, prA };
}

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Request-Id": `request-${token}`,
  };
}

describe("migration pull request review API", () => {
  it("accepts a waiver only when its expiry is valid and short lived", async () => {
    const { app, prA } = fixture();
    const missingExpiry = await app.request(`/prs/${prA}/reviews`, {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({ decision: "waive", rationale: "Approved exception window" }),
    });
    expect(missingExpiry.status).toBe(400);
    await expect(missingExpiry.json()).resolves.toEqual({ error: "review_waiver_expiry_invalid" });

    const expired = await app.request(`/prs/${prA}/reviews`, {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({
        decision: "waive",
        rationale: "Approved exception window",
        waiverExpiresAt: "2026-08-02T11:59:59.000Z",
      }),
    });
    expect(expired.status).toBe(400);

    const accepted = await app.request(`/prs/${prA}/reviews`, {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({
        decision: "waive",
        rationale: "Approved exception window",
        waiverExpiresAt: "2026-08-02T18:00:00.000Z",
      }),
    });
    expect(accepted.status).toBe(201);
    await expect(accepted.json()).resolves.toMatchObject({
      decision: "waive",
      waiverExpiresAt: "2026-08-02T18:00:00.000Z",
      reviewer: { subject: "owner@example.com" },
    });

    const unrelatedExpiry = await app.request(`/prs/${prA}/reviews`, {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({
        decision: "approve",
        rationale: "Evidence is complete",
        waiverExpiresAt: "2026-08-02T18:00:00.000Z",
      }),
    });
    expect(unrelatedExpiry.status).toBe(400);
    await expect(unrelatedExpiry.json()).resolves.toEqual({
      error: "review_waiver_expiry_unexpected",
    });
  });

  it("fails closed across roles, tenants, and nonhuman identities", async () => {
    const { app, prA } = fixture();
    const unauthenticated = await app.request(`/prs/${prA}/reviews`);
    expect(unauthenticated.status).toBe(401);

    const viewerReview = await app.request(`/prs/${prA}/reviews`, {
      method: "POST",
      headers: headers("viewer-a"),
      body: JSON.stringify({ decision: "approve", rationale: "Evidence is complete" }),
    });
    expect(viewerReview.status).toBe(403);

    const crossTenant = await app.request(`/prs/${prA}/reviews`, {
      method: "POST",
      headers: headers("owner-b"),
      body: JSON.stringify({ decision: "approve", rationale: "Evidence is complete" }),
    });
    expect(crossTenant.status).toBe(404);

    const engineerAssignment = await app.request(`/prs/${prA}/reviewers`, {
      method: "POST",
      headers: headers("engineer-a"),
      body: JSON.stringify({
        reviewerPrincipalIds: ["human:reviewer@example.com"],
        requiredReviewerCount: 1,
      }),
    });
    expect(engineerAssignment.status).toBe(403);

    const serviceAssignment = await app.request(`/prs/${prA}/reviewers`, {
      method: "POST",
      headers: headers("service-a"),
      body: JSON.stringify({
        reviewerPrincipalIds: ["human:reviewer@example.com"],
        requiredReviewerCount: 1,
      }),
    });
    expect(serviceAssignment.status).toBe(403);
    await expect(serviceAssignment.json()).resolves.toEqual({
      error: "review_attributed_identity_required",
    });
  });

  it("creates reviewer assignments and attributed comments with validation", async () => {
    const { app, prA } = fixture();
    const invalidAssignment = await app.request(`/prs/${prA}/reviewers`, {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({ reviewerPrincipalIds: ["human:reviewer@example.com"], requiredReviewerCount: 2 }),
    });
    expect(invalidAssignment.status).toBe(400);

    const assignment = await app.request(`/prs/${prA}/reviewers`, {
      method: "POST",
      headers: headers("owner-a"),
      body: JSON.stringify({
        reviewerPrincipalIds: ["human:reviewer@example.com"],
        requiredReviewerCount: 1,
      }),
    });
    expect(assignment.status).toBe(201);
    await expect(assignment.json()).resolves.toMatchObject({
      requiredReviewerCount: 1,
      reviewerPrincipalIds: [expect.stringMatching(/^principal-human-/)],
    });

    const invalidComment = await app.request(`/prs/${prA}/review-comments`, {
      method: "POST",
      headers: headers("engineer-a"),
      body: JSON.stringify({ commentId: "comment-1", body: "   " }),
    });
    expect(invalidComment.status).toBe(400);

    const comment = await app.request(`/prs/${prA}/review-comments`, {
      method: "POST",
      headers: headers("engineer-a"),
      body: JSON.stringify({
        commentId: "comment-1",
        body: "  Add rollback coverage before approval.  ",
      }),
    });
    expect(comment.status).toBe(201);
    await expect(comment.json()).resolves.toMatchObject({
      commentId: "comment-1",
      body: "Add rollback coverage before approval.",
      bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});
