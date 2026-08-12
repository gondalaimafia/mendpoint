import {
  createPublicKey,
  createHash,
  KeyObject,
  verify as verifyBytes,
  type KeyLike,
} from "node:crypto";

export const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1" as const;
export const DSSE_IN_TOTO_PAYLOAD_TYPE = "application/vnd.in-toto+json" as const;
export const MENDPOINT_SOFTWARE_ATTESTATION_PREDICATE_V1 =
  "https://mendpoint.ai/attestations/software/v1" as const;
export const SOFTWARE_ATTESTATION_MAX_PAYLOAD_BYTES = 1024 * 1024;

const DIGEST = /^[a-f0-9]{64}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_ARTIFACTS = 64;
const MAX_SIGNATURES = 64;
const MAX_ID_BYTES = 512;
const MAX_VERSION_BYTES = 128;

type MaybePromise<T> = T | Promise<T>;

export type SoftwareAttestationArtifactInput = {
  artifactId: string;
  sha256: string;
};

export type SoftwareAttestationScopeInput = {
  tenantId: string;
  repositoryId: string;
  runId: string;
  correlationId: string;
  sourceArtifacts: SoftwareAttestationArtifactInput[];
  snapshotArtifact: SoftwareAttestationArtifactInput;
  candidateArtifact: SoftwareAttestationArtifactInput;
  verificationArtifacts: SoftwareAttestationArtifactInput[];
  policyArtifact: SoftwareAttestationArtifactInput;
  deliveryArtifact: SoftwareAttestationArtifactInput | null;
  rollbackArtifact: SoftwareAttestationArtifactInput | null;
  waiverArtifact: SoftwareAttestationArtifactInput | null;
};

export type SoftwareAttestationExpectedScope = SoftwareAttestationScopeInput;

export type SoftwareAttestationStatementInput = {
  attestationId: string;
  scope: SoftwareAttestationScopeInput;
  producer: {
    principalId: string;
    service: string;
    version: string;
  };
  outcome: "passed" | "failed" | "waived";
  issuedAt: string;
};

export type SoftwareAttestationArtifact = Readonly<{
  artifactId: string;
  sha256: string;
}>;

export type SoftwareAttestationScope = Readonly<{
  tenantId: string;
  repositoryId: string;
  runId: string;
  correlationId: string;
  sourceArtifacts: readonly SoftwareAttestationArtifact[];
  snapshotArtifact: SoftwareAttestationArtifact;
  candidateArtifact: SoftwareAttestationArtifact;
  verificationArtifacts: readonly SoftwareAttestationArtifact[];
  policyArtifact: SoftwareAttestationArtifact;
  deliveryArtifact: SoftwareAttestationArtifact | null;
  rollbackArtifact: SoftwareAttestationArtifact | null;
  waiverArtifact: SoftwareAttestationArtifact | null;
}>;

export type SoftwareAttestationStatementV1 = Readonly<{
  _type: typeof IN_TOTO_STATEMENT_V1;
  subject: readonly Readonly<{
    name: string;
    digest: Readonly<{ sha256: string }>;
  }>[];
  predicateType: typeof MENDPOINT_SOFTWARE_ATTESTATION_PREDICATE_V1;
  predicate: Readonly<{
    schemaVersion: 1;
    attestationId: string;
    scope: SoftwareAttestationScope;
    scopeSha256: string;
    producer: Readonly<{
      principalId: string;
      service: string;
      version: string;
    }>;
    outcome: "passed" | "failed" | "waived";
    issuedAt: string;
  }>;
}>;

export type DsseEnvelope = Readonly<{
  payloadType: typeof DSSE_IN_TOTO_PAYLOAD_TYPE;
  payload: string;
  signatures: readonly Readonly<{
    keyid?: string;
    sig: string;
  }>[];
}>;

export type SoftwareAttestationSigner = Readonly<{
  keyId: string;
  algorithm: "ed25519";
  sign(bytes: Uint8Array): MaybePromise<Uint8Array>;
}>;

export type SoftwareAttestationTrustedKey = Readonly<{
  keyId: string;
  algorithm: "ed25519";
  publicKey: KeyLike;
  principalId: string;
  service: string;
  tenantIds: readonly string[];
  predicateTypes: readonly string[];
  validFrom: string;
  validUntil: string;
  revokedAt: string | null;
}>;

