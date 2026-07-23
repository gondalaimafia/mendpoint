/**
 * Poll one or many vendor OpenAPI feeds → insert versions when content changes → optional pipeline.
 * Lives in catalog as pure orchestration helpers; worker/API call with a DB handle.
 */
import {
  createDb,
  findMonorepoRoot,
  getProviderBySlug,
  insertApiVersion,
  insertFeedPoll,
  insertProvider,
  latestSuccessfulHash,
  listProviders,
  recordAudit,
  updateProviderFeedUrls,
  type AppDb,
} from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";
import { fetchOpenApiDocument, listCatalogFeeds, type PollableFeed } from "./poll.js";
import { VENDOR_CATALOG } from "./vendors.js";

export type PollOneResult = {
  slug: string;
  url: string;
  status:
    | "unchanged"
    | "new_version"
    | "pipeline_ran"
    | "error"
    | "no_url"
    | "skipped";
  contentHash?: string;
  versionLabel?: string;
  versionId?: string;
  changeId?: string;
  error?: string;
};

export type PollAllOptions = {
  db?: AppDb;
  monorepoRoot?: string;
  /** Run change pipeline when a new version is stored (default true if ≥2 versions). */
  runPipeline?: boolean;
  /** Only these slugs (default: all catalog+DB feeds with URLs). */
  slugs?: string[];
  /** Skip HTTP feeds (useful offline / tests). */
  localOnly?: boolean;
  pipeline?: (slug: string, db: AppDb) => Promise<{ changeId: string }>;
};

function collectFeeds(db: AppDb): PollableFeed[] {
  const bySlug = new Map<string, PollableFeed>();
  for (const f of listCatalogFeeds()) {
    bySlug.set(f.slug, f);
  }
  for (const p of listProviders(db)) {
    const url = p.openapi_url;
    if (url) {
      bySlug.set(p.slug, {
        slug: p.slug,
        name: p.name,
        openapiUrl: url,
        changelogUrl: p.changelog_url ?? undefined,
        source: "provider",
      });
    }
  }
  return [...bySlug.values()];
}

function ensureProvider(db: AppDb, feed: PollableFeed) {
  let p = getProviderBySlug(db, feed.slug);
  if (!p) {
    const cat = VENDOR_CATALOG.find((v) => v.slug === feed.slug);
    insertProvider(db, {
      id: newId(),
      slug: feed.slug,
      name: feed.name,
      website: cat?.website ?? null,
      openapiUrl: feed.openapiUrl,
      changelogUrl: feed.changelogUrl ?? null,
      createdAt: nowIso(),
    });
    p = getProviderBySlug(db, feed.slug)!;
  } else if (!p.openapi_url && feed.openapiUrl) {
    updateProviderFeedUrls(db, feed.slug, {
      openapiUrl: feed.openapiUrl,
      changelogUrl: feed.changelogUrl ?? null,
    });
  }
  return p;
}

export async function pollOneFeed(
  feed: PollableFeed,
  opts: PollAllOptions = {},
): Promise<PollOneResult> {
  const db = opts.db ?? createDb();
  const root = opts.monorepoRoot ?? findMonorepoRoot();
  const url = feed.openapiUrl;

  if (opts.localOnly && !url.startsWith("file:")) {
    return { slug: feed.slug, url, status: "skipped" };
  }

  ensureProvider(db, feed);

  const fetched = await fetchOpenApiDocument(url, { monorepoRoot: root });
  if (!fetched.ok || !fetched.contentHash || !fetched.body) {
    const err = fetched.error ?? "fetch failed";
    insertFeedPoll(db, {
      id: newId(),
      providerSlug: feed.slug,
      openapiUrl: url,
      status: "error",
      error: err,
      polledAt: nowIso(),
    });
    return { slug: feed.slug, url, status: "error", error: err };
  }

  const prev = latestSuccessfulHash(db, feed.slug);
  // Also compare against last stored version body hash via version_label match
  const provider = getProviderBySlug(db, feed.slug)!;
  if (prev === fetched.contentHash) {
    insertFeedPoll(db, {
      id: newId(),
      providerSlug: feed.slug,
      openapiUrl: url,
      contentHash: fetched.contentHash,
      versionLabel: fetched.versionLabel,
      status: "unchanged",
      polledAt: nowIso(),
    });
    return {
      slug: feed.slug,
      url,
      status: "unchanged",
      contentHash: fetched.contentHash,
      versionLabel: fetched.versionLabel,
    };
  }

  const versionId = newId();
  const versionLabel = fetched.versionLabel ?? `polled-${fetched.contentHash.slice(0, 8)}`;
  // Disambiguate if label already exists for this provider
  let label = versionLabel;
  const existingLabels = new Set(
    (
      db.raw
        .prepare(`SELECT version_label FROM api_versions WHERE provider_id = ?`)
        .all(provider.id) as Array<{ version_label: string }>
    ).map((r) => r.version_label),
  );
  if (existingLabels.has(label)) {
    label = `${versionLabel}+${fetched.contentHash.slice(0, 6)}`;
  }

  insertApiVersion(db, {
    id: versionId,
    providerId: provider.id,
    versionLabel: label,
    openapiJson: fetched.body,
    changelogMd: null,
    publishedAt: nowIso(),
  });

  recordAudit(db, {
    actor: "worker",
    action: "feed.new_version",
    resourceType: "provider",
    resourceId: provider.id,
    metadata: {
      slug: feed.slug,
      versionLabel: label,
      contentHash: fetched.contentHash,
      url,
    },
  });

  let changeId: string | undefined;
  let status: PollOneResult["status"] = "new_version";

  const shouldPipe = opts.runPipeline !== false;
  if (shouldPipe && opts.pipeline) {
    try {
      const report = await opts.pipeline(feed.slug, db);
      changeId = report.changeId;
      status = "pipeline_ran";
    } catch (e) {
      // Version stored; pipeline may fail if only 1 version or no consumers
      insertFeedPoll(db, {
        id: newId(),
        providerSlug: feed.slug,
        openapiUrl: url,
        contentHash: fetched.contentHash,
        versionLabel: label,
        status: "new_version",
        versionId,
        error: e instanceof Error ? e.message : String(e),
        polledAt: nowIso(),
      });
      return {
        slug: feed.slug,
        url,
        status: "new_version",
        contentHash: fetched.contentHash,
        versionLabel: label,
        versionId,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  insertFeedPoll(db, {
    id: newId(),
    providerSlug: feed.slug,
    openapiUrl: url,
    contentHash: fetched.contentHash,
    versionLabel: label,
    status,
    versionId,
    pipelineChangeId: changeId ?? null,
    polledAt: nowIso(),
  });

  return {
    slug: feed.slug,
    url,
    status,
    contentHash: fetched.contentHash,
    versionLabel: label,
    versionId,
    changeId,
  };
}

export async function pollAllFeeds(opts: PollAllOptions = {}): Promise<PollOneResult[]> {
  const db = opts.db ?? createDb();
  let feeds = collectFeeds(db);
  if (opts.slugs?.length) {
    const want = new Set(opts.slugs);
    feeds = feeds.filter((f) => want.has(f.slug));
  }
  if (opts.localOnly) {
    feeds = feeds.filter((f) => f.openapiUrl.startsWith("file:"));
  }

  const results: PollOneResult[] = [];
  for (const feed of feeds) {
    results.push(await pollOneFeed(feed, { ...opts, db }));
  }
  return results;
}
