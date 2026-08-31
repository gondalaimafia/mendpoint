/**
 * Resume side of the agent -> human -> agent handoff (task brief §3).
 *
 * A resume must NOT start a disconnected session with a concatenated string. It
 * reads the COMPILED ENVELOPE that the Mission Context Compiler assembles from
 * the durable stores (organization memory always; decisions, exceptions,
 * verification, and history when the task is mission-bound), and returns a
 * standing that keeps three different absences DISTINCT — the collapse of which
 * is this repository's dominant defect:
 *
 *   - `no_mission_bound`   — this task is not part of a formal mission, so there
 *                            is no mission-scoped prior context to inherit (and
 *                            there is no tenant organization memory either).
 *   - `no_prior_context`   — the stores WERE consulted and genuinely hold nothing
 *                            to inherit for this task.
 *   - `context_not_loaded` — a store we meant to read did not load (it threw, or
 *                            a section came back store-unavailable, or a claimed
 *                            mission could not be resolved). This must never read
 *                            as "no prior context": it fails closed.
 *
 * Plus an ownership guard: a run whose status does not map to an agent-owned
 * ownership phase (including an unrecognized status) is `not_resumable` — a
 * resume is refused rather than injected into a run that is not the agent's to
 * run.
 */
import {
  getMission,
  ownershipHolder,
  ownershipStateForAgentRunStatus,
  type AppDb,
  type Mission,
} from "@mendpoint/db";
import type { InheritedContextInjection } from "@mendpoint/agent";
import type {
  ContextRef,
  InheritedContextEnvelope,
  MissionSectionNotConsultedReason,
  SectionNotConsultedReason,
} from "@mendpoint/pipeline";
import type { GraphLearnDb } from "@mendpoint/graph-learn";
import { buildMissionContext, hasInheritedContent } from "./mission-context.js";

export type ResumeContextParams = Readonly<{
  tenantId: string;
  /** The status of the run being resumed, for the ownership guard. */
  currentRunStatus: string;
  /**
   * The mission this resumed task belongs to, if the job payload carries one. A
   * present-but-unresolvable id fails closed (`context_not_loaded`); an absent id
   * is an honest `no_mission_bound`, never fabricated into a mission.
   */
  missionId?: string | null;
  task: Readonly<{
    taskId: string;
    capability: string;
    riskClass: string;
    goal: string;
    endpointKey?: string | null;
  }>;
  fallback: Readonly<{ objective: string; repositoryId: string | null; snapshotId: string | null }>;
  evidenceRefs?: readonly string[];
  graphDb?: GraphLearnDb | null;
  /** Why `graphDb` is absent, when the caller resolved a handle that came back unavailable. */
  graphUnavailableReason?: string | null;
}>;

export type ResumeContextStanding =
  | Readonly<{
      status: "loaded";
      injection: InheritedContextInjection;
      refs: readonly ContextRef[];
      envelope: InheritedContextEnvelope;
      missionBound: boolean;
    }>
  | Readonly<{ status: "no_prior_context"; envelope: InheritedContextEnvelope; missionBound: boolean }>
  | Readonly<{ status: "no_mission_bound"; envelope: InheritedContextEnvelope }>
  | Readonly<{ status: "context_not_loaded"; reason: string }>
  | Readonly<{ status: "not_resumable"; reason: string }>;

/** The classification of a compiled envelope, without the rendered payload. */
export type ResumeStandingKind =
  | Readonly<{ kind: "loaded" }>
  | Readonly<{ kind: "no_prior_context" }>
  | Readonly<{ kind: "no_mission_bound" }>
  | Readonly<{ kind: "context_not_loaded"; reason: string }>;

/** The envelope sections a resume actually intends to read. */
type IntendedSection =
  | InheritedContextEnvelope["activeDecisions"]
  | InheritedContextEnvelope["unresolvedExceptions"]
  | InheritedContextEnvelope["verificationState"]
  | InheritedContextEnvelope["relevantHistory"]
  | InheritedContextEnvelope["relevantOrgMemory"]
  | InheritedContextEnvelope["missionArtifacts"]
  | InheritedContextEnvelope["graphProjection"];

/**
 * Every `not_consulted` reason, classified once. `failure` means we meant to look
 * and could not, which is `context_not_loaded` and never `no_prior_context`;
 * `absence` means there was genuinely nothing to look for.
 *
 * These are exhaustive `Record`s over the reason unions DELIBERATELY: adding a
 * member to `SectionNotConsultedReason` or `MissionSectionNotConsultedReason`
 * without classifying it here is a COMPILE error. A scan that instead listed the
 * failing reasons by hand is what let `graph_version_absent` carry a dangling
 * graph-version pin straight through to `loaded` (docs/agents/FAILURE_MODES.md §1).
 */
const GRAPH_REASON_DISPOSITION: Record<SectionNotConsultedReason, "absence" | "failure"> = {
  // Nothing was pinned, nothing was asked: honest absences.
  graph_version_absent: "absence",
  endpoint_key_absent: "absence",
  // We meant to consult the graph and could not.
  store_not_available: "failure",
  graph_repository_unresolved: "failure",
  graph_version_unresolvable: "failure",
  graph_projection_failed: "failure",
};

