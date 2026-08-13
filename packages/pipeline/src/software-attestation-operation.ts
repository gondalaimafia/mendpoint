import { createHash } from "node:crypto";
import {
  appendDomainEvent,
  verifyDomainEventIntegrity,
  insertArtifactManifest,
  insertEvidenceRecord,
  type AppDb,
  type ArtifactManifestRow,
} from "@mendpoint/db";
import {
  createSoftwareAttestationStatementV1,
  signSoftwareAttestation,
  type DsseEnvelope,
  type SoftwareAttestationScope,
  type SoftwareAttestationSigner,
  type SoftwareAttestationStatementV1,
  type SoftwareAttestationTrustPolicy,
  verifySoftwareAttestation,
} from "@mendpoint/contract";

export type SoftwareAttestationArtifactRefs = Readonly<{
  sourceIds: readonly string[];
  snapshotId: string;
  candidateId: string;
  verificationIds: readonly string[];
  policyId: string;
  deliveryId: string | null;
  rollbackId: string | null;
  waiverId: string | null;
}>;

export type IssueSoftwareAttestationInput = Readonly<{
  tenantId: string;
  repositoryId: string;
  runId: string;
  correlationId: string;
  actorPrincipalId: string;
  idempotencyKey: string;
  outcome: "passed" | "failed" | "waived";
  issuedAt: string;
  artifacts: SoftwareAttestationArtifactRefs;
}>;

export type IssuedSoftwareAttestation = Readonly<{
  attestationId: string;
  artifactId: string;
  scope: SoftwareAttestationScope;
  statement: SoftwareAttestationStatementV1;
  envelope: DsseEnvelope;
}>;

export type SoftwareAttestationOperationDependencies = Readonly<{
  enabled?: boolean;
  signer: SoftwareAttestationSigner;
  producerService?: string;
  producerVersion?: string;
  authorizeScope?(db: AppDb, input: IssueSoftwareAttestationInput, scope: SoftwareAttestationScope): boolean;
}>;

const SHA256 = /^[a-f0-9]{64}$/;

export async function issueSoftwareAttestation(
  db: AppDb,
  input: IssueSoftwareAttestationInput,
  dependencies: SoftwareAttestationOperationDependencies,
): Promise<IssuedSoftwareAttestation> {
  if (dependencies.enabled !== true) throw new Error("software_attestation_disabled");
  validateInput(input);
  const requestDigest = sha256(canonicalJson({ ...input, issuedAt: undefined }));
  const replay = replayByIdempotency(db, input.tenantId, input.idempotencyKey, requestDigest);
  if (replay) return replay;

  const scope = resolveScope(db, input);
  const authorized = dependencies.authorizeScope?.(db, input, scope);
  if (!authorized) throw new Error("software_attestation_scope_not_authoritative");
  const attestationId = `attestation_${sha256(`${input.tenantId}\0${input.idempotencyKey}\0${requestDigest}`)}`;
  const statement = createSoftwareAttestationStatementV1({
    attestationId,
    scope: mutableScope(scope),
    producer: {
      principalId: input.actorPrincipalId,
      service: dependencies.producerService ?? "mendpoint-attestation",
      version: dependencies.producerVersion ?? "1",
    },
    outcome: input.outcome,
    issuedAt: input.issuedAt,
  });
  const envelope = await signSoftwareAttestation(statement, dependencies.signer);
  const content = canonicalJson(envelope);
  const artifactId = `artifact_${sha256(`${attestationId}\0${sha256(content)}`)}`;

  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const raced = replayByIdempotency(db, input.tenantId, input.idempotencyKey, requestDigest);
    if (raced) { db.raw.exec("COMMIT"); return raced; }
    insertArtifactManifest(db, {
      id: artifactId,
      tenantId: input.tenantId,
      kind: "software_attestation_dsse",
      schemaVersion: 1,
      sha256: sha256(content),
      mediaType: "application/vnd.dsse.envelope.v1+json",
      sizeBytes: Buffer.byteLength(content),
      storageRef: `sqlite://artifact_manifests/${artifactId}#content_text`,
      content,
      producerPrincipalId: input.actorPrincipalId,
      createdAt: input.issuedAt,
    });
    insertEvidenceRecord(db, {
      id: `evidence_${sha256(attestationId)}`,
      tenantId: input.tenantId,
      subjectType: "software_attestation",
      subjectId: attestationId,
      artifactId,
      inputArtifactId: scope.candidateArtifact.artifactId,
      producerPrincipalId: input.actorPrincipalId,
      tool: "mendpoint-attestation",
      toolVersion: dependencies.producerVersion ?? "1",
      verdict: input.outcome === "passed" ? "passed" : input.outcome === "waived" ? "waived" : "failed",
      createdAt: input.issuedAt,
    });
    appendDomainEvent(db, {
      id: `event_${sha256(`${attestationId}\0issued`)}`,
      tenantId: input.tenantId,
      schemaVersion: 1,
      eventType: "software_attestation.issued",
      aggregateType: "software_attestation",
      aggregateId: attestationId,
      actorPrincipalId: input.actorPrincipalId,
      correlationId: input.correlationId,
      idempotencyKey: `software-attestation:${input.idempotencyKey}`,
      payload: { requestDigest, artifactId, attestationId, repositoryId: input.repositoryId, runId: input.runId, correlationId: input.correlationId, actorPrincipalId: input.actorPrincipalId, outcome: input.outcome, artifacts: input.artifacts },
      createdAt: input.issuedAt,
    });
    db.raw.exec("COMMIT");
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
  return freezeIssued({ attestationId, artifactId, scope, statement, envelope });
}


