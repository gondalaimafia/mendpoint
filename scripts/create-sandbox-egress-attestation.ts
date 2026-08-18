import { Buffer } from "node:buffer";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST,
  SANDBOX_EGRESS_ATTESTATION_SCHEMA,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_URL,
  sandboxEgressAttestationPayloadBytes,
  type SandboxEgressAttestationPayload,
} from "@mendpoint/platform";

export type CreateSandboxEgressAttestationInput = Readonly<{
  app: string;
  image: string;
  policyDigest: string;
  testedAt: string;
  expiresAt: string;
  evidenceRefs: readonly string[];
  keyId: string;
  privateKeyPkcs8Base64: string;
}>;

export type CreatedSandboxEgressAttestation = Readonly<{
  attestationBase64: string;
  publicKeySpkiBase64: string;
  keyId: string;
  policyDigest: string;
  payload: SandboxEgressAttestationPayload;
}>;

function canonicalBase64(value: string, code: string): Buffer {
  const trimmed = value.trim();
  const bytes = Buffer.from(trimmed, "base64");
  if (!trimmed || !bytes.length || bytes.toString("base64") !== trimmed) {
    throw new Error(code);
  }
  return bytes;
}

export function createSandboxEgressAttestation(
  input: CreateSandboxEgressAttestationInput,
): CreatedSandboxEgressAttestation {
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey({
      key: canonicalBase64(input.privateKeyPkcs8Base64, "sandbox_egress_signing_key_invalid"),
      format: "der",
      type: "pkcs8",
    });
  } catch {
    throw new Error("sandbox_egress_signing_key_invalid");
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("sandbox_egress_signing_key_invalid");
  }
  const payload: SandboxEgressAttestationPayload = Object.freeze({
    schemaVersion: SANDBOX_EGRESS_ATTESTATION_SCHEMA,
    app: input.app,
    image: input.image,
    policyDigest: input.policyDigest,
    testedAt: input.testedAt,
    expiresAt: input.expiresAt,
    forbiddenOutbound: Object.freeze({
      url: SANDBOX_EGRESS_FORBIDDEN_PROBE_URL,
      blocked: true,
    }),
    allowedVerification: Object.freeze({
      commandDigest: SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST,
      passed: true,
    }),
    evidenceRefs: Object.freeze(
      [...input.evidenceRefs].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    ),
  });
  const payloadBytes = sandboxEgressAttestationPayloadBytes(payload);
  const envelope = Object.freeze({
    payload: payloadBytes.toString("base64"),
    signatures: Object.freeze([Object.freeze({
      keyId: input.keyId,
      signature: sign(null, payloadBytes, privateKey).toString("base64"),
    })]),
  });
  const publicKey = createPublicKey(privateKey);
  return Object.freeze({
    attestationBase64: Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
    publicKeySpkiBase64: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    keyId: input.keyId,
    policyDigest: input.policyDigest,
    payload,
  });
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name}_required`);
  return value;
}

export function sandboxEgressAttestationInputFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): CreateSandboxEgressAttestationInput {
  const testedAt = env.MENDPOINT_SANDBOX_EGRESS_TESTED_AT?.trim() || now.toISOString();
  const expiresAt = env.MENDPOINT_SANDBOX_EGRESS_EXPIRES_AT?.trim() ||
    new Date(Date.parse(testedAt) + 23 * 60 * 60 * 1000).toISOString();
  const evidenceRefs = required(env, "MENDPOINT_SANDBOX_EGRESS_EVIDENCE_REFS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  return Object.freeze({
    app: required(env, "MENDPOINT_SANDBOX_EGRESS_APP"),
    image: required(env, "MENDPOINT_SANDBOX_EGRESS_IMAGE"),
    policyDigest: required(env, "MENDPOINT_SANDBOX_EGRESS_POLICY_DIGEST"),
    testedAt,
    expiresAt,
    evidenceRefs: Object.freeze(evidenceRefs),
    keyId: required(env, "MENDPOINT_SANDBOX_EGRESS_KEY_ID"),
    privateKeyPkcs8Base64: required(env, "MENDPOINT_SANDBOX_EGRESS_SIGNING_KEY_PKCS8_BASE64"),
  });
}

function isMain(): boolean {
  return Boolean(process.argv[1]) &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  try {
    process.stdout.write(`${JSON.stringify(createSandboxEgressAttestation(
      sandboxEgressAttestationInputFromEnv(),
    ))}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