export type SoftwareAttestationTrustPolicy = Readonly<{
  resolve?(keyId: string): MaybePromise<SoftwareAttestationTrustedKey | null>;
  candidates?(): MaybePromise<readonly SoftwareAttestationTrustedKey[]>;
  threshold?: number;
}>;

type SnapshotTrustedKey = Omit<SoftwareAttestationTrustedKey, "publicKey"> & Readonly<{
  publicKey: KeyObject;
  publicKeySha256: string;
}>;

export type VerifiedSoftwareAttestation = Readonly<{
  statement: SoftwareAttestationStatementV1;
  key: Readonly<{
    keyId: string;
    principalId: string;
    service: string;
  }>;
  keys: readonly Readonly<{
    keyId: string;
    principalId: string;
    service: string;
  }>[];
  verifiedAt: string;
}>;

function fail(code: string): never {
  throw new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) fail(code);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(code);
  }
}

function requiredKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  code: string,
): void {
  if (required.some((key) => !Object.hasOwn(value, key))) fail(code);
}

function text(value: unknown, code: string, maxBytes = MAX_ID_BYTES): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(code);
  }
  return value;
}

function timestamp(value: unknown, code: string): string {
  const candidate = text(value, code, 64);
  const parsed = Date.parse(candidate);
  if (
    !CANONICAL_TIMESTAMP.test(candidate) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== candidate
  ) {
    fail(code);
  }
  return candidate;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function artifact(value: unknown): SoftwareAttestationArtifact {
  const candidate = record(value, "software_attestation_artifact_invalid");
  exactKeys(
    candidate,
    ["artifactId", "sha256"],
    "software_attestation_artifact_invalid",
  );
  const artifactId = text(
    candidate.artifactId,
    "software_attestation_artifact_id_invalid",
  );
  const digest = text(candidate.sha256, "software_attestation_artifact_digest_invalid", 64);
  if (!DIGEST.test(digest)) fail("software_attestation_artifact_digest_invalid");
  return Object.freeze({ artifactId, sha256: digest });
}

function artifactList(value: unknown): readonly SoftwareAttestationArtifact[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_ARTIFACTS
  ) {
    fail("software_attestation_artifact_list_invalid");
  }
  const normalized: SoftwareAttestationArtifact[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) fail("software_attestation_artifact_list_invalid");
    const item = artifact(value[index]);
    if (ids.has(item.artifactId)) fail("software_attestation_artifact_duplicate");
    ids.add(item.artifactId);
    normalized.push(item);
  }
  normalized.sort(
    (left, right) =>
      compareText(left.artifactId, right.artifactId) ||
      compareText(left.sha256, right.sha256),
  );
  return Object.freeze(normalized);
}

function optionalArtifact(value: unknown): SoftwareAttestationArtifact | null {
  return value === null ? null : artifact(value);
}

function normalizeScope(value: unknown): SoftwareAttestationScope {
  const candidate = record(value, "software_attestation_scope_invalid");
  exactKeys(candidate, [
    "candidateArtifact",
    "correlationId",
    "deliveryArtifact",
    "policyArtifact",
    "repositoryId",
    "rollbackArtifact",
    "runId",
    "snapshotArtifact",
    "sourceArtifacts",
    "tenantId",
    "verificationArtifacts",
    "waiverArtifact",
  ], "software_attestation_scope_invalid");

  const scope = {
    tenantId: text(candidate.tenantId, "software_attestation_tenant_invalid", 256),
    repositoryId: text(
      candidate.repositoryId,
      "software_attestation_repository_invalid",
      1024,
    ),
    runId: text(candidate.runId, "software_attestation_run_invalid"),
    correlationId: text(
      candidate.correlationId,
      "software_attestation_correlation_invalid",
    ),
    sourceArtifacts: artifactList(candidate.sourceArtifacts),
    snapshotArtifact: artifact(candidate.snapshotArtifact),
    candidateArtifact: artifact(candidate.candidateArtifact),
    verificationArtifacts: artifactList(candidate.verificationArtifacts),
    policyArtifact: artifact(candidate.policyArtifact),
    deliveryArtifact: optionalArtifact(candidate.deliveryArtifact),
    rollbackArtifact: optionalArtifact(candidate.rollbackArtifact),
    waiverArtifact: optionalArtifact(candidate.waiverArtifact),
  } satisfies SoftwareAttestationScope;

  const all = [
    ...scope.sourceArtifacts,
    scope.snapshotArtifact,
    scope.candidateArtifact,
    ...scope.verificationArtifacts,
    scope.policyArtifact,
    scope.deliveryArtifact,
    scope.rollbackArtifact,
    scope.waiverArtifact,
  ].filter((item): item is SoftwareAttestationArtifact => item !== null);
  const ids = new Set<string>();
  for (const item of all) {
    if (ids.has(item.artifactId)) fail("software_attestation_artifact_duplicate");
    ids.add(item.artifactId);
  }
  return deepFreeze(scope);
}

