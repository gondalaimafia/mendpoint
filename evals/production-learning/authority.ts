import { createHash, createPublicKey, verify } from "node:crypto";

export interface SignedAuthorityEnvelope<T> {
  schemaVersion: "mendpoint.signed-authority.v1";
  issuer: string;
  keyId: string;
  issuedAt: string;
  expiresAt: string;
  payload: T;
  signature: string;
}

export type AuthorityPurpose =
  | "production_learning"
  | "external_provider_transmission"
  | "evaluation_grading";

interface PinnedAuthorityTrustRoot {
  issuer: string;
  keyId: string;
  publicKeyEnv: string;
  publicKeyDigestEnv: string;
}

const PINNED_AUTHORITY_TRUST_ROOTS: Readonly<Record<AuthorityPurpose, PinnedAuthorityTrustRoot>> = Object.freeze({
  production_learning: Object.freeze({
    issuer: "mendpoint-production-learning-control-plane",
    keyId: "production-learning-ed25519-v1",
    publicKeyEnv: "MENDPOINT_PRODUCTION_LEARNING_PUBLIC_KEY_SPKI_BASE64",
    publicKeyDigestEnv: "MENDPOINT_PRODUCTION_LEARNING_TRUSTED_KEY_SHA256",
  }),
  external_provider_transmission: Object.freeze({
    issuer: "mendpoint-external-provider-control-plane",
    keyId: "external-provider-ed25519-v1",
    publicKeyEnv: "MENDPOINT_EXTERNAL_PROVIDER_PUBLIC_KEY_SPKI_BASE64",
    publicKeyDigestEnv: "MENDPOINT_EXTERNAL_PROVIDER_TRUSTED_KEY_SHA256",
  }),
  evaluation_grading: Object.freeze({
    issuer: "mendpoint-evaluation-grading-control-plane",
    keyId: "evaluation-grading-ed25519-v1",
    publicKeyEnv: "MENDPOINT_EVALUATION_GRADING_PUBLIC_KEY_SPKI_BASE64",
    publicKeyDigestEnv: "MENDPOINT_EVALUATION_GRADING_TRUSTED_KEY_SHA256",
  }),
});

export function canonicalAuthorityBytes<T>(envelope: Omit<SignedAuthorityEnvelope<T>, "signature">): Buffer {
  function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value !== null && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }
  return Buffer.from(canonicalJson(envelope), "utf8");
}

export function signedAuthorityEnvelopeDigest<T>(envelope: SignedAuthorityEnvelope<T>): string {
  const { signature, ...unsigned } = envelope;
  return createHash("sha256")
    .update(canonicalAuthorityBytes(unsigned))
    .update("\0")
    .update(Buffer.from(signature, "base64"))
    .digest("hex");
}

export function verifySignedAuthorityEnvelope<T extends { productionRevision: string }>(
  envelope: SignedAuthorityEnvelope<T>,
  purpose: AuthorityPurpose,
): Readonly<T> {
  const trustRoot = PINNED_AUTHORITY_TRUST_ROOTS[purpose];
  if (envelope.schemaVersion !== "mendpoint.signed-authority.v1") throw new Error("authority_schema_invalid");
  if (envelope.issuer !== trustRoot.issuer || envelope.keyId !== trustRoot.keyId) throw new Error("authority_issuer_not_trusted");
  const publicKeyDerBase64 = process.env[trustRoot.publicKeyEnv];
  const pinnedPublicKeyDigest = process.env[trustRoot.publicKeyDigestEnv];
  if (publicKeyDerBase64 === undefined || pinnedPublicKeyDigest === undefined || !/^[0-9a-f]{64}$/.test(pinnedPublicKeyDigest)) {
    throw new Error("authority_trust_root_unavailable");
  }
  const publicKeyDer = Buffer.from(publicKeyDerBase64, "base64");
  if (createHash("sha256").update(publicKeyDer).digest("hex") !== pinnedPublicKeyDigest) {
    throw new Error("authority_public_key_digest_mismatch");
  }
  const issuedAt = Date.parse(envelope.issuedAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  const now = Date.now();
  if (![issuedAt, expiresAt, now].every(Number.isFinite) || issuedAt > now || expiresAt <= now) {
    throw new Error("authority_time_window_invalid");
  }
  const currentProductionRevision = process.env.MENDPOINT_PRODUCTION_REVISION;
  if (currentProductionRevision === undefined || !/^[0-9a-f]{40}$/.test(currentProductionRevision)) {
    throw new Error("authority_current_production_revision_unavailable");
  }
  if (envelope.payload.productionRevision !== currentProductionRevision) {
    throw new Error("authority_production_revision_not_current");
  }
  const signature = Buffer.from(envelope.signature, "base64");
  if (signature.length === 0) throw new Error("authority_signature_missing");
  const publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
  const { signature: _signature, ...unsigned } = envelope;
  if (publicKey.asymmetricKeyType !== "ed25519" || !verify(null, canonicalAuthorityBytes(unsigned), publicKey, signature)) {
    throw new Error("authority_signature_invalid");
  }
  return Object.freeze(structuredClone(envelope.payload));
}
