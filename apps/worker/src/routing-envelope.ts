import { createHash } from "node:crypto";
import type {
  DataClassification,
  RouterPolicySnapshot,
  RouterTaskSpec,
  TaskRisk,
} from "@mendpoint/platform";

/**
 * Single source of truth for the router policy envelope both production routers
 * (Warden and Transformer) submit. Before this module each router owned an
 * independently hardcoded `buildTaskSpec`/`buildPolicySnapshot` pair; the
 * snapshot id was a digest of that hardcoded body, so nothing could ever be
 * inherited and two copies could silently drift. Here the common structure and
 * constants live once and every per-product value is passed in.
 */

/** Ordered classification lattice, least to most sensitive. */
const CLASSIFICATION_ORDER: readonly DataClassification[] = Object.freeze([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

/**
 * Tools every routed task requires an executor to provide. Both real executors
 * (the Warden attempt and the Transformer attempt) read files, write files, and
 * run a verification command, so this is the honest requirement — not the empty
 * array that made the `tool_missing` gate structurally inert. Declaring it means
 * an executor that cannot supply one of these tools is genuinely excluded.
 */
export const ROUTING_REQUIRED_TOOLS: readonly string[] = Object.freeze([
  "read_file",
  "write_file",
  "run_command",
]);

/**
 * The allowed-classification ceiling for an envelope, fail-safe by construction.
 * An explicitly declared maximum admits every classification up to and including
 * it; an ABSENT (undefined) or unknown maximum authorizes only `public`. Absence
 * therefore closes rather than widens — a source policy that never ran cannot
 * silently unlock the most sensitive tier (cf. the non-training default in
 * `packages/agent/src/model-tenant-routing.ts`).
 */
export function allowedClassificationsForCeiling(
  maximum: DataClassification | undefined,
): readonly DataClassification[] {
  if (maximum === undefined) return Object.freeze(["public"] as const);
  const index = CLASSIFICATION_ORDER.indexOf(maximum);
  if (index < 0) return Object.freeze(["public"] as const);
  return Object.freeze(CLASSIFICATION_ORDER.slice(0, index + 1));
}

/** Deterministic, key-sorted JSON so a content-addressed snapshot id is stable. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("routing_canonical_value_invalid");
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Content-addressed `sha256:` digest of a canonicalized value. */
export function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

/**
 * Honest lower-bound estimate of the prompt-seed input tokens available AT the
 * routing call (task goal, verification command, and artifact identifiers). A
 * seed estimate, not a full-context measurement — the repository context size is
 * unknown until the attempt runs — but a real, input-derived value rather than a
 * hardcoded zero, so the `hard_limit_exceeded` gate can fire when a seed already
 * exceeds a specialized executor's input window. Approximated at ~4 chars/token.
 */
export function estimateSeedInputTokens(
  parts: readonly (string | undefined)[],
): number {
  const chars = parts.reduce((sum, part) => sum + (part?.length ?? 0), 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Risk-adjusted minimum quality floor (§13.4: quality gates override cost, and
 * higher-risk work demands stronger results). Replaces the inert `minimumScore:
 * 0` so the router's `quality_below_minimum` gate can fire.
 */
export function riskQualityFloor(risk: TaskRisk): number {
  switch (risk) {
    case "low":
      return 0.6;
    case "medium":
      return 0.7;
    case "high":
      return 0.8;
    case "critical":
      return 0.9;
  }
}

const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const DEFAULT_MAX_LATENCY_MS = 3_600_000;
const DEFAULT_BUDGET_USD = 25;

/** Per-product task inputs; the shared structure and constants are supplied here. */
export type RoutingTaskSpecInput = Readonly<{
  taskId: string;
  tenantId: string;
  kind: string;
  goal: string;
  idempotencyKey: string;
  inputArtifactIds: readonly string[];
  requiredCapabilities: readonly string[];
  classification: DataClassification;
  risk: TaskRisk;
  verifyCommand: string;
  /** Seed strings for the token estimate when no explicit estimate is supplied. */
  tokenSeedParts: readonly (string | undefined)[];
  estimatedInputTokens?: number;
  maxOutputTokens?: number;
  maximumLatencyMs?: number;
  budgetUsd?: number;
}>;

/** Build the shared router task spec from resolved per-product values. */
export function buildRoutingTaskSpec(input: RoutingTaskSpecInput): RouterTaskSpec {
  return {
    taskId: input.taskId,
    tenantId: input.tenantId,
    kind: input.kind,
    goal: input.goal,
    idempotencyKey: input.idempotencyKey,
    inputArtifactIds: [...input.inputArtifactIds],
    requiredCapabilities: [...input.requiredCapabilities],
    allowedTools: [...ROUTING_REQUIRED_TOOLS],
    context: {
      estimatedInputTokens:
        input.estimatedInputTokens ?? estimateSeedInputTokens(input.tokenSeedParts),
      maximumOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    },
    verification: {
      requiredChecks: [input.verifyCommand],
      requireAll: true,
      onFailure: "human_handoff",
    },
    fallbackPolicy: {
      enabled: true,
      maxAttempts: 3,
      sameExecutorRetries: 1,
      retryableFailures: ["timeout", "rate_limited", "provider_unavailable"],
      fallbackFailures: ["provider_unavailable", "executor_unavailable"],
    },
    privacy: { classification: input.classification },
    risk: input.risk,
    quality: { minimumScore: riskQualityFloor(input.risk) },
    latency: { maximumMs: input.maximumLatencyMs ?? DEFAULT_MAX_LATENCY_MS },
    budget: { maximumUsd: input.budgetUsd ?? DEFAULT_BUDGET_USD },
  };
}

/** Per-product policy inputs; the shared structure and constants are supplied here. */
export type RoutingPolicySnapshotInput = Readonly<{
  /**
   * The declared maximum data classification this envelope authorizes. Absent
   * (undefined) yields the narrowest safe set (`["public"]`) — absence must not
   * widen.
   */
  maximumDataClassification: DataClassification | undefined;
  externalProcessingAllowed: boolean;
  allowedExecutionRegions: readonly string[];
  maximumLatencyMs?: number;
  budgetUsd?: number;
  decidedAt?: Date;
}>;

/** Build the shared router policy snapshot from resolved per-product values. */
export function buildRoutingPolicySnapshot(
  input: RoutingPolicySnapshotInput,
): RouterPolicySnapshot {
  const body: Omit<RouterPolicySnapshot, "snapshotId" | "capturedAt"> = {
    version: 1,
    privacy: {
      allowedClassifications: allowedClassificationsForCeiling(
        input.maximumDataClassification,
      ),
      externalProcessingAllowed: input.externalProcessingAllowed,
    },
    region: { allowedExecutionRegions: [...input.allowedExecutionRegions] },
    risk: { maximumAutonomousRisk: "medium", humanReviewAtOrAbove: "high" },
    // Baseline policy quality floor (§13.4). The effective minimum is the max of
    // this and the risk-adjusted task floor, so no executor below the baseline is
    // ever eligible and the `quality_below_minimum` gate can fire.
    quality: { minimumScore: 0.6 },
    latency: { maximumMs: input.maximumLatencyMs ?? DEFAULT_MAX_LATENCY_MS },
    budget: { maximumUsd: input.budgetUsd ?? DEFAULT_BUDGET_USD },
  };
  return {
    snapshotId: digest(body),
    ...body,
    capturedAt: (input.decidedAt ?? new Date()).toISOString(),
  };
}
