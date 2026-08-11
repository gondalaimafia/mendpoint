import { SAML, type Profile, type SamlConfig } from "@node-saml/node-saml";
import { SignJWT, exportJWK, importPKCS8, type JWK } from "jose";
import { safeLocalReturn } from "./safe-return";

export const SAML_FLOW_COOKIE = "mendpoint_saml_flow";
export const SAML_FLOW_MAX_AGE_SECONDS = 10 * 60;
export const SAML_SESSION_MAX_AGE_SECONDS = 60 * 60;
const ASSERTION_REPLAY_TTL_MS = 60 * 60 * 1000;

const FLOW_CONTEXT = "mendpoint-saml-flow-v1\n";

/**
 * SAML SP configuration read from the environment. Everything is env gated and
 * default off: when the SP fields are absent the SAML routes report
 * not-configured and no existing auth behaviour changes.
 */
export type SamlSpConfig = {
  entryPoint: string;
  idpCert: string | string[];
  idpIssuer: string | undefined;
  spEntityId: string;
  acsUrl: string;
  spPrivateKey: string | undefined;
  wantAuthnResponseSigned: boolean;
  acceptedClockSkewMs: number;
  maxAssertionAgeMs: number;
  authnContext: string[] | undefined;
  tenantAttribute: string;
  defaultTenantId: string | undefined;
};

/**
 * Bridge configuration. After a SAML assertion is validated the SP mints a
 * short lived signed JWT so the API's existing OIDC verifier authenticates the
 * SAML human exactly like an OIDC human: same tenant membership lookup, same
 * human principal, same downstream review authorization. Enterprises point the
 * API's OIDC_ISSUER / OIDC_JWKS_URI / OIDC_AUDIENCE at this bridge.
 */
export type SamlBridgeConfig = {
  issuer: string;
  audience: string;
  signingKeyPkcs8: string;
  kid: string;
  tenantClaim: string;
  amr: string[];
  sessionMaxAgeSeconds: number;
};

export type SamlFlow = {
  requestId: string;
  relayState: string;
  returnTo: string;
  issuedAt: number;
  expiresAt: number;
};

export type SamlIdentity = {
  issuer: string;
  subject: string;
  tenantId: string;
  email: string | null;
  displayName: string | null;
  authnContext: string | null;
  assertionId: string;
};

