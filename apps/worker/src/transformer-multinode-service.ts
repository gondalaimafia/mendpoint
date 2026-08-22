import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  createTransformerPilotAttemptCheckpointConfig,
  deriveTransformerAttemptCheckpointBinding,
  openTransformerAttemptCheckpoint,
  openTransformerAttemptCheckpointForDraftDelivery,
  openTransformerWorkspaceArtifact,
  runTransformerAttempt,
  type ExactSourceSnapshot,
  type RecipeCommandRunner,
  type TransformerAttemptCheckpointArtifactStore,
  type TransformerAttemptCheckpointAuthorityPort,
  type TransformerAttemptCoordinatorPort,
  type TransformerAttemptPhase,
  type TransformerAttemptRunResult,
  type TransformerDraftDeliveryLease,
  type TransformerDeliveredDraftObservation,
  type TransformerExecutableAttemptLease,
  type TransformerPilotCampaign,
  type TransformerScmObservation,
} from "@mendpoint/transformer";
import type {
  ExactDraftDeliveryInput,
  ExactDraftDeliveryResult,
  ExactDraftObservation,
  ExactDraftObservationInput,
} from "@mendpoint/github";
import type { TransformerCheckpointArtifactBackend } from "./transformer-checkpoint-artifacts.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export type TransformerMultinodeTransport = Readonly<{
  request(input: Readonly<{ path: string; body: unknown; signal?: AbortSignal }>): Promise<unknown>;
}>;

export type TransformerMultinodeService = Readonly<{
  mode: "checkpoint_required";
  runOnce(): Promise<TransformerAttemptRunResult>;
  runDeliveryOnce(): Promise<
    | Readonly<{ status: "idle" }>
    | Readonly<{ status: "delivered"; deliveryId: string; pullRequestUrl: string; commitSha: string }>
  >;
  runObservationOnce(): Promise<
    | Readonly<{ status: "idle" }>
    | Readonly<{ status: "observed"; wave: number; campaignState: TransformerPilotCampaign["state"] }>
  >;
}>;

