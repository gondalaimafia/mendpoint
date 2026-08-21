import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
  getAgentRun,
  listRepositorySnapshotFiles,
  type AppDb,
} from "@mendpoint/db";
import { createSandbox } from "@mendpoint/platform";
import {
  delegatedPrVerificationResultDigest,
  type DelegatedPrCandidateAuthority,
  type DelegatedPrCandidateOperationDependencies,
  type DelegatedPrVerificationDependencies,
  type DelegatedPrVerificationExchange,
  type DelegatedPrVerificationExecution,
  type DelegatedPrVerificationReceipt,
  type DelegatedPrVerificationResolution,
  type DelegatedPrVerifier,
  type DelegatedPrVerifierRequest,
  type ValidatedDelegatedPrCandidate,
} from "@mendpoint/pipeline";

const MAX_FILES = 5_000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const INFRA_EXIT_CODES = new Set([124, 125, 126, 127, 128, 130, 137, 143]);
const EFFECT_TABLE = `CREATE TABLE IF NOT EXISTS delegated_pr_sandbox_verifier_effects (
  tenant_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  run_id TEXT NOT NULL,
  candidate_artifact_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('dispatched','settled')),
  result_json TEXT,
  PRIMARY KEY (tenant_id, request_digest)
) STRICT`;

type Entry = Readonly<{ path: string; size: number; sha256: string; executable: boolean }>;

export type DelegatedPrSandboxExecutionInput = Readonly<{
  tenantId: string;
  role: "fail_to_pass" | "pass_to_pass";
  workspace: "source" | "candidate";
  command: string;
  timeoutMs: number;
  files: Readonly<Record<string, Buffer>>;
}>;

export type DelegatedPrSandboxExecutionResult = Readonly<{
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  // The kind of sandbox the executor actually ran on. Reported by the executor, never assumed:
  // an executor that cannot name its own backend must leave this absent so the run refuses to pass.
  backend: string;
}>;

export type DelegatedPrSandboxExecutor = (
  input: DelegatedPrSandboxExecutionInput,
) => Promise<DelegatedPrSandboxExecutionResult>;

export type DelegatedPrVerificationRuntime = Readonly<{
  candidateDependencies: DelegatedPrCandidateOperationDependencies;
  verificationDependencies: DelegatedPrVerificationDependencies;
}>;

