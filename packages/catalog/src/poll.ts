/**
 * Continuous OpenAPI feed polling.
 * Fetches catalog / provider openapiUrl, content-hashes, records new versions when changed.
 */
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { join, resolve } from "node:path";
import { VENDOR_CATALOG, type VendorEntry } from "./vendors.js";

export type FetchOpenApiResult = {
  ok: boolean;
  url: string;
  body?: string;
  openapi?: unknown;
  contentHash?: string;
  versionLabel?: string;
  error?: string;
  status?: number;
};

export type OpenApiValidationEvidence = {
  id: string;
  source: "catalog" | "provider" | "unknown";
  format: "json" | "unknown";
  formatStatus: "accepted" | "rejected" | "not_observed";
  schemaVersion: string | null;
  schemaStatus: "accepted" | "rejected" | "not_observed";
  sizeBytes: number;
  contentSha256: string | null;
  status: "accepted" | "rejected" | "skipped";
  error: string | null;
  httpStatus: number | null;
  observedAt: string;
};

export function contentHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

function supportedSchemaVersion(document: Record<string, unknown>): string | null {
  const version = document.openapi ?? document.swagger;
  if (typeof version !== "string" || !version.trim()) return null;
  const normalized = version.trim();
  if ("swagger" in document) return normalized === "2.0" ? normalized : null;
  return /^3\.(?:0|1)\.\d+(?:[-+].*)?$/.test(normalized) ? normalized : null;
}

export function buildOpenApiValidationEvidence(
  fetched: FetchOpenApiResult,
  input: {
    id: string;
    source: "catalog" | "provider" | "unknown";
    observedAt: string;
    status?: "accepted" | "rejected" | "skipped";
  },
): OpenApiValidationEvidence {
  const body = fetched.body;
  const sizeBytes = body === undefined ? 0 : Buffer.byteLength(body, "utf8");
  const contentSha256 = body === undefined
    ? null
    : createHash("sha256").update(body, "utf8").digest("hex");
  let format: OpenApiValidationEvidence["format"] = "unknown";
  let formatStatus: OpenApiValidationEvidence["formatStatus"] = "not_observed";
  let schemaVersion: string | null = null;
  let schemaStatus: OpenApiValidationEvidence["schemaStatus"] = "not_observed";
  if (body !== undefined) {
    try {
      const parsed = JSON.parse(body) as unknown;
      format = "json";
      formatStatus = "accepted";
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const document = parsed as Record<string, unknown>;
        const declared = document.openapi ?? document.swagger;
        schemaVersion = typeof declared === "string" ? declared.trim() || null : null;
        const validVersion = supportedSchemaVersion(document);
        const validInfo = Boolean(
          document.info && typeof document.info === "object" && !Array.isArray(document.info),
        );
        const validPaths = Boolean(
          document.paths && typeof document.paths === "object" && !Array.isArray(document.paths),
        );
        schemaStatus = validVersion && validInfo && validPaths ? "accepted" : "rejected";
      } else {
        schemaStatus = "rejected";
      }
    } catch {
      formatStatus = "rejected";
    }
  }
  return {
    id: input.id,
    source: input.source,
    format,
    formatStatus,
    schemaVersion,
    schemaStatus,
    sizeBytes,
    contentSha256,
    status: input.status ?? (fetched.ok ? "accepted" : "rejected"),
    error: fetched.error ?? null,
    httpStatus: fetched.status ?? null,
    observedAt: input.observedAt,
  };
}

/** Resolve file: relative paths against monorepo root (or cwd). */
export function resolveFeedUrl(url: string, monorepoRoot?: string): string {
  if (!url.startsWith("file:")) return url;
  const pathPart = url.slice("file:".length);
  const windowsFileUriPath =
    pathPart.match(/^\/+([A-Za-z]:[\\/].*)$/)?.[1];
  const absolutePath =
    windowsFileUriPath ??
    (/^[A-Za-z]:[\\/]/.test(pathPart) || pathPart.startsWith("/")
      ? pathPart
      : undefined);
  if (absolutePath) {
    return `file:${resolve(absolutePath)}`;
  }
  const root = monorepoRoot ?? process.cwd();
  return `file:${join(root, pathPart)}`;
}

