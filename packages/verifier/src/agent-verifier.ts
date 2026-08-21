import type {
  AgentVerifierResult,
  VerificationStrategy,
  VerifierBackend,
  VerifierBackendScore,
  VerifierCandidate,
  VerifierEvidencePack,
  VerifierFailureCode,
  VerifierRecommendation,
  VerifierRolloutMode,
  VerifierRisk,
  VerifierTelemetry,
  VerifierUsage,
} from "./types.js";
import { filterDeterministicCandidates } from "./evidence.js";
import { bradleyTerryWinProbability, buildPivotTournamentSchedule, verifierScoreIdentity } from "./tournament.js";
import { canonicalJson, codeUnitCompare, deepFreeze, exactDigest, exactIso, fail, identifier, sha256 } from "./utils.js";

export type AgentVerifierConfig = Readonly<{
  enabled: boolean;
  rolloutMode: VerifierRolloutMode;
  backend: VerifierBackend;
  evaluations: number;
  pivots: number;
  seed: number;
  maximumCandidates: number;
  maximumCostUsd?: number;
  behaviorChangeAuthority?: Readonly<{ tenantIds: readonly string[]; products: readonly ("fettler" | "regauge")[] }>;
  scoreCache?: VerifierScoreCache;
}>;

export interface VerifierScoreCache {
  get(identity: string): VerifierBackendScore | undefined;
  put(identity: string, score: VerifierBackendScore): void;
}

export interface AgentVerifier {
  verify(input: Readonly<{ pack: VerifierEvidencePack; incumbentCandidateId: string; verificationAttemptId: string; observedAt: string; signal?: AbortSignal }>): Promise<AgentVerifierResult>;
}

type NormalizedAgentVerifierConfig = Readonly<Omit<AgentVerifierConfig, "maximumCostUsd"> & { maximumCostUsd: number }>;

type MutableTotals = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number; totalTokens: number; cost: number; latency: number; responseDigests: Set<string> };

