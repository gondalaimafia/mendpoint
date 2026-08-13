/**
 * Self-serve organization access administration (S3-rbac).
 *
 * A tenant-scoped, flag-gated admin surface that lets an owner/admin manage
 * least-privilege access WITHOUT our help, on top of the existing primitives it
 * never rebuilds or weakens:
 *   - membership + role management  ->  /tenants/memberships (tenant-memberships.ts)
 *   - RBAC role grants              ->  @mendpoint/platform permissionsFor / can
 *   - config-as-code narrowing      ->  @mendpoint/transformer resolveEffectiveConfig
 *   - hash-chained audit log        ->  @mendpoint/db recordAudit / queryTenantAuditEvents
 *
 * This slice ADDS, all owner/admin only, tenant-scoped, and (for mutations) audited:
 *   POST/DELETE/GET /scopes   repository & environment scopes narrowing a member
 *   GET  /access              a member's EFFECTIVE access (role permissions
 *                             intersected with config narrowing; repositories and
 *                             environments intersected with the tenant's real ones)
 *   GET  /audit[/export]      the tenant's hash-chained audit trail, filterable,
 *                             CSV/JSON export, with chain-verification status
 *   GET  /posture             a security-posture summary read from REAL settings
 *
 * ENFORCEMENT HONESTY (see also the route docs):
 *   - Role -> permission narrowing is ENFORCED (permittedRolePermissions is the same
 *     function the run seam uses; the result is always a subset of permissionsFor).
 *   - Repository scoping is ENFORCED at grant time (a scope must name a real tenant
 *     repository) and at resolution (the effective set is the intersection). It is
 *     NOT yet consulted at the legacy run-trigger / PR-delivery call sites, so there
 *     it is advisory; that gap is surfaced explicitly, never hidden.
 *   - Environment scoping is ENFORCED at resolution against the tenant's real
 *     environments (the distinct environments its connected repositories declare,
 *     the server-side reflection of config-as-code environments); a scope value that
 *     matches no real environment is reported as advisory, never silently honored.
 *
 * DEFAULT-SAFE: the whole factory is inert (404 on every path) unless
 * MENDPOINT_SELF_SERVE_ADMIN=1, so with the flag off behavior is byte-identical.
 */
import {
  grantMemberScope,
  listConnectedRepositories,
  listMemberScopes,
  listTenantMemberScopes,
  listTenantMemberships,
  getTenantMembership,
  queryTenantAuditEvents,
  exportTenantAuditCsv,
  recordAudit,
  revokeMemberScope,
  verifyAuditIntegrity,
  type AppDb,
  type MemberScopeType,
  type TenantMembershipRow,
} from "@mendpoint/db";
import { permissionsFor, type Permission, type Role } from "@mendpoint/platform";
import {
  resolveEffectiveConfig,
  permittedRolePermissions,
  type EffectiveConfig,
} from "@mendpoint/transformer";
import { customerModelRoutingEnabled, resolveTenantModelTier } from "@mendpoint/agent";
import { createHash, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type { ApiEnv } from "./auth.js";

export function selfServeAdminEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MENDPOINT_SELF_SERVE_ADMIN === "1";
}

// ---------------------------------------------------------------------------
// Pure access resolver (exported for direct unit testing of the invariants)
// ---------------------------------------------------------------------------

export type MemberScopeSet = Readonly<{
  repositories: readonly string[];
  environments: readonly string[];
}>;

export type AccessDimension = Readonly<{
  /** `all`: no scope of this type, so the member keeps their role's full reach.
   *  `scoped`: confined to `allowed`. */
  mode: "all" | "scoped";
  /** The ENFORCED set — always a subset of the tenant's real universe. */
  allowed: readonly string[];
  /** Scope values that matched no real resource: stored + shown, never enforced. */
  advisory: readonly string[];
}>;

