import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_URL,
  verifySandboxEgressAttestation,
} from "@mendpoint/platform";
import { createSandboxEgressAttestation } from "./create-sandbox-egress-attestation.js";

const IMAGE = `registry.fly.io/mendpoint-sandbox@sha256:${"a".repeat(64)}`;
const POLICY = `sha256:${"b".repeat(64)}`;

describe("sandbox egress acceptance receipt producer", () => {
  it("signs a bounded receipt that production verifies without exposing the private key", () => {
    const keys = generateKeyPairSync("ed25519");
    const privateKeyPkcs8Base64 = keys.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");
    const receipt = createSandboxEgressAttestation({
      app: "mendpoint-sandbox",
      image: IMAGE,
      policyDigest: POLICY,
      testedAt: "2026-08-18T20:00:00.000Z",
      expiresAt: "2026-08-19T19:00:00.000Z",
      evidenceRefs: ["evidence://github/actions/run/1", "evidence://fly/machine/accepted"],
      keyId: "sandbox-egress-key-1",
      privateKeyPkcs8Base64,
    });

    expect(JSON.stringify(receipt)).not.toContain(privateKeyPkcs8Base64);
    expect(receipt.payload).toMatchObject({
      forbiddenOutbound: { url: SANDBOX_EGRESS_FORBIDDEN_PROBE_URL, blocked: true },
      allowedVerification: { commandDigest: SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST, passed: true },
    });
    expect(verifySandboxEgressAttestation({
      attestationBase64: receipt.attestationBase64,
      publicKeySpkiBase64: receipt.publicKeySpkiBase64,
      expectedKeyId: receipt.keyId,
      expectedPolicyDigest: receipt.policyDigest,
      expectedApp: receipt.payload.app,
      expectedImage: receipt.payload.image,
      observedAt: "2026-08-18T21:00:00.000Z",
    })).toEqual(receipt.payload);
  });

  it("rejects a non Ed25519 signing authority", () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(() => createSandboxEgressAttestation({
      app: "mendpoint-sandbox",
      image: IMAGE,
      policyDigest: POLICY,
      testedAt: "2026-08-18T20:00:00.000Z",
      expiresAt: "2026-08-19T19:00:00.000Z",
      evidenceRefs: ["evidence://fly/machine/accepted"],
      keyId: "sandbox-egress-key-1",
      privateKeyPkcs8Base64: keys.privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64"),
    })).toThrow("sandbox_egress_signing_key_invalid");
  });
});