export function validateDelegatedPrVerificationEnvironment(
  env: NodeJS.ProcessEnv,
  workerId = "worker-preflight",
): string[] {
  if (env.MENDPOINT_DELEGATED_PR_VERIFICATION_ENABLED?.trim() !== "1") return [];
  const errors: string[] = [];
  const requireValue = (key: string) => {
    const value = env[key]?.trim();
    if (!value) errors.push(`${key} is required when delegated PR verification is enabled`);
    return value ?? "";
  };
  const candidateAuthorityId = requireValue("MENDPOINT_DELEGATED_PR_CANDIDATE_AUTHORITY_ID");
  const authorityId = requireValue("MENDPOINT_DELEGATED_PR_VERIFIER_AUTHORITY_ID");
  const authorityDigest = requireValue("MENDPOINT_DELEGATED_PR_VERIFIER_AUTHORITY_DIGEST");
  const executionAuthorityId = requireValue("MENDPOINT_DELEGATED_PR_EXECUTION_AUTHORITY_ID");
  const receiptSecret = requireValue("MENDPOINT_DELEGATED_PR_RECEIPT_SECRET");
  const revision = requireValue("MENDPOINT_GIT_COMMIT");
  const failCommand = requireValue("MENDPOINT_DELEGATED_PR_FAIL_TO_PASS_COMMAND");
  const passCommand = requireValue("MENDPOINT_DELEGATED_PR_PASS_TO_PASS_COMMAND");
  if (env.MENDPOINT_SANDBOX_KIND?.trim() !== "fly_machines") {
    errors.push("Delegated PR verification requires MENDPOINT_SANDBOX_KIND=fly_machines");
  }
  if (![candidateAuthorityId, authorityId, executionAuthorityId, workerId]
      .filter(Boolean).every((value) => ID.test(value)) || candidateAuthorityId === authorityId ||
      authorityId === executionAuthorityId) {
    errors.push("Delegated PR verification authority identities are invalid or not independent");
  }
  if (authorityDigest && !DIGEST.test(authorityDigest)) errors.push("Delegated PR verifier authority digest is invalid");
  if (revision && !REVISION.test(revision)) errors.push("MENDPOINT_GIT_COMMIT is invalid for delegated PR verification");
  if (receiptSecret && receiptSecret.length < 32) errors.push("Delegated PR receipt secret must be at least 32 characters");
  for (const [name, value] of [["fail to pass", failCommand], ["pass to pass", passCommand]] as const) {
    if (value && (value.length > 1_024 || /[\0\r\n;&|><`$]/.test(value))) {
      errors.push(`Delegated PR ${name} command is invalid`);
    }
  }
  try { integer(env, "MENDPOINT_DELEGATED_PR_TIMEOUT_MS", 120_000, 1_000, 600_000); }
  catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  try {
    const timeout = integer(env, "MENDPOINT_DELEGATED_PR_TIMEOUT_MS", 120_000, 1_000, 600_000);
    integer(env, "MENDPOINT_DELEGATED_PR_LEASE_MS", 300_000, timeout * 2, 1_800_000);
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  return errors;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

function digest(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 &&
    !value.includes("\0") && !value.includes("\\") && !value.startsWith("/") &&
    !/^[A-Za-z]:/.test(value) && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return canonical(Object.keys(value).sort(compareCodeUnits)) === canonical([...keys].sort(compareCodeUnits));
}

function realDirectory(value: string | undefined, code: string): string {
  if (!value || !isAbsolute(value)) throw new Error(code);
  let real: string;
  try { real = realpathSync(resolve(value)); }
  catch { throw new Error(code); }
  if (!lstatSync(real).isDirectory()) throw new Error(code);
  return real;
}

function safeRoot(root: string, expectedParent: string, code: string): string {
  const real = realDirectory(root, code);
  if (!isWithin(expectedParent, real) || real === expectedParent) throw new Error(code);
  return real;
}

function readBoundedFile(root: string, relativePath: string, expected: Entry, budget: { bytes: number }): Buffer {
  if (!validPath(relativePath) || relativePath !== expected.path || !DIGEST.test(expected.sha256) ||
      !Number.isSafeInteger(expected.size) || expected.size < 0) {
    throw new Error("delegated_pr_verifier_manifest_invalid");
  }
  const absolute = resolve(root, relativePath);
  if (!isWithin(root, absolute)) throw new Error("delegated_pr_verifier_path_escape");
  let real: string;
  try { real = realpathSync(absolute); }
  catch { throw new Error("delegated_pr_verifier_file_missing"); }
  if (!isWithin(root, real)) throw new Error("delegated_pr_verifier_path_escape");
  const descriptor = openSync(real, "r");
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size !== expected.size || stat.size > MAX_BYTES ||
        budget.bytes + stat.size > MAX_BYTES) {
      throw new Error("delegated_pr_verifier_workspace_limit");
    }
    const bytes = readFileSync(descriptor);
    if (bytes.byteLength !== expected.size || digest(bytes) !== expected.sha256) {
      throw new Error("delegated_pr_verifier_file_digest_mismatch");
    }
    budget.bytes += bytes.byteLength;
    return Buffer.from(bytes);
  } finally {
    closeSync(descriptor);
  }
}

function parseEntry(value: unknown): Entry {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !exactKeys(value, ["path", "size", "sha256", "executable"])) {
    throw new Error("delegated_pr_verifier_manifest_invalid");
  }
  const entry = value as Record<string, unknown>;
  if (!validPath(entry.path) || !Number.isSafeInteger(entry.size) || Number(entry.size) < 0 ||
      typeof entry.sha256 !== "string" || !DIGEST.test(entry.sha256) || typeof entry.executable !== "boolean") {
    throw new Error("delegated_pr_verifier_manifest_invalid");
  }
  return Object.freeze({ path: entry.path, size: Number(entry.size), sha256: entry.sha256,
    executable: entry.executable });
}

function exactFiles(root: string, entries: readonly Entry[]): Readonly<Record<string, Buffer>> {
  if (entries.length === 0 || entries.length > MAX_FILES) throw new Error("delegated_pr_verifier_workspace_limit");
  const files: Record<string, Buffer> = {};
  const budget = { bytes: 0 };
  let prior = "";
  for (const entry of entries) {
    if (prior && compareCodeUnits(prior, entry.path) >= 0) throw new Error("delegated_pr_verifier_manifest_invalid");
    if (entry.executable) throw new Error("delegated_pr_verifier_executable_mode_unsupported");
    prior = entry.path;
    files[entry.path] = readBoundedFile(root, entry.path, entry, budget);
  }
  return Object.freeze(files);
}

function treeDigest(entries: readonly Entry[]): string {
  return digest(JSON.stringify(stable(entries)));
}

function parseObject(value: string, code: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(code);
  }
}

function loadBundle(
  db: AppDb,
  input: Readonly<{ tenantId: string; runId: string }>,
  env: NodeJS.ProcessEnv,
) {
  const run = getAgentRun(db, input.runId, input.tenantId);
  if (!run || run.status !== "candidate_ready" || run.ok !== 1 || !run.job_id || !run.finished_at) {
    throw new Error("delegated_pr_candidate_authority_not_found");
  }
  const result = parseObject(run.result_json ?? "", "delegated_pr_candidate_authority_corrupt");
  const source = result.source && typeof result.source === "object" && !Array.isArray(result.source)
    ? result.source as Record<string, unknown> : null;
  const artifacts = result.artifacts && typeof result.artifacts === "object" && !Array.isArray(result.artifacts)
    ? result.artifacts as Record<string, unknown> : null;
  const changedPaths = Array.isArray(result.changedPaths) ? result.changedPaths : [];
  if (!source || !artifacts || typeof artifacts.candidateManifest !== "string" ||
      typeof artifacts.candidateWorkspace !== "string" || typeof artifacts.candidateManifestSha256 !== "string" ||
      !DIGEST.test(artifacts.candidateManifestSha256) || changedPaths.length === 0 ||
      changedPaths.some((path) => !validPath(path))) {
    throw new Error("delegated_pr_candidate_authority_corrupt");
  }
  const dataRoot = realDirectory(env.MENDPOINT_DATA_DIR, "delegated_pr_candidate_data_root_invalid");
  const reposRoot = realDirectory(env.MENDPOINT_REPOS_DIR, "delegated_pr_candidate_repos_root_invalid");
  const candidateTenantRoot = safeRoot(resolve(dataRoot, "warden-candidates", input.tenantId), dataRoot,
    "delegated_pr_candidate_workspace_escape");
  const candidateRoot = safeRoot(artifacts.candidateWorkspace, candidateTenantRoot,
    "delegated_pr_candidate_workspace_escape");
  const sourceTenantRoot = safeRoot(resolve(reposRoot, input.tenantId), reposRoot,
    "delegated_pr_candidate_source_escape");
  const sourceRoot = safeRoot(run.repo_path, sourceTenantRoot, "delegated_pr_candidate_source_escape");
  const manifestPath = realpathSync(resolve(artifacts.candidateManifest));
  if (!isWithin(candidateTenantRoot, manifestPath)) throw new Error("delegated_pr_candidate_manifest_escape");
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error("delegated_pr_candidate_manifest_invalid");
  }
  const manifestBytes = readFileSync(manifestPath);
  if (digest(manifestBytes) !== artifacts.candidateManifestSha256) {
    throw new Error("delegated_pr_candidate_manifest_digest_mismatch");
  }
  const manifest = parseObject(manifestBytes.toString("utf8"), "delegated_pr_candidate_manifest_invalid");
  const manifestSource = manifest.source && typeof manifest.source === "object" && !Array.isArray(manifest.source)
    ? manifest.source as Record<string, unknown> : null;
  const manifestCandidate = manifest.candidate && typeof manifest.candidate === "object" &&
    !Array.isArray(manifest.candidate) ? manifest.candidate as Record<string, unknown> : null;
  if (!manifestSource || !manifestCandidate || !Array.isArray(manifestCandidate.entries) ||
      source.repositoryId !== manifestSource.repositoryId || source.snapshotId !== manifestSource.snapshotId ||
      source.revision !== manifestSource.revision || source.manifestSha256 !== manifestSource.manifestSha256 ||
      artifacts.sourceDigest !== manifestSource.digest || artifacts.candidateDigest !== manifestCandidate.digest ||
      canonical(changedPaths) !== canonical(manifest.changedPaths)) {
    throw new Error("delegated_pr_candidate_manifest_binding_mismatch");
  }
  if (![source.repositoryId, source.snapshotId].every((value) => typeof value === "string" && ID.test(value)) ||
      typeof source.revision !== "string" || !REVISION.test(source.revision) ||
      typeof source.manifestSha256 !== "string" || !SHA256.test(source.manifestSha256) ||
      typeof artifacts.sourceDigest !== "string" || !DIGEST.test(artifacts.sourceDigest) ||
      typeof artifacts.candidateDigest !== "string" || !DIGEST.test(artifacts.candidateDigest)) {
    throw new Error("delegated_pr_candidate_manifest_binding_mismatch");
  }
  const candidateEntries = manifestCandidate.entries.map(parseEntry);
  if (treeDigest(candidateEntries) !== artifacts.candidateDigest) {
    throw new Error("delegated_pr_candidate_manifest_digest_mismatch");
  }
  const snapshotRows = listRepositorySnapshotFiles(db, input.tenantId, String(source.snapshotId));
  if (!snapshotRows.length || snapshotRows.some((row) => row.kind !== "file")) {
    throw new Error("delegated_pr_candidate_snapshot_files_invalid");
  }
  const sourceEntries = snapshotRows.map((row) => Object.freeze({
    path: row.path,
    size: row.size,
    sha256: `sha256:${row.sha256}`,
    executable: row.mode === "100755",
  }));
  if (treeDigest(sourceEntries) !== artifacts.sourceDigest) {
    throw new Error("delegated_pr_candidate_snapshot_digest_mismatch");
  }
  const sourceFiles = exactFiles(sourceRoot, sourceEntries);
  const candidateFiles = exactFiles(candidateRoot, candidateEntries);
  const candidate: ValidatedDelegatedPrCandidate = Object.freeze({
    tenantId: input.tenantId,
    runId: input.runId,
    jobId: run.job_id,
    repositoryId: String(source.repositoryId),
    snapshotId: String(source.snapshotId),
    revision: String(source.revision),
    sourceManifestSha256: String(source.manifestSha256),
    sourceTreeDigest: String(artifacts.sourceDigest),
    candidateTreeDigest: String(artifacts.candidateDigest),
    candidateManifestSha256: artifacts.candidateManifestSha256,
    changedPaths: Object.freeze(changedPaths.map(String).sort(compareCodeUnits)),
    createdAt: run.finished_at,
  });
  return Object.freeze({ candidate, sourceFiles, candidateFiles });
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key}_required`);
  return value;
}

function command(env: NodeJS.ProcessEnv, key: string): string {
  const value = required(env, key);
  if (value.length > 1_024 || /[\0\r\n;&|><`$]/.test(value)) throw new Error(`${key}_invalid`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum: number, maximum: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${key}_invalid`);
  return value;
}

async function flyExecute(input: DelegatedPrSandboxExecutionInput): Promise<DelegatedPrSandboxExecutionResult> {
  const handle = createSandbox({
    kind: "fly_machines",
    prefix: "mendpoint-delegated-verify-",
    tenantId: input.tenantId,
    files: input.files,
    fly: { execTimeoutMs: input.timeoutMs, capMs: input.timeoutMs },
  });
  if (typeof handle.runIsolated !== "function") {
    handle.dispose();
    throw new Error("delegated_pr_verifier_sandbox_unavailable");
  }
  try {
    const result = await handle.runIsolated(`cd /workspace && ${input.command}`, { timeoutMs: input.timeoutMs });
    return Object.freeze({ ok: result.ok, stdout: result.stdout, stderr: result.stderr,
      exitCode: typeof result.exitCode === "number" ? result.exitCode : -1, backend: "fly_machines" });
  } finally {
    handle.dispose();
  }
}

function signedReceipt(
  request: DelegatedPrVerifierRequest,
  result: DelegatedPrVerificationResolution,
  secret: string,
): DelegatedPrVerificationExchange {
  const unsigned = {
    tenantId: request.tenantId,
    runId: request.runId,
    candidateArtifactId: request.candidateArtifact.artifactId,
    requestDigest: request.requestDigest,
    leaseGeneration: request.leaseGeneration,
    authorityId: request.authorityId,
    outcome: result.status,
    resultDigest: delegatedPrVerificationResultDigest(result),
    observedAt: result.status === "completed" || result.status === "failed"
      ? result.completedAt : new Date().toISOString(),
  };
  const signature = `hmac-sha256:${createHmac("sha256", secret).update(canonical(unsigned)).digest("hex")}`;
  return Object.freeze({ result, receipt: Object.freeze({ ...unsigned, signature }) });
}

function receiptVerifier(secret: string) {
  return (receipt: DelegatedPrVerificationReceipt): boolean => {
    if (!/^hmac-sha256:[a-f0-9]{64}$/.test(receipt.signature)) return false;
    const { signature, ...unsigned } = receipt;
    const expected = createHmac("sha256", secret).update(canonical(unsigned)).digest();
    const observed = Buffer.from(signature.slice("hmac-sha256:".length), "hex");
    return observed.length === expected.length && timingSafeEqual(observed, expected);
  };
}

function execution(
  authorityId: string,
  authorityDigest: string,
  commandDigest: string,
  sourceDigest: string,
  candidateDigest: string,
  baseline: DelegatedPrSandboxExecutionResult,
  candidate: DelegatedPrSandboxExecutionResult,
  baselineVerdict: "test_failure" | "passed",
  sandboxBackend: string,
): DelegatedPrVerificationExecution {
  const logsDigest = digest(canonical({ baseline, candidate }));
  return Object.freeze({ authorityId, authorityDigest, commandDigest, sourceDigest, candidateDigest,
    baselineExitCode: baseline.exitCode, candidateExitCode: candidate.exitCode, baselineVerdict,
    // The runner output is not parsed, so which checks were failing is never observed. Emit the
    // not_observed sentinel rather than echoing the configured expectation as if it were seen.
    failingCheckIdentities: Object.freeze({ status: "not_observed" as const,
      reason: "check_identities_not_parsed_from_runner_output" }),
    sandboxBackend, logsDigest });
}

function createVerifier(input: Readonly<{
  db: AppDb;
  env: NodeJS.ProcessEnv;
  authorityId: string;
  authorityDigest: string;
  executionAuthorityId: string;
  receiptSecret: string;
  failToPassCommand: string;
  passToPassCommand: string;
  timeoutMs: number;
  execute: DelegatedPrSandboxExecutor;
}>): DelegatedPrVerifier {
  input.db.raw.exec(EFFECT_TABLE);
  const resolve = async (request: DelegatedPrVerifierRequest, allowDispatch: boolean): Promise<DelegatedPrVerificationExchange> => {
    const existing = input.db.raw.prepare(
      `SELECT run_id, candidate_artifact_id, phase, result_json
       FROM delegated_pr_sandbox_verifier_effects WHERE tenant_id = ? AND request_digest = ?`,
    ).get(request.tenantId, request.requestDigest) as
      | { run_id: string; candidate_artifact_id: string; phase: string; result_json: string | null }
      | undefined;
    if (existing && (existing.run_id !== request.runId ||
        existing.candidate_artifact_id !== request.candidateArtifact.artifactId)) {
      throw new Error("delegated_pr_verifier_effect_conflict");
    }
    if (existing?.phase === "settled" && existing.result_json) {
      const result = JSON.parse(existing.result_json) as DelegatedPrVerificationResolution;
      return signedReceipt(request, result, input.receiptSecret);
    }
    // A dispatched-but-unsettled row is a prior attempt that produced no durable outcome (a transient
    // sandbox transport error before any mutation). Re-running the sandbox is side-effect free, so
    // re-attempt it rather than latching the request into pending forever. Only a genuinely first
    // reconcile with nothing dispatched has nothing to run.
    if (!existing && !allowDispatch) {
      return signedReceipt(request, Object.freeze({ status: "pending" }), input.receiptSecret);
    }
    if (!existing) {
      input.db.raw.prepare(
        `INSERT INTO delegated_pr_sandbox_verifier_effects
         (tenant_id, request_digest, run_id, candidate_artifact_id, phase)
         VALUES (?, ?, ?, ?, 'dispatched')`,
      ).run(request.tenantId, request.requestDigest, request.runId, request.candidateArtifact.artifactId);
    }
    let result: DelegatedPrVerificationResolution;
    let externalStarted = false;
    try {
      const bundle = loadBundle(input.db, { tenantId: request.tenantId, runId: request.runId }, input.env);
      if (canonical(bundle.candidate) !== canonical({ ...request.candidate, tenantId: request.tenantId,
          runId: request.runId, jobId: bundle.candidate.jobId, createdAt: bundle.candidate.createdAt })) {
        throw new Error("delegated_pr_verifier_candidate_binding_mismatch");
      }
      const run = async (role: "fail_to_pass" | "pass_to_pass", workspace: "source" | "candidate", commandValue: string) =>
        input.execute({ tenantId: request.tenantId, role, workspace, command: commandValue,
          timeoutMs: input.timeoutMs, files: workspace === "source" ? bundle.sourceFiles : bundle.candidateFiles });
      externalStarted = true;
      const failBaseline = await run("fail_to_pass", "source", input.failToPassCommand);
      const failCandidate = await run("fail_to_pass", "candidate", input.failToPassCommand);
      const passBaseline = await run("pass_to_pass", "source", input.passToPassCommand);
      const passCandidate = await run("pass_to_pass", "candidate", input.passToPassCommand);
      const runs = [failBaseline, failCandidate, passBaseline, passCandidate];
      const observedExitCodes = runs.map((value) => value.exitCode);
      const backends = runs.map((value) => value.backend);
      // The backend must be reported by the executor that actually ran; never assume one. A stub
      // that cannot name its own backend leaves this unobserved and the run refuses to pass.
      const observedBackend = typeof backends[0] === "string" && ID.test(backends[0]) &&
        backends.every((value) => value === backends[0]) ? backends[0] : undefined;
      if (observedExitCodes.some((value) => !Number.isSafeInteger(value) || INFRA_EXIT_CODES.has(value)) ||
          !(failBaseline.exitCode > 0 && failCandidate.exitCode === 0 && passBaseline.exitCode === 0 &&
          passCandidate.exitCode === 0)) {
        result = Object.freeze({ status: "failed", code: "delegated_pr_verification_contract_failed",
          completedAt: new Date().toISOString() });
      } else if (observedBackend === undefined) {
        result = Object.freeze({ status: "failed", code: "delegated_pr_verification_sandbox_backend_unobserved",
          completedAt: new Date().toISOString() });
      } else {
        result = Object.freeze({
          status: "completed",
          executionAuthorityId: input.executionAuthorityId,
          failToPass: execution(input.authorityId, input.authorityDigest,
            digest(input.failToPassCommand), request.candidate.sourceTreeDigest,
            request.candidate.candidateTreeDigest, failBaseline, failCandidate, "test_failure",
            observedBackend),
          passToPass: execution(input.authorityId, input.authorityDigest,
            digest(input.passToPassCommand), request.candidate.sourceTreeDigest,
            request.candidate.candidateTreeDigest, passBaseline, passCandidate, "passed", observedBackend),
          completedAt: new Date().toISOString(),
        });
      }
    } catch {
      if (externalStarted) {
        return signedReceipt(request, Object.freeze({ status: "pending" }), input.receiptSecret);
      }
      result = Object.freeze({ status: "failed", code: "delegated_pr_verification_materialization_failed",
        completedAt: new Date().toISOString() });
    }
    input.db.raw.prepare(
      `UPDATE delegated_pr_sandbox_verifier_effects SET phase = 'settled', result_json = ?
       WHERE tenant_id = ? AND request_digest = ? AND phase = 'dispatched'`,
    ).run(canonical(result), request.tenantId, request.requestDigest);
    return signedReceipt(request, result, input.receiptSecret);
  };
  return Object.freeze({
    verify: (request: DelegatedPrVerifierRequest) => resolve(request, true),
    reconcile: (request: DelegatedPrVerifierRequest) => resolve(request, false),
  });
}

export function delegatedPrVerificationRuntimeFromEnv(
  db: AppDb,
  env: NodeJS.ProcessEnv,
  workerId: string,
  execute: DelegatedPrSandboxExecutor = flyExecute,
): DelegatedPrVerificationRuntime | undefined {
  if (env.MENDPOINT_DELEGATED_PR_VERIFICATION_ENABLED?.trim() !== "1") return undefined;
  const environmentErrors = validateDelegatedPrVerificationEnvironment(env, workerId);
  if (environmentErrors.length) throw new Error(environmentErrors.join("; "));
  const candidateAuthorityId = required(env, "MENDPOINT_DELEGATED_PR_CANDIDATE_AUTHORITY_ID");
  const authorityId = required(env, "MENDPOINT_DELEGATED_PR_VERIFIER_AUTHORITY_ID");
  const authorityDigest = required(env, "MENDPOINT_DELEGATED_PR_VERIFIER_AUTHORITY_DIGEST");
  const executionAuthorityId = required(env, "MENDPOINT_DELEGATED_PR_EXECUTION_AUTHORITY_ID");
  const receiptSecret = required(env, "MENDPOINT_DELEGATED_PR_RECEIPT_SECRET");
  const mendpointRevision = required(env, "MENDPOINT_GIT_COMMIT");
  const failToPassCommand = command(env, "MENDPOINT_DELEGATED_PR_FAIL_TO_PASS_COMMAND");
  const passToPassCommand = command(env, "MENDPOINT_DELEGATED_PR_PASS_TO_PASS_COMMAND");
  const timeoutMs = integer(env, "MENDPOINT_DELEGATED_PR_TIMEOUT_MS", 120_000, 1_000, 600_000);
  const leaseMs = integer(env, "MENDPOINT_DELEGATED_PR_LEASE_MS", 300_000, timeoutMs * 2, 1_800_000);
  if (![candidateAuthorityId, authorityId, executionAuthorityId, workerId].every((value) => ID.test(value)) ||
      candidateAuthorityId === authorityId || authorityId === executionAuthorityId ||
      !DIGEST.test(authorityDigest) || !REVISION.test(mendpointRevision) || receiptSecret.length < 32) {
    throw new Error("delegated_pr_verification_configuration_invalid");
  }
  const authority: DelegatedPrCandidateAuthority = Object.freeze({
    loadExactCandidate: async (database, identity) => loadBundle(database, identity, env).candidate,
  });
  const verifier = createVerifier({ db, env, authorityId, authorityDigest, executionAuthorityId,
    receiptSecret, failToPassCommand, passToPassCommand, timeoutMs, execute });
  return Object.freeze({
    candidateDependencies: Object.freeze({ enabled: true, authority,
      producerPrincipalId: candidateAuthorityId, producerVersion: mendpointRevision }),
    verificationDependencies: Object.freeze({ enabled: true, workerId, timeoutMs, leaseMs,
      candidateProducerPrincipalId: candidateAuthorityId, candidateProducerVersion: mendpointRevision,
      authorityId, authorityDigest, executionAuthorityId, mendpointRevision,
      policy: Object.freeze({ failToPassCommandDigest: digest(failToPassCommand),
        passToPassCommandDigest: digest(passToPassCommand),
        sandboxBackend: "fly_machines" }),
      verifier,
      verifyReceipt: receiptVerifier(receiptSecret),
    }),
  });
}
