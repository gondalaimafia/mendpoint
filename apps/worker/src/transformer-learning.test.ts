import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getLearningRecord,
  getLearningRecordRedactedContent,
  grantLearningConsent,
  insertPrincipal,
  insertTenant,
  type AppDb,
  type TransformerAdaptiveCandidateRecord,
} from "@mendpoint/db";
import type {
  AdaptiveCandidateArtifact,
  AdaptiveRepairPlannerInput,
  LearningPrecedentEntry,
} from "@mendpoint/transformer";
import {
  admitApprovedOutcomeContentLearningRecord,
  admitApprovedOutcomeLearningRecord,
} from "./transformer-learning-producer.js";
import {
  buildApprovedOutcome,
  serializeApprovedOutcome,
} from "./transformer-learning-outcome.js";
import { admitRejectedOutcomeLearningRecord } from "./transformer-learning-rejected.js";
import {
  buildLearningPrecedent,
  sealApprovedLearningOutcomes,
} from "./transformer-learning-consumer.js";
import { enrichPlannerInputWithPrecedent } from "./transformer-adaptive-planner.js";

const TENANT = "tenant-a";
const HUMAN = "human-tenant-a";
const AT = "2026-08-01T00:00:00.000Z";
const OBSERVED = "2026-08-01T10:00:00.000Z";
const NOW = "2026-08-01T12:00:00.000Z";
const ON = Object.freeze({ MENDPOINT_TRANSFORMER_LEARNING_ENABLED: "1" }) as NodeJS.ProcessEnv;
const OFF = Object.freeze({}) as NodeJS.ProcessEnv;

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
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-tf-learning-"));
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
  return db;
}

function grant(db: AppDb): void {
  grantLearningConsent(db, {
    id: "consent-a",
    tenantId: TENANT,
    consentVersion: 1,
    purpose: "transformer-adaptive-repair",
    residencyRegion: "us-east",
    authorizedByPrincipalId: HUMAN,
    effectiveAt: AT,
    expiresAt: "2026-12-01T00:00:00.000Z",
    reason: "Authorized adaptive-repair improvement",
    idempotencyKey: "grant-a",
    createdAt: AT,
  });
}

function grantContent(db: AppDb, residencyRegion = "eu-west"): void {
  grantLearningConsent(db, {
    id: "consent-content",
    tenantId: TENANT,
    consentVersion: 1,
    purpose: "transformer-adaptive-training-content",
    residencyRegion,
    authorizedByPrincipalId: HUMAN,
    effectiveAt: AT,
    expiresAt: "2026-12-01T00:00:00.000Z",
    reason: "Authorized after-content capture",
    idempotencyKey: "grant-content",
    createdAt: AT,
  });
}

function grantRejected(db: AppDb, residencyRegion = "ap-south"): void {
  grantLearningConsent(db, {
    id: "consent-rejected",
    tenantId: TENANT,
    consentVersion: 1,
    purpose: "transformer-adaptive-rejected-outcomes",
    residencyRegion,
    authorizedByPrincipalId: HUMAN,
    effectiveAt: AT,
    expiresAt: "2026-12-01T00:00:00.000Z",
    reason: "Authorized rejected-outcome capture",
    idempotencyKey: "grant-rejected",
    createdAt: AT,
  });
}

function learningRecordCount(db: AppDb): number {
  const row = db.raw
    .prepare("SELECT COUNT(*) AS n FROM learning_records WHERE tenant_id = ?")
    .get(TENANT) as { n: number };
  return row.n;
}

