/**
 * Self-serve guided onboarding status (S1.3).
 *
 * Proves the guided first-run status endpoint:
 *  - the flag helper is exact (all three foundation flags must be on);
 *  - the route is inert (404) unless enabled;
 *  - every step's done/next/blocked state is DERIVED from real tenant-scoped data
 *    (workspace, connected repos, monitored providers, scan jobs, migration PRs);
 *  - a blocked step carries an actionable fix, not a raw API error;
 *  - the flow is tenant-scoped: one tenant never observes another's progress.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  createTenant,
  enqueueJob,
  insertApiChange,
  insertApiVersion,
  insertConsumer,
  insertMigrationPr,
  insertMonitoredApi,
  insertProvider,
  insertConnectedRepository,
  upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { ApiEnv } from "./auth.js";
import {
  computeOnboardingStatus,
  createSelfServeOnboardingRoutes,
  selfServeOnboardingEnabled,
  type OnboardingStatus,
  type OnboardingStepId,
  type OnboardingStepState,
} from "./self-serve-onboarding.js";

const NOW = "2026-08-13T12:00:00.000Z";
const ALL_FLAGS = {
  MENDPOINT_SELF_SERVE_SIGNUP: "1",
  MENDPOINT_SELF_SERVE_CONNECT: "1",
  MENDPOINT_SELF_SERVE_WARDEN: "1",
} as const;

const opened: Array<{ db: AppDb; directory: string }> = [];

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function freshDb(): AppDb {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-onboarding-"));
  const db = createDb(join(directory, "api.sqlite"));
  opened.push({ db, directory });
  return db;
}

function seedTenant(db: AppDb, tenantId: string, name: string): void {
  createTenant(db, {
    tenantId,
    slug: `slug-${tenantId}`,
    name,
    plan: "free",
    owner: {
      issuer: "https://self-serve.mendpoint.ai",
      subject: `owner-${tenantId}@example.com`,
      email: `owner-${tenantId}@example.com`,
      displayName: name,
    },
    apiKeyId: `key-${tenantId}`,
    createdAt: NOW,
  });
}

function seedConnectedRepo(db: AppDb, tenantId: string, owner: string, name: string): void {
  upsertScmConnection(db, {
    id: `conn-${tenantId}-${name}`,
    tenantId,
    provider: "local_git",
    credentialRef: "local://filesystem",
    externalAccountId: owner,
    displayName: `${owner} ${name}`,
    createdAt: NOW,
    updatedAt: NOW,
  });
  insertConnectedRepository(db, {
    id: `repo-${tenantId}-${name}`,
    tenantId,
    connectionId: `conn-${tenantId}-${name}`,
    remoteId: `${owner}/${name}`,
    owner,
    name,
    defaultBranch: "main",
    status: "ready",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

/** Seed a provider + change + a tenant consumer that monitors it. Returns ids. */
function seedMonitoredProvider(db: AppDb, tenantId: string, slug: string) {
  insertProvider(db, { id: `provider-${slug}`, slug, name: `Provider ${slug}`, createdAt: NOW });
  insertApiVersion(db, {
    id: `version-${slug}-1`,
    providerId: `provider-${slug}`,
    versionLabel: "1",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: slug, version: "1" } }),
    publishedAt: NOW,
  });
  insertApiVersion(db, {
    id: `version-${slug}-2`,
    providerId: `provider-${slug}`,
    versionLabel: "2",
    openapiJson: JSON.stringify({ openapi: "3.0.0", info: { title: slug, version: "2" } }),
    publishedAt: NOW,
  });
  insertApiChange(db, {
    id: `change-${slug}`,
    providerId: `provider-${slug}`,
    fromVersionId: `version-${slug}-1`,
    toVersionId: `version-${slug}-2`,
    risk: "breaking",
    summary: `Change ${slug}`,
    diffJson: "[]",
    createdAt: NOW,
  });
  insertConsumer(db, {
    id: `consumer-${tenantId}-${slug}`,
    name: `Consumer ${slug}`,
    githubOwner: "customer",
    githubRepo: `repo-${slug}`,
    tenantId,
    createdAt: NOW,
  });
  insertMonitoredApi(db, {
    id: `mon-${tenantId}-${slug}`,
    consumerId: `consumer-${tenantId}-${slug}`,
    providerId: `provider-${slug}`,
  });
  return { consumerId: `consumer-${tenantId}-${slug}`, changeId: `change-${slug}` };
}

