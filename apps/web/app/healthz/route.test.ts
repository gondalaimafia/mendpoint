import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const dirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("public deployment health", () => {
  it("requires API readiness, API authentication, and a fresh worker heartbeat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-health-"));
    dirs.push(dir);
    const heartbeatPath = join(dir, "state", "worker-heartbeat.json");
    mkdirSync(join(dir, "state"));
    writeFileSync(
      heartbeatPath,
      JSON.stringify({
        ok: true,
        recordedAt: new Date().toISOString(),
        feedPollingEnabled: false,
        feedPollOk: true,
        releasePollingConfigured: false,
        releasePollConfigurationCount: 0,
        feedScheduleStatus: "not_started",
        releaseConfigurationStatus: "not_configured",
        releaseConfigurationFailed: 0,
        jobs: { failed: 0 },
      }),
    );
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH = heartbeatPath;
    process.env.MENDPOINT_API_KEY = `me_${"a".repeat(40)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      checks: { worker: {
        releasePollingConfigured: false,
        releasePollConfigurationCount: 0,
        feedScheduleStatus: "not_started",
        releaseConfigurationStatus: "not_configured",
        releaseConfigurationFailed: 0,
      } },
    });
  });

  it("exposes release scheduler degradation while feedPollOk remains the readiness gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-health-release-poll-"));
    dirs.push(dir);
    const heartbeatPath = join(dir, "worker-heartbeat.json");
    writeFileSync(heartbeatPath, JSON.stringify({
      ok: true,
      recordedAt: new Date().toISOString(),
      feedPollingEnabled: true,
      feedPollOk: false,
      releasePollingConfigured: true,
      releasePollConfigurationCount: 2,
      feedScheduleStatus: "degraded",
      releaseConfigurationStatus: "degraded",
      releaseConfigurationFailed: 1,
      jobs: { failed: 0 },
    }));
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH = heartbeatPath;
    process.env.MENDPOINT_API_KEY = `me_${"a".repeat(40)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      checks: { worker: {
        ok: false,
        releasePollingConfigured: true,
        releasePollConfigurationCount: 2,
        feedScheduleStatus: "degraded",
        releaseConfigurationStatus: "degraded",
        releaseConfigurationFailed: 1,
      } },
    });
  });

  it.each([
    ["releasePollingConfigured", "yes"],
    ["releasePollConfigurationCount", -1],
    ["feedScheduleStatus", "unknown"],
    ["releaseConfigurationStatus", "unknown"],
    ["releaseConfigurationFailed", 1.5],
    ["feedScheduleCount", "1"],
  ])("fails closed when present heartbeat field %s is malformed", async (field, value) => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-health-release-malformed-"));
    dirs.push(dir);
    const heartbeatPath = join(dir, "worker-heartbeat.json");
    writeFileSync(heartbeatPath, JSON.stringify({
      ok: true,
      recordedAt: new Date().toISOString(),
      feedPollingEnabled: false,
      feedPollOk: true,
      releasePollingConfigured: false,
      releasePollConfigurationCount: 0,
      feedScheduleStatus: "not_started",
      releaseConfigurationStatus: "not_configured",
      releaseConfigurationFailed: 0,
      [field]: value,
    }));
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH = heartbeatPath;
    process.env.MENDPOINT_API_KEY = `me_${"a".repeat(40)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      checks: { worker: { ok: false } },
    });
  });

  it("accepts a legacy heartbeat when the release scheduler fields are absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-health-release-legacy-"));
    dirs.push(dir);
    const heartbeatPath = join(dir, "worker-heartbeat.json");
    writeFileSync(heartbeatPath, JSON.stringify({
      ok: true,
      recordedAt: new Date().toISOString(),
      feedPollingEnabled: false,
      feedPollOk: true,
    }));
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH = heartbeatPath;
    process.env.MENDPOINT_API_KEY = `me_${"a".repeat(40)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const response = await GET();
    expect(response.status).toBe(200);
  });

  it("fails closed before configured release polling proves its first healthy run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-health-release-not-started-"));
    dirs.push(dir);
    const heartbeatPath = join(dir, "worker-heartbeat.json");
    writeFileSync(heartbeatPath, JSON.stringify({
      ok: true,
      recordedAt: new Date().toISOString(),
      feedPollingEnabled: true,
      feedPollOk: true,
      releasePollingConfigured: true,
      releasePollConfigurationCount: 1,
      feedScheduleStatus: "not_started",
      releaseConfigurationStatus: "not_started",
      releaseConfigurationFailed: 0,
      jobs: { failed: 0 },
    }));
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH = heartbeatPath;
    process.env.MENDPOINT_API_KEY = `me_${"a".repeat(40)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      checks: { worker: {
        ok: false,
        releasePollingConfigured: true,
        feedScheduleStatus: "not_started",
        releaseConfigurationStatus: "not_started",
      } },
    });
  });

  it("returns 503 after configured release polling attempts work without a durable success", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-health-release-first-success-"));
    dirs.push(dir);
    const heartbeatPath = join(dir, "worker-heartbeat.json");
    writeFileSync(heartbeatPath, JSON.stringify({
      ok: true,
      recordedAt: new Date().toISOString(),
      feedPollingEnabled: true,
      feedPollOk: false,
      releasePollingConfigured: true,
      releasePollConfigurationCount: 1,
      feedScheduleStatus: "degraded",
      releaseConfigurationStatus: "degraded",
      releaseConfigurationFailed: 0,
      jobs: { failed: 0 },
    }));
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH = heartbeatPath;
    process.env.MENDPOINT_API_KEY = `me_${"a".repeat(40)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      checks: { worker: {
        ok: false,
        releasePollingConfigured: true,
        feedScheduleStatus: "degraded",
        releaseConfigurationStatus: "degraded",
        releaseConfigurationFailed: 0,
      } },
    });
  });

  it("fails when the worker heartbeat is stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-health-stale-"));
    dirs.push(dir);
    const heartbeatPath = join(dir, "worker-heartbeat.json");
    writeFileSync(
      heartbeatPath,
      JSON.stringify({
        ok: true,
        recordedAt: "2020-01-01T00:00:00.000Z",
        feedPollingEnabled: false,
        feedPollOk: true,
        jobs: { failed: 0 },
      }),
    );
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH = heartbeatPath;
    process.env.MENDPOINT_API_KEY = `me_${"a".repeat(40)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      checks: { worker: { ok: false } },
    });
  });

  it("keeps dead letter recovery visible as an operational failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-health-dead-letter-"));
    dirs.push(dir);
    const heartbeatPath = join(dir, "worker-heartbeat.json");
    writeFileSync(
      heartbeatPath,
      JSON.stringify({
        ok: true,
        recordedAt: new Date().toISOString(),
        feedPollingEnabled: false,
        feedPollOk: true,
        jobs: { failed: 0 },
        recovery: { due: 0, scheduled: 0, running: 0, deadLetter: 1, expiredLeases: 0 },
      }),
    );
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH = heartbeatPath;
    process.env.MENDPOINT_API_KEY = `me_${"a".repeat(40)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      checks: {
        worker: {
          ok: false,
          recovery: { deadLetter: 1 },
        },
      },
    });
  });

  it("fails when customer Warden discovery is disabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-health-customer-feed-"));
    dirs.push(dir);
    const heartbeatPath = join(dir, "worker-heartbeat.json");
    writeFileSync(
      heartbeatPath,
      JSON.stringify({
        ok: true,
        recordedAt: new Date().toISOString(),
        feedPollingEnabled: false,
        feedPollOk: true,
        jobs: { failed: 0 },
      }),
    );
    process.env.MENDPOINT_DEPLOYMENT_PROFILE = "customer";
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH = heartbeatPath;
    process.env.MENDPOINT_API_KEY = `me_${"a".repeat(40)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      checks: {
        worker: {
          ok: false,
          feedPollingEnabled: false,
          reason: "customer_feed_polling_disabled",
        },
      },
    });
  });

  it("requires a configured schedule and an observed successful customer feed poll", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-health-customer-feed-proof-"));
    dirs.push(dir);
    const heartbeatPath = join(dir, "worker-heartbeat.json");
    const heartbeat = (feedScheduleCount: number, feedLastSuccessAt?: string) => ({
      ok: true,
      recordedAt: new Date().toISOString(),
      feedPollingEnabled: true,
      feedPollOk: true,
      feedScheduleCount,
      feedStaleAfterMs: 60_000,
      ...(feedLastSuccessAt ? { feedLastSuccessAt } : {}),
      jobs: { failed: 0 },
    });
    process.env.MENDPOINT_DEPLOYMENT_PROFILE = "customer";
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH = heartbeatPath;
    process.env.MENDPOINT_API_KEY = `me_${"a".repeat(40)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    writeFileSync(heartbeatPath, JSON.stringify(heartbeat(0)));
    let response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      checks: { worker: { reason: "customer_feed_not_observed", feedScheduleCount: 0 } },
    });

    writeFileSync(heartbeatPath, JSON.stringify(heartbeat(1)));
    response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      checks: { worker: { reason: "customer_feed_not_observed", feedScheduleCount: 1 } },
    });

    const observedAt = new Date().toISOString();
    writeFileSync(heartbeatPath, JSON.stringify(heartbeat(1, observedAt)));
    response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      checks: {
        worker: {
          ok: true,
          feedScheduleCount: 1,
          feedLastSuccessAt: observedAt,
        },
      },
    });
  });

  it("rejects stale, future, and over-bound in-progress customer feed evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-health-customer-feed-freshness-"));
    dirs.push(dir);
    const heartbeatPath = join(dir, "worker-heartbeat.json");
    const now = Date.now();
    const heartbeat = (feedLastSuccessAt: string, feedPollStartedAt?: string) => ({
      ok: true,
      recordedAt: new Date(now).toISOString(),
      feedPollingEnabled: true,
      feedPollOk: true,
      feedScheduleCount: 1,
      feedLastSuccessAt,
      feedStaleAfterMs: 60_000,
      ...(feedPollStartedAt ? { feedPollStartedAt } : {}),
      jobs: { failed: 0 },
    });
    process.env.MENDPOINT_DEPLOYMENT_PROFILE = "customer";
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH = heartbeatPath;
    process.env.MENDPOINT_API_KEY = `me_${"a".repeat(40)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    for (const value of [
      heartbeat(new Date(now - 60_001).toISOString()),
      heartbeat(new Date(now + 60_001).toISOString()),
      heartbeat(
        new Date(now - 1_000).toISOString(),
        new Date(now - 60_001).toISOString(),
      ),
    ]) {
      writeFileSync(heartbeatPath, JSON.stringify(value));
      const response = await GET();
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        checks: { worker: { reason: "customer_feed_not_fresh" } },
      });
    }
  });

  it("fails while an enabled Transformer infrastructure loop is unhealthy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-health-transformer-infra-"));
    dirs.push(dir);
    const heartbeatPath = join(dir, "worker-heartbeat.json");
    const observedAt = new Date().toISOString();
    writeFileSync(
      heartbeatPath,
      JSON.stringify({
        ok: true,
        recordedAt: observedAt,
        feedPollingEnabled: false,
        feedPollOk: true,
        jobs: { failed: 0 },
        transformer: {
          enabled: true,
          active: false,
          lastRunAt: observedAt,
          lastSuccessAt: observedAt,
          infrastructureError: "transformer_lane_internal_error",
          expired: 0,
          attempted: 0,
          completed: 0,
          failed: 0,
          stale: 0,
          idle: 0,
          errors: [],
        },
      }),
    );
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH = heartbeatPath;
    process.env.MENDPOINT_API_KEY = `me_${"a".repeat(40)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      checks: {
        worker: {
          ok: false,
          transformer: {
            enabled: true,
            infrastructureError: "transformer_lane_internal_error",
          },
        },
      },
    });
  });

  it("keeps handled Transformer customer failures separate from worker health", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-health-transformer-customer-"));
    dirs.push(dir);
    const heartbeatPath = join(dir, "worker-heartbeat.json");
    const observedAt = new Date().toISOString();
    writeFileSync(
      heartbeatPath,
      JSON.stringify({
        ok: true,
        recordedAt: observedAt,
        feedPollingEnabled: false,
        feedPollOk: true,
        jobs: { failed: 0 },
        transformer: {
          enabled: true,
          active: false,
          lastRunAt: observedAt,
          lastSuccessAt: observedAt,
          expired: 0,
          attempted: 1,
          completed: 0,
          failed: 1,
          stale: 0,
          idle: 0,
          errors: ["recipe_execution_verification_failed:package-engine"],
        },
      }),
    );
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH = heartbeatPath;
    process.env.MENDPOINT_API_KEY = `me_${"a".repeat(40)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      checks: {
        worker: {
          ok: true,
          transformer: {
            enabled: true,
            failed: 1,
          },
        },
      },
    });
  });
});
