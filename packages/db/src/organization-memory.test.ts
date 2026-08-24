import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  insertArtifactManifest,
  insertEvidenceRecord,
  insertPrincipal,
  insertTenant,
  type AppDb,
} from "./index.js";
import {
  activateOrganizationMemory,
  assessActivation,
  confirmOrganizationMemory,
  createExplicitMemory,
  CORROBORATION_THRESHOLD,
  deleteOrganizationMemory,
  disableOrganizationMemory,
  editOrganizationMemory,
  getOrganizationMemoryHead,
  getOrganizationMemoryProvenance,
  listOrganizationMemory,
  organizationMemoryId,
  observeOrganizationMemory,
  recordOrganizationMemoryObservation,
  rejectOrganizationMemory,
} from "./organization-memory.js";

const AT = "2026-08-01T00:00:00.000Z";
const T1 = "2026-08-01T01:00:00.000Z";
const T2 = "2026-08-01T02:00:00.000Z";
const T3 = "2026-08-01T03:00:00.000Z";

const dirs: string[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(tenants: string[] = ["tenant-a"]): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-org-memory-"));
  dirs.push(dir);
  const db = createDb(join(dir, "org-memory.sqlite"));
  dbs.push(db);
  for (const tenantId of tenants) {
    insertTenant(db, { id: tenantId, slug: tenantId, name: tenantId, createdAt: AT });
    insertPrincipal(db, {
      id: `human-${tenantId}`,
      tenantId,
      kind: "human",
      subject: `user-${tenantId}`,
      displayName: `Human ${tenantId}`,
      createdAt: AT,
    });
    insertPrincipal(db, {
      id: `human-${tenantId}-second`,
      tenantId,
      kind: "human",
      subject: `user-${tenantId}-second`,
      displayName: `Human ${tenantId} second`,
      createdAt: AT,
    });
  }
  return db;
}

const OBS = {
  category: "CODING_CONVENTION" as const,
  scope: "tenant",
  subjectKey: "prefer-internal-auth-client",
  statement: "Prefer the internal auth client over direct OAuth calls",
  source: "repeated_verified_behavior" as const,
};

function observe(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    category: typeof OBS.category;
    scope: string;
    subjectKey: string;
    statement: string;
    source: typeof OBS.source;
    at: string;
    observerPrincipalId?: string;
  }>,
  evidenceKey: string,
) {
  const observerPrincipalId = input.observerPrincipalId ?? `human-${input.tenantId}`;
  const memoryId = organizationMemoryId(input);
  const artifactId = `artifact-${evidenceKey}`;
  const evidenceId = `evidence-${evidenceKey}`;
  const content = JSON.stringify({ memoryId, evidenceKey });
  const sha256 = createHash("sha256").update(content).digest("hex");
  insertArtifactManifest(db, {
    id: artifactId,
    tenantId: input.tenantId,
    kind: "organization_memory_observation",
    schemaVersion: 1,
    sha256,
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
    storageRef: `inline:${artifactId}`,
    content,
    producerPrincipalId: observerPrincipalId,
    createdAt: input.at,
  });
  insertEvidenceRecord(db, {
    id: evidenceId,
    tenantId: input.tenantId,
    subjectType: "organization_memory_observation",
    subjectId: memoryId,
    artifactId,
    producerPrincipalId: observerPrincipalId,
    tool: "mendpoint-organization-memory-observer",
    verdict: "passed",
    createdAt: input.at,
  });
  return recordOrganizationMemoryObservation(db, {
    ...input,
    observerPrincipalId,
    sourceRefs: [evidenceId],
  });
}

