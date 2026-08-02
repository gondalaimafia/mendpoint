import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COVERAGE_EVIDENCE_VERSION,
  COVERAGE_PERCENTILE_METHOD,
  evaluateCoverageEvidence,
  validateCoverageEvidence,
} from "./coverage-metrics.js";

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function references() {
  return [
    {
      id: "source-a",
      kind: "source",
      uri: "https://github.com/acme/payments",
      revision: "a".repeat(40),
      digest: digest("source-a"),
      capturedAt: "2026-08-01T00:00:00.000Z",
    },
    {
      id: "evidence-a",
      kind: "evidence",
      uri: "urn:mendpoint:evidence:run-a",
      revision: "run-a.v1",
      digest: digest("evidence-a"),
      capturedAt: "2026-08-01T01:00:00.000Z",
    },
  ];
}

const cited = {
  sourceRefIds: ["source-a"],
  evidenceRefIds: ["evidence-a"],
};

function contract(): any {
  return {
    version: COVERAGE_EVIDENCE_VERSION,
    cohort: {
      id: "design-partner-2026-08",
      workloadId: "warden-supported-change-corpus",
      workloadVersion: "1.0.0",
      workloadDigest: digest("workload-v1"),
      inclusionCriteria: ["Repositories with observed provider changes"],
      exclusionCriteria: ["Synthetic provider events"],
      window: {
        start: "2026-08-01T00:00:00.000Z",
        end: "2026-08-02T00:00:00.000Z",
      },
      sampleCount: 2,
      percentileMethod: COVERAGE_PERCENTILE_METHOD,
      ...cited,
    },
    scope: {
      changeTaxonomy: [
        { id: "rest-required-field", disposition: "eligible", ...cited },
        { id: "binary-contract-change", disposition: "abstain", ...cited },
      ],
      providerScope: [
        { id: "stripe", disposition: "eligible", ...cited },
        { id: "unknown-provider", disposition: "abstain", ...cited },
      ],
      languageFrontends: [
        { id: "typescript", disposition: "eligible", ...cited },
        { id: "cobol", disposition: "abstain", ...cited },
      ],
      verificationProfiles: [{ id: "node-test", ...cited }],
      abstentionClassifications: [
        { id: "ambiguous-evidence", trigger: "ambiguity", ...cited },
        { id: "repository-limit", trigger: "repository_limit", ...cited },
        { id: "unsupported-scope", trigger: "unsupported_scope", ...cited },
        { id: "truncated-input", trigger: "truncation", ...cited },
      ],
      repositoryLimits: {
        maxFiles: 5_000,
        maxBytes: 50_000_000,
        maxFileBytes: 2_000_000,
        maxFindings: 10_000,
        ...cited,
      },
      decisionPolicy: {
        minimumDraftConfidence: 0.8,
        unresolvedAmbiguity: "abstain",
        truncatedInput: "abstain",
        ...cited,
      },
    },
    references: references(),
    samples: [
      {
        id: "sample-drafted",
        changeKind: "rest-required-field",
        providerId: "stripe",
        languageFrontendId: "typescript",
        repository: { files: 120, bytes: 500_000, largestFileBytes: 20_000, findings: 4 },
        provenance: { mode: "observed", ...cited },
        confidence: 0.9,
        ambiguity: "none",
        ambiguityReason: null,
        truncated: false,
        truncationReason: null,
        decision: "drafted",
        abstentionClassificationId: null,
        adjudicatedFindings: { truePositive: 2, falsePositive: 1, falseNegative: 1 },
        changePublishedAt: "2026-08-01T00:00:00.000Z",
        feedObservedAt: "2026-08-01T00:05:00.000Z",
        draftCreatedAt: "2026-08-01T00:20:00.000Z",
        verificationProfileId: "node-test",
        verificationOutcome: "passed",
        reviewerChangedLines: 2,
        mergeOutcome: "merged",
        regressionDetected: false,
      },
      {
        id: "sample-abstained",
        changeKind: "rest-required-field",
        providerId: "stripe",
        languageFrontendId: "typescript",
        repository: { files: 80, bytes: 300_000, largestFileBytes: 10_000, findings: 1 },
        provenance: { mode: "observed", ...cited },
        confidence: 0.4,
        ambiguity: "unresolved",
        ambiguityReason: "Two source revisions disagree",
        truncated: false,
        truncationReason: null,
        decision: "abstained",
        abstentionClassificationId: "ambiguous-evidence",
        adjudicatedFindings: { truePositive: 0, falsePositive: 0, falseNegative: 1 },
        changePublishedAt: "2026-08-01T01:00:00.000Z",
        feedObservedAt: "2026-08-01T01:10:00.000Z",
        draftCreatedAt: null,
        verificationProfileId: null,
        verificationOutcome: "not_run",
        reviewerChangedLines: null,
        mergeOutcome: "not_submitted",
        regressionDetected: null,
      },
    ],
  };
}

