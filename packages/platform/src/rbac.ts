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
  return {
    id: h["x-user-id"] ?? "anonymous",
    tenantId: h["x-tenant-id"] ?? "default",
    role: (h["x-role"] as Role) || "viewer",
  };
}