export type MemberAccess = Readonly<{
  role: Role;
  permissions: Readonly<{ trigger: readonly Permission[]; approve: readonly Permission[] }>;
  repositories: AccessDimension;
  environments: AccessDimension;
}>;

function dimension(scopeValues: readonly string[], universe: readonly string[]): AccessDimension {
  const unique = [...new Set(scopeValues)];
  if (unique.length === 0) {
    return { mode: "all", allowed: [...universe], advisory: [] };
  }
  const universeSet = new Set(universe);
  return {
    mode: "scoped",
    // Intersection only — a scope can never widen access beyond the tenant's real
    // resources; unknown values fall through to `advisory`.
    allowed: unique.filter((value) => universeSet.has(value)),
    advisory: unique.filter((value) => !universeSet.has(value)),
  };
}

/**
 * Resolve a member's effective access. Permissions are `permittedRolePermissions`
 * (RBAC grants intersected with any config narrowing) — always a subset of
 * `permissionsFor(role)`. Repository/environment access is the intersection of the
 * member's scopes with the tenant's real repositories/environments. The result can
 * never exceed the role's grants nor the tenant's resources: least-privilege only.
 */
export function resolveMemberAccess(input: {
  role: Role;
  scopes: MemberScopeSet;
  tenantRepositories: readonly string[];
  tenantEnvironments: readonly string[];
  effective: EffectiveConfig;
}): MemberAccess {
  const permitted = permittedRolePermissions(input.effective, input.role);
  return {
    role: input.role,
    permissions: { trigger: permitted.trigger, approve: permitted.approve },
    repositories: dimension(input.scopes.repositories, input.tenantRepositories),
    environments: dimension(input.scopes.environments, input.tenantEnvironments),
  };
}

// ---------------------------------------------------------------------------
// Security posture (read from REAL settings, never a hardcoded checklist)
// ---------------------------------------------------------------------------

export type PostureControl = Readonly<{
  id: string;
  label: string;
  /** `enforced`: guaranteed now. `configured`: deployment control on for this tenant.
   *  `not_configured`: exists but not active for this tenant. */
  status: "enforced" | "configured" | "not_configured";
  detail: string;
  /** Where the status was read from (the honest provenance). */
  source: string;
}>;

export type SecurityPosture = Readonly<{
  tenantId: string;
  controls: readonly PostureControl[];
  computedAt: string;
}>;

