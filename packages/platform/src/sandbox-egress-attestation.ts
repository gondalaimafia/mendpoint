import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";

export const SANDBOX_EGRESS_ATTESTATION_LEGACY_SCHEMA = "2026-08-18.v1" as const;
export const SANDBOX_EGRESS_ATTESTATION_SCHEMA = "2026-08-19.v2" as const;

// Receipt schema versions in ascending order of strength; the array index is a
// version's rank. A newer schema is APPENDED, never inserted, so ranks stay stable.
// The legacy v1 schema (rank 0) attested containment with an unsound
// fetch/example.com probe and sits below the floor.
export const SANDBOX_EGRESS_ATTESTATION_SCHEMA_VERSIONS: readonly string[] = Object.freeze([
  SANDBOX_EGRESS_ATTESTATION_LEGACY_SCHEMA,
  SANDBOX_EGRESS_ATTESTATION_SCHEMA,
]);

// The lowest receipt schema the verifier will EVER accept, enforced unconditionally at
// the point of verification. This is policy in code, not an input: an operator env var
// may only RAISE the floor to a newer schema, never lower or disable it, and a blank or
// unset variable means "use this code floor" (never "accept any schema version").
export const SANDBOX_EGRESS_ATTESTATION_MIN_SCHEMA_FLOOR: typeof SANDBOX_EGRESS_ATTESTATION_SCHEMA =
  SANDBOX_EGRESS_ATTESTATION_SCHEMA;

export const SANDBOX_EGRESS_FORBIDDEN_PROBE_URL = "https://example.com/" as const;

// Raw IPv4 anycast targets, never hostnames: a machine with real outbound egress
// reaches these on 443, and because they are literal IPs the probe performs no DNS
// lookup, so a broken resolver cannot masquerade as a network fence. Multiple
// destinations are required so a single-host anomaly cannot alone conclude containment.
export const SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS = [
  ["1.1.1.1", 443],
  ["8.8.8.8", 443],
  ["9.9.9.9", 443],
] as const;

// Only these connect errors prove an egress fence. A DNS error, TLS error, refused
// connection, timeout (silent drop), or transient blip is ambiguous and must be
// reported as "not proven" (a nonzero exit that refuses the run), never as blocked.
export const SANDBOX_EGRESS_FIREWALL_ERROR_CODES = [
  "EPERM",
  "ENETUNREACH",
  "EHOSTUNREACH",
] as const;

// Probe exit codes are read by the forbidden-egress gate, where 0 means "containment
// proven" and any nonzero value refuses the customer command:
//   0  every target failed to connect with a firewall-class error (fence proven)
//   42 at least one target was reachable (egress is open; not blocked)
//   3  outcome ambiguous or unclassifiable (not proven)
// Fail closed: only an unambiguous, multi-destination firewall result yields 0.
export const SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND =
  `node -e 'const net=require("node:net");const FW=new Set(${JSON.stringify(SANDBOX_EGRESS_FIREWALL_ERROR_CODES)});const T=${JSON.stringify(SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS)};Promise.all(T.map(([h,p])=>new Promise(res=>{const s=net.connect({host:h,port:p});let done=false;const fin=v=>{if(done)return;done=true;try{s.destroy()}catch(e){}res(v)};s.setTimeout(3000);s.on("connect",()=>fin({reachable:true}));s.on("timeout",()=>fin({code:"ETIMEDOUT"}));s.on("error",e=>fin({code:(e&&e.code)||"UNKNOWN"}))}))).then(rs=>{if(rs.some(r=>r.reachable))process.exit(42);const fenced=rs.filter(r=>r.code&&FW.has(r.code));if(fenced.length===rs.length&&fenced.length>=2){process.stdout.write("mendpoint-egress-blocked\\n");process.exit(0)}process.exit(3)}).catch(()=>process.exit(3))'`;
