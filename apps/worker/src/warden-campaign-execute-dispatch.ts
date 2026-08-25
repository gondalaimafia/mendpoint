/**
 * Worker-side entrypoint for the Fettler campaign per-target executor.
 *
 * `executeWardenCampaignTarget` (@mendpoint/pipeline) drives one approved
 * campaign target queued -> analyzing -> editing -> verifying -> **review**: it
 * analyzes, generates and applies typed edits, runs baseline+post verification,
 * and lands a review-package artifact at stage `review`. It never delivers a PR
 * itself — delivery stays the separate, review-first `warden.candidate.deliver`
 * job — so this executor is COMPLEMENTARY to that flow, not a duplicate delivery
 * path (spec §16.1 review-first; §31.7 one canonical implementation).
 *
 * Until now the executor had no production caller (only tests). This module is
 * that caller's core: it parses a `warden.campaign.execute-target` job, invokes
 * the executor, and maps its outcome onto the worker's job-status vocabulary,
 * distinguishing a retryable `WardenCampaignExecutionError` (transient — reschedule)
 * from a terminal one (fail). It is deliberately free of the fenced job-loop's
 * lease/completion mechanics so it is unit-testable in isolation; the loop
 * routing that honors the `completeJob`/`failJob` fence contract, and the
 * construction of the production `WardenCampaignExecutionDependencies`
 * (generation planEdits/applyEdits + sandbox verify + draft delivery config),
 * are wired by the caller.
 */
import type { AppDb } from "@mendpoint/db";
import {
  WardenCampaignExecutionError,
  executeWardenCampaignTarget,
  type WardenCampaignExecutionDependencies,
} from "@mendpoint/pipeline";
import type { FieldRename } from "./warden-campaign-recipe.js";

export const WARDEN_CAMPAIGN_EXECUTE_JOB_TYPE = "warden.campaign.execute-target";

/** The minimal job shape this dispatch reads (mirrors the worker's `Job`). */
export interface WardenCampaignExecuteJob {
  readonly id: string;
  readonly tenant_id: string;
  readonly type: string;
  readonly payload_json: string;
}

/** Injectable executor so the dispatch is unit-testable without the full fixture. */
export type WardenCampaignExecutor = typeof executeWardenCampaignTarget;

export type WardenCampaignExecuteOutcome =
  | { readonly status: "executed"; readonly stage: string }
  | { readonly status: "retry_scheduled"; readonly code: string }
  | { readonly status: "failed"; readonly code: string };

interface RolloutApproval {
  decisionSha256: string;
  approvedByPrincipalId: string;
  approvedAt: string;
}
interface OwnerApproval {
  ownerPrincipalId: string;
  ownerHandle: string;
  approvedAt: string;
}
interface ExecutePayload {
  campaignId: string;
  targetId: string;
  rolloutDecisionId: string;
  actorPrincipalId: string;
  runId: string;
  createdAt: string;
  source: unknown;
  rolloutApproval: RolloutApproval;
  ownerApproval: OwnerApproval;
  /** Field renames extracted from the diff at enqueue time; drives the recipe. */
  renames: FieldRename[];
}

class PayloadError extends Error {}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PayloadError(`warden_campaign_execute_payload_${key}_invalid`);
  }
  return value;
}

function object(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PayloadError(`warden_campaign_execute_payload_${key}_invalid`);
  }
  return value as Record<string, unknown>;
}

/**
 * Parse and fail closed on a malformed job payload. The executor re-validates
 * every authority (approvals, snapshot, rollout cohort) itself, so this parse is
 * a shape guard only — never a substitute for the executor's checks.
 */
export function parseWardenCampaignExecuteJob(job: WardenCampaignExecuteJob): ExecutePayload {
  let raw: unknown;
  try {
    raw = JSON.parse(job.payload_json);
  } catch {
    throw new PayloadError("warden_campaign_execute_payload_invalid");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PayloadError("warden_campaign_execute_payload_invalid");
  }
  const record = raw as Record<string, unknown>;
  const rollout = object(record, "rolloutApproval");
  const owner = object(record, "ownerApproval");
  return {
    campaignId: str(record, "campaignId"),
    targetId: str(record, "targetId"),
    rolloutDecisionId: str(record, "rolloutDecisionId"),
    actorPrincipalId: str(record, "actorPrincipalId"),
    runId: str(record, "runId"),
    createdAt: str(record, "createdAt"),
    source: object(record, "source"),
    rolloutApproval: {
      decisionSha256: str(rollout, "decisionSha256"),
      approvedByPrincipalId: str(rollout, "approvedByPrincipalId"),
      approvedAt: str(rollout, "approvedAt"),
    },
    ownerApproval: {
      ownerPrincipalId: str(owner, "ownerPrincipalId"),
      ownerHandle: str(owner, "ownerHandle"),
      approvedAt: str(owner, "approvedAt"),
    },
    renames: parseRenames(record.renames),
  };
}

function parseRenames(value: unknown): FieldRename[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PayloadError("warden_campaign_execute_payload_renames_invalid");
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new PayloadError("warden_campaign_execute_payload_renames_invalid");
    const record = entry as Record<string, unknown>;
    return { from: str(record, "from"), to: str(record, "to") };
  });
}

/**
 * Run one `warden.campaign.execute-target` job. Returns a job-status outcome; it
 * does not throw for a known executor error, so the caller maps the outcome onto
 * `completeJob`/`failJob` under the loop fence. An unexpected (non-executor)
 * error is rethrown so the loop's generic failure path handles it.
 */
export async function runWardenCampaignExecuteTarget(input: {
  db: AppDb;
  job: WardenCampaignExecuteJob;
  /** Build the executor dependencies from the renames the diff carried in the
   * job payload (per job — each campaign target carries its own change). */
  resolveDependencies: (renames: readonly FieldRename[], tenantId: string) => WardenCampaignExecutionDependencies;
  execute?: WardenCampaignExecutor;
}): Promise<WardenCampaignExecuteOutcome> {
  const execute = input.execute ?? executeWardenCampaignTarget;
  let payload: ExecutePayload;
  try {
    payload = parseWardenCampaignExecuteJob(input.job);
  } catch (error) {
    return { status: "failed", code: error instanceof PayloadError ? error.message : "warden_campaign_execute_payload_invalid" };
  }
  try {
    const result = await execute({
      db: input.db,
      tenantId: input.job.tenant_id,
      campaignId: payload.campaignId,
      targetId: payload.targetId,
      rolloutDecisionId: payload.rolloutDecisionId,
      source: payload.source as Parameters<WardenCampaignExecutor>[0]["source"],
      rolloutApproval: payload.rolloutApproval,
      ownerApproval: payload.ownerApproval,
      actorPrincipalId: payload.actorPrincipalId,
      runId: payload.runId,
      createdAt: payload.createdAt,
      dependencies: input.resolveDependencies(payload.renames, input.job.tenant_id),
    });
    return { status: "executed", stage: result.stage };
  } catch (error) {
    if (error instanceof WardenCampaignExecutionError) {
      return error.retryable
        ? { status: "retry_scheduled", code: error.code }
        : { status: "failed", code: error.code };
    }
    throw error;
  }
}