function candidate(
  overrides: Partial<{
    id: string;
    reviewDecision: "approve" | "reject" | "regenerate" | null;
    reviewedAt: string | null;
    rationale: string;
    paths: readonly string[];
    family: string | null;
    provider: string | null;
    framework: string | null;
  }> = {},
): TransformerAdaptiveCandidateRecord {
  return {
    id: overrides.id ?? "tfadapt_candidate_1",
    family: overrides.family ?? null,
    provider: overrides.provider ?? null,
    framework: overrides.framework ?? null,
    tenantId: TENANT,
    campaignId: "camp-1",
    unitId: "unit-1",
    attemptId: "attempt-1",
    repositoryId: "repo-1",
    snapshotId: "snap-1",
    baseBranch: "main",
    expectedBaseRevision: "a".repeat(40),
    kind: "adaptive",
    status: "approved",
    divergedFromDigest: `sha256:${"1".repeat(64)}`,
    candidateDigest: `sha256:${"2".repeat(64)}`,
    failingCommandId: "npm-test",
    sealedPath: "/tmp/seal.json",
    sealedSha256: `sha256:${"3".repeat(64)}`,
    changedPaths: overrides.paths ?? ["src/app.ts"],
    reviewerPrincipalId: overrides.reviewDecision === null ? null : HUMAN,
    reviewDecision: overrides.reviewDecision === undefined ? "approve" : overrides.reviewDecision,
    reviewRationale: overrides.rationale ?? "Approved: the fix is scoped and correct.",
    reviewedAt: overrides.reviewedAt === undefined ? OBSERVED : overrides.reviewedAt,
    promotedAt: null,
    supersedesCandidateId: null,
    supersededByCandidateId: null,
    generation: 1,
    expiresAt: "2026-08-02T00:00:00.000Z",
    createdAt: AT,
    updatedAt: OBSERVED,
  } as unknown as TransformerAdaptiveCandidateRecord;
}

function artifact(rationale = "Adjust the client call to the new signature."): AdaptiveCandidateArtifact {
  return {
    schemaVersion: 5,
    kind: "adaptive",
    tenantId: TENANT,
    campaignId: "camp-1",
    unitId: "unit-1",
    attemptId: "attempt-1",
    repositoryId: "repo-1",
    snapshotId: "snap-1",
    baseBranch: "main",
    expectedBaseRevision: "a".repeat(40),
    divergedFromDigest: `sha256:${"1".repeat(64)}`,
    candidateDigest: `sha256:${"2".repeat(64)}`,
    failingCommandId: "npm-test",
    changedPaths: ["src/app.ts"],
    adaptiveChangedPaths: ["src/app.ts"],
    files: { "src/app.ts": "export const x = 1;\n" },
    fileModes: { "src/app.ts": "100644" },
    review: {
      schemaVersion: 1,
      edits: [
        {
          path: "src/app.ts",
          changeType: "modify",
          beforeContent: "export const x = 0;\n",
          beforeDigest: `sha256:${"4".repeat(64)}`,
          beforeMode: "100644",
          afterDigest: `sha256:${"5".repeat(64)}`,
          afterMode: "100644",
          semanticCategory: "behavior",
          rationale,
          risk: "low",
          confidence: 90,
        },
      ],
      verification: {
        passed: true,
        commandId: "npm-test",
        summary: "All tests pass after the adjustment.",
        outputDigest: `sha256:${"6".repeat(64)}`,
      },
      overallRisk: "low",
      confidence: 90,
    },
    reviewDigest: `sha256:${"7".repeat(64)}`,
  } as unknown as AdaptiveCandidateArtifact;
}

function recordCount(db: AppDb): number {
  const row = db.raw
    .prepare("SELECT COUNT(*) AS n FROM learning_records WHERE tenant_id = ?")
    .get(TENANT) as { n: number };
  return row.n;
}

