import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  initializeWithMutationLease,
  validateCustomerBackupPathSafety,
} from "@mendpoint/ops";

const dataRoot = resolve(process.env.MENDPOINT_VOLUME_ROOT ?? "/data");
const tenantId = process.env.MENDPOINT_TENANT_ID ?? "tenant_default";
const reposRoot = resolve(process.env.MENDPOINT_REPOS_DIR ?? `${dataRoot}/repos`);
const tenantRepos = resolve(reposRoot, tenantId);
const appRoot = resolve(process.env.MENDPOINT_APP_ROOT ?? "/app");
const deploymentProfile = process.env.MENDPOINT_DEPLOYMENT_PROFILE;
const childIdentity = process.platform === "win32" ? {} : { uid: 1000, gid: 1000 };

if (!["demo", "pilot", "customer"].includes(deploymentProfile)) {
  throw new Error(
    "MENDPOINT_DEPLOYMENT_PROFILE must be explicitly set to demo, pilot, or customer",
  );
}
if (!process.env.MENDPOINT_API_KEY?.trim()) {
  throw new Error("MENDPOINT_API_KEY is required");
}
if (!process.env.MENDPOINT_WEB_ACCESS_TOKEN?.trim()) {
  throw new Error("MENDPOINT_WEB_ACCESS_TOKEN is required");
}
if (!process.env.MENDPOINT_APPLICATION_DATA_KEY?.trim()) {
  throw new Error("MENDPOINT_APPLICATION_DATA_KEY is required");
}
if (deploymentProfile === "customer") {
  const unsafe = [
    process.env.GITHUB_MODE !== "real" ? "GITHUB_MODE=real" : null,
    process.env.MENDPOINT_DEPLOYMENT_CLASS !== "customer"
      ? "MENDPOINT_DEPLOYMENT_CLASS=customer"
      : null,
    process.env.MENDPOINT_FEED_POLLING_ENABLED !== "1"
      ? "MENDPOINT_FEED_POLLING_ENABLED=1"
      : null,
    process.env.POLL_LOCAL_ONLY !== "0" ? "POLL_LOCAL_ONLY=0" : null,
    process.env.MENDPOINT_PILOT_SEED !== "0" ? "MENDPOINT_PILOT_SEED=0" : null,
  ].filter(Boolean);
  if (unsafe.length) {
    throw new Error(`Customer deployment profile requires ${unsafe.join(", ")}`);
  }
}

const childEnv = {
  ...process.env,
  NODE_ENV: "production",
  API_AUTH: "required",
  API_HOST: "127.0.0.1",
  API_PORT: process.env.API_PORT ?? "3001",
  HOSTNAME: "0.0.0.0",
  PORT: process.env.PORT ?? "3000",
  MENDPOINT_DATA_DIR: process.env.MENDPOINT_DATA_DIR ?? resolve(dataRoot, "db"),
  MENDPOINT_REPOS_DIR: reposRoot,
  MENDPOINT_API_URL: process.env.MENDPOINT_API_URL ?? "http://127.0.0.1:3001",
  MENDPOINT_BOOTSTRAP_API_KEY: process.env.MENDPOINT_API_KEY,
  MENDPOINT_WORKER_HEARTBEAT_PATH:
    process.env.MENDPOINT_WORKER_HEARTBEAT_PATH ??
    resolve(dataRoot, "state", "worker-heartbeat.json"),
  GRAPH_LEARN_DB:
    process.env.GRAPH_LEARN_DB ?? resolve(dataRoot, "db", "graph-learn.sqlite"),
  MENDPOINT_ALERTS_PATH:
    process.env.MENDPOINT_ALERTS_PATH ?? resolve(dataRoot, "state", "alerts.jsonl"),
};

const customerBackupPaths = deploymentProfile === "customer"
  ? validateCustomerBackupPathSafety({
      sourceRoot: process.env.MENDPOINT_BACKUP_SOURCE_ROOT,
      outputRoot: process.env.MENDPOINT_BACKUP_OUTPUT_ROOT,
      fenceRoot: process.env.MENDPOINT_BACKUP_FENCE_ROOT,
      evidencePath: process.env.MENDPOINT_BACKUP_EVIDENCE_PATH,
      dataRoot: childEnv.MENDPOINT_DATA_DIR,
    })
  : null;

