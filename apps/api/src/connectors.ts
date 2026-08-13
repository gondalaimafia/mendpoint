/**
 * Self-serve connectors surface (S3-connectors).
 *
 * Tenant-scoped, flag-gated CRUD for CI/CD, ticketing, and documentation
 * connectors. The whole router is inert (404) unless MENDPOINT_SELF_SERVE_WARDEN=1
 * (the single self-serve flag, imported from ./self-serve-scan.js — never a
 * second copy), so default behavior stays byte-identical when the flag is off.
 *
 * Credential handling: a submitted secret token is sealed with the existing
 * AES-256-GCM envelope (`@mendpoint/connectors` ConnectorCredentialVault, which
 * wraps `packages/platform/src/vault-envelope.ts`) and stored as ciphertext in
 * `connectors.credential_envelope`. Plaintext is never persisted and never
 * logged. Verification opens the sealed token tenant-scoped, builds the connector
 * in its declared mode, and runs `verifyConnection()`; failures fail closed with
 * an actionable message.
 */
import {
  getConnector,
  listConnectors,
  registerConnector,
  revokeConnector,
  setConnectorHealth,
  type AppDb,
  type ConnectorRow,
} from "@mendpoint/db";
import {
  CONNECTOR_CATALOG,
  ConnectorCredentialVault,
  catalogEntry,
  connectorCredentialVaultFromEnv,
  createCiConnector,
  createDocsConnector,
  createTicketingConnector,
  defaultConnectorFetch,
  explainConnectorError,
  type CiProvider,
  type Connector,
  type ConnectorKind,
  type ConnectorMode,
  type DocsProvider,
  type SealedCredential,
  type TicketingProvider,
} from "@mendpoint/connectors";
import { newId, nowIso } from "@mendpoint/shared";
import { Hono, type Context } from "hono";
import type { ApiEnv } from "./auth.js";

const KINDS = new Set<ConnectorKind>(["ci", "ticketing", "docs"]);
const DISPLAY_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,99}$/;

export type ConnectorsRoutesOptions = Readonly<{
  db: AppDb;
  enabled: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  /** Test injection; defaults to the env-derived envelope vault. */
  credentialVault?: ConnectorCredentialVault;
}>;

type StoredConnectorConfig = {
  email?: string;
  apiBaseUrl?: string;
  project?: string;
  ref?: string;
};

function connectorTenantId(c: Context<ApiEnv>): string {
  const principal = c.get("principal");
  if (!principal) throw new Error("authenticated_principal_required");
  // A blank tenantId must never reach a tenant-scoped query where a fail-open
  // branch could drop the filter and read across tenants. Fail closed instead.
  if (principal.tenantId.trim() === "") throw new Error("tenant_scope_required");
  return principal.tenantId;
}

function publicConnector(row: ConnectorRow) {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    displayName: row.display_name,
    mode: row.mode,
    credentialConfigured: Boolean(row.credential_envelope),
    healthStatus: row.health_status,
    verified: Boolean(row.verified),
    available: Boolean(row.verified) && !row.revoked_at,
    errorCode: row.error_code,
    errorHint: row.error_code ? explainConnectorError(row.error_code) : null,
    lastVerifiedAt: row.last_verified_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Build the in-memory connector for a stored row + opened credential. */
function buildConnector(
  row: ConnectorRow,
  token: string | undefined,
): Connector {
  const config = JSON.parse(row.config_json || "{}") as StoredConnectorConfig;
  const common = { mode: row.mode, token, fetch: defaultConnectorFetch };
  if (row.kind === "ci") {
    return createCiConnector({
      provider: row.provider as CiProvider,
      apiBaseUrl: config.apiBaseUrl,
      ...common,
    });
  }
  if (row.kind === "ticketing") {
    return createTicketingConnector({
      provider: row.provider as TicketingProvider,
      email: config.email,
      apiBaseUrl: config.apiBaseUrl,
      project: config.project,
      ...common,
    });
  }
  return createDocsConnector({
    provider: row.provider as DocsProvider,
    email: config.email,
    apiBaseUrl: config.apiBaseUrl,
    ref: config.ref,
    ...common,
  });
}

function parseMode(value: unknown): ConnectorMode {
  return value === "real" ? "real" : "mock";
}

function nonSecretConfig(input: Record<string, unknown>): StoredConnectorConfig {
  const config: StoredConnectorConfig = {};
  for (const key of ["email", "apiBaseUrl", "project", "ref"] as const) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") config[key] = value.trim();
  }
  return config;
}

