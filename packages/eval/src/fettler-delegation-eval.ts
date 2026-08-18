import {
  agentEvalDigest,
  evalGrade,
  type AgentEvalScenario,
} from "./agent-eval-contract.js";
import { runFettlerDelegationEvalTrial } from "./warden-source-eval.js";

export const FETTLER_DELEGATION_DELIVERY_EVAL_SCENARIO: AgentEvalScenario = Object.freeze({
  id: "fettler.delegation.apply_verify_draft.simulated",
  product: "warden",
  family: "apply_verify_draft_delivery",
  tier: "recovery",
  critical: true,
  sourceRefs: Object.freeze([
    "https://github.com/SWE-bench/SWE-bench",
    "https://github.com/METR/task-standard",
    "https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request",
  ]),
  deterministic: true,
  evidenceLane: "simulated_scripted",
  budget: Object.freeze({
    maxDurationMs: 30_000,
    maxSteps: 64,
    maxChangedFiles: 1,
    maxChangedBytes: 2_048,
    maxEvidenceBytes: 12_000,
  }),
  run: async (trial) => {
    const started = Date.now();
    const result = await runFettlerDelegationEvalTrial(trial);
    return Object.freeze({
      observation: Object.freeze({
        disposition: result.passed ? "passed" : "failed",
        semanticDigest: agentEvalDigest({
          lane: "simulated_scripted",
          liveModelCapability: false,
          liveScmCapability: false,
          changedPaths: result.changedPaths,
          stoppedReason: result.stoppedReason,
          delivery: {
            delivered: result.delivery.delivered,
            draftOnly: result.delivery.draftOnly,
            exactFiles: result.delivery.exactFiles,
            identicalReplay: result.delivery.identicalReplay,
            pullRequestCount: result.delivery.pullRequestCount,
          },
          grades: result.grades.map((grade) => ({ id: grade.id, passed: grade.passed })),
        }),
        metrics: Object.freeze({
          durationMs: Date.now() - started,
          steps: result.steps + result.grades.length,
          changedFiles: result.changedPaths.length,
          changedBytes: result.changedBytes,
          evidenceBytes: result.evidenceBytes,
          toolCalls: result.toolCalls,
          modelCalls: result.modelCalls,
        }),
        details: Object.freeze({
          lane: "simulated_scripted",
          liveModelCapability: false,
          liveScmCapability: false,
          authenticatedHumanApproval: false,
          productionWorkerExecution: true,
          productionWorkerDelivery: true,
          exactDraftBoundary: true,
          pullRequestCount: result.delivery.pullRequestCount,
          draftUrl: result.delivery.result?.url ?? null,
        }),
      }),
      grades: Object.freeze(result.grades.map((grade) => evalGrade({
        id: grade.id,
        critical: true,
        passed: grade.passed,
        expected: grade.expected,
        observed: grade.observed,
      }))),
    });
  },
});
