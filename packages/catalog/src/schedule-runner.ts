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
import type { PollableFeed } from "./poll.js";

export type FeedScheduleExecution = {
  scheduleId: string;
  providerSlug: string;
  windowStartedAt: string;
  windowEndsAt: string;
  status: "succeeded" | "failed" | "already_claimed";
  poll?: PollOneResult;
  error?: string;
};

export type FeedScheduleRunOptions = {
  db: AppDb;
  tenantId: string;
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
  feeds: readonly PollableFeed[],
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

export async function runFeedSchedules(options: FeedScheduleRunOptions) {
  const at = options.at ?? nowIso();
  const intervalMs = options.defaultIntervalMs ?? 60 * 60 * 1_000;
  const staleAfterMs = options.defaultStaleAfterMs ?? intervalMs * 2;
  if (staleAfterMs < intervalMs) throw new Error("feed_schedule_stale_window_invalid");
  const feeds = [...(options.feeds ?? listPollableFeeds(options.db))];
  ensureSchedules(options.db, options.tenantId, feeds, at, intervalMs, staleAfterMs);
  getFeedScheduleHealth(options.db, at, options.tenantId);

  const feedBySlug = new Map(feeds.map((feed) => [feed.slug, feed]));
  const schedules = listFeedSchedules(options.db, options.tenantId).filter(
    (schedule) => schedule.enabled === 1,
  );
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
      if (!feed) {
        const error = "scheduled feed source is not configured";
        completeFeedScheduleWindow(options.db, {
          scheduleId: schedule.id,
          windowStartedAt: window.startedAt,
          succeeded: false,
          error,
          completedAt: at,
        });
        return {
          scheduleId: schedule.id,
          providerSlug: schedule.provider_slug,
          windowStartedAt: window.startedAt,
          windowEndsAt: window.endsAt,
          status: "failed",
          error,
        };
      }
      try {
        const poll = options.execute
          ? await options.execute(feed, schedule)
          : await pollOneFeed(feed, {
              db: options.db,
              tenantId: schedule.tenant_id,
              localOnly: options.localOnly,
              runPipeline: options.runPipeline,
              pipeline: options.pipeline,
            });
        const succeeded = !new Set<PollOneResult["status"]>([
          "error",
          "no_url",
          "skipped",
        ]).has(poll.status);
        const error = succeeded ? undefined : poll.error ?? `feed poll ${poll.status}`;
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
          error,
        };
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause);
        completeFeedScheduleWindow(options.db, {
          scheduleId: schedule.id,
          windowStartedAt: window.startedAt,
          succeeded: false,
          error,
          completedAt: at,
        });
        return {
          scheduleId: schedule.id,
          providerSlug: schedule.provider_slug,
          windowStartedAt: window.startedAt,
          windowEndsAt: window.endsAt,
          status: "failed",
          error,
        };
      }
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
