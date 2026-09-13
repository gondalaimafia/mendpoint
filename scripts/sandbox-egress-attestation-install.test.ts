import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST,
  SANDBOX_EGRESS_ATTESTATION_SCHEMA,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS,
  sandboxEgressAttestationPayloadBytes,
  type SandboxEgressAttestationPayload,
} from "@mendpoint/platform";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = "scripts/sandbox-egress-attestation-install.ts";
const APP = "mendpoint-sandbox";
const IMAGE = `registry.fly.io/mendpoint-sandbox@sha256:${"a".repeat(64)}`;
const POLICY = `sha256:${"b".repeat(64)}`;

// One Ed25519 key; `make` signs with it (or a throwaway key for a tampered
// receipt). The env always carries the main public key, so a wrong-key receipt
// is a signature that does not verify -- exactly a tampered install argument.
function authority() {
  const keys = generateKeyPairSync("ed25519");
  const publicKeySpkiBase64 = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const make = (
    overrides: Partial<SandboxEgressAttestationPayload> = {},
    opts: { wrongKey?: boolean } = {},
  ): string => {
    const testedAt = new Date(Date.now() - 60_000).toISOString();
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    const payload = {
      schemaVersion: SANDBOX_EGRESS_ATTESTATION_SCHEMA,
      app: APP,
      image: IMAGE,
      policyDigest: POLICY,
      testedAt,
      expiresAt,
      forbiddenOutbound: {
        commandDigest: SANDBOX_EGRESS_FORBIDDEN_PROBE_DIGEST,
        targets: SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS.map(([host, port]) => `${host}:${port}`),
        blocked: true,
      },
      allowedVerification: { commandDigest: SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST, passed: true },
      evidenceRefs: ["evidence://protected-egress-acceptance/install"],
      ...overrides,
    } as SandboxEgressAttestationPayload;
    const payloadBytes = sandboxEgressAttestationPayloadBytes(payload);
    const signingKey = opts.wrongKey ? generateKeyPairSync("ed25519").privateKey : keys.privateKey;
    const envelope = {
      payload: payloadBytes.toString("base64"),
      signatures: [{ keyId: "sandbox-egress-key-1", signature: sign(null, payloadBytes, signingKey).toString("base64") }],
    };
    return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
  };
  return { publicKeySpkiBase64, make };
}

function run(attestation: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, attestation], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function envFor(publicKeySpkiBase64: string, path: string, image = IMAGE): NodeJS.ProcessEnv {
  return {
    MENDPOINT_SANDBOX_EGRESS_ATTESTATION_PATH: path,
    MENDPOINT_SANDBOX_FLY_APP: APP,
    MENDPOINT_SANDBOX_FLY_IMAGE: image,
    MENDPOINT_SANDBOX_EGRESS_ATTESTATION_PUBLIC_KEY_SPKI_BASE64: publicKeySpkiBase64,
    MENDPOINT_SANDBOX_EGRESS_ATTESTATION_KEY_ID: "sandbox-egress-key-1",
    MENDPOINT_SANDBOX_EGRESS_POLICY_DIGEST: POLICY,
    MENDPOINT_SANDBOX_EGRESS_ATTESTATION_MIN_SCHEMA: SANDBOX_EGRESS_ATTESTATION_SCHEMA,
  };
}

describe("sandbox egress attestation install script", () => {
  it("verifies the receipt, writes it atomically, and prints one installed JSON line", () => {
    const a = authority();
    const dir = mkdtempSync(join(tmpdir(), "egress-install-"));
    const path = join(dir, "sandbox-egress", "attestation.b64");
    const attestation = a.make();
    const result = run(attestation, envFor(a.publicKeySpkiBase64, path));

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(attestation);
    // Atomic write leaves no temp sibling behind.
    expect(readdirSync(join(dir, "sandbox-egress")).filter((f) => f.startsWith(".attestation"))).toEqual([]);
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o644);
    }
    const line = result.stdout.split("\n").find((l) => l.includes('"installed"'));
    expect(line, `stdout: ${result.stdout}`).toBeTruthy();
    const json = JSON.parse(line!);
    expect(json).toMatchObject({ installed: true, path });
    expect(typeof json.testedAt).toBe("string");
    expect(typeof json.expiresAt).toBe("string");
    expect(json.sha256).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);

  it("refuses a scope mismatch (image change) with a redeploy-required message and writes nothing", () => {
    const a = authority();
    const dir = mkdtempSync(join(tmpdir(), "egress-install-"));
    const path = join(dir, "sandbox-egress", "attestation.b64");
    // The receipt is signed for IMAGE, but this machine expects a DIFFERENT image.
    const differentImage = `registry.fly.io/mendpoint-sandbox@sha256:${"c".repeat(64)}`;
    const result = run(a.make(), envFor(a.publicKeySpkiBase64, path, differentImage));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sandbox_egress_attestation_scope_mismatch");
    expect(result.stderr).toContain("redeploy");
    expect(existsSync(path)).toBe(false);
  }, 30_000);

  it("refuses a tampered receipt before writing (pre-write verification is load-bearing)", () => {
    const a = authority();
    const dir = mkdtempSync(join(tmpdir(), "egress-install-"));
    const path = join(dir, "sandbox-egress", "attestation.b64");
    // Signed with a throwaway key: the signature will not verify against the
    // configured public key. If the pre-write verification were removed, this
    // would be written and the test would fail on existsSync(path) === false.
    const result = run(a.make({}, { wrongKey: true }), envFor(a.publicKeySpkiBase64, path));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sandbox_egress_attestation_signature_invalid");
    expect(existsSync(path)).toBe(false);
  }, 30_000);

  it("refuses a missing argument", () => {
    const a = authority();
    const dir = mkdtempSync(join(tmpdir(), "egress-install-"));
    const path = join(dir, "sandbox-egress", "attestation.b64");
    const result = run("", envFor(a.publicKeySpkiBase64, path));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sandbox_egress_attestation_install_argument_missing");
    expect(existsSync(path)).toBe(false);
  }, 30_000);
});
