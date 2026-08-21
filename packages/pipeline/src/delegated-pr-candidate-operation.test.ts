import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, insertAgentRun, insertPrincipal } from "@mendpoint/db";
import {
  promoteDelegatedPrCandidate,
  type DelegatedPrCandidateAuthority,
} from "./delegated-pr-candidate-operation.js";

const databases: ReturnType<typeof createDb>[] = [];
const roots: string[] = [];
const hex = (value: string) => value.repeat(64);
const revision = (value: string) => value.repeat(40);

afterEach(() => {
  for (const db of databases.splice(0)) db.raw.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "delegated-candidate-"));
  roots.push(root);
  const db = createDb(join(root, "test.sqlite"));
  databases.push(db);
  const createdAt = "2026-08-19T12:01:00.000Z";
  insertPrincipal(db, {
    id: "candidate-authority", tenantId: "tenant-a", kind: "service",
    subject: "candidate-authority", displayName: "Candidate authority",
    createdAt: "2026-08-19T12:00:00.000Z",
  });
  db.raw.prepare(
    `INSERT INTO scm_connections
     (id, tenant_id, provider, credential_ref, external_account_id, display_name,
      created_at, updated_at)
     VALUES ('connection-a', 'tenant-a', 'github', 'secret://github/app', 'account-a',
      'GitHub', ?, ?)`,
  ).run(createdAt, createdAt);
  db.raw.prepare(
    `INSERT INTO connected_repositories
     (id, tenant_id, connection_id, remote_id, owner, name, selected_branch, status,
      default_branch, environment, retention_days, created_at, updated_at)
     VALUES ('repo-a', 'tenant-a', 'connection-a', '101', 'acme', 'service', 'main',
      'ready', 'main', 'test', 30, ?, ?)`,
  ).run(createdAt, createdAt);
  db.raw.prepare(
    `INSERT INTO repository_snapshots
     (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256,
      storage_path, submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version,
      created_at, expires_at)
     VALUES ('snapshot-a', 'tenant-a', 'repo-a', 'main', ?, ?, 'snapshots/a',
      'reject', 'reject', '[]', 1, ?, '2026-08-20T12:00:00.000Z')`,
  ).run(revision("a"), hex("b"), createdAt);
  const candidate = Object.freeze({
    tenantId: "tenant-a",
    runId: "run-a",
    jobId: "job-a",
    repositoryId: "repo-a",
    snapshotId: "snapshot-a",
    revision: revision("a"),
    sourceManifestSha256: hex("b"),
    sourceTreeDigest: `sha256:${hex("c")}`,
    candidateTreeDigest: `sha256:${hex("d")}`,
    candidateManifestSha256: `sha256:${hex("e")}`,
    changedPaths: Object.freeze(["src/client.ts"]),
    createdAt,
  });
  insertAgentRun(db, {
    id: "run-a", tenantId: "tenant-a", jobId: "job-a", goal: "repair", repoPath: "repo",
    status: "candidate_ready", ok: true, steps: 2, filesChanged: [...candidate.changedPaths],
    resultJson: JSON.stringify({
      source: {
        repositoryId: candidate.repositoryId,
        snapshotId: candidate.snapshotId,
        revision: candidate.revision,
        manifestSha256: candidate.sourceManifestSha256,
      },
      artifacts: {
        sourceDigest: candidate.sourceTreeDigest,
        candidateDigest: candidate.candidateTreeDigest,
        candidateManifestSha256: candidate.candidateManifestSha256,
      },
    }),
    createdAt, finishedAt: createdAt,
  });
  const authority: DelegatedPrCandidateAuthority = Object.freeze({
    loadExactCandidate: vi.fn(async () => candidate),
  });
  const input = Object.freeze({
    tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a",
    idempotencyKey: "candidate-a", observedAt: "2026-08-19T12:02:00.000Z",
  });
  const dependencies = Object.freeze({
    enabled: true, authority, producerPrincipalId: "candidate-authority",
    producerVersion: revision("f"),
  });
  return { db, candidate, authority, input, dependencies };
}

describe("delegated PR candidate operation", () => {
  it("publishes one immutable candidate artifact from durable IDs and replays exactly", async () => {
    const { db, candidate, authority, input, dependencies } = fixture();
    const first = await promoteDelegatedPrCandidate(db, input, dependencies);
    const replay = await promoteDelegatedPrCandidate(
      db,
      { ...input, observedAt: "2026-08-19T12:03:00.000Z" },
      dependencies,
    );

    expect(replay).toEqual(first);
    expect(authority.loadExactCandidate).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      tenantId: "tenant-a", runId: "run-a", candidateTreeDigest: candidate.candidateTreeDigest,
      changedPaths: ["src/client.ts"],
      artifact: { artifactId: expect.stringMatching(/^delegated_candidate_[a-f0-9]{40}$/) },
    });
    const artifact = db.raw.prepare(
      "SELECT kind, sha256, content_text FROM artifact_manifests WHERE id = ?",
    ).get(first.artifact.artifactId) as { kind: string; sha256: string; content_text: string };
    expect(artifact.kind).toBe("delegated_pr_candidate");
    expect(createHash("sha256").update(artifact.content_text).digest("hex")).toBe(artifact.sha256);
    expect(JSON.parse(artifact.content_text)).toMatchObject({
      kind: "delegated_pr_candidate", tenantId: "tenant-a", runId: "run-a",
      repositoryId: "repo-a", snapshotId: "snapshot-a", revision: revision("a"),
      candidateTreeDigest: candidate.candidateTreeDigest,
      candidateManifestSha256: candidate.candidateManifestSha256,
      changedPaths: ["src/client.ts"],
    });
  });

  it.each([
    ["repository", { repositoryId: "repo-b" }],
    ["snapshot", { snapshotId: "snapshot-b" }],
    ["revision", { revision: revision("9") }],
    ["source manifest", { sourceManifestSha256: hex("9") }],
    ["candidate tree", { candidateTreeDigest: `sha256:${hex("9")}` }],
    ["changed paths", { changedPaths: ["src/other.ts"] }],
  ])("fails closed on %s drift and writes nothing", async (_name, change) => {
    const { db, candidate, authority, input, dependencies } = fixture();
    vi.mocked(authority.loadExactCandidate).mockResolvedValueOnce(Object.freeze({ ...candidate, ...change }));
    await expect(promoteDelegatedPrCandidate(db, input, dependencies))
      .rejects.toThrow(/delegated_pr_candidate_authority_mismatch/);
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM artifact_manifests WHERE kind = 'delegated_pr_candidate'",
    ).get()).toEqual({ count: 0 });
  });

  it("rejects conflicting replay without rereading mutable candidate state", async () => {
    const { db, authority, input, dependencies } = fixture();
    await promoteDelegatedPrCandidate(db, input, dependencies);
    await expect(promoteDelegatedPrCandidate(db, { ...input, runId: "run-b" }, dependencies))
      .rejects.toThrow();
    expect(authority.loadExactCandidate).toHaveBeenCalledTimes(1);
  });
});
