import {
  pathBlocked,
  redactSourceForModel,
  verificationControlPath,
} from "@mendpoint/agent";
import { deploymentProfile } from "@mendpoint/ops";

export type WardenRunInput = Readonly<{
  goal: string;
  consumerId: string;
  allowedChangedPaths: readonly string[];
  verifyCommand?: string;
  errorLog?: string;
  maxSteps: number;
  dryRun?: boolean;
  useLlm?: boolean;
  ingressRedactions: number;
}>;

export type WardenRunInputResult =
  | Readonly<{ ok: true; value: WardenRunInput }>
  | Readonly<{ ok: false; error: string }>;

const OPTIONAL_BOOLEAN_ERRORS = new Set([
  "dryRun must be a boolean",
  "useLlm must be a boolean",
]);

export function resolveWardenUseLlm(
  input: Readonly<{ useLlm?: boolean }>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (deploymentProfile(env) === "customer") return true;
  return input.useLlm ?? env.LLM_AGENT === "1";
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

export function parseWardenRunInput(body: unknown): WardenRunInputResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "request body must be an object" };
  }
  const input = body as Record<string, unknown>;
  if (typeof input.goal !== "string" || !input.goal.trim()) {
    return { ok: false, error: "goal required" };
  }
  if (typeof input.consumerId !== "string" || !input.consumerId.trim()) {
    return { ok: false, error: "consumerId required" };
  }
  const paths = input.allowedChangedPaths;
  if (
    !Array.isArray(paths) ||
    paths.length < 1 ||
    paths.length > 40 ||
    paths.some((path) =>
      typeof path !== "string" ||
      path.length < 1 ||
      path.length > 500 ||
      path.includes("\0") ||
      path.includes("\\") ||
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) ||
    new Set(paths).size !== paths.length
  ) {
    return {
      ok: false,
      error: "allowedChangedPaths must contain 1 to 40 unique repository file paths",
    };
  }
  if (paths.some((path) => verificationControlPath(String(path)))) {
    return { ok: false, error: "allowedChangedPaths cannot include tests or verification controls" };
  }
  if (paths.some((path) => pathBlocked(String(path)))) {
    return { ok: false, error: "allowedChangedPaths contains a protected repository path" };
  }
  const goal = redactSourceForModel(input.goal.trim(), 4_000);
  if (goal.excluded || goal.truncated) {
    return { ok: false, error: "goal contains unsupported or excessive content" };
  }
  let errorLog: ReturnType<typeof redactSourceForModel> | undefined;
  if (input.errorLog !== undefined) {
    if (typeof input.errorLog !== "string") {
      return { ok: false, error: "errorLog must be a string" };
    }
    errorLog = redactSourceForModel(input.errorLog, 8_000);
    if (errorLog.excluded || errorLog.truncated) {
      return { ok: false, error: "errorLog contains unsupported or excessive content" };
    }
  }
  if (
    input.verifyCommand !== undefined &&
    (typeof input.verifyCommand !== "string" || !input.verifyCommand.trim() || input.verifyCommand.length > 500)
  ) {
    return { ok: false, error: "verifyCommand must be a nonempty string" };
  }
  const maxSteps = input.maxSteps === undefined ? 20 : Number(input.maxSteps);
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) {
    return { ok: false, error: "maxSteps must be an integer from 1 to 100" };
  }
  if (input.dryRun === true) {
    return { ok: false, error: "dryRun is not supported for snapshot bound Gauge runs" };
  }
  try {
    return {
      ok: true,
      value: Object.freeze({
        goal: goal.text,
        consumerId: input.consumerId.trim(),
        allowedChangedPaths: Object.freeze([...paths]),
        ...(typeof input.verifyCommand === "string"
          ? { verifyCommand: input.verifyCommand.trim() }
          : {}),
        ...(errorLog ? { errorLog: errorLog.text } : {}),
        maxSteps,
        ...(input.dryRun !== undefined
          ? { dryRun: optionalBoolean(input.dryRun, "dryRun") }
          : {}),
        ...(input.useLlm !== undefined
          ? { useLlm: optionalBoolean(input.useLlm, "useLlm") }
          : {}),
        ingressRedactions: goal.counts.total + (errorLog?.counts.total ?? 0),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error && OPTIONAL_BOOLEAN_ERRORS.has(error.message)
        ? error.message
        : "request is invalid",
    };
  }
}
