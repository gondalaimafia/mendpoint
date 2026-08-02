import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type AppDb } from "@mendpoint/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesignPartnerApplicationStore,
  type DesignPartnerApplicationBody,
  type DesignPartnerApplicationStore,
} from "./design-partner-applications-store.js";

const KEY = Buffer.alloc(32, 73);
const NOW = new Date("2026-08-01T15:00:00.000Z");
const directories: string[] = [];
const databases: AppDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.raw.close();
    } catch {
      // Restart tests close an earlier handle explicitly.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-design-partner-store-"));
  directories.push(directory);
  const path = join(directory, "applications.sqlite");
  const db = createDb(path);
  databases.push(db);
  let sequence = 0;
  const store = createDesignPartnerApplicationStore({
    db,
    key: KEY,
    now: () => new Date(NOW),
    createId: () => `application-${++sequence}`,
  });
  return { path, db, store };
}

function validBody(overrides: Partial<DesignPartnerApplicationBody> = {}): DesignPartnerApplicationBody {
  return {
    name: "Avery Smith",
    workEmail: "Avery@Acme.dev",
    company: "Acme Systems",
    role: "Platform lead",
    providerChange: "We need to validate a payment provider API version change next quarter.",
    repositoryScope: "One approved service repository with the payments adapter and its tests.",
    successMetric: "Produce a verified patch with passing checks and no unrelated file changes.",
    authorized: true,
    consent: true,
    website: "",
    startedAt: NOW.getTime() - 10_000,
    ...overrides,
  };
}

function create(
  store: DesignPartnerApplicationStore,
  requestId: string,
  body: unknown = validBody(),
  tenantId = "tenant-a",
) {
  return store.create({
    tenantId,
    actorPrincipalId: "api-key:key-a",
    requestId,
    body,
    source: {
      bridge: "public-design-partner-v1",
      origin: "https://mendpoint.dev",
      referrerPath: "/design-partners",
      userAgent: "Mendpoint test client",
    },
  });
}