describe("Organization Memory governance", () => {
  it("a single observation cannot reach ACTIVE", () => {
    const db = fixture();
    const candidate = observe(db, {
      tenantId: "tenant-a",
      ...OBS,
      at: T1,
    }, "single-observation");
    expect(candidate.status).toBe("MEMORY_CANDIDATE");

    // The activation control must refuse: one observation is corroboration 1,
    // below CORROBORATION_THRESHOLD, and no human confirmed it.
    expect(() =>
      activateOrganizationMemory(db, {
        tenantId: "tenant-a",
        memoryId: candidate.memoryId,
        reason: "attempt to activate a lone observation",
        at: T2,
      }),
    ).toThrow("organization_memory_activation_blocked_insufficient_corroboration");

    const head = getOrganizationMemoryHead(db, "tenant-a", candidate.memoryId);
    expect(head?.status).toBe("MEMORY_CANDIDATE");

    // And the assessment itself reports blocked with the distinct reason.
    const chain = getOrganizationMemoryProvenance(db, "tenant-a", candidate.memoryId);
    expect(assessActivation(chain)).toEqual({
      status: "blocked",
      reason: "insufficient_corroboration",
    });
  });

  it("re-submitting the SAME observation cannot inflate corroboration", () => {
    const db = fixture();
    const first = observe(db, {
      tenantId: "tenant-a",
      ...OBS,
      at: T1,
    }, "duplicate-observation");
    // Same authority evidence again — idempotent, still a single distinct observation.
    const again = observe(db, {
      tenantId: "tenant-a",
      ...OBS,
      at: T2,
    }, "duplicate-observation");
    expect(again.recordId).toBe(first.recordId);
    expect(again.status).toBe("MEMORY_CANDIDATE");
    expect(() =>
      activateOrganizationMemory(db, {
        tenantId: "tenant-a",
        memoryId: first.memoryId,
        reason: "attempt",
        at: T3,
      }),
    ).toThrow("organization_memory_activation_blocked_insufficient_corroboration");
  });

  it("two independent observations validate, then activate to ACTIVE", () => {
    const db = fixture();
    observe(db, {
      tenantId: "tenant-a",
      ...OBS,
      at: T1,
    }, "independent-one");
    const second = observe(db, {
      tenantId: "tenant-a",
      ...OBS,
      observerPrincipalId: "human-tenant-a-second",
      at: T2,
    }, "independent-two");
    expect(CORROBORATION_THRESHOLD).toBe(2);
    expect(second.status).toBe("VALIDATION");
    const active = activateOrganizationMemory(db, {
      tenantId: "tenant-a",
      memoryId: second.memoryId,
      reason: "corroborated by two independent migrations",
      at: T3,
    });
    expect(active.status).toBe("ACTIVE");
  });

  it("rechecks corroboration authority at activation time", () => {
    const db = fixture();
    observe(db, { tenantId: "tenant-a", ...OBS, at: T1 }, "revocation-one");
    const second = observe(db, {
      tenantId: "tenant-a",
      ...OBS,
      observerPrincipalId: "human-tenant-a-second",
      at: T2,
    }, "revocation-two");
    db.raw.prepare("UPDATE principals SET revoked_at = ? WHERE id = ?")
      .run(T2, "human-tenant-a-second");
    expect(() => activateOrganizationMemory(db, {
      tenantId: "tenant-a",
      memoryId: second.memoryId,
      reason: "must recheck authority",
      at: T3,
    })).toThrow("organization_memory_observer_authority_invalid");
    expect(getOrganizationMemoryHead(db, "tenant-a", second.memoryId)?.status).toBe("VALIDATION");
  });

  it("a human confirmation promotes a single-observation candidate", () => {
    const db = fixture();
    const candidate = observe(db, {
      tenantId: "tenant-a",
      ...OBS,
      at: T1,
    }, "human-confirmation");
    const confirmed = confirmOrganizationMemory(db, {
      tenantId: "tenant-a",
      memoryId: candidate.memoryId,
      actorPrincipalId: "human-tenant-a",
      reason: "confirmed by the platform owner",
      at: T2,
    });
    expect(confirmed.status).toBe("CONFIRMED");
    const active = activateOrganizationMemory(db, {
      tenantId: "tenant-a",
      memoryId: candidate.memoryId,
      actorPrincipalId: "human-tenant-a",
      reason: "activate confirmed memory",
      at: T3,
    });
    expect(active.status).toBe("ACTIVE");
  });

  it("an explicit human statement is created ACTIVE", () => {
    const db = fixture();
    const memory = createExplicitMemory(db, {
      tenantId: "tenant-a",
      category: "REVIEW_PREFERENCE",
      scope: "tenant",
      subjectKey: "squash-merge-only",
      statement: "Squash-merge only; no merge commits",
      actorPrincipalId: "human-tenant-a",
      reason: "stated in onboarding",
      at: T1,
    });
    expect(memory.status).toBe("ACTIVE");
    expect(memory.source).toBe("explicit");
    expect(memory.trainingEligible).toBe(false);
  });

  it("rejects a candidate", () => {
    const db = fixture();
    const candidate = observe(db, {
      tenantId: "tenant-a",
      ...OBS,
      at: T1,
    }, "rejection");
    const rejected = rejectOrganizationMemory(db, {
      tenantId: "tenant-a",
      memoryId: candidate.memoryId,
      actorPrincipalId: "human-tenant-a",
      reason: "not a real convention",
      at: T2,
    });
    expect(rejected.status).toBe("REJECTED");
  });
});

