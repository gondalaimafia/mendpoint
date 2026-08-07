import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import type { ApiEnv } from "./auth.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const REDACTED = "[redacted]";

export const INTERNAL_ERROR_CODE = "internal_error";

export type PublicErrorRule = Readonly<{
  internalCode: string;
  publicCode?: string;
  status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 503;
  publicMessage?: string;
  responseShape?: "flat" | "nested";
}>;

function stableRequestId(c: Context<ApiEnv>): string {
  const supplied = c.get("requestId") ?? c.req.header("x-request-id") ?? "";
  const requestId = REQUEST_ID_PATTERN.test(supplied)
    ? supplied
    : `req_${randomUUID()}`;
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  return requestId;
}

function safeErrorName(error: Error): string {
  return ERROR_NAME_PATTERN.test(error.name) ? error.name : "Error";
}

/** Convert arbitrary failure details into a recursively safe structure. */
export function redactForStructuredLog(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value !== "object") return REDACTED;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (value instanceof Error) {
    const cause = "cause" in value
      ? redactForStructuredLog((value as Error & { cause?: unknown }).cause, seen)
      : undefined;
    return {
      type: safeErrorName(value),
      message: REDACTED,
      stack: REDACTED,
      ...(cause === undefined ? {} : { cause }),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactForStructuredLog(item, seen));
  }

  return {
    type: "Object",
    fieldCount: Object.keys(value).length,
    values: Object.values(value).map((item) => redactForStructuredLog(item, seen)),
  };
}

export function internalErrorResponse(c: Context<ApiEnv>, error: unknown) {
  const requestId = stableRequestId(c);
  console.error(JSON.stringify({
    event: "api_internal_error",
    requestId,
    method: c.req.method,
    error: redactForStructuredLog(error),
  }));
  return c.json({ error: INTERNAL_ERROR_CODE, requestId }, 500);
}

/** Expose only an exact reviewed domain code; every other failure is internal. */
export function mappedErrorResponse(
  c: Context<ApiEnv>,
  error: unknown,
  rules: readonly PublicErrorRule[],
) {
  const internalCode = error instanceof Error ? error.message : "";
  const rule = rules.find((candidate) => candidate.internalCode === internalCode);
  if (!rule) return internalErrorResponse(c, error);
  const requestId = stableRequestId(c);
  const publicCode = rule.publicCode ?? rule.internalCode;
  const body = rule.responseShape === "nested"
    ? {
        error: {
          code: publicCode,
          ...(rule.publicMessage ? { message: rule.publicMessage } : {}),
        },
        requestId,
      }
    : {
        error: publicCode,
        ...(rule.publicMessage ? { message: rule.publicMessage } : {}),
        requestId,
      };
  return c.json(
    body,
    rule.status,
  );
}
