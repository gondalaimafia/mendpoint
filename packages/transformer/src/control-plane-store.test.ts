import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TransformerControlPlaneStore } from "./control-plane-store.js";

function createDraft(
  store: TransformerControlPlaneStore,
  tenantId = "tenant-a",
  campaignId = "campaign-1",
) {
  store.createCampaign({
    tenantId,
    id: campaignId,
    name: `${tenantId} migration`,
    sourceSystem: "legacy",
    targetSystem: "target",
    blueprintId: "blueprint-1",
    bsgId: "bsg-1",
  });
  store.createBlueprint({
    tenantId,
    id: "blueprint-1",
    campaignId,
    objective: "preserve behavior",
    content: { scope: ["orders"] },
  });
  store.createBsg({
    tenantId,
    id: "bsg-1",
    campaignId,
    nodes: [],
    edges: [],
  });
}

function reviewAndLock(
  store: TransformerControlPlaneStore,
  tenantId = "tenant-a",
  campaignId = "campaign-1",
) {
  store.transitionBlueprint(tenantId, "blueprint-1", "in_review");
  store.transitionBlueprint(tenantId, "blueprint-1", "reviewed");
  store.reviseBsg(
    tenantId,
    "bsg-1",
    [{ id: "behavior-1", kind: "behavior", spec: "orders retain totals" }],
    [],
  );
  store.lockBsg(tenantId, "bsg-1");
  store.transitionCampaign(tenantId, campaignId, "ready");
  store.transitionCampaign(tenantId, campaignId, "running");
}

