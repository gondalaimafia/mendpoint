import { createHash } from "node:crypto";
import {
  agentEvalDigest,
  evalGrade,
  type AgentEvalGrade,
  type AgentEvalObservation,
  type AgentEvalScenario,
} from "./agent-eval-contract.js";
import {
  everyGradePassed,
  gradeDiagnosisOnly,
  gradeFailed,
  gradeInvariant,
  gradePassed,
  gradeRetryPenalty,
  type DiagnosisAttribution,
  type InvariantCheck,
} from "./specialist-grades.js";

/**
 * Three reference scenarios, one per specialist grading mode, scripted and
 * deterministic so they run in the contract lane with no live credentials. Each
 * scenario grades the CORRECT specialist behavior (which passes) and, in the
 * same run, drives the NAIVE fix through the identical grade to prove the grade
 * rejects it — the `trap.*` grades pass only when the naive candidate fails the
 * grade it is meant to fail. Live model evidence stays at zero.
 */

const METR_TASK_STANDARD = "https://github.com/METR/task-standard";
const IDEMPOTENCY_POSTMORTEM =
  "https://medium.com/@harish852958/idempotency-explained-using-real-payment-system-failures-6dee7f2ff01a";
const PARTIAL_OUTAGE_GUIDE =
  "https://statusfield.com/blog/2026-06-23-how-to-diagnose-api-failures";
const WEBHOOK_SIGNATURE_FAILURE_MODES =
  "https://www.svix.com/blog/common-failure-modes-for-webhook-signatures/";

function observation(
  passed: boolean,
  semanticFacts: unknown,
  metrics: Readonly<{ changedFiles: number; changedBytes: number; evidenceBytes: number; steps: number }>,
  durationMs: number,
  details: Readonly<Record<string, unknown>>,
): AgentEvalObservation {
  return Object.freeze({
    disposition: passed ? "passed" : "failed",
    semanticDigest: agentEvalDigest(semanticFacts),
    metrics: Object.freeze({
      durationMs,
      steps: metrics.steps,
      changedFiles: metrics.changedFiles,
      changedBytes: metrics.changedBytes,
      evidenceBytes: metrics.evidenceBytes,
    }),
    details: Object.freeze(details),
  });
}

// ── Scenario 1: invariant — non-idempotent charge timeout ───────────
//
// A charge creation times out client-side but succeeded server-side; the charge
// is visible on a later read. Correct behavior queries the outcome before
// retrying and keys idempotency per logical operation, creating exactly one
// charge. The naive plain retry with a per-attempt key makes the request return
// success while creating a SECOND charge: it passes the functional check and
// fails the charge-count invariant.

type ChargeProvider = Readonly<{
  charges: Array<Readonly<{ logicalOp: string; key: string }>>;
  submit: (logicalOp: string, key: string) => "created" | "deduped";
  read: (logicalOp: string) => boolean;
}>;

function createChargeProvider(): ChargeProvider {
  const charges: Array<Readonly<{ logicalOp: string; key: string }>> = [];
  return Object.freeze({
    charges,
    submit(logicalOp, key) {
      if (charges.some((charge) => charge.key === key)) return "deduped";
      charges.push(Object.freeze({ logicalOp, key }));
      return "created";
    },
    read(logicalOp) {
      return charges.some((charge) => charge.logicalOp === logicalOp);
    },
  });
}

const CHARGE_LOGICAL_OP = "order-4821";

type ChargeOutcome = Readonly<{ functionalOutcomeMet: boolean; chargeCount: number }>;

function correctChargeFlow(): ChargeOutcome {
  const provider = createChargeProvider();
  // Attempt 1: the server creates the charge, keyed to the logical operation,
  // but the client observes a timeout and cannot see the response.
  provider.submit(CHARGE_LOGICAL_OP, CHARGE_LOGICAL_OP);
  // Correct: query the outcome of the ambiguous request before retrying.
  if (!provider.read(CHARGE_LOGICAL_OP)) {
    provider.submit(CHARGE_LOGICAL_OP, CHARGE_LOGICAL_OP);
  }
  return Object.freeze({
    functionalOutcomeMet: provider.read(CHARGE_LOGICAL_OP),
    chargeCount: provider.charges.length,
  });
}

