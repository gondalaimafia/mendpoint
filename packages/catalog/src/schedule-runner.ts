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
  duplicateReleasePollConfigurationResult,
  invalidReleasePollExecutorResult,
  parseReleasePollConfiguration,
  pollReleaseSource,
  type CanonicalReleasePollConfigurationV1,
  type ParsedReleasePollConfiguration,
  type ReleasePollConfigurationV1,
  type ReleasePollResult,
  type ValidReleasePollResult,
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
  return JSON.stringify([tenantId, providerSlug]);
}

function expectedReleaseSourceUrl(config: CanonicalReleasePollConfigurationV1): string {
  const canonical = config.source.url;
  const digest = createHash("sha256").update(canonical).digest("hex");
  return `${new URL(canonical).origin}/.well-known/mendpoint/release-source/${digest}`;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function parseArtifactReferences(value: unknown) {
  if (!Array.isArray(value)) return null;
  const parsed = [];
  for (const reference of value) {
    const snapshot = Object.freeze({
      artifactId: reference?.artifactId,
      contentSha256: reference?.contentSha256,
    });
    if (
      !exactRecord(reference, ["artifactId", "contentSha256"]) ||
      typeof snapshot.artifactId !== "string" ||
      !/^rel_[a-f0-9]{32}$/.test(snapshot.artifactId) ||
      typeof snapshot.contentSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(snapshot.contentSha256)
    ) return null;
    parsed.push(snapshot as { artifactId: string; contentSha256: string });
  }
  return Object.freeze(parsed);
}

function parseDispatchReferences(value: unknown) {
  if (!Array.isArray(value)) return null;
  const parsed = [];
  for (const reference of value) {
    const snapshot = Object.freeze({
      dispatchId: reference?.dispatchId,
      artifactId: reference?.artifactId,
      artifactContentSha256: reference?.artifactContentSha256,
    });
    if (
      !exactRecord(reference, ["artifactContentSha256", "artifactId", "dispatchId"]) ||
      typeof snapshot.dispatchId !== "string" ||
      !/^rdi_[a-f0-9]{32}$/.test(snapshot.dispatchId) ||
      typeof snapshot.artifactId !== "string" ||
      !/^rel_[a-f0-9]{32}$/.test(snapshot.artifactId) ||
      typeof snapshot.artifactContentSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(snapshot.artifactContentSha256)
    ) return null;
    parsed.push(snapshot as {
      dispatchId: string;
      artifactId: string;
      artifactContentSha256: string;
    });
  }
  return Object.freeze(parsed);
}

function validateReleaseExecutorResult(
  value: unknown,
  config: CanonicalReleasePollConfigurationV1,
): ValidReleasePollResult | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    const status = candidate.status;
    if (status !== "ingested" && status !== "unchanged" && status !== "failed") return null;
    const keys = [
      "adapter", "artifacts", "contractVersion", "dispatches", "inserted", "providerSlug",
      "sourceMaxBytes", "sourceUrl", "status", "tenantId",
      ...(status === "failed" ? ["error"] : []),
    ];
    if (!exactRecord(candidate, keys)) return null;
    const artifacts = parseArtifactReferences(candidate.artifacts);
    const dispatches = parseDispatchReferences(candidate.dispatches);
    const snapshot = Object.freeze({
      status,
      contractVersion: candidate.contractVersion,
      tenantId: candidate.tenantId,
      providerSlug: candidate.providerSlug,
      adapter: candidate.adapter,
      sourceUrl: candidate.sourceUrl,
      sourceMaxBytes: candidate.sourceMaxBytes,
      inserted: candidate.inserted,
      artifacts,
      dispatches,
      error: status === "failed" ? candidate.error : undefined,
    });
    if (
      snapshot.contractVersion !== config.contractVersion ||
      snapshot.tenantId !== config.tenantId ||
      snapshot.providerSlug !== config.provider.slug ||
      snapshot.adapter !== config.adapter ||
      snapshot.sourceUrl !== expectedReleaseSourceUrl(config) ||
      snapshot.sourceMaxBytes !== (config.source.maxBytes ?? null) ||
      !Number.isSafeInteger(snapshot.inserted) || Number(snapshot.inserted) < 0 ||
      !artifacts || !dispatches
    ) return null;
    if (status === "failed") {
      if (
        snapshot.inserted !== 0 || typeof snapshot.error !== "string" ||
        !snapshot.error.trim() || snapshot.error.length > 1024
      ) return null;
      return Object.freeze({
        status,
        contractVersion: snapshot.contractVersion,
        tenantId: snapshot.tenantId,
        providerSlug: snapshot.providerSlug,
        adapter: snapshot.adapter,
        sourceUrl: snapshot.sourceUrl,
        sourceMaxBytes: snapshot.sourceMaxBytes,
        inserted: 0,
        artifacts,
        dispatches,
        error: snapshot.error,
      }) as ValidReleasePollResult;
    } else if (status === "unchanged" && snapshot.inserted !== 0) {
      return null;
    } else if (status === "ingested" && Number(snapshot.inserted) < 1) {
      return null;
    }
    return Object.freeze({
      status,
      contractVersion: snapshot.contractVersion,
      tenantId: snapshot.tenantId,
      providerSlug: snapshot.providerSlug,
      adapter: snapshot.adapter,
      sourceUrl: snapshot.sourceUrl,
      sourceMaxBytes: snapshot.sourceMaxBytes,
      inserted: snapshot.inserted,
      artifacts,
      dispatches,
    }) as ValidReleasePollResult;
  } catch {
    return null;
  }
}

