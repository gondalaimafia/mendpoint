import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getFettlerDelegationEvidence,
  recordAudit,
  type AppDb,
} from "./index.js";

const opened: Array<{ db: AppDb; directory: string }> = [];
const TENANT = "tenant-a";
const RUN = "run-a";
const JOB = "job-a";
const REVISION = "a".repeat(40);
const HEAD = "b".repeat(40);
const DIGEST = `sha256:${"c".repeat(64)}`;
const SEAL = `sha256:${"d".repeat(64)}`;
const CANDIDATE = "c".repeat(64);
const CANDIDATE_MANIFEST = "f".repeat(64);
const SOURCE_MANIFEST = "e".repeat(64);
const T0 = "2026-08-18T12:00:00.000Z";
const REVIEWED_AT = "2026-08-18T12:02:00.000Z";
const MEMBERSHIP_ISSUER = "https://identity.example.com";
const MEMBERSHIP_SUBJECT = "reviewer-a";
const MEMBERSHIP_EVIDENCE_ID = `membership:${createHash("sha256")
  .update(`${TENANT}\n${MEMBERSHIP_ISSUER}\n${MEMBERSHIP_SUBJECT}`, "utf8")
  .digest("hex")}`;

function fixture(): AppDb {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-delegation-evidence-"));
  const db = createDb(join(directory, "evidence.sqlite"));
  opened.push({ db, directory });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES (?, 'tenant-a', 'Tenant A', 'team', 'active', 10, ?)`)
    .run(TENANT, T0);
  return db;
}

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function seedCompleteDelegation(
  db: AppDb,
  approvalMetadata: Record<string, unknown> = {},
): void {
  db.raw.prepare(`INSERT INTO principals
    (id, tenant_id, kind, subject, display_name, audience, created_at)
    VALUES ('human-a', ?, 'human', ?, 'Reviewer', ?, ?)`)
    .run(TENANT, `${MEMBERSHIP_ISSUER}|${MEMBERSHIP_SUBJECT}`, MEMBERSHIP_ISSUER, T0);
  db.raw.prepare(`INSERT INTO tenant_memberships
    (tenant_id, issuer, subject, email, display_name, role, status, created_at, updated_at)
    VALUES (?, ?, ?, 'reviewer@example.com', 'Reviewer', 'owner', 'active', ?, ?)`)
    .run(TENANT, MEMBERSHIP_ISSUER, MEMBERSHIP_SUBJECT, T0, T0);
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name,
     created_at, updated_at)
    VALUES ('connection-a', ?, 'github', 'secret://github/app', 'account-a', 'GitHub', ?, ?)`)
    .run(TENANT, T0, T0);
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch,
     selected_branch, environment, retention_days, status, created_at, updated_at)
    VALUES ('repo-a', ?, 'connection-a', '99', 'acme', 'repo', 'main', 'main',
      'production', 30, 'ready', ?, ?)`)
    .run(TENANT, T0, T0);
  db.raw.prepare(`INSERT INTO repository_snapshots
    (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256,
     storage_path, submodules_policy, lfs_policy, sparse_paths_json,
     file_manifest_version, created_at, expires_at)
    VALUES ('snapshot-a', ?, 'repo-a', 'main', ?, ?, '/snapshots/a', 'reject',
      'pointer_only', '[]', 1, ?, '2026-08-19T12:00:00.000Z')`)
    .run(TENANT, REVISION, SOURCE_MANIFEST, T0);

  db.raw.prepare(`INSERT INTO jobs
    (id, tenant_id, type, payload_json, status, attempts, max_attempts, result_json,
     created_at, started_at, finished_at, available_at, lease_generation)
    VALUES (?, ?, 'agent.run', '{}', 'done', 1, 3, '{}', ?, ?, ?, ?, 1)`)
    .run(JOB, TENANT, T0, T0, "2026-08-18T12:01:00.000Z", T0);

  const result = {
    jobId: JOB,
    product: "warden",
    attemptStatus: "succeeded",
    source: {
      repositoryId: "repo-a",
      snapshotId: "snapshot-a",
      revision: REVISION,
      manifestSha256: SOURCE_MANIFEST,
    },
    review: {
      decision: "approve",
      reviewerPrincipalId: "human-a",
      trustPrincipalId: "human-a",
      authMethod: "oidc",
      membershipEvidenceId: MEMBERSHIP_EVIDENCE_ID,
      rationale: "The bounded migration is ready.",
      reviewedAt: REVIEWED_AT,
    },
    artifacts: {
      candidateDigest: CANDIDATE,
      candidateManifestSha256: CANDIDATE_MANIFEST,
      approval: { path: "approvals/seal.json", sha256: SEAL },
    },
    cleanup: { status: "cleaned", cleanedAt: "2026-08-18T12:10:00.000Z" },
  };
  db.raw.prepare(`INSERT INTO agent_runs
    (id, tenant_id, job_id, goal, repo_path, status, ok, steps, files_changed_json,
     result_json, created_at, finished_at)
    VALUES (?, ?, ?, 'Migrate provider API', '/snapshot', 'candidate_approved', 1, 2,
      '["src/client.ts"]', ?, ?, ?)`)
    .run(RUN, TENANT, JOB, JSON.stringify(result), T0, "2026-08-18T12:02:00.000Z");

  db.raw.prepare(`INSERT INTO trajectories
    (id, tenant_id, product, task_kind, task_summary, run_id, job_id, context_refs_json,
     available_tools_json, sandbox_backend, final_outcome, accepted, cost_usd,
     cost_measured, latency_ms, provenance_json, created_at)
    VALUES ('trajectory-a', ?, 'fettler', 'provider_migration', 'Migrate provider API', ?, ?,
      '[]', '["read_file"]', 'fly_machines', 'verified', 'accepted', 0.12, 1, 60000,
      '{}', ?)`)
    .run(TENANT, RUN, JOB, T0);
  db.raw.prepare(`INSERT INTO trajectory_steps
    (id, trajectory_id, tenant_id, step_index, step_kind, planner_source, model_id,
     reservation_ref, ok, cost_usd, latency_ms, created_at)
    VALUES ('step-a', 'trajectory-a', ?, 0, 'model_call', 'model', 'muse-1.2',
      'reservation-a', 1, 0.12, 500, ?),
      ('step-b', 'trajectory-a', ?, 1, 'verification', 'deterministic', NULL,
      NULL, 1, NULL, 200, ?)`)
    .run(TENANT, T0, TENANT, T0);

  db.raw.prepare(`INSERT INTO fettler_model_reservations
    (id, tenant_id, job_id, run_id, worker_id, lease_generation, call_index,
     request_digest, reservation_digest, settlement_digest, provider, configured_model,
     actual_model, endpoint_host, body_request_id, header_request_id, status,
     maximum_input_tokens, maximum_output_tokens, maximum_total_tokens,
     maximum_cost_usd, job_budget_usd, reported_input_tokens, reported_output_tokens,
     reported_total_tokens, reported_cost_usd, charged_input_tokens,
     charged_output_tokens, charged_total_tokens, charged_cost_usd, reserved_at, settled_at)
    VALUES ('reservation-a', ?, ?, ?, 'worker-a', 1, 1, ?, ?, ?, 'openai', 'muse-1.2',
      'muse-1.2-20260818', 'api.openai.com', 'request-a', 'request-a', 'succeeded',
      1000, 500, 1500, 1.0, 2.0, 100, 50, 150, 0.12, 100, 50, 150, 0.12, ?, ?)`)
    .run(TENANT, JOB, RUN, DIGEST, DIGEST, DIGEST, T0, "2026-08-18T12:00:30.000Z");

  db.raw.prepare(`INSERT INTO routing_ledger
    (id, tenant_id, job_id, run_id, task_kind, envelope_id, policy_snapshot_id,
     task_snapshot_id, action, selected_executor_id, provider_id, outcome,
     input_tokens, output_tokens, total_tokens, cost_usd, decision_json, created_at, updated_at)
    VALUES ('route-a', ?, ?, ?, 'provider_migration', 'envelope-a', 'policy-a',
      'task-a', 'execute', 'executor-a', 'openai', 'succeeded', 100, 50, 150, 0.12,
      '{}', ?, ?)`)
    .run(TENANT, JOB, RUN, T0, T0);
  db.raw.prepare(`INSERT INTO agent_run_meters
    (tenant_id, run_id, outcome, created_at, candidate_ready_at, duration_ms,
     input_tokens, output_tokens, total_tokens, cost_usd, cost_measured, metered_at)
    VALUES (?, ?, 'candidate_approved', ?, ?, 120000, 100, 50, 150, 0.12, 1, ?)`)
    .run(TENANT, RUN, T0, "2026-08-18T12:02:00.000Z", "2026-08-18T12:02:01.000Z");

  db.raw.prepare(`INSERT INTO jobs
    (id, tenant_id, type, payload_json, status, attempts, max_attempts, result_json,
     created_at, started_at, finished_at, available_at, lease_generation)
    VALUES ('delivery-job-a', ?, 'warden.candidate.deliver', '{}', 'done', 1, 5, '{}',
      ?, ?, ?, ?, 1)`)
    .run(TENANT, T0, T0, "2026-08-18T12:04:00.000Z", T0);
  db.raw.prepare(`INSERT INTO fettler_candidate_deliveries
    (id, tenant_id, run_id, job_id, status, repository_id, snapshot_id, base_branch,
     expected_base_revision, sealed_path, sealed_sha256, requester_principal_id,
     rationale, intent_digest, branch_name, base_revision, commit_sha, draft_pr,
     draft_pr_number, draft_pr_url, requested_at, intent_bound_at, delivered_at,
     outcome, outcome_at, outcome_source, updated_at)
    VALUES ('delivery-a', ?, ?, 'delivery-job-a', 'delivered', 'repo-a', 'snapshot-a',
      'main', ?, 'approvals/seal.json', ?, 'human-a', 'The bounded migration is ready.',
      ?, 'mendpoint/run-a', ?, ?, 1, 41, 'https://github.com/acme/repo/pull/41', ?, ?, ?,
      'closed_unmerged', ?, 'github_webhook', ?)`)
    .run(TENANT, RUN, REVISION, SEAL, DIGEST, REVISION, HEAD, T0, T0,
      "2026-08-18T12:04:00.000Z", "2026-08-18T12:09:00.000Z",
      "2026-08-18T12:09:00.000Z");

  recordAudit(db, {
    id: "audit-approval",
    tenantId: TENANT,
    actor: "operator",
    principalId: "human-a",
    requestId: "oidc-request-a",
    action: "agent.candidate.approved",
    resourceType: "agent_run",
    resourceId: RUN,
    metadata: {
      decision: "approve",
      reviewerPrincipalId: "human-a",
      trustPrincipalId: "human-a",
      authMethod: "oidc",
      membershipEvidenceId: MEMBERSHIP_EVIDENCE_ID,
      reviewedAt: REVIEWED_AT,
      candidateDigest: CANDIDATE,
      candidateManifestSha256: CANDIDATE_MANIFEST,
      delivery: {
        id: "delivery-a",
        runId: RUN,
        repositoryId: "repo-a",
        snapshotId: "snapshot-a",
        expectedBaseRevision: REVISION,
        sealedPath: "approvals/seal.json",
        sealedSha256: SEAL,
      },
      ...approvalMetadata,
    },
  });
  recordAudit(db, {
    id: "audit-delivery",
    tenantId: TENANT,
    actor: "agent",
    requestId: "delivery-job-a",
    action: "agent.candidate.draft_delivered",
    resourceType: "agent_run",
    resourceId: RUN,
    metadata: {
      deliveryId: "delivery-a",
      repositoryId: "repo-a",
      snapshotId: "snapshot-a",
      baseBranch: "main",
      expectedBaseRevision: REVISION,
      approvalSeal: SEAL,
      requesterPrincipalId: "human-a",
      branchName: "mendpoint/run-a",
      commitSha: HEAD,
      draftPr: true,
      draftPrNumber: 41,
      draftPrUrl: "https://github.com/acme/repo/pull/41",
    },
  });

  db.raw.prepare(`INSERT INTO fettler_ci_cycles
    (id, tenant_id, delivery_id, observation_job_id, status, repository_id,
     remote_repository_id, installation_id, pull_request_number, base_branch,
     branch_name, base_revision, current_head_sha, required_checks_json,
     allowed_changed_paths_json, max_cycles, used_cycles, max_model_calls,
     maximum_cost_usd, current_observation_digest, created_at, updated_at)
    VALUES ('cycle-a', ?, 'delivery-a', 'ci-job-a', 'succeeded', 'repo-a', 99, 88, 41,
      'main', 'mendpoint/run-a', ?, ?, '["check:1:test"]', '["src/client.ts"]',
      3, 1, 3, 2.0, ?, ?, ?)`)
    .run(TENANT, REVISION, HEAD, DIGEST, T0, T0);
  db.raw.prepare(`INSERT INTO fettler_ci_observations
    (id, tenant_id, cycle_id, head_sha, verdict, observation_digest,
     evidence_artifact_id, evidence_digest, observed_at)
    VALUES ('observation-a', ?, 'cycle-a', ?, 'success', ?, 'artifact-a', ?, ?)`)
    .run(TENANT, HEAD, DIGEST, DIGEST, "2026-08-18T12:08:00.000Z");
}

describe("Fettler delegation durable evidence inventory", () => {
  it("returns every exact tenant and run bound record without inferring SCM cleanup", () => {
    const db = fixture();
    seedCompleteDelegation(db);

    const evidence = getFettlerDelegationEvidence(db, TENANT, RUN);

    expect(evidence.agentRun.status).toBe("observed");
    expect(evidence.job.status === "observed" && evidence.job.value.id).toBe(JOB);
    expect(evidence.trajectory.status === "observed" &&
      evidence.trajectory.value.steps.map((step) => step.id)).toEqual(["step-a", "step-b"]);
    expect(evidence.modelReservations.status === "observed" &&
      evidence.modelReservations.value.map((row) => row.id)).toEqual(["reservation-a"]);
    expect(evidence.routingLedger.status === "observed" &&
      evidence.routingLedger.value.map((row) => row.id)).toEqual(["route-a"]);
    expect(evidence.runMeter.status === "observed" && evidence.runMeter.value.costMeasured).toBe(true);
    expect(evidence.approval.status === "observed" && evidence.approval.value).toMatchObject({
      reviewerPrincipalId: "human-a",
      trustPrincipalId: "human-a",
      authMethod: "oidc",
      membershipEvidenceId: MEMBERSHIP_EVIDENCE_ID,
      reviewedAt: REVIEWED_AT,
      seal: { sha256: SEAL },
      candidate: { digest: CANDIDATE, candidateManifestSha256: CANDIDATE_MANIFEST },
    });
    expect(evidence.candidateDelivery.status === "observed" &&
      evidence.candidateDelivery.value.auditEvents.map((row) => row.id)).toEqual(["audit-delivery"]);
    expect(evidence.ci.status === "observed" && evidence.ci.value[0]?.observations[0]?.verdict).toBe("success");
    expect(evidence.terminalOutcome).toEqual({ status: "observed", value: {
      source: "candidate_delivery", outcome: "closed_unmerged",
      observedAt: "2026-08-18T12:09:00.000Z",
    } });
    expect(evidence.cleanup).toEqual({
      status: "not_observed",
      reason: "scm_cleanup_not_durably_recorded",
    });
    expect(evidence.auditIntegrity.ok).toBe(true);
  });

  it("returns literal not_observed values for a missing run and never crosses tenants", () => {
    const db = fixture();
    seedCompleteDelegation(db);
    db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
      VALUES ('tenant-b', 'tenant-b', 'Tenant B', 'team', 'active', 10, ?)`)
      .run(T0);

    const missing = getFettlerDelegationEvidence(db, "tenant-b", RUN);
    expect(missing.agentRun).toEqual({ status: "not_observed", reason: "agent_run_not_found" });
    expect(missing.job.status).toBe("not_observed");
    expect(missing.modelReservations.status).toBe("not_observed");
    expect(missing.candidateDelivery.status).toBe("not_observed");
  });

  it("withholds approval and delivery audit evidence when an exact binding is absent", () => {
    const db = fixture();
    seedCompleteDelegation(db);
    db.raw.prepare(`UPDATE agent_runs SET result_json = json_set(result_json,
      '$.artifacts.approval.sha256', ?) WHERE id = ? AND tenant_id = ?`)
      .run(`sha256:${"f".repeat(64)}`, RUN, TENANT);

    const evidence = getFettlerDelegationEvidence(db, TENANT, RUN);
    expect(evidence.approval).toEqual({
      status: "not_observed",
      reason: "approval_candidate_binding_unproven",
    });
    expect(evidence.candidateDelivery.status).toBe("observed");
  });

  it.each([
    ["review timestamp", { reviewedAt: "2026-08-18T12:03:00.000Z" }],
    ["trust principal", { trustPrincipalId: "human-other" }],
    ["authentication method", { authMethod: "api_key" }],
    ["membership evidence", { membershipEvidenceId: "membership:other" }],
    ["candidate digest", { candidateDigest: "0".repeat(64) }],
    ["candidate manifest", { candidateManifestSha256: "1".repeat(64) }],
  ])("withholds approval when audit metadata has a mismatched %s", (_label, override) => {
    const db = fixture();
    seedCompleteDelegation(db, override);

    expect(getFettlerDelegationEvidence(db, TENANT, RUN).approval.status).toBe("not_observed");
  });

  it("requires exactly one matching approval event", () => {
    const db = fixture();
    seedCompleteDelegation(db);
    const first = db.raw.prepare("SELECT * FROM audit_events WHERE id = 'audit-approval'").get() as {
      metadata_json: string;
    };
    recordAudit(db, {
      id: "audit-approval-duplicate",
      tenantId: TENANT,
      actor: "operator",
      principalId: "human-a",
      requestId: "oidc-request-b",
      action: "agent.candidate.approved",
      resourceType: "agent_run",
      resourceId: RUN,
      metadata: JSON.parse(first.metadata_json),
    });

    expect(getFettlerDelegationEvidence(db, TENANT, RUN).approval).toEqual({
      status: "not_observed",
      reason: "approval_candidate_binding_unproven",
    });
  });

  it("requires the referenced active tenant membership", () => {
    const db = fixture();
    seedCompleteDelegation(db);
    db.raw.prepare("DELETE FROM tenant_memberships WHERE tenant_id = ?").run(TENANT);

    expect(getFettlerDelegationEvidence(db, TENANT, RUN).approval).toEqual({
      status: "not_observed",
      reason: "approval_principal_unproven",
    });
  });

  it("withholds all audit-derived records when the tenant audit chain is corrupt", () => {
    const db = fixture();
    seedCompleteDelegation(db);
    db.raw.exec("DROP TRIGGER audit_events_append_only_update");
    db.raw.prepare("UPDATE audit_events SET metadata_json = '{}' WHERE id = 'audit-approval'").run();

    const evidence = getFettlerDelegationEvidence(db, TENANT, RUN);
    expect(evidence.auditIntegrity.ok).toBe(false);
    expect(evidence.approval).toEqual({ status: "not_observed", reason: "audit_chain_invalid" });
    // A torn audit chain leaves the delivery unproven, so the discriminant itself
    // must say so -- matching the sibling approval record -- rather than reporting
    // observed with the truth demoted to a nested auditReason field.
    expect(evidence.candidateDelivery).toEqual({ status: "not_observed", reason: "audit_chain_invalid" });
  });

  it("is read only and fails closed on conflicting run and job bindings", () => {
    const db = fixture();
    seedCompleteDelegation(db);
    db.raw.prepare(`INSERT INTO jobs
      (id, tenant_id, type, payload_json, status, attempts, max_attempts, created_at,
       available_at, lease_generation)
      VALUES ('job-conflict', ?, 'agent.run', '{}', 'done', 1, 3, ?, ?, 1)`)
      .run(TENANT, T0, T0);
    db.raw.prepare(`INSERT INTO fettler_model_reservations
      (id, tenant_id, job_id, run_id, worker_id, lease_generation, call_index,
       request_digest, reservation_digest, provider, configured_model, endpoint_host,
       status, maximum_input_tokens, maximum_output_tokens, maximum_total_tokens,
       maximum_cost_usd, job_budget_usd, reserved_at)
      VALUES ('reservation-conflict', ?, 'job-conflict', ?, 'worker-a', 1, 1,
       ?, ?, 'openai', 'muse-1.2', 'api.openai.com', 'active', 1, 1, 2, 0.1, 1.0, ?)`)
      .run(TENANT, RUN, DIGEST, DIGEST, T0);
    const before = db.raw.prepare("SELECT total_changes() AS count").get() as { count: number };

    const evidence = getFettlerDelegationEvidence(db, TENANT, RUN);

    const after = db.raw.prepare("SELECT total_changes() AS count").get() as { count: number };
    expect(after.count).toBe(before.count);
    expect(evidence.modelReservations).toEqual({
      status: "not_observed",
      reason: "model_reservation_binding_conflict",
    });
  });

  it("does not treat a trajectory linked to a different job as exact run evidence", () => {
    const db = fixture();
    seedCompleteDelegation(db);
    db.raw.prepare("UPDATE trajectories SET job_id = 'other-job' WHERE id = 'trajectory-a'").run();

    const evidence = getFettlerDelegationEvidence(db, TENANT, RUN);

    expect(evidence.trajectory).toEqual({
      status: "not_observed",
      reason: "trajectory_binding_conflict",
    });
  });

});
