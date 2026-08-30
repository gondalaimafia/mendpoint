import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  disableOrganizationMemory,
  getOrganizationMemoryHead,
  grantLearningConsent,
  insertPrincipal,
  insertTenant,
  type AppDb,
} from "@mendpoint/db";
import {
  governedLearningAdmissionIds,
  type LearningSignalClass,
  type LearningVerificationProducer,
} from "@mendpoint/pipeline";
import {
  GOVERNED_LEARNING_PURPOSE,
  admitGovernedLearningOutcome,
  type GovernedLearningOutcomeFacts,
} from "./governed-learning-producer.js";
import { projectGovernedOutcomeToOrganizationMemory } from "./governed-learning-memory.js";

// These tests pin the corpus-integrity fix: the sole production producer used to
// assert `verdict: "passed"` and `contaminationFree: true` as literals, so the
// "insufficient" classification branch (learning-event.ts) was unreachable and the
// contamination gate (learning-operations.ts) could never fire. The verdict is now
// derived from the recorded authority's signal class, and contamination-freedom is
// a caller attestation the gate enforces.

const TENANT = "tenant-verdict";
const HUMAN = "human-verdict";
const RESIDENCY = "us-east";
const AT = "2026-08-01T00:00:00.000Z";
const OBSERVED = "2026-08-01T10:00:00.000Z";
const NOW = "2026-08-01T12:00:00.000Z";

const dirs: string[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-verdict-"));
  dirs.push(dir);
  const db = createDb(join(dir, "app.sqlite"));
  dbs.push(db);
  insertTenant(db, { id: TENANT, slug: TENANT, name: TENANT, createdAt: AT });
  insertPrincipal(db, {
    id: HUMAN,
    tenantId: TENANT,
    kind: "human",
    subject: "reviewer",
    displayName: "Reviewer",
    createdAt: AT,
  });
  grantLearningConsent(db, {
    id: "consent-governed",
    tenantId: TENANT,
    consentVersion: 1,
    purpose: GOVERNED_LEARNING_PURPOSE,
    residencyRegion: RESIDENCY,
    authorizedByPrincipalId: HUMAN,
    effectiveAt: AT,
    expiresAt: "2026-12-01T00:00:00.000Z",
    reason: "Authorized governed learning",
    idempotencyKey: "grant-governed",
    createdAt: AT,
  });
  return db;
}

function facts(
  db: AppDb,
  runId: string,
  overrides: Readonly<{
    signalClass?: LearningSignalClass;
    producedBy?: LearningVerificationProducer;
    contaminationFree?: boolean;
    status?: GovernedLearningOutcomeFacts["outcome"]["status"];
    nullAuthority?: boolean;
  }> = {},
): GovernedLearningOutcomeFacts {
  const signalClass = overrides.signalClass ?? "hard";
  const status = overrides.status ?? "corrected";
  return {
    db,
    tenantId: TENANT,
    consentId: "consent-governed",
    residencyRegion: RESIDENCY,
    product: "fettler",
    sourceObjectType: "fettler_agent_run",
    sourceObjectId: runId,
    repositoryId: "warden-repo-verdict",
    taskType: "api_remediation",
    capability: "remediation_generation",
    specialization: {
      provider: null,
      framework: null,
      language: null,
      runtime: null,
      migrationFamily: "api_remediation",
      riskClass: "medium",
    },
    execution: { modelId: null, adapterId: null, routerDecisionId: `warden_route_${runId}`, fallback: false },
    predictionSummary: "Apply the reviewed Warden repair.",
    outcome: { status, summary: "The repair passed objective verification.", attribution: "model_behavior" },
    reviewerDecision: "accepted",
    correctionSubstantive: true,
    contaminationFree: overrides.contaminationFree ?? true,
    confidence: 0.9,
    verificationAuthority: overrides.nullAuthority
      ? null
      : {
          signalClass,
          producedBy: overrides.producedBy ?? (signalClass === "hard" ? "sandbox_command" : "model_verifier"),
          producerModelId: signalClass === "hard" ? null : "muse-spark-1.2",
        },
    economics: { inputTokens: 100, outputTokens: 20, latencyMs: 500, costUsd: 0.01 },
    sourceClass: "design_partner_verified",
    provenanceQualifiers: signalClass === "hard"
      ? ["deterministically_verified", "reviewer_accepted"]
      : ["reviewer_accepted"],
    mayLeaveTenantBoundary: false,
    revision: "b".repeat(40),
    snapshotDigest: `sha256:${"c".repeat(64)}`,
    scenarioId: null,
    syntheticFamilyId: null,
    reviewerPrincipalId: HUMAN,
    reviewRationale: "Approved in Warden review.",
    observedAt: OBSERVED,
    now: NOW,
  };
}

