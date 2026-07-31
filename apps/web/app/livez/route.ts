import { apiCheck, workerCheck } from "../../lib/health-checks";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const checks = {
    api: false,
    worker: await workerCheck(false),
  };
  try {
    checks.api = await apiCheck("/live");
  } catch {
    // The structured response below is the process recovery signal.
  }
  const ok = checks.api && checks.worker.ok;
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
