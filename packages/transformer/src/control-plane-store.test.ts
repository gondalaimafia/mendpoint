import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NODE_RUNTIME_18_TO_20_RECIPE, recipeReference } from "./recipe.js";
import {
  TransformerControlPlaneStore,
  type BlueprintPolicy,
  type MutationContext,
} from "./control-plane-store.js";

function context(id: string, actorId = "operator-1"): MutationContext {
  return {
    actorId,
    correlationId: `correlation-${id}`,
    causationId: `causation-${id}`,
    evidenceRefs: [`evidence://${id}`],
    idempotencyKey: `idempotency-${id}`,
  };
}

function blueprintPolicy(
  overrides: Partial<BlueprintPolicy> = {},
): BlueprintPolicy {
  return {
    ownerIds: ["owner-1"],
    risks: [
      {
        id: "risk-1",
        statement: "Runtime behavior may change",
        severity: "medium",
        ownerId: "owner-1",
        evidenceRefs: ["source://package.json#engines.node"],
      },
    ],
    unknowns: [
      {
        id: "unknown-1",
        question: "Does production use the declared runtime?",
        ownerId: "owner-1",
        evidenceRefs: ["source://Dockerfile#1"],
      },
    ],
    verification: { commands: ["npm test"] },
    rollback: {
      strategy: "inverse_operations",
      verificationCommands: ["npm test"],
    },
    approval: { required: true, reviewerIds: ["reviewer-1"] },
    recipe: recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
    ...overrides,
  };
}

function createDraft(
  store: TransformerControlPlaneStore,
  tenantId = "tenant-a",
  campaignId = "campaign-1",
) {
  const suffix = `${tenantId}-${campaignId}`;
  store.createCampaign(
    {
      tenantId,
      id: campaignId,
      name: `${tenantId} migration`,
      sourceSystem: "node@18",
      targetSystem: "node@20",
      blueprintId: "blueprint-1",
      bsgId: "bsg-1",
    },
    context(`${suffix}-campaign`),
  );
  store.createBlueprint(
    {
      tenantId,
      id: "blueprint-1",
      campaignId,
      objective: "Preserve behavior while changing runtimes",
      content: { scope: ["payments"] },
      policy: blueprintPolicy(),
    },
    context(`${suffix}-blueprint`),
  );
  store.createBsg(
    {
      tenantId,
      id: "bsg-1",
      campaignId,
      nodes: [],
      edges: [],
    },
    context(`${suffix}-bsg`),
  );
}

function reviewAndLock(
  store: TransformerControlPlaneStore,
  tenantId = "tenant-a",
  campaignId = "campaign-1",
) {
  const suffix = `${tenantId}-${campaignId}`;
  store.transitionBlueprint(
    tenantId,
    "blueprint-1",
    "in_review",
    1,
    context(`${suffix}-blueprint-review`),
  );
  store.transitionBlueprint(
    tenantId,
    "blueprint-1",
    "reviewed",
    2,
    context(`${suffix}-blueprint-reviewed`),
  );
  store.reviseBsg(
    tenantId,
    "bsg-1",
    [
      {
        id: "behavior-1",
        kind: "behavior",
        spec: "Payment totals remain unchanged",
        sourceRefs: ["test://payments.test.ts#retains-totals", "schema://payments#total"],
      },
    ],
    [],
    1,
    context(`${suffix}-bsg-revise`),
  );
  store.lockBsg(tenantId, "bsg-1", 2, context(`${suffix}-bsg-lock`));
  store.transitionCampaign(
    tenantId,
    campaignId,
    "ready",
    1,
    context(`${suffix}-campaign-ready`),
  );
  store.transitionCampaign(
    tenantId,
    campaignId,
    "running",
    2,
    context(`${suffix}-campaign-running`),
  );
}

