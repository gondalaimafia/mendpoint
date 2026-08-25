/**
 * Production activation for Fettler campaign-execute jobs.
 *
 * Two complementary seams:
 * - `enqueueReadyWardenCampaignTargets` — the production enqueuer for
 *   `warden.campaign.execute-target` (E1).
 * - `productionCampaignResolveDependencies` — per-tenant Change Graph handle
 *   for `run-service` (E2). Never opens an in-memory graph and never creates a
 *   missing GRAPH_LEARN_DB file.
 */
import { createHash } from "node:crypto";
import {
  claimReadyWardenTargets,
  enqueueJob,
  getJob,
  getWardenCampaign,
  type AppDb,
} from "@mendpoint/db";
import {
  productionGraphFilePresent,
  resolveTenantGraphHandle,
  WardenCampaignExecutionError,
  type WardenCampaignExecutionDependencies,
} from "@mendpoint/pipeline";
import type { UnifiedSourceArtifact } from "@mendpoint/change-intel";
import { WARDEN_CAMPAIGN_EXECUTE_JOB_TYPE } from "./warden-campaign-execute-dispatch.js";
import {
  extractFieldRenames,
  fieldRenameRecipeDependencies,
  payloadRenameDeriver,
  type FieldRename,
} from "./warden-campaign-recipe.js";

export { extractFieldRenames, type FieldRename };

export type CampaignExecuteEnqueueInput = Readonly<{
  tenantId: string;
  campaignId: string;
  actorPrincipalId: string;
  createdAt: string;
  source: UnifiedSourceArtifact;
  renames: readonly FieldRename[];
  rolloutDecisionId: string;
  rolloutApproval: Readonly<{
    decisionSha256: string;
    approvedByPrincipalId: string;
    approvedAt: string;
  }>;
  ownerApproval: Readonly<{
    ownerPrincipalId: string;
    ownerHandle: string;
    approvedAt: string;
  }>;
}>;

export function enqueueReadyWardenCampaignTargets(
  db: AppDb,
  input: CampaignExecuteEnqueueInput,
): Readonly<{ jobIds: readonly string[] }> {
  const campaign = getWardenCampaign(db, input.tenantId, input.campaignId);
  if (!campaign) throw new Error("warden_campaign_not_found");
  if (campaign.status !== "running") throw new Error("warden_campaign_not_running");
  const ready = claimReadyWardenTargets(db, input.tenantId, input.campaignId);
  const jobIds: string[] = [];
  for (const target of ready) {
    // Stable per tenant/campaign/target so a retried start cannot double-enqueue.
    const jobId = `job-warden-exec-${createHash("sha256")
      .update(`${input.tenantId}\0${input.campaignId}\0${target.id}`)
      .digest("hex")
      .slice(0, 32)}`;
    if (!getJob(db, jobId, input.tenantId)) {
      enqueueJob(db, {
        id: jobId,
        tenantId: input.tenantId,
        type: WARDEN_CAMPAIGN_EXECUTE_JOB_TYPE,
        createdAt: input.createdAt,
        payload: {
          campaignId: input.campaignId,
          targetId: target.id,
          rolloutDecisionId: input.rolloutDecisionId,
          actorPrincipalId: input.actorPrincipalId,
          runId: `run-${jobId}`,
          createdAt: input.createdAt,
          source: input.source,
          renames: input.renames,
          rolloutApproval: input.rolloutApproval,
          ownerApproval: input.ownerApproval,
        },
      });
    }
    jobIds.push(jobId);
  }
  return Object.freeze({ jobIds: Object.freeze(jobIds) });
}

/**
 * Build executor dependencies from payload renames against the REAL tenant
 * Change Graph. Throws a retryable executor error when the handle is not ready
 * so the job waits rather than running against an empty memory store.
 */
export function productionCampaignResolveDependencies(options: {
  graphPath?: string | null;
} = {}): (renames: readonly FieldRename[], tenantId: string) => WardenCampaignExecutionDependencies {
  const handles = new Map<string, Extract<ReturnType<typeof resolveTenantGraphHandle>, { status: "ready" }>>();
  return (renames, tenantId) => {
    let handle = handles.get(tenantId);
    if (!handle) {
      const resolved = resolveTenantGraphHandle({
        tenantId,
        graphPath: options.graphPath,
      });
      if (resolved.status !== "ready") {
        throw new WardenCampaignExecutionError(
          "warden_tenant_graph_unavailable",
          true,
          resolved.detail,
        );
      }
      handle = resolved;
      handles.set(tenantId, handle);
    }
    return fieldRenameRecipeDependencies({
      deriveRename: payloadRenameDeriver(renames),
      graphDb: handle.graphDb,
    });
  };
}

/** Whether run-service may claim campaign-execute jobs. */
export function campaignExecuteClaimEnabled(graphPath?: string | null): boolean {
  return productionGraphFilePresent(graphPath);
}
