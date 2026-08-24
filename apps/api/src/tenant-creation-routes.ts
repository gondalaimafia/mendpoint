import { Hono, type Context } from "hono";
import { tenantToApi, type AppDb } from "@mendpoint/db";
import { newId, nowIso } from "@mendpoint/shared";
import type { ApiEnv } from "./auth.js";
import { createTopLevelTenant, TenantCreationError } from "./tenant-creation.js";

export type TenantCreationRouteOptions = Readonly<{
  db: AppDb;
  id?: () => string;
  now?: () => string;
  onCreated?: (
    context: Context<ApiEnv>,
    tenant: ReturnType<typeof createTopLevelTenant>,
  ) => void;
}>;

function publicMessage(error: TenantCreationError): string {
  if (error.code === "tenant_fields_required") return "slug and name required";
  if (error.code === "tenant_plan_invalid") return "invalid plan";
  if (error.code === "tenant_slug_taken") return "slug taken";
  return "catalog authority required";
}

export function createTenantCreationRoutes(
  options: TenantCreationRouteOptions,
): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();
  routes.post("/", async (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req
      .json<{ slug: string; name: string; plan?: string }>()
      .catch(() => undefined);
    if (!body) return c.json({ error: "invalid json" }, 400);
    try {
      const tenant = createTopLevelTenant(options.db, {
        principal,
        input: body,
        id: options.id?.() ?? newId(),
        createdAt: options.now?.() ?? nowIso(),
      });
      options.onCreated?.(c, tenant);
      return c.json(tenantToApi(tenant), 201);
    } catch (error) {
      if (error instanceof TenantCreationError) {
        return c.json({ error: publicMessage(error) }, error.status);
      }
      console.error("tenant_creation_failed", error);
      return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
    }
  });
  return routes;
}
