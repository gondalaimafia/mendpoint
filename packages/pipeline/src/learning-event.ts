import { createHash } from "node:crypto";

export type LearningProduct = "fettler" | "regauge";
export type LearningSourceClass =
  | "synthetic_ground_truth"
  | "design_partner_verified"
  | "production_verified";
export type LearningProvenanceQualifier =
  | "human_corrected"
  | "deterministically_verified"
  | "reviewer_accepted"
  | "merged_and_verified";
// Precedence class for a verification verdict, ported from the observation layer
// (`TrajectorySignalClass` in packages/db/src/trajectory.ts): a deterministic
// test/compiler/sandbox result, a graph invariant, runtime evidence, or a human
// correction is HARD; a model verifier's opinion is SOFT and must never acquire
// the authority of a hard signal. Kept as a local union (not imported) so this
// schema module stays dependency-free; learning-signal-class-sync.test.ts asserts
// the two unions never drift.
export type LearningSignalClass = "hard" | "soft";
// What actually produced a verification verdict. The first five and the human
// reviewer are hard producers; only a model verifier is soft.
export type LearningVerificationProducer =
  | "test_runner"
  | "compiler"
  | "sandbox_command"
  | "graph_invariant"
  | "runtime_evidence"
  | "human_reviewer"
  | "model_verifier";
export type LearningOutcomeStatus =
  | "succeeded"
  | "failed"
  | "corrected"
  | "abstained"
  | "escalated"
  | "rolled_back";
export type LearningOutcomeAttribution =
  | "model_behavior"
  | "router"
  | "retrieval"
  | "graph"
  | "parser"
  | "tooling"
  | "deterministic_recipe"
  | "prompt"
  | "product_logic"
  | "calibration"
  | "none";
export type LearningRiskClass = "low" | "medium" | "high" | "critical";
export type LearningDestination =
  | "model_weight"
  | "router_policy"
  | "retrieval"
  | "graph"
  | "parser"
  | "tooling"
  | "deterministic_recipe"
  | "prompt"
  | "product_logic"
  | "calibration"
  | "no_action"
  // The tenant-private convention destination. Names where an organization-specific
  // convention belongs (spec §17.4/§17.4.3), realised by the Organization Memory
  // store (`packages/db/src/organization-memory.ts`, ADR-0008). Purely vocabulary:
  // `classify` below never routes here, because no attribution value means
  // "organizational convention" — the producers now derive attribution from run
  // evidence but no derivation yields this destination (see the classify comment
  // and lesson-routing.ts). It is a reachable value with no live route; the
  // upstream gap is recorded in docs/learning/LESSON_DESTINATION_ROUTING.md.
  | "organization_memory";

export type GovernedLearningEventV1 = Readonly<{
  schemaVersion: 1;
  eventId: string;
  product: LearningProduct;
  missionId: string;
  repositoryId: string;
  taskType: string;
  capability: string;
  specialization: Readonly<{
    provider: string | null;
    framework: string | null;
    language: string | null;
    runtime: string | null;
    migrationFamily: string;
    riskClass: LearningRiskClass;
    splitGroupId: string;
  }>;
  execution: Readonly<{
    modelId: string | null;
    adapterId: string | null;
    routerDecisionId: string;
    fallback: boolean;
  }>;
  references: Readonly<{
    graphContextArtifactId: string | null;
    inputArtifactId: string;
    proposedActionArtifactId: string | null;
  }>;
  prediction: Readonly<{ summary: string; evidenceRefs: readonly string[] }>;
  observedOutcome: Readonly<{
    status: LearningOutcomeStatus;
    summary: string;
    attribution: LearningOutcomeAttribution;
    evidenceRefs: readonly string[];
  }>;
  verification: Readonly<{
    verdict: "passed" | "failed" | "inconclusive";
    evidenceRefs: readonly string[];
    // Optional for dual-read (docs/learning/implementation-plan.md prescribes
    // dual-read, not cut-over): events stored before this field existed load
    // without it and are treated as soft/unknown by every consumer, never as
    // hard. Present on every event produced after this change. `producerModelId`
    // carries a model+version only for a `model_verifier`; it is null otherwise.
    authority?: Readonly<{
      signalClass: LearningSignalClass;
      producedBy: LearningVerificationProducer;
      producerModelId: string | null;
    }>;
  }>;
  reviewerDecision: Readonly<{
    decision: "accepted" | "rejected" | "modified" | "regenerated" | "merged" | "abandoned";
    evidenceRefs: readonly string[];
  }> | null;
  correction: Readonly<{ artifactId: string; substantive: boolean }> | null;
  confidence: number | null;
  economics: Readonly<{
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    costUsd: number;
  }>;
  governance: Readonly<{
    tenantId: string;
    residencyRegion: string;
    consentId: string | null;
    sourceClass: LearningSourceClass;
    provenanceQualifiers: readonly LearningProvenanceQualifier[];
    mayLeaveTenantBoundary: boolean;
  }>;
  createdAt: string;
}>;

