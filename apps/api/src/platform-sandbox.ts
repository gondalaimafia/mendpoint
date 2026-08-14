import { Hono, type Context } from "hono";
import {
  createSandbox,
  RUNTIME_MATRIX,
  sandboxManifest,
} from "@mendpoint/platform";
import type { ApiEnv } from "./auth.js";

const MAX_BODY_BYTES = 1_048_576;
const MAX_FILES = 128;
const MAX_FILE_BYTES = 262_144;
const MAX_TOTAL_FILE_BYTES = 1_048_576;
const MAX_PATH_CHARS = 240;
const MAX_URL_CHARS = 2_048;
const REQUEST_KEYS = new Set(["files", "serviceBaseUrl"]);

type PlatformSandboxRequest = Readonly<{
  files?: Readonly<Record<string, string>>;
  serviceBaseUrl?: string;
}>;

function requestError(code: string): Error {
  return new Error(code);
}

function validPath(path: string): boolean {
  if (
    !path
    || path.length > MAX_PATH_CHARS
    || path.includes("\\")
    || path.includes(":")
    || /[\0-\x1f\x7f]/.test(path)
  ) {
    return false;
  }
  const parts = path.split("/");
  return !path.startsWith("/") && parts.every((part) => part !== "" && part !== "." && part !== "..");
}

function files(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw requestError("platform_sandbox_files_invalid");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_FILES) throw requestError("platform_sandbox_file_count_invalid");
  let totalBytes = 0;
  const result = Object.create(null) as Record<string, string>;
  for (const [path, content] of entries) {
    if (!validPath(path) || typeof content !== "string") {
      throw requestError("platform_sandbox_file_invalid");
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) throw requestError("platform_sandbox_file_too_large");
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_FILE_BYTES) {
      throw requestError("platform_sandbox_files_too_large");
    }
    result[path] = content;
  }
  return Object.freeze(result);
}

function serviceBaseUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_CHARS) {
    throw requestError("platform_sandbox_service_url_invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw requestError("platform_sandbox_service_url_invalid");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw requestError("platform_sandbox_service_url_invalid");
  }
  return parsed.toString();
}

async function parseRequest(c: Context<ApiEnv>): Promise<PlatformSandboxRequest> {
  const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw requestError("platform_sandbox_content_type_invalid");
  }
  const declared = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw requestError("platform_sandbox_request_too_large");
  }
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw requestError("platform_sandbox_request_too_large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw requestError("platform_sandbox_request_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw requestError("platform_sandbox_request_invalid");
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).some((key) => !REQUEST_KEYS.has(key))) {
    throw requestError("platform_sandbox_field_invalid");
  }
  return Object.freeze({
    files: files(value.files),
    serviceBaseUrl: serviceBaseUrl(value.serviceBaseUrl),
  });
}

function failure(c: Context<ApiEnv>, error: unknown): Response {
  const code = error instanceof Error ? error.message : "platform_sandbox_failed";
  if (code === "platform_sandbox_request_too_large" || code.endsWith("_too_large")) {
    return c.json({ error: code }, 413);
  }
  if (code === "platform_sandbox_content_type_invalid") {
    return c.json({ error: code }, 415);
  }
  if (code.startsWith("platform_sandbox_")) {
    return c.json({ error: code }, 422);
  }
  throw error;
}

export function createPlatformSandboxRoutes(): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  routes.post("/", async (c) => {
    try {
      const body = await parseRequest(c);
      const sandbox = createSandbox({
        files: body.files,
        serviceBaseUrl: body.serviceBaseUrl,
        mocks: [{ name: "upstream-stub" }],
      });
      try {
        const manifest = sandboxManifest(sandbox);
        return c.json({ ...manifest, disposed: true, runtimes: RUNTIME_MATRIX });
      } finally {
        sandbox.dispose();
      }
    } catch (error) {
      return failure(c, error);
    }
  });
  return routes;
}