describe("Transformer durable control plane contracts", () => {
  it("rolls back nested mutations and idempotency records when an atomic operation fails", () => {
    const store = new TransformerControlPlaneStore();
    expect(() =>
      store.atomic(() => {
        createDraft(store);
        store.atomic(() => {
          expect(store.getCampaign("tenant-a", "campaign-1")).toBeDefined();
        });
        throw new Error("injected_post_write_failure");
      }),
    ).toThrow("injected_post_write_failure");

    expect(store.getCampaign("tenant-a", "campaign-1")).toBeUndefined();
    expect(store.getBlueprint("tenant-a", "blueprint-1")).toBeUndefined();
    expect(store.getBsg("tenant-a", "bsg-1")).toBeUndefined();
    expect(store.listEvents("tenant-a", "campaign-1")).toEqual([]);

    createDraft(store);
    expect(store.getCampaign("tenant-a", "campaign-1")?.revision).toBe(1);
    store.close();
  });

  it("requires complete blueprint policy and the exact registered recipe digest", () => {
    const store = new TransformerControlPlaneStore();
    try {
      store.createCampaign(
        {
          tenantId: "tenant-a",
          id: "campaign-1",
          name: "Runtime migration",
          sourceSystem: "node@18",
          targetSystem: "node@20",
          blueprintId: "blueprint-1",
          bsgId: "bsg-1",
        },
        context("campaign"),
      );

      expect(() =>
        store.createBlueprint(
          {
            tenantId: "tenant-a",
            id: "blueprint-1",
            campaignId: "campaign-1",
            objective: "Migrate the runtime",
            content: {},
            policy: blueprintPolicy({ ownerIds: [] }),
          },
          context("blueprint-missing-owner"),
        ),
      ).toThrow("blueprint_owner_required");

      expect(() =>
        store.createBlueprint(
          {
            tenantId: "tenant-a",
            id: "blueprint-1",
            campaignId: "campaign-1",
            objective: "Migrate the runtime",
            content: {},
            policy: blueprintPolicy({
              recipe: {
                ...recipeReference(NODE_RUNTIME_18_TO_20_RECIPE),
                digest: `sha256:${"0".repeat(64)}`,
              },
            }),
          },
          context("blueprint-wrong-recipe"),
        ),
      ).toThrow("recipe_digest_mismatch");

      const blueprint = store.createBlueprint(
        {
          tenantId: "tenant-a",
          id: "blueprint-1",
          campaignId: "campaign-1",
          objective: "Migrate the runtime",
          content: {},
          policy: blueprintPolicy(),
        },
        context("blueprint-valid"),
      );
      expect(blueprint.policy.recipe.digest).toBe(NODE_RUNTIME_18_TO_20_RECIPE.digest);
      expect(Object.isFrozen(blueprint.policy.recipe)).toBe(true);
      expect(Object.isFrozen(blueprint.policy)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("replays an identical create once and rejects a conflicting replay", () => {
    const store = new TransformerControlPlaneStore();
    const input = {
      tenantId: "tenant-a",
      id: "campaign-1",
      name: "Runtime migration",
      sourceSystem: "node@18",
      targetSystem: "node@20",
      blueprintId: "blueprint-1",
      bsgId: "bsg-1",
    };
    try {
      const first = store.createCampaign(input, context("campaign-replay"));
      const replay = store.createCampaign({ ...input }, context("campaign-replay"));
      expect(replay).toEqual(first);
      expect(store.listEvents("tenant-a", "campaign-1")).toHaveLength(1);
      expect(() =>
        store.createCampaign(
          { ...input, name: "Conflicting migration" },
          context("campaign-replay"),
        ),
      ).toThrow("idempotency_conflict");
    } finally {
      store.close();
    }
  });

  it("rejects stale revisions without appending a version or event", () => {
    const store = new TransformerControlPlaneStore();
    try {
      createDraft(store);
      const reviewed = store.transitionBlueprint(
        "tenant-a",
        "blueprint-1",
        "in_review",
        1,
        context("review-once"),
      );
      const before = store.listEvents("tenant-a", "campaign-1").length;
      expect(reviewed.revision).toBe(2);
      expect(() =>
        store.transitionBlueprint(
          "tenant-a",
          "blueprint-1",
          "reviewed",
          1,
          context("stale-review"),
        ),
      ).toThrow("blueprint_revision_conflict");
      expect(store.getBlueprint("tenant-a", "blueprint-1")?.revision).toBe(2);
      expect(store.listEvents("tenant-a", "campaign-1")).toHaveLength(before);
    } finally {
      store.close();
    }
  });

  it("preserves source provenance, policy, events, and idempotency across restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "transformer-control-"));
    const path = join(dir, "control.sqlite");
    try {
      let store = new TransformerControlPlaneStore(path);
      createDraft(store);
      reviewAndLock(store);
      const eventCount = store.listEvents("tenant-a", "campaign-1").length;
      store.close();

      store = new TransformerControlPlaneStore(path);
      expect(store.schemaVersion()).toBe(2);
      expect(store.getCampaign("tenant-a", "campaign-1")?.state).toBe("running");
      expect(store.getBsg("tenant-a", "bsg-1")?.nodes[0]?.sourceRefs).toEqual([
        "test://payments.test.ts#retains-totals",
        "schema://payments#total",
      ]);
      const blueprint = store.getBlueprint("tenant-a", "blueprint-1");
      expect(blueprint?.policy.recipe.digest).toBe(NODE_RUNTIME_18_TO_20_RECIPE.digest);
      expect(Object.isFrozen(blueprint?.policy.recipe)).toBe(true);
      const events = store.listEvents("tenant-a", "campaign-1");
      expect(events).toHaveLength(eventCount);
      expect(events.every((event) => event.actorId === "operator-1")).toBe(true);
      expect(events.every((event) => event.correlationId.length > 0)).toBe(true);
      expect(events.every((event) => event.causationId.length > 0)).toBe(true);
      expect(events.every((event) => event.evidenceRefs.length > 0)).toBe(true);
      expect(events[0]).toMatchObject({ previousRevision: 0, newRevision: 1 });

      const replay = store.createCampaign(
        {
          tenantId: "tenant-a",
          id: "campaign-1",
          name: "tenant-a migration",
          sourceSystem: "node@18",
          targetSystem: "node@20",
          blueprintId: "blueprint-1",
          bsgId: "bsg-1",
        },
        context("tenant-a-campaign-1-campaign"),
      );
      expect(replay.revision).toBe(1);
      expect(store.listEvents("tenant-a", "campaign-1")).toHaveLength(eventCount);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps identical entity and idempotency keys isolated between tenants", () => {
    const store = new TransformerControlPlaneStore();
    try {
      createDraft(store, "tenant-a", "campaign-1");
      createDraft(store, "tenant-b", "campaign-1");
      expect(store.getCampaign("tenant-a", "campaign-1")?.name).toBe("tenant-a migration");
      expect(store.getCampaign("tenant-b", "campaign-1")?.name).toBe("tenant-b migration");
      expect(store.getCampaign("tenant-c", "campaign-1")).toBeUndefined();
      expect(store.listEvents("tenant-a", "campaign-1")).toHaveLength(3);
      expect(store.listEvents("tenant-b", "campaign-1")).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  it("enforces append-only versions, events, and idempotency at the SQLite boundary", () => {
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
      expect(() => raw.exec("DELETE FROM tf_campaign_versions")).toThrow(
        "transformer_versions_append_only",
      );
      expect(() => raw.exec("DELETE FROM tf_idempotency_keys")).toThrow(
        "transformer_idempotency_append_only",
      );
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
