import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, insertArtifactManifest, insertPrincipal } from "@mendpoint/db";
import { exactDraftCleanupOperationId } from "@mendpoint/github";
import {
  recordDelegatedPrCleanup,
  getVerifiedFettlerDelegationEvidence,
  verifyStoredDelegatedPrCleanup,
} from "./delegated-pr-cleanup-operation.js";

const databases: ReturnType<typeof createDb>[] = [];
const roots: string[] = [];
const sha = (value: string) => value.repeat(40);
const digest = (value: string) => `sha256:${value.repeat(64)}`;

afterEach(() => {
  for (const db of databases.splice(0)) db.raw.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "delegated-cleanup-"));
  roots.push(root);
  const db = createDb(join(root, "test.sqlite"));
  databases.push(db);
  insertPrincipal(db, {
    id: "cleanup-service",
    tenantId: "tenant-a",
    kind: "service",
    subject: "cleanup-controller",
    displayName: "Cleanup controller",
    createdAt: "2026-08-18T12:00:00.000Z",
  });
  db.raw.prepare(
    `INSERT INTO fettler_candidate_deliveries
     (id, tenant_id, run_id, job_id, status, repository_id, snapshot_id, base_branch,
      expected_base_revision, sealed_path, sealed_sha256, requester_principal_id, rationale,
      intent_digest, branch_name, base_revision, commit_sha, draft_pr, draft_pr_number,
      draft_pr_url, requested_at, delivered_at, updated_at)
     VALUES ('delivery-row', 'tenant-a', 'run-a', 'delivery-job', 'delivered', 'repo-a',
      'snapshot', 'main', ?, 'sealed', ?, 'reviewer', 'approved', ?, 'mendpoint/change',
      ?, ?, 1, 17, 'https://github.com/acme/service/pull/17', ?, ?, ?)`,
  ).run(
    sha("a"), digest("b"), digest("c"), sha("a"), sha("b"),
    "2026-08-18T12:01:00.000Z", "2026-08-18T12:02:00.000Z", "2026-08-18T12:02:00.000Z",
  );
  db.raw.prepare(
    `INSERT INTO fettler_ci_cycles
     (id, tenant_id, delivery_id, observation_job_id, status, repository_id,
      remote_repository_id, installation_id, pull_request_number, base_branch, branch_name,
      base_revision, current_head_sha, required_checks_json, allowed_changed_paths_json,
      max_cycles, used_cycles, max_model_calls, maximum_cost_usd, created_at, updated_at)
     VALUES ('cycle-a', 'tenant-a', 'delivery-row', 'observe-job', 'awaiting_review', 'repo-a',
      101, 501, 17, 'main', 'mendpoint/change', ?, ?, '["check:77:unit"]',
      '["src/a.ts"]', 3, 0, 4, 1.5, ?, ?)`,
  ).run(sha("a"), sha("b"), "2026-08-18T12:02:00.000Z", "2026-08-18T12:02:00.000Z");
  const add = (id: string, kind: string) => {
    const content = JSON.stringify({ id, kind, tenantId: "tenant-a", repositoryId: "repo-a", runId: "run-a", correlationId: "corr-a" });
    insertArtifactManifest(db, {
      id, tenantId: "tenant-a", kind, schemaVersion: 1,
      sha256: createHash("sha256").update(content).digest("hex"),
      mediaType: "application/json", sizeBytes: Buffer.byteLength(content),
      storageRef: `sqlite://${id}`, content, producerPrincipalId: "cleanup-service",
      createdAt: "2026-08-18T12:00:00.000Z",
    });
  };
  for (const [id, kind] of [
    ["source", "source"], ["snapshot", "snapshot"], ["candidate", "candidate"],
    ["verification", "verification"], ["policy", "policy"], ["delivery-artifact", "delivery"],
  ] as const) add(id, kind);

  let state: "open" | "closed" = "open";
  let listCalls = 0;
  const pull = () => ({
    number: 17, html_url: "https://github.com/acme/service/pull/17", state, draft: true,
    merged_at: null,
    base: { ref: "main", sha: sha("a"), repo: { id: 101 } },
    head: { ref: "mendpoint/change", sha: sha("b"), repo: { id: 101 } },
  });
  const octokit = {
    pulls: {
      get: vi.fn(async () => ({ data: pull() })),
      update: vi.fn(async () => { state = "closed"; return { data: pull() }; }),
      list: vi.fn(async () => ({ data: listCalls++ === 0 ? [pull()] : [], headers: {} })),
    },
    git: {
      getRef: vi.fn(async ({ ref }: { ref: string }) => ({
        data: { object: { sha: ref === "heads/main" ? sha("a") : sha("b") } },
      })),
    },
  } as unknown as Octokit;
  const keys = generateKeyPairSync("ed25519");
  const signer = {
    keyId: "cleanup-key", algorithm: "ed25519" as const,
    sign: (bytes: Uint8Array) => new Uint8Array(sign(null, bytes, keys.privateKey)),
  };
  const trustPolicy = {
    resolve: () => ({
      keyId: "cleanup-key", algorithm: "ed25519" as const, publicKey: keys.publicKey,
      principalId: "cleanup-service", service: "mendpoint-delegated-cleanup",
      tenantIds: ["tenant-a"], predicateTypes: ["https://mendpoint.ai/attestations/software/v1"],
      validFrom: "2026-08-18T00:00:00.000Z", validUntil: "2026-08-20T00:00:00.000Z", revokedAt: null,
    }),
  };
  const scope = {
    owner: "acme", repo: "service", installationId: 501, expectedRepositoryId: 101,
    pullRequestNumber: 17, baseBranch: "main", expectedBaseSha: sha("a"),
    headBranch: "mendpoint/change", expectedHeadSha: sha("b"), headDisposition: "retain_exact" as const,
  };
  const input = {
    tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a",
    actorPrincipalId: "cleanup-service", deliveryRecordId: "delivery-row", cycleId: "cycle-a",
    idempotencyKey: "cleanup-a", observedAt: "2026-08-18T12:03:00.000Z",
    cleanup: { ...scope, operationId: exactDraftCleanupOperationId(scope) },
    artifacts: {
      sourceIds: ["source"], snapshotId: "snapshot", candidateId: "candidate",
      verificationIds: ["verification"], policyId: "policy", deliveryId: "delivery-artifact",
    },
  };
  const dependencies = {
    enabled: true as const, octokit, signer, authorizeActor: () => true,
    producerService: "mendpoint-delegated-cleanup",
  };
  return { db, input, dependencies, trustPolicy, octokit };
}