describe("transformer learning producer", () => {
  it("admits a learning record when consent is present", () => {
    const db = setup();
    grant(db);
    const result = admitApprovedOutcomeLearningRecord({
      db,
      tenantId: TENANT,
      candidate: candidate(),
      artifact: artifact(),
      now: NOW,
      env: ON,
    });
    expect(result.admitted).toBe(true);
    expect(result.recordId).toBeDefined();
    expect(recordCount(db)).toBe(1);
    const record = getLearningRecord(db, TENANT, result.recordId!);
    expect(record?.consent_id).toBe("consent-a");
    expect(record?.purpose).toBe("transformer-adaptive-repair");
    expect(record?.residency_region).toBe("us-east");
    // The record carries redaction evidence with the learning-redaction tool.
    const evidence = db.raw
      .prepare("SELECT tool, verdict FROM evidence_records WHERE id = ?")
      .get(record!.redaction_evidence_id) as { tool: string; verdict: string };
    expect(evidence.tool).toBe("learning-redaction");
    expect(evidence.verdict).toBe("passed");
  });

  it("admits nothing when consent is absent", () => {
    const db = setup();
    const result = admitApprovedOutcomeLearningRecord({
      db,
      tenantId: TENANT,
      candidate: candidate(),
      artifact: artifact(),
      now: NOW,
      env: ON,
    });
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe("no_active_consent");
    expect(recordCount(db)).toBe(0);
  });

  it("admits nothing for an unapproved or rejected candidate", () => {
    const db = setup();
    grant(db);
    for (const decision of ["reject", null] as const) {
      const result = admitApprovedOutcomeLearningRecord({
        db,
        tenantId: TENANT,
        candidate: candidate({ reviewDecision: decision }),
        artifact: artifact(),
        now: NOW,
        env: ON,
      });
      expect(result.admitted).toBe(false);
      expect(result.reason).toBe("not_approved");
    }
    expect(recordCount(db)).toBe(0);
  });

  it("redacts secrets out of the stored learning content", () => {
    const db = setup();
    grant(db);
    const secret = `ghp_${"aB3dE7gH9jK1mN4pQ6rT8uV0wX2yZ5cD7eF"}`;
    const result = admitApprovedOutcomeLearningRecord({
      db,
      tenantId: TENANT,
      candidate: candidate(),
      artifact: artifact(`Rotate away from the leaked token ${secret} before shipping.`),
      now: NOW,
      env: ON,
    });
    expect(result.admitted).toBe(true);
    const content = getLearningRecordRedactedContent(db, TENANT, result.recordId!);
    expect(content).toBeTruthy();
    expect(content).not.toContain(secret);
    expect(content).toContain("[REDACTED");
  });

  it("admits nothing and does not alter state when the flag is off", () => {
    const db = setup();
    grant(db);
    const result = admitApprovedOutcomeLearningRecord({
      db,
      tenantId: TENANT,
      candidate: candidate(),
      artifact: artifact(),
      now: NOW,
      env: OFF,
    });
    expect(result).toEqual({ admitted: false, reason: "disabled" });
    expect(recordCount(db)).toBe(0);
    // No artifacts, evidence, or reviews were written either.
    const artifacts = db.raw
      .prepare("SELECT COUNT(*) AS n FROM artifact_manifests WHERE tenant_id = ?")
      .get(TENANT) as { n: number };
    expect(artifacts.n).toBe(0);
  });

  it("is idempotent across repeated admission of the same outcome", () => {
    const db = setup();
    grant(db);
    const first = admitApprovedOutcomeLearningRecord({
      db, tenantId: TENANT, candidate: candidate(), artifact: artifact(), now: NOW, env: ON,
    });
    const second = admitApprovedOutcomeLearningRecord({
      db, tenantId: TENANT, candidate: candidate(), artifact: artifact(), now: NOW, env: ON,
    });
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(true);
    expect(second.reason).toBe("already_admitted");
    expect(recordCount(db)).toBe(1);
  });
});