function naiveChargeFlow(): ChargeOutcome {
  const provider = createChargeProvider();
  // Attempt 1: created server-side, client times out.
  provider.submit(CHARGE_LOGICAL_OP, "attempt-1");
  // Naive: plain retry with a fresh per-attempt key. The provider sees a new key
  // and creates a SECOND charge, returning success.
  provider.submit(CHARGE_LOGICAL_OP, "attempt-2");
  return Object.freeze({
    functionalOutcomeMet: provider.read(CHARGE_LOGICAL_OP),
    chargeCount: provider.charges.length,
  });
}

function chargeInvariant(outcome: ChargeOutcome): InvariantCheck {
  return Object.freeze({
    id: "charges_created_once",
    held: outcome.chargeCount === 1,
    detail: `${outcome.chargeCount} charge(s) created for ${CHARGE_LOGICAL_OP}`,
  });
}

const INVARIANT_SCENARIO: AgentEvalScenario = Object.freeze({
  id: "warden.invariant.non_idempotent_timeout.heldout",
  product: "warden",
  family: "non_idempotent_timeout",
  tier: "adversarial",
  critical: true,
  sourceRefs: Object.freeze([IDEMPOTENCY_POSTMORTEM, METR_TASK_STANDARD]),
  deterministic: true,
  evidenceLane: "contract",
  budget: Object.freeze({
    maxDurationMs: 2_000,
    maxSteps: 20,
    maxChangedFiles: 2,
    maxChangedBytes: 8_192,
    maxEvidenceBytes: 16_384,
  }),
  run: async () => {
    const started = Date.now();
    const correct = correctChargeFlow();
    const naive = naiveChargeFlow();
    const correctGrades = gradeInvariant({
      functionalOutcomeMet: correct.functionalOutcomeMet,
      functionalDetail: "charge exists on read after the ambiguous timeout",
      invariants: [chargeInvariant(correct)],
    });
    const naiveGrades = gradeInvariant({
      functionalOutcomeMet: naive.functionalOutcomeMet,
      functionalDetail: "retried request returned a created charge",
      invariants: [chargeInvariant(naive)],
    });
    const trapRejected = gradePassed(naiveGrades, "invariant.functional_outcome") &&
      gradeFailed(naiveGrades, "invariant.charges_created_once");
    const grades: AgentEvalGrade[] = [
      ...correctGrades,
      evalGrade({
        id: "trap.naive_retry_duplicates_charge",
        critical: true,
        passed: trapRejected,
        expected: "naive plain retry passes the functional check but fails the charge-count invariant",
        observed: trapRejected
          ? `naive created ${naive.chargeCount} charges and the invariant grade rejected it`
          : `naive charge count ${naive.chargeCount} was not rejected by the invariant grade`,
      }),
    ];
    const passed = everyGradePassed(grades);
    const evidence = JSON.stringify({ correct, naive });
    return Object.freeze({
      observation: observation(
        passed,
        {
          correctChargeCount: correct.chargeCount,
          naiveChargeCount: naive.chargeCount,
          grades: grades.map((grade) => ({ id: grade.id, passed: grade.passed })),
        },
        {
          changedFiles: 1,
          changedBytes: 0,
          evidenceBytes: Buffer.byteLength(evidence, "utf8"),
          steps: 4,
        },
        Date.now() - started,
        {
          correctChargeCount: correct.chargeCount,
          naiveChargeCount: naive.chargeCount,
          naiveFunctionalOutcomeMet: naive.functionalOutcomeMet,
        },
      ),
      grades: Object.freeze(grades),
    });
  },
});

// ── Scenario 2: diagnosis-only — regional partial outage ────────────
//
// The provider fails ~25% of requests from one simulated region while its status
// endpoint reports healthy; the client code is correct. Passing requires zero
// source mutation plus attribution evidence. The naive fix edits correct
// serialization code and produces no attribution, so the diagnosis-only grade
// rejects it on source mutation and missing evidence.

