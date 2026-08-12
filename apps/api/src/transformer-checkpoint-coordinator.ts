import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import type { AppDb } from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

type Runtime = Readonly<{ now(): string }>;
type Json = Record<string, unknown>;

export class TransformerCheckpointCoordinatorStore {
  constructor(private readonly db: AppDb, private readonly runtime: Runtime = { now: () => new Date().toISOString() }) {
    db.raw.exec(`
      CREATE TABLE IF NOT EXISTS transformer_checkpoint_coordinator (
        tenant_id TEXT NOT NULL, campaign_id TEXT NOT NULL, episode_id TEXT NOT NULL,
        request_digest TEXT NOT NULL, checkpoint_digest TEXT, checkpoint_json TEXT,
        lease_owner TEXT, lease_generation INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, campaign_id, episode_id, request_digest)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS transformer_checkpoint_operations (
        tenant_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, operation_kind TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL, response_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, idempotency_key)
      ) WITHOUT ROWID;
    `);
  }

  read(input: Readonly<{ tenantId: string; campaignId: string; episodeId: string; requestDigest: string }>): Json | null {
    validateScope(input);
    const row = this.db.raw.prepare(
      `SELECT checkpoint_digest, checkpoint_json FROM transformer_checkpoint_coordinator
       WHERE tenant_id = ? AND campaign_id = ? AND episode_id = ? AND request_digest = ?`,
    ).get(input.tenantId, input.campaignId, input.episodeId, input.requestDigest) as { checkpoint_digest: string | null; checkpoint_json: string | null } | undefined;
    if (!row?.checkpoint_digest || !row.checkpoint_json) return null;
    const checkpoint = parseJson(row.checkpoint_json, "coordinator_state_corrupt");
    if (checkpointDigest(checkpoint) !== row.checkpoint_digest) throw new Error("coordinator_state_corrupt");
    return Object.freeze({ status: "found", ...input, checkpointDigest: row.checkpoint_digest, checkpoint, serverTime: this.now() });
  }

  claim(workerId: string, raw: unknown): Json {
    const input = object(raw);
    exactKeys(input, ["campaignId", "episodeId", "idempotencyKey", "leaseDurationMs", "operationId", "requestDigest", "tenantId"]);
    const scope = scopeFrom(input);
    const operationId = identifier(input.operationId);
    const idempotencyKey = identifier(input.idempotencyKey);
    if (!Number.isSafeInteger(input.leaseDurationMs) || Number(input.leaseDurationMs) < 1_000 || Number(input.leaseDurationMs) > 3_600_000) throw new Error("coordinator_request_invalid");
    return this.transaction(() => {
      const fingerprint = sha256(canonical(input));
      const replay = this.replay(scope.tenantId, idempotencyKey, "claim", fingerprint);
      if (replay) return Object.freeze({ ...replay, replayed: true });
      const serverTime = this.now();
      const current = this.db.raw.prepare(
        `SELECT lease_owner, lease_generation, lease_expires_at FROM transformer_checkpoint_coordinator
         WHERE tenant_id = ? AND campaign_id = ? AND episode_id = ? AND request_digest = ?`,
      ).get(scope.tenantId, scope.campaignId, scope.episodeId, scope.requestDigest) as { lease_owner: string | null; lease_generation: number; lease_expires_at: string | null } | undefined;
      if (current?.lease_expires_at && current.lease_expires_at > serverTime) throw new Error("coordinator_lease_rejected");
      const generation = (current?.lease_generation ?? 0) + 1;
      const leaseExpiresAt = new Date(Date.parse(serverTime) + Number(input.leaseDurationMs)).toISOString();
      this.db.raw.prepare(
        `INSERT INTO transformer_checkpoint_coordinator
          (tenant_id, campaign_id, episode_id, request_digest, lease_owner, lease_generation, lease_expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, campaign_id, episode_id, request_digest) DO UPDATE SET
          lease_owner = excluded.lease_owner, lease_generation = excluded.lease_generation,
          lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at`,
      ).run(scope.tenantId, scope.campaignId, scope.episodeId, scope.requestDigest, workerId, generation, leaseExpiresAt, serverTime);
      const response = { status: "claimed", ...scope, operationId, workerId, leaseGeneration: generation, leaseExpiresAt, serverTime, replayed: false };
      this.remember(scope.tenantId, idempotencyKey, "claim", fingerprint, response);
      return Object.freeze(response);
    });
  }

