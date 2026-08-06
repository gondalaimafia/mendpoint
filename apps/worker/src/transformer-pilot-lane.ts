import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { AppDb } from "@mendpoint/db";
import {
  runTransformerAttempt,
  type RecipeCommandRunner,
  type TransformerAttemptCoordinatorPort,
  type TransformerPilotExecutionStore,
} from "@mendpoint/transformer";
import { authorizeTransformerWorkerAction } from "@mendpoint/ops";
import { loadTransformerRecipeSnapshot } from "./transformer-snapshot-loader.js";
import {
  buildRoutedExecutorRegistry,
  runRoutedTransformerAttempt,
  transformerRoutingRequest,
} from "./transformer-router.js";

export type TransformerPilotLaneResult = Readonly<{
  enabled: boolean;
  expired: number;
  attempted: number;
  completed: number;
  failed: number;
  stale: number;
  idle: number;
  handoff?: number;
  errors: readonly string[];
  infrastructureError?: string;
}>;

export type TransformerPilotLaneStore = Pick<
  TransformerPilotExecutionStore,
  | "listExpiredAttempts"
  | "expireAttempt"
  | "listRunnableCampaigns"
  | "claimNextAttempt"
  | "assertCurrentAttemptFence"
  | "completeAttempt"
  | "recordAttemptFailure"
>;

export type RunTransformerPilotLaneInput = Readonly<{
  db: AppDb;
  store: TransformerPilotLaneStore;
  gateConfig?: string;
  tenantId?: string;
  workerId: string;
  evidenceRoot: string;
  candidateRoot: string;
  tempRoot?: string;
  leaseDurationMs?: number;
  maxCampaigns?: number;
  now?: () => string;
  runId?: string;
  leaseToken?: () => string;
  commandRunner?: RecipeCommandRunner;
  shouldContinue?: () => boolean;
}>;

const ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._,:-]{0,499}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function boundedError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/database is locked|SQLITE_BUSY/i.test(raw)) {
    return "transformer_lane_database_locked";
  }
  return ERROR_CODE.test(raw) ? raw : "transformer_lane_internal_error";
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${sha256(parts.join("\0"))}`;
}

function empty(enabled: boolean): TransformerPilotLaneResult {
  return Object.freeze({
    enabled,
    expired: 0,
    attempted: 0,
    completed: 0,
    failed: 0,
    stale: 0,
    idle: 0,
    errors: Object.freeze([]),
  });
}

function requireLimit(value: number | undefined): number {
  const limit = value ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("transformer_lane_campaign_limit_invalid");
  }
  return limit;
}

function requireLeaseDuration(value: number | undefined): number {
  const duration = value ?? 15 * 60_000;
  if (!Number.isSafeInteger(duration) || duration < 1_000 || duration > 3_600_000) {
    throw new Error("transformer_lane_lease_duration_invalid");
  }
  return duration;
}

function asCoordinator(store: TransformerPilotLaneStore): TransformerAttemptCoordinatorPort {
  return {
    claimNextAttempt: (input) => store.claimNextAttempt(input),
    assertCurrentAttemptFence: (input) => store.assertCurrentAttemptFence(input),
    completeAttempt: (input) => store.completeAttempt(input),
    recordAttemptFailure: (input) => store.recordAttemptFailure(input),
  };
}

export async function runTransformerPilotLaneOnce(
  input: RunTransformerPilotLaneInput,
): Promise<TransformerPilotLaneResult> {
  const rawGate = input.gateConfig?.trim();
  if (!rawGate) return empty(false);
  const now = input.now ?? (() => new Date().toISOString());
  const runId = input.runId ?? randomUUID();
  const maxCampaigns = requireLimit(input.maxCampaigns);
  const leaseDurationMs = requireLeaseDuration(input.leaseDurationMs);
  const createLeaseToken = input.leaseToken ?? (() => randomBytes(32).toString("hex"));
  const errors: string[] = [];
  let expired = 0;
  let attempted = 0;
  let completed = 0;
  let failed = 0;
  let stale = 0;
  let idle = 0;
  let handoff = 0;
  let infrastructureError: string | undefined;

  const sweepObservedAt = now();
  for (const attempt of input.store.listExpiredAttempts(
    sweepObservedAt,
    input.tenantId,
    maxCampaigns,
    rawGate,
  )) {
    if (input.shouldContinue?.() === false) break;
    const decision = authorizeTransformerWorkerAction(
      { tenantId: attempt.tenantId, environment: attempt.environment },
      rawGate,
    );
    if (!decision.allowed) {
      errors.push(`transformer_lane_expiry_denied:${attempt.campaignId}`);
      continue;
    }
    try {
      input.store.expireAttempt({
        tenantId: attempt.tenantId,
        campaignId: attempt.campaignId,
        unitId: attempt.unitId,
        leaseGeneration: attempt.leaseGeneration,
        observedAt: sweepObservedAt,
        evidenceRefs: Object.freeze([
          ...decision.acceptanceEvidenceRefs,
          stableId(
            "tfexpired",
            attempt.tenantId,
            attempt.campaignId,
            attempt.unitId,
            String(attempt.leaseGeneration),
          ),
        ]),
        idempotencyKey: stableId(
          "tfexpire",
          attempt.tenantId,
          attempt.campaignId,
          attempt.unitId,
          String(attempt.leaseGeneration),
        ),
        gateConfig: rawGate,
      });
      expired++;
    } catch (error) {
      const code = boundedError(error);
      if (!code.includes("not_running") && !code.includes("fence_stale")) {
        errors.push(code);
        infrastructureError ??= code;
      }
    }
  }

  const coordinator = asCoordinator(input.store);
  // The shared policy router is the dispatcher for every runnable campaign: it
  // decides (execute vs mandatory human handoff), selects the Transformer
  // executor over Warden under the existing filters and breakers, and persists
  // the decision + outcome to the durable routing ledger. The claim, snapshot,
  // lease, and authorization guarantees below are unchanged; the attempt runs
  // through the router's executor port instead of being invoked directly.
  const routedRegistry = buildRoutedExecutorRegistry(now());
  for (const campaign of input.store.listRunnableCampaigns(
    input.tenantId,
    maxCampaigns,
    rawGate,
  )) {
    if (input.shouldContinue?.() === false) break;
    const decision = authorizeTransformerWorkerAction(
      { tenantId: campaign.tenantId, environment: campaign.environment },
      rawGate,
    );
    if (!decision.allowed) {
      errors.push(`transformer_lane_campaign_denied:${campaign.campaignId}`);
      continue;
    }
    const claimKey = stableId(
      "tfclaim",
      input.workerId,
      runId,
      campaign.tenantId,
      campaign.campaignId,
    );
    const routed = await runRoutedTransformerAttempt({
      db: input.db,
      registry: routedRegistry,
      tenantId: campaign.tenantId,
      jobId: campaign.campaignId,
      runId,
      sessionId: runId,
      goal: `Transformer recipe migration for ${campaign.campaignId}`,
      routingRequest: transformerRoutingRequest({
        taskId: campaign.campaignId,
        tenantId: campaign.tenantId,
        campaignId: campaign.campaignId,
        idempotencyKey: claimKey,
        policySnapshotId: stableId(
          "tfpolicy",
          campaign.tenantId,
          campaign.campaignId,
        ),
        decidedAt: new Date(now()),
      }),
      outcomeIdempotencyKey: stableId(
        "tfroute",
        campaign.tenantId,
        campaign.campaignId,
        runId,
      ),
      runAttempt: () =>
        runTransformerAttempt({
          scope: campaign,
          gateConfig: rawGate,
          coordinator,
          loadExactSource: (lease) => loadTransformerRecipeSnapshot(input.db, lease, now()),
          evidenceRoot: resolve(input.evidenceRoot),
          candidateRoot: resolve(input.candidateRoot),
          ...(input.tempRoot ? { tempRoot: resolve(input.tempRoot) } : {}),
          leaseDurationMs,
          observedAt: () => now(),
          idempotencyKey: (phase, attemptId) =>
            phase === "claim"
              ? claimKey
              : stableId(
                  `tf${phase}`,
                  campaign.tenantId,
                  campaign.campaignId,
                  attemptId ?? "unbound",
                ),
          leaseToken: createLeaseToken,
          ...(input.commandRunner ? { commandRunner: input.commandRunner } : {}),
          actualCostUsd: 0,
        }),
    });
    if (routed.status === "handoff") {
      handoff++;
      errors.push(`transformer_routing_human_handoff:${campaign.campaignId}`);
      continue;
    }
    if (routed.status !== "idle") attempted++;
    if (routed.status === "completed") completed++;
    else if (routed.status === "failed") {
      failed++;
      if (routed.errorCode) errors.push(routed.errorCode);
    } else if (routed.status === "stale") stale++;
    else idle++;
  }

  return Object.freeze({
    enabled: true,
    expired,
    attempted,
    completed,
    failed,
    stale,
    idle,
    ...(handoff ? { handoff } : {}),
    errors: Object.freeze([...new Set(errors)].slice(0, 25)),
    ...(infrastructureError ? { infrastructureError } : {}),
  });
}

export function transformerPilotWorkerPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const override = env.MENDPOINT_TRANSFORMER_PILOT_DB?.trim();
  if (override) return resolve(override);
  const dataRoot = env.MENDPOINT_DATA_DIR?.trim();
  return join(dataRoot ? resolve(dataRoot) : join(cwd, "data"), "transformer-pilot.sqlite");
}