export type GovernedLearningEvent = Readonly<{
  event: GovernedLearningEventV1;
  digest: string;
}>;

export type GovernedLearningLesson = Readonly<{
  schemaVersion: 1;
  lessonId: string;
  eventId: string;
  eventDigest: string;
  product: LearningProduct;
  capability: string;
  evidenceStrength: "high" | "medium" | "insufficient";
  destinations: readonly Readonly<{ destination: LearningDestination; rationale: string }>[];
  eligibleForModelTraining: boolean;
  governance: GovernedLearningEventV1["governance"];
}>;

const PRODUCTS = new Set<LearningProduct>(["fettler", "regauge"]);
const SOURCE_CLASSES = new Set<LearningSourceClass>([
  "synthetic_ground_truth",
  "design_partner_verified",
  "production_verified",
]);
const PROVENANCE_QUALIFIERS = new Set<LearningProvenanceQualifier>([
  "human_corrected",
  "deterministically_verified",
  "reviewer_accepted",
  "merged_and_verified",
]);
const OUTCOME_STATUSES = new Set<LearningOutcomeStatus>([
  "succeeded",
  "failed",
  "corrected",
  "abstained",
  "escalated",
  "rolled_back",
]);
const ATTRIBUTIONS = new Set<LearningOutcomeAttribution>([
  "model_behavior",
  "router",
  "retrieval",
  "graph",
  "parser",
  "tooling",
  "deterministic_recipe",
  "prompt",
  "product_logic",
  "calibration",
  "none",
]);
const VERDICTS = new Set(["passed", "failed", "inconclusive"]);
const SIGNAL_CLASSES = new Set<LearningSignalClass>(["hard", "soft"]);
const VERIFICATION_PRODUCERS = new Set<LearningVerificationProducer>([
  "test_runner",
  "compiler",
  "sandbox_command",
  "graph_invariant",
  "runtime_evidence",
  "human_reviewer",
  "model_verifier",
]);
const REVIEW_DECISIONS = new Set([
  "accepted",
  "rejected",
  "modified",
  "regenerated",
  "merged",
  "abandoned",
]);
const RISK_CLASSES = new Set<LearningRiskClass>(["low", "medium", "high", "critical"]);
const PRIVATE_REASONING_KEYS = new Set([
  "chainofthought",
  "hiddenreasoning",
  "privatereasoning",
  "scratchpad",
]);
const MAX_EVENT_BYTES = 128 * 1024;
const MAX_EVIDENCE_REFS = 64;

