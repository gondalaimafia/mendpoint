import { Hono, type Context } from "hono";
import {
  createTransformerPilotCheckpointAuthority,
  type TransformerDraftDeliveryLease,
  type TransformerPilotExecutionStore,
  type TransformerExecutableAttemptLease,
} from "@mendpoint/transformer";
import type { ExactSourceSnapshot } from "@mendpoint/transformer";
import { parseTransformerGateConfig } from "@mendpoint/ops";
import type { ApiEnv } from "./auth.js";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const OPERATIONS = [
  "claimNextAttempt", "renewAttemptLease", "assertCurrentAttemptFence",
  "recordAdaptiveAttemptUsage", "reserveAdaptiveModelCall", "settleAdaptiveModelCall",
  "recordAdaptiveCandidateHandoff", "completeAttempt", "recordAttemptFailure",
  "claimNextDraftDelivery", "assertCurrentDraftDeliveryFence", "completeDraftDelivery",
  "reconcileWave",
] as const;
const AUTHORITY_OPERATIONS = [
  "readBindingAuthority", "readLease", "readHead", "compareAndSwapHead",
  "completeWithHead", "failWithHead", "readFailureReceipt",
] as const;

type Operation = typeof OPERATIONS[number];
type AuthorityOperation = typeof AUTHORITY_OPERATIONS[number];
type Json = Record<string, unknown>;

export type TransformerDraftRepositoryTarget = Readonly<{
  owner: string;
  repo: string;
  baseBranch: string;
  installationId: number;
  remoteRepositoryId: number;
}>;

