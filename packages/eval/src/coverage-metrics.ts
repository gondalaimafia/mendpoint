import { createHash } from "node:crypto";

export const COVERAGE_EVIDENCE_VERSION = "2026-08-01.v1" as const;
export const COVERAGE_REPORT_VERSION = "2026-08-01.v1" as const;
export const COVERAGE_PERCENTILE_METHOD = "nearest_rank_v1" as const;

export type EvidenceReference = Readonly<{
  id: string;
  kind: "source" | "evidence";
  uri: string;
  revision: string;
  digest: string;
  capturedAt: string;
}>;

export type ScopedCapability = Readonly<{
  id: string;
  disposition: "eligible" | "abstain";
  sourceRefIds: readonly string[];
  evidenceRefIds: readonly string[];
}>;

export type VerificationProfileScope = Readonly<{
  id: string;
  sourceRefIds: readonly string[];
  evidenceRefIds: readonly string[];
}>;

export type AbstentionClassification = Readonly<{
  id: string;
  trigger: "unsupported_scope" | "repository_limit" | "low_confidence" | "ambiguity" | "truncation" | "operator_policy";
  sourceRefIds: readonly string[];
  evidenceRefIds: readonly string[];
}>;

export type CoverageScope = Readonly<{
  changeTaxonomy: readonly ScopedCapability[];
  providerScope: readonly ScopedCapability[];
  languageFrontends: readonly ScopedCapability[];
  verificationProfiles: readonly VerificationProfileScope[];
  abstentionClassifications: readonly AbstentionClassification[];
  repositoryLimits: Readonly<{
    maxFiles: number;
    maxBytes: number;
    maxFileBytes: number;
    maxFindings: number;
    sourceRefIds: readonly string[];
    evidenceRefIds: readonly string[];
  }>;
  decisionPolicy: Readonly<{
    minimumDraftConfidence: number;
    unresolvedAmbiguity: "abstain";
    truncatedInput: "abstain";
    sourceRefIds: readonly string[];
    evidenceRefIds: readonly string[];
  }>;
}>;

export type CoverageCohort = Readonly<{
  id: string;
  workloadId: string;
  workloadVersion: string;
  workloadDigest: string;
  inclusionCriteria: readonly string[];
  exclusionCriteria: readonly string[];
  window: Readonly<{ start: string; end: string }>;
  sampleCount: number;
  percentileMethod: typeof COVERAGE_PERCENTILE_METHOD;
  sourceRefIds: readonly string[];
  evidenceRefIds: readonly string[];
}>;

export type CoverageSample = Readonly<{
  id: string;
  changeKind: string;
  providerId: string;
  languageFrontendId: string;
  repository: Readonly<{
    files: number;
    bytes: number;
    largestFileBytes: number;
    findings: number;
  }>;
  provenance: Readonly<{
    mode: "observed";
    sourceRefIds: readonly string[];
    evidenceRefIds: readonly string[];
  }>;
  confidence: number;
  ambiguity: "none" | "bounded" | "unresolved";
  ambiguityReason: string | null;
  truncated: boolean;
  truncationReason: string | null;
  decision: "drafted" | "abstained";
  abstentionClassificationId: string | null;
  adjudicatedFindings: Readonly<{
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
  }>;
  changePublishedAt: string;
  feedObservedAt: string;
  draftCreatedAt: string | null;
  verificationProfileId: string | null;
  verificationOutcome: "passed" | "failed" | "not_run";
  reviewerChangedLines: number | null;
  mergeOutcome: "merged" | "closed_unmerged" | "open" | "not_submitted";
  regressionDetected: boolean | null;
}>;

export type CoverageEvidenceContract = Readonly<{
  version: typeof COVERAGE_EVIDENCE_VERSION;
  cohort: CoverageCohort;
  scope: CoverageScope;
  references: readonly EvidenceReference[];
  samples: readonly CoverageSample[];
}>;

type RateMetric = Readonly<{ numerator: number; denominator: number; rate: number }>;
type DurationMetric = Readonly<{
  sampleCount: number;
  unit: "milliseconds";
  percentileMethod: typeof COVERAGE_PERCENTILE_METHOD;
  p50: number;
  p95: number;
  maximum: number;
}>;

type DimensionCoverage = Readonly<{
  id: string;
  disposition?: "eligible" | "abstain";
  sampleCount: number;
}>;

