/**
 * Production environment validation.
 * Fails fast in production when required knobs are missing.
 */
export type EnvReport = {
  ok: boolean;
  mode: "development" | "production" | "test";
  errors: string[];
  warnings: string[];
  values: Record<string, string | undefined>;
};

export function nodeEnv(): "development" | "production" | "test" {
  const e = (process.env.NODE_ENV ?? "development").toLowerCase();
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
  const mode = nodeEnv();
  const errors: string[] = [];
  const warnings: string[] = [];
  const values: Record<string, string | undefined> = {
    NODE_ENV: env.NODE_ENV,
    API_PORT: env.API_PORT,
    API_AUTH: env.API_AUTH,
    DATABASE_URL: env.DATABASE_URL,
    WEB_URL: env.WEB_URL,
    GITHUB_MODE: env.GITHUB_MODE,
    CORS_ORIGINS: env.CORS_ORIGINS,
  };

  if (mode === "production") {
    const auth = (env.API_AUTH ?? "").toLowerCase();
    if (auth !== "required" && auth !== "on" && auth !== "true") {
      errors.push(
        "API_AUTH must be 'required' in production (set API_AUTH=required)",
      );
    }
    if (!env.DATABASE_URL && !env.MENDPOINT_DATA_DIR) {
      warnings.push(
        "DATABASE_URL / MENDPOINT_DATA_DIR unset — using default ./data (ensure volume mount)",
      );
    }
    if ((env.GITHUB_MODE ?? "mock") === "mock") {
      warnings.push(
        "GITHUB_MODE=mock — real PRs disabled (ok for private/self-hosted demos)",
      );
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
