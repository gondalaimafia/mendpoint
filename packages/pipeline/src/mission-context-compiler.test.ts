/**
 * Mission Context Compiler controls. Each test names the control it guards; the
 * control is deletable and the test dies when it is removed (see PR body).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getTrajectory,
  recordTrajectory,
  type AppDb,
  type OrganizationMemoryRecord,
  type OrganizationMemoryStatus,
} from "@mendpoint/db";
import type { FettlerEndpointImpactResult } from "@mendpoint/graph-learn";
import {
  compileMissionContext,
  MISSION_CONTEXT_BOUNDS,
  policyEnvelopeDirectives,
  renderMissionContext,
  type MissionContextInput,
  type MissionVerificationState,
} from "./mission-context-compiler.js";
import {
  canonicalPolicyEnvelopeJson,
  defaultPolicyEnvelope,
  type PolicyEnvelope,
} from "@mendpoint/policy";

const T0 = "2026-01-01T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

describe("policyEnvelopeDirectives", () => {
  it("emits only the constraining dimensions of the default envelope", () => {
    const envelope = defaultPolicyEnvelope({ tenantId: "t1", policyEnvelopeId: "pe-1", createdAt: T0 });
    const result = policyEnvelopeDirectives("t1", canonicalPolicyEnvelopeJson(envelope), 1);
    expect(result.readable).toBe(true);
    const subjects = result.directives.map((d) => d.subjectKey).sort();
    // Default: review required, no deploy, no training — and nothing else.
    expect(subjects).toEqual(["policy:deployment", "policy:review", "policy:training"]);
    expect(result.directives.every((d) => d.source === "policy_envelope:v1" && d.tenantId === "t1")).toBe(true);
  });

  it("emits scope, zone, risk, and external-processing directives when restricted", () => {
    const restricted: PolicyEnvelope = {
      ...defaultPolicyEnvelope({ tenantId: "t1", policyEnvelopeId: "pe-1", createdAt: T0 }),
      repositoryScope: ["repo-a"],
      forbiddenZones: ["src/generated"],
      allowedTools: ["codemod"],
      allowedModelClasses: ["owned"],
      externalProcessingAllowed: false,
      riskCeiling: "medium",
    };
    const subjects = policyEnvelopeDirectives("t1", canonicalPolicyEnvelopeJson(restricted), 2)
      .directives.map((d) => d.subjectKey);
    expect(subjects).toContain("policy:repository_scope");
    expect(subjects).toContain("policy:forbidden_zone:src/generated");
    expect(subjects).toContain("policy:tool_scope");
    expect(subjects).toContain("policy:model_scope");
    expect(subjects).toContain("policy:external_processing");
    expect(subjects).toContain("policy:risk_ceiling");
  });

  it("emits the maximally restrictive fallback for a malformed envelope rather than an empty (fail-open) or partial policy", () => {
    for (const bad of ["{not json", JSON.stringify({ version: "x" })]) {
      const result = policyEnvelopeDirectives("t1", bad, 1);
      // The failure is observable: `readable: false` with a non-empty reason.
      expect(result.readable).toBe(false);
      if (result.readable) throw new Error("unreachable");
      expect(result.reason.length).toBeGreaterThan(0);
      const subjects = result.directives.map((d) => d.subjectKey).sort();
      // Maximally restrictive: review, no deploy, no external processing, no training.
      expect(subjects).toEqual([
        "policy:deployment",
        "policy:external_processing",
        "policy:review",
        "policy:training",
      ]);
      // Strictly MORE restrictive than the valid default, which does not forbid
      // external processing — a corrupt row is never LESS restrictive.
      expect(subjects).toContain("policy:external_processing");
      expect(result.directives).not.toHaveLength(0);
    }
  });
});

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    try {
      db.raw.close();
    } catch {
      /* already closed */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-ctx-"));
  const db = createDb(join(dir, "ctx.sqlite"));
  opened.push({ db, dir });
  db.raw
    .prepare(
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES ('t1','one','One','team','active',10,?)`,
    )
    .run(T0);
  return db;
}

/** A minimal Organization Memory head with only the fields the compiler reads. */
function memory(input: {
  tenantId?: string;
  status: OrganizationMemoryStatus;
  statement: string;
  memoryId?: string;
}): OrganizationMemoryRecord {
  const memoryId = input.memoryId ?? `om:${input.statement}`;
  return {
    recordId: `omv1:${memoryId}`,
    tenantId: input.tenantId ?? "t1",
    memoryId,
    revision: 1,
    supersedesRecordId: null,
    transition: "activated",
    scope: "repo:x",
    category: "MIGRATION_PREFERENCE",
    statement: input.statement,
    structuredValue: null,
    source: "explicit",
    sourceRefs: [],
    observationFingerprint: null,
    confidence: "high",
    status: input.status,
    appliesTo: [],
    trainingEligible: false,
    actorPrincipalId: null,
    reason: "test",
    contentSha256: "0".repeat(64),
    createdAt: T0,
    lastConfirmedAt: T0,
  } as OrganizationMemoryRecord;
}

function graphImpact(tenantId = "t1"): FettlerEndpointImpactResult {
  return {
    schemaVersion: "mendpoint.fettler-impact-context.v1",
    tenantId,
    repositoryId: "repo1",
    graphVersionId: "gv-1",
    graphContentDigest: "gcd",
    target: { status: "absent", reason: "absent" } as unknown as FettlerEndpointImpactResult["target"],
    impact: "unknown_impact",
    entities: [],
    relationships: [],
    paths: [],
    coverage: { basis: "target_absent", reasons: ["absent"], truncated: false },
    resultDigest: "rd",
  };
}

function baseInput(overrides: Partial<MissionContextInput> = {}): MissionContextInput {
  return {
    tenantId: "t1",
    mission: {
      missionId: "m1",
      product: "fettler",
      objective: "Migrate the payments SDK",
      repositoryId: "repo1",
      snapshotId: "snap1",
      graphVersionId: "gv-1",
    },
    task: { taskId: "task1", capability: "code_migration", riskClass: "medium", goal: "Do the migration" },
    hardPolicies: { consulted: true, records: [] },
    missionDecisions: { consulted: true, records: [] },
    organizationMemory: { consulted: true, records: [] },
    userPreferences: { consulted: true, records: [] },
    graph: { consulted: false, reason: "graph_version_absent" },
    history: { consulted: true, records: [] },
    verification: { consulted: true, records: [] },
    exceptions: { consulted: true, records: [] },
    evidenceRefs: [],
    ...overrides,
  };
}

describe("mission context compiler", () => {
  it("CONTROL 1: an explicit mission decision beats a conflicting org memory, and the envelope says so", () => {
    const envelope = compileMissionContext(
      baseInput({
        missionDecisions: {
          consulted: true,
          records: [
            { tenantId: "t1", id: "d1", subjectKey: "pr_atomicity", directive: "This migration must be atomic in one PR", decidedAt: T0 },
          ],
        },
        organizationMemory: {
          consulted: true,
          records: [{ subjectKey: "pr_atomicity", record: memory({ status: "ACTIVE", statement: "prefer small pull requests" }) }],
        },
      }),
    );
    expect(envelope.relevantOrgMemory.status).toBe("consulted");
    if (envelope.relevantOrgMemory.status !== "consulted") throw new Error("unreachable");
    // The mission decision wins: the memory is NOT applied, it is recorded as overridden.
    expect(envelope.relevantOrgMemory.applied).toHaveLength(0);
    expect(envelope.relevantOrgMemory.overridden).toHaveLength(1);
    expect(envelope.relevantOrgMemory.overridden[0]!.overriddenBy).toBe("mission_decision");
    const outcome = envelope.precedence.find((entry) => entry.subjectKey === "pr_atomicity");
    expect(outcome?.winner).toBe("mission_decision");
    const { injection } = renderMissionContext(envelope);
    expect(injection.promptBody).toContain("OVERRIDDEN by mission_decision");
    expect(injection.promptBody).toContain("This migration must be atomic in one PR");
  });

  it("CONTROL 2: an inferred memory candidate cannot override a hard policy", () => {
    const envelope = compileMissionContext(
      baseInput({
        hardPolicies: {
          consulted: true,
          records: [{ tenantId: "t1", id: "p1", subjectKey: "secret_logging", directive: "never log secrets", source: "platform_policy" }],
        },
        organizationMemory: {
          consulted: true,
          records: [{ subjectKey: "secret_logging", record: memory({ status: "MEMORY_CANDIDATE", statement: "log full request bodies for debugging" }) }],
        },
      }),
    );
    if (envelope.relevantOrgMemory.status !== "consulted") throw new Error("unreachable");
    expect(envelope.relevantOrgMemory.applied).toHaveLength(0);
    expect(envelope.relevantOrgMemory.overridden.map((entry) => entry.overriddenBy)).toEqual(["hard_policy"]);
    expect(envelope.precedence.find((entry) => entry.subjectKey === "secret_logging")?.winner).toBe("hard_policy");
  });

  it("CONTROL 3: the envelope is bounded under a deliberately oversized mission history", () => {
    const history = Array.from({ length: 200 }, (_, index) => ({
      tenantId: "t1",
      trajectoryRef: `traj-${index}`,
      outcome: "failed",
      summary: "x".repeat(1_800),
    }));
    const memories = Array.from({ length: 200 }, (_, index) => ({
      subjectKey: `subject-${index}`,
      record: memory({ status: "ACTIVE", statement: "y".repeat(1_800), memoryId: `om-${index}` }),
    }));
    const envelope = compileMissionContext(
      baseInput({ history: { consulted: true, records: history }, organizationMemory: { consulted: true, records: memories } }),
    );
    if (envelope.relevantHistory.status !== "consulted") throw new Error("unreachable");
    expect(envelope.relevantHistory.entries.length).toBeLessThanOrEqual(MISSION_CONTEXT_BOUNDS.maxSectionItems);
    expect(envelope.bounds.sectionItemsCapped).toBe(true);
    expect(envelope.bounds.historyTruncated).toBe(true);
    const { injection, envelope: rendered } = renderMissionContext(envelope);
    expect(injection.byteLength).toBeLessThanOrEqual(MISSION_CONTEXT_BOUNDS.maxPromptBytes);
    expect(rendered.bounds.promptTruncated).toBe(true);
  });

  it("CONTROL 4: 'no memory applies' is distinguishable from 'memory was not consulted'", () => {
    const applies = compileMissionContext(baseInput({ organizationMemory: { consulted: true, records: [] } }));
    const notConsulted = compileMissionContext(baseInput({ organizationMemory: { consulted: false } }));
    expect(applies.relevantOrgMemory.status).toBe("consulted");
    expect(notConsulted.relevantOrgMemory.status).toBe("not_consulted");
    if (notConsulted.relevantOrgMemory.status !== "not_consulted") throw new Error("unreachable");
    expect(notConsulted.relevantOrgMemory.reason).toBe("store_not_available");
    expect(renderMissionContext(applies).injection.promptBody).toContain("no organization memory applies");
    expect(renderMissionContext(notConsulted).injection.promptBody).toContain("reason: store_not_available");
  });

  it("CONTROL 5: verification against a changed snapshot is not presented as current", () => {
    const states: Array<{ state: MissionVerificationState; expectCurrent: boolean }> = [
      { state: "stale_evidence", expectCurrent: false },
      { state: "no_current_evidence", expectCurrent: false },
      { state: "current_evidence", expectCurrent: true },
    ];
    for (const { state, expectCurrent } of states) {
      const envelope = compileMissionContext(
        baseInput({
          verification: {
            consulted: true,
            records: [
              {
                tenantId: "t1",
                id: "v1",
                statement: "verifier ran green",
                verdict: "passed",
                state,
                reason: state === "current_evidence" ? null : "snapshot_identity_changed",
                boundSnapshotId: "snap-old",
              },
            ],
          },
        }),
      );
      if (envelope.verificationState.status !== "consulted") throw new Error("unreachable");
      expect(envelope.verificationState.entries[0]!.state).toBe(state);
      const body = renderMissionContext(envelope).injection.promptBody;
      if (expectCurrent) {
        expect(body).toContain("- current: verifier ran green");
      } else {
        expect(body).toContain(`NOT CURRENT (${state}`);
        expect(body).not.toContain("- current: verifier ran green");
      }
    }
  });

  it("CONTROL 6: context refs are populated (graph context self-identifies) and round-trip through the trajectory slot", () => {
    const db = fixtureDb();
    const compiled = renderMissionContext(
      compileMissionContext(baseInput({ graph: { consulted: true, impact: graphImpact() } })),
    );
    const graphRef = compiled.refs.find((ref) => ref.kind === "graph_context");
    expect(graphRef).toBeDefined();
    recordTrajectory(db, {
      id: "traj-1",
      tenantId: "t1",
      product: "fettler",
      taskKind: "code_migration",
      taskSummary: "migration",
      runId: "run-1",
      jobId: "job-1",
      contextRefs: compiled.refs,
      createdAt: T0,
    });
    const stored = getTrajectory(db, "t1", "traj-1")!;
    expect(stored.contextRefs.length).toBe(compiled.refs.length);
    expect(
      stored.contextRefs.some((ref) => typeof ref === "object" && ref !== null && (ref as { kind?: unknown }).kind === "graph_context"),
    ).toBe(true);
  });

  it("CONTROL 8: context from one tenant never reaches another tenant's envelope", () => {
    expect(() =>
      compileMissionContext(
        baseInput({
          organizationMemory: { consulted: true, records: [{ subjectKey: "s", record: memory({ tenantId: "t2", status: "ACTIVE", statement: "foreign" }) }] },
        }),
      ),
    ).toThrow("mission_context_tenant_mismatch");
    expect(() =>
      compileMissionContext(
        baseInput({
          missionDecisions: { consulted: true, records: [{ tenantId: "t2", id: "d", subjectKey: "s", directive: "foreign", decidedAt: T0 }] },
        }),
      ),
    ).toThrow("mission_context_tenant_mismatch");
    expect(() =>
      compileMissionContext(baseInput({ graph: { consulted: true, impact: graphImpact("t2") } })),
    ).toThrow("mission_context_tenant_mismatch");
  });

  it("excluded (disabled) memory never participates in resolution", () => {
    const envelope = compileMissionContext(
      baseInput({
        organizationMemory: { consulted: true, records: [{ subjectKey: "s", record: memory({ status: "DISABLED", statement: "was a convention" }) }] },
      }),
    );
    if (envelope.relevantOrgMemory.status !== "consulted") throw new Error("unreachable");
    expect(envelope.relevantOrgMemory.applied).toHaveLength(0);
    expect(envelope.relevantOrgMemory.overridden).toHaveLength(0);
    expect(envelope.precedence).toHaveLength(0);
  });

  it("'no mission bound' is distinguishable from 'store not available' for mission-scoped sections", () => {
    const envelope = compileMissionContext(
      baseInput({
        mission: { missionId: null, product: "fettler", objective: "repair a failing test", repositoryId: "repo1", snapshotId: null, graphVersionId: null },
        missionDecisions: { consulted: false, reason: "no_mission_bound" },
        exceptions: { consulted: false, reason: "no_mission_bound" },
        verification: { consulted: false, reason: "no_mission_bound" },
        organizationMemory: { consulted: true, records: [{ subjectKey: "s", record: memory({ status: "ACTIVE", statement: "squash-merge only" }) }] },
      }),
    );
    expect(envelope.missionIdentity.missionId).toBeNull();
    expect(envelope.activeDecisions.status).toBe("not_consulted");
    if (envelope.activeDecisions.status !== "not_consulted") throw new Error("unreachable");
    expect(envelope.activeDecisions.reason).toBe("no_mission_bound");
    // Org memory is tenant-scoped and still applies with no mission bound.
    expect(envelope.relevantOrgMemory.status).toBe("consulted");
    const body = renderMissionContext(envelope).injection.promptBody;
    expect(body).toContain("no_mission_bound");
    expect(body).toContain("task not part of a formal mission");
  });

  it("omitted artifacts are not_consulted, distinct from a bound empty read", () => {
    const omitted = compileMissionContext(baseInput());
    expect(omitted.missionArtifacts.status).toBe("not_consulted");
    if (omitted.missionArtifacts.status !== "not_consulted") throw new Error("unreachable");
    expect(omitted.missionArtifacts.reason).toBe("store_not_available");

    const emptyBound = compileMissionContext(baseInput({ artifacts: { consulted: true, records: [] } }));
    expect(emptyBound.missionArtifacts.status).toBe("consulted");
    if (emptyBound.missionArtifacts.status !== "consulted") throw new Error("unreachable");
    expect(emptyBound.missionArtifacts.entries).toEqual([]);
    const emptyBody = renderMissionContext(emptyBound).injection.promptBody;
    expect(emptyBody).toContain("Mission artifacts [consulted]");
    expect(emptyBody).toContain("(none registered for this mission)");
  });

  it("consulted artifacts carry refs/roles/sha256/label only, never bodies", () => {
    const envelope = compileMissionContext(
      baseInput({
        artifacts: {
          consulted: true,
          records: [{
            tenantId: "t1",
            id: "ma-1",
            role: "candidate_patch",
            artifactId: "art-patch",
            artifactSha256: "a".repeat(64),
            label: "payments patch",
          }],
        },
      }),
    );
    expect(envelope.missionArtifacts.status).toBe("consulted");
    if (envelope.missionArtifacts.status !== "consulted") throw new Error("unreachable");
    expect(envelope.missionArtifacts.entries).toEqual([{
      id: "ma-1",
      role: "candidate_patch",
      artifactId: "art-patch",
      artifactSha256: "a".repeat(64),
      label: "payments patch",
    }]);
    const compiled = renderMissionContext(envelope);
    expect(compiled.injection.promptBody).toContain("[candidate_patch] art-patch");
    expect(compiled.injection.promptBody).toContain(`sha256=${"a".repeat(64)}`);
    expect(compiled.injection.promptBody).toContain("payments patch");
    expect(compiled.injection.promptBody).not.toContain("PATCH BODY");
    expect(compiled.refs).toContainEqual({
      kind: "mission_artifact",
      id: "ma-1",
      role: "candidate_patch",
      artifactId: "art-patch",
      sha256: "a".repeat(64),
    });
  });

  it("unbound artifacts report no_mission_bound, not store_not_available", () => {
    const envelope = compileMissionContext(
      baseInput({
        mission: { missionId: null, product: "fettler", objective: "repair a failing test", repositoryId: "repo1", snapshotId: null, graphVersionId: null },
        artifacts: { consulted: false, reason: "no_mission_bound" },
      }),
    );
    expect(envelope.missionArtifacts.status).toBe("not_consulted");
    if (envelope.missionArtifacts.status !== "not_consulted") throw new Error("unreachable");
    expect(envelope.missionArtifacts.reason).toBe("no_mission_bound");
    expect(renderMissionContext(envelope).injection.promptBody).toContain("Mission artifacts [not consulted]");
  });

  it("a foreign-tenant artifact is rejected rather than leaking into the prompt", () => {
    expect(() =>
      compileMissionContext(
        baseInput({
          artifacts: {
            consulted: true,
            records: [{
              tenantId: "t2",
              id: "ma-x",
              role: "candidate_patch",
              artifactId: "art-x",
              artifactSha256: "b".repeat(64),
              label: "foreign",
            }],
          },
        }),
      ),
    ).toThrow("mission_context_tenant_mismatch");
  });

  it("an active memory with no higher layer applies and is named", () => {
    const envelope = compileMissionContext(
      baseInput({
        organizationMemory: { consulted: true, records: [{ subjectKey: "s", record: memory({ status: "ACTIVE", statement: "squash-merge only" }) }] },
      }),
    );
    if (envelope.relevantOrgMemory.status !== "consulted") throw new Error("unreachable");
    expect(envelope.relevantOrgMemory.applied).toHaveLength(1);
    expect(envelope.relevantOrgMemory.applied[0]!.provenance).toBe("confirmed");
    expect(envelope.relevantOrgMemory.applied[0]!.reference.statement).toBe("squash-merge only");
  });
});
