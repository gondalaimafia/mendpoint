import {
  claimReleaseDispatch,
  completeReleaseDispatch,
  failReleaseDispatch,
  rehydrateReleaseArtifact,
  type ReleaseDispatch,
  type ReleaseIngestionStore,
} from "@mendpoint/catalog";
import type { AppDb } from "@mendpoint/db";
import {
  RELEASE_DISPATCH_CONTRACT_VERSION,
  RELEASE_DISPATCH_SINK_FAILURE_CODES,
  acceptReleaseDispatchDomainEvent,
  ensureReleaseDispatchPrincipal,
  type ReleaseDispatchSinkError,
} from "./release-dispatch-domain-event-sink.js";

export const RELEASE_DISPATCH_CONSUMER_CONFIGURATIONS_ENV =
  "MENDPOINT_RELEASE_DISPATCH_CONSUMERS_JSON" as const;

const MAX_CONSUMERS = 500;
const MAX_CLAIMS_PER_CONSUMER = 1_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CONSUMER_KEYS = Object.freeze(["actorPrincipalId", "contractVersion", "tenantId"] as const);

export type ReleaseDispatchConsumer = Readonly<{
  contractVersion: typeof RELEASE_DISPATCH_CONTRACT_VERSION;
  tenantId: string;
  actorPrincipalId: string;
}>;

export type ReleaseDispatchDrainSummary = Readonly<{
  configured: number;
  configurationFailed: number;
  claimed: number;
  completed: number;
  failed: number;
  retried: number;
  exhausted: number;
}>;

type ReleaseDispatchSink = typeof acceptReleaseDispatchDomainEvent;

function configurationError(): never {
  throw new Error("release_dispatch_consumers_invalid");
}

function requireIdentifier(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) configurationError();
  return value;
}

export function parseReleaseDispatchConsumersFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): readonly ReleaseDispatchConsumer[] {
  const raw = env[RELEASE_DISPATCH_CONSUMER_CONFIGURATIONS_ENV];
  if (raw === undefined) return Object.freeze([]);
  if (raw.trim().length === 0) configurationError();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    configurationError();
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONSUMERS) {
    configurationError();
  }
  const tenants = new Set<string>();
  const consumers = value.map((entry): ReleaseDispatchConsumer => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) configurationError();
    const record = entry as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== CONSUMER_KEYS.length || keys.some((key, index) => key !== CONSUMER_KEYS[index])) {
      configurationError();
    }
    if (record.contractVersion !== RELEASE_DISPATCH_CONTRACT_VERSION) configurationError();
    const tenantId = requireIdentifier(record.tenantId);
    if (tenants.has(tenantId)) configurationError();
    tenants.add(tenantId);
    return Object.freeze({
      contractVersion: RELEASE_DISPATCH_CONTRACT_VERSION,
      tenantId,
      actorPrincipalId: requireIdentifier(record.actorPrincipalId),
    });
  });
  return Object.freeze(consumers);
}

function nowIso(now: () => string): string {
  const value = now();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error("release_dispatch_clock_invalid");
  }
  return value;
}

function classifyFailure(error: unknown): Readonly<{
  code: string;
  retryable: boolean;
}> {
  const sinkFailure = error as Partial<ReleaseDispatchSinkError>;
  if (
    typeof sinkFailure.code === "string" &&
    Object.values(RELEASE_DISPATCH_SINK_FAILURE_CODES).includes(
      sinkFailure.code as typeof RELEASE_DISPATCH_SINK_FAILURE_CODES[keyof typeof RELEASE_DISPATCH_SINK_FAILURE_CODES],
    ) &&
    typeof sinkFailure.retryable === "boolean"
  ) {
    return Object.freeze({ code: sinkFailure.code, retryable: sinkFailure.retryable });
  }
  if (error instanceof Error && [
    "release_artifact_not_found",
    "release_artifact_digest_mismatch",
    "release_content_sha256_invalid",
    "release_artifact_id_required",
    "release_tenant_id_required",
  ].includes(error.message)) {
    return Object.freeze({
      code: RELEASE_DISPATCH_SINK_FAILURE_CODES.validationFailed,
      retryable: false,
    });
  }
  return Object.freeze({
    code: RELEASE_DISPATCH_SINK_FAILURE_CODES.internalFailure,
    retryable: false,
  });
}

function normalizeLeaseFailure(error: unknown): never {
  if (error instanceof Error && error.message === "release_dispatch_lease_lost") throw error;
  throw new Error("release_dispatch_settlement_unavailable");
}

