import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST,
  SANDBOX_EGRESS_ATTESTATION_SCHEMA,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS,
  sandboxEgressAttestationPayloadBytes,
  type SandboxEgressAttestationPayload,
} from "@mendpoint/platform";
import {
  customerSandboxEgressReadinessCheck,
  verifyCustomerSandboxReceipt,
} from "./customer-readiness.js";

const APP = "mendpoint-sandbox";
const IMAGE = `registry.fly.io/mendpoint-sandbox@sha256:${"a".repeat(64)}`;
const POLICY = `sha256:${"b".repeat(64)}`;
const NOW = "2026-08-18T20:00:00.000Z";
const EXPIRES_AT = "2026-08-18T20:55:00.000Z";

function signedReceipt(overrides: Partial<SandboxEgressAttestationPayload> = {}) {
  const keys = generateKeyPairSync("ed25519");
  const payload: SandboxEgressAttestationPayload = {
    schemaVersion: SANDBOX_EGRESS_ATTESTATION_SCHEMA,
    app: APP,
    image: IMAGE,
    policyDigest: POLICY,
    testedAt: "2026-08-18T19:55:00.000Z",
    expiresAt: EXPIRES_AT,
    forbiddenOutbound: {
      commandDigest: SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST,
      targets: SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS.map(([host, port]) => `${host}:${port}`),
      blocked: true,
    },
    allowedVerification: { commandDigest: SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST, passed: true },
    evidenceRefs: ["evidence://protected-egress-acceptance/1"],
    ...overrides,
  };
  const payloadBytes = sandboxEgressAttestationPayloadBytes(payload);
  const envelope = {
    payload: payloadBytes.toString("base64"),
    signatures: [{ keyId: "sandbox-egress-key-1", signature: sign(null, payloadBytes, keys.privateKey).toString("base64") }],
  };
  return {
    attestationBase64: Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
    publicKeySpkiBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

function baseEnv(receipt: { attestationBase64: string; publicKeySpkiBase64: string }): NodeJS.ProcessEnv {
  return {
    MENDPOINT_SANDBOX_FLY_APP: APP,
    MENDPOINT_SANDBOX_FLY_IMAGE: IMAGE,
    MENDPOINT_SANDBOX_EGRESS_ATTESTATION_BASE64: receipt.attestationBase64,
    MENDPOINT_SANDBOX_EGRESS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64: receipt.publicKeySpkiBase64,
    MENDPOINT_SANDBOX_EGRESS_ATTESTATION_KEY_ID: "sandbox-egress-key-1",
    MENDPOINT_SANDBOX_EGRESS_POLICY_DIGEST: POLICY,
  };
}

describe("customer sandbox egress readiness check", () => {
  it("verifyCustomerSandboxReceipt reports source: env when only the environment holds the receipt", () => {
    const receipt = signedReceipt();
    const result = verifyCustomerSandboxReceipt(baseEnv(receipt), NOW);
    expect(result).toMatchObject({ status: "verified", source: "env", expiresAt: EXPIRES_AT });
  });

  it("verifyCustomerSandboxReceipt reports source: file when the receipt is served from the volume file", () => {
    const receipt = signedReceipt();
    const path = join(mkdtempSync(join(tmpdir(), "customer-egress-")), "attestation.b64");
    writeFileSync(path, receipt.attestationBase64);
    const env = { ...baseEnv(receipt), MENDPOINT_SANDBOX_EGRESS_ATTESTATION_PATH: path };
    const result = verifyCustomerSandboxReceipt(env, NOW);
    expect(result).toMatchObject({ status: "verified", source: "file", expiresAt: EXPIRES_AT });
  });

  it("customerSandboxEgressReadinessCheck surfaces ok, source and expiresAt in the detail for the renewal to confirm", () => {
    const receipt = signedReceipt();
    const path = join(mkdtempSync(join(tmpdir(), "customer-egress-")), "attestation.b64");
    writeFileSync(path, receipt.attestationBase64);
    const env = { ...baseEnv(receipt), MENDPOINT_SANDBOX_EGRESS_ATTESTATION_PATH: path };
    const check = customerSandboxEgressReadinessCheck(env, NOW);
    expect(check.name).toBe("sandbox_egress_receipt");
    expect(check.ok).toBe(true);
    expect(JSON.parse(check.detail)).toEqual({ status: "verified", source: "file", expiresAt: EXPIRES_AT });
  });

  it("customerSandboxEgressReadinessCheck reports not-ok and only the status when no receipt verifies", () => {
    const check = customerSandboxEgressReadinessCheck(
      { MENDPOINT_SANDBOX_FLY_APP: APP, MENDPOINT_SANDBOX_FLY_IMAGE: IMAGE },
      NOW,
    );
    expect(check.ok).toBe(false);
    // No receipt configured -> unavailable, and no source/expiry leaks into the detail.
    expect(JSON.parse(check.detail)).toEqual({ status: "unavailable" });
  });
});