function producer(value: unknown): SoftwareAttestationStatementV1["predicate"]["producer"] {
  const candidate = record(value, "software_attestation_producer_invalid");
  exactKeys(
    candidate,
    ["principalId", "service", "version"],
    "software_attestation_producer_invalid",
  );
  return Object.freeze({
    principalId: text(
      candidate.principalId,
      "software_attestation_producer_principal_invalid",
    ),
    service: text(candidate.service, "software_attestation_producer_service_invalid"),
    version: text(
      candidate.version,
      "software_attestation_producer_version_invalid",
      MAX_VERSION_BYTES,
    ),
  });
}

function outcome(value: unknown): SoftwareAttestationStatementV1["predicate"]["outcome"] {
  if (value !== "passed" && value !== "failed" && value !== "waived") {
    fail("software_attestation_outcome_invalid");
  }
  return value;
}

export function createSoftwareAttestationStatementV1(
  input: SoftwareAttestationStatementInput,
): SoftwareAttestationStatementV1 {
  const candidate = record(input, "software_attestation_input_invalid");
  exactKeys(
    candidate,
    ["attestationId", "issuedAt", "outcome", "producer", "scope"],
    "software_attestation_input_invalid",
  );
  const scope = normalizeScope(candidate.scope);
  const statement: SoftwareAttestationStatementV1 = {
    _type: IN_TOTO_STATEMENT_V1,
    subject: [{
      name: scope.candidateArtifact.artifactId,
      digest: { sha256: scope.candidateArtifact.sha256 },
    }],
    predicateType: MENDPOINT_SOFTWARE_ATTESTATION_PREDICATE_V1,
    predicate: {
      schemaVersion: 1,
      attestationId: text(
        candidate.attestationId,
        "software_attestation_id_invalid",
      ),
      scope,
      scopeSha256: sha256(canonicalJson(scope)),
      producer: producer(candidate.producer),
      outcome: outcome(candidate.outcome),
      issuedAt: timestamp(candidate.issuedAt, "software_attestation_issued_at_invalid"),
    },
  };
  return deepFreeze(statement);
}

