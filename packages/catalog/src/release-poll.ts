import {
  ingestReleaseDocument,
  listReleaseDispatches,
  type ReleaseAdapter,
  type ReleaseIngestionStore,
} from "./release-ingestion.js";
import {
  fetchFeedDocument,
  type FetchFeedOptions,
} from "./poll.js";

export const RELEASE_POLL_CONTRACT_VERSION = "release-poll.v1" as const;

export type ReleasePollConfigurationV1 = Readonly<{
  contractVersion: typeof RELEASE_POLL_CONTRACT_VERSION;
  tenantId: string;
  provider: Readonly<{ slug: string }>;
  adapter: ReleaseAdapter;
  source: Readonly<{
    url: string;
    maxBytes?: number;
  }>;
}>;

export type CanonicalReleasePollConfigurationV1 = ReleasePollConfigurationV1;

export type ReleaseArtifactReference = Readonly<{
  artifactId: string;
  contentSha256: string;
}>;

export type ReleaseDispatchReference = Readonly<{
  dispatchId: string;
  artifactId: string;
  artifactContentSha256: string;
}>;

type ReleasePollIdentity = Readonly<{
  contractVersion: typeof RELEASE_POLL_CONTRACT_VERSION;
  tenantId: string;
  providerSlug: string;
  adapter: ReleaseAdapter;
  sourceUrl: string;
  sourceMaxBytes: number | null;
}>;

export type ReleasePollResult =
  | Readonly<ReleasePollIdentity & {
      status: "ingested" | "unchanged";
      inserted: number;
      artifacts: readonly ReleaseArtifactReference[];
      dispatches: readonly ReleaseDispatchReference[];
    }>
  | Readonly<ReleasePollIdentity & {
      status: "failed";
      error: string;
      inserted: 0;
      artifacts: readonly ReleaseArtifactReference[];
      dispatches: readonly ReleaseDispatchReference[];
    }>;

export type ReleasePollOptions = Readonly<{
  at?: string;
  fetchOptions?: FetchFeedOptions;
}>;

const RELEASE_ADAPTERS = new Set<ReleaseAdapter>([
  "rss",
  "atom",
  "github_releases",
  "provider_page",
  "sdk_registry",
]);
const SENSITIVE_SOURCE_QUERY = /^(?:access_?token|api_?key|authorization|credential|password|private_?key|secret|signature|token)$/i;

type RawReleasePollConfiguration = Readonly<{
  contractVersion: unknown;
  tenantId: unknown;
  providerSlug: unknown;
  adapter: unknown;
  sourceUrl: unknown;
  sourceMaxBytes: unknown;
}>;

function rawConfiguration(config: ReleasePollConfigurationV1): RawReleasePollConfiguration {
  return Object.freeze({
    contractVersion: config.contractVersion,
    tenantId: config.tenantId,
    providerSlug: config.provider.slug,
    adapter: config.adapter,
    sourceUrl: config.source.url,
    sourceMaxBytes: config.source.maxBytes,
  });
}

function canonicalText(name: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw new Error(`${name}_required`);
  const canonical = value.trim();
  if (!canonical || canonical.length > max) throw new Error(`${name}_invalid`);
  return canonical;
}

function canonicalSourceUrl(value: unknown): string {
  const text = canonicalText("release_poll_source_url", value, 2048);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("release_poll_source_url_unsafe");
  }
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password ||
    [...parsed.searchParams.keys()].some((key) => SENSITIVE_SOURCE_QUERY.test(key))
  ) {
    throw new Error("release_poll_source_url_unsafe");
  }
  return parsed.toString();
}

function canonicalMaxBytes(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error("release_poll_source_max_bytes_invalid");
  }
  return Number(value);
}

function canonicalizeRawConfiguration(
  raw: RawReleasePollConfiguration,
): CanonicalReleasePollConfigurationV1 {
  if (raw.contractVersion !== RELEASE_POLL_CONTRACT_VERSION) {
    throw new Error("release_poll_contract_version_unsupported");
  }
  const adapter = canonicalText("release_poll_adapter", raw.adapter, 64) as ReleaseAdapter;
  if (!RELEASE_ADAPTERS.has(adapter)) throw new Error("release_poll_adapter_unsupported");
  const maxBytes = canonicalMaxBytes(raw.sourceMaxBytes);
  return Object.freeze({
    contractVersion: RELEASE_POLL_CONTRACT_VERSION,
    tenantId: canonicalText("release_poll_tenant_id", raw.tenantId, 256),
    provider: Object.freeze({
      slug: canonicalText("release_poll_provider_slug", raw.providerSlug, 128),
    }),
    adapter,
    source: Object.freeze({
      url: canonicalSourceUrl(raw.sourceUrl),
      ...(maxBytes === undefined ? {} : { maxBytes }),
    }),
  });
}

