import { createHash } from "node:crypto";
import {
  enqueueJob,
  getConnectedRepositoryIdByRemote,
  getGitHubInstallationByInstallationId,
  getJob,
  getMonitoringConsumerIdForRepository,
  recordFettlerPrReviewEvent,
  type AppDb,
} from "@mendpoint/db";
import type { NormalizedWebhookAction } from "@mendpoint/github";
import { containsForbiddenPathChar } from "@mendpoint/transformer";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DELIVERY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SUPPORTED_ACTIONS = new Set(["opened", "synchronize"]);

/** Job type the worker claims to materialize the head and enqueue the run. */
export const FETTLER_PR_REVIEW_JOB_TYPE = "fettler.pr.review";

export type FettlerPrReviewDispatchPayload = Readonly<{
  tenantId: string;
  repositoryId: string;
  remoteRepositoryId: number;
  installationId: number;
  consumerId: string;
  pullRequestNumber: number;
  headSha: string;
  headRef: string | null;
  deliveryId: string;
}>;

export type FettlerPrReviewDispatchResult =
  | { status: "enqueued"; dispatchJobId: string; tenantId: string }
  | { status: "duplicate"; dispatchJobId: string; tenantId: string }
  | { status: "ignored"; reason: string }
  | { status: "refused"; reason: string };

export type FettlerPrReviewDispatchInput = Readonly<{
  db: AppDb;
  event: NormalizedWebhookAction;
  deliveryId: string;
  observedAt: string;
  /**
   * Enqueue seam. Defaults to the durable job enqueue. Injectable so a test can
   * exercise the fail-closed path where an unexpected enqueue error is recorded
   * as `failed` (distinct from a deliberate `ignored`) and rethrown.
   */
  enqueue?: (input: Readonly<{
    db: AppDb;
    jobId: string;
    payload: FettlerPrReviewDispatchPayload;
    createdAt: string;
  }>) => void;
}>;

function dispatchJobId(input: Readonly<{
  tenantId: string;
  repositoryId: string;
  pullRequestNumber: number;
  headSha: string;
}>): string {
  const hash = createHash("sha256")
    .update(
      [input.tenantId, input.repositoryId, String(input.pullRequestNumber), input.headSha].join("\0"),
      "utf8",
    )
    .digest("hex");
  return `fettler-pr-job-${hash.slice(0, 40)}`;
}

function defaultEnqueue(input: Readonly<{
  db: AppDb;
  jobId: string;
  payload: FettlerPrReviewDispatchPayload;
  createdAt: string;
}>): void {
  enqueueJob(input.db, {
    id: input.jobId,
    tenantId: input.payload.tenantId,
    type: FETTLER_PR_REVIEW_JOB_TYPE,
    payload: input.payload,
    createdAt: input.createdAt,
  });
}

/**
 * Decides how to handle an inbound customer `pull_request` (opened/synchronize)
 * webhook and records the verdict durably. Fails closed and keeps three states
 * distinguishable in the record:
 *   - `refused`  : unknown/unauthorized installation, malformed identity, or a
 *                  branch name carrying a forbidden bidi/format/invisible char.
 *   - `ignored`  : deliberately skipped (unsupported action, draft, bot author,
 *                  repository not connected, no monitoring consumer).
 *   - `enqueued` : a review dispatch job was queued (one per PR head).
 *   - `duplicate`: a dispatch job for this exact PR head already exists.
 * An unexpected enqueue failure is recorded as `failed` and rethrown, so the
 * persisted record never confuses a failure with a deliberate ignore.
 *
 * This path only ever enqueues an analysis run. It never approves, merges, or
 * pushes anything.
 */
