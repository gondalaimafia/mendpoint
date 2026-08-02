import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  confirmCustomerIncident,
  createChangeSourceArtifact,
  getChangeSourceArtifact,
  listChangeSourceEvents,
  listChangeSourceRevisions,
  openChangeSourceStore,
  requireApprovedChangeSourceForFanout,
  reviewChangeSourceArtifact,
  verifyChangeSourceEventIntegrity,
  type ChangeSourceStore,
  type CustomerIncidentInput,
  type ManualProviderAnnouncementInput,
} from "./index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const CREATED = "2026-08-01T12:00:00.000Z";
const REVIEWED = "2026-08-01T12:05:00.000Z";
const CONFIRMED = "2026-08-01T12:10:00.000Z";

const stores: ChangeSourceStore[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // A restart test closes its first handle explicitly.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function memoryStore(): ChangeSourceStore {
  const store = openChangeSourceStore();
  stores.push(store);
  return store;
}

function manual(
  tenantId = "tenant-a",
  overrides: Partial<ManualProviderAnnouncementInput> = {},
): ManualProviderAnnouncementInput {
  return {
    id: `manual-${tenantId}`,
    tenantId,
    kind: "manual_provider_announcement",
    providerSlug: "stripe",
    announcement: "The Charges API removes amount_cents on 2026-10-01.",
    author: { principalId: "human:author", displayName: "Provider operator" },
    source: { kind: "provider_page", uri: "https://docs.stripe.com/changelog/charges-v2" },
    effectiveDate: "2026-10-01T00:00:00.000Z",
    affectedProducts: ["charges", "payments"],
    evidence: [{ kind: "document", locator: "https://docs.stripe.com/changelog/charges-v2", sha256: HASH_A }],
    provenance: {
      observedAt: CREATED,
      capturedAt: CREATED,
      capturedBy: "collector:manual-intake",
      sourceRevision: "2026-08-01",
    },
    excerpt: { text: "amount_cents is removed", location: "Migration section, paragraph 2" },
    confidence: 0.9,
    createdAt: CREATED,
    ...overrides,
  };
}

function incident(
  tenantId = "tenant-a",
  overrides: Partial<CustomerIncidentInput> = {},
): CustomerIncidentInput {
  return {
    id: `incident-${tenantId}`,
    tenantId,
    kind: "customer_incident",
    incidentRef: "INC-1042",
    redactedDetails: "Payment requests return 400 for account [REDACTED].",
    redactionEvidence: {
      method: "deterministic field allowlist v1",
      sourceSha256: HASH_B,
      redactedFields: ["account_id", "authorization"],
    },
    author: { principalId: "human:support", displayName: "Support operator" },
    source: { kind: "customer_ticket", uri: "urn:mendpoint:incident:INC-1042" },
    effectiveDate: null,
    affectedProducts: ["payments"],
    evidence: [{ kind: "ticket", locator: "urn:mendpoint:evidence:ticket-1042", sha256: HASH_B }],
    provenance: {
      observedAt: CREATED,
      capturedAt: CREATED,
      capturedBy: "collector:support-intake",
      sourceRevision: "ticket-revision-3",
    },
    excerpt: { text: "requests return 400", location: "customer report, line 1" },
    confidence: 0.6,
    createdAt: CREATED,
    ...overrides,
  };
}

