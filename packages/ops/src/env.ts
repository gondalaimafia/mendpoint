/**
 * Production environment validation.
 * Fails fast in production when required knobs are missing.
 */
import { isAbsolute } from "node:path";

export type EnvReport = {
  ok: boolean;
  mode: "development" | "production" | "test";
  errors: string[];
  warnings: string[];
  values: Record<string, string | undefined>;
};

export function nodeEnv(
  env: NodeJS.ProcessEnv = process.env,
): "development" | "production" | "test" {
  const e = (env.NODE_ENV ?? "development").toLowerCase();
  if (e === "production") return "production";
  if (e === "test") return "test";
  return "development";
}

export function isProduction(): boolean {
  return nodeEnv() === "production";
}

/**
 * Validate env for API process.
 * Production requires API_AUTH=required (or on) and a stable data dir.
 */
export function validateApiEnv(env: NodeJS.ProcessEnv = process.env): EnvReport {
  const mode = nodeEnv(env);
  const errors: string[] = [];
  const warnings: string[] = [];
  const values: Record<string, string | undefined> = {
    NODE_ENV: env.NODE_ENV,
    API_PORT: env.API_PORT,
    API_AUTH: env.API_AUTH,
    DATABASE_URL: env.DATABASE_URL,
    MENDPOINT_DATA_DIR: env.MENDPOINT_DATA_DIR,
    MENDPOINT_REPOS_DIR: env.MENDPOINT_REPOS_DIR,
    WEB_URL: env.WEB_URL,
    GITHUB_MODE: env.GITHUB_MODE,
    GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET ? "[set]" : undefined,
    GITHUB_TOKEN: env.GITHUB_TOKEN ? "[set]" : undefined,
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY ? "[set]" : undefined,
    GITHUB_APP_PRIVATE_KEY_PATH: env.GITHUB_APP_PRIVATE_KEY_PATH,
    CORS_ORIGINS: env.CORS_ORIGINS,
    TRUST_PROXY: env.TRUST_PROXY,
    TRUST_PROXY_SECRET: env.TRUST_PROXY_SECRET ? "[set]" : undefined,
  };

  const githubMode =
    env.GITHUB_MODE ?? (mode === "production" ? "" : "mock");
  if (mode === "production" && !env.GITHUB_MODE) {
    errors.push("GITHUB_MODE must be explicitly set to 'mock' or 'real' in production");
  } else if (githubMode !== "mock" && githubMode !== "real") {
    errors.push("GITHUB_MODE must be exactly 'mock' or 'real'");
  }

  if (env.DATABASE_URL) {
    const raw = env.DATABASE_URL;
    const pathPart = raw.startsWith("file:") ? raw.slice("file:".length) : raw;
    if (!pathPart || raw.includes("\0") || (!raw.startsWith("file:") && raw.includes("://"))) {
      errors.push(
        "DATABASE_URL must be a SQLite file path or file: path; network database URLs are unsupported",
      );
    } else if (mode === "production" && !isAbsolute(pathPart)) {
      errors.push("DATABASE_URL must resolve to an absolute path in production");
    }
  }
  if (
    mode === "production" &&
    env.MENDPOINT_DATA_DIR &&
    !isAbsolute(env.MENDPOINT_DATA_DIR)
  ) {
    errors.push("MENDPOINT_DATA_DIR must be an absolute path in production");
  }

  if (mode === "production") {
    const auth = (env.API_AUTH ?? "").toLowerCase();
    if (auth !== "required" && auth !== "on" && auth !== "true") {
      errors.push(
        "API_AUTH must be 'required' in production (set API_AUTH=required)",
      );
    }
    if (!env.DATABASE_URL && !env.MENDPOINT_DATA_DIR) {
      errors.push(
        "DATABASE_URL or MENDPOINT_DATA_DIR is required in production for durable storage",
      );
    }
    if (!env.MENDPOINT_REPOS_DIR) {
      errors.push("MENDPOINT_REPOS_DIR is required in production");
    } else if (!isAbsolute(env.MENDPOINT_REPOS_DIR)) {
      errors.push("MENDPOINT_REPOS_DIR must be an absolute path in production");
    }
    if (env.TRUST_PROXY === "1" && !env.TRUST_PROXY_SECRET) {
      errors.push("TRUST_PROXY_SECRET is required when TRUST_PROXY=1 in production");
    }
    if (githubMode === "mock") {
      warnings.push(
        "GITHUB_MODE=mock — real PRs disabled (ok for private/self-hosted demos)",
      );
    } else if (githubMode === "real") {
      if (!env.GITHUB_WEBHOOK_SECRET) {
        errors.push(
          "GITHUB_WEBHOOK_SECRET is required when GITHUB_MODE=real in production",
        );
      }
      if (!env.GITHUB_TOKEN) {
        errors.push(
          "GITHUB_MODE=real requires GITHUB_TOKEN for production delivery",
        );
      }
    }
    if (!env.CORS_ORIGINS && !env.WEB_URL) {
      warnings.push("CORS_ORIGINS / WEB_URL unset — defaulting to localhost origins");
    }
  }

  return {
    ok: errors.length === 0,
    mode,
    errors,
    warnings,
    values,
  };
}

export function assertApiEnvOrExit(): EnvReport {
  const report = validateApiEnv();
  if (!report.ok && isProduction()) {
    console.error("[mendpoint] production env validation failed:");
    for (const e of report.errors) console.error("  -", e);
    process.exit(1);
  }
  for (const w of report.warnings) {
    console.warn("[mendpoint] warning:", w);
  }
  return report;
}