function parseStatement(value: unknown): SoftwareAttestationStatementV1 {
  const statement = record(value, "software_attestation_statement_invalid");
  requiredKeys(
    statement,
    ["_type", "predicate", "predicateType", "subject"],
    "software_attestation_statement_invalid",
  );
  if (statement._type !== IN_TOTO_STATEMENT_V1) {
    fail("software_attestation_statement_type_invalid");
  }
  if (statement.predicateType !== MENDPOINT_SOFTWARE_ATTESTATION_PREDICATE_V1) {
    fail("software_attestation_predicate_type_invalid");
  }
  const predicate = record(
    statement.predicate,
    "software_attestation_predicate_invalid",
  );
  requiredKeys(predicate, [
    "attestationId",
    "issuedAt",
    "outcome",
    "producer",
    "schemaVersion",
    "scope",
    "scopeSha256",
  ], "software_attestation_predicate_invalid");
  if (predicate.schemaVersion !== 1) fail("software_attestation_schema_version_invalid");

  const scope = normalizeScope(predicate.scope);
  if (canonicalJson(predicate.scope) !== canonicalJson(scope)) {
    fail("software_attestation_statement_noncanonical");
  }
  const scopeSha256 = text(
    predicate.scopeSha256,
    "software_attestation_scope_digest_invalid",
    64,
  );
  if (!DIGEST.test(scopeSha256) || scopeSha256 !== sha256(canonicalJson(scope))) {
    fail("software_attestation_scope_digest_invalid");
  }

  if (!Array.isArray(statement.subject) || statement.subject.length !== 1 || !(0 in statement.subject)) {
    fail("software_attestation_subject_invalid");
  }
  const subject = record(statement.subject[0], "software_attestation_subject_invalid");
  exactKeys(subject, ["digest", "name"], "software_attestation_subject_invalid");
  const subjectDigest = record(
    subject.digest,
    "software_attestation_subject_digest_invalid",
  );
  exactKeys(subjectDigest, ["sha256"], "software_attestation_subject_digest_invalid");
  if (
    subject.name !== scope.candidateArtifact.artifactId ||
    subjectDigest.sha256 !== scope.candidateArtifact.sha256
  ) {
    fail("software_attestation_subject_scope_mismatch");
  }

  return deepFreeze({
    _type: IN_TOTO_STATEMENT_V1,
    subject: [{
      name: scope.candidateArtifact.artifactId,
      digest: { sha256: scope.candidateArtifact.sha256 },
    }],
    predicateType: MENDPOINT_SOFTWARE_ATTESTATION_PREDICATE_V1,
    predicate: {
      schemaVersion: 1,
      attestationId: text(
        predicate.attestationId,
        "software_attestation_id_invalid",
      ),
      scope,
      scopeSha256,
      producer: producer(predicate.producer),
      outcome: outcome(predicate.outcome),
      issuedAt: timestamp(
        predicate.issuedAt,
        "software_attestation_issued_at_invalid",
      ),
    },
  });
}

export function canonicalSoftwareAttestationStatementJson(
  statement: SoftwareAttestationStatementV1,
): string {
  return canonicalJson(parseStatement(statement));
}

export function dssePreAuthEncode(
  payloadType: string,
  payload: Uint8Array,
): Uint8Array {
  const type = text(payloadType, "software_attestation_payload_type_invalid", 256);
  if (!(payload instanceof Uint8Array)) fail("software_attestation_payload_invalid");
  const typeBytes = Buffer.from(type, "utf8");
  const prefix = Buffer.from(
    `DSSEv1 ${typeBytes.byteLength} ${type} ${payload.byteLength} `,
    "utf8",
  );
  return new Uint8Array(Buffer.concat([prefix, Buffer.from(payload)]));
}

function strictBase64(value: unknown, code: string, maxBytes: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0) fail(code);
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 4) {
    fail(maxBytes === SOFTWARE_ATTESTATION_MAX_PAYLOAD_BYTES
      ? "software_attestation_payload_too_large"
      : code);
  }
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || /[+\/]/.test(value) && /[-_]/.test(value)) {
    fail(code);
  }
  const urlSafe = /[-_]/.test(value) || !value.endsWith("=");
  const bytes = Buffer.from(value, urlSafe ? "base64url" : "base64");
  const withoutPadding = value.replace(/=+$/, "");
  const canonical = urlSafe
    ? bytes.toString("base64url")
    : bytes.toString("base64").replace(/=+$/, "");
  if (withoutPadding !== canonical) fail(code);
  if (!urlSafe && value !== bytes.toString("base64")) fail(code);
  if (bytes.byteLength > maxBytes) {
    fail(maxBytes === SOFTWARE_ATTESTATION_MAX_PAYLOAD_BYTES
      ? "software_attestation_payload_too_large"
      : code);
  }
  return new Uint8Array(bytes);
}

