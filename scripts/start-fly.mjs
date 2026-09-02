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
import {
  customerWardenChildEnvironment,
  validateCustomerWardenRuntime,
} from "./customer-warden-profile.ts";
import {
  createRcloneCustomerObjectStoreTransport,
  loadCustomerObjectStoreConfig,
  probeCustomerObjectStore,
} from "./customer-object-store.ts";
import { reapStaleExclusiveFenceAtBoot } from "./customer-backup-scheduler.ts";
import { createChildSupervisor } from "./child-supervisor.ts";
import { runCustomerBootSequence } from "./customer-boot-sequence.ts";

const dataRoot = resolve(process.env.MENDPOINT_VOLUME_ROOT ?? "/data");
const tenantId = process.env.MENDPOINT_TENANT_ID ?? "tenant_default";
const reposRoot = resolve(process.env.MENDPOINT_REPOS_DIR ?? `${dataRoot}/repos`);
const tenantRepos = resolve(reposRoot, tenantId);
const appRoot = resolve(process.env.MENDPOINT_APP_ROOT ?? "/app");
const deploymentProfile = process.env.MENDPOINT_DEPLOYMENT_PROFILE;
const childIdentity =
  process.platform !== "win32" && process.getuid?.() === 0
    ? { uid: 1000, gid: 1000 }
    : {};

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
  const customerWardenErrors = validateCustomerWardenRuntime(process.env);
  if (customerWardenErrors.length) {
    throw new Error(customerWardenErrors.join(", "));
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

function environmentForRole(role) {
  if (deploymentProfile !== "customer") return childEnv;
  return customerWardenChildEnvironment(role, childEnv);
}

// Supervision policy lives in scripts/child-supervisor.ts so it can be executed
// by tests rather than asserted by scanning this file. See that module for why
// the backup scheduler is the one non-critical child.
const supervisor = createChildSupervisor();
const { children, startProcess } = supervisor;
const shutdown = (exitCode = 0) => supervisor.shutdown(exitCode);

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

const customerBackupPaths = deploymentProfile === "customer"
  ? validateCustomerBackupPathSafety({
      sourceRoot: process.env.MENDPOINT_BACKUP_SOURCE_ROOT,
      outputRoot: process.env.MENDPOINT_BACKUP_OUTPUT_ROOT,
      fenceRoot: process.env.MENDPOINT_BACKUP_FENCE_ROOT,
      evidencePath: process.env.MENDPOINT_BACKUP_EVIDENCE_PATH,
      dataRoot: childEnv.MENDPOINT_DATA_DIR,
    })
  : null;

async function verifyCustomerBackupObjectStore() {
  if (
    !customerBackupPaths ||
    process.env.MENDPOINT_BACKUP_TRANSPORT !== "rclone_s3"
  ) return;
  mkdirSync(customerBackupPaths.sourceRoot, { recursive: true, mode: 0o700 });
  mkdirSync(customerBackupPaths.outputRoot, { recursive: true, mode: 0o700 });
  const config = loadCustomerObjectStoreConfig(process.env);
  const transport = createRcloneCustomerObjectStoreTransport(config, environmentForRole("backup"));
  await probeCustomerObjectStore(config, transport, {
    machineId: process.env.FLY_MACHINE_ID?.trim() || "non-fly-customer",
  });
}

await verifyCustomerBackupObjectStore();

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
  for (const child of children.values()) child.kill("SIGTERM");
  throw new Error("Runtime environment validation failed before startup");
}

// The boot ORDER -- profile gate, dead-owner fence reap, mutation lease, children
// -- lives in scripts/customer-boot-sequence.ts so it can be executed by tests
// rather than asserted by scanning this file. A comment satisfies a regex exactly
// as well as running code does, which is how a deleted call once passed a scan.
runCustomerBootSequence({
  profile: deploymentProfile,
  fenceRoot: customerBackupPaths ? customerBackupPaths.fenceRoot : null,
  reapAtBoot: reapStaleExclusiveFenceAtBoot,
  withMutationLease: (run) => initializeWithMutationLease(run, childEnv),
  appRoot,
  webRoot: "/web",
  pollIntervalMs: process.env.POLL_INTERVAL_MS ?? "5000",
  startChild: (child) => {
    startProcess(child.name, process.execPath, child.args, {
      cwd: child.cwd,
      identity: childIdentity,
      env: environmentForRole(child.role),
      critical: child.critical,
    });
  },
  prepareInsideLease: () => {
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
    env: { ...environmentForRole("api"), ...extraEnv },
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
runSetup(["--import", "tsx", "scripts/bootstrap-scim-authority.ts"], {
  MENDPOINT_SCIM_BOOTSTRAP_AUTHORITIES_JSON:
    process.env.MENDPOINT_SCIM_BOOTSTRAP_AUTHORITIES_JSON,
});
delete childEnv.MENDPOINT_SCIM_BOOTSTRAP_AUTHORITIES_JSON;

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

  },
});

