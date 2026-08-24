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
} from "@mendpoint/db";
import {
  canonicalPolicyEnvelopeJson,
  type PolicyEnvelope,
  type PolicyTaskRequest,
} from "@mendpoint/policy";

const RESIDENCY = "default";
function permissiveEnvelope(overrides: Partial<PolicyEnvelope> = {}): PolicyEnvelope {
  return {
    policyEnvelopeId: "pe-1", tenantId: "t1", version: 1,
    repositoryScope: [], branchScope: [], forbiddenZones: [], allowedTools: [], allowedModelClasses: [],
    externalProcessingAllowed: true, residency: RESIDENCY, riskCeiling: "critical",
    reviewRequired: true, deploymentAllowed: false, trainingDataAllowed: false, retentionDays: null,
    createdAt: at, ...overrides,
  };
}
import {
  evaluateMissionTaskPolicy,
  missionPolicyDenialReasons,
} from "./mission-policy-enforcement.js";

const opened: Array<{ db: AppDb; dir: string }> = [];
const at = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-policy-enforce-"));
  const db = createDb(join(dir, "e.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1','one','One','team','active',10,?)`).run(at);
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com", displayName: "One", createdAt: at });
  createMission(db, { id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
    objective: "Migrate", ownerPrincipalId: "p1", eventId: "e-m1", idempotencyKey: "c-m1", correlationId: "corr", createdAt: at });
  return db;
}

function bind(db: AppDb, envelope: PolicyEnvelope) {
  createPolicyEnvelope(db, { tenantId: "t1", version: envelope.version, policyEnvelopeId: envelope.policyEnvelopeId,
    envelopeJson: canonicalPolicyEnvelopeJson(envelope), createdAt: at });
  bindMissionToPolicyEnvelope(db, { tenantId: "t1", missionId: "m1", version: envelope.version, actorPrincipalId: "p1",
    eventId: "e-bind", idempotencyKey: "bind-1", correlationId: "corr", createdAt: at });
}

const baseTask: PolicyTaskRequest = {
  repositoryId: "repo-a", branch: "main", targetPaths: ["src/pay.ts"], tool: "codemod",
  modelClass: "owned", externalProcessing: false, risk: "medium", isDeployment: false,
  wantsTrainingCapture: false, residency: RESIDENCY,
};

describe("evaluateMissionTaskPolicy", () => {
  it("returns no_envelope when the mission pinned none (does not silently allow)", () => {
    const db = fixture();
    const result = evaluateMissionTaskPolicy(db, { tenantId: "t1", missionId: "m1", task: baseTask });
    expect(result.status).toBe("no_envelope");
    expect(missionPolicyDenialReasons(result)).toBeNull();
  });

  it("enforces an inherited default envelope: an in-bounds task is allowed", () => {
    const db = fixture();
    bind(db, permissiveEnvelope());
    const result = evaluateMissionTaskPolicy(db, { tenantId: "t1", missionId: "m1", task: baseTask });
    expect(result.status).toBe("enforced");
    if (result.status !== "enforced") throw new Error("unreachable");
    expect(result.decision.allowed).toBe(true);
    expect(result.version).toBe(1);
    expect(missionPolicyDenialReasons(result)).toBeNull();
  });

  it("denies a task that violates a restricted envelope, with every reason", () => {
    const db = fixture();
    const restricted = permissiveEnvelope({
      repositoryScope: ["repo-b"],
      forbiddenZones: ["src"],
      allowedTools: ["safe-tool"],
    });
    bind(db, restricted);
    const denied = evaluateMissionTaskPolicy(db, { tenantId: "t1", missionId: "m1", task: baseTask });
    expect(denied.status).toBe("enforced");
    if (denied.status !== "enforced") throw new Error("unreachable");
    expect(denied.decision.allowed).toBe(false);
    const reasons = missionPolicyDenialReasons(denied);
    expect(reasons).not.toBeNull();
    const codes = (reasons ?? []).map((r) => r.split(":")[0]).sort();
    expect(codes).toContain("repository_out_of_scope");
    expect(codes).toContain("forbidden_zone_edit");
    expect(codes).toContain("tool_not_allowed");
  });

  it("fails closed on a malformed pinned envelope (envelope_invalid, denial required)", () => {
    const db = fixture();
    createPolicyEnvelope(db, { tenantId: "t1", version: 1, policyEnvelopeId: "pe-bad",
      envelopeJson: '{"not":"a valid envelope"}', createdAt: at });
    bindMissionToPolicyEnvelope(db, { tenantId: "t1", missionId: "m1", version: 1, actorPrincipalId: "p1",
      eventId: "e-bind", idempotencyKey: "bind-1", correlationId: "corr", createdAt: at });
    const result = evaluateMissionTaskPolicy(db, { tenantId: "t1", missionId: "m1", task: baseTask });
    expect(result.status).toBe("envelope_invalid");
    expect(missionPolicyDenialReasons(result)).toEqual(["policy_envelope_invalid"]);
  });
});
