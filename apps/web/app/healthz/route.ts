import { apiCheck, workerCheck } from "../../lib/health-checks";

export const dynamic = "force-dynamic";

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
