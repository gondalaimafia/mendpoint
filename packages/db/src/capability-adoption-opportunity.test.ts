import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type AppDb } from "./index.js";
import {
  getCapabilityAdoptionOpportunity,
  listCapabilityAdoptionOpportunities,
  recordCapabilityAdoptionOpportunity,
  type RecordCapabilityAdoptionOpportunityInput,
} from "./capability-adoption-opportunity.js";

const NOW = "2026-08-12T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

function fixture(): AppDb {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-cap-adopt-db-"));
  const db = createDb(join(directory, "test.sqlite"));
  opened.push({ db, directory });
  return db;
}

function input(
  overrides: Partial<RecordCapabilityAdoptionOpportunityInput> = {},
): RecordCapabilityAdoptionOpportunityInput {
  return {
    tenantId: "tenant-a",
    changeId: "change-1",
    providerSlug: "acme-payments",
    capabilityId: "acme.POST./v1/balance.path_added",
    op: "path_added",
    endpoint: "GET /v1/balance",
    path: "/v1/balance",
    method: "get",
    field: null,
    linkedConsumerCount: 2,
    adoptingCount: 0,
    nonAdoptingCount: 2,
    adoptionRate: 0,
    priority: 2,
    adoptingConsumers: [],
    nonAdoptingConsumers: [
      { consumerId: "c1", consumerName: "shop-app", evidence: [] },
      { consumerId: "c2", consumerName: "billing-app", evidence: [] },
    ],
    suggestedAction: 'Generate an adopt-PR (pipeline mode "adopt") for GET /v1/balance.',
    valueBasis: "2 of 2 linked consumer(s) do not statically reference GET /v1/balance.",
    now: NOW,
    ...overrides,
  };
}

afterEach(() => {
  while (opened.length) {
    const { db, directory } = opened.pop()!;
    db.raw.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("recordCapabilityAdoptionOpportunity", () => {
  it("persists and reads back the opportunity", () => {
    const db = fixture();
    const record = recordCapabilityAdoptionOpportunity(db, input());
    expect(record.priority).toBe(2);
    expect(record.nonAdoptingConsumers.map((c) => c.consumerName)).toEqual([
      "shop-app",
      "billing-app",
    ]);
    const fetched = getCapabilityAdoptionOpportunity(db, "tenant-a", record.id);
    expect(fetched).toEqual(record);
  });

  it("is idempotent for the same (tenant, change, capability)", () => {
    const db = fixture();
    const first = recordCapabilityAdoptionOpportunity(db, input());
    const second = recordCapabilityAdoptionOpportunity(db, input());
    expect(second.id).toBe(first.id);
    expect(listCapabilityAdoptionOpportunities(db, "tenant-a")).toHaveLength(1);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("upserts re-measured counts on repeat record", () => {
    const db = fixture();
    recordCapabilityAdoptionOpportunity(db, input());
    const updated = recordCapabilityAdoptionOpportunity(
      db,
      input({
        adoptingCount: 1,
        nonAdoptingCount: 1,
        adoptionRate: 0.5,
        priority: 1,
        adoptingConsumers: [{ consumerId: "c2", consumerName: "billing-app", evidence: ["x"] }],
        nonAdoptingConsumers: [{ consumerId: "c1", consumerName: "shop-app", evidence: [] }],
        now: "2026-08-12T13:00:00.000Z",
      }),
    );
    expect(updated.adoptingCount).toBe(1);
    expect(updated.priority).toBe(1);
    expect(updated.updatedAt).toBe("2026-08-12T13:00:00.000Z");
    expect(updated.createdAt).toBe(NOW);
    expect(listCapabilityAdoptionOpportunities(db, "tenant-a")).toHaveLength(1);
  });

  it("scopes reads and listing by tenant", () => {
    const db = fixture();
    recordCapabilityAdoptionOpportunity(db, input());
    recordCapabilityAdoptionOpportunity(db, input({ tenantId: "tenant-b" }));
    expect(listCapabilityAdoptionOpportunities(db, "tenant-a")).toHaveLength(1);
    expect(listCapabilityAdoptionOpportunities(db, "tenant-b")).toHaveLength(1);
    expect(
      listCapabilityAdoptionOpportunities(db, "tenant-a", { providerSlug: "nope" }),
    ).toHaveLength(0);
  });

  it("rejects an out-of-range adoption rate", () => {
    const db = fixture();
    expect(() => recordCapabilityAdoptionOpportunity(db, input({ adoptionRate: 1.5 }))).toThrow(
      "capability_adoption_opportunity_rate_invalid",
    );
  });
});