export function readSoftwareAttestation(db: AppDb, tenantId: string, attestationId: string): IssuedSoftwareAttestation | undefined {
  if (!verifyDomainEventIntegrity(db, tenantId).ok) throw new Error("software_attestation_event_integrity_invalid");
  const event = db.raw.prepare(
    "SELECT payload_json FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'software_attestation' AND aggregate_id = ? AND event_type = 'software_attestation.issued'",
  ).get(tenantId, attestationId) as { payload_json: string } | undefined;
  if (!event) return undefined;
  const payload = JSON.parse(event.payload_json) as { artifactId: string };
  return readArtifact(db, tenantId, payload.artifactId, attestationId);
}

export async function verifyStoredSoftwareAttestation(db: AppDb, input: Readonly<{ tenantId: string; attestationId: string; verifiedAt: string; trustPolicy: SoftwareAttestationTrustPolicy }>) {
  if (!verifyDomainEventIntegrity(db, input.tenantId).ok) throw new Error("software_attestation_event_integrity_invalid");
  const event = db.raw.prepare("SELECT payload_json, actor_principal_id FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'software_attestation' AND aggregate_id = ? AND event_type = 'software_attestation.issued'").get(input.tenantId, input.attestationId) as { payload_json: string; actor_principal_id: string } | undefined;
  if (!event) throw new Error("software_attestation_not_found");
  const payload = JSON.parse(event.payload_json) as { artifactId?: string; repositoryId?: string; runId?: string; correlationId?: string; actorPrincipalId?: string; outcome?: IssueSoftwareAttestationInput["outcome"]; artifacts?: SoftwareAttestationArtifactRefs };
  if (!payload.artifactId || !payload.repositoryId || !payload.runId || !payload.correlationId || !payload.actorPrincipalId || !payload.outcome || !payload.artifacts) throw new Error("software_attestation_event_corrupt");
  const issued = readArtifact(db, input.tenantId, payload.artifactId, input.attestationId);
  const expectedScope = resolveScope(db, { tenantId: input.tenantId, repositoryId: payload.repositoryId, runId: payload.runId, correlationId: payload.correlationId, actorPrincipalId: payload.actorPrincipalId, idempotencyKey: "verification", outcome: payload.outcome, issuedAt: issued.statement.predicate.issuedAt, artifacts: payload.artifacts });
  const verified = await verifySoftwareAttestation({ envelope: issued.envelope, expectedScope: mutableScope(expectedScope), verifiedAt: input.verifiedAt, trustPolicy: input.trustPolicy });
  if (verified.key.principalId !== event.actor_principal_id || verified.statement.predicate.producer.principalId !== event.actor_principal_id || payload.actorPrincipalId !== event.actor_principal_id) throw new Error("software_attestation_principal_binding_invalid");
  return verified;
}

function replayByIdempotency(db: AppDb, tenantId: string, key: string, requestDigest: string): IssuedSoftwareAttestation | undefined {
  const event = db.raw.prepare("SELECT aggregate_id, payload_json FROM domain_events WHERE tenant_id = ? AND idempotency_key = ?")
    .get(tenantId, `software-attestation:${key}`) as { aggregate_id: string; payload_json: string } | undefined;
  if (!event) return undefined;
  const payload = JSON.parse(event.payload_json) as { requestDigest?: string; artifactId?: string };
  if (payload.requestDigest !== requestDigest || typeof payload.artifactId !== "string") throw new Error("software_attestation_idempotency_conflict");
  return readArtifact(db, tenantId, payload.artifactId, event.aggregate_id);
}

function readArtifact(db: AppDb, tenantId: string, artifactId: string, attestationId: string): IssuedSoftwareAttestation {
  const row = db.raw.prepare("SELECT * FROM artifact_manifests WHERE id = ? AND tenant_id = ? AND kind = 'software_attestation_dsse'")
    .get(artifactId, tenantId) as ArtifactManifestRow | undefined;
  if (!row?.content_text || sha256(row.content_text) !== row.sha256) throw new Error("software_attestation_artifact_corrupt");
  const envelope = JSON.parse(row.content_text) as DsseEnvelope;
  const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as SoftwareAttestationStatementV1;
  if (statement.predicate.attestationId !== attestationId) throw new Error("software_attestation_artifact_mismatch");
  return freezeIssued({ attestationId, artifactId, scope: statement.predicate.scope, statement, envelope });
}

