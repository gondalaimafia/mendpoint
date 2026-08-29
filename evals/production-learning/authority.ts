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

export interface TrustedAuthorityVerifierConfig {
  issuer: string;
  keyId: string;
  publicKeyDerBase64: string;
  publicKeySha256: string;
  currentProductionRevision: string;
  now: string;
}

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
  config: TrustedAuthorityVerifierConfig,
): Readonly<T> {
  if (envelope.schemaVersion !== "mendpoint.signed-authority.v1") throw new Error("authority_schema_invalid");
  if (envelope.issuer !== config.issuer || envelope.keyId !== config.keyId) throw new Error("authority_issuer_not_trusted");
  const publicKeyDer = Buffer.from(config.publicKeyDerBase64, "base64");
  if (createHash("sha256").update(publicKeyDer).digest("hex") !== config.publicKeySha256) {
    throw new Error("authority_public_key_digest_mismatch");
  }
  const issuedAt = Date.parse(envelope.issuedAt);
  const expiresAt = Date.parse(envelope.expiresAt);
  const now = Date.parse(config.now);
  if (![issuedAt, expiresAt, now].every(Number.isFinite) || issuedAt > now || expiresAt <= now) {
    throw new Error("authority_time_window_invalid");
  }
  if (envelope.payload.productionRevision !== config.currentProductionRevision) {
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