export function dispatchFettlerPrReviewFromWebhook(
  input: FettlerPrReviewDispatchInput,
): FettlerPrReviewDispatchResult {
  const { db, event, deliveryId, observedAt } = input;
  const enqueue = input.enqueue ?? defaultEnqueue;

  const record = (
    outcome: "enqueued" | "duplicate" | "ignored" | "refused" | "failed",
    reason: string | null,
    extra?: Partial<{
      tenantId: string | null;
      installationId: string | null;
      remoteRepositoryId: string | null;
      dispatchJobId: string | null;
    }>,
  ) => {
    recordFettlerPrReviewEvent(db, {
      deliveryId,
      outcome,
      reason,
      action: event.type === "pull_request" ? event.action : null,
      pullRequestNumber:
        event.type === "pull_request" && Number.isSafeInteger(event.number) ? event.number : null,
      headSha:
        event.type === "pull_request" && event.headSha ? event.headSha : null,
      tenantId: extra?.tenantId ?? null,
      installationId:
        extra?.installationId ??
        (event.type === "pull_request" && event.installationId
          ? String(event.installationId)
          : null),
      remoteRepositoryId:
        extra?.remoteRepositoryId ??
        (event.type === "pull_request" && event.repositoryId
          ? String(event.repositoryId)
          : null),
      dispatchJobId: extra?.dispatchJobId ?? null,
      createdAt: observedAt,
    });
  };

  if (event.type !== "pull_request") {
    record("ignored", "not_pull_request");
    return { status: "ignored", reason: "not_pull_request" };
  }

  if (!SUPPORTED_ACTIONS.has(event.action)) {
    record("ignored", "unsupported_action");
    return { status: "ignored", reason: "unsupported_action" };
  }

  // Identity floor. A refused (not dropped) event for anything we cannot bind to
  // a concrete, exact PR head under a concrete installation.
  if (
    !DELIVERY.test(deliveryId) ||
    !Number.isSafeInteger(event.repositoryId) ||
    !Number.isSafeInteger(event.accountId) ||
    !Number.isSafeInteger(event.installationId) ||
    !Number.isSafeInteger(event.number) ||
    event.number < 1 ||
    !event.headSha ||
    !SHA.test(event.headSha)
  ) {
    record("refused", "identity_invalid");
    return { status: "refused", reason: "identity_invalid" };
  }

  // Untrusted payload. The branch name reaches evidence records and prompts, so
  // reject a head ref carrying a forbidden bidi/format/invisible character
  // before it is persisted or forwarded anywhere.
  if (event.headRef && containsForbiddenPathChar(event.headRef)) {
    record("refused", "forbidden_path_char");
    return { status: "refused", reason: "forbidden_path_char" };
  }

  // Verify the installation, and verify the repository against the installation
  // rather than trusting the payload's own claim.
  const installation = getGitHubInstallationByInstallationId(db, String(event.installationId));
  if (
    !installation ||
    installation.deleted_at ||
    installation.suspended_at ||
    !installation.tenant_id ||
    installation.account_id !== String(event.accountId)
  ) {
    record("refused", "installation_not_authorized", {
      tenantId: installation?.tenant_id ?? null,
    });
    return { status: "refused", reason: "installation_not_authorized" };
  }
  const tenantId = installation.tenant_id;

  const repositories = installation.repositories_json
    ? (JSON.parse(installation.repositories_json) as Array<{
        id?: number;
        owner?: string;
        name?: string;
      }>)
    : [];
  const repositoryCovered =
    installation.repository_selection === "all" ||
    repositories.some(
      (repository) =>
        repository.id === event.repositoryId &&
        repository.owner?.toLowerCase() === event.owner.toLowerCase() &&
        repository.name?.toLowerCase() === event.repo.toLowerCase(),
    );
  if (!repositoryCovered) {
    record("refused", "repository_not_authorized", { tenantId });
    return { status: "refused", reason: "repository_not_authorized" };
  }

  // Deliberate ignores on a covered repository.
  if (event.draft) {
    record("ignored", "draft", { tenantId });
    return { status: "ignored", reason: "draft" };
  }
  if (event.authorType && event.authorType.toLowerCase() === "bot") {
    record("ignored", "bot_author", { tenantId });
    return { status: "ignored", reason: "bot_author" };
  }

  // Bind the repository to a tenant-owned connected repository reached through
  // this same installation, and to the consumer that monitors it. Missing either
  // is a deliberate ignore, not a failure: nothing here is wired to review.
  const repositoryId = getConnectedRepositoryIdByRemote(db, {
    tenantId,
    remoteId: String(event.repositoryId),
    installationId: String(event.installationId),
  });
  if (!repositoryId) {
    record("ignored", "not_connected", { tenantId });
    return { status: "ignored", reason: "not_connected" };
  }
  const consumerId = getMonitoringConsumerIdForRepository(db, {
    tenantId,
    connectedRepositoryId: repositoryId,
  });
  if (!consumerId) {
    record("ignored", "not_monitored", { tenantId });
    return { status: "ignored", reason: "not_monitored" };
  }

  // Idempotency. One dispatch (and therefore one run) per exact PR head. A
  // second delivery for the same head deduplicates to the existing job. Literal
  // redeliveries of the same delivery id are already blocked upstream by the
  // shared webhook delivery dedup; this content key additionally collapses
  // distinct deliveries that describe the same head.
  const jobId = dispatchJobId({
    tenantId,
    repositoryId,
    pullRequestNumber: event.number,
    headSha: event.headSha,
  });
  if (getJob(db, jobId, tenantId)) {
    record("duplicate", "dispatch_exists", {
      tenantId,
      dispatchJobId: jobId,
    });
    return { status: "duplicate", dispatchJobId: jobId, tenantId };
  }

  const payload: FettlerPrReviewDispatchPayload = Object.freeze({
    tenantId,
    repositoryId,
    remoteRepositoryId: event.repositoryId!,
    installationId: event.installationId!,
    consumerId,
    pullRequestNumber: event.number,
    headSha: event.headSha,
    headRef: event.headRef ?? null,
    deliveryId,
  });

  try {
    enqueue({ db, jobId, payload, createdAt: observedAt });
  } catch (error) {
    record("failed", error instanceof Error ? error.message.slice(0, 200) : "enqueue_failed", {
      tenantId,
      dispatchJobId: jobId,
    });
    throw error;
  }

  record("enqueued", null, { tenantId, dispatchJobId: jobId });
  return { status: "enqueued", dispatchJobId: jobId, tenantId };
}