describe("transformer after-content producer (opt-in content purpose)", () => {
  function contentDoc(db: AppDb, recordId: string): Record<string, unknown> {
    const content = getLearningRecordRedactedContent(db, TENANT, recordId);
    expect(content).toBeTruthy();
    return JSON.parse(content!) as Record<string, unknown>;
  }

  it("captures redacted after-content as its own record under the content consent", () => {
    const db = setup();
    grant(db);
    grantContent(db, "eu-west");
    const result = admitApprovedOutcomeContentLearningRecord({
      db,
      tenantId: TENANT,
      candidate: candidate(),
      artifact: artifact(),
      now: NOW,
      env: ON,
    });
    expect(result.admitted).toBe(true);
    const record = getLearningRecord(db, TENANT, result.recordId!);
    // Residency inherits from the content consent, not the base consent.
    expect(record?.purpose).toBe("transformer-adaptive-training-content");
    expect(record?.residency_region).toBe("eu-west");
    expect(record?.consent_id).toBe("consent-content");
    const doc = contentDoc(db, result.recordId!);
    expect(doc.afterContent).toEqual([
      {
        path: "src/app.ts",
        changeType: "modify",
        beforeContent: "export const x = 0;\n",
        afterContent: "export const x = 1;\n",
      },
    ]);
  });

  it("does NOT capture after-content without the content consent (base stays byte-identical)", () => {
    const db = setup();
    grant(db); // base consent only, no content consent
    const base = admitApprovedOutcomeLearningRecord({
      db,
      tenantId: TENANT,
      candidate: candidate(),
      artifact: artifact(),
      now: NOW,
      env: ON,
    });
    expect(base.admitted).toBe(true);
    const before = learningRecordCount(db);
    const content = admitApprovedOutcomeContentLearningRecord({
      db,
      tenantId: TENANT,
      candidate: candidate(),
      artifact: artifact(),
      now: NOW,
      env: ON,
    });
    expect(content.admitted).toBe(false);
    expect(content.reason).toBe("no_active_consent");
    // No extra learning record was written: exactly the base record remains.
    expect(learningRecordCount(db)).toBe(before);
  });

  it("scrubs secrets out of the stored after-content bytes", () => {
    const db = setup();
    grant(db);
    grantContent(db);
    const secret = `ghp_${"aB3dE7gH9jK1mN4pQ6rT8uV0wX2yZ5cD7eF"}`;
    const leaky = {
      ...artifact(),
      files: { "src/app.ts": `export const x = 1; // rotate ${secret} before shipping\n` },
    } as unknown as AdaptiveCandidateArtifact;
    const result = admitApprovedOutcomeContentLearningRecord({
      db,
      tenantId: TENANT,
      candidate: candidate(),
      artifact: leaky,
      now: NOW,
      env: ON,
    });
    expect(result.admitted).toBe(true);
    const content = getLearningRecordRedactedContent(db, TENANT, result.recordId!);
    expect(content).not.toContain(secret);
    expect(content).toContain("[REDACTED");
  });

  it("fails closed (stores nothing) when redacting the after-content would not yield valid JSON", () => {
    const db = setup();
    grant(db);
    grantContent(db);
    const secret = `ghp_${"aB3dE7gH9jK1mN4pQ6rT8uV0wX2yZ5cD7eF"}`;
    // A quoted secret assignment redacts to text that breaks JSON quoting; the
    // wrapper refuses it rather than storing a weaker/partial scrub.
    const leaky = {
      ...artifact(),
      files: { "src/app.ts": `export const token = "${secret}";\n` },
    } as unknown as AdaptiveCandidateArtifact;
    const result = admitApprovedOutcomeContentLearningRecord({
      db,
      tenantId: TENANT,
      candidate: candidate(),
      artifact: leaky,
      now: NOW,
      env: ON,
    });
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe("redaction_unparseable");
    expect(learningRecordCount(db)).toBe(0);
  });

  it("captures nothing and writes nothing when the flag is off", () => {
    const db = setup();
    grant(db);
    grantContent(db);
    const result = admitApprovedOutcomeContentLearningRecord({
      db,
      tenantId: TENANT,
      candidate: candidate(),
      artifact: artifact(),
      now: NOW,
      env: OFF,
    });
    expect(result).toEqual({ admitted: false, reason: "disabled" });
    expect(learningRecordCount(db)).toBe(0);
  });

  it("captures nothing for an unapproved candidate", () => {
    const db = setup();
    grant(db);
    grantContent(db);
    const result = admitApprovedOutcomeContentLearningRecord({
      db,
      tenantId: TENANT,
      candidate: candidate({ reviewDecision: "reject" }),
      artifact: artifact(),
      now: NOW,
      env: ON,
    });
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe("not_approved");
  });
});

