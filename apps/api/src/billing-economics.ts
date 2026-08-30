import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";
import {
  createInvoiceExport,
  getInvoiceExport,
  listActualExecutionCosts,
  reconcileInvoiceExport,
  reconcileGrossMargin,
  recordActualExecutionCost,
  transitionInvoiceExportState,
  type ActualExecutionCostEntry,
  type ActualExecutionCostInput,
  type AppDb,
  type GrossMarginReconciliation,
  type InvoiceExport,
  type InvoiceExportSigner,
  type InvoiceExportState,
} from "@mendpoint/db";
import { Hono, type Context, type Next } from "hono";
import type { ApiEnv } from "./auth.js";

export type BillingEconomicsRouteDeps = Readonly<{
  db: AppDb;
  now?: () => string;
  invoiceSigner?: InvoiceExportSigner;
}>;

type InvoiceExportAuthorityGrant = Readonly<{
  tenantId: string;
  actorPrincipalId: string;
  currency: string;
  contractReference: string;
  taxBasisPoints: number;
  taxJurisdiction: string;
  taxPolicyVersion: string;
}>;

const INVOICE_EXPORT_AUTHORITY_SCHEMA = "invoice-export-authority/1" as const;
const INVOICE_EXPORT_KEYRING_SCHEMA = "invoice-export-signing-keyring/2" as const;

type InvoiceSigningKey = Readonly<{
  privateKey: KeyObject;
  publicKey: KeyObject;
  publicKeySpkiBase64: string;
}>;

function invoiceExportSigningKeys(value: string): ReadonlyMap<string, InvoiceSigningKey> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== INVOICE_EXPORT_KEYRING_SCHEMA || !Array.isArray(record.keys)) return null;
    if (Object.keys(record).sort().join(",") !== "keys,schemaVersion") return null;
    const keys = new Map<string, InvoiceSigningKey>();
    for (const valueKey of record.keys) {
      if (!valueKey || typeof valueKey !== "object" || Array.isArray(valueKey)) return null;
      const keyRecord = valueKey as Record<string, unknown>;
      if (Object.keys(keyRecord).sort().join(",") !==
          "keyId,privateKeyPkcs8Base64,publicKeySpkiBase64") return null;
      if (
        typeof keyRecord.keyId !== "string" ||
        !keyRecord.keyId ||
        keyRecord.keyId.trim() !== keyRecord.keyId ||
        keyRecord.keyId.length > 200 ||
        typeof keyRecord.privateKeyPkcs8Base64 !== "string" ||
        typeof keyRecord.publicKeySpkiBase64 !== "string"
      ) return null;
      const privateDer = Buffer.from(keyRecord.privateKeyPkcs8Base64, "base64");
      const publicDer = Buffer.from(keyRecord.publicKeySpkiBase64, "base64");
      if (
        privateDer.toString("base64") !== keyRecord.privateKeyPkcs8Base64 ||
        publicDer.toString("base64") !== keyRecord.publicKeySpkiBase64 ||
        keys.has(keyRecord.keyId)
      ) {
        return null;
      }
      const privateKey = createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
      const publicKey = createPublicKey({ key: publicDer, format: "der", type: "spki" });
      if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519") {
        return null;
      }
      const derivedPublic = createPublicKey(privateKey).export({ format: "der", type: "spki" });
      if (!Buffer.from(derivedPublic).equals(publicDer)) return null;
      keys.set(keyRecord.keyId, Object.freeze({
        privateKey,
        publicKey,
        publicKeySpkiBase64: keyRecord.publicKeySpkiBase64,
      }));
    }
    return keys.size > 0 ? keys : null;
  } catch {
    return null;
  }
}

