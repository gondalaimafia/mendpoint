import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  pathBlocked,
  verificationControlPath,
  type FettlerProviderChangeEvidence,
} from "@mendpoint/agent";
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

const EXACT_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_CHANGED_PATHS = 40;

export type JoinedFettlerRun = Readonly<{
  consumerId: string;
  status: "queued" | "replayed" | "abstained";
  jobId?: string;
  runId?: string;
  reason?: string;
}>;

export type PipelineFettlerJoinInput = Readonly<{
  tenantId: string;
  pipelineJobId: string;
  providerSlug: string;
  report: PipelineReport;
  observedAt: string;
  useLlm: boolean;
  versionBinding?: Readonly<{
    contentHash: string;
    fromVersionId: string;
    fromVersionLabel: string;
    toVersionId: string;
    toVersionLabel: string;
  }>;
}>;

export type FettlerProviderChangeLineage = FettlerProviderChangeEvidence;

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
    const existingLineage = existing.fettlerProviderChange;
    const expectedLineage = expectedPayload.fettlerProviderChange;
    if ((existingLineage === undefined) !== (expectedLineage === undefined)) return false;
    if (existingLineage !== undefined && (
      typeof existingLineage !== "object" || existingLineage === null || Array.isArray(existingLineage) ||
      typeof expectedLineage !== "object" || expectedLineage === null || Array.isArray(expectedLineage)
    )) return false;
    return isDeepStrictEqual(
      {
        ...withoutCampaignHint(existing),
        source: {
          ...existingSource,
          pipelineJobId: (expectedSource as Record<string, unknown>).pipelineJobId,
        },
        ...(existingLineage === undefined ? {} : {
          fettlerProviderChange: {
            ...existingLineage as Record<string, unknown>,
            pipelineJobId: (expectedLineage as Record<string, unknown>).pipelineJobId,
          },
        }),
      },
      withoutCampaignHint(expectedPayload),
    );
  } catch {
    return false;
  }
}

