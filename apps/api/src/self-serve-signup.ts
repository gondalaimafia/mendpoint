/**
 * Self-serve signup intake (S0-A).
 *
 * Public, flag-gated endpoint that provisions a brand-new tenant for a first
 * customer: it mints a per-user founding-owner identity, auto-creates the
 * tenant, binds the owner membership, and issues the tenant's scoped API key.
 * The whole route is inert (404) unless MENDPOINT_SELF_SERVE_SIGNUP=1, so the
 * existing operator-token and OIDC/SAML paths are never touched.
 */
import { createTenant, type AppDb } from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";
import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import type { ApiEnv } from "./auth.js";

const MAX_BODY_BYTES = 8 * 1_024;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REQUEST_KEYS = new Set(["email", "workspaceName"]);

/** Stable issuer for self-serve founding owners (not an OIDC provider). */
export const SELF_SERVE_ISSUER = "https://self-serve.mendpoint.ai";

export function selfServeSignupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MENDPOINT_SELF_SERVE_SIGNUP === "1";
}

export type SelfServeSignupRoutesOptions = Readonly<{
  db: AppDb;
  enabled: boolean;
  now?: () => string;
}>;

function ownerKey(subject: string): string {
  return createHash("sha256").update(`${SELF_SERVE_ISSUER}\n${subject}`, "utf8").digest("hex");
}

async function body(c: Context<ApiEnv>): Promise<{ email: string; workspaceName: string }> {
  const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) throw new Error("self_serve_content_type_invalid");
  const declared = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("self_serve_payload_too_large");
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new Error("self_serve_payload_too_large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("self_serve_payload_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("self_serve_payload_invalid");
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).some((key) => !REQUEST_KEYS.has(key))) throw new Error("self_serve_field_invalid");
  const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  if (!email || email.length > 320 || !EMAIL.test(email)) throw new Error("self_serve_email_invalid");
  const rawName = typeof value.workspaceName === "string" ? value.workspaceName.trim() : "";
  if (rawName.length > 200) throw new Error("self_serve_workspace_name_invalid");
  const workspaceName = rawName || `${email.split("@")[0]} workspace`;
  return { email, workspaceName };
}

function replyError(c: Context<ApiEnv>, error: unknown): Response {
  const code = error instanceof Error ? error.message : "self_serve_failed";
  if (code === "self_serve_payload_too_large") return c.json({ error: code }, 413);
  if (code === "self_serve_content_type_invalid") return c.json({ error: code }, 415);
  if (code === "tenant_slug_taken") return c.json({ error: "self_serve_workspace_unavailable" }, 409);
  if (code.startsWith("self_serve_")) return c.json({ error: code }, 422);
  throw error;
}

export function createSelfServeSignupRoutes(options: SelfServeSignupRoutesOptions): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  if (!options.enabled) {
    routes.all("*", (c) => c.json({ error: "not_found" }, 404));
    return routes;
  }
  const now = options.now ?? nowIso;

  routes.post("/", async (c) => {
    try {
      const { email, workspaceName } = await body(c);
      const key = ownerKey(email);
      const createdAt = now();
      const result = createTenant(options.db, {
        tenantId: `tenant_ss_${key.slice(0, 24)}`,
        slug: `ss-${key.slice(0, 16)}`,
        name: workspaceName,
        plan: "free",
        owner: {
          issuer: SELF_SERVE_ISSUER,
          subject: email,
          email,
          displayName: workspaceName,
        },
        apiKeyId: `key_ss_${key.slice(0, 24)}_${newId()}`,
        apiKeyName: `${workspaceName} owner key`,
        apiKeyScopes: ["*"],
        createdAt,
      });
      if (!result.created || !result.apiKey) {
        return c.json({ error: "self_serve_account_exists" }, 409);
      }
      return c.json(
        {
          tenant: {
            id: result.tenant.id,
            slug: result.tenant.slug,
            name: result.tenant.name,
            plan: result.tenant.plan,
          },
          owner: {
            issuer: result.membership.issuer,
            subject: result.membership.subject,
            email: result.membership.email,
            displayName: result.membership.display_name,
            role: result.membership.role,
          },
          apiKey: { token: result.apiKey.token, prefix: result.apiKey.prefix },
        },
        201,
      );
    } catch (error) {
      return replyError(c, error);
    }
  });

  return routes;
}