export async function signSoftwareAttestation(
  statement: SoftwareAttestationStatementV1,
  signer: SoftwareAttestationSigner,
): Promise<DsseEnvelope> {
  const normalized = parseStatement(statement);
  const keyIdValue = signer?.keyId;
  const algorithm = signer?.algorithm;
  const signOperation = signer?.sign;
  const keyId = text(keyIdValue, "software_attestation_signer_key_invalid");
  if (algorithm !== "ed25519" || typeof signOperation !== "function") {
    fail("software_attestation_signer_invalid");
  }
  const payload = Buffer.from(canonicalJson(normalized), "utf8");
  if (payload.byteLength > SOFTWARE_ATTESTATION_MAX_PAYLOAD_BYTES) {
    fail("software_attestation_payload_too_large");
  }
  const preAuth = dssePreAuthEncode(DSSE_IN_TOTO_PAYLOAD_TYPE, payload);
  const supplied = await Reflect.apply(signOperation, signer, [new Uint8Array(preAuth)]);
  if (!(supplied instanceof Uint8Array) || supplied.byteLength !== 64) {
    fail("software_attestation_signature_invalid");
  }
  const signature = Buffer.from(new Uint8Array(supplied)).toString("base64");
  return deepFreeze({
    payloadType: DSSE_IN_TOTO_PAYLOAD_TYPE,
    payload: payload.toString("base64"),
    signatures: [{ keyid: keyId, sig: signature }],
  });
}

function parseEnvelope(value: unknown): Readonly<{
  payload: Uint8Array;
  signatures: readonly Readonly<{
    keyId: string | null;
    signature: Uint8Array;
  }>[];
}> {
  const envelope = record(value, "software_attestation_envelope_invalid");
  requiredKeys(
    envelope,
    ["payload", "payloadType", "signatures"],
    "software_attestation_envelope_invalid",
  );
  if (envelope.payloadType !== DSSE_IN_TOTO_PAYLOAD_TYPE) {
    fail("software_attestation_payload_type_invalid");
  }
  if (
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length === 0 ||
    envelope.signatures.length > MAX_SIGNATURES
  ) {
    fail("software_attestation_signatures_invalid");
  }
  const signatures: Array<Readonly<{ keyId: string | null; signature: Uint8Array }>> = [];
  for (let index = 0; index < envelope.signatures.length; index += 1) {
    if (!(index in envelope.signatures)) {
      fail("software_attestation_signatures_invalid");
    }
    const entry = record(
      envelope.signatures[index],
      "software_attestation_signature_invalid",
    );
    requiredKeys(entry, ["sig"], "software_attestation_signature_invalid");
    const signature = strictBase64(
      entry.sig,
      "software_attestation_signature_invalid",
      64,
    );
    if (signature.byteLength !== 64) fail("software_attestation_signature_invalid");
    const keyId = entry.keyid === undefined || entry.keyid === ""
      ? null
      : text(entry.keyid, "software_attestation_key_id_invalid");
    signatures.push(Object.freeze({ keyId, signature }));
  }
  return Object.freeze({
    payload: strictBase64(
      envelope.payload,
      "software_attestation_payload_invalid",
      SOFTWARE_ATTESTATION_MAX_PAYLOAD_BYTES,
    ),
    signatures: Object.freeze(signatures),
  });
}

function stringSet(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ARTIFACTS) {
    fail(code);
  }
  const normalized: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) fail(code);
    normalized.push(text(value[index], code, 1024));
  }
  if (new Set(normalized).size !== normalized.length) fail(code);
  return Object.freeze([...normalized].sort());
}

