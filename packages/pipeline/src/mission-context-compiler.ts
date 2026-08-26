/**
 * Mission Context Compiler — assemble the MINIMUM SUFFICIENT inherited context
 * for one task and render it for a model call
 * (spec: docs/missions/CONTEXT_COMPILER.md).
 *
 * Today every model call rebuilds identical, tenant-independent context from
 * compiled-in constants (`packages/agent/src/agent.ts` — `wardenPlaybook()` takes
 * no tenant). This compiler instead SELECTS a bounded envelope of inherited
 * context — mission identity, the task, a bounded graph projection, relevant
 * history, active decisions, relevant organization memory, policy constraints,
 * verification state, unresolved exceptions, mission artifacts (refs only),
 * and evidence refs — and renders it for injection at the model seam.
 *
 * Design commitments, each with a deletable control and a test that dies when it
 * is removed (see mission-context-compiler.test.ts):
 *
 *  - Bounded, not complete. Every list section is capped and every string is
 *    length-limited (house style: transformer/src/mission-compiler.ts). An
 *    oversized mission history is truncated, never dumped.
 *  - Precedence is not reinvented. Layer ordering is resolved ONLY by
 *    `resolveOrganizationDecision` (`./organization-memory-precedence.ts`). This
 *    module groups the layers by subject and calls the single resolver; it never
 *    re-derives ordering. A memory that a hard policy or mission decision
 *    outranks is recorded as `overridden`, never dropped silently, and never
 *    placed in `applied` — memory cannot become hidden policy.
 *  - Three states throughout (house template: db/src/fettler-delegation-evidence
 *    .ts). A section is `consulted` (with possibly-empty results — "no memory
 *    applies") or `not_consulted` (with a DISTINCT reason — "the store was not
 *    read"). The two never collapse.
 *  - Verification carries its validity. A verification bound to a snapshot or
 *    graph version other than the task's current one is marked `stale` and is
 *    never rendered as current evidence.
 *  - Tenant isolation is structural. Every input item is checked against the
 *    envelope tenant; a foreign item throws rather than leaking into the prompt.
 *  - No chain-of-thought. The context refs record which context was supplied and
 *    which evidence was used — identifiers and digests — never model reasoning.
 */
import type { InheritedContextInjection } from "@mendpoint/agent";
import { MAX_INHERITED_CONTEXT_BYTES } from "@mendpoint/agent";
import type { OrganizationMemoryRecord, OrganizationMemoryStatus } from "@mendpoint/db";
import {
  compileMissionGraphProjection,
  type FettlerEndpointImpactResult,
} from "@mendpoint/graph-learn";
import { parsePolicyEnvelope, type PolicyEnvelope } from "@mendpoint/policy";
import { createHash } from "node:crypto";
import {
  organizationMemoryPrecedenceLayer,
  resolveOrganizationDecision,
  toOrganizationMemoryReference,
  type OrganizationMemoryReference,
  type PrecedenceInput,
  type PrecedenceLayerName,
  type PrecedenceResult,
} from "./organization-memory-precedence.js";

// ---------------------------------------------------------------------------
// Bounds (house style: transformer/src/mission-compiler.ts)
// ---------------------------------------------------------------------------

export const MISSION_CONTEXT_BOUNDS = {
  /** Max items rendered per list section (history, decisions, memory, ...). */
  maxSectionItems: 32,
  /** Max characters for any free-text field (statement, directive, objective). */
  maxText: 2_000,
  /** Max characters for an identifier. */
  maxIdentifier: 200,
  /** Max evidence references carried on the envelope. */
  maxEvidenceRefs: 512,
  /** Max bytes for the compiled graph projection (within compiler's own ceiling). */
  maxGraphBytes: 16_384,
  /** Max bytes for the whole rendered prompt body (matches the seam ceiling). */
  maxPromptBytes: MAX_INHERITED_CONTEXT_BYTES,
} as const;

// ---------------------------------------------------------------------------
// Three-state section discriminants (house template)
// ---------------------------------------------------------------------------

/** A section that was read. Its results may be empty ("nothing applies"). */
export type Consulted<T> = Readonly<{ status: "consulted" } & T>;
/** A section that was NOT read. The reason distinguishes it from an empty read. */
export type NotConsulted<R extends string> = Readonly<{ status: "not_consulted"; reason: R }>;
/**
 * A section whose source WAS read but could not be parsed. Distinct from both a
 * `consulted` empty read ("nothing applies") and a `not_consulted` section ("we
 * did not look"): here we looked, the source was corrupt, and we fell back to a
 * safe default. The `reason` records why the parse failed.
 */
export type Unreadable<T> = Readonly<{ status: "unreadable"; reason: string } & T>;

export type SectionNotConsultedReason =
  | "store_not_available"
  | "not_applicable_to_task"
  | "graph_version_absent"
  | "endpoint_key_absent"
  | "graph_projection_failed";

/**
 * Why a section was not consulted. `no_mission_bound` is DISTINCT from
 * `store_not_available`: the store was reachable, but this task is not part of a
 * formal Mission, so mission-scoped decisions/exceptions/verification do not
 * apply — never the same thing as "the store could not be read".
 */
export type MissionSectionNotConsultedReason = "store_not_available" | "no_mission_bound";

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export type MissionIdentity = Readonly<{
  /** Null when the task is not part of a formal Mission (e.g. a Fettler repair). */
  missionId: string | null;
  product: "fettler" | "regauge";
  objective: string;
  repositoryId: string | null;
  snapshotId: string | null;
  graphVersionId: string | null;
}>;

export type TaskDescriptor = Readonly<{
  taskId: string;
  capability: string;
  riskClass: string;
  goal: string;
}>;

export type GraphProjection = Readonly<{
  graphVersionId: string;
  graphContentDigest: string;
  resultDigest: string;
  impact: "impact" | "no_impact" | "unknown_impact";
  coverageBasis: "complete" | "partial" | "target_absent";
  byteLength: number;
  /** The bounded, canonical graph-projection JSON produced by the reused compiler. */
  content: string;
  contentDigest: string;
}>;

export type HistoryEntry = Readonly<{
  trajectoryRef: string;
  outcome: string;
  summary: string;
}>;