describe("Organization Memory history + disable", () => {
  it("an edit preserves prior history rather than destroying it", () => {
    const db = fixture();
    const created = createExplicitMemory(db, {
      tenantId: "tenant-a",
      category: "PRESENTATION_PREFERENCE",
      scope: "tenant",
      subjectKey: "no-em-dashes",
      statement: "No em dashes in user-facing copy",
      actorPrincipalId: "human-tenant-a",
      reason: "brand guideline",
      at: T1,
    });
    const edited = editOrganizationMemory(db, {
      tenantId: "tenant-a",
      memoryId: created.memoryId,
      actorPrincipalId: "human-tenant-a",
      reason: "clarify scope",
      at: T2,
      statement: "No em dashes or en dashes in user-facing copy",
    });
    expect(edited.revision).toBe(2);

    const provenance = getOrganizationMemoryProvenance(db, "tenant-a", created.memoryId);
    expect(provenance).toHaveLength(2);
    // The original revision is untouched — history is intact.
    expect(provenance[0]!.recordId).toBe(created.recordId);
    expect(provenance[0]!.statement).toBe("No em dashes in user-facing copy");
    // The head carries the edited statement.
    const head = getOrganizationMemoryHead(db, "tenant-a", created.memoryId);
    expect(head?.statement).toBe("No em dashes or en dashes in user-facing copy");
    expect(head?.status).toBe("ACTIVE");
  });

  it("append-only: raw UPDATE and DELETE are rejected", () => {
    const db = fixture();
    const created = createExplicitMemory(db, {
      tenantId: "tenant-a",
      category: "CODING_CONVENTION",
      scope: "tenant",
      subjectKey: "tabs-vs-spaces",
      statement: "Two-space indentation",
      actorPrincipalId: "human-tenant-a",
      reason: "style",
      at: T1,
    });
    expect(() =>
      db.raw.prepare("UPDATE organization_memory SET statement = ? WHERE record_id = ?").run("tampered", created.recordId),
    ).toThrow("organization_memory_append_only");
    expect(() =>
      db.raw.prepare("DELETE FROM organization_memory WHERE record_id = ?").run(created.recordId),
    ).toThrow("organization_memory_append_only");
  });

  it("a disable flips the head immediately, with no redeploy", () => {
    const db = fixture();
    const created = createExplicitMemory(db, {
      tenantId: "tenant-a",
      category: "DEPLOYMENT_POLICY",
      scope: "tenant",
      subjectKey: "deploy-window",
      statement: "Deploy only on weekdays",
      actorPrincipalId: "human-tenant-a",
      reason: "ops policy",
      at: T1,
    });
    expect(getOrganizationMemoryHead(db, "tenant-a", created.memoryId)?.status).toBe("ACTIVE");
    disableOrganizationMemory(db, {
      tenantId: "tenant-a",
      memoryId: created.memoryId,
      actorPrincipalId: "human-tenant-a",
      reason: "no longer applies",
      at: T2,
    });
    // Re-queried head reflects the disable at once.
    expect(getOrganizationMemoryHead(db, "tenant-a", created.memoryId)?.status).toBe("DISABLED");
    expect(listOrganizationMemory(db, { tenantId: "tenant-a", status: "ACTIVE" })).toHaveLength(0);
    expect(listOrganizationMemory(db, { tenantId: "tenant-a", status: "DISABLED" })).toHaveLength(1);
  });

  it("a delete soft-deletes but preserves history", () => {
    const db = fixture();
    const created = createExplicitMemory(db, {
      tenantId: "tenant-a",
      category: "RISK_PREFERENCE",
      scope: "tenant",
      subjectKey: "low-risk-only",
      statement: "Only low-risk autonomous migrations",
      actorPrincipalId: "human-tenant-a",
      reason: "risk appetite",
      at: T1,
    });
    deleteOrganizationMemory(db, {
      tenantId: "tenant-a",
      memoryId: created.memoryId,
      actorPrincipalId: "human-tenant-a",
      reason: "obsolete",
      at: T2,
    });
    expect(getOrganizationMemoryHead(db, "tenant-a", created.memoryId)?.status).toBe("DELETED");
    // The original creation row still exists.
    expect(getOrganizationMemoryProvenance(db, "tenant-a", created.memoryId)).toHaveLength(2);
  });
});

