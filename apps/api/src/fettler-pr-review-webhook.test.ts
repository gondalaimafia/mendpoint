import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getFettlerPrReviewEvent,
  getJob,
  upsertGitHubInstallation,
  type AppDb,
} from "@mendpoint/db";
import type { NormalizedWebhookAction } from "@mendpoint/github";
import {
  dispatchFettlerPrReviewFromWebhook,
  FETTLER_PR_REVIEW_JOB_TYPE,
} from "./fettler-pr-review-webhook.js";

const opened: Array<{ db: AppDb; root: string }> = [];
const sha = (value: string) => value.repeat(40);
const NOW = "2026-08-21T12:00:00.000Z";

afterEach(() => {
  for (const value of opened.splice(0)) {
    value.db.raw.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});

function countDispatchJobs(db: AppDb): number {
  const row = db.raw
    .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE type = ?`)
    .get(FETTLER_PR_REVIEW_JOB_TYPE) as { count: number };
  return Number(row.count);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-pr-review-webhook-"));
  const db = createDb(join(root, "api.sqlite"));
  opened.push({ db, root });
  upsertGitHubInstallation(db, {
    id: "install-a",
    installationId: "202",
    accountId: "303",
    accountLogin: "acme",
    tenantId: "tenant-a",
    repositorySelection: "selected",
    repositories: [{ id: 101, owner: "acme", name: "service" }],
    createdAt: NOW,
    updatedAt: NOW,
  });
  db.raw
    .prepare(
      `INSERT INTO scm_connections
         (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
       VALUES ('scm-a', 'tenant-a', 'github', 'cred-a', '202', 'acme', ?, ?)`,
    )
    .run(NOW, NOW);
  db.raw
    .prepare(
      `INSERT INTO connected_repositories
         (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
          environment, retention_days, status, created_at, updated_at)
       VALUES ('repo-a', 'tenant-a', 'scm-a', '101', 'acme', 'service', 'main', 'main',
          'production', 30, 'ready', ?, ?)`,
    )
    .run(NOW, NOW);
  db.raw
    .prepare(
      `INSERT INTO consumers
         (id, name, github_owner, github_repo, installation_id, github_delivery_mode, tenant_id, created_at)
       VALUES ('consumer-a', 'Acme service', 'acme', 'service', '202', 'app', 'tenant-a', ?)`,
    )
    .run(NOW);
  db.raw
    .prepare(
      `INSERT INTO consumer_repos
         (id, consumer_id, local_path, default_branch, connected_repository_id, created_at)
       VALUES ('crp-a', 'consumer-a', '/repos/acme/service', 'main', 'repo-a', ?)`,
    )
    .run(NOW);
  const event: NormalizedWebhookAction = {
    type: "pull_request",
    action: "opened",
    owner: "acme",
    repo: "service",
    repositoryId: 101,
    accountId: 303,
    installationId: 202,
    number: 42,
    merged: false,
    state: "open",
    title: "Add feature",
    htmlUrl: "https://github.com/acme/service/pull/42",
    headRef: "feature/x",
    headSha: sha("d"),
    baseRef: "main",
    draft: false,
    labels: [],
  };
  return { db, event, root };
}

describe("Fettler PR review webhook dispatch", () => {
  it("enqueues exactly one dispatch for an opened PR on a covered repository", () => {
    const { db, event } = fixture();
    const result = dispatchFettlerPrReviewFromWebhook({
      db,
      event,
      deliveryId: "delivery-1",
      observedAt: NOW,
    });
    expect(result.status).toBe("enqueued");
    if (result.status !== "enqueued") throw new Error("unreachable");
    expect(getJob(db, result.dispatchJobId, "tenant-a")).toBeTruthy();
    expect(countDispatchJobs(db)).toBe(1);
    const record = getFettlerPrReviewEvent(db, "delivery-1");
    expect(record?.outcome).toBe("enqueued");
    expect(record?.tenant_id).toBe("tenant-a");
    expect(record?.dispatch_job_id).toBe(result.dispatchJobId);
    // The dispatch payload only carries identity; nothing that could merge,
    // approve, or push.
    const job = getJob(db, result.dispatchJobId, "tenant-a")!;
    const payload = job.payload_json.toLowerCase();
    expect(payload).not.toContain("merge");
    expect(payload).not.toContain("approve");
    expect(payload).not.toContain("push");
  });

  it("deduplicates a second delivery describing the same PR head to no new run", () => {
    const { db, event } = fixture();
    const first = dispatchFettlerPrReviewFromWebhook({ db, event, deliveryId: "delivery-1", observedAt: NOW });
    expect(first.status).toBe("enqueued");
    const second = dispatchFettlerPrReviewFromWebhook({
      db,
      event,
      deliveryId: "delivery-2",
      observedAt: "2026-08-21T12:01:00.000Z",
    });
    expect(second.status).toBe("duplicate");
    expect(countDispatchJobs(db)).toBe(1);
    expect(getFettlerPrReviewEvent(db, "delivery-2")?.outcome).toBe("duplicate");
  });

  it("refuses and records an event from an unknown installation, never silently dropping it", () => {
    const { db, event } = fixture();
    const result = dispatchFettlerPrReviewFromWebhook({
      db,
      event: { ...event, installationId: 999 } as NormalizedWebhookAction,
      deliveryId: "delivery-unknown",
      observedAt: NOW,
    });
    expect(result).toEqual({ status: "refused", reason: "installation_not_authorized" });
    expect(countDispatchJobs(db)).toBe(0);
    expect(getFettlerPrReviewEvent(db, "delivery-unknown")?.outcome).toBe("refused");
  });

  it("distinguishes a deliberately ignored event from a processing failure in the record", () => {
    const { db, event } = fixture();
    const ignored = dispatchFettlerPrReviewFromWebhook({
      db,
      event: { ...event, draft: true } as NormalizedWebhookAction,
      deliveryId: "delivery-draft",
      observedAt: NOW,
    });
    expect(ignored).toEqual({ status: "ignored", reason: "draft" });
    expect(getFettlerPrReviewEvent(db, "delivery-draft")?.outcome).toBe("ignored");
    expect(countDispatchJobs(db)).toBe(0);

    const boom = new Error("enqueue exploded");
    expect(() =>
      dispatchFettlerPrReviewFromWebhook({
        db,
        event,
        deliveryId: "delivery-fail",
        observedAt: NOW,
        enqueue: () => {
          throw boom;
        },
      }),
    ).toThrow(boom);
    const failed = getFettlerPrReviewEvent(db, "delivery-fail");
    expect(failed?.outcome).toBe("failed");
    // The two states are not interchangeable in the record.
    expect(failed?.outcome).not.toBe(getFettlerPrReviewEvent(db, "delivery-draft")?.outcome);
    expect(countDispatchJobs(db)).toBe(0);
  });

  it("rejects a head branch carrying a bidi/format control character", () => {
    const { db, event } = fixture();
    const result = dispatchFettlerPrReviewFromWebhook({
      db,
      event: { ...event, headRef: "feature/‮gnp.js" } as NormalizedWebhookAction,
      deliveryId: "delivery-bidi",
      observedAt: NOW,
    });
    expect(result).toEqual({ status: "refused", reason: "forbidden_path_char" });
    expect(countDispatchJobs(db)).toBe(0);
    expect(getFettlerPrReviewEvent(db, "delivery-bidi")?.outcome).toBe("refused");
  });

  it("ignores a repository the installation does not cover", () => {
    const { db, event } = fixture();
    const result = dispatchFettlerPrReviewFromWebhook({
      db,
      event: { ...event, repositoryId: 999 } as NormalizedWebhookAction,
      deliveryId: "delivery-uncovered",
      observedAt: NOW,
    });
    expect(result).toEqual({ status: "refused", reason: "repository_not_authorized" });
    expect(countDispatchJobs(db)).toBe(0);
  });
});
