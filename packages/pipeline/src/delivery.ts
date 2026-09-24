/**
 * Consumer draft delivery (PR #606 redesign, extracted from runChangePipeline).
 *
 * Covers the whole delivery lifecycle for one consumer, from the pre-delivery
 * write (D1 CAS) through recording the adopted PR. The GitHub branch is the
 * source of truth: git-backed repositories deliver through the adoptive state
 * machine (one branch, one ledger operation, lookup L every attempt), and a
 * repository with no git history keeps main's legacy create/commit/open path.
 *
 * There is NO re-anchoring, retirement, anchor persistence or body replay: a
 * retry re-runs delivery from the persisted write-ahead artifact and the current
 * body, and ADOPT converges the PR body when the head is still ours.
 */
import { createHash } from "node:crypto";
import {
  insertMigrationPr,
  updateMigrationPrDelivery,
  updateMigrationPrStatus,
  persistDeliveryArtifact,
  hasDeliveryArtifactByContent,
  getLatestDeliveryArtifact,
  getPr,
  getConsumer,
  getConsumerRepo,
  type AppDb,
} from "@mendpoint/db";
import {
  AdoptiveDraftBlockedError,
  type GitHubDelivery,
  type AdoptiveDraftResult,
} from "@mendpoint/github";

/** ~7-day cap on retrying a stuck delivery before it abandons (D10). */
export const GITHUB_DELIVERY_ABANDON_AFTER_MS = 7 * 24 * 60 * 60 * 1_000;

/** Content-shape key for a write-ahead artifact: unique per (delivery key, tree, parent). */
export function deliveryArtifactDigest(deliveryKey: string, treeSha: string, parentSha: string): string {
  return createHash("sha256").update(`${deliveryKey}\u0000${treeSha}\u0000${parentSha}`).digest("hex");
}

export type DeliveryResolution = {
  delivery: GitHubDelivery;
  githubRepositoryId?: string;
  githubInstallationId?: string;
  githubAccountId?: string;
  assertRepositoryIdentity?: () => Promise<void>;
};

export type DeliverConsumerDraftParams = Readonly<{
  db: AppDb;
  tenantId: string;
  prId: string;
  changeId: string;
  /** Whether a retryable migration_pr row already exists (update vs insert). */
  isRetry: boolean;
  consumer: Readonly<{ id: string; github_owner: string; github_repo: string }>;
  defaultBranch: string;
  /** Delivery identity K = change:consumer, bound into the commit trailer. */
  deliveryKey: string;
  /**
   * The delivery branch. For a retry it is the row's STORED branch_name, so a
   * main-era row (mendpoint/<slug>-<Date.now()>) delivers on its own branch and
   * adopts the PR already there rather than opening a duplicate (D8); a fresh row
   * uses the deterministic branch.
   */
  branchName: string;
  title: string;
  risk: string;
  patch: string;
  /** The fully assembled, length-bounded PR body for this attempt. */
  body: string;
  files: ReadonlyArray<{ path: string; content: string }>;
  /** Base = refreshedHeadSha ?? resolvedSha (git_commit); null for a non-delivery. */
  baseSha: string | null;
  commitDate: string | null;
  revisionKind: "git_commit" | "content_manifest" | null;
  shouldDeliver: boolean;
  /** The terminal status when shouldDeliver is false (low_confidence, gates_failed, ...). */
  terminalStatus: string;
  coverageJson: string | null;
  createdAt: string;
  existingPrNumber: number | null;
  existingPrUrl: string | null;
  /** Resolve the delivery transport; called inside the delivery try so a resolver
   * error (mode mismatch, unauthorized repo, ...) becomes a retryable delivery_failed. */
  resolveDelivery: () => DeliveryResolution;
  assertActive: () => void;
}>;

export type DeliverConsumerDraftResult = Readonly<{
  status: string;
  prNumber: number | null;
  prUrl: string | null;
  deliveryError: string | null;
}>;