export type CoverageMetricsReport = Readonly<{
  version: typeof COVERAGE_REPORT_VERSION;
  contractDigest: string;
  basis: Readonly<{
    cohortId: string;
    workloadId: string;
    workloadVersion: string;
    workloadDigest: string;
    window: Readonly<{ start: string; end: string }>;
    sampleCount: number;
    percentileMethod: typeof COVERAGE_PERCENTILE_METHOD;
    sourceRefIds: readonly string[];
    evidenceRefIds: readonly string[];
  }>;
  claimScope: Readonly<{
    kind: "observed_cohort_only";
    extrapolationAllowed: false;
    observedChangeKinds: readonly string[];
    observedProviders: readonly string[];
    observedLanguageFrontends: readonly string[];
  }>;
  scopeCoverage: Readonly<{
    changeTaxonomy: readonly DimensionCoverage[];
    providerScope: readonly DimensionCoverage[];
    languageFrontends: readonly DimensionCoverage[];
    verificationProfiles: readonly DimensionCoverage[];
    abstentionClassifications: readonly DimensionCoverage[];
    repositoryLimits: CoverageScope["repositoryLimits"];
  }>;
  observationQuality: Readonly<{
    confidence: Readonly<{ minimum: number; p50: number; p95: number }>;
    ambiguity: Readonly<Record<CoverageSample["ambiguity"], number>>;
    truncated: RateMetric;
  }>;
  metrics: Readonly<{
    feedFreshness: DurationMetric;
    precision: RateMetric;
    recall: RateMetric;
    abstention: RateMetric;
    changeToDraft: DurationMetric;
    verificationPassRate: RateMetric;
    reviewerDelta: Readonly<{
      sampleCount: number;
      unit: "changed_lines";
      percentileMethod: typeof COVERAGE_PERCENTILE_METHOD;
      p50: number;
      p95: number;
      maximum: number;
      zeroDelta: RateMetric;
    }>;
    mergeOutcome: Readonly<Record<CoverageSample["mergeOutcome"], number>>;
    regression: RateMetric;
  }>;
}>;

const ID = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MUTABLE_REVISION = /(?:^|[/:._-])(?:main|master|head|latest|current|tip|\*)(?:$|[/:._-])/i;
const UNIVERSAL_IDENTIFIER = /(?:^|[._:-])(?:all|every|any|unlimited|universal)(?:$|[._:-])/i;

function fail(code: string): never {
  throw new Error(code);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field}_object_required`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) if (!allow.has(key)) fail(`${field}_unknown_field:${key}`);
  for (const key of allowed) if (!(key in value)) fail(`${field}_field_required:${key}`);
}

function text(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max) {
    fail(`${field}_invalid`);
  }
  return value;
}

function id(value: unknown, field: string): string {
  const result = text(value, field, 200);
  if (!ID.test(result) || UNIVERSAL_IDENTIFIER.test(result)) {
    fail(`${field}_invalid`);
  }
  return result;
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field, 40);
  if (Number.isNaN(Date.parse(result)) || new Date(result).toISOString() !== result) fail(`${field}_invalid`);
  return result;
}

function digest(value: unknown, field: string): string {
  const result = text(value, field, 80);
  if (!DIGEST.test(result)) fail(`${field}_invalid`);
  return result;
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`${field}_invalid`);
  return value as number;
}

function probability(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${field}_invalid`);
  }
  return value;
}

function enumeration<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(`${field}_invalid`);
  return value as T;
}

function uniqueStrings(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length)) fail(`${field}_invalid`);
  const result = value.map((entry, index) => text(entry, `${field}[${index}]`));
  if (new Set(result).size !== result.length) fail(`${field}_duplicate`);
  return result.sort();
}

function idRefs(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.length) fail(`${field}_invalid`);
  const result = value.map((entry, index) => id(entry, `${field}[${index}]`));
  if (new Set(result).size !== result.length) fail(`${field}_duplicate`);
  return result.sort();
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function parseReferences(value: unknown): EvidenceReference[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 10_000) fail("coverage_references_invalid");
  const references = value.map((entry, index) => {
    const item = record(entry, `coverage_references[${index}]`);
    exactKeys(item, ["id", "kind", "uri", "revision", "digest", "capturedAt"], `coverage_references[${index}]`);
    const uri = text(item.uri, `coverage_references[${index}].uri`, 2_000);
    try {
      const parsed = new URL(uri);
      if (!["https:", "urn:"].includes(parsed.protocol)) fail(`coverage_references[${index}].uri_invalid`);
    } catch {
      fail(`coverage_references[${index}].uri_invalid`);
    }
    const revision = text(item.revision, `coverage_references[${index}].revision`, 256);
    if (MUTABLE_REVISION.test(revision)) fail(`coverage_references[${index}].revision_mutable`);
    return {
      id: id(item.id, `coverage_references[${index}].id`),
      kind: enumeration(item.kind, ["source", "evidence"] as const, `coverage_references[${index}].kind`),
      uri,
      revision,
      digest: digest(item.digest, `coverage_references[${index}].digest`),
      capturedAt: timestamp(item.capturedAt, `coverage_references[${index}].capturedAt`),
    };
  });
  if (new Set(references.map((item) => item.id)).size !== references.length) fail("coverage_reference_id_duplicate");
  if (!references.some((item) => item.kind === "source") || !references.some((item) => item.kind === "evidence")) {
    fail("coverage_reference_kinds_required");
  }
  return references.sort((left, right) => left.id.localeCompare(right.id));
}

