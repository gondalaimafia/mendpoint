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
  assertNoTenantIdentity,
  TENANT_IDENTITY_DELIVERY_ERROR,
  type GitHubDelivery,
  type AdoptiveDraftResult,
} from "@mendpoint/github";
import { isValidGitBranchName } from "@mendpoint/generation";
import { renderPublicPrIdentity } from "./public-pr-identity.js";

/** Public-identity re-render options for a retry: the configured repos root and
 * the consumer's public owner/repo, so a legacy checkout path becomes owner/repo. */
function retryPublicIdentityOptions(
  consumer: Readonly<{ github_owner: string; github_repo: string }>,
): { reposDir: string | null; ownerRepo: string } {
  return {
    reposDir: process.env.MENDPOINT_REPOS_DIR?.trim() || null,
    ownerRepo: `${consumer.github_owner}/${consumer.github_repo}`,
  };
}

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
  /**
   * The originating fanout job's gate payload (reservation keys stripped), stored
   * on the row (insert only) so a delivery-only retry that must fall back to a full
   * pipeline run replays the SAME gate inputs for the SAME change. null outside a fanout.
   */
  originFanoutJson?: string | null;
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
      originFanoutJson: params.originFanoutJson ?? null,
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
    // Fail closed per consumer on an unpushable branch (e.g. a legacy shared slug with a
    // git-invalid character): a named, non-retryable delivery_blocked, NOT a thrown crash of the
    // whole pipeline run. Analysis and findings are already persisted before this call.
    if (!isValidGitBranchName(params.branchName)) {
      throw new AdoptiveDraftBlockedError("branch_name_invalid");
    }
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
      // The adoptive transport carries the fail-closed guard (#724) on its wrapped
      // octokit; this legacy path builds the branch/commit/PR through the shared
      // GitHubDelivery methods, so guard the same customer-facing strings here —
      // the lowest choke point this path passes through before any API write.
      assertNoTenantIdentity(
        params.tenantId,
        "content_manifest",
        [
          { kind: "title", value: params.title },
          { kind: "body", value: params.body },
          { kind: "branch", value: params.branchName },
          { kind: "commit", value: params.title },
          ...params.files.flatMap((f) => [
            { kind: "file" as const, value: f.path },
            { kind: "file" as const, value: f.content },
          ]),
        ],
        () => new AdoptiveDraftBlockedError(TENANT_IDENTITY_DELIVERY_ERROR),
      );
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
          // #724: threads the fail-closed tenant-identity guard onto the adoptive
          // transport so every customer-facing write is refused if it carries the id.
          tenantId: params.tenantId,
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
  /**
   * True when the row is still retryable but no write-ahead artifact exists (the
   * outage hit before the commit was built), so a delivery-only replay is
   * impossible and the caller must fall back to a full pipeline run for the
   * change. `changeId`/`consumerId` identify that change. Distinct from the plain
   * retried:false cases (not found, already terminal), which need no fallback.
   */
  fallbackToPipeline?: boolean;
  changeId?: string;
  consumerId?: string;
  /** The row's persisted originating fanout gate payload (reservation-stripped), so
   * the caller replays the same gates when it falls back to a full pipeline run. */
  originFanoutJson?: string | null;
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
  // failure or a content-manifest repo). Delivery-only cannot reconstruct it, so
  // signal the caller to fall back to a full pipeline run for the change (bounded
  // by the same 7-day cap enforced above). This is distinct from the plain
  // retried:false returns (not found, already terminal), which need no fallback.
  if (!artifact || !artifact.filesJson) {
    return Object.freeze({
      retried: false,
      fallbackToPipeline: true,
      changeId: pr.change_id,
      consumerId: consumer.id,
      originFanoutJson: (pr as { origin_fanout_json?: string | null }).origin_fanout_json ?? null,
      status: pr.status,
      prNumber: pr.github_pr_number ?? null,
      prUrl: pr.github_pr_url ?? null,
      deliveryError: null,
    });
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
    // #724: a main-era artifact stored the tenant id and server checkout path in
    // its title/body. Re-project them to public identity at retry time rather than
    // re-sending the pre-upgrade text. Adoption identity is the commit trailer/tree
    // and the branch — never the body bytes — so re-rendering the body is safe and
    // ADOPT converges it. The branch is the delivery identity and is left as-is; if
    // it somehow carried the id the fail-closed guard blocks the write. The server
    // checkout path is rewritten to the public owner/repo (#724 should-fix).
    title: renderPublicPrIdentity(artifact.title, tenantId, retryPublicIdentityOptions(consumer)),
    risk: pr.risk,
    patch: pr.patch_unified,
    body: renderPublicPrIdentity(artifact.body, tenantId, retryPublicIdentityOptions(consumer)),
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
