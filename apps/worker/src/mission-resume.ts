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
import type { ContextRef, InheritedContextEnvelope } from "@mendpoint/pipeline";
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
  task: Readonly<{ taskId: string; capability: string; riskClass: string; goal: string }>;
  fallback: Readonly<{ objective: string; repositoryId: string | null; snapshotId: string | null }>;
  evidenceRefs?: readonly string[];
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
  | InheritedContextEnvelope["missionArtifacts"];

/**
 * Classify an already-compiled envelope (pure). `store_not_available` on a
 * section we intended to read means the store did not load: that is
 * `context_not_loaded`, NOT `no_prior_context`. `no_mission_bound` on a
 * mission-scoped section is a legitimate absence, not a load failure. Only
 * `hardPolicies`/`userPreferences` are excluded here — they are known-absent
 * stores on main (no per-tenant policy row exists), not failed loads.
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
  ];
  for (const { name, section } of intended) {
    if (!section) return { kind: "context_not_loaded", reason: `section_missing:${name}` };
    if (section.status === "not_consulted" && section.reason === "store_not_available") {
      return { kind: "context_not_loaded", reason: `store_not_available:${name}` };
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
