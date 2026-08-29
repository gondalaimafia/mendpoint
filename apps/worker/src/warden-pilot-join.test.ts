import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWardenCampaignTarget,
  bindConsumerRepoSnapshot,
  createDb,
  createMission,
  createWardenCampaign,
  getAgentRun,
  getJob,
  insertConnectedRepository,
  insertConsumer,
  insertConsumerRepo,
  insertPrincipal,
  insertRepositorySnapshot,
  insertRepositorySnapshotPolicy,
  linkFettlerCampaignToMission,
  listAgentRuns,
  listJobs,
  upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import type { PipelineReport } from "@mendpoint/pipeline";
import { enqueuePipelineWardenRuns } from "./warden-pilot-join.js";

const opened: Array<{ db: AppDb; root: string }> = [];
const observedAt = "2026-08-10T18:00:00.000Z";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-pilot-join-"));
  const snapshotRoot = join(root, "snapshot");
  mkdirSync(snapshotRoot);
  writeFileSync(join(snapshotRoot, "check.mjs"), "process.exit(0);\n", "utf8");
  const db = createDb(join(root, "app.sqlite"));
  opened.push({ db, root });
  insertConsumer(db, {
    id: "consumer-a",
    name: "Customer API",
    githubOwner: "acme",
    githubRepo: "customer-api",
    tenantId: "tenant-a",
    createdAt: observedAt,
  });
  const connection = upsertScmConnection(db, {
    id: "connection-a",
    tenantId: "tenant-a",
    provider: "github",
    credentialRef: "github-app://installation/100",
    externalAccountId: "100",
    displayName: "Acme",
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const repository = insertConnectedRepository(db, {
    id: "repository-a",
    tenantId: "tenant-a",
    connectionId: connection.id,
    remoteId: "200",
    owner: "acme",
    name: "customer-api",
    defaultBranch: "main",
    status: "ready",
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  insertRepositorySnapshot(db, {
    id: "snapshot-a",
    tenantId: "tenant-a",
    repositoryId: repository.id,
    requestedRef: "main",
    resolvedSha: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    storagePath: snapshotRoot,
    createdAt: observedAt,
    expiresAt: "2026-08-11T18:00:00.000Z",
  });
  insertRepositorySnapshotPolicy(db, {
    id: "snapshot-policy-a",
    tenantId: "tenant-a",
    snapshotId: "snapshot-a",
    codeowners: [],
    ciFiles: ["check.mjs"],
    verificationCommands: ["node check.mjs"],
    protectedBranch: { name: "main", exactCommit: "a".repeat(40) },
    createdAt: observedAt,
  });
  insertConsumerRepo(db, {
    id: "consumer-repo-a",
    consumerId: "consumer-a",
    localPath: snapshotRoot,
    createdAt: observedAt,
  });
  bindConsumerRepoSnapshot(db, {
    tenantId: "tenant-a",
    consumerRepoId: "consumer-repo-a",
    connectionId: connection.id,
    connectedRepositoryId: repository.id,
    snapshotId: "snapshot-a",
  });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('tenant-a','one','One','team','active',10,?)`).run(observedAt);
  insertPrincipal(db, {
    id: "p1",
    tenantId: "tenant-a",
    kind: "human",
    subject: "owner@example.com",
    displayName: "Owner",
    createdAt: observedAt,
  });
  return { db };
}

function enrollSingleRepoCampaign(db: AppDb, input: {
  campaignId?: string;
  missionId?: string;
} = {}) {
  const campaignId = input.campaignId ?? "campaign-a";
  const missionId = input.missionId ?? "mission-a";
  createMission(db, {
    id: missionId,
    tenantId: "tenant-a",
    product: "fettler",
    triggerKind: "provider_change",
    objective: "Migrate consumers off the recorded change",
    ownerPrincipalId: "p1",
    eventId: `e-${missionId}`,
    idempotencyKey: `c-${missionId}`,
    correlationId: "corr",
    createdAt: observedAt,
  });
  createWardenCampaign(db, {
    id: campaignId,
    tenantId: "tenant-a",
    name: "Stripe upgrade",
    ownerPrincipalId: "p1",
    concurrencyLimit: 1,
    completionPolicy: "all",
    eventId: `e-${campaignId}`,
    idempotencyKey: `k-${campaignId}`,
    correlationId: "corr",
    createdAt: observedAt,
  });
  addWardenCampaignTarget(db, {
    id: `target-${campaignId}`,
    tenantId: "tenant-a",
    campaignId,
    repositoryId: "repository-a",
    snapshotId: "snapshot-a",
    ownerPrincipalId: "p1",
    eventId: `e-target-${campaignId}`,
    idempotencyKey: `k-target-${campaignId}`,
    correlationId: "corr",
    createdAt: observedAt,
  });
  linkFettlerCampaignToMission(db, {
    tenantId: "tenant-a",
    campaignId,
    missionId,
    actorPrincipalId: "p1",
    eventId: `e-link-${campaignId}`,
    idempotencyKey: `k-link-${campaignId}`,
    correlationId: "corr",
    createdAt: observedAt,
  });
}

function report(paths: readonly string[], confidence: "high" | "medium" | "low" = "high"): PipelineReport {
  return {
    changeId: "change-a",
    risk: "breaking",
    summary: "The charges endpoint changed",
    diff: {
      risk: "breaking",
      summary: "The charges endpoint changed",
      entries: [],
    },
    surfaces: 1,
    consumers: [{
      consumerId: "consumer-a",
      name: "Customer API",
      findings: paths.length,
      candidates: paths.length,
      confirmed: paths.length,
      overallConfidence: confidence,
      prStatus: "notification_only",
      impactReport: {
        surfaces: [],
        sites: paths.map((filePath, index) => ({
          filePath,
          lineStart: index + 1,
          lineEnd: index + 1,
          symbol: `symbol${index}`,
          confidence,
          evidence: `evidence ${index}`,
          impactType: "direct_call",
          surfaceIds: ["surface-a"],
          relatedOps: [],
          confirmationPath: "static",
        })),
        overallRisk: "breaking",
        overallConfidence: confidence,
        strategySummary: "Static evidence",
        candidateCount: paths.length,
        confirmedCount: paths.length,
        lowConfidenceNotifications: [],
      },
    }],
  };
}

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.raw.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

describe("joined Warden pilot intake", () => {
  it("queues one snapshot-bound Warden run and replays equivalent parent requests exactly once", () => {
    const { db } = fixture();
    const first = enqueuePipelineWardenRuns(db, {
      tenantId: "tenant-a",
      pipelineJobId: "pipeline-job-a",
      providerSlug: "stripe",
      report: report(["src/client.ts", "src/charges.ts"]),
      observedAt,
      useLlm: true,
    });
    const second = enqueuePipelineWardenRuns(db, {
      tenantId: "tenant-a",
      pipelineJobId: "pipeline-job-b",
      providerSlug: "stripe",
      report: report(["src/client.ts", "src/charges.ts"]),
      observedAt,
      useLlm: true,
    });

    expect(first).toEqual([expect.objectContaining({ status: "queued", consumerId: "consumer-a" })]);
    expect(second).toEqual([expect.objectContaining({
      status: "replayed",
      consumerId: "consumer-a",
      jobId: first[0]!.jobId,
      runId: first[0]!.runId,
    })]);
    expect(listJobs(db, 20, "tenant-a").filter((job) => job.type === "agent.run")).toHaveLength(1);
    expect(listAgentRuns(db, 20, "tenant-a")).toHaveLength(1);

    const job = getJob(db, first[0]!.jobId!, "tenant-a");
    const payload = JSON.parse(job!.payload_json) as Record<string, unknown>;
    expect(payload).toEqual(expect.objectContaining({
      consumerId: "consumer-a",
      allowedChangedPaths: ["src/charges.ts", "src/client.ts"],
      allowNetwork: false,
      useLlm: true,
      source: {
        pipelineJobId: "pipeline-job-a",
        changeId: "change-a",
        providerSlug: "stripe",
        snapshotId: "snapshot-a",
        repositoryId: "repository-a",
        revision: "a".repeat(40),
      },
    }));
    expect(payload).not.toHaveProperty("verifyCommand");
    expect(payload).not.toHaveProperty("fettlerCampaignId");
    expect(payload).not.toHaveProperty("missionId");
    expect(getAgentRun(db, first[0]!.runId!, "tenant-a")).toMatchObject({
      status: "queued",
      repo_path: expect.stringContaining("snapshot"),
    });
  });

  it("abstains when impact evidence is low confidence, exceeds the bounded path limit, or is protected", () => {
    const { db } = fixture();
    const low = enqueuePipelineWardenRuns(db, {
      tenantId: "tenant-a",
      pipelineJobId: "pipeline-low",
      providerSlug: "stripe",
      report: report(["src/client.ts"], "low"),
      observedAt,
      useLlm: true,
    });
    const oversized = enqueuePipelineWardenRuns(db, {
      tenantId: "tenant-a",
      pipelineJobId: "pipeline-large",
      providerSlug: "stripe",
      report: report(Array.from({ length: 41 }, (_, index) => `src/file-${index}.ts`)),
      observedAt,
      useLlm: true,
    });
    const protectedPath = enqueuePipelineWardenRuns(db, {
      tenantId: "tenant-a",
      pipelineJobId: "pipeline-protected",
      providerSlug: "stripe",
      report: report([".github/workflows/ci.yml"]),
      observedAt,
      useLlm: true,
    });

    expect(low).toEqual([expect.objectContaining({ status: "abstained", reason: "impact_confidence_low" })]);
    expect(oversized).toEqual([expect.objectContaining({ status: "abstained", reason: "impact_scope_exceeds_limit" })]);
    expect(protectedPath).toEqual([expect.objectContaining({ status: "abstained", reason: "impact_paths_not_mutable" })]);
    expect(listJobs(db, 20, "tenant-a").filter((job) => job.type === "agent.run")).toHaveLength(0);
  });

  it("does not cross tenant boundaries when a report names another tenant's consumer", () => {
    const { db } = fixture();
    const result = enqueuePipelineWardenRuns(db, {
      tenantId: "tenant-b",
      pipelineJobId: "pipeline-cross-tenant",
      providerSlug: "stripe",
      report: report(["src/client.ts"]),
      observedAt,
      useLlm: true,
    });
    expect(result).toEqual([expect.objectContaining({ status: "abstained", reason: "consumer_not_available" })]);
    expect(listJobs(db, 20, "tenant-b")).toHaveLength(0);
  });

  it("attaches the unambiguous enrolled Fettler campaign to the queued agent.run", () => {
    const { db } = fixture();
    enrollSingleRepoCampaign(db);
    const joined = enqueuePipelineWardenRuns(db, {
      tenantId: "tenant-a",
      pipelineJobId: "pipeline-job-bound",
      providerSlug: "stripe",
      report: report(["src/client.ts"]),
      observedAt,
      useLlm: false,
    });
    const job = getJob(db, joined[0]!.jobId!, "tenant-a");
    const payload = JSON.parse(job!.payload_json) as Record<string, unknown>;
    expect(payload.fettlerCampaignId).toBe("campaign-a");
    expect(payload).not.toHaveProperty("missionId");
  });

  it("replays an already-queued unbound job after a campaign is enrolled", () => {
    const { db } = fixture();
    const first = enqueuePipelineWardenRuns(db, {
      tenantId: "tenant-a",
      pipelineJobId: "pipeline-job-a",
      providerSlug: "stripe",
      report: report(["src/client.ts"]),
      observedAt,
      useLlm: false,
    });
    enrollSingleRepoCampaign(db);
    const second = enqueuePipelineWardenRuns(db, {
      tenantId: "tenant-a",
      pipelineJobId: "pipeline-job-b",
      providerSlug: "stripe",
      report: report(["src/client.ts"]),
      observedAt,
      useLlm: false,
    });
    expect(second[0]?.status).toBe("replayed");
    expect(second[0]?.jobId).toBe(first[0]!.jobId);
    const payload = JSON.parse(getJob(db, first[0]!.jobId!, "tenant-a")!.payload_json) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("fettlerCampaignId");
  });

  it("stays unbound when two single-repo campaigns share the repository", () => {
    const { db } = fixture();
    enrollSingleRepoCampaign(db, { campaignId: "campaign-a", missionId: "mission-a" });
    enrollSingleRepoCampaign(db, { campaignId: "campaign-b", missionId: "mission-b" });
    const joined = enqueuePipelineWardenRuns(db, {
      tenantId: "tenant-a",
      pipelineJobId: "pipeline-ambiguous",
      providerSlug: "stripe",
      report: report(["src/client.ts"]),
      observedAt,
      useLlm: false,
    });
    const payload = JSON.parse(getJob(db, joined[0]!.jobId!, "tenant-a")!.payload_json) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("fettlerCampaignId");
  });

  it("CONTROL: an enqueue with no enrolled campaign stays unbound", () => {
    // Real control for "attaches the unambiguous enrolled Fettler campaign":
    // the treatment's only cause (an enrolled campaign) is removed, so the
    // hint must be absent. If the enqueue path attached a hint unconditionally,
    // this control would fail.
    const { db } = fixture();
    const joined = enqueuePipelineWardenRuns(db, {
      tenantId: "tenant-a",
      pipelineJobId: "pipeline-control",
      providerSlug: "stripe",
      report: report(["src/client.ts"]),
      observedAt,
      useLlm: false,
    });
    const payload = JSON.parse(getJob(db, joined[0]!.jobId!, "tenant-a")!.payload_json) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("fettlerCampaignId");
  });

  it("does not replay a campaign-bound job as an unbound one when the campaign is later unenrolled", () => {
    // One-sided hint case: existing-has-hint / expected-has-none must NOT be
    // treated as an equivalent replay. A dropped campaign hint is a real
    // payload divergence, so the second attempt is an idempotency conflict, not
    // a silent replay of the bound job.
    const { db } = fixture();
    enrollSingleRepoCampaign(db);
    const first = enqueuePipelineWardenRuns(db, {
      tenantId: "tenant-a",
      pipelineJobId: "pipeline-job-a",
      providerSlug: "stripe",
      report: report(["src/client.ts"]),
      observedAt,
      useLlm: false,
    });
    const boundPayload = JSON.parse(getJob(db, first[0]!.jobId!, "tenant-a")!.payload_json) as Record<string, unknown>;
    expect(boundPayload.fettlerCampaignId).toBe("campaign-a");

    // Unenroll the campaign so the next attempt resolves no hint.
    db.raw.prepare(`DELETE FROM fettler_campaign_targets WHERE tenant_id = 'tenant-a'`).run();

    expect(() => enqueuePipelineWardenRuns(db, {
      tenantId: "tenant-a",
      pipelineJobId: "pipeline-job-b",
      providerSlug: "stripe",
      report: report(["src/client.ts"]),
      observedAt,
      useLlm: false,
    })).toThrow("warden_pilot_join_idempotency_conflict");
  });
});
