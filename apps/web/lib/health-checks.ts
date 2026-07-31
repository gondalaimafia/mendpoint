import { readFile } from "node:fs/promises";

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
    const ok =
      live &&
      (!operational ||
        (heartbeat.feedPollOk === true &&
          (heartbeat.recovery?.expiredLeases ?? 0) === 0 &&
          (heartbeat.recovery?.deadLetter ?? 0) === 0));
    return {
      ok,
      ageMs,
      feedPollingEnabled: heartbeat.feedPollingEnabled === true,
      activeJob: heartbeat.activeJob ?? null,
      recovery: heartbeat.recovery,
      reason: ok ? undefined : "heartbeat_stale_or_unhealthy",
    };
  } catch {
    return { ok: false, reason: "heartbeat_unavailable" };
  }
}