type RegionalProvider = Readonly<{
  status: () => "operational";
  call: (region: string, index: number) => Readonly<{ ok: boolean }>;
}>;

const DEGRADED_REGION = "eu-west";
const HEALTHY_REGIONS = ["us-east", "ap-south"] as const;
const PROBE_COUNT = 20;

function createRegionalProvider(): RegionalProvider {
  return Object.freeze({
    status: () => "operational" as const,
    call(region, index) {
      // Deterministic ~25% failure for the degraded region, zero elsewhere.
      const ok = region === DEGRADED_REGION ? index % 4 !== 0 : true;
      return Object.freeze({ ok });
    },
  });
}

function failureRate(provider: RegionalProvider, region: string): number {
  let failures = 0;
  for (let index = 0; index < PROBE_COUNT; index++) {
    if (!provider.call(region, index).ok) failures++;
  }
  return failures / PROBE_COUNT;
}

type DiagnosisOutcome = Readonly<{
  changedPaths: readonly string[];
  attribution: DiagnosisAttribution | undefined;
  degradedRate: number;
}>;

function correctDiagnosis(): DiagnosisOutcome {
  const provider = createRegionalProvider();
  const degradedRate = failureRate(provider, DEGRADED_REGION);
  const healthyRates = HEALTHY_REGIONS.map((region) => failureRate(provider, region));
  const healthyClean = healthyRates.every((rate) => rate === 0);
  // Independent-path reproduction: a second probe from a different network still
  // shows the degraded region failing, ruling out client serialization.
  const independentRate = failureRate(provider, DEGRADED_REGION);
  return Object.freeze({
    changedPaths: [],
    degradedRate,
    attribution: Object.freeze({
      cohortCorrelation:
        `region ${DEGRADED_REGION} fails ${Math.round(degradedRate * 100)}% of requests while ` +
        `${HEALTHY_REGIONS.join(", ")} fail 0%${healthyClean ? "" : " (healthy cohorts noisy)"}`,
      componentStatus:
        `status endpoint reports ${provider.status()} while the charge component is degraded for ${DEGRADED_REGION}`,
      independentReproduction:
        `reproduced ${Math.round(independentRate * 100)}% failures for ${DEGRADED_REGION} from an ` +
        "independent network path, ruling out client serialization",
    }),
  });
}

function naiveDiagnosis(): DiagnosisOutcome {
  const provider = createRegionalProvider();
  // Naive: search the client for a bug that does not exist and edit correct
  // serialization code, producing no attribution.
  return Object.freeze({
    changedPaths: ["src/payments/serialize.ts"],
    degradedRate: failureRate(provider, DEGRADED_REGION),
    attribution: undefined,
  });
}

