/**
 * Best-effort Mission artifact registry on existing persist seams.
 *
 * Mission outputs already live as `artifact_manifests` rows. This helper
 * registers those existing manifests as first-class Mission outputs by
 * REFERENCE (id + sha256), never copying bytes and never creating a new
 * manifest. A missing Mission is a silent skip — registration is metadata and
 * must not fail the producing job.
 */
import { createHash } from "node:crypto";
import {
  getMission,
  getPrincipalBySubject,
  insertArtifactManifest,
  recordMissionArtifactLineage,
  registerMissionArtifact,
  resolveMissionForFettlerCampaign,
  resolveMissionForRegaugeCampaign,
  type AppDb,
  type MissionArtifactRole,
} from "@mendpoint/db";

const REGAUGE_PRODUCER_SUBJECT = "service:regauge-production-bootstrap";

export type MissionArtifactRegistration = Readonly<{
  role: MissionArtifactRole;
  artifactId: string;
  label: string;
  parentArtifactId?: string;
}>;

export type MissionArtifactRegisterResult =
  | Readonly<{ status: "skipped_unbound" }>
  | Readonly<{ status: "skipped_mission_not_found"; missionId: string }>
  | Readonly<{ status: "skipped_producer_absent" }>
  | Readonly<{ status: "skipped_no_artifacts" }>
  | Readonly<{ status: "registered"; missionId: string; count: number }>
  | Readonly<{ status: "failed"; missionId: string; reason: string }>;

function logSkip(message: string): void {
  console.error(`  mission artifact ${message}`);
}

/**
 * Register already-persisted artifact manifests against a bound Mission.
 * Unbound / unresolvable / registration faults never throw to the caller.
 */
export function tryRegisterBoundMissionArtifacts(
  db: AppDb,
  input: {
    tenantId: string;
    missionId?: string | null;
    producerPrincipalId: string;
    correlationId: string;
    createdAt: string;
    sourceSnapshot?: string | null;
    artifacts: readonly MissionArtifactRegistration[];
  },
): MissionArtifactRegisterResult {
  const missionId = input.missionId?.trim() ?? "";
  if (!missionId) return { status: "skipped_unbound" };
  if (!getMission(db, input.tenantId, missionId)) {
    logSkip(`skip: mission_not_found tenant=${input.tenantId} mission=${missionId}`);
    return { status: "skipped_mission_not_found", missionId };
  }
  try {
    for (const artifact of input.artifacts) {
      registerMissionArtifact(db, {
        tenantId: input.tenantId,
        missionId,
        role: artifact.role,
        artifactId: artifact.artifactId,
        label: artifact.label,
        producerPrincipalId: input.producerPrincipalId,
        correlationId: input.correlationId,
        createdAt: input.createdAt,
        sourceSnapshot: input.sourceSnapshot ?? null,
      });
    }
    for (const artifact of input.artifacts) {
      if (!artifact.parentArtifactId) continue;
      recordMissionArtifactLineage(db, {
        tenantId: input.tenantId,
        missionId,
        artifactId: artifact.artifactId,
        parentArtifactId: artifact.parentArtifactId,
        recordedByPrincipalId: input.producerPrincipalId,
        correlationId: input.correlationId,
        createdAt: input.createdAt,
      });
    }
    return { status: "registered", missionId, count: input.artifacts.length };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logSkip(`registration failed tenant=${input.tenantId} mission=${missionId}: ${reason}`);
    return { status: "failed", missionId, reason };
  }
}

/**
 * Resolve a Fettler campaign's linked Mission (if any) and register the given
 * already-persisted manifests against it. No campaign link → skip, don't fail.
 */
export function tryRegisterFettlerCampaignMissionArtifacts(
  db: AppDb,
  input: {
    tenantId: string;
    campaignId: string;
    producerPrincipalId: string;
    createdAt: string;
    sourceSnapshot?: string | null;
    artifacts: readonly MissionArtifactRegistration[];
  },
): MissionArtifactRegisterResult {
  const mission = resolveMissionForFettlerCampaign(db, input.tenantId, input.campaignId);
  return tryRegisterBoundMissionArtifacts(db, {
    tenantId: input.tenantId,
    missionId: mission?.id ?? null,
    producerPrincipalId: input.producerPrincipalId,
    correlationId: input.campaignId,
    createdAt: input.createdAt,
    sourceSnapshot: input.sourceSnapshot,
    artifacts: input.artifacts,
  });
}