type HostResolver = (hostname: string) => Promise<string[]>;

export type FetchOpenApiOptions = {
  monorepoRoot?: string;
  timeoutMs?: number;
  maxBytes?: number;
  production?: boolean;
  fetchImpl?: typeof fetch;
  resolveHostname?: HostResolver;
  /** Human-readable provider/feed label, surfaced in size-limit errors. */
  provider?: string;
};

/**
 * Default ceiling for a fetched OpenAPI feed body.
 *
 * Real published specs already exceed the old 5 MiB cap: Stripe's spec3.json is
 * ~8.17 MB and GitHub's REST description is larger still. 32 MiB gives ~4x
 * headroom over Stripe while still hard-stopping runaway or hostile responses.
 * Measured cost of parsing the 8.17 MB Stripe spec: ~27 ms, ~7.7 MB of parsed
 * object-graph heap, plus the retained body string (~8 MB) — a peak on the order
 * of ~25-30 MB. Scaling roughly linearly, a full 32 MiB payload costs ~100-130 MB
 * peak, which a single-flight poller can absorb; anything past that is rejected
 * before the body is buffered.
 */
export const DEFAULT_FEED_MAX_BYTES = 32 * 1024 * 1024;

const remoteBlockList = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
] as const) {
  remoteBlockList.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  remoteBlockList.addSubnet(network, prefix, "ipv6");
}

function blockedRemoteAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0]!;
  if (normalized.startsWith("::ffff:")) return true;
  const family = isIP(normalized);
  if (family === 4) return remoteBlockList.check(normalized, "ipv4");
  if (family === 6) return remoteBlockList.check(normalized, "ipv6");
  return true;
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map(
    (entry) => entry.address,
  );
}

async function validateProductionRemoteUrl(
  input: URL,
  resolveHostname: HostResolver,
): Promise<void> {
  if (input.protocol !== "https:") {
    throw new Error("production feed URLs must use https");
  }
  if (input.username || input.password) {
    throw new Error("production feed URLs must not contain credentials");
  }
  const hostname = input.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "metadata" ||
    hostname === "metadata.google.internal" ||
    hostname === "instance-data"
  ) {
    throw new Error("production feed URL resolves to a blocked host");
  }
  const addresses = isIP(hostname)
    ? [hostname]
    : await resolveHostname(hostname);
  if (!addresses.length || addresses.some(blockedRemoteAddress)) {
    throw new Error("production feed URL resolves to a blocked address");
  }
}

