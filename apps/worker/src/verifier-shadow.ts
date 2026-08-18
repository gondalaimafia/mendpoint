import {
  CredentialBroker,
  EnvSecretProvider,
  type CredentialAccessAudit,
} from "@mendpoint/platform";
import {
  createAgentVerifier,
  createDeepSeekVerifierBackend,
  createFetchVerifierTransport,
  resolveVerifierRuntimeConfig,
  verifyVerifierEvidencePack,
  type AgentVerifierResult,
  type VerifierEvidencePack,
  type VerifierHttpTransport,
  type VerifierPricing,
  type VerifierTelemetry,
} from "@mendpoint/verifier";

export type VerifierShadowRuntime = Readonly<{
  observe(input: Readonly<{
    pack: VerifierEvidencePack;
    incumbentCandidateId: string;
    verificationAttemptId: string;
    observedAt: string;
    signal?: AbortSignal;
  }>): Promise<AgentVerifierResult>;
}>;

export function createVerifierShadowRuntime(input: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  pricing: VerifierPricing;
  persistTelemetry(telemetry: VerifierTelemetry): Promise<void>;
  auditCredentialAccess: CredentialAccessAudit;
  transport?: VerifierHttpTransport;
  actorId?: string;
}>): VerifierShadowRuntime | null {
  const env = input.env ?? process.env;
  const config = resolveVerifierRuntimeConfig(env);
  if (!config.enabled || config.rolloutMode === "off") return null;
  if (config.rolloutMode !== "offline" && config.rolloutMode !== "shadow") fail("verifier_shadow_rollout_invalid");
  validatePricing(input.pricing);
  if (typeof input.persistTelemetry !== "function" || typeof input.auditCredentialAccess !== "function") fail("verifier_shadow_ports_invalid");
  const persistTelemetry = input.persistTelemetry.bind(input);
  const broker = new CredentialBroker({
    providers: [new EnvSecretProvider(env)],
    audit: input.auditCredentialAccess,
  });
  const transport = input.transport ?? createFetchVerifierTransport();
  const actorId = input.actorId?.trim() || "mendpoint-verifier-worker";

  return Object.freeze({
    async observe(request): Promise<AgentVerifierResult> {
      const pack = verifyVerifierEvidencePack(request.pack);
      const credential = await broker.access({
        credentialId: "deepseek-v4-flash-verifier",
        secret: { provider: "env", id: config.credentialEnvName },
        audiences: ["deepseek-verifier"],
        rotation: { generation: 1, issuedAt: "2026-08-17T00:00:00.000Z" },
      }, {
        actorId,
        audience: "deepseek-verifier",
        purpose: "independent software verification",
        requestId: request.verificationAttemptId,
        at: new Date(request.observedAt),
      });
      const verifier = createAgentVerifier({
        enabled: true,
        rolloutMode: config.rolloutMode,
        backend: createDeepSeekVerifierBackend({
          apiKey: credential.secret.reveal(),
          transport,
          scoringMode: config.scoringMode,
          timeoutMs: config.timeoutMs,
          maximumRetries: config.maximumRetries,
          pricing: input.pricing,
        }),
        evaluations: config.evaluations,
        pivots: config.pivots,
        seed: 0,
        maximumCandidates: config.maximumCandidates,
        maximumCostUsd: config.maximumCostUsd,
      });
      const result = await verifier.verify({ ...request, pack });
      await persistTelemetry(result.telemetry);
      return result;
    },
  });
}

function validatePricing(input: VerifierPricing): void {
  if (!input || input.currency !== "USD" || typeof input.version !== "string" || !input.version.trim() ||
    !Number.isFinite(Date.parse(input.effectiveAt)) || new Date(Date.parse(input.effectiveAt)).toISOString() !== input.effectiveAt ||
    [input.inputPerMillion, input.cachedInputPerMillion, input.outputPerMillion].some((value) => !Number.isFinite(value) || value < 0)) {
    fail("verifier_shadow_pricing_invalid");
  }
}

function fail(code: string): never { throw new Error(code); }
