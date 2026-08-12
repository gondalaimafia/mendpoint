export type TransformerCoordinatorClientErrorCode =
  | "coordinator_disabled"
  | "coordinator_config_invalid"
  | "coordinator_checkpoint_required"
  | "coordinator_tenant_scope_denied"
  | "coordinator_request_invalid"
  | "coordinator_request_too_large"
  | "coordinator_operation_limit"
  | "coordinator_timeout"
  | "coordinator_aborted"
  | "coordinator_unauthorized"
  | "coordinator_scope_denied"
  | "coordinator_not_found"
  | "coordinator_conflict"
  | "coordinator_lease_rejected"
  | "coordinator_rate_limited"
  | "coordinator_unavailable"
  | "coordinator_response_too_large"
  | "coordinator_response_invalid";

export class TransformerCoordinatorClientError extends Error {
  constructor(public readonly code: TransformerCoordinatorClientErrorCode) {
    super(code);
    this.name = "TransformerCoordinatorClientError";
  }
}

export type TransformerCoordinatorClientConfig = Readonly<{
  enabled: boolean;
  checkpointMode: "required";
  baseUrl: string;
  authToken: string;
  workerId: string;
  tenantPrefix: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxOperations: number;
}>;

export type TransformerCoordinatorTransportRequest = Readonly<{
  url: string;
  method: "GET" | "POST";
  headers: Readonly<Record<string, string>>;
  body?: Uint8Array;
  signal: AbortSignal;
}>;

export type TransformerCoordinatorTransportResponse = Readonly<{
  status: number;
  body: Uint8Array;
}>;

export type TransformerCoordinatorTransport = Readonly<{
  request(input: TransformerCoordinatorTransportRequest): Promise<TransformerCoordinatorTransportResponse>;
}>;

export type TransformerCheckpointReadInput = Readonly<{
  tenantId: string;
  campaignId: string;
  episodeId: string;
  requestDigest: string;
  signal?: AbortSignal;
}>;

export type TransformerCheckpointCompareAndSwapInput = Readonly<{
  tenantId: string;
  campaignId: string;
  episodeId: string;
  operationId: string;
  idempotencyKey: string;
  requestDigest: string;
  expectedCheckpointDigest: string | null;
  checkpointDigest: string;
  leaseGeneration: number;
  nextCheckpoint: unknown;
  signal?: AbortSignal;
}>;

export type TransformerCoordinatorCheckpointResponse = Readonly<{
  status: "accepted";
  tenantId: string;
  campaignId: string;
  episodeId: string;
  operationId: string;
  requestDigest: string;
  checkpointDigest: string;
  serverTime?: string;
  replayed: boolean;
  checkpoint: unknown;
}>;

export type TransformerCoordinatorCheckpointReadReceipt = Readonly<{
  status: "found";
  tenantId: string;
  campaignId: string;
  episodeId: string;
  requestDigest: string;
  checkpointDigest: string;
  serverTime?: string;
  checkpoint: unknown;
}>;

export type TransformerCheckpointLeaseClaimInput = Readonly<{
  tenantId: string;
  campaignId: string;
  episodeId: string;
  requestDigest: string;
  operationId: string;
  idempotencyKey: string;
  leaseDurationMs: number;
  signal?: AbortSignal;
}>;

export type TransformerCheckpointLeaseReceipt = Readonly<{
  status: "claimed";
  tenantId: string;
  campaignId: string;
  episodeId: string;
  requestDigest: string;
  operationId: string;
  workerId: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  serverTime: string;
  replayed: boolean;
}>;

export type TransformerCoordinatorClient = Readonly<{
  mode: "checkpoint_required";
  claimCheckpointLease(input: TransformerCheckpointLeaseClaimInput): Promise<TransformerCheckpointLeaseReceipt>;
  readCheckpoint(input: TransformerCheckpointReadInput): Promise<TransformerCoordinatorCheckpointReadReceipt | null>;
  compareAndSwapCheckpoint(input: TransformerCheckpointCompareAndSwapInput): Promise<TransformerCoordinatorCheckpointResponse>;
}>;

const CONFIG_KEYS = ["authToken", "baseUrl", "checkpointMode", "enabled", "maxOperations", "maxResponseBytes", "tenantPrefix", "timeoutMs", "workerId"];
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const TENANT_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,198}[._-]$/;

