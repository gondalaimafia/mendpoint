import type { VerifierBackend, VerifierCriterion, VerifierUsage } from "./types.js";
import { verifierScoreIdentity } from "./tournament.js";
import { boundedText, canonicalJson, codeUnitCompare, deepFreeze, exactDigest, fail, identifier, rejectPrivateReasoning, sha256, sortedUnique } from "./utils.js";

export type VerifierProgressStep = Readonly<{
  stepId: string;
  kind: "observation" | "tool" | "verification" | "candidate";
  summary: string;
  evidenceRefs: readonly string[];
}>;
export type VerifierProgressState = "not_started" | "evidence_gathering" | "plausible_plan" | "candidate_produced" | "verification_incomplete" | "deterministic_survivor" | "blocked" | "complete";
export type VerifierProgressResult = Readonly<{
  schemaVersion: "2026-08-17.progress.v1";
  taskId: string;
  checkpoints: readonly Readonly<{ stepId: string; score: number; state: VerifierProgressState; scoreDigest: string }>[];
  state: VerifierProgressState;
  usage: VerifierUsage;
  estimatedCostUsd: number;
  resultDigest: string;
}>;

export async function trackVerifierProgress(input: Readonly<{
  backend: VerifierBackend;
  tenantId: string;
  taskId: string;
  evidencePackDigest: string;
  trustedTask: string;
  trustedEvidence: string;
  criteria: readonly VerifierCriterion[];
  steps: readonly VerifierProgressStep[];
  checkpointStepIds: readonly string[];
  evaluations: number;
  signal?: AbortSignal;
}>): Promise<VerifierProgressResult> {
  rejectPrivateReasoning(input);
  const tenantId = identifier(input.tenantId, "verifier_tenant_id_invalid");
  const taskId = identifier(input.taskId, "verifier_task_id_invalid");
  const packDigest = exactDigest(input.evidencePackDigest, "verifier_evidence_digest_invalid");
  const trustedTask = boundedText(input.trustedTask, "verifier_task_invalid", 4096);
  const trustedEvidence = boundedText(input.trustedEvidence, "verifier_evidence_invalid", 128 * 1024);
  if (!Array.isArray(input.criteria) || !input.criteria.length || input.criteria.length > 32) fail("verifier_criteria_invalid");
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 256) fail("verifier_progress_steps_invalid");
  if (!Number.isSafeInteger(input.evaluations) || input.evaluations < 1 || input.evaluations > 16) fail("verifier_evaluations_invalid");
  const steps = input.steps.map((step) => ({
    stepId: identifier(step.stepId, "verifier_progress_step_id_invalid"),
    kind: step.kind,
    summary: boundedText(step.summary, "verifier_progress_summary_invalid", 4096),
    evidenceRefs: sortedUnique(step.evidenceRefs, "verifier_progress_evidence_invalid", 64),
  }));
  if (new Set(steps.map(({ stepId }) => stepId)).size !== steps.length) fail("verifier_progress_step_duplicate");
  const indexes = input.checkpointStepIds.map((id) => steps.findIndex((step) => step.stepId === id));
  if (!indexes.length || indexes.some((index) => index < 0) || indexes.some((index, position) => position > 0 && index <= indexes[position - 1]!)) {
    fail("verifier_progress_checkpoints_invalid");
  }
  const totals = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cost: 0 };
  const checkpoints: Array<{ stepId: string; score: number; state: VerifierProgressState; scoreDigest: string }> = [];
  for (const checkpointIndex of indexes) {
    const observableOutput = steps.slice(0, checkpointIndex + 1).map((step) => `[${step.kind}] ${step.summary}`).join("\n");
    const candidateId = `progress:${steps[checkpointIndex]!.stepId}`;
    const candidateDigest = sha256(observableOutput);
    let weighted = 0;
    let weight = 0;
    for (const criterion of input.criteria) {
      const criterionDigest = sha256(canonicalJson(criterion));
      for (let repetition = 0; repetition < input.evaluations; repetition++) {
        const requestId = verifierScoreIdentity({ tenantId, taskId, evidencePackDigest: packDigest, candidateADigest: candidateDigest, candidateBDigest: null, criterionDigest, backendId: input.backend.descriptor.backendId, model: input.backend.descriptor.model, backendRevision: input.backend.descriptor.backendRevision, mode: input.backend.descriptor.mode, repetition });
        const response = await input.backend.score({
          requestId, tenantId, taskId, evidencePackDigest: packDigest, criterion,
          candidates: [{ candidateId, artifactDigest: candidateDigest, observableOutput, changedPaths: [] }],
          trustedTask, trustedEvidence, repetition, signal: input.signal,
        });
        const score = response.scores[candidateId];
        if (score === undefined || !Number.isFinite(score) || score < 0 || score > 1) fail("verifier_progress_score_invalid");
        weighted += score * criterion.weight;
        weight += criterion.weight;
        totals.inputTokens += response.usage.inputTokens;
        totals.cachedInputTokens += response.usage.cachedInputTokens;
        totals.outputTokens += response.usage.outputTokens;
        totals.reasoningTokens += response.usage.reasoningTokens;
        totals.totalTokens += response.usage.totalTokens;
        totals.cost += response.estimatedCostUsd;
      }
    }
    const score = weight ? weighted / weight : 0;
    const step = steps[checkpointIndex]!;
    const state = progressState(step.kind, score);
    checkpoints.push({ stepId: step.stepId, score, state, scoreDigest: sha256(canonicalJson({ candidateDigest, score, state })) });
  }
  const usage = Object.freeze({ inputTokens: totals.inputTokens, cachedInputTokens: totals.cachedInputTokens, outputTokens: totals.outputTokens, reasoningTokens: totals.reasoningTokens, totalTokens: totals.totalTokens });
  const base = { schemaVersion: "2026-08-17.progress.v1" as const, taskId, checkpoints: Object.freeze(checkpoints), state: checkpoints.at(-1)?.state ?? "not_started" as VerifierProgressState, usage, estimatedCostUsd: totals.cost };
  return deepFreeze({ ...base, resultDigest: sha256(canonicalJson(base)) });
}

function progressState(kind: VerifierProgressStep["kind"], score: number): VerifierProgressState {
  if (score < 0.25) return "blocked";
  if (kind === "verification" && score >= 0.75) return "complete";
  if (kind === "candidate" && score >= 0.75) return "deterministic_survivor";
  if (kind === "candidate") return "candidate_produced";
  if (kind === "verification") return "verification_incomplete";
  if (score >= 0.5) return "plausible_plan";
  return "evidence_gathering";
}
