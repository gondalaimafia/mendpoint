/**
 * Poll one or many vendor OpenAPI feeds → insert versions when content changes → optional pipeline.
 * Lives in catalog as pure orchestration helpers; worker/API call with a DB handle.
 */
import {
  claimFeedTenantDispatch,
  completeFeedTenantDispatch,
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
import { boundedConcurrency, mapWithConcurrency } from "./concurrency.js";
import {
  buildOpenApiValidationEvidence,
  fetchOpenApiDocument,
  listCatalogFeeds,
  type FetchOpenApiResult,
  type PollableFeed,
} from "./poll.js";
import { VENDOR_CATALOG } from "./vendors.js";

export type FeedPipelineContext = {
  tenantId: string;
  contentHash: string;
  versionId?: string;
  versionLabel?: string;
};

export type FeedPipelineDispatchResult =
  | { changeId: string; jobId?: never }
  | { jobId: string; changeId?: never };

export type PollOneResult = {
  slug: string;
  url: string;
  status:
    | "unchanged"
    | "new_version"
    | "pipeline_ran"
    | "pipeline_enqueued"
    | "error"
    | "no_url"
    | "skipped";
  contentHash?: string;
  versionLabel?: string;
  versionId?: string;
  changeId?: string;
  jobId?: string;
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
  /** Maximum number of feeds with remote work in flight (default 4, max 16). */
  concurrency?: number;
  pipeline?: (
    slug: string,
    db: AppDb,
    context: FeedPipelineContext,
  ) => Promise<FeedPipelineDispatchResult>;
  /** Request-scoped source cache used to share one provider fetch across tenant schedules. */
  sourceFetches?: Map<string, Promise<FetchOpenApiResult>>;
  sourceDocumentLoader?: (
    url: string,
    monorepoRoot: string,
  ) => Promise<FetchOpenApiResult>;
};

function pipelineResult(
  report: FeedPipelineDispatchResult,
): Pick<PollOneResult, "status" | "changeId" | "jobId"> {
  return "jobId" in report
    ? { status: "pipeline_enqueued", jobId: report.jobId }
    : { status: "pipeline_ran", changeId: report.changeId };
}

export function listPollableFeeds(db: AppDb): PollableFeed[] {
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

function persistPollOutcome(
  db: AppDb,
  feed: PollableFeed,
  tenantId: string,
  fetched: FetchOpenApiResult,
  row: {
    status: PollOneResult["status"];
    contentHash?: string | null;
    versionLabel?: string | null;
    error?: string | null;
    versionId?: string | null;
    pipelineChangeId?: string | null;
    validationStatus?: "accepted" | "rejected" | "skipped";
  },
) {
  const polledAt = nowIso();
  insertFeedPoll(db, {
    id: newId(),
    tenantId,
    providerSlug: feed.slug,
    openapiUrl: feed.openapiUrl,
    contentHash: row.contentHash,
    versionLabel: row.versionLabel,
    status: row.status,
    error: row.error,
    versionId: row.versionId,
    pipelineChangeId: row.pipelineChangeId,
    polledAt,
    validationEvidence: buildOpenApiValidationEvidence(fetched, {
      id: newId(),
      source: feed.source,
      observedAt: polledAt,
      status: row.validationStatus,
    }),
  });
}

async function dispatchTenantPipeline(
  db: AppDb,
  feed: PollableFeed,
  opts: PollAllOptions,
  context: FeedPipelineContext,
): Promise<FeedPipelineDispatchResult | undefined> {
  if (opts.runPipeline === false || !opts.pipeline) return undefined;
  const attemptedAt = nowIso();
  const leaseGeneration = claimFeedTenantDispatch(db, {
    tenantId: opts.tenantId,
    providerSlug: feed.slug,
    contentHash: context.contentHash,
    versionId: context.versionId,
    attemptedAt,
  });
  if (leaseGeneration === null) return undefined;
  try {
    const result = await opts.pipeline(feed.slug, db, context);
    completeFeedTenantDispatch(db, {
      tenantId: opts.tenantId,
      providerSlug: feed.slug,
      contentHash: context.contentHash,
      leaseGeneration,
      succeeded: true,
      pipelineRef: result.changeId ?? result.jobId,
      completedAt: nowIso(),
    });
    return result;
  } catch (error) {
    completeFeedTenantDispatch(db, {
      tenantId: opts.tenantId,
      providerSlug: feed.slug,
      contentHash: context.contentHash,
      leaseGeneration,
      succeeded: false,
      error: error instanceof Error ? error.message : String(error),
      completedAt: nowIso(),
    });
    throw error;
  }
}

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
    const error = "remote feed skipped in local-only mode";
    persistPollOutcome(db, feed, opts.tenantId, { ok: false, url, error }, {
      status: "skipped",
      error,
      validationStatus: "skipped",
    });
    return { slug: feed.slug, url, status: "skipped" };
  }

  ensureProvider(db, feed);

  const load = opts.sourceDocumentLoader
    ? () => opts.sourceDocumentLoader!(url, root)
    : () => fetchOpenApiDocument(url, { monorepoRoot: root });
  let sourceFetch = opts.sourceFetches?.get(url);
  if (!sourceFetch) {
    sourceFetch = load();
    opts.sourceFetches?.set(url, sourceFetch);
  }
  const fetched = await sourceFetch;
  if (!fetched.ok || !fetched.contentHash || !fetched.body) {
    const err = fetched.error ?? "fetch failed";
    persistPollOutcome(db, feed, opts.tenantId, fetched, {
      status: "error",
      error: err,
      validationStatus: "rejected",
    });
    return { slug: feed.slug, url, status: "error", error: err };
  }

  const latest = latestFeedPollForSlug(db, feed.slug);
  const prev = latestSuccessfulHash(db, feed.slug);
  const provider = getProviderBySlug(db, feed.slug)!;
  if (prev === fetched.contentHash) {
    const versions = listVersionsForProvider(db, provider.id);
    const existingVersion =
      versions.find((version) => version.id === latest?.version_id) ??
      versions.at(-1);
    try {
      const report = await dispatchTenantPipeline(db, feed, opts, {
        tenantId: opts.tenantId,
        contentHash: fetched.contentHash,
        versionId: existingVersion?.id,
        versionLabel: existingVersion?.version_label ?? fetched.versionLabel,
      });
      const dispatched = report ? pipelineResult(report) : undefined;
      persistPollOutcome(db, feed, opts.tenantId, fetched, {
        contentHash: fetched.contentHash,
        versionLabel: existingVersion?.version_label ?? fetched.versionLabel,
        status: dispatched?.status ?? "unchanged",
        versionId: existingVersion?.id,
        pipelineChangeId: dispatched?.changeId ?? dispatched?.jobId,
      });
      return {
        slug: feed.slug,
        url,
        status: dispatched?.status ?? "unchanged",
        contentHash: fetched.contentHash,
        versionLabel: existingVersion?.version_label ?? fetched.versionLabel,
        versionId: existingVersion?.id,
        changeId: dispatched?.changeId,
        jobId: dispatched?.jobId,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      persistPollOutcome(db, feed, opts.tenantId, fetched, {
        contentHash: fetched.contentHash,
        versionLabel: existingVersion?.version_label ?? fetched.versionLabel,
        status: "new_version",
        versionId: existingVersion?.id,
        error,
      });
      return {
        slug: feed.slug,
        url,
        status: "new_version",
        contentHash: fetched.contentHash,
        versionLabel: existingVersion?.version_label ?? fetched.versionLabel,
        versionId: existingVersion?.id,
        error,
      };
    }
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
  let jobId: string | undefined;
  let status: PollOneResult["status"] = "new_version";

  if (opts.runPipeline !== false && opts.pipeline) {
    try {
      const report = await dispatchTenantPipeline(db, feed, opts, {
        tenantId: opts.tenantId,
        contentHash: fetched.contentHash,
        versionId,
        versionLabel: label,
      });
      if (report) {
        const dispatched = pipelineResult(report);
        changeId = dispatched.changeId;
        jobId = dispatched.jobId;
        status = dispatched.status;
      }
    } catch (e) {
      // Version stored; pipeline may fail if only 1 version or no consumers
      persistPollOutcome(db, feed, opts.tenantId, fetched, {
        contentHash: fetched.contentHash,
        versionLabel: label,
        status: "new_version",
        versionId,
        error: e instanceof Error ? e.message : String(e),
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

  persistPollOutcome(db, feed, opts.tenantId, fetched, {
    contentHash: fetched.contentHash,
    versionLabel: label,
    status,
    versionId,
    pipelineChangeId: changeId ?? jobId ?? null,
  });

  return {
    slug: feed.slug,
    url,
    status,
    contentHash: fetched.contentHash,
    versionLabel: label,
    versionId,
    changeId,
    jobId,
  };
}

export async function pollAllFeeds(opts: PollAllOptions): Promise<PollOneResult[]> {
  const db = opts.db ?? createDb();
  let feeds = listPollableFeeds(db);
  if (opts.slugs?.length) {
    const want = new Set(opts.slugs);
    feeds = feeds.filter((f) => want.has(f.slug));
  }
  if (opts.localOnly) {
    feeds = feeds.filter((f) => f.openapiUrl.startsWith("file:"));
  }

  return mapWithConcurrency(
    feeds,
    boundedConcurrency(opts.concurrency),
    (feed) => pollOneFeed(feed, { ...opts, db }),
  );
}
