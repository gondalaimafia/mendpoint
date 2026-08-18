import { createHash } from "node:crypto";
import { insertArtifactManifest, insertEvidenceRecord, type AppDb } from "@mendpoint/db";
import { verifyVerifierTelemetry, type VerifierTelemetry } from "@mendpoint/verifier";

export type PersistedVerifierTelemetry = Readonly<{
  artifactId: string;
  evidenceId: string;
  telemetryDigest: string;
}>;

export function claimVerifierShadowAttempt(db: AppDb, input: Readonly<{
  tenantId: string;
  verificationAttemptId: string;
  evidencePackDigest: string;
  observedAt: string;
  producerPrincipalId?: string | null;
}>): boolean {
  if (!/^sha256:[a-f0-9]{64}$/.test(input.evidencePackDigest)) throw new Error("verifier_dispatch_pack_digest_invalid");
  if (!/^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/.test(input.verificationAttemptId)) throw new Error("verifier_dispatch_attempt_id_invalid");
  const observedAt = Date.parse(input.observedAt);
  if (!Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== input.observedAt) throw new Error("verifier_dispatch_observed_at_invalid");
  const content = canonicalJson({
    schemaVersion: "2026-08-17.verifier-dispatch.v1",
    tenantId: input.tenantId,
    verificationAttemptId: input.verificationAttemptId,
    evidencePackDigest: input.evidencePackDigest,
  });
  const contentSha256 = createHash("sha256").update(content, "utf8").digest("hex");
  const owns = !db.raw.isTransaction;
  const savepoint = `verifier_dispatch_${contentSha256.slice(0, 12)}`;
  if (owns) db.raw.exec("BEGIN IMMEDIATE"); else db.raw.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = insertArtifactManifest(db, {
      id: `verifier-dispatch-${contentSha256.slice(0, 40)}`,
      tenantId: input.tenantId,
      kind: "agent_verifier_dispatch_intent",
      schemaVersion: 1,
      sha256: contentSha256,
      mediaType: "application/vnd.mendpoint.agent-verifier-dispatch.v1+json",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      storageRef: `sqlite://artifact_manifests/verifier-dispatch-${contentSha256.slice(0, 40)}`,
      content,
      producerPrincipalId: input.producerPrincipalId ?? null,
      createdAt: input.observedAt,
    });
    if (owns) db.raw.exec("COMMIT"); else db.raw.exec(`RELEASE ${savepoint}`);
    return result.inserted;
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    else if (!owns && db.raw.isTransaction) { db.raw.exec(`ROLLBACK TO ${savepoint}`); db.raw.exec(`RELEASE ${savepoint}`); }
    throw error;
  }
}

export function persistVerifierTelemetry(db: AppDb, input: Readonly<{
  telemetry: VerifierTelemetry;
  producerPrincipalId?: string | null;
}>): PersistedVerifierTelemetry {
  const telemetry = verifyVerifierTelemetry(input.telemetry);
  const content = canonicalJson(telemetry);
  const contentSha256 = createHash("sha256").update(content, "utf8").digest("hex");
  const suffix = contentSha256.slice(0, 40);
  const artifactId = `verifier-telemetry-${suffix}`;
  const evidenceId = `verifier-evidence-${suffix}`;
  const owns = !db.raw.isTransaction;
  const savepoint = `verifier_telemetry_${suffix.slice(0, 12)}`;
  if (owns) db.raw.exec("BEGIN IMMEDIATE"); else db.raw.exec(`SAVEPOINT ${savepoint}`);
  try {
    insertArtifactManifest(db, {
      id: artifactId,
      tenantId: telemetry.tenantId,
      kind: "agent_verifier_telemetry",
      schemaVersion: 1,
      sha256: contentSha256,
      mediaType: "application/vnd.mendpoint.agent-verifier-telemetry.v1+json",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      storageRef: `sqlite://artifact_manifests/${artifactId}`,
      content,
      producerPrincipalId: input.producerPrincipalId ?? null,
      createdAt: telemetry.observedAt,
    });
    insertEvidenceRecord(db, {
      id: evidenceId,
      tenantId: telemetry.tenantId,
      subjectType: "agent_verifier_task",
      subjectId: telemetry.taskId,
      artifactId,
      producerPrincipalId: input.producerPrincipalId ?? null,
      tool: "mendpoint-agent-verifier",
      toolVersion: "2026-08-17.v1",
      verdict: "unknown",
      createdAt: telemetry.observedAt,
    });
    if (owns) db.raw.exec("COMMIT"); else db.raw.exec(`RELEASE ${savepoint}`);
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    else if (!owns && db.raw.isTransaction) { db.raw.exec(`ROLLBACK TO ${savepoint}`); db.raw.exec(`RELEASE ${savepoint}`); }
    throw error;
  }
  return Object.freeze({ artifactId, evidenceId, telemetryDigest: telemetry.telemetryDigest });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