describe("transformer rejected-outcome producer (opt-in negatives purpose)", () => {
  function rejectedCandidate(rationale = "Rejected: the fix hides the real defect.") {
    return candidate({ reviewDecision: "reject", rationale });
  }

  it("captures a redacted, labeled negative record under the rejected consent", () => {
    const db = setup();
    grantRejected(db, "ap-south");
    const result = admitRejectedOutcomeLearningRecord({
      db,
      tenantId: TENANT,
      candidate: rejectedCandidate(),
      artifact: artifact(),
      now: NOW,
      env: ON,
    });
    expect(result.admitted).toBe(true);
    const record = getLearningRecord(db, TENANT, result.recordId!);
    expect(record?.purpose).toBe("transformer-adaptive-rejected-outcomes");
    expect(record?.residency_region).toBe("ap-south");
    const content = getLearningRecordRedactedContent(db, TENANT, result.recordId!);
    const doc = JSON.parse(content!) as Record<string, unknown>;
    expect(doc.decision).toBe("rejected");
    expect(doc.rejectionRationale).toBe("Rejected: the fix hides the real defect.");
  });

  it("captures nothing for an approved candidate", () => {
    const db = setup();
    grantRejected(db);
    const result = admitRejectedOutcomeLearningRecord({
      db,
      tenantId: TENANT,
      candidate: candidate(), // approved
      artifact: artifact(),
      now: NOW,
      env: ON,
    });
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe("not_rejected");
  });

  it("captures nothing without the rejected-outcome consent (fail closed)", () => {
    const db = setup();
    grant(db); // base consent only; no rejected-outcome consent
    const result = admitRejectedOutcomeLearningRecord({
      db,
      tenantId: TENANT,
      candidate: rejectedCandidate(),
      artifact: artifact(),
      now: NOW,
      env: ON,
    });
    expect(result.admitted).toBe(false);
    expect(result.reason).toBe("no_active_consent");
    expect(learningRecordCount(db)).toBe(0);
  });

  it("scrubs secrets out of the stored rejection rationale", () => {
    const db = setup();
    grantRejected(db);
    const secret = `ghp_${"aB3dE7gH9jK1mN4pQ6rT8uV0wX2yZ5cD7eF"}`;
    const result = admitRejectedOutcomeLearningRecord({
      db,
      tenantId: TENANT,
      candidate: rejectedCandidate(`Rejected: rotate the leaked token ${secret} first.`),
      artifact: artifact(),
      now: NOW,
      env: ON,
    });
    expect(result.admitted).toBe(true);
    const content = getLearningRecordRedactedContent(db, TENANT, result.recordId!);
    expect(content).not.toContain(secret);
    expect(content).toContain("[REDACTED");
  });

  it("captures nothing and writes nothing when the flag is off", () => {
    const db = setup();
    grantRejected(db);
    const result = admitRejectedOutcomeLearningRecord({
      db,
      tenantId: TENANT,
      candidate: rejectedCandidate(),
      artifact: artifact(),
      now: NOW,
      env: OFF,
    });
    expect(result).toEqual({ admitted: false, reason: "disabled" });
    expect(learningRecordCount(db)).toBe(0);
  });
});