describe("design partner application storage", () => {
  it("persists encrypted append-only records across restart", () => {
    const { path, db, store } = fixture();
    const created = create(store, "persist-1");
    expect(created.replayed).toBe(false);

    const raw = db.raw.prepare("SELECT * FROM design_partner_applications WHERE id = ?")
      .get(created.application.id) as Record<string, unknown>;
    const serialized = JSON.stringify(raw);
    for (const plaintext of [
      "Avery Smith",
      "avery@acme.dev",
      "Acme Systems",
      "payment provider API version",
      "api-key:key-a",
    ]) {
      expect(serialized.toLowerCase()).not.toContain(plaintext.toLowerCase());
    }
    expect(String(raw.email_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(String(raw.content_digest)).toMatch(/^[a-f0-9]{64}$/);
    const audit = vi.fn();
    expect(store.reveal({
      tenantId: "tenant-a",
      actorPrincipalId: "api-key:key-a",
      requestId: "reveal-persisted",
      applicationId: created.application.id,
      purposeCode: "application_review",
    }, audit).payload).toMatchObject({
      contact: { workEmail: "avery@acme.dev", company: "Acme Systems" },
      evidence: {
        actorPrincipalId: "api-key:key-a",
        consentGranted: true,
        authorizationConfirmed: true,
      },
    });
    expect(audit).toHaveBeenCalledOnce();
    expect(() => db.raw.prepare("UPDATE design_partner_applications SET status = 'new' WHERE id = ?")
      .run(created.application.id)).toThrow(/append_only/);
    expect(() => db.raw.prepare("DELETE FROM design_partner_applications WHERE id = ?")
      .run(created.application.id)).toThrow(/append_only/);

    db.raw.close();
    databases.splice(databases.indexOf(db), 1);
    const reopenedDb = createDb(path);
    databases.push(reopenedDb);
    const reopened = createDesignPartnerApplicationStore({
      db: reopenedDb,
      key: KEY,
      now: () => new Date("2026-08-01T15:30:00.000Z"),
    });
    expect(reopened.get("tenant-a", created.application.id)).toEqual(created.application);
    const replay = create(reopened, "persist-1");
    expect(replay).toEqual({ application: created.application, replayed: true });
  });

  it("isolates tenant metadata and keeps list and get responses free of plaintext PII", () => {
    const { store } = fixture();
    const created = create(store, "tenant-a-1");
    expect(store.list("tenant-b")).toEqual([]);
    expect(store.get("tenant-b", created.application.id)).toBeUndefined();
    const exposed = JSON.stringify({
      list: store.list("tenant-a"),
      get: store.get("tenant-a", created.application.id),
    });
    expect(exposed).not.toContain("Avery");
    expect(exposed).not.toContain("Acme");
    expect(exposed).not.toContain("api-key:key-a");
    expect(exposed).not.toContain("emailHash");
  });

  it("replays only the same request and rejects changed or duplicated submissions", () => {
    const { store } = fixture();
    const first = create(store, "replay-1");
    expect(create(store, "replay-1")).toEqual({ application: first.application, replayed: true });
    expect(() => create(store, "replay-1", validBody({ company: "Different Company" })))
      .toThrow("application_idempotency_conflict");
    expect(() => create(store, "duplicate-1")).toThrow("application_duplicate_rejected");
  });

  it("limits repeated accepted applications for the same normalized email", () => {
    const { store } = fixture();
    for (let index = 1; index <= 3; index += 1) {
      create(store, `rate-${index}`, validBody({
        successMetric: `Produce verified result number ${index} with passing checks and recorded evidence.`,
      }));
    }
    expect(() => create(store, "rate-4", validBody({
      successMetric: "Produce verified result number four with passing checks and recorded evidence.",
    }))).toThrow("application_rate_limited");
  });

  it.each([
    ["honeypot", { website: "bot.example" }, "application_honeypot_rejected"],
    ["too fast", { startedAt: NOW.getTime() - 500 }, "application_submitted_too_fast"],
    ["expired", { startedAt: NOW.getTime() - 3_700_000 }, "application_form_expired"],
    ["disposable email", { workEmail: "person@mailinator.com" }, "application_disposable_email_rejected"],
    ["private email", { workEmail: "person@company.local" }, "application_work_email_invalid"],
    ["invalid email", { workEmail: "person@localhost" }, "application_work_email_invalid"],
    ["URL", { providerChange: "We need to validate the change described at https://private.example/repo now." }, "application_url_rejected"],
    ["secret", { repositoryScope: "The approved adapter uses Authorization: Bearer super-secret-token-value." }, "application_secret_rejected"],
    ["source code", { successMetric: "The result should include ```const result = input``` and passing verification." }, "application_source_code_rejected"],
    ["oversized field", { successMetric: "x".repeat(1_201) }, "application_successMetric_invalid"],
    ["missing consent", { consent: false }, "application_consent_required"],
    ["missing authorization", { authorized: false }, "application_authorization_required"],
  ])("rejects %s", (_label, overrides, expected) => {
    const { store } = fixture();
    expect(() => create(store, `reject-${String(_label).replaceAll(" ", "-")}`, validBody(overrides)))
      .toThrow(expected);
  });

  it("rejects client supplied server-owned state and requires a separate valid key", () => {
    const { db, store } = fixture();
    expect(() => create(store, "server-owned", { ...validBody(), tenantId: "tenant-victim" }))
      .toThrow("application_server_owned_field_rejected");
    expect(() => createDesignPartnerApplicationStore({ db, env: {} })).toThrow("application_data_key_required");
    expect(() => createDesignPartnerApplicationStore({
      db,
      env: {
        MENDPOINT_APPLICATION_DATA_KEY: KEY.toString("base64url"),
        MENDPOINT_API_KEY: KEY.toString("base64url"),
      },
    })).toThrow("application_data_key_not_distinct");
  });

  it("requires a successful attributable audit callback before revealing plaintext", () => {
    const { store } = fixture();
    const created = create(store, "audited-reveal-create");
    const input = {
      tenantId: "tenant-a",
      actorPrincipalId: "human:owner@company.dev",
      requestId: "audited-reveal",
      applicationId: created.application.id,
      purposeCode: "applicant_follow_up" as const,
    };
    expect(() => store.reveal(input, (() => {
      throw new Error("audit_sink_unavailable");
    }))).toThrow("audit_sink_unavailable");
    expect(() => (store.reveal as unknown as (value: typeof input, audit?: unknown) => unknown)(input))
      .toThrow("application_audit_callback_required");

    const audit = vi.fn();
    const revealed = store.reveal(input, audit);
    expect(revealed.payload.contact.workEmail).toBe("avery@acme.dev");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      actorPrincipalId: "human:owner@company.dev",
      requestId: "audited-reveal",
      resourceId: created.application.id,
      purposeCode: "applicant_follow_up",
    }));
  });

  it("cryptographically erases one payload while retaining immutable metadata and evidence", () => {
    const { path, db, store } = fixture();
    const created = create(store, "erase-create");
    const ciphertextBefore = db.raw.prepare("SELECT encrypted_payload FROM design_partner_applications WHERE id = ?")
      .get(created.application.id) as { encrypted_payload: string };
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM design_partner_application_payload_keys WHERE application_id = ?")
      .get(created.application.id)).toEqual({ count: 1 });

    const erased = store.erase({
      tenantId: "tenant-a",
      actorPrincipalId: "human:owner@company.dev",
      requestId: "erase-request",
      applicationId: created.application.id,
      reasonCode: "applicant_request",
    });
    expect(erased.replayed).toBe(false);
    expect(erased.application).toMatchObject({
      id: created.application.id,
      payloadState: "erased",
      erasureReasonCode: "applicant_request",
    });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM design_partner_application_payload_keys WHERE application_id = ?")
      .get(created.application.id)).toEqual({ count: 0 });
    expect(db.raw.prepare("SELECT encrypted_payload FROM design_partner_applications WHERE id = ?")
      .get(created.application.id)).toEqual(ciphertextBefore);
    expect(() => store.reveal({
      tenantId: "tenant-a",
      actorPrincipalId: "human:owner@company.dev",
      requestId: "reveal-after-erase",
      applicationId: created.application.id,
      purposeCode: "privacy_request",
    }, vi.fn())).toThrow("application_payload_erased");
    expect(() => db.raw.prepare("DELETE FROM design_partner_application_erasures WHERE application_id = ?")
      .run(created.application.id)).toThrow(/append_only/);

    const replay = store.erase({
      tenantId: "tenant-a",
      actorPrincipalId: "human:owner@company.dev",
      requestId: "erase-request",
      applicationId: created.application.id,
      reasonCode: "applicant_request",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.erasure).toEqual(erased.erasure);
    expect(() => store.erase({
      tenantId: "tenant-b",
      actorPrincipalId: "human:owner@company.dev",
      requestId: "cross-tenant-erase",
      applicationId: created.application.id,
      reasonCode: "operator_request",
    })).toThrow("application_not_found");

    db.raw.close();
    databases.splice(databases.indexOf(db), 1);
    const reopenedDb = createDb(path);
    databases.push(reopenedDb);
    const reopened = createDesignPartnerApplicationStore({
      db: reopenedDb,
      key: KEY,
      now: () => new Date(NOW),
    });
    expect(reopened.get("tenant-a", created.application.id)?.payloadState).toBe("erased");
    expect(() => reopened.reveal({
      tenantId: "tenant-a",
      actorPrincipalId: "human:owner@company.dev",
      requestId: "reveal-erased-after-restart",
      applicationId: created.application.id,
      purposeCode: "privacy_request",
    }, vi.fn())).toThrow("application_payload_erased");
  });

  it("publishes retention expiry and purges only expired payloads in the authenticated tenant", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-design-partner-retention-"));
    directories.push(directory);
    const db = createDb(join(directory, "applications.sqlite"));
    databases.push(db);
    let current = new Date(NOW);
    let sequence = 0;
    const store = createDesignPartnerApplicationStore({
      db,
      key: KEY,
      now: () => new Date(current),
      createId: () => `retained-${++sequence}`,
      retentionMs: 24 * 60 * 60 * 1_000,
    });
    const tenantA = create(store, "retention-a", validBody(), "tenant-a");
    const tenantB = create(store, "retention-b", validBody(), "tenant-b");
    expect(tenantA.application.retentionExpiresAt).toBe("2026-08-02T15:00:00.000Z");
    current = new Date("2026-08-03T15:00:00.000Z");
    expect(() => store.reveal({
      tenantId: "tenant-a",
      actorPrincipalId: "api-key:key-a",
      requestId: "expired-reveal",
      applicationId: tenantA.application.id,
      purposeCode: "application_review",
    }, vi.fn())).toThrow("application_payload_expired");
    const purge = store.purgeExpired({
      tenantId: "tenant-a",
      actorPrincipalId: "api-key:key-a",
      requestId: "purge-expired-a",
    });
    expect(purge).toEqual({ purgedApplicationIds: [tenantA.application.id], purgedCount: 1 });
    expect(store.get("tenant-a", tenantA.application.id)?.payloadState).toBe("erased");
    expect(store.get("tenant-b", tenantB.application.id)?.payloadState).toBe("available");
    expect(store.purgeExpired({
      tenantId: "tenant-a",
      actorPrincipalId: "api-key:key-a",
      requestId: "purge-expired-a-again",
    }).purgedCount).toBe(0);
  });
});
