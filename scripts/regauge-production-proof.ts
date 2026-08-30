import { constants, copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { REGAUGE_DEEPSEEK_APPROVED_SCOPE } from "@mendpoint/pipeline";
import {
  createAppDelivery,
  type ExactDraftObservation,
  type ExactDraftObservationInput,
} from "@mendpoint/github";
import {
  REGAUGE_DRAFT_BRANCH_PREFIX,
  REGAUGE_LEGACY_DRAFT_BRANCH_PREFIX,
} from "@mendpoint/worker/transformer-multinode-service";

const API_KEY = /^me_[A-Za-z0-9_-]{32,}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const GITHUB_DRAFT = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

type FetchInput = Readonly<{
  coordinatorUrl: string;
  fetchImpl?: typeof fetch;
}>;

export type RegaugeDraftCanaryEvidence = Readonly<{
  schemaVersion: 1;
  tenantId: string;
  campaignId: string;
  observedAt: string;
  pullRequests: readonly Readonly<{
    unitId: string;
    number: number;
    url: string;
    owner: string;
    repository: string;
    commitSha: string;
    baseBranch: string;
    baseRevision: string;
    headBranch: string;
    matchingOpenDrafts: 1;
    evidenceRefs: readonly string[];
    productionDeliveryApprovalRefs: readonly string[];
  }>[];
}>;

type RegaugeDraftObserver = (
  input: ExactDraftObservationInput,
  authority: Readonly<{ installationId: number; repositoryId: number }>,
) => Promise<ExactDraftObservation>;

export type RegaugeVerifierEvidence = Readonly<{
  schemaVersion: 1;
  tenantId: string;
  campaignId: string;
  observedAt: string;
  observation: Readonly<{
    telemetryDigest: string;
    evidencePackDigest: string;
    provider: "deepseek";
    model: "deepseek-v4-flash";
    backendRevision: string;
    observedAt: string;
    totalTokens: number;
    estimatedCostUsd: number;
    latencyMs: number;
    scoreEvidenceDigests: readonly string[];
    consentId: string;
    consentEffectiveAt: string;
    consentGrantedAt: string;
    consentExpiresAt: string;
    consentRecordDigest: string;
    providerRequestedAt: string;
    providerProcessedAt: string;
    advisoryOnly: true;
    behaviorChanged: false;
  }>;
}>;

export type RegaugeReadinessSoakReport = Readonly<{
  schemaVersion: 1;
  status: "completed" | "failed";
  passed: boolean;
  coordinatorUrl: string;
  expectedRevision: string;
  durationSeconds: number;
  intervalSeconds: number;
  samples: number;
  failures: number;
  startedAt: string;
  endedAt: string;
}>;

export type RegaugeWorkerStartPlan = Readonly<{
  schemaVersion: 1;
  runId: string;
  revision: string;
  volumeId: string;
  coordinatorId: string;
  workerId: string;
  workerState: string;
  action: "observe" | "wait" | "start";
}>;

export type RegaugeMachineContinuityEvidence = Readonly<{
  schemaVersion: 1;
  runId: string;
  revision: string;
  volumeId: string;
  coordinator: Readonly<{ machineId: string; instanceId: string }>;
  worker: Readonly<{ machineId: string; instanceId: string; check: "passing" }>;
}>;

function requiredId(value: string, code: string): string {
  if (!ID.test(value)) throw new Error(code);
  return value;
}

function validGitBranch(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 ||
      value.startsWith("/") || value.endsWith("/") || value.endsWith(".") ||
      value.includes("//") || value.includes("..") || value.includes("@{") ||
      value.includes("\\") || value.split("/").some((part) => !part || part.endsWith(".lock"))) {
    return false;
  }
  return !/[\u0000-\u0020\u007f~^:?*\[]/.test(value);
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function machineMatchesRevision(machine: Record<string, any>, revision: string): boolean {
  return machine.config?.env?.MENDPOINT_RELEASE_REVISION === revision &&
    machine.image_ref?.labels?.GH_SHA === revision;
}

function machineId(machine: Record<string, any>): string {
  return requiredId(String(machine.id ?? ""), "regauge_production_machine_topology_invalid");
}

function exactCoordinator(
  machine: Record<string, any>,
  revision: string,
  volumeId: string,
  runId: string,
): boolean {
  const mounts = Array.isArray(machine.config?.mounts) ? machine.config.mounts : [];
  return machine.state === "started" &&
    machine.config?.metadata?.fly_process_group === "coordinator" &&
    machineMatchesRevision(machine, revision) &&
    machine.config?.env?.MENDPOINT_REGAUGE_COORDINATOR_ACTIVATION_RUN_ID === runId &&
    mounts.length === 1 &&
    mounts[0]?.volume === volumeId &&
    mounts[0]?.path === "/data";
}

function exactWorker(machine: Record<string, any>, revision: string, runId: string): boolean {
  const mounts = Array.isArray(machine.config?.mounts) ? machine.config.mounts : [];
  return machine.config?.metadata?.fly_process_group === "worker" &&
    machineMatchesRevision(machine, revision) &&
    machine.config?.env?.MENDPOINT_REGAUGE_ACTIVATION_RUN_ID === runId &&
    mounts.length === 0;
}

function exactMachinePair(
  machines: unknown,
  revision: string,
  volumeId: string,
  runId: string,
): Readonly<{ coordinator: Record<string, any>; worker: Record<string, any> }> {
  if (!REVISION.test(revision) || !ID.test(volumeId) || !ID.test(runId) ||
      !Array.isArray(machines) || machines.length !== 2) {
    throw new Error("regauge_production_machine_topology_invalid");
  }
  const values = machines.map(record);
  if (values.some((value) => !value)) {
    throw new Error("regauge_production_machine_topology_invalid");
  }
  const records = values as Record<string, any>[];
  const coordinators = records.filter((machine) => exactCoordinator(machine, revision, volumeId, runId));
  const workers = records.filter((machine) => exactWorker(machine, revision, runId));
  if (coordinators.length !== 1 || workers.length !== 1 ||
      machineId(coordinators[0]!) === machineId(workers[0]!)) {
    throw new Error("regauge_production_machine_topology_invalid");
  }
  return Object.freeze({ coordinator: coordinators[0]!, worker: workers[0]! });
}

export function planRegaugeWorkerStart(input: Readonly<{
  machines: unknown;
  expectedRevision: string;
  expectedVolumeId: string;
  expectedRunId: string;
}>): RegaugeWorkerStartPlan {
  const pair = exactMachinePair(
    input.machines,
    input.expectedRevision,
    input.expectedVolumeId,
    input.expectedRunId,
  );
  const workerState = String(pair.worker.state ?? "");
  const action = workerState === "started" ? "observe"
    : workerState === "starting" ? "wait"
      : workerState === "stopped" ? "start"
        : null;
  if (!action) throw new Error("regauge_production_worker_state_invalid");
  return Object.freeze({
    schemaVersion: 1,
    runId: input.expectedRunId,
    revision: input.expectedRevision,
    volumeId: input.expectedVolumeId,
    coordinatorId: machineId(pair.coordinator),
    workerId: machineId(pair.worker),
    workerState,
    action,
  });
}

export function establishRegaugeMachineContinuity(input: Readonly<{
  machines: unknown;
  expectedRevision: string;
  expectedVolumeId: string;
  expectedRunId: string;
}>): RegaugeMachineContinuityEvidence {
  const pair = exactMachinePair(
    input.machines,
    input.expectedRevision,
    input.expectedVolumeId,
    input.expectedRunId,
  );
  const checks = Array.isArray(pair.worker.checks) ? pair.worker.checks : [];
  if (pair.worker.state !== "started" ||
      checks.filter((check: unknown) => record(check)?.name === "regauge_worker" &&
        record(check)?.status === "passing").length !== 1) {
    throw new Error("regauge_production_machine_topology_invalid");
  }
  const coordinatorInstanceId = requiredId(
    String(pair.coordinator.instance_id ?? ""),
    "regauge_production_machine_continuity_invalid",
  );
  const workerInstanceId = requiredId(
    String(pair.worker.instance_id ?? ""),
    "regauge_production_machine_continuity_invalid",
  );
  return Object.freeze({
    schemaVersion: 1,
    runId: input.expectedRunId,
    revision: input.expectedRevision,
    volumeId: input.expectedVolumeId,
    coordinator: Object.freeze({
      machineId: machineId(pair.coordinator),
      instanceId: coordinatorInstanceId,
    }),
    worker: Object.freeze({
      machineId: machineId(pair.worker),
      instanceId: workerInstanceId,
      check: "passing",
    }),
  });
}

export function verifyRegaugeMachineContinuity(input: Readonly<{
  machines: unknown;
  expected: RegaugeMachineContinuityEvidence;
}>): RegaugeMachineContinuityEvidence {
  const current = establishRegaugeMachineContinuity({
    machines: input.machines,
    expectedRevision: input.expected.revision,
    expectedVolumeId: input.expected.volumeId,
    expectedRunId: input.expected.runId,
  });
  if (current.coordinator.machineId !== input.expected.coordinator.machineId ||
      current.coordinator.instanceId !== input.expected.coordinator.instanceId ||
      current.worker.machineId !== input.expected.worker.machineId ||
      current.worker.instanceId !== input.expected.worker.instanceId) {
    throw new Error("regauge_production_machine_continuity_invalid");
  }
  return current;
}

function exactCoordinatorUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("regauge_production_coordinator_url_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("regauge_production_coordinator_url_invalid");
  }
  url.pathname = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return url.toString();
}

async function boundedJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const operation = async (): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`regauge_production_probe_http_${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new Error("regauge_production_probe_response_too_large");
    }
    if (!response.body) throw new Error("regauge_production_probe_response_invalid");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("regauge_production_probe_response_too_large");
      }
      chunks.push(value);
    }
    const source = Buffer.concat(chunks).toString("utf8");
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("regauge_production_probe_response_invalid");
    }
    return parsed as Record<string, unknown>;
  };
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        hardTimer = setTimeout(() => {
          controller.abort("regauge_production_probe_timeout");
          reject(new Error("regauge_production_probe_timeout"));
        }, REQUEST_TIMEOUT_MS);
        hardTimer.unref?.();
      }),
    ]);
  } finally {
    controller.abort("regauge_production_probe_complete");
    if (hardTimer) clearTimeout(hardTimer);
  }
}

export async function observeRegaugeDraftCanary(input: FetchInput & Readonly<{
  token: string;
  tenantId: string;
  campaignId: string;
  expectedApprovalRef: string;
  expectedEvidenceRefs: readonly string[];
  expectedOwner: string;
  expectedRepository: string;
  expectedInstallationId: number;
  expectedRepositoryId: number;
  observeDraft?: RegaugeDraftObserver;
}>): Promise<RegaugeDraftCanaryEvidence> {
  const coordinatorUrl = exactCoordinatorUrl(input.coordinatorUrl);
  if (!API_KEY.test(input.token)) throw new Error("regauge_production_token_invalid");
  const tenantId = requiredId(input.tenantId, "regauge_production_tenant_invalid");
  const campaignId = requiredId(input.campaignId, "regauge_production_campaign_invalid");
  const expectedApprovalRef = requiredEvidenceRef(
    input.expectedApprovalRef,
    "regauge_production_draft_canary_authority_invalid",
  );
  if (!Array.isArray(input.expectedEvidenceRefs)) {
    throw new Error("regauge_production_draft_canary_authority_invalid");
  }
  const expectedEvidenceRefs = Object.freeze(input.expectedEvidenceRefs.map((value) =>
    requiredEvidenceRef(value, "regauge_production_draft_canary_authority_invalid")));
  if (expectedEvidenceRefs.length === 0 ||
      new Set(expectedEvidenceRefs).size !== expectedEvidenceRefs.length ||
      expectedEvidenceRefs.includes(expectedApprovalRef)) {
    throw new Error("regauge_production_draft_canary_authority_invalid");
  }
  const expectedOwner = requiredId(input.expectedOwner, "regauge_production_repository_invalid");
  const expectedRepository = requiredId(input.expectedRepository, "regauge_production_repository_invalid");
  if (!Number.isSafeInteger(input.expectedInstallationId) || input.expectedInstallationId < 1 ||
      !Number.isSafeInteger(input.expectedRepositoryId) || input.expectedRepositoryId < 1) {
    throw new Error("regauge_production_repository_invalid");
  }
  const payload = await boundedJson(
    new URL("v1/regauge/attempt-coordinator/draft-observations", coordinatorUrl).toString(),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tenantId, campaignId }),
    },
    input.fetchImpl ?? globalThis.fetch,
  );
  if (!Array.isArray(payload.result) || payload.result.length === 0) {
    throw new Error("regauge_production_draft_canary_missing");
  }
  if (payload.result.length !== 1) {
    throw new Error("regauge_production_draft_canary_cardinality_invalid");
  }
  const observedAt = String(payload.serverTime ?? "");
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new Error("regauge_production_draft_canary_invalid");
  }
  const observeDraft = input.observeDraft ?? (async (draftInput, authority) =>
    createAppDelivery(authority.installationId, undefined, [authority.repositoryId])
      .observeExactDraft(draftInput));
  const pullRequests = await Promise.all(payload.result.map(async (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("regauge_production_draft_canary_invalid");
    }
    const { draft, target } = value as Record<string, any>;
    const match = GITHUB_DRAFT.exec(String(draft?.pullRequestUrl ?? ""));
    const draftEvidenceRefs = Array.isArray(draft?.evidenceRefs)
      ? draft.evidenceRefs as unknown[]
      : [];
    const productionDeliveryApprovalRefs = Array.isArray(draft?.productionDeliveryApprovalRefs)
      ? draft.productionDeliveryApprovalRefs as unknown[]
      : [];
    if (!draft || !target || draft.tenantId !== tenantId || draft.campaignId !== campaignId ||
        !ID.test(String(draft.unitId ?? "")) || !match || target.owner !== expectedOwner ||
        target.repo !== expectedRepository || target.owner !== match[1] || target.repo !== match[2] ||
        !validGitBranch(draft.baseBranch) || !validGitBranch(draft.branchName) ||
        target.baseBranch !== draft.baseBranch ||
        target.installationId !== input.expectedInstallationId ||
        target.remoteRepositoryId !== input.expectedRepositoryId ||
        Number(draft.pullRequestNumber) !== Number(match[3]) ||
        !REVISION.test(String(draft.baseRevision ?? "")) || !REVISION.test(String(draft.commitSha ?? "")) ||
        draftEvidenceRefs.length === 0 ||
        draftEvidenceRefs.some((item: unknown) => typeof item !== "string" || !item) ||
        productionDeliveryApprovalRefs.length === 0 ||
        productionDeliveryApprovalRefs.some((item: unknown) => typeof item !== "string" || !item) ||
        !productionDeliveryApprovalRefs.includes(expectedApprovalRef) ||
        expectedEvidenceRefs.some((reference) => !draftEvidenceRefs.includes(reference))) {
      throw new Error("regauge_production_draft_canary_invalid");
    }
    const observation = await observeDraft({
      owner: expectedOwner,
      repo: expectedRepository,
      pullRequestNumber: Number(draft.pullRequestNumber),
      expectedBaseBranch: String(draft.baseBranch),
      expectedBaseSha: String(draft.baseRevision),
      expectedHeadBranch: String(draft.branchName),
      expectedHeadSha: String(draft.commitSha),
      expectedCampaignBranchPrefix: REGAUGE_DRAFT_BRANCH_PREFIX,
      compatibilityCampaignBranchPrefixes: [REGAUGE_LEGACY_DRAFT_BRANCH_PREFIX],
      expectedRepositoryId: input.expectedRepositoryId,
      expectedInstallationId: input.expectedInstallationId,
      requireExactDraft: true,
      includeDeliveryEvidence: true,
    }, {
      installationId: input.expectedInstallationId,
      repositoryId: input.expectedRepositoryId,
    });
    if (observation.state !== "draft" || observation.baseRevision !== draft.baseRevision ||
        observation.headRevision !== draft.commitSha ||
        observation.repositoryId !== input.expectedRepositoryId ||
        observation.installationId !== input.expectedInstallationId ||
        observation.matchingOpenDrafts !== 1) {
      throw new Error("regauge_production_draft_canary_remote_invalid");
    }
    return Object.freeze({
      unitId: draft.unitId as string,
      number: draft.pullRequestNumber as number,
      url: draft.pullRequestUrl as string,
      owner: target.owner as string,
      repository: target.repo as string,
      commitSha: draft.commitSha as string,
      baseBranch: draft.baseBranch as string,
      baseRevision: draft.baseRevision as string,
      headBranch: draft.branchName as string,
      matchingOpenDrafts: 1 as const,
      evidenceRefs: Object.freeze([
        ...new Set([...(draftEvidenceRefs as string[]), ...observation.evidenceRefs]),
      ].sort()),
      productionDeliveryApprovalRefs: Object.freeze([
        ...new Set(productionDeliveryApprovalRefs as string[]),
      ].sort()),
    });
  }));
  pullRequests.sort((left, right) => left.unitId < right.unitId ? -1 : left.unitId > right.unitId ? 1 : 0);
  return Object.freeze({
    schemaVersion: 1,
    tenantId,
    campaignId,
    observedAt,
    pullRequests: Object.freeze(pullRequests),
  });
}

export async function observeRegaugeVerifierEvidence(input: FetchInput & Readonly<{
  token: string;
  tenantId: string;
  campaignId: string;
  expectedConsentId: string;
}>): Promise<RegaugeVerifierEvidence> {
  const coordinatorUrl = exactCoordinatorUrl(input.coordinatorUrl);
  if (!API_KEY.test(input.token)) throw new Error("regauge_production_token_invalid");
  const tenantId = requiredId(input.tenantId, "regauge_production_tenant_invalid");
  const campaignId = requiredId(input.campaignId, "regauge_production_campaign_invalid");
  const expectedConsentId = requiredId(input.expectedConsentId, "regauge_production_verifier_consent_invalid");
  const payload = await boundedJson(
    new URL("v1/regauge/attempt-coordinator/verifier-observations", coordinatorUrl).toString(),
    {
      method: "POST",
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      body: JSON.stringify({ tenantId, campaignId }),
    },
    input.fetchImpl ?? globalThis.fetch,
  );
  if (!Array.isArray(payload.result) || payload.result.length !== 1) {
    throw new Error("regauge_production_verifier_evidence_missing");
  }
  const value = payload.result[0];
  const observedAt = String(payload.serverTime ?? "");
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !Number.isFinite(Date.parse(observedAt))) {
    throw new Error("regauge_production_verifier_evidence_invalid");
  }
  const observation = value as Record<string, unknown>;
  const scoreEvidenceDigests = observation.scoreEvidenceDigests;
  const providerRequestedAt = String(observation.providerRequestedAt ?? "");
  const providerProcessedAt = String(observation.providerProcessedAt ?? "");
  const consentEffectiveAt = String(observation.consentEffectiveAt ?? "");
  const consentGrantedAt = String(observation.consentGrantedAt ?? "");
  const consentExpiresAt = String(observation.consentExpiresAt ?? "");
  const processedMs = Date.parse(providerProcessedAt);
  const requestedMs = Date.parse(providerRequestedAt);
  if (!/^sha256:[a-f0-9]{64}$/.test(String(observation.telemetryDigest)) ||
      !/^sha256:[a-f0-9]{64}$/.test(String(observation.evidencePackDigest)) ||
      observation.provider !== "deepseek" || observation.model !== "deepseek-v4-flash" ||
      typeof observation.backendRevision !== "string" || !observation.backendRevision ||
      !Number.isFinite(Date.parse(String(observation.observedAt))) ||
      typeof observation.totalTokens !== "number" || !Number.isSafeInteger(observation.totalTokens) || observation.totalTokens <= 0 ||
      typeof observation.estimatedCostUsd !== "number" || observation.estimatedCostUsd < 0 ||
      typeof observation.latencyMs !== "number" || observation.latencyMs < 0 ||
      !Array.isArray(scoreEvidenceDigests) || scoreEvidenceDigests.length === 0 ||
      scoreEvidenceDigests.some((digest) => !/^sha256:[a-f0-9]{64}$/.test(String(digest))) ||
      observation.consentId !== expectedConsentId ||
      !/^sha256:[a-f0-9]{64}$/.test(String(observation.consentRecordDigest)) ||
      !Number.isFinite(requestedMs) || !Number.isFinite(processedMs) || requestedMs > processedMs ||
      !Number.isFinite(Date.parse(consentEffectiveAt)) || !Number.isFinite(Date.parse(consentGrantedAt)) ||
      !Number.isFinite(Date.parse(consentExpiresAt)) ||
      Date.parse(consentEffectiveAt) >= requestedMs || Date.parse(consentGrantedAt) >= requestedMs ||
      Date.parse(consentExpiresAt) <= processedMs ||
      Date.parse(consentExpiresAt) > Date.parse(REGAUGE_DEEPSEEK_APPROVED_SCOPE.authorizationDeadline) ||
      observation.advisoryOnly !== true || observation.behaviorChanged !== false) {
    throw new Error("regauge_production_verifier_evidence_invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    tenantId,
    campaignId,
    observedAt,
    observation: Object.freeze({
      telemetryDigest: String(observation.telemetryDigest),
      evidencePackDigest: String(observation.evidencePackDigest),
      provider: "deepseek",
      model: "deepseek-v4-flash",
      backendRevision: String(observation.backendRevision),
      observedAt: String(observation.observedAt),
      totalTokens: Number(observation.totalTokens),
      estimatedCostUsd: observation.estimatedCostUsd,
      latencyMs: observation.latencyMs,
      scoreEvidenceDigests: Object.freeze(scoreEvidenceDigests.map(String)),
      consentId: expectedConsentId,
      consentEffectiveAt,
      consentGrantedAt,
      consentExpiresAt,
      consentRecordDigest: String(observation.consentRecordDigest),
      providerRequestedAt,
      providerProcessedAt,
      advisoryOnly: true,
      behaviorChanged: false,
    }),
  });
}

export async function runRegaugeReadinessSoak(input: FetchInput & Readonly<{
  expectedRevision: string;
  durationSeconds: number;
  intervalSeconds: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}>): Promise<RegaugeReadinessSoakReport> {
  const coordinatorUrl = exactCoordinatorUrl(input.coordinatorUrl);
  if (!REVISION.test(input.expectedRevision)) throw new Error("regauge_production_revision_invalid");
  if (!Number.isSafeInteger(input.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > 21_600 ||
      !Number.isSafeInteger(input.intervalSeconds) || input.intervalSeconds < 1 || input.intervalSeconds > 300 ||
      input.intervalSeconds > input.durationSeconds) {
    throw new Error("regauge_production_soak_bounds_invalid");
  }
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const deadline = started + input.durationSeconds * 1000;
  let samples = 0;
  let failures = 0;
  while (now() < deadline) {
    try {
      const [version, ready] = await Promise.all([
        boundedJson(new URL("version", coordinatorUrl).toString(), { method: "GET" }, input.fetchImpl ?? globalThis.fetch),
        boundedJson(new URL("ready", coordinatorUrl).toString(), { method: "GET" }, input.fetchImpl ?? globalThis.fetch),
      ]);
      const checks = ready.checks;
      if (version.revision !== input.expectedRevision || ready.status !== "ok" || !Array.isArray(checks) ||
          checks.some((check) => !check || typeof check !== "object" || (check as Record<string, unknown>).ok !== true)) {
        failures += 1;
      }
    } catch {
      failures += 1;
    }
    samples += 1;
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(input.intervalSeconds * 1000, remaining));
  }
  return Object.freeze({
    schemaVersion: 1,
    status: failures === 0 && samples > 0 ? "completed" : "failed",
    passed: failures === 0 && samples > 0,
    coordinatorUrl,
    expectedRevision: input.expectedRevision,
    durationSeconds: input.durationSeconds,
    intervalSeconds: input.intervalSeconds,
    samples,
    failures,
    startedAt: new Date(started).toISOString(),
    endedAt: new Date(now()).toISOString(),
  });
}

export function persistRegaugeProductionEvidence(path: string, value: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try { copyFileSync(temporary, path, constants.COPYFILE_EXCL); }
  finally { rmSync(temporary, { force: true }); }
  return path;
}

function readBoundedJsonFile(path: string | undefined): unknown {
  if (!path || statSync(path).size > MAX_RESPONSE_BYTES) {
    throw new Error("regauge_production_proof_input_invalid");
  }
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function parseMachineContinuityEvidence(value: unknown): RegaugeMachineContinuityEvidence {
  const parsed = record(value);
  const coordinator = record(parsed?.coordinator);
  const worker = record(parsed?.worker);
  if (parsed?.schemaVersion !== 1 || !ID.test(String(parsed?.runId ?? "")) ||
      !REVISION.test(String(parsed?.revision ?? "")) ||
      !ID.test(String(parsed?.volumeId ?? "")) || !coordinator || !worker ||
      worker.check !== "passing") {
    throw new Error("regauge_production_machine_continuity_invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    runId: requiredId(String(parsed.runId), "regauge_production_machine_continuity_invalid"),
    revision: String(parsed.revision),
    volumeId: requiredId(String(parsed.volumeId), "regauge_production_machine_continuity_invalid"),
    coordinator: Object.freeze({
      machineId: requiredId(String(coordinator.machineId ?? ""), "regauge_production_machine_continuity_invalid"),
      instanceId: requiredId(String(coordinator.instanceId ?? ""), "regauge_production_machine_continuity_invalid"),
    }),
    worker: Object.freeze({
      machineId: requiredId(String(worker.machineId ?? ""), "regauge_production_machine_continuity_invalid"),
      instanceId: requiredId(String(worker.instanceId ?? ""), "regauge_production_machine_continuity_invalid"),
      check: "passing",
    }),
  });
}

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function requiredEvidenceRef(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048 ||
      value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(code);
  }
  return value;
}

async function main(): Promise<void> {
  const mode = option("mode");
  const output = option("output");
  if (!mode || !output) throw new Error("regauge_production_proof_usage_invalid");
  if (mode === "worker-start-plan") {
    const evidence = planRegaugeWorkerStart({
      machines: readBoundedJsonFile(option("input")),
      expectedRevision: process.env.MENDPOINT_RELEASE_REVISION ?? "",
      expectedVolumeId: option("volume-id") ?? "",
      expectedRunId: process.env.MENDPOINT_REGAUGE_ACTIVATION_RUN_ID ?? "",
    });
    persistRegaugeProductionEvidence(output, evidence);
    return;
  }
  if (mode === "machine-establish") {
    const evidence = establishRegaugeMachineContinuity({
      machines: readBoundedJsonFile(option("input")),
      expectedRevision: process.env.MENDPOINT_RELEASE_REVISION ?? "",
      expectedVolumeId: option("volume-id") ?? "",
      expectedRunId: process.env.MENDPOINT_REGAUGE_ACTIVATION_RUN_ID ?? "",
    });
    persistRegaugeProductionEvidence(output, evidence);
    return;
  }
  if (mode === "machine-continuity") {
    const evidence = verifyRegaugeMachineContinuity({
      machines: readBoundedJsonFile(option("input")),
      expected: parseMachineContinuityEvidence(readBoundedJsonFile(option("expected"))),
    });
    persistRegaugeProductionEvidence(output, evidence);
    return;
  }
  if (mode === "draft-canary") {
    const expectedApprovalRef = process.env.MENDPOINT_REGAUGE_PRODUCTION_APPROVAL_REF ?? "";
    const evidence = await observeRegaugeDraftCanary({
      coordinatorUrl: process.env.MENDPOINT_REGAUGE_COORDINATOR_URL ?? "",
      token: process.env.MENDPOINT_REGAUGE_COORDINATOR_TOKEN ?? "",
      tenantId: process.env.MENDPOINT_REGAUGE_TENANT_ID ?? "",
      campaignId: process.env.MENDPOINT_REGAUGE_CAMPAIGN_ID ?? "",
      expectedApprovalRef,
      expectedEvidenceRefs: (process.env.MENDPOINT_REGAUGE_EVIDENCE_REFS ?? "")
        .split(",")
        .filter((value) => value.length > 0 && value !== expectedApprovalRef),
      expectedOwner: process.env.MENDPOINT_REGAUGE_CANARY_OWNER ?? "",
      expectedRepository: process.env.MENDPOINT_REGAUGE_CANARY_REPOSITORY ?? "",
      expectedInstallationId: Number(process.env.MENDPOINT_REGAUGE_GITHUB_INSTALLATION_ID),
      expectedRepositoryId: Number(process.env.MENDPOINT_REGAUGE_CANARY_REPOSITORY_ID),
    });
    persistRegaugeProductionEvidence(output, evidence);
    return;
  }
  if (mode === "readiness-soak") {
    const report = await runRegaugeReadinessSoak({
      coordinatorUrl: process.env.MENDPOINT_REGAUGE_COORDINATOR_URL ?? "",
      expectedRevision: process.env.MENDPOINT_RELEASE_REVISION ?? "",
      durationSeconds: Number(option("duration-seconds")),
      intervalSeconds: Number(option("interval-seconds") ?? "10"),
    });
    persistRegaugeProductionEvidence(output, report);
    if (!report.passed) process.exitCode = 1;
    return;
  }
  if (mode === "verifier-evidence") {
    const evidence = await observeRegaugeVerifierEvidence({
      coordinatorUrl: process.env.MENDPOINT_REGAUGE_COORDINATOR_URL ?? "",
      token: process.env.MENDPOINT_REGAUGE_COORDINATOR_TOKEN ?? "",
      tenantId: process.env.MENDPOINT_REGAUGE_TENANT_ID ?? "",
      campaignId: process.env.MENDPOINT_REGAUGE_CAMPAIGN_ID ?? "",
      expectedConsentId: expectedConsentIdFromGovernance(
        process.env.MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON,
        process.env.MENDPOINT_REGAUGE_TENANT_ID ?? "",
      ),
    });
    persistRegaugeProductionEvidence(output, evidence);
    return;
  }
  throw new Error("regauge_production_proof_mode_invalid");
}

function expectedConsentIdFromGovernance(value: string | undefined, tenantId: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(value?.trim() ?? ""); }
  catch { throw new Error("regauge_production_verifier_consent_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      !Array.isArray((parsed as Record<string, unknown>).entries)) {
    throw new Error("regauge_production_verifier_consent_invalid");
  }
  const matches = ((parsed as Record<string, unknown>).entries as unknown[]).filter((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry) &&
    (entry as Record<string, unknown>).tenantId === tenantId &&
    Array.isArray((entry as Record<string, unknown>).products) &&
    ((entry as Record<string, unknown>).products as unknown[]).includes("regauge"));
  if (matches.length !== 1) throw new Error("regauge_production_verifier_consent_invalid");
  return requiredId(String((matches[0] as Record<string, unknown>).consentId ?? ""),
    "regauge_production_verifier_consent_invalid");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/regauge-production-proof.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
