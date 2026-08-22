import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildLearningCorpus,
  createDb,
  getLearningRecordRedactedContent,
  grantLearningConsent,
  insertPrincipal,
  insertTenant,
  type AppDb,
  type TransformerAdaptiveCandidateRecord,
} from "@mendpoint/db";
import type { AdaptiveCandidateArtifact } from "@mendpoint/transformer";
import {
  governedLearningSplit,
  materializeGovernedLearningCorpus,
} from "@mendpoint/pipeline";
import { admitApprovedOutcomeLearningRecord } from "./transformer-learning-producer.js";
import { admitTransformerGovernedLearningEvent } from "./transformer-governed-learning-producer.js";
import { sealApprovedLearningOutcomes } from "./transformer-learning-consumer.js";
import {
  GOVERNED_LEARNING_PURPOSE,
  admitGovernedLearningOutcome,
} from "./governed-learning-producer.js";

const TENANT = "tenant-iso";
const HUMAN = "human-iso";
const RESIDENCY = "us-east";
const LEGACY_PURPOSE = "transformer-adaptive-repair";
const AT = "2026-08-01T00:00:00.000Z";
const OBSERVED = "2026-08-01T10:00:00.000Z";
const CUTOFF = "2026-08-01T11:00:00.000Z";
const NOW = "2026-08-01T12:00:00.000Z";
const MATERIALIZE_AT = "2026-08-01T12:30:00.000Z";
const ON = Object.freeze({ MENDPOINT_REGAUGE_LEARNING_ENABLED: "1" }) as NodeJS.ProcessEnv;

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
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-gov-iso-"));
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

function grant(db: AppDb, id: string, purpose: string): void {
  grantLearningConsent(db, {
    id,
    tenantId: TENANT,
    consentVersion: 1,
    purpose,
    residencyRegion: RESIDENCY,
    authorizedByPrincipalId: HUMAN,
    effectiveAt: AT,
    expiresAt: "2026-12-01T00:00:00.000Z",
    reason: `Authorized ${purpose}`,
    idempotencyKey: `grant-${id}`,
    createdAt: AT,
  });
}

function candidate(id: string): TransformerAdaptiveCandidateRecord {
  return {
    id,
    family: null,
    provider: "stripe",
    framework: "hono",
    tenantId: TENANT,
    campaignId: "camp-1",
    unitId: "unit-1",
    attemptId: "attempt-1",
    repositoryId: "regauge-repo-1",
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
    changedPaths: ["src/app.ts"],
    reviewerPrincipalId: HUMAN,
    reviewDecision: "approve",
    reviewRationale: "Approved: the fix is scoped and correct.",
    reviewedAt: OBSERVED,
    promotedAt: null,
    supersedesCandidateId: null,
    supersededByCandidateId: null,
    generation: 1,
    expiresAt: "2026-08-02T00:00:00.000Z",
    createdAt: AT,
    updatedAt: OBSERVED,
  } as unknown as TransformerAdaptiveCandidateRecord;
}