function settleFailure(input: Readonly<{
  store: ReleaseIngestionStore;
  dispatch: ReleaseDispatch;
  workerId: string;
  code: string;
  retryable: boolean;
}>): "failed" | "retried" | "exhausted" {
  try {
    const settled = failReleaseDispatch(input.store, {
      tenantId: input.dispatch.tenantId,
      dispatchId: input.dispatch.id,
      workerId: input.workerId,
      leaseGeneration: input.dispatch.leaseGeneration,
      failureCode: input.code,
      retryable: input.retryable,
    });
    if (settled.status === "pending") return "retried";
    return input.retryable ? "exhausted" : "failed";
  } catch (error) {
    normalizeLeaseFailure(error);
  }
}

export function drainReleaseDispatchesOnce(input: Readonly<{
  store: ReleaseIngestionStore;
  db: AppDb;
  consumers: readonly ReleaseDispatchConsumer[];
  workerId: string;
  leaseDurationMs: number;
  maxClaimsPerConsumer: number;
  now?: () => string;
  sink?: ReleaseDispatchSink;
  shouldContinue?: () => boolean;
}>): ReleaseDispatchDrainSummary {
  const workerId = requireIdentifier(input.workerId);
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1 || input.leaseDurationMs > 86_400_000) {
    throw new Error("release_dispatch_lease_duration_invalid");
  }
  if (
    !Number.isSafeInteger(input.maxClaimsPerConsumer) || input.maxClaimsPerConsumer < 1 ||
    input.maxClaimsPerConsumer > MAX_CLAIMS_PER_CONSUMER
  ) {
    throw new Error("release_dispatch_claim_limit_invalid");
  }
  if (!Array.isArray(input.consumers) || input.consumers.length > MAX_CONSUMERS) configurationError();
  const now = input.now ?? (() => new Date().toISOString());
  const sink = input.sink ?? acceptReleaseDispatchDomainEvent;
  const shouldContinue = input.shouldContinue ?? (() => true);
  let configurationFailed = 0;
  let claimed = 0;
  let completed = 0;
  let failed = 0;
  let retried = 0;
  let exhausted = 0;

  consumerLoop: for (const consumer of input.consumers) {
    if (!shouldContinue()) break;
    const parsedConsumer = parseReleaseDispatchConsumersFromEnv({
      [RELEASE_DISPATCH_CONSUMER_CONFIGURATIONS_ENV]: JSON.stringify([consumer]),
    })[0]!;
    const configurationObservedAt = nowIso(now);
    try {
      ensureReleaseDispatchPrincipal({
        db: input.db,
        tenantId: parsedConsumer.tenantId,
        actorPrincipalId: parsedConsumer.actorPrincipalId,
        observedAt: configurationObservedAt,
      });
    } catch {
      configurationFailed += 1;
      continue;
    }

    for (let index = 0; index < input.maxClaimsPerConsumer; index += 1) {
      if (!shouldContinue()) break consumerLoop;
      let dispatch: ReleaseDispatch | null;
      try {
        dispatch = claimReleaseDispatch(input.store, {
          tenantId: parsedConsumer.tenantId,
          workerId,
          leaseDurationMs: input.leaseDurationMs,
        });
      } catch {
        throw new Error("release_dispatch_claim_unavailable");
      }
      if (!dispatch) break;
      if (dispatch.tenantId !== parsedConsumer.tenantId) {
        throw new Error("release_dispatch_claim_tenant_mismatch");
      }
      claimed += 1;
      try {
        const observedAt = nowIso(now);
        const artifact = rehydrateReleaseArtifact(input.store, {
          tenantId: dispatch.tenantId,
          artifactId: dispatch.artifactId,
          expectedContentSha256: dispatch.artifactContentSha256,
        });
        if (!shouldContinue()) break consumerLoop;
        sink({
          db: input.db,
          actorPrincipalId: parsedConsumer.actorPrincipalId,
          envelope: Object.freeze({
            contractVersion: RELEASE_DISPATCH_CONTRACT_VERSION,
            tenantId: dispatch.tenantId,
            dispatchId: dispatch.id,
            artifactId: artifact.id,
            artifactContentSha256: artifact.contentSha256,
          }),
          observedAt,
        });
      } catch (error) {
        if (!shouldContinue()) break consumerLoop;
        const classification = classifyFailure(error);
        const outcome = settleFailure({
          store: input.store,
          dispatch,
          workerId,
          code: classification.code,
          retryable: classification.retryable,
        });
        if (outcome === "failed") failed += 1;
        else if (outcome === "retried") retried += 1;
        else exhausted += 1;
        continue;
      }
      if (!shouldContinue()) break consumerLoop;
      try {
        completeReleaseDispatch(input.store, {
          tenantId: dispatch.tenantId,
          dispatchId: dispatch.id,
          workerId,
          leaseGeneration: dispatch.leaseGeneration,
        });
        completed += 1;
      } catch (error) {
        normalizeLeaseFailure(error);
      }
    }
  }

  return Object.freeze({
    configured: input.consumers.length,
    configurationFailed,
    claimed,
    completed,
    failed,
    retried,
    exhausted,
  });
}