describe("change source artifact store", () => {
  it("deduplicates canonical content inside a tenant without crossing tenant boundaries", () => {
    const store = memoryStore();
    const first = createChangeSourceArtifact(store, manual());
    const duplicate = createChangeSourceArtifact(store, manual("tenant-a", {
      id: "manual-duplicate",
      author: { principalId: "human:other", displayName: "Another operator" },
    }));
    const otherTenant = createChangeSourceArtifact(store, manual("tenant-b"));

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(duplicate.artifact.id).toBe(first.artifact.id);
    expect(otherTenant.inserted).toBe(true);
    expect(otherTenant.artifact.id).not.toBe(first.artifact.id);
    expect(getChangeSourceArtifact(store, "tenant-b", first.artifact.id)).toBeUndefined();
    expect(() => reviewChangeSourceArtifact(store, {
      tenantId: "tenant-b",
      artifactId: first.artifact.id,
      expectedRevision: 1,
      reviewerPrincipalId: "human:reviewer",
      decision: "approve",
      reason: "wrong tenant",
      reviewedAt: REVIEWED,
    })).toThrow("change_source_artifact_not_found");
    expect(listChangeSourceEvents(store, "tenant-a", first.artifact.id)).toHaveLength(1);
  });

  it("persists artifacts, revisions, and event integrity across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-change-source-"));
    directories.push(directory);
    const path = join(directory, "change-source.sqlite");
    const firstStore = openChangeSourceStore(path);
    stores.push(firstStore);
    const created = createChangeSourceArtifact(firstStore, manual());
    reviewChangeSourceArtifact(firstStore, {
      tenantId: "tenant-a",
      artifactId: created.artifact.id,
      expectedRevision: 1,
      reviewerPrincipalId: "human:reviewer",
      decision: "approve",
      reason: "source and scope verified",
      override: { confidence: 0.98, affectedProducts: ["payments"] },
      reviewedAt: REVIEWED,
    });
    firstStore.close();
    stores.splice(stores.indexOf(firstStore), 1);

    const reopened = openChangeSourceStore(path);
    stores.push(reopened);
    const artifact = getChangeSourceArtifact(reopened, "tenant-a", created.artifact.id);
    expect(artifact?.latestRevision).toMatchObject({
      revision: 2,
      reviewState: "approved",
      reviewerPrincipalId: "human:reviewer",
      reviewerOverride: { confidence: 0.98, affectedProducts: ["payments"] },
    });
    expect(listChangeSourceRevisions(reopened, "tenant-a", created.artifact.id)).toHaveLength(2);
    expect(verifyChangeSourceEventIntegrity(reopened, "tenant-a", created.artifact.id)).toEqual({
      ok: true,
      checked: 2,
      firstInvalidSequence: null,
    });
  });

  it("enforces append-only artifacts, revisions, and events in SQLite", () => {
    const store = memoryStore();
    const created = createChangeSourceArtifact(store, manual()).artifact;

    expect(() => store.raw.prepare("UPDATE change_source_artifacts SET confidence = 0 WHERE id = ?").run(created.id))
      .toThrow(/change_source_artifacts_append_only/);
    expect(() => store.raw.prepare("DELETE FROM change_source_revisions WHERE artifact_id = ?").run(created.id))
      .toThrow(/change_source_revisions_append_only/);
    expect(() => store.raw.prepare("UPDATE change_source_events SET payload_json = '{}' WHERE artifact_id = ?").run(created.id))
      .toThrow(/change_source_events_append_only/);
    expect(getChangeSourceArtifact(store, "tenant-a", created.id)?.confidence).toBe(0.9);
  });

  it("rejects missing or unsafe provenance before writing", () => {
    const store = memoryStore();
    expect(() => createChangeSourceArtifact(store, manual("tenant-a", {
      source: { kind: "provider_page", uri: "http://internal.example/change" },
    }))).toThrow("change_source_source_uri_unsafe");
    expect(() => createChangeSourceArtifact(store, manual("tenant-a", {
      source: {
        kind: "provider_page",
        uri: "https://docs.example.com/change?access_token=do-not-store",
      },
    }))).toThrow("change_source_source_uri_unsafe");
    expect(() => createChangeSourceArtifact(store, manual("tenant-a", {
      id: "missing-evidence",
      announcement: "A different announcement",
      evidence: [],
    }))).toThrow("change_source_evidence_required");
    expect(() => createChangeSourceArtifact(store, manual("tenant-a", {
      id: "bad-time",
      announcement: "Another different announcement",
      provenance: {
        observedAt: REVIEWED,
        capturedAt: CREATED,
        capturedBy: "collector:test",
      },
    }))).toThrow("change_source_provenance_time_invalid");
    expect(store.raw.prepare("SELECT COUNT(*) AS count FROM change_source_artifacts").get()).toEqual({ count: 0 });
  });

  it("requires redaction evidence and never accepts raw incident material", () => {
    const store = memoryStore();
    expect(() => createChangeSourceArtifact(store, incident("tenant-a", {
      redactionEvidence: undefined as never,
    }))).toThrow("change_source_redaction_evidence_required");
    expect(() => createChangeSourceArtifact(store, {
      ...incident("tenant-a", { id: "raw-incident", incidentRef: "INC-RAW" }),
      rawDetails: "Authorization: Bearer secret-token",
    } as CustomerIncidentInput)).toThrow("change_source_unredacted_incident_material_rejected");
    expect(() => createChangeSourceArtifact(store, incident("tenant-a", {
      id: "leaked-incident",
      incidentRef: "INC-LEAK",
      redactedDetails: "Authorization: Bearer secret-token",
    }))).toThrow("change_source_incident_details_not_redacted");

    const created = createChangeSourceArtifact(store, incident()).artifact;
    expect(created.redactionEvidence).toMatchObject({
      method: "deterministic field allowlist v1",
      sourceSha256: HASH_B,
      redactedFields: ["account_id", "authorization"],
    });
    expect(created.redactionEvidence?.redactedContentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(created)).not.toContain("secret-token");
  });

  it("fails closed until review approval and customer confirmation are both recorded", () => {
    const store = memoryStore();
    const announcement = createChangeSourceArtifact(store, manual()).artifact;
    expect(() => requireApprovedChangeSourceForFanout(store, "tenant-a", announcement.id))
      .toThrow("change_source_not_approved_for_fanout");
    const approvedAnnouncement = reviewChangeSourceArtifact(store, {
      tenantId: "tenant-a",
      artifactId: announcement.id,
      expectedRevision: 1,
      reviewerPrincipalId: "human:reviewer",
      decision: "approve",
      reason: "provider evidence verified",
      reviewedAt: REVIEWED,
    });
    expect(requireApprovedChangeSourceForFanout(store, "tenant-a", announcement.id).id)
      .toBe(approvedAnnouncement.id);

    const customerIncident = createChangeSourceArtifact(store, incident()).artifact;
    const approvedIncident = reviewChangeSourceArtifact(store, {
      tenantId: "tenant-a",
      artifactId: customerIncident.id,
      expectedRevision: 1,
      reviewerPrincipalId: "human:reviewer",
      decision: "approve",
      reason: "redacted evidence is sufficient",
      reviewedAt: REVIEWED,
    });
    expect(() => requireApprovedChangeSourceForFanout(store, "tenant-a", customerIncident.id))
      .toThrow("change_source_incident_not_confirmed_for_fanout");
    const confirmedIncident = confirmCustomerIncident(store, {
      tenantId: "tenant-a",
      artifactId: customerIncident.id,
      expectedRevision: approvedIncident.latestRevision.revision,
      actorPrincipalId: "human:customer-owner",
      confirmed: true,
      reason: "customer reproduced and confirmed the affected surface",
      confirmedAt: CONFIRMED,
    });
    expect(confirmedIncident.latestRevision).toMatchObject({
      revision: 3,
      reviewState: "approved",
      incidentConfirmation: "confirmed",
    });
    expect(requireApprovedChangeSourceForFanout(store, "tenant-a", customerIncident.id).id)
      .toBe(customerIncident.id);
  });
});
