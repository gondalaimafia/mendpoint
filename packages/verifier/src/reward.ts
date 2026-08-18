import { fail } from "./utils.js";

export type LogProbabilityAlternative = Readonly<{ token: string; logprob: number }>;
export type FineGrainedReward = Readonly<{
  value: number;
  recognizedTokenCount: number;
  recognizedProbabilityMass: number;
}>;

const SCORE_TOKENS = "ABCDEFGHIJKLMNOPQRST";

export function decodeFineGrainedReward(alternatives: readonly LogProbabilityAlternative[]): FineGrainedReward {
  if (!Array.isArray(alternatives) || alternatives.length === 0 || alternatives.length > 20) {
    fail("verifier_logprob_alternatives_invalid");
  }
  const probabilities = new Map<string, number>();
  for (const alternative of alternatives) {
    const token = typeof alternative.token === "string" ? alternative.token.trim() : "";
    if (!Number.isFinite(alternative.logprob) || alternative.logprob > 0) fail("verifier_logprob_invalid");
    if (!/^[A-T]$/.test(token)) continue;
    const probability = Math.exp(alternative.logprob);
    probabilities.set(token, Math.max(probabilities.get(token) ?? 0, probability));
  }
  if (probabilities.size === 0) fail("verifier_logprob_score_tokens_missing");
  const mass = [...probabilities.values()].reduce((total, value) => total + value, 0);
  if (!Number.isFinite(mass) || mass <= 0) fail("verifier_logprob_probability_invalid");
  let weighted = 0;
  for (const [token, probability] of probabilities) {
    const rank = SCORE_TOKENS.indexOf(token);
    weighted += probability * ((19 - rank) / 19);
  }
  return Object.freeze({
    value: weighted / mass,
    recognizedTokenCount: probabilities.size,
    recognizedProbabilityMass: mass,
  });
}