function resolveScope(db: AppDb, input: IssueSoftwareAttestationInput): SoftwareAttestationScope {
  const artifact = (id: string, role: "source" | "snapshot" | "candidate" | "verification" | "policy" | "delivery" | "rollback" | "waiver") => {
    const row = db.raw.prepare("SELECT id, tenant_id, kind, sha256, content_text FROM artifact_manifests WHERE id = ? AND tenant_id = ?").get(id, input.tenantId) as { id: string; tenant_id: string; kind: string; sha256: string; content_text: string | null } | undefined;
    if (!row && role === "snapshot") {
      const snapshot = db.raw.prepare("SELECT id, tenant_id, repository_id, manifest_sha256 FROM repository_snapshots WHERE id = ? AND tenant_id = ? AND repository_id = ?").get(id, input.tenantId, input.repositoryId) as { id: string; tenant_id: string; repository_id: string; manifest_sha256: string } | undefined;
      if (!snapshot || !SHA256.test(snapshot.manifest_sha256)) throw new Error("software_attestation_artifact_not_authoritative");
      return Object.freeze({ artifactId: snapshot.id, sha256: snapshot.manifest_sha256 });
    }
    if (!row || !SHA256.test(row.sha256) || !artifactKindMatches(row.kind, role)) throw new Error("software_attestation_artifact_not_authoritative");
    if (row.content_text) {
      if (sha256(row.content_text) !== row.sha256) throw new Error("software_attestation_artifact_not_authoritative");
      let content: unknown;
      try { content = JSON.parse(row.content_text); } catch { content = undefined; }
      if (content && typeof content === "object" && !Array.isArray(content)) {
        const bindings = content as Record<string, unknown>;
        for (const [key, expected] of [["tenantId", input.tenantId], ["repositoryId", input.repositoryId], ["runId", input.runId], ["correlationId", input.correlationId]] as const) {
          if (bindings[key] !== undefined && bindings[key] !== expected) throw new Error("software_attestation_artifact_binding_mismatch");
        }
      }
    }
    return Object.freeze({ artifactId: row.id, sha256: row.sha256 });
  };
  return Object.freeze({
    tenantId: input.tenantId,
    repositoryId: input.repositoryId,
    runId: input.runId,
    correlationId: input.correlationId,
    sourceArtifacts: Object.freeze(input.artifacts.sourceIds.map((id) => artifact(id, "source"))),
    snapshotArtifact: artifact(input.artifacts.snapshotId, "snapshot"),
    candidateArtifact: artifact(input.artifacts.candidateId, "candidate"),
    verificationArtifacts: Object.freeze(input.artifacts.verificationIds.map((id) => artifact(id, "verification"))),
    policyArtifact: artifact(input.artifacts.policyId, "policy"),
    deliveryArtifact: input.artifacts.deliveryId ? artifact(input.artifacts.deliveryId, "delivery") : null,
    rollbackArtifact: input.artifacts.rollbackId ? artifact(input.artifacts.rollbackId, "rollback") : null,
    waiverArtifact: input.artifacts.waiverId ? artifact(input.artifacts.waiverId, "waiver") : null,
  });
}

function artifactKindMatches(kind: string, role: string): boolean {
  const normalized = kind.toLowerCase();
  if (role === "policy") return normalized.includes("policy") || normalized.includes("gate");
  if (role === "delivery") return normalized.includes("delivery") || normalized.includes("package");
  return normalized.includes(role);
}

function validateInput(input: IssueSoftwareAttestationInput): void {
  for (const value of [input.tenantId, input.repositoryId, input.runId, input.correlationId, input.actorPrincipalId, input.idempotencyKey]) if (typeof value !== "string" || !value.trim()) throw new Error("software_attestation_input_invalid");
  if (!Number.isFinite(Date.parse(input.issuedAt)) || input.artifacts.sourceIds.length === 0 || input.artifacts.verificationIds.length === 0) throw new Error("software_attestation_input_invalid");
  if ((input.outcome === "waived") !== (input.artifacts.waiverId !== null)) throw new Error("software_attestation_waiver_mismatch");
}

function mutableScope(scope: SoftwareAttestationScope) { return JSON.parse(JSON.stringify(scope)); }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
function freezeIssued(value: IssuedSoftwareAttestation): IssuedSoftwareAttestation { return Object.freeze({ ...value, scope: Object.freeze(value.scope), statement: Object.freeze(value.statement), envelope: Object.freeze(value.envelope) }); }
