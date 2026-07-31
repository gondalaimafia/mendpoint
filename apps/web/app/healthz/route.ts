import { readFile } from "node:fs/promises";

export const dynamic = "force-dynamic";

type WorkerHeartbeat = {
  ok?: boolean;
  recordedAt?: string;
  feedPollingEnabled?: boolean;
  feedPollOk?: boolean;
  jobs?: { failed?: number };
};

function apiBase(): string {
  return (process.env.MENDPOINT_API_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
}

async function apiCheck(path: string, authenticated = false): Promise<boolean> {
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

async function workerCheck(): Promise<{
  ok: boolean;
  ageMs?: number;
  feedPollingEnabled?: boolean;
  reason?: string;
}> {
  const path = process.env.MENDPOINT_WORKER_HEARTBEAT_PATH?.trim();
  if (!path) return { ok: false, reason: "heartbeat_not_configured" };
  try {
    const heartbeat = JSON.parse(await readFile(path, "utf8")) as WorkerHeartbeat;
    const recordedAt = Date.parse(heartbeat.recordedAt ?? "");
    const ageMs = Date.now() - recordedAt;
    const maxAgeMs = Number(process.env.MENDPOINT_WORKER_HEARTBEAT_MAX_AGE_MS ?? 30_000);
    const ok =
      heartbeat.ok === true &&
      heartbeat.feedPollOk === true &&
      heartbeat.jobs?.failed === 0 &&
      Number.isFinite(recordedAt) &&
      ageMs >= 0 &&
      ageMs <= maxAgeMs;
    return {
      ok,
      ageMs,
      feedPollingEnabled: heartbeat.feedPollingEnabled === true,
      reason: ok ? undefined : "heartbeat_stale_or_unhealthy",
    };
  } catch {
    return { ok: false, reason: "heartbeat_unavailable" };
  }
}

export async function GET(): Promise<Response> {
  const checks = {
    apiReady: false,
    apiAuthenticated: false,
    worker: await workerCheck(),
  };
  try {
    checks.apiReady = await apiCheck("/ready");
    checks.apiAuthenticated = await apiCheck("/keys", true);
  } catch {
    // The structured response below is the operational signal.
  }
  const ok = checks.apiReady && checks.apiAuthenticated && checks.worker.ok;
  return Response.json(
    {
      ok,
      service: "mendpoint",
      checks,
      checkedAt: new Date().toISOString(),
    },
    {
      status: ok ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
