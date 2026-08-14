import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, enqueueWardenCiCycle, recordWardenCiObservation, upsertGitHubInstallation, type AppDb } from "@mendpoint/db";
import type { NormalizedWebhookAction } from "@mendpoint/github";
import { wakeFettlerReviewFromWebhook } from "./warden-review-webhook.js";

const opened: Array<{ db: AppDb; root: string }> = [];
const sha = (value: string) => value.repeat(40);
const digest = (value: string) => `sha256:${value.repeat(64)}`;
afterEach(() => { for (const value of opened.splice(0)) { value.db.raw.close(); rmSync(value.root, { recursive: true, force: true }); } });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-review-webhook-"));
  const db = createDb(join(root, "api.sqlite")); opened.push({ db, root });
  upsertGitHubInstallation(db, { id: "install-a", installationId: "202", accountId: "303",
    accountLogin: "acme", tenantId: "tenant-a", repositorySelection: "selected",
    repositories: [{ id: 101, owner: "acme", name: "service" }], createdAt: "2026-08-14T12:00:00.000Z",
    updatedAt: "2026-08-14T12:00:00.000Z" });
  db.raw.prepare(`INSERT INTO fettler_candidate_deliveries
    (id, tenant_id, run_id, job_id, status, repository_id, snapshot_id, base_branch,
     expected_base_revision, sealed_path, sealed_sha256, requester_principal_id, rationale,
     intent_digest, branch_name, base_revision, commit_sha, draft_pr, draft_pr_number,
     draft_pr_url, requested_at, delivered_at, updated_at)
    VALUES ('delivery-a', 'tenant-a', 'run-a', 'job-a', 'delivered', 'repo-a', 'snapshot-a',
      'main', ?, 'sealed', ?, 'principal-a', 'approved', ?, 'mendpoint/fettler-a', ?, ?, 1, 17,
      'https://github.com/acme/service/pull/17', ?, ?, ?)`)
    .run(sha("a"), digest("b"), digest("c"), sha("a"), sha("d"),
      "2026-08-14T12:00:00.000Z", "2026-08-14T12:00:30.000Z", "2026-08-14T12:00:30.000Z");
  const cycle = enqueueWardenCiCycle(db, { tenantId: "tenant-a", deliveryId: "delivery-a", repositoryId: "repo-a",
    remoteRepositoryId: 101, installationId: 202, requiredChecks: ["check:77:unit"],
    allowedChangedPaths: ["src/a.ts"], maxCycles: 3, maxModelCalls: 4, maximumCostUsd: 1,
    observedAt: "2026-08-14T12:00:00.000Z" });
  recordWardenCiObservation(db, { tenantId: "tenant-a", cycleId: cycle.id, headSha: sha("d"), verdict: "success",
    observationDigest: digest("e"), evidenceArtifactId: "artifact-a", evidenceDigest: digest("f"),
    observedAt: "2026-08-14T12:01:00.000Z" });
  const event: NormalizedWebhookAction = { type: "pull_request_review", source: "review", action: "submitted",
    owner: "acme", repo: "service", repositoryId: 101, accountId: 303, installationId: 202,
    pullRequestNumber: 17, headSha: sha("d"), sourceId: 71 };
  return { db, cycle, event };
}

describe("Fettler review webhook wake", () => {
  it("derives the tenant from an active exact installation and wakes once", () => {
    const { db, cycle, event } = fixture();
    expect(wakeFettlerReviewFromWebhook({ db, event, deliveryId: "delivery-review-1",
      observedAt: "2026-08-14T12:02:00.000Z" })).toMatchObject({ status: "woken", cycle: { id: cycle.id } });
    expect(wakeFettlerReviewFromWebhook({ db, event, deliveryId: "delivery-review-1",
      observedAt: "2026-08-14T12:02:01.000Z" })).toMatchObject({ status: "already_active" });
  });

  it.each([
    { repositoryId: 102 }, { accountId: 304 }, { installationId: 203 },
  ])("does not cross an exact authority boundary %#", (change) => {
    const { db, event } = fixture();
    expect(() => wakeFettlerReviewFromWebhook({ db, event: { ...event, ...change } as NormalizedWebhookAction,
      deliveryId: "delivery-review-2", observedAt: "2026-08-14T12:02:00.000Z" })).toThrow();
  });

  it.each([{ pullRequestNumber: 18 }, { headSha: sha("c") }])(
    "ignores a stale pull request identity %#", (change) => {
      const { db, event } = fixture();
      expect(wakeFettlerReviewFromWebhook({ db, event: { ...event, ...change } as NormalizedWebhookAction,
        deliveryId: "delivery-review-3", observedAt: "2026-08-14T12:02:00.000Z" }))
        .toEqual({ status: "not_found", cycle: null });
    });
});
