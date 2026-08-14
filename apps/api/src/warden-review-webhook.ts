import {
  getGitHubInstallationByInstallationId,
  wakeWardenCiReviewObservation,
  type AppDb,
  type WardenCiReviewWakeResult,
} from "@mendpoint/db";
import type { NormalizedWebhookAction } from "@mendpoint/github";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DELIVERY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REVIEW_ACTIONS = new Set(["submitted", "edited", "dismissed"]);
const COMMENT_ACTIONS = new Set(["created", "edited", "deleted"]);

export function wakeFettlerReviewFromWebhook(input: Readonly<{
  db: AppDb;
  event: NormalizedWebhookAction;
  deliveryId: string;
  observedAt: string;
}>): WardenCiReviewWakeResult {
  const event = input.event;
  if (event.type !== "pull_request_review" ||
      !(event.source === "review" ? REVIEW_ACTIONS : COMMENT_ACTIONS).has(event.action) ||
      !DELIVERY.test(input.deliveryId) || !Number.isSafeInteger(event.repositoryId) ||
      !Number.isSafeInteger(event.accountId) || !Number.isSafeInteger(event.installationId) ||
      !Number.isSafeInteger(event.pullRequestNumber) || event.pullRequestNumber < 1 ||
      !SHA.test(event.headSha)) {
    throw new Error("warden_review_webhook_identity_invalid");
  }
  const installation = getGitHubInstallationByInstallationId(input.db, String(event.installationId));
  if (!installation || installation.deleted_at || installation.suspended_at || !installation.tenant_id ||
      installation.account_id !== String(event.accountId)) {
    throw new Error("warden_review_webhook_installation_not_authorized");
  }
  const repositories = installation.repositories_json
    ? JSON.parse(installation.repositories_json) as Array<{ id?: number; owner?: string; name?: string }>
    : [];
  if (installation.repository_selection !== "all" && !repositories.some((repository) =>
    repository.id === event.repositoryId && repository.owner?.toLowerCase() === event.owner.toLowerCase() &&
    repository.name?.toLowerCase() === event.repo.toLowerCase())) {
    throw new Error("warden_review_webhook_repository_not_authorized");
  }
  return wakeWardenCiReviewObservation(input.db, {
    tenantId: installation.tenant_id,
    remoteRepositoryId: event.repositoryId!,
    installationId: event.installationId!,
    pullRequestNumber: event.pullRequestNumber,
    headSha: event.headSha,
    wakeId: input.deliveryId,
    observedAt: input.observedAt,
  });
}