export type AppliedMemory = Readonly<{
  subjectKey: string;
  reference: OrganizationMemoryReference;
  /** `confirmed` = ACTIVE governing memory; `inferred` = pending candidate. */
  provenance: "confirmed" | "inferred";
}>;

export type OverriddenMemory = Readonly<{
  subjectKey: string;
  reference: OrganizationMemoryReference;
  /** The precedence layer that outranked this memory. */
  overriddenBy: PrecedenceLayerName;
}>;

/** One resolved contended subject: what won and what it displaced. */
export type PrecedenceOutcome = Readonly<{
  subjectKey: string;
  winner: PrecedenceResult["winner"];
  reason: string;
  overrides: readonly PrecedenceLayerName[];
}>;

export type OrgMemorySection =
  | Consulted<{
      applied: readonly AppliedMemory[];
      overridden: readonly OverriddenMemory[];
    }>
  | NotConsulted<MissionSectionNotConsultedReason>;

export type PolicyConstraint = Readonly<{
  id: string;
  subjectKey: string;
  directive: string;
  source: string;
}>;

/**
 * Verification standing, PRESERVED verbatim from the three standings emitted by
 * `classifyMissionVerificationEvidence` (packages/db/src/mission-verification.ts).
 * That classifier is the SOLE constructor of `current_evidence`, emitted only
 * after asserting equality of the bound snapshot-identity triple (snapshot_id,
 * resolved_sha, manifest_sha256). The compiler NEVER re-derives this and never
 * adds a looser relevance rule: it carries the standing through and never renders
 * a non-current standing as current. `stale_evidence` and the four distinct
 * `no_current_evidence` absence reasons (carried in `reason`) are kept, not
 * flattened into a boolean or an empty object.
 */
export type MissionVerificationState = "current_evidence" | "stale_evidence" | "no_current_evidence";

const MISSION_VERIFICATION_STATES: ReadonlySet<MissionVerificationState> = new Set([
  "current_evidence",
  "stale_evidence",
  "no_current_evidence",
]);

export type VerificationEntry = Readonly<{
  id: string;
  statement: string;
  verdict: string;
  /** The classifier's state, carried through unchanged. */
  state: MissionVerificationState;
  /** The classifier's distinct reason (stale / no_current / never), if any. */
  reason: string | null;
  boundSnapshotId: string | null;
  boundGraphVersionId: string | null;
}>;

export type ExceptionEntry = Readonly<{
  id: string;
  statement: string;
  status: string;
}>;

/**
 * A mission output by REFERENCE only: role, artifact id, sha256, and label.
 * Never the artifact body — those bytes stay in `artifact_manifests`.
 */
export type ArtifactEntry = Readonly<{
  id: string;
  role: string;
  artifactId: string;
  artifactSha256: string;
  label: string;
  createdAt: string;
  taskId: string | null;
}>;

export type DecisionEntry = Readonly<{
  id: string;
  subjectKey: string;
  directive: string;
  decidedAt: string;
}>;

export type InheritedContextEnvelope = Readonly<{
  schemaVersion: "mendpoint.inherited-context.v1";
  tenantId: string;
  missionIdentity: MissionIdentity;
  task: TaskDescriptor;
  graphProjection: Consulted<{ projection: GraphProjection }> | NotConsulted<SectionNotConsultedReason>;
  relevantHistory: Consulted<{ entries: readonly HistoryEntry[] }> | NotConsulted<MissionSectionNotConsultedReason>;
  activeDecisions: Consulted<{ entries: readonly DecisionEntry[] }> | NotConsulted<MissionSectionNotConsultedReason>;
  relevantOrgMemory: OrgMemorySection;
  policyConstraints:
    | Consulted<{ entries: readonly PolicyConstraint[] }>
    | Unreadable<{ entries: readonly PolicyConstraint[] }>
    | NotConsulted<MissionSectionNotConsultedReason>;
  verificationState:
    | Consulted<{ entries: readonly VerificationEntry[] }>
    | NotConsulted<MissionSectionNotConsultedReason>;
  unresolvedExceptions:
    | Consulted<{ entries: readonly ExceptionEntry[] }>
    | NotConsulted<MissionSectionNotConsultedReason>;
  /**
   * Mission outputs by reference (role / artifact id / sha256 / label / createdAt).
   * Never bodies. Required on the input like every sibling section.
   */
  missionArtifacts:
    | Consulted<{ entries: readonly ArtifactEntry[] }>
    | NotConsulted<MissionSectionNotConsultedReason>;
  evidenceRefs: readonly string[];
  /** Every contended subject that the single precedence resolver decided. */
  precedence: readonly PrecedenceOutcome[];
  bounds: Readonly<{
    sectionItemsCapped: boolean;
    historyTruncated: boolean;
    promptTruncated: boolean;
  }>;
}>;

// ---------------------------------------------------------------------------
// Input contract (pure: the caller performs all I/O and reads)
// ---------------------------------------------------------------------------

/** A precedence-participating directive from a store other than Org Memory. */
export type DirectiveInput = Readonly<{
  tenantId: string;
  id: string;
  subjectKey: string;
  directive: string;
  source: string;
}>;

/**
 * Outcome of translating a Mission's Policy Envelope into hard-policy directives.
 * `readable` carries the envelope's real directives; `unreadable` carries the
 * maximally restrictive fallback and the parse failure `reason`, so the caller can
 * record the unreadable case as a THIRD state distinct from an empty read.
 */
export type PolicyEnvelopeDirectives =
  | Readonly<{ readable: true; directives: readonly DirectiveInput[] }>
  | Readonly<{ readable: false; reason: string; directives: readonly DirectiveInput[] }>;

/**
 * Translate a Mission's inherited Policy Envelope into hard-policy directives for
 * the context compiler (spec §6.10: the compiled context SHOULD include the
 * Policy Envelope; §28.1.0: policy is inherited). Only ACTUALLY-constraining
 * dimensions are emitted, so the permissive default envelope contributes its real
 * constraints (review required, no deploy, no training) and nothing else — the
 * prompt is not grown with "unrestricted" noise. These directives are also the
 * top precedence layer (`hard_policy`), so a memory that contradicts policy is
 * recorded as overridden, never applied.
 *
 * The envelope JSON is parsed and validated (`parsePolicyEnvelope`). A malformed
 * row is NOT treated as unconstrained: emitting no directives would make a corrupt
 * envelope strictly LESS restrictive than a valid one (fail-open). Instead the
 * parse failure yields `readable: false` with the maximally restrictive fallback
 * (review required, no deployment, no external processing, no training) — a
 * Mission whose policy is unreadable is treated as maximally constrained — and a
 * `reason` the caller records observably. We still never emit a PARTIAL policy.
 */
