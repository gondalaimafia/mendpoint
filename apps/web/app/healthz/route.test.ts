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
});
