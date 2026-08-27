import { createHash } from "node:crypto";
import {
  claimFeedScheduleWindow,
  completeFeedScheduleWindow,
  getFeedScheduleHealth,
  listFeedSchedules,
  upsertFeedSchedule,
  type AppDb,
  type FeedScheduleRow,
} from "@mendpoint/db";
import { nowIso } from "@mendpoint/shared";
import { boundedConcurrency, mapWithConcurrency } from "./concurrency.js";
import {
  listPollableFeeds,
  pollOneFeed,
  type FeedPipelineDispatchResult,
  type FeedPipelineContext,
  type PollOneResult,
} from "./run-poll.js";
import {
  canonicalizeReleasePollConfiguration,
  pollReleaseSource,
  type CanonicalReleasePollConfigurationV1,
  type ReleasePollConfigurationV1,
  type ReleasePollResult,
} from "./release-poll.js";
import type { ReleaseIngestionStore } from "./release-ingestion.js";
import type { FetchFeedOptions, FetchOpenApiResult, PollableFeed } from "./poll.js";

export type FeedScheduleSourceOutcome<T> =
  | Readonly<{ status: "succeeded"; result: T }>
  | Readonly<{ status: "failed"; error: string; result?: T }>
  | Readonly<{ status: "not_configured" }>;

export type FeedScheduleExecution = {
  scheduleId: string;
  providerSlug: string;
  windowStartedAt: string;
  windowEndsAt: string;
  status: "succeeded" | "failed" | "already_claimed";
  poll?: PollOneResult;
  openApiOutcome?: FeedScheduleSourceOutcome<PollOneResult>;
  releaseOutcome?: FeedScheduleSourceOutcome<ReleasePollResult>;
  error?: string;
};