function snapshotTrustedKey(
  value: unknown,
  expectedKeyId: string | null,
): SnapshotTrustedKey {
  const key = record(value, "software_attestation_key_invalid");
  exactKeys(key, [
    "algorithm",
    "keyId",
    "predicateTypes",
    "principalId",
    "publicKey",
    "revokedAt",
    "service",
    "tenantIds",
    "validFrom",
    "validUntil",
  ], "software_attestation_key_invalid");
  const keyIdValue = key.keyId;
  const algorithm = key.algorithm;
  const publicKeyValue = key.publicKey;
  const principalIdValue = key.principalId;
  const serviceValue = key.service;
  const tenantIdsValue = key.tenantIds;
  const predicateTypesValue = key.predicateTypes;
  const validFromValue = key.validFrom;
  const validUntilValue = key.validUntil;
  const revokedAtValue = key.revokedAt;
  const keyId = text(keyIdValue, "software_attestation_key_id_invalid");
  if ((expectedKeyId !== null && keyId !== expectedKeyId) || algorithm !== "ed25519") {
    fail("software_attestation_key_invalid");
  }
  if (publicKeyValue === null || publicKeyValue === undefined) {
    fail("software_attestation_key_invalid");
  }
  let publicKey: KeyObject;
  try {
    if (publicKeyValue instanceof KeyObject) {
      if (publicKeyValue.type !== "public") fail("software_attestation_key_invalid");
      publicKey = createPublicKey({
        key: publicKeyValue.export({ format: "der", type: "spki" }),
        format: "der",
        type: "spki",
      });
    } else {
      publicKey = createPublicKey(publicKeyValue as KeyLike);
    }
  } catch {
    fail("software_attestation_key_invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("software_attestation_key_invalid");
  }
  const publicKeySha256 = sha256(
    publicKey.export({ format: "der", type: "spki" }),
  );
  const validFrom = timestamp(validFromValue, "software_attestation_key_time_invalid");
  const validUntil = timestamp(validUntilValue, "software_attestation_key_time_invalid");
  if (Date.parse(validUntil) <= Date.parse(validFrom)) {
    fail("software_attestation_key_time_invalid");
  }
  const revokedAt = revokedAtValue === null
    ? null
    : timestamp(revokedAtValue, "software_attestation_key_time_invalid");
  return Object.freeze({
    keyId,
    algorithm: "ed25519",
    publicKey,
    publicKeySha256,
    principalId: text(
      principalIdValue,
      "software_attestation_key_principal_invalid",
    ),
    service: text(serviceValue, "software_attestation_key_service_invalid"),
    tenantIds: stringSet(tenantIdsValue, "software_attestation_key_tenants_invalid"),
    predicateTypes: stringSet(
      predicateTypesValue,
      "software_attestation_key_predicates_invalid",
    ),
    validFrom,
    validUntil,
    revokedAt,
  });
}

function scopeMatches(
  actual: SoftwareAttestationScope,
  expected: SoftwareAttestationScope,
): boolean {
  return canonicalJson(actual) === canonicalJson(expected);
}

function keyTimeFailure(
  key: SnapshotTrustedKey,
  verifiedAtMs: number,
): string | null {
  if (key.revokedAt !== null && Date.parse(key.revokedAt) <= verifiedAtMs) {
    return "software_attestation_key_revoked";
  }
  if (verifiedAtMs < Date.parse(key.validFrom)) {
    return "software_attestation_key_not_yet_valid";
  }
  if (verifiedAtMs >= Date.parse(key.validUntil)) {
    return "software_attestation_key_expired";
  }
  return null;
}

function trustedKeyList(value: unknown): readonly SnapshotTrustedKey[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SIGNATURES) {
    fail("software_attestation_trust_policy_invalid");
  }
  const keys: SnapshotTrustedKey[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) fail("software_attestation_trust_policy_invalid");
    const key = snapshotTrustedKey(value[index], null);
    if (ids.has(key.keyId)) fail("software_attestation_trust_policy_invalid");
    ids.add(key.keyId);
    keys.push(key);
  }
  return Object.freeze(keys);
}

