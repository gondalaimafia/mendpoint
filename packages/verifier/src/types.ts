export const VERIFIER_SCHEMA_VERSION = "2026-08-17.v1" as const;

export type VerifierProduct = "fettler" | "regauge";
export type VerifierRisk = "low" | "medium" | "high" | "critical";
export type VerifierDataClassification = "public" | "internal" | "confidential" | "restricted";
export type VerifierRolloutMode = "off" | "offline" | "shadow" | "advisory" | "selective" | "automated";
export type VerifierScoringMode = "nonthinking_logprobs" | "upstream_thinking_logprobs" | "muse_self";
export type VerifierRecommendation =
  | "continue"
  | "replan"
  | "request_more_evidence"
  | "resample"
  | "ready_for_review"
  | "escalate";
export type VerifierFailureCode =
  | "verifier_false_positive"
  | "verifier_false_negative"
  | "verifier_misrank"
  | "verifier_uncalibrated"
  | "criteria_failure"
  | "evidence_missing"
  | "correlated_failure"
  | "api_failure"
  | "logprob_failure"
  | "cache_failure"
  | "cost_excessive"
  | "latency_excessive";

export type VerifierGovernanceInput = {
  dataClassification: VerifierDataClassification;
  requiredRegion: string;
  processingRegion: string;
  externalModelAllowed: boolean;
  mayLeaveTenantBoundary: boolean;
  consentId: string | null;
  consentActive: boolean;
};

export type VerifierCriterionInput = {
  id: string;
  title: string;
  description: string;
  hard: boolean;
  weight: number;
};

export type VerifierSourceInput = {
  id: string;
  kind: "repository_excerpt" | "graph" | "retrieval" | "verification" | "owner" | "human";
  digest: string;
  locator: string;
  content: string;
};

export type VerifierDeterministicCheckInput = {
  id: string;
  status: "passed" | "failed" | "incomplete";
  evidenceRefs: string[];
  candidateIds: string[] | null;
};

export type VerifierHardCriterionResultInput = {
  criterionId: string;
  status: "passed" | "failed" | "incomplete";
  evidenceRefs: string[];
};

export type VerifierCandidateInput = {
  candidateId: string;
  artifactDigest: string;
  kind: "plan" | "patch" | "completion";
  observableOutput: string;
  changedPaths: string[];
  evidenceRefs: string[];
  deterministicCheckIds: string[];
  hardCriterionResults: VerifierHardCriterionResultInput[];
};

export type VerifierEvidencePackInput = {
  schemaVersion: typeof VERIFIER_SCHEMA_VERSION;
  tenantId: string;
  missionId: string;
  taskId: string;
  product: VerifierProduct;
  repositoryId: string;
  snapshotDigest: string;
  objective: string;
  risk: VerifierRisk;
  governance: VerifierGovernanceInput;
  allowedChangedPaths: string[];
  criteria: VerifierCriterionInput[];
  sources: VerifierSourceInput[];
  checks: VerifierDeterministicCheckInput[];
  candidates: VerifierCandidateInput[];
  assembledAt: string;
  assemblerVersion: string;
};

export type VerifierCriterion = Readonly<VerifierCriterionInput>;
export type VerifierSource = Readonly<VerifierSourceInput & { contentDigest: string }>;
export type VerifierDeterministicCheck = Readonly<{
  id: string;
  status: VerifierDeterministicCheckInput["status"];
  evidenceRefs: readonly string[];
  candidateIds: readonly string[] | null;
}>;
export type VerifierCandidate = Readonly<{
  candidateId: string;
  artifactDigest: string;
  kind: VerifierCandidateInput["kind"];
  observableOutput: string;
  changedPaths: readonly string[];
  evidenceRefs: readonly string[];
  deterministicCheckIds: readonly string[];
  hardCriterionResults: readonly Readonly<{
    criterionId: string;
    status: VerifierHardCriterionResultInput["status"];
    evidenceRefs: readonly string[];
  }>[];
}>;

