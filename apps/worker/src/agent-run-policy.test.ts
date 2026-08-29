import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindMissionToPolicyEnvelope,
  createDb,
  createMission,
  createPolicyEnvelope,
  insertPrincipal,
  type AppDb,
  type SnapshotIdentity,
} from "@mendpoint/db";
import { ensureDefaultPolicyEnvelopeBinding } from "@mendpoint/pipeline";
import {
  canonicalPolicyEnvelopeJson,
  defaultPolicyEnvelope,
  type PolicyEnvelope,
} from "@mendpoint/policy";
import { assertAgentRunMissionPolicy } from "./agent-run-policy.js";

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
