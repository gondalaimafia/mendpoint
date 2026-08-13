import { createHmac, randomBytes } from "node:crypto";
import {
  createTransformerPilotAttemptCheckpointConfig,
  runTransformerAttempt,
  type ExactSourceSnapshot,
  type RecipeCommandRunner,
  type TransformerAttemptCheckpointArtifactStore,
  type TransformerAttemptCheckpointAuthorityPort,
  type TransformerAttemptCoordinatorPort,
  type TransformerAttemptPhase,
  type TransformerAttemptRunResult,
  type TransformerExecutableAttemptLease,
} from "@mendpoint/transformer";
import type { TransformerCheckpointArtifactBackend } from "./transformer-checkpoint-artifacts.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export type TransformerMultinodeTransport = Readonly<{
  request(input: Readonly<{ path: string; body: unknown; signal?: AbortSignal }>): Promise<unknown>;
}>;

export type TransformerMultinodeService = Readonly<{
  mode: "checkpoint_required";
  runOnce(): Promise<TransformerAttemptRunResult>;
}>;

export function createTransformerMultinodeService(inputConfig: Readonly<{
  enabled: boolean;
  mode: "checkpoint_required";
  workerId: string;
  tenantId: string;
  campaignId: string;
  environment: string;
  evidenceRoot: string;
  candidateRoot: string;
  leaseDurationMs: number;
  executorDigest: string;
  encryptionKey: Uint8Array;
  evidenceRefs: readonly string[];
  gateConfig?: string;
  commandRunner?: RecipeCommandRunner;
  operationSecret: Uint8Array;
}>, transport: TransformerMultinodeTransport, artifactBackend: TransformerCheckpointArtifactBackend): TransformerMultinodeService {
  if (inputConfig.enabled !== true) throw new Error("transformer_multinode_service_disabled");
  if (inputConfig.mode !== "checkpoint_required") throw new Error("transformer_multinode_checkpoint_required");
  if (![inputConfig.workerId, inputConfig.tenantId, inputConfig.campaignId].every((value) => ID.test(value)) || !inputConfig.environment.trim() || !inputConfig.evidenceRoot.trim() || !inputConfig.candidateRoot.trim() || !Number.isSafeInteger(inputConfig.leaseDurationMs) || inputConfig.leaseDurationMs < 1_000 || inputConfig.leaseDurationMs > 3_600_000 || !(inputConfig.encryptionKey instanceof Uint8Array) || inputConfig.encryptionKey.byteLength !== 32 || !(inputConfig.operationSecret instanceof Uint8Array) || inputConfig.operationSecret.byteLength < 32 || !inputConfig.executorDigest.trim() || !Array.isArray(inputConfig.evidenceRefs) || !transport || typeof transport.request !== "function") throw new Error("transformer_multinode_service_config_invalid");
  const config = Object.freeze({ ...inputConfig, encryptionKey: new Uint8Array(inputConfig.encryptionKey), operationSecret: new Uint8Array(inputConfig.operationSecret), evidenceRefs: Object.freeze([...inputConfig.evidenceRefs]) });
  const request = transport.request.bind(transport);
  const createArtifact = artifactBackend.createOnly.bind(artifactBackend);
  const readArtifact = artifactBackend.read.bind(artifactBackend);
  const markArtifact = artifactBackend.mark.bind(artifactBackend);
  let coordinatorTime: string | undefined;
  const remote = async (path: string, body: unknown, signal?: AbortSignal) => {
    const response = await request({ path, body, signal });
    if (!response || typeof response !== "object" || !("result" in response)) throw new Error("transformer_multinode_response_invalid");
    const envelope = response as { result: unknown; serverTime?: unknown };
    if (typeof envelope.serverTime !== "string" || !Number.isFinite(Date.parse(envelope.serverTime)) || new Date(Date.parse(envelope.serverTime)).toISOString() !== envelope.serverTime) throw new Error("transformer_multinode_response_invalid");
    coordinatorTime = envelope.serverTime;
    return envelope.result;
  };
  const coordinator = Object.freeze(Object.fromEntries([
    "claimNextAttempt", "renewAttemptLease", "assertCurrentAttemptFence", "recordAdaptiveAttemptUsage",
    "reserveAdaptiveModelCall", "settleAdaptiveModelCall", "recordAdaptiveCandidateHandoff",
    "completeAttempt", "recordAttemptFailure",
  ].map((operation) => [operation, (input: unknown) => remote(`/v1/transformer/attempt-coordinator/operations/${operation}`, input)]))) as TransformerAttemptCoordinatorPort;
  const authority = Object.freeze(Object.fromEntries([
    "readBindingAuthority", "readLease", "readHead", "compareAndSwapHead",
    "completeWithHead", "failWithHead", "readFailureReceipt",
  ].map((operation) => [operation, (input: unknown) => remote(`/v1/transformer/attempt-coordinator/checkpoint-authority/${operation}`, input)]))) as unknown as TransformerAttemptCheckpointAuthorityPort;
  const checkpointArtifacts: TransformerAttemptCheckpointArtifactStore = Object.freeze({
    async read(storageKey) { return readArtifact(storageKey); },
    async publishImmutableDurable(storageKey, bytes) {
      let result: "created" | "exists";
      try { result = await createArtifact(storageKey, new Uint8Array(bytes)); }
      catch (error) {
        const recovered = await readArtifact(storageKey).catch(() => null);
        if (recovered && same(recovered, bytes)) return;
        if (recovered) throw new Error("transformer_checkpoint_artifact_collision", { cause: error });
        throw error;
      }
      const readback = await readArtifact(storageKey);
      if (!readback || !same(readback, bytes)) throw new Error(result === "exists" ? "transformer_checkpoint_artifact_collision" : "transformer_checkpoint_artifact_readback_failed");
    },
    async recordPending(storageKey) { await markArtifact(storageKey, "pending"); },
    async recordReferenced(storageKey) { await markArtifact(storageKey, "referenced"); },
    async recordUnreferenced(storageKey) { await markArtifact(storageKey, "unreferenced"); },
  });
  const checkpoint = createTransformerPilotAttemptCheckpointConfig({
    authority,
    artifactStore: checkpointArtifacts,
    encryptionKey: new Uint8Array(config.encryptionKey),
    executorDigest: config.executorDigest,
    evidenceRefs: Object.freeze([...config.evidenceRefs]),
    ...(config.gateConfig === undefined ? {} : { gateConfig: config.gateConfig }),
  });
  const stable = (purpose: string) => createHmac("sha256", config.operationSecret).update(`${config.tenantId}:${config.campaignId}:${config.workerId}:${purpose}`).digest("hex");
  const leaseToken = stable("lease-token");
  const token = () => leaseToken;
  const observedAt = (_phase: TransformerAttemptPhase) => coordinatorTime ?? new Date().toISOString();
  const serviceInstanceId = randomBytes(16).toString("hex");
  let claimOrdinal = 0;
  let running = false;
  const idempotencyKey = (phase: TransformerAttemptPhase, attemptId?: string) => {
    const identity = attemptId ?? `claim:${serviceInstanceId}:${claimOrdinal}`;
    return `${config.workerId}-${phase}-${stable(`${phase}:${identity}`).slice(0, 32)}`;
  };
  return Object.freeze({
    mode: "checkpoint_required" as const,
    async runOnce() {
      if (running) throw new Error("transformer_multinode_run_in_progress");
      running = true;
      try {
        await remote("/v1/transformer/attempt-coordinator/readyz", { tenantId: config.tenantId });
        const result = await runTransformerAttempt({
          scope: { tenantId: config.tenantId, campaignId: config.campaignId, environment: config.environment },
          ...(config.gateConfig === undefined ? {} : { gateConfig: config.gateConfig }),
          coordinator,
          loadExactSource: async (lease: TransformerExecutableAttemptLease): Promise<ExactSourceSnapshot> => await remote("/v1/transformer/attempt-coordinator/source", { tenantId: config.tenantId, lease, leaseToken }) as ExactSourceSnapshot,
          evidenceRoot: config.evidenceRoot,
          candidateRoot: config.candidateRoot,
          leaseDurationMs: config.leaseDurationMs,
          observedAt,
          idempotencyKey,
          leaseToken: token,
          checkpoint,
          ...(config.commandRunner === undefined ? {} : { commandRunner: config.commandRunner }),
        });
        claimOrdinal += 1;
        return result;
      } finally {
        running = false;
      }
    },
  });
}

