import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST,
  SANDBOX_EGRESS_FIREWALL_ERROR_CODES,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND,
  SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS,
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

type ProbeOutcome = { event: "connect" | "timeout" | "error"; code?: string };

// Execute the exact shipped forbidden-egress probe script body against a fake
// node:net, so the wired command's own classification is what is under test (no
// second copy of the logic). Returns the process exit code the script would emit.
function runForbiddenProbe(outcomeFor: (host: string) => ProbeOutcome): Promise<number> {
  const cmd = SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND;
  // The script is single-quoted for the shell and contains no single quotes itself.
  const body = cmd.slice(cmd.indexOf("'") + 1, cmd.lastIndexOf("'"));
  const makeFakeNet = () => ({
    connect({ host }: { host: string; port: number }) {
      const handlers: Record<string, (arg?: unknown) => void> = {};
      const sock = {
        on(event: string, cb: (arg?: unknown) => void) {
          handlers[event] = cb;
          return sock;
        },
        setTimeout() {
          return sock;
        },
        destroy() {
          return sock;
        },
      };
      queueMicrotask(() => {
        const o = outcomeFor(host);
        if (o.event === "connect") handlers.connect?.();
        else if (o.event === "timeout") handlers.timeout?.();
        else handlers.error?.(Object.assign(new Error("probe"), { code: o.code }));
      });
      return sock;
    },
  });
  return new Promise<number>((resolve) => {
    const fakeRequire = (id: string): unknown => {
      if (id === "node:net") return makeFakeNet();
      throw new Error(`unexpected require(${id})`);
    };
    const fakeProcess = { exit: (code: number) => resolve(code) };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function("require", "process", body) as (
      req: unknown,
      proc: unknown,
    ) => void;
    fn(fakeRequire, fakeProcess);
  });
}

describe("forbidden egress probe classification (fails closed on ambiguity)", () => {
  it("probes only raw IPs and firewall-class codes, never a hostname or fetch", () => {
    expect(SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS.length).toBeGreaterThanOrEqual(2);
    for (const [ip] of SANDBOX_EGRESS_FORBIDDEN_PROBE_TARGETS) {
      expect(SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND).toContain(ip);
    }
    for (const code of SANDBOX_EGRESS_FIREWALL_ERROR_CODES) {
      expect(SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND).toContain(code);
    }
    expect(SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND).not.toContain("fetch(");
    expect(SANDBOX_EGRESS_FORBIDDEN_PROBE_COMMAND).not.toContain("example.com");
  });

  it("does NOT report blocked when a DNS-class error occurs (0 means a proven fence)", async () => {
    const exit = await runForbiddenProbe(() => ({ event: "error", code: "EAI_AGAIN" }));
    expect(exit).not.toBe(0);
    expect(exit).toBe(3);
  });

  it("reports blocked (exit 0) only when every destination fails firewall-class", async () => {
    const exit = await runForbiddenProbe(() => ({ event: "error", code: "ENETUNREACH" }));
    expect(exit).toBe(0);
  });

  it("does NOT report blocked when only some destinations fail firewall-class", async () => {
    const codes: Record<string, string> = {
      "1.1.1.1": "ENETUNREACH",
      "8.8.8.8": "ECONNREFUSED",
      "9.9.9.9": "ENETUNREACH",
    };
    const exit = await runForbiddenProbe((host) => ({ event: "error", code: codes[host] ?? "UNKNOWN" }));
    expect(exit).not.toBe(0);
    expect(exit).toBe(3);
  });

  it("reports an unclassifiable error as not proven, never as blocked", async () => {
    const exit = await runForbiddenProbe(() => ({ event: "error", code: "ECONNRESET" }));
    expect(exit).toBe(3);
  });

  it("treats a timeout (silent drop) as not proven, never as blocked", async () => {
    const exit = await runForbiddenProbe(() => ({ event: "timeout" }));
    expect(exit).toBe(3);
  });

  it("reports reachable (exit 42, not blocked) when any destination connects", async () => {
    const exit = await runForbiddenProbe((host) =>
      host === "8.8.8.8" ? { event: "connect" } : { event: "error", code: "ENETUNREACH" },
    );
    expect(exit).toBe(42);
  });
});

describe("negative egress receipt (representable, then rejected)", () => {
  const failedPayload = {
    schemaVersion: "2026-08-18.v1" as const,
    app: APP,
    image: IMAGE,
    policyDigest: POLICY,
    testedAt: "2026-08-18T19:55:00.000Z",
    expiresAt: "2026-08-18T20:55:00.000Z",
    forbiddenOutbound: { url: SANDBOX_EGRESS_FORBIDDEN_PROBE_URL, blocked: false },
    allowedVerification: { commandDigest: SANDBOX_EGRESS_ALLOWED_PROBE_DIGEST, passed: true },
    evidenceRefs: ["evidence://protected-egress-acceptance/failed"],
  };

  it("a receipt asserting a failed forbidden probe is representable and rejected by the normalizer", () => {
    // Representable only because blocked is now boolean rather than the literal true.
    const failed: SandboxEgressAttestationPayload = failedPayload;
    expect(failed.forbiddenOutbound.blocked).toBe(false);
    expect(() => sandboxEgressAttestationPayloadBytes(failed)).toThrow(
      "sandbox_egress_attestation_probe_invalid",
    );
  });

  it("a signed false-probe receipt is rejected end-to-end by the verifier", () => {
    const keys = generateKeyPairSync("ed25519");
    const payloadBytes = Buffer.from(JSON.stringify(failedPayload), "utf8");
    const envelope = {
      payload: payloadBytes.toString("base64"),
      signatures: [
        { keyId: "sandbox-egress-key-1", signature: sign(null, payloadBytes, keys.privateKey).toString("base64") },
      ],
    };
    expect(() =>
      verifySandboxEgressAttestation({
        attestationBase64: Buffer.from(JSON.stringify(envelope), "utf8").toString("base64"),
        publicKeySpkiBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
        expectedKeyId: "sandbox-egress-key-1",
        expectedPolicyDigest: POLICY,
        expectedApp: APP,
        expectedImage: IMAGE,
        observedAt: NOW,
      }),
    ).toThrow("sandbox_egress_attestation_probe_invalid");
  });
});
