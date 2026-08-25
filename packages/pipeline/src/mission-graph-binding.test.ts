import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWardenCampaignTarget,
  bindMissionGraphVersion,
  createDb,
  createMission,
  createWardenCampaign,
  getMission,
  insertPrincipal,
  linkFettlerCampaignToMission,
  type AppDb,
} from "@mendpoint/db";
import {
  openGraphLearnDb,
  openGraphLearnMemory,
  publishSoftwareGraphVersion,
  type GraphLearnDb,
  type SoftwareGraphPublicationV1,
} from "@mendpoint/graph-learn";
import {
  openExistingGraphFile,
  pinKnownGraphVersionToMission,
  pinPublishedGraphVersionForSingleRepository,
  pinPublishedGraphVersionOnSingleRepoFettlerMissions,
  pinPublishedGraphVersionToMission,
} from "./mission-graph-binding.js";

const opened: Array<{ db: AppDb; dir: string }> = [];
const graphOpened: GraphLearnDb[] = [];
const at = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
  while (graphOpened.length) {
    try { graphOpened.pop()?.raw.close(); } catch { /* ignore */ }
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-mission-graph-"));
  const db = createDb(join(dir, "app.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1', 'one', 'One', 'team', 'active', 10, ?)`).run(at);
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com",
    displayName: "One", createdAt: at });
  createMission(db, { id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
    objective: "Migrate consumers off v1", ownerPrincipalId: "p1", eventId: "e-m1",
    idempotencyKey: "create-m1", correlationId: "corr", createdAt: at });
  return { db, dir };
}

function coverage(extractor: { id: string; version: string; digest: string }) {
  return ([
    "repository_discovery",
    "language_parsing",
    "provider_specification",
    "sdk_resolution",
    "call_resolution",
    "test_resolution",
  ] as const).map((stage) => ({
    extractor,
    stage,
    basis: "complete" as const,
    analyzed: 1,
    omitted: 0,
    evidenceRefs: [`evidence:${stage}`],
  }));
}

function publication(overrides: Partial<SoftwareGraphPublicationV1> = {}): SoftwareGraphPublicationV1 {
  const extractor = Object.freeze({
    id: "mendpoint.code-index",
    version: "1.0.0",
    digest: `sha256:${"1".repeat(64)}`,
  });
  return {
    schemaVersion: "mendpoint.software-graph.v1",
    tenantId: "t1",
    repositoryId: "repo-a",
    repositorySnapshotId: "snapshot-1",
    repositoryRevision: "a".repeat(40),
    providerId: "provider-a",
    providerSnapshotId: "provider-snapshot-1",
    providerRevision: "2026-08-17",
    observedAt: "2026-08-17T12:00:00.000Z",
    entities: [{
      id: "endpoint:charges-create",
      kind: "endpoint",
      canonicalKey: "POST /v1/charges",
      aliases: ["charges.create"],
      label: "POST /v1/charges",
      scope: "provider",
      evidenceRefs: ["artifact:openapi:v1"],
      extractor,
      derivation: "provider_spec",
      confidenceBasis: "deterministic_exact",
      status: "active",
      validFrom: "2026-08-17T12:00:00.000Z",
    }],
    relationships: [],
    coverage: coverage(extractor),
    ...overrides,
  };
}

function seedConnectedRepo(db: AppDb, repositoryId: string, snapshotId: string) {
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES ('connection-a', 't1', 'github', 'secret://github/app', 'account-a', 'GitHub', ?, ?)`)
    .run(at, at);
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
     environment, retention_days, status, created_at, updated_at)
    VALUES (?, 't1', 'connection-a', '99', 'acme', 'repo', 'main', 'main',
      'production', 30, 'ready', ?, ?)`)
    .run(repositoryId, at, at);
  db.raw.prepare(`INSERT INTO repository_snapshots
    (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
     submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
    VALUES (?, 't1', ?, 'main', ?, ?, '/snapshots/exact', 'reject',
      'pointer_only', '[]', 1, ?, '2026-08-15T17:00:00.000Z')`)
    .run(snapshotId, repositoryId, "a".repeat(40), "b".repeat(64), at);
}