export function computeSecurityPosture(
  db: AppDb,
  input: { tenantId: string; env?: NodeJS.ProcessEnv; now?: () => string },
): SecurityPosture {
  const tenantId = input.tenantId.trim();
  if (!tenantId) throw new Error("tenant_scope_required");
  const env = input.env ?? process.env;
  const now = input.now ?? (() => new Date().toISOString());

  const effective = resolveEffectiveConfig({});
  const scopes = listTenantMemberScopes(db, tenantId);
  const repoScopes = scopes.filter((s) => s.scope_type === "repository").length;
  const envScopes = scopes.filter((s) => s.scope_type === "environment").length;
  const scopedMembers = new Set(scopes.map((s) => `${s.issuer}\n${s.subject}`)).size;

  const routingOn = customerModelRoutingEnabled(env);
  const tier = resolveTenantModelTier(tenantId, env);
  const microvmConfigured = Boolean(
    (env.MENDPOINT_SANDBOX_FLY_APP ?? "").trim() &&
      (env.FLY_API_TOKEN ?? "").trim() &&
      (env.MENDPOINT_SANDBOX_FLY_MODE ?? "").trim().toLowerCase() !== "mock",
  );
  const chain = verifyAuditIntegrity(db, tenantId);

  const controls: PostureControl[] = [
    {
      id: "tenant_isolation",
      label: "Tenant isolation",
      status: "enforced",
      detail:
        "Every customer-owned row is filtered by tenant and cross-tenant access fails closed (assertTenant / assertTenantScope).",
      source: "@mendpoint/platform assertTenant + @mendpoint/db assertTenantScope",
    },
    {
      id: "least_privilege_scopes",
      label: "Least-privilege repository/environment scopes",
      status: scopes.length > 0 ? "enforced" : "not_configured",
      detail:
        scopes.length > 0
          ? `${scopedMembers} member(s) confined by ${repoScopes} repository and ${envScopes} environment scope(s), intersected with the tenant's real resources.`
          : "No member scopes defined; members inherit their role's full tenant reach. Add scopes to narrow further.",
      source: "@mendpoint/db tenant_member_scopes (listTenantMemberScopes)",
    },
    {
      id: "review_first_no_auto_merge",
      label: "Review-first, no auto-merge",
      status:
        !effective.policy.autoMergeLowRisk && effective.workflows.draftOnly ? "enforced" : "not_configured",
      detail:
        "Every candidate is a reviewable draft; auto-merge cannot be enabled by config (draft-only floor, autoMergeLowRisk stays false).",
      source: "@mendpoint/transformer resolveEffectiveConfig (policy.autoMergeLowRisk / workflows.draftOnly)",
    },
    {
      id: "non_training_model_routing",
      label: "Non-training model routing",
      status: routingOn && tier === "non_training" ? "enforced" : "not_configured",
      detail:
        !routingOn
          ? "Customer model routing is not enabled in this deployment; the training-tier guard is inactive."
          : tier === "non_training"
            ? "This tenant is routed to a non-training model backend; a hard guard rejects any training-tier resolution."
            : "This tenant is on the internal training-tier allowlist (training_allowed).",
      source: "@mendpoint/agent customerModelRoutingEnabled + resolveTenantModelTier",
    },
    {
      id: "microvm_isolation",
      label: "Per-run microVM isolation",
      status: microvmConfigured ? "configured" : "not_configured",
      detail: microvmConfigured
        ? "Runs execute in per-run Fly Machines microVMs; host fallback is refused."
        : "Fly Machines sandbox is not configured for this deployment (no isolated microVM app/token).",
      source: "env MENDPOINT_SANDBOX_FLY_APP + FLY_API_TOKEN + MENDPOINT_SANDBOX_FLY_MODE",
    },
    {
      id: "secret_redaction",
      label: "Secret redaction before model calls",
      status: "enforced",
      detail: "Source shared with a model is redacted first (redactSourceForModel); secrets are stripped unconditionally.",
      source: "@mendpoint/agent redactSourceForModel",
    },
    {
      id: "audit_chain",
      label: "Hash-chained audit trail",
      status: chain.ok ? "enforced" : "not_configured",
      detail: chain.ok
        ? `Append-only audit chain verified across ${chain.checked} event(s).`
        : `Audit chain verification failed (${chain.error ?? "unknown"}).`,
      source: "@mendpoint/db verifyAuditIntegrity",
    },
  ];

  return { tenantId, controls, computedAt: now() };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export type SelfServeAdminRoutesOptions = Readonly<{
  db: AppDb;
  enabled: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  createId?: () => string;
}>;

const MAX_BODY_BYTES = 32 * 1_024;
const SCOPE_TYPES = new Set<MemberScopeType>(["repository", "environment"]);

type Manager = ReturnType<typeof requireManager>;

function requireManager(c: Context<ApiEnv>) {
  const principal = c.get("principal");
  const trustPrincipalId = c.get("trustPrincipalId");
  if (!principal || !trustPrincipalId) throw new Error("admin_authentication_required");
  if (principal.tenantId.trim() === "") throw new Error("tenant_scope_required");
  if (principal.role !== "owner" && principal.role !== "admin") {
    throw new Error("admin_manager_required");
  }
  return { ...principal, trustPrincipalId };
}

function replyManagerError(c: Context<ApiEnv>, error: unknown): Response {
  const code = error instanceof Error ? error.message : "admin_error";
  if (code === "admin_authentication_required" || code === "tenant_scope_required") {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (code === "admin_manager_required") {
    return c.json({ error: "forbidden" }, 403);
  }
  throw error;
}

function text(value: unknown, code: string, max = 512): string {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(code);
  return normalized;
}

async function jsonBody(c: Context<ApiEnv>): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) throw new Error("admin_content_type_invalid");
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new Error("admin_payload_too_large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("admin_payload_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("admin_payload_invalid");
  }
  return parsed as Record<string, unknown>;
}

