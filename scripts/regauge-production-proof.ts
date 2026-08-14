import { constants, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

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
    evidenceRefs: readonly string[];
  }>[];
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

function requiredId(value: string, code: string): string {
  if (!ID.test(value)) throw new Error(code);
  return value;
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
  expectedOwner: string;
  expectedRepository: string;
}>): Promise<RegaugeDraftCanaryEvidence> {
  const coordinatorUrl = exactCoordinatorUrl(input.coordinatorUrl);
  if (!API_KEY.test(input.token)) throw new Error("regauge_production_token_invalid");
  const tenantId = requiredId(input.tenantId, "regauge_production_tenant_invalid");
  const campaignId = requiredId(input.campaignId, "regauge_production_campaign_invalid");
  const expectedOwner = requiredId(input.expectedOwner, "regauge_production_repository_invalid");
  const expectedRepository = requiredId(input.expectedRepository, "regauge_production_repository_invalid");
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
  const observedAt = String(payload.serverTime ?? "");
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new Error("regauge_production_draft_canary_invalid");
  }
  const pullRequests = payload.result.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("regauge_production_draft_canary_invalid");
    }
    const { draft, target } = value as Record<string, any>;
    const match = GITHUB_DRAFT.exec(String(draft?.pullRequestUrl ?? ""));
    if (!draft || !target || draft.tenantId !== tenantId || draft.campaignId !== campaignId ||
        !ID.test(String(draft.unitId ?? "")) || !match || target.owner !== expectedOwner ||
        target.repo !== expectedRepository || target.owner !== match[1] || target.repo !== match[2] ||
        Number(draft.pullRequestNumber) !== Number(match[3]) ||
        !REVISION.test(String(draft.commitSha ?? "")) || !Array.isArray(draft.evidenceRefs) ||
        draft.evidenceRefs.length === 0 || draft.evidenceRefs.some((item: unknown) => typeof item !== "string" || !item)) {
      throw new Error("regauge_production_draft_canary_invalid");
    }
    return Object.freeze({
      unitId: draft.unitId as string,
      number: draft.pullRequestNumber as number,
      url: draft.pullRequestUrl as string,
      owner: target.owner as string,
      repository: target.repo as string,
      commitSha: draft.commitSha as string,
      evidenceRefs: Object.freeze([...new Set(draft.evidenceRefs as string[])].sort()),
    });
  }).sort((left, right) => left.unitId < right.unitId ? -1 : left.unitId > right.unitId ? 1 : 0);
  return Object.freeze({
    schemaVersion: 1,
    tenantId,
    campaignId,
    observedAt,
    pullRequests: Object.freeze(pullRequests),
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

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

async function main(): Promise<void> {
  const mode = option("mode");
  const output = option("output");
  if (!mode || !output) throw new Error("regauge_production_proof_usage_invalid");
  if (mode === "draft-canary") {
    const evidence = await observeRegaugeDraftCanary({
      coordinatorUrl: process.env.MENDPOINT_REGAUGE_COORDINATOR_URL ?? "",
      token: process.env.MENDPOINT_REGAUGE_COORDINATOR_TOKEN ?? "",
      tenantId: process.env.MENDPOINT_REGAUGE_TENANT_ID ?? "",
      campaignId: process.env.MENDPOINT_REGAUGE_CAMPAIGN_ID ?? "",
      expectedOwner: process.env.MENDPOINT_REGAUGE_CANARY_OWNER ?? "",
      expectedRepository: process.env.MENDPOINT_REGAUGE_CANARY_REPOSITORY ?? "",
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
  throw new Error("regauge_production_proof_mode_invalid");
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/regauge-production-proof.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
