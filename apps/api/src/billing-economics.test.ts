import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendDomainEvent,
  createApiKey,
  createDb,
  createMission,
  createUsageEntitlement,
  createUsagePriceVersion,
  enqueueJob,
  ensureMissionTaskForJob,
  getPrincipalBySubject,
  insertTenant,
  insertArtifactManifest,
  insertReviewDecision,
  listActualExecutionCosts,
  missionTaskIdForJob,
  recordActualExecutionCost,
  reserveUsage,
  settleUsageReservation,
  type AppDb,
  type InvoiceExportSigner,
} from "@mendpoint/db";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthMiddleware, type ApiEnv } from "./auth.js";
import {
  createBillingEconomicsRoutes,
  invoiceExportSignerFromEnv,
} from "./billing-economics.js";
import { requestIdMiddleware } from "./production.js";

const NOW = "2026-08-01T15:00:00.000Z";
const directories: string[] = [];
const databases: AppDb[] = [];
const originalAuth = process.env.API_AUTH;
const testInvoiceKeyPair = generateKeyPairSync("ed25519");
const testInvoicePublicKeySpkiBase64 = Buffer.from(testInvoiceKeyPair.publicKey.export({
  format: "der",
  type: "spki",
})).toString("base64");

function serializedSigningKey(keyId: string) {
  const pair = generateKeyPairSync("ed25519");
  return {
    keyId,
    privateKeyPkcs8Base64: Buffer.from(pair.privateKey.export({
      format: "der",
      type: "pkcs8",
    })).toString("base64"),
    publicKeySpkiBase64: Buffer.from(pair.publicKey.export({
      format: "der",
      type: "spki",
    })).toString("base64"),
  };
}

function publicSigningKey(
  key: ReturnType<typeof serializedSigningKey>,
): { keyId: string; publicKeySpkiBase64: string } {
  return { keyId: key.keyId, publicKeySpkiBase64: key.publicKeySpkiBase64 };
}

afterEach(() => {
  if (originalAuth === undefined) delete process.env.API_AUTH;
  else process.env.API_AUTH = originalAuth;
  while (databases.length) databases.pop()?.raw.close();
  while (directories.length) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  process.env.API_AUTH = "required";
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-billing-api-"));
  directories.push(directory);
  const db = createDb(join(directory, "billing.sqlite"));
  databases.push(db);
  insertTenant(db, {
    id: "billing-tenant-a",
    slug: "billing-tenant-a",
    name: "Billing tenant A",
    createdAt: NOW,
  });
  insertTenant(db, {
    id: "billing-tenant-b",
    slug: "billing-tenant-b",
    name: "Billing tenant B",
    createdAt: NOW,
  });
  const tenantA = createApiKey(db, {
    id: "billing-key-a",
    name: "Billing tenant A",
    tenantId: "billing-tenant-a",
    scopes: ["*", "billing:execution-cost:write", "billing:execution-outcome:write"],
    createdAt: NOW,
  });
  const tenantB = createApiKey(db, {
    id: "billing-key-b",
    name: "Billing tenant B",
    tenantId: "billing-tenant-b",
    scopes: ["*"],
    createdAt: NOW,
  });
  return { db, tenantA: tenantA.token, tenantB: tenantB.token };
}

function appFor(
  db: AppDb,
  now: () => string = () => NOW,
  invoiceSigner?: InvoiceExportSigner,
) {
  const app = new Hono<ApiEnv>();
  app.use("*", requestIdMiddleware());
  app.use("*", createAuthMiddleware(db));
  app.route("/billing", createBillingEconomicsRoutes({ db, now, invoiceSigner }));
  return app;
}

function invoiceSigner(): InvoiceExportSigner {
  return {
    keyId: "invoice-api-key-1",
    authorize: ({ tenantId }) => tenantId === "billing-tenant-a",
    sign: (payload) => signBytes(
      null,
      Buffer.from(payload, "utf8"),
      testInvoiceKeyPair.privateKey,
    ).toString("base64"),
    verifyForKey: (keyId, payload, signature) =>
      keyId === "invoice-api-key-1" &&
      verifyBytes(
        null,
        Buffer.from(payload, "utf8"),
        testInvoiceKeyPair.publicKey,
        Buffer.from(signature, "base64"),
      ),
    verificationMaterialForKey: (keyId) => keyId === "invoice-api-key-1"
      ? { algorithm: "ed25519", publicKeySpkiBase64: testInvoicePublicKeySpkiBase64 }
      : null,
  };
}

function seedInvoiceUsage(db: AppDb) {
  createUsagePriceVersion(db, {
    id: "invoice-price-a",
    tenantId: "billing-tenant-a",
    formulaVersion: "mcu-v1",
    currency: "USD",
    pricePerMcuMoneyMicros: 20_000,
    effectiveAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    contractReference: "invoice-contract-a",
    createdAt: NOW,
  });
  createUsageEntitlement(db, {
    id: "invoice-entitlement-a",
    tenantId: "billing-tenant-a",
    priceVersionId: "invoice-price-a",
    quotaMcuMicros: 20_000_000,
    features: ["fettler", "regauge"],
    contractReference: "invoice-contract-a",
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-09-01T00:00:00.000Z",
    createdAt: NOW,
  });
  const reservation = reserveUsage(db, {
    id: "invoice-reservation-a",
    tenantId: "billing-tenant-a",
    idempotencyKey: "invoice-reserve-a",
    taskId: "invoice-task-a",
    campaignId: "invoice-campaign-a",
    mcuMicros: 5_000_000,
    reason: "bounded invoice work",
    createdAt: "2026-08-10T00:00:00.000Z",
  });
  settleUsageReservation(db, {
    id: "invoice-settlement-a",
    tenantId: "billing-tenant-a",
    idempotencyKey: "invoice-settle-a",
    reservationId: reservation.id,
    actualMcuMicros: 4_000_000,
    reason: "accepted invoice work",
    createdAt: "2026-08-10T00:01:00.000Z",
  });
}

function invoiceBody(overrides: Record<string, unknown> = {}) {
  return {
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-09-01T00:00:00.000Z",
    currency: "USD",
    contractReference: "invoice-contract-a",
    tax: {
      basisPoints: 0,
      jurisdiction: "US-IL",
      policyVersion: "tax-policy-zero-v1",
    },
    tenantId: "billing-tenant-b",
    actorPrincipalId: "attacker",
    chargeCustomer: true,
    ...overrides,
  };
}

function headers(token: string, requestId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Request-Id": requestId,
  };
}

