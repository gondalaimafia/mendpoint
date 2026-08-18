import { createHash } from "node:crypto";

const PRIVATE_REASONING_KEYS = new Set([
  "chainofthought",
  "cot",
  "hiddenreasoning",
  "privatereasoning",
  "reasoningcontent",
  "scratchpad",
  "thoughts",
]);

export function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort(codeUnitCompare)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function exactDigest(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) fail(code);
  return value;
}

export function exactIso(value: unknown, code: string): string {
  if (typeof value !== "string") fail(code);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail(code);
  return value;
}

export function boundedText(value: unknown, code: string, maximum = 512): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) fail(code);
  return value;
}

export function identifier(value: unknown, code: string): string {
  const result = boundedText(value, code, 256);
  if (!/^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/.test(result)) fail(code);
  return result;
}

export function nonnegative(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(code);
  return value;
}

export function positiveInteger(value: unknown, code: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) fail(code);
  return value as number;
}

export function sortedUnique(values: readonly string[], code: string, maximum = 256): readonly string[] {
  if (!Array.isArray(values) || values.length > maximum) fail(code);
  const normalized = values.map((value) => boundedText(value, code, 1024));
  if (new Set(normalized).size !== normalized.length) fail(code);
  return Object.freeze(normalized.sort(codeUnitCompare));
}

export function rejectPrivateReasoning(value: unknown, depth = 0, seen = new WeakSet<object>()): void {
  if (depth > 20) fail("verifier_value_too_deep");
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) fail("verifier_value_cycle_invalid");
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) rejectPrivateReasoning(child, depth + 1, seen);
  } else {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) || descriptor.get || descriptor.set) fail("verifier_value_accessor_forbidden");
      if (PRIVATE_REASONING_KEYS.has(key.replace(/[_-]/g, "").toLowerCase())) {
        fail("verifier_private_reasoning_forbidden");
      }
      rejectPrivateReasoning(descriptor.value, depth + 1, seen);
    }
  }
  seen.delete(value);
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key)) || keys.some((key) => !(key in value))) fail(code);
}

export function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value as Record<string, unknown>;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function fail(code: string): never {
  throw new Error(code);
}
