import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindMissionToPolicyEnvelope,
  createDb,
  createMission,
  createPolicyEnvelope,
  createWardenCampaign,
  insertPrincipal,
  listMissionPolicyEvaluations,
  linkFettlerCampaignToMission,
  type AppDb,
  type SnapshotIdentity,
} from "@mendpoint/db";
import { ensureDefaultPolicyEnvelopeBinding } from "@mendpoint/pipeline";
import {
  canonicalPolicyEnvelopeJson,
  defaultPolicyEnvelope,
  type PolicyEnvelope,
} from "@mendpoint/policy";
import {
  assertAgentRunMissionPolicy,
  assertBoundAgentRunMissionPolicy,
} from "./agent-run-policy.js";

const at = "2026-08-25T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-agent-run-policy-"));
  const db = createDb(join(dir, "app.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('t1','one','One','team','active',10,?)`,
  ).run(at);
  insertPrincipal(db, {
    id: "p1",
    tenantId: "t1",
    kind: "human",
    subject: "owner@example.com",
    displayName: "Owner",
    createdAt: at,
  });
  createMission(db, {
    id: "m1",
    tenantId: "t1",
    product: "fettler",
    triggerKind: "provider_change",
    objective: "Remediate the payments field rename",
    ownerPrincipalId: "p1",
    eventId: "e-m1",
    idempotencyKey: "c-m1",
    correlationId: "corr",
    createdAt: at,
  });
  // A raised policy exception binds to the agent.run snapshot the caller threads;
  // seed the repo and that snapshot. The Fettler Mission itself has no bound
  // scope, matching the real enrollment path.
  db.raw.prepare(
    `INSERT INTO scm_connections (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
     VALUES ('c1', 't1', 'github', 'me://ref', 'acct', 'Acme', ?, ?)`,
  ).run(at, at);
  db.raw.prepare(
    `INSERT INTO connected_repositories
       (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch, environment, retention_days, status, created_at, updated_at)
     VALUES ('repo-a', 't1', 'c1', '1', 'acme', 'svc', 'main', 'main', 'production', 30, 'ready', ?, ?)`,
  ).run(at, at);
  db.raw.prepare(
    `INSERT INTO repository_snapshots
       (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
        submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
     VALUES ('snapA', 't1', 'repo-a', 'main', ?, ?, 'C:/tmp/snapA', 'reject', 'reject', '[]', 1, ?, '2026-09-01T00:00:00.000Z')`,
  ).run("a".repeat(40), "b".repeat(64), at);
  return db;
}

const snapA: SnapshotIdentity = { snapshotId: "snapA", resolvedSha: "a".repeat(40) };

const allowed = {
  tenantId: "t1",
  missionId: "m1",
  repositoryId: "repo-a",
  branch: "main",
  targetPaths: ["src/pay.ts"],
  useLlm: false,
  risk: "medium",
  observedAgainst: snapA,
  observedAt: at,
} as const;

describe("assertAgentRunMissionPolicy", () => {
  it("allows a bound Mission that inherited the default envelope", () => {
    const db = fixture();
    ensureDefaultPolicyEnvelopeBinding(db, {
      tenantId: "t1",
      missionId: "m1",
      actorPrincipalId: "p1",
      correlationId: "corr",
      createdAt: at,
    });
    expect(() => assertAgentRunMissionPolicy(db, allowed)).not.toThrow();
    const evidence = listMissionPolicyEvaluations(db, "t1", "m1");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.status).toBe("enforced");
    expect(evidence[0]?.allowed).toBe(true);
    expect(evidence[0]?.envelopeVersion).toBe(1);
  });

  it("CONTROL: the live Fettler agent.run caller must leave an evaluation row", () => {
    const db = fixture();
    ensureDefaultPolicyEnvelopeBinding(db, {
      tenantId: "t1",
      missionId: "m1",
      actorPrincipalId: "p1",
      correlationId: "corr",
      createdAt: at,
    });
    assertAgentRunMissionPolicy(db, allowed);
    expect(listMissionPolicyEvaluations(db, "t1", "m1")).toHaveLength(1);
  });

  it("fails closed when the claimed Mission row is missing", () => {
    const db = fixture();
    expect(() => assertAgentRunMissionPolicy(db, { ...allowed, missionId: "missing" }))
      .toThrow("mission_not_found:missing");
  });

  it("fails closed when the Mission has no inherited envelope", () => {
    const db = fixture();
    expect(() => assertAgentRunMissionPolicy(db, allowed))
      .toThrow("mission_policy_envelope_missing");
  });

  it("fails closed when the inherited envelope denies the edit", () => {
    const db = fixture();
    const restricted: PolicyEnvelope = {
      ...defaultPolicyEnvelope({
        tenantId: "t1",
        policyEnvelopeId: "pe-restricted",
        createdAt: at,
      }),
      repositoryScope: ["repo-other"],
      allowedTools: ["read"],
    };
    createPolicyEnvelope(db, {
      tenantId: "t1",
      version: 1,
      policyEnvelopeId: restricted.policyEnvelopeId,
      envelopeJson: canonicalPolicyEnvelopeJson(restricted),
      createdAt: at,
    });
    bindMissionToPolicyEnvelope(db, {
      tenantId: "t1",
      missionId: "m1",
      version: 1,
      actorPrincipalId: "p1",
      eventId: "e-bind",
      idempotencyKey: "bind-1",
      correlationId: "corr",
      createdAt: at,
    });
    expect(() => assertAgentRunMissionPolicy(db, allowed)).toThrow(/mission_policy_denied/);
  });
});

