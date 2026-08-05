import { readFile } from "node:fs/promises";

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
      process.env.MENDPOINT_TRANSFORMER_HEARTBEAT_MAX_AGE_MS ?? 20 * 60_000,
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
    const ok =
      live &&
      (!operational ||
        (heartbeat.feedPollOk === true &&
          (heartbeat.recovery?.expiredLeases ?? 0) === 0 &&
          (heartbeat.recovery?.deadLetter ?? 0) === 0 &&
          transformerOk));
    return {
      ok,
      ageMs,
      feedPollingEnabled: heartbeat.feedPollingEnabled === true,
      activeJob: heartbeat.activeJob ?? null,
      recovery: heartbeat.recovery,
      transformer: transformer ? {
        ...transformer,
        ok: transformerOk,
        ...(Number.isFinite(lastRunAt) ? { lastRunAgeMs } : {}),
        ...(Number.isFinite(lastSuccessAt) ? { lastSuccessAgeMs } : {}),
      } : undefined,
      reason: ok ? undefined : "heartbeat_stale_or_unhealthy",
    };
  } catch {
    return { ok: false, reason: "heartbeat_unavailable" };
  }
}