export async function verifySoftwareAttestation(input: Readonly<{
  envelope: DsseEnvelope;
  trustPolicy: SoftwareAttestationTrustPolicy;
  expectedScope: SoftwareAttestationExpectedScope;
  verifiedAt: string;
}>): Promise<VerifiedSoftwareAttestation> {
  const parsedEnvelope = parseEnvelope(input.envelope);
  const expectedScope = normalizeScope(input.expectedScope);
  const verifiedAt = timestamp(input.verifiedAt, "software_attestation_verified_at_invalid");
  const resolveOperation = input.trustPolicy?.resolve;
  const candidatesOperation = input.trustPolicy?.candidates;
  const configuredThreshold = input.trustPolicy?.threshold;
  if (typeof resolveOperation !== "function" && typeof candidatesOperation !== "function") {
    fail("software_attestation_trust_policy_invalid");
  }
  const threshold = configuredThreshold === undefined ? 1 : configuredThreshold;
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > MAX_SIGNATURES) {
    fail("software_attestation_signature_threshold_invalid");
  }
  const verifiedAtMs = Date.parse(verifiedAt);
  const preAuth = dssePreAuthEncode(
    DSSE_IN_TOTO_PAYLOAD_TYPE,
    parsedEnvelope.payload,
  );
  let unhintedCandidates: readonly SnapshotTrustedKey[] | null = null;
  const hintedCandidates = new Map<string, SnapshotTrustedKey | null>();
  const cryptographicallyVerified = new Map<string, SnapshotTrustedKey>();
  let timeFailure: string | null = null;
  let trustedCandidates = 0;
  for (const signature of parsedEnvelope.signatures) {
    let candidates: readonly SnapshotTrustedKey[];
    if (signature.keyId !== null) {
      if (typeof resolveOperation === "function") {
        if (!hintedCandidates.has(signature.keyId)) {
          const resolved = await Reflect.apply(resolveOperation, input.trustPolicy, [signature.keyId]);
          hintedCandidates.set(
            signature.keyId,
            resolved === null ? null : snapshotTrustedKey(resolved, signature.keyId),
          );
        }
        const resolved = hintedCandidates.get(signature.keyId) ?? null;
        candidates = resolved === null ? [] : [resolved];
      } else {
        if (unhintedCandidates === null) {
          unhintedCandidates = trustedKeyList(
            await Reflect.apply(candidatesOperation!, input.trustPolicy, []),
          );
        }
        candidates = unhintedCandidates.filter((key) => key.keyId === signature.keyId);
      }
    } else {
      if (typeof candidatesOperation !== "function") {
        fail("software_attestation_trust_policy_invalid");
      }
      if (unhintedCandidates === null) {
        unhintedCandidates = trustedKeyList(
          await Reflect.apply(candidatesOperation, input.trustPolicy, []),
        );
      }
      candidates = unhintedCandidates;
    }
    trustedCandidates += candidates.length;
    for (const key of candidates) {
      const unusable = keyTimeFailure(key, verifiedAtMs);
      if (unusable !== null) {
        timeFailure ??= unusable;
        continue;
      }
      let valid = false;
      try {
        valid = verifyBytes(null, preAuth, key.publicKey, signature.signature);
      } catch {
        fail("software_attestation_key_invalid");
      }
      if (valid) cryptographicallyVerified.set(key.publicKeySha256, key);
    }
  }
  if (cryptographicallyVerified.size < threshold) {
    if (trustedCandidates === 0) fail("software_attestation_key_untrusted");
    if (cryptographicallyVerified.size === 0 && timeFailure !== null) fail(timeFailure);
    if (cryptographicallyVerified.size === 0 && parsedEnvelope.signatures.length === 1) {
      fail("software_attestation_signature_invalid");
    }
    fail("software_attestation_signature_threshold_not_met");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(parsedEnvelope.payload).toString("utf8"));
  } catch {
    fail("software_attestation_statement_invalid");
  }
  const statement = parseStatement(decoded);
  if (!scopeMatches(statement.predicate.scope, expectedScope)) {
    fail("software_attestation_scope_mismatch");
  }
  const issuedAtMs = Date.parse(statement.predicate.issuedAt);
  if (issuedAtMs > verifiedAtMs) {
    fail("software_attestation_issued_at_invalid");
  }
  const authorized = [...cryptographicallyVerified.values()].filter((key) =>
    key.tenantIds.includes(statement.predicate.scope.tenantId) &&
    key.predicateTypes.includes(statement.predicateType) &&
    key.principalId === statement.predicate.producer.principalId &&
    key.service === statement.predicate.producer.service &&
    issuedAtMs >= Date.parse(key.validFrom) &&
    issuedAtMs < Date.parse(key.validUntil) &&
    (key.revokedAt === null || issuedAtMs < Date.parse(key.revokedAt))
  ).sort((left, right) => compareText(left.keyId, right.keyId));
  if (authorized.length < threshold) {
    if (authorized.length === 0) fail("software_attestation_key_unauthorized");
    fail("software_attestation_signature_threshold_not_met");
  }
  const verifiedKeys = authorized.map((key) => Object.freeze({
    keyId: key.keyId,
    principalId: key.principalId,
    service: key.service,
  }));
  const primaryKey = verifiedKeys[0]!;
  return deepFreeze({
    statement,
    key: primaryKey,
    keys: verifiedKeys,
    verifiedAt,
  });
}
