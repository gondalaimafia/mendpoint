import {
  getIdentitySession,
  getPrincipal,
  getTenantMembership,
  listApiKeys,
  type AppDb,
  type TenantMembershipRow,
} from "@mendpoint/db";
import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { ApiEnv } from "./auth.js";

export type HumanManagerAuthorityErrors = Readonly<{
  authenticationRequired: string;
  managerRequired: string;
  observedAtInvalid: string;
}>;

export type LiveHumanManager = Readonly<{
  id: string;
  tenantId: string;
  role: Extract<TenantMembershipRow["role"], "owner" | "admin">;
  trustPrincipalId: string;
}>;

export function claimedHumanManager(
  c: Context<ApiEnv>,
  errors: HumanManagerAuthorityErrors,
): LiveHumanManager {
  const principal = c.get("principal");
  const trustPrincipalId = c.get("trustPrincipalId");
  if (!principal || !trustPrincipalId) throw new Error(errors.authenticationRequired);
  if (principal.role !== "owner" && principal.role !== "admin") {
    throw new Error(errors.managerRequired);
  }
  return { ...principal, role: principal.role, trustPrincipalId };
}

export function revalidateHumanManager(
  c: Context<ApiEnv>,
  db: AppDb,
  observedAt: Date,
  errors: HumanManagerAuthorityErrors,
): LiveHumanManager {
  const claimed = claimedHumanManager(c, errors);
  const observedAtMs = observedAt.getTime();
  if (!Number.isFinite(observedAtMs)) throw new Error(errors.observedAtInvalid);
  const observedAtIso = observedAt.toISOString();
  const trust = getPrincipal(db, claimed.tenantId, claimed.trustPrincipalId);
  if (
    !trust ||
    trust.kind !== "human" ||
    trust.created_at > observedAtIso ||
    trust.revoked_at !== null ||
    (trust.expires_at !== null && (
      !Number.isFinite(Date.parse(trust.expires_at)) || Date.parse(trust.expires_at) <= observedAtMs
    )) ||
    !trust.audience ||
    !trust.subject.startsWith(`${trust.audience}|`)
  ) throw new Error(errors.authenticationRequired);
  const subject = trust.subject.slice(trust.audience.length + 1);
  const membership = subject
    ? getTenantMembership(db, claimed.tenantId, trust.audience, subject)
    : undefined;
  if (
    !membership ||
    membership.status !== "active" ||
    (membership.role !== "owner" && membership.role !== "admin") ||
    claimed.id !== `human:${trust.subject}`
  ) throw new Error(errors.managerRequired);

  const authMethod = c.get("authMethod");
  if (authMethod === "api_key") {
    const apiKeyId = c.get("apiKeyId");
    const key = apiKeyId
      ? listApiKeys(db, claimed.tenantId).find((candidate) => candidate.id === apiKeyId)
      : undefined;
    let liveScopes: unknown;
    try { liveScopes = key ? JSON.parse(key.scopes_json) : null; } catch { liveScopes = null; }
    if (
      !key ||
      key.created_at > observedAtIso ||
      key.revoked_at !== null ||
      !Array.isArray(liveScopes) ||
      (!liveScopes.includes("tenant:admin") && !liveScopes.includes("*"))
    ) throw new Error(errors.authenticationRequired);
  } else if (authMethod === "oidc") {
    const sessionId = c.get("identitySessionId");
    const session = sessionId ? getIdentitySession(db, claimed.tenantId, sessionId) : undefined;
    const evidenceId = `membership:${createHash("sha256")
      .update(`${claimed.tenantId}\n${trust.audience}\n${subject}`, "utf8")
      .digest("hex")}`;
    if (
      !session ||
      session.principal_id !== trust.id ||
      session.issuer !== trust.audience ||
      session.subject !== subject ||
      session.membership_updated_at !== membership.updated_at ||
      session.issued_at > observedAtIso ||
      session.expires_at <= observedAtIso ||
      session.revoked_at !== null ||
      c.get("membershipEvidenceId") !== evidenceId
    ) throw new Error(errors.authenticationRequired);
  } else {
    throw new Error(errors.authenticationRequired);
  }
  return { ...claimed, role: membership.role };
}

/** First-owner bootstrap is API-key-only because no durable human membership exists yet. */
export function revalidateBootstrapManager(
  c: Context<ApiEnv>,
  db: AppDb,
  observedAt: Date,
  errors: HumanManagerAuthorityErrors,
): LiveHumanManager {
  const claimed = claimedHumanManager(c, errors);
  const observedAtMs = observedAt.getTime();
  if (!Number.isFinite(observedAtMs)) throw new Error(errors.observedAtInvalid);
  if (c.get("authMethod") !== "api_key") throw new Error(errors.authenticationRequired);
  const apiKeyId = c.get("apiKeyId");
  const key = apiKeyId
    ? listApiKeys(db, claimed.tenantId).find((candidate) => candidate.id === apiKeyId)
    : undefined;
  let liveScopes: unknown;
  try { liveScopes = key ? JSON.parse(key.scopes_json) : null; } catch { liveScopes = null; }
  const role = Array.isArray(liveScopes) && (liveScopes.includes("*") || liveScopes.includes("role:owner"))
    ? "owner"
    : Array.isArray(liveScopes) && liveScopes.includes("role:admin")
      ? "admin"
      : null;
  if (
    !key ||
    key.created_at > observedAt.toISOString() ||
    key.revoked_at !== null ||
    !Array.isArray(liveScopes) ||
    (!liveScopes.includes("tenant:admin") && !liveScopes.includes("*")) ||
    role === null
  ) throw new Error(errors.authenticationRequired);
  const trust = getPrincipal(db, claimed.tenantId, claimed.trustPrincipalId);
  if (
    !trust ||
    trust.created_at > observedAt.toISOString() ||
    trust.revoked_at !== null ||
    (trust.expires_at !== null && (
      !Number.isFinite(Date.parse(trust.expires_at)) || Date.parse(trust.expires_at) <= observedAtMs
    ))
  ) throw new Error(errors.authenticationRequired);
  const humanMatches = trust.kind === "human" && Boolean(trust.audience) &&
    trust.subject.startsWith(`${trust.audience}|`) && claimed.id === `human:${trust.subject}`;
  const apiKeyMatches = trust.kind === "api_key" && trust.audience === "mendpoint-api" &&
    trust.subject === key.id && claimed.id === `api-key:${key.id}`;
  if (!humanMatches && !apiKeyMatches) throw new Error(errors.authenticationRequired);
  return { ...claimed, role };
}