function draftedToAbstained(sample: any): void {
  sample.confidence = 0.4;
  sample.ambiguity = "unresolved";
  sample.ambiguityReason = "Insufficient evidence";
  sample.decision = "abstained";
  sample.abstentionClassificationId = "ambiguous-evidence";
  sample.draftCreatedAt = null;
  sample.verificationProfileId = null;
  sample.verificationOutcome = "not_run";
  sample.reviewerChangedLines = null;
  sample.mergeOutcome = "not_submitted";
  sample.regressionDetected = null;
}

describe("coverage metrics evidence contract", () => {
  it("produces deterministic cohort metrics with an explicit non-extrapolation boundary", () => {
    const first = evaluateCoverageEvidence(contract());
    const reordered = contract();
    reordered.samples.reverse();
    reordered.references.reverse();
    reordered.scope.changeTaxonomy.reverse();
    const second = evaluateCoverageEvidence(reordered);

    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.basis).toMatchObject({
      cohortId: "design-partner-2026-08",
      workloadId: "warden-supported-change-corpus",
      sampleCount: 2,
      percentileMethod: "nearest_rank_v1",
      sourceRefIds: ["source-a"],
      evidenceRefIds: ["evidence-a"],
    });
    expect(first.claimScope).toEqual({
      kind: "observed_cohort_only",
      extrapolationAllowed: false,
      observedChangeKinds: ["rest-required-field"],
      observedProviders: ["stripe"],
      observedLanguageFrontends: ["typescript"],
    });
    expect(first.metrics.precision).toEqual({ numerator: 2, denominator: 3, rate: 2 / 3 });
    expect(first.metrics.recall).toEqual({ numerator: 2, denominator: 4, rate: 0.5 });
    expect(first.metrics.abstention).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(first.metrics.feedFreshness).toMatchObject({
      sampleCount: 2,
      percentileMethod: "nearest_rank_v1",
      p50: 300_000,
      p95: 600_000,
      maximum: 600_000,
    });
    expect(first.metrics.changeToDraft).toMatchObject({ sampleCount: 1, p50: 1_200_000 });
    expect(first.metrics.verificationPassRate).toEqual({ numerator: 1, denominator: 1, rate: 1 });
    expect(first.metrics.reviewerDelta).toMatchObject({ sampleCount: 1, p50: 2, p95: 2 });
    expect(first.metrics.mergeOutcome).toEqual({
      merged: 1,
      closed_unmerged: 0,
      open: 0,
      not_submitted: 1,
    });
    expect(first.metrics.regression).toEqual({ numerator: 0, denominator: 1, rate: 0 });
    expect(first.observationQuality).toMatchObject({
      confidence: { minimum: 0.4, p50: 0.4, p95: 0.9 },
      ambiguity: { none: 1, bounded: 0, unresolved: 1 },
      truncated: { numerator: 0, denominator: 2, rate: 0 },
    });
    expect(first.scopeCoverage.changeTaxonomy).toEqual([
      { id: "binary-contract-change", disposition: "abstain", sampleCount: 0 },
      { id: "rest-required-field", disposition: "eligible", sampleCount: 2 },
    ]);
    expect(JSON.stringify(first)).not.toMatch(/all providers|every change|unlimited|works for any/i);
  });

  it("normalizes and freezes the versioned evidence contract", () => {
    const validated = validateCoverageEvidence(contract());
    expect(validated.version).toBe(COVERAGE_EVIDENCE_VERSION);
    expect(validated.samples.map((sample) => sample.id)).toEqual(["sample-abstained", "sample-drafted"]);
    expect(Object.isFrozen(validated.samples[0])).toBe(true);
  });

  it.each([
    ["estimated top level data", (value: any) => { value.estimated = true; }, /coverage_contract_unknown_field:estimated/],
    ["estimated sample provenance", (value: any) => { value.samples[0].provenance.mode = "estimated"; }, /provenance.mode_invalid/],
    ["missing workload", (value: any) => { delete value.cohort.workloadId; }, /coverage_cohort_field_required:workloadId/],
    ["wrong sample count", (value: any) => { value.cohort.sampleCount = 3; }, /coverage_sample_count_mismatch/],
    ["unapproved percentile method", (value: any) => { value.cohort.percentileMethod = "linear"; }, /percentileMethod_invalid/],
    ["mutable reference", (value: any) => { value.references[0].revision = "main"; }, /revision_mutable/],
    ["mutable branch reference", (value: any) => { value.references[0].revision = "refs/heads/main"; }, /revision_mutable/],
    ["wrong reference kind", (value: any) => { value.samples[0].provenance.sourceRefIds = ["evidence-a"]; }, /source_ref_invalid:evidence-a/],
    ["missing evidence reference", (value: any) => { value.samples[0].provenance.evidenceRefIds = ["missing-ref"]; }, /evidence_ref_invalid:missing-ref/],
    ["universal provider scope", (value: any) => { value.scope.providerScope[0].id = "all"; }, /providerScope\[0\].id_invalid/],
    ["provider outside declared scope", (value: any) => { value.samples[0].providerId = "github"; }, /provider_out_of_scope/],
    ["observation outside cohort window", (value: any) => { value.samples[0].feedObservedAt = "2026-08-03T00:00:00.000Z"; }, /outside_cohort_window/],
    ["feed timestamp before publication", (value: any) => { value.samples[0].feedObservedAt = "2025-08-01T00:00:00.000Z"; }, /feed_time_invalid/],
    ["low confidence draft", (value: any) => { value.samples[0].confidence = 0.2; }, /unsafe_draft/],
    ["unresolved ambiguous draft", (value: any) => { value.samples[0].ambiguity = "unresolved"; value.samples[0].ambiguityReason = "conflict"; }, /unsafe_draft/],
    ["truncated draft", (value: any) => { value.samples[0].truncated = true; value.samples[0].truncationReason = "budget"; }, /unsafe_draft/],
    ["repository over limit", (value: any) => { value.samples[0].repository.files = 5_001; }, /unsafe_draft/],
    ["scope requires abstention", (value: any) => { value.scope.providerScope[0].disposition = "abstain"; }, /unsafe_draft/],
    ["unclassified abstention", (value: any) => { value.samples[1].abstentionClassificationId = null; }, /abstention_classification_invalid/],
    ["unknown abstention class", (value: any) => { value.samples[1].abstentionClassificationId = "unknown"; }, /abstention_classification_invalid/],
    ["mislabeled abstention", (value: any) => { value.samples[1].abstentionClassificationId = "repository-limit"; }, /abstention_classification_mismatch/],
    ["draft without verification", (value: any) => { value.samples[0].verificationOutcome = "not_run"; }, /draft_observation_incomplete/],
    ["draft without reviewer delta", (value: any) => { value.samples[0].reviewerChangedLines = null; }, /draft_observation_incomplete/],
    ["abstention with submitted outcome", (value: any) => { value.samples[1].mergeOutcome = "open"; }, /abstention_observation_invalid/],
    ["duplicate sample id", (value: any) => { value.samples[1].id = value.samples[0].id; }, /coverage_sample_id_duplicate/],
  ])("fails closed for %s", (_name, mutate, pattern) => {
    const value = contract();
    mutate(value);
    expect(() => evaluateCoverageEvidence(value)).toThrow(pattern);
  });

  it("refuses metrics without observed detection denominators or a drafted sample", () => {
    const noLabels = contract();
    for (const sample of noLabels.samples) {
      sample.adjudicatedFindings = { truePositive: 0, falsePositive: 0, falseNegative: 0 };
    }
    expect(() => evaluateCoverageEvidence(noLabels)).toThrow("coverage_precision_denominator_empty");

    const noDraft = contract();
    draftedToAbstained(noDraft.samples[0]);
    expect(() => evaluateCoverageEvidence(noDraft)).toThrow("coverage_drafted_samples_required");
  });
});