function executionCostBody(overrides: Record<string, unknown> = {}) {
  return {
    executionId: "execution-a",
    taskId: "task-a",
    campaignId: "campaign-a",
    taskClass: "api-migration",
    route: "frontier-primary",
    attemptNumber: 1,
    retryNumber: 0,
    fallbackFromExecutionId: null,
    outcomeStatus: "unresolved",
    acceptedOutcomeId: null,
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheWriteTokens: 100,
    modelId: "model-a",
    modelPriceVersion: "model-price-v1",
    modelCostMoneyMicros: 1_000,
    cacheCostMoneyMicros: 100,
    gpuMillis: 500,
    gpuCostMoneyMicros: 200,
    graphCostMoneyMicros: 300,
    sandboxCostMoneyMicros: 400,
    verificationCostMoneyMicros: 500,
    modelCostMeasured: true,
    cacheCostMeasured: true,
    gpuCostMeasured: true,
    graphCostMeasured: true,
    sandboxCostMeasured: true,
    verificationCostMeasured: true,
    measurementProvenance: {
      model: "provider_invoice:model-a",
      cache: "provider_invoice:cache",
      gpu: "runtime_meter:gpu",
      graph: "runtime_meter:graph",
      sandbox: "runtime_meter:sandbox",
      verification: "runtime_meter:verification",
    },
    currency: "USD",
    createdAt: NOW,
    ...overrides,
  };
}

async function postCost(app: Hono<ApiEnv>, token: string, requestId: string, body: unknown) {
  return app.request("/billing/execution-costs", {
    method: "POST",
    headers: headers(token, requestId),
    body: JSON.stringify(body),
  });
}

function settleRevenue(
  db: AppDb,
  actorPrincipalId: string,
  taskId: string,
  campaignId: string,
) {
  createUsagePriceVersion(db, {
    id: "billing-price-a",
    tenantId: "billing-tenant-a",
    formulaVersion: "mcu-v1",
    currency: "USD",
    pricePerMcuMoneyMicros: 20_000,
    effectiveAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-09-01T00:00:00.000Z",
    contractReference: "contract-a",
    createdAt: NOW,
  });
  createUsageEntitlement(db, {
    id: "billing-entitlement-a",
    tenantId: "billing-tenant-a",
    priceVersionId: "billing-price-a",
    quotaMcuMicros: 20_000_000,
    features: ["warden"],
    contractReference: "contract-a",
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-09-01T00:00:00.000Z",
    createdAt: NOW,
  });
  const reservation = reserveUsage(db, {
    id: "billing-reservation-a",
    tenantId: "billing-tenant-a",
    idempotencyKey: "billing-reserve-a",
    taskId,
    campaignId,
    mcuMicros: 5_000_000,
    reason: "task ceiling",
    actorPrincipalId,
    createdAt: NOW,
  });
  settleUsageReservation(db, {
    id: "billing-settlement-a",
    tenantId: "billing-tenant-a",
    idempotencyKey: "billing-settle-a",
    reservationId: reservation.id,
    actualMcuMicros: 4_000_000,
    invoiceReference: "invoice-a",
    reason: "verified outcome",
    actorPrincipalId,
    createdAt: "2026-08-01T15:01:00.000Z",
  });
}

