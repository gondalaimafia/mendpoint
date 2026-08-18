import type { VerifierBackend, VerifierBackendScore, VerifierBackendScoreInput, VerifierUsage } from "./types.js";
import { boundedText, deepFreeze, exactDigest, fail, nonnegative, rejectPrivateReasoning } from "./utils.js";

export type MuseSelfVerifierInvocation = Readonly<{
  scores: Readonly<Record<string, number>>;
  usage: VerifierUsage;
  estimatedCostUsd: number;
  latencyMs: number;
  responseDigest: string;
}>;

export function createMuseSelfVerifierBackend(input: Readonly<{
  model: string;
  backendRevision: string;
  invoke(request: VerifierBackendScoreInput): Promise<MuseSelfVerifierInvocation>;
}>): VerifierBackend {
  const model = boundedText(input.model, "verifier_muse_model_invalid", 256);
  const backendRevision = boundedText(input.backendRevision, "verifier_muse_revision_invalid", 256);
  if (typeof input.invoke !== "function") fail("verifier_muse_invoker_invalid");
  const invoke = input.invoke.bind(input);
  return Object.freeze({
    descriptor: Object.freeze({ backendId: "muse-self-verifier", provider: "muse", model, backendRevision, mode: "muse_self" }),
    async score(request: VerifierBackendScoreInput): Promise<VerifierBackendScore> {
      const result = await invoke(request);
      rejectPrivateReasoning(result);
      const candidateIds = new Set(request.candidates.map(({ candidateId }) => candidateId));
      if (Object.keys(result.scores).length !== candidateIds.size || Object.keys(result.scores).some((candidateId) => !candidateIds.has(candidateId))) {
        fail("verifier_muse_scores_invalid");
      }
      const scores = Object.fromEntries(Object.entries(result.scores).map(([candidateId, score]) => {
        if (!Number.isFinite(score) || score < 0 || score > 1) fail("verifier_muse_score_invalid");
        return [candidateId, score];
      }));
      const usage = normalizeUsage(result.usage);
      return deepFreeze({
        requestId: request.requestId,
        scores,
        criterionId: request.criterion.id,
        rawResponseDigest: exactDigest(result.responseDigest, "verifier_muse_response_digest_invalid"),
        recognizedProbabilityMass: 1,
        usage,
        estimatedCostUsd: nonnegative(result.estimatedCostUsd, "verifier_muse_cost_invalid"),
        latencyMs: nonnegative(result.latencyMs, "verifier_muse_latency_invalid"),
      });
    },
  });
}

function normalizeUsage(input: VerifierUsage): VerifierUsage {
  const values = [input.inputTokens, input.cachedInputTokens, input.outputTokens, input.reasoningTokens, input.totalTokens];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0) || input.cachedInputTokens > input.inputTokens || input.totalTokens !== input.inputTokens + input.outputTokens) {
    fail("verifier_muse_usage_invalid");
  }
  return Object.freeze({ ...input });
}