export function policyEnvelopeDirectives(
  tenantId: string,
  envelopeJson: string,
  version: number,
): PolicyEnvelopeDirectives {
  const source = `policy_envelope:v${version}`;
  const out: DirectiveInput[] = [];
  const push = (key: string, directive: string) =>
    out.push({ tenantId, id: `policy:v${version}:${key}`, subjectKey: `policy:${key}`, directive, source });

  let envelope: PolicyEnvelope;
  try {
    envelope = parsePolicyEnvelope(JSON.parse(envelopeJson));
  } catch (error) {
    // Fail closed: the four fail-closed dimensions of the default envelope, so an
    // unreadable policy is never less restrictive than a working one.
    push("review", "Human review is required before delivery.");
    push("deployment", "Deployment is not permitted by policy.");
    push("external_processing", "External processing/models are not permitted by policy.");
    push("training", "Training-data capture is not permitted by policy.");
    const reason = error instanceof Error ? error.message : "policy_envelope_unparseable";
    const unreadable: PolicyEnvelopeDirectives = { readable: false, reason, directives: Object.freeze(out) };
    return unreadable;
  }

  if (envelope.reviewRequired) push("review", "Human review is required before delivery.");
  if (!envelope.deploymentAllowed) push("deployment", "Deployment is not permitted by policy.");
  if (!envelope.externalProcessingAllowed) push("external_processing", "External processing/models are not permitted by policy.");
  if (!envelope.trainingDataAllowed) push("training", "Training-data capture is not permitted by policy.");
  if (envelope.riskCeiling !== "critical") push("risk_ceiling", `Risk ceiling: ${envelope.riskCeiling}.`);
  if (envelope.repositoryScope.length > 0) push("repository_scope", `Repositories limited to: ${[...envelope.repositoryScope].sort().join(", ")}.`);
  if (envelope.branchScope.length > 0) push("branch_scope", `Branches limited to: ${[...envelope.branchScope].sort().join(", ")}.`);
  if (envelope.allowedTools.length > 0) push("tool_scope", `Tools limited to: ${[...envelope.allowedTools].sort().join(", ")}.`);
  if (envelope.allowedModelClasses.length > 0) push("model_scope", `Model classes limited to: ${[...envelope.allowedModelClasses].sort().join(", ")}.`);
  for (const zone of [...envelope.forbiddenZones].sort()) {
    push(`forbidden_zone:${zone}`, `Do not edit under ${zone} (forbidden zone).`);
  }
  const readable: PolicyEnvelopeDirectives = { readable: true, directives: Object.freeze(out) };
  return readable;
}

export type MissionDecisionInput = Readonly<{
  tenantId: string;
  id: string;
  subjectKey: string;
  directive: string;
  decidedAt: string;
}>;

export type OrgMemoryInput = Readonly<{
  subjectKey: string;
  record: OrganizationMemoryRecord;
}>;

export type VerificationInput = Readonly<{
  tenantId: string;
  id: string;
  statement: string;
  verdict: string;
  /** The state from `classifyMissionVerificationEvidence`. Carried through as-is. */
  state: MissionVerificationState;
  /** The classifier's distinct reason (for stale / no_current / never), if any. */
  reason?: string | null;
  /** The snapshot the verification ran against, if any (for display + refs only). */
  boundSnapshotId?: string | null;
  /** The graph version the verification ran against, if any (display + refs only). */
  boundGraphVersionId?: string | null;
}>;

export type ExceptionInput = Readonly<{
  tenantId: string;
  id: string;
  statement: string;
  status: string;
}>;

/** Mission artifact registry row, refs only — never the stored body. */
export type ArtifactInput = Readonly<{
  tenantId: string;
  id: string;
  role: string;
  artifactId: string;
  artifactSha256: string;
  label: string;
  createdAt: string;
  taskId: string | null;
}>;

export type HistoryInput = Readonly<{
  tenantId: string;
  trajectoryRef: string;
  outcome: string;
  summary: string;
}>;

/**
 * Section wrapper: either the store was read (records, possibly empty) or not.
 * When not read, a distinct reason distinguishes "the store could not be read"
 * from "this task has no Mission, so mission-scoped context does not apply".
 */
export type SectionSource<T> =
  | Readonly<{ consulted: true; records: readonly T[] }>
  | Readonly<{ consulted: false; reason?: MissionSectionNotConsultedReason }>;

/**
 * The hard-policy section source. Adds a third disposition to `SectionSource`: the
 * Policy Envelope was read (`consulted`) but could not be parsed (`unreadable`),
 * so `records` carries the maximally restrictive fallback and `reason` records the
 * failure. Distinct from a `consulted` empty read and from `not_consulted`.
 */
export type HardPolicySource =
  | Readonly<{ consulted: true; unreadable?: false; records: readonly DirectiveInput[] }>
  | Readonly<{ consulted: true; unreadable: true; reason: string; records: readonly DirectiveInput[] }>
  | Readonly<{ consulted: false; reason?: MissionSectionNotConsultedReason }>;

export type GraphSource =
  | Readonly<{ consulted: true; impact: FettlerEndpointImpactResult; maxBytes?: number }>
  | Readonly<{ consulted: false; reason: SectionNotConsultedReason }>;

export type MissionContextInput = Readonly<{
  tenantId: string;
  mission: MissionIdentity;
  task: TaskDescriptor;
  hardPolicies: HardPolicySource;
  missionDecisions: SectionSource<MissionDecisionInput>;
  organizationMemory: SectionSource<OrgMemoryInput>;
  userPreferences: SectionSource<DirectiveInput>;
  graph: GraphSource;
  history: SectionSource<HistoryInput>;
  verification: SectionSource<VerificationInput>;
  exceptions: SectionSource<ExceptionInput>;
  artifacts: SectionSource<ArtifactInput>;
  evidenceRefs?: readonly string[];
}>;

