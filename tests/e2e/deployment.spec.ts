import { expect, test, type APIRequestContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const image = process.env.MENDPOINT_E2E_IMAGE ?? "mendpoint-fly:e2e";
const webOrigin = process.env.MENDPOINT_E2E_WEB_URL ?? "http://localhost:3100";
const webPort = new URL(webOrigin).port || "3100";
const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
const container = `mendpoint-e2e-${suffix}`;
const volume = `mendpoint-e2e-data-${suffix}`;
const apiKey = `me_${"a".repeat(40)}`;
const webToken = "e2e-web-access-token";
const webhookSecret = "e2e-webhook-secret";
const tenantId = "tenant_default";
const verifierHash = createHash("sha256")
  .update(readFileSync(resolve("fixtures/consumers/shop-app/check.mjs")))
  .digest("hex");

type Json = Record<string, unknown>;

function docker(args: string[], options: { allowFailure?: boolean } = {}): string {
  try {
    return execFileSync("docker", args, {
      cwd: resolve("."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (options.allowFailure) return "";
    const detail = error as { stdout?: Buffer | string; stderr?: Buffer | string };
    throw new Error(
      `docker ${args.join(" ")} failed\n${String(detail.stdout ?? "")}\n${String(detail.stderr ?? "")}`,
    );
  }
}

function startRuntime(workerIntervalMs: number): void {
  const variables: Record<string, string> = {
    AGENTIC_REPAIR: "1",
    API_AUTH: "required",
    CORS_ORIGINS: webOrigin,
    GITHUB_MODE: "mock",
    GITHUB_WEBHOOK_SECRET: webhookSecret,
    MENDPOINT_API_KEY: apiKey,
    MENDPOINT_APPROVED_VERIFIER_SHA256S: verifierHash,
    MENDPOINT_FEED_POLLING_ENABLED: "0",
    MENDPOINT_PILOT_SEED: "1",
    MENDPOINT_TENANT_ID: tenantId,
    MENDPOINT_VERIFY_FIRST: "1",
    MENDPOINT_WEB_ACCESS_TOKEN: webToken,
    MENDPOINT_WEB_ALLOWED_ORIGINS: webOrigin,
    POLL_INTERVAL_MS: String(workerIntervalMs),
    POLL_LOCAL_ONLY: "1",
    WEB_URL: webOrigin,
  };
  const args = [
    "run",
    "--detach",
    "--name",
    container,
    "--publish",
    `127.0.0.1:${webPort}:3000`,
    "--volume",
    `${volume}:/data`,
  ];
  for (const [key, value] of Object.entries(variables)) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(image);
  docker(args);
}

function stopRuntime(): void {
  docker(["rm", "--force", container], { allowFailure: true });
}

function saveRuntimeLogs(): void {
  mkdirSync(resolve("test-results/e2e"), { recursive: true });
  const logs = docker(["logs", container], { allowFailure: true });
  writeFileSync(resolve("test-results/e2e/runtime.log"), logs, "utf8");
}

async function waitForHttp(
  request: APIRequestContext,
  path: string,
  expectedStatus: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          return (await request.get(path)).status();
        } catch {
          return 0;
        }
      },
      { timeout: 90_000, intervals: [250, 500, 1_000, 2_000] },
    )
    .toBe(expectedStatus);
}

async function signedWebhook(
  request: APIRequestContext,
  event: string,
  delivery: string,
  payload: Json,
) {
  const raw = JSON.stringify(payload);
  const signature = createHmac("sha256", webhookSecret).update(raw).digest("hex");
  return request.post("/webhooks/github", {
    data: raw,
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": event,
      "X-GitHub-Delivery": delivery,
      "X-Hub-Signature-256": `sha256=${signature}`,
    },
  });
}

test.describe.configure({ mode: "serial" });

