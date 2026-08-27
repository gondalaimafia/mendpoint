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

function identity(config: ReleasePollConfigurationV1): ReleasePollIdentity {
  return Object.freeze({
    contractVersion: RELEASE_POLL_CONTRACT_VERSION,
    tenantId: config.tenantId,
    providerSlug: config.provider.slug,
    adapter: config.adapter,
    sourceUrl: config.source.url,
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
  const pollIdentity = identity(config);
  if (config.contractVersion !== RELEASE_POLL_CONTRACT_VERSION) {
    return failed(pollIdentity, "release_poll_contract_version_unsupported");
  }
  if (!RELEASE_ADAPTERS.has(config.adapter)) {
    return failed(pollIdentity, "release_poll_adapter_unsupported");
  }
  const at = options.at ?? new Date().toISOString();
  const fetched = await fetchFeedDocument(config.source.url, {
    ...options.fetchOptions,
    maxBytes: config.source.maxBytes ?? options.fetchOptions?.maxBytes,
    provider: config.provider.slug,
  });
  if (!fetched.ok || fetched.body === undefined) {
    return failed(pollIdentity, fetched.error ?? "release_poll_fetch_failed");
  }
  try {
    const ingested = ingestReleaseDocument(store, {
      tenantId: config.tenantId,
      providerSlug: config.provider.slug,
      adapter: config.adapter,
      sourceUrl: config.source.url,
      body: fetched.body,
      observedAt: at,
      now: at,
      maxBytes: config.source.maxBytes,
    });
    const artifacts = Object.freeze(ingested.artifacts.map((artifact) => Object.freeze({
      artifactId: artifact.id,
      contentSha256: artifact.contentSha256,
    })));
    const artifactIds = new Set(artifacts.map((artifact) => artifact.artifactId));
    const dispatches = Object.freeze(listReleaseDispatches(store, config.tenantId)
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
