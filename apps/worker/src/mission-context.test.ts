/**
 * End-to-end evidence that the Mission Context Compiler runs on a REAL run
 * against the real durable stores, and that `trajectories.context_refs_json` — a
 * slot with zero writers before this change — is populated with what the run
 * received. Also exercises the mission-bound path (decisions, exceptions,
 * verification) that the cli.ts hook does not reach on the mission-less repair
 * path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindMissionGraphVersion,
  bindMissionToPolicyEnvelope,
  createDb,
  createExplicitMemory,
  createMission,
  createPolicyEnvelope,
  getMission,
  getTrajectory,
  insertArtifactManifest,
  insertPrincipal,
  raiseMissionException,
  recordMissionDecision,
  recordMissionVerification,
  recordTrajectory,
  registerMissionArtifact,
  type AppDb,
} from "@mendpoint/db";
import { ensureDefaultPolicyEnvelopeBinding } from "@mendpoint/pipeline";
import { buildMissionContext, hasInheritedContent } from "./mission-context.js";

const T0 = "2026-01-01T00:00:00.000Z";
const SHA = "1".repeat(40);
const MANIFEST = "a".repeat(64);
const opened: Array<{ db: AppDb; dir: string }> = [];

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

function fixture(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-wctx-"));
  const db = createDb(join(dir, "w.sqlite"));
  opened.push({ db, dir });
  db.raw
    .prepare(
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES ('t1','one','One','team','active',10,?)`,
    )
    .run(T0);
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com", displayName: "One", createdAt: T0 });
  db.raw
    .prepare(
      `INSERT INTO scm_connections (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
       VALUES ('c1','t1','github','me://ref','acct','Acme',?,?)`,
    )
    .run(T0, T0);
  db.raw
    .prepare(
      `INSERT INTO connected_repositories
        (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch, environment, retention_days, status, created_at, updated_at)
       VALUES ('r1','t1','c1','1','acme','svc','main','main','production',30,'ready',?,?)`,
    )
    .run(T0, T0);
  db.raw
    .prepare(
      `INSERT INTO repository_snapshots
        (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
         submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
       VALUES ('snapA','t1','r1','main',?,?, 'C:/tmp/snapA','reject','reject','[]',1,?, '2026-02-01T00:00:00.000Z')`,
    )
    .run(SHA, MANIFEST, T0);
  createMission(db, {
    id: "m1",
    tenantId: "t1",
    product: "fettler",
    triggerKind: "migration_objective",
    objective: "Migrate the payments SDK",
    ownerPrincipalId: "p1",
    repositoryId: "r1",
    snapshotId: "snapA",
    eventId: "ev-m1",
    idempotencyKey: "cm-m1",
    correlationId: "corr",
    createdAt: T0,
  });
  return db;
}

describe("worker mission-context producer (real stores)", () => {
  it("CONTROL 6 (real run): compiles from live stores and populates context_refs_json", () => {
    const db = fixture();
    // An explicit organization memory whose scope collides with a mission
    // decision, so the mission decision must override it in the envelope.
    createExplicitMemory(db, {
      tenantId: "t1",
      category: "MIGRATION_PREFERENCE",
      scope: "pr_atomicity",
      subjectKey: "pr_atomicity",
      statement: "prefer small pull requests",
      actorPrincipalId: "p1",
      reason: "org convention",
      at: T0,
    });
    recordMissionDecision(db, {
      tenantId: "t1",
      missionId: "m1",
      decision: "This migration must be atomic in one PR",
      scope: "pr_atomicity",
      authorPrincipalId: "p1",
      correlationId: "corr",
      createdAt: T0,
    });
    raiseMissionException(db, {
      tenantId: "t1",
      missionId: "m1",
      reason: "payments/legacy.ts cannot be migrated automatically",
      impact: "one file left on v1",
      ownerPrincipalId: "p1",
      resolutionPath: "manual follow-up",
      blocking: true,
      correlationId: "corr",
      createdAt: T0,
    });
    recordMissionVerification(db, {
      tenantId: "t1",
      missionId: "m1",
      verification: "integration suite green",
      scope: "stage-2",
      snapshotId: "snapA",
      resolvedSha: SHA,
      manifestSha256: MANIFEST,
      status: "passed",
      verifierPrincipalId: "p1",
      correlationId: "corr",
      createdAt: T0,
    });

    const mission = getMission(db, "t1", "m1")!;
    const compiled = buildMissionContext(db, {
      tenantId: "t1",
      mission,
      task: { taskId: "task-1", capability: "code_migration", riskClass: "medium", goal: "Do the migration" },
      fallback: { objective: mission.objective, repositoryId: mission.repositoryId, snapshotId: mission.snapshotId },
    });

    expect(hasInheritedContent(compiled.envelope)).toBe(true);
    // Mission-bound sections are live.
    expect(compiled.envelope.activeDecisions.status).toBe("consulted");
    expect(compiled.envelope.unresolvedExceptions.status).toBe("consulted");
    expect(compiled.envelope.verificationState.status).toBe("consulted");
    expect(compiled.envelope.missionArtifacts.status).toBe("consulted");
    if (compiled.envelope.missionArtifacts.status !== "consulted") throw new Error("unreachable");
    expect(compiled.envelope.missionArtifacts.entries).toEqual([]);
    // The passing verification against the current snapshot is current evidence.
    if (compiled.envelope.verificationState.status !== "consulted") throw new Error("unreachable");
    expect(compiled.envelope.verificationState.entries.some((entry) => entry.state === "current_evidence")).toBe(true);
    expect(compiled.envelope.missionIdentity.graphVersionId).toBeNull();
    expect(compiled.envelope.graphProjection).toEqual({
      status: "not_consulted",
      reason: "graph_version_absent",
    });
    // The mission decision overrode the conflicting organization memory.
    if (compiled.envelope.relevantOrgMemory.status !== "consulted") throw new Error("unreachable");
    expect(compiled.envelope.relevantOrgMemory.applied).toHaveLength(0);
    expect(compiled.envelope.relevantOrgMemory.overridden.map((entry) => entry.overriddenBy)).toEqual(["mission_decision"]);

    // Persist a real trajectory carrying the refs, and read it back.
    recordTrajectory(db, {
      id: "traj-real",
      tenantId: "t1",
      product: "fettler",
      taskKind: "code_migration",
      taskSummary: "migration",
      missionId: "m1",
      runId: "run-real",
      jobId: "job-real",
      contextRefs: compiled.refs,
      createdAt: T0,
    });
    const stored = getTrajectory(db, "t1", "traj-real")!;
    expect(stored.contextRefs.length).toBeGreaterThan(0);
    expect(stored.contextRefs.length).toBe(compiled.refs.length);
    const kinds = new Set(
      stored.contextRefs.map((ref) => (typeof ref === "object" && ref !== null ? (ref as { kind?: unknown }).kind : undefined)),
    );
    expect(kinds.has("mission_decision")).toBe(true);
    expect(kinds.has("verification")).toBe(true);
    expect(kinds.has("exception")).toBe(true);
  });

  it("renders the mission's inherited Policy Envelope as consulted hard-policy constraints", () => {
    const db = fixture();
    ensureDefaultPolicyEnvelopeBinding(db, {
      tenantId: "t1", missionId: "m1", actorPrincipalId: "p1", correlationId: "corr", createdAt: T0,
    });
    const mission = getMission(db, "t1", "m1")!;
    const compiled = buildMissionContext(db, {
      tenantId: "t1",
      mission,
      task: { taskId: "task-1", capability: "code_migration", riskClass: "medium", goal: "Do the migration" },
      fallback: { objective: mission.objective, repositoryId: mission.repositoryId, snapshotId: mission.snapshotId },
    });
    expect(compiled.envelope.policyConstraints.status).toBe("consulted");
    if (compiled.envelope.policyConstraints.status !== "consulted") throw new Error("unreachable");
    const subjects = compiled.envelope.policyConstraints.entries.map((e) => e.subjectKey).sort();
    expect(subjects).toEqual(["policy:deployment", "policy:review", "policy:training"]);
    expect(compiled.injection.promptBody).toContain("Human review is required before delivery.");
  });

  it("records a corrupt Policy Envelope as `unreadable` (not empty) with the maximally restrictive fallback", () => {
    const db = fixture();
    // The envelope store keeps the body opaque, so a corrupt/attacker-shaped row
    // can be pinned. Bind the mission to it and compile.
    createPolicyEnvelope(db, {
      tenantId: "t1", version: 1, policyEnvelopeId: "pe-corrupt", envelopeJson: "{not valid json", createdAt: T0,
    });
    bindMissionToPolicyEnvelope(db, {
      tenantId: "t1", missionId: "m1", version: 1, actorPrincipalId: "p1",
      eventId: "m1-policy-envelope-bound", idempotencyKey: "mission-policy-bind-m1-v1",
      correlationId: "corr", createdAt: T0,
    });
    const mission = getMission(db, "t1", "m1")!;
    const compiled = buildMissionContext(db, {
      tenantId: "t1",
      mission,
      task: { taskId: "task-1", capability: "code_migration", riskClass: "medium", goal: "Do the migration" },
      fallback: { objective: mission.objective, repositoryId: mission.repositoryId, snapshotId: mission.snapshotId },
    });
    // Observable third state: neither `consulted` (an empty read reads as
    // unconstrained) nor `not_consulted` (we did look).
    expect(compiled.envelope.policyConstraints.status).toBe("unreadable");
    if (compiled.envelope.policyConstraints.status !== "unreadable") throw new Error("unreachable");
    expect(compiled.envelope.policyConstraints.reason.length).toBeGreaterThan(0);
    // Maximally restrictive fallback — strictly more restrictive than the valid
    // default, which does not forbid external processing.
    const subjects = compiled.envelope.policyConstraints.entries.map((e) => e.subjectKey).sort();
    expect(subjects).toEqual(["policy:deployment", "policy:external_processing", "policy:review", "policy:training"]);
    // The restrictive constraints reach the model and the prompt names why.
    expect(hasInheritedContent(compiled.envelope)).toBe(true);
    expect(compiled.injection.promptBody).toContain("External processing/models are not permitted by policy.");
    expect(compiled.injection.promptBody).toContain("policy envelope unreadable");
  });

  it("with no mission bound, tenant organization memory still applies and mission-scoped sections report no_mission_bound", () => {
    const db = fixture();
    createExplicitMemory(db, {
      tenantId: "t1",
      category: "CODING_CONVENTION",
      scope: "imports",
      subjectKey: "imports",
      statement: "use the internal auth client, never direct OAuth",
      actorPrincipalId: "p1",
      reason: "org convention",
      at: T0,
    });
    const compiled = buildMissionContext(db, {
      tenantId: "t1",
      mission: null,
      task: { taskId: "job-x", capability: "repair", riskClass: "internal", goal: "fix the failing test" },
      fallback: { objective: "fix the failing test", repositoryId: "r1", snapshotId: "snapA" },
    });
    // Tenant memory applies without a mission.
    expect(hasInheritedContent(compiled.envelope)).toBe(true);
    if (compiled.envelope.relevantOrgMemory.status !== "consulted") throw new Error("unreachable");
    expect(compiled.envelope.relevantOrgMemory.applied).toHaveLength(1);
    // Mission-scoped sections are distinctly not_consulted for lack of a mission.
    expect(compiled.envelope.activeDecisions.status).toBe("not_consulted");
    if (compiled.envelope.activeDecisions.status !== "not_consulted") throw new Error("unreachable");
    expect(compiled.envelope.activeDecisions.reason).toBe("no_mission_bound");
    expect(compiled.envelope.missionArtifacts.status).toBe("not_consulted");
    if (compiled.envelope.missionArtifacts.status !== "not_consulted") throw new Error("unreachable");
    expect(compiled.envelope.missionArtifacts.reason).toBe("no_mission_bound");
    expect(compiled.injection.promptBody).toContain("use the internal auth client");
  });

  it("carries a pinned graph version on mission identity without inventing an impact query", () => {
    const db = fixture();
    const beforeMission = getMission(db, "t1", "m1")!;
    const before = buildMissionContext(db, {
      tenantId: "t1",
      mission: beforeMission,
      task: { taskId: "task-1", capability: "code_migration", riskClass: "medium", goal: "Do the migration" },
      fallback: { objective: beforeMission.objective, repositoryId: beforeMission.repositoryId, snapshotId: beforeMission.snapshotId },
    });
    bindMissionGraphVersion(db, {
      tenantId: "t1",
      missionId: "m1",
      graphVersionId: "sgv1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      actorPrincipalId: "p1",
      eventId: "e-graph",
      idempotencyKey: "k-graph",
      correlationId: "corr",
      createdAt: T0,
    });
    const mission = getMission(db, "t1", "m1")!;
    const compiled = buildMissionContext(db, {
      tenantId: "t1",
      mission,
      task: { taskId: "task-1", capability: "code_migration", riskClass: "medium", goal: "Do the migration" },
      fallback: { objective: mission.objective, repositoryId: mission.repositoryId, snapshotId: mission.snapshotId },
    });
    expect(compiled.envelope.missionIdentity.graphVersionId).toBe(
      "sgv1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(compiled.envelope.graphProjection).toEqual({
      status: "not_consulted",
      reason: "endpoint_key_absent",
    });
    expect(compiled.injection.digest).not.toBe(before.injection.digest);
    expect(compiled.injection.promptBody).toContain(
      "graph version sgv1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(compiled.refs).toContainEqual({
      kind: "mission_identity",
      missionId: "m1",
      repositoryId: "r1",
      snapshotId: "snapA",
      graphVersionId: "sgv1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    recordTrajectory(db, {
      id: "traj-graph-pin",
      tenantId: "t1",
      product: "fettler",
      taskKind: "code_migration",
      taskSummary: "graph-pinned migration",
      missionId: "m1",
      runId: "run-graph-pin",
      jobId: "job-graph-pin",
      contextRefs: compiled.refs,
      createdAt: T0,
    });
    const file = (db.raw.prepare("PRAGMA database_list").get() as { file: string }).file;
    db.raw.close();
    const reopened = createDb(file);
    const tracked = opened.find((entry) => entry.db === db);
    if (!tracked) throw new Error("fixture_not_tracked");
    tracked.db = reopened;

    expect(getTrajectory(reopened, "t1", "traj-graph-pin")?.contextRefs).toContainEqual({
      kind: "mission_identity",
      missionId: "m1",
      repositoryId: "r1",
      snapshotId: "snapA",
      graphVersionId: "sgv1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
  });

  it("lists registered mission artifacts by reference after insertArtifactManifest", () => {
    const db = fixture();
    const body = "the candidate patch bytes must never appear in context";
    const sha256 = createHash("sha256").update(body).digest("hex");
    insertArtifactManifest(db, {
      id: "art-patch",
      tenantId: "t1",
      kind: "candidate-edit",
      schemaVersion: 1,
      sha256,
      mediaType: "text/plain",
      sizeBytes: Buffer.byteLength(body, "utf8"),
      storageRef: "mem://art-patch",
      content: body,
      createdAt: T0,
    });
    const registered = registerMissionArtifact(db, {
      tenantId: "t1",
      missionId: "m1",
      role: "candidate_patch",
      artifactId: "art-patch",
      label: "payments patch",
      producerPrincipalId: "p1",
      correlationId: "corr",
      createdAt: T0,
    });
    const mission = getMission(db, "t1", "m1")!;
    const compiled = buildMissionContext(db, {
      tenantId: "t1",
      mission,
      task: { taskId: "task-1", capability: "code_migration", riskClass: "medium", goal: "Do the migration" },
      fallback: { objective: mission.objective, repositoryId: mission.repositoryId, snapshotId: mission.snapshotId },
    });
    expect(compiled.envelope.missionArtifacts.status).toBe("consulted");
    if (compiled.envelope.missionArtifacts.status !== "consulted") throw new Error("unreachable");
    expect(compiled.envelope.missionArtifacts.entries).toEqual([{
      id: registered.id,
      role: "candidate_patch",
      artifactId: "art-patch",
      artifactSha256: sha256,
      label: "payments patch",
      createdAt: T0,
      taskId: null,
    }]);
    expect(compiled.injection.promptBody).toContain("[candidate_patch] art-patch");
    expect(compiled.injection.promptBody).toContain(`sha256=${sha256}`);
    expect(compiled.injection.promptBody).not.toContain("the candidate patch bytes must never appear in context");
    expect(compiled.refs).toContainEqual({
      kind: "mission_artifact",
      id: registered.id,
      role: "candidate_patch",
      artifactId: "art-patch",
      sha256,
    });
  });
});
