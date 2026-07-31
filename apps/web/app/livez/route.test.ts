import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /livez", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MENDPOINT_WORKER_HEARTBEAT_PATH;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("requires API and worker liveness without depending on recovery state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-livez-"));
    dirs.push(dir);
    const heartbeatPath = join(dir, "worker.json");
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH = heartbeatPath;
    writeFileSync(
      heartbeatPath,
      JSON.stringify({
        ok: true,
        recordedAt: new Date().toISOString(),
        feedPollOk: false,
        recovery: { deadLetter: 2, expiredLeases: 0 },
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "mendpoint",
      checks: { api: true, worker: { ok: true } },
    });
  });
});
