import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWardenCampaignTarget,
  bindMissionToPolicyEnvelope,
  createDb,
  createMission,
  createPolicyEnvelope,
  createWardenCampaign,
  insertPrincipal,
  insertRepositorySnapshot,
  insertRepositorySnapshotPolicy,
  linkFettlerCampaignToMission,
  listMissionArtifactLineage,
  listMissionArtifacts,
  listWardenCampaignTargets,
  fettlerCampaignMissionTaskId,
  planWardenRollout,
  recordMissionDecision,
  replayWardenRun,
  transitionWardenCampaign,
  type AppDb,
} from "@mendpoint/db";
import { ingestRepositoryEvidence, openGraphLearnMemory, type GraphLearnDb } from "@mendpoint/graph-learn";
import type { UnifiedSourceArtifact } from "@mendpoint/change-intel";
import { canonicalPolicyEnvelopeJson, type PolicyEnvelope } from "@mendpoint/policy";
import {
  compareWardenVerificationRuns,
  createWardenCampaignReviewPackage,
  createWardenSourceEnvelope,
  executeWardenCampaignTarget,
  recoverWardenCampaignTarget,
  validateCheck,
  WardenCampaignExecutionError,
  type WardenCampaignExecutionDependencies,
  type WardenVerificationCheck,
  type WardenVerificationRun,
} from "./warden-campaign-executor.js";

