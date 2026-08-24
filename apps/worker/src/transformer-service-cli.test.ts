import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTransformerServiceCli } from "./transformer-service-cli.js";

const roots: string[] = [];
const testPrivateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" }).toString();
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); vi.unstubAllGlobals(); });

describe("Transformer service CLI", () => {
  it("fails closed without any startup network when disabled", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(runTransformerServiceCli({})).rejects.toThrow("transformer_multinode_service_disabled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects incomplete enabled configuration before network startup", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(runTransformerServiceCli({ MENDPOINT_REGAUGE_MULTINODE_ENABLED: "1" })).rejects.toThrow("transformer_multinode_worker_id_required");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an unsafe readiness bind address before network startup", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(runTransformerServiceCli({
      MENDPOINT_REGAUGE_MULTINODE_ENABLED: "1",
      MENDPOINT_REGAUGE_WORKER_ID: "worker-a",
      MENDPOINT_REGAUGE_TENANT_ID: "tenant-a",
      MENDPOINT_REGAUGE_CAMPAIGN_ID: "campaign-a",
      MENDPOINT_REGAUGE_PRIVATE_DATA_ROOT: "C:\\private",
      MENDPOINT_REGAUGE_CHECKPOINT_KEY: Buffer.alloc(32, 1).toString("base64"),
      MENDPOINT_REGAUGE_READINESS_HOST: "example.com",
    })).rejects.toThrow("transformer_multinode_readiness_host_invalid");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("boots with expired draft authority because expiry gates authorization only", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      result: null,
      serverTime: new Date().toISOString(),
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const root = mkdtempSync(join(tmpdir(), "transformer-expired-")); roots.push(root);
    const port = await freePort();
    const running = await runTransformerServiceCli({
      ...environment(root, port),
      MENDPOINT_REGAUGE_ACTIVATION_EXPIRES_AT: new Date(Date.now() - 1_000).toISOString(),
    });
    await vi.waitFor(async () => expect((await readReady(running.readinessUrl)).status).toBe(200));
    expect(fetch).toHaveBeenCalled();
    await running.close();
  });

  it("reports 503 after a failed authenticated probe and 200 only after coordinator and artifact probes succeed", async () => {
    const root = mkdtempSync(join(tmpdir(), "transformer-cli-")); roots.push(root);
    const port = await freePort();
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      if (calls === 2) await held;
      const result = calls >= 4 ? null : { ready: true };
      return new Response(JSON.stringify({ result, serverTime: new Date().toISOString() }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const running = await runTransformerServiceCli(environment(root, port));
    expect((await readReady(running.readinessUrl)).status).toBe(503);
    release();
    await vi.waitFor(async () => expect((await readReady(running.readinessUrl)).status).toBe(200));
    await running.close();
  });
});

function environment(root: string, port: number): NodeJS.ProcessEnv { return { MENDPOINT_REGAUGE_MULTINODE_ENABLED: "1", MENDPOINT_REGAUGE_WORKER_ID: "worker-a", MENDPOINT_REGAUGE_TENANT_ID: "tenant-a", MENDPOINT_REGAUGE_CAMPAIGN_ID: "campaign-a", MENDPOINT_REGAUGE_PRIVATE_DATA_ROOT: root, MENDPOINT_REGAUGE_CHECKPOINT_KEY: Buffer.alloc(32, 1).toString("base64"), MENDPOINT_REGAUGE_OPERATION_SECRET: Buffer.alloc(32, 2).toString("base64"), MENDPOINT_REGAUGE_INTERVAL_MS: "100", MENDPOINT_REGAUGE_READINESS_PORT: String(port), MENDPOINT_REGAUGE_COORDINATOR_URL: "https://coordinator.example/", MENDPOINT_REGAUGE_COORDINATOR_TOKEN: "x".repeat(32), MENDPOINT_REGAUGE_COORDINATOR_TIMEOUT_MS: "1000", MENDPOINT_REGAUGE_MAX_RESPONSE_BYTES: "4096", MENDPOINT_REGAUGE_ARTIFACT_BACKEND: "filesystem", MENDPOINT_REGAUGE_SHARED_ARTIFACT_ROOT: join(root, "artifacts"), MENDPOINT_REGAUGE_ENVIRONMENT: "test", MENDPOINT_REGAUGE_LEASE_MS: "60000", MENDPOINT_REGAUGE_EXECUTOR_DIGEST: `sha256:${"e".repeat(64)}`, MENDPOINT_REGAUGE_EVIDENCE_REFS: "evidence:runner", MENDPOINT_REGAUGE_GATE: "gate", GITHUB_MODE: "real", GITHUB_APP_ID: "42", GITHUB_APP_PRIVATE_KEY: testPrivateKey }; }
async function freePort(): Promise<number> { const server = createServer(); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; await new Promise<void>((resolve) => server.close(() => resolve())); return port; }
async function readReady(url: string): Promise<{ status: number; body: unknown }> { return new Promise((resolve, reject) => { import("node:http").then(({ get }) => get(url, (response) => { const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(Buffer.from(chunk))); response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) })); }).on("error", reject), reject); }); }