describe("pinKnownGraphVersionToMission", () => {
  it("pins a published version set-once and is idempotent for the same version", () => {
    const { db } = fixture();
    const first = pinKnownGraphVersionToMission(db, {
      tenantId: "t1", missionId: "m1", graphVersionId: "sgv1:abc",
      actorPrincipalId: "p1", correlationId: "c", createdAt: at,
    });
    expect(first.status).toBe("bound");
    expect(first.mission?.graphVersionId).toBe("sgv1:abc");
    const again = pinKnownGraphVersionToMission(db, {
      tenantId: "t1", missionId: "m1", graphVersionId: "sgv1:abc",
      actorPrincipalId: "p1", correlationId: "c", createdAt: at,
    });
    expect(again.status).toBe("already_bound");
    expect(again.mission?.revision).toBe(first.mission?.revision);
  });

  it("does not overwrite a different pinned version", () => {
    const { db } = fixture();
    bindMissionGraphVersion(db, {
      tenantId: "t1", missionId: "m1", graphVersionId: "sgv1:abc",
      actorPrincipalId: "p1", eventId: "e-bind", idempotencyKey: "k-bind",
      correlationId: "c", createdAt: at,
    });
    const result = pinKnownGraphVersionToMission(db, {
      tenantId: "t1", missionId: "m1", graphVersionId: "sgv1:def",
      actorPrincipalId: "p1", correlationId: "c", createdAt: at,
    });
    expect(result).toMatchObject({ status: "already_bound", reason: "conflict" });
    expect(getMission(db, "t1", "m1")?.graphVersionId).toBe("sgv1:abc");
  });

  it("leaves a missing mission unbound", () => {
    const { db } = fixture();
    expect(pinKnownGraphVersionToMission(db, {
      tenantId: "t1", missionId: "missing", graphVersionId: "sgv1:abc",
      actorPrincipalId: "p1", correlationId: "c", createdAt: at,
    })).toEqual({ status: "unchanged", reason: "mission_not_found" });
  });
});

describe("pinPublishedGraphVersionToMission", () => {
  it("pins the unique published head for a tenant repository", () => {
    const { db } = fixture();
    const graphDb = openGraphLearnMemory();
    graphOpened.push(graphDb);
    const published = publishSoftwareGraphVersion(graphDb, publication());
    const result = pinPublishedGraphVersionToMission(db, {
      tenantId: "t1", missionId: "m1", repositoryId: "repo-a",
      actorPrincipalId: "p1", correlationId: "c", createdAt: at, graphDb,
    });
    expect(result.status).toBe("bound");
    expect(result.mission?.graphVersionId).toBe(published.versionId);
  });

  it("stays unbound when no graph file exists and does not create one", () => {
    const { db, dir } = fixture();
    const missing = join(dir, "no-such-graph.sqlite");
    const previous = process.env.GRAPH_LEARN_DB;
    delete process.env.GRAPH_LEARN_DB;
    try {
      const result = pinPublishedGraphVersionToMission(db, {
        tenantId: "t1", missionId: "m1", repositoryId: "repo-a",
        actorPrincipalId: "p1", correlationId: "c", createdAt: at,
        graphPath: missing,
      });
      expect(result).toEqual({ status: "unchanged", reason: "graph_file_missing" });
      expect(existsSync(missing)).toBe(false);
      expect(getMission(db, "t1", "m1")?.graphVersionId).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.GRAPH_LEARN_DB;
      else process.env.GRAPH_LEARN_DB = previous;
    }
  });

  it("refuses an in-memory GRAPH_LEARN_DB path", () => {
    const { db } = fixture();
    expect(openExistingGraphFile(":memory:")).toBeUndefined();
    expect(pinPublishedGraphVersionToMission(db, {
      tenantId: "t1", missionId: "m1", repositoryId: "repo-a",
      actorPrincipalId: "p1", correlationId: "c", createdAt: at,
      graphPath: ":memory:",
    })).toEqual({ status: "unchanged", reason: "graph_file_missing" });
  });

  it("stays unbound when two providers publish different heads for the same repository", () => {
    const { db } = fixture();
    const graphDb = openGraphLearnMemory();
    graphOpened.push(graphDb);
    publishSoftwareGraphVersion(graphDb, publication());
    publishSoftwareGraphVersion(graphDb, publication({
      providerId: "provider-b",
      entities: [{
        ...publication().entities[0]!,
        id: "endpoint:messages-create",
        canonicalKey: "POST /v1/messages",
        aliases: ["messages.create"],
        label: "POST /v1/messages",
      }],
    }));
    const result = pinPublishedGraphVersionToMission(db, {
      tenantId: "t1", missionId: "m1", repositoryId: "repo-a",
      actorPrincipalId: "p1", correlationId: "c", createdAt: at, graphDb,
    });
    expect(result).toMatchObject({ status: "unchanged", reason: "ambiguous_graph_version" });
    expect(getMission(db, "t1", "m1")?.graphVersionId).toBeNull();
  });
});

describe("pinPublishedGraphVersionForSingleRepository", () => {
  it("does not pin when more than one repository is in scope", () => {
    const { db } = fixture();
    const graphDb = openGraphLearnMemory();
    graphOpened.push(graphDb);
    publishSoftwareGraphVersion(graphDb, publication());
    const result = pinPublishedGraphVersionForSingleRepository(db, {
      tenantId: "t1", missionId: "m1", repositoryIds: ["repo-a", "repo-b"],
      actorPrincipalId: "p1", correlationId: "c", createdAt: at, graphDb,
    });
    expect(result.reason).toBe("multi_repository_scope");
    expect(getMission(db, "t1", "m1")?.graphVersionId).toBeNull();
  });
});