export function createAgentVerifier(input: AgentVerifierConfig): AgentVerifier {
  if (typeof input.enabled !== "boolean") fail("verifier_enabled_invalid");
  if (!["off", "offline", "shadow", "advisory", "selective", "automated"].includes(input.rolloutMode)) fail("verifier_rollout_mode_invalid");
  if (!input.backend || typeof input.backend.score !== "function") fail("verifier_backend_invalid");
  if (!Number.isSafeInteger(input.evaluations) || input.evaluations < 1 || input.evaluations > 16) fail("verifier_evaluations_invalid");
  if (!Number.isSafeInteger(input.pivots) || input.pivots < 1 || input.pivots > 16) fail("verifier_pivots_invalid");
  if (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > 0x7fffffff) fail("verifier_seed_invalid");
  if (!Number.isSafeInteger(input.maximumCandidates) || input.maximumCandidates < 1 || input.maximumCandidates > 20) fail("verifier_maximum_candidates_invalid");
  const maximumCostUsd = input.maximumCostUsd ?? 0.25;
  if (!Number.isFinite(maximumCostUsd) || maximumCostUsd <= 0 || maximumCostUsd > 100) fail("verifier_maximum_cost_invalid");
  const behaviorChangeAuthority = normalizeBehaviorChangeAuthority(input.behaviorChangeAuthority);
  const config = Object.freeze({
    enabled: input.enabled,
    rolloutMode: input.rolloutMode,
    backend: Object.freeze({ descriptor: deepFreeze(structuredClone(input.backend.descriptor)), score: input.backend.score.bind(input.backend) }) as VerifierBackend,
    evaluations: input.evaluations,
    pivots: input.pivots,
    seed: input.seed,
    maximumCandidates: input.maximumCandidates,
    maximumCostUsd,
    behaviorChangeAuthority,
    scoreCache: input.scoreCache ? Object.freeze({ get: input.scoreCache.get.bind(input.scoreCache), put: input.scoreCache.put.bind(input.scoreCache) }) : undefined,
  });
  return Object.freeze({
    async verify(request: Readonly<{ pack: VerifierEvidencePack; incumbentCandidateId: string; verificationAttemptId: string; observedAt: string; signal?: AbortSignal }>): Promise<AgentVerifierResult> {
      const verificationAttemptId = identifier(request.verificationAttemptId, "verifier_attempt_id_invalid");
      const observedAt = exactIso(request.observedAt, "verifier_observed_at_invalid");
      const incumbent = request.pack.candidates.find((candidate) => candidate.candidateId === request.incumbentCandidateId);
      if (!incumbent) fail("verifier_incumbent_candidate_unknown");
      const filtered = filterDeterministicCandidates(request.pack);
      const disabled = !config.enabled || config.rolloutMode === "off";
      if (disabled) {
        return resultFor({
          status: "disabled", pack: request.pack, config, incumbentCandidateId: request.incumbentCandidateId,
          filtered, scores: {}, suggestedCandidateId: null, effectiveCandidateId: request.incumbentCandidateId,
          recommendation: "continue", behaviorChanged: false, totals: emptyTotals(),
          verificationAttemptId, observedAt,
          failureCode: null,
        });
      }
      if (filtered.eligible.length === 0) {
        return resultFor({
          status: "no_eligible_candidates", pack: request.pack, config, incumbentCandidateId: request.incumbentCandidateId,
          filtered, scores: {}, suggestedCandidateId: null, effectiveCandidateId: request.incumbentCandidateId,
          recommendation: "escalate", behaviorChanged: false, totals: emptyTotals(),
          verificationAttemptId, observedAt,
          failureCode: "evidence_missing",
        });
      }
      if (filtered.eligible.length > config.maximumCandidates) fail("verifier_candidate_limit_exceeded");
      const totals = emptyTotals();
      try {
        const scores = await scoreCandidates(config, request.pack, filtered.eligible, totals, request.signal);
        const suggestedCandidateId = [...filtered.eligible]
          .sort((left, right) => (scores[right.candidateId] ?? 0) - (scores[left.candidateId] ?? 0) || codeUnitCompare(left.candidateId, right.candidateId))[0]!.candidateId;
        const canChange = config.rolloutMode === "selective" &&
          config.behaviorChangeAuthority?.tenantIds.includes(request.pack.tenantId) === true &&
          config.behaviorChangeAuthority.products.includes(request.pack.product);
        const effectiveCandidateId = canChange ? suggestedCandidateId : request.incumbentCandidateId;
        const behaviorChanged = effectiveCandidateId !== request.incumbentCandidateId;
        const highest = scores[suggestedCandidateId] ?? 0;
        // A confident verdict (ready_for_review) requires that the pack actually
        // showed the verifier substantive, reviewable change evidence: a
        // repository excerpt, graph impact, or retrieval source. Packs carrying
        // only a templated summary plus verification and owner references (for
        // example the current product completion shadow lane) contain no
        // evidence the model can independently check, so their score, however
        // high, may not surface as ready_for_review. It is capped at
        // request_more_evidence, which names the actual gap, keeps the signal
        // soft, and makes the missing evidence pack visible in telemetry rather
        // than silently inert. This never overrides a higher-precedence signal;
        // it only makes the verifier's own soft signal more conservative.
        const recommendation: VerifierRecommendation = highest >= 0.75 && packHasSubstantiveEvidence(request.pack)
          ? "ready_for_review"
          : highest >= 0.55 ? "request_more_evidence" : "resample";
        return resultFor({
          status: "verified", pack: request.pack, config, incumbentCandidateId: request.incumbentCandidateId,
          filtered, scores, suggestedCandidateId, effectiveCandidateId, recommendation, behaviorChanged, totals,
          verificationAttemptId, observedAt, failureCode: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "verifier_backend_unknown";
        // Distinguish a cache/backend identity mismatch (validateBackendScore
        // rejecting a response whose requestId/criterionId does not bind the
        // problem — a cache-poisoning signal) from an ordinary upstream failure.
        // Folding them together would make a poisoning event look like a 503.
        const failureCode: VerifierFailureCode = message.includes("logprob")
          ? "logprob_failure"
          : message.includes("cache_or_backend_identity_mismatch")
            ? "cache_failure"
            : "api_failure";
        return resultFor({
          status: "failed", pack: request.pack, config, incumbentCandidateId: request.incumbentCandidateId,
          filtered, scores: {}, suggestedCandidateId: null, effectiveCandidateId: request.incumbentCandidateId,
          recommendation: "escalate", behaviorChanged: false, totals,
          verificationAttemptId, observedAt,
          failureCode,
        });
      }
    },
  });
}

// Kinds that carry actual reviewable change or impact content the verifier can
// score against. Verification, owner, and human sources are authority and check
// references, not a substitute for the model seeing the candidate's real change,
// so they do not by themselves make a confident verdict admissible.
const SUBSTANTIVE_EVIDENCE_KINDS: ReadonlySet<VerifierEvidencePack["sources"][number]["kind"]> = new Set([
  "repository_excerpt",
  "graph",
  "retrieval",
]);

function packHasSubstantiveEvidence(pack: VerifierEvidencePack): boolean {
  return pack.sources.some((source) => SUBSTANTIVE_EVIDENCE_KINDS.has(source.kind));
}

function normalizeBehaviorChangeAuthority(authority: AgentVerifierConfig["behaviorChangeAuthority"]): AgentVerifierConfig["behaviorChangeAuthority"] {
  if (authority === undefined) return undefined;
  if (!Array.isArray(authority.tenantIds) || !Array.isArray(authority.products) ||
    authority.tenantIds.length < 1 || authority.tenantIds.length > 256 ||
    authority.products.length < 1 || authority.products.length > 2) {
    fail("verifier_behavior_authority_invalid");
  }
  const tenantIds = authority.tenantIds.map((tenantId) => identifier(tenantId, "verifier_behavior_authority_invalid"));
  const products = authority.products.map((product) => {
    if (product !== "fettler" && product !== "regauge") fail("verifier_behavior_authority_invalid");
    return product;
  });
  if (new Set(tenantIds).size !== tenantIds.length || new Set(products).size !== products.length) {
    fail("verifier_behavior_authority_invalid");
  }
  return deepFreeze({
    tenantIds: [...tenantIds].sort(codeUnitCompare),
    products: [...products].sort(codeUnitCompare),
  });
}

async function scoreCandidates(
  config: NormalizedAgentVerifierConfig,
  pack: VerifierEvidencePack,
  candidates: readonly VerifierCandidate[],
  totals: MutableTotals,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, number>>> {
  const scores: Record<string, number> = Object.fromEntries(candidates.map((candidate) => [candidate.candidateId, 0]));
  const masses: Record<string, number> = Object.fromEntries(candidates.map((candidate) => [candidate.candidateId, 0]));
  const byId = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  const trustedEvidence = canonicalJson({
    sources: pack.sources.map(({ id, kind, digest, locator, content }) => ({ id, kind, digest, locator, content })),
    checks: pack.checks,
    snapshotDigest: pack.snapshotDigest,
    allowedChangedPaths: pack.allowedChangedPaths,
  });

  const scoreOnePair = async (candidateA: VerifierCandidate, candidateB: VerifierCandidate | null) => {
    for (const criterion of pack.criteria) {
      const criterionDigest = sha256(canonicalJson(criterion));
      for (let repetition = 0; repetition < config.evaluations; repetition++) {
        const swapped = Boolean(candidateB && repetition % 2 === 1);
        const slots = candidateB
          ? swapped ? [candidateB, candidateA] as const : [candidateA, candidateB] as const
          : [candidateA] as const;
        const requestId = verifierScoreIdentity({
          tenantId: pack.tenantId,
          taskId: pack.taskId,
          evidencePackDigest: pack.packDigest,
          candidateADigest: slots[0].artifactDigest,
          candidateBDigest: slots[1]?.artifactDigest ?? null,
          criterionDigest,
          backendId: config.backend.descriptor.backendId,
          model: config.backend.descriptor.model,
          backendRevision: config.backend.descriptor.backendRevision,
          mode: config.backend.descriptor.mode,
          repetition,
        });
        const backendInput = {
          requestId,
          tenantId: pack.tenantId,
          taskId: pack.taskId,
          evidencePackDigest: pack.packDigest,
          criterion,
          candidates: slots.map((candidate) => ({
            candidateId: candidate.candidateId,
            artifactDigest: candidate.artifactDigest,
            observableOutput: candidate.observableOutput,
            changedPaths: candidate.changedPaths,
          })),
          trustedTask: pack.objective,
          trustedEvidence,
          repetition,
          maximumCostUsd: config.maximumCostUsd - totals.cost,
          signal,
        } as const;
        const cached = config.scoreCache?.get(requestId);
        const response = validateBackendScore(cached ?? await config.backend.score(backendInput), {
          requestId,
          criterionId: criterion.id,
          candidateIds: slots.map(({ candidateId }) => candidateId),
        });
        if (!cached) config.scoreCache?.put(requestId, deepFreeze(structuredClone(response)));
        accumulateTotals(totals, response);
        if (totals.cost > config.maximumCostUsd) fail("verifier_budget_exceeded");
        const scoreA = response.scores[candidateA.candidateId];
        if (scoreA === undefined) fail("verifier_backend_candidate_score_missing");
        if (!candidateB) {
          scores[candidateA.candidateId]! += scoreA * criterion.weight;
          masses[candidateA.candidateId]! += criterion.weight;
          continue;
        }
        const scoreB = response.scores[candidateB.candidateId];
        if (scoreB === undefined) fail("verifier_backend_candidate_score_missing");
        const winA = bradleyTerryWinProbability(scoreA, scoreB);
        scores[candidateA.candidateId]! += winA * criterion.weight;
        scores[candidateB.candidateId]! += (1 - winA) * criterion.weight;
        masses[candidateA.candidateId]! += criterion.weight;
        masses[candidateB.candidateId]! += criterion.weight;
      }
    }
  };

  if (candidates.length === 1) {
    await scoreOnePair(candidates[0]!, null);
  } else {
    const first = buildPivotTournamentSchedule(candidates.map(({ candidateId }) => candidateId), Math.min(config.pivots, candidates.length), config.seed);
    for (const edge of first.ring) await scoreOnePair(byId.get(edge.candidateAId)!, byId.get(edge.candidateBId)!);
    const ringScores = Object.fromEntries(candidates.map(({ candidateId }) => [candidateId, masses[candidateId]! ? scores[candidateId]! / masses[candidateId]! : 0]));
    const complete = buildPivotTournamentSchedule(candidates.map(({ candidateId }) => candidateId), Math.min(config.pivots, candidates.length), config.seed, ringScores);
    for (const edge of complete.pivot) await scoreOnePair(byId.get(edge.candidateAId)!, byId.get(edge.candidateBId)!);
  }
  return Object.freeze(Object.fromEntries(Object.keys(scores).sort(codeUnitCompare).map((candidateId) => [candidateId, masses[candidateId]! ? scores[candidateId]! / masses[candidateId]! : 0])));
}

function validateBackendScore(
  response: VerifierBackendScore,
  expected: Readonly<{ requestId: string; criterionId: string; candidateIds: readonly string[] }>,
): VerifierBackendScore {
  if (!response || typeof response !== "object" || Array.isArray(response) ||
    response.requestId !== expected.requestId || response.criterionId !== expected.criterionId) {
    fail("verifier_cache_or_backend_identity_mismatch");
  }
  if (!response.scores || typeof response.scores !== "object" || Array.isArray(response.scores)) {
    fail("verifier_backend_scores_invalid");
  }
  const scoreIds = Object.keys(response.scores).sort(codeUnitCompare);
  const expectedIds = [...expected.candidateIds].sort(codeUnitCompare);
  if (canonicalJson(scoreIds) !== canonicalJson(expectedIds) ||
    scoreIds.some((candidateId) => {
      const score = response.scores[candidateId];
      return !Number.isFinite(score) || score! < 0 || score! > 1;
    })) fail("verifier_backend_scores_invalid");
  exactDigest(response.rawResponseDigest, "verifier_backend_response_digest_invalid");
  if (!Number.isFinite(response.recognizedProbabilityMass) ||
    response.recognizedProbabilityMass < 0.5 || response.recognizedProbabilityMass > 1.000001) {
    fail("verifier_logprob_probability_mass_insufficient");
  }
  const usage = response.usage;
  if (!usage || [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.reasoningTokens, usage.totalTokens]
    .some((value) => !Number.isSafeInteger(value) || value < 0) ||
    usage.cachedInputTokens > usage.inputTokens || usage.reasoningTokens > usage.outputTokens ||
    usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    fail("verifier_backend_usage_invalid");
  }
  if (!Number.isFinite(response.estimatedCostUsd) || response.estimatedCostUsd < 0 ||
    !Number.isFinite(response.latencyMs) || response.latencyMs < 0) {
    fail("verifier_backend_accounting_invalid");
  }
  return deepFreeze(structuredClone(response));
}

function emptyTotals(): MutableTotals {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0, latency: 0, responseDigests: new Set() };
}

function accumulateTotals(totals: MutableTotals, response: VerifierBackendScore): void {
  totals.inputTokens += response.usage.inputTokens;
  totals.cachedInputTokens += response.usage.cachedInputTokens;
  totals.outputTokens += response.usage.outputTokens;
  totals.reasoningTokens += response.usage.reasoningTokens;
  totals.totalTokens += response.usage.totalTokens;
  totals.cost += response.estimatedCostUsd;
  totals.latency += response.latencyMs;
  totals.responseDigests.add(response.rawResponseDigest);
}

function resultFor(input: {
  status: AgentVerifierResult["status"];
  pack: VerifierEvidencePack;
  config: Readonly<AgentVerifierConfig>;
  incumbentCandidateId: string;
  filtered: ReturnType<typeof filterDeterministicCandidates>;
  scores: Readonly<Record<string, number>>;
  suggestedCandidateId: string | null;
  effectiveCandidateId: string;
  recommendation: VerifierRecommendation;
  behaviorChanged: boolean;
  totals: MutableTotals;
  verificationAttemptId: string;
  observedAt: string;
  failureCode: VerifierTelemetry["failureCode"];
}): AgentVerifierResult {
  const usage: VerifierUsage = Object.freeze({
    inputTokens: input.totals.inputTokens,
    cachedInputTokens: input.totals.cachedInputTokens,
    outputTokens: input.totals.outputTokens,
    reasoningTokens: input.totals.reasoningTokens,
    totalTokens: input.totals.totalTokens,
  });
  const telemetryBase = {
    schemaVersion: "2026-08-17.telemetry.v1" as const,
    telemetryId: `verifier_${sha256(`${input.pack.tenantId}\0${input.verificationAttemptId}`).slice("sha256:".length)}`,
    verificationAttemptId: input.verificationAttemptId,
    tenantId: input.pack.tenantId,
    missionId: input.pack.missionId,
    taskId: input.pack.taskId,
    product: input.pack.product,
    evidencePackDigest: input.pack.packDigest,
    rolloutMode: input.config.rolloutMode,
    backend: input.status === "disabled" ? null : input.config.backend.descriptor,
    incumbentCandidateId: input.incumbentCandidateId,
    eligibleCandidateIds: input.filtered.eligible.map(({ candidateId }) => candidateId),
    rejectedCandidates: input.filtered.rejected,
    candidateScores: input.scores,
    suggestedCandidateId: input.suggestedCandidateId,
    effectiveCandidateId: input.effectiveCandidateId,
    behaviorChanged: input.behaviorChanged,
    recommendation: input.recommendation,
    failureCode: input.failureCode,
    usage,
    estimatedCostUsd: input.totals.cost,
    latencyMs: input.totals.latency,
    observedAt: input.observedAt,
    scoreEvidenceDigests: Object.freeze([...input.totals.responseDigests].sort(codeUnitCompare)),
    softSignalOnly: true as const,
  };
  const telemetry = deepFreeze({ ...telemetryBase, telemetryDigest: sha256(canonicalJson(telemetryBase)) });
  return deepFreeze({
    status: input.status,
    recommendation: input.recommendation,
    failureCode: input.failureCode,
    suggestedCandidateId: input.suggestedCandidateId,
    effectiveCandidateId: input.effectiveCandidateId,
    behaviorChanged: input.behaviorChanged,
    telemetry,
  });
}

export function resolveVerifierPolicy(input: Readonly<{
  risk: VerifierRisk;
  rolloutMode: VerifierRolloutMode;
  eligible: boolean;
  candidateCount: number;
  priorFailures: number;
  remainingBudgetUsd: number;
}>): VerificationStrategy {
  if (input.rolloutMode === "off" || input.risk === "low") return "pass_through";
  if (!input.eligible || input.risk === "critical" || input.priorFailures >= 2 || input.remainingBudgetUsd <= 0) return "human_escalation";
  if (input.risk === "high" && input.candidateCount >= 2) return "muse_best_of_n_deepseek";
  if (input.risk === "medium" || input.risk === "high") return "deepseek_verify";
  return "pass_through";
}
