import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { pathBlocked, verificationControlPath } from "@mendpoint/agent";
import {
  enqueueJob,
  getAgentRun,
  getConsumer,
  getConsumerRepo,
  getJob,
  getRepositorySnapshotPolicy,
  insertAgentRun,
  listRepositorySnapshots,
  recordAudit,
  type AppDb,
} from "@mendpoint/db";
import {
  resolveUnambiguousSingleRepoFettlerCampaign,
  type PipelineReport,
} from "@mendpoint/pipeline";
import type { ImpactReport } from "@mendpoint/shared";

const EXACT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_CHANGED_PATHS = 40;

export type JoinedWardenRun = Readonly<{
  consumerId: string;
  status: "queued" | "replayed" | "abstained";
  jobId?: string;
  runId?: string;
  reason?: string;
}>;

export type PipelineWardenJoinInput = Readonly<{
  tenantId: string;
  pipelineJobId: string;
  providerSlug: string;
  report: PipelineReport;
  observedAt: string;
  useLlm: boolean;
}>;

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

function safePath(path: string): boolean {
  return Boolean(path) &&
    path.length <= 500 &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/.test(path) &&
    !path.split("/").some((part) => !part || part === "." || part === "..") &&
    !verificationControlPath(path) &&
    !pathBlocked(path);
}

/**
 * Thread a live Fettler endpoint key only when the impact report already
 * names exactly one HTTP surface. Zero or many surfaces stay absent so
 * MissionGraphProjection reports `endpoint_key_absent` instead of inventing
 * a key.
 */
export function liveFettlerEndpointKey(report: ImpactReport | undefined): string | undefined {
  if (!report) return undefined;
  const keys = [...new Set(
    report.surfaces
      .filter((surface) => surface.kind === "http_path" || surface.kind === "http_method")
      .map((surface) => surface.canonicalId.trim())
      .filter(Boolean),
  )];
  return keys.length === 1 ? keys[0] : undefined;
}