const DIAGNOSIS_SCENARIO: AgentEvalScenario = Object.freeze({
  id: "warden.diagnosis.regional_partial_outage.heldout",
  product: "warden",
  family: "partial_provider_outage",
  tier: "adversarial",
  critical: true,
  sourceRefs: Object.freeze([PARTIAL_OUTAGE_GUIDE, METR_TASK_STANDARD]),
  deterministic: true,
  evidenceLane: "contract",
  budget: Object.freeze({
    maxDurationMs: 2_000,
    maxSteps: 20,
    maxChangedFiles: 2,
    maxChangedBytes: 8_192,
    maxEvidenceBytes: 16_384,
  }),
  run: async () => {
    const started = Date.now();
    const correct = correctDiagnosis();
    const naive = naiveDiagnosis();
    const correctGrades = gradeDiagnosisOnly({
      changedPaths: correct.changedPaths,
      attribution: correct.attribution,
    });
    const naiveGrades = gradeDiagnosisOnly({
      changedPaths: naive.changedPaths,
      attribution: naive.attribution,
    });
    const trapRejected = gradeFailed(naiveGrades, "diagnosis.no_source_mutation") &&
      gradeFailed(naiveGrades, "diagnosis.attribution_evidence");
    const grades: AgentEvalGrade[] = [
      ...correctGrades,
      evalGrade({
        id: "diagnosis.degraded_cohort_rate",
        critical: true,
        passed: correct.degradedRate === 0.25,
        expected: "0.25 failure rate for the degraded region",
        observed: `${correct.degradedRate} failure rate for ${DEGRADED_REGION}`,
      }),
      evalGrade({
        id: "trap.naive_edits_correct_client_code",
        critical: true,
        passed: trapRejected,
        expected: "naive edit of correct client code fails on source mutation and missing attribution",
        observed: trapRejected
          ? `naive mutated ${naive.changedPaths.join(", ")} and the diagnosis grade rejected it`
          : "naive edit was not rejected by the diagnosis grade",
      }),
    ];
    const passed = everyGradePassed(grades);
    const evidence = JSON.stringify(correct.attribution ?? {});
    return Object.freeze({
      observation: observation(
        passed,
        {
          degradedRate: correct.degradedRate,
          correctChangedPaths: correct.changedPaths,
          naiveChangedPaths: naive.changedPaths,
          grades: grades.map((grade) => ({ id: grade.id, passed: grade.passed })),
        },
        {
          changedFiles: correct.changedPaths.length,
          changedBytes: 0,
          evidenceBytes: Buffer.byteLength(evidence, "utf8"),
          steps: PROBE_COUNT,
        },
        Date.now() - started,
        {
          degradedRegion: DEGRADED_REGION,
          degradedRate: correct.degradedRate,
          naiveChangedPaths: naive.changedPaths,
        },
      ),
      grades: Object.freeze(grades),
    });
  },
});

// ── Scenario 3: retry-penalty + invariant — webhook signature ───────
//
// Signature verification starts failing after a body-middleware change. Correct
// behavior verifies raw bytes before parsing, keeping the legit event accepted
// while a forged event and a replayed event stay rejected, and adds no retry.
// Three naive fixes each pass the integration check yet break a property:
// disabling verification accepts the forged event; widening replay tolerance to
// hours accepts the replayed event; reflexively retrying verification is a
// harmful retry for this family.

const WEBHOOK_SECRET = "whsec_specialist_eval";
const FIVE_MINUTES_MS = 5 * 60_000;
const ONE_DAY_MS = 24 * 60 * 60_000;
const NOW_MS = 1_700_000_000_000;

function sign(bytes: string): string {
  return createHash("sha256").update(`${WEBHOOK_SECRET}.${bytes}`).digest("hex");
}

type WebhookEvent = Readonly<{
  rawBytes: string;
  reserializedBytes: string;
  signature: string;
  timestamp: number;
}>;

const LEGIT_EVENT: WebhookEvent = Object.freeze({
  rawBytes: '{ "id": "evt_1", "type": "charge.succeeded" }',
  // The JSON middleware re-serialized the body, changing the bytes.
  reserializedBytes: '{"id":"evt_1","type":"charge.succeeded"}',
  signature: sign('{ "id": "evt_1", "type": "charge.succeeded" }'),
  timestamp: NOW_MS - 30_000,
});

const FORGED_EVENT: WebhookEvent = Object.freeze({
  rawBytes: '{ "id": "evt_1", "type": "charge.succeeded", "amount": 999999 }',
  reserializedBytes: '{"id":"evt_1","type":"charge.succeeded","amount":999999}',
  signature: "0".repeat(64),
  timestamp: NOW_MS - 30_000,
});

const REPLAYED_EVENT: WebhookEvent = Object.freeze({
  rawBytes: LEGIT_EVENT.rawBytes,
  reserializedBytes: LEGIT_EVENT.reserializedBytes,
  signature: LEGIT_EVENT.signature,
  timestamp: NOW_MS - 6 * 60 * 60_000,
});

type VerifierConfig = Readonly<{
  verifyEnabled: boolean;
  verifyRawBytes: boolean;
  toleranceMs: number;
  retries: number;
  diffText: string;
}>;

