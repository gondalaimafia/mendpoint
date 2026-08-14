/**
 * Self-serve Warden scan trigger (S1.2).
 *
 * A tenant-scoped, flag-gated endpoint that lets a customer kick off an impact
 * scan themselves instead of running `npm run demo`. It reuses the existing
 * pipeline.fanout enqueue path (the same job the worker already runs for
 * publish-version / /jobs/fanout): it resolves a provider the tenant already
 * monitors, then enqueues one deterministic pipeline.fanout job keyed by the
 * caller's Idempotency-Key so a double-click never double-runs. The whole route
 * is inert (404) unless MENDPOINT_SELF_SERVE_WARDEN=1, so default behavior stays
 * byte-identical.
 */
import {
  enqueueJob,
  getJob,
  listConsumersForProvider,
  listTenantMonitoredProviders,
  type AppDb,
} from "@mendpoint/db";
import { nowIso, resolveRenamedEnv } from "@mendpoint/shared";
import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import type { ApiEnv } from "./auth.js";

// Same idempotency-key shape the Warden run trigger (/agent/runs) enforces.
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function selfServeWardenEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveRenamedEnv(env, "MENDPOINT_SELF_SERVE_FETTLER") === "1";
}

export type SelfServeScanRoutesOptions = Readonly<{
  db: AppDb;
  enabled: boolean;
  now?: () => string;
}>;

function scanTenantId(c: Context<ApiEnv>): string {
  const principal = c.get("principal");
  if (!principal) throw new Error("authenticated_principal_required");
  // A blank tenantId must never reach a tenant-scoped query where a fail-open
  // branch could drop the filter and read across tenants. Fail closed instead.
  if (principal.tenantId.trim() === "") throw new Error("tenant_scope_required");
  return principal.tenantId;
}

async function readProviderSlug(c: Context<ApiEnv>): Promise<string | undefined> {
  const raw = (await c.req.text()).trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("scan_payload_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("scan_payload_invalid");
  }
  const value = parsed as Record<string, unknown>;
  if (value.providerSlug === undefined || value.providerSlug === null) return undefined;
  if (typeof value.providerSlug !== "string" || value.providerSlug.trim() === "") {
    throw new Error("scan_provider_slug_invalid");
  }
  return value.providerSlug.trim();
}

export function createSelfServeScanRoutes(options: SelfServeScanRoutesOptions): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  if (!options.enabled) {
    routes.all("*", (c) => c.json({ error: "not_found" }, 404));
    return routes;
  }
  const now = options.now ?? nowIso;
  const { db } = options;

  routes.post("/", async (c) => {
    let tenantId: string;
    try {
      tenantId = scanTenantId(c);
    } catch (error) {
      const code = error instanceof Error ? error.message : "authenticated_principal_required";
      return c.json({ error: code }, 401);
    }

    const idempotencyKey = c.req.header("idempotency-key")?.trim() ?? "";
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      return c.json({ error: "Idempotency-Key header must contain 8 to 128 safe characters" }, 400);
    }

    let requestedSlug: string | undefined;
    try {
      requestedSlug = await readProviderSlug(c);
    } catch (error) {
      const code = error instanceof Error ? error.message : "scan_payload_invalid";
      return c.json({ error: code }, 400);
    }

    // Resolve the provider strictly within the tenant's own monitored surface.
    // A caller may only scan a provider that at least one of their consumers
    // monitors, so tenant A can never trigger a run on tenant B's provider.
    let providerSlug: string;
    if (requestedSlug) {
      if (listConsumersForProvider(db, requestedSlug, tenantId).length === 0) {
        return c.json({ error: "provider not monitored by tenant" }, 404);
      }
      providerSlug = requestedSlug;
    } else {
      const monitored = listTenantMonitoredProviders(db, tenantId);
      if (monitored.length === 0) {
        return c.json({ error: "no monitored providers to scan" }, 409);
      }
      providerSlug = monitored[0]!.providerSlug;
    }

    // Deterministic job id so a double-click (same Idempotency-Key) collapses to
    // one pipeline.fanout run for this tenant.
    const identity = createHash("sha256")
      .update(`${tenantId}\n${idempotencyKey}`)
      .digest("hex");
    const jobId = `scan-job-${identity.slice(0, 32)}`;
    const payload = { providerSlug, tenantId };
    const payloadJson = JSON.stringify(payload);
    const createdAt = now();

    db.raw.exec("BEGIN IMMEDIATE");
    try {
      const existing = getJob(db, jobId, tenantId);
      if (existing) {
        if (existing.type !== "pipeline.fanout" || existing.payload_json !== payloadJson) {
          db.raw.exec("ROLLBACK");
          return c.json({ error: "idempotency key was already used for a different scan" }, 409);
        }
        db.raw.exec("COMMIT");
        return c.json(
          {
            jobId,
            providerSlug,
            type: "pipeline.fanout",
            status: existing.status,
            replayed: true,
          },
          202,
        );
      }
      enqueueJob(db, {
        id: jobId,
        tenantId,
        type: "pipeline.fanout",
        payload,
        createdAt,
      });
      db.raw.exec("COMMIT");
    } catch (error) {
      db.raw.exec("ROLLBACK");
      throw error;
    }

    return c.json(
      { jobId, providerSlug, type: "pipeline.fanout", status: "pending", replayed: false },
      202,
    );
  });

  return routes;
}
