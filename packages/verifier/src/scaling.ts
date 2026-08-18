import type { AgentVerifier } from "./agent-verifier.js";
import { createVerifierEvidencePack } from "./evidence.js";
import type {
  AgentVerifierResult,
  VerifierCandidateInput,
  VerifierDeterministicCheckInput,
  VerifierEvidencePackInput,
} from "./types.js";
import { boundedText, codeUnitCompare, deepFreeze, exactIso, fail, identifier, sha256 } from "./utils.js";

export type MuseGeneratorDescriptor = Readonly<{
  provider: string;
  model: "muse-1.2";
  revision: string;
}>;

export type MusePlanGenerator = Readonly<{
  descriptor: MuseGeneratorDescriptor;
  generate(input: Readonly<{
    taskId: string;
    objective: string;
    candidateId: string;
    ordinal: number;
    workspaceId: string;
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    workspaceId: string;
    candidate: VerifierCandidateInput;
    checks: readonly Readonly<Omit<VerifierDeterministicCheckInput, "candidateIds">>[];
  }>>;
}>;

export type MuseBestOfNPlanResult = Readonly<{
  generatedBy: MuseGeneratorDescriptor;
  evidencePackDigest: string;
  generatedCandidateIds: readonly string[];
  filteredOut: AgentVerifierResult["telemetry"]["rejectedCandidates"];
  verifierResult: AgentVerifierResult;
}>;

export async function runMuseBestOfNPlans(input: Readonly<{
  basePack: Omit<VerifierEvidencePackInput, "candidates" | "checks">;
  globalChecks: readonly VerifierDeterministicCheckInput[];
  candidateCount: number;
  incumbentOrdinal: number;
  generationAttemptId: string;
  generator: MusePlanGenerator;
  verifier: AgentVerifier;
  observedAt: string;
  signal?: AbortSignal;
}>): Promise<MuseBestOfNPlanResult> {
  if (!Number.isSafeInteger(input.candidateCount) || input.candidateCount < 1 || input.candidateCount > 5) {
    fail("verifier_candidate_count_invalid");
  }
  if (!Number.isSafeInteger(input.incumbentOrdinal) || input.incumbentOrdinal < 0 || input.incumbentOrdinal >= input.candidateCount) {
    fail("verifier_incumbent_ordinal_invalid");
  }
  const generationAttemptId = identifier(input.generationAttemptId, "verifier_generation_attempt_id_invalid");
  const observedAt = exactIso(input.observedAt, "verifier_observed_at_invalid");
  const descriptor = normalizeDescriptor(input.generator?.descriptor);
  if (!input.generator || typeof input.generator.generate !== "function") fail("verifier_muse_generator_invalid");
  const generate = input.generator.generate.bind(input.generator);
  const candidates: VerifierCandidateInput[] = [];
  const checks: VerifierDeterministicCheckInput[] = input.globalChecks.map((check) => structuredClone(check));
  const workspaceIds = new Set<string>();

  for (let ordinal = 0; ordinal < input.candidateCount; ordinal++) {
    if (input.signal?.aborted) fail("verifier_generation_aborted");
    const candidateId = `muse_plan_${ordinal + 1}`;
    const workspaceId = `workspace_${sha256(`${input.basePack.tenantId}\0${input.basePack.taskId}\0${generationAttemptId}\0${ordinal}`).slice("sha256:".length, "sha256:".length + 32)}`;
    const generated = await generate({
      taskId: input.basePack.taskId,
      objective: input.basePack.objective,
      candidateId,
      ordinal,
      workspaceId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!generated || generated.workspaceId !== workspaceId || workspaceIds.has(generated.workspaceId)) {
      fail("verifier_candidate_workspace_mismatch");
    }
    workspaceIds.add(generated.workspaceId);
    if (generated.candidate.candidateId !== candidateId || generated.candidate.kind !== "plan") {
      fail("verifier_generated_candidate_invalid");
    }
    candidates.push(structuredClone(generated.candidate));
    for (const check of generated.checks) {
      checks.push({ ...structuredClone(check), candidateIds: [candidateId] });
    }
  }

  const pack = createVerifierEvidencePack({
    ...structuredClone(input.basePack),
    checks,
    candidates,
  });
  const incumbentCandidateId = `muse_plan_${input.incumbentOrdinal + 1}`;
  const verifierResult = await input.verifier.verify({
    pack,
    incumbentCandidateId,
    verificationAttemptId: `verify_${generationAttemptId}`,
    observedAt,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return deepFreeze({
    generatedBy: descriptor,
    evidencePackDigest: pack.packDigest,
    generatedCandidateIds: candidates.map(({ candidateId }) => candidateId).sort(codeUnitCompare),
    filteredOut: verifierResult.telemetry.rejectedCandidates,
    verifierResult,
  });
}

function normalizeDescriptor(input: MuseGeneratorDescriptor | undefined): MuseGeneratorDescriptor {
  if (!input || input.model !== "muse-1.2") fail("verifier_muse_generator_required");
  return deepFreeze({
    provider: identifier(input.provider, "verifier_generator_provider_invalid"),
    model: input.model,
    revision: boundedText(input.revision, "verifier_generator_revision_invalid", 256),
  });
}
