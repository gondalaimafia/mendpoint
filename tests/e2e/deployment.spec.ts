import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
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
const applicationDataKey = "b".repeat(64);
const webToken = "e2e-web-access-token";
const webhookSecret = "e2e-webhook-secret";
const tenantId = "tenant_default";
const verifierHash = createHash("sha256")
  .update(readFileSync(resolve("fixtures/consumers/shop-app/check.mjs")))
  .digest("hex");

const publicPages = [
  {
    path: "/",
    heading:
      "Turn submitted OpenAPI changes into evidence backed migration pull request candidates for supported GitHub repositories.",
  },
  { path: "/design-partners", heading: "Start with one bounded migration problem" },
  { path: "/docs", heading: "Supported Warden pilot scope" },
  { path: "/security", heading: "Concrete controls and visible limitations" },
  { path: "/privacy", heading: "Private preview application data" },
  { path: "/service-status", heading: /Pilot deployment (?:is operational|needs attention)/ },
  { path: "/terms", heading: "Pilot website terms" },
] as const;

const unsupportedPublicClaims = [
  /[$£€]\s*\d/,
  /\b\d+(?:\.\d+)?\s*%/,
  /\b\d[\d,]*(?:\+)?\s+(?:customers?|repositories?|migrations?|pull requests?)\b/i,
  /\bunlimited\b/i,
  /\b(?:zero|no) egress\b/i,
  /\bproduction ready\b/i,
  /\bgenerally available\b/i,
  /\bGitLab (?:support|delivery) is available\b/i,
  /\b(?:SSO|SAML) is available\b/i,
] as const;

type Json = Record<string, unknown>;

async function expectNoBlockingAccessibilityViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = result.violations.filter(
    (violation) => violation.impact === "critical" || violation.impact === "serious",
  );
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

