import { readFile } from "node:fs/promises";
import { assessFeedFreshness, resolveRenamedEnv } from "@mendpoint/shared";

type TransformerHeartbeat = {
  enabled?: boolean;
  active?: boolean;
  lastRunAt?: string;
  lastSuccessAt?: string;
  infrastructureError?: string;
  expired?: number;
  attempted?: number;
  completed?: number;
  failed?: number;
  stale?: number;
  idle?: number;
  errors?: readonly string[];
};

type WorkerHeartbeat = {
  ok?: boolean;
  recordedAt?: string;
  feedPollingEnabled?: boolean;
  feedPollOk?: boolean;
  feedScheduleCount?: number;
  feedLastSuccessAt?: string;
  feedStaleAfterMs?: number;
  feedPollStartedAt?: string;
  releasePollingConfigured?: boolean;
  releasePollConfigurationCount?: number;
  feedScheduleStatus?: string;
  releaseConfigurationStatus?: string;
  releaseConfigurationFailed?: number;
  releaseDispatchConfigured?: boolean | null;
  releaseDispatchConsumerCount?: number | null;
  releaseDispatchStatus?: string;
  releaseDispatchPending?: number | null;
  releaseDispatchClaimed?: number | null;
  releaseDispatchFailed?: number | null;
  releaseDispatchDue?: number | null;
  releaseDispatchExpiredClaims?: number | null;
  releaseDispatchFailureStage?: string | null;
  releaseDispatchFailureCode?: string | null;
  activeJob?: { id?: string; type?: string; leaseGeneration?: number } | null;
  recovery?: {
    due?: number;
    scheduled?: number;
    running?: number;
    deadLetter?: number;
    expiredLeases?: number;
  };
  transformer?: TransformerHeartbeat;
};

type FeedScheduleStatus = "not_started" | "healthy" | "degraded";
type ReleaseConfigurationStatus = "not_started" | "not_configured" | "healthy" | "degraded";
type ReleaseDispatchStatus = ReleaseConfigurationStatus | "unknown";
type ReleaseDispatchFailureStage =
  | "configuration" | "claim" | "artifact_rehydration" | "event_append"
  | "settlement" | "backlog" | "fence" | "runtime";

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function feedScheduleStatus(value: unknown): FeedScheduleStatus | null {
  return value === "not_started" || value === "healthy" || value === "degraded"
    ? value
    : null;
}

function releaseConfigurationStatus(value: unknown): ReleaseConfigurationStatus | null {
  return value === "not_started" || value === "not_configured" ||
      value === "healthy" || value === "degraded"
    ? value
    : null;
}

function releaseDispatchStatus(value: unknown): ReleaseDispatchStatus | null {
  return value === "unknown" ? value : releaseConfigurationStatus(value);
}

function safeCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function releaseDispatchFailureStage(value: unknown): ReleaseDispatchFailureStage | null {
  return typeof value === "string" && [
    "configuration", "claim", "artifact_rehydration", "event_append",
    "settlement", "backlog", "fence", "runtime",
  ].includes(value) ? value as ReleaseDispatchFailureStage : null;
}

function releaseDispatchFailureCode(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : null;
}