describe("Transformer durable control plane", () => {
  it("blocks execution until a reviewed blueprint and nonempty locked BSG exist", () => {
    const store = new TransformerControlPlaneStore();
    try {
      createDraft(store);
      expect(() =>
        store.transitionCampaign("tenant-a", "campaign-1", "ready"),
      ).toThrow("reviewed_blueprint_required");

      store.transitionBlueprint("tenant-a", "blueprint-1", "in_review");
      store.transitionBlueprint("tenant-a", "blueprint-1", "reviewed");
      expect(() => store.lockBsg("tenant-a", "bsg-1")).toThrow(
        "nonempty_bsg_required",
      );
      expect(() =>
        store.transitionCampaign("tenant-a", "campaign-1", "ready"),
      ).toThrow("nonempty_locked_bsg_required");

      store.reviseBsg(
        "tenant-a",
        "bsg-1",
        [{ id: "invariant-1", kind: "invariant", spec: "total never changes" }],
        [],
      );
      store.lockBsg("tenant-a", "bsg-1");
      expect(store.transitionCampaign("tenant-a", "campaign-1", "ready").state).toBe(
        "ready",
      );
      expect(
        store.transitionCampaign("tenant-a", "campaign-1", "running").state,
      ).toBe("running");
      store.createUnit({
        tenantId: "tenant-a",
        id: "unit-1",
        campaignId: "campaign-1",
        title: "migrate orders",
        repoKey: "orders",
        dependsOn: [],
      });
      store.createAttempt({
        tenantId: "tenant-a",
        id: "attempt-1",
        campaignId: "campaign-1",
        unitId: "unit-1",
        number: 1,
        input: {},
      });
      store.createPullRequest({
        tenantId: "tenant-a",
        id: "pr-1",
        campaignId: "campaign-1",
        unitId: "unit-1",
        url: "https://example.test/pr/1",
      });
      store.transitionCampaign("tenant-a", "campaign-1", "paused");
      expect(() =>
        store.transitionAttempt("tenant-a", "attempt-1", "running"),
      ).toThrow("campaign_running_required");
      expect(() =>
        store.transitionPullRequest("tenant-a", "pr-1", "open"),
      ).toThrow("campaign_running_required");
    } finally {
      store.close();
    }
  });

  it("enforces state machines and records every accepted revision", () => {
    const store = new TransformerControlPlaneStore();
    try {
      createDraft(store);
      expect(() =>
        store.transitionCampaign("tenant-a", "campaign-1", "running"),
      ).toThrow("invalid_campaign_transition:draft->running");
      expect(() =>
        store.transitionBlueprint("tenant-a", "blueprint-1", "reviewed"),
      ).toThrow("invalid_blueprint_transition:draft->reviewed");

      const review = store.transitionBlueprint(
        "tenant-a",
        "blueprint-1",
        "in_review",
      );
      expect(review.revision).toBe(2);
      const reviewed = store.transitionBlueprint(
        "tenant-a",
        "blueprint-1",
        "reviewed",
      );
      expect(reviewed.revision).toBe(3);
      expect(() =>
        store.reviseBlueprint("tenant-a", "blueprint-1", { changed: true }),
      ).toThrow("reviewed_blueprint_immutable");

      const approval = store.createApproval({
        tenantId: "tenant-a",
        id: "approval-1",
        campaignId: "campaign-1",
        subjectType: "blueprint",
        subjectId: "blueprint-1",
      });
      expect(approval.revision).toBe(1);
      expect(() =>
        store.transitionApproval("tenant-a", "approval-1", "revoked", {
          reviewerId: "reviewer-1",
          note: "revoke",
        }),
      ).toThrow("invalid_approval_transition:pending->revoked");
      expect(() =>
        store.transitionApproval("tenant-a", "approval-1", "approved"),
      ).toThrow("approval_reviewer_required");
      expect(
        store.transitionApproval("tenant-a", "approval-1", "approved", {
          reviewerId: "reviewer-1",
        }).revision,
      ).toBe(2);

      const events = store.listEvents("tenant-a", "campaign-1");
      expect(events.map((event) => event.sequence)).toEqual(
        [...events.map((event) => event.sequence)].sort((a, b) => a - b),
      );
      expect(events.some((event) => event.type === "blueprint.transitioned")).toBe(
        true,
      );
    } finally {
      store.close();
    }
  });

  it("survives restart with every control-plane contract and event", () => {
    const dir = mkdtempSync(join(tmpdir(), "transformer-control-"));
    const path = join(dir, "control.sqlite");
    try {
      let store = new TransformerControlPlaneStore(path);
      createDraft(store);
      reviewAndLock(store);
      store.createUnit({
        tenantId: "tenant-a",
        id: "unit-1",
        campaignId: "campaign-1",
        title: "migrate orders",
        repoKey: "orders",
        dependsOn: [],
        waveId: "wave-1",
      });
      store.transitionUnit("tenant-a", "unit-1", "ready");
      store.transitionUnit("tenant-a", "unit-1", "running");
      store.createWave({
        tenantId: "tenant-a",
        id: "wave-1",
        campaignId: "campaign-1",
        name: "first wave",
        unitIds: ["unit-1"],
      });
      store.transitionWave("tenant-a", "wave-1", "ready");
      store.transitionWave("tenant-a", "wave-1", "running");
      store.createAttempt({
        tenantId: "tenant-a",
        id: "attempt-1",
        campaignId: "campaign-1",
        unitId: "unit-1",
        number: 1,
        input: { command: "test" },
      });
      store.createApproval({
        tenantId: "tenant-a",
        id: "approval-1",
        campaignId: "campaign-1",
        subjectType: "wave",
        subjectId: "wave-1",
      });
      store.createException({
        tenantId: "tenant-a",
        id: "exception-1",
        campaignId: "campaign-1",
        code: "TEST_FAILED",
        message: "one test failed",
        unitId: "unit-1",
      });
      store.createArtifact({
        tenantId: "tenant-a",
        id: "artifact-1",
        campaignId: "campaign-1",
        kind: "test-report",
        uri: "artifact://test-report",
        digest: `sha256:${"a".repeat(64)}`,
        metadata: { passed: 99 },
      });
      store.createPullRequest({
        tenantId: "tenant-a",
        id: "pr-1",
        campaignId: "campaign-1",
        unitId: "unit-1",
        url: "https://example.test/pr/1",
        number: 1,
      });
      store.appendEvent({
        id: "checkpoint-1",
        tenantId: "tenant-a",
        campaignId: "campaign-1",
        type: "campaign.checkpointed",
        entityType: "campaign",
        entityId: "campaign-1",
        payload: { durable: true },
      });
      const eventCount = store.listEvents("tenant-a", "campaign-1").length;
      store.close();

      store = new TransformerControlPlaneStore(path);
      expect(store.schemaVersion()).toBe(1);
      expect(store.getCampaign("tenant-a", "campaign-1")?.state).toBe("running");
      expect(store.getBlueprint("tenant-a", "blueprint-1")?.state).toBe("reviewed");
      expect(store.getBsg("tenant-a", "bsg-1")?.nodes).toHaveLength(1);
      expect(store.getUnit("tenant-a", "unit-1")?.state).toBe("running");
      expect(store.getWave("tenant-a", "wave-1")?.state).toBe("running");
      expect(store.getAttempt("tenant-a", "attempt-1")?.state).toBe("queued");
      expect(store.getApproval("tenant-a", "approval-1")?.state).toBe("pending");
      expect(store.getException("tenant-a", "exception-1")?.state).toBe("open");
      expect(store.getArtifact("tenant-a", "artifact-1")?.digest).toBe(
        `sha256:${"a".repeat(64)}`,
      );
      expect(store.getPullRequest("tenant-a", "pr-1")?.state).toBe("draft");
      expect(store.listEvents("tenant-a", "campaign-1")).toHaveLength(eventCount);
      expect(
        store
          .listEvents("tenant-a", "campaign-1")
          .some((event) => event.id === "checkpoint-1"),
      ).toBe(true);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps identical IDs isolated between tenants", () => {
    const store = new TransformerControlPlaneStore();
    try {
      createDraft(store, "tenant-a", "campaign-1");
      createDraft(store, "tenant-b", "campaign-1");
      expect(store.getCampaign("tenant-a", "campaign-1")?.name).toBe(
        "tenant-a migration",
      );
      expect(store.getCampaign("tenant-b", "campaign-1")?.name).toBe(
        "tenant-b migration",
      );
      expect(store.getCampaign("tenant-c", "campaign-1")).toBeUndefined();
      expect(() =>
        store.transitionCampaign("tenant-c", "campaign-1", "ready"),
      ).toThrow("campaign_not_found");
      expect(store.listEvents("tenant-a", "campaign-1")).toHaveLength(3);
      expect(store.listEvents("tenant-b", "campaign-1")).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  it("enforces append-only events at the SQLite boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "transformer-events-"));
    const path = join(dir, "events.sqlite");
    try {
      const store = new TransformerControlPlaneStore(path);
      createDraft(store);
      store.close();

      const raw = new DatabaseSync(path);
      expect(() => raw.exec("UPDATE tf_events SET type = 'tampered'")).toThrow(
        "transformer_events_append_only",
      );
      expect(() => raw.exec("DELETE FROM tf_events")).toThrow(
        "transformer_events_append_only",
      );
      expect(() => raw.exec("UPDATE tf_campaign_versions SET state = 'completed'")).toThrow(
        "transformer_versions_append_only",
      );
      expect(() => raw.exec("DELETE FROM tf_blueprint_versions")).toThrow(
        "transformer_versions_append_only",
      );
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
