/**
 * Worker-side producer for the Mission Context Compiler. The agent process holds
 * no database handle at the model seam, so this module (which does) reads the
 * durable stores and hands the compiler already-fetched inputs, then returns the
 * rendered injection plus the context refs to persist.
 *
 * Reads only. Tenant is always the authenticated job principal (`tenantId`),
 * never a value from a request body or the capture DTO. Every store read is
 * tenant-scoped; the compiler re-asserts the tenant on every item.
 *
 * Honest scope note (see docs/missions/CONTEXT_COMPILER.md): a Fettler repair job
 * on current main is NOT bound to a `mission` row (its agent.run payload carries
 * no campaign or mission id). So on that path the mission-scoped sections report
 * `no_mission_bound` — distinct from "store unavailable" — while the tenant-scoped
 * organization memory still applies. When a Fettler job IS mission-bound (a
 * separate, acknowledged binding gap), passing the resolved `mission` lights up
 * decisions, exceptions, verification, history, and mission artifacts too.
 */
import {
  classifyMissionVerificationEvidence,
  evaluateMissionExceptions,
  getActiveMissionDecisions,
  getMissionPolicyEnvelope,
  listMissionArtifacts,
  listMissionVerifications,
  listOrganizationMemory,
  listTrajectories,
  resolveMissionSnapshotIdentity,
  type AppDb,
  type Mission,
  type MissionVerificationStanding,
} from "@mendpoint/db";
import {
  compileAndRenderMissionContext,
  policyEnvelopeDirectives,
  type CompiledMissionContext,
  type InheritedContextEnvelope,
  type MissionContextInput,
  type VerificationInput,
} from "@mendpoint/pipeline";
import { queryFettlerEndpointImpact, type GraphLearnDb } from "@mendpoint/graph-learn";

export type BuildMissionContextParams = Readonly<{
  tenantId: string;
  /** The resolved Mission, or null when the task is not mission-bound. */
  mission: Mission | null;
  task: Readonly<{
    taskId: string;
    capability: string;
    riskClass: string;
    goal: string;
    /** Live Fettler endpoint key. Never invented; absent keeps graph not-consulted. */
    endpointKey?: string | null;
  }>;
  /** Fallback identity when no mission is bound (a Fettler repair on a snapshot). */
  fallback: Readonly<{ objective: string; repositoryId: string | null; snapshotId: string | null }>;
  evidenceRefs?: readonly string[];
  /**
   * Tenant Change Graph handle. Required to consult impact. Never created here
   * (`getGraphLearnDb` is not a production graph). Tests inject `openGraphLearnMemory()`.
   */
  graphDb?: GraphLearnDb | null;
}>;

/** Map a per-scope verification standing to the compiler's carried-through input. */
function verificationInputsForStanding(
  tenantId: string,
  scope: string,
  standing: MissionVerificationStanding,
): VerificationInput {
  if (standing.standing === "current_evidence") {
    const record = standing.record;
    return {
      tenantId,
      id: record.id,
      statement: record.verification,
      verdict: record.status,
      state: "current_evidence",
      reason: null,
      boundSnapshotId: record.snapshotId,
    };
  }
  if (standing.standing === "stale_evidence") {
    const record = standing.record;
    return {
      tenantId,
      id: record.id,
      statement: record.verification,
      verdict: record.status,
      state: "stale_evidence",
      reason: `snapshot_identity_changed:${standing.changed.field}`,
      boundSnapshotId: record.snapshotId,
    };
  }
  // no_current_evidence: no single record; surface the absence reason per scope so
  // "never verified" stays distinct from "only stale" and from a failed current run.
  return {
    tenantId,
    id: `verification:${scope}`,
    statement: `scope ${scope}`,
    verdict: "none",
    state: "no_current_evidence",
    reason: standing.reason,
  };
}

