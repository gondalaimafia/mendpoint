/**
 * Poll one or many vendor OpenAPI feeds → insert versions when content changes → optional pipeline.
 * Lives in catalog as pure orchestration helpers; worker/API call with a DB handle.
 */
import {
  createDb,
  findMonorepoRoot,
  getProviderBySlug,
  insertApiVersionIfAbsent,
  insertFeedPoll,
  insertProvider,
  latestSuccessfulHash,
  latestFeedPollForSlug,
  listProviders,
  listVersionsForProvider,
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
  /** Tenant receiving pipeline and audit results for this poll. */
  tenantId: string;
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

const pollLocks = new WeakMap<object, Map<string, Promise<void>>>();

export async function pollOneFeed(
  feed: PollableFeed,
  opts: PollAllOptions,
): Promise<PollOneResult> {
  const db = opts.db ?? createDb();
  let locks = pollLocks.get(db);
  if (!locks) {
    locks = new Map();
    pollLocks.set(db, locks);
  }
  const prior = locks.get(feed.slug) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.then(() => gate);
  locks.set(feed.slug, tail);
  await prior;
  try {
    return await pollOneFeedUnlocked(feed, { ...opts, db });
  } finally {
    release();
    if (locks.get(feed.slug) === tail) locks.delete(feed.slug);
  }
}

async function pollOneFeedUnlocked(
  feed: PollableFeed,
  opts: PollAllOptions & { db: AppDb },
): Promise<PollOneResult> {
  const db = opts.db;
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

  const latest = latestFeedPollForSlug(db, feed.slug);
  if (
    latest?.content_hash === fetched.contentHash &&
    latest.error &&
    opts.runPipeline !== false &&
    opts.pipeline
  ) {
    try {
      const report = await opts.pipeline(feed.slug, db);
      insertFeedPoll(db, {
        id: newId(),
        providerSlug: feed.slug,
        openapiUrl: url,
        contentHash: fetched.contentHash,
        versionLabel: latest.version_label,
        status: "pipeline_ran",
        versionId: latest.version_id,
        pipelineChangeId: report.changeId,
        polledAt: nowIso(),
      });
      return {
        slug: feed.slug,
        url,
        status: "pipeline_ran",
        contentHash: fetched.contentHash,
        versionLabel: latest.version_label ?? undefined,
        versionId: latest.version_id ?? undefined,
        changeId: report.changeId,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      insertFeedPoll(db, {
        id: newId(),
        providerSlug: feed.slug,
        openapiUrl: url,
        contentHash: fetched.contentHash,
        versionLabel: latest.version_label,
        status: "new_version",
        versionId: latest.version_id,
        error,
        polledAt: nowIso(),
      });
      return {
        slug: feed.slug,
        url,
        status: "new_version",
        contentHash: fetched.contentHash,
        versionLabel: latest.version_label ?? undefined,
        versionId: latest.version_id ?? undefined,
        error,
      };
    }
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

  const versionLabel = fetched.versionLabel ?? `polled-${fetched.contentHash.slice(0, 8)}`;
  let label = versionLabel;
  const existingLabels = new Set(
    listVersionsForProvider(db, provider.id).map((row) => row.version_label),
  );
  if (existingLabels.has(label)) {
    label = `${versionLabel}+${fetched.contentHash.slice(0, 6)}`;
  }
  const versionInsert = insertApiVersionIfAbsent(db, {
    id: newId(),
    providerId: provider.id,
    versionLabel: label,
    openapiJson: fetched.body,
    changelogMd: null,
    publishedAt: nowIso(),
  });
  const versionId = versionInsert.id;
  const insertedVersion = versionInsert.inserted;
  if (!insertedVersion) {
    const existing = listVersionsForProvider(db, provider.id).find(
      (row) => row.id === versionId,
    );
    if (existing) label = existing.version_label;
  }

  if (insertedVersion) {
    recordAudit(db, {
      tenantId: opts.tenantId,
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
  }

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

export async function pollAllFeeds(opts: PollAllOptions): Promise<PollOneResult[]> {
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
