import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, getJob, insertAgentRun, type AppDb } from "./index.js";
import {
  bindWardenCandidateDeliveryScope,
  bindWardenCandidateDeliveryIntent,
  enqueueWardenCandidateDelivery,
  getWardenCandidateDelivery,
  getWardenCandidateDeliveryByRun,
  recordWardenCandidateDeliveryFailure,
  recordWardenCandidateDeliverySuccess,
} from "./warden-candidate-delivery.js";

const NOW = "2026-08-06T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

function sealedProviderChange(repositoryId = "repo-1") {
  return {
    schemaVersion: 5,
    tenantId: "tenant-a",
    repositoryId,
    snapshotId: "snapshot-1",
    baseBranch: "main",
    expectedBaseRevision: "a".repeat(40),
    fettlerProviderChange: {
      schemaVersion: 1,
      providerSlug: "stripe",
      changeId: "change-stripe-2026-08-31",
      pipelineJobId: "pipeline-job-1",
      contentHash: "0123456789abcdef",
      fromVersionId: "version-stripe-2026-07-29",
      fromVersionLabel: "2026-07-29.dahlia",
      toVersionId: "version-stripe-2026-08-31",
      toVersionLabel: "2026-08-31.acacia",
      repositoryId,
      snapshotId: "snapshot-1",
      revision: "a".repeat(40),
    },
  } as const;
}

function seedPrecursorInputs(db: AppDb) {
  db.raw.exec(`
    INSERT INTO providers (id, slug, name, created_at)
      VALUES ('provider-stripe', 'stripe', 'Stripe', '${NOW}');
    INSERT INTO api_versions (id, provider_id, version_label, openapi_json, published_at)
      VALUES ('version-stripe-2026-07-29', 'provider-stripe', '2026-07-29.dahlia', '{}', '${NOW}'),
             ('version-stripe-2026-08-31', 'provider-stripe', '2026-08-31.acacia', '{}', '${NOW}');
    INSERT INTO api_changes (id, provider_id, from_version_id, to_version_id, risk, summary, diff_json, created_at)
      VALUES ('change-stripe-2026-08-31', 'provider-stripe', 'version-stripe-2026-07-29',
        'version-stripe-2026-08-31', 'breaking', 'Removed request field', '{}', '${NOW}');
  `);
}

function seedRepositoryConsumer(db: AppDb, input: { consumerId: string; repoRowId: string; repositoryId: string }) {
  db.raw.prepare(
    `INSERT INTO consumers (id, name, github_owner, github_repo, tenant_id, created_at)
     VALUES (?, ?, 'acme', 'sdk', 'tenant-a', ?)`,
  ).run(input.consumerId, input.consumerId, NOW);
  db.raw.prepare(
    `INSERT INTO consumer_repos (id, consumer_id, local_path, connected_repository_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.repoRowId, input.consumerId, `C:\\repos\\${input.consumerId}`, input.repositoryId, NOW);
}

function seedNotificationOnlyMigrationPr(db: AppDb, input: { id: string; consumerId: string }) {
  db.raw.prepare(
    `INSERT INTO migration_prs
     (id, change_id, consumer_id, title, body, branch_name, status, risk, patch_unified, created_at)
     VALUES (?, 'change-stripe-2026-08-31', ?, 'Notice', 'Notice only', 'none',
       'notification_only', 'breaking', '', ?)`,
  ).run(input.id, input.consumerId, NOW);
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-warden-delivery-db-"));
  const db = createDb(join(directory, "test.sqlite"));
  opened.push({ db, directory });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?),
            ('tenant-b', 'tenant-b', 'Tenant B', 'team', 'active', 10, ?)`,
  ).run(NOW, NOW);
  insertAgentRun(db, {
    id: "warden-run-1",
    tenantId: "tenant-a",
    jobId: "source-job-1",
    goal: "Repair the SDK",
    repoPath: "C:\\snapshot",
    status: "candidate_approved",
    ok: true,
    steps: 3,
    filesChanged: ["src/client.ts"],
    resultJson: JSON.stringify({
      source: {
        repositoryId: "repo-1",
        snapshotId: "snapshot-1",
        revision: "a".repeat(40),
      },
      artifacts: {
        approval: {
          path: "C:\\data\\warden-evidence\\tenant-a\\approvals\\seal.json",
          sha256: `sha256:${"b".repeat(64)}`,
        },
      },
      review: {
        decision: "approve",
        reviewerPrincipalId: "human:reviewer@example.com",
        rationale: "The target and regression checks pass.",
      },
    }),
    createdAt: NOW,
    finishedAt: NOW,
  });
  return db;
}