describe("billing economics API routes", () => {
  it("constructs a signer only from a complete exact protected authority binding", () => {
    const authority = JSON.stringify({
      schemaVersion: "invoice-export-authority/1",
      grants: [{
        tenantId: "tenant-a",
        actorPrincipalId: "user-a",
        currency: "USD",
        contractReference: "contract-a",
        taxBasisPoints: 625,
        taxJurisdiction: "US-IL",
        taxPolicyVersion: "tax-2026-08",
      }],
    });
    const signingKey = serializedSigningKey("invoice-key-1");
    const env = {
      MENDPOINT_INVOICE_EXPORT_SIGNING_KEY_ID: "invoice-key-1",
      MENDPOINT_INVOICE_EXPORT_SIGNING_KEYS_JSON: JSON.stringify({
        schemaVersion: "invoice-export-signing-keyring/2",
        keys: [signingKey],
      }),
      MENDPOINT_INVOICE_EXPORT_AUTHORITY_JSON: authority,
    };
    const signer = invoiceExportSignerFromEnv(env);
    expect(signer?.authorize({
      tenantId: "tenant-a",
      actorPrincipalId: "user-a",
      currency: "USD",
      contractReference: "contract-a",
      tax: { basisPoints: 625, jurisdiction: "US-IL", policyVersion: "tax-2026-08" },
    })).toBe(true);
    expect(signer?.authorize({
      tenantId: "tenant-b",
      actorPrincipalId: "user-a",
      currency: "USD",
      contractReference: "contract-a",
      tax: { basisPoints: 625, jurisdiction: "US-IL", policyVersion: "tax-2026-08" },
    })).toBe(false);
    const payload = "signed invoice payload";
    const signature = signer!.sign(payload);
    expect(signer?.verifyForKey("invoice-key-1", payload, signature)).toBe(true);
    expect(signer?.verifyForKey("invoice-key-1", `${payload}.`, signature)).toBe(false);
    expect(signer?.verifyForKey("invoice-key-missing", payload, signature)).toBe(false);
    expect(invoiceExportSignerFromEnv({
      ...env,
      MENDPOINT_INVOICE_EXPORT_SIGNING_KEYS_JSON: JSON.stringify({
        schemaVersion: "invoice-export-signing-keyring/2",
        keys: [{
          ...signingKey,
          privateKeyPkcs8Base64: "short",
        }],
      }),
    })).toBeUndefined();
    expect(invoiceExportSignerFromEnv({ ...env, MENDPOINT_INVOICE_EXPORT_AUTHORITY_JSON: "{}" })).toBeUndefined();
    expect(invoiceExportSignerFromEnv({
      ...env,
      MENDPOINT_INVOICE_EXPORT_AUTHORITY_JSON: authority.replace("tenant-a", " tenant-a"),
    })).toBeUndefined();
  });

  it("retains historical verification keys across signing-key rotation", async () => {
    const { db, tenantA } = fixture();
    seedInvoiceUsage(db);
    const bootstrap = await appFor(db).request("/billing/gross-margin", {
      headers: headers(tenantA, "invoice-key-rotation-bootstrap"),
    });
    expect(bootstrap.status).toBe(200);
    const principal = getPrincipalBySubject(
      db,
      "billing-tenant-a",
      "api_key",
      "billing-key-a",
    )!;
    const authority = JSON.stringify({
      schemaVersion: "invoice-export-authority/1",
      grants: [{
        tenantId: "billing-tenant-a",
        actorPrincipalId: principal.id,
        currency: "USD",
        contractReference: "invoice-contract-a",
        taxBasisPoints: 0,
        taxJurisdiction: "US-IL",
        taxPolicyVersion: "tax-policy-zero-v1",
      }],
    });
    const oldKey = serializedSigningKey("invoice-key-old");
    const newKey = serializedSigningKey("invoice-key-new");
    const signerFor = (
      keyId: string,
      keys: readonly (
        ReturnType<typeof serializedSigningKey> |
        ReturnType<typeof publicSigningKey>
      )[],
    ) =>
      invoiceExportSignerFromEnv({
        MENDPOINT_INVOICE_EXPORT_SIGNING_KEY_ID: keyId,
        MENDPOINT_INVOICE_EXPORT_SIGNING_KEYS_JSON: JSON.stringify({
          schemaVersion: "invoice-export-signing-keyring/2",
          keys,
        }),
        MENDPOINT_INVOICE_EXPORT_AUTHORITY_JSON: authority,
      });
    expect(signerFor("invoice-key-new", [oldKey, newKey])).toBeUndefined();
    const issuedApp = appFor(
      db,
      () => "2026-09-02T12:00:00.000Z",
      signerFor("invoice-key-old", [oldKey])!,
    );
    const created = await issuedApp.request("/billing/invoice-exports", {
      method: "POST",
      headers: headers(tenantA, "invoice-key-rotation"),
      body: JSON.stringify(invoiceBody()),
    });
    expect(created.status).toBe(201);
    const invoice = await created.json() as { data: { id: string } };

    const rotatedApp = appFor(
      db,
      () => "2026-09-03T00:00:00.000Z",
      signerFor("invoice-key-new", [
        publicSigningKey(oldKey),
        newKey,
      ])!,
    );
    const reconciliation = await rotatedApp.request(
      `/billing/invoice-exports/${invoice.data.id}/reconciliation`,
      { headers: headers(tenantA, "invoice-key-rotation-reconcile") },
    );
    expect(reconciliation.status).toBe(200);
    await expect(reconciliation.json()).resolves.toMatchObject({
      data: { complete: true, signature: { keyId: "invoice-key-old", ok: true } },
    });
  });
  it("requires authentication and forces tenant and actor from the authenticated principal", async () => {
    const { db, tenantA, tenantB } = fixture();
    const app = appFor(db);
    const unauthenticated = await app.request("/billing/execution-costs", {
      headers: { "X-Request-Id": "anonymous-list" },
    });
    expect(unauthenticated.status).toBe(401);

    const created = await postCost(app, tenantA, "cost-create-a", executionCostBody({
      id: "client-controlled-id",
      tenantId: "billing-tenant-b",
      actorPrincipalId: "principal-attacker",
      idempotencyKey: "client-controlled-key",
      createdAt: "2000-01-01T00:00:00.000Z",
    }));
    expect(created.status).toBe(201);
    const response = await created.json() as { data: Record<string, unknown> };
    expect(response.data).toMatchObject({
      executionId: "execution-a",
      totalCostMoneyMicros: 2_500,
      currency: "USD",
    });
    for (const privateField of [
      "tenantId",
      "actorPrincipalId",
      "idempotencyKey",
      "entrySequence",
      "previousHash",
      "entryHash",
    ]) {
      expect(response.data).not.toHaveProperty(privateField);
    }

    const stored = listActualExecutionCosts(db, "billing-tenant-a");
    const actor = getPrincipalBySubject(db, "billing-tenant-a", "api_key", "billing-key-a");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      tenantId: "billing-tenant-a",
      actorPrincipalId: actor?.id,
      idempotencyKey: "cost-create-a",
      createdAt: NOW,
    });
    expect(stored[0]?.id).not.toBe("client-controlled-id");
    expect(listActualExecutionCosts(db, "billing-tenant-b")).toEqual([]);

    const tenantBList = await app.request("/billing/execution-costs", {
      headers: { ...headers(tenantB, "cost-list-b"), "X-Tenant-Id": "billing-tenant-a" },
    });
    expect(tenantBList.status).toBe(200);
    await expect(tenantBList.json()).resolves.toEqual({ data: [], meta: { count: 0 } });
  });

  it("replays the same request ID exactly once and rejects changed replay input", async () => {
    const { db, tenantA } = fixture();
    let currentTime = NOW;
    const app = appFor(db, () => currentTime);
    const body = executionCostBody();
    const created = await postCost(app, tenantA, "stable-cost-request", body);
    expect(created.status).toBe(201);
    const createdBody = await created.json();

    currentTime = "2026-08-01T15:05:00.000Z";
    const replay = await postCost(app, tenantA, "stable-cost-request", body);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(createdBody);
    expect(listActualExecutionCosts(db, "billing-tenant-a")).toHaveLength(1);

    const conflict = await postCost(app, tenantA, "stable-cost-request", executionCostBody({
      modelCostMoneyMicros: 1_001,
    }));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "execution_cost_idempotency_conflict" },
    });
    expect(listActualExecutionCosts(db, "billing-tenant-a")).toHaveLength(1);
  });

  it("fails closed with a deterministic error for corrupt stored measurement provenance", async () => {
    const { db, tenantA } = fixture();
    const app = appFor(db);
    expect((await postCost(app, tenantA, "cost-corrupt-provenance", executionCostBody())).status)
      .toBe(201);
    db.raw.exec("DROP TRIGGER actual_execution_cost_entries_append_only_update");

    for (const corrupt of ["{", "[]", JSON.stringify({ model: 7 })]) {
      db.raw.prepare(
        "UPDATE actual_execution_cost_entries SET measurement_provenance_json = ? WHERE execution_id = ?",
      ).run(corrupt, "execution-a");
      const response = await app.request("/billing/execution-costs", {
        headers: headers(tenantA, `corrupt-provenance-${corrupt.length}`),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "execution_cost_ledger_integrity_invalid" },
      });
    }

    const margin = await app.request("/billing/gross-margin", {
      headers: headers(tenantA, "corrupt-provenance-margin"),
    });
    expect(margin.status).toBe(200);
    await expect(margin.json()).resolves.toMatchObject({
      data: {
        complete: false,
        ledgers: { executionCosts: { ok: false, checked: 0 } },
        exactGrossMarginMoneyMicros: null,
      },
    });
  });

  it("withdraws a public accepted outcome when newer durable authority supersedes it", async () => {
    const { db, tenantA } = fixture();
    const app = appFor(db);
    expect((await postCost(app, tenantA, "cost-stale-outcome", executionCostBody())).status)
      .toBe(201);
    const actor = getPrincipalBySubject(db, "billing-tenant-a", "api_key", "billing-key-a")!;
    const cost = listActualExecutionCosts(db, "billing-tenant-a")[0]!;
    const approvedContent = JSON.stringify({
      costEntryId: cost.id,
      costEntryHash: cost.entryHash,
      decision: "approve",
    });
    insertArtifactManifest(db, {
      id: "accepted-stale-outcome", tenantId: "billing-tenant-a", kind: "review-evidence",
      schemaVersion: 1, sha256: createHash("sha256").update(approvedContent).digest("hex"),
      mediaType: "application/json", sizeBytes: Buffer.byteLength(approvedContent),
      storageRef: "evidence://accepted-stale-outcome", content: approvedContent,
      producerPrincipalId: actor.id, createdAt: "2026-09-02T00:00:00.000Z",
    });
    insertReviewDecision(db, {
      id: "review-accepted-stale-outcome", tenantId: "billing-tenant-a",
      subjectType: "execution_cost", subjectId: cost.executionId,
      candidateArtifactId: "accepted-stale-outcome", reviewerPrincipalId: actor.id,
      decision: "approve", rationale: "Initial accepted authority",
      createdAt: "2026-09-02T00:00:00.000Z",
    });
    const accepted = await app.request(`/billing/execution-costs/${cost.executionId}/outcomes`, {
      method: "POST",
      headers: headers(tenantA, "accepted-stale-outcome"),
      body: JSON.stringify({ authorityEvidenceId: "review-accepted-stale-outcome" }),
    });
    expect(accepted.status).toBe(201);
    expect((await app.request("/billing/execution-costs", {
      headers: headers(tenantA, "list-accepted-current"),
    })).status).toBe(200);

    const rejectedContent = JSON.stringify({
      costEntryId: cost.id,
      costEntryHash: cost.entryHash,
      decision: "reject",
    });
    insertArtifactManifest(db, {
      id: "rejected-current-outcome", tenantId: "billing-tenant-a", kind: "review-evidence",
      schemaVersion: 1, sha256: createHash("sha256").update(rejectedContent).digest("hex"),
      mediaType: "application/json", sizeBytes: Buffer.byteLength(rejectedContent),
      storageRef: "evidence://rejected-current-outcome", content: rejectedContent,
      producerPrincipalId: actor.id, createdAt: "2026-09-02T00:01:00.000Z",
    });
    insertReviewDecision(db, {
      id: "review-rejected-current-outcome", tenantId: "billing-tenant-a",
      subjectType: "execution_cost", subjectId: cost.executionId,
      candidateArtifactId: "rejected-current-outcome", reviewerPrincipalId: actor.id,
      decision: "reject", rationale: "Supersede the accepted authority",
      createdAt: "2026-09-02T00:01:00.000Z",
    });
    const stale = await app.request("/billing/execution-costs", {
      headers: headers(tenantA, "list-accepted-stale"),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: "execution_cost_ledger_integrity_invalid" },
    });
  });

  it("requires purpose-bound service authority and explicit measurement evidence", async () => {
    const { db, tenantA, tenantB } = fixture();
    const app = appFor(db);

    const wildcardOnly = await postCost(
      app,
      tenantB,
      "wildcard-cannot-write-cost",
      executionCostBody(),
    );
    expect(wildcardOnly.status).toBe(403);

    const forgedAccepted = await postCost(
      app,
      tenantA,
      "accepted-requires-outcome-authority",
      executionCostBody({ outcomeStatus: "accepted", acceptedOutcomeId: "review-a" }),
    );
    expect(forgedAccepted.status).toBe(400);

    const missingObservation = await postCost(
      app,
      tenantA,
      "observation-flags-required",
      executionCostBody({ cacheCostMeasured: undefined }),
    );
    expect(missingObservation.status).toBe(400);

    const missingProvenance = await postCost(
      app,
      tenantA,
      "measurement-provenance-required",
      executionCostBody({ measurementProvenance: { model: "provider_invoice:model-a" } }),
    );
    expect(missingProvenance.status).toBe(400);
    expect(listActualExecutionCosts(db, "billing-tenant-a")).toEqual([]);
  });

  it("keeps margin fields closed when recognized revenue has no actual cost", async () => {
    const { db, tenantA, tenantB } = fixture();
    const app = appFor(db);
    await app.request("/billing/execution-costs", {
      headers: headers(tenantA, "initialize-principal-a"),
    });
    const actor = getPrincipalBySubject(db, "billing-tenant-a", "api_key", "billing-key-a");
    expect(actor).not.toBeNull();
    settleRevenue(db, actor!.id, "task-without-cost", "campaign-a");

    const margin = await app.request("/billing/gross-margin", {
      headers: headers(tenantA, "margin-a"),
    });
    expect(margin.status).toBe(200);
    const marginBody = await margin.json() as { data: Record<string, unknown> };
    expect(marginBody).toMatchObject({
      data: {
        complete: false,
        netRevenueMoneyMicros: 80_000,
        actualCostMoneyMicros: 0,
        exactGrossMarginMoneyMicros: null,
        attributedGrossMarginMoneyMicros: null,
        unattributedRevenueMoneyMicros: 80_000,
        incompleteAttributions: [
          { code: "accepted_outcome_missing", taskId: "task-without-cost" },
          { code: "actual_cost_missing", taskId: "task-without-cost" },
        ],
      },
    });
    expect(marginBody.data).not.toHaveProperty("tenantId");
    expect(JSON.stringify(marginBody)).not.toContain("sourceId");

    const tenantBMargin = await app.request("/billing/gross-margin", {
      headers: { ...headers(tenantB, "margin-b"), "X-Tenant-Id": "billing-tenant-a" },
    });
    expect(tenantBMargin.status).toBe(200);
    await expect(tenantBMargin.json()).resolves.toMatchObject({
      data: { netRevenueMoneyMicros: 0, actualCostMoneyMicros: 0 },
    });
  });

  it("creates, reads, transitions, and reconciles a public signed export without charging", async () => {
    const { db, tenantA, tenantB } = fixture();
    seedInvoiceUsage(db);
    const app = appFor(db, () => "2026-09-02T12:00:00.000Z", invoiceSigner());
    const created = await app.request("/billing/invoice-exports", {
      method: "POST",
      headers: headers(tenantA, "invoice-create-a"),
      body: JSON.stringify(invoiceBody()),
    });
    expect(created.status).toBe(201);
    const createdBody = await created.json() as { data: Record<string, unknown> };
    expect(createdBody.data).toMatchObject({
      currency: "USD",
      contractReference: "invoice-contract-a",
      subtotalMoneyMicros: 80_000,
      taxMoneyMicros: 0,
      totalMoneyMicros: 80_000,
      signingKeyId: "invoice-api-key-1",
      state: "issued",
    });
    for (const privateField of [
      "tenantId",
      "actorPrincipalId",
      "idempotencyKey",
      "canonicalPayload",
      "previousHash",
      "eventHash",
    ]) {
      expect(createdBody.data).not.toHaveProperty(privateField);
    }
    expect(createdBody.data).not.toHaveProperty("chargeCustomer");
    const lines = createdBody.data.lines as Array<Record<string, unknown>>;
    expect(lines[0]).not.toHaveProperty("usageEntryId");
    expect(lines[0]).not.toHaveProperty("usageEntryHash");

    const id = createdBody.data.id as string;
    const signedDocument = await app.request(`/billing/invoice-exports/${id}/signed-document`, {
      headers: headers(tenantA, "invoice-signed-document-a"),
    });
    expect(signedDocument.status).toBe(200);
    const signedBody = await signedDocument.json() as {
      data: {
        canonicalPayload: string;
        payloadDigest: string;
        signature: {
          algorithm: string;
          keyId: string;
          valueBase64: string;
          publicKeySpkiBase64: string;
        };
      };
    };
    expect(signedBody.data.signature.algorithm).toBe("ed25519");
    expect(createHash("sha256").update(signedBody.data.canonicalPayload).digest("hex"))
      .toBe(signedBody.data.payloadDigest);
    expect(verifyBytes(
      null,
      Buffer.from(signedBody.data.canonicalPayload, "utf8"),
      createPublicKey({
        key: Buffer.from(signedBody.data.signature.publicKeySpkiBase64, "base64"),
        format: "der",
        type: "spki",
      }),
      Buffer.from(signedBody.data.signature.valueBase64, "base64"),
    )).toBe(true);
    const tenantBRead = await app.request(`/billing/invoice-exports/${id}`, {
      headers: headers(tenantB, "invoice-read-b"),
    });
    expect(tenantBRead.status).toBe(404);
    const exported = await app.request(`/billing/invoice-exports/${id}/transitions`, {
      method: "POST",
      headers: headers(tenantA, "invoice-export-a"),
      body: JSON.stringify({
        state: "exported",
        policyVersion: "dunning-policy-v1",
        reason: "exported to approved finance channel",
        tenantId: "billing-tenant-b",
      }),
    });
    expect(exported.status).toBe(200);
    await expect(exported.json()).resolves.toMatchObject({ data: { state: "exported" } });
    const reconciliation = await app.request(`/billing/invoice-exports/${id}/reconciliation`, {
      headers: headers(tenantA, "invoice-reconcile-a"),
    });
    expect(reconciliation.status).toBe(200);
    await expect(reconciliation.json()).resolves.toMatchObject({
      data: { complete: true, issues: [] },
    });
    db.raw.exec("DROP TRIGGER invoice_export_state_events_append_only_update");
    db.raw.prepare(
      "UPDATE invoice_export_state_events SET authority_signature = ? WHERE invoice_id = ? AND sequence = 2",
    ).run("0".repeat(64), id);
    const corruptedRead = await app.request(`/billing/invoice-exports/${id}`, {
      headers: headers(tenantA, "invoice-corrupted-read"),
    });
    expect(corruptedRead.status).toBe(409);
    await expect(corruptedRead.json()).resolves.toMatchObject({
      error: { code: "invoice_export_reconciliation_incomplete" },
    });
    expect((await app.request("/billing/charges", {
      method: "POST",
      headers: headers(tenantA, "no-charge-path"),
    })).status).toBe(404);
  });

  it("replays identical invoice requests, rejects changed replay, and fails closed without signer", async () => {
    const { db, tenantA } = fixture();
    seedInvoiceUsage(db);
    let current = "2026-09-02T12:00:00.000Z";
    const app = appFor(db, () => current, invoiceSigner());
    const request = {
      method: "POST",
      headers: headers(tenantA, "invoice-replay-a"),
      body: JSON.stringify(invoiceBody()),
    };
    const first = await app.request("/billing/invoice-exports", request);
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    current = "2026-09-03T00:00:00.000Z";
    const replay = await app.request("/billing/invoice-exports", request);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(firstBody);
    const changed = await app.request("/billing/invoice-exports", {
      ...request,
      body: JSON.stringify(invoiceBody({
        tax: { basisPoints: 100, jurisdiction: "US-IL", policyVersion: "tax-policy-v2" },
      })),
    });
    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toMatchObject({
      error: { code: "invoice_export_idempotency_conflict" },
    });
    const duplicateSource = await app.request("/billing/invoice-exports", {
      method: "POST",
      headers: headers(tenantA, "invoice-second-request"),
      body: JSON.stringify(invoiceBody()),
    });
    expect(duplicateSource.status).toBe(409);
    await expect(duplicateSource.json()).resolves.toMatchObject({
      error: { code: "invoice_export_source_already_invoiced" },
    });

    const missingSignerApp = appFor(db, () => current);
    const missingSigner = await missingSignerApp.request("/billing/invoice-exports", {
      method: "POST",
      headers: headers(tenantA, "invoice-no-signer"),
      body: JSON.stringify(invoiceBody()),
    });
    expect(missingSigner.status).toBe(503);
    await expect(missingSigner.json()).resolves.toMatchObject({
      error: { code: "invoice_export_signer_required" },
    });
  });

  it("reconciles a settled job to its mission task through the exact execution ID", async () => {
    const { db, tenantA } = fixture();
    const app = appFor(db, () => "2026-09-02T00:00:00.000Z");
    await app.request("/billing/execution-costs", {
      headers: headers(tenantA, "initialize-mission-principal"),
    });
    const actor = getPrincipalBySubject(db, "billing-tenant-a", "api_key", "billing-key-a");
    expect(actor).not.toBeNull();
    settleRevenue(db, actor!.id, "job-production-a", "campaign-a");
    createMission(db, {
      id: "mission-production-a",
      tenantId: "billing-tenant-a",
      product: "fettler",
      triggerKind: "provider_change",
      objective: "Complete production work",
      ownerPrincipalId: actor!.id,
      eventId: "event-mission-production-a",
      idempotencyKey: "mission-production-a",
      correlationId: "job-production-a",
      createdAt: NOW,
    });
    enqueueJob(db, {
      id: "job-production-a",
      tenantId: "billing-tenant-a",
      type: "agent.run",
      payload: { missionId: "mission-production-a" },
      createdAt: NOW,
    });
    const missionTask = ensureMissionTaskForJob(db, {
      tenantId: "billing-tenant-a",
      jobId: "job-production-a",
      missionId: "mission-production-a",
      taskType: "agent.run",
      acceptanceCriteria: "Produce the verified result.",
      risk: "medium",
      actorPrincipalId: actor!.id,
      assignedPrincipalId: actor!.id,
      createdAt: NOW,
      correlationId: "job-production-a",
    });
    const body = executionCostBody({
      executionId: "job-production-a",
      taskId: missionTask.id,
      campaignId: "campaign-a",
    });
    const recordedCost = recordActualExecutionCost(db, {
      ...(body as Omit<Parameters<typeof recordActualExecutionCost>[1],
        "id" | "tenantId" | "idempotencyKey" | "actorPrincipalId" | "missionId">),
      id: "cost-production-a",
      tenantId: "billing-tenant-a",
      idempotencyKey: "cost-production-a",
      actorPrincipalId: actor!.id,
      missionId: "mission-production-a",
    });
    const evidenceContent = JSON.stringify({
      decision: "approve",
      executionId: "job-production-a",
      costEntryId: recordedCost.id,
      costEntryHash: recordedCost.entryHash,
    });
    insertArtifactManifest(db, {
      id: "pull-request-a", tenantId: "billing-tenant-a", kind: "review-evidence",
      schemaVersion: 1, sha256: createHash("sha256").update(evidenceContent).digest("hex"),
      mediaType: "application/json", sizeBytes: Buffer.byteLength(evidenceContent),
      storageRef: "evidence://pull-request-a", content: evidenceContent,
      producerPrincipalId: actor!.id, createdAt: "2026-09-02T00:00:00.000Z",
    });
    insertReviewDecision(db, {
      id: "review-production-a", tenantId: "billing-tenant-a",
      subjectType: "execution_cost", subjectId: "job-production-a",
      candidateArtifactId: "pull-request-a", reviewerPrincipalId: actor!.id,
      decision: "approve", rationale: "Approved durable production outcome",
      createdAt: "2026-09-02T00:00:00.000Z",
    });
    const accepted = await app.request("/billing/execution-costs/job-production-a/outcomes", {
      method: "POST",
      headers: headers(tenantA, "mission-outcome-a"),
      body: JSON.stringify({
        authorityEvidenceId: "review-production-a",
      }),
    });
    expect(accepted.status).toBe(201);
    const acceptedBody = await accepted.json();
    const acceptedReplay = await app.request("/billing/execution-costs/job-production-a/outcomes", {
      method: "POST",
      headers: headers(tenantA, "mission-outcome-a"),
      body: JSON.stringify({
        authorityEvidenceId: "review-production-a",
      }),
    });
    expect(acceptedReplay.status).toBe(201);
    await expect(acceptedReplay.json()).resolves.toEqual(acceptedBody);

    const costs = await app.request("/billing/execution-costs", {
      headers: headers(tenantA, "mission-cost-list"),
    });
    expect(costs.status).toBe(200);
    await expect(costs.json()).resolves.toMatchObject({
      data: [{
        executionId: "job-production-a",
        missionId: "mission-production-a",
        outcomeStatus: "accepted",
        acceptedOutcomeId: "pull-request-a",
        modelCostMeasured: true,
        cacheCostMeasured: true,
        gpuCostMeasured: true,
        graphCostMeasured: true,
        sandboxCostMeasured: true,
        verificationCostMeasured: true,
        measurementProvenance: {
          model: "provider_invoice:model-a",
          cache: "provider_invoice:cache",
          gpu: "runtime_meter:gpu",
          graph: "runtime_meter:graph",
          sandbox: "runtime_meter:sandbox",
          verification: "runtime_meter:verification",
        },
      }],
    });

    const margin = await app.request("/billing/gross-margin", {
      headers: headers(tenantA, "mission-margin"),
    });
    expect(margin.status).toBe(200);
    await expect(margin.json()).resolves.toMatchObject({
      data: {
        complete: true,
        ledgers: {
          executionCosts: { ok: true, checked: 1 },
        },
        netRevenueMoneyMicros: 80_000,
        actualCostMoneyMicros: 2_500,
        exactGrossMarginMoneyMicros: 77_500,
        attributedGrossMarginMoneyMicros: 77_500,
        unattributedRevenueMoneyMicros: 0,
        incompleteAttributions: [],
        attributions: [
          {
            executionId: "job-production-a",
            taskId: missionTaskIdForJob("job-production-a"),
            campaignId: "campaign-a",
            route: "frontier-primary",
            outcomeStatus: "accepted",
            acceptedOutcomeId: "pull-request-a",
            attributedNetRevenueMoneyMicros: 80_000,
            attributedGrossMarginMoneyMicros: 77_500,
          },
        ],
      },
    });

    const rollback = appendDomainEvent(db, {
      id: "rollback-production-a",
      tenantId: "billing-tenant-a",
      schemaVersion: 1,
      eventType: "execution_cost.rolled_back",
      aggregateType: "execution_cost",
      aggregateId: "job-production-a",
      actorPrincipalId: actor!.id,
      correlationId: "job-production-a",
      idempotencyKey: "rollback-production-a",
      payload: {
        costEntryId: recordedCost.id,
        costEntryHash: recordedCost.entryHash,
      },
      createdAt: "2026-09-02T00:01:00.000Z",
    });
    const rolledBack = await app.request("/billing/execution-costs/job-production-a/outcomes", {
      method: "POST",
      headers: headers(tenantA, "mission-outcome-rollback"),
      body: JSON.stringify({ authorityEvidenceId: rollback.row.id }),
    });
    expect(rolledBack.status).toBe(201);
    await expect(rolledBack.json()).resolves.toMatchObject({
      data: { outcomeStatus: "rolled_back", acceptedOutcomeId: null },
    });
    const rolledBackCosts = await app.request("/billing/execution-costs", {
      headers: headers(tenantA, "mission-cost-list-rolled-back"),
    });
    await expect(rolledBackCosts.json()).resolves.toMatchObject({
      data: [{
        executionId: "job-production-a",
        outcomeStatus: "rolled_back",
        acceptedOutcomeId: null,
      }],
    });

    const originalReplayAfterRollback = await app.request(
      "/billing/execution-costs/job-production-a/outcomes",
      {
        method: "POST",
        headers: headers(tenantA, "mission-outcome-a"),
        body: JSON.stringify({ authorityEvidenceId: "review-production-a" }),
      },
    );
    expect(originalReplayAfterRollback.status).toBe(201);
    await expect(originalReplayAfterRollback.json()).resolves.toEqual(acceptedBody);

    db.raw.exec("DROP TRIGGER actual_execution_cost_outcomes_append_only_update");
    db.raw.prepare(
      "UPDATE actual_execution_cost_outcomes SET authority_digest = ? WHERE execution_id = ?",
    ).run("f".repeat(64), "job-production-a");
    const corruptMargin = await app.request("/billing/gross-margin", {
      headers: headers(tenantA, "mission-margin-corrupt-outcome"),
    });
    expect(corruptMargin.status).toBe(200);
    await expect(corruptMargin.json()).resolves.toMatchObject({
      data: {
        complete: false,
        ledgers: {
          executionCosts: { ok: false, checked: 1 },
        },
      },
    });
  });
});
