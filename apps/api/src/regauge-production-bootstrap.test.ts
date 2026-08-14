import { describe, expect, it } from "vitest";
import { TRANSFORMER_GATE_SCHEMA_VERSION } from "@mendpoint/ops";
import {
  bootstrapRegaugeProductionCampaign,
  type RegaugeProductionBootstrapInput,
  type RegaugeProductionBootstrapRuntime,
} from "./regauge-production-bootstrap.js";

const REVISION = "a".repeat(40);
const SNAPSHOT_DIGEST = `sha256:${"b".repeat(64)}`;
const APPROVAL_REF = "approval:regauge:20260814";

function gate(): string {
  return JSON.stringify({
    schemaVersion: TRANSFORMER_GATE_SCHEMA_VERSION,
    tenantAllowlist: ["tenant_regauge_canary"],
    environmentAllowlist: ["production"],
    grants: [{
      tenantId: "tenant_regauge_canary",
      environment: "production",
      boundaries: ["api_control_plane", "worker_action", "delivery"],
      acceptanceEvidenceRefs: ["evidence:regauge:acceptance"],
      productionDeliveryApprovalRefs: [APPROVAL_REF],
    }],
  });
}

function input(): RegaugeProductionBootstrapInput {
  return {
    tenantId: "tenant_regauge_canary",
    campaignId: "campaign_regauge_canary_20260814",
    environment: "production",
    repository: {
      owner: "gondalaimafia",
      name: "mendpoint-canary-drill-20260801",
      remoteRepositoryId: "1319732323",
      defaultBranch: "main",
      selectedBranch: "codex/regauge-canary-baseline",
      expectedRevision: REVISION,
      installationId: "7123456",
      accountId: "7654321",
      accountLogin: "gondalaimafia",
    },
    plannerActorId: "service:regauge-production-bootstrap",
    reviewer: {
      issuer: "https://github.com",
      subject: "gondalaimafia",
      displayName: "Talal Gondal",
      email: null,
    },
    objective: {
      id: "regauge-node-20-to-22-canary",
      statement: "Upgrade the approved canary from Node 20 to Node 22.",
      sourceSystem: "node@20",
      targetSystem: "node@22",
    },
    gateConfig: gate(),
    productionApprovalRef: APPROVAL_REF,
    evidenceRefs: [APPROVAL_REF, "evidence:regauge:acceptance"],
  };
}

function fakeRuntime() {
  let control: Awaited<ReturnType<RegaugeProductionBootstrapRuntime["readControl"]>>;
  let execution: Awaited<ReturnType<RegaugeProductionBootstrapRuntime["readExecution"]>>;
  let receipt: Awaited<ReturnType<RegaugeProductionBootstrapRuntime["readReceipt"]>>;
  const calls = { prepare: 0, plan: 0, review: 0, launch: 0, record: 0 };
  const runtime: RegaugeProductionBootstrapRuntime = {
    async prepareRepository() {
      calls.prepare += 1;
      return {
        repositoryId: "repository-a",
        snapshotId: "snapshot-a",
        revision: REVISION,
        snapshotDigest: SNAPSHOT_DIGEST,
      };
    },
    async readControl() { return control; },
    async plan(request) {
      calls.plan += 1;
      control = {
        campaignId: request.campaignId,
        campaignState: "draft",
        campaignRevision: 1,
        blueprintId: "blueprint-a",
        blueprintDigest: `sha256:${"c".repeat(64)}`,
        blueprintState: "draft",
        blueprintRevision: 1,
        bsgRevision: 1,
        repositoryId: request.repositoryId,
        snapshotId: request.snapshotId,
        revision: request.revision,
        snapshotDigest: request.snapshotDigest,
        plannerActorId: request.plannerActorId,
        reviewerActorIds: [request.reviewerActorId],
        sourceSystem: request.objective.sourceSystem,
        targetSystem: request.objective.targetSystem,
        objectiveStatement: request.objective.statement,
      };
      return control;
    },
    async review(request) {
      calls.review += 1;
      control = { ...request.control, campaignState: "ready", campaignRevision: 2,
        blueprintState: "reviewed", blueprintRevision: 3, bsgRevision: 2 };
      return control;
    },
    async readExecution() { return execution; },
    async launch(request) {
      calls.launch += 1;
      execution = {
        campaignId: request.campaignId,
        state: "running",
        repositoryId: request.control.repositoryId,
        snapshotId: request.control.snapshotId,
        revision: request.control.revision,
        snapshotDigest: request.control.snapshotDigest,
        blueprintId: request.control.blueprintId,
        blueprintDigest: request.control.blueprintDigest,
      };
      return execution;
    },
    async readReceipt() { return receipt; },
    async recordReceipt(value) {
      calls.record += 1;
      receipt = { ...value, eventHash: `sha256:${"d".repeat(64)}` };
      return receipt;
    },
  };
  return { runtime, calls };
}

describe("Regauge production campaign bootstrap", () => {
  it("prepares, independently reviews, launches, records, and exactly replays one campaign", async () => {
    const fixture = fakeRuntime();

    const first = await bootstrapRegaugeProductionCampaign(input(), fixture.runtime);
    const second = await bootstrapRegaugeProductionCampaign(input(), fixture.runtime);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      tenantId: "tenant_regauge_canary",
      campaignId: "campaign_regauge_canary_20260814",
      repositoryId: "repository-a",
      snapshotId: "snapshot-a",
      revision: REVISION,
      state: "running",
      eventHash: `sha256:${"d".repeat(64)}`,
    });
    expect(fixture.calls).toEqual({ prepare: 1, plan: 1, review: 1, launch: 1, record: 1 });
  });

  it("rejects campaign drift before invoking repository or mission effects", async () => {
    const fixture = fakeRuntime();
    await bootstrapRegaugeProductionCampaign(input(), fixture.runtime);
    const changed = input();
    changed.repository.expectedRevision = "e".repeat(40);

    await expect(bootstrapRegaugeProductionCampaign(changed, fixture.runtime))
      .rejects.toThrow("regauge_production_bootstrap_idempotency_conflict");
    expect(fixture.calls.prepare).toBe(1);
  });

  it("does not trust a receipt when the durable execution authority is missing", async () => {
    const fixture = fakeRuntime();
    await bootstrapRegaugeProductionCampaign(input(), fixture.runtime);

    await expect(bootstrapRegaugeProductionCampaign(input(), {
      ...fixture.runtime,
      async readExecution() { return undefined; },
    })).rejects.toThrow("regauge_production_bootstrap_execution_drift");
    expect(fixture.calls).toEqual({ prepare: 1, plan: 1, review: 1, launch: 1, record: 1 });
  });

  it("fails closed before effects without an independent reviewer and production delivery grant", async () => {
    const fixture = fakeRuntime();
    const sameActor = input();
    sameActor.plannerActorId = "human:https://github.com|gondalaimafia";
    await expect(bootstrapRegaugeProductionCampaign(sameActor, fixture.runtime))
      .rejects.toThrow("regauge_production_bootstrap_independent_reviewer_required");

    const missingApproval = input();
    missingApproval.productionApprovalRef = "approval:missing";
    missingApproval.evidenceRefs = ["approval:missing", "evidence:regauge:acceptance"];
    await expect(bootstrapRegaugeProductionCampaign(missingApproval, fixture.runtime))
      .rejects.toThrow("regauge_production_bootstrap_gate_denied");
    expect(fixture.calls).toEqual({ prepare: 0, plan: 0, review: 0, launch: 0, record: 0 });
  });
});
