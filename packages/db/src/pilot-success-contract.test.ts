import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, insertPrincipal, type AppDb } from "./index.js";
import {
  approvePilotSuccessContract,
  createPilotSuccessContract,
  getPilotSuccessContract,
  listPilotSuccessContracts,
  revisePilotSuccessContract,
  type PilotSuccessContractDefinition,
} from "./pilot-success-contract.js";

const opened: Array<{ db: AppDb; directory: string }> = [];
const CREATED_AT = "2026-08-02T12:00:00.000Z";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-pilot-contract-"));
  const db = createDb(join(directory, "pilot.sqlite"));
  opened.push({ db, directory });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?),
           ('tenant-b', 'tenant-b', 'Tenant B', 'team', 'active', 10, ?)`)
    .run(CREATED_AT, CREATED_AT);
  for (const principal of [
    ["creator-a", "tenant-a", "human", "creator@example.com"],
    ["reviewer-a", "tenant-a", "human", "reviewer@example.com"],
    ["other-a", "tenant-a", "human", "other@example.com"],
    ["service-a", "tenant-a", "service", "contract-service"],
    ["reviewer-b", "tenant-b", "human", "reviewer@example.com"],
  ] as const) {
    insertPrincipal(db, {
      id: principal[0],
      tenantId: principal[1],
      kind: principal[2],
      subject: principal[3],
      displayName: principal[0],
      createdAt: CREATED_AT,
    });
  }
  return db;
}

afterEach(() => {
  for (const { db, directory } of opened.splice(0)) {
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function definition(overrides: Partial<PilotSuccessContractDefinition> = {}): PilotSuccessContractDefinition {
  return {
    providerChange: {
      provider: "Example Payments",
      changeClass: "breaking",
      description: "Move payment confirmation from v1 to v2.",
    },
    repositories: [
      { owner: "customer", name: "checkout", branch: "main", scope: "payments adapter and tests" },
    ],
    thresholds: [
      { metric: "verified migration pull requests", operator: "gte", target: 1, unit: "pull requests" },
      { metric: "unresolved critical regressions", operator: "eq", target: 0, unit: "regressions" },
    ],
    owners: [
      { responsibility: "customer_owner", principalId: "creator-a" },
      { responsibility: "mendpoint_owner", principalId: "creator-a" },
      { responsibility: "technical_reviewer", principalId: "reviewer-a" },
      { responsibility: "privacy_contact", principalId: "creator-a" },
      { responsibility: "rollback_owner", principalId: "creator-a" },
    ],
    supportResponses: [
      { severity: "critical", responseMinutes: 30, coverage: "Weekdays 09:00 to 17:00 UTC" },
      { severity: "standard", responseMinutes: 240, coverage: "Weekdays 09:00 to 17:00 UTC" },
    ],
    privacy: {
      dataCategories: ["repository source", "verification logs"],
      retentionDays: 30,
      processingRegions: ["us-central"],
      deletionProcedure: "The customer owner requests an operator purge and receives evidence.",
    },
    rollback: {
      trigger: "A critical verification regression or an unauthorized file change.",
      procedure: "Close the draft pull request and restore the recorded repository snapshot.",
      ownerPrincipalId: "creator-a",
      recoveryMinutes: 60,
    },
    weeklyReview: {
      dayOfWeek: "Wednesday",
      timeUtc: "16:00",
      ownerPrincipalId: "creator-a",
      agenda: ["thresholds", "support incidents", "privacy requests", "conversion risks"],
    },
    conversionDecision: {
      decisionDueAt: "2026-09-01T16:00:00.000Z",
      ownerPrincipalId: "creator-a",
      criteria: ["All measurable thresholds pass", "Both owners accept the operating review"],
    },
    ...overrides,
  };
}

describe("pilot success contract", () => {
  it("creates a tenant owned versioned contract and preserves immutable content evidence", () => {
    const db = fixture();
    const first = createPilotSuccessContract(db, {
      id: "pilot-one",
      tenantId: "tenant-a",
      title: "Example Payments pilot",
      definition: definition(),
      createdByPrincipalId: "creator-a",
      createdAt: CREATED_AT,
    });

    expect(first).toMatchObject({ id: "pilot-one", tenantId: "tenant-a", version: 1, status: "draft" });
    expect(first.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.definition.providerChange.changeClass).toBe("breaking");
    expect(first.definition.owners.map((owner) => owner.responsibility)).toEqual([
      "customer_owner", "mendpoint_owner", "privacy_contact", "rollback_owner", "technical_reviewer",
    ]);
    expect(getPilotSuccessContract(db, "tenant-b", "pilot-one")).toBeUndefined();
    expect(listPilotSuccessContracts(db, "tenant-a")).toHaveLength(1);

    expect(() => db.raw.prepare(
      `UPDATE pilot_success_contract_versions SET title = 'changed' WHERE id = ?`,
    ).run(first.versionId)).toThrow(/pilot_success_contract_versions_append_only/);
    expect(() => db.raw.prepare(
      `UPDATE artifact_manifests SET content_text = '{}' WHERE id = ?`,
    ).run(first.artifactId)).toThrow(/artifact_manifests_append_only/);
  });

  it("adds revisions without mutating prior versions and fences stale revisions", () => {
    const db = fixture();
    const first = createPilotSuccessContract(db, {
      id: "pilot-one", tenantId: "tenant-a", title: "Example Payments pilot",
      definition: definition(), createdByPrincipalId: "creator-a", createdAt: CREATED_AT,
    });
    const second = revisePilotSuccessContract(db, {
      tenantId: "tenant-a", contractId: first.id, expectedVersion: 1,
      title: "Example Payments production pilot",
      definition: definition({
        thresholds: [
          { metric: "verified migration pull requests", operator: "gte", target: 2, unit: "pull requests" },
        ],
      }),
      createdByPrincipalId: "creator-a", createdAt: "2026-08-03T12:00:00.000Z",
    });

    expect(second).toMatchObject({ id: "pilot-one", version: 2, status: "draft" });
    expect(second.parentVersionId).toBe(first.versionId);
    expect(getPilotSuccessContract(db, "tenant-a", "pilot-one", 1)?.title).toBe("Example Payments pilot");
    expect(getPilotSuccessContract(db, "tenant-a", "pilot-one")?.version).toBe(2);
    expect(() => revisePilotSuccessContract(db, {
      tenantId: "tenant-a", contractId: first.id, expectedVersion: 1, title: "Stale",
      definition: definition(), createdByPrincipalId: "creator-a",
      createdAt: "2026-08-04T12:00:00.000Z",
    })).toThrow("pilot_contract_version_conflict");
  });

  it("requires a distinct listed human reviewer and stores an immutable approval", () => {
    const db = fixture();
    const contract = createPilotSuccessContract(db, {
      id: "pilot-one", tenantId: "tenant-a", title: "Example Payments pilot",
      definition: definition(), createdByPrincipalId: "creator-a", createdAt: CREATED_AT,
    });
    const approve = (reviewerPrincipalId: string) => approvePilotSuccessContract(db, {
      id: `approval-${reviewerPrincipalId}`,
      tenantId: "tenant-a",
      contractId: contract.id,
      version: 1,
      reviewerPrincipalId,
      rationale: "The scope, controls, and conversion criteria are accepted for this pilot.",
      createdAt: "2026-08-03T14:00:00.000Z",
    });

    expect(() => approve("creator-a")).toThrow("pilot_contract_independent_reviewer_required");
    expect(() => approve("service-a")).toThrow("pilot_contract_human_reviewer_required");
    expect(() => approve("other-a")).toThrow("pilot_contract_reviewer_not_assigned");
    expect(() => approvePilotSuccessContract(db, {
      id: "approval-cross-tenant", tenantId: "tenant-a", contractId: contract.id, version: 1,
      reviewerPrincipalId: "reviewer-b", rationale: "Cross tenant", createdAt: "2026-08-03T14:00:00.000Z",
    })).toThrow("pilot_contract_human_reviewer_required");

    const approved = approve("reviewer-a");
    expect(approved.status).toBe("approved");
    expect(approved.approval).toMatchObject({
      reviewerPrincipalId: "reviewer-a",
      rationale: "The scope, controls, and conversion criteria are accepted for this pilot.",
    });
    expect(approved.approval?.evidenceSha256).toBe(contract.contentSha256);
    expect(() => approve("reviewer-a")).toThrow("pilot_contract_already_approved");
    expect(() => db.raw.prepare(
      `UPDATE review_decisions SET rationale = 'changed' WHERE id = 'approval-reviewer-a'`,
    ).run()).toThrow(/review_decisions_append_only/);
  });

  it("rejects incomplete and non measurable agreements before persistence", () => {
    const db = fixture();
    const input = {
      id: "pilot-one", tenantId: "tenant-a", title: "Example Payments pilot",
      createdByPrincipalId: "creator-a", createdAt: CREATED_AT,
    } as const;
    expect(() => createPilotSuccessContract(db, {
      ...input,
      definition: definition({ thresholds: [] }),
    })).toThrow("pilot_contract_thresholds_required");
    expect(() => createPilotSuccessContract(db, {
      ...input,
      definition: definition({
        owners: definition().owners.filter((owner) => owner.responsibility !== "privacy_contact"),
      }),
    })).toThrow("pilot_contract_owner_privacy_contact_required");
    expect(listPilotSuccessContracts(db, "tenant-a")).toEqual([]);
  });

  it("rolls back contract and approval mutations when the colocated audit hook fails", () => {
    const db = fixture();
    expect(() => createPilotSuccessContract(db, {
      id: "pilot-atomic", tenantId: "tenant-a", title: "Atomic pilot",
      definition: definition(), createdByPrincipalId: "creator-a", createdAt: CREATED_AT,
    }, () => { throw new Error("audit_write_failed"); })).toThrow("audit_write_failed");
    expect(getPilotSuccessContract(db, "tenant-a", "pilot-atomic")).toBeUndefined();

    const contract = createPilotSuccessContract(db, {
      id: "pilot-atomic", tenantId: "tenant-a", title: "Atomic pilot",
      definition: definition(), createdByPrincipalId: "creator-a", createdAt: CREATED_AT,
    });
    expect(() => approvePilotSuccessContract(db, {
      id: "approval-atomic",
      tenantId: "tenant-a",
      contractId: contract.id,
      version: 1,
      reviewerPrincipalId: "reviewer-a",
      rationale: "The atomic approval evidence is complete.",
      createdAt: "2026-08-03T14:00:00.000Z",
    }, () => { throw new Error("audit_write_failed"); })).toThrow("audit_write_failed");
    expect(getPilotSuccessContract(db, "tenant-a", contract.id)?.status).toBe("draft");
  });
});