function buildGraphSource(params: BuildMissionContextParams): MissionContextInput["graph"] {
  const graphVersionId = params.mission?.graphVersionId ?? null;
  if (!graphVersionId) return { consulted: false, reason: "graph_version_absent" };
  const endpointKey = params.task.endpointKey?.trim() ?? "";
  if (!endpointKey) return { consulted: false, reason: "endpoint_key_absent" };
  const repositoryId = params.mission?.repositoryId ?? params.fallback.repositoryId;
  if (!repositoryId) return { consulted: false, reason: "not_applicable_to_task" };
  const graphDb = params.graphDb ?? null;
  if (!graphDb) return { consulted: false, reason: "store_not_available" };
  try {
    const impact = queryFettlerEndpointImpact(graphDb, {
      tenantId: params.tenantId,
      repositoryId,
      graphVersionId,
      endpointKey,
      maxHops: 6,
      maxEntities: 50,
      maxRelationships: 100,
    });
    return { consulted: true, impact };
  } catch {
    return { consulted: false, reason: "graph_projection_failed" };
  }
}

/**
 * Assemble and render the inherited context for one Fettler task. Returns the
 * compiled envelope, the injection to place on the task, and the context refs to
 * persist. Never throws for a store read: a read failure surfaces as a
 * `not_consulted` section, never as a fabricated empty one.
 */