const MISSION_REASON_DISPOSITION: Record<MissionSectionNotConsultedReason, "absence" | "failure"> = {
  store_not_available: "failure",
  // This task is not part of a formal Mission, so mission-scoped context does not
  // apply. Reachable, not failed.
  no_mission_bound: "absence",
};

/** An unclassified reason is one nobody thought about, so it fails closed. */
function reasonDisposition(reason: string): "absence" | "failure" {
  const lookup = (map: Record<string, "absence" | "failure">): "absence" | "failure" | undefined =>
    Object.hasOwn(map, reason) ? map[reason] : undefined;
  return lookup(GRAPH_REASON_DISPOSITION) ?? lookup(MISSION_REASON_DISPOSITION) ?? "failure";
}

/**
 * Classify an already-compiled envelope (pure). A `not_consulted` section whose
 * reason is a `failure` above means the store did not load: that is
 * `context_not_loaded`, NOT `no_prior_context`. Only `hardPolicies`/
 * `userPreferences` are excluded here — they are known-absent stores on main (no
 * per-tenant policy row exists), not failed loads.
 */
export function classifyResumeStanding(
  envelope: InheritedContextEnvelope,
  missionBound: boolean,
): ResumeStandingKind {
  const intended: Array<{ name: string; section: IntendedSection }> = [
    { name: "org_memory", section: envelope.relevantOrgMemory },
    { name: "decisions", section: envelope.activeDecisions },
    { name: "exceptions", section: envelope.unresolvedExceptions },
    { name: "verification", section: envelope.verificationState },
    { name: "history", section: envelope.relevantHistory },
    { name: "artifacts", section: envelope.missionArtifacts },
    { name: "graph", section: envelope.graphProjection },
  ];
  for (const { name, section } of intended) {
    if (!section) return { kind: "context_not_loaded", reason: `section_missing:${name}` };
    if (section.status === "not_consulted" && reasonDisposition(section.reason) === "failure") {
      // `detail`, when the producer had one, names WHICH cause produced the reason
      // (e.g. which tenant-graph-handle failure). It is appended, never substituted:
      // the reason itself is what decides fail-closed.
      const detail = "detail" in section && section.detail ? `:${section.detail}` : "";
      return { kind: "context_not_loaded", reason: `${section.reason}:${name}${detail}` };
    }
  }
  if (hasInheritedContent(envelope)) return { kind: "loaded" };
  if (missionBound) return { kind: "no_prior_context" };
  return { kind: "no_mission_bound" };
}

/**
 * Resolve the inherited context for a resuming task. Fails closed: an ownership
 * phase that is not the agent's, an unresolvable mission id, or a compile
 * failure each returns a distinct non-`loaded` standing rather than an empty one.
 */
export function resolveResumeContext(db: AppDb, params: ResumeContextParams): ResumeContextStanding {
  // Ownership guard. An unrecognized status maps to `unknown` -> `indeterminate`
  // (fail closed), so a corrupt status is `not_resumable`, never agent-owned.
  const ownership = ownershipStateForAgentRunStatus(params.currentRunStatus);
  if (ownershipHolder(ownership) !== "agent") {
    return { status: "not_resumable", reason: `run_ownership:${ownership}` };
  }

  let mission: Mission | null = null;
  if (params.missionId) {
    const resolved = getMission(db, params.tenantId, params.missionId);
    if (!resolved) {
      // We were told this task is mission-bound but the mission did not load.
      // Never silently downgrade to "no mission": fail closed.
      return { status: "context_not_loaded", reason: "mission_not_found" };
    }
    mission = resolved;
  }

  let compiled: ReturnType<typeof buildMissionContext>;
  try {
    compiled = buildMissionContext(db, {
      tenantId: params.tenantId,
      mission,
      task: params.task,
      fallback: params.fallback,
      ...(params.evidenceRefs ? { evidenceRefs: params.evidenceRefs } : {}),
      ...(params.graphDb ? { graphDb: params.graphDb } : {}),
      ...(params.graphUnavailableReason ? { graphUnavailableReason: params.graphUnavailableReason } : {}),
    });
  } catch (error) {
    return {
      status: "context_not_loaded",
      reason: `compile_failed:${error instanceof Error ? error.message : "unknown"}`,
    };
  }

  const missionBound = mission !== null;
  const kind = classifyResumeStanding(compiled.envelope, missionBound);
  switch (kind.kind) {
    case "loaded":
      return {
        status: "loaded",
        injection: compiled.injection,
        refs: compiled.refs,
        envelope: compiled.envelope,
        missionBound,
      };
    case "no_prior_context":
      return { status: "no_prior_context", envelope: compiled.envelope, missionBound };
    case "no_mission_bound":
      return { status: "no_mission_bound", envelope: compiled.envelope };
    case "context_not_loaded":
      return { status: "context_not_loaded", reason: kind.reason };
  }
}
