import { canonicalJson, codeUnitCompare, fail, identifier, sha256 } from "./utils.js";

export type TournamentComparison = Readonly<{ candidateAId: string; candidateBId: string }>;
export type PivotTournamentSchedule = Readonly<{
  ring: readonly TournamentComparison[];
  pivot: readonly TournamentComparison[];
  pivotCandidateIds: readonly string[];
  comparisons: readonly TournamentComparison[];
}>;

function seededShuffle(values: readonly string[], seed: number): string[] {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0x7fffffff) fail("verifier_seed_invalid");
  let state = (seed ^ 0x9e3779b9) >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index--) {
    const target = Math.floor(next() * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target]!, shuffled[index]!];
  }
  return shuffled;
}

function pairKey(left: string, right: string): string {
  return codeUnitCompare(left, right) <= 0 ? `${left}\0${right}` : `${right}\0${left}`;
}

export function buildPivotTournamentSchedule(
  candidateIdsInput: readonly string[],
  pivots: number,
  seed: number,
  ringScores: Readonly<Record<string, number>> = {},
): PivotTournamentSchedule {
  if (!Array.isArray(candidateIdsInput) || candidateIdsInput.length === 0) fail("verifier_candidates_required");
  if (candidateIdsInput.length > 64) fail("verifier_candidates_too_many");
  const candidateIds = candidateIdsInput.map((id) => identifier(id, "verifier_candidate_id_invalid"));
  if (new Set(candidateIds).size !== candidateIds.length) fail("verifier_candidate_duplicate");
  if (!Number.isSafeInteger(pivots) || pivots < 1 || pivots > candidateIds.length) fail("verifier_pivots_invalid");

  const order = seededShuffle(candidateIds, seed);
  const ring: TournamentComparison[] = [];
  if (order.length > 1) {
    for (let index = 0; index < order.length; index++) {
      ring.push(Object.freeze({
        candidateAId: order[index]!,
        candidateBId: order[(index + 1) % order.length]!,
      }));
    }
  }
  const pivotCandidateIds = [...candidateIds]
    .sort((left, right) => {
      const scoreDifference = (ringScores[right] ?? 0) - (ringScores[left] ?? 0);
      return scoreDifference || codeUnitCompare(left, right);
    })
    .slice(0, pivots);
  const pivotSet = new Set(pivotCandidateIds);
  const existingPairs = new Set(ring.map((edge) => pairKey(edge.candidateAId, edge.candidateBId)));
  const pivot: TournamentComparison[] = [];
  const add = (candidateAId: string, candidateBId: string) => {
    const key = pairKey(candidateAId, candidateBId);
    if (existingPairs.has(key)) return;
    existingPairs.add(key);
    pivot.push(Object.freeze({ candidateAId, candidateBId }));
  };
  for (const candidateId of [...candidateIds].sort(codeUnitCompare)) {
    if (pivotSet.has(candidateId)) continue;
    for (const pivotId of pivotCandidateIds) add(candidateId, pivotId);
  }
  for (let left = 0; left < pivotCandidateIds.length; left++) {
    for (let right = left + 1; right < pivotCandidateIds.length; right++) {
      add(pivotCandidateIds[left]!, pivotCandidateIds[right]!);
    }
  }
  return Object.freeze({
    ring: Object.freeze(ring),
    pivot: Object.freeze(pivot),
    pivotCandidateIds: Object.freeze(pivotCandidateIds),
    comparisons: Object.freeze([...ring, ...pivot]),
  });
}

export type VerifierScoreIdentityInput = Readonly<{
  tenantId: string;
  taskId: string;
  evidencePackDigest: string;
  candidateADigest: string;
  candidateBDigest: string | null;
  criterionDigest: string;
  backendId: string;
  model: string;
  backendRevision: string;
  mode: string;
  repetition: number;
}>;

export function verifierScoreIdentity(input: VerifierScoreIdentityInput): string {
  if (!Number.isSafeInteger(input.repetition) || input.repetition < 0) fail("verifier_repetition_invalid");
  return sha256(canonicalJson(input));
}

export function bradleyTerryWinProbability(scoreA: number, scoreB: number): number {
  if (![scoreA, scoreB].every((score) => Number.isFinite(score) && score >= 0 && score <= 1)) {
    fail("verifier_score_invalid");
  }
  return 1 / (1 + Math.exp(-(scoreA - scoreB)));
}