export function createGovernedLearningEvent(input: unknown): GovernedLearningEvent {
  const value = snapshot(input, 0, new WeakSet<object>()) as Record<string, unknown>;
  rejectPrivateReasoning(value);
  exactKeys(value, [
    "schemaVersion", "eventId", "product", "missionId", "repositoryId", "taskType",
    "capability", "specialization", "execution", "references", "prediction", "observedOutcome", "verification",
    "reviewerDecision", "correction", "confidence", "economics", "governance", "createdAt",
  ], "learning_event");
  if (value.schemaVersion !== 1) fail("learning_event_schema_version_invalid");

  const specialization = record(value.specialization, "learning_event_specialization_invalid");
  exactKeys(specialization, [
    "provider", "framework", "language", "runtime", "migrationFamily", "riskClass", "splitGroupId",
  ], "learning_event_specialization");
  const execution = record(value.execution, "learning_event_execution_invalid");
  exactKeys(execution, ["modelId", "adapterId", "routerDecisionId", "fallback"], "learning_event_execution");
  const references = record(value.references, "learning_event_references_invalid");
  exactKeys(references, ["graphContextArtifactId", "inputArtifactId", "proposedActionArtifactId"], "learning_event_references");
  const prediction = record(value.prediction, "learning_event_prediction_invalid");
  exactKeys(prediction, ["summary", "evidenceRefs"], "learning_event_prediction");
  const outcome = record(value.observedOutcome, "learning_event_outcome_invalid");
  exactKeys(outcome, ["status", "summary", "attribution", "evidenceRefs"], "learning_event_outcome");
  const verification = record(value.verification, "learning_event_verification_invalid");
  // `authority` is optional for dual-read; `verdict` and `evidenceRefs` are
  // required. Reject any other key, keeping the strict-shape guarantee.
  if (Object.keys(verification).some((key) => key !== "verdict" && key !== "evidenceRefs" && key !== "authority")) {
    fail("learning_event_verification_field_invalid");
  }
  if (!("verdict" in verification) || !("evidenceRefs" in verification)) {
    fail("learning_event_verification_field_missing");
  }
  const economics = record(value.economics, "learning_event_economics_invalid");
  exactKeys(economics, ["inputTokens", "outputTokens", "latencyMs", "costUsd"], "learning_event_economics");
  const governance = record(value.governance, "learning_event_governance_invalid");
  exactKeys(governance, [
    "tenantId", "residencyRegion", "consentId", "sourceClass", "provenanceQualifiers",
    "mayLeaveTenantBoundary",
  ], "learning_event_governance");

  const product = member(value.product, PRODUCTS, "learning_event_product_invalid");
  const status = member(outcome.status, OUTCOME_STATUSES, "learning_event_outcome_status_invalid");
  const attribution = member(outcome.attribution, ATTRIBUTIONS, "learning_event_attribution_invalid");
  const sourceClass = member(governance.sourceClass, SOURCE_CLASSES, "learning_event_source_class_invalid");
  const verdict = member(verification.verdict, VERDICTS, "learning_event_verdict_invalid") as GovernedLearningEventV1["verification"]["verdict"];
  const reviewerDecision = value.reviewerDecision === null
    ? null
    : normalizeReviewerDecision(record(value.reviewerDecision, "learning_event_reviewer_decision_invalid"));
  const correction = value.correction === null
    ? null
    : normalizeCorrection(record(value.correction, "learning_event_correction_invalid"));
  const createdAt = iso(value.createdAt, "learning_event_created_at_invalid");

  const event: GovernedLearningEventV1 = {
    schemaVersion: 1,
    eventId: text(value.eventId, "learning_event_id_invalid"),
    product,
    missionId: text(value.missionId, "learning_event_mission_id_invalid"),
    repositoryId: text(value.repositoryId, "learning_event_repository_id_invalid"),
    taskType: text(value.taskType, "learning_event_task_type_invalid"),
    capability: text(value.capability, "learning_event_capability_invalid"),
    specialization: {
      provider: nullableText(specialization.provider, "learning_event_provider_invalid"),
      framework: nullableText(specialization.framework, "learning_event_framework_invalid"),
      language: nullableText(specialization.language, "learning_event_language_invalid"),
      runtime: nullableText(specialization.runtime, "learning_event_runtime_invalid"),
      migrationFamily: text(specialization.migrationFamily, "learning_event_migration_family_invalid"),
      riskClass: member(specialization.riskClass, RISK_CLASSES, "learning_event_risk_class_invalid"),
      splitGroupId: text(specialization.splitGroupId, "learning_event_split_group_invalid"),
    },
    execution: {
      modelId: nullableText(execution.modelId, "learning_event_model_id_invalid"),
      adapterId: nullableText(execution.adapterId, "learning_event_adapter_id_invalid"),
      routerDecisionId: text(execution.routerDecisionId, "learning_event_router_decision_id_invalid"),
      fallback: bool(execution.fallback, "learning_event_fallback_invalid"),
    },
    references: {
      graphContextArtifactId: nullableText(references.graphContextArtifactId, "learning_event_graph_reference_invalid"),
      inputArtifactId: text(references.inputArtifactId, "learning_event_input_reference_invalid"),
      proposedActionArtifactId: nullableText(references.proposedActionArtifactId, "learning_event_action_reference_invalid"),
    },
    prediction: {
      summary: text(prediction.summary, "learning_event_prediction_summary_invalid", 4000),
      evidenceRefs: refs(prediction.evidenceRefs, "learning_event_prediction_evidence_invalid"),
    },
    observedOutcome: {
      status,
      summary: text(outcome.summary, "learning_event_outcome_summary_invalid", 4000),
      attribution,
      evidenceRefs: refs(outcome.evidenceRefs, "learning_event_outcome_evidence_invalid"),
    },
    verification: {
      verdict,
      evidenceRefs: refs(verification.evidenceRefs, "learning_event_verification_evidence_invalid"),
      ...normalizeVerificationAuthority(verification),
    },
    reviewerDecision,
    correction,
    confidence: nullableNumber(value.confidence, "learning_event_confidence_invalid", 0, 1),
    economics: {
      inputTokens: integer(economics.inputTokens, "learning_event_input_tokens_invalid"),
      outputTokens: integer(economics.outputTokens, "learning_event_output_tokens_invalid"),
      latencyMs: number(economics.latencyMs, "learning_event_latency_invalid"),
      costUsd: number(economics.costUsd, "learning_event_cost_invalid"),
    },
    governance: {
      tenantId: text(governance.tenantId, "learning_event_tenant_invalid"),
      residencyRegion: text(governance.residencyRegion, "learning_event_residency_invalid"),
      consentId: nullableText(governance.consentId, "learning_event_consent_invalid"),
      sourceClass,
      provenanceQualifiers: members(
        governance.provenanceQualifiers,
        PROVENANCE_QUALIFIERS,
        "learning_event_provenance_qualifiers_invalid",
      ),
      mayLeaveTenantBoundary: bool(governance.mayLeaveTenantBoundary, "learning_event_boundary_invalid"),
    },
    createdAt,
  };
  const canonical = canonicalJson(event);
  if (Buffer.byteLength(canonical, "utf8") > MAX_EVENT_BYTES) fail("learning_event_too_large");
  return deepFreeze({ event, digest: sha256(canonical) });
}