export function createTransformerAttemptCoordinatorRoutes(options: Readonly<{
  enabled: boolean;
  store: TransformerPilotExecutionStore;
  now?: () => string;
  gateConfig?: string;
  loadExactSource(lease: TransformerExecutableAttemptLease, observedAt: string): ExactSourceSnapshot | Promise<ExactSourceSnapshot>;
  resolveDraftRepository?(input: Readonly<{
    tenantId: string;
    repositoryId: string;
    snapshotId: string;
    expectedBaseRevision: string;
  }>): TransformerDraftRepositoryTarget | Promise<TransformerDraftRepositoryTarget>;
}>): Hono<ApiEnv> {
  if (options.enabled) parseTransformerGateConfig(options.gateConfig);
  const app = new Hono<ApiEnv>();
  const now = options.now ?? (() => new Date().toISOString());
  const authority = createTransformerPilotCheckpointAuthority(options.store);
  app.use("*", async (c, next) => options.enabled === true ? next() : c.json({ error: "not_found" }, 404));
  app.post("/readyz", (c) => handled(c, async () => {
    requireWorker(c);
    return c.json({ result: { ready: true }, serverTime: serverTime(now) });
  }));
  app.post("/operations/:operation", async (c) => handled(c, async () => {
    requireWorker(c);
    const operation = c.req.param("operation") as Operation;
    if (!OPERATIONS.includes(operation)) throw new Error("coordinator_not_found");
    const input = await request(c);
    assertTenant(c, input);
    const observedAt = serverTime(now);
    const bound = { ...input, observedAt, gateConfig: options.gateConfig };
    const method = options.store[operation] as unknown as (value: Json) => unknown;
    const result = await method.call(options.store, bound);
    return c.json({ result: result === undefined ? null : result, serverTime: observedAt });
  }));
  app.post("/checkpoint-authority/:operation", async (c) => handled(c, async () => {
    requireWorker(c);
    const operation = c.req.param("operation") as AuthorityOperation;
    if (!AUTHORITY_OPERATIONS.includes(operation)) throw new Error("coordinator_not_found");
    const input = await request(c);
    assertTenant(c, input);
    const observedAt = serverTime(now);
    if (operation === "completeWithHead" || operation === "failWithHead") {
      const completion = input.completionIntent as Json | undefined;
      const unitId = operation === "completeWithHead" ? completion?.unitId : input.unitId;
      const leaseGeneration = operation === "completeWithHead" ? completion?.leaseGeneration : input.leaseGeneration;
      const clientObservedAt = String(input.observedAt ?? "");
      if (typeof unitId !== "string" || !Number.isSafeInteger(leaseGeneration) || !Number.isFinite(Date.parse(clientObservedAt))) throw new Error("coordinator_request_invalid");
      const unit = options.store.getCampaign(String(input.tenantId), String(input.campaignId))?.units.find((candidate) => candidate.id === unitId);
      const exactReplayState = operation === "completeWithHead" ? unit?.state === "executed" : unit?.state === "failed";
      if (Math.abs(Date.parse(clientObservedAt) - Date.parse(observedAt)) > 60_000 && !exactReplayState) throw new Error("coordinator_request_invalid");
      try {
        options.store.assertCurrentAttemptFence({ tenantId: String(input.tenantId), campaignId: String(input.campaignId), unitId, leaseGeneration: Number(leaseGeneration), leaseToken: String(input.leaseToken ?? ""), observedAt });
      } catch {
        if (!exactReplayState) throw new Error("coordinator_fence_conflict");
      }
    }
    const preserveBoundTime = operation === "completeWithHead" || operation === "failWithHead";
    const bound = { ...input, ...(!preserveBoundTime && operation !== "readHead" && operation !== "readBindingAuthority" ? { observedAt } : {}), gateConfig: options.gateConfig };
    const method = authority[operation] as unknown as (value: Json) => unknown;
    const result = await method.call(authority, bound);
    return c.json({ result: result === undefined ? null : result, serverTime: observedAt });
  }));
  app.post("/source", async (c) => handled(c, async () => {
    requireWorker(c);
    const input = await request(c);
    assertTenant(c, input);
    const lease = input.lease as TransformerExecutableAttemptLease;
    if (!lease || typeof lease !== "object" || lease.tenantId !== input.tenantId) throw new Error("coordinator_request_invalid");
    const observedAt = serverTime(now);
    try {
      options.store.assertCurrentAttemptFence({
        tenantId: lease.tenantId,
        campaignId: lease.campaignId,
        unitId: lease.unitId,
        leaseGeneration: lease.leaseGeneration,
        leaseToken: String(input.leaseToken ?? ""),
        observedAt,
      });
    } catch { throw new Error("coordinator_fence_conflict"); }
    const source = await options.loadExactSource(lease, observedAt);
    if (source.repositoryId !== lease.snapshot.repositoryId || source.revision !== lease.snapshot.revision || source.digest !== lease.snapshot.digest) throw new Error("coordinator_source_binding_invalid");
    return c.json({ result: source, serverTime: observedAt });
  }));
  app.post("/draft-source", async (c) => handled(c, async () => {
    requireWorker(c);
    const input = await request(c);
    assertTenant(c, input);
    const lease = input.lease as TransformerDraftDeliveryLease;
    if (!lease || typeof lease !== "object" || lease.type !== "deliver_draft" ||
        lease.tenantId !== input.tenantId || typeof input.leaseToken !== "string") {
      throw new Error("coordinator_request_invalid");
    }
    const observedAt = serverTime(now);
    try {
      options.store.assertCurrentDraftDeliveryFence({
        tenantId: lease.tenantId,
        campaignId: lease.campaignId,
        unitId: lease.unitId,
        deliveryId: lease.deliveryId,
        leaseGeneration: lease.leaseGeneration,
        leaseToken: input.leaseToken,
        observedAt,
        gateConfig: options.gateConfig,
      });
    } catch { throw new Error("coordinator_fence_conflict"); }
    const authoritativeLease = options.store.readCurrentDraftDeliveryLease({
      tenantId: lease.tenantId,
      campaignId: lease.campaignId,
      unitId: lease.unitId,
      deliveryId: lease.deliveryId,
    });
    if (JSON.stringify(authoritativeLease) !== JSON.stringify(lease)) {
      throw new Error("coordinator_request_invalid");
    }
    const attemptLease: TransformerExecutableAttemptLease = Object.freeze({
      type: "execute_recipe",
      tenantId: lease.tenantId,
      campaignId: lease.campaignId,
      unitId: lease.unitId,
      attemptNumber: lease.checkpointHead.attemptNumber,
      leaseGeneration: lease.checkpointHead.writerLeaseGeneration,
      leaseTokenDigest: lease.checkpointHead.writerLeaseTokenDigest,
      leaseExpiresAt: lease.leaseExpiresAt,
      startedAt: lease.leasedAt,
      snapshot: lease.snapshot,
      candidateRevision: lease.candidateRevision,
      candidateDigest: lease.candidateDigest,
      changedPaths: lease.changedPaths,
      recipe: lease.recipe,
      constraintVersion: lease.constraintVersion,
      constraintDigest: lease.constraintDigest,
      gateEvidenceRefs: lease.evidenceRefs,
      adaptiveBudgetRemaining: Object.freeze({
        attempts: 0, plannerCalls: 0, modelCalls: 0, inputTokens: 0,
        outputTokens: 0, totalTokens: 0, actualCostUsd: 0, wallTimeMs: 0,
      }),
    });
    const [source, target] = await Promise.all([
      options.loadExactSource(attemptLease, observedAt),
      options.resolveDraftRepository?.({
        tenantId: lease.tenantId,
        repositoryId: lease.snapshot.repositoryId,
        snapshotId: lease.snapshot.snapshotId,
        expectedBaseRevision: lease.snapshot.revision,
      }) ?? Promise.reject(new Error("coordinator_draft_repository_unavailable")),
    ]);
    if (source.repositoryId !== lease.snapshot.repositoryId ||
        source.revision !== lease.snapshot.revision || source.digest !== lease.snapshot.digest) {
      throw new Error("coordinator_source_binding_invalid");
    }
    return c.json({ result: { source, target }, serverTime: observedAt });
  }));
  app.post("/draft-observations", async (c) => handled(c, async () => {
    requireWorker(c);
    const input = await request(c);
    assertTenant(c, input);
    if (typeof input.campaignId !== "string" || !input.campaignId) {
      throw new Error("coordinator_request_invalid");
    }
    const observedAt = serverTime(now);
    const drafts = options.store.listCurrentWaveDeliveredDrafts({
      tenantId: String(input.tenantId),
      campaignId: input.campaignId,
    });
    if (!drafts.length) return c.json({ result: [], serverTime: observedAt });
    if (!options.resolveDraftRepository) {
      throw new Error("coordinator_draft_repository_unavailable");
    }
    const result = await Promise.all(drafts.map(async (draft) => Object.freeze({
      draft,
      target: await options.resolveDraftRepository!({
        tenantId: draft.tenantId,
        repositoryId: draft.snapshot.repositoryId,
        snapshotId: draft.snapshot.snapshotId,
        expectedBaseRevision: draft.snapshot.revision,
      }),
    })));
    return c.json({ result, serverTime: observedAt });
  }));
  return app;
}