function providerChangeLineage(input: PipelineFettlerJoinInput, result: PipelineReport["consumers"][number], binding: {
  repositoryId: string;
  snapshotId: string;
  revision: string;
}): FettlerProviderChangeLineage {
  if (!input.versionBinding) throw new Error("fettler_provider_change_version_binding_required");
  const impact = result.impactReport!;
  const sites = impact.sites
    .map((site) => ({
      filePath: site.filePath,
      lineStart: site.lineStart,
      lineEnd: site.lineEnd,
      symbol: site.symbol,
      confidence: site.confidence,
      impactType: site.impactType,
      surfaceIds: [...site.surfaceIds].sort(),
      evidenceDigest: digest([site.evidence]),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const overallConfidence = result.overallConfidence ?? impact.overallConfidence;
  if (overallConfidence !== "medium" && overallConfidence !== "high") {
    throw new Error("fettler_provider_change_confidence_invalid");
  }
  const whatChanged = (input.report.summary || input.report.diff.summary)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 500);
  const unknowns: string[] = [];
  if (!result.graphVersionId) unknowns.push("Change Graph version was not available for this impact run.");
  if (!result.graphContextArtifactId) unknowns.push("Change Graph context artifact was not available for this impact run.");
  if (result.candidates > result.confirmed) {
    unknowns.push(`${result.candidates - result.confirmed} candidate impact site(s) remain unconfirmed.`);
  }
  if (impact.lowConfidenceNotifications.length) {
    unknowns.push(`${impact.lowConfidenceNotifications.length} low confidence observation(s) require review.`);
  }
  return Object.freeze({
    schemaVersion: 1,
    providerSlug: input.providerSlug,
    changeId: input.report.changeId,
    pipelineJobId: input.pipelineJobId,
    ...input.versionBinding,
    repositoryId: binding.repositoryId,
    snapshotId: binding.snapshotId,
    revision: binding.revision,
    graphVersionId: result.graphVersionId ?? null,
    graphContextArtifactId: result.graphContextArtifactId ?? null,
    impactEvidenceDigest: `sha256:${digest([JSON.stringify({
      consumerId: result.consumerId,
      findings: result.findings,
      candidates: result.candidates,
      confirmed: result.confirmed,
      overallConfidence,
      sites,
    })])}`,
    overallConfidence,
    whatChanged,
    knownFacts: Object.freeze([
      `The provider change is recorded as ${input.report.risk}.`,
      `${result.confirmed} of ${result.candidates} candidate impact site(s) are confirmed.`,
      "The repository snapshot and exact revision are bound to this run.",
    ]),
    unknowns: Object.freeze(unknowns),
    whyAffected: `${result.findings} impact finding(s) connect the provider change to this monitored consumer; ${result.confirmed} are confirmed at ${overallConfidence} confidence.`,
  });
}

function abstain(
  db: AppDb,
  input: PipelineFettlerJoinInput,
  consumerId: string,
  reason: string,
): JoinedFettlerRun {
  recordAudit(db, {
    id: `audit_${digest([input.tenantId, input.pipelineJobId, consumerId, reason])}`,
    tenantId: input.tenantId,
    actor: "fettler",
    action: "fettler.provider_change.abstained",
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

export function enqueuePipelineFettlerRuns(
  db: AppDb,
  input: PipelineFettlerJoinInput,
): readonly JoinedFettlerRun[] {
  if (!input.tenantId.trim() || !input.pipelineJobId.trim() || !input.providerSlug.trim()) {
    throw new Error("fettler_provider_change_join_identity_required");
  }
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error("fettler_provider_change_join_observed_at_invalid");
  }

  return Object.freeze(input.report.consumers.map((result): JoinedFettlerRun => {
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
    // These identifiers are already persisted in production. Keep their legacy
    // prefixes so a replay after this rename resolves the same durable records.
    const jobId = `warden-pilot-job-${identity.slice(0, 32)}`;
    const runId = `warden-pilot-run-${identity.slice(32)}`;
    const goal = `Apply the recorded ${input.providerSlug} API migration for change ${input.report.changeId}. ` +
      "Update only the evidence linked paths and pass the repository verification policy.";
    const campaign = resolveUnambiguousSingleRepoFettlerCampaign(
      db,
      input.tenantId,
      repo.connected_repository_id,
    );
    const fettlerProviderChange = input.versionBinding
      ? providerChangeLineage(input, result, {
          repositoryId: repo.connected_repository_id,
          snapshotId: snapshot.id,
          revision: snapshot.resolved_sha,
        })
      : undefined;
    const payload = {
      goal,
      consumerId: consumer.id,
      allowedChangedPaths,
      maxSteps: 48,
      useLlm: input.useLlm,
      allowNetwork: false,
      sessionId: runId,
      ...(fettlerProviderChange ? { fettlerProviderChange } : {}),
      ...(campaign ? { fettlerCampaignId: campaign.campaignId } : {}),
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
          throw new Error("fettler_provider_change_join_idempotency_conflict");
        }
        const run = getAgentRun(db, runId, input.tenantId);
        if (!run || run.job_id !== jobId) {
          throw new Error("fettler_provider_change_join_run_identity_conflict");
        }
        const canonicalPayload = JSON.parse(existing.payload_json) as {
          source: { pipelineJobId: string };
        };
        recordAudit(db, {
          id: `audit_${digest([input.tenantId, jobId, input.pipelineJobId, "replayed"])}`,
          tenantId: input.tenantId,
          actor: "fettler",
          action: "fettler.provider_change.replayed",
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
          product: "fettler",
          source: payload.source,
        }),
        createdAt: input.observedAt,
        finishedAt: null,
      });
      recordAudit(db, {
        id: `audit_${digest([input.tenantId, jobId, "queued"])}`,
        tenantId: input.tenantId,
        actor: "fettler",
        action: "fettler.provider_change.queued",
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

/** @deprecated Read compatibility for callers compiled against the pilot name. */
export type JoinedWardenRun = JoinedFettlerRun;
/** @deprecated Read compatibility for callers compiled against the pilot name. */
export type PipelineWardenJoinInput = PipelineFettlerJoinInput;
/** @deprecated Use enqueuePipelineFettlerRuns for new production work. */
export const enqueuePipelineWardenRuns = enqueuePipelineFettlerRuns;