export function extractGovernedLesson(input: GovernedLearningEvent): GovernedLearningLesson {
  const verified = createGovernedLearningEvent(input.event);
  if (verified.digest !== input.digest) fail("learning_event_digest_mismatch");
  const event = verified.event;
  const evidenceStrength = strength(event);
  const destinations = evidenceStrength === "insufficient"
    ? [{ destination: "no_action" as const, rationale: "verification_not_authoritative" }]
    : classify(event);
  const eligibleForModelTraining = destinations.some(({ destination }) => destination === "model_weight")
    && event.verification.verdict === "passed"
    // Fail closed: an event whose verdict is soft or has no recorded authority
    // never trains weights, regardless of provenance qualifiers or consent.
    && event.verification.authority?.signalClass === "hard"
    && event.governance.consentId !== null;
  return deepFreeze({
    schemaVersion: 1 as const,
    lessonId: `lesson_${sha256(`${verified.digest}\0${canonicalJson(destinations)}`)}`,
    eventId: event.eventId,
    eventDigest: verified.digest,
    product: event.product,
    capability: event.capability,
    evidenceStrength,
    destinations,
    eligibleForModelTraining,
    governance: event.governance,
  });
}

// This 1:1 map from `attribution` to `LearningDestination` is only as
// discriminating as the `attribution` it is handed, and in production it is handed
// a constant. Both production producers call `deriveOutcomeAttribution`
// (`apps/worker/src/outcome-attribution.ts`) rather than hardcoding a literal, but
// each can only feed it `not_verified` today (Warden has no independent verifier;
// ReGauge's "passed" flag is tautological and it has no verifier), so both always
// emit `none` and this map only ever selects `no_action`. Its eleven-way
// discrimination is therefore real in the code but LATENT: it stays dormant until a
// seam can observe a genuine verification outcome (which needs the review-evidence
// schema to admit failure — it types ok/exitCode as literals today — and producers
// to admit non-merged outcomes). High precision, fail closed: an undetermined case
// yields `none`, never a fabricated `model_behavior`. Of the eleven destinations
// this map CAN emit, only `model_weight` has a downstream sink, and nothing routes
// there in production. These facts are made observable and countable in
// `lesson-routing.ts` (`summarizeLessonRouting`,
// `assessProductionAttributionDiscrimination`); see
// `docs/learning/LESSON_DESTINATION_ROUTING.md`.
function classify(event: GovernedLearningEventV1): Array<Readonly<{ destination: LearningDestination; rationale: string }>> {
  const attribution = event.observedOutcome.attribution;
  const mapped: Record<LearningOutcomeAttribution, Readonly<{ destination: LearningDestination; rationale: string }>> = {
    model_behavior: {
      destination: event.correction?.substantive ? "model_weight" : "no_action",
      rationale: event.correction?.substantive ? "model_behavior_corrected" : "no_substantive_correction",
    },
    router: { destination: "router_policy", rationale: "router_selection_failure" },
    retrieval: { destination: "retrieval", rationale: "required_context_not_retrieved" },
    graph: { destination: "graph", rationale: "graph_evidence_incomplete_or_wrong" },
    parser: { destination: "parser", rationale: "parser_failure" },
    tooling: { destination: "tooling", rationale: "tool_execution_failure" },
    deterministic_recipe: { destination: "deterministic_recipe", rationale: "reusable_deterministic_pattern" },
    prompt: { destination: "prompt", rationale: "instruction_or_context_failure" },
    product_logic: { destination: "product_logic", rationale: "product_behavior_failure" },
    calibration: { destination: "calibration", rationale: "confidence_outcome_mismatch" },
    none: { destination: "no_action", rationale: "no_improvement_destination" },
  };
  return [mapped[attribution]];
}

