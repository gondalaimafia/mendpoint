import type {
  AgentVerifierResult,
  VerificationStrategy,
  VerifierBackend,
  VerifierBackendScore,
  VerifierCandidate,
  VerifierEvidencePack,
  VerifierRecommendation,
  VerifierRolloutMode,
  VerifierRisk,
  VerifierTelemetry,
  VerifierUsage,
} from "./types.js";
import { filterDeterministicCandidates } from "./evidence.js";
import { bradleyTerryWinProbability, buildPivotTournamentSchedule, verifierScoreIdentity } from "./tournament.js";
import { canonicalJson, codeUnitCompare, deepFreeze, exactIso, fail, identifier, sha256 } from "./utils.js";

// Minimum share of the score position's probability that must land on the
// A through T score tokens for the resulting reward to count as a confident
// signal. Below this floor the decode can report a maximal reward off a
// vanishingly small recognized mass (for example a 99.9994% not-an-answer
// distribution), so the verdict is downgraded to escalate instead of trusted.
const DEFAULT_MINIMUM_RECOGNIZED_PROBABILITY_MASS = 0.2;

export type AgentVerifierConfig = Readonly<{
  enabled: boolean;
  rolloutMode: VerifierRolloutMode;
  backend: VerifierBackend;
  evaluations: number;
  pivots: number;
  seed: number;
  maximumCandidates: number;
  maximumCostUsd?: number;
  minimumRecognizedProbabilityMass?: number;
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

type NormalizedAgentVerifierConfig = Readonly<Omit<AgentVerifierConfig, "maximumCostUsd" | "minimumRecognizedProbabilityMass"> & { maximumCostUsd: number; minimumRecognizedProbabilityMass: number }>;

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
  const minimumRecognizedProbabilityMass = input.minimumRecognizedProbabilityMass ?? DEFAULT_MINIMUM_RECOGNIZED_PROBABILITY_MASS;
  if (!Number.isFinite(minimumRecognizedProbabilityMass) || minimumRecognizedProbabilityMass < 0 || minimumRecognizedProbabilityMass > 1) fail("verifier_minimum_recognized_mass_invalid");
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
    minimumRecognizedProbabilityMass,
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
          recognizedProbabilityMass: null, recognizedProbabilityMassBelowFloor: false,
        });
      }
      if (filtered.eligible.length === 0) {
        return resultFor({
          status: "no_eligible_candidates", pack: request.pack, config, incumbentCandidateId: request.incumbentCandidateId,
          filtered, scores: {}, suggestedCandidateId: null, effectiveCandidateId: request.incumbentCandidateId,
          recommendation: "escalate", behaviorChanged: false, totals: emptyTotals(),
          verificationAttemptId, observedAt,
          failureCode: "evidence_missing",
          recognizedProbabilityMass: null, recognizedProbabilityMassBelowFloor: false,
        });
      }
      if (filtered.eligible.length > config.maximumCandidates) fail("verifier_candidate_limit_exceeded");
      const totals = emptyTotals();
      try {
        const { scores, recognizedMass } = await scoreCandidates(config, request.pack, filtered.eligible, totals, request.signal);
        const suggestedCandidateId = [...filtered.eligible]
          .sort((left, right) => (scores[right.candidateId] ?? 0) - (scores[left.candidateId] ?? 0) || codeUnitCompare(left.candidateId, right.candidateId))[0]!.candidateId;
        // Fail closed on recognized probability mass. A score is a confident
        // signal only when the score position put at least the configured floor
        // of its probability on the A through T score tokens. A missing or
        // non-finite mass, or a candidate that was never scored, is treated as
        // below the floor, never above it. Below the floor the reward is not
        // trusted: selection cannot change and the verdict is escalate.
        const suggestedMass = recognizedMass[suggestedCandidateId];
        const massConfident = Number.isFinite(suggestedMass) && suggestedMass! >= config.minimumRecognizedProbabilityMass;
        const canChange = massConfident && config.rolloutMode === "selective" &&
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
        const recommendation: VerifierRecommendation = massConfident
          ? (highest >= 0.75 && packHasSubstantiveEvidence(request.pack)
              ? "ready_for_review"
              : highest >= 0.55 ? "request_more_evidence" : "resample")
          : "escalate";
        return resultFor({
          status: "verified", pack: request.pack, config, incumbentCandidateId: request.incumbentCandidateId,
          filtered, scores, suggestedCandidateId, effectiveCandidateId, recommendation, behaviorChanged, totals,
          verificationAttemptId, observedAt, failureCode: massConfident ? null : "verifier_uncalibrated",
          recognizedProbabilityMass: Number.isFinite(suggestedMass) ? suggestedMass! : null,
          recognizedProbabilityMassBelowFloor: !massConfident,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "verifier_backend_unknown";
        const failureCode = message.includes("logprob") ? "logprob_failure" as const : "api_failure" as const;
        return resultFor({
          status: "failed", pack: request.pack, config, incumbentCandidateId: request.incumbentCandidateId,
          filtered, scores: {}, suggestedCandidateId: null, effectiveCandidateId: request.incumbentCandidateId,
          recommendation: "escalate", behaviorChanged: false, totals,
          verificationAttemptId, observedAt,
          failureCode,
          recognizedProbabilityMass: null, recognizedProbabilityMassBelowFloor: false,
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
): Promise<Readonly<{ scores: Readonly<Record<string, number>>; recognizedMass: Readonly<Record<string, number>> }>> {
  const scores: Record<string, number> = Object.fromEntries(candidates.map((candidate) => [candidate.candidateId, 0]));
  const masses: Record<string, number> = Object.fromEntries(candidates.map((candidate) => [candidate.candidateId, 0]));
  // Running minimum recognized probability mass observed for each candidate
  // across every backend response it appeared in. Starts at +Infinity so a
  // candidate that is never scored stays non-finite and is treated as below the
  // floor by the caller (fail closed), rather than defaulting to a passing mass.
  const recognizedMass: Record<string, number> = Object.fromEntries(candidates.map((candidate) => [candidate.candidateId, Number.POSITIVE_INFINITY]));
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
        const response = cached ?? await config.backend.score(backendInput);
        if (response.requestId !== requestId || response.criterionId !== criterion.id ||
          slots.some((candidate) => response.scores[candidate.candidateId] === undefined)) {
          fail("verifier_cache_or_backend_identity_mismatch");
        }
        if (!cached) config.scoreCache?.put(requestId, deepFreeze(structuredClone(response)));
        accumulateTotals(totals, response);
        if (totals.cost > config.maximumCostUsd) fail("verifier_budget_exceeded");
        // A missing or non-finite recognized mass counts as zero (below any
        // floor), so a backend that omits it cannot launder a low-recognition
        // response into a confident one.
        const responseMass = Number.isFinite(response.recognizedProbabilityMass) ? response.recognizedProbabilityMass : 0;
        recognizedMass[candidateA.candidateId] = Math.min(recognizedMass[candidateA.candidateId]!, responseMass);
        if (candidateB) recognizedMass[candidateB.candidateId] = Math.min(recognizedMass[candidateB.candidateId]!, responseMass);
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
  return Object.freeze({
    scores: Object.freeze(Object.fromEntries(Object.keys(scores).sort(codeUnitCompare).map((candidateId) => [candidateId, masses[candidateId]! ? scores[candidateId]! / masses[candidateId]! : 0]))),
    recognizedMass: Object.freeze({ ...recognizedMass }),
  });
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
  recognizedProbabilityMass: number | null;
  recognizedProbabilityMassBelowFloor: boolean;
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
    recognizedProbabilityMass: input.recognizedProbabilityMass,
    recognizedProbabilityMassFloor: input.config.minimumRecognizedProbabilityMass ?? DEFAULT_MINIMUM_RECOGNIZED_PROBABILITY_MASS,
    recognizedProbabilityMassBelowFloor: input.recognizedProbabilityMassBelowFloor,
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