async function expectPublicWebsite(page: Page, request: APIRequestContext): Promise<string> {
  for (const route of publicPages) {
    const response = await page.goto(route.path);
    expect(response?.status(), `${route.path} should render without authentication`).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
    await expect(
      page.getByText("Private Design Partner Preview", { exact: false }).first(),
    ).toBeVisible();
    await expect(page.locator("main")).toBeVisible();
    await expectNoBlockingAccessibilityViolations(page);

    const renderedDocument = [
      await page.locator("body").innerText(),
      await page.title(),
      (await page.locator('meta[name="description"]').getAttribute("content")) ?? "",
      ...(await page.locator('script[type="application/ld+json"]').allTextContents()),
    ].join("\n");
    for (const unsupportedClaim of unsupportedPublicClaims) {
      expect(renderedDocument, `${route.path} contains unsupported public wording`).not.toMatch(
        unsupportedClaim,
      );
    }
  }

  await page.setViewportSize({ width: 375, height: 812 });
  for (const route of publicPages) {
    await page.goto(route.path);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
      `${route.path} should not overflow a mobile viewport horizontally`,
    ).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("/");
  await expect(page).toHaveTitle(/Evidence backed API migration candidates/);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /Private design partner preview.*supported GitHub repositories/i,
  );

  const destinations = await page.locator("a[href]").evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      href: anchor.getAttribute("href") ?? "",
      name: (anchor.textContent ?? anchor.getAttribute("aria-label") ?? "").trim(),
    })),
  );
  const expectedLocalDestinations = new Set([
    "/",
    "/access",
    "/contact",
    "/design-partners",
    "/docs",
    "/privacy",
    "/security",
    "/service-status",
    "/terms",
  ]);
  const expectedExternalDestinations = new Set([
    "https://github.com/gondalaimafia/mendpoint",
  ]);
  const checkedLocalDestinations = new Set<string>();
  const checkedExternalDestinations = new Set<string>();
  for (const destination of destinations) {
    expect(destination.name, `Link ${destination.href} should have an accessible name`).not.toBe("");
    const href = destination.href.trim();
    expect(href, `${destination.name} should have a real destination`).not.toBe("");
    expect(href, `${destination.name} should not use a JavaScript destination`).not.toMatch(
      /^javascript:/i,
    );
    expect(href, `${destination.name} should not use an empty fragment`).not.toBe("#");
    const target = new URL(href, page.url());
    const current = new URL(page.url());
    const targetsCurrentDocument =
      target.origin === current.origin &&
      target.pathname === current.pathname &&
      target.search === current.search;
    if (target.hash && targetsCurrentDocument) {
      const fragment = target.hash.slice(1);
      const resolves = await page.evaluate((encodedFragment) => {
        try {
          return document.getElementById(decodeURIComponent(encodedFragment)) !== null;
        } catch {
          return false;
        }
      }, fragment);
      expect(
        resolves,
        `${destination.name} fragment ${target.hash} should resolve on the current page`,
      ).toBe(true);
    }
    if (target.origin === new URL(webOrigin).origin) {
      const path = `${target.pathname}${target.search}`;
      if (!checkedLocalDestinations.has(path)) {
        const response = await request.get(path, { maxRedirects: 0 });
        expect([200, 307, 308], `${destination.name} should resolve at ${path}`).toContain(response.status());
        checkedLocalDestinations.add(path);
      }
    } else {
      expect(target.protocol, `${destination.name} should use a secure external URL`).toBe("https:");
      checkedExternalDestinations.add(target.href.replace(/\/$/, ""));
    }
  }
  for (const destination of expectedLocalDestinations) {
    expect(
      checkedLocalDestinations.has(destination),
      `Homepage or footer is missing ${destination}`,
    ).toBe(true);
  }
  for (const destination of expectedExternalDestinations) {
    expect(
      checkedExternalDestinations.has(destination),
      `Homepage or footer is missing ${destination}`,
    ).toBe(true);
  }

  const structuredData = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(structuredData.length).toBeGreaterThan(0);
  const application = structuredData
    .map((value) => JSON.parse(value) as Record<string, unknown>)
    .find((value) => value["@type"] === "SoftwareApplication");
  expect(application).toBeTruthy();
  expect(application).toMatchObject({
    offers: { availability: "https://schema.org/LimitedAvailability" },
  });
  expect(JSON.stringify(application)).not.toMatch(/"(?:price|priceCurrency|lowPrice|highPrice)"/i);

  await page.goto("/design-partners");
  let submitted = false;
  await page.route("**/api/design-partners", async (route) => {
    submitted = true;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "temporarily_unavailable" }),
    });
  });
  await page.getByRole("button", { name: "Submit application" }).click();
  expect(submitted, "Browser validation should prevent an empty application request").toBe(false);
  expect(
    await page.getByLabel("Name").evaluate((input: HTMLInputElement) => input.validity.valid),
  ).toBe(false);

  await page.getByLabel("Name").fill("Deployment Test");
  await page.getByLabel("Work email").fill("deployment@example.com");
  await page.getByLabel("Company").fill("Example Company");
  await page.getByLabel("Role").fill("Engineering lead");
  await page
    .getByLabel("Provider change to validate")
    .fill("Validate a bounded breaking API change in one service.");
  await page
    .getByLabel("Approved repository scope")
    .fill("One approved GitHub repository and its configured checks.");
  await page
    .getByLabel("Measurable success criterion")
    .fill("Produce one reviewable candidate that passes the configured checks.");
  await page.getByLabel(/I am authorized/).check();
  await page.getByLabel(/I agree that Mendpoint/).check();
  await page.getByRole("button", { name: "Submit application" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "We could not submit the application. Check the fields and try again.",
  );
  expect(submitted).toBe(true);
  await page.unroute("**/api/design-partners");

  await page.getByLabel("Work email").fill(`deployment-${suffix}@mendpoint.ai`);
  await page.waitForTimeout(3_100);
  await page.getByRole("button", { name: "Submit application" }).click();
  const success = page.getByRole("status");
  await expect(success).toContainText("Application received. Reference application-");
  const applicationId = /Reference (application-[A-Za-z0-9-]+)\./.exec(
    await success.innerText(),
  )?.[1];
  expect(applicationId).toBeTruthy();
  return applicationId!;
}

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
    MENDPOINT_APPLICATION_DATA_KEY: applicationDataKey,
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

    for (const path of ["/livez", "/healthz"] as const) {
      const publicHealth = await request.get(path, { maxRedirects: 0 });
      expect(publicHealth.status(), `${path} should remain public`).toBe(200);
    }

    const applicationId = await expectPublicWebsite(page, request);

    await page.goto("/console");
    await expect(page).toHaveURL(/\/access\?next=%2Fconsole$/);

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
    await page.getByLabel("Operator ID").fill("deployment-test");
    await page.getByLabel("Access token").fill("wrong-token");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Access denied")).toBeVisible();
    await page.getByLabel("Access token").fill(webToken);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/status$/);
    await expect(page.getByRole("heading", { name: "System status" })).toBeVisible();
    await expect(page.getByText("degraded", { exact: true })).toBeVisible();
    await expect(page.getByText(/GITHUB_MODE=mock/)).toBeVisible();
    await expect(page.getByText("db_ping", { exact: true })).toBeVisible();

    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((cookie) => cookie.name === "mendpoint_web_session");
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.secure).toBe(true);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    expect(await page.content()).not.toContain(apiKey);

    await page.goto("/console");
    await expect(page.getByRole("heading", { name: "Keep every API change moving" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
    await expect(page.getByText("Workspace", { exact: true })).toBeVisible();
    await expect(page.getByText("Automation", { exact: true })).toBeVisible();
    await expect(page.getByText("Operations", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Review system" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Applications" })).toBeVisible();
    await expectNoBlockingAccessibilityViolations(page);

    await page.goto("/applications");
    await expect(page.getByRole("heading", { name: "Design partner applications" })).toBeVisible();
    const applicationButton = page.getByRole("button", { name: new RegExp(applicationId) });
    await expect(applicationButton).toBeVisible();
    await applicationButton.click();
    await page.getByRole("button", { name: "Record access and reveal details" }).click();
    await expect(page.getByText(`deployment-${suffix}@mendpoint.ai`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Erase applicant details" }).click();
    await page.getByRole("button", { name: "Confirm permanent erasure" }).click();
    await expect(page.getByRole("status")).toContainText("Applicant details were erased");
    await expect(page.getByText(/Sensitive details are no longer recoverable/)).toBeVisible();
    await expectNoBlockingAccessibilityViolations(page);

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
          const response = await page.request.get(`/api/jobs/${queuedBody.jobId}`);
          const job = (await response.json()) as { id: string; status: string };
          return job.status;
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
          const response = await page.request.get(`/api/jobs/${queuedBody.jobId}`);
          if (!response.ok()) return `http_${response.status()}`;
          const job = (await response.json()) as {
            id: string;
            status: string;
            error?: unknown;
            payload?: unknown;
            leaseToken?: unknown;
          };
          expect(job.error).toBeUndefined();
          expect(job.payload).toBeUndefined();
          expect(job.leaseToken).toBeUndefined();
          return job.status;
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
    await expectNoBlockingAccessibilityViolations(page);
  } finally {
    saveRuntimeLogs();
    stopRuntime();
    docker(["volume", "rm", volume], { allowFailure: true });
  }
});