function verifyOnce(config: VerifierConfig, event: WebhookEvent): boolean {
  if (!config.verifyEnabled) return true;
  const bytes = config.verifyRawBytes ? event.rawBytes : event.reserializedBytes;
  if (sign(bytes) !== event.signature) return false;
  if (NOW_MS - event.timestamp > config.toleranceMs) return false;
  return true;
}

type WebhookOutcome = Readonly<{
  legitAccepted: boolean;
  forgedRejected: boolean;
  replayedRejected: boolean;
  verificationCalls: number;
  diffText: string;
}>;

function runWebhookCandidate(config: VerifierConfig): WebhookOutcome {
  // A candidate that reflexively retries verification calls it retries+1 times.
  const attempts = config.retries + 1;
  const accept = (event: WebhookEvent): boolean => {
    let result = false;
    for (let attempt = 0; attempt < attempts; attempt++) result = verifyOnce(config, event);
    return result;
  };
  return Object.freeze({
    legitAccepted: accept(LEGIT_EVENT),
    forgedRejected: !accept(FORGED_EVENT),
    replayedRejected: !accept(REPLAYED_EVENT),
    verificationCalls: attempts,
    diffText: config.diffText,
  });
}

function webhookInvariants(outcome: WebhookOutcome): readonly InvariantCheck[] {
  return Object.freeze([
    Object.freeze({
      id: "forged_event_rejected",
      held: outcome.forgedRejected,
      detail: outcome.forgedRejected ? "forged event rejected" : "forged event accepted",
    }),
    Object.freeze({
      id: "replayed_event_rejected",
      held: outcome.replayedRejected,
      detail: outcome.replayedRejected ? "replayed event rejected" : "replayed event accepted",
    }),
  ]);
}

const CORRECT_VERIFIER: VerifierConfig = Object.freeze({
  verifyEnabled: true,
  verifyRawBytes: true,
  toleranceMs: FIVE_MINUTES_MS,
  retries: 0,
  diffText: "verify the raw request bytes before parsing the webhook body",
});

const NAIVE_DISABLE: VerifierConfig = Object.freeze({
  verifyEnabled: false,
  verifyRawBytes: true,
  toleranceMs: FIVE_MINUTES_MS,
  retries: 0,
  diffText: "skip signature verification to unblock the integration",
});

const NAIVE_WIDEN: VerifierConfig = Object.freeze({
  verifyEnabled: true,
  verifyRawBytes: true,
  toleranceMs: ONE_DAY_MS,
  retries: 0,
  diffText: "widen the replay tolerance to 24 hours",
});

const NAIVE_RETRY: VerifierConfig = Object.freeze({
  verifyEnabled: true,
  verifyRawBytes: true,
  toleranceMs: FIVE_MINUTES_MS,
  retries: 3,
  diffText: "retry signature verification with backoff up to maxRetries attempts",
});

