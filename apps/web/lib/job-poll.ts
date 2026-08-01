export type PolledJob = {
  id: string;
  status: string;
  errorCode?: string | null;
};

const TERMINAL = new Set(["done", "dead_letter", "failed", "cancelled"]);

export async function waitForJob(
  apiUrl: string,
  jobId: string,
  options: {
    attempts?: number;
    intervalMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<PolledJob | null> {
  const attempts = Math.max(1, Math.min(options.attempts ?? 30, 60));
  const intervalMs = Math.max(250, Math.min(options.intervalMs ?? 1_000, 5_000));
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)));

  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = await fetchImpl(`${apiUrl}/jobs/${encodeURIComponent(jobId)}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Job status request failed: ${response.status}`);
    const job = (await response.json()) as PolledJob;
    if (job && TERMINAL.has(job.status)) return job;
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  return null;
}