describe("transformer learning consumer", () => {
  function admitOutcome(db: AppDb, id: string, reviewedAt: string, rationale: string): string {
    const result = admitApprovedOutcomeLearningRecord({
      db,
      tenantId: TENANT,
      candidate: candidate({ id, reviewedAt, rationale }),
      artifact: artifact(rationale),
      now: NOW,
      env: ON,
    });
    expect(result.admitted).toBe(true);
    return result.recordId!;
  }

  it("seals only eligible approved members and surfaces them as precedent", () => {
    const db = setup();
    grant(db);
    admitOutcome(db, "tfadapt_a", "2026-08-01T10:00:00.000Z", "Fix A, scoped and correct.");
    admitOutcome(db, "tfadapt_b", "2026-08-01T10:30:00.000Z", "Fix B, scoped and correct.");

    // Cutoff sits between the two outcomes: only A is eligible.
    const sealed = sealApprovedLearningOutcomes({
      db,
      tenantId: TENANT,
      temporalCutoffAt: "2026-08-01T10:15:00.000Z",
      createdByPrincipalId: HUMAN,
      sealedByPrincipalId: HUMAN,
      now: NOW,
      env: ON,
    });
    expect(sealed.sealed).toBe(true);
    expect(sealed.memberCount).toBe(1);

    const precedent = buildLearningPrecedent({ db, tenantId: TENANT, at: NOW, env: ON });
    expect(precedent).toHaveLength(1);
    expect(precedent[0].edits[0].rationale).toContain("Fix A");
    expect(precedent[0].contentSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("surfaces nothing before a dataset is sealed", () => {
    const db = setup();
    grant(db);
    admitOutcome(db, "tfadapt_a", "2026-08-01T10:00:00.000Z", "Fix A, scoped and correct.");
    expect(buildLearningPrecedent({ db, tenantId: TENANT, at: NOW, env: ON })).toEqual([]);
  });

  it("surfaces nothing when the flag is off", () => {
    const db = setup();
    grant(db);
    admitOutcome(db, "tfadapt_a", "2026-08-01T10:00:00.000Z", "Fix A, scoped and correct.");
    sealApprovedLearningOutcomes({
      db,
      tenantId: TENANT,
      temporalCutoffAt: "2026-08-01T11:00:00.000Z",
      createdByPrincipalId: HUMAN,
      sealedByPrincipalId: HUMAN,
      now: NOW,
      env: ON,
    });
    expect(buildLearningPrecedent({ db, tenantId: TENANT, at: NOW, env: OFF })).toEqual([]);
  });

  it("refuses to seal without an active consent", () => {
    const db = setup();
    const result = sealApprovedLearningOutcomes({
      db,
      tenantId: TENANT,
      temporalCutoffAt: "2026-08-01T11:00:00.000Z",
      createdByPrincipalId: HUMAN,
      sealedByPrincipalId: HUMAN,
      now: NOW,
      env: ON,
    });
    expect(result.sealed).toBe(false);
    expect(result.reason).toBe("no_active_consent");
  });
});

describe("planner precedent enrichment", () => {
  function plannerInput(): AdaptiveRepairPlannerInput {
    return {
      schemaVersion: 1,
      unitId: "unit-1",
      goal: "migrate",
      recipe: {} as AdaptiveRepairPlannerInput["recipe"],
      iteration: 1,
      failingCommandId: null,
      verifierOutput: "",
      context: [],
      allowedMutationPaths: [],
      priorChangedPaths: [],
    };
  }
  const entry: LearningPrecedentEntry = {
    contentSha256: "a".repeat(64),
    failingCommandId: "npm-test",
    overallRisk: "low",
    confidence: 90,
    changedPaths: ["src/app.ts"],
    edits: [{ path: "src/app.ts", semanticCategory: "behavior", risk: "low", rationale: "ok" }],
    verificationSummary: "passed",
    verificationCommandId: "npm-test",
    observedAt: OBSERVED,
  };

  it("returns the same input reference when no supplier is given", () => {
    const input = plannerInput();
    expect(enrichPlannerInputWithPrecedent(input)).toBe(input);
  });

  it("returns the same input reference when the supplier yields no precedent", () => {
    const input = plannerInput();
    expect(enrichPlannerInputWithPrecedent(input, () => [])).toBe(input);
  });

  it("attaches precedent when the supplier yields entries", () => {
    const input = plannerInput();
    const enriched = enrichPlannerInputWithPrecedent(input, () => [entry]);
    expect(enriched).not.toBe(input);
    expect(enriched.precedent).toEqual([entry]);
  });

  it("falls back to the unchanged input when the supplier throws", () => {
    const input = plannerInput();
    const enriched = enrichPlannerInputWithPrecedent(input, () => {
      throw new Error("boom");
    });
    expect(enriched).toBe(input);
  });
});

describe("buildApprovedOutcome classification labels", () => {
  it("embeds the candidate's real labels and omits nulls for byte-identity", () => {
    const labeled = buildApprovedOutcome(
      candidate({ family: "sdk", provider: "aws-sdk-js", framework: null }),
      artifact(),
      OBSERVED,
    );
    expect(labeled.family).toBe("sdk");
    expect(labeled.provider).toBe("aws-sdk-js");
    expect("framework" in labeled).toBe(false);

    // A null-label (legacy/undeterminable) candidate serializes byte-identically to
    // the pre-labeling document: no family/provider/framework keys at all.
    const bare = buildApprovedOutcome(candidate(), artifact(), OBSERVED);
    const serialized = serializeApprovedOutcome(bare);
    expect(serialized).not.toContain("family");
    expect(serialized).not.toContain("provider");
    expect(serialized).not.toContain("framework");
  });
});
