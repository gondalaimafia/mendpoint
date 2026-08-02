/**
 * Multi-tenant RBAC (v0) — roles, permissions, tenant isolation checks.
 * Not a full IdP; gates API/agent actions by tenant + role.
 */
export type Role = "owner" | "admin" | "engineer" | "viewer" | "fde" | "agent";

export type Permission =
  | "graph:read"
  | "graph:write"
  | "plan:read"
  | "plan:edit"
  | "plan:execute"
  | "pr:write"
  | "outcome:label"
  | "tenant:admin"
  | "dogfood:read"
  | "sandbox:run";

const ROLE_PERMS: Record<Role, Permission[]> = {
  owner: [
    "graph:read",
    "graph:write",
    "plan:read",
    "plan:edit",
    "plan:execute",
    "pr:write",
    "outcome:label",
    "tenant:admin",
    "dogfood:read",
    "sandbox:run",
  ],
  admin: [
    "graph:read",
    "graph:write",
    "plan:read",
    "plan:edit",
    "plan:execute",
    "pr:write",
    "outcome:label",
    "tenant:admin",
    "dogfood:read",
    "sandbox:run",
  ],
  engineer: [
    "graph:read",
    "graph:write",
    "plan:read",
    "plan:edit",
    "plan:execute",
    "pr:write",
    "outcome:label",
    "dogfood:read",
    "sandbox:run",
  ],
  fde: [
    "graph:read",
    "plan:read",
    "plan:edit",
    "plan:execute",
    "pr:write",
    "outcome:label",
    "dogfood:read",
    "sandbox:run",
  ],
  viewer: ["graph:read", "plan:read", "dogfood:read"],
  agent: [
    "graph:read",
    "graph:write",
    "plan:read",
    "plan:execute",
    "sandbox:run",
    "outcome:label",
  ],
};

export type Principal = {
  id: string;
  tenantId: string;
  role: Role;
  email?: string;
};

export function permissionsFor(role: Role): Permission[] {
  return ROLE_PERMS[role] ?? [];
}

export function can(principal: Principal, perm: Permission): boolean {
  return permissionsFor(principal.role).includes(perm);
}

export function assertCan(principal: Principal, perm: Permission): void {
  if (!can(principal, perm)) {
    throw new Error(
      `rbac_denied: ${principal.id} role=${principal.role} missing ${perm}`,
    );
  }
}

export function canMutateSystemCatalog(
  principal: Principal,
  systemTenantId = process.env.MENDPOINT_SYSTEM_TENANT_ID ?? "tenant_default",
): boolean {
  return (
    principal.tenantId === systemTenantId && can(principal, "tenant:admin")
  );
}

/** Tenant isolation: resource must match principal tenant (or global empty). */
export function assertTenant(
  principal: Principal,
  resourceTenantId: string | undefined | null,
): void {
  if (!resourceTenantId || resourceTenantId === "") return;
  if (resourceTenantId !== principal.tenantId) {
    throw new Error(
      `rbac_tenant_mismatch: principal=${principal.tenantId} resource=${resourceTenantId}`,
    );
  }
}

export function parsePrincipalFromHeaders(h: {
  "x-tenant-id"?: string;
  "x-role"?: string;
  "x-user-id"?: string;
}): Principal {
  const roleRaw = (h["x-role"] ?? "engineer").toLowerCase();
  const role: Role = (
    ["owner", "admin", "engineer", "viewer", "fde", "agent"] as Role[]
  ).includes(roleRaw as Role)
    ? (roleRaw as Role)
    : "viewer";
  return {
    id: h["x-user-id"] ?? "anonymous",
    tenantId: h["x-tenant-id"] ?? "tenant_default",
    role,
  };
}

const PUBLIC_READ_PATHS = new Set([
  "/",
  "/health",
  "/live",
  "/ready",
  "/version",
  "/status",
  "/billing/plans",
  "/brands",
]);

export function isPublicRoute(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (path.startsWith("/webhooks/")) return true;
  return (m === "GET" || m === "HEAD") && PUBLIC_READ_PATHS.has(path);
}

/** Map HTTP method + path prefix → required permission (broader API RBAC). */
export function permissionForRoute(
  method: string,
  path: string,
): Permission | null {
  const m = method.toUpperCase();
  if (isPublicRoute(m, path)) return null;

  if (m === "GET" || m === "HEAD" || m === "OPTIONS") {
    // Sensitive reads still permission-mapped when X-Role is present (middleware enforces)
    if (path.startsWith("/platform/dogfood") || path.startsWith("/platform/alerts"))
      return "dogfood:read";
    if (path.startsWith("/platform/plans") || path.startsWith("/warden/plans"))
      return "plan:read";
    if (path.startsWith("/platform/scm")) return "tenant:admin";
    if (path.startsWith("/billing/")) return "tenant:admin";
    if (
      path.startsWith("/graph-learn") ||
      path.startsWith("/graph/") ||
      path === "/graph"
    )
      return "graph:read";
    if (
      path.startsWith("/keys") ||
      path.startsWith("/tenants") ||
      path.startsWith("/github/app") ||
      path.startsWith("/audit")
    )
      return "tenant:admin";
    // Authenticated reads fail closed. Public reads must be explicitly listed above.
    return "graph:read";
  }

  // Mutations
  if (path.startsWith("/platform/plans") && (m === "PATCH" || m === "POST"))
    return "plan:edit";
  if (path.startsWith("/platform/scm")) return "tenant:admin";
  if (path.startsWith("/billing/")) return "tenant:admin";
  if (path.includes("/feedback") || path.includes("/outcome"))
    return "outcome:label";
  if (path.startsWith("/prs") && m === "POST") return "pr:write";
  if (
    m === "POST" &&
    /^\/jobs\/[^/]+\/(?:retry|cancel)$/.test(path)
  )
    return "tenant:admin";
  if (path.startsWith("/platform/vm") || path.startsWith("/platform/live-sandbox") || path.startsWith("/platform/sandbox"))
    return "sandbox:run";
  if (path.startsWith("/graph-learn") && m === "POST") return "graph:write";
  if (path.startsWith("/platform/") && m === "POST") return "plan:execute";
  if (path.startsWith("/warden/") || path.startsWith("/transformer/"))
    return "plan:execute";
  if (path.startsWith("/providers") || path.startsWith("/consumers") || path.startsWith("/changes"))
    return "graph:write";
  if (
    path.startsWith("/keys") ||
    path.startsWith("/tenants") ||
    path.startsWith("/github/app")
  )
    return "tenant:admin";
  return "plan:execute";
}
