import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimNextJob,
  createDb,
  enqueueJob,
  getWardenModelReservation,
  recoverExpiredJobs,
  reserveWardenModelCall,
  settleActiveWardenModelReservationsForFence,
  settleWardenModelCall,
  verifyWardenModelReservationIntegrity,
  type AppDb,
  type JobRow,
  type WardenModelReservationInput,
} from "./index.js";

const NOW = "2026-08-06T12:00:00.000Z";
const LATER = "2026-08-06T12:01:00.000Z";
const AFTER_EXPIRY = "2026-08-06T12:02:01.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

function fixture(): { db: AppDb; job: JobRow } {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-warden-model-accounting-"));
  const db = createDb(join(directory, "db.sqlite"));
  opened.push({ db, directory });
  enqueueJob(db, {
    id: "warden-job-a",
    tenantId: "tenant-a",
    type: "agent.run",
    payload: { goal: "repair" },
    maxAttempts: 3,
    createdAt: NOW,
  });
  const job = claimNextJob(db, ["agent.run"], {
    tenantId: "tenant-a",
    workerId: "worker-a",
    leaseMs: 120_000,
    now: NOW,
  });
  if (!job) throw new Error("test job was not claimed");
  return { db, job };
}

function reservation(
  job: JobRow,
  overrides: Partial<WardenModelReservationInput> = {},
): WardenModelReservationInput {
  return {
    id: "wdmodel-call-a",
    tenantId: job.tenant_id,
    jobId: job.id,
    runId: "run-a",
    workerId: job.lease_owner!,
    leaseGeneration: job.lease_generation,
    callIndex: 1,
    requestDigest: `sha256:${"a".repeat(64)}`,
    provider: "provider-a",
    configuredModel: "model-a",
    endpointHost: "models.example",
    maximumInputTokens: 1_000,
    maximumOutputTokens: 200,
    maximumTotalTokens: 1_200,
    maximumCostUsd: 1.25,
    jobBudgetUsd: 2,
    observedAt: LATER,
    ...overrides,
  };
}

afterEach(() => {
  while (opened.length) {
    const current = opened.pop()!;
    current.db.raw.close();
    rmSync(current.directory, { recursive: true, force: true });
  }
});