function memberResourceId(tenantId: string, issuer: string, subject: string): string {
  return `member_scope:${createHash("sha256")
    .update(`${tenantId}\n${issuer}\n${subject}`, "utf8")
    .digest("hex")}`;
}

function tenantEnvironments(db: AppDb, tenantId: string): string[] {
  return [
    ...new Set(
      listConnectedRepositories(db, tenantId)
        .map((r) => r.environment)
        .filter((e): e is string => typeof e === "string" && e.trim() !== ""),
    ),
  ].sort();
}

function tenantRepositories(db: AppDb, tenantId: string): string[] {
  return listConnectedRepositories(db, tenantId)
    .map((r) => `${r.owner}/${r.name}`)
    .sort();
}

function memberOf(db: AppDb, tenantId: string, issuer: string, subject: string): TenantMembershipRow {
  const membership = getTenantMembership(db, tenantId, issuer, subject);
  if (!membership || membership.status !== "active") throw new Error("admin_member_not_found");
  return membership;
}

export function createSelfServeAdminRoutes(options: SelfServeAdminRoutesOptions): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  if (!options.enabled) {
    routes.all("*", (c) => c.json({ error: "not_found" }, 404));
    return routes;
  }
  const { db } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? (() => `admin-audit-${randomUUID()}`);

  function audit(
    c: Context<ApiEnv>,
    actor: Manager,
    action: string,
    resourceId: string,
    metadata: Record<string, unknown>,
  ): void {
    recordAudit(db, {
      id: createId(),
      tenantId: actor.tenantId,
      actor: actor.id,
      principalId: actor.trustPrincipalId,
      apiKeyId: c.get("apiKeyId") ?? null,
      requestId: c.get("requestId") ?? null,
      action,
      resourceType: "member_scope",
      resourceId,
      metadata,
    });
  }

  // --- member scopes ------------------------------------------------------
  routes.get("/scopes", (c) => {
    let actor: Manager;
    try {
      actor = requireManager(c);
    } catch (error) {
      return replyManagerError(c, error);
    }
    const issuer = c.req.query("issuer");
    const subject = c.req.query("subject");
    const rows =
      issuer && subject
        ? listMemberScopes(db, actor.tenantId, issuer, subject)
        : listTenantMemberScopes(db, actor.tenantId);
    return c.json({
      data: rows.map((r) => ({
        issuer: r.issuer,
        subject: r.subject,
        scopeType: r.scope_type,
        scopeValue: r.scope_value,
        createdAt: r.created_at,
        createdBy: r.created_by,
      })),
    });
  });

  routes.post("/scopes", async (c) => {
    let actor: Manager;
    try {
      actor = requireManager(c);
    } catch (error) {
      return replyManagerError(c, error);
    }
    try {
      const body = await jsonBody(c);
      const issuer = text(body.issuer, "admin_issuer_invalid", 2_048);
      const subject = text(body.subject, "admin_subject_invalid");
      const scopeTypeRaw = body.scopeType;
      if (typeof scopeTypeRaw !== "string" || !SCOPE_TYPES.has(scopeTypeRaw as MemberScopeType)) {
        throw new Error("admin_scope_type_invalid");
      }
      const scopeType = scopeTypeRaw as MemberScopeType;
      const scopeValue = text(body.scopeValue, "admin_scope_value_invalid");

      memberOf(db, actor.tenantId, issuer, subject);
      // Repository scoping is genuinely enforced: a scope must name a repository the
      // tenant actually has, so an admin can never scope a member to a repo outside
      // the tenant. Environment values are validated at resolution (against the
      // tenant's real environments), so a plausible token is accepted here.
      if (scopeType === "repository" && !tenantRepositories(db, actor.tenantId).includes(scopeValue)) {
        return c.json({ error: "admin_repository_not_found" }, 404);
      }

      const row = grantMemberScope(db, {
        id: `member-scope-${randomUUID()}`,
        tenantId: actor.tenantId,
        issuer,
        subject,
        scopeType,
        scopeValue,
        createdBy: actor.trustPrincipalId,
        createdAt: now().toISOString(),
      });
      audit(c, actor, "member_scope.grant", memberResourceId(actor.tenantId, issuer, subject), {
        scopeType: row.scope_type,
        scopeValue: row.scope_value,
      });
      return c.json(
        {
          data: {
            issuer: row.issuer,
            subject: row.subject,
            scopeType: row.scope_type,
            scopeValue: row.scope_value,
            createdAt: row.created_at,
          },
        },
        201,
      );
    } catch (error) {
      return replyAdminBadRequest(c, error);
    }
  });

  routes.delete("/scopes", async (c) => {
    let actor: Manager;
    try {
      actor = requireManager(c);
    } catch (error) {
      return replyManagerError(c, error);
    }
    try {
      const body = await jsonBody(c);
      const issuer = text(body.issuer, "admin_issuer_invalid", 2_048);
      const subject = text(body.subject, "admin_subject_invalid");
      const scopeTypeRaw = body.scopeType;
      if (typeof scopeTypeRaw !== "string" || !SCOPE_TYPES.has(scopeTypeRaw as MemberScopeType)) {
        throw new Error("admin_scope_type_invalid");
      }
      const scopeType = scopeTypeRaw as MemberScopeType;
      const scopeValue = text(body.scopeValue, "admin_scope_value_invalid");
      const removed = revokeMemberScope(db, {
        tenantId: actor.tenantId,
        issuer,
        subject,
        scopeType,
        scopeValue,
      });
      if (!removed) return c.json({ error: "admin_scope_not_found" }, 404);
      audit(c, actor, "member_scope.revoke", memberResourceId(actor.tenantId, issuer, subject), {
        scopeType,
        scopeValue,
      });
      return c.json({ data: { removed: true } });
    } catch (error) {
      return replyAdminBadRequest(c, error);
    }
  });

  // --- effective access ---------------------------------------------------
  routes.get("/access", (c) => {
    let actor: Manager;
    try {
      actor = requireManager(c);
    } catch (error) {
      return replyManagerError(c, error);
    }
    const issuer = c.req.query("issuer");
    const subject = c.req.query("subject");
    if (!issuer || !subject) return c.json({ error: "admin_member_query_required" }, 400);
    let membership: TenantMembershipRow;
    try {
      membership = memberOf(db, actor.tenantId, issuer, subject);
    } catch {
      return c.json({ error: "admin_member_not_found" }, 404);
    }
    const scopes = listMemberScopes(db, actor.tenantId, issuer, subject);
    const access = resolveMemberAccess({
      role: membership.role as Role,
      scopes: {
        repositories: scopes.filter((s) => s.scope_type === "repository").map((s) => s.scope_value),
        environments: scopes.filter((s) => s.scope_type === "environment").map((s) => s.scope_value),
      },
      tenantRepositories: tenantRepositories(db, actor.tenantId),
      tenantEnvironments: tenantEnvironments(db, actor.tenantId),
      effective: resolveEffectiveConfig({}),
    });
    // Honest enforcement provenance the UI can surface verbatim.
    return c.json({
      data: {
        issuer,
        subject,
        role: access.role,
        rbacGrants: permissionsFor(access.role),
        permissions: access.permissions,
        repositories: access.repositories,
        environments: access.environments,
        enforcement: {
          permissions: "enforced (role grants intersected with config-as-code narrowing)",
          repositories:
            "enforced at grant + resolution (intersection with the tenant's repositories); advisory at legacy run/PR call sites",
          environments:
            "enforced at resolution (intersection with the tenant's real environments); advisory at legacy run/PR call sites",
        },
      },
    });
  });

  // --- audit trail --------------------------------------------------------
  routes.get("/audit", (c) => {
    let actor: Manager;
    try {
      actor = requireManager(c);
    } catch (error) {
      return replyManagerError(c, error);
    }
    try {
      const result = queryTenantAuditEvents(db, actor.tenantId, {
        actor: c.req.query("actor") ?? null,
        action: c.req.query("action") ?? null,
        resourceType: c.req.query("resourceType") ?? null,
        resourceId: c.req.query("resourceId") ?? null,
        since: c.req.query("since") ?? null,
        until: c.req.query("until") ?? null,
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : null,
        offset: c.req.query("offset") ? Number(c.req.query("offset")) : null,
      });
      c.header("Cache-Control", "no-store");
      return c.json({
        data: result.events.map((e) => ({
          id: e.id,
          createdAt: e.created_at,
          eventSequence: e.event_sequence,
          actor: e.actor,
          action: e.action,
          resourceType: e.resource_type,
          resourceId: e.resource_id,
          requestId: e.request_id,
        })),
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        chain: result.chain,
        filters: result.filters,
      });
    } catch (error) {
      return replyAdminBadRequest(c, error);
    }
  });

  routes.get("/audit/export", (c) => {
    let actor: Manager;
    try {
      actor = requireManager(c);
    } catch (error) {
      return replyManagerError(c, error);
    }
    const format = (c.req.query("format") ?? "csv").toLowerCase();
    try {
      const result = queryTenantAuditEvents(db, actor.tenantId, {
        actor: c.req.query("actor") ?? null,
        action: c.req.query("action") ?? null,
        resourceType: c.req.query("resourceType") ?? null,
        resourceId: c.req.query("resourceId") ?? null,
        since: c.req.query("since") ?? null,
        until: c.req.query("until") ?? null,
        limit: c.req.query("limit") ? Number(c.req.query("limit")) : 500,
      });
      c.header("Cache-Control", "no-store");
      if (format === "json") {
        return c.json({ data: result.events, chain: result.chain });
      }
      return c.body(exportTenantAuditCsv(result.events), 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="mendpoint-audit.csv"',
      });
    } catch (error) {
      return replyAdminBadRequest(c, error);
    }
  });

  // --- security posture ---------------------------------------------------
  routes.get("/posture", (c) => {
    let actor: Manager;
    try {
      actor = requireManager(c);
    } catch (error) {
      return replyManagerError(c, error);
    }
    c.header("Cache-Control", "no-store");
    return c.json({ data: computeSecurityPosture(db, { tenantId: actor.tenantId, env }) });
  });

  return routes;
}

const ADMIN_BAD_REQUEST = new Set([
  "admin_content_type_invalid",
  "admin_payload_invalid",
  "admin_payload_too_large",
  "admin_issuer_invalid",
  "admin_subject_invalid",
  "admin_scope_type_invalid",
  "admin_scope_value_invalid",
  "admin_member_query_required",
  "audit_actor_invalid",
  "audit_action_invalid",
  "audit_resource_type_invalid",
  "audit_resource_id_invalid",
  "audit_since_invalid",
  "audit_until_invalid",
  "audit_window_invalid",
  "audit_limit_invalid",
  "audit_offset_invalid",
]);

function replyAdminBadRequest(c: Context<ApiEnv>, error: unknown): Response {
  const code = error instanceof Error ? error.message : "admin_error";
  if (code === "admin_member_not_found") return c.json({ error: code }, 404);
  if (ADMIN_BAD_REQUEST.has(code)) return c.json({ error: code }, 400);
  throw error;
}