function apiBase(): string {
  return (process.env.MENDPOINT_API_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
}

export async function apiCheck(path: string, authenticated = false): Promise<boolean> {
  const headers = new Headers({ Accept: "application/json" });
  if (authenticated) {
    const apiKey = process.env.MENDPOINT_API_KEY?.trim();
    if (!apiKey) return false;
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  const response = await fetch(`${apiBase()}${path}`, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  return response.ok;
}

export async function workerCheck(operational = true): Promise<{
  ok: boolean;
  ageMs?: number;
  feedPollingEnabled?: boolean;
  feedScheduleCount?: number;
  feedLastSuccessAt?: string;
  feedStaleAfterMs?: number;
  feedPollStartedAt?: string;
  releasePollingConfigured?: boolean;
  releasePollConfigurationCount?: number;
  feedScheduleStatus?: FeedScheduleStatus;
  releaseConfigurationStatus?: ReleaseConfigurationStatus;
  releaseConfigurationFailed?: number;
  releaseDispatchConfigured?: boolean | null;
  releaseDispatchConsumerCount?: number | null;
  releaseDispatchStatus?: ReleaseDispatchStatus;
  releaseDispatchPending?: number | null;
  releaseDispatchClaimed?: number | null;
  releaseDispatchFailed?: number | null;
  releaseDispatchDue?: number | null;
  releaseDispatchExpiredClaims?: number | null;
  releaseDispatchFailureStage?: ReleaseDispatchFailureStage | null;
  releaseDispatchFailureCode?: string | null;
  activeJob?: WorkerHeartbeat["activeJob"];
  recovery?: WorkerHeartbeat["recovery"];
  transformer?: TransformerHeartbeat & {
    ok: boolean;
    lastRunAgeMs?: number;
    lastSuccessAgeMs?: number;
  };
  reason?: string;
}> {
  const path = process.env.MENDPOINT_WORKER_HEARTBEAT_PATH?.trim();
  if (!path) return { ok: false, reason: "heartbeat_not_configured" };
  try {
    const heartbeat = JSON.parse(await readFile(path, "utf8")) as WorkerHeartbeat;
    const recordedAt = Date.parse(heartbeat.recordedAt ?? "");
    const ageMs = Date.now() - recordedAt;
    const maxAgeMs = Number(process.env.MENDPOINT_WORKER_HEARTBEAT_MAX_AGE_MS ?? 30_000);
    const live =
      heartbeat.ok === true &&
      Number.isFinite(recordedAt) &&
      ageMs >= 0 &&
      ageMs <= maxAgeMs;
    const transformer = heartbeat.transformer;
    const transformerMaxAgeMs = Number(
      resolveRenamedEnv(process.env, "MENDPOINT_REGAUGE_HEARTBEAT_MAX_AGE_MS") ?? 20 * 60_000,
    );
    const lastRunAt = Date.parse(transformer?.lastRunAt ?? "");
    const lastSuccessAt = Date.parse(transformer?.lastSuccessAt ?? "");
    const lastRunAgeMs = Date.now() - lastRunAt;
    const lastSuccessAgeMs = Date.now() - lastSuccessAt;
    const transformerAgeValid = Number.isFinite(transformerMaxAgeMs) &&
      transformerMaxAgeMs >= 1_000;
    const transformerOk = transformer?.enabled !== true || (
      !transformer.infrastructureError &&
      transformerAgeValid &&
      (transformer.active === true
        ? Number.isFinite(lastRunAt) && lastRunAgeMs >= 0 && lastRunAgeMs <= transformerMaxAgeMs
        : Number.isFinite(lastSuccessAt) && lastSuccessAgeMs >= 0 && lastSuccessAgeMs <= transformerMaxAgeMs)
    );
    const customerProfile = process.env.MENDPOINT_DEPLOYMENT_PROFILE === "customer";
    const feedScheduleCount = hasOwn(heartbeat, "feedScheduleCount")
      ? safeCount(heartbeat.feedScheduleCount)
      : 0;
    const releaseConfiguredPresent = hasOwn(heartbeat, "releasePollingConfigured");
    const releasePollingConfigured = releaseConfiguredPresent
      ? typeof heartbeat.releasePollingConfigured === "boolean"
        ? heartbeat.releasePollingConfigured
        : null
      : false;
    const releaseCountPresent = hasOwn(heartbeat, "releasePollConfigurationCount");
    const releasePollConfigurationCount = releaseCountPresent
      ? safeCount(heartbeat.releasePollConfigurationCount)
      : 0;
    const feedStatusPresent = hasOwn(heartbeat, "feedScheduleStatus");
    const currentFeedScheduleStatus = feedStatusPresent
      ? feedScheduleStatus(heartbeat.feedScheduleStatus)
      : "not_started";
    const releaseStatusPresent = hasOwn(heartbeat, "releaseConfigurationStatus");
    const currentReleaseConfigurationStatus = releaseStatusPresent
      ? releaseConfigurationStatus(heartbeat.releaseConfigurationStatus)
      : "not_configured";
    const releaseFailedPresent = hasOwn(heartbeat, "releaseConfigurationFailed");
    const releaseConfigurationFailed = releaseFailedPresent
      ? safeCount(heartbeat.releaseConfigurationFailed)
      : 0;
    const releaseFieldsValid = typeof releasePollingConfigured === "boolean" &&
      feedScheduleCount !== null &&
      releasePollConfigurationCount !== null &&
      currentFeedScheduleStatus !== null &&
      currentReleaseConfigurationStatus !== null &&
      releaseConfigurationFailed !== null;
    const releasePollingHealthy = releaseFieldsValid && releasePollingConfigured
      ? releasePollConfigurationCount > 0 &&
        currentFeedScheduleStatus === "healthy" &&
        currentReleaseConfigurationStatus === "healthy" &&
        releaseConfigurationFailed === 0
      : releaseFieldsValid && releasePollConfigurationCount === 0 &&
        currentReleaseConfigurationStatus === "not_configured" &&
        releaseConfigurationFailed === 0;
    const releaseDispatchFieldPresence = [
      "releaseDispatchConfigured",
      "releaseDispatchConsumerCount",
      "releaseDispatchStatus",
      "releaseDispatchPending",
      "releaseDispatchClaimed",
      "releaseDispatchFailed",
      "releaseDispatchDue",
      "releaseDispatchExpiredClaims",
      "releaseDispatchFailureStage",
      "releaseDispatchFailureCode",
    ].map((field) => hasOwn(heartbeat, field));
    const releaseDispatchAnyFieldPresent = releaseDispatchFieldPresence.some(Boolean);
    const releaseDispatchAllFieldsPresent = releaseDispatchFieldPresence.every(Boolean);
    const dispatchConfiguredPresent = hasOwn(heartbeat, "releaseDispatchConfigured");
    const releaseDispatchConfigured = dispatchConfiguredPresent
      ? typeof heartbeat.releaseDispatchConfigured === "boolean"
        ? heartbeat.releaseDispatchConfigured
        : null
      : releaseDispatchAnyFieldPresent ? null : false;
    const releaseDispatchConsumerCount = hasOwn(heartbeat, "releaseDispatchConsumerCount")
      ? safeCount(heartbeat.releaseDispatchConsumerCount)
      : releaseDispatchAnyFieldPresent ? null : 0;
    const currentReleaseDispatchStatus = hasOwn(heartbeat, "releaseDispatchStatus")
      ? releaseDispatchStatus(heartbeat.releaseDispatchStatus)
      : releaseDispatchAnyFieldPresent ? null : "not_configured";
    const releaseDispatchPending = hasOwn(heartbeat, "releaseDispatchPending")
      ? safeCount(heartbeat.releaseDispatchPending)
      : releaseDispatchAnyFieldPresent ? null : 0;
    const releaseDispatchClaimed = hasOwn(heartbeat, "releaseDispatchClaimed")
      ? safeCount(heartbeat.releaseDispatchClaimed)
      : releaseDispatchAnyFieldPresent ? null : 0;
    const releaseDispatchFailed = hasOwn(heartbeat, "releaseDispatchFailed")
      ? safeCount(heartbeat.releaseDispatchFailed)
      : releaseDispatchAnyFieldPresent ? null : 0;
    const releaseDispatchDue = hasOwn(heartbeat, "releaseDispatchDue")
      ? safeCount(heartbeat.releaseDispatchDue)
      : releaseDispatchAnyFieldPresent ? null : 0;
    const releaseDispatchExpiredClaims = hasOwn(heartbeat, "releaseDispatchExpiredClaims")
      ? safeCount(heartbeat.releaseDispatchExpiredClaims)
      : releaseDispatchAnyFieldPresent ? null : 0;
    const currentReleaseDispatchFailureStage = hasOwn(heartbeat, "releaseDispatchFailureStage")
      ? heartbeat.releaseDispatchFailureStage === null
        ? null
        : releaseDispatchFailureStage(heartbeat.releaseDispatchFailureStage)
      : releaseDispatchAnyFieldPresent ? undefined : null;
    const currentReleaseDispatchFailureCode = hasOwn(heartbeat, "releaseDispatchFailureCode")
      ? heartbeat.releaseDispatchFailureCode === null
        ? null
        : releaseDispatchFailureCode(heartbeat.releaseDispatchFailureCode)
      : releaseDispatchAnyFieldPresent ? undefined : null;
    const releaseDispatchFailureValid =
      currentReleaseDispatchFailureStage !== undefined &&
      currentReleaseDispatchFailureCode !== undefined &&
      ((currentReleaseDispatchFailureStage === null) === (currentReleaseDispatchFailureCode === null)) &&
      (currentReleaseDispatchStatus === "degraded" || currentReleaseDispatchStatus === "unknown"
        ? currentReleaseDispatchFailureStage !== null
        : currentReleaseDispatchFailureStage === null);
    const releaseDispatchFieldsValid =
      (!releaseDispatchAnyFieldPresent || releaseDispatchAllFieldsPresent) &&
      typeof releaseDispatchConfigured === "boolean" &&
      releaseDispatchConsumerCount !== null &&
      currentReleaseDispatchStatus !== null &&
      releaseDispatchPending !== null &&
      releaseDispatchClaimed !== null &&
      releaseDispatchFailed !== null &&
      releaseDispatchDue !== null &&
      releaseDispatchExpiredClaims !== null;
    const releaseDispatchRequiredButMissing =
      releasePollingConfigured === true && !releaseDispatchAnyFieldPresent;
    const releaseDispatchContractValid = releaseDispatchFieldsValid &&
      releaseDispatchFailureValid && !releaseDispatchRequiredButMissing;
    const releaseDispatchHealthy = releaseDispatchContractValid && releaseDispatchConfigured
      ? releaseDispatchConsumerCount > 0 &&
        currentReleaseDispatchStatus === "healthy" &&
        releaseDispatchFailed === 0 &&
        releaseDispatchDue === 0 &&
        releaseDispatchExpiredClaims === 0
      : releaseDispatchContractValid &&
        releaseDispatchConsumerCount === 0 &&
        currentReleaseDispatchStatus === "not_configured" &&
        releaseDispatchPending === 0 &&
        releaseDispatchClaimed === 0 &&
        releaseDispatchFailed === 0 &&
        releaseDispatchDue === 0 &&
        releaseDispatchExpiredClaims === 0;
    const releaseDispatchUnknown = releaseDispatchRequiredButMissing ||
      releaseDispatchAnyFieldPresent && !releaseDispatchContractValid;
    const feedLastSuccessAt = Date.parse(heartbeat.feedLastSuccessAt ?? "");
    const feedFreshness = assessFeedFreshness({
      lastSuccessAt: heartbeat.feedLastSuccessAt,
      staleAfterMs: heartbeat.feedStaleAfterMs,
      pollStartedAt: heartbeat.feedPollStartedAt,
    });
    const customerFeedObserved =
      heartbeat.feedPollingEnabled === true &&
      feedScheduleCount !== null && feedScheduleCount > 0 &&
      Number.isFinite(feedLastSuccessAt) &&
      feedFreshness.ok;
    const requiredFeedAvailable = !customerProfile || customerFeedObserved;
    const ok =
      live &&
      (!operational ||
        (heartbeat.feedPollOk === true &&
          releasePollingHealthy &&
          releaseDispatchHealthy &&
          requiredFeedAvailable &&
          (heartbeat.recovery?.expiredLeases ?? 0) === 0 &&
          (heartbeat.recovery?.deadLetter ?? 0) === 0 &&
          transformerOk));
    return {
      ok,
      ageMs,
      feedPollingEnabled: heartbeat.feedPollingEnabled === true,
      feedScheduleCount: feedScheduleCount ?? 0,
      ...(Number.isFinite(feedLastSuccessAt)
        ? { feedLastSuccessAt: heartbeat.feedLastSuccessAt }
        : {}),
      ...(heartbeat.feedStaleAfterMs !== undefined
        ? { feedStaleAfterMs: heartbeat.feedStaleAfterMs }
        : {}),
      ...(heartbeat.feedPollStartedAt
        ? { feedPollStartedAt: heartbeat.feedPollStartedAt }
        : {}),
      releasePollingConfigured: releasePollingConfigured === true,
      releasePollConfigurationCount: releasePollConfigurationCount ?? 0,
      feedScheduleStatus: currentFeedScheduleStatus ?? "not_started",
      releaseConfigurationStatus: currentReleaseConfigurationStatus ?? "not_configured",
      releaseConfigurationFailed: releaseConfigurationFailed ?? 0,
      releaseDispatchConfigured: releaseDispatchUnknown ? null : releaseDispatchConfigured,
      releaseDispatchConsumerCount: releaseDispatchUnknown ? null : releaseDispatchConsumerCount,
      releaseDispatchStatus: releaseDispatchUnknown
        ? "unknown"
        : currentReleaseDispatchStatus ??
          (releaseDispatchAnyFieldPresent ? "unknown" : "not_configured"),
      releaseDispatchPending: releaseDispatchUnknown ? null : releaseDispatchPending,
      releaseDispatchClaimed: releaseDispatchUnknown ? null : releaseDispatchClaimed,
      releaseDispatchFailed: releaseDispatchUnknown ? null : releaseDispatchFailed,
      releaseDispatchDue: releaseDispatchUnknown ? null : releaseDispatchDue,
      releaseDispatchExpiredClaims: releaseDispatchUnknown ? null : releaseDispatchExpiredClaims,
      releaseDispatchFailureStage: releaseDispatchUnknown ? null : currentReleaseDispatchFailureStage,
      releaseDispatchFailureCode: releaseDispatchUnknown ? null : currentReleaseDispatchFailureCode,
      activeJob: heartbeat.activeJob ?? null,
      recovery: heartbeat.recovery,
      transformer: transformer ? {
        ...transformer,
        ok: transformerOk,
        ...(Number.isFinite(lastRunAt) ? { lastRunAgeMs } : {}),
        ...(Number.isFinite(lastSuccessAt) ? { lastSuccessAgeMs } : {}),
      } : undefined,
      reason: ok
        ? undefined
        : customerProfile && heartbeat.feedPollingEnabled !== true
          ? "customer_feed_polling_disabled"
          : customerProfile && (
              feedScheduleCount === null || feedScheduleCount < 1 || !Number.isFinite(feedLastSuccessAt)
            )
            ? "customer_feed_not_observed"
          : customerProfile && !feedFreshness.ok
            ? "customer_feed_not_fresh"
          : "heartbeat_stale_or_unhealthy",
    };
  } catch {
    return { ok: false, reason: "heartbeat_unavailable" };
  }
}
