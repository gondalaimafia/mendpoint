import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { createAppDelivery, loadAppCredentials } from "@mendpoint/github";
import { resolveRenamedEnv } from "@mendpoint/shared";
import {
  createFilesystemTransformerArtifactBackend,
  createS3CompatibleTransformerArtifactBackend,
} from "./transformer-shared-artifact-backends.js";
import { createSigV4S3ArtifactTransport } from "./transformer-s3-transport.js";
import {
  createFetchTransformerMultinodeTransport,
  createTransformerMultinodeService,
} from "./transformer-multinode-service.js";
import {
  resolveTransformerCoordinatorUrl,
  resolveTransformerS3Config,
  resolveTransformerWorkerId,
} from "./transformer-production-profile.js";

export type RunningTransformerService = Readonly<{ close(): Promise<void>; readinessUrl: string }>;

type ReadinessProbeStage = "coordinator" | "artifact" | "work_cycle";

class ReadinessProbeError extends Error {
  readonly stage: ReadinessProbeStage;

  constructor(stage: ReadinessProbeStage, code: string) {
    super(code);
    this.stage = stage;
  }
}

export async function runTransformerServiceCli(env: NodeJS.ProcessEnv = process.env): Promise<RunningTransformerService> {
  if (resolveRenamedEnv(env, "MENDPOINT_REGAUGE_MULTINODE_ENABLED") !== "1") throw new Error("transformer_multinode_service_disabled");
  const workerId = resolveTransformerWorkerId(env);
  const tenantId = required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_TENANT_ID"), "transformer_multinode_tenant_required");
  const campaignId = required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_CAMPAIGN_ID"), "transformer_multinode_campaign_required");
  const dataRoot = resolve(required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_PRIVATE_DATA_ROOT"), "transformer_multinode_data_root_required"));
  const encryptionKey = decodeKey(required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_CHECKPOINT_KEY"), "transformer_multinode_checkpoint_key_required"));
  const intervalMs = integer(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_INTERVAL_MS") ?? "5000", 100, 60_000, "transformer_multinode_interval_invalid");
  const readinessPort = integer(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_READINESS_PORT") ?? "9465", 1, 65_535, "transformer_multinode_readiness_port_invalid");
  const readinessHost = readinessAddress(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_READINESS_HOST") ?? "127.0.0.1");
  const transport = createFetchTransformerMultinodeTransport({
    baseUrl: resolveTransformerCoordinatorUrl(env),
    authToken: required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_COORDINATOR_TOKEN"), "transformer_multinode_coordinator_token_required"),
    workerId,
    timeoutMs: integer(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_COORDINATOR_TIMEOUT_MS") ?? "30000", 1, 120_000, "transformer_multinode_timeout_invalid"),
    maxResponseBytes: integer(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_MAX_RESPONSE_BYTES") ?? String(64 * 1024 * 1024), 1_024, 128 * 1024 * 1024, "transformer_multinode_response_limit_invalid"),
  });
  const artifactMode = required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_ARTIFACT_BACKEND"), "transformer_multinode_artifact_backend_required");
  const s3 = resolveTransformerS3Config(env);
  const backend = artifactMode === "filesystem"
    ? createFilesystemTransformerArtifactBackend({ root: resolve(required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_SHARED_ARTIFACT_ROOT"), "transformer_multinode_artifact_root_required")), maxStoredBytes: 64 * 1024 * 1024 })
    : artifactMode === "s3"
      ? createS3CompatibleTransformerArtifactBackend({ bucket: required(s3.bucket, "transformer_multinode_s3_bucket_required"), keyPrefix: required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_S3_PREFIX"), "transformer_multinode_s3_prefix_required"), maxStoredBytes: 64 * 1024 * 1024 }, createSigV4S3ArtifactTransport({ endpoint: required(s3.endpoint, "transformer_multinode_s3_endpoint_required"), region: required(s3.region, "transformer_multinode_s3_region_required"), accessKeyId: required(s3.accessKeyId, "transformer_multinode_s3_access_key_required"), secretAccessKey: required(s3.secretAccessKey, "transformer_multinode_s3_secret_required"), ...(s3.sessionToken?.trim() ? { sessionToken: s3.sessionToken.trim() } : {}), timeoutMs: 30_000 }))
      : (() => { throw new Error("transformer_multinode_artifact_backend_invalid"); })();
  if (env.GITHUB_MODE !== "real") throw new Error("transformer_multinode_github_real_required");
  const appCredentials = loadAppCredentials(env);
  if (!appCredentials) throw new Error("transformer_multinode_github_app_credentials_required");
  const service = createTransformerMultinodeService({
    enabled: true,
    mode: "checkpoint_required",
    workerId,
    tenantId,
    campaignId,
    environment: required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_ENVIRONMENT"), "transformer_multinode_environment_required"),
    evidenceRoot: resolve(dataRoot, "evidence"),
    candidateRoot: resolve(dataRoot, "candidates"),
    leaseDurationMs: integer(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_LEASE_MS") ?? "900000", 1_000, 3_600_000, "transformer_multinode_lease_invalid"),
    executorDigest: required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_EXECUTOR_DIGEST"), "transformer_multinode_executor_digest_required"),
    encryptionKey,
    operationSecret: decodeKey(required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_OPERATION_SECRET"), "transformer_multinode_operation_secret_required")),
    evidenceRefs: evidenceRefs(required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_EVIDENCE_REFS"), "transformer_multinode_evidence_refs_required")),
    gateConfig: required(resolveRenamedEnv(env, "MENDPOINT_REGAUGE_GATE"), "transformer_multinode_gate_required"),
    deliverDraft: (intent, target) => createAppDelivery(
      target.installationId,
      appCredentials,
      [target.remoteRepositoryId],
    ).deliverExactDraft(intent),
    observeDraft: (observation, target) => createAppDelivery(
      target.installationId,
      appCredentials,
      [target.remoteRepositoryId],
    ).observeExactDraft(observation),
  }, transport, backend);
  let closing = false;
  let healthy = false;
  let lastError: string | null = null;
  let lastFailure: string | null = null;
  let readinessObserved = false;
  const stop = new AbortController();
  const readiness: Server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/readyz") { response.writeHead(404).end(); return; }
    response.setHeader("content-type", "application/json");
    response.writeHead(healthy && !closing ? 200 : 503).end(JSON.stringify({
      ready: healthy && !closing,
      mode: "checkpoint_required",
      workerId,
      lastError,
    }));
  });
  await new Promise<void>((resolveReady, reject) => {
    readiness.once("error", reject);
    readiness.listen(readinessPort, readinessHost, () => { readiness.off("error", reject); resolveReady(); });
  });
  readinessEvent("regauge_worker_readiness_listener_bound", { workerId, host: readinessHost, port: readinessPort });
  const probe = async () => {
    try {
      await transport.request({
        path: "/v1/regauge/attempt-coordinator/readyz",
        body: { tenantId, campaignId },
      });
    }
    catch (error) {
      void error;
      throw new ReadinessProbeError("coordinator", "transformer_multinode_coordinator_probe_failed");
    }
    try {
      const sentinelKey = `readiness/${tenantId}/${workerId}`;
      const sentinel = new TextEncoder().encode(`transformer-readiness:${tenantId}:${workerId}`);
      await backend.createOnly(sentinelKey, sentinel);
      const readback = await backend.read(sentinelKey);
      if (!readback || new TextDecoder().decode(readback) !== new TextDecoder().decode(sentinel)) throw new Error("transformer_multinode_artifact_probe_failed");
    }
    catch (error) {
      throw new ReadinessProbeError("artifact", safeArtifactErrorCode(error));
    }
  };
  const recordReady = () => {
    const recovered = lastFailure !== null;
    healthy = true;
    lastError = null;
    lastFailure = null;
    if (recovered) readinessEvent("regauge_worker_readiness_recovered", { workerId });
    else if (!readinessObserved) readinessEvent("regauge_worker_readiness_ready", { workerId });
    readinessObserved = true;
  };
  const recordFailure = (error: unknown, fallbackStage: ReadinessProbeStage = "work_cycle") => {
    const stage = error instanceof ReadinessProbeError ? error.stage : fallbackStage;
    const code = error instanceof ReadinessProbeError
      ? error.message
      : "transformer_multinode_work_cycle_failed";
    healthy = false;
    lastError = code;
    const failure = `${stage}:${code}`;
    if (failure !== lastFailure) readinessEvent("regauge_worker_readiness_failed", { workerId, stage, code });
    lastFailure = failure;
    readinessObserved = true;
  };
  try { await probe(); recordReady(); } catch (error) { recordFailure(error); }
  const loop = async () => {
    while (!closing) {
      try {
        await probe();
        await service.runOnce();
        await service.runDeliveryOnce();
        await service.runObservationOnce();
        recordReady();
      }
      catch (error) { recordFailure(error); }
      if (!closing) await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, intervalMs);
        stop.signal.addEventListener("abort", () => { clearTimeout(timer); resolveWait(); }, { once: true });
      });
    }
  };
  const running = loop();
  return Object.freeze({
    readinessUrl: `http://127.0.0.1:${readinessPort}/readyz`,
    async close() {
      closing = true;
      stop.abort();
      await new Promise<void>((resolveClose, reject) => readiness.close((error) => error ? reject(error) : resolveClose()));
      await running;
    },
  });
}

function required(value: string | undefined, code: string): string { if (!value?.trim()) throw new Error(code); return value.trim(); }
function integer(value: string, minimum: number, maximum: number, code: string): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(code); return parsed; }
function readinessAddress(value: string): "127.0.0.1" | "0.0.0.0" { if (value === "127.0.0.1" || value === "0.0.0.0") return value; throw new Error("transformer_multinode_readiness_host_invalid"); }
function decodeKey(value: string): Uint8Array { const bytes = Buffer.from(value, "base64"); if (bytes.byteLength !== 32 || bytes.toString("base64") !== value) throw new Error("transformer_multinode_checkpoint_key_invalid"); return new Uint8Array(bytes); }
function evidenceRefs(value: string): readonly string[] { const refs = value.split(",").map((item) => item.trim()).filter(Boolean); if (!refs.length || new Set(refs).size !== refs.length) throw new Error("transformer_multinode_evidence_refs_invalid"); return Object.freeze(refs); }
function safeArtifactErrorCode(error: unknown): string { const message = error instanceof Error ? error.message : ""; return /^(?:s3_artifact|filesystem_artifact|transformer_multinode_artifact)_[a-z0-9_]{2,120}$/.test(message) ? message : "transformer_multinode_artifact_probe_failed"; }
function readinessEvent(event: string, details: Readonly<Record<string, string | number>>): void { console.info(JSON.stringify({ event, ...details })); }