// ---------------------------------------------------------------------------
// Local validation helpers (bounded)
// ---------------------------------------------------------------------------

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function text(value: unknown, code: string, maximum: number = MISSION_CONTEXT_BOUNDS.maxText): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new Error(code);
  }
  return value;
}

/**
 * Free text from a durable store (statements, directives, objectives) that may be
 * legitimately longer than the render budget (the record stores allow up to 4000
 * chars). Require a non-empty string, then TRUNCATE for rendering rather than
 * throwing — an over-long convention must not fail the whole compile.
 */
function clippedText(value: unknown, code: string, maximum = MISSION_CONTEXT_BOUNDS.maxText): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(code);
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function identifier(value: unknown, code: string): string {
  return text(value, code, MISSION_CONTEXT_BOUNDS.maxIdentifier);
}

function assertTenant(tenantId: string, itemTenantId: string): void {
  if (itemTenantId !== tenantId) throw new Error("mission_context_tenant_mismatch");
}

/** A not-consulted section, preserving the caller's distinct reason. */
function sectionNotConsulted(source: {
  consulted: false;
  reason?: MissionSectionNotConsultedReason;
}): NotConsulted<MissionSectionNotConsultedReason> {
  return Object.freeze({ status: "not_consulted", reason: source.reason ?? "store_not_available" });
}

// ---------------------------------------------------------------------------
// Precedence assembly (single resolver, grouped by subject)
// ---------------------------------------------------------------------------

type SubjectLayers = {
  hardPolicy?: DirectiveInput;
  missionDecision?: MissionDecisionInput;
  confirmedOrgMemory?: OrgMemoryInput;
  userPreference?: DirectiveInput;
  inferredCandidate?: OrgMemoryInput;
};

/**
 * Group every precedence-participating layer by subject, then resolve each
 * subject with the single `resolveOrganizationDecision`. Excluded memory
 * (disabled/rejected/stale/deleted) is never built into an input, so it stops
 * influencing resolution the instant its head flips — mirroring the resolver's
 * documented contract. Returns the applied/overridden memory split and the
 * per-subject precedence outcomes.
 */