function seedScanJob(db: AppDb, tenantId: string, providerSlug: string): void {
  enqueueJob(db, {
    id: `scan-job-${tenantId}-abc`,
    tenantId,
    type: "pipeline.fanout",
    payload: { providerSlug, tenantId },
    createdAt: NOW,
  });
}

function seedReviewablePr(db: AppDb, changeId: string, consumerId: string): void {
  insertMigrationPr(db, {
    id: "pr-onboarding-1",
    changeId,
    consumerId,
    title: "Migrate to v2",
    body: "Adopt the breaking change.",
    branchName: "mendpoint/migrate",
    status: "open",
    risk: "breaking",
    patchUnified: "diff",
    createdAt: NOW,
  });
}

function byId(status: OnboardingStatus): Record<OnboardingStepId, OnboardingStepState> {
  return Object.fromEntries(status.steps.map((step) => [step.id, step.state])) as Record<
    OnboardingStepId,
    OnboardingStepState
  >;
}

const identities = {
  "owner-a": { id: "human:owner-a@example.com", tenantId: "tenant-a", role: "owner" as const },
  "owner-b": { id: "human:owner-b@example.com", tenantId: "tenant-b", role: "owner" as const },
  "owner-blank": { id: "human:blank@example.com", tenantId: "", role: "owner" as const },
} as const;

function routeFixture(db: AppDb, enabled: boolean) {
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    const token = c.req.header("Authorization")?.replace(/^Bearer /, "") as
      | keyof typeof identities
      | undefined;
    const principal = token ? identities[token] : undefined;
    if (principal) c.set("principal", principal);
    return next();
  });
  app.route("/self-serve/onboarding", createSelfServeOnboardingRoutes({ db, enabled }));
  return app;
}

describe("selfServeOnboardingEnabled", () => {
  it("requires all three foundation flags set to exactly '1'", () => {
    expect(selfServeOnboardingEnabled({})).toBe(false);
    expect(selfServeOnboardingEnabled({ ...ALL_FLAGS, MENDPOINT_SELF_SERVE_WARDEN: "0" })).toBe(false);
    expect(selfServeOnboardingEnabled({ ...ALL_FLAGS, MENDPOINT_SELF_SERVE_CONNECT: "true" })).toBe(false);
    expect(selfServeOnboardingEnabled({ ...ALL_FLAGS })).toBe(true);
  });
});

