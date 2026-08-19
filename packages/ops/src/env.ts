/**
 * Production environment validation.
 * Fails fast in production when required knobs are missing.
 */
import { isAbsolute } from "node:path";
import {
  loadAppCredentials,
  parseGitHubAccountTenantBindings,
} from "@mendpoint/github";
import { assessModelEgress } from "@mendpoint/shared";
import { customerBackupInputFromEnv } from "./disaster-recovery.js";

export type EnvReport = {
  ok: boolean;
  mode: "development" | "production" | "test";
  errors: string[];
  warnings: string[];
  values: Record<string, string | undefined>;
};

export type DeploymentProfile = "demo" | "pilot" | "customer" | "transformer_pilot";

const DEPLOYMENT_PROFILES = new Set<DeploymentProfile>([
  "demo",
  "pilot",
  "customer",
  "transformer_pilot",
]);

export function deploymentProfile(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentProfile | null {
  const value = env.MENDPOINT_DEPLOYMENT_PROFILE;
  return value && DEPLOYMENT_PROFILES.has(value as DeploymentProfile)
    ? value as DeploymentProfile
    : null;
}

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
    MENDPOINT_MODEL_EGRESS: env.MENDPOINT_MODEL_EGRESS,
    MENDPOINT_MODEL_LOCAL_HOSTS: env.MENDPOINT_MODEL_LOCAL_HOSTS,
    LLM_AGENT_URL: env.LLM_AGENT_URL,
    MENDPOINT_DEPLOYMENT_PROFILE: env.MENDPOINT_DEPLOYMENT_PROFILE,
    MENDPOINT_DEPLOYMENT_CLASS: env.MENDPOINT_DEPLOYMENT_CLASS,
    MENDPOINT_SANDBOX_FLY_MODE: env.MENDPOINT_SANDBOX_FLY_MODE,
    MENDPOINT_FEED_POLLING_ENABLED: env.MENDPOINT_FEED_POLLING_ENABLED,
    POLL_LOCAL_ONLY: env.POLL_LOCAL_ONLY,
    MENDPOINT_PILOT_SEED: env.MENDPOINT_PILOT_SEED,
    MENDPOINT_TENANT_ID: env.MENDPOINT_TENANT_ID,
    MENDPOINT_BACKUP_OUTPUT_ROOT: env.MENDPOINT_BACKUP_OUTPUT_ROOT,
    MENDPOINT_BACKUP_EVIDENCE_PATH: env.MENDPOINT_BACKUP_EVIDENCE_PATH,
    MENDPOINT_BACKUP_STORAGE_CLASS: env.MENDPOINT_BACKUP_STORAGE_CLASS,
    MENDPOINT_BACKUP_KEY: env.MENDPOINT_BACKUP_KEY ? "[set]" : undefined,
    MENDPOINT_BACKUP_KEY_ID: env.MENDPOINT_BACKUP_KEY_ID,
    GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET ? "[set]" : undefined,
    GITHUB_TOKEN: env.GITHUB_TOKEN ? "[set]" : undefined,
    GITHUB_APP_ID: env.GITHUB_APP_ID,
    GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY ? "[set]" : undefined,
    GITHUB_APP_PRIVATE_KEY_PATH: env.GITHUB_APP_PRIVATE_KEY_PATH,
    GITHUB_APP_ACCOUNT_TENANT_BINDINGS: env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS
      ? "[set]"
      : undefined,
    GITHUB_APP_OWNER_TENANT_BINDINGS: env.GITHUB_APP_OWNER_TENANT_BINDINGS
      ? "[legacy_forbidden]"
      : undefined,
    CORS_ORIGINS: env.CORS_ORIGINS,
    TRUST_PROXY: env.TRUST_PROXY,
    TRUST_PROXY_SECRET: env.TRUST_PROXY_SECRET ? "[set]" : undefined,
  };

  // Enforced no-egress mode: fail fast at boot when local_only is configured
  // but an external model endpoint would be used, rather than at first run.
  const egress = assessModelEgress(env);
  if (egress.violation === "model_egress_mode_invalid") {
    errors.push(
      "MENDPOINT_MODEL_EGRESS must be exactly local_only or external_allowed",
    );
  } else if (egress.violation === "model_egress_local_only_violation") {
    errors.push(
      "MENDPOINT_MODEL_EGRESS=local_only forbids an external model endpoint; every configured model endpoint (LLM_AGENT_URL, LLM_REPAIR_URL, OPENAI_API_BASE, XAI_API_BASE, or the selected provider base URL) must resolve to a private, loopback, link-local, or allowlisted host",
    );
  } else if (egress.violation === "warden_model_endpoint_invalid") {
    errors.push(
      "Each configured model endpoint (LLM_AGENT_URL, LLM_REPAIR_URL, OPENAI_API_BASE, XAI_API_BASE) must be a valid URL when MENDPOINT_MODEL_EGRESS=local_only",
    );
  }

  const githubMode =
    env.GITHUB_MODE ?? (mode === "production" ? "" : "mock");
  const profile = deploymentProfile(env);
  if (mode === "production" && !env.MENDPOINT_DEPLOYMENT_PROFILE?.trim()) {
    errors.push(
      "MENDPOINT_DEPLOYMENT_PROFILE must be explicitly set to demo, pilot, customer, or transformer_pilot in production",
    );
  } else if (env.MENDPOINT_DEPLOYMENT_PROFILE?.trim() && !profile) {
    errors.push(
      "MENDPOINT_DEPLOYMENT_PROFILE must be exactly demo, pilot, customer, or transformer_pilot",
    );
  }
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
    if (profile === "customer") {
      if (githubMode !== "real") {
        errors.push("Customer deployment profile requires GITHUB_MODE=real");
      }
      // Every network-fence control is gated on MENDPOINT_SANDBOX_KIND=fly_machines;
      // any other kind (local, vm, in_cluster) runs customer code on the worker host
      // with no egress fence. resolveSandboxKind defaults to local when unset, so this
      // must be asserted explicitly or a customer deploy passes preflight unfenced.
      if (env.MENDPOINT_SANDBOX_KIND?.trim() !== "fly_machines") {
        errors.push(
          "Customer deployment profile requires MENDPOINT_SANDBOX_KIND=fly_machines; other sandbox kinds run customer code on the worker host with no network fence",
        );
      }
      if (env.MENDPOINT_DEPLOYMENT_CLASS !== "customer") {
        errors.push(
          "Customer deployment profile requires MENDPOINT_DEPLOYMENT_CLASS=customer",
        );
      }
      if (env.MENDPOINT_FEED_POLLING_ENABLED !== "1") {
        errors.push(
          "Customer deployment profile requires MENDPOINT_FEED_POLLING_ENABLED=1",
        );
      }
      if (env.POLL_LOCAL_ONLY !== "0") {
        errors.push("Customer deployment profile requires POLL_LOCAL_ONLY=0");
      }
      if (env.MENDPOINT_PILOT_SEED !== "0") {
        errors.push("Customer deployment profile requires MENDPOINT_PILOT_SEED=0");
      }
      try {
        customerBackupInputFromEnv(env);
      } catch {
        errors.push(
          "Customer deployment profile requires complete isolated application-consistent backup configuration",
        );
      }
    }
    if (githubMode === "mock") {
      warnings.push(
        "GITHUB_MODE=mock — real PRs disabled (ok for private/self-hosted demos)",
      );
    } else if (githubMode === "real") {
      const hasAnyAppCredential = Boolean(
        env.GITHUB_APP_ID?.trim() ||
        env.GITHUB_APP_PRIVATE_KEY?.trim() ||
        env.GITHUB_APP_PRIVATE_KEY_PATH?.trim(),
      );
      const appCredentials = loadAppCredentials(env);
      const deploymentClass = env.MENDPOINT_DEPLOYMENT_CLASS?.trim();
      if (deploymentClass !== "customer" && deploymentClass !== "disposable_canary") {
        errors.push(
          "MENDPOINT_DEPLOYMENT_CLASS must be customer or disposable_canary for real GitHub delivery",
        );
      }
      if (!env.GITHUB_WEBHOOK_SECRET) {
        errors.push(
          "GITHUB_WEBHOOK_SECRET is required when GITHUB_MODE=real in production",
        );
      }
      if (!appCredentials) {
        if (deploymentClass === "disposable_canary") {
          if (!env.GITHUB_TOKEN?.trim()) {
            errors.push("GITHUB_TOKEN is required for disposable canary PAT delivery");
          }
          if (!env.MENDPOINT_TENANT_ID?.trim()) {
            errors.push("MENDPOINT_TENANT_ID is required for disposable canary PAT delivery");
          }
        } else {
          errors.push(
            "Complete GitHub App credentials are required for customer production delivery",
          );
        }
      }
      if (hasAnyAppCredential && !appCredentials) {
        errors.push(
          "GitHub App credentials must include a positive app ID and a readable RSA private key",
        );
      }
      if (appCredentials) {
        try {
          if (env.GITHUB_APP_OWNER_TENANT_BINDINGS?.trim()) {
            throw new Error("legacy");
          }
          const bindings = parseGitHubAccountTenantBindings(
            env.GITHUB_APP_ACCOUNT_TENANT_BINDINGS,
          );
          if (bindings.size === 0) throw new Error("empty");
          if (new Set(bindings.values()).size !== bindings.size) {
            throw new Error("ambiguous");
          }
        } catch {
          errors.push(
            "GITHUB_APP_ACCOUNT_TENANT_BINDINGS must be a nonempty one-to-one JSON numeric account ID to tenant map; legacy login bindings are forbidden",
          );
        }
      }
    }
    // The sandbox backend must be chosen explicitly in production. resolveSandboxKind
    // silently defaults to "local" when MENDPOINT_SANDBOX_KIND is unset, so an absent
    // value is not a safe default: it disables the egress fence without any signal.
    // Refused here so an unset (or misspelled) kind is caught at boot, mirroring the
    // "GITHUB_MODE must be explicitly set" guard above.
    {
      const sandboxKind = env.MENDPOINT_SANDBOX_KIND?.trim();
      if (!sandboxKind) {
        errors.push(
          "MENDPOINT_SANDBOX_KIND must be explicitly set to fly_machines, local, vm, or in_cluster in production",
        );
      } else if (
        sandboxKind !== "fly_machines" &&
        sandboxKind !== "local" &&
        sandboxKind !== "vm" &&
        sandboxKind !== "in_cluster"
      ) {
        errors.push(
          "MENDPOINT_SANDBOX_KIND must be exactly fly_machines, local, vm, or in_cluster",
        );
      }
    }
    // Sandbox mock mode fabricates a passing verification: the mock Fly client
    // mints exit_code 0 without ever running the command, so it must never reach
    // a real deployment. Refused here — alongside the other production-mode
    // guards, so it is discoverable at boot and not only at the sandbox call
    // site. Mirrors the fail-closed shape used for GITHUB_MODE above.
    if (env.MENDPOINT_SANDBOX_FLY_MODE === "mock") {
      errors.push(
        "MENDPOINT_SANDBOX_FLY_MODE=mock is forbidden in production; the mock sandbox reports a passing verification without executing the command; unset it and wire a real Fly sandbox token",
      );
    }
    if (env.MENDPOINT_SANDBOX_KIND?.trim() === "fly_machines") {
      const requiredSandboxAuthority = [
        "MENDPOINT_SANDBOX_FLY_APP",
        "MENDPOINT_SANDBOX_FLY_TOKEN",
        "MENDPOINT_SANDBOX_FLY_IMAGE",
        "MENDPOINT_SANDBOX_EGRESS_ATTESTATION_BASE64",
        "MENDPOINT_SANDBOX_EGRESS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64",
        "MENDPOINT_SANDBOX_EGRESS_ATTESTATION_KEY_ID",
        "MENDPOINT_SANDBOX_EGRESS_POLICY_DIGEST",
      ] as const;
      for (const name of requiredSandboxAuthority) {
        if (!env[name]?.trim()) errors.push(`${name} is required when MENDPOINT_SANDBOX_KIND=fly_machines in production`);
      }
      if (
        env.MENDPOINT_SANDBOX_FLY_IMAGE?.trim() &&
        !/^[a-z0-9][a-z0-9./_-]{1,300}@sha256:[a-f0-9]{64}$/u.test(env.MENDPOINT_SANDBOX_FLY_IMAGE.trim())
      ) {
        errors.push("MENDPOINT_SANDBOX_FLY_IMAGE must be an immutable digest-pinned image in production");
      }
      if (
        env.MENDPOINT_SANDBOX_EGRESS_POLICY_DIGEST?.trim() &&
        !/^sha256:[a-f0-9]{64}$/u.test(env.MENDPOINT_SANDBOX_EGRESS_POLICY_DIGEST.trim())
      ) {
        errors.push("MENDPOINT_SANDBOX_EGRESS_POLICY_DIGEST must be a sha256 digest");
      }
      if (env.MENDPOINT_SANDBOX_ALLOW_UNPINNED_IMAGE === "1" || env.MENDPOINT_SANDBOX_ALLOW_UNPINNED_IMAGE === "true") {
        errors.push("MENDPOINT_SANDBOX_ALLOW_UNPINNED_IMAGE is forbidden in production");
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
