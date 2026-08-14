import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  RELEASE,
  resolveReleaseRevision,
  validateApiEnv,
  rateLimit,
  clearRateLimits,
  rateLimitBucketCount,
  isFeatureEnabled,
  featureMatrix,
  liveness,
  readiness,
  releaseBanner,
} from "./index.js";

const CUSTOMER_BACKUP_ENV = {
  MENDPOINT_BACKUP_SOURCE_ROOT: process.platform === "win32"
    ? "C:\\mendpoint\\data"
    : "/srv/mendpoint/data",
  MENDPOINT_BACKUP_OUTPUT_ROOT: process.platform === "win32"
    ? "C:\\mendpoint-backups\\customer"
    : "/var/backups/mendpoint",
  MENDPOINT_BACKUP_FENCE_ROOT: process.platform === "win32"
    ? "C:\\mendpoint\\data\\backup-fence"
    : "/srv/mendpoint/data/backup-fence",
  MENDPOINT_BACKUP_EVIDENCE_PATH: process.platform === "win32"
    ? "C:\\mendpoint\\data\\backup-state\\last-verified.json"
    : "/srv/mendpoint/data/backup-state/last-verified.json",
  MENDPOINT_BACKUP_STORAGE_CLASS: "durable_isolated_mount",
  MENDPOINT_BACKUP_KEY: "11".repeat(32),
  MENDPOINT_BACKUP_KEY_ID: "customer-backup-key-v1",
  MENDPOINT_BACKUP_DATABASE_PATH: "mendpoint.sqlite",
  MENDPOINT_BACKUP_GRAPH_PATH: "graph-learn.sqlite",
  MENDPOINT_BACKUP_CHANGE_SOURCES_PATH: "change-sources.sqlite",
  MENDPOINT_BACKUP_TRANSFORMER_CONTROL_PLANE_PATH: "transformer-control-plane.sqlite",
  MENDPOINT_BACKUP_TRANSFORMER_PILOT_PATH: "transformer-pilot.sqlite",
  MENDPOINT_BACKUP_ARTIFACTS_PATH: ".",
  MENDPOINT_BACKUP_CONFIGURATION_PATH: "configuration/recovery.json",
} satisfies NodeJS.ProcessEnv;