function artifact(): AdaptiveCandidateArtifact {
  return {
    schemaVersion: 5,
    kind: "adaptive",
    tenantId: TENANT,
    campaignId: "camp-1",
    unitId: "unit-1",
    attemptId: "attempt-1",
    repositoryId: "regauge-repo-1",
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
          rationale: "Adjust the client call to the new signature.",
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

/** A Fettler repository id whose governed split group lands in the train split. */
function trainRepository(): string {
  for (let i = 0; i < 1000; i += 1) {
    const repo = `warden-repo-${i}`;
    if (governedLearningSplit(`${repo}:api_remediation`) === "train") return repo;
  }
  throw new Error("no train repository found");
}

function admitFettlerGoverned(db: AppDb, consentId: string, runId: string, repositoryId: string) {
  return admitGovernedLearningOutcome({
    db,
    tenantId: TENANT,
    consentId,
    residencyRegion: RESIDENCY,
    product: "fettler",
    sourceObjectType: "fettler_agent_run",
    sourceObjectId: runId,
    repositoryId,
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
    outcome: { status: "corrected", summary: "The repair passed objective verification.", attribution: "model_behavior" },
    reviewerDecision: "accepted",
    correctionSubstantive: true,
    contaminationFree: true,
    confidence: 0.9,
    verificationAuthority: { signalClass: "hard", producedBy: "sandbox_command", producerModelId: null },
    economics: { inputTokens: 100, outputTokens: 20, latencyMs: 500, costUsd: 0.01 },
    sourceClass: "design_partner_verified",
    provenanceQualifiers: ["deterministically_verified", "reviewer_accepted"],
    mayLeaveTenantBoundary: false,
    revision: "b".repeat(40),
    snapshotDigest: `sha256:${"c".repeat(64)}`,
    scenarioId: null,
    syntheticFamilyId: null,
    reviewerPrincipalId: HUMAN,
    reviewRationale: "Approved in Warden review.",
    observedAt: OBSERVED,
    now: NOW,
  });
}

// A ReGauge governed record admitted DIRECTLY with a genuinely-verified outcome, so
// the governed corpus has an eligible `regauge` member. The real
// `admitTransformerGovernedLearningEvent` can no longer produce an eligible record —
// it honestly emits `none` (see the isolation test below) — so this hypothetical
// stands in for a future seam that can attest verification. It mirrors what that
// producer passes (product/source/task), differing only in the outcome it could
// not honestly attest today.
function admitRegaugeGoverned(db: AppDb, consentId: string, candidateId: string) {
  return admitGovernedLearningOutcome({
    db,
    tenantId: TENANT,
    consentId,
    residencyRegion: RESIDENCY,
    product: "regauge",
    sourceObjectType: "transformer_adaptive_candidate",
    sourceObjectId: candidateId,
    repositoryId: "regauge-repo-1",
    taskType: "legacy_migration",
    capability: "remediation_generation",
    specialization: {
      provider: "stripe",
      framework: "hono",
      language: null,
      runtime: null,
      migrationFamily: "adaptive_repair",
      riskClass: "low",
    },
    execution: { modelId: null, adapterId: null, routerDecisionId: `transformer_route_${candidateId}`, fallback: false },
    predictionSummary: "Adaptive repair candidate.",
    outcome: { status: "corrected", summary: "The repair passed objective verification.", attribution: "model_behavior" },
    reviewerDecision: "accepted",
    correctionSubstantive: true,
    contaminationFree: true,
    confidence: 0.9,
    verificationAuthority: { signalClass: "hard", producedBy: "sandbox_command", producerModelId: null },
    economics: { inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0 },
    sourceClass: "design_partner_verified",
    provenanceQualifiers: ["deterministically_verified", "reviewer_accepted"],
    mayLeaveTenantBoundary: false,
    revision: "b".repeat(40),
    snapshotDigest: `sha256:${"d".repeat(64)}`,
    scenarioId: null,
    syntheticFamilyId: null,
    reviewerPrincipalId: HUMAN,
    reviewRationale: "Approved in adaptive review.",
    observedAt: OBSERVED,
    now: NOW,
  });
}

function recordAttribution(db: AppDb, recordId: string): string | undefined {
  const content = getLearningRecordRedactedContent(db, TENANT, recordId);
  if (!content) return undefined;
  return (JSON.parse(content) as { event: { observedOutcome: { attribution: string } } })
    .event.observedOutcome.attribution;
}

function memberRecordIds(db: AppDb, datasetVersionId: string): Set<string> {
  const rows = db.raw
    .prepare("SELECT learning_record_id FROM learning_dataset_members WHERE tenant_id = ? AND dataset_version_id = ?")
    .all(TENANT, datasetVersionId) as Array<{ learning_record_id: string }>;
  return new Set(rows.map((row) => row.learning_record_id));
}

function corpusProducts(db: AppDb, artifactIds: readonly string[]): Set<string> {
  const products = new Set<string>();
  for (const id of artifactIds) {
    const row = db.raw
      .prepare("SELECT content_text FROM artifact_manifests WHERE id = ? AND tenant_id = ?")
      .get(id, TENANT) as { content_text: string | null } | undefined;
    if (!row?.content_text) continue;
    const parsed = JSON.parse(row.content_text) as { examples?: Array<{ product?: string }> };
    for (const example of parsed.examples ?? []) {
      if (typeof example.product === "string") products.add(example.product);
    }
  }
  return products;
}

describe("legacy and governed learning corpora stay isolated", () => {
  it("keeps the legacy export CLI path and the governed materializer on disjoint records", () => {
    const db = setup();
    grant(db, "consent-legacy", LEGACY_PURPOSE);
    grant(db, "consent-governed", GOVERNED_LEARNING_PURPOSE);

    // Legacy record under the legacy purpose (the live producer, unchanged).
    const legacy = admitApprovedOutcomeLearningRecord({
      db,
      tenantId: TENANT,
      candidate: candidate("regauge-cand-1"),
      artifact: artifact(),
      now: NOW,
      env: ON,
    });
    expect(legacy.admitted).toBe(true);
    const legacyRecordId = legacy.recordId!;

    // The REAL governed ReGauge producer, from the SAME source, under the governed
    // purpose. It is admitted ADDITIVELY as a distinct record (proving the additive
    // dual-emission), but it honestly attributes the outcome to `none` — it has no
    // independent verifier and cannot attest verification — so it is NOT
    // corpus-eligible and must never enter the governed training corpus.
    const governedRegaugeReal = admitTransformerGovernedLearningEvent({
      db,
      tenantId: TENANT,
      candidate: candidate("regauge-cand-1"),
      artifact: artifact(),
      // Merged terminal outcome: the producer refuses to admit any other state.
      deliveryOutcome: "merged",
      now: NOW,
      env: ON,
    });
    expect(governedRegaugeReal.admitted).toBe(true);
    expect(governedRegaugeReal.recordId).not.toBe(legacyRecordId);
    expect(recordAttribution(db, governedRegaugeReal.recordId!)).toBe("none");
    const ineligibleRegaugeRecordId = governedRegaugeReal.recordId!;

    // An eligible ReGauge governed member for the corpus, admitted directly with a
    // genuinely-verified outcome (a hypothetical stand-in the real producer cannot
    // honestly emit today). This is what gives the corpus its `regauge` product.
    const governedRegauge = admitRegaugeGoverned(db, "consent-governed", "regauge-cand-eligible");
    expect(governedRegauge.admitted).toBe(true);

    // Governed Fettler record, so the materializer receives BOTH products. Its
    // split group lands in the train split so materialization has a training set.
    const governedFettler = admitFettlerGoverned(db, "consent-governed", "warden-run-1", trainRepository());
    expect(governedFettler.admitted).toBe(true);

    const governedRecordIds = new Set([governedRegauge.recordId!, governedFettler.recordId!]);

    // Seal and export the LEGACY corpus. It must produce exactly the one legacy
    // example, with ZERO unexpected-schema exclusions (it never meets a governed
    // lesson document), because it is scoped to the legacy purpose.
    const sealed = sealApprovedLearningOutcomes({
      db,
      tenantId: TENANT,
      temporalCutoffAt: CUTOFF,
      createdByPrincipalId: HUMAN,
      sealedByPrincipalId: HUMAN,
      now: NOW,
      env: ON,
    });
    expect(sealed.sealed).toBe(true);
    const legacyCorpus = buildLearningCorpus({ db, tenantId: TENANT, purpose: LEGACY_PURPOSE, at: NOW });
    expect(legacyCorpus.stats.exported).toBe(1);
    expect(legacyCorpus.stats.excludedByReason.unexpected_schema).toBe(0);
    expect(legacyCorpus.examples.every((example) => example.provenance.purpose === LEGACY_PURPOSE)).toBe(true);

    // The legacy sealed dataset contains ONLY the legacy record, never a governed one.
    const legacyMembers = memberRecordIds(db, sealed.datasetVersionId!);
    expect(legacyMembers.has(legacyRecordId)).toBe(true);
    for (const governedId of governedRecordIds) expect(legacyMembers.has(governedId)).toBe(false);

    // Materialize the GOVERNED corpus. It must consume ONLY the two governed
    // records (both products), never the legacy record.
    const governedCorpus = materializeGovernedLearningCorpus(db, {
      tenantId: TENANT,
      purpose: GOVERNED_LEARNING_PURPOSE,
      temporalCutoffAt: CUTOFF,
      actorPrincipalId: HUMAN,
      idempotencyKey: "governed-corpus-1",
      createdAt: MATERIALIZE_AT,
    });
    expect(governedCorpus.memberCount).toBe(2);
    expect(governedCorpus.exampleCount).toBe(2);

    const governedMembers = memberRecordIds(db, governedCorpus.datasetVersionId);
    expect(governedMembers.has(legacyRecordId)).toBe(false);
    expect([...governedRecordIds].every((id) => governedMembers.has(id))).toBe(true);
    // The real ReGauge producer's `none` record is admitted but never corpus-eligible.
    expect(governedMembers.has(ineligibleRegaugeRecordId)).toBe(false);

    // Both products flow into the governed corpus; the legacy one carries neither
    // a governed lesson nor a mixed product set.
    const products = corpusProducts(db, [
      governedCorpus.artifactId,
      governedCorpus.validationArtifactId,
      governedCorpus.holdoutArtifactId,
    ]);
    expect(products).toEqual(new Set(["fettler", "regauge"]));

    // The two dataset member sets are disjoint: the load-bearing isolation property.
    for (const id of governedMembers) expect(legacyMembers.has(id)).toBe(false);
  });
});