export function createTransformerCoordinatorClient(config: TransformerCoordinatorClientConfig, transport: TransformerCoordinatorTransport): TransformerCoordinatorClient {
  validateConfig(config, transport);
  const settings = Object.freeze({
    authToken: config.authToken,
    baseUrl: new URL(config.baseUrl).toString().replace(/\/$/, ""),
    maxOperations: config.maxOperations,
    maxResponseBytes: config.maxResponseBytes,
    tenantPrefix: config.tenantPrefix,
    timeoutMs: config.timeoutMs,
    workerId: config.workerId,
  });
  const request = transport.request.bind(transport);
  let operations = 0;

  const authorizeTenant = (tenantId: string): void => {
    if (!ID.test(tenantId) || !tenantId.startsWith(settings.tenantPrefix)) fail("coordinator_tenant_scope_denied");
  };
  const reserve = (): void => {
    if (operations >= settings.maxOperations) fail("coordinator_operation_limit");
    operations += 1;
  };
  const send = async (path: string, method: "GET" | "POST", headers: Record<string, string>, body: Uint8Array | undefined, signal: AbortSignal | undefined): Promise<TransformerCoordinatorTransportResponse> => {
    if (body && body.byteLength > settings.maxResponseBytes) fail("coordinator_request_too_large");
    if (signal?.aborted) fail("coordinator_aborted");
    const controller = new AbortController();
    let rejectInterruption: ((error: TransformerCoordinatorClientError) => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterruption = reject; });
    const interrupt = (code: "coordinator_timeout" | "coordinator_aborted", reason?: unknown): void => {
      rejectInterruption?.(new TransformerCoordinatorClientError(code));
      controller.abort(reason);
    };
    const abortFromCaller = () => interrupt("coordinator_aborted", signal?.reason);
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => interrupt("coordinator_timeout", new Error("timeout")), settings.timeoutMs);
    try {
      const response = await Promise.race([request({
        url: `${settings.baseUrl}${path}`,
        method,
        headers: Object.freeze({ authorization: `Bearer ${settings.authToken}`, "x-mendpoint-worker-id": settings.workerId, ...headers }),
        ...(body === undefined ? {} : { body: new Uint8Array(body) }),
        signal: controller.signal,
      }), interrupted]);
      if (!Number.isInteger(response.status) || !(response.body instanceof Uint8Array)) fail("coordinator_response_invalid");
      if (response.body.byteLength > settings.maxResponseBytes) fail("coordinator_response_too_large");
      return response;
    } catch (error) {
      if (error instanceof TransformerCoordinatorClientError) throw error;
      if (signal?.aborted) fail("coordinator_aborted");
      fail("coordinator_unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  };

  return Object.freeze({
    mode: "checkpoint_required" as const,
    async claimCheckpointLease(input) {
      authorizeTenant(input.tenantId);
      if (!ID.test(input.campaignId) || !ID.test(input.episodeId) || !ID.test(input.operationId) || !ID.test(input.idempotencyKey) || !DIGEST.test(input.requestDigest) || !Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1_000 || input.leaseDurationMs > 3_600_000) fail("coordinator_request_invalid");
      const body = encode({ tenantId: input.tenantId, campaignId: input.campaignId, episodeId: input.episodeId, requestDigest: input.requestDigest, operationId: input.operationId, idempotencyKey: input.idempotencyKey, leaseDurationMs: input.leaseDurationMs });
      reserve();
      const response = await send("/v1/transformer/checkpoints/claim", "POST", { "content-type": "application/json", "x-idempotency-key": input.idempotencyKey }, body, input.signal);
      mapStatus(response.status);
      const parsed = decodeObject(response.body) as Partial<TransformerCheckpointLeaseReceipt>;
      if (Object.keys(parsed).sort().join(",") !== "campaignId,episodeId,leaseExpiresAt,leaseGeneration,operationId,replayed,requestDigest,serverTime,status,tenantId,workerId" || parsed.status !== "claimed" || parsed.tenantId !== input.tenantId || parsed.campaignId !== input.campaignId || parsed.episodeId !== input.episodeId || parsed.operationId !== input.operationId || parsed.requestDigest !== input.requestDigest || parsed.workerId !== settings.workerId || !Number.isSafeInteger(parsed.leaseGeneration) || Number(parsed.leaseGeneration) < 1 || typeof parsed.replayed !== "boolean" || !validInstant(parsed.serverTime) || !validInstant(parsed.leaseExpiresAt) || Date.parse(parsed.leaseExpiresAt!) <= Date.parse(parsed.serverTime!)) fail("coordinator_response_invalid");
      return Object.freeze(parsed as TransformerCheckpointLeaseReceipt);
    },
    async readCheckpoint(input) {
      authorizeTenant(input.tenantId);
      if (!ID.test(input.campaignId) || !ID.test(input.episodeId) || !DIGEST.test(input.requestDigest)) fail("coordinator_request_invalid");
      reserve();
      const response = await send(`/v1/transformer/checkpoints/${encodeURIComponent(input.tenantId)}/${encodeURIComponent(input.campaignId)}/${encodeURIComponent(input.episodeId)}`, "GET", { "x-mendpoint-request-digest": input.requestDigest }, undefined, input.signal);
      if (response.status === 404) return null;
      mapStatus(response.status);
      const parsed = decodeObject(response.body);
      const readKeys = Object.keys(parsed).sort().join(",");
      if ((readKeys !== "campaignId,checkpoint,checkpointDigest,episodeId,requestDigest,status,tenantId" && readKeys !== "campaignId,checkpoint,checkpointDigest,episodeId,requestDigest,serverTime,status,tenantId") || parsed.status !== "found" || parsed.tenantId !== input.tenantId || parsed.campaignId !== input.campaignId || parsed.episodeId !== input.episodeId || parsed.requestDigest !== input.requestDigest || !DIGEST.test(String(parsed.checkpointDigest)) || !("checkpoint" in parsed) || ("serverTime" in parsed && !validInstant(parsed.serverTime))) fail("coordinator_response_invalid");
      if (checkpointDigest(parsed.checkpoint, "coordinator_response_invalid") !== parsed.checkpointDigest) fail("coordinator_response_invalid");
      return freezeReceipt(parsed as TransformerCoordinatorCheckpointReadReceipt);
    },
    async compareAndSwapCheckpoint(input) {
      authorizeTenant(input.tenantId);
      if (!ID.test(input.campaignId) || !ID.test(input.episodeId) || !ID.test(input.operationId) || !ID.test(input.idempotencyKey) || !DIGEST.test(input.requestDigest) || !DIGEST.test(input.checkpointDigest) || !Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration < 1 || (input.expectedCheckpointDigest !== null && !DIGEST.test(input.expectedCheckpointDigest))) fail("coordinator_request_invalid");
      if (checkpointDigest(input.nextCheckpoint, "coordinator_request_invalid") !== input.checkpointDigest) fail("coordinator_request_invalid");
      const body = encode({
        tenantId: input.tenantId,
        campaignId: input.campaignId,
        episodeId: input.episodeId,
        operationId: input.operationId,
        idempotencyKey: input.idempotencyKey,
        requestDigest: input.requestDigest,
        expectedCheckpointDigest: input.expectedCheckpointDigest,
        checkpointDigest: input.checkpointDigest,
        leaseGeneration: input.leaseGeneration,
        nextCheckpoint: input.nextCheckpoint,
      });
      reserve();
      const response = await send("/v1/transformer/checkpoints/compare-and-swap", "POST", { "content-type": "application/json", "x-idempotency-key": input.idempotencyKey }, body, input.signal);
      mapStatus(response.status);
      const parsed = decodeObject(response.body) as Partial<TransformerCoordinatorCheckpointResponse>;
      const casKeys = Object.keys(parsed).sort().join(",");
      if ((casKeys !== "campaignId,checkpoint,checkpointDigest,episodeId,operationId,replayed,requestDigest,status,tenantId" && casKeys !== "campaignId,checkpoint,checkpointDigest,episodeId,operationId,replayed,requestDigest,serverTime,status,tenantId") || parsed.status !== "accepted" || parsed.tenantId !== input.tenantId || parsed.campaignId !== input.campaignId || parsed.episodeId !== input.episodeId || parsed.operationId !== input.operationId || parsed.requestDigest !== input.requestDigest || parsed.checkpointDigest !== input.checkpointDigest || typeof parsed.replayed !== "boolean" || !("checkpoint" in parsed) || ("serverTime" in parsed && !validInstant(parsed.serverTime))) fail("coordinator_response_invalid");
      if (checkpointDigest(parsed.checkpoint, "coordinator_response_invalid") !== input.checkpointDigest) fail("coordinator_response_invalid");
      return freezeReceipt(parsed as TransformerCoordinatorCheckpointResponse);
    },
  });
}

function validateConfig(config: TransformerCoordinatorClientConfig, transport: TransformerCoordinatorTransport): void {
  if (!config || typeof config !== "object" || Object.keys(config).sort().join(",") !== CONFIG_KEYS.join(",")) fail("coordinator_config_invalid");
  if (config.enabled !== true) fail("coordinator_disabled");
  if (config.checkpointMode !== "required") fail("coordinator_checkpoint_required");
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { fail("coordinator_config_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname || url.pathname !== "/" || !hasText(config.authToken) || config.authToken.length < 32 || !ID.test(config.workerId) || !TENANT_PREFIX.test(config.tenantPrefix) || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || !Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes < 1 || !Number.isSafeInteger(config.maxOperations) || config.maxOperations < 1 || !transport || typeof transport.request !== "function") fail("coordinator_config_invalid");
}

function mapStatus(status: number): void {
  if (status >= 200 && status < 300) return;
  if (status === 401) fail("coordinator_unauthorized");
  if (status === 403) fail("coordinator_scope_denied");
  if (status === 404) fail("coordinator_not_found");
  if (status === 409) fail("coordinator_conflict");
  if (status === 412) fail("coordinator_lease_rejected");
  if (status === 429) fail("coordinator_rate_limited");
  if (status >= 500) fail("coordinator_unavailable");
  fail("coordinator_response_invalid");
}

function encode(value: unknown): Uint8Array { try { return new TextEncoder().encode(canonicalJson(value, new WeakSet<object>(), 0)); } catch { fail("coordinator_request_invalid"); } }
function decodeObject(bytes: Uint8Array): Record<string, unknown> { try { const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); if (!value || typeof value !== "object" || Array.isArray(value)) fail("coordinator_response_invalid"); return value; } catch (error) { if (error instanceof TransformerCoordinatorClientError) throw error; fail("coordinator_response_invalid"); } }
function checkpointDigest(value: unknown, code: "coordinator_request_invalid" | "coordinator_response_invalid"): string {
  try {
    const canonical = canonicalJson(value, new WeakSet<object>(), 1);
    return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
  } catch {
    fail(code);
  }
}
function canonicalJson(value: unknown, ancestors: WeakSet<object>, depth: number): string {
  if (depth > 64) throw new Error("checkpoint_depth_exceeded");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("checkpoint_number_invalid");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("checkpoint_value_invalid");
  if (ancestors.has(value)) throw new Error("checkpoint_cycle");
  const isArray = Array.isArray(value);
  if ((isArray && Object.getPrototypeOf(value) !== Array.prototype) || (!isArray && Object.getPrototypeOf(value) !== Object.prototype)) throw new Error("checkpoint_prototype_invalid");
  ancestors.add(value);
  try {
    if (isArray) {
      const array = value as unknown[];
      const ownKeys = Reflect.ownKeys(array);
      if (ownKeys.some((key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))) || Object.keys(array).length !== array.length) throw new Error("checkpoint_array_invalid");
      const values: string[] = [];
      for (let index = 0; index < array.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("checkpoint_property_invalid");
        values.push(canonicalJson(descriptor.value, ancestors, depth + 1));
      }
      return `[${values.join(",")}]`;
    }
    const object = value as Record<string, unknown>;
    const ownKeys = Reflect.ownKeys(object);
    if (ownKeys.some((key) => typeof key !== "string")) throw new Error("checkpoint_key_invalid");
    const keys = ownKeys as string[];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("checkpoint_property_invalid");
    }
    keys.sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors, depth + 1)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
function freezeReceipt<T extends TransformerCoordinatorCheckpointReadReceipt | TransformerCoordinatorCheckpointResponse>(receipt: T): T {
  freezeJson(receipt.checkpoint);
  return Object.freeze(receipt);
}
function freezeJson(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}
function hasText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function validInstant(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value; }
function fail(code: TransformerCoordinatorClientErrorCode): never { throw new TransformerCoordinatorClientError(code); }
import { createHash } from "node:crypto";
