export type GitHubSleep = (milliseconds: number) => Promise<void>;

const MAX_RETRIES = 2;
const MAX_TOTAL_WAIT_MS = 180_000;

export const defaultGitHubSleep: GitHubSleep = async (milliseconds) => {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
};

function retryAfterMilliseconds(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function responseRetryDelay(
  response: Response,
  retryIndex: number,
  now: number,
): number | null {
  const retryAfter = retryAfterMilliseconds(response.headers.get("retry-after"), now);
  if (retryAfter !== null) return retryAfter;

  if (response.headers.get("x-ratelimit-remaining") === "0") {
    const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
      return Math.max(1_000, resetSeconds * 1_000 - now + 1_000);
    }
  }

  if (response.status === 403 || response.status === 429) {
    return 60_000 * 2 ** retryIndex;
  }
  if ([502, 503, 504].includes(response.status)) {
    return 1_000 * 2 ** retryIndex;
  }
  return null;
}

export async function fetchGitHubReadWithRetry(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  sleepImpl: GitHubSleep = defaultGitHubSleep,
  now: () => number = Date.now,
): Promise<Response> {
  let totalWait = 0;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      if (attempt === MAX_RETRIES) {
        throw new Error("GitHub API read failed before receiving an HTTP response");
      }
      const delay = 1_000 * 2 ** attempt;
      if (totalWait + delay > MAX_TOTAL_WAIT_MS) {
        throw new Error("GitHub API read retry budget was exhausted");
      }
      totalWait += delay;
      await sleepImpl(delay);
      continue;
    }
    if (response.ok || attempt === MAX_RETRIES) return response;
    const delay = responseRetryDelay(response, attempt, now());
    if (delay === null || totalWait + delay > MAX_TOTAL_WAIT_MS) return response;
    await response.body?.cancel();
    totalWait += delay;
    await sleepImpl(delay);
  }
  throw new Error("GitHub API read retry budget was exhausted");
}