describe("ops GA", () => {
  beforeEach(() => {
    clearRateLimits();
  });

  it("release is GA 1.0.0", () => {
    expect(RELEASE.product).toBe("Fettler");
    expect(RELEASE.version).toBe("1.0.0");
    expect(RELEASE.channel).toBe("ga");
    expect(releaseBanner()).toBe("Mendpoint / Fettler 1.0.0 (ga)");
    expect(RELEASE.gaFeatures.length).toBeGreaterThan(5);
  });

  it("accepts only an immutable deployed source revision", () => {
    expect(resolveReleaseRevision({ MENDPOINT_RELEASE_REVISION: "a".repeat(40) }))
      .toBe("a".repeat(40));
    expect(resolveReleaseRevision({ MENDPOINT_RELEASE_REVISION: "b".repeat(64) }))
      .toBe("b".repeat(64));
    expect(resolveReleaseRevision({})).toBeNull();
    expect(() => resolveReleaseRevision({ MENDPOINT_RELEASE_REVISION: "main" }))
      .toThrow("release_revision_invalid");
  });

  it("production requires API_AUTH", () => {
    const prev = process.env.NODE_ENV;
    const auth = process.env.API_AUTH;
    process.env.NODE_ENV = "production";
    delete process.env.API_AUTH;
    const r = validateApiEnv(process.env);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("API_AUTH"))).toBe(true);
    process.env.NODE_ENV = prev;
    if (auth !== undefined) process.env.API_AUTH = auth;
    else delete process.env.API_AUTH;
  });

  it("production real GitHub mode requires a webhook secret", () => {
    const r = validateApiEnv({
      NODE_ENV: "production",
      API_AUTH: "required",
      GITHUB_MODE: "real",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("GITHUB_WEBHOOK_SECRET"))).toBe(true);
  });

  it("rejects typoed GitHub mode and unsupported database URLs", () => {
    const r = validateApiEnv({
      NODE_ENV: "production",
      API_AUTH: "required",
      GITHUB_MODE: "rea1",
      DATABASE_URL: "postgres://db.example/mendpoint",
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("GITHUB_MODE"))).toBe(true);
    expect(r.errors.some((e) => e.includes("SQLite"))).toBe(true);
  });

  it("rejects an implicit production GitHub mode", () => {
    const r = validateApiEnv({
      NODE_ENV: "production",
      API_AUTH: "required",
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      WEB_URL: "https://mendpoint.example",
    });
    expect(r.errors.some((e) => e.includes("explicitly set"))).toBe(true);
  });

  it("accepts a durable mock mode production configuration", () => {
    const r = validateApiEnv({
      NODE_ENV: "production",
      MENDPOINT_DEPLOYMENT_PROFILE: "demo",
      API_AUTH: "required",
      GITHUB_MODE: "mock",
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
      WEB_URL: "https://mendpoint.example",
    });
    expect(r.ok).toBe(true);
  });

  it("accepts the dedicated Transformer pilot with customer class GitHub App delivery", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const report = validateApiEnv({
      NODE_ENV: "production",
      MENDPOINT_DEPLOYMENT_PROFILE: "transformer_pilot",
      MENDPOINT_DEPLOYMENT_CLASS: "customer",
      API_AUTH: "required",
      GITHUB_MODE: "real",
      GITHUB_WEBHOOK_SECRET: "secret",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      GITHUB_APP_ACCOUNT_TENANT_BINDINGS: '{"7123456":"tenant-transformer"}',
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
    });
    expect(report.ok).toBe(true);
  });

  it("fails closed when trusted proxy mode has no shared secret", () => {
    const r = validateApiEnv({
      NODE_ENV: "production",
      MENDPOINT_DEPLOYMENT_PROFILE: "demo",
      API_AUTH: "required",
      GITHUB_MODE: "mock",
      TRUST_PROXY: "1",
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
    });
    expect(r.errors).toContain(
      "TRUST_PROXY_SECRET is required when TRUST_PROXY=1 in production",
    );
  });

  it("requires an App for customers and allows PAT only for a disposable canary", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const appOnly = validateApiEnv({
      ...CUSTOMER_BACKUP_ENV,
      NODE_ENV: "production",
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      API_AUTH: "required",
      GITHUB_MODE: "real",
      MENDPOINT_DEPLOYMENT_CLASS: "customer",
      MENDPOINT_FEED_POLLING_ENABLED: "1",
      POLL_LOCAL_ONLY: "0",
      MENDPOINT_PILOT_SEED: "0",
      GITHUB_WEBHOOK_SECRET: "secret",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: privateKeyPem,
      GITHUB_APP_ACCOUNT_TENANT_BINDINGS: '{"7123456":"tenant_default"}',
      MENDPOINT_DATA_DIR: CUSTOMER_BACKUP_ENV.MENDPOINT_BACKUP_SOURCE_ROOT,
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
      WEB_URL: "https://mendpoint.example",
    });
    expect(appOnly.ok).toBe(true);

    const invalidApp = validateApiEnv({
      NODE_ENV: "production",
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      API_AUTH: "required",
      GITHUB_MODE: "real",
      MENDPOINT_DEPLOYMENT_CLASS: "customer",
      MENDPOINT_FEED_POLLING_ENABLED: "1",
      POLL_LOCAL_ONLY: "0",
      MENDPOINT_PILOT_SEED: "0",
      GITHUB_WEBHOOK_SECRET: "secret",
      GITHUB_TOKEN: "fine-grained-pat",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "not-a-private-key",
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
      WEB_URL: "https://mendpoint.example",
    });
    expect(invalidApp.errors).toContain(
      "GitHub App credentials must include a positive app ID and a readable RSA private key",
    );

    const incompleteApp = validateApiEnv({
      NODE_ENV: "production",
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      API_AUTH: "required",
      GITHUB_MODE: "real",
      MENDPOINT_DEPLOYMENT_CLASS: "customer",
      MENDPOINT_FEED_POLLING_ENABLED: "1",
      POLL_LOCAL_ONLY: "0",
      MENDPOINT_PILOT_SEED: "0",
      GITHUB_WEBHOOK_SECRET: "secret",
      GITHUB_APP_ID: "123",
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
      WEB_URL: "https://mendpoint.example",
    });
    expect(incompleteApp.errors).toContain(
      "Complete GitHub App credentials are required for customer production delivery",
    );

    const customerPat = validateApiEnv({
      NODE_ENV: "production",
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      API_AUTH: "required",
      GITHUB_MODE: "real",
      MENDPOINT_DEPLOYMENT_CLASS: "customer",
      MENDPOINT_FEED_POLLING_ENABLED: "1",
      POLL_LOCAL_ONLY: "0",
      MENDPOINT_PILOT_SEED: "0",
      GITHUB_WEBHOOK_SECRET: "secret",
      GITHUB_TOKEN: "fine-grained-pat",
      MENDPOINT_TENANT_ID: "tenant-canary",
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
      WEB_URL: "https://mendpoint.example",
    });
    expect(customerPat.errors).toContain(
      "Complete GitHub App credentials are required for customer production delivery",
    );

    const patBacked = validateApiEnv({
      NODE_ENV: "production",
      MENDPOINT_DEPLOYMENT_PROFILE: "pilot",
      API_AUTH: "required",
      GITHUB_MODE: "real",
      MENDPOINT_DEPLOYMENT_CLASS: "disposable_canary",
      MENDPOINT_TENANT_ID: "tenant-canary",
      GITHUB_WEBHOOK_SECRET: "secret",
      GITHUB_TOKEN: "fine-grained-pat",
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
      WEB_URL: "https://mendpoint.example",
    });
    expect(patBacked.ok).toBe(true);
  });

  it("rejects legacy GitHub login bindings for customer production", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const report = validateApiEnv({
      NODE_ENV: "production",
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      API_AUTH: "required",
      GITHUB_MODE: "real",
      MENDPOINT_DEPLOYMENT_CLASS: "customer",
      MENDPOINT_FEED_POLLING_ENABLED: "1",
      POLL_LOCAL_ONLY: "0",
      MENDPOINT_PILOT_SEED: "0",
      GITHUB_WEBHOOK_SECRET: "secret",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      GITHUB_APP_OWNER_TENANT_BINDINGS: '{"gondalaimafia":"tenant_default"}',
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
    });
    expect(report.errors).toContain(
      "GITHUB_APP_ACCOUNT_TENANT_BINDINGS must be a nonempty one-to-one JSON numeric account ID to tenant map; legacy login bindings are forbidden",
    );
  });

  it("rejects ambiguous account bindings before customer startup", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const report = validateApiEnv({
      NODE_ENV: "production",
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      API_AUTH: "required",
      GITHUB_MODE: "real",
      MENDPOINT_DEPLOYMENT_CLASS: "customer",
      MENDPOINT_FEED_POLLING_ENABLED: "1",
      POLL_LOCAL_ONLY: "0",
      MENDPOINT_PILOT_SEED: "0",
      GITHUB_WEBHOOK_SECRET: "secret",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      GITHUB_APP_ACCOUNT_TENANT_BINDINGS:
        '{"7123456":"tenant_default","8123456":"tenant_default"}',
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
    });
    expect(report.errors).toContain(
      "GITHUB_APP_ACCOUNT_TENANT_BINDINGS must be a nonempty one-to-one JSON numeric account ID to tenant map; legacy login bindings are forbidden",
    );
  });

  it("requires an explicit production deployment profile", () => {
    const missing = validateApiEnv({
      NODE_ENV: "production",
      API_AUTH: "required",
      GITHUB_MODE: "mock",
      MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
    });
    expect(missing.errors).toContain(
      "MENDPOINT_DEPLOYMENT_PROFILE must be explicitly set to demo, pilot, customer, or transformer_pilot in production",
    );

    for (const profile of ["production", "CUSTOMER", " customer "]) {
      const invalid = validateApiEnv({
        ...missing.values,
        NODE_ENV: "production",
        API_AUTH: "required",
        GITHUB_MODE: "mock",
        MENDPOINT_DEPLOYMENT_PROFILE: profile,
        MENDPOINT_DATA_DIR: process.platform === "win32" ? "C:\\data" : "/data",
        MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
      });
      expect(invalid.errors).toContain(
        "MENDPOINT_DEPLOYMENT_PROFILE must be exactly demo, pilot, customer, or transformer_pilot",
      );
    }
  });

  it("fails closed on every demo control in a customer deployment profile", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const base = {
      ...CUSTOMER_BACKUP_ENV,
      NODE_ENV: "production",
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      API_AUTH: "required",
      GITHUB_MODE: "real",
      MENDPOINT_DEPLOYMENT_CLASS: "customer",
      MENDPOINT_FEED_POLLING_ENABLED: "1",
      POLL_LOCAL_ONLY: "0",
      MENDPOINT_PILOT_SEED: "0",
      GITHUB_WEBHOOK_SECRET: "secret",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: privateKeyPem,
      GITHUB_APP_ACCOUNT_TENANT_BINDINGS: '{"12345":"tenant_default"}',
      MENDPOINT_DATA_DIR: CUSTOMER_BACKUP_ENV.MENDPOINT_BACKUP_SOURCE_ROOT,
      MENDPOINT_REPOS_DIR: process.platform === "win32" ? "C:\\repos" : "/repos",
      WEB_URL: "https://mendpoint.example",
    } satisfies NodeJS.ProcessEnv;

    expect(validateApiEnv(base).ok).toBe(true);
    const {
      MENDPOINT_BACKUP_OUTPUT_ROOT: _backupOutput,
      ...missingBackup
    } = base;
    expect(validateApiEnv(missingBackup).errors).toContain(
      "Customer deployment profile requires complete isolated application-consistent backup configuration",
    );
    expect(validateApiEnv({ ...base, MENDPOINT_BACKUP_KEY: "" }).errors).toContain(
      "Customer deployment profile requires complete isolated application-consistent backup configuration",
    );
    expect(validateApiEnv({ ...base, MENDPOINT_BACKUP_STORAGE_CLASS: "local_directory" }).errors).toContain(
      "Customer deployment profile requires complete isolated application-consistent backup configuration",
    );
    expect(validateApiEnv({ ...base, GITHUB_MODE: "mock" }).errors)
      .toContain("Customer deployment profile requires GITHUB_MODE=real");
    expect(validateApiEnv({ ...base, MENDPOINT_FEED_POLLING_ENABLED: "0" }).errors)
      .toContain("Customer deployment profile requires MENDPOINT_FEED_POLLING_ENABLED=1");
    expect(validateApiEnv({ ...base, POLL_LOCAL_ONLY: "1" }).errors)
      .toContain("Customer deployment profile requires POLL_LOCAL_ONLY=0");
    expect(validateApiEnv({ ...base, MENDPOINT_PILOT_SEED: "1" }).errors)
      .toContain("Customer deployment profile requires MENDPOINT_PILOT_SEED=0");
  });

  it("ships an isolated durable Compose backup mount without exposing the backup key to the worker", () => {
    const compose = readFileSync(resolve(import.meta.dirname, "../../../docker-compose.yml"), "utf8");
    expect(compose.match(/mendpoint-backups:\/backup/g)?.length).toBe(1);
    expect(compose).toMatch(/\n\s*mendpoint-backups:\s*\r?\n/);
    expect(compose).toContain("MENDPOINT_BACKUP_STORAGE_CLASS");
    expect(compose).toContain("MENDPOINT_BACKUP_KEY");
    expect(compose).toContain(
      "MENDPOINT_BACKUP_ARTIFACTS_PATH: ${MENDPOINT_BACKUP_ARTIFACTS_PATH:-.}",
    );
    const dockerfile = readFileSync(resolve(import.meta.dirname, "../../../Dockerfile"), "utf8");
    for (const retainedRoot of [
      "warden-candidates",
      "warden-evidence",
      "transformer-candidates",
      "transformer-evidence",
    ]) expect(dockerfile).toContain(`/app/data/${retainedRoot}`);
    const worker = compose.split("\n  worker:")[1] ?? "";
    expect(worker).not.toContain("MENDPOINT_BACKUP_KEY:");
    expect(worker).toContain("GITHUB_APP_ACCOUNT_TENANT_BINDINGS:");
    expect(worker).toContain("MENDPOINT_WORKER_HEARTBEAT_PATH: /app/data/worker-heartbeat.json");
    expect(worker).toContain('"run-service"');
    const web = (compose.split("\n  web:")[1] ?? "").split("\n  worker:")[0] ?? "";
    expect(web).toContain("MENDPOINT_WORKER_HEARTBEAT_PATH: /app/data/worker-heartbeat.json");
    expect(web).toContain("mendpoint-data:/app/data:ro");
  });

  it("rate limits after max", () => {
    for (let i = 0; i < 5; i++) {
      const r = rateLimit("t1", { limit: 5, windowMs: 60_000 });
      expect(r.allowed).toBe(true);
    }
    const blocked = rateLimit("t1", { limit: 5, windowMs: 60_000 });
    expect(blocked.allowed).toBe(false);
  });

  it("bounds retained rate limit identities", () => {
    const previous = process.env.RATE_LIMIT_MAX_BUCKETS;
    process.env.RATE_LIMIT_MAX_BUCKETS = "3";
    try {
      for (let i = 0; i < 10; i++) {
        rateLimit(`identity-${i}`, { limit: 1, windowMs: 60_000 });
      }
      expect(rateLimitBucketCount()).toBeLessThanOrEqual(3);
    } finally {
      if (previous === undefined) delete process.env.RATE_LIMIT_MAX_BUCKETS;
      else process.env.RATE_LIMIT_MAX_BUCKETS = previous;
    }
  });

  it("GA features on; experimental off by default", () => {
    expect(isFeatureEnabled("migration_pr_review_first")).toBe(true);
    expect(isFeatureEnabled("firecracker_vm_backend")).toBe(false);
    const m = featureMatrix();
    expect(m.filter((f) => f.tier === "ga").every((f) => f.enabled)).toBe(true);
  });

  it("liveness and readiness return structured probes", () => {
    expect(liveness().status).toBe("ok");
    const r = readiness();
    expect(["ok", "degraded", "fail"]).toContain(r.status);
    expect(r.release.version).toBe("1.0.0");
  });

  it("fails boot when local_only egress is configured with an external model endpoint", () => {
    const r = validateApiEnv({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_AGENT_URL: "https://api.meta.ai/v1",
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain(
      "MENDPOINT_MODEL_EGRESS=local_only forbids an external model endpoint; LLM_AGENT_URL must resolve to a private, loopback, link-local, or allowlisted host",
    );
  });

  it("accepts a local model endpoint under local_only egress", () => {
    const r = validateApiEnv({
      MENDPOINT_MODEL_EGRESS: "local_only",
      LLM_AGENT_URL: "http://127.0.0.1:11434/v1",
    });
    expect(r.errors.some((e) => e.includes("MENDPOINT_MODEL_EGRESS"))).toBe(false);
    expect(r.errors.some((e) => e.includes("LLM_AGENT_URL"))).toBe(false);
  });

  it("rejects an invalid egress flag value", () => {
    const r = validateApiEnv({ MENDPOINT_MODEL_EGRESS: "localonly" });
    expect(r.errors).toContain(
      "MENDPOINT_MODEL_EGRESS must be exactly local_only or external_allowed",
    );
  });

  it("leaves external_allowed (default) egress unchanged for a public endpoint", () => {
    const r = validateApiEnv({ LLM_AGENT_URL: "https://api.meta.ai/v1" });
    expect(r.errors.some((e) => e.includes("MENDPOINT_MODEL_EGRESS"))).toBe(false);
  });
});
