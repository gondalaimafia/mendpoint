/**
 * Liveness / readiness probes for production orchestration.
 */
import { existsSync, accessSync, constants } from "node:fs";
import { dirname } from "node:path";
import { RELEASE, releaseBanner } from "./release.js";
import { validateApiEnv } from "./env.js";
import { featureMatrix } from "./features.js";

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
}): ProbeResult {
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
    "data/mendpoint.sqlite";
  try {
    const dir = dirname(dbPath);
    if (dir && dir !== ".") {
      accessSync(dir === "" ? "." : dir, constants.W_OK);
    }
    checks.push({ name: "data_dir_writable", ok: true, detail: dir || "." });
  } catch {
    // dir may not exist yet — try parent
    checks.push({
      name: "data_dir_writable",
      ok: true,
      detail: "will create on first write",
    });
  }

  if (opts?.dbPing) {
    try {
      const ok = opts.dbPing();
      checks.push({ name: "db_ping", ok, detail: ok ? "ok" : "ping failed" });
    } catch (e) {
      checks.push({
        name: "db_ping",
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  } else {
    checks.push({
      name: "db_file",
      ok: true,
      detail: existsSync(dbPath) ? "exists" : "will create",
    });
  }

  const fail = checks.some((c) => !c.ok);
  const degraded = env.warnings.length > 0 && !fail;

  return {
    status: fail ? "fail" : degraded ? "degraded" : "ok",
    checks,
    release: {
      version: RELEASE.version,
      channel: RELEASE.channel,
      product: RELEASE.product,
      banner: releaseBanner(),
    },
    features: featureMatrix(),
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    ts: new Date().toISOString(),
  };
}
