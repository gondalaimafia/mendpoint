import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, getJob, type AppDb } from "@mendpoint/db";
import {
  LEARNING_OUTCOME_RESOLVE_JOB_TYPE,
  enqueueDeliveryOutcomeLearning,
} from "./delivery-outcome-learning-dispatch.js";

const TENANT = "tenant-a";
const NOW = "2026-08-06T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

afterEach(() => {
  while (opened.length) {
    const entry = opened.pop()!;
    entry.db.raw.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

function setup(): AppDb {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-outcome-dispatch-"));
  const db = createDb(join(directory, "api.sqlite"));
  opened.push({ db, directory });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES (?, ?, 'Tenant A', 'team', 'active', 10, ?)`,
  ).run(TENANT, TENANT, NOW);
  return db;
}

describe("delivery-outcome learning enqueue", () => {
  it("enqueues a resolution job carrying the lane and delivery, tenant-scoped", () => {
    const db = setup();
    const result = enqueueDeliveryOutcomeLearning({
      db, lane: "fettler", tenantId: TENANT, deliveryId: "fettler-del-1", createdAt: NOW,
    });
    expect(result.status).toBe("enqueued");
    const job = getJob(db, result.jobId, TENANT);
    expect(job?.type).toBe(LEARNING_OUTCOME_RESOLVE_JOB_TYPE);
    expect(JSON.parse(job!.payload_json)).toEqual({ lane: "fettler", deliveryId: "fettler-del-1" });
  });

  it("deduplicates: a redelivered webhook collapses to the existing job", () => {
    const db = setup();
    const first = enqueueDeliveryOutcomeLearning({
      db, lane: "regauge", tenantId: TENANT, deliveryId: "regauge-del-1", createdAt: NOW,
    });
    const second = enqueueDeliveryOutcomeLearning({
      db, lane: "regauge", tenantId: TENANT, deliveryId: "regauge-del-1", createdAt: NOW,
    });
    expect(first.status).toBe("enqueued");
    expect(second.status).toBe("duplicate");
    expect(second.jobId).toBe(first.jobId);
  });

  it("keys the job id on lane, tenant, and delivery so distinct lanes never collide", () => {
    const db = setup();
    const fettler = enqueueDeliveryOutcomeLearning({
      db, lane: "fettler", tenantId: TENANT, deliveryId: "shared-id", createdAt: NOW,
    });
    const regauge = enqueueDeliveryOutcomeLearning({
      db, lane: "regauge", tenantId: TENANT, deliveryId: "shared-id", createdAt: NOW,
    });
    expect(fettler.status).toBe("enqueued");
    expect(regauge.status).toBe("enqueued");
    expect(regauge.jobId).not.toBe(fettler.jobId);
  });
});
