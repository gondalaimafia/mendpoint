const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 64 * 1_024 * 1_024;

export type BoundedHttpResult = Readonly<{
  response: Response;
  text: string;
}>;

export type BoundedHttpOptions = Readonly<{
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}>;

function integer(value: number, maximum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(code);
  }
  return value;
}

async function responseText(
  response: Response,
  maximumBytes: number,
  abort: Promise<never>,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("bounded_http_response_too_large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  const decode = (chunk?: Uint8Array, stream = false): string => {
    try {
      return decoder.decode(chunk, { stream });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error("bounded_http_response_encoding_invalid");
      }
      throw error;
    }
  };
  try {
    while (true) {
      const next = await Promise.race([reader.read(), abort]);
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("bounded_http_response_too_large");
      }
      text += decode(next.value, true);
    }
    return text + decode();
  } finally {
    reader.releaseLock();
  }
}

export async function fetchBoundedText(
  input: string | URL | Request,
  init: RequestInit,
  options: BoundedHttpOptions,
): Promise<BoundedHttpResult> {
  const timeoutMs = integer(
    options.timeoutMs,
    MAX_TIMEOUT_MS,
    "bounded_http_timeout_invalid",
  );
  const maxResponseBytes = integer(
    options.maxResponseBytes,
    MAX_RESPONSE_BYTES,
    "bounded_http_response_limit_invalid",
  );
  const controller = new AbortController();
  let timedOut = false;
  const parentSignals = [options.signal, init.signal].filter(
    (signal): signal is AbortSignal => Boolean(signal),
  );
  const abortFromParent = () => controller.abort("parent_aborted");
  for (const signal of parentSignals) {
    if (signal.aborted) controller.abort("parent_aborted");
    else signal.addEventListener("abort", abortFromParent, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort("timeout");
  }, timeoutMs);
  const abort = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(new Error(timedOut ? "bounded_http_timeout" : "bounded_http_aborted"));
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener("abort", fail, { once: true });
  });

  try {
    const response = await Promise.race([
      (options.fetchImpl ?? fetch)(input, {
        ...init,
        redirect: init.redirect ?? "error",
        signal: controller.signal,
      }),
      abort,
    ]);
    const text = await responseText(response, maxResponseBytes, abort);
    return Object.freeze({ response, text });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(timedOut ? "bounded_http_timeout" : "bounded_http_aborted");
    }
    throw error;
  } finally {
    clearTimeout(timer);
    for (const signal of parentSignals) {
      signal.removeEventListener("abort", abortFromParent);
    }
  }
}