export async function runFeedSchedules(options: FeedScheduleRunOptions) {
  const at = options.at ?? nowIso();
  const intervalMs = options.defaultIntervalMs ?? 60 * 60 * 1_000;
  const staleAfterMs = options.defaultStaleAfterMs ?? intervalMs * 2;
  if (staleAfterMs < intervalMs) throw new Error("feed_schedule_stale_window_invalid");
  const feeds = [...(options.feeds ?? listPollableFeeds(options.db))];
  const releaseByScope = new Map<string, ParsedReleasePollConfiguration>();
  const releaseConfigurationFailures: ReleasePollResult[] = [];
  for (const config of options.releaseFeeds ?? []) {
    const parsed = parseReleasePollConfiguration(config);
    const binding = parsed.status === "valid"
      ? { tenantId: parsed.config.tenantId, providerSlug: parsed.config.provider.slug }
      : parsed.result.configurationBinding;
    if (!binding) {
      if (parsed.status === "invalid") releaseConfigurationFailures.push(parsed.result);
      continue;
    }
    const scope = releaseScope(binding.tenantId, binding.providerSlug);
    releaseByScope.set(scope, releaseByScope.has(scope)
      ? Object.freeze({
          status: "invalid" as const,
          result: duplicateReleasePollConfigurationResult(binding),
        })
      : parsed);
  }
  if (options.tenantId) {
    const providerSlugs = new Set(feeds.map((feed) => feed.slug));
    for (const parsed of releaseByScope.values()) {
      const binding = parsed.status === "valid"
        ? { tenantId: parsed.config.tenantId, providerSlug: parsed.config.provider.slug }
        : parsed.result.configurationBinding;
      if (binding?.tenantId === options.tenantId) providerSlugs.add(binding.providerSlug);
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
      const releaseConfiguration = releaseByScope.get(releaseScope(
        schedule.tenant_id,
        schedule.provider_slug,
      ));
      let poll: PollOneResult | undefined;
      let openApiOutcome: FeedScheduleSourceOutcome<PollOneResult>;
      try {
        if (!feed && releaseConfiguration) {
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
      if (releaseConfiguration?.status === "invalid") {
        releaseOutcome = Object.freeze({
          status: "failed" as const,
          error: releaseConfiguration.result.error,
          result: releaseConfiguration.result,
        });
      } else if (releaseConfiguration) {
        const releaseConfig = releaseConfiguration.config;
        if (!options.releaseStore) {
          releaseOutcome = Object.freeze({
            status: "failed" as const,
            error: "release ingestion store is not configured",
          });
        } else {
          try {
            const untrustedResult: unknown = options.releaseExecute
              ? await options.releaseExecute(options.releaseStore, releaseConfig, schedule, at)
              : await pollReleaseSource(options.releaseStore, releaseConfig, {
                  at,
                  fetchOptions: options.releaseFetchOptions,
                });
            const result = validateReleaseExecutorResult(untrustedResult, releaseConfig);
            if (!result) {
              const invalid = invalidReleasePollExecutorResult({
                tenantId: releaseConfig.tenantId,
                providerSlug: releaseConfig.provider.slug,
              });
              releaseOutcome = Object.freeze({
                status: "failed" as const,
                error: invalid.error,
                result: invalid,
              });
            } else {
            switch (result.status) {
              case "failed":
                releaseOutcome = Object.freeze({
                  status: "failed" as const,
                  error: result.error,
                  result,
                });
                break;
              case "ingested":
              case "unchanged":
                releaseOutcome = Object.freeze({ status: "succeeded" as const, result });
                break;
            }
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
          ? releaseConfiguration ? `OpenAPI: ${openApiError}` : openApiError
          : undefined,
        releaseError ? `release: ${releaseError}` : undefined,
      ].filter((error): error is string => Boolean(error));
      const succeeded = errors.length === 0;
      const error = succeeded ? undefined : errors.join("; ");
      const completed = completeFeedScheduleWindow(options.db, {
        scheduleId: schedule.id,
        windowStartedAt: window.startedAt,
        succeeded,
        error,
        completedAt: at,
      });
      if (!completed) {
        return {
          scheduleId: schedule.id,
          providerSlug: schedule.provider_slug,
          windowStartedAt: window.startedAt,
          windowEndsAt: window.endsAt,
          status: "failed",
          poll,
          openApiOutcome,
          releaseOutcome,
          error: "release_poll_schedule_authority_lost",
        };
      }
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

  const durableHealth = getFeedScheduleHealth(options.db, at, options.tenantId);
  const health = releaseConfigurationFailures.length === 0
    ? durableHealth
    : {
        ...durableHealth,
        status: "degraded" as const,
        counts: {
          ...durableHealth.counts,
          failed: durableHealth.counts.failed + releaseConfigurationFailures.length,
        },
        configurationFailures: Object.freeze([...releaseConfigurationFailures]),
      };
  return {
    at,
    maxConcurrency: boundedConcurrency(options.maxConcurrency),
    claimed: executions.filter((execution) => execution.status !== "already_claimed").length,
    succeeded: executions.filter((execution) => execution.status === "succeeded").length,
    failed: executions.filter((execution) => execution.status === "failed").length +
      releaseConfigurationFailures.length,
    alreadyClaimed: executions.filter((execution) => execution.status === "already_claimed").length,
    executions,
    releaseConfigurationFailures: Object.freeze([...releaseConfigurationFailures]),
    health,
  };
}