export const SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST =
  `sha256:${createHash("sha256").update(SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND, "utf8").digest("hex")}`;
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
    commandDigest: typeof SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST;
    targets: readonly string[];
    // boolean, not the literal `true`. Our producer never emits a negative receipt:
    // `sandboxEgressAttestationPayloadBytes` refuses `blocked: false` with
    // `sandbox_egress_attestation_probe_invalid`. The wider type exists for the verifier,
    // which parses untrusted (attacker-signable) JSON where `blocked: false` can appear
    // and must be representable so it can be explicitly rejected rather than silently
    // coerced to `true`.
    blocked: boolean;
  }>;
  allowedVerification: Readonly<{
    commandDigest: string;
    // boolean, not the literal `true`, for the verifier's benefit: see
    // forbiddenOutbound.blocked above. The producer never emits `passed: false`.
    passed: boolean;
  }>;
  evidenceRefs: readonly string[];
}>;

export type SandboxEgressAuthorityConfig = Readonly<{
  attestationBase64?: string;
  publicKeySpkiBase64?: string;
  expectedKeyId?: string;
  expectedPolicyDigest?: string;
  // A raise-only operator input, validated at the point of verification: it may lift the
  // code floor to a newer schema but can never lower or disable it. Typed `string`
  // because it arrives from untrusted env; `resolveSandboxEgressMinimumSchema` rejects a
  // non-empty value that is not a known schema version. Blank/unset means "code floor".
  minimumSchemaVersion?: string;
  now?: () => string;
}>;

type LegacySandboxEgressAttestationPayload = Readonly<{
  schemaVersion: typeof SANDBOX_EGRESS_ATTESTATION_LEGACY_SCHEMA;
  app: string;
  image: string;
  policyDigest: string;
  testedAt: string;
  expiresAt: string;
  forbiddenOutbound: Readonly<{
    url: typeof SANDBOX_EGRESS_FORBIDDEN_PROBE_URL;
    blocked: boolean;
  }>;
  allowedVerification: Readonly<{
    commandDigest: string;
    passed: boolean;
  }>;
  evidenceRefs: readonly string[];
}>;

export type VerifiedSandboxEgressAttestationPayload =
  | SandboxEgressAttestationPayload
  | LegacySandboxEgressAttestationPayload;

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

function normalizedScope(payload: Record<string, unknown>): Readonly<{
  app: string;
  image: string;
  policyDigest: string;
  testedAt: string;
  expiresAt: string;
  evidenceRefs: readonly string[];
}> {
  const app = text(payload.app, 63, "sandbox_egress_attestation_scope_invalid");
  const image = text(payload.image, 380, "sandbox_egress_attestation_scope_invalid");
  const policyDigest = text(payload.policyDigest, 71, "sandbox_egress_attestation_scope_invalid");
  if (!APP.test(app) || !IMAGE.test(image) || !DIGEST.test(policyDigest)) fail("sandbox_egress_attestation_scope_invalid");
  const testedAt = canonicalTimestamp(payload.testedAt, "sandbox_egress_attestation_time_invalid");
  const expiresAt = canonicalTimestamp(payload.expiresAt, "sandbox_egress_attestation_time_invalid");
  if (!Array.isArray(payload.evidenceRefs) || payload.evidenceRefs.length < 1 || payload.evidenceRefs.length > 32) fail("sandbox_egress_attestation_evidence_invalid");
  const evidenceRefs = payload.evidenceRefs.map((ref) => text(ref, 512, "sandbox_egress_attestation_evidence_invalid"));
  const sortedRefs = [...evidenceRefs].sort(codeUnitCompare);
  if (new Set(sortedRefs).size !== sortedRefs.length || sortedRefs.some((ref, index) => ref !== evidenceRefs[index])) fail("sandbox_egress_attestation_evidence_invalid");
  return Object.freeze({ app, image, policyDigest, testedAt, expiresAt, evidenceRefs: Object.freeze(sortedRefs) });
}