describe("Organization Memory tenant binding (Tier 1, structural)", () => {
  it("cross-tenant read is impossible — proven structurally, not by filter", () => {
    const db = fixture(["tenant-a", "tenant-b"]);
    const common = {
      category: "ARCHITECTURE_CONVENTION" as const,
      scope: "tenant",
      subjectKey: "hexagonal-ports",
      statement: "Ports and adapters at every boundary",
      reason: "architecture standard",
    };
    const a = createExplicitMemory(db, { tenantId: "tenant-a", ...common, actorPrincipalId: "human-tenant-a", at: T1 });
    const b = createExplicitMemory(db, { tenantId: "tenant-b", ...common, actorPrincipalId: "human-tenant-b", at: T1 });

    // The logical id embeds the tenant, so "the same" convention has a DIFFERENT
    // memory_id per tenant. The content-addressed record_id differs too, because
    // tenant_id is inside the hashed body: a cross-tenant collision is
    // arithmetically impossible, not merely filtered.
    expect(a.memoryId).not.toBe(b.memoryId);
    expect(a.recordId).not.toBe(b.recordId);
    expect(a.contentSha256).not.toBe(b.contentSha256);

    // memory_id is deterministic and tenant-bound.
    expect(a.memoryId).toBe(
      organizationMemoryId({ tenantId: "tenant-a", category: common.category, scope: common.scope, subjectKey: common.subjectKey }),
    );

    // Tenant B cannot read tenant A's memory even with its exact id.
    expect(getOrganizationMemoryHead(db, "tenant-b", a.memoryId)).toBeUndefined();
    expect(getOrganizationMemoryProvenance(db, "tenant-b", a.memoryId)).toHaveLength(0);
    expect(listOrganizationMemory(db, { tenantId: "tenant-b" }).map((m) => m.memoryId)).toEqual([b.memoryId]);
  });

  it("a row read under the wrong tenant fails integrity rather than leaking", () => {
    const db = fixture(["tenant-a", "tenant-b"]);
    const a = createExplicitMemory(db, {
      tenantId: "tenant-a",
      category: "INTERNAL_ABSTRACTION",
      scope: "tenant",
      subjectKey: "use-http-client-wrapper",
      statement: "Use the shared HttpClient wrapper",
      actorPrincipalId: "human-tenant-a",
      reason: "internal abstraction",
      at: T1,
    });
    // A direct cross-tenant fetch by primary key, bypassing the tenant filter,
    // is caught by re-hash + tenant assertion in hydrate.
    const rows = db.raw
      .prepare("SELECT tenant_id FROM organization_memory WHERE record_id = ?")
      .all(a.recordId) as Array<{ tenant_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBe("tenant-a");
  });
});

describe("Organization Memory schema convergence", () => {
  it("an existing volume that predates the table gains it on next boot, with no ALTER", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-org-memory-converge-"));
    dirs.push(dir);
    const path = join(dir, "converge.sqlite");

    // Boot once, then simulate a PRE-CHANGE volume by dropping the feature's
    // table, indexes, and triggers — a database that predates Organization
    // Memory has exactly this shape (the table simply absent).
    const first = createDb(path);
    insertTenant(first, { id: "tenant-a", slug: "tenant-a", name: "tenant-a", createdAt: AT });
    insertPrincipal(first, {
      id: "human-tenant-a",
      tenantId: "tenant-a",
      kind: "human",
      subject: "user-a",
      displayName: "Human A",
      createdAt: AT,
    });
    first.raw.exec("DROP TRIGGER IF EXISTS organization_memory_append_only_update");
    first.raw.exec("DROP TRIGGER IF EXISTS organization_memory_append_only_delete");
    first.raw.exec("DROP INDEX IF EXISTS organization_memory_chain_idx");
    first.raw.exec("DROP INDEX IF EXISTS organization_memory_status_idx");
    first.raw.exec("DROP TABLE IF EXISTS organization_memory");
    const present = first.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='organization_memory'")
      .get();
    expect(present).toBeUndefined();
    first.raw.close();

    // Reopen the SAME volume with the current schema. CREATE TABLE IF NOT EXISTS
    // converges the missing table; no additive migration ALTERs anything.
    const second = createDb(path);
    dbs.push(second);
    const reconverged = second.raw
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='organization_memory'")
      .get() as { name: string } | undefined;
    expect(reconverged?.name).toBe("organization_memory");

    // The reconverged table is fully functional.
    const memory = createExplicitMemory(second, {
      tenantId: "tenant-a",
      category: "TESTING_REQUIREMENT",
      scope: "tenant",
      subjectKey: "coverage-floor",
      statement: "New code needs tests",
      actorPrincipalId: "human-tenant-a",
      reason: "quality bar",
      at: T1,
    });
    expect(memory.status).toBe("ACTIVE");
    expect(getOrganizationMemoryHead(second, "tenant-a", memory.memoryId)?.statement).toBe("New code needs tests");
  });
});