function invoiceExportAuthorityGrants(value: string): readonly InvoiceExportAuthorityGrant[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== INVOICE_EXPORT_AUTHORITY_SCHEMA || !Array.isArray(record.grants)) return null;
    if (Object.keys(record).sort().join(",") !== "grants,schemaVersion") return null;
    const grants: InvoiceExportAuthorityGrant[] = [];
    for (const valueGrant of record.grants) {
      if (!valueGrant || typeof valueGrant !== "object" || Array.isArray(valueGrant)) return null;
      const grant = valueGrant as Record<string, unknown>;
      if (Object.keys(grant).sort().join(",") !==
          "actorPrincipalId,contractReference,currency,taxBasisPoints,taxJurisdiction,taxPolicyVersion,tenantId") return null;
      if (
        typeof grant.tenantId !== "string" || grant.tenantId.trim() !== grant.tenantId || !grant.tenantId ||
        typeof grant.actorPrincipalId !== "string" || grant.actorPrincipalId.trim() !== grant.actorPrincipalId || !grant.actorPrincipalId ||
        typeof grant.currency !== "string" || !/^[A-Z]{3}$/u.test(grant.currency) ||
        typeof grant.contractReference !== "string" || grant.contractReference.trim() !== grant.contractReference || !grant.contractReference ||
        !Number.isSafeInteger(grant.taxBasisPoints) || (grant.taxBasisPoints as number) < 0 || (grant.taxBasisPoints as number) > 10_000 ||
        typeof grant.taxJurisdiction !== "string" || grant.taxJurisdiction.trim() !== grant.taxJurisdiction || !grant.taxJurisdiction ||
        typeof grant.taxPolicyVersion !== "string" || grant.taxPolicyVersion.trim() !== grant.taxPolicyVersion || !grant.taxPolicyVersion
      ) return null;
      grants.push(Object.freeze({
        tenantId: grant.tenantId,
        actorPrincipalId: grant.actorPrincipalId,
        currency: grant.currency,
        contractReference: grant.contractReference,
        taxBasisPoints: grant.taxBasisPoints,
        taxJurisdiction: grant.taxJurisdiction,
        taxPolicyVersion: grant.taxPolicyVersion,
      }) as InvoiceExportAuthorityGrant);
    }
    return grants.length > 0 ? Object.freeze(grants) : null;
  } catch {
    return null;
  }
}

export function invoiceExportSignerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): InvoiceExportSigner | undefined {
  const keyId = env.MENDPOINT_INVOICE_EXPORT_SIGNING_KEY_ID?.trim();
  const keyringJson = env.MENDPOINT_INVOICE_EXPORT_SIGNING_KEYS_JSON?.trim();
  const authorityJson = env.MENDPOINT_INVOICE_EXPORT_AUTHORITY_JSON?.trim();
  if (!keyId || !keyringJson || !authorityJson || keyId.length > 200) return undefined;
  const keys = invoiceExportSigningKeys(keyringJson);
  const currentKey = keys?.get(keyId);
  if (!keys || !currentKey) return undefined;
  const grants = invoiceExportAuthorityGrants(authorityJson);
  if (!grants) return undefined;
  return Object.freeze({
    keyId,
    authorize: (input) => grants.some((grant) =>
      grant.tenantId === input.tenantId &&
      grant.actorPrincipalId === input.actorPrincipalId &&
      grant.currency === input.currency &&
      grant.contractReference === input.contractReference &&
      grant.taxBasisPoints === input.tax.basisPoints &&
      grant.taxJurisdiction === input.tax.jurisdiction &&
      grant.taxPolicyVersion === input.tax.policyVersion),
    sign: (payload) => signBytes(null, Buffer.from(payload, "utf8"), currentKey.privateKey).toString("base64"),
    verifyForKey: (verificationKeyId, payload, signature) => {
      const verificationKey = keys.get(verificationKeyId);
      if (!verificationKey) return false;
      const supplied = Buffer.from(signature, "base64");
      if (supplied.length === 0 || supplied.toString("base64") !== signature) return false;
      return verifyBytes(null, Buffer.from(payload, "utf8"), verificationKey.publicKey, supplied);
    },
    verificationMaterialForKey: (verificationKeyId) => {
      const verificationKey = keys.get(verificationKeyId);
      return verificationKey
        ? Object.freeze({
          algorithm: "ed25519" as const,
          publicKeySpkiBase64: verificationKey.publicKeySpkiBase64,
        })
        : null;
    },
  });
}