export type TransformerMultinodeDraftTarget = Readonly<{
  owner: string;
  repo: string;
  baseBranch: string;
  installationId: number;
  remoteRepositoryId: number;
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
  now?: () => string;
  operationSecret: Uint8Array;
  deliverDraft?(input: ExactDraftDeliveryInput, target: TransformerMultinodeDraftTarget): Promise<ExactDraftDeliveryResult>;
  observeDraft?(input: ExactDraftObservationInput, target: TransformerMultinodeDraftTarget): Promise<ExactDraftObservation>;
}>, transport: TransformerMultinodeTransport, artifactBackend: TransformerCheckpointArtifactBackend): TransformerMultinodeService {
  if (inputConfig.enabled !== true) throw new Error("transformer_multinode_service_disabled");
  if (inputConfig.mode !== "checkpoint_required") throw new Error("transformer_multinode_checkpoint_required");
  if (![inputConfig.workerId, inputConfig.tenantId, inputConfig.campaignId].every((value) => ID.test(value)) || !inputConfig.environment.trim() || !inputConfig.evidenceRoot.trim() || !inputConfig.candidateRoot.trim() || !Number.isSafeInteger(inputConfig.leaseDurationMs) || inputConfig.leaseDurationMs < 1_000 || inputConfig.leaseDurationMs > 3_600_000 || !(inputConfig.encryptionKey instanceof Uint8Array) || inputConfig.encryptionKey.byteLength !== 32 || !(inputConfig.operationSecret instanceof Uint8Array) || inputConfig.operationSecret.byteLength < 32 || !inputConfig.executorDigest.trim() || !Array.isArray(inputConfig.evidenceRefs) || (inputConfig.deliverDraft !== undefined && typeof inputConfig.deliverDraft !== "function") || (inputConfig.observeDraft !== undefined && typeof inputConfig.observeDraft !== "function") || !transport || typeof transport.request !== "function") throw new Error("transformer_multinode_service_config_invalid");
  const config = Object.freeze({ ...inputConfig, encryptionKey: new Uint8Array(inputConfig.encryptionKey), operationSecret: new Uint8Array(inputConfig.operationSecret), evidenceRefs: Object.freeze([...inputConfig.evidenceRefs]) });
  const request = transport.request.bind(transport);
  const createArtifact = artifactBackend.createOnly.bind(artifactBackend);
  const readArtifact = artifactBackend.read.bind(artifactBackend);
  const markArtifact = artifactBackend.mark.bind(artifactBackend);
  const deliverDraft = inputConfig.deliverDraft;
  const observeDraft = inputConfig.observeDraft;
  const now = inputConfig.now ?? (() => new Date().toISOString());
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
    "completeAttempt", "recordAttemptFailure", "claimNextDraftDelivery",
    "assertCurrentDraftDeliveryFence", "completeDraftDelivery", "reconcileWave",
  ].map((operation) => [operation, (input: unknown) => remote(`/v1/regauge/attempt-coordinator/operations/${operation}`, input)]))) as TransformerAttemptCoordinatorPort;
  const authority = Object.freeze(Object.fromEntries([
    "readBindingAuthority", "readLease", "readHead", "compareAndSwapHead",
    "completeWithHead", "failWithHead", "readFailureReceipt",
  ].map((operation) => [operation, (input: unknown) => remote(`/v1/regauge/attempt-coordinator/checkpoint-authority/${operation}`, input)]))) as unknown as TransformerAttemptCheckpointAuthorityPort;
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
    now,
    ...(config.gateConfig === undefined ? {} : { gateConfig: config.gateConfig }),
  });
  const stable = (purpose: string) => createHmac("sha256", config.operationSecret).update(`${config.tenantId}:${config.campaignId}:${config.workerId}:${purpose}`).digest("hex");
  const campaignStable = (purpose: string) => createHmac("sha256", config.operationSecret)
    .update(`${config.tenantId}:${config.campaignId}:${purpose}`)
    .digest("hex");
  const leaseToken = stable("lease-token");
  const token = () => leaseToken;
  const observedAt = (_phase: TransformerAttemptPhase) => coordinatorTime ?? now();
  const serviceInstanceId = randomBytes(16).toString("hex");
  let claimOrdinal = 0;
  let deliveryClaimOrdinal = 0;
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
        await remote("/v1/regauge/attempt-coordinator/readyz", {
          tenantId: config.tenantId,
          campaignId: config.campaignId,
        });
        const result = await runTransformerAttempt({
          scope: { tenantId: config.tenantId, campaignId: config.campaignId, environment: config.environment },
          ...(config.gateConfig === undefined ? {} : { gateConfig: config.gateConfig }),
          coordinator,
          loadExactSource: async (lease: TransformerExecutableAttemptLease): Promise<ExactSourceSnapshot> => await remote("/v1/regauge/attempt-coordinator/source", { tenantId: config.tenantId, lease, leaseToken }) as ExactSourceSnapshot,
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
    async runDeliveryOnce() {
      if (!deliverDraft) throw new Error("transformer_multinode_draft_delivery_disabled");
      if (running) throw new Error("transformer_multinode_run_in_progress");
      running = true;
      try {
        await remote("/v1/regauge/attempt-coordinator/readyz", {
          tenantId: config.tenantId,
          campaignId: config.campaignId,
        });
        await remote(
          "/v1/regauge/attempt-coordinator/operations/authorizeCurrentWaveDrafts",
          {
            tenantId: config.tenantId,
            campaignId: config.campaignId,
            observedAt: observedAt("complete"),
            evidenceRefs: config.evidenceRefs,
            idempotencyKey: `regauge-draft-authorize-${campaignStable(
              "draft-authorize",
            ).slice(0, 32)}`,
          },
        );
        const deliveryLeaseToken = stable("draft-delivery-token");
        const claimIdempotencyKey = `${config.workerId}-draft-claim-${stable(
          `draft-claim:${serviceInstanceId}:${deliveryClaimOrdinal}`,
        ).slice(0, 32)}`;
        const claim = await remote(
          "/v1/regauge/attempt-coordinator/operations/claimNextDraftDelivery",
          {
            tenantId: config.tenantId,
            campaignId: config.campaignId,
            observedAt: observedAt("claim"),
            evidenceRefs: config.evidenceRefs,
            idempotencyKey: claimIdempotencyKey,
            leaseToken: deliveryLeaseToken,
            leaseDurationMs: config.leaseDurationMs,
          },
        ) as TransformerDraftDeliveryLease | null;
        if (claim === null) {
          deliveryClaimOrdinal += 1;
          return Object.freeze({ status: "idle" as const });
        }
        deliveryClaimOrdinal += 1;
        assertDraftLease(claim, config);
        const recovered = await remote(
          "/v1/regauge/attempt-coordinator/draft-source",
          { tenantId: config.tenantId, lease: claim, leaseToken: deliveryLeaseToken },
        ) as Readonly<{ source: ExactSourceSnapshot; target: TransformerMultinodeDraftTarget }>;
        const target = assertDraftTarget(recovered.target);
        const executableLease: TransformerExecutableAttemptLease = Object.freeze({
          type: "execute_recipe",
          tenantId: claim.tenantId,
          campaignId: claim.campaignId,
          unitId: claim.unitId,
          attemptNumber: claim.checkpointHead.attemptNumber,
          leaseGeneration: claim.checkpointHead.writerLeaseGeneration,
          leaseTokenDigest: claim.checkpointHead.writerLeaseTokenDigest,
          leaseExpiresAt: claim.leaseExpiresAt,
          startedAt: claim.leasedAt,
          snapshot: claim.snapshot,
          candidateRevision: claim.candidateRevision,
          candidateDigest: claim.candidateDigest,
          changedPaths: claim.changedPaths,
          recipe: claim.recipe,
          constraintVersion: claim.constraintVersion,
          constraintDigest: claim.constraintDigest,
          gateEvidenceRefs: claim.evidenceRefs,
          adaptiveBudgetRemaining: Object.freeze({
            attempts: 0, plannerCalls: 0, modelCalls: 0, inputTokens: 0,
            outputTokens: 0, totalTokens: 0, actualCostUsd: 0, wallTimeMs: 0,
          }),
        });
        const binding = deriveTransformerAttemptCheckpointBinding({
          scope: {
            tenantId: config.tenantId,
            campaignId: config.campaignId,
            environment: config.environment,
          },
          lease: executableLease,
          source: recovered.source,
          executorDigest: config.executorDigest,
        });
        const envelopeBytes = await readArtifact(claim.checkpointHead.envelopeStorageKey);
        if (!envelopeBytes || digestBytes(envelopeBytes) !== claim.checkpointHead.envelopeDigest) {
          throw new Error("transformer_multinode_draft_checkpoint_missing");
        }
        let envelope: Parameters<typeof openTransformerAttemptCheckpoint>[0];
        try { envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(envelopeBytes)); }
        catch { throw new Error("transformer_multinode_draft_checkpoint_invalid"); }
        if (envelope.stateDigest !== claim.checkpointHead.stateDigest ||
            envelope.episodeId !== claim.checkpointHead.episodeId ||
            envelope.generation !== claim.checkpointHead.generation) {
          throw new Error("transformer_multinode_draft_checkpoint_invalid");
        }
        const state = openTransformerAttemptCheckpointForDraftDelivery(
          envelope,
          config.encryptionKey,
          binding,
        );
        if (state.stage !== "terminal" || !state.candidateSeal ||
            state.candidateSeal.candidateRevision !== claim.candidateRevision ||
            state.candidateSeal.candidateDigest !== claim.candidateDigest) {
          throw new Error("transformer_multinode_draft_candidate_invalid");
        }
        const workspaceBytes = await readArtifact(state.workspaceArtifact.storageKey);
        if (!workspaceBytes) throw new Error("transformer_multinode_draft_candidate_missing");
        const workspace = openTransformerWorkspaceArtifact(
          state.workspaceArtifact,
          workspaceBytes,
          config.encryptionKey,
          { tenantId: config.tenantId, episodeId: state.episodeId },
        );
        const byPath = new Map(workspace.map((file) => [file.path, file]));
        const utf8 = new TextDecoder("utf-8", { fatal: true });
        const files = claim.changedPaths.map((path) => {
          const file = byPath.get(path);
          if (!file) throw new Error("transformer_multinode_draft_candidate_invalid");
          return Object.freeze({
            path,
            content: utf8.decode(file.content),
            mode: file.mode === "executable" ? "100755" as const : "100644" as const,
          });
        });
        const title = cleanTitle(claim.title);
        const branch = `mendpoint/transformer/${campaignStable(`draft:${claim.deliveryId}`).slice(0, 32)}`;
        const intent: ExactDraftDeliveryInput = Object.freeze({
          owner: target.owner,
          repo: target.repo,
          baseBranch: target.baseBranch,
          expectedBaseSha: claim.snapshot.revision,
          branch,
          commitMessage: `Regauge: ${title}`,
          commitDate: claim.authorizedAt,
          title: `Draft: ${title}`,
          body: [
            "Automated Regauge migration draft.",
            "",
            `Candidate digest: ${claim.candidateDigest}`,
            `Checkpoint: ${claim.checkpointHead.stateDigest}`,
            "",
            "Evidence:",
            ...claim.evidenceRefs.map((reference) => `* ${reference}`),
          ].join("\n"),
          files: Object.freeze(files),
        });
        const intentDigest = digestBytes(new TextEncoder().encode(JSON.stringify(intent)));
        await remote(
          "/v1/regauge/attempt-coordinator/operations/assertCurrentDraftDeliveryFence",
          {
            tenantId: config.tenantId,
            campaignId: config.campaignId,
            unitId: claim.unitId,
            deliveryId: claim.deliveryId,
            leaseGeneration: claim.leaseGeneration,
            leaseToken: deliveryLeaseToken,
            observedAt: observedAt("execute"),
          },
        );
        const delivered = await deliverDraft(intent, target);
        if (delivered.draft !== true || delivered.branch !== intent.branch ||
            delivered.baseBranch !== intent.baseBranch || delivered.baseSha !== intent.expectedBaseSha ||
            delivered.title !== intent.title || !/^[a-f0-9]{40}$/.test(delivered.commitSha) ||
            !Number.isSafeInteger(delivered.number) || delivered.number < 1 ||
            !/^https:\/\//.test(delivered.url)) {
          throw new Error("transformer_multinode_draft_delivery_evidence_invalid");
        }
        const completionBody = {
          tenantId: config.tenantId,
          campaignId: config.campaignId,
          unitId: claim.unitId,
          deliveryId: claim.deliveryId,
          leaseGeneration: claim.leaseGeneration,
          leaseToken: deliveryLeaseToken,
          observedAt: observedAt("complete"),
          evidenceRefs: Object.freeze([...claim.evidenceRefs, `transformer-delivery:${intentDigest}`]),
          idempotencyKey: `${config.workerId}-draft-complete-${stable(
            `draft-complete:${claim.deliveryId}:${claim.leaseGeneration}`,
          ).slice(0, 32)}`,
          completion: Object.freeze({
            intentDigest,
            branchName: delivered.branch,
            baseBranch: delivered.baseBranch,
            baseRevision: delivered.baseSha,
            commitSha: delivered.commitSha,
            pullRequestNumber: delivered.number,
            pullRequestUrl: delivered.url,
          }),
        };
        let completed = false;
        let completionError: unknown;
        for (let attempt = 0; attempt < 2 && !completed; attempt += 1) {
          try {
            await remote(
              "/v1/regauge/attempt-coordinator/operations/completeDraftDelivery",
              completionBody,
            );
            completed = true;
          } catch (error) { completionError = error; }
        }
        if (!completed) throw completionError;
        return Object.freeze({
          status: "delivered" as const,
          deliveryId: claim.deliveryId,
          pullRequestUrl: delivered.url,
          commitSha: delivered.commitSha,
        });
      } finally {
        running = false;
      }
    },
    async runObservationOnce() {
      if (!observeDraft) throw new Error("transformer_multinode_draft_observation_disabled");
      if (running) throw new Error("transformer_multinode_run_in_progress");
      running = true;
      try {
        await remote("/v1/regauge/attempt-coordinator/readyz", {
          tenantId: config.tenantId,
          campaignId: config.campaignId,
        });
        const entries = await remote(
          "/v1/regauge/attempt-coordinator/draft-observations",
          { tenantId: config.tenantId, campaignId: config.campaignId },
        ) as readonly Readonly<{
          draft: TransformerDeliveredDraftObservation;
          target: TransformerMultinodeDraftTarget;
        }>[];
        if (!Array.isArray(entries) || entries.length === 0) {
          return Object.freeze({ status: "idle" as const });
        }
        const wave = entries[0]!.draft.wave;
        if (entries.some((entry) => entry.draft.tenantId !== config.tenantId ||
            entry.draft.campaignId !== config.campaignId || entry.draft.wave !== wave)) {
          throw new Error("transformer_multinode_draft_observation_scope_invalid");
        }
        const observations: TransformerScmObservation[] = [];
        for (const entry of entries) {
          const target = assertDraftTarget(entry.target);
          const draft = entry.draft;
          const observation = await observeDraft({
            owner: target.owner,
            repo: target.repo,
            pullRequestNumber: draft.pullRequestNumber,
            expectedBaseBranch: draft.baseBranch,
            expectedBaseSha: draft.baseRevision,
            expectedHeadBranch: draft.branchName,
            expectedHeadSha: draft.commitSha,
          }, target);
          observations.push(Object.freeze({
            unitId: draft.unitId,
            state: observation.state,
            baseRevision: observation.baseRevision,
            headRevision: observation.headRevision,
            checks: observation.checks,
            checkRevision: observation.checkRevision,
            approvals: observation.approvals,
            approvalRevision: observation.approvalRevision,
            conversationsResolved: observation.conversationsResolved,
            reviewerEditLines: 0,
            legacyItemsRemoved: 0,
            evidenceRefs: Object.freeze([...new Set([...draft.evidenceRefs, ...observation.evidenceRefs])].sort()),
          }));
        }
        observations.sort((left, right) => left.unitId < right.unitId ? -1 : left.unitId > right.unitId ? 1 : 0);
        const observationDigest = digestBytes(new TextEncoder().encode(JSON.stringify(observations)));
        const campaign = await remote(
          "/v1/regauge/attempt-coordinator/operations/reconcileWave",
          {
            tenantId: config.tenantId,
            campaignId: config.campaignId,
            wave,
            observations,
            observedAt: observedAt("complete"),
            evidenceRefs: Object.freeze([...new Set(observations.flatMap((item) => item.evidenceRefs))].sort()),
            idempotencyKey: `${config.workerId}-draft-observe-${stable(
              `draft-observe:${wave}:${observationDigest}`,
            ).slice(0, 32)}`,
          },
        ) as TransformerPilotCampaign;
        return Object.freeze({ status: "observed" as const, wave, campaignState: campaign.state });
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

function cleanTitle(value: string): string {
  const title = value.replace(/[\0\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!title) throw new Error("transformer_multinode_draft_title_invalid");
  return title.slice(0, 480);
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertDraftLease(
  lease: TransformerDraftDeliveryLease,
  config: Readonly<{ tenantId: string; campaignId: string }>,
): void {
  if (!lease || lease.type !== "deliver_draft" || lease.tenantId !== config.tenantId ||
      lease.campaignId !== config.campaignId || !ID.test(lease.unitId) ||
      !ID.test(lease.deliveryId) || !Number.isSafeInteger(lease.leaseGeneration) ||
      lease.leaseGeneration < 1) {
    throw new Error("transformer_multinode_draft_lease_invalid");
  }
}

function assertDraftTarget(value: TransformerMultinodeDraftTarget): TransformerMultinodeDraftTarget {
  if (!value || !ID.test(value.owner) || !ID.test(value.repo) || !value.baseBranch ||
      !Number.isSafeInteger(value.installationId) || value.installationId < 1 ||
      !Number.isSafeInteger(value.remoteRepositoryId) || value.remoteRepositoryId < 1) {
    throw new Error("transformer_multinode_draft_target_invalid");
  }
  return Object.freeze({ ...value });
}
