import type { Principal } from "@mendpoint/platform";

export function isHumanWardenReviewer(
  principal: Principal | undefined,
  trustPrincipal: Readonly<{ kind: string; tenant_id: string }> | undefined,
  tenantId: string,
  apiKeyId?: string,
): boolean {
  return Boolean(
    principal &&
    !apiKeyId &&
    principal.tenantId === tenantId &&
    principal.id.startsWith("human:") &&
    trustPrincipal?.kind === "human" &&
    trustPrincipal.tenant_id === tenantId,
  );
}