function campaignHint(payload: Record<string, unknown>): string | undefined {
  // Cover every campaign-hint key `resolveBoundMissionForJob` honours, so the
  // guard cannot be dodged by a regauge-tagged replay even though this producer
  // only sets `fettlerCampaignId` today.
  const value = payload.fettlerCampaignId ?? payload.campaignId ?? payload.regaugeCampaignId;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function withoutCampaignHint(payload: Record<string, unknown>): Record<string, unknown> {
  // Only the campaign hint is normalized out of the structural comparison; its
  // divergence is judged separately below. All three campaign-hint keys are
  // stripped in lockstep with `campaignHint` above. `missionId` is deliberately
  // NOT stripped: this file never sets it today, so leaving it in the deep-equal
  // means any future one-sided `missionId` is caught as a real payload
  // divergence rather than silently ignored.
  const { fettlerCampaignId: _campaign, campaignId: _alias, regaugeCampaignId: _regauge, ...rest } = payload;
  return rest;
}

function equivalentReplayPayload(existingPayloadJson: string, expectedPayload: Record<string, unknown>): boolean {
  try {
    const existing = JSON.parse(existingPayloadJson) as Record<string, unknown>;
    const existingSource = existing.source;
    const expectedSource = expectedPayload.source;
    if (
      !existingSource || typeof existingSource !== "object" || Array.isArray(existingSource) ||
      !expectedSource || typeof expectedSource !== "object" || Array.isArray(expectedSource)
    ) {
      return false;
    }
    const existingHint = campaignHint(existing);
    const expectedHint = campaignHint(expectedPayload);
    // A campaign hint may be ADDED by a later enrollment (existing had none,
    // expected now does) — a benign late binding that stays an equivalent
    // replay. But an existing hint must never be silently DROPPED or CHANGED on
    // replay: existing-has-hint with expected-none, or two differing hints, is
    // a real payload divergence, not "didn't determine, so it matches".
    if (existingHint && existingHint !== expectedHint) return false;
    return isDeepStrictEqual(
      {
        ...withoutCampaignHint(existing),
        source: {
          ...existingSource,
          pipelineJobId: (expectedSource as Record<string, unknown>).pipelineJobId,
        },
      },
      withoutCampaignHint(expectedPayload),
    );
  } catch {
    return false;
  }
}

function abstain(
  db: AppDb,
  input: PipelineWardenJoinInput,
  consumerId: string,
  reason: string,
): JoinedWardenRun {
  recordAudit(db, {
    id: `audit_${digest([input.tenantId, input.pipelineJobId, consumerId, reason])}`,
    tenantId: input.tenantId,
    actor: "warden-pilot",
    action: "warden.pilot.abstained",
    resourceType: "consumer",
    resourceId: consumerId,
    metadata: {
      pipelineJobId: input.pipelineJobId,
      changeId: input.report.changeId,
      providerSlug: input.providerSlug,
      reason,
    },
  });
  return Object.freeze({ consumerId, status: "abstained", reason });
}

export function enqueuePipelineWardenRuns(
  db: AppDb,
  input: PipelineWardenJoinInput,
): readonly JoinedWardenRun[] {
  if (!input.tenantId.trim() || !input.pipelineJobId.trim() || !input.providerSlug.trim()) {
    throw new Error("warden_pilot_join_identity_required");
  }
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error("warden_pilot_join_observed_at_invalid");
  }

  return Object.freeze(input.report.consumers.map((result): JoinedWardenRun => {
    const consumer = getConsumer(db, result.consumerId, input.tenantId);
    const repo = consumer ? getConsumerRepo(db, consumer.id, input.tenantId) : undefined;
    if (!consumer || !repo) {
      return abstain(db, input, result.consumerId, "consumer_not_available");
    }
    if (!result.impactReport || result.findings < 1) {
      return abstain(db, input, consumer.id, "impact_evidence_missing");
    }
    if (result.overallConfidence === "low" || result.impactReport.overallConfidence === "low") {
      return abstain(db, input, consumer.id, "impact_confidence_low");
    }
    if (!repo.connected_repository_id || !repo.snapshot_id || !repo.exact_commit) {
      return abstain(db, input, consumer.id, "snapshot_binding_missing");
    }
    if (!EXACT_REVISION.test(repo.exact_commit)) {
      return abstain(db, input, consumer.id, "snapshot_revision_invalid");
    }
    const snapshot = listRepositorySnapshots(
      db,
      input.tenantId,
      repo.connected_repository_id,
    ).find((candidate) => candidate.id === repo.snapshot_id);
    if (!snapshot || snapshot.resolved_sha !== repo.exact_commit) {
      return abstain(db, input, consumer.id, "snapshot_binding_mismatch");
    }
    if (Date.parse(snapshot.expires_at) <= Date.parse(input.observedAt)) {
      return abstain(db, input, consumer.id, "snapshot_expired");
    }
    if (!getRepositorySnapshotPolicy(db, input.tenantId, snapshot.id)) {
      return abstain(db, input, consumer.id, "verification_policy_missing");
    }

    const evidencePaths = [...new Set(result.impactReport.sites
      .filter((site) => site.confidence !== "low")
      .map((site) => site.filePath))].sort();
    if (evidencePaths.length > MAX_CHANGED_PATHS) {
      return abstain(db, input, consumer.id, "impact_scope_exceeds_limit");
    }
    const allowedChangedPaths = evidencePaths.filter(safePath);
    if (!allowedChangedPaths.length) {
      return abstain(db, input, consumer.id, "impact_paths_not_mutable");
    }
    if (allowedChangedPaths.length !== evidencePaths.length) {
      return abstain(db, input, consumer.id, "impact_scope_contains_protected_paths");
    }

    const identity = digest([
      input.tenantId,
      input.providerSlug,
      input.report.changeId,
      consumer.id,
      snapshot.id,
      snapshot.resolved_sha,
      snapshot.manifest_sha256,
      ...allowedChangedPaths,
    ]);
    const jobId = `warden-pilot-job-${identity.slice(0, 32)}`;
    const runId = `warden-pilot-run-${identity.slice(32)}`;
    const goal = `Apply the recorded ${input.providerSlug} API migration for change ${input.report.changeId}. ` +
      "Update only the evidence linked paths and pass the repository verification policy.";
    const campaign = resolveUnambiguousSingleRepoFettlerCampaign(
      db,
      input.tenantId,
      repo.connected_repository_id,
    );
    const endpointKey = liveFettlerEndpointKey(result.impactReport);
    const payload = {
      goal,
      consumerId: consumer.id,
      allowedChangedPaths,
      maxSteps: 48,
      useLlm: input.useLlm,
      allowNetwork: false,
      sessionId: runId,
      ...(campaign ? { fettlerCampaignId: campaign.campaignId } : {}),
      ...(endpointKey ? { endpointKey } : {}),
      source: {
        pipelineJobId: input.pipelineJobId,
        changeId: input.report.changeId,
        providerSlug: input.providerSlug,
        repositoryId: repo.connected_repository_id,
        snapshotId: snapshot.id,
        revision: snapshot.resolved_sha,
      },
    };
    const payloadJson = JSON.stringify(payload);

    const ownsTransaction = !db.raw.isTransaction;
    if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
    try {
      const existing = getJob(db, jobId, input.tenantId);
      if (existing) {
        if (
          existing.type !== "agent.run" ||
          !equivalentReplayPayload(existing.payload_json, payload)
        ) {
          throw new Error("warden_pilot_join_idempotency_conflict");
        }
        const run = getAgentRun(db, runId, input.tenantId);
        if (!run || run.job_id !== jobId) {
          throw new Error("warden_pilot_join_run_identity_conflict");
        }
        const canonicalPayload = JSON.parse(existing.payload_json) as {
          source: { pipelineJobId: string };
        };
        recordAudit(db, {
          id: `audit_${digest([input.tenantId, jobId, input.pipelineJobId, "replayed"])}`,
          tenantId: input.tenantId,
          actor: "warden-pilot",
          action: "warden.pilot.replayed",
          resourceType: "agent_run",
          resourceId: runId,
          metadata: {
            jobId,
            canonicalPipelineJobId: canonicalPayload.source.pipelineJobId,
            replayPipelineJobId: input.pipelineJobId,
            changeId: input.report.changeId,
            providerSlug: input.providerSlug,
            consumerId: consumer.id,
          },
        });
        if (ownsTransaction) db.raw.exec("COMMIT");
        return Object.freeze({ consumerId: consumer.id, status: "replayed", jobId, runId });
      }

      enqueueJob(db, {
        id: jobId,
        tenantId: input.tenantId,
        type: "agent.run",
        payload,
        createdAt: input.observedAt,
      });
      insertAgentRun(db, {
        id: runId,
        tenantId: input.tenantId,
        jobId,
        goal,
        repoPath: snapshot.storage_path,
        status: "queued",
        ok: false,
        steps: 0,
        filesChanged: [],
        resultJson: JSON.stringify({
          jobId,
          product: "warden",
          source: payload.source,
        }),
        createdAt: input.observedAt,
        finishedAt: null,
      });
      recordAudit(db, {
        id: `audit_${digest([input.tenantId, jobId, "queued"])}`,
        tenantId: input.tenantId,
        actor: "warden-pilot",
        action: "warden.pilot.queued",
        resourceType: "agent_run",
        resourceId: runId,
        metadata: {
          jobId,
          pipelineJobId: input.pipelineJobId,
          changeId: input.report.changeId,
          providerSlug: input.providerSlug,
          consumerId: consumer.id,
          repositoryId: repo.connected_repository_id,
          snapshotId: snapshot.id,
          revision: snapshot.resolved_sha,
          allowedChangedPaths,
          ...(campaign
            ? { fettlerCampaignId: campaign.campaignId, missionId: campaign.missionId }
            : {}),
        },
      });
      if (ownsTransaction) db.raw.exec("COMMIT");
      return Object.freeze({ consumerId: consumer.id, status: "queued", jobId, runId });
    } catch (error) {
      if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
      throw error;
    }
  }));
}