test("production image protects operators and recovers queued work after a crash", async ({
  page,
  request,
}) => {
  docker(["volume", "create", volume]);
  startRuntime(600_000);

  try {
    await waitForHttp(request, "/livez", 200);
    await waitForHttp(request, "/healthz", 200);

    const protectedApi = await request.get("/api/jobs", {
      headers: { "X-Role": "owner", "X-Tenant-Id": tenantId },
    });
    expect(protectedApi.status()).toBe(401);
    expect(await protectedApi.json()).toEqual({ error: "web_session_required" });

    const badWebhook = await request.post("/webhooks/github", {
      data: "{}",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "ping",
        "X-GitHub-Delivery": `bad-${suffix}`,
        "X-Hub-Signature-256": "sha256=invalid",
      },
    });
    expect(badWebhook.status()).toBe(401);

    await page.goto("/status");
    await expect(page).toHaveURL(/\/access\?next=%2Fstatus$/);
    await page.getByLabel("Access token").fill("wrong-token");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Access denied")).toBeVisible();
    await page.getByLabel("Access token").fill(webToken);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/status$/);
    await expect(page.getByRole("heading", { name: "System status" })).toBeVisible();
    await expect(page.getByText("Operational", { exact: true })).toBeVisible();

    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((cookie) => cookie.name === "mendpoint_web_session");
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.secure).toBe(true);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    expect(await page.content()).not.toContain(apiKey);

    const delivery = `ping-${suffix}`;
    const ping = await signedWebhook(page.request, "ping", delivery, { zen: "keep it bounded" });
    expect(ping.status()).toBe(200);
    expect(await ping.json()).toMatchObject({ ok: true, pong: "keep it bounded" });

    // Let the worker finish its initial empty sweep before queueing work.
    await page.waitForTimeout(6_000);
    await page.goto("/repair");
    await expect(page.getByRole("heading", { name: "Agentic repair" })).toBeVisible();
    await expect(page.getByLabel("Consumer")).toHaveValue(/.+/);
    await page.getByLabel(/Dry run/).check();
    const queuedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/repair/sessions") && response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Start verified repair" }).click();
    const queued = await queuedResponse;
    expect(queued.status()).toBe(202);
    const queuedBody = (await queued.json()) as { sessionId: string; jobId: string };
    expect(queuedBody.sessionId).toBeTruthy();
    expect(queuedBody.jobId).toBeTruthy();

    await expect
      .poll(
        async () => {
          const response = await page.request.get("/api/jobs");
          const jobs = (await response.json()) as Array<{ id: string; status: string }>;
          return jobs.find((job) => job.id === queuedBody.jobId)?.status;
        },
        { timeout: 10_000 },
      )
      .toBe("pending");

    const mutationHeaders = { Origin: webOrigin, "Content-Type": "application/json" };
    const cancelled = await page.request.post(`/api/jobs/${queuedBody.jobId}/cancel`, {
      data: { reason: "E2E operator cancellation" },
      headers: mutationHeaders,
    });
    expect(cancelled.status()).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: "cancelled" });
    const duplicateCancel = await page.request.post(`/api/jobs/${queuedBody.jobId}/cancel`, {
      data: { reason: "E2E duplicate cancellation" },
      headers: mutationHeaders,
    });
    expect(duplicateCancel.status()).toBe(409);
    const retried = await page.request.post(`/api/jobs/${queuedBody.jobId}/retry`, {
      data: { reason: "E2E recovery" },
      headers: mutationHeaders,
    });
    expect(retried.status()).toBe(200);
    expect(await retried.json()).toMatchObject({ status: "pending" });
    const duplicateRetry = await page.request.post(`/api/jobs/${queuedBody.jobId}/retry`, {
      data: { reason: "E2E duplicate retry" },
      headers: mutationHeaders,
    });
    expect(duplicateRetry.status()).toBe(409);

    stopRuntime();
    startRuntime(1_000);
    await waitForHttp(request, "/livez", 200);

    const replay = await signedWebhook(page.request, "ping", delivery, { zen: "keep it bounded" });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toEqual({ ok: true, duplicate: true });

    await expect
      .poll(
        async () => {
          const response = await page.request.get("/api/jobs");
          if (!response.ok()) return `http_${response.status()}`;
          const jobs = (await response.json()) as Array<{
            id: string;
            status: string;
            error?: unknown;
            payload?: unknown;
            leaseToken?: unknown;
          }>;
          const job = jobs.find((candidate) => candidate.id === queuedBody.jobId);
          if (job) {
            expect(job.error).toBeUndefined();
            expect(job.payload).toBeUndefined();
            expect(job.leaseToken).toBeUndefined();
          }
          return job?.status;
        },
        { timeout: 60_000, intervals: [250, 500, 1_000, 2_000] },
      )
      .toBe("done");

    const recoveryResponse = await page.request.get("/api/recovery/summary");
    expect(recoveryResponse.status()).toBe(200);
    expect(await recoveryResponse.json()).toMatchObject({
      pending: 0,
      running: 0,
      deadLetter: 0,
      simulated: 1,
    });
    await waitForHttp(request, "/healthz", 200);

    await page.goto("/repair");
    await expect(page.getByText("simulated", { exact: true })).toBeVisible();
    await page.goto("/status");
    await expect(page.getByRole("heading", { name: "Self healing recovery" })).toBeVisible();
    await expect(page.getByText("Simulations: 1.")).toBeVisible();
  } finally {
    saveRuntimeLogs();
    stopRuntime();
    docker(["volume", "rm", volume], { allowFailure: true });
  }
});
