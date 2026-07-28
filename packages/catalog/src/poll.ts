/**
 * Continuous OpenAPI feed polling.
 * Fetches catalog / provider openapiUrl, content-hashes, records new versions when changed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

export function contentHash(body: string): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
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

export async function fetchOpenApiDocument(
  url: string,
  opts?: { monorepoRoot?: string; timeoutMs?: number },
): Promise<FetchOpenApiResult> {
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

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 30_000);
    try {
      const res = await fetch(resolved, {
        signal: ctrl.signal,
        headers: { Accept: "application/json, application/yaml, text/yaml, */*" },
      });
      const body = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          url: resolved,
          status: res.status,
          error: `HTTP ${res.status}`,
          body,
        };
      }
      return parseOpenApiBody(resolved, body, res.status);
    } finally {
      clearTimeout(t);
    }
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