export function buildMissionContext(
  db: AppDb,
  params: BuildMissionContextParams,
): CompiledMissionContext {
  const { tenantId, mission } = params;

  // Organization memory is tenant-scoped and applies with or without a mission.
  // Subject key is the memory scope, which decisions share, so a decision and a
  // memory on the same scope contend under the single precedence resolver.
  const memoryHeads = listOrganizationMemory(db, { tenantId });
  const organizationMemory: MissionContextInput["organizationMemory"] = {
    consulted: true,
    records: memoryHeads.map((record) => ({ subjectKey: record.scope, record })),
  };

  const missionId = mission?.id ?? null;
  const snapshotId = mission?.snapshotId ?? params.fallback.snapshotId;

  const missionDecisions: MissionContextInput["missionDecisions"] = mission
    ? {
        consulted: true,
        records: getActiveMissionDecisions(db, tenantId, mission.id).map((decision) => ({
          tenantId,
          id: decision.id,
          subjectKey: decision.scope,
          directive: decision.decision,
          decidedAt: decision.createdAt,
        })),
      }
    : { consulted: false, reason: "no_mission_bound" };

  const exceptions: MissionContextInput["exceptions"] = mission
    ? (() => {
        const evaluation = evaluateMissionExceptions(db, tenantId, mission.id);
        // Unresolved = open exceptions (blocking, non-blocking-open, and stale
        // ones awaiting re-affirmation). Resolved/withdrawn are excluded.
        const open = [...evaluation.blocking, ...evaluation.nonBlockingOpen, ...evaluation.stale];
        return {
          consulted: true,
          records: open.map((exception) => ({
            tenantId,
            id: exception.id,
            statement: exception.reason,
            status: exception.standing,
          })),
        };
      })()
    : { consulted: false, reason: "no_mission_bound" };

  // Verification currency is decided ONLY by classifyMissionVerificationEvidence,
  // and only when a bound current snapshot identity exists. With no mission or no
  // single snapshot binding, we report not_consulted rather than guessing currency.
  const verification: MissionContextInput["verification"] = (() => {
    if (!mission) return { consulted: false, reason: "no_mission_bound" as const };
    if (!mission.snapshotId) return { consulted: false, reason: "no_mission_bound" as const };
    const current = resolveMissionSnapshotIdentity(db, tenantId, mission.snapshotId);
    const all = listMissionVerifications(db, tenantId, mission.id);
    const scopes = [...new Set(all.map((record) => record.scope))].sort();
    return {
      consulted: true,
      records: scopes.map((scope) =>
        verificationInputsForStanding(
          tenantId,
          scope,
          classifyMissionVerificationEvidence(
            all.filter((record) => record.scope === scope),
            current,
          ),
        ),
      ),
    };
  })();

  // The Mission's inherited Policy Envelope (spec §6.7) becomes the hard-policy
  // layer: its real constraints are rendered and outrank organization memory in
  // precedence. When the mission pins no envelope (legacy missions predating
  // set-once binding at creation), the policy store is honestly not consulted.
  const policyEnvelope = mission ? getMissionPolicyEnvelope(db, tenantId, mission.id) : null;
  const hardPolicies: MissionContextInput["hardPolicies"] = (() => {
    if (!policyEnvelope) return { consulted: false, reason: "store_not_available" };
    const directives = policyEnvelopeDirectives(tenantId, policyEnvelope.envelopeJson, policyEnvelope.version);
    // A corrupt envelope row is recorded as `unreadable` (not an empty consulted
    // read) and carries the maximally restrictive fallback, so it is never less
    // restrictive than a valid envelope.
    return directives.readable
      ? { consulted: true, records: directives.directives }
      : { consulted: true, unreadable: true, reason: directives.reason, records: directives.directives };
  })();

  const history: MissionContextInput["history"] = mission
    ? {
        consulted: true,
        records: listTrajectories(db, tenantId, { missionId: mission.id, limit: 32 }).map((trajectory) => ({
          tenantId,
          trajectoryRef: trajectory.id,
          outcome: trajectory.finalOutcome ?? "unknown",
          summary: trajectory.taskSummary,
        })),
      }
    : { consulted: false, reason: "no_mission_bound" };

  const artifacts: MissionContextInput["artifacts"] = (() => {
    if (!mission) return { consulted: false, reason: "no_mission_bound" };
    try {
      return {
        consulted: true,
        records: listMissionArtifacts(db, tenantId, mission.id, undefined, 32).map((artifact) => ({
          tenantId,
          id: artifact.id,
          role: artifact.role,
          artifactId: artifact.artifactId,
          artifactSha256: artifact.artifactSha256,
          label: artifact.label,
          createdAt: artifact.createdAt,
          taskId: artifact.taskId,
        })),
      };
    } catch (error) {
      console.error(
        `  mission artifact context read failed tenant=${tenantId} mission=${mission.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { consulted: false, reason: "store_not_available" };
    }
  })();

  const input: MissionContextInput = {
    tenantId,
    mission: {
      missionId,
      product: mission?.product ?? "fettler",
      objective: mission?.objective ?? params.fallback.objective,
      repositoryId: mission?.repositoryId ?? params.fallback.repositoryId,
      snapshotId,
      graphVersionId: mission?.graphVersionId ?? null,
    },
    task: params.task,
    // Policy constraints come from the mission's inherited Policy Envelope
    // (spec §6.7). When no envelope is pinned, the section is honestly not
    // consulted rather than fabricated. The precedence machinery is exercised
    // whenever a policy directive, mission decision, and memory share a scope.
    hardPolicies,
    missionDecisions,
    organizationMemory,
    userPreferences: { consulted: false, reason: "store_not_available" },
    // Impact-path projection requires a real endpoint key from a live Fettler
    // surface (`queryFettlerEndpointImpact`). This producer does not invent one.
    graph: buildGraphSource(params),
    history,
    verification,
    exceptions,
    artifacts,
    ...(params.evidenceRefs ? { evidenceRefs: params.evidenceRefs } : {}),
  };

  return compileAndRenderMissionContext(input);
}

/**
 * Whether an envelope carries any inherited content worth injecting. An envelope
 * whose every inherited section is empty or not-consulted is not injected, so the
 * prompt is not grown for nothing.
 */
export function hasInheritedContent(envelope: InheritedContextEnvelope): boolean {
  if (envelope.missionIdentity.graphVersionId !== null) return true;
  if (envelope.relevantOrgMemory.status === "consulted" && envelope.relevantOrgMemory.applied.length > 0) {
    return true;
  }
  if (envelope.activeDecisions.status === "consulted" && envelope.activeDecisions.entries.length > 0) return true;
  if (envelope.unresolvedExceptions.status === "consulted" && envelope.unresolvedExceptions.entries.length > 0) {
    return true;
  }
  if (envelope.missionArtifacts?.status === "consulted" && envelope.missionArtifacts.entries.length > 0) {
    return true;
  }
  if (envelope.verificationState.status === "consulted" && envelope.verificationState.entries.length > 0) return true;
  if (envelope.policyConstraints.status === "consulted" && envelope.policyConstraints.entries.length > 0) return true;
  // An unreadable envelope always carries the restrictive fallback and must reach the model.
  if (envelope.policyConstraints.status === "unreadable") return true;
  if (envelope.graphProjection.status === "consulted") return true;
  return false;
}