export function createConnectorsRoutes(options: ConnectorsRoutesOptions): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  if (!options.enabled) {
    routes.all("*", (c) => c.json({ error: "not_found" }, 404));
    return routes;
  }
  const env = options.env ?? process.env;
  const now = options.now ?? nowIso;
  const { db } = options;
  const vault = options.credentialVault ?? connectorCredentialVaultFromEnv(env);

  // The connector catalog drives the guided-setup UI.
  routes.get("/catalog", (c) => c.json({ families: CONNECTOR_CATALOG }));

  // List the tenant's own connectors (never another tenant's).
  routes.get("/", (c) => {
    let tenantId: string;
    try {
      tenantId = connectorTenantId(c);
    } catch (error) {
      return authError(c, error);
    }
    return c.json({ connectors: listConnectors(db, tenantId).map(publicConnector) });
  });

  // Connect: register a connector (default mock), sealing any submitted secret.
  routes.post("/", async (c) => {
    let tenantId: string;
    try {
      tenantId = connectorTenantId(c);
    } catch (error) {
      return authError(c, error);
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "connector_payload_invalid" }, 400);
    }
    const kind = body.kind;
    if (typeof kind !== "string" || !KINDS.has(kind as ConnectorKind)) {
      return c.json({ error: "connector_kind_invalid" }, 422);
    }
    const provider = typeof body.provider === "string" ? body.provider : "";
    if (!catalogEntry(kind as ConnectorKind, provider as never)) {
      return c.json({ error: "connector_provider_invalid" }, 422);
    }
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    if (!DISPLAY_NAME.test(displayName)) {
      return c.json({ error: "connector_display_name_invalid" }, 422);
    }
    const mode = parseMode(body.mode);
    const config = nonSecretConfig(body);

    const id = newId();
    let sealed: SealedCredential | undefined;
    const token = typeof body.token === "string" && body.token.trim() !== "" ? body.token : undefined;
    if (token) {
      sealed = await vault.seal(tenantId, id, token);
    }
    const at = now();
    let row: ConnectorRow;
    try {
      row = registerConnector(db, {
        id,
        tenantId,
        kind: kind as ConnectorKind,
        provider,
        displayName,
        mode,
        credentialEnvelope: sealed ? JSON.stringify(sealed) : null,
        configJson: JSON.stringify(config),
        createdAt: at,
        updatedAt: at,
      });
    } catch (error) {
      return connectorStoreError(c, error);
    }
    return c.json({ connector: publicConnector(row) }, 201);
  });

  // Verify: probe the external system and record health (fail-closed).
  routes.post("/:id/verify", async (c) => {
    let tenantId: string;
    try {
      tenantId = connectorTenantId(c);
    } catch (error) {
      return authError(c, error);
    }
    const row = getConnector(db, c.req.param("id"), tenantId);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (row.revoked_at) return c.json({ error: "connector_revoked" }, 409);

    const at = now();
    let token: string | undefined;
    if (row.credential_envelope) {
      try {
        const opened = await vault.open(JSON.parse(row.credential_envelope) as SealedCredential, tenantId);
        token = opened.reveal();
      } catch (error) {
        return recordFailure(c, db, row, tenantId, credentialCode(error), at);
      }
    }
    let connector: Connector;
    try {
      connector = buildConnector(row, token);
    } catch (error) {
      // Missing/invalid credential in real mode fails closed here.
      return recordFailure(c, db, row, tenantId, connectorCode(error), at);
    }
    const health = await connector.verifyConnection();
    const updated = setConnectorHealth(db, {
      id: row.id,
      tenantId,
      healthStatus: health.ok ? "verified" : "failed",
      verified: health.ok,
      errorCode: health.errorCode,
      lastVerifiedAt: health.ok ? at : row.last_verified_at,
      updatedAt: at,
    });
    return c.json(
      {
        connector: publicConnector(updated),
        health: {
          ok: health.ok,
          detail: health.detail,
          errorCode: health.errorCode,
          errorHint: health.errorCode ? explainConnectorError(health.errorCode) : null,
        },
      },
      health.ok ? 200 : 422,
    );
  });

  // Disconnect: soft-revoke the connector.
  routes.delete("/:id", (c) => {
    let tenantId: string;
    try {
      tenantId = connectorTenantId(c);
    } catch (error) {
      return authError(c, error);
    }
    const row = getConnector(db, c.req.param("id"), tenantId);
    if (!row) return c.json({ error: "not_found" }, 404);
    const revoked = revokeConnector(db, { id: row.id, tenantId, revokedAt: now() });
    return c.json({ connector: publicConnector(revoked) });
  });

  return routes;
}

function authError(c: Context<ApiEnv>, error: unknown): Response {
  const code = error instanceof Error ? error.message : "authenticated_principal_required";
  return c.json({ error: code }, 401);
}

function connectorStoreError(c: Context<ApiEnv>, error: unknown): Response {
  const code = error instanceof Error ? error.message : "connector_store_failed";
  if (code === "connector_tenant_mismatch") return c.json({ error: "not_found" }, 404);
  if (code === "connector_revoked") return c.json({ error: code }, 409);
  if (code.startsWith("connector_")) return c.json({ error: code }, 422);
  throw error;
}

function credentialCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return message === "tenant_mismatch" ? "tenant_mismatch" : "connector_credential_unreadable";
}

function connectorCode(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (typeof code === "string" && code !== "") return code;
  return "connector_verify_failed";
}

function recordFailure(
  c: Context<ApiEnv>,
  db: AppDb,
  row: ConnectorRow,
  tenantId: string,
  errorCode: string,
  at: string,
): Response {
  const updated = setConnectorHealth(db, {
    id: row.id,
    tenantId,
    healthStatus: "failed",
    verified: false,
    errorCode,
    lastVerifiedAt: row.last_verified_at,
    updatedAt: at,
  });
  return c.json(
    {
      connector: publicConnector(updated),
      health: { ok: false, detail: errorCode, errorCode, errorHint: explainConnectorError(errorCode) },
    },
    422,
  );
}