export type FeedScheduleRunOptions = {
  db: AppDb;
  /** Omit to service all existing tenant schedules without creating defaults. */
  tenantId?: string;
  at?: string;
  defaultIntervalMs?: number;
  defaultStaleAfterMs?: number;
  maxConcurrency?: number;
  localOnly?: boolean;
  runPipeline?: boolean;
  pipeline?: (
    slug: string,
    db: AppDb,
    context: FeedPipelineContext,
  ) => Promise<FeedPipelineDispatchResult>;
  execute?: (feed: PollableFeed, schedule: FeedScheduleRow) => Promise<PollOneResult>;
  feeds?: readonly PollableFeed[];
  releaseStore?: ReleaseIngestionStore;
  releaseFeeds?: readonly ReleasePollConfigurationV1[];
  releaseFetchOptions?: FetchFeedOptions;
  releaseExecute?: (
    store: ReleaseIngestionStore,
    config: ReleasePollConfigurationV1,
    schedule: FeedScheduleRow,
    at: string,
  ) => Promise<ReleasePollResult>;
  sourceDocumentLoader?: (
    url: string,
    monorepoRoot: string,
  ) => Promise<FetchOpenApiResult>;
};

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32)}`;
}

function scheduleWindow(schedule: FeedScheduleRow, at: string) {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new Error("feed_schedule_run_time_invalid");
  const startMs = Math.floor(atMs / schedule.interval_ms) * schedule.interval_ms;
  return {
    startedAt: new Date(startMs).toISOString(),
    endsAt: new Date(startMs + schedule.interval_ms).toISOString(),
  };
}

function ensureSchedules(
  db: AppDb,
  tenantId: string,
  feeds: readonly Readonly<{ slug: string }>[],
  at: string,
  intervalMs: number,
  staleAfterMs: number,
) {
  const existing = new Set(
    listFeedSchedules(db, tenantId).map((schedule) => schedule.provider_slug),
  );
  for (const feed of feeds) {
    if (existing.has(feed.slug)) continue;
    upsertFeedSchedule(db, {
      id: stableId("feed-schedule", tenantId, feed.slug),
      tenantId,
      providerSlug: feed.slug,
      intervalMs,
      staleAfterMs,
      createdAt: at,
    });
  }
}

function openApiSucceeded(poll: PollOneResult): boolean {
  return !new Set<PollOneResult["status"]>([
    "error",
    "no_url",
    "skipped",
  ]).has(poll.status);
}

function releaseScope(tenantId: string, providerSlug: string): string {
  return `${tenantId}\n${providerSlug}`;
}

function releaseResultMatchesConfiguration(
  result: ReleasePollResult,
  config: CanonicalReleasePollConfigurationV1,
): boolean {
  return (
    result.contractVersion === config.contractVersion &&
    result.tenantId === config.tenantId &&
    result.providerSlug === config.provider.slug &&
    result.adapter === config.adapter &&
    result.sourceUrl === config.source.url &&
    result.sourceMaxBytes === (config.source.maxBytes ?? null)
  );
}

export async function runFeedSchedules(options: FeedScheduleRunOptions) {
  const at = options.at ?? nowIso();
  const intervalMs = options.defaultIntervalMs ?? 60 * 60 * 1_000;
  const staleAfterMs = options.defaultStaleAfterMs ?? intervalMs * 2;
  if (staleAfterMs < intervalMs) throw new Error("feed_schedule_stale_window_invalid");
  const feeds = [...(options.feeds ?? listPollableFeeds(options.db))];
  const releaseByScope = new Map<string, CanonicalReleasePollConfigurationV1>();
  for (const config of options.releaseFeeds ?? []) {
    const snapshot = canonicalizeReleasePollConfiguration(config);
    const scope = releaseScope(snapshot.tenantId, snapshot.provider.slug);
    if (releaseByScope.has(scope)) throw new Error("release_poll_configuration_duplicate");
    releaseByScope.set(scope, snapshot);
  }
  if (options.tenantId) {
    const providerSlugs = new Set(feeds.map((feed) => feed.slug));
    for (const config of releaseByScope.values()) {
      if (config.tenantId === options.tenantId) providerSlugs.add(config.provider.slug);
    }
    ensureSchedules(
      options.db,
      options.tenantId,
      [...providerSlugs].map((slug) => ({ slug })),
      at,
      intervalMs,
      staleAfterMs,
    );
  }
  getFeedScheduleHealth(options.db, at, options.tenantId);

  const feedBySlug = new Map(feeds.map((feed) => [feed.slug, feed]));
  const schedules = listFeedSchedules(options.db, options.tenantId).filter(
    (schedule) => schedule.enabled === 1,
  );
  const sourceFetches = new Map<string, Promise<FetchOpenApiResult>>();
  const executions = await mapWithConcurrency(
    schedules,
    boundedConcurrency(options.maxConcurrency),
    async (schedule): Promise<FeedScheduleExecution> => {
      const window = scheduleWindow(schedule, at);
      const claimed = claimFeedScheduleWindow(options.db, {
        id: stableId("feed-window", schedule.id, window.startedAt),
        scheduleId: schedule.id,
        windowStartedAt: window.startedAt,
        windowEndsAt: window.endsAt,
        attemptedAt: at,
      });
      if (!claimed) {
        return {
          scheduleId: schedule.id,
          providerSlug: schedule.provider_slug,
          windowStartedAt: window.startedAt,
          windowEndsAt: window.endsAt,
          status: "already_claimed",
        };
      }
      const feed = feedBySlug.get(schedule.provider_slug);
      const releaseConfig = releaseByScope.get(releaseScope(
        schedule.tenant_id,
        schedule.provider_slug,
      ));
      let poll: PollOneResult | undefined;
      let openApiOutcome: FeedScheduleSourceOutcome<PollOneResult>;
      try {
        if (!feed && releaseConfig) {
          openApiOutcome = Object.freeze({ status: "not_configured" as const });
        } else if (!feed) {
          throw new Error("scheduled feed source is not configured");
        } else {
          poll = options.execute
            ? await options.execute(feed, schedule)
            : await pollOneFeed(feed, {
                db: options.db,
                tenantId: schedule.tenant_id,
                localOnly: options.localOnly,
                runPipeline: options.runPipeline,
                pipeline: options.pipeline,
                sourceFetches,
                sourceDocumentLoader: options.sourceDocumentLoader,
              });
          openApiOutcome = openApiSucceeded(poll)
            ? Object.freeze({ status: "succeeded" as const, result: poll })
            : Object.freeze({
                status: "failed" as const,
                error: poll.error ?? `feed poll ${poll.status}`,
                result: poll,
              });
        }
      } catch (cause) {
        openApiOutcome = Object.freeze({
          status: "failed" as const,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }

      let releaseOutcome: FeedScheduleSourceOutcome<ReleasePollResult> = Object.freeze({
        status: "not_configured" as const,
      });
      if (releaseConfig) {
        if (!options.releaseStore) {
          releaseOutcome = Object.freeze({
            status: "failed" as const,
            error: "release ingestion store is not configured",
          });
        } else {
          try {
            const result = options.releaseExecute
              ? await options.releaseExecute(options.releaseStore, releaseConfig, schedule, at)
              : await pollReleaseSource(options.releaseStore, releaseConfig, {
                  at,
                  fetchOptions: options.releaseFetchOptions,
                });
            if (result.status !== "failed" && !releaseResultMatchesConfiguration(result, releaseConfig)) {
              releaseOutcome = Object.freeze({
                status: "failed" as const,
                error: "release_poll_result_identity_mismatch",
                result,
              });
            } else {
              releaseOutcome = result.status === "failed"
                ? Object.freeze({ status: "failed" as const, error: result.error, result })
                : Object.freeze({ status: "succeeded" as const, result });
            }
          } catch (cause) {
            releaseOutcome = Object.freeze({
              status: "failed" as const,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          }
        }
      }

      const openApiError = openApiOutcome.status === "failed" ? openApiOutcome.error : undefined;
      const releaseError = releaseOutcome.status === "failed" ? releaseOutcome.error : undefined;
      const errors = [
        openApiError
          ? releaseConfig ? `OpenAPI: ${openApiError}` : openApiError
          : undefined,
        releaseError ? `release: ${releaseError}` : undefined,
      ].filter((error): error is string => Boolean(error));
      const succeeded = errors.length === 0;
      const error = succeeded ? undefined : errors.join("; ");
      completeFeedScheduleWindow(options.db, {
        scheduleId: schedule.id,
        windowStartedAt: window.startedAt,
        succeeded,
        error,
        completedAt: at,
      });
      return {
        scheduleId: schedule.id,
        providerSlug: schedule.provider_slug,
        windowStartedAt: window.startedAt,
        windowEndsAt: window.endsAt,
        status: succeeded ? "succeeded" : "failed",
        poll,
        openApiOutcome,
        releaseOutcome,
        error,
      };
    },
  );

  const health = getFeedScheduleHealth(options.db, at, options.tenantId);
  return {
    at,
    maxConcurrency: boundedConcurrency(options.maxConcurrency),
    claimed: executions.filter((execution) => execution.status !== "already_claimed").length,
    succeeded: executions.filter((execution) => execution.status === "succeeded").length,
    failed: executions.filter((execution) => execution.status === "failed").length,
    alreadyClaimed: executions.filter((execution) => execution.status === "already_claimed").length,
    executions,
    health,
  };
}