function assertReferenceSet(
  sourceRefIds: readonly string[],
  evidenceRefIds: readonly string[],
  references: Map<string, EvidenceReference>,
  field: string,
): void {
  for (const referenceId of sourceRefIds) {
    if (references.get(referenceId)?.kind !== "source") fail(`${field}_source_ref_invalid:${referenceId}`);
  }
  for (const referenceId of evidenceRefIds) {
    if (references.get(referenceId)?.kind !== "evidence") fail(`${field}_evidence_ref_invalid:${referenceId}`);
  }
}

function scopedCapabilities(
  value: unknown,
  field: string,
  references: Map<string, EvidenceReference>,
): ScopedCapability[] {
  if (!Array.isArray(value) || !value.length || value.length > 10_000) fail(`${field}_invalid`);
  const items = value.map((entry, index) => {
    const item = record(entry, `${field}[${index}]`);
    exactKeys(item, ["id", "disposition", "sourceRefIds", "evidenceRefIds"], `${field}[${index}]`);
    const result = {
      id: id(item.id, `${field}[${index}].id`),
      disposition: enumeration(item.disposition, ["eligible", "abstain"] as const, `${field}[${index}].disposition`),
      sourceRefIds: idRefs(item.sourceRefIds, `${field}[${index}].sourceRefIds`),
      evidenceRefIds: idRefs(item.evidenceRefIds, `${field}[${index}].evidenceRefIds`),
    };
    assertReferenceSet(result.sourceRefIds, result.evidenceRefIds, references, `${field}[${index}]`);
    return result;
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) fail(`${field}_id_duplicate`);
  return items.sort((left, right) => left.id.localeCompare(right.id));
}

function referencedIds(
  value: unknown,
  field: string,
  references: Map<string, EvidenceReference>,
): VerificationProfileScope[] {
  if (!Array.isArray(value) || !value.length || value.length > 10_000) fail(`${field}_invalid`);
  const items = value.map((entry, index) => {
    const item = record(entry, `${field}[${index}]`);
    exactKeys(item, ["id", "sourceRefIds", "evidenceRefIds"], `${field}[${index}]`);
    const result = {
      id: id(item.id, `${field}[${index}].id`),
      sourceRefIds: idRefs(item.sourceRefIds, `${field}[${index}].sourceRefIds`),
      evidenceRefIds: idRefs(item.evidenceRefIds, `${field}[${index}].evidenceRefIds`),
    };
    assertReferenceSet(result.sourceRefIds, result.evidenceRefIds, references, `${field}[${index}]`);
    return result;
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) fail(`${field}_id_duplicate`);
  return items.sort((left, right) => left.id.localeCompare(right.id));
}

function abstentionClassifications(
  value: unknown,
  references: Map<string, EvidenceReference>,
): AbstentionClassification[] {
  const field = "coverage_scope.abstentionClassifications";
  if (!Array.isArray(value) || !value.length || value.length > 10_000) fail(`${field}_invalid`);
  const items = value.map((entry, index) => {
    const item = record(entry, `${field}[${index}]`);
    exactKeys(item, ["id", "trigger", "sourceRefIds", "evidenceRefIds"], `${field}[${index}]`);
    const result = {
      id: id(item.id, `${field}[${index}].id`),
      trigger: enumeration(item.trigger, [
        "unsupported_scope", "repository_limit", "low_confidence", "ambiguity", "truncation", "operator_policy",
      ] as const, `${field}[${index}].trigger`),
      sourceRefIds: idRefs(item.sourceRefIds, `${field}[${index}].sourceRefIds`),
      evidenceRefIds: idRefs(item.evidenceRefIds, `${field}[${index}].evidenceRefIds`),
    };
    assertReferenceSet(result.sourceRefIds, result.evidenceRefIds, references, `${field}[${index}]`);
    return result;
  });
  if (new Set(items.map((item) => item.id)).size !== items.length) fail(`${field}_id_duplicate`);
  return items.sort((left, right) => left.id.localeCompare(right.id));
}

function parseScope(value: unknown, references: Map<string, EvidenceReference>): CoverageScope {
  const scope = record(value, "coverage_scope");
  exactKeys(scope, [
    "changeTaxonomy", "providerScope", "languageFrontends", "verificationProfiles",
    "abstentionClassifications", "repositoryLimits", "decisionPolicy",
  ], "coverage_scope");
  const repositoryLimits = record(scope.repositoryLimits, "coverage_scope.repositoryLimits");
  exactKeys(repositoryLimits, ["maxFiles", "maxBytes", "maxFileBytes", "maxFindings", "sourceRefIds", "evidenceRefIds"], "coverage_scope.repositoryLimits");
  const limits = {
    maxFiles: integer(repositoryLimits.maxFiles, "coverage_scope.repositoryLimits.maxFiles", 1),
    maxBytes: integer(repositoryLimits.maxBytes, "coverage_scope.repositoryLimits.maxBytes", 1),
    maxFileBytes: integer(repositoryLimits.maxFileBytes, "coverage_scope.repositoryLimits.maxFileBytes", 1),
    maxFindings: integer(repositoryLimits.maxFindings, "coverage_scope.repositoryLimits.maxFindings", 1),
    sourceRefIds: idRefs(repositoryLimits.sourceRefIds, "coverage_scope.repositoryLimits.sourceRefIds"),
    evidenceRefIds: idRefs(repositoryLimits.evidenceRefIds, "coverage_scope.repositoryLimits.evidenceRefIds"),
  };
  if (limits.maxFileBytes > limits.maxBytes) fail("coverage_scope_repository_file_limit_invalid");
  assertReferenceSet(limits.sourceRefIds, limits.evidenceRefIds, references, "coverage_scope.repositoryLimits");
  const decisionPolicy = record(scope.decisionPolicy, "coverage_scope.decisionPolicy");
  exactKeys(decisionPolicy, ["minimumDraftConfidence", "unresolvedAmbiguity", "truncatedInput", "sourceRefIds", "evidenceRefIds"], "coverage_scope.decisionPolicy");
  const policy = {
    minimumDraftConfidence: probability(decisionPolicy.minimumDraftConfidence, "coverage_scope.decisionPolicy.minimumDraftConfidence"),
    unresolvedAmbiguity: enumeration(decisionPolicy.unresolvedAmbiguity, ["abstain"] as const, "coverage_scope.decisionPolicy.unresolvedAmbiguity"),
    truncatedInput: enumeration(decisionPolicy.truncatedInput, ["abstain"] as const, "coverage_scope.decisionPolicy.truncatedInput"),
    sourceRefIds: idRefs(decisionPolicy.sourceRefIds, "coverage_scope.decisionPolicy.sourceRefIds"),
    evidenceRefIds: idRefs(decisionPolicy.evidenceRefIds, "coverage_scope.decisionPolicy.evidenceRefIds"),
  };
  assertReferenceSet(policy.sourceRefIds, policy.evidenceRefIds, references, "coverage_scope.decisionPolicy");
  return {
    changeTaxonomy: scopedCapabilities(scope.changeTaxonomy, "coverage_scope.changeTaxonomy", references),
    providerScope: scopedCapabilities(scope.providerScope, "coverage_scope.providerScope", references),
    languageFrontends: scopedCapabilities(scope.languageFrontends, "coverage_scope.languageFrontends", references),
    verificationProfiles: referencedIds(scope.verificationProfiles, "coverage_scope.verificationProfiles", references),
    abstentionClassifications: abstentionClassifications(scope.abstentionClassifications, references),
    repositoryLimits: limits,
    decisionPolicy: policy,
  };
}

function parseCohort(value: unknown, references: Map<string, EvidenceReference>): CoverageCohort {
  const cohort = record(value, "coverage_cohort");
  exactKeys(cohort, [
    "id", "workloadId", "workloadVersion", "workloadDigest", "inclusionCriteria",
    "exclusionCriteria", "window", "sampleCount", "percentileMethod", "sourceRefIds", "evidenceRefIds",
  ], "coverage_cohort");
  const window = record(cohort.window, "coverage_cohort.window");
  exactKeys(window, ["start", "end"], "coverage_cohort.window");
  const result = {
    id: id(cohort.id, "coverage_cohort.id"),
    workloadId: id(cohort.workloadId, "coverage_cohort.workloadId"),
    workloadVersion: text(cohort.workloadVersion, "coverage_cohort.workloadVersion", 100),
    workloadDigest: digest(cohort.workloadDigest, "coverage_cohort.workloadDigest"),
    inclusionCriteria: uniqueStrings(cohort.inclusionCriteria, "coverage_cohort.inclusionCriteria"),
    exclusionCriteria: uniqueStrings(cohort.exclusionCriteria, "coverage_cohort.exclusionCriteria", true),
    window: {
      start: timestamp(window.start, "coverage_cohort.window.start"),
      end: timestamp(window.end, "coverage_cohort.window.end"),
    },
    sampleCount: integer(cohort.sampleCount, "coverage_cohort.sampleCount", 1),
    percentileMethod: enumeration(cohort.percentileMethod, [COVERAGE_PERCENTILE_METHOD] as const, "coverage_cohort.percentileMethod"),
    sourceRefIds: idRefs(cohort.sourceRefIds, "coverage_cohort.sourceRefIds"),
    evidenceRefIds: idRefs(cohort.evidenceRefIds, "coverage_cohort.evidenceRefIds"),
  };
  if (Date.parse(result.window.end) <= Date.parse(result.window.start)) fail("coverage_cohort_window_invalid");
  assertReferenceSet(result.sourceRefIds, result.evidenceRefIds, references, "coverage_cohort");
  return result;
}

function parseSample(value: unknown, index: number, references: Map<string, EvidenceReference>): CoverageSample {
  const field = `coverage_samples[${index}]`;
  const sample = record(value, field);
  exactKeys(sample, [
    "id", "changeKind", "providerId", "languageFrontendId", "repository", "provenance",
    "confidence", "ambiguity", "ambiguityReason", "truncated", "truncationReason", "decision",
    "abstentionClassificationId", "adjudicatedFindings", "changePublishedAt", "feedObservedAt",
    "draftCreatedAt", "verificationProfileId", "verificationOutcome", "reviewerChangedLines",
    "mergeOutcome", "regressionDetected",
  ], field);
  const repository = record(sample.repository, `${field}.repository`);
  exactKeys(repository, ["files", "bytes", "largestFileBytes", "findings"], `${field}.repository`);
  const provenance = record(sample.provenance, `${field}.provenance`);
  exactKeys(provenance, ["mode", "sourceRefIds", "evidenceRefIds"], `${field}.provenance`);
  const findings = record(sample.adjudicatedFindings, `${field}.adjudicatedFindings`);
  exactKeys(findings, ["truePositive", "falsePositive", "falseNegative"], `${field}.adjudicatedFindings`);
  const sourceRefIds = idRefs(provenance.sourceRefIds, `${field}.provenance.sourceRefIds`);
  const evidenceRefIds = idRefs(provenance.evidenceRefIds, `${field}.provenance.evidenceRefIds`);
  assertReferenceSet(sourceRefIds, evidenceRefIds, references, `${field}.provenance`);
  const nullableText = (entry: unknown, name: string) => entry === null ? null : text(entry, name, 1_000);
  const nullableId = (entry: unknown, name: string) => entry === null ? null : id(entry, name);
  const nullableInteger = (entry: unknown, name: string) => entry === null ? null : integer(entry, name);
  const nullableBoolean = (entry: unknown, name: string) => entry === null
    ? null
    : typeof entry === "boolean" ? entry : fail(`${name}_invalid`);
  const nullableTimestamp = (entry: unknown, name: string) => entry === null ? null : timestamp(entry, name);
  return {
    id: id(sample.id, `${field}.id`),
    changeKind: id(sample.changeKind, `${field}.changeKind`),
    providerId: id(sample.providerId, `${field}.providerId`),
    languageFrontendId: id(sample.languageFrontendId, `${field}.languageFrontendId`),
    repository: {
      files: integer(repository.files, `${field}.repository.files`, 1),
      bytes: integer(repository.bytes, `${field}.repository.bytes`, 1),
      largestFileBytes: integer(repository.largestFileBytes, `${field}.repository.largestFileBytes`, 1),
      findings: integer(repository.findings, `${field}.repository.findings`),
    },
    provenance: {
      mode: enumeration(provenance.mode, ["observed"] as const, `${field}.provenance.mode`),
      sourceRefIds,
      evidenceRefIds,
    },
    confidence: probability(sample.confidence, `${field}.confidence`),
    ambiguity: enumeration(sample.ambiguity, ["none", "bounded", "unresolved"] as const, `${field}.ambiguity`),
    ambiguityReason: nullableText(sample.ambiguityReason, `${field}.ambiguityReason`),
    truncated: typeof sample.truncated === "boolean" ? sample.truncated : fail(`${field}.truncated_invalid`),
    truncationReason: nullableText(sample.truncationReason, `${field}.truncationReason`),
    decision: enumeration(sample.decision, ["drafted", "abstained"] as const, `${field}.decision`),
    abstentionClassificationId: nullableId(sample.abstentionClassificationId, `${field}.abstentionClassificationId`),
    adjudicatedFindings: {
      truePositive: integer(findings.truePositive, `${field}.adjudicatedFindings.truePositive`),
      falsePositive: integer(findings.falsePositive, `${field}.adjudicatedFindings.falsePositive`),
      falseNegative: integer(findings.falseNegative, `${field}.adjudicatedFindings.falseNegative`),
    },
    changePublishedAt: timestamp(sample.changePublishedAt, `${field}.changePublishedAt`),
    feedObservedAt: timestamp(sample.feedObservedAt, `${field}.feedObservedAt`),
    draftCreatedAt: nullableTimestamp(sample.draftCreatedAt, `${field}.draftCreatedAt`),
    verificationProfileId: nullableId(sample.verificationProfileId, `${field}.verificationProfileId`),
    verificationOutcome: enumeration(sample.verificationOutcome, ["passed", "failed", "not_run"] as const, `${field}.verificationOutcome`),
    reviewerChangedLines: nullableInteger(sample.reviewerChangedLines, `${field}.reviewerChangedLines`),
    mergeOutcome: enumeration(sample.mergeOutcome, ["merged", "closed_unmerged", "open", "not_submitted"] as const, `${field}.mergeOutcome`),
    regressionDetected: nullableBoolean(sample.regressionDetected, `${field}.regressionDetected`),
  };
}

function scopeMap(values: readonly ScopedCapability[]): Map<string, ScopedCapability> {
  return new Map(values.map((item) => [item.id, item]));
}

function assertSampleSemantics(sample: CoverageSample, contract: Omit<CoverageEvidenceContract, "samples">): void {
  const field = `coverage_sample:${sample.id}`;
  const change = scopeMap(contract.scope.changeTaxonomy).get(sample.changeKind);
  const provider = scopeMap(contract.scope.providerScope).get(sample.providerId);
  const language = scopeMap(contract.scope.languageFrontends).get(sample.languageFrontendId);
  if (!change) fail(`${field}_change_kind_out_of_scope`);
  if (!provider) fail(`${field}_provider_out_of_scope`);
  if (!language) fail(`${field}_language_out_of_scope`);
  if (sample.repository.largestFileBytes > sample.repository.bytes) fail(`${field}_repository_shape_invalid`);
  const limits = contract.scope.repositoryLimits;
  const overLimit = sample.repository.files > limits.maxFiles || sample.repository.bytes > limits.maxBytes ||
    sample.repository.largestFileBytes > limits.maxFileBytes || sample.repository.findings > limits.maxFindings;
  const dispositionRequiresAbstention = [change, provider, language].some((item) => item.disposition === "abstain");
  const policyRequiresAbstention = sample.confidence < contract.scope.decisionPolicy.minimumDraftConfidence ||
    sample.ambiguity === "unresolved" || sample.truncated || overLimit;
  if ((dispositionRequiresAbstention || policyRequiresAbstention) && sample.decision !== "abstained") {
    fail(`${field}_unsafe_draft`);
  }
  if (sample.ambiguity === "none" && sample.ambiguityReason !== null) fail(`${field}_ambiguity_reason_unexpected`);
  if (sample.ambiguity !== "none" && sample.ambiguityReason === null) fail(`${field}_ambiguity_reason_required`);
  if (sample.truncated !== (sample.truncationReason !== null)) fail(`${field}_truncation_reason_invalid`);
  const published = Date.parse(sample.changePublishedAt);
  const observed = Date.parse(sample.feedObservedAt);
  if (observed < published) fail(`${field}_feed_time_invalid`);
  if (observed < Date.parse(contract.cohort.window.start) || observed > Date.parse(contract.cohort.window.end)) {
    fail(`${field}_outside_cohort_window`);
  }
  const abstentionById = new Map(contract.scope.abstentionClassifications.map((item) => [item.id, item]));
  const verificationIds = new Set(contract.scope.verificationProfiles.map((item) => item.id));
  if (sample.decision === "abstained") {
    const classification = sample.abstentionClassificationId
      ? abstentionById.get(sample.abstentionClassificationId)
      : undefined;
    if (!classification) {
      fail(`${field}_abstention_classification_invalid`);
    }
    const validTriggers = new Set<AbstentionClassification["trigger"]>(["operator_policy"]);
    if (dispositionRequiresAbstention) validTriggers.add("unsupported_scope");
    if (overLimit) validTriggers.add("repository_limit");
    if (sample.confidence < contract.scope.decisionPolicy.minimumDraftConfidence) validTriggers.add("low_confidence");
    if (sample.ambiguity !== "none") validTriggers.add("ambiguity");
    if (sample.truncated) validTriggers.add("truncation");
    if (!validTriggers.has(classification.trigger)) fail(`${field}_abstention_classification_mismatch`);
    if (sample.draftCreatedAt !== null || sample.verificationProfileId !== null ||
        sample.verificationOutcome !== "not_run" || sample.reviewerChangedLines !== null ||
        sample.mergeOutcome !== "not_submitted" || sample.regressionDetected !== null) {
      fail(`${field}_abstention_observation_invalid`);
    }
  } else {
    if (sample.abstentionClassificationId !== null) fail(`${field}_draft_abstention_invalid`);
    if (!sample.draftCreatedAt || Date.parse(sample.draftCreatedAt) < observed) fail(`${field}_draft_time_invalid`);
    if (!sample.verificationProfileId || !verificationIds.has(sample.verificationProfileId)) {
      fail(`${field}_verification_profile_invalid`);
    }
    if (sample.verificationOutcome === "not_run" || sample.reviewerChangedLines === null ||
        sample.mergeOutcome === "not_submitted" || sample.regressionDetected === null) {
      fail(`${field}_draft_observation_incomplete`);
    }
  }
}

export function validateCoverageEvidence(input: unknown): CoverageEvidenceContract {
  const contract = record(input, "coverage_contract");
  exactKeys(contract, ["version", "cohort", "scope", "references", "samples"], "coverage_contract");
  if (contract.version !== COVERAGE_EVIDENCE_VERSION) fail("coverage_contract_version_invalid");
  const references = parseReferences(contract.references);
  const referenceMap = new Map(references.map((item) => [item.id, item]));
  const cohort = parseCohort(contract.cohort, referenceMap);
  const scope = parseScope(contract.scope, referenceMap);
  if (!Array.isArray(contract.samples) || !contract.samples.length || contract.samples.length > 100_000) {
    fail("coverage_samples_required");
  }
  const samples = contract.samples.map((sample, index) => parseSample(sample, index, referenceMap));
  if (new Set(samples.map((sample) => sample.id)).size !== samples.length) fail("coverage_sample_id_duplicate");
  if (samples.length !== cohort.sampleCount) fail("coverage_sample_count_mismatch");
  const base = { version: COVERAGE_EVIDENCE_VERSION, cohort, scope, references } as const;
  for (const sample of samples) assertSampleSemantics(sample, base);
  return deepFreeze({ ...base, samples: samples.sort((left, right) => left.id.localeCompare(right.id)) });
}

function nearestRank(values: readonly number[], percentile: number): number {
  if (!values.length) fail("coverage_percentile_empty");
  const ordered = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * ordered.length));
  return ordered[rank - 1]!;
}