function strength(event: GovernedLearningEventV1): GovernedLearningLesson["evidenceStrength"] {
  if (event.verification.verdict !== "passed" || event.verification.evidenceRefs.length === 0) return "insufficient";
  // Derive the strongest tier from the recorded verification authority, not from
  // the caller-asserted provenance qualifiers. Fail closed: only a HARD verdict
  // (deterministic test/compiler/sandbox, graph invariant, runtime evidence, or
  // human correction) can reach "high". A soft verdict (model verifier) or an
  // absent authority is capped below "high" no matter what qualifiers are passed.
  const hard = event.verification.authority?.signalClass === "hard";
  if (event.governance.sourceClass === "synthetic_ground_truth") {
    return hard && event.governance.provenanceQualifiers.includes("deterministically_verified") ? "high" : "medium";
  }
  if (hard && event.governance.provenanceQualifiers.some((value) =>
    value === "human_corrected" || value === "reviewer_accepted" || value === "merged_and_verified")) return "high";
  return "medium";
}

function normalizeVerificationAuthority(
  verification: Record<string, unknown>,
): Readonly<{ authority?: NonNullable<GovernedLearningEventV1["verification"]["authority"]> }> {
  // Dual-read fail-closed: an absent authority key stays absent, so a pre-change
  // event keeps its exact digest and every consumer treats it as soft/unknown.
  // We never inject a "hard" default. When present it must be a complete, valid
  // authority object; a null or malformed value is rejected, not coerced.
  if (!("authority" in verification)) return {};
  const authority = record(verification.authority, "learning_event_verification_authority_invalid");
  exactKeys(authority, ["signalClass", "producedBy", "producerModelId"], "learning_event_verification_authority");
  return {
    authority: {
      signalClass: member(authority.signalClass, SIGNAL_CLASSES, "learning_event_verification_signal_class_invalid"),
      producedBy: member(authority.producedBy, VERIFICATION_PRODUCERS, "learning_event_verification_producer_invalid"),
      producerModelId: nullableText(authority.producerModelId, "learning_event_verification_producer_model_invalid"),
    },
  };
}

