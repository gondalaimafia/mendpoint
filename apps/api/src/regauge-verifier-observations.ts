import { createHash } from "node:crypto";
import {
  getPrincipal,
  listArtifactManifests,
  listEvidenceRecords,
  resolveMissionForRegaugeCampaign,
  type AppDb,
} from "@mendpoint/db";
import {
  readVerifierAdvisoryProviderEvidence,
  REGAUGE_DEEPSEEK_APPROVED_SCOPE,
} from "@mendpoint/pipeline";
import { verifyVerifierTelemetry } from "@mendpoint/verifier";

export type RegaugeVerifierObservation = Readonly<{
  telemetryDigest: string;
  evidencePackDigest: string;
  provider: "deepseek";
  model: "deepseek-v4-flash";
  backendRevision: string;
  observedAt: string;
  totalTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  scoreEvidenceDigests: readonly string[];
  consentId: string;
  consentEffectiveAt: string;
  consentGrantedAt: string;
  consentExpiresAt: string;
  consentRecordDigest: string;
  providerRequestedAt: string;
  providerProcessedAt: string;
  advisoryOnly: true;
  behaviorChanged: false;
}>;

export function readRegaugeVerifierObservations(
  db: AppDb,
  input: Readonly<{ tenantId: string; campaignId: string }>,
): readonly RegaugeVerifierObservation[] {
  if (input.tenantId !== REGAUGE_DEEPSEEK_APPROVED_SCOPE.tenantId ||
      input.campaignId !== REGAUGE_DEEPSEEK_APPROVED_SCOPE.campaignId) {
    throw new Error("regauge_verifier_observation_scope_invalid");
  }
  const mission = resolveMissionForRegaugeCampaign(db, input.tenantId, input.campaignId);
  if (!mission) throw new Error("regauge_verifier_observation_mission_missing");
  const taskPrefix = `${input.campaignId}:`;
  const observations = listArtifactManifests(db, input.tenantId, "agent_verifier_telemetry")
    .flatMap((artifact) => {
      if (artifact.schema_version !== 1 ||
          artifact.media_type !== "application/vnd.mendpoint.agent-verifier-telemetry.v1+json" ||
          !artifact.content_text || sha256(artifact.content_text) !== artifact.sha256 ||
          Buffer.byteLength(artifact.content_text, "utf8") !== artifact.size_bytes ||
          !artifact.producer_principal_id) return [];
      try {
        const telemetry = verifyVerifierTelemetry(JSON.parse(artifact.content_text));
        const producer = getPrincipal(db, input.tenantId, artifact.producer_principal_id);
        const providerEvidence = readVerifierAdvisoryProviderEvidence(db, {
          tenantId: input.tenantId,
          verificationAttemptId: telemetry.verificationAttemptId,
          evidencePackDigest: telemetry.evidencePackDigest,
        });
        const evidence = listEvidenceRecords(
          db,
          input.tenantId,
          "agent_verifier_task",
          telemetry.taskId,
        ).filter((record) => record.artifact_id === artifact.id &&
          record.producer_principal_id === artifact.producer_principal_id &&
          record.tool === "mendpoint-agent-verifier" && record.tool_version === "2026-08-17.v1" &&
          record.verdict === "unknown");
        if (telemetry.tenantId !== input.tenantId || telemetry.missionId !== mission.id ||
            telemetry.product !== "regauge" || !telemetry.taskId.startsWith(taskPrefix) ||
            telemetry.verificationAttemptId !== `completion_${telemetry.taskId}` ||
            telemetry.rolloutMode !== "advisory" || telemetry.backend?.provider !== "deepseek" ||
            telemetry.backend.model !== "deepseek-v4-flash" || telemetry.failureCode !== null ||
            telemetry.behaviorChanged !== false || telemetry.softSignalOnly !== true ||
            telemetry.usage.totalTokens <= 0 || telemetry.scoreEvidenceDigests.length === 0 ||
            !producer || producer.kind !== "service" || producer.created_at > telemetry.observedAt ||
            producer.revoked_at && producer.revoked_at <= telemetry.observedAt ||
            producer.expires_at && producer.expires_at <= telemetry.observedAt || evidence.length !== 1 ||
            !providerEvidence || providerEvidence.consentGrantedAt >= providerEvidence.providerRequestedAt ||
            providerEvidence.consentEffectiveAt >= providerEvidence.providerRequestedAt ||
            providerEvidence.providerProcessedAt < providerEvidence.providerRequestedAt ||
            providerEvidence.consentExpiresAt <= providerEvidence.providerProcessedAt ||
            providerEvidence.consentExpiresAt > REGAUGE_DEEPSEEK_APPROVED_SCOPE.authorizationDeadline) return [];
        return [Object.freeze({
          telemetryDigest: telemetry.telemetryDigest,
          evidencePackDigest: telemetry.evidencePackDigest,
          provider: "deepseek" as const,
          model: "deepseek-v4-flash" as const,
          backendRevision: telemetry.backend.backendRevision,
          observedAt: telemetry.observedAt,
          totalTokens: telemetry.usage.totalTokens,
          estimatedCostUsd: telemetry.estimatedCostUsd,
          latencyMs: telemetry.latencyMs,
          scoreEvidenceDigests: Object.freeze([...telemetry.scoreEvidenceDigests]),
          consentId: providerEvidence.consentId,
          consentEffectiveAt: providerEvidence.consentEffectiveAt,
          consentGrantedAt: providerEvidence.consentGrantedAt,
          consentExpiresAt: providerEvidence.consentExpiresAt,
          consentRecordDigest: providerEvidence.consentRecordDigest,
          providerRequestedAt: providerEvidence.providerRequestedAt,
          providerProcessedAt: providerEvidence.providerProcessedAt,
          advisoryOnly: true as const,
          behaviorChanged: false as const,
        })];
      } catch { return []; }
    })
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt));
  if (observations.length > 1) throw new Error("regauge_verifier_observation_ambiguous");
  return Object.freeze(observations);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
