import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDb,
  insertApiChange,
  insertApiVersion,
  insertConsumer,
  insertMigrationPr,
  insertProvider,
  type AppDb,
} from "@mendpoint/db";
import { afterEach, describe, expect, it } from "vitest";
import { listPullRequestReadModel } from "./pull-request-read-model.js";

const NOW = "2026-08-31T12:00:00.000Z";
const opened: Array<{ db: AppDb; root: string }> = [];

afterEach(() => {
  for (const { db, root } of opened.splice(0)) {
    db.raw.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-fettler-pr-feed-"));
  const db = createDb(join(root, "test.sqlite"));
  opened.push({ db, root });
  return { db, root, env: { MENDPOINT_DATA_DIR: join(root, "data") } as NodeJS.ProcessEnv };
}

function seedLegacy(db: AppDb, tenantId: string) {
  insertProvider(db, { id: "provider-a", slug: "provider-a", name: "Provider A", createdAt: NOW });
  insertApiVersion(db, {
    id: "version-a-1", providerId: "provider-a", versionLabel: "1",
    openapiJson: '{"info":{"version":"1"}}', publishedAt: NOW,
  });
  insertApiVersion(db, {
    id: "version-a-2", providerId: "provider-a", versionLabel: "2",
    openapiJson: '{"info":{"version":"2"}}', publishedAt: NOW,
  });
  insertApiChange(db, {
    id: "change-a", providerId: "provider-a", fromVersionId: "version-a-1",
    toVersionId: "version-a-2", risk: "breaking", summary: "Legacy change",
    diffJson: "[]", createdAt: NOW,
  });
  insertConsumer(db, {
    id: "consumer-a", name: "Consumer A", githubOwner: "customer",
    githubRepo: "legacy", tenantId, createdAt: NOW,
  });
  insertMigrationPr(db, {
    id: "legacy-pr", changeId: "change-a", consumerId: "consumer-a",
    title: "Legacy migration", body: "Legacy body", branchName: "mendpoint/legacy",
    status: "draft", risk: "breaking", patchUnified: "", createdAt: NOW,
  });
}

function seedCandidate(input: Readonly<{
  db: AppDb;
  root: string;
  tenantId: string;
  id: string;
  repositoryId: string;
  requestedAt: string;
  tamper?: boolean;
}>) {
  const revision = "a".repeat(40);
  const approvals = join(input.root, "data", "warden-evidence", input.tenantId, "approvals");
  mkdirSync(approvals, { recursive: true });
  const artifact = {
    schemaVersion: 5,
    tenantId: input.tenantId,
    repositoryId: input.repositoryId,
    snapshotId: `snapshot-${input.id}`,
    baseBranch: "main",
    expectedBaseRevision: revision,
    reviewerPrincipalId: "human:reviewer@example.com",
    rationale: "The exact candidate and checks are approved.",
    reviewEvidence: {
      schemaVersion: 1,
      summary: "Replace the removed provider field",
      verification: {
        summary: "The focused and regression checks passed.",
        commands: [{
          command: "npm test",
          ok: true,
          exitCode: 0,
          outputSha256: `sha256:${"f".repeat(64)}`,
        }],
      },
      edits: [{
        path: "src/client.ts",
        rationale: "Use the supported field.",
        category: "provider_migration",
        risk: "medium",
        confidence: 0.95,
        assessmentSource: "planner",
        verification: {
          summary: "The focused and regression checks passed.",
          commandOutputSha256: [`sha256:${"f".repeat(64)}`],
        },
      }],
    },
    fettlerProviderChange: {
      schemaVersion: 1,
      providerSlug: "stripe",
      changeId: "change-stripe-2026-08",
      pipelineJobId: "pipeline-job-a",
      repositoryId: input.repositoryId,
      snapshotId: `snapshot-${input.id}`,
      revision,
      graphVersionId: "graph-version-a",
      graphContextArtifactId: "graph-context-a",
      impactEvidenceDigest: `sha256:${"e".repeat(64)}`,
      overallConfidence: "high",
      whatChanged: "The provider removed a field used by the client.",
      knownFacts: ["The removed field is read in src/client.ts."],
      unknowns: ["Runtime traffic volume is not observed."],
      whyAffected: "The repository reads the provider field removed by this version.",
    },
    changedPaths: ["src/client.ts"],
    sourceDigest: `sha256:${"b".repeat(64)}`,
    candidate: { digest: `sha256:${"c".repeat(64)}`, entries: [] },
    files: [],
  };
  const bytes = Buffer.from(JSON.stringify(artifact));
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const path = join(approvals, `${input.id}.json`);
  writeFileSync(path, bytes);
  if (input.tamper) writeFileSync(path, `${bytes.toString("utf8")} `);
  input.db.raw.prepare(
    `INSERT INTO fettler_candidate_deliveries
      (id, tenant_id, run_id, job_id, status, repository_id, snapshot_id, base_branch,
       expected_base_revision, sealed_path, sealed_sha256, requester_principal_id,
       rationale, branch_name, base_revision, commit_sha, draft_pr, draft_pr_number,
       draft_pr_url, requested_at, delivered_at, updated_at)
     VALUES (?, ?, ?, ?, 'delivered', ?, ?, 'main', ?, ?, ?, 'human:reviewer@example.com',
       'The exact candidate and checks are approved.', 'fettler/stripe-change', ?, ?, 1, 42,
       'https://github.com/customer/repo/pull/42', ?, ?, ?)`,
  ).run(
    input.id, input.tenantId, `run-${input.id}`, `job-${input.id}`,
    input.repositoryId, `snapshot-${input.id}`, revision, path, digest,
    revision, "d".repeat(40), input.requestedAt, input.requestedAt, input.requestedAt,
  );
}

describe("Fettler pull request read model", () => {
  it("merges legacy rows with tenant scoped sealed candidate delivery evidence", () => {
    const { db, root, env } = setup();
    seedLegacy(db, "tenant-a");
    seedCandidate({
      db, root, tenantId: "tenant-a", id: "candidate-a", repositoryId: "repo-a",
      requestedAt: "2026-08-31T13:00:00.000Z",
    });
    seedCandidate({
      db, root, tenantId: "tenant-b", id: "candidate-b", repositoryId: "repo-b",
      requestedAt: "2026-08-31T14:00:00.000Z",
    });

    const rows = listPullRequestReadModel({ db, tenantId: "tenant-a", limit: 20, offset: 0, env });

    expect(rows.map((row) => [row.id, row.source])).toEqual([
      ["candidate-a", "fettler_candidate"],
      ["legacy-pr", "legacy_migration"],
    ]);
    expect(rows[0]).toMatchObject({
      status: "delivered",
      githubPrNumber: 42,
      candidateDelivery: {
        deliveryStatus: "delivered",
        repositoryId: "repo-a",
        snapshotId: "snapshot-candidate-a",
        expectedBaseRevision: "a".repeat(40),
        deliveredCommitSha: "d".repeat(40),
        providerChange: {
          providerSlug: "stripe",
          changeId: "change-stripe-2026-08",
          graphVersionId: "graph-version-a",
          knownFacts: ["The removed field is read in src/client.ts."],
          unknowns: ["Runtime traffic volume is not observed."],
        },
        proposedMigration: {
          summary: "Replace the removed provider field",
          edits: [{
            path: "src/client.ts",
            explanation: "Use the supported field.",
            risk: "medium",
            confidence: 0.95,
          }],
        },
        verification: { summary: "The focused and regression checks passed." },
        changedPaths: ["src/client.ts"],
      },
    });
  });

  it("fails closed when a candidate approval artifact no longer matches its seal", () => {
    const { db, root, env } = setup();
    seedCandidate({
      db, root, tenantId: "tenant-a", id: "candidate-a", repositoryId: "repo-a",
      requestedAt: NOW, tamper: true,
    });

    expect(() => listPullRequestReadModel({
      db, tenantId: "tenant-a", limit: 20, offset: 0, env,
    })).toThrow("warden_candidate_approval_digest_mismatch");
  });

  it("rejects a blank tenant scope", () => {
    const { db, env } = setup();
    expect(() => listPullRequestReadModel({
      db, tenantId: " ", limit: 20, offset: 0, env,
    })).toThrow("tenant_scope_required");
  });
});