  compareAndSwap(workerId: string, raw: unknown): Json {
    const input = object(raw);
    exactKeys(input, ["campaignId", "checkpointDigest", "episodeId", "expectedCheckpointDigest", "idempotencyKey", "leaseGeneration", "nextCheckpoint", "operationId", "requestDigest", "tenantId"]);
    const scope = scopeFrom(input);
    const operationId = identifier(input.operationId);
    const idempotencyKey = identifier(input.idempotencyKey);
    if (!Number.isSafeInteger(input.leaseGeneration) || Number(input.leaseGeneration) < 1 || !DIGEST.test(String(input.checkpointDigest)) || (input.expectedCheckpointDigest !== null && !DIGEST.test(String(input.expectedCheckpointDigest)))) throw new Error("coordinator_request_invalid");
    const canonicalCheckpoint = canonical(input.nextCheckpoint);
    if (sha256(canonicalCheckpoint) !== input.checkpointDigest) throw new Error("coordinator_request_invalid");
    return this.transaction(() => {
      const fingerprint = sha256(canonical(input));
      const replay = this.replay(scope.tenantId, idempotencyKey, "cas", fingerprint);
      if (replay) return Object.freeze({ ...replay, replayed: true });
      const serverTime = this.now();
      const current = this.db.raw.prepare(
        `SELECT checkpoint_digest, lease_owner, lease_generation, lease_expires_at
           FROM transformer_checkpoint_coordinator
          WHERE tenant_id = ? AND campaign_id = ? AND episode_id = ? AND request_digest = ?`,
      ).get(scope.tenantId, scope.campaignId, scope.episodeId, scope.requestDigest) as { checkpoint_digest: string | null; lease_owner: string | null; lease_generation: number; lease_expires_at: string | null } | undefined;
      if (!current || current.lease_owner !== workerId || current.lease_generation !== input.leaseGeneration || !current.lease_expires_at || current.lease_expires_at <= serverTime) throw new Error("coordinator_lease_rejected");
      if (current.checkpoint_digest !== input.expectedCheckpointDigest) throw new Error("coordinator_conflict");
      const result = this.db.raw.prepare(
        `UPDATE transformer_checkpoint_coordinator SET checkpoint_digest = ?, checkpoint_json = ?, updated_at = ?
          WHERE tenant_id = ? AND campaign_id = ? AND episode_id = ? AND request_digest = ?
            AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?
            AND checkpoint_digest IS ?`,
      ).run(String(input.checkpointDigest), canonicalCheckpoint, serverTime, scope.tenantId, scope.campaignId, scope.episodeId, scope.requestDigest, workerId, Number(input.leaseGeneration), serverTime, input.expectedCheckpointDigest === null ? null : String(input.expectedCheckpointDigest));
      if (Number(result.changes) !== 1) throw new Error("coordinator_conflict");
      const response = { status: "accepted", ...scope, operationId, checkpointDigest: input.checkpointDigest, checkpoint: input.nextCheckpoint, serverTime, replayed: false };
      this.remember(scope.tenantId, idempotencyKey, "cas", fingerprint, response);
      return Object.freeze(response);
    });
  }

  private now(): string {
    const value = this.runtime.now();
    if (!validInstant(value)) throw new Error("coordinator_clock_invalid");
    return value;
  }
  private replay(tenantId: string, key: string, kind: string, fingerprint: string): Json | null {
    const row = this.db.raw.prepare("SELECT operation_kind, request_fingerprint, response_json FROM transformer_checkpoint_operations WHERE tenant_id = ? AND idempotency_key = ?")
      .get(tenantId, key) as { operation_kind: string; request_fingerprint: string; response_json: string } | undefined;
    if (!row) return null;
    if (row.operation_kind !== kind || row.request_fingerprint !== fingerprint) throw new Error("coordinator_conflict");
    return object(parseJson(row.response_json, "coordinator_state_corrupt"));
  }
  private remember(tenantId: string, key: string, kind: string, fingerprint: string, response: Json): void {
    this.db.raw.prepare("INSERT INTO transformer_checkpoint_operations (tenant_id, idempotency_key, operation_kind, request_fingerprint, response_json) VALUES (?, ?, ?, ?, ?)")
      .run(tenantId, key, kind, fingerprint, canonical(response));
  }
  private transaction<T>(operation: () => T): T {
    const owns = !this.db.raw.isTransaction;
    if (owns) this.db.raw.exec("BEGIN IMMEDIATE");
    try { const result = operation(); if (owns) this.db.raw.exec("COMMIT"); return result; }
    catch (error) { if (owns && this.db.raw.isTransaction) this.db.raw.exec("ROLLBACK"); throw error; }
  }
}