function persistRow(params: DeliverConsumerDraftParams, status: string): void {
  if (params.isRetry) {
    updateMigrationPrDelivery(params.db, params.prId, { status, body: params.body });
  } else {
    insertMigrationPr(params.db, {
      id: params.prId,
      changeId: params.changeId,
      consumerId: params.consumer.id,
      title: params.title,
      body: params.body,
      branchName: params.branchName,
      status,
      risk: params.risk,
      patchUnified: params.patch,
      githubPrNumber: params.existingPrNumber,
      githubPrUrl: params.existingPrUrl,
      createdAt: params.createdAt,
      resolvedAt: null,
      coverageJson: params.coverageJson,
    });
  }
}

/**
 * Deliver (or record) one consumer's draft. Persists the migration_pr row first
 * (the pre-delivery write is CAS-guarded so it can never downgrade a recorded
 * draft), then, when shouldDeliver, delivers and records the adopted PR facts.
 */
export async function deliverConsumerDraft(
  params: DeliverConsumerDraftParams,
): Promise<DeliverConsumerDraftResult> {
  const { db, prId, consumer } = params;

  // Pre-delivery write (D1 CAS): delivery_pending while delivering, else terminal.
  persistRow(params, params.shouldDeliver ? "delivery_pending" : params.terminalStatus);
  if (!params.shouldDeliver) {
    return Object.freeze({
      status: params.terminalStatus,
      prNumber: params.existingPrNumber,
      prUrl: params.existingPrUrl,
      deliveryError: null,
    });
  }

  params.assertActive();
  try {
    if (!params.baseSha || !params.commitDate || !params.revisionKind) {
      throw new Error("github_exact_draft_evidence_missing");
    }
    const resolution = params.resolveDelivery();
    await resolution.assertRepositoryIdentity?.();
    updateMigrationPrDelivery(db, prId, {
      status: "delivery_pending",
      body: params.body,
      ...(resolution.githubRepositoryId ? { githubRepositoryId: resolution.githubRepositoryId } : {}),
      ...(resolution.githubInstallationId ? { githubInstallationId: resolution.githubInstallationId } : {}),
      ...(resolution.githubAccountId ? { githubAccountId: resolution.githubAccountId } : {}),
    });

    let recorded: { prNumber: number; prUrl: string; status: string; deliveredBaseSha: string | null; deliveredHeadSha: string | null };
    if (params.revisionKind === "content_manifest") {
      // No git history: keep main's legacy create/commit/open path (no adoption).
      const github = resolution.delivery;
      await github.createBranch(consumer.github_owner, consumer.github_repo, params.branchName, params.defaultBranch);
      params.assertActive();
      await github.commitFiles(
        consumer.github_owner,
        consumer.github_repo,
        params.branchName,
        params.title,
        params.files.map((f) => ({ path: f.path, content: f.content })),
      );
      params.assertActive();
      const pr = await github.openPullRequest(
        consumer.github_owner,
        consumer.github_repo,
        params.branchName,
        params.title,
        params.body,
        params.defaultBranch,
      );
      recorded = { prNumber: pr.number, prUrl: pr.url, status: "draft", deliveredBaseSha: null, deliveredHeadSha: null };
    } else {
      if (typeof resolution.delivery.deliverAdoptiveDraft !== "function") {
        throw new Error("github_delivery_adoptive_unsupported");
      }
      const result: AdoptiveDraftResult = await resolution.delivery.deliverAdoptiveDraft(
        {
          owner: consumer.github_owner,
          repo: consumer.github_repo,
          baseBranch: params.defaultBranch,
          expectedBaseSha: params.baseSha,
          branch: params.branchName,
          deliveryKey: params.deliveryKey,
          title: params.title,
          commitDate: params.commitDate,
          files: params.files.map((f) => ({ path: f.path, content: f.content, mode: "100644" as const })),
        },
        {
          resolveBody: () => params.body,
          hooks: {
            persistArtifact: (artifact) => {
              persistDeliveryArtifact(db, {
                tenantId: params.tenantId,
                // Key by the commit SHAPE (delivery key + tree + parent), not the
                // body digest: the body is identical across attempts, so keying by
                // it would (with ON CONFLICT DO NOTHING) never store the (tree,
                // parent) of a later attempt built on a moved base — and ours()
                // would then judge our own commit foreign. Each shape is its own row.
                artifactDigest: deliveryArtifactDigest(artifact.deliveryKey, artifact.treeSha, artifact.parentSha),
                deliveryKey: artifact.deliveryKey,
                title: artifact.title,
                body: artifact.body,
                treeSha: artifact.treeSha,
                parentSha: artifact.parentSha,
                // The file edits, so a delivery-only retry (D10) reconstructs the
                // whole delivery from the artifact without re-analysing.
                filesJson: JSON.stringify(params.files.map((f) => ({ path: f.path, content: f.content }))),
                createdAt: params.commitDate!,
              });
            },
            // Recognise our own commit from a prior attempt after the base moved:
            // its (tree, parent) matches a persisted artifact for this delivery.
            isOursArtifact: (content) =>
              hasDeliveryArtifactByContent(db, params.tenantId, params.deliveryKey, content.treeSha, content.parentSha),
          },
        },
      );
      const status = result.state === "merged" ? "merged" : result.state === "closed" ? "closed" : "draft";
      recorded = {
        prNumber: result.number,
        prUrl: result.url,
        status,
        deliveredBaseSha: result.state === "draft" ? result.deliveredBaseSha : null,
        deliveredHeadSha: result.state === "draft" ? result.deliveredHeadSha : null,
      };
    }
    params.assertActive();
    updateMigrationPrDelivery(db, prId, {
      status: recorded.status,
      githubPrNumber: recorded.prNumber,
      githubPrUrl: recorded.prUrl,
      body: params.body,
      ...(recorded.deliveredBaseSha ? { deliveredBaseSha: recorded.deliveredBaseSha } : {}),
      ...(recorded.deliveredHeadSha ? { deliveredHeadSha: recorded.deliveredHeadSha } : {}),
    });
    return Object.freeze({
      status: recorded.status,
      prNumber: recorded.prNumber,
      prUrl: recorded.prUrl,
      deliveryError: null,
    });
  } catch (error) {
    // A blocked delivery needs a human action on GitHub (foreign branch, ambiguous
    // or wrong-base PR, ...): record delivery_blocked with the named code, reported
    // not thrown. Everything else is a retryable delivery_failed; there is no
    // re-anchoring or retirement. Both writes are CAS-guarded (no PR number), so
    // neither can downgrade a draft another worker already recorded.
    const blocked = error instanceof AdoptiveDraftBlockedError ||
      (error as { blocked?: unknown } | null)?.blocked === true;
    const status = blocked ? "delivery_blocked" : "delivery_failed";
    const deliveryError = blocked && (error as { code?: string }).code
      ? (error as { code: string }).code
      : error instanceof Error ? error.message : String(error);
    updateMigrationPrDelivery(db, prId, { status });
    return Object.freeze({ status, prNumber: null, prUrl: null, deliveryError });
  }
}