/** Read back the stored governed lesson document for an admitted event. */
function storedLesson(db: AppDb, eventId: string): {
  verdict: string;
  evidenceStrength: string;
  destinations: ReadonlyArray<{ destination: string; rationale: string }>;
  eligibleForModelTraining: boolean;
} {
  const ids = governedLearningAdmissionIds(TENANT, eventId);
  const row = db.raw
    .prepare("SELECT content_text FROM artifact_manifests WHERE id = ? AND tenant_id = ?")
    .get(ids.redactedArtifactId, TENANT) as { content_text: string | null } | undefined;
  if (!row?.content_text) throw new Error("lesson document not found");
  const doc = JSON.parse(row.content_text) as {
    event: { verification: { verdict: string } };
    lesson: {
      evidenceStrength: string;
      destinations: ReadonlyArray<{ destination: string; rationale: string }>;
      eligibleForModelTraining: boolean;
    };
  };
  return {
    verdict: doc.event.verification.verdict,
    evidenceStrength: doc.lesson.evidenceStrength,
    destinations: doc.lesson.destinations,
    eligibleForModelTraining: doc.lesson.eligibleForModelTraining,
  };
}

describe("governed producer derives the verification verdict from the recorded authority", () => {
  it("projects both product outcomes into tenant-bound, non-active memory candidates", () => {
    const db = setup();
    const fettlerFacts = facts(db, "run-memory-fettler");
    const fettler = admitGovernedLearningOutcome(fettlerFacts);
    const regaugeFacts: GovernedLearningOutcomeFacts = {
      ...facts(db, "candidate-memory-regauge"),
      product: "regauge",
      sourceObjectType: "transformer_adaptive_candidate",
      repositoryId: "regauge-repo-verdict",
      taskType: "legacy_migration",
      specialization: {
        ...fettlerFacts.specialization,
        migrationFamily: "adaptive_repair",
      },
      reviewRationale: `Keep the compatibility adapter; ghp_${"aB1".repeat(14)} must never persist.`,
    };
    const regauge = admitGovernedLearningOutcome(regaugeFacts);

    expect(fettler.memoryProjection?.status).toBe("observed");
    expect(regauge.memoryProjection?.status).toBe("observed");
    for (const result of [fettler, regauge]) {
      if (result.memoryProjection?.status !== "observed") throw new Error("memory projection missing");
      const head = getOrganizationMemoryHead(db, TENANT, result.memoryProjection.memoryId);
      expect(head?.status).toBe("MEMORY_CANDIDATE");
      expect(head?.trainingEligible).toBe(false);
      expect(head?.source).toBe("reviewer_correction");
      expect(head?.sourceRefs).toContain(`learning-event:${result.eventId}`);
    }
    if (regauge.memoryProjection?.status !== "observed") throw new Error("regauge projection missing");
    const regaugeHead = getOrganizationMemoryHead(db, TENANT, regauge.memoryProjection.memoryId);
    expect(regaugeHead?.statement).not.toContain("ghp_");
    expect(regaugeHead?.statement).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("replays the memory projection idempotently", () => {
    const db = setup();
    const input = facts(db, "run-memory-replay");
    const first = admitGovernedLearningOutcome(input);
    const replay = admitGovernedLearningOutcome(input);

    expect(first.admitted).toBe(true);
    expect(replay.reason).toBe("already_admitted");
    expect(replay.memoryProjection).toEqual(first.memoryProjection);
  });

  it("keeps a disabled memory chain from blocking an idempotent admission replay", () => {
    const db = setup();
    const input = facts(db, "run-memory-disabled");
    const first = admitGovernedLearningOutcome(input);
    if (first.memoryProjection?.status !== "observed") throw new Error("memory projection missing");
    disableOrganizationMemory(db, {
      tenantId: TENANT,
      memoryId: first.memoryProjection.memoryId,
      actorPrincipalId: HUMAN,
      reason: "operator rollback",
      at: "2026-08-01T13:00:00.000Z",
    });
    const replay = admitGovernedLearningOutcome({
      ...input,
      now: "2026-08-01T14:00:00.000Z",
    });

    expect(first.admitted).toBe(true);
    expect(replay.admitted).toBe(true);
    expect(replay.reason).toBe("already_admitted");
    expect(replay.memoryProjection).toMatchObject({
      status: "failed",
      reason: "organization_memory_not_open",
    });
    const persisted = db.raw
      .prepare("SELECT COUNT(*) AS count FROM learning_records WHERE tenant_id = ?")
      .get(TENANT) as { count: number };
    expect(persisted.count).toBe(1);
  });

  it("rejects a reviewer principal from another tenant", () => {
    const db = setup();
    insertTenant(db, {
      id: "tenant-other",
      slug: "tenant-other",
      name: "Other tenant",
      createdAt: AT,
    });
    insertPrincipal(db, {
      id: "human-other",
      tenantId: "tenant-other",
      kind: "human",
      subject: "other-reviewer",
      displayName: "Other Reviewer",
      createdAt: AT,
    });

    const projection = projectGovernedOutcomeToOrganizationMemory({
      db,
      tenantId: TENANT,
      product: "fettler",
      repositoryId: "warden-repo-verdict",
      taskType: "api_remediation",
      migrationFamily: "api_remediation",
      outcomeStatus: "corrected",
      reviewerDecision: "accepted",
      reviewerPrincipalId: "human-other",
      reviewRationale: "Prefer the compatibility adapter.",
      eventId: "event-cross-tenant",
      learningRecordId: "record-cross-tenant",
      revision: "b".repeat(40),
      snapshotDigest: `sha256:${"c".repeat(64)}`,
      observedAt: NOW,
    });

    expect(projection).toMatchObject({
      status: "failed",
      reason: "organization_memory_observer_authority_invalid",
    });
    const persisted = db.raw
      .prepare("SELECT COUNT(*) AS count FROM organization_memory WHERE tenant_id = ?")
      .get(TENANT) as { count: number };
    expect(persisted.count).toBe(0);
  });

  it("a soft model_verifier authority cannot produce a passed verdict; the lesson reads insufficient", () => {
    const db = setup();
    const result = admitGovernedLearningOutcome(facts(db, "run-soft", { signalClass: "soft" }));
    expect(result.admitted).toBe(true);

    // The soft authority yields `inconclusive`, never `passed`, so the previously
    // unreachable "insufficient" classification branch now fires.
    const lesson = storedLesson(db, result.eventId!);
    expect(lesson.verdict).toBe("inconclusive");
    expect(lesson.verdict).not.toBe("passed");
    expect(lesson.evidenceStrength).toBe("insufficient");
    expect(lesson.destinations).toEqual([
      { destination: "no_action", rationale: "verification_not_authoritative" },
    ]);
    expect(lesson.eligibleForModelTraining).toBe(false);
  });

  it("a genuinely hard, contamination-checked outcome still admits and stays on the weight path", () => {
    const db = setup();
    const result = admitGovernedLearningOutcome(facts(db, "run-hard", { signalClass: "hard" }));
    expect(result.admitted).toBe(true);

    const lesson = storedLesson(db, result.eventId!);
    expect(lesson.verdict).toBe("passed");
    expect(lesson.evidenceStrength).toBe("high");
    expect(lesson.eligibleForModelTraining).toBe(true);
  });

  it("a failed outcome carried through admission is never eligible to train weights, even with a hard authority", () => {
    // The safety property the whole change turns on: admitting a failure must never
    // make it eligible to train weights. This is the fail-closed case — a hard
    // authority (a deterministic runtime signal that the outcome was negative)
    // paired with a `failed` status. The verdict is derived as `failed`, NOT
    // `passed`, precisely because the outcome did not succeed: "hard" is the
    // signal's authority, not a claim the repair passed. `strength()` then caps the
    // lesson at "insufficient" and it routes only to `no_action`.
    //
    // Load-bearing check: this assertion dies if the verdict derivation in
    // governed-learning-producer.ts is weakened back to `signalClass === "hard" ?
    // "passed" : "inconclusive"` (dropping the outcome-success condition). With that
    // weakening the verdict becomes `passed`, evidence strength becomes "high", the
    // lesson routes to `model_weight`, and `eligibleForModelTraining` flips to true
    // — so the assertions below fail. Verified by temporarily applying the weakening
    // and observing the failure, then restoring.
    const db = setup();
    const result = admitGovernedLearningOutcome(facts(db, "run-failed-hard", { signalClass: "hard", status: "failed" }));
    expect(result.admitted).toBe(true);

    const lesson = storedLesson(db, result.eventId!);
    expect(lesson.verdict).toBe("failed");
    expect(lesson.verdict).not.toBe("passed");
    expect(lesson.evidenceStrength).toBe("insufficient");
    expect(lesson.destinations).toEqual([
      { destination: "no_action", rationale: "verification_not_authoritative" },
    ]);
    expect(lesson.eligibleForModelTraining).toBe(false);
  });

  it("a failed outcome with no verification authority (the honest producer path) is inconclusive and inert", () => {
    // The realistic failure path: the producers record NO correctness-verification
    // authority for a non-success outcome (the explicit not-observed state, null),
    // so the derived verdict is `inconclusive`. This confirms the honest recording
    // yields the same fail-closed result as the hard-authority case above.
    const db = setup();
    const result = admitGovernedLearningOutcome(
      facts(db, "run-failed-null", { status: "rolled_back", nullAuthority: true }),
    );
    expect(result.admitted).toBe(true);

    const lesson = storedLesson(db, result.eventId!);
    expect(lesson.verdict).toBe("inconclusive");
    expect(lesson.evidenceStrength).toBe("insufficient");
    expect(lesson.destinations).toEqual([
      { destination: "no_action", rationale: "verification_not_authoritative" },
    ]);
    expect(lesson.eligibleForModelTraining).toBe(false);
  });

  it("an outcome whose contamination status is not attested is rejected by the admission gate", () => {
    const db = setup();
    const result = admitGovernedLearningOutcome(facts(db, "run-uncontaminated", { contaminationFree: false }));
    // The gate (learning-operations.ts) throws learning_admission_authority_invalid
    // for any contaminationFree !== true; the best-effort producer surfaces it as a
    // non-admission rather than admitting a record the check never cleared.
    expect(result.admitted).toBe(false);
    expect(result.reason).toContain("learning_admission_authority_invalid");

    // Nothing was persisted for the rejected outcome.
    const rows = db.raw
      .prepare("SELECT COUNT(*) AS n FROM learning_records WHERE tenant_id = ?")
      .get(TENANT) as { n: number };
    expect(rows.n).toBe(0);
  });
});
