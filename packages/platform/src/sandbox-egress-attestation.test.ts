import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_URL,
  sandboxEgressAttestationPayloadBytes,
  verifySandboxEgressAttestation,
  type SandboxEgressAttestationPayload,
} from "./sandbox-egress-attestation.js";

const APP = "mendpoint-sandbox";
const IMAGE = `registry.fly.io/mendpoint-sandbox@sha256:${"a".repeat(64)}`;
const POLICY = `sha256:${"b".repeat(64)}`;
const NOW = "2026-08-18T20:00:00.000Z";

function signed(overrides: Partial<SandboxEgressAttestationPayload> = {}) {
  const keys = generateKeyPairSync("ed25519");
  const payload: SandboxEgressAttestationPayload = {
    schemaVersion: "2026-08-18.v1",
    app: APP,
    image: IMAGE,
    policyDigest: POLICY,
    testedAt: "2026-08-18T19:55:00.000Z",
    expiresAt: "2026-08-18T20:55:00.000Z",
    forbiddenOutbound: {
      url: SANDBOX_EGRESS_FORBIDDEN_PROBE_URL,
      blocked: true,
    },
    allowedVerification: {
      commandDigest: SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST,
      passed: true,
    },
    evidenceRefs: ["evidence://protected-egress-acceptance/1"],
    ...overrides,
  };
  const payloadBytes = sandboxEgressAttestationPayloadBytes(payload);
  const envelope = {
    payload: payloadBytes.toString("base64"),
    signatures: [{ keyId: "sandbox-egress-key-1", signature: sign(null, payloadBytes, keys.privateKey).toString("base64") }],
  };
  return {
    config: {
      attestationBase64: Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
      publicKeySpkiBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      expectedKeyId: "sandbox-egress-key-1",
      expectedPolicyDigest: POLICY,
    },
    payload,
  };
}

describe("sandbox egress policy attestation", () => {
  it("verifies an exact app, image, policy, probe, and fresh Ed25519 signature", () => {
    const fixture = signed();
    expect(
      verifySandboxEgressAttestation({
        ...fixture.config,
        expectedApp: APP,
        expectedImage: IMAGE,
        observedAt: NOW,
      }),
    ).toMatchObject({ app: APP, image: IMAGE, policyDigest: POLICY });
  });

  it.each([
    ["wrong app", { expectedApp: "other-app" }, "sandbox_egress_attestation_scope_mismatch"],
    ["wrong image", { expectedImage: `registry.fly.io/other@sha256:${"c".repeat(64)}` }, "sandbox_egress_attestation_scope_mismatch"],
    ["wrong policy", { expectedPolicyDigest: `sha256:${"d".repeat(64)}` }, "sandbox_egress_attestation_scope_mismatch"],
    ["expired", { observedAt: "2026-08-18T21:00:00.000Z" }, "sandbox_egress_attestation_expired"],
  ])("rejects %s authority", (_name, override, code) => {
    const fixture = signed();
    expect(() =>
      verifySandboxEgressAttestation({
        ...fixture.config,
        expectedApp: APP,
        expectedImage: IMAGE,
        observedAt: NOW,
        ...override,
      }),
    ).toThrow(code);
  });

  it("rejects a payload or signature substitution", () => {
    const fixture = signed();
    const decoded = JSON.parse(Buffer.from(fixture.config.attestationBase64, "base64").toString("utf8")) as {
      payload: string;
      signatures: Array<{ keyId: string; signature: string }>;
    };
    decoded.payload = Buffer.from(
      sandboxEgressAttestationPayloadBytes({ ...fixture.payload, app: "attacker-app" }),
    ).toString("base64");
    expect(() =>
      verifySandboxEgressAttestation({
        ...fixture.config,
        attestationBase64: Buffer.from(JSON.stringify(decoded), "utf8").toString("base64"),
        expectedApp: APP,
        expectedImage: IMAGE,
        observedAt: NOW,
      }),
    ).toThrow("sandbox_egress_attestation_signature_invalid");
  });
});