/**
 * Resolve a ReGauge campaign's linked Mission and register already-persisted
 * manifests. Empty artifact lists skip — never invent a manifest here.
 */
export function tryRegisterRegaugeCampaignMissionArtifacts(
  db: AppDb,
  input: {
    tenantId: string;
    campaignId: string;
    producerPrincipalId: string;
    createdAt: string;
    sourceSnapshot?: string | null;
    artifacts: readonly MissionArtifactRegistration[];
  },
): MissionArtifactRegisterResult {
  if (input.artifacts.length === 0) return { status: "skipped_no_artifacts" };
  const mission = resolveMissionForRegaugeCampaign(db, input.tenantId, input.campaignId);
  return tryRegisterBoundMissionArtifacts(db, {
    tenantId: input.tenantId,
    missionId: mission?.id ?? null,
    producerPrincipalId: input.producerPrincipalId,
    correlationId: input.campaignId,
    createdAt: input.createdAt,
    sourceSnapshot: input.sourceSnapshot,
    artifacts: input.artifacts,
  });
}

/**
 * Persist the completed ReGauge attempt as a tenant-scoped artifact_manifest
 * and register it on the bound Mission. The live completeAttempt evidence
 * refs are filesystem / store IDs, not manifests — this is the writer that
 * makes registration possible. Attribution uses the ReGauge bootstrap
 * service principal, never the human Mission owner. Missing Mission or
 * service principal skips; faults never throw.
 */
export function persistAndRegisterRegaugeCompleteAttemptArtifacts(
  db: AppDb,
  input: {
    tenantId: string;
    campaignId: string;
    unitId: string;
    candidateDigest: string;
    candidateRevision: string;
    createdAt: string;
    evidenceRefs?: readonly string[];
    sourceSnapshot?: string | null;
  },
): MissionArtifactRegisterResult {
  const mission = resolveMissionForRegaugeCampaign(db, input.tenantId, input.campaignId);
  if (!mission) return { status: "skipped_unbound" };
  const producer = getPrincipalBySubject(
    db,
    input.tenantId,
    "service",
    REGAUGE_PRODUCER_SUBJECT,
  );
  if (!producer) {
    logSkip(`skip: producer_absent tenant=${input.tenantId} campaign=${input.campaignId}`);
    return { status: "skipped_producer_absent" };
  }
  try {
    const content = canonicalJson({
      schemaVersion: 1,
      kind: "regauge-complete-attempt",
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      unitId: input.unitId,
      candidateDigest: input.candidateDigest,
      candidateRevision: input.candidateRevision,
      snapshotId: input.sourceSnapshot ?? null,
      evidenceRefs: [...(input.evidenceRefs ?? [])].map((ref) => ref.trim()).filter(Boolean).sort(),
      createdAt: input.createdAt,
    });
    const digest = sha256(content);
    const artifactId = `artifact_${sha256(`${input.tenantId}\0regauge-complete-attempt\0${digest}`)}`;
    const persisted = insertArtifactManifest(db, {
      id: artifactId,
      tenantId: input.tenantId,
      kind: "regauge-complete-attempt",
      schemaVersion: 1,
      sha256: digest,
      mediaType: "application/vnd.mendpoint.regauge-complete-attempt+json",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      storageRef: `sqlite://artifact_manifests/${artifactId}#content_text`,
      content,
      producerPrincipalId: producer.id,
      createdAt: input.createdAt,
    });
    return tryRegisterBoundMissionArtifacts(db, {
      tenantId: input.tenantId,
      missionId: mission.id,
      producerPrincipalId: producer.id,
      correlationId: input.campaignId,
      createdAt: input.createdAt,
      sourceSnapshot: input.sourceSnapshot ?? null,
      artifacts: [{
        role: "candidate_patch",
        artifactId: persisted.row.id,
        label: `regauge candidate ${input.unitId}`,
      }],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logSkip(`persist failed tenant=${input.tenantId} campaign=${input.campaignId}: ${reason}`);
    return { status: "failed", missionId: mission.id, reason };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