describe("Warden durable model accounting", () => {
  it("reserves once behind the current job lease and preserves exact provenance", () => {
    const { db, job } = fixture();
    const input = reservation(job);
    const first = reserveWardenModelCall(db, input);
    const replay = reserveWardenModelCall(db, input);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      id: input.id,
      tenant_id: "tenant-a",
      job_id: job.id,
      run_id: "run-a",
      worker_id: "worker-a",
      lease_generation: 1,
      call_index: 1,
      request_digest: input.requestDigest,
      provider: "provider-a",
      configured_model: "model-a",
      endpoint_host: "models.example",
      status: "active",
      maximum_cost_usd: 1.25,
    });
    expect(() => reserveWardenModelCall(db, {
      ...input,
      maximumCostUsd: 1.2,
    })).toThrow("warden_model_reservation_idempotency_conflict");
  });

  it("counts active reservations against job headroom under competing calls", () => {
    const { db, job } = fixture();
    reserveWardenModelCall(db, reservation(job));

    expect(() => reserveWardenModelCall(db, reservation(job, {
      id: "wdmodel-call-b",
      callIndex: 2,
      requestDigest: `sha256:${"b".repeat(64)}`,
      maximumCostUsd: 0.76,
    }))).toThrow("warden_model_budget_exhausted");
    expect(getWardenModelReservation(db, "tenant-a", "wdmodel-call-b")).toBeUndefined();
  });

  it("settles exact measured usage once and rejects stale or conflicting evidence", () => {
    const { db, job } = fixture();
    const input = reservation(job);
    reserveWardenModelCall(db, input);
    const settlement = {
      tenantId: "tenant-a",
      jobId: job.id,
      reservationId: input.id,
      workerId: job.lease_owner!,
      leaseGeneration: job.lease_generation,
      status: "succeeded" as const,
      actualModel: "model-a-2026-08-06",
      bodyRequestId: "body-request-a",
      headerRequestId: "header-request-a",
      inputTokens: 500,
      outputTokens: 100,
      totalTokens: 600,
      costUsd: 0.5,
      observedAt: LATER,
    };
    const first = settleWardenModelCall(db, settlement);
    expect(settleWardenModelCall(db, settlement)).toEqual(first);
    expect(first).toMatchObject({
      status: "succeeded",
      actual_model: settlement.actualModel,
      body_request_id: settlement.bodyRequestId,
      header_request_id: settlement.headerRequestId,
      reported_total_tokens: 600,
      reported_cost_usd: 0.5,
      charged_total_tokens: 600,
      charged_cost_usd: 0.5,
    });
    expect(verifyWardenModelReservationIntegrity(first)).toEqual({
      ok: true,
      reservationDigestVersion: 1,
      settlementDigestVersion: 2,
    });
    expect(verifyWardenModelReservationIntegrity({
      ...first,
      maximum_cost_usd: 1.2,
    })).toMatchObject({ ok: false, error: "warden_model_reservation_digest_mismatch" });
    expect(verifyWardenModelReservationIntegrity({
      ...first,
      charged_cost_usd: 0.6,
    })).toMatchObject({ ok: false, error: "warden_model_settlement_digest_mismatch" });
    expect(() => settleWardenModelCall(db, {
      ...settlement,
      costUsd: 0.6,
    })).toThrow("warden_model_settlement_idempotency_conflict");
    expect(() => reserveWardenModelCall(db, reservation(job, {
      id: "wdmodel-stale",
      workerId: "worker-stale",
    }))).toThrow("warden_model_job_lease_stale");
  });

  it.each([
    ["all-zero", { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }],
    ["missing", {}],
    ["inconsistent", { inputTokens: 10, outputTokens: 5, totalTokens: 16, costUsd: 0.1 }],
    ["zero-cost", { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0 }],
  ])("charges the reservation maximum for %s successful usage evidence", (_case, usage) => {
    const { db, job } = fixture();
    const input = reservation(job);
    reserveWardenModelCall(db, input);

    const settled = settleWardenModelCall(db, {
      tenantId: "tenant-a",
      jobId: job.id,
      reservationId: input.id,
      workerId: job.lease_owner!,
      leaseGeneration: job.lease_generation,
      status: "succeeded",
      ...usage,
      observedAt: LATER,
    });

    expect(settled).toMatchObject({
      status: "over_budget",
      charged_input_tokens: input.maximumInputTokens,
      charged_output_tokens: input.maximumOutputTokens,
      charged_total_tokens: input.maximumTotalTokens,
      charged_cost_usd: input.maximumCostUsd,
    });
  });

  it("charges the reservation maximum for failed, unmeasured, or over-budget calls", () => {
    const { db, job } = fixture();
    for (const [index, status] of [[1, "failed"], [2, "succeeded"]] as const) {
      const input = reservation(job, {
        id: `wdmodel-conservative-${index}`,
        callIndex: index,
        requestDigest: `sha256:${String(index).repeat(64)}`,
        maximumCostUsd: 0.5,
      });
      reserveWardenModelCall(db, input);
      const settled = settleWardenModelCall(db, {
        tenantId: "tenant-a",
        jobId: job.id,
        reservationId: input.id,
        workerId: job.lease_owner!,
        leaseGeneration: job.lease_generation,
        status,
        ...(status === "succeeded"
          ? { inputTokens: 1_001, outputTokens: 200, totalTokens: 1_201, costUsd: 0.51 }
          : { errorCode: "provider_timeout" }),
        observedAt: LATER,
      });
      expect(settled).toMatchObject({
        status: status === "succeeded" ? "over_budget" : "failed",
        charged_input_tokens: 1_000,
        charged_output_tokens: 200,
        charged_total_tokens: 1_200,
        charged_cost_usd: 0.5,
      });
    }
  });

  it("conservatively settles a crashed call before an expired job can be retried", () => {
    const { db, job } = fixture();
    const input = reservation(job, { maximumCostUsd: 1.5, jobBudgetUsd: 2 });
    reserveWardenModelCall(db, input);

    expect(recoverExpiredJobs(db, AFTER_EXPIRY, "tenant-a")).toBe(1);
    expect(getWardenModelReservation(db, "tenant-a", input.id)).toMatchObject({
      status: "unknown",
      error_code: "warden_model_lease_expired",
      charged_cost_usd: 1.5,
      charged_total_tokens: 1_200,
      settled_at: AFTER_EXPIRY,
    });

    const retry = claimNextJob(db, ["agent.run"], {
      tenantId: "tenant-a",
      workerId: "worker-b",
      leaseMs: 120_000,
      now: AFTER_EXPIRY,
    });
    if (!retry) throw new Error("test retry was not claimed");
    expect(() => reserveWardenModelCall(db, reservation(retry, {
      id: "wdmodel-retry-b",
      runId: "run-b",
      callIndex: 1,
      requestDigest: `sha256:${"c".repeat(64)}`,
      maximumCostUsd: 0.51,
      jobBudgetUsd: 2,
      observedAt: "2026-08-06T12:02:02.000Z",
    }))).toThrow("warden_model_budget_exhausted");
  });

  it("conservatively settles every active call before a fenced job failure clears its lease", () => {
    const { db, job } = fixture();
    const first = reservation(job, { maximumCostUsd: 0.75 });
    const second = reservation(job, {
      id: "wdmodel-call-b",
      callIndex: 2,
      requestDigest: `sha256:${"b".repeat(64)}`,
      maximumCostUsd: 0.5,
    });
    reserveWardenModelCall(db, first);
    reserveWardenModelCall(db, second);

    expect(settleActiveWardenModelReservationsForFence(db, {
      jobId: job.id,
      workerId: job.lease_owner!,
      leaseGeneration: job.lease_generation,
      observedAt: LATER,
      errorCode: "warden_model_job_failed",
    })).toBe(2);
    expect(getWardenModelReservation(db, "tenant-a", first.id)).toMatchObject({
      status: "unknown",
      charged_cost_usd: 0.75,
      error_code: "warden_model_job_failed",
    });
    expect(getWardenModelReservation(db, "tenant-a", second.id)).toMatchObject({
      status: "unknown",
      charged_cost_usd: 0.5,
      error_code: "warden_model_job_failed",
    });
    expect(settleActiveWardenModelReservationsForFence(db, {
      jobId: job.id,
      workerId: "worker-stale",
      leaseGeneration: job.lease_generation,
      observedAt: LATER,
      errorCode: "warden_model_job_failed",
    })).toBe(0);
  });
});
