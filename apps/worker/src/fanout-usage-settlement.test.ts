import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createUsageEntitlement,
  createUsagePriceVersion,
  listUsageLedger,
  reserveRunUsage,
  RUN_USAGE_RESERVATION_KEY,
  RUN_USAGE_RESERVED_MCU_KEY,
  type AppDb,
} from "@mendpoint/db";
import type { PipelineReport } from "@mendpoint/pipeline";
import { settleFanoutRunUsage } from "./cli.js";

const dbs: AppDb[] = [];
const dirs: string[] = [];

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-fanout-usage-"));
  dirs.push(dir);
  const db = createDb(join(dir, "usage.sqlite"));
  dbs.push(db);
  createUsagePriceVersion(db, {
    id: "price-a",
    tenantId: "tenant_default",
    formulaVersion: "mcu-v1",
    currency: "USD",
    pricePerMcuMoneyMicros: 20_000,
    effectiveAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
    contractReference: "contract-a",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  createUsageEntitlement(db, {
    id: "entitlement-a",
    tenantId: "tenant_default",
    priceVersionId: "price-a",
    quotaMcuMicros: 100_000_000,
    features: ["fettler"],
    contractReference: "contract-a",
    periodStart: "2026-09-01T00:00:00.000Z",
    periodEnd: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
  });
  const reserved = 2_000_000;
  const reservation = reserveRunUsage(db, {
    tenantId: "tenant_default",
    runId: "run-fanout-1",
    mcuMicros: reserved,
    reason: "admitted pipeline.fanout run",
    createdAt: "2026-09-02T12:00:00.000Z",
  });
  const payload: Record<string, unknown> = {
    [RUN_USAGE_RESERVATION_KEY]: reservation.id,
    [RUN_USAGE_RESERVED_MCU_KEY]: reserved,
  };
  const report = { surfaces: 0, consumers: [] } as unknown as PipelineReport;
  return { db, payload, report };
}

function settlementProvenance(db: AppDb): string | null | undefined {
  return listUsageLedger(db, "tenant_default")
    .find((entry) => entry.entryType === "settlement")?.consumptionProvenance;
}

describe("fanout run usage settlement provenance", () => {
  it("records the settlement as not_measured when self-serve billing is off (estimate hold)", () => {
    const { db, payload, report } = setup();
    // Env WITHOUT MENDPOINT_SELF_SERVE_BILLING: settlement is the reserved estimate,
    // a hold and not a measurement. Forcing `measured` on the writer would record
    // "measured" here, so this assertion dies under that mutation.
    settleFanoutRunUsage(db, "tenant_default", payload, report, {});
    expect(settlementProvenance(db)).toBe("not_measured:fanout_estimate_hold");
  });

  it("records the settlement as measured when self-serve billing is on", () => {
    const { db, payload, report } = setup();
    settleFanoutRunUsage(db, "tenant_default", payload, report, { MENDPOINT_SELF_SERVE_BILLING: "1" });
    expect(settlementProvenance(db)).toBe("measured");
  });
});