const opened: Array<{ db: AppDb; graph: GraphLearnDb; dir: string }> = [];
const createdAt = "2026-08-02T14:00:00.000Z";
const resolvedSha = "a".repeat(40);
const manifestSha256 = "b".repeat(64);

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixture(options: { bindDefaultEnvelope?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-warden-executor-"));
  const snapshotRoot = join(dir, "snapshot");
  mkdirSync(snapshotRoot);
  writeFileSync(join(snapshotRoot, "check.mjs"), "process.exit(0);\n", "utf8");
  const candidateRoot = join(dir, "candidate");
  mkdirSync(candidateRoot);
  writeFileSync(join(candidateRoot, "check.mjs"), "process.exit(0);\n", "utf8");
  const db = createDb(join(dir, "warden.sqlite"));
  const graph = openGraphLearnMemory();
  opened.push({ db, graph, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?)`).run(createdAt);
  insertPrincipal(db, { id: "owner", tenantId: "tenant-a", kind: "human", subject: "owner@example.com",
    displayName: "Owner", createdAt });
  insertPrincipal(db, { id: "reviewer", tenantId: "tenant-a", kind: "human", subject: "reviewer@example.com",
    displayName: "Reviewer", createdAt });
  insertPrincipal(db, { id: "worker", tenantId: "tenant-a", kind: "service", subject: "warden-worker",
    displayName: "Warden worker", createdAt });
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES ('connection', 'tenant-a', 'local_git', 'vault://connection', 'account', 'Local', ?, ?)`).run(createdAt, createdAt);
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch, environment,
     retention_days, status, created_at, updated_at)
    VALUES ('repo-a', 'tenant-a', 'connection', 'repo-a', 'acme', 'payments', 'main', 'main', 'test',
     30, 'ready', ?, ?)`).run(createdAt, createdAt);
  insertRepositorySnapshot(db, {
    id: "snapshot-a", tenantId: "tenant-a", repositoryId: "repo-a", requestedRef: "main",
    resolvedSha, manifestSha256, storagePath: snapshotRoot, createdAt,
    expiresAt: "2026-08-03T14:00:00.000Z",
  });
  insertRepositorySnapshotPolicy(db, {
    id: "snapshot-policy", tenantId: "tenant-a", snapshotId: "snapshot-a",
    codeowners: { "src/**": ["@payments"] }, ciFiles: [".github/workflows/ci.yml"],
    verificationCommands: ["node check.mjs"], protectedBranch: { name: "main" }, createdAt,
  });
  createWardenCampaign(db, {
    id: "campaign-a", tenantId: "tenant-a", name: "Payments update", ownerPrincipalId: "owner",
    concurrencyLimit: 1, completionPolicy: "all", eventId: "campaign-created", idempotencyKey: "campaign-created",
    correlationId: "campaign-a", createdAt,
  });
  createMission(db, {
    id: "mission-a", tenantId: "tenant-a", product: "fettler", triggerKind: "provider_change",
    objective: "Payments update", ownerPrincipalId: "owner", eventId: "mission-created",
    idempotencyKey: "mission-created", correlationId: "campaign-a", createdAt,
  });
  linkFettlerCampaignToMission(db, {
    tenantId: "tenant-a", campaignId: "campaign-a", missionId: "mission-a",
    actorPrincipalId: "owner", eventId: "mission-linked", idempotencyKey: "mission-linked",
    correlationId: "campaign-a", createdAt,
  });
  if (options.bindDefaultEnvelope !== false) {
    const envelope: PolicyEnvelope = {
      policyEnvelopeId: "pe-default", tenantId: "tenant-a", version: 1,
      repositoryScope: [], branchScope: [], forbiddenZones: [], allowedTools: [], allowedModelClasses: [],
      externalProcessingAllowed: true, residency: "default", riskCeiling: "critical",
      reviewRequired: true, deploymentAllowed: false, trainingDataAllowed: false, retentionDays: null,
      createdAt,
    };
    createPolicyEnvelope(db, {
      tenantId: "tenant-a", version: 1, policyEnvelopeId: envelope.policyEnvelopeId,
      envelopeJson: canonicalPolicyEnvelopeJson(envelope), createdAt,
    });
    bindMissionToPolicyEnvelope(db, {
      tenantId: "tenant-a", missionId: "mission-a", version: 1, actorPrincipalId: "owner",
      eventId: "mission-policy-bound", idempotencyKey: "mission-policy-bound",
      correlationId: "campaign-a", createdAt,
    });
  }
  addWardenCampaignTarget(db, {
    id: "target-a", tenantId: "tenant-a", campaignId: "campaign-a", repositoryId: "repo-a",
    snapshotId: "snapshot-a", ownerPrincipalId: "owner", maxAttempts: 2,
    eventId: "target-created", idempotencyKey: "target-created", correlationId: "campaign-a", createdAt,
  });
  const decision = planWardenRollout(db, {
    id: "rollout-a", tenantId: "tenant-a", campaignId: "campaign-a", expectedCampaignRevision: 1,
    profiles: [{ targetId: "target-a", risk: "medium", environment: "test", verificationConfidence: 0.99,
      canaryEligible: true, ownerGroup: "payments", ownerMaxParallel: 1,
      maintenanceWindow: { start: "2026-08-02T13:00:00.000Z", end: "2026-08-02T16:00:00.000Z" } }],
    canaryTargetId: "target-a", maxCohortSize: 1,
    stopConditions: { pauseFailureRate: 0.1, abortFailureRate: 0.25,
      minimumVerificationConfidence: 0.9, abortOnCriticalFailure: true },
    actorPrincipalId: "owner", eventId: "rollout-created", idempotencyKey: "rollout-created",
    correlationId: "campaign-a", createdAt,
  });
  transitionWardenCampaign(db, {
    tenantId: "tenant-a", campaignId: "campaign-a", expectedRevision: 1, to: "running",
    actorPrincipalId: "owner", eventId: "campaign-running", idempotencyKey: "campaign-running",
    correlationId: "campaign-a", createdAt,
  });
  ingestRepositoryEvidence(graph, {
    tenantId: "tenant-a", repositoryId: "repo-a", snapshotId: "snapshot-a", exactCommit: resolvedSha,
    capturedAt: createdAt,
    evidence: [
      { type: "codeowners", id: "owners-1", observedAt: createdAt,
        codeownersPath: ".github/CODEOWNERS", owners: ["@payments"], matchedPaths: ["src/payments.ts"] },
      { type: "ci", id: "ci-1", observedAt: createdAt, provider: "github_actions",
        workflow: "CI", job: "test", conclusion: "success", runId: "100" },
      { type: "runtime_trace", id: "runtime-1", observedAt: createdAt,
        operation: "POST /charges", status: "ok", durationMs: 17 },
    ],
  });
  return { db, graph, dir, snapshotRoot, candidateRoot, decision };
}

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.raw.close();
    item.graph.raw.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

function source(): UnifiedSourceArtifact {
  const content = JSON.stringify({ provider: "stripe", version: "2026-08" });
  return {
    id: "source-release-1", tenantId: "tenant-a", sourceKind: "release",
    sourceUri: "https://provider.example/releases/2026-08", providerSlug: "provider",
    sourceRevision: "2026-08", contentSha256: digest(content), contentType: "application/json", content,
    observedAt: createdAt, capturedAt: createdAt, capturedBy: "worker:catalog",
    taxonomyVersion: "2026-08-02", taxonomySignals: [{ kind: "field", subject: "charge.amount",
      before: "integer", after: "string", breaking: true, evidenceLocation: "release.body:12" }],
    createdAt,
  };
}

function check(
  command: string,
  status: "passed" | "failed" | "not_verified",
  failures: string[] = [],
): WardenVerificationCheck {
  return {
    command,
    status,
    failureFingerprints: failures,
    outputSha256: digest(`${command}:${status}`),
    durationMs: 4,
    // A passed/failed check must name the observed backend; a refusal names none.
    sandboxBackend: status === "not_verified" ? null : "fly_machines",
  };
}

function dependencies(value: ReturnType<typeof fixture>, verify?: WardenCampaignExecutionDependencies["verify"]): WardenCampaignExecutionDependencies {
  return {
    graphDb: value.graph,
    async planEdits(input) {
      return [{ id: "edit-1", kind: "ast_codemod", targetPath: "src/payments.ts", targetSymbol: "createCharge",
        sourceEvidenceIds: [input.source.sourceArtifactId], precondition: "amount is an integer",
        postcondition: "amount is serialized as a string", rollback: "restore the exact snapshot bytes", confidence: 0.98 }];
    },
    async applyEdits(input) {
      return { baseManifestSha256: input.manifestSha256, candidateRoot: value.candidateRoot,
        candidateContent: "export const amount = String(input.amount);\n", appliedEditIds: input.edits.map((edit) => edit.id) };
    },
    verify: verify ?? (async (input) => [check(input.commands[0]!, "passed")]),
  };
}

function executionInput(value: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  return {
    db: value.db, tenantId: "tenant-a", campaignId: "campaign-a", targetId: "target-a",
    rolloutDecisionId: "rollout-a", source: source(), actorPrincipalId: "worker", runId: "run-a", createdAt,
    rolloutApproval: { decisionSha256: value.decision.decisionSha256, approvedByPrincipalId: "reviewer", approvedAt: createdAt },
    ownerApproval: { ownerPrincipalId: "owner", ownerHandle: "@payments", approvedAt: createdAt },
    dependencies: dependencies(value), ...overrides,
  };
}

describe("Warden campaign executor", () => {
  it("executes one exact snapshot into an immutable review package with typed edits and replay links", async () => {
    const value = fixture();
    const result = await executeWardenCampaignTarget(executionInput(value));
    expect(result).toMatchObject({
      tenantId: "tenant-a", campaignId: "campaign-a", targetId: "target-a", stage: "review",
      attempt: 1, snapshotId: "snapshot-a", resolvedSha,
    });
    expect(result.replay.eventCount).toBe(7);
    expect(result.replay.deterministicReplayEligible).toBe(true);
    expect(result.replay.artifacts.map((artifact) => artifact.kind)).toEqual(expect.arrayContaining([
      "warden-source-envelope", "warden-execution-gates", "warden-baseline-verification",
      "warden-candidate", "warden-post-edit-verification", "warden-campaign-review-package",
    ]));
    expect(listWardenCampaignTargets(value.db, "tenant-a", "campaign-a")[0]).toMatchObject({
      stage: "review", packageArtifactId: result.packageArtifactId, attemptCount: 1,
    });
    const reviewPackage = value.db.raw.prepare(
      "SELECT content_text FROM artifact_manifests WHERE id = ?",
    ).get(result.packageArtifactId) as { content_text: string };
    expect(JSON.parse(reviewPackage.content_text)).toMatchObject({
      delivery: { mode: "draft", autoMerge: false, autoDeploy: false },
      snapshot: { id: "snapshot-a", resolvedSha, manifestSha256 },
      typedEdits: [{ kind: "ast_codemod", targetSymbol: "createCharge" }],
      upstreamChange: { providerSlug: "provider", sourceKind: "release" },
      whyInScope: { repositoryId: "repo-a", ownerHandle: "@payments" },
      graphPath: { query: "repository_evidence" },
      coverageLimits: { gatedOn: ["codeowners", "ci", "runtime_trace"] },
      // graphBasis is derived from the gate rows that matched on the exact commit,
      // not asserted as a literal. Fields fixed by the clean-run precondition
      // (comparisonOk, introducedFailures, notVerified) are no longer emitted.
      uncertainty: { graphBasis: "exact_commit_evidence" },
      risk: { reviewRequired: true, autoMerge: false, autoDeploy: false },
      recipeProvenance: { kinds: ["ast_codemod"] },
      verification: { resolvedFailures: [] },
    });
    const parsed = JSON.parse(reviewPackage.content_text);
    expect(parsed.verification).not.toHaveProperty("comparisonOk");
    expect(parsed.verification).not.toHaveProperty("introducedFailures");
    expect(parsed.uncertainty).not.toHaveProperty("notVerified");
  });

  it("fails closed on a new verification regression and resumes only from verified replay evidence", async () => {
    const value = fixture();
    const failure = digest("introduced failure");
    const deps = dependencies(value, async (input) => input.phase === "baseline"
      ? [check(input.commands[0]!, "passed")]
      : [check(input.commands[0]!, "failed", [failure])]);
    await expect(executeWardenCampaignTarget(executionInput(value, { dependencies: deps })))
      .rejects.toMatchObject({ code: "warden_verification_regression", retryable: true });
    expect(listWardenCampaignTargets(value.db, "tenant-a", "campaign-a")[0]).toMatchObject({
      stage: "failed", attemptCount: 1, exceptionCode: "warden_verification_regression",
    });
    const failedReplay = replayWardenRun(value.db, "tenant-a", "run-a");
    expect(() => recoverWardenCampaignTarget({
      db: value.db, tenantId: "tenant-a", campaignId: "campaign-a", targetId: "target-a",
      failedRunId: "run-a", expectedReplaySha256: digest("wrong"), actorPrincipalId: "worker", createdAt,
    })).toThrow("warden_replay_expected_digest_mismatch");
    const recovered = recoverWardenCampaignTarget({
      db: value.db, tenantId: "tenant-a", campaignId: "campaign-a", targetId: "target-a",
      failedRunId: "run-a", expectedReplaySha256: failedReplay.replaySha256, actorPrincipalId: "worker", createdAt,
    });
    expect(recovered.target).toMatchObject({ stage: "queued", attemptCount: 1, exceptionCode: null });
  });

  it("enforces human rollout approval, owner, CI, runtime, and active cohort gates before editing", async () => {
    const value = fixture();
    await expect(executeWardenCampaignTarget(executionInput(value, {
      rolloutApproval: { decisionSha256: "f".repeat(64), approvedByPrincipalId: "reviewer", approvedAt: createdAt },
    }))).rejects.toMatchObject({ code: "warden_rollout_approval_mismatch" });
    expect(listWardenCampaignTargets(value.db, "tenant-a", "campaign-a")[0]?.attemptCount).toBe(0);

    value.graph.raw.prepare("DELETE FROM gl_edges WHERE source = ? OR target = ?").run(
      "evidence:tenant-a:snapshot-a:ci:ci-1", "evidence:tenant-a:snapshot-a:ci:ci-1",
    );
    value.graph.raw.prepare("DELETE FROM gl_nodes WHERE id = ?").run("evidence:tenant-a:snapshot-a:ci:ci-1");
    await expect(executeWardenCampaignTarget(executionInput(value, { runId: "run-ci-failure" })))
      .rejects.toMatchObject({ code: "warden_ci_gate_failed", retryable: true });
    expect(listWardenCampaignTargets(value.db, "tenant-a", "campaign-a")[0]).toMatchObject({
      stage: "failed", exceptionCode: "warden_ci_gate_failed", attemptCount: 1,
    });
  });

  it("normalizes source provenance and compares baseline failures without hiding existing debt", () => {
    const envelope = createWardenSourceEnvelope(source());
    expect(envelope).toMatchObject({
      schemaVersion: 1, sourceArtifactId: "source-release-1", contentSha256: source().contentSha256,
      signalEvidenceLocations: ["release.body:12"],
    });
    const oldFailure = digest("old failure");
    const fixedFailure = digest("fixed failure");
    const base: WardenVerificationRun = {
      phase: "baseline", snapshotId: "snapshot-a", resolvedSha, manifestSha256,
      commands: ["node check.mjs"], checks: [check("node check.mjs", "failed", [oldFailure, fixedFailure])],
    };
    const post: WardenVerificationRun = {
      ...base, phase: "post_edit", checks: [check("node check.mjs", "failed", [oldFailure])],
    };
    expect(compareWardenVerificationRuns(base, post)).toEqual({
      ok: true, introducedFailures: [], resolvedFailures: [fixedFailure],
      baselineFailed: [oldFailure, fixedFailure].sort(), postEditFailed: [oldFailure],
      notVerified: [],
    });
    expect(() => createWardenSourceEnvelope({ ...source(), contentSha256: "0".repeat(64) }))
      .toThrow("warden_source_hash_mismatch");
  });

  it("treats a not_verified check as inconclusive, never as a clean pass or a regression", () => {
    const base: WardenVerificationRun = {
      phase: "baseline", snapshotId: "snapshot-a", resolvedSha, manifestSha256,
      commands: ["node check.mjs"], checks: [check("node check.mjs", "passed")],
    };
    // Post-edit could not be verified (containment refused). A refusal is not a
    // regression, but it also must NOT read as a clean pass: the comparison is
    // inconclusive and fails closed.
    const post: WardenVerificationRun = {
      ...base, phase: "post_edit", checks: [check("node check.mjs", "not_verified")],
    };
    const comparison = compareWardenVerificationRuns(base, post);
    expect(comparison.notVerified).toEqual(["node check.mjs"]);
    expect(comparison.introducedFailures).toEqual([]);
    expect(comparison.ok).toBe(false);
  });

  it("rejects a check that names no backend for a passed/failed outcome (fail closed)", () => {
    expect(() =>
      validateCheck(
        { command: "node check.mjs", status: "passed", failureFingerprints: [], outputSha256: digest("x"), durationMs: 1, sandboxBackend: null },
        "node check.mjs",
      ),
    ).toThrow("warden_verification_result_invalid");
  });

  it("fails closed when the campaign is not mission-bound", async () => {
    const value = fixture();
    value.db.raw.prepare("UPDATE mission SET fettler_campaign_id = NULL WHERE id = ?").run("mission-a");
    await expect(executeWardenCampaignTarget(executionInput(value)))
      .rejects.toMatchObject({ code: "warden_mission_not_bound", retryable: false });
    expect(listWardenCampaignTargets(value.db, "tenant-a", "campaign-a")[0]?.stage).toBe("queued");
  });

  it("fails closed when the bound Mission has no Policy Envelope", async () => {
    const value = fixture();
    value.db.raw.prepare("UPDATE mission SET policy_envelope_version = NULL WHERE id = ?").run("mission-a");
    await expect(executeWardenCampaignTarget(executionInput(value)))
      .rejects.toMatchObject({ code: "warden_policy_envelope_missing", retryable: false });
  });

  it("fails closed when planned edits violate the inherited envelope", async () => {
    const value = fixture({ bindDefaultEnvelope: false });
    const restricted: PolicyEnvelope = {
      policyEnvelopeId: "pe-restricted", tenantId: "tenant-a", version: 1,
      repositoryScope: [], branchScope: [], forbiddenZones: ["src"], allowedTools: [], allowedModelClasses: [],
      externalProcessingAllowed: true, residency: "default", riskCeiling: "critical",
      reviewRequired: true, deploymentAllowed: false, trainingDataAllowed: false, retentionDays: null,
      createdAt,
    };
    createPolicyEnvelope(value.db, {
      tenantId: "tenant-a", version: 1, policyEnvelopeId: restricted.policyEnvelopeId,
      envelopeJson: canonicalPolicyEnvelopeJson(restricted), createdAt,
    });
    bindMissionToPolicyEnvelope(value.db, {
      tenantId: "tenant-a", missionId: "mission-a", version: 1, actorPrincipalId: "owner",
      eventId: "mission-policy-restricted", idempotencyKey: "mission-policy-restricted",
      correlationId: "campaign-a", createdAt,
    });
    await expect(executeWardenCampaignTarget(executionInput(value)))
      .rejects.toMatchObject({ code: "warden_policy_denied", retryable: false });
    expect(listWardenCampaignTargets(value.db, "tenant-a", "campaign-a")[0]?.stage).not.toBe("review");
  });

  it("fails closed when every planned edit matches an active rejected Mission decision", async () => {
    const value = fixture();
    recordMissionDecision(value.db, {
      tenantId: "tenant-a", missionId: "mission-a",
      decision: "do not modify generated SDK call sites in src/payments.ts",
      scope: "src/payments.ts",
      authorPrincipalId: "owner", correlationId: "campaign-a", createdAt,
    });
    await expect(executeWardenCampaignTarget(executionInput(value)))
      .rejects.toMatchObject({ code: "warden_edits_previously_rejected", retryable: false });
    expect(listWardenCampaignTargets(value.db, "tenant-a", "campaign-a")[0]?.stage).not.toBe("review");
  });

  it("registers persisted candidate, verification, and review-package manifests on a bound Mission", async () => {
    const value = fixture();
    const result = await executeWardenCampaignTarget(executionInput(value));
    const registered = listMissionArtifacts(value.db, "tenant-a", "mission-a");
    expect(registered.map((row) => row.role).sort()).toEqual([
      "candidate_patch", "pull_request", "verification_report",
    ]);
    expect(registered.find((row) => row.role === "candidate_patch")?.artifactId).toBe(result.candidateArtifactId);
    expect(registered.find((row) => row.role === "verification_report")?.artifactId).toBe(result.postEditArtifactId);
    expect(registered.find((row) => row.role === "pull_request")?.artifactId).toBe(result.packageArtifactId);
    expect(registered.every((row) => row.sourceSnapshot === "snapshot-a")).toBe(true);
    expect(registered.every((row) => row.taskId === fettlerCampaignMissionTaskId("mission-a", "repo-a"))).toBe(true);
    expect(registered.every((row) => row.producerPrincipalId === "worker")).toBe(true);
    const lineage = listMissionArtifactLineage(value.db, "tenant-a", "mission-a");
    expect(lineage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        artifactId: result.postEditArtifactId, parentArtifactId: result.candidateArtifactId,
      }),
      expect.objectContaining({
        artifactId: result.packageArtifactId, parentArtifactId: result.candidateArtifactId,
      }),
    ]));
  });

  // CONTROL: the live campaign execute seam must call the best-effort registry
  // helper. Deleting tryRegisterFettlerCampaignMissionArtifacts from
  // executeWardenCampaignTarget makes this die.
  it("CONTROL: executeWardenCampaignTarget calls tryRegisterFettlerCampaignMissionArtifacts", () => {
    const source = readFileSync(join(import.meta.dirname, "warden-campaign-executor.ts"), "utf8");
    expect(source).toContain('from "./mission-artifact-register.js"');
    expect(source).toMatch(/tryRegisterFettlerCampaignMissionArtifacts\(/);
    expect(source).toContain('role: "candidate_patch"');
    expect(source).toContain('role: "verification_report"');
    expect(source).toContain('role: "pull_request"');
  });
});

function reviewPackageInput(
  commands: readonly string[],
  approvedCommands: readonly string[],
): Parameters<typeof createWardenCampaignReviewPackage>[0] {
  return {
    campaignId: "campaign-a", targetId: "target-a", runId: "run-a", attempt: 1,
    source: {
      schemaVersion: 1, sourceArtifactId: "source-1", tenantId: "tenant-a", sourceKind: "release",
      providerSlug: "provider", sourceUri: "https://provider.example/r", sourceRevision: null,
      contentSha256: digest("content"), observedAt: createdAt, capturedAt: createdAt,
      taxonomyVersion: "2026-08-02", signalEvidenceLocations: [],
    },
    sourceEnvelopeArtifactId: "source-artifact",
    snapshot: { id: "snapshot-a", repositoryId: "repo-a", resolvedSha, manifestSha256 },
    ownerHandle: "@payments",
    gates: {
      snapshotId: "snapshot-a", resolvedSha, ownerEvidenceId: "owners-1", ciEvidenceId: "ci-1",
      runtimeEvidenceId: "runtime-1", graphBasis: "exact_commit_evidence",
      gatedOn: ["codeowners", "ci", "runtime_trace"],
    },
    edits: [{ id: "edit-1", kind: "ast_codemod", targetPath: "src/payments.ts", targetSymbol: "createCharge",
      sourceEvidenceIds: ["source-1"], precondition: "p", postcondition: "q", rollback: "r", confidence: 0.9 }],
    commands, approvedCommands,
    comparison: {
      ok: true, introducedFailures: [], resolvedFailures: [], baselineFailed: [], postEditFailed: [], notVerified: [],
    },
    baselineArtifactId: "baseline", candidateArtifactId: "candidate",
    postEditArtifactId: "post-edit", gateArtifactId: "gate",
  };
}

describe("createWardenCampaignReviewPackage coverage notes", () => {
  it("flags a command subset by set, even when duplicates make the counts match", () => {
    // ran = {a}, approved = {a, b}: "b" never ran, but the array lengths both equal
    // 2, so the pre-fix length comparison suppressed the note.
    const pkg = createWardenCampaignReviewPackage(reviewPackageInput(["a", "a"], ["a", "b"]));
    expect(pkg.uncertainty.notes).toContain("verification_command_subset");
  });

  it("omits the subset note when the approved and ran command sets are equal", () => {
    const pkg = createWardenCampaignReviewPackage(reviewPackageInput(["a", "b"], ["b", "a"]));
    expect(pkg.uncertainty.notes).not.toContain("verification_command_subset");
  });
});