async function boundedResponseText(
  response: Response,
  maxBytes: number,
  controller: AbortController,
  provider: string,
): Promise<string> {
  // Reject early on the declared size, before buffering any of the body.
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    controller.abort();
    throw new Error(
      `OpenAPI feed for ${provider} is ${declared} bytes, over the ${maxBytes}-byte limit`,
    );
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        controller.abort();
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `OpenAPI feed for ${provider} exceeds the ${maxBytes}-byte limit ` +
            `(read ${size}+ bytes before aborting)`,
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export async function fetchOpenApiDocument(
  url: string,
  opts?: FetchOpenApiOptions,
): Promise<FetchOpenApiResult> {
  const production =
    opts?.production ?? process.env.NODE_ENV === "production";
  if (production && url.startsWith("file:")) {
    return {
      ok: false,
      url,
      error: "file feed URLs are disabled in production",
    };
  }
  const resolved = resolveFeedUrl(url, opts?.monorepoRoot);
  try {
    if (resolved.startsWith("file:")) {
      const path = resolved.slice("file:".length);
      if (!existsSync(path)) {
        return { ok: false, url: resolved, error: `file not found: ${path}` };
      }
      const body = readFileSync(path, "utf8");
      return parseOpenApiBody(resolved, body);
    }

    const fetchImpl = opts?.fetchImpl ?? fetch;
    const resolveHostname = opts?.resolveHostname ?? defaultResolveHostname;
    const maxBytes = opts?.maxBytes ?? DEFAULT_FEED_MAX_BYTES;
    let current = new URL(resolved);
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (production) {
        await validateProductionRemoteUrl(current, resolveHostname);
      }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 30_000);
      let res: Response;
      try {
        res = await fetchImpl(current, {
          signal: ctrl.signal,
          redirect: "manual",
          headers: {
            Accept: "application/json, application/yaml, text/yaml, */*",
          },
        });
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get("location");
          if (!location) {
            return {
              ok: false,
              url: current.href,
              status: res.status,
              error: `HTTP ${res.status} redirect missing location`,
            };
          }
          if (redirects === 5) {
            return {
              ok: false,
              url: current.href,
              status: res.status,
              error: "too many feed redirects",
            };
          }
          await res.body?.cancel().catch(() => undefined);
          current = new URL(location, current);
          continue;
        }
        const providerLabel = opts?.provider ?? current.hostname;
        const body = await boundedResponseText(res, maxBytes, ctrl, providerLabel);
        if (!res.ok) {
          return {
            ok: false,
            url: current.href,
            status: res.status,
            error: `HTTP ${res.status}`,
            body,
          };
        }
        return parseOpenApiBody(current.href, body, res.status);
      } finally {
        clearTimeout(t);
      }
    }
    return {
      ok: false,
      url: current.href,
      error: "too many feed redirects",
    };
  } catch (e) {
    return {
      ok: false,
      url: resolved,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function parseOpenApiBody(
  url: string,
  body: string,
  status?: number,
): FetchOpenApiResult {
  let openapi: unknown;
  try {
    openapi = JSON.parse(body);
  } catch {
    // Minimal YAML tolerance: not a full parser — store raw, fail structured parse
    return {
      ok: false,
      url,
      status,
      body,
      error: "OpenAPI body is not valid JSON (YAML feeds need conversion)",
    };
  }
  if (!openapi || typeof openapi !== "object" || Array.isArray(openapi)) {
    return {
      ok: false,
      url,
      status,
      body,
      error: "OpenAPI document must be a JSON object",
    };
  }
  const doc = openapi as Record<string, unknown>;
  const version = doc.openapi ?? doc.swagger;
  if (typeof version !== "string" || !version.trim()) {
    return {
      ok: false,
      url,
      status,
      body,
      error: "OpenAPI document is missing openapi or swagger version",
    };
  }
  if (!supportedSchemaVersion(doc)) {
    return {
      ok: false,
      url,
      status,
      body,
      error: `OpenAPI schema version is unsupported: ${String(version)}`,
    };
  }
  if (!doc.info || typeof doc.info !== "object" || Array.isArray(doc.info)) {
    return {
      ok: false,
      url,
      status,
      body,
      error: "OpenAPI document is missing info object",
    };
  }
  if (!doc.paths || typeof doc.paths !== "object" || Array.isArray(doc.paths)) {
    return {
      ok: false,
      url,
      status,
      body,
      error: "OpenAPI document is missing paths object",
    };
  }
  const hash = contentHash(body);
  const versionLabel = extractVersionLabel(openapi, hash);
  return {
    ok: true,
    url,
    status,
    body,
    openapi,
    contentHash: hash,
    versionLabel,
  };
}

export function extractVersionLabel(openapi: unknown, hash: string): string {
  const info =
    openapi && typeof openapi === "object" && "info" in openapi
      ? (openapi as { info?: { version?: string } }).info
      : undefined;
  const v = info?.version?.trim();
  if (v) return v;
  return `polled-${hash.slice(0, 8)}`;
}

export type PollableFeed = {
  slug: string;
  name: string;
  openapiUrl: string;
  changelogUrl?: string;
  source: "catalog" | "provider";
};

/** Catalog entries that have a feed URL configured. */
export function listCatalogFeeds(): PollableFeed[] {
  return VENDOR_CATALOG.filter((v): v is VendorEntry & { openapiUrl: string } =>
    Boolean(v.openapiUrl),
  ).map((v) => ({
    slug: v.slug,
    name: v.name,
    openapiUrl: v.openapiUrl!,
    changelogUrl: v.changelogUrl,
    source: "catalog" as const,
  }));
}

export function catalogFeedForSlug(slug: string): PollableFeed | undefined {
  return listCatalogFeeds().find((f) => f.slug === slug);
}
