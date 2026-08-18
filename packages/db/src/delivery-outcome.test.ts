import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type AppDb } from "./index.js";
import {
  findWardenCandidateDeliveryByPrUrl,
  getWardenCandidateDelivery,
  recordWardenCandidateDeliveryOutcome,
} from "./warden-candidate-delivery.js";
import {
  findAdaptiveDeliveryByPrUrl,
  getAdaptiveDelivery,
  recordAdaptiveDeliveryOutcome,
} from "./transformer-adaptive-delivery.js";

// The acceptance-outcome signal: once a delivered PR reaches a terminal fate on
// GitHub, that fate is recorded against the delivery that produced it. A delivery
// with no outcome yet stays pending (outcome === null), never a negative.

const NOW = "2026-08-18T12:00:00.000Z";
const LATER = "2026-08-18T13:00:00.000Z";
const LATEST = "2026-08-18T14:00:00.000Z";
const sha = (value: string) => value.repeat(40);
const digest = (value: string) => `sha256:${value.repeat(64)}`;
const FETTLER_URL = "https://github.com/acme/service/pull/17";
const REGAUGE_URL = "https://github.com/acme/service/pull/42";

const opened: Array<{ db: AppDb; directory: string }> = [];

afterEach(() => {
  while (opened.length) {
    const entry = opened.pop()!;
    entry.db.raw.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

function fixture(): AppDb {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-delivery-outcome-"));
  const db = createDb(join(directory, "test.sqlite"));
  opened.push({ db, directory });
  db.raw
    .prepare(
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?),
              ('tenant-b', 'tenant-b', 'Tenant B', 'team', 'active', 10, ?)`,
    )
    .run(NOW, NOW);
  return db;
}

/** Seed a delivered Fettler candidate delivery that opened a real PR. */
function seedFettlerDelivered(db: AppDb, overrides?: { status?: string; draftPrUrl?: string | null }): void {
  db.raw
    .prepare(
      `INSERT INTO fettler_candidate_deliveries
        (id, tenant_id, run_id, job_id, status, repository_id, snapshot_id, base_branch,
         expected_base_revision, sealed_path, sealed_sha256, requester_principal_id, rationale,
         intent_digest, branch_name, base_revision, commit_sha, draft_pr, draft_pr_number,
         draft_pr_url, requested_at, delivered_at, updated_at)
       VALUES ('fettler-del-1', 'tenant-a', 'run-a', 'job-a', ?, 'repo-a', 'snap-a', 'main', ?,
         'sealed', ?, 'principal-a', 'approved', ?, 'mendpoint/fettler-a', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      overrides?.status ?? "delivered",
      sha("a"),
      digest("b"),
      digest("c"),
      sha("a"),
      sha("d"),
      overrides?.status === "delivery_pending" ? null : 1,
      overrides?.status === "delivery_pending" ? null : 17,
      overrides?.draftPrUrl === undefined ? FETTLER_URL : overrides.draftPrUrl,
      NOW,
      overrides?.status === "delivery_pending" ? null : NOW,
      NOW,
    );
}

/** Seed a delivered Regauge adaptive delivery that opened a real PR. */
function seedRegaugeDelivered(db: AppDb): void {
  db.raw
    .prepare(
      `INSERT INTO regauge_adaptive_deliveries
        (id, tenant_id, candidate_id, job_id, status, repository_id, snapshot_id, base_branch,
         expected_base_revision, intent_digest, branch_name, base_revision, commit_sha, draft_pr,
         draft_pr_number, draft_pr_url, requester_principal_id, requested_at, intent_bound_at,
         delivered_at, updated_at)
       VALUES ('regauge-del-1', 'tenant-a', 'cand-a', 'job-r', 'delivered', 'repo-a', 'snap-a',
         'main', ?, ?, 'mendpoint/regauge-a', ?, ?, 1, 42, ?, 'principal-a', ?, ?, ?, ?)`,
    )
    .run(sha("a"), digest("e"), sha("a"), sha("f"), REGAUGE_URL, NOW, NOW, NOW, NOW);
}

describe("Fettler candidate delivery acceptance outcome", () => {
  it("resolves the delivered delivery by its durable PR URL, globally", () => {
    const db = fixture();
    seedFettlerDelivered(db);
    const resolved = findWardenCandidateDeliveryByPrUrl(db, FETTLER_URL);
    expect(resolved?.id).toBe("fettler-del-1");
    expect(resolved?.tenantId).toBe("tenant-a");
    // Unknown URL and a non-delivered row never resolve.
    expect(findWardenCandidateDeliveryByPrUrl(db, "https://github.com/acme/service/pull/999")).toBeUndefined();
  });

  it("does not resolve a delivery that never reached delivered", () => {
    const db = fixture();
    seedFettlerDelivered(db, { status: "delivery_pending", draftPrUrl: null });
    expect(findWardenCandidateDeliveryByPrUrl(db, FETTLER_URL)).toBeUndefined();
  });

  it("reads pending (never a negative) until an outcome is recorded", () => {
    const db = fixture();
    seedFettlerDelivered(db);
    // Delivered, but no webhook yet: outcome is null, distinct from any decision.
    expect(getWardenCandidateDelivery(db, "tenant-a", "fettler-del-1")?.outcome).toBeNull();
  });

  it("records a merged PR against the delivery", () => {
    const db = fixture();
    seedFettlerDelivered(db);
    const merged = recordWardenCandidateDeliveryOutcome(db, {
      tenantId: "tenant-a",
      deliveryId: "fettler-del-1",
      outcome: "merged",
      source: "github_webhook",
      observedAt: LATER,
    });
    expect(merged.outcome).toBe("merged");
    expect(merged.outcomeAt).toBe(LATER);
    expect(merged.outcomeSource).toBe("github_webhook");
    // Idempotent re-delivery of the same outcome is a no-op.
    expect(
      recordWardenCandidateDeliveryOutcome(db, {
        tenantId: "tenant-a",
        deliveryId: "fettler-del-1",
        outcome: "merged",
        source: "github_webhook",
        observedAt: LATEST,
      }).outcomeAt,
    ).toBe(LATER);
  });

  it("records a closed-unmerged PR distinctly from merged", () => {
    const db = fixture();
    seedFettlerDelivered(db);
    const closed = recordWardenCandidateDeliveryOutcome(db, {
      tenantId: "tenant-a",
      deliveryId: "fettler-del-1",
      outcome: "closed_unmerged",
      source: "github_webhook",
      observedAt: LATER,
    });
    expect(closed.outcome).toBe("closed_unmerged");
    expect(closed.outcome).not.toBe("merged");
  });

  it("records a revert after merge as reverted, not merged", () => {
    const db = fixture();
    seedFettlerDelivered(db);
    recordWardenCandidateDeliveryOutcome(db, {
      tenantId: "tenant-a",
      deliveryId: "fettler-del-1",
      outcome: "merged",
      source: "github_webhook",
      observedAt: LATER,
    });
    const reverted = recordWardenCandidateDeliveryOutcome(db, {
      tenantId: "tenant-a",
      deliveryId: "fettler-del-1",
      outcome: "reverted",
      source: "verifier",
      observedAt: LATEST,
    });
    expect(reverted.outcome).toBe("reverted");
    expect(reverted.outcome).not.toBe("merged");
    expect(reverted.outcomeAt).toBe(LATEST);
    // A reverted migration is terminal and cannot silently read back as merged.
    expect(getWardenCandidateDelivery(db, "tenant-a", "fettler-del-1")?.outcome).toBe("reverted");
  });

  it("rejects impossible transitions (revert without a merge, close after merge)", () => {
    const db = fixture();
    seedFettlerDelivered(db);
    expect(() =>
      recordWardenCandidateDeliveryOutcome(db, {
        tenantId: "tenant-a",
        deliveryId: "fettler-del-1",
        outcome: "reverted",
        source: "verifier",
        observedAt: LATER,
      }),
    ).toThrow("warden_candidate_delivery_outcome_transition_invalid");
    recordWardenCandidateDeliveryOutcome(db, {
      tenantId: "tenant-a",
      deliveryId: "fettler-del-1",
      outcome: "merged",
      source: "github_webhook",
      observedAt: LATER,
    });
    expect(() =>
      recordWardenCandidateDeliveryOutcome(db, {
        tenantId: "tenant-a",
        deliveryId: "fettler-del-1",
        outcome: "closed_unmerged",
        source: "github_webhook",
        observedAt: LATEST,
      }),
    ).toThrow("warden_candidate_delivery_outcome_transition_invalid");
  });

  it("denies a cross-tenant outcome write and leaves the row pending", () => {
    const db = fixture();
    seedFettlerDelivered(db);
    expect(() =>
      recordWardenCandidateDeliveryOutcome(db, {
        tenantId: "tenant-b",
        deliveryId: "fettler-del-1",
        outcome: "merged",
        source: "github_webhook",
        observedAt: LATER,
      }),
    ).toThrow("warden_candidate_delivery_outcome_not_found");
    expect(getWardenCandidateDelivery(db, "tenant-a", "fettler-del-1")?.outcome).toBeNull();
  });
});

describe("Regauge adaptive delivery acceptance outcome", () => {
  it("resolves the delivered delivery by its durable PR URL, globally", () => {
    const db = fixture();
    seedRegaugeDelivered(db);
    const resolved = findAdaptiveDeliveryByPrUrl(db, REGAUGE_URL);
    expect(resolved?.id).toBe("regauge-del-1");
    expect(resolved?.tenantId).toBe("tenant-a");
    expect(findAdaptiveDeliveryByPrUrl(db, "https://github.com/acme/service/pull/999")).toBeUndefined();
  });

  it("reads pending until an outcome is recorded, then records merged", () => {
    const db = fixture();
    seedRegaugeDelivered(db);
    expect(getAdaptiveDelivery(db, "tenant-a", "regauge-del-1")?.outcome).toBeNull();
    const merged = recordAdaptiveDeliveryOutcome(db, {
      tenantId: "tenant-a",
      deliveryId: "regauge-del-1",
      outcome: "merged",
      source: "github_webhook",
      observedAt: LATER,
    });
    expect(merged.outcome).toBe("merged");
    expect(merged.outcomeAt).toBe(LATER);
  });

  it("records closed-unmerged distinctly and a revert after merge as reverted", () => {
    const db = fixture();
    seedRegaugeDelivered(db);
    const closed = recordAdaptiveDeliveryOutcome(db, {
      tenantId: "tenant-a",
      deliveryId: "regauge-del-1",
      outcome: "closed_unmerged",
      source: "github_webhook",
      observedAt: LATER,
    });
    expect(closed.outcome).toBe("closed_unmerged");

    const db2 = fixture();
    seedRegaugeDelivered(db2);
    recordAdaptiveDeliveryOutcome(db2, {
      tenantId: "tenant-a",
      deliveryId: "regauge-del-1",
      outcome: "merged",
      source: "github_webhook",
      observedAt: LATER,
    });
    const reverted = recordAdaptiveDeliveryOutcome(db2, {
      tenantId: "tenant-a",
      deliveryId: "regauge-del-1",
      outcome: "reverted",
      source: "verifier",
      observedAt: LATEST,
    });
    expect(reverted.outcome).toBe("reverted");
    expect(reverted.outcome).not.toBe("merged");
  });

  it("denies a cross-tenant outcome write and leaves the row pending", () => {
    const db = fixture();
    seedRegaugeDelivered(db);
    expect(() =>
      recordAdaptiveDeliveryOutcome(db, {
        tenantId: "tenant-b",
        deliveryId: "regauge-del-1",
        outcome: "merged",
        source: "github_webhook",
        observedAt: LATER,
      }),
    ).toThrow("transformer_adaptive_delivery_outcome_not_found");
    expect(getAdaptiveDelivery(db, "tenant-a", "regauge-del-1")?.outcome).toBeNull();
  });
});