describe("self-serve onboarding route gating", () => {
  it("is inert (404) unless enabled", async () => {
    const db = freshDb();
    seedTenant(db, "tenant-a", "Acme");
    const res = await routeFixture(db, false).request("/self-serve/onboarding", {
      headers: { Authorization: "Bearer owner-a" },
    });
    expect(res.status).toBe(404);
  });

  it("returns the caller's own onboarding status when enabled", async () => {
    const db = freshDb();
    seedTenant(db, "tenant-a", "Acme");
    const res = await routeFixture(db, true).request("/self-serve/onboarding", {
      headers: { Authorization: "Bearer owner-a" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OnboardingStatus;
    expect(body.tenantId).toBe("tenant-a");
    expect(body.workspaceName).toBe("Acme");
    expect(body.totalSteps).toBe(5);
  });

  it("fails closed (401) when the principal has a blank tenant", async () => {
    const db = freshDb();
    const res = await routeFixture(db, true).request("/self-serve/onboarding", {
      headers: { Authorization: "Bearer owner-blank" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "tenant_scope_required" });
  });

  it("rejects an unauthenticated request (401)", async () => {
    const db = freshDb();
    const res = await routeFixture(db, true).request("/self-serve/onboarding");
    expect(res.status).toBe(401);
  });
});

describe("onboarding state derived from real tenant data", () => {
  it("a fresh workspace has connect next and every later step blocked", () => {
    const db = freshDb();
    seedTenant(db, "tenant-a", "Acme");
    const status = computeOnboardingStatus(db, "tenant-a");
    expect(byId(status)).toEqual({
      workspace: "done",
      connect: "next",
      spec: "blocked",
      scan: "blocked",
      review: "blocked",
    });
    expect(status.completedSteps).toBe(1);
  });

  it("connecting a repository advances the flow to the spec step", () => {
    const db = freshDb();
    seedTenant(db, "tenant-a", "Acme");
    seedConnectedRepo(db, "tenant-a", "acme", "payments-sdk");
    const status = computeOnboardingStatus(db, "tenant-a");
    expect(byId(status)).toMatchObject({ connect: "done", spec: "next", scan: "blocked" });
    const connect = status.steps.find((step) => step.id === "connect")!;
    expect(connect.detail).toContain("acme/payments-sdk");
  });

  it("marks scan done and surfaces the live job id + status once a scan job exists", () => {
    const db = freshDb();
    seedTenant(db, "tenant-a", "Acme");
    seedConnectedRepo(db, "tenant-a", "acme", "payments-sdk");
    seedMonitoredProvider(db, "tenant-a", "alpha");
    seedScanJob(db, "tenant-a", "alpha");
    const status = computeOnboardingStatus(db, "tenant-a");
    expect(byId(status)).toMatchObject({ spec: "done", scan: "done", review: "next" });
    const scan = status.steps.find((step) => step.id === "scan")!;
    expect(scan.meta).toMatchObject({ jobId: `scan-job-tenant-a-abc`, status: "pending" });
    expect(scan.detail).toContain("scan-job-tenant-a-abc");
  });

  it("completes when a reviewable PR exists and links to its review page", () => {
    const db = freshDb();
    seedTenant(db, "tenant-a", "Acme");
    seedConnectedRepo(db, "tenant-a", "acme", "payments-sdk");
    const { changeId, consumerId } = seedMonitoredProvider(db, "tenant-a", "alpha");
    seedScanJob(db, "tenant-a", "alpha");
    seedReviewablePr(db, changeId, consumerId);
    const status = computeOnboardingStatus(db, "tenant-a");
    expect(status.completedSteps).toBe(5);
    const review = status.steps.find((step) => step.id === "review")!;
    expect(review.state).toBe("done");
    expect(review.action).toMatchObject({ kind: "link", href: "/consumer/prs/pr-onboarding-1" });
  });

  it("a blocked step carries an actionable fix, never a raw API error", () => {
    const db = freshDb();
    seedTenant(db, "tenant-a", "Acme");
    const status = computeOnboardingStatus(db, "tenant-a");
    const scan = status.steps.find((step) => step.id === "scan")!;
    expect(scan.state).toBe("blocked");
    expect(scan.blockedReason).toBe('Finish "Connect a repository" first, then this step unlocks.');
    // A blocked step never invites its own action directly.
    expect(scan.action.kind).toBe("none");
  });
});

describe("onboarding is strictly tenant-scoped", () => {
  it("never reflects another tenant's connect / scan / PR progress", async () => {
    const db = freshDb();
    seedTenant(db, "tenant-a", "Acme");
    seedTenant(db, "tenant-b", "Beta");
    // tenant-a is fully set up; tenant-b has only its workspace.
    seedConnectedRepo(db, "tenant-a", "acme", "payments-sdk");
    const { changeId, consumerId } = seedMonitoredProvider(db, "tenant-a", "alpha");
    seedScanJob(db, "tenant-a", "alpha");
    seedReviewablePr(db, changeId, consumerId);

    const b = computeOnboardingStatus(db, "tenant-b");
    expect(byId(b)).toEqual({
      workspace: "done",
      connect: "next",
      spec: "blocked",
      scan: "blocked",
      review: "blocked",
    });
    expect(b.completedSteps).toBe(1);

    // And over the route, tenant-b's response carries only tenant-b state.
    const res = await routeFixture(db, true).request("/self-serve/onboarding", {
      headers: { Authorization: "Bearer owner-b" },
    });
    const body = (await res.json()) as OnboardingStatus;
    expect(body.tenantId).toBe("tenant-b");
    expect(body.completedSteps).toBe(1);
  });
});