const preflight = spawnSync(
  process.execPath,
  ["--import", "tsx", "scripts/validate-runtime-env.ts"],
  {
    cwd: appRoot,
    env: childEnv,
    stdio: "inherit",
    ...childIdentity,
  },
);
if (preflight.status !== 0) {
  throw new Error("Runtime environment validation failed before startup");
}

initializeWithMutationLease(() => {
const customerOwnedPaths = customerBackupPaths
  ? [
      customerBackupPaths.outputRoot,
      customerBackupPaths.fenceRoot,
      resolve(customerBackupPaths.fenceRoot, "writers"),
      customerBackupPaths.evidenceDirectory,
      ...[
        "warden-candidates",
        "warden-evidence",
        "transformer-candidates",
        "transformer-evidence",
      ].map((name) => resolve(childEnv.MENDPOINT_DATA_DIR, name)),
    ]
  : [];

for (const path of [
  dataRoot,
  resolve(dataRoot, "db"),
  reposRoot,
  tenantRepos,
  resolve(dataRoot, "runs"),
  resolve(dataRoot, "state"),
  resolve(dataRoot, "state", "mendpoint"),
  ...customerOwnedPaths,
]) {
  mkdirSync(path, { recursive: true });
  chownSync(path, 1000, 1000);
  if (customerOwnedPaths.includes(path)) chmodSync(path, 0o700);
}

function runSetup(args, extraEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: appRoot,
    env: { ...childEnv, ...extraEnv },
    stdio: "inherit",
    ...childIdentity,
  });
  if (result.status !== 0) {
    throw new Error(`Setup command failed: ${args.join(" ")}`);
  }
}

function chownTree(path) {
  const stat = lstatSync(path);
  chownSync(path, 1000, 1000);
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(path)) chownTree(resolve(path, entry));
}

runSetup(["--import", "tsx", "scripts/bootstrap-key.ts"]);

if (process.env.MENDPOINT_PILOT_SEED === "1") {
  const demoRepo = resolve(tenantRepos, "shop-app");
  if (!existsSync(demoRepo)) {
    cpSync(resolve(appRoot, "fixtures", "consumers", "shop-app"), demoRepo, { recursive: true });
    chownTree(demoRepo);
  }
  const demoVerifier = resolve(demoRepo, "check.mjs");
  if (!existsSync(demoVerifier)) {
    cpSync(resolve(appRoot, "fixtures", "consumers", "shop-app", "check.mjs"), demoVerifier);
    chownSync(demoVerifier, 1000, 1000);
  }
  runSetup(["--import", "tsx", "scripts/seed.ts"], {
    MENDPOINT_SEED_REPO_PATH: demoRepo,
  });
}

const children = new Map();
let stopping = false;

function start(name, args, cwd = appRoot) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: childEnv,
    stdio: "inherit",
    ...childIdentity,
  });
  children.set(name, child);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`${name} exited code=${code ?? "none"} signal=${signal ?? "none"}`);
    shutdown(code ?? 1);
  });
}

function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) child.kill("SIGTERM");
  const timer = setTimeout(() => {
    for (const child of children.values()) child.kill("SIGKILL");
    process.exit(exitCode);
  }, 25_000);
  timer.unref();
  Promise.all(
    [...children.values()].map(
      (child) => new Promise((resolveChild) => child.once("exit", resolveChild)),
    ),
  ).finally(() => process.exit(exitCode));
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

start("api", ["--import", "tsx", "apps/api/src/server.ts"]);
start("worker", [
  "--import",
  "tsx",
  "apps/worker/src/cli.ts",
  "run-service",
  "--interval",
  process.env.POLL_INTERVAL_MS ?? "5000",
]);
start("web", ["start-production.mjs"], "/web");
}, childEnv);
