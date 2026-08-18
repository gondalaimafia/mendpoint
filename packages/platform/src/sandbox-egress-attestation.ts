import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";

export const SANDBOX_EGRESS_ATTESTATION_SCHEMA = "2026-08-18.v1" as const;
export const SANDBOX_EGRESS_FORBIDDEN_PROBE_URL = "https://example.com/" as const;
export const SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND =
  `node -e 'const c=new AbortController();setTimeout(()=>c.abort(),3000);fetch("${SANDBOX_EGRESS_FORBIDDEN_PROBE_URL}",{method:"HEAD",signal:c.signal,redirect:"manual"}).then(()=>process.exit(42),()=>process.exit(0))'`;
export const SANDBOX_EGRESS_ALLOWED_PROBE_COMMAND =
  "node -e 'process.stdout.write(\"mendpoint-egress-allowed\\n\")'";
export const SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST =
  `sha256:${createHash("sha256").update(SANDBOX_EGRESS_ALLOWED_PROBE_COMMAND, "utf8").digest("hex")}`;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const IMAGE = /^[a-z0-9][a-z0-9./_-]{1,300}@sha256:[a-f0-9]{64}$/u;
const APP = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const MAX_ENVELOPE_BYTES = 32 * 1024;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export type SandboxEgressAttestationPayload = Readonly<{
  schemaVersion: typeof SANDBOX_EGRESS_ATTESTATION_SCHEMA;
  app: string;
  image: string;
  policyDigest: string;
  testedAt: string;
  expiresAt: string;
  forbiddenOutbound: Readonly<{
    url: typeof SANDBOX_EGRESS_FORBIDDEN_PROBE_URL;
    blocked: true;
  }>;
  allowedVerification: Readonly<{
    commandDigest: string;
    passed: true;
  }>;
  evidenceRefs: readonly string[];
}>;

export type SandboxEgressAuthorityConfig = Readonly<{
  attestationBase64?: string;
  publicKeySpkiBase64?: string;
  expectedKeyId?: string;
  expectedPolicyDigest?: string;
  now?: () => string;
}>;

type AttestationEnvelope = Readonly<{
  payload: string;
  signatures: readonly Readonly<{ keyId: string; signature: string }>[];
}>;

function fail(code: string): never {
  throw new Error(code);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], code: string): void {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const wanted = [...expected].sort(codeUnitCompare);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(code);
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function canonicalTimestamp(value: unknown, code: string): string {
  if (typeof value !== "string") fail(code);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) fail(code);
  return value;
}

function canonicalBase64(value: unknown, maxBytes: number, code: string): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.length > maxBytes * 2) fail(code);
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, "base64");
  } catch {
    fail(code);
  }
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64") !== value) fail(code);
  return bytes;
}

function text(value: unknown, max: number, code: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(code);
  return value;
}

function normalizePayload(value: unknown): SandboxEgressAttestationPayload {
  const payload = object(value, "sandbox_egress_attestation_payload_invalid");
  exactKeys(payload, [
    "schemaVersion", "app", "image", "policyDigest", "testedAt", "expiresAt",
    "forbiddenOutbound", "allowedVerification", "evidenceRefs",
  ], "sandbox_egress_attestation_payload_invalid");
  if (payload.schemaVersion !== SANDBOX_EGRESS_ATTESTATION_SCHEMA) fail("sandbox_egress_attestation_schema_invalid");
  const app = text(payload.app, 63, "sandbox_egress_attestation_scope_invalid");
  const image = text(payload.image, 380, "sandbox_egress_attestation_scope_invalid");
  const policyDigest = text(payload.policyDigest, 71, "sandbox_egress_attestation_scope_invalid");
  if (!APP.test(app) || !IMAGE.test(image) || !DIGEST.test(policyDigest)) fail("sandbox_egress_attestation_scope_invalid");
  const testedAt = canonicalTimestamp(payload.testedAt, "sandbox_egress_attestation_time_invalid");
  const expiresAt = canonicalTimestamp(payload.expiresAt, "sandbox_egress_attestation_time_invalid");
  const forbidden = object(payload.forbiddenOutbound, "sandbox_egress_attestation_probe_invalid");
  exactKeys(forbidden, ["url", "blocked"], "sandbox_egress_attestation_probe_invalid");
  if (forbidden.url !== SANDBOX_EGRESS_FORBIDDEN_PROBE_URL || forbidden.blocked !== true) fail("sandbox_egress_attestation_probe_invalid");
  const allowed = object(payload.allowedVerification, "sandbox_egress_attestation_probe_invalid");
  exactKeys(allowed, ["commandDigest", "passed"], "sandbox_egress_attestation_probe_invalid");
  if (allowed.commandDigest !== SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST || allowed.passed !== true) fail("sandbox_egress_attestation_probe_invalid");
  if (!Array.isArray(payload.evidenceRefs) || payload.evidenceRefs.length < 1 || payload.evidenceRefs.length > 32) fail("sandbox_egress_attestation_evidence_invalid");
  const evidenceRefs = payload.evidenceRefs.map((ref) => text(ref, 512, "sandbox_egress_attestation_evidence_invalid"));
  const sortedRefs = [...evidenceRefs].sort(codeUnitCompare);
  if (new Set(sortedRefs).size !== sortedRefs.length || sortedRefs.some((ref, index) => ref !== evidenceRefs[index])) fail("sandbox_egress_attestation_evidence_invalid");
  return Object.freeze({
    schemaVersion: SANDBOX_EGRESS_ATTESTATION_SCHEMA,
    app,
    image,
    policyDigest,
    testedAt,
    expiresAt,
    forbiddenOutbound: Object.freeze({ url: SANDBOX_EGRESS_FORBIDDEN_PROBE_URL, blocked: true }),
    allowedVerification: Object.freeze({ commandDigest: SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST, passed: true }),
    evidenceRefs: Object.freeze(sortedRefs),
  });
}

