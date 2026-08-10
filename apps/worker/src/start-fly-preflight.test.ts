import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { customerBackupInputFromEnv, validateApiEnv } from "@mendpoint/ops";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporaryRoots: string[] = [];
const CUSTOMER_WARDEN_ENV = {
  FLY_MACHINE_ID: "preflight-machine",
  MENDPOINT_ALLOWED_MACHINE_ID: "preflight-machine",
  MENDPOINT_CUSTOMER_READY: "1",
  MENDPOINT_CUSTOMER_TOPOLOGY: "single_node",
  MENDPOINT_CUSTOMER_MAX_MACHINES: "1",
  MENDPOINT_WARDEN_MODEL_SOURCE_ENABLED: "1",
  MENDPOINT_WARDEN_MODEL_SOURCE_TENANTS: "tenant_default",
  MENDPOINT_WARDEN_MODEL_PROVIDER: "openai-compatible",
  MENDPOINT_WARDEN_EXTERNAL_PROCESSING_ALLOWED: "1",
  MENDPOINT_WARDEN_MODEL_REGION: "us-central",
  MENDPOINT_WARDEN_MODEL_MAXIMUM_DATA_CLASSIFICATION: "confidential",
  MENDPOINT_WARDEN_MODEL_ESTIMATED_COST_USD: "0.25",
  MENDPOINT_WARDEN_MODEL_MAXIMUM_CALL_COST_USD: "1.00",
  MENDPOINT_WARDEN_REPOSITORY_CLASSIFICATIONS: '{"tenant_default/repo":"confidential"}',
  MENDPOINT_TRANSFORMER_ENABLED: "0",
  MENDPOINT_TRANSFORMER_ADAPTIVE_MODEL_SOURCE_ENABLED: "0",
  MENDPOINT_BACKUP_TRANSPORT: "pre_mounted",
  TRUST_PROXY_SECRET: "preflight-test-proxy-secret",
  WEB_URL: "https://console.example",
  CORS_ORIGINS: "https://console.example",
  MENDPOINT_WEB_ALLOWED_ORIGINS: "https://console.example",
  OIDC_ISSUER: "https://identity.example",
  OIDC_AUDIENCE: "mendpoint-api",
  OIDC_JWKS_URI: "https://identity.example/.well-known/jwks.json",
  OIDC_CLIENT_ID: "mendpoint-web",
  OIDC_CLIENT_SECRET: "preflight-test-oidc-secret",
  OIDC_REDIRECT_URI: "https://console.example/api/oidc/callback",
  OIDC_TENANT_CLAIM: "tenant_id",
  OIDC_REQUIRED_AMR: "mfa",
  LLM_AGENT_MODEL: "test-model",
  LLM_AGENT_URL: "https://models.example/v1",
  OPENAI_API_KEY: "preflight-test-model-key",
} satisfies NodeJS.ProcessEnv;

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("customer launcher preflight", () => {
  it("blocks bootstrap and child startup while a customer backup is exclusive", () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-start-fence-"));
    temporaryRoots.push(parent);
    const dataRoot = join(parent, "data");
    const backupSourceRoot = join(dataRoot, "db");
    const fenceRoot = join(backupSourceRoot, "backup-fence");
    const databasePath = join(dataRoot, "db", "mendpoint.sqlite");
    mkdirSync(fenceRoot, { recursive: true });
    writeFileSync(join(fenceRoot, "exclusive.json"), "{}\n");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...CUSTOMER_WARDEN_ENV,
      NODE_ENV: "production",
      MENDPOINT_APP_ROOT: repoRoot,
      MENDPOINT_VOLUME_ROOT: dataRoot,
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      MENDPOINT_DEPLOYMENT_CLASS: "customer",
      MENDPOINT_FEED_POLLING_ENABLED: "1",
      MENDPOINT_PILOT_SEED: "0",
      POLL_LOCAL_ONLY: "0",
      GITHUB_MODE: "real",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      GITHUB_APP_ACCOUNT_TENANT_BINDINGS: '{"7123456":"tenant_default"}',
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
      MENDPOINT_API_KEY: `me_${"a".repeat(32)}`,
      MENDPOINT_WEB_ACCESS_TOKEN: "preflight-test-web-token",
      MENDPOINT_APPLICATION_DATA_KEY: "preflight-test-data-key",
      MENDPOINT_DATA_DIR: join(dataRoot, "db"),
      MENDPOINT_REPOS_DIR: join(dataRoot, "repos"),
      GRAPH_LEARN_DB: join(dataRoot, "db", "graph-learn.sqlite"),
      MENDPOINT_BACKUP_SOURCE_ROOT: backupSourceRoot,
      MENDPOINT_BACKUP_OUTPUT_ROOT: join(parent, "backups"),
      MENDPOINT_BACKUP_FENCE_ROOT: fenceRoot,
      MENDPOINT_BACKUP_EVIDENCE_PATH: join(backupSourceRoot, "backup-state", "last-verified.json"),
      MENDPOINT_BACKUP_STORAGE_CLASS: "durable_isolated_mount",
      MENDPOINT_BACKUP_KEY: "11".repeat(32),
      MENDPOINT_BACKUP_KEY_ID: "customer-backup-key-v1",
      MENDPOINT_BACKUP_DATABASE_PATH: "mendpoint.sqlite",
      MENDPOINT_BACKUP_GRAPH_PATH: "graph-learn.sqlite",
      MENDPOINT_BACKUP_CHANGE_SOURCES_PATH: "change-sources.sqlite",
      MENDPOINT_BACKUP_TRANSFORMER_CONTROL_PLANE_PATH: "transformer-control-plane.sqlite",
      MENDPOINT_BACKUP_TRANSFORMER_PILOT_PATH: "transformer-pilot.sqlite",
      MENDPOINT_BACKUP_ARTIFACTS_PATH: ".",
      MENDPOINT_BACKUP_CONFIGURATION_PATH: "recovery.json",
    };
    delete env.DATABASE_URL;
    expect(() => customerBackupInputFromEnv(env)).not.toThrow();
    expect(validateApiEnv({
      ...env,
      API_AUTH: "required",
    }).errors).toEqual([]);

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(repoRoot, "scripts", "start-fly.mjs")],
      { cwd: repoRoot, env, encoding: "utf8", timeout: 30_000 },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "customer_startup_blocked_by_backup",
    );
    expect(existsSync(databasePath)).toBe(false);
  });

  it("fails before creating persistent state when full customer validation fails", () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-start-preflight-"));
    temporaryRoots.push(parent);
    const dataRoot = join(parent, "must-not-exist");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...CUSTOMER_WARDEN_ENV,
      NODE_ENV: "production",
      MENDPOINT_APP_ROOT: repoRoot,
      MENDPOINT_VOLUME_ROOT: dataRoot,
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      MENDPOINT_DEPLOYMENT_CLASS: "customer",
      MENDPOINT_FEED_POLLING_ENABLED: "1",
      MENDPOINT_PILOT_SEED: "0",
      POLL_LOCAL_ONLY: "0",
      GITHUB_MODE: "real",
      MENDPOINT_API_KEY: "preflight-test-api-key",
      MENDPOINT_WEB_ACCESS_TOKEN: "preflight-test-web-token",
      MENDPOINT_APPLICATION_DATA_KEY: "preflight-test-data-key",
    };
    for (const name of [
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_PRIVATE_KEY_PATH",
      "GITHUB_WEBHOOK_SECRET",
      "GITHUB_APP_ACCOUNT_TENANT_BINDINGS",
      "GITHUB_APP_OWNER_TENANT_BINDINGS",
    ]) {
      delete env[name];
    }

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(repoRoot, "scripts", "start-fly.mjs")],
      { cwd: repoRoot, env, encoding: "utf8", timeout: 30_000 },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Customer Warden profile requires GITHUB_APP_ID");
    expect(existsSync(dataRoot)).toBe(false);
  });

  it("rejects an unsafe backup root before privileged startup creates customer paths", () => {
    const parent = mkdtempSync(join(tmpdir(), "mendpoint-start-path-safety-"));
    temporaryRoots.push(parent);
    const dataRoot = join(parent, "must-not-exist", "data");
    const backupSourceRoot = join(dataRoot, "db");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...CUSTOMER_WARDEN_ENV,
      NODE_ENV: "production",
      API_AUTH: "required",
      MENDPOINT_APP_ROOT: repoRoot,
      MENDPOINT_VOLUME_ROOT: dataRoot,
      MENDPOINT_DEPLOYMENT_PROFILE: "customer",
      MENDPOINT_DEPLOYMENT_CLASS: "customer",
      MENDPOINT_FEED_POLLING_ENABLED: "1",
      MENDPOINT_PILOT_SEED: "0",
      POLL_LOCAL_ONLY: "0",
      GITHUB_MODE: "real",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      GITHUB_APP_ACCOUNT_TENANT_BINDINGS: '{"7123456":"tenant_default"}',
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
      MENDPOINT_API_KEY: `me_${"a".repeat(32)}`,
      MENDPOINT_WEB_ACCESS_TOKEN: "preflight-test-web-token",
      MENDPOINT_APPLICATION_DATA_KEY: "preflight-test-data-key",
      MENDPOINT_DATA_DIR: backupSourceRoot,
      MENDPOINT_REPOS_DIR: join(dataRoot, "repos"),
      GRAPH_LEARN_DB: join(backupSourceRoot, "graph-learn.sqlite"),
      MENDPOINT_BACKUP_SOURCE_ROOT: backupSourceRoot,
      MENDPOINT_BACKUP_OUTPUT_ROOT: parse(parent).root,
      MENDPOINT_BACKUP_FENCE_ROOT: join(backupSourceRoot, ".backup-fence"),
      MENDPOINT_BACKUP_EVIDENCE_PATH: join(backupSourceRoot, ".backup-state", "last-verified.json"),
      MENDPOINT_BACKUP_STORAGE_CLASS: "durable_isolated_mount",
      MENDPOINT_BACKUP_KEY: "11".repeat(32),
      MENDPOINT_BACKUP_KEY_ID: "customer-backup-key-v1",
      MENDPOINT_BACKUP_DATABASE_PATH: "mendpoint.sqlite",
      MENDPOINT_BACKUP_GRAPH_PATH: "graph-learn.sqlite",
      MENDPOINT_BACKUP_CHANGE_SOURCES_PATH: "change-sources.sqlite",
      MENDPOINT_BACKUP_TRANSFORMER_CONTROL_PLANE_PATH: "transformer-control-plane.sqlite",
      MENDPOINT_BACKUP_TRANSFORMER_PILOT_PATH: "transformer-pilot.sqlite",
      MENDPOINT_BACKUP_ARTIFACTS_PATH: ".",
      MENDPOINT_BACKUP_CONFIGURATION_PATH: "recovery.json",
    };
    delete env.DATABASE_URL;

    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(repoRoot, "scripts", "start-fly.mjs")],
      { cwd: repoRoot, env, encoding: "utf8", timeout: 30_000 },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("customer_backup_output_root_unsafe");
    expect(existsSync(dataRoot)).toBe(false);
  });
});
