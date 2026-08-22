import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  VERIFIER_SCHEMA_VERSION,
  createAgentVerifier,
  createDeepSeekVerifierBackend,
  createFetchVerifierTransport,
  createVerifierEvidencePack,
  resolveVerifierRuntimeConfig,
  type VerifierHttpTransport,
  type VerifierPricing,
} from "@mendpoint/verifier";

export type DeepSeekVerifierLiveSmokeReport = Readonly<{
  schemaVersion: "2026-08-22.deepseek-verifier-live-smoke.v1";
  model: string;
  scoringMode: string;
  status: "verified" | "failed";
  recommendation: string;
  failureCode: string | null;
  selectedCandidateId: string | null;
  candidateScore: number | null;
  usage: Readonly<{
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
  }>;
  estimatedCostUsd: number;
  latencyMs: number;
  telemetryDigest: string;
  evidencePackDigest: string;
  observedAt: string;
}>;

type LiveSmokeInput = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  observedAt?: string;
  transport?: VerifierHttpTransport;
}>;

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function pricingFromEnv(env: Readonly<Record<string, string | undefined>>): VerifierPricing {
  const raw = env.MENDPOINT_AGENT_VERIFIER_PRICING_JSON?.trim();
  if (!raw) throw new Error("deepseek_verifier_live_smoke_pricing_missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("deepseek_verifier_live_smoke_pricing_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("deepseek_verifier_live_smoke_pricing_invalid");
  }
  const value = parsed as Record<string, unknown>;
  const expected = ["cachedInputPerMillion", "currency", "effectiveAt", "inputPerMillion", "outputPerMillion", "version"];
  if (Object.keys(value).sort().join("\0") !== expected.join("\0") ||
    typeof value.version !== "string" || value.currency !== "USD" || typeof value.effectiveAt !== "string" ||
    typeof value.inputPerMillion !== "number" || typeof value.cachedInputPerMillion !== "number" ||
    typeof value.outputPerMillion !== "number") {
    throw new Error("deepseek_verifier_live_smoke_pricing_invalid");
  }
  return Object.freeze({
    version: value.version,
    currency: "USD",
    effectiveAt: value.effectiveAt,
    inputPerMillion: value.inputPerMillion,
    cachedInputPerMillion: value.cachedInputPerMillion,
    outputPerMillion: value.outputPerMillion,
  });
}