function resolvePrecedence(
  tenantId: string,
  hardPolicies: readonly DirectiveInput[],
  missionDecisions: readonly MissionDecisionInput[],
  orgMemory: readonly OrgMemoryInput[],
  userPreferences: readonly DirectiveInput[],
): {
  applied: AppliedMemory[];
  overridden: OverriddenMemory[];
  outcomes: PrecedenceOutcome[];
} {
  const subjects = new Map<string, SubjectLayers>();
  const ensure = (subjectKey: string): SubjectLayers => {
    let layers = subjects.get(subjectKey);
    if (!layers) {
      layers = {};
      subjects.set(subjectKey, layers);
    }
    return layers;
  };

  for (const policy of hardPolicies) {
    assertTenant(tenantId, policy.tenantId);
    // First hard policy per subject wins the slot; a second is a config error.
    const layers = ensure(policy.subjectKey);
    if (layers.hardPolicy) throw new Error("mission_context_duplicate_hard_policy");
    layers.hardPolicy = policy;
  }
  for (const decision of missionDecisions) {
    assertTenant(tenantId, decision.tenantId);
    const layers = ensure(decision.subjectKey);
    if (layers.missionDecision) throw new Error("mission_context_duplicate_mission_decision");
    layers.missionDecision = decision;
  }
  for (const preference of userPreferences) {
    assertTenant(tenantId, preference.tenantId);
    const layers = ensure(preference.subjectKey);
    if (layers.userPreference) throw new Error("mission_context_duplicate_user_preference");
    layers.userPreference = preference;
  }
  for (const memory of orgMemory) {
    assertTenant(tenantId, memory.record.tenantId);
    const layer = organizationMemoryPrecedenceLayer(memory.record);
    if (layer === "excluded") continue; // disabled/rejected/stale/deleted: never participates
    const layers = ensure(memory.subjectKey);
    if (layer === "confirmed_org_memory") {
      if (layers.confirmedOrgMemory) throw new Error("mission_context_duplicate_confirmed_memory");
      layers.confirmedOrgMemory = memory;
    } else {
      if (layers.inferredCandidate) throw new Error("mission_context_duplicate_inferred_memory");
      layers.inferredCandidate = memory;
    }
  }

  const applied: AppliedMemory[] = [];
  const overridden: OverriddenMemory[] = [];
  const outcomes: PrecedenceOutcome[] = [];

  for (const subjectKey of [...subjects.keys()].sort(compareCodeUnits)) {
    const layers = subjects.get(subjectKey)!;
    const confirmedRef = layers.confirmedOrgMemory
      ? toOrganizationMemoryReference(layers.confirmedOrgMemory.record)
      : undefined;
    const inferredRef = layers.inferredCandidate
      ? toOrganizationMemoryReference(layers.inferredCandidate.record)
      : undefined;

    const precedenceInput: PrecedenceInput = {
      tenantId,
      ...(layers.hardPolicy
        ? { hardPolicy: { tenantId, id: layers.hardPolicy.id, directive: layers.hardPolicy.directive } }
        : {}),
      ...(layers.missionDecision
        ? {
            missionDecision: {
              tenantId,
              id: layers.missionDecision.id,
              directive: layers.missionDecision.directive,
            },
          }
        : {}),
      ...(confirmedRef ? { confirmedOrgMemory: confirmedRef } : {}),
      ...(layers.userPreference
        ? {
            userPreference: {
              tenantId,
              id: layers.userPreference.id,
              directive: layers.userPreference.directive,
            },
          }
        : {}),
      ...(inferredRef ? { inferredCandidate: inferredRef } : {}),
    };

    // The SINGLE precedence decision. Ordering is not re-derived here.
    const result = resolveOrganizationDecision(precedenceInput);
    outcomes.push(
      Object.freeze({
        subjectKey,
        winner: result.winner,
        reason: result.reason,
        overrides: result.overrides,
      }),
    );

    // A memory is APPLIED only when the resolver names it the winner. This is the
    // control that keeps an overridden memory out of the injected context.
    if (result.appliedMemory) {
      applied.push(
        Object.freeze({
          subjectKey,
          reference: result.appliedMemory,
          provenance: result.winner === "confirmed_org_memory" ? "confirmed" : "inferred",
        }),
      );
    }
    // Every memory present but outranked is surfaced, never dropped silently.
    for (const entry of result.overriddenMemory) {
      overridden.push(
        Object.freeze({ subjectKey, reference: entry.memory, overriddenBy: result.winner as PrecedenceLayerName }),
      );
    }
  }

  return { applied, overridden, outcomes };
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildGraphSection(
  tenantId: string,
  source: GraphSource,
): InheritedContextEnvelope["graphProjection"] {
  if (!source.consulted) {
    return Object.freeze({ status: "not_consulted", reason: source.reason });
  }
  const impact = source.impact;
  assertTenant(tenantId, impact.tenantId);
  const maxBytes = Math.min(source.maxBytes ?? MISSION_CONTEXT_BOUNDS.maxGraphBytes, MISSION_CONTEXT_BOUNDS.maxGraphBytes);
  let projection: ReturnType<typeof compileMissionGraphProjection>;
  try {
    // Reuse the one bounded graph projector; never write a second one.
    projection = compileMissionGraphProjection({ impact, maxBytes });
  } catch {
    return Object.freeze({ status: "not_consulted", reason: "graph_projection_failed" });
  }
  return Object.freeze({
    status: "consulted",
    projection: Object.freeze({
      graphVersionId: projection.graphVersionId,
      graphContentDigest: projection.graphContentDigest,
      resultDigest: projection.resultDigest,
      impact: projection.impact,
      coverageBasis: projection.coverage.basis,
      byteLength: projection.compiled.byteLength,
      content: projection.compiled.content,
      contentDigest: projection.compiled.contentDigest,
    }),
  });
}

function buildVerificationSection(
  tenantId: string,
  source: SectionSource<VerificationInput>,
): InheritedContextEnvelope["verificationState"] {
  if (!source.consulted) {
    return sectionNotConsulted(source);
  }
  const entries = source.records.slice(0, MISSION_CONTEXT_BOUNDS.maxSectionItems).map((record) => {
    assertTenant(tenantId, record.tenantId);
    // The staleness/currency decision belongs to `classifyMissionVerificationEvidence`,
    // not to the compiler. We validate the state is a known one and carry it (and
    // its reason) through unchanged — never re-deriving currency from the bound ids.
    if (!MISSION_VERIFICATION_STATES.has(record.state)) {
      throw new Error("mission_context_verification_state_invalid");
    }
    return Object.freeze({
      id: identifier(record.id, "mission_context_verification_id_invalid"),
      statement: clippedText(record.statement, "mission_context_verification_statement_invalid"),
      verdict: identifier(record.verdict, "mission_context_verification_verdict_invalid"),
      state: record.state,
      reason: record.reason ? clippedText(record.reason, "mission_context_verification_reason_invalid") : null,
      boundSnapshotId: record.boundSnapshotId ?? null,
      boundGraphVersionId: record.boundGraphVersionId ?? null,
    });
  });
  return Object.freeze({ status: "consulted", entries: Object.freeze(entries) });
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

export function compileMissionContext(input: MissionContextInput): InheritedContextEnvelope {
  const tenantId = identifier(input.tenantId, "mission_context_tenant_invalid");

  const missionIdentity: MissionIdentity = Object.freeze({
    missionId: input.mission.missionId
      ? identifier(input.mission.missionId, "mission_context_mission_id_invalid")
      : null,
    product: input.mission.product,
    objective: clippedText(input.mission.objective, "mission_context_objective_invalid"),
    repositoryId: input.mission.repositoryId
      ? identifier(input.mission.repositoryId, "mission_context_repository_invalid")
      : null,
    snapshotId: input.mission.snapshotId
      ? identifier(input.mission.snapshotId, "mission_context_snapshot_invalid")
      : null,
    graphVersionId: input.mission.graphVersionId
      ? identifier(input.mission.graphVersionId, "mission_context_graph_version_invalid")
      : null,
  });
  if (input.mission.product !== "fettler" && input.mission.product !== "regauge") {
    throw new Error("mission_context_product_invalid");
  }

  const task: TaskDescriptor = Object.freeze({
    taskId: identifier(input.task.taskId, "mission_context_task_id_invalid"),
    capability: identifier(input.task.capability, "mission_context_capability_invalid"),
    riskClass: identifier(input.task.riskClass, "mission_context_risk_invalid"),
    goal: clippedText(input.task.goal, "mission_context_goal_invalid"),
  });

  // ---- precedence-governed sections ----
  const hardPolicyRecords = input.hardPolicies.consulted ? input.hardPolicies.records : [];
  const decisionRecords = input.missionDecisions.consulted ? input.missionDecisions.records : [];
  const memoryRecords = input.organizationMemory.consulted ? input.organizationMemory.records : [];
  const preferenceRecords = input.userPreferences.consulted ? input.userPreferences.records : [];

  const precedence = resolvePrecedence(
    tenantId,
    hardPolicyRecords,
    decisionRecords,
    memoryRecords,
    preferenceRecords,
  );

  let sectionItemsCapped = false;
  const cap = <T>(records: readonly T[]): readonly T[] => {
    if (records.length > MISSION_CONTEXT_BOUNDS.maxSectionItems) sectionItemsCapped = true;
    return records.slice(0, MISSION_CONTEXT_BOUNDS.maxSectionItems);
  };

  const relevantOrgMemory: OrgMemorySection = input.organizationMemory.consulted
    ? Object.freeze({
        status: "consulted",
        applied: Object.freeze(cap(precedence.applied)),
        overridden: Object.freeze(precedence.overridden.slice(0, MISSION_CONTEXT_BOUNDS.maxSectionItems)),
      })
    : sectionNotConsulted(input.organizationMemory);

  const activeDecisions: InheritedContextEnvelope["activeDecisions"] = input.missionDecisions.consulted
    ? Object.freeze({
        status: "consulted",
        entries: Object.freeze(
          cap(decisionRecords).map((record) => {
            assertTenant(tenantId, record.tenantId);
            return Object.freeze({
              id: identifier(record.id, "mission_context_decision_id_invalid"),
              subjectKey: identifier(record.subjectKey, "mission_context_decision_subject_invalid"),
              directive: clippedText(record.directive, "mission_context_decision_directive_invalid"),
              decidedAt: identifier(record.decidedAt, "mission_context_decision_time_invalid"),
            });
          }),
        ),
      })
    : sectionNotConsulted(input.missionDecisions);

  const policyConstraints: InheritedContextEnvelope["policyConstraints"] = (() => {
    if (!input.hardPolicies.consulted) return sectionNotConsulted(input.hardPolicies);
    const entries = Object.freeze(
      cap(hardPolicyRecords).map((record) => {
        assertTenant(tenantId, record.tenantId);
        return Object.freeze({
          id: identifier(record.id, "mission_context_policy_id_invalid"),
          subjectKey: identifier(record.subjectKey, "mission_context_policy_subject_invalid"),
          directive: clippedText(record.directive, "mission_context_policy_directive_invalid"),
          source: identifier(record.source, "mission_context_policy_source_invalid"),
        });
      }),
    );
    // An unparseable Policy Envelope is recorded as `unreadable` — a third state,
    // never a `consulted` empty read — while still carrying the maximally
    // restrictive fallback directives, so the failure is observable and safe.
    return input.hardPolicies.unreadable
      ? Object.freeze({ status: "unreadable", reason: input.hardPolicies.reason, entries })
      : Object.freeze({ status: "consulted", entries });
  })();

  const relevantHistory: InheritedContextEnvelope["relevantHistory"] = input.history.consulted
    ? Object.freeze({
        status: "consulted",
        entries: Object.freeze(
          cap(input.history.records).map((record) => {
            assertTenant(tenantId, record.tenantId);
            return Object.freeze({
              trajectoryRef: identifier(record.trajectoryRef, "mission_context_history_ref_invalid"),
              outcome: identifier(record.outcome, "mission_context_history_outcome_invalid"),
              summary: clippedText(record.summary, "mission_context_history_summary_invalid"),
            });
          }),
        ),
      })
    : sectionNotConsulted(input.history);
  const historyTruncated = input.history.consulted &&
    input.history.records.length > MISSION_CONTEXT_BOUNDS.maxSectionItems;

  const unresolvedExceptions: InheritedContextEnvelope["unresolvedExceptions"] = input.exceptions.consulted
    ? Object.freeze({
        status: "consulted",
        entries: Object.freeze(
          cap(input.exceptions.records).map((record) => {
            assertTenant(tenantId, record.tenantId);
            return Object.freeze({
              id: identifier(record.id, "mission_context_exception_id_invalid"),
              statement: clippedText(record.statement, "mission_context_exception_statement_invalid"),
              status: identifier(record.status, "mission_context_exception_status_invalid"),
            });
          }),
        ),
      })
    : sectionNotConsulted(input.exceptions);

  if (input.artifacts.consulted) {
    for (const record of input.artifacts.records) assertTenant(tenantId, record.tenantId);
  }
  const missionArtifacts: InheritedContextEnvelope["missionArtifacts"] = input.artifacts.consulted
    ? Object.freeze({
        status: "consulted",
        entries: Object.freeze(
          cap(input.artifacts.records).map((record) => {
            return Object.freeze({
              id: identifier(record.id, "mission_context_artifact_id_invalid"),
              role: identifier(record.role, "mission_context_artifact_role_invalid"),
              artifactId: identifier(record.artifactId, "mission_context_artifact_ref_invalid"),
              artifactSha256: identifier(record.artifactSha256, "mission_context_artifact_sha256_invalid"),
              label: clippedText(record.label.replace(/\s+/g, " "), "mission_context_artifact_label_invalid"),
              createdAt: identifier(record.createdAt, "mission_context_artifact_created_at_invalid"),
              taskId: record.taskId === null ? null : identifier(record.taskId, "mission_context_artifact_task_id_invalid"),
            });
          }),
        ),
      })
    : sectionNotConsulted(input.artifacts);

  const graphProjection = buildGraphSection(tenantId, input.graph);
  const verificationState = buildVerificationSection(tenantId, input.verification);

  const evidenceRefs = Object.freeze(
    [...new Set(input.evidenceRefs ?? [])]
      .map((ref) => text(ref, "mission_context_evidence_ref_invalid", 500))
      .sort(compareCodeUnits)
      .slice(0, MISSION_CONTEXT_BOUNDS.maxEvidenceRefs),
  );

  return Object.freeze({
    schemaVersion: "mendpoint.inherited-context.v1",
    tenantId,
    missionIdentity,
    task,
    graphProjection,
    relevantHistory,
    activeDecisions,
    relevantOrgMemory,
    policyConstraints,
    verificationState,
    unresolvedExceptions,
    missionArtifacts,
    evidenceRefs,
    precedence: Object.freeze(precedence.outcomes),
    bounds: Object.freeze({ sectionItemsCapped, historyTruncated, promptTruncated: false }),
  });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

/**
 * A supplied-context reference for `trajectories.context_refs_json`. Records
 * WHICH context was supplied and WHICH evidence was used — identifiers and
 * digests only. Never model reasoning (spec 8.12). A graph ref self-identifies
 * with `kind: "graph_context"` so the learning producer's delivery classifier
 * reads it as `recorded_present`.
 */
export type ContextRef =
  | Readonly<{
      kind: "mission_identity";
      missionId: string;
      repositoryId: string | null;
      snapshotId: string | null;
      graphVersionId: string;
    }>
  | Readonly<{ kind: "graph_context"; graphVersionId: string; contentDigest: string; byteLength: number }>
  | Readonly<{ kind: "org_memory"; recordId: string; memoryId: string; status: OrganizationMemoryStatus; provenance: "confirmed" | "inferred" }>
  | Readonly<{ kind: "org_memory_overridden"; recordId: string; overriddenBy: PrecedenceLayerName }>
  | Readonly<{ kind: "mission_decision"; id: string; subjectKey: string }>
  | Readonly<{ kind: "policy_constraint"; id: string; subjectKey: string; source: string }>
  | Readonly<{ kind: "verification"; id: string; state: MissionVerificationState }>
  | Readonly<{ kind: "exception"; id: string; status: string }>
  | Readonly<{ kind: "mission_artifact"; id: string; role: string; artifactId: string; sha256: string }>
  | Readonly<{ kind: "history"; trajectoryRef: string; outcome: string }>
  | Readonly<{ kind: "evidence"; ref: string }>;

export type CompiledMissionContext = Readonly<{
  envelope: InheritedContextEnvelope;
  injection: InheritedContextInjection;
  refs: readonly ContextRef[];
}>;

function sectionState<T extends { status: string }>(section: T): string {
  if (section.status === "consulted") return "consulted";
  if (section.status === "unreadable") return "unreadable";
  return "not consulted";
}

/**
 * Render the envelope to the bounded prompt body plus the context refs. The body
 * is sectioned and labelled; each section states whether it was consulted so a
 * reader (and the model) can tell "nothing applies" from "not consulted". The
 * body is dropped section by section (lowest priority first) if it exceeds the
 * prompt byte ceiling, and the drop is recorded in `bounds.promptTruncated`.
 */
export function renderMissionContext(envelope: InheritedContextEnvelope): CompiledMissionContext {
  const refs: ContextRef[] = [];
  const lines: string[] = [];

  lines.push(`# Inherited mission context (schema ${envelope.schemaVersion})`);
  lines.push(
    `Mission ${envelope.missionIdentity.missionId ?? "(none — task not part of a formal mission)"} ` +
      `(${envelope.missionIdentity.product}); objective: ${envelope.missionIdentity.objective}`,
  );
  if (
    envelope.missionIdentity.missionId &&
    envelope.missionIdentity.graphVersionId
  ) {
    lines.push(
      `Mission bindings: repository ${envelope.missionIdentity.repositoryId ?? "(none)"}; ` +
        `snapshot ${envelope.missionIdentity.snapshotId ?? "(none)"}; ` +
        `graph version ${envelope.missionIdentity.graphVersionId}`,
    );
    refs.push(
      Object.freeze({
        kind: "mission_identity",
        missionId: envelope.missionIdentity.missionId,
        repositoryId: envelope.missionIdentity.repositoryId,
        snapshotId: envelope.missionIdentity.snapshotId,
        graphVersionId: envelope.missionIdentity.graphVersionId,
      }),
    );
  }
  lines.push(`Task ${envelope.task.taskId}; capability ${envelope.task.capability}; risk ${envelope.task.riskClass}`);
  lines.push(`Task goal: ${envelope.task.goal}`);

  // Ordered by drop-priority (highest kept longest). Artifacts drop first:
  // they are refs, not standing. Verification and org memory stay longer.
  const sections: string[][] = [];

  // Policy constraints (highest authority).
  const policyLines: string[] = [`## Policy constraints [${sectionState(envelope.policyConstraints)}]`];
  if (envelope.policyConstraints.status === "not_consulted") {
    policyLines.push(`(reason: ${envelope.policyConstraints.reason})`);
  } else {
    // An unreadable envelope still renders its maximally restrictive fallback, and
    // names why it fell back so the reader (and the model) sees the constraints
    // were imposed because the policy could not be parsed, not authored.
    if (envelope.policyConstraints.status === "unreadable") {
      policyLines.push(`(policy envelope unreadable: ${envelope.policyConstraints.reason}; enforcing the maximally restrictive fallback)`);
    } else if (envelope.policyConstraints.entries.length === 0) {
      policyLines.push("(none apply to this task)");
    }
    for (const entry of envelope.policyConstraints.entries) {
      policyLines.push(`- [${entry.subjectKey}] ${entry.directive} (source: ${entry.source})`);
      refs.push(Object.freeze({ kind: "policy_constraint", id: entry.id, subjectKey: entry.subjectKey, source: entry.source }));
    }
  }
  sections.push(policyLines);

  // Active mission decisions.
  const decisionLines: string[] = [`## Active mission decisions [${sectionState(envelope.activeDecisions)}]`];
  if (envelope.activeDecisions.status === "consulted") {
    if (envelope.activeDecisions.entries.length === 0) decisionLines.push("(none apply to this task)");
    for (const entry of envelope.activeDecisions.entries) {
      decisionLines.push(`- [${entry.subjectKey}] ${entry.directive} (decided ${entry.decidedAt})`);
      refs.push(Object.freeze({ kind: "mission_decision", id: entry.id, subjectKey: entry.subjectKey }));
    }
  } else {
    decisionLines.push(`(reason: ${envelope.activeDecisions.reason})`);
  }
  sections.push(decisionLines);

  // Unresolved exceptions.
  const exceptionLines: string[] = [`## Unresolved exceptions [${sectionState(envelope.unresolvedExceptions)}]`];
  if (envelope.unresolvedExceptions.status === "consulted") {
    if (envelope.unresolvedExceptions.entries.length === 0) exceptionLines.push("(none open for this task)");
    for (const entry of envelope.unresolvedExceptions.entries) {
      exceptionLines.push(`- ${entry.statement} (status: ${entry.status})`);
      refs.push(Object.freeze({ kind: "exception", id: entry.id, status: entry.status }));
    }
  } else {
    exceptionLines.push(`(reason: ${envelope.unresolvedExceptions.reason})`);
  }
  sections.push(exceptionLines);

  // Verification: current evidence and superseded evidence are separated. A stale
  // verification is listed under "superseded" and is NEVER presented as current.
  const verificationLines: string[] = [`## Verification state [${sectionState(envelope.verificationState)}]`];
  if (envelope.verificationState.status === "consulted") {
    // ONLY `current_evidence` is rendered as current. Every other state
    // (stale_evidence, never_verified, no_current_evidence) is presented as
    // not-current, preserving the classifier's distinct state and reason.
    const current = envelope.verificationState.entries.filter((entry) => entry.state === "current_evidence");
    const notCurrent = envelope.verificationState.entries.filter((entry) => entry.state !== "current_evidence");
    if (current.length === 0) verificationLines.push("Current evidence: (none)");
    for (const entry of current) {
      verificationLines.push(`- current: ${entry.statement} -> ${entry.verdict}`);
    }
    for (const entry of notCurrent) {
      const reason = entry.reason ? `, reason: ${entry.reason}` : "";
      verificationLines.push(
        `- NOT CURRENT (${entry.state}${reason}, do not treat as current): ${entry.statement} -> ${entry.verdict}`,
      );
    }
    for (const entry of envelope.verificationState.entries) {
      refs.push(Object.freeze({ kind: "verification", id: entry.id, state: entry.state }));
    }
  } else {
    verificationLines.push(`(reason: ${envelope.verificationState.reason})`);
  }
  sections.push(verificationLines);

  // Relevant organization memory (precedence-resolved). Applied vs overridden are
  // both shown, so a consumer learns which memory governed and which was displaced.
  const memoryLines: string[] = [`## Relevant organization memory [${sectionState(envelope.relevantOrgMemory)}]`];
  if (envelope.relevantOrgMemory.status === "consulted") {
    if (envelope.relevantOrgMemory.applied.length === 0 && envelope.relevantOrgMemory.overridden.length === 0) {
      memoryLines.push("(no organization memory applies to this task)");
    }
    for (const entry of envelope.relevantOrgMemory.applied) {
      memoryLines.push(`- applies (${entry.provenance}) [${entry.subjectKey}]: ${entry.reference.statement}`);
      refs.push(
        Object.freeze({
          kind: "org_memory",
          recordId: entry.reference.recordId,
          memoryId: entry.reference.memoryId,
          status: entry.reference.status,
          provenance: entry.provenance,
        }),
      );
    }
    for (const entry of envelope.relevantOrgMemory.overridden) {
      memoryLines.push(
        `- OVERRIDDEN by ${entry.overriddenBy} [${entry.subjectKey}] (not applied): ${entry.reference.statement}`,
      );
      refs.push(
        Object.freeze({ kind: "org_memory_overridden", recordId: entry.reference.recordId, overriddenBy: entry.overriddenBy }),
      );
    }
  } else {
    memoryLines.push(`(reason: ${envelope.relevantOrgMemory.reason})`);
  }
  sections.push(memoryLines);

  // Graph projection (bounded, reused compiler).
  const graphLines: string[] = [`## Graph projection [${sectionState(envelope.graphProjection)}]`];
  if (envelope.graphProjection.status === "consulted") {
    const projection = envelope.graphProjection.projection;
    graphLines.push(
      `impact=${projection.impact} coverage=${projection.coverageBasis} ` +
        `graphVersion=${projection.graphVersionId} (${projection.byteLength} bytes)`,
    );
    graphLines.push(projection.content);
    refs.push(
      Object.freeze({
        kind: "graph_context",
        graphVersionId: projection.graphVersionId,
        contentDigest: projection.contentDigest,
        byteLength: projection.byteLength,
      }),
    );
  } else {
    graphLines.push(`(reason: ${envelope.graphProjection.reason})`);
  }
  sections.push(graphLines);

  // Relevant history (lowest priority: dropped first under the byte ceiling).
  const historyLines: string[] = [`## Relevant history [${sectionState(envelope.relevantHistory)}]`];
  if (envelope.relevantHistory.status === "consulted") {
    if (envelope.relevantHistory.entries.length === 0) historyLines.push("(no prior attempts recorded)");
    for (const entry of envelope.relevantHistory.entries) {
      historyLines.push(`- ${entry.trajectoryRef} (${entry.outcome}): ${entry.summary}`);
      refs.push(Object.freeze({ kind: "history", trajectoryRef: entry.trajectoryRef, outcome: entry.outcome }));
    }
  } else {
    historyLines.push(`(reason: ${envelope.relevantHistory.reason})`);
  }
  sections.push(historyLines);

  // Mission artifacts by reference only. Last in drop order: refs are less
  // actionable than verification / org memory / graph standing.
  const artifactLines: string[] = [`## Mission artifacts [${sectionState(envelope.missionArtifacts)}]`];
  if (envelope.missionArtifacts.status === "consulted") {
    if (envelope.missionArtifacts.entries.length === 0) artifactLines.push("(none registered for this mission)");
    const newestByRole = new Set<string>();
    for (const entry of envelope.missionArtifacts.entries) {
      const newest = !newestByRole.has(entry.role);
      if (newest) newestByRole.add(entry.role);
      const task = entry.taskId ? ` task=${entry.taskId}` : "";
      const currency = newest ? " newest-in-role" : " superseded-in-role";
      artifactLines.push(
        `- [${entry.role}] ${entry.artifactId} sha256=${entry.artifactSha256} created=${entry.createdAt}${task}${currency} (${entry.label})`,
      );
      refs.push(
        Object.freeze({
          kind: "mission_artifact",
          id: entry.id,
          role: entry.role,
          artifactId: entry.artifactId,
          sha256: entry.artifactSha256,
        }),
      );
    }
  } else {
    artifactLines.push(`(reason: ${envelope.missionArtifacts.reason})`);
  }
  sections.push(artifactLines);

  for (const ref of envelope.evidenceRefs) refs.push(Object.freeze({ kind: "evidence", ref }));

  // Assemble under the byte ceiling, dropping whole low-priority sections last-first.
  let promptTruncated = false;
  const keep = sections.slice();
  const assemble = (): string => [lines.join("\n"), ...keep.map((section) => section.join("\n"))].join("\n\n");
  while (Buffer.byteLength(assemble(), "utf8") > MISSION_CONTEXT_BOUNDS.maxPromptBytes && keep.length > 0) {
    keep.pop();
    promptTruncated = true;
  }
  const promptBody = assemble();
  const byteLength = Buffer.byteLength(promptBody, "utf8");

  const injection: InheritedContextInjection = Object.freeze({
    schemaVersion: "mendpoint.inherited-context.v1",
    digest: sha256(promptBody),
    promptBody,
    sectionCount: keep.length,
    byteLength,
  });

  const finalEnvelope: InheritedContextEnvelope = promptTruncated
    ? Object.freeze({ ...envelope, bounds: Object.freeze({ ...envelope.bounds, promptTruncated: true }) })
    : envelope;

  return Object.freeze({ envelope: finalEnvelope, injection, refs: Object.freeze(refs) });
}

/** Compile and render in one call — the shape the worker consumes. */
export function compileAndRenderMissionContext(input: MissionContextInput): CompiledMissionContext {
  return renderMissionContext(compileMissionContext(input));
}