type JsonRecord = Record<string, unknown>;

function errorResponse(
  c: Context<ApiEnv>,
  code: string,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 503,
) {
  return c.json({ error: { code, message } }, status);
}

function invoiceId(tenantId: string, idempotencyKey: string): string {
  return `invoice-export-${createHash("sha256")
    .update(`${tenantId}\n${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function publicInvoice(invoice: InvoiceExport) {
  return {
    id: invoice.id,
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    currency: invoice.currency,
    contractReference: invoice.contractReference,
    tax: invoice.tax,
    subtotalMoneyMicros: invoice.subtotalMoneyMicros,
    taxMoneyMicros: invoice.taxMoneyMicros,
    totalMoneyMicros: invoice.totalMoneyMicros,
    payloadDigest: invoice.payloadDigest,
    signingKeyId: invoice.signingKeyId,
    signature: invoice.signature,
    state: invoice.state,
    issuedAt: invoice.issuedAt,
    lines: invoice.lines.map((line) => ({
      kind: line.kind,
      taskId: line.taskId,
      campaignId: line.campaignId,
      priceVersionId: line.priceVersionId,
      formulaVersion: line.formulaVersion,
      contractReference: line.contractReference,
      currency: line.currency,
      mcuMicros: line.mcuMicros,
      moneyMicros: line.moneyMicros,
      reason: line.reason,
    })),
    stateHistory: invoice.stateHistory.map((event) => ({
      state: event.state,
      policyVersion: event.policyVersion,
      reason: event.reason,
      occurredAt: event.occurredAt,
    })),
  };
}

function authenticatedPrincipal(c: Context<ApiEnv>) {
  const principal = c.get("principal");
  const actorPrincipalId = c.get("trustPrincipalId");
  if (!principal || !actorPrincipalId) return null;
  return { tenantId: principal.tenantId, actorPrincipalId };
}

async function requireAuthenticatedPrincipal(c: Context<ApiEnv>, next: Next) {
  if (!authenticatedPrincipal(c)) {
    return errorResponse(c, "unauthorized", "Authentication is required", 401);
  }
  return next();
}

function requestId(c: Context<ApiEnv>): string | null {
  const value = c.get("requestId")?.trim();
  return value && value.length <= 200 ? value : null;
}

function recordId(tenantId: string, idempotencyKey: string): string {
  return `execution-cost-${createHash("sha256")
    .update(`${tenantId}\n${idempotencyKey}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function publicExecutionCost(entry: ActualExecutionCostEntry) {
  return {
    id: entry.id,
    executionId: entry.executionId,
    taskId: entry.taskId,
    campaignId: entry.campaignId,
    taskClass: entry.taskClass,
    route: entry.route,
    attemptNumber: entry.attemptNumber,
    retryNumber: entry.retryNumber,
    fallbackFromExecutionId: entry.fallbackFromExecutionId,
    outcomeStatus: entry.outcomeStatus,
    acceptedOutcomeId: entry.acceptedOutcomeId,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens,
    cacheWriteTokens: entry.cacheWriteTokens,
    modelId: entry.modelId,
    modelPriceVersion: entry.modelPriceVersion,
    modelCostMoneyMicros: entry.modelCostMoneyMicros,
    cacheCostMoneyMicros: entry.cacheCostMoneyMicros,
    gpuMillis: entry.gpuMillis,
    gpuCostMoneyMicros: entry.gpuCostMoneyMicros,
    graphCostMoneyMicros: entry.graphCostMoneyMicros,
    sandboxCostMoneyMicros: entry.sandboxCostMoneyMicros,
    verificationCostMoneyMicros: entry.verificationCostMoneyMicros,
    totalCostMoneyMicros: entry.totalCostMoneyMicros,
    currency: entry.currency,
    createdAt: entry.createdAt,
  };
}

function publicGrossMargin(report: GrossMarginReconciliation) {
  return {
    complete: report.complete,
    currency: report.currency,
    ledgers: {
      usage: { ok: report.usageIntegrity.ok, checked: report.usageIntegrity.checked },
      executionCosts: { ok: report.costIntegrity.ok, checked: report.costIntegrity.checked },
    },
    settledMcuMicros: report.settledMcuMicros,
    creditedMcuMicros: report.creditedMcuMicros,
    adjustedMcuMicros: report.adjustedMcuMicros,
    settledRevenueMoneyMicros: report.settledRevenueMoneyMicros,
    creditMoneyMicros: report.creditMoneyMicros,
    adjustmentMoneyMicros: report.adjustmentMoneyMicros,
    netRevenueMoneyMicros: report.netRevenueMoneyMicros,
    actualCostMoneyMicros: report.actualCostMoneyMicros,
    modelCostMoneyMicros: report.modelCostMoneyMicros,
    cacheCostMoneyMicros: report.cacheCostMoneyMicros,
    gpuCostMoneyMicros: report.gpuCostMoneyMicros,
    graphCostMoneyMicros: report.graphCostMoneyMicros,
    sandboxCostMoneyMicros: report.sandboxCostMoneyMicros,
    verificationCostMoneyMicros: report.verificationCostMoneyMicros,
    exactGrossMarginMoneyMicros: report.exactGrossMarginMoneyMicros,
    attributedGrossMarginMoneyMicros: report.attributedGrossMarginMoneyMicros,
    unattributedRevenueMoneyMicros: report.unattributedRevenueMoneyMicros,
    incompleteAttributions: report.incompleteAttributions.map(({ code, taskId }) => ({ code, taskId })),
    attributions: report.attributions.map(({ tenantId: _tenantId, ...attribution }) => attribution),
  };
}

function executionCostInput(
  body: JsonRecord,
  identity: { tenantId: string; actorPrincipalId: string },
  idempotencyKey: string,
  createdAt: string,
): ActualExecutionCostInput {
  return {
    id: recordId(identity.tenantId, idempotencyKey),
    tenantId: identity.tenantId,
    idempotencyKey,
    executionId: body.executionId as string,
    taskId: body.taskId as string,
    campaignId: body.campaignId as string | null | undefined,
    taskClass: body.taskClass as string,
    route: body.route as string,
    attemptNumber: body.attemptNumber as number,
    retryNumber: body.retryNumber as number,
    fallbackFromExecutionId: body.fallbackFromExecutionId as string | null | undefined,
    outcomeStatus: body.outcomeStatus as ActualExecutionCostInput["outcomeStatus"],
    acceptedOutcomeId: body.acceptedOutcomeId as string | null | undefined,
    inputTokens: body.inputTokens as number,
    outputTokens: body.outputTokens as number,
    cacheReadTokens: body.cacheReadTokens as number,
    cacheWriteTokens: body.cacheWriteTokens as number,
    modelId: body.modelId as string,
    modelPriceVersion: body.modelPriceVersion as string,
    modelCostMoneyMicros: body.modelCostMoneyMicros as number,
    cacheCostMoneyMicros: body.cacheCostMoneyMicros as number,
    gpuMillis: body.gpuMillis as number,
    gpuCostMoneyMicros: body.gpuCostMoneyMicros as number,
    graphCostMoneyMicros: body.graphCostMoneyMicros as number,
    sandboxCostMoneyMicros: body.sandboxCostMoneyMicros as number,
    verificationCostMoneyMicros: body.verificationCostMoneyMicros as number,
    currency: body.currency as string,
    actorPrincipalId: identity.actorPrincipalId,
    createdAt,
  };
}

function handleRecordError(c: Context<ApiEnv>, error: unknown) {
  const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
    ? error.message
    : "execution_cost_request_invalid";
  if (code === "execution_cost_idempotency_conflict" || code === "execution_cost_execution_conflict") {
    return errorResponse(c, code, "The request conflicts with an existing execution cost", 409);
  }
  if (code === "execution_cost_actor_tenant_mismatch") {
    return errorResponse(c, code, "The authenticated principal cannot record this execution cost", 403);
  }
  return errorResponse(c, code, "The execution cost request is invalid", 400);
}

function handleInvoiceError(c: Context<ApiEnv>, error: unknown) {
  const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
    ? error.message
    : "invoice_export_request_invalid";
  if (code === "invoice_export_not_found") {
    return errorResponse(c, code, "The invoice export was not found", 404);
  }
  if (code === "invoice_export_signer_required" ||
      code === "invoice_export_state_authority_required" ||
      code === "invoice_export_verification_material_unavailable") {
    return errorResponse(c, code, "Invoice signing authority is unavailable", 503);
  }
  if (code === "invoice_export_actor_tenant_mismatch" ||
      code === "invoice_export_actor_inactive" ||
      code === "invoice_export_signing_not_authorized" ||
      code === "invoice_export_state_not_authorized") {
    return errorResponse(c, code, "The authenticated principal is not authorized", 403);
  }
  if (code.includes("conflict") || code === "invoice_export_id_tenant_mismatch" ||
      code === "invoice_export_state_transition_invalid" ||
      code === "invoice_export_source_already_invoiced" ||
      code === "invoice_export_reconciliation_incomplete") {
    return errorResponse(c, code, "The request conflicts with the invoice export", 409);
  }
  return errorResponse(c, code, "The invoice export request is invalid", 400);
}

export function createBillingEconomicsRoutes({
  db,
  now = () => new Date().toISOString(),
  invoiceSigner,
}: BillingEconomicsRouteDeps) {
  const routes = new Hono<ApiEnv>({ strict: false });
  routes.use("*", requireAuthenticatedPrincipal);

  routes.post("/execution-costs", async (c) => {
    const identity = authenticatedPrincipal(c)!;
    const idempotencyKey = requestId(c);
    if (!idempotencyKey) {
      return errorResponse(c, "request_id_invalid", "A valid request ID is required", 400);
    }
    try {
      const body = await c.req.json<unknown>();
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return errorResponse(c, "execution_cost_request_invalid", "The execution cost request is invalid", 400);
      }
      const entry = recordActualExecutionCost(
        db,
        executionCostInput(
          body as JsonRecord,
          identity,
          idempotencyKey,
          now(),
        ),
      );
      return c.json({ data: publicExecutionCost(entry) }, 201);
    } catch (error) {
      return handleRecordError(c, error);
    }
  });

  routes.get("/execution-costs", (c) => {
    const identity = authenticatedPrincipal(c)!;
    const requestedLimit = c.req.query("limit");
    const limit = requestedLimit === undefined ? 500 : Number(requestedLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
      return errorResponse(c, "execution_cost_limit_invalid", "Limit must be an integer from 1 to 5000", 400);
    }
    const records = listActualExecutionCosts(db, identity.tenantId, limit).map(publicExecutionCost);
    return c.json({ data: records, meta: { count: records.length } });
  });

  routes.get("/gross-margin", (c) => {
    const identity = authenticatedPrincipal(c)!;
    return c.json({ data: publicGrossMargin(reconcileGrossMargin(db, identity.tenantId)) });
  });

  routes.post("/invoice-exports", async (c) => {
    const identity = authenticatedPrincipal(c)!;
    const idempotencyKey = requestId(c);
    if (!idempotencyKey) {
      return errorResponse(c, "request_id_invalid", "A valid request ID is required", 400);
    }
    try {
      const body = await c.req.json<unknown>();
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return errorResponse(c, "invoice_export_request_invalid", "The invoice export request is invalid", 400);
      }
      const request = body as JsonRecord;
      const tax = request.tax;
      if (!tax || typeof tax !== "object" || Array.isArray(tax)) {
        return errorResponse(c, "invoice_export_tax_required", "Explicit tax policy is required", 400);
      }
      const taxRecord = tax as JsonRecord;
      const invoice = createInvoiceExport(db, {
        id: invoiceId(identity.tenantId, idempotencyKey),
        tenantId: identity.tenantId,
        idempotencyKey,
        periodStart: request.periodStart as string,
        periodEnd: request.periodEnd as string,
        currency: request.currency as string,
        contractReference: request.contractReference as string,
        tax: {
          basisPoints: taxRecord.basisPoints as number,
          jurisdiction: taxRecord.jurisdiction as string,
          policyVersion: taxRecord.policyVersion as string,
        },
        actorPrincipalId: identity.actorPrincipalId,
        issuedAt: now(),
        signer: invoiceSigner,
      });
      return c.json({ data: publicInvoice(invoice) }, 201);
    } catch (error) {
      return handleInvoiceError(c, error);
    }
  });

  routes.get("/invoice-exports/:id", (c) => {
    const identity = authenticatedPrincipal(c)!;
    try {
      const invoice = getInvoiceExport(db, identity.tenantId, c.req.param("id"));
      if (!invoice) return errorResponse(c, "invoice_export_not_found", "The invoice export was not found", 404);
      if (!reconcileInvoiceExport(db, identity.tenantId, invoice.id, invoiceSigner).complete) {
        return errorResponse(
          c,
          "invoice_export_reconciliation_incomplete",
          "The invoice export failed integrity reconciliation",
          409,
        );
      }
      return c.json({ data: publicInvoice(invoice) });
    } catch (error) {
      return handleInvoiceError(c, error);
    }
  });

  routes.get("/invoice-exports/:id/signed-document", (c) => {
    const identity = authenticatedPrincipal(c)!;
    try {
      const invoice = getInvoiceExport(db, identity.tenantId, c.req.param("id"));
      if (!invoice) return errorResponse(c, "invoice_export_not_found", "The invoice export was not found", 404);
      if (!reconcileInvoiceExport(db, identity.tenantId, invoice.id, invoiceSigner).complete) {
        return errorResponse(
          c,
          "invoice_export_reconciliation_incomplete",
          "The invoice export failed integrity reconciliation",
          409,
        );
      }
      const verification = invoiceSigner?.verificationMaterialForKey?.(invoice.signingKeyId);
      if (!verification) {
        return errorResponse(
          c,
          "invoice_export_verification_material_unavailable",
          "Invoice verification material is unavailable",
          503,
        );
      }
      return c.json({
        data: {
          schemaVersion: "invoice-export-signed-document/1",
          invoiceId: invoice.id,
          canonicalPayload: invoice.canonicalPayload,
          payloadDigest: invoice.payloadDigest,
          signature: {
            algorithm: verification.algorithm,
            keyId: invoice.signingKeyId,
            valueBase64: invoice.signature,
            publicKeySpkiBase64: verification.publicKeySpkiBase64,
          },
        },
      });
    } catch (error) {
      return handleInvoiceError(c, error);
    }
  });

  routes.post("/invoice-exports/:id/transitions", async (c) => {
    const identity = authenticatedPrincipal(c)!;
    const idempotencyKey = requestId(c);
    if (!idempotencyKey) {
      return errorResponse(c, "request_id_invalid", "A valid request ID is required", 400);
    }
    try {
      const body = await c.req.json<unknown>();
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return errorResponse(c, "invoice_export_request_invalid", "The invoice export request is invalid", 400);
      }
      const invoice = transitionInvoiceExportState(db, {
        tenantId: identity.tenantId,
        invoiceId: c.req.param("id"),
        idempotencyKey,
        state: (body as JsonRecord).state as InvoiceExportState,
        policyVersion: (body as JsonRecord).policyVersion as string,
        reason: (body as JsonRecord).reason as string,
        actorPrincipalId: identity.actorPrincipalId,
        occurredAt: now(),
        authority: invoiceSigner,
      });
      return c.json({ data: publicInvoice(invoice) });
    } catch (error) {
      return handleInvoiceError(c, error);
    }
  });

  routes.get("/invoice-exports/:id/reconciliation", (c) => {
    const identity = authenticatedPrincipal(c)!;
    try {
      const reconciliation = reconcileInvoiceExport(
        db,
        identity.tenantId,
        c.req.param("id"),
        invoiceSigner,
      );
      return c.json({ data: reconciliation });
    } catch (error) {
      return handleInvoiceError(c, error);
    }
  });

  return routes;
}