function trimmed(value: string | undefined | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(value.length / 4) * 4,
      "=",
    ));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function flowKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${FLOW_CONTEXT}${secret}`),
  );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, usage);
}

export function safeReturnTo(value: string | null): string {
  return safeLocalReturn(value);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Read SP config from env. Returns null when SAML is not configured. */
export function samlSpConfig(): SamlSpConfig | null {
  const entryPoint = trimmed(process.env.SAML_IDP_SSO_URL);
  const idpCert = trimmed(process.env.SAML_IDP_CERT);
  const spEntityId = trimmed(process.env.SAML_SP_ENTITY_ID);
  const acsUrl = trimmed(process.env.SAML_ACS_URL);
  if (!entryPoint || !idpCert || !spEntityId || !acsUrl) return null;
  if (new URL(entryPoint).protocol !== "https:") throw new Error("saml_idp_sso_url_https_required");
  if (new URL(acsUrl).protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new Error("saml_acs_url_https_required");
  }
  return {
    entryPoint,
    idpCert,
    idpIssuer: trimmed(process.env.SAML_IDP_ENTITY_ID),
    spEntityId,
    acsUrl,
    spPrivateKey: trimmed(process.env.SAML_SP_PRIVATE_KEY),
    wantAuthnResponseSigned: /^(1|true|yes)$/i.test(process.env.SAML_WANT_RESPONSE_SIGNED?.trim() ?? ""),
    acceptedClockSkewMs: positiveInt(process.env.SAML_CLOCK_SKEW_MS, 5_000),
    maxAssertionAgeMs: positiveInt(process.env.SAML_MAX_ASSERTION_AGE_MS, 0),
    authnContext: trimmed(process.env.SAML_AUTHN_CONTEXT)?.split(",").map((item) => item.trim()).filter(Boolean),
    tenantAttribute: trimmed(process.env.SAML_TENANT_ATTRIBUTE) ?? "tenantId",
    defaultTenantId: trimmed(process.env.SAML_DEFAULT_TENANT_ID),
  };
}

/** Read bridge config from env. Throws when SAML is configured but the bridge is incomplete. */
export function samlBridgeConfig(): SamlBridgeConfig {
  const issuer = trimmed(process.env.SAML_JWT_ISSUER);
  const audience = trimmed(process.env.SAML_JWT_AUDIENCE);
  const signingKeyPkcs8 = process.env.SAML_JWT_SIGNING_KEY;
  const kid = trimmed(process.env.SAML_JWT_KID);
  if (!issuer || !audience || !signingKeyPkcs8?.trim() || !kid) {
    throw new Error("saml_bridge_configuration_incomplete");
  }
  if (new URL(issuer).protocol !== "https:") throw new Error("saml_jwt_issuer_https_required");
  const amr = (trimmed(process.env.SAML_JWT_AMR) ?? "mfa")
    .split(",").map((item) => item.trim()).filter(Boolean);
  return {
    issuer,
    audience,
    signingKeyPkcs8,
    kid,
    tenantClaim: trimmed(process.env.SAML_JWT_TENANT_CLAIM) ?? "tenant_id",
    amr,
    sessionMaxAgeSeconds: Math.max(1, Math.min(
      positiveInt(process.env.SAML_SESSION_MAX_AGE_SECONDS, SAML_SESSION_MAX_AGE_SECONDS),
      SAML_SESSION_MAX_AGE_SECONDS,
    )),
  };
}

export function samlConfigured(): boolean {
  try {
    if (!samlSpConfig()) return false;
    samlBridgeConfig();
    return true;
  } catch {
    return false;
  }
}

function baseSamlOptions(config: SamlSpConfig): SamlConfig {
  return {
    entryPoint: config.entryPoint,
    idpCert: config.idpCert,
    ...(config.idpIssuer ? { idpIssuer: config.idpIssuer } : {}),
    issuer: config.spEntityId,
    callbackUrl: config.acsUrl,
    audience: config.spEntityId,
    ...(config.spPrivateKey ? { privateKey: config.spPrivateKey } : {}),
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: config.wantAuthnResponseSigned,
    acceptedClockSkewMs: config.acceptedClockSkewMs,
    ...(config.maxAssertionAgeMs > 0 ? { maxAssertionAgeMs: config.maxAssertionAgeMs } : {}),
    ...(config.authnContext && config.authnContext.length > 0
      ? { authnContext: config.authnContext }
      : { disableRequestedAuthnContext: true }),
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
  };
}

function randomToken(bytes = 24): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Build an SP initiated AuthnRequest redirect (HTTP-Redirect binding) plus the
 * encrypted flow cookie that binds InResponseTo and RelayState to this browser.
 */
export async function createSamlAuthnRequest(input: {
  config: SamlSpConfig;
  secret: string;
  returnTo: string;
  host?: string;
  now?: Date;
}): Promise<{ redirectUrl: string; cookie: string }> {
  const now = (input.now ?? new Date()).getTime();
  // xsd:ID must start with a letter or underscore.
  const requestId = `_${randomToken(20)}`;
  const relayState = randomToken(24);
  const saml = new SAML({
    ...baseSamlOptions(input.config),
    generateUniqueId: () => requestId,
  });
  const redirectUrl = await saml.getAuthorizeUrlAsync(relayState, input.host, {});
  const flow: SamlFlow = {
    requestId,
    relayState,
    returnTo: safeReturnTo(input.returnTo),
    issuedAt: now,
    expiresAt: now + SAML_FLOW_MAX_AGE_SECONDS * 1000,
  };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(FLOW_CONTEXT) },
    await flowKey(input.secret, ["encrypt"]),
    new TextEncoder().encode(JSON.stringify(flow)),
  );
  return {
    redirectUrl,
    cookie: `samlflow1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`,
  };
}

export async function readSamlFlow(input: {
  cookie: string;
  secret: string;
  now?: Date;
}): Promise<SamlFlow | null> {
  const parts = input.cookie.split(".");
  if (parts.length !== 3 || parts[0] !== "samlflow1") return null;
  const iv = base64UrlToBytes(parts[1]!);
  const encrypted = base64UrlToBytes(parts[2]!);
  if (!iv || iv.length !== 12 || !encrypted) return null;
  let flow: SamlFlow;
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(iv), additionalData: new TextEncoder().encode(FLOW_CONTEXT) },
      await flowKey(input.secret, ["decrypt"]),
      new Uint8Array(encrypted),
    );
    flow = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decrypted)) as SamlFlow;
  } catch {
    return null;
  }
  const now = (input.now ?? new Date()).getTime();
  if (
    !flow ||
    typeof flow.requestId !== "string" ||
    flow.requestId.length < 8 ||
    typeof flow.relayState !== "string" ||
    flow.relayState.length < 8 ||
    typeof flow.returnTo !== "string" ||
    !Number.isSafeInteger(flow.issuedAt) ||
    !Number.isSafeInteger(flow.expiresAt) ||
    flow.expiresAt <= flow.issuedAt ||
    flow.expiresAt - flow.issuedAt !== SAML_FLOW_MAX_AGE_SECONDS * 1000 ||
    now < flow.issuedAt ||
    now >= flow.expiresAt
  ) return null;
  return flow;
}

/**
 * Cache provider that binds node-saml's InResponseTo validation to the exact
 * request id carried in the encrypted flow cookie. The XML parsing of the
 * InResponseTo attribute is delegated to node-saml; correlation is enforced
 * here. Fails closed: any InResponseTo other than the expected id resolves null
 * and node-saml rejects the response.
 */
function boundInResponseToCache(expectedRequestId: string) {
  return {
    async saveAsync() {
      return null;
    },
    async getAsync(key: string) {
      return key === expectedRequestId ? new Date().toISOString() : null;
    },
    async removeAsync() {
      return null;
    },
  };
}

// Single-use assertion id guard. Module scoped in-memory TTL set. This protects
// a single instance; a horizontally scaled deployment must back replay
// protection with a shared store (documented in docs/SAML_SSO.md).
const consumedAssertions = new Map<string, number>();

function assertSingleUse(assertionId: string, now: number): void {
  for (const [id, expiresAt] of consumedAssertions) {
    if (expiresAt <= now) consumedAssertions.delete(id);
  }
  if (consumedAssertions.has(assertionId)) {
    throw new Error("saml_assertion_replayed");
  }
  consumedAssertions.set(assertionId, now + ASSERTION_REPLAY_TTL_MS);
}

/** Test-only: reset the in-memory replay guard. */
export function __resetSamlReplayGuard(): void {
  consumedAssertions.clear();
}

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = firstString(item);
      if (resolved) return resolved;
    }
  }
  return null;
}

function extractAssertionId(profile: Profile): string | null {
  const direct = firstString(profile.ID);
  if (direct) return direct;
  const assertion = profile.getAssertion?.();
  if (assertion && typeof assertion === "object") {
    const root = (assertion as Record<string, unknown>).Assertion ?? assertion;
    const attributes = root && typeof root === "object"
      ? (root as Record<string, unknown>).$ ?? root
      : null;
    if (attributes && typeof attributes === "object") {
      const id = firstString((attributes as Record<string, unknown>).ID);
      if (id) return id;
    }
  }
  return null;
}

function extractEmail(profile: Profile): string | null {
  return (
    firstString(profile.email) ??
    firstString(profile.mail) ??
    firstString(profile["urn:oid:0.9.2342.19200300.100.1.3"]) ??
    (typeof profile.nameID === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.nameID)
      ? profile.nameID.toLowerCase()
      : null)
  );
}

function extractDisplayName(profile: Profile): string | null {
  return (
    firstString(profile.displayName) ??
    firstString(profile.cn) ??
    firstString(profile["urn:oid:2.16.840.1.113730.3.1.241"]) ??
    firstString(profile["urn:oid:2.5.4.3"])
  );
}

/**
 * Extract the bearer SubjectConfirmationData Recipient from the signed
 * assertion. node-saml does not validate Recipient or the Response Destination,
 * so the SP must: the Recipient lives inside the signed assertion and is the
 * authoritative binding that the assertion was delivered to this ACS.
 */
function extractRecipient(profile: Profile): string | null {
  const assertion = profile.getAssertion?.();
  if (!assertion || typeof assertion !== "object") return null;
  const root = ((assertion as Record<string, unknown>).Assertion ?? assertion) as Record<string, unknown>;
  const subject = Array.isArray(root.Subject) ? root.Subject[0] : root.Subject;
  if (!subject || typeof subject !== "object") return null;
  const confirmationList = (subject as Record<string, unknown>).SubjectConfirmation;
  const confirmation = Array.isArray(confirmationList) ? confirmationList[0] : confirmationList;
  if (!confirmation || typeof confirmation !== "object") return null;
  const dataList = (confirmation as Record<string, unknown>).SubjectConfirmationData;
  const data = Array.isArray(dataList) ? dataList[0] : dataList;
  const attributes = data && typeof data === "object" ? (data as Record<string, unknown>).$ : null;
  if (attributes && typeof attributes === "object") {
    return firstString((attributes as Record<string, unknown>).Recipient);
  }
  return null;
}

/** Best effort extraction of the assertion AuthnContextClassRef for the acr claim. */
function extractAuthnContext(profile: Profile): string | null {
  const assertion = profile.getAssertion?.();
  if (!assertion || typeof assertion !== "object") return null;
  const root = (assertion as Record<string, unknown>).Assertion ?? assertion;
  const statements = root && typeof root === "object"
    ? (root as Record<string, unknown>).AuthnStatement
    : null;
  const statement = Array.isArray(statements) ? statements[0] : statements;
  if (!statement || typeof statement !== "object") return null;
  const contextList = (statement as Record<string, unknown>).AuthnContext;
  const context = Array.isArray(contextList) ? contextList[0] : contextList;
  if (!context || typeof context !== "object") return null;
  const classRef = (context as Record<string, unknown>).AuthnContextClassRef;
  const entry = Array.isArray(classRef) ? classRef[0] : classRef;
  if (typeof entry === "string") return entry.trim() || null;
  if (entry && typeof entry === "object") {
    return firstString((entry as Record<string, unknown>)._) ??
      firstString((entry as Record<string, unknown>)["#text"]);
  }
  return null;
}

/**
 * Validate a SAML POST Response and map it to a tenant bound human identity.
 * node-saml enforces: signature over the assertion against the IdP cert,
 * AudienceRestriction, SubjectConfirmationData Recipient, Destination,
 * Conditions NotBefore / NotOnOrAfter, and InResponseTo (bound to the flow
 * cookie via the cache provider). This function adds RelayState correlation,
 * single-use assertion id replay protection, and subject / tenant extraction.
 * Fails closed on any missing value.
 */
export async function validateSamlResponse(input: {
  config: SamlSpConfig;
  bridge: SamlBridgeConfig;
  flow: SamlFlow;
  samlResponse: string;
  relayState: string;
  now?: Date;
}): Promise<SamlIdentity> {
  if (input.relayState !== input.flow.relayState) {
    throw new Error("saml_relay_state_mismatch");
  }
  const saml = new SAML({
    ...baseSamlOptions(input.config),
    validateInResponseTo: "always" as SamlConfig["validateInResponseTo"],
    cacheProvider: boundInResponseToCache(input.flow.requestId),
  });
  const { profile, loggedOut } = await saml.validatePostResponseAsync({
    SAMLResponse: input.samlResponse,
    RelayState: input.relayState,
  });
  if (loggedOut || !profile) throw new Error("saml_response_invalid");

  // Recipient binding: enforced by the SP because node-saml does not. The
  // Recipient is inside the signed assertion, so this check is authoritative.
  const recipient = extractRecipient(profile);
  if (!recipient || recipient !== input.config.acsUrl) {
    throw new Error("saml_recipient_mismatch");
  }

  const assertionId = extractAssertionId(profile);
  if (!assertionId) throw new Error("saml_assertion_id_missing");
  assertSingleUse(assertionId, (input.now ?? new Date()).getTime());

  const subject = firstString(profile.nameID);
  if (!subject) throw new Error("saml_subject_missing");

  const tenantId =
    firstString(profile[input.config.tenantAttribute]) ??
    input.config.defaultTenantId ??
    null;
  if (!tenantId) throw new Error("saml_tenant_missing");

  return {
    issuer: input.bridge.issuer,
    subject,
    tenantId,
    email: extractEmail(profile),
    displayName: extractDisplayName(profile),
    authnContext: extractAuthnContext(profile),
    assertionId,
  };
}

/**
 * Mint the bridge JWT the API verifies via its OIDC verifier. Issuer, audience,
 * tenant claim and MFA (amr) are aligned with the API's OIDC configuration so a
 * SAML human is authenticated exactly like an OIDC human.
 */
export async function mintBridgeToken(input: {
  bridge: SamlBridgeConfig;
  identity: SamlIdentity;
  now?: Date;
}): Promise<{ token: string; expiresInSeconds: number }> {
  const key = await importPKCS8(input.bridge.signingKeyPkcs8, "RS256");
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const expiresInSeconds = input.bridge.sessionMaxAgeSeconds;
  const token = await new SignJWT({
    [input.bridge.tenantClaim]: input.identity.tenantId,
    amr: input.bridge.amr,
    ...(input.identity.authnContext ? { acr: input.identity.authnContext } : {}),
    ...(input.identity.email ? { email: input.identity.email } : {}),
    auth_via: "saml",
  })
    .setProtectedHeader({ alg: "RS256", kid: input.bridge.kid, typ: "JWT" })
    .setIssuer(input.bridge.issuer)
    .setAudience(input.bridge.audience)
    .setSubject(input.identity.subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + expiresInSeconds)
    .sign(key);
  return { token, expiresInSeconds };
}

/** Public JWKS derived from the bridge signing key, served to the API's OIDC_JWKS_URI. */
export async function bridgeJwks(bridge: SamlBridgeConfig): Promise<{ keys: JWK[] }> {
  const key = await importPKCS8(bridge.signingKeyPkcs8, "RS256", { extractable: true });
  const jwk = await exportJWK(key);
  // Serve only the public components. Never expose private key material (d, p,
  // q, dp, dq, qi) in a JWKS.
  const publicJwk: JWK = { kty: jwk.kty!, n: jwk.n, e: jwk.e, kid: bridge.kid, use: "sig", alg: "RS256" };
  return { keys: [publicJwk] };
}

/** SP metadata XML for IdP configuration. */
export function samlMetadata(config: SamlSpConfig): string {
  const saml = new SAML(baseSamlOptions(config));
  return saml.generateServiceProviderMetadata(
    null,
    config.spPrivateKey ? undefined : null,
  );
}