describe("delegated PR cleanup operation", () => {
  it("performs exact cleanup, persists immutable evidence, signs it, and replays without another mutation", async () => {
    const { db, input, dependencies, trustPolicy, octokit } = fixture();
    const first = await recordDelegatedPrCleanup(db, input, dependencies);
    const replay = await recordDelegatedPrCleanup(
      db,
      { ...input, observedAt: "2026-08-18T12:04:00.000Z" },
      dependencies,
    );
    expect(replay).toEqual(first);
    expect(octokit.pulls.update).toHaveBeenCalledTimes(1);
    expect(first.cleanup).toMatchObject({
      pullRequestState: "closed", branchState: "retained_exact",
      headSha: sha("b"), baseSha: sha("a"), openPullRequestsForHead: 0,
    });
    const verified = await verifyStoredDelegatedPrCleanup(db, {
      tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a",
      verifiedAt: "2026-08-18T12:05:00.000Z", trustPolicy,
    });
    expect(verified?.cleanup).toEqual(first.cleanup);
    expect(verified?.attestation.statement.predicate.scope.rollbackArtifact?.artifactId)
      .toBe(first.cleanupArtifactId);
    const inventory = await getVerifiedFettlerDelegationEvidence(db, {
      tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a",
      verifiedAt: "2026-08-18T12:05:00.000Z", trustPolicy,
    });
    expect(inventory.cleanup).toEqual({
      status: "observed",
      value: expect.objectContaining({
        cleanupId: first.cleanupId,
        attestationId: first.attestation.attestationId,
        cleanup: first.cleanup,
      }),
    });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM artifact_manifests WHERE tenant_id = ? AND kind = 'delegated_pr_cleanup_rollback'").get("tenant-a"))
      .toEqual({ count: 1 });
  });

  it("fails closed before remote mutation for disabled, unauthorized, cross-scope, or untrusted reads", async () => {
    const { db, input, dependencies, trustPolicy, octokit } = fixture();
    await expect(recordDelegatedPrCleanup(db, input, { enabled: false } as never))
      .rejects.toThrow("delegated_pr_cleanup_disabled");
    await expect(recordDelegatedPrCleanup(db, input, { ...dependencies, authorizeActor: () => false }))
      .rejects.toThrow("delegated_pr_cleanup_actor_unauthorized");
    await expect(recordDelegatedPrCleanup(db, {
      ...input, cleanup: { ...input.cleanup, installationId: 999 },
    }, dependencies)).rejects.toThrow("delegated_pr_cleanup_scope_mismatch");
    expect(octokit.pulls.update).not.toHaveBeenCalled();

    const recorded = await recordDelegatedPrCleanup(db, input, dependencies);
    expect(() => db.raw.prepare(
      "UPDATE artifact_manifests SET content_text = '{}' WHERE tenant_id = ? AND id = ?",
    ).run("tenant-a", recorded.cleanupArtifactId)).toThrow(/artifact_manifests_append_only/);
    await expect(recordDelegatedPrCleanup(db, {
      ...input, artifacts: { ...input.artifacts, candidateId: "source" },
    }, dependencies)).rejects.toThrow("delegated_pr_cleanup_idempotency_conflict");
    await expect(verifyStoredDelegatedPrCleanup(db, {
      tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a",
      verifiedAt: "2026-08-18T12:05:00.000Z",
      trustPolicy: { ...trustPolicy, resolve: () => null },
    })).rejects.toThrow("software_attestation_key_untrusted");
    await expect(verifyStoredDelegatedPrCleanup(db, {
      tenantId: "tenant-b", runId: "run-a", correlationId: "corr-a",
      verifiedAt: "2026-08-18T12:05:00.000Z", trustPolicy,
    })).resolves.toBeUndefined();
    await expect(verifyStoredDelegatedPrCleanup(db, {
      tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a",
      verifiedAt: "2026-08-20T12:05:00.000Z", maximumAgeMs: 60_000, trustPolicy,
    })).rejects.toThrow("delegated_pr_cleanup_stale");
  });

  it("snapshots the authorized input and signer configuration before invoking remote code", async () => {
    const { db, input, dependencies, octokit } = fixture();
    const update = octokit.pulls.update as unknown as ReturnType<typeof vi.fn>;
    const original = update.getMockImplementation();
    update.mockImplementation(async (...args: unknown[]) => {
      (input.artifacts as { candidateId: string }).candidateId = "source";
      (dependencies as { producerService: string }).producerService = "tampered-service";
      return original!(...args);
    });
    const recorded = await recordDelegatedPrCleanup(db, input, dependencies);
    expect(recorded.attestation.scope.candidateArtifact.artifactId).toBe("candidate");
    expect(recorded.attestation.statement.predicate.producer.service)
      .toBe("mendpoint-delegated-cleanup");
  });

  it("does not publish passed cleanup evidence until signing succeeds", async () => {
    const { db, input, dependencies, octokit } = fixture();
    await expect(recordDelegatedPrCleanup(db, input, {
      ...dependencies,
      signer: { ...dependencies.signer, sign: () => { throw new Error("signer unavailable"); } },
    })).rejects.toThrow("signer unavailable");
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM evidence_records WHERE tenant_id = ? AND subject_type = 'delegated_pr_cleanup'",
    ).get("tenant-a")).toEqual({ count: 0 });

    await expect(recordDelegatedPrCleanup(db, input, dependencies)).resolves.toBeDefined();
    expect(octokit.pulls.update).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM evidence_records WHERE tenant_id = ? AND subject_type = 'delegated_pr_cleanup'",
    ).get("tenant-a")).toEqual({ count: 1 });
  });
});
