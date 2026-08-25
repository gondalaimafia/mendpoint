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

export type VerifierAdvisoryRuntime = Readonly<{
  observe(input: Readonly<{
    pack: VerifierEvidencePack;
    incumbentCandidateId: string;
    verificationAttemptId: string;
    observedAt: string;
    signal?: AbortSignal;
  }>): Promise<AgentVerifierResult>;
}>;

export function createVerifierAdvisoryRuntime(input: Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  pricing: VerifierPricing;
  persistTelemetry(telemetry: VerifierTelemetry): Promise<void>;
  auditCredentialAccess: CredentialAccessAudit;
  transport?: VerifierHttpTransport;
  actorId?: string;
}>): VerifierAdvisoryRuntime | null {
  const env = input.env ?? process.env;
  const config = resolveVerifierRuntimeConfig(env);
  if (!config.enabled || config.rolloutMode === "off") return null;
  if (config.rolloutMode !== "offline" && config.rolloutMode !== "advisory") fail("verifier_advisory_rollout_invalid");
  // `offline` is documented (docs/agents/MUSE_DEEPSEEK_VERIFIER_DESIGN.md) as
  // "fixture and retained benchmark evaluation only" and must never open a live
  // network transport. This worker shadow runtime is a production egress path
  // with no retained-artifact source of its own, so a fixture is never available
  // here for a live completion: offline therefore performs no observation and no
  // egress. Refusing is the "no action" / fail-closed effect the design assigns
  // to an unavailable transport; silently falling back to the live fetch
  // transport (the prior behavior) is exactly what the offline contract forbids.
  // Fixture and benchmark evaluation run through createAgentVerifier directly in
  // the eval harness, not through this runtime. Only advisory builds a live
  // transport below.
  if (config.rolloutMode === "offline") return null;
  validatePricing(input.pricing);
  if (typeof input.persistTelemetry !== "function" || typeof input.auditCredentialAccess !== "function") fail("verifier_advisory_ports_invalid");
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
          baseUrl: config.baseUrl,
          env,
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
    fail("verifier_advisory_pricing_invalid");
  }
}

function fail(code: string): never { throw new Error(code); }

/** @deprecated Import createVerifierAdvisoryRuntime. Kept for queued callers across one deploy. */
export const createVerifierShadowRuntime = createVerifierAdvisoryRuntime;
/** @deprecated Import VerifierAdvisoryRuntime. */
export type VerifierShadowRuntime = VerifierAdvisoryRuntime;