export type RetryConsumerDeliveryInput = Readonly<{
  db: AppDb;
  tenantId: string;
  prId: string;
  /** Resolve the transport for the loaded consumer/repo (worker wires the App resolver). */
  deliveryFor: (
    consumer: Readonly<{
      installation_id: string | null;
      github_delivery_mode: "app" | "legacy_pat" | "revoked";
      github_owner: string;
      github_repo: string;
    }>,
    repo?: Readonly<{ scm_connection_id: string | null; connected_repository_id: string | null }>,
  ) => DeliveryResolution;
  /** The refreshed remote default head, when the worker refreshed the clone; else the artifact base. */
  refreshedHeadSha?: string | null;
  now: string;
}>;

export type RetryConsumerDeliveryResult = Readonly<{
  /** Whether a delivery-only retry ran (false when there is nothing to retry or no artifact). */
  retried: boolean;
  status: string;
  prNumber: number | null;
  prUrl: string | null;
  deliveryError: string | null;
}>;

/**
 * Delivery-only retry (PR #606 D10): re-run ONLY the adoptive delivery for a
 * failed/blocked migration_pr from its persisted write-ahead artifact — no
 * re-analysis, no regeneration. Enforces the ~7-day age cap into a terminal
 * github_delivery_abandoned. Returns retried:false (so the caller may fall back to
 * a full pipeline run) when the row is not retryable or never anchored an artifact.
 */