export function sandboxEgressAttestationPayloadBytes(
  payload: SandboxEgressAttestationPayload,
): Buffer {
  const normalized = normalizePayload(structuredClone(payload));
  return Buffer.from(JSON.stringify(normalized), "utf8");
}

export function verifySandboxEgressAttestation(input: Readonly<
  SandboxEgressAuthorityConfig & {
    expectedApp: string;
    expectedImage: string;
    observedAt: string;
  }
>): SandboxEgressAttestationPayload {
  const attestationBase64 = input.attestationBase64?.trim();
  const publicKeySpkiBase64 = input.publicKeySpkiBase64?.trim();
  const expectedKeyId = input.expectedKeyId?.trim();
  const expectedPolicyDigest = input.expectedPolicyDigest?.trim();
  if (!attestationBase64 || !publicKeySpkiBase64 || !expectedKeyId || !expectedPolicyDigest) {
    fail("sandbox_egress_attestation_required");
  }
  if (!KEY_ID.test(expectedKeyId) || !DIGEST.test(expectedPolicyDigest)) fail("sandbox_egress_attestation_config_invalid");
  const observedAt = canonicalTimestamp(input.observedAt, "sandbox_egress_attestation_time_invalid");
  const envelopeBytes = canonicalBase64(attestationBase64, MAX_ENVELOPE_BYTES, "sandbox_egress_attestation_invalid");
  let envelopeValue: unknown;
  try {
    envelopeValue = JSON.parse(envelopeBytes.toString("utf8"));
  } catch {
    fail("sandbox_egress_attestation_invalid");
  }
  const envelope = object(envelopeValue, "sandbox_egress_attestation_invalid");
  exactKeys(envelope, ["payload", "signatures"], "sandbox_egress_attestation_invalid");
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) fail("sandbox_egress_attestation_signature_invalid");
  const signatureValue = object(envelope.signatures[0], "sandbox_egress_attestation_signature_invalid");
  exactKeys(signatureValue, ["keyId", "signature"], "sandbox_egress_attestation_signature_invalid");
  if (signatureValue.keyId !== expectedKeyId) fail("sandbox_egress_attestation_signature_invalid");
  const payloadBytes = canonicalBase64(envelope.payload, MAX_PAYLOAD_BYTES, "sandbox_egress_attestation_payload_invalid");
  const signatureBytes = canonicalBase64(signatureValue.signature, 128, "sandbox_egress_attestation_signature_invalid");
  const publicKeyBytes = canonicalBase64(publicKeySpkiBase64, 1024, "sandbox_egress_attestation_key_invalid");
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    publicKey = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
  } catch {
    fail("sandbox_egress_attestation_key_invalid");
  }
  if (publicKey.asymmetricKeyType !== "ed25519" || !verify(null, payloadBytes, publicKey, signatureBytes)) {
    fail("sandbox_egress_attestation_signature_invalid");
  }
  let payloadValue: unknown;
  try {
    payloadValue = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    fail("sandbox_egress_attestation_payload_invalid");
  }
  const payload = normalizePayload(payloadValue);
  if (!sandboxEgressAttestationPayloadBytes(payload).equals(payloadBytes)) fail("sandbox_egress_attestation_payload_invalid");
  if (payload.app !== input.expectedApp || payload.image !== input.expectedImage || payload.policyDigest !== expectedPolicyDigest) {
    fail("sandbox_egress_attestation_scope_mismatch");
  }
  const observed = Date.parse(observedAt);
  const tested = Date.parse(payload.testedAt);
  const expires = Date.parse(payload.expiresAt);
  if (tested > observed || expires <= tested || expires - tested > MAX_LIFETIME_MS) fail("sandbox_egress_attestation_time_invalid");
  if (observed >= expires) fail("sandbox_egress_attestation_expired");
  return payload;
}

export function sandboxEgressAuthorityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SandboxEgressAuthorityConfig {
  return Object.freeze({
    attestationBase64: env.MENDPOINT_SANDBOX_EGRESS_ATTESTATION_BASE64,
    publicKeySpkiBase64: env.MENDPOINT_SANDBOX_EGRESS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
    expectedKeyId: env.MENDPOINT_SANDBOX_EGRESS_ATTESTATION_KEY_ID,
    expectedPolicyDigest: env.MENDPOINT_SANDBOX_EGRESS_POLICY_DIGEST,
  });
}