function normalizeLegacyPayload(value: unknown): LegacySandboxEgressAttestationPayload {
  const payload = object(value, "sandbox_egress_attestation_payload_invalid");
  exactKeys(payload, [
    "schemaVersion", "app", "image", "policyDigest", "testedAt", "expiresAt",
    "forbiddenOutbound", "allowedVerification", "evidenceRefs",
  ], "sandbox_egress_attestation_payload_invalid");
  if (payload.schemaVersion !== SANDBOX_EGRESS_ATTESTATION_LEGACY_SCHEMA) fail("sandbox_egress_attestation_schema_invalid");
  const scope = normalizedScope(payload);
  const forbidden = object(payload.forbiddenOutbound, "sandbox_egress_attestation_probe_invalid");
  exactKeys(forbidden, ["url", "blocked"], "sandbox_egress_attestation_probe_invalid");
  if (forbidden.url !== SANDBOX_EGRESS_FORBIDDEN_PROBE_URL || forbidden.blocked !== true) fail("sandbox_egress_attestation_probe_invalid");
  const allowed = object(payload.allowedVerification, "sandbox_egress_attestation_probe_invalid");
  exactKeys(allowed, ["commandDigest", "passed"], "sandbox_egress_attestation_probe_invalid");
  if (allowed.commandDigest !== SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST || allowed.passed !== true) fail("sandbox_egress_attestation_probe_invalid");
  return Object.freeze({
    schemaVersion: SANDBOX_EGRESS_ATTESTATION_LEGACY_SCHEMA,
    app: scope.app,
    image: scope.image,
    policyDigest: scope.policyDigest,
    testedAt: scope.testedAt,
    expiresAt: scope.expiresAt,
    forbiddenOutbound: Object.freeze({ url: SANDBOX_EGRESS_FORBIDDEN_PROBE_URL, blocked: true }),
    allowedVerification: Object.freeze({ commandDigest: SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST, passed: true }),
    evidenceRefs: scope.evidenceRefs,
  });
}

function normalizePayload(value: unknown): SandboxEgressAttestationPayload {
  const payload = object(value, "sandbox_egress_attestation_payload_invalid");
  exactKeys(payload, [
    "schemaVersion", "app", "image", "policyDigest", "testedAt", "expiresAt",
    "forbiddenOutbound", "allowedVerification", "evidenceRefs",
  ], "sandbox_egress_attestation_payload_invalid");
  if (payload.schemaVersion !== SANDBOX_EGRESS_ATTESTATION_SCHEMA) fail("sandbox_egress_attestation_schema_invalid");
  const scope = normalizedScope(payload);
  const forbidden = object(payload.forbiddenOutbound, "sandbox_egress_attestation_probe_invalid");
  exactKeys(forbidden, ["commandDigest", "targets", "blocked"], "sandbox_egress_attestation_probe_invalid");
  const expectedTargets = SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS.map(([host, port]) => `${host}:${port}`);
  if (
    forbidden.commandDigest !== SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST ||
    forbidden.blocked !== true ||
    !Array.isArray(forbidden.targets) ||
    forbidden.targets.length !== expectedTargets.length ||
    forbidden.targets.some((target, index) => target !== expectedTargets[index])
  ) fail("sandbox_egress_attestation_probe_invalid");
  const allowed = object(payload.allowedVerification, "sandbox_egress_attestation_probe_invalid");
  exactKeys(allowed, ["commandDigest", "passed"], "sandbox_egress_attestation_probe_invalid");
  if (allowed.commandDigest !== SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST || allowed.passed !== true) fail("sandbox_egress_attestation_probe_invalid");
  return Object.freeze({
    schemaVersion: SANDBOX_EGRESS_ATTESTATION_SCHEMA,
    app: scope.app,
    image: scope.image,
    policyDigest: scope.policyDigest,
    testedAt: scope.testedAt,
    expiresAt: scope.expiresAt,
    forbiddenOutbound: Object.freeze({
      commandDigest: SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST,
      targets: Object.freeze(expectedTargets),
      blocked: true,
    }),
    allowedVerification: Object.freeze({ commandDigest: SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST, passed: true }),
    evidenceRefs: scope.evidenceRefs,
  });
}

function normalizeVersionedPayload(value: unknown): VerifiedSandboxEgressAttestationPayload {
  const payload = object(value, "sandbox_egress_attestation_payload_invalid");
  if (payload.schemaVersion === SANDBOX_EGRESS_ATTESTATION_SCHEMA) return normalizePayload(value);
  if (payload.schemaVersion === SANDBOX_EGRESS_ATTESTATION_LEGACY_SCHEMA) return normalizeLegacyPayload(value);
  fail("sandbox_egress_attestation_schema_invalid");
}

