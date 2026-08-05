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
        jobs: { failed: 0 },
      }),
    );
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH = heartbeatPath;
    process.env.MENDPOINT_API_KEY = `me_${"a".repeat(40)}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
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