export function canonicalizeReleasePollConfiguration(
  config: ReleasePollConfigurationV1,
): CanonicalReleasePollConfigurationV1 {
  return canonicalizeRawConfiguration(rawConfiguration(config));
}

function identity(config: CanonicalReleasePollConfigurationV1): ReleasePollIdentity {
  return Object.freeze({
    contractVersion: RELEASE_POLL_CONTRACT_VERSION,
    tenantId: config.tenantId,
    providerSlug: config.provider.slug,
    adapter: config.adapter,
    sourceUrl: config.source.url,
    sourceMaxBytes: config.source.maxBytes ?? null,
  });
}

function failureIdentity(raw: RawReleasePollConfiguration): ReleasePollIdentity {
  return Object.freeze({
    contractVersion: RELEASE_POLL_CONTRACT_VERSION,
    tenantId: typeof raw.tenantId === "string" ? raw.tenantId.trim() : "invalid",
    providerSlug: typeof raw.providerSlug === "string" ? raw.providerSlug.trim() : "invalid",
    adapter: (typeof raw.adapter === "string" ? raw.adapter.trim() : "rss") as ReleaseAdapter,
    sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl.trim() : "invalid",
    sourceMaxBytes: Number.isSafeInteger(raw.sourceMaxBytes) ? Number(raw.sourceMaxBytes) : null,
  });
}

function failed(
  pollIdentity: ReleasePollIdentity,
  error: string,
): ReleasePollResult {
  return Object.freeze({
    ...pollIdentity,
    status: "failed" as const,
    error,
    inserted: 0 as const,
    artifacts: Object.freeze([]),
    dispatches: Object.freeze([]),
  });
}

export async function pollReleaseSource(
  store: ReleaseIngestionStore,
  config: ReleasePollConfigurationV1,
  options: ReleasePollOptions = {},
): Promise<ReleasePollResult> {
  const raw = rawConfiguration(config);
  let snapshot: CanonicalReleasePollConfigurationV1;
  try {
    snapshot = canonicalizeRawConfiguration(raw);
  } catch (cause) {
    return failed(failureIdentity(raw), cause instanceof Error ? cause.message : String(cause));
  }
  const pollIdentity = identity(snapshot);
  const at = options.at ?? new Date().toISOString();
  const fetched = await fetchFeedDocument(snapshot.source.url, {
    ...options.fetchOptions,
    maxBytes: snapshot.source.maxBytes ?? options.fetchOptions?.maxBytes,
    provider: snapshot.provider.slug,
  });
  if (!fetched.ok || fetched.body === undefined) {
    return failed(pollIdentity, fetched.error ?? "release_poll_fetch_failed");
  }
  try {
    const ingested = ingestReleaseDocument(store, {
      tenantId: snapshot.tenantId,
      providerSlug: snapshot.provider.slug,
      adapter: snapshot.adapter,
      sourceUrl: snapshot.source.url,
      body: fetched.body,
      observedAt: at,
      now: at,
      maxBytes: snapshot.source.maxBytes,
    });
    const artifacts = Object.freeze(ingested.artifacts.map((artifact) => Object.freeze({
      artifactId: artifact.id,
      contentSha256: artifact.contentSha256,
    })));
    const artifactIds = new Set(artifacts.map((artifact) => artifact.artifactId));
    const dispatches = Object.freeze(listReleaseDispatches(store, snapshot.tenantId)
      .filter((dispatch) => artifactIds.has(dispatch.artifactId))
      .map((dispatch) => Object.freeze({
        dispatchId: dispatch.id,
        artifactId: dispatch.artifactId,
        artifactContentSha256: dispatch.artifactContentSha256,
      })));
    return Object.freeze({
      ...pollIdentity,
      status: ingested.inserted > 0 ? "ingested" as const : "unchanged" as const,
      inserted: ingested.inserted,
      artifacts,
      dispatches,
    });
  } catch (cause) {
    return failed(pollIdentity, cause instanceof Error ? cause.message : String(cause));
  }
}