export async function runDeepSeekVerifierLiveSmoke(input: LiveSmokeInput = {}): Promise<DeepSeekVerifierLiveSmokeReport> {
  const env = input.env ?? process.env;
  const observedAt = input.observedAt ?? new Date().toISOString();
  const config = resolveVerifierRuntimeConfig(env);
  if (!config.enabled) throw new Error("deepseek_verifier_live_smoke_disabled");
  if (config.rolloutMode !== "shadow") throw new Error("deepseek_verifier_live_smoke_requires_shadow");
  if (config.scoringMode !== "nonthinking_logprobs") throw new Error("deepseek_verifier_live_smoke_requires_nonthinking_logprobs");
  const apiKey = env[config.credentialEnvName]?.trim();
  if (!apiKey) throw new Error("deepseek_verifier_live_smoke_key_missing");

  const repositoryContent = "export function answer(): number { return 42; }\n";
  const verificationContent = "The authoritative synthetic check requires answer() to return 42.";
  const candidateOutput = "Changed src/answer.ts so answer() returns 42.";
  const repositoryDigest = digest(repositoryContent);
  const verificationDigest = digest(verificationContent);
  const candidateDigest = digest(candidateOutput);
  const pack = createVerifierEvidencePack({
    schemaVersion: VERIFIER_SCHEMA_VERSION,
    tenantId: "deepseek_live_smoke",
    missionId: "deepseek_live_smoke",
    taskId: "fettler_synthetic_contract",
    product: "fettler",
    repositoryId: "synthetic_public_repository",
    snapshotDigest: digest("deepseek_live_smoke_snapshot"),
    objective: "Verify that the synthetic public candidate makes answer() return 42.",
    risk: "medium",
    governance: {
      dataClassification: "public",
      requiredRegion: "global",
      processingRegion: "global",
      externalModelAllowed: true,
      mayLeaveTenantBoundary: true,
      consentId: "synthetic_public_smoke",
      consentActive: true,
    },
    allowedChangedPaths: ["src/answer.ts"],
    criteria: [{
      id: "contract_correctness",
      title: "Contract correctness",
      description: "The candidate makes answer() return the required value 42.",
      hard: false,
      weight: 1,
    }],
    sources: [
      {
        id: "candidate_repository_excerpt",
        kind: "repository_excerpt",
        digest: repositoryDigest,
        locator: "src/answer.ts",
        content: repositoryContent,
      },
      {
        id: "authoritative_verification",
        kind: "verification",
        digest: verificationDigest,
        locator: "synthetic:answer-contract",
        content: verificationContent,
      },
    ],
    checks: [{
      id: "synthetic_contract_check",
      status: "passed",
      evidenceRefs: ["authoritative_verification", "candidate_repository_excerpt"],
      candidateIds: ["candidate-correct"],
    }],
    candidates: [{
      candidateId: "candidate-correct",
      artifactDigest: candidateDigest,
      kind: "completion",
      observableOutput: candidateOutput,
      changedPaths: ["src/answer.ts"],
      evidenceRefs: ["authoritative_verification", "candidate_repository_excerpt"],
      deterministicCheckIds: ["synthetic_contract_check"],
      hardCriterionResults: [],
    }],
    assembledAt: observedAt,
    assemblerVersion: "deepseek-verifier-live-smoke.v1",
  });

  const backend = createDeepSeekVerifierBackend({
    apiKey,
    transport: input.transport ?? createFetchVerifierTransport(),
    scoringMode: config.scoringMode,
    timeoutMs: config.timeoutMs,
    maximumRetries: config.maximumRetries,
    pricing: pricingFromEnv(env),
    baseUrl: config.baseUrl,
    env,
  });
  const verifier = createAgentVerifier({
    enabled: true,
    rolloutMode: "shadow",
    backend,
    evaluations: 1,
    pivots: 1,
    seed: 0,
    maximumCandidates: 1,
    maximumCostUsd: config.maximumCostUsd,
  });
  const result = await verifier.verify({
    pack,
    incumbentCandidateId: "candidate-correct",
    verificationAttemptId: "deepseek_live_smoke_attempt",
    observedAt,
  });
  const selectedCandidateId = result.suggestedCandidateId;
  const candidateScore = selectedCandidateId === null
    ? null
    : result.telemetry.candidateScores[selectedCandidateId] ?? null;
  return Object.freeze({
    schemaVersion: "2026-08-22.deepseek-verifier-live-smoke.v1",
    model: result.telemetry.backend?.model ?? config.model,
    scoringMode: result.telemetry.backend?.mode ?? config.scoringMode,
    status: result.status === "verified" ? "verified" : "failed",
    recommendation: result.recommendation,
    failureCode: result.failureCode,
    selectedCandidateId,
    candidateScore,
    usage: result.telemetry.usage,
    estimatedCostUsd: result.telemetry.estimatedCostUsd,
    latencyMs: result.telemetry.latencyMs,
    telemetryDigest: result.telemetry.telemetryDigest,
    evidencePackDigest: pack.packDigest,
    observedAt,
  });
}

async function main(): Promise<void> {
  try {
    const report = await runDeepSeekVerifierLiveSmoke();
    console.log(JSON.stringify(report));
    if (report.status !== "verified" || report.recommendation !== "ready_for_review") process.exitCode = 1;
  } catch (error) {
    const code = error instanceof Error && /^deepseek_verifier_live_smoke_[a-z_]+$/.test(error.message)
      ? error.message
      : "deepseek_verifier_live_smoke_failed";
    console.error(code);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) void main();
