export class BodyLimitExceededError extends Error {
  constructor() {
    super("body_limit_exceeded");
    this.name = "BodyLimitExceededError";
  }
}

export class InvalidContentLengthError extends Error {
  constructor() {
    super("content_length_invalid");
    this.name = "InvalidContentLengthError";
  }
}

export function cancelBody(
  body: ReadableStream<Uint8Array> | null,
  abort?: () => void,
): void {
  abort?.();
  if (body) void body.cancel("body_limit_exceeded").catch(() => undefined);
}

export async function readBodyWithinLimit(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
  abort?: () => void,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("body_limit_invalid");
  }
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = maximumBytes + 1 - totalBytes;
      const retainedBytes = Math.min(next.value.byteLength, Math.max(remaining, 0));
      if (retainedBytes > 0) {
        const retained = new Uint8Array(retainedBytes);
        retained.set(next.value.subarray(0, retainedBytes));
        chunks.push(retained);
        totalBytes += retainedBytes;
      }
      if (next.value.byteLength > retainedBytes || totalBytes > maximumBytes) {
        abort?.();
        await reader.cancel("body_limit_exceeded").catch(() => undefined);
        throw new BodyLimitExceededError();
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0]!;
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readRequestBodyWithinLimit(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      cancelBody(request.body);
      throw new InvalidContentLengthError();
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes)) {
      cancelBody(request.body);
      throw new InvalidContentLengthError();
    }
    if (declaredBytes > maximumBytes) {
      cancelBody(request.body);
      throw new BodyLimitExceededError();
    }
  }
  return readBodyWithinLimit(request.body, maximumBytes);
}