describe("pinPublishedGraphVersionOnSingleRepoFettlerMissions", () => {
  it("pins the published version on the campaign Mission for a single-repo campaign", () => {
    const { db } = fixture();
    seedConnectedRepo(db, "repo-a", "snapshot-a");
    createWardenCampaign(db, {
      id: "campaign-a", tenantId: "t1", name: "Stripe upgrade", ownerPrincipalId: "p1",
      concurrencyLimit: 1, completionPolicy: "all", eventId: "e-camp",
      idempotencyKey: "k-camp", correlationId: "c", createdAt: at,
    });
    addWardenCampaignTarget(db, {
      id: "target-a", tenantId: "t1", campaignId: "campaign-a", repositoryId: "repo-a",
      snapshotId: "snapshot-a", ownerPrincipalId: "p1", eventId: "e-target",
      idempotencyKey: "k-target", correlationId: "c", createdAt: at,
    });
    linkFettlerCampaignToMission(db, {
      tenantId: "t1", campaignId: "campaign-a", missionId: "m1", actorPrincipalId: "p1",
      eventId: "e-link", idempotencyKey: "k-link", correlationId: "c", createdAt: at,
    });
    const results = pinPublishedGraphVersionOnSingleRepoFettlerMissions(db, {
      tenantId: "t1", repositoryId: "repo-a", graphVersionId: "sgv1:published",
      actorPrincipalId: "p1", correlationId: "change-1", createdAt: at,
    });
    expect(results).toEqual([
      expect.objectContaining({ status: "bound" }),
    ]);
    expect(getMission(db, "t1", "m1")?.graphVersionId).toBe("sgv1:published");
  });

  it("does not pin a multi-repo campaign from one repository's published version", () => {
    const { db } = fixture();
    seedConnectedRepo(db, "repo-a", "snapshot-a");
    db.raw.prepare(`INSERT INTO connected_repositories
      (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
       environment, retention_days, status, created_at, updated_at)
      VALUES ('repo-b', 't1', 'connection-a', '100', 'acme', 'other', 'main', 'main',
        'production', 30, 'ready', ?, ?)`).run(at, at);
    db.raw.prepare(`INSERT INTO repository_snapshots
      (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
       submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
      VALUES ('snapshot-b', 't1', 'repo-b', 'main', ?, ?, '/snapshots/b', 'reject',
        'pointer_only', '[]', 1, ?, '2026-08-15T17:00:00.000Z')`)
      .run("c".repeat(40), "d".repeat(64), at);
    createWardenCampaign(db, {
      id: "campaign-multi", tenantId: "t1", name: "Multi", ownerPrincipalId: "p1",
      concurrencyLimit: 1, completionPolicy: "all", eventId: "e-camp",
      idempotencyKey: "k-camp", correlationId: "c", createdAt: at,
    });
    addWardenCampaignTarget(db, {
      id: "target-a", tenantId: "t1", campaignId: "campaign-multi", repositoryId: "repo-a",
      snapshotId: "snapshot-a", ownerPrincipalId: "p1", eventId: "e-ta",
      idempotencyKey: "k-ta", correlationId: "c", createdAt: at,
    });
    addWardenCampaignTarget(db, {
      id: "target-b", tenantId: "t1", campaignId: "campaign-multi", repositoryId: "repo-b",
      snapshotId: "snapshot-b", ownerPrincipalId: "p1", eventId: "e-tb",
      idempotencyKey: "k-tb", correlationId: "c", createdAt: at,
    });
    linkFettlerCampaignToMission(db, {
      tenantId: "t1", campaignId: "campaign-multi", missionId: "m1", actorPrincipalId: "p1",
      eventId: "e-link", idempotencyKey: "k-link", correlationId: "c", createdAt: at,
    });
    const results = pinPublishedGraphVersionOnSingleRepoFettlerMissions(db, {
      tenantId: "t1", repositoryId: "repo-a", graphVersionId: "sgv1:published",
      actorPrincipalId: "p1", correlationId: "change-1", createdAt: at,
    });
    expect(results).toEqual([]);
    expect(getMission(db, "t1", "m1")?.graphVersionId).toBeNull();
  });
});

describe("openExistingGraphFile", () => {
  it("opens a real file that already exists and does not invent a missing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "mendpoint-graph-file-"));
    opened.push({ db: createDb(join(dir, "unused.sqlite")), dir });
    const path = join(dir, "graph.sqlite");
    const created = openGraphLearnDb(path);
    created.raw.close();
    const openedExisting = openExistingGraphFile(path);
    expect(openedExisting?.path).toBe(path);
    openedExisting?.raw.close();
    expect(openExistingGraphFile(join(dir, "missing.sqlite"))).toBeUndefined();
  });
});