function canonicalPayloadBytes(payload: VerifiedSandboxEgressAttestationPayload): Buffer {
  return Buffer.from(JSON.stringify(payload), "utf8");
}

export function sandboxEgressAttestationPayloadBytes(
  payload: SandboxEgressAttestationPayload,
): Buffer {
  const normalized = normalizePayload(structuredClone(payload));
  return Buffer.from(JSON.stringify(normalized), "utf8");
}

/**
 * Resolve the minimum receipt schema version the verifier will require. The code floor
 * (`SANDBOX_EGRESS_ATTESTATION_MIN_SCHEMA_FLOOR`) is always the lower bound; a
 * `configured` value may only RAISE it to a higher-ranked known schema, never lower or
 * disable it. A blank or unset `configured` value returns the floor; a non-empty value
 * that is not a known schema version is rejected as configuration error.
 *
 * `policy` is an injection seam for tests (mirroring the probe test's fake `node:net`):
 * production always resolves against the module's real version ordering and code floor.
 */
export function resolveSandboxEgressMinimumSchema(
  configured: string | undefined,
  policy: Readonly<{ floor?: string; versions?: readonly string[] }> = {},
): string {
  const versions = policy.versions ?? SANDBOX_EGRESS_ATTESTATION_SCHEMA_VERSIONS;
  const floor = policy.floor ?? SANDBOX_EGRESS_ATTESTATION_MIN_SCHEMA_FLOOR;
  const floorRank = versions.indexOf(floor);
  if (floorRank < 0) fail("sandbox_egress_attestation_config_invalid");
  const trimmed = configured?.trim();
  if (!trimmed) return floor;
  const configuredRank = versions.indexOf(trimmed);
  if (configuredRank < 0) fail("sandbox_egress_attestation_config_invalid");
  return configuredRank > floorRank ? versions[configuredRank] : floor;
}

export function verifySandboxEgressAttestation(input: Readonly<
  SandboxEgressAuthorityConfig & {
    expectedApp: string;
    expectedImage: string;
    observedAt: string;
  }
>): VerifiedSandboxEgressAttestationPayload {
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
  const payload = normalizeVersionedPayload(payloadValue);
  // The schema floor is policy in code, enforced unconditionally. `minimumSchemaVersion`
  // is an operator input that may only RAISE the floor; a blank or unset value keeps the
  // code floor, so a legacy receipt below the floor is always rejected. A non-empty value
  // that is not a known schema version raises config_invalid.
  const requiredSchema = resolveSandboxEgressMinimumSchema(input.minimumSchemaVersion);
  const requiredRank = SANDBOX_EGRESS_ATTESTATION_SCHEMA_VERSIONS.indexOf(requiredSchema);
  const payloadRank = SANDBOX_EGRESS_ATTESTATION_SCHEMA_VERSIONS.indexOf(payload.schemaVersion);
  if (payloadRank < 0 || payloadRank < requiredRank) {
    fail("sandbox_egress_attestation_schema_invalid");
  }
  if (!canonicalPayloadBytes(payload).equals(payloadBytes)) fail("sandbox_egress_attestation_payload_invalid");
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
  const minimumSchemaVersion = env.MENDPOINT_SANDBOX_EGRESS_ATTESTATION_MIN_SCHEMA?.trim();
  return Object.freeze({
    attestationBase64: env.MENDPOINT_SANDBOX_EGRESS_ATTESTATION_BASE64,
    publicKeySpkiBase64: env.MENDPOINT_SANDBOX_EGRESS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64,
    expectedKeyId: env.MENDPOINT_SANDBOX_EGRESS_ATTESTATION_KEY_ID,
    expectedPolicyDigest: env.MENDPOINT_SANDBOX_EGRESS_POLICY_DIGEST,
    // Passed through unvalidated: the raise-only floor is resolved and any unknown value
    // rejected at the point of verification, not here.
    minimumSchemaVersion,
  });
}
