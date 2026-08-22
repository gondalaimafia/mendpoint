/**
 * Durable evidence-record type contracts for policy-routed execution.
 *
 * These types describe the shape of router evidence events and prepared
 * envelopes. They are still consumed by the adaptive-routing aggregation in
 * `router-adaptive.ts`, which parses recorded evidence to learn from history.
 *
 * The runtime that produced, replayed, and finalized these records
 * (`PolicyRouterRuntime`, plus its in-memory and JSONL evidence stores) was
 * never wired to a production path and has been removed; see
 * `docs/adr/0011-remove-policy-router-runtime.md`. The live routing path is
 * `evaluateExecutor` / `routeTask` in `router.ts` and `createWardenRoutingRuntime`
 * in the worker, none of which depend on a durable envelope runtime.
 */
import type {
  ExecutorDescriptor,
  HumanHandoffReason,
  RouterFailureCode,
  RouterPolicySnapshot,
  RouterTaskSpec,
  RoutingDecisionRecord,
} from "./router.js";
import type { AdaptiveRoutingStats } from "./router-adaptive.js";

export type RouterRetryPolicy = Readonly<{
  maxAttempts: number;
  sameExecutorRetries: number;
  fallbackEnabled: boolean;
  retryableErrorCodes: readonly RouterFailureCode[];
  fallbackErrorCodes: readonly RouterFailureCode[];
  retryBackoffMs: readonly number[];
}>;

export type PersistedRouterTaskSpec = Readonly<
  Omit<RouterTaskSpec, "goal"> & { goalDigest: string }
>;

export type RouterVerificationEvidence = Readonly<{
  verdict: "passed" | "failed" | "unknown";
  evidenceArtifactIds: readonly string[];
  verifierId: string;
  verifierVersion?: string;
}>;

export type RouterActualOutcomeInput = Readonly<{
  idempotencyKey: string;
  executorId: string;
  providerId: string;
  outcome: "succeeded" | "failed" | "cancelled";
  startedAt: string;
  completedAt: string;
  actualLatencyMs: number;
  /** Null means the metering source has not supplied authoritative cost. */
  actualCostUsd: number | null;
  actualQualityScore?: number;
  errorCode?: RouterFailureCode;
  verification: RouterVerificationEvidence;
}>;

export type RouterDispatch = Readonly<{
  executorId: string;
  providerId: string;
  executorKind: ExecutorDescriptor["kind"];
  executorVersion: string;
  priceVersion: string;
  executionRegion: string;
  expectedQualityScore: number;
  expectedLatencyMs: number;
  expectedCostUsd: number;
  attempt: number;
  kind: "primary" | "retry" | "fallback";
  fallbackFromExecutorId?: string;
  notBefore?: string;
}>;

type SerializableRoute = Omit<RouterDispatch, "attempt" | "kind" | "fallbackFromExecutorId">;

export type RouterPreparedEnvelope = Readonly<{
  schemaVersion: 1;
  envelopeId: string;
  createdAt: string;
  task: PersistedRouterTaskSpec;
  policy: RouterPolicySnapshot;
  executorSnapshot: readonly ExecutorDescriptor[];
  availabilitySnapshot: readonly Readonly<{
    executorId: string;
    providerId: string;
    allowed: boolean;
  }>[];
  constraints: Readonly<{
    classification: RouterTaskSpec["privacy"]["classification"];
    externalProcessingAllowed: boolean;
    requiredRegion?: string;
    allowedExecutionRegions: readonly string[];
    maximumBudgetUsd: number;
    maximumLatencyMs: number;
    minimumQualityScore: number;
    taskRisk: RouterTaskSpec["risk"];
    maximumAutonomousRisk: RouterPolicySnapshot["risk"]["maximumAutonomousRisk"];
  }>;
  retryPolicy: RouterRetryPolicy;
  decision: RoutingDecisionRecord;
  action: "execute" | "human_handoff";
  selectedExecutorId: string | null;
  eligibleExecutors: readonly SerializableRoute[];
  excludedExecutors: RoutingDecisionRecord["evaluations"];
  primary?: SerializableRoute;
  fallbacks: readonly SerializableRoute[];
  rationale: readonly string[];
  estimate: Readonly<{
    selectedCostUsd: number | null;
    selectedLatencyMs: number | null;
    maximumAuthorizedCostUsd: number;
  }>;
  handoffReason?: HumanHandoffReason;
  /**
   * Recorded outcome aggregates that fed adaptive ranking for this decision.
   * Present only when adaptive routing is enabled and frozen into the envelope so
   * a decision can be reproduced from the same history. Absent (and omitted from
   * the envelope fingerprint) when adaptive routing is off, so the envelope and
   * decision stay byte-identical to static-only routing.
   */
  adaptiveStatsSnapshot?: AdaptiveRoutingStats;
}>;

export type RouterAttemptEvidence = Readonly<{
  dispatch: RouterDispatch;
  idempotencyKey: string;
  outcome: RouterActualOutcomeInput["outcome"];
  startedAt: string;
  completedAt: string;
  actualLatencyMs: number;
  actualCostUsd: number | null;
  actualQualityScore?: number;
  errorCode?: RouterFailureCode;
  verification: RouterVerificationEvidence;
}>;

export type RouterEvidenceEvent = Readonly<{
  eventId: string;
  envelopeId: string;
  sequence: number;
  previousEventId: string | null;
  recordedAt: string;
  type: "prepared" | "dispatch" | "attempt" | "final";
  data: unknown;
}>;