export function createFetchTransformerMultinodeTransport(inputConfig: Readonly<{ baseUrl: string; authToken: string; workerId: string; timeoutMs: number; maxResponseBytes: number }>): TransformerMultinodeTransport {
  let url: URL;
  try { url = new URL(inputConfig.baseUrl); } catch { throw new Error("transformer_multinode_transport_config_invalid"); }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || inputConfig.authToken.length < 32 || !ID.test(inputConfig.workerId) || !Number.isSafeInteger(inputConfig.timeoutMs) || inputConfig.timeoutMs < 1 || !Number.isSafeInteger(inputConfig.maxResponseBytes) || inputConfig.maxResponseBytes < 1) throw new Error("transformer_multinode_transport_config_invalid");
  const config = Object.freeze({ ...inputConfig });
  const baseUrl = url.toString().replace(/\/$/, "");
  return Object.freeze({ async request(input) {
    const body = JSON.stringify(input.body);
    if (Buffer.byteLength(body, "utf8") > config.maxResponseBytes) throw new Error("transformer_multinode_request_too_large");
    const controller = new AbortController();
    let rejectBoundary: ((error: Error) => void) | undefined;
    const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject; });
    const timeout = new Error("transformer_multinode_timeout");
    const timer = setTimeout(() => { controller.abort(timeout); rejectBoundary?.(timeout); }, config.timeoutMs);
    const onAbort = () => { const error = new Error("transformer_multinode_aborted"); controller.abort(input.signal?.reason ?? error); rejectBoundary?.(error); };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (input.signal?.aborted) onAbort();
      const response = await Promise.race([fetch(`${baseUrl}${input.path}`, { method: "POST", headers: { authorization: `Bearer ${config.authToken}`, "content-type": "application/json", "x-mendpoint-worker-id": config.workerId }, body, signal: controller.signal }), boundary]);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > config.maxResponseBytes) throw new Error("transformer_multinode_response_too_large");
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (response.body) for await (const chunk of response.body) { total += chunk.byteLength; if (total > config.maxResponseBytes) throw new Error("transformer_multinode_response_too_large"); chunks.push(chunk); }
      const bytes = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!response.ok) throw new Error(typeof parsed?.error === "string" ? parsed.error : "transformer_multinode_unavailable");
      return parsed;
    } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", onAbort); }
  } });
}

function same(left: Uint8Array, right: Uint8Array): boolean { if (left.byteLength !== right.byteLength) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!; return difference === 0; }
