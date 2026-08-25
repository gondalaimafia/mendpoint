import type { VerifierCriterion, VerifierProduct, VerifierRolloutMode, VerifierScoringMode } from "./types.js";
import { deepFreeze, fail } from "./utils.js";

export type DisabledVerifierRuntimeConfig = Readonly<{ enabled: false; rolloutMode: "off" }>;
export type EnabledVerifierRuntimeConfig = Readonly<{
  enabled: true;
  schemaVersion: "2026-08-17.config.v1";
  rolloutMode: VerifierRolloutMode;
  provider: "deepseek";
  model: "deepseek-v4-flash";
  baseUrl: string;
  credentialEnvName: "DEEPSEEK_API_KEY";
  evaluations: number;
  pivots: number;
  scoringMode: Exclude<VerifierScoringMode, "muse_self">;
  maximumCandidates: number;
  maximumCostUsd: number;
  timeoutMs: number;
  maximumRetries: number;
}>;
export type VerifierRuntimeConfig = DisabledVerifierRuntimeConfig | EnabledVerifierRuntimeConfig;

function integer(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) fail(`verifier_config_${name.toLowerCase()}_invalid`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`verifier_config_${name.toLowerCase()}_invalid`);
  return value;
}

function decimal(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(raw)) fail(`verifier_config_${name.toLowerCase()}_invalid`);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) fail(`verifier_config_${name.toLowerCase()}_invalid`);
  return value;
}

function resolveBaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env.MENDPOINT_AGENT_VERIFIER_BASE_URL?.trim();
  if (raw === undefined || raw === "") return "https://api.deepseek.com";
  let parsed: URL;
  try { parsed = new URL(raw); } catch { fail("verifier_config_base_url_invalid"); }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    fail("verifier_config_base_url_invalid");
  }
  return raw;
}

export function resolveVerifierRuntimeConfig(env: Readonly<Record<string, string | undefined>>): VerifierRuntimeConfig {
  const enabled = env.DEEPSEEK_VERIFIER_ENABLED?.trim();
  if (enabled === undefined || enabled === "" || enabled === "false") return Object.freeze({ enabled: false, rolloutMode: "off" });
  if (enabled !== "true") fail("verifier_config_enabled_invalid");
  const rolloutMode = (env.MENDPOINT_AGENT_VERIFIER_ROLLOUT_MODE?.trim() || "advisory") as VerifierRolloutMode;
  if (!["off", "offline", "shadow", "advisory", "selective", "automated"].includes(rolloutMode)) fail("verifier_config_rollout_invalid");
  const scoringMode = (env.MENDPOINT_AGENT_VERIFIER_SCORING_MODE?.trim() || "nonthinking_logprobs") as Exclude<VerifierScoringMode, "muse_self">;
  if (scoringMode !== "nonthinking_logprobs" && scoringMode !== "upstream_thinking_logprobs") fail("verifier_config_scoring_mode_invalid");
  return deepFreeze({
    enabled: true as const,
    schemaVersion: "2026-08-17.config.v1" as const,
    rolloutMode,
    provider: "deepseek" as const,
    model: "deepseek-v4-flash" as const,
    baseUrl: resolveBaseUrl(env),
    credentialEnvName: "DEEPSEEK_API_KEY" as const,
    evaluations: integer(env, "MENDPOINT_AGENT_VERIFIER_EVALUATIONS", 4, 1, 16),
    pivots: integer(env, "MENDPOINT_AGENT_VERIFIER_PIVOTS", 2, 1, 16),
    scoringMode,
    maximumCandidates: integer(env, "MENDPOINT_AGENT_VERIFIER_MAXIMUM_CANDIDATES", 5, 1, 20),
    maximumCostUsd: decimal(env, "MENDPOINT_AGENT_VERIFIER_MAXIMUM_COST_USD", 0.25, 0.000001, 100),
    timeoutMs: integer(env, "MENDPOINT_AGENT_VERIFIER_TIMEOUT_MS", 30_000, 1, 120_000),
    maximumRetries: integer(env, "MENDPOINT_AGENT_VERIFIER_MAXIMUM_RETRIES", 1, 0, 3),
  });
}

const FETTLER = [
  { id: "semantic_migration_correctness", title: "Semantic migration correctness", description: "The API migration preserves semantics and updates every evidenced affected use.", hard: false, weight: 1 },
  { id: "blast_radius_correctness", title: "Blast radius correctness", description: "The candidate accounts for the exact graph and repository impact evidence.", hard: false, weight: 1 },
  { id: "verification_strength", title: "Verification strength", description: "The evidence meaningfully checks the claimed behavior and identifies gaps.", hard: false, weight: 1 },
] as const satisfies readonly VerifierCriterion[];

const REGAUGE = [
  { id: "architecture_correctness", title: "Architecture correctness", description: "The staged legacy migration respects the current architecture and target state.", hard: false, weight: 1 },
  { id: "migration_safety", title: "Migration safety", description: "The sequence is bounded, reversible, and does not skip required stage gates.", hard: false, weight: 1 },
  { id: "behavior_preservation", title: "Behavior preservation", description: "The candidate preserves verified legacy behavior unless the objective explicitly changes it.", hard: false, weight: 1 },
] as const satisfies readonly VerifierCriterion[];

export function criteriaForProduct(product: VerifierProduct): readonly VerifierCriterion[] {
  if (product !== "fettler" && product !== "regauge") fail("verifier_product_invalid");
  return deepFreeze([...(product === "fettler" ? FETTLER : REGAUGE)]);
}
