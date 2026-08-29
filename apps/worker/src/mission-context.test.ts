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
import {
  openGraphLearnMemory,
  publishSoftwareGraphVersion,
  type SoftwareGraphPublicationV1,
} from "@mendpoint/graph-learn";
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

  // An older candidate's passed row on the same source snapshot must not
  // survive as current_evidence next to a later attempt. Deleting
  // selectCurrentVerificationRecords in the producer turns this RED.
  it("surfaces only the latest candidate-scoped verification as current evidence", () => {
    const db = fixture();
    recordMissionVerification(db, {
      tenantId: "t1",
      missionId: "m1",
      verification: "older candidate green",
      scope: `warden.campaign.execute:c1:t1:candidate:${"a".repeat(64)}`,
      snapshotId: "snapA",
      resolvedSha: SHA,
      manifestSha256: MANIFEST,
      status: "passed",
      verifierPrincipalId: "p1",
      correlationId: "corr",
      createdAt: T0,
    });
    recordMissionVerification(db, {
      tenantId: "t1",
      missionId: "m1",
      verification: "newer candidate still failing preexisting checks",
      scope: `warden.campaign.execute:c1:t1:candidate:${"b".repeat(64)}`,
      snapshotId: "snapA",
      resolvedSha: SHA,
      manifestSha256: MANIFEST,
      status: "inconclusive",
      verifierPrincipalId: "p1",
      correlationId: "corr",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    const mission = getMission(db, "t1", "m1")!;
    const compiled = buildMissionContext(db, {
      tenantId: "t1",
      mission,
      task: { taskId: "task-1", capability: "code_migration", riskClass: "medium", goal: "Do the migration" },
      fallback: { objective: mission.objective, repositoryId: mission.repositoryId, snapshotId: mission.snapshotId },
    });
    if (compiled.envelope.verificationState.status !== "consulted") throw new Error("unreachable");
    expect(compiled.envelope.verificationState.entries).toHaveLength(1);
    expect(compiled.envelope.verificationState.entries[0]).toMatchObject({
      state: "no_current_evidence",
      reason: "current_verification_inconclusive",
    });
    expect(compiled.envelope.verificationState.entries.some((entry) => entry.state === "current_evidence"))
      .toBe(false);
  });

  // When two candidate attempts in one family share the caller-supplied
  // createdAt, the current record cannot be determined. The producer must refuse
  // rather than credit the older candidate's passed row. Restoring the
  // content-digest tie-break in selectCurrentVerificationRecords turns this RED.
  it("refuses to credit a candidate as current when two attempts tie on createdAt", () => {
    const db = fixture();
    recordMissionVerification(db, {
      tenantId: "t1",
      missionId: "m1",
      verification: "candidate A green",
      scope: `warden.campaign.execute:c1:t1:candidate:${"a".repeat(64)}`,
      snapshotId: "snapA",
      resolvedSha: SHA,
      manifestSha256: MANIFEST,
      status: "passed",
      verifierPrincipalId: "p1",
      correlationId: "corr",
      createdAt: T0,
    });
    recordMissionVerification(db, {
      tenantId: "t1",
      missionId: "m1",
      verification: "candidate B still failing preexisting checks",
      scope: `warden.campaign.execute:c1:t1:candidate:${"b".repeat(64)}`,
      snapshotId: "snapA",
      resolvedSha: SHA,
      manifestSha256: MANIFEST,
      status: "inconclusive",
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
    if (compiled.envelope.verificationState.status !== "consulted") throw new Error("unreachable");
    // The family is refused: exactly one entry, and it never reads as current.
    expect(compiled.envelope.verificationState.entries).toHaveLength(1);
    expect(compiled.envelope.verificationState.entries[0]).toMatchObject({
      state: "no_current_evidence",
      reason: "ambiguous_current_candidate",
    });
    expect(compiled.envelope.verificationState.entries.some((entry) => entry.state === "current_evidence"))
      .toBe(false);
  });

  // Production candidate scopes are long: campaignId is `fettler-campaign-<32 hex>`
  // (49 chars) and targetId is `wct_<64 hex>` (68 chars), so the execute scope
  // `warden.campaign.execute:<campaignId>:<targetId>:candidate:<64 hex>` is 217
  // chars. On the absence paths the entry id is derived from the scope; a raw
  // `verification:<scope>` id (230 chars) overflows the compiler's identifier
  // ceiling (200), which THROWS rather than clips. Reverting the sha256-keyed id in
  // mission-context.ts makes both of the following die with
  // `mission_context_verification_id_invalid`, collapsing the whole mission context
  // to `context_not_loaded` on exactly these missions. Fixtures use the REAL id
  // shapes, not the 2-char ids the other tests use.
  const PROD_CAMPAIGN_ID = `fettler-campaign-${"c".repeat(32)}`; // 49 chars, matches warden-campaign-enrollment.ts
  const PROD_TARGET_ID = `wct_${"d".repeat(64)}`; // 68 chars, matches warden-campaign.ts
  const PROD_CANDIDATE_SCOPE =
    `warden.campaign.execute:${PROD_CAMPAIGN_ID}:${PROD_TARGET_ID}:candidate:${"e".repeat(64)}`;

  it("compiles a production-shaped candidate scope on the no_current_evidence path (bounded id)", () => {
    // The raw scope would overflow the identifier ceiling once prefixed.
    expect(`verification:${PROD_CANDIDATE_SCOPE}`.length).toBeGreaterThan(200);
    const db = fixture();
    // Inconclusive against the CURRENT snapshot -> no_current_evidence with the
    // current_verification_inconclusive reason (an absence path, no record id).
    recordMissionVerification(db, {
      tenantId: "t1",
      missionId: "m1",
      verification: "campaign execute post-edit checks were not all passed",
      scope: PROD_CANDIDATE_SCOPE,
      snapshotId: "snapA",
      resolvedSha: SHA,
      manifestSha256: MANIFEST,
      status: "inconclusive",
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
    if (compiled.envelope.verificationState.status !== "consulted") throw new Error("unreachable");
    expect(compiled.envelope.verificationState.entries).toHaveLength(1);
    const entry = compiled.envelope.verificationState.entries[0];
    expect(entry).toMatchObject({ state: "no_current_evidence", reason: "current_verification_inconclusive" });
    // The absence id is a bounded digest, well under the 200-char ceiling.
    expect(entry.id).toMatch(/^verification:[0-9a-f]{64}$/);
    expect(entry.id.length).toBeLessThanOrEqual(200);
  });

  it("compiles a production-shaped candidate scope on the only_stale_evidence path (bounded id)", () => {
    const db = fixture();
    // A second immutable snapshot the mission is NOT currently bound to.
    const SHA_B = "2".repeat(40);
    const MANIFEST_B = "b".repeat(64);
    db.raw
      .prepare(
        `INSERT INTO repository_snapshots
          (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
           submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
         VALUES ('snapB','t1','r1','main',?,?, 'C:/tmp/snapB','reject','reject','[]',1,?, '2026-02-01T00:00:00.000Z')`,
      )
      .run(SHA_B, MANIFEST_B, T0);
    // Non-passing evidence bound to a DIFFERENT snapshot: no current-identity
    // record and no passing record -> no_current_evidence / only_stale_evidence.
    recordMissionVerification(db, {
      tenantId: "t1",
      missionId: "m1",
      verification: "campaign execute checks were not all passed on a superseded snapshot",
      scope: PROD_CANDIDATE_SCOPE,
      snapshotId: "snapB",
      resolvedSha: SHA_B,
      manifestSha256: MANIFEST_B,
      status: "failed",
      verifierPrincipalId: "p1",
      correlationId: "corr",
      createdAt: T0,
    });
    const mission = getMission(db, "t1", "m1")!; // still bound to snapA
    const compiled = buildMissionContext(db, {
      tenantId: "t1",
      mission,
      task: { taskId: "task-1", capability: "code_migration", riskClass: "medium", goal: "Do the migration" },
      fallback: { objective: mission.objective, repositoryId: mission.repositoryId, snapshotId: mission.snapshotId },
    });
    if (compiled.envelope.verificationState.status !== "consulted") throw new Error("unreachable");
    expect(compiled.envelope.verificationState.entries).toHaveLength(1);
    const entry = compiled.envelope.verificationState.entries[0];
    expect(entry).toMatchObject({ state: "no_current_evidence", reason: "only_stale_evidence" });
    expect(entry.id).toMatch(/^verification:[0-9a-f]{64}$/);
    expect(entry.id.length).toBeLessThanOrEqual(200);
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

  it("consults MissionGraphProjection only when a live endpoint key and graph handle are supplied", () => {
    const db = fixture();
    const graph = openGraphLearnMemory();
    const extractor = Object.freeze({
      id: "mendpoint.code-index",
      version: "1.0.0",
      digest: `sha256:${"1".repeat(64)}`,
    });
    const publication: SoftwareGraphPublicationV1 = {
      schemaVersion: "mendpoint.software-graph.v1",
      tenantId: "t1",
      repositoryId: "r1",
      repositorySnapshotId: "snapA",
      repositoryRevision: SHA,
      providerId: "provider-a",
      providerSnapshotId: "provider-snapshot-1",
      providerRevision: "2026-08-17",
      observedAt: T0,
      entities: [{
        extractor,
        derivation: "repository_usage",
        confidenceBasis: "deterministic_exact",
        validFrom: T0,
        id: "endpoint:charges-create",
        kind: "endpoint",
        canonicalKey: "POST /v1/charges",
        aliases: ["charges.create"],
        label: "POST /v1/charges",
        scope: "provider",
        evidenceRefs: ["artifact:openapi:v1"],
        status: "active",
      }],
      relationships: [],
      coverage: [
        { extractor, stage: "repository_discovery", basis: "complete", analyzed: 1, omitted: 0, evidenceRefs: ["manifest:r1:snapA"] },
        { extractor, stage: "language_parsing", basis: "complete", analyzed: 1, omitted: 0, evidenceRefs: ["parser:typescript:v1"] },
        { extractor, stage: "provider_specification", basis: "complete", analyzed: 1, omitted: 0, evidenceRefs: ["artifact:openapi:v1"] },
        { extractor, stage: "sdk_resolution", basis: "complete", analyzed: 1, omitted: 0, evidenceRefs: ["artifact:sdk-map:1"] },
        { extractor, stage: "call_resolution", basis: "complete", analyzed: 1, omitted: 0, evidenceRefs: ["call-graph:r1:snapA"] },
        { extractor, stage: "test_resolution", basis: "complete", analyzed: 0, omitted: 0, evidenceRefs: ["source:test/none.ts:1"] },
      ],
    };
    const published = publishSoftwareGraphVersion(graph, publication);
    bindMissionGraphVersion(db, {
      tenantId: "t1",
      missionId: "m1",
      graphVersionId: published.versionId,
      actorPrincipalId: "p1",
      eventId: "e-graph-live",
      idempotencyKey: "k-graph-live",
      correlationId: "corr",
      createdAt: T0,
    });
    const mission = getMission(db, "t1", "m1")!;
    const withoutHandle = buildMissionContext(db, {
      tenantId: "t1",
      mission,
      task: {
        taskId: "task-1", capability: "code_migration", riskClass: "medium",
        goal: "Do the migration", endpointKey: "POST /v1/charges",
      },
      fallback: { objective: mission.objective, repositoryId: mission.repositoryId, snapshotId: mission.snapshotId },
    });
    expect(withoutHandle.envelope.graphProjection).toEqual({
      status: "not_consulted",
      reason: "store_not_available",
    });
    const compiled = buildMissionContext(db, {
      tenantId: "t1",
      mission,
      task: {
        taskId: "task-1", capability: "code_migration", riskClass: "medium",
        goal: "Do the migration", endpointKey: "POST /v1/charges",
      },
      fallback: { objective: mission.objective, repositoryId: mission.repositoryId, snapshotId: mission.snapshotId },
      graphDb: graph,
    });
    expect(compiled.envelope.graphProjection.status).toBe("consulted");
    if (compiled.envelope.graphProjection.status !== "consulted") throw new Error("unreachable");
    expect(compiled.envelope.graphProjection.projection.graphVersionId).toBe(published.versionId);
    expect(["impact", "no_impact", "unknown_impact"]).toContain(
      compiled.envelope.graphProjection.projection.impact,
    );
    graph.raw.close();
  });
});
