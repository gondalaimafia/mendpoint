import {
  getIdentitySession,
  recordAudit,
  revokeIdentitySession,
  type AppDb,
} from "@mendpoint/db";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { ApiEnv } from "./auth.js";

type Options = Readonly<{ db: AppDb; now?: () => Date }>;

function auditId(tenantId: string, sessionId: string, revokedAt: string): string {
  return `audit-session-${createHash("sha256")
    .update(`${tenantId}\n${sessionId}\n${revokedAt}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

export function createIdentitySessionRoutes(options: Options): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  const now = options.now ?? (() => new Date());

  routes.get("/current", (c) => {
    const principal = c.get("principal");
    const sessionId = c.get("identitySessionId");
    if (!principal || !sessionId || c.get("authMethod") !== "oidc") {
      return c.json({ error: "oidc_session_required" }, 401);
    }
    const session = getIdentitySession(options.db, principal.tenantId, sessionId);
    if (!session || session.revoked_at !== null) return c.json({ error: "oidc_session_invalid" }, 401);
    return c.json({
      data: {
        id: session.id,
        principalId: session.principal_id,
        authStrength: session.auth_strength,
        issuedAt: session.issued_at,
        expiresAt: session.expires_at,
        lastSeenAt: session.last_seen_at,
      },
    });
  });

  routes.post("/current/revoke", (c) => {
    const principal = c.get("principal");
    const trustPrincipalId = c.get("trustPrincipalId");
    const sessionId = c.get("identitySessionId");
    if (!principal || !trustPrincipalId || !sessionId || c.get("authMethod") !== "oidc") {
      return c.json({ error: "oidc_session_required" }, 401);
    }
    const revokedAt = now().toISOString();
    const owns = !options.db.raw.isTransaction;
    if (owns) options.db.raw.exec("BEGIN IMMEDIATE");
    try {
      const session = revokeIdentitySession(options.db, {
        tenantId: principal.tenantId,
        sessionId,
        actorPrincipalId: trustPrincipalId,
        reason: "human_logout",
        revokedAt,
      });
      if (!session) {
        if (owns) options.db.raw.exec("ROLLBACK");
        return c.json({ error: "oidc_session_not_found" }, 404);
      }
      recordAudit(options.db, {
        id: auditId(principal.tenantId, sessionId, revokedAt),
        tenantId: principal.tenantId,
        actor: principal.id,
        principalId: trustPrincipalId,
        apiKeyId: null,
        requestId: c.get("requestId") ?? null,
        action: "identity_session.revoke",
        resourceType: "identity_session",
        resourceId: sessionId,
        metadata: { reason: "human_logout", revokedAt },
      });
      if (owns) options.db.raw.exec("COMMIT");
      return c.json({ data: { id: session.id, revokedAt: session.revoked_at } });
    } catch (error) {
      if (owns && options.db.raw.isTransaction) options.db.raw.exec("ROLLBACK");
      console.error(error instanceof Error ? error.message : "identity_session_revoke_failed");
      return c.json({ error: "identity_session_revoke_failed", requestId: c.get("requestId") ?? null }, 500);
    }
  });

  return routes;
}