afterEach(() => {
  while (opened.length) {
    const entry = opened.pop()!;
    entry.db.raw.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

describe("Warden candidate delivery outbox", () => {
  it("atomically enqueues one deterministic tenant-scoped draft delivery", () => {
    const db = fixture();
    const input = {
      tenantId: "tenant-a",
      runId: "warden-run-1",
      repositoryId: "repo-1",
      snapshotId: "snapshot-1",
      baseBranch: "main",
      expectedBaseRevision: "a".repeat(40),
      sealedPath: "C:\\data\\warden-evidence\\tenant-a\\approvals\\seal.json",
      sealedSha256: `sha256:${"b".repeat(64)}`,
      requesterPrincipalId: "human:reviewer@example.com",
      rationale: "The target and regression checks pass.",
      now: NOW,
    } as const;

    const first = enqueueWardenCandidateDelivery(db, input);
    const replay = enqueueWardenCandidateDelivery(db, input);

    expect(replay).toEqual(first);
    expect(first.status).toBe("delivery_pending");
    expect(first.precursorMigrationPrId).toBeNull();
    expect((db.raw.prepare("PRAGMA table_info(fettler_candidate_deliveries)").all() as Array<{ name: string }>)
      .map((column) => column.name)).toContain("precursor_migration_pr_id");
    expect((db.raw.prepare("PRAGMA index_list(fettler_candidate_deliveries)").all() as Array<{ name: string }>)
      .map((index) => index.name)).toContain("fettler_candidate_deliveries_precursor_idx");
    expect(getJob(db, first.jobId, "tenant-a")).toMatchObject({
      type: "warden.candidate.deliver",
      status: "pending",
    });
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", "warden-run-1")).toEqual(first);
    expect(getWardenCandidateDeliveryByRun(db, "tenant-b", "warden-run-1")).toBeUndefined();
  });

  it("rejects a replay whose immutable repository binding differs", () => {
    const db = fixture();
    const base = {
      tenantId: "tenant-a",
      runId: "warden-run-1",
      repositoryId: "repo-1",
      snapshotId: "snapshot-1",
      baseBranch: "main",
      expectedBaseRevision: "a".repeat(40),
      sealedPath: "C:\\data\\warden-evidence\\tenant-a\\approvals\\seal.json",
      sealedSha256: `sha256:${"b".repeat(64)}`,
      requesterPrincipalId: "human:reviewer@example.com",
      rationale: "The target and regression checks pass.",
      now: NOW,
    } as const;
    enqueueWardenCandidateDelivery(db, base);
    expect(() => enqueueWardenCandidateDelivery(db, { ...base, baseBranch: "release" }))
      .toThrow("warden_candidate_delivery_conflict");
  });

  it("rejects a second approved run for the same sealed provider change and repository", () => {
    const db = fixture();
    insertAgentRun(db, {
      id: "warden-run-2",
      tenantId: "tenant-a",
      jobId: "source-job-2",
      goal: "Repair the same SDK change",
      repoPath: "C:\\snapshot",
      status: "candidate_approved",
      ok: true,
      steps: 3,
      filesChanged: ["src/client.ts"],
      resultJson: JSON.stringify({
        source: { repositoryId: "repo-1", snapshotId: "snapshot-1", revision: "a".repeat(40) },
        artifacts: { approval: {
          path: "C:\\data\\warden-evidence\\tenant-a\\approvals\\seal-2.json",
          sha256: `sha256:${"d".repeat(64)}`,
        } },
        review: {
          decision: "approve",
          reviewerPrincipalId: "human:reviewer@example.com",
          rationale: "The target and regression checks pass.",
        },
      }),
      createdAt: NOW,
      finishedAt: NOW,
    });
    const first = enqueueWardenCandidateDelivery(db, deliveryInput);
    const second = enqueueWardenCandidateDelivery(db, {
      ...deliveryInput,
      runId: "warden-run-2",
      sealedPath: "C:\\data\\warden-evidence\\tenant-a\\approvals\\seal-2.json",
      sealedSha256: `sha256:${"d".repeat(64)}`,
    });
    const sealedProviderChange = {
      schemaVersion: 5,
      tenantId: "tenant-a",
      repositoryId: "repo-1",
      snapshotId: "snapshot-1",
      baseBranch: "main",
      expectedBaseRevision: "a".repeat(40),
      fettlerProviderChange: {
        schemaVersion: 1,
        providerSlug: "stripe",
        changeId: "change-stripe-2026-08-31",
        pipelineJobId: "pipeline-job-1",
        contentHash: "0123456789abcdef",
        fromVersionId: "version-stripe-2026-07-29",
        fromVersionLabel: "2026-07-29.dahlia",
        toVersionId: "version-stripe-2026-08-31",
        toVersionLabel: "2026-08-31.acacia",
        repositoryId: "repo-1",
        snapshotId: "snapshot-1",
        revision: "a".repeat(40),
      },
    } as const;

    expect(bindWardenCandidateDeliveryScope(db, {
      tenantId: "tenant-a",
      deliveryId: first.id,
      sealedArtifact: sealedProviderChange,
    })).toMatchObject({ status: "bound", providerSlug: "stripe", changeId: "change-stripe-2026-08-31" });
    expect(getWardenCandidateDelivery(db, "tenant-a", first.id)?.precursorMigrationPrId).toBeNull();
    expect(() => bindWardenCandidateDeliveryScope(db, {
      tenantId: "tenant-a",
      deliveryId: second.id,
      sealedArtifact: sealedProviderChange,
    })).toThrow("warden_candidate_delivery_scope_conflict");
  });

  it("atomically stores one exact notification-only precursor and replays idempotently", () => {
    const db = fixture();
    seedPrecursorInputs(db);
    seedRepositoryConsumer(db, { consumerId: "consumer-1", repoRowId: "consumer-repo-1", repositoryId: "repo-1" });
    seedNotificationOnlyMigrationPr(db, { id: "migration-pr-1", consumerId: "consumer-1" });
    const delivery = enqueueWardenCandidateDelivery(db, deliveryInput);

    const first = bindWardenCandidateDeliveryScope(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      sealedArtifact: sealedProviderChange(),
    });
    const replay = bindWardenCandidateDeliveryScope(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      sealedArtifact: sealedProviderChange(),
    });

    expect(replay).toEqual(first);
    expect(getWardenCandidateDelivery(db, "tenant-a", delivery.id)?.precursorMigrationPrId)
      .toBe("migration-pr-1");
  });

  it("does not reinterpret a bound null precursor when feed history changes", () => {
    const db = fixture();
    seedPrecursorInputs(db);
    seedRepositoryConsumer(db, { consumerId: "consumer-1", repoRowId: "consumer-repo-1", repositoryId: "repo-1" });
    const delivery = enqueueWardenCandidateDelivery(db, deliveryInput);
    const first = bindWardenCandidateDeliveryScope(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      sealedArtifact: sealedProviderChange(),
    });
    seedNotificationOnlyMigrationPr(db, { id: "migration-pr-later", consumerId: "consumer-1" });

    const replay = bindWardenCandidateDeliveryScope(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      sealedArtifact: sealedProviderChange(),
    });

    expect(replay).toEqual(first);
    expect(getWardenCandidateDelivery(db, "tenant-a", delivery.id)?.precursorMigrationPrId).toBeNull();
  });

  it("fails closed and rolls back scope binding when multiple exact precursors exist", () => {
    const db = fixture();
    seedPrecursorInputs(db);
    seedRepositoryConsumer(db, { consumerId: "consumer-1", repoRowId: "consumer-repo-1", repositoryId: "repo-1" });
    seedNotificationOnlyMigrationPr(db, { id: "migration-pr-1", consumerId: "consumer-1" });
    seedNotificationOnlyMigrationPr(db, { id: "migration-pr-2", consumerId: "consumer-1" });
    const delivery = enqueueWardenCandidateDelivery(db, deliveryInput);

    expect(() => bindWardenCandidateDeliveryScope(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      sealedArtifact: sealedProviderChange(),
    })).toThrow("warden_candidate_delivery_precursor_ambiguous");
    expect(getWardenCandidateDelivery(db, "tenant-a", delivery.id)?.precursorMigrationPrId).toBeNull();
    expect(getJob(db, delivery.jobId, "tenant-a")?.payload_json).not.toContain("fettlerProviderChangeScope");
  });

  it("fails closed when a connected repository is linked to multiple tenant consumers", () => {
    const db = fixture();
    seedPrecursorInputs(db);
    seedRepositoryConsumer(db, { consumerId: "consumer-1", repoRowId: "consumer-repo-1", repositoryId: "repo-1" });
    seedRepositoryConsumer(db, { consumerId: "consumer-2", repoRowId: "consumer-repo-2", repositoryId: "repo-1" });
    seedNotificationOnlyMigrationPr(db, { id: "migration-pr-1", consumerId: "consumer-1" });
    const delivery = enqueueWardenCandidateDelivery(db, deliveryInput);

    expect(() => bindWardenCandidateDeliveryScope(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      sealedArtifact: sealedProviderChange(),
    })).toThrow("warden_candidate_delivery_precursor_repository_ambiguous");
    expect(getWardenCandidateDelivery(db, "tenant-a", delivery.id)?.precursorMigrationPrId).toBeNull();
  });

  it("fails closed when the matching consumer is linked to another connected repository", () => {
    const db = fixture();
    seedPrecursorInputs(db);
    seedRepositoryConsumer(db, { consumerId: "consumer-1", repoRowId: "consumer-repo-1", repositoryId: "repo-1" });
    db.raw.prepare(
      `INSERT INTO consumer_repos (id, consumer_id, local_path, connected_repository_id, created_at)
       VALUES ('consumer-repo-2', 'consumer-1', 'C:\\repos\\consumer-1-other', 'repo-2', ?)`,
    ).run(NOW);
    seedNotificationOnlyMigrationPr(db, { id: "migration-pr-1", consumerId: "consumer-1" });
    const delivery = enqueueWardenCandidateDelivery(db, deliveryInput);

    expect(() => bindWardenCandidateDeliveryScope(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      sealedArtifact: sealedProviderChange(),
    })).toThrow("warden_candidate_delivery_precursor_repository_ambiguous");
    expect(getWardenCandidateDelivery(db, "tenant-a", delivery.id)?.precursorMigrationPrId).toBeNull();
    expect(getJob(db, delivery.jobId, "tenant-a")?.payload_json).not.toContain("fettlerProviderChangeScope");
  });

  it("leaves legacy approval schemas unscoped and rejects mutated sealed bindings", () => {
    const db = fixture();
    seedPrecursorInputs(db);
    seedRepositoryConsumer(db, { consumerId: "consumer-1", repoRowId: "consumer-repo-1", repositoryId: "repo-1" });
    seedNotificationOnlyMigrationPr(db, { id: "migration-pr-1", consumerId: "consumer-1" });
    const delivery = enqueueWardenCandidateDelivery(db, deliveryInput);
    expect(bindWardenCandidateDeliveryScope(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      sealedArtifact: {
        schemaVersion: 4,
        fettlerProviderChange: {
          schemaVersion: 1,
          providerSlug: "stripe",
          changeId: "unsealed-prose-must-not-authorize",
        },
      },
    })).toEqual({ status: "legacy_unscoped" });
    expect(getWardenCandidateDelivery(db, "tenant-a", delivery.id)?.precursorMigrationPrId).toBeNull();
    expect(() => bindWardenCandidateDeliveryScope(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      sealedArtifact: {
        schemaVersion: 5,
        tenantId: "tenant-a",
        repositoryId: "repo-mutated",
        snapshotId: "snapshot-1",
        baseBranch: "main",
        expectedBaseRevision: "a".repeat(40),
        fettlerProviderChange: {
          schemaVersion: 1,
          providerSlug: "stripe",
          changeId: "change-stripe-2026-08-31",
          pipelineJobId: "pipeline-job-1",
          contentHash: "0123456789abcdef",
          fromVersionId: "version-stripe-2026-07-29",
          fromVersionLabel: "2026-07-29.dahlia",
          toVersionId: "version-stripe-2026-08-31",
          toVersionLabel: "2026-08-31.acacia",
          repositoryId: "repo-mutated",
          snapshotId: "snapshot-1",
          revision: "a".repeat(40),
        },
      },
    })).toThrow("warden_candidate_delivery_scope_binding_mismatch");
  });

  it("adds the nullable precursor column when an existing database is reopened", () => {
    const directory = mkdtempSync(join(tmpdir(), "mendpoint-warden-delivery-upgrade-"));
    const path = join(directory, "upgrade.sqlite");
    const seed = createDb(path);
    seed.raw.prepare(
      `INSERT INTO fettler_candidate_deliveries
       (id, tenant_id, run_id, job_id, status, repository_id, snapshot_id, base_branch,
        expected_base_revision, sealed_path, sealed_sha256, requester_principal_id, rationale,
        requested_at, updated_at)
       VALUES ('delivery-legacy', 'tenant-a', 'run-legacy', 'job-legacy', 'delivery_pending',
        'repo-1', 'snapshot-1', 'main', ?, 'C:\\seal.json', ?, 'human:reviewer@example.com',
        'Approved', ?, ?)`,
    ).run("a".repeat(40), `sha256:${"b".repeat(64)}`, NOW, NOW);
    seed.raw.close();
    const legacy = new DatabaseSync(path);
    const before = (legacy.prepare("PRAGMA table_info(fettler_candidate_deliveries)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    if (before.includes("precursor_migration_pr_id")) {
      legacy.exec(`
        DROP INDEX IF EXISTS fettler_candidate_deliveries_precursor_idx;
        ALTER TABLE fettler_candidate_deliveries DROP COLUMN precursor_migration_pr_id;
      `);
    }
    legacy.close();

    const upgraded = createDb(path);
    opened.push({ db: upgraded, directory });
    const after = (upgraded.raw.prepare("PRAGMA table_info(fettler_candidate_deliveries)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    expect(after).toContain("precursor_migration_pr_id");
    expect((upgraded.raw.prepare("PRAGMA index_list(fettler_candidate_deliveries)").all() as Array<{ name: string }>)
      .map((index) => index.name)).toContain("fettler_candidate_deliveries_precursor_idx");
    expect(getWardenCandidateDelivery(upgraded, "tenant-a", "delivery-legacy")?.precursorMigrationPrId)
      .toBeNull();
  });

  it("fails closed when an existing delivery scope is malformed", () => {
    const db = fixture();
    const delivery = enqueueWardenCandidateDelivery(db, deliveryInput);
    const job = getJob(db, delivery.jobId, "tenant-a")!;
    const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
    db.raw.prepare("UPDATE jobs SET payload_json = ? WHERE id = ? AND tenant_id = ?").run(
      JSON.stringify({ ...payload, fettlerProviderChangeScope: { schemaVersion: 1 } }),
      delivery.jobId,
      "tenant-a",
    );

    expect(() => bindWardenCandidateDeliveryScope(db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      sealedArtifact: {
        schemaVersion: 5,
        tenantId: "tenant-a",
        repositoryId: "repo-1",
        snapshotId: "snapshot-1",
        baseBranch: "main",
        expectedBaseRevision: "a".repeat(40),
        fettlerProviderChange: {
          schemaVersion: 1,
          providerSlug: "stripe",
          changeId: "change-stripe-2026-08-31",
          pipelineJobId: "pipeline-job-1",
          contentHash: "0123456789abcdef",
          fromVersionId: "version-stripe-2026-07-29",
          fromVersionLabel: "2026-07-29.dahlia",
          toVersionId: "version-stripe-2026-08-31",
          toVersionLabel: "2026-08-31.acacia",
          repositoryId: "repo-1",
          snapshotId: "snapshot-1",
          revision: "a".repeat(40),
        },
      },
    })).toThrow("warden_candidate_delivery_scope_corrupt");
  });

  const deliveryInput = {
    tenantId: "tenant-a",
    runId: "warden-run-1",
    repositoryId: "repo-1",
    snapshotId: "snapshot-1",
    baseBranch: "main",
    expectedBaseRevision: "a".repeat(40),
    sealedPath: "C:\\data\\warden-evidence\\tenant-a\\approvals\\seal.json",
    sealedSha256: `sha256:${"b".repeat(64)}`,
    requesterPrincipalId: "human:reviewer@example.com",
    rationale: "The target and regression checks pass.",
    now: NOW,
  } as const;

  it("binds intent and records one draft delivery, idempotently", () => {
    const db = fixture();
    const delivery = enqueueWardenCandidateDelivery(db, deliveryInput);

    const bound = bindWardenCandidateDeliveryIntent(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, intentDigest: `sha256:${"c".repeat(64)}`,
      branchName: "mendpoint/warden-run-1", observedAt: NOW,
    });
    expect(bound.intentDigest).toBe(`sha256:${"c".repeat(64)}`);
    expect(bindWardenCandidateDeliveryIntent(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, intentDigest: `sha256:${"c".repeat(64)}`,
      branchName: "mendpoint/warden-run-1", observedAt: NOW,
    })).toEqual(bound);

    const delivered = recordWardenCandidateDeliverySuccess(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, branchName: "mendpoint/warden-run-1",
      baseRevision: "a".repeat(40), commitSha: "d".repeat(40), draftPrNumber: 42,
      draftPrUrl: "https://github.com/acme/service/pull/42", observedAt: NOW,
    });
    expect(delivered.status).toBe("delivered");
    expect(delivered.draftPrNumber).toBe(42);
    // Replaying the identical PR is idempotent.
    expect(recordWardenCandidateDeliverySuccess(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, branchName: "mendpoint/warden-run-1",
      baseRevision: "a".repeat(40), commitSha: "d".repeat(40), draftPrNumber: 42,
      draftPrUrl: "https://github.com/acme/service/pull/42", observedAt: NOW,
    })).toEqual(delivered);
    // A different PR against an already-delivered row must fail closed, not overwrite silently.
    expect(() => recordWardenCandidateDeliverySuccess(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, branchName: "mendpoint/warden-run-1",
      baseRevision: "a".repeat(40), commitSha: "e".repeat(40), draftPrNumber: 99,
      draftPrUrl: "https://github.com/acme/service/pull/99", observedAt: NOW,
    })).toThrow("warden_candidate_delivery_not_pending");
  });

  it("fails closed when a retried job succeeds against a terminal delivery_failed row", () => {
    const db = fixture();
    const delivery = enqueueWardenCandidateDelivery(db, deliveryInput);
    // Attempt 1 exhausts its retries and dead-letters: the delivery goes terminal.
    const failed = recordWardenCandidateDeliveryFailure(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, errorCode: "github_pr_failed",
      errorMessage: "draft PR creation failed", terminal: true, observedAt: NOW,
    });
    expect(failed.status).toBe("delivery_failed");

    // An operator retries the dead-lettered job; attempt 2 creates a REAL draft PR and reports back.
    // Both the intent bind and the success write must refuse the terminal row loudly rather than
    // silently discard the write and return a fake success.
    expect(() => bindWardenCandidateDeliveryIntent(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, intentDigest: `sha256:${"c".repeat(64)}`,
      branchName: "mendpoint/warden-run-1", observedAt: NOW,
    })).toThrow("warden_candidate_delivery_not_pending");
    expect(() => recordWardenCandidateDeliverySuccess(db, {
      tenantId: "tenant-a", deliveryId: delivery.id, branchName: "mendpoint/warden-run-1",
      baseRevision: "a".repeat(40), commitSha: "d".repeat(40), draftPrNumber: 42,
      draftPrUrl: "https://github.com/acme/service/pull/42", observedAt: NOW,
    })).toThrow("warden_candidate_delivery_not_pending");

    // The terminal row is untouched: it never claims a delivery it did not persist, and the intent
    // fence never bound.
    const after = getWardenCandidateDelivery(db, "tenant-a", delivery.id)!;
    expect(after.status).toBe("delivery_failed");
    expect(after.intentDigest).toBeNull();
    expect(after.draftPrNumber).toBeNull();
  });
});
