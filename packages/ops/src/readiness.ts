/**
 * Liveness / readiness probes for production orchestration.
 */
import { existsSync, accessSync, constants, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { assessModelEgress } from "@mendpoint/shared";
import { RELEASE, releaseBanner } from "./release.js";
import { validateApiEnv } from "./env.js";
import { featureMatrix } from "./features.js";
import { assessCustomerBackupReadiness } from "./disaster-recovery.js";
import { recordCounter, recordHistogram, startSpan } from "./telemetry.js";

export type ProbeResult = {
  status: "ok" | "degraded" | "fail";
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  release: {
    version: string;
    channel: string;
    product: string;
    banner: string;
  };
  features?: ReturnType<typeof featureMatrix>;
  modelEgress?: {
    mode: "local_only" | "external_allowed";
    localOnly: boolean;
    endpointConfigured: boolean;
    localOnlySatisfied: boolean;
  };
  uptimeSec: number;
  ts: string;
};

const startedAt = Date.now();

export function liveness(): ProbeResult {
  return {
    status: "ok",
    checks: [{ name: "process", ok: true }],
    release: {
      version: RELEASE.version,
      channel: RELEASE.channel,
      product: RELEASE.product,
      banner: releaseBanner(),
    },
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    ts: new Date().toISOString(),
  };
}

export function readiness(opts?: {
  dbPath?: string;
  dbPing?: () => boolean;
  schemaCheck?: () => boolean;
}): ProbeResult {
  const span = startSpan("ops.readiness");
  const startNs = Date.now();
  const checks: ProbeResult["checks"] = [];
  const env = validateApiEnv();
  checks.push({
    name: "env",
    ok: env.ok,
    detail: env.errors.join("; ") || env.warnings.join("; ") || "ok",
  });

  const dbPath =
    opts?.dbPath ??
    process.env.DATABASE_URL?.replace(/^file:/, "") ??
    (process.env.MENDPOINT_DATA_DIR
      ? join(process.env.MENDPOINT_DATA_DIR, "mendpoint.sqlite")
      : undefined) ??
    "data/mendpoint.sqlite";
  try {
    const dir = dirname(dbPath);
    let writableRoot = dir || ".";
    while (!existsSync(writableRoot)) {
      const parent = dirname(writableRoot);
      if (parent === writableRoot) break;
      writableRoot = parent;
    }
    if (!statSync(writableRoot).isDirectory()) {
      throw new Error("storage_root_not_directory");
    }
    accessSync(writableRoot, constants.W_OK);
    checks.push({ name: "data_dir_writable", ok: true, detail: "available" });
  } catch {
    checks.push({
      name: "data_dir_writable",
      ok: false,
      detail: "unavailable",
    });
  }

  if (opts?.dbPing) {
    try {
      const ok = opts.dbPing();
      checks.push({ name: "db_ping", ok, detail: ok ? "ok" : "ping failed" });
    } catch {
      checks.push({
        name: "db_ping",
        ok: false,
        detail: "failed",
      });
    }
  } else {
    checks.push({
      name: "db_file",
      ok: true,
      detail: existsSync(dbPath) ? "exists" : "will create",
    });
  }

  if (opts?.schemaCheck) {
    try {
      const ok = opts.schemaCheck();
      checks.push({ name: "db_schema", ok, detail: ok ? "valid" : "invalid" });
    } catch {
      checks.push({ name: "db_schema", ok: false, detail: "invalid" });
    }
  }

  if (process.env.MENDPOINT_DEPLOYMENT_PROFILE === "customer") {
    const backup = assessCustomerBackupReadiness(process.env);
    checks.push({
      name: "last_verified_backup",
      ok: backup.ok,
      detail: backup.detail,
    });
  }

  // Auditable model egress posture, so an operator can verify local_only mode.
  const egress = assessModelEgress(process.env);
  checks.push({
    name: "model_egress",
    ok: egress.violation === null,
    detail: egress.violation ?? egress.mode,
  });

  const fail = checks.some((c) => !c.ok);
  const degraded = env.warnings.length > 0 && !fail;
  const status = fail ? "fail" : degraded ? "degraded" : "ok";

  span.setAttribute("readiness.status", status);
  span.end(fail ? "error" : "ok");
  recordCounter("readiness_check_total", 1, { status });
  recordHistogram("readiness_check_duration_ms", Date.now() - startNs, { status });

  return {
    status,
    checks,
    release: {
      version: RELEASE.version,
      channel: RELEASE.channel,
      product: RELEASE.product,
      banner: releaseBanner(),
    },
    features: featureMatrix(),
    modelEgress: {
      mode: egress.mode,
      localOnly: egress.localOnly,
      endpointConfigured: egress.endpointConfigured,
      localOnlySatisfied: egress.localOnlySatisfied,
    },
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    ts: new Date().toISOString(),
  };
}