export function createTransformerCheckpointCoordinatorRoutes(options: Readonly<{ enabled: boolean; store: TransformerCheckpointCoordinatorStore }>): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => options.enabled === true ? next() : c.json({ error: "not_found" }, 404));
  app.get("/:tenantId/:campaignId/:episodeId", (c) => route(c, () => {
    const worker = requireWorker(c);
    const scope = routeScope(c);
    void worker;
    const requestDigest = c.req.header("x-mendpoint-request-digest") ?? "";
    const value = options.store.read({ ...scope, requestDigest });
    return value ? c.json(value) : c.json({ error: "not_found" }, 404);
  }));
  app.post("/claim", async (c) => route(c, async () => {
    const worker = requireWorker(c);
    const body = await bodyJson(c);
    assertPrincipalTenant(c, body);
    if (c.req.header("x-idempotency-key") !== body.idempotencyKey) throw new Error("coordinator_request_invalid");
    return c.json(options.store.claim(worker, body));
  }));
  app.post("/compare-and-swap", async (c) => route(c, async () => {
    const worker = requireWorker(c);
    const body = await bodyJson(c);
    assertPrincipalTenant(c, body);
    if (c.req.header("x-idempotency-key") !== body.idempotencyKey) throw new Error("coordinator_request_invalid");
    return c.json(options.store.compareAndSwap(worker, body));
  }));
  return app;
}

function routeScope(c: Context<ApiEnv>) {
  const tenantId = c.req.param("tenantId");
  const principal = c.get("principal");
  if (!principal || principal.tenantId !== tenantId) throw new Error("coordinator_scope_denied");
  return { tenantId, campaignId: identifier(c.req.param("campaignId")), episodeId: identifier(c.req.param("episodeId")) };
}
function requireWorker(c: Context<ApiEnv>): string {
  const principal = c.get("principal");
  if (!principal) throw new Error("coordinator_unauthorized");
  const scopes = c.get("authScopes") ?? [];
  const workerId = c.req.header("x-mendpoint-worker-id") ?? "";
  if (!principal.id.startsWith("api-key:") || principal.role !== "agent" || (!scopes.includes("*") && !scopes.includes("transformer:worker")) || !ID.test(workerId)) throw new Error("coordinator_scope_denied");
  return workerId;
}
function assertPrincipalTenant(c: Context<ApiEnv>, input: Json): void { const principal = c.get("principal"); if (!principal || input.tenantId !== principal.tenantId) throw new Error("coordinator_scope_denied"); }
async function bodyJson(c: Context<ApiEnv>): Promise<Json> {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("coordinator_request_too_large");
  const text = await c.req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new Error("coordinator_request_too_large");
  return object(parseJson(text, "coordinator_request_invalid"));
}
async function route(c: Context<ApiEnv>, operation: () => Response | Promise<Response>): Promise<Response> {
  try { return await operation(); } catch (error) {
    const code = error instanceof Error ? error.message : "coordinator_unavailable";
    if (code === "coordinator_unauthorized") return c.json({ error: code }, 401);
    if (code === "coordinator_scope_denied") return c.json({ error: code }, 403);
    if (code === "coordinator_conflict") return c.json({ error: code }, 409);
    if (code === "coordinator_lease_rejected") return c.json({ error: code }, 412);
    if (code === "coordinator_request_too_large") return c.json({ error: code }, 413);
    if (code === "coordinator_request_invalid") return c.json({ error: code }, 400);
    return c.json({ error: "coordinator_unavailable" }, 503);
  }
}

function scopeFrom(input: Json) { const scope = { tenantId: identifier(input.tenantId), campaignId: identifier(input.campaignId), episodeId: identifier(input.episodeId), requestDigest: String(input.requestDigest) }; validateScope(scope); return scope; }
function validateScope(input: Readonly<{ tenantId: string; campaignId: string; episodeId: string; requestDigest: string }>): void { if (!ID.test(input.tenantId) || !ID.test(input.campaignId) || !ID.test(input.episodeId) || !DIGEST.test(input.requestDigest)) throw new Error("coordinator_request_invalid"); }
function identifier(value: unknown): string { if (typeof value !== "string" || !ID.test(value)) throw new Error("coordinator_request_invalid"); return value; }
function object(value: unknown): Json { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("coordinator_request_invalid"); return value as Json; }
function exactKeys(value: Json, keys: readonly string[]): void { if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new Error("coordinator_request_invalid"); }
function parseJson(value: string, code: string): unknown { try { return JSON.parse(value); } catch { throw new Error(code); } }
function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function checkpointDigest(value: unknown): string { return sha256(canonical(value)); }
function validInstant(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function canonical(value: unknown, ancestors = new WeakSet<object>(), depth = 0): string {
  if (depth > 64) throw new Error("coordinator_request_invalid");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("coordinator_request_invalid"); return JSON.stringify(value); }
  if (!value || typeof value !== "object" || ancestors.has(value)) throw new Error("coordinator_request_invalid");
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw new Error("coordinator_request_invalid");
  ancestors.add(value);
  try {
    if (array) return `[${(value as unknown[]).map((entry) => canonical(entry, ancestors, depth + 1)).join(",")}]`;
    const input = value as Json;
    const keys = Object.keys(input).sort();
    if (Reflect.ownKeys(input).length !== keys.length) throw new Error("coordinator_request_invalid");
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(input[key], ancestors, depth + 1)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
}
