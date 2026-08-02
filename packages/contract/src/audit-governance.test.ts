import { describe, expect, it } from "vitest";
import {
  createGovernedAuditExport,
  evaluateAuditRetention,
  verifyGovernedAuditExport,
  type GovernedAuditRecord,
} from "./audit-governance.js";

const record: GovernedAuditRecord = {
  id: "audit-1",
  tenantId: "tenant-a",
  actorId: "user@example.com",
  action: "candidate.verified",
  resourceType: "candidate",
  resourceId: "candidate-a",
  retentionClass: "security",
  occurredAt: "2025-01-01T00:00:00.000Z",
  metadata: {
    verdict: "passed",
    nested: { token: "must-not-export", content: "customer source" },
  },
  sourceEventHash: "a".repeat(64),
};

describe("audit governance", () => {
  it("applies retention classes and lets an active legal hold override expiry", () => {
    expect(evaluateAuditRetention(record, [], new Date("2027-01-01T00:00:00.000Z"))).toMatchObject({
      disposition: "eligible_for_deletion",
      reason: "retention_elapsed",
    });
    expect(
      evaluateAuditRetention(
        record,
        [
          {
            id: "hold-1",
            tenantId: "tenant-a",
            status: "active",
            reason: "customer dispute",
            resourceType: "candidate",
            resourceId: "candidate-a",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        new Date("2027-01-01T00:00:00.000Z"),
      ),
    ).toMatchObject({ disposition: "retain", reason: "legal_hold", legalHoldIds: ["hold-1"] });
  });

  it("creates tenant-owned redacted exports with replay-verifiable hashes", () => {
    const bundle = createGovernedAuditExport({
      exportId: "export-1",
      tenantId: "tenant-a",
      requestedByActorId: "security-owner",
      destination: { uri: "customer://tenant-a/security/audit", ownerTenantId: "tenant-a" },
      redactionProfile: "security",
      createdAt: "2026-08-02T00:00:00.000Z",
      records: [record, { ...record, id: "audit-2", occurredAt: "2025-01-02T00:00:00.000Z" }],
    });
    expect(JSON.stringify(bundle)).not.toContain("must-not-export");
    expect(JSON.stringify(bundle)).not.toContain("customer source");
    expect(bundle.records[1]?.previousExportHash).toBe(bundle.records[0]?.exportHash);
    expect(verifyGovernedAuditExport(bundle)).toEqual({ ok: true, checked: 2 });
  });

  it("pseudonymizes actors for minimal exports", () => {
    const bundle = createGovernedAuditExport({
      exportId: "export-minimal",
      tenantId: "tenant-a",
      requestedByActorId: "security-owner",
      destination: { uri: "s3://tenant-a-audit/export", ownerTenantId: "tenant-a" },
      redactionProfile: "minimal",
      createdAt: "2026-08-02T00:00:00.000Z",
      records: [record],
    });
    expect(bundle.records[0]?.actorId).toMatch(/^actor_sha256:[a-f0-9]{64}$/);
    expect(bundle.records[0]?.metadata).toEqual({});
  });

  it("rejects cross-tenant or public web export destinations", () => {
    expect(() =>
      createGovernedAuditExport({
        exportId: "export-1",
        tenantId: "tenant-a",
        requestedByActorId: "security-owner",
        destination: { uri: "customer://tenant-b/audit", ownerTenantId: "tenant-b" },
        redactionProfile: "support",
        createdAt: "2026-08-02T00:00:00.000Z",
        records: [record],
      }),
    ).toThrow("audit_export_destination_tenant_mismatch");
    expect(() =>
      createGovernedAuditExport({
        exportId: "export-1",
        tenantId: "tenant-a",
        requestedByActorId: "security-owner",
        destination: { uri: "https://example.com/audit", ownerTenantId: "tenant-a" },
        redactionProfile: "support",
        createdAt: "2026-08-02T00:00:00.000Z",
        records: [record],
      }),
    ).toThrow("audit_export_destination_invalid");
  });

  it("detects tampered export replay", () => {
    const bundle = createGovernedAuditExport({
      exportId: "export-1",
      tenantId: "tenant-a",
      requestedByActorId: "security-owner",
      destination: { uri: "gs://tenant-a-audit/export", ownerTenantId: "tenant-a" },
      redactionProfile: "support",
      createdAt: "2026-08-02T00:00:00.000Z",
      records: [record],
    });
    const tampered = {
      ...bundle,
      records: [{ ...bundle.records[0]!, action: "candidate.failed" }],
    };
    expect(verifyGovernedAuditExport(tampered)).toMatchObject({
      ok: false,
      error: "audit_export_chain:audit-1",
    });
  });
});