function durationMetric(values: readonly number[]): DurationMetric {
  return {
    sampleCount: values.length,
    unit: "milliseconds",
    percentileMethod: COVERAGE_PERCENTILE_METHOD,
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    maximum: Math.max(...values),
  };
}

function rate(numerator: number, denominator: number, field: string): RateMetric {
  if (!denominator) fail(`${field}_denominator_empty`);
  return { numerator, denominator, rate: numerator / denominator };
}

function dimensionCoverage(
  entries: readonly { id: string; disposition?: "eligible" | "abstain" }[],
  sampleIds: readonly string[],
): DimensionCoverage[] {
  return entries.map((entry) => ({
    id: entry.id,
    ...(entry.disposition ? { disposition: entry.disposition } : {}),
    sampleCount: sampleIds.filter((sampleId) => sampleId === entry.id).length,
  }));
}

export function evaluateCoverageEvidence(input: unknown): CoverageMetricsReport {
  const contract = validateCoverageEvidence(input);
  const drafted = contract.samples.filter((sample) => sample.decision === "drafted");
  if (!drafted.length) fail("coverage_drafted_samples_required");
  const truePositive = contract.samples.reduce((sum, sample) => sum + sample.adjudicatedFindings.truePositive, 0);
  const falsePositive = contract.samples.reduce((sum, sample) => sum + sample.adjudicatedFindings.falsePositive, 0);
  const falseNegative = contract.samples.reduce((sum, sample) => sum + sample.adjudicatedFindings.falseNegative, 0);
  const feedFreshness = contract.samples.map((sample) => Date.parse(sample.feedObservedAt) - Date.parse(sample.changePublishedAt));
  const changeToDraft = drafted.map((sample) => Date.parse(sample.draftCreatedAt!) - Date.parse(sample.changePublishedAt));
  const reviewerDelta = drafted.map((sample) => sample.reviewerChangedLines!);
  const confidence = contract.samples.map((sample) => sample.confidence);
  const scopedReferences = [
    ...contract.scope.changeTaxonomy,
    ...contract.scope.providerScope,
    ...contract.scope.languageFrontends,
    ...contract.scope.verificationProfiles,
    ...contract.scope.abstentionClassifications,
    contract.scope.repositoryLimits,
    contract.scope.decisionPolicy,
  ];
  const sourceRefIds = [...new Set([
    ...contract.cohort.sourceRefIds,
    ...scopedReferences.flatMap((item) => item.sourceRefIds),
    ...contract.samples.flatMap((sample) => sample.provenance.sourceRefIds),
  ])].sort();
  const evidenceRefIds = [...new Set([
    ...contract.cohort.evidenceRefIds,
    ...scopedReferences.flatMap((item) => item.evidenceRefIds),
    ...contract.samples.flatMap((sample) => sample.provenance.evidenceRefIds),
  ])].sort();
  const mergeOutcome = { merged: 0, closed_unmerged: 0, open: 0, not_submitted: 0 };
  for (const sample of contract.samples) mergeOutcome[sample.mergeOutcome]++;
  const ambiguity = { none: 0, bounded: 0, unresolved: 0 };
  for (const sample of contract.samples) ambiguity[sample.ambiguity]++;
  const verificationPassed = drafted.filter((sample) => sample.verificationOutcome === "passed").length;
  const regressions = drafted.filter((sample) => sample.regressionDetected).length;
  const report: CoverageMetricsReport = {
    version: COVERAGE_REPORT_VERSION,
    contractDigest: sha256(stableJson(contract)),
    basis: {
      cohortId: contract.cohort.id,
      workloadId: contract.cohort.workloadId,
      workloadVersion: contract.cohort.workloadVersion,
      workloadDigest: contract.cohort.workloadDigest,
      window: contract.cohort.window,
      sampleCount: contract.samples.length,
      percentileMethod: contract.cohort.percentileMethod,
      sourceRefIds,
      evidenceRefIds,
    },
    claimScope: {
      kind: "observed_cohort_only",
      extrapolationAllowed: false,
      observedChangeKinds: [...new Set(contract.samples.map((sample) => sample.changeKind))].sort(),
      observedProviders: [...new Set(contract.samples.map((sample) => sample.providerId))].sort(),
      observedLanguageFrontends: [...new Set(contract.samples.map((sample) => sample.languageFrontendId))].sort(),
    },
    scopeCoverage: {
      changeTaxonomy: dimensionCoverage(contract.scope.changeTaxonomy, contract.samples.map((sample) => sample.changeKind)),
      providerScope: dimensionCoverage(contract.scope.providerScope, contract.samples.map((sample) => sample.providerId)),
      languageFrontends: dimensionCoverage(contract.scope.languageFrontends, contract.samples.map((sample) => sample.languageFrontendId)),
      verificationProfiles: dimensionCoverage(contract.scope.verificationProfiles, drafted.map((sample) => sample.verificationProfileId!)),
      abstentionClassifications: dimensionCoverage(contract.scope.abstentionClassifications, contract.samples.map((sample) => sample.abstentionClassificationId).filter((value): value is string => value !== null)),
      repositoryLimits: contract.scope.repositoryLimits,
    },
    observationQuality: {
      confidence: {
        minimum: Math.min(...confidence),
        p50: nearestRank(confidence, 0.5),
        p95: nearestRank(confidence, 0.95),
      },
      ambiguity,
      truncated: rate(contract.samples.filter((sample) => sample.truncated).length, contract.samples.length, "coverage_truncation"),
    },
    metrics: {
      feedFreshness: durationMetric(feedFreshness),
      precision: rate(truePositive, truePositive + falsePositive, "coverage_precision"),
      recall: rate(truePositive, truePositive + falseNegative, "coverage_recall"),
      abstention: rate(contract.samples.length - drafted.length, contract.samples.length, "coverage_abstention"),
      changeToDraft: durationMetric(changeToDraft),
      verificationPassRate: rate(verificationPassed, drafted.length, "coverage_verification"),
      reviewerDelta: {
        sampleCount: reviewerDelta.length,
        unit: "changed_lines",
        percentileMethod: COVERAGE_PERCENTILE_METHOD,
        p50: nearestRank(reviewerDelta, 0.5),
        p95: nearestRank(reviewerDelta, 0.95),
        maximum: Math.max(...reviewerDelta),
        zeroDelta: rate(reviewerDelta.filter((value) => value === 0).length, reviewerDelta.length, "coverage_reviewer_delta"),
      },
      mergeOutcome,
      regression: rate(regressions, drafted.length, "coverage_regression"),
    },
  };
  return deepFreeze(report);
}