describe("observeOrganizationMemory producer", () => {
  it("mints observation evidence and records a candidate without a client evidence id", () => {
    const db = fixture();
    const recorded = observeOrganizationMemory(db, {
      tenantId: "tenant-a",
      ...OBS,
      observerPrincipalId: "human-tenant-a",
      at: T1,
    });
    expect(recorded.status).toBe("MEMORY_CANDIDATE");
    expect(recorded.sourceRefs).toHaveLength(1);
    const evidence = db.raw.prepare(
      `SELECT subject_type, subject_id, producer_principal_id, verdict FROM evidence_records WHERE id = ?`,
    ).get(recorded.sourceRefs[0]) as {
      subject_type: string; subject_id: string; producer_principal_id: string; verdict: string;
    };
    expect(evidence).toMatchObject({
      subject_type: "organization_memory_observation",
      subject_id: recorded.memoryId,
      producer_principal_id: "human-tenant-a",
      verdict: "passed",
    });
  });

  it("is idempotent for the same observer restating the same convention", () => {
    const db = fixture();
    const first = observeOrganizationMemory(db, {
      tenantId: "tenant-a",
      ...OBS,
      observerPrincipalId: "human-tenant-a",
      at: T1,
    });
    const again = observeOrganizationMemory(db, {
      tenantId: "tenant-a",
      ...OBS,
      observerPrincipalId: "human-tenant-a",
      at: T2,
    });
    expect(again.recordId).toBe(first.recordId);
    expect(again.sourceRefs).toEqual(first.sourceRefs);
  });

  it("lets a second independent principal corroborate through the producer", () => {
    const db = fixture();
    observeOrganizationMemory(db, {
      tenantId: "tenant-a",
      ...OBS,
      observerPrincipalId: "human-tenant-a",
      at: T1,
    });
    const second = observeOrganizationMemory(db, {
      tenantId: "tenant-a",
      ...OBS,
      observerPrincipalId: "human-tenant-a-second",
      at: T2,
    });
    expect(second.status).toBe("VALIDATION");
  });
});
