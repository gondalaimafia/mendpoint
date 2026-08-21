import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimNextJob,
  createDb,
  getJob,
  insertAgentRun,
  insertPrincipal,
  insertRepositorySnapshot,
  insertRepositorySnapshotFiles,
  type AppDb,
} from "@mendpoint/db";
import {
  enqueueDelegatedPrVerificationJob,
  runDelegatedPrVerificationJob,
} from "./delegated-pr-verification-job.js";
import {
  delegatedPrVerificationRuntimeFromEnv,
  validateDelegatedPrVerificationEnvironment,
  type DelegatedPrSandboxExecutionInput,
} from "./delegated-pr-sandbox-verifier.js";

const opened: Array<{ db: AppDb; root: string }> = [];
const hex = (value: string) => value.repeat(64);
const revision = (value: string) => value.repeat(40);
const sha = (value: Buffer | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)]));
  return value;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "delegated-sandbox-verifier-"));
  const dataRoot = join(root, "data");
  const reposRoot = join(root, "repos");
  const sourceRoot = join(reposRoot, "tenant-a", "snapshot-a");
  const candidateRoot = join(dataRoot, "warden-candidates", "tenant-a");
  const candidateWorkspace = join(candidateRoot, "workspace-a");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(candidateWorkspace, { recursive: true });
  const sourceBytes = Buffer.from("export const value = 1;\n");
  const candidateBytes = Buffer.from("export const value = 2;\n");
  writeFileSync(join(sourceRoot, "src.ts"), sourceBytes);
  writeFileSync(join(candidateWorkspace, "src.ts"), candidateBytes);
  const sourceEntries = [{ path: "src.ts", size: sourceBytes.byteLength, sha256: sha(sourceBytes), executable: false }];
  const candidateEntries = [{ path: "src.ts", size: candidateBytes.byteLength, sha256: sha(candidateBytes), executable: false }];
  const sourceTreeDigest = sha(JSON.stringify(stable(sourceEntries)));
  const candidateTreeDigest = sha(JSON.stringify(stable(candidateEntries)));
  const manifest = {
    schemaVersion: 1,
    taskMode: "repair",
    scope: { tenantId: "tenant-a", attemptId: "run-a" },
    source: { repositoryId: "repo-a", snapshotId: "snapshot-a", revision: revision("a"),
      manifestSha256: hex("b"), digest: sourceTreeDigest },
    candidate: { digest: candidateTreeDigest, entries: candidateEntries },
    changedPaths: ["src.ts"],
    changedBytes: candidateBytes.byteLength,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestPath = join(candidateRoot, "run-a.manifest.json");
  writeFileSync(manifestPath, manifestBytes);
  const db = createDb(join(root, "worker.sqlite"));
  opened.push({ db, root });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, '2026-08-19T12:00:00.000Z')`,
  ).run();
  for (const principal of ["candidate-authority", "verifier-a"]) {
    insertPrincipal(db, { id: principal, tenantId: "tenant-a", kind: "service", subject: principal,
      displayName: principal, createdAt: "2026-08-19T12:00:00.000Z" });
  }
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES ('conn-a', 'tenant-a', 'github', 'secret://github/app', '1', 'GitHub',
      '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z')`).run();
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
     environment, retention_days, status, created_at, updated_at)
    VALUES ('repo-a', 'tenant-a', 'conn-a', '1', 'acme', 'repo', 'main', 'main', 'test', 30,
      'ready', '2026-08-19T12:00:00.000Z', '2026-08-19T12:00:00.000Z')`).run();
  insertRepositorySnapshot(db, { id: "snapshot-a", tenantId: "tenant-a", repositoryId: "repo-a",
    requestedRef: "main", resolvedSha: revision("a"), manifestSha256: hex("b"), storagePath: sourceRoot,
    submodulesPolicy: "reject", lfsPolicy: "reject", sparsePaths: [], fileManifestVersion: 1,
    createdAt: "2026-08-19T12:00:00.000Z", expiresAt: "2026-08-20T12:00:00.000Z" });
  insertRepositorySnapshotFiles(db, { tenantId: "tenant-a", snapshotId: "snapshot-a", files: [{
    path: "src.ts", mode: "100644", kind: "file", size: sourceBytes.byteLength,
    sha256: sha(sourceBytes).slice(7),
  }] });
  insertAgentRun(db, { id: "run-a", tenantId: "tenant-a", jobId: "source-job-a", goal: "repair",
    repoPath: sourceRoot, status: "candidate_ready", ok: true, steps: 2, filesChanged: ["src.ts"],
    resultJson: JSON.stringify({ source: { repositoryId: "repo-a", snapshotId: "snapshot-a",
      revision: revision("a"), manifestSha256: hex("b") }, changedPaths: ["src.ts"], artifacts: {
      candidateWorkspace, candidateManifest: manifestPath, sourceDigest: sourceTreeDigest,
      candidateDigest: candidateTreeDigest, candidateManifestSha256: sha(manifestBytes),
    } }), createdAt: "2026-08-19T12:01:00.000Z", finishedAt: "2026-08-19T12:01:00.000Z" });
  const env = {
    NODE_ENV: "production",
    MENDPOINT_DATA_DIR: dataRoot,
    MENDPOINT_REPOS_DIR: reposRoot,
    MENDPOINT_SANDBOX_KIND: "fly_machines",
    MENDPOINT_DELEGATED_PR_VERIFICATION_ENABLED: "1",
    MENDPOINT_DELEGATED_PR_CANDIDATE_AUTHORITY_ID: "candidate-authority",
    MENDPOINT_DELEGATED_PR_VERIFIER_AUTHORITY_ID: "verifier-a",
    MENDPOINT_DELEGATED_PR_VERIFIER_AUTHORITY_DIGEST: `sha256:${hex("3")}`,
    MENDPOINT_DELEGATED_PR_EXECUTION_AUTHORITY_ID: "sandbox-a",
    MENDPOINT_DELEGATED_PR_RECEIPT_SECRET: "test-receipt-secret-that-is-at-least-32-bytes",
    MENDPOINT_DELEGATED_PR_FAIL_TO_PASS_COMMAND: "npm test -- target",
    MENDPOINT_DELEGATED_PR_PASS_TO_PASS_COMMAND: "npm test -- regression",
    MENDPOINT_DELEGATED_PR_FAIL_TO_PASS_IDENTITIES: "test:target",
    MENDPOINT_GIT_COMMIT: revision("f"),
  } as NodeJS.ProcessEnv;
  return { db, env, root, sourceBytes, candidateBytes, candidateWorkspace };
}

afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.db.raw.close();
    rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("delegated PR Fly sandbox verifier", () => {
  it("does not require configured failing-check identities that the verifier cannot observe", () => {
    const { db, env } = fixture();
    delete env.MENDPOINT_DELEGATED_PR_FAIL_TO_PASS_IDENTITIES;
    expect(() => delegatedPrVerificationRuntimeFromEnv(db, env, "worker-a", async () => {
      throw new Error("not called");
    })).not.toThrow();
  });

  it("reconstructs exact sealed source and candidate bytes and publishes both command contracts", async () => {
    const value = fixture();
    const observedAt = new Date().toISOString();
    const execute = vi.fn(async (input: DelegatedPrSandboxExecutionInput) => ({
      ok: input.workspace === "candidate" || input.role === "pass_to_pass",
      stdout: `${input.workspace}:${input.role}`,
      stderr: "",
      exitCode: input.workspace === "source" && input.role === "fail_to_pass" ? 1 : 0,
      backend: "fly_machines",
    }));
    const runtime = delegatedPrVerificationRuntimeFromEnv(value.db, value.env, "worker-a", execute);
    expect(runtime).toBeDefined();
    const jobId = enqueueDelegatedPrVerificationJob(value.db, {
      tenantId: "tenant-a", runId: "run-a", correlationId: "source-job-a",
      createdAt: observedAt,
    });
    const job = claimNextJob(value.db, ["warden.candidate.verify"], {
      tenantId: "tenant-a", workerId: "worker-a", leaseMs: 60_000,
      now: observedAt,
    })!;
    const result = await runDelegatedPrVerificationJob(value.db, { job, ...runtime!,
      now: () => observedAt });
    expect(result.status).toBe("verified");
    expect(getJob(value.db, jobId, "tenant-a")?.status).toBe("done");
    expect(execute).toHaveBeenCalledTimes(4);
    for (const call of execute.mock.calls) {
      const input = call[0];
      expect(input.files["src.ts"]).toEqual(input.workspace === "source" ? value.sourceBytes : value.candidateBytes);
    }
    const executions = (value.db.raw.prepare(
      "SELECT content_text FROM artifact_manifests WHERE kind = 'delegated_pr_verification_execution' ORDER BY id",
    ).all() as Array<{ content_text: string }>).map((row) => JSON.parse(row.content_text).execution);
    expect(executions).toHaveLength(2);
    for (const artifact of executions) {
      // The backend is the one the executor reported, and check identities are honestly not_observed
      // rather than echoed from MENDPOINT_DELEGATED_PR_FAIL_TO_PASS_IDENTITIES.
      expect(artifact.sandboxBackend).toBe("fly_machines");
      expect(artifact.failingCheckIdentities).toEqual({
        status: "not_observed", reason: "check_identities_not_parsed_from_runner_output" });
    }
  });

  it("fails before sandbox execution when sealed candidate bytes drift", async () => {
    const value = fixture();
    const observedAt = new Date().toISOString();
    writeFileSync(join(value.candidateWorkspace, "src.ts"), "tampered\n");
    const execute = vi.fn();
    const runtime = delegatedPrVerificationRuntimeFromEnv(value.db, value.env, "worker-a", execute);
    const jobId = enqueueDelegatedPrVerificationJob(value.db, { tenantId: "tenant-a", runId: "run-a",
      correlationId: "source-job-a", createdAt: observedAt });
    const job = claimNextJob(value.db, ["warden.candidate.verify"], { tenantId: "tenant-a",
      workerId: "worker-a", leaseMs: 60_000, now: observedAt })!;
    const result = await runDelegatedPrVerificationJob(value.db, { job, ...runtime!,
      now: () => observedAt });
    expect(result.status).toBe("failed");
    expect(getJob(value.db, jobId, "tenant-a")?.status).toBe("dead_letter");
    expect(execute).not.toHaveBeenCalled();
  });

  it("reconciles a lost verifier response without repeating sandbox execution", async () => {
    const value = fixture();
    const observedAt = new Date().toISOString();
    const execute = vi.fn(async (input: DelegatedPrSandboxExecutionInput) => ({
      ok: input.workspace === "candidate" || input.role === "pass_to_pass",
      stdout: "bounded",
      stderr: "",
      exitCode: input.workspace === "source" && input.role === "fail_to_pass" ? 1 : 0,
      backend: "fly_machines",
    }));
    const runtime = delegatedPrVerificationRuntimeFromEnv(value.db, value.env, "worker-a", execute)!;
    const originalVerifier = runtime.verificationDependencies.verifier;
    let loseResponse = true;
    const verificationDependencies = {
      ...runtime.verificationDependencies,
      verifier: {
        verify: async (request: Parameters<typeof originalVerifier.verify>[0]) => {
          const response = await originalVerifier.verify(request);
          if (loseResponse) {
            loseResponse = false;
            throw Object.assign(new Error("transport lost"), { code: "ECONNRESET" });
          }
          return response;
        },
        reconcile: originalVerifier.reconcile,
      },
    };
    const jobId = enqueueDelegatedPrVerificationJob(value.db, { tenantId: "tenant-a", runId: "run-a",
      correlationId: "source-job-a", createdAt: observedAt });
    const first = claimNextJob(value.db, ["warden.candidate.verify"], { tenantId: "tenant-a",
      workerId: "worker-a", leaseMs: 60_000, now: observedAt })!;
    await expect(runDelegatedPrVerificationJob(value.db, { job: first,
      candidateDependencies: runtime.candidateDependencies, verificationDependencies,
      now: () => observedAt })).resolves.toMatchObject({ status: "retry_scheduled" });
    value.db.raw.prepare("UPDATE jobs SET available_at = ? WHERE id = ? AND tenant_id = ?")
      .run(observedAt, jobId, "tenant-a");
    const second = claimNextJob(value.db, ["warden.candidate.verify"], { tenantId: "tenant-a",
      workerId: "worker-a", leaseMs: 60_000, now: observedAt })!;
    await expect(runDelegatedPrVerificationJob(value.db, { job: second, ...runtime,
      now: () => observedAt })).resolves.toMatchObject({ status: "verified" });
    expect(execute).toHaveBeenCalledTimes(4);
    expect(getJob(value.db, jobId, "tenant-a")?.status).toBe("done");
  });

  it("settles an infrastructure exit as a signed terminal failure", async () => {
    const value = fixture();
    const observedAt = new Date().toISOString();
    const execute = vi.fn(async (input: DelegatedPrSandboxExecutionInput) => ({
      ok: false,
      stdout: "",
      stderr: "sandbox timed out",
      exitCode: input.workspace === "source" && input.role === "fail_to_pass" ? 124 : 0,
      backend: "fly_machines",
    }));
    const runtime = delegatedPrVerificationRuntimeFromEnv(value.db, value.env, "worker-a", execute)!;
    const jobId = enqueueDelegatedPrVerificationJob(value.db, { tenantId: "tenant-a", runId: "run-a",
      correlationId: "source-job-a", createdAt: observedAt });
    const job = claimNextJob(value.db, ["warden.candidate.verify"], { tenantId: "tenant-a",
      workerId: "worker-a", leaseMs: 60_000, now: observedAt })!;
    await expect(runDelegatedPrVerificationJob(value.db, { job, ...runtime,
      now: () => observedAt })).resolves.toMatchObject({
      status: "failed",
      code: "delegated_pr_verification_contract_failed",
    });
    expect(execute).toHaveBeenCalledTimes(4);
    expect(getJob(value.db, jobId, "tenant-a")?.status).toBe("dead_letter");
    expect(value.db.raw.prepare(
      "SELECT phase FROM delegated_pr_sandbox_verifier_effects WHERE tenant_id = ?",
    ).get("tenant-a")).toEqual({ phase: "settled" });
  });

  it("refuses to pass when the executor does not report its own sandbox backend", async () => {
    const value = fixture();
    const observedAt = new Date().toISOString();
    // A plain executor that stands in for Fly but never names its backend must not be assumed
    // to be fly_machines: the run settles as a signed failure instead of a false pass.
    const execute = vi.fn(async (input: DelegatedPrSandboxExecutionInput) => ({
      ok: input.workspace === "candidate" || input.role === "pass_to_pass",
      stdout: "",
      stderr: "",
      exitCode: input.workspace === "source" && input.role === "fail_to_pass" ? 1 : 0,
      backend: undefined as unknown as string,
    }));
    const runtime = delegatedPrVerificationRuntimeFromEnv(value.db, value.env, "worker-a", execute)!;
    const jobId = enqueueDelegatedPrVerificationJob(value.db, { tenantId: "tenant-a", runId: "run-a",
      correlationId: "source-job-a", createdAt: observedAt });
    const job = claimNextJob(value.db, ["warden.candidate.verify"], { tenantId: "tenant-a",
      workerId: "worker-a", leaseMs: 60_000, now: observedAt })!;
    await expect(runDelegatedPrVerificationJob(value.db, { job, ...runtime,
      now: () => observedAt })).resolves.toMatchObject({
      status: "failed",
      code: "delegated_pr_verification_sandbox_backend_unobserved",
    });
    expect(execute).toHaveBeenCalledTimes(4);
    expect(getJob(value.db, jobId, "tenant-a")?.status).toBe("dead_letter");
  });

  it("recovers from a transient sandbox transport error instead of poisoning the request", async () => {
    const value = fixture();
    const observedAt = new Date().toISOString();
    let calls = 0;
    const execute = vi.fn(async (input: DelegatedPrSandboxExecutionInput) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("sandbox transport lost"), { code: "ECONNRESET" });
      return {
        ok: input.workspace === "candidate" || input.role === "pass_to_pass",
        stdout: "",
        stderr: "",
        exitCode: input.workspace === "source" && input.role === "fail_to_pass" ? 1 : 0,
        backend: "fly_machines",
      };
    });
    const runtime = delegatedPrVerificationRuntimeFromEnv(value.db, value.env, "worker-a", execute)!;
    const jobId = enqueueDelegatedPrVerificationJob(value.db, { tenantId: "tenant-a", runId: "run-a",
      correlationId: "source-job-a", createdAt: observedAt });
    const first = claimNextJob(value.db, ["warden.candidate.verify"], { tenantId: "tenant-a",
      workerId: "worker-a", leaseMs: 60_000, now: observedAt })!;
    await expect(runDelegatedPrVerificationJob(value.db, { job: first, ...runtime,
      now: () => observedAt })).resolves.toMatchObject({ status: "retry_scheduled" });
    value.db.raw.prepare("UPDATE jobs SET available_at = ? WHERE id = ? AND tenant_id = ?")
      .run(observedAt, jobId, "tenant-a");
    const second = claimNextJob(value.db, ["warden.candidate.verify"], { tenantId: "tenant-a",
      workerId: "worker-a", leaseMs: 60_000, now: observedAt })!;
    await expect(runDelegatedPrVerificationJob(value.db, { job: second, ...runtime,
      now: () => observedAt })).resolves.toMatchObject({ status: "verified" });
    // One throwing call on the poisoned first attempt, then four successful runs on the retry.
    expect(calls).toBe(5);
    expect(getJob(value.db, jobId, "tenant-a")?.status).toBe("done");
    expect(value.db.raw.prepare(
      "SELECT phase FROM delegated_pr_sandbox_verifier_effects WHERE tenant_id = ?",
    ).get("tenant-a")).toEqual({ phase: "settled" });
  });

  it("is absent by default", () => {
    const value = fixture();
    expect(delegatedPrVerificationRuntimeFromEnv(value.db, {}, "worker-a", vi.fn())).toBeUndefined();
  });

  it("fails production preflight when enabled authority is incomplete", () => {
    expect(validateDelegatedPrVerificationEnvironment({
      MENDPOINT_DELEGATED_PR_VERIFICATION_ENABLED: "1",
      MENDPOINT_SANDBOX_KIND: "local",
    })).toEqual(expect.arrayContaining([
      expect.stringContaining("MENDPOINT_DELEGATED_PR_CANDIDATE_AUTHORITY_ID"),
      expect.stringContaining("MENDPOINT_SANDBOX_KIND=fly_machines"),
    ]));
  });
});
