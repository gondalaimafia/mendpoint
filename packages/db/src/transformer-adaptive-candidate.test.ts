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
  signOffAdaptiveEscalation,
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

  it("persists deterministic classification labels and normalizes unknown values to null", () => {
    const db = freshDb();
    const labeled = record(db, {
      attemptId: "tfattempt_sdk",
      unitId: "unit-sdk",
      family: "sdk",
      provider: "aws-sdk-js",
      framework: null,
    });
    expect(labeled.family).toBe("sdk");
    expect(labeled.provider).toBe("aws-sdk-js");
    expect(labeled.framework).toBeNull();
    expect(getAdaptiveCandidate(db, "tenant-a", labeled.id)?.provider).toBe("aws-sdk-js");

    // A candidate with no bound recipe stores null labels (honest undeterminable).
    const bare = record(db, { attemptId: "tfattempt_bare", unitId: "unit-bare" });
    expect(bare.family).toBeNull();
    expect(bare.provider).toBeNull();
    expect(bare.framework).toBeNull();

    // An out-of-vocabulary family is coerced to null rather than blocking the row.
    const coerced = record(db, {
      attemptId: "tfattempt_coerce",
      unitId: "unit-coerce",
      family: "not-a-real-family",
      provider: "  ",
    });
    expect(coerced.family).toBeNull();
    expect(coerced.provider).toBeNull();
  });

  it("converges a pre-labeling DB on boot: adds null-label columns, keeps legacy rows intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-adaptive-boot-"));
    dirs.push(dir);
    const path = join(dir, "boot.sqlite");

    // Build the CURRENT schema, then simulate a PRE-change (pre-labeling) database
    // by dropping the three new columns before any migration runs.
    const seed = createDb(path);
    dbs.push(seed);
    for (const column of ["family", "provider", "framework"]) {
      seed.raw.exec(`ALTER TABLE regauge_adaptive_candidates DROP COLUMN ${column}`);
    }
    const preColumns = (
      seed.raw.prepare("PRAGMA table_info(regauge_adaptive_candidates)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(preColumns).not.toContain("family");
    expect(preColumns).not.toContain("provider");
    expect(preColumns).not.toContain("framework");

    // Insert a legacy row against the pre-change shape (no label columns exist yet).
    seed.raw.exec(
      `INSERT INTO regauge_adaptive_candidates
        (id, tenant_id, campaign_id, unit_id, attempt_id, repository_id, snapshot_id,
         base_branch, expected_base_revision, kind, status, review_tier,
         diverged_from_digest, candidate_digest, failing_command_id,
         sealed_path, sealed_sha256, changed_paths_json, generation,
         expires_at, created_at, updated_at)
       VALUES ('tfadapt_legacy', 'tenant-a', 'campaign-1', 'unit-legacy', 'tfattempt_legacy',
         'repo-1', 'snapshot-1', 'main', '${"e".repeat(40)}', 'adaptive', 'review_pending',
         'standard', '${DIVERGED}', '${CANDIDATE}', 'verify:typecheck',
         '/data/x.json', '${SEAL}', '["package.json"]', 1,
         '2099-01-01T00:00:00.000Z', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z')`,
    );
    seed.raw.close();
    dbs.pop();

    // Boot again over the SAME file. The static DDL is a no-op (table exists) and the
    // additive migration must add the columns without crashing or losing data.
    const upgraded = createDb(path);
    dbs.push(upgraded);
    const postColumns = (
      upgraded.raw.prepare("PRAGMA table_info(regauge_adaptive_candidates)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(postColumns).toContain("family");
    expect(postColumns).toContain("provider");
    expect(postColumns).toContain("framework");

    // The legacy row survived, reads with null labels, and keeps every other field.
    const legacy = getAdaptiveCandidate(upgraded, "tenant-a", "tfadapt_legacy");
    expect(legacy?.status).toBe("review_pending");
    expect(legacy?.candidateDigest).toBe(CANDIDATE);
    expect(legacy?.family).toBeNull();
    expect(legacy?.provider).toBeNull();
    expect(legacy?.framework).toBeNull();

    // A post-migration write persists real labels through the upgraded schema.
    const fresh = record(upgraded, {
      attemptId: "tfattempt_post",
      unitId: "unit-post",
      family: "runtime",
      provider: "node",
    });
    expect(fresh.family).toBe("runtime");
    expect(fresh.provider).toBe("node");
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

  it("defaults to the standard tier and keeps single-approval behavior unchanged", () => {
    const db = freshDb();
    const rec = record(db);
    expect(rec.reviewTier).toBe("standard");
    expect(rec.escalationReviewerPrincipalId).toBeNull();
    // A standard candidate approves with a single human, exactly as before.
    const approved = reviewAdaptiveCandidate(db, {
      tenantId: "tenant-a",
      id: rec.id,
      decision: "approve",
      reviewerPrincipalId: "human:reviewer-1",
      now: "2026-08-06T01:00:00.000Z",
    });
    expect(approved.status).toBe("approved");
    // Signing off a standard candidate is not applicable.
    expect(() =>
      signOffAdaptiveEscalation(db, {
        tenantId: "tenant-a",
        id: rec.id,
        reviewerPrincipalId: "human:senior-1",
        rationale: "not needed",
      }),
    ).toThrow("transformer_adaptive_candidate_escalation_not_required");
  });

  it("escalated: a single standard approval is insufficient; needs a distinct second sign-off", () => {
    const db = freshDb();
    const rec = record(db, { reviewTier: "escalated" });
    expect(rec.reviewTier).toBe("escalated");
    // Approval without any escalation sign-off is refused.
    expect(() =>
      reviewAdaptiveCandidate(db, {
        tenantId: "tenant-a",
        id: rec.id,
        decision: "approve",
        reviewerPrincipalId: "human:reviewer-1",
        now: "2026-08-06T01:00:00.000Z",
      }),
    ).toThrow("transformer_adaptive_candidate_escalation_required");
    expect(getAdaptiveCandidate(db, "tenant-a", rec.id)?.status).toBe("review_pending");
    // The escalation sign-off records a second human but does not approve.
    const signed = signOffAdaptiveEscalation(db, {
      tenantId: "tenant-a",
      id: rec.id,
      reviewerPrincipalId: "human:senior-1",
      rationale: "Second sign-off: reviewed the high-risk change and it is safe.",
      now: "2026-08-06T01:05:00.000Z",
    });
    expect(signed.status).toBe("review_pending");
    expect(signed.escalationReviewerPrincipalId).toBe("human:senior-1");
    // The signer cannot also be the approver (must be two distinct humans).
    expect(() =>
      reviewAdaptiveCandidate(db, {
        tenantId: "tenant-a",
        id: rec.id,
        decision: "approve",
        reviewerPrincipalId: "human:senior-1",
        now: "2026-08-06T01:06:00.000Z",
      }),
    ).toThrow("transformer_adaptive_candidate_escalation_required");
    // A distinct approver finalizes through the unchanged standard path.
    const approved = reviewAdaptiveCandidate(db, {
      tenantId: "tenant-a",
      id: rec.id,
      decision: "approve",
      reviewerPrincipalId: "human:reviewer-1",
      now: "2026-08-06T01:07:00.000Z",
    });
    expect(approved.status).toBe("approved");
    expect(approved.reviewerPrincipalId).toBe("human:reviewer-1");
    const promoted = promoteAdaptiveCandidate(db, {
      tenantId: "tenant-a",
      id: rec.id,
      now: "2026-08-06T01:08:00.000Z",
    });
    expect(promoted.status).toBe("promoted");
  });

  it("escalation sign-off is idempotent for the same signer and conflicts on a distinct signer", () => {
    const db = freshDb();
    const rec = record(db, { reviewTier: "escalated" });
    const first = signOffAdaptiveEscalation(db, {
      tenantId: "tenant-a",
      id: rec.id,
      reviewerPrincipalId: "human:senior-1",
      rationale: "Second sign-off rationale.",
      now: "2026-08-06T01:00:00.000Z",
    });
    const replay = signOffAdaptiveEscalation(db, {
      tenantId: "tenant-a",
      id: rec.id,
      reviewerPrincipalId: "human:senior-1",
      rationale: "Second sign-off rationale.",
      now: "2026-08-06T01:01:00.000Z",
    });
    expect(replay.escalationReviewedAt).toBe(first.escalationReviewedAt);
    expect(() =>
      signOffAdaptiveEscalation(db, {
        tenantId: "tenant-a",
        id: rec.id,
        reviewerPrincipalId: "human:senior-2",
        rationale: "A different senior tries to sign off.",
        now: "2026-08-06T01:02:00.000Z",
      }),
    ).toThrow("transformer_adaptive_candidate_escalation_conflict");
  });

  it("blocked: cannot be approved or promoted, but can be rejected", () => {
    const db = freshDb();
    const rec = record(db, { reviewTier: "blocked" });
    expect(rec.reviewTier).toBe("blocked");
    expect(() =>
      reviewAdaptiveCandidate(db, {
        tenantId: "tenant-a",
        id: rec.id,
        decision: "approve",
        reviewerPrincipalId: "human:reviewer-1",
        now: "2026-08-06T01:00:00.000Z",
      }),
    ).toThrow("transformer_adaptive_candidate_blocked");
    // Never reaches an approved state, so promotion is impossible.
    expect(() =>
      promoteAdaptiveCandidate(db, {
        tenantId: "tenant-a",
        id: rec.id,
        now: "2026-08-06T01:01:00.000Z",
      }),
    ).toThrow("transformer_adaptive_candidate_not_approved");
    // Rejection is always permitted (it delivers nothing).
    const rejected = reviewAdaptiveCandidate(db, {
      tenantId: "tenant-a",
      id: rec.id,
      decision: "reject",
      reviewerPrincipalId: "human:reviewer-1",
      now: "2026-08-06T01:02:00.000Z",
    });
    expect(rejected.status).toBe("rejected");
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
