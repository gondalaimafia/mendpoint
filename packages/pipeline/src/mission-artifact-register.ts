/**
 * Best-effort Mission artifact registry on existing persist seams.
 *
 * Mission outputs already live as `artifact_manifests` rows. This helper
 * registers those existing manifests as first-class Mission outputs by
 * REFERENCE (id + sha256), never copying bytes and never creating a new
 * manifest. A missing Mission is a silent skip — registration is metadata and
 * must not fail the producing job.
 */
import {
  getMission,
  recordMissionArtifactLineage,
  registerMissionArtifact,
  resolveMissionForFettlerCampaign,
  resolveMissionForRegaugeCampaign,
  type AppDb,
  type MissionArtifactRole,
} from "@mendpoint/db";

export type MissionArtifactRegistration = Readonly<{
  role: MissionArtifactRole;
  artifactId: string;
  label: string;
  parentArtifactId?: string;
}>;

export type MissionArtifactRegisterResult =
  | Readonly<{ status: "skipped_unbound" }>
  | Readonly<{ status: "skipped_no_artifacts" }>
  | Readonly<{ status: "skipped_mission_not_found"; missionId: string }>
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
  db.raw.exec("SAVEPOINT mission_artifact_registration");
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
    db.raw.exec("RELEASE SAVEPOINT mission_artifact_registration");
    return { status: "registered", missionId, count: input.artifacts.length };
  } catch (error) {
    db.raw.exec("ROLLBACK TO SAVEPOINT mission_artifact_registration");
    db.raw.exec("RELEASE SAVEPOINT mission_artifact_registration");
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
 * Resolve a ReGauge campaign's linked Mission (if any) and register already-
 * persisted manifests against it. No campaign link or empty artifact list →
 * skip, don't fail, and never invent a manifest.
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