function enrollFettlerCampaign(db: AppDb, campaignId: string, missionId: string): void {
  createWardenCampaign(db, {
    id: campaignId,
    tenantId: "t1",
    name: "Payments",
    ownerPrincipalId: "p1",
    concurrencyLimit: 1,
    completionPolicy: "all",
    eventId: `e-${campaignId}`,
    idempotencyKey: `k-${campaignId}`,
    correlationId: "corr",
    createdAt: at,
  });
  linkFettlerCampaignToMission(db, {
    tenantId: "t1",
    campaignId,
    missionId,
    actorPrincipalId: "p1",
    eventId: `e-link-${campaignId}`,
    idempotencyKey: `k-link-${campaignId}`,
    correlationId: "corr",
    createdAt: at,
  });
}

function agentRunJob(payload: Record<string, unknown>) {
  return {
    id: "job-1",
    tenant_id: "t1",
    type: "agent.run",
    payload_json: JSON.stringify(payload),
  };
}

const boundTask = {
  repositoryId: "repo-a",
  branch: "main",
  targetPaths: ["src/pay.ts"],
  useLlm: false,
  risk: "medium",
  observedAgainst: snapA,
  observedAt: at,
} as const;

describe("assertBoundAgentRunMissionPolicy", () => {
  // Mutation proof for the policy-gate fix: a campaign-bound agent.run (no
  // explicit `missionId`) must reach assertAgentRunMissionPolicy. Reverting the
  // gate to resolve only `payload.missionId` makes this case skip the envelope,
  // so this expectation flips from RED (throws) to a silent pass.
  it("evaluates a campaign-bound agent.run and fails closed when its Mission has no envelope", () => {
    const db = fixture();
    enrollFettlerCampaign(db, "campaign", "m1");
    expect(() => assertBoundAgentRunMissionPolicy(db, agentRunJob({ fettlerCampaignId: "campaign" }), boundTask))
      .toThrow("mission_policy_envelope_missing");
  });

  // Non-vacuous reachability proof for the campaign path: a `.not.toThrow()`
  // allow-case cannot distinguish "gate reached and allowed" from "gate skipped
  // entirely", so this deny-case is what proves the campaign-bound run actually
  // reaches the envelope evaluation. It throws only if the gate is reached; a
  // reachability regression turns it red.
  it("evaluates a campaign-bound agent.run and fails closed when the inherited envelope denies the edit", () => {
    const db = fixture();
    enrollFettlerCampaign(db, "campaign", "m1");
    const restricted: PolicyEnvelope = {
      ...defaultPolicyEnvelope({
        tenantId: "t1",
        policyEnvelopeId: "pe-restricted",
        createdAt: at,
      }),
      repositoryScope: ["repo-other"],
      allowedTools: ["read"],
    };
    createPolicyEnvelope(db, {
      tenantId: "t1",
      version: 1,
      policyEnvelopeId: restricted.policyEnvelopeId,
      envelopeJson: canonicalPolicyEnvelopeJson(restricted),
      createdAt: at,
    });
    bindMissionToPolicyEnvelope(db, {
      tenantId: "t1",
      missionId: "m1",
      version: 1,
      actorPrincipalId: "p1",
      eventId: "e-bind",
      idempotencyKey: "bind-1",
      correlationId: "corr",
      createdAt: at,
    });
    expect(() => assertBoundAgentRunMissionPolicy(db, agentRunJob({ fettlerCampaignId: "campaign" }), boundTask))
      .toThrow(/mission_policy_denied/);
  });

  it("allows a campaign-bound agent.run whose Mission inherited the default envelope", () => {
    const db = fixture();
    enrollFettlerCampaign(db, "campaign", "m1");
    ensureDefaultPolicyEnvelopeBinding(db, {
      tenantId: "t1",
      missionId: "m1",
      actorPrincipalId: "p1",
      correlationId: "corr",
      createdAt: at,
    });
    expect(() => assertBoundAgentRunMissionPolicy(db, agentRunJob({ fettlerCampaignId: "campaign" }), boundTask))
      .not.toThrow();
  });

  it("also evaluates an explicitly mission-claimed agent.run", () => {
    const db = fixture();
    expect(() => assertBoundAgentRunMissionPolicy(db, agentRunJob({ missionId: "m1" }), boundTask))
      .toThrow("mission_policy_envelope_missing");
  });

  it("is a no-op for an unbound agent.run (no claim, no linked campaign)", () => {
    const db = fixture();
    // A campaign that exists but is not linked to any Mission stays unbound.
    createWardenCampaign(db, {
      id: "campaign", tenantId: "t1", name: "Payments", ownerPrincipalId: "p1",
      concurrencyLimit: 1, completionPolicy: "all", eventId: "e-c", idempotencyKey: "k-c",
      correlationId: "corr", createdAt: at,
    });
    expect(() => assertBoundAgentRunMissionPolicy(db, agentRunJob({ fettlerCampaignId: "campaign" }), boundTask))
      .not.toThrow();
    expect(() => assertBoundAgentRunMissionPolicy(db, agentRunJob({ goal: "repair" }), boundTask))
      .not.toThrow();
  });

  it("fails closed when a claimed Mission row is missing", () => {
    const db = fixture();
    expect(() => assertBoundAgentRunMissionPolicy(db, agentRunJob({ missionId: "missing" }), boundTask))
      .toThrow("mission_task_job_mission_not_found");
  });
});