export type VerifierEvidencePack = Readonly<{
  schemaVersion: typeof VERIFIER_SCHEMA_VERSION;
  tenantId: string;
  missionId: string;
  taskId: string;
  product: VerifierProduct;
  repositoryId: string;
  snapshotDigest: string;
  objective: string;
  risk: VerifierRisk;
  governance: Readonly<VerifierGovernanceInput>;
  allowedChangedPaths: readonly string[];
  criteria: readonly VerifierCriterion[];
  sources: readonly VerifierSource[];
  checks: readonly VerifierDeterministicCheck[];
  candidates: readonly VerifierCandidate[];
  assembledAt: string;
  assemblerVersion: string;
  packDigest: string;
}>;

export type VerifierBackendDescriptor = Readonly<{
  backendId: string;
  provider: string;
  model: string;
  backendRevision: string;
  mode: VerifierScoringMode;
}>;

export type VerifierUsage = Readonly<{
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}>;

export type VerifierBackendCandidate = Readonly<{
  candidateId: string;
  artifactDigest: string;
  observableOutput: string;
  changedPaths: readonly string[];
}>;

export type VerifierBackendScoreInput = Readonly<{
  requestId: string;
  tenantId: string;
  taskId: string;
  evidencePackDigest: string;
  criterion: VerifierCriterion;
  candidates: readonly VerifierBackendCandidate[];
  trustedTask: string;
  trustedEvidence: string;
  repetition: number;
  maximumCostUsd?: number;
  signal?: AbortSignal;
}>;

export type VerifierBackendScore = Readonly<{
  requestId: string;
  scores: Readonly<Record<string, number>>;
  criterionId: string;
  rawResponseDigest: string;
  recognizedProbabilityMass: number;
  usage: VerifierUsage;
  estimatedCostUsd: number;
  latencyMs: number;
}>;

export interface VerifierBackend {
  readonly descriptor: VerifierBackendDescriptor;
  score(input: VerifierBackendScoreInput): Promise<VerifierBackendScore>;
}

export type VerifierHttpRequest = Readonly<{
  url: string;
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}>;

export type VerifierHttpResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: unknown;
}>;

export interface VerifierHttpTransport {
  request(input: VerifierHttpRequest): Promise<VerifierHttpResponse>;
}

export type VerifierPricing = Readonly<{
  version: string;
  currency: "USD";
  effectiveAt: string;
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
}>;

export type AgentVerifierResult = Readonly<{
  status: "disabled" | "no_eligible_candidates" | "verified" | "failed";
  recommendation: VerifierRecommendation;
  failureCode: VerifierFailureCode | null;
  suggestedCandidateId: string | null;
  effectiveCandidateId: string;
  behaviorChanged: boolean;
  telemetry: VerifierTelemetry;
}>;

export type VerifierTelemetry = Readonly<{
  schemaVersion: "2026-08-17.telemetry.v1";
  telemetryId: string;
  verificationAttemptId: string;
  tenantId: string;
  missionId: string;
  taskId: string;
  product: VerifierProduct;
  evidencePackDigest: string;
  rolloutMode: VerifierRolloutMode;
  backend: VerifierBackendDescriptor | null;
  incumbentCandidateId: string;
  eligibleCandidateIds: readonly string[];
  rejectedCandidates: readonly Readonly<{ candidateId: string; reasons: readonly string[] }>[];
  candidateScores: Readonly<Record<string, number>>;
  suggestedCandidateId: string | null;
  effectiveCandidateId: string;
  behaviorChanged: boolean;
  recommendation: VerifierRecommendation;
  failureCode: VerifierFailureCode | null;
  usage: VerifierUsage;
  estimatedCostUsd: number;
  latencyMs: number;
  observedAt: string;
  scoreEvidenceDigests: readonly string[];
  softSignalOnly: true;
  telemetryDigest: string;
}>;

export type VerificationStrategy =
  | "pass_through"
  | "muse_self_verify"
  | "deepseek_verify"
  | "muse_best_of_n_deepseek"
  | "human_escalation";
