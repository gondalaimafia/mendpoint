import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimNextJob,
  createDb,
  enqueueJob,
  getWardenModelReservation,
  type AppDb,
} from "@mendpoint/db";
import {
  assertWardenModelAccountingSettled,
  createWardenModelAccountingRuntime,
} from "./warden-model-accounting.js";

const NOW = "2026-08-06T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-warden-model-runtime-"));
  const db = createDb(join(directory, "db.sqlite"));
  opened.push({ db, directory });
  enqueueJob(db, {
    id: "warden-job-a",
    tenantId: "tenant-a",
    type: "agent.run",
    payload: { goal: "repair" },
    createdAt: NOW,
  });
  const job = claimNextJob(db, ["agent.run"], {
    tenantId: "tenant-a",
    workerId: "worker-a",
    leaseMs: 120_000,
    now: NOW,
  })!;
  let tick = 0;
  const runtime = createWardenModelAccountingRuntime({
    db,
    tenantId: "tenant-a",
    jobId: job.id,
    runId: "run-a",
    workerId: job.lease_owner!,
    leaseGeneration: job.lease_generation,
    provider: "provider-a",
    configuredModel: "model-a",
    endpoint: "https://models.example/v1/chat/completions",
    maximumCallCostUsd: 1,
    jobBudgetUsd: 2,
    now: () => new Date(Date.parse(NOW) + ++tick * 1_000).toISOString(),
  });
  return { db, job, runtime };
}

afterEach(() => {
  while (opened.length) {
    const current = opened.pop()!;
    current.db.raw.close();
    rmSync(current.directory, { recursive: true, force: true });
  }
});

describe("Warden worker model accounting runtime", () => {
  it("maps exact agent reservations and settlements into the fenced ledger", async () => {
    const { db, job, runtime } = fixture();
    await runtime.reserve({
      reservationId: "wdmodel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      callIndex: 1,
      requestDigest: `sha256:${"b".repeat(64)}`,
      provider: "provider-a",
      configuredModel: "model-a",
      endpointHost: "models.example",
      maximumInputTokens: 1_000,
      maximumOutputTokens: 200,
      maximumTotalTokens: 1_200,
      maximumCostUsd: 1,
    });
    expect(() => assertWardenModelAccountingSettled(db, {
      tenantId: "tenant-a",
      jobId: job.id,
      workerId: job.lease_owner!,
      leaseGeneration: job.lease_generation,
    })).toThrow("warden_model_reservations_active");

    await runtime.settle({
      reservationId: "wdmodel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      status: "succeeded",
      actualModel: "model-a-20260806",
      bodyRequestId: "body-a",
      headerRequestId: "header-a",
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
      costUsd: 0.5,
    });
    expect(getWardenModelReservation(
      db,
      "tenant-a",
      "wdmodel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    )).toMatchObject({
      status: "succeeded",
      run_id: "run-a",
      body_request_id: "body-a",
      header_request_id: "header-a",
      charged_cost_usd: 0.5,
    });
    expect(() => assertWardenModelAccountingSettled(db, {
      tenantId: "tenant-a",
      jobId: job.id,
      workerId: job.lease_owner!,
      leaseGeneration: job.lease_generation,
    })).not.toThrow();
  });

  it("fails closed when agent provenance drifts from the configured source", async () => {
    const { runtime } = fixture();
    await expect(runtime.reserve({
      reservationId: "wdmodel_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      callIndex: 1,
      requestDigest: `sha256:${"c".repeat(64)}`,
      provider: "different-provider",
      configuredModel: "model-a",
      endpointHost: "models.example",
      maximumInputTokens: 100,
      maximumOutputTokens: 20,
      maximumTotalTokens: 120,
      maximumCostUsd: 1,
    })).rejects.toThrow("warden_model_accounting_provenance_mismatch");
  });
});