function requireWorker(c: Context<ApiEnv>): void {
  const principal = c.get("principal");
  const scopes = c.get("authScopes") ?? [];
  if (!principal?.id.startsWith("api-key:") || principal.role !== "agent" || (!scopes.includes("*") && !scopes.includes("transformer:worker"))) throw new Error("coordinator_unauthorized");
}
function assertTenant(c: Context<ApiEnv>, input: Json): void { if (input.tenantId !== c.get("principal")?.tenantId) throw new Error("coordinator_scope_denied"); }
async function request(c: Context<ApiEnv>): Promise<Json> {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("coordinator_request_too_large");
  const text = await c.req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new Error("coordinator_request_too_large");
  try { const value = JSON.parse(text); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value as Json; } catch { throw new Error("coordinator_request_invalid"); }
}
function serverTime(now: () => string): string { const value = now(); if (!Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) throw new Error("coordinator_clock_invalid"); return value; }
async function handled(c: Context<ApiEnv>, operation: () => Promise<Response>): Promise<Response> {
  try { return await operation(); } catch (error) {
    const code = error instanceof Error ? error.message : "coordinator_unavailable";
    if (code === "coordinator_unauthorized") return c.json({ error: code }, 401);
    if (code === "coordinator_scope_denied") return c.json({ error: code }, 403);
    if (code === "coordinator_not_found") return c.json({ error: code }, 404);
    if (code === "coordinator_request_invalid") return c.json({ error: code }, 400);
    if (code.includes("fence") || code.includes("lease") || code.includes("conflict") || code.includes("idempotency")) return c.json({ error: "coordinator_conflict" }, 409);
    return c.json({ error: "coordinator_unavailable" }, 503);
  }
}
