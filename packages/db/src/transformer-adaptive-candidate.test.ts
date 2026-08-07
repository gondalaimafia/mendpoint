import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  expireAdaptiveCandidate,
  getAdaptiveCandidate,
  getAdaptiveRegenerationByCandidate,
  listAdaptiveCandidateTenantIds,
  listAdaptiveAttentionCandidates,
  listAdaptiveCandidateHistory,
  listAdaptiveCandidates,
  listAdaptiveCandidatesForMaintenance,
  listPendingAdaptiveRegenerations,
  markAdaptiveRegenerationBlocked,
  markAdaptiveRegenerationScheduled,
  promoteAdaptiveCandidate,
  recordAdaptiveCandidate,
  requestAdaptiveCandidateRegeneration,
  reviewAdaptiveCandidate,
  type AppDb,
} from "./index.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  while (dbs.length) {
    try {
      dbs.pop()?.raw.close();
    } catch {
      /* ignore */
    }
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
});

function freshDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-adaptive-db-"));
  dirs.push(dir);
  const db = createDb(join(dir, "t.sqlite"));
  dbs.push(db);
  return db;
}

const DIVERGED = `sha256:${"a".repeat(64)}`;
const CANDIDATE = `sha256:${"b".repeat(64)}`;
const SEAL = `sha256:${"c".repeat(64)}`;

function record(db: AppDb, overrides: Record<string, unknown> = {}) {
  return recordAdaptiveCandidate(db, {
    tenantId: "tenant-a",
    campaignId: "campaign-1",
    unitId: "unit-1",
    attemptId: "tfattempt_abc",
    repositoryId: "repo-1",
    snapshotId: "snapshot-1",
    baseBranch: "main",
    expectedBaseRevision: "e".repeat(40),
    divergedFromDigest: DIVERGED,
    candidateDigest: CANDIDATE,
    failingCommandId: "verify:typecheck",
    sealedPath: "/data/transformer-adaptive-candidates/tenant-a/approvals/x.json",
    sealedSha256: SEAL,
    changedPaths: ["package.json"],
    expiresAt: "2099-01-01T00:00:00.000Z",
    now: "2026-08-06T00:00:00.000Z",
    ...overrides,
  });
}