export async function retryConsumerDelivery(
  input: RetryConsumerDeliveryInput,
): Promise<RetryConsumerDeliveryResult> {
  const { db, tenantId, prId, now } = input;
  const pr = getPr(db, prId, tenantId);
  if (!pr) return Object.freeze({ retried: false, status: "not_found", prNumber: null, prUrl: null, deliveryError: null });
  if (pr.status !== "delivery_failed" && pr.status !== "delivery_blocked") {
    return Object.freeze({ retried: false, status: pr.status, prNumber: pr.github_pr_number ?? null, prUrl: pr.github_pr_url ?? null, deliveryError: null });
  }
  // 7-day age cap: abandon into a visible terminal state the operator can reopen.
  if (Number.isFinite(Date.parse(pr.created_at)) &&
      Date.parse(now) - Date.parse(pr.created_at) > GITHUB_DELIVERY_ABANDON_AFTER_MS) {
    updateMigrationPrStatus(db, prId, "github_delivery_abandoned", null);
    return Object.freeze({ retried: true, status: "github_delivery_abandoned", prNumber: null, prUrl: null, deliveryError: "github_delivery_abandoned" });
  }
  const consumer = getConsumer(db, pr.consumer_id, tenantId);
  const repo = consumer ? getConsumerRepo(db, consumer.id, tenantId) : undefined;
  if (!consumer || !repo) {
    return Object.freeze({ retried: false, status: pr.status, prNumber: pr.github_pr_number ?? null, prUrl: pr.github_pr_url ?? null, deliveryError: null });
  }
  const deliveryKey = `${pr.change_id}:${pr.consumer_id}`;
  const artifact = getLatestDeliveryArtifact(db, tenantId, deliveryKey);
  // No artifact means delivery never reached the commit build (e.g. a base-refresh
  // failure or a content-manifest repo). Delivery-only cannot reconstruct it; the
  // caller falls back to a full pipeline run.
  if (!artifact || !artifact.filesJson) {
    return Object.freeze({ retried: false, status: pr.status, prNumber: pr.github_pr_number ?? null, prUrl: pr.github_pr_url ?? null, deliveryError: null });
  }
  const files = JSON.parse(artifact.filesJson) as Array<{ path: string; content: string }>;
  const outcome = await deliverConsumerDraft({
    db,
    tenantId,
    prId,
    changeId: pr.change_id,
    isRetry: true,
    consumer: { id: consumer.id, github_owner: consumer.github_owner, github_repo: consumer.github_repo },
    defaultBranch: (repo as { default_branch?: string }).default_branch ?? "main",
    deliveryKey,
    // The row's stored branch (D8) — a main-era branch is adopted, not duplicated.
    branchName: pr.branch_name,
    title: artifact.title,
    risk: pr.risk,
    patch: pr.patch_unified,
    // Reuse the artifact's body (the persisted delivery), not a regenerated one.
    body: artifact.body,
    files,
    // Base = the refreshed remote head when available, else the artifact's base.
    baseSha: input.refreshedHeadSha ?? artifact.parentSha,
    commitDate: pr.created_at,
    revisionKind: "git_commit",
    shouldDeliver: true,
    terminalStatus: pr.status,
    coverageJson: null,
    createdAt: pr.created_at,
    existingPrNumber: pr.github_pr_number ?? null,
    existingPrUrl: pr.github_pr_url ?? null,
    resolveDelivery: () => input.deliveryFor(consumer, repo),
    assertActive: () => {},
  });
  return Object.freeze({
    retried: true,
    status: outcome.status,
    prNumber: outcome.prNumber,
    prUrl: outcome.prUrl,
    deliveryError: outcome.deliveryError,
  });
}