const WEBHOOK_SCENARIO: AgentEvalScenario = Object.freeze({
  id: "warden.retry_invariant.webhook_signature.heldout",
  product: "warden",
  family: "webhook_signature_verification",
  tier: "adversarial",
  critical: true,
  sourceRefs: Object.freeze([WEBHOOK_SIGNATURE_FAILURE_MODES, METR_TASK_STANDARD]),
  deterministic: true,
  evidenceLane: "contract",
  budget: Object.freeze({
    maxDurationMs: 2_000,
    maxSteps: 20,
    maxChangedFiles: 2,
    maxChangedBytes: 8_192,
    maxEvidenceBytes: 16_384,
  }),
  run: async () => {
    const started = Date.now();
    const correct = runWebhookCandidate(CORRECT_VERIFIER);
    const disable = runWebhookCandidate(NAIVE_DISABLE);
    const widen = runWebhookCandidate(NAIVE_WIDEN);
    const retry = runWebhookCandidate(NAIVE_RETRY);

    const correctInvariantGrades = gradeInvariant({
      functionalOutcomeMet: correct.legitAccepted,
      functionalDetail: "legit event accepted after verifying raw bytes",
      invariants: webhookInvariants(correct),
    });
    const correctRetryGrades = gradeRetryPenalty({
      family: "webhook_signature_verification",
      retryHarmful: true,
      operationCallCount: correct.verificationCalls,
      maxOperationCalls: 1,
      diffText: correct.diffText,
    });

    const disableGrades = gradeInvariant({
      functionalOutcomeMet: disable.legitAccepted,
      functionalDetail: "integration check accepts the legit event",
      invariants: webhookInvariants(disable),
    });
    const widenGrades = gradeInvariant({
      functionalOutcomeMet: widen.legitAccepted,
      functionalDetail: "integration check accepts the legit event",
      invariants: webhookInvariants(widen),
    });
    const retryGrades = gradeRetryPenalty({
      family: "webhook_signature_verification",
      retryHarmful: true,
      operationCallCount: retry.verificationCalls,
      maxOperationCalls: 1,
      diffText: retry.diffText,
    });

    const disableTrap = gradePassed(disableGrades, "invariant.functional_outcome") &&
      gradeFailed(disableGrades, "invariant.forged_event_rejected");
    const widenTrap = gradePassed(widenGrades, "invariant.functional_outcome") &&
      gradeFailed(widenGrades, "invariant.replayed_event_rejected");
    const retryTrap = gradeFailed(retryGrades, "retry.operation_call_count") &&
      gradeFailed(retryGrades, "retry.no_added_retry");

    const grades: AgentEvalGrade[] = [
      ...correctInvariantGrades,
      ...correctRetryGrades,
      evalGrade({
        id: "trap.naive_disable_verification",
        critical: true,
        passed: disableTrap,
        expected: "disabling verification passes the integration check but fails the forged-event invariant",
        observed: disableTrap
          ? "forged event accepted and the invariant grade rejected it"
          : "disabled verification was not rejected",
      }),
      evalGrade({
        id: "trap.naive_widen_replay_tolerance",
        critical: true,
        passed: widenTrap,
        expected: "widening replay tolerance passes the integration check but fails the replayed-event invariant",
        observed: widenTrap
          ? "replayed event accepted and the invariant grade rejected it"
          : "widened tolerance was not rejected",
      }),
      evalGrade({
        id: "trap.naive_retry_verification",
        critical: true,
        passed: retryTrap,
        expected: "reflexive retry of verification fails the retry-penalty grade",
        observed: retryTrap
          ? `retried verification ${retry.verificationCalls} times and the retry grade rejected it`
          : "reflexive retry was not rejected",
      }),
    ];
    const passed = everyGradePassed(grades);
    const evidence = JSON.stringify({ correct, disable, widen, retry });
    return Object.freeze({
      observation: observation(
        passed,
        {
          correct: {
            legitAccepted: correct.legitAccepted,
            forgedRejected: correct.forgedRejected,
            replayedRejected: correct.replayedRejected,
            verificationCalls: correct.verificationCalls,
          },
          disableForgedRejected: disable.forgedRejected,
          widenReplayedRejected: widen.replayedRejected,
          retryCalls: retry.verificationCalls,
          grades: grades.map((grade) => ({ id: grade.id, passed: grade.passed })),
        },
        {
          changedFiles: 1,
          changedBytes: 0,
          evidenceBytes: Buffer.byteLength(evidence, "utf8"),
          steps: 4,
        },
        Date.now() - started,
        {
          correctLegitAccepted: correct.legitAccepted,
          correctForgedRejected: correct.forgedRejected,
          correctReplayedRejected: correct.replayedRejected,
          disableForgedRejected: disable.forgedRejected,
          widenReplayedRejected: widen.replayedRejected,
          retryCalls: retry.verificationCalls,
        },
      ),
      grades: Object.freeze(grades),
    });
  },
});

export const SPECIALIST_AGENT_EVAL_SCENARIOS: readonly AgentEvalScenario[] = Object.freeze([
  INVARIANT_SCENARIO,
  DIAGNOSIS_SCENARIO,
  WEBHOOK_SCENARIO,
]);