describe("transformer adaptive candidate store", () => {
  it("records a converged adaptive candidate in review_pending", () => {
    const db = freshDb();
    const rec = record(db);
    expect(rec.kind).toBe("adaptive");
    expect(rec.status).toBe("review_pending");
    expect(rec.divergedFromDigest).toBe(DIVERGED);
    expect(rec.candidateDigest).toBe(CANDIDATE);
    expect(rec.repositoryId).toBe("repo-1");
    expect(rec.snapshotId).toBe("snapshot-1");
    expect(rec.baseBranch).toBe("main");
    expect(rec.expectedBaseRevision).toBe("e".repeat(40));
    expect(getAdaptiveCandidate(db, "tenant-a", rec.id)?.status).toBe("review_pending");
  });

  it("enumerates every tenant and candidate for lifecycle maintenance", () => {
    const db = freshDb();
    record(db);
    record(db, {
      tenantId: "tenant-b",
      campaignId: "campaign-2",
      unitId: "unit-2",
      attemptId: "tfattempt_def",
    });
    expect(listAdaptiveCandidateTenantIds(db)).toEqual(["tenant-a", "tenant-b"]);
    expect(listAdaptiveCandidatesForMaintenance(db, "tenant-a").map((row) => row.id))
      .toEqual([getAdaptiveCandidate(db, "tenant-a", record(db).id)!.id]);
  });

  it("is idempotent for the identical sealed candidate and conflicts on a different seal", () => {
    const db = freshDb();
    const first = record(db);
    const replay = record(db);
    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe("review_pending");
    expect(() => record(db, { sealedSha256: `sha256:${"d".repeat(64)}` })).toThrow(
      "transformer_adaptive_candidate_conflict",
    );
    expect(() => record(db, { baseBranch: "release" })).toThrow(
      "transformer_adaptive_candidate_conflict",
    );
  });

  it("rejects a non-divergent candidate (digest equals the recipe digest)", () => {
    const db = freshDb();
    expect(() => record(db, { divergedFromDigest: CANDIDATE })).toThrow(
      "transformer_adaptive_candidate_not_divergent",
    );
  });

  it("requires explicit human review; approve then promote", () => {
    const db = freshDb();
    const rec = record(db);
    const approved = reviewAdaptiveCandidate(db, {
      tenantId: "tenant-a",
      id: rec.id,
      decision: "approve",
      reviewerPrincipalId: "human:reviewer-1",
      now: "2026-08-06T01:00:00.000Z",
    });
    expect(approved.status).toBe("approved");
    expect(approved.reviewerPrincipalId).toBe("human:reviewer-1");
    const promoted = promoteAdaptiveCandidate(db, {
      tenantId: "tenant-a",
      id: rec.id,
      now: "2026-08-06T02:00:00.000Z",
    });
    expect(promoted.status).toBe("promoted");
  });

  it("retains the reviewed candidate and links a scheduled immutable regeneration", () => {
    const db = freshDb();
    const original = record(db);
    const requested = requestAdaptiveCandidateRegeneration(db, {
      tenantId: "tenant-a",
      id: original.id,
      reviewerPrincipalId: "human:reviewer-1",
      rationale: "Keep the public behavior but choose a safer dependency edit.",
      now: "2026-08-06T01:00:00.000Z",
    });
    expect(requested.candidate).toMatchObject({
      status: "superseded",
      reviewDecision: "regenerate",
      reviewRationale: "Keep the public behavior but choose a safer dependency edit.",
      reviewerPrincipalId: "human:reviewer-1",
      sealedPath: original.sealedPath,
      sealedSha256: original.sealedSha256,
      generation: 1,
    });
    expect(listPendingAdaptiveRegenerations(db)).toEqual([requested.regeneration]);

    markAdaptiveRegenerationScheduled(db, {
      tenantId: "tenant-a",
      id: requested.regeneration.id,
      observedAt: "2026-08-06T01:01:00.000Z",
    });
    const replacement = record(db, {
      attemptId: "tfattempt_replacement",
      candidateDigest: `sha256:${"d".repeat(64)}`,
      sealedPath: "/data/transformer-adaptive-candidates/tenant-a/approvals/y.json",
      sealedSha256: `sha256:${"f".repeat(64)}`,
      now: "2026-08-06T01:02:00.000Z",
    });
    expect(replacement).toMatchObject({
      status: "review_pending",
      supersedesCandidateId: original.id,
      generation: 2,
    });
    expect(getAdaptiveCandidate(db, "tenant-a", original.id)?.supersededByCandidateId)
      .toBe(replacement.id);
    expect(getAdaptiveRegenerationByCandidate(db, "tenant-a", original.id)).toMatchObject({
      status: "completed",
      supersedingCandidateId: replacement.id,
    });
    expect(listAdaptiveCandidateHistory(db, { tenantId: "tenant-a" }).records.map((row) => row.id))
      .toContain(original.id);
  });

  it("records an authorization block once without burning a regeneration attempt", () => {
    const db = freshDb();
    const original = record(db);
    const requested = requestAdaptiveCandidateRegeneration(db, {
      tenantId: "tenant-a",
      id: original.id,
      reviewerPrincipalId: "human:reviewer-1",
      rationale: "Keep behavior stable while revising the dependency edit.",
      now: "2026-08-06T01:00:00.000Z",
    });

    const first = markAdaptiveRegenerationBlocked(db, {
      tenantId: "tenant-a",
      id: requested.regeneration.id,
      reason: "external_processing_authorization_required",
      observedAt: "2026-08-06T01:01:00.000Z",
    });
    const replay = markAdaptiveRegenerationBlocked(db, {
      tenantId: "tenant-a",
      id: requested.regeneration.id,
      reason: "external_processing_authorization_required",
      observedAt: "2026-08-06T01:02:00.000Z",
    });

    expect(first).toMatchObject({
      status: "pending",
      attemptCount: 0,
      lastErrorCode: "external_processing_authorization_required",
      updatedAt: "2026-08-06T01:01:00.000Z",
    });
    expect(replay).toEqual(first);
    expect(listPendingAdaptiveRegenerations(db)).toEqual([first]);
  });

  it("refuses to promote an unapproved (pending) candidate", () => {
    const db = freshDb();
    const rec = record(db);
    expect(() => promoteAdaptiveCandidate(db, { tenantId: "tenant-a", id: rec.id })).toThrow(
      "transformer_adaptive_candidate_not_approved",
    );
  });

  it("review is idempotent and rejects re-decision after a terminal review", () => {
    const db = freshDb();
    const rec = record(db);
    reviewAdaptiveCandidate(db, {
      tenantId: "tenant-a",
      id: rec.id,
      decision: "reject",
      reviewerPrincipalId: "human:reviewer-1",
    });
    const replay = reviewAdaptiveCandidate(db, {
      tenantId: "tenant-a",
      id: rec.id,
      decision: "reject",
      reviewerPrincipalId: "human:reviewer-1",
    });
    expect(replay.status).toBe("rejected");
    expect(() =>
      reviewAdaptiveCandidate(db, {
        tenantId: "tenant-a",
        id: rec.id,
        decision: "approve",
        reviewerPrincipalId: "human:reviewer-1",
      }),
    ).toThrow("transformer_adaptive_candidate_not_pending");
  });

  it("expires a pending candidate only after the retention window", () => {
    const db = freshDb();
    const rec = record(db, { expiresAt: "2026-08-06T00:30:00.000Z" });
    expect(() =>
      expireAdaptiveCandidate(db, {
        tenantId: "tenant-a",
        id: rec.id,
        observedAt: "2026-08-06T00:15:00.000Z",
      }),
    ).toThrow("transformer_adaptive_candidate_not_expired");
    const expired = expireAdaptiveCandidate(db, {
      tenantId: "tenant-a",
      id: rec.id,
      observedAt: "2026-08-06T01:00:00.000Z",
    });
    expect(expired.status).toBe("expired");
  });

  it("expires instead of approving at the exact retention boundary", () => {
    const db = freshDb();
    const expiresAt = "2026-08-06T00:30:00.000Z";
    const rec = record(db, { expiresAt });
    const result = reviewAdaptiveCandidate(db, {
      tenantId: "tenant-a",
      id: rec.id,
      decision: "approve",
      reviewerPrincipalId: "human:reviewer-1",
      now: expiresAt,
    });
    expect(result.status).toBe("expired");
    expect(result.reviewDecision).toBeNull();
  });

  it("preserves a human approval through queued delivery after the review window", () => {
    const db = freshDb();
    const rec = record(db, { expiresAt: "2026-08-06T02:00:00.000Z" });
    reviewAdaptiveCandidate(db, {
      tenantId: "tenant-a",
      id: rec.id,
      decision: "approve",
      reviewerPrincipalId: "human:reviewer-1",
      now: "2026-08-06T01:00:00.000Z",
    });
    const result = promoteAdaptiveCandidate(db, {
      tenantId: "tenant-a",
      id: rec.id,
      now: "2026-08-06T02:00:00.000Z",
    });
    expect(result.status).toBe("promoted");
    expect(result.promotedAt).toBe("2026-08-06T02:00:00.000Z");
    expect(() =>
      expireAdaptiveCandidate(db, {
        tenantId: "tenant-a",
        id: rec.id,
        observedAt: "2026-08-06T03:00:00.000Z",
      }),
    ).toThrow("transformer_adaptive_candidate_not_expirable");
  });

  it("isolates tenants: another tenant cannot see, review, or promote the candidate", () => {
    const db = freshDb();
    const rec = record(db);
    expect(getAdaptiveCandidate(db, "tenant-b", rec.id)).toBeUndefined();
    expect(listAdaptiveCandidates(db, "tenant-b")).toHaveLength(0);
    expect(() =>
      reviewAdaptiveCandidate(db, {
        tenantId: "tenant-b",
        id: rec.id,
        decision: "approve",
        reviewerPrincipalId: "human:intruder",
      }),
    ).toThrow("transformer_adaptive_candidate_not_found");
    expect(() => promoteAdaptiveCandidate(db, { tenantId: "tenant-b", id: rec.id })).toThrow(
      "transformer_adaptive_candidate_not_found",
    );
  });

  it("keeps every attention candidate visible behind terminal history and paginates history exactly once", () => {
    const db = freshDb();
    const pending = record(db, {
      unitId: "attention-pending",
      attemptId: "tfattempt_attention_pending",
      now: "2026-08-01T00:00:00.000Z",
    });
    const approved = record(db, {
      unitId: "attention-approved",
      attemptId: "tfattempt_attention_approved",
      now: "2026-08-01T00:00:01.000Z",
    });
    reviewAdaptiveCandidate(db, {
      tenantId: "tenant-a",
      id: approved.id,
      decision: "approve",
      reviewerPrincipalId: "human:reviewer-1",
      now: "2026-08-01T00:01:00.000Z",
    });
    const terminalIds: string[] = [];
    for (let index = 0; index < 105; index += 1) {
      const createdAt = new Date(Date.parse("2026-08-02T00:00:00.000Z") + index * 1_000)
        .toISOString();
      const candidate = record(db, {
        unitId: `terminal-${index.toString().padStart(3, "0")}`,
        attemptId: `tfattempt_terminal_${index.toString().padStart(3, "0")}`,
        now: createdAt,
      });
      reviewAdaptiveCandidate(db, {
        tenantId: "tenant-a",
        id: candidate.id,
        decision: "reject",
        reviewerPrincipalId: "human:reviewer-1",
        now: createdAt,
      });
      terminalIds.push(candidate.id);
    }
    record(db, {
      tenantId: "tenant-b",
      campaignId: "campaign-b",
      unitId: "tenant-b-pending",
      attemptId: "tfattempt_tenant_b",
    });

    expect(listAdaptiveAttentionCandidates(db, "tenant-a").map((row) => row.id).sort())
      .toEqual([approved.id, pending.id].sort());
    expect(listAdaptiveAttentionCandidates(db, "tenant-b")).toHaveLength(1);

    const visited: string[] = [];
    let cursor: { updatedAt: string; id: string } | undefined;
    do {
      const page = listAdaptiveCandidateHistory(db, {
        tenantId: "tenant-a",
        limit: 17,
        cursor,
      });
      expect(page.records.length).toBeLessThanOrEqual(17);
      visited.push(...page.records.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(visited).toHaveLength(105);
    expect(new Set(visited).size).toBe(105);
    expect(new Set(visited)).toEqual(new Set(terminalIds));
  });

  it("fails closed when reviewing an unknown id", () => {
    const db = freshDb();
    expect(() =>
      reviewAdaptiveCandidate(db, {
        tenantId: "tenant-a",
        id: "tfadapt_missing",
        decision: "approve",
        reviewerPrincipalId: "human:reviewer-1",
      }),
    ).toThrow("transformer_adaptive_candidate_not_found");
  });
});