function normalizeReviewerDecision(value: Record<string, unknown>): GovernedLearningEventV1["reviewerDecision"] {
  exactKeys(value, ["decision", "evidenceRefs"], "learning_event_reviewer_decision");
  return {
    decision: member(value.decision, REVIEW_DECISIONS, "learning_event_reviewer_decision_invalid") as NonNullable<GovernedLearningEventV1["reviewerDecision"]>["decision"],
    evidenceRefs: refs(value.evidenceRefs, "learning_event_reviewer_evidence_invalid"),
  };
}

function normalizeCorrection(value: Record<string, unknown>): NonNullable<GovernedLearningEventV1["correction"]> {
  exactKeys(value, ["artifactId", "substantive"], "learning_event_correction");
  return {
    artifactId: text(value.artifactId, "learning_event_correction_artifact_invalid"),
    substantive: bool(value.substantive, "learning_event_correction_substantive_invalid"),
  };
}

function snapshot(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > 16) fail("learning_event_too_deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("learning_event_number_invalid");
    return value;
  }
  if (typeof value !== "object") fail("learning_event_json_invalid");
  if (seen.has(value)) fail("learning_event_cycle_invalid");
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 256) fail("learning_event_array_too_large");
    const result = value.map((item) => snapshot(item, depth + 1, seen));
    seen.delete(value);
    return result;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail("learning_event_object_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || descriptor.get || descriptor.set) fail("learning_event_accessor_forbidden");
    result[key] = snapshot(descriptor.value, depth + 1, seen);
  }
  seen.delete(value);
  return result;
}

function rejectPrivateReasoning(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) rejectPrivateReasoning(child);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (PRIVATE_REASONING_KEYS.has(key.replace(/[_-]/g, "").toLowerCase())) {
      fail("learning_event_private_reasoning_forbidden");
    }
    rejectPrivateReasoning(child);
  }
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], prefix: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) fail(`${prefix}_field_invalid`);
  if (allowed.some((key) => !(key in value))) fail(`${prefix}_field_missing`);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function text(value: unknown, code: string, max = 512): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}

function nullableText(value: unknown, code: string): string | null {
  return value === null ? null : text(value, code);
}

function bool(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") fail(code);
  return value;
}

function number(value: unknown, code: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) fail(code);
  return value;
}

function integer(value: unknown, code: string): number {
  const result = number(value, code);
  if (!Number.isSafeInteger(result)) fail(code);
  return result;
}

function nullableNumber(value: unknown, code: string, min: number, max: number): number | null {
  return value === null ? null : number(value, code, min, max);
}

function iso(value: unknown, code: string): string {
  if (typeof value !== "string") fail(code);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail(code);
  return value;
}

function refs(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_REFS) fail(code);
  const normalized = value.map((item) => text(item, code));
  if (new Set(normalized).size !== normalized.length) fail(code);
  return Object.freeze(normalized.sort(codeUnitCompare));
}

function members<T extends string>(value: unknown, allowed: ReadonlySet<T>, code: string): readonly T[] {
  if (!Array.isArray(value) || value.length > 16) fail(code);
  const normalized = value.map((item) => member(item, allowed, code));
  if (new Set(normalized).size !== normalized.length) fail(code);
  return Object.freeze(normalized.sort(codeUnitCompare));
}

function member<T extends string>(value: unknown, allowed: ReadonlySet<T>, code: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) fail(code);
  return value as T;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort(codeUnitCompare).map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(code: string): never {
  throw new Error(code);
}
